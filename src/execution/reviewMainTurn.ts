import { enqueueWork } from "../coordination/workMailboxQueue.js";
import { createTurnInput } from "../context/turnInputContract.js";
import {
  contextSnapshotDeltaRefIds,
  freezeTurnContextSnapshot
} from "../context/turnContextPack.js";
import { contextSnapshotRef } from "../context/contextSnapshot.js";
import { roleAgentSessionResumeMode } from "../executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../executor/effectiveLaunch.js";
import { createTaskEvent } from "../event/taskEvent.js";
import {
  finishReviewRound,
  startReviewRound,
  type ReviewRound
} from "../review/reviewRound.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  createTurn,
  type ProducerTurnResult,
  type Turn
} from "../turn/turn.js";
import {
  executionGroupSettled,
  MINIMUM_SYNTHESIS_RESULTS,
  type ReviewExecutionGroup
} from "./workItemExecution.js";

export type ReviewSynthesisProducer = Readonly<{
  laneId: string;
  roleName: string;
  turnId: string;
  result: ProducerTurnResult;
}>;

export type ReviewMainTurnReconciliation = Readonly<{
  createdTurns: readonly Turn[];
  failedReviewRoundIds: readonly string[];
}>;

export function successfulReviewSynthesisProducers(
  store: Pick<TaskStore, "getTurn">,
  round: ReviewRound,
  group: ReviewExecutionGroup
): readonly ReviewSynthesisProducer[] {
  if (!executionGroupSettled(group)) {
    throw new Error(`Review ExecutionGroup is not settled: ${round.id}/${group.id}.`);
  }
  return [...group.lanes]
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    .flatMap((lane): ReviewSynthesisProducer[] => {
      if (lane.disposition !== "succeeded") return [];
      const turn = lane.successfulTurnId === undefined
        ? null
        : store.getTurn(round.taskId, lane.successfulTurnId);
      if (turn === null
        || turn.status !== "completed"
        || turn.purpose !== "review"
        || turn.reviewRoundId !== round.id
        || turn.executionGroupId !== group.id
        || turn.executionLaneId !== lane.id
        || turn.result?.producer === undefined) {
        throw new Error(
          `Successful Review ExecutionLane has no exact Producer result: `
          + `${group.id}/${lane.id}.`
        );
      }
      return [{
        laneId: lane.id,
        roleName: lane.roleName,
        turnId: turn.id,
        result: turn.result.producer
      }];
    });
}

/**
 * Projects a settled replicated Review into exactly one initial main Reviewer
 * synthesis Turn. Explicit Turn retry may create later main attempts with the
 * same source Group; successful producer Lanes remain immutable.
 */
