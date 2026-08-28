import type {
  AcpElicitationHandler,
  AcpRuntimeEvent,
  AcpRuntimeTurnResult,
} from "acpx/runtime";

import type { NativeAcpxPermissionMode } from "../../contracts/native-execution.js";
import {
  startRunnerToolBridge,
  type RunnerToolBridge,
  type RunnerToolBridgeOptions,
} from "../runner-tool-bridge.js";
import {
  stageManagedCodexCredential,
  type ManagedCodexCredentialLease,
} from "./codex-credentials.js";
import {
  verifyQualifiedAcpxInstallation,
  type VerifiedAcpxCommandLease,
  type VerifiedAcpxInstallation,
} from "./installation-integrity.js";
import {
  requireVerifiedAcpxModel,
  type AcpxModelStatus,
} from "./model-verification.js";
import { acpxRuntimePermissionPolicy } from "./permission-policy.js";
import {
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
  type QualifiedAcpxProfile,
} from "./qualified-profiles.js";
import {
  createAcpxIdentityRecord,
  createAcpxRecoveryBinding,
  verifyExpectedAcpxIdentity,
  type AcpxIdentityRecord,
  type AcpxRecoveryBinding,
} from "./recovery-identity.js";
import {
  prepareAcpxRuntimeSandbox,
  type AcpxRuntimeSandbox,
} from "./runtime-sandbox.js";
import type { AcpxExpectedSessionIdentity } from "./sidecar-protocol.js";

export const ACPX_TURN_CANCELLATION_SHUTDOWN_BOUND_MS = 2_000;
const RUNTIME_ADMISSION_VERIFICATION_TIMEOUT_MS = 8_000;

class AcpxRuntimeAdmissionTimeoutError extends Error {
  constructor() {
    super("ACPX runtime admission verification exceeded its deadline");
    this.name = "AcpxRuntimeAdmissionTimeoutError";
  }
}

export interface AcpxRuntimePortIdentity {
  acpxRecordId: string;
  backendSessionId: string;
  agentSessionId: string;
}

export interface AcpxRuntimeTurnInput {
  text: string;
  requestId: string;
  signal?: AbortSignal;
  onElicitation?: AcpElicitationHandler;
}

export interface AcpxRuntimeTurn {
  readonly requestId: string;
  readonly promptStarted: Promise<void>;
  readonly events: AsyncIterable<AcpRuntimeEvent>;
  readonly result: Promise<AcpRuntimeTurnResult>;
  cancel(input?: { reason?: string }): Promise<void>;
  closeStream(input?: { reason?: string }): Promise<void>;
}

/** Minimal third-party ACP runtime surface admitted by the host boundary. */
export interface AcpxRuntimePort {
  identity(): Promise<AcpxRuntimePortIdentity>;
  getStatus(): Promise<AcpxModelStatus>;
  setModel?(model: string): Promise<void>;
  startTurn(input: AcpxRuntimeTurnInput): AcpxRuntimeTurn;
  close(input: { reason: string }): Promise<void>;
}

export interface AcpxRuntimePortOpenOptions {
  command: VerifiedAcpxCommandLease;
  profile: QualifiedAcpxProfile;
  cwd: string;
  stateDirectory: string;
  providerSessionKey: string;
  permissionMode: NativeAcpxPermissionMode;
  permissionPolicy: ReturnType<typeof acpxRuntimePermissionPolicy>;
  launchEnvironment: Readonly<NodeJS.ProcessEnv>;
  systemInstructions: string;
  mcpServers: readonly AcpxMcpServerBinding[];
}

export interface AcpxMcpServerBinding {
  name: string;
  url: string;
  bearerToken: string;
  runnerOwned: boolean;
}

export type AcpxSemanticToolSession = Omit<RunnerToolBridgeOptions, "secret">;

export interface AcpxRuntimeHostDependencies {
  verifyInstallation?: (
    profile: QualifiedAcpxProfile,
  ) => Promise<VerifiedAcpxInstallation>;
  openRuntime(options: AcpxRuntimePortOpenOptions): Promise<AcpxRuntimePort>;
  /** Internal test seam for the post-handshake admission deadline. */
  admissionVerificationTimeoutMs?: number;
}

