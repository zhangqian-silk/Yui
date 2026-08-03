import { enqueueWork } from "../coordination/workMailboxQueue.js";
import {
  declareTaskRoleSessionUnusable,
  type RetiredTaskRoleSession,
  type UnusableSessionRetirement
} from "../executor/agentExecutor.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { terminalizeExactTaskRun } from "./exactRunTerminalization.js";
import { createTaskMessage } from "../message/message.js";
import { activeRoleAgentBinding, updateRoleStatus } from "../role/role.js";
import type { AgentRun } from "../run/agentRun.js";
import { runtimeLifecycleTarget } from "../runtime/lifecycleReservation.js";
import {
  createLeaderRecoveryNotification
} from "../scheduler/operatorNotification.js";
import { recordLeaderFailure } from "../scheduler/leaderFailure.js";
import type { TaskStore } from "../storage/taskStore.js";
import { updateWorkItemStatus } from "../workItem/workItem.js";

export type DeclareUnusableSessionRetirementInput = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  runId: string;
  receiptId: string;
  nativeSessionId: string;
  launchId: string;
  reason: string;
}>;

export type DeclareUnusableSessionRetirementResult = Readonly<{
  disposition: "applied" | "existing";
  status: "cleanup-pending" | "retired";
  run: AgentRun;
  retirementId: string;
  changed: boolean;
}>;

/**
 * Records the Operator's exact unusable-Session fact and fails only its active
 * delivered Run. External stop and Session retirement remain Controller work.
 */
