import {
  spawn as spawnChildProcess,
  type ChildProcess,
} from "node:child_process";
import { EventEmitter, once } from "node:events";

import type {
  AcpAgentRegistry,
  AcpRuntime,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpSessionStore,
} from "acpx/runtime";
import { decodeAcpxRuntimeHandleState } from "acpx/runtime";
import { describe, expect, it, vi } from "vitest";

import type { VerifiedAcpxCommandLease } from "./installation-integrity.js";
import {
  launchUnresponsiveProviderReaper,
  openCodexAcpxRuntime,
} from "./codex-runtime-adapter.js";
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
  it("hands an exact detached provider group to the external reaper", async () => {
    if (process.platform === "win32") return;
    const child = spawnChildProcess(
      process.execPath,
      ["--eval", "setInterval(() => undefined, 1_000)"],
      { detached: true, stdio: "ignore" },
    );
    await once(child, "spawn");
    const exited = once(child, "exit");
    try {
      await launchUnresponsiveProviderReaper(child);
      child.unref();
      const [, signal] = await exited;
      expect(signal).toBe("SIGKILL");
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The reaper already removed the private process group.
        }
      }
    }
  });

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
    expect(runtimeOptions?.elicitationModes).toEqual(["form"]);
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
    const child = fakeChild();
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

  it("retries protocol cleanup after a retained attempt never settles", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      const runtimeClose = new Promise<void>(() => {});
      vi.mocked(runtime.close)
        .mockReturnValueOnce(runtimeClose)
        .mockResolvedValueOnce(undefined);
      const child = fakeChild();
      const command = fakeCommand();
      vi.mocked(command.spawn).mockReturnValue(child);
      let runtimeOptions: AcpRuntimeOptions | undefined;
      const port = await openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
      });
      runtimeOptions?.spawnAgent?.({
        command: "ignored",
        args: ["--stdio"],
        options: {},
      });

      const firstClose = expect(
        port.close({ reason: "runtime close stalled" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      expect(runtime.close).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await firstClose;

      // The first exact cleanup remains owned, but it cannot become the retry
      // barrier after its bounded observation and provider termination finish.
      expect(runtime.close).toHaveBeenCalledOnce();
      await expect(port.close({ reason: "idempotent terminal close" }))
        .resolves.toBeUndefined();
      expect(runtime.close).toHaveBeenCalledTimes(2);
      expect(runtime.close).toHaveBeenLastCalledWith({
        handle: HANDLE,
        reason: "idempotent terminal close",
        discardPersistentState: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a fresh close after a retained attempt rejects late", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      let rejectRuntimeClose!: (error: unknown) => void;
      const runtimeClose = new Promise<void>((_resolve, reject) => {
        rejectRuntimeClose = reject;
      });
      vi.mocked(runtime.close)
        .mockReturnValueOnce(runtimeClose)
        .mockResolvedValueOnce(undefined);
      const child = fakeChild();
      const command = fakeCommand();
      vi.mocked(command.spawn).mockReturnValue(child);
      let runtimeOptions: AcpRuntimeOptions | undefined;
      const port = await openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
      });
      runtimeOptions?.spawnAgent?.({
        command: "ignored",
        args: ["--stdio"],
        options: {},
      });

      const firstClose = expect(
        port.close({ reason: "runtime close stalled" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      await firstClose;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      const protocolFailure = new Error("late protocol close failure");
      rejectRuntimeClose(protocolFailure);
      await Promise.resolve();
      await expect(port.close({ reason: "retry after retained failure" }))
        .resolves.toBeUndefined();
      expect(runtime.close).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles an older close that fails after a fresh close succeeds", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      let rejectFirstClose!: (error: unknown) => void;
      const firstRuntimeClose = new Promise<void>((_resolve, reject) => {
        rejectFirstClose = reject;
      });
      vi.mocked(runtime.close)
        .mockReturnValueOnce(firstRuntimeClose)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);
      const child = fakeChild();
      const command = fakeCommand();
      vi.mocked(command.spawn).mockReturnValue(child);
      let runtimeOptions: AcpRuntimeOptions | undefined;
      const port = await openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
      });
      runtimeOptions?.spawnAgent?.({
        command: "ignored",
        args: ["--stdio"],
        options: {},
      });

      const firstClose = expect(
        port.close({ reason: "first protocol close stalls" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      await firstClose;

      await expect(port.close({ reason: "fresh protocol close succeeds" }))
        .resolves.toBeUndefined();
      expect(runtime.close).toHaveBeenCalledTimes(2);

      rejectFirstClose(new Error("older protocol close failed late"));
      await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(3));
      expect(runtime.close).toHaveBeenLastCalledWith({
        handle: HANDLE,
        reason: "ACPX late protocol cleanup reconciliation 1",
        discardPersistentState: false,
      });
      await expect(port.close({ reason: "observe reconciled cleanup" }))
        .resolves.toBeUndefined();
      expect(runtime.close).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the event-loop handle for a provider that survives both shutdown signals", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      const child = stubbornChild();
      const command = fakeCommand();
      const reapUnresponsiveChild = vi.fn().mockResolvedValue(undefined);
      vi.mocked(command.spawn).mockReturnValue(child);
      let runtimeOptions: AcpRuntimeOptions | undefined;
      const port = await openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
        reapUnresponsiveChild,
      });
      runtimeOptions?.spawnAgent?.({
        command: "ignored",
        args: ["--stdio"],
        options: {},
      });

      const closing = expect(
        port.close({ reason: "provider ignored shutdown" }),
      ).rejects.toMatchObject({
        errors: [
          expect.objectContaining({
            message: "ACPX provider did not exit after SIGKILL",
          }),
        ],
      });
      await vi.advanceTimersByTimeAsync(4_000);
      await closing;

      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(child.stdin?.destroy).toHaveBeenCalledOnce();
      expect(child.stdout?.destroy).toHaveBeenCalledOnce();
      expect(child.stderr?.destroy).toHaveBeenCalledOnce();
      expect(reapUnresponsiveChild).toHaveBeenCalledWith(child);
      // The close still fails and preserves the cleanup diagnostic. Only the
      // successful external-reaper handoff releases the local event-loop hold.
      expect(child.unref).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains an unresponsive provider when external reaper handoff fails", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      const child = stubbornChild();
      const command = fakeCommand();
      vi.mocked(command.spawn).mockReturnValue(child);
      let runtimeOptions: AcpRuntimeOptions | undefined;
      const port = await openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
        reapUnresponsiveChild: vi.fn().mockRejectedValue(
          new Error("reaper handoff failed"),
        ),
      });
      runtimeOptions?.spawnAgent?.({
        command: "ignored",
        args: ["--stdio"],
        options: {},
      });

      const closing = expect(
        port.close({ reason: "provider handoff failed" }),
      ).rejects.toMatchObject({
        errors: expect.arrayContaining([
          expect.objectContaining({ message: "reaper handoff failed" }),
        ]),
      });
      await vi.advanceTimersByTimeAsync(4_000);
      await closing;

      expect(child.unref).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases an unresponsive Windows provider when no group reaper is available", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      const child = stubbornChild();
      const command = fakeCommand();
      const reaperFailure = new Error(
        "ACPX provider process-group reaping is unavailable on Windows",
      );
      const reapUnresponsiveChild = vi.fn().mockRejectedValue(reaperFailure);
      vi.mocked(command.spawn).mockReturnValue(child);
      let runtimeOptions: AcpRuntimeOptions | undefined;
      const port = await openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
        reapUnresponsiveChild,
        releaseUnresponsiveChildOnReaperFailure: true,
      });
      runtimeOptions?.spawnAgent?.({
        command: "ignored",
        args: ["--stdio"],
        options: {},
      });

      const closing = expect(
        port.close({ reason: "provider handoff is unavailable" }),
      ).rejects.toMatchObject({
        errors: expect.arrayContaining([reaperFailure]),
      });
      await vi.advanceTimersByTimeAsync(4_000);
      await closing;

      expect(child.stdin?.destroy).toHaveBeenCalledOnce();
      expect(child.stdout?.destroy).toHaveBeenCalledOnce();
      expect(child.stderr?.destroy).toHaveBeenCalledOnce();
      expect(reapUnresponsiveChild).toHaveBeenCalledWith(child);
      expect(child.unref).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects and independently cleans providers spawned during termination", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      const firstChild = childThatExitsOnKill();
      const lateChild = childThatExitsOnKill();
      const command = fakeCommand();
      vi.mocked(command.spawn)
        .mockReturnValueOnce(firstChild)
        .mockReturnValueOnce(lateChild);
      const retainedCleanups: Promise<void>[] = [];
      let runtimeOptions: AcpRuntimeOptions | undefined;
      const port = await openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        retainCleanup: (cleanup) => retainedCleanups.push(cleanup),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
      });
      runtimeOptions?.spawnAgent?.({
        command: "ignored",
        args: ["--stdio"],
        options: {},
      });

      let settled = false;
      const closing = port.close({ reason: "join late provider" }).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(() => runtimeOptions?.spawnAgent?.({
          command: "ignored",
          args: ["--stdio"],
          options: {},
        })).toThrow("provider spawned after cleanup was sealed");
      expect(lateChild.kill).toHaveBeenCalledWith("SIGKILL");
      expect(retainedCleanups).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(500);
      expect(firstChild.kill).toHaveBeenCalledWith("SIGKILL");
      await closing;
      await retainedCleanups[0];
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps prompt turns to the admitted ACPX handle", async () => {
    const runtime = fakeRuntime();
    const turn = {
      requestId: "turn-1",
      promptStarted: Promise.resolve(),
      events: { async *[Symbol.asyncIterator]() {} },
      result: Promise.resolve({ status: "completed" as const }),
      cancel: vi.fn(),
      closeStream: vi.fn(),
    };
    vi.mocked(runtime.startTurn).mockReturnValue(turn);
    const port = await openCodexAcpxRuntime(openOptions(fakeCommand()), {
      createRegistry: () => registry(),
      createStore: () => store(),
      createRuntime: () => runtime,
    });
    const signal = new AbortController().signal;
    const onElicitation = vi.fn();

    expect(
      port.startTurn({
        text: "Complete the task.",
        requestId: "turn-1",
        signal,
        onElicitation,
      }),
    ).toBe(turn);
    expect(runtime.startTurn).toHaveBeenCalledWith({
      handle: HANDLE,
      text: "Complete the task.",
      mode: "prompt",
      requestId: "turn-1",
      signal,
      onElicitation,
    });
  });

  it("projects only ephemeral MCP bindings and applies fail-closed permissions", async () => {
    const runtime = fakeRuntime();
    let runtimeOptions: AcpRuntimeOptions | undefined;
    const port = await openCodexAcpxRuntime(
      {
        ...openOptions(fakeCommand()),
        permissionMode: "deny-all",
        mcpServers: [
          {
            name: "paperclip",
            url: "http://127.0.0.1:3210/mcp",
            bearerToken: "bridge-secret",
            runnerOwned: true,
          },
        ],
      },
      {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
      },
    );

    expect(runtimeOptions?.mcpServers).toEqual([
      {
        type: "http",
        name: "paperclip",
        url: "http://127.0.0.1:3210/mcp",
        headers: [{ name: "Authorization", value: "Bearer bridge-secret" }],
      },
    ]);
    await expect(
      runtimeOptions?.onPermissionRequest?.(
        {
          sessionId: "session-1",
          inferredKind: "execute",
          raw: { _meta: { is_mcp_tool_approval: true } },
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ outcome: "allow_once" });
    await expect(
      runtimeOptions?.onPermissionRequest?.(
        {
          sessionId: "session-1",
          inferredKind: "execute",
          raw: {},
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ outcome: "reject_once" });
    expect(
      JSON.stringify(vi.mocked(runtime.ensureSession).mock.calls),
    ).not.toContain("bridge-secret");
    await port.close({ reason: "complete" });
  });

  it("delegates permissions that require an unavailable coordinator", async () => {
    const runtime = fakeRuntime();
    let runtimeOptions: AcpRuntimeOptions | undefined;
    const port = await openCodexAcpxRuntime(openOptions(fakeCommand()), {
      createRegistry: () => registry(),
      createStore: () => store(),
      createRuntime: (options) => {
        runtimeOptions = options;
        return runtime;
      },
    });

    await expect(
      runtimeOptions?.onPermissionRequest?.(
        {
          sessionId: "session-1",
          inferredKind: "write",
          raw: {},
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toBeUndefined();
    await port.close({ reason: "complete" });
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

  it("bounds invalid-identity cleanup before terminating the provider", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime({ ...HANDLE, agentSessionId: undefined });
      vi.mocked(runtime.close).mockImplementation(
        () => new Promise<void>(() => undefined),
      );
      const child = fakeChild();
      const command = fakeCommand();
      vi.mocked(command.spawn).mockReturnValue(child);
      const opening = openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => ({
          ...runtime,
          ensureSession: vi.fn(async () => {
            options.spawnAgent?.({
              command: "ignored",
              args: ["--stdio"],
              options: {},
            });
            return { ...HANDLE, agentSessionId: undefined };
          }),
        }),
      });
      const rejected = expect(opening).rejects.toThrow(
        "identity validation and cleanup failed",
      );

      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates a provider spawned before the session handshake rejects", async () => {
    const child = fakeChild();
    const command = fakeCommand();
    vi.mocked(command.spawn).mockReturnValue(child);
    const failure = new Error("ACP handshake rejected");
    const runtime = fakeRuntime();

    await expect(
      openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => {
          vi.mocked(runtime.ensureSession).mockImplementation(async () => {
            options.spawnAgent?.({
              command: "ignored",
              args: ["--stdio"],
              options: {},
            });
            throw failure;
          });
          return runtime;
        },
      }),
    ).rejects.toBe(failure);
    expect(runtime.close).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("aggregates asynchronous provider signal errors after a failed handshake", async () => {
    const child = failingSignalChild();
    const command = fakeCommand();
    vi.mocked(command.spawn).mockReturnValue(child.child);
    const handshakeError = new Error("ACP handshake rejected");
    const runtime = fakeRuntime();

    const result = openCodexAcpxRuntime(openOptions(command), {
      createRegistry: () => registry(),
      createStore: () => store(),
      createRuntime: (options) => {
        vi.mocked(runtime.ensureSession).mockImplementation(async () => {
          options.spawnAgent?.({
            command: "ignored",
            args: ["--stdio"],
            options: {},
          });
          throw handshakeError;
        });
        return runtime;
      },
    });

    await expect(result).rejects.toMatchObject({
      errors: [
        handshakeError,
        ...child.errors,
        expect.objectContaining({
          message: "ACPX provider did not exit after SIGKILL",
        }),
      ],
    });
    expect(child.child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("closes a recovered session when its handshake rejects before another save", async () => {
    const runtime = fakeRuntime();
    const recoveredStore = store();
    vi.mocked(recoveredStore.load).mockResolvedValue({
      acpxRecordId: "recovered-record",
      acpSessionId: "recovered-backend-session",
      agentSessionId: "recovered-agent-session",
      name: "recovered-runtime-name",
      cwd: "/workspace",
    } as never);
    const failure = new Error("recovered ACP handshake rejected");

    await expect(
      openCodexAcpxRuntime(openOptions(fakeCommand()), {
        createRegistry: () => registry(),
        createStore: () => recoveredStore,
        createRuntime: (runtimeOptions) => {
          vi.mocked(runtime.ensureSession).mockImplementation(async () => {
            await runtimeOptions.sessionStore.load("provider-key");
            throw failure;
          });
          return runtime;
        },
      }),
    ).rejects.toBe(failure);
    expect(runtime.close).toHaveBeenCalledOnce();
    const recoveredClose = vi.mocked(runtime.close).mock.calls[0]![0];
    expect(recoveredClose).toMatchObject({
      handle: {
        sessionKey: "provider-key",
        backend: "acpx",
        cwd: "/workspace",
        acpxRecordId: "recovered-record",
        backendSessionId: "recovered-backend-session",
        agentSessionId: "recovered-agent-session",
      },
      reason: "ACPX session handshake failed",
      discardPersistentState: false,
    });
    expect(
      decodeAcpxRuntimeHandleState(recoveredClose.handle.runtimeSessionName),
    ).toEqual({
      name: "recovered-runtime-name",
      agent: "codex",
      cwd: "/workspace",
      mode: "persistent",
      acpxRecordId: "recovered-record",
      backendSessionId: "recovered-backend-session",
      agentSessionId: "recovered-agent-session",
    });
    expect(recoveredStore.save).not.toHaveBeenCalled();
  });

  it("closes a newly created session when its record save rejects", async () => {
    const runtime = fakeRuntime();
    const failingStore = store();
    const failure = new Error("session store unavailable");
    vi.mocked(failingStore.save).mockRejectedValue(failure);

    await expect(
      openCodexAcpxRuntime(openOptions(fakeCommand()), {
        createRegistry: () => registry(),
        createStore: () => failingStore,
        createRuntime: (runtimeOptions) => {
          vi.mocked(runtime.ensureSession).mockImplementation(async () => {
            await runtimeOptions.sessionStore.save({
              acpxRecordId: "new-record",
              acpSessionId: "new-backend-session",
              agentSessionId: "new-agent-session",
              name: "new-runtime-name",
              cwd: "/workspace",
            } as never);
            return HANDLE;
          });
          return runtime;
        },
      }),
    ).rejects.toBe(failure);
    expect(runtime.close).toHaveBeenCalledOnce();
    const failedSaveClose = vi.mocked(runtime.close).mock.calls[0]![0];
    expect(failedSaveClose).toMatchObject({
      handle: {
        sessionKey: "provider-key",
        backend: "acpx",
        cwd: "/workspace",
        acpxRecordId: "new-record",
        backendSessionId: "new-backend-session",
        agentSessionId: "new-agent-session",
      },
      reason: "ACPX session handshake failed",
      discardPersistentState: false,
    });
    expect(
      decodeAcpxRuntimeHandleState(failedSaveClose.handle.runtimeSessionName),
    ).toMatchObject({ name: "new-runtime-name", agent: "codex" });
  });

  it("bounds a stalled runtime close before terminating a failed-handshake provider", async () => {
    const child = fakeChild();
    const command = fakeCommand();
    vi.mocked(command.spawn).mockReturnValue(child);
    const runtime = fakeRuntime();
    vi.mocked(runtime.close).mockImplementation(
      () => new Promise<void>(() => undefined),
    );

    await expect(
      openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (runtimeOptions) => {
          vi.mocked(runtime.ensureSession).mockImplementation(async () => {
            await runtimeOptions.sessionStore.save({
              acpxRecordId: "actual-record",
              acpSessionId: "backend-session",
              agentSessionId: "agent-session",
              name: "actual-runtime-name",
              cwd: "/workspace",
            } as never);
            runtimeOptions.spawnAgent?.({
              command: "ignored",
              args: ["--stdio"],
              options: {},
            });
            throw new Error("ACP handshake rejected");
          });
          return runtime;
        },
        runtimeCloseTimeoutMs: 5,
      }),
    ).rejects.toThrow("ACPX session handshake and runtime cleanup failed");
    expect(runtime.close).toHaveBeenCalledOnce();
    const stalledClose = vi.mocked(runtime.close).mock.calls[0]![0];
    expect(stalledClose).toMatchObject({
      handle: {
        sessionKey: "provider-key",
        backend: "acpx",
        cwd: "/workspace",
        acpxRecordId: "actual-record",
        backendSessionId: "backend-session",
        agentSessionId: "agent-session",
      },
      reason: "ACPX session handshake failed",
      discardPersistentState: false,
    });
    expect(
      decodeAcpxRuntimeHandleState(stalledClose.handle.runtimeSessionName),
    ).toMatchObject({ name: "actual-runtime-name", agent: "codex" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects close with asynchronous provider signal errors", async () => {
    const runtime = fakeRuntime();
    const command = fakeCommand();
    const child = failingSignalChild();
    let runtimeOptions: AcpRuntimeOptions | undefined;
    vi.mocked(command.spawn).mockReturnValue(child.child);
    const port = await openCodexAcpxRuntime(openOptions(command), {
      createRegistry: () => registry(),
      createStore: () => store(),
      createRuntime: (options) => {
        runtimeOptions = options;
        return runtime;
      },
    });
    runtimeOptions?.spawnAgent?.({
      command: "ignored",
      args: ["--stdio"],
      options: {},
    });

    await expect(port.close({ reason: "test complete" })).rejects.toMatchObject(
      {
        errors: [
          ...child.errors,
          expect.objectContaining({
            message: "ACPX provider did not exit after SIGKILL",
          }),
        ],
      },
    );
    expect(child.child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("retains a provider error after close removes the child", async () => {
    const runtime = fakeRuntime();
    const command = fakeCommand();
    const child = fakeChild();
    const providerError = new Error("provider spawn failed");
    let runtimeOptions: AcpRuntimeOptions | undefined;
    vi.mocked(command.spawn).mockReturnValue(child);
    const port = await openCodexAcpxRuntime(openOptions(command), {
      createRegistry: () => registry(),
      createStore: () => store(),
      createRuntime: (options) => {
        runtimeOptions = options;
        return runtime;
      },
    });
    runtimeOptions?.spawnAgent?.({
      command: "ignored",
      args: ["--stdio"],
      options: {},
    });

    child.emit("error", providerError);
    child.emit("close", 1, null);

    await expect(port.close({ reason: "test complete" })).rejects.toMatchObject(
      {
        errors: [providerError],
      },
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("bounds a stalled session handshake and terminates its provider", async () => {
    const child = fakeChild();
    const command = fakeCommand();
    vi.mocked(command.spawn).mockReturnValue(child);
    const runtime = fakeRuntime();

    await expect(
      openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        sessionHandshakeTimeoutMs: 1,
        createRuntime: (options) => {
          vi.mocked(runtime.ensureSession).mockImplementation(() => {
            options.spawnAgent?.({
              command: "ignored",
              args: ["--stdio"],
              options: {},
            });
            return new Promise<AcpRuntimeHandle>(() => undefined);
          });
          return runtime;
        },
      }),
    ).rejects.toThrow("session handshake exceeded its admission deadline");
    expect(runtime.close).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects provider children created after handshake cleanup is sealed", async () => {
    const child = fakeChild();
    const postCleanupChild = fakeChild();
    const command = fakeCommand();
    vi.mocked(command.spawn)
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(postCleanupChild);
    const runtime = fakeRuntime();
    const retainCleanup = vi.fn<(cleanup: Promise<void>) => void>();
    let runtimeOptions: AcpRuntimeOptions | undefined;
    let resolveHandshake: ((handle: AcpRuntimeHandle) => void) | undefined;
    vi.mocked(runtime.ensureSession).mockImplementation(
      () =>
        new Promise<AcpRuntimeHandle>((resolve) => {
          resolveHandshake = resolve;
        }),
    );

    await expect(
      openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        sessionHandshakeTimeoutMs: 1,
        retainCleanup,
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
      }),
    ).rejects.toThrow("session handshake exceeded its admission deadline");

    expect(retainCleanup).toHaveBeenCalledOnce();
    const retainedCleanup = retainCleanup.mock.calls[0]?.[0];
    expect(retainedCleanup).toBeDefined();

    expect(() => runtimeOptions?.spawnAgent?.({
      command: "ignored",
      args: ["--stdio"],
      options: {},
    })).toThrow("provider spawned after cleanup was sealed");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(retainCleanup).toHaveBeenCalledTimes(2);
    await retainCleanup.mock.calls[1]?.[0];
    resolveHandshake?.(HANDLE);

    await retainedCleanup;
    expect(runtime.close).toHaveBeenCalledWith({
      handle: HANDLE,
      reason: "ACPX session handshake completed after its admission deadline",
      discardPersistentState: false,
    });
    expect(() => runtimeOptions?.spawnAgent?.({
      command: "ignored",
      args: ["--stdio"],
      options: {},
    })).toThrow("provider spawned after cleanup was sealed");
    expect(postCleanupChild.kill).toHaveBeenCalledWith("SIGKILL");
    expect(retainCleanup).toHaveBeenCalledTimes(3);
    await retainCleanup.mock.calls[2]?.[0];
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
    mcpServers: [],
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

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperties(child, {
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  child.kill = vi.fn(() => {
    child.signalCode = "SIGTERM";
    queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
    return true;
  });
  return child;
}

function failingSignalChild(): {
  child: ChildProcess;
  errors: [Error, Error];
} {
  const child = new EventEmitter() as ChildProcess;
  const errors: [Error, Error] = [
    new Error("SIGTERM delivery failed"),
    new Error("SIGKILL delivery failed"),
  ];
  Object.defineProperties(child, {
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  child.kill = vi.fn((signal) => {
    const error = signal === "SIGTERM" ? errors[0] : errors[1];
    queueMicrotask(() => child.emit("error", error));
    return true;
  });
  return { child, errors };
}

function stubbornChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperties(child, {
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
    stdin: { value: { destroy: vi.fn() } },
    stdout: { value: { destroy: vi.fn() } },
    stderr: { value: { destroy: vi.fn() } },
  });
  child.kill = vi.fn(() => true);
  child.unref = vi.fn(() => child);
  return child;
}

function childThatExitsOnKill(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperties(child, {
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (signal === "SIGKILL") {
      child.signalCode = "SIGKILL";
      queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
    }
    return true;
  });
  return child;
}

function registry(): AcpAgentRegistry {
  return { resolve: vi.fn(), list: vi.fn() };
}

function store(): AcpSessionStore {
  return { load: vi.fn(), save: vi.fn() };
}
