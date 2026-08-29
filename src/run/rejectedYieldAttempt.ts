import {
  contextContentDigest,
  validateContextSnapshotRef,
  type ContextSnapshotRef
} from "../context/contextSnapshot.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { ExecutionFinding } from "../execution/executionGroup.js";
import type { ReviewCheck } from "../review/reviewRound.js";
import { computeYieldOutcomeDigest } from "./yieldReceipt.js";

export const RUN_YIELD_REJECTED_EVENT = "run.yield-rejected";

const MAX_SUMMARY_CHARACTERS = 2_000;
const MAX_REPORT_CHARACTERS = 8_000;
const MAX_CHECKS = 16;
const MAX_FINDINGS = 16;
const MAX_EVIDENCE = 16;
const MAX_LABEL_CHARACTERS = 128;
const MAX_DETAILS_CHARACTERS = 512;
const MAX_EVIDENCE_CHARACTERS = 512;

export type RejectedYieldAttempt = Readonly<{
  schemaVersion: 1;
  authority: "unaccepted";
  semanticStatus: "diagnostic-only";
  taskId: string;
  runId: string;
  roleName: string;
  purpose: "review";
  reviewRoundId: string;
  receiptId: string;
  rejectionReason: string;
  summary: string;
  report: string;
  checks: readonly ReviewCheck[];
  findings: readonly ExecutionFinding[];
  evidence: readonly string[];
  evidenceCommit?: string;
  deltaDisposition?: string;
  deltaReasoning?: string;
  projectionTruncated: boolean;
  observed: Readonly<{
    nativeSessionId: string | null;
    launchId: string | null;
    durableNativeSessionId: string | null;
    durableLaunchId: string | null;
    inFlightRunId: string | null;
    inFlightReceiptId: string | null;
    activeRunId: string | null;
    activeReceiptId: string | null;
    contextSnapshot: ContextSnapshotRef | null;
    activeContextSnapshot: ContextSnapshotRef | null;
  }>;
  attemptedAt: string;
  contentDigest: string;
  attemptDigest: string;
}>;

export type CreateRejectedYieldAttemptInput = Readonly<{
  taskId: string;
  runId: string;
  roleName: string;
  reviewRoundId: string;
  receiptId: string;
  rejectionReason: string;
  summary: string;
  reviewResult?: Readonly<{
    report?: string;
    checks?: readonly ReviewCheck[];
    findings?: readonly ExecutionFinding[];
    evidence?: readonly string[];
    evidenceCommit?: string;
    gitSnapshot?: unknown;
    deltaDisposition?: string;
    deltaReasoning?: string;
  }>;
  nativeSessionId?: string;
  launchId?: string;
  durableNativeSessionId?: string;
  durableLaunchId?: string;
  inFlightRunId?: string;
  inFlightReceiptId?: string;
  contextSnapshot?: ContextSnapshotRef;
  activeRun?: Readonly<{
    id: string;
    receiptId: string;
    contextSnapshot?: ContextSnapshotRef;
  }> | null;
  attemptedAt: Date;
}>;

/**
 * Creates the bounded diagnostic projection persisted when a Reviewer report
 * cannot cross the exact terminalization fence. The full validated submission
 * participates in the immutable digest, while only known, size-bounded fields
 * are retained as non-authoritative evidence.
 */