export function declareUnusableSessionRetirement(
  store: TaskStore,
  rawInput: DeclareUnusableSessionRetirementInput,
  now: Date
): DeclareUnusableSessionRetirementResult {
  const input = normalizeInput(rawInput);
  const task = store.getTask(input.taskId);
  if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
  const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
  if (sessions !== null) {
    const existing = matchingExistingRetirement(sessions.unusableSessionRetirement, input);
    if (existing !== null) {
      const run = store.getAgentRun(input.taskId, input.runId);
      if (run === null || run.status !== "failed") {
        throw new Error("Existing unusable-session retirement has no matching failed Run.");
      }
      return {
        disposition: "existing",
        status: "cleanup-pending",
        run,
        retirementId: existing.id,
        changed: false
      };
    }
    const retired = matchingRetiredSession(sessions.retiredSessions, input);
    if (retired !== null) {
      const run = store.getAgentRun(input.taskId, input.runId);
      if (run === null || run.status !== "failed") {
        throw new Error("Retired unusable Session has no matching failed Run.");
      }
      return {
        disposition: "existing",
        status: "retired",
        run,
        retirementId: retired.retirementId,
        changed: false
      };
    }
  }
  if (task.status !== "active") {
    throw new Error(`Task is not active: ${task.id}/${task.status}.`);
  }
  const role = store.getRole(input.taskId, input.roleName);
  if (role === null) throw new Error(`Role not found: ${input.taskId}/${input.roleName}.`);
  const binding = activeRoleAgentBinding(role);
  if (binding.agentId !== input.agentId || binding.adapterId !== input.adapterId) {
    throw new Error("Operator Session retirement does not match the active Role Agent binding.");
  }
  const configuredAgent = store.getConfiguredAgent(input.agentId);
  if (configuredAgent?.adapterId !== input.adapterId) {
    throw new Error("Operator Session retirement does not match the configured Agent.");
  }
  if (role.status !== "running") {
    throw new Error(`Role is not running: ${input.taskId}/${input.roleName}/${role.status}.`);
  }
  const run = store.getAgentRun(input.taskId, input.runId);
  if (run === null) throw new Error(`Run not found: ${input.taskId}/${input.runId}.`);
  if (run.status !== "active") throw new Error(`Run is already terminal: ${run.id}/${run.status}.`);
  if (run.deliveredAt === undefined) throw new Error(`Run delivery is still pending: ${run.id}.`);
  if (
    run.taskId !== input.taskId
    || run.roleName !== input.roleName
    || run.effective.agentId !== input.agentId
    || run.effective.adapterId !== input.adapterId
  ) {
    throw new Error("Operator Session retirement does not match the exact Run owner.");
  }
  if (store.getActiveAgentRun(input.taskId, input.roleName)?.id !== input.runId) {
    throw new Error("Operator Session retirement does not match the active Run pointer.");
  }
  if (sessions === null) throw new Error("Task Role Session set is missing.");
  if (sessions.unusableSessionRetirement !== null) {
    throw new Error("Task Role already has a different unusable-session retirement.");
  }
  if (sessions.pendingTurnCompletion !== null) {
    throw new Error("Task Role has a pending Turn completion.");
  }
  const inFlight = sessions.inFlight;
  if (
    inFlight === null
    || inFlight.agentId !== input.agentId
    || inFlight.runId !== input.runId
    || inFlight.receiptId !== input.receiptId
    || inFlight.deliveredAt === undefined
  ) {
    throw new Error("Operator Session retirement does not match the delivered receipt fence.");
  }
  const session = sessions.sessions[input.agentId];
  if (
    sessions.activeAgentId !== input.agentId
    || session === undefined
    || session.adapterId !== input.adapterId
    || session.nativeSessionId !== input.nativeSessionId
    || session.launchId !== input.launchId
    || session.policy !== "fixed"
    || session.status !== "running"
  ) {
    throw new Error("Operator Session retirement does not match the current fixed Session generation.");
  }
  const roleMailbox = store.getWorkMailbox({
    kind: "role",
    taskId: input.taskId,
    roleName: input.roleName
  });
  if (
    roleMailbox?.processing?.executionRef?.type !== "run"
    || roleMailbox.processing.executionRef.taskId !== input.taskId
    || roleMailbox.processing.executionRef.id !== input.runId
  ) {
    throw new Error("Operator Session retirement does not match the Run mailbox execution.");
  }
  const runtimeTarget = runtimeLifecycleTarget({
    scope: "task",
    taskId: input.taskId,
    roleName: input.roleName
  });
  const runtimeMailbox = store.getWorkMailbox(runtimeTarget);
  if (runtimeMailbox !== null
    && (runtimeMailbox.processing !== null || runtimeMailbox.pending !== null)) {
    throw new Error("Task Role already has conflicting runtime lifecycle work.");
  }

  const retirementId = `session-retirement-${input.runId}`;
  const declaredSessions = declareTaskRoleSessionUnusable(sessions, {
    id: retirementId,
    ...input
  }, now);
  const summary = `Operator declared fixed native Session unusable: ${input.reason}`;
  const terminal = terminalizeExactTaskRun(store, {
    ...input,
    runtimeFence: "preserve-for-unusable-session-retirement",
    runtimeCleanup: "required",
    outcome: { status: "failed", summary }
  }, now);
  if (terminal.disposition !== "applied" || terminal.run === null) {
    throw new Error(
      `Operator Session retirement lost its exact terminal fence: ${
        terminal.reason ?? "obsolete"
      }.`
    );
  }
  store.saveTaskRoleSessionSet(declaredSessions);
  const message = createTaskMessage(
    store.nextMessageId(input.taskId),
    input.taskId,
    summary,
    "operator",
    { type: "operator" },
    now,
    {
      runId: input.runId,
      ...(run.workItemId === undefined ? {} : { workItemId: run.workItemId })
    }
  );
  store.saveMessage(input.taskId, message);
  store.saveEvent(input.taskId, createTaskEvent(
    store.nextEventId(input.taskId),
    input.taskId,
    "message.sent",
    { messageId: message.id, kind: message.kind },
    now
  ));
  if (run.purpose === "execution" && run.workItemId !== undefined) {
    const item = store.getWorkItem(input.taskId, run.workItemId);
    if (item !== null && ![
      "completed", "failed", "cancelled", "superseded", "abandoned"
    ].includes(item.status)) {
      store.saveWorkItem(
        input.taskId,
        updateWorkItemStatus(item, "failed", now, summary)
      );
    }
  }
  if (input.roleName === "leader") {
    const currentRole = store.getRole(input.taskId, input.roleName)!;
    store.saveRole(input.taskId, updateRoleStatus(currentRole, "failed", now));
    store.saveLeaderFailure(recordLeaderFailure(
      input.taskId,
      input.nativeSessionId,
      summary,
      now,
      store.getLeaderFailure(input.taskId)
    ));
    store.saveOperatorNotification(createLeaderRecoveryNotification(
      input.taskId,
      summary,
      now,
      store.getOperatorNotification(input.taskId)
    ));
    enqueueWork(store, { kind: "operator" }, "leader-run-failed", now, [
      { type: "task", id: input.taskId },
      { type: "run", taskId: input.taskId, id: input.runId },
      { type: "message", taskId: input.taskId, id: message.id }
    ]);
  } else {
    enqueueWork(
      store,
      { kind: "role", taskId: input.taskId, roleName: "leader" },
      run.purpose === "review" ? "review-failed" : "role-run-failed",
      now,
      [
        { type: "run", taskId: input.taskId, id: input.runId },
        { type: "message", taskId: input.taskId, id: message.id },
        ...(run.workItemId === undefined
          ? []
          : [{
              type: "work-item" as const,
              taskId: input.taskId,
              id: run.workItemId
            }])
      ]
    );
  }
  store.saveEvent(input.taskId, createTaskEvent(
    store.nextEventId(input.taskId),
    input.taskId,
    "runtime.unusable-session-retirement-requested",
    {
      retirementId,
      taskId: input.taskId,
      roleName: input.roleName,
      agentId: input.agentId,
      adapterId: input.adapterId,
      runId: input.runId,
      receiptId: input.receiptId,
      nativeSessionId: input.nativeSessionId,
      launchId: input.launchId,
      reason: input.reason,
      freshLaunchAllowed: "false"
    },
    now
  ));
  return {
    disposition: "applied",
    status: "cleanup-pending",
    run: terminal.run,
    retirementId,
    changed: true
  };
}

