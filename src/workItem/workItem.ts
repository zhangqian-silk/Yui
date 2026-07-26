export type WorkItemStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "superseded";
export type WorkItemWorkspaceDisposition = "integrated" | "abandoned";

export type WorkItem = {
  schemaVersion: 1;
  id: string;
  taskId: string;
  title: string;
  assignee: string;
  status: WorkItemStatus;
  outcome?: string;
  workspaceDisposition?: WorkItemWorkspaceDisposition;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  "pending", "running", "completed", "failed", "cancelled", "superseded"
];
const TERMINAL_WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  "completed", "failed", "cancelled", "superseded"
];

export function validateWorkItem(workItem: WorkItem): WorkItem {
  if (workItem.schemaVersion !== 1) {
    throw new Error("Work item must use schemaVersion 1.");
  }
  requireSafeIdentity(workItem.id, "Work item id");
  requireSafeIdentity(workItem.taskId, "Task id");
  requireText(workItem.title, "Work item title");
  requireSafeIdentity(workItem.assignee, "Work item assignee");
  if (!WORK_ITEM_STATUSES.includes(workItem.status)) {
    throw new Error("Work item status is invalid.");
  }
  if (workItem.outcome !== undefined) requireText(workItem.outcome, "Work item outcome");
  requireTimestamp(workItem.createdAt, "Work item createdAt");
  requireTimestamp(workItem.updatedAt, "Work item updatedAt");

  const terminal = isTerminalStatus(workItem.status);
  if (terminal) {
    if (workItem.outcome === undefined) {
      throw new Error(`Work item outcome is required for ${workItem.status}.`);
    }
    if (workItem.endedAt === undefined) {
      throw new Error(`Work item endedAt is required for ${workItem.status}.`);
    }
  } else if (workItem.endedAt !== undefined) {
    throw new Error("Non-terminal work item must not have endedAt.");
  }
  if (workItem.endedAt !== undefined) requireTimestamp(workItem.endedAt, "Work item endedAt");

  if (workItem.workspaceDisposition !== undefined) {
    if (!["integrated", "abandoned"].includes(workItem.workspaceDisposition)) {
      throw new Error("Work item workspaceDisposition is invalid.");
    }
    if (!terminal) {
      throw new Error("Only a terminal work item can record workspace cleanup.");
    }
  }
  return workItem;
}

export function recordWorkItemWorkspaceDisposition(
  workItem: WorkItem,
  disposition: WorkItemWorkspaceDisposition,
  now: Date
): WorkItem {
  validateWorkItem(workItem);
  if (!isTerminalStatus(workItem.status)) {
    throw new Error("Only a terminal work item can record workspace cleanup.");
  }
  if (workItem.workspaceDisposition !== undefined) {
    if (workItem.workspaceDisposition !== disposition) {
      throw new Error(
        `Work item workspace is already recorded as ${workItem.workspaceDisposition}.`
      );
    }
    return workItem;
  }
  const timestamp = now.toISOString();
  return validateWorkItem({
    ...workItem,
    workspaceDisposition: disposition,
    updatedAt: timestamp
  });
}

export function createWorkItem(
  id: string,
  taskId: string,
  input: Pick<WorkItem, "title" | "assignee">,
  now: Date
): WorkItem {
  const timestamp = now.toISOString();
  return validateWorkItem({
    schemaVersion: 1,
    id: requireSafeIdentity(id, "Work item id"),
    taskId: requireSafeIdentity(taskId, "Task id"),
    title: requireText(input.title, "Work item title"),
    assignee: requireSafeIdentity(input.assignee, "Work item assignee"),
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function updateWorkItemStatus(
  workItem: WorkItem,
  status: WorkItemStatus,
  outcome: string | undefined,
  now: Date
): WorkItem {
  validateWorkItem(workItem);
  const wasTerminal = isTerminalStatus(workItem.status);
  if (wasTerminal && status !== workItem.status) {
    throw new Error(`Terminal work item status cannot change: ${workItem.id}.`);
  }
  const terminal = isTerminalStatus(status);
  const normalizedOutcome = outcome === undefined ? undefined : requireText(outcome, "Work item outcome");
  if (terminal && normalizedOutcome === undefined) {
    throw new Error(`Work item outcome is required for ${status}.`);
  }
  const timestamp = now.toISOString();
  const { outcome: _outcome, endedAt: _endedAt, ...base } = workItem;
  return validateWorkItem({
    ...base,
    status,
    ...(normalizedOutcome === undefined ? {} : { outcome: normalizedOutcome }),
    updatedAt: timestamp,
    ...(terminal ? { endedAt: timestamp } : {})
  });
}

export function retryFailedWorkItem(
  workItem: WorkItem,
  now: Date
): WorkItem {
  validateWorkItem(workItem);
  if (workItem.status !== "failed") {
    throw new Error(`Work item is not retryable from ${workItem.status}: ${workItem.id}.`);
  }
  if (workItem.workspaceDisposition !== undefined) {
    throw new Error(`Work item workspace is already disposed: ${workItem.id}.`);
  }
  const { outcome: _outcome, endedAt: _endedAt, ...base } = workItem;
  return validateWorkItem({
    ...base,
    status: "running",
    updatedAt: now.toISOString()
  });
}

function isTerminalStatus(status: WorkItemStatus): boolean {
  return TERMINAL_WORK_ITEM_STATUSES.includes(status);
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
    throw new Error(`${label} is invalid.`);
  }
}
