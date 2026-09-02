import { isDeepStrictEqual } from "node:util";

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
import type { TaskStore } from "../storage/taskStore.js";
import {
  createTurn,
  type ProducerTurnResult,
  type Turn
} from "../turn/turn.js";
import {
  currentWorkItemExecutionGroup,
  updateWorkItemStatus,
  type WorkItem
} from "../workItem/workItem.js";
import {
  MINIMUM_WORK_ITEM_SYNTHESIS_RESULTS,
  workItemExecutionGroupSettled,
  type WorkItemExecutionGroup
} from "./workItemExecution.js";

export type WorkItemSynthesisProducer = Readonly<{
  laneId: string;
  roleName: string;
  turnId: string;
  result: ProducerTurnResult;
}>;

export type WorkItemMainTurnReconciliation = Readonly<{
  createdTurns: readonly Turn[];
  failedWorkItemIds: readonly string[];
}>;

export function successfulWorkItemSynthesisProducers(
  store: Pick<TaskStore, "getTurn">,
  item: WorkItem,
  group: WorkItemExecutionGroup
): readonly WorkItemSynthesisProducer[] {
  if (!workItemExecutionGroupSettled(group)) {
    throw new Error(`WorkItem ExecutionGroup is not settled: ${item.id}/${group.id}.`);
  }
  return [...group.lanes]
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    .flatMap((lane): WorkItemSynthesisProducer[] => {
      if (lane.disposition !== "succeeded") return [];
      const turn = lane.successfulTurnId === undefined
        ? null
        : store.getTurn(item.taskId, lane.successfulTurnId);
      if (turn === null
        || turn.status !== "completed"
        || turn.workItemId !== item.id
        || turn.executionGroupId !== group.id
        || turn.executionLaneId !== lane.id
        || turn.result?.producer === undefined) {
        throw new Error(
          `Successful ExecutionLane has no exact Producer Turn result: ${group.id}/${lane.id}.`
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
 * Reconcile every settled replicated WorkItem in one Task. The Turn row is the
 * durable caller/idempotency record: at most one initial main Turn may name a
 * source Group, while explicit retries append more Turns with the same source.
 */
export function reconcileWorkItemMainTurns(
  store: TaskStore,
  taskId: string,
  now: Date
): WorkItemMainTurnReconciliation {
  const task = store.getTask(taskId);
  if (task === null || task.status !== "active" || task.executionGate.state !== "enabled") {
    return { createdTurns: [], failedWorkItemIds: [] };
  }
  const createdTurns: Turn[] = [];
  const failedWorkItemIds: string[] = [];
  const items = [...store.listWorkItems(taskId)].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  ));
  for (const item of items) {
    if (item.status !== "running") continue;
    const group = currentWorkItemExecutionGroup(item);
    if (group === undefined || !workItemExecutionGroupSettled(group)) continue;
    const producers = successfulWorkItemSynthesisProducers(store, item, group);
    if (producers.length < MINIMUM_WORK_ITEM_SYNTHESIS_RESULTS) {
      const summary = `ExecutionGroup ${group.id} settled with ${producers.length} successful `
        + `Producer result${producers.length === 1 ? "" : "s"}; at least `
        + `${MINIMUM_WORK_ITEM_SYNTHESIS_RESULTS} are required.`;
      store.saveWorkItem(taskId, updateWorkItemStatus(item, "failed", now, summary));
      store.saveEvent(taskId, createTaskEvent(
        store.nextEventId(taskId),
        taskId,
        "work.execution-group-failed",
        {
          workItemId: item.id,
          executionGroupId: group.id,
          successfulProducerCount: String(producers.length),
          requiredProducerCount: String(MINIMUM_WORK_ITEM_SYNTHESIS_RESULTS)
        },
        now
      ));
      failedWorkItemIds.push(item.id);
      continue;
    }
    const existing = store.listTurns(taskId).some((turn) => (
      turn.purpose === "execution"
      && turn.workItemId === item.id
      && turn.sourceExecutionGroupId === group.id
    ));
    if (existing) continue;
    if (item.assignee === undefined) {
      throw new Error(`Replicated WorkItem has no main assignee: ${item.id}.`);
    }
    const role = store.getRole(taskId, item.assignee);
    if (role === null) throw new Error(`WorkItem main Role is missing: ${taskId}/${item.assignee}.`);
    if (store.getActiveTurn(taskId, role.name) !== null) continue;
    const workspace = role.name === "leader"
      ? store.getTaskWorkspace(taskId)
      : store.getWorkItemWorkspace(taskId, item.id);
    if (workspace === null) {
      throw new Error(`WorkItem main workspace is missing: ${taskId}/${item.id}.`);
    }
    const visibleProjectIds = workspace.entries.map(({ projectId }) => projectId).sort();
    const taskProjectIds = task.projectBindings.map(({ projectId }) => projectId).sort();
    const writableProjectIds = workspace.entries
      .filter(({ access }) => access === "write")
      .map(({ projectId }) => projectId)
      .sort();
    if (!isDeepStrictEqual(visibleProjectIds, taskProjectIds)
      || !isDeepStrictEqual(writableProjectIds, [...item.writeProjectIds].sort())) {
      throw new Error(`WorkItem main workspace does not match its approved scope: ${item.id}.`);
    }
    const effective = resolveEffectiveLaunch({
      role,
      purpose: "execution",
      workspace,
      workItemWriteProjectIds: item.writeProjectIds
    });
    const snapshot = freezeTurnContextSnapshot(store, {
      taskId,
      roleName: role.name,
      purpose: "execution",
      workItemId: item.id,
      workspace
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
        source: { type: "yui", channel: "workitem-dispatch" },
        directive: synthesisDirective(group, producers),
        contextSnapshotRef: contextSnapshotRef(snapshot),
        deltaRefIds: contextSnapshotDeltaRefIds(store, snapshot)
      }),
      now,
      {
        workItemId: item.id,
        sourceExecutionGroupId: group.id,
        workspace,
        effective
      }
    );
    store.saveTurn(turn);
    store.saveActiveTurn(turn);
    enqueueWork(
      store,
      { kind: "role", taskId, roleName: role.name },
      "workitem-synthesis-ready",
      now,
      [
        { type: "turn", taskId, id: turn.id },
        { type: "work-item", taskId, id: item.id }
      ]
    );
    store.saveEvent(taskId, createTaskEvent(
      store.nextEventId(taskId),
      taskId,
      "turn.dispatched",
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
        workItemId: item.id,
        sourceExecutionGroupId: group.id
      },
      now
    ));
    createdTurns.push(turn);
  }
  return { createdTurns, failedWorkItemIds };
}

function synthesisDirective(
  group: WorkItemExecutionGroup,
  producers: readonly WorkItemSynthesisProducer[]
): string {
  return [
    "Synthesize the frozen successful Producer results below in the WorkItem main workspace.",
    "Do not rerun, retry, append, or abandon any Lane. Form the final WorkItem result from these records.",
    JSON.stringify({
      schemaVersion: 1,
      sourceExecutionGroupId: group.id,
      assignment: group.assignment,
      producers
    }, null, 2)
  ].join("\n\n");
}
