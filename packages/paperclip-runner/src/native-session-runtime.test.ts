import { describe, expect, it, vi } from "vitest";

import type { ControlPlanePort } from "./contracts/control-plane-port.js";
import type { NativeExecutionInputV1 } from "./contracts/native-execution.js";
import type { NativeRunIdentity } from "./contracts/types.js";
import type {
  NativeSession,
  NativeSessionBackend,
  PersistedNativeSession,
} from "./contracts/native-session-backend.js";
import type {
  PrpEvent,
  PrpStructuredRunResult,
  PrpTerminalState,
} from "./protocol/replay-contract.js";
import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  nativeRuntimePromptDigest,
} from "./contracts/runtime-context.js";
import {
  executeNativeSession,
  type ExecuteNativeSessionOptions,
} from "./native-session-runtime.js";

const identity = {
  runId: "run-recovery",
  sessionId: "session-recovery",
  companyId: "company-recovery",
  issueId: "issue-recovery",
  agentId: "agent-recovery",
};

const result: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: "Recovered native work completed.",
  completionClaim: {
    contractRevision: "1",
    objectiveSatisfied: true,
    criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }],
    remainingWork: [],
  },
  evidence: [],
  verification: [{ commandOrCheck: "recovery", status: "passed" }],
  attentionRequests: [],
  artifacts: [],
};

const terminal: PrpTerminalState = {
  schema: "paperclip.prp.terminal.v1",
  turnTerminalState: "completed",
  runTerminalState: "succeeded",
  reportedWorkDisposition: "done",
};

const yieldedResult: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "yielded",
  summary: "Waiting for the requested response.",
  completionClaim: {
    contractRevision: "1",
    objectiveSatisfied: false,
    criteria: [{ criterionId: "objective", status: "unknown", evidenceRefs: ["interaction:pending"] }],
    remainingWork: [{ description: "Resume after the response.", blocksCompletion: true }],
  },
  evidence: [{ ref: "interaction:pending" }],
  verification: [],
  attentionRequests: [],
  artifacts: [{ kind: "issue_thread_interaction", ref: "interaction:pending" }],
  continuation: {
    kind: "response_wake",
    summary: "Resume from the answer.",
    idempotencyKey: "interaction-response:pending",
  },
};

const input: NativeExecutionInputV1 = {
  schema: "paperclip.native-execution-input.v1",
  binding: {
    companyId: identity.companyId,
    runId: identity.runId,
    issueId: identity.issueId,
    agentId: identity.agentId,
    executionWorkspaceId: "workspace-recovery",
  },
  task: {
    identifier: "PAP-RECOVERY",
    title: "Recover native work",
    description: null,
    prompt: "# PAP-RECOVERY: Recover native work",
    workMode: "standard",
  },
  workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
  session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1 },
  provider: { kind: "codex", model: null },
  completionContract: {
    id: "contract-recovery",
    sha256: "contract-recovery-sha",
    schemaVersion: "paperclip.completion-contract.v1",
    contract: {
      revision: "1",
      objective: "Recover native work",
      criteria: [{ id: "objective", requirement: "Complete after recovery" }],
    },
  },
  interactionResponses: [],
  credentialBindings: [],
};

function controlEvent(
  sourceSeq: number,
  eventType: PrpEvent["eventType"],
  payload: Record<string, unknown>,
): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `control-recovery:${identity.runId}:${sourceSeq}`,
    sourceSeq,
    sourceInstanceId: "control-recovery",
    sourceKind: "control_plane",
    runId: identity.runId,
    normalizedSessionId: identity.sessionId,
    turnId: "turn-recovery",
    eventType,
    schemaVersion: 1,
    priority: 0,
    emittedAt: "2026-08-09T00:00:00.000Z",
    payload,
  };
}

function runnerEvent(
  sourceSeq: number,
  eventType: PrpEvent["eventType"],
  payload: Record<string, unknown> = {},
): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `runner-recovery:${identity.runId}:${sourceSeq}`,
    sourceSeq,
    sourceInstanceId: "runner-recovery",
    sourceKind: "runner",
    runId: identity.runId,
    normalizedSessionId: identity.sessionId,
    turnId: "turn-recovery",
    eventType,
    schemaVersion: 1,
    priority: 0,
    emittedAt: "2026-08-09T00:00:00.000Z",
    payload,
  };
}

function highestContiguous(events: PrpEvent[]): number {
  const sequences = new Set(events.map((event) => event.sourceSeq));
  let cursor = 0;
  while (sequences.has(cursor + 1)) cursor += 1;
  return cursor;
}

