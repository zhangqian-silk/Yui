import type { TaskRoleSessionSet } from "../executor/agentExecutor.js";
import type { Turn } from "../turn/turn.js";
import {
  governingWorkItemCandidate,
  currentWorkItemExecutionGroup,
  type WorkItem,
  type WorkItemCandidate
} from "../workItem/workItem.js";
import type {
  WorkItemExecutionGroup,
  WorkItemExecutionLane
} from "./workItemExecution.js";
import { MINIMUM_WORK_ITEM_SYNTHESIS_RESULTS } from "./workItemExecution.js";

export type WorkItemLaneProjectedStatus =
  | "running"
  | "succeeded"
  | "needs-attention"
  | "failed"
  | "unknown";

export type WorkItemTurnProjectedStatus =
  | "not-started"
  | "running"
  | "succeeded"
  | "needs-attention"
  | "unknown";

export type WorkItemSynthesisStatus =
  | "not-applicable"
  | "blocked-by-open-lanes"
  | "eligible"
  | "insufficient-results"
  | "main-running"
  | "main-needs-attention"
  | "complete"
  | "unknown";

export type WorkItemExecutionProjection = Readonly<{
  schemaVersion: 1;
  shape: "direct" | "replicated";
  groupId?: string;
  lanes: readonly WorkItemLaneProjection[];
  laneCounts: Readonly<{
    running: number;
    succeeded: number;
    needsAttention: number;
    failed: number;
    unknown: number;
  }>;
  synthesis: Readonly<{
    status: WorkItemSynthesisStatus;
    successfulLaneCount: number;
    requiredSuccessfulLaneCount: number;
  }>;
  mainTurn: WorkItemMainTurnProjection;
  candidate: WorkItemCandidateSourceProjection;
  nextAction: WorkItemExecutionNextAction;
}>;

export type WorkItemLaneProjection = Readonly<{
  laneId: string;
  ordinal: number;
  roleName: string;
  status: WorkItemLaneProjectedStatus;
  currentTurnId?: string;
  successfulTurnId?: string;
  session: "active" | "ended" | "unobserved";
  retryTurnId?: string;
  settleTurnId?: string;
  observation: "observed" | "unobserved";
}>;

export type WorkItemMainTurnProjection = Readonly<{
  status: WorkItemTurnProjectedStatus;
  roleName?: string;
  turnId?: string;
  sourceExecutionGroupId?: string;
  session: "active" | "ended" | "unobserved";
  retryTurnId?: string;
  observation: "observed" | "unobserved";
}>;

export type WorkItemCandidateSourceProjection = Readonly<{
  status: "none" | "observed" | "unknown";
  candidateId?: string;
  sourceType?: "direct" | "turn";
  mainTurnId?: string;
  sourceExecutionGroupId?: string;
  successfulLaneTurns: readonly Readonly<{
    laneId: string;
    successfulTurnId: string;
  }>[];
  observation: "observed" | "unobserved";
}>;

export type WorkItemExecutionNextAction = Readonly<{
  kind:
    | "dispatch-work"
    | "wait-for-lanes"
    | "retry-or-settle-lanes"
    | "inspect-unknown"
    | "await-main-dispatch"
    | "wait-for-main"
    | "retry-main"
    | "redispatch-work"
    | "submit-candidate"
    | "decide-candidate"
    | "none";
  owners: readonly string[];
  targetIds: readonly string[];
}>;

export function projectWorkItemExecution(
  item: WorkItem,
  turns: readonly Turn[],
  sessionSets: readonly TaskRoleSessionSet[] = []
): WorkItemExecutionProjection {
  const group = currentWorkItemExecutionGroup(item);
  const relevantTurns = turns.filter((turn) => turn.workItemId === item.id);
  const sessionsByRole = new Map(sessionSets.map((set) => [set.owner.roleName, set]));
  const lanes = group === undefined
    ? []
    : [...group.lanes]
      .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
      .map((lane) => projectLane(item, group, lane, relevantTurns, sessionsByRole));
  const laneCounts = Object.freeze({
    running: lanes.filter(({ status }) => status === "running").length,
    succeeded: lanes.filter(({ status }) => status === "succeeded").length,
    needsAttention: lanes.filter(({ status }) => status === "needs-attention").length,
    failed: lanes.filter(({ status }) => status === "failed").length,
    unknown: lanes.filter(({ status }) => status === "unknown").length
  });
  const mainTurn = projectMainTurn(item, group, relevantTurns, sessionsByRole);
  const synthesis = projectSynthesis(group, lanes, mainTurn);
  const candidate = projectCandidate(item, group, relevantTurns, lanes, mainTurn);
  return Object.freeze({
    schemaVersion: 1,
    shape: group === undefined ? "direct" : "replicated",
    ...(group === undefined ? {} : { groupId: group.id }),
    lanes: Object.freeze(lanes),
    laneCounts,
    synthesis,
    mainTurn,
    candidate,
    nextAction: projectNextAction(item, lanes, synthesis, mainTurn, candidate)
  });
}

