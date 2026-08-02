import {
  selectedSchedulerRoles,
  selectedSchedulerTasks,
  type SchedulerReconcileSelection,
  type SchedulerStorePort,
  type TmuxDeliveryPort
} from "./ports.js";
import { queueLeaderWakeup } from "./wakeupQueue.js";

export const EXITED_ROLE_RUN_SUMMARY = "The role's tmux session exited before the run yielded.";
export const MISSING_TURN_HOOK_SUMMARY =
  "The role returned to its composer without a matching native Turn Hook.";
export const DEFAULT_READY_RECOVERY_AGE_MS = 120_000;

export type ReadyRecoveryControl = Readonly<{
  confirmedRunIds: ReadonlySet<string>;
  observedRunIds: Set<string>;
}>;

/**
 * Lightweight liveness only: an active AgentRun whose tmux role is absent is
 * failed, then the Leader is durably queued. No TTL, cooldown, or schedules.
 */
export async function reconcileExitedRoleRuns(
  store: SchedulerStorePort,
  delivery: Pick<
    TmuxDeliveryPort,
    "inspectRole" | "inspectRoles" | "inspectRoleReadiness" | "stopRole" | "forgetPrepared"
  >,
  now: Date,
  selection?: SchedulerReconcileSelection,
  excludedRunIds: ReadonlySet<string> = new Set(),
  minimumReadyRecoveryAgeMs = DEFAULT_READY_RECOVERY_AGE_MS,
  readyRecoveryRunIds: ReadonlySet<string> = new Set(),
  readyRecoveryControl?: ReadyRecoveryControl
): Promise<string[]> {
  const failed: string[] = [];
  const candidates = selectedSchedulerTasks(store, selection).flatMap((task) => (
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
  if (eligible.length === 0) return failed;
  const batch = delivery.inspectRoles === undefined
    ? null
    : await delivery.inspectRoles(eligible.map((candidate) => candidate.inspection));
  const batchStatuses = batch === null
    ? new Map<string, "present" | "absent">()
    : exactBatchStatuses(batch, eligible);
  for (const { task, role, run, session, inspection } of eligible) {
      const status = batch === null
        ? await delivery.inspectRole(inspection)
        : batchStatuses.get(`${task.id}\0${role.name}`)!;
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
          && delivery.stopRole !== undefined
          && await delivery.inspectRoleReadiness(inspection) === "ready"
        ) {
          readyRecoveryControl?.observedRunIds.add(run.id);
          if (!readyRecoveryControl?.confirmedRunIds.has(run.id)) continue;
          // Readiness proves quiescence, not Turn completion. Stop the exact
          // generation before releasing durable state so a late Hook is stale.
          if (!await delivery.stopRole(task.id, role.name)) continue;
          const persisted = store.saveExitedRoleRun({
            task,
            role,
            run,
            session,
            reason: "missing-turn-hook",
            summary: MISSING_TURN_HOOK_SUMMARY,
            now
          });
          if (persisted === "state-changed") continue;
          delivery.forgetPrepared?.({
            taskId: task.id,
            roleName: role.name,
            runId: run.id
          });
          failed.push(run.id);
          if (persisted === undefined && task.status === "active") {
            queueLeaderWakeup(
              store,
              task.id,
              role.name === "leader" ? "leader-run-failed" : "role-run-failed",
              now
            );
          }
        }
        continue;
      }

      const persisted = store.saveExitedRoleRun({
        task,
        role,
        run,
        session,
        reason: "host-exited",
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
