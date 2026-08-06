import { completeProcessing } from "../coordination/workMailbox.js";
import { enqueueWork } from "../coordination/workMailboxQueue.js";
import { settleExactWorkExecution } from "../coordination/workMailboxQueue.js";
import {
  terminalizeTaskRoleRunSession,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import { updateRoleStatus } from "../role/role.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { finishReviewRound, type ReviewCheck } from "../review/reviewRound.js";
import { failAgentRun, yieldAgentRun, type AgentRun } from "../run/agentRun.js";
import { formatAgentRunReceiptId } from "../task/taskRecordReference.js";
import {
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import {
  clearMatchingLeaderStallAttention,
  latestRunDurableProgressAt,
  RUN_RECOVERY_APPLIED_EVENT,
  RUN_RECOVERY_REQUESTED_EVENT
} from "../scheduler/roleRunStall.js";
import type { TaskStore } from "../storage/taskStore.js";
import { updateWorkItemStatus } from "../workItem/workItem.js";

export type ExactRunTerminalizationInput = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  runId: string;
  receiptId: string;
  nativeSessionId?: string;
  launchId?: string;
  /** Aggregate retirement owns every queued Role signal, not only this Run. */
  mailboxDisposition?: "exact" | "discard";
  outcome: Readonly<{
    status: "yielded" | "failed";
    summary: string;
  }>;
  reviewResult?: Readonly<{
    report?: string;
    checks?: readonly ReviewCheck[];
    evidenceCommit?: string;
  }>;
}>;

export type ExactRunTerminalizationResult = Readonly<{
  disposition: "applied" | "obsolete";
  run: AgentRun | null;
  reason?: string;
}>;

export type ExactAgentRunRecoveryAction =
  | "diagnose"
  | "retry"
  | "replace-session"
  | "terminate";

export type ExactAgentRunRecoveryInput = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  launchId?: string;
  /** Exact semantic progress fence read by the Leader before acting. */
  expectedProgressAt: string;
  providerAcceptance: "accepted" | "rejected" | "ambiguous";
  action: ExactAgentRunRecoveryAction;
  reason: string;
  now: Date;
}>;

export type ExactAgentRunRecoveryResult = Readonly<{
  disposition: "applied" | "state-changed" | "blocked";
  action: ExactAgentRunRecoveryAction;
  run: AgentRun | null;
  progressAt?: string;
  reason?: string;
  /** Retry/session replacement are requests only; the Leader must perform the next exact action. */
  requiresExplicitFollowup?: boolean;
}>;

/**
 * Applies one exact application-level terminal fact inside the caller's
 * FileTaskStore transaction. All caller-owned outcome records can therefore
 * be saved in the same aggregate commit.
 */
export function terminalizeExactTaskRun(
  store: TaskStore,
  input: ExactRunTerminalizationInput,
  now: Date
): ExactRunTerminalizationResult {
  const run = store.getAgentRun(input.taskId, input.runId);
  if (run === null) return obsolete(null, "run-missing");
  if (run.status !== "active") return obsolete(run, "run-terminal");
  if (run.taskId !== input.taskId || run.roleName !== input.roleName) {
    return obsolete(run, "run-owner-mismatch");
  }
  if (run.effective.agentId !== input.agentId) {
    return obsolete(run, "run-agent-mismatch");
  }
  const role = store.getRole(input.taskId, input.roleName);
  if (role === null) return obsolete(run, "role-missing");
  const active = store.getActiveAgentRun(input.taskId, input.roleName);
  if (active?.id !== run.id) return obsolete(run, "active-run-mismatch");

  const reviewRound = run.purpose === "review" && run.reviewRoundId !== undefined
    ? store.getReviewRound(input.taskId, run.reviewRoundId)
    : null;
  if (run.purpose === "review" && (
    reviewRound === null
    || reviewRound.status !== "running"
    || reviewRound.reviewerRunId !== run.id
    || reviewRound.reviewerRoleName !== run.roleName
    || reviewRound.workItemId !== run.workItemId
  )) return obsolete(run, "review-round-mismatch");

  const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
  if (!matchesSessionFence(sessions, input)) {
    return obsolete(run, "session-fence-mismatch");
  }
  if (!matchesLaunchFence(store, sessions, input)) {
    return obsolete(run, "launch-fence-mismatch");
  }

  const roleTarget = {
    kind: "role" as const,
    taskId: input.taskId,
    roleName: input.roleName
  };
  if (input.mailboxDisposition === "discard") {
    store.removeWorkMailbox(roleTarget);
  } else {
    const mailboxSettlement = settleExactWorkExecution(
      store,
      roleTarget,
      { type: "run", taskId: run.taskId, id: run.id }
    );
    if (mailboxSettlement === "absent") {
      throw new Error(`Run mailbox execution is missing: ${run.id}.`);
    }
  }

  const terminal = input.outcome.status === "yielded"
    ? yieldAgentRun(run, input.outcome.summary, now)
    : failAgentRun(run, input.outcome.summary, now);
  store.saveAgentRun(terminal);
  if (reviewRound !== null) {
    store.saveReviewRound(input.taskId, finishReviewRound(
      reviewRound,
      input.outcome.status === "yielded" ? "completed" : "failed",
      input.outcome.summary,
      now,
      input.reviewResult
    ));
  }
  store.clearActiveAgentRun(input.taskId, input.roleName);
  store.saveRole(input.taskId, updateRoleStatus(role, "idle", now));
  if (sessions !== null) {
    store.saveTaskRoleSessionSet(terminalizeTaskRoleRunSession(sessions, {
      agentId: input.agentId,
      runId: input.runId,
      receiptId: input.receiptId
    }, now));
  }
  settleLaunchReservation(store, sessions, input);
  return { disposition: "applied", run: terminal };
}

