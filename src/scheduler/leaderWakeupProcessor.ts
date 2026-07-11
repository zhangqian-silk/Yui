import { createTaskEvent } from "../event/taskEvent.js";
import { compileDispatchInput } from "../context/dispatchContext.js";
import { buildAgentLaunchPlan } from "../executor/launchPlan.js";
import { updateRoleStatus } from "../role/role.js";
import { createAgentRun } from "../run/agentRun.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";

export type LeaderWakeupProcessingResult = {
  taskId: string;
  status: "dispatched" | "skipped" | "failed";
  error?: string;
};

export function processLeaderWakeups(
  store: TaskStore,
  tmux: TmuxManager,
  now: Date
): LeaderWakeupProcessingResult[] {
  return store.listPendingWakeups().map((wakeup) => {
    const task = store.getTask(wakeup.taskId);
    const role = store.getRole(wakeup.taskId, "leader");
    const session = store.getAgentSession(wakeup.taskId, "leader");

    if (
      task === null ||
      task.archived ||
      role === null ||
      session === null ||
      store.getActiveAgentRun(wakeup.taskId, "leader") !== null
    ) {
      return { taskId: wakeup.taskId, status: "skipped" };
    }

    try {
      const input = [
        `TaskMux wakeup reasons: ${wakeup.reasons.join(", ")}.`,
        `Run taskmux task context ${task.id} --format json, then continue Leader stewardship.`
      ].join(" ");
      const launch = buildAgentLaunchPlan(role, "resume", session);
      const compiledInput = compileDispatchInput(store, task.id, role, input);
      tmux.dispatchRole(task.id, role, launch, compiledInput);

      const run = createAgentRun(
        store.nextAgentRunId(task.id),
        task.id,
        role.name,
        "resume",
        compiledInput,
        now
      );
      store.saveAgentRun(run);
      store.saveActiveAgentRun(run);
      store.saveRole(task.id, updateRoleStatus(role, "running", now));
      store.saveAgentSession({ ...session, status: "running", updatedAt: now.toISOString() });
      store.saveEvent(task.id, createTaskEvent(
        store.nextEventId(task.id),
        "leader.wakeup_dispatched",
        { reasons: wakeup.reasons.join(",") },
        now
      ));
      store.clearPendingWakeup(task.id);
      return { taskId: task.id, status: "dispatched" };
    } catch (error) {
      return {
        taskId: task.id,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
}
