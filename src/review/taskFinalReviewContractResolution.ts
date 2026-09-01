import { requireIdentity } from "../domain/validation.js";
import {
  sameTaskFinalReviewContract,
  validateTaskFinalReviewContract,
  type TaskFinalReviewContract
} from "./taskFinalReviewContract.js";
import type { ReviewRound } from "./reviewRound.js";
import type { WorkItem } from "../workItem/workItem.js";

export type TaskFinalReviewContractResolution = Readonly<{
  effective: TaskFinalReviewContract;
}>;

/**
 * Resolve the one Task-final Review contract recorded by current Candidate and
 * ReviewRound evidence. The contract is immutable once established; all later
 * observations must match it exactly.
 */
export function resolveRecordedTaskFinalReviewContract(
  taskId: string,
  workItems: readonly WorkItem[],
  reviewRounds: readonly ReviewRound[]
): TaskFinalReviewContractResolution | undefined {
  const normalizedTaskId = requireIdentity(taskId, "Task final-review contract Task id");
  const observations = [
    ...workItems.flatMap((item) => item.candidates.flatMap((candidate) => (
      candidate.taskFinalReviewContract === undefined
        ? []
        : [{
            contract: candidate.taskFinalReviewContract,
            source: `Candidate ${item.id}/${candidate.id}`
          }]
    ))),
    ...reviewRounds.flatMap((round) => (
      (round.scope ?? "work-item") !== "task"
      || round.taskFinalReviewContract === undefined
        ? []
        : [{
            contract: round.taskFinalReviewContract,
            source: `ReviewRound ${round.id}`
          }]
    ))
  ];
  if (observations.length === 0) return undefined;

  const effective = validateTaskFinalReviewContract(observations[0]!.contract);
  if (effective.taskId !== normalizedTaskId) {
    throw new Error(`${observations[0]!.source} carries a final-review contract for another Task.`);
  }
  for (const observation of observations.slice(1)) {
    const contract = validateTaskFinalReviewContract(observation.contract);
    if (contract.taskId !== normalizedTaskId) {
      throw new Error(`${observation.source} carries a final-review contract for another Task.`);
    }
    if (!sameTaskFinalReviewContract(contract, effective)) {
      throw new Error(`${observation.source} conflicts with the Task final-review contract.`);
    }
  }
  return Object.freeze({ effective });
}
