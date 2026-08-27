import { readFile, stat } from "node:fs/promises";

export const LIVE_CONSOLE_CONFORMANCE_SCHEMA =
  "paperclip.runner.live-console.conformance.v1" as const;

export interface LiveConsoleRuntimeRequestFixture {
  id: string;
  method: string;
  requestKind: string;
  resolution: Record<string, unknown> & { action: string };
  expectedResponse: Record<string, unknown>;
}

export interface LiveConsoleGoalFixture {
  action: "get" | "set" | "pause" | "resume" | "clear";
  method: string;
  params: Record<string, unknown>;
}

export interface LiveConsoleConformanceFixture {
  schema: typeof LIVE_CONSOLE_CONFORMANCE_SCHEMA;
  codexVersion: string;
  runtimeRequests: LiveConsoleRuntimeRequestFixture[];
  goals: LiveConsoleGoalFixture[];
  lineage: {
    rootThreadId: string;
    childThread: Record<string, unknown> & { id: string; sessionId: string };
  };
  controls: Record<string, { turnId?: string; expected: string }>;
  reconnect: {
    runId: string;
    normalizedSessionId: string;
    driverSessionId: string;
    providerSessionId: string;
    lastSourceSequence: number;
  };
  redactionMarkers: string[];
}

const MAX_LIVE_CONSOLE_FIXTURE_BYTES = 1024 * 1024;
const MAX_RUNTIME_REQUEST_CASES = 64;
const MAX_REDACTION_MARKERS = 64;
const MAX_CONTROL_CASES = 64;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Load the deterministic Live console wire fixture without trusting its shape. */
export async function loadLiveConsoleConformanceFixture(
  path: string,
): Promise<LiveConsoleConformanceFixture> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_LIVE_CONSOLE_FIXTURE_BYTES) {
    throw new Error("Live console fixture exceeded its file-size limit");
  }
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  const fixture = record(value);
  if (fixture?.schema !== LIVE_CONSOLE_CONFORMANCE_SCHEMA) {
    throw new Error("Live console fixture has an unsupported schema");
  }
  if (!nonEmpty(fixture.codexVersion)) {
    throw new Error("Live console fixture must name the observed Codex version");
  }
  if (
    !Array.isArray(fixture.runtimeRequests) ||
    fixture.runtimeRequests.length === 0 ||
    fixture.runtimeRequests.length > MAX_RUNTIME_REQUEST_CASES
  ) {
    throw new Error("Live console fixture must include runtime request cases");
  }
  if (!Array.isArray(fixture.goals) || fixture.goals.length !== 5) {
    throw new Error("Live console fixture must include all five goal operations");
  }
  const requestIds = new Set<string>();
  for (const candidate of fixture.runtimeRequests) {
    const request = record(candidate);
    const resolution = record(request?.resolution);
    if (
      !nonEmpty(request?.id) ||
      requestIds.has(request.id) ||
      !nonEmpty(request.method) ||
      !nonEmpty(request.requestKind) ||
      !nonEmpty(resolution?.action) ||
      record(request.expectedResponse) === null
    ) {
      throw new Error("Live console fixture contains an invalid runtime request case");
    }
    requestIds.add(request.id);
  }
  const goalMethods = {
    get: "thread/goal/get",
    set: "thread/goal/set",
    pause: "thread/goal/set",
    resume: "thread/goal/set",
    clear: "thread/goal/clear",
  } as const;
  const actions = new Set<string>();
  for (const candidate of fixture.goals) {
    const goal = record(candidate);
    if (goal === null) {
      throw new Error("Live console fixture contains an invalid goal operation");
    }
    const action = goal?.action;
    if (
      typeof action !== "string" ||
      !(action in goalMethods) ||
      goal.method !== goalMethods[action as keyof typeof goalMethods] ||
      record(goal.params) === null
    ) {
      throw new Error("Live console fixture contains an invalid goal operation");
    }
    actions.add(action);
  }
  if (!["get", "set", "pause", "resume", "clear"].every((action) => actions.has(action))) {
    throw new Error("Live console fixture goal operation set is incomplete");
  }
  const lineage = record(fixture.lineage);
  const child = record(lineage?.childThread);
  const controls = record(fixture.controls);
  const reconnect = record(fixture.reconnect);
  if (
    !nonEmpty(lineage?.rootThreadId) ||
    !nonEmpty(child?.id) ||
    !nonEmpty(child.sessionId) ||
    !nonEmpty(reconnect?.runId) ||
    !nonEmpty(reconnect.normalizedSessionId) ||
    !nonEmpty(reconnect.driverSessionId) ||
    !nonEmpty(reconnect.providerSessionId) ||
    !Number.isSafeInteger(reconnect.lastSourceSequence) ||
    (reconnect.lastSourceSequence as number) < 0
  ) {
    throw new Error("Live console fixture identity or lineage is incomplete");
  }
  if (
    controls === null ||
    Object.keys(controls).length === 0 ||
    Object.keys(controls).length > MAX_CONTROL_CASES ||
    Object.values(controls).some((candidate) => {
      const control = record(candidate);
      return control === null ||
        !nonEmpty(control.expected) ||
        (control.turnId !== undefined && !nonEmpty(control.turnId));
    })
  ) {
    throw new Error("Live console fixture controls are invalid");
  }
  if (
    !Array.isArray(fixture.redactionMarkers) ||
    fixture.redactionMarkers.length > MAX_REDACTION_MARKERS ||
    !fixture.redactionMarkers.every(nonEmpty)
  ) {
    throw new Error("Live console fixture redaction markers are invalid");
  }
  return value as LiveConsoleConformanceFixture;
}
