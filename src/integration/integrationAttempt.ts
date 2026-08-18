import {
  normalizedUniqueIdentities,
  normalizedUniqueText,
  requireIdentity,
  requireText,
  requireTimestamp
} from "../domain/validation.js";
import { validateTaskRecordReference } from "../task/taskRecordReference.js";
import {
  normalizeCheckResult,
  type CheckResult
} from "./checkResult.js";

export type IntegrationAttemptStatus =
  | "running"
  | "blocked"
  | "validating"
  | "committed"
  | "superseded"
  | "failed";

export type ConflictReport = Readonly<{
  affectedPaths: readonly string[];
  summary: string;
}>;

export type ResolutionDecision = Readonly<{
  action: "manual-resolution" | "reject";
  rationale: string;
  decidedBy: "leader";
  decidedAt: string;
}>;

export type IntegrationAttempt = Readonly<{
  schemaVersion: 4;
  id: string;
  taskId: string;
  projectId: string;
  targetRef: string;
  expectedHead: string;
  changeSetIds: readonly string[];
  checkCommands: readonly string[];
  candidateCommit?: string;
  /**
   * The VerificationPlan digests captured when the gate job started.
   * On resume, the artifact is recorded under this identity (not the
   * current plan's), so a plan edit during the gate never misattributes
   * the evidence.
   */
  gatePlanDigest?: string;
  gateToolchainDigest?: string;
  /**
   * The DurableJob running the check commands, once the Controller has
   * accepted it. A running attempt with a jobId never goes "no-check":
   * the job is the source of truth and its terminal wakeup resumes the
   * attempt through `integration continue`.
   */
  jobId?: string;
  status: IntegrationAttemptStatus;
  conflict?: ConflictReport;
  resolution?: ResolutionDecision;
  checks?: readonly CheckResult[];
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}>;

