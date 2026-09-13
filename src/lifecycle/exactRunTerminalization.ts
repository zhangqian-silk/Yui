import { isDeepStrictEqual } from "node:util";
import { createTaskMessage } from "../message/message.js";
import { providerRetryPending } from "../runtime/providerRetry.js";

import {
  captureRoleRunDispatch,
  enqueueWork,
  settleRoleRunDispatch
} from "../coordination/workMailboxQueue.js";
import {
  finishReviewRound,
  updateReviewExecutionGroup,
  type ReviewRound
} from "../review/reviewRound.js";
import {
  completeRun,
  failRun,
  runPurposeAdmitsTaskState,
  type AgentRun,
  type AgentRunSystemEvidence,
  type AgentRunProviderResult
} from "../agentRun/agentRun.js";
import { boundedRunFailureDiagnostic } from "../domain/agentResultTransport.js";
import {
  updateExecutionLane,
  updateWorkItemExecutionLane
} from "../execution/workItemExecution.js";
import { managedProviderTurnId } from "../runtime/providerRuntimeIdentity.js";
import {
  latestRunDurableProgressAt
} from "../scheduler/roleRunStall.js";
import { markTaskWakeConsumed } from "../scheduler/taskWake.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  workItemExecutionGroupById,
  updateWorkItemExecutionGroup
} from "../workItem/workItem.js";

export type ExactReviewRoundTerminalizationResult = Readonly<{
  disposition: "applied" | "obsolete";
  round: ReviewRound | null;
  reason?: string;
}>;

/**
 * Validate every immutable identity and frozen Project head needed before a
 * review AgentRun can settle any mailbox or Round state. This is deliberately
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
  if (!options.allowTerminal && run.executionLaneId === undefined
    && round.status !== "pending" && round.status !== "running") {
    return { disposition: "obsolete", round, reason: "review-round-terminal" };
  }
  const lane = round.executionGroup?.lanes.find(({ id }) => id === run.executionLaneId);
  const exactReviewerRun = round.reviewerRunId === run.id
    || lane?.currentRunId === run.id;
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
      || lane.currentRunId !== run.id
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
 * the AgentRun exactly. This is the sole review-round convergence primitive shared
 * by the exact AgentRun terminalization path and the pre-delivery launch-failure
 * path: a failed review AgentRun must never leave its Round stranded.
 */
export function terminalizeExactRunReviewRound(
  store: TaskStore,
  input: Readonly<{
    taskId: string;
    run: AgentRun;
    outcome: Readonly<{
      status: "completed";
      output: string;
    }> | Readonly<{
      status: "failed";
      diagnostic: string;
      failureReason: import("../agentRun/agentRun.js").AgentRunFailureReason;
      output?: string;
    }>;
    systemEvidence?: AgentRunSystemEvidence;
  }>,
  now: Date
): ExactReviewRoundTerminalizationResult {
  const validation = validateExactRunReviewRound(store, input.run);
  if (validation.disposition !== "applied" || validation.round === null) {
    return validation;
  }
  const reviewRound = validation.round;
  if (input.run.executionGroupId !== undefined
    && input.run.executionLaneId !== undefined) {
    // Producer AgentRuns own only their immutable AgentRun result. The unified Group
    // is advanced after that result is validated and stored below.
    return { disposition: "applied", round: reviewRound };
  }
  const terminal = finishReviewRound(
    reviewRound,
    input.outcome.status,
    now,
    input.outcome.status === "failed"
      ? { kind: "execution", message: input.outcome.diagnostic }
      : undefined
  );
  store.saveReviewRound(input.taskId, terminal);
  return { disposition: "applied", round: terminal };
}

