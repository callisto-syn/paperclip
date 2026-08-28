import { createHash, randomBytes } from "node:crypto";

import type { AcpRuntimeEvent } from "acpx/runtime";

import {
  PRP_BLOCK_TOOL_NAME,
  PRP_COMPLETION_TOOL_NAME,
} from "../../contracts/completion-result.js";
import {
  HarnessCapabilityUnavailableError,
  HarnessStaleTurnError,
  type HarnessDriver,
  type HarnessDriverConfigValidation,
  type HarnessDriverDescriptor,
  type HarnessSession,
  type HarnessTranscriptSnapshot,
  type OpenHarnessSessionInput,
  type PersistedHarnessSession,
} from "../../contracts/harness-driver.js";
import type { NativeAcpxPermissionMode } from "../../contracts/native-execution.js";
import type { NativeUserMessage } from "../../contracts/types.js";
import type {
  PrpEvent,
  PrpStructuredRunResult,
} from "../../protocol/replay-contract.js";
import { validatePrpStructuredRunResult } from "../../protocol/replay-contract.js";
import {
  canonicalProviderEventsFromAcpxRuntimeEvent,
  createAcpxToolEventNormalizer,
} from "../../provider-events.js";
import {
  canonicalRunnerToolName,
  type RunnerToolCall,
} from "../runner-tool-bridge.js";
import { openCodexAcpxRuntime } from "./codex-runtime-adapter.js";
import {
  acpxDriverDescriptor,
  validateAcpxDriverConfig,
} from "./driver-profile.js";
import {
  AcpxRuntimeHost,
  type AcpxRuntimeTurn,
  type OpenAcpxRuntimeHostOptions,
} from "./runtime-host.js";

const MAX_BUFFERED_EVENTS = 512;
const MAX_TRANSCRIPT_EVENTS = 1_024;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const CLOSE_TURN_SETTLEMENT_TIMEOUT_MS = 2_000;

export interface CodexAcpxDynamicToolCall {
  tool: string;
  callId: string;
  providerSessionId: string;
  turnId: string;
  arguments: unknown;
  signal: AbortSignal;
}

export interface CodexAcpxDriverOptions {
  runtimeDirectory: string;
  model: string;
  permissionMode?: NativeAcpxPermissionMode;
  systemInstructions?: string;
  environment?: NodeJS.ProcessEnv;
  managedCodexCredentialSourcePath?: string;
  dynamicTools?: readonly Readonly<Record<string, unknown>>[];
  dynamicToolHandler?: (call: CodexAcpxDynamicToolCall) => Promise<unknown>;
  now?: () => Date;
}

interface CodexAcpxHost {
  identity(): ReturnType<AcpxRuntimeHost["identity"]>;
  binding(): ReturnType<AcpxRuntimeHost["binding"]>;
  status(): ReturnType<AcpxRuntimeHost["status"]>;
  startTurn(
    input: Parameters<AcpxRuntimeHost["startTurn"]>[0],
  ): AcpxRuntimeTurn;
  interruptActiveTurn(reason: string): Promise<void>;
  close(input: { reason: string }): Promise<void>;
}

export interface CodexAcpxDriverDependencies {
  openHost?: (options: OpenAcpxRuntimeHostOptions) => Promise<CodexAcpxHost>;
  /** Internal test seam; production uses the fixed close-settlement bound. */
  closeSettlementTimeoutMs?: number;
  /** Internal test seam; production uses the fixed event-retention bound. */
  maxBufferedEvents?: number;
}

/** Codex-only HarnessDriver backed by the admitted ACPX runtime host. */
export class CodexAcpxDriver implements HarnessDriver {
  readonly #options: CodexAcpxDriverOptions;
  readonly #openHost: NonNullable<CodexAcpxDriverDependencies["openHost"]>;
  readonly #closeSettlementTimeoutMs: number;
  readonly #maxBufferedEvents: number;

