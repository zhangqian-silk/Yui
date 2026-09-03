import { createTaskEvent } from "../event/taskEvent.js";
import { updateExecutionLane } from "../execution/workItemExecution.js";
import { usageError } from "../errors/cliError.js";
import { requestDurableJobCancel } from "../job/durableJob.js";
import { finishReviewRound, updateReviewExecutionGroup } from "../review/reviewRound.js";
import { failTurn, type Turn } from "../turn/turn.js";
import { queueLeaderWakeup } from "../scheduler/wakeupQueue.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  startTaskExecution,
  stopTaskExecution,
  type TaskCompletedBy
} from "../task/task.js";
import { taskActor } from "./taskActor.js";

export type TaskExecutionStopRequest = Readonly<{
  taskId: string;
  reason: string;
}>;

export type TaskExecutionStopResult = Readonly<{
  taskId: string;
  changed: boolean;
  roleNames: readonly string[];
  terminatedTurnIds: readonly string[];
  cancelledJobIds: readonly string[];
  output: string;
}>;

export type TaskExecutionStartResult = Readonly<{
  taskId: string;
  changed: boolean;
  output: string;
}>;

export function parseTaskExecutionStopRequest(args: readonly string[]): TaskExecutionStopRequest {
  const taskId = args[0];
  if (taskId === undefined || taskId.startsWith("--")) {
    throw usageError("Task execution stop usage: yui task execution stop <task> --force --reason <text>.");
  }
  let force = false;
  let reason: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--force" && !force) {
      force = true;
      continue;
    }
    if (argument === "--reason" && reason === undefined) {
      reason = args[index + 1];
      index += 1;
      continue;
    }
    throw usageError(`Unknown or duplicated Task execution stop option: ${String(argument)}.`);
  }
  if (!force) throw usageError("Task execution stop requires --force.");
  const normalizedReason = reason?.trim();
  if (normalizedReason === undefined
    || normalizedReason.length === 0
    || normalizedReason.startsWith("--")) {
    throw usageError("Task execution stop requires --reason <text>.");
  }
  return { taskId, reason: normalizedReason };
}

export function parseTaskExecutionStartRequest(args: readonly string[]): string {
  if (args.length !== 1 || args[0]!.startsWith("--")) {
    throw usageError("Task execution start usage: yui task execution start <task>.");
  }
  return args[0]!;
}

/**
 * Fence execution before touching the physical runtime. Progress records and
 * workspaces remain intact; only current attempts and delivery claims end.
 */
export function stopTaskExecutionCommand(
  request: TaskExecutionStopRequest,
  store: TaskStore,
  options: Readonly<{ now?: () => Date; environment?: NodeJS.ProcessEnv }> = {}
): TaskExecutionStopResult {
  const now = options.now?.() ?? new Date();
  const actor = requireOperatorOrUser(options.environment, request.taskId);
  return store.transaction((tx) => {
    const task = tx.getTask(request.taskId);
    if (task === null) throw usageError(`Task not found: ${request.taskId}.`);
    if (task.status !== "active") {
      throw usageError(`Only an active Task can be stopped: ${task.id}.`);
    }

    const changed = task.executionGate.state !== "stopped";
    tx.saveTask(stopTaskExecution(task, now));

    const activeTurns = tx.listTurns(task.id).filter((run) => run.status === "active");
    const activeJobs = tx.listDurableJobs(task.id)
      .filter((job) => job.status === "queued" || job.status === "running");
    for (const job of activeJobs) {
      tx.saveDurableJob(task.id, requestDurableJobCancel(job, now));
    }
    failExecutionAttempts(tx, task.id, activeTurns, request.reason, now);
    for (const run of activeTurns) {
      tx.saveTurn(failTurn(
        run,
        "cancelled",
        `Task execution stopped: ${request.reason}`,
        now
      ));
      if (run.executionGroupId !== undefined && run.executionLaneId !== undefined) {
        tx.clearActiveExecutionLaneTurn(task.id, run.executionGroupId, run.executionLaneId);
      }
      tx.clearActiveTurn(task.id, run.roleName);
    }

    const roleNames = taskRuntimeRoleNames(tx, task.id, activeTurns);
    for (const roleName of roleNames) {
      tx.clearActiveTurn(task.id, roleName);
    }
    // A stop is allowed to discard stale pointer projections even when their
    // historical Turns are already terminal.
    for (const run of tx.listTurns(task.id)) {
      if (run.executionGroupId !== undefined && run.executionLaneId !== undefined) {
        tx.clearActiveExecutionLaneTurn(task.id, run.executionGroupId, run.executionLaneId);
      }
    }

    for (const mailbox of tx.listWorkMailboxes()) {
      if ("taskId" in mailbox.target && mailbox.target.taskId === task.id) {
        tx.removeWorkMailbox(mailbox.target);
      }
    }
    tx.clearLeaderFailure(task.id);
    tx.saveEvent(task.id, createTaskEvent(
      tx.nextEventId(task.id),
      task.id,
      "task.execution-stopped",
      {
        by: actor,
        reason: request.reason,
        terminatedRuns: String(activeTurns.length)
      },
      now
    ));

    return {
      taskId: task.id,
      changed,
      roleNames,
      terminatedTurnIds: activeTurns.map(({ id }) => id),
      cancelledJobIds: activeJobs.map(({ id }) => id),
      output: changed
        ? `Stopped Task execution: ${task.id}. Progress was preserved; `
          + `${activeTurns.length} active attempt(s) were terminated and `
          + `${activeJobs.length} DurableJob(s) were cancelled.`
        : `Task execution is already stopped: ${task.id}. Runtime cleanup will be verified.`
    };
  });
}

