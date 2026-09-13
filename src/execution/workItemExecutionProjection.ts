import type { AgentRun } from "../agentRun/agentRun.js";
import { synthesisSourceRunIds } from "../context/runContextPack.js";
import type { TaskRoleSessionSet } from "../executor/agentExecutor.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  currentWorkItemExecutionGroup,
  governingWorkItemCandidate,
  type WorkItem,
  type WorkItemCandidate
} from "../workItem/workItem.js";
import type {
  WorkItemExecutionGroup,
  WorkItemExecutionLane
} from "./workItemExecution.js";

export type WorkItemLaneProjectedStatus =
  | "running"
  | "succeeded"
  | "needs-attention"
  | "failed"
  | "unknown";

export type WorkItemRunProjectedStatus =
  | "not-started"
  | "running"
  | "succeeded"
  | "needs-attention"
  | "unknown";

export type WorkItemSynthesisStatus =
  | "not-applicable"
  | "awaiting-selection"
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
  }>;
  mainRun: WorkItemMainRunProjection;
  candidate: WorkItemCandidateSourceProjection;
  nextAction: WorkItemExecutionNextAction;
}>;

export type WorkItemLaneProjection = Readonly<{
  laneId: string;
  ordinal: number;
  roleName: string;
  status: WorkItemLaneProjectedStatus;
  currentRunId?: string;
  successfulRunId?: string;
  session: "active" | "ended" | "unobserved";
  retryRunId?: string;
  settleRunId?: string;
  observation: "observed" | "unobserved";
  delivery?: import("../runtime/providerRuntimeIdentity.js").ProviderTurnStatus | "unobserved";
}>;

export type WorkItemMainRunProjection = Readonly<{
  status: WorkItemRunProjectedStatus;
  roleName?: string;
  runId?: string;
  sourceExecutionGroupId?: string;
  session: "active" | "ended" | "unobserved";
  retryRunId?: string;
  observation: "observed" | "unobserved";
  delivery?: import("../runtime/providerRuntimeIdentity.js").ProviderTurnStatus | "unobserved";
}>;

export type WorkItemCandidateSourceProjection = Readonly<{
  status: "none" | "observed" | "unknown";
  candidateId?: string;
  sourceType?: "direct" | "run";
  mainRunId?: string;
  sourceExecutionGroupId?: string;
  successfulLaneRuns: readonly Readonly<{
    laneId: string;
    successfulRunId: string;
  }>[];
  observation: "observed" | "unobserved";
}>;

export type WorkItemExecutionNextAction = Readonly<{
  kind:
    | "execute-directly"
    | "dispatch-work"
    | "wait-for-lanes"
    | "retry-or-settle-lanes"
    | "inspect-unknown"
    | "select-synthesis-sources"
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
  runs: readonly AgentRun[],
  sessionSets: readonly TaskRoleSessionSet[] = [],
  sourceStore?: Pick<TaskStore, "getContextSnapshot">
): WorkItemExecutionProjection {
  const group = currentWorkItemExecutionGroup(item);
  const relevantRuns = runs.filter((run) => run.workItemId === item.id);
  const sessionsByRole = new Map(sessionSets.map((set) => [set.owner.roleName, set]));
  const lanes = group === undefined
    ? []
    : [...group.lanes]
      .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
      .map((lane) => projectLane(item, group, lane, relevantRuns, sessionsByRole));
  const laneCounts = Object.freeze({
    running: lanes.filter(({ status }) => status === "running").length,
    succeeded: lanes.filter(({ status }) => status === "succeeded").length,
    needsAttention: lanes.filter(({ status }) => status === "needs-attention").length,
    failed: lanes.filter(({ status }) => status === "failed").length,
    unknown: lanes.filter(({ status }) => status === "unknown").length
  });
  const mainRun = projectMainRun(item, group, relevantRuns, sessionsByRole);
  const synthesis = projectSynthesis(group, lanes, mainRun);
  const candidate = projectCandidate(item, group, relevantRuns, mainRun, sourceStore);
  return Object.freeze({
    schemaVersion: 1,
    shape: group === undefined ? "direct" : "replicated",
    ...(group === undefined ? {} : { groupId: group.id }),
    lanes: Object.freeze(lanes),
    laneCounts,
    synthesis,
    mainRun,
    candidate,
    nextAction: projectNextAction(item, lanes, synthesis, mainRun, candidate)
  });
}

