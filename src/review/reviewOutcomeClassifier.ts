import type { ReviewRound } from "./reviewRound.js";

/**
 * Issue 06: classifies a ReviewRound outcome as an execution-attempt (infra)
 * failure or a semantic review delivery.  Only a completed Round carrying a
 * valid reviewer report may feed the finding ledger; every failed Round is an
 * infra attempt regardless of which legacy or new flow recovers it, so failed
 * attempts never create or duplicate semantic findings.
 */

export type ReviewInfraFailureKind =
  | "session-not-stopped"
  | "run-start"
  | "storage-lock"
  | "tmux-exit"
  | "yield-timeout"
  | "run-identity"
  | "policy"
  | "baseline-contamination"
  | "other-infra";

export type ReviewOutcomeClassification = Readonly<{
  kind: "semantic" | "infra";
  /** Present for infra outcomes; the matched failure family. */
  infraKind?: ReviewInfraFailureKind;
  reason: string;
}>;

const INFRA_SIGNATURES: readonly Readonly<{
  kind: ReviewInfraFailureKind;
  pattern: RegExp;
}>[] = [
  {
    kind: "session-not-stopped",
    pattern: /session must be stopped before workspace migration/iu
  },
  {
    kind: "run-start",
    pattern: /role run could not start|could not start (?:the )?(?:reviewer|role) run/iu
  },
  {
    kind: "storage-lock",
    pattern: /\.state\.lock|state lock|lock timeout|storage lock/iu
  },
  {
    kind: "tmux-exit",
    pattern: /tmux[^\n]{0,80}(?:exited|exit|died|vanished)|pane (?:exited|died)/iu
  },
  {
    kind: "yield-timeout",
    pattern: /yield timeout|controller yield timeout|yield timed out/iu
  },
  {
    kind: "run-identity",
    pattern: /wrong run id|unknown run id|run id (?:is )?(?:invalid|unknown|mismatch)/iu
  },
  {
    kind: "policy",
    pattern: /cyber_?policy|policy denial|permission denied by policy/iu
  },
  {
    kind: "baseline-contamination",
    pattern: /cross[-\s]?baseline|baseline pollution|contaminated baseline|wrong base sha/iu
  }
];

/**
 * Classifies a terminal Round.  `completed` is always semantic (the reviewer
 * delivered a report); `failed` is always infra.  Non-terminal Rounds have no
 * outcome yet.
 */
export function classifyReviewRoundOutcome(
  round: ReviewRound
): ReviewOutcomeClassification | null {
  if (round.status === "completed") {
    return { kind: "semantic", reason: "Reviewer delivered a report." };
  }
  if (round.status !== "failed") return null;
  const text = `${round.summary ?? ""}\n${round.report ?? ""}`;
  for (const { kind, pattern } of INFRA_SIGNATURES) {
    if (pattern.test(text)) {
      return { kind: "infra", infraKind: kind, reason: `Review execution attempt failed (${kind}).` };
    }
  }
  return {
    kind: "infra",
    infraKind: "other-infra",
    reason: "Review execution attempt failed before a semantic report."
  };
}

/** True when this Round may feed the finding ledger. */
export function isSemanticReviewRound(round: ReviewRound): boolean {
  return classifyReviewRoundOutcome(round)?.kind === "semantic";
}