export function reconcileReviewMainTurns(
  store: TaskStore,
  taskId: string,
  now: Date
): ReviewMainTurnReconciliation {
  const task = store.getTask(taskId);
  if (task === null || task.status !== "active") {
    return { createdTurns: [], failedReviewRoundIds: [] };
  }
  const createdTurns: Turn[] = [];
  const failedReviewRoundIds: string[] = [];
  const rounds = [...store.listReviewRounds(taskId)]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  for (const round of rounds) {
    const group = round.executionGroup;
    if (round.status !== "running"
      || group === undefined
      || round.reviewerTurnId !== undefined
      || !executionGroupSettled(group)) continue;
    const producers = successfulReviewSynthesisProducers(store, round, group);
    if (producers.length < MINIMUM_SYNTHESIS_RESULTS) {
      const summary = `Review ExecutionGroup ${group.id} settled with ${producers.length} `
        + `successful Producer result${producers.length === 1 ? "" : "s"}; at least `
        + `${MINIMUM_SYNTHESIS_RESULTS} are required.`;
      store.saveReviewRound(taskId, finishReviewRound(
        round,
        "failed",
        summary,
        now,
        { report: summary, checks: [] }
      ));
      store.saveEvent(taskId, createTaskEvent(
        store.nextEventId(taskId),
        taskId,
        "review.execution-group-failed",
        {
          reviewRoundId: round.id,
          executionGroupId: group.id,
          successfulProducerCount: String(producers.length),
          requiredProducerCount: String(MINIMUM_SYNTHESIS_RESULTS)
        },
        now
      ));
      failedReviewRoundIds.push(round.id);
      continue;
    }
    const existing = store.listTurns(taskId).filter((turn) => (
      turn.purpose === "review"
      && turn.reviewRoundId === round.id
      && turn.sourceExecutionGroupId === group.id
    ));
    if (existing.some(({ status }) => status !== "failed")) continue;
    const role = store.getRole(taskId, round.reviewerRoleName);
    if (role === null) {
      throw new Error(`Review main Role is missing: ${taskId}/${round.reviewerRoleName}.`);
    }
    if (store.getActiveTurn(taskId, role.name) !== null) continue;
    const workspace = store.getReviewRoundWorkspace(taskId, round.id);
    if (workspace === null) {
      throw new Error(`Review main workspace is missing: ${taskId}/${round.id}.`);
    }
    const effective = resolveEffectiveLaunch({
      role,
      purpose: "review",
      workspace,
      reviewRoundId: round.id,
      reviewBaseCommit: round.reviewBaseCommit
    });
    const snapshot = freezeTurnContextSnapshot(store, {
      taskId,
      roleName: role.name,
      purpose: "review",
      ...(round.workItemId === undefined ? {} : { workItemId: round.workItemId }),
      reviewRoundId: round.id
    }, now, "controller", group.assignment.contextSnapshotRef);
    const turn = createTurn(
      store.nextTurnId(taskId),
      taskId,
      role.name,
      roleAgentSessionResumeMode(
        store.getTaskRoleSessionSet(taskId, role.name),
        effective.agentId,
        effective
      ),
      createTurnInput({
        source: {
          type: "yui",
          channel: round.workItemId === undefined ? "task-dispatch" : "workitem-dispatch"
        },
        directive: synthesisDirective(group, producers),
        contextSnapshotRef: contextSnapshotRef(snapshot),
        deltaRefIds: contextSnapshotDeltaRefIds(store, snapshot)
      }),
      now,
      {
        ...(round.workItemId === undefined ? {} : { workItemId: round.workItemId }),
        purpose: "review",
        reviewRoundId: round.id,
        sourceExecutionGroupId: group.id,
        workspace,
        effective
      }
    );
    store.saveTurn(turn);
    store.saveReviewRound(taskId, startReviewRound(round, turn.id));
    store.saveActiveTurn(turn);
    enqueueWork(
      store,
      { kind: "role", taskId, roleName: role.name },
      "review-synthesis-ready",
      now,
      [
        { type: "turn", taskId, id: turn.id },
        ...(round.workItemId === undefined
          ? []
          : [{ type: "work-item" as const, taskId, id: round.workItemId }])
      ]
    );
    store.saveEvent(taskId, createTaskEvent(
      store.nextEventId(taskId),
      taskId,
      "turn.review-dispatched",
      {
        turnId: turn.id,
        role: turn.roleName,
        purpose: turn.purpose,
        mode: turn.mode,
        agent: `${turn.effective.agentId}/${turn.effective.adapterId}`,
        effectiveRevision: String(turn.effective.sourceDesiredRevision),
        profileAccess: turn.effective.profileAccess,
        effectivePermission: turn.effective.permission.strategy,
        writeProjectIds: turn.effective.writeProjectIds.join(",") || "none",
        reviewRoundId: round.id,
        sourceExecutionGroupId: group.id
      },
      now
    ));
    createdTurns.push(turn);
  }
  return { createdTurns, failedReviewRoundIds };
}

function synthesisDirective(
  group: ReviewExecutionGroup,
  producers: readonly ReviewSynthesisProducer[]
): string {
  return [
    "Act as the authoritative main Reviewer over the frozen successful Producer results below.",
    "Inspect and synthesize every successful result in stable Lane order. Do not rerun, retry, append, select, or abandon Lanes.",
    "Only this main Review Turn may establish Review findings, checks, semantic outcome, and completion evidence.",
    JSON.stringify({
      schemaVersion: 1,
      sourceExecutionGroupId: group.id,
      assignment: group.assignment,
      producers
    }, null, 2)
  ].join("\n\n");
}
