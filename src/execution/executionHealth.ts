import type { TaskEvent } from "../event/taskEvent.js";
import type { AgentRun } from "../run/agentRun.js";
import {
  isRoleRunStalled,
  latestStallProgressAt
} from "../scheduler/roleRunStall.js";
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
import {
  summarizeExecutionGroup,
  type ExecutionGroup,
  type ExecutionGroupSummary,
  type ExecutionLane
} from "./executionGroup.js";

export type ExecutionLaneRuntimeHealth =
  | "active"
  | "silent"
  | "suspected-stalled"
  | "confirmed-dead";

export type ExecutionLaneRecovery =
  | "none"
  | "diagnose"
  | "terminate-exact-run"
  | "retry-new-agent-run"
  | "reuse-result";

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

type LaneSummary = ExecutionGroupSummary["laneSummaries"][number];

export type ExecutionGroupHealthSummary = Readonly<
  Omit<ExecutionGroupSummary, "laneSummaries"> & {
    laneSummaries: readonly Readonly<LaneSummary & ExecutionLaneHealthProjection>[];
    health: Omit<ExecutionGroupHealthProjection, "groupId" | "lanes">;
  }
>;

export type ActionableExecutionLaneRecovery = Readonly<{
  groupId: string;
  laneId: string;
  runId?: string;
  runtimeHealth?: ExecutionLaneRuntimeHealth;
  recovery: "diagnose" | "terminate-exact-run" | "retry-new-agent-run";
}>;

export type ExecutionHealthRun = Pick<
  AgentRun,
  | "id"
  | "taskId"
  | "roleName"
  | "purpose"
  | "status"
  | "createdAt"
  | "updatedAt"
  | "pushedAt"
  | "deliveredAt"
  | "workItemId"
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
  runs: readonly ExecutionHealthRun[];
  sessions: readonly ExecutionHealthSession[];
  events: readonly TaskEvent[];
  now: Date;
  policy?: RuntimeHealthPolicy;
}>;

/**
 * Fold existing Run, runtime, Session, process-exit, and stall facts into the
 * four Lane health states. This is a read model only: it never advances a
 * Lane, terminalizes a Run, or guesses that silence means death.
 */
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
    reusableLaneIds: lanes.filter(({ resultReusable }) => resultReusable)
      .map(({ laneId }) => laneId),
    retryableLaneIds: lanes.filter(({ recovery }) => recovery === "retry-new-agent-run")
      .map(({ laneId }) => laneId)
  });
}

/** Structural Group summary plus the health/recovery projection used by CLI/Web reads. */
export function summarizeExecutionGroupHealth(
  input: ExecutionGroupHealthInput
): ExecutionGroupHealthSummary {
  const summary = summarizeExecutionGroup(input.group);
  const projection = projectExecutionGroupHealth(input);
  const healthByLane = new Map(projection.lanes.map((lane) => [lane.laneId, lane]));
  return Object.freeze({
    ...summary,
    laneSummaries: summary.laneSummaries.map((lane) => Object.freeze({
      ...lane,
      ...healthByLane.get(lane.laneId)!
    })),
    health: Object.freeze({
      activeLaneCount: projection.activeLaneCount,
      silentLaneCount: projection.silentLaneCount,
      suspectedStalledLaneCount: projection.suspectedStalledLaneCount,
      confirmedDeadLaneCount: projection.confirmedDeadLaneCount,
      reusableLaneIds: projection.reusableLaneIds,
      retryableLaneIds: projection.retryableLaneIds
    })
  });
}

/** Unresolved Lane recovery in deterministic operational priority order. */
export function actionableExecutionLaneRecoveries(
  groups: readonly ExecutionGroupHealthSummary[]
): ActionableExecutionLaneRecovery[] {
  const priority = {
    "terminate-exact-run": 0,
    "retry-new-agent-run": 1,
    diagnose: 2
  } as const;
  return groups
    .filter(({ resolution }) => resolution === undefined)
    .flatMap((group) => group.laneSummaries.flatMap((lane): ActionableExecutionLaneRecovery[] => {
      if (lane.recovery !== "diagnose"
        && lane.recovery !== "terminate-exact-run"
        && lane.recovery !== "retry-new-agent-run") return [];
      return [{
        groupId: group.groupId,
        laneId: lane.laneId,
        ...(lane.runId === undefined ? {} : { runId: lane.runId }),
        ...(lane.runtimeHealth === undefined ? {} : { runtimeHealth: lane.runtimeHealth }),
        recovery: lane.recovery
      }];
    }))
    .sort((left, right) => priority[left.recovery] - priority[right.recovery]);
}

