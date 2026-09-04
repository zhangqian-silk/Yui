import {
  normalizedUniqueIdentities,
  normalizedUniqueText,
  requireIdentity,
  requireText,
  requireTimestamp
} from "../domain/validation.js";
import { validateReviewConfig, type ReviewConfig } from "../review/reviewConfig.js";
import {
  taskFinalReviewConfig,
  validateTaskFinalReviewContract,
  type TaskFinalReviewContract
} from "../review/taskFinalReviewContract.js";
import {
  validateManagedWorkspace,
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
import { validateTaskRecordReference } from "../task/taskRecordReference.js";
import {
  assertWorkItemExecutionGroupTransition,
  validateWorkItemExecutionGroup as validateExecutionGroupRecord,
  workItemExecutionGroupSettled,
  type WorkItemExecutionGroup
} from "../execution/workItemExecution.js";

export type WorkItemStatus =
  | "pending"
  | "running"
  | "awaiting_acceptance"
  | "completed"
  | "failed"
  | "retired";

export type WorkItemDisposition = Readonly<{
  schemaVersion: 1;
  by: "leader" | "operator" | "user";
  summary: string;
  retiredAt: string;
  replacementWorkItemId?: string;
}>;

export type WorkItemDispositionInput = Readonly<{
  by: "leader" | "operator" | "user";
  summary: string;
  replacementWorkItemId?: string;
}>;

export type WorkItemWorkspaceDisposition = "integrated" | "abandoned";

/**
 * Optional base-ref overrides used only when a fresh WorkItem Develop
 * workspace is first provisioned. The resolved commit is frozen in the
 * managed workspace entry; this record remains a ref request, not a second
 * capture boundary.
 */
export type WorkItemProjectBaseRef = Readonly<{
  projectId: string;
  baseRef: string;
}>;

export type CandidateGitSnapshot = Readonly<{
  schemaVersion: 1;
  reviewBaseCommit: string;
  projects: readonly Readonly<{
    projectId: string;
    commit: string;
  }>[];
}>;

/**
 * Frozen provenance for an exact-contract Leader-direct Candidate. Task main
 * workspace records intentionally follow the physical branch HEAD as the
 * Controller prepares Roles, so they cannot also serve as an immutable
 * ChangeSet boundary.
 */
export type DirectTaskMainSnapshot = Readonly<{
  schemaVersion: 1;
  projects: readonly Readonly<{
    projectId: string;
    directory: string;
    branch: string;
    baseCommit: string;
    headCommit: string;
  }>[];
}>;

export type WorkItemCandidate = Readonly<{
  schemaVersion: 3;
  id: string;
  taskId: string;
  workItemId: string;
  sequence: number;
  workItemRevision: number;
  summary: string;
  source:
    | Readonly<{ type: "direct" }>
    | Readonly<{ type: "turn"; turnId: string }>;
  executionGroupId?: string;
  executionLaneId?: string;
  reviewPolicy?: ReviewConfig;
  taskFinalReviewContract?: TaskFinalReviewContract;
  /** Snapshot of the WorkItem-owned Develop workspace at candidate time. */
  workspace?: ManagedWorkspace;
  gitSnapshot?: CandidateGitSnapshot;
  /** Exact base/head boundary for a metadata-only Task-main Candidate. */
  taskMainSnapshot?: DirectTaskMainSnapshot;
  createdAt: string;
}>;

export type WorkItem = {
  /** v15 removes retired pre-unified execution history from the current contract. */
  schemaVersion: 15;
  id: string;
  taskId: string;
  title: string;
  objective: string;
  acceptance: readonly string[];
  dependsOn: readonly string[];
  writeProjectIds: readonly string[];
  /** Immutable execution history for this WorkItem. */
  executionGroups: readonly WorkItemExecutionGroup[];
  /** Current iteration Group; historical Groups remain addressable by id. */
  currentExecutionGroupId?: string;
  /** Explicit Git refs for the initial writable WorkItem worktree. */
  baseRefs?: readonly WorkItemProjectBaseRef[];
  revision: number;
  assignee?: string;
  status: WorkItemStatus;
  candidates: readonly WorkItemCandidate[];
  outcome?: string;
  disposition?: WorkItemDisposition;
  workspaceDisposition?: WorkItemWorkspaceDisposition;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

export type WorkItemDefinitionUpdate = Readonly<{
  title?: string;
  objective?: string;
  acceptance?: readonly string[];
  dependsOn?: readonly string[];
  writeProjectIds?: readonly string[];
  baseRefs?: readonly WorkItemProjectBaseRef[] | null;
  assignee?: string | null;
}>;

const TERMINAL_STATUSES: readonly WorkItemStatus[] = [
  "completed",
  "failed",
  "retired"
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
    baseRefs?: readonly WorkItemProjectBaseRef[];
    executionGroups?: readonly WorkItemExecutionGroup[];
    currentExecutionGroupId?: string;
  }>,
  now: Date
): WorkItem {
  const timestamp = now.toISOString();
  return validateWorkItem({
    schemaVersion: 15,
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
    executionGroups: (input.executionGroups ?? []).map((group) =>
      validateWorkItemExecutionGroup(group, taskId, id)
    ),
    ...(input.currentExecutionGroupId === undefined
      ? {}
      : { currentExecutionGroupId: requireIdentity(input.currentExecutionGroupId, "ExecutionGroup id") }),
    ...(input.baseRefs === undefined || input.baseRefs.length === 0
      ? {}
      : { baseRefs: normalizeProjectBaseRefs(input.baseRefs) }),
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

/** Replace the mutable definition of an execution-free Draft WorkItem. */
export function editDraftWorkItemDefinition(
  workItem: WorkItem,
  update: WorkItemDefinitionUpdate,
  now: Date
): WorkItem {
  validateWorkItem(workItem);
  if (workItem.status !== "pending"
    || workItem.executionGroups.length > 0
    || workItem.candidates.length > 0
    || workItem.disposition !== undefined
    || workItem.workspaceDisposition !== undefined) {
    throw new Error(`Work Item has execution or retirement facts: ${workItem.id}.`);
  }
  const next = {
    ...workItem,
    ...(update.title === undefined
      ? {}
      : { title: requireText(update.title, "Work item title") }),
    ...(update.objective === undefined
      ? {}
      : { objective: requireText(update.objective, "Work item objective") }),
    ...(update.acceptance === undefined
      ? {}
      : { acceptance: normalizedUniqueText(update.acceptance, "Work item acceptance criterion") }),
    ...(update.dependsOn === undefined
      ? {}
      : { dependsOn: normalizedUniqueIdentities(update.dependsOn, "Work item dependency") }),
    ...(update.writeProjectIds === undefined
      ? {}
      : {
          writeProjectIds: normalizedUniqueIdentities(
            update.writeProjectIds,
            "Work item writable Project"
          )
        }),
    revision: workItem.revision + 1,
    updatedAt: now.toISOString()
  } as WorkItem;
  if (update.baseRefs === null) delete next.baseRefs;
  else if (update.baseRefs !== undefined) {
    const normalized = normalizeProjectBaseRefs(update.baseRefs);
    if (normalized.length === 0) delete next.baseRefs;
    else next.baseRefs = normalized;
  }
  if (update.assignee === null) delete next.assignee;
  else if (update.assignee !== undefined) {
    next.assignee = requireIdentity(update.assignee, "Work item assignee");
  }
  return validateWorkItem(next);
}

export function submitWorkItemCandidate(
  workItem: WorkItem,
  input: Readonly<{
    summary: string;
    source:
      | Readonly<{ type: "direct" }>
      | Readonly<{ type: "turn"; turnId: string }>;
    reviewPolicy?: ReviewConfig;
    taskFinalReviewContract?: TaskFinalReviewContract;
    executionGroupId?: string;
    executionLaneId?: string;
    workspace?: ManagedWorkspace;
    gitSnapshot?: CandidateGitSnapshot;
    taskMainSnapshot?: DirectTaskMainSnapshot;
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
    schemaVersion: 3,
    id: `candidate-${sequence}`,
    taskId: workItem.taskId,
    workItemId: workItem.id,
    sequence,
    workItemRevision: revision,
    summary: input.summary,
    source: input.source,
    ...(input.reviewPolicy === undefined ? {} : { reviewPolicy: input.reviewPolicy }),
    ...(input.taskFinalReviewContract === undefined
      ? {}
      : { taskFinalReviewContract: input.taskFinalReviewContract }),
    ...(input.executionGroupId === undefined
      ? {}
      : { executionGroupId: requireIdentity(input.executionGroupId, "ExecutionGroup id") }),
    ...(input.executionLaneId === undefined
      ? {}
      : { executionLaneId: requireIdentity(input.executionLaneId, "ExecutionLane id") }),
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    ...(input.gitSnapshot === undefined ? {} : { gitSnapshot: input.gitSnapshot }),
    ...(input.taskMainSnapshot === undefined
      ? {}
      : { taskMainSnapshot: input.taskMainSnapshot }),
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
  if (workItem.disposition !== undefined && status !== workItem.status) {
    throw new Error(`Retired Work Item status cannot change: ${workItem.id}.`);
  }
  const closingFailedWork = workItem.status === "failed" && status === "retired";
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
    // Isolated workspace cleanup remains durable evidence after retirement.
    ...(closingFailedWork && workspaceDisposition !== undefined
      ? { workspaceDisposition }
      : {}),
    updatedAt: timestamp,
    ...(terminal ? { endedAt: timestamp } : {})
  });
}

/** Attach the common execution Group without changing the WorkItem identity. */
export function attachWorkItemExecutionGroup(
  workItem: WorkItem,
  executionGroup: WorkItemExecutionGroup,
  now: Date
): WorkItem {
  validateWorkItem(workItem);
  const checked = validateWorkItemExecutionGroup(executionGroup, workItem.taskId, workItem.id);
  if (workItem.status === "completed" || workItem.status === "failed" || workItem.status === "retired") {
    throw new Error(`A terminal Work Item cannot attach an ExecutionGroup: ${workItem.id}.`);
  }
  const existing = workItemExecutionGroupById(workItem, checked.id);
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(checked)) {
      throw new Error(`Work Item ExecutionGroup is immutable: ${workItem.id}/${checked.id}.`);
    }
    if (workItem.currentExecutionGroupId === checked.id) return workItem;
    throw new Error(`Work Item historical ExecutionGroup is immutable: ${workItem.id}/${checked.id}.`);
  }
  const current = currentWorkItemExecutionGroup(workItem);
  if (current !== undefined && !workItemExecutionGroupSettled(current)) {
    throw new Error(`Work Item already has an open ExecutionGroup: ${workItem.id}/${current.id}.`);
  }
  return validateWorkItem({
    ...workItem,
    executionGroups: [...workItem.executionGroups, checked],
    currentExecutionGroupId: checked.id,
    revision: workItem.revision + 1,
    updatedAt: now.toISOString()
  });
}

/** Advance a Group's lane state while keeping its frozen target immutable. */
export function updateWorkItemExecutionGroup(
  workItem: WorkItem,
  executionGroup: WorkItemExecutionGroup,
  now: Date
): WorkItem {
  validateWorkItem(workItem);
  const checked = validateWorkItemExecutionGroup(executionGroup, workItem.taskId, workItem.id);
  const existing = workItemExecutionGroupById(workItem, checked.id);
  if (existing === undefined) {
    return attachWorkItemExecutionGroup(workItem, checked, now);
  }
  if (workItem.currentExecutionGroupId !== checked.id) {
    throw new Error(`Work Item historical ExecutionGroup is immutable: ${workItem.id}/${checked.id}.`);
  }
  if (JSON.stringify(existing.assignment) !== JSON.stringify(checked.assignment)) {
    throw new Error(`Work Item ExecutionGroup Assignment is immutable: ${workItem.id}/${checked.id}.`);
  }
  if (JSON.stringify(existing) === JSON.stringify(checked)) return workItem;
  assertWorkItemExecutionGroupTransition(existing, checked);
  return validateWorkItem({
    ...workItem,
    executionGroups: workItem.executionGroups.map((group) =>
      group.id === checked.id ? checked : group
    ),
    revision: workItem.revision + 1,
    updatedAt: now.toISOString()
  });
}

/**
 * Records the Leader's explicit disposition as the authoritative terminal
 * fact. Replays of the same decision are idempotent; a different terminal
 * decision can never overwrite the first one.
 */
export function retireWorkItem(
  workItem: WorkItem,
  input: WorkItemDispositionInput,
  now: Date
): WorkItem {
  validateWorkItem(workItem);
  const disposition = normalizeDisposition(input, now);
  if (workItem.disposition !== undefined) {
    if (
      workItem.status === "retired"
      && sameDisposition(workItem.disposition, disposition)
    ) {
      return workItem;
    }
    throw new Error(`Work Item already has an explicit disposition: ${workItem.id}.`);
  }
  if (workItem.status === "completed") {
    throw new Error(`Completed Work Item cannot be retired: ${workItem.id}.`);
  }
  if (isTerminalStatus(workItem.status)
    && workItem.status !== "failed"
    && workItem.status !== "retired") {
    throw new Error(`Terminal Work Item status cannot change: ${workItem.id}.`);
  }
  const timestamp = disposition.retiredAt;
  return validateWorkItem({
    ...workItem,
    status: "retired",
    outcome: disposition.summary,
    disposition,
    revision: workItem.revision + 1,
    updatedAt: timestamp,
    endedAt: timestamp
  });
}

export function retryFailedWorkItem(workItem: WorkItem, now: Date): WorkItem {
  validateWorkItem(workItem);
  if (workItem.status !== "failed") {
    throw new Error(`Work item is not retryable from ${workItem.status}: ${workItem.id}.`);
  }
  if (workItem.workspaceDisposition !== undefined) {
    throw new Error(`Work item workspace is already settled: ${workItem.id}.`);
  }
  const { outcome: _outcome, endedAt: _endedAt, ...base } = workItem;
  // Keep every historical Group. A settled current Group is cleared only as
  // the current pointer; redispatch appends a fresh immutable Group.
  const current = currentWorkItemExecutionGroup(workItem);
  const retryBase = current === undefined || !workItemExecutionGroupSettled(current)
    ? base
    : (({ currentExecutionGroupId: _currentExecutionGroupId, ...history }) => history)(base);
  return validateWorkItem({
    ...retryBase,
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
  rejectUnknownFields(workItem as unknown as Record<string, unknown>, [
    "schemaVersion",
    "id",
    "taskId",
    "title",
    "objective",
    "acceptance",
    "dependsOn",
    "writeProjectIds",
    "executionGroups",
    "currentExecutionGroupId",
    "baseRefs",
    "revision",
    "assignee",
    "status",
    "candidates",
    "outcome",
    "disposition",
    "workspaceDisposition",
    "createdAt",
    "updatedAt",
    "endedAt"
  ], "WorkItem");
  if (workItem.schemaVersion !== 15) throw new Error("WorkItem must use schemaVersion 15.");
  validateTaskRecordReference({ taskId: workItem.taskId, localId: workItem.id }, "workItem");
  requireIdentity(workItem.taskId, "Task id");
  requireText(workItem.title, "Work item title");
  requireText(workItem.objective, "Work item objective");
  normalizedUniqueText(workItem.acceptance, "Work item acceptance criterion");
  const dependsOn = normalizedUniqueIdentities(workItem.dependsOn, "Work item dependency");
  normalizedUniqueIdentities(workItem.writeProjectIds, "Work item writable Project");
  if (workItem.baseRefs !== undefined) {
    const baseRefs = normalizeProjectBaseRefs(workItem.baseRefs);
    const writableProjects = new Set(workItem.writeProjectIds);
    if (baseRefs.some(({ projectId }) => !writableProjects.has(projectId))) {
      throw new Error("Work Item Project base refs must target writable Projects.");
    }
  }
  if (dependsOn.includes(workItem.id)) {
    throw new Error("A Work Item cannot depend on itself.");
  }
  if (!Number.isSafeInteger(workItem.revision) || workItem.revision < 1) {
    throw new Error("Work Item revision must be a positive integer.");
  }
  if (workItem.assignee !== undefined) {
    requireIdentity(workItem.assignee, "Work item assignee");
  }
  if (!Array.isArray(workItem.executionGroups)) {
    throw new Error("Work Item executionGroups are invalid.");
  }
  const groupIds = new Set<string>();
  for (const group of workItem.executionGroups) {
    validateWorkItemExecutionGroup(group, workItem.taskId, workItem.id);
    if (groupIds.has(group.id)) {
      throw new Error(`Work Item ExecutionGroup is duplicated: ${group.id}.`);
    }
    groupIds.add(group.id);
  }
  if (workItem.currentExecutionGroupId !== undefined) {
    requireIdentity(workItem.currentExecutionGroupId, "ExecutionGroup id");
    if (!groupIds.has(workItem.currentExecutionGroupId)) {
      throw new Error(`Work Item current ExecutionGroup is not in history: ${workItem.id}.`);
    }
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
  if (workItem.disposition !== undefined) {
    validateDisposition(workItem.disposition);
    if (workItem.status !== "retired") {
      throw new Error("Work Item disposition does not match its status.");
    }
    if (workItem.outcome !== workItem.disposition.summary
      || workItem.endedAt !== workItem.disposition.retiredAt) {
      throw new Error("Work Item disposition does not match its terminal metadata.");
    }
  }
  return workItem;
}

/** Resolve the WorkItem's current execution iteration. */
export function currentWorkItemExecutionGroup(
  workItem: WorkItem
): WorkItemExecutionGroup | undefined {
  return workItem.currentExecutionGroupId === undefined
    ? undefined
    : workItemExecutionGroupById(workItem, workItem.currentExecutionGroupId);
}

/** Resolve any historical or current WorkItem Group by its immutable id. */
export function workItemExecutionGroupById(
  workItem: WorkItem,
  executionGroupId: string
): WorkItemExecutionGroup | undefined {
  return workItem.executionGroups.find(({ id }) => id === executionGroupId);
}

/**
 * True when a Turn failure belongs to the WorkItem's current unresolved Lane.
 * Such a failure is Lane-bounded: the WorkItem remains running so the Leader
 * can reuse completed siblings and retry only this failed attempt.
 */
export function workItemOwnsUnresolvedExecutionLane(
  workItem: Pick<WorkItem, "currentExecutionGroupId" | "executionGroups">,
  executionGroupId: string | undefined,
  executionLaneId: string | undefined
): boolean {
  if (executionGroupId === undefined
    || executionLaneId === undefined
    || workItem.currentExecutionGroupId !== executionGroupId) return false;
  const group = workItem.executionGroups.find(({ id }) => id === executionGroupId);
  return group !== undefined
    && !workItemExecutionGroupSettled(group)
    && group.lanes.some(({ id, disposition, currentTurnId }) => (
      id === executionLaneId && disposition === "open" && currentTurnId !== undefined
    ));
}

function validateWorkItemExecutionGroup(
  group: WorkItemExecutionGroup,
  taskId: string,
  workItemId: string
): WorkItemExecutionGroup {
  validateExecutionGroupRecord(group);
  if (group.taskId !== taskId) {
    throw new Error(`Work Item ExecutionGroup provenance is invalid: ${workItemId}.`);
  }
  if (group.assignment.workItemId !== workItemId
    || group.assignment.taskId !== taskId) {
    throw new Error(`Work Item ExecutionGroup Assignment is invalid: ${workItemId}.`);
  }
  return group;
}

export function validateWorkItemCandidate(
  candidate: WorkItemCandidate
): WorkItemCandidate {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("Work Item candidate is required.");
  }
  if (candidate.schemaVersion !== 3) {
    throw new Error("Work Item candidate must use schemaVersion 3.");
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
  if (candidate.source.type !== "direct" && candidate.source.type !== "turn") {
    throw new Error("Work Item candidate source is invalid.");
  }
  if (candidate.source.type === "turn") {
    validateTaskRecordReference({
      taskId: candidate.taskId,
      localId: candidate.source.turnId
    }, "turn");
  }
  if ((candidate.executionGroupId === undefined) !== (candidate.executionLaneId === undefined)) {
    throw new Error("Work Item candidate execution lineage is incomplete.");
  }
  if (candidate.executionGroupId !== undefined) {
    requireIdentity(candidate.executionGroupId, "ExecutionGroup id");
    requireIdentity(candidate.executionLaneId!, "ExecutionLane id");
  }
  if (candidate.reviewPolicy !== undefined) validateReviewConfig(candidate.reviewPolicy);
  if (candidate.taskFinalReviewContract !== undefined) {
    const contract = validateTaskFinalReviewContract(candidate.taskFinalReviewContract);
    if (contract.taskId !== candidate.taskId) {
      throw new Error("Task final-review contract belongs to another Task.");
    }
    const policy = taskFinalReviewConfig(contract);
    if (candidate.reviewPolicy?.roleName !== policy.roleName
      || candidate.reviewPolicy.trigger !== policy.trigger) {
      throw new Error("Task final-review contract does not match the Candidate review policy.");
    }
  }
  if (candidate.workspace !== undefined) {
    validateManagedWorkspace(candidate.workspace);
    if (candidate.workspace.owner.type !== "work-item"
      || candidate.workspace.owner.taskId !== candidate.taskId
      || candidate.workspace.owner.workItemId !== candidate.workItemId) {
      throw new Error("Work Item candidate must use its WorkItem-owned workspace.");
    }
  }
  if (candidate.gitSnapshot !== undefined) {
    if (candidate.workspace === undefined) {
      throw new Error("Candidate Git snapshot requires a managed workspace.");
    }
    validateCandidateGitSnapshot(candidate.gitSnapshot, candidate.workspace);
  }
  if (candidate.taskMainSnapshot !== undefined) {
    if (candidate.workspace !== undefined
      || candidate.gitSnapshot !== undefined
      || candidate.taskFinalReviewContract === undefined) {
      throw new Error(
        "Task-main Candidate snapshot requires an exact metadata-only Candidate."
      );
    }
    validateDirectTaskMainSnapshot(candidate.taskMainSnapshot);
  }
  requireTimestamp(candidate.createdAt, "Work Item candidate createdAt");
  return candidate;
}

export function createDirectTaskMainSnapshot(
  workspace: ManagedWorkspace,
  projectIds: readonly string[],
  heads: readonly Readonly<{ projectId: string; headCommit: string }>[]
): DirectTaskMainSnapshot {
  validateManagedWorkspace(workspace);
  if (workspace.owner.type !== "task") {
    throw new Error("Direct Candidate snapshot must come from Task main.");
  }
  const selected = normalizedUniqueIdentities(
    projectIds,
    "Direct Candidate snapshot Project"
  );
  const headByProject = new Map(heads.map(({ projectId, headCommit }) => [
    requireIdentity(projectId, "Direct Candidate snapshot Project"),
    requireCommit(headCommit, "Direct Candidate snapshot head")
  ]));
  if (headByProject.size !== heads.length) {
    throw new Error("Direct Candidate snapshot Projects are duplicated.");
  }
  const projects = workspace.entries
    .filter(({ projectId }) => selected.includes(projectId))
    .map((entry) => {
      if (entry.access !== "write") {
        throw new Error(
          `Direct Candidate snapshot Project is not writable: ${entry.projectId}.`
        );
      }
      const headCommit = headByProject.get(entry.projectId);
      if (headCommit === undefined) {
        throw new Error(
          `Direct Candidate snapshot Project head is missing: ${entry.projectId}.`
        );
      }
      return {
        projectId: entry.projectId,
        directory: entry.directory,
        branch: entry.branch,
        baseCommit: entry.baseCommit,
        headCommit
      };
    });
  if (projects.length !== selected.length || projects.length !== headByProject.size) {
    throw new Error("Direct Candidate snapshot Project scope does not match Task main.");
  }
  return validateDirectTaskMainSnapshot({ schemaVersion: 1, projects });
}

function validateDirectTaskMainSnapshot(
  snapshot: DirectTaskMainSnapshot
): DirectTaskMainSnapshot {
  if (typeof snapshot !== "object" || snapshot === null || snapshot.schemaVersion !== 1) {
    throw new Error("Direct Candidate Task-main snapshot must use schemaVersion 1.");
  }
  if (!Array.isArray(snapshot.projects) || snapshot.projects.length === 0) {
    throw new Error("Direct Candidate Task-main snapshot requires a Project.");
  }
  const projectIds = new Set<string>();
  for (const project of snapshot.projects) {
    const projectId = requireIdentity(project.projectId, "Direct Candidate snapshot Project");
    if (projectIds.has(projectId)) {
      throw new Error("Direct Candidate snapshot Projects are duplicated.");
    }
    projectIds.add(projectId);
    requireText(project.directory, "Direct Candidate snapshot directory");
    requireText(project.branch, "Direct Candidate snapshot branch");
    requireCommit(project.baseCommit, "Direct Candidate snapshot base");
    requireCommit(project.headCommit, "Direct Candidate snapshot head");
  }
  return snapshot;
}

export function createCandidateGitSnapshot(
  workspace: ManagedWorkspace,
  projects: readonly Readonly<{ projectId: string; commit: string }>[]
): CandidateGitSnapshot {
  validateManagedWorkspace(workspace);
  if (workspace.owner.type !== "work-item") {
    throw new Error("Candidate Git snapshot must come from a WorkItem workspace.");
  }
  if (workspace.entries.length === 0) {
    throw new Error("Candidate Git snapshot requires a Project workspace.");
  }
  const byProject = new Map(projects.map(({ projectId, commit: value }) => [
    requireIdentity(projectId, "Candidate snapshot Project"),
    requireCommit(value, "Candidate snapshot commit")
  ]));
  if (byProject.size !== projects.length) {
    throw new Error("Candidate snapshot Projects are duplicated.");
  }
  const normalized = workspace.entries.map(({ projectId }) => {
    const value = byProject.get(projectId);
    if (value === undefined) {
      throw new Error(`Candidate snapshot Project is missing: ${projectId}.`);
    }
    return { projectId, commit: value };
  });
  if (normalized.length !== byProject.size) {
    throw new Error("Candidate snapshot contains a Project outside its workspace.");
  }
  const primary = workspace.entries.find(({ access }) => access === "write")
    ?? workspace.entries[0]!;
  return {
    schemaVersion: 1,
    reviewBaseCommit: byProject.get(primary.projectId)!,
    projects: normalized
  };
}

function validateCandidateGitSnapshot(
  snapshot: CandidateGitSnapshot,
  workspace: ManagedWorkspace
): void {
  if (snapshot.schemaVersion !== 1) {
    throw new Error("Candidate Git snapshot must use schemaVersion 1.");
  }
  requireCommit(snapshot.reviewBaseCommit, "Candidate review base commit");
  const normalized = createCandidateGitSnapshot(workspace, snapshot.projects);
  if (normalized.reviewBaseCommit !== snapshot.reviewBaseCommit
    || JSON.stringify(normalized.projects) !== JSON.stringify(snapshot.projects)) {
    throw new Error("Candidate Git snapshot does not match its managed workspace.");
  }
}

function requireCommit(value: string, label: string): string {
  const commit = requireText(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) {
    throw new Error(`${label} is invalid.`);
  }
  return commit;
}

export function currentWorkItemCandidate(
  workItem: WorkItem
): WorkItemCandidate | undefined {
  return workItem.status === "awaiting_acceptance"
    ? workItem.candidates.at(-1)
    : undefined;
}

/**
 * Resolve the one Candidate that still governs Task delivery semantics.
 * Awaiting Candidates remain under Leader disposition, while completed
 * Candidates freeze accepted delivery evidence. Failed, retired, pending,
 * and running WorkItems retain Candidate history only for audit; older
 * Candidates on the same WorkItem are superseded by its latest Candidate.
 */
export function governingWorkItemCandidate(
  workItem: WorkItem
): WorkItemCandidate | undefined {
  return workItem.status === "awaiting_acceptance" || workItem.status === "completed"
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
    "retired"
  ].includes(status)) {
    throw new Error(`Work Item status is invalid: ${String(status)}.`);
  }
}

function normalizeProjectBaseRefs(
  baseRefs: readonly WorkItemProjectBaseRef[]
): readonly WorkItemProjectBaseRef[] {
  if (!Array.isArray(baseRefs)) {
    throw new Error("Work Item Project base refs are invalid.");
  }
  const projectIds = new Set<string>();
  return baseRefs.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Work Item Project base ref is invalid.");
    }
    const projectId = requireIdentity(entry.projectId, "Work Item Project id");
    if (projectIds.has(projectId)) {
      throw new Error(`Work Item Project base ref is duplicated: ${projectId}.`);
    }
    projectIds.add(projectId);
    const baseRef = requireText(entry.baseRef, "Work Item Project base ref");
    if (baseRef.startsWith("-") || /[\r\n]/u.test(baseRef)) {
      throw new Error("Work Item Project base ref is invalid.");
    }
    return { projectId, baseRef };
  });
}

