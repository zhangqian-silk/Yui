/**
 * Stable fault classification for execution audit (Issue 11 §2).
 *
 * Classification comes from structured outcomes wherever the current build
 * exposes them. Free-text regex matching exists ONLY for importing historical
 * records (AgentRun summaries written before this taxonomy existed) and is
 * never the basis of a new state machine: every text-derived result carries
 * `basis: "text-historical"` so consumers can tell the two apart.
 */
import type { AgentRun } from "../run/agentRun.js";
import type { ReviewRound } from "../review/reviewRound.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import {
  classifyReviewRoundOutcome,
  type ReviewOutcomeEvidenceStore
} from "../review/reviewOutcomeClassifier.js";

export const FAULT_CLASSES = [
  "provider-transient",
  "policy-denied",
  "session-dead",
  "delivery-yield-uncertain",
  "storage-backend-lock",
  "scheduler-duplicate-suppressed-wake",
  "review-infra",
  "review-semantic-negative",
  "integration-environment",
  "integration-candidate-failure",
  "stale-base-target-cas",
  "archive-resource-leak",
  "other"
] as const;

export type FaultClass = (typeof FAULT_CLASSES)[number];

export type FaultClassification = Readonly<{
  faultClass: FaultClass;
  basis: "structured" | "text-historical" | "none";
  /** Short excerpt or field name that justifies the class. */
  evidence: string;
}>;

export const NO_FAULT: FaultClassification = Object.freeze({
  faultClass: "other",
  basis: "none",
  evidence: ""
});

/** Structured hint a future capability provider (other Issues) may supply. */
export type StructuredFaultHint = Readonly<{
  faultClass: FaultClass;
  evidence: string;
}>;

const PROVIDER_TRANSIENT_PATTERN =
  /\b5\d{2}\b|gateway time|connection lost|server error|overloaded|rate.?limit|ECONNRESET|socket hang up|API Error|nonstream call error|mid-response/iu;
const POLICY_DENIED_PATTERN =
  /policy|permission denied|forbidden|not authorized|\b403\b/iu;
const SESSION_DEAD_PATTERN =
  /tmux session exited|session cannot be replaced|could not start|pane[^\n]*(dead|exited)|session[^\n]*(dead|exited|broken)|native session|launch reservation/iu;
const STORAGE_LOCK_PATTERN =
  /storage lock|database is locked|SQLITE_BUSY|lock timeout|COMMAND_TIMED_OUT|storage conflict|timed out waiting/iu;
const DELIVERY_UNCERTAIN_PATTERN =
  /delivery[^\n]*(uncertain|unknown)|yield[^\n]*(uncertain|unknown)|uncertain[^\n]*(yield|delivery)|push[^\n]*uncertain/iu;
const STALE_BASE_PATTERN =
  /stale (role|agent|base|target|state)|expected head|base[^\n]*(changed|moved)|conflict|CAS/iu;

const INTEGRATION_ENVIRONMENT_PATTERN =
  /tsc: not found|command not found|ENOENT|runner disappeared|runner vanished|dirty target|wrong argument|not a git repository|npm error|node: not found/iu;

