import { requireIdentity } from "../domain/validation.js";

export const REVIEW_TRIGGERS = ["always", "leader", "final"] as const;
export type ReviewTrigger = typeof REVIEW_TRIGGERS[number];

/**
 * Issue 06 feature flag. `shadow` records the finding ledger and serves Leader
 * commands without changing completion behavior; `enforce` additionally fails
 * Task completion closed on undispositioned open P1/P2 findings.
 */
export const REVIEW_FINDING_LEDGER_MODES = ["shadow", "enforce"] as const;
export type ReviewFindingLedgerMode = typeof REVIEW_FINDING_LEDGER_MODES[number];

/** Issue 07: delta-recheck is opt-in per Project review policy. */
export const REVIEW_DELTA_RECHECK_MODES = ["enabled", "disabled"] as const;
export type ReviewDeltaRecheckMode = typeof REVIEW_DELTA_RECHECK_MODES[number];

/** Issue 07: conservative defaults for whether a delta attempt is allowed. */
export const DEFAULT_DELTA_RECHECK_MAX_CHANGED_LINES = 200;
export const DEFAULT_DELTA_RECHECK_MAX_CHANGED_FILES = 5;

/** The Reviewer Role seeded in a new Home by `yui setup`. */
export const DEFAULT_REVIEWER_ROLE = "reviewer";

export type ReviewConfig = Readonly<{
  roleName: string;
  trigger: ReviewTrigger;
  findingLedger?: ReviewFindingLedgerMode;
  /** Issue 07: when `enabled`, `task review request --delta-recheck` is allowed. */
  deltaRecheck?: ReviewDeltaRecheckMode;
  /** Issue 07: max added+deleted lines that still allow a delta attempt. */
  deltaRecheckMaxChangedLines?: number;
  /** Issue 07: max changed files that still allow a delta attempt. */
  deltaRecheckMaxChangedFiles?: number;
}>;

export function validateReviewConfig(config: ReviewConfig): ReviewConfig {
  requireIdentity(config.roleName, "Review Role");
  if (!REVIEW_TRIGGERS.includes(config.trigger)) {
    throw new Error(`Review trigger is invalid: ${String(config.trigger)}.`);
  }
  if (config.findingLedger !== undefined
    && !REVIEW_FINDING_LEDGER_MODES.includes(config.findingLedger)) {
    throw new Error(`Review finding ledger mode is invalid: ${String(config.findingLedger)}.`);
  }
  if (config.deltaRecheck !== undefined
    && !REVIEW_DELTA_RECHECK_MODES.includes(config.deltaRecheck)) {
    throw new Error(`Review delta-recheck mode is invalid: ${String(config.deltaRecheck)}.`);
  }
  if (config.deltaRecheckMaxChangedLines !== undefined
    && (!Number.isInteger(config.deltaRecheckMaxChangedLines)
      || config.deltaRecheckMaxChangedLines < 1)) {
    throw new Error("Review delta-recheck max changed lines must be a positive integer.");
  }
  if (config.deltaRecheckMaxChangedFiles !== undefined
    && (!Number.isInteger(config.deltaRecheckMaxChangedFiles)
      || config.deltaRecheckMaxChangedFiles < 1)) {
    throw new Error("Review delta-recheck max changed files must be a positive integer.");
  }
  return config;
}

/** Issue 07: resolves the delta-recheck policy; absent config defaults to disabled. */
export function deltaRecheckEnabled(config: ReviewConfig | null | undefined): boolean {
  return config?.deltaRecheck === "enabled";
}

/** Issue 07: resolves the line threshold with its conservative default. */
export function deltaRecheckMaxChangedLines(config: ReviewConfig | null | undefined): number {
  return config?.deltaRecheckMaxChangedLines ?? DEFAULT_DELTA_RECHECK_MAX_CHANGED_LINES;
}

/** Issue 07: resolves the file threshold with its conservative default. */
export function deltaRecheckMaxChangedFiles(config: ReviewConfig | null | undefined): number {
  return config?.deltaRecheckMaxChangedFiles ?? DEFAULT_DELTA_RECHECK_MAX_CHANGED_FILES;
}
