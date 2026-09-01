import type { TaskEvent } from "../event/taskEvent.js";
import type { Turn } from "../turn/turn.js";
import type { ReviewFinding } from "./reviewFinding.js";
import type { ReviewRound } from "./reviewRound.js";
import { isSemanticReviewRound } from "./reviewOutcomeClassifier.js";

export type ReviewAcceptanceEvidenceStore = Readonly<{
  listTurns(taskId: string): readonly Turn[];
  listReviewFindings(taskId: string): readonly ReviewFinding[];
  listEvents(taskId: string): readonly TaskEvent[];
}>;

/**
 * Whether a completed Task-final Round is a trustworthy accepted baseline.
 * Semantic completion alone is insufficient when it returned a non-accepting
 * delta disposition or still owns an open material finding.
 */
export function isAcceptedTaskReviewBaseline(
  store: ReviewAcceptanceEvidenceStore,
  round: ReviewRound
): boolean {
  return isAcceptedTaskReviewBaselineFromEvidence(round, store);
}

/** Pure evidence form shared by read-only projections and mutation paths. */
export function isAcceptedTaskReviewBaselineFromEvidence(
  round: ReviewRound,
  evidence?: ReviewAcceptanceEvidenceStore
): boolean {
  if ((round.scope ?? "work-item") !== "task"
    || round.status !== "completed"
    || round.taskCandidate === undefined
    || round.taskCandidate.projects.length === 0
    || !isSemanticReviewRound(round, evidence)) return false;
  if ((round.checks ?? []).some(({ outcome }) => outcome === "failed")) return false;
  if (round.deltaRecheck !== undefined
    && round.deltaRecheck.disposition !== "equivalent-and-accepted") return false;
  return !(evidence?.listReviewFindings(round.taskId) ?? []).some((finding) => (
    finding.lastReviewRoundId === round.id
    && (finding.severity === "p1" || finding.severity === "p2")
    && (finding.disposition === "open" || finding.disposition === "fixed-pending-review")
  ));
}
