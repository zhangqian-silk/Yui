import { isDeepStrictEqual } from "node:util";

import { requireIdentity, requireTimestamp } from "../domain/validation.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { AgentRun } from "../run/agentRun.js";
import { runtimeObservationFromTaskEvent } from "../runtime/runtimeObservation.js";
import {
  validateExecutionGroup,
  type ExecutionGroup,
  type ExecutionLaneStatus
} from "./executionGroup.js";

export const RESOURCE_BROKER_POLICY_SCHEMA_VERSION = 1 as const;

/**
 * One conservative Home-wide admission policy. Limits are counted
 * independently at every scope; a Lane must fit all of them. The policy never
 * creates fan-out by itself, so single-Lane dispatch remains the default.
 */
export type ResourceBrokerPolicy = Readonly<{
  schemaVersion: typeof RESOURCE_BROKER_POLICY_SCHEMA_VERSION;
  maxActiveLanes: number;
  maxActiveLanesPerTask: number;
  maxActiveLanesPerWorkItem: number;
  maxActiveLanesPerGroup: number;
  maxActiveLanesPerProvider: number;
  maxActiveLanesPerAgent: number;
  maxActiveLanesPerModel: number;
  maxQueuedLanesPerGroup: number;
}>;

export type ResourceLaneIdentity = Readonly<{
  taskId: string;
  workItemId?: string;
  executionGroupId: string;
  executionLaneId: string;
  providerId: string;
  agentId: string;
  model?: string;
  requestedAt: string;
}>;

export type ResourceLimitScope =
  | "home"
  | "task"
  | "work-item"
  | "group"
  | "provider"
  | "agent"
  | "model"
  | "fair-queue"
  | "group-queue";

export type ResourceAdmission = Readonly<{
  request: ResourceLaneIdentity;
  decision: "admitted" | "queued" | "blocked";
  limitedBy: readonly ResourceLimitScope[];
  reason: string;
}>;

export type ExecutionResourceUsage = Readonly<{
  tokens: number;
  toolCalls: number;
  /** False means the Provider did not expose enough exact usage to enforce it. */
  tokensObservable?: boolean;
  /** False means the Agent Driver did not expose tool-operation identity. */
  toolCallsObservable?: boolean;
}>;

export type ExecutionStageResourceProjection = Readonly<{
  tokens: number;
  toolCalls: number;
  wallClockSeconds: number;
  tokensRemaining?: number;
  toolCallsRemaining?: number;
  wallClockSecondsRemaining?: number;
  tokensObservable: boolean;
  toolCallsObservable: boolean;
  usableLaneCount: number;
  activeLaneIds: readonly string[];
  pendingLaneIds: readonly string[];
  skippedLaneIds: readonly string[];
  quorumMet: boolean;
  quorumReachedAt?: string;
  deadlineReached: boolean;
  exhaustedBudgets: readonly ("tokens" | "tool-calls" | "wall-clock")[];
  stragglerLaneIds: readonly string[];
}>;

export type ExecutionRoutingDecision = Readonly<{
  action: "wait" | "expand-parallel" | "deepen-sequential" | "resolve" | "blocked";
  earlyTerminationAllowed: boolean;
  cancelPendingLaneIds: readonly string[];
  retainActiveLaneIds: readonly string[];
  reason: string;
}>;

const DEFAULT_ACTIVE_LANES = 4;
const DEFAULT_ACTIVE_LANES_PER_TASK = 2;
const DEFAULT_ACTIVE_LANES_PER_WORK_ITEM = 2;
const DEFAULT_ACTIVE_LANES_PER_GROUP = 2;
const DEFAULT_ACTIVE_LANES_PER_PROVIDER = 4;
const DEFAULT_ACTIVE_LANES_PER_AGENT = 2;
const DEFAULT_ACTIVE_LANES_PER_MODEL = 2;
const DEFAULT_QUEUED_LANES_PER_GROUP = 4;

