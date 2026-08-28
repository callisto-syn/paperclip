import type { ChildProcess } from "node:child_process";

import type {
  AcpAgentRegistry,
  AcpRuntime,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpSessionStore,
} from "acpx/runtime";
import { describe, expect, it, vi } from "vitest";

import type { VerifiedAcpxCommandLease } from "./installation-integrity.js";
import { openCodexAcpxRuntime } from "./codex-runtime-adapter.js";
import type { AcpxRuntimePortOpenOptions } from "./runtime-host.js";

const HANDLE: AcpRuntimeHandle = {
  sessionKey: "session-key",
  backend: "acpx",
  runtimeSessionName: "runtime-name",
  cwd: "/workspace",
  acpxRecordId: "record-1",
  backendSessionId: "backend-1",
  agentSessionId: "agent-1",
};

describe("Codex ACPX runtime adapter", () => {
  it("opens a persistent Codex session without persisting launch secrets", async () => {
    const runtime = fakeRuntime();
    let runtimeOptions: AcpRuntimeOptions | undefined;
    const command = fakeCommand();
    const port = await openCodexAcpxRuntime(openOptions(command), {
      createRegistry: ({ overrides }) => {
        expect(overrides).toEqual({
          codex: ["paperclip-verified-acpx-command"],
        });
        return registry();
      },
      createStore: ({ stateDir }) => {
        expect(stateDir).toBe("/runtime/state");
        return store();
      },
      createRuntime: (options) => {
        runtimeOptions = options;
        return runtime;
      },
    });

    expect(runtime.ensureSession).toHaveBeenCalledWith({
      sessionKey: "provider-key",
      agent: "codex",
      mode: "persistent",
      cwd: "/workspace",
      sessionOptions: {
        model: "gpt-5.6-sol",
        systemPrompt: { append: "Use Paperclip tools." },
      },
    });
    expect(
      JSON.stringify(vi.mocked(runtime.ensureSession).mock.calls[0]?.[0]),
    ).not.toContain("credential-secret");
    expect(runtimeOptions?.spawnEnvironment?.()).toEqual({
      CODEX_HOME: "/runtime/agent-home",
      OPENAI_API_KEY: "credential-secret",
    });
    expect(runtimeOptions?.spawnCwd).toBe("/workspace");
    expect(await port.identity()).toEqual({
      acpxRecordId: "record-1",
      backendSessionId: "backend-1",
      agentSessionId: "agent-1",
    });
  });

  it("launches only through the verified command lease", async () => {
    const runtime = fakeRuntime();
    let runtimeOptions: AcpRuntimeOptions | undefined;
    const command = fakeCommand();
    await openCodexAcpxRuntime(openOptions(command), {
      createRegistry: () => registry(),
      createStore: () => store(),
      createRuntime: (options) => {
        runtimeOptions = options;
        return runtime;
      },
    });
    const child = {} as ChildProcess;
    vi.mocked(command.spawn).mockReturnValue(child);
    const spawnOptions = { cwd: "/runtime/spawn" };

    expect(
      runtimeOptions?.spawnAgent?.({
        command: "/attacker/replacement",
        args: ["--stdio"],
        options: spawnOptions,
      }),
    ).toBe(child);
    expect(command.spawn).toHaveBeenCalledWith(["--stdio"], spawnOptions);
  });

  it("maps status, model selection, and state-preserving close", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.getStatus!).mockResolvedValue({
      models: {
        currentModelId: "gpt-5.6-sol",
        availableModelIds: ["gpt-5.6-sol"],
      },
    });
    const port = await openCodexAcpxRuntime(openOptions(fakeCommand()), {
      createRegistry: () => registry(),
      createStore: () => store(),
      createRuntime: () => runtime,
    });

    expect(await port.getStatus()).toEqual({
      models: {
        currentModelId: "gpt-5.6-sol",
        availableModelIds: ["gpt-5.6-sol"],
      },
    });
    await port.setModel?.("gpt-5.6-sol");
    expect(runtime.setConfigOption).toHaveBeenCalledWith({
      handle: HANDLE,
      key: "model",
      value: "gpt-5.6-sol",
    });
    await port.close({ reason: "test complete" });
    expect(runtime.close).toHaveBeenCalledWith({
      handle: HANDLE,
      reason: "test complete",
      discardPersistentState: false,
    });
  });

  it("fails closed and closes the session when ACPX omits recovery identity", async () => {
    const runtime = fakeRuntime({ ...HANDLE, agentSessionId: undefined });
    await expect(
      openCodexAcpxRuntime(openOptions(fakeCommand()), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: () => runtime,
      }),
    ).rejects.toThrow("ACPX runtime omitted agentSessionId");
    expect(runtime.close).toHaveBeenCalledWith({
      handle: { ...HANDLE, agentSessionId: undefined },
      reason: "ACPX runtime identity validation failed",
      discardPersistentState: false,
    });
  });

  it("rejects non-Codex profiles before constructing ACPX", async () => {
    const createRuntime = vi.fn();
    await expect(
      openCodexAcpxRuntime(
        {
          ...openOptions(fakeCommand()),
          profile: {
            ...openOptions(fakeCommand()).profile,
            agent: "claude",
          },
        },
        { createRuntime },
      ),
    ).rejects.toThrow("currently supports Codex only");
    expect(createRuntime).not.toHaveBeenCalled();
  });
});

function openOptions(
  command: VerifiedAcpxCommandLease,
): AcpxRuntimePortOpenOptions {
  return {
    command,
    profile: {
      driverKind: "acpx_runtime",
      protocolVersion: 1,
      acpxVersion: "0.13.1",
      agent: "codex",
      agentProfileVersion: 1,
      agentServerPackage: "@agentclientprotocol/codex-acp",
      agentServerVersion: "1.6.2",
      agentRuntimePackage: null,
      agentRuntimeVersion: null,
      commandDigest: "sha256:test",
      qualificationModel: "gpt-5.6-sol",
      reportedModelId: "gpt-5.6-sol",
      permissionPolicy: "interactive",
    },
    cwd: "/workspace",
    stateDirectory: "/runtime/state",
    providerSessionKey: "provider-key",
    permissionMode: "approve-reads",
    permissionPolicy: {
      autoApprove: ["read"],
      escalate: ["write"],
      defaultAction: "escalate",
    },
    launchEnvironment: {
      CODEX_HOME: "/runtime/agent-home",
      OPENAI_API_KEY: "credential-secret",
      OMITTED: undefined,
    },
    systemInstructions: "Use Paperclip tools.",
  };
}

function fakeRuntime(handle: AcpRuntimeHandle = HANDLE): AcpRuntime {
  return {
    ensureSession: vi.fn().mockResolvedValue(handle),
    startTurn: vi.fn(),
    runTurn: vi.fn(),
    getStatus: vi.fn(),
    setConfigOption: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(),
  };
}

function fakeCommand(): VerifiedAcpxCommandLease {
  return { spawn: vi.fn(), close: vi.fn() };
}

function registry(): AcpAgentRegistry {
  return { resolve: vi.fn(), list: vi.fn() };
}

function store(): AcpSessionStore {
  return { load: vi.fn(), save: vi.fn() };
}