export interface OpenAcpxRuntimeHostOptions {
  runtimeDirectory: string;
  normalizedSessionId: string;
  workingDirectory: string;
  agent: QualifiedAcpxAgent;
  model: string;
  permissionMode: NativeAcpxPermissionMode;
  systemInstructions?: string;
  environment?: NodeJS.ProcessEnv;
  managedCodexCredentialSourcePath?: string;
  expectedIdentity?: AcpxExpectedSessionIdentity;
  semanticTools?: AcpxSemanticToolSession;
}

export class AcpxRuntimeHost {
  readonly #runtime: AcpxRuntimePort;
  readonly #binding: AcpxRecoveryBinding;
  readonly #identity: AcpxIdentityRecord;
  readonly #sandbox: AcpxRuntimeSandbox;
  readonly #credential: ManagedCodexCredentialLease | null;
  readonly #command: VerifiedAcpxCommandLease;
  readonly #toolBridge: RunnerToolBridge | null;
  #activeTurn: AcpxRuntimeTurn | null = null;
  #closingStarted = false;
  #closePromise: Promise<void> | null = null;
  #closed = false;

  private constructor(input: {
    runtime: AcpxRuntimePort;
    binding: AcpxRecoveryBinding;
    identity: AcpxIdentityRecord;
    sandbox: AcpxRuntimeSandbox;
    credential: ManagedCodexCredentialLease | null;
    command: VerifiedAcpxCommandLease;
    toolBridge: RunnerToolBridge | null;
  }) {
    this.#runtime = input.runtime;
    this.#binding = input.binding;
    this.#identity = input.identity;
    this.#sandbox = input.sandbox;
    this.#credential = input.credential;
    this.#command = input.command;
    this.#toolBridge = input.toolBridge;
  }

  static async open(
    options: OpenAcpxRuntimeHostOptions,
    dependencies: AcpxRuntimeHostDependencies,
  ): Promise<AcpxRuntimeHost> {
    const profile = resolveQualifiedAcpxProfile(options.agent, options.model);
    const binding = await createAcpxRecoveryBinding({
      runtimeDirectory: options.runtimeDirectory,
      normalizedSessionId: options.normalizedSessionId,
      workingDirectory: options.workingDirectory,
      profile,
      requestedModel: options.model,
      permissionMode: options.permissionMode,
    });
    if (options.expectedIdentity) {
      verifyExpectedAcpxIdentity(options.expectedIdentity, binding, null);
    }
    if (
      options.agent !== "codex" &&
      options.managedCodexCredentialSourcePath !== undefined
    ) {
      throw new Error(
        "Managed Codex credentials require the Codex ACPX profile",
      );
    }

    const installation = await (
      dependencies.verifyInstallation ?? verifyQualifiedAcpxInstallation
    )(profile);
    if (installation.commandDigest !== profile.commandDigest) {
      throw new Error("Verified ACPX installation does not match its profile");
    }
    let command: VerifiedAcpxCommandLease | null = null;
    let credential: ManagedCodexCredentialLease | null = null;
    let toolBridge: RunnerToolBridge | null = null;
    let runtime: AcpxRuntimePort | null = null;
    try {
      const sandbox = await prepareAcpxRuntimeSandbox({
        binding,
        agent: options.agent,
        environment: options.environment,
      });
      if (options.agent === "codex") {
        credential = await stageManagedCodexCredential({
          agentHomeDirectory: sandbox.agentHomeDirectory,
          environment: options.environment,
          sourcePath: options.managedCodexCredentialSourcePath,
        });
      }
      command = await installation.openCommand();
      toolBridge = options.semanticTools
        ? await startRunnerToolBridge(options.semanticTools)
        : null;
      runtime = await dependencies.openRuntime({
        command,
        profile,
        cwd: binding.workspacePath,
        stateDirectory: sandbox.stateDirectory,
        providerSessionKey: binding.profileSessionKey,
        permissionMode: binding.permissionMode,
        permissionPolicy: acpxRuntimePermissionPolicy(binding.permissionMode),
        launchEnvironment: sandbox.launchEnvironment,
        systemInstructions: boundedInstructions(options.systemInstructions),
        mcpServers: toolBridge
          ? [
              {
                name: "paperclip",
                url: toolBridge.url,
                bearerToken: toolBridge.secret,
                runnerOwned: true,
              },
            ]
          : [],
      });
      const runtimeIdentity = await boundedRuntimeAdmissionVerification(
        runtime,
        profile,
        dependencies.admissionVerificationTimeoutMs ??
          RUNTIME_ADMISSION_VERIFICATION_TIMEOUT_MS,
      );
      const observedIdentity: AcpxExpectedSessionIdentity = {
        kind: "acpx",
        normalizedSessionId: binding.normalizedSessionId,
        ...runtimeIdentity,
        profileDigest: binding.profileDigest,
        workspaceDigest: binding.workspaceDigest,
        requestedModel: binding.requestedModel,
        effectiveModel: binding.effectiveModel,
        permissionMode: binding.permissionMode,
      };
      const identity = createAcpxIdentityRecord(observedIdentity, binding);
      if (options.expectedIdentity) {
        verifyExpectedAcpxIdentity(options.expectedIdentity, binding, identity);
      }
      return new AcpxRuntimeHost({
        runtime,
        binding,
        identity,
        sandbox,
        credential,
        command,
        toolBridge,
      });
    } catch (error) {
      const cleanupError = await cleanupRuntimeResources(
        runtime,
        toolBridge,
        credential,
        command,
        "ACPX runtime initialization failed",
      );
      if (cleanupError) {
        throw new AggregateError(
          [error, ...cleanupError.errors],
          "ACPX runtime initialization and cleanup failed",
        );
      }
      throw error;
    }
  }