export function resolveResourceBrokerPolicy(
  configured?: Partial<Omit<ResourceBrokerPolicy, "schemaVersion">> | null
): ResourceBrokerPolicy {
  const value = configured ?? {};
  return Object.freeze({
    schemaVersion: RESOURCE_BROKER_POLICY_SCHEMA_VERSION,
    maxActiveLanes: positive(value.maxActiveLanes, DEFAULT_ACTIVE_LANES, "maxActiveLanes"),
    maxActiveLanesPerTask: positive(
      value.maxActiveLanesPerTask,
      DEFAULT_ACTIVE_LANES_PER_TASK,
      "maxActiveLanesPerTask"
    ),
    maxActiveLanesPerWorkItem: positive(
      value.maxActiveLanesPerWorkItem,
      DEFAULT_ACTIVE_LANES_PER_WORK_ITEM,
      "maxActiveLanesPerWorkItem"
    ),
    maxActiveLanesPerGroup: positive(
      value.maxActiveLanesPerGroup,
      DEFAULT_ACTIVE_LANES_PER_GROUP,
      "maxActiveLanesPerGroup"
    ),
    maxActiveLanesPerProvider: positive(
      value.maxActiveLanesPerProvider,
      DEFAULT_ACTIVE_LANES_PER_PROVIDER,
      "maxActiveLanesPerProvider"
    ),
    maxActiveLanesPerAgent: positive(
      value.maxActiveLanesPerAgent,
      DEFAULT_ACTIVE_LANES_PER_AGENT,
      "maxActiveLanesPerAgent"
    ),
    maxActiveLanesPerModel: positive(
      value.maxActiveLanesPerModel,
      DEFAULT_ACTIVE_LANES_PER_MODEL,
      "maxActiveLanesPerModel"
    ),
    maxQueuedLanesPerGroup: positive(
      value.maxQueuedLanesPerGroup,
      DEFAULT_QUEUED_LANES_PER_GROUP,
      "maxQueuedLanesPerGroup"
    )
  });
}

/**
 * Deterministic admission over the caller's stable request order. Capacity
 * pressure queues a Lane; it never terminalizes that Lane or its siblings.
 */
export function planResourceAdmissions(input: Readonly<{
  policy: ResourceBrokerPolicy;
  active: readonly ResourceLaneIdentity[];
  queued: readonly ResourceLaneIdentity[];
  requests: readonly ResourceLaneIdentity[];
}>): ResourceAdmission[] {
  const policy = resolveResourceBrokerPolicy(input.policy);
  const active = input.active.map(validateLaneIdentity);
  const queued = input.queued.map(validateLaneIdentity);
  const decisions: ResourceAdmission[] = [];
  for (const raw of input.requests) {
    const request = validateLaneIdentity(raw);
    const directLimits = activeLimits(policy, active, request);
    const queuedBefore = [
      ...queued,
      ...decisions.filter(({ decision }) => decision === "queued").map(({ request }) => request)
    ];
    const fairReservations = directLimits.length === 0
      ? reservableOlderQueuedLanes(policy, active, queuedBefore, request)
      : [];
    const fairLimits = activeLimits(policy, [...active, ...fairReservations], request);
    const limitedBy = fairLimits.length === 0
      ? directLimits
      : directLimits.length === 0 && fairReservations.length > 0
        ? [...fairLimits, "fair-queue" as const]
        : fairLimits;
    if (limitedBy.length === 0) {
      active.push(request);
      decisions.push(Object.freeze({
        request,
        decision: "admitted",
        limitedBy: [],
        reason: "capacity is available at every resource scope"
      }));
      continue;
    }
    const groupQueued = [
      ...queued,
      ...decisions.filter(({ decision }) => decision === "queued").map(({ request }) => request)
    ].filter(({ taskId, executionGroupId }) => (
      taskId === request.taskId && executionGroupId === request.executionGroupId
    )).length;
    if (groupQueued >= policy.maxQueuedLanesPerGroup) {
      decisions.push(Object.freeze({
        request,
        decision: "blocked",
        limitedBy: [...limitedBy, "group-queue" as const],
        reason: `resource capacity is unavailable and the Group queue is full (${groupQueued}/${policy.maxQueuedLanesPerGroup})`
      }));
      continue;
    }
    decisions.push(Object.freeze({
      request,
      decision: "queued",
      limitedBy,
      reason: `resource backpressure: ${limitedBy.join(", ")}`
    }));
  }
  return decisions;
}

