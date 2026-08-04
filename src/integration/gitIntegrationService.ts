import { execFile, spawn } from "node:child_process";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { CheckResult } from "./checkResult.js";
import { NodeGitWorkspace, type GitWorkspacePort } from "../repository/gitWorkspace.js";
import type { GitWorkspaceRemoval } from "../repository/gitWorkspace.js";
import { resolveWorktreeRoot } from "../repository/taskWorkspacePreparer.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  requireLeaderDecision,
  updateIntegrationAttempt,
  type IntegrationAttempt
} from "./integrationAttempt.js";

const executeFile = promisify(execFile);

export type IntegrationResult =
  | Readonly<{ status: "committed"; attempt: IntegrationAttempt; workspace: IntegrationWorkspace }>
  | Readonly<{ status: "blocked"; attempt: IntegrationAttempt; workspace: IntegrationWorkspace }>
  | Readonly<{ status: "failed"; attempt: IntegrationAttempt; workspace?: IntegrationWorkspace }>;

type PlannedCommit = Readonly<{ changeSetId: string; commit: string }>;
export type IntegrationWorkspace = Readonly<{
  projectId: string;
  path: string;
  branch: string;
  baseCommit: string;
}>;

export class GitIntegrationService {
  readonly home: string;
  readonly worktreeRoot: string;

  constructor(
    home: string,
    readonly store: TaskStore,
    readonly git: GitWorkspacePort = new NodeGitWorkspace(),
    readonly now: () => Date = () => new Date()
  ) {
    this.home = resolve(home);
    this.worktreeRoot = resolveWorktreeRoot(home, store.getConfig().defaultWorkspace);
  }

  async integrate(taskId: string, integrationId: string): Promise<IntegrationResult> {
    const initial = requireIntegration(this.store, taskId, integrationId);
    const task = this.store.getTask(initial.taskId);
    if (task === null || !task.projectBindings.some(
      ({ projectId }) => projectId === initial.projectId
    )) {
      throw new Error(`Integration Task Project is unavailable: ${initial.taskId}.`);
    }
    if (task.status !== "active") {
      throw new Error(`Integration Task is not active: ${task.id}/${task.status}.`);
    }
    const project = this.store.getProject(initial.projectId);
    if (project === null) throw new Error(`Project not found: ${initial.projectId}.`);
    let prepared: Readonly<{ path: string; branch: string; baseCommit: string }>;
    let workspace: IntegrationWorkspace;
    try {
      prepared = await this.git.ensureIntegrationWorktree({
        repositoryPath: project.path,
        container: join(this.worktreeRoot, project.name),
        taskId: task.id,
        integrationId: initial.id,
        baseRef: initial.expectedHead
      });
      workspace = {
        projectId: project.id,
        path: prepared.path,
        branch: prepared.branch,
        baseCommit: prepared.baseCommit
      };
    } catch (error) {
      return this.#fail(initial, error, "integration-preparation");
    }
    if (initial.status === "validating") {
      return this.#recoverValidating(initial, workspace, project.path);
    }
    let current = initial;

    try {
      const plan = await integrationCommitPlan(
        this.store,
        task.id,
        project.path,
        current.changeSetIds
      );
      let remaining = plan;
      if (current.resolution?.action === "manual-resolution") {
        const resolvedCommit = await completeManualResolution(prepared.path);
        const resolvedIndex = plan.findIndex(({ commit }) => commit === resolvedCommit);
        if (resolvedIndex < 0) {
          throw new Error(
            `Manual resolution commit is not part of the Integration plan: ${resolvedCommit}.`
          );
        }
        remaining = plan.slice(resolvedIndex + 1);
      }
      const conflict = await this.#applyCommits(current, workspace, prepared.path, remaining);
      if (conflict !== undefined) {
        return conflict;
      }

      const checkResults = await runChecks(
        prepared.path,
        current.checkCommands,
        this.home,
        task.id,
        current.id
      );
      if (checkResults.some((check) => check.outcome === "failed")) {
        current = updateIntegrationAttempt(current, {
          status: "failed",
          checks: checkResults
        }, this.now());
        this.store.saveIntegrationAttempt(task.id, current);
        return this.#terminalResult("failed", current, workspace);
      }
      const candidateCommit = await gitLine(["-C", prepared.path, "rev-parse", "HEAD^{commit}"]);
      current = updateIntegrationAttempt(current, {
        status: "validating",
        candidateCommit,
        checks: checkResults
      }, this.now());
      this.store.saveIntegrationAttempt(task.id, current);
      await advanceTargetRef(
        project.path,
        current.targetRef,
        candidateCommit,
        current.expectedHead
      );
      const committed = updateIntegrationAttempt(current, { status: "committed" }, this.now());
      this.store.saveIntegrationAttempt(task.id, committed);
      return this.#terminalResult("committed", committed, workspace);
    } catch (error) {
      if (current.status === "validating" && current.candidateCommit !== undefined) {
        const target = await resolveRef(project.path, current.targetRef);
        if (target === current.candidateCommit) {
          const committed = updateIntegrationAttempt(
            current,
            { status: "committed" },
            this.now()
          );
          this.store.saveIntegrationAttempt(task.id, committed);
          return this.#terminalResult("committed", committed, workspace);
        }
      }
      return this.#fail(current, error, "integration", workspace);
    }
  }

