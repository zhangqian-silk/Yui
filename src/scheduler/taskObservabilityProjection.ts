import type { ContextSnapshot } from "../context/contextSnapshot.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { ExecutionGroup } from "../execution/workItemExecution.js";
import type { AgentRun } from "../agentRun/agentRun.js";
import type { SessionTokenMetrics } from "../runtime/sessionTokenMetrics.js";
import { projectTaskUsageMetrics, type TaskUsageMetrics } from "../runtime/taskUsageMetrics.js";
import type { Task } from "../task/task.js";
import type { WorkItem, WorkItemStatus } from "../workItem/workItem.js";

export type TaskDagNodeStatus =
  | "ready"
  | "blocked"
  | "open"
  | "accepted"
  | "retired";

export type TaskDagEdgeStatus = "satisfied" | "active" | "failed-open" | "dead";

export type TaskDagNode = Readonly<{
  id: string;
  title: string;
  status: WorkItemStatus;
  projectedStatus: TaskDagNodeStatus;
  dependsOn: readonly string[];
  dependentIds: readonly string[];
  rootCauseIds: readonly string[];
  replacementWorkItemId?: string;
}>;

export type TaskDagEdge = Readonly<{
  from: string;
  to: string;
  status: TaskDagEdgeStatus;
}>;

export type TaskDagProjection = Readonly<{
  nodes: readonly TaskDagNode[];
  edges: readonly TaskDagEdge[];
  readyIds: readonly string[];
  blockedIds: readonly string[];
}>;

export type TaskCostProjection = TaskUsageMetrics & Readonly<{
  laneCount: number;
  groupCount: number;
  retryCount: number;
  /** No durable marginal-value observation exists yet; never infer one. */
  marginalValuePercent: number | null;
  marginalValueStatus: "unavailable";
}>;

export type ContextSnapshotMetric = Readonly<{
  id: string;
  scope: ContextSnapshot["scope"];
  sequence: number;
  digest: string;
  refCount: number | null;
  resourceCount: number | null;
  byteSize: number | null;
  parentId?: string;
}>;

export type TaskContextProjection = Readonly<{
  snapshotCount: number;
  snapshots: readonly ContextSnapshotMetric[];
  totalBytes: number | null;
  largestBytes: number | null;
  compressionEvents: number | null;
  compressionRatio: number | null;
  compressionStatus: "unavailable";
}>;

export type TaskSessionTokenProjection = Readonly<{
  roleName: string;
  agentId: string;
  metrics: SessionTokenMetrics;
}>;

export type WorkItemObservabilityProjection = Readonly<{
  workItemId: string;
  title: string;
  status: WorkItemStatus;
  groupIds: readonly string[];
  cost: TaskCostProjection;
  context: TaskContextProjection;
  resultCount: number | null;
}>;

export type TaskObservabilityProjection = Readonly<{
  dag: TaskDagProjection;
  workItems: readonly WorkItemObservabilityProjection[];
  cost: TaskCostProjection;
  context: TaskContextProjection;
  /** Per-Session read-only token metrics; never an aggregate decision input. */
  sessionTokens: readonly TaskSessionTokenProjection[];
}>;

export type TaskObservabilityInput = Readonly<{
  task: Pick<Task, "id" | "status" | "createdAt" | "completedAt" | "retiredAt">;
  workItems: readonly WorkItem[];
  executionGroups: readonly ExecutionGroup[];
  runs: readonly AgentRun[];
  events: readonly TaskEvent[];
  contextSnapshots?: readonly ContextSnapshot[];
  sessionTokens?: readonly TaskSessionTokenProjection[];
  now?: Date;
}>;

/**
 * Build the read-only DAG, execution, cost, and context view consumed by CLI
 * and Web. It deliberately derives every value from existing Task records and
 * never persists or repairs a second graph/status authority.
 */