  constructor(
    options: CodexAcpxDriverOptions,
    dependencies: CodexAcpxDriverDependencies = {},
  ) {
    this.#options = {
      ...options,
      ...(options.environment
        ? { environment: { ...options.environment } }
        : {}),
      ...(options.dynamicTools
        ? { dynamicTools: structuredClone(options.dynamicTools) }
        : {}),
    };
    this.#openHost =
      dependencies.openHost ??
      ((hostOptions) =>
        AcpxRuntimeHost.open(hostOptions, {
          openRuntime: openCodexAcpxRuntime,
        }));
    this.#closeSettlementTimeoutMs =
      dependencies.closeSettlementTimeoutMs ?? CLOSE_TURN_SETTLEMENT_TIMEOUT_MS;
    this.#maxBufferedEvents = Math.max(
      1,
      Math.floor(dependencies.maxBufferedEvents ?? MAX_BUFFERED_EVENTS),
    );
  }

  async descriptor(): Promise<HarnessDriverDescriptor> {
    const descriptor = acpxDriverDescriptor("codex");
    return {
      ...descriptor,
      displayName: "Codex via ACPX",
      runtimeContextCapabilities: {
        instructions: "native",
        skills: "unsupported",
        mcp: "native",
      },
      capabilities: {
        ...descriptor.capabilities,
        resume: false,
        runtimeRequestResolution: false,
        runtimeRequestHandoff: false,
        unsupported: [
          "resume",
          "steering",
          "runtimeRequestResolution",
          "runtimeRequestHandoff",
          "goals",
          "threadLineage",
        ],
      },
    };
  }

  async validateConfig(value: unknown): Promise<HarnessDriverConfigValidation> {
    const validation = validateAcpxDriverConfig(value);
    if (!validation.ok || validation.config.agent === "codex")
      return validation;
    return {
      ok: false,
      config: null,
      issues: [
        {
          path: "agent",
          code: "unsupported_agent",
          message: "The production ACPX driver currently supports Codex only.",
        },
      ],
    };
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    let session: CodexAcpxSession | null = null;
    const host = await this.#openHost({
      runtimeDirectory: this.#options.runtimeDirectory,
      normalizedSessionId: input.normalizedSessionId,
      workingDirectory: input.workingDirectory,
      agent: "codex",
      model: this.#options.model,
      permissionMode: this.#options.permissionMode ?? "approve-reads",
      systemInstructions: this.#options.systemInstructions,
      environment: this.#options.environment,
      managedCodexCredentialSourcePath:
        this.#options.managedCodexCredentialSourcePath,
      semanticTools: {
        tools: this.#options.dynamicTools ?? [],
        handler: (call) => {
          if (!session) {
            throw new Error("Codex ACPX session is not ready for tool calls");
          }
          return session.dispatchTool(call);
        },
      },
    });
    try {
      session = new CodexAcpxSession({
        host,
        input,
        dynamicToolHandler: this.#options.dynamicToolHandler,
        now: this.#options.now ?? (() => new Date()),
        closeSettlementTimeoutMs: this.#closeSettlementTimeoutMs,
        maxBufferedEvents: this.#maxBufferedEvents,
      });
      return session;
    } catch (error) {
      await host
        .close({ reason: "Codex ACPX session initialization failed" })
        .catch(() => undefined);
      throw error;
    }
  }
}

class CodexAcpxSession implements HarnessSession {
  readonly #host: CodexAcpxHost;
  readonly #input: OpenHarnessSessionInput;
  readonly #dynamicToolHandler?: CodexAcpxDriverOptions["dynamicToolHandler"];
  readonly #now: () => Date;
  readonly #closeSettlementTimeoutMs: number;
  readonly #maxBufferedEvents: number;
  readonly #events: AsyncQueue<PrpEvent>;
  readonly #transcript: Array<{ event: PrpEvent; bytes: number }> = [];
  readonly #terminalTurns = new Map<string, string>();
  readonly #sourceInstanceId: string;
  #sourceSequence = 0;
  #activeTurnId: string | null = null;
  #semanticResult: PrpStructuredRunResult | null = null;
  #semanticFingerprint: string | null = null;
  #semanticCallId: string | null = null;
  #semanticTurnId: string | null = null;
  #usage: Record<string, unknown> | null = null;
  #assistantText = "";
  #closed = false;
  #closingStarted = false;
  #eventStreamClosed = false;
  #activePump: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #hostClosePromise: Promise<void> | null = null;
  #transcriptBytes = 0;
  #transcriptEventCount = 0;
  #transcriptOmitted = false;
  #eventStreamOmitted = false;