function normalizeInput(
  input: DeclareUnusableSessionRetirementInput
): DeclareUnusableSessionRetirementInput {
  return {
    taskId: requiredIdentity(input.taskId, "Task id"),
    roleName: requiredIdentity(input.roleName, "Role name"),
    agentId: requiredIdentity(input.agentId, "Agent id"),
    adapterId: requiredText(input.adapterId, "Agent adapter id"),
    runId: requiredIdentity(input.runId, "Run id"),
    receiptId: requiredText(input.receiptId, "Run receipt id"),
    nativeSessionId: requiredText(input.nativeSessionId, "Native Session id"),
    launchId: requiredIdentity(input.launchId, "Launch id"),
    reason: requiredText(input.reason, "Operator reason")
  };
}

function matchingExistingRetirement(
  retirement: UnusableSessionRetirement | null,
  input: DeclareUnusableSessionRetirementInput
): UnusableSessionRetirement | null {
  if (retirement === null) return null;
  return retirement.taskId === input.taskId
    && retirement.roleName === input.roleName
    && retirement.agentId === input.agentId
    && retirement.adapterId === input.adapterId
    && retirement.runId === input.runId
    && retirement.receiptId === input.receiptId
    && retirement.nativeSessionId === input.nativeSessionId
    && retirement.launchId === input.launchId
    && retirement.reason === input.reason
    ? retirement
    : null;
}

function matchingRetiredSession(
  retiredSessions: Readonly<Record<string, RetiredTaskRoleSession>>,
  input: DeclareUnusableSessionRetirementInput
): RetiredTaskRoleSession | null {
  return Object.values(retiredSessions).find((retired) => (
    retired.runId === input.runId
    && retired.receiptId === input.receiptId
    && retired.reason === input.reason
    && retired.session.agentId === input.agentId
    && retired.session.adapterId === input.adapterId
    && retired.session.nativeSessionId === input.nativeSessionId
    && retired.session.launchId === input.launchId
  )) ?? null;
}

function requiredIdentity(value: string, label: string): string {
  const normalized = requiredText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(normalized)
    || /[\/\\\0]/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
