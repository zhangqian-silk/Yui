import type { TaskEvent } from "../event/taskEvent.js";
import type { Turn } from "../turn/turn.js";
import {
  isRoleTurnStalled,
  latestStallProgressAt
} from "../scheduler/roleTurnStall.js";
import {
  validateRuntimeProcessExitObservation,
  type RuntimeProcessExitObservation
} from "../runtime/processExitObservation.js";
import {
  runtimeObservationFromTaskEvent,
  type RuntimeObservation
} from "../runtime/runtimeObservation.js";
import {
  projectRuntimeTaskEvents,
  type RuntimeProjection
} from "../runtime/runtimeProjection.js";
import {
  DEFAULT_RUNTIME_HEALTH_POLICY,
  type RuntimeHealthPolicy
} from "../runtime/runtimeHealthPolicy.js";
import { runOwnsBlockingProviderContinuation } from "../runtime/runtimeContinuationProjection.js";
import type {
  ExecutionGroup,
  ExecutionLane
} from "./workItemExecution.js";

export type ExecutionLaneRuntimeHealth =
  | "active"
  | "silent"
  | "suspected-stalled"
  | "confirmed-dead";

export type ExecutionLaneRecovery =
  | "none"
  | "inspect"
  | "retry-new-turn"
  | "reuse-result";

export type ExecutionLaneProjectedStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "needs-attention"
  | "failed"
  | "unknown";

export type ExecutionLaneHealthProjection = Readonly<{
  laneId: string;
  runtimeHealth?: ExecutionLaneRuntimeHealth;
  recovery: ExecutionLaneRecovery;
  resultReusable: boolean;
  reason: string;
  evidence: readonly string[];
}>;

export type ExecutionGroupHealthProjection = Readonly<{
  groupId: string;
  lanes: readonly ExecutionLaneHealthProjection[];
  activeLaneCount: number;
  silentLaneCount: number;
  suspectedStalledLaneCount: number;
  confirmedDeadLaneCount: number;
  reusableLaneIds: readonly string[];
  retryableLaneIds: readonly string[];
}>;

export type ExecutionGroupHealthSummary = Readonly<{
  groupId: string;
  purpose: "execution" | "review";
  kind: "replicated";
  laneCount: number;
  activeLaneCount: number;
  terminalLaneCount: number;
  succeededLaneCount: number;
  failedLaneCount: number;
  laneSummaries: readonly Readonly<{
    laneId: string;
    roleName: string;
    ordinal: number;
    turnId?: string;
    successfulTurnId?: string;
    status: ExecutionLaneProjectedStatus;
    effective?: ExecutionLane["effective"];
  } & ExecutionLaneHealthProjection>[];
  health: Omit<ExecutionGroupHealthProjection, "groupId" | "lanes">;
}>;

export type ActionableExecutionLaneRecovery = Readonly<{
  groupId: string;
  laneId: string;
  turnId?: string;
  runtimeHealth?: ExecutionLaneRuntimeHealth;
  recovery: "retry-new-turn";
}>;

export type ExecutionHealthTurn = Pick<
  Turn,
  | "id"
  | "taskId"
  | "roleName"
  | "purpose"
  | "status"
  | "createdAt"
  | "updatedAt"
  | "workItemId"
  | "reviewRoundId"
  | "executionGroupId"
  | "executionLaneId"
> & Readonly<{
  effective: Readonly<{ agentId: string; adapterId: string }>;
}>;

export type ExecutionHealthSession = Readonly<{
  roleName: string;
  agentId: string;
  adapterId: string;
  status?: string;
  nativeSessionId?: string;
  launchId?: string;
}>;

export type ExecutionGroupHealthInput = Readonly<{
  group: ExecutionGroup;
  turns: readonly ExecutionHealthTurn[];
  sessions: readonly ExecutionHealthSession[];
  events: readonly TaskEvent[];
  now: Date;
  policy?: RuntimeHealthPolicy;
}>;

