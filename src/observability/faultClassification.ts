/** Stable fault classification from Core-owned execution facts only. */
import type { Turn } from "../turn/turn.js";
import type { ReviewRound } from "../review/reviewRound.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";

export const FAULT_CLASSES = [
  "session-dead",
  "delivery-uncertain",
  "review-infra",
  "integration-environment",
  "integration-candidate-failure",
  "stale-base-target-cas",
  "other"
] as const;

export type FaultClass = (typeof FAULT_CLASSES)[number];

export type FaultClassification = Readonly<{
  faultClass: FaultClass;
  basis: "core-fact" | "core-diagnostic" | "none";
  /** Short excerpt or field name that justifies the class. */
  evidence: string;
}>;

export const NO_FAULT: FaultClassification = Object.freeze({
  faultClass: "other",
  basis: "none",
  evidence: ""
});

/** Optional Core-owned fault fact supplied by a caller with narrower evidence. */
export type CoreFaultHint = Readonly<{
  faultClass: FaultClass;
  evidence: string;
}>;

const INTEGRATION_ENVIRONMENT_PATTERN =
  /tsc: not found|command not found|ENOENT|runner disappeared|runner vanished|dirty target|wrong argument|not a git repository|npm error|node: not found/iu;

function excerpt(text: string, max = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

/** Classify a failed Turn without inspecting Agent-authored output. */
export function classifyTurnFailure(
  run: Pick<Turn, "status" | "result">,
  hint?: CoreFaultHint
): FaultClassification {
  if (run.status !== "failed") return NO_FAULT;
  if (hint !== undefined) {
    return {
      faultClass: hint.faultClass,
      basis: "core-fact",
      evidence: hint.evidence
    };
  }
  const failureReason = run.result?.failureReason;
  if (failureReason === "delivery-unknown") {
    return {
      faultClass: "delivery-uncertain",
      basis: "core-fact",
      evidence: failureReason
    };
  }
  if (failureReason === "startup-failed") {
    return {
      faultClass: "session-dead",
      basis: "core-fact",
      evidence: failureReason
    };
  }
  return {
    faultClass: "other",
    basis: "core-fact",
    evidence: failureReason ?? "failed without Core failure reason"
  };
}

/** ReviewRound failure is an execution fault; completed prose is not classified. */
export function classifyReviewRound(round: ReviewRound): FaultClassification {
  if (round.status === "failed") {
    return {
      faultClass: "review-infra",
      basis: "core-fact",
      evidence: round.failure?.message ?? "Review execution failed without Core failure detail."
    };
  }
  return NO_FAULT;
}

/**
 * Integration failure classes: environment/toolchain failure, stale base/CAS
 * conflict, or candidate failure. Conflict/check records are Core-owned, but
 * environment attribution still uses a regex over their diagnostic text.
 */
export function classifyIntegrationAttempt(
  attempt: Pick<IntegrationAttempt, "status" | "checks" | "conflict">
): FaultClassification {
  if (attempt.status !== "failed") return NO_FAULT;
  if (attempt.conflict !== undefined) {
    return {
      faultClass: "stale-base-target-cas",
      basis: "core-fact",
      evidence: excerpt(attempt.conflict.summary)
    };
  }
  const checkText = (attempt.checks ?? [])
    .map((c) => `${c.name}: ${c.details ?? c.outcome}`)
    .join("\n");
  if (INTEGRATION_ENVIRONMENT_PATTERN.test(checkText)) {
    return {
      faultClass: "integration-environment",
      basis: "core-diagnostic",
      evidence: excerpt(checkText)
    };
  }
  if ((attempt.checks ?? []).some((c) => c.outcome === "failed")) {
    return {
      faultClass: "integration-candidate-failure",
      basis: "core-fact",
      evidence: excerpt(checkText)
    };
  }
  return {
    faultClass: "other",
    basis: "core-fact",
    evidence: "failed without checks or conflict"
  };
}

export type FaultClassCounts = Readonly<Record<FaultClass, number>>;

export function emptyFaultClassCounts(): FaultClassCounts {
  return Object.freeze(
    Object.fromEntries(FAULT_CLASSES.map((name) => [name, 0]))
  ) as FaultClassCounts;
}

export function countFaultClasses(
  classifications: Iterable<FaultClassification>
): FaultClassCounts {
  const counts = new Map<FaultClass, number>(
    FAULT_CLASSES.map((name) => [name, 0])
  );
  for (const { faultClass } of classifications) {
    counts.set(faultClass, (counts.get(faultClass) ?? 0) + 1);
  }
  return Object.freeze(Object.fromEntries(counts)) as FaultClassCounts;
}
