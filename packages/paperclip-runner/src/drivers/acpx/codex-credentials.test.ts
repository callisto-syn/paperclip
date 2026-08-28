import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
