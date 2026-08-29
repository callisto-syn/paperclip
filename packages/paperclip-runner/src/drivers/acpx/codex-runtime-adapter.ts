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
const activeRuntimeCleanupOwners = new Set<Promise<unknown | null>>();

class AcpxRuntimeCloseTimeoutError extends Error {
  constructor() {
    super("ACPX runtime close exceeded its shutdown timeout");
    this.name = "AcpxRuntimeCloseTimeoutError";
  }
}

export interface CodexAcpxRuntimeDependencies {
  createRuntime?: (options: AcpRuntimeOptions) => AcpRuntime;
  createRegistry?: (input: {
    overrides: Record<string, string | string[]>;
  }) => AcpAgentRegistry;
  createStore?: (input: { stateDir: string }) => AcpSessionStore;
  runtimeCloseTimeoutMs?: number;
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

  let handle: AcpRuntimeHandle;
  try {
    handle = await runtime.ensureSession({
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
    });
  } catch (error) {
    const runtimeCleanupError = failedHandshakeHandle
      ? await boundedRuntimeClose(
          runtime,
          failedHandshakeHandle,
          "ACPX session handshake failed",
          runtimeCloseTimeoutMs,
        )
      : null;
    const cleanupErrors = await children.terminate();
    if (runtimeCleanupError !== null || cleanupErrors.length > 0) {
      throw new AggregateError(
        [
          error,
          ...(runtimeCleanupError === null ? [] : [runtimeCleanupError]),
          ...cleanupErrors,
        ],
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
    const cleanupError = await boundedRuntimeClose(
      runtime,
      handle,
      "ACPX runtime identity validation failed",
      runtimeCloseTimeoutMs,
    );
    if (cleanupError !== null) {
      const processErrors = await children.terminate();
      throw new AggregateError(
        [error, cleanupError, ...processErrors],
        "ACPX runtime identity validation and cleanup failed",
      );
    }
    const processErrors = await children.terminate();
    if (processErrors.length > 0) {
      throw new AggregateError(
        [error, ...processErrors],
        "ACPX runtime identity validation and provider cleanup failed",
      );
    }
    throw error;
  }
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
      });
    },
    async close(input) {
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
    },
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
  activeRuntimeCleanupOwners.add(cleanup);
  void cleanup.finally(() => activeRuntimeCleanupOwners.delete(cleanup));
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

  add(child: ChildProcess): ChildProcess {
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
    return child;
  }

  async terminate(): Promise<unknown[]> {
    const errors: unknown[] = [];
    const children = [...this.#children];
    await Promise.all(
      children.map(async (child) => {
        if (running(child)) {
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
              errors.push(
                new Error("ACPX provider did not exit after SIGKILL"),
              );
            }
          }
        }
      }),
    );
    // A failed spawn or signal can emit `error` and then `close` before this
    // method snapshots the live children. Keep those errors independently of
    // child membership, report each object once, and drain them only after all
    // in-flight termination attempts have had a chance to emit.
    for (const error of this.#errors) pushUnique(errors, error);
    this.#errors.clear();
    return errors;
  }
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