function projectLane(
  item: WorkItem,
  group: WorkItemExecutionGroup,
  lane: WorkItemExecutionLane,
  turns: readonly Turn[],
  sessionsByRole: ReadonlyMap<string, TaskRoleSessionSet>
): WorkItemLaneProjection {
  const current = lane.currentTurnId === undefined
    ? undefined
    : turns.find(({ id }) => id === lane.currentTurnId);
  const exact = current !== undefined
    && current.taskId === item.taskId
    && current.workItemId === item.id
    && current.executionGroupId === group.id
    && current.executionLaneId === lane.id
    && current.roleName === lane.roleName;
  const session = exact
    ? turnSessionStatus(current, sessionsByRole.get(lane.roleName))
    : "unobserved";
  if (lane.disposition === "failed") {
    return Object.freeze({
      laneId: lane.id,
      ordinal: lane.ordinal,
      roleName: lane.roleName,
      status: "failed",
      ...(lane.currentTurnId === undefined ? {} : { currentTurnId: lane.currentTurnId }),
      session,
      observation: exact ? "observed" : "unobserved"
    });
  }
  if (lane.disposition === "succeeded") {
    const producerObserved = exact
      && lane.successfulTurnId === current.id
      && current.status === "completed"
      && current.result !== undefined;
    return Object.freeze({
      laneId: lane.id,
      ordinal: lane.ordinal,
      roleName: lane.roleName,
      status: producerObserved ? "succeeded" : "unknown",
      ...(lane.currentTurnId === undefined ? {} : { currentTurnId: lane.currentTurnId }),
      ...(lane.successfulTurnId === undefined ? {} : { successfulTurnId: lane.successfulTurnId }),
      session,
      observation: producerObserved ? "observed" : "unobserved"
    });
  }
  if (!exact) {
    return Object.freeze({
      laneId: lane.id,
      ordinal: lane.ordinal,
      roleName: lane.roleName,
      status: "unknown",
      ...(lane.currentTurnId === undefined ? {} : { currentTurnId: lane.currentTurnId }),
      session: "unobserved",
      observation: "unobserved"
    });
  }
  if (current.status === "failed") {
    return Object.freeze({
      laneId: lane.id,
      ordinal: lane.ordinal,
      roleName: lane.roleName,
      status: "needs-attention",
      currentTurnId: current.id,
      session,
      retryTurnId: current.id,
      settleTurnId: current.id,
      observation: "observed"
    });
  }
  if (current.status === "active") {
    return Object.freeze({
      laneId: lane.id,
      ordinal: lane.ordinal,
      roleName: lane.roleName,
      status: session === "ended" ? "needs-attention" : "running",
      currentTurnId: current.id,
      session,
      observation: "observed"
    });
  }
  return Object.freeze({
    laneId: lane.id,
    ordinal: lane.ordinal,
    roleName: lane.roleName,
    status: "unknown",
    currentTurnId: current.id,
    session,
    observation: "unobserved"
  });
}

