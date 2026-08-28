import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  parseCodexTurnDiff,
  type ParsedCodexTurnDiffFile,
} from "./codex-turn-diff.js";

export { parseCodexTurnDiff } from "./codex-turn-diff.js";

import type {
  HarnessDriver,
  HarnessDriverDescriptor,
  HarnessSession,
  HarnessSessionRecoveryResult,
  HarnessGoalOperation,
  HarnessRuntimeRequest,
  HarnessRuntimeRequestResolution,
  PaperclipQuestionSet,
  HarnessThreadGoal,
  HarnessThreadLineageEntry,
  OpenHarnessSessionInput,
  PersistedHarnessSession,
  PersistedHarnessSemanticResult,
  PersistedHarnessTurnTerminal,
} from "../../contracts/harness-driver.js";
import {
  HarnessCapabilityUnavailableError,
  HarnessOperationAlreadyTerminalError,
  HarnessReconciliationError,
  HarnessStaleTurnError,
  harnessRuntimeInputExpiredOutcome,
  harnessRuntimeRequestOutcome,
  parseHarnessRuntimeRequestResolution,
} from "../../contracts/harness-driver.js";
import {
  CODEX_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA,
  CODEX_BLOCK_TOOL_NAME,
  CODEX_CODEX_PROTOCOL_VERSION,
  CODEX_COMPLETION_TOOL_NAME,
  CODEX_RESULT_OUTPUT_SCHEMA,
  CODEX_RESULT_PROVIDER_INPUT_SCHEMA,
  CODEX_SEMANTIC_TOOL_NAMES,
  CODEX_SKILLLESS_BASE_INSTRUCTIONS,
  type CodexModelContextSnapshot,
  type CodexTaskEnvelope,
} from "../../contracts/codex.js";
import {
  validatePrpStructuredRunResult,
  type PrpEvent,
  type PrpStructuredRunResult,
} from "../../protocol/replay-contract.js";
import type { NativeUserMessage } from "../../contracts/types.js";
import { paperclipWorkspaceFileReferencesFromText } from "../../live/workspace-file-reference.js";
import {
  canonicalProviderEventsFromCodex,
  providerFamilyCapabilities,
} from "../../provider-events.js";
import {
  ProcessCodexAppServerTransport,
  createSanitizedCodexEnvironment,
  isCodexMethodUnavailable,
  redactCodexDiagnostic,
  type CodexAppServerTransport,
  type CodexRpcNotification,
  type CodexRpcServerRequest,
  type CodexTraceInterpretation,
  type CodexTransportProcessInfo,
} from "./app-server-transport.js";
import {
  boundedCodexPayload as boundedPayload,
  boundedCodexValue,
  codexToolAcceptsDisposition as toolAcceptsDisposition,
  isCodexSemanticTool as isSemanticTool,
  isRetainableCodexPayload,
  redactCodexValue,
  rejectedCodexToolCall as rejectedToolCall,
  validateCodexWorkingDirectory as validateWorkingDirectory,
} from "./codex-boundaries.js";
import {
  hasCodexQuestionForm,
  normalizeCodexQuestionSet,
  runtimeRequestKind,
  runtimeRequestPrompt,
  runtimeRequestProtocolPayload,
  runtimeRequestResponse,
} from "./codex-question-adapter.js";
import {
  CODEX_PLANNING_PERMISSION_PROFILE as PLANNING_PERMISSION_PROFILE,
  CODEX_SKILLLESS_PERMISSION_PROFILE as SKILLLESS_PERMISSION_PROFILE,
  codexCommandEnvironment,
  createIsolatedCodexAppServerArgs,
  createSecuredCodexThreadParams,
  createSkilllessCodexThreadConfig,
} from "./codex-security-config.js";
import {
  boundedCodexWorkspaceStat as boundedWorkspaceStat,
  codexThreadLineage as lineageFromThread,
  codexThreadStatus as threadStatus,
  codexWorkspaceRelativePath as workspaceRelativePath,
  isBoundCodexNotification,
  isSupportedCodexNotificationMethod,
  parseCodexThreadGoal as parseThreadGoal,
  safeCodexRequestResponse as safeRequestResponse,
} from "./codex-thread-normalization.js";

export {
  createIsolatedCodexAppServerArgs,
  createSkilllessCodexThreadConfig,
  normalizeCodexQuestionSet,
};

const DRIVER_KIND = "codex_app_server";
const DRIVER_VERSION = "codex-v2";

class AsyncQueue<T> implements AsyncIterable<T> {
  #values: T[] = [];
  #waiters: Array<(value: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter({ value, done: false });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0))
      waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

export interface CodexAppServerDriverOptions {
  taskEnvelope: CodexTaskEnvelope;
  /** Explicit provider model selected by the persisted native execution. */
  model?: string;
  approvalPolicy?: "never" | "on-request" | "untrusted";
  baseInstructions?: string;
  includeSkillInstructions?: boolean;
  conversationMode?: "task" | "direct";
  requestedCollaborationMode?: "default" | "plan";
  /**
   * Include Codex's built-in collaboration instructions. Defaults to true so
   * interactive runs receive native commentary/preambles. Deterministic evals
   * may opt out explicitly without changing the production default.
   */
  includeCollaborationModeInstructions?: boolean;
  transportFactory?: (context?: {
    providerRecoveryPolicy?: PersistedHarnessSession["providerRecoveryPolicy"];
  }) => CodexAppServerTransport;
  /** Additional control-plane tools exposed to the provider for this run. */
  dynamicTools?: readonly Readonly<Record<string, unknown>>[];
  /** Executes an admitted additional tool call. Completion tools remain driver-owned. */
  dynamicToolHandler?: (call: {
    tool: string;
    callId: string;
    threadId: string;
    turnId: string;
    arguments: unknown;
  }) => Promise<unknown>;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  runnerInstanceId?: string;
  onDiagnostic?: (message: string) => void;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
  capabilities?: Partial<{
    resume: boolean;
    read: boolean;
    steering: boolean;
    interruption: boolean;
    usage: boolean;
    reconciliation: boolean;
    dynamicTools: boolean;
    runtimeRequestResolution: boolean;
    goals: boolean;
    threadLineage: boolean;
  }>;
  /** Provider-specific identity retained when the Codex protocol facade is backed by runnerd. */
  driverIdentity?: {
    kind: string;
    displayName: string;
    version: string;
  };
  collaborationModes?: readonly ("default" | "plan")[];
  requireProviderSessionIdentity?: boolean;
}

type CodexCapabilities = Required<
  NonNullable<CodexAppServerDriverOptions["capabilities"]>
>;

type SemanticResultAdmission = "committed" | "identical" | "conflict";

interface TerminalReplayConflict {
  code: "conflicting_semantic_result" | "conflicting_turn_terminal";
  message: string;
}

interface OpenedCodexThread {
  threadId: string;
  providerSessionId: string | null;
  collaborationMode: Record<string, unknown> | null;
  context: CodexModelContextSnapshot;
  lineage: HarnessThreadLineageEntry;
}

interface PendingRuntimeRequest {
  request: HarnessRuntimeRequest;
  settle: (response: Record<string, unknown>) => void;
  settlingResolution?: HarnessRuntimeRequestResolution;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function boundedText(
  value: unknown,
  fallback = "unknown",
  maxCharacters = 1024,
): string {
  const candidate = text(value, fallback);
  return candidate.length <= maxCharacters
    ? candidate
    : `${candidate.slice(0, maxCharacters)}...[truncated]`;
}

function itemFromParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  return record(params.item);
}

function itemText(item: Record<string, unknown>): string {
  for (const key of ["text", "aggregatedOutput", "patch", "delta"]) {
    if (typeof item[key] === "string") return item[key];
  }
  return "";
}

function userInput(message: NativeUserMessage): Record<string, unknown> {
  return { type: "text", text: message.text, text_elements: [] };
}

function terminalState(
  status: string,
): "completed" | "failed" | "interrupted" | "cancelled" {
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  if (status === "cancelled") return "cancelled";
  return "completed";
}

function tryParseResult(value: unknown): PrpStructuredRunResult | null {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const validation = validatePrpStructuredRunResult(candidate);
  return validation.ok ? validation.result : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = record(value);
  if (
    Object.keys(object).length > 0 ||
    (typeof value === "object" && value !== null)
  ) {
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function differingJsonPaths(
  left: unknown,
  right: unknown,
  prefix = "",
  limit = 12,
): string[] {
  if (canonicalJson(left) === canonicalJson(right)) return [];
  if (limit <= 0) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    const paths: string[] = [];
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      paths.push(...differingJsonPaths(
        left[index],
        right[index],
        `${prefix}[${index}]`,
        limit - paths.length,
      ));
      if (paths.length >= limit) break;
    }
    return paths.length > 0 ? paths : [prefix || "result"];
  }
  const leftRecord = record(left);
  const rightRecord = record(right);
  if (
    (typeof left === "object" && left !== null) &&
    (typeof right === "object" && right !== null) &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const paths: string[] = [];
    const keys = [...new Set([
      ...Object.keys(leftRecord),
      ...Object.keys(rightRecord),
    ])].sort();
    for (const key of keys) {
      paths.push(...differingJsonPaths(
        leftRecord[key],
        rightRecord[key],
        prefix ? `${prefix}.${key}` : key,
        limit - paths.length,
      ));
      if (paths.length >= limit) break;
    }
    return paths.length > 0 ? paths : [prefix || "result"];
  }
  return [prefix || "result"];
}

function finishToolSpec(): Record<string, unknown> {
  return {
    name: CODEX_COMPLETION_TOOL_NAME,
    description: "Return the one semantic completion result for this task.",
    inputSchema: CODEX_RESULT_PROVIDER_INPUT_SCHEMA,
  };
}

function blockToolSpec(): Record<string, unknown> {
  return {
    name: CODEX_BLOCK_TOOL_NAME,
    description:
      "Return the one semantic result when the task cannot continue.",
    inputSchema: CODEX_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA,
  };
}

export function codexSemanticToolSpecs(): readonly Readonly<
  Record<string, unknown>
>[] {
  return [finishToolSpec(), blockToolSpec()];
}

function dynamicToolResponse(value: unknown): Record<string, unknown> {
  return {
    success: true,
    contentItems: [
      {
        type: "inputText",
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  };
}

export class CodexAppServerDriver implements HarnessDriver {
  readonly #options: CodexAppServerDriverOptions;
  readonly #caps: CodexCapabilities;

  constructor(options: CodexAppServerDriverOptions) {
    this.#options = options;
    this.#caps = {
      resume: true,
      read: true,
      steering: true,
      interruption: true,
      usage: true,
      reconciliation: true,
      dynamicTools: true,
      runtimeRequestResolution: true,
      goals: true,
      threadLineage: true,
      ...options.capabilities,
    };
    if (!this.#caps.read) this.#caps.reconciliation = false;
  }

  #direct(): boolean {
    return this.#options.conversationMode === "direct";
  }

  #baseInstructions(): string {
    return this.#options.baseInstructions ?? CODEX_SKILLLESS_BASE_INSTRUCTIONS;
  }

  async descriptor(): Promise<HarnessDriverDescriptor> {
    const unsupported = Object.entries(this.#caps)
      .filter(([, supported]) => !supported)
      .map(([operation]) => operation);
    return {
      kind: this.#options.driverIdentity?.kind ?? DRIVER_KIND,
      displayName:
        this.#options.driverIdentity?.displayName ?? "Codex app-server",
      version: this.#options.driverIdentity?.version ?? DRIVER_VERSION,
      protocolVersion: CODEX_CODEX_PROTOCOL_VERSION,
      runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" },
      capabilities: {
        resume: this.#caps.resume,
        typedEvents: true,
        typedEventFamilies: providerFamilyCapabilities({
          plan: "available",
          tool_execution: "available",
          research: "available",
          delegation: "available",
          model_identity: "available",
          context: "available",
          artifact: "policy_disabled",
          review: "available",
          hook: "available",
          memory: "available",
          safety: "available",
          terminal: "available",
          wait: "available",
          provider_notice: "available",
        }),
        steering: this.#caps.steering,
        interruption: this.#caps.interruption,
        structuredResult: true,
        read: this.#caps.read,
        reconciliation: this.#caps.reconciliation,
        usage: this.#caps.usage,
        dynamicTools: this.#caps.dynamicTools,
        runtimeRequestResolution: this.#caps.runtimeRequestResolution,
        runtimeRequestHandoff: this.#caps.runtimeRequestResolution,
        goals: this.#caps.goals,
        threadLineage: this.#caps.threadLineage,
        collaborationModes: [
          ...(this.#options.collaborationModes ?? ["default", "plan"]),
        ],
        unsupported,
      },
    };
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    const workingDirectory = validateWorkingDirectory(
      input.workingDirectory,
      this.#options.environment,
    );
    const transport = this.#transport();
    try {
      await this.#persistProcessOwnership(transport);
      const initialize = await this.#initialize(transport);
      const requestedMode =
        this.#options.requestedCollaborationMode ?? "default";
      const response = await transport.request("thread/start", {
        ...createSecuredCodexThreadParams(
          workingDirectory,
          requestedMode,
          this.#options.includeCollaborationModeInstructions ?? true,
          this.#options.includeSkillInstructions ?? false,
        ),
        approvalPolicy: this.#options.approvalPolicy ?? "never",
        ...(this.#options.model ? { model: this.#options.model } : {}),
        ...(this.#direct()
          ? {}
          : {
              baseInstructions: this.#baseInstructions(),
              completionContract: {
                revision:
                  this.#options.taskEnvelope.completionContract.revision,
                criterionIds:
                  this.#options.taskEnvelope.completionContract.criteria.map(
                    (criterion) => criterion.id,
                  ),
              },
            }),
        dynamicTools: this.#direct()
          ? []
          : this.#caps.dynamicTools
            ? [
                ...(this.#options.dynamicTools ?? []),
                ...codexSemanticToolSpecs(),
              ]
            : [],
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      });
      const collaborationMode = await this.#negotiateCollaborationMode(
        transport,
        response,
        requestedMode,
      );
      const opened = this.#openedThread(
        response,
        initialize,
        workingDirectory,
        collaborationMode,
      );
      const goal = await this.#discoverGoal(transport, opened.threadId);
      if (opened.context.liveConsole)
        opened.context.liveConsole.goals = this.#caps.goals;
      return this.#session({
        transport,
        runId: input.runId,
        normalizedSessionId: input.normalizedSessionId,
        opened,
        goal,
        resumed: false,
        sourceSequence: 0,
      });
    } catch (error) {
      // Cleanup must never replace the provider/bootstrap failure that caused
      // the session open to abort. Remote transports may perform checkpoint
      // work during close; when no durable provider identity exists that
      // cleanup can fail independently.
      await transport.close().catch(() => {});
      throw error;
    }
  }

