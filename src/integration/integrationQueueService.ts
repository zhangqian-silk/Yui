import {
  NodeGitWorkspace,
  type GitWorkspacePort
} from "../repository/gitWorkspace.js";
import { workspaceProjectEntry } from "../worktree/managedWorkspace.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  createIntegrationAttempt,
  updateIntegrationAttempt,
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
import type { ChangeSet } from "./changeSet.js";

/**
 * The serialized integration queue.  Every item gets a fresh apply on the
 * current target; a conflict or gate failure blocks only that item.  After
 * each target advance the remaining items recompute their overlap, and an
 * item whose own paths became affected loses any evidence coverage.  Path
 * disjointness never rebinds evidence to a new target: a gate may read any
 * file, so each item runs its checks against the exact target it integrates.
 */

export type IntegrationQueueGitPort = GitWorkspacePort & {
  findCommitWithSameTreeInHistory?: (input: Readonly<{
    repositoryPath: string;
    sourceCommit: string;
    historyHead: string;
  }>) => Promise<string | null>;
  treesAgreeOnPaths?: (input: Readonly<{
    repositoryPath: string;
    leftCommit: string;
    rightCommit: string;
    paths: readonly string[];
  }>) => Promise<boolean>;
  changedFilesBetween?: (input: Readonly<{
    repositoryPath: string;
    fromCommit: string;
    toCommit: string;
  }>) => Promise<readonly string[]>;
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
 * Producer WorkItem statuses that close the WorkItem lifecycle.  A ChangeSet
 * captured from a WorkItem that reached one of these without ever producing a
 * Candidate has no deliverable to integrate: landing it would break Task-final
 * provenance, which traces every queued ChangeSet back to its WorkItem's
 * Candidate.
 */
const TERMINAL_PRODUCER_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "retired"
]);

/**
 * Only a ChangeSet whose producer WorkItem reached a deliverable may enter the
 * queue.  In-progress WorkItems are left to the capture path, which only runs
 * once a Candidate exists; the re-check inside the write transaction closes
 * the TOCTOU window between this read and the entry creation.
 */
