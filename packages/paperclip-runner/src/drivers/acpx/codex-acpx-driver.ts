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
  type HarnessSessionRecoveryResult,
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
import {
  DEFAULT_CODEX_ACPX_RUNTIME_SHUTDOWN_BOUND_MS,
  openCodexAcpxRuntime,
} from "./codex-runtime-adapter.js";
import {
  acpxDriverDescriptor,
  validateAcpxDriverConfig,
} from "./driver-profile.js";
import {
  ACPX_TURN_CANCELLATION_SHUTDOWN_BOUND_MS,
  AcpxRuntimeHost,
  type AcpxRuntimeTurn,
  type OpenAcpxRuntimeHostOptions,
} from "./runtime-host.js";
import { readAcpxRecoveryWorkspace } from "./runtime-sandbox.js";

const MAX_BUFFERED_EVENTS = 512;
const TERMINAL_EVENT_RESERVE = 3;
const TURN_START_EVENT_COUNT = 3;
const MAX_TRANSCRIPT_EVENTS = 1_024;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_RECOVERY_TERMINAL_TURNS = 4_096;
const MAX_RECOVERY_TERMINAL_BYTES = 8 * 1024 * 1024;
const CLOSE_TURN_SETTLEMENT_TIMEOUT_MS = 2_000;
const MAX_AUTONOMOUS_HOST_CLOSE_RETRIES = 3;
const MAX_QUARANTINED_HOST_CLOSE_RETRIES = 3;
const QUARANTINED_HOST_CLOSE_RETRY_MS = 60_000;
const MAX_QUARANTINED_HOST_ATTEMPT_RETRY_DELAY_MS = 1_000;
// Host shutdown first bounds active-turn cancellation and then performs the
// adapter's bounded protocol/TERM/KILL cleanup. Admission can inherit an
// already-running three-attempt recovery, so cover every attempt and bounded
// inter-attempt delay, plus one second of scheduling margin.
const QUARANTINED_HOST_CLOSE_ATTEMPT_BOUND_MS =
  ACPX_TURN_CANCELLATION_SHUTDOWN_BOUND_MS +
  DEFAULT_CODEX_ACPX_RUNTIME_SHUTDOWN_BOUND_MS;
const QUARANTINED_HOST_ADMISSION_GRACE_MS =
  MAX_QUARANTINED_HOST_CLOSE_RETRIES *
    QUARANTINED_HOST_CLOSE_ATTEMPT_BOUND_MS +
  (MAX_QUARANTINED_HOST_CLOSE_RETRIES - 1) *
    MAX_QUARANTINED_HOST_ATTEMPT_RETRY_DELAY_MS +
  1_000;

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

interface QuarantinedHostCleanup {
  host: CodexAcpxHost;
  reason: string;
  attempt: Promise<void> | null;
  recovery: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface CodexAcpxDriverDependencies {
  openHost?: (options: OpenAcpxRuntimeHostOptions) => Promise<CodexAcpxHost>;
  /** Internal test seam; production uses the fixed close-settlement bound. */
  closeSettlementTimeoutMs?: number;
  /** Internal test seam; production uses the fixed event-retention bound. */
  maxBufferedEvents?: number;
  readRecoveryWorkspace?: (input: {
    runtimeDirectory: string;
    normalizedSessionId: string;
  }) => Promise<string>;
}

/** Codex-only HarnessDriver backed by the admitted ACPX runtime host. */
export class CodexAcpxDriver implements HarnessDriver {
  readonly #options: CodexAcpxDriverOptions;
  readonly #openHost: NonNullable<CodexAcpxDriverDependencies["openHost"]>;
  readonly #closeSettlementTimeoutMs: number;
  readonly #maxBufferedEvents: number;
  readonly #cleanupOwners = new Set<Promise<void>>();
  readonly #quarantinedHostCleanups = new Set<QuarantinedHostCleanup>();
  readonly #readRecoveryWorkspace: NonNullable<
    CodexAcpxDriverDependencies["readRecoveryWorkspace"]
  >;

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
      TERMINAL_EVENT_RESERVE + TURN_START_EVENT_COUNT,
      Math.floor(dependencies.maxBufferedEvents ?? MAX_BUFFERED_EVENTS),
    );
    this.#readRecoveryWorkspace =
      dependencies.readRecoveryWorkspace ?? readAcpxRecoveryWorkspace;
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
        resume: true,
        runtimeRequestResolution: false,
        runtimeRequestHandoff: false,
        unsupported: [
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
    await this.#retryQuarantinedHostCleanups();
    return await this.#open(input, null);
  }