  constructor(input: {
    host: CodexAcpxHost;
    input: OpenHarnessSessionInput;
    dynamicToolHandler?: CodexAcpxDriverOptions["dynamicToolHandler"];
    now: () => Date;
    closeSettlementTimeoutMs: number;
    maxBufferedEvents: number;
  }) {
    const identity = input.host.identity();
    if (identity.normalizedSessionId !== input.input.normalizedSessionId) {
      throw new Error("Codex ACPX host returned a different session identity");
    }
    this.#host = input.host;
    this.#input = structuredClone(input.input);
    this.#dynamicToolHandler = input.dynamicToolHandler;
    this.#now = input.now;
    this.#closeSettlementTimeoutMs = input.closeSettlementTimeoutMs;
    this.#maxBufferedEvents = input.maxBufferedEvents;
    this.#events = new AsyncQueue<PrpEvent>(
      input.maxBufferedEvents,
      isCriticalBufferedEvent,
      (event) => isTerminalEvent(event.eventType),
    );
    this.#sourceInstanceId = stableId(
      "paperclip-acpx",
      input.input.normalizedSessionId,
    );
  }

  ids() {
    const identity = this.#host.identity();
    return {
      driverSessionId: identity.acpxRecordId,
      providerSessionId: identity.agentSessionId,
      displayId: identity.agentSessionId,
    };
  }

  events(): AsyncIterable<PrpEvent> {
    return this.#events;
  }

  async startTurn(input: {
    message: NativeUserMessage;
  }): Promise<{ turnId: string }> {
    this.#assertOpen();
    if (this.#activeTurnId) {
      throw new Error("Codex ACPX session already has an active turn");
    }
    if (this.#terminalTurns.size >= this.#maxBufferedEvents) {
      throw new HarnessCapabilityUnavailableError(
        "turn.start",
        "the bounded session turn limit was reached; open a new session",
      );
    }
    const turnId = `turn-${randomBytes(12).toString("hex")}`;
    this.#activeTurnId = turnId;
    this.#assistantText = "";
    this.#emit("turn.submitted", { text: input.message.text }, { turnId });
    this.#emit("turn.accepted", { turnId }, { turnId });
    this.#emit("turn.started", { status: "inProgress" }, { turnId });
    let turn: AcpxRuntimeTurn;
    try {
      turn = this.#host.startTurn({
        text: input.message.text,
        requestId: `${safeId(this.#input.runId, "run")}:${turnId}`,
      });
    } catch (error) {
      this.#activeTurnId = null;
      this.#emit(
        "turn.failed",
        { status: "failed", error: { message: safeMessage(error) } },
        { turnId },
      );
      throw error;
    }
    const pump = this.#pumpTurn(turnId, turn);
    this.#activePump = pump;
    void pump
      .finally(() => {
        if (this.#activePump === pump) this.#activePump = null;
      })
      .catch(() => undefined);
    return { turnId };
  }

  async interrupt(input: { turnId?: string; reason?: string }): Promise<void> {
    this.#assertOpen();
    if (input.turnId && input.turnId !== this.#activeTurnId) {
      throw new HarnessStaleTurnError(input.turnId);
    }
    if (!this.#activeTurnId) {
      throw new HarnessCapabilityUnavailableError(
        "interruption",
        "there is no active Codex ACPX turn",
      );
    }
    await this.#host.interruptActiveTurn(input.reason ?? "interrupted");
  }

  async dispatchTool(call: RunnerToolCall): Promise<unknown> {
    this.#assertOpen();
    const turnId = this.#activeTurnId;
    if (!turnId) {
      throw new Error("Codex ACPX tool call is not bound to an active turn");
    }
    const tool = canonicalRunnerToolName(call.tool);
    if (tool === PRP_COMPLETION_TOOL_NAME || tool === PRP_BLOCK_TOOL_NAME) {
      const validation = validatePrpStructuredRunResult(call.arguments);
      if (!validation.ok) throw new Error("Invalid semantic run result");
      const blocked = validation.result.reportedWorkDisposition === "blocked";
      if (
        (tool === PRP_BLOCK_TOOL_NAME && !blocked) ||
        (tool === PRP_COMPLETION_TOOL_NAME && blocked)
      ) {
        throw new Error(
          "Semantic result disposition does not match the terminal tool",
        );
      }
      const fingerprint = canonicalJson(validation.result);
      if (
        this.#semanticFingerprint !== null &&
        this.#semanticFingerprint !== fingerprint
      ) {
        throw new Error("A different semantic result is already committed");
      }
      if (this.#semanticFingerprint === null) {
        this.#semanticResult = structuredClone(validation.result);
        this.#semanticFingerprint = fingerprint;
        this.#semanticCallId = call.callId;
        this.#semanticTurnId = turnId;
        this.#emit("run.result.proposed", validation.result, {
          turnId,
          itemId: call.callId,
        });
      }
      return { accepted: true };
    }
    if (!this.#dynamicToolHandler) {
      throw new Error(`Unsupported Paperclip operation ${tool}`);
    }
    return await this.#dynamicToolHandler({
      tool,
      callId: call.callId,
      providerSessionId: this.#host.identity().agentSessionId,
      turnId,
      arguments: structuredClone(call.arguments),
      signal: call.signal,
    });
  }

  async read(): Promise<Record<string, unknown>> {
    return {
      identity: this.#host.identity(),
      binding: this.#host.binding(),
      status: await this.#host.status(),
    };
  }

  async reconcile(): Promise<Record<string, unknown>> {
    const identity = this.#host.identity();
    const status = await this.#host.status();
    if (
      status.agentSessionId &&
      status.agentSessionId !== identity.agentSessionId
    ) {
      throw new Error("ACPX reconciliation changed the provider session");
    }
    return { identity, status };
  }

  async usage(): Promise<Record<string, unknown> | null> {
    return this.#usage === null ? null : structuredClone(this.#usage);
  }

  async transcript(): Promise<HarnessTranscriptSnapshot> {
    return {
      schema: "paperclip-runner/harness-transcript/v1",
      complete: !this.#transcriptOmitted,
      eventCount: this.#transcriptEventCount,
      events: structuredClone(this.#transcript.map(({ event }) => event)),
      omissionReason: this.#transcriptOmitted ? "retention_limit" : null,
    };
  }

  async snapshot(): Promise<PersistedHarnessSession> {
    const identity = this.#host.identity();
    return {
      driverKind: "acpx_runtime",
      driverSessionId: identity.acpxRecordId,
      providerSessionId: identity.agentSessionId,
      runId: this.#input.runId,
      normalizedSessionId: this.#input.normalizedSessionId,
      activeTurnId: this.#activeTurnId,
      lastSourceSequence: this.#sourceSequence,
      providerIdentity: {
        kind: "acpx",
        normalizedSessionId: identity.normalizedSessionId,
        acpxRecordId: identity.acpxRecordId,
        backendSessionId: identity.backendSessionId,
        agentSessionId: identity.agentSessionId,
        profileDigest: identity.profileDigest,
        workspaceDigest: identity.workspaceDigest,
        requestedModel: identity.requestedModel,
        effectiveModel: identity.effectiveModel,
        permissionMode: identity.permissionMode,
      },
      semanticResult:
        this.#semanticResult &&
        this.#semanticFingerprint &&
        this.#semanticTurnId
          ? {
              result: structuredClone(this.#semanticResult),
              fingerprint: this.#semanticFingerprint,
              callId: this.#semanticCallId,
              turnId: this.#semanticTurnId,
            }
          : null,
      terminalTurns: [...this.#terminalTurns].map(
        ([terminalTurnId, fingerprint]) => ({
          turnId: terminalTurnId,
          fingerprint,
        }),
      ),
    };
  }

  async close(input: { reason: string }): Promise<void> {
    if (this.#closePromise) return await this.#closePromise;
    if (this.#closed) return;
    this.#closingStarted = true;
    const closePromise = this.#finishClose(input.reason);
    this.#closePromise = closePromise;
    try {
      await closePromise;
      this.#closed = true;
    } finally {
      if (this.#closePromise === closePromise) this.#closePromise = null;
    }
  }

  async #finishClose(reason: string): Promise<void> {
    const closingTurnId = this.#activeTurnId;
    const pump = this.#activePump;
    const hostClose =
      this.#hostClosePromise ?? this.#startHostClose({ reason });
    await settleWithin(hostClose, this.#closeSettlementTimeoutMs);
    if (pump) {
      await settleWithin(
        pump.catch(() => undefined),
        this.#closeSettlementTimeoutMs,
      ).catch(() => undefined);
    }
    if (closingTurnId && !this.#terminalTurns.has(closingTurnId)) {
      if (this.#activeTurnId === closingTurnId) this.#activeTurnId = null;
      this.#terminalTurns.set(
        closingTurnId,
        canonicalJson({ status: "interrupted" }),
      );
      this.#emit(
        "turn.interrupted",
        { status: "interrupted", stopReason: "session_closed" },
        { turnId: closingTurnId },
      );
    }
    this.#eventStreamClosed = true;
    this.#events.close();
  }

  #startHostClose(input: { reason: string }): Promise<void> {
    const closePromise = this.#host.close(input);
    this.#hostClosePromise = closePromise;
    void closePromise.catch(() => {
      if (this.#hostClosePromise === closePromise) {
        this.#hostClosePromise = null;
      }
    });
    return closePromise;
  }

  async #pumpTurn(turnId: string, turn: AcpxRuntimeTurn): Promise<void> {
    try {
      let index = 0;
      const normalizeToolEvent =
        createAcpxToolEventNormalizer<AcpRuntimeEvent>();
      for await (const event of turn.events) {
        this.#mapRuntimeEvent(normalizeToolEvent(event), turnId, ++index);
      }
      const result = await turn.result;
      if (this.#terminalTurns.has(turnId)) return;
      if (this.#activeTurnId === turnId) this.#activeTurnId = null;
      if (result.status === "completed") {
        const finalText = this.#assistantText.trim();
        if (finalText) {
          this.#emit(
            "item.completed",
            { kind: "agentMessage", channel: "final", text: finalText },
            { turnId, itemId: `${turnId}:final-answer` },
          );
        }
        this.#terminalTurns.set(
          turnId,
          canonicalJson({
            status: "completed",
            semanticResult: this.#semanticFingerprint,
          }),
        );
        this.#emit(
          "turn.completed",
          { status: "completed", stopReason: result.stopReason ?? null },
          { turnId },
        );
      } else if (result.status === "cancelled") {
        this.#terminalTurns.set(
          turnId,
          canonicalJson({ status: "interrupted" }),
        );
        this.#emit(
          "turn.interrupted",
          {
            status: "interrupted",
            stopReason: result.stopReason ?? "cancelled",
          },
          { turnId },
        );
      } else {
        this.#terminalTurns.set(turnId, canonicalJson({ status: "failed" }));
        this.#emit(
          "provider.notice.recorded",
          {
            schema: "paperclip.provider.notice.v1",
            noticeId: `${turnId}:failure`,
            severity: "error",
            category: "acpx_turn_failed",
            scope: "turn",
            recoverable: result.error.retryable ?? false,
            userActionable: true,
            summary: safeMessage(result.error.message),
          },
          { turnId, itemId: `${turnId}:failure` },
        );
        this.#emit(
          "turn.failed",
          {
            status: "failed",
            error: {
              code: result.error.code ?? null,
              message: safeMessage(result.error.message),
            },
          },
          { turnId },
        );
      }
    } catch (error) {
      if (this.#terminalTurns.has(turnId)) return;
      if (this.#activeTurnId === turnId) this.#activeTurnId = null;
      if (this.#closed) {
        this.#terminalTurns.set(
          turnId,
          canonicalJson({ status: "interrupted" }),
        );
        this.#emit(
          "turn.interrupted",
          { status: "interrupted", stopReason: "session_closed" },
          { turnId },
        );
      } else {
        this.#terminalTurns.set(turnId, canonicalJson({ status: "failed" }));
        this.#emit(
          "turn.failed",
          { status: "failed", error: { message: safeMessage(error) } },
          { turnId },
        );
      }
    }
  }

  #mapRuntimeEvent(
    event: AcpRuntimeEvent,
    turnId: string,
    index: number,
  ): void {
    const fallbackItemId = `${turnId}:acp:${index}`;
    if (event.type === "text_delta") {
      const output = boundedText(event.text, 64 * 1024);
      if (event.stream !== "thought" && event.tag !== "agent_thought_chunk") {
        this.#assistantText = boundedText(
          `${this.#assistantText}${output}`,
          256 * 1024,
        );
      }
      this.#emit(
        "item.delta",
        {
          kind:
            event.stream === "thought" || event.tag === "agent_thought_chunk"
              ? "thinking"
              : "agent_message",
          text: output,
        },
        { turnId, itemId: fallbackItemId },
      );
    }
    if (event.type === "status" && event.tag === "usage_update") {
      this.#usage = boundedRecord({
        cumulative: event.breakdown,
        cost: event.cost,
      });
    }
    for (const canonical of canonicalProviderEventsFromAcpxRuntimeEvent(
      event,
      fallbackItemId,
      turnId,
    )) {
      this.#emit(canonical.eventType, canonical.payload, {
        turnId,
        itemId: canonical.itemId,
      });
    }
  }

  #emit(
    eventType: PrpEvent["eventType"],
    payload: Record<string, unknown>,
    refs: { turnId?: string; itemId?: string } = {},
  ): void {
    if (this.#eventStreamClosed) return;
    if (this.#eventStreamOmitted && isTerminalEvent(eventType)) {
      this.#eventStreamOmitted = false;
      this.#emit(
        "harness.diagnostic",
        {
          code: "event_stream_retention_limit",
          message:
            "Earlier provider events were omitted because the consumer exceeded the bounded event buffer.",
        },
        refs,
      );
    }
    const sourceSeq = ++this.#sourceSequence;
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${this.#sourceInstanceId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: this.#sourceInstanceId,
      sourceKind: "runner",
      runId: this.#input.runId,
      normalizedSessionId: this.#input.normalizedSessionId,
      ...(refs.turnId ? { turnId: refs.turnId } : {}),
      ...(refs.itemId ? { itemId: refs.itemId } : {}),
      eventType,
      schemaVersion: 1,
      priority: eventType === "run.result.proposed" ? 0 : 1,
      emittedAt: this.#now().toISOString(),
      payload: structuredClone(payload),
    };
    this.#retainTranscriptEvent(event);
    if (this.#events.push(event)) this.#eventStreamOmitted = true;
  }

  #retainTranscriptEvent(event: PrpEvent): void {
    this.#transcriptEventCount += 1;
    const retained = structuredClone(event);
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(retained));
    } catch {
      this.#transcriptOmitted = true;
      return;
    }
    if (bytes > MAX_TRANSCRIPT_BYTES) {
      this.#transcriptOmitted = true;
      return;
    }
    this.#transcript.push({ event: retained, bytes });
    this.#transcriptBytes += bytes;
    while (
      this.#transcript.length > MAX_TRANSCRIPT_EVENTS ||
      this.#transcriptBytes > MAX_TRANSCRIPT_BYTES
    ) {
      const omitted = this.#transcript.shift();
      if (omitted) this.#transcriptBytes -= omitted.bytes;
      this.#transcriptOmitted = true;
    }
  }

  #assertOpen(): void {
    if (this.#closed || this.#closingStarted) {
      throw new Error("Codex ACPX session is closing or closed");
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function boundedRecord(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > 64 * 1024) {
    return { omitted: true, reason: "payload_limit" };
  }
  const parsed: unknown = JSON.parse(serialized);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function boundedText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  return bytes.length <= maxBytes
    ? value
    : bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

function safeId(value: string, fallback: string): string {
  const candidate = value.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 160);
  return /^[A-Za-z0-9]/.test(candidate) ? candidate : fallback;
}

