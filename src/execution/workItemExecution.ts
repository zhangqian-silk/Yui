import { isDeepStrictEqual } from "node:util";

import {
  normalizedUniqueIdentities,
  normalizedUniqueText,
  requireIdentity,
  requirePositiveInteger,
  requireText,
  requireTimestamp
} from "../domain/validation.js";
import {
  validateContextSnapshotRef,
  type ContextSnapshotRef
} from "../context/contextSnapshot.js";
import {
  validateEffectiveLaunchSnapshot,
  type EffectiveLaunchSnapshot
} from "../executor/effectiveLaunch.js";

export const WORK_ITEM_EXECUTION_GROUP_SCHEMA_VERSION = 2 as const;
export const WORK_ITEM_EXECUTION_LANE_SCHEMA_VERSION = 2 as const;
export const WORK_ITEM_EXECUTION_ASSIGNMENT_SCHEMA_VERSION = 1 as const;
export const MINIMUM_WORK_ITEM_SYNTHESIS_RESULTS = 2;
export const EXECUTION_GROUP_SCHEMA_VERSION = WORK_ITEM_EXECUTION_GROUP_SCHEMA_VERSION;
export const EXECUTION_LANE_SCHEMA_VERSION = WORK_ITEM_EXECUTION_LANE_SCHEMA_VERSION;
export const EXECUTION_ASSIGNMENT_SCHEMA_VERSION = WORK_ITEM_EXECUTION_ASSIGNMENT_SCHEMA_VERSION;
export const MINIMUM_SYNTHESIS_RESULTS = MINIMUM_WORK_ITEM_SYNTHESIS_RESULTS;

export type WorkItemExecutionProjectBase = Readonly<{
  projectId: string;
  baseCommit: string;
}>;

export type WorkItemExecutionDependencyFact = Readonly<{
  workItemId: string;
  revision: number;
}>;

/**
 * The one immutable semantic input shared by every producer Lane in a Group.
 * Runtime wrappers may differ, but no Lane can override any Assignment fact.
 */
export type WorkItemExecutionAssignment = Readonly<{
  schemaVersion: typeof WORK_ITEM_EXECUTION_ASSIGNMENT_SCHEMA_VERSION;
  input: string;
  objective: string;
  acceptance: readonly string[];
  contextSnapshotRef: ContextSnapshotRef;
  taskId: string;
  workItemId: string;
  workItemRevision: number;
  projects: readonly WorkItemExecutionProjectBase[];
  dependencyFacts: readonly WorkItemExecutionDependencyFact[];
}>;

/** The immutable Review target shared by every replicated producer. */
export type ReviewExecutionAssignment = Readonly<{
  schemaVersion: typeof EXECUTION_ASSIGNMENT_SCHEMA_VERSION;
  input: string;
  objective: string;
  acceptance: readonly string[];
  contextSnapshotRef: ContextSnapshotRef;
  taskId: string;
  reviewRoundId: string;
  reviewBaseCommit: string;
  scope: "work-item" | "task";
  workItemId?: string;
  candidateId?: string;
  projects: readonly WorkItemExecutionProjectBase[];
}>;

export type ExecutionAssignment =
  | WorkItemExecutionAssignment
  | ReviewExecutionAssignment;

export type WorkItemExecutionLaneDisposition = "open" | "succeeded" | "failed";
export type ExecutionLaneDisposition = WorkItemExecutionLaneDisposition;

export type WorkItemExecutionLaneWorkspace = Readonly<{
  root: string;
  writableProjectIds: readonly string[];
}>;
export type ExecutionLaneWorkspace = WorkItemExecutionLaneWorkspace;

/** A recoverable logical producer slot; immutable attempts live in Turn. */
export type ExecutionLane = Readonly<{
  schemaVersion: typeof WORK_ITEM_EXECUTION_LANE_SCHEMA_VERSION;
  id: string;
  groupId: string;
  ordinal: number;
  roleName: string;
  effective?: EffectiveLaunchSnapshot;
  workspace?: WorkItemExecutionLaneWorkspace;
  currentTurnId?: string;
  successfulTurnId?: string;
  disposition: WorkItemExecutionLaneDisposition;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}>;