  identity(): AcpxIdentityRecord {
    return structuredClone(this.#identity);
  }

  binding(): AcpxRecoveryBinding {
    return structuredClone(this.#binding);
  }

  runtimeRoot(): string {
    return this.#sandbox.root;
  }

  persistedEnvironment(): Readonly<NodeJS.ProcessEnv> {
    return Object.freeze({ ...this.#sandbox.persistedEnvironment });
  }

  async status(): Promise<AcpxModelStatus> {
    return structuredClone(await this.#runtime.getStatus());
  }

  startTurn(input: AcpxRuntimeTurnInput): AcpxRuntimeTurn {
    if (this.#closed || this.#closingStarted) {
      throw new Error("ACPX runtime host is closing");
    }
    if (this.#activeTurn) {
      throw new Error("ACPX runtime host already has an active turn");
    }
    const requestId = boundedRequestId(input.requestId);
    const text = boundedTurnText(input.text);
    const turn = this.#runtime.startTurn({
      text,
      requestId,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onElicitation
        ? { onElicitation: input.onElicitation }
        : {}),
    });
    this.#activeTurn = turn;
    void turn.result
      .finally(() => {
        // Once shutdown owns this turn, retain its cancellation handle until
        // runtime cleanup succeeds. The result may settle while cleanup is
        // failing, and a later close must still be able to retry cancellation.
        if (this.#activeTurn === turn && !this.#closingStarted) {
          this.#activeTurn = null;
        }
      })
      .catch(() => undefined);
    return turn;
  }

  async interruptActiveTurn(reason: string): Promise<void> {
    const turn = this.#activeTurn;
    if (!turn) throw new Error("ACPX runtime host has no active turn");
    const cancellationError = await boundedCancellation(
      turn.cancel({ reason: boundedReason(reason) }),
    );
    if (cancellationError) throw cancellationError;
  }

  async close(input: { reason: string }): Promise<void> {
    if (this.#closed) return;
    if (this.#closePromise) {
      return await this.#closePromise;
    }
    this.#closingStarted = true;
    const closePromise = this.#close(boundedReason(input.reason));
    this.#closePromise = closePromise;
    try {
      await closePromise;
      this.#closed = true;
    } finally {
      if (this.#closePromise === closePromise) this.#closePromise = null;
    }
  }

  async #close(reason: string): Promise<void> {
    const errors: unknown[] = [];
    const activeTurn = this.#activeTurn;
    if (activeTurn) {
      try {
        const cancellationError = await boundedCancellation(
          activeTurn.cancel({ reason }),
        );
        if (cancellationError) errors.push(cancellationError);
      } catch (error) {
        errors.push(error);
      }
    }
    const cleanupError = await cleanupRuntimeResources(
      this.#runtime,
      this.#toolBridge,
      this.#credential,
      this.#command,
      reason,
    );
    if (cleanupError) errors.push(...cleanupError.errors);
    if (!cleanupError) {
      // Runtime, credential, and command ownership has been relinquished even
      // when the provider never acknowledged turn cancellation. Preserve that
      // cancellation error for this caller, but make later close calls
      // idempotently observe the successfully closed host.
      if (this.#activeTurn === activeTurn) this.#activeTurn = null;
      this.#closed = true;
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "ACPX runtime cleanup failed");
    }
  }
}

async function boundedRuntimeAdmissionVerification(
  runtime: AcpxRuntimePort,
  profile: QualifiedAcpxProfile,
  timeoutMs: number,
): Promise<AcpxRuntimePortIdentity> {
  const verification = Promise.resolve().then(async () => {
    await requireVerifiedAcpxModel(runtime, profile);
    return await runtime.identity();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      verification,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AcpxRuntimeAdmissionTimeoutError()),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function boundedCancellation(
  cancellation: Promise<void>,
): Promise<unknown | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    cancellation.then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    ),
    new Promise<{ error: unknown }>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            error: new Error(
              "ACPX turn cancellation exceeded its shutdown timeout",
            ),
          }),
        ACPX_TURN_CANCELLATION_SHUTDOWN_BOUND_MS,
      );
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return outcome.error;
}

