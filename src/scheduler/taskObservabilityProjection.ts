import type { ContextSnapshot } from "../context/contextSnapshot.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { ExecutionGroup, ExecutionLaneStatus } from "../execution/executionGroup.js";
import { isDeepStrictEqual } from "node:util";
import {
  observedExecutionResourceUsage,
  type ExecutionStageResourceProjection
} from "../execution/resourceBroker.js";
import type { Turn } from "../turn/turn.js";
import type { SessionTokenMetrics } from "../runtime/sessionTokenMetrics.js";
import type { WorkItem, WorkItemStatus } from "../workItem/workItem.js";
import type { ExecutionGroupHealthSummary } from "../execution/executionHealth.js";

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
  currentGroupId?: string;
  groupIds: readonly string[];
  executionGroups: readonly ExecutionGroupHealthSummary[];
  stages: readonly Readonly<{
    groupId: string;
    mode?: string;
    stage?: string;
    round?: number;
    stageAttempt?: number;
    laneCount: number;
    activeLaneCount: number;
    terminalLaneCount: number;
    resolution?: string;
    resources?: ExecutionStageResourceProjection;
  }>[];
  cost: TaskCostProjection;
  context: TaskContextProjection;
  evidenceCount: number;
  openFindingCount: number;
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
  groupSummaries?: readonly ExecutionGroupHealthSummary[];
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
  const summariesById = new Map((input.groupSummaries ?? []).map((summary) => [summary.groupId, summary]));
  const dag = projectDag(input.workItems);
  const workItems = input.workItems.map((item) => {
    const groups = item.executionGroups;
    const executionGroups = groups.flatMap((group) => {
      const summary = summariesById.get(group.id);
      return summary === undefined ? [] : [summary];
    });
    const stages = groups.map((group) => {
      const summary = summariesById.get(group.id);
      return Object.freeze({
        groupId: group.id,
        ...(group.stage === undefined ? {} : {
          mode: group.stage.mode,
          stage: group.stage.stage,
          round: group.stage.round,
          stageAttempt: group.stage.stageAttempt
        }),
        laneCount: group.lanes.length,
        activeLaneCount: group.lanes.filter(({ status }) => status === "pending" || status === "running").length,
        terminalLaneCount: group.lanes.filter(({ status }) => isTerminalLane(status)).length,
        ...(group.resolution === undefined ? {} : { resolution: group.resolution.decision }),
        ...(summary?.resources === undefined ? {} : { resources: summary.resources })
      });
    });
    const itemCost = projectCost(groups, input.turns, input.events, now);
    const itemContext = projectContext(groups, input.turns, input.contextSnapshots);
    const evidence = groups.flatMap((group) => group.lanes.flatMap((lane) => (
      lane.result?.evidence ?? []
    )));
    const openFindingCount = groups.reduce((count, group) => count + group.lanes.reduce(
      (laneCount, lane) => laneCount + (lane.result?.findings ?? [])
        .filter(({ status }) => status === "open").length,
      0
    ), 0);
    return Object.freeze({
      workItemId: item.id,
      title: item.title,
      status: item.status,
      ...(item.currentExecutionGroupId === undefined ? {} : { currentGroupId: item.currentExecutionGroupId }),
      groupIds: groups.map(({ id }) => id),
      executionGroups,
      stages,
      cost: itemCost,
      context: itemContext,
      evidenceCount: evidence.length,
      openFindingCount
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
    const unresolved = item.dependsOn.filter((dependency) => !dependencySatisfied(dependency, byId));
    if (unresolved.length === 0) {
      if (item.status === "failed" || item.status === "awaiting_acceptance") result.push(item.id);
      return;
    }
    for (const dependency of unresolved) {
      const target = resolveDependency(dependency, byId);
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
  const target = resolveDependency(id, byId);
  return target !== undefined && (target.status === "completed" || (
    target.status === "retired" && target.disposition?.replacementWorkItemId === undefined
  ));
}

function dependencyEdgeStatus(
  id: string,
  byId: ReadonlyMap<string, WorkItem>
): TaskDagEdgeStatus {
  const target = byId.get(id);
  if (target === undefined) return "dead";
  if (dependencySatisfied(id, byId)) return "satisfied";
  const resolved = resolveDependency(id, byId);
  if (resolved === undefined) return "dead";
  if (resolved.status === "failed" || resolved.status === "awaiting_acceptance") return "failed-open";
  return "active";
}

function resolveDependency(
  id: string,
  byId: ReadonlyMap<string, WorkItem>
): WorkItem | undefined {
  const visited = new Set<string>();
  let current = byId.get(id);
  while (current?.status === "retired" && current.disposition?.replacementWorkItemId !== undefined) {
    if (visited.has(current.id)) return undefined;
    visited.add(current.id);
    current = byId.get(current.disposition.replacementWorkItemId);
  }
  return current;
}

function projectCost(
  groups: readonly ExecutionGroup[],
  turns: readonly Turn[],
  events: readonly TaskEvent[],
  now: Date
): TaskCostProjection {
  const stageGroups = latestStageGroups(groups);
  let tokens = 0;
  let toolCalls = 0;
  let wallClockSeconds = 0;
  let tokensObservable = true;
  let toolCallsObservable = true;
  let laneCount = 0;
  let retryCount = 0;
  for (const group of stageGroups) {
    const lineage = groups.filter((candidate) => sameStage(candidate, group));
    const usage = observedExecutionResourceUsage({ group, stageGroups: lineage, turns, events });
    tokens += usage.tokens;
    toolCalls += usage.toolCalls;
    tokensObservable = tokensObservable && (usage.tokensObservable ?? true);
    toolCallsObservable = toolCallsObservable && (usage.toolCallsObservable ?? true);
    wallClockSeconds += stageDurationSeconds(lineage, now);
    laneCount += group.lanes.length;
    retryCount += Math.max(0, lineage.length - 1);
  }
  return Object.freeze({
    tokens,
    toolCalls,
    wallClockSeconds,
    tokensObservable,
    toolCallsObservable,
    laneCount,
    groupCount: stageGroups.length,
    retryCount,
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
    const ref = group.stage?.contextSnapshotRef;
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

function latestStageGroups(groups: readonly ExecutionGroup[]): ExecutionGroup[] {
  const latest = new Map<string, ExecutionGroup>();
  for (const group of groups) {
    const key = group.stage === undefined ? `group:${group.id}` : stageKey(group);
    const existing = latest.get(key);
    if (existing === undefined || compareStageGroup(existing, group) < 0) latest.set(key, group);
  }
  return [...latest.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function sameStage(left: ExecutionGroup, right: ExecutionGroup): boolean {
  if (left.stage === undefined || right.stage === undefined) return left.id === right.id;
  return left.taskId === right.taskId
    && executionTargetKey(left) === executionTargetKey(right)
    && left.stage.mode === right.stage.mode
    && left.stage.stage === right.stage.stage
    && left.stage.round === right.stage.round
    && isDeepStrictEqual(left.stage.budget, right.stage.budget)
    && isDeepStrictEqual(left.stage.resources, right.stage.resources);
}

function stageKey(group: ExecutionGroup): string {
  const stage = group.stage!;
  return `${executionTargetKey(group)}\0${stage.mode}\0${stage.stage}\0${stage.round}`;
}

function executionTargetKey(group: ExecutionGroup): string {
  const target = group.target;
  return `${target.kind}\0${target.workItemId ?? ""}\0${target.candidateId ?? ""}`;
}

function compareStageGroup(left: ExecutionGroup, right: ExecutionGroup): number {
  return (left.stage?.stageAttempt ?? 1) - (right.stage?.stageAttempt ?? 1)
    || left.updatedAt.localeCompare(right.updatedAt)
    || left.id.localeCompare(right.id);
}

function stageDurationSeconds(groups: readonly ExecutionGroup[], now: Date): number {
  const started = groups.map(({ createdAt }) => Date.parse(createdAt)).filter(Number.isFinite);
  const ended = groups.map((group) => Date.parse(group.updatedAt)).filter(Number.isFinite);
  if (started.length === 0) return 0;
  const hasOpenWork = groups.some((group) => group.lanes.some(({ status }) => (
    status === "pending" || status === "running"
  )));
  const end = hasOpenWork || ended.length === 0
    ? now.getTime()
    : Math.max(...ended);
  return Math.max(0, Math.floor((end - Math.min(...started)) / 1_000));
}

function isTerminalLane(status: ExecutionLaneStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}
