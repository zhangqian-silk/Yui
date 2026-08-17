import {
  selectedSchedulerTasks,
  isSchedulerTaskWorkspaceReady,
  type SchedulerReconcileSelection,
  type SchedulerStorePort
} from "./ports.js";
import { queueLeaderWakeup } from "./wakeupQueue.js";
import { projectTaskExecution } from "./taskExecutionProjection.js";
import {
  collectTaskActionability,
  computeActionabilityDigest,
  decideOrphanWake,
  resolveActionabilityMode,
  type ActionabilityMode
} from "./actionability.js";

/**
 * Observation recorded when the actionability admission check suppresses (or
 * would suppress, in shadow mode) a `task-orphaned` wake. The Controller can
 * surface these as suppressed-wake-age metrics without changing behavior.
 */
export type OrphanWakeSuppression = Readonly<{
  taskId: string;
  mode: ActionabilityMode;
  digest: string;
  observedDigest: string;
  suppressed: boolean;
}>;

export type RepairOrphanedOptions = Readonly<{
  /** Defaults to the YUI_SCHEDULER_ACTIONABILITY_MODE env resolution. */
  actionabilityMode?: ActionabilityMode;
  /** Called once per suppressed (or would-suppress) admission decision. */
  onSuppression?: (suppression: OrphanWakeSuppression) => void;
}>;

/**
 * Repairs an active Task that has no durable owner capable of advancing it.
 * This is a low-frequency safety net; normal transitions enqueue their own
 * Role mailbox signal in the same transaction.
 *
 * Issue 05: when actionability enforcement is enabled, a `task-orphaned` wake
 * is suppressed if the last Leader Run ended waiting/blocked and its observed
 * actionability digest equals the current digest. Shadow mode records the
 * would-suppress decision without changing the existing wake. Computation
 * errors fail open: the Task is woken once and the error is recorded so it can
 * never be silently starved.
 */
export function repairOrphanedActiveTasks(
  store: SchedulerStorePort,
  now: Date,
  selection?: SchedulerReconcileSelection,
  options?: RepairOrphanedOptions
): readonly string[] {
  const mode = options?.actionabilityMode ?? resolveActionabilityMode();
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

    // Issue 05: digest-based admission. Only the "no-executor" orphan path
    // reaches here; every other needs-leader-action state already has a
    // durable owner (candidate, integration, or pending wake) and is exempt.
    if (projection.reason === "no-executor") {
      const admission = admitOrphanWake(store, task.id, mode, options?.onSuppression);
      if (admission === "suppress") continue;
    }

    const taskWorkspace = store.getTaskWorkspace(task.id);
    if (!isSchedulerTaskWorkspaceReady(task, taskWorkspace)) {
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

/**
 * Decide whether one `task-orphaned` scan should wake the Leader. Returns
 * `"suppress"` only in enforce mode when the digest is unchanged since the
 * last waiting/blocked Leader Run. Shadow mode and fail-open always wake.
 */
function admitOrphanWake(
  store: SchedulerStorePort,
  taskId: string,
  mode: ActionabilityMode,
  onSuppression?: (suppression: OrphanWakeSuppression) => void
): "wake" | "suppress" {
  let digest: string;
  try {
    const input = collectTaskActionability(
      store as Parameters<typeof collectTaskActionability>[0],
      taskId
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
  if (decision.kind === "suppress") {
    onSuppression?.({
      taskId,
      mode,
      digest,
      observedDigest: decision.observedDigest,
      suppressed: mode === "enforce"
    });
    if (mode === "enforce") return "suppress";
  }
  return "wake";
}

/**
 * The most recent Leader Run (terminal or active). Active Runs are returned
 * so the admission check never suppresses while a Leader is still running.
 */
function findLastLeaderRun(
  store: SchedulerStorePort,
  taskId: string
): Pick<import("../run/agentRun.js").AgentRun, "status" | "disposition" | "observedActionabilityDigest"> | null {
  const runs = store.listAgentRuns?.(taskId) ?? [];
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