export function buildTaskObservabilityProjection(
  input: TaskObservabilityInput
): TaskObservabilityProjection {
  const now = input.now ?? new Date();
  const dag = projectDag(input.workItems);
  const workItems = input.workItems.map((item) => {
    const groups = item.executionGroups;
    const itemCost = projectCost({ ...input, now }, groups, item.id);
    const itemContext = projectContext(groups, input.runs, input.contextSnapshots);
    const producerObservability = projectWorkItemProducerObservability(item, input.runs);
    return Object.freeze({
      workItemId: item.id,
      title: item.title,
      status: item.status,
      groupIds: groups.map(({ id }) => id),
      cost: itemCost,
      context: itemContext,
      resultCount: producerObservability?.resultCount ?? null
    });
  });
  const cost = projectCost({ ...input, now }, input.executionGroups);
  const context = projectContext(input.executionGroups, input.runs, input.contextSnapshots);
  return Object.freeze({
    dag,
    workItems,
    cost,
    context,
    sessionTokens: Object.freeze([...(input.sessionTokens ?? [])])
  });
}

function projectWorkItemProducerObservability(
  item: WorkItem,
  runs: readonly AgentRun[]
): Readonly<{ resultCount: number }> | null {
  const successfulLanes = item.executionGroups.flatMap((group) => group.lanes.flatMap((lane) => (
    lane.disposition === "succeeded" ? [{ group, lane }] : []
  )));
  let resultCount = 0;
  for (const { group, lane } of successfulLanes) {
    const run = lane.successfulRunId === undefined
      ? undefined
      : runs.find(({ id }) => id === lane.successfulRunId);
    if (run === undefined
      || run.result === undefined
      || run.status !== "completed"
      || run.taskId !== item.taskId
      || run.workItemId !== item.id
      || run.executionGroupId !== group.id
      || run.executionLaneId !== lane.id
      || run.roleName !== lane.roleName) return null;
    resultCount += 1;
  }
  return { resultCount };
}

function projectDag(workItems: readonly WorkItem[]): TaskDagProjection {
  const byId = new Map(workItems.map((item) => [item.id, item]));
  const dependents = new Map<string, string[]>();
  for (const item of workItems) dependents.set(item.id, []);
  const edges: TaskDagEdge[] = [];
  for (const item of workItems) {
    for (const dependency of item.dependsOn) {
      const target = byId.get(dependency);
      const status = dependencyEdgeStatus(dependency, byId);
      edges.push({ from: dependency, to: item.id, status });
      dependents.get(dependency)?.push(item.id);
    }
  }
  const nodes = workItems.map((item) => {
    const unresolved = item.dependsOn.filter((dependency) => {
      return !dependencySatisfied(dependency, byId);
    });
    const projectedStatus = item.status === "open"
      ? unresolved.length === 0 ? "ready" : "blocked"
      : item.status;
    return Object.freeze({
      id: item.id,
      title: item.title,
      status: item.status,
      projectedStatus,
      dependsOn: item.dependsOn,
      dependentIds: Object.freeze([...(dependents.get(item.id) ?? [])]),
      rootCauseIds: Object.freeze(rootCauses(item.id, byId)),
      ...(item.disposition?.replacementWorkItemId === undefined
        ? {}
        : { replacementWorkItemId: item.disposition.replacementWorkItemId })
    });
  });
  return Object.freeze({
    nodes,
    edges: Object.freeze(edges),
    readyIds: Object.freeze(nodes.filter(({ projectedStatus }) => projectedStatus === "ready").map(({ id }) => id)),
    blockedIds: Object.freeze(nodes.filter(({ projectedStatus }) => projectedStatus === "blocked").map(({ id }) => id))
  });
}