describe("executeNativeSession recovery", () => {
  it("keeps governed-wait discovery synchronous", () => {
    type GovernedWaitResolver = NonNullable<ExecuteNativeSessionOptions["resolveGovernedWait"]>;
    const resolver: GovernedWaitResolver = () => null;
    // An async resolver could retain control-plane mutation authority after
    // execution settles, so the public boundary rejects it at compile time.
    // @ts-expect-error governed-wait discovery must not return a promise
    const asynchronousResolver: GovernedWaitResolver = async () => null;

    expect(resolver).toBeTypeOf("function");
    void asynchronousResolver;
  });

  it("preserves durable success while quarantined cleanup stays bounded", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn().mockRejectedValue(new Error("persistent close failure"));
      const session: NativeSession = {
        identity: () => identity,
        async capabilities() {
          return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
        },
        async *events() {
          yield runnerEvent(1, "turn.completed");
        },
        async startTurn() { return { turnId: "turn-recovery" }; },
        async result() { return { result, terminal, turnId: "turn-recovery" }; },
        async snapshot() {
          return {
            backendKind: "mock",
            sessionId: "driver-recovery",
            identity,
            providerSessionId: "provider-recovery",
            cursor: null,
            activeTurnId: null,
            pendingRuntimeRequests: [],
            lineage: [],
          };
        },
        close,
      };
      const openSession = vi.fn(async () => session);
      const backend: NativeSessionBackend = {
        async descriptor() {
          return {
            kind: "mock",
            name: "recovery-backend",
            version: "1",
            capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
          };
        },
        openSession,
      };
      const port: ControlPlanePort = {
        async openRun() {},
        async checkpointSession() {},
        async appendEvent() {
          return { cursor: 1, highestContiguousSourceSeq: 1, disposition: "committed" };
        },
        async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
        async completeRun() {},
      };
      const execute = () => executeNativeSession({
        input,
        backend,
        controlPlane: port,
        runnerInstanceId: "runner-recovery",
        controlPlaneInstanceId: "control-recovery",
      });

      await expect(execute()).resolves.toMatchObject({ result });
      expect(close).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(close).toHaveBeenCalledTimes(7);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(close).toHaveBeenCalledTimes(7);

      close.mockImplementation(({ reason }: { reason: string }) =>
        reason === "native session scheduled quarantined cleanup recovery"
          ? new Promise<void>((resolve) => setTimeout(resolve, 250))
          : Promise.resolve()
      );
      // Enter the scheduled recovery's delay, then admit while recovery exists
      // but before it has assigned cleanup.attempt. Admission must observe the
      // active owner and continue once its imminent close succeeds.
      await vi.advanceTimersByTimeAsync(50_000);
      const recoveredExecution = execute();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(close).toHaveBeenCalledTimes(8);
      expect(close.mock.calls[7]?.[0]).toEqual({
        reason: "native session scheduled quarantined cleanup recovery",
      });
      // The retry delay consumed the first second. A separate close budget
      // keeps admission pending through a slightly slower successful close.
      await vi.advanceTimersByTimeAsync(250);
      await expect(recoveredExecution).resolves.toMatchObject({ result });
      expect(close).toHaveBeenCalledTimes(9);
      expect(openSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed before launch when a v3 driver does not declare complete native context realization", async () => {
    const digest = "0".repeat(64);
    const context = {
      prompt: {
        revision: PAPERCLIP_EXECUTION_PROMPT_REVISION,
        text: PAPERCLIP_EXECUTION_PROMPT,
        digest: nativeRuntimePromptDigest(),
      },
      instructions: {
        entryPath: "AGENTS.md",
        bundle: {
          schema: NATIVE_RUNTIME_ASSET_SCHEMA,
          digest,
          manifestDigest: digest,
          rootPath: "/paperclip/context/instructions",
          fileCount: 1,
          totalBytes: 1,
        },
      },
      skills: [],
      mcp: { assignmentSetId: "none", digest, bindingId: null },
    } as const;
    const openSession = vi.fn();
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "future-provider",
          name: "future-provider",
          version: "1",
          capabilities: {
            resume: false,
            typedEvents: true,
            steering: false,
            interruption: false,
            structuredResult: true,
          },
        };
      },
      openSession,
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent() { throw new Error("unexpected event"); },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input: {
        ...input,
        schema: "paperclip.native-execution-input.v3",
        executionMode: "default",
        planningContext: null,
        runtimeContext: {
          ...context,
          aggregateDigest: canonicalNativeRuntimeContextDigest(context),
        },
      },
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
    })).rejects.toThrow("does not natively realize instructions, skills, mcp");
    expect(openSession).not.toHaveBeenCalled();
  });

  it("contains a consumer rejection when starting the turn fails first", async () => {
    let markAppendStarted = () => {};
    const appendStarted = new Promise<void>((resolve) => { markAppendStarted = resolve; });
    let releaseAppend = () => {};
    const appendReleased = new Promise<void>((resolve) => { releaseAppend = resolve; });
    let appendCommitted = false;
    const close = vi.fn(async () => undefined);
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() { yield runnerEvent(1, "turn.started"); },
      async startTurn() {
        await appendStarted;
        throw new Error("start turn failed");
      },
      async result() { return null; },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: "driver-recovery",
          identity,
          providerSessionId: "provider-recovery",
          cursor: null,
          activeTurnId: null,
          pendingRuntimeRequests: [],
          lineage: [],
        };
      },
      close,
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { return session; },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent(_event, options) {
        markAppendStarted();
        await Promise.race([
          appendReleased,
          new Promise<never>((_resolve, reject) => {
            const rejectAbort = () => reject(options?.signal.reason ?? new Error("append aborted"));
            if (options?.signal.aborted) rejectAbort();
            else options?.signal.addEventListener("abort", rejectAbort, { once: true });
          }),
        ]);
        appendCommitted = true;
        return {
          cursor: 1,
          highestContiguousSourceSeq: 1,
          disposition: "committed" as const,
        };
      },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      async completeRun() {},
    };

    const execution = executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
    });
    await appendStarted;
    await expect(execution).rejects.toThrow("start turn failed");
    expect(close).toHaveBeenCalled();
    expect(appendCommitted).toBe(false);
    releaseAppend();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(appendCommitted).toBe(false);
  });

  it("stops and closes a timed-out consumer even when the caller requested a warm session", async () => {
    let markAppendStarted = () => {};
    const appendStarted = new Promise<void>((resolve) => { markAppendStarted = resolve; });
    let releaseAppend = () => {};
    const appendReleased = new Promise<void>((resolve) => { releaseAppend = resolve; });
    let releaseTeardown = () => {};
    const teardownReleased = new Promise<void>((resolve) => { releaseTeardown = resolve; });
    const iteratorTeardown = vi.fn();
    let appendCommitted = false;
    const appendEvent = vi.fn(async (
      _event: PrpEvent,
      options?: { signal: AbortSignal },
    ) => {
      markAppendStarted();
      await Promise.race([
        appendReleased,
        new Promise<never>((_resolve, reject) => {
          const rejectAbort = () => reject(options?.signal.reason ?? new Error("append aborted"));
          if (options?.signal.aborted) rejectAbort();
          else options?.signal.addEventListener("abort", rejectAbort, { once: true });
        }),
      ]);
      appendCommitted = true;
      return {
        cursor: 1,
        highestContiguousSourceSeq: 1,
        disposition: "committed" as const,
      };
    });
    const cancel = vi.fn(() => {
      releaseTeardown();
      return { cleanup: Promise.resolve() };
    });
    const close = vi.fn(async () => { releaseTeardown(); });
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() {
        try {
          yield runnerEvent(1, "turn.completed");
        } finally {
          iteratorTeardown();
          await teardownReleased;
        }
      },
      async startTurn() { return { turnId: "turn-recovery" }; },
      cancel,
      async result() { return null; },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: "driver-recovery",
          identity,
          providerSessionId: "provider-recovery",
          cursor: null,
          activeTurnId: null,
          pendingRuntimeRequests: [],
          lineage: [],
        };
      },
      close,
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { return session; },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      appendEvent,
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      async completeRun() {},
    };

    const execution = executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      timeoutMs: 1,
      keepSessionOpen: true,
    });
    const rejection = expect(execution).rejects.toThrow("native session timed out");
    await appendStarted;
    await vi.waitFor(() => expect(iteratorTeardown).toHaveBeenCalledOnce());
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalled();
    expect(appendEvent).toHaveBeenCalledOnce();
    expect(appendCommitted).toBe(false);
    releaseAppend();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(appendCommitted).toBe(false);
  });

  it("closes a failed session while retaining an uncancellable event read", async () => {
    let releaseStream = () => {};
    const streamReleased = new Promise<void>((resolve) => { releaseStream = resolve; });
    const close = vi.fn(async () => { releaseStream(); });
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: false, structuredResult: true };
      },
      async *events() {
        await streamReleased;
        yield runnerEvent(1, "turn.completed");
      },
      async startTurn() { return { turnId: "turn-recovery" }; },
      async result() { return null; },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: "driver-recovery",
          identity,
          providerSessionId: "provider-recovery",
          cursor: null,
          activeTurnId: null,
          pendingRuntimeRequests: [],
          lineage: [],
        };
      },
      close,
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: false, structuredResult: true },
        };
      },
      async openSession() { return session; },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent() { throw new Error("unexpected event"); },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      timeoutMs: 1,
      keepSessionOpen: true,
    })).rejects.toThrow("native session timed out");
    expect(close).toHaveBeenCalledOnce();
  });

  it("commits cancellation before bounding failed provider cleanup", async () => {
    let releaseStream = () => {};
    const streamReleased = new Promise<void>((resolve) => { releaseStream = resolve; });
    let releaseCancellation = () => {};
    const cancellationReleased = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    const interrupt = vi.fn(() => cancellationReleased);
    let cancellationCommitted = false;
    const cancel = vi.fn(() => {
      cancellationCommitted = true;
      return { cleanup: cancellationReleased };
    });
    const close = vi.fn(async () => { releaseStream(); });
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() {
        await streamReleased;
        yield runnerEvent(1, "turn.completed");
      },
      async startTurn() { return { turnId: "turn-recovery" }; },
      interrupt,
      cancel,
      async result() { return null; },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: "driver-recovery",
          identity,
          providerSessionId: "provider-recovery",
          cursor: null,
          activeTurnId: null,
          pendingRuntimeRequests: [],
          lineage: [],
        };
      },
      close,
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { return session; },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent() { throw new Error("unexpected event"); },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      async completeRun() {},
    };

    const execution = executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      timeoutMs: 1,
      keepSessionOpen: true,
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(interrupt).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    await expect(execution).rejects.toThrow("native session timed out");
    expect(cancellationCommitted).toBe(true);
    releaseCancellation();
  });

  it("bounds failure when iterator teardown and provider close never settle", async () => {
    const never = new Promise<void>(() => undefined);
    const close = vi.fn(() => never);
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: false, structuredResult: true };
      },
      async *events() {
        await never;
        yield runnerEvent(1, "turn.completed");
      },
      async startTurn() { return { turnId: "turn-recovery" }; },
      async result() { return null; },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: "driver-recovery",
          identity,
          providerSessionId: "provider-recovery",
          cursor: null,
          activeTurnId: null,
          pendingRuntimeRequests: [],
          lineage: [],
        };
      },
      close,
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: false, structuredResult: true },
        };
      },
      async openSession() { return session; },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent() { throw new Error("unexpected event"); },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      timeoutMs: 1,
      keepSessionOpen: true,
    })).rejects.toThrow("native session timed out");
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves durable success when provider close never settles", async () => {
    const never = new Promise<void>(() => undefined);
    const close = vi.fn(() => never);
    const completeRun = vi.fn(async () => undefined);
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: false, structuredResult: true };
      },
      async *events() { yield runnerEvent(1, "turn.completed"); },
      async startTurn() { return { turnId: "turn-recovery" }; },
      async result() { return { result, terminal, turnId: "turn-recovery" }; },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: "driver-recovery",
          identity,
          providerSessionId: "provider-recovery",
          cursor: "1",
          activeTurnId: null,
          pendingRuntimeRequests: [],
          lineage: [],
        };
      },
      close,
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: false, structuredResult: true },
        };
      },
      async openSession() { return session; },
    };
    const events: PrpEvent[] = [];
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent(event) {
        events.push(structuredClone(event as PrpEvent));
        return {
          cursor: events.length,
          highestContiguousSourceSeq: highestContiguous(events),
          disposition: "committed",
        };
      },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      completeRun,
    };

    await expect(executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
    })).resolves.toMatchObject({ result, terminal });
    expect(completeRun).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes after a synchronous governed-wait probe returns no result", async () => {
    const resolveGovernedWait = vi.fn(() => null);
    const lifecycle: string[] = [];
    const close = vi.fn(async () => { lifecycle.push("closed"); });
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() {
        yield runnerEvent(1, "item.completed");
      },
      async startTurn() { return { turnId: "turn-recovery" }; },
      async result() { return null; },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: "driver-recovery",
          identity,
          providerSessionId: "provider-recovery",
          cursor: null,
          activeTurnId: "turn-recovery",
          pendingRuntimeRequests: [],
          lineage: [],
        };
      },
      close,
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { return session; },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent() {
        return { cursor: 1, highestContiguousSourceSeq: 1, disposition: "committed" };
      },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      async completeRun() {},
    };

    const execution = executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      timeoutMs: 5,
      resolveGovernedWait,
    });
    await expect(execution).rejects.toThrow("before a turn terminal fact");
    expect(resolveGovernedWait).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalled();
    expect(lifecycle).toEqual(["closed"]);
  });

  it("commits a governed wait without waiting for abort-insensitive provider cleanup", async () => {
    const lifecycle: string[] = [];
    let cancellationSignal: AbortSignal | undefined;
    const cancel = vi.fn(({ signal }: { signal: AbortSignal }) => {
      cancellationSignal = signal;
      lifecycle.push("cancelled");
      return { cleanup: new Promise<void>(() => undefined) };
    });
    const close = vi.fn(async () => { lifecycle.push("closed"); });
    const events: PrpEvent[] = [];
    const retainedSessions: Array<NativeSession | null> = [];
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() {
        yield runnerEvent(1, "item.completed");
      },
      async startTurn() { return { turnId: "turn-recovery" }; },
      cancel,
      async result() { return null; },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: "driver-recovery",
          identity,
          providerSessionId: "provider-recovery",
          cursor: null,
          activeTurnId: "turn-recovery",
          pendingRuntimeRequests: [],
          lineage: [],
        };
      },
      close,
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { return session; },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent(event) {
        events.push(structuredClone(event as PrpEvent));
        return {
          cursor: events.length,
          highestContiguousSourceSeq: event.sourceSeq,
          disposition: "committed",
        };
      },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      async completeRun() {},
    };

    const execution = executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      timeoutMs: 5,
      resolveGovernedWait: () => yieldedResult,
      keepSessionOpen: true,
      onSession: (current) => retainedSessions.push(current),
    });
    await expect(execution).resolves.toMatchObject({ result: yieldedResult });
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancellationSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(lifecycle).toEqual(["cancelled", "closed"]);
    expect(retainedSessions.at(-1)).toBeNull();
    expect(events.map((event) => event.eventType)).toEqual([
      "item.completed",
      "run.result.accepted",
      "run.terminal",
    ]);
  });

  it("rejects a mismatched checkpoint before it mutates control-plane state", async () => {
    const openRun = vi.fn(async () => undefined);
    const checkpointSession = vi.fn(async () => undefined);
    const openSession = vi.fn();
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      openSession,
    };
    const port: ControlPlanePort = {
      openRun,
      async loadSessionCheckpoint() {
        return {
          backendKind: "mock",
          sessionId: "driver-recovery",
          identity: { ...identity, companyId: "other-company" },
        };
      },
      checkpointSession,
      async appendEvent() { throw new Error("unexpected event"); },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
    })).rejects.toThrow("native_session_checkpoint_binding_mismatch");
    expect(openRun).not.toHaveBeenCalled();
    expect(checkpointSession).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
  });

  it("rejects a mismatched existing session before opening control-plane state", async () => {
    const openRun = vi.fn(async () => undefined);
    const attachRun = vi.fn(async () => undefined);
    const existingSession: NativeSession = {
      identity: () => ({ ...identity, companyId: "other-company" }),
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      attachRun,
      async *events() {},
      async startTurn() { return { turnId: "unexpected" }; },
      async result() { return null; },
      async snapshot() { throw new Error("unexpected snapshot"); },
      async close() {},
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "existing-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { throw new Error("unexpected open"); },
    };
    const port: ControlPlanePort = {
      openRun,
      async appendEvent() { throw new Error("unexpected event"); },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      existingSession,
    })).rejects.toThrow("native_session_attach_binding_mismatch");
    expect(openRun).not.toHaveBeenCalled();
    expect(attachRun).not.toHaveBeenCalled();
  });

  it("quarantines a retained session when attachment partially mutates then fails", async () => {
    const attachmentFailure = new Error("provider attachment failed");
    const openRun = vi.fn(async () => undefined);
    let retainedIdentity = { ...identity, runId: "run-previous" };
    const attachRun = vi.fn(async (input: { identity: NativeRunIdentity }) => {
      retainedIdentity = structuredClone(input.identity);
      throw attachmentFailure;
    });
    const close = vi.fn(() => new Promise<void>(() => {}));
    const startTurn = vi.fn(async () => ({ turnId: "unexpected" }));
    const onSession = vi.fn();
    const existingSession: NativeSession = {
      identity: () => structuredClone(retainedIdentity),
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      attachRun,
      async *events() {},
      startTurn,
      async result() { return null; },
      async snapshot() { throw new Error("unexpected snapshot"); },
      close,
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "existing-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { throw new Error("unexpected open"); },
    };
    const port: ControlPlanePort = {
      openRun,
      async appendEvent() { throw new Error("unexpected event"); },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      existingSession,
      onSession,
    })).rejects.toBe(attachmentFailure);
    expect(attachRun).toHaveBeenCalledWith({ identity });
    expect(retainedIdentity).toEqual(identity);
    expect(onSession).toHaveBeenCalledOnce();
    expect(onSession).toHaveBeenCalledWith(null);
    expect(close).toHaveBeenCalledWith({
      reason: "native session attachment failed",
    });
    expect(openRun).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("quarantines an attached session when control-plane run admission fails", async () => {
    const admissionFailure = new Error("control-plane admission failed");
    const openRun = vi.fn(async () => {
      throw admissionFailure;
    });
    const attachRun = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const startTurn = vi.fn(async () => ({ turnId: "unexpected" }));
    const onSession = vi.fn();
    const existingSession: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      attachRun,
      async *events() {},
      startTurn,
      async result() { return null; },
      async snapshot() { throw new Error("unexpected snapshot"); },
      close,
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "existing-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { throw new Error("unexpected open"); },
    };
    const port: ControlPlanePort = {
      openRun,
      async appendEvent() { throw new Error("unexpected event"); },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      existingSession,
      onSession,
    })).rejects.toBe(admissionFailure);
    expect(attachRun).toHaveBeenCalledWith({ identity });
    expect(openRun).toHaveBeenCalledOnce();
    expect(onSession).toHaveBeenCalledOnce();
    expect(onSession).toHaveBeenCalledWith(null);
    expect(close).toHaveBeenCalledWith({
      reason: "native control-plane run admission failed",
    });
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("rejects checkpoint adoption when the requested session id is absent", async () => {
    const openRun = vi.fn(async () => undefined);
    const openSession = vi.fn();
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      openSession,
    };
    const port: ControlPlanePort = {
      openRun,
      async loadSessionCheckpoint() {
        return {
          backendKind: "mock",
          sessionId: "driver-other-session",
          identity: { ...identity, sessionId: "other-session" },
        };
      },
      async appendEvent() { throw new Error("unexpected event"); },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input: {
        ...input,
        session: { ...input.session, normalizedSessionId: null },
      },
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
    })).rejects.toThrow("native_session_checkpoint_binding_mismatch");
    expect(openRun).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
  });

  it("proves required provider recovery before re-opening the durable run", async () => {
    const checkpoint: PersistedNativeSession = {
      backendKind: "mock",
      sessionId: "driver-unrecoverable",
      identity,
      providerSessionId: "provider-unrecoverable",
      providerRecoveryPolicy: "same_session_only",
      cursor: "0",
      activeTurnId: "turn-unrecoverable",
      pendingRuntimeRequests: [],
      lineage: [],
    };
    const openRun = vi.fn(async () => undefined);
    const completeRun = vi.fn(async () => undefined);
    const recoverSession = vi.fn(async () => ({
      recovered: false as const,
      reason: "provider session no longer exists",
    }));
    const openSession = vi.fn(async () => { throw new Error("replacement is forbidden"); });
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      openSession,
      recoverSession,
    };
    const port: ControlPlanePort = {
      openRun,
      async loadSessionCheckpoint() { return structuredClone(checkpoint); },
      async checkpointSession() {},
      async appendEvent() { throw new Error("unexpected event"); },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      completeRun,
    };

    await expect(executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
    })).rejects.toThrow(
      "native_session_recovery_failed: provider session no longer exists",
    );

    expect(recoverSession).toHaveBeenCalledOnce();
    expect(openRun).not.toHaveBeenCalled();
    expect(completeRun).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
  });

  it("continues a provider-reported active turn without starting a duplicate turn", async () => {
    const checkpoint: PersistedNativeSession = {
      backendKind: "mock",
      sessionId: "driver-recovery",
      identity,
      providerSessionId: "provider-recovery",
      cursor: "0",
      activeTurnId: null,
      pendingRuntimeRequests: [],
      lineage: [],
    };
    const providerSnapshot: PersistedNativeSession = {
      ...checkpoint,
      cursor: "1",
      activeTurnId: "turn-recovery",
    };
    const terminalEvent: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: "provider-recovery:1",
      sourceSeq: 1,
      sourceInstanceId: "provider-recovery",
      sourceKind: "provider",
      runId: identity.runId,
      normalizedSessionId: identity.sessionId,
      turnId: "turn-recovery",
      eventType: "turn.completed",
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-08-09T00:00:00.000Z",
      payload: {},
    };
    const bySource = new Map<string, PrpEvent[]>();
    const startTurn = vi.fn(async () => ({ turnId: "duplicate-turn" }));
    const openSession = vi.fn(async () => { throw new Error("must recover the provider session"); });
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() { yield terminalEvent; },
      startTurn,
      async result() { return { result, terminal, turnId: "turn-recovery" }; },
      async snapshot() { return structuredClone(providerSnapshot); },
      async close() {},
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      openSession,
      async recoverSession() { return { recovered: true, session }; },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async loadSessionCheckpoint() { return structuredClone(checkpoint); },
      async checkpointSession() {},
      async appendEvent(event) {
        const list = bySource.get(event.sourceInstanceId) ?? [];
        list.push(structuredClone(event));
        bySource.set(event.sourceInstanceId, list);
        return {
          cursor: list.length,
          highestContiguousSourceSeq: highestContiguous(list),
          disposition: "committed",
        };
      },
      async replayEvents(replay) {
        const list = bySource.get(replay.sourceInstanceId) ?? [];
        return {
          events: structuredClone(list.filter((event) => event.sourceSeq > replay.afterSourceSeq)),
          highestContiguousSourceSeq: highestContiguous(list),
        };
      },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
    })).resolves.toMatchObject({ turnId: "turn-recovery", providerSessionId: "provider-recovery" });
    expect(openSession).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
  });

  it.each([
    { checkpointCursor: "12", expectedCursor: "41", terminalSequence: 42 },
    { checkpointCursor: "50", expectedCursor: "50", terminalSequence: 51 },
  ])(
    "seeds recovery from the larger of checkpoint $checkpointCursor and the persisted source high-water mark",
    async ({ checkpointCursor, expectedCursor, terminalSequence }) => {
      const checkpoint: PersistedNativeSession = {
        backendKind: "mock",
        sessionId: "driver-recovery",
        identity,
        providerSessionId: "provider-recovery",
        cursor: checkpointCursor,
        activeTurnId: null,
        pendingRuntimeRequests: [],
        lineage: [],
      };
      const runnerEvents = [
        runnerEvent(13, "item.completed", { kind: "progress" }),
        runnerEvent(41, "item.completed", { kind: "progress" }),
      ];
      const terminalEvent = runnerEvent(terminalSequence, "turn.completed");
      const controlEvents: PrpEvent[] = [];
      const checkpoints: PersistedNativeSession[] = [];
      const session: NativeSession = {
        identity: () => identity,
        async capabilities() {
          return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
        },
        async *events() { yield terminalEvent; },
        async startTurn() { return { turnId: "turn-recovery" }; },
        async result() { return { result, terminal, turnId: "turn-recovery" }; },
        async snapshot() {
          return { ...checkpoint, cursor: String(terminalSequence), activeTurnId: null };
        },
        async close() {},
      };
      const recoverSession = vi.fn(async (recoveryCheckpoint: PersistedNativeSession) => {
        expect(recoveryCheckpoint.cursor).toBe(expectedCursor);
        return { recovered: true, session };
      });
      const backend: NativeSessionBackend = {
        async descriptor() {
          return {
            kind: "mock",
            name: "recovery-backend",
            version: "1",
            capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
          };
        },
        async openSession() { throw new Error("must recover the provider session"); },
        recoverSession,
      };
      const port: ControlPlanePort = {
        async openRun() {},
        async loadSessionCheckpoint() { return structuredClone(checkpoint); },
        async checkpointSession(snapshot) { checkpoints.push(structuredClone(snapshot)); },
        async appendEvent(event) {
          const target = event.sourceInstanceId === "runner-recovery" ? runnerEvents : controlEvents;
          if (target.some((existing) => existing.sourceSeq === event.sourceSeq)) {
            throw new Error(`native_event_replay_conflict:${event.sourceSeq}`);
          }
          target.push(structuredClone(event));
          return {
            cursor: target.length,
            highestContiguousSourceSeq: highestContiguous(target),
            disposition: "committed",
          };
        },
        async replayEvents(replay) {
          const source = replay.sourceInstanceId === "runner-recovery" ? runnerEvents : controlEvents;
          const events = source
            .filter((event) => event.sourceSeq > replay.afterSourceSeq)
            .sort((left, right) => left.sourceSeq - right.sourceSeq)
            .slice(0, replay.limit);
          return { events: structuredClone(events), highestContiguousSourceSeq: highestContiguous(source) };
        },
        async completeRun() {},
      };

      await expect(executeNativeSession({
        input,
        backend,
        controlPlane: port,
        runnerInstanceId: "runner-recovery",
        controlPlaneInstanceId: "control-recovery",
      })).resolves.toMatchObject({ turnId: "turn-recovery" });

      expect(recoverSession).toHaveBeenCalledOnce();
      expect(runnerEvents.some((event) => event.sourceSeq === terminalSequence)).toBe(true);
      if (checkpointCursor === "12") {
        expect(checkpoints[0]).toMatchObject({ cursor: "41" });
      }
    },
  );

  it("attempts exact recovery before opening an observable replacement session", async () => {
    const checkpoint: PersistedNativeSession = {
      backendKind: "mock",
      sessionId: "driver-old",
      identity,
      providerSessionId: "provider-old",
      providerRecoveryPolicy: "allow_replacement_after_resume_failure",
      cursor: null,
      activeTurnId: null,
      pendingRuntimeRequests: [],
      lineage: [],
    };
    const replacementSnapshot: PersistedNativeSession = {
      ...checkpoint,
      sessionId: "driver-new",
      providerSessionId: "provider-new",
      providerRecoveryPolicy: "same_session_only",
    };
    const replacementSession: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() { yield runnerEvent(1, "turn.completed"); },
      async startTurn() { return { turnId: "turn-replacement" }; },
      async result() { return { result, terminal, turnId: "turn-replacement" }; },
      async snapshot() { return structuredClone(replacementSnapshot); },
      async close() {},
    };
    const recoverSession = vi.fn(async () => ({
      recovered: false as const,
      reason: "provider reported the prior session missing",
    }));
    const openReplacementSession = vi.fn(async () => replacementSession);
    const onContinuityBreak = vi.fn(async () => undefined);
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "replacement-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { throw new Error("replacement seam must be used"); },
      recoverSession,
      openReplacementSession,
    };
    const events: PrpEvent[] = [];
    const port: ControlPlanePort = {
      async openRun() {},
      async loadSessionCheckpoint() { return structuredClone(checkpoint); },
      async checkpointSession() {},
      async appendEvent(event) {
        events.push(structuredClone(event));
        return { cursor: events.length, highestContiguousSourceSeq: highestContiguous(events), disposition: "committed" };
      },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-replacement",
      controlPlaneInstanceId: "control-replacement",
      onContinuityBreak,
    })).resolves.toMatchObject({ providerSessionId: "provider-new" });

    expect(recoverSession).toHaveBeenCalledOnce();
    expect(openReplacementSession).toHaveBeenCalledOnce();
    expect(onContinuityBreak).toHaveBeenCalledWith({
      reason: "provider reported the prior session missing",
      previousDriverSessionId: "driver-old",
      previousProviderSessionId: "provider-old",
      replacementDriverSessionId: "driver-new",
      replacementProviderSessionId: "provider-new",
    });
  });

  it("retries disposition recovery when its bound provider turn is absent", async () => {
    const checkpoint: PersistedNativeSession = {
      backendKind: "mock",
      sessionId: "driver-recovery",
      identity,
      providerSessionId: "provider-recovery",
      cursor: "1",
      activeTurnId: "turn-already-terminal",
      terminalTurns: [{ turnId: "turn-already-terminal", fingerprint: "terminal-fingerprint" }],
      dispositionOnlyRecoveryConsumed: true,
      dispositionOnlyRecoveryTurnId: "turn-missing-disposition",
      pendingRuntimeRequests: [],
      lineage: [],
    };
    const recoveredSnapshot: PersistedNativeSession = {
      ...checkpoint,
      activeTurnId: null,
    };
    const terminalEvent: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: "provider-recovery:2",
      sourceSeq: 2,
      sourceInstanceId: "provider-recovery",
      sourceKind: "provider",
      runId: identity.runId,
      normalizedSessionId: identity.sessionId,
      turnId: "turn-continuation",
      eventType: "turn.completed",
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-08-09T00:00:01.000Z",
      payload: {},
    };
    const startTurn = vi.fn(async () => ({ turnId: "turn-continuation" }));
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() { yield terminalEvent; },
      startTurn,
      async result() { return { result, terminal, turnId: "turn-continuation" }; },
      async snapshot() { return structuredClone(recoveredSnapshot); },
      async close() {},
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { throw new Error("must recover the provider session"); },
      async recoverSession() { return { recovered: true, session }; },
    };
    const bySource = new Map<string, PrpEvent[]>();
    const port: ControlPlanePort = {
      async openRun() {},
      async loadSessionCheckpoint() { return structuredClone(checkpoint); },
      async checkpointSession() {},
      async appendEvent(event) {
        const list = bySource.get(event.sourceInstanceId) ?? [];
        list.push(structuredClone(event));
        bySource.set(event.sourceInstanceId, list);
        return {
          cursor: list.length,
          highestContiguousSourceSeq: highestContiguous(list),
          disposition: "committed",
        };
      },
      async replayEvents(replay) {
        const list = bySource.get(replay.sourceInstanceId) ?? [];
        return {
          events: structuredClone(list.filter((event) => event.sourceSeq > replay.afterSourceSeq)),
          highestContiguousSourceSeq: highestContiguous(list),
        };
      },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
    })).resolves.toMatchObject({ turnId: "turn-continuation", providerSessionId: "provider-recovery" });
    expect(startTurn).toHaveBeenCalledOnce();
    const recoveryEnvelope = JSON.parse(
      startTurn.mock.calls[0]![0].message.text,
    ) as { task: { prompt: string } };
    expect(recoveryEnvelope.task.prompt).toContain(
      "semantic-result recovery for a prior completed provider turn",
    );
    expect(recoveryEnvelope.task.prompt).toContain(
      "Do not repeat implementation, tests, research, or the final answer",
    );
  });

  it("consumes an adopted completed disposition turn without starting another turn", async () => {
    const checkpoint: PersistedNativeSession = {
      backendKind: "mock",
      sessionId: "driver-recovery",
      identity,
      providerSessionId: "provider-recovery",
      cursor: "1",
      activeTurnId: null,
      terminalTurns: [{ turnId: "turn-work", fingerprint: "work-terminal" }],
      dispositionOnlyRecoveryConsumed: false,
      pendingRuntimeRequests: [],
      lineage: [],
    };
    const recoveredSnapshot: PersistedNativeSession = {
      ...checkpoint,
      cursor: "2",
      terminalTurns: [
        ...checkpoint.terminalTurns!,
        { turnId: "turn-disposition", fingerprint: "disposition-terminal" },
      ],
      dispositionOnlyRecoveryConsumed: true,
    };
    const terminalEvent: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: "provider-recovery:2",
      sourceSeq: 2,
      sourceInstanceId: "provider-recovery",
      sourceKind: "provider",
      runId: identity.runId,
      normalizedSessionId: identity.sessionId,
      turnId: "turn-disposition",
      eventType: "turn.completed",
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-08-09T00:00:01.000Z",
      payload: {},
    };
    const startTurn = vi.fn(async () => ({ turnId: "unexpected-turn" }));
    let dispositionTerminalCommitted = false;
    let prematureDispositionCheckpoint = false;
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() { yield terminalEvent; },
      startTurn,
      async result() { return null; },
      async snapshot() { return structuredClone(recoveredSnapshot); },
      async close() {},
    };
    const events: PrpEvent[] = [];
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { throw new Error("must recover the provider session"); },
      async recoverSession() { return { recovered: true, session }; },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async loadSessionCheckpoint() { return structuredClone(checkpoint); },
      async checkpointSession(snapshot) {
        if (
          snapshot.terminalTurns?.some((turn) => turn.turnId === "turn-disposition")
          && !dispositionTerminalCommitted
        ) prematureDispositionCheckpoint = true;
      },
      async appendEvent(event) {
        events.push(structuredClone(event));
        if (event.eventType === "turn.completed" && event.turnId === "turn-disposition") {
          dispositionTerminalCommitted = true;
        }
        return {
          cursor: events.length,
          highestContiguousSourceSeq: highestContiguous(events),
          disposition: "committed",
        };
      },
      async replayEvents(replay) {
        return {
          events: structuredClone(events.filter((event) =>
            event.sourceInstanceId === replay.sourceInstanceId
            && event.sourceSeq > replay.afterSourceSeq
          )),
          highestContiguousSourceSeq: highestContiguous(events),
        };
      },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      resolveMissingResult: async () => result,
    })).resolves.toMatchObject({
      result,
      turnId: "turn-disposition",
    });
    expect(startTurn).not.toHaveBeenCalled();
    expect(prematureDispositionCheckpoint).toBe(false);
    expect(events.map((event) => event.eventType)).toEqual([
      "turn.completed",
      "run.result.accepted",
      "run.terminal",
    ]);
  });

  it("resolves a proposal-less durable disposition terminal through control-plane policy", async () => {
    const checkpoint: PersistedNativeSession = {
      backendKind: "mock",
      sessionId: "driver-recovery",
      identity,
      providerSessionId: "provider-recovery",
      cursor: "1",
      activeTurnId: null,
      terminalTurns: [{ turnId: "turn-work", fingerprint: "work-terminal" }],
      dispositionOnlyRecoveryConsumed: true,
      pendingRuntimeRequests: [],
      lineage: [],
    };
    const terminalEvent: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: "runner-recovery:run-native:4",
      sourceSeq: 4,
      sourceInstanceId: "runner-recovery",
      sourceKind: "provider",
      runId: identity.runId,
      normalizedSessionId: identity.sessionId,
      turnId: "turn-disposition",
      eventType: "turn.completed",
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-08-09T00:00:01.000Z",
      payload: {},
    };
    const resultProposalEvent: PrpEvent = {
      ...terminalEvent,
      sourceEventId: "runner-recovery:run-native:3",
      sourceSeq: 3,
      eventType: "run.result.proposed",
      payload: result,
    };
    const originalTaskTerminal: PrpEvent = {
      ...terminalEvent,
      sourceEventId: "runner-recovery:run-native:2",
      sourceSeq: 2,
      turnId: "turn-work",
    };
    const originalTaskProposal: PrpEvent = {
      ...resultProposalEvent,
      sourceEventId: "runner-recovery:run-native:1",
      sourceSeq: 1,
      turnId: "turn-work",
    };
    const startTurn = vi.fn(async () => ({ turnId: "unexpected-turn" }));
    let recoveredSubmissionOwned = true;
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() { yield structuredClone(terminalEvent); },
      startTurn,
      async result() { return null; },
      async snapshot() {
        return {
          ...structuredClone(checkpoint),
          dispositionOnlyRecoveryConsumed: recoveredSubmissionOwned,
        };
      },
      async close() {},
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { throw new Error("must recover the provider session"); },
      async recoverSession() { return { recovered: true, session }; },
    };
    const bySource = new Map<string, PrpEvent[]>([
      ["runner-recovery", [
        structuredClone(originalTaskProposal),
        structuredClone(originalTaskTerminal),
      ]],
    ]);
    const port: ControlPlanePort = {
      async openRun() {},
      async loadSessionCheckpoint() { return structuredClone(checkpoint); },
      async checkpointSession() {},
      async appendEvent(event) {
        const list = bySource.get(event.sourceInstanceId) ?? [];
        list.push(structuredClone(event));
        bySource.set(event.sourceInstanceId, list);
        return {
          cursor: list.length,
          highestContiguousSourceSeq: highestContiguous(list),
          disposition: "committed",
        };
      },
      async replayEvents(replay) {
        const list = bySource.get(replay.sourceInstanceId) ?? [];
        return {
          events: structuredClone(list.filter((event) => event.sourceSeq > replay.afterSourceSeq)),
          highestContiguousSourceSeq: highestContiguous(list),
        };
      },
      async completeRun() {},
    };

    const execute = () => executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      resolveMissingResult: async ({ terminalEvent: replayed }) => {
        expect(replayed).toEqual(terminalEvent);
        return result;
      },
    });
    await expect(execute()).resolves.toMatchObject({
      result,
      turnId: "turn-disposition",
    });
    bySource.set("runner-recovery", [
      structuredClone(originalTaskProposal),
      structuredClone(originalTaskTerminal),
      structuredClone(resultProposalEvent),
      structuredClone(terminalEvent),
    ]);
    // Provider recovery may clear a legacy pre-acceptance marker when thread
    // history has no matching turn. Durable replay remains authoritative and
    // must still prevent a duplicate disposition submission.
    recoveredSubmissionOwned = false;

    await expect(execute()).resolves.toMatchObject({
      result,
      turnId: "turn-disposition",
    });
    expect(startTurn).not.toHaveBeenCalled();
    expect(bySource.get("runner-recovery")).toEqual([
      originalTaskProposal,
      originalTaskTerminal,
      resultProposalEvent,
      terminalEvent,
    ]);
    expect(bySource.get("control-recovery")?.map((event) => event.eventType)).toEqual([
      "run.result.accepted",
      "run.terminal",
    ]);

  });

  it("resolves a checkpointed result-less disposition without resubmitting when its terminal event is missing", async () => {
    const workProposal: PrpEvent = {
      ...runnerEvent(1, "run.result.proposed", result),
      turnId: "turn-work",
    };
    const workTerminal: PrpEvent = {
      ...runnerEvent(2, "turn.completed"),
      turnId: "turn-work",
    };
    const checkpoint: PersistedNativeSession = {
      backendKind: "mock",
      sessionId: "driver-recovery",
      identity,
      providerSessionId: "provider-recovery",
      cursor: "3",
      activeTurnId: null,
      terminalTurns: [
        { turnId: "turn-work", fingerprint: "work-terminal" },
        { turnId: "turn-disposition", fingerprint: "disposition-terminal" },
      ],
      dispositionOnlyRecoveryConsumed: true,
      dispositionOnlyRecoveryTurnId: "turn-disposition",
      pendingRuntimeRequests: [],
      lineage: [],
    };
    const recoveredCheckpoint: PersistedNativeSession = structuredClone(checkpoint);
    const startTurn = vi.fn(async () => ({ turnId: "unexpected-turn" }));
    const events = vi.fn(() => (async function* () {
      throw new Error("checkpoint fallback must not consume provider events");
    })());
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      events,
      startTurn,
      async result() { return null; },
      async snapshot() { return structuredClone(recoveredCheckpoint); },
      async close() {},
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { throw new Error("must recover the provider session"); },
      async recoverSession() { return { recovered: true, session }; },
    };
    const bySource = new Map<string, PrpEvent[]>([
      ["runner-recovery", [workProposal, workTerminal]],
    ]);
    const completeRun = vi.fn(async () => undefined);
    const port: ControlPlanePort = {
      async openRun() {},
      async loadSessionCheckpoint() { return structuredClone(checkpoint); },
      async checkpointSession() {},
      async appendEvent(event) {
        const list = bySource.get(event.sourceInstanceId) ?? [];
        list.push(structuredClone(event));
        bySource.set(event.sourceInstanceId, list);
        return {
          cursor: list.length,
          highestContiguousSourceSeq: highestContiguous(list),
          disposition: "committed",
        };
      },
      async replayEvents(replay) {
        const list = bySource.get(replay.sourceInstanceId) ?? [];
        return {
          events: structuredClone(list.filter((event) => event.sourceSeq > replay.afterSourceSeq)),
          highestContiguousSourceSeq: highestContiguous(list),
        };
      },
      completeRun,
    };

    const execute = () => executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      resolveMissingResult: async ({ turnId, terminalEvent }) => {
        expect(turnId).toBe("turn-disposition");
        expect(terminalEvent).toMatchObject({
          sourceInstanceId: "control-recovery",
          sourceKind: "control_plane",
          runId: identity.runId,
          normalizedSessionId: identity.sessionId,
          turnId: "turn-disposition",
          eventType: "turn.completed",
          payload: {
            recovery: "checkpointed_resultless_disposition",
            terminalFingerprint: "disposition-terminal",
          },
        });
        return result;
      },
    });
    await expect(execute()).resolves.toMatchObject({
      result,
      turnId: "turn-disposition",
    });
    expect(startTurn).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(completeRun).toHaveBeenCalledOnce();
    expect(bySource.get("runner-recovery")).toEqual([
      workProposal,
      workTerminal,
    ]);
    expect(bySource.get("control-recovery")?.map((event) => event.eventType)).toEqual([
      "run.result.accepted",
      "run.terminal",
    ]);

    recoveredCheckpoint.terminalTurns![1]!.fingerprint = "conflicting-terminal";
    await expect(execute()).rejects.toThrow(
      "native_disposition_recovery_checkpoint_conflict",
    );
    expect(startTurn).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(completeRun).toHaveBeenCalledOnce();
  });

  it("recovers a completed checkpoint and appends only a missing control terminal fact", async () => {
    const checkpoint: PersistedNativeSession = {
      backendKind: "mock",
      sessionId: "driver-recovery",
      identity,
      providerSessionId: "provider-recovery",
      cursor: "4",
      semanticResult: result,
      terminal,
      activeTurnId: "turn-recovery",
      terminalTurns: [{ turnId: "turn-recovery", fingerprint: "terminal-fingerprint" }],
      pendingRuntimeRequests: [],
      lineage: [],
    };
    const events = [controlEvent(1, "run.result.accepted", { result })];
    const checkpoints: PersistedNativeSession[] = [];
    const completeRun = vi.fn(async () => undefined);
    const startTurn = vi.fn(async () => ({ turnId: "unexpected-turn" }));
    const openSession = vi.fn(async () => {
      throw new Error("a recovered run must not open a second provider session");
    });
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() {},
      startTurn,
      async result() { return { result, terminal, turnId: "turn-recovery" }; },
      async snapshot() { return structuredClone(checkpoint); },
      async close() {},
    };
    const recoverSession = vi.fn(async () => ({ recovered: true, session }));
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      openSession,
      recoverSession,
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async loadSessionCheckpoint() { return structuredClone(checkpoint); },
      async checkpointSession(snapshot) { checkpoints.push(structuredClone(snapshot)); },
      async appendEvent(event) {
        events.push(structuredClone(event as PrpEvent));
        return {
          cursor: events.length,
          highestContiguousSourceSeq: highestContiguous(events),
          disposition: "committed",
        };
      },
      async replayEvents(replay) {
        const replayed = events.filter((event) => event.sourceSeq > replay.afterSourceSeq);
        return { events: structuredClone(replayed), highestContiguousSourceSeq: highestContiguous(events) };
      },
      completeRun,
    };

    const completed = await executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
    });

    expect(openSession).not.toHaveBeenCalled();
    expect(recoverSession).toHaveBeenCalledOnce();
    expect(startTurn).not.toHaveBeenCalled();
    expect(events.map((event) => event.eventType)).toEqual(["run.result.accepted", "run.terminal"]);
    expect(events.map((event) => event.sourceSeq)).toEqual([1, 2]);
    expect(completeRun).toHaveBeenCalledOnce();
    expect(completed).toMatchObject({ nativeEventCount: 1, highestContiguousSourceSeq: 2 });
    expect(checkpoints.at(-1)).toMatchObject({ semanticResult: result, terminal });
  });

  it("accepts a control-plane governed wait when a completed turn omitted its semantic result", async () => {
    const terminalEvent: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: "provider-recovery:1",
      sourceSeq: 1,
      sourceInstanceId: "provider-recovery",
      sourceKind: "provider",
      runId: identity.runId,
      normalizedSessionId: identity.sessionId,
      turnId: "turn-waiting",
      eventType: "turn.completed",
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-08-09T00:00:00.000Z",
      payload: {},
    };
    const yielded: PrpStructuredRunResult = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "yielded",
      summary: "Waiting for the requested response.",
      completionClaim: {
        contractRevision: "1",
        objectiveSatisfied: false,
        criteria: [{ criterionId: "objective", status: "unknown", evidenceRefs: ["interaction:pending"] }],
        remainingWork: [{ description: "Resume after the response.", blocksCompletion: true }],
      },
      evidence: [{ ref: "interaction:pending" }],
      verification: [],
      attentionRequests: [],
      artifacts: [],
      continuation: {
        kind: "response_wake",
        summary: "Resume from the answer.",
        idempotencyKey: "interaction-response:pending",
      },
    };
    const events: PrpEvent[] = [];
    const completeRun = vi.fn(async () => undefined);
    const resolveMissingResult = vi.fn(async () => yielded);
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() { yield terminalEvent; },
      async startTurn() { return { turnId: "turn-waiting" }; },
      async result() { return null; },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: identity.sessionId,
          identity,
          providerSessionId: "provider-waiting",
          cursor: "1",
          activeTurnId: "turn-waiting",
          pendingRuntimeRequests: [],
          lineage: [],
        };
      },
      async close() {},
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "governed-wait-backend",
          version: "1",
          capabilities: { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { return session; },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent(event) {
        events.push(structuredClone(event as PrpEvent));
        return {
          cursor: events.length,
          highestContiguousSourceSeq: highestContiguous(events),
          disposition: "committed",
        };
      },
      async replayEvents(replay) {
        const replayed = events.filter((event) =>
          event.sourceInstanceId === replay.sourceInstanceId && event.sourceSeq > replay.afterSourceSeq
        );
        return { events: structuredClone(replayed), highestContiguousSourceSeq: highestContiguous(replayed) };
      },
      completeRun,
    };

    const completed = await executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      resolveMissingResult,
    });

    expect(resolveMissingResult).toHaveBeenCalledWith({ turnId: "turn-waiting", terminalEvent });
    expect(completed).toMatchObject({
      result: yielded,
      terminal: { runTerminalState: "succeeded", reportedWorkDisposition: "yielded" },
      turnId: "turn-waiting",
    });
    expect(completeRun).toHaveBeenCalledWith(expect.objectContaining({ result: yielded }));
    expect(events.map((event) => event.eventType)).toEqual([
      "turn.completed",
      "run.result.accepted",
      "run.terminal",
    ]);
  });

  it("parks a provider turn immediately after a durable governed wait appears", async () => {
    const yielded: PrpStructuredRunResult = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "yielded",
      summary: "Waiting for the requested response.",
      completionClaim: {
        contractRevision: "1",
        objectiveSatisfied: false,
        criteria: [
          {
            criterionId: "objective",
            status: "unknown",
            evidenceRefs: ["interaction:pending"],
          },
        ],
        remainingWork: [
          { description: "Resume after the response.", blocksCompletion: true },
        ],
      },
      evidence: [{ ref: "interaction:pending" }],
      verification: [],
      attentionRequests: [],
      artifacts: [],
      continuation: {
        kind: "response_wake",
        summary: "Resume from the answer.",
        idempotencyKey: "interaction-response:pending",
      },
    };
    const itemCompleted: PrpEvent = {
      ...controlEvent(1, "item.completed", {
        kind: "dynamicToolCall",
        item: { id: "ask-1", name: "ask_user_questions" },
      }),
      sourceEventId: "provider-recovery:1",
      sourceInstanceId: "provider-recovery",
      sourceKind: "provider",
      turnId: "turn-waiting",
    };
    const turnInterrupted: PrpEvent = {
      ...controlEvent(2, "turn.interrupted", { reason: "governed_wait" }),
      sourceEventId: "provider-recovery:2",
      sourceInstanceId: "provider-recovery",
      sourceKind: "provider",
      turnId: "turn-waiting",
    };
    let releaseCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      releaseCancelled = resolve;
    });
    const cancel = vi.fn(() => {
      releaseCancelled();
      return { cleanup: Promise.resolve() };
    });
    const events: PrpEvent[] = [];
    const completeRun = vi.fn(async () => undefined);
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return {
          resume: false,
          typedEvents: true,
          steering: false,
          interruption: true,
          structuredResult: true,
        };
      },
      async *events() {
        yield itemCompleted;
        await cancelled;
        yield turnInterrupted;
      },
      async startTurn() {
        return { turnId: "turn-waiting" };
      },
      cancel,
      async result() {
        return null;
      },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: identity.sessionId,
          identity,
          providerSessionId: "provider-waiting",
          cursor: "2",
          activeTurnId: "turn-waiting",
          pendingRuntimeRequests: [],
          lineage: [],
        };
      },
      async close() {},
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "governed-wait-backend",
          version: "1",
          capabilities: {
            resume: false,
            typedEvents: true,
            steering: false,
            interruption: true,
            structuredResult: true,
          },
        };
      },
      async openSession() {
        return session;
      },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent(event) {
        events.push(structuredClone(event as PrpEvent));
        return {
          cursor: events.length,
          highestContiguousSourceSeq: highestContiguous(events),
          disposition: "committed",
        };
      },
      async replayEvents(replay) {
        const replayed = events.filter(
          (event) =>
            event.sourceInstanceId === replay.sourceInstanceId &&
            event.sourceSeq > replay.afterSourceSeq,
        );
        return {
          events: structuredClone(replayed),
          highestContiguousSourceSeq: highestContiguous(replayed),
        };
      },
      completeRun,
    };

    const completed = await executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      resolveGovernedWait: ({ event }) =>
        event.eventType === "item.completed" ? yielded : null,
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(completed).toMatchObject({
      result: yielded,
      terminal: {
        turnTerminalState: "completed",
        runTerminalState: "succeeded",
        reportedWorkDisposition: "yielded",
      },
    });
    expect(events.map((event) => event.eventType)).toEqual([
      "item.completed",
      "run.result.accepted",
      "run.terminal",
    ]);
  });

  it("hands a committed structured input to the durable wait after its live window", async () => {
    vi.useFakeTimers();
    try {
      const questionSet = {
        schema: "paperclip.question_set.v1" as const,
        questions: [{
          id: "region",
          prompt: "Which region?",
          required: true,
          answerMode: "single_select" as const,
          options: [{ id: "us", label: "US" }, { id: "eu", label: "Europe" }],
        }],
      };
      const request = {
        schema: "paperclip.runtime_request.v2",
        requestKind: "runtime",
        requestId: "input-1",
        type: "input",
        status: "pending",
        prompt: "Which region?",
        input: questionSet,
        origin: { adapter: "mock" },
        turnId: "turn-waiting",
        itemId: "input-1",
      };
      const created = { ...runnerEvent(1, "runtime_request.created", { request }), turnId: "turn-waiting" };
      const expired = { ...runnerEvent(2, "runtime_request.expired", {
        requestId: "input-1",
        requestKind: "runtime",
        turnId: "turn-waiting",
        itemId: "input-1",
        reason: "durable_handoff",
        replayAllowed: false,
        requestType: "input",
        request,
      }), turnId: "turn-waiting" };
      const interrupted = { ...runnerEvent(3, "turn.interrupted", { reason: "governed_wait" }), turnId: "turn-waiting" };
      let releaseHandoff!: () => void;
      const handedOff = new Promise<void>((resolve) => { releaseHandoff = resolve; });
      let releaseCancelled!: () => void;
      const cancelled = new Promise<void>((resolve) => { releaseCancelled = resolve; });
      let releaseCreated!: () => void;
      const createdCommitted = new Promise<void>((resolve) => { releaseCreated = resolve; });
      const handoffRuntimeRequest = vi.fn(() => {
        releaseHandoff();
        return { result: "handed_off" as const, cleanup: Promise.resolve() };
      });
      const cancel = vi.fn(() => {
        releaseCancelled();
        return { cleanup: Promise.resolve() };
      });
      const events: PrpEvent[] = [];
      const session: NativeSession = {
        identity: () => identity,
        async capabilities() {
          return {
            resume: false,
            typedEvents: true,
            steering: false,
            interruption: true,
            structuredResult: true,
            runtimeRequestHandoff: true,
          };
        },
        async *events() {
          yield created;
          await handedOff;
          yield expired;
          await cancelled;
          yield interrupted;
        },
        async startTurn() { return { turnId: "turn-waiting" }; },
        handoffRuntimeRequest,
        cancel,
        async result() { return null; },
        async snapshot() {
          return {
            backendKind: "mock",
            sessionId: identity.sessionId,
            identity,
            providerSessionId: "provider-waiting",
            cursor: "3",
            activeTurnId: "turn-waiting",
            pendingRuntimeRequests: [],
            lineage: [],
          };
        },
        async close() {},
      };
      const backend: NativeSessionBackend = {
        async descriptor() {
          return {
            kind: "mock",
            name: "runtime-input-wait-backend",
            version: "1",
            capabilities: {
              resume: false,
              typedEvents: true,
              steering: false,
              interruption: true,
              structuredResult: true,
              runtimeRequestHandoff: true,
            },
          };
        },
        async openSession() { return session; },
      };
      const port: ControlPlanePort = {
        async openRun() {},
        async checkpointSession() {},
        async appendEvent(event) {
          events.push(structuredClone(event as PrpEvent));
          if (event.eventType === "runtime_request.created") releaseCreated();
          const sourceEvents = events.filter((candidate) => candidate.sourceInstanceId === event.sourceInstanceId);
          return {
            cursor: events.length,
            highestContiguousSourceSeq: highestContiguous(sourceEvents),
            disposition: "committed",
          };
        },
        async replayEvents(replay) {
          const replayed = events.filter((event) =>
            event.sourceInstanceId === replay.sourceInstanceId && event.sourceSeq > replay.afterSourceSeq
          );
          return { events: structuredClone(replayed), highestContiguousSourceSeq: highestContiguous(replayed) };
        },
        async completeRun() {},
      };

      const execution = executeNativeSession({
        input,
        backend,
        controlPlane: port,
        runnerInstanceId: "runner-recovery",
        controlPlaneInstanceId: "control-recovery",
        runtimeInputLiveWindowMs: 120,
        resolveGovernedWait: ({ event }) =>
          event.eventType === "runtime_request.expired" ? yieldedResult : null,
      });
      await createdCommitted;
      expect(handoffRuntimeRequest).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(119);
      expect(handoffRuntimeRequest).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(execution).resolves.toMatchObject({ result: yieldedResult });
      expect(handoffRuntimeRequest).toHaveBeenCalledWith({
        requestId: "input-1",
        turnId: "turn-waiting",
        reason: "durable_handoff",
        signal: expect.any(AbortSignal),
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(events.map((event) => event.eventType)).toContain("runtime_request.expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts and bounds a durable handoff that never settles", async () => {
    const request = {
      schema: "paperclip.runtime_request.v2",
      requestKind: "runtime",
      requestId: "input-stalled",
      type: "input",
      status: "pending",
      prompt: "Which region?",
      input: {
        schema: "paperclip.question_set.v1",
        questions: [{
          id: "region",
          prompt: "Which region?",
          required: true,
          answerMode: "text",
        }],
      },
      origin: { adapter: "mock" },
      turnId: "turn-stalled",
      itemId: "input-stalled",
    };
    const created = {
      ...runnerEvent(1, "runtime_request.created", { request }),
      turnId: "turn-stalled",
    };
    let releaseEvents = () => {};
    const eventsReleased = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    let markHandoffStarted = () => {};
    const handoffStarted = new Promise<void>((resolve) => {
      markHandoffStarted = resolve;
    });
    let handoffSignal: AbortSignal | undefined;
    let releaseHandoff = () => {};
    const close = vi.fn(async () => releaseEvents());
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return {
          resume: false,
          typedEvents: true,
          steering: false,
          interruption: true,
          structuredResult: true,
          runtimeRequestHandoff: true,
        };
      },
      async *events() {
        yield created;
        await eventsReleased;
      },
      async startTurn() {
        return { turnId: "turn-stalled" };
      },
      handoffRuntimeRequest(input) {
        handoffSignal = input.signal;
        markHandoffStarted();
        return {
          result: "handed_off",
          cleanup: new Promise<void>((resolve) => { releaseHandoff = resolve; }),
        };
      },
      cancel() {
        releaseEvents();
        return { cleanup: Promise.resolve() };
      },
      async result() {
        return null;
      },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: identity.sessionId,
          identity,
          providerSessionId: "provider-stalled",
          activeTurnId: "turn-stalled",
        };
      },
      close,
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "stalled-handoff-backend",
          version: "1",
          capabilities: await session.capabilities(),
        };
      },
      async openSession() {
        return session;
      },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent() {
        return {
          cursor: 1,
          highestContiguousSourceSeq: 1,
          disposition: "committed",
        };
      },
      async replayEvents() {
        return { events: [], highestContiguousSourceSeq: 0 };
      },
      async completeRun() {},
    };

    const execution = executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      runtimeInputLiveWindowMs: 1,
      timeoutMs: 25,
      keepSessionOpen: true,
    });
    await handoffStarted;
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(handoffSignal?.aborted).toBe(true);
    await expect(execution).rejects.toThrow("native session timed out");
    releaseHandoff();
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves terminal success while iterator teardown remains pending", async () => {
    vi.useFakeTimers();
    try {
      let releaseTeardown = () => {};
      const teardownStarted = vi.fn();
      const close = vi.fn(async () => undefined);
      const readResult = vi.fn(async () => ({
        result,
        terminal,
        turnId: "turn-terminal",
      }));
      const session: NativeSession = {
        identity: () => identity,
        async capabilities() {
          return {
            resume: false,
            typedEvents: true,
            steering: false,
            interruption: true,
            structuredResult: true,
          };
        },
        async *events() {
          try {
            yield { ...runnerEvent(1, "turn.completed"), turnId: "turn-terminal" };
          } finally {
            teardownStarted();
            await new Promise<void>((resolve) => {
              releaseTeardown = resolve;
            });
          }
        },
        async startTurn() {
          return { turnId: "turn-terminal" };
        },
        result: readResult,
        async snapshot() {
          return {
            backendKind: "mock",
            sessionId: identity.sessionId,
            identity,
            providerSessionId: "provider-terminal",
            cursor: "1",
            activeTurnId: null,
          };
        },
        close,
      };
      const backend: NativeSessionBackend = {
        async descriptor() {
          return {
            kind: "mock",
            name: "slow-teardown-backend",
            version: "1",
            capabilities: await session.capabilities(),
          };
        },
        async openSession() {
          return session;
        },
      };
      const completeRun = vi.fn(async () => undefined);
      const port: ControlPlanePort = {
        async openRun() {},
        async checkpointSession() {},
        async appendEvent() {
          return {
            cursor: 1,
            highestContiguousSourceSeq: 1,
            disposition: "committed",
          };
        },
        async replayEvents() {
          return { events: [], highestContiguousSourceSeq: 0 };
        },
        completeRun,
      };

      const execution = executeNativeSession({
        input,
        backend,
        controlPlane: port,
        runnerInstanceId: "runner-recovery",
        controlPlaneInstanceId: "control-recovery",
      });
      await vi.waitFor(() => expect(teardownStarted).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(100);
      await expect(execution).resolves.toMatchObject({ result });
      expect(readResult).toHaveBeenCalledOnce();
      expect(completeRun).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      releaseTeardown();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves terminal success while quarantining stalled handoff cleanup", async () => {
    const request = {
      schema: "paperclip.runtime_request.v2",
      requestKind: "runtime",
      requestId: "input-terminal",
      type: "input",
      status: "pending",
      prompt: "Which region?",
      input: {
        schema: "paperclip.question_set.v1",
        questions: [{
          id: "region",
          prompt: "Which region?",
          required: true,
          answerMode: "text",
        }],
      },
      origin: { adapter: "mock" },
      turnId: "turn-terminal",
      itemId: "input-terminal",
    };
    let markHandoffStarted = () => {};
    const handoffStarted = new Promise<void>((resolve) => {
      markHandoffStarted = resolve;
    });
    let releaseHandoff = () => {};
    let handoffSignal: AbortSignal | undefined;
    const close = vi.fn(async () => undefined);
    const onSession = vi.fn();
    const completeRun = vi.fn(async () => undefined);
    const readResult = vi.fn(async () => ({
      result,
      terminal,
      turnId: "turn-terminal",
    }));
    const providerEvents = [
      {
        ...runnerEvent(1, "runtime_request.created", { request }),
        turnId: "turn-terminal",
      },
      { ...runnerEvent(2, "turn.completed"), turnId: "turn-terminal" },
    ];
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return {
          resume: false,
          typedEvents: true,
          steering: false,
          interruption: true,
          structuredResult: true,
          runtimeRequestHandoff: true,
        };
      },
      async *events() {
        yield providerEvents[0]!;
        await handoffStarted;
        yield providerEvents[1]!;
      },
      async startTurn() {
        return { turnId: "turn-terminal" };
      },
      handoffRuntimeRequest(input) {
        handoffSignal = input.signal;
        markHandoffStarted();
        return {
          result: "handed_off",
          cleanup: new Promise<void>((resolve) => {
            releaseHandoff = resolve;
          }),
        };
      },
      result: readResult,
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: identity.sessionId,
          identity,
          providerSessionId: "provider-terminal",
          cursor: "2",
          activeTurnId: null,
        };
      },
      close,
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "terminal-handoff-backend",
          version: "1",
          capabilities: await session.capabilities(),
        };
      },
      async openSession() {
        return session;
      },
    };
    const appended: PrpEvent[] = [];
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent(event) {
        appended.push(structuredClone(event as PrpEvent));
        return {
          cursor: appended.length,
          highestContiguousSourceSeq: highestContiguous(appended),
          disposition: "committed",
        };
      },
      async replayEvents() {
        return { events: [], highestContiguousSourceSeq: 0 };
      },
      completeRun,
    };

    const execution = executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      runtimeInputLiveWindowMs: 1,
      keepSessionOpen: true,
      onSession,
    });
    await handoffStarted;
    await vi.waitFor(() => expect(handoffSignal?.aborted).toBe(true));
    await expect(execution).resolves.toMatchObject({ result });
    expect(readResult).toHaveBeenCalledOnce();
    expect(completeRun).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(onSession).toHaveBeenLastCalledWith(null);
    releaseHandoff();
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    expect(completeRun).toHaveBeenCalledOnce();
  });

  it("keeps a settling structured input in the original turn while its append crosses expiry", async () => {
    const request = {
      schema: "paperclip.runtime_request.v2",
      requestKind: "runtime",
      requestId: "input-live",
      type: "input",
      status: "pending",
      prompt: "Which region?",
      input: {
        schema: "paperclip.question_set.v1",
        questions: [{
          id: "region",
          prompt: "Which region?",
          required: true,
          answerMode: "text",
        }],
      },
      origin: { adapter: "mock" },
      turnId: "turn-live",
      itemId: "input-live",
    };
    const providerEvents = [
      { ...runnerEvent(1, "runtime_request.created", { request }), turnId: "turn-live" },
      {
        ...runnerEvent(2, "runtime_request.resolved", {
          requestId: "input-live",
          requestKind: "user_input",
          turnId: "turn-live",
          itemId: "input-live",
          action: "submit",
          requestType: "input",
        }),
        turnId: "turn-live",
      },
      { ...runnerEvent(3, "turn.completed"), turnId: "turn-live" },
    ];
    const appended: PrpEvent[] = [];
    let markSettlementAppendStarted!: () => void;
    const settlementAppendStarted = new Promise<void>((resolve) => {
      markSettlementAppendStarted = resolve;
    });
    let releaseSettlementAppend!: () => void;
    const settlementAppendReleased = new Promise<void>((resolve) => {
      releaseSettlementAppend = resolve;
    });
    const handoffRuntimeRequest = vi.fn(() => ({
      result: "handed_off" as const,
      cleanup: Promise.resolve(),
    }));
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return {
          resume: false,
          typedEvents: true,
          steering: false,
          interruption: true,
          structuredResult: true,
          runtimeRequestHandoff: true,
        };
      },
      async *events() { yield* providerEvents; },
      async startTurn() { return { turnId: "turn-live" }; },
      handoffRuntimeRequest,
      async result() { return { result, terminal, turnId: "turn-live" }; },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: identity.sessionId,
          identity,
          providerSessionId: "provider-live",
          cursor: "3",
          activeTurnId: null,
          pendingRuntimeRequests: [],
          lineage: [],
        };
      },
      async close() {},
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "runtime-input-live-backend",
          version: "1",
          capabilities: {
            resume: false,
            typedEvents: true,
            steering: false,
            interruption: true,
            structuredResult: true,
            runtimeRequestHandoff: true,
          },
        };
      },
      async openSession() { return session; },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent(event) {
        if (event.eventType === "runtime_request.resolved") {
          markSettlementAppendStarted();
          await settlementAppendReleased;
        }
        appended.push(structuredClone(event as PrpEvent));
        const sourceEvents = appended.filter((candidate) => candidate.sourceInstanceId === event.sourceInstanceId);
        return {
          cursor: appended.length,
          highestContiguousSourceSeq: highestContiguous(sourceEvents),
          disposition: "committed",
        };
      },
      async replayEvents(replay) {
        const replayed = appended.filter((event) =>
          event.sourceInstanceId === replay.sourceInstanceId && event.sourceSeq > replay.afterSourceSeq
        );
        return { events: structuredClone(replayed), highestContiguousSourceSeq: highestContiguous(replayed) };
      },
      async completeRun() {},
    };

    const originalSetTimeout = globalThis.setTimeout;
    let queuedHandoffCallback: (() => void) | null = null;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
      if (delay === 123_456) {
        queuedHandoffCallback = () => callback(...args);
        const handle = originalSetTimeout(() => undefined, 60_000);
        handle.unref?.();
        return handle;
      }
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    try {
      const execution = executeNativeSession({
        input,
        backend,
        controlPlane: port,
        runnerInstanceId: "runner-recovery",
        controlPlaneInstanceId: "control-recovery",
        runtimeInputLiveWindowMs: 123_456,
      });
      await settlementAppendStarted;
      expect(queuedHandoffCallback).not.toBeNull();
      queuedHandoffCallback?.();
      await Promise.resolve();
      expect(handoffRuntimeRequest).not.toHaveBeenCalled();
      releaseSettlementAppend();
      await expect(execution).resolves.toMatchObject({ result });
      queuedHandoffCallback?.();
      await Promise.resolve();
      expect(handoffRuntimeRequest).not.toHaveBeenCalled();
      expect(appended.some((event) => event.eventType === "runtime_request.expired")).toBe(false);
    } finally {
      releaseSettlementAppend();
      timeoutSpy.mockRestore();
    }
  });
});