  async recoverSession(
    snapshot: PersistedHarnessSession,
  ): Promise<HarnessSessionRecoveryResult> {
    if (!this.#caps.resume) {
      return { recovered: false, reason: "resume capability is unavailable" };
    }
    if (!this.#caps.read) {
      return {
        recovered: false,
        reason: "read capability is required for safe resume",
      };
    }
    if (
      !snapshot.runId ||
      !snapshot.normalizedSessionId ||
      !snapshot.driverSessionId
    ) {
      return {
        recovered: false,
        reason: "persisted session identity is incomplete",
      };
    }
    const transport = this.#transport({
      providerRecoveryPolicy: snapshot.providerRecoveryPolicy,
    });
    try {
      await this.#persistProcessOwnership(transport);
      const initialize = await this.#initialize(transport);
      const existing = await transport.request("thread/read", {
        threadId: snapshot.driverSessionId,
        includeTurns: false,
      });
      const existingThread = record(existing.thread);
      if (text(existingThread.id) !== snapshot.driverSessionId) {
        await transport.close();
        return {
          recovered: false,
          reason: "provider read a different session",
        };
      }
      const workingDirectory = validateWorkingDirectory(
        text(existingThread.cwd),
        this.#options.environment,
      );
      const response = await transport.request("thread/resume", {
        threadId: snapshot.driverSessionId,
        ...createSecuredCodexThreadParams(
          workingDirectory,
          this.#options.requestedCollaborationMode ?? "default",
          this.#options.includeCollaborationModeInstructions ?? true,
          this.#options.includeSkillInstructions ?? false,
        ),
        baseInstructions: this.#direct()
          ? ""
          : this.#baseInstructions(),
        approvalPolicy: this.#options.approvalPolicy ?? "never",
        ...(this.#options.model ? { model: this.#options.model } : {}),
        persistExtendedHistory: false,
      });
      const collaborationMode = await this.#negotiateCollaborationMode(
        transport,
        response,
        this.#options.requestedCollaborationMode ?? "default",
      );
      const opened = this.#openedThread(
        response,
        initialize,
        workingDirectory,
        collaborationMode,
      );
      if (opened.threadId !== snapshot.driverSessionId) {
        await transport.close();
        return {
          recovered: false,
          reason: "provider resumed a different session",
        };
      }
      if (
        snapshot.providerSessionId &&
        opened.providerSessionId !== snapshot.providerSessionId
      ) {
        await transport.close();
        return {
          recovered: false,
          reason: "provider resumed a different provider session",
        };
      }
      const goal = await this.#discoverGoal(transport, opened.threadId);
      if (opened.context.liveConsole)
        opened.context.liveConsole.goals = this.#caps.goals;
      return {
        recovered: true,
        session: this.#session({
          transport,
          runId: snapshot.runId,
          normalizedSessionId: snapshot.normalizedSessionId,
          opened,
          goal,
          resumed: true,
          activeTurnId: snapshot.activeTurnId ?? null,
          semanticResult: snapshot.semanticResult ?? null,
          terminalTurns: snapshot.terminalTurns ?? [],
          stalePendingRuntimeRequests: snapshot.pendingRuntimeRequests ?? [],
          lineage: snapshot.lineage,
          sourceSequence: snapshot.lastSourceSequence ?? 0,
        }),
      };
    } catch (error) {
      await transport.close().catch(() => {});
      return { recovered: false, reason: redactCodexDiagnostic(String(error)) };
    }
  }

  #transport(context?: {
    providerRecoveryPolicy?: PersistedHarnessSession["providerRecoveryPolicy"];
  }): CodexAppServerTransport {
    return (
      this.#options.transportFactory?.(context) ??
      new ProcessCodexAppServerTransport({
        args: createIsolatedCodexAppServerArgs(this.#options.environment),
        environment: createSanitizedCodexEnvironment(this.#options.environment),
        onDiagnostic: this.#options.onDiagnostic,
        processGroup: true,
      })
    );
  }

  async #negotiateCollaborationMode(
    transport: CodexAppServerTransport,
    threadResponse: Record<string, unknown>,
    requested: "default" | "plan",
  ): Promise<Record<string, unknown> | null> {
    if (requested !== "plan") return null;
    try {
      const response = await transport.request("collaborationMode/list", {});
      const preset = Array.isArray(response.data)
        ? response.data
            .map(record)
            .find((candidate) => text(candidate.mode) === "plan")
        : undefined;
      if (!preset) throw new Error("plan preset is absent");
      const model = text(
        preset.model,
        text(threadResponse.model, text(record(threadResponse.thread).model)),
      );
      if (model.length === 0)
        throw new Error("plan preset did not resolve a model");
      return {
        mode: "plan",
        settings: {
          model,
          reasoning_effort: preset.reasoning_effort ?? null,
          developer_instructions: null,
        },
      };
    } catch (cause) {
      const error = new Error(
        `planning_mode_unsupported: installed Codex app-server did not expose a usable native plan collaboration mode (${redactCodexDiagnostic(String(cause))})`,
      );
      error.name = "PlanningModeUnsupportedError";
      throw error;
    }
  }

  async #persistProcessOwnership(
    transport: CodexAppServerTransport,
  ): Promise<void> {
    if (!this.#options.onSpawn) return;
    const processInfo: CodexTransportProcessInfo | undefined =
      transport.processInfo?.();
    if (!processInfo || processInfo.exited || processInfo.pid === null) return;
    await this.#options.onSpawn({
      pid: processInfo.pid,
      processGroupId: processInfo.processGroupId,
      startedAt: processInfo.startedAt,
    });
  }

  async #initialize(
    transport: CodexAppServerTransport,
  ): Promise<Record<string, unknown>> {
    const initialized = await transport.request("initialize", {
      clientInfo: {
        name: "paperclip-runner",
        title: "Paperclip Runner",
        version: DRIVER_VERSION,
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    transport.notify("initialized");
    return initialized;
  }

  async #discoverGoal(
    transport: CodexAppServerTransport,
    threadId: string,
  ): Promise<HarnessThreadGoal | null | undefined> {
    if (!this.#caps.goals) return undefined;
    try {
      const response = await transport.request("thread/goal/get", { threadId });
      return parseThreadGoal(response.goal);
    } catch (error) {
      if (isCodexMethodUnavailable(error)) {
        // The provider answered, and its answer is that this build has no goal
        // API. That is the only evidence that retires the capability.
        this.#caps.goals = false;
        this.#options.onDiagnostic?.(
          redactCodexDiagnostic(`thread goals unavailable: ${String(error)}`),
        );
        return undefined;
      }
      // A transport or protocol failure says nothing about what the provider
      // supports, so the capability stays as advertised and the goal is merely
      // unknown until the next call.
      this.#options.onDiagnostic?.(
        redactCodexDiagnostic(`thread goal probe failed: ${String(error)}`),
      );
      return undefined;
    }
  }

  #openedThread(
    response: Record<string, unknown>,
    initialize: Record<string, unknown>,
    workingDirectory: string,
    collaborationMode: Record<string, unknown> | null,
  ): OpenedCodexThread {
    const thread = record(response.thread);
    const threadId = text(thread.id);
    if (threadId.length === 0)
      throw new Error("Codex thread response omitted thread.id");
    const providerSessionId = text(thread.sessionId) || null;
    if (this.#options.requireProviderSessionIdentity && providerSessionId === null) {
      throw new Error(
        `provider_initialize_protocol_error: provider=${this.#options.driverIdentity?.kind ?? "codex"} stage=session.open omitted provider session identity`,
      );
    }
    const activePermissionProfile = record(thread.activePermissionProfile);
    const permissionProfileId = text(activePermissionProfile.id);
    const requestedMode = this.#options.requestedCollaborationMode ?? "default";
    const requiredPermissionProfile =
      requestedMode === "plan"
        ? PLANNING_PERMISSION_PROFILE
        : SKILLLESS_PERMISSION_PROFILE;
    if (
      permissionProfileId.length > 0 &&
      permissionProfileId !== requiredPermissionProfile
    ) {
      throw new Error(
        "Codex thread did not activate the required filesystem permission profile",
      );
    }
    const configuredPermissionProfile = {
      ...activePermissionProfile,
      id: requiredPermissionProfile,
    };
    const returnedWorkingDirectory = text(response.cwd, workingDirectory);
    if (resolve(returnedWorkingDirectory) !== workingDirectory) {
      throw new Error(
        "Codex thread response changed the assigned working directory",
      );
    }
    return {
      threadId,
      providerSessionId,
      collaborationMode,
      context: {
        protocolVersion: CODEX_CODEX_PROTOCOL_VERSION,
        codexVersion: boundedText(initialize.userAgent),
        clientInfo: {
          name: "paperclip-runner",
          title: "Paperclip Runner",
          version: DRIVER_VERSION,
        },
        model: boundedText(response.model),
        modelProvider: boundedText(
          response.modelProvider,
          boundedText(thread.modelProvider),
        ),
        workingDirectory,
        collaborationMode: collaborationMode === null ? "default" : "plan",
        sandbox: {
          permissionProfile: boundedCodexValue(configuredPermissionProfile),
          legacyPolicy: boundedCodexValue(response.sandbox ?? null),
          rootAccess: "none",
          minimalRuntimeAccess: "read",
          workspaceAccess: requestedMode === "plan" ? "read" : "write",
          networkAccess: false,
        },
        approvalPolicy: boundedCodexValue(
          response.approvalPolicy ?? this.#options.approvalPolicy ?? "never",
        ),
        baseInstructions: this.#baseInstructions(),
        instructionSources: Array.isArray(response.instructionSources)
          ? response.instructionSources
              .filter((value): value is string => typeof value === "string")
              .slice(0, 32)
              .map((value) => boundedText(value))
          : [],
        instructionPolicy: {
          skillInstructions: this.#options.includeSkillInstructions ?? false,
          appInstructions: false,
          collaborationInstructions:
            this.#options.includeCollaborationModeInstructions ?? true,
        },
        environmentKeys: Object.keys(
          codexCommandEnvironment(this.#options.environment),
        ).sort(),
        dynamicToolNames: this.#direct()
          ? []
          : this.#caps.dynamicTools
            ? [
                ...(this.#options.dynamicTools ?? []).map((tool) =>
                  text(tool.name),
                ),
                ...CODEX_SEMANTIC_TOOL_NAMES,
              ]
            : [],
        modelInputKinds: ["text"],
        liveConsole: {
          conversationMode: this.#direct() ? "direct" : "task",
          runtimeRequestResolution: this.#caps.runtimeRequestResolution,
          goals: this.#caps.goals,
          threadLineage: this.#caps.threadLineage,
        },
        envelope: structuredClone(this.#options.taskEnvelope),
      },
      lineage: lineageFromThread(thread),
    };
  }

  #session(input: {
    transport: CodexAppServerTransport;
    runId: string;
    normalizedSessionId: string;
    opened: OpenedCodexThread;
    goal?: HarnessThreadGoal | null;
    resumed: boolean;
    activeTurnId?: string | null;
    semanticResult?: PersistedHarnessSemanticResult | null;
    terminalTurns?: PersistedHarnessTurnTerminal[];
    stalePendingRuntimeRequests?: HarnessRuntimeRequest[];
    lineage?: HarnessThreadLineageEntry[];
    sourceSequence: number;
  }): CodexHarnessSession {
    return new CodexHarnessSession({
      ...input,
      taskEnvelope: this.#options.taskEnvelope,
      conversationMode: this.#direct() ? "direct" : "task",
      now: this.#options.now ?? (() => new Date()),
      runnerInstanceId: this.#options.runnerInstanceId ?? "runner-codex",
      driverKind: this.#options.driverIdentity?.kind ?? DRIVER_KIND,
      capabilities: this.#caps,
      dynamicTools: this.#options.dynamicTools ?? [],
      dynamicToolHandler: this.#options.dynamicToolHandler,
    });
  }
}

