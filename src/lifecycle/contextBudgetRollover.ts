import { enqueueWork } from "../coordination/workMailboxQueue.js";
import {
  validateRoleSessionSet,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import { createTaskEvent } from "../event/taskEvent.js";
import {
  RUNTIME_CLEANUP_REQUIRED_REASON,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import type { TaskStore } from "../storage/taskStore.js";

/**
 * Issue 04 (context token budget): retires one native Session generation that
 * crossed the hard context budget so the next Leader wake starts a fresh
 * generation. This is a controlled rollover, not a failure: the durable Task
 * records are the checkpoint, the bounded context snapshot re-establishes
 * working context for the new generation, and the retired Session is kept in
 * history as `stopped` with an auditable event. The Controller separately
 * owns verified process cleanup through the runtime cleanup lane.
 */

export const CONTEXT_BUDGET_ROLLOVER_REASON = "context-budget-hard-limit";

export type ContextBudgetRolloverResult = Readonly<{
  taskId: string;
  roleName: string;
  eventId: string;
  retiredNativeSessionId?: string;
  retiredLaunchId?: string;
}>;

export function rolloverTaskRoleSessionForContextBudget(
  store: TaskStore,
  taskId: string,
  roleName: string,
  evidence: Readonly<{ peakTokens: number; hardTokens: number }>,
  now: Date
): ContextBudgetRolloverResult | null {
  const task = store.getTask(taskId);
  if (task === null) throw new Error(`Task not found: ${taskId}.`);
  if (task.status !== "active") {
    throw new Error(`Task is not active: ${task.id}/${task.status}.`);
  }
  const role = store.getRole(task.id, roleName);
  if (role === null) throw new Error(`Role not found: ${task.id}/${roleName}.`);
  const set = store.getTaskRoleSessionSet(task.id, role.name);
  const current = set?.sessions[set.activeAgentId];
  if (set === null || set === undefined || current === undefined) {
    // No live generation to retire; the caller can launch fresh directly.
    return null;
  }
  const timestamp = now.toISOString();
  const reason = `${CONTEXT_BUDGET_ROLLOVER_REASON} (peak ${evidence.peakTokens} >= hard ${evidence.hardTokens} tokens)`;

  enqueueWork(
    store,
    runtimeLifecycleTarget({ scope: "task", taskId: task.id, roleName: role.name }),
    RUNTIME_CLEANUP_REQUIRED_REASON,
    now,
    [{ type: "task", id: task.id }]
  );

  const retired = retireStoppedTaskRoleSession(set, timestamp);
  store.saveTaskRoleSessionSet(retired);

  const eventId = store.nextEventId(task.id);
  store.saveEvent(task.id, createTaskEvent(
    eventId,
    task.id,
    "runtime.role-session-reset",
    {
      roleName: role.name,
      reason,
      peakTokens: String(evidence.peakTokens),
      hardTokens: String(evidence.hardTokens),
      ...(current.nativeSessionId === undefined
        ? {}
        : { nativeSessionId: current.nativeSessionId }),
      ...(current.launchId === undefined ? {} : { launchId: current.launchId })
    },
    now
  ));
  return Object.freeze({
    taskId: task.id,
    roleName: role.name,
    eventId,
    ...(current.nativeSessionId === undefined
      ? {}
      : { retiredNativeSessionId: current.nativeSessionId }),
    ...(current.launchId === undefined ? {} : { retiredLaunchId: current.launchId })
  });
}

/**
 * Retires the current generation to history as `stopped` (not `broken`:
 * a budget rollover is not a Session failure) and clears the Turn fence so
 * the next launch is a fresh generation.
 */
function retireStoppedTaskRoleSession(
  set: TaskRoleSessionSet,
  timestamp: string
): TaskRoleSessionSet {
  validateRoleSessionSet(set);
  const current = set.sessions[set.activeAgentId];
  const sessions = { ...set.sessions };
  delete sessions[set.activeAgentId];
  const history = current === undefined
    ? set.history
    : [
        ...(set.history ?? []),
        { ...current, status: "stopped" as const, updatedAt: timestamp }
      ];
  return validateRoleSessionSet({
    ...set,
    sessions,
    ...(history === undefined ? {} : { history }),
    inFlight: null,
    providerBinding: null,
    updatedAt: timestamp
  });
}