export function projectExecutionGroupHealth(
  input: ExecutionGroupHealthInput
): ExecutionGroupHealthProjection {
  const policy = input.policy ?? DEFAULT_RUNTIME_HEALTH_POLICY;
  const lanes = input.group.lanes.map((lane) => projectExecutionLaneHealth(
    lane,
    input,
    policy
  ));
  return Object.freeze({
    groupId: input.group.id,
    lanes,
    activeLaneCount: countHealth(lanes, "active"),
    silentLaneCount: countHealth(lanes, "silent"),
    suspectedStalledLaneCount: countHealth(lanes, "suspected-stalled"),
    confirmedDeadLaneCount: countHealth(lanes, "confirmed-dead"),
    reusableLaneIds: lanes.filter(({ resultReusable }) => resultReusable).map(({ laneId }) => laneId),
    retryableLaneIds: lanes.filter(({ recovery }) => recovery === "retry-new-turn").map(({ laneId }) => laneId)
  });
}

export function summarizeExecutionGroupHealth(
  input: ExecutionGroupHealthInput
): ExecutionGroupHealthSummary {
  const health = projectExecutionGroupHealth(input);
  const healthByLane = new Map(health.lanes.map((lane) => [lane.laneId, lane]));
  const laneSummaries = input.group.lanes.map((lane) => {
    const projected = healthByLane.get(lane.id)!;
    const turn = exactLaneTurn(input, lane);
    return Object.freeze({
      roleName: lane.roleName,
      ordinal: lane.ordinal,
      ...(lane.currentTurnId === undefined ? {} : { turnId: lane.currentTurnId }),
      ...(lane.successfulTurnId === undefined
        ? {}
        : { successfulTurnId: lane.successfulTurnId }),
      status: projectedStatus(lane, turn),
      ...(lane.effective === undefined ? {} : { effective: lane.effective }),
      ...projected
    });
  });
  return Object.freeze({
    groupId: input.group.id,
    purpose: "reviewRoundId" in input.group.assignment ? "review" : "execution",
    kind: "replicated",
    laneCount: input.group.lanes.length,
    activeLaneCount: laneSummaries.filter(({ status }) => status === "running").length,
    terminalLaneCount: input.group.lanes.filter(({ disposition }) => disposition !== "open").length,
    succeededLaneCount: input.group.lanes.filter(({ disposition }) => disposition === "succeeded").length,
    failedLaneCount: input.group.lanes.filter(({ disposition }) => disposition === "failed").length,
    laneSummaries,
    health: Object.freeze({
      activeLaneCount: health.activeLaneCount,
      silentLaneCount: health.silentLaneCount,
      suspectedStalledLaneCount: health.suspectedStalledLaneCount,
      confirmedDeadLaneCount: health.confirmedDeadLaneCount,
      reusableLaneIds: health.reusableLaneIds,
      retryableLaneIds: health.retryableLaneIds
    })
  });
}

export function actionableExecutionLaneRecoveries(
  groups: readonly ExecutionGroupHealthSummary[]
): ActionableExecutionLaneRecovery[] {
  return groups.flatMap((group) => group.laneSummaries.flatMap(
    (lane): ActionableExecutionLaneRecovery[] => lane.recovery !== "retry-new-turn"
      ? []
      : [{
          groupId: group.groupId,
          laneId: lane.laneId,
          ...(lane.turnId === undefined ? {} : { turnId: lane.turnId }),
          ...(lane.runtimeHealth === undefined ? {} : { runtimeHealth: lane.runtimeHealth }),
          recovery: "retry-new-turn"
        }]
  ));
}

