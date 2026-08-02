import {
  validateEffectiveLaunchSnapshot,
  type EffectiveLaunchSnapshot
} from "../executor/effectiveLaunch.js";
import { validateRoleWorkspace, type RoleWorkspace } from "../worktree/roleWorkspace.js";
import { validateTaskRecordReference } from "../task/taskRecordReference.js";

export type DispatchMode = "new" | "resume";
export type AgentRunStatus = "active" | "yielded" | "failed";
export type AgentRunPurpose = "execution" | "review";

export type AgentRun = {
  schemaVersion: 4;
  id: string;
  taskId: string;
  roleName: string;
  mode: DispatchMode;
  input: string;
  purpose: AgentRunPurpose;
  workItemId?: string;
  reviewRoundId?: string;
  workspace?: RoleWorkspace;
  /** Immutable actual launch configuration and provenance. */
  effective: EffectiveLaunchSnapshot;
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
    workspace?: RoleWorkspace;
    effective: EffectiveLaunchSnapshot;
  }
): AgentRun {
  if (mode !== "new" && mode !== "resume") {
    throw new Error(`Agent run dispatch mode is invalid: ${mode}.`);
  }
  const timestamp = now.toISOString();
  return {
    schemaVersion: 4,
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
      : { workspace: validateRoleWorkspace(context.workspace) }),
    effective: validateEffectiveLaunchSnapshot(context.effective),
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
  if (run.schemaVersion !== 4) throw new Error("Agent run must use schemaVersion 4.");
  validateTaskRecordReference({ taskId: run.taskId, localId: run.id }, "agentRun");
  requireSafeIdentity(run.roleName, "Role name");
  if (run.mode !== "new" && run.mode !== "resume") {
    throw new Error(`Agent run dispatch mode is invalid: ${String(run.mode)}.`);
  }
  requireText(run.input, "Agent run input");
  if (!["execution", "review"].includes(run.purpose)) {
    throw new Error(`Agent run purpose is invalid: ${String(run.purpose)}.`);
  }
  if (run.workItemId !== undefined) {
    validateTaskRecordReference({ taskId: run.taskId, localId: run.workItemId }, "workItem");
  }
  if (run.reviewRoundId !== undefined) {
    validateTaskRecordReference({ taskId: run.taskId, localId: run.reviewRoundId }, "reviewRound");
  }
  if (run.workspace !== undefined) {
    validateRoleWorkspace(run.workspace);
    if (run.workspace.taskId !== run.taskId) {
      throw new Error("Agent run workspace belongs to another Task.");
    }
    if (run.workspace.owner.type === "work-item"
      && run.workspace.owner.workItemId !== run.workItemId) {
      throw new Error("Agent run workspace belongs to another Work Item.");
    }
    if (run.workspace.owner.type === "review-round"
      && run.workspace.owner.reviewRoundId !== run.reviewRoundId) {
      throw new Error(
        `Agent run ReviewRound workspace owner does not match ${run.reviewRoundId ?? "none"}.`
      );
    }
  }
  if (run.purpose === "review") {
    if (run.workItemId === undefined || run.reviewRoundId === undefined) {
      throw new Error("A review Agent run requires WorkItem and ReviewRound references.");
    }
    const resolvedReview = run.effective.provenance === "resolved";
    if (resolvedReview && (run.workspace === undefined
      || run.workspace.owner.type !== "review-round"
      || run.workspace.owner.reviewRoundId !== run.reviewRoundId)) {
      throw new Error(
        `A review Agent run requires its exact ReviewRound workspace owner: ${run.reviewRoundId}.`
      );
    }
    if (resolvedReview && (run.workspace!.entries.length === 0
      || run.workspace!.entries.some(({ access }) => access !== "write"))) {
      throw new Error("A review Agent run requires only isolated writable workspace entries.");
    }
    if (!resolvedReview && run.status === "active") {
      throw new Error("An active review Agent run cannot use legacy launch provenance.");
    }
  } else {
    if (run.reviewRoundId !== undefined) {
      throw new Error("An execution Agent run cannot reference a ReviewRound.");
    }
    if (run.workspace?.owner.type === "review-round") {
      throw new Error("An execution Agent run cannot use a ReviewRound-owned workspace.");
    }
  }
  validateEffectiveLaunchSnapshot(run.effective);
  if (run.workspace !== undefined
    && (run.effective.workspace.root !== run.workspace.root
      || JSON.stringify(run.effective.workspace.entries) !== JSON.stringify(run.workspace.entries))) {
    throw new Error("Agent run effective workspace does not match its managed workspace.");
  }
  if (run.purpose === "review") {
    if (run.effective.reviewRoundId !== run.reviewRoundId) {
      throw new Error("Review Agent run effective provenance does not match its ReviewRound.");
    }
    if (run.effective.reviewBaseProvenance === "frozen-candidate" && !run.workspace!.entries.some(
      ({ baseCommit }) => baseCommit === run.effective.reviewBaseCommit
    )) {
      throw new Error("Review Agent run effective base does not match its workspace.");
    }
  } else if (run.effective.reviewRoundId !== undefined) {
    throw new Error("Execution Agent run cannot carry Review effective provenance.");
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
