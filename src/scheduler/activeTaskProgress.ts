import {
  selectedSchedulerTasks,
  type SchedulerReconcileSelection,
  type SchedulerStorePort
} from "./ports.js";
import { queueLeaderWakeup } from "./wakeupQueue.js";

/**
 * Repairs an active Task that has no durable owner capable of advancing it.
 * This is a low-frequency safety net; normal transitions enqueue their own
 * Role mailbox signal in the same transaction.
 */
export function repairOrphanedActiveTasks(
  store: SchedulerStorePort,
  now: Date,
  selection?: SchedulerReconcileSelection
): readonly string[] {
  const repaired: string[] = [];
  for (const task of selectedSchedulerTasks(store, selection)) {
    if (task.status !== "active") continue;
    const roles = store.listRoles(task.id);
    const hasActiveRun = roles.some((role) => (
      store.getActiveAgentRun(task.id, role.name) !== null
    ));
    const hasInFlightTurn = roles.some((role) => store.hasInFlightTurn(task.id, role.name));
    if (
      hasActiveRun
      || hasInFlightTurn
      || store.hasOpenInputRequest(task.id)
      || store.getLeaderFailure(task.id) !== null
      || store.getOperatorNotification(task.id) !== null
      || hasTaskOrLeaderPendingWork(store, task.id)
    ) {
      continue;
    }

    const leaderTarget = { kind: "role", taskId: task.id, roleName: "leader" } as const;
    if (
      task.repositoryId !== undefined
      && task.cwd === undefined
      && typeof store.queueTaskProgress === "function"
    ) {
      store.queueTaskProgress(task.id, "task-orphaned", now);
    }
    const leaderMailbox = store.getWorkMailbox(leaderTarget);
    if (leaderMailbox?.processing !== null && leaderMailbox?.processing !== undefined) {
      if (store.releaseWorkMailbox(leaderTarget, leaderMailbox.processing.batchId)) {
        queueLeaderWakeup(store, task.id, "task-orphaned", now);
        repaired.push(task.id);
      }
      continue;
    }

    queueLeaderWakeup(store, task.id, "task-orphaned", now);
    repaired.push(task.id);
  }
  return repaired;
}

function hasTaskOrLeaderPendingWork(
  store: SchedulerStorePort,
  taskId: string
): boolean {
  if (store.getPendingWakeup(taskId) !== null) return true;
  const leaderMailbox = store.getWorkMailbox({
    kind: "role",
    taskId,
    roleName: "leader"
  });
  return leaderMailbox?.pending !== null && leaderMailbox?.pending !== undefined;
}