export type ExactRunTerminalizationInput = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  runId: string;
  nativeSessionId?: string;
  /** Aggregate retirement owns every queued Role signal, not only this AgentRun. */
  mailboxDisposition?: "exact" | "discard";
  outcome: Readonly<{
    status: "completed";
    output: string;
    provider?: AgentRunProviderResult;
  }> | Readonly<{
    status: "failed";
    diagnostic: string;
    failureReason: import("../agentRun/agentRun.js").AgentRunFailureReason;
    provider?: AgentRunProviderResult;
    output?: string;
  }>;
  systemEvidence?: AgentRunSystemEvidence;
  workspaceFailure?: Readonly<{
    failureReason:
      | "workspace-unavailable"
      | "workspace-dirty"
      | "workspace-branch-mismatch";
    diagnostic: string;
  }>;
}>;

export type ExactRunTerminalizationResult = Readonly<{
  disposition: "applied" | "obsolete";
  run: AgentRun | null;
  reason?: string;
}>;

export type ExactRunRetirementInput = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  /** Exact semantic progress fence observed before the retirement request. */
  expectedProgressAt: string;
  reason: string;
}>;

export type ExactRunRetirementResult = Readonly<{
  disposition: "applied" | "state-changed" | "blocked";
  run: AgentRun | null;
  progressAt?: string;
  reason?: string;
}>;

/** Explicit runtime replacement has already proved this Role's resources
 * stopped. A stale active-pointer/Review projection cannot veto cancellation
 * of its engineering attempts. Never accept work or rewrite an old result. */
export function cancelQuiescentRoleRuns(
  store: TaskStore, taskId: string, roleName: string, reason: string, now: Date
): void {
  for (const run of store.listRuns(taskId).filter(run => run.roleName === roleName && run.status === "active")) {
    const outcome = { status: "failed" as const, failureReason: "cancelled" as const, diagnostic: reason };
    const settled = terminalizeExactTaskRun(store, {
      taskId, roleName, agentId: run.effective.agentId, runId: run.id, outcome
    }, now);
    if (settled.disposition === "applied") continue;
    store.saveRun(failRun(run, "cancelled", reason, now));
    settleRoleRunDispatch(store, { taskId, roleName, runId: run.id });
    if (store.getActiveRun(taskId, roleName)?.id === run.id) store.clearActiveRun(taskId, roleName);
    if (run.executionGroupId !== undefined && run.executionLaneId !== undefined
      && store.getActiveExecutionLaneRun(taskId, run.executionGroupId, run.executionLaneId)?.id === run.id) {
      store.clearActiveExecutionLaneRun(taskId, run.executionGroupId, run.executionLaneId);
    }
    if (run.reviewRoundId !== undefined && run.executionGroupId === undefined) {
      const round = store.getReviewRound(taskId, run.reviewRoundId);
      if (round?.reviewerRunId === run.id && (round.status === "pending" || round.status === "running")) {
        store.saveReviewRound(taskId, finishReviewRound(round, "failed", now, { kind: "execution", message: reason }));
      }
    }
    if (roleName !== "leader") {
      const message = createTaskMessage(store.nextMessageId(taskId), taskId,
        `Execution ${run.id} cancelled after runtime stop.`, "role-result",
        { type: "role", roleName }, now, { resultRef: { type: "agent-run-result", runId: run.id } });
      store.saveMessage(taskId, message);
      enqueueWork(store, { kind: "role", taskId, roleName: "leader" }, "role-result", now,
        [{ type: "message", taskId, id: message.id }]);
    }
  }
}

/**
 * Retire one stranded active AgentRun only after its exact Provider Turn is
 * terminal and every durable execution fence is quiet. The caller owns the
 * surrounding aggregate transaction so the AgentRun, ReviewRound/Lane, mailbox,
 * Session, and append-only retirement record commit together.
 */