/**
 * Reserve only older queued Lanes that could start now. This gives released
 * capacity to the oldest compatible waiter without letting a Provider- or
 * Agent-blocked head prevent independent work from using other scopes.
 */
function reservableOlderQueuedLanes(
  policy: ResourceBrokerPolicy,
  active: readonly ResourceLaneIdentity[],
  queued: readonly ResourceLaneIdentity[],
  request: ResourceLaneIdentity
): ResourceLaneIdentity[] {
  const projected = [...active];
  const reserved: ResourceLaneIdentity[] = [];
  const seen = new Set<string>();
  for (const candidate of [...queued].sort(compareResourceQueueOrder)) {
    const key = resourceLaneKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    if (sameResourceLane(candidate, request)
      || compareResourceQueueOrder(candidate, request) >= 0
      || activeLimits(policy, projected, candidate).length > 0) continue;
    projected.push(candidate);
    reserved.push(candidate);
  }
  return reserved;
}

function compareResourceQueueOrder(
  left: ResourceLaneIdentity,
  right: ResourceLaneIdentity
): number {
  return left.requestedAt.localeCompare(right.requestedAt)
    || left.taskId.localeCompare(right.taskId, undefined, { numeric: true })
    || left.executionGroupId.localeCompare(right.executionGroupId, undefined, { numeric: true })
    || left.executionLaneId.localeCompare(right.executionLaneId, undefined, { numeric: true });
}

function sameResourceLane(left: ResourceLaneIdentity, right: ResourceLaneIdentity): boolean {
  return resourceLaneKey(left) === resourceLaneKey(right);
}

function resourceLaneKey(value: ResourceLaneIdentity): string {
  return `${value.taskId}\0${value.executionGroupId}\0${value.executionLaneId}`;
}

/** Current stage spend/completion projection used by CLI, Web, and routing. */
export function projectExecutionStageResources(input: Readonly<{
  group: ExecutionGroup;
  /** All WorkItem Groups; only this stage's retry lineage is counted. */
  stageGroups?: readonly ExecutionGroup[];
  usage: ExecutionResourceUsage;
  now: Date;
}>): ExecutionStageResourceProjection {
  const group = validateExecutionGroup(input.group);
  const stageGroups = executionStageRetryLineage(group, input.stageGroups);
  const stage = group.stage;
  const resources = stage?.resources;
  const tokens = nonNegative(input.usage.tokens, "Execution token usage");
  const toolCalls = nonNegative(input.usage.toolCalls, "Execution tool-call usage");
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Execution resource projection time is invalid.");
  const stageStartedAt = stageGroups
    .map(({ createdAt }) => createdAt)
    .sort()[0] ?? group.createdAt;
  const wallClockSeconds = Math.max(0, Math.floor((nowMs - Date.parse(stageStartedAt)) / 1_000));
  const usable = group.lanes.filter(({ status }) => isUsable(status))
    .sort((left, right) => (left.endedAt ?? left.updatedAt).localeCompare(right.endedAt ?? right.updatedAt));
  const activeLaneIds = group.lanes.filter(({ status }) => status === "running").map(({ id }) => id);
  const pendingLaneIds = group.lanes.filter(({ status }) => status === "pending").map(({ id }) => id);
  const skippedLaneIds = group.lanes.filter(({ status }) => status === "skipped").map(({ id }) => id);
  const quorum = resources?.quorum ?? group.lanes.length;
  const quorumMet = usable.length >= quorum;
  const quorumReachedAt = quorumMet
    ? (usable[quorum - 1]!.endedAt ?? usable[quorum - 1]!.updatedAt)
    : undefined;
  const tokensObservable = input.usage.tokensObservable ?? true;
  const toolCallsObservable = input.usage.toolCallsObservable ?? true;
  const exhaustedBudgets: ("tokens" | "tool-calls" | "wall-clock")[] = [];
  if (tokensObservable && stage?.budget.maxTokens !== undefined
    && tokens >= stage.budget.maxTokens) exhaustedBudgets.push("tokens");
  if (toolCallsObservable && stage?.budget.maxToolCalls !== undefined
    && toolCalls >= stage.budget.maxToolCalls) exhaustedBudgets.push("tool-calls");
  if (stage?.budget.maxWallClockSeconds !== undefined
    && wallClockSeconds >= stage.budget.maxWallClockSeconds) exhaustedBudgets.push("wall-clock");
  const deadlineReached = resources === undefined
    ? false
    : nowMs >= Date.parse(resources.deadlineAt);
  const stragglerLaneIds = resources === undefined || quorumReachedAt === undefined
    ? []
    : nowMs - Date.parse(quorumReachedAt) < resources.stragglerAfterSeconds * 1_000
      ? []
      : [...activeLaneIds];
  return Object.freeze({
    tokens,
    toolCalls,
    wallClockSeconds,
    ...(stage?.budget.maxTokens === undefined
      ? {}
      : { tokensRemaining: Math.max(0, stage.budget.maxTokens - tokens) }),
    ...(stage?.budget.maxToolCalls === undefined
      ? {}
      : { toolCallsRemaining: Math.max(0, stage.budget.maxToolCalls - toolCalls) }),
    ...(stage?.budget.maxWallClockSeconds === undefined
      ? {}
      : {
          wallClockSecondsRemaining: Math.max(
            0,
            stage.budget.maxWallClockSeconds - wallClockSeconds
          )
        }),
    tokensObservable,
    toolCallsObservable,
    usableLaneCount: usable.length,
    activeLaneIds,
    pendingLaneIds,
    skippedLaneIds,
    quorumMet,
    ...(quorumReachedAt === undefined ? {} : { quorumReachedAt }),
    deadlineReached,
    exhaustedBudgets,
    stragglerLaneIds
  });
}

