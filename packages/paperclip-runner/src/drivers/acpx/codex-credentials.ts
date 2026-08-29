import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const MAX_CODEX_CREDENTIAL_BYTES = 256 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const MAX_DIRECTORY_SYNC_ATTEMPTS = 8;
const MAX_AUTONOMOUS_CREDENTIAL_CLEANUP_ATTEMPTS = 8;
const CREDENTIAL_CLEANUP_INTENT = ".paperclip-auth-cleanup-required";

interface QuarantinedCredentialCleanup {
  path: string;
  home: string;
  intentPath: string;
  recovery: Promise<void> | null;
}

const quarantinedCredentialCleanups = new Map<
  string,
  QuarantinedCredentialCleanup
>();

export type ManagedCodexCredentialMode =
  "api_key" | "inline_json" | "managed_file";

export interface ManagedCodexCredentialLease {
  readonly path: string;
  readonly mode: ManagedCodexCredentialMode;
  close(): Promise<void>;
}

/** Stage one explicit Codex authentication source in its isolated runtime home. */
export async function stageManagedCodexCredential(input: {
  agentHomeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  sourcePath?: string;
}): Promise<ManagedCodexCredentialLease> {
  const home = await realpath(input.agentHomeDirectory);
  const homeMetadata = await lstat(home);
  if (!homeMetadata.isDirectory() || homeMetadata.isSymbolicLink()) {
    throw new Error("Managed Codex credential home must be a real directory");
  }
  if (
    process.platform !== "win32" &&
    ((homeMetadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" &&
        homeMetadata.uid !== process.getuid()))
  ) {
    throw new Error("Managed Codex credential home permissions are unsafe");
  }
  const destination = join(home, "auth.json");
  const intentPath = join(home, CREDENTIAL_CLEANUP_INTENT);
  await recoverQuarantinedCredentialCleanup(destination, home);
  await recoverPersistedCredentialCleanup(destination, home, intentPath);
  const environment = input.environment ?? {};
  const hasApiKey = Boolean(
    environment.CODEX_API_KEY || environment.OPENAI_API_KEY,
  );
  const inlineJson = environment.PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET;
  const hasInlineJson = typeof inlineJson === "string" && inlineJson.length > 0;
  const hasManagedFile =
    typeof input.sourcePath === "string" && input.sourcePath.length > 0;
  const sourceCount = [hasApiKey, hasInlineJson, hasManagedFile].filter(
    Boolean,
  ).length;
  if (sourceCount === 0) {
    throw new Error(
      "provider_initialize_protocol_error: provider=acpx stage=credential.stage managed Codex credential missing",
    );
  }
  if (sourceCount !== 1) {
    throw new Error("Managed Codex credential source is ambiguous");
  }

  if (
    hasManagedFile &&
    (!isAbsolute(input.sourcePath!) ||
      resolve(input.sourcePath!) === destination)
  ) {
    throw new Error(
      "Managed Codex credential source must be an external absolute path",
    );
  }

  if (hasApiKey) {
    // Codex will read the API key from the launch environment. Persist cleanup
    // intent before touching auth.json and retain it for the lease lifetime,
    // so a replacement runner removes stale or provider-generated auth after
    // a crash before it admits another provider.
    try {
      await createCredentialCleanupIntent(intentPath, home);
      await removeCredential(destination, home);
    } catch (error) {
      quarantineCredentialCleanup(destination, home, intentPath);
      throw error;
    }
    return credentialLease(destination, home, intentPath, "api_key");
  }

  const credential = hasInlineJson
    ? boundedInlineCredential(inlineJson!)
    : await readManagedCredential(input.sourcePath!);
  try {
    validateCredentialDocument(credential);
    await createCredentialCleanupIntent(intentPath, home);
    // Establish durable absence before installing a replacement. This keeps a
    // previously staged authentication document from reappearing after a
    // crash even when the following rename is interrupted.
    await removeCredential(destination, home);
    await writeCredential(destination, home, credential);
  } catch (error) {
    // Either unlink or rename may already have mutated the credential
    // namespace before directory durability failed. Retain a bounded process
    // owner that removes auth.json, and make later staging recover that owner
    // before admitting another provider.
    quarantineCredentialCleanup(destination, home, intentPath);
    throw error;
  } finally {
    credential.fill(0);
  }
  return credentialLease(
    destination,
    home,
    intentPath,
    hasInlineJson ? "inline_json" : "managed_file",
  );
}

