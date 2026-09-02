import type { WorkItem } from "../workItem/workItem.js";
import type { ReviewRound } from "../review/reviewRound.js";
import type { Turn } from "../turn/turn.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { ResourceLaneIdentity } from "../execution/resourceBroker.js";

export type ResourceQueueProjectionStore = Readonly<{
  listActiveTaskIds(): readonly string[];
  listTurns(taskId: string): readonly Turn[];
  listWorkItems(taskId: string): readonly WorkItem[];
  listReviewRounds(taskId: string): readonly ReviewRound[];
  listEvents(taskId: string): readonly TaskEvent[];
}>;

/** Exact durable Broker queue used by resource admission. */
export function projectQueuedResourceLaneIdentities(
  store: ResourceQueueProjectionStore,
  now: Date
): ResourceLaneIdentity[] {
  return store.listActiveTaskIds().flatMap((taskId) => {
    const workItemLanes: ResourceLaneIdentity[] = [];
    const reviewLanes = store.listReviewRounds(taskId).flatMap((round) => {
      if (round.status !== "pending" && round.status !== "running") return [];
      const group = round.executionGroup;
      if (group === undefined || group.resolution !== undefined) return [];
      return group.lanes.flatMap((lane): ResourceLaneIdentity[] => {
        if (lane.status !== "pending"
          || lane.effective === undefined
          || lane.turnId !== undefined) return [];
        return [{
          taskId,
          ...(round.workItemId === undefined ? {} : { workItemId: round.workItemId }),
          executionGroupId: group.id,
          executionLaneId: lane.id,
          providerId: lane.effective.adapterId,
          agentId: lane.effective.agentId,
          ...(lane.effective.model === undefined ? {} : { model: lane.effective.model }),
          requestedAt: lane.updatedAt
        }];
      });
    });
    return [...workItemLanes, ...reviewLanes];
  });
}