export function createIntegrationAttempt(
  input: Readonly<Pick<
    IntegrationAttempt,
    "id" | "taskId" | "projectId" | "targetRef" | "expectedHead" | "changeSetIds"
  > & Partial<Pick<
    IntegrationAttempt,
    "checkCommands"
  >>>,
  now: Date
): IntegrationAttempt {
  const timestamp = now.toISOString();
  return validateIntegrationAttempt({
    schemaVersion: 4,
    id: input.id,
    taskId: input.taskId,
    projectId: input.projectId,
    targetRef: input.targetRef,
    expectedHead: input.expectedHead,
    changeSetIds: [...input.changeSetIds],
    checkCommands: normalizedUniqueText(input.checkCommands ?? [], "Integration check command"),
    status: "running",
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

/**
 * Bind the check DurableJob to a running attempt. Set-once: the job is the
 * durable source of truth for the checks, so a retry of the start path must
 * find the recorded job instead of spawning a second one.
 */
export function recordIntegrationCheckJob(
  attempt: IntegrationAttempt,
  jobId: string,
  now: Date
): IntegrationAttempt {
  validateIntegrationAttempt(attempt);
  if (attempt.status !== "running") {
    throw new Error(`Integration check job can only bind a running attempt: ${attempt.status}.`);
  }
  if (attempt.jobId !== undefined) {
    throw new Error(`Integration check job is already recorded: ${attempt.jobId}.`);
  }
  validateTaskRecordReference(
    { taskId: attempt.taskId, localId: jobId },
    "durableJob"
  );
  return validateIntegrationAttempt({
    ...attempt,
    jobId,
    updatedAt: now.toISOString()
  });
}

export function requireLeaderDecision(
  attempt: IntegrationAttempt,
  report: ConflictReport,
  now: Date
): IntegrationAttempt {
  validateIntegrationAttempt(attempt);
  const continuingAfterResolution = attempt.status === "blocked"
    && attempt.resolution?.action === "manual-resolution";
  if (attempt.status !== "running" && !continuingAfterResolution) {
    throw new Error(`Integration cannot request a decision from ${attempt.status}.`);
  }
  const {
    resolution: _previousResolution,
    endedAt: _endedAt,
    ...unresolved
  } = attempt;
  return validateIntegrationAttempt({
    ...unresolved,
    status: "blocked",
    conflict: normalizeConflictReport(report),
    updatedAt: now.toISOString()
  });
}

export function recordResolutionDecision(
  attempt: IntegrationAttempt,
  decision: Omit<ResolutionDecision, "decidedBy" | "decidedAt">,
  now: Date
): IntegrationAttempt {
  validateIntegrationAttempt(attempt);
  if (attempt.status !== "blocked" || attempt.conflict === undefined) {
    throw new Error("Integration has no pending semantic decision.");
  }
  if (decision.action !== "manual-resolution" && decision.action !== "reject") {
    throw new Error(`Resolution action is invalid: ${String(decision.action)}.`);
  }
  const timestamp = now.toISOString();
  return validateIntegrationAttempt({
    ...attempt,
    status: decision.action === "reject" ? "failed" : "blocked",
    resolution: {
      action: decision.action,
      rationale: requireText(decision.rationale, "Resolution rationale"),
      decidedBy: "leader",
      decidedAt: timestamp
    },
    updatedAt: timestamp,
    ...(decision.action === "reject" ? { endedAt: timestamp } : {})
  });
}

const TERMINAL_STATUSES = ["committed", "superseded", "failed"];

export function updateIntegrationAttempt(
  attempt: IntegrationAttempt,
  patch: Readonly<Partial<Pick<
    IntegrationAttempt,
    "candidateCommit" | "status" | "conflict" | "checks"
    | "gatePlanDigest" | "gateToolchainDigest"
  >>>,
  now: Date
): IntegrationAttempt {
  validateIntegrationAttempt(attempt);
  const status = patch.status ?? attempt.status;
  const terminal = TERMINAL_STATUSES.includes(status);
  const updated: IntegrationAttempt = {
    ...attempt,
    ...patch,
    status,
    updatedAt: now.toISOString(),
    ...(terminal ? { endedAt: now.toISOString() } : {})
  };
  if (!terminal && updated.endedAt !== undefined) {
    const { endedAt: _endedAt, ...active } = updated;
    return validateIntegrationAttempt(active);
  }
  return validateIntegrationAttempt(updated);
}

/**
 * Mark a committed Integration as superseded (obsolete).  A superseded
 * Integration retains its evidence but is excluded from latest-committed
 * selection, allowing the next valid committed Integration to become the
 * Task's delivery baseline.  Only a committed Integration may be superseded;
 * a reason is required for the audit trail.
 */
export function supersedeIntegration(
  attempt: IntegrationAttempt,
  reason: string,
  now: Date
): IntegrationAttempt {
  validateIntegrationAttempt(attempt);
  if (attempt.status !== "committed") {
    throw new Error(`Integration cannot be superseded from ${attempt.status}: ${attempt.id}.`);
  }
  const timestamp = now.toISOString();
  return validateIntegrationAttempt({
    ...attempt,
    status: "superseded",
    checks: [
      ...(attempt.checks ?? []),
      { name: "superseded", outcome: "failed" as const, details: requireText(reason, "Supersede reason") }
    ],
    updatedAt: timestamp,
    endedAt: timestamp
  });
}

export function validateIntegrationAttempt(attempt: IntegrationAttempt): IntegrationAttempt {
  if (attempt.schemaVersion !== 4) {
    throw new Error("IntegrationAttempt must use schemaVersion 4.");
  }
  validateTaskRecordReference({
    taskId: attempt.taskId,
    localId: attempt.id
  }, "integrationAttempt");
  requireIdentity(attempt.projectId, "Project id");
  requireText(attempt.targetRef, "Integration target ref");
  requireCommit(attempt.expectedHead, "Integration expected head");
  normalizedUniqueIdentities(attempt.changeSetIds, "ChangeSet id");
  for (const changeSetId of attempt.changeSetIds) {
    validateTaskRecordReference({ taskId: attempt.taskId, localId: changeSetId }, "changeSet");
  }
  normalizedUniqueText(attempt.checkCommands, "Integration check command");
  if (attempt.changeSetIds.length === 0) {
    throw new Error("IntegrationAttempt requires at least one ChangeSet.");
  }
  if (attempt.candidateCommit !== undefined) {
    requireCommit(attempt.candidateCommit, "Integration candidate commit");
  }
  if (attempt.jobId !== undefined) {
    validateTaskRecordReference(
      { taskId: attempt.taskId, localId: attempt.jobId },
      "durableJob"
    );
  }
  if (![
    "running",
    "blocked",
    "validating",
    "committed",
    "superseded",
    "failed"
  ].includes(attempt.status)) {
    throw new Error(`Integration status is invalid: ${String(attempt.status)}.`);
  }
  if (attempt.conflict !== undefined) normalizeConflictReport(attempt.conflict);
  if (attempt.status === "blocked" && attempt.conflict === undefined) {
    throw new Error("A blocked Integration needs a ConflictReport.");
  }
  if (attempt.resolution !== undefined) {
    if (
      attempt.resolution.action !== "manual-resolution"
      && attempt.resolution.action !== "reject"
    ) {
      throw new Error(`Resolution action is invalid: ${String(attempt.resolution.action)}.`);
    }
    requireText(attempt.resolution.rationale, "Resolution rationale");
    if (attempt.resolution.decidedBy !== "leader") {
      throw new Error("Only the Leader may record a ResolutionDecision.");
    }
    requireTimestamp(attempt.resolution.decidedAt, "Resolution decidedAt");
  }
  attempt.checks?.forEach(normalizeCheckResult);
  requireTimestamp(attempt.createdAt, "Integration Attempt createdAt");
  requireTimestamp(attempt.updatedAt, "Integration Attempt updatedAt");
  if (TERMINAL_STATUSES.includes(attempt.status)) {
    requireTimestamp(attempt.endedAt ?? "", "Integration Attempt endedAt");
  }
  return attempt;
}

function normalizeConflictReport(report: ConflictReport): ConflictReport {
  const affectedPaths = normalizedUniqueText(report.affectedPaths, "Conflict path");
  return {
    affectedPaths,
    summary: requireText(report.summary, "Conflict summary")
  };
}

function requireCommit(value: string, label: string): string {
  const normalized = requireText(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}