function excerpt(text: string, max = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

/**
 * Classify a failed AgentRun. A structured hint (from a future capability
 * provider) always wins; otherwise the summary is matched as historical
 * import text. Active/yielded runs return {@link NO_FAULT}.
 */
export function classifyAgentRunFailure(
  run: Pick<AgentRun, "status" | "summary">,
  structured?: StructuredFaultHint
): FaultClassification {
  if (run.status !== "failed") return NO_FAULT;
  if (structured !== undefined) {
    return {
      faultClass: structured.faultClass,
      basis: "structured",
      evidence: structured.evidence
    };
  }
  const summary = run.summary ?? "";
  if (summary.length === 0) {
    return { faultClass: "other", basis: "text-historical", evidence: "" };
  }
  const text = excerpt(summary);
  if (POLICY_DENIED_PATTERN.test(summary)) {
    return { faultClass: "policy-denied", basis: "text-historical", evidence: text };
  }
  if (PROVIDER_TRANSIENT_PATTERN.test(summary)) {
    return { faultClass: "provider-transient", basis: "text-historical", evidence: text };
  }
  if (STORAGE_LOCK_PATTERN.test(summary)) {
    return { faultClass: "storage-backend-lock", basis: "text-historical", evidence: text };
  }
  if (DELIVERY_UNCERTAIN_PATTERN.test(summary)) {
    return { faultClass: "delivery-yield-uncertain", basis: "text-historical", evidence: text };
  }
  if (STALE_BASE_PATTERN.test(summary)) {
    return { faultClass: "stale-base-target-cas", basis: "text-historical", evidence: text };
  }
  if (SESSION_DEAD_PATTERN.test(summary)) {
    return { faultClass: "session-dead", basis: "text-historical", evidence: text };
  }
  return { faultClass: "other", basis: "text-historical", evidence: text };
}

/**
 * Review execution failure (the Round itself failed to execute/deliver) is
 * `review-infra`; a completed Round with failed checks is a semantic negative.
 */
export function classifyReviewRound(
  round: ReviewRound,
  evidence?: ReviewOutcomeEvidenceStore
): FaultClassification {
  const outcome = classifyReviewRoundOutcome(round, evidence);
  if (outcome?.kind === "non-semantic") {
    return {
      faultClass: "review-infra",
      basis: "structured",
      evidence: outcome.reason
    };
  }
  if (outcome?.kind === "semantic" && (round.checks ?? []).some((c) => c.outcome === "failed")) {
    const failed = (round.checks ?? [])
      .filter((c) => c.outcome === "failed")
      .map((c) => c.name)
      .join(",");
    return {
      faultClass: "review-semantic-negative",
      basis: "structured",
      evidence: `failed checks: ${failed}`
    };
  }
  return NO_FAULT;
}

/**
 * Integration failure classes: environment/toolchain failure, stale base/CAS
 * conflict, or candidate failure. Conflict reports are structured; check
 * details are matched as historical text.
 */
export function classifyIntegrationAttempt(
  attempt: Pick<IntegrationAttempt, "status" | "checks" | "conflict">
): FaultClassification {
  if (attempt.status !== "failed") return NO_FAULT;
  if (attempt.conflict !== undefined) {
    return {
      faultClass: "stale-base-target-cas",
      basis: "structured",
      evidence: excerpt(attempt.conflict.summary)
    };
  }
  const checkText = (attempt.checks ?? [])
    .map((c) => `${c.name}: ${c.details ?? c.outcome}`)
    .join("\n");
  if (INTEGRATION_ENVIRONMENT_PATTERN.test(checkText)) {
    return {
      faultClass: "integration-environment",
      basis: "text-historical",
      evidence: excerpt(checkText)
    };
  }
  if ((attempt.checks ?? []).some((c) => c.outcome === "failed")) {
    return {
      faultClass: "integration-candidate-failure",
      basis: "structured",
      evidence: excerpt(checkText)
    };
  }
  return {
    faultClass: "other",
    basis: "structured",
    evidence: "failed without checks or conflict"
  };
}

/**
 * Wake reason classification. An orphan wake (the scheduler re-woke a Leader
 * with no new fact) is the duplicate/suppressed-wake class. Quiescence
 * suppression counters are owned by the scheduler Issue; when absent the
 * audit reports `unsupported` instead of guessing.
 */
export function classifyWakeReasons(reasons: readonly string[]): FaultClassification {
  if (reasons.some((reason) => reason === "task-orphaned")) {
    return {
      faultClass: "scheduler-duplicate-suppressed-wake",
      basis: "structured",
      evidence: reasons.join(",")
    };
  }
  return NO_FAULT;
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
