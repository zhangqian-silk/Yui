import { isDeepStrictEqual } from "node:util";

import { completeProcessing } from "../coordination/workMailbox.js";
import type { TaskRoleSessionSet } from "../executor/agentExecutor.js";
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
  completeTurn,
  createProducerTurnResult,
  failTurn,
  type Turn,
  type TurnProviderResult
} from "../turn/turn.js";
import {
  recordExecutionLaneResult,
  resolveExecutionGroup,
  type ExecutionLaneGitSnapshot
} from "../execution/executionGroup.js";
import { updateWorkItemExecutionLane } from "../execution/workItemExecution.js";
import { reconcileWorkItemMainTurns } from "../execution/workItemMainTurn.js";
import {
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import { managedProviderTurnId } from "../runtime/providerRuntimeIdentity.js";
import {
  latestTurnDurableProgressAt
} from "../scheduler/roleTurnStall.js";
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
 * review Turn can settle any mailbox or Round state. This is deliberately
 * read-only: callers use it as the compare-and-swap fence immediately before
 * their aggregate mutation.
 */
export function validateExactTurnReviewRound(
  store: TaskStore,
  turn: Turn,
  options: Readonly<{ allowTerminal?: boolean }> = {}
): ExactReviewRoundTerminalizationResult {
  if (turn.purpose !== "review") return { disposition: "applied", round: null };
  if (turn.reviewRoundId === undefined) {
    return { disposition: "obsolete", round: null, reason: "review-round-missing" };
  }
  const round = store.getReviewRound(turn.taskId, turn.reviewRoundId);
  if (round === null) {
    return { disposition: "obsolete", round: null, reason: "review-round-missing" };
  }
  if (!options.allowTerminal
    && round.status !== "pending" && round.status !== "running") {
    return { disposition: "obsolete", round, reason: "review-round-terminal" };
  }
  const lane = round.executionGroup?.lanes.find(({ id }) => id === turn.executionLaneId);
  const exactReviewerTurn = round.reviewerTurnId === turn.id || lane?.turnId === turn.id;
  const exactReviewerRole = round.reviewerRoleName === turn.roleName || lane?.roleName === turn.roleName;
  if (!exactReviewerTurn
    || !exactReviewerRole
    || round.workItemId !== turn.workItemId
    || round.reviewBaseCommit !== turn.effective.reviewBaseCommit) {
    return { disposition: "obsolete", round, reason: "review-round-mismatch" };
  }
  const laneWorkspaceRoot = lane?.workspace?.root;
  if (turn.workspace === undefined || round.workspace === undefined
    || (laneWorkspaceRoot === undefined && !isDeepStrictEqual(turn.workspace, round.workspace))
    || (laneWorkspaceRoot !== undefined && turn.workspace.root !== laneWorkspaceRoot)) {
    return { disposition: "obsolete", round, reason: "review-workspace-mismatch" };
  }
  const storedWorkspace = turn.workspace.owner.type === "execution-lane"
    ? store.getManagedWorkspace(turn.workspace.owner)
    : store.getReviewRoundWorkspace(turn.taskId, round.id);
  if (storedWorkspace === null
    || (turn.workspace.owner.type !== "execution-lane"
      && !isDeepStrictEqual(storedWorkspace, round.workspace))
    || !isDeepStrictEqual(storedWorkspace, turn.workspace)) {
    return { disposition: "obsolete", round, reason: "review-workspace-drift" };
  }
  if (turn.workspace.owner.type !== "execution-lane") {
    if (storedWorkspace.owner.type !== "review-round"
      || storedWorkspace.owner.taskId !== turn.taskId
      || storedWorkspace.owner.reviewRoundId !== round.id) {
      return { disposition: "obsolete", round, reason: "review-workspace-owner-mismatch" };
    }
  }
  if (turn.workspace.owner.type === "execution-lane"
    && (turn.workspace.owner.purpose !== "review"
      || turn.workspace.owner.executionGroupId !== turn.executionGroupId
      || turn.workspace.owner.executionLaneId !== turn.executionLaneId
      || turn.workspace.owner.reviewRoundId !== round.id)) {
    return { disposition: "obsolete", round, reason: "review-lane-workspace-owner-mismatch" };
  }
  if (turn.workspace.owner.type === "execution-lane") {
    if (lane === undefined
      || lane.turnId !== turn.id
      || lane.roleName !== turn.roleName
      || lane.workspace?.root !== turn.workspace.root
      || lane.workspace.writableProjectIds.length !== turn.workspace.entries.length
      || turn.workspace.entries.some((entry) => (
        entry.access !== "write"
        || !lane.workspace!.writableProjectIds.includes(entry.projectId)
      ))) {
      return { disposition: "obsolete", round, reason: "review-lane-workspace-lineage-mismatch" };
    }
  }
  const task = store.getTask(turn.taskId);
  const taskScope = (round.scope ?? "work-item") === "task";
  const item = taskScope || round.workItemId === undefined
    ? null
    : store.getWorkItem(turn.taskId, round.workItemId);
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
 * Atomically terminalizes the exact ReviewRound bound to a review Turn.
 * The round must still be pending/running and its reviewer identity must match
 * the Turn exactly. This is the sole review-round convergence primitive shared
 * by the exact Turn terminalization path and the pre-delivery launch-failure
 * path: a failed review Turn must never leave its Round stranded.
 */
export function terminalizeExactTurnReviewRound(
  store: TaskStore,
  input: Readonly<{
    taskId: string;
    turn: Turn;
    outcome: Readonly<{ status: "completed" | "failed"; summary: string }>;
    reviewResult?: Readonly<{
      summary?: string;
      report?: string;
      checks?: readonly ReviewCheck[];
      findings?: readonly import("../execution/executionGroup.js").ExecutionFinding[];
      evidence?: readonly string[];
      evidenceCommit?: string;
      gitSnapshot?: ExecutionLaneGitSnapshot;
      deltaDisposition?: DeltaRecheckDisposition;
      deltaReasoning?: string;
    }>;
    /** Explicit retirement closes a fully terminal failed Group instead of leaving a retry path. */
    settleFailedExecutionGroup?: boolean;
  }>,
  now: Date
): ExactReviewRoundTerminalizationResult {
  const validation = validateExactTurnReviewRound(store, input.turn);
  if (validation.disposition !== "applied" || validation.round === null) {
    return validation;
  }
  const reviewRound = validation.round;
  let groupedRound = input.turn.executionGroupId !== undefined
    && input.turn.executionLaneId !== undefined
    && reviewRound.executionGroup !== undefined
    ? updateReviewExecutionGroup(
        reviewRound,
        recordExecutionLaneResult(
          reviewRound.executionGroup,
          input.turn.executionLaneId,
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
          input.outcome.status,
          now
        )
      )
    : reviewRound;
  if (input.settleFailedExecutionGroup === true
    && input.outcome.status === "failed"
    && groupedRound.executionGroup !== undefined
    && groupedRound.executionGroup.resolution === undefined
    && groupedRound.executionGroup.lanes.every((lane) => (
      lane.status === "completed"
      || lane.status === "failed"
      || lane.status === "skipped"
    ))) {
    groupedRound = updateReviewExecutionGroup(
      groupedRound,
      resolveExecutionGroup(groupedRound.executionGroup, {
        decision: "blocked",
        summary: input.outcome.summary
      }, now)
    );
  }
  const groupedMultiLane = groupedRound.executionGroup !== undefined
    && (groupedRound.executionGroup.lanes.length > 1
      || groupedRound.executionGroup.strategy.mode === "adaptive");
  if (groupedMultiLane
    && groupedRound.executionGroup !== undefined
    && groupedRound.executionGroup.resolution === undefined) {
    // A panel Lane only contributes evidence.  The Leader must see every
    // terminal Lane and explicitly resolve the Group before this ReviewRound
    // can become terminal.
    store.saveReviewRound(input.taskId, groupedRound);
    return { disposition: "applied", round: groupedRound };
  }
  const terminal = finishReviewRound(
    groupedRound,
    input.outcome.status,
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

export type ExactTurnTerminalizationInput = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  turnId: string;
  nativeSessionId?: string;
  launchId?: string;
  /** Aggregate retirement owns every queued Role signal, not only this Turn. */
  mailboxDisposition?: "exact" | "discard";
  /** Explicit retirement closes a fully terminal failed Group instead of leaving a retry path. */
  settleFailedExecutionGroup?: boolean;
  outcome: Readonly<{
    status: "completed" | "failed";
    summary: string;
    failureReason?: import("../turn/turn.js").TurnFailureReason;
    provider?: TurnProviderResult;
  }>;
  reviewResult?: Readonly<{
    summary?: string;
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

export type ExactTurnTerminalizationResult = Readonly<{
  disposition: "applied" | "obsolete";
  turn: Turn | null;
  reason?: string;
}>;

export type ExactTurnRetirementInput = Readonly<{
  taskId: string;
  roleName: string;
  turnId: string;
  agentId: string;
  adapterId: string;
  nativeSessionId?: string;
  launchId?: string;
  /** Exact semantic progress fence observed before the retirement request. */
  expectedProgressAt: string;
  reason: string;
}>;

export type ExactTurnRetirementResult = Readonly<{
  disposition: "applied" | "state-changed" | "blocked";
  turn: Turn | null;
  progressAt?: string;
  reason?: string;
}>;

/**
 * Retire one stranded active Turn only after its exact Provider Turn is
 * terminal and every durable execution fence is quiet. The caller owns the
 * surrounding aggregate transaction so the Turn, ReviewRound/Lane, mailbox,
 * Session, and append-only retirement record commit together.
 */
export function retireExactActiveTurn(
  store: TaskStore,
  input: ExactTurnRetirementInput,
  now: Date
): ExactTurnRetirementResult {
  const current = store.getTurn(input.taskId, input.turnId);
  const stateChanged = (reason: string): ExactTurnRetirementResult => ({
    disposition: "state-changed",
    turn: current,
    ...(current === null ? {} : { progressAt: latestTurnDurableProgressAt(
      store,
      input.taskId,
      input.roleName,
      input.turnId
    )?.progressAt }),
    reason
  });
  const task = store.getTask(input.taskId);
  if (task === null) return stateChanged("task-missing");
  if (task.status !== "active") return stateChanged("task-terminal");
  if (current === null) return stateChanged("turn-missing");
  if (current.status !== "active") return stateChanged("turn-terminal");
  if (current.taskId !== input.taskId || current.roleName !== input.roleName) {
    return stateChanged("turn-owner-mismatch");
  }
  if (current.effective.agentId !== input.agentId
    || current.effective.adapterId !== input.adapterId) {
    return stateChanged("turn-launch-identity-mismatch");
  }
  const active = current.executionGroupId !== undefined && current.executionLaneId !== undefined
    ? store.getActiveExecutionLaneTurn(
      input.taskId,
      current.executionGroupId,
      current.executionLaneId
    )
    : store.getActiveTurn(input.taskId, input.roleName);
  if (active?.id !== current.id) return stateChanged("active-turn-mismatch");
  const progress = latestTurnDurableProgressAt(
    store,
    input.taskId,
    input.roleName,
    input.turnId
  );
  if (progress === null) return stateChanged("progress-unavailable");
  if (progress.progressAt !== input.expectedProgressAt) {
    return { ...stateChanged("progress-fence-mismatch"), progressAt: progress.progressAt };
  }
  const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
  const terminalInput: ExactTurnTerminalizationInput = {
    taskId: input.taskId,
    roleName: input.roleName,
    agentId: input.agentId,
    turnId: input.turnId,
    ...(input.nativeSessionId === undefined ? {} : { nativeSessionId: input.nativeSessionId }),
    ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
    ...(current.purpose === "review" ? { settleFailedExecutionGroup: true } : {}),
    outcome: { status: "failed", summary: input.reason, failureReason: "missing-result" }
  };
  const session = sessions?.sessions[input.agentId];
  const providerBinding = sessions?.providerBinding;
  const providerTurn = providerBinding?.turn;
  const providerSettled = managedProviderTurnId(providerTurn) === current.id
    && (providerTurn?.status === "completed"
      || providerTurn?.status === "failed"
      || providerTurn?.status === "cancelled"
      || providerTurn?.status === "rejected");
  if (session?.status === "active" && !providerSettled) {
    return {
      disposition: "blocked",
      turn: current,
      progressAt: progress.progressAt,
      reason: "runtime-not-terminal"
    };
  }
  const terminal = terminalizeExactTaskTurn(store, terminalInput, now);
  if (terminal.disposition !== "applied" || terminal.turn === null) {
    return stateChanged(terminal.reason ?? "terminalization-fence-mismatch");
  }
  return {
    disposition: "applied",
    turn: terminal.turn,
    progressAt: progress.progressAt
  };
}

/**
 * Applies one exact application-level terminal fact inside the caller's
 * TaskStore transaction. All caller-owned outcome records can therefore
 * be saved in the same aggregate commit.
 */
export function terminalizeExactTaskTurn(
  store: TaskStore,
  input: ExactTurnTerminalizationInput,
  now: Date
): ExactTurnTerminalizationResult {
  const turn = store.getTurn(input.taskId, input.turnId);
  if (turn === null) return obsolete(null, "turn-missing");
  if (turn.status !== "active") return obsolete(turn, "turn-terminal");
  if (turn.taskId !== input.taskId || turn.roleName !== input.roleName) {
    return obsolete(turn, "turn-owner-mismatch");
  }
  if (turn.effective.agentId !== input.agentId) {
    return obsolete(turn, "turn-agent-mismatch");
  }
  const role = store.getRole(input.taskId, input.roleName);
  if (role === null) return obsolete(turn, "role-missing");
  const active = turn.executionGroupId !== undefined && turn.executionLaneId !== undefined
    ? store.getActiveExecutionLaneTurn(
      input.taskId,
      turn.executionGroupId,
      turn.executionLaneId
    )
    : store.getActiveTurn(input.taskId, input.roleName);
  if (active?.id !== turn.id) return obsolete(turn, "active-turn-mismatch");

  const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
  // Validate the exact ReviewRound, Candidate, stored workspace, and frozen
  // Project heads before any mailbox or Round write.
  const reviewValidation = validateExactTurnReviewRound(store, turn);
  if (reviewValidation.disposition !== "applied") {
    return obsolete(turn, reviewValidation.reason ?? "review-round-mismatch");
  }

  // All Turn, active-pointer, Session, launch, and mailbox fences have passed.
  // Only now may the exact ReviewRound be terminalized alongside the Turn so a
  // stale fence never leaves a Round written while the Turn stays active.
  const reviewRoundTerminalization = terminalizeExactTurnReviewRound(store, {
    taskId: input.taskId,
    turn,
    outcome: input.outcome,
    reviewResult: input.reviewResult,
    ...(input.settleFailedExecutionGroup === undefined
      ? {}
      : { settleFailedExecutionGroup: input.settleFailedExecutionGroup })
  }, now);
  if (reviewRoundTerminalization.disposition !== "applied") {
    return obsolete(turn, reviewRoundTerminalization.reason ?? "review-round-mismatch");
  }

  const producer = input.outcome.status === "completed"
    && turn.purpose === "execution"
    && turn.workItemId !== undefined
    && turn.executionGroupId !== undefined
    && turn.executionLaneId !== undefined
    ? createProducerTurnResult({
        summary: input.reviewResult?.summary ?? input.outcome.summary,
        ...(input.reviewResult?.report === undefined
          ? {}
          : { report: input.reviewResult.report }),
        ...(input.reviewResult?.checks === undefined
          ? {}
          : { checks: input.reviewResult.checks }),
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
          : {
              projectCodeRefs: input.reviewResult.gitSnapshot.projects.map((project) => ({
                projectId: project.projectId,
                commit: project.headCommit
              }))
            })
      })
    : undefined;
  const incompleteProducer = producer !== undefined
    && turn.effective.writeProjectIds.length > 0
    && (producer.codeRefs.length === 0 || producer.checks.length === 0);
  const terminal = input.outcome.status === "completed" && !incompleteProducer
    ? completeTurn(turn, input.outcome.summary, now, input.outcome.provider, producer)
    : failTurn(
        turn,
        incompleteProducer ? "missing-result" : input.outcome.failureReason ?? "runtime-failed",
        incompleteProducer
          ? "Producer result is missing an immutable code reference or validation check."
          : input.outcome.summary,
        now,
        input.outcome.provider
      );
  if (turn.executionGroupId !== undefined
    && turn.executionLaneId !== undefined
    && turn.purpose === "execution"
    && turn.workItemId !== undefined) {
    const item = store.getWorkItem(input.taskId, turn.workItemId);
    const group = item === null
      ? undefined
      : workItemExecutionGroupById(item, turn.executionGroupId);
    if (item !== null && group !== undefined) {
      if (terminal.status === "completed" || input.settleFailedExecutionGroup === true) {
        const grouped = updateWorkItemExecutionLane(group, turn.executionLaneId, {
          currentTurnId: turn.id,
          ...(terminal.status === "completed"
            ? { successfulTurnId: turn.id, disposition: "succeeded" as const }
            : { disposition: "failed" as const })
        }, now);
        store.saveWorkItem(input.taskId, updateWorkItemExecutionGroup(item, grouped, now));
      }
    }
  }
  store.saveTurn(terminal);
  if (terminal.roleName === "leader") {
    const wake = store.listTaskWakes(input.taskId)
      .find((candidate) => candidate.turnId === terminal.id && candidate.status === "dispatched");
    if (wake !== undefined) {
      store.saveTaskWake(input.taskId, markTaskWakeConsumed(wake, now));
    }
  }
  if (terminal.executionGroupId !== undefined && terminal.executionLaneId !== undefined) {
    store.clearActiveExecutionLaneTurn(
      input.taskId,
      terminal.executionGroupId,
      terminal.executionLaneId
    );
  } else {
    store.clearActiveTurn(input.taskId, input.roleName);
  }
  settleLaunchReservation(store, sessions, input);
  reconcileWorkItemMainTurns(store, input.taskId, now);
  return { disposition: "applied", turn: terminal };
}

function settleLaunchReservation(
  store: TaskStore,
  sessions: TaskRoleSessionSet | null,
  input: ExactTurnTerminalizationInput
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
  const launchId = input.nativeSessionId === undefined
    ? input.launchId ?? session?.launchId
    : session?.launchId;
  if (launchId === undefined || !isRuntimeLaunchReservation(reservation, launchId)) return;
  const settled = completeProcessing(mailbox!, reservation!.batchId);
  if (settled.processing === null && settled.pending === null) {
    store.removeWorkMailbox(target);
  } else {
    store.saveWorkMailbox(settled);
  }
}

function obsolete(
  turn: Turn | null,
  reason: string
): ExactTurnTerminalizationResult {
  return { disposition: "obsolete", turn, reason };
}
