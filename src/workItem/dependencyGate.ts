import type { TaskStore } from "../storage/taskStore.js";
import type { WorkItem, WorkItemStatus } from "./workItem.js";

export const WORK_ITEM_DEPENDENCIES_NOT_COMPLETED =
  "work-item-dependencies-not-completed" as const;

export type UnmetWorkItemDependency = Readonly<{
  id: string;
  status: WorkItemStatus | "missing";
}>;

export class WorkItemDependencyGateError extends Error {
  readonly details: Readonly<{
    reason: typeof WORK_ITEM_DEPENDENCIES_NOT_COMPLETED;
    workItemId: string;
    unmetDependencies: readonly UnmetWorkItemDependency[];
  }>;

  constructor(
    workItemId: string,
    unmetDependencies: readonly UnmetWorkItemDependency[]
  ) {
    super(
      `Work Item dependencies are not completed: ${unmetDependencies
        .map(({ id, status }) => `${id} (${status})`)
        .join(", ")}.`
    );
    this.name = "WorkItemDependencyGateError";
    this.details = Object.freeze({
      reason: WORK_ITEM_DEPENDENCIES_NOT_COMPLETED,
      workItemId,
      unmetDependencies: Object.freeze([...unmetDependencies])
    });
  }
}

/**
 * The direct `dependsOn` list is the only dependency authority. Every direct
 * dependency must exist and be completed; retirement and replacement metadata
 * never satisfy or rewrite the edge.
 */
export function assertWorkItemDependenciesCompleted(
  store: Pick<TaskStore, "getWorkItem">,
  item: Pick<WorkItem, "id" | "taskId" | "dependsOn">
): void {
  const unmetDependencies = item.dependsOn.flatMap((dependencyId) => {
    const dependency = store.getWorkItem(item.taskId, dependencyId);
    if (dependency?.status === "completed") return [];
    return [{
      id: dependencyId,
      status: dependency?.status ?? "missing"
    } satisfies UnmetWorkItemDependency];
  });
  if (unmetDependencies.length > 0) {
    throw new WorkItemDependencyGateError(item.id, unmetDependencies);
  }
}
