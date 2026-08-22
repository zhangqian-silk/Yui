import { createHash } from "node:crypto";
import { createTaskEvent, type TaskEvent } from "../event/taskEvent.js";
import type { YuiConfig } from "../storage/taskStore.js";
import { isSemanticReviewRound } from "./reviewOutcomeClassifier.js";
import {
  createReviewFinding,
  disposeReviewFinding,
  isReviewFindingBlocking,
  normalizeReviewFindingSeverity,
  redetectReviewFinding,
  resolveReviewFinding,
  reviewFindingStableKey,
  touchReviewFinding,
  validateReviewFinding,
  type ReviewFinding,
  type ReviewFindingDisposition,
  type ReviewFindingReportEntry,
  type ReviewFindingSeverity
} from "./reviewFinding.js";
import type { ReviewCheck, ReviewRound, TaskReviewCandidate } from "./reviewRound.js";

/**
 * Issue 06: cross-Round Review finding ledger operations.
 *
 * The ledger is derived only from completed (semantic) ReviewRounds.  Failed
 * execution attempts never reach it.  In `shadow` mode the ledger records
 * findings and serves Leader commands, but the Task completion gate keeps the
 * legacy behavior; `enforce` mode additionally fails completion closed on
 * undispositioned open P1/P2 findings.
 */

export type ReviewFindingLedgerMode = "shadow" | "enforce";

/** Resolves the durable feature flag; absent config defaults to shadow. */
export function reviewFindingLedgerMode(config: YuiConfig): ReviewFindingLedgerMode {
  const mode = config.review?.findingLedger;
  return mode === "enforce" ? "enforce" : "shadow";
}

/** Minimal store port satisfied structurally by TaskStore and its adapters. */
export type ReviewFindingStorePort = Readonly<{
  getConfig(): YuiConfig;
  getReviewRound(taskId: string, reviewRoundId: string): ReviewRound | null;
  listReviewRounds(taskId: string): ReviewRound[];
  nextReviewFindingId(taskId: string): string;
  getReviewFinding(taskId: string, findingId: string): ReviewFinding | null;
  listReviewFindings(taskId: string): ReviewFinding[];
  saveReviewFinding(taskId: string, finding: ReviewFinding): void;
  nextEventId(taskId: string): string;
  saveEvent(taskId: string, event: TaskEvent): void;
  listEvents(taskId: string): TaskEvent[];
}>;

export const REVIEW_FINDINGS_RECONCILE_FAILED_EVENT = "review.findings-reconcile-failed";

export type ExtractedReviewFinding = Readonly<{
  sourceId?: string;
  severity: ReviewFindingSeverity;
  status: "open" | "resolved";
  invariant: string;
  title: string;
  affectedPaths: readonly string[];
  affectedSymbols: readonly string[];
  evidence: readonly string[];
}>;

export type ReconcileFindingsResult = Readonly<{
  roundId: string;
  skipped: boolean;
  reason?: string;
  created: readonly ReviewFinding[];
  updated: readonly ReviewFinding[];
  conflicts: readonly ReviewFinding[];
}>;

/**
 * Extracts reported findings from a completed Round.  The reviewer's JSON
 * report is the authoritative source; panel Rounds fall back to the findings
 * attached to their ExecutionGroup lane results.  A malformed or free-text
 * report yields no findings (the raw report stays authoritative evidence).
 */
export function extractReportedFindings(round: ReviewRound): readonly ExtractedReviewFinding[] {
  const fromReport = extractFindingsFromReportJson(round.report ?? "");
  if (fromReport.length > 0) return fromReport;
  return extractFindingsFromLanes(round);
}