  async cleanup(integration: IntegrationAttempt): Promise<GitWorkspaceRemoval> {
    const task = this.store.getTask(integration.taskId);
    if (task === null || !task.projectBindings.some(
      ({ projectId }) => projectId === integration.projectId
    )) {
      throw new Error(`Integration Task Project is unavailable: ${integration.id}.`);
    }
    const project = this.store.getProject(integration.projectId);
    if (project === null) throw new Error(`Project not found: ${integration.projectId}.`);
    const result = await this.git.removeIntegrationWorktree({
      repositoryPath: project.path,
      container: join(this.worktreeRoot, project.name),
      taskId: task.id,
      integrationId: integration.id
    });
    if (result !== "dirty") {
      await rm(integrationCheckDirectory(this.home, task.id, integration.id), {
        recursive: true,
        force: true
      });
    }
    return result;
  }

  async #applyCommits(
    attempt: IntegrationAttempt,
    workspace: IntegrationWorkspace,
    candidatePath: string,
    commits: readonly PlannedCommit[]
  ): Promise<IntegrationResult | undefined> {
    for (const { changeSetId, commit } of commits) {
      try {
        await git(["-C", candidatePath, "cherry-pick", commit]);
      } catch {
        const affectedPaths = (await git([
          "-C", candidatePath, "diff", "--name-only", "--diff-filter=U"
        ])).trim().split("\n").filter(Boolean);
        const pending = requireLeaderDecision(attempt, {
          affectedPaths,
          summary: `ChangeSet ${changeSetId} conflicts with ${attempt.targetRef}.`
        }, this.now());
        this.store.saveIntegrationAttempt(attempt.taskId, pending);
        return { status: "blocked", attempt: pending, workspace };
      }
    }
    return undefined;
  }

  async #recoverValidating(
    attempt: IntegrationAttempt,
    workspace: IntegrationWorkspace,
    repositoryPath: string
  ): Promise<IntegrationResult> {
    if (attempt.candidateCommit === undefined || attempt.checks === undefined) {
      return this.#fail(
        attempt,
        new Error("Validating Integration is missing its candidate commit or checks."),
        "integration-recovery",
        workspace
      );
    }
    const target = await resolveRef(repositoryPath, attempt.targetRef);
    if (target === attempt.expectedHead) {
      try {
        await advanceTargetRef(
          repositoryPath,
          attempt.targetRef,
          attempt.candidateCommit,
          attempt.expectedHead
        );
      } catch (error) {
        return this.#fail(attempt, error, "integration-recovery", workspace);
      }
    } else if (target !== attempt.candidateCommit) {
      return this.#fail(
        attempt,
        new Error(`Target moved to ${target}; expected ${attempt.expectedHead}.`),
        "integration-recovery",
        workspace
      );
    }
    const committed = updateIntegrationAttempt(attempt, { status: "committed" }, this.now());
    this.store.saveIntegrationAttempt(attempt.taskId, committed);
    return this.#terminalResult("committed", committed, workspace);
  }

  #fail(
    attempt: IntegrationAttempt,
    error: unknown,
    checkName: string,
    workspace?: IntegrationWorkspace
  ): IntegrationResult {
    const failed = updateIntegrationAttempt(attempt, {
      status: "failed",
      checks: [
        ...(attempt.checks ?? []),
        {
          name: checkName,
          outcome: "failed",
          details: error instanceof Error ? error.message : String(error)
        }
      ]
    }, this.now());
    this.store.saveIntegrationAttempt(attempt.taskId, failed);
    return this.#terminalResult("failed", failed, workspace);
  }

  #terminalResult(
    status: "committed" | "failed",
    attempt: IntegrationAttempt,
    workspace?: IntegrationWorkspace
  ): IntegrationResult {
    if (status === "committed") {
      if (workspace === undefined) {
        throw new Error(`Committed Integration has no workspace: ${attempt.id}.`);
      }
      return { status, attempt, workspace };
    }
    return {
      status,
      attempt,
      ...(workspace === undefined ? {} : { workspace })
    };
  }
}

