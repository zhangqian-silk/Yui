import {
  selectedSchedulerTasks,
  type SchedulerReconcileSelection,
  type SchedulerStorePort
} from "./ports.js";
import { queueLeaderWakeup } from "./wakeupQueue.js";
import { projectTaskExecution } from "./taskExecutionProjection.js";

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
    const activeRuns = roles.flatMap((role) => {
      const run = store.getActiveAgentRun(task.id, role.name);
      return run === null ? [] : [run];
    });
    const hasInFlightTurn = roles.some((role) => store.hasInFlightTurn(task.id, role.name));
    const leaderTarget = { kind: "role", taskId: task.id, roleName: "leader" } as const;
    const leaderMailbox = store.getWorkMailbox(leaderTarget);
    const projection = projectTaskExecution({
      task,
      roles,
      runs: activeRuns,
      pendingWakeup: store.getPendingWakeup(task.id),
      leaderMailbox,
      leaderFailure: store.getLeaderFailure(task.id),
      operatorNotification: store.getOperatorNotification(task.id)
    });
    if (
      hasInFlightTurn
      || store.hasOpenInputRequest(task.id)
      || store.getLeaderFailure(task.id) !== null
      || store.getOperatorNotification(task.id) !== null
      || projection.status !== "needs-leader-action"
      || hasUnclaimedLeaderWork(store, task.id, leaderMailbox)
    ) {
      continue;
    }

    if (
      task.projectBindings.length > 0
      && task.cwd === undefined
      && typeof store.queueTaskProgress === "function"
    ) {
      store.queueTaskProgress(task.id, "task-orphaned", now);
    }
    if (leaderMailbox?.processing !== null && leaderMailbox?.processing !== undefined) {
      const recovered = store.releaseLeaderWakeupAndEnqueue === undefined
        ? store.releaseWorkMailbox(leaderTarget, leaderMailbox.processing.batchId)
          && (queueLeaderWakeup(store, task.id, "task-orphaned", now), true)
        : store.releaseLeaderWakeupAndEnqueue(
            task.id,
            leaderMailbox.processing.batchId,
            "task-orphaned",
            now
          );
      if (recovered) {
        repaired.push(task.id);
      }
      continue;
    }

    queueLeaderWakeup(store, task.id, "task-orphaned", now);
    repaired.push(task.id);
  }
  return repaired;
}

function hasUnclaimedLeaderWork(
  store: Pick<SchedulerStorePort, "getPendingWakeup">,
  taskId: string,
  leaderMailbox: ReturnType<SchedulerStorePort["getWorkMailbox"]>
): boolean {
  if (leaderMailbox === null) return store.getPendingWakeup(taskId) !== null;
  return leaderMailbox?.processing === null
    && leaderMailbox.pending !== null;
}
