import {
  selectedSchedulerRoles,
  selectedSchedulerTasks,
  type SchedulerReconcileSelection,
  type SchedulerStorePort,
  type TmuxDeliveryPort
} from "./ports.js";
import { queueLeaderWakeup } from "./wakeupQueue.js";

export const EXITED_ROLE_RUN_SUMMARY = "The role's tmux session exited before the run yielded.";
export const DEFAULT_READY_RECOVERY_AGE_MS = 120_000;

export type RoleLiveStatus = "present" | "absent";
export type RoleLiveStatusSnapshot = ReadonlyMap<string, RoleLiveStatus>;

type RoleRunCandidate = Readonly<{
  task: ReturnType<typeof selectedSchedulerTasks>[number];
  role: ReturnType<typeof selectedSchedulerRoles>[number];
  run: NonNullable<ReturnType<SchedulerStorePort["getActiveAgentRun"]>>;
  session: ReturnType<SchedulerStorePort["getRoleSession"]>;
  inspection: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
  }>;
}>;

/**
 * Lightweight liveness only: an active AgentRun whose tmux role is absent is
 * failed, then the Leader is durably queued. No TTL, cooldown, or schedules.
 */
export async function reconcileExitedRoleRuns(
  store: SchedulerStorePort,
  delivery: Pick<
    TmuxDeliveryPort,
    "inspectRole" | "inspectRoles" | "inspectRoleReadiness" | "forgetPrepared"
  >,
  now: Date,
  selection?: SchedulerReconcileSelection,
  excludedRunIds: ReadonlySet<string> = new Set(),
  minimumReadyRecoveryAgeMs = DEFAULT_READY_RECOVERY_AGE_MS,
  readyRecoveryRunIds: ReadonlySet<string> = new Set(),
  liveStatuses?: Map<string, RoleLiveStatus>
): Promise<string[]> {
  const failed: string[] = [];
  const candidates = activeRunCandidates(store, selection);
  if (candidates.length === 0) return failed;
  const completing = new Set(
    store.listPendingRuntimeTurnCompletions().map((completion) => (
      `${completion.taskId}\0${completion.roleName}\0${completion.runId}`
    ))
  );
  const eligible = candidates.filter(({ task, role, run }) => (
    !excludedRunIds.has(run.id)
    && !completing.has(`${task.id}\0${role.name}\0${run.id}`)
  ));
  // Build one complete provider inventory for every active Run, including
  // delivery-uncertain and completion-pending Runs. Those Runs are excluded
  // only from destructive liveness transitions below; omitting them here
  // would leave the shared stall pass with an incomplete snapshot and make a
  // live-but-unaccepted Run invisible to delivery-stall attention.
  const hasCompleteSharedSnapshot = liveStatuses !== undefined
    && candidates.every(({ task, role }) => (
      liveStatuses.has(roleIdentity(task.id, role.name))
    ));
  const batchStatuses = hasCompleteSharedSnapshot
    ? liveStatuses
    : await inspectRoleStatuses(delivery, candidates);
  if (liveStatuses !== undefined) {
    for (const [key, status] of batchStatuses) liveStatuses.set(key, status);
  }
  for (const { task, role, run, session, inspection } of eligible) {
      const status = batchStatuses.get(`${task.id}\0${role.name}`);
      if (status === undefined) throw new Error("Role liveness snapshot is incomplete.");
      if (status === "present") {
        const isFullReconciliation = selection === undefined || selection.full;
        const readyRecoveryDue = readyRecoveryRunIds.has(run.id)
          || (
            isFullReconciliation
            && run.deliveredAt !== undefined
            && now.getTime() - Date.parse(run.deliveredAt) >= minimumReadyRecoveryAgeMs
          );
        if (
          readyRecoveryDue
          && run.deliveredAt !== undefined
          && delivery.inspectRoleReadiness !== undefined
          && store.recoverReadyRoleRun !== undefined
          && await delivery.inspectRoleReadiness(inspection) === "ready"
        ) {
          store.recoverReadyRoleRun({
            taskId: task.id,
            roleName: role.name,
            runId: run.id,
            now
          });
          delivery.forgetPrepared?.({
            taskId: task.id,
            roleName: role.name,
            runId: run.id
          });
        }
        continue;
      }

      const persisted = store.saveExitedRoleRun({
        task,
        role,
        run,
        session,
        summary: EXITED_ROLE_RUN_SUMMARY,
        now
      });
      if (persisted === "state-changed") continue;
      delivery.forgetPrepared?.({
        taskId: task.id,
        roleName: role.name,
        runId: run.id
      });
      failed.push(run.id);
      // Compatibility for narrow in-memory/custom ports that predate the
      // adapter's atomic failure+wake transition. Production returns
      // "failed" and already enqueued this wake in the same transaction.
      if (persisted === undefined && task.status === "active") {
        queueLeaderWakeup(
          store,
          task.id,
          role.name === "leader" ? "leader-run-failed" : "role-run-failed",
          now
        );
      }
  }
  return failed;
}

function activeRunCandidates(
  store: SchedulerStorePort,
  selection?: SchedulerReconcileSelection
): RoleRunCandidate[] {
  return selectedSchedulerTasks(store, selection).flatMap((task) => (
    selectedSchedulerRoles(store, task.id, selection).flatMap((role) => {
      const run = store.getActiveAgentRun(task.id, role.name);
      if (run === null) return [];
      const session = store.getRoleSession(task.id, role.name);
      return [{
        task,
        role,
        run,
        session,
        inspection: {
          taskId: task.id,
          roleName: role.name,
          agentId: role.activeAgentId,
          adapterId: role.adapterId,
          ...(session?.nativeSessionId === undefined
            ? {}
            : { nativeSessionId: session.nativeSessionId })
        }
      }];
    })
  ));
}

async function inspectRoleStatuses(
  delivery: Pick<TmuxDeliveryPort, "inspectRole" | "inspectRoles">,
  candidates: readonly RoleRunCandidate[]
): Promise<RoleLiveStatusSnapshot> {
  if (delivery.inspectRoles !== undefined) {
    const batch = await delivery.inspectRoles(candidates.map(({ inspection }) => inspection));
    return exactBatchStatuses(batch, candidates);
  }
  const entries = [];
  for (const candidate of candidates) {
    entries.push({
      key: roleIdentity(candidate.task.id, candidate.role.name),
      status: await delivery.inspectRole(candidate.inspection)
    });
  }
  return new Map(entries.map(({ key, status }) => [key, status]));
}

function exactBatchStatuses(
  batch: readonly Readonly<{
    taskId: string;
    roleName: string;
    status: "present" | "absent";
  }>[],
  candidates: readonly Readonly<{
    task: Readonly<{ id: string }>;
    role: Readonly<{ name: string }>;
  }>[]
): Map<string, "present" | "absent"> {
  const expected = new Set(candidates.map(({ task, role }) => `${task.id}\0${role.name}`));
  const statuses = new Map<string, "present" | "absent">();
  for (const entry of batch) {
    const key = `${entry.taskId}\0${entry.roleName}`;
    if (!expected.has(key) || statuses.has(key)) {
      throw new Error("Tmux Role batch liveness snapshot is invalid.");
    }
    statuses.set(key, entry.status);
  }
  if (statuses.size !== expected.size) {
    throw new Error("Tmux Role batch liveness snapshot is incomplete.");
  }
  return statuses;
}

function roleIdentity(taskId: string, roleName: string): string {
  return `${taskId}\0${roleName}`;
}
