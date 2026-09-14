import type { AgentRun } from "../agentRun/agentRun.js";
import type { ReviewRound } from "./reviewRound.js";

export type ReviewCompletionEvidenceStore = Readonly<{
  listRuns(taskId: string): readonly AgentRun[];
}>;

export function isCompletedReviewExecutionFromRuns(
  round: ReviewRound,
  runs: readonly AgentRun[]
): boolean {
  if (round.status !== "completed" || round.reviewerRunId === undefined) return false;
  const run = runs.find(({ id }) => id === round.reviewerRunId);
  return run !== undefined
    && run.status === "completed"
    && run.result !== undefined
    && run.purpose === "review"
    && run.taskId === round.taskId
    && run.reviewRoundId === round.id
    && run.roleName === round.reviewerRoleName
    && run.executionGroupId === undefined
    && run.effective.reviewBaseCommit === round.reviewBaseCommit;
}

/**
 * Whether a Task-final ReviewRound has one exact completed main Reviewer AgentRun.
 * This is structural evidence only and never means the Leader accepted it.
 */
export function isCompletedTaskReviewEvidence(
  store: ReviewCompletionEvidenceStore,
  round: ReviewRound
): boolean {
  return isCompletedTaskReviewEvidenceFromRuns(round, store.listRuns(round.taskId));
}

export function isCompletedTaskReviewEvidenceFromRuns(
  round: ReviewRound,
  runs: readonly AgentRun[]
): boolean {
  if (round.scope !== "task"
    || round.taskCandidate === undefined
    || round.taskCandidate.projects.length === 0) {
    return false;
  }
  return isCompletedReviewExecutionFromRuns(round, runs);
}
