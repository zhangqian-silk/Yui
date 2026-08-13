import {
  normalizedUniqueIdentities,
  normalizedUniqueText,
  requireIdentity,
  requireText,
  requireTimestamp
} from "../domain/validation.js";
import { validateTaskRecordReference } from "../task/taskRecordReference.js";

/**
 * A per-Task integration queue entry: one ChangeSet waiting for (or passing
 * through) the serialized merge queue.  The queue never blocks parallel
 * development; it only orders the final exact-commit integration.
 */
export type IntegrationQueueStatus =
  | "queued"
  | "running"
  | "conflicted"
  | "validated"
  | "committed"
  | "superseded";

export type IntegrationQueueEntry = Readonly<{
  schemaVersion: 1;
  id: string;
  taskId: string;
  projectId: string;
  changeSetId: string;
  targetRef: string;
  status: IntegrationQueueStatus;
  checkCommands: readonly string[];
  /** Exact target head when processing started. */
  targetBefore?: string;
  /** Exact target head after the queue committed this entry. */
  targetAfter?: string;
  /** The IntegrationAttempt that processed (or last processed) this entry. */
  integrationAttemptId?: string;
  conflictSummary?: string;
  /**
   * Paths landed on the target after this entry was enqueued that overlap the
   * entry's own ChangeSet.  Recomputed after every target advance; an empty
   * set plus reusable evidence lets the entry skip re-verification.
   */
  affectedPaths?: readonly string[];
  /** Durable verification evidence for the entry's exact head commit. */
  evidenceRefs: readonly string[];
  supersedeReason?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}>;

