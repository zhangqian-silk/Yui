import {
  normalizedUniqueText,
  requireIdentity,
  requireText,
  requireTimestamp
} from "../domain/validation.js";

type ChangeSetIdentity = Readonly<{
  id: string;
  taskId: string;
  projectId: string;
  baseCommit: string;
  headCommit: string;
  branch: string;
  changedPaths: readonly string[];
  createdAt: string;
}>;

export type WorkItemChangeSet = ChangeSetIdentity & Readonly<{
  schemaVersion: 2;
  workItemId: string;
}>;

export type ChangeSet = WorkItemChangeSet;

export type CreateWorkItemChangeSetInput = Readonly<
  Omit<WorkItemChangeSet, "schemaVersion" | "createdAt">
>;

export function createWorkItemChangeSet(
  input: CreateWorkItemChangeSetInput,
  now: Date
): WorkItemChangeSet {
  return validateChangeSet({
    schemaVersion: 2,
    ...input,
    changedPaths: [...input.changedPaths],
    createdAt: now.toISOString()
  });
}

export function validateChangeSet<T extends ChangeSet>(changeSet: T): T {
  if (changeSet.schemaVersion !== 2) throw new Error("ChangeSet must use schemaVersion 2.");
  requireIdentity(changeSet.workItemId, "Work Item id");
  requireIdentity(changeSet.id, "ChangeSet id");
  requireIdentity(changeSet.taskId, "Task id");
  requireIdentity(changeSet.projectId, "Project id");
  requireCommit(changeSet.baseCommit, "ChangeSet base commit");
  requireCommit(changeSet.headCommit, "ChangeSet head commit");
  if (changeSet.baseCommit === changeSet.headCommit) {
    throw new Error("ChangeSet must contain at least one commit.");
  }
  requireText(changeSet.branch, "ChangeSet branch");
  normalizedUniqueText(changeSet.changedPaths, "ChangeSet path");
  requireTimestamp(changeSet.createdAt, "ChangeSet createdAt");
  return changeSet;
}

function requireCommit(value: string, label: string): string {
  const normalized = requireText(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}