async function cleanupRuntimeResources(
  runtime: AcpxRuntimePort | null,
  toolBridge: RunnerToolBridge | null,
  credential: ManagedCodexCredentialLease | null,
  command: VerifiedAcpxCommandLease | null,
  reason: string,
): Promise<AggregateError | null> {
  const closes = [
    runtime ? () => runtime.close({ reason }) : null,
    toolBridge ? () => toolBridge.close() : null,
    credential ? () => credential.close() : null,
    command ? () => command.close() : null,
  ].filter((close): close is () => Promise<void> => close !== null);
  // Start every independent cleanup together. A protocol close that remains
  // pending must not prevent credential, tool-bridge, or command ownership
  // from being relinquished while its exact promise stays owned upstream.
  const outcomes = await Promise.all(
    closes.map(async (close) => {
      try {
        await close();
        return null;
      } catch (error) {
        return error;
      }
    }),
  );
  const errors = outcomes.filter((error): error is unknown => error !== null);
  return errors.length > 0
    ? new AggregateError(errors, "ACPX runtime cleanup failed")
    : null;
}

function boundedInstructions(value: string | undefined): string {
  const instructions = value ?? "";
  if (Buffer.byteLength(instructions) > 256 * 1024) {
    throw new Error("ACPX system instructions exceed their bounded size");
  }
  return instructions;
}

function boundedReason(value: string): string {
  const reason = value.trim().slice(0, 1_000);
  return reason || "ACPX runtime closed";
}

function boundedRequestId(value: string): string {
  const requestId = value.trim();
  if (
    requestId.length === 0 ||
    requestId !== value ||
    Buffer.byteLength(requestId) > 1_024
  ) {
    throw new Error("ACPX turn request id is outside its bounded size");
  }
  return requestId;
}

function boundedTurnText(value: string): string {
  if (Buffer.byteLength(value) > 1024 * 1024) {
    throw new Error("ACPX turn text exceeds its bounded size");
  }
  return value;
}