class CodexHarnessSession implements HarnessSession {
  readonly #transport: CodexAppServerTransport;
  #runId: string;
  readonly #normalizedSessionId: string;
  readonly #opened: OpenedCodexThread;
  readonly #taskEnvelope: CodexTaskEnvelope;
  readonly #conversationMode: "task" | "direct";
  readonly #now: () => Date;
  readonly #runnerInstanceId: string;
  readonly #driverKind: string;
  readonly #capabilities: CodexCapabilities;
  readonly #dynamicTools: readonly Readonly<Record<string, unknown>>[];
  readonly #dynamicToolHandler: CodexAppServerDriverOptions["dynamicToolHandler"];
  readonly #events = new AsyncQueue<PrpEvent>();
  #sourceSequence: number;
  #activeTurnId: string | null;
  #usage: Record<string, unknown> | null = null;
  #result: PrpStructuredRunResult | null = null;
  #resultFingerprint: string | null = null;
  #resultCallId: string | null = null;
  #resultTurnId: string | null = null;
  #turnStartPending = false;
  #protocolFailed = false;
  #protocolFailureCode: string | null = null;
  #protocolFailureMessage: string | null = null;
  #terminal = false;
  #dispositionOnlyRecoveryAvailable = false;
  #turnStarted = false;
  readonly #terminalTurns = new Map<string, string>();
  readonly #workspaceChangesByTurn = new Map<string, Record<string, unknown>>();
  readonly #emittedFileReferences = new Set<string>();
  readonly #itemChannels = new Map<
    string,
    "progress" | "final" | "summary" | "detail" | "unknown"
  >();
  readonly #pendingRuntimeRequests = new Map<string, PendingRuntimeRequest>();
  readonly #lineage = new Map<string, HarnessThreadLineageEntry>();
  #goal: HarnessThreadGoal | null = null;
  #interruptQueued = false;
  #steerSequence = 0;
  readonly #acknowledgedSteeringCorrelations = new Map<string, string>();
  #interruptSequence = 0;

