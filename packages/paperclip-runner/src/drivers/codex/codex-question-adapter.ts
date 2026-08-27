import type {
  HarnessRuntimeRequest,
  HarnessRuntimeRequestKind,
  HarnessRuntimeRequestResolution,
  PaperclipQuestion,
  PaperclipQuestionResponse,
  PaperclipQuestionSet,
} from "../../contracts/harness-driver.js";
import {
  PAPERCLIP_QUESTION_SET_SCHEMA,
  PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2,
  parsePaperclipQuestionSet,
} from "../../contracts/harness-driver.js";
import { redactCodexDiagnostic } from "./app-server-transport.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function boundedText(
  value: unknown,
  fallback = "unknown",
  maxCharacters = 1024,
): string {
  const candidate = text(value, fallback);
  return candidate.length <= maxCharacters
    ? candidate
    : `${candidate.slice(0, maxCharacters)}...[truncated]`;
}

export function runtimeRequestKind(method: string): HarnessRuntimeRequestKind | null {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "execCommandApproval"
  ) {
    return "command_approval";
  }
  if (
    method === "item/fileChange/requestApproval" ||
    method === "applyPatchApproval"
  ) {
    return "file_approval";
  }
  if (method === "item/permissions/requestApproval")
    return "permission_approval";
  if (
    method === "item/tool/requestUserInput" ||
    method === "tool/requestUserInput"
  ) {
    return "user_input";
  }
  if (method === "mcpServer/elicitation/request") return "elicitation";
  return null;
}

/**
 * During the v1 migration, input requests that predate structured form data
 * remain opaque runtime requests. Once a provider supplies a native form,
 * however, a malformed/unsupported form must fail closed instead of silently
 * degrading back to the legacy textarea presentation.
 */
export function hasCodexQuestionForm(method: string, params: Record<string, unknown>): boolean {
  if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
    return "questions" in params;
  }
  if (method === "mcpServer/elicitation/request") {
    return "requestedSchema" in params || "schema" in params;
  }
  return false;
}

export function runtimeRequestPrompt(
  kind: HarnessRuntimeRequestKind,
  params: Record<string, unknown>,
): string {
  const reason = text(params.reason, text(params.message));
  if (reason.length > 0) return boundedText(redactCodexDiagnostic(reason));
  const labels: Record<HarnessRuntimeRequestKind, string> = {
    command_approval: "Codex requests approval to run a command.",
    file_approval: "Codex requests approval to change files.",
    permission_approval: "Codex requests additional runtime permissions.",
    user_input: "Codex requests user input.",
    elicitation: "A tool requests structured user input.",
  };
  return labels[kind];
}

function stableQuestionId(value: unknown, index: number): string {
  const candidate = text(value).trim();
  return candidate.length > 0 ? candidate.slice(0, 160) : `question-${index + 1}`;
}

function codexOptions(value: unknown): NonNullable<PaperclipQuestion["options"]> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 128).map((rawOption, index) => {
    const option = record(rawOption);
    const label = text(option.label, text(option.value, text(rawOption))).slice(0, 1_000);
    return {
      id: stableQuestionId(option.id, index).replace(/^question-/, "option-"),
      label: label || `Option ${index + 1}`,
      ...(text(option.description).length > 0
        ? { description: boundedText(redactCodexDiagnostic(text(option.description))) }
        : {}),
    };
  });
}

function jsonSchemaOptions(schema: Record<string, unknown>): NonNullable<PaperclipQuestion["options"]> {
  const values = Array.isArray(schema.enum)
    ? schema.enum
    : Array.isArray(schema.oneOf)
      ? schema.oneOf.map((entry) => record(entry).const)
      : [];
  return values.slice(0, 128).map((value, index) => {
    const oneOf = Array.isArray(schema.oneOf) ? record(schema.oneOf[index]) : {};
    return {
      id: `option-${index + 1}`,
      label: text(oneOf.title, typeof value === "string" ? value : JSON.stringify(value)).slice(0, 1_000),
      ...(text(oneOf.description).length > 0
        ? { description: boundedText(text(oneOf.description)) }
        : {}),
    };
  });
}