function projectExecutionLaneHealth(
  lane: ExecutionLane,
  input: ExecutionGroupHealthInput,
  policy: RuntimeHealthPolicy
): ExecutionLaneHealthProjection {
  const turn = exactLaneTurn(input, lane);
  const continuationAgentId = turn?.effective.agentId ?? lane.effective?.agentId;
  if (lane.disposition === "open"
    && lane.currentTurnId !== undefined
    && continuationAgentId !== undefined
    && runOwnsBlockingProviderContinuation(input.events, {
      taskId: input.group.taskId,
      roleName: lane.roleName,
      turnId: lane.currentTurnId,
      agentId: continuationAgentId
    })) {
    return projection(lane, {
      runtimeHealth: "active",
      recovery: "none",
      resultReusable: false,
      reason: "the exact Turn still owns an unsettled Provider continuation writer",
      evidence: ["runtime-continuation-writer-owned"]
    });
  }
  if (lane.disposition === "succeeded") {
    return projection(lane, {
      recovery: "reuse-result",
      resultReusable: true,
      reason: "the successful Producer result is durable and immutable",
      evidence: ["execution-lane-success"]
    });
  }
  if (lane.disposition === "failed") {
    return projection(lane, {
      runtimeHealth: "confirmed-dead",
      recovery: "none",
      resultReusable: false,
      reason: "the logical Producer Lane was explicitly settled as failed",
      evidence: ["execution-lane-settled-failure"]
    });
  }
  if (lane.currentTurnId === undefined) {
    return projection(lane, {
      recovery: "none",
      resultReusable: false,
      reason: "the Producer Lane has not been dispatched",
      evidence: []
    });
  }
  if (turn === undefined) {
    return projection(lane, {
      runtimeHealth: "suspected-stalled",
      recovery: "inspect",
      resultReusable: false,
      reason: "the open Lane has no exact current Turn",
      evidence: ["execution-lineage-missing"]
    });
  }
  if (turn.status === "failed") {
    return projection(lane, {
      runtimeHealth: "confirmed-dead",
      recovery: "retry-new-turn",
      resultReusable: false,
      reason: "the exact current Turn is durably failed",
      evidence: ["turn-terminal-failure"]
    });
  }
  if (turn.status === "completed") {
    return projection(lane, {
      runtimeHealth: "suspected-stalled",
      recovery: "inspect",
      resultReusable: false,
      reason: "the current Turn completed without settling its logical Lane",
      evidence: ["execution-lineage-inconsistent"]
    });
  }
  const session = input.sessions.find((candidate) => (
    candidate.roleName === turn.roleName
    && candidate.agentId === turn.effective.agentId
    && candidate.adapterId === turn.effective.adapterId
  ));
  const observations = exactTurnObservations(input.events, turn, session);
  const runtime = runtimeProjection(observations, input.events, turn);
  const unsettledContinuation = runtime !== null
    && Object.values(runtime.continuations).some((continuation) => (
      continuation.execution === "active"
      || continuation.execution === "unknown"
      || continuation.identityConflict
    ));
  const unsettledChildWork = runtime !== null
    && (Object.values(runtime.operations).some(({ kind }) => kind === "subagent")
      || unsettledContinuation);
  if (observations.some((observation) => (
    observation.kind === "turn.failed"
    && observation.payload.failure?.turnTerminal === true
  )) && !unsettledChildWork) {
    return projection(lane, {
      runtimeHealth: "confirmed-dead",
      recovery: "inspect",
      resultReusable: false,
      reason: "the Provider reported an exact Turn-terminal failure",
      evidence: ["provider-turn-terminal"]
    });
  }

  const runtimeTerminalEvidence = runtime === null
    ? []
    : [
        ...(runtime.host === "exited" ? ["runtime-host-exited"] : []),
        ...(runtime.session === "ended" || runtime.session === "failed"
          ? [`runtime-session-${runtime.session}`]
          : [])
      ];
  if (runtimeTerminalEvidence.length > 0 && !unsettledChildWork) {
    return projection(lane, {
      runtimeHealth: "confirmed-dead",
      recovery: "inspect",
      resultReusable: false,
      reason: "the exact runtime host or Session is terminal and no unsettled child work remains",
      evidence: runtimeTerminalEvidence
    });
  }

  const exit = latestExactProcessExit(input.events, turn, session);
  if (session?.status === "ended"
    && exit !== null
    && isAbnormalExit(exit.classification)
    && !unsettledChildWork) {
    return projection(lane, {
      runtimeHealth: "confirmed-dead",
      recovery: "inspect",
      resultReusable: false,
      reason: "the exact Session and abnormal process exit independently confirm death",
      evidence: ["native-session-terminal", `process-exit:${exit.classification}`]
    });
  }

  if (isRoleTurnStalled(input.events, turn.id)) {
    return projection(lane, {
      runtimeHealth: "suspected-stalled",
      recovery: "inspect",
      resultReusable: false,
      reason: `the durable progress clock has not advanced since ${
        latestStallProgressAt(input.events, turn.id) ?? turn.updatedAt
      }; no death proof exists`,
      evidence: ["turn-stalled"]
    });
  }

  const activeOperation = runtime !== null
    && (Object.keys(runtime.operations).length > 0 || unsettledContinuation);
  const lastActivityAt = runtime?.lastRuntimeActivityAt
    ?? turn.updatedAt
    ?? turn.createdAt;
  const recentActivity = input.now.getTime() - Date.parse(lastActivityAt) < policy.quietAfterMs;
  if (activeOperation || recentActivity) {
    return projection(lane, {
      runtimeHealth: "active",
      recovery: "none",
      resultReusable: false,
      reason: unsettledContinuation
        ? "the exact runtime reports unsettled continuation work"
        : activeOperation
          ? "the exact runtime reports an active operation"
          : "the exact Turn has recent structured runtime activity",
      evidence: unsettledContinuation
        ? ["runtime-continuation-unsettled"]
        : activeOperation
          ? ["runtime-operation-active"]
          : ["runtime-activity-recent"]
    });
  }
  return projection(lane, {
    runtimeHealth: "silent",
    recovery: "none",
    resultReusable: false,
    reason: "the exact Turn remains active without recent structured activity; silence alone is not death",
    evidence: ["turn-active"]
  });
}