/**
 * Leader-controlled recovery boundary for one active AgentRun. This primitive
 * validates every durable fence in one transaction and records only a
 * structured request for retry/session replacement. It never writes terminal
 * bytes, retries a provider input, kills a host, or silently rebinds a native
 * generation. Explicit termination is the sole action that changes Run state.
 */
export function recoverExactAgentRun(
  store: TaskStore,
  input: ExactAgentRunRecoveryInput
): ExactAgentRunRecoveryResult {
  return store.transaction((tx) => recoverExactAgentRunInTransaction(tx, input));
}

/** Alias named after the existing exact terminalization primitive. */
export const recoverExactTaskRun = recoverExactAgentRun;

function recoverExactAgentRunInTransaction(
  store: TaskStore,
  input: ExactAgentRunRecoveryInput
): ExactAgentRunRecoveryResult {
  const current = store.getAgentRun(input.taskId, input.runId);
  const stateChanged = (reason: string): ExactAgentRunRecoveryResult => ({
    disposition: "state-changed",
    action: input.action,
    run: current,
    ...(current === null ? {} : { progressAt: latestRunDurableProgressAt(
      store,
      input.taskId,
      input.roleName,
      input.runId
    )?.progressAt }),
    reason
  });
  const task = store.getTask(input.taskId);
  if (task === null) return stateChanged("task-missing");
  if (task.status !== "active") return stateChanged("task-terminal");
  if (current === null) return stateChanged("run-missing");
  if (current.status !== "active") return stateChanged("run-terminal");
  if (current.taskId !== input.taskId || current.roleName !== input.roleName) {
    return stateChanged("run-owner-mismatch");
  }
  if (
    current.effective.agentId !== input.agentId
    || current.effective.adapterId !== input.adapterId
  ) {
    return stateChanged("run-launch-identity-mismatch");
  }
  const role = store.getRole(input.taskId, input.roleName);
  if (role === null) return stateChanged("role-missing");
  if (store.getActiveAgentRun(input.taskId, input.roleName)?.id !== current.id) {
    return stateChanged("active-run-mismatch");
  }
  const progress = latestRunDurableProgressAt(
    store,
    input.taskId,
    input.roleName,
    input.runId
  );
  if (progress === null) return stateChanged("progress-unavailable");
  if (progress.progressAt !== input.expectedProgressAt) {
    return {
      ...stateChanged("progress-fence-mismatch"),
      progressAt: progress.progressAt
    };
  }
  // Acceptance is a durable delivery boundary, not a Leader assertion. An
  // accepted request must match the Run's persisted receipt; an already
  // delivered Run cannot be reclassified as provider-rejected.
  if (
    (input.providerAcceptance === "accepted" && current.deliveredAt === undefined)
    || (input.providerAcceptance === "rejected" && current.deliveredAt !== undefined)
  ) {
    return {
      disposition: "blocked",
      action: input.action,
      run: current,
      progressAt: progress.progressAt,
      reason: "provider-acceptance-mismatch"
    };
  }
  if (!matchesRecoverySessionFence(store, input)) {
    return stateChanged("session-or-launch-fence-mismatch");
  }
  if (
    input.providerAcceptance === "ambiguous"
    && input.action !== "diagnose"
  ) {
    return {
      disposition: "blocked",
      action: input.action,
      run: current,
      progressAt: progress.progressAt,
      reason: "provider-acceptance-ambiguous"
    };
  }
  if (!hasRecoveryReason(input.reason)) {
    return {
      disposition: "blocked",
      action: input.action,
      run: current,
      progressAt: progress.progressAt,
      reason: "recovery-reason-required"
    };
  }

  const eventPayload = {
    runId: current.id,
    roleName: current.roleName,
    action: input.action,
    providerAcceptance: input.providerAcceptance,
    progressAt: progress.progressAt,
    ...(input.nativeSessionId === undefined ? {} : { nativeSessionId: input.nativeSessionId }),
    ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
    reason: input.reason
  };
  const events = store.listEvents(input.taskId);
  const alreadyRequested = events.some((event) => (
    event.type === RUN_RECOVERY_REQUESTED_EVENT
    && event.payload.runId === current.id
    && event.payload.action === input.action
    && event.payload.progressAt === progress.progressAt
    && event.payload.nativeSessionId === input.nativeSessionId
    && event.payload.launchId === input.launchId
  ));

  if (input.action !== "terminate") {
    if (!alreadyRequested) {
      store.saveEvent(input.taskId, createTaskEvent(
        store.nextEventId(input.taskId),
        input.taskId,
        RUN_RECOVERY_REQUESTED_EVENT,
        eventPayload,
        input.now
      ));
      // A non-Leader request is surfaced through the existing Leader mailbox;
      // it is not a Task Message and is coalesced by the mailbox reason.
      if (input.roleName !== "leader") {
        enqueueWork(
          store,
          { kind: "role", taskId: input.taskId, roleName: "leader" },
          "run-recovery-requested",
          input.now,
          [{ type: "run", taskId: input.taskId, id: current.id }]
        );
      }
    }
    return {
      disposition: "applied",
      action: input.action,
      run: current,
      progressAt: progress.progressAt,
      requiresExplicitFollowup: true
    };
  }

  const terminalization = terminalizeExactTaskRun(store, {
    taskId: input.taskId,
    roleName: input.roleName,
    agentId: input.agentId,
    runId: input.runId,
    receiptId: formatAgentRunReceiptId(input.taskId, input.runId),
    ...(input.nativeSessionId === undefined ? {} : { nativeSessionId: input.nativeSessionId }),
    ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
    outcome: { status: "failed", summary: input.reason }
  }, input.now);
  if (terminalization.disposition !== "applied" || terminalization.run === null) {
    return stateChanged(terminalization.reason ?? "terminalization-fence-mismatch");
  }
  const terminal = terminalization.run;
  if (terminal.purpose === "execution" && terminal.workItemId !== undefined) {
    const item = store.getWorkItem(input.taskId, terminal.workItemId);
    if (item !== null && !["completed", "failed", "retired"].includes(item.status)) {
      store.saveWorkItem(input.taskId, updateWorkItemStatus(item, "failed", input.now, input.reason));
    }
  }
  store.saveEvent(input.taskId, createTaskEvent(
    store.nextEventId(input.taskId),
    input.taskId,
    RUN_RECOVERY_APPLIED_EVENT,
    { ...eventPayload, status: "terminated" },
    input.now
  ));
  clearMatchingLeaderStallAttention(store, input.taskId, input.runId);
  if (input.roleName !== "leader") {
    enqueueWork(
      store,
      { kind: "role", taskId: input.taskId, roleName: "leader" },
      "run-recovery-terminated",
      input.now,
      [{ type: "run", taskId: input.taskId, id: input.runId }]
    );
  }
  return {
    disposition: "applied",
    action: input.action,
    run: terminal,
    progressAt: progress.progressAt
  };
}

