import {
  currentWorkItemExecutionGroup,
  type WorkItem
} from "../workItem/workItem.js";
import type { ReviewRound } from "../review/reviewRound.js";
import type { Turn } from "../turn/turn.js";
import type { TaskEvent } from "../event/taskEvent.js";
import {
  executionStageSpendClosed,
  observedExecutionResourceUsage,
  projectExecutionStageResources,
  type ResourceLaneIdentity
} from "../execution/resourceBroker.js";

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
    const taskTurns = store.listTurns(taskId);
    const taskEvents = store.listEvents(taskId);
    const workItemLanes = store.listWorkItems(taskId).flatMap((item) => {
      if (item.status !== "running") return [];
      const group = currentWorkItemExecutionGroup(item);
      if (group === undefined || group.resolution !== undefined) return [];
      if (group.stage !== undefined) {
        const resources = projectExecutionStageResources({
          group,
          stageGroups: item.executionGroups,
          usage: observedExecutionResourceUsage({
            group,
            stageGroups: item.executionGroups,
            turns: taskTurns,
            events: taskEvents
          }),
          now
        });
        if (executionStageSpendClosed(resources)) return [];
      }
      return group.lanes.flatMap((lane): ResourceLaneIdentity[] => {
        if (lane.status !== "pending"
          || lane.effective === undefined
          || lane.turnId !== undefined) return [];
        return [{
          taskId,
          workItemId: item.id,
          executionGroupId: group.id,
          executionLaneId: lane.id,
          providerId: lane.effective.adapterId,
          agentId: lane.effective.agentId,
          ...(lane.effective.model === undefined ? {} : { model: lane.effective.model }),
          requestedAt: lane.updatedAt
        }];
      });
    });
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
