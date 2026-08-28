import type { ChildProcess } from "node:child_process";

import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
  type AcpAgentRegistry,
  type AcpRuntime,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpSessionStore,
} from "acpx/runtime";

import type {
  AcpxRuntimePort,
  AcpxRuntimePortIdentity,
  AcpxRuntimePortOpenOptions,
} from "./runtime-host.js";

const VERIFIED_COMMAND_SENTINEL = "paperclip-verified-acpx-command";

export interface CodexAcpxRuntimeDependencies {
  createRuntime?: (options: AcpRuntimeOptions) => AcpRuntime;
  createRegistry?: (input: {
    overrides: Record<string, string | string[]>;
  }) => AcpAgentRegistry;
  createStore?: (input: { stateDir: string }) => AcpSessionStore;
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
    throw new Error("The production ACPX runtime currently supports Codex only");
  }

  const createRegistry = dependencies.createRegistry ?? createAgentRegistry;
  const createStore = dependencies.createStore ?? createRuntimeStore;
  const createRuntime = dependencies.createRuntime ?? createAcpRuntime;
  const runtime = createRuntime({
    cwd: options.cwd,
    sessionStore: createStore({ stateDir: options.stateDirectory }),
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
    spawnEnvironment: () => definedEnvironment(options.launchEnvironment),
    spawnCwd: options.cwd,
    spawnAgent: (input) =>
      options.command.spawn(input.args, input.options) as ChildProcess,
  });

  const handle = await runtime.ensureSession({
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

  try {
    return runtimePort(runtime, handle, requireIdentity(handle));
  } catch (error) {
    try {
      await runtime.close({
        handle,
        reason: "ACPX runtime identity validation failed",
        discardPersistentState: false,
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "ACPX runtime identity validation and cleanup failed",
      );
    }
    throw error;
  }
}

function runtimePort(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
  identity: AcpxRuntimePortIdentity,
): AcpxRuntimePort {
  return {
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
    async close(input) {
      await runtime.close({
        handle,
        reason: input.reason,
        discardPersistentState: false,
      });
    },
  };
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