function rootCauses(
  id: string,
  byId: ReadonlyMap<string, WorkItem>
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const visit = (currentId: string): void => {
    if (visited.has(currentId)) return;
    visited.add(currentId);
    const item = byId.get(currentId);
    if (item === undefined) {
      result.push(currentId);
      return;
    }
    if (item.status === "retired") {
      result.push(item.id);
      return;
    }
    const unresolved = item.dependsOn.filter((dependency) => !dependencySatisfied(dependency, byId));
    if (unresolved.length === 0) {
      if (item.status === "open" && item.currentCandidateId !== undefined) result.push(item.id);
      return;
    }
    for (const dependency of unresolved) {
      const target = byId.get(dependency);
      if (target?.status === "open" && target.currentCandidateId !== undefined) result.push(target.id);
      else visit(dependency);
    }
  };
  visit(id);
  return [...new Set(result)];
}

function dependencySatisfied(
  id: string,
  byId: ReadonlyMap<string, WorkItem>
): boolean {
  return byId.get(id)?.status === "accepted";
}

function dependencyEdgeStatus(
  id: string,
  byId: ReadonlyMap<string, WorkItem>
): TaskDagEdgeStatus {
  const target = byId.get(id);
  if (target === undefined) return "dead";
  if (dependencySatisfied(id, byId)) return "satisfied";
  if (target.status === "retired") return "dead";
  if (target.status === "open" && target.currentCandidateId !== undefined) return "active";
  return "active";
}

function projectCost(
  input: TaskObservabilityInput,
  groups: readonly ExecutionGroup[],
  workItemId?: string
): TaskCostProjection {
  const uniqueGroups = [...new Map(groups.map((group) => [group.id, group])).values()];
  const groupIds = new Set(uniqueGroups.map(({ id }) => id));
  const attempts = input.runs.filter(({ executionGroupId }) => (
    executionGroupId !== undefined && groupIds.has(executionGroupId)
  ));
  const laneCount = uniqueGroups.reduce((total, group) => total + group.lanes.length, 0);
  return Object.freeze({
    ...projectTaskUsageMetrics({ ...input, workItemId }),
    laneCount,
    groupCount: uniqueGroups.length,
    retryCount: Math.max(0, attempts.length - laneCount),
    marginalValuePercent: null,
    marginalValueStatus: "unavailable"
  });
}

function projectContext(
  groups: readonly ExecutionGroup[],
  runs: readonly AgentRun[],
  snapshots?: readonly ContextSnapshot[]
): TaskContextProjection {
  const refs = new Map<string, {
    id: string;
    scope: ContextSnapshot["scope"];
    sequence: number;
    digest: string;
  }>();
  for (const group of groups) {
    const ref = group.assignment.contextSnapshotRef;
    if (ref !== undefined) refs.set(ref.id, ref);
  }
  for (const run of runs) {
    const ref = run.inputs[0]!.input.contextSnapshotRef;
    if (ref !== undefined) refs.set(ref.id, ref);
  }
  const snapshotById = new Map((snapshots ?? []).map((snapshot) => [snapshot.id, snapshot]));
  const metrics = [...refs.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    .map((ref) => {
      const snapshot = snapshotById.get(ref.id);
      const byteSize = snapshot === undefined ? null : Buffer.byteLength(JSON.stringify(snapshot), "utf8");
      return Object.freeze({
        id: ref.id,
        scope: ref.scope,
        sequence: ref.sequence,
        digest: ref.digest,
        refCount: snapshot?.refs.length ?? null,
        resourceCount: snapshot?.resources.length ?? null,
        byteSize,
        ...(snapshot?.parentRef === undefined ? {} : { parentId: snapshot.parentRef.id })
      });
    });
  const sizes = metrics.flatMap(({ byteSize }) => byteSize === null ? [] : [byteSize]);
  return Object.freeze({
    snapshotCount: metrics.length,
    snapshots: Object.freeze(metrics),
    totalBytes: sizes.length === metrics.length ? sizes.reduce((sum, size) => sum + size, 0) : null,
    largestBytes: sizes.length === 0 ? null : Math.max(...sizes),
    compressionEvents: null,
    compressionRatio: null,
    compressionStatus: "unavailable"
  });
}
