import {
  normalizedUniqueText,
  requireIdentity,
  requireText,
  requireTimestamp
} from "../domain/validation.js";
import { validateTaskRecordReference } from "../task/taskRecordReference.js";
import {
  validateChangeSetManifest,
  type ChangeSetManifest
} from "./changeSetManifest.js";

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
  schemaVersion: 3;
  workItemId: string;
  /**
   * Optional integration manifest.  ChangeSets written by older Yui releases
   * have none and still integrate; overlap diagnostics degrade to path-only
   * analysis for them.
   */
  manifest?: ChangeSetManifest;
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
    schemaVersion: 3,
    ...input,
    changedPaths: [...input.changedPaths],
    ...(input.manifest === undefined
      ? {}
      : { manifest: validateChangeSetManifest(input.manifest) }),
    createdAt: now.toISOString()
  });
}

export function validateChangeSet<T extends ChangeSet>(changeSet: T): T {
  if (changeSet.schemaVersion !== 3) throw new Error("ChangeSet must use schemaVersion 3.");
  validateTaskRecordReference({ taskId: changeSet.taskId, localId: changeSet.id }, "changeSet");
  validateTaskRecordReference({
    taskId: changeSet.taskId,
    localId: changeSet.workItemId
  }, "workItem");
  requireIdentity(changeSet.projectId, "Project id");
  requireCommit(changeSet.baseCommit, "ChangeSet base commit");
  requireCommit(changeSet.headCommit, "ChangeSet head commit");
  if (changeSet.baseCommit === changeSet.headCommit) {
    throw new Error("ChangeSet must contain at least one commit.");
  }
  requireText(changeSet.branch, "ChangeSet branch");
  normalizedUniqueText(changeSet.changedPaths, "ChangeSet path");
  if (changeSet.manifest !== undefined) {
    const manifest = validateChangeSetManifest(changeSet.manifest);
    const changed = new Set(changeSet.changedPaths);
    for (const deleted of manifest.deletedPaths) {
      if (!changed.has(deleted)) {
        throw new Error(`ChangeSet manifest deleted path is not a changed path: ${deleted}.`);
      }
    }
  }
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
