import { usageError } from "../errors/cliError.js";
import { GitIntegrationService } from "../integration/gitIntegrationService.js";
import { createIntegrationAttempt } from "../integration/integrationAttempt.js";
import { NodeGitWorkspace, type GitWorkspacePort } from "../repository/gitWorkspace.js";
import { FileTaskWorkspacePreparer } from "../repository/taskWorkspacePreparer.js";
import type { TaskStore } from "../storage/taskStore.js";
import { workspaceProjectEntry } from "../worktree/managedWorkspace.js";
import { parseRepeatable } from "./taskIntegrationCommands.js";
import { taskLocalActor } from "./taskActor.js";

export type TaskUpstreamCommandOptions = Readonly<{
  git?: GitWorkspacePort;
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
}>;

export type TaskUpstreamCommandResult = Readonly<{
  output: string;
  data?: unknown;
}>;

export async function runTaskUpstreamCommand(
  args: readonly string[],
  store: TaskStore,
  home: string,
  options: TaskUpstreamCommandOptions = {}
): Promise<TaskUpstreamCommandResult> {
  const [command, ...rest] = args;
  if (command === "integrate") return integrateUpstream(rest, store, home, options);
  throw usageError(
    command === undefined
      ? "Task upstream command is required."
      : `Unknown command: task upstream ${command}`
  );
}

async function integrateUpstream(
  args: readonly string[],
  store: TaskStore,
  home: string,
  options: TaskUpstreamCommandOptions
): Promise<TaskUpstreamCommandResult> {
  const usage = "Task upstream integrate usage: yui task upstream integrate <task> (--latest|--project <project>) [--check <command> ...].";
  let latest = false;
  const normalized: string[] = [];
  for (const arg of args) {
    if (arg === "--latest") {
      if (latest) throw usageError("Option may only be specified once: --latest.", usage);
      latest = true;
      continue;
    }
    normalized.push(
      ...(arg.startsWith("--project=")
        ? ["--project", arg.slice("--project=".length)]
        : [arg])
    );
  }
  const parsed = parseRepeatable(
    normalized,
    new Set(["--check"]),
    new Set(["--project"]),
    usage
  );
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const taskId = parsed.positionals[0]!;
  const projectRef = parsed.one.get("--project");
  if (!latest && projectRef === undefined) {
    throw usageError("Specify --latest for every Task Project, or --project <project>.");
  }
  if (latest && projectRef !== undefined) {
    throw usageError("--latest and --project are mutually exclusive.");
  }
  let task = store.getTask(taskId);
  if (task === null) throw usageError(`Task not found: ${taskId}.`);
  if (task.status !== "active") {
    throw usageError(`Task must be active to integrate upstream: ${taskId}/${task.status}.`);
  }
  taskLocalActor(store, options.environment, task.id);
  const git = options.git ?? new NodeGitWorkspace();
  const now = options.now ?? (() => new Date());
  await new FileTaskWorkspacePreparer(home, store, git, now)
    .prepareTaskWorkspace(task.id);
  task = store.getTask(task.id);
  if (task === null || task.status !== "active") {
    throw usageError(`Task is no longer active: ${taskId}.`);
  }
  const workspace = store.getTaskWorkspace(task.id);
  if (workspace === null || workspace.owner.type !== "task") {
    throw usageError(`Task has no authoritative main clone: ${task.id}.`);
  }

  const service = new GitIntegrationService(store.rootDirectory(), store, git, now);
  const results = [];

  for (const binding of task.projectBindings) {
    if (projectRef !== undefined && binding.projectId !== projectRef) continue;
    const project = store.getProject(binding.projectId);
    if (project === null) throw usageError(`Project not found: ${binding.projectId}.`);
    if (project.remoteUrl === undefined) {
      throw usageError(`Project has no remote URL: ${project.id}.`);
    }
    if (binding.baseCommit === undefined || binding.currentCommit === undefined) {
      throw usageError(`Task Project has no activated commit boundary: ${task.id}/${project.id}.`);
    }
    const entry = workspaceProjectEntry(workspace, project.id);
    if (entry === undefined) {
      throw usageError(`Task workspace has no entry for Project: ${project.id}.`);
    }
    const head = (await git.inspect(entry.path, entry.branch)).baseCommit;
    if (head !== binding.currentCommit) {
      throw usageError(
        `Task Project current commit diverged from its main clone: ${task.id}/${project.id}.`
      );
    }
    const remote = await git.resolveRemoteHead({
      remoteUrl: project.remoteUrl,
      branch: binding.baseRef
    });
    const attempt = store.transaction((tx) => {
      const created = createIntegrationAttempt({
        id: tx.nextIntegrationAttemptId(task.id),
        taskId: task.id,
        projectId: project.id,
        targetRef: entry.branch,
        beforeCommit: binding.currentCommit!,
        source: {
          kind: "upstream",
          branch: remote.branch,
          remoteCommit: remote.commit,
          taskBaseCommit: binding.baseCommit!,
          strategy: "rebase"
        },
        checkCommands: parsed.many.get("--check") ?? []
      }, now());
      tx.saveIntegrationAttempt(task.id, created);
      return created;
    });
    const result = await service.integrate(task.id, attempt.id);
    results.push(result);
    if (result.status !== "committed") break;
  }

  if (projectRef !== undefined && results.length === 0) {
    throw usageError(`Task Project not found: ${task.id}/${projectRef}.`);
  }
  const lines = results.map(({ attempt, status }) => (
    `  ${attempt.projectId}: ${attempt.beforeCommit.slice(0, 12)} -> ${
      (attempt.afterCommit ?? attempt.candidateCommit ?? attempt.beforeCommit).slice(0, 12)
    } (${status})`
  ));
  return {
    output: `Upstream Integration results for Task ${task.id}:\n${lines.join("\n")}\n`,
    data: { taskId: task.id, integrations: results }
  };
}