function matchesRecoverySessionFence(
  store: TaskStore,
  input: ExactAgentRunRecoveryInput
): boolean {
  const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
  // Recovery must never proceed without a durable Session fence.  A missing
  // nativeSessionId is supported for an opaque host, but its exact launchId
  // is then the only identity that can fence the action.
  if (sessions === null) return false;
  if (sessions.activeAgentId !== input.agentId) return false;
  const session = sessions.sessions[input.agentId];
  if (session === undefined) return false;
  if (session.agentId !== input.agentId || session.adapterId !== input.adapterId) return false;
  if (session.status === "stopped" || session.status === "broken") return false;

  const sessionNativeSessionId = session.nativeSessionId;
  if (sessionNativeSessionId === undefined) {
    if (input.nativeSessionId !== undefined) return false;
  } else if (input.nativeSessionId !== sessionNativeSessionId) {
    return false;
  }

  let launchMatches = false;
  if (input.launchId !== undefined && session.launchId === input.launchId) {
    launchMatches = true;
  }
  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId: input.taskId,
    roleName: input.roleName
  }));
  if (
    !launchMatches
    && input.launchId !== undefined
    && isRuntimeLaunchReservation(mailbox?.processing, input.launchId)
  ) {
    launchMatches = true;
  }

  // An opaque Session has no native identity to compare, so an exact launch
  // identity is mandatory.  Native Sessions may retain the older no-launch
  // shape; their exact native identity remains a valid fence.
  if (sessionNativeSessionId === undefined) return launchMatches;
  if (input.nativeSessionId === undefined) return launchMatches;
  return session.launchId === undefined
    ? input.launchId === undefined || launchMatches
    : launchMatches;
}

