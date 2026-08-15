import {
  NodeGitWorkspace,
  type GitWorkspacePort
} from "../repository/gitWorkspace.js";
import { workspaceProjectEntry } from "../worktree/managedWorkspace.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  createIntegrationAttempt,
  recordResolutionDecision,
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
import type { WorkItemCandidate } from "../workItem/workItem.js";

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
  deletedFilesBetween?: (input: Readonly<{
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
 * Synchronous Task-active fence usable inside a write transaction.  The Task
 * may retire between the pre-flight read and the commit point; a terminal Task
 * must not gain new queue entries or Integration Attempts.
 */
function assertTaskActive(store: TaskStore, taskId: string): void {
  const task = store.getTask(taskId);
  if (task === null) {
    throw new Error(`Task not found: ${taskId}.`);
  }
  if (task.status !== "active") {
    throw new Error(`Task is not active: ${task.id}/${task.status}.`);
  }
}

/**
 * Synchronous current-Candidate fence usable inside a write transaction.
 * Rejects a running WorkItem (no current Candidate) and a ChangeSet whose
 * headCommit no longer matches the latest immutable Candidate snapshot.
 * Returns without error when the Candidate carries no head snapshot: the
 * async workspace fallback in assertCurrentCandidateHead covers that case
 * outside the transaction.
 */
function assertCurrentCandidateInStore(
  store: TaskStore,
  taskId: string,
  changeSet: ChangeSet
): void {
  const workItem = store.getWorkItem(taskId, changeSet.workItemId);
  if (workItem === null) {
    throw new Error(`ChangeSet producer WorkItem not found: ${changeSet.workItemId}.`);
  }
  // A running WorkItem has no current Candidate: a new one is expected.
  if (workItem.status === "running") {
    throw new Error(
      `ChangeSet ${changeSet.id} has no current Candidate: `
      + `WorkItem ${workItem.id} is running.`
    );
  }
  const latestCandidate = workItem.candidates.at(-1);
  if (latestCandidate !== undefined) {
    const snapshotHead = candidateHeadCommit(latestCandidate, changeSet.projectId);
    if (snapshotHead !== undefined && snapshotHead !== changeSet.headCommit) {
      throw new Error(
        `ChangeSet ${changeSet.id} was captured from a superseded Candidate: `
        + `current Candidate head is ${snapshotHead}, ChangeSet head is ${changeSet.headCommit}.`
      );
    }
  }
}

/**
 * A ChangeSet captured from a since-superseded Candidate must not enter the
 * queue.  The fence binds to the latest immutable Candidate snapshot: a
 * running WorkItem has no current Candidate, and a ChangeSet whose headCommit
 * no longer matches the latest Candidate (or the workspace HEAD when the
 * Candidate carries no head snapshot) was captured from an earlier Candidate.
 * When the workspace exists but cannot be inspected, fail closed.
 */
async function assertCurrentCandidateHead(
  store: TaskStore,
  taskId: string,
  changeSet: ChangeSet,
  git: IntegrationQueueGitPort
): Promise<void> {
  assertCurrentCandidateInStore(store, taskId, changeSet);
  // Fall back to the managed workspace HEAD when the Candidate carries no
  // head-commit snapshot.  Fail closed: a workspace that exists but cannot
  // be inspected blocks enqueue.
  const workspace = store.getManagedWorkspace({
    type: "work-item",
    taskId,
    workItemId: changeSet.workItemId
  });
  if (workspace === null) return;
  const entry = workspace.entries.find((e) => e.projectId === changeSet.projectId);
  if (entry === undefined) return;
  let currentHead: string;
  try {
    currentHead = (await git.inspect(entry.path)).baseCommit;
  } catch {
    throw new Error(
      `ChangeSet ${changeSet.id} cannot be verified: `
      + `workspace ${entry.path} exists but cannot be inspected.`
    );
  }
  if (currentHead !== changeSet.headCommit) {
    throw new Error(
      `ChangeSet ${changeSet.id} was captured from a superseded Candidate: `
      + `workspace HEAD is ${currentHead}, ChangeSet head is ${changeSet.headCommit}.`
    );
  }
}

function candidateHeadCommit(
  candidate: WorkItemCandidate,
  projectId: string
): string | undefined {
  const gitSnapshotHead = candidate.gitSnapshot?.projects
    .find((p) => p.projectId === projectId)?.commit;
  if (gitSnapshotHead !== undefined) return gitSnapshotHead;
  const taskMainHead = candidate.taskMainSnapshot?.projects
    .find((p) => p.projectId === projectId)?.headCommit;
  if (taskMainHead !== undefined) return taskMainHead;
  return undefined;
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
  // Producer fence: only a ChangeSet whose WorkItem reached a deliverable may
  // enter the queue.  Re-checked inside the write transaction.
  assertEnqueueableProducer(input.store, task.id, changeSet);
  // Current-Candidate fence: a ChangeSet captured from a since-superseded
  // Candidate must not enter the queue.  Runs before the duplicate fast path
  // so a retry-window WorkItem cannot resurrect a stale ChangeSet that was
  // enqueued before its Candidate was superseded.
  await assertCurrentCandidateHead(input.store, task.id, changeSet, git);
  // Fast path: a duplicate already visible returns without any git inspection.
  // The authoritative re-check happens inside the write transaction so two
  // concurrent enqueues cannot both create entries for the same ChangeSet.
  const existing = findActiveQueueDuplicate(
    input.store, task.id, input.projectId, input.changeSetId
  );
  if (existing !== undefined) {
    // A conflicting idempotency retry must fail closed, even on the fast
    // path: a caller that enqueues with a different explicit gate is either
    // mistaken or trying to bypass the original gate.  Reject instead of
    // silently discarding the requested checks.  A retry with no gate is a
    // plain idempotent lookup and returns the existing entry.
    const requestedChecks = input.checkCommands ?? [];
    if (
      requestedChecks.length > 0
      && (
        existing.checkCommands.length !== requestedChecks.length
        || existing.checkCommands.some((cmd, i) => cmd !== requestedChecks[i])
      )
    ) {
      throw new Error(
        `ChangeSet ${input.changeSetId} is already queued as ${existing.id} `
        + `with checkCommands [${existing.checkCommands.join(", ")}]; `
        + `a conflicting retry with [${requestedChecks.join(", ")}] is not allowed.`
      );
    }
    // A conflicting explicit target must also fail closed: a caller that
    // enqueues for a different branch is either mistaken or trying to land
    // the same ChangeSet on two targets through one entry.  A retry with no
    // explicit target is a plain idempotent lookup.
    if (input.targetRef !== undefined) {
      const requestedTarget = canonicalizeTargetRef(input.targetRef);
      if (requestedTarget !== existing.targetRef) {
        throw new Error(
          `ChangeSet ${input.changeSetId} is already queued as ${existing.id} `
          + `with targetRef ${existing.targetRef}; `
          + `a conflicting retry with targetRef ${requestedTarget} is not allowed.`
        );
      }
    }
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
  const canonicalTargetRef = canonicalizeTargetRef(targetRef);
  const targetHead = (await git.inspect(project.path, exactBranchRef(canonicalTargetRef))).baseCommit;
  let equivalent = await findEquivalentCommit(
    git,
    project.path,
    changeSet.headCommit,
    targetHead,
    changeSet.baseCommit
  );
  if (equivalent === null) {
    // The identical change may already have landed through another commit
    // while the target also moved on with unrelated work: the whole-tree
    // check misses it, but the touched paths already agree.
    equivalent = await findContainedChangeSet(git, project.path, changeSet, targetHead);
  }
  return input.store.transactionAsync(async (tx) => {
    const duplicate = findActiveQueueDuplicate(
      tx, task.id, input.projectId, input.changeSetId
    );
    if (duplicate !== undefined) {
      // A conflicting idempotency retry must fail closed: a caller that
      // enqueues with a different explicit gate is either mistaken or trying
      // to bypass the original gate.  Reject instead of silently discarding
      // the requested checks.  A retry with no gate is a plain idempotent
      // lookup and returns the existing entry.
      const requestedChecks = input.checkCommands ?? [];
      if (
        requestedChecks.length > 0
        && (
          duplicate.checkCommands.length !== requestedChecks.length
          || duplicate.checkCommands.some((cmd, i) => cmd !== requestedChecks[i])
        )
      ) {
        throw new Error(
          `ChangeSet ${input.changeSetId} is already queued as ${duplicate.id} `
          + `with checkCommands [${duplicate.checkCommands.join(", ")}]; `
          + `a conflicting retry with [${requestedChecks.join(", ")}] is not allowed.`
        );
      }
      // A conflicting explicit target must also fail closed.  A retry with
      // no explicit target is a plain idempotent lookup.
      if (input.targetRef !== undefined && canonicalTargetRef !== duplicate.targetRef) {
        throw new Error(
          `ChangeSet ${input.changeSetId} is already queued as ${duplicate.id} `
          + `with targetRef ${duplicate.targetRef}; `
          + `a conflicting retry with targetRef ${canonicalTargetRef} is not allowed.`
        );
      }
      return {
        entry: duplicate,
        outcome: duplicate.status === "committed" ? "already-committed" : "already-queued"
      };
    }
    // Re-verify the Task is still active inside the write transaction:
    // the Task may have retired between the pre-flight read and this commit.
    assertTaskActive(tx, task.id);
    // Re-verify the producer inside the write transaction: the WorkItem may
    // have retired (or been deleted) between the read above and this commit.
    assertEnqueueableProducer(tx, task.id, changeSet);
    // Re-verify the current-Candidate fence inside the write transaction:
    // the WorkItem may have entered retry (status running) between the
    // async target inspection and this commit.
    assertCurrentCandidateInStore(tx, task.id, changeSet);
    const id = tx.nextIntegrationQueueEntryId(task.id);
    const requestedChecks = input.checkCommands ?? [];
    // The async proof above observed the target before this write
    // transaction.  A concurrent landing may have advanced it since; a
    // stale containment proof cannot terminalize the entry against the
    // old head, so re-read inside the transaction and invalidate the
    // proof if it moved.
    let effectiveTargetHead = targetHead;
    if (equivalent !== null) {
      effectiveTargetHead = (await git.inspect(project.path, exactBranchRef(canonicalTargetRef))).baseCommit;
      if (effectiveTargetHead !== targetHead) {
        equivalent = null;
      } else {
        // The inspect above is itself async: a concurrent landing can
        // advance the target during the call, so the returned head may
        // already be stale.  Verify with a second read; if it moved, the
        // convergence proof is stale and the entry must queue.
        const verifiedHead = (await git.inspect(project.path, exactBranchRef(canonicalTargetRef))).baseCommit;
        if (verifiedHead !== effectiveTargetHead) {
          equivalent = null;
          effectiveTargetHead = verifiedHead;
        }
      }
    }
    if (equivalent === null || requestedChecks.length > 0) {
      let entry = createIntegrationQueueEntry({
        id,
        taskId: task.id,
        projectId: input.projectId,
        changeSetId: input.changeSetId,
        targetRef: canonicalTargetRef,
        checkCommands: requestedChecks,
        evidenceRefs: changeSet.manifest?.evidenceRefs ?? []
      }, now());
      // Durable positive exact-SHA evidence on an unchanged target, at the lane
      // head, validates the entry so processing skips its checks.  The process-
      // path evidence fence still invalidates the binding if the target moves
      // before this entry runs, so a non-empty advance never rebinds old
      // evidence.  A converged ChangeSet with explicit gates queues normally:
      // the no-op apply still runs the caller's checks against the current
      // target instead of waiving them.
      if (canReuseEvidenceAtHead(tx, task.id, tx.listIntegrationQueueEntries(task.id), entry, changeSet, effectiveTargetHead)) {
        entry = markIntegrationQueueValidated(entry, now(), effectiveTargetHead);
      }
      tx.saveIntegrationQueueEntry(task.id, entry);
      return { entry, outcome: "queued" as const };
    }
    // The ChangeSet is already represented on the target and no gate was
    // requested, so applying it would be a no-op and the target does not move.
    // Still record the one integration authority every acceptance and
    // provenance consumer reads: a committed IntegrationAttempt against the
    // exact observed target head, with the converged queue entry pointing at
    // it.  No gate runs because there is nothing new to apply and none was
    // requested; the entry's proof string says why.
    const attempt = updateIntegrationAttempt(
      createIntegrationAttempt({
        id: tx.nextIntegrationAttemptId(task.id),
        taskId: task.id,
        projectId: input.projectId,
        targetRef: canonicalTargetRef,
        expectedHead: effectiveTargetHead,
        changeSetIds: [input.changeSetId],
        checkCommands: []
      }, now()),
      { status: "committed", candidateCommit: effectiveTargetHead },
      now()
    );
    tx.saveIntegrationAttempt(task.id, attempt);
    const entry = createConvergedIntegrationQueueEntry({
      id,
      taskId: task.id,
      projectId: input.projectId,
      changeSetId: input.changeSetId,
      targetRef: canonicalTargetRef,
      targetHead: effectiveTargetHead,
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
 * the reviewed head), no earlier lane entry will advance the target first,
 * and the evidence covers every requested check command.  Entries behind a
 * lane mate stay `queued`: the mate's commit moves the target, so the
 * evidence would not cover their integration anyway.  A review check that
 * passed for command X never waives a different gate Y.
 */
function canReuseEvidenceAtHead(
  store: TaskStore,
  taskId: string,
  entries: readonly IntegrationQueueEntry[],
  entry: IntegrationQueueEntry,
  changeSet: ChangeSet,
  targetHead: string
): boolean {
  if (entry.evidenceRefs.length === 0) return false;
  if (targetHead !== changeSet.baseCommit) return false;
  const lane = queueLaneKey(entry);
  if (entries.some((existing) => queueLaneKey(existing) === lane
    && existing.status !== "committed"
    && existing.status !== "superseded")) return false;
  return evidenceCoversCheckCommands(store, taskId, entry.evidenceRefs, entry.checkCommands);
}

/**
 * Resolve each reusable evidence reference to its ReviewRound and collect the
 * names of checks that passed.  A requested gate command is covered only when
 * a resolved round recorded that exact command as passed.  A review that ran
 * `true` (or any other unrelated check) never waives a different gate.
 *
 * A check is reusable only when it ran on the frozen candidate tree.  A
 * ReviewRound must attest to this by recording its `evidenceCommit` as the
 * exact `reviewBaseCommit`.  A missing `evidenceCommit` is ambiguous: the
 * reviewer may have run checks with uncommitted dirty diagnostics, so the
 * absence cannot be treated as frozen-tree proof.  A round whose
 * `evidenceCommit` differs from its `reviewBaseCommit` ran its checks on a
 * diagnostic tree (the reviewer's own commit with review-only changes); those
 * checks proved a different tree and cannot waive the candidate gate.
 */
function evidenceCoversCheckCommands(
  store: TaskStore,
  taskId: string,
  evidenceRefs: readonly string[],
  checkCommands: readonly string[]
): boolean {
  if (checkCommands.length === 0) return true;
  const covered = new Set<string>();
  for (const ref of evidenceRefs) {
    const roundId = parseReviewRoundRef(ref);
    if (roundId === undefined) continue;
    const round = store.getReviewRound(taskId, roundId);
    if (round === null || round.status !== "completed") continue;
    if (round.evidenceCommit !== round.reviewBaseCommit) continue;
    for (const check of round.checks ?? []) {
      if (check.outcome === "passed") covered.add(check.name);
    }
  }
  return checkCommands.every((cmd) => covered.has(cmd));
}

function parseReviewRoundRef(ref: string): string | undefined {
  const prefix = "review-round:";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
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
    await reconcileTerminalAttempts(store, task.id, git, now);
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
    const targetBefore = (await git.inspect(project.path, exactBranchRef(candidate.targetRef))).baseCommit;
    // Evidence fence: a validated entry's reusable evidence only covers the
    // exact target head it was validated against.  An out-of-band target
    // advance (another Task) that touches the entry's paths, or whose impact
    // cannot be proven, invalidates the evidence: requeue and run its checks.
    if (candidate.status === "validated"
      && await evidenceTargetAdvanced(
        git, project.path, candidate, targetBefore, store, task.id
      )) {
      store.transaction((tx) => {
        assertTaskActive(tx, task.id);
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
      // Task-active fence: the Task may have retired between the pre-flight
      // read and this commit.  A terminal Task must not gain a new running
      // Integration Attempt.  This throws (not caught by the Candidate-fence
      // handler below) so the caller sees the rejection.
      assertTaskActive(tx, task.id);
      // Current-Candidate fence: a queued ChangeSet whose producer WorkItem
      // entered retry (or whose latest Candidate no longer matches) must not
      // advance the target.  Mark it conflicted so the Leader can supersede
      // or re-enqueue a fresh ChangeSet.
      try {
        const changeSet = tx.getChangeSet(task.id, current.changeSetId);
        if (changeSet === null) {
          throw new Error(`ChangeSet not found: ${current.changeSetId}.`);
        }
        assertCurrentCandidateInStore(tx, task.id, changeSet);
      } catch (error) {
        const running = markIntegrationQueueRunning(current, targetBefore, now());
        tx.saveIntegrationQueueEntry(task.id, running);
        tx.saveIntegrationQueueEntry(task.id, markIntegrationQueueBlocked(
          running,
          error instanceof Error ? error.message : String(error),
          now()
        ));
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
      return entry;
    });
    if (result.status === "committed") {
      const project = store.getProject(settled.projectId);
      if (project !== null) {
        await recomputeAffectedPaths(store, task.id, settled, project.path, git, now);
      }
    }
    processed.push({ entry: settled, attempt: result.attempt, result });
  }
  return processed;
}

/**
 * A queue lane serializes one target ref: entries for the same Project and
 * targetRef integrate one at a time in id order.  Entries of different lanes
 * (another Project or ref) do not share a target and may integrate alongside.
 */
/**
 * Canonicalise a Git ref so that "master" and "refs/heads/master" share one
 * lane.  Only the `refs/heads/` prefix is stripped; other ref namespaces
 * (tags, remotes) are kept distinct.
 */
function canonicalizeTargetRef(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/**
 * Resolve a canonical target ref to its exact Git ref for inspection.  A
 * short name or `refs/heads/*` resolves to the exact branch ref, so a
 * same-named tag cannot shadow the branch.  Other fully-qualified refs
 * keep their exact meaning.
 */
function exactBranchRef(canonicalRef: string): string {
  return canonicalRef.startsWith("refs/") ? canonicalRef : `refs/heads/${canonicalRef}`;
}

function queueLaneKey(entry: IntegrationQueueEntry): string {
  return `${entry.projectId} ${canonicalizeTargetRef(entry.targetRef)}`;
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
  // read any file — including the exact target SHA the evidence is bound to.
  // A changed target SHA invalidates exact-SHA evidence regardless of tree
  // identity, so any entry with checks must re-run its gate.  An entry
  // without checks has nothing to re-run and may commit directly.
  return entry.checkCommands.length > 0;
}

/**
 * A conflicted entry whose manual-resolution Attempt committed converges.  The
 * settle happens in one transaction; the downstream affected-path recompute
 * follows with the same committed evidence, so waiting successors never keep
 * stale overlap evidence.
 */
export async function reconcileIntegrationQueueEntry(
  store: TaskStore,
  taskId: string,
  entryId: string,
  git: IntegrationQueueGitPort,
  now: () => Date = () => new Date()
): Promise<IntegrationQueueEntry> {
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
  const committed = store.transaction((tx) => {
    const settled = markIntegrationQueueCommitted(entry, committedTargetAfter(attempt), now());
    tx.saveIntegrationQueueEntry(taskId, settled);
    return settled;
  });
  const project = store.getProject(committed.projectId);
  if (project !== null) {
    await recomputeAffectedPaths(store, taskId, committed, project.path, git, now);
  }
  return committed;
}

/**
 * A conflicted entry may carry a blocked IntegrationAttempt waiting for a
 * leader decision.  Requeue or supersede IS that decision — the blocked
 * attempt is abandoned — so resolve it as rejected (terminal `failed`)
 * rather than leaving it to block Task retirement.
 */
function resolveBlockedAttempt(
  store: TaskStore,
  taskId: string,
  entry: IntegrationQueueEntry,
  decision: "requeue" | "supersede",
  now: () => Date
): void {
  if (entry.integrationAttemptId === undefined) return;
  const attempt = store.getIntegrationAttempt(taskId, entry.integrationAttemptId);
  if (attempt === null || attempt.status !== "blocked") return;
  const rejected = recordResolutionDecision(attempt, {
    action: "reject",
    rationale: `Integration Attempt rejected by queue ${decision}.`
  }, now());
  store.saveIntegrationAttempt(taskId, rejected);
}

/**
 * A linked Integration Attempt that is actively processing or already
 * committed cannot be discarded by requeue or supersede.  Only a blocked
 * Attempt (finalized by resolveBlockedAttempt) or a failed one is safe to
 * recover; a running, validating, or committed Attempt would leave the
 * queue entry contradicting the Attempt/target state.
 */
function assertRecoverableAttempt(
  store: TaskStore,
  taskId: string,
  entry: IntegrationQueueEntry,
  action: string
): void {
  if (entry.integrationAttemptId === undefined) return;
  const attempt = store.getIntegrationAttempt(taskId, entry.integrationAttemptId);
  if (attempt === null) return;
  if (attempt.status !== "blocked" && attempt.status !== "failed") {
    throw new Error(
      `Integration queue entry ${entry.id} is backed by ${attempt.status} `
      + `Integration Attempt ${attempt.id}; reconcile the queue entry instead `
      + `of ${action} it.`
    );
  }
}

/** Retry a conflicted item (for example after a gate failure was fixed). */
export function requeueIntegrationQueueEntry(
  store: TaskStore,
  taskId: string,
  entryId: string,
  now: () => Date = () => new Date()
): IntegrationQueueEntry {
  // The committed-Attempt guard, the blocked-Attempt finalization, and the
  // queue write must be atomic: a concurrent manual-resolution continue can
  // commit the Attempt between the guard and the write, leaving the queue
  // entry requeued behind a committed target.
  return store.transaction((tx) => {
    assertTaskActive(tx, taskId);
    const entry = tx.getIntegrationQueueEntry(taskId, entryId);
    if (entry === null) {
      throw new Error(`Integration queue entry not found: ${taskId}/${entryId}.`);
    }
    assertRecoverableAttempt(tx, taskId, entry, "requeue");
    resolveBlockedAttempt(tx, taskId, entry, "requeue", now);
    const waiting = markIntegrationQueueRequeued(entry, now());
    tx.saveIntegrationQueueEntry(taskId, waiting);
    return waiting;
  });
}

export function supersedeIntegrationQueueEntry(
  store: TaskStore,
  taskId: string,
  entryId: string,
  reason: string,
  now: () => Date = () => new Date()
): IntegrationQueueEntry {
  return store.transaction((tx) => {
    const entry = tx.getIntegrationQueueEntry(taskId, entryId);
    if (entry === null) {
      throw new Error(`Integration queue entry not found: ${taskId}/${entryId}.`);
    }
    assertRecoverableAttempt(tx, taskId, entry, "supersede");
    resolveBlockedAttempt(tx, taskId, entry, "supersede", now);
    const superseded = markIntegrationQueueSuperseded(entry, reason, now());
    tx.saveIntegrationQueueEntry(taskId, superseded);
    return superseded;
  });
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
async function reconcileTerminalAttempts(
  store: TaskStore,
  taskId: string,
  git: IntegrationQueueGitPort,
  now: () => Date
): Promise<void> {
  for (const entry of store.listIntegrationQueueEntries(taskId)) {
    if (entry.integrationAttemptId === undefined) continue;
    if (entry.status === "committed") {
      // Crash window: the settle marked this entry committed but died before
      // recomputing downstream affectedPaths.  Replay that update idempotently
      // so waiting entries regain their overlap evidence.
      const project = store.getProject(entry.projectId);
      if (project !== null) {
        await recomputeAffectedPaths(store, taskId, entry, project.path, git, now);
      }
      continue;
    }
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
      const project = store.getProject(committed.projectId);
      if (project !== null) {
        await recomputeAffectedPaths(store, taskId, committed, project.path, git, now);
      }
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

async function recomputeAffectedPaths(
  store: TaskStore,
  taskId: string,
  committed: IntegrationQueueEntry,
  projectPath: string,
  git: IntegrationQueueGitPort,
  now: () => Date
): Promise<void> {
  const committedChangeSet = store.getChangeSet(taskId, committed.changeSetId);
  if (committedChangeSet === null) return;
  const landed = new Set(committedChangeSet.changedPaths);
  for (const entry of store.listIntegrationQueueEntries(taskId)) {
    if (entry.projectId !== committed.projectId) continue;
    if (canonicalizeTargetRef(entry.targetRef) !== canonicalizeTargetRef(committed.targetRef)) continue;
    if (entry.status !== "queued" && entry.status !== "validated") continue;
    const changeSet = store.getChangeSet(taskId, entry.changeSetId);
    if (changeSet === null) continue;
    // A committed entry whose targetAfter is already an ancestor of the
    // waiting entry's baseCommit is part of that entry's base, not a
    // post-enqueue target advance.  This prevents recovery replay from
    // reviving evidence that was valid at enqueue time, and covers both
    // the direct predecessor and transitive history cases.
    if (committed.targetAfter !== undefined
      && await git.isAncestor(projectPath, committed.targetAfter, changeSet.baseCommit)) continue;
    const affected = changeSet.changedPaths.filter((path) => landed.has(path));
    // Re-read inside the transaction: a concurrent processor may have claimed
    // or conflicted this entry during the async isAncestor gap above.  Only
    // persist the recompute when the entry is still waiting to be processed.
    store.transaction((tx) => {
      const current = tx.getIntegrationQueueEntry(taskId, entry.id);
      if (current === null) return;
      if (current.status !== "queued" && current.status !== "validated") return;
      let updated = recordIntegrationQueueAffectedPaths(current, affected, now());
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
      if (updated.status !== current.status
        || (updated.affectedPaths ?? []).join("\n") !== (current.affectedPaths ?? []).join("\n")) {
        tx.saveIntegrationQueueEntry(taskId, updated);
      }
    });
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
  historyHead: string,
  baseCommit: string
): Promise<string | null> {
  if (git.findCommitWithSameTreeInHistory === undefined) {
    return (await git.isAncestor(repositoryPath, sourceCommit, historyHead))
      ? sourceCommit
      : null;
  }
  const found = await git.findCommitWithSameTreeInHistory({
    repositoryPath,
    sourceCommit,
    historyHead
  });
  if (found === null) return null;
  // The exact source commit landing on the target is integration evidence
  // regardless of the base relationship.  A different same-tree commit is
  // only evidence when it is at or after the ChangeSet base: a same-tree
  // commit older than the base is history the ChangeSet may be deliberately
  // restoring, not proof that the restore landed.
  if (found === sourceCommit) return found;
  return (await git.isAncestor(repositoryPath, baseCommit, found)) ? found : null;
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
  // A migrated v2 ChangeSet without a manifest has no deletedPaths.  Recover
  // the actual deletions from git so the containment proof verifies both
  // sides of a rename: without this, a rename whose destination already
  // exists on the target would converge even though the source still lives
  // there.  A ChangeSet with a manifest trusts its declared deletedPaths.
  let extraDeleted: readonly string[] = [];
  if (changeSet.manifest === undefined) {
    if (git.deletedFilesBetween === undefined) return null;
    extraDeleted = await git.deletedFilesBetween({
      repositoryPath,
      fromCommit: changeSet.baseCommit,
      toCommit: changeSet.headCommit
    });
  }
  const paths = [...new Set([
    ...changeSet.changedPaths,
    ...(changeSet.manifest?.deletedPaths ?? []),
    ...extraDeleted
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
