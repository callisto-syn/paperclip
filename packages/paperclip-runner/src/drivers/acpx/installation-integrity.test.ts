import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { verifyQualifiedAcpxInstallation } from "./installation-integrity.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ACPX installation integrity", () => {
  it("accepts the exact package, version, executable, and runtime", async () => {
    const fixture = await installationFixture();
    const installation = await verifyQualifiedAcpxInstallation(
      fixture.profile,
      fixture.resolve,
    );
    expect(installation).toMatchObject({
      commandDigest: fixture.profile.commandDigest,
      openCommand: expect.any(Function),
      agentServerPackageJsonPath: await realpath(fixture.serverPackageJsonPath),
      agentRuntimePackageJsonPath: await realpath(
        fixture.runtimePackageJsonPath,
      ),
    });
  });

  it("rejects package version and executable digest drift", async () => {
    const fixture = await installationFixture();
    await writeFile(
      fixture.serverPackageJsonPath,
      JSON.stringify({ version: "0.0.34", bin: "bin/server.js" }),
    );
    await expect(
      verifyQualifiedAcpxInstallation(fixture.profile, fixture.resolve),
    ).rejects.toThrow(/package version mismatch/);

    await writeFile(
      fixture.serverPackageJsonPath,
      JSON.stringify({ version: "0.0.33", bin: "bin/server.js" }),
    );
    await writeFile(fixture.commandPath, "changed executable");
    await expect(
      verifyQualifiedAcpxInstallation(fixture.profile, fixture.resolve),
    ).rejects.toThrow(/digest mismatch/);
  });

  it("rejects ambiguous and escaping executable metadata", async () => {
    const fixture = await installationFixture();
    await writeFile(
      fixture.serverPackageJsonPath,
      JSON.stringify({
        version: "0.0.33",
        bin: { first: "bin/server.js", second: "bin/other.js" },
      }),
    );
    await expect(
      verifyQualifiedAcpxInstallation(fixture.profile, fixture.resolve),
    ).rejects.toThrow(/one relative executable/);

    await writeFile(
      fixture.serverPackageJsonPath,
      JSON.stringify({ version: "0.0.33", bin: "../outside.js" }),
    );
    await expect(
      verifyQualifiedAcpxInstallation(fixture.profile, fixture.resolve),
    ).rejects.toThrow(/escapes its package/);
  });

  it("rejects runtime version drift", async () => {
    const fixture = await installationFixture();
    await writeFile(
      fixture.runtimePackageJsonPath,
      JSON.stringify({ version: "0.84.3" }),
    );
    await expect(
      verifyQualifiedAcpxInstallation(fixture.profile, fixture.resolve),
    ).rejects.toThrow(/runtime version mismatch/);
  });

  it.runIf(process.platform !== "win32")(
    "rejects an executable symlink even when its target has the expected digest",
    async () => {
      const fixture = await installationFixture();
      const target = join(fixture.root, "outside.js");
      await writeFile(target, fixture.command);
      await rm(fixture.commandPath);
      await symlink(target, fixture.commandPath);

      await expect(
        verifyQualifiedAcpxInstallation(fixture.profile, fixture.resolve),
      ).rejects.toThrow(/no-follow regular file/);
    },
  );

  it("detects pathname replacement before opening a launch lease", async () => {
    const fixture = await installationFixture();
    const installation = await verifyQualifiedAcpxInstallation(
      fixture.profile,
      fixture.resolve,
    );
    await writeFile(fixture.commandPath, "replacement");

    await expect(installation.openCommand()).rejects.toThrow(
      /digest mismatch|identity changed/,
    );
  });

  it("launches the verified bytes after its pathname is replaced", async () => {
    const fixture = await installationFixture();
    const installation = await verifyQualifiedAcpxInstallation(
      fixture.profile,
      fixture.resolve,
    );
    const lease = await installation.openCommand();
    const replacement = `${fixture.commandPath}.replacement`;
    await writeFile(
      replacement,
      '#!/usr/bin/env node\nprocess.stdout.write("replacement");\n',
    );
    await chmod(replacement, 0o755);
    await rename(replacement, fixture.commandPath);

    await expectOutput(lease.spawn(), "verified");
  });

  it("launches the verified bytes after the open inode is modified", async () => {
    const fixture = await installationFixture();
    const installation = await verifyQualifiedAcpxInstallation(
      fixture.profile,
      fixture.resolve,
    );
    const lease = await installation.openCommand();
    const before = await stat(fixture.commandPath, { bigint: true });
    await writeFile(
      fixture.commandPath,
      '#!/usr/bin/env node\nprocess.stdout.write("modified");\n',
    );
    const after = await stat(fixture.commandPath, { bigint: true });
    expect(after.ino).toBe(before.ino);

    await expectOutput(lease.spawn(), "verified");
  });

  it("loads a verified ESM snapshot with relative imports and arguments", async () => {
    const fixture = await installationFixture();
    const command = [
      'import value from "./value.js";',
      "process.stdout.write(`${value}:${process.argv[2]}`);",
    ].join("\n");
    await Promise.all([
      writeFile(
        fixture.serverPackageJsonPath,
        JSON.stringify({
          version: "0.0.33",
          type: "module",
          bin: "bin/server.js",
        }),
      ),
      writeFile(fixture.commandPath, command),
      writeFile(
        join(fixture.commandDirectory, "value.js"),
        'export default "relative";',
      ),
    ]);
    const installation = await verifyQualifiedAcpxInstallation(
      {
        ...fixture.profile,
        commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
      },
      fixture.resolve,
    );

    await expectOutput(
      (await installation.openCommand()).spawn(["argument"]),
      "relative:argument",
    );
  });
});

async function expectOutput(
  child: ChildProcess,
  expected: string,
): Promise<void> {
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  const [exitCode] = await once(child, "exit");
  expect(exitCode).toBe(0);
  expect(stdout).toBe(expected);
}

async function installationFixture() {
  const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-installation-"));
  temporaryDirectories.push(root);
  const serverDirectory = join(root, "pi-acp");
  const runtimeDirectory = join(root, "pi-runtime");
  const commandDirectory = join(serverDirectory, "bin");
  await Promise.all([
    mkdir(commandDirectory, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
  ]);
  const serverPackageJsonPath = join(serverDirectory, "package.json");
  const runtimePackageJsonPath = join(runtimeDirectory, "package.json");
  const commandPath = join(commandDirectory, "server.js");
  const command = '#!/usr/bin/env node\nprocess.stdout.write("verified");\n';
  await Promise.all([
    writeFile(
      serverPackageJsonPath,
      JSON.stringify({ version: "0.0.33", bin: "bin/server.js" }),
    ),
    writeFile(runtimePackageJsonPath, JSON.stringify({ version: "0.84.2" })),
    writeFile(commandPath, command),
  ]);
  await chmod(commandPath, 0o755);
  const base = resolveQualifiedAcpxProfile(
    "pi",
    "openrouter/deepseek/deepseek-v4-flash-0731",
  );
  const profile = {
    ...base,
    commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
  };
  const paths = new Map([
    ["pi-acp", serverPackageJsonPath],
    ["@earendil-works/pi-coding-agent", runtimePackageJsonPath],
  ]);
  return {
    root,
    command,
    profile,
    commandPath,
    commandDirectory,
    serverPackageJsonPath,
    runtimePackageJsonPath,
    resolve(packageName: string): string {
      const resolved = paths.get(packageName);
      if (!resolved) throw new Error(`unexpected package ${packageName}`);
      return resolved;
    },
  };
}
