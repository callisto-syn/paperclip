import { describe, expect, it } from "vitest";

import type { HarnessRuntimeRequest } from "../../contracts/harness-driver.js";
import {
  hasCodexQuestionForm,
  normalizeCodexQuestionSet,
  runtimeRequestKind,
  runtimeRequestProtocolPayload,
  runtimeRequestResponse,
} from "./codex-question-adapter.js";

describe("Codex structured question adapter", () => {
  it("normalizes requestUserInput without inventing required answers", () => {
    const questions = normalizeCodexQuestionSet("item/tool/requestUserInput", {
      title: "Deployment",
      questions: [
        {
          id: "environment",
          header: "Target",
          question: "Where should we deploy?",
          options: [
            { id: "staging", label: "Staging", description: "Safe first step" },
            { id: "production", label: "Production" },
          ],
        },
        {
          id: "regions",
          question: "Which regions?",
          multiSelect: true,
          options: [{ id: "us", label: "US" }, { id: "eu", label: "EU" }],
          required: true,
        },
        {
          id: "notes",
          question: "Anything else?",
          minLength: 2,
          maxLength: 500,
        },
      ],
    });

    expect(questions).toMatchObject({
      schema: "paperclip.question_set.v1",
      title: "Deployment",
      questions: [
        { id: "environment", required: false, answerMode: "single_select" },
        { id: "regions", required: true, answerMode: "multi_select" },
        {
          id: "notes",
          required: false,
          answerMode: "text",
          textValidation: { minLength: 2, maxLength: 500 },
        },
      ],
    });
    expect(runtimeRequestKind("item/tool/requestUserInput")).toBe("user_input");
    expect(hasCodexQuestionForm("item/tool/requestUserInput", { questions: [] })).toBe(true);
  });

  it("fails closed on a malformed native question form", () => {
    expect(() => normalizeCodexQuestionSet("tool/requestUserInput", {
      questions: [
        { id: "duplicate", question: "First?" },
        { id: "duplicate", question: "Second?" },
      ],
    })).toThrow("must be unique");
  });

  it("fails closed instead of truncating oversized native forms", () => {
    expect(() => normalizeCodexQuestionSet("tool/requestUserInput", {
      questions: Array.from({ length: 65 }, (_, index) => ({
        id: `question-${index}`,
        question: `Question ${index}`,
      })),
    })).toThrow("Codex question form exceeds 64 questions");

    expect(() => normalizeCodexQuestionSet("tool/requestUserInput", {
      questions: [{
        id: "oversized-options",
        question: "Choose one",
        options: Array.from({ length: 129 }, (_, index) => ({
          id: `option-${index}`,
          label: `Option ${index}`,
        })),
      }],
    })).toThrow("Codex question exceeds 128 options");

    expect(() => normalizeCodexQuestionSet("tool/requestUserInput", {
      questions: [{
        id: "q".repeat(161),
        question: "Choose one",
      }],
    })).toThrow("Codex question identifier exceeds 160 characters");

    expect(() => normalizeCodexQuestionSet("mcpServer/elicitation/request", {
      requestedSchema: {
        type: "object",
        properties: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [
          `property-${index}`,
          { type: "string" },
        ])),
      },
    })).toThrow("Codex question form exceeds 64 questions");
  });

  it("maps canonical answers back to Codex user-input and elicitation shapes", () => {
    const input = normalizeCodexQuestionSet("tool/requestUserInput", {
      questions: [{
        id: "environment",
        question: "Where?",
        options: [{ id: "staging", label: "Staging" }],
      }],
    })!;
    const request: HarnessRuntimeRequest = {
      requestId: "request-1",
      requestKind: "user_input",
      method: "tool/requestUserInput",
      turnId: "turn-1",
      itemId: "item-1",
      status: "pending",
      prompt: "Codex requests user input.",
      details: {},
      input,
      origin: { adapter: "codex", method: "tool/requestUserInput" },
    };
    const response = {
      schema: "paperclip.question_response.v1" as const,
      answers: { environment: { selectedOptionIds: ["staging"] } },
    };

    expect(runtimeRequestResponse(request, { action: "submit", response })).toEqual({
      answers: { environment: { answers: ["Staging"] } },
    });
    expect(runtimeRequestProtocolPayload(request)).toMatchObject({
      schema: "paperclip.runtime_request.v2",
      requestKind: "runtime",
      requestId: "request-1",
      type: "input",
      input,
    });

    const elicitationInput = normalizeCodexQuestionSet("mcpServer/elicitation/request", {
      requestedSchema: {
        type: "object",
        properties: {
          retries: { type: "integer", title: "Retries", minimum: 0, maximum: 5 },
          enabled: { type: "boolean", title: "Enabled" },
        },
        required: ["retries"],
      },
    })!;
    const elicitationRequest: HarnessRuntimeRequest = {
      ...request,
      requestId: "request-2",
      requestKind: "elicitation",
      method: "mcpServer/elicitation/request",
      details: {
        requestedSchema: {
          type: "object",
          properties: {
            retries: { type: "integer" },
            enabled: { type: "boolean" },
          },
        },
      },
      input: elicitationInput,
    };
    expect(runtimeRequestResponse(elicitationRequest, {
      action: "submit",
      response: {
        schema: "paperclip.question_response.v1",
        answers: {
          retries: { text: "3" },
          enabled: { selectedOptionIds: ["true"] },
        },
      },
    })).toEqual({
      action: "accept",
      content: { retries: 3, enabled: true },
      _meta: null,
    });
  });
});
