import type {
  HarnessThreadGoal,
  HarnessThreadLineageEntry,
} from "../../contracts/harness-driver.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function parseCodexThreadGoal(value: unknown): HarnessThreadGoal | null {
  const goal = record(value);
  const threadId = text(goal.threadId);
  const objective = text(goal.objective);
  const status = text(goal.status);
  if (
    threadId.length === 0 ||
    objective.length === 0 ||
    ![
      "active",
      "paused",
      "blocked",
      "usageLimited",
      "budgetLimited",
      "complete",
    ].includes(status)
  ) {
    return null;
  }
  return {
    threadId,
    objective,
    status: status as HarnessThreadGoal["status"],
    tokenBudget: typeof goal.tokenBudget === "number" ? goal.tokenBudget : null,
    tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0,
    timeUsedSeconds:
      typeof goal.timeUsedSeconds === "number" ? goal.timeUsedSeconds : 0,
    createdAt: typeof goal.createdAt === "number" ? goal.createdAt : 0,
    updatedAt: typeof goal.updatedAt === "number" ? goal.updatedAt : 0,
  };
}

function threadStatus(value: unknown): string {
  if (typeof value === "string") return value;
  return text(record(value).type, "unknown");
}

export function codexThreadLineage(value: unknown): HarnessThreadLineageEntry {
  const thread = record(value);
  const source = record(thread.source);
  const subAgent = source.subAgent ?? source.subagent;
  const subAgentRecord = record(subAgent);
  const spawn = record(
    subAgentRecord.thread_spawn ?? subAgentRecord.threadSpawn,
  );
  const parentThreadId =
    text(
      spawn.parent_thread_id ?? spawn.parentThreadId,
      text(thread.forkedFromId),
    ) || null;
  return {
    threadId: text(thread.id),
    providerSessionId: text(thread.sessionId) || null,
    parentThreadId,
    depth:
      typeof spawn.depth === "number"
        ? spawn.depth
        : parentThreadId === null
          ? 0
          : 1,
    nickname:
      text(
        thread.agentNickname,
        text(spawn.agent_nickname ?? spawn.agentNickname),
      ) || null,
    role:
      text(thread.agentRole, text(spawn.agent_role ?? spawn.agentRole)) || null,
    status: threadStatus(thread.status),
  };
}

export function isBoundCodexNotification(method: string): boolean {
  return (
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "thread/started" ||
    method === "thread/status/changed" ||
    method === "thread/closed" ||
    method === "thread/goal/updated" ||
    method === "thread/goal/cleared" ||
    method === "serverRequest/resolved" ||
    method === "thread/tokenUsage/updated" ||
    method === "error" ||
    method === "warning" ||
    method === "configWarning" ||
    method === "guardianWarning" ||
    method === "deprecationNotice" ||
    method === "windows/worldWritableWarning" ||
    method === "hook/started" ||
    method === "hook/completed" ||
    method === "thread/compacted" ||
    method === "model/rerouted" ||
    method === "model/verification" ||
    method === "model/safetyBuffering/updated" ||
    method.startsWith("item/") ||
    method === "paperclip/workspaceChange/updated" ||
    method === "paperclip/runResult" ||
    method === "turn/diff/updated" ||
    method === "turn/plan/updated"
  );
}

export function codexWorkspaceRelativePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim().replaceAll("\\", "/");
  if (
    path.length === 0 ||
    path.length > 1_024 ||
    path.startsWith("/") ||
    path.startsWith("//") ||
    /^[A-Za-z]:\//u.test(path) ||
    path.split("/").some((part) => part === ".." || part.length === 0)
  ) return null;
  return path;
}

export function boundedCodexWorkspaceStat(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function safeCodexRequestResponse(
  method: string,
  action: "decline" | "cancel" = "decline",
): Record<string, unknown> {
  if (method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (method === "mcpServer/elicitation/request") {
    return { action, content: null, _meta: null };
  }
  if (
    method === "item/tool/requestUserInput" ||
    method === "tool/requestUserInput"
  ) {
    return { answers: {} };
  }
  if (
    method.includes("requestApproval") ||
    method === "execCommandApproval" ||
    method === "applyPatchApproval"
  ) {
    return { decision: action };
  }
  return {};
}