function quarantineCredentialCleanup(
  path: string,
  home: string,
  intentPath: string,
): void {
  const existing = quarantinedCredentialCleanups.get(home);
  if (existing !== undefined) return;
  const cleanup: QuarantinedCredentialCleanup = {
    path,
    home,
    intentPath,
    recovery: null,
  };
  quarantinedCredentialCleanups.set(home, cleanup);
  startCredentialCleanupRecovery(
    cleanup,
    MAX_AUTONOMOUS_CREDENTIAL_CLEANUP_ATTEMPTS,
  );
}

function startCredentialCleanupRecovery(
  cleanup: QuarantinedCredentialCleanup,
  maxAttempts: number,
): Promise<void> {
  if (cleanup.recovery) return cleanup.recovery;
  const recovery = (async () => {
    let retryDelayMs = 10;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await removeReplaceableCredential(cleanup.path);
        await syncDirectory(cleanup.home);
        await removeCredentialCleanupIntent(
          cleanup.intentPath,
          cleanup.home,
        );
        quarantinedCredentialCleanups.delete(cleanup.home);
        return;
      } catch {
        if (attempt === maxAttempts) return;
        await new Promise<void>((resolveRetry) => {
          const timer = setTimeout(resolveRetry, retryDelayMs);
          timer.unref?.();
        });
        retryDelayMs = Math.min(retryDelayMs * 2, 1_000);
      }
    }
  })();
  cleanup.recovery = recovery;
  void recovery.finally(() => {
    if (cleanup.recovery === recovery) cleanup.recovery = null;
  }).catch(() => undefined);
  return recovery;
}

async function recoverQuarantinedCredentialCleanup(
  path: string,
  home: string,
): Promise<void> {
  const cleanup = quarantinedCredentialCleanups.get(home);
  if (cleanup === undefined) return;
  await (cleanup.recovery ?? startCredentialCleanupRecovery(cleanup, 1));
  if (!quarantinedCredentialCleanups.has(home)) return;
  const admissionRecovery = startCredentialCleanupRecovery(cleanup, 1);
  await admissionRecovery;
  if (quarantinedCredentialCleanups.has(home)) {
    throw new Error(
      `Managed Codex credential cleanup remains non-durable for ${path}`,
    );
  }
}

async function recoverPersistedCredentialCleanup(
  path: string,
  home: string,
  intentPath: string,
): Promise<void> {
  if (!(await pathExists(intentPath))) return;
  await removeCredential(path, home);
  await removeCredentialCleanupIntent(intentPath, home);
}

function credentialLease(
  path: string,
  home: string,
  intentPath: string,
  mode: ManagedCodexCredentialMode,
): ManagedCodexCredentialLease {
  let closed = false;
  return Object.freeze({
    path,
    mode,
    async close(): Promise<void> {
      if (closed) return;
      try {
        await removeCredential(path, home);
        await removeCredentialCleanupIntent(intentPath, home);
        closed = true;
      } catch (error) {
        quarantineCredentialCleanup(path, home, intentPath);
        throw error;
      }
    },
  });
}