function projectLane(
  item: WorkItem,
  group: WorkItemExecutionGroup,
  lane: WorkItemExecutionLane,
  runs: readonly AgentRun[],
  sessionsByRole: ReadonlyMap<string, TaskRoleSessionSet>
): WorkItemLaneProjection {
  const current = lane.currentRunId === undefined
    ? undefined
    : runs.find(({ id }) => id === lane.currentRunId);
  const exact = current !== undefined
    && current.taskId === item.taskId
    && current.workItemId === item.id
    && current.executionGroupId === group.id
    && current.executionLaneId === lane.id
    && current.roleName === lane.roleName;
  const session = exact
    ? runSessionStatus(current, sessionsByRole.get(lane.roleName))
    : "unobserved";
  if (lane.disposition === "failed") {
    return Object.freeze({
      laneId: lane.id,
      ordinal: lane.ordinal,
      roleName: lane.roleName,
      status: "failed",
      ...(lane.currentRunId === undefined ? {} : { currentRunId: lane.currentRunId }),
      session,
      observation: exact ? "observed" : "unobserved"
    });
  }
  if (lane.disposition === "succeeded") {
    const producerObserved = exact
      && lane.successfulRunId === current.id
      && current.status === "completed"
      && current.result !== undefined;
    return Object.freeze({
      laneId: lane.id,
      ordinal: lane.ordinal,
      roleName: lane.roleName,
      status: producerObserved ? "succeeded" : "unknown",
      ...(lane.currentRunId === undefined ? {} : { currentRunId: lane.currentRunId }),
      ...(lane.successfulRunId === undefined ? {} : { successfulRunId: lane.successfulRunId }),
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
      ...(lane.currentRunId === undefined ? {} : { currentRunId: lane.currentRunId }),
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
      currentRunId: current.id,
      session,
      retryRunId: current.id,
      settleRunId: current.id,
      observation: "observed"
    });
  }
  if (current.status === "active") {
    return Object.freeze({
      laneId: lane.id,
      ordinal: lane.ordinal,
      roleName: lane.roleName,
      status: session === "ended" ? "needs-attention" : "running",
      currentRunId: current.id,
      delivery: observedAdmission(current, sessionsByRole.get(lane.roleName)),
      session,
      observation: "observed"
    });
  }
  return Object.freeze({
    laneId: lane.id,
    ordinal: lane.ordinal,
    roleName: lane.roleName,
    status: "unknown",
    currentRunId: current.id,
    session,
    observation: "unobserved"
  });
}

function projectMainRun(
  item: WorkItem,
  group: WorkItemExecutionGroup | undefined,
  runs: readonly AgentRun[],
  sessionsByRole: ReadonlyMap<string, TaskRoleSessionSet>
): WorkItemMainRunProjection {
  const candidates = runs.filter((run) => (
    run.purpose === "execution"
    && run.roleName === item.assignee
    && run.executionGroupId === undefined
    && run.executionLaneId === undefined
    && run.sourceExecutionGroupId === group?.id
  )).sort(compareRuns);
  const run = candidates.at(-1);
  if (run === undefined) {
    return Object.freeze({
      status: "not-started",
      ...(item.assignee === undefined ? {} : { roleName: item.assignee }),
      ...(group === undefined ? {} : { sourceExecutionGroupId: group.id }),
      session: "unobserved",
      observation: "unobserved"
    });
  }
  const session = runSessionStatus(run, sessionsByRole.get(run.roleName));
  const base = {
    roleName: run.roleName,
    runId: run.id,
    ...(run.sourceExecutionGroupId === undefined
      ? {}
      : { sourceExecutionGroupId: run.sourceExecutionGroupId }),
    session
  };
  if (run.status === "failed") {
    return Object.freeze({
      ...base,
      status: "needs-attention",
      retryRunId: run.id,
      observation: "observed"
    });
  }
  if (run.status === "active") {
    return Object.freeze({
      ...base,
      delivery: observedAdmission(run, sessionsByRole.get(run.roleName)),
      status: session === "ended" ? "needs-attention" : "running",
      observation: "observed"
    });
  }
  return Object.freeze({
    ...base,
    status: run.result === undefined ? "unknown" : "succeeded",
    observation: run.result === undefined ? "unobserved" : "observed"
  });
}

function projectSynthesis(
  group: WorkItemExecutionGroup | undefined,
  _lanes: readonly WorkItemLaneProjection[],
  mainRun: WorkItemMainRunProjection
): WorkItemExecutionProjection["synthesis"] {
  if (group === undefined) {
    return Object.freeze({
      status: "not-applicable",
      successfulLaneCount: 0
    });
  }
  const successfulLaneCount = group.lanes.filter(({ disposition }) => disposition === "succeeded").length;
  let status: WorkItemSynthesisStatus;
  if (mainRun.status === "not-started") {
    status = "awaiting-selection";
  } else if (mainRun.status === "running") {
    status = "main-running";
  } else if (mainRun.status === "needs-attention") {
    status = "main-needs-attention";
  } else if (mainRun.status === "succeeded") {
    status = "complete";
  } else {
    status = "unknown";
  }
  return Object.freeze({
    status,
    successfulLaneCount
  });
}

