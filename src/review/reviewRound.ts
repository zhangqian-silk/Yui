import {
  requireIdentity,
  requireText,
  requireTimestamp
} from "../domain/validation.js";
import { validateTaskRecordReference } from "../task/taskRecordReference.js";
import type { TaskCompletedBy } from "../task/task.js";
import {
  validateTaskFinalReviewContract,
  type TaskFinalReviewContract
} from "./taskFinalReviewContract.js";
import {
  validateManagedWorkspace,
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
import {
  assertExecutionGroupTransition,
  retryFailedExecutionLanes,
  validateExecutionGroup,
  validateReviewExecutionAssignment,
  type ReviewExecutionGroup
} from "../execution/workItemExecution.js";
export type ReviewRoundStatus = "pending" | "running" | "completed" | "failed";
export type ReviewRequestSource = "policy" | TaskCompletedBy;
export type ReviewWorkspaceDisposition = "preserved" | "reassigned" | "removed";
export type ReviewScope = "work-item" | "task";

/**
 * Objective lineage of a delta-recheck Task-final ReviewRound. The Reviewer's
 * judgment remains solely in the exact Turn result.
 */
export type DeltaRecheckRecord = Readonly<{
  schemaVersion: 1;
  /** The completed Task-final ReviewRound whose acceptance this recheck extends. */
  previousReviewRoundId: string;
  /** Frozen head accepted by the previous Round. */
  previousBaseCommit: string;
  /** sha256 of the exact unified diff text between the two frozen heads. */
  diffDigest: string;
  changedFiles: readonly string[];
  addedLines: number;
  deletedLines: number;
}>;

/** Immutable heads reviewed by a Task-scoped final ReviewRound. */
export type TaskReviewCandidate = Readonly<{
  schemaVersion: 1;
  projects: readonly Readonly<{
    projectId: string;
    commit: string;
  }>[];
}>;

export type ReviewRoundFailure = Readonly<{
  kind: "dispatch" | "execution" | "quorum";
  message: string;
}>;

export type ReviewRound = {
  /** v8 keeps only Core-owned identity, lifecycle, and objective evidence. */
  schemaVersion: 8;
  id: string;
  taskId: string;
  workItemId?: string;
  candidateId?: string;
  reviewerRoleName: string;
  reviewerTurnId?: string;
  reviewBaseCommit: string;
  /** WorkItem review by default; `task` reviews the complete frozen Task. */
  scope?: ReviewScope;
  /** Present only when this round reviews the complete frozen Task. */
  taskCandidate?: TaskReviewCandidate;
  /** Exact Task/control capability that established this Task-final gate. */
  taskFinalReviewContract?: TaskFinalReviewContract;
  /** Present only when this Round is an Issue 07 delta-recheck. */
  deltaRecheck?: DeltaRecheckRecord;
  /** Present only for replicated producer execution; the main Reviewer is not a Lane. */
  executionGroup?: ReviewExecutionGroup;
  workspace?: ManagedWorkspace;
  requestedBy: ReviewRequestSource;
  status: ReviewRoundStatus;
  failure?: ReviewRoundFailure;
  workspaceDisposition?: Readonly<{
    kind: ReviewWorkspaceDisposition;
    recordedAt: string;
  }>;
  createdAt: string;
  endedAt?: string;
};

export function createReviewRound(
  id: string,
  taskId: string,
  workItemId: string,
  candidateId: string,
  reviewerRoleName: string,
  requestedBy: ReviewRequestSource,
  reviewBaseCommit: string,
  now: Date,
  executionGroup?: ReviewExecutionGroup
): ReviewRound {
  return validateReviewRound({
    schemaVersion: 8,
    id: requireIdentity(id, "ReviewRound id"),
    taskId: requireIdentity(taskId, "Task id"),
    workItemId: requireIdentity(workItemId, "Work Item id"),
    candidateId: requireIdentity(candidateId, "Candidate id"),
    reviewerRoleName: requireIdentity(reviewerRoleName, "Reviewer Role"),
    reviewBaseCommit: requireCommit(reviewBaseCommit, "Review base commit"),
    requestedBy: validateReviewRequestSource(requestedBy),
    status: "pending",
    ...(executionGroup === undefined ? {} : { executionGroup }),
    createdAt: now.toISOString()
  });
}

export function createTaskReviewRound(
  id: string,
  taskId: string,
  reviewerRoleName: string,
  requestedBy: ReviewRequestSource,
  taskCandidate: TaskReviewCandidate,
  now: Date,
  taskFinalReviewContract?: TaskFinalReviewContract,
  executionGroup?: ReviewExecutionGroup
): ReviewRound {
  const candidate = validateTaskReviewCandidate(taskCandidate);
  return validateReviewRound({
    schemaVersion: 8,
    id: requireIdentity(id, "ReviewRound id"),
    taskId: requireIdentity(taskId, "Task id"),
    reviewerRoleName: requireIdentity(reviewerRoleName, "Reviewer Role"),
    reviewBaseCommit: candidate.projects[0]!.commit,
    scope: "task",
    taskCandidate: candidate,
    ...(taskFinalReviewContract === undefined
      ? {}
      : { taskFinalReviewContract }),
    requestedBy: validateReviewRequestSource(requestedBy),
    status: "pending",
    ...(executionGroup === undefined ? {} : { executionGroup }),
    createdAt: now.toISOString()
  });
}

/**
 * Issue 07: creates a delta-recheck Task-final Round.  The Round still targets
 * the new frozen head and still requires a fresh Reviewer disposition; the
 * delta record only binds the recheck to the previous acceptance and the exact
 * diff so the Reviewer can prove equivalence instead of reloading every
 * first-round evidence.
 */
export function createTaskDeltaReviewRound(
  id: string,
  taskId: string,
  reviewerRoleName: string,
  requestedBy: ReviewRequestSource,
  taskCandidate: TaskReviewCandidate,
  deltaRecheck: DeltaRecheckRecord,
  now: Date,
  taskFinalReviewContract?: TaskFinalReviewContract,
  executionGroup?: ReviewExecutionGroup
): ReviewRound {
  const candidate = validateTaskReviewCandidate(taskCandidate);
  return validateReviewRound({
    schemaVersion: 8,
    id: requireIdentity(id, "ReviewRound id"),
    taskId: requireIdentity(taskId, "Task id"),
    reviewerRoleName: requireIdentity(reviewerRoleName, "Reviewer Role"),
    reviewBaseCommit: candidate.projects[0]!.commit,
    scope: "task",
    taskCandidate: candidate,
    ...(taskFinalReviewContract === undefined
      ? {}
      : { taskFinalReviewContract }),
    deltaRecheck: validateDeltaRecheckRecord(deltaRecheck),
    requestedBy: validateReviewRequestSource(requestedBy),
    status: "pending",
    ...(executionGroup === undefined ? {} : { executionGroup }),
    createdAt: now.toISOString()
  });
}

export function attachReviewRoundWorkspace(
  round: ReviewRound,
  workspace: ManagedWorkspace
): ReviewRound {
  validateReviewRound(round);
  validateReviewWorkspace(round, workspace);
  if (round.status !== "pending") {
    throw new Error(`ReviewRound workspace cannot attach from ${round.status}: ${round.id}.`);
  }
  if (round.workspace !== undefined) {
    if (JSON.stringify(round.workspace) !== JSON.stringify(workspace)) {
      throw new Error(`ReviewRound workspace is immutable: ${round.id}.`);
    }
    return round;
  }
  return validateReviewRound({ ...round, workspace });
}

export function startReviewRound(
  round: ReviewRound,
  reviewerTurnId: string
): ReviewRound {
  validateReviewRound(round);
  if (round.status !== "pending"
    && !(round.status === "running"
      && round.executionGroup !== undefined
      && round.reviewerTurnId === undefined)) {
    throw new Error(`ReviewRound cannot start from ${round.status}: ${round.id}.`);
  }
  if (round.workspace === undefined) {
    throw new Error(`ReviewRound workspace is not ready: ${round.id}.`);
  }
  return validateReviewRound({
    ...round,
    reviewerTurnId: requireIdentity(reviewerTurnId, "Reviewer Turn id"),
    status: "running"
  });
}

export function startReplicatedReviewRound(round: ReviewRound): ReviewRound {
  validateReviewRound(round);
  if (round.status !== "pending" || round.executionGroup === undefined) {
    throw new Error(`ReviewRound cannot start replicated execution: ${round.id}.`);
  }
  if (round.workspace === undefined) {
    throw new Error(`ReviewRound workspace is not ready: ${round.id}.`);
  }
  return validateReviewRound({ ...round, status: "running" });
}

export function finishReviewRound(
  round: ReviewRound,
  status: "completed" | "failed",
  now: Date,
  failure?: ReviewRoundFailure
): ReviewRound {
  validateReviewRound(round);
  if (round.status !== "pending" && round.status !== "running") {
    throw new Error(`ReviewRound is already terminal: ${round.id}.`);
  }
  if (status === "completed" && failure !== undefined) {
    throw new Error("A completed ReviewRound cannot carry failure metadata.");
  }
  if (status === "failed" && failure === undefined) {
    throw new Error("A failed ReviewRound requires Core-owned failure metadata.");
  }
  return validateReviewRound({
    ...round,
    status,
    ...(failure === undefined ? {} : { failure: validateReviewRoundFailure(failure) }),
    endedAt: now.toISOString()
  });
}

/**
 * Retry a failed review execution attempt under the same semantic Round
 * identity. Turn history remains the attempt trail; the Round itself returns
 * to pending so infrastructure retries do not manufacture a new semantic
 * ReviewRound or duplicate findings.
 */
export function retryReviewRound(
  round: ReviewRound,
  requestedBy: TaskCompletedBy,
  now: Date
): ReviewRound {
  validateReviewRound(round);
  if (round.status !== "failed") {
    throw new Error(`ReviewRound ${round.id} is not retryable from ${round.status}.`);
  }
  const taskScope = (round.scope ?? "work-item") === "task";
  return validateReviewRound({
    schemaVersion: round.schemaVersion,
    id: round.id,
    taskId: round.taskId,
    ...(round.scope === undefined ? {} : { scope: round.scope }),
    ...(taskScope
      ? {}
      : {
          workItemId: round.workItemId!,
          candidateId: round.candidateId!
        }),
    reviewerRoleName: round.reviewerRoleName,
    reviewBaseCommit: round.reviewBaseCommit,
    ...(taskScope
      ? {
          taskCandidate: round.taskCandidate!,
          ...(round.taskFinalReviewContract === undefined
            ? {}
            : { taskFinalReviewContract: round.taskFinalReviewContract })
        }
      : {}),
    ...(round.deltaRecheck === undefined
      ? {}
      // A retried delta Round is still the same semantic recheck: the
      // disposition is terminal evidence and must not be carried into the
      // fresh attempt, so only the immutable lineage is preserved.
      : {
          deltaRecheck: validateDeltaRecheckRecord({
            schemaVersion: 1,
            previousReviewRoundId: round.deltaRecheck.previousReviewRoundId,
            previousBaseCommit: round.deltaRecheck.previousBaseCommit,
            diffDigest: round.deltaRecheck.diffDigest,
            changedFiles: round.deltaRecheck.changedFiles,
            addedLines: round.deltaRecheck.addedLines,
            deletedLines: round.deltaRecheck.deletedLines
          })
        }),
    // A replicated retry preserves settled successful Producers and reopens
    // only failed Lanes. If every Producer succeeded, only the main Reviewer
    // Turn is retried.
    ...(round.executionGroup === undefined
      ? {}
      : { executionGroup: retryFailedExecutionLanes(round.executionGroup, now) }),
    requestedBy: validateReviewRequestSource(requestedBy),
    status: "pending",
    ...(round.workspace === undefined ? {} : { workspace: round.workspace }),
    createdAt: round.createdAt
  });
}

/** Task-final compatibility wrapper for callers that require that scope. */
export function retryTaskReviewRound(
  round: ReviewRound,
  requestedBy: TaskCompletedBy,
  now: Date
): ReviewRound {
  if ((round.scope ?? "work-item") !== "task") {
    throw new Error(`Only a Task-final ReviewRound can be retried in place: ${round.id}.`);
  }
  return retryReviewRound(round, requestedBy, now);
}

/** A failed producer attempt leaves its logical Lane open for another Turn. */
export function retryRunningReviewExecutionLane(
  round: ReviewRound,
  executionLaneId: string,
  turnId: string
): ReviewRound {
  validateReviewRound(round);
  if (round.status !== "running" || round.executionGroup === undefined) {
    throw new Error(`ReviewRound ${round.id} has no running ExecutionGroup.`);
  }
  const lane = round.executionGroup.lanes.find(({ id }) => id === executionLaneId);
  if (lane === undefined || lane.disposition !== "open" || lane.currentTurnId !== turnId) {
    throw new Error(
      `Review retry does not target the current failed Lane attempt: `
      + `${round.executionGroup.id}/${executionLaneId}/${turnId}.`
    );
  }
  return round;
}

export function recordReviewWorkspaceDisposition(
  round: ReviewRound,
  disposition: ReviewWorkspaceDisposition,
  now: Date
): ReviewRound {
  validateReviewRound(round);
  if (round.status !== "completed" && round.status !== "failed") {
    throw new Error(`ReviewRound must be terminal before workspace disposition: ${round.id}.`);
  }
  if (round.workspace === undefined) {
    throw new Error(`ReviewRound has no managed workspace: ${round.id}.`);
  }
  if (disposition !== "preserved"
    && disposition !== "reassigned"
    && disposition !== "removed") {
    throw new Error(`Review workspace disposition is invalid: ${String(disposition)}.`);
  }
  if (round.workspaceDisposition?.kind === disposition) return round;
  if (round.workspaceDisposition?.kind === "removed") {
    throw new Error(`ReviewRound workspace is already removed: ${round.id}.`);
  }
  return validateReviewRound({
    ...round,
    workspaceDisposition: { kind: disposition, recordedAt: now.toISOString() }
  });
}

/** Attach the common Reviewer panel Group while preserving the Round target. */
export function attachReviewExecutionGroup(
  round: ReviewRound,
  executionGroup: ReviewExecutionGroup
): ReviewRound {
  validateReviewRound(round);
  validateReviewExecutionGroup(executionGroup, round);
  if (round.status !== "pending") {
    throw new Error(`ReviewRound ExecutionGroup cannot attach from ${round.status}: ${round.id}.`);
  }
  if (round.executionGroup !== undefined) {
    if (JSON.stringify(round.executionGroup) !== JSON.stringify(executionGroup)) {
      throw new Error(`ReviewRound ExecutionGroup is immutable: ${round.id}.`);
    }
    return round;
  }
  return validateReviewRound({ ...round, executionGroup });
}

/** Advance a Reviewer panel Group without changing the Round target. */
export function updateReviewExecutionGroup(
  round: ReviewRound,
  executionGroup: ReviewExecutionGroup
): ReviewRound {
  validateReviewRound(round);
  validateReviewExecutionGroup(executionGroup, round);
  if (round.executionGroup === undefined) {
    if (round.status !== "pending") {
      throw new Error(`ReviewRound ExecutionGroup cannot attach from ${round.status}: ${round.id}.`);
    }
    return validateReviewRound({ ...round, executionGroup });
  }
  if (round.executionGroup.id !== executionGroup.id) {
    throw new Error(`ReviewRound ExecutionGroup identity is immutable: ${round.id}.`);
  }
  if (JSON.stringify(round.executionGroup) === JSON.stringify(executionGroup)) return round;
  assertExecutionGroupTransition(round.executionGroup, executionGroup);
  return validateReviewRound({ ...round, executionGroup });
}

export function validateReviewRound(round: ReviewRound): ReviewRound {
  rejectUnknownFields(round as unknown as Record<string, unknown>, [
    "schemaVersion",
    "id",
    "taskId",
    "workItemId",
    "candidateId",
    "reviewerRoleName",
    "reviewerTurnId",
    "reviewBaseCommit",
    "scope",
    "taskCandidate",
    "taskFinalReviewContract",
    "deltaRecheck",
    "executionGroup",
    "workspace",
    "requestedBy",
    "status",
    "failure",
    "workspaceDisposition",
    "createdAt",
    "endedAt"
  ], "ReviewRound");
  if (round.schemaVersion !== 8) throw new Error("ReviewRound must use schemaVersion 8.");
  validateTaskRecordReference({ taskId: round.taskId, localId: round.id }, "reviewRound");
  requireIdentity(round.reviewerRoleName, "Reviewer Role");
  requireCommit(round.reviewBaseCommit, "Review base commit");
  const scope = round.scope ?? "work-item";
  if (scope !== "work-item" && scope !== "task") {
    throw new Error(`ReviewRound scope is invalid: ${String(round.scope)}.`);
  }
  if (scope === "task") {
    if (round.workItemId !== undefined || round.candidateId !== undefined) {
      throw new Error(`Task ReviewRound cannot use a WorkItem Candidate anchor: ${round.id}.`);
    }
    if (round.taskCandidate === undefined) {
      throw new Error(`Task ReviewRound requires a frozen Task candidate: ${round.id}.`);
    }
    const candidate = validateTaskReviewCandidate(round.taskCandidate);
    if (candidate.projects[0]!.commit !== round.reviewBaseCommit) {
      throw new Error(`Task ReviewRound base does not match its primary Project: ${round.id}.`);
    }
    if (round.taskFinalReviewContract !== undefined) {
      const contract = validateTaskFinalReviewContract(round.taskFinalReviewContract);
      if (contract.taskId !== round.taskId) {
        throw new Error(`Task ReviewRound contract belongs to another Task: ${round.id}.`);
      }
      if (contract.reviewerRoleName !== round.reviewerRoleName) {
        throw new Error(`Task ReviewRound contract uses another Reviewer Role: ${round.id}.`);
      }
    }
  } else {
    if (round.workItemId === undefined || round.candidateId === undefined) {
      throw new Error(`WorkItem ReviewRound requires a Candidate anchor: ${round.id}.`);
    }
    validateTaskRecordReference({ taskId: round.taskId, localId: round.workItemId }, "workItem");
    if (!/^candidate-[1-9]\d*$/.test(round.candidateId)) {
      throw new Error(`Candidate local id is invalid: ${round.candidateId}.`);
    }
    if (round.taskCandidate !== undefined
      || round.taskFinalReviewContract !== undefined) {
      throw new Error(`WorkItem ReviewRound cannot carry Task-final metadata: ${round.id}.`);
    }
  }
  if (round.executionGroup !== undefined) validateReviewExecutionGroup(round.executionGroup, round);
  validateReviewRequestSource(round.requestedBy);
  if (!["pending", "running", "completed", "failed"].includes(round.status)) {
    throw new Error(`ReviewRound status is invalid: ${String(round.status)}.`);
  }
  if (round.deltaRecheck !== undefined) {
    if (scope !== "task") {
      throw new Error(`Only a Task-final ReviewRound can be a delta-recheck: ${round.id}.`);
    }
    validateDeltaRecheckRecord(round.deltaRecheck);
  }
  if (round.reviewerTurnId !== undefined) {
    validateTaskRecordReference({
      taskId: round.taskId,
      localId: round.reviewerTurnId
    }, "turn");
  }
  if (round.workspace !== undefined) validateReviewWorkspace(round, round.workspace);
  requireTimestamp(round.createdAt, "ReviewRound createdAt");
  const terminal = round.status === "completed" || round.status === "failed";
  if (terminal) {
    if (round.status === "completed" && round.reviewerTurnId === undefined) {
      throw new Error("A completed ReviewRound requires its exact main Reviewer Turn.");
    }
    if (round.status === "completed" && round.failure !== undefined) {
      throw new Error("A completed ReviewRound cannot carry failure metadata.");
    }
    if (round.status === "failed" && round.failure === undefined) {
      throw new Error("A failed ReviewRound requires failure metadata.");
    }
    if (round.failure !== undefined) validateReviewRoundFailure(round.failure);
    requireTimestamp(round.endedAt ?? "", "ReviewRound endedAt");
  } else if (round.failure !== undefined
    || round.endedAt !== undefined) {
    throw new Error("An active ReviewRound cannot have terminal metadata.");
  }
  if (round.status === "running" && round.workspace === undefined) {
    throw new Error("A running ReviewRound requires its main Reviewer workspace.");
  }
  if (round.status === "running"
    && round.reviewerTurnId === undefined
    && round.executionGroup === undefined) {
    throw new Error("A running ReviewRound requires a direct Reviewer Turn or replicated Group.");
  }
  if (round.workspaceDisposition !== undefined) {
    if (!terminal || round.workspace === undefined) {
      throw new Error("Only a terminal ReviewRound workspace can have a disposition.");
    }
    if (round.workspaceDisposition.kind !== "preserved"
      && round.workspaceDisposition.kind !== "reassigned"
      && round.workspaceDisposition.kind !== "removed") {
      throw new Error("Review workspace disposition is invalid.");
    }
    requireTimestamp(round.workspaceDisposition.recordedAt, "Review workspace disposition time");
  }
  return round;
}

/** Validates a delta-recheck record's immutable identity and terminal fields. */
export function validateDeltaRecheckRecord(
  record: DeltaRecheckRecord
): DeltaRecheckRecord {
  rejectUnknownFields(record as unknown as Record<string, unknown>, [
    "schemaVersion",
    "previousReviewRoundId",
    "previousBaseCommit",
    "diffDigest",
    "changedFiles",
    "addedLines",
    "deletedLines"
  ], "Delta recheck record");
  if (record.schemaVersion !== 1) {
    throw new Error("Delta recheck record must use schemaVersion 1.");
  }
  requireIdentity(record.previousReviewRoundId, "Delta recheck previous ReviewRound id");
  requireCommit(record.previousBaseCommit, "Delta recheck previous base commit");
  if (!/^[a-f0-9]{64}$/u.test(record.diffDigest)) {
    throw new Error("Delta recheck diff digest is invalid.");
  }
  if (!Array.isArray(record.changedFiles)
    || record.changedFiles.some((file) => typeof file !== "string" || file.trim().length === 0)) {
    throw new Error("Delta recheck changed files are invalid.");
  }
  if (!Number.isInteger(record.addedLines) || record.addedLines < 0
    || !Number.isInteger(record.deletedLines) || record.deletedLines < 0) {
    throw new Error("Delta recheck line counts are invalid.");
  }
  return record;
}

/** True when this Round is an Issue 07 delta-recheck. */
export function isDeltaRecheckRound(round: ReviewRound): boolean {
  return round.deltaRecheck !== undefined;
}

function validateReviewRoundFailure(failure: ReviewRoundFailure): ReviewRoundFailure {
  rejectUnknownFields(failure as unknown as Record<string, unknown>, [
    "kind",
    "message"
  ], "ReviewRound failure");
  if (failure.kind !== "dispatch"
    && failure.kind !== "execution"
    && failure.kind !== "quorum") {
    throw new Error("ReviewRound failure kind is invalid.");
  }
  requireText(failure.message, "ReviewRound failure message");
  return failure;
}

function validateReviewExecutionGroup(
  group: ReviewExecutionGroup,
  round: ReviewRound
): ReviewExecutionGroup {
  validateExecutionGroup(group);
  const assignment = validateReviewExecutionAssignment(group.assignment);
  if (group.taskId !== round.taskId
    || assignment.taskId !== round.taskId
    || assignment.reviewRoundId !== round.id
    || assignment.reviewBaseCommit !== round.reviewBaseCommit
    || assignment.scope !== (round.scope ?? "work-item")) {
    throw new Error(`ReviewRound ExecutionGroup provenance is invalid: ${round.id}.`);
  }
  if ((round.scope ?? "work-item") === "work-item"
    && (assignment.workItemId !== round.workItemId
      || assignment.candidateId !== round.candidateId)) {
    throw new Error(`ReviewRound ExecutionGroup WorkItem target is invalid: ${round.id}.`);
  }
  if (group.lanes.some(({ roleName }) => roleName === round.reviewerRoleName)) {
    throw new Error(`The main Reviewer cannot also be a Producer Lane: ${round.id}.`);
  }
  return group;
}

export function validateTaskReviewCandidate(
  candidate: TaskReviewCandidate
): TaskReviewCandidate {
  if (candidate.schemaVersion !== 1) {
    throw new Error("Task Review candidate must use schemaVersion 1.");
  }
  if (!Array.isArray(candidate.projects) || candidate.projects.length === 0) {
    throw new Error("Task Review candidate requires at least one Project.");
  }
  const projects = candidate.projects.map(({ projectId, commit }) => ({
    projectId: requireIdentity(projectId, "Task Review Project"),
    commit: requireCommit(commit, "Task Review Project commit")
  }));
  if (new Set(projects.map(({ projectId }) => projectId)).size !== projects.length) {
    throw new Error("Task Review candidate Projects must be unique.");
  }
  return { schemaVersion: 1, projects };
}

function validateReviewWorkspace(round: ReviewRound, workspace: ManagedWorkspace): void {
  validateManagedWorkspace(workspace);
  if (workspace.owner.taskId !== round.taskId) {
    throw new Error(`ReviewRound workspace provenance is invalid: ${round.id}.`);
  }
  if (workspace.owner.type !== "review-round"
    || workspace.owner.reviewRoundId !== round.id) {
    throw new Error(`ReviewRound does not own its workspace: ${round.id}.`);
  }
  if (workspace.entries.length === 0
    || workspace.entries.some(({ access }) => access !== "write")) {
    throw new Error(`ReviewRound workspace must contain only writable isolated entries: ${round.id}.`);
  }
  if (!workspace.entries.some(({ baseCommit }) => baseCommit === round.reviewBaseCommit)) {
    throw new Error(`ReviewRound workspace does not contain its review base: ${round.id}.`);
  }
}

function requireCommit(value: string, label: string): string {
  const commit = requireText(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) {
    throw new Error(`${label} is invalid.`);
  }
  return commit;
}

function validateReviewRequestSource(source: ReviewRequestSource): ReviewRequestSource {
  if (source !== "policy"
    && source !== "user"
    && source !== "operator"
    && source !== "leader") {
    throw new Error(`Review request source is invalid: ${String(source)}.`);
  }
  return source;
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
