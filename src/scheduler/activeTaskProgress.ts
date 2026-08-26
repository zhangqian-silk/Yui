import {
  selectedActiveSchedulerTasks,
  isSchedulerTaskWorkspaceReady,
  type SchedulerReconcileSelection,
  type SchedulerStorePort
} from "./ports.js";
import { queueLeaderWakeup } from "./wakeupQueue.js";
import { wakeReason } from "./wakeReason.js";
import { projectTaskExecution } from "./taskExecutionProjection.js";
import {
  collectTaskActionability,
  computeActionabilityDigest,
  decideOrphanWake,
  hasDispatchableQueuedResourceLane
} from "./actionability.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";

/**
 * Repairs an active Task that has no durable owner capable of advancing it.
 * This is a low-frequency safety net; normal transitions enqueue their own
 * Role mailbox signal in the same transaction.
 *
 * Issue 05: a `task-orphaned` wake is suppressed when the last Leader Run
 * ended waiting/blocked and its observed actionability digest equals the
 * current digest. Suppression is silent — no Message, Event, or progress
 * record is written — because a periodic scan that changes nothing is Yui
 * engineering behavior with no Task-visible effect. Computation errors fail
 * open: the Task is woken once and the error is recorded so it can never be
 * silently starved.
 */
export function repairOrphanedActiveTasks(
  store: SchedulerStorePort,
  now: Date,
  selection?: SchedulerReconcileSelection
): readonly string[] {
  const repaired: string[] = [];
  for (const task of selectedActiveSchedulerTasks(store, selection)) {
    const roles = store.listRoles(task.id);
    const activeRuns = roles.flatMap((role) => {
      const run = store.getActiveAgentRun(task.id, role.name);
      return run === null ? [] : [run];
    });
    const hasInFlightTurn = roles.some((role) => store.hasInFlightTurn(task.id, role.name));
    const hasLeaderInFlightTurn = store.hasInFlightTurn(task.id, "leader");
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
    const queuedAlongsideActiveSibling = hasDispatchableQueuedResourceLane(store, task.id)
      && !activeRuns.some(({ roleName }) => roleName === "leader")
      && activeRuns.some(({ roleName }) => roleName !== "leader")
      && projection.status === "waiting-on-agents";
    if (
      (queuedAlongsideActiveSibling ? hasLeaderInFlightTurn : hasInFlightTurn)
      || store.hasOpenInputRequest(task.id)
      || store.getLeaderFailure(task.id) !== null
      || store.getOperatorNotification(task.id) !== null
      || (projection.status !== "needs-leader-action" && !queuedAlongsideActiveSibling)
      || hasUnclaimedLeaderWork(store, task.id, leaderMailbox)
    ) {
      continue;
    }

    // Digest admission covers both an ownerless Task and a resource-queued
    // Task with active siblings. The latter wakes only when capacity/deadline
    // actionability changes, so repeated full scans remain silent.
    if (projection.reason === "no-executor" || queuedAlongsideActiveSibling) {
      if (admitOrphanWake(store, task.id, now) === "suppress") continue;
    }

    const taskWorkspace = store.getTaskWorkspace(task.id);
    if (!isSchedulerTaskWorkspaceReady(task, taskWorkspace)) {
      store.queueTaskProgress(task.id, "task-orphaned", now);
    }
    if (leaderMailbox?.processing !== null && leaderMailbox?.processing !== undefined) {
      const recovered = store.releaseLeaderWakeupAndEnqueue === undefined
        ? store.releaseWorkMailbox(leaderTarget, leaderMailbox.processing.batchId)
          && (queueLeaderWakeup(store, task.id, wakeReason("task-orphaned"), now), true)
        : store.releaseLeaderWakeupAndEnqueue(
            task.id,
            leaderMailbox.processing.batchId,
            wakeReason("task-orphaned"),
            now
          );
      if (recovered) {
        repaired.push(task.id);
      }
      continue;
    }

    queueLeaderWakeup(store, task.id, wakeReason("task-orphaned"), now);
    repaired.push(task.id);
  }
  return repaired;
}

/**
 * Decide whether one `task-orphaned` scan should wake the Leader. Returns
 * `"suppress"` without writing anything when the digest is unchanged since
 * the last waiting/blocked Leader Run. Computation errors fail open.
 */
function admitOrphanWake(
  store: SchedulerStorePort,
  taskId: string,
  now: Date
): "wake" | "suppress" {
  let digest: string;
  try {
    const input = collectTaskActionability(
      store as Parameters<typeof collectTaskActionability>[0],
      taskId,
      now
    );
    digest = computeActionabilityDigest(input);
  } catch (error) {
    // Fail open: wake once and record the computation error so the Task can
    // never be silently starved by a broken projection.
    store.queueTaskProgress(taskId, "actionability-unknown", new Date());
    return "wake";
  }
  const lastLeaderRun = findLastLeaderRun(store, taskId);
  const decision = decideOrphanWake({ currentDigest: digest, lastLeaderRun });
  return decision.kind === "suppress" ? "suppress" : "wake";
}

/**
 * The most recent Leader Run (terminal or active). Active Runs are returned
 * so the admission check never suppresses while a Leader is still running.
 */
function findLastLeaderRun(
  store: SchedulerStorePort,
  taskId: string
): Pick<import("../run/agentRun.js").AgentRun, "status" | "disposition" | "observedActionabilityDigest"> | null {
  const runs = operationalTaskRecords(
    store.listAgentRuns?.(taskId) ?? [],
    store.listEvents?.(taskId) ?? [],
    "agent-run"
  );
  let latest: typeof runs[number] | null = null;
  for (const run of runs) {
    if (run.roleName !== "leader") continue;
    if (latest === null || run.createdAt > latest.createdAt) latest = run;
  }
  if (latest === null) return null;
  return {
    status: latest.status,
    ...(latest.disposition === undefined ? {} : { disposition: latest.disposition }),
    ...(latest.observedActionabilityDigest === undefined
      ? {}
      : { observedActionabilityDigest: latest.observedActionabilityDigest })
  };
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
