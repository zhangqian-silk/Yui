export type WorkItemStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "superseded";

export type WorkItem = {
  schemaVersion: 1;
  id: string;
  taskId: string;
  title: string;
  assignee: string;
  status: WorkItemStatus;
  outcome?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

export function createWorkItem(
  id: string,
  taskId: string,
  input: Pick<WorkItem, "title" | "assignee">,
  now: Date
): WorkItem {
  const timestamp = now.toISOString();
  return {
    schemaVersion: 1,
    id: requireSafeIdentity(id, "Work item id"),
    taskId: requireSafeIdentity(taskId, "Task id"),
    title: requireText(input.title, "Work item title"),
    assignee: requireSafeIdentity(input.assignee, "Work item assignee"),
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function updateWorkItemStatus(
  workItem: WorkItem,
  status: WorkItemStatus,
  outcome: string | undefined,
  now: Date
): WorkItem {
  const terminal = ["completed", "failed", "cancelled", "superseded"].includes(status);
  const normalizedOutcome = outcome === undefined ? undefined : requireText(outcome, "Work item outcome");
  if (terminal && normalizedOutcome === undefined) {
    throw new Error(`Work item outcome is required for ${status}.`);
  }
  const timestamp = now.toISOString();
  const { outcome: _outcome, endedAt: _endedAt, ...base } = workItem;
  return {
    ...base,
    status,
    ...(normalizedOutcome === undefined ? {} : { outcome: normalizedOutcome }),
    updatedAt: timestamp,
    ...(terminal ? { endedAt: timestamp } : {})
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
