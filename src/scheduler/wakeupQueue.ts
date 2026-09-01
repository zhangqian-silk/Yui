import type { SchedulerStorePort } from "./ports.js";
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
