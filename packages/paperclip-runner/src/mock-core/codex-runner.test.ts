import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CODEX_CODEX_PROTOCOL_VERSION,
  CODEX_SKILLLESS_BASE_INSTRUCTIONS,
  createCodexTaskEnvelope,
  type CodexModelContextSnapshot,
} from "../contracts/codex.js";
import type {
  HarnessDriver,
  HarnessSession,
  OpenHarnessSessionInput,
} from "../contracts/harness-driver.js";
import type {
  PrpEvent,
  PrpStructuredRunResult,
} from "../protocol/replay-contract.js";
import { loadLiveConsoleConformanceFixture } from "../protocol/live-console-fixture.js";
import {
  runCodexCodexTracer,
  validateCodexResultProposal,
} from "./codex-runner.js";

const envelope = createCodexTaskEnvelope({
  objective: "Create hello.txt with the text hello.",
  criteria: [{ id: "file", requirement: "hello.txt contains hello" }],
});

function completedResult(): PrpStructuredRunResult {
  return {
    schema: "paperclip.run_result.v1",
    reportedWorkDisposition: "done",
    summary: "Created hello.txt.",
    completionClaim: {
      contractRevision: envelope.completionContract.revision,
      objectiveSatisfied: true,
      criteria: [{
        criterionId: "file",
        status: "satisfied",
        evidenceRefs: ["hello.txt"],
      }],
      remainingWork: [],
    },
    evidence: [{ ref: "hello.txt" }],
    verification: [{ commandOrCheck: "read hello.txt", status: "passed" }],
    attentionRequests: [],
    artifacts: [{ kind: "file", ref: "hello.txt" }],
  };
}