function assertEnqueueableProducer(
  store: TaskStore,
  taskId: string,
  changeSet: ChangeSet
): void {
  const workItem = store.getWorkItem(taskId, changeSet.workItemId);
  if (workItem === null) {
    throw new Error(
      `ChangeSet producer WorkItem not found: ${changeSet.workItemId}.`
    );
  }
  if (
    workItem.candidates.length === 0
    && TERMINAL_PRODUCER_STATUSES.has(workItem.status)
  ) {
    throw new Error(
      `ChangeSet producer WorkItem has no terminal Candidate: ${workItem.id}/${workItem.status}.`
    );
  }
}

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
  // Fast path: a duplicate already visible returns without any git inspection.
  // The authoritative re-check happens inside the write transaction so two
  // concurrent enqueues cannot both create entries for the same ChangeSet.
  const existing = findActiveQueueDuplicate(
    input.store, task.id, input.projectId, input.changeSetId
  );
  if (existing !== undefined) {
    return {
      entry: existing,
      outcome: existing.status === "committed" ? "already-committed" : "already-queued"
    };
  }
  // Producer fence: only a ChangeSet whose WorkItem reached a deliverable may
  // enter the queue.  Re-checked inside the write transaction.
  assertEnqueueableProducer(input.store, task.id, changeSet);
  const project = input.store.getProject(input.projectId);
  if (project === null) throw new Error(`Project not found: ${input.projectId}.`);
  const targetRef = input.targetRef
    ?? changeSet.manifest?.targetRef
    ?? taskMainBranch(input.store, task.id, input.projectId);
  if (targetRef === undefined) {
    throw new Error(`Task main worktree is not ready; reconcile the Task first: ${task.id}.`);
  }
  const targetHead = (await git.inspect(project.path, targetRef)).baseCommit;
  let equivalent = await findEquivalentCommit(
    git,
    project.path,
    changeSet.headCommit,
    targetHead
  );
  if (equivalent === null) {
    // The identical change may already have landed through another commit
    // while the target also moved on with unrelated work: the whole-tree
    // check misses it, but the touched paths already agree.
    equivalent = await findContainedChangeSet(git, project.path, changeSet, targetHead);
  }
  return input.store.transaction((tx) => {
    const duplicate = findActiveQueueDuplicate(
      tx, task.id, input.projectId, input.changeSetId
    );
    if (duplicate !== undefined) {
      return {
        entry: duplicate,
        outcome: duplicate.status === "committed" ? "already-committed" : "already-queued"
      };
    }
    // Re-verify the producer inside the write transaction: the WorkItem may
    // have retired (or been deleted) between the read above and this commit.
    assertEnqueueableProducer(tx, task.id, changeSet);
    const id = tx.nextIntegrationQueueEntryId(task.id);
    if (equivalent === null) {
      let entry = createIntegrationQueueEntry({
        id,
        taskId: task.id,
        projectId: input.projectId,
        changeSetId: input.changeSetId,
        targetRef,
        checkCommands: input.checkCommands ?? [],
        evidenceRefs: changeSet.manifest?.evidenceRefs ?? []
      }, now());
      // Durable positive exact-SHA evidence on an unchanged target, at the lane
      // head, validates the entry so processing skips its checks.  The process-
      // path evidence fence still invalidates the binding if the target moves
      // before this entry runs, so a non-empty advance never rebinds old
      // evidence.
      if (canReuseEvidenceAtHead(tx.listIntegrationQueueEntries(task.id), entry, changeSet, targetHead)) {
        entry = markIntegrationQueueValidated(entry, now(), targetHead);
      }
      tx.saveIntegrationQueueEntry(task.id, entry);
      return { entry, outcome: "queued" as const };
    }
    // The ChangeSet is already represented on the target, so applying it would
    // be a no-op and the target does not move.  Still record the one
    // integration authority every acceptance and provenance consumer reads:
    // a committed IntegrationAttempt against the exact observed target head,
    // with the converged queue entry pointing at it.  No gate runs because
    // there is nothing new to apply; the entry's proof string says why.
    const attempt = updateIntegrationAttempt(
      createIntegrationAttempt({
        id: tx.nextIntegrationAttemptId(task.id),
        taskId: task.id,
        projectId: input.projectId,
        targetRef,
        expectedHead: targetHead,
        changeSetIds: [input.changeSetId],
        checkCommands: []
      }, now()),
      { status: "committed", candidateCommit: targetHead },
      now()
    );
    tx.saveIntegrationAttempt(task.id, attempt);
    const entry = createConvergedIntegrationQueueEntry({
      id,
      taskId: task.id,
      projectId: input.projectId,
      changeSetId: input.changeSetId,
      targetRef,
      targetHead,
      proof: equivalent === changeSet.headCommit
        ? `ancestor-convergence:${equivalent}`
        : `tree-convergence:${equivalent}`,
      integrationAttemptId: attempt.id
    }, now());
    tx.saveIntegrationQueueEntry(task.id, entry);
    return { entry, outcome: "converged" as const };
  });
}

function findActiveQueueDuplicate(
  store: TaskStore,
  taskId: string,
  projectId: string,
  changeSetId: string
): IntegrationQueueEntry | undefined {
  return store.listIntegrationQueueEntries(taskId)
    .find((entry) => entry.projectId === projectId
      && entry.changeSetId === changeSetId
      && entry.status !== "superseded");
}

/**
 * Whether a freshly queued entry may start `validated` (skipping its checks):
 * its ChangeSet carries durable positive exact-SHA evidence, the target is
 * unchanged since the ChangeSet was based (so integrating fast-forwards to
 * the reviewed head), and no earlier lane entry will advance the target
 * first.  Entries behind a lane mate stay `queued`: the mate's commit moves
 * the target, so the evidence would not cover their integration anyway.
 */
