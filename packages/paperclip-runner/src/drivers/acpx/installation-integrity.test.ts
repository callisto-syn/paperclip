import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import {
  revalidateVerifiedAcpxCommand,
  verifyQualifiedAcpxInstallation,
} from "./installation-integrity.js";

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
      commandPath: await realpath(fixture.commandPath),
      commandDigest: fixture.profile.commandDigest,
      commandIdentity: {
        device: expect.any(String),
        inode: expect.any(String),
        size: expect.any(String),
      },
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

  it("detects pathname replacement before launch", async () => {
    const fixture = await installationFixture();
    const installation = await verifyQualifiedAcpxInstallation(
      fixture.profile,
      fixture.resolve,
    );
    await writeFile(fixture.commandPath, "replacement");

    await expect(revalidateVerifiedAcpxCommand(installation)).rejects.toThrow(
      /digest mismatch|identity changed/,
    );
  });
});

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
  const command = "#!/usr/bin/env node\nprocess.exit(0);\n";
  await Promise.all([
    writeFile(
      serverPackageJsonPath,
      JSON.stringify({ version: "0.0.33", bin: "bin/server.js" }),
    ),
    writeFile(runtimePackageJsonPath, JSON.stringify({ version: "0.84.2" })),
    writeFile(commandPath, command),
  ]);
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
    serverPackageJsonPath,
    runtimePackageJsonPath,
    resolve(packageName: string): string {
      const resolved = paths.get(packageName);
      if (!resolved) throw new Error(`unexpected package ${packageName}`);
      return resolved;
    },
  };
}