function extractFindingsFromReportJson(report: string): readonly ExtractedReviewFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(report) as unknown;
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.findings)) return [];
  return record.findings.flatMap((entry): ExtractedReviewFinding[] => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const finding = entry as Record<string, unknown>;
    const summary = typeof finding.summary === "string" && finding.summary.trim().length > 0
      ? finding.summary.trim()
      : typeof finding.title === "string" && finding.title.trim().length > 0
        ? finding.title.trim()
        : null;
    if (summary === null) return [];
    let severity: ReviewFindingSeverity;
    try {
      severity = normalizeReviewFindingSeverity(finding.severity);
    } catch {
      return [];
    }
    const status = finding.status === "resolved" ? "resolved" : "open";
    const title = typeof finding.title === "string" && finding.title.trim().length > 0
      ? finding.title.trim()
      : summary;
    const invariant = typeof finding.invariant === "string" && finding.invariant.trim().length > 0
      ? finding.invariant.trim()
      : typeof finding.category === "string" && finding.category.trim().length > 0
        ? finding.category.trim()
        : "review-finding";
    return [{
      ...(typeof finding.id === "string" && finding.id.trim().length > 0
        ? { sourceId: finding.id.trim() }
        : {}),
      severity,
      status,
      invariant,
      title,
      affectedPaths: stringList(finding.paths ?? finding.affectedPaths),
      affectedSymbols: stringList(finding.symbols ?? finding.affectedSymbols),
      evidence: stringList(finding.evidence)
    }];
  });
}

