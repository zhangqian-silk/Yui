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

export type WorkItemExecutionLaneDisposition = "open" | "succeeded" | "failed";

export type WorkItemExecutionLaneWorkspace = Readonly<{
  root: string;
  writableProjectIds: readonly string[];
}>;

/** A recoverable logical producer slot; immutable attempts live in Turn. */
export type WorkItemExecutionLane = Readonly<{
  schemaVersion: typeof WORK_ITEM_EXECUTION_LANE_SCHEMA_VERSION;
  id: string;
  groupId: string;
  ordinal: number;
  roleName: string;
  effective: EffectiveLaunchSnapshot;
  workspace: WorkItemExecutionLaneWorkspace;
  currentTurnId?: string;
  successfulTurnId?: string;
  disposition: WorkItemExecutionLaneDisposition;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}>;

export type WorkItemExecutionGroup = Readonly<{
  schemaVersion: typeof WORK_ITEM_EXECUTION_GROUP_SCHEMA_VERSION;
  id: string;
  taskId: string;
  assignment: WorkItemExecutionAssignment;
  lanes: readonly WorkItemExecutionLane[];
  createdAt: string;
  updatedAt: string;
}>;

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
    effective: EffectiveLaunchSnapshot;
  }>[];
}>;

export type WorkItemExecutionLaneInput = Readonly<{
  roleName: string;
  effective: EffectiveLaunchSnapshot;
  workspace: WorkItemExecutionLaneWorkspace;
  currentTurnId?: string;
}>;

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

