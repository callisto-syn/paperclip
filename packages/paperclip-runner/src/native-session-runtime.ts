import { randomUUID } from "node:crypto";

import type { ControlPlanePort } from "./contracts/control-plane-port.js";
import type { NativeExecutionInput, NativeSessionExecutionResult } from "./contracts/native-execution.js";
import { buildNativeModelEnvelope, parseNativeExecutionInput } from "./contracts/native-execution.js";
import type { NativeSession, NativeSessionBackend } from "./contracts/native-session-backend.js";
import type { PersistedNativeSession } from "./contracts/native-session-backend.js";
import type { PrpEvent, PrpStructuredRunResult, PrpTerminalState } from "./protocol/replay-contract.js";
import { parsePaperclipQuestionSet } from "./contracts/question-set.js";

export const DEFAULT_NATIVE_RUNTIME_INPUT_LIVE_WINDOW_MS = 120_000;
const OPTIONAL_SESSION_CANCELLATION_GRACE_MS = 100;
const FAILED_OPERATION_SETTLEMENT_GRACE_MS = 100;

export interface ExecuteNativeSessionOptions {
  input: NativeExecutionInput;
  backend: NativeSessionBackend;
  controlPlane: ControlPlanePort;
  runnerInstanceId: string;
  controlPlaneInstanceId: string;
  timeoutMs?: number;
  /** Internal test seam; production uses the fixed 120-second platform policy. */
  runtimeInputLiveWindowMs?: number;
  onSession?: (session: NativeSession | null) => void;
  existingSession?: NativeSession;
  persistedSession?: PersistedNativeSession | null;
  keepSessionOpen?: boolean;
  onCheckpoint?: (snapshot: PersistedNativeSession) => Promise<void> | void;
  /** Called when exact provider recovery failed and policy opened a new provider session. */
  onContinuityBreak?: (input: {
    reason: string;
    previousDriverSessionId: string;
    previousProviderSessionId: string | null;
    replacementDriverSessionId: string;
    replacementProviderSessionId: string | null;
  }) => Promise<void> | void;
  /**
   * Control-plane policy seam for a provider turn that completed after
   * durably creating a governed wait, but did not emit a semantic finish
   * result. The runner package cannot inspect server-owned interactions, so
   * it asks the embedding control plane whether that missing result is an
   * intentional yield before treating it as provider failure.
   */
  resolveMissingResult?: (input: {
    turnId: string | null;
    terminalEvent: PrpEvent;
  }) => Promise<PrpStructuredRunResult | null>;
  /**
   * Detect a durable server-owned wait as soon as its provider tool event is
   * committed. Models are not trusted to stop or avoid polling after creating
   * a question/review interaction; the control plane may park the turn here.
   */
  resolveGovernedWait?: (input: {
    turnId: string | null;
    event: PrpEvent;
    /**
     * Resolution must settle when this signal aborts. The runtime grants a
     * bounded settlement window before closing the provider session; callers
     * must treat the aborted signal as revocation of mutation authority.
     */
    signal: AbortSignal;
  }) => Promise<PrpStructuredRunResult | null>;
}

function isTurnTerminal(event: PrpEvent): boolean {
  return ["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"].includes(event.eventType);
}

function terminalFromEvent(event: PrpEvent, disposition: PrpTerminalState["reportedWorkDisposition"]): PrpTerminalState {
  const states = event.eventType === "turn.completed"
    ? { turnTerminalState: "completed" as const, runTerminalState: "succeeded" as const }
    : event.eventType === "turn.failed"
      ? { turnTerminalState: "failed" as const, runTerminalState: "failed" as const }
      : event.eventType === "turn.interrupted"
        ? { turnTerminalState: "interrupted" as const, runTerminalState: "cancelled" as const }
        : { turnTerminalState: "cancelled" as const, runTerminalState: "cancelled" as const };
  return { schema: "paperclip.prp.terminal.v1", ...states, reportedWorkDisposition: disposition };
}

