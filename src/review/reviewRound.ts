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
  validateExecutionGroup,
  validateReviewExecutionAssignment,
  type ReviewExecutionGroup
} from "../execution/workItemExecution.js";
export type ReviewRoundStatus = "pending" | "running" | "completed" | "failed";
export type ReviewRequestSource = "policy" | TaskCompletedBy;
export type ReviewWorkspaceDisposition = "preserved" | "reassigned" | "removed";
export type ReviewScope = "work-item" | "task";

/**
 * Issue 07: the only dispositions a delta-recheck Reviewer may return.
 * `equivalent-and-accepted` accepts the new frozen head; `finding` records
 * findings; `requires-full-review` returns explicit uncertainty to the Leader.
 */
export type DeltaRecheckDisposition =
  | "equivalent-and-accepted"
  | "finding"
  | "requires-full-review";

/**
 * Issue 07: lineage of a delta-recheck Task-final ReviewRound.  The record
 * binds the round to the previous completed Round and the exact diff it
 * rechecked, so an acceptance can never be silently copied to a different
 * tree.  `disposition` is absent while the Round is active and is recorded
 * exactly once at terminalization.
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
  /** Present only once the delta Round completed. */
  disposition?: DeltaRecheckDisposition;
  /** Reviewer's equivalence/escalation reasoning; present once terminal. */
  reasoning?: string;
  /** Full ReviewRound created after a `requires-full-review` escalation. */
  escalatedToReviewRoundId?: string;
}>;

/** Immutable heads reviewed by a Task-scoped final ReviewRound. */
export type TaskReviewCandidate = Readonly<{
  schemaVersion: 1;
  projects: readonly Readonly<{
    projectId: string;
    commit: string;
  }>[];
}>;

export type ReviewCheck = Readonly<{
  name: string;
  outcome: "passed" | "failed" | "skipped";
  details?: string;
}>;

export type ReviewFinding = Readonly<{
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "open" | "resolved";
  summary: string;
}>;

export type ReviewResultReport = Readonly<{
  summary: string;
  report: string;
  checks: readonly ReviewCheck[];
  findings?: readonly ReviewFinding[];
  evidence?: readonly string[];
  evidenceCommit?: string;
  /** Issue 07: delta-recheck disposition; absent for full Reviews. */
  deltaDisposition?: DeltaRecheckDisposition;
  /** Issue 07: delta-recheck equivalence/escalation reasoning. */
  deltaReasoning?: string;
}>;

export type ReviewRound = {
  /** v7 uses the unified direct/replicated execution authority. */
  schemaVersion: 7;
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
  /** Preserved opaque evidence from a valid pre-v7 Review ExecutionGroup. */
  legacyExecutionGroup?: Readonly<Record<string, unknown>>;
  workspace?: ManagedWorkspace;
  requestedBy: ReviewRequestSource;
  status: ReviewRoundStatus;
  summary?: string;
  report?: string;
  checks?: readonly ReviewCheck[];
  evidenceCommit?: string;
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
    schemaVersion: 7,
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
    schemaVersion: 7,
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
    schemaVersion: 7,
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
  summary: string,
  now: Date,
  result: Readonly<{
    report?: string;
    checks?: readonly ReviewCheck[];
    evidenceCommit?: string;
    /** Issue 07: delta-recheck disposition extracted from the Reviewer report. */
    deltaDisposition?: DeltaRecheckDisposition;
    /** Issue 07: Reviewer's delta-recheck equivalence/escalation reasoning. */
    deltaReasoning?: string;
  }> = {}
): ReviewRound {
  validateReviewRound(round);
  if (round.status !== "pending" && round.status !== "running") {
    throw new Error(`ReviewRound is already terminal: ${round.id}.`);
  }
  const terminal = validateReviewRound({
    ...round,
    status,
    summary: requireText(summary, "Review summary"),
    report: requireText(result.report ?? summary, "Review report"),
    checks: validateChecks(result.checks ?? []),
    ...(result.evidenceCommit === undefined
      ? {}
      : { evidenceCommit: requireCommit(result.evidenceCommit, "Review evidence commit") }),
    endedAt: now.toISOString()
  });
  if (round.deltaRecheck === undefined) {
    if (result.deltaDisposition !== undefined || result.deltaReasoning !== undefined) {
      throw new Error(`Only a delta-recheck ReviewRound can carry a delta disposition: ${round.id}.`);
    }
    return terminal;
  }
  if (status !== "completed") {
    // A failed delta Round is an infra attempt; it records no disposition and
    // the candidate stays unaccepted.
    return terminal;
  }
  // Fail closed: a completed delta Round without an explicit, valid
  // disposition remains non-accepting for Leader routing. Uncertainty never accepts.
  const disposition = result.deltaDisposition ?? "requires-full-review";
  const reasoning = result.deltaReasoning ?? result.report ?? summary;
  return validateReviewRound({
    ...terminal,
    deltaRecheck: validateDeltaRecheckRecord({
      ...round.deltaRecheck,
      disposition,
      reasoning: requireText(reasoning, "Delta recheck reasoning")
    })
  });
}

