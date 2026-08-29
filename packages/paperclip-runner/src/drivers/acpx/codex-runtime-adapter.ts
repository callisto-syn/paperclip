import type { ChildProcess } from "node:child_process";

import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
  encodeAcpxRuntimeHandleState,
  type AcpAgentRegistry,
  type AcpRuntime,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpSessionRecord,
  type AcpSessionStore,
} from "acpx/runtime";

import type {
  AcpxRuntimePort,
  AcpxRuntimePortIdentity,
  AcpxRuntimePortOpenOptions,
} from "./runtime-host.js";
import { decideAcpxPermission } from "./permission-policy.js";

const VERIFIED_COMMAND_SENTINEL = "paperclip-verified-acpx-command";
const DEFAULT_RUNTIME_CLOSE_TIMEOUT_MS = 2_000;
const PROVIDER_TERM_EXIT_TIMEOUT_MS = 2_000;
const PROVIDER_KILL_EXIT_TIMEOUT_MS = 2_000;
const MAX_LATE_RUNTIME_CLEANUP_RECONCILIATION_ATTEMPTS = 3;
// Production shutdown waits for the protocol close bound before beginning the
// sequential TERM/KILL verification windows. Keep this exported package-local
// bound aligned with the implementation so admission can include the complete
// provider cleanup path instead of accounting for only part of it.
export const DEFAULT_CODEX_ACPX_RUNTIME_SHUTDOWN_BOUND_MS =
  DEFAULT_RUNTIME_CLOSE_TIMEOUT_MS +
  PROVIDER_TERM_EXIT_TIMEOUT_MS +
  PROVIDER_KILL_EXIT_TIMEOUT_MS;
// A close may outlive its caller-facing wait bound. Keep every exact attempt
// owned until it settles even after the port releases it for a bounded retry.
// This prevents abandoned protocol work from being garbage-collected without
// letting one permanently pending attempt block all future recovery.
const activeRuntimeCleanupOwners = new Set<Promise<unknown>>();
const SESSION_HANDSHAKE_TIMEOUT_MS = 8_000;

class AcpxRuntimeCloseTimeoutError extends Error {
  constructor() {
    super("ACPX runtime close exceeded its shutdown timeout");
    this.name = "AcpxRuntimeCloseTimeoutError";
  }
}

class AcpxSessionHandshakeTimeoutError extends Error {
  constructor() {
    super("ACPX session handshake exceeded its admission deadline");
    this.name = "AcpxSessionHandshakeTimeoutError";
  }
}

export interface CodexAcpxRuntimeDependencies {
  createRuntime?: (options: AcpRuntimeOptions) => AcpRuntime;
  createRegistry?: (input: {
    overrides: Record<string, string | string[]>;
  }) => AcpAgentRegistry;
  createStore?: (input: { stateDir: string }) => AcpSessionStore;
  runtimeCloseTimeoutMs?: number;
  /** Internal test seam for the provider-session admission deadline. */
  sessionHandshakeTimeoutMs?: number;
  /** Retains autonomous cleanup ownership across the sidecar lifecycle. */
  retainCleanup?: (cleanup: Promise<void>) => void;
}

/**
 * Adapt the pinned ACPX library to Paperclip's admitted runtime port. The
 * executable, launch environment, and spawn cwd stay host-owned and are never
 * persisted in ACPX's session options.
 */