function stableId(prefix: string, value: string): string {
  const readable = safeId(value, "session").slice(0, 80);
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${prefix}-${readable}-${suffix}`;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(
      /(key|token|secret|password|authorization)\s*[:=]\s*[^\s,}\]]+/gi,
      "$1=[REDACTED]",
    )
    .slice(0, 4_000);
}

function isTerminalEvent(eventType: PrpEvent["eventType"]): boolean {
  return (
    eventType === "turn.completed" ||
    eventType === "turn.failed" ||
    eventType === "turn.interrupted"
  );
}

function isCriticalBufferedEvent(event: PrpEvent): boolean {
  return (
    event.priority === 0 ||
    event.eventType === "harness.diagnostic" ||
    isTerminalEvent(event.eventType)
  );
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  readonly #maxItems: number;
  readonly #isCritical: (item: T) => boolean;
  readonly #isProtected: (item: T) => boolean;
  #closed = false;

  constructor(
    maxItems: number,
    isCritical: (item: T) => boolean,
    isProtected: (item: T) => boolean,
  ) {
    this.#maxItems = maxItems;
    this.#isCritical = isCritical;
    this.#isProtected = isProtected;
  }

  /** Returns true when an event had to be omitted. */
  push(item: T): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value: item });
      return false;
    }
    const omitted = this.#items.length >= this.#maxItems;
    if (omitted) {
      const expendable = this.#items.findIndex(
        (candidate) => !this.#isCritical(candidate),
      );
      if (expendable >= 0) this.#items.splice(expendable, 1);
      else if (this.#isProtected(item)) {
        const unprotected = this.#items.findIndex(
          (candidate) => !this.#isProtected(candidate),
        );
        if (unprotected >= 0) this.#items.splice(unprotected, 1);
        else return true;
      } else return true;
    }
    this.#items.push(item);
    return omitted;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) {
          return Promise.resolve({ done: false, value: item });
        }
        if (this.#closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

async function settleWithin(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("ACPX host cleanup exceeded its shutdown timeout"));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