/**
 * Issue 06: retry a failed Task-final execution attempt under the same semantic
 * Round identity. Turn history remains the attempt trail; the Round itself
 * returns to pending so infrastructure retries do not manufacture a new
 * semantic ReviewRound or duplicate findings.
 */
export function retryTaskReviewRound(
  round: ReviewRound,
  requestedBy: TaskCompletedBy
): ReviewRound {
  validateReviewRound(round);
  if ((round.scope ?? "work-item") !== "task") {
    throw new Error(`Only a Task-final ReviewRound can be retried in place: ${round.id}.`);
  }
  if (round.status !== "failed") {
    throw new Error(`ReviewRound ${round.id} is not retryable from ${round.status}.`);
  }
  return validateReviewRound({
    schemaVersion: round.schemaVersion,
    id: round.id,
    taskId: round.taskId,
    reviewerRoleName: round.reviewerRoleName,
    reviewBaseCommit: round.reviewBaseCommit,
    scope: "task",
    ...(round.taskCandidate === undefined ? {} : { taskCandidate: round.taskCandidate }),
    ...(round.taskFinalReviewContract === undefined
      ? {}
      : { taskFinalReviewContract: round.taskFinalReviewContract }),
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
    // A replicated retry preserves the exact settled successful producer set.
    // Only the main Reviewer Turn is retried; successful Lanes never rerun.
    ...(round.executionGroup === undefined ? {} : { executionGroup: round.executionGroup }),
    ...(round.legacyExecutionGroup === undefined
      ? {}
      : { legacyExecutionGroup: round.legacyExecutionGroup }),
    requestedBy: validateReviewRequestSource(requestedBy),
    status: "pending",
    ...(round.workspace === undefined ? {} : { workspace: round.workspace }),
    createdAt: round.createdAt
  });
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

/** Accepts the Reviewer's complete report and extracts only optional known evidence. */
export function parseReviewResultReport(value: string): ReviewResultReport {
  const report = requireText(value, "Review report");
  let parsed: unknown;
  try {
    parsed = JSON.parse(report) as unknown;
  } catch {
    return { summary: report, report, checks: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { summary: report, report, checks: [] };
  }
  const record = parsed as Record<string, unknown>;
  const summary = typeof record.summary === "string" && record.summary.trim().length > 0
    ? requireText(record.summary, "Review summary")
    : report;
  const checks = extractChecks(record.checks);
  const findings = extractFindings(record.findings);
  const evidence = extractEvidence(record.evidence);
  const deltaDisposition = extractDeltaDisposition(record.deltaDisposition);
  return {
    summary,
    report,
    checks,
    ...(findings.length === 0 ? {} : { findings }),
    ...(evidence.length === 0 ? {} : { evidence }),
    ...(deltaDisposition === undefined ? {} : { deltaDisposition }),
    ...(typeof record.deltaReasoning !== "string"
      || record.deltaReasoning.trim().length === 0
      ? {}
      : { deltaReasoning: requireText(record.deltaReasoning, "Delta recheck reasoning") }),
    ...(typeof record.evidenceCommit !== "string"
      ? {}
      : {
          evidenceCommit: requireCommit(
            record.evidenceCommit,
            "Review evidence commit"
          )
        })
  };
}

function extractDeltaDisposition(value: unknown): DeltaRecheckDisposition | undefined {
  if (value !== "equivalent-and-accepted"
    && value !== "finding"
    && value !== "requires-full-review") {
    return undefined;
  }
  return value;
}

function extractFindings(value: unknown): readonly ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }
    const finding = entry as Record<string, unknown>;
    if (typeof finding.id !== "string"
      || (finding.severity !== "low" && finding.severity !== "medium"
        && finding.severity !== "high" && finding.severity !== "critical"
        && finding.severity !== "p1" && finding.severity !== "p2")
      || (finding.status !== "open" && finding.status !== "resolved")
      || typeof finding.summary !== "string") {
      return [];
    }
    return [{
      id: requireIdentity(finding.id, "Review finding id"),
      // Reviewers may use the product-level P1/P2 vocabulary. Execution
      // groups keep one canonical severity scale so resolution gates remain
      // stable across Worker and Reviewer reports.
      severity: finding.severity === "p1"
        ? "critical"
        : finding.severity === "p2"
          ? "high"
          : finding.severity,
      status: finding.status,
      summary: requireText(finding.summary, "Review finding summary")
    } as ReviewFinding];
  });
}

