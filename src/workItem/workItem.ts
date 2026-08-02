import {
  normalizedUniqueIdentities,
  normalizedUniqueText,
  requireIdentity,
  requireText,
  requireTimestamp
} from "../domain/validation.js";
import { validateReviewConfig, type ReviewConfig } from "../review/reviewConfig.js";
import { validateRoleWorkspace, type RoleWorkspace } from "../worktree/roleWorkspace.js";
import { validateTaskRecordReference } from "../task/taskRecordReference.js";

export type WorkItemStatus =
  | "pending"
  | "running"
  | "awaiting_acceptance"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

export type WorkItemWorkspaceDisposition = "integrated" | "abandoned";

export type WorkItemCandidate = Readonly<{
  schemaVersion: 2;
  id: string;
  taskId: string;
  workItemId: string;
  sequence: number;
  workItemRevision: number;
  summary: string;
  source:
    | Readonly<{ type: "direct" }>
    | Readonly<{ type: "run"; runId: string }>;
  reviewPolicy?: ReviewConfig;
  workspace?: RoleWorkspace;
  createdAt: string;
}>;

export type WorkItem = {
  schemaVersion: 6;
  id: string;
  taskId: string;
  title: string;
  objective: string;
  acceptance: readonly string[];
  dependsOn: readonly string[];
  writeProjectIds: readonly string[];
  revision: number;
  assignee?: string;
  status: WorkItemStatus;
  candidates: readonly WorkItemCandidate[];
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
    writeProjectIds?: readonly string[];
  }>,
  now: Date
): WorkItem {
  const timestamp = now.toISOString();
  return validateWorkItem({
    schemaVersion: 6,
    id: requireIdentity(id, "Work Item id"),
    taskId: requireIdentity(taskId, "Task id"),
    title: requireText(input.title, "Work item title"),
    objective: requireText(input.objective ?? input.title, "Work item objective"),
    acceptance: normalizedUniqueText(input.acceptance ?? [], "Work item acceptance criterion"),
    dependsOn: normalizedUniqueIdentities(input.dependsOn ?? [], "Work item dependency"),
    writeProjectIds: normalizedUniqueIdentities(
      input.writeProjectIds ?? [],
      "Work item writable Project"
    ),
    revision: 1,
    ...(input.assignee === undefined
      ? {}
      : { assignee: requireIdentity(input.assignee, "Work item assignee") }),
    status: "pending",
    candidates: [],
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function submitWorkItemCandidate(
  workItem: WorkItem,
  input: Readonly<{
    summary: string;
    source:
      | Readonly<{ type: "direct" }>
      | Readonly<{ type: "run"; runId: string }>;
    reviewPolicy?: ReviewConfig;
    workspace?: RoleWorkspace;
  }>,
  now: Date
): WorkItem {
  validateWorkItem(workItem);
  if (workItem.status !== "running") {
    throw new Error(
      `Work Item candidate can only be submitted from running: ${workItem.id}/${workItem.status}.`
    );
  }
  const revision = workItem.revision + 1;
  const sequence = workItem.candidates.length + 1;
  const candidate = validateWorkItemCandidate({
    schemaVersion: 2,
    id: `candidate-${sequence}`,
    taskId: workItem.taskId,
    workItemId: workItem.id,
    sequence,
    workItemRevision: revision,
    summary: input.summary,
    source: input.source,
    ...(input.reviewPolicy === undefined ? {} : { reviewPolicy: input.reviewPolicy }),
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    createdAt: now.toISOString()
  });
  const { outcome: _outcome, endedAt: _endedAt, ...base } = workItem;
  return validateWorkItem({
    ...base,
    status: "awaiting_acceptance",
    candidates: [...workItem.candidates, candidate],
    revision,
    updatedAt: now.toISOString()
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
    && (status === "cancelled" || status === "superseded");
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
    workspaceDisposition,
    ...base
  } = workItem;
  return validateWorkItem({
    ...base,
    status,
    revision: workItem.revision + 1,
    ...(normalizedOutcome === undefined ? {} : { outcome: normalizedOutcome }),
    // An isolated result's disposition is still durable evidence after the
    // failed WorkItem is explicitly cancelled or superseded.
    ...(closingFailedWork && workspaceDisposition !== undefined
      ? { workspaceDisposition }
      : {}),
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
  if (workItem.schemaVersion !== 6) throw new Error("WorkItem must use schemaVersion 6.");
  validateTaskRecordReference({ taskId: workItem.taskId, localId: workItem.id }, "workItem");
  requireIdentity(workItem.taskId, "Task id");
  requireText(workItem.title, "Work item title");
  requireText(workItem.objective, "Work item objective");
  normalizedUniqueText(workItem.acceptance, "Work item acceptance criterion");
  const dependsOn = normalizedUniqueIdentities(workItem.dependsOn, "Work item dependency");
  normalizedUniqueIdentities(workItem.writeProjectIds, "Work item writable Project");
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
  if (!Array.isArray(workItem.candidates)) {
    throw new Error("Work Item candidates are invalid.");
  }
  const candidateIds = new Set<string>();
  workItem.candidates.forEach((candidate, index) => {
    validateWorkItemCandidate(candidate);
    if (candidate.taskId !== workItem.taskId || candidate.workItemId !== workItem.id) {
      throw new Error("Work Item candidate provenance is invalid.");
    }
    if (candidate.sequence !== index + 1) {
      throw new Error("Work Item candidate sequence is invalid.");
    }
    if (candidateIds.has(candidate.id)) {
      throw new Error(`Work Item candidate is duplicated: ${candidate.id}.`);
    }
    candidateIds.add(candidate.id);
    if (candidate.workItemRevision > workItem.revision) {
      throw new Error("Work Item candidate revision cannot exceed the Work Item revision.");
    }
  });
  const currentCandidate = currentWorkItemCandidate(workItem);
  if (workItem.status === "awaiting_acceptance" && currentCandidate === undefined) {
    throw new Error("A Work Item awaiting acceptance requires a candidate.");
  }
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

export function validateWorkItemCandidate(
  candidate: WorkItemCandidate
): WorkItemCandidate {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("Work Item candidate is required.");
  }
  if (candidate.schemaVersion !== 2) {
    throw new Error("Work Item candidate must use schemaVersion 2.");
  }
  requireIdentity(candidate.taskId, "Work Item candidate Task id");
  validateTaskRecordReference({
    taskId: candidate.taskId,
    localId: candidate.workItemId
  }, "workItem");
  if (candidate.id !== `candidate-${candidate.sequence}`) {
    throw new Error("Work Item candidate local id is invalid.");
  }
  if (!Number.isSafeInteger(candidate.sequence) || candidate.sequence < 1) {
    throw new Error("Work Item candidate sequence must be a positive integer.");
  }
  if (!Number.isSafeInteger(candidate.workItemRevision)
    || candidate.workItemRevision < 1) {
    throw new Error("Work Item candidate revision must be a positive integer.");
  }
  requireText(candidate.summary, "Work Item candidate summary");
  if (typeof candidate.source !== "object" || candidate.source === null) {
    throw new Error("Work Item candidate source is required.");
  }
  if (candidate.source.type !== "direct" && candidate.source.type !== "run") {
    throw new Error("Work Item candidate source is invalid.");
  }
  if (candidate.source.type === "run") {
    validateTaskRecordReference({
      taskId: candidate.taskId,
      localId: candidate.source.runId
    }, "agentRun");
  }
  if (candidate.reviewPolicy !== undefined) validateReviewConfig(candidate.reviewPolicy);
  if (candidate.workspace !== undefined) validateRoleWorkspace(candidate.workspace);
  requireTimestamp(candidate.createdAt, "Work Item candidate createdAt");
  return candidate;
}

export function currentWorkItemCandidate(
  workItem: WorkItem
): WorkItemCandidate | undefined {
  return workItem.status === "awaiting_acceptance"
    ? workItem.candidates.at(-1)
    : undefined;
}

export function updateWorkItemWriteProjects(
  workItem: WorkItem,
  writeProjectIds: readonly string[],
  now: Date
): WorkItem {
  validateWorkItem(workItem);
  if (isTerminalStatus(workItem.status)) {
    throw new Error(`Terminal Work Item write scope cannot change: ${workItem.id}.`);
  }
  const normalized = normalizedUniqueIdentities(
    writeProjectIds,
    "Work item writable Project"
  );
  const requested = new Set(normalized);
  const removed = workItem.writeProjectIds.filter((projectId) => !requested.has(projectId));
  if (removed.length > 0) {
    throw new Error(
      `Work Item write scope cannot remove approved Projects: ${removed.join(", ")}.`
    );
  }
  if (
    normalized.length === workItem.writeProjectIds.length
    && workItem.writeProjectIds.every((projectId) => requested.has(projectId))
  ) {
    return workItem;
  }
  return validateWorkItem({
    ...workItem,
    writeProjectIds: normalized,
    revision: workItem.revision + 1,
    updatedAt: now.toISOString()
  });
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