async function integrationCommitPlan(
  store: TaskStore,
  taskId: string,
  repositoryPath: string,
  changeSetIds: readonly string[]
): Promise<PlannedCommit[]> {
  const plan: PlannedCommit[] = [];
  for (const changeSetId of changeSetIds) {
    const changeSet = store.getChangeSet(taskId, changeSetId);
    if (changeSet === null) throw new Error(`ChangeSet not found: ${changeSetId}.`);
    const commits = (await git([
      "-C", repositoryPath, "rev-list", "--reverse",
      `${changeSet.baseCommit}..${changeSet.headCommit}`
    ])).trim().split("\n").filter(Boolean);
    plan.push(...commits.map((commit) => ({ changeSetId, commit })));
  }
  return plan;
}

async function completeManualResolution(path: string): Promise<string> {
  const unmerged = (await git(["-C", path, "diff", "--name-only", "--diff-filter=U"])).trim();
  if (unmerged.length > 0) {
    throw new Error(`Manual resolution is incomplete: ${unmerged.split("\n").join(", ")}.`);
  }
  let cherryPickHead: string;
  try {
    cherryPickHead = await gitLine([
      "-C", path, "rev-parse", "--verify", "CHERRY_PICK_HEAD"
    ]);
  } catch {
    throw new Error("Manual resolution has no active cherry-pick.");
  }
  const emptyResolution = await gitSucceeds(["-C", path, "diff", "--cached", "--quiet"]);
  if (emptyResolution) {
    await git(["-C", path, "cherry-pick", "--skip"]);
  } else {
    await git(["-C", path, "-c", "user.name=Yui", "-c", "user.email=yui@local",
      "cherry-pick", "--continue"]);
  }
  return cherryPickHead;
}

async function runChecks(
  path: string,
  commands: readonly string[],
  home: string,
  taskId: string,
  integrationId: string
): Promise<CheckResult[]> {
  if (commands.length === 0) return [];
  const outputDirectory = integrationCheckDirectory(home, taskId, integrationId);
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const results: CheckResult[] = [];
  for (const [index, command] of commands.entries()) {
    const absoluteLogPath = join(
      outputDirectory,
      `${String(index + 1).padStart(3, "0")}.log`
    );
    const logPath = relative(home, absoluteLogPath).split(sep).join("/");
    const result = await runCheck(path, command, absoluteLogPath, logPath);
    results.push(result);
    if (result.outcome === "failed") break;
  }
  return results;
}

type CheckCompletion = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  timedOut: boolean;
}>;

async function runCheck(
  cwd: string,
  command: string,
  absoluteLogPath: string,
  logPath: string
): Promise<CheckResult> {
  const output = await open(absoluteLogPath, "w", 0o600);
  let completion: CheckCompletion;
  try {
    completion = await spawnCheck(command, cwd, output.fd);
  } finally {
    await output.close();
  }
  const outputSize = (await stat(absoluteLogPath)).size;
  const outputReference = outputSize === 0
    ? {}
    : { logPath };
  if (outputSize === 0) await rm(absoluteLogPath, { force: true });
  if (
    completion.error === undefined
    && !completion.timedOut
    && completion.code === 0
  ) {
    return {
      name: command,
      outcome: "passed",
      ...outputReference
    };
  }
  const diagnostic = outputSize === 0
    ? undefined
    : await lastCompleteDiagnosticLine(absoluteLogPath);
  return {
    name: command,
    outcome: "failed",
    details: [
      checkFailureReason(completion),
      ...(diagnostic === undefined ? [] : [diagnostic])
    ].join(" "),
    ...outputReference
  };
}