export function createRejectedYieldAttempt(
  input: CreateRejectedYieldAttemptInput
): RejectedYieldAttempt {
  const reviewResult = input.reviewResult;
  const fullReport = reviewResult?.report ?? input.summary;
  const contentDigest = computeYieldOutcomeDigest({
    status: "yielded",
    summary: input.summary,
    ...(reviewResult === undefined ? {} : { reviewResult })
  });
  const summary = boundedText(input.summary, MAX_SUMMARY_CHARACTERS);
  const report = boundedText(fullReport, MAX_REPORT_CHARACTERS);
  const checks = (reviewResult?.checks ?? []).slice(0, MAX_CHECKS).map((check) => ({
    name: boundedText(check.name, MAX_LABEL_CHARACTERS),
    outcome: check.outcome,
    ...(check.details === undefined
      ? {}
      : { details: boundedText(check.details, MAX_DETAILS_CHARACTERS) })
  }));
  const findings = (reviewResult?.findings ?? []).slice(0, MAX_FINDINGS).map((finding) => ({
    id: boundedText(finding.id, MAX_LABEL_CHARACTERS),
    severity: finding.severity,
    status: finding.status,
    summary: boundedText(finding.summary, MAX_DETAILS_CHARACTERS)
  }));
  const evidence = (reviewResult?.evidence ?? []).slice(0, MAX_EVIDENCE)
    .map((entry) => boundedText(entry, MAX_EVIDENCE_CHARACTERS));
  const deltaReasoning = reviewResult?.deltaReasoning === undefined
    ? undefined
    : boundedText(reviewResult.deltaReasoning, MAX_DETAILS_CHARACTERS);
  const projectionTruncated = summary !== input.summary
    || report !== fullReport
    || checks.length !== (reviewResult?.checks?.length ?? 0)
    || checks.some((check, index) => (
      check.name !== reviewResult?.checks?.[index]?.name
      || check.details !== reviewResult?.checks?.[index]?.details
    ))
    || findings.length !== (reviewResult?.findings?.length ?? 0)
    || findings.some((finding, index) => (
      finding.id !== reviewResult?.findings?.[index]?.id
      || finding.summary !== reviewResult?.findings?.[index]?.summary
    ))
    || evidence.length !== (reviewResult?.evidence?.length ?? 0)
    || evidence.some((entry, index) => entry !== reviewResult?.evidence?.[index])
    || deltaReasoning !== reviewResult?.deltaReasoning
    || reviewResult?.gitSnapshot !== undefined;
  const observed = Object.freeze({
    nativeSessionId: input.nativeSessionId ?? null,
    launchId: input.launchId ?? null,
    durableNativeSessionId: input.durableNativeSessionId ?? null,
    durableLaunchId: input.durableLaunchId ?? null,
    inFlightRunId: input.inFlightRunId ?? null,
    inFlightReceiptId: input.inFlightReceiptId ?? null,
    activeRunId: input.activeRun?.id ?? null,
    activeReceiptId: input.activeRun?.receiptId ?? null,
    contextSnapshot: input.contextSnapshot ?? null,
    activeContextSnapshot: input.activeRun?.contextSnapshot ?? null
  });
  const attemptDigest = contextContentDigest({
    taskId: input.taskId,
    runId: input.runId,
    reviewRoundId: input.reviewRoundId,
    receiptId: input.receiptId,
    rejectionReason: input.rejectionReason,
    contentDigest,
    observed
  });
  return Object.freeze({
    schemaVersion: 1,
    authority: "unaccepted",
    semanticStatus: "diagnostic-only",
    taskId: input.taskId,
    runId: input.runId,
    roleName: input.roleName,
    purpose: "review",
    reviewRoundId: input.reviewRoundId,
    receiptId: input.receiptId,
    rejectionReason: input.rejectionReason,
    summary,
    report,
    checks: Object.freeze(checks),
    findings: Object.freeze(findings),
    evidence: Object.freeze(evidence),
    ...(reviewResult?.evidenceCommit === undefined
      ? {}
      : { evidenceCommit: reviewResult.evidenceCommit }),
    ...(reviewResult?.deltaDisposition === undefined
      ? {}
      : { deltaDisposition: reviewResult.deltaDisposition }),
    ...(deltaReasoning === undefined ? {} : { deltaReasoning }),
    projectionTruncated,
    observed,
    attemptedAt: input.attemptedAt.toISOString(),
    contentDigest,
    attemptDigest
  });
}

export function rejectedYieldAttemptEventPayload(
  attempt: RejectedYieldAttempt
): TaskEvent["payload"] {
  return {
    runId: attempt.runId,
    roleName: attempt.roleName,
    reviewRoundId: attempt.reviewRoundId,
    receiptId: attempt.receiptId,
    rejectionReason: attempt.rejectionReason,
    authority: attempt.authority,
    semanticStatus: attempt.semanticStatus,
    contentDigest: attempt.contentDigest,
    attemptDigest: attempt.attemptDigest,
    attempt: JSON.stringify(attempt)
  };
}

