import { randomUUID } from "node:crypto";
import { createTaskEvent } from "../event/taskEvent.js";
import { createCycle, type CycleCause } from "../cycle/cycle.js";
import { compileDispatchInput } from "../context/dispatchContext.js";
import { buildAgentLaunchPlan, withTaskmuxRunEnvironment } from "../executor/launchPlan.js";
import { recordAgentSession, type AgentSession } from "../executor/agentExecutor.js";
import { updateRoleStatus } from "../role/role.js";
import { createAgentRun } from "../run/agentRun.js";
import { recordLeaderFailure } from "./leaderFailure.js";
import type { TaskStore } from "../storage/taskStore.js";
import { resolveTaskmuxHome } from "../storage/taskStore.js";
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
      store.getLeaderFailure(wakeup.taskId) !== null ||
      store.getActiveAgentRun(wakeup.taskId, "leader") !== null
    ) {
      return { taskId: wakeup.taskId, status: "skipped" };
    }

    let effectiveSession: AgentSession | null = session;
    try {
      const mode = session === null ? "new" : "resume";
      const input = [
        `TaskMux wakeup reasons: ${wakeup.reasons.join(", ")}.`,
        `Run taskmux task context ${task.id} --format json, then continue Leader stewardship.`
      ].join(" ");
      const compiledInput = compileDispatchInput(store, task.id, role, input);
      const run = createAgentRun(
        store.nextAgentRunId(task.id),
        task.id,
        role.name,
        mode,
        compiledInput,
        now
      );
      let baseLaunch = buildAgentLaunchPlan(role, mode, session);
      if (mode === "new" && role.agent === "claude") {
        const nativeSessionId = randomUUID();
        effectiveSession = recordAgentSession(
          task.id,
          role.name,
          role.agent,
          nativeSessionId,
          now,
          null
        );
        baseLaunch = { ...baseLaunch, args: [...baseLaunch.args, "--session-id", nativeSessionId] };
      }
      const launch = withTaskmuxRunEnvironment(
        baseLaunch,
        resolveTaskmuxHome(process.env),
        role,
        run,
        effectiveSession?.nativeSessionId
      );
      tmux.dispatchRole(task.id, role, launch, compiledInput, { replaceExisting: mode === "new" });

      store.saveAgentRun(run);
      store.saveActiveAgentRun(run);
      store.saveRole(task.id, updateRoleStatus(role, "running", now));
      if (effectiveSession !== null) {
        store.saveAgentSession({ ...effectiveSession, status: "running", updatedAt: now.toISOString() });
      }
      const schedule = store.getTaskSchedule(task.id);
      if (schedule !== null) {
        store.saveTaskSchedule(task.id, {
          ...schedule,
          lastLeaderWakeupAt: now.toISOString(),
          updatedAt: now.toISOString()
        });
      }
      store.saveEvent(task.id, createTaskEvent(
        store.nextEventId(task.id),
        "leader.wakeup_dispatched",
        { reasons: wakeup.reasons.join(",") },
        now
      ));
      const cycle = createCycle(
        store.nextCycleId(task.id),
        task.id,
        cycleCauseForWakeup(wakeup.reasons),
        `Leader wakeup: ${wakeup.reasons.join(", ")}`,
        now
      );
      store.saveCycle(task.id, cycle);
      store.saveEvent(task.id, createTaskEvent(
        store.nextEventId(task.id),
        "cycle.created",
        { cycle: cycle.id, cause: cycle.cause },
        now
      ));
      store.clearPendingWakeup(task.id);
      return { taskId: task.id, status: "dispatched" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.saveLeaderFailure(recordLeaderFailure(
        task.id,
        effectiveSession?.nativeSessionId ?? "(unregistered)",
        message,
        now,
        store.getLeaderFailure(task.id)
      ));
      if (effectiveSession !== null) {
        store.saveAgentSession({ ...effectiveSession, status: "broken", updatedAt: now.toISOString() });
      }
      store.saveRole(task.id, updateRoleStatus(role, "failed", now));
      return {
        taskId: task.id,
        status: "failed",
        error: message
      };
    }
  });
}

function cycleCauseForWakeup(reasons: string[]): CycleCause {
  const supported = reasons.find((reason): reason is CycleCause => [
    "task-created",
    "user-comment",
    "schedule",
    "review-time",
    "operator-input",
    "role-result",
    "inactivity",
    "explicit-wake"
  ].includes(reason));

  if (supported !== undefined) {
    return supported;
  }
  if (reasons.some((reason) => reason.startsWith("role-") || reason.startsWith("leader-run-"))) {
    return "role-result";
  }
  return "explicit-wake";
}
