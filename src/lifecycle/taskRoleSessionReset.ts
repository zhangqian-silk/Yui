import { enqueueWork } from "../coordination/workMailboxQueue.js";
import { resetTaskRoleSession } from "../executor/agentExecutor.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { createTaskMessage } from "../message/message.js";
import { updateRoleStatus } from "../role/role.js";
import { createLeaderRecoveryNotification } from "../scheduler/operatorNotification.js";
import { recordLeaderFailure } from "../scheduler/leaderFailure.js";
import {
  RUNTIME_CLEANUP_REQUIRED_REASON,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import type { AgentRun } from "../run/agentRun.js";
import type { TaskStore } from "../storage/taskStore.js";
import { formatAgentRunReceiptId } from "../task/taskRecordReference.js";
import {
  updateWorkItemStatus,
  workItemOwnsUnresolvedExecutionLane
} from "../workItem/workItem.js";
import { terminalizeExactTaskRun } from "./exactRunTerminalization.js";

export type ResetTaskRoleSessionResult = Readonly<{
  taskId: string;
  roleName: string;
  run: AgentRun | null;
  nativeSessionId?: string;
}>;

/**
 * Resets the current native generation using Yui's own persisted identities.
 * The caller supplies intent only; the Controller verifies process cleanup.
 */
export function resetTaskRoleSessionGeneration(
  store: TaskStore,
  taskId: string,
  roleName: string,
  reason: string,
  now: Date
): ResetTaskRoleSessionResult {
  const task = store.getTask(requiredIdentity(taskId, "Task id"));
  if (task === null) throw new Error(`Task not found: ${taskId}.`);
  if (task.status !== "active") throw new Error(`Task is not active: ${task.id}/${task.status}.`);
  const normalizedRole = requiredIdentity(roleName, "Role name");
  const role = store.getRole(task.id, normalizedRole);
  if (role === null) throw new Error(`Role not found: ${task.id}/${normalizedRole}.`);
  const summary = `Reset native Session: ${requiredText(reason, "Reset reason")}`;
  let sessions = store.getTaskRoleSessionSet(task.id, role.name);
  const current = sessions?.sessions[sessions.activeAgentId];
  const activeRun = store.getActiveAgentRun(task.id, role.name);

  if (activeRun !== null) {
    const receiptId = sessions?.inFlight?.runId === activeRun.id
      ? sessions.inFlight.receiptId
      : formatAgentRunReceiptId(task.id, activeRun.id);
    const terminal = terminalizeExactTaskRun(store, {
      taskId: task.id,
      roleName: role.name,
      agentId: activeRun.effective.agentId,
      runId: activeRun.id,
      receiptId,
      ...(current === undefined ? {} : {
        nativeSessionId: current.nativeSessionId,
        ...(current.launchId === undefined ? {} : { launchId: current.launchId })
      }),
      outcome: { status: "failed", summary }
    }, now);
    if (terminal.disposition !== "applied" || terminal.run === null) {
      throw new Error(`Task Role reset lost its exact Run fence: ${terminal.reason ?? "obsolete"}.`);
    }
    if (activeRun.purpose === "execution" && activeRun.workItemId !== undefined) {
      const item = store.getWorkItem(task.id, activeRun.workItemId);
      if (item !== null
        && !["completed", "failed", "retired"].includes(item.status)
        && !workItemOwnsUnresolvedExecutionLane(
          item,
          activeRun.executionGroupId,
          activeRun.executionLaneId
        )) {
        store.saveWorkItem(task.id, updateWorkItemStatus(item, "failed", now, summary));
      }
    }
  }

  enqueueWork(store, runtimeLifecycleTarget({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  }), RUNTIME_CLEANUP_REQUIRED_REASON, now, [{ type: "task", id: task.id }]);

  sessions = store.getTaskRoleSessionSet(task.id, role.name);
  if (sessions !== null) store.saveTaskRoleSessionSet(resetTaskRoleSession(sessions, now));
  const updatedRole = store.getRole(task.id, role.name)!;
  store.saveRole(task.id, updateRoleStatus(
    updatedRole,
    role.name === "leader" ? "failed" : "idle",
    now
  ));

  const message = createTaskMessage(
    store.nextMessageId(task.id),
    task.id,
    summary,
    "system",
    { type: "system" },
    now,
    activeRun === null ? {} : {
      runId: activeRun.id,
      ...(activeRun.workItemId === undefined ? {} : { workItemId: activeRun.workItemId })
    }
  );
  store.saveMessage(task.id, message);
  store.saveEvent(task.id, createTaskEvent(
    store.nextEventId(task.id),
    task.id,
    "runtime.role-session-reset",
    {
      roleName: role.name,
      reason: summary,
      ...(activeRun === null ? {} : { runId: activeRun.id }),
      ...(current?.nativeSessionId === undefined
        ? {}
        : { nativeSessionId: current.nativeSessionId })
    },
    now
  ));

  if (role.name === "leader") {
    const nativeSessionId = current?.nativeSessionId ?? `reset-${task.id}`;
    store.saveLeaderFailure(recordLeaderFailure(
      task.id,
      nativeSessionId,
      summary,
      now,
      store.getLeaderFailure(task.id)
    ));
    store.saveOperatorNotification(createLeaderRecoveryNotification(
      task.id,
      summary,
      now,
      store.getOperatorNotification(task.id)
    ));
    enqueueWork(store, { kind: "operator" }, "leader-run-failed", now, [
      { type: "task", id: task.id },
      { type: "message", taskId: task.id, id: message.id },
      ...(activeRun === null ? [] : [{
        type: "run" as const,
        taskId: task.id,
        id: activeRun.id
      }])
    ]);
  } else {
    enqueueWork(store, { kind: "role", taskId: task.id, roleName: "leader" }, "role-run-failed", now, [
      { type: "message", taskId: task.id, id: message.id },
      ...(activeRun === null ? [] : [{
        type: "run" as const,
        taskId: task.id,
        id: activeRun.id
      }])
    ]);
  }
  return {
    taskId: task.id,
    roleName: role.name,
    run: activeRun === null ? null : store.getAgentRun(task.id, activeRun.id),
    ...(current === undefined ? {} : { nativeSessionId: current.nativeSessionId })
  };
}

function requiredIdentity(value: string, label: string): string {
  const normalized = requiredText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(normalized)
    || /[\/\\\0]/u.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
