import { usageError } from "../errors/cliError.js";
import {
  GitIntegrationService,
  type RemoteBaseline
} from "../integration/gitIntegrationService.js";
import {
  createIntegrationAttempt,
  type IntegrationAttempt
} from "../integration/integrationAttempt.js";
import {
  NodeGitWorkspace,
  type GitWorkspacePort,
  type GitRemoteHead
} from "../repository/gitWorkspace.js";
import type { Project } from "../repository/project.js";
import type { Task } from "../task/task.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  workspaceProjectEntry,
  type ManagedWorkspace,
  type WorkspaceProjectEntry
} from "../worktree/managedWorkspace.js";

type CompletionGateOptions = Readonly<{
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
  git?: GitWorkspacePort;
}>;

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
  previousIntegration: IntegrationAttempt;
}>;

/**
 * Reconcile configured remote baselines before a Task completion attempt.
 *
 * Remote resolution and fetches happen from the Task's managed worktree.  A
 * moved remote is represented by a new Integration Attempt that reuses the
 * already integrated ChangeSets, runs the existing Project checks, and lets
 * the normal target CAS advance the Task branch.  Stable Project checkouts
 * are never refreshed or otherwise mutated here.
 */
export async function reconcileTaskRemoteBaselines(
  taskId: string,
  store: TaskStore,
  home: string,
  options: CompletionGateOptions = {}
): Promise<readonly RemoteReconciliation[]> {
  const task = store.getTask(taskId);
  if (task === null) throw usageError(`Task not found: ${taskId}.`);
  // The delivery contract opts Project-backed Tasks into committed
  // Integration evidence.  Metadata-only Tasks retain their existing local
  // completion semantics and have no remote baseline to reconcile here.
  if (task.projectBindings.length === 0 || task.requireIntegration !== true) return [];
  const workspace = requireTaskWorkspace(store, task);
  const git = options.git ?? new NodeGitWorkspace();
  if (git.fetchRemoteHeadIntoWorktree === undefined
    || git.mergeRemoteIntoWorktree === undefined) {
    throw usageError(
      `Task ${task.id} cannot verify remote baselines: managed Git workspace support is unavailable.`
    );
  }

  // A completed Task-final Review that exactly covers the current frozen heads
  // is the final review evidence.  Do not reconcile the remote after a clean
  // review, as merging a moved remote would change the reviewed head and
  // invalidate the review.
  if (await hasCompletedTaskFinalReviewForCurrentCandidate(store, task, workspace, git)) {
    return [];
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
    const previousIntegration = latestCommittedIntegration(store, task.id, project.id);
    // Let the existing exact-head Task-final gate report local post-
    // Integration drift before attempting any network operation.  This keeps
    // completion read-only for an already-invalid candidate and preserves its
    // precise recovery guidance.
    if (previousIntegration !== undefined
      && previousIntegration.candidateCommit !== currentCommit) {
      continue;
    }
    const remote = await fetchRemote(git, entry, project);
    if (remote.commit === currentCommit) continue;
    if (await git.isAncestor(entry.path, remote.commit, currentCommit)) continue;

    if (previousIntegration === undefined) {
      throw usageError(
        `Project ${project.id} remote target moved to ${remote.commit}, but no committed `
        + "Integration can establish a safe Task baseline."
      );
    }
    if (previousIntegration.candidateCommit !== currentCommit) {
      throw usageError(
        `Project ${project.id} Task head ${currentCommit} does not match its latest committed `
        + `Integration ${previousIntegration.id}; settle that drift before remote reconciliation.`
      );
    }
    if (!await git.isClean(entry.path)) {
      throw usageError(
        `Project ${project.id} managed Task workspace is dirty; commit or clean it before remote reconciliation.`
      );
    }
    plans.push({ project, entry, remote, currentCommit, previousIntegration });
  }

  const reconciled: RemoteReconciliation[] = [];
  for (const plan of plans) {
    const attempt = store.transaction((tx) => {
      const created = createIntegrationAttempt({
        id: tx.nextIntegrationAttemptId(task.id),
        taskId: task.id,
        projectId: plan.project.id,
        targetRef: plan.entry.branch,
        expectedHead: plan.currentCommit,
        changeSetIds: plan.previousIntegration.changeSetIds,
        checkCommands: plan.previousIntegration.checkCommands
      }, options.now?.() ?? new Date());
      tx.saveIntegrationAttempt(task.id, created);
      return created;
    });
    const baseline: RemoteBaseline = {
      remoteUrl: plan.project.remoteUrl!,
      branch: plan.remote.branch
    };
    const result = await new GitIntegrationService(
      home,
      store,
      git,
      options.now ?? (() => new Date()),
      options.environment
    ).integrate(task.id, attempt.id, { remoteBaseline: baseline });
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

/**
 * Check whether the latest Task-final ReviewRound is completed and its
 * immutable candidate exactly matches the current actual heads for every
 * Project in the Task.  When this holds, the reviewed head is the final
 * head and remote reconciliation must not change it.
 */
async function hasCompletedTaskFinalReviewForCurrentCandidate(
  store: TaskStore,
  task: Task,
  workspace: ManagedWorkspace,
  git: GitWorkspacePort
): Promise<boolean> {
  const rounds = store.listReviewRounds(task.id)
    .filter((round) => (round.scope ?? "work-item") === "task")
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
  const latest = rounds.at(-1);
  if (latest === undefined || latest.status !== "completed") return false;
  if (latest.taskCandidate === undefined) return false;

  const candidateProjects = new Map(
    latest.taskCandidate.projects.map((entry) => [entry.projectId, entry.commit])
  );
  for (const binding of task.projectBindings) {
    const reviewedCommit = candidateProjects.get(binding.projectId);
    if (reviewedCommit === undefined) return false;
    const entry = workspaceProjectEntry(workspace, binding.projectId);
    if (entry === undefined || entry.access !== "write") return false;
    const actualHead = (await git.inspect(entry.path, "HEAD")).baseCommit;
    if (actualHead !== reviewedCommit) return false;
  }
  return true;
}

function latestCommittedIntegration(
  store: TaskStore,
  taskId: string,
  projectId: string
): IntegrationAttempt | undefined {
  return store.listIntegrationAttempts(taskId)
    .filter((attempt) => attempt.projectId === projectId && attempt.status === "committed")
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
    .at(-1);
}
