import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const ACPX_WORKSPACE_RELATIVE_DISPLAY_BOUNDARY =
  "paperclip.workspace_relative_display.v2";
export const ACPX_WORKSPACE_ENTRY_ATTESTATION = "paperclip.workspace_entry.v1";
const RFC_URI_SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Converts provider paths to workspace-relative display targets using the
 * sidecar host's path semantics. URI-scheme and Windows drive-shaped values
 * are ambiguous on POSIX, so they require a real, in-workspace filesystem
 * entry before the sidecar may attest them as filename data. Consumers must
 * treat the result as display data, never as file-access authorization.
 */
export function safeAcpxLocations(
  locations: readonly unknown[] | null | undefined,
  workingDirectory: string | null | undefined,
): Array<Record<string, unknown>> {
  if (!workingDirectory) return [];
  const cwd = resolve(workingDirectory);
  let canonicalCwd: string | null | undefined;
  return (locations ?? []).slice(0, 2_000).flatMap((location) => {
    const candidate = record(location);
    const rawPath = typeof candidate.path === "string" ? candidate.path : "";
    if (!rawPath || rawPath.includes("\0") || rawPath.startsWith("\\"))
      return [];
    const absolute = isAbsolute(rawPath)
      ? resolve(rawPath)
      : resolve(cwd, rawPath);
    const local = relative(cwd, absolute);
    if (!local || isAbsolute(local)) return [];
    const portable = sep === "\\" ? local.replaceAll("\\", "/") : local;
    if (
      portable.startsWith("/") ||
      portable.split("/").some((segment) => segment === "..")
    ) {
      return [];
    }
    // Classify the value we actually emit as well as the provider's spelling.
    // Dot-relative and absolute paths can normalize to a scheme-shaped display
    // target even though their raw forms did not begin with a scheme prefix.
    const requiresEntryAttestation =
      WINDOWS_DRIVE_PREFIX.test(rawPath) ||
      RFC_URI_SCHEME_PREFIX.test(rawPath) ||
      WINDOWS_DRIVE_PREFIX.test(portable) ||
      RFC_URI_SCHEME_PREFIX.test(portable);
    let entryAttested = false;
    if (requiresEntryAttestation) {
      try {
        if (canonicalCwd === undefined) canonicalCwd = realpathSync(cwd);
        if (canonicalCwd === null) return [];
        const canonicalEntry = realpathSync(absolute);
        const entryRelative = relative(canonicalCwd, canonicalEntry);
        entryAttested =
          Boolean(entryRelative) &&
          !isAbsolute(entryRelative) &&
          !entryRelative.split(sep).some((segment) => segment === "..");
      } catch {
        canonicalCwd = canonicalCwd ?? null;
        return [];
      }
      if (!entryAttested) return [];
    }
    return [
      {
        path: [...portable].slice(0, 4_000).join(""),
        line: candidate.line ?? null,
        pathBoundary: ACPX_WORKSPACE_RELATIVE_DISPLAY_BOUNDARY,
        ...(entryAttested
          ? { pathAttestation: ACPX_WORKSPACE_ENTRY_ATTESTATION }
          : {}),
      },
    ];
  });
}