function projectCandidate(
  item: WorkItem,
  group: WorkItemExecutionGroup | undefined,
  runs: readonly AgentRun[],
  mainRun: WorkItemMainRunProjection,
  sourceStore?: Pick<TaskStore, "getContextSnapshot">
): WorkItemCandidateSourceProjection {
  const candidate = governingWorkItemCandidate(item);
  if (candidate === undefined) {
    return Object.freeze({
      status: "none",
      successfulLaneRuns: Object.freeze([]),
      observation: "observed"
    });
  }
  if (candidate.source.type === "direct") {
    const valid = group === undefined && item.assignee === undefined;
    return candidateProjection(candidate, valid ? "observed" : "unknown", [], valid);
  }
  const sourceRunId = candidate.source.runId;
  const sourceRun = runs.find(({ id }) => id === sourceRunId);
  const laneRuns = group === undefined || sourceStore === undefined || sourceRun === undefined
    ? []
    : synthesisSourceRunIds(sourceStore, sourceRun).flatMap((id) => {
      const selected = runs.find((run) => run.id === id);
      return selected?.executionLaneId === undefined ? [] : [{
        laneId: selected.executionLaneId, successfulRunId: selected.id
      }];
    });
  const valid = sourceRun !== undefined
    && sourceRun.id === mainRun.runId
    && sourceRun.status === "completed"
    && sourceRun.result !== undefined
    && sourceRun.executionGroupId === undefined
    && sourceRun.executionLaneId === undefined
    && sourceRun.sourceExecutionGroupId === group?.id
    && candidate.executionLaneId === undefined
    && candidate.executionGroupId === undefined
    && (group === undefined || laneRuns.length > 0);
  return candidateProjection(candidate, valid ? "observed" : "unknown", laneRuns, valid, group?.id);
}

function candidateProjection(
  candidate: WorkItemCandidate,
  status: "observed" | "unknown",
  successfulLaneRuns: readonly Readonly<{ laneId: string; successfulRunId: string }>[],
  observed: boolean,
  sourceExecutionGroupId?: string
): WorkItemCandidateSourceProjection {
  return Object.freeze({
    status,
    candidateId: candidate.id,
    sourceType: candidate.source.type,
    ...(candidate.source.type === "run" ? { mainRunId: candidate.source.runId } : {}),
    ...(sourceExecutionGroupId === undefined ? {} : { sourceExecutionGroupId }),
    successfulLaneRuns: Object.freeze(successfulLaneRuns),
    observation: observed ? "observed" : "unobserved"
  });
}

function projectNextAction(
  item: WorkItem,
  lanes: readonly WorkItemLaneProjection[],
  synthesis: WorkItemExecutionProjection["synthesis"],
  mainRun: WorkItemMainRunProjection,
  candidate: WorkItemCandidateSourceProjection
): WorkItemExecutionNextAction {
  if (["accepted", "retired"].includes(item.status)) return action("none", [], []);
  if ((item.status === "open" && item.currentCandidateId !== undefined)) {
    return candidate.status === "observed"
      ? action("decide-candidate", ["leader"], [candidate.candidateId!])
      : action("inspect-unknown", ["leader"], candidate.candidateId === undefined ? [] : [candidate.candidateId]);
  }
  if (lanes.some(({ status }) => status === "unknown")) {
    return action("inspect-unknown", ["leader"], lanes
      .filter(({ status }) => status === "unknown")
      .map(({ laneId }) => laneId));
  }
  const recoveries = lanes.filter(({ retryRunId }) => retryRunId !== undefined);
  if (recoveries.length > 0) {
    return action("retry-or-settle-lanes", ["leader"], recoveries.map(({ retryRunId }) => retryRunId!));
  }
  const activeLanes = lanes.filter(({ status }) => status === "running");
  if (activeLanes.length > 0) {
    return action("wait-for-lanes", activeLanes.map(({ roleName }) => roleName), activeLanes.map(({ laneId }) => laneId));
  }
  if (synthesis.status === "awaiting-selection") {
    return action("select-synthesis-sources", ["leader"], [item.id]);
  }
  if (mainRun.status === "running") {
    return action("wait-for-main", mainRun.roleName === undefined ? [] : [mainRun.roleName], mainRun.runId === undefined ? [] : [mainRun.runId]);
  }
  if (mainRun.status === "needs-attention") {
    return mainRun.retryRunId === undefined
      ? action("inspect-unknown", ["leader"], mainRun.runId === undefined ? [] : [mainRun.runId])
      : action("retry-main", ["leader"], [mainRun.retryRunId]);
  }
  if (mainRun.status === "succeeded" && item.status === "open") {
    return action("submit-candidate", ["leader"], [mainRun.runId!]);
  }
  if (mainRun.status === "unknown" || synthesis.status === "unknown") {
    return action("inspect-unknown", ["leader"], mainRun.runId === undefined ? [item.id] : [mainRun.runId]);
  }
  if (item.status === "open") {
    return action(item.assignee === undefined ? "execute-directly" : "dispatch-work",
      ["leader"], [item.id]);
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

function runSessionStatus(
  run: AgentRun,
  set: TaskRoleSessionSet | undefined
): "active" | "ended" | "unobserved" {
  return set?.sessions[run.effective.agentId]?.status ?? "unobserved";
}

function observedAdmission(run: AgentRun, sessions: TaskRoleSessionSet | undefined) {
  const native = sessions?.providerBinding?.run;
  return native?.runId === run.id ? native.status : "unobserved" as const;
}

function compareRuns(left: AgentRun, right: AgentRun): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