function exactLaneTurn(
  input: ExecutionGroupHealthInput,
  lane: ExecutionLane
): ExecutionHealthTurn | undefined {
  return lane.currentTurnId === undefined
    ? undefined
    : input.turns.find((turn) => (
        turn.taskId === input.group.taskId
        && turn.id === lane.currentTurnId
        && turn.executionGroupId === input.group.id
        && turn.executionLaneId === lane.id
        && turn.roleName === lane.roleName
      ));
}

function exactTurnObservations(
  events: readonly TaskEvent[],
  turn: ExecutionHealthTurn,
  session: ExecutionHealthSession | undefined
): RuntimeObservation[] {
  return events.map(runtimeObservationFromTaskEvent)
    .filter((observation): observation is RuntimeObservation => (
      observation !== null
      && observation.fence.taskId === turn.taskId
      && observation.fence.turnId === turn.id
      && observation.fence.roleName === turn.roleName
      && observation.fence.agentId === turn.effective.agentId
      && (session?.launchId === undefined || observation.fence.launchId === session.launchId)
      && (session?.nativeSessionId === undefined
        || observation.fence.nativeSessionId === session.nativeSessionId)
    ));
}

function runtimeProjection(
  observations: readonly RuntimeObservation[],
  events: readonly TaskEvent[],
  turn: ExecutionHealthTurn
): RuntimeProjection | null {
  const first = observations[0];
  return first === undefined
    ? null
    : projectRuntimeTaskEvents(first.fence, turn.createdAt, events);
}

type ExactProcessExit = Readonly<{
  observation: RuntimeProcessExitObservation;
  classification: string;
}>;

function latestExactProcessExit(
  events: readonly TaskEvent[],
  turn: ExecutionHealthTurn,
  session: ExecutionHealthSession | undefined
): ExactProcessExit | null {
  const matching = events.flatMap((event): ExactProcessExit[] => {
    if (event.type !== "runtime.process-exit-observed") return [];
    try {
      const observation = validateRuntimeProcessExitObservation(
        JSON.parse(event.payload.observation ?? "") as RuntimeProcessExitObservation
      );
      if (observation.taskId !== turn.taskId
        || observation.turnId !== turn.id
        || observation.roleName !== turn.roleName
        || (session?.launchId !== undefined && observation.launchId !== session.launchId)
        || (session?.nativeSessionId !== undefined
          && observation.nativeSessionId !== session.nativeSessionId)) return [];
      return [{
        observation,
        classification: event.payload.classification ?? "unknown"
      }];
    } catch {
      return [];
    }
  });
  return matching.sort((left, right) => (
    Date.parse(right.observation.observedAt) - Date.parse(left.observation.observedAt)
  ))[0] ?? null;
}

function isAbnormalExit(classification: string): boolean {
  return classification === "host-abnormal" || classification === "provider-turn-failed";
}

function projectedStatus(
  lane: ExecutionLane,
  turn: ExecutionHealthTurn | undefined
): ExecutionLaneProjectedStatus {
  if (lane.disposition === "succeeded") return "succeeded";
  if (lane.disposition === "failed") return "failed";
  if (lane.currentTurnId === undefined) return "pending";
  if (turn === undefined) return "unknown";
  if (turn.status === "active") return "running";
  if (turn.status === "failed") return "needs-attention";
  return "unknown";
}

function projection(
  lane: ExecutionLane,
  fields: Omit<ExecutionLaneHealthProjection, "laneId">
): ExecutionLaneHealthProjection {
  return Object.freeze({ laneId: lane.id, ...fields });
}

function countHealth(
  lanes: readonly ExecutionLaneHealthProjection[],
  health: ExecutionLaneRuntimeHealth
): number {
  return lanes.filter(({ runtimeHealth }) => runtimeHealth === health).length;
}
