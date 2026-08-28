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

  it("reports a host close timeout and retains cleanup ownership", async () => {
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

    fixture.finishTurn({ status: "cancelled", stopReason: "session_closed" });
    hostClose.resolve();
    await expect(
      session.close({ reason: "finish retained cleanup" }),
    ).resolves.toBeUndefined();
    expect(fixture.host.close).toHaveBeenCalledOnce();
    await expect(terminalEvents).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "turn.interrupted" }),
      ]),
    );
  });

  it("bounds lagging streams while preserving omission and terminal events", async () => {
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
    await session.startTurn({
      message: { role: "user", text: "Produce another large turn." },
    });
    await vi.waitFor(async () => {
      const snapshot = await session.snapshot();
      expect(snapshot.terminalTurns).toHaveLength(2);
      const transcript = await session.transcript!();
      expect(transcript.eventCount).toBeGreaterThan(1_024);
      expect(transcript.complete).toBe(false);
      expect(transcript.events.length).toBeLessThanOrEqual(1_024);
      expect(transcript.omissionReason).toBe("retention_limit");
    });

    await session.close({ reason: "bounds verified" });
    const iterator = session.events()[Symbol.asyncIterator]();
    const retained: PrpEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      retained.push(next.value);
    }
    expect(retained).toHaveLength(512);
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
    ).toHaveLength(2);
  });

  it("preserves every terminal when the bounded queue is all critical", async () => {
    const fixture = driverFixture({}, { maxBufferedEvents: 4 });
    const session = await fixture.driver.openSession({
      runId: "run-critical-bounds",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalTurnIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const { turnId } = await session.startTurn({
        message: { role: "user", text: `Complete turn ${index}.` },
      });
      terminalTurnIds.push(turnId);
      fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
      await vi.waitFor(async () => {
        await expect(session.snapshot()).resolves.toMatchObject({
          activeTurnId: null,
        });
      });
    }
    await expect(
      session.startTurn({
        message: { role: "user", text: "Exceed the bounded turn limit." },
      }),
    ).rejects.toThrow("bounded session turn limit");

    await session.close({ reason: "critical bounds verified" });
    const retained: PrpEvent[] = [];
    for await (const event of session.events()) retained.push(event);
    expect(
      retained
        .filter((event) => event.eventType === "turn.completed")
        .map((event) => event.turnId),
    ).toEqual(terminalTurnIds);
  });
});

function driverFixture(
  overrides: Partial<CodexAcpxDriverOptions> = {},
  fixtureOptions: {
    runtimeEvents?: readonly AcpRuntimeEvent[];
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
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
