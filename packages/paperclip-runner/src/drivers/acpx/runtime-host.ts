import type {
  AcpRuntimeEvent,
  AcpRuntimeTurnResult,
} from "acpx/runtime";

import type { NativeAcpxPermissionMode } from "../../contracts/native-execution.js";
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

export interface AcpxRuntimePortIdentity {
  acpxRecordId: string;
  backendSessionId: string;
  agentSessionId: string;
}

export interface AcpxRuntimeTurnInput {
  text: string;
  requestId: string;
  signal?: AbortSignal;
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
}

export interface AcpxRuntimeHostDependencies {
  verifyInstallation?: (
    profile: QualifiedAcpxProfile,
  ) => Promise<VerifiedAcpxInstallation>;
  openRuntime(options: AcpxRuntimePortOpenOptions): Promise<AcpxRuntimePort>;
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
}

export class AcpxRuntimeHost {
  readonly #runtime: AcpxRuntimePort;
  readonly #binding: AcpxRecoveryBinding;
  readonly #identity: AcpxIdentityRecord;
  readonly #sandbox: AcpxRuntimeSandbox;
  readonly #credential: ManagedCodexCredentialLease | null;
  readonly #command: VerifiedAcpxCommandLease;
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
  }) {
    this.#runtime = input.runtime;
    this.#binding = input.binding;
    this.#identity = input.identity;
    this.#sandbox = input.sandbox;
    this.#credential = input.credential;
    this.#command = input.command;
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
      });
      await requireVerifiedAcpxModel(runtime, profile);
      const runtimeIdentity = await runtime.identity();
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
      });
    } catch (error) {
      const cleanupError = await cleanupRuntimeResources(
        runtime,
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
    });
    this.#activeTurn = turn;
    void turn.result
      .finally(() => {
        if (this.#activeTurn === turn) this.#activeTurn = null;
      })
      .catch(() => undefined);
    return turn;
  }

  async close(input: { reason: string }): Promise<void> {
    if (this.#closed) return;
    if (this.#closePromise) return await this.#closePromise;
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
    if (this.#activeTurn) {
      try {
        await this.#activeTurn.cancel({ reason });
      } catch (error) {
        errors.push(error);
      }
    }
    const cleanupError = await cleanupRuntimeResources(
      this.#runtime,
      this.#credential,
      this.#command,
      reason,
    );
    if (cleanupError) errors.push(...cleanupError.errors);
    if (errors.length > 0) {
      throw new AggregateError(errors, "ACPX runtime cleanup failed");
    }
  }
}

async function cleanupRuntimeResources(
  runtime: AcpxRuntimePort | null,
  credential: ManagedCodexCredentialLease | null,
  command: VerifiedAcpxCommandLease | null,
  reason: string,
): Promise<AggregateError | null> {
  const errors: unknown[] = [];
  for (const close of [
    runtime ? () => runtime.close({ reason }) : null,
    credential ? () => credential.close() : null,
    command ? () => command.close() : null,
  ]) {
    if (!close) continue;
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
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