export type WorkItemExecutionLane = ExecutionLane & Readonly<{
  effective: EffectiveLaunchSnapshot;
  workspace: WorkItemExecutionLaneWorkspace;
}>;

export type ExecutionGroup<
  Assignment extends ExecutionAssignment = ExecutionAssignment,
  Lane extends ExecutionLane = ExecutionLane
> = Readonly<{
  schemaVersion: typeof WORK_ITEM_EXECUTION_GROUP_SCHEMA_VERSION;
  id: string;
  taskId: string;
  assignment: Assignment;
  lanes: readonly Lane[];
  createdAt: string;
  updatedAt: string;
}>;
export type WorkItemExecutionGroup =
  ExecutionGroup<WorkItemExecutionAssignment, WorkItemExecutionLane>;
export type ReviewExecutionGroup = ExecutionGroup<ReviewExecutionAssignment>;

export type WorkItemExecutionGroupSummary = Readonly<{
  groupId: string;
  kind: "replicated";
  laneCount: number;
  openLaneCount: number;
  succeededLaneCount: number;
  failedLaneCount: number;
  laneSummaries: readonly Readonly<{
    laneId: string;
    roleName: string;
    ordinal: number;
    disposition: WorkItemExecutionLaneDisposition;
    currentTurnId?: string;
    successfulTurnId?: string;
    effective?: EffectiveLaunchSnapshot;
  }>[];
}>;
export type ExecutionGroupSummary = WorkItemExecutionGroupSummary;

export type WorkItemExecutionLaneInput = Readonly<{
  roleName: string;
  effective?: EffectiveLaunchSnapshot;
  workspace?: WorkItemExecutionLaneWorkspace;
  currentTurnId?: string;
}>;
export type ExecutionLaneInput = WorkItemExecutionLaneInput;

export function createWorkItemExecutionAssignment(input: Readonly<{
  input: string;
  objective: string;
  acceptance: readonly string[];
  contextSnapshotRef: ContextSnapshotRef;
  taskId: string;
  workItemId: string;
  workItemRevision: number;
  projects: readonly WorkItemExecutionProjectBase[];
  dependencyFacts: readonly WorkItemExecutionDependencyFact[];
}>): WorkItemExecutionAssignment {
  return validateWorkItemExecutionAssignment({
    schemaVersion: WORK_ITEM_EXECUTION_ASSIGNMENT_SCHEMA_VERSION,
    ...input
  });
}

export function createReviewExecutionAssignment(input: Readonly<{
  input: string;
  objective: string;
  acceptance: readonly string[];
  contextSnapshotRef: ContextSnapshotRef;
  taskId: string;
  reviewRoundId: string;
  reviewBaseCommit: string;
  scope: "work-item" | "task";
  workItemId?: string;
  candidateId?: string;
  projects: readonly WorkItemExecutionProjectBase[];
}>): ReviewExecutionAssignment {
  return validateReviewExecutionAssignment({
    schemaVersion: EXECUTION_ASSIGNMENT_SCHEMA_VERSION,
    ...input
  });
}

export function createExecutionGroup<Assignment extends ExecutionAssignment>(
  id: string,
  taskId: string,
  assignment: Assignment,
  laneInputs: readonly ExecutionLaneInput[],
  now: Date
): ExecutionGroup<Assignment> {
  if (laneInputs.length < MINIMUM_SYNTHESIS_RESULTS) {
    throw new Error("A replicated ExecutionGroup requires at least two Lanes.");
  }
  const groupId = requireIdentity(id, "ExecutionGroup id");
  const normalizedTaskId = requireIdentity(taskId, "Task id");
  const frozenAssignment = validateExecutionAssignment(assignment) as Assignment;
  if (frozenAssignment.taskId !== normalizedTaskId) {
    throw new Error("ExecutionGroup Assignment belongs to another Task.");
  }
  const timestamp = now.toISOString();
  return validateExecutionGroup({
    schemaVersion: EXECUTION_GROUP_SCHEMA_VERSION,
    id: groupId,
    taskId: normalizedTaskId,
    assignment: frozenAssignment,
    lanes: laneInputs.map((lane, index) => ({
      schemaVersion: EXECUTION_LANE_SCHEMA_VERSION,
      id: `${groupId}-lane-${index + 1}`,
      groupId,
      ordinal: index + 1,
      roleName: lane.roleName,
      ...(lane.effective === undefined ? {} : { effective: lane.effective }),
      ...(lane.workspace === undefined ? {} : { workspace: lane.workspace }),
      ...(lane.currentTurnId === undefined ? {} : { currentTurnId: lane.currentTurnId }),
      disposition: "open" as const,
      createdAt: timestamp,
      updatedAt: timestamp
    })),
    createdAt: timestamp,
    updatedAt: timestamp
  }) as ExecutionGroup<Assignment>;
}

