import type { Turn } from "../turn/turn.js";
import type { ReviewRound } from "./reviewRound.js";

export type ReviewCompletionEvidenceStore = Readonly<{
  listTurns(taskId: string): readonly Turn[];
}>;

/** Whether a ReviewRound has one exact completed main Reviewer Turn. */
export function isCompletedReviewExecution(
  store: ReviewCompletionEvidenceStore,
  round: ReviewRound
): boolean {
  return isCompletedReviewExecutionFromTurns(round, store.listTurns(round.taskId));
}

export function isCompletedReviewExecutionFromTurns(
  round: ReviewRound,
  turns: readonly Turn[]
): boolean {
  if (round.status !== "completed" || round.reviewerTurnId === undefined) return false;
  const turn = turns.find(({ id }) => id === round.reviewerTurnId);
  return turn !== undefined
    && turn.status === "completed"
    && turn.result !== undefined
    && turn.purpose === "review"
    && turn.taskId === round.taskId
    && turn.reviewRoundId === round.id
    && turn.roleName === round.reviewerRoleName
    && turn.executionGroupId === undefined
    && turn.effective.reviewBaseCommit === round.reviewBaseCommit;
}

/**
 * Whether a Task-final ReviewRound has one exact completed main Reviewer Turn.
 * This is structural evidence only and never means the Leader accepted it.
 */
export function isCompletedTaskReviewEvidence(
  store: ReviewCompletionEvidenceStore,
  round: ReviewRound
): boolean {
  return isCompletedTaskReviewEvidenceFromTurns(round, store.listTurns(round.taskId));
}

export function isCompletedTaskReviewEvidenceFromTurns(
  round: ReviewRound,
  turns: readonly Turn[]
): boolean {
  if ((round.scope ?? "work-item") !== "task"
    || round.taskCandidate === undefined
    || round.taskCandidate.projects.length === 0) {
    return false;
  }
  return isCompletedReviewExecutionFromTurns(round, turns);
}
