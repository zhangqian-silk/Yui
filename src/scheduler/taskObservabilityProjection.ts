import type { ContextSnapshot } from "../context/contextSnapshot.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type {
  ExecutionGroup,
  WorkItemExecutionGroup
} from "../execution/workItemExecution.js";
import type { Turn } from "../turn/turn.js";
import type { SessionTokenMetrics } from "../runtime/sessionTokenMetrics.js";
import type { WorkItem, WorkItemStatus } from "../workItem/workItem.js";

export type TaskDagNodeStatus =
  | "ready"
  | "blocked"
  | "running"
  | "awaiting_acceptance"
  | "completed"
  | "failed"
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

export type TaskCostProjection = Readonly<{
  tokens: number;
  toolCalls: number;
  wallClockSeconds: number;
  tokensObservable: boolean;
  toolCallsObservable: boolean;
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
  evidenceCount: number | null;
  openFindingCount: number | null;
}>;

export type TaskObservabilityProjection = Readonly<{
  dag: TaskDagProjection;
  workItems: readonly WorkItemObservabilityProjection[];
  cost: TaskCostProjection;
  context: TaskContextProjection;
  /** Per-generation read-only token metrics; never an aggregate decision input. */
  sessionTokens: readonly TaskSessionTokenProjection[];
}>;

export type TaskObservabilityInput = Readonly<{
  workItems: readonly WorkItem[];
  executionGroups: readonly ExecutionGroup[];
  turns: readonly Turn[];
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
    const itemCost = projectWorkItemCost(groups, input.turns, now);
    const itemContext = projectContext(groups, input.turns, input.contextSnapshots);
    const producerObservability = projectWorkItemProducerObservability(item, input.turns);
    return Object.freeze({
      workItemId: item.id,
      title: item.title,
      status: item.status,
      groupIds: groups.map(({ id }) => id),
      cost: itemCost,
      context: itemContext,
      evidenceCount: producerObservability?.evidenceCount ?? null,
      openFindingCount: producerObservability?.openFindingCount ?? null
    });
  });
  const cost = projectCost(input.executionGroups, input.turns, input.events, now);
  const context = projectContext(input.executionGroups, input.turns, input.contextSnapshots);
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
  turns: readonly Turn[]
): Readonly<{ evidenceCount: number; openFindingCount: number }> | null {
  const successfulLanes = item.executionGroups.flatMap((group) => group.lanes.flatMap((lane) => (
    lane.disposition === "succeeded" ? [{ group, lane }] : []
  )));
  let evidenceCount = 0;
  let openFindingCount = 0;
  for (const { group, lane } of successfulLanes) {
    const turn = lane.successfulTurnId === undefined
      ? undefined
      : turns.find(({ id }) => id === lane.successfulTurnId);
    const producer = turn?.result?.producer;
    if (turn === undefined
      || producer === undefined
      || turn.status !== "completed"
      || turn.taskId !== item.taskId
      || turn.workItemId !== item.id
      || turn.executionGroupId !== group.id
      || turn.executionLaneId !== lane.id
      || turn.roleName !== lane.roleName) return null;
    evidenceCount += producer.evidence.length;
    openFindingCount += producer.findings.filter(({ status }) => status === "open").length;
  }
  return { evidenceCount, openFindingCount };
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
    const projectedStatus = item.status === "pending"
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
      if (item.status === "failed" || item.status === "awaiting_acceptance") result.push(item.id);
      return;
    }
    for (const dependency of unresolved) {
      const target = byId.get(dependency);
      if (target?.status === "failed" || target?.status === "awaiting_acceptance") result.push(target.id);
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
  return byId.get(id)?.status === "completed";
}

function dependencyEdgeStatus(
  id: string,
  byId: ReadonlyMap<string, WorkItem>
): TaskDagEdgeStatus {
  const target = byId.get(id);
  if (target === undefined) return "dead";
  if (dependencySatisfied(id, byId)) return "satisfied";
  if (target.status === "retired") return "dead";
  if (target.status === "failed" || target.status === "awaiting_acceptance") return "failed-open";
  return "active";
}

function projectCost(
  groups: readonly ExecutionGroup[],
  turns: readonly Turn[],
  _events: readonly TaskEvent[],
  now: Date
): TaskCostProjection {
  const uniqueGroups = [...new Map(groups.map((group) => [group.id, group])).values()];
  const groupIds = new Set(uniqueGroups.map(({ id }) => id));
  const attempts = turns.filter(({ executionGroupId }) => (
    executionGroupId !== undefined && groupIds.has(executionGroupId)
  ));
  const laneCount = uniqueGroups.reduce((total, group) => total + group.lanes.length, 0);
  return Object.freeze({
    tokens: 0,
    toolCalls: 0,
    wallClockSeconds: uniqueGroups.reduce(
      (total, group) => total + groupDurationSeconds(group, now),
      0
    ),
    tokensObservable: false,
    toolCallsObservable: false,
    laneCount,
    groupCount: uniqueGroups.length,
    retryCount: Math.max(0, attempts.length - laneCount),
    marginalValuePercent: null,
    marginalValueStatus: "unavailable"
  });
}

function projectWorkItemCost(
  groups: readonly WorkItemExecutionGroup[],
  turns: readonly Turn[],
  now: Date
): TaskCostProjection {
  const groupIds = new Set(groups.map(({ id }) => id));
  const attempts = turns.filter(({ executionGroupId }) => (
    executionGroupId !== undefined && groupIds.has(executionGroupId)
  ));
  const wallClockSeconds = groups.reduce((total, group) => {
    const started = Date.parse(group.createdAt);
    const ended = group.lanes.some(({ disposition }) => disposition === "open")
      ? now.getTime()
      : Date.parse(group.updatedAt);
    return total + (Number.isFinite(started) && Number.isFinite(ended)
      ? Math.max(0, Math.floor((ended - started) / 1_000))
      : 0);
  }, 0);
  const laneCount = groups.reduce((total, group) => total + group.lanes.length, 0);
  return Object.freeze({
    tokens: 0,
    toolCalls: 0,
    wallClockSeconds,
    tokensObservable: false,
    toolCallsObservable: false,
    laneCount,
    groupCount: groups.length,
    retryCount: Math.max(0, attempts.length - laneCount),
    marginalValuePercent: null,
    marginalValueStatus: "unavailable"
  });
}

function projectContext(
  groups: readonly ExecutionGroup[],
  turns: readonly Turn[],
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
  for (const turn of turns) {
    const ref = turn.inputs[0]!.input.contextSnapshotRef;
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

function groupDurationSeconds(group: ExecutionGroup, now: Date): number {
  const started = Date.parse(group.createdAt);
  const ended = group.lanes.some(({ disposition }) => disposition === "open")
    ? now.getTime()
    : Date.parse(group.updatedAt);
  return Number.isFinite(started) && Number.isFinite(ended)
    ? Math.max(0, Math.floor((ended - started) / 1_000))
    : 0;
}