/** Enable execution only after the caller has proven all old physical writers absent. */
export function startTaskExecutionCommand(
  taskId: string,
  store: TaskStore,
  options: Readonly<{ now?: () => Date; environment?: NodeJS.ProcessEnv }> = {}
): TaskExecutionStartResult {
  const now = options.now?.() ?? new Date();
  const actor = requireOperatorOrUser(options.environment, taskId);
  return store.transaction((tx) => {
    const task = tx.getTask(taskId);
    if (task === null) throw usageError(`Task not found: ${taskId}.`);
    if (task.status !== "active") {
      throw usageError(`Only an active Task can be started: ${task.id}.`);
    }
    if (task.executionGate.state === "enabled") {
      return { taskId: task.id, changed: false, output: `Task execution is already enabled: ${task.id}.` };
    }
    if (tx.listTurns(task.id).some((run) => run.status === "active")
      || tx.listDurableJobs(task.id).some((job) => job.status === "queued" || job.status === "running")) {
      throw usageError(`Task still has an active execution attempt: ${task.id}.`);
    }

    for (const mailbox of tx.listWorkMailboxes()) {
      if ("taskId" in mailbox.target && mailbox.target.taskId === task.id) {
        tx.removeWorkMailbox(mailbox.target);
      }
    }
    tx.clearLeaderFailure(task.id);
    tx.saveTask(startTaskExecution(task, now));
    queueLeaderWakeup(tx, task.id, "execution-started", now);
    tx.saveEvent(task.id, createTaskEvent(
      tx.nextEventId(task.id),
      task.id,
      "task.execution-started",
      { by: actor },
      now
    ));
    return {
      taskId: task.id,
      changed: true,
      output: `Started Task execution: ${task.id}. The Leader will continue from durable progress.`
    };
  });
}

/** Remove cleanup-generated delivery records after physical release is proven. */
export function finalizeStoppedTaskExecution(taskId: string, store: TaskStore): void {
  store.transaction((tx) => {
    const task = tx.getTask(taskId);
    if (task === null) throw usageError(`Task not found: ${taskId}.`);
    if (task.executionGate.state !== "stopped") {
      throw usageError(`Task execution is not stopped: ${taskId}.`);
    }
    for (const mailbox of tx.listWorkMailboxes()) {
      if ("taskId" in mailbox.target && mailbox.target.taskId === taskId) {
        tx.removeWorkMailbox(mailbox.target);
      }
    }
    tx.clearLeaderFailure(taskId);
  });
}

function requireOperatorOrUser(
  environment: NodeJS.ProcessEnv | undefined,
  taskId: string
): Exclude<TaskCompletedBy, "leader"> {
  const actor = taskActor(environment, taskId);
  if (actor === "leader") {
    throw usageError("Task execution stop/start requires the global Operator or a human user.");
  }
  return actor;
}

function taskRuntimeRoleNames(
  store: TaskStore,
  taskId: string,
  turns: readonly Turn[]
): readonly string[] {
  const names = new Set<string>(store.listRoles(taskId).map(({ name }) => name));
  for (const sessions of store.listRoleSessionSets(taskId)) names.add(sessions.owner.roleName);
  for (const turn of turns) names.add(turn.roleName);
  for (const owner of store.listSessionOwners()) {
    if (owner.owner.scope === "task" && owner.owner.taskId === taskId) {
      names.add(owner.owner.roleName);
    }
  }
  return [...names].sort();
}

function failExecutionAttempts(
  store: TaskStore,
  taskId: string,
  turns: readonly Turn[],
  reason: string,
  now: Date
): void {
  const summary = `Task execution stopped: ${reason}`;
  const reviewRounds = new Map(store.listReviewRounds(taskId).map((round) => [round.id, round]));
  const affectedReviewRoundIds = new Set<string>();

  for (const turn of turns) {
    if (turn.reviewRoundId !== undefined) {
      affectedReviewRoundIds.add(turn.reviewRoundId);
      if (turn.executionGroupId === undefined || turn.executionLaneId === undefined) continue;
      const round = reviewRounds.get(turn.reviewRoundId);
      const group = round?.executionGroup?.id === turn.executionGroupId
        ? round.executionGroup
        : undefined;
      const lane = group?.lanes.find(({ id }) => id === turn.executionLaneId);
      if (round !== undefined && group !== undefined && lane !== undefined
        && lane.disposition === "open") {
        reviewRounds.set(round.id, updateReviewExecutionGroup(
          round,
          updateExecutionLane(group, lane.id, {
            currentTurnId: turn.id,
            disposition: "failed"
          }, now)
        ));
      }
    }
  }

  for (const reviewRoundId of affectedReviewRoundIds) {
    const round = reviewRounds.get(reviewRoundId)!;
    const original = store.getReviewRound(round.taskId, round.id);
    if (original === null) continue;
    const changed = JSON.stringify(original.executionGroup) !== JSON.stringify(round.executionGroup);
    const terminal = round.status === "pending" || round.status === "running"
      ? finishReviewRound(round, "failed", summary, now)
      : round;
    if (changed || terminal !== round) store.saveReviewRound(round.taskId, terminal);
  }
}
