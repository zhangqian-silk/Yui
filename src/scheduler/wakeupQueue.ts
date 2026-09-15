import type { SchedulerStorePort } from "./ports.js";
import { mergePendingWakeup, type PendingWakeup } from "./pendingWakeup.js";

/** The caller's TaskStore transaction owns this read/merge/write operation. */
export function queueLeaderWakeup(
  store: Pick<SchedulerStorePort, "getPendingWakeup" | "savePendingWakeup">
    & { getTask(taskId: string): Readonly<{ status: string }> | null },
  taskId: string,
  reason: string,
  now: Date
): PendingWakeup | null {
  if (store.getTask(taskId)?.status === "archived") return null;
  const pending = mergePendingWakeup(taskId, reason, now, store.getPendingWakeup(taskId));
  store.savePendingWakeup(pending);
  return pending;
}
