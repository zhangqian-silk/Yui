import {
  NodeGitWorkspace,
  type GitWorkspacePort
} from "../repository/gitWorkspace.js";
import { workspaceProjectEntry } from "../worktree/managedWorkspace.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  createIntegrationAttempt,
  type IntegrationAttempt
} from "./integrationAttempt.js";
import {
  createConvergedIntegrationQueueEntry,
  createIntegrationQueueEntry,
  markIntegrationQueueBlocked,
  markIntegrationQueueCommitted,
  markIntegrationQueueRequeued,
  markIntegrationQueueRunning,
  markIntegrationQueueSuperseded,
  markIntegrationQueueValidated,
  recordIntegrationQueueAffectedPaths,
  recordIntegrationQueueAttempt,
  type IntegrationQueueEntry
} from "./integrationQueueEntry.js";
import {
  GitIntegrationService,
  type IntegrationResult
} from "./gitIntegrationService.js";

/**
 * The serialized integration queue.  Every item gets a fresh apply on the
 * current target; a conflict or gate failure blocks only that item.  After
 * each target advance the remaining items recompute their overlap, and an
 * unaffected item with exact-SHA evidence is validated without re-running
 * its checks.
 */

export type IntegrationQueueGitPort = GitWorkspacePort & {
  findCommitWithSameTreeInHistory?: (input: Readonly<{
    repositoryPath: string;
    sourceCommit: string;
    historyHead: string;
  }>) => Promise<string | null>;
};

export type EnqueueIntegrationQueueOutcome =
  | "queued"
  | "already-queued"
  | "already-committed"
  | "converged";

export type EnqueueIntegrationQueueResult = Readonly<{
  entry: IntegrationQueueEntry;
  outcome: EnqueueIntegrationQueueOutcome;
}>;

export type EnqueueIntegrationQueueInput = Readonly<{
  store: TaskStore;
  taskId: string;
  projectId: string;
  changeSetId: string;
  targetRef?: string;
  checkCommands?: readonly string[];
  git?: IntegrationQueueGitPort;
  now?: () => Date;
}>;

/**
 * Enqueue one ChangeSet.  Enqueue is idempotent per (Project, ChangeSet): an
 * existing non-superseded entry is returned instead of duplicated.  When the
 * ChangeSet is already represented on the target (an ancestor or a same-tree
 * commit) the entry converges directly to committed with its proof.
 */
export async function enqueueIntegrationQueueEntry(
  input: EnqueueIntegrationQueueInput
): Promise<EnqueueIntegrationQueueResult> {
  const now = input.now ?? (() => new Date());
  const git = input.git ?? new NodeGitWorkspace();
  const task = input.store.getTask(input.taskId);
  if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
  if (task.status !== "active") {
    throw new Error(`Task is not active: ${task.id}/${task.status}.`);
  }
  const changeSet = input.store.getChangeSet(task.id, input.changeSetId);
  if (changeSet === null) throw new Error(`ChangeSet not found: ${input.changeSetId}.`);
  if (changeSet.projectId !== input.projectId) {
    throw new Error(`ChangeSet belongs to another Project: ${changeSet.projectId}.`);
  }
  if (!task.projectBindings.some(({ projectId }) => projectId === input.projectId)) {
    throw new Error(`Project does not belong to Task: ${input.projectId}.`);
  }
  const existing = input.store.listIntegrationQueueEntries(task.id)
    .find((entry) => entry.projectId === input.projectId
      && entry.changeSetId === input.changeSetId);
  if (existing !== undefined && existing.status !== "superseded") {
    return {
      entry: existing,
      outcome: existing.status === "committed" ? "already-committed" : "already-queued"
    };
  }
  const project = input.store.getProject(input.projectId);
  if (project === null) throw new Error(`Project not found: ${input.projectId}.`);
  const targetRef = input.targetRef
    ?? changeSet.manifest?.targetRef
    ?? taskMainBranch(input.store, task.id, input.projectId);
  if (targetRef === undefined) {
    throw new Error(`Task main worktree is not ready; reconcile the Task first: ${task.id}.`);
  }
  const targetHead = (await git.inspect(project.path, targetRef)).baseCommit;
  const equivalent = await findEquivalentCommit(
    git,
    project.path,
    changeSet.headCommit,
    targetHead
  );
  return input.store.transaction((tx) => {
    const id = tx.nextIntegrationQueueEntryId(task.id);
    const entry = equivalent === null
      ? createIntegrationQueueEntry({
          id,
          taskId: task.id,
          projectId: input.projectId,
          changeSetId: input.changeSetId,
          targetRef,
          checkCommands: input.checkCommands ?? [],
          evidenceRefs: changeSet.manifest?.evidenceRefs ?? []
        }, now())
      : createConvergedIntegrationQueueEntry({
          id,
          taskId: task.id,
          projectId: input.projectId,
          changeSetId: input.changeSetId,
          targetRef,
          targetHead,
          proof: equivalent === changeSet.headCommit
            ? `ancestor-convergence:${equivalent}`
            : `tree-convergence:${equivalent}`
        }, now());
    tx.saveIntegrationQueueEntry(task.id, entry);
    return { entry, outcome: equivalent === null ? "queued" : "converged" as const };
  });
}

