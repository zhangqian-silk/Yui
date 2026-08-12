import { requireIdentity } from "../domain/validation.js";

export const REVIEW_TRIGGERS = ["always", "leader", "final"] as const;
export type ReviewTrigger = typeof REVIEW_TRIGGERS[number];

/** The Reviewer Role seeded in a new Home by `yui setup`. */
export const DEFAULT_REVIEWER_ROLE = "reviewer";

export type ReviewConfig = Readonly<{
  roleName: string;
  trigger: ReviewTrigger;
}>;

export function validateReviewConfig(config: ReviewConfig): ReviewConfig {
  requireIdentity(config.roleName, "Review Role");
  if (!REVIEW_TRIGGERS.includes(config.trigger)) {
    throw new Error(`Review trigger is invalid: ${String(config.trigger)}.`);
  }
  return config;
}