function projectExecutionLaneHealth(
  lane: ExecutionLane,
  input: ExecutionGroupHealthInput,
  policy: RuntimeHealthPolicy
): ExecutionLaneHealthProjection {
  const run = lane.runId === undefined
    ? undefined
    : input.runs.find((candidate) => exactLaneRun(candidate, input.group, lane));
  const continuationAgentId = run?.effective.agentId ?? lane.effective?.agentId;
  if (lane.status !== "completed"
    && lane.status !== "yielded"
    && lane.runId !== undefined
    && continuationAgentId !== undefined
    && runOwnsBlockingProviderContinuation(input.events, {
      taskId: input.group.taskId,
      roleName: lane.roleName,
      runId: lane.runId,
      agentId: continuationAgentId
    })) {
    return projection(lane, {
      runtimeHealth: "active",
      recovery: "none",
      resultReusable: false,
      reason: "the exact Run still owns an unsettled Provider continuation writer",
      evidence: ["runtime-continuation-writer-owned"]
    });
  }
  if (lane.status === "completed" || lane.status === "yielded") {
    return projection(lane, {
      recovery: "reuse-result",
      resultReusable: true,
      reason: "the terminal Lane result is durable and must be reused",
      evidence: ["execution-lane-result"]
    });
  }
  if (lane.status === "failed") {
    return projection(lane, {
      runtimeHealth: "confirmed-dead",
      recovery: "retry-new-agent-run",
      resultReusable: false,
      reason: "the exact Lane attempt is durably failed; a retry must create a new AgentRun",
      evidence: ["execution-lane-terminal-failure"]
    });
  }
  if (lane.status === "pending") {
    return projection(lane, {
      recovery: "none",
      resultReusable: false,
      reason: "the Lane has not started",
      evidence: []
    });
  }

  if (run === undefined) {
    return projection(lane, {
      runtimeHealth: "suspected-stalled",
      recovery: "diagnose",
      resultReusable: false,
      reason: "the running Lane has no exact AgentRun record",
      evidence: ["execution-lineage-missing"]
    });
  }
  if (run.status === "failed") {
    return projection(lane, {
      runtimeHealth: "confirmed-dead",
      recovery: "retry-new-agent-run",
      resultReusable: false,
      reason: "the exact AgentRun is durably failed",
      evidence: ["agent-run-terminal-failure"]
    });
  }
  if (run.status !== "active") {
    return projection(lane, {
      runtimeHealth: "suspected-stalled",
      recovery: "diagnose",
      resultReusable: false,
      reason: "the Lane is running but its exact AgentRun is terminal without a Lane result",
      evidence: ["execution-lineage-inconsistent"]
    });
  }

  const session = input.sessions.find((candidate) => (
    candidate.roleName === run.roleName
    && candidate.agentId === run.effective.agentId
    && candidate.adapterId === run.effective.adapterId
  ));
  const observations = exactRunObservations(input.events, run, session);
  const runtime = runtimeProjection(observations, input.events, run);
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
    && observation.payload.failure?.runTerminal === true
  )) && !unsettledChildWork) {
    return projection(lane, {
      runtimeHealth: "confirmed-dead",
      recovery: "terminate-exact-run",
      resultReusable: false,
      reason: "the Provider reported an exact run-terminal failure",
      evidence: ["provider-run-terminal"]
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
      recovery: "terminate-exact-run",
      resultReusable: false,
      reason: "the exact runtime host or Session is terminal and no unsettled child work remains",
      evidence: runtimeTerminalEvidence
    });
  }

  const exit = latestExactProcessExit(input.events, run, session);
  const sessionDead = session?.status === "stopped" || session?.status === "broken";
  if (sessionDead
    && exit !== null
    && isAbnormalExit(exit.classification)
    && !unsettledChildWork) {
    return projection(lane, {
      runtimeHealth: "confirmed-dead",
      recovery: "terminate-exact-run",
      resultReusable: false,
      reason: "the exact Session and abnormal process exit independently confirm death",
      evidence: ["native-session-terminal", `process-exit:${exit.classification}`]
    });
  }

  if (isRoleRunStalled(input.events, run.id)) {
    return projection(lane, {
      runtimeHealth: "suspected-stalled",
      recovery: "diagnose",
      resultReusable: false,
      reason: `the durable progress clock has not advanced since ${
        latestStallProgressAt(input.events, run.id) ?? run.updatedAt
      }; no death proof exists`,
      evidence: ["run-stalled"]
    });
  }

  const activeOperation = runtime !== null
    && (Object.keys(runtime.operations).length > 0 || unsettledContinuation);
  const lastActivityAt = runtime?.lastRuntimeActivityAt
    ?? run.deliveredAt
    ?? run.pushedAt
    ?? run.createdAt;
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
        : "the exact Run has recent structured runtime activity",
      evidence: unsettledContinuation
        ? ["runtime-continuation-unsettled"]
        : activeOperation ? ["runtime-operation-active"] : ["runtime-activity-recent"]
    });
  }
  return projection(lane, {
    runtimeHealth: "silent",
    recovery: "none",
    resultReusable: false,
    reason: "the exact Run remains active without recent structured activity; silence alone is not death",
    evidence: ["agent-run-active"]
  });
}