export type ProcessIntegrationQueueOptions = Readonly<{
  projectId?: string;
  limit?: number;
  git?: IntegrationQueueGitPort;
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
}>;

export type ProcessIntegrationQueueItem = Readonly<{
  entry: IntegrationQueueEntry;
  attempt: IntegrationAttempt;
  result: IntegrationResult;
}>;

/**
 * Process queued items in id order.  Each item gets a fresh IntegrationAttempt
 * on the exact current target; conflicts and gate failures map the item to
 * `conflicted` without touching the others.  After every commit the remaining
 * items recompute overlap, and unaffected items with evidence are validated.
 */
export async function processIntegrationQueue(
  store: TaskStore,
  home: string,
  taskId: string,
  options: ProcessIntegrationQueueOptions = {}
): Promise<readonly ProcessIntegrationQueueItem[]> {
  const now = options.now ?? (() => new Date());
  const git = options.git ?? new NodeGitWorkspace();
  const task = store.getTask(taskId);
  if (task === null) throw new Error(`Task not found: ${taskId}.`);
  if (task.status !== "active") {
    throw new Error(`Task is not active: ${task.id}/${task.status}.`);
  }
  const processed: ProcessIntegrationQueueItem[] = [];
  for (;;) {
    if (options.limit !== undefined && processed.length >= options.limit) break;
    reconcileCommittedEntries(store, task.id, now);
    const next = store.listIntegrationQueueEntries(task.id)
      .filter((entry) =>
        (options.projectId === undefined || entry.projectId === options.projectId)
        && (entry.status === "queued" || entry.status === "validated"))
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    if (next === undefined) break;
    const project = store.getProject(next.projectId);
    if (project === null) throw new Error(`Project not found: ${next.projectId}.`);
    const skipChecks = next.status === "validated";
    const targetBefore = (await git.inspect(project.path, next.targetRef)).baseCommit;
    const prepared = store.transaction((tx) => {
      const attempt = createIntegrationAttempt({
        id: tx.nextIntegrationAttemptId(task.id),
        taskId: task.id,
        projectId: next.projectId,
        targetRef: next.targetRef,
        expectedHead: targetBefore,
        changeSetIds: [next.changeSetId],
        checkCommands: skipChecks ? [] : next.checkCommands
      }, now());
      tx.saveIntegrationAttempt(task.id, attempt);
      const entry = recordIntegrationQueueAttempt(
        markIntegrationQueueRunning(next, targetBefore, now()),
        attempt.id,
        now()
      );
      tx.saveIntegrationQueueEntry(task.id, entry);
      return { entry, attempt };
    });
    const result = await new GitIntegrationService(home, store, git, now, options.environment)
      .integrate(task.id, prepared.attempt.id);
    const settled = store.transaction((tx) => {
      let entry = prepared.entry;
      if (result.status === "committed") {
        entry = markIntegrationQueueCommitted(entry, committedTargetAfter(result.attempt), now());
      } else if (result.status === "blocked") {
        entry = markIntegrationQueueBlocked(
          entry,
          result.attempt.conflict?.summary
            ?? "Integration blocked without a conflict report.",
          now()
        );
      } else {
        entry = markIntegrationQueueBlocked(entry, gateFailureSummary(result.attempt), now());
      }
      tx.saveIntegrationQueueEntry(task.id, entry);
      if (result.status === "committed") {
        recomputeAffectedPaths(tx, task.id, entry, now);
      }
      return entry;
    });
    processed.push({ entry: settled, attempt: result.attempt, result });
  }
  return processed;
}

/** A conflicted entry whose manual-resolution Attempt committed converges. */
export function reconcileIntegrationQueueEntry(
  store: TaskStore,
  taskId: string,
  entryId: string,
  now: () => Date = () => new Date()
): IntegrationQueueEntry {
  const entry = store.getIntegrationQueueEntry(taskId, entryId);
  if (entry === null) {
    throw new Error(`Integration queue entry not found: ${taskId}/${entryId}.`);
  }
  if (entry.status !== "conflicted") {
    throw new Error(`Integration queue entry is not conflicted: ${entry.id}/${entry.status}.`);
  }
  const attempt = entry.integrationAttemptId === undefined
    ? undefined
    : store.getIntegrationAttempt(taskId, entry.integrationAttemptId);
  if (attempt?.status !== "committed") {
    throw new Error(
      `Integration Attempt has not committed: ${entry.integrationAttemptId ?? "-"}/${attempt?.status ?? "missing"}.`
    );
  }
  const committed = markIntegrationQueueCommitted(entry, committedTargetAfter(attempt), now());
  store.saveIntegrationQueueEntry(taskId, committed);
  return committed;
}

