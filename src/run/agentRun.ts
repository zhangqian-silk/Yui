import { isAgentAdapterId, type AgentAdapterId } from "../agent/adapterCatalog.js";
import {
  validateManagedWorkspace,
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";

export type DispatchMode = "new" | "resume";
export type AgentRunStatus = "active" | "yielded" | "failed";
export type AgentRunPurpose = "execution" | "review";

export type AgentRun = {
  schemaVersion: 3;
  id: string;
  taskId: string;
  roleName: string;
  mode: DispatchMode;
  input: string;
  purpose: AgentRunPurpose;
  workItemId?: string;
  reviewRoundId?: string;
  workspace?: ManagedWorkspace;
  agentId?: string;
  adapterId?: AgentAdapterId;
  model?: string;
  effort?: string;
  status: AgentRunStatus;
  /** Set only after tmux has confirmed the receipt-backed input delivery. */
  deliveredAt?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

export function createAgentRun(
  id: string,
  taskId: string,
  roleName: string,
  mode: DispatchMode,
  input: string,
  now: Date,
  context: {
    workItemId?: string;
    purpose?: AgentRunPurpose;
    reviewRoundId?: string;
    workspace?: ManagedWorkspace;
    agent?: Readonly<{
      agentId: string;
      adapterId: AgentAdapterId;
      model?: string;
      effort?: string;
    }>;
  } = {}
): AgentRun {
  if (mode !== "new" && mode !== "resume") {
    throw new Error(`Agent run dispatch mode is invalid: ${mode}.`);
  }
  const timestamp = now.toISOString();
  return {
    schemaVersion: 3,
    id: requireSafeIdentity(id, "Agent run id"),
    taskId: requireSafeIdentity(taskId, "Task id"),
    roleName: requireSafeIdentity(roleName, "Role name"),
    mode,
    input: requireText(input, "Agent run input"),
    purpose: context.purpose ?? "execution",
    ...(context.workItemId === undefined
      ? {}
      : { workItemId: requireSafeIdentity(context.workItemId, "Work item id") }),
    ...(context.reviewRoundId === undefined
      ? {}
      : { reviewRoundId: requireSafeIdentity(context.reviewRoundId, "ReviewRound id") }),
    ...(context.workspace === undefined
      ? {}
      : { workspace: validateManagedWorkspace(context.workspace) }),
    ...(context.agent === undefined
      ? {}
      : {
          agentId: requireSafeIdentity(context.agent.agentId, "Agent id"),
          adapterId: requireAdapterId(context.agent.adapterId),
          ...(context.agent.model === undefined
            ? {}
            : { model: requireText(context.agent.model, "Agent model") }),
          ...(context.agent.effort === undefined
            ? {}
            : { effort: requireText(context.agent.effort, "Agent effort") })
        }),
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function isActiveAgentRun(run: AgentRun): boolean {
  return run.status === "active";
}

export function markAgentRunDelivered(run: AgentRun, now: Date): AgentRun {
  if (run.status !== "active") {
    throw new Error(`Cannot deliver a terminal Agent run: ${run.id}.`);
  }
  if (run.deliveredAt !== undefined) return run;
  const timestamp = now.toISOString();
  return { ...run, deliveredAt: timestamp, updatedAt: timestamp };
}

export function validateAgentRun(run: AgentRun): AgentRun {
  if (run.schemaVersion !== 3) throw new Error("Agent run must use schemaVersion 3.");
  requireSafeIdentity(run.id, "Agent run id");
  requireSafeIdentity(run.taskId, "Task id");
  requireSafeIdentity(run.roleName, "Role name");
  if (run.mode !== "new" && run.mode !== "resume") {
    throw new Error(`Agent run dispatch mode is invalid: ${String(run.mode)}.`);
  }
  requireText(run.input, "Agent run input");
  if (!["execution", "review"].includes(run.purpose)) {
    throw new Error(`Agent run purpose is invalid: ${String(run.purpose)}.`);
  }
  if (run.workItemId !== undefined) requireSafeIdentity(run.workItemId, "Work item id");
  if (run.reviewRoundId !== undefined) requireSafeIdentity(run.reviewRoundId, "ReviewRound id");
  if (run.workspace !== undefined) {
    validateManagedWorkspace(run.workspace);
    if (run.workspace.owner.taskId !== run.taskId) {
      throw new Error("Agent run workspace belongs to another Task.");
    }
    if (run.workspace.owner.type === "work-item"
      && run.workspace.owner.workItemId !== run.workItemId) {
      throw new Error("Agent run workspace belongs to another Work Item.");
    }
    if (run.workspace.owner.type === "work-item" && run.workItemId === undefined) {
      throw new Error("A WorkItem workspace requires a WorkItem Agent run reference.");
    }
    if (run.workspace.owner.type === "review-round" && run.purpose !== "review") {
      throw new Error("A ReviewRound workspace requires a review Agent run.");
    }
    if (run.workspace.owner.type === "integration-attempt") {
      throw new Error("An IntegrationAttempt workspace cannot be used by an Agent run.");
    }
  }
  if (run.purpose === "review") {
    if (run.workItemId === undefined || run.reviewRoundId === undefined) {
      throw new Error("A review Agent run requires WorkItem and ReviewRound references.");
    }
    if (run.workspace !== undefined && (
      run.workspace.owner.type !== "review-round"
      || run.workspace.owner.reviewRoundId !== run.reviewRoundId
    )) {
      throw new Error("A review Agent run must use its ReviewRound-owned workspace.");
    }
  } else if (run.reviewRoundId !== undefined) {
    throw new Error("An execution Agent run cannot reference a ReviewRound.");
  }
  if ((run.agentId === undefined) !== (run.adapterId === undefined)) {
    throw new Error("Agent run snapshot requires both agentId and adapterId.");
  }
  if (run.agentId !== undefined) requireSafeIdentity(run.agentId, "Agent id");
  if (run.adapterId !== undefined) requireAdapterId(run.adapterId);
  if (run.model !== undefined) requireText(run.model, "Agent model");
  if (run.effort !== undefined) requireText(run.effort, "Agent effort");
  if ((run.model !== undefined || run.effort !== undefined) && run.agentId === undefined) {
    throw new Error("Agent run model and effort require an Agent snapshot.");
  }
  if (!( ["active", "yielded", "failed"] as const).includes(run.status)) {
    throw new Error(`Agent run status is invalid: ${String(run.status)}.`);
  }
  requireTimestamp(run.createdAt, "Agent run createdAt");
  requireTimestamp(run.updatedAt, "Agent run updatedAt");
  if (run.deliveredAt !== undefined) requireTimestamp(run.deliveredAt, "Agent run deliveredAt");
  if (run.status === "active") {
    if (run.summary !== undefined || run.endedAt !== undefined) {
      throw new Error("An active Agent run cannot have terminal metadata.");
    }
  } else {
    requireText(run.summary ?? "", "Agent run summary");
    requireTimestamp(run.endedAt ?? "", "Agent run endedAt");
  }
  return run;
}

export function yieldAgentRun(run: AgentRun, summary: string, now: Date): AgentRun {
  return finishAgentRun(run, "yielded", requireText(summary, "Agent run summary"), now);
}

export function failAgentRun(run: AgentRun, summary: string, now: Date): AgentRun {
  return finishAgentRun(run, "failed", requireText(summary, "Agent run summary"), now);
}

function finishAgentRun(
  run: AgentRun,
  status: Exclude<AgentRunStatus, "active">,
  summary: string,
  now: Date
): AgentRun {
  if (run.status !== "active") {
    throw new Error(`Agent run is already terminal: ${run.id}.`);
  }
  const timestamp = now.toISOString();
  return {
    ...run,
    status,
    summary,
    updatedAt: timestamp,
    endedAt: timestamp
  };
}

function requireSafeIdentity(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(normalized)
    || /[\/\\\0]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requireAdapterId(value: string): AgentAdapterId {
  if (!isAgentAdapterId(value)) throw new Error(`Agent adapter is unsupported: ${value}.`);
  return value;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}

function requireTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
}