function extractFindingsFromLanes(round: ReviewRound): readonly ExtractedReviewFinding[] {
  const lanes = round.executionGroup?.lanes ?? [];
  return lanes.flatMap((lane) => {
    const findings = lane.result?.findings ?? [];
    return findings.flatMap((finding): ExtractedReviewFinding[] => {
      let severity: ReviewFindingSeverity;
      try {
        severity = normalizeReviewFindingSeverity(finding.severity);
      } catch {
        return [];
      }
      return [{
        sourceId: finding.id,
        severity,
        status: finding.status === "resolved" ? "resolved" : "open",
        invariant: "review-finding",
        title: finding.summary,
        affectedPaths: [],
        affectedSymbols: [],
        evidence: []
      }];
    });
  });
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

/**
 * Reconciles one completed Round's findings into the Task ledger.  Stable-key
 * matches update the existing record; ambiguous matches (multiple records with
 * the same key) create a `mergeRequired` record instead of silently merging.
 * Infra (failed) Rounds are skipped without touching the ledger.
 */
export function reconcileReviewFindings(
  store: ReviewFindingStorePort,
  taskId: string,
  roundId: string,
  now: Date
): ReconcileFindingsResult {
  const round = store.getReviewRound(taskId, roundId);
  if (round === null) {
    return { roundId, skipped: true, reason: "ReviewRound not found.", created: [], updated: [], conflicts: [] };
  }
  if (!isSemanticReviewRound(round)) {
    return {
      roundId,
      skipped: true,
      reason: "ReviewRound is an execution-attempt failure, not a semantic report.",
      created: [],
      updated: [],
      conflicts: []
    };
  }
  const extracted = extractReportedFindings(round);
  if (extracted.length === 0) {
    return { roundId, skipped: true, reason: "ReviewRound report carries no findings.", created: [], updated: [], conflicts: [] };
  }
  const ledger = store.listReviewFindings(taskId);
  const created: ReviewFinding[] = [];
  const updated: ReviewFinding[] = [];
  const conflicts: ReviewFinding[] = [];
  for (const entry of extracted) {
    const stableKey = reviewFindingStableKey({
      invariant: entry.invariant,
      primaryPath: entry.affectedPaths[0],
      primarySymbol: entry.affectedSymbols[0],
      title: entry.title
    });
    const matches = ledger.filter((finding) => finding.stableKey === stableKey);
    if (matches.length === 1) {
      const existing = matches[0]!;
      const next = entry.status === "resolved"
        ? resolveReviewFinding(existing, {
          reviewRoundId: round.id,
          evidence: entry.evidence,
          now
        })
        : existing.disposition === "accepted-risk"
          || existing.disposition === "not-actionable"
          || existing.disposition === "superseded"
          ? touchReviewFinding(existing, {
            reviewRoundId: round.id,
            evidence: entry.evidence,
            now
          })
          : redetectReviewFinding(existing, {
            reviewRoundId: round.id,
            evidence: entry.evidence,
            now
          });
      if (next !== existing) {
        store.saveReviewFinding(taskId, next);
        updated.push(next);
      }
      continue;
    }
    if (matches.length > 1) {
      // Stable-key collision: keep every evidence trail and require an explicit
      // Leader merge instead of silently overwriting either record.
      const existingConflict = matches.find((finding) => finding.mergeRequired === true);
      if (existingConflict !== undefined) {
        // A merge-required record already exists for this stable key; refresh
        // its evidence and last-Round pointer instead of creating unbounded
        // duplicate conflict records.
        const refreshed = touchReviewFinding(existingConflict, {
          reviewRoundId: round.id,
          evidence: entry.evidence,
          now
        });
        if (refreshed !== existingConflict) {
          store.saveReviewFinding(taskId, refreshed);
          updated.push(refreshed);
        }
        continue;
      }
      const conflict = createReviewFinding(
        store.nextReviewFindingId(taskId),
        taskId,
        {
          ...(entry.sourceId === undefined ? {} : { sourceId: entry.sourceId }),
          stableKey,
          severity: entry.severity,
          invariant: entry.invariant,
          title: entry.title,
          affectedPaths: entry.affectedPaths,
          affectedSymbols: entry.affectedSymbols,
          evidence: entry.evidence,
          reviewRoundId: round.id
        },
        now
      );
      const flagged = validateReviewFinding({ ...conflict, mergeRequired: true });
      store.saveReviewFinding(taskId, flagged);
      conflicts.push(flagged);
      continue;
    }
    const createdFinding = createReviewFinding(
      store.nextReviewFindingId(taskId),
      taskId,
      {
        ...(entry.sourceId === undefined ? {} : { sourceId: entry.sourceId }),
        stableKey,
        severity: entry.severity,
        invariant: entry.invariant,
        title: entry.title,
        affectedPaths: entry.affectedPaths,
        affectedSymbols: entry.affectedSymbols,
        evidence: entry.evidence,
        reviewRoundId: round.id
      },
      now
    );
    store.saveReviewFinding(taskId, createdFinding);
    created.push(createdFinding);
  }
  store.saveEvent(taskId, createTaskEvent(
    store.nextEventId(taskId),
    taskId,
    "review.findings-reconciled",
    {
      reviewRoundId: round.id,
      created: String(created.length),
      updated: String(updated.length),
      conflicts: String(conflicts.length)
    },
    now
  ));
  return { roundId, skipped: false, created, updated, conflicts };
}

/**
 * Reconciles a delivered Review without making ledger availability a
 * precondition for preserving the reviewer's free-form report. A ledger
 * read/write failure is recorded as a Task event; `enforce` completion fails
 * closed until the Leader recovers the ledger.
 */
export function reconcileReviewFindingsAfterReview(
  store: ReviewFindingStorePort,
  taskId: string,
  roundId: string,
  now: Date
): ReconcileFindingsResult {
  try {
    return reconcileReviewFindings(store, taskId, roundId, now);
  } catch (error) {
    const reason = `Review finding ledger is unavailable: ${error instanceof Error ? error.message : String(error)}`;
    store.saveEvent(taskId, createTaskEvent(
      store.nextEventId(taskId),
      taskId,
      REVIEW_FINDINGS_RECONCILE_FAILED_EVENT,
      { reviewRoundId: roundId, reason },
      now
    ));
    return {
      roundId,
      skipped: true,
      reason,
      created: [],
      updated: [],
      conflicts: []
    };
  }
}

/** True when a semantic Review could not be reconciled into the ledger. */
export function reviewFindingLedgerWriteFailed(
  store: ReviewFindingStorePort,
  taskId: string
): boolean {
  return reviewFindingLedgerWriteFailedFromEvents(store.listEvents(taskId));
}

/** Pure event-fold variant of {@link reviewFindingLedgerWriteFailed}. */
export function reviewFindingLedgerWriteFailedFromEvents(
  events: readonly TaskEvent[]
): boolean {
  const latestByRound = new Map<string, TaskEvent>();
  for (const event of events) {
    if (event.type !== REVIEW_FINDINGS_RECONCILE_FAILED_EVENT
      && event.type !== "review.findings-reconciled") {
      continue;
    }
    const reviewRoundId = event.payload.reviewRoundId;
    if (reviewRoundId !== undefined) latestByRound.set(reviewRoundId, event);
  }
  return [...latestByRound.values()]
    .some((event) => event.type === REVIEW_FINDINGS_RECONCILE_FAILED_EVENT);
}

export type ReviewFindingDispositionCommand = Readonly<{
  disposition: ReviewFindingDisposition;
  by: string;
  note?: string;
  workItemId?: string;
  commit?: string;
  verification?: string;
  supersededBy?: string;
  now: Date;
}>;

/** Applies one explicit Leader disposition to a finding. */
export function dispositionReviewFinding(
  store: ReviewFindingStorePort,
  taskId: string,
  findingId: string,
  command: ReviewFindingDispositionCommand
): ReviewFinding {
  const existing = store.getReviewFinding(taskId, findingId);
  if (existing === null) {
    throw new Error(`ReviewFinding not found: ${taskId}/${findingId}.`);
  }
  const next = disposeReviewFinding(existing, {
    disposition: command.disposition,
    by: command.by,
    ...(command.note === undefined ? {} : { note: command.note }),
    ...(command.workItemId === undefined
      && command.commit === undefined
      && command.verification === undefined
      ? {}
      : {
        repair: {
          ...(command.workItemId === undefined ? {} : { workItemId: command.workItemId }),
          ...(command.commit === undefined ? {} : { commit: command.commit }),
          ...(command.verification === undefined ? {} : { verification: command.verification })
        }
      }),
    ...(command.supersededBy === undefined ? {} : { supersededBy: command.supersededBy }),
    now: command.now
  });
  store.saveReviewFinding(taskId, next);
  store.saveEvent(taskId, createTaskEvent(
    store.nextEventId(taskId),
    taskId,
    "review.finding-dispositioned",
    {
      reviewFindingId: next.id,
      disposition: next.disposition,
      by: command.by
    },
    command.now
  ));
  return next;
}

export type RepairGroup = Readonly<{
  groupKey: string;
  findings: readonly ReviewFinding[];
  findingIds: readonly string[];
  affectedPaths: readonly string[];
  affectedSymbols: readonly string[];
  invariants: readonly string[];
}>;

/**
 * Groups open P1/P2 findings into repair waves by file/symbol/invariant
 * overlap.  Findings sharing an affected path, symbol, or invariant land in
 * the same group (union-find), so one WorkItem repairs one overlapping set
 * while disjoint groups can run in parallel.
 */
export function planRepairGroups(store: ReviewFindingStorePort, taskId: string): readonly RepairGroup[] {
  const open = store.listReviewFindings(taskId)
    .filter((finding) => finding.disposition === "open"
      && (finding.severity === "p1" || finding.severity === "p2"))
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
  const parent = new Map<string, string>(open.map((finding) => [finding.id, finding.id]));
  const root = (id: string): string => {
    let current = id;
    while (parent.get(current) !== current) {
      current = parent.get(current)!;
    }
    let cursor = id;
    while (parent.get(cursor) !== cursor) {
      const next = parent.get(cursor)!;
      parent.set(cursor, current);
      cursor = next;
    }
    return current;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  const byPath = new Map<string, string>();
  const bySymbol = new Map<string, string>();
  const byInvariant = new Map<string, string>();
  for (const finding of open) {
    for (const path of finding.affectedPaths) {
      const seen = byPath.get(path);
      if (seen === undefined) byPath.set(path, finding.id);
      else union(seen, finding.id);
    }
    for (const symbol of finding.affectedSymbols) {
      const seen = bySymbol.get(symbol);
      if (seen === undefined) bySymbol.set(symbol, finding.id);
      else union(seen, finding.id);
    }
    // Issue 06: only union on a real invariant.  Findings that lack an
    // explicit invariant/category all share the fallback "review-finding"
    // label; unioning on it would collapse sparse reports into one group and
    // defeat parallel repair.
    if (finding.invariant !== "review-finding") {
      const seen = byInvariant.get(finding.invariant);
      if (seen === undefined) byInvariant.set(finding.invariant, finding.id);
      else union(seen, finding.id);
    }
  }
  const groups = new Map<string, ReviewFinding[]>();
  for (const finding of open) {
    const key = root(finding.id);
    const members = groups.get(key) ?? [];
    members.push(finding);
    groups.set(key, members);
  }
  return [...groups.values()]
    .map((findings) => ({
      groupKey: findings.map(({ id }) => id).join("+"),
      findings,
      findingIds: findings.map(({ id }) => id),
      affectedPaths: [...new Set(findings.flatMap(({ affectedPaths }) => affectedPaths))].sort(),
      affectedSymbols: [...new Set(findings.flatMap(({ affectedSymbols }) => affectedSymbols))].sort(),
      invariants: [...new Set(findings.map(({ invariant }) => invariant))].sort()
    }))
    .sort((left, right) => left.groupKey.localeCompare(right.groupKey, undefined, { numeric: true }));
}

/**
 * Completion gate: open (or repair-pending) P1/P2 findings block Task
 * completion under `enforce`.  P3/backlog findings never block.
 */
export function blockingOpenFindings(
  store: ReviewFindingStorePort,
  taskId: string
): readonly ReviewFinding[] {
  return store.listReviewFindings(taskId)
    .filter(isReviewFindingBlocking)
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
}

/** True when the completion gate must fail closed for this Task. */
export function completionGateBlocked(
  store: ReviewFindingStorePort,
  taskId: string
): boolean {
  if (reviewFindingLedgerMode(store.getConfig()) !== "enforce") return false;
  return reviewFindingLedgerWriteFailed(store, taskId)
    || blockingOpenFindings(store, taskId).length > 0;
}

export type FindingLedgerSummary = Readonly<{
  total: number;
  open: readonly ReviewFinding[];
  fixedPendingReview: readonly ReviewFinding[];
  verifiedFixed: readonly ReviewFinding[];
  acceptedRisk: readonly ReviewFinding[];
  notActionable: readonly ReviewFinding[];
  superseded: readonly ReviewFinding[];
  blocking: readonly ReviewFinding[];
  mergeRequired: readonly ReviewFinding[];
}>;

export function summarizeFindingLedger(
  store: ReviewFindingStorePort,
  taskId: string
): FindingLedgerSummary {
  const findings = store.listReviewFindings(taskId)
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
  const byDisposition = (disposition: ReviewFindingDisposition): ReviewFinding[] =>
    findings.filter((finding) => finding.disposition === disposition);
  return {
    total: findings.length,
    open: byDisposition("open"),
    fixedPendingReview: byDisposition("fixed-pending-review"),
    verifiedFixed: byDisposition("verified-fixed"),
    acceptedRisk: byDisposition("accepted-risk"),
    notActionable: byDisposition("not-actionable"),
    superseded: byDisposition("superseded"),
    blocking: findings.filter(isReviewFindingBlocking),
    mergeRequired: findings.filter((finding) => finding.mergeRequired === true)
  };
}

/**
 * Renders the ledger summary as the incremental Review context block: it
 * replaces repeated full-history restatement while still listing every
 * disposition class the final report must account for.
 */
export function renderFindingLedgerContext(summary: FindingLedgerSummary): string {
  const lines: string[] = ["Finding ledger:"];
  lines.push(`- total: ${summary.total}`);
  const renderList = (label: string, findings: readonly ReviewFinding[]): void => {
    if (findings.length === 0) return;
    lines.push(`- ${label}:`);
    for (const finding of findings) {
      lines.push(`  - ${finding.id} [${finding.severity}] ${finding.title}`
        + ` (invariant: ${finding.invariant}; first: ${finding.firstReviewRoundId}; last: ${finding.lastReviewRoundId})`);
      if (finding.repair !== undefined) {
        const repairParts = [
          finding.repair.workItemId === undefined ? "" : `work-item=${finding.repair.workItemId}`,
          finding.repair.commit === undefined ? "" : `commit=${finding.repair.commit}`,
          finding.repair.verification === undefined ? "" : `verification=${finding.repair.verification}`
        ].filter((part) => part.length > 0);
        if (repairParts.length > 0) lines.push(`    repair: ${repairParts.join("; ")}`);
      }
    }
  };
  renderList("verified-fixed", summary.verifiedFixed);
  renderList("open (new/repair pending)", summary.open);
  renderList("fixed-pending-review", summary.fixedPendingReview);
  renderList("accepted-risk", summary.acceptedRisk);
  renderList("not-actionable (backlog)", summary.notActionable);
  renderList("superseded", summary.superseded);
  if (summary.mergeRequired.length > 0) {
    lines.push(`- merge-required: ${summary.mergeRequired.map(({ id }) => id).join(", ")}`);
  }
  if (summary.blocking.length > 0) {
    lines.push(`- residual blocking P1/P2: ${summary.blocking.map(({ id }) => id).join(", ")}`);
  } else {
    lines.push("- residual blocking P1/P2: none");
  }
  return lines.join("\n");
}

export type ReusableReviewEvidence = Readonly<{
  reviewRoundId: string;
  evidenceCommit: string;
  digest: string;
  checks: readonly ReviewCheck[];
}>;

/**
 * Fallback gate-evidence reuse (Issue 08 artifacts are optional): a completed
 * Task-final Round whose evidence commit exactly matches the candidate's
 * primary head may donate its checks by digest.  A changed head returns null,
 * so an old GREEN can never be reused against a different tree.
 */
export function reusableTaskReviewEvidence(
  store: ReviewFindingStorePort,
  taskId: string,
  candidate: TaskReviewCandidate
): ReusableReviewEvidence | null {
  const rounds = store.listReviewRounds(taskId)
    .filter((round) => (round.scope ?? "work-item") === "task"
      && round.status === "completed"
      && round.evidenceCommit !== undefined
      && isSameTaskReviewCandidate(round.taskCandidate, candidate))
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
  const latest = rounds.at(-1);
  if (latest === undefined || latest.evidenceCommit === undefined) return null;
  const checks = latest.checks ?? [];
  if (checks.length === 0 || checks.some((check) => check.outcome !== "passed")) return null;
  const digest = createHash("sha256")
    .update(JSON.stringify(checks))
    .digest("hex");
  return {
    reviewRoundId: latest.id,
    evidenceCommit: latest.evidenceCommit,
    digest,
    checks
  };
}

export type TaskFinalReviewFindingContext = Readonly<{
  context: string;
  previousSemanticRound: ReviewRound | null;
  reusableEvidence: ReusableReviewEvidence | null;
}>;

/**
 * Builds the Issue 06 incremental Review context. The Reviewer receives the
 * cross-Round ledger, exact old/new frozen heads, repair evidence, and any
 * reusable exact-head checks. A changed head or failed/absent checks returns
 * no reusable evidence, so an old GREEN can never be borrowed for a new tree.
 */
export function buildTaskFinalReviewFindingContext(
  store: ReviewFindingStorePort,
  taskId: string,
  candidate: TaskReviewCandidate
): TaskFinalReviewFindingContext {
  const previousSemanticRound = store.listReviewRounds(taskId)
    .filter((round) => (round.scope ?? "work-item") === "task" && round.status === "completed")
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
    .at(-1) ?? null;
  const reusableEvidence = reusableTaskReviewEvidence(store, taskId, candidate);
  // dbonly: the finding ledger is SQLite-native.  A file-only Home (no yui.db)
  // cannot serve findings; the Review dispatch must still proceed, so the
  // ledger context degrades to an explicit "unavailable" note.
  let ledgerContext: string;
  try {
    ledgerContext = renderFindingLedgerContext(summarizeFindingLedger(store, taskId));
  } catch {
    ledgerContext = "Finding ledger: unavailable (SQLite backend required; run `yui update` to migrate this Home).";
  }
  const lines = [
    "Review convergence context:",
    ledgerContext,
    ...(previousSemanticRound === null
      ? ["Previous semantic Task-final ReviewRound: none."]
      : [
          `Previous semantic Task-final ReviewRound: ${previousSemanticRound.id}`,
          ...candidate.projects.map((project) => {
            const previous = previousSemanticRound.taskCandidate?.projects
              .find((entry) => entry.projectId === project.projectId)?.commit;
            return previous === undefined
              ? `Exact review boundary for ${project.projectId}: new head ${project.commit}`
              : previous === project.commit
                ? `Exact review boundary for ${project.projectId}: unchanged at ${project.commit}`
                : `Exact diff for ${project.projectId}: ${previous}..${project.commit}`;
          })
        ]),
    ...(reusableEvidence === null
      ? [
          "Reusable gate evidence: none (head changed, checks are absent, or a check did not pass); rerun the checks needed for this exact tree."
        ]
      : [
          `Reusable gate evidence: ${reusableEvidence.reviewRoundId}@${reusableEvidence.evidenceCommit}`,
          `Reusable check digest: ${reusableEvidence.digest}`,
          `Reusable checks: ${reusableEvidence.checks.map(({ name, outcome }) => `${name}=${outcome}`).join(", ")}`
        ]),
    "Reuse each listed ledger finding id when it is still valid; explain why a new finding is not already covered by the ledger.",
    "Your final report must clearly list verified-fixed findings, new findings, accepted risks, and residual verification gaps."
  ];
  return {
    context: lines.join("\n"),
    previousSemanticRound,
    reusableEvidence
  };
}

function isSameTaskReviewCandidate(
  left: TaskReviewCandidate | undefined,
  right: TaskReviewCandidate
): boolean {
  return left !== undefined
    && left.projects.length === right.projects.length
    && left.projects.every((project, index) => (
      project.projectId === right.projects[index]?.projectId
      && project.commit === right.projects[index]?.commit
    ));
}
