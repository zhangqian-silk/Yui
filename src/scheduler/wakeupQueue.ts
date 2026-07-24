import type { SchedulerAgentRun, SchedulerStorePort, SchedulerTask } from "./ports.js";
import { mergePendingWakeup, type PendingWakeup } from "./pendingWakeup.js";

export function queueLeaderWakeup(
  store: Pick<SchedulerStorePort, "getPendingWakeup" | "savePendingWakeup">
    & Partial<Pick<SchedulerStorePort, "enqueueLeaderWakeup">>,
  taskId: string,
  reason: string,
  now: Date
): PendingWakeup {
  if (store.enqueueLeaderWakeup !== undefined) {
    return store.enqueueLeaderWakeup(taskId, reason, now);
  }
  const pending = mergePendingWakeup(taskId, reason, now, store.getPendingWakeup(taskId));
  store.savePendingWakeup(pending);
  return pending;
}

export function queueLeaderWakeupAfterYield(
  store: Pick<SchedulerStorePort, "getPendingWakeup" | "savePendingWakeup">,
  task: SchedulerTask,
  run: Pick<SchedulerAgentRun, "taskId" | "roleName">,
  now: Date
): PendingWakeup | null {
  if (run.taskId !== task.id) throw new Error(`AgentRun belongs to another Task: ${run.taskId}.`);
  if (task.status !== "active" || run.roleName === "leader") return null;
  return queueLeaderWakeup(store, task.id, "role-result", now);
}