export async function openCodexAcpxRuntime(
  options: AcpxRuntimePortOpenOptions,
  dependencies: CodexAcpxRuntimeDependencies = {},
): Promise<AcpxRuntimePort> {
  if (options.profile.agent !== "codex") {
    throw new Error(
      "The production ACPX runtime currently supports Codex only",
    );
  }

  const createRegistry = dependencies.createRegistry ?? createAgentRegistry;
  const createStore = dependencies.createStore ?? createRuntimeStore;
  const createRuntime = dependencies.createRuntime ?? createAcpRuntime;
  const runtimeCloseTimeoutMs =
    dependencies.runtimeCloseTimeoutMs ?? DEFAULT_RUNTIME_CLOSE_TIMEOUT_MS;
  const children = new SpawnedChildSet();
  const baseStore = createStore({ stateDir: options.stateDirectory });
  let failedHandshakeHandle: AcpRuntimeHandle | null = null;
  const rememberHandshakeHandle = (record: AcpSessionRecord): void => {
    const runtimeSessionName = record.name?.trim();
    if (
      typeof record.acpxRecordId !== "string"
      || record.acpxRecordId.length === 0
      || !runtimeSessionName
      || record.cwd !== options.cwd
    ) {
      return;
    }
    failedHandshakeHandle = {
      sessionKey: options.providerSessionKey,
      backend: "acpx",
      runtimeSessionName: encodeAcpxRuntimeHandleState({
        name: runtimeSessionName,
        agent: "codex",
        cwd: record.cwd,
        mode: "persistent",
        acpxRecordId: record.acpxRecordId,
        backendSessionId: record.acpSessionId,
        agentSessionId: record.agentSessionId,
      }),
      cwd: record.cwd,
      acpxRecordId: record.acpxRecordId,
      backendSessionId: record.acpSessionId,
      ...(record.agentSessionId
        ? { agentSessionId: record.agentSessionId }
        : {}),
    };
  };
  const sessionStore: AcpSessionStore = {
    async load(sessionId) {
      const record = await baseStore.load(sessionId);
      if (record !== undefined) rememberHandshakeHandle(record);
      return record;
    },
    async save(record) {
      // ACPX has already created this runtime-owned identity before it asks
      // the store to persist it. Capture cleanup authority first so a storage
      // rejection cannot orphan the live session created by the handshake.
      rememberHandshakeHandle(record);
      await baseStore.save(record);
    },
  };
  const runnerOwnedMcpServerNames = new Set(
    options.mcpServers
      .filter((server) => server.runnerOwned)
      .map((server) => server.name),
  );
  const runtime = createRuntime({
    cwd: options.cwd,
    sessionStore,
    agentRegistry: createRegistry({
      overrides: { codex: [VERIFIED_COMMAND_SENTINEL] },
    }),
    permissionMode: options.permissionMode,
    elicitationModes: ["form"],
    nonInteractivePermissions: "fail",
    permissionPolicy: {
      ...options.permissionPolicy,
      autoApprove: options.permissionPolicy.autoApprove
        ? [...options.permissionPolicy.autoApprove]
        : undefined,
      escalate: options.permissionPolicy.escalate
        ? [...options.permissionPolicy.escalate]
        : undefined,
    },
    mcpServers: options.mcpServers.map((server) => ({
      type: "http" as const,
      name: server.name,
      url: server.url,
      headers: [
        { name: "Authorization", value: `Bearer ${server.bearerToken}` },
      ],
    })),
    onPermissionRequest: async (request) => {
      const disposition = decideAcpxPermission(
        options.profile.agent,
        options.permissionMode,
        request,
        {
          runnerOwnedMcpServerNames,
          allConfiguredMcpServersAreRunnerOwned:
            options.mcpServers.length > 0 &&
            options.mcpServers.every((server) => server.runnerOwned),
        },
      );
      return disposition === "delegate" ? undefined : { outcome: disposition };
    },
    spawnEnvironment: () => definedEnvironment(options.launchEnvironment),
    spawnCwd: options.cwd,
    spawnAgent: (input) =>
      children.add(
        options.command.spawn(input.args, input.options) as ChildProcess,
      ),
  });

  const handshake = Promise.resolve().then(() =>
    runtime.ensureSession({
      sessionKey: options.providerSessionKey,
      agent: "codex",
      mode: "persistent",
      cwd: options.cwd,
      sessionOptions: {
        model: options.profile.qualificationModel,
        ...(options.systemInstructions
          ? { systemPrompt: { append: options.systemInstructions } }
          : {}),
      },
    }),
  );
  let handle: AcpRuntimeHandle;
  try {
    handle = await boundedSessionHandshake(
      handshake,
      dependencies.sessionHandshakeTimeoutMs ?? SESSION_HANDSHAKE_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof AcpxSessionHandshakeTimeoutError) {
      const lateCleanup = lateHandshakeCleanup(
        runtime,
        handshake,
        children,
        runtimeCloseTimeoutMs,
      );
      dependencies.retainCleanup?.(lateCleanup);
      // The adapter remains safe for non-sidecar callers: cleanup still runs,
      // and its eventual rejection is observed even without an owner hook.
      void lateCleanup.catch(() => undefined);
    }
    const cleanupErrors = await cleanupFailedRuntimeOpen(
      runtime,
      failedHandshakeHandle,
      children,
      "ACPX session handshake failed",
      runtimeCloseTimeoutMs,
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "ACPX session handshake and runtime cleanup failed",
      );
    }
    throw error;
  }

  try {
    return runtimePort(
      runtime,
      handle,
      requireIdentity(handle),
      children,
      runtimeCloseTimeoutMs,
    );
  } catch (error) {
    const cleanupErrors = await cleanupFailedRuntimeOpen(
      runtime,
      handle,
      children,
      "ACPX runtime identity validation failed",
      runtimeCloseTimeoutMs,
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "ACPX runtime identity validation and cleanup failed",
      );
    }
    throw error;
  }
}