/** Retry a conflicted item (for example after a gate failure was fixed). */
export function requeueIntegrationQueueEntry(
  store: TaskStore,
  taskId: string,
  entryId: string,
  now: () => Date = () => new Date()
): IntegrationQueueEntry {
  const entry = store.getIntegrationQueueEntry(taskId, entryId);
  if (entry === null) {
    throw new Error(`Integration queue entry not found: ${taskId}/${entryId}.`);
  }
  const waiting = markIntegrationQueueRequeued(entry, now());
  store.saveIntegrationQueueEntry(taskId, waiting);
  return waiting;
}

export function supersedeIntegrationQueueEntry(
  store: TaskStore,
  taskId: string,
  entryId: string,
  reason: string,
  now: () => Date = () => new Date()
): IntegrationQueueEntry {
  const entry = store.getIntegrationQueueEntry(taskId, entryId);
  if (entry === null) {
    throw new Error(`Integration queue entry not found: ${taskId}/${entryId}.`);
  }
  const superseded = markIntegrationQueueSuperseded(entry, reason, now());
  store.saveIntegrationQueueEntry(taskId, superseded);
  return superseded;
}

function reconcileCommittedEntries(
  store: TaskStore,
  taskId: string,
  now: () => Date
): void {
  for (const entry of store.listIntegrationQueueEntries(taskId)) {
    if (entry.status !== "conflicted" || entry.integrationAttemptId === undefined) continue;
    const attempt = store.getIntegrationAttempt(taskId, entry.integrationAttemptId);
    if (attempt?.status !== "committed") continue;
    store.saveIntegrationQueueEntry(
      taskId,
      markIntegrationQueueCommitted(entry, committedTargetAfter(attempt), now())
    );
  }
}

function recomputeAffectedPaths(
  store: TaskStore,
  taskId: string,
  committed: IntegrationQueueEntry,
  now: () => Date
): void {
  const committedChangeSet = store.getChangeSet(taskId, committed.changeSetId);
  if (committedChangeSet === null) return;
  const landed = new Set(committedChangeSet.changedPaths);
  for (const entry of store.listIntegrationQueueEntries(taskId)) {
    if (entry.projectId !== committed.projectId) continue;
    if (entry.status !== "queued" && entry.status !== "validated") continue;
    const changeSet = store.getChangeSet(taskId, entry.changeSetId);
    if (changeSet === null) continue;
    const affected = changeSet.changedPaths.filter((path) => landed.has(path));
    const beforeAffected = (entry.affectedPaths ?? []).length;
    let updated = recordIntegrationQueueAffectedPaths(entry, affected, now());
    if (updated.status === "validated" && (updated.affectedPaths?.length ?? 0) > 0) {
      updated = markIntegrationQueueRequeued(updated, now());
    } else if (
      updated.status === "queued"
      && (updated.affectedPaths?.length ?? 0) === 0
      && updated.evidenceRefs.length > 0
    ) {
      updated = markIntegrationQueueValidated(updated, now());
    }
    if (updated.status !== entry.status
      || (updated.affectedPaths?.length ?? 0) !== beforeAffected) {
      store.saveIntegrationQueueEntry(taskId, updated);
    }
  }
}

function committedTargetAfter(attempt: IntegrationAttempt): string {
  if (attempt.candidateCommit === undefined) {
    throw new Error(`Committed Integration Attempt has no candidate commit: ${attempt.id}.`);
  }
  return attempt.candidateCommit;
}

function gateFailureSummary(attempt: IntegrationAttempt): string {
  const failed = (attempt.checks ?? []).find((check) => check.outcome === "failed");
  return failed === undefined
    ? "Integration failed before the target ref advanced."
    : `gate failed: ${failed.name}${failed.details === undefined ? "" : `: ${failed.details}`}`;
}

async function findEquivalentCommit(
  git: IntegrationQueueGitPort,
  repositoryPath: string,
  sourceCommit: string,
  historyHead: string
): Promise<string | null> {
  if (git.findCommitWithSameTreeInHistory === undefined) {
    return (await git.isAncestor(repositoryPath, sourceCommit, historyHead))
      ? sourceCommit
      : null;
  }
  return git.findCommitWithSameTreeInHistory({ repositoryPath, sourceCommit, historyHead });
}

function taskMainBranch(
  store: TaskStore,
  taskId: string,
  projectId: string
): string | undefined {
  const mainWorkspace = store.getTaskWorkspace(taskId);
  if (mainWorkspace === null) return undefined;
  return workspaceProjectEntry(mainWorkspace, projectId)?.branch;
}
