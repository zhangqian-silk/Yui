import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export type GitRepositoryInspection = Readonly<{
  root: string;
  gitDirectory: string;
  baseRef: string;
  baseCommit: string;
}>;

export type PreparedGitWorktree = Readonly<{
  path: string;
  branch: string;
  baseCommit: string;
}>;

export type GitWorkspaceRemoval = "removed" | "missing" | "dirty";
export type GitWorkspaceState = "missing" | "clean" | "dirty";

export interface GitWorkspacePort {
  inspect(repositoryPath: string, baseRef?: string): Promise<GitRepositoryInspection>;
  headRef(repositoryPath: string): Promise<string>;
  isClean(repositoryPath: string): Promise<boolean>;
  clone(input: Readonly<{
    remoteUrl: string;
    destination: string;
    branch?: string;
  }>): Promise<GitRepositoryInspection>;
  ensureLocalBranch(
    repositoryPath: string,
    branch: string
  ): Promise<GitRepositoryInspection>;
  ensureWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskId: string;
    roleName: string;
    baseRef: string;
  }>): Promise<PreparedGitWorktree>;
  inspectWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskId: string;
    roleName: string;
  }>): Promise<GitWorkspaceState>;
  removeWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskId: string;
    roleName: string;
    deleteBranch?: boolean;
  }>): Promise<GitWorkspaceRemoval>;
}