/**
 * Parallel-vs-sequential decision support. Evidence sufficiency is an explicit
 * semantic input: budget pressure can block or defer work, but can never turn
 * insufficient evidence into a successful early stop.
 */
export function routeExecutionStage(input: Readonly<{
  group: ExecutionGroup;
  resources: ExecutionStageResourceProjection;
  evidenceSufficient: boolean;
  disagreement: "unknown" | "low" | "high";
  marginalValuePercent?: number;
}>): ExecutionRoutingDecision {
  const group = validateExecutionGroup(input.group);
  const stage = group.stage;
  const policy = stage?.resources;
  const marginal = input.marginalValuePercent === undefined
    ? undefined
    : percentage(input.marginalValuePercent, "Execution marginal value");
  const budgetPressure = input.resources.deadlineReached
    || input.resources.exhaustedBudgets.length > 0;
  const marginalLow = marginal !== undefined
    && policy !== undefined
    && marginal < policy.minimumMarginalValuePercent;
  const earlyTerminationAllowed = input.evidenceSufficient && input.resources.quorumMet;
  const stopSpending = earlyTerminationAllowed && (budgetPressure || marginalLow);
  const cancelPendingLaneIds = stopSpending ? input.resources.pendingLaneIds : [];
  const retainActiveLaneIds = stopSpending ? input.resources.activeLaneIds : [];
  if (earlyTerminationAllowed) {
    if (input.resources.activeLaneIds.length > 0) {
      return Object.freeze({
        action: "wait",
        earlyTerminationAllowed,
        cancelPendingLaneIds,
        retainActiveLaneIds,
        reason: stopSpending
          ? "quorum and sufficient evidence allow pending work to stop, but active stragglers are retained"
          : "evidence is sufficient, but active Lanes remain inside the stage policy"
      });
    }
    if (!stopSpending && input.resources.pendingLaneIds.length > 0) {
      return Object.freeze({
        action: "wait",
        earlyTerminationAllowed,
        cancelPendingLaneIds: [],
        retainActiveLaneIds: [],
        reason: "evidence is sufficient, but pending Lanes remain inside the configured marginal-value policy"
      });
    }
    return Object.freeze({
      action: "resolve",
      earlyTerminationAllowed,
      cancelPendingLaneIds,
      retainActiveLaneIds,
      reason: stopSpending
        ? "quorum and sufficient evidence make further pending spend uneconomic"
        : "quorum and sufficient evidence are complete"
    });
  }
  if (input.resources.activeLaneIds.length > 0) {
    return Object.freeze({
      action: "wait",
      earlyTerminationAllowed: false,
      cancelPendingLaneIds: [],
      retainActiveLaneIds: [],
      reason: budgetPressure
        ? "evidence is insufficient; active work is retained despite budget pressure"
        : "evidence is insufficient and active Lanes may still add evidence"
    });
  }
  if (budgetPressure) {
    return Object.freeze({
      action: "blocked",
      earlyTerminationAllowed: false,
      cancelPendingLaneIds: [],
      retainActiveLaneIds: [],
      reason: "the stage budget or deadline is exhausted before evidence sufficiency"
    });
  }
  if (input.resources.pendingLaneIds.length > 0) {
    return Object.freeze({
      action: "wait",
      earlyTerminationAllowed: false,
      cancelPendingLaneIds: [],
      retainActiveLaneIds: [],
      reason: "evidence is insufficient and scheduled Lanes are waiting for resource capacity"
    });
  }
  const capacity = group.strategy.mode === "fixed" ? group.strategy.count : group.strategy.max;
  if (group.strategy.mode === "adaptive"
    && input.disagreement === "high"
    && group.lanes.length < capacity) {
    return Object.freeze({
      action: "expand-parallel",
      earlyTerminationAllowed: false,
      cancelPendingLaneIds: [],
      retainActiveLaneIds: [],
      reason: "material disagreement and available Lane capacity favor another independent route"
    });
  }
  return Object.freeze({
    action: "deepen-sequential",
    earlyTerminationAllowed: false,
    cancelPendingLaneIds: [],
    retainActiveLaneIds: [],
    reason: "available evidence favors the next bounded stage over more parallel fan-out"
  });
}

