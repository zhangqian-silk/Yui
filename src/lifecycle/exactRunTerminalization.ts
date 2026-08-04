import { completeProcessing } from "../coordination/workMailbox.js";
import { settleExactWorkExecution } from "../coordination/workMailboxQueue.js";
import {
  terminalizeTaskRoleRunSession,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import { updateRoleStatus } from "../role/role.js";
import { finishReviewRound, type ReviewCheck } from "../review/reviewRound.js";
import { failAgentRun, yieldAgentRun, type AgentRun } from "../run/agentRun.js";
import {
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import type { TaskStore } from "../storage/taskStore.js";

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
