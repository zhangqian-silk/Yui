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

/** The Reviewer Role seeded in a new Home by `yui setup`. */
export const DEFAULT_REVIEWER_ROLE = "reviewer";

export type ReviewConfig = Readonly<{
  roleName: string;
  trigger: ReviewTrigger;
  findingLedger?: ReviewFindingLedgerMode;
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
  return config;
}
