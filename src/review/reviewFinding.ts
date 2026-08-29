import { createHash } from "node:crypto";
import {
  requireIdentity,
  requireText,
  requireTimestamp,
  normalizedUniqueText
} from "../domain/validation.js";
import { validateTaskRecordReference } from "../task/taskRecordReference.js";

/**
 * Issue 06: cross-Round Review finding ledger.
 *
 * A ReviewFinding is the durable, stable identity of one semantic review
 * finding across a Task's repair lineage.  Execution-attempt failures (infra)
 * never create findings; only a completed Round carrying a valid reviewer
 * report feeds the ledger.  The Leader dispositions every blocking finding
 * exactly once, and the Task completion gate fails closed on undispositioned
 * open P1/P2 findings while `review.findingLedger=enforce`.
 */

export type ReviewFindingSeverity = "p1" | "p2" | "p3";

export type ReviewFindingDisposition =
  | "open"
  | "fixed-pending-review"
  | "verified-fixed"
  | "accepted-risk"
  | "not-actionable"
  | "superseded";

/** Dispositions that still block Task completion under `enforce`. */
export const BLOCKING_FINDING_DISPOSITIONS: readonly ReviewFindingDisposition[] = [
  "open",
  "fixed-pending-review"
];

/** Dispositions a Task-control Agent may set explicitly. */
export const TASK_CONTROL_FINDING_DISPOSITIONS: readonly ReviewFindingDisposition[] = [
  "fixed-pending-review",
  "verified-fixed",
  "accepted-risk",
  "not-actionable",
  "superseded"
];

export type ReviewFindingRepair = Readonly<{
  workItemId?: string;
  commit?: string;
  verification?: string;
}>;

export type ReviewFinding = Readonly<{
  schemaVersion: 1;
  id: string;
  taskId: string;
  /** Reviewer-supplied identifier from the source report, kept for traceability. */
  sourceId?: string;
  /** Deterministic identity derived from invariant + primary path + symbol. */
  stableKey: string;
  severity: ReviewFindingSeverity;
  invariant: string;
  title: string;
  affectedPaths: readonly string[];
  affectedSymbols: readonly string[];
  evidence: readonly string[];
  firstReviewRoundId: string;
  lastReviewRoundId: string;
  disposition: ReviewFindingDisposition;
  repair?: ReviewFindingRepair;
  dispositionBy?: string;
  dispositionNote?: string;
  /** Set when a stable-key match is ambiguous; the Leader must merge explicitly. */
  mergeRequired?: boolean;
  /** When superseded, the stable key of the finding that absorbed this one. */
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}>;

/** Raw finding shape accepted from a reviewer report (all rich fields optional). */
export type ReviewFindingReportEntry = Readonly<{
  sourceId?: string;
  severity: ReviewFindingSeverity;
  status: "open" | "resolved";
  invariant?: string;
  category?: string;
  title?: string;
  summary: string;
  affectedPaths?: readonly string[];
  affectedSymbols?: readonly string[];
  evidence?: readonly string[];
}>;

/** Normalizes the severity vocabularies reviewers may use to P1/P2/P3. */
export function normalizeReviewFindingSeverity(value: unknown): ReviewFindingSeverity {
  if (typeof value !== "string") throw new Error("Review finding severity is required.");
  const normalized = value.trim().toLowerCase();
  if (normalized === "p1" || normalized === "critical" || normalized === "blocker") return "p1";
  if (normalized === "p2" || normalized === "high" || normalized === "major") return "p2";
  if (normalized === "p3"
    || normalized === "medium"
    || normalized === "moderate"
    || normalized === "low"
    || normalized === "minor"
    || normalized === "nit"
    || normalized === "info"
    || normalized === "style") {
    return "p3";
  }
  throw new Error(`Review finding severity is invalid: ${String(value)}.`);
}

/**
 * Derives the stable ledger key for one reported finding.  The key is
 * deterministic for the same invariant/path/symbol so a repeated finding in a
 * later Round updates the existing record instead of creating a duplicate.
 */
