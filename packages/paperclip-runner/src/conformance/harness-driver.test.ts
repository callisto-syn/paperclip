import { describe, expect, it } from "vitest";

import { DeterministicHarnessDriver } from "../mock-core/deterministic-harness-driver.js";
import {
  loadHarnessDriverConformanceFixture,
  runHarnessDriverConformance,
} from "./harness-driver.js";

describe("harness-driver conformance V1", () => {
  it("ships a deterministic fixture covering the complete Evals hook set", async () => {
    const fixture = await loadHarnessDriverConformanceFixture();
    expect(fixture.requiredCapabilities).toContain("dynamicTools");
    expect(fixture.unsupportedFeatures).toContain("steering");

    const report = await runHarnessDriverConformance({
      driver: new DeterministicHarnessDriver(),
      fixture,
    });
    expect(report).toMatchObject({
      schema: "paperclip-runner/harness-driver-conformance-report/v1",
      contractVersion: 1,
      eventCount: 7,
      semanticToolCallCount: 1,
      checks: {
        capabilityDescription: true,
        configValidation: true,
        sessionLifecycle: true,
        sessionRecovery: true,
        semanticTools: true,
        eventValidation: true,
        interruptAndCancel: true,
        usage: true,
        transcriptCompleteness: true,
        unsupportedFeatures: true,
      },
    });
  });

  it("recovers an active turn with its source cursor and interruption state", async () => {
    const driver = new DeterministicHarnessDriver();
    const session = await driver.openSession({
      runId: "run_active_recovery",
      normalizedSessionId: "session_active_recovery",
      workingDirectory: "/deterministic/conformance",
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "[conformance:interrupt]" },
    });
    const snapshot = await session.snapshot();
    expect(snapshot).toMatchObject({ activeTurnId: turnId, lastSourceSequence: 2 });

    const recovery = await driver.recoverSession(snapshot);
    expect(recovery.recovered).toBe(true);
    expect(recovery.session).toBeDefined();
    const recovered = recovery.session!;
    await expect(recovered.interrupt?.({
      turnId,
      reason: "recovered_interrupt",
    })).resolves.toBeUndefined();

    const events = [];
    for await (const event of recovered.events()) events.push(event);
    expect(events.map((event) => [event.sourceSeq, event.eventType])).toEqual([
      [3, "turn.interrupted"],
      [4, "run.terminal"],
    ]);
    await recovered.close({ reason: "recovered_complete" });
    await session.close({ reason: "original_complete", force: true });
  });
});