class TraceConformanceDriver implements HarnessDriver {
  async descriptor() {
    return {
      kind: "codex-trace-fixture",
      displayName: "Codex trace fixture",
      version: "1.0.0",
      protocolVersion: CODEX_CODEX_PROTOCOL_VERSION,
      capabilities: {
        resume: false,
        typedEvents: true,
        steering: false,
        interruption: false,
        structuredResult: true,
        dynamicTools: false,
      },
    };
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    const turnId = "turn-trace";
    let releaseEvents: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    const events: PrpEvent[] = [];
    const context: CodexModelContextSnapshot = {
      protocolVersion: CODEX_CODEX_PROTOCOL_VERSION,
      codexVersion: "trace-fixture",
      clientInfo: {
        name: "paperclip-runner",
        title: "Paperclip Runner",
        version: "1.0.0",
      },
      model: "codex-fixture",
      modelProvider: "openai",
      workingDirectory: input.workingDirectory,
      collaborationMode: "default",
      sandbox: { type: "workspaceWrite" },
      approvalPolicy: "never",
      baseInstructions: CODEX_SKILLLESS_BASE_INSTRUCTIONS,
      instructionSources: [],
      instructionPolicy: {
        skillInstructions: false,
        appInstructions: false,
        collaborationInstructions: true,
      },
      environmentKeys: [],
      dynamicToolNames: [],
      modelInputKinds: ["text"],
      envelope,
    };
    const event = (
      sourceSeq: number,
      eventType: PrpEvent["eventType"],
      payload: Record<string, unknown>,
      withTurn = true,
    ): PrpEvent => ({
      schema: "paperclip.prp.event.v1",
      sourceEventId: `provider:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: "codex-trace-provider",
      sourceKind: "runner",
      runId: input.runId,
      normalizedSessionId: input.normalizedSessionId,
      ...(withTurn ? { turnId } : {}),
      eventType,
      schemaVersion: 1,
      priority: eventType === "run.result.proposed" ? 0 : 1,
      emittedAt: new Date(Date.UTC(2026, 7, 27, 12, 0, sourceSeq)).toISOString(),
      payload,
    });

    return {
      ids: () => ({
        driverSessionId: "driver-trace",
        providerSessionId: "provider-trace",
      }),
      events: async function* () {
        await started;
        for (const candidate of events) yield structuredClone(candidate);
      },
      startTurn: async () => {
        events.push(
          event(1, "session.started", { context }, false),
          event(2, "turn.started", {}),
          event(3, "run.result.proposed", completedResult()),
          event(4, "turn.completed", {}),
        );
        releaseEvents?.();
        return { turnId };
      },
      snapshot: async () => ({
        driverKind: "codex-trace-fixture",
        driverSessionId: "driver-trace",
        providerSessionId: "provider-trace",
        runId: input.runId,
        normalizedSessionId: input.normalizedSessionId,
        activeTurnId: null,
        lastSourceSequence: 4,
      }),
      close: async () => undefined,
    };
  }
}

describe("Codex trace conformance", () => {
  it("accepts only results that satisfy the exact controller envelope", () => {
    expect(validateCodexResultProposal(completedResult(), envelope)).toMatchObject({
      status: "accepted",
    });

    const wrongRevision = completedResult();
    wrongRevision.completionClaim.contractRevision = "wrong-revision";
    expect(validateCodexResultProposal(wrongRevision, envelope)).toMatchObject({
      status: "rejected",
      issues: [{ code: "contract_revision_mismatch" }],
    });

    const unknownCriterion = completedResult();
    unknownCriterion.completionClaim.criteria = [{
      criterionId: "not-in-envelope",
      status: "satisfied",
      evidenceRefs: [],
    }];
    const decision = validateCodexResultProposal(unknownCriterion, envelope);
    expect(decision).toMatchObject({ status: "rejected" });
    if (decision.status === "rejected") {
      expect(decision.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["unknown_criterion", "missing_criterion"]),
      );
    }
  });

  it("loads the checked-in provider conformance fixture through validation", async () => {
    const fixturePath = fileURLToPath(new URL(
      "../../protocol/fixtures/codex-driver/driver-conformance.json",
      import.meta.url,
    ));
    await expect(loadLiveConsoleConformanceFixture(fixturePath)).resolves.toMatchObject({
      schema: "paperclip.runner.live-console.conformance.v1",
      runtimeRequests: expect.arrayContaining([
        expect.objectContaining({ requestKind: "user_input" }),
      ]),
      reconnect: { lastSourceSequence: 17 },
    });
  });

  it("rejects malformed goal and control declarations in the fixture", async () => {
    const fixturePath = fileURLToPath(new URL(
      "../../protocol/fixtures/codex-driver/driver-conformance.json",
      import.meta.url,
    ));
    const source = JSON.parse(await readFile(fixturePath, "utf8"));
    const directory = await mkdtemp(join(tmpdir(), "paperclip-live-fixture-"));
    const candidatePath = join(directory, "candidate.json");
    try {
      source.goals[0].method = "thread/goal/wrong";
      await writeFile(candidatePath, JSON.stringify(source));
      await expect(loadLiveConsoleConformanceFixture(candidatePath))
        .rejects.toThrow("invalid goal operation");

      source.goals[0].method = "thread/goal/get";
      source.controls.sameTurnSteer.expected = 42;
      await writeFile(candidatePath, JSON.stringify(source));
      await expect(loadLiveConsoleConformanceFixture(candidatePath))
        .rejects.toThrow("controls are invalid");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("executes live trace and persisted replay with controller-owned terminal facts", async () => {
    const trace = await runCodexCodexTracer({
      driver: new TraceConformanceDriver(),
      taskEnvelope: envelope,
      workingDirectory: "/trace-workspace",
      timeoutMs: 1_000,
    });

    expect(trace.resultDecision.status).toBe("accepted");
    expect(trace.events.filter((event) => event.eventType === "run.terminal"))
      .toHaveLength(1);
    expect(trace.assertions).toEqual({
      exactlyOneTerminalResult: true,
      proposalAccepted: true,
      liveReplayParity: true,
      stableIdentity: true,
      sourceSequenceContinuous: true,
      stableItemIdentity: true,
      contextIsSkillless: true,
      unrelatedSkillsAbsent: true,
      credentialsAbsent: true,
    });
    expect(trace.replaySnapshot).toEqual(trace.liveSnapshot);
  });
});
