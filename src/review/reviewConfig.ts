import { requireIdentity } from "../domain/validation.js";

export const REVIEW_TRIGGERS = ["always", "leader"] as const;
export type ReviewTrigger = typeof REVIEW_TRIGGERS[number];

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