export function createIntegrationQueueEntry(
  input: Readonly<Pick<
    IntegrationQueueEntry,
    "id" | "taskId" | "projectId" | "changeSetId" | "targetRef"
  > & Partial<Pick<
    IntegrationQueueEntry,
    "checkCommands" | "evidenceRefs"
  >>>,
  now: Date
): IntegrationQueueEntry {
  const timestamp = now.toISOString();
  return validateIntegrationQueueEntry({
    schemaVersion: 1,
    id: input.id,
    taskId: input.taskId,
    projectId: input.projectId,
    changeSetId: input.changeSetId,
    targetRef: input.targetRef,
    status: "queued",
    checkCommands: normalizedUniqueText(input.checkCommands ?? [], "Integration queue check command"),
    evidenceRefs: normalizedUniqueText(input.evidenceRefs ?? [], "Integration queue evidence"),
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

/**
 * An entry whose ChangeSet is already represented on the target (an ancestor
 * or a same-tree commit) converges directly to committed with its proof.
 */
export function createConvergedIntegrationQueueEntry(
  input: Readonly<Pick<
    IntegrationQueueEntry,
    "id" | "taskId" | "projectId" | "changeSetId" | "targetRef"
  > & {
    targetHead: string;
    proof: string;
  }>,
  now: Date
): IntegrationQueueEntry {
  const timestamp = now.toISOString();
  return validateIntegrationQueueEntry({
    schemaVersion: 1,
    id: input.id,
    taskId: input.taskId,
    projectId: input.projectId,
    changeSetId: input.changeSetId,
    targetRef: input.targetRef,
    status: "committed",
    checkCommands: [],
    targetBefore: input.targetHead,
    targetAfter: input.targetHead,
    evidenceRefs: [input.proof],
    createdAt: timestamp,
    updatedAt: timestamp,
    endedAt: timestamp
  });
}

export function markIntegrationQueueRunning(
  entry: IntegrationQueueEntry,
  targetBefore: string,
  now: Date
): IntegrationQueueEntry {
  validateIntegrationQueueEntry(entry);
  if (!["queued", "conflicted", "validated"].includes(entry.status)) {
    throw new Error(`Integration queue entry cannot run from ${entry.status}: ${entry.id}.`);
  }
  const { conflictSummary: _previousConflict, ...rest } = entry;
  return validateIntegrationQueueEntry({
    ...rest,
    status: "running",
    targetBefore,
    updatedAt: now.toISOString()
  });
}

export function recordIntegrationQueueAttempt(
  entry: IntegrationQueueEntry,
  integrationAttemptId: string,
  now: Date
): IntegrationQueueEntry {
  validateIntegrationQueueEntry(entry);
  if (entry.status !== "running") {
    throw new Error(`Integration queue entry is not running: ${entry.id}/${entry.status}.`);
  }
  return validateIntegrationQueueEntry({
    ...entry,
    integrationAttemptId,
    updatedAt: now.toISOString()
  });
}

export function markIntegrationQueueBlocked(
  entry: IntegrationQueueEntry,
  conflictSummary: string,
  now: Date
): IntegrationQueueEntry {
  validateIntegrationQueueEntry(entry);
  if (entry.status !== "running") {
    throw new Error(`Integration queue entry is not running: ${entry.id}/${entry.status}.`);
  }
  return validateIntegrationQueueEntry({
    ...entry,
    status: "conflicted",
    conflictSummary: requireText(conflictSummary, "Integration queue conflict summary"),
    updatedAt: now.toISOString()
  });
}

export function markIntegrationQueueCommitted(
  entry: IntegrationQueueEntry,
  targetAfter: string,
  now: Date
): IntegrationQueueEntry {
  validateIntegrationQueueEntry(entry);
  if (entry.status !== "running" && entry.status !== "conflicted") {
    throw new Error(`Integration queue entry cannot commit from ${entry.status}: ${entry.id}.`);
  }
  const timestamp = now.toISOString();
  return validateIntegrationQueueEntry({
    ...entry,
    status: "committed",
    targetAfter,
    updatedAt: timestamp,
    endedAt: timestamp
  });
}

/**
 * A target advance proved this entry's ChangeSet unaffected, and it carries
 * reusable exact-SHA evidence: its checks need not be re-executed.
 */
export function markIntegrationQueueValidated(
  entry: IntegrationQueueEntry,
  now: Date
): IntegrationQueueEntry {
  validateIntegrationQueueEntry(entry);
  if (entry.status !== "queued") {
    throw new Error(`Integration queue entry cannot validate from ${entry.status}: ${entry.id}.`);
  }
  if (entry.evidenceRefs.length === 0) {
    throw new Error(`Integration queue entry has no reusable evidence: ${entry.id}.`);
  }
  return validateIntegrationQueueEntry({
    ...entry,
    status: "validated",
    updatedAt: now.toISOString()
  });
}

/**
 * A validated entry whose ChangeSet became affected by a later target advance
 * loses its evidence coverage and runs its checks again; a conflicted entry is
 * manually retried after its underlying issue was fixed.
 */
export function markIntegrationQueueRequeued(
  entry: IntegrationQueueEntry,
  now: Date
): IntegrationQueueEntry {
  validateIntegrationQueueEntry(entry);
  if (entry.status !== "validated" && entry.status !== "conflicted") {
    throw new Error(
      `Integration queue entry cannot requeue from ${entry.status}: ${entry.id}.`
    );
  }
  return validateIntegrationQueueEntry({
    ...entry,
    status: "queued",
    updatedAt: now.toISOString()
  });
}

export function recordIntegrationQueueAffectedPaths(
  entry: IntegrationQueueEntry,
  affectedPaths: readonly string[],
  now: Date
): IntegrationQueueEntry {
  validateIntegrationQueueEntry(entry);
  if (!["queued", "validated"].includes(entry.status)) {
    throw new Error(
      `Integration queue entry cannot recompute overlap from ${entry.status}: ${entry.id}.`
    );
  }
  const previous = new Set(entry.affectedPaths ?? []);
  const merged = [...new Set([...previous, ...affectedPaths])].sort();
  return validateIntegrationQueueEntry({
    ...entry,
    affectedPaths: merged,
    updatedAt: now.toISOString()
  });
}

export function markIntegrationQueueSuperseded(
  entry: IntegrationQueueEntry,
  reason: string,
  now: Date
): IntegrationQueueEntry {
  validateIntegrationQueueEntry(entry);
  if (!["queued", "conflicted", "validated"].includes(entry.status)) {
    throw new Error(
      `Integration queue entry cannot be superseded from ${entry.status}: ${entry.id}.`
    );
  }
  const timestamp = now.toISOString();
  return validateIntegrationQueueEntry({
    ...entry,
    status: "superseded",
    supersedeReason: requireText(reason, "Integration queue supersede reason"),
    updatedAt: timestamp,
    endedAt: timestamp
  });
}

export function validateIntegrationQueueEntry(
  entry: IntegrationQueueEntry
): IntegrationQueueEntry {
  if (entry.schemaVersion !== 1) {
    throw new Error("IntegrationQueueEntry must use schemaVersion 1.");
  }
  validateTaskRecordReference({ taskId: entry.taskId, localId: entry.id }, "integrationQueue");
  validateTaskRecordReference(
    { taskId: entry.taskId, localId: entry.changeSetId },
    "changeSet"
  );
  requireIdentity(entry.projectId, "Project id");
  requireText(entry.targetRef, "Integration queue target ref");
  normalizedUniqueText(entry.checkCommands, "Integration queue check command");
  normalizedUniqueText(entry.evidenceRefs, "Integration queue evidence");
  if (![
    "queued",
    "running",
    "conflicted",
    "validated",
    "committed",
    "superseded"
  ].includes(entry.status)) {
    throw new Error(`Integration queue status is invalid: ${String(entry.status)}.`);
  }
  if (entry.targetBefore !== undefined) requireCommit(entry.targetBefore, "Integration queue targetBefore");
  if (entry.targetAfter !== undefined) requireCommit(entry.targetAfter, "Integration queue targetAfter");
  if (entry.integrationAttemptId !== undefined) {
    normalizedUniqueIdentities([entry.integrationAttemptId], "Integration attempt id");
  }
  if (entry.conflictSummary !== undefined) {
    requireText(entry.conflictSummary, "Integration queue conflict summary");
  }
  if (entry.affectedPaths !== undefined) {
    normalizedUniqueText(entry.affectedPaths, "Integration queue affected path");
  }
  if (entry.supersedeReason !== undefined) {
    requireText(entry.supersedeReason, "Integration queue supersede reason");
  }
  requireTimestamp(entry.createdAt, "Integration queue entry createdAt");
  requireTimestamp(entry.updatedAt, "Integration queue entry updatedAt");
  if (["committed", "superseded"].includes(entry.status)) {
    requireTimestamp(entry.endedAt ?? "", "Integration queue entry endedAt");
  }
  if (entry.status === "committed") {
    requireCommit(entry.targetAfter ?? "", "Integration queue targetAfter");
  }
  if (entry.status === "running") {
    requireCommit(entry.targetBefore ?? "", "Integration queue targetBefore");
  }
  return entry;
}

function requireCommit(value: string, label: string): string {
  const normalized = requireText(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}
