import { usageError } from "../errors/cliError.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { NodeGitWorkspace, type GitWorkspacePort } from "../repository/gitWorkspace.js";
import { acquireProjectMaintenanceLock } from "../repository/projectMaintenanceLock.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
import { workspaceProjectEntry } from "../worktree/managedWorkspace.js";

/**
 * RFC Phase 4: Active Task upstream integration.
 *
 * After activation, the initial baseline is a historical fact. Introducing new
 * upstream code is a normal upstream integration, not a baseline rewrite. This
 * command resolves the exact upstream commit, merges it into the Task
 * worktree, and records the result as a Task event.  On failure, the original
 * HEAD is restored so Task commits are not lost.
 */

export type TaskUpstreamCommandOptions = Readonly<{
  git?: GitWorkspacePort;
  now?: () => Date;
}>;

export type TaskUpstreamCommandResult = Readonly<{
  output: string;
  data?: unknown;
}>;

export async function runTaskUpstreamCommand(
  args: readonly string[],
  store: TaskStore,
  options: TaskUpstreamCommandOptions = {}
): Promise<TaskUpstreamCommandResult> {
  const [command, ...rest] = args;
  if (command === "integrate") {
    return integrateUpstream(rest, store, options);
  }
  throw usageError(
    command === undefined
      ? "Task upstream command is required."
      : `Unknown command: task upstream ${command}`
  );
}

async function integrateUpstream(
  args: readonly string[],
  store: TaskStore,
  options: TaskUpstreamCommandOptions
): Promise<TaskUpstreamCommandResult> {
  const usage = "Task upstream integrate usage: yui task upstream integrate <task> [--latest] [--project <project>].";
  const taskId = args[0];
  if (taskId === undefined) throw usageError(usage);
  const flags = new Set(args.slice(1));
  if (flags.size !== args.length - 1) {
    throw usageError(usage);
  }
  const latest = flags.has("--latest");
  const projectFlag = args.find((arg) => arg.startsWith("--project="));
  const projectRef = projectFlag?.slice("--project=".length);
  if (!latest && projectRef === undefined) {
    throw usageError("Specify --latest to integrate the remote development head, or --project=<project> to target one Project.");
  }
  if (latest && projectRef !== undefined) {
    throw usageError("--latest and --project are mutually exclusive.");
  }
  for (const flag of flags) {
    if (flag !== "--latest" && !flag.startsWith("--project=")) {
      throw usageError(usage);
    }
  }

  const task = store.getTask(taskId);
  if (task === null) throw usageError(`Task not found: ${taskId}.`);
  if (task.status !== "active") {
    throw usageError(`Task must be active to integrate upstream: ${taskId}/${task.status}.`);
  }
  // RFC Phase 4: integrating upstream rewrites the Task worktree HEAD. Refuse
  // while the Leader has an active Run so the merge never lands under a
  // running Session.
  const activeLeaderRun = store.getActiveAgentRun(taskId, "leader");
  if (activeLeaderRun !== null) {
    throw usageError(
      `Task has an active Leader Run (${activeLeaderRun.id}); stop it before integrating upstream: ${taskId}.`
    );
  }
  const workspace = store.getTaskWorkspace(taskId);
  if (workspace === null) {
    throw usageError(`Task has no workspace: ${taskId}. Activate it first.`);
  }

  const git = options.git ?? new NodeGitWorkspace();
  const now = options.now ?? (() => new Date());
  const results: Array<{
    projectId: string;
    oldHead: string;
    newHead: string;
    upstreamCommit: string;
  }> = [];

  for (const binding of task.projectBindings) {
    if (projectRef !== undefined && binding.projectId !== projectRef) continue;
    const project = store.getProject(binding.projectId);
    if (project === null) {
      throw usageError(`Project not found: ${binding.projectId}.`);
    }
    if (project.remoteUrl === undefined) {
      throw usageError(`Project has no remote URL: ${project.id}.`);
    }
    const entry = workspaceProjectEntry(workspace, project.id);
    if (entry === undefined) {
      throw usageError(`Task workspace has no entry for Project: ${project.id}.`);
    }

    // Hold the per-Project maintenance fence while resolving the remote
    // baseline so a concurrent `project refresh` cannot interleave with the
    // fetch.
    const releaseMaintenance = acquireProjectMaintenanceLock(store.rootDirectory(), project.id);
    let oldHead: string;
    let newHead: string;
    let upstreamCommit: string;
    try {
      // Resolve the exact upstream commit.
      const upstream = await git.resolveRemoteBaseline({
        repositoryPath: project.path,
        remoteUrl: project.remoteUrl,
        developmentRef: project.developmentBranch
      });
      upstreamCommit = upstream.commit;

      // Record the current HEAD as a backup before merging.
      const current = await git.inspect(entry.path, "HEAD");
      oldHead = current.baseCommit;

      try {
        // mergeWorktree always creates a merge commit (--no-ff); record the
        // actual resulting HEAD rather than assuming a fast-forward.
        await git.mergeWorktree({
          targetPath: entry.path,
          sourceRefs: [upstream.commit]
        });
      } catch (error) {
        // Restore the original HEAD on failure.  mergeWorktree already aborts
        // a conflicted merge, so HEAD is usually already at oldHead; reset
        // only when the merge left HEAD moved or the tree dirty.
        let restoreNote: string;
        try {
          await git.resetWorktree({
            targetPath: entry.path,
            expectedHead: oldHead,
            restoreHead: oldHead
          });
          restoreNote = ` The workspace has been restored to ${oldHead}.`;
        } catch {
          restoreNote = ` The workspace may be left in a conflicted state; inspect ${entry.path} manually.`;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Upstream integration failed for Project ${project.id}: ${message}.` + restoreNote
        );
      }
      const after = await git.inspect(entry.path, "HEAD");
      newHead = after.baseCommit;
    } finally {
      releaseMaintenance();
    }

    // Record the integration event immediately so a later Project's failure
    // does not lose this Project's audit trail.
    const result = { projectId: project.id, oldHead, newHead, upstreamCommit };
    store.transaction((tx) => {
      tx.saveEvent(task.id, createTaskEvent(
        tx.nextEventId(task.id),
        task.id,
        "task.upstream-integrated",
        result,
        now()
      ));
    });
    results.push(result);
  }

  const lines = results.map((r) =>
    `  ${r.projectId}: ${r.oldHead.slice(0, 12)} -> ${r.newHead.slice(0, 12)} (upstream: ${r.upstreamCommit.slice(0, 12)})`
  );
  return {
    output: `Integrated upstream for Task ${taskId}:\n${lines.join("\n")}\n`,
    data: { taskId, integrations: results }
  };
}
