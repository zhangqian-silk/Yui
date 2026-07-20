import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
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

export interface GitWorkspacePort {
  inspect(repositoryPath: string, baseRef?: string): Promise<GitRepositoryInspection>;
  ensureWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskId: string;
    roleName: string;
    baseRef: string;
  }>): Promise<PreparedGitWorktree>;
  removeWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskId: string;
    roleName: string;
  }>): Promise<GitWorkspaceRemoval>;
}

/** The small Git boundary used by repository registration and Task workspaces. */
export class NodeGitWorkspace implements GitWorkspacePort {
  async inspect(repositoryPath: string, baseRef = "HEAD"): Promise<GitRepositoryInspection> {
    const requested = await canonicalDirectory(repositoryPath, "Repository");
    const ref = safeRef(baseRef);
    const root = await canonicalDirectory(
      await gitLine(["-C", requested, "rev-parse", "--show-toplevel"]),
      "Repository root"
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
    return { root, gitDirectory, baseRef: ref, baseCommit: baseCommit.toLowerCase() };
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
      const repository = await this.inspect(input.repositoryPath);
      await assertOwnedWorktree(repository, container, path);
      await assertExpectedBranch(path, identity.branch);
      const head = await gitLine([
        "-C", path, "rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"
      ]);
      return { path, branch: identity.branch, baseCommit: head.toLowerCase() };
    }

    const repository = await this.inspect(input.repositoryPath, input.baseRef);
    await canonicalContainer(dirname(path), true);

    const branchRef = `refs/heads/${identity.branch}`;
    const branchExists = await gitSucceeds([
      "-C", repository.root, "show-ref", "--verify", "--quiet", branchRef
    ]);
    await git(branchExists
      ? ["-C", repository.root, "worktree", "add", "--", path, identity.branch]
      : [
          "-C", repository.root, "worktree", "add", "-b", identity.branch,
          "--", path, repository.baseCommit
        ]);

    await assertOwnedWorktree(repository, container, path);
    await assertExpectedBranch(path, identity.branch);
    return { path, branch: identity.branch, baseCommit: repository.baseCommit };
  }

  async removeWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskId: string;
    roleName: string;
  }>): Promise<GitWorkspaceRemoval> {
    const container = resolve(input.container);
    const path = managedPath(
      container,
      worktreeIdentity(input.taskId, input.roleName).directory
    );
    const kind = await pathKind(path);
    if (kind === undefined) return "missing";
    if (kind === "symlink") throw new Error("Managed worktree path must not be a symbolic link.");

    const canonicalContainerPath = await canonicalContainer(container, false);
    const repository = await this.inspect(input.repositoryPath);
    await assertOwnedWorktree(repository, canonicalContainerPath, path);
    const porcelain = await git(["-C", path, "status", "--porcelain=v1", "--untracked-files=all"]);
    if (porcelain.length > 0) return "dirty";
    await git(["-C", repository.root, "worktree", "remove", "--", path]);
    return "removed";
  }
}

export function worktreeIdentity(
  taskId: string,
  roleName: string
): Readonly<{ directory: string; branch: string }> {
  const taskKey = safeIdentity(taskId, "Task id");
  const roleKey = safeIdentity(roleName, "Role name");
  return {
    directory: join(taskKey, roleKey),
    branch: `taskmux/${gitRefSegment(taskKey)}/${gitRefSegment(roleKey)}`
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
  repository: GitRepositoryInspection,
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
  if (common !== repository.gitDirectory) {
    throw new Error("Managed worktree belongs to another repository.");
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