function extractEvidence(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => (
    typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : []
  ));
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
  if (round.schemaVersion !== 7) throw new Error("ReviewRound must use schemaVersion 7.");
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
  if (round.legacyExecutionGroup !== undefined
    && (typeof round.legacyExecutionGroup !== "object"
      || round.legacyExecutionGroup === null
      || Array.isArray(round.legacyExecutionGroup))) {
    throw new Error("ReviewRound legacy ExecutionGroup evidence is invalid.");
  }
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
    requireText(round.summary ?? "", "Review summary");
    requireText(round.report ?? "", "Review report");
    validateChecks(round.checks ?? []);
    if (round.evidenceCommit !== undefined) {
      // The exact commit on which the review's checks ran.  Equals the base
      // when the reviewer ran checks on the frozen candidate tree; differs
      // when the reviewer committed diagnostics on top of it.  A dirty
      // review with uncommitted changes records no evidenceCommit, since no
      // single commit captures the checked tree.
      requireCommit(round.evidenceCommit, "Review evidence commit");
    }
    requireTimestamp(round.endedAt ?? "", "ReviewRound endedAt");
  } else if (round.summary !== undefined
    || round.report !== undefined
    || round.checks !== undefined
    || round.evidenceCommit !== undefined
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
  if (round.deltaRecheck?.disposition !== undefined) {
    if (!terminal) {
      throw new Error("An active delta-recheck ReviewRound cannot have a disposition.");
    }
    if (round.deltaRecheck.reasoning === undefined
      || round.deltaRecheck.reasoning.trim().length === 0) {
      throw new Error("A terminal delta-recheck ReviewRound requires reasoning.");
    }
    if (round.deltaRecheck.escalatedToReviewRoundId !== undefined
      && round.deltaRecheck.disposition !== "requires-full-review") {
      throw new Error("Only a requires-full-review delta-recheck can record an escalation.");
    }
  }
  return round;
}

/** Validates a delta-recheck record's immutable identity and terminal fields. */
export function validateDeltaRecheckRecord(
  record: DeltaRecheckRecord
): DeltaRecheckRecord {
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
  if (record.disposition !== undefined
    && record.disposition !== "equivalent-and-accepted"
    && record.disposition !== "finding"
    && record.disposition !== "requires-full-review") {
    throw new Error(`Delta recheck disposition is invalid: ${String(record.disposition)}.`);
  }
  if (record.reasoning !== undefined) {
    requireText(record.reasoning, "Delta recheck reasoning");
  }
  if (record.escalatedToReviewRoundId !== undefined) {
    requireIdentity(record.escalatedToReviewRoundId, "Delta recheck escalation ReviewRound id");
  }
  return record;
}

/** True when this Round is an Issue 07 delta-recheck. */
export function isDeltaRecheckRound(round: ReviewRound): boolean {
  return round.deltaRecheck !== undefined;
}

/** True only when a delta Round explicitly accepted the new head. */
export function deltaRecheckAccepted(round: ReviewRound): boolean {
  return round.deltaRecheck?.disposition === "equivalent-and-accepted";
}

/** True when a delta Round escalated to a full Review. */
export function deltaRecheckEscalated(round: ReviewRound): boolean {
  return round.deltaRecheck?.disposition === "requires-full-review";
}

/**
 * True when a completed delta Round does NOT accept the new head.  A `finding`
 * or `requires-full-review` disposition must keep the completion gate closed.
 */
export function deltaRecheckBlocksAcceptance(round: ReviewRound): boolean {
  return round.deltaRecheck !== undefined
    && round.status === "completed"
    && round.deltaRecheck.disposition !== undefined
    && round.deltaRecheck.disposition !== "equivalent-and-accepted";
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

function extractChecks(value: unknown): readonly ReviewCheck[] {
  if (!Array.isArray(value)) return [];
  const extracted = value.flatMap((entry): ReviewCheck[] => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const check = entry as Record<string, unknown>;
    if (typeof check.name !== "string"
      || (check.outcome !== "passed"
        && check.outcome !== "failed"
        && check.outcome !== "skipped")) return [];
    return [{
      name: check.name,
      outcome: check.outcome,
      ...(typeof check.details === "string" ? { details: check.details } : {})
    }];
  });
  return validateChecks(extracted);
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

function validateChecks(checks: readonly ReviewCheck[]): readonly ReviewCheck[] {
  if (!Array.isArray(checks)) throw new Error("Review checks are invalid.");
  return checks.map((check) => {
    const name = requireText(check.name, "Review check name");
    if (check.outcome !== "passed" && check.outcome !== "failed"
      && check.outcome !== "skipped") {
      throw new Error(`Review check outcome is invalid: ${String(check.outcome)}.`);
    }
    return {
      name,
      outcome: check.outcome,
      ...(check.details === undefined
        ? {}
        : { details: requireText(check.details, "Review check details") })
    };
  });
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
