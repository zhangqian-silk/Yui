import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { createChangeSet, type ChangeSet } from "../integration/changeSet.js";
import { NodeGitWorkspace, type GitWorkspacePort } from "../repository/gitWorkspace.js";
import type { GitWorkspaceRemoval } from "../repository/gitWorkspace.js";
import { resolveWorktreeRoot } from "../repository/taskWorkspacePreparer.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { ExecutionAttempt } from "../execution/executionAttempt.js";

const executeFile = promisify(execFile);

export type AttemptWorkspace = Readonly<{
  taskId: string;
  attemptId: string;
  projectId: string;
  path: string;
  baseRef: string;
  baseCommit: string;
  branch?: string;
}>;

export class AttemptWorkspaceManager {
  readonly worktreeRoot: string;

  constructor(
    home: string,
    readonly store: TaskStore,
    readonly git: GitWorkspacePort = new NodeGitWorkspace(),
    readonly now: () => Date = () => new Date()
  ) {
    const workspace = store.getConfig().defaultWorkspace;
    this.worktreeRoot = workspace === undefined ? "" : resolveWorktreeRoot(home, workspace);
  }

  async reserve(input: Pick<ExecutionAttempt, "id" | "taskId">): Promise<AttemptWorkspace> {
    const task = this.store.getTask(input.taskId);
    if (task === null) throw new Error(`Task not found: ${input.taskId}.`);
    if (task.projectId === undefined) {
      throw new Error(`Write Attempt requires a Project-backed Task: ${input.id}.`);
    }
    const project = this.store.getProject(task.projectId);
    if (project === null) throw new Error(`Project not found: ${task.projectId}.`);
    if (this.worktreeRoot.length === 0) {
      throw new Error("Project workspace is not configured; run yui setup.");
    }
    const baseRef = task.cwd === undefined
      ? task.baseRef ?? project.developmentBranch
      : "HEAD";
    const inspection = await this.git.inspect(task.cwd ?? project.path, baseRef);
    const expectedPath = join(this.worktreeRoot, project.name, task.id, "attempts", input.id);
    return {
      taskId: task.id,
      attemptId: input.id,
      projectId: project.id,
      path: expectedPath,
      baseRef,
      baseCommit: inspection.baseCommit
    };
  }

  async activate(reserved: AttemptWorkspace): Promise<AttemptWorkspace> {
    const project = this.store.getProject(reserved.projectId);
    if (project === null) throw new Error(`Project not found: ${reserved.projectId}.`);
    const prepared = await this.git.ensureAttemptWorktree({
      repositoryPath: project.path,
      container: join(this.worktreeRoot, project.name),
      taskId: reserved.taskId,
      attemptId: reserved.attemptId,
      baseRef: reserved.baseCommit
    });
    if (
      prepared.path !== reserved.path
      || prepared.baseCommit !== reserved.baseCommit
    ) {
      throw new Error(
        `Attempt worktree identity is inconsistent: ${reserved.attemptId}.`
      );
    }
    return { ...reserved, path: prepared.path, branch: prepared.branch };
  }

  async captureChangeSet(
    attempt: ExecutionAttempt,
    workspace: AttemptWorkspace
  ): Promise<ChangeSet | null> {
    if (workspace.branch === undefined) {
      throw new Error(`Write workspace is incomplete: ${workspace.attemptId}.`);
    }
    const status = await git(["-C", workspace.path, "status", "--porcelain=v1", "--untracked-files=all"]);
    if (status.trim().length > 0) {
      await git(["-C", workspace.path, "add", "--all"]);
      await git(["-C", workspace.path, "-c", "user.name=Yui", "-c", "user.email=yui@local",
        "commit", "-m", `yui: execution attempt ${attempt.id}`]);
    }
    const headCommit = await gitLine(["-C", workspace.path, "rev-parse", "HEAD^{commit}"]);
    const currentBranch = (await git([
      "-C", workspace.path, "symbolic-ref", "--quiet", "--short", "HEAD"
    ])).trim();
    if (currentBranch !== workspace.branch) {
      throw new Error(
        `Attempt workspace left its managed branch: expected ${
          workspace.branch
        }, found ${currentBranch}.`
      );
    }
    if (headCommit === workspace.baseCommit) return null;
    if (!await gitSucceeds([
      "-C", workspace.path,
      "merge-base", "--is-ancestor",
      workspace.baseCommit,
      headCommit
    ])) {
      throw new Error(
        `Attempt workspace HEAD does not descend from its recorded base: ${attempt.id}.`
      );
    }
    const changedPaths = (await git([
      "-C", workspace.path, "diff", "--name-only", "-z", workspace.baseCommit, headCommit
    ])).split("\0").filter(Boolean);
    const changeSet = createChangeSet({
      id: this.store.nextChangeSetId(attempt.taskId),
      taskId: attempt.taskId,
      attemptId: attempt.id,
      projectId: workspace.projectId,
      baseCommit: workspace.baseCommit,
      headCommit,
      branch: workspace.branch,
      changedPaths
    }, this.now());
    this.store.saveChangeSet(attempt.taskId, changeSet);
    return changeSet;
  }

  async cleanup(attempt: ExecutionAttempt): Promise<GitWorkspaceRemoval> {
    const task = this.store.getTask(attempt.taskId);
    if (task?.projectId === undefined) {
      throw new Error(`Execution Attempt Task Project is unavailable: ${attempt.id}.`);
    }
    const project = this.store.getProject(task.projectId);
    if (project === null) throw new Error(`Project not found: ${task.projectId}.`);
    return this.git.removeAttemptWorktree({
      repositoryPath: project.path,
      container: join(this.worktreeRoot, project.name),
      taskId: task.id,
      attemptId: attempt.id,
      ...(attempt.baseCommit === undefined ? {} : { expectedBaseCommit: attempt.baseCommit }),
      allowCommittedChanges: attempt.result?.changeSetId !== undefined
    });
  }
}

async function git(args: readonly string[]): Promise<string> {
  try {
    const result = await executeFile("git", [...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000
    });
    return result.stdout;
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr).trim()
      : "";
    throw new Error(stderr.length === 0 ? "Git command failed." : `Git command failed: ${stderr}`, {
      cause: error
    });
  }
}

async function gitLine(args: readonly string[]): Promise<string> {
  const value = (await git(args)).trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) {
    throw new Error("Git returned an invalid commit.");
  }
  return value;
}

async function gitSucceeds(args: readonly string[]): Promise<boolean> {
  try {
    await git(args);
    return true;
  } catch {
    return false;
  }
}