/** Codex-native requests are converted once, before they enter PRP. */
export function normalizeCodexQuestionSet(method: string, params: Record<string, unknown>): PaperclipQuestionSet | null {
  if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
    if (!Array.isArray(params.questions) || params.questions.length === 0) return null;
    const questions = params.questions.slice(0, 64).map((rawQuestion, index): PaperclipQuestion => {
      const question = record(rawQuestion);
      const options = codexOptions(question.options);
      return {
        id: stableQuestionId(question.id, index),
        ...(text(question.header).length > 0 ? { header: boundedText(text(question.header), "", 1_000) } : {}),
        prompt: boundedText(text(question.question, text(question.prompt, `Question ${index + 1}`))),
        ...(text(question.description).length > 0 ? { helpText: boundedText(text(question.description)) } : {}),
        // Codex requestUserInput questions do not normally declare requiredness.
        // Do not invent a required constraint when the provider omitted one.
        required: question.required === true,
        answerMode: options && options.length > 0
          ? question.multiSelect === true || question.multiple === true ? "multi_select" : "single_select"
          : "text",
        ...(options && options.length > 0 ? { options } : {}),
        ...(question.isOther === true || question.allowOther === true
          ? { customAnswer: { enabled: true, label: "Other", placeholder: "Enter another answer" } }
          : {}),
        ...(!(options && options.length > 0) && (typeof question.minLength === "number" || typeof question.maxLength === "number")
          ? { textValidation: {
              ...(typeof question.minLength === "number" ? { minLength: question.minLength } : {}),
              ...(typeof question.maxLength === "number" ? { maxLength: question.maxLength } : {}),
            } }
          : {}),
      };
    });
    return parsePaperclipQuestionSet({
      schema: PAPERCLIP_QUESTION_SET_SCHEMA,
      title: text(params.title, "Codex needs your input"),
      ...(text(params.description).length > 0 ? { description: boundedText(text(params.description)) } : {}),
      submitLabel: text(params.submitLabel, "Submit answers"),
      questions,
    });
  }
  if (method !== "mcpServer/elicitation/request") return null;
  const requestedSchema = record(params.requestedSchema ?? params.schema);
  const properties = record(requestedSchema.properties);
  const required = new Set(Array.isArray(requestedSchema.required) ? requestedSchema.required.filter((entry): entry is string => typeof entry === "string") : []);
  const questions = Object.entries(properties).slice(0, 64).map(([id, rawProperty]): PaperclipQuestion => {
    const property = record(rawProperty);
    const propertyType = text(property.type);
    const itemSchema = record(property.items);
    const selectSchema = propertyType === "array" ? itemSchema : property;
    const options = propertyType === "boolean"
      ? [{ id: "true", label: "Yes" }, { id: "false", label: "No" }]
      : jsonSchemaOptions(selectSchema);
    const answerMode: PaperclipQuestion["answerMode"] = propertyType === "array" && options.length > 0
      ? "multi_select"
      : options.length > 0
        ? "single_select"
        : "text";
    const inputType = propertyType === "integer" ? "integer" : propertyType === "number" ? "number" : "text";
    return {
      id,
      ...(text(property.title).length > 0 ? { header: boundedText(text(property.title), "", 1_000) } : {}),
      prompt: boundedText(text(property.title, id)),
      ...(text(property.description).length > 0 ? { helpText: boundedText(text(property.description)) } : {}),
      required: required.has(id),
      answerMode,
      ...(options.length > 0 ? { options } : {}),
      ...(answerMode === "text" ? { textValidation: {
        inputType,
        ...(typeof property.minLength === "number" ? { minLength: property.minLength } : {}),
        ...(typeof property.maxLength === "number" ? { maxLength: property.maxLength } : {}),
        ...(typeof property.minimum === "number" ? { minimum: property.minimum } : {}),
        ...(typeof property.maximum === "number" ? { maximum: property.maximum } : {}),
        ...(typeof property.pattern === "string" ? { pattern: property.pattern } : {}),
      } } : {}),
    };
  });
  if (questions.length === 0) return null;
  return parsePaperclipQuestionSet({
    schema: PAPERCLIP_QUESTION_SET_SCHEMA,
    title: "A tool needs your input",
    ...(text(params.message).length > 0 ? { description: boundedText(text(params.message)) } : {}),
    submitLabel: "Submit",
    questions,
  });
}

export function runtimeRequestProtocolPayload(request: HarnessRuntimeRequest): Record<string, unknown> {
  if (request.input !== undefined) {
    return {
      schema: PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2,
      requestKind: "runtime",
      requestId: request.requestId,
      type: "input",
      status: request.status,
      prompt: request.prompt,
      input: structuredClone(request.input),
      origin: structuredClone(request.origin),
      turnId: request.turnId,
      itemId: request.itemId,
    };
  }
  return { ...request, type: request.method };
}