/** Fold exact runtime observations into the spend dimensions Yui can prove. */
export function observedExecutionResourceUsage(input: Readonly<{
  group: ExecutionGroup;
  /** All WorkItem Groups; only this stage's retry lineage is counted. */
  stageGroups?: readonly ExecutionGroup[];
  /** Immutable Run history keeps failed Lane attempts inside the budget. */
  runs?: readonly Pick<
    AgentRun,
    "id" | "taskId" | "purpose" | "executionGroupId"
  >[];
  events: readonly TaskEvent[];
}>): ExecutionResourceUsage {
  const group = validateExecutionGroup(input.group);
  const stageGroups = executionStageRetryLineage(group, input.stageGroups);
  const groupIds = new Set(stageGroups.map(({ id }) => id));
  const runIds = new Set([
    ...stageGroups.flatMap((candidate) => candidate.lanes
      .flatMap(({ runId }) => runId === undefined ? [] : [runId])),
    ...(input.runs ?? []).filter((run) => (
      run.taskId === group.taskId
      && run.purpose === "execution"
      && run.executionGroupId !== undefined
      && groupIds.has(run.executionGroupId)
    )).map(({ id }) => id)
  ]);
  const observations = input.events.map(runtimeObservationFromTaskEvent)
    .filter((value): value is NonNullable<typeof value> => (
      value !== null
      && value.fence.taskId === group.taskId
      && value.fence.runId !== undefined
      && runIds.has(value.fence.runId)
    ));
  let tokens = 0;
  let tokensObservable = true;
  for (const runId of runIds) {
    const usage = observations.filter(({ fence, payload }) => (
      fence.runId === runId && payload.usage !== undefined
    )).sort((left, right) => (
      left.receivedAt.localeCompare(right.receivedAt)
      || (left.sequence ?? 0) - (right.sequence ?? 0)
      || (left.ordinal ?? 0) - (right.ordinal ?? 0)
    ));
    if (usage.length === 0) {
      tokensObservable = false;
      continue;
    }
    const requestSnapshots = new Map(usage
      .filter(({ payload }) => payload.usage!.semantics === "request-context")
      .map((observation) => [observation.semanticKey, observation.payload.usage!]));
    if (requestSnapshots.size > 0) {
      tokens += [...requestSnapshots.values()]
        .reduce((sum, value) => sum + value.inputTokens + value.outputTokens, 0);
      continue;
    }
    const cumulative = usage
      .filter(({ payload }) => payload.usage!.semantics === "cumulative-session")
      .map(({ payload }) => payload.usage!.inputTokens + payload.usage!.outputTokens);
    if (cumulative.length >= 2 && cumulative[0] === 0) {
      tokens += Math.max(...cumulative);
      continue;
    }
    if (cumulative.length >= 2) {
      tokens += Math.max(0, Math.max(...cumulative) - cumulative[0]!);
    }
    if (cumulative.length > 0 || usage.some(({ payload }) => (
      payload.usage!.semantics === "remaining-context"
    ))) tokensObservable = false;
  }
  const toolOperationIds = new Set(observations.flatMap((observation) => (
    observation.kind === "operation.started" && observation.payload.operation === "tool"
      ? [`${observation.fence.runId}\0${observation.payload.operationId ?? observation.semanticKey}`]
      : []
  )));
  const toolCallsObservable = observations.some(({ kind, payload }) => (
    kind === "operation.started" && payload.operation === "tool"
  ));
  return Object.freeze({
    tokens,
    toolCalls: toolOperationIds.size,
    tokensObservable,
    toolCallsObservable
  });
}

