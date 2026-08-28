import { isDeepStrictEqual } from "node:util";

import { completeProcessing } from "../coordination/workMailbox.js";
import { enqueueWork } from "../coordination/workMailboxQueue.js";
import { settleExactWorkExecution } from "../coordination/workMailboxQueue.js";
import {
  terminalizeTaskRoleRunSession,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import { updateRoleStatus } from "../role/role.js";
import { createTaskEvent } from "../event/taskEvent.js";
import {
  finishReviewRound,
  updateReviewExecutionGroup,
  type DeltaRecheckDisposition,
  type ReviewCheck,
  type ReviewRound
} from "../review/reviewRound.js";
import { reconcileReviewFindingsAfterReview } from "../review/reviewFindingLedger.js";
import {
  agentRunDeliveryReceiptId,
  failAgentRun,
  withYieldReceipt,
  yieldAgentRun,
  type AgentRun
} from "../run/agentRun.js";
import { createYieldReceipt } from "../run/yieldReceipt.js";
import {
  recordExecutionLaneResult,
  type ExecutionLaneGitSnapshot
} from "../execution/executionGroup.js";
import {
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import { runOwnsBlockingProviderContinuation } from "../runtime/runtimeContinuationProjection.js";
import {
  latestRunDurableProgressAt,
  RUN_RECOVERY_APPLIED_EVENT,
  RUN_RECOVERY_REQUESTED_EVENT
} from "../scheduler/roleRunStall.js";
import { markTaskWakeConsumed } from "../scheduler/taskWake.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  workItemExecutionGroupById,
  workItemOwnsUnresolvedExecutionLane,
  updateWorkItemExecutionGroup,
  updateWorkItemStatus
} from "../workItem/workItem.js";
export type ExactReviewRoundTerminalizationResult = Readonly<{
  disposition: "applied" | "obsolete";
  round: ReviewRound | null;
  reason?: string;
}>;

/**
 * Validate every immutable identity and frozen Project head needed before a
 * review Run can settle any mailbox or Round state.  This is deliberately
 * read-only: callers use it as the compare-and-swap fence immediately before
 * their aggregate mutation.
 */
export function validateExactRunReviewRound(
  store: TaskStore,
  run: AgentRun,
  options: Readonly<{ allowTerminal?: boolean }> = {}
): ExactReviewRoundTerminalizationResult {
  if (run.purpose !== "review") return { disposition: "applied", round: null };
  if (run.reviewRoundId === undefined) {
    return { disposition: "obsolete", round: null, reason: "review-round-missing" };
  }
  const round = store.getReviewRound(run.taskId, run.reviewRoundId);
  if (round === null) {
    return { disposition: "obsolete", round: null, reason: "review-round-missing" };
  }
  if (!options.allowTerminal
    && round.status !== "pending" && round.status !== "running") {
    return { disposition: "obsolete", round, reason: "review-round-terminal" };
  }
  const lane = round.executionGroup?.lanes.find(({ id }) => id === run.executionLaneId);
  const exactReviewerRun = round.reviewerRunId === run.id || lane?.runId === run.id;
  const exactReviewerRole = round.reviewerRoleName === run.roleName || lane?.roleName === run.roleName;
  if (!exactReviewerRun
    || !exactReviewerRole
    || round.workItemId !== run.workItemId
    || round.reviewBaseCommit !== run.effective.reviewBaseCommit) {
    return { disposition: "obsolete", round, reason: "review-round-mismatch" };
  }
  const laneWorkspaceRoot = lane?.workspace?.root;
  if (run.workspace === undefined || round.workspace === undefined
    || (laneWorkspaceRoot === undefined && !isDeepStrictEqual(run.workspace, round.workspace))
    || (laneWorkspaceRoot !== undefined && run.workspace.root !== laneWorkspaceRoot)) {
    return { disposition: "obsolete", round, reason: "review-workspace-mismatch" };
  }
  const storedWorkspace = run.workspace.owner.type === "execution-lane"
    ? store.getManagedWorkspace(run.workspace.owner)
    : store.getReviewRoundWorkspace(run.taskId, round.id);
  if (storedWorkspace === null
    || (run.workspace.owner.type !== "execution-lane"
      && !isDeepStrictEqual(storedWorkspace, round.workspace))
    || !isDeepStrictEqual(storedWorkspace, run.workspace)) {
    return { disposition: "obsolete", round, reason: "review-workspace-drift" };
  }
  if (run.workspace.owner.type !== "execution-lane") {
    if (storedWorkspace.owner.type !== "review-round"
      || storedWorkspace.owner.taskId !== run.taskId
      || storedWorkspace.owner.reviewRoundId !== round.id) {
      return { disposition: "obsolete", round, reason: "review-workspace-owner-mismatch" };
    }
  }
  if (run.workspace.owner.type === "execution-lane"
    && (run.workspace.owner.purpose !== "review"
      || run.workspace.owner.executionGroupId !== run.executionGroupId
      || run.workspace.owner.executionLaneId !== run.executionLaneId
      || run.workspace.owner.reviewRoundId !== round.id)) {
    return { disposition: "obsolete", round, reason: "review-lane-workspace-owner-mismatch" };
  }
  if (run.workspace.owner.type === "execution-lane") {
    if (lane === undefined
      || lane.runId !== run.id
      || lane.roleName !== run.roleName
      || lane.workspace?.root !== run.workspace.root
      || lane.workspace.writableProjectIds.length !== run.workspace.entries.length
      || run.workspace.entries.some((entry) => (
        entry.access !== "write"
        || !lane.workspace!.writableProjectIds.includes(entry.projectId)
      ))) {
      return { disposition: "obsolete", round, reason: "review-lane-workspace-lineage-mismatch" };
    }
  }
  const task = store.getTask(run.taskId);
  const taskScope = (round.scope ?? "work-item") === "task";
  const item = taskScope || round.workItemId === undefined
    ? null
    : store.getWorkItem(run.taskId, round.workItemId);
  if (!taskScope && item === null) {
    return { disposition: "obsolete", round, reason: "review-work-item-missing" };
  }
  const candidate = taskScope
    ? undefined
    : item!.candidates.find(({ id }) => id === round.candidateId);
  if (!taskScope && candidate === undefined) {
    return { disposition: "obsolete", round, reason: "review-candidate-missing" };
  }
  const frozenProjects = taskScope
    ? round.taskCandidate?.projects
    : candidate?.gitSnapshot?.projects;
  if (taskScope) {
    if (task === null || round.taskCandidate === undefined) {
      return { disposition: "obsolete", round, reason: "review-task-candidate-missing" };
    }
    if (frozenProjects === undefined
      || new Set(frozenProjects.map(({ projectId }) => projectId)).size
        !== task.projectBindings.length
      || task.projectBindings.some(({ projectId }) => (
        !frozenProjects.some((project) => project.projectId === projectId)
      ))) {
      return { disposition: "obsolete", round, reason: "review-frozen-project-scope-drift" };
    }
  } else if (candidate?.gitSnapshot !== undefined
    && candidate.gitSnapshot.reviewBaseCommit !== round.reviewBaseCommit) {
    return { disposition: "obsolete", round, reason: "review-candidate-snapshot-drift" };
  }
  if (!taskScope && frozenProjects === undefined) {
    return { disposition: "applied", round };
  }
  if (frozenProjects === undefined
    || storedWorkspace.entries.length !== frozenProjects.length) {
    return { disposition: "obsolete", round, reason: "review-frozen-project-scope-drift" };
  }
  const frozenByProject = new Map(
    frozenProjects.map(({ projectId, commit }) => [projectId, commit])
  );
  if (storedWorkspace.entries.some((entry) => (
    entry.access !== "write"
    || frozenByProject.get(entry.projectId) !== entry.baseCommit
    || entry.baseRef !== entry.baseCommit
  ))) {
    return { disposition: "obsolete", round, reason: "review-frozen-head-drift" };
  }
  return { disposition: "applied", round };
}

/**
 * Atomically terminalizes the exact ReviewRound bound to a review AgentRun.
 * The round must still be pending/running and its reviewer identity must match
 * the Run exactly. This is the sole review-round convergence primitive shared
 * by the exact Run terminalization path and the pre-delivery launch-failure
 * path: a failed review Run must never leave its Round stranded.
 */
export function terminalizeExactRunReviewRound(
  store: TaskStore,
  input: Readonly<{
    taskId: string;
    run: AgentRun;
    outcome: Readonly<{ status: "yielded" | "failed"; summary: string }>;
    reviewResult?: Readonly<{
      report?: string;
      checks?: readonly ReviewCheck[];
      findings?: readonly import("../execution/executionGroup.js").ExecutionFinding[];
      evidence?: readonly string[];
      evidenceCommit?: string;
      gitSnapshot?: ExecutionLaneGitSnapshot;
      deltaDisposition?: DeltaRecheckDisposition;
      deltaReasoning?: string;
    }>;
  }>,
  now: Date
): ExactReviewRoundTerminalizationResult {
  const validation = validateExactRunReviewRound(store, input.run);
  if (validation.disposition !== "applied" || validation.round === null) {
    return validation;
  }
  const reviewRound = validation.round;
  const groupedRound = input.run.executionGroupId !== undefined
    && input.run.executionLaneId !== undefined
    && reviewRound.executionGroup !== undefined
    ? updateReviewExecutionGroup(
        reviewRound,
        recordExecutionLaneResult(
          reviewRound.executionGroup,
          input.run.executionLaneId,
          {
            summary: input.outcome.summary,
            ...(input.reviewResult?.report === undefined ? {} : { report: input.reviewResult.report }),
            ...(input.reviewResult?.checks === undefined
              ? {}
              : {
                  checks: input.reviewResult.checks.map(({ name, outcome, details }) => ({
                    name,
                    outcome,
                    ...(details === undefined ? {} : { details })
                  }))
                }),
            ...(input.reviewResult?.findings === undefined
              ? {}
              : { findings: input.reviewResult.findings }),
            ...(input.reviewResult?.evidence === undefined
              ? {}
              : { evidence: input.reviewResult.evidence }),
            ...(input.reviewResult?.evidenceCommit === undefined
              ? {}
              : { evidenceCommit: input.reviewResult.evidenceCommit }),
            ...(input.reviewResult?.gitSnapshot === undefined
              ? {}
              : { gitSnapshot: input.reviewResult.gitSnapshot })
          },
          input.outcome.status === "yielded" ? "completed" : "failed",
          now
        )
      )
    : reviewRound;
  const groupedMultiLane = groupedRound.executionGroup !== undefined
    && (groupedRound.executionGroup.lanes.length > 1
      || groupedRound.executionGroup.strategy.mode === "adaptive");
  if (groupedMultiLane && groupedRound.executionGroup !== undefined) {
    // A panel Lane only contributes evidence.  The Leader must see every
    // terminal Lane and explicitly resolve the Group before this ReviewRound
    // can become terminal.
    store.saveReviewRound(input.taskId, groupedRound);
    return { disposition: "applied", round: groupedRound };
  }
  const terminal = finishReviewRound(
    groupedRound,
    input.outcome.status === "yielded" ? "completed" : "failed",
    input.outcome.summary,
    now,
    input.reviewResult
  );
  store.saveReviewRound(input.taskId, terminal);
  // Issue 06: a completed (semantic) Round feeds the finding ledger; a failed
  // execution attempt is skipped by the classifier and never creates findings.
  if (terminal.status === "completed") {
    reconcileReviewFindingsAfterReview(store, input.taskId, terminal.id, now);
  }
  return { disposition: "applied", round: terminal };
}

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
    findings?: readonly import("../execution/executionGroup.js").ExecutionFinding[];
    evidence?: readonly string[];
    evidenceCommit?: string;
    gitSnapshot?: ExecutionLaneGitSnapshot;
    deltaDisposition?: DeltaRecheckDisposition;
    deltaReasoning?: string;
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
  const active = run.executionGroupId !== undefined && run.executionLaneId !== undefined
    ? store.getActiveExecutionLaneRun(
      input.taskId,
      run.executionGroupId,
      run.executionLaneId
    )
    : store.getActiveAgentRun(input.taskId, input.roleName);
  if (active?.id !== run.id) return obsolete(run, "active-run-mismatch");

  const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
  if (!matchesSessionFence(sessions, input)) {
    return obsolete(run, "session-fence-mismatch");
  }
  if (!matchesLaunchFence(store, sessions, input)) {
    return obsolete(run, "launch-fence-mismatch");
  }
  if (runOwnsBlockingProviderContinuation(store.listEvents(input.taskId), {
    taskId: run.taskId,
    roleName: run.roleName,
    runId: run.id,
    agentId: run.effective.agentId
  })) {
    return obsolete(run, "provider-continuation-writer-owned");
  }

  // Validate the exact ReviewRound, Candidate, stored workspace, and frozen
  // Project heads before any mailbox or Round write.
  const reviewValidation = validateExactRunReviewRound(store, run);
  if (reviewValidation.disposition !== "applied") {
    return obsolete(run, reviewValidation.reason ?? "review-round-mismatch");
  }

  const roleTarget = {
    kind: "role" as const,
    taskId: input.taskId,
    roleName: input.roleName
  };
  if (input.mailboxDisposition === "discard") {
    store.removeWorkMailbox(roleTarget);
  } else {
    // For review Runs the mailbox must carry an exact pending or processing
    // entry for this Run: an absent or unrelated mailbox means the review
    // dispatch was never recorded and the terminalization must fail closed.
    // Execution/Leader Runs keep the historical absent-is-clean behavior so
    // direct Leader completion and normal execution are unaffected.
    const isReview = run.purpose === "review";
    const mailbox = store.getWorkMailbox(roleTarget);
    const processing = mailbox?.processing;
    if (mailbox !== null && processing !== null && processing !== undefined) {
      if (
        processing.executionRef === undefined
        || processing.executionRef.type !== "run"
        || processing.executionRef.taskId !== run.taskId
        || processing.executionRef.id !== run.id
      ) {
        return obsolete(run, "mailbox-busy");
      }
      store.saveWorkMailbox(completeProcessing(mailbox, processing.batchId));
    } else {
      const mailboxSettlement = settleExactWorkExecution(
        store,
        roleTarget,
        { type: "run", taskId: run.taskId, id: run.id }
      );
      if (mailboxSettlement === "absent" && isReview && run.deliveredAt === undefined) {
        return obsolete(run, "review-mailbox-missing");
      }
    }
  }

  // All Run, active-pointer, Session, launch, and mailbox fences have passed.
  // Only now may the exact ReviewRound be terminalized alongside the Run so a
  // stale fence never leaves a Round written while the Run stays active.
  const reviewRoundTerminalization = terminalizeExactRunReviewRound(store, {
    taskId: input.taskId,
    run,
    outcome: input.outcome,
    reviewResult: input.reviewResult
  }, now);
  if (reviewRoundTerminalization.disposition !== "applied") {
    return obsolete(run, reviewRoundTerminalization.reason ?? "review-round-mismatch");
  }

  const terminal = input.outcome.status === "yielded"
    ? withYieldReceipt(
        yieldAgentRun(run, input.outcome.summary, now),
        createYieldReceipt(input.taskId, input.runId, {
          status: "yielded",
          summary: input.outcome.summary,
          ...(input.reviewResult === undefined
            ? {}
            : {
                reviewResult: {
                  ...(input.reviewResult.report === undefined ? {} : { report: input.reviewResult.report }),
                  ...(input.reviewResult.checks === undefined ? {} : { checks: input.reviewResult.checks }),
                  ...(input.reviewResult.findings === undefined ? {} : { findings: input.reviewResult.findings }),
                  ...(input.reviewResult.evidence === undefined ? {} : { evidence: input.reviewResult.evidence }),
                  ...(input.reviewResult.evidenceCommit === undefined ? {} : { evidenceCommit: input.reviewResult.evidenceCommit }),
                  ...(input.reviewResult.gitSnapshot === undefined ? {} : { gitSnapshot: input.reviewResult.gitSnapshot }),
                  ...(input.reviewResult.deltaDisposition === undefined ? {} : { deltaDisposition: input.reviewResult.deltaDisposition }),
                  ...(input.reviewResult.deltaReasoning === undefined ? {} : { deltaReasoning: input.reviewResult.deltaReasoning })
                }
              })
        }, now)
      )
    : failAgentRun(run, input.outcome.summary, now);
  if (run.executionGroupId !== undefined
    && run.executionLaneId !== undefined
    && run.purpose === "execution"
    && run.workItemId !== undefined) {
    const item = store.getWorkItem(input.taskId, run.workItemId);
    const group = item === null
      ? undefined
      : workItemExecutionGroupById(item, run.executionGroupId);
    if (item !== null && group !== undefined) {
      const grouped = recordExecutionLaneResult(
        group,
        run.executionLaneId,
      {
        summary: input.outcome.summary,
        ...(input.reviewResult?.report === undefined ? {} : { report: input.reviewResult.report }),
        ...(input.reviewResult?.checks === undefined ? {} : { checks: input.reviewResult.checks }),
        ...(input.reviewResult?.findings === undefined ? {} : { findings: input.reviewResult.findings }),
        ...(input.reviewResult?.evidence === undefined ? {} : { evidence: input.reviewResult.evidence }),
        ...(input.reviewResult?.evidenceCommit === undefined ? {} : { evidenceCommit: input.reviewResult.evidenceCommit }),
        ...(input.reviewResult?.gitSnapshot === undefined ? {} : { gitSnapshot: input.reviewResult.gitSnapshot })
      },
        input.outcome.status === "yielded" ? "completed" : "failed",
        now
      );
      store.saveWorkItem(input.taskId, updateWorkItemExecutionGroup(item, grouped, now));
    }
  }
  store.saveAgentRun(terminal);
  if (terminal.roleName === "leader") {
    const wake = store.listTaskWakes(input.taskId)
      .find((candidate) => candidate.runId === terminal.id && candidate.status === "dispatched");
    if (wake !== undefined) {
      store.saveTaskWake(input.taskId, markTaskWakeConsumed(wake, now));
    }
  }
  if (terminal.executionGroupId !== undefined && terminal.executionLaneId !== undefined) {
    store.clearActiveExecutionLaneRun(
      input.taskId,
      terminal.executionGroupId,
      terminal.executionLaneId
    );
  } else {
    store.clearActiveAgentRun(input.taskId, input.roleName);
  }
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
  const active = current.executionGroupId !== undefined && current.executionLaneId !== undefined
    ? store.getActiveExecutionLaneRun(
      input.taskId,
      current.executionGroupId,
      current.executionLaneId
    )
    : store.getActiveAgentRun(input.taskId, input.roleName);
  if (active?.id !== current.id) {
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
    receiptId: agentRunDeliveryReceiptId(current),
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
    if (item !== null
      && !["completed", "failed", "retired"].includes(item.status)
      && !workItemOwnsUnresolvedExecutionLane(
        item,
        terminal.executionGroupId,
        terminal.executionLaneId
      )) {
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
  // A dead Session is precisely when replace-session/terminate recovery is
  // needed. Preserve its exact identity as the CAS fence; only same-Session
  // retry is invalid once the native process is stopped or broken.
  if ((session.status === "stopped" || session.status === "broken")
    && input.action === "retry") return false;

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