  constructor(input: {
    transport: CodexAppServerTransport;
    runId: string;
    normalizedSessionId: string;
    opened: OpenedCodexThread;
    taskEnvelope: CodexTaskEnvelope;
    conversationMode: "task" | "direct";
    resumed: boolean;
    activeTurnId?: string | null;
    semanticResult?: PersistedHarnessSemanticResult | null;
    terminalTurns?: PersistedHarnessTurnTerminal[];
    stalePendingRuntimeRequests?: HarnessRuntimeRequest[];
    lineage?: HarnessThreadLineageEntry[];
    goal?: HarnessThreadGoal | null;
    sourceSequence: number;
    now: () => Date;
    runnerInstanceId: string;
    driverKind: string;
    capabilities: CodexCapabilities;
    dynamicTools: readonly Readonly<Record<string, unknown>>[];
    dynamicToolHandler?: CodexAppServerDriverOptions["dynamicToolHandler"];
  }) {
    this.#transport = input.transport;
    this.#runId = input.runId;
    this.#sourceSequence = 0;
    this.#normalizedSessionId = input.normalizedSessionId;
    this.#opened = input.opened;
    this.#taskEnvelope = input.taskEnvelope;
    this.#conversationMode = input.conversationMode;
    this.#activeTurnId = input.activeTurnId ?? null;
    this.#sourceSequence = input.sourceSequence;
    this.#now = input.now;
    this.#runnerInstanceId = input.runnerInstanceId;
    this.#driverKind = input.driverKind;
    this.#capabilities = input.capabilities;
    this.#dynamicTools = input.dynamicTools;
    this.#dynamicToolHandler = input.dynamicToolHandler;
    this.#goal = input.goal === undefined ? null : structuredClone(input.goal);
    for (const entry of input.lineage ?? [input.opened.lineage]) {
      this.#lineage.set(entry.threadId, structuredClone(entry));
    }
    if (!this.#lineage.has(input.opened.lineage.threadId)) {
      this.#lineage.set(
        input.opened.lineage.threadId,
        structuredClone(input.opened.lineage),
      );
    }
    if (input.semanticResult) {
      const validation = validatePrpStructuredRunResult(
        input.semanticResult.result,
      );
      if (
        !validation.ok ||
        canonicalJson(validation.result) !== input.semanticResult.fingerprint
      ) {
        throw new HarnessReconciliationError(
          "persisted semantic result fingerprint is invalid",
        );
      }
      this.#result = structuredClone(validation.result);
      this.#resultFingerprint = input.semanticResult.fingerprint;
      this.#resultCallId = input.semanticResult.callId ?? null;
      this.#resultTurnId = input.semanticResult.turnId;
    }
    for (const terminal of input.terminalTurns ?? []) {
      if (
        !terminal.turnId ||
        !terminal.fingerprint ||
        this.#terminalTurns.has(terminal.turnId)
      ) {
        throw new HarnessReconciliationError(
          "persisted terminal turn fingerprints are invalid",
        );
      }
      this.#terminalTurns.set(terminal.turnId, terminal.fingerprint);
    }
    if (this.#activeTurnId && this.#terminalTurns.has(this.#activeTurnId)) {
      this.#activeTurnId = null;
    }
    this.#terminal =
      this.#conversationMode === "task"
      && this.#result !== null
      && this.#resultTurnId !== null
      && this.#terminalTurns.has(this.#resultTurnId);
    this.#dispositionOnlyRecoveryAvailable =
      input.resumed &&
      this.#conversationMode === "task" &&
      this.#terminalTurns.size > 0 &&
      this.#result === null;
    this.#transport.setServerRequestHandler((request) =>
      this.#handleServerRequest(request),
    );
    this.#emit(input.resumed ? "session.resumed" : "session.started", {
      driverSessionId: input.opened.threadId,
      providerSessionId: input.opened.providerSessionId,
      context: input.opened.context,
    });
    for (const stale of input.stalePendingRuntimeRequests ?? []) {
      this.#emit(
        "runtime_request.cancelled",
        harnessRuntimeRequestOutcome(stale, { reason: "transport_recovered" }),
        { turnId: stale.turnId, itemId: stale.itemId },
      );
    }
    this.#emit(
      "item.completed",
      {
        kind: "thread_lineage",
        text: `Root thread ${input.opened.threadId}`,
        lineage: input.opened.lineage,
      },
      { itemId: `thread:${input.opened.threadId}` },
    );
    this.#emit(
      "item.completed",
      {
        kind: "model",
        text: `${input.opened.context.model} (${input.opened.context.modelProvider})`,
        model: {
          name: input.opened.context.model,
          provider: input.opened.context.modelProvider,
          codexVersion: input.opened.context.codexVersion,
        },
      },
      { itemId: `${input.opened.threadId}:model` },
    );
    void this.#pumpNotifications();
  }

  ids(): ReturnType<HarnessSession["ids"]> {
    return {
      driverSessionId: this.#opened.threadId,
      providerSessionId: this.#opened.providerSessionId,
      displayId: this.#opened.threadId,
    };
  }

  async attachRun(input: { runId: string }): Promise<void> {
    if (
      this.#activeTurnId !== null ||
      this.#turnStartPending ||
      this.#pendingRuntimeRequests.size > 0
    ) {
      throw new Error("codex_run_attach_busy");
    }
    if (!input.runId) throw new Error("codex_run_attach_invalid");
    await this.#transport.attachRun?.({
      runId: input.runId,
      turnId: `turn_attachment_${randomUUID().replaceAll("-", "")}`,
      itemId: `item_attachment_${randomUUID().replaceAll("-", "")}`,
    });
    this.#runId = input.runId;
    this.#result = null;
    this.#resultFingerprint = null;
    this.#resultCallId = null;
    this.#resultTurnId = null;
    this.#terminal = false;
    this.#terminalTurns.clear();
    this.#turnStarted = false;
    this.#protocolFailed = false;
    this.#protocolFailureCode = null;
    this.#protocolFailureMessage = null;
    this.#emit("run.attached", { runId: input.runId, sameSession: true });
  }

  contextSnapshot(): CodexModelContextSnapshot {
    return structuredClone(this.#opened.context);
  }

  events(): AsyncIterable<PrpEvent> {
    return this.#events;
  }

  async startTurn(input: {
    message: NativeUserMessage;
    requestedCollaborationMode?: "default" | "plan";
  }): Promise<{
    turnId: string;
    effectiveCollaborationMode: "default" | "plan";
  }> {
    if (
      this.#terminal ||
      this.#protocolFailed ||
      this.#activeTurnId !== null ||
      this.#turnStartPending
    ) {
      throw this.#unsupported(
        "turn start",
        this.#protocolFailureCode === null
          ? "session cannot start another turn"
          : `session failed protocol validation: ${this.#protocolFailureCode} (${this.#protocolFailureMessage ?? "no detail"})`,
      );
    }
    const dispositionOnlyRecovery = this.#dispositionOnlyRecoveryAvailable;
    const taskText =
      this.#conversationMode === "direct"
        ? input.message.text
        : dispositionOnlyRecovery
          ? input.message.text
        : JSON.stringify({
            task: this.#taskEnvelope,
            message: input.message.text,
          });
    const effectiveCollaborationMode = this.#opened.context.collaborationMode;
    if (
      input.requestedCollaborationMode &&
      input.requestedCollaborationMode !== effectiveCollaborationMode
    ) {
      throw new Error(
        `collaboration_mode_mismatch: requested ${input.requestedCollaborationMode}, effective ${effectiveCollaborationMode}`,
      );
    }
    // The submitted text is part of the canonical record so a tracer can show
    // the operator's own message without keeping shadow state next to the
    // reducer.
    this.#emit("turn.submitted", {
      envelopeSchema: this.#taskEnvelope.schema,
      text: input.message.text,
      requestedCollaborationMode:
        input.requestedCollaborationMode ?? effectiveCollaborationMode,
      effectiveCollaborationMode,
    });
    this.#turnStartPending = true;
    let response: Record<string, unknown>;
    const requestedMode = this.#opened.context.collaborationMode;
    try {
      response = await this.#transport.request("turn/start", {
        threadId: this.#opened.threadId,
        cwd: this.#opened.context.workingDirectory,
        permissions:
          requestedMode === "plan"
            ? PLANNING_PERMISSION_PROFILE
            : SKILLLESS_PERMISSION_PROFILE,
        runtimeWorkspaceRoots: [this.#opened.context.workingDirectory],
        ...(this.#opened.collaborationMode === null
          ? {}
          : { collaborationMode: this.#opened.collaborationMode }),
        input: [userInput({ role: "user", text: taskText })],
        ...(this.#conversationMode === "direct"
          ? {}
          : { outputSchema: CODEX_RESULT_OUTPUT_SCHEMA }),
      });
    } finally {
      this.#turnStartPending = false;
    }
    const turn = record(response.turn);
    const turnId = text(turn.id);
    if (turnId.length === 0)
      throw new Error("Codex turn response omitted turn.id");
    if (this.#activeTurnId !== null && this.#activeTurnId !== turnId) {
      this.#failProtocol(
        "turn_start_mismatch",
        "turn/start response disagreed with turn/started",
      );
      throw new Error("Codex turn identity changed during start");
    }
    this.#activeTurnId ??= turnId;
    if (dispositionOnlyRecovery) {
      this.#dispositionOnlyRecoveryAvailable = false;
    }
    this.#emit("turn.accepted", { turnId }, { turnId });
    if (this.#interruptQueued) {
      this.#interruptQueued = false;
      await this.#sendInterrupt(turnId, "queued_before_start");
    }
    return {
      turnId,
      effectiveCollaborationMode,
    };
  }

  async steer(input: {
    turnId: string;
    message: NativeUserMessage;
    correlationId?: string;
  }): Promise<void> {
    this.#requireCapability("steering");
    this.#requireActiveTurn(input.turnId, "steering");
    if (input.correlationId) {
      const acknowledgedTurnId = this.#acknowledgedSteeringCorrelations.get(
        input.correlationId,
      );
      if (acknowledgedTurnId) {
        if (acknowledgedTurnId !== input.turnId)
          throw new HarnessOperationAlreadyTerminalError("steering");
        return;
      }
    }
    try {
      await this.#transport.request("turn/steer", {
        threadId: this.#opened.threadId,
        input: [userInput(input.message)],
        expectedTurnId: input.turnId,
        correlationId: input.correlationId,
      });
      if (this.#activeTurnId !== input.turnId) {
        throw new HarnessOperationAlreadyTerminalError("steering");
      }
      if (input.correlationId) {
        this.#acknowledgedSteeringCorrelations.set(
          input.correlationId,
          input.turnId,
        );
      }
      this.#emit(
        "item.completed",
        {
          kind: "steering_acknowledgement",
          text: "Steering acknowledged for the active turn.",
          status: "acknowledged",
        },
        {
          turnId: input.turnId,
          itemId: input.correlationId
            ? `${input.turnId}:steer:${input.correlationId}`
            : `${input.turnId}:steer:${++this.#steerSequence}`,
        },
      );
    } catch (error) {
      if (error instanceof HarnessOperationAlreadyTerminalError) throw error;
      const detail = redactCodexDiagnostic(String(error));
      if (/unsupported|unavailable|capability|method not found/i.test(detail)) {
        throw this.#unsupported("steering", detail);
      }
      // Steering rejection is a retryable operation failure, not evidence
      // that the provider lacks the capability. Preserve that distinction for
      // the control plane while keeping provider diagnostics redacted.
      throw new Error(detail);
    }
  }

  async interrupt(input: { turnId?: string; reason?: string }): Promise<void> {
    this.#requireCapability("interruption");
    if (this.#turnStartPending && this.#activeTurnId === null) {
      this.#interruptQueued = true;
      this.#emit(
        "item.completed",
        {
          kind: "interrupt_acknowledgement",
          text: "Interrupt queued until the provider assigns the turn identity.",
          status: "queued",
        },
        { itemId: `interrupt:queued:${++this.#interruptSequence}` },
      );
      return;
    }
    if (this.#terminal || this.#activeTurnId === null) {
      throw new HarnessOperationAlreadyTerminalError("interruption");
    }
    const turnId = input.turnId ?? this.#activeTurnId;
    this.#requireActiveTurn(turnId, "interruption");
    await this.#sendInterrupt(turnId, input.reason);
  }

  async #sendInterrupt(turnId: string, reason?: string): Promise<void> {
    try {
      await this.#transport.request("turn/interrupt", {
        threadId: this.#opened.threadId,
        turnId,
      });
      if (this.#activeTurnId !== turnId) {
        throw new HarnessOperationAlreadyTerminalError("interruption");
      }
      this.#emit(
        "item.completed",
        {
          kind: "interrupt_acknowledgement",
          text: "Interrupt accepted for the active turn.",
          status: "acknowledged",
          reason: boundedText(reason),
        },
        {
          turnId,
          itemId: `${turnId}:interrupt:${++this.#interruptSequence}`,
        },
      );
    } catch (error) {
      if (error instanceof HarnessOperationAlreadyTerminalError) throw error;
      throw this.#unsupported("interruption", error);
    }
  }

  pendingRuntimeRequests(): HarnessRuntimeRequest[] {
    return [...this.#pendingRuntimeRequests.values()].map(({ request }) =>
      structuredClone(request),
    );
  }

  async resolveRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void> {
    this.#requireCapability("runtimeRequestResolution");
    const pending = this.#pendingRuntimeRequests.get(input.requestId);
    if (pending === undefined) {
      throw new HarnessCapabilityUnavailableError(
        "runtime request resolution",
        `request ${input.requestId} is no longer pending`,
      );
    }
    if (
      pending.request.turnId !== input.turnId ||
      this.#activeTurnId !== input.turnId
    ) {
      throw new HarnessStaleTurnError(input.turnId);
    }
    const resolution = parseHarnessRuntimeRequestResolution(
      pending.request.requestKind,
      input.resolution,
      pending.request.input,
    );
    if (pending.settlingResolution !== undefined) {
      throw new HarnessCapabilityUnavailableError(
        "runtime request resolution",
        `request ${input.requestId} is already settling`,
      );
    }
    pending.settlingResolution = structuredClone(resolution);
    const response = runtimeRequestResponse(pending.request, resolution);
    try {
      await this.#transport.resolveRuntimeRequest?.({
        requestId: input.requestId,
        turnId: input.turnId,
        resolution,
      });
    } catch (error) {
      if (this.#pendingRuntimeRequests.get(input.requestId) === pending) {
        pending.settlingResolution = undefined;
      }
      throw error;
    }
    if (!this.#pendingRuntimeRequests.delete(input.requestId)) return;
    this.#emit(
      "runtime_request.resolved",
      harnessRuntimeRequestOutcome(pending.request, {
        action: resolution.action,
        ...(resolution.action === "submit" && "response" in resolution
          ? { response: resolution.response }
          : {}),
      }),
      { turnId: input.turnId, itemId: pending.request.itemId },
    );
    pending.settle(response);
  }

  async handoffRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    reason: "durable_handoff";
  }): Promise<"handed_off" | "already_settled"> {
    this.#requireCapability("runtimeRequestResolution");
    const pending = this.#pendingRuntimeRequests.get(input.requestId);
    if (
      pending === undefined
      || pending.request.input === undefined
      || pending.request.turnId !== input.turnId
      || this.#activeTurnId !== input.turnId
      || pending.settlingResolution !== undefined
    ) return "already_settled";
    if (!this.#pendingRuntimeRequests.delete(input.requestId)) return "already_settled";
    this.#emit(
      "runtime_request.expired",
      harnessRuntimeInputExpiredOutcome(pending.request, input.reason),
      { turnId: input.turnId, itemId: pending.request.itemId },
    );
    pending.settle(safeRequestResponse(pending.request.method, "cancel"));
    await Promise.allSettled([
      this.#transport.resolveRuntimeRequest?.({
        requestId: input.requestId,
        turnId: input.turnId,
        resolution: { action: "cancel" },
      }),
      this.#transport.request("turn/interrupt", {
        threadId: this.#opened.threadId,
        turnId: input.turnId,
      }),
    ]);
    return "handed_off";
  }

  async goal(input: HarnessGoalOperation): Promise<HarnessThreadGoal | null> {
    this.#requireCapability("goals");
    let method: string;
    let params: Record<string, unknown> = { threadId: this.#opened.threadId };
    if (input.action === "get") {
      method = "thread/goal/get";
    } else if (input.action === "clear") {
      method = "thread/goal/clear";
    } else {
      method = "thread/goal/set";
      if (input.action === "set") {
        params = {
          ...params,
          objective: input.objective,
          status: "active",
          ...(input.tokenBudget !== undefined
            ? { tokenBudget: input.tokenBudget }
            : {}),
        };
      } else {
        params = {
          ...params,
          status: input.action === "pause" ? "paused" : "active",
        };
      }
    }
    try {
      const response = await this.#transport.request(method, params);
      const goal =
        input.action === "clear" ? null : parseThreadGoal(response.goal);
      if (!["get", "clear"].includes(input.action) && goal === null) {
        throw new Error(`${method} omitted its goal`);
      }
      this.#goal = goal;
      const kind = input.action === "clear" ? "goal_cleared" : "goal";
      this.#emit(
        "item.completed",
        {
          kind,
          text:
            goal === null
              ? input.action === "clear"
                ? "Thread goal cleared."
                : "No thread goal is configured."
              : `Thread goal ${goal.status}: ${goal.objective}`,
          action: input.action,
          goal,
        },
        { itemId: `${this.#opened.threadId}:goal:${this.#sourceSequence + 1}` },
      );
      return goal === null ? null : structuredClone(goal);
    } catch (error) {
      throw this.#unsupported(`goal ${input.action}`, error);
    }
  }

  lineage(): HarnessThreadLineageEntry[] {
    return [...this.#lineage.values()].map((entry) => structuredClone(entry));
  }

  async read(): Promise<Record<string, unknown>> {
    this.#requireCapability("read");
    try {
      return await this.#transport.request("thread/read", {
        threadId: this.#opened.threadId,
        includeTurns: true,
      });
    } catch (error) {
      throw this.#unsupported("read", error);
    }
  }

  async reconcile(): Promise<Record<string, unknown>> {
    this.#requireCapability("reconciliation");
    const snapshot = await this.read();
    const thread = record(snapshot.thread);
    if (text(thread.id) !== this.#opened.threadId) {
      throw new HarnessReconciliationError(
        "thread/read returned a different driver session",
      );
    }
    const providerSessionId = text(thread.sessionId);
    if (
      this.#opened.providerSessionId !== null &&
      providerSessionId !== this.#opened.providerSessionId
    ) {
      throw new HarnessReconciliationError(
        "thread/read returned a different provider session",
      );
    }
    const turns = Array.isArray(thread.turns) ? thread.turns.map(record) : [];
    const reconciledUsage = boundedPayload(
      record(thread.tokenUsage ?? snapshot.tokenUsage),
    );
    if (Object.keys(reconciledUsage).length > 0) this.#usage = reconciledUsage;
    const activeTurns = turns.filter(
      (turn) => text(turn.status) === "inProgress",
    );
    const expectedTurnId = this.#activeTurnId;
    const unexpectedActive = activeTurns.find(
      (turn) => text(turn.id) !== expectedTurnId,
    );
    if (unexpectedActive !== undefined) {
      throw new HarnessReconciliationError(
        `thread/read exposed active turn ${text(unexpectedActive.id)} instead of persisted active turn ${expectedTurnId ?? "none"}`,
      );
    }

    let reconciledTerminalTurnId: string | null = null;
    if (expectedTurnId !== null) {
      const expectedTurn = turns.find(
        (turn) => text(turn.id) === expectedTurnId,
      );
      if (expectedTurn === undefined) {
        throw new HarnessReconciliationError(
          `persisted active turn ${expectedTurnId} is missing from thread/read`,
        );
      }
      const status = text(expectedTurn.status);
      if (status === "inProgress") {
        this.#activeTurnId = expectedTurnId;
      } else if (
        ["completed", "failed", "interrupted", "cancelled"].includes(status)
      ) {
        reconciledTerminalTurnId = expectedTurnId;
        this.#mapTerminalTurn(expectedTurn, expectedTurnId, true);
      } else {
        throw new HarnessReconciliationError(
          `persisted active turn ${expectedTurnId} has unreconcilable status ${status || "missing"}`,
        );
      }
    }

    for (const [turnId, fingerprint] of this.#terminalTurns) {
      const observed = turns.find((turn) => text(turn.id) === turnId);
      if (observed === undefined) continue;
      if (
        !["completed", "failed", "interrupted", "cancelled"].includes(
          text(observed.status),
        )
      ) {
        throw new HarnessReconciliationError(
          `previously terminal turn ${turnId} is no longer terminal in thread/read`,
        );
      }
      const conflict = this.#terminalReplayConflict(observed, fingerprint);
      if (conflict !== null) {
        throw new HarnessReconciliationError(
          `previously terminal turn ${turnId} ${conflict.message}`,
        );
      }
    }
    this.#emit("session.reconciled", {
      providerSessionId: this.#opened.providerSessionId,
      turnCount: turns.length,
      activeTurnId: this.#activeTurnId,
      terminalTurnId: reconciledTerminalTurnId,
    });
    return snapshot;
  }

  async usage(): Promise<Record<string, unknown> | null> {
    this.#requireCapability("usage");
    return this.#usage === null ? null : structuredClone(this.#usage);
  }

  async snapshot(): Promise<PersistedHarnessSession> {
    return {
      driverKind: this.#driverKind,
      driverSessionId: this.#opened.threadId,
      providerSessionId: this.#opened.providerSessionId,
      runId: this.#runId,
      normalizedSessionId: this.#normalizedSessionId,
      activeTurnId: this.#activeTurnId,
      semanticResult:
        this.#result === null ||
        this.#resultFingerprint === null ||
        this.#resultTurnId === null
          ? null
          : {
              result: structuredClone(this.#result),
              fingerprint: this.#resultFingerprint,
              callId: this.#resultCallId,
              turnId: this.#resultTurnId,
            },
      terminalTurns: [...this.#terminalTurns].map(([turnId, fingerprint]) => ({
        turnId,
        fingerprint,
      })),
      pendingRuntimeRequests: this.pendingRuntimeRequests(),
      goal: this.#goal === null ? null : structuredClone(this.#goal),
      lineage: this.lineage(),
      lastSourceSequence: this.#sourceSequence,
    };
  }

  async close(): Promise<void> {
    this.#cancelPendingRequests("session_closed");
    this.#events.close();
    await this.#transport.close();
  }

  async #pumpNotifications(): Promise<void> {
    try {
      for await (const notification of this.#transport.notifications()) {
        this.#mapNotification(notification);
      }
    } catch (error) {
      this.#emit("harness.diagnostic", {
        code: "notification_transport_failed",
        message: redactCodexDiagnostic(String(error)),
      });
      this.#expirePendingInputRequestsAfterProviderLoss();
      this.#failProtocol(
        "notification_transport_failed",
        "Provider notification transport failed closed.",
      );
    }
  }

  #mapNotification(notification: CodexRpcNotification): void {
    const sourceSequenceBefore = this.#sourceSequence;
    let rejected = false;
    try {
      this.#mapNotificationBody(notification);
    } catch (error) {
      rejected = true;
      throw error;
    } finally {
      const correlation = notification.paperclipTrace;
      if (correlation !== undefined) {
        const emittedEventIds: string[] = [];
        for (
          let sourceSeq = sourceSequenceBefore + 1;
          sourceSeq <= this.#sourceSequence;
          sourceSeq += 1
        ) {
          emittedEventIds.push(
            `${this.#runnerInstanceId}:${this.#runId}:${sourceSeq}`,
          );
        }
        const disposition: CodexTraceInterpretation["disposition"] = rejected
          ? "rejected"
          : emittedEventIds.length > 0
            ? "mapped"
            : "ignored";
        try {
          this.#transport.recordTraceInterpretation?.({
            sourceEventId: correlation.sourceEventId,
            sourceEventType: correlation.sourceEventType,
            providerMethod: notification.method,
            disposition,
            emittedEventIds,
            reason: rejected
              ? "Codex driver rejected the rehydrated provider notification"
              : emittedEventIds.length > 0
                ? "Codex driver normalized the rehydrated provider notification into persisted canonical PRP events"
                : "Codex driver accepted the rehydrated provider notification but emitted no canonical PRP event",
          });
        } catch {
          // Trace delivery is deliberately outside run authority.
        }
      }
    }
  }

  #mapNotificationBody(notification: CodexRpcNotification): void {
    if (!isSupportedCodexNotificationMethod(notification.method)) return;
    if (!isBoundCodexNotification(notification, {
      runId: this.#runId,
      threadIds: [...this.#lineage.keys()],
    })) {
      const params = notification.params;
      const claimedThreadId = text(
        params.threadId,
        text(record(params.thread).id, text(record(params.turn).threadId)),
      );
      const claimedRunId = text(params.runId, text(params.paperclipRunId));
      if (claimedThreadId.length > 0 || claimedRunId.length > 0) {
        this.#failProtocol(
          "thread_binding_mismatch",
          `Provider ${notification.method} message did not name the active run or a known thread.`,
        );
      }
      return;
    }
    const params = notification.params;
    const turn = record(params.turn);
    const item = itemFromParams(params);
    const threadId = text(params.threadId);
    const turnId = text(params.turnId, text(turn.id));
    const itemId = text(item.id, text(params.itemId));
    if (notification.method === "paperclip/workspaceChange/updated") {
      if (!this.#notificationNamesActiveTurn(turnId, "workspace change")) return;
      if (threadId.length > 0 && threadId !== this.#opened.threadId) return;
      this.#recordCanonicalWorkspaceChange(
        turnId,
        params.workspaceChange ?? params,
      );
      return;
    }
    if (
      (threadId.length === 0 || threadId === this.#opened.threadId) &&
      (turnId.length === 0 ||
        this.#activeTurnId === null ||
        turnId === this.#activeTurnId)
    ) {
      for (const canonical of canonicalProviderEventsFromCodex(
        notification.method,
        params,
      )) {
        this.#emit(canonical.eventType, canonical.payload, {
          turnId: turnId || undefined,
          itemId: canonical.itemId,
        });
      }
    }
    if (
      notification.method === "error" ||
      notification.method === "warning" ||
      notification.method === "configWarning"
    ) {
      this.#emit("harness.diagnostic", {
        code: notification.method.replaceAll("/", "_"),
        message: redactCodexDiagnostic(
          text(params.message, JSON.stringify(boundedCodexValue(params))),
        ),
      });
      return;
    }
    if (notification.method === "thread/started") {
      if (!this.#capabilities.threadLineage) return;
      const thread = record(params.thread);
      const lineage = lineageFromThread(thread);
      if (
        lineage.threadId.length === 0 ||
        lineage.threadId === this.#opened.threadId ||
        lineage.parentThreadId === null ||
        !this.#lineage.has(lineage.parentThreadId)
      ) {
        return;
      }
      this.#lineage.set(lineage.threadId, lineage);
      this.#emit(
        "item.started",
        {
          kind: "thread_lineage",
          text: `${lineage.nickname ?? lineage.role ?? "Child agent"} started.`,
          lineage,
        },
        { itemId: `thread:${lineage.threadId}` },
      );
      return;
    }
    if (notification.method === "thread/status/changed") {
      const lineage = this.#lineage.get(threadId);
      if (lineage === undefined || threadId === this.#opened.threadId) return;
      lineage.status = threadStatus(params.status);
      this.#emit(
        "item.delta",
        {
          kind: "thread_lineage",
          text: `${lineage.nickname ?? lineage.role ?? "Child agent"}: ${lineage.status}`,
          lineage,
        },
        { itemId: `thread:${lineage.threadId}` },
      );
      return;
    }
    if (notification.method === "thread/closed") {
      const lineage = this.#lineage.get(threadId);
      if (lineage === undefined || threadId === this.#opened.threadId) return;
      lineage.status = "closed";
      this.#emit(
        "item.completed",
        {
          kind: "thread_lineage",
          text: `${lineage.nickname ?? lineage.role ?? "Child agent"} closed.`,
          lineage,
        },
        { itemId: `thread:${lineage.threadId}` },
      );
      return;
    }
    if (notification.method === "thread/goal/updated") {
      if (threadId !== this.#opened.threadId) return;
      const goal = parseThreadGoal(params.goal);
      if (goal === null) return;
      this.#goal = goal;
      this.#emit(
        "item.completed",
        {
          kind: "goal",
          text: `Thread goal ${goal.status}: ${goal.objective}`,
          action: "notification",
          goal,
        },
        {
          turnId: turnId || undefined,
          itemId: `${threadId}:goal:update:${this.#sourceSequence + 1}`,
        },
      );
      return;
    }
    if (notification.method === "thread/goal/cleared") {
      if (threadId !== this.#opened.threadId) return;
      this.#goal = null;
      this.#emit(
        "item.completed",
        {
          kind: "goal_cleared",
          text: "Thread goal cleared.",
          action: "notification",
          goal: null,
        },
        { itemId: `${threadId}:goal:clear:${this.#sourceSequence + 1}` },
      );
      return;
    }
    if (notification.method === "serverRequest/resolved") {
      const requestId = String(params.requestId ?? "");
      const pending = this.#pendingRuntimeRequests.get(requestId);
      if (pending === undefined || threadId !== this.#opened.threadId) return;
      this.#pendingRuntimeRequests.delete(requestId);
      const resolution = pending.settlingResolution;
      this.#emit(
        resolution === undefined ? "runtime_request.cancelled" : "runtime_request.resolved",
        harnessRuntimeRequestOutcome(
          pending.request,
          resolution === undefined
            ? { reason: "provider_resolved" }
            : {
                action: resolution.action,
                ...(resolution.action === "submit" && "response" in resolution
                  ? { response: resolution.response }
                  : {}),
              },
        ),
        { turnId: pending.request.turnId, itemId: pending.request.itemId },
      );
      pending.settle(
        resolution === undefined
          ? safeRequestResponse(pending.request.method, "cancel")
          : runtimeRequestResponse(pending.request, resolution),
      );
      return;
    }
    if (
      notification.method === "item/completed"
      && text(params.kind) === "steering_acknowledgement"
      && Object.keys(item).length === 0
    ) {
      // runnerd persists its own command acknowledgement as a canonical PRP
      // item. The request() call is already the authoritative acknowledgement
      // and steer() emits the user-visible item with the active turn binding.
      // Do not reinterpret this transport-level echo as an unbound Codex item.
      return;
    }
    if (notification.method === "paperclip/runResult") {
      if (
        threadId !== this.#opened.threadId
        || !this.#notificationNamesActiveTurn(turnId, "semantic result")
      ) {
        if (threadId !== this.#opened.threadId) {
          this.#failProtocol(
            "thread_binding_mismatch",
            "Provider semantic result did not name the opened thread.",
          );
        }
        return;
      }
      if (!isRetainableCodexPayload(params.result)) {
        this.#failProtocol(
          "invalid_semantic_result",
          "Provider semantic result exceeded the retained payload limit.",
        );
        return;
      }
      const validation = validatePrpStructuredRunResult(params.result);
      if (!validation.ok) {
        this.#failProtocol(
          "invalid_semantic_result",
          "Provider semantic result did not match the run-result contract.",
        );
        return;
      }
      const differingFields = this.#result === null
        ? []
        : differingJsonPaths(this.#result, validation.result);
      if (this.#admitResult(validation.result, itemId, turnId) === "conflict") {
        this.#failProtocol(
          "conflicting_semantic_result",
          `Provider supplied a different schema-valid semantic result after one was committed. Differing fields: ${differingFields.join(", ") || "unknown"}.`,
        );
      }
      return;
    }
    if (threadId !== this.#opened.threadId) {
      this.#failProtocol(
        "thread_binding_mismatch",
        `Provider ${notification.method} message did not name the opened thread.`,
      );
      return;
    }
    if (notification.method === "turn/started") {
      if (
        turnId.length === 0 ||
        this.#terminal ||
        this.#protocolFailed ||
        this.#turnStarted ||
        (!this.#turnStartPending && this.#activeTurnId === null) ||
        (this.#activeTurnId !== null && this.#activeTurnId !== turnId)
      ) {
        this.#failProtocol(
          "turn_binding_mismatch",
          "Provider started an unexpected turn.",
        );
        return;
      }
      this.#activeTurnId = turnId;
      this.#turnStarted = true;
      this.#emit(
        "turn.started",
        { status: text(turn.status, "inProgress") },
        { turnId },
      );
      return;
    }
    if (notification.method === "turn/completed") {
      if (this.#terminalTurns.has(turnId)) {
        this.#mapTerminalTurn(turn, turnId);
        return;
      }
      if (!this.#notificationNamesActiveTurn(turnId, "turn terminal")) return;
      this.#mapTerminalTurn(turn, turnId);
      return;
    }
    if (notification.method === "item/started") {
      if (!this.#notificationNamesActiveTurn(turnId, "item start")) return;
      const channel = this.#channelForStartedItem(item);
      if (itemId) this.#itemChannels.set(itemId, channel);
      this.#emit(
        "item.started",
        boundedPayload({
          kind: text(item.type, "unknown"),
          channel,
          providerPhase: text(item.phase) || undefined,
          text: itemText(item),
          item,
        }),
        { turnId, itemId },
      );
      return;
    }
    if (notification.method === "item/completed") {
      if (!this.#notificationNamesActiveTurn(turnId, "item completion")) return;
      if (!this.#captureResultFromItem(item, turnId)) return;
      const channel = itemId
        ? (this.#itemChannels.get(itemId) ?? this.#channelForStartedItem(item))
        : this.#channelForStartedItem(item);
      this.#emit(
        "item.completed",
        boundedPayload({
          kind: text(item.type, "unknown"),
          channel,
          providerPhase: text(item.phase) || undefined,
          text: itemText(item),
          item,
        }),
        { turnId, itemId },
      );
      if (text(item.type) === "agentMessage") {
        for (const reference of paperclipWorkspaceFileReferencesFromText(
          this.#opened.context.workingDirectory,
          text(item.text),
          turnId,
        )) {
          if (this.#emittedFileReferences.has(reference.referenceId)) continue;
          this.#emittedFileReferences.add(reference.referenceId);
          this.#emit(
            "workspace.file.referenced",
            { ...reference },
            { turnId, itemId: reference.referenceId },
          );
        }
      }
      if (itemId) this.#itemChannels.delete(itemId);
      if (text(item.type) === "fileChange")
        this.#recordWorkspaceChanges(turnId, item.changes, true);
      return;
    }
    const deltaKinds: Record<string, string> = {
      "item/agentMessage/delta": "agentMessage",
      "item/plan/delta": "plan",
      "item/reasoning/summaryTextDelta": "reasoning",
      "item/reasoning/textDelta": "reasoning",
      "item/commandExecution/outputDelta": "commandExecution",
      "item/fileChange/outputDelta": "fileChange",
      "item/fileChange/patchUpdated": "fileChange",
      "turn/diff/updated": "diff",
      "turn/plan/updated": "plan",
    };
    const deltaKind = deltaKinds[notification.method];
    if (deltaKind !== undefined) {
      if (!this.#notificationNamesActiveTurn(turnId, "item update")) return;
      const methodChannel = this.#channelForDelta(notification.method);
      const channel =
        methodChannel !== "unknown"
          ? methodChannel
          : itemId
            ? (this.#itemChannels.get(itemId) ?? "unknown")
            : "unknown";
      this.#emit(
        "item.delta",
        boundedPayload({
          kind: deltaKind,
          channel,
          providerMethod: notification.method,
          text: text(params.delta, text(params.patch, text(params.output))),
          update: params,
        }),
        { turnId, itemId: itemId || `${turnId}:${deltaKind}` },
      );
      if (notification.method === "item/fileChange/patchUpdated") {
        this.#recordWorkspaceChanges(turnId, params.changes, false);
      } else if (notification.method === "turn/diff/updated") {
        this.#recordTurnDiff(turnId, params.diff);
      }
      return;
    }
    if (notification.method === "thread/tokenUsage/updated") {
      this.#usage = boundedPayload(record(params.tokenUsage));
      // Codex can replay a thread-scoped usage snapshot while a resumed thread
      // is being attached, before the next turn has started. Keep the snapshot,
      // but do not turn that benign replay into a fatal turn-binding violation.
      if (this.#activeTurnId === null || turnId !== this.#activeTurnId) return;
      this.#emit(
        "item.completed",
        { kind: "usage", usage: this.#usage },
        {
          turnId,
          itemId: `${turnId}:usage:${this.#sourceSequence + 1}`,
        },
      );
      return;
    }
  }

  #channelForStartedItem(
    item: Record<string, unknown>,
  ): "progress" | "final" | "summary" | "detail" | "unknown" {
    const type = text(item.type);
    const phase = text(item.phase).toLowerCase();
    if (type === "agentMessage") {
      if (phase === "commentary") return "progress";
      if (phase === "final_answer") return "final";
      return "unknown";
    }
    if (type === "reasoning") return "summary";
    return "unknown";
  }

  #channelForDelta(
    method: string,
  ): "progress" | "final" | "summary" | "detail" | "unknown" {
    if (method === "item/reasoning/summaryTextDelta") return "summary";
    if (method === "item/reasoning/textDelta") return "detail";
    return "unknown";
  }

  #recordWorkspaceChanges(
    turnId: string,
    value: unknown,
    complete: boolean,
  ): void {
    const changes = Array.isArray(value) ? value : [];
    const files = changes
      .slice(0, 2_000)
      .flatMap((candidate): Record<string, unknown>[] => {
        const change = record(candidate);
        const path = text(change.path).replaceAll("\\", "/");
        if (!path || path.startsWith("/") || path.split("/").includes(".."))
          return [];
        const kind = change.kind;
        const kindRecord = record(kind);
        const kindText = text(
          kind,
          text(kindRecord.type, Object.keys(kindRecord)[0] ?? "update"),
        );
        const update = record(kindRecord.update ?? change.update);
        const previousPath =
          text(update.move_path, text(update.movePath)) || null;
        const operation = previousPath
          ? "rename"
          : kindText.toLowerCase().includes("add")
            ? "create"
            : kindText.toLowerCase().includes("delete")
              ? "delete"
              : "modify";
        const diff = text(change.diff).slice(0, 262_144) || null;
        const diffLines = diff?.split("\n") ?? [];
        return [
          {
            path,
            operation,
            previousPath,
            additions:
              diff === null
                ? null
                : diffLines.filter(
                    (line) => line.startsWith("+") && !line.startsWith("+++"),
                  ).length,
            deletions:
              diff === null
                ? null
                : diffLines.filter(
                    (line) => line.startsWith("-") && !line.startsWith("---"),
                  ).length,
            binary: diff === null,
            diff,
          },
        ];
      });
    if (files.length === 0) return;
    const unknown = files.some(
      (file) => file.additions === null || file.deletions === null,
    );
    const payload = {
      schema: "paperclip.workspace.diff.v1",
      changeSetId: `${turnId}:workspace`,
      revision:
        Number(record(this.#workspaceChangesByTurn.get(turnId)).revision ?? 0) +
        1,
      source: "harness_reported",
      complete,
      files,
      totals: {
        files: files.length,
        additions: unknown
          ? null
          : files.reduce((sum, file) => sum + Number(file.additions), 0),
        deletions: unknown
          ? null
          : files.reduce((sum, file) => sum + Number(file.deletions), 0),
      },
      patchArtifactRef: null,
    };
    this.#workspaceChangesByTurn.set(turnId, payload);
    this.#emit("workspace.change.updated", payload, {
      turnId,
      itemId: `${turnId}:workspace`,
    });
  }

  #recordTurnDiff(turnId: string, value: unknown): void {
    const diff = text(value);
    const files = parseCodexTurnDiff(diff);
    // An empty string is an authoritative empty aggregate snapshot. A
    // non-empty value that cannot be parsed is left on the bounded diagnostic
    // item.delta path instead of erasing the last valid workspace snapshot.
    if (files.length === 0 && diff.trim()) return;
    this.#recordWorkspaceSnapshot(turnId, files);
  }

  #recordCanonicalWorkspaceChange(turnId: string, value: unknown): void {
    const candidate = record(value);
    if (candidate.schema !== "paperclip.workspace.diff.v1") return;
    if (!Array.isArray(candidate.files)) return;
    const files = candidate.files.slice(0, 2_000).flatMap((value) => {
      const file = record(value);
      const path = workspaceRelativePath(file.path);
      if (path === null) return [];
      const operation = text(file.operation);
      if (
        operation !== "create" &&
        operation !== "modify" &&
        operation !== "delete" &&
        operation !== "rename" &&
        operation !== "mode_change"
      ) return [];
      const previousPath =
        file.previousPath === null || file.previousPath === undefined
          ? null
          : workspaceRelativePath(file.previousPath);
      if (operation === "rename" && previousPath === null) return [];
      const binary = file.binary === true;
      const diff =
        binary || file.diff === null || file.diff === undefined
          ? null
          : typeof file.diff === "string"
            ? file.diff.slice(0, 262_144)
            : null;
      const additions = boundedWorkspaceStat(file.additions);
      const deletions = boundedWorkspaceStat(file.deletions);
      return [{
        path,
        operation: operation as ParsedCodexTurnDiffFile["operation"],
        previousPath,
        additions: binary ? null : additions,
        deletions: binary ? null : deletions,
        binary,
        diff,
      }];
    });
    // Empty is an authoritative snapshot. If the provider supplied entries
    // but every one failed validation, retain the previous valid revision.
    if (candidate.files.length > 0 && files.length === 0) return;
    this.#recordWorkspaceSnapshot(
      turnId,
      files,
      candidate.revision,
      typeof candidate.patchArtifactRef === "string"
        ? candidate.patchArtifactRef.slice(0, 2_048)
        : null,
    );
  }

  #recordWorkspaceSnapshot(
    turnId: string,
    files: ReturnType<typeof parseCodexTurnDiff>,
    requestedRevision?: unknown,
    patchArtifactRef: string | null = null,
  ): void {
    const previous = this.#workspaceChangesByTurn.get(turnId);
    if (
      previous !== undefined &&
      JSON.stringify(record(previous).files) === JSON.stringify(files) &&
      record(previous).patchArtifactRef === patchArtifactRef
    ) return;
    const unknown = files.some(
      (file) => file.additions === null || file.deletions === null,
    );
    const priorRevision = Number(record(previous).revision ?? 0);
    const incomingRevision =
      typeof requestedRevision === "number" &&
      Number.isSafeInteger(requestedRevision) &&
      requestedRevision > 0
        ? requestedRevision
        : 1;
    const payload = {
      schema: "paperclip.workspace.diff.v1",
      changeSetId: `${turnId}:workspace`,
      revision: Math.max(priorRevision + 1, incomingRevision),
      source: "harness_reported",
      complete: false,
      files,
      totals: {
        files: files.length,
        additions: unknown
          ? null
          : files.reduce((sum, file) => sum + Number(file.additions), 0),
        deletions: unknown
          ? null
          : files.reduce((sum, file) => sum + Number(file.deletions), 0),
      },
      patchArtifactRef,
    };
    this.#workspaceChangesByTurn.set(turnId, payload);
    this.#emit("workspace.change.updated", payload, {
      turnId,
      itemId: `${turnId}:workspace`,
    });
  }

  async #handleServerRequest(
    request: CodexRpcServerRequest,
  ): Promise<Record<string, unknown>> {
    const sourceSequenceBefore = this.#sourceSequence;
    let rejected = false;
    try {
      const response = await this.#handleServerRequestBody(request);
      rejected = response.success === false;
      return response;
    } catch (error) {
      rejected = true;
      throw error;
    } finally {
      const correlation = request.paperclipTrace;
      if (correlation !== undefined) {
        const emittedEventIds: string[] = [];
        for (
          let sourceSeq = sourceSequenceBefore + 1;
          sourceSeq <= this.#sourceSequence;
          sourceSeq += 1
        ) {
          emittedEventIds.push(
            `${this.#runnerInstanceId}:${this.#runId}:${sourceSeq}`,
          );
        }
        try {
          this.#transport.recordTraceInterpretation?.({
            sourceEventId: correlation.sourceEventId,
            sourceEventType: correlation.sourceEventType,
            providerMethod: request.method,
            disposition: rejected
              ? "rejected"
              : emittedEventIds.length > 0
                ? "mapped"
                : "ignored",
            emittedEventIds,
            reason: rejected
              ? "Codex driver rejected the correlated provider server request"
              : emittedEventIds.length > 0
                ? "Codex driver mapped the correlated provider server request into canonical PRP events"
                : "Codex driver accepted the correlated provider server request without emitting a canonical PRP event",
          });
        } catch {
          // Trace delivery is deliberately outside run authority.
        }
      }
    }
  }

  async #handleServerRequestBody(
    request: CodexRpcServerRequest,
  ): Promise<Record<string, unknown>> {
    if (request.method === "item/tool/call") {
      const tool = text(request.params.tool);
      const threadId = text(request.params.threadId);
      const turnId = text(request.params.turnId);
      const callId = text(request.params.callId);
      if (
        this.#protocolFailed ||
        this.#terminal ||
        threadId !== this.#opened.threadId ||
        turnId.length === 0 ||
        turnId !== this.#activeTurnId ||
        callId.length === 0
      ) {
        this.#failProtocol(
          "tool_binding_mismatch",
          "Semantic tool call did not name the active thread and turn.",
        );
        return rejectedToolCall(
          "Semantic tool call was outside the active thread and turn.",
        );
      }
      if (!isSemanticTool(tool)) {
        const admitted = this.#dynamicTools.some(
          (candidate) => candidate.name === tool,
        );
        if (admitted && this.#dynamicToolHandler !== undefined) {
          this.#emit(
            "item.started",
            {
              kind: "dynamicToolCall",
              item: {
                type: "tool_use",
                id: callId,
                name: tool,
                input: request.params.arguments,
              },
            },
            { turnId, itemId: callId },
          );
          try {
            const result = await this.#dynamicToolHandler({
              tool,
              callId,
              threadId,
              turnId,
              arguments: request.params.arguments,
            });
            this.#emit(
              "item.completed",
              {
                kind: "dynamicToolCall",
                item: {
                  type: "tool_result",
                  id: callId,
                  tool_use_id: callId,
                  result,
                },
              },
              { turnId, itemId: callId },
            );
            return dynamicToolResponse(result);
          } catch (error) {
            const message = boundedText(
              error instanceof Error ? error.message : error,
            );
            this.#emit(
              "item.completed",
              {
                kind: "dynamicToolCall",
                item: {
                  type: "tool_result",
                  id: callId,
                  tool_use_id: callId,
                  error: message,
                  is_error: true,
                },
              },
              { turnId, itemId: callId },
            );
            return {
              success: false,
              contentItems: [{ type: "inputText", text: message }],
            };
          }
        }
        this.#diagnoseUnsupported(`dynamic tool ${tool}`);
        return rejectedToolCall("Unsupported tool.");
      }
      if (!isRetainableCodexPayload(request.params.arguments)) {
        return rejectedToolCall(
          "Semantic result exceeded the retained payload limit.",
        );
      }
      const validation = validatePrpStructuredRunResult(
        request.params.arguments,
      );
      if (!validation.ok) {
        return {
          success: false,
          contentItems: [
            { type: "inputText", text: "Invalid semantic result." },
          ],
        };
      }
      if (
        !toolAcceptsDisposition(tool, validation.result.reportedWorkDisposition)
      ) {
        return {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text:
                tool === CODEX_BLOCK_TOOL_NAME
                  ? "paperclip_block requires reportedWorkDisposition=blocked."
                  : "paperclip_finish accepts only done or needs_review.",
            },
          ],
        };
      }
      const admission = this.#admitResult(validation.result, callId, turnId);
      if (admission === "conflict") {
        return rejectedToolCall(
          "A different semantic result was already committed.",
        );
      }
      return {
        success: true,
        contentItems: [
          { type: "inputText", text: "Semantic completion accepted." },
        ],
      };
    }

    const requestKind = runtimeRequestKind(request.method);
    if (requestKind === null) return safeRequestResponse(request.method);
    const requestTurnId = text(request.params.turnId);
    if (
      text(request.params.threadId) !== this.#opened.threadId ||
      requestTurnId.length === 0 ||
      requestTurnId !== this.#activeTurnId ||
      this.#terminal ||
      this.#protocolFailed
    ) {
      this.#failProtocol(
        "runtime_request_binding_mismatch",
        "Runtime request did not name the active thread and turn.",
      );
      return safeRequestResponse(request.method);
    }
    const requestId = String(request.id);
    if (this.#pendingRuntimeRequests.has(requestId)) {
      this.#failProtocol(
        "runtime_request_duplicate",
        "Provider reused a pending runtime request identity.",
      );
      return safeRequestResponse(request.method);
    }
    let input: PaperclipQuestionSet | null = null;
    try {
      input = normalizeCodexQuestionSet(request.method, request.params);
    } catch {
      this.#emit("harness.diagnostic", {
        code: "runtime_input_rejected",
        adapter: "codex-app-server",
        method: request.method,
        reason: "The provider input request contained an invalid question form.",
      }, { turnId: requestTurnId, itemId: String(request.id) });
      return safeRequestResponse(request.method);
    }
    if (
      (requestKind === "user_input" || requestKind === "elicitation") &&
      input === null &&
      hasCodexQuestionForm(request.method, request.params)
    ) {
      this.#emit("harness.diagnostic", {
        code: "runtime_input_rejected",
        adapter: "codex-app-server",
        method: request.method,
        reason: "The provider input request did not contain a supported question form.",
      }, { turnId: requestTurnId, itemId: String(request.id) });
      return safeRequestResponse(request.method);
    }
    const runtimeRequest: HarnessRuntimeRequest = {
      requestId,
      requestKind,
      method: request.method,
      turnId: requestTurnId,
      itemId: text(request.params.itemId, requestId),
      status: "pending",
      prompt: runtimeRequestPrompt(requestKind, request.params),
      details: record(redactCodexValue(boundedCodexValue(request.params))),
      ...(input !== null ? { input } : {}),
      origin: {
        adapter: "codex-app-server",
        provider: "codex",
        method: request.method,
      },
    };
    this.#emit(
      "runtime_request.created",
      {
        request: runtimeRequestProtocolPayload(runtimeRequest),
      },
      {
        turnId: requestTurnId,
        itemId: runtimeRequest.itemId,
      },
    );
    return new Promise<Record<string, unknown>>((settle) => {
      this.#pendingRuntimeRequests.set(requestId, {
        request: runtimeRequest,
        settle,
      });
    });
  }

  #captureResultFromItem(
    item: Record<string, unknown>,
    turnId: string,
  ): boolean {
    if (this.#conversationMode === "direct") return true;
    if (
      text(item.type) !== "agentMessage" ||
      !isRetainableCodexPayload(item.text)
    )
      return true;
    const result = tryParseResult(item.text);
    if (result !== null && isRetainableCodexPayload(result)) {
      const admission = this.#admitResult(result, text(item.id), turnId);
      if (admission === "conflict") {
        this.#failProtocol(
          "conflicting_semantic_result",
          "Provider agentMessage supplied a different schema-valid semantic result after one was committed.",
        );
        return false;
      }
    }
    return true;
  }

  #admitResult(
    result: PrpStructuredRunResult,
    itemId: string,
    turnId?: string,
  ): SemanticResultAdmission {
    const fingerprint = canonicalJson(result);
    if (this.#resultFingerprint !== null) {
      return this.#resultFingerprint === fingerprint ? "identical" : "conflict";
    }
    this.#result = structuredClone(result);
    this.#resultFingerprint = fingerprint;
    this.#resultCallId = itemId || null;
    this.#resultTurnId = turnId || this.#activeTurnId;
    result.verification.forEach((verification, index) => {
      this.#emit(
        "item.completed",
        {
          kind: "verification",
          text: `${verification.status}: ${verification.commandOrCheck}`,
          verification,
        },
        {
          turnId: turnId || this.#activeTurnId || undefined,
          itemId: `${itemId || "semantic-result"}:verification:${index + 1}`,
        },
      );
    });
    this.#emit("run.result.proposed", result, {
      turnId: turnId || this.#activeTurnId || undefined,
      itemId: itemId || undefined,
    });
    return "committed";
  }

  #finalize(turnStatus: string): void {
    if (this.#conversationMode === "direct") return;
    if (this.#terminal) return;
    if (this.#result === null) {
      this.#emit("harness.diagnostic", {
        code: "semantic_result_missing",
        message: `Turn ${turnStatus} without a schema-valid semantic proposal; recovery is required.`,
      });
    }
    this.#terminal = true;
  }

  #mapTerminalTurn(
    turn: Record<string, unknown>,
    fallbackTurnId: string,
    reconciling = false,
  ): void {
    const turnId = text(turn.id, fallbackTurnId || this.#activeTurnId || "");
    const status = text(turn.status, "completed");
    const previous = this.#terminalTurns.get(turnId);
    if (previous !== undefined) {
      const conflict = this.#terminalReplayConflict(turn, previous);
      if (conflict !== null) {
        if (reconciling) {
          throw new HarnessReconciliationError(
            `previously terminal turn ${turnId} ${conflict.message}`,
          );
        }
        this.#failProtocol(
          conflict.code,
          `Provider terminal for turn ${turnId} ${conflict.message}.`,
        );
      }
      return;
    }
    const candidate = this.#resultFromTurn(turn);
    if (candidate !== null) {
      const admission = this.#admitResult(
        candidate,
        text(this.#resultItemFromTurn(turn)?.id),
        turnId,
      );
      if (admission === "conflict") {
        const message = `terminal turn ${turnId} contains a conflicting semantic result`;
        if (reconciling) throw new HarnessReconciliationError(message);
        this.#failProtocol(
          "conflicting_semantic_result",
          `Provider ${message}.`,
        );
        return;
      }
    }
    this.#terminalTurns.set(turnId, this.#terminalFingerprint(turn));
    const workspace = this.#workspaceChangesByTurn.get(turnId);
    if (workspace !== undefined) {
      this.#emit(
        "workspace.diff.recorded",
        { ...workspace, source: "runner_verified", complete: true },
        {
          turnId,
          itemId: `${turnId}:workspace`,
        },
      );
    }
    const eventType =
      status === "failed"
        ? "turn.failed"
        : status === "interrupted"
          ? "turn.interrupted"
          : status === "cancelled"
            ? "turn.cancelled"
            : "turn.completed";
    this.#cancelPendingRequests("turn_terminal");
    this.#activeTurnId = null;
    this.#turnStarted = false;
    this.#emit(
      eventType,
      boundedPayload({
        status,
        error: turn.error ?? null,
      }),
      { turnId },
    );
    this.#finalize(status);
  }

  #terminalFingerprint(
    turn: Record<string, unknown>,
    semanticResult: PrpStructuredRunResult | null = this.#result,
  ): string {
    return canonicalJson({
      terminalState: terminalState(text(turn.status, "completed")),
      error: turn.error ?? null,
      result: semanticResult,
    });
  }

  #terminalReplayConflict(
    turn: Record<string, unknown>,
    expectedFingerprint: string,
  ): TerminalReplayConflict | null {
    const candidate = this.#resultFromTurn(turn);
    if (
      candidate !== null &&
      this.#resultFingerprint !== null &&
      canonicalJson(candidate) !== this.#resultFingerprint
    ) {
      return {
        code: "conflicting_semantic_result",
        message: "contains a conflicting semantic result",
      };
    }
    const semanticResult = this.#result ?? candidate;
    if (
      this.#terminalFingerprint(turn, semanticResult) !== expectedFingerprint
    ) {
      return {
        code: "conflicting_turn_terminal",
        message: "changed from its committed terminal fingerprint",
      };
    }
    if (candidate !== null && this.#result === null) {
      this.#admitResult(
        candidate,
        text(this.#resultItemFromTurn(turn)?.id),
        text(turn.id),
      );
    }
    return null;
  }

  #resultItemFromTurn(
    turn: Record<string, unknown>,
  ): Record<string, unknown> | null {
    if (!Array.isArray(turn.items)) return null;
    return (
      turn.items
        .map(record)
        .reverse()
        .find(
          (value) =>
            text(value.type) === "agentMessage" &&
            isRetainableCodexPayload(value.text) &&
            tryParseResult(value.text) !== null,
        ) ?? null
    );
  }

  #resultFromTurn(
    turn: Record<string, unknown>,
  ): PrpStructuredRunResult | null {
    const item = this.#resultItemFromTurn(turn);
    return item === null ? null : tryParseResult(item.text);
  }

  #requireActiveTurn(turnId: string, operation: string): void {
    if (this.#activeTurnId !== turnId) {
      this.#emit("harness.diagnostic", {
        code: "stale_turn_rejected",
        operation,
        turnId,
        activeTurnId: this.#activeTurnId,
        message: `Rejected ${operation} for a stale turn identity.`,
      });
      throw new HarnessStaleTurnError(turnId);
    }
  }

  #cancelPendingRequests(reason: string): void {
    for (const pending of this.#pendingRuntimeRequests.values()) {
      this.#emit(
        pending.request.input === undefined ? "runtime_request.cancelled" : "runtime_request.expired",
        pending.request.input === undefined
          ? harnessRuntimeRequestOutcome(pending.request, { reason })
          : harnessRuntimeInputExpiredOutcome(pending.request, "provider_process_lost"),
        { turnId: pending.request.turnId, itemId: pending.request.itemId },
      );
      pending.settle(safeRequestResponse(pending.request.method, "cancel"));
    }
    this.#pendingRuntimeRequests.clear();
  }

  #expirePendingInputRequestsAfterProviderLoss(): void {
    for (const [requestId, pending] of this.#pendingRuntimeRequests) {
      if (pending.request.input === undefined) continue;
      this.#emit(
        "runtime_request.expired",
        harnessRuntimeInputExpiredOutcome(pending.request, "provider_process_lost"),
        { turnId: pending.request.turnId, itemId: pending.request.itemId },
      );
      pending.settle(safeRequestResponse(pending.request.method, "cancel"));
      this.#pendingRuntimeRequests.delete(requestId);
    }
  }

  #notificationNamesActiveTurn(turnId: string, kind: string): boolean {
    if (
      this.#protocolFailed ||
      this.#terminal ||
      turnId.length === 0 ||
      this.#activeTurnId === null ||
      turnId !== this.#activeTurnId
    ) {
      this.#failProtocol(
        "turn_binding_mismatch",
        `Provider ${kind} did not name the active turn.`,
      );
      return false;
    }
    return true;
  }

  #requireCapability(operation: keyof CodexCapabilities): void {
    if (!this.#capabilities[operation])
      throw this.#unsupported(operation, "capability not advertised");
  }

  #unsupported(
    operation: string,
    detail: unknown,
  ): HarnessCapabilityUnavailableError {
    const error = new HarnessCapabilityUnavailableError(
      operation,
      redactCodexDiagnostic(String(detail)),
    );
    this.#diagnoseUnsupported(operation, error.message);
    return error;
  }

  #diagnoseUnsupported(
    operation: string,
    detail = "operation is not available",
  ): void {
    this.#emit("harness.diagnostic", {
      code: "unsupported_operation",
      operation,
      message: redactCodexDiagnostic(detail),
    });
  }

  #failProtocol(code: string, message: string): void {
    if (this.#protocolFailed) return;
    this.#protocolFailed = true;
    this.#protocolFailureCode = code;
    this.#protocolFailureMessage = redactCodexDiagnostic(message);
    this.#cancelPendingRequests("protocol_failed");
    this.#emit("session.failed", {
      code,
      message: redactCodexDiagnostic(message),
      recoverable: false,
    });
    if (!this.#terminal && this.#activeTurnId !== null) {
      const turnId = this.#activeTurnId;
      this.#emit(
        "turn.failed",
        { status: "failed", error: { code } },
        { turnId },
      );
      this.#terminalTurns.set(turnId, canonicalJson({ protocolFailure: code }));
      this.#activeTurnId = null;
    }
    this.#terminal = true;
    this.#events.close();
    void this.#transport.close();
  }

  #emit(
    eventType: PrpEvent["eventType"],
    payload: Record<string, unknown>,
    refs: { turnId?: string; itemId?: string } = {},
  ): void {
    const sourceSeq = ++this.#sourceSequence;
    this.#events.push({
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${this.#runnerInstanceId}:${this.#runId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: this.#runnerInstanceId,
      sourceKind: "runner",
      runId: this.#runId,
      normalizedSessionId: this.#normalizedSessionId,
      ...(refs.turnId ? { turnId: refs.turnId } : {}),
      ...(refs.itemId ? { itemId: refs.itemId } : {}),
      eventType,
      schemaVersion: 1,
      priority: eventType === "run.result.proposed" ? 0 : 1,
      emittedAt: this.#now().toISOString(),
      payload,
    });
  }
}