function hasRecoveryReason(value: string): boolean {
  return typeof value === "string" && value.includes("\0") === false && value.trim().length > 0;
}

function matchesSessionFence(
  sessions: TaskRoleSessionSet | null,
  input: ExactRunTerminalizationInput
): boolean {
  if (sessions === null) return input.nativeSessionId === undefined;
  if (sessions.activeAgentId !== input.agentId) return false;
  const session = sessions.sessions[input.agentId];
  if (input.nativeSessionId !== undefined) {
    if (session?.nativeSessionId !== input.nativeSessionId) return false;
  }
  const pending = sessions.pendingTurnCompletion;
  if (pending !== null && (
    pending.agentId !== input.agentId
    || pending.runId !== input.runId
    || (input.nativeSessionId !== undefined
      && pending.nativeSessionId !== input.nativeSessionId)
  )) return false;
  const inFlight = sessions.inFlight;
  return inFlight === null || (
    inFlight.agentId === input.agentId
    && inFlight.runId === input.runId
    && inFlight.receiptId === input.receiptId
  );
}

function matchesLaunchFence(
  store: TaskStore,
  sessions: TaskRoleSessionSet | null,
  input: ExactRunTerminalizationInput
): boolean {
  if (input.launchId === undefined) return true;
  const session = sessions?.sessions[input.agentId] as
    | (TaskRoleSessionSet["sessions"][string] & { launchId?: string })
    | undefined;
  if (session?.launchId === input.launchId) return true;
  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId: input.taskId,
    roleName: input.roleName
  }));
  return isRuntimeLaunchReservation(mailbox?.processing, input.launchId);
}

function settleLaunchReservation(
  store: TaskStore,
  sessions: TaskRoleSessionSet | null,
  input: ExactRunTerminalizationInput
): void {
  const target = runtimeLifecycleTarget({
    scope: "task",
    taskId: input.taskId,
    roleName: input.roleName
  });
  const mailbox = store.getWorkMailbox(target);
  const reservation = mailbox?.processing;
  const session = sessions?.sessions[input.agentId] as
    | (TaskRoleSessionSet["sessions"][string] & { launchId?: string })
    | undefined;
  const launchId = input.launchId ?? session?.launchId;
  if (launchId === undefined || !isRuntimeLaunchReservation(reservation, launchId)) return;
  const settled = completeProcessing(mailbox!, reservation!.batchId);
  if (settled.processing === null && settled.pending === null) {
    store.removeWorkMailbox(target);
  } else {
    store.saveWorkMailbox(settled);
  }
}

function obsolete(
  run: AgentRun | null,
  reason: string
): ExactRunTerminalizationResult {
  return { disposition: "obsolete", run, reason };
}
