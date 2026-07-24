import {
  selectedSchedulerTasks,
  type SchedulerReconcileSelection,
  type SchedulerStorePort,
  type TmuxDeliveryPort
} from "./ports.js";

/** Stops archived Task processes at the tmux boundary and closes their sessions. */
export async function stopArchivedTaskRuntimes(
  store: SchedulerStorePort,
  delivery: Pick<TmuxDeliveryPort, "stopTask">,
  now: Date,
  selection?: SchedulerReconcileSelection
): Promise<string[]> {
  const stopped: string[] = [];
  for (const task of selectedSchedulerTasks(store, selection)) {
    if (task.status !== "archived") continue;
    if (await delivery.stopTask(task.id)) stopped.push(task.id);
    store.saveArchivedTaskStopped(task.id, now);
  }
  return stopped;
}