async function boundedSessionHandshake(
  handshake: Promise<AcpRuntimeHandle>,
  timeoutMs: number,
): Promise<AcpRuntimeHandle> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handshake,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AcpxSessionHandshakeTimeoutError()),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function lateHandshakeCleanup(
  runtime: AcpRuntime,
  handshake: Promise<AcpRuntimeHandle>,
  children: SpawnedChildSet,
  runtimeCloseTimeoutMs: number,
): Promise<void> {
  return handshake.then(
    async (lateHandle) => {
      const errors = await cleanupFailedRuntimeOpen(
        runtime,
        lateHandle,
        children,
        "ACPX session handshake completed after its admission deadline",
        runtimeCloseTimeoutMs,
      );
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "ACPX late-handshake runtime cleanup failed",
        );
      }
    },
    () => undefined,
  );
}

async function cleanupFailedRuntimeOpen(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle | null,
  children: SpawnedChildSet,
  reason: string,
  timeoutMs: number,
): Promise<unknown[]> {
  const closeError = handle
    ? await boundedRuntimeClose(runtime, handle, reason, timeoutMs)
    : null;
  const errors = await children.terminate();
  if (closeError !== null) errors.unshift(closeError);
  return errors;
}

function runtimePort(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
  identity: AcpxRuntimePortIdentity,
  children: SpawnedChildSet,
  runtimeCloseTimeoutMs: number,
): AcpxRuntimePort {
  let runtimeClosed = false;
  let runtimeCloseAttempt: Promise<unknown | null> | undefined;
  let lateReconciliationOwner: Promise<void> | undefined;
  let lateReconciliationAttempts = 0;
  const watchedReleasedAttempts = new Set<Promise<unknown | null>>();

  const scheduleLateFailureReconciliation = (): void => {
    if (runtimeCloseAttempt || lateReconciliationOwner || runtimeClosed) return;
    const attemptNumber = lateReconciliationAttempts + 1;
    let retry = false;
    const reconciliation = closeRuntime({
      reason:
        `ACPX late protocol cleanup reconciliation ${attemptNumber}`,
    }).then(
      () => {
        lateReconciliationAttempts = 0;
      },
      () => {
        lateReconciliationAttempts = attemptNumber;
        retry = attemptNumber < MAX_LATE_RUNTIME_CLEANUP_RECONCILIATION_ATTEMPTS;
      },
    );
    const owner = reconciliation.finally(() => {
      if (lateReconciliationOwner === owner) lateReconciliationOwner = undefined;
      if (retry) queueMicrotask(scheduleLateFailureReconciliation);
    });
    lateReconciliationOwner = owner;
    retainRuntimeCleanupOwner(owner);
  };

  const watchReleasedAttempt = (attempt: Promise<unknown | null>): void => {
    if (watchedReleasedAttempts.has(attempt)) return;
    watchedReleasedAttempts.add(attempt);
    void attempt.then((error) => {
      watchedReleasedAttempts.delete(attempt);
      if (error === null) return;
      // A newer successful close cannot erase an older outcome that had not
      // settled yet. Re-open cleanup state and autonomously create a bounded
      // reconciliation generation so the late failure is not suppression-only.
      runtimeClosed = false;
      scheduleLateFailureReconciliation();
    });
  };

  async function closeRuntime(input: { reason: string }): Promise<void> {
    if (runtimeClosed) return;
    runtimeCloseAttempt ??= runtimeCloseOutcome(runtime, handle, input.reason);
    const observedAttempt = runtimeCloseAttempt;
    const processCleanup = terminateChildrenAfterCloseBound(
      observedAttempt,
      children,
      runtimeCloseTimeoutMs,
    );
    // The caller may stop waiting, but the exact ACPX protocol cleanup stays
    // owned until it settles. Provider termination proceeds at the deadline;
    // after this bounded observation finishes a later close may make a fresh
    // protocol attempt instead of inheriting a permanently pending promise.
    const [closeError, processErrors] = await Promise.all([
      boundedCloseOutcome(observedAttempt, runtimeCloseTimeoutMs),
      processCleanup,
    ]);
    if (closeError instanceof AcpxRuntimeCloseTimeoutError) {
      watchReleasedAttempt(observedAttempt);
    }
    if (runtimeCloseAttempt === observedAttempt) {
      runtimeCloseAttempt = undefined;
    }
    if (processErrors.length === 0 && closeError === null) {
      runtimeClosed = true;
    }
    if (closeError !== null || processErrors.length > 0) {
      const errors = [closeError, ...processErrors].filter(
        (error): error is unknown => error !== null,
      );
      throw new AggregateError(
        errors,
        "ACPX runtime and provider cleanup failed",
      );
    }
  }

  const port: AcpxRuntimePort = {
    async identity() {
      return structuredClone(identity);
    },
    async getStatus() {
      if (!runtime.getStatus) {
        throw new Error("The pinned ACPX runtime cannot report session status");
      }
      return structuredClone(await runtime.getStatus({ handle }));
    },
    ...(runtime.setConfigOption
      ? {
          async setModel(model: string) {
            await runtime.setConfigOption?.({
              handle,
              key: "model",
              value: model,
            });
          },
        }
      : {}),
    startTurn(input) {
      return runtime.startTurn({
        handle,
        text: input.text,
        mode: "prompt",
        requestId: input.requestId,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onElicitation ? { onElicitation: input.onElicitation } : {}),
      });
    },
    close: closeRuntime,
  };
  return port;
}

