import { describe, expect, it, vi } from "vitest";

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
});

function driverFixture(overrides: Partial<CodexAcpxDriverOptions> = {}): {
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
        yield {
          type: "text_delta" as const,
          text: "Task complete.",
          stream: "output" as const,
        };
        yield {
          type: "tool_call" as const,
          toolCallId: "provider-tool-1",
          title: "Read",
          kind: "read" as const,
          status: "pending",
          tag: "tool_call",
          text: "Reading",
        };
      },
    },
    result: result.promise,
    cancel: vi.fn(async () => undefined),
    closeStream: vi.fn(async () => undefined),
  };
  const host = fakeHost(turn);
  let hostOptions: OpenAcpxRuntimeHostOptions | null = null;
  const dependencies: CodexAcpxDriverDependencies = {
    openHost: async (options) => {
      hostOptions = options;
      return host;
    },
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

function fakeHost(turn: AcpxRuntimeTurn) {
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
    close: vi.fn(async () => undefined),
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