function normalizeDisposition(
  input: WorkItemDispositionInput,
  now: Date
): WorkItemDisposition {
  if (input.by !== "leader" && input.by !== "operator" && input.by !== "user") {
    throw new Error("Work Item retirement actor is invalid.");
  }
  const summary = requireText(input.summary, "Work item disposition summary");
  const replacementWorkItemId = input.replacementWorkItemId;
  if (replacementWorkItemId !== undefined) {
    requireIdentity(replacementWorkItemId, "Replacement Work Item id");
  }
  const result: WorkItemDisposition = {
    schemaVersion: 1,
    by: input.by,
    summary,
    retiredAt: now.toISOString(),
    ...(replacementWorkItemId === undefined ? {} : { replacementWorkItemId })
  };
  return validateDisposition(result);
}

function validateDisposition(disposition: WorkItemDisposition): WorkItemDisposition {
  if (disposition.schemaVersion !== 1) {
    throw new Error("Work Item disposition must use schemaVersion 1.");
  }
  if (disposition.by !== "leader"
    && disposition.by !== "operator"
    && disposition.by !== "user") {
    throw new Error("Work Item disposition actor is invalid.");
  }
  requireText(disposition.summary, "Work item disposition summary");
  requireTimestamp(disposition.retiredAt, "Work Item retiredAt");
  if (disposition.replacementWorkItemId !== undefined) {
    requireIdentity(disposition.replacementWorkItemId, "Replacement Work Item id");
  }
  return disposition;
}

function sameDisposition(
  left: WorkItemDisposition,
  right: WorkItemDisposition
): boolean {
  return left.by === right.by
    && left.summary === right.summary
    && left.replacementWorkItemId === right.replacementWorkItemId;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string
): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown !== undefined) throw new Error(`${label} has unknown field: ${unknown}.`);
}