function activeLimits(
  policy: ResourceBrokerPolicy,
  active: readonly ResourceLaneIdentity[],
  request: ResourceLaneIdentity
): ResourceLimitScope[] {
  const checks: readonly [ResourceLimitScope, number, (value: ResourceLaneIdentity) => boolean][] = [
    ["home", policy.maxActiveLanes, () => true],
    ["task", policy.maxActiveLanesPerTask, (value) => value.taskId === request.taskId],
    ["work-item", policy.maxActiveLanesPerWorkItem, (value) => (
      request.workItemId !== undefined && value.taskId === request.taskId
        && value.workItemId === request.workItemId
    )],
    ["group", policy.maxActiveLanesPerGroup, (value) => (
      value.taskId === request.taskId && value.executionGroupId === request.executionGroupId
    )],
    ["provider", policy.maxActiveLanesPerProvider, (value) => value.providerId === request.providerId],
    ["agent", policy.maxActiveLanesPerAgent, (value) => value.agentId === request.agentId],
    ["model", policy.maxActiveLanesPerModel, (value) => modelKey(value) === modelKey(request)]
  ];
  return checks.filter(([, limit, matches]) => active.filter(matches).length >= limit)
    .map(([scope]) => scope);
}

function executionStageRetryLineage(
  group: ExecutionGroup,
  candidates: readonly ExecutionGroup[] | undefined
): ExecutionGroup[] {
  const stage = group.stage;
  if (stage === undefined || candidates === undefined) return [group];
  const lineage = candidates
    .map(validateExecutionGroup)
    .filter((candidate) => (
      candidate.taskId === group.taskId
      && candidate.purpose === "execution"
      && candidate.stage?.mode === stage.mode
      && candidate.stage.stage === stage.stage
      && candidate.stage.round === stage.round
      && candidate.stage.stageAttempt <= stage.stageAttempt
      && isDeepStrictEqual(candidate.stage.budget, stage.budget)
      && isDeepStrictEqual(candidate.stage.resources, stage.resources)
    ));
  if (!lineage.some(({ id }) => id === group.id)) lineage.push(group);
  return lineage;
}

function validateLaneIdentity(value: ResourceLaneIdentity): ResourceLaneIdentity {
  requireIdentity(value.taskId, "Resource Lane Task id");
  if (value.workItemId !== undefined) requireIdentity(value.workItemId, "Resource Lane WorkItem id");
  requireIdentity(value.executionGroupId, "Resource Lane ExecutionGroup id");
  requireIdentity(value.executionLaneId, "Resource Lane id");
  requireIdentity(value.providerId, "Resource Lane Provider id");
  requireIdentity(value.agentId, "Resource Lane Agent id");
  if (value.model !== undefined) requireIdentity(value.model, "Resource Lane model");
  requireTimestamp(value.requestedAt, "Resource Lane request time");
  return Object.freeze({ ...value });
}

function modelKey(value: ResourceLaneIdentity): string {
  return `${value.providerId}\0${value.model ?? "default"}`;
}

function positive(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return resolved;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

function percentage(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be an integer from 0 to 100.`);
  }
  return value;
}

function isUsable(status: ExecutionLaneStatus): boolean {
  return status === "yielded" || status === "completed";
}
