export interface OpenedAcpxSidecarHost {
  identity(): unknown;
  status(): Promise<unknown>;
  close(options: { reason: string }): Promise<void>;
}

export async function verifyOpenedAcpxSidecarHost(
  host: OpenedAcpxSidecarHost,
  sanitizeStatus: (value: unknown) => Record<string, unknown>,
): Promise<{ identity: unknown; status: Record<string, unknown> }> {
  try {
    const identity = host.identity();
    const status = sanitizeStatus(await host.status());
    return { identity, status };
  } catch (error) {
    await host
      .close({ reason: "ACPX session open verification failed" })
      .catch(() => undefined);
    throw error;
  }
}

export interface AcpxRunAttachment {
  runId: string;
  catalogRevision: number;
}

export function parseAcpxRunAttachment(
  params: Record<string, unknown>,
): AcpxRunAttachment {
  return {
    runId: boundedIdentity(params.runId, "runId"),
    catalogRevision: positiveInteger(params.catalogRevision, "catalogRevision"),
  };
}

export function boundedIdentity(value: unknown, field: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`${field} is required`);
  if (result.length > 240 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`${field} is invalid`);
  }
  return result;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return Number(value);
}