export function createWorkItemExecutionGroup(
  id: string,
  taskId: string,
  assignment: WorkItemExecutionAssignment,
  laneInputs: readonly WorkItemExecutionLaneInput[],
  now: Date
): WorkItemExecutionGroup {
  if (laneInputs.length < 2) {
    throw new Error("A replicated WorkItem ExecutionGroup requires at least two Lanes.");
  }
  const groupId = requireIdentity(id, "ExecutionGroup id");
  const normalizedTaskId = requireIdentity(taskId, "Task id");
  const frozenAssignment = validateWorkItemExecutionAssignment(assignment);
  if (frozenAssignment.taskId !== normalizedTaskId) {
    throw new Error("ExecutionGroup Assignment belongs to another Task.");
  }
  const timestamp = now.toISOString();
  return validateWorkItemExecutionGroup({
    schemaVersion: WORK_ITEM_EXECUTION_GROUP_SCHEMA_VERSION,
    id: groupId,
    taskId: normalizedTaskId,
    assignment: frozenAssignment,
    lanes: laneInputs.map((lane, index) => ({
      schemaVersion: WORK_ITEM_EXECUTION_LANE_SCHEMA_VERSION,
      id: `${groupId}-lane-${index + 1}`,
      groupId,
      ordinal: index + 1,
      roleName: lane.roleName,
      effective: lane.effective,
      workspace: lane.workspace,
      ...(lane.currentTurnId === undefined ? {} : { currentTurnId: lane.currentTurnId }),
      disposition: "open" as const,
      createdAt: timestamp,
      updatedAt: timestamp
    })),
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function updateWorkItemExecutionLane(
  group: WorkItemExecutionGroup,
  laneId: string,
  patch: Readonly<{
    currentTurnId?: string;
    successfulTurnId?: string;
    disposition?: WorkItemExecutionLaneDisposition;
  }>,
  now: Date
): WorkItemExecutionGroup {
  validateWorkItemExecutionGroup(group);
  const index = group.lanes.findIndex(({ id }) => id === laneId);
  if (index < 0) throw new Error(`ExecutionGroup Lane not found: ${laneId}.`);
  const current = group.lanes[index]!;
  if (current.disposition !== "open") {
    throw new Error(`Terminal ExecutionLane is immutable: ${laneId}.`);
  }
  const disposition = patch.disposition ?? current.disposition;
  const currentTurnId = patch.currentTurnId ?? current.currentTurnId;
  const successfulTurnId = patch.successfulTurnId ?? current.successfulTurnId;
  if (disposition === "succeeded") {
    if (successfulTurnId === undefined || successfulTurnId !== currentTurnId) {
      throw new Error("A succeeded Lane must identify its current successful Turn.");
    }
  } else if (successfulTurnId !== undefined) {
    throw new Error("Only a succeeded Lane may identify a successful Turn.");
  }
  const timestamp = now.toISOString();
  const updated: WorkItemExecutionLane = {
    ...current,
    ...(currentTurnId === undefined ? {} : { currentTurnId }),
    ...(successfulTurnId === undefined ? {} : { successfulTurnId }),
    disposition,
    updatedAt: timestamp,
    ...(disposition === "open" ? {} : { endedAt: timestamp })
  };
  const candidate = validateWorkItemExecutionGroup({
    ...group,
    lanes: group.lanes.map((lane, laneIndex) => laneIndex === index ? updated : lane),
    updatedAt: timestamp
  });
  assertWorkItemExecutionGroupTransition(group, candidate);
  return candidate;
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

export function validateWorkItemExecutionGroup(
  group: WorkItemExecutionGroup
): WorkItemExecutionGroup {
  rejectUnknownFields(group as unknown as Record<string, unknown>, [
    "schemaVersion",
    "id",
    "taskId",
    "assignment",
    "lanes",
    "createdAt",
    "updatedAt"
  ], "WorkItem ExecutionGroup");
  if (group.schemaVersion !== WORK_ITEM_EXECUTION_GROUP_SCHEMA_VERSION) {
    throw new Error("WorkItem ExecutionGroup schemaVersion is invalid.");
  }
  requireIdentity(group.id, "ExecutionGroup id");
  requireIdentity(group.taskId, "ExecutionGroup Task id");
  const assignment = validateWorkItemExecutionAssignment(group.assignment);
  if (assignment.taskId !== group.taskId) {
    throw new Error("ExecutionGroup Assignment Task does not match its Group.");
  }
  if (!Array.isArray(group.lanes) || group.lanes.length < 2) {
    throw new Error("A replicated WorkItem ExecutionGroup requires at least two Lanes.");
  }
  const ids = new Set<string>();
  const roles = new Set<string>();
  const assignmentProjectIds = assignment.projects.map(({ projectId }) => projectId).sort();
  group.lanes.forEach((lane, index) => {
    validateWorkItemExecutionLane(lane, group.id, index + 1);
    if (!isDeepStrictEqual(
      [...lane.workspace.writableProjectIds].sort(),
      assignmentProjectIds
    ) || !isDeepStrictEqual(
      [...lane.effective.writeProjectIds].sort(),
      assignmentProjectIds
    )) {
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

export function assertWorkItemExecutionGroupTransition(
  existing: WorkItemExecutionGroup,
  candidate: WorkItemExecutionGroup
): void {
  validateWorkItemExecutionGroup(existing);
  validateWorkItemExecutionGroup(candidate);
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
    if (lane.id !== next.id
      || lane.groupId !== next.groupId
      || lane.ordinal !== next.ordinal
      || lane.roleName !== next.roleName
      || lane.createdAt !== next.createdAt
      || !isDeepStrictEqual(lane.effective, next.effective)
      || !isDeepStrictEqual(lane.workspace, next.workspace)) {
      throw new Error(`ExecutionLane identity changed: ${lane.id}.`);
    }
    if (lane.disposition !== "open" && !isDeepStrictEqual(lane, next)) {
      throw new Error(`Terminal ExecutionLane is immutable: ${lane.id}.`);
    }
  });
}

export function workItemExecutionGroupSettled(group: WorkItemExecutionGroup): boolean {
  validateWorkItemExecutionGroup(group);
  return group.lanes.every(({ disposition }) => disposition !== "open");
}

export function summarizeWorkItemExecutionGroup(
  group: WorkItemExecutionGroup
): WorkItemExecutionGroupSummary {
  validateWorkItemExecutionGroup(group);
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
      effective: lane.effective
    }))
  };
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