function canReuseEvidenceAtHead(
  entries: readonly IntegrationQueueEntry[],
  entry: IntegrationQueueEntry,
  changeSet: ChangeSet,
  targetHead: string
): boolean {
  if (entry.evidenceRefs.length === 0) return false;
  if (targetHead !== changeSet.baseCommit) return false;
  const lane = queueLaneKey(entry);
  return !entries.some((existing) => queueLaneKey(existing) === lane
    && existing.status !== "committed"
    && existing.status !== "superseded");
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
 * items recompute overlap, and an item whose own paths became affected loses
 * its evidence coverage and runs its checks again.
 *
 * A lane (one Project/targetRef pair) integrates one item at a time: while an
 * item is `running` — claimed by this or another processor — no other item of
 * the lane is selected, and the claim re-checks the barrier inside its write
 * transaction so two store instances cannot run items of the same target
 * concurrently.  The barrier covers the whole lane regardless of id order, so
 * a requeued predecessor is serialized behind a successor that started first.
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
    reconcileTerminalAttempts(store, task.id, now);
    // The store already returns entries in numeric id order; trust it instead
    // of re-sorting with a lexicographic compare (which yields 1, 10, 2, ...).
    // A running entry is the persistent head of its lane: its successors are
    // skipped here so another processor's in-flight item is never claimed
    // past.
    const candidate = firstClaimableQueueEntry(
      store.listIntegrationQueueEntries(task.id),
      options.projectId
    );
    if (candidate === undefined) break;
    const project = store.getProject(candidate.projectId);
    if (project === null) throw new Error(`Project not found: ${candidate.projectId}.`);
    const targetBefore = (await git.inspect(project.path, candidate.targetRef)).baseCommit;
    // Evidence fence: a validated entry's reusable evidence only covers the
    // exact target head it was validated against.  An out-of-band target
    // advance (another Task) that touches the entry's paths, or whose impact
    // cannot be proven, invalidates the evidence: requeue and run its checks.
    if (candidate.status === "validated"
      && await evidenceTargetAdvanced(
        git, project.path, candidate, targetBefore, store, task.id
      )) {
      store.transaction((tx) => {
        const current = tx.getIntegrationQueueEntry(task.id, candidate.id);
        if (current !== null && current.status === "validated") {
          tx.saveIntegrationQueueEntry(task.id, markIntegrationQueueRequeued(current, now()));
        }
      });
      continue;
    }
    // CAS claim: re-read the entry inside the write transaction.  Another
    // store instance may have taken it since selection; if the status changed,
    // do not create an Attempt and re-select instead.  The running barrier is
    // re-checked here as well: an earlier lane mate that started running
    // between selection and claim serializes this entry behind it.
    const claimed = store.transaction((tx) => {
      const current = tx.getIntegrationQueueEntry(task.id, candidate.id);
      if (current === null
        || (current.status !== "queued" && current.status !== "validated")) {
        return { skipped: true as const };
      }
      if (laneBlockedByRunningEntry(tx.listIntegrationQueueEntries(task.id), current)) {
        return { skipped: true as const };
      }
      const attempt = createIntegrationAttempt({
        id: tx.nextIntegrationAttemptId(task.id),
        taskId: task.id,
        projectId: current.projectId,
        targetRef: current.targetRef,
        expectedHead: targetBefore,
        changeSetIds: [current.changeSetId],
        checkCommands: current.status === "validated" ? [] : current.checkCommands
      }, now());
      tx.saveIntegrationAttempt(task.id, attempt);
      const entry = recordIntegrationQueueAttempt(
        markIntegrationQueueRunning(current, targetBefore, now()),
        attempt.id,
        now()
      );
      tx.saveIntegrationQueueEntry(task.id, entry);
      return { skipped: false as const, entry, attempt };
    });
    if (claimed.skipped) continue;
    const result = await new GitIntegrationService(home, store, git, now, options.environment)
      .integrate(task.id, claimed.attempt.id);
    const settled = store.transaction((tx) => {
      let entry = claimed.entry;
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

/**
 * A queue lane serializes one target ref: entries for the same Project and
 * targetRef integrate one at a time in id order.  Entries of different lanes
 * (another Project or ref) do not share a target and may integrate alongside.
 */
function queueLaneKey(entry: IntegrationQueueEntry): string {
  return `${entry.projectId} ${entry.targetRef}`;
}

/**
 * The first entry a processor may claim: the earliest queued/validated entry
 * whose lane has no running entry anywhere in it.  A running entry serializes
 * its whole lane — predecessors and successors alike — so a requeued
 * predecessor cannot slip past a successor that is already running.
 */
function firstClaimableQueueEntry(
  entries: readonly IntegrationQueueEntry[],
  projectId: string | undefined
): IntegrationQueueEntry | undefined {
  const blockedLanes = new Set<string>();
  for (const entry of entries) {
    if (projectId !== undefined && entry.projectId !== projectId) continue;
    if (entry.status === "running") {
      blockedLanes.add(queueLaneKey(entry));
    }
  }
  for (const entry of entries) {
    if (projectId !== undefined && entry.projectId !== projectId) continue;
    if ((entry.status === "queued" || entry.status === "validated")
      && !blockedLanes.has(queueLaneKey(entry))) {
      return entry;
    }
  }
  return undefined;
}

/**
 * The claim-time re-check of the running barrier: the candidate stays
 * claimable only while no other entry of its lane is running.  The barrier
 * covers the whole lane regardless of id order, so a requeued predecessor is
 * serialized behind a successor that started running first.
 */
function laneBlockedByRunningEntry(
  entries: readonly IntegrationQueueEntry[],
  candidate: IntegrationQueueEntry
): boolean {
  const lane = queueLaneKey(candidate);
  return entries.some((entry) => entry.id !== candidate.id
    && entry.status === "running"
    && queueLaneKey(entry) === lane);
}

/**
 * Whether a validated entry's reusable evidence no longer covers the current
 * target.  The evidence only proves the gate as of `entry.evidenceTargetHead`;
 * an out-of-band target advance (another Task) on the entry's own paths, or any
 * advance whose impact on the entry's gate cannot be proven, invalidates it.
 * Returns false (evidence still covers the target) only when proven unaffected.
 */
async function evidenceTargetAdvanced(
  git: IntegrationQueueGitPort,
  repositoryPath: string,
  entry: IntegrationQueueEntry,
  currentTargetHead: string,
  store: TaskStore,
  taskId: string
): Promise<boolean> {
  const boundary = entry.evidenceTargetHead;
  if (boundary === undefined) return true;
  if (boundary === currentTargetHead) return false;
  // The target advanced out of band since the evidence boundary.  Compute the
  // real path delta and re-run the gate unless the entry is provably unaffected.
  if (git.changedFilesBetween === undefined) return true;
  let delta: readonly string[];
  try {
    delta = await git.changedFilesBetween({
      repositoryPath,
      fromCommit: boundary,
      toCommit: currentTargetHead
    });
  } catch {
    return true;
  }
  const changeSet = store.getChangeSet(taskId, entry.changeSetId);
  if (changeSet === null) return true;
  const ownPaths = new Set([
    ...changeSet.changedPaths,
    ...(changeSet.manifest?.deletedPaths ?? [])
  ]);
  if (delta.some((path) => ownPaths.has(path))) return true;
  // The delta does not touch the entry's own paths, but the entry's gate may
  // read any file: a non-empty delta means non-impact cannot be proven, so the
  // checks must run again.  An empty delta (identical trees) cannot affect a
  // gate, and an entry without checks has nothing to re-run.
  return delta.length > 0 && entry.checkCommands.length > 0;
}

/**
 * A conflicted entry whose manual-resolution Attempt committed converges.  The
 * settle and the downstream affected-path recompute a normal commit performs
 * happen in one transaction, so waiting successors never observe a committed
 * entry with stale overlap evidence.
 */
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
  return store.transaction((tx) => {
    const committed = markIntegrationQueueCommitted(entry, committedTargetAfter(attempt), now());
    tx.saveIntegrationQueueEntry(taskId, committed);
    recomputeAffectedPaths(tx, taskId, committed, now);
    return committed;
  });
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

/**
 * Converge entries whose linked IntegrationAttempt already settled.  A
 * conflicted entry whose manual resolve committed, or a `running` entry
 * whose process crashed between the Attempt's terminal write and the queue
 * settle, both prove their outcome through the Attempt itself: converge
 * them idempotently — a committed Attempt to `committed`, replaying the
 * downstream affected/evidence updates a normal settle would, and a failed
 * or blocked Attempt to `conflicted` carrying the Attempt's own diagnosis —
 * so the next process pass sees a consistent queue and a wedged lane frees.
 */
function reconcileTerminalAttempts(
  store: TaskStore,
  taskId: string,
  now: () => Date
): void {
  for (const entry of store.listIntegrationQueueEntries(taskId)) {
    if (entry.integrationAttemptId === undefined) continue;
    if (entry.status !== "conflicted" && entry.status !== "running") continue;
    const attempt = store.getIntegrationAttempt(taskId, entry.integrationAttemptId);
    if (attempt === null) continue;
    if (attempt.status === "committed") {
      const committed = markIntegrationQueueCommitted(
        entry,
        committedTargetAfter(attempt),
        now()
      );
      store.saveIntegrationQueueEntry(taskId, committed);
      recomputeAffectedPaths(store, taskId, committed, now);
      continue;
    }
    // Crash window: the Attempt persisted a terminal failed/blocked outcome
    // but the process died before settling the entry.  Only a `running`
    // entry can be wedged by it — a `conflicted` entry already carries its
    // diagnosis — so converge the stuck lane head to `conflicted` with the
    // Attempt's own diagnosis, after which requeue or supersede can recover
    // it.  An Attempt still running or validating is genuinely in flight.
    if (entry.status !== "running") continue;
    if (attempt.status !== "failed" && attempt.status !== "blocked") continue;
    const diagnosis = attempt.status === "blocked"
      ? attempt.conflict?.summary ?? "Integration blocked without a conflict report."
      : gateFailureSummary(attempt);
    store.saveIntegrationQueueEntry(
      taskId,
      markIntegrationQueueBlocked(entry, diagnosis, now())
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
      // The target advanced onto this entry's own paths: its evidence no
      // longer covers the target, so the gate must run again.
      updated = markIntegrationQueueRequeued(updated, now());
    }
    // A queued entry keeps its place and runs its checks against the exact
    // current target at process time.  Disjoint changedPaths must never
    // rebind its evidence to the new target head: a gate may read any file,
    // so a non-empty target increment cannot be proven irrelevant from path
    // metadata alone.
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

/**
 * A ChangeSet whose head already agrees with the target on every path it
 * touched (deletions included) is fully represented there: an identical
 * parallel change landed through another commit.  Converge it directly,
 * since applying it would be a no-op and a second commit would only
 * duplicate the same work.
 */
async function findContainedChangeSet(
  git: IntegrationQueueGitPort,
  repositoryPath: string,
  changeSet: ChangeSet,
  targetHead: string
): Promise<string | null> {
  if (git.treesAgreeOnPaths === undefined) return null;
  const paths = [...new Set([
    ...changeSet.changedPaths,
    ...(changeSet.manifest?.deletedPaths ?? [])
  ])];
  if (paths.length === 0) return null;
  const agrees = await git.treesAgreeOnPaths({
    repositoryPath,
    leftCommit: changeSet.headCommit,
    rightCommit: targetHead,
    paths
  });
  return agrees ? targetHead : null;
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
