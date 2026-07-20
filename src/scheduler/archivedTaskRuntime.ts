import type { SchedulerStorePort, TmuxDeliveryPort } from "./ports.js";

/** Stops archived Task processes at the tmux boundary and closes their sessions. */
export async function stopArchivedTaskRuntimes(
  store: SchedulerStorePort,
  delivery: Pick<TmuxDeliveryPort, "stopTask">,
  now: Date
): Promise<string[]> {
  const stopped: string[] = [];
  for (const task of store.listTasks()) {
    if (task.status !== "archived") continue;
    if (await delivery.stopTask(task.id)) stopped.push(task.id);
    store.saveArchivedTaskStopped(task.id, now);
  }
  return stopped;
}