export function createWorkItemExecutionGroup(
  id: string,
  taskId: string,
  assignment: WorkItemExecutionAssignment,
  laneInputs: readonly WorkItemExecutionLaneInput[],
  now: Date
): WorkItemExecutionGroup {
  const group = createExecutionGroup(id, taskId, assignment, laneInputs, now);
  return validateWorkItemExecutionGroup(group as WorkItemExecutionGroup);
}

export function updateExecutionLane<Assignment extends ExecutionAssignment>(
  group: ExecutionGroup<Assignment>,
  laneId: string,
  patch: Readonly<{
    currentTurnId?: string;
    successfulTurnId?: string;
    disposition?: ExecutionLaneDisposition;
    effective?: EffectiveLaunchSnapshot;
    workspace?: ExecutionLaneWorkspace;
  }>,
  now: Date
): ExecutionGroup<Assignment> {
  validateExecutionGroup(group);
  const index = group.lanes.findIndex(({ id }) => id === laneId);
  if (index < 0) throw new Error(`ExecutionGroup Lane not found: ${laneId}.`);
  const current = group.lanes[index]!;
  if (current.disposition !== "open") {
    throw new Error(`Terminal ExecutionLane is immutable: ${laneId}.`);
  }
  const disposition = patch.disposition ?? current.disposition;
  const currentTurnId = patch.currentTurnId ?? current.currentTurnId;
  const successfulTurnId = patch.successfulTurnId ?? current.successfulTurnId;
  const effective = patch.effective ?? current.effective;
  const workspace = patch.workspace ?? current.workspace;
  if ((effective === undefined) !== (workspace === undefined)) {
    throw new Error("ExecutionLane launch facts are incomplete.");
  }
  if (disposition === "succeeded") {
    if (successfulTurnId === undefined || successfulTurnId !== currentTurnId) {
      throw new Error("A succeeded Lane must identify its current successful Turn.");
    }
  } else if (successfulTurnId !== undefined) {
    throw new Error("Only a succeeded Lane may identify a successful Turn.");
  }
  const timestamp = now.toISOString();
  const updated: ExecutionLane = {
    ...current,
    ...(effective === undefined ? {} : { effective }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(currentTurnId === undefined ? {} : { currentTurnId }),
    ...(successfulTurnId === undefined ? {} : { successfulTurnId }),
    disposition,
    updatedAt: timestamp,
    ...(disposition === "open" ? {} : { endedAt: timestamp })
  };
  const candidate = validateExecutionGroup({
    ...group,
    lanes: group.lanes.map((lane, laneIndex) => laneIndex === index ? updated : lane),
    updatedAt: timestamp
  }) as ExecutionGroup<Assignment>;
  assertExecutionGroupTransition(group, candidate);
  return candidate;
}

export function updateWorkItemExecutionLane(
  group: WorkItemExecutionGroup,
  laneId: string,
  patch: Readonly<{
    currentTurnId?: string;
    successfulTurnId?: string;
    disposition?: WorkItemExecutionLaneDisposition;
    effective?: EffectiveLaunchSnapshot;
    workspace?: WorkItemExecutionLaneWorkspace;
  }>,
  now: Date
): WorkItemExecutionGroup {
  return validateWorkItemExecutionGroup(
    updateExecutionLane(group, laneId, patch, now) as WorkItemExecutionGroup
  );
}

/**
 * Reopen only failed Lanes for an explicit retry of the same semantic
 * execution. Successful results remain settled, while each failed Lane
 * returns to the same state produced by a naturally failed Turn: open and
 * still pointing at the failed attempt that dispatch must replace.
 *
 * This is the sole terminal-to-open Lane transition. Normal Lane updates keep
 * terminal records immutable.
 */
export function retryFailedExecutionLanes<Assignment extends ExecutionAssignment>(
  group: ExecutionGroup<Assignment>,
  now: Date
): ExecutionGroup<Assignment> {
  validateExecutionGroup(group);
  if (!group.lanes.some(({ disposition }) => disposition === "failed")) return group;
  const timestamp = now.toISOString();
  return validateExecutionGroup({
    ...group,
    lanes: group.lanes.map((lane) => {
      if (lane.disposition !== "failed") return lane;
      const { endedAt: _endedAt, ...retryable } = lane;
      return {
        ...retryable,
        disposition: "open" as const,
        updatedAt: timestamp
      };
    }),
    updatedAt: timestamp
  }) as ExecutionGroup<Assignment>;
}

export function validateWorkItemExecutionAssignment(
  assignment: WorkItemExecutionAssignment
): WorkItemExecutionAssignment {
  rejectUnknownFields(assignment as unknown as Record<string, unknown>, [
    "schemaVersion",
    "input",
    "objective",
    "acceptance",
    "contextSnapshotRef",
    "taskId",
    "workItemId",
    "workItemRevision",
    "projects",
    "dependencyFacts"
  ], "WorkItem ExecutionAssignment");
  if (assignment.schemaVersion !== WORK_ITEM_EXECUTION_ASSIGNMENT_SCHEMA_VERSION) {
    throw new Error("WorkItem ExecutionAssignment schemaVersion is invalid.");
  }
  requireText(assignment.input, "ExecutionAssignment input");
  requireText(assignment.objective, "ExecutionAssignment objective");
  normalizedUniqueText(assignment.acceptance, "ExecutionAssignment acceptance criterion");
  validateContextSnapshotRef(assignment.contextSnapshotRef);
  requireIdentity(assignment.taskId, "ExecutionAssignment Task id");
  requireIdentity(assignment.workItemId, "ExecutionAssignment WorkItem id");
  requirePositiveInteger(assignment.workItemRevision, "ExecutionAssignment WorkItem revision");
  if (!Array.isArray(assignment.projects)) {
    throw new Error("ExecutionAssignment projects are invalid.");
  }
  const projectIds = assignment.projects.map((project) => {
    rejectUnknownFields(project as unknown as Record<string, unknown>, [
      "projectId",
      "baseCommit"
    ], "ExecutionAssignment Project base");
    const { projectId, baseCommit } = project;
    requireIdentity(projectId, "ExecutionAssignment Project id");
    requireCommit(baseCommit, "ExecutionAssignment Project base commit");
    return projectId;
  });
  normalizedUniqueIdentities(projectIds, "ExecutionAssignment Project");
  if (!Array.isArray(assignment.dependencyFacts)) {
    throw new Error("ExecutionAssignment dependency facts are invalid.");
  }
  const dependencyIds = assignment.dependencyFacts.map((dependency) => {
    rejectUnknownFields(dependency as unknown as Record<string, unknown>, [
      "workItemId",
      "revision"
    ], "ExecutionAssignment dependency fact");
    const { workItemId, revision } = dependency;
    requireIdentity(workItemId, "ExecutionAssignment dependency WorkItem id");
    requirePositiveInteger(revision, "ExecutionAssignment dependency revision");
    return workItemId;
  });
  normalizedUniqueIdentities(dependencyIds, "ExecutionAssignment dependency WorkItem");
  return assignment;
}

export function validateReviewExecutionAssignment(
  assignment: ReviewExecutionAssignment
): ReviewExecutionAssignment {
  rejectUnknownFields(assignment as unknown as Record<string, unknown>, [
    "schemaVersion",
    "input",
    "objective",
    "acceptance",
    "contextSnapshotRef",
    "taskId",
    "reviewRoundId",
    "reviewBaseCommit",
    "scope",
    "workItemId",
    "candidateId",
    "projects"
  ], "Review ExecutionAssignment");
  if (assignment.schemaVersion !== EXECUTION_ASSIGNMENT_SCHEMA_VERSION) {
    throw new Error("Review ExecutionAssignment schemaVersion is invalid.");
  }
  requireText(assignment.input, "ExecutionAssignment input");
  requireText(assignment.objective, "ExecutionAssignment objective");
  normalizedUniqueText(assignment.acceptance, "ExecutionAssignment acceptance criterion");
  validateContextSnapshotRef(assignment.contextSnapshotRef);
  requireIdentity(assignment.taskId, "ExecutionAssignment Task id");
  requireIdentity(assignment.reviewRoundId, "ExecutionAssignment ReviewRound id");
  requireCommit(assignment.reviewBaseCommit, "ExecutionAssignment Review base commit");
  if (assignment.scope !== "work-item" && assignment.scope !== "task") {
    throw new Error("Review ExecutionAssignment scope is invalid.");
  }
  if (assignment.scope === "work-item") {
    requireIdentity(assignment.workItemId ?? "", "ExecutionAssignment WorkItem id");
    requireIdentity(assignment.candidateId ?? "", "ExecutionAssignment Candidate id");
  } else if (assignment.workItemId !== undefined || assignment.candidateId !== undefined) {
    throw new Error("A Task Review ExecutionAssignment cannot identify a WorkItem Candidate.");
  }
  validateExecutionProjects(assignment.projects);
  return assignment;
}

export function validateExecutionAssignment(
  assignment: ExecutionAssignment
): ExecutionAssignment {
  return "reviewRoundId" in assignment
    ? validateReviewExecutionAssignment(assignment)
    : validateWorkItemExecutionAssignment(assignment);
}

export function validateExecutionGroup(
  group: ExecutionGroup
): ExecutionGroup {
  rejectUnknownFields(group as unknown as Record<string, unknown>, [
    "schemaVersion",
    "id",
    "taskId",
    "assignment",
    "lanes",
    "createdAt",
    "updatedAt"
  ], "ExecutionGroup");
  if (group.schemaVersion !== EXECUTION_GROUP_SCHEMA_VERSION) {
    throw new Error("ExecutionGroup schemaVersion is invalid.");
  }
  requireIdentity(group.id, "ExecutionGroup id");
  requireIdentity(group.taskId, "ExecutionGroup Task id");
  const assignment = validateExecutionAssignment(group.assignment);
  if (assignment.taskId !== group.taskId) {
    throw new Error("ExecutionGroup Assignment Task does not match its Group.");
  }
  if (!Array.isArray(group.lanes) || group.lanes.length < MINIMUM_SYNTHESIS_RESULTS) {
    throw new Error("A replicated ExecutionGroup requires at least two Lanes.");
  }
  const ids = new Set<string>();
  const roles = new Set<string>();
  const assignmentProjectIds = assignment.projects.map(({ projectId }) => projectId).sort();
  group.lanes.forEach((lane, index) => {
    validateWorkItemExecutionLane(lane, group.id, index + 1);
    if (lane.workspace !== undefined && (!isDeepStrictEqual(
      [...lane.workspace.writableProjectIds].sort(),
      assignmentProjectIds
    ) || !isDeepStrictEqual(
      [...lane.effective!.writeProjectIds].sort(),
      assignmentProjectIds
    ))) {
      throw new Error(`ExecutionLane Project scope differs from its Assignment: ${lane.id}.`);
    }
    if (ids.has(lane.id)) throw new Error(`ExecutionGroup Lane is duplicated: ${lane.id}.`);
    if (roles.has(lane.roleName)) {
      throw new Error(`ExecutionGroup Lane Role is duplicated: ${lane.roleName}.`);
    }
    ids.add(lane.id);
    roles.add(lane.roleName);
  });
  requireTimestamp(group.createdAt, "ExecutionGroup createdAt");
  requireTimestamp(group.updatedAt, "ExecutionGroup updatedAt");
  if (Date.parse(group.updatedAt) < Date.parse(group.createdAt)) {
    throw new Error("ExecutionGroup updatedAt precedes createdAt.");
  }
  return group;
}

export function validateWorkItemExecutionGroup(
  group: WorkItemExecutionGroup
): WorkItemExecutionGroup {
  validateExecutionGroup(group);
  validateWorkItemExecutionAssignment(group.assignment);
  if (group.lanes.some(({ effective, workspace }) => (
    effective === undefined || workspace === undefined
  ))) {
    throw new Error("A WorkItem ExecutionGroup requires prepared Lane launch facts.");
  }
  return group;
}

export function assertWorkItemExecutionGroupTransition(
  existing: WorkItemExecutionGroup,
  candidate: WorkItemExecutionGroup
): void {
  validateWorkItemExecutionGroup(existing);
  validateWorkItemExecutionGroup(candidate);
  assertExecutionGroupTransition(existing, candidate);
}

export function assertExecutionGroupTransition(
  existing: ExecutionGroup,
  candidate: ExecutionGroup
): void {
  validateExecutionGroup(existing);
  validateExecutionGroup(candidate);
  if (isDeepStrictEqual(existing, candidate)) return;
  if (existing.id !== candidate.id
    || existing.taskId !== candidate.taskId
    || existing.createdAt !== candidate.createdAt
    || !isDeepStrictEqual(existing.assignment, candidate.assignment)
    || existing.lanes.length !== candidate.lanes.length) {
    throw new Error(`ExecutionGroup identity or Assignment changed: ${existing.id}.`);
  }
  if (Date.parse(candidate.updatedAt) < Date.parse(existing.updatedAt)) {
    throw new Error(`ExecutionGroup time moved backwards: ${existing.id}.`);
  }
  existing.lanes.forEach((lane, index) => {
    const next = candidate.lanes[index]!;
    const launchFactsChanged = lane.effective === undefined
      ? (next.effective === undefined) !== (next.workspace === undefined)
      : !isDeepStrictEqual(lane.effective, next.effective)
        || !isDeepStrictEqual(lane.workspace, next.workspace);
    if (lane.id !== next.id
      || lane.groupId !== next.groupId
      || lane.ordinal !== next.ordinal
      || lane.roleName !== next.roleName
      || lane.createdAt !== next.createdAt
      || launchFactsChanged) {
      throw new Error(`ExecutionLane identity changed: ${lane.id}.`);
    }
    if (lane.disposition !== "open" && !isDeepStrictEqual(lane, next)) {
      throw new Error(`Terminal ExecutionLane is immutable: ${lane.id}.`);
    }
  });
}

export function workItemExecutionGroupSettled(group: WorkItemExecutionGroup): boolean {
  validateWorkItemExecutionGroup(group);
  return executionGroupSettled(group);
}

export function executionGroupSettled(group: ExecutionGroup): boolean {
  validateExecutionGroup(group);
  return group.lanes.every(({ disposition }) => disposition !== "open");
}

export function summarizeWorkItemExecutionGroup(
  group: WorkItemExecutionGroup
): WorkItemExecutionGroupSummary {
  validateWorkItemExecutionGroup(group);
  return summarizeExecutionGroup(group);
}

export function summarizeExecutionGroup(
  group: ExecutionGroup
): ExecutionGroupSummary {
  validateExecutionGroup(group);
  return {
    groupId: group.id,
    kind: "replicated",
    laneCount: group.lanes.length,
    openLaneCount: group.lanes.filter(({ disposition }) => disposition === "open").length,
    succeededLaneCount: group.lanes.filter(({ disposition }) => disposition === "succeeded").length,
    failedLaneCount: group.lanes.filter(({ disposition }) => disposition === "failed").length,
    laneSummaries: group.lanes.map((lane) => ({
      laneId: lane.id,
      roleName: lane.roleName,
      ordinal: lane.ordinal,
      disposition: lane.disposition,
      ...(lane.currentTurnId === undefined ? {} : { currentTurnId: lane.currentTurnId }),
      ...(lane.successfulTurnId === undefined ? {} : { successfulTurnId: lane.successfulTurnId }),
      ...(lane.effective === undefined ? {} : { effective: lane.effective })
    }))
  };
}

function validateExecutionProjects(
  projects: readonly WorkItemExecutionProjectBase[]
): readonly WorkItemExecutionProjectBase[] {
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error("ExecutionAssignment projects are invalid.");
  }
  const projectIds = projects.map((project) => {
    rejectUnknownFields(project as unknown as Record<string, unknown>, [
      "projectId",
      "baseCommit"
    ], "ExecutionAssignment Project base");
    const { projectId, baseCommit } = project;
    requireIdentity(projectId, "ExecutionAssignment Project id");
    requireCommit(baseCommit, "ExecutionAssignment Project base commit");
    return projectId;
  });
  normalizedUniqueIdentities(projectIds, "ExecutionAssignment Project");
  return projects;
}

