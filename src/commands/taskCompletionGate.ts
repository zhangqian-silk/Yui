import { isDeepStrictEqual } from "node:util";
import { usageError } from "../errors/cliError.js";
import {
  GitIntegrationService,
  type IntegrationJobPort
} from "../integration/gitIntegrationService.js";
import {
  createIntegrationAttempt
} from "../integration/integrationAttempt.js";
import {
  NodeGitWorkspace,
  type GitWorkspacePort,
  type GitRemoteHead
} from "../repository/gitWorkspace.js";
import type { Project } from "../repository/project.js";
import type { Task } from "../task/task.js";
import { publicationExternalKey } from "../task/publicationReference.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { ReviewRound, TaskReviewCandidate } from "../review/reviewRound.js";
import { isCompletedTaskReviewEvidence } from "../review/reviewAcceptance.js";
import {
  workspaceProjectEntry,
  type ManagedWorkspace,
  type WorkspaceProjectEntry
} from "../worktree/managedWorkspace.js";

type CompletionGateOptions = Readonly<{
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
  git?: GitWorkspacePort;
  /**
   * f7: The Controller IntegrationJobPort so non-empty checks run as
   * DurableJobs instead of in the Leader/CLI process. Required for the
   * remote-baseline path to avoid leaving running/no-check zombies.
   */
  jobPort?: IntegrationJobPort;
}>;

export type TaskCompletionPublishedTreeProof = Readonly<{
  taskId: string;
  projectId: string;
  publicationId: string;
  reviewRoundId?: string;
  localCommit: string;
  remoteCommit: string;
  tree: string;
}>;

/**
 * Verify the one supported ancestry waiver before `task complete` mutates any
 * durable state. The explicit Publication must be the current verified merged
 * record, bind the exact physical Task head (and, when WorkItems exist, its
 * completed final Review), and name an ancestry-divergent commit with the
 * exact same Git tree.
 */
