import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createCodexTaskEnvelope } from "../contracts/codex.js";
import type { PrpStructuredRunResult } from "../protocol/replay-contract.js";
import { loadLiveConsoleConformanceFixture } from "../protocol/live-console-fixture.js";
import { validateCodexResultProposal } from "./codex-runner.js";

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
});
