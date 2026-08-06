import {
  requireIdentity,
  requireText,
  requireTimestamp
} from "../domain/validation.js";
import { validateTaskRecordReference } from "../task/taskRecordReference.js";
import {
  validateManagedWorkspace,
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
export type ReviewRoundStatus = "pending" | "running" | "completed" | "failed";
export type ReviewRequestSource = "policy" | "leader";
export type ReviewWorkspaceDisposition = "preserved" | "removed";

export type ReviewCheck = Readonly<{
  name: string;
  outcome: "passed" | "failed" | "skipped";
  details?: string;
}>;

export type ReviewYieldReport = Readonly<{
  summary: string;
  report: string;
  checks: readonly ReviewCheck[];
  evidenceCommit?: string;
}>;

export type ReviewRound = {
  schemaVersion: 2;
  id: string;
  taskId: string;
  workItemId: string;
  candidateId: string;
  reviewerRoleName: string;
  reviewerRunId?: string;
  reviewBaseCommit: string;
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
  now: Date
): ReviewRound {
  return validateReviewRound({
    schemaVersion: 2,
    id: requireIdentity(id, "ReviewRound id"),
    taskId: requireIdentity(taskId, "Task id"),
    workItemId: requireIdentity(workItemId, "Work Item id"),
    candidateId: requireIdentity(candidateId, "Candidate id"),
    reviewerRoleName: requireIdentity(reviewerRoleName, "Reviewer Role"),
    reviewBaseCommit: requireCommit(reviewBaseCommit, "Review base commit"),
    requestedBy: validateReviewRequestSource(requestedBy),
    status: "pending",
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
  reviewerRunId: string
): ReviewRound {
  validateReviewRound(round);
  if (round.status !== "pending") {
    throw new Error(`ReviewRound cannot start from ${round.status}: ${round.id}.`);
  }
  if (round.workspace === undefined) {
    throw new Error(`ReviewRound workspace is not ready: ${round.id}.`);
  }
  return validateReviewRound({
    ...round,
    reviewerRunId: requireIdentity(reviewerRunId, "Reviewer Run id"),
    status: "running"
  });
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
  }> = {}
): ReviewRound {
  validateReviewRound(round);
  if (round.status !== "pending" && round.status !== "running") {
    throw new Error(`ReviewRound is already terminal: ${round.id}.`);
  }
  return validateReviewRound({
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
}

/** Accepts the Reviewer's complete report and extracts only optional known evidence. */
export function parseReviewYieldReport(value: string): ReviewYieldReport {
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
  return {
    summary,
    report,
    checks,
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
  if (disposition !== "preserved" && disposition !== "removed") {
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

export function validateReviewRound(round: ReviewRound): ReviewRound {
  if (round.schemaVersion !== 2) throw new Error("ReviewRound must use schemaVersion 2.");
  validateTaskRecordReference({ taskId: round.taskId, localId: round.id }, "reviewRound");
  validateTaskRecordReference({ taskId: round.taskId, localId: round.workItemId }, "workItem");
  if (!/^candidate-[1-9]\d*$/.test(round.candidateId)) {
    throw new Error(`Candidate local id is invalid: ${round.candidateId}.`);
  }
  requireIdentity(round.reviewerRoleName, "Reviewer Role");
  requireCommit(round.reviewBaseCommit, "Review base commit");
  validateReviewRequestSource(round.requestedBy);
  if (!["pending", "running", "completed", "failed"].includes(round.status)) {
    throw new Error(`ReviewRound status is invalid: ${String(round.status)}.`);
  }
  if (round.reviewerRunId !== undefined) {
    validateTaskRecordReference({
      taskId: round.taskId,
      localId: round.reviewerRunId
    }, "agentRun");
  }
  if (round.workspace !== undefined) validateReviewWorkspace(round, round.workspace);
  requireTimestamp(round.createdAt, "ReviewRound createdAt");
  const terminal = round.status === "completed" || round.status === "failed";
  if (terminal) {
    requireText(round.summary ?? "", "Review summary");
    requireText(round.report ?? "", "Review report");
    validateChecks(round.checks ?? []);
    if (round.evidenceCommit !== undefined) {
      requireCommit(round.evidenceCommit, "Review evidence commit");
      if (round.evidenceCommit === round.reviewBaseCommit) {
        throw new Error("Review evidence commit must differ from its review base.");
      }
    }
    requireTimestamp(round.endedAt ?? "", "ReviewRound endedAt");
  } else if (round.summary !== undefined
    || round.report !== undefined
    || round.checks !== undefined
    || round.evidenceCommit !== undefined
    || round.endedAt !== undefined) {
    throw new Error("An active ReviewRound cannot have terminal metadata.");
  }
  if (round.status === "running"
    && (round.reviewerRunId === undefined || round.workspace === undefined)) {
    throw new Error("A running ReviewRound requires a Reviewer Run and workspace.");
  }
  if (round.workspaceDisposition !== undefined) {
    if (!terminal || round.workspace === undefined) {
      throw new Error("Only a terminal ReviewRound workspace can have a disposition.");
    }
    if (round.workspaceDisposition.kind !== "preserved"
      && round.workspaceDisposition.kind !== "removed") {
      throw new Error("Review workspace disposition is invalid.");
    }
    requireTimestamp(round.workspaceDisposition.recordedAt, "Review workspace disposition time");
  }
  return round;
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
  if (source !== "policy" && source !== "leader") {
    throw new Error(`Review request source is invalid: ${String(source)}.`);
  }
  return source;
}