  async recoverSession(
    snapshot: PersistedHarnessSession,
  ): Promise<HarnessSessionRecoveryResult> {
    try {
      await this.#retryQuarantinedHostCleanups();
      validateRecoverySnapshot(snapshot);
      const terminalTurnIds = new Set(
        (snapshot.terminalTurns ?? []).map(({ turnId }) => turnId),
      );
      if (
        snapshot.activeTurnId &&
        !terminalTurnIds.has(snapshot.activeTurnId)
      ) {
        return {
          recovered: false,
          reason: "active Codex ACPX turn continuity is unavailable",
        };
      }
      const workingDirectory = await this.#readRecoveryWorkspace({
        runtimeDirectory: this.#options.runtimeDirectory,
        normalizedSessionId: snapshot.normalizedSessionId!,
      });
      return {
        recovered: true,
        session: await this.#open(
          {
            runId: snapshot.runId!,
            normalizedSessionId: snapshot.normalizedSessionId!,
            workingDirectory,
          },
          snapshot,
        ),
      };
    } catch (error) {
      return { recovered: false, reason: safeMessage(error) };
    }
  }

  async #open(
    input: OpenHarnessSessionInput,
    snapshot: PersistedHarnessSession | null,
  ): Promise<HarnessSession> {
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
      ...(snapshot?.providerIdentity?.kind === "acpx"
        ? { expectedIdentity: snapshot.providerIdentity }
        : {}),
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
        retainCleanup: (cleanup) => this.#retainCleanup(cleanup),
        quarantineCleanup: (hostToRetain, reason) =>
          this.#quarantineHostCleanup(hostToRetain, reason),
        snapshot,
      });
      return session;
    } catch (error) {
      const cleanup = host.close({
        reason: "Codex ACPX session initialization failed",
      });
      this.#retainCleanup(cleanup);
      await settleWithin(cleanup, this.#closeSettlementTimeoutMs).catch(
        () => undefined,
      );
      throw error;
    }
  }

  #retainCleanup(cleanup: Promise<void>): void {
    this.#cleanupOwners.add(cleanup);
    void cleanup
      .finally(() => this.#cleanupOwners.delete(cleanup))
      .catch(() => undefined);
  }

  #quarantineHostCleanup(host: CodexAcpxHost, reason: string): void {
    if ([...this.#quarantinedHostCleanups].some((entry) => entry.host === host)) {
      return;
    }
    const cleanup: QuarantinedHostCleanup = {
      host,
      reason,
      attempt: null,
      recovery: null,
      timer: null,
    };
    this.#quarantinedHostCleanups.add(cleanup);
    this.#startQuarantinedHostCleanupRecovery(
      cleanup,
      MAX_QUARANTINED_HOST_CLOSE_RETRIES,
      "quarantined cleanup recovery",
    );
  }

  #startQuarantinedHostCleanupRecovery(
    cleanup: QuarantinedHostCleanup,
    maxAttempts: number,
    reason: string,
  ): Promise<void> {
    if (cleanup.recovery) return cleanup.recovery;
    const recovery = (async () => {
      for (
        let attemptCount = 0;
        attemptCount < maxAttempts && this.#quarantinedHostCleanups.has(cleanup);
        attemptCount += 1
      ) {
        // Start the first retry immediately so admission's finite grace applies
        // to provider cleanup rather than to this rate-limit delay. Only later
        // attempts wait, preserving sequential bounded retry behavior.
        if (attemptCount > 0) {
          await waitForCleanupRetry(
            Math.max(
              1,
              Math.min(
                MAX_QUARANTINED_HOST_ATTEMPT_RETRY_DELAY_MS,
                this.#closeSettlementTimeoutMs,
              ),
            ),
          );
        }
        const attempt = Promise.resolve().then(() => cleanup.host.close({
          reason: `${cleanup.reason} (${reason})`,
        }));
        cleanup.attempt = attempt;
        try {
          await attempt;
          this.#quarantinedHostCleanups.delete(cleanup);
        } catch {
          // Retain the quarantine after this finite, sequential retry batch.
        } finally {
          if (cleanup.attempt === attempt) cleanup.attempt = null;
        }
      }
    })();
    cleanup.recovery = recovery;
    this.#retainCleanup(recovery);
    void recovery.finally(() => {
      if (cleanup.recovery === recovery) cleanup.recovery = null;
      this.#scheduleQuarantinedHostCleanup(cleanup);
    }).catch(() => undefined);
    return recovery;
  }

  #scheduleQuarantinedHostCleanup(cleanup: QuarantinedHostCleanup): void {
    if (
      !this.#quarantinedHostCleanups.has(cleanup)
      || cleanup.recovery
      || cleanup.attempt
      || cleanup.timer
    ) {
      return;
    }
    // A quarantined host remains actively owned, but recovery is rate-limited:
    // each entry holds at most one unref'd timer and one sequential close.
    // Admission may pull that timer forward; it never creates a parallel try.
    cleanup.timer = setTimeout(() => {
      cleanup.timer = null;
      if (!this.#quarantinedHostCleanups.has(cleanup)) return;
      this.#startQuarantinedHostCleanupRecovery(
        cleanup,
        1,
        "scheduled quarantined cleanup recovery",
      );
    }, QUARANTINED_HOST_CLOSE_RETRY_MS);
    cleanup.timer.unref?.();
  }

  async #retryQuarantinedHostCleanups(): Promise<void> {
    const deadline = Date.now() + QUARANTINED_HOST_ADMISSION_GRACE_MS;
    const observedOwners = new Set<Promise<void>>();
    const acceleratedCleanups = new Set<QuarantinedHostCleanup>();
    while (true) {
      // A close that is still pending has not entered quarantine yet, but it
      // owns the same provider resources. Observe every retained owner and any
      // replacement quarantine recovery it installs before admitting a host.
      const cleanupOwners = new Set<Promise<void>>(this.#cleanupOwners);
      for (const cleanup of this.#quarantinedHostCleanups) {
        if (cleanup.timer) {
          clearTimeout(cleanup.timer);
          cleanup.timer = null;
        }
        if (cleanup.recovery) {
          acceleratedCleanups.add(cleanup);
          cleanupOwners.add(cleanup.recovery);
        } else if (!acceleratedCleanups.has(cleanup)) {
          acceleratedCleanups.add(cleanup);
          cleanupOwners.add(this.#startQuarantinedHostCleanupRecovery(
            cleanup,
            1,
            "quarantined cleanup admission recovery",
          ));
        }
      }
      const replacementOwners = [...cleanupOwners].filter(
        (owner) => !observedOwners.has(owner),
      );
      if (replacementOwners.length === 0) break;
      replacementOwners.forEach((owner) => observedOwners.add(owner));
      const remainingMs = deadline - Date.now();
      if (
        remainingMs <= 0
        || !(await settlesWithin(
          Promise.all(replacementOwners.map((owner) => owner.catch(() => undefined))),
          remainingMs,
        ))
      ) {
        throw new Error(
          "Codex ACPX cannot open a new session because quarantined host cleanup exceeded the admission grace",
        );
      }
    }
    if (this.#cleanupOwners.size > 0 || this.#quarantinedHostCleanups.size > 0) {
      throw new Error(
        "Codex ACPX cannot open a new session while quarantined host cleanup remains incomplete",
      );
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
  readonly #retainCleanup: (cleanup: Promise<void>) => void;
  readonly #quarantineCleanup: (host: CodexAcpxHost, reason: string) => void;
  readonly #transcript: Array<{ event: PrpEvent; bytes: number }> = [];
  readonly #terminalTurns = new Map<string, string>();
  readonly #sourceInstanceId: string;
  readonly #providerRecoveryPolicy: NonNullable<
    PersistedHarnessSession["providerRecoveryPolicy"]
  >;
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
  #hostCloseRecoveryPromise: Promise<void> | null = null;
  #hostClosed = false;
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
    retainCleanup: (cleanup: Promise<void>) => void;
    quarantineCleanup: (host: CodexAcpxHost, reason: string) => void;
    snapshot: PersistedHarnessSession | null;
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
    this.#retainCleanup = input.retainCleanup;
    this.#quarantineCleanup = input.quarantineCleanup;
    this.#events = new AsyncQueue<PrpEvent>(input.maxBufferedEvents);
    this.#sourceInstanceId = stableId(
      "paperclip-acpx",
      input.input.normalizedSessionId,
    );
    this.#sourceSequence = input.snapshot?.lastSourceSequence ?? 0;
    this.#activeTurnId = input.snapshot?.activeTurnId ?? null;
    this.#providerRecoveryPolicy =
      input.snapshot?.providerRecoveryPolicy ?? "same_session_only";
    const semantic = input.snapshot?.semanticResult;
    if (semantic) {
      this.#semanticResult = structuredClone(semantic.result);
      this.#semanticFingerprint = semantic.fingerprint;
      this.#semanticCallId = semantic.callId ?? null;
      this.#semanticTurnId = semantic.turnId;
    }
    for (const terminal of input.snapshot?.terminalTurns ?? []) {
      this.#terminalTurns.set(terminal.turnId, terminal.fingerprint);
    }
    if (this.#activeTurnId && this.#terminalTurns.has(this.#activeTurnId)) {
      this.#activeTurnId = null;
    }
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
    if (!this.#events.hasCapacity(TERMINAL_EVENT_RESERVE + TURN_START_EVENT_COUNT)) {
      throw new HarnessCapabilityUnavailableError(
        "turn.start",
        "the event consumer must drain the previous turn before another turn can start",
      );
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
      const ownerTerminal = this.#semanticTurnId === null
        ? null
        : this.#terminalTurns.get(this.#semanticTurnId) ?? null;
      const ownerCompletedWithResult = ownerTerminal !== null &&
        terminalFingerprintOwnsResult(ownerTerminal, fingerprint);
      const claimsUnsettledRetry =
        this.#semanticFingerprint === fingerprint &&
        this.#semanticTurnId !== turnId &&
        !ownerCompletedWithResult;
      if (this.#semanticFingerprint === null || claimsUnsettledRetry) {
        if (!this.#emit("run.result.proposed", validation.result, {
          turnId,
          itemId: call.callId,
        })) {
          throw new HarnessCapabilityUnavailableError(
            "run.result.proposed",
            "the event consumer must drain provider events before a semantic result can be accepted",
          );
        }
        this.#semanticResult = structuredClone(validation.result);
        this.#semanticFingerprint = fingerprint;
        this.#semanticCallId = call.callId;
        this.#semanticTurnId = turnId;
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
      providerRecoveryPolicy: this.#providerRecoveryPolicy,
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
    } catch (error) {
      this.#scheduleHostCloseRecovery(input.reason);
      throw error;
    } finally {
      if (this.#closePromise === closePromise) this.#closePromise = null;
    }
  }

  async #finishClose(reason: string): Promise<void> {
    const closingTurnId = this.#activeTurnId;
    const pump = this.#activePump;
    const hostClose =
      this.#hostClosePromise ?? this.#startHostClose({ reason });
    let hostCloseError: unknown = null;
    try {
      await settleWithin(hostClose, this.#closeSettlementTimeoutMs);
    } catch (error) {
      hostCloseError = error;
    }
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
    if (hostCloseError) {
      this.#emit(
        "harness.diagnostic",
        {
          code: "acpx_host_cleanup_deferred",
          message:
            "ACPX host cleanup exceeded its caller wait bound; the driver retains the exact cleanup until it settles.",
        },
        closingTurnId ? { turnId: closingTurnId } : {},
        0,
      );
    }
    this.#eventStreamClosed = true;
    this.#events.close();
    if (hostCloseError) {
      throw hostCloseError;
    }
  }

  #startHostClose(input: { reason: string }): Promise<void> {
    const closePromise = this.#host.close(input).then(() => {
      this.#hostClosed = true;
    });
    this.#hostClosePromise = closePromise;
    this.#retainCleanup(closePromise);
    return closePromise;
  }

  #scheduleHostCloseRecovery(reason: string): void {
    if (this.#hostClosed || this.#hostCloseRecoveryPromise) return;
    const failedOrPendingClose = this.#hostClosePromise;
    if (!failedOrPendingClose) return;
    // Never overlap the exact cleanup that exceeded the caller's wait bound.
    // Once an attempt rejects, keep one delay-bounded recovery owner alive for
    // a finite retry budget. A permanently pending attempt remains the sole
    // owner while the runtime adapter independently terminates its children;
    // repeated terminal failures settle instead of creating an immortal loop.
    const recovery = (async () => {
      let attempt = failedOrPendingClose;
      let retryCount = 0;
      while (!this.#hostClosed) {
        try {
          await attempt;
          this.#closed = true;
          return;
        } catch (error) {
          if (retryCount >= MAX_AUTONOMOUS_HOST_CLOSE_RETRIES) {
            this.#quarantineCleanup(this.#host, reason);
            throw error;
          }
          retryCount += 1;
        }
        await waitForCleanupRetry(
          Math.max(1, Math.min(1_000, this.#closeSettlementTimeoutMs)),
        );
        if (this.#hostClosed) {
          this.#closed = true;
          return;
        }
        if (this.#hostClosePromise === attempt) {
          this.#hostClosePromise = null;
        }
        attempt = this.#startHostClose({
          reason: `${reason} (automatic cleanup recovery ${retryCount})`,
        });
      }
    })();
    this.#hostCloseRecoveryPromise = recovery;
    this.#retainCleanup(recovery);
    void recovery
      .finally(() => {
        if (this.#hostCloseRecoveryPromise === recovery) {
          this.#hostCloseRecoveryPromise = null;
        }
      })
      .catch(() => undefined);
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
        if (
          this.#semanticFingerprint !== null &&
          this.#semanticTurnId !== null &&
          this.#semanticTurnId !== turnId
        ) {
          const ownerTerminal = this.#terminalTurns.get(this.#semanticTurnId);
          if (
            ownerTerminal !== undefined &&
            !terminalFingerprintOwnsResult(
              ownerTerminal,
              this.#semanticFingerprint,
            )
          ) {
            // A provider retry may confirm the already durable semantic result
            // without invoking the terminal tool again. Bind that result to
            // the successful settlement so the checkpoint remains recoverable.
            this.#semanticTurnId = turnId;
          }
        }
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
            semanticResult:
              this.#semanticTurnId === turnId
                ? this.#semanticFingerprint
                : null,
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
      if (this.#closed || this.#closingStarted) {
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
    reservedAfter = isTerminalEvent(eventType)
      ? 0
      : eventType === "run.result.proposed"
        ? TERMINAL_EVENT_RESERVE - 1
        : TERMINAL_EVENT_RESERVE,
  ): boolean {
    if (this.#eventStreamClosed) return false;
    if (this.#eventStreamOmitted && isTerminalEvent(eventType)) {
      this.#eventStreamOmitted = false;
      const recordedOmission = this.#emit(
        "harness.diagnostic",
        {
          code: "event_stream_retention_limit",
          message:
            "Earlier provider events were omitted because the consumer exceeded the bounded event buffer.",
        },
        refs,
        1,
      );
      if (!recordedOmission) this.#eventStreamOmitted = true;
    }
    if (!this.#events.hasCapacity(1 + reservedAfter)) {
      this.#eventStreamOmitted = true;
      this.#transcriptEventCount += 1;
      this.#transcriptOmitted = true;
      return false;
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
    if (!this.#events.push(event)) {
      throw new Error("Codex ACPX event queue violated its reserved capacity");
    }
    return true;
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

function waitForCleanupRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  });
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

function terminalFingerprintOwnsResult(
  terminalFingerprint: string,
  semanticFingerprint: string,
): boolean {
  try {
    const terminal = JSON.parse(terminalFingerprint) as unknown;
    if (typeof terminal !== "object" || terminal === null || Array.isArray(terminal)) {
      return false;
    }
    const record = terminal as Record<string, unknown>;
    return record.status === "completed" &&
      record.semanticResult === semanticFingerprint;
  } catch {
    return false;
  }
}

function validateRecoverySnapshot(snapshot: PersistedHarnessSession): void {
  if (
    snapshot.driverKind !== "acpx_runtime" ||
    !snapshot.runId?.trim() ||
    !snapshot.normalizedSessionId?.trim() ||
    snapshot.providerIdentity?.kind !== "acpx"
  ) {
    throw new Error("persisted Codex ACPX session identity is incomplete");
  }
  const identity = snapshot.providerIdentity;
  if (
    !boundedIdentity(snapshot.runId) ||
    !boundedIdentity(snapshot.normalizedSessionId) ||
    identity.normalizedSessionId !== snapshot.normalizedSessionId ||
    identity.acpxRecordId !== snapshot.driverSessionId ||
    identity.agentSessionId !== snapshot.providerSessionId ||
    ![
      identity.normalizedSessionId,
      identity.acpxRecordId,
      identity.backendSessionId,
      identity.agentSessionId,
      identity.requestedModel,
      identity.effectiveModel,
    ].every(boundedIdentity) ||
    !/^sha256:[a-f0-9]{64}$/.test(identity.profileDigest) ||
    !/^sha256:[a-f0-9]{64}$/.test(identity.workspaceDigest) ||
    (identity.permissionMode !== undefined &&
      !["approve-all", "approve-reads", "deny-all"].includes(
        identity.permissionMode,
      ))
  ) {
    throw new Error("persisted Codex ACPX session identity is inconsistent");
  }
  if (
    snapshot.providerRecoveryPolicy !== undefined &&
    snapshot.providerRecoveryPolicy !== "same_session_only"
  ) {
    throw new Error("persisted Codex ACPX recovery policy is unsupported");
  }
  if (
    (snapshot.pendingRuntimeRequests?.length ?? 0) > 0 ||
    (snapshot.lineage?.length ?? 0) > 0 ||
    snapshot.goal != null
  ) {
    throw new Error("persisted Codex ACPX snapshot has unsupported state");
  }
  if (
    snapshot.lastSourceSequence !== undefined &&
    (!Number.isSafeInteger(snapshot.lastSourceSequence) ||
      snapshot.lastSourceSequence < 0)
  ) {
    throw new Error("persisted Codex ACPX source sequence is invalid");
  }
  if (
    snapshot.terminalTurns !== undefined &&
    !Array.isArray(snapshot.terminalTurns)
  ) {
    throw new Error("persisted Codex ACPX terminal history is invalid");
  }
  const terminalTurns = snapshot.terminalTurns ?? [];
  if (terminalTurns.length > MAX_RECOVERY_TERMINAL_TURNS) {
    throw new Error("persisted Codex ACPX terminal history exceeds its limit");
  }
  const terminalTurnIds = new Set<string>();
  let terminalBytes = 0;
  for (const terminal of terminalTurns) {
    terminalBytes +=
      Buffer.byteLength(terminal.turnId ?? "") +
      Buffer.byteLength(terminal.fingerprint ?? "");
    if (
      !boundedIdentity(terminal.turnId) ||
      !terminal.fingerprint ||
      Buffer.byteLength(terminal.fingerprint) > 256 * 1024 ||
      terminalBytes > MAX_RECOVERY_TERMINAL_BYTES ||
      terminalTurnIds.has(terminal.turnId)
    ) {
      throw new Error("persisted Codex ACPX terminal turn is invalid");
    }
    terminalTurnIds.add(terminal.turnId);
  }
  if (
    snapshot.activeTurnId !== undefined &&
    snapshot.activeTurnId !== null &&
    !boundedIdentity(snapshot.activeTurnId)
  ) {
    throw new Error("persisted Codex ACPX active turn is invalid");
  }
  const semantic = snapshot.semanticResult;
  if (semantic) {
    const validation = validatePrpStructuredRunResult(semantic.result);
    if (
      !validation.ok ||
      semantic.fingerprint !== canonicalJson(validation.result) ||
      !boundedIdentity(semantic.turnId) ||
      (semantic.callId !== undefined &&
        semantic.callId !== null &&
        !boundedIdentity(semantic.callId))
    ) {
      throw new Error("persisted Codex ACPX semantic result is invalid");
    }
    const semanticTerminal = terminalTurns.find(
      (terminal) => terminal.turnId === semantic.turnId,
    );
    if (
      !semanticTerminal ||
      !isCompletedSemanticTerminal(
        semanticTerminal.fingerprint,
        semantic.fingerprint,
      )
    ) {
      throw new Error(
        "persisted Codex ACPX semantic result has no completed terminal turn",
      );
    }
    if (
      snapshot.activeTurnId !== undefined &&
      snapshot.activeTurnId !== null
    ) {
      const activeTerminal = terminalTurns.find(
        (terminal) => terminal.turnId === snapshot.activeTurnId,
      );
      if (
        snapshot.activeTurnId !== semantic.turnId ||
        !activeTerminal ||
        !isCompletedSemanticTerminal(
          activeTerminal.fingerprint,
          semantic.fingerprint,
        )
      ) {
        throw new Error(
          "persisted Codex ACPX active turn is not the completed semantic settlement",
        );
      }
    }
  } else if (terminalTurns.length > 0) {
    const settlementTurnId =
      snapshot.activeTurnId ?? terminalTurns.at(-1)!.turnId;
    const settlement = terminalTurns.find(
      (terminal) => terminal.turnId === settlementTurnId,
    );
    if (!settlement || !isCompletedTerminal(settlement.fingerprint)) {
      throw new Error(
        "persisted Codex ACPX resultless recovery requires a completed terminal turn",
      );
    }
  }
}

function isCompletedTerminal(terminalFingerprint: string): boolean {
  try {
    const value: unknown = JSON.parse(terminalFingerprint);
    return typeof value === "object"
      && value !== null
      && !Array.isArray(value)
      && (value as Record<string, unknown>).status === "completed";
  } catch {
    return false;
  }
}

function isCompletedSemanticTerminal(
  terminalFingerprint: string,
  semanticFingerprint: string,
): boolean {
  try {
    const value: unknown = JSON.parse(terminalFingerprint);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const terminal = value as Record<string, unknown>;
    return (
      terminal.status === "completed" &&
      terminal.semanticResult === semanticFingerprint
    );
  } catch {
    return false;
  }
}

function boundedIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 240 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
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

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  readonly #maxItems: number;
  #closed = false;

  constructor(maxItems: number) {
    this.#maxItems = maxItems;
  }

  hasCapacity(requiredItems: number): boolean {
    return (
      requiredItems <=
      this.#waiters.length + this.#maxItems - this.#items.length
    );
  }

  push(item: T): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value: item });
      return true;
    }
    if (this.#items.length >= this.#maxItems) return false;
    this.#items.push(item);
    return true;
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

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