export function reviewFindingStableKey(input: Readonly<{
  invariant: string;
  primaryPath?: string;
  primarySymbol?: string;
  title: string;
}>): string {
  const invariant = input.invariant.trim().toLowerCase();
  const primaryPath = (input.primaryPath ?? "").trim().toLowerCase();
  const primarySymbol = (input.primarySymbol ?? "").trim().toLowerCase();
  const basis = [
    invariant,
    primaryPath,
    primarySymbol
  ].join("|");
  // Reports without path/symbol provenance cannot safely collapse different
  // titles under one invariant. Use the title as the fallback identity instead
  // of merging every such finding into a single ledger record.
  const material = primaryPath.length === 0 && primarySymbol.length === 0
    ? `${invariant}|${input.title.trim().toLowerCase()}`
    : basis;
  return `rf-${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

export function createReviewFinding(
  id: string,
  taskId: string,
  input: Readonly<{
    sourceId?: string;
    stableKey: string;
    severity: ReviewFindingSeverity;
    invariant: string;
    title: string;
    affectedPaths?: readonly string[];
    affectedSymbols?: readonly string[];
    evidence?: readonly string[];
    reviewRoundId: string;
  }>,
  now: Date
): ReviewFinding {
  const timestamp = now.toISOString();
  return validateReviewFinding({
    schemaVersion: 1,
    id: requireIdentity(id, "ReviewFinding id"),
    taskId: requireIdentity(taskId, "Task id"),
    ...(input.sourceId === undefined ? {} : { sourceId: requireIdentity(input.sourceId, "ReviewFinding source id") }),
    stableKey: requireIdentity(input.stableKey, "ReviewFinding stable key"),
    severity: input.severity,
    invariant: requireText(input.invariant, "ReviewFinding invariant"),
    title: requireText(input.title, "ReviewFinding title"),
    affectedPaths: normalizedUniqueText(input.affectedPaths ?? [], "ReviewFinding affected path"),
    affectedSymbols: normalizedUniqueText(input.affectedSymbols ?? [], "ReviewFinding affected symbol"),
    evidence: normalizedUniqueText(input.evidence ?? [], "ReviewFinding evidence"),
    firstReviewRoundId: requireIdentity(input.reviewRoundId, "ReviewFinding first ReviewRound"),
    lastReviewRoundId: requireIdentity(input.reviewRoundId, "ReviewFinding last ReviewRound"),
    disposition: "open",
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export type ReviewFindingDispositionInput = Readonly<{
  disposition: ReviewFindingDisposition;
  by: string;
  note?: string;
  repair?: ReviewFindingRepair;
  supersededBy?: string;
  now: Date;
}>;

/**
 * Applies one Leader disposition.  Terminal dispositions
 * (verified-fixed/accepted-risk/not-actionable/superseded) are explicit Leader
 * decisions and stay terminal; `fixed-pending-review` may still regress to
 * `open` when a later Round reproduces the finding.
 */
export function disposeReviewFinding(
  finding: ReviewFinding,
  input: ReviewFindingDispositionInput
): ReviewFinding {
  validateReviewFinding(finding);
  if (!TASK_CONTROL_FINDING_DISPOSITIONS.includes(input.disposition)) {
    throw new Error(`ReviewFinding disposition is not a Leader decision: ${input.disposition}.`);
  }
  if (finding.disposition !== "open" && finding.disposition !== "fixed-pending-review") {
    throw new Error(
      `ReviewFinding ${finding.id} is already terminal: ${finding.disposition}.`
    );
  }
  if (input.disposition === "superseded" && input.supersededBy === undefined) {
    throw new Error(`ReviewFinding ${finding.id} supersession requires a successor stable key.`);
  }
  const repair = input.repair === undefined
    ? finding.repair
    : validateReviewFindingRepair(input.repair);
  return validateReviewFinding({
    ...finding,
    disposition: input.disposition,
    ...(repair === undefined ? {} : { repair }),
    dispositionBy: requireIdentity(input.by, "ReviewFinding disposition actor"),
    ...(input.note === undefined ? {} : { dispositionNote: requireText(input.note, "ReviewFinding disposition note") }),
    ...(input.supersededBy === undefined ? {} : { supersededBy: requireIdentity(input.supersededBy, "ReviewFinding successor stable key") }),
    mergeRequired: false,
    updatedAt: input.now.toISOString()
  });
}

/**
 * Reconciles a re-detection of this finding in a later Round.  A regression
 * reopens a `fixed-pending-review` finding; a `verified-fixed` finding that
 * reproduces also reopens (the fix did not hold).  Explicit Leader decisions
 * (accepted-risk/not-actionable/superseded) stay terminal but still get their
 * evidence and last-Round pointer refreshed.
 */
export function redetectReviewFinding(
  finding: ReviewFinding,
  input: Readonly<{
    reviewRoundId: string;
    evidence?: readonly string[];
    now: Date;
  }>
): ReviewFinding {
  validateReviewFinding(finding);
  const evidence = normalizedUniqueText(
    [...finding.evidence, ...(input.evidence ?? [])],
    "ReviewFinding evidence"
  );
  const reopen = finding.disposition === "fixed-pending-review"
    || finding.disposition === "verified-fixed";
  return validateReviewFinding({
    ...finding,
    lastReviewRoundId: requireIdentity(input.reviewRoundId, "ReviewFinding last ReviewRound"),
    evidence,
    ...(reopen ? { disposition: "open" as const, repair: undefined } : {}),
    ...(reopen ? { mergeRequired: finding.mergeRequired } : {}),
    updatedAt: input.now.toISOString()
  });
}

/** Refreshes last-Round/evidence for a terminal finding without reopening it. */
export function touchReviewFinding(
  finding: ReviewFinding,
  input: Readonly<{
    reviewRoundId: string;
    evidence?: readonly string[];
    now: Date;
  }>
): ReviewFinding {
  validateReviewFinding(finding);
  const evidence = normalizedUniqueText(
    [...finding.evidence, ...(input.evidence ?? [])],
    "ReviewFinding evidence"
  );
  if (finding.lastReviewRoundId === input.reviewRoundId
    && evidence.length === finding.evidence.length) {
    return finding;
  }
  return validateReviewFinding({
    ...finding,
    lastReviewRoundId: requireIdentity(input.reviewRoundId, "ReviewFinding last ReviewRound"),
    evidence,
    updatedAt: input.now.toISOString()
  });
}

/**
 * Issue 06: a Reviewer reports a previously-open finding as resolved in a
 * later semantic Round.  The claim is only accepted when the ledger already
 * has repair refs; otherwise the old finding remains open (a changed candidate
 * without repair evidence must not advance disposition).  With repair refs,
 * this transitions `open` to `fixed-pending-review` (the fix claim is recorded
 * but the Leader still owns the final disposition) and refreshes
 * evidence/last-Round for `fixed-pending-review`.  Explicit Leader decisions
 * (accepted-risk/not-actionable/superseded) and `verified-fixed` are untouched.
 */
export function resolveReviewFinding(
  finding: ReviewFinding,
  input: Readonly<{
    reviewRoundId: string;
    evidence?: readonly string[];
    now: Date;
  }>
): ReviewFinding {
  validateReviewFinding(finding);
  const evidence = normalizedUniqueText(
    [...finding.evidence, ...(input.evidence ?? [])],
    "ReviewFinding evidence"
  );
  const transition = finding.disposition === "open" && finding.repair !== undefined;
  if (!transition
    && finding.lastReviewRoundId === input.reviewRoundId
    && evidence.length === finding.evidence.length) {
    return finding;
  }
  return validateReviewFinding({
    ...finding,
    lastReviewRoundId: requireIdentity(input.reviewRoundId, "ReviewFinding last ReviewRound"),
    evidence,
    ...(transition ? { disposition: "fixed-pending-review" as const } : {}),
    updatedAt: input.now.toISOString()
  });
}

export function isReviewFindingBlocking(finding: ReviewFinding): boolean {
  return BLOCKING_FINDING_DISPOSITIONS.includes(finding.disposition)
    && (finding.severity === "p1" || finding.severity === "p2");
}

export function validateReviewFinding(finding: ReviewFinding): ReviewFinding {
  if (finding.schemaVersion !== 1) {
    throw new Error("ReviewFinding must use schemaVersion 1.");
  }
  validateTaskRecordReference({ taskId: finding.taskId, localId: finding.id }, "reviewFinding");
  requireIdentity(finding.stableKey, "ReviewFinding stable key");
  if (finding.severity !== "p1" && finding.severity !== "p2" && finding.severity !== "p3") {
    throw new Error(`ReviewFinding severity is invalid: ${String(finding.severity)}.`);
  }
  requireText(finding.invariant, "ReviewFinding invariant");
  requireText(finding.title, "ReviewFinding title");
  normalizedUniqueText(finding.affectedPaths, "ReviewFinding affected path");
  normalizedUniqueText(finding.affectedSymbols, "ReviewFinding affected symbol");
  normalizedUniqueText(finding.evidence, "ReviewFinding evidence");
  validateTaskRecordReference(
    { taskId: finding.taskId, localId: finding.firstReviewRoundId },
    "reviewRound"
  );
  validateTaskRecordReference(
    { taskId: finding.taskId, localId: finding.lastReviewRoundId },
    "reviewRound"
  );
  if (![
    "open",
    "fixed-pending-review",
    "verified-fixed",
    "accepted-risk",
    "not-actionable",
    "superseded"
  ].includes(finding.disposition)) {
    throw new Error(`ReviewFinding disposition is invalid: ${String(finding.disposition)}.`);
  }
  if (finding.repair !== undefined) validateReviewFindingRepair(finding.repair);
  if (finding.dispositionBy !== undefined) {
    requireIdentity(finding.dispositionBy, "ReviewFinding disposition actor");
  }
  if (finding.dispositionNote !== undefined) {
    requireText(finding.dispositionNote, "ReviewFinding disposition note");
  }
  if (finding.supersededBy !== undefined) {
    requireIdentity(finding.supersededBy, "ReviewFinding successor stable key");
    if (finding.disposition !== "superseded") {
      throw new Error(`ReviewFinding ${finding.id} carries a successor but is not superseded.`);
    }
  }
  if (finding.disposition === "superseded" && finding.supersededBy === undefined) {
    throw new Error(`ReviewFinding ${finding.id} is superseded without a successor.`);
  }
  requireTimestamp(finding.createdAt, "ReviewFinding createdAt");
  requireTimestamp(finding.updatedAt, "ReviewFinding updatedAt");
  return finding;
}

function validateReviewFindingRepair(repair: ReviewFindingRepair): ReviewFindingRepair {
  if (repair.workItemId !== undefined) {
    requireIdentity(repair.workItemId, "ReviewFinding repair WorkItem");
  }
  if (repair.commit !== undefined) {
    const commit = requireText(repair.commit, "ReviewFinding repair commit").toLowerCase();
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) {
      throw new Error("ReviewFinding repair commit is invalid.");
    }
  }
  if (repair.verification !== undefined) {
    requireText(repair.verification, "ReviewFinding repair verification");
  }
  return repair;
}
