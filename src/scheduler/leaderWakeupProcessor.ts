import { createTaskEvent } from "../event/taskEvent.js";
import { createCycle, type CycleCause } from "../cycle/cycle.js";
import { compileDispatchInput } from "../context/dispatchContext.js";
import type { AgentSession } from "../executor/agentExecutor.js";
import { resolveAgentExecutor } from "../executor/executorRegistry.js";
import type { Role } from "../role/role.js";
import { updateRoleStatus } from "../role/role.js";
import type { AgentRun } from "../run/agentRun.js";
import { createAgentRun } from "../run/agentRun.js";
import type { LeaderFailure } from "./leaderFailure.js";
import { recordLeaderFailure } from "./leaderFailure.js";
import type { OperatorNotification } from "./operatorNotification.js";
import { createLeaderRecoveryNotification } from "./operatorNotification.js";
import type { PendingWakeup } from "./pendingWakeup.js";
import type { TaskSchedule } from "./taskSchedule.js";
import type { Task } from "../task/task.js";
import type { TaskReader, TaskStore } from "../storage/taskStore.js";
import { resolveTaskmuxHome } from "../storage/taskStore.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";

export type LeaderWakeupProcessingResult = {
  taskId: string;
  status: "dispatched" | "skipped" | "failed";
  error?: string;
};

type LeaderWakeupPreparation =
  | { kind: "skipped"; wakeup: PendingWakeup }
  | {
      kind: "ready";
      wakeup: PendingWakeup;
      task: Task;
      role: Role;
      session: AgentSession | null;
      run: AgentRun;
      input: string;
      schedule: TaskSchedule | null;
      previousLeaderFailure: LeaderFailure | null;
      previousOperatorNotification: OperatorNotification | null;
      eventIds: readonly [string, string];
      cycleId: string;
    };

export function processLeaderWakeups(
  store: TaskStore,
  tmux: TmuxManager,
  now: Date
): LeaderWakeupProcessingResult[] {
  const preparedWakeups = store.runReadSnapshot((snapshot) =>
    snapshot.listPendingWakeups().map((wakeup) => prepareLeaderWakeup(snapshot, wakeup, now))
  );

  return preparedWakeups.map((preparation) => {
    if (preparation.kind === "skipped") {
      return { taskId: preparation.wakeup.taskId, status: "skipped" };
    }

    const { wakeup, task, role, session, run, input, schedule } = preparation;
    let effectiveSession: AgentSession | null = session;
    try {
      const mode = session === null || session.status === "reserved" ? "new" : "resume";
      const executor = resolveAgentExecutor(role.agent);
      const dispatchInput = {
        runtime: tmux,
        taskmuxHome: resolveTaskmuxHome(process.env),
        taskId: task.id,
        role,
        run,
        session,
        input,
        now
      };
      const dispatched = mode === "new" ? executor.start(dispatchInput) : executor.recover(dispatchInput);
      effectiveSession = dispatched.session;

      store.saveAgentRun(run);
      store.saveActiveAgentRun(run);
      store.saveRole(task.id, updateRoleStatus(role, "running", now));
      if (effectiveSession !== null) {
        store.saveAgentSession({ ...effectiveSession, status: "running", updatedAt: now.toISOString() });
      }
      if (schedule !== null) {
        store.saveTaskSchedule(task.id, {
          ...schedule,
          lastLeaderWakeupAt: now.toISOString(),
          updatedAt: now.toISOString()
        });
      }
      store.saveEvent(task.id, createTaskEvent(
        preparation.eventIds[0],
        "leader.wakeup_dispatched",
        { reasons: wakeup.reasons.join(",") },
        now
      ));
      const cycle = createCycle(
        preparation.cycleId,
        task.id,
        cycleCauseForWakeup(wakeup.reasons),
        `Leader wakeup: ${wakeup.reasons.join(", ")}`,
        now
      );
      store.saveCycle(task.id, cycle);
      store.saveEvent(task.id, createTaskEvent(
        preparation.eventIds[1],
        "cycle.created",
        { cycle: cycle.id, cause: cycle.cause },
        now
      ));
      store.clearPendingWakeupIfUnchanged(wakeup);
      return { taskId: task.id, status: "dispatched" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.saveLeaderFailure(recordLeaderFailure(
        task.id,
        effectiveSession?.nativeSessionId ?? "(unregistered)",
        message,
        now,
        preparation.previousLeaderFailure
      ));
      store.saveOperatorNotification(createLeaderRecoveryNotification(
        task.id,
        message,
        now,
        preparation.previousOperatorNotification
      ));
      try {
        tmux.sendRoleInput(
          "operator",
          "operator",
          `TaskMux alert: Leader recovery failed for ${task.id}. ${message}`
        );
      } catch {
        // The durable notification remains available when Operator is not running.
      }
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

function prepareLeaderWakeup(
  store: TaskReader,
  wakeup: PendingWakeup,
  now: Date
): LeaderWakeupPreparation {
  const task = store.getTask(wakeup.taskId);
  const role = store.getRole(wakeup.taskId, "leader");
  const session = store.getAgentSession(wakeup.taskId, "leader");
  const previousLeaderFailure = store.getLeaderFailure(wakeup.taskId);
  const previousOperatorNotification = store.getOperatorNotification(wakeup.taskId);
  if (
    task === null ||
    task.archived ||
    role === null ||
    previousLeaderFailure !== null ||
    store.getActiveAgentRun(wakeup.taskId, "leader") !== null
  ) {
    return { kind: "skipped", wakeup };
  }
  const mode = session === null || session.status === "reserved" ? "new" : "resume";
  const input = [
    `TaskMux wakeup reasons: ${wakeup.reasons.join(", ")}.`,
    `Run taskmux task context ${task.id} --format json, then continue Leader stewardship.`
  ].join(" ");
  const compiledInput = compileDispatchInput(store, task.id, role, input);
  const eventCount = store.listEvents(task.id).length;
  return {
    kind: "ready",
    wakeup,
    task,
    role,
    session,
    run: createAgentRun(
      store.nextAgentRunId(task.id),
      task.id,
      role.name,
      mode,
      compiledInput,
      now
    ),
    input: compiledInput,
    schedule: store.getTaskSchedule(task.id),
    previousLeaderFailure,
    previousOperatorNotification,
    eventIds: [`event-${eventCount + 1}`, `event-${eventCount + 2}`],
    cycleId: store.nextCycleId(task.id)
  };
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