/** The small Git boundary used by project registration and Task workspaces. */
export class NodeGitWorkspace implements GitWorkspacePort {
  async clone(input: Readonly<{
    remoteUrl: string;
    destination: string;
    branch?: string;
  }>): Promise<GitRepositoryInspection> {
    const remote = safeRemote(input.remoteUrl);
    const destination = resolve(requireText(input.destination, "Project destination"));
    if (await pathKind(destination) !== undefined) {
      throw new Error(`Project destination already exists: ${destination}.`);
    }
    await canonicalContainer(dirname(destination), true);
    const branch = input.branch === undefined ? undefined : safeRef(input.branch);
    try {
      await git([
        "clone",
        ...(branch === undefined ? [] : ["--branch", branch]),
        "--",
        remote,
        destination
      ]);
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
    return this.inspect(destination, "HEAD");
  }

  async ensureLocalBranch(
    repositoryPath: string,
    branch: string
  ): Promise<GitRepositoryInspection> {
    try {
      return await this.inspect(repositoryPath, branch);
    } catch (originalError) {
      const root = (await this.inspect(repositoryPath, "HEAD")).root;
      const name = safeRef(branch);
      if (!await gitSucceeds(["check-ref-format", "--branch", name])) throw originalError;
      const remoteRef = `refs/remotes/origin/${name}`;
      if (!await gitSucceeds([
        "-C", root, "show-ref", "--verify", "--quiet", remoteRef
      ])) throw originalError;
      await git(["-C", root, "branch", "--", name, remoteRef]);
      return this.inspect(root, name);
    }
  }

  async inspect(repositoryPath: string, baseRef = "HEAD"): Promise<GitRepositoryInspection> {
    const requested = await canonicalDirectory(repositoryPath, "Project");
    const ref = safeRef(baseRef);
    const root = await canonicalDirectory(
      await gitLine(["-C", requested, "rev-parse", "--show-toplevel"]),
      "Project root"
    );
    const gitDirectory = await canonicalDirectory(
      await gitLine([
        "-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"
      ]),
      "Git common directory"
    );
    const baseCommit = await gitLine([
      "-C", root, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`
    ]);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(baseCommit)) {
      throw new Error("Git returned an invalid base commit.");
    }
    return {
      root,
      gitDirectory,
      baseRef: ref,
      baseCommit: baseCommit.toLowerCase()
    };
  }

  async headRef(repositoryPath: string): Promise<string> {
    const requested = await canonicalDirectory(repositoryPath, "Project");
    return gitLine(["-C", requested, "rev-parse", "--abbrev-ref", "HEAD"]);
  }

  async isClean(repositoryPath: string): Promise<boolean> {
    const root = (await this.inspect(repositoryPath)).root;
    const status = await git([
      "-C", root, "status", "--porcelain=v1", "--untracked-files=all"
    ]);
    return status.length === 0;
  }

  async ensureWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskId: string;
    roleName: string;
    baseRef: string;
  }>): Promise<PreparedGitWorktree> {
    const container = await canonicalContainer(input.container, true);
    const identity = worktreeIdentity(input.taskId, input.roleName);
    const path = managedPath(container, identity.directory);
    const kind = await pathKind(path);
    if (kind === "symlink") throw new Error("Managed worktree path must not be a symbolic link.");

    if (kind === "directory") {
      // A worktree already created before a crash remains usable even if the
      // original base branch/tag is later deleted.
      const project = await this.inspect(input.repositoryPath);
      await assertOwnedWorktree(project, container, path);
      await assertExpectedBranch(path, identity.branch);
      const head = await gitLine([
        "-C", path, "rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"
      ]);
      return { path, branch: identity.branch, baseCommit: head.toLowerCase() };
    }

    const project = await this.inspect(input.repositoryPath, input.baseRef);
    await canonicalContainer(dirname(path), true);

    const branchRef = `refs/heads/${identity.branch}`;
    const branchExists = await gitSucceeds([
      "-C", project.root, "show-ref", "--verify", "--quiet", branchRef
    ]);
    await git(branchExists
      ? ["-C", project.root, "worktree", "add", "--", path, identity.branch]
      : [
          "-C", project.root, "worktree", "add", "-b", identity.branch,
          "--", path, project.baseCommit
        ]);

    await assertOwnedWorktree(project, container, path);
    await assertExpectedBranch(path, identity.branch);
    const head = await gitLine([
      "-C", path, "rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"
    ]);
    return { path, branch: identity.branch, baseCommit: head.toLowerCase() };
  }

  async removeWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskId: string;
    roleName: string;
    deleteBranch?: boolean;
  }>): Promise<GitWorkspaceRemoval> {
    const state = await this.inspectWorktree(input);
    if (state === "dirty") return state;
    const container = resolve(input.container);
    const identity = worktreeIdentity(input.taskId, input.roleName);
    const path = managedPath(container, identity.directory);
    const project = await this.inspect(input.repositoryPath);
    if (state === "missing") {
      if (input.deleteBranch === true) {
        await git(["-C", project.root, "worktree", "prune"]);
        await deleteBranchIfPresent(project.root, identity.branch);
      }
      return state;
    }
    await git(["-C", project.root, "worktree", "remove", "--", path]);
    if (input.deleteBranch === true) {
      await deleteBranchIfPresent(project.root, identity.branch);
    }
    return "removed";
  }

  async inspectWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskId: string;
    roleName: string;
  }>): Promise<GitWorkspaceState> {
    const container = resolve(input.container);
    const path = managedPath(
      container,
      worktreeIdentity(input.taskId, input.roleName).directory
    );
    const kind = await pathKind(path);
    if (kind === undefined) return "missing";
    if (kind === "symlink") throw new Error("Managed worktree path must not be a symbolic link.");

    const canonicalContainerPath = await canonicalContainer(container, false);
    const project = await this.inspect(input.repositoryPath);
    await assertOwnedWorktree(project, canonicalContainerPath, path);
    const porcelain = await git(["-C", path, "status", "--porcelain=v1", "--untracked-files=all"]);
    return porcelain.length > 0 ? "dirty" : "clean";
  }
}

async function deleteBranchIfPresent(repositoryRoot: string, branch: string): Promise<void> {
  const branchRef = `refs/heads/${branch}`;
  if (!await gitSucceeds([
    "-C", repositoryRoot, "show-ref", "--verify", "--quiet", branchRef
  ])) return;
  await git(["-C", repositoryRoot, "branch", "-D", "--", branch]);
}

export function worktreeIdentity(
  taskId: string,
  roleName: string
): Readonly<{ directory: string; branch: string }> {
  const taskKey = safeIdentity(taskId, "Task id");
  const roleKey = safeIdentity(roleName, "Role name");
  return {
    directory: join(taskKey, roleKey),
    branch: `yui/${gitRefSegment(taskKey)}/${gitRefSegment(roleKey)}`
  };
}

function gitRefSegment(identity: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identity)
    && !identity.includes("..")
    && !identity.endsWith(".")
    && !identity.endsWith(".lock")) {
    return identity;
  }
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `encoded-${digest}`;
}

async function assertExpectedBranch(path: string, expected: string): Promise<void> {
  const branch = await gitLine(["-C", path, "symbolic-ref", "--short", "HEAD"]);
  if (branch !== expected) {
    throw new Error(`Managed worktree is on an unexpected branch: ${branch}.`);
  }
}

async function assertOwnedWorktree(
  project: GitRepositoryInspection,
  container: string,
  path: string
): Promise<void> {
  const canonicalPath = await canonicalDirectory(path, "Managed worktree");
  assertContained(container, canonicalPath);
  if (canonicalPath !== path) throw new Error("Managed worktree resolves through a symbolic link.");
  const root = await canonicalDirectory(
    await gitLine(["-C", path, "rev-parse", "--show-toplevel"]),
    "Managed worktree root"
  );
  if (root !== path) throw new Error("Managed worktree root does not match its deterministic path.");
  const common = await canonicalDirectory(
    await gitLine(["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    "Managed Git common directory"
  );
  if (common !== project.gitDirectory) {
    throw new Error("Managed worktree belongs to another project.");
  }
}

async function canonicalContainer(path: string, create: boolean): Promise<string> {
  const lexical = resolve(path);
  if (create) await mkdir(lexical, { recursive: true, mode: 0o700 });
  const canonical = await canonicalDirectory(lexical, "Worktree container");
  if (canonical !== lexical) throw new Error("Worktree container resolves through a symbolic link.");
  return canonical;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const value = requireText(path, label);
  const canonical = await realpath(isAbsolute(value) ? value : resolve(value));
  return canonical;
}

function managedPath(container: string, directory: string): string {
  const path = join(container, directory);
  assertContained(container, path);
  return path;
}

function assertContained(container: string, path: string): void {
  const child = relative(container, path);
  if (child.length === 0 || child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(child)) {
    throw new Error("Managed worktree path escapes its container.");
  }
}

async function pathKind(path: string): Promise<"directory" | "symlink" | undefined> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) return "symlink";
    if (!entry.isDirectory()) throw new Error("Managed worktree path is not a directory.");
    return "directory";
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function git(args: readonly string[]): Promise<string> {
  try {
    const result = await executeFile("git", [...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000
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
  const lines = (await git(args)).trimEnd().split("\n");
  if (lines.length !== 1 || lines[0]?.length === 0 || lines[0]?.includes("\0")) {
    throw new Error("Git returned invalid output.");
  }
  return lines[0];
}

function safeIdentity(value: string, label: string): string {
  const identity = requireText(value, label);
  if ([".", "..", "__proto__", "prototype", "constructor"].includes(identity)
    || /[\/\\\0]/.test(identity)) {
    throw new Error(`${label} is invalid.`);
  }
  return identity;
}

function safeRef(value: string): string {
  const ref = requireText(value, "Git base ref");
  if (ref.startsWith("-") || /[\r\n]/.test(ref)) throw new Error("Git base ref is invalid.");
  return ref;
}

function safeRemote(value: string): string {
  const remote = requireText(value, "Git remote URL");
  if (remote.startsWith("-") || /[\r\n]/.test(remote)) {
    throw new Error("Git remote URL is invalid.");
  }
  return remote;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function isErrno(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value
    && (value as { code?: unknown }).code === code;
}
