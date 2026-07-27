import {
  normalizedUniqueIdentities,
  normalizedUniqueText,
  requireIdentity,
  requireText,
  requireTimestamp
} from "../domain/validation.js";

export type WorkItemStatus =
  | "pending"
  | "running"
  | "awaiting_acceptance"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

export type WorkItemWorkspaceDisposition = "integrated" | "abandoned";

export type WorkItem = {
  schemaVersion: 2;
  id: string;
  taskId: string;
  title: string;
  objective: string;
  acceptance: readonly string[];
  dependsOn: readonly string[];
  revision: number;
  assignee?: string;
  status: WorkItemStatus;
  outcome?: string;
  workspaceDisposition?: WorkItemWorkspaceDisposition;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

const TERMINAL_STATUSES: readonly WorkItemStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "superseded"
];

export function createWorkItem(
  id: string,
  taskId: string,
  input: Readonly<{
    title: string;
    objective?: string;
    acceptance?: readonly string[];
    dependsOn?: readonly string[];
    assignee?: string;
  }>,
  now: Date
): WorkItem {
  const timestamp = now.toISOString();
  return validateWorkItem({
    schemaVersion: 2,
    id: requireIdentity(id, "Work Item id"),
    taskId: requireIdentity(taskId, "Task id"),
    title: requireText(input.title, "Work item title"),
    objective: requireText(input.objective ?? input.title, "Work item objective"),
    acceptance: normalizedUniqueText(input.acceptance ?? [], "Work item acceptance criterion"),
    dependsOn: normalizedUniqueIdentities(input.dependsOn ?? [], "Work item dependency"),
    revision: 1,
    ...(input.assignee === undefined
      ? {}
      : { assignee: requireIdentity(input.assignee, "Work item assignee") }),
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function updateWorkItemStatus(
  workItem: WorkItem,
  status: WorkItemStatus,
  now: Date,
  outcome?: string
): WorkItem {
  validateWorkItem(workItem);
  validateStatus(status);
  const alreadyTerminal = isTerminalStatus(workItem.status);
  const closingFailedWork = workItem.status === "failed"
    && (status === "cancelled" || status === "superseded")
    && workItem.workspaceDisposition === undefined;
  if (alreadyTerminal && status !== workItem.status && !closingFailedWork) {
    throw new Error(`Terminal Work Item status cannot change: ${workItem.id}.`);
  }
  const terminal = isTerminalStatus(status);
  const normalizedOutcome = outcome === undefined
    ? undefined
    : requireText(outcome, "Work item outcome");
  if (terminal && normalizedOutcome === undefined) {
    throw new Error(`Work item outcome is required for ${status}.`);
  }
  const timestamp = now.toISOString();
  if (alreadyTerminal && status === workItem.status) {
    return validateWorkItem({
      ...workItem,
      outcome: normalizedOutcome,
      revision: workItem.revision + 1,
      updatedAt: timestamp
    });
  }
  const {
    endedAt: _endedAt,
    outcome: _outcome,
    workspaceDisposition: _workspaceDisposition,
    ...base
  } = workItem;
  return validateWorkItem({
    ...base,
    status,
    revision: workItem.revision + 1,
    ...(normalizedOutcome === undefined ? {} : { outcome: normalizedOutcome }),
    updatedAt: timestamp,
    ...(terminal ? { endedAt: timestamp } : {})
  });
}

export function retryFailedWorkItem(workItem: WorkItem, now: Date): WorkItem {
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
    revision: workItem.revision + 1,
    updatedAt: now.toISOString()
  });
}

export function recordWorkItemWorkspaceDisposition(
  workItem: WorkItem,
  disposition: WorkItemWorkspaceDisposition,
  now: Date
): WorkItem {
  validateWorkItem(workItem);
  if (!isTerminalStatus(workItem.status)) {
    throw new Error("Only a terminal Work Item can record workspace cleanup.");
  }
  if (workItem.workspaceDisposition !== undefined) {
    if (workItem.workspaceDisposition !== disposition) {
      throw new Error(
        `Work Item workspace is already recorded as ${workItem.workspaceDisposition}.`
      );
    }
    return workItem;
  }
  return validateWorkItem({
    ...workItem,
    workspaceDisposition: disposition,
    revision: workItem.revision + 1,
    updatedAt: now.toISOString()
  });
}

export function validateWorkItem(workItem: WorkItem): WorkItem {
  if (workItem.schemaVersion !== 2) throw new Error("WorkItem must use schemaVersion 2.");
  requireIdentity(workItem.id, "Work Item id");
  requireIdentity(workItem.taskId, "Task id");
  requireText(workItem.title, "Work item title");
  requireText(workItem.objective, "Work item objective");
  normalizedUniqueText(workItem.acceptance, "Work item acceptance criterion");
  const dependsOn = normalizedUniqueIdentities(workItem.dependsOn, "Work item dependency");
  if (dependsOn.includes(workItem.id)) {
    throw new Error("A Work Item cannot depend on itself.");
  }
  if (!Number.isSafeInteger(workItem.revision) || workItem.revision < 1) {
    throw new Error("Work Item revision must be a positive integer.");
  }
  if (workItem.assignee !== undefined) {
    requireIdentity(workItem.assignee, "Work item assignee");
  }
  validateStatus(workItem.status);
  if (workItem.outcome !== undefined) requireText(workItem.outcome, "Work item outcome");
  requireTimestamp(workItem.createdAt, "Work Item createdAt");
  requireTimestamp(workItem.updatedAt, "Work Item updatedAt");
  const terminal = isTerminalStatus(workItem.status);
  if (terminal) {
    requireText(workItem.outcome ?? "", "Work item outcome");
    requireTimestamp(workItem.endedAt ?? "", "Work Item endedAt");
  } else {
    if (workItem.outcome !== undefined) {
      throw new Error("A non-terminal Work Item cannot have an outcome.");
    }
    if (workItem.endedAt !== undefined) {
      throw new Error("A non-terminal Work Item cannot have endedAt.");
    }
  }
  if (workItem.workspaceDisposition !== undefined) {
    if (!["integrated", "abandoned"].includes(workItem.workspaceDisposition)) {
      throw new Error("Work item workspaceDisposition is invalid.");
    }
    if (!terminal) {
      throw new Error("Only a terminal Work Item can record workspace cleanup.");
    }
  }
  return workItem;
}

function isTerminalStatus(status: WorkItemStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function validateStatus(status: WorkItemStatus): void {
  if (![
    "pending",
    "running",
    "awaiting_acceptance",
    "completed",
    "failed",
    "cancelled",
    "superseded"
  ].includes(status)) {
    throw new Error(`Work Item status is invalid: ${String(status)}.`);
  }
}