async function attemptOptionalSessionCancellation(session: NativeSession, reason: string): Promise<void> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const attempts = Promise.allSettled([
    Promise.resolve().then(() => session.interrupt?.({ reason })),
    Promise.resolve().then(() => session.cancel?.({ reason })),
  ]);
  await Promise.race([
    attempts,
    new Promise<void>((resolve) => {
      graceTimer = setTimeout(resolve, OPTIONAL_SESSION_CANCELLATION_GRACE_MS);
    }),
  ]);
  if (graceTimer !== undefined) clearTimeout(graceTimer);
}

async function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    operation.then(() => true),
    new Promise<false>((resolve) => {
      graceTimer = setTimeout(() => resolve(false), timeoutMs);
      graceTimer.unref?.();
    }),
  ]);
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  return settled;
}

async function settleBeforeAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  inFlight: Set<Promise<unknown>>,
): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("native event consumption aborted");
  // Promise work cannot be forcibly cancelled in JavaScript. Keep ownership
  // of the operation after abort and join it before session.close(); the signal
  // provides prompt cooperative cancellation, while joining prevents an
  // abort-ignoring callback from publishing stale state after teardown.
  const pending = operation();
  inFlight.add(pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(pending);
  }
}

async function consumeTurn(
  session: NativeSession,
  controlPlane: ControlPlanePort,
  timeoutMs: number,
  runtimeInputLiveWindowMs: number,
  closeFailedSession: () => Promise<void>,
  retainFailedCleanup: (cleanup: Promise<void>, ownsSessionClose: boolean) => void,
  resolveGovernedWait?: ExecuteNativeSessionOptions["resolveGovernedWait"],
  externalSignal?: AbortSignal,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const appendAbort = new AbortController();
  const governedOperations = new Set<Promise<unknown>>();
  let governedCancellationStarted = false;
  let deferredGovernedSettlement: Promise<unknown> | null = null;
  const inputTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const eventIterator = session.events()[Symbol.asyncIterator]();
  let stopConsumer = false;
  let rejectHandoff: ((error: unknown) => void) | null = null;
  const handoffFailure = new Promise<never>((_resolve, reject) => {
    rejectHandoff = reject;
  });
  let removeExternalAbort = () => {};
  const externalAbortFailure = externalSignal
    ? new Promise<never>((_resolve, reject) => {
        const abort = () => {
          const reason = externalSignal.reason ?? new Error("native event consumption aborted");
          stopConsumer = true;
          appendAbort.abort(reason);
          reject(reason);
        };
        if (externalSignal.aborted) {
          abort();
        } else {
          externalSignal.addEventListener("abort", abort, { once: true });
          removeExternalAbort = () => externalSignal.removeEventListener("abort", abort);
        }
      })
    : new Promise<never>(() => undefined);
  const clearInputTimer = (requestId: string) => {
    const inputTimer = inputTimers.get(requestId);
    if (inputTimer !== undefined) clearTimeout(inputTimer);
    inputTimers.delete(requestId);
  };
  const consumer = (async () => {
        let eventCount = 0;
        let highestContiguousSourceSeq = 0;
        let governedResult: PrpStructuredRunResult | null = null;
        while (true) {
          const next = await eventIterator.next();
          if (stopConsumer) throw new Error("native event consumer stopped");
          if (next.done) throw new Error("native event stream closed before a turn terminal fact");
          const event = next.value;
          const receipt = await controlPlane.appendEvent(event, {
            signal: appendAbort.signal,
          });
          if (stopConsumer) throw new Error("native event consumer stopped");
          eventCount += receipt.disposition === "committed" ? 1 : 0;
          highestContiguousSourceSeq = Math.max(highestContiguousSourceSeq, receipt.highestContiguousSourceSeq);
          const payload = event.payload as Record<string, unknown>;
          const request = payload.request && typeof payload.request === "object" && !Array.isArray(payload.request)
            ? payload.request as Record<string, unknown>
            : null;
          if (
            receipt.disposition === "committed"
            && event.eventType === "runtime_request.created"
            && request?.schema === "paperclip.runtime_request.v2"
            && request.type === "input"
            && typeof request.requestId === "string"
            && typeof request.turnId === "string"
          ) {
            try {
              parsePaperclipQuestionSet(request.input);
              const requestId = request.requestId;
              const turnId = request.turnId;
              clearInputTimer(requestId);
              const inputTimer = setTimeout(() => {
                inputTimers.delete(requestId);
                if (session.handoffRuntimeRequest === undefined) {
                  rejectHandoff?.(new Error("native_runtime_request_handoff_unavailable"));
                  return;
                }
                void session.handoffRuntimeRequest({
                  requestId,
                  turnId,
                  reason: "durable_handoff",
                }).catch((error) => rejectHandoff?.(error));
              }, runtimeInputLiveWindowMs);
              inputTimer.unref?.();
              inputTimers.set(requestId, inputTimer);
            } catch {
              // Invalid structured inputs remain rejected by the driver and never become durable questions.
            }
          } else if (
            ["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"].includes(event.eventType)
            && typeof payload.requestId === "string"
          ) {
            clearInputTimer(payload.requestId);
          }
          if (governedResult === null && resolveGovernedWait) {
            governedResult = await settleBeforeAbort(
              () => Promise.resolve().then(() => resolveGovernedWait({
                turnId: event.turnId ?? null,
                event,
                signal: appendAbort.signal,
              })),
              appendAbort.signal,
              governedOperations,
            );
            if (governedResult !== null && !isTurnTerminal(event)) {
              governedCancellationStarted = true;
              await settleBeforeAbort(
                () => Promise.resolve().then(() => session.cancel?.({
                  reason: "Paperclip parked this turn on a durable governed interaction.",
                })).catch(() => undefined),
                appendAbort.signal,
                governedOperations,
              );
            }
          }
          if (isTurnTerminal(event)) {
            return { event, eventCount, highestContiguousSourceSeq, governedResult };
          }
        }
      })();
  // A timeout can win the race while an iterator is still waiting for data.
  // Observe any later consumer rejection so it cannot become process-fatal.
  void consumer.catch(() => undefined);
  try {
    return await Promise.race([
      consumer,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`native session timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
      handoffFailure,
      externalAbortFailure,
    ]);
  } catch (error) {
    stopConsumer = true;
    appendAbort.abort(error);
    // Governed callbacks carry control-plane mutation authority. Give them a
    // bounded cooperative-cancellation window. If an embedder ignores abort,
    // transfer ownership to an observed cleanup chain instead of either
    // defeating the execution timeout or closing underneath a live mutation.
    if (governedOperations.size > 0) {
      const governedSettlement = Promise.allSettled([...governedOperations]);
      if (!(await settlesWithin(governedSettlement, FAILED_OPERATION_SETTLEMENT_GRACE_MS))) {
        deferredGovernedSettlement = governedSettlement;
      }
    }
    if (!governedCancellationStarted) {
      await attemptOptionalSessionCancellation(session, "Native session event consumption failed.");
    }
    throw error;
  } finally {
    stopConsumer = true;
    // Do not let failure escape while the provider iterator still owns a live
    // subscription. Cancellation above is responsible for releasing a blocked
    // `next()`; awaiting `return()` then synchronizes the iterator's `finally`
    // teardown before the session can be closed or reused.
    const iteratorTeardown = eventIterator.return?.().catch(() => undefined);
    // The consumer may already be past `next()` and awaiting a durable append.
    // Abort is a control-plane durability boundary: appendEvent must settle
    // without committing when its signal is aborted. Join both promises so a
    // failed execution cannot be followed by a late durable write or provider
    // teardown.
    const teardownSettlement = Promise.allSettled([
      iteratorTeardown,
      consumer,
    ]);
    if (appendAbort.signal.aborted) {
      if (deferredGovernedSettlement !== null) {
        retainFailedCleanup((async () => {
          await deferredGovernedSettlement;
          await closeFailedSession();
          await teardownSettlement;
        })(), true);
      } else {
        await closeFailedSession();
        if (!(await settlesWithin(teardownSettlement, FAILED_OPERATION_SETTLEMENT_GRACE_MS))) {
          retainFailedCleanup(teardownSettlement.then(() => undefined), false);
        }
      }
    } else {
      await teardownSettlement;
    }
    if (timer !== undefined) clearTimeout(timer);
    removeExternalAbort();
    for (const inputTimer of inputTimers.values()) clearTimeout(inputTimer);
    inputTimers.clear();
  }
}

function checkpointCursor(cursor: string | null | undefined): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  const parsed = Number(cursor);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function reconcileRecoveryCursor(input: {
  controlPlane: ControlPlanePort;
  checkpoint: PersistedNativeSession;
  runId: string;
  sourceInstanceId: string;
}): Promise<PersistedNativeSession> {
  const checkpointHighWater = checkpointCursor(input.checkpoint.cursor);
  let afterSourceSeq = checkpointHighWater;
  let persistedHighWater = checkpointHighWater;
  while (true) {
    const replay = await input.controlPlane.replayEvents({
      runId: input.runId,
      sourceInstanceId: input.sourceInstanceId,
      afterSourceSeq,
      limit: 1_000,
    });
    if (replay.events.length === 0) break;
    const pageHighWater = replay.events.reduce(
      (highest, event) => Math.max(highest, event.sourceSeq),
      afterSourceSeq,
    );
    if (pageHighWater <= afterSourceSeq) {
      throw new Error("native_recovery_replay_did_not_advance");
    }
    persistedHighWater = Math.max(persistedHighWater, pageHighWater);
    afterSourceSeq = pageHighWater;
  }
  if (persistedHighWater === checkpointHighWater && input.checkpoint.cursor === String(checkpointHighWater)) {
    return input.checkpoint;
  }
  return { ...input.checkpoint, cursor: String(persistedHighWater) };
}

/**
 * Package-owned normalized session loop. Paperclip supplies persistence and
 * authority through ControlPlanePort; provider/session behavior stays here.
 */
export async function executeNativeSession(options: ExecuteNativeSessionOptions): Promise<NativeSessionExecutionResult> {
  const input = parseNativeExecutionInput(options.input);
  const descriptor = await options.backend.descriptor();
  if ("runtimeContext" in input) {
    const capabilities = descriptor.runtimeContextCapabilities;
    const unsupported = (["instructions", "skills", "mcp"] as const).filter((key) => capabilities?.[key] !== "native");
    if (unsupported.length) throw new Error(`native_runtime_context_unsupported: ${descriptor.name} does not natively realize ${unsupported.join(", ")}`);
  }
  let persistedSession = options.existingSession
    ? null
    : options.persistedSession ?? await options.controlPlane.loadSessionCheckpoint?.() ?? null;
  if (
    persistedSession
    && (
      persistedSession.identity.runId !== input.binding.runId
      || persistedSession.identity.companyId !== input.binding.companyId
      || persistedSession.identity.issueId !== input.binding.issueId
      || persistedSession.identity.agentId !== input.binding.agentId
      || input.session.normalizedSessionId === null
      || persistedSession.identity.sessionId !== input.session.normalizedSessionId
    )
  ) throw new Error("native_session_checkpoint_binding_mismatch");
  const normalizedSessionId = persistedSession?.identity.sessionId
    ?? input.session.normalizedSessionId
    ?? randomUUID();
  await options.controlPlane.openRun({
    identity: {
      runId: input.binding.runId,
      sessionId: normalizedSessionId,
      companyId: input.binding.companyId,
      issueId: input.binding.issueId,
      agentId: input.binding.agentId,
    },
    backendKind: descriptor.kind,
    sourceInstanceId: options.runnerInstanceId,
  });
  if (persistedSession) {
    persistedSession = await reconcileRecoveryCursor({
      controlPlane: options.controlPlane,
      checkpoint: persistedSession,
      runId: input.binding.runId,
      sourceInstanceId: options.runnerInstanceId,
    });
    await options.controlPlane.checkpointSession?.(persistedSession);
    await options.onCheckpoint?.(persistedSession);
  }

  const identity = {
    runId: input.binding.runId,
    sessionId: normalizedSessionId,
    companyId: input.binding.companyId,
    issueId: input.binding.issueId,
    agentId: input.binding.agentId,
  };
  let recovered = false;
  let session: NativeSession;
  let continuityBreak: {
    reason: string;
    previousDriverSessionId: string;
    previousProviderSessionId: string | null;
  } | null = null;
  if (options.existingSession) {
    if (options.existingSession.attachRun === undefined) {
      throw new Error("native_session_multi_run_unavailable");
    }
    await options.existingSession.attachRun({ identity });
    session = options.existingSession;
    recovered = true;
  } else if (persistedSession) {
    const replacementAllowed =
      persistedSession.providerRecoveryPolicy ===
      "allow_replacement_after_resume_failure";
    const recovery = options.backend.recoverSession
      ? await options.backend.recoverSession(persistedSession)
      : { recovered: false as const, reason: "driver does not support recovery" };
    if (!recovery.recovered || !recovery.session) {
      if (!replacementAllowed) {
        throw new Error(`native_session_recovery_failed: ${recovery.reason ?? "unknown"}`);
      }
      continuityBreak = {
        reason: recovery.reason ?? "provider session is no longer recoverable",
        previousDriverSessionId: persistedSession.sessionId,
        previousProviderSessionId: persistedSession.providerSessionId ?? null,
      };
      const replacementInput = {
        identity,
        workingDirectory: input.workspace.cwd,
      };
      session = options.backend.openReplacementSession
        ? await options.backend.openReplacementSession(
            replacementInput,
            persistedSession,
          )
        : await options.backend.openSession(replacementInput);
    } else {
      session = recovery.session;
      recovered = true;
    }
  } else {
    session = await options.backend.openSession({
      identity,
      workingDirectory: input.workspace.cwd,
    });
  }
  options.onSession?.(session);
  let sessionClosePromise: Promise<void> | null = null;
  const closeSession = () => {
    if (sessionClosePromise === null) {
      options.onSession?.(null);
      sessionClosePromise = session.close({
        reason: "native session execution complete",
      });
    }
    return sessionClosePromise;
  };
  let executionSucceeded = false;
  let failedCleanupOwnsSessionClose = false;
  const retainFailedCleanup = (cleanup: Promise<void>, ownsSessionClose: boolean) => {
    failedCleanupOwnsSessionClose ||= ownsSessionClose;
    // Retain and observe cleanup after the caller-facing execution settles.
    // The chain itself owns ordering; observing it prevents a late rejection
    // from becoming process-fatal without granting it mutation authority.
    void cleanup.catch(() => undefined);
  };
  try {
    const checkpoint = async () => {
      const snapshot = await session.snapshot();
      await options.controlPlane.checkpointSession?.(snapshot);
      await options.onCheckpoint?.(snapshot);
    };
    const recoveredSnapshot = await session.snapshot();
    if (continuityBreak) {
      await options.onContinuityBreak?.({
        ...continuityBreak,
        replacementDriverSessionId: recoveredSnapshot.sessionId,
        replacementProviderSessionId:
          recoveredSnapshot.providerSessionId ?? null,
      });
    }
    await options.controlPlane.checkpointSession?.(recoveredSnapshot);
    await options.onCheckpoint?.(recoveredSnapshot);

    let consumed = {
      event: null as PrpEvent | null,
      eventCount: 0,
      highestContiguousSourceSeq: 0,
      governedResult: null as PrpStructuredRunResult | null,
    };
    const completionSnapshot = recoveredSnapshot.semanticResult && recoveredSnapshot.terminal
      ? recoveredSnapshot
      : persistedSession;
    let completed = completionSnapshot?.semanticResult && completionSnapshot.terminal
      ? {
          result: completionSnapshot.semanticResult,
          terminal: completionSnapshot.terminal,
          turnId: completionSnapshot.activeTurnId ?? null,
        }
      : null;
    if (!completed) {
      const consumptionAbort = new AbortController();
      const consuming = consumeTurn(
        session,
        options.controlPlane,
        options.timeoutMs ?? 900_000,
        options.runtimeInputLiveWindowMs ?? DEFAULT_NATIVE_RUNTIME_INPUT_LIVE_WINDOW_MS,
        closeSession,
        retainFailedCleanup,
        options.resolveGovernedWait,
        consumptionAbort.signal,
      );
      // Event consumption must begin before startTurn so an eager provider cannot
      // outrun us. Observe its rejection immediately, though: if startTurn or
      // checkpointing fails first, the outer finally closes the session and the
      // abandoned consumer will reject when its stream closes. Without a handler
      // that later rejection becomes process-fatal under Node's strict policy.
      void consuming.catch(() => undefined);
      // A recovered driver is authoritative about whether a provider turn is
      // still active. In particular, drivers normalize the checkpoint race
      // where a terminal fingerprint was persisted before activeTurnId was
      // cleared. Falling back to the older control-plane checkpoint here
      // resurrects that terminal turn and waits forever for an event that was
      // already consumed.
      const recoveredActiveTurnId = recovered
        ? recoveredSnapshot.activeTurnId ?? null
        : persistedSession?.activeTurnId ?? null;
      try {
        if (!recovered || !recoveredActiveTurnId) {
          const modelEnvelope = buildNativeModelEnvelope(input);
          const dispositionOnlyRecovery = Boolean(
            recovered &&
            !recoveredSnapshot.semanticResult &&
            (persistedSession?.terminalTurns?.length ?? 0) > 0 &&
            !recoveredActiveTurnId
          );
          if (dispositionOnlyRecovery) {
            modelEnvelope.task.prompt = [
              "Paperclip semantic-result recovery for a prior completed provider turn.",
              "The prior turn already performed the work and its user-facing final answer is recorded.",
              "Do not repeat implementation, tests, research, or the final answer.",
              "Use the existing session context to invoke exactly one paperclip_finish or paperclip_block with the accurate current disposition, then stop without additional user-facing prose.",
            ].join("\n");
          }
          await session.startTurn({
            message: { role: "user", text: JSON.stringify(modelEnvelope) },
            requestedCollaborationMode: "executionMode" in input ? input.executionMode : "default",
          });
          await checkpoint();
        }
      } catch (error) {
        // Consumption starts before provider launch so eager events cannot be
        // lost. If launch or its checkpoint fails, abort any in-flight append
        // before joining cleanup so the failed turn cannot commit late or
        // strand execution on a never-settling durability call.
        consumptionAbort.abort(error);
        await consuming.catch(() => undefined);
        throw error;
      }
      const terminalEvent = await consuming;
      consumed = terminalEvent;
      completed = terminalEvent.governedResult === null
        ? await session.result()
        : {
            result: terminalEvent.governedResult,
            terminal: {
              schema: "paperclip.prp.terminal.v1",
              turnTerminalState: "completed",
              runTerminalState: "succeeded",
              reportedWorkDisposition:
                terminalEvent.governedResult.reportedWorkDisposition,
            },
            turnId: terminalEvent.event.turnId ?? null,
          };
      if (completed === null && options.resolveMissingResult) {
        const recoveredResult = await options.resolveMissingResult({
          turnId: terminalEvent.event.turnId ?? null,
          terminalEvent: terminalEvent.event,
        });
        if (recoveredResult !== null) {
          completed = {
            result: recoveredResult,
            terminal: terminalFromEvent(terminalEvent.event, recoveredResult.reportedWorkDisposition),
            turnId: terminalEvent.event.turnId ?? null,
          };
        }
      }
      await checkpoint();
    }
    if (completed === null) throw new Error("native_finalization_missing: session returned no semantic result");
    let terminal: PrpTerminalState;
    if (consumed.governedResult !== null) {
      terminal = completed.terminal;
    } else if (completionSnapshot?.semanticResult && completionSnapshot.terminal) {
      terminal = completionSnapshot.terminal;
    } else {
      terminal = terminalFromEvent(consumed.event!, completed.result.reportedWorkDisposition);
    }
    const eventTurnId = completed.turnId
      ?? persistedSession?.activeTurnId
      ?? persistedSession?.terminalTurns?.at(-1)?.turnId
      ?? consumed.event?.turnId;
    const controlEvent = (
      sourceSeq: number,
      eventType: PrpEvent["eventType"],
      payload: Record<string, unknown>,
    ): PrpEvent => ({
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${options.controlPlaneInstanceId}:${input.binding.runId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: options.controlPlaneInstanceId,
      sourceKind: "control_plane",
      runId: input.binding.runId,
      normalizedSessionId,
      ...(eventTurnId ? { turnId: eventTurnId } : {}),
      eventType,
      schemaVersion: 1,
      priority: 0,
      emittedAt: new Date().toISOString(),
      payload,
    });
    const expectedControlEvents = [
      controlEvent(1, "run.result.accepted", { result: completed.result }),
      controlEvent(2, "run.terminal", terminal as unknown as Record<string, unknown>),
    ];
    const controlReplay = await options.controlPlane.replayEvents({
      runId: input.binding.runId,
      sourceInstanceId: options.controlPlaneInstanceId,
      afterSourceSeq: 0,
      limit: 10,
    });
    const replayBySequence = new Map(controlReplay.events.map((event) => [event.sourceSeq, event]));
    for (const existing of controlReplay.events) {
      const expected = expectedControlEvents[existing.sourceSeq - 1];
      if (
        expected === undefined
        || existing.eventType !== expected.eventType
        || canonicalJson(existing.payload) !== canonicalJson(expected.payload)
      ) {
        throw new Error(`native_control_event_replay_conflict:${existing.sourceSeq}`);
      }
    }
    consumed.highestContiguousSourceSeq = Math.max(
      consumed.highestContiguousSourceSeq,
      controlReplay.highestContiguousSourceSeq,
    );
    for (const event of expectedControlEvents) {
      if (replayBySequence.has(event.sourceSeq)) continue;
      const receipt = await options.controlPlane.appendEvent(event);
      consumed.eventCount += receipt.disposition === "committed" ? 1 : 0;
      consumed.highestContiguousSourceSeq = Math.max(
        consumed.highestContiguousSourceSeq,
        receipt.highestContiguousSourceSeq,
      );
    }
    await options.controlPlane.completeRun({
      result: completed.result,
      terminal,
      turnId: completed.turnId,
      callerResultId: `${options.runnerInstanceId}:${input.binding.runId}:result`,
      callerDedupeKey: `${input.binding.runId}:${input.completionContract.sha256}`,
    });
    const snapshot = await session.snapshot();
    await options.controlPlane.checkpointSession?.({
      ...snapshot,
      semanticResult: completed.result,
      terminal,
    });
    await options.onCheckpoint?.({
      ...snapshot,
      semanticResult: completed.result,
      terminal,
    });
    const usage = await session.usage?.() ?? null;
    const executionResult = {
      result: completed.result,
      terminal,
      turnId: completed.turnId,
      normalizedSessionId,
      providerSessionId: snapshot.providerSessionId ?? null,
      driverKind: descriptor.name,
      driverVersion: typeof usage?.driverVersion === "string" ? usage.driverVersion : descriptor.version,
      nativeEventCount: consumed.eventCount,
      highestContiguousSourceSeq: consumed.highestContiguousSourceSeq,
      usage,
    };
    executionSucceeded = true;
    return executionResult;
  } finally {
    if ((!options.keepSessionOpen || !executionSucceeded) && !failedCleanupOwnsSessionClose) {
      await closeSession();
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