/** Reads only canonical records emitted by rejectedYieldAttemptEventPayload. */
export function rejectedYieldAttemptFromTaskEvent(
  event: TaskEvent
): RejectedYieldAttempt | null {
  if (event.type !== RUN_YIELD_REJECTED_EVENT) return null;
  try {
    const parsed: unknown = JSON.parse(event.payload.attempt ?? "");
    if (!isRejectedYieldAttempt(parsed)) return null;
    const expectedAttemptDigest = contextContentDigest({
      taskId: parsed.taskId,
      runId: parsed.runId,
      reviewRoundId: parsed.reviewRoundId,
      receiptId: parsed.receiptId,
      rejectionReason: parsed.rejectionReason,
      contentDigest: parsed.contentDigest,
      observed: parsed.observed
    });
    if (parsed.schemaVersion !== 1
      || parsed.authority !== "unaccepted"
      || parsed.semanticStatus !== "diagnostic-only"
      || parsed.purpose !== "review"
      || parsed.taskId !== event.taskId
      || parsed.runId !== event.payload.runId
      || parsed.roleName !== event.payload.roleName
      || parsed.reviewRoundId !== event.payload.reviewRoundId
      || parsed.receiptId !== event.payload.receiptId
      || parsed.rejectionReason !== event.payload.rejectionReason
      || parsed.contentDigest !== event.payload.contentDigest
      || parsed.attemptDigest !== event.payload.attemptDigest
      || parsed.attemptDigest !== expectedAttemptDigest
      || parsed.attemptedAt !== event.createdAt
      || !/^[a-f0-9]{64}$/u.test(parsed.contentDigest)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isRejectedYieldAttempt(value: unknown): value is RejectedYieldAttempt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const attempt = value as Partial<RejectedYieldAttempt>;
  const observed = attempt.observed;
  if (typeof observed !== "object" || observed === null || Array.isArray(observed)) return false;
  const nullableObserved = [
    observed.nativeSessionId,
    observed.launchId,
    observed.durableNativeSessionId,
    observed.durableLaunchId,
    observed.inFlightRunId,
    observed.inFlightReceiptId,
    observed.activeRunId,
    observed.activeReceiptId
  ];
  if (nullableObserved.some((entry) => entry !== null && typeof entry !== "string")) {
    return false;
  }
  if (observed.contextSnapshot !== null) validateContextSnapshotRef(observed.contextSnapshot);
  if (observed.activeContextSnapshot !== null) {
    validateContextSnapshotRef(observed.activeContextSnapshot);
  }
  return typeof attempt.taskId === "string"
    && typeof attempt.runId === "string"
    && typeof attempt.roleName === "string"
    && typeof attempt.reviewRoundId === "string"
    && typeof attempt.receiptId === "string"
    && typeof attempt.rejectionReason === "string"
    && typeof attempt.summary === "string"
    && typeof attempt.report === "string"
    && typeof attempt.projectionTruncated === "boolean"
    && typeof attempt.attemptedAt === "string"
    && typeof attempt.contentDigest === "string"
    && typeof attempt.attemptDigest === "string"
    && Array.isArray(attempt.checks)
    && attempt.checks.every((check) => (
      typeof check === "object" && check !== null
      && typeof check.name === "string"
      && ["passed", "failed", "skipped"].includes(check.outcome)
      && (check.details === undefined || typeof check.details === "string")
    ))
    && Array.isArray(attempt.findings)
    && attempt.findings.every((finding) => (
      typeof finding === "object" && finding !== null
      && typeof finding.id === "string"
      && typeof finding.summary === "string"
    ))
    && Array.isArray(attempt.evidence)
    && attempt.evidence.every((entry) => typeof entry === "string");
}

function boundedText(value: string, maximum: number): string {
  const safe = value
    .replaceAll(/\u001B\][^\u0007]*(?:\u0007|\u001B\\|\u009C)/gu, " ")
    .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, " ")
    .replaceAll(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu, " ");
  const characters = Array.from(safe);
  if (characters.length <= maximum) return safe;
  return `${characters.slice(0, maximum - 1).join("")}…`;
}