function projectMainTurn(
  item: WorkItem,
  group: WorkItemExecutionGroup | undefined,
  turns: readonly Turn[],
  sessionsByRole: ReadonlyMap<string, TaskRoleSessionSet>
): WorkItemMainTurnProjection {
  const candidates = turns.filter((turn) => (
    turn.purpose === "execution"
    && turn.roleName === item.assignee
    && turn.executionGroupId === undefined
    && turn.executionLaneId === undefined
    && turn.sourceExecutionGroupId === group?.id
  )).sort(compareTurns);
  const turn = candidates.at(-1);
  if (turn === undefined) {
    return Object.freeze({
      status: "not-started",
      ...(item.assignee === undefined ? {} : { roleName: item.assignee }),
      ...(group === undefined ? {} : { sourceExecutionGroupId: group.id }),
      session: "unobserved",
      observation: "unobserved"
    });
  }
  const session = turnSessionStatus(turn, sessionsByRole.get(turn.roleName));
  const base = {
    roleName: turn.roleName,
    turnId: turn.id,
    ...(turn.sourceExecutionGroupId === undefined
      ? {}
      : { sourceExecutionGroupId: turn.sourceExecutionGroupId }),
    session
  };
  if (turn.status === "failed") {
    return Object.freeze({
      ...base,
      status: "needs-attention",
      retryTurnId: turn.id,
      observation: "observed"
    });
  }
  if (turn.status === "active") {
    return Object.freeze({
      ...base,
      status: session === "ended" ? "needs-attention" : "running",
      observation: "observed"
    });
  }
  return Object.freeze({
    ...base,
    status: turn.result === undefined ? "unknown" : "succeeded",
    observation: turn.result === undefined ? "unobserved" : "observed"
  });
}

function projectSynthesis(
  group: WorkItemExecutionGroup | undefined,
  lanes: readonly WorkItemLaneProjection[],
  mainTurn: WorkItemMainTurnProjection
): WorkItemExecutionProjection["synthesis"] {
  if (group === undefined) {
    return Object.freeze({
      status: "not-applicable",
      successfulLaneCount: 0,
      requiredSuccessfulLaneCount: MINIMUM_WORK_ITEM_SYNTHESIS_RESULTS
    });
  }
  const successfulLaneCount = group.lanes.filter(({ disposition }) => disposition === "succeeded").length;
  let status: WorkItemSynthesisStatus;
  if (group.lanes.some(({ disposition }) => disposition === "open")) {
    status = "blocked-by-open-lanes";
  } else if (lanes.some((lane) => (
    lane.status === "unknown" && group.lanes.some(({ id, disposition }) => (
      id === lane.laneId && disposition === "succeeded"
    ))
  ))) {
    status = "unknown";
  } else if (successfulLaneCount < MINIMUM_WORK_ITEM_SYNTHESIS_RESULTS) {
    status = "insufficient-results";
  } else if (mainTurn.status === "not-started") {
    status = "eligible";
  } else if (mainTurn.status === "running") {
    status = "main-running";
  } else if (mainTurn.status === "needs-attention") {
    status = "main-needs-attention";
  } else if (mainTurn.status === "succeeded") {
    status = "complete";
  } else {
    status = "unknown";
  }
  return Object.freeze({
    status,
    successfulLaneCount,
    requiredSuccessfulLaneCount: MINIMUM_WORK_ITEM_SYNTHESIS_RESULTS
  });
}

function projectCandidate(
  item: WorkItem,
  group: WorkItemExecutionGroup | undefined,
  turns: readonly Turn[],
  lanes: readonly WorkItemLaneProjection[],
  mainTurn: WorkItemMainTurnProjection
): WorkItemCandidateSourceProjection {
  const candidate = governingWorkItemCandidate(item);
  if (candidate === undefined) {
    return Object.freeze({
      status: "none",
      successfulLaneTurns: Object.freeze([]),
      observation: "observed"
    });
  }
  if (candidate.source.type === "direct") {
    const valid = group === undefined && item.assignee === undefined;
    return candidateProjection(candidate, valid ? "observed" : "unknown", [], valid);
  }
  const sourceTurnId = candidate.source.turnId;
  const sourceTurn = turns.find(({ id }) => id === sourceTurnId);
  const laneTurns = group === undefined
    ? []
    : [...group.lanes]
      .filter(({ disposition, successfulTurnId }) => (
        disposition === "succeeded" && successfulTurnId !== undefined
      ))
      .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
      .map((lane) => ({ laneId: lane.id, successfulTurnId: lane.successfulTurnId! }));
  const valid = sourceTurn !== undefined
    && sourceTurn.id === mainTurn.turnId
    && sourceTurn.status === "completed"
    && sourceTurn.result !== undefined
    && sourceTurn.executionGroupId === undefined
    && sourceTurn.executionLaneId === undefined
    && sourceTurn.sourceExecutionGroupId === group?.id
    && candidate.executionLaneId === undefined
    && candidate.executionGroupId === undefined
    && (group === undefined || (
      laneTurns.length >= MINIMUM_WORK_ITEM_SYNTHESIS_RESULTS
      && lanes.filter(({ successfulTurnId }) => successfulTurnId !== undefined)
        .every(({ status }) => status === "succeeded")
    ));
  return candidateProjection(candidate, valid ? "observed" : "unknown", laneTurns, valid, group?.id);
}