function projection(
  lane: ExecutionLane,
  value: Omit<ExecutionLaneHealthProjection, "laneId">
): ExecutionLaneHealthProjection {
  return Object.freeze({ laneId: lane.id, ...value });
}

function exactLaneRun(
  run: ExecutionHealthRun,
  group: ExecutionGroup,
  lane: ExecutionLane
): boolean {
  return run.id === lane.runId
    && run.taskId === group.taskId
    && run.roleName === lane.roleName
    && run.executionGroupId === group.id
    && run.executionLaneId === lane.id;
}

function exactRunObservations(
  events: readonly TaskEvent[],
  run: ExecutionHealthRun,
  session: ExecutionHealthSession | undefined
): RuntimeObservation[] {
  return events.map(runtimeObservationFromTaskEvent)
    .filter((observation): observation is RuntimeObservation => (
      observation !== null
      && observation.fence.taskId === run.taskId
      && observation.fence.runId === run.id
      && observation.fence.roleName === run.roleName
      && observation.fence.agentId === run.effective.agentId
      && (session?.launchId === undefined || observation.fence.launchId === session.launchId)
      && (session?.nativeSessionId === undefined
        || observation.fence.nativeSessionId === session.nativeSessionId)
    ));
}

function runtimeProjection(
  observations: readonly RuntimeObservation[],
  events: readonly TaskEvent[],
  run: ExecutionHealthRun
): RuntimeProjection | null {
  const first = observations[0];
  return first === undefined
    ? null
    : projectRuntimeTaskEvents(first.fence, run.createdAt, events);
}

type ExactProcessExit = Readonly<{
  observation: RuntimeProcessExitObservation;
  classification: string;
}>;

function latestExactProcessExit(
  events: readonly TaskEvent[],
  run: ExecutionHealthRun,
  session: ExecutionHealthSession | undefined
): ExactProcessExit | null {
  const matching = events.flatMap((event): ExactProcessExit[] => {
    if (event.type !== "runtime.process-exit-observed") return [];
    try {
      const observation = validateRuntimeProcessExitObservation(
        JSON.parse(event.payload.observation ?? "") as RuntimeProcessExitObservation
      );
      if (observation.taskId !== run.taskId
        || observation.runId !== run.id
        || observation.roleName !== run.roleName
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

function countHealth(
  lanes: readonly ExecutionLaneHealthProjection[],
  health: ExecutionLaneRuntimeHealth
): number {
  return lanes.filter(({ runtimeHealth }) => runtimeHealth === health).length;
}