async function spawnCheck(
  command: string,
  cwd: string,
  outputFd: number
): Promise<CheckCompletion> {
  let child;
  try {
    child = spawn("/bin/sh", ["-lc", command], {
      cwd,
      stdio: ["ignore", outputFd, outputFd]
    });
  } catch (error) {
    return {
      code: null,
      signal: null,
      error: error instanceof Error ? error : new Error(String(error)),
      timedOut: false
    };
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, 30 * 60_000);
  timeout.unref();
  const completion = await new Promise<Omit<CheckCompletion, "timedOut">>((resolve) => {
    child.once("error", (error) => {
      resolve({ code: null, signal: null, error });
    });
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  clearTimeout(timeout);
  return { ...completion, timedOut };
}

function checkFailureReason(completion: CheckCompletion): string {
  if (completion.timedOut) return "Command timed out after 1800 seconds.";
  if (completion.error !== undefined) {
    return `Command failed to start: ${completion.error.message}`;
  }
  if (completion.code !== null) return `Command exited with code ${completion.code}.`;
  if (completion.signal !== null) return `Command terminated by ${completion.signal}.`;
  return "Command failed.";
}

async function lastCompleteDiagnosticLine(path: string): Promise<string | undefined> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, 64 * 1024);
    if (length === 0) return undefined;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    let text = buffer.toString("utf8");
    if (info.size > length) {
      const firstLineEnd = text.indexOf("\n");
      if (firstLineEnd < 0) return undefined;
      text = text.slice(firstLineEnd + 1);
    }
    const line = text.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean).at(-1);
    return line === undefined || line.length > 1_000 ? undefined : line;
  } finally {
    await handle.close();
  }
}

function integrationCheckDirectory(
  home: string,
  taskId: string,
  integrationId: string
): string {
  return join(home, "artifacts", "integration-checks", taskId, integrationId);
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

async function gitSucceeds(args: readonly string[]): Promise<boolean> {
  try {
    await git(args);
    return true;
  } catch {
    return false;
  }
}

async function gitLine(args: readonly string[]): Promise<string> {
  const value = (await git(args)).trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) {
    throw new Error("Git returned an invalid commit.");
  }
  return value;
}

function requireIntegration(
  store: TaskStore,
  taskId: string,
  id: string
): IntegrationAttempt {
  const attempt = store.getIntegrationAttempt(taskId, id);
  if (attempt === null) {
    throw new Error(`Integration Attempt not found: ${taskId}/${id}.`);
  }
  return attempt;
}

function fullTargetRef(value: string): string {
  if (value.startsWith("refs/")) return value;
  if (value.startsWith("-") || /[\r\n]/u.test(value)) {
    throw new Error("Integration target ref is invalid.");
  }
  return `refs/heads/${value}`;
}

async function resolveRef(repositoryPath: string, ref: string): Promise<string> {
  return gitLine([
    "-C", repositoryPath, "rev-parse", "--verify", "--end-of-options",
    `${fullTargetRef(ref)}^{commit}`
  ]);
}

async function advanceTargetRef(
  repositoryPath: string,
  targetRef: string,
  candidateCommit: string,
  expectedHead: string
): Promise<void> {
  const ref = fullTargetRef(targetRef);
  const checkedOutPaths = await checkedOutWorktreePaths(repositoryPath, ref);
  if (checkedOutPaths.length === 0) {
    await git([
      "-C", repositoryPath, "update-ref",
      ref,
      candidateCommit,
      expectedHead
    ]);
    return;
  }
  if (checkedOutPaths.length > 1) {
    throw new Error(`Integration target is checked out in multiple worktrees: ${targetRef}.`);
  }
  const checkout = checkedOutPaths[0]!;
  const status = await git([
    "-C", checkout, "status", "--porcelain=v1", "--untracked-files=all"
  ]);
  if (status.trim().length > 0) {
    throw new Error(`Integration target worktree is not clean: ${checkout}.`);
  }
  const current = await gitLine(["-C", checkout, "rev-parse", "HEAD^{commit}"]);
  if (current !== expectedHead) {
    throw new Error(`Target moved to ${current}; expected ${expectedHead}.`);
  }
  await git(["-C", checkout, "merge", "--ff-only", "--no-edit", candidateCommit]);
  const advanced = await resolveRef(repositoryPath, targetRef);
  if (advanced !== candidateCommit) {
    throw new Error(`Integration target did not advance to candidate: ${targetRef}.`);
  }
  const finalStatus = await git([
    "-C", checkout, "status", "--porcelain=v1", "--untracked-files=all"
  ]);
  if (finalStatus.trim().length > 0) {
    throw new Error(`Integration target worktree became dirty: ${checkout}.`);
  }
}

async function checkedOutWorktreePaths(
  repositoryPath: string,
  targetRef: string
): Promise<string[]> {
  const porcelain = (await git([
    "-C", repositoryPath, "worktree", "list", "--porcelain"
  ])).trim();
  if (porcelain.length === 0) return [];
  return porcelain.split(/\n\n+/u).flatMap((record) => {
    const lines = record.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
    return path !== undefined && branch === targetRef ? [path] : [];
  });
}
