import {
  normalizedUniqueText,
  requireIdentity,
  requireText,
  requireTimestamp
} from "../domain/validation.js";

export type ChangeSet = Readonly<{
  schemaVersion: 1;
  id: string;
  taskId: string;
  attemptId: string;
  projectId: string;
  baseCommit: string;
  headCommit: string;
  branch: string;
  changedPaths: readonly string[];
  createdAt: string;
}>;

export type CreateChangeSetInput = Readonly<Omit<ChangeSet, "schemaVersion" | "createdAt">>;

export function createChangeSet(input: CreateChangeSetInput, now: Date): ChangeSet {
  return validateChangeSet({
    schemaVersion: 1,
    ...input,
    changedPaths: [...input.changedPaths],
    createdAt: now.toISOString()
  });
}

export function validateChangeSet(changeSet: ChangeSet): ChangeSet {
  if (changeSet.schemaVersion !== 1) throw new Error("ChangeSet must use schemaVersion 1.");
  requireIdentity(changeSet.id, "ChangeSet id");
  requireIdentity(changeSet.taskId, "Task id");
  requireIdentity(changeSet.attemptId, "Execution Attempt id");
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
