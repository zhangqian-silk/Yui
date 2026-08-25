import { isDeepStrictEqual } from "node:util";

import { requireIdentity, requireText, requireTimestamp } from "../domain/validation.js";
import {
  validateEffectiveLaunchSnapshot,
  type EffectiveLaunchSnapshot
} from "../executor/effectiveLaunch.js";

/** The one execution abstraction used by both the one-lane and panel paths. */
export const EXECUTION_GROUP_SCHEMA_VERSION = 1 as const;
export const EXECUTION_LANE_SCHEMA_VERSION = 1 as const;

export type ExecutionPurpose = "execution" | "review";
export type ExecutionLaneStatus =
  | "pending"
  | "running"
  | "yielded"
  | "completed"
  | "failed";

export type ExecutionStrategy = Readonly<
  | { mode: "fixed"; count: number }
  | { mode: "adaptive"; max: number }
>;

/**
 * A target is deliberately a value snapshot rather than a pointer to a live
 * branch, Candidate, or contract.  A changed target therefore cannot be
 * appended to an existing group.
 */
export type ExecutionTarget = Readonly<{
  schemaVersion: 1;
  kind: "work-item" | "task-final-review";
  taskId: string;
  workItemId?: string;
  candidateId?: string;
  revision: number;
  projects: readonly Readonly<{ projectId: string; commit: string }>[];
  contractDigest?: string;
  fingerprint: string;
}>;

export type ExecutionCheck = Readonly<{
  name: string;
  outcome: "passed" | "failed" | "skipped";
  details?: string;
}>;

export type ExecutionFinding = Readonly<{
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  /** Open high-priority findings always remain visible to the Leader. */
  status: "open" | "resolved";
}>;

/**
 * The immutable Git output of one Lane at the moment it yields.  Resolution
 * must consume these exact commits; a later branch advance is never silently
 * folded into the Candidate.
 */
export type ExecutionLaneGitSnapshot = Readonly<{
  schemaVersion: 1;
  projects: readonly Readonly<{
    projectId: string;
    headCommit: string;
    branch: string;
  }>[];
}>;

export type ExecutionLaneResult = Readonly<{
  summary: string;
  report?: string;
  checks?: readonly ExecutionCheck[];
  findings?: readonly ExecutionFinding[];
  evidence?: readonly string[];
  /** Commit containing durable evidence produced by this Lane. */
  evidenceCommit?: string;
  /** Managed workspace heads frozen automatically when this Lane yields. */
  gitSnapshot?: ExecutionLaneGitSnapshot;
}>;

export type ExecutionLaneWorkspace = Readonly<{
  /** A lane must never share a writable root with another lane. */
  root: string;
  writableProjectIds: readonly string[];
}>;

export type ExecutionLane = Readonly<{
  schemaVersion: typeof EXECUTION_LANE_SCHEMA_VERSION;
  id: string;
  groupId: string;
  ordinal: number;
  roleName: string;
  effective?: EffectiveLaunchSnapshot;
  runId?: string;
  sessionId?: string;
  reviewRoundId?: string;
  workspace?: ExecutionLaneWorkspace;
  status: ExecutionLaneStatus;
  result?: ExecutionLaneResult;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}>;

export type ExecutionResolution = Readonly<{
  decision: "accept" | "reject" | "retry" | "blocked";
  summary: string;
  selectedLaneIds: readonly string[];
  unresolvedFindingIds: readonly string[];
  decidedAt: string;
}>;

export type ExecutionGroup = Readonly<{
  schemaVersion: typeof EXECUTION_GROUP_SCHEMA_VERSION;
  id: string;
  taskId: string;
  purpose: ExecutionPurpose;
  strategy: ExecutionStrategy;
  target: ExecutionTarget;
  lanes: readonly ExecutionLane[];
  resolution?: ExecutionResolution;
  createdAt: string;
  updatedAt: string;
}>;

export type ExecutionGroupSummary = Readonly<{
  groupId: string;
  purpose: ExecutionPurpose;
  strategy: ExecutionStrategy;
  laneCount: number;
  activeLaneCount: number;
  terminalLaneCount: number;
  failedLaneCount: number;
  openHighPriorityFindingIds: readonly string[];
  laneSummaries: readonly Readonly<{
    laneId: string;
    roleName: string;
    ordinal: number;
    status: ExecutionLaneStatus;
    summary?: string;
    report?: string;
    checks?: readonly ExecutionCheck[];
    findings?: readonly ExecutionFinding[];
    evidence?: readonly string[];
    evidenceCommit?: string;
    gitSnapshot?: ExecutionLaneGitSnapshot;
    /** The Leader's group decision, when this Lane was selected. */
    decision?: ExecutionResolution["decision"];
  }>[];
  resolution?: ExecutionResolution;
}>;

