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

  await removeCredential(destination, home);
  if (hasApiKey) return credentialLease(destination, home, "api_key");

  const credential = hasInlineJson
    ? boundedInlineCredential(inlineJson!)
    : await readManagedCredential(input.sourcePath!);
  try {
    validateCredentialDocument(credential);
    await writeCredential(destination, home, credential);
  } finally {
    credential.fill(0);
  }
  return credentialLease(
    destination,
    home,
    hasInlineJson ? "inline_json" : "managed_file",
  );
}

function credentialLease(
  path: string,
  home: string,
  mode: ManagedCodexCredentialMode,
): ManagedCodexCredentialLease {
  let closed = false;
  return Object.freeze({
    path,
    mode,
    async close(): Promise<void> {
      if (closed) return;
      await removeCredential(path, home);
      closed = true;
    },
  });
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
  let installed = false;
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, destination);
    installed = true;
    await syncDirectory(home);
  } catch (error) {
    if (installed) {
      try {
        await removeCredential(destination, home);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Managed Codex credential staging and rollback failed",
        );
      }
    }
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function removeCredential(path: string, home: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      throw new Error("Managed Codex credential destination is a directory");
    }
    await unlink(path);
    await syncDirectory(home);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
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