export function retireExactActiveRun(
  store: TaskStore,
  input: ExactRunRetirementInput,
  now: Date
): ExactRunRetirementResult {
  const current = store.getRun(input.taskId, input.runId);
  const stateChanged = (reason: string): ExactRunRetirementResult => ({
    disposition: "state-changed",
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
  if (current === null) return stateChanged("turn-missing");
  if (current.status !== "active") return stateChanged("turn-terminal");
  // The Turn's purpose decides which Task lifecycle admits it: a planning Turn
  // is admitted on a Draft, so its retirement must land there too. Otherwise a
  // Draft planning Turn could never be retired and would leak an active Turn.
  if (!runPurposeAdmitsTaskState(current.purpose, task)) {
    return stateChanged("task-terminal");
  }
  if (current.taskId !== input.taskId || current.roleName !== input.roleName) {
    return stateChanged("turn-owner-mismatch");
  }
  if (current.effective.agentId !== input.agentId
    || current.effective.adapterId !== input.adapterId) {
    return stateChanged("turn-launch-identity-mismatch");
  }
  const active = current.executionGroupId !== undefined && current.executionLaneId !== undefined
    ? store.getActiveExecutionLaneRun(
      input.taskId,
      current.executionGroupId,
      current.executionLaneId
    )
    : store.getActiveRun(input.taskId, input.roleName);
  if (active?.id !== current.id) return stateChanged("active-turn-mismatch");
  const progress = latestRunDurableProgressAt(
    store,
    input.taskId,
    input.roleName,
    input.runId
  );
  if (progress === null) return stateChanged("progress-unavailable");
  if (progress.progressAt !== input.expectedProgressAt) {
    return { ...stateChanged("progress-fence-mismatch"), progressAt: progress.progressAt };
  }
  const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
  const terminalInput: ExactRunTerminalizationInput = {
    taskId: input.taskId,
    roleName: input.roleName,
    agentId: input.agentId,
    runId: input.runId,
    ...(input.nativeSessionId === undefined ? {} : { nativeSessionId: input.nativeSessionId }),
    outcome: { status: "failed", diagnostic: input.reason, failureReason: "missing-result" }
  };
  const session = sessions?.sessions[input.agentId];
  const providerBinding = sessions?.providerBinding;
  const providerTurn = providerBinding?.run;
  const providerSettled = managedProviderTurnId(providerTurn) === current.id
    && (providerTurn?.status === "completed"
      || providerTurn?.status === "failed"
      || providerTurn?.status === "cancelled"
      || providerTurn?.status === "rejected"
      || providerTurn?.status === "deferred");
  if (session?.status === "active" && !providerSettled) {
    return {
      disposition: "blocked",
      run: current,
      progressAt: progress.progressAt,
      reason: "runtime-not-terminal"
    };
  }
  const terminal = terminalizeExactTaskRun(store, terminalInput, now);
  if (terminal.disposition !== "applied" || terminal.run === null) {
    return stateChanged(terminal.reason ?? "terminalization-fence-mismatch");
  }
  return {
    disposition: "applied",
    run: terminal.run,
    progressAt: progress.progressAt
  };
}

/**
 * Applies one exact application-level terminal fact inside the caller's
 * TaskStore transaction. All caller-owned outcome records can therefore
 * be saved in the same aggregate commit.
 */
export function terminalizeExactTaskRun(
  store: TaskStore,
  input: ExactRunTerminalizationInput,
  now: Date
): ExactRunTerminalizationResult {
  const run = store.getRun(input.taskId, input.runId);
  if (run === null) return obsolete(null, "turn-missing");
  if (run.status !== "active") return obsolete(run, "turn-terminal");
  if (run.taskId !== input.taskId || run.roleName !== input.roleName) {
    return obsolete(run, "turn-owner-mismatch");
  }
  if (run.effective.agentId !== input.agentId) {
    return obsolete(run, "turn-agent-mismatch");
  }
  const role = store.getRole(input.taskId, input.roleName);
  if (role === null) return obsolete(run, "role-missing");
  const active = run.executionGroupId !== undefined && run.executionLaneId !== undefined
    ? store.getActiveExecutionLaneRun(
      input.taskId,
      run.executionGroupId,
      run.executionLaneId
    )
    : store.getActiveRun(input.taskId, input.roleName);
  if (active?.id !== run.id) return obsolete(run, "active-turn-mismatch");

  // Validate the exact ReviewRound, Candidate, stored workspace, and frozen
  // Project heads before any mailbox or Round write.
  const reviewValidation = validateExactRunReviewRound(store, run);
  if (reviewValidation.disposition !== "applied") {
    return obsolete(run, reviewValidation.reason ?? "review-round-mismatch");
  }
  const requiredSnapshotProjects = [...new Set(run.effective.writeProjectIds)].sort();
  const observedSnapshotProjects = input.systemEvidence?.workspaceSnapshot?.projects
    .map(({ projectId }) => projectId)
    .sort();
  const laneSnapshotRequired = input.outcome.status === "completed"
    && run.executionGroupId !== undefined
    && run.executionLaneId !== undefined
    && requiredSnapshotProjects.length > 0;
  const missingLaneSnapshot = laneSnapshotRequired
    && (
      observedSnapshotProjects === undefined
      || !isDeepStrictEqual(observedSnapshotProjects, requiredSnapshotProjects)
    );
  const workspaceFailure = laneSnapshotRequired
    ? input.workspaceFailure ?? (missingLaneSnapshot
      ? {
          failureReason: "workspace-unavailable" as const,
          diagnostic: "Core could not freeze the exact clean writable Lane workspace."
        }
      : undefined)
    : undefined;
  const effectiveOutcome = input.outcome.status === "completed" && workspaceFailure !== undefined
    ? {
        status: "failed" as const,
        output: input.outcome.output,
        diagnostic: workspaceFailure.diagnostic,
        failureReason: workspaceFailure.failureReason,
        ...(input.outcome.provider === undefined ? {} : { provider: input.outcome.provider })
      }
    : input.outcome;
  const terminalOutcome = effectiveOutcome.status === "failed"
    ? {
        ...effectiveOutcome,
        diagnostic: boundedRunFailureDiagnostic(effectiveOutcome.diagnostic)
      }
    : effectiveOutcome;

  // All AgentRun, active-pointer, Session, launch, and mailbox fences have passed.
  // Only now may the exact ReviewRound be terminalized alongside the AgentRun so a
  // stale fence never leaves a Round written while the AgentRun stays active.
  const reviewRoundTerminalization = terminalizeExactRunReviewRound(store, {
    taskId: input.taskId,
    run,
    outcome: terminalOutcome
  }, now);
  if (reviewRoundTerminalization.disposition !== "applied") {
    return obsolete(run, reviewRoundTerminalization.reason ?? "review-round-mismatch");
  }

  const terminal = terminalOutcome.status === "completed"
    ? completeRun(
        run,
        terminalOutcome.output,
        now,
        terminalOutcome.provider,
        input.systemEvidence
      )
    : failRun(
        run,
        terminalOutcome.failureReason,
        terminalOutcome.diagnostic,
        now,
        terminalOutcome.provider,
        terminalOutcome.output
      );
  if (run.executionGroupId !== undefined
    && run.executionLaneId !== undefined
    && run.purpose === "execution"
    && run.workItemId !== undefined) {
    const item = store.getWorkItem(input.taskId, run.workItemId);
    const group = item === null
      ? undefined
      : workItemExecutionGroupById(item, run.executionGroupId);
    if (item !== null && group !== undefined) {
      if (terminal.status === "completed") {
        const grouped = updateWorkItemExecutionLane(group, run.executionLaneId, {
          currentRunId: run.id,
          successfulRunId: run.id,
          disposition: "succeeded"
        }, now);
        store.saveWorkItem(input.taskId, updateWorkItemExecutionGroup(item, grouped, now));
      }
    }
  }
  if (run.executionGroupId !== undefined
    && run.executionLaneId !== undefined
    && run.purpose === "review"
    && run.reviewRoundId !== undefined) {
    const round = store.getReviewRound(input.taskId, run.reviewRoundId);
    const group = round?.executionGroup;
    if (round !== null
      && round !== undefined
      && group !== undefined
      && group.id === run.executionGroupId) {
      if (terminal.status === "completed") {
        const grouped = updateExecutionLane(group, run.executionLaneId, {
          currentRunId: run.id,
          successfulRunId: run.id,
          disposition: "succeeded"
        }, now);
        store.saveReviewRound(
          input.taskId,
          updateReviewExecutionGroup(round, grouped)
        );
      }
    }
  }
  store.saveRun(terminal);
  const pendingMessages = store.listMessages(terminal.taskId).filter((message) =>
    message.recipient?.roleName === terminal.roleName && message.recipient.ownerRunId !== undefined
    && message.continuation?.runId === undefined);
  if (pendingMessages.length > 0) {
    enqueueWork(store, { kind: "task", taskId: terminal.taskId }, "message-continuation", now,
      pendingMessages.slice(0, 16).map((message) => ({ type: "message", taskId: terminal.taskId, id: message.id })),
      { dedupeKey: `message-after-result:${terminal.taskId}/${terminal.id}` });
  }
  if (terminal.roleName !== "leader") {
    // Keep the report in its execution record; atomically publish only a
    // collaboration reference. Duplicate terminals have already returned.
    const message = createTaskMessage(
      store.nextMessageId(terminal.taskId), terminal.taskId,
      `Execution ${terminal.id} ${terminal.status}.`,
      "role-result", { type: "role", roleName: terminal.roleName }, now,
      { resultRef: { type: "agent-run-result", runId: terminal.id }, ...(terminal.workItemId === undefined
        ? {} : { workItemId: terminal.workItemId }) }
    );
    store.saveMessage(terminal.taskId, message);
    if (!providerRetryPending(store.getTaskRoleSessionSet(terminal.taskId, terminal.roleName)?.providerBinding)) {
      enqueueWork(store, { kind: "role", taskId: terminal.taskId, roleName: "leader" },
      "role-result", now, [{ type: "message", taskId: terminal.taskId, id: message.id }],
      { source: "task-event", dedupeKey: `result:${terminal.taskId}/${terminal.id}` });
    }
  }
  const dispatchIdentity = {
    taskId: terminal.taskId,
    roleName: terminal.roleName,
    runId: terminal.id
  };
  const dispatchToken = captureRoleRunDispatch(
    store.getWorkMailbox({
      kind: "role",
      taskId: terminal.taskId,
      roleName: terminal.roleName
    }),
    dispatchIdentity
  );
  settleRoleRunDispatch(store, dispatchIdentity, dispatchToken);
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
    store.clearActiveRun(input.taskId, input.roleName);
  }
  releaseDeferredTaskActivation(store, terminal, now);
  return { disposition: "applied", run: terminal };
}

/**
 * A planning Turn that deferred an activation has just ended, so signal the
 * Task mailbox to look at the request now.
 *
 * The signal carries no decision. Whether the request still applies is re-read
 * at the adoption boundary from facts that are current then, so a request
 * cancelled or a Task retired while this Turn was still running is never
 * replayed. Enqueuing inside the terminalization transaction keeps the release
 * atomic with the Turn becoming non-active: there is no window in which the
 * deferral is unblocked but nothing will look at it.
 */
function releaseDeferredTaskActivation(store: TaskStore, terminal: AgentRun, now: Date): void {
  if (terminal.purpose !== "planning") return;
  const request = store.getTask(terminal.taskId)?.activationRequest;
  if (request?.disposition !== "pending") return;
  if (request.afterPlanningRun !== terminal.id) return;
  enqueueWork(
    store,
    { kind: "task", taskId: terminal.taskId },
    "activation-deferral-released",
    now,
    [{ type: "task", id: terminal.taskId }]
  );
}

function obsolete(
  run: AgentRun | null,
  reason: string
): ExactRunTerminalizationResult {
  return { disposition: "obsolete", run, reason };
}