async function boundedRuntimeClose(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
  reason: string,
  timeoutMs: number,
): Promise<unknown | null> {
  return await boundedCloseOutcome(
    runtimeCloseOutcome(runtime, handle, reason),
    timeoutMs,
  );
}

function runtimeCloseOutcome(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
  reason: string,
): Promise<unknown | null> {
  const cleanup = Promise.resolve()
    .then(() =>
      runtime.close({ handle, reason, discardPersistentState: false }),
    )
    .then(
      () => null,
      (error: unknown) => error,
    );
  return retainRuntimeCleanupOwner(cleanup);
}

function retainRuntimeCleanupOwner<T>(cleanup: Promise<T>): Promise<T> {
  activeRuntimeCleanupOwners.add(cleanup);
  void cleanup
    .finally(() => activeRuntimeCleanupOwners.delete(cleanup))
    .catch(() => undefined);
  return cleanup;
}

async function terminateChildrenAfterCloseBound(
  closeOutcome: Promise<unknown | null>,
  children: SpawnedChildSet,
  timeoutMs: number,
): Promise<unknown[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closeOutcome.then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(1, Math.floor(timeoutMs)));
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return await children.terminate();
}

async function boundedCloseOutcome(
  closeOutcome: Promise<unknown | null>,
  timeoutMs: number,
): Promise<unknown | null> {
  const boundedTimeoutMs = Math.max(1, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    closeOutcome.then((error) => ({ error })),
    new Promise<{ error: unknown }>((resolve) => {
      timer = setTimeout(
        () => resolve({ error: new AcpxRuntimeCloseTimeoutError() }),
        boundedTimeoutMs,
      );
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return outcome.error;
}

class SpawnedChildSet {
  readonly #children = new Set<ChildProcess>();
  readonly #errors = new Set<unknown>();
  readonly #terminations = new Map<ChildProcess, Promise<unknown[]>>();
  #terminating = false;
  #sealed = false;

  add(child: ChildProcess): ChildProcess {
    if (this.#sealed) {
      // Once the stable-empty cleanup point is sealed, ACPX no longer has
      // authority to create provider work. Kill a violating late child before
      // returning control to the runtime and reject the spawn itself.
      try {
        if (running(child)) child.kill("SIGKILL");
      } finally {
        closeUnresponsiveChildStreams(child);
      }
      throw new Error("ACPX provider spawned after cleanup was sealed");
    }
    this.#children.add(child);
    const onError = (error: unknown) => this.#errors.add(error);
    const forget = () => this.#children.delete(child);
    const forgetAndDetach = () => {
      forget();
      child.off("error", onError);
    };
    // ChildProcess reports some spawn and signal-delivery failures through an
    // asynchronous `error` event. Observe those for the child's whole tracked
    // lifetime so cleanup can report them instead of crashing runnerd.
    child.on("error", onError);
    child.once("exit", forget);
    child.once("close", forgetAndDetach);
    if (this.#terminating) this.#startTermination(child);
    return child;
  }

  async terminate(): Promise<unknown[]> {
    this.#terminating = true;
    for (const child of this.#children) this.#startTermination(child);
    const errors: unknown[] = [];
    // A provider can be spawned while another child is between TERM and KILL.
    // Keep joining tracked attempts until the owned set reaches a stable empty
    // point so failed admission and sidecar shutdown cannot lose that child.
    while (this.#terminations.size > 0) {
      for (const error of (await Promise.all([...this.#terminations.values()])).flat()) {
        pushUnique(errors, error);
      }
    }
    // JavaScript cannot interleave another spawn between this synchronous
    // empty check and the seal. Children added before it are tracked by the
    // loop; children added afterward are synchronously killed by add().
    this.#sealed = true;
    // A failed spawn or signal can emit `error` and then `close` before this
    // method snapshots the live children. Keep those errors independently of
    // child membership and report each object once after all owned attempts.
    for (const error of this.#errors) pushUnique(errors, error);
    this.#errors.clear();
    return errors;
  }

  #startTermination(child: ChildProcess): Promise<unknown[]> {
    const existing = this.#terminations.get(child);
    if (existing) return existing;
    const termination = terminateChild(child).catch((error: unknown) => [error]);
    this.#terminations.set(child, termination);
    termination.then(() => {
      if (this.#terminations.get(child) === termination) {
        this.#terminations.delete(child);
      }
    });
    return termination;
  }
}

async function terminateChild(child: ChildProcess): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (!running(child)) return errors;
  const terminateOutcome = await signalAndWaitForExit(
    child,
    "SIGTERM",
    PROVIDER_TERM_EXIT_TIMEOUT_MS,
  );
  if (terminateOutcome.error !== undefined) {
    pushUnique(errors, terminateOutcome.error);
  }
  if (!terminateOutcome.exited && running(child)) {
    const killOutcome = await signalAndWaitForExit(
      child,
      "SIGKILL",
      PROVIDER_KILL_EXIT_TIMEOUT_MS,
    );
    if (killOutcome.error !== undefined) {
      pushUnique(errors, killOutcome.error);
    }
    if (!killOutcome.exited && running(child)) {
      errors.push(new Error("ACPX provider did not exit after SIGKILL"));
      errors.push(...closeUnresponsiveChildStreams(child));
    }
  }
  return errors;
}

function closeUnresponsiveChildStreams(child: ChildProcess): unknown[] {
  const errors: unknown[] = [];
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (!stream) continue;
    try {
      stream.destroy();
    } catch (error) {
      errors.push(error);
    }
  }
  // Do not unref a provider that ignored SIGKILL. Keeping the child-process
  // handle referenced prevents the sidecar from exiting while it still owns a
  // live provider and makes the failed cleanup externally observable.
  return errors;
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function signalAndWaitForExit(
  child: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<{ exited: boolean; error?: unknown }> {
  if (!running(child)) return { exited: true };
  return await new Promise<{ exited: boolean; error?: unknown }>((resolve) => {
    let settled = false;
    const finish = (outcome: { exited: boolean; error?: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      child.off("error", onError);
      resolve(outcome);
    };
    const onExit = () => finish({ exited: true });
    const onError = (error: unknown) => finish({ exited: false, error });
    const timer = setTimeout(() => finish({ exited: false }), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    child.once("close", onExit);
    child.once("error", onError);
    if (!running(child)) {
      finish({ exited: true });
      return;
    }
    try {
      child.kill(signal);
      if (!running(child)) finish({ exited: true });
    } catch (error) {
      finish({ exited: false, error });
    }
  });
}

function pushUnique(errors: unknown[], error: unknown): void {
  if (!errors.includes(error)) errors.push(error);
}

function requireIdentity(handle: AcpRuntimeHandle): AcpxRuntimePortIdentity {
  const identity = {
    acpxRecordId: handle.acpxRecordId,
    backendSessionId: handle.backendSessionId,
    agentSessionId: handle.agentSessionId,
  };
  for (const [name, value] of Object.entries(identity)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`ACPX runtime omitted ${name}`);
    }
  }
  return identity as AcpxRuntimePortIdentity;
}

function definedEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