export type ExecutionLaneInput = Readonly<{
  id?: string;
  ordinal?: number;
  roleName: string;
  effective?: EffectiveLaunchSnapshot;
  runId?: string;
  sessionId?: string;
  reviewRoundId?: string;
  workspace?: ExecutionLaneWorkspace;
}>;

export type ExecutionGroupInput = Readonly<{
  purpose: ExecutionPurpose;
  target: ExecutionTarget;
  strategy?: ExecutionStrategy;
  lanes?: readonly ExecutionLaneInput[];
  /** Used only when the caller wants the default one-lane group. */
  roleName?: string;
}>;

export function createExecutionGroup(
  id: string,
  taskId: string,
  input: ExecutionGroupInput,
  now: Date
): ExecutionGroup {
  const timestamp = now.toISOString();
  const strategy = normalizeStrategy(input.strategy ?? { mode: "fixed", count: 1 });
  const target = validateExecutionTarget(input.target, taskId);
  const laneInputs = input.lanes === undefined
    ? [{ roleName: input.roleName ?? "leader" }]
    : input.lanes;
  if (laneInputs.length === 0) {
    throw new Error("An ExecutionGroup requires at least one Lane.");
  }
  if (strategy.mode === "fixed" && laneInputs.length > strategy.count) {
    throw new Error("ExecutionGroup Lane count exceeds its fixed strategy.");
  }
  if (strategy.mode === "adaptive" && laneInputs.length > strategy.max) {
    throw new Error("ExecutionGroup Lane count exceeds its adaptive maximum.");
  }
  const lanes = laneInputs.map((lane, index) => createLane(
    `${id}-lane-${lane.id ?? index + 1}`,
    id,
    lane,
    index + 1,
    timestamp
  ));
  return validateExecutionGroup({
    schemaVersion: EXECUTION_GROUP_SCHEMA_VERSION,
    id: requireIdentity(id, "ExecutionGroup id"),
    taskId: requireIdentity(taskId, "Task id"),
    purpose: validatePurpose(input.purpose),
    strategy,
    target,
    lanes,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function addExecutionLane(
  group: ExecutionGroup,
  input: ExecutionLaneInput,
  now: Date
): ExecutionGroup {
  validateExecutionGroup(group);
  if (group.resolution !== undefined) {
    throw new Error(`ExecutionGroup is already resolved: ${group.id}.`);
  }
  if (!isDeepStrictEqual(group.target, validateExecutionTarget(group.target, group.taskId))) {
    throw new Error(`ExecutionGroup target is not frozen: ${group.id}.`);
  }
  const nextCount = group.lanes.length + 1;
  if (group.strategy.mode === "fixed" && nextCount > group.strategy.count) {
    throw new Error(`Fixed ExecutionGroup cannot add Lane ${nextCount}: ${group.id}.`);
  }
  if (group.strategy.mode === "adaptive" && nextCount > group.strategy.max) {
    throw new Error(`Adaptive ExecutionGroup reached its maximum: ${group.id}.`);
  }
  const timestamp = now.toISOString();
  const lane = createLane(
    `${group.id}-lane-${input.id ?? nextCount}`,
    group.id,
    input,
    input.ordinal ?? nextCount,
    timestamp
  );
  if (group.lanes.some((existing) => existing.id === lane.id)) {
    throw new Error(`ExecutionGroup Lane already exists: ${lane.id}.`);
  }
  return validateExecutionGroup({
    ...group,
    lanes: [...group.lanes, lane],
    updatedAt: timestamp
  });
}

/** Alias used by scheduler-facing callers. */
export const appendExecutionLane = addExecutionLane;

export function assertExecutionTargetUnchanged(
  group: ExecutionGroup,
  target: ExecutionTarget
): void {
  validateExecutionGroup(group);
  const next = validateExecutionTarget(target, group.taskId);
  if (!isDeepStrictEqual(group.target, next)) {
    throw new Error(
      `ExecutionGroup target changed; create a new Group: ${group.id}.`
    );
  }
}

/**
 * Enforce the only durable Group/Lane evolution accepted by both domain
 * helpers and storage. Identity, target, prior results, and a final Leader
 * resolution never move backwards. A terminal Lane may only reopen as an
 * explicit retry with a fresh Run identity, or reset to pending for a
 * Task-final Review execution retry.
 */
export function assertExecutionGroupTransition(
  existing: ExecutionGroup,
  candidate: ExecutionGroup
): void {
  validateExecutionGroup(existing);
  validateExecutionGroup(candidate);
  if (isDeepStrictEqual(existing, candidate)) return;
  if (existing.id !== candidate.id
    || existing.taskId !== candidate.taskId
    || existing.purpose !== candidate.purpose
    || !isDeepStrictEqual(existing.strategy, candidate.strategy)
    || !isDeepStrictEqual(existing.target, candidate.target)
    || existing.createdAt !== candidate.createdAt) {
    throw new Error(`ExecutionGroup identity or target changed: ${existing.id}.`);
  }
  if (Date.parse(candidate.updatedAt) < Date.parse(existing.updatedAt)) {
    throw new Error(`ExecutionGroup time moved backwards: ${existing.id}.`);
  }
  if (existing.resolution !== undefined) {
    throw new Error(`Resolved ExecutionGroup is immutable: ${existing.id}.`);
  }
  if (candidate.lanes.length < existing.lanes.length) {
    throw new Error(`ExecutionGroup cannot remove Lanes: ${existing.id}.`);
  }
  for (const [index, lane] of existing.lanes.entries()) {
    const next = candidate.lanes[index];
    if (next === undefined) {
      throw new Error(`ExecutionGroup cannot remove Lane: ${lane.id}.`);
    }
    assertExecutionLaneTransition(lane, next, existing.id, existing.purpose);
  }
}

export function isExecutionGroupTransition(
  existing: ExecutionGroup,
  candidate: ExecutionGroup
): boolean {
  try {
    assertExecutionGroupTransition(existing, candidate);
    return true;
  } catch {
    return false;
  }
}

export function updateExecutionLane(
  group: ExecutionGroup,
  laneId: string,
  patch: Readonly<{
    status?: ExecutionLaneStatus;
    effective?: EffectiveLaunchSnapshot;
    runId?: string;
    sessionId?: string;
    reviewRoundId?: string;
    workspace?: ExecutionLaneWorkspace;
  }>,
  now: Date
): ExecutionGroup {
  validateExecutionGroup(group);
  if (group.resolution !== undefined) {
    throw new Error(`ExecutionGroup is already resolved: ${group.id}.`);
  }
  const id = requireIdentity(laneId, "ExecutionLane id");
  const existing = group.lanes.find((lane) => lane.id === id);
  if (existing === undefined) throw new Error(`ExecutionLane not found: ${group.id}/${id}.`);
  if (isTerminalLane(existing.status) && patch.status !== existing.status) {
    throw new Error(`Terminal ExecutionLane cannot be updated; create a retry Lane: ${group.id}/${id}.`);
  }
  const status = patch.status ?? existing.status;
  const timestamp = now.toISOString();
  const terminal = status === "completed" || status === "failed" || status === "yielded";
  const next = {
    ...existing,
    ...(patch.effective === undefined ? {} : { effective: validateEffectiveLaunchSnapshot(patch.effective) }),
    ...(patch.runId === undefined ? {} : { runId: requireIdentity(patch.runId, "Agent Run id") }),
    ...(patch.sessionId === undefined ? {} : { sessionId: requireIdentity(patch.sessionId, "Session id") }),
    ...(patch.reviewRoundId === undefined ? {} : { reviewRoundId: requireIdentity(patch.reviewRoundId, "ReviewRound id") }),
    ...(patch.workspace === undefined ? {} : { workspace: validateLaneWorkspace(patch.workspace) }),
    status,
    updatedAt: timestamp,
    ...(terminal && existing.endedAt === undefined ? { endedAt: timestamp } : {})
  } as ExecutionLane;
  return validateExecutionGroup({
    ...group,
    lanes: group.lanes.map((lane) => lane.id === id ? next : lane),
    updatedAt: timestamp
  });
}

/**
 * Reopens a failed/yielded lane for an explicit WorkItem retry.  The lane
 * keeps its identity and frozen Group target, while the previous result stays
 * in the event/Candidate history rather than being silently overwritten.
 */
export function restartExecutionLane(
  group: ExecutionGroup,
  laneId: string,
  patch: Readonly<{
    effective?: EffectiveLaunchSnapshot;
    runId?: string;
    sessionId?: string;
    reviewRoundId?: string;
    workspace?: ExecutionLaneWorkspace;
  }>,
  now: Date
): ExecutionGroup {
  validateExecutionGroup(group);
  if (group.resolution !== undefined) {
    throw new Error(`ExecutionGroup is already resolved: ${group.id}.`);
  }
  const id = requireIdentity(laneId, "ExecutionLane id");
  const existing = group.lanes.find((lane) => lane.id === id);
  if (existing === undefined) throw new Error(`ExecutionLane not found: ${group.id}/${id}.`);
  if (!isTerminalLane(existing.status)) {
    throw new Error(`ExecutionLane is not retryable: ${group.id}/${id}.`);
  }
  const timestamp = now.toISOString();
  const { result: _result, endedAt: _endedAt, ...base } = existing;
  const next: ExecutionLane = {
    ...base,
    ...(patch.effective === undefined ? {} : { effective: validateEffectiveLaunchSnapshot(patch.effective) }),
    ...(patch.runId === undefined ? {} : { runId: requireIdentity(patch.runId, "Agent Run id") }),
    ...(patch.sessionId === undefined ? {} : { sessionId: requireIdentity(patch.sessionId, "Session id") }),
    ...(patch.reviewRoundId === undefined ? {} : { reviewRoundId: requireIdentity(patch.reviewRoundId, "ReviewRound id") }),
    ...(patch.workspace === undefined ? {} : { workspace: validateLaneWorkspace(patch.workspace) }),
    status: "running",
    updatedAt: timestamp
  };
  return validateExecutionGroup({
    ...group,
    lanes: group.lanes.map((lane) => lane.id === id ? next : lane),
    updatedAt: timestamp
  });
}

/**
 * Resets a terminal Reviewer Lane to pending without replacing its ExecutionGroup.
 * The old AgentRun remains the attempt trail; clearing the Lane's Run/session and
 * result lets the same semantic ReviewRound be dispatched again.
 */
export function resetReviewExecutionLane(
  group: ExecutionGroup,
  laneId: string,
  now: Date
): ExecutionLane {
  validateExecutionGroup(group);
  if (group.purpose !== "review") {
    throw new Error(`Only Review ExecutionLanes can reset to pending: ${group.id}/${laneId}.`);
  }
  if (group.resolution !== undefined) {
    throw new Error(`ExecutionGroup is already resolved: ${group.id}.`);
  }
  const existing = group.lanes.find((lane) => lane.id === laneId);
  if (existing === undefined) throw new Error(`ExecutionLane not found: ${group.id}/${laneId}.`);
  if (!isTerminalLane(existing.status)) return existing;
  const timestamp = now.toISOString();
  const {
    effective: _effective,
    runId: _runId,
    sessionId: _sessionId,
    result: _result,
    endedAt: _endedAt,
    ...base
  } = existing;
  return validateExecutionLane({
    ...base,
    status: "pending",
    updatedAt: timestamp
  }, group);
}

export function recordExecutionLaneResult(
  group: ExecutionGroup,
  laneId: string,
  result: ExecutionLaneResult,
  status: "yielded" | "completed" | "failed",
  now: Date
): ExecutionGroup {
  const checked = validateLaneResult(result);
  validateExecutionGroup(group);
  const existing = group.lanes.find((lane) => lane.id === laneId);
  if (existing === undefined) throw new Error(`ExecutionLane not found: ${group.id}/${laneId}.`);
  if (isTerminalLane(existing.status)) {
    throw new Error(`ExecutionLane is already terminal: ${group.id}/${laneId}.`);
  }
  const timestamp = now.toISOString();
  return validateExecutionGroup({
    ...group,
    lanes: group.lanes.map((lane) => lane.id === laneId
      ? { ...lane, status, result: checked, updatedAt: timestamp, endedAt: timestamp }
      : lane),
    updatedAt: timestamp
  });
}

export function resolveExecutionGroup(
  group: ExecutionGroup,
  input: Readonly<{
    decision: ExecutionResolution["decision"];
    summary: string;
    selectedLaneIds?: readonly string[];
  }>,
  now: Date
): ExecutionGroup {
  validateExecutionGroup(group);
  if (group.resolution !== undefined) {
    throw new Error(`ExecutionGroup is already resolved: ${group.id}.`);
  }
  if (group.lanes.some((lane) => !isTerminalLane(lane.status))) {
    throw new Error(`ExecutionGroup has active Lanes: ${group.id}.`);
  }
  const summary = requireText(input.summary, "Execution resolution summary");
  const defaultSelectedLaneIds = input.decision === "accept"
    ? group.lanes
      .filter((lane) => lane.status === "yielded" || lane.status === "completed")
      .map(({ id }) => id)
    : group.lanes.map(({ id }) => id);
  const selected = [...new Set((input.selectedLaneIds ?? defaultSelectedLaneIds)
    .map((id) => requireIdentity(id, "Selected ExecutionLane id")))];
  if (input.decision === "accept" && selected.length === 0) {
    throw new Error(`ExecutionGroup has no usable terminal Lane outputs: ${group.id}.`);
  }
  if (input.decision === "accept" && selected.some((id) => {
    const lane = group.lanes.find((candidate) => candidate.id === id);
    return lane?.status !== "yielded" && lane?.status !== "completed";
  })) {
    throw new Error(`ExecutionGroup accept selects a Lane without usable terminal output: ${group.id}.`);
  }
  if (selected.some((id) => !group.lanes.some((lane) => lane.id === id))) {
    throw new Error(`Execution resolution selects an unknown Lane: ${group.id}.`);
  }
  const openHigh = openHighPriorityFindingIds(group);
  if (input.decision === "accept" && openHigh.length > 0) {
    throw new Error(
      `ExecutionGroup cannot be accepted with open high-priority findings: ${openHigh.join(", ")}.`
    );
  }
  const timestamp = now.toISOString();
  return validateExecutionGroup({
    ...group,
    resolution: {
      decision: input.decision,
      summary,
      selectedLaneIds: selected,
      unresolvedFindingIds: openHigh,
      decidedAt: timestamp
    },
    updatedAt: timestamp
  });
}

export function summarizeExecutionGroup(group: ExecutionGroup): ExecutionGroupSummary {
  validateExecutionGroup(group);
  const activeLaneCount = group.lanes.filter(({ status }) => (
    status === "pending" || status === "running"
  )).length;
  const terminalLaneCount = group.lanes.length - activeLaneCount;
  return {
    groupId: group.id,
    purpose: group.purpose,
    strategy: group.strategy,
    laneCount: group.lanes.length,
    activeLaneCount,
    terminalLaneCount,
    failedLaneCount: group.lanes.filter(({ status }) => status === "failed").length,
    openHighPriorityFindingIds: openHighPriorityFindingIds(group),
    laneSummaries: group.lanes.map((lane) => ({
      laneId: lane.id,
      roleName: lane.roleName,
      ordinal: lane.ordinal,
      status: lane.status,
      ...(lane.result === undefined ? {} : {
        summary: lane.result.summary,
        ...(lane.result.report === undefined ? {} : { report: lane.result.report }),
        ...(lane.result.checks === undefined ? {} : { checks: lane.result.checks }),
        ...(lane.result.findings === undefined ? {} : { findings: lane.result.findings }),
        ...(lane.result.evidence === undefined ? {} : { evidence: lane.result.evidence }),
        ...(lane.result.evidenceCommit === undefined ? {} : { evidenceCommit: lane.result.evidenceCommit }),
        ...(lane.result.gitSnapshot === undefined ? {} : { gitSnapshot: lane.result.gitSnapshot })
      }),
      ...(group.resolution === undefined
        || !group.resolution.selectedLaneIds.includes(lane.id)
        ? {}
        : { decision: group.resolution.decision })
    })),
    ...(group.resolution === undefined ? {} : { resolution: group.resolution })
  };
}

export function validateExecutionGroup(group: ExecutionGroup): ExecutionGroup {
  if (group.schemaVersion !== EXECUTION_GROUP_SCHEMA_VERSION) {
    throw new Error("ExecutionGroup must use schemaVersion 1.");
  }
  const taskId = requireIdentity(group.taskId, "Task id");
  requireIdentity(group.id, "ExecutionGroup id");
  validatePurpose(group.purpose);
  normalizeStrategy(group.strategy);
  validateExecutionTarget(group.target, taskId);
  if (!Array.isArray(group.lanes) || group.lanes.length === 0) {
    throw new Error("ExecutionGroup requires at least one Lane.");
  }
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  const roots = new Set<string>();
  for (const lane of group.lanes) {
    validateExecutionLane(lane, group);
    if (ids.has(lane.id)) throw new Error(`ExecutionLane is duplicated: ${lane.id}.`);
    if (ordinals.has(lane.ordinal)) throw new Error(`ExecutionLane ordinal is duplicated: ${lane.ordinal}.`);
    ids.add(lane.id);
    ordinals.add(lane.ordinal);
    if (lane.workspace !== undefined) {
      if (roots.has(lane.workspace.root) && lane.workspace.writableProjectIds.length > 0) {
        throw new Error(`Writable ExecutionLane workspace is shared: ${lane.workspace.root}.`);
      }
      if (lane.workspace.writableProjectIds.length > 0) roots.add(lane.workspace.root);
    }
  }
  const expectedMax = group.strategy.mode === "fixed" ? group.strategy.count : group.strategy.max;
  if (group.lanes.length > expectedMax) throw new Error("ExecutionGroup has too many Lanes.");
  if (group.resolution !== undefined) {
    if (group.lanes.some(({ status }) => !isTerminalLane(status))) {
      throw new Error(`Resolved ExecutionGroup has active Lanes: ${group.id}.`);
    }
    validateResolution(group.resolution, group);
  }
  requireTimestamp(group.createdAt, "ExecutionGroup createdAt");
  requireTimestamp(group.updatedAt, "ExecutionGroup updatedAt");
  return group;
}

export function validateExecutionLane(
  lane: ExecutionLane,
  group?: Pick<ExecutionGroup, "id" | "taskId" | "purpose">
): ExecutionLane {
  if (lane.schemaVersion !== EXECUTION_LANE_SCHEMA_VERSION) {
    throw new Error("ExecutionLane must use schemaVersion 1.");
  }
  requireIdentity(lane.id, "ExecutionLane id");
  requireIdentity(lane.groupId, "ExecutionGroup id");
  if (group !== undefined) {
    if (lane.groupId !== group.id) throw new Error(`ExecutionLane belongs to another Group: ${lane.id}.`);
    if (group.purpose === "review" && lane.reviewRoundId === undefined) {
      // A review lane may be pending before its ReviewRound is dispatched, but
      // it must acquire that identity before it can run.
      if (lane.status === "running" || lane.status === "completed" || lane.status === "failed") {
        throw new Error(`Running Reviewer Lane requires a ReviewRound: ${lane.id}.`);
      }
    }
  }
  positiveInteger(lane.ordinal, "ExecutionLane ordinal");
  requireIdentity(lane.roleName, "ExecutionLane Role");
  if (lane.effective !== undefined) validateEffectiveLaunchSnapshot(lane.effective);
  if (lane.runId !== undefined) requireIdentity(lane.runId, "Agent Run id");
  if (lane.sessionId !== undefined) requireIdentity(lane.sessionId, "Session id");
  if (lane.reviewRoundId !== undefined) requireIdentity(lane.reviewRoundId, "ReviewRound id");
  if (lane.workspace !== undefined) validateLaneWorkspace(lane.workspace);
  if (!( ["pending", "running", "yielded", "completed", "failed"] as const).includes(lane.status)) {
    throw new Error(`ExecutionLane status is invalid: ${String(lane.status)}.`);
  }
  if (lane.result !== undefined) validateLaneResult(lane.result);
  requireTimestamp(lane.createdAt, "ExecutionLane createdAt");
  requireTimestamp(lane.updatedAt, "ExecutionLane updatedAt");
  if (isTerminalLane(lane.status)) {
    requireTimestamp(lane.endedAt ?? "", "ExecutionLane endedAt");
    if (lane.result === undefined) throw new Error(`Terminal ExecutionLane requires a result: ${lane.id}.`);
  } else if (lane.endedAt !== undefined || lane.result !== undefined) {
    throw new Error(`Active ExecutionLane cannot have terminal output: ${lane.id}.`);
  }
  return lane;
}

function createLane(
  id: string,
  groupId: string,
  input: ExecutionLaneInput,
  ordinal: number,
  timestamp: string
): ExecutionLane {
  return validateExecutionLane({
    schemaVersion: EXECUTION_LANE_SCHEMA_VERSION,
    id: requireIdentity(id, "ExecutionLane id"),
    groupId: requireIdentity(groupId, "ExecutionGroup id"),
    ordinal: positiveInteger(input.ordinal ?? ordinal, "ExecutionLane ordinal"),
    roleName: requireIdentity(input.roleName, "ExecutionLane Role"),
    ...(input.effective === undefined ? {} : { effective: validateEffectiveLaunchSnapshot(input.effective) }),
    ...(input.runId === undefined ? {} : { runId: requireIdentity(input.runId, "Agent Run id") }),
    ...(input.sessionId === undefined ? {} : { sessionId: requireIdentity(input.sessionId, "Session id") }),
    ...(input.reviewRoundId === undefined ? {} : { reviewRoundId: requireIdentity(input.reviewRoundId, "ReviewRound id") }),
    ...(input.workspace === undefined ? {} : { workspace: validateLaneWorkspace(input.workspace) }),
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function validateExecutionTarget(target: ExecutionTarget, taskId: string): ExecutionTarget {
  if (target === null || typeof target !== "object" || target.schemaVersion !== 1) {
    throw new Error("ExecutionTarget must use schemaVersion 1.");
  }
  if (target.taskId !== taskId) throw new Error("ExecutionTarget belongs to another Task.");
  if (target.kind !== "work-item" && target.kind !== "task-final-review") {
    throw new Error(`ExecutionTarget kind is invalid: ${String(target.kind)}.`);
  }
  positiveInteger(target.revision, "ExecutionTarget revision");
  if (!Array.isArray(target.projects)) throw new Error("ExecutionTarget Projects are invalid.");
  const projects = new Set<string>();
  for (const project of target.projects) {
    const id = requireIdentity(project.projectId, "ExecutionTarget Project");
    if (projects.has(id)) throw new Error(`ExecutionTarget Project is duplicated: ${id}.`);
    projects.add(id);
    requireCommit(project.commit, "ExecutionTarget commit");
  }
  if (target.kind === "work-item" && target.workItemId === undefined) {
    throw new Error("WorkItem ExecutionTarget requires a Work Item id.");
  }
  if (target.workItemId !== undefined) requireIdentity(target.workItemId, "Work Item id");
  if (target.candidateId !== undefined) requireIdentity(target.candidateId, "Candidate id");
  if (target.contractDigest !== undefined) requireText(target.contractDigest, "Execution contract digest");
  requireText(target.fingerprint, "ExecutionTarget fingerprint");
  return target;
}

function validateLaneWorkspace(workspace: ExecutionLaneWorkspace): ExecutionLaneWorkspace {
  requireText(workspace.root, "ExecutionLane workspace root");
  if (!Array.isArray(workspace.writableProjectIds)) throw new Error("ExecutionLane workspace Projects are invalid.");
  const ids = workspace.writableProjectIds.map((id) => requireIdentity(id, "ExecutionLane writable Project"));
  if (new Set(ids).size !== ids.length) throw new Error("ExecutionLane writable Projects are duplicated.");
  return workspace;
}

function validateLaneResult(result: ExecutionLaneResult): ExecutionLaneResult {
  requireText(result.summary, "ExecutionLane summary");
  if (result.report !== undefined) requireText(result.report, "ExecutionLane report");
  if (result.checks !== undefined) {
    for (const check of result.checks) {
      requireText(check.name, "Execution check name");
      if (!["passed", "failed", "skipped"].includes(check.outcome)) throw new Error("Execution check outcome is invalid.");
      if (check.details !== undefined) requireText(check.details, "Execution check details");
    }
  }
  if (result.findings !== undefined) {
    const ids = new Set<string>();
    for (const finding of result.findings) {
      const id = requireIdentity(finding.id, "Execution finding id");
      if (ids.has(id)) throw new Error(`Execution finding is duplicated: ${id}.`);
      ids.add(id);
      if (!["low", "medium", "high", "critical"].includes(finding.severity)) throw new Error("Execution finding severity is invalid.");
      requireText(finding.summary, "Execution finding summary");
      if (finding.status !== "open" && finding.status !== "resolved") throw new Error("Execution finding status is invalid.");
    }
  }
  if (result.evidence !== undefined) result.evidence.forEach((value) => requireText(value, "Execution evidence"));
  if (result.evidenceCommit !== undefined) {
    requireCommit(result.evidenceCommit, "Execution evidence commit");
  }
  if (result.gitSnapshot !== undefined) validateExecutionLaneGitSnapshot(result.gitSnapshot);
  return result;
}

function validateExecutionLaneGitSnapshot(snapshot: ExecutionLaneGitSnapshot): ExecutionLaneGitSnapshot {
  if (snapshot === null || typeof snapshot !== "object" || snapshot.schemaVersion !== 1) {
    throw new Error("Execution Lane Git snapshot must use schemaVersion 1.");
  }
  if (!Array.isArray(snapshot.projects) || snapshot.projects.length === 0) {
    throw new Error("Execution Lane Git snapshot requires Projects.");
  }
  const ids = new Set<string>();
  for (const project of snapshot.projects) {
    const projectId = requireIdentity(project.projectId, "Execution Lane snapshot Project");
    if (ids.has(projectId)) throw new Error(`Execution Lane snapshot Project is duplicated: ${projectId}.`);
    ids.add(projectId);
    requireCommit(project.headCommit, "Execution Lane snapshot head commit");
    requireText(project.branch, "Execution Lane snapshot branch");
  }
  return snapshot;
}

function validateResolution(resolution: ExecutionResolution, group: ExecutionGroup): void {
  if (!["accept", "reject", "retry", "blocked"].includes(resolution.decision)) throw new Error("Execution resolution decision is invalid.");
  requireText(resolution.summary, "Execution resolution summary");
  const laneIds = new Set(group.lanes.map(({ id }) => id));
  if (new Set(resolution.selectedLaneIds).size !== resolution.selectedLaneIds.length
    || resolution.selectedLaneIds.some((id) => !laneIds.has(id))) {
    throw new Error("Execution resolution Lane selection is invalid.");
  }
  if (resolution.decision === "accept"
    && (resolution.selectedLaneIds.length === 0
      || resolution.selectedLaneIds.some((id) => {
        const lane = group.lanes.find((candidate) => candidate.id === id);
        return lane?.status !== "yielded" && lane?.status !== "completed";
      }))) {
    throw new Error("Execution accept resolution must select usable Lane output.");
  }
  requireTimestamp(resolution.decidedAt, "Execution resolution time");
  const findings = openHighPriorityFindingIds(group);
  if (!isDeepStrictEqual(
    [...resolution.unresolvedFindingIds].sort(),
    [...findings].sort()
  )) {
    throw new Error("Execution resolution findings do not match the unresolved high-priority findings.");
  }
  if (resolution.decision === "accept" && findings.length > 0) {
    throw new Error("Execution accept resolution cannot retain high-priority findings.");
  }
}

function assertExecutionLaneTransition(
  existing: ExecutionLane,
  candidate: ExecutionLane,
  groupId: string,
  groupPurpose: ExecutionPurpose
): void {
  if (existing.id !== candidate.id
    || existing.groupId !== candidate.groupId
    || existing.groupId !== groupId
    || existing.ordinal !== candidate.ordinal
    || existing.roleName !== candidate.roleName
    || existing.createdAt !== candidate.createdAt
    || existing.reviewRoundId !== candidate.reviewRoundId) {
    throw new Error(`ExecutionLane identity changed: ${existing.id}.`);
  }
  if (Date.parse(candidate.updatedAt) < Date.parse(existing.updatedAt)) {
    throw new Error(`ExecutionLane time moved backwards: ${existing.id}.`);
  }
  if (isTerminalLane(existing.status)) {
    if (isDeepStrictEqual(existing, candidate)) return;
    if (groupPurpose === "review"
      && candidate.status === "pending"
      && candidate.effective === undefined
      && candidate.runId === undefined
      && candidate.sessionId === undefined
      && candidate.result === undefined
      && candidate.endedAt === undefined
      && isDeepStrictEqual(existing.workspace, candidate.workspace)) {
      return;
    }
    if (candidate.status !== "running"
      || candidate.runId === undefined
      || candidate.runId === existing.runId) {
      throw new Error(`Terminal ExecutionLane is immutable without a fresh retry Run: ${existing.id}.`);
    }
    return;
  }
  if (existing.status === "running" && candidate.status === "pending") {
    throw new Error(`Running ExecutionLane cannot return to pending: ${existing.id}.`);
  }
  for (const key of ["effective", "runId", "sessionId", "workspace"] as const) {
    if (existing[key] !== undefined
      && !isDeepStrictEqual(existing[key], candidate[key])) {
      throw new Error(`ExecutionLane ${key} changed without retry: ${existing.id}.`);
    }
  }
}

function openHighPriorityFindingIds(group: ExecutionGroup): string[] {
  return group.lanes.flatMap((lane) => (lane.result?.findings ?? [])
    .filter((finding) => finding.status === "open" && (finding.severity === "high" || finding.severity === "critical"))
    .map(({ id }) => id));
}

function normalizeStrategy(strategy: ExecutionStrategy): ExecutionStrategy {
  if (strategy.mode === "fixed") {
    positiveInteger(strategy.count, "Fixed ExecutionGroup Lane count");
    return { mode: "fixed", count: strategy.count };
  }
  if (strategy.mode === "adaptive") {
    positiveInteger(strategy.max, "Adaptive ExecutionGroup Lane maximum");
    return { mode: "adaptive", max: strategy.max };
  }
  throw new Error(`Execution strategy is invalid: ${String((strategy as { mode?: unknown }).mode)}.`);
}

function validatePurpose(purpose: ExecutionPurpose): ExecutionPurpose {
  if (purpose !== "execution" && purpose !== "review") throw new Error(`Execution purpose is invalid: ${String(purpose)}.`);
  return purpose;
}

function isTerminalLane(status: ExecutionLaneStatus): boolean {
  return status === "yielded" || status === "completed" || status === "failed";
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function requireCommit(value: string, label: string): string {
  const commit = requireText(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) throw new Error(`${label} is invalid.`);
  return commit;
}
