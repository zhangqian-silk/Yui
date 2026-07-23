import {
  selectedSchedulerRoles,
  selectedSchedulerTasks,
  type SchedulerReconcileSelection,
  type SchedulerStorePort,
  type TmuxDeliveryPort
} from "./ports.js";
import { queueLeaderWakeup } from "./wakeupQueue.js";

export const EXITED_ROLE_RUN_SUMMARY = "The role's tmux session exited before the run yielded.";

/**
 * Lightweight liveness only: an active AgentRun whose tmux role is absent is
 * failed, then the Leader is durably queued. No TTL, cooldown, or schedules.
 */
export async function reconcileExitedRoleRuns(
  store: SchedulerStorePort,
  delivery: Pick<TmuxDeliveryPort, "inspectRole" | "inspectRoles">,
  now: Date,
  selection?: SchedulerReconcileSelection
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
  const batch = delivery.inspectRoles === undefined
    ? null
    : await delivery.inspectRoles(candidates.map((candidate) => candidate.inspection));
  const batchStatuses = new Map(
    (batch ?? []).map((entry) => [
      `${entry.taskId}\0${entry.roleName}`,
      entry.status
    ])
  );
  for (const { task, role, run, session, inspection } of candidates) {
      const status = batch === null
        ? await delivery.inspectRole(inspection)
        : batchStatuses.get(`${task.id}\0${role.name}`) ?? "absent";
      if (status === "present") continue;

      store.saveExitedRoleRun({
        task,
        role,
        run,
        session,
        summary: EXITED_ROLE_RUN_SUMMARY,
        now
      });
      failed.push(run.id);
      if (task.status === "active") {
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
