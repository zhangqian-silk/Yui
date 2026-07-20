import type { SchedulerStorePort, TmuxDeliveryPort } from "./ports.js";
import { queueLeaderWakeup } from "./wakeupQueue.js";

export const EXITED_ROLE_RUN_SUMMARY = "The role's tmux session exited before the run yielded.";

/**
 * Lightweight liveness only: an active AgentRun whose tmux role is absent is
 * failed, then the Leader is durably queued. No TTL, cooldown, or schedules.
 */
export async function reconcileExitedRoleRuns(
  store: SchedulerStorePort,
  delivery: Pick<TmuxDeliveryPort, "inspectRole">,
  now: Date
): Promise<string[]> {
  const failed: string[] = [];
  for (const task of store.listTasks()) {
    for (const role of store.listRoles(task.id)) {
      const run = store.getActiveAgentRun(task.id, role.name);
      if (run === null) continue;
      const session = store.getRoleSession(task.id, role.name);
      const status = await delivery.inspectRole({
        taskId: task.id,
        roleName: role.name,
        agentId: role.activeAgentId,
        adapterId: role.adapterId,
        ...(session?.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: session.nativeSessionId })
      });
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
  }
  return failed;
}