async function createCredentialCleanupIntent(
  intentPath: string,
  home: string,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      intentPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile("paperclip-managed-codex-cleanup-v1\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectoryDurably(home);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function removeCredentialCleanupIntent(
  intentPath: string,
  home: string,
): Promise<void> {
  await removeReplaceableCredential(intentPath);
  await syncDirectoryDurably(home);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function boundedInlineCredential(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length < 1 || bytes.length > MAX_CODEX_CREDENTIAL_BYTES) {
    bytes.fill(0);
    throw new Error(
      "Managed Codex credential document exceeds its bounded size",
    );
  }
  return bytes;
}

async function readManagedCredential(sourcePath: string): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await open(
      sourcePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new Error(
      "provider_initialize_protocol_error: provider=acpx stage=credential.stage managed Codex credential missing",
    );
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(MAX_CODEX_CREDENTIAL_BYTES)
    ) {
      throw new Error(
        "Managed Codex credential source is not a bounded regular file",
      );
    }
    if (process.platform !== "win32" && (before.mode & 0o077n) !== 0n) {
      throw new Error("Managed Codex credential source permissions are unsafe");
    }
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      before.uid !== BigInt(process.getuid())
    ) {
      throw new Error("Managed Codex credential source ownership is unsafe");
    }
    const bytes = await readHandle(handle, Number(before.size));
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.size !== BigInt(bytes.length)
    ) {
      bytes.fill(0);
      throw new Error("Managed Codex credential source changed while read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readHandle(handle: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== size) {
    bytes.fill(0);
    throw new Error("Managed Codex credential source ended while read");
  }
  return bytes;
}

function validateCredentialDocument(bytes: Buffer): void {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Managed Codex credential source is malformed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Managed Codex credential source is malformed");
  }
}

async function writeCredential(
  destination: string,
  home: string,
  bytes: Buffer,
): Promise<void> {
  const temporaryPath = join(
    home,
    `.auth.json.tmp-${randomBytes(12).toString("hex")}`,
  );
  let handle: FileHandle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
  } catch {
    throw new Error("Managed Codex credential destination could not be opened");
  }
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    try {
      await rename(temporaryPath, destination);
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EACCES", "EEXIST", "ENOTEMPTY", "EPERM"].includes(
          errorCode(error) ?? "",
        )
      ) {
        throw error;
      }
      // Win32 rename does not replace an existing destination. Remove only
      // the already-conflicting pathname (never a real directory), then move
      // the fully synced private temporary file into place.
      await removeReplaceableCredential(destination);
      await rename(temporaryPath, destination);
    }
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
  // Do not acknowledge the lease until the namespace update is durable. A
  // directory-sync failure is a fail-closed admission condition: retry here so
  // neither a returned lease nor a thrown pre-lease error can lose ownership
  // of auth.json across a crash.
  await syncDirectoryDurably(home);
}

async function removeReplaceableCredential(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      throw new Error("Managed Codex credential destination is a directory");
    }
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function removeCredential(path: string, home: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      throw new Error("Managed Codex credential destination is a directory");
    }
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  // Sync even after ENOENT: a previous unlink may have succeeded before its
  // directory sync failed. Never report cleanup or finish preflight while the
  // removal can still be rolled back by a crash.
  await syncDirectoryDurably(home);
}

async function syncDirectoryDurably(directory: string): Promise<void> {
  let retryDelayMs = 10;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_DIRECTORY_SYNC_ATTEMPTS; attempt += 1) {
    try {
      await syncDirectory(directory);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === MAX_DIRECTORY_SYNC_ATTEMPTS) break;
      // Keep admission closed during transient failures, while bounding total
      // startup/shutdown latency for a persistently unhealthy filesystem.
      await new Promise<void>((resolveRetry) => {
        setTimeout(resolveRetry, retryDelayMs);
      });
      retryDelayMs = Math.min(retryDelayMs * 2, 1_000);
    }
  }
  throw new Error(
    `Managed Codex credential directory remained non-durable after ${MAX_DIRECTORY_SYNC_ATTEMPTS} attempts`,
    { cause: lastError },
  );
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : null;
}