function canonicalCodexAnswers(
  request: HarnessRuntimeRequest,
  response: PaperclipQuestionResponse,
): Record<string, { answers: string[] }> {
  const result: Record<string, { answers: string[] }> = {};
  for (const question of request.input?.questions ?? []) {
    const answer = response.answers[question.id];
    if (answer === undefined) continue;
    const labels = (answer.selectedOptionIds ?? []).map((optionId) =>
      question.options?.find((option) => option.id === optionId)?.label,
    ).filter((label): label is string => typeof label === "string");
    if (answer.text !== undefined) labels.push(answer.text);
    if (answer.customText !== undefined) labels.push(answer.customText);
    result[question.id] = { answers: labels };
  }
  return result;
}

function jsonSchemaOptionValue(schema: Record<string, unknown>, optionId: string): unknown {
  if (optionId === "true") return true;
  if (optionId === "false") return false;
  const index = Number(optionId.match(/^option-(\d+)$/)?.[1] ?? "0") - 1;
  if (index < 0) return optionId;
  if (Array.isArray(schema.enum)) return schema.enum[index];
  if (Array.isArray(schema.oneOf)) return record(schema.oneOf[index]).const;
  return optionId;
}

function canonicalElicitationContent(
  request: HarnessRuntimeRequest,
  response: PaperclipQuestionResponse,
): Record<string, unknown> {
  const requestedSchema = record(request.details.requestedSchema ?? request.details.schema);
  const properties = record(requestedSchema.properties);
  const content: Record<string, unknown> = {};
  for (const question of request.input?.questions ?? []) {
    const answer = response.answers[question.id];
    if (answer === undefined) continue;
    const property = record(properties[question.id]);
    const itemSchema = record(property.items);
    if (question.answerMode === "text") {
      const value = answer.text ?? "";
      content[question.id] = property.type === "integer" || property.type === "number" ? Number(value) : value;
    } else if (question.answerMode === "multi_select") {
      content[question.id] = (answer.selectedOptionIds ?? []).map((optionId) => jsonSchemaOptionValue(itemSchema, optionId));
    } else {
      const optionId = answer.selectedOptionIds?.[0];
      if (optionId !== undefined) content[question.id] = jsonSchemaOptionValue(property, optionId);
      else if (answer.customText !== undefined) content[question.id] = answer.customText;
    }
  }
  return content;
}

/**
 * Maps an already-validated resolution onto the provider's response shape.
 * `parseHarnessRuntimeRequestResolution` is the only gate on shape, so every
 * branch here answers a resolution the request kind actually accepts.
 */
export function runtimeRequestResponse(
  request: HarnessRuntimeRequest,
  resolution: HarnessRuntimeRequestResolution,
): Record<string, unknown> {
  if (
    request.requestKind === "command_approval" ||
    request.requestKind === "file_approval"
  ) {
    if (resolution.action === "submit") {
      throw new Error(
        `${request.requestKind} does not accept submitted form data`,
      );
    }
    const decisions = {
      accept: "accept",
      accept_for_session: "acceptForSession",
      decline: "decline",
      cancel: "cancel",
    } as const;
    return { decision: decisions[resolution.action] };
  }
  if (request.requestKind === "permission_approval") {
    if (resolution.action === "submit") {
      throw new Error(
        "permission approval does not accept submitted form data",
      );
    }
    return {
      permissions: {},
      scope: resolution.action === "accept_for_session" ? "session" : "turn",
    };
  }
  if (request.requestKind === "user_input") {
    if (resolution.action === "submit" && "response" in resolution) {
      return { answers: canonicalCodexAnswers(request, resolution.response) };
    }
    if (resolution.action !== "submit" || !("answers" in resolution)) {
      // Declines and cancels are the only non-submit answers the validator
      // lets through, and neither carries form data.
      return { answers: {} };
    }
    return { answers: structuredClone(resolution.answers) };
  }
  if (resolution.action === "submit" && "response" in resolution) {
    return {
      action: "accept",
      content: canonicalElicitationContent(request, resolution.response),
      _meta: null,
    };
  }
  if (resolution.action === "submit" && "content" in resolution) {
    return {
      action: "accept",
      content: structuredClone(resolution.content),
      _meta: null,
    };
  }
  if (
    resolution.action === "submit" ||
    resolution.action === "accept_for_session"
  ) {
    throw new Error("elicitation submissions require content");
  }
  return { action: resolution.action, content: null, _meta: null };
}