function validateWorkItemExecutionLane(
  lane: WorkItemExecutionLane,
  groupId: string,
  ordinal: number
): void {
  rejectUnknownFields(lane as unknown as Record<string, unknown>, [
    "schemaVersion",
    "id",
    "groupId",
    "ordinal",
    "roleName",
    "effective",
    "workspace",
    "currentTurnId",
    "successfulTurnId",
    "disposition",
    "createdAt",
    "updatedAt",
    "endedAt"
  ], "WorkItem ExecutionLane");
  if (lane.schemaVersion !== WORK_ITEM_EXECUTION_LANE_SCHEMA_VERSION) {
    throw new Error("WorkItem ExecutionLane schemaVersion is invalid.");
  }
  requireIdentity(lane.id, "ExecutionLane id");
  if (lane.groupId !== groupId) throw new Error("ExecutionLane Group does not match.");
  if (lane.ordinal !== ordinal) throw new Error("ExecutionLane ordinal is invalid.");
  requireIdentity(lane.roleName, "ExecutionLane Role name");
  if ((lane.effective === undefined) !== (lane.workspace === undefined)) {
    throw new Error("ExecutionLane launch facts are incomplete.");
  }
  if (lane.effective !== undefined && lane.workspace !== undefined) {
    validateEffectiveLaunchSnapshot(lane.effective);
    rejectUnknownFields(lane.workspace as unknown as Record<string, unknown>, [
      "root",
      "writableProjectIds"
    ], "ExecutionLane workspace");
    requireText(lane.workspace.root, "ExecutionLane workspace root");
    normalizedUniqueIdentities(
      lane.workspace.writableProjectIds,
      "ExecutionLane writable Project"
    );
  }
  if (lane.currentTurnId !== undefined && lane.effective === undefined) {
    throw new Error("A dispatched ExecutionLane requires launch facts.");
  }
  if (lane.currentTurnId !== undefined) requireIdentity(lane.currentTurnId, "ExecutionLane current Turn id");
  if (lane.successfulTurnId !== undefined) requireIdentity(lane.successfulTurnId, "ExecutionLane successful Turn id");
  if (!["open", "succeeded", "failed"].includes(lane.disposition)) {
    throw new Error(`ExecutionLane disposition is invalid: ${String(lane.disposition)}.`);
  }
  if (lane.disposition === "succeeded") {
    if (lane.currentTurnId === undefined || lane.successfulTurnId !== lane.currentTurnId) {
      throw new Error("A succeeded Lane must identify its current successful Turn.");
    }
  } else if (lane.successfulTurnId !== undefined) {
    throw new Error("Only a succeeded Lane may identify a successful Turn.");
  }
  requireTimestamp(lane.createdAt, "ExecutionLane createdAt");
  requireTimestamp(lane.updatedAt, "ExecutionLane updatedAt");
  if (lane.disposition === "open") {
    if (lane.endedAt !== undefined) throw new Error("An open ExecutionLane cannot have endedAt.");
  } else {
    requireTimestamp(lane.endedAt ?? "", "ExecutionLane endedAt");
  }
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}.`);
}

function requireCommit(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (!/^[0-9a-f]{40}$/u.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}
