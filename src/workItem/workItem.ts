import {
  normalizedUniqueIdentities,
  normalizedUniqueText,
  requireIdentity,
  requirePositiveInteger,
  requireText,
  requireTimestamp
} from "../domain/validation.js";
import {
  contextContentDigest,
  validateContextSnapshotRef,
  type ContextSnapshotRef
} from "../context/contextSnapshot.js";
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
  assertExecutionGroupTransition,
  validateExecutionGroup,
  WORK_ITEM_EXPLORATION_STAGES,
  type CandidateConvergencePolicy,
  type ExecutionGroup,
  type ExecutionParentResultRef,
  type ExecutionStageContext,
  type ExecutionStrategy,
  type WorkItemExplorationMode,
  type WorkItemExplorationStage
} from "../execution/executionGroup.js";

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
  /** v11 lets new exploration histories freeze the structured convergence policy. */
  schemaVersion: 11;
  id: string;
  taskId: string;
  title: string;
  objective: string;
  acceptance: readonly string[];
  dependsOn: readonly string[];
  writeProjectIds: readonly string[];
  /** Immutable execution history for this WorkItem. */
  executionGroups: readonly ExecutionGroup[];
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
    executionGroups?: readonly ExecutionGroup[];
    currentExecutionGroupId?: string;
  }>,
  now: Date
): WorkItem {
  const timestamp = now.toISOString();
  return validateWorkItem({
    schemaVersion: 11,
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

export function submitWorkItemCandidate(
  workItem: WorkItem,
  input: Readonly<{
    summary: string;
    source:
      | Readonly<{ type: "direct" }>
      | Readonly<{ type: "run"; runId: string }>;
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
    schemaVersion: 2,
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
  executionGroup: ExecutionGroup,
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
  if (current !== undefined && current.resolution === undefined) {
    throw new Error(`Work Item already has an unresolved ExecutionGroup: ${workItem.id}/${current.id}.`);
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
  executionGroup: ExecutionGroup,
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
  if (JSON.stringify(existing.target) !== JSON.stringify(checked.target)) {
    throw new Error(`Work Item ExecutionGroup target is immutable: ${workItem.id}/${checked.id}.`);
  }
  if (JSON.stringify(existing) === JSON.stringify(checked)) return workItem;
  assertExecutionGroupTransition(existing, checked);
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
  // Keep every historical Group. A resolved current Group is cleared only as
  // the current pointer; dispatch appends a fresh immutable Group.
  const current = currentWorkItemExecutionGroup(workItem);
  const retryBase = current?.resolution === undefined
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
  if (workItem.schemaVersion !== 11) throw new Error("WorkItem must use schemaVersion 11.");
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
  validateWorkItemExplorationHistory(workItem.executionGroups);
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
    if (candidate.executionGroupId !== undefined) {
      const group = workItem.executionGroups.find(({ id }) => id === candidate.executionGroupId);
      if (group?.stage !== undefined) {
        if (group.stage.stage !== "resolve"
          || group.resolution?.decision !== "accept"
          || !group.resolution.selectedLaneIds.includes(candidate.executionLaneId!)) {
          throw new Error("An exploration Candidate must come from the accepted Resolve stage.");
        }
      }
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

export type PlanWorkItemExplorationStageInput = Readonly<{
  /** Required only when the first exploration Group is planned. */
  mode?: WorkItemExplorationMode;
  /** Required only when the first exploration Group is planned. */
  maxRounds?: number;
  /** Required for a new stage; retries inherit the frozen stage budget. */
  maxAttempts?: number;
  strategy: ExecutionStrategy;
  contextSnapshotRef: ContextSnapshotRef;
  /** Set only on the first stage; every successor inherits the frozen policy. */
  convergence?: CandidateConvergencePolicy;
}>;

/**
 * Project the next legal exploration stage from immutable WorkItem Group
 * history. Retry repeats the current stage; retry at Resolve begins the next
 * round. Reject has no continuation, while blocked follows the same bounded
 * retry path after the Leader settles any required InputRequest.
 */
export function planWorkItemExplorationStage(
  workItem: WorkItem,
  input: PlanWorkItemExplorationStageInput
): ExecutionStageContext {
  validateWorkItem(workItem);
  const snapshot = validateContextSnapshotRef(input.contextSnapshotRef);
  const capacity = executionStrategyCapacity(input.strategy);
  const current = currentWorkItemExecutionGroup(workItem);
  if (workItem.executionGroups.length === 0) {
    if (workItem.status !== "pending" && workItem.status !== "running") {
      throw new Error(`Work Item cannot begin exploration from ${workItem.status}: ${workItem.id}.`);
    }
    if (input.mode === undefined) {
      throw new Error("The first exploration stage requires a mode.");
    }
    if (input.convergence === undefined) {
      throw new Error("The first exploration stage requires a candidate convergence policy.");
    }
    return {
      schemaVersion: 1,
      mode: input.mode,
      stage: "plan",
      round: 1,
      stageAttempt: 1,
      maxRounds: requirePositiveInteger(input.maxRounds ?? 1, "Exploration max rounds"),
      budget: {
        maxLanes: capacity,
        maxAttempts: requirePositiveInteger(
          input.maxAttempts ?? 1,
          "Exploration stage max attempts"
        )
      },
      contextSnapshotRef: snapshot,
      parentResults: [],
      ...(input.convergence === undefined ? {} : { convergence: input.convergence })
    };
  }
  if (current === undefined || current.stage === undefined) {
    throw new Error("A Work Item cannot mix single and exploration ExecutionGroups.");
  }
  if (current.resolution === undefined) {
    throw new Error(`Execution stage is still active: ${current.id}.`);
  }
  if (input.mode !== undefined && input.mode !== current.stage.mode) {
    throw new Error("Work Item exploration mode is immutable.");
  }
  if (input.maxRounds !== undefined && input.maxRounds !== current.stage.maxRounds) {
    throw new Error("Work Item exploration maxRounds is immutable.");
  }
  const parentResults = selectedParentResults(current);
  const base = {
    schemaVersion: 1 as const,
    mode: current.stage.mode,
    maxRounds: current.stage.maxRounds,
    contextSnapshotRef: snapshot,
    parentResults,
    ...(current.stage.convergence === undefined
      ? {}
      : { convergence: current.stage.convergence })
  };
  if (current.resolution.decision === "reject") {
    throw new Error(`Rejected exploration has no continuation: ${current.id}.`);
  }
  if (current.resolution.decision === "accept") {
    if (current.stage.stage === "resolve") {
      throw new Error(`Accepted Resolve stage already completed exploration: ${current.id}.`);
    }
    return {
      ...base,
      stage: nextExplorationStage(current.stage.stage),
      round: current.stage.round,
      stageAttempt: 1,
      budget: {
        maxLanes: capacity,
        maxAttempts: requirePositiveInteger(
          input.maxAttempts ?? 1,
          "Exploration stage max attempts"
        )
      }
    };
  }
  if (current.stage.stage === "resolve" && current.resolution.decision === "retry") {
    if (current.stage.round >= current.stage.maxRounds) {
      throw new Error(`Work Item exploration round budget is exhausted: ${workItem.id}.`);
    }
    return {
      ...base,
      stage: "plan",
      round: current.stage.round + 1,
      stageAttempt: 1,
      budget: {
        maxLanes: capacity,
        maxAttempts: requirePositiveInteger(
          input.maxAttempts ?? 1,
          "Exploration stage max attempts"
        )
      }
    };
  }
  if (current.stage.stageAttempt >= current.stage.budget.maxAttempts) {
    throw new Error(`Work Item exploration stage attempt budget is exhausted: ${workItem.id}.`);
  }
  if (capacity !== current.stage.budget.maxLanes) {
    throw new Error("A retried exploration stage must keep its frozen Lane budget.");
  }
  if (input.maxAttempts !== undefined
    && input.maxAttempts !== current.stage.budget.maxAttempts) {
    throw new Error("A retried exploration stage must keep its frozen attempt budget.");
  }
  return {
    ...base,
    stage: current.stage.stage,
    round: current.stage.round,
    stageAttempt: current.stage.stageAttempt + 1,
    budget: current.stage.budget
  };
}

/** Resolve the WorkItem's current execution iteration. */
export function currentWorkItemExecutionGroup(
  workItem: WorkItem
): ExecutionGroup | undefined {
  return workItem.currentExecutionGroupId === undefined
    ? undefined
    : workItemExecutionGroupById(workItem, workItem.currentExecutionGroupId);
}

/** Resolve any historical or current WorkItem Group by its immutable id. */
export function workItemExecutionGroupById(
  workItem: WorkItem,
  executionGroupId: string
): ExecutionGroup | undefined {
  return workItem.executionGroups.find(({ id }) => id === executionGroupId);
}

/**
 * True when a Run failure belongs to the WorkItem's current unresolved Lane.
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
    && group.resolution === undefined
    && group.lanes.some(({ id, status }) => (
      id === executionLaneId && status === "failed"
    ));
}

function validateWorkItemExplorationHistory(groups: readonly ExecutionGroup[]): void {
  const staged = groups.filter(({ stage }) => stage !== undefined);
  if (staged.length === 0) return;
  if (staged.length !== groups.length) {
    throw new Error("A Work Item cannot mix single and exploration ExecutionGroups.");
  }
  const first = groups[0]!.stage!;
  if (first.stage !== "plan"
    || first.round !== 1
    || first.stageAttempt !== 1
    || first.parentResults.length !== 0) {
    throw new Error("Work Item exploration must begin at Plan round 1 attempt 1.");
  }
  for (let index = 1; index < groups.length; index += 1) {
    const previous = groups[index - 1]!;
    const current = groups[index]!;
    const before = previous.stage!;
    const after = current.stage!;
    if (previous.resolution === undefined) {
      throw new Error(`Exploration stage must resolve before its successor: ${previous.id}.`);
    }
    if (previous.resolution.decision === "reject") {
      throw new Error(`Rejected exploration cannot have a successor: ${previous.id}.`);
    }
    if (after.mode !== before.mode
      || after.maxRounds !== before.maxRounds
      || JSON.stringify(after.convergence) !== JSON.stringify(before.convergence)) {
      throw new Error("Work Item exploration mode, maxRounds and convergence policy are immutable.");
    }
    const parents = selectedParentResults(previous);
    if (JSON.stringify(after.parentResults) !== JSON.stringify(parents)) {
      throw new Error(`Exploration parentResults do not match ${previous.id}.`);
    }
    if (previous.resolution.decision === "accept") {
      if (before.stage === "resolve"
        || after.stage !== nextExplorationStage(before.stage)
        || after.round !== before.round
        || after.stageAttempt !== 1) {
        throw new Error(`Exploration stage transition is invalid: ${previous.id}/${current.id}.`);
      }
      continue;
    }
    if (before.stage === "resolve" && previous.resolution.decision === "retry") {
      if (before.round >= before.maxRounds
        || after.stage !== "plan"
        || after.round !== before.round + 1
        || after.stageAttempt !== 1) {
        throw new Error(`Exploration round transition is invalid: ${previous.id}/${current.id}.`);
      }
      continue;
    }
    if (after.stage !== before.stage
      || after.round !== before.round
      || after.stageAttempt !== before.stageAttempt + 1
      || after.stageAttempt > before.budget.maxAttempts
      || JSON.stringify(after.budget) !== JSON.stringify(before.budget)) {
      throw new Error(`Exploration retry transition is invalid: ${previous.id}/${current.id}.`);
    }
  }
}

function selectedParentResults(group: ExecutionGroup): readonly ExecutionParentResultRef[] {
  if (group.resolution === undefined) {
    throw new Error(`ExecutionGroup is unresolved: ${group.id}.`);
  }
  return group.resolution.selectedLaneIds.map((laneId) => {
    const lane = group.lanes.find(({ id }) => id === laneId);
    if (lane?.result === undefined) {
      throw new Error(`Selected ExecutionLane result is missing: ${group.id}/${laneId}.`);
    }
    return {
      executionGroupId: group.id,
      executionLaneId: lane.id,
      resultDigest: contextContentDigest(lane.result)
    };
  });
}

function nextExplorationStage(stage: WorkItemExplorationStage): WorkItemExplorationStage {
  const index = WORK_ITEM_EXPLORATION_STAGES.indexOf(stage);
  const next = WORK_ITEM_EXPLORATION_STAGES[index + 1];
  if (next === undefined) throw new Error("Resolve is the final exploration stage.");
  return next;
}

function executionStrategyCapacity(strategy: ExecutionStrategy): number {
  return requirePositiveInteger(
    strategy.mode === "fixed" ? strategy.count : strategy.max,
    "Execution strategy capacity"
  );
}

function validateWorkItemExecutionGroup(
  group: ExecutionGroup,
  taskId: string,
  workItemId: string
): ExecutionGroup {
  validateExecutionGroup(group);
  if (group.taskId !== taskId || group.purpose !== "execution") {
    throw new Error(`Work Item ExecutionGroup provenance is invalid: ${workItemId}.`);
  }
  if (group.target.kind !== "work-item"
    || group.target.workItemId !== workItemId
    || group.target.taskId !== taskId) {
    throw new Error(`Work Item ExecutionGroup target is invalid: ${workItemId}.`);
  }
  return group;
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
    if (candidate.source.type !== "direct"
      || candidate.workspace !== undefined
      || candidate.gitSnapshot !== undefined
      || candidate.taskFinalReviewContract === undefined) {
      throw new Error(
        "Task-main Candidate snapshot requires an exact direct metadata-only Candidate."
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