function candidateProjection(
  candidate: WorkItemCandidate,
  status: "observed" | "unknown",
  successfulLaneTurns: readonly Readonly<{ laneId: string; successfulTurnId: string }>[],
  observed: boolean,
  sourceExecutionGroupId?: string
): WorkItemCandidateSourceProjection {
  return Object.freeze({
    status,
    candidateId: candidate.id,
    sourceType: candidate.source.type,
    ...(candidate.source.type === "turn" ? { mainTurnId: candidate.source.turnId } : {}),
    ...(sourceExecutionGroupId === undefined ? {} : { sourceExecutionGroupId }),
    successfulLaneTurns: Object.freeze(successfulLaneTurns),
    observation: observed ? "observed" : "unobserved"
  });
}

function projectNextAction(
  item: WorkItem,
  lanes: readonly WorkItemLaneProjection[],
  synthesis: WorkItemExecutionProjection["synthesis"],
  mainTurn: WorkItemMainTurnProjection,
  candidate: WorkItemCandidateSourceProjection
): WorkItemExecutionNextAction {
  if (["completed", "retired"].includes(item.status)) return action("none", [], []);
  if (item.status === "awaiting_acceptance") {
    return candidate.status === "observed"
      ? action("decide-candidate", ["leader"], [candidate.candidateId!])
      : action("inspect-unknown", ["leader"], candidate.candidateId === undefined ? [] : [candidate.candidateId]);
  }
  if (lanes.some(({ status }) => status === "unknown")) {
    return action("inspect-unknown", ["leader"], lanes
      .filter(({ status }) => status === "unknown")
      .map(({ laneId }) => laneId));
  }
  const recoveries = lanes.filter(({ retryTurnId }) => retryTurnId !== undefined);
  if (recoveries.length > 0) {
    return action("retry-or-settle-lanes", ["leader"], recoveries.map(({ retryTurnId }) => retryTurnId!));
  }
  const activeLanes = lanes.filter(({ status }) => status === "running");
  if (activeLanes.length > 0) {
    return action("wait-for-lanes", activeLanes.map(({ roleName }) => roleName), activeLanes.map(({ laneId }) => laneId));
  }
  if (synthesis.status === "insufficient-results") {
    return action("redispatch-work", ["leader"], [item.id]);
  }
  if (synthesis.status === "eligible") {
    return action("await-main-dispatch", ["controller", ...(item.assignee === undefined ? [] : [item.assignee])], [item.id]);
  }
  if (mainTurn.status === "running") {
    return action("wait-for-main", mainTurn.roleName === undefined ? [] : [mainTurn.roleName], mainTurn.turnId === undefined ? [] : [mainTurn.turnId]);
  }
  if (mainTurn.status === "needs-attention") {
    return mainTurn.retryTurnId === undefined
      ? action("inspect-unknown", ["leader"], mainTurn.turnId === undefined ? [] : [mainTurn.turnId])
      : action("retry-main", ["leader"], [mainTurn.retryTurnId]);
  }
  if (mainTurn.status === "succeeded" && item.status === "running") {
    return action("submit-candidate", ["leader"], [mainTurn.turnId!]);
  }
  if (mainTurn.status === "unknown" || synthesis.status === "unknown") {
    return action("inspect-unknown", ["leader"], mainTurn.turnId === undefined ? [item.id] : [mainTurn.turnId]);
  }
  if (item.status === "pending" || item.status === "failed") {
    return action("dispatch-work", ["leader"], [item.id]);
  }
  return action("inspect-unknown", ["leader"], [item.id]);
}

function action(
  kind: WorkItemExecutionNextAction["kind"],
  owners: readonly string[],
  targetIds: readonly string[]
): WorkItemExecutionNextAction {
  return Object.freeze({
    kind,
    owners: Object.freeze([...new Set(owners)]),
    targetIds: Object.freeze([...new Set(targetIds)])
  });
}

function turnSessionStatus(
  turn: Turn,
  set: TaskRoleSessionSet | undefined
): "active" | "ended" | "unobserved" {
  return set?.sessions[turn.effective.agentId]?.status ?? "unobserved";
}

function compareTurns(left: Turn, right: Turn): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