export async function verifyTaskCompletionPublishedTree(
  taskId: string,
  publicationId: string,
  store: TaskStore,
  options: Pick<CompletionGateOptions, "git"> = {}
): Promise<TaskCompletionPublishedTreeProof> {
  const task = store.getTask(taskId);
  if (task === null) throw usageError(`Task not found: ${taskId}.`);
  if (task.status !== "active") {
    throw usageError(`Task is not active: ${task.id}.`);
  }
  const publication = requireCurrentVerifiedPublication(store, task.id, publicationId);
  const binding = task.projectBindings.find(({ projectId }) => (
    projectId === publication.projectId
  ));
  if (binding === undefined) {
    throw usageError(
      `Publication ${publication.id} Project is not bound to Task ${task.id}: `
      + `${publication.projectId}.`
    );
  }
  if (publication.localCommit === undefined || publication.remoteCommit === undefined) {
    throw usageError(
      `Publication ${publication.id} must record exact local and remote commits.`
    );
  }

  const workspace = requireTaskWorkspace(store, task);
  const git = options.git ?? new NodeGitWorkspace();
  const actualHeads = new Map<string, string>();
  for (const taskBinding of task.projectBindings) {
    const entry = workspaceProjectEntry(workspace, taskBinding.projectId);
    if (entry === undefined || entry.access !== "write") {
      throw usageError(
        `Task ${task.id} has no writable managed main workspace for Project ${taskBinding.projectId}.`
      );
    }
    const actualCommit = (await git.inspect(entry.path, "HEAD")).baseCommit;
    actualHeads.set(taskBinding.projectId, actualCommit);
  }
  const actualCandidate: TaskReviewCandidate = {
    schemaVersion: 1,
    projects: task.projectBindings.map(({ projectId }) => ({
      projectId,
      commit: actualHeads.get(projectId)!
    }))
  };
  const latestReview = acceptedTaskFinalReviews(store, task.id)
    .find((round) => (
      round.taskCandidate !== undefined
      && sameTaskCandidate(round.taskCandidate, actualCandidate)
    ));

  const entry = workspaceProjectEntry(workspace, publication.projectId)!;
  const localCommit = actualHeads.get(publication.projectId)!;
  if (publication.localCommit !== localCommit) {
    throw usageError(
      `Publication ${publication.id} local commit ${publication.localCommit} `
      + `does not match Task head ${localCommit}.`
    );
  }

  let remoteCommit: string;
  let localTree: string;
  let remoteTree: string;
  try {
    remoteCommit = (await git.inspect(entry.path, publication.remoteCommit)).baseCommit;
    [localTree, remoteTree] = await Promise.all([
      git.resolveTree(entry.path, localCommit),
      git.resolveTree(entry.path, remoteCommit)
    ]);
  } catch (error) {
    throw usageError(
      `Publication ${publication.id} commit/tree evidence is unavailable: `
      + `${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (remoteCommit !== publication.remoteCommit) {
    throw usageError(
      `Publication ${publication.id} remote commit changed: expected `
      + `${publication.remoteCommit}, found ${remoteCommit}.`
    );
  }
  const [localContainsRemote, remoteContainsLocal] = await Promise.all([
    git.isAncestor(entry.path, remoteCommit, localCommit),
    git.isAncestor(entry.path, localCommit, remoteCommit)
  ]);
  if (localContainsRemote || remoteContainsLocal) {
    throw usageError(
      `Publication ${publication.id} is not ancestry-divergent from Task head ${localCommit}; `
      + "use normal Task completion."
    );
  }
  if (localTree !== remoteTree) {
    throw usageError(
      `Publication ${publication.id} Git trees differ: `
      + `${localCommit}^{tree}=${localTree}, ${remoteCommit}^{tree}=${remoteTree}.`
    );
  }

  return {
    taskId: task.id,
    projectId: publication.projectId,
    publicationId: publication.id,
    ...(latestReview === undefined ? {} : { reviewRoundId: latestReview.id }),
    localCommit,
    remoteCommit,
    tree: localTree
  };
}

/** Re-derive every durable half of the asynchronous Git proof under the Task
 * completion transaction. The physical heads are the CLI snapshot captured
 * immediately before mutation; any record or head drift fails closed. */
export function assertTaskCompletionPublishedTreeProof(
  store: TaskStore,
  task: Task,
  publicationId: string,
  proof: TaskCompletionPublishedTreeProof | undefined,
  actualCandidate: TaskReviewCandidate
): TaskCompletionPublishedTreeProof {
  if (proof === undefined
    || proof.taskId !== task.id
    || proof.publicationId !== publicationId) {
    throw usageError(
      `Published-tree completion proof is missing or mismatched for ${task.id}/${publicationId}.`
    );
  }
  const publication = requireCurrentVerifiedPublication(store, task.id, publicationId);
  if (publication.projectId !== proof.projectId
    || publication.localCommit !== proof.localCommit
    || publication.remoteCommit !== proof.remoteCommit) {
    throw usageError(`Publication evidence changed before Task completion: ${publication.id}.`);
  }
  if (proof.reviewRoundId !== undefined) {
    const review = store.getReviewRound(task.id, proof.reviewRoundId);
    if (review === null
      || !isCompletedTaskReviewEvidence(store, review)
      || review.taskCandidate === undefined
      || !sameTaskCandidate(review.taskCandidate, actualCandidate)) {
      throw usageError(
        `Task-final Review evidence changed before published-tree completion: ${task.id}.`
      );
    }
  }
  const actualCommit = actualCandidate.projects.find(({ projectId }) => (
    projectId === proof.projectId
  ))?.commit;
  if (actualCommit !== proof.localCommit) {
    throw usageError(
      `Task head changed before published-tree completion: `
      + `${proof.projectId}@${actualCommit ?? "missing"}.`
    );
  }
  return proof;
}

function requireCurrentVerifiedPublication(
  store: TaskStore,
  taskId: string,
  publicationId: string
) {
  const publication = store.getPublicationReference(taskId, publicationId);
  if (publication === null) {
    throw usageError(`Publication reference not found: ${taskId}/${publicationId}.`);
  }
  const current = store.findPublicationReferenceByExternalKey(
    publicationExternalKey(publication)
  );
  if (current === null || current.taskId !== taskId || current.id !== publication.id) {
    throw usageError(
      `Publication ${publication.id} is not the current unsuperseded record for its external identity.`
    );
  }
  if (publication.state !== "merged" || publication.verification !== "verified") {
    throw usageError(
      `Publication ${publication.id} must be merged and verified before Task completion.`
    );
  }
  return publication;
}

function acceptedTaskFinalReviews(
  store: TaskStore,
  taskId: string
): readonly ReviewRound[] {
  return store.listReviewRounds(taskId)
    .filter((round) => isCompletedTaskReviewEvidence(store, round))
    .sort((left, right) => (
      right.id.localeCompare(left.id, undefined, { numeric: true })
    ));
}

function sameTaskCandidate(
  left: TaskReviewCandidate,
  right: TaskReviewCandidate
): boolean {
  return left.projects.length === right.projects.length
    && left.projects.every((project, index) => (
      project.projectId === right.projects[index]?.projectId
      && project.commit === right.projects[index]?.commit
    ));
}

export type RemoteReconciliation = Readonly<{
  projectId: string;
  remote: GitRemoteHead;
  fromCommit: string;
  toCommit: string;
  integrationId: string;
}>;

type RemotePlan = Readonly<{
  project: Project;
  entry: WorkspaceProjectEntry;
  remote: GitRemoteHead;
  currentCommit: string;
  taskBaseCommit: string;
}>;

/**
 * Reconcile configured remote baselines before a Task completion attempt.
 *
 * Remote resolution and fetches happen from the Task's managed worktree.  A
 * moved remote is represented by a normal upstream Integration Attempt. The
 * normal check and CAS path advances only the Task clone; stable Project
 * checkouts are never refreshed or otherwise mutated here.
 */
export async function reconcileTaskRemoteBaselines(
  taskId: string,
  store: TaskStore,
  home: string,
  options: CompletionGateOptions = {}
): Promise<readonly RemoteReconciliation[]> {
  const task = store.getTask(taskId);
  if (task === null) throw usageError(`Task not found: ${taskId}.`);
  if (task.projectBindings.length === 0) {
    return [];
  }
  const workspace = requireTaskWorkspace(store, task);
  const git = options.git ?? new NodeGitWorkspace();
  if (git.fetchRemoteHeadIntoWorktree === undefined) {
    throw usageError(
      `Task ${task.id} cannot verify remote baselines: managed Git workspace support is unavailable.`
    );
  }

  const plans: RemotePlan[] = [];
  for (const binding of task.projectBindings) {
    const project = store.getProject(binding.projectId);
    if (project === null) {
      throw usageError(`Project not found for Task ${task.id}: ${binding.projectId}.`);
    }
    if (project.remoteUrl === undefined) continue;
    const entry = workspaceProjectEntry(workspace, project.id);
    if (entry === undefined || entry.access !== "write") {
      throw usageError(
        `Task ${task.id} has no writable managed main workspace for remote Project ${project.id}.`
      );
    }
    const currentCommit = (await git.inspect(entry.path, "HEAD")).baseCommit;
    if (binding.currentCommit !== currentCommit || binding.baseCommit === undefined) {
      throw usageError(
        `Project ${project.id} Task commit record does not match its authoritative main clone.`
      );
    }
    const remote = await fetchRemote(git, entry, project);
    if (remote.commit === currentCommit) continue;
    if (await git.isAncestor(entry.path, remote.commit, currentCommit)) continue;

    if (!await git.isClean(entry.path)) {
      throw usageError(
        `Project ${project.id} managed Task workspace is dirty; commit or clean it before remote reconciliation.`
      );
    }
    plans.push({
      project,
      entry,
      remote,
      currentCommit,
      taskBaseCommit: binding.baseCommit
    });
  }

  const reconciled: RemoteReconciliation[] = [];
  for (const plan of plans) {
    const attempt = store.transaction((tx) => {
      const created = createIntegrationAttempt({
        id: tx.nextIntegrationAttemptId(task.id),
        taskId: task.id,
        projectId: plan.project.id,
        targetRef: plan.entry.branch,
        beforeCommit: plan.currentCommit,
        source: {
          kind: "upstream",
          branch: plan.remote.branch,
          remoteCommit: plan.remote.commit,
          taskBaseCommit: plan.taskBaseCommit,
          strategy: "rebase"
        },
        checkCommands: []
      }, options.now?.() ?? new Date());
      tx.saveIntegrationAttempt(task.id, created);
      return created;
    });
    const result = await new GitIntegrationService(
      home,
      store,
      git,
      options.now ?? (() => new Date()),
      options.environment,
      undefined,
      options.jobPort
    ).integrate(task.id, attempt.id);
    // rr6/f3: A moved remote with non-empty checks spawns a DurableJob. This
    // is a pending completion outcome, not a failure: name the exact
    // Integration and Job and the exact continuation command (mirroring the
    // `task integration` checks-running message) so the caller can resume the
    // same remote-reconciliation attempt instead of being blocked by the
    // preflight's active-job/unresolved-Integration gates.
    if (result.status === "checks-running") {
      throw usageError(
        `Remote baseline reconciliation for ${task.id}/${plan.project.id} is running checks as `
        + `Integration ${result.attempt.id} (DurableJob ${result.job.id}); run `
        + `'yui task integration continue ${task.id}/${result.attempt.id}' when the job finishes, `
        + `then retry task complete.`
      );
    }
    if (result.status !== "committed" || result.attempt.candidateCommit === undefined) {
      const detail = result.attempt.checks?.find(({ outcome }) => outcome === "failed")?.details
        ?? result.attempt.conflict?.summary
        ?? result.attempt.status;
      throw usageError(
        `Remote baseline reconciliation failed for ${task.id}/${plan.project.id}: ${detail}`
      );
    }
    reconciled.push({
      projectId: plan.project.id,
      remote: plan.remote,
      fromCommit: plan.currentCommit,
      toCommit: result.attempt.candidateCommit,
      integrationId: attempt.id
    });
  }
  return reconciled;
}

async function fetchRemote(
  git: GitWorkspacePort,
  entry: WorkspaceProjectEntry,
  project: Project
): Promise<GitRemoteHead> {
  try {
    return await git.fetchRemoteHeadIntoWorktree!({
      repositoryPath: entry.path,
      remoteUrl: project.remoteUrl!,
      branch: project.developmentBranch
    });
  } catch (error) {
    throw usageError(
      `Project ${project.id} remote target could not be resolved; completion is fail-closed: `
      + `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function requireTaskWorkspace(store: TaskStore, task: Task): ManagedWorkspace {
  const workspace = store.getTaskWorkspace(task.id);
  if (workspace === null || workspace.owner.type !== "task") {
    throw usageError(`Task ${task.id} has no authoritative managed main workspace.`);
  }
  return workspace;
}
