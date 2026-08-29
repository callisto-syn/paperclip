import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { stageManagedCodexCredential } from "./codex-credentials.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("managed Codex credentials", () => {
  it("stages inline JSON privately and removes it idempotently", async () => {
    const fixture = await credentialFixture();
    const lease = await stageManagedCodexCredential({
      agentHomeDirectory: fixture.home,
      environment: {
        PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: JSON.stringify({
          tokens: { access_token: "inline-canary" },
        }),
      },
    });

    expect(lease.mode).toBe("inline_json");
    await expect(readFile(lease.path, "utf8")).resolves.toContain(
      "inline-canary",
    );
    if (process.platform !== "win32") {
      expect((await stat(lease.path)).mode & 0o777).toBe(0o600);
    }
    await lease.close();
    await lease.close();
    await expect(readFile(lease.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.runIf(process.platform !== "win32")(
    "retries the directory sync after unlink already succeeded",
    async () => {
      const fixture = await credentialFixture();
      const lease = await stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
      });
      const probe = await open(fixture.home, "r");
      const prototype = Object.getPrototypeOf(probe) as {
        sync(this: FileHandle): Promise<void>;
      };
      await probe.close();
      const originalSync = prototype.sync;
      let syncAttempts = 0;
      const syncSpy = vi.spyOn(prototype, "sync").mockImplementation(
        async function (this: FileHandle): Promise<void> {
          syncAttempts += 1;
          if (syncAttempts === 1) throw new Error("injected directory sync failure");
          await originalSync.call(this);
        },
      );
      try {
        await expect(lease.close()).resolves.toBeUndefined();
        await expect(readFile(lease.path)).rejects.toMatchObject({ code: "ENOENT" });
        expect(syncAttempts).toBe(2);
      } finally {
        syncSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "retries preflight, installation, and removal until each is durable",
    async () => {
      const fixture = await credentialFixture();
      const probe = await open(fixture.home, "r");
      const prototype = Object.getPrototypeOf(probe) as {
        sync(this: FileHandle): Promise<void>;
      };
      await probe.close();
      const originalSync = prototype.sync;
      let directorySyncAttempts = 0;
      const syncSpy = vi.spyOn(prototype, "sync").mockImplementation(
        async function (this: FileHandle): Promise<void> {
          if ((await this.stat()).isDirectory()) {
            directorySyncAttempts += 1;
          }
          // The first attempt at each namespace boundary fails; the durable
          // helper must retry before staging or cleanup reports success.
          if ([1, 3, 5].includes(directorySyncAttempts)) {
            throw new Error("injected directory sync failure");
          }
          await originalSync.call(this);
        },
      );
      try {
        const lease = await stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
        });
        await expect(readFile(lease.path, "utf8")).resolves.toBe("{}");
        await expect(lease.close()).resolves.toBeUndefined();
        await expect(readFile(lease.path)).rejects.toMatchObject({ code: "ENOENT" });
        expect(directorySyncAttempts).toBe(6);
      } finally {
        syncSpy.mockRestore();
      }
    },
  );

  it("copies an explicit private source without changing the source", async () => {
    const fixture = await credentialFixture();
    const source = join(fixture.root, "managed-auth.json");
    await writeFile(
      source,
      JSON.stringify({ tokens: { access_token: "managed-canary" } }),
      { mode: 0o600 },
    );
    await chmod(source, 0o600);

    const lease = await stageManagedCodexCredential({
      agentHomeDirectory: fixture.home,
      sourcePath: source,
    });
    expect(lease.mode).toBe("managed_file");
    await expect(readFile(lease.path, "utf8")).resolves.toContain(
      "managed-canary",
    );
    await lease.close();
    await expect(readFile(source, "utf8")).resolves.toContain("managed-canary");
  });

  it("replaces a stale regular auth destination in JSON modes", async () => {
    const fixture = await credentialFixture();
    const destination = join(fixture.home, "auth.json");
    await writeFile(destination, '{"stale":true}', { mode: 0o600 });

    const lease = await stageManagedCodexCredential({
      agentHomeDirectory: fixture.home,
      environment: {
        PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"fresh":true}',
      },
    });
    await expect(readFile(destination, "utf8")).resolves.toBe(
      '{"fresh":true}',
    );
    await lease.close();
  });

  it("cleans stale and provider-generated auth in API-key mode", async () => {
    const fixture = await credentialFixture();
    const destination = join(fixture.home, "auth.json");
    await writeFile(destination, '{"stale":true}');

    const lease = await stageManagedCodexCredential({
      agentHomeDirectory: fixture.home,
      environment: { OPENAI_API_KEY: "launch-only-key" },
    });
    expect(lease.mode).toBe("api_key");
    await expect(readFile(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(destination, '{"provider_generated":true}');
    await lease.close();
    await expect(readFile(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.runIf(process.platform !== "win32")(
    "keeps API-key staging pending until stale removal is durable",
    async () => {
      const fixture = await credentialFixture();
      const destination = join(fixture.home, "auth.json");
      await writeFile(destination, '{"stale":true}', { mode: 0o600 });
      const probe = await open(fixture.home, "r");
      const prototype = Object.getPrototypeOf(probe) as {
        sync(this: FileHandle): Promise<void>;
      };
      await probe.close();
      const originalSync = prototype.sync;
      let syncAttempts = 0;
      const syncSpy = vi.spyOn(prototype, "sync").mockImplementation(
        async function (this: FileHandle): Promise<void> {
          syncAttempts += 1;
          if (syncAttempts === 1) throw new Error("injected directory sync failure");
          await originalSync.call(this);
        },
      );
      try {
        const lease = await stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { OPENAI_API_KEY: "launch-only-key" },
        });
        await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lease.close()).resolves.toBeUndefined();
        expect(syncAttempts).toBe(3);
      } finally {
        syncSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails within a bound and retains cleanup ownership until durability recovers",
    async () => {
      const fixture = await credentialFixture();
      const probe = await open(fixture.home, "r");
      const prototype = Object.getPrototypeOf(probe) as {
        sync(this: FileHandle): Promise<void>;
      };
      await probe.close();
      const syncSpy = vi.spyOn(prototype, "sync").mockRejectedValue(
        new Error("persistent directory sync failure"),
      );
      try {
        const staging = stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { OPENAI_API_KEY: "launch-only-key" },
        });
        await expect(staging).rejects.toThrow(
          "remained non-durable after 8 attempts",
        );
        expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(8);
        syncSpy.mockRestore();
        const lease = await stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { OPENAI_API_KEY: "launch-only-key" },
        });
        await expect(lease.close()).resolves.toBeUndefined();
      } finally {
        syncSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "owns cleanup when post-rename directory durability fails",
    async () => {
      const fixture = await credentialFixture();
      const destination = join(fixture.home, "auth.json");
      const probe = await open(fixture.home, "r");
      const prototype = Object.getPrototypeOf(probe) as {
        sync(this: FileHandle): Promise<void>;
      };
      await probe.close();
      const originalSync = prototype.sync;
      let directorySyncAttempts = 0;
      const syncSpy = vi.spyOn(prototype, "sync").mockImplementation(
        async function (this: FileHandle): Promise<void> {
          if ((await this.stat()).isDirectory()) {
            directorySyncAttempts += 1;
            if (directorySyncAttempts > 1) {
              throw new Error("persistent post-rename sync failure");
            }
          }
          await originalSync.call(this);
        },
      );
      try {
        await expect(stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
        })).rejects.toThrow("remained non-durable after 8 attempts");
        await expect(readFile(destination, "utf8")).resolves.toBe("{}");

        syncSpy.mockRestore();
        const lease = await stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
        });
        await expect(readFile(destination, "utf8")).resolves.toBe("{}");
        await lease.close();
      } finally {
        syncSpy.mockRestore();
      }
    },
  );

  it("rejects missing, ambiguous, malformed, and unsafe sources", async () => {
    const fixture = await credentialFixture();
    await expect(
      stageManagedCodexCredential({ agentHomeDirectory: fixture.home }),
    ).rejects.toThrow(/credential missing/);
    await expect(
      stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: {
          OPENAI_API_KEY: "key",
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}",
        },
      }),
    ).rejects.toThrow(/ambiguous/);
    await expect(
      stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "[]" },
      }),
    ).rejects.toThrow(/malformed/);

    const source = join(fixture.root, "unsafe-auth.json");
    await writeFile(source, "{}", { mode: 0o644 });
    await chmod(source, 0o644);
    if (process.platform !== "win32") {
      await expect(
        stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          sourcePath: source,
        }),
      ).rejects.toThrow(/permissions are unsafe/);
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects a credential home that is not private",
    async () => {
      const fixture = await credentialFixture();
      await chmod(fixture.home, 0o755);

      await expect(
        stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { OPENAI_API_KEY: "launch-only-key" },
        }),
      ).rejects.toThrow(/home permissions are unsafe/);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symbolic-link source",
    async () => {
      const fixture = await credentialFixture();
      const target = join(fixture.root, "auth-target.json");
      const source = join(fixture.root, "auth-link.json");
      await writeFile(target, "{}", { mode: 0o600 });
      await symlink(target, source);

      await expect(
        stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          sourcePath: source,
        }),
      ).rejects.toThrow(/credential missing/);
    },
  );

  it.runIf(process.platform !== "win32")(
    "replaces a stale destination link without touching its target",
    async () => {
      const fixture = await credentialFixture();
      const target = join(fixture.root, "outside.json");
      const destination = join(fixture.home, "auth.json");
      await writeFile(target, '{"outside":true}', { mode: 0o600 });
      await symlink(target, destination);

      const lease = await stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
      });
      await expect(readFile(target, "utf8")).resolves.toBe('{"outside":true}');
      expect((await stat(lease.path)).isFile()).toBe(true);
      await lease.close();
    },
  );
});

async function credentialFixture(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-credential-"));
  temporaryDirectories.push(root);
  const home = join(root, "codex-home");
  await mkdir(home, { mode: 0o700 });
  await chmod(home, 0o700);
  return { root, home };
}
