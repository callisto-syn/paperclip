import { describe, expect, it, vi } from "vitest";

import type { AcpRuntimeEvent } from "acpx/runtime";

import {
  PRP_BLOCK_TOOL_NAME,
  PRP_COMPLETION_TOOL_NAME,
} from "../../contracts/completion-result.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { validatePrpEvent } from "../../protocol/replay-contract.js";
import {
  CodexAcpxDriver,
  type CodexAcpxDriverDependencies,
  type CodexAcpxDriverOptions,
} from "./codex-acpx-driver.js";
import type {
  AcpxRuntimeTurn,
  OpenAcpxRuntimeHostOptions,
} from "./runtime-host.js";

describe("Codex ACPX harness driver", () => {
  it("advertises only the implemented Codex production surface", async () => {
    const fixture = driverFixture();
    const descriptor = await fixture.driver.descriptor();

    expect(descriptor).toMatchObject({
      kind: "acpx_runtime",
      displayName: "Codex via ACPX",
      capabilities: {
        resume: false,
        interruption: true,
        dynamicTools: true,
        runtimeRequestResolution: false,
      },
      runtimeContextCapabilities: {
        instructions: "native",
        skills: "unsupported",
        mcp: "native",
      },
    });
    await expect(
      fixture.driver.validateConfig({
        agent: "claude",
        model: "claude-sonnet-5",
        permissionMode: "approve-reads",
      }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [{ code: "unsupported_agent" }],
    });
  });

  it("maps one turn, dispatches tools, and commits one semantic result", async () => {
    const dynamicToolHandler = vi.fn(async () => ({ title: "Document" }));
    const fixture = driverFixture({ dynamicToolHandler });
    const session = await fixture.driver.openSession({
      runId: "run-1",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.completed");

    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });
    const bridgeHandler = fixture.hostOptions!.semanticTools!.handler;
    await expect(
      bridgeHandler({
        tool: "documents.read",
        callId: "tool-1",
        arguments: { id: "doc-1" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ title: "Document" });
    expect(dynamicToolHandler).toHaveBeenCalledWith({
      tool: "documents.read",
      callId: "tool-1",
      providerSessionId: "agent-1",
      turnId,
      arguments: { id: "doc-1" },
      signal: expect.any(AbortSignal),
    });

    await expect(
      bridgeHandler({
        tool: PRP_COMPLETION_TOOL_NAME,
        callId: "finish-1",
        arguments: completedResult(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ accepted: true });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });

    const events = await terminalEvents;
    expect(events.every((event) => validatePrpEvent(event).ok)).toBe(true);
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "turn.submitted",
        "turn.accepted",
        "turn.started",
        "item.delta",
        "tool.execution.started",
        "run.result.proposed",
        "item.completed",
        "turn.completed",
      ]),
    );
    expect(
      events.findIndex((event) => event.eventType === "run.result.proposed"),
    ).toBeLessThan(
      events.findIndex((event) => event.eventType === "turn.completed"),
    );
    await expect(session.snapshot()).resolves.toMatchObject({
      driverKind: "acpx_runtime",
      activeTurnId: null,
      providerIdentity: {
        kind: "acpx",
        agentSessionId: "agent-1",
      },
      semanticResult: {
        callId: "finish-1",
        turnId,
        result: { reportedWorkDisposition: "done" },
      },
    });
    await session.close({ reason: "complete" });
    await session.close({ reason: "idempotent close" });
    expect(fixture.host.close).toHaveBeenCalledOnce();
  });

  it("rejects terminal disposition drift and bounds interruption", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-2",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });
    const bridgeHandler = fixture.hostOptions!.semanticTools!.handler;

    await expect(
      bridgeHandler({
        tool: PRP_BLOCK_TOOL_NAME,
        callId: "block-1",
        arguments: completedResult(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("does not match");
    await session.interrupt({ turnId, reason: "user cancelled" });
    expect(fixture.host.interruptActiveTurn).toHaveBeenCalledWith(
      "user cancelled",
    );
    await expect(session.interrupt({ turnId: "stale-turn" })).rejects.toThrow(
      "is not the active turn",
    );
    await session.close({ reason: "cancelled" });
  });

  it("emits an interrupted terminal before closing an active stream", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-close",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.interrupted");
    await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });

    await Promise.all([
      session.close({ reason: "operator shutdown" }),
      session.close({ reason: "duplicate shutdown" }),
    ]);

    await expect(terminalEvents).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "turn.interrupted" }),
      ]),
    );
    await expect(session.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      terminalTurns: [expect.objectContaining({ turnId: expect.any(String) })],
    });
    expect(fixture.host.close).toHaveBeenCalledOnce();
  });

  it("classifies a pump rejection during close as interrupted", async () => {
    const runtimeEventFailure = deferred<never>();
    const fixture = driverFixture({}, { runtimeEventFailure: runtimeEventFailure.promise });
    const session = await fixture.driver.openSession({
      runId: "run-close-pump-failure",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.interrupted");
    await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });

    const closing = session.close({ reason: "operator shutdown" });
    runtimeEventFailure.reject(new Error("provider stream closed during shutdown"));
    await expect(closing).resolves.toBeUndefined();

    const emitted = await terminalEvents;
    expect(emitted.filter((event) => event.eventType === "turn.interrupted"))
      .toHaveLength(1);
    expect(emitted.some((event) => event.eventType === "turn.failed")).toBe(false);
  });

  it("reports a host close timeout while retaining the exact cleanup", async () => {
    const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
    const hostClose = deferred<void>();
    fixture.host.close.mockImplementation(() => hostClose.promise);
    const session = await fixture.driver.openSession({
      runId: "run-close-timeout",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.interrupted");
    await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });

    await expect(
      session.close({ reason: "runtime close stalled" }),
    ).rejects.toThrow("host cleanup exceeded its shutdown timeout");
    expect(fixture.host.close).toHaveBeenCalledOnce();
    await expect(terminalEvents).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "turn.interrupted" }),
      ]),
    );
    await expect(session.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      terminalTurns: [expect.objectContaining({ turnId: expect.any(String) })],
    });

    fixture.finishTurn({ status: "cancelled", stopReason: "session_closed" });
    hostClose.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(fixture.host.close).toHaveBeenCalledOnce();
  });

  it("reconciles the retained close when it settles after the wait bound", async () => {
    const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
    const retainedClose = deferred<void>();
    fixture.host.close.mockImplementation(() => retainedClose.promise);
    const session = await fixture.driver.openSession({
      runId: "run-close-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });

    await expect(
      session.close({ reason: "runtime close stalled" }),
    ).rejects.toThrow("host cleanup exceeded its shutdown timeout");
    retainedClose.resolve();
    await expect(
      session.close({ reason: "observe retained completion" }),
    ).resolves.toBeUndefined();
    expect(fixture.host.close).toHaveBeenCalledOnce();
  });

  it("does not spin while the exact host cleanup remains pending", async () => {
    const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
    const stalledClose = deferred<void>();
    fixture.host.close.mockImplementation(() => stalledClose.promise);
    const session = await fixture.driver.openSession({
      runId: "run-close-stalled-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });

    await expect(
      session.close({ reason: "runtime close never settles" }),
    ).rejects.toThrow("host cleanup exceeded its shutdown timeout");
    expect(fixture.host.close).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(fixture.host.close).toHaveBeenCalledOnce();
  });

  it("retains autonomous host cleanup recovery through repeated failure", async () => {
    const fixture = driverFixture({}, {
      closeSettlementTimeoutMs: 1,
    });
    fixture.host.close
      .mockRejectedValueOnce(new Error("transient cleanup failure"))
      .mockRejectedValueOnce(new Error("second cleanup failure"))
      .mockResolvedValueOnce(undefined);
    const session = await fixture.driver.openSession({
      runId: "run-close-permanent-failure",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const diagnosticEvents = collectUntil(session.events(), "harness.diagnostic");

    await expect(
      session.close({ reason: "runtime close initially failed" }),
    ).rejects.toThrow("transient cleanup failure");
    await expect(diagnosticEvents).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "harness.diagnostic",
        payload: expect.objectContaining({ code: "acpx_host_cleanup_deferred" }),
      }),
    ]));
    await vi.waitFor(() => expect(fixture.host.close).toHaveBeenCalledTimes(3));
    expect(fixture.host.close).toHaveBeenLastCalledWith({
      reason: "runtime close initially failed (automatic cleanup recovery 2)",
    });
    await expect(
      session.close({ reason: "observe recovered cleanup" }),
    ).resolves.toBeUndefined();
    expect(fixture.host.close).toHaveBeenCalledTimes(3);
  });

  it("keeps an autonomous owner after bounded foreground cleanup retries", async () => {
    const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
    fixture.host.close.mockRejectedValue(new Error("persistent cleanup failure"));
    const session = await fixture.driver.openSession({
      runId: "run-close-retry-bound",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });

    await expect(
      session.close({ reason: "runtime close persistently failed" }),
    ).rejects.toThrow("persistent cleanup failure");
    await vi.waitFor(() => expect(fixture.host.close.mock.calls.length).toBeGreaterThanOrEqual(4));
    await expect(
      fixture.driver.openSession({
        runId: "run-after-quarantine",
        normalizedSessionId: "session-2",
        workingDirectory: "/workspace",
      }),
    ).rejects.toThrow("quarantined host cleanup remains incomplete");
    const callsBeforeRecovery = fixture.host.close.mock.calls.length;
    fixture.host.close.mockResolvedValue(undefined);
    await vi.waitFor(() => expect(fixture.host.close.mock.calls.length).toBeGreaterThan(callsBeforeRecovery));
    expect(fixture.host.close).toHaveBeenLastCalledWith({
      reason: "runtime close persistently failed (quarantined cleanup recovery)",
    });
    await expect(fixture.driver.openSession({
      runId: "run-after-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    })).resolves.toBeDefined();
  });

  it("bounds lagging streams without introducing source sequence gaps", async () => {
    const fixture = driverFixture(
      {},
      {
        runtimeEvents: Array.from({ length: 1_100 }, (_, index) => ({
          type: "text_delta" as const,
          text: `chunk-${index}`,
          stream: "output" as const,
        })),
      },
    );
    const session = await fixture.driver.openSession({
      runId: "run-bounds",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    await session.startTurn({
      message: { role: "user", text: "Produce many events." },
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });

    await vi.waitFor(async () => {
      const snapshot = await session.snapshot();
      expect(snapshot.terminalTurns).toHaveLength(1);
    });
    await vi.waitFor(async () => {
      const snapshot = await session.snapshot();
      expect(snapshot.terminalTurns).toHaveLength(1);
      const transcript = await session.transcript!();
      expect(transcript.eventCount).toBeGreaterThan(1_024);
      expect(transcript.complete).toBe(false);
      expect(transcript.events.length).toBeLessThanOrEqual(1_024);
      expect(transcript.omissionReason).toBe("retention_limit");
    });
    await expect(
      session.startTurn({
        message: { role: "user", text: "Do not overtake the lagging consumer." },
      }),
    ).rejects.toThrow("event consumer must drain");

    await session.close({ reason: "bounds verified" });
    const iterator = session.events()[Symbol.asyncIterator]();
    const retained: PrpEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      retained.push(next.value);
    }
    expect(retained.length).toBeLessThanOrEqual(512);
    expect(retained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "harness.diagnostic",
          payload: expect.objectContaining({
            code: "event_stream_retention_limit",
          }),
        }),
      ]),
    );
    expect(
      retained.filter((event) => event.eventType === "turn.completed"),
    ).toHaveLength(1);
    expect(retained.map((event) => event.sourceSeq)).toEqual(
      Array.from({ length: retained.length }, (_, index) => index + 1),
    );
  });

  it("retains a committed semantic proposal under terminal queue pressure", async () => {
    const fixture = driverFixture({}, { maxBufferedEvents: 6 });
    const session = await fixture.driver.openSession({
      runId: "run-semantic-bounds",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });
    await expect(fixture.hostOptions!.semanticTools!.handler({
      tool: PRP_COMPLETION_TOOL_NAME,
      callId: "finish-bounded",
      arguments: completedResult(),
      signal: new AbortController().signal,
    })).resolves.toEqual({ accepted: true });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });

    await vi.waitFor(async () => {
      await expect(session.snapshot()).resolves.toMatchObject({
        terminalTurns: [expect.objectContaining({ turnId })],
      });
    });
    await session.close({ reason: "bounded result verified" });
    const retained: PrpEvent[] = [];
    for await (const event of session.events()) retained.push(event);

    const proposalIndex = retained.findIndex(
      (event) => event.eventType === "run.result.proposed",
    );
    const terminalIndex = retained.findIndex(
      (event) => event.eventType === "turn.completed",
    );
    expect(proposalIndex).toBeGreaterThanOrEqual(0);
    expect(terminalIndex).toBeGreaterThan(proposalIndex);
    expect(retained).toHaveLength(6);
  });

  it("rejects turn admission when only terminal reserve capacity remains", async () => {
    const fixture = driverFixture({}, { maxBufferedEvents: 6 });
    const session = await fixture.driver.openSession({
      runId: "run-admission-bounds",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    await session.startTurn({
      message: { role: "user", text: "Fill the regular event capacity." },
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    await vi.waitFor(async () => {
      await expect(session.snapshot()).resolves.toMatchObject({
        terminalTurns: [expect.objectContaining({ turnId: expect.any(String) })],
      });
    });
    const iterator = session.events()[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();

    await expect(session.startTurn({
      message: { role: "user", text: "Must wait for the remaining events." },
    })).rejects.toThrow("event consumer must drain");
    expect(fixture.host.startTurn).toHaveBeenCalledOnce();
    await session.close({ reason: "admission bound verified" });
  });

  it("preserves every terminal when the bounded consumer keeps draining", async () => {
    const fixture = driverFixture({}, { maxBufferedEvents: 6 });
    const session = await fixture.driver.openSession({
      runId: "run-critical-bounds",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalTurnIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const terminalEvents = collectUntil(session.events(), "turn.completed");
      const { turnId } = await session.startTurn({
        message: { role: "user", text: `Complete turn ${index}.` },
      });
      terminalTurnIds.push(turnId);
      fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
      const emitted = await terminalEvents;
      expect(emitted.at(-1)).toMatchObject({
        eventType: "turn.completed",
        turnId,
      });
    }
    await expect(
      session.startTurn({
        message: { role: "user", text: "Exceed the bounded turn limit." },
      }),
    ).rejects.toThrow("bounded session turn limit");

    await session.close({ reason: "critical bounds verified" });
    await expect(session.snapshot()).resolves.toMatchObject({
      terminalTurns: terminalTurnIds.map((turnId) =>
        expect.objectContaining({ turnId }),
      ),
    });
  });
});

function driverFixture(
  overrides: Partial<CodexAcpxDriverOptions> = {},
  fixtureOptions: {
    runtimeEvents?: readonly AcpRuntimeEvent[];
    runtimeEventFailure?: Promise<never>;
    closeSettlementTimeoutMs?: number;
    maxBufferedEvents?: number;
  } = {},
): {
  driver: CodexAcpxDriver;
  host: ReturnType<typeof fakeHost>;
  hostOptions: OpenAcpxRuntimeHostOptions | null;
  finishTurn(result: Awaited<AcpxRuntimeTurn["result"]>): void;
} {
  const result = deferred<Awaited<AcpxRuntimeTurn["result"]>>();
  const turn: AcpxRuntimeTurn = {
    requestId: "provider-turn-1",
    promptStarted: Promise.resolve(),
    events: {
      async *[Symbol.asyncIterator]() {
        yield* fixtureOptions.runtimeEvents ?? [
          {
            type: "text_delta" as const,
            text: "Task complete.",
            stream: "output" as const,
          },
          {
            type: "tool_call" as const,
            toolCallId: "provider-tool-1",
            title: "Read",
            kind: "read" as const,
            status: "pending",
            tag: "tool_call",
            text: "Reading",
          },
        ];
        if (fixtureOptions.runtimeEventFailure) {
          await fixtureOptions.runtimeEventFailure;
        }
      },
    },
    result: result.promise,
    cancel: vi.fn(async () => undefined),
    closeStream: vi.fn(async () => undefined),
  };
  const host = fakeHost(turn, () =>
    result.resolve({ status: "cancelled", stopReason: "session_closed" }),
  );
  let hostOptions: OpenAcpxRuntimeHostOptions | null = null;
  const dependencies: CodexAcpxDriverDependencies = {
    openHost: async (options) => {
      hostOptions = options;
      return host;
    },
    closeSettlementTimeoutMs: fixtureOptions.closeSettlementTimeoutMs,
    maxBufferedEvents: fixtureOptions.maxBufferedEvents,
  };
  const driver = new CodexAcpxDriver(
    {
      runtimeDirectory: "/runtime",
      model: "gpt-5.6-sol",
      permissionMode: "approve-reads",
      dynamicTools: [
        {
          name: "documents.read",
          inputSchema: { type: "object" },
        },
      ],
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      ...overrides,
    },
    dependencies,
  );
  return {
    driver,
    host,
    get hostOptions() {
      return hostOptions;
    },
    finishTurn: result.resolve,
  };
}

function fakeHost(turn: AcpxRuntimeTurn, onClose: () => void) {
  return {
    identity: () => ({
      schema: "paperclip.runner.acpx-identity.v1" as const,
      normalizedSessionId: "session-1",
      acpxRecordId: "record-1",
      backendSessionId: "backend-1",
      agentSessionId: "agent-1",
      profileDigest: `sha256:${"a".repeat(64)}`,
      workspaceDigest: `sha256:${"b".repeat(64)}`,
      requestedModel: "gpt-5.6-sol",
      effectiveModel: "gpt-5.6-sol",
      permissionMode: "approve-reads" as const,
    }),
    binding: () => ({
      normalizedSessionId: "session-1",
      workspacePath: "/workspace",
      workspaceDigest: `sha256:${"b".repeat(64)}`,
      runtimeRoot: "/runtime/acpx/session-1",
      profileDigest: `sha256:${"a".repeat(64)}`,
      requestedModel: "gpt-5.6-sol",
      effectiveModel: "gpt-5.6-sol",
      permissionMode: "approve-reads" as const,
      profileSessionKey: "paperclip-session",
    }),
    status: vi.fn(async () => ({
      agentSessionId: "agent-1",
      models: {
        currentModelId: "gpt-5.6-sol",
        availableModelIds: ["gpt-5.6-sol"],
      },
    })),
    startTurn: vi.fn(() => turn),
    interruptActiveTurn: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      onClose();
    }),
  };
}

async function collectUntil(
  events: AsyncIterable<PrpEvent>,
  terminalType: PrpEvent["eventType"],
): Promise<PrpEvent[]> {
  const collected: PrpEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    if (event.eventType === terminalType) return collected;
  }
  throw new Error(`Event stream closed before ${terminalType}`);
}

function completedResult() {
  return {
    schema: "paperclip.run_result.v1" as const,
    reportedWorkDisposition: "done" as const,
    summary: "The task is complete.",
    completionClaim: {
      contractRevision: "codex-acpx-test-v1",
      objectiveSatisfied: true,
      criteria: [],
      remainingWork: [],
    },
    evidence: [],
    verification: [
      { commandOrCheck: "Codex ACPX driver test", status: "passed" as const },
    ],
    attentionRequests: [],
    artifacts: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}
