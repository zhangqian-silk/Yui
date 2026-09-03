/**
 * Read-only resource discovery for Resource GC (Issue 10).
 *
 * Discovery enumerates the disk objects Yui created — managed Git worktrees,
 * legacy deployments, and runtime artifacts — and attributes each one to an
 * owner. Only precisely attributable resources become cleanup candidates;
 * anything else is reported and retained.
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import { managedProjectPath, type Project } from "../repository/project.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import { isResourceQuarantinePath } from "./resourceRegistry.js";
import {
  createResourceRecord,
  isReleaseNamespacePath,
  isTerminalTaskStatus,
  type ResourceKind,
  type ResourceOwner,
  type ResourceRecord
} from "./resourceTypes.js";

const executeFile = promisify(execFile);

export type DiscoveredResource = Readonly<{
  record: ResourceRecord;
  /** Whether discovery could prove the owner is terminal. */
  ownerTerminal: boolean;
}>;

export type ResourceDiscoveryInput = Readonly<{
  home: string;
  projects: readonly Project[];
  managedWorkspaces: readonly ManagedWorkspace[];
  taskStatusById: ReadonlyMap<string, string>;
  now: Date;
}>;

export type GitWorktreeEntry = Readonly<{
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  prunable: boolean;
}>;

/** Parse `git worktree list --porcelain` output. */
export function parseGitWorktreePorcelain(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: {
    path?: string;
    head?: string;
    branch?: string;
    detached: boolean;
    prunable: boolean;
  } = { detached: false, prunable: false };
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path !== undefined) {
        entries.push(finalize(current));
      }
      current = { path: line.slice("worktree ".length), detached: false, prunable: false };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "detached") {
      current.detached = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  if (current.path !== undefined) entries.push(finalize(current));
  return entries;

  function finalize(entry: NonNullable<typeof current>): GitWorktreeEntry {
    return {
      path: entry.path!,
      ...(entry.head === undefined ? {} : { head: entry.head }),
      ...(entry.branch === undefined ? {} : { branch: entry.branch }),
      detached: entry.detached,
      prunable: entry.prunable
    };
  }
}

async function listGitWorktrees(repositoryPath: string): Promise<GitWorktreeEntry[]> {
  try {
    const { stdout } = await executeFile(
      "git",
      ["-C", repositoryPath, "worktree", "list", "--porcelain"],
      { timeout: 10_000 }
    );
    return parseGitWorktreePorcelain(stdout);
  } catch (error) {
    throw new Error(
      `Failed to list Git worktrees for ${repositoryPath}: `
        + `${error instanceof Error ? error.message : "unknown error"}`,
      { cause: error }
    );
  }
}

async function gitWorktreeCleanliness(path: string): Promise<"clean" | "dirty" | "unknown"> {
  try {
    const { stdout } = await executeFile(
      "git",
      ["-C", path, "status", "--porcelain=v1", "--untracked-files=all"],
      { timeout: 10_000 }
    );
    return stdout.length > 0 ? "dirty" : "clean";
  } catch {
    return "unknown";
  }
}

/**
 * Discover every resource Yui created. The scan is read-only and never
 * deletes; classification into releasable/retained happens in the GC engine.
 */
export async function discoverResources(
  input: ResourceDiscoveryInput
): Promise<DiscoveredResource[]> {
  const home = resolve(input.home);
  const discovered: DiscoveredResource[] = [];

  // 1. Managed Git worktrees, per Project.
  for (const project of input.projects) {
    const repositoryPath = projectRepositoryPath(home, project);
    if (repositoryPath === undefined) continue;
    const worktrees = await listGitWorktrees(repositoryPath);
    for (const worktree of worktrees) {
      if (resolve(worktree.path) === resolve(repositoryPath)) continue;
      if (isReleaseNamespacePath(home, worktree.path)) continue;
      if (isResourceQuarantinePath(home, worktree.path)) continue;
      const owner = attributeWorktreeOwner(home, project, worktree, input.managedWorkspaces);
      // A prunable worktree's gitdir points to a non-existent location; its
      // cleanliness cannot be proven, so it is retained, not released.
      const cleanliness = worktree.prunable
        ? "unknown"
        : await gitWorktreeCleanliness(worktree.path);
      const taskStatus = owner.taskId === undefined
        ? undefined
        : input.taskStatusById.get(owner.taskId);
      discovered.push({
        record: createResourceRecord({
          kind: "worktree",
          path: resolve(worktree.path),
          owner,
          git: {
            repositoryPath,
            ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
            ...(worktree.head === undefined ? {} : { head: worktree.head })
          },
          ...(sizeOf(worktree.path) === undefined ? {} : { sizeBytes: sizeOf(worktree.path) }),
          cleanliness,
          activeRefs: [],
          disposition: "active"
        }, input.now),
        ownerTerminal: owner.taskId === undefined
          ? owner.basis === "unattributed"
          : isTerminalTaskStatus(taskStatus as never)
      });
    }
  }

  // 2. Legacy deployments (historical runtime; no current-master creator).
  for (const kind of ["deployment", "deployment-backup"] as const) {
    const directory = kind === "deployment"
      ? join(home, "runtime", "deployments")
      : join(home, "runtime", "deploy-backups");
    if (!existsSync(directory)) continue;
    for (const entry of safeReaddir(directory)) {
      const path = join(directory, entry.name);
      if (isReleaseNamespacePath(home, path)) continue;
      if (isResourceQuarantinePath(home, path)) continue;
      const owner = attributeDeploymentOwner(home, entry.name, input.taskStatusById);
      const isGit = existsSync(join(path, ".git"));
      const cleanliness = isGit ? await gitWorktreeCleanliness(path) : "n/a";
      const gitMetadata = isGit ? readDeploymentGitMetadata(path) : undefined;
      const taskStatus = owner.taskId === undefined
        ? undefined
        : input.taskStatusById.get(owner.taskId);
      discovered.push({
        record: createResourceRecord({
          kind: "deployment",
          path: resolve(path),
          owner,
          ...(gitMetadata !== undefined ? { git: gitMetadata } : {}),
          ...(sizeOf(path) === undefined ? {} : { sizeBytes: sizeOf(path) }),
          cleanliness,
          activeRefs: [],
          disposition: "active"
        }, input.now),
        ownerTerminal: owner.taskId === undefined
          ? false
          : isTerminalTaskStatus(taskStatus as never)
      });
    }
  }

  // 3. Runtime artifacts.
  discovered.push(...discoverRuntimeArtifacts(home, input));

  return discovered;
}

function discoverRuntimeArtifacts(
  home: string,
  input: ResourceDiscoveryInput
): DiscoveredResource[] {
  const discovered: DiscoveredResource[] = [];
  const now = input.now;

  // 3a. Task runtime isolation roots: <home>.task-runtimes/<taskId>/<owner>/<launch>/
  const runtimeRoot = `${resolve(home)}.task-runtimes`;
  if (existsSync(runtimeRoot)) {
    for (const taskEntry of safeReaddir(runtimeRoot)) {
      if (!taskEntry.isDirectory()) continue;
      const taskId = taskEntry.name;
      const taskRoot = join(runtimeRoot, taskId);
      const taskStatus = input.taskStatusById.get(taskId);
      for (const ownerEntry of safeReaddir(taskRoot)) {
        if (!ownerEntry.isDirectory()) continue;
        for (const launchEntry of safeReaddir(join(taskRoot, ownerEntry.name))) {
          if (!launchEntry.isDirectory()) continue;
          const generationRoot = join(taskRoot, ownerEntry.name, launchEntry.name);
          const marker = readTaskRuntimeMarker(generationRoot);
          const owner: ResourceOwner = marker === undefined
            ? { home, taskId, basis: "naming-convention" }
            : {
                home,
                taskId,
                ...(marker.workItemId === undefined ? {} : { workItemId: marker.workItemId }),
                ...(marker.reviewRoundId === undefined ? {} : { reviewRoundId: marker.reviewRoundId }),
                basis: "marker"
              };
          discovered.push({
            record: createResourceRecord({
              kind: "runtime-artifact",
              path: resolve(generationRoot),
              owner,
              ...(sizeOf(generationRoot) === undefined ? {} : { sizeBytes: sizeOf(generationRoot) }),
              cleanliness: "n/a",
              activeRefs: [],
              disposition: "active"
            }, now),
            ownerTerminal: isTerminalTaskStatus(taskStatus as never)
          });
        }
      }
    }
  }

  // 3c. Session contexts: hash-named, owner not provable from the filename.
  const sessionContextDirectory = join(home, "runtime", "session-contexts");
  for (const entry of safeReaddir(sessionContextDirectory)) {
    if (!entry.name.endsWith(".md")) continue;
    const path = join(sessionContextDirectory, entry.name);
    discovered.push({
      record: createResourceRecord({
        kind: "runtime-artifact",
        path: resolve(path),
        owner: { home, basis: "unattributed" },
        ...(sizeOf(path) === undefined ? {} : { sizeBytes: sizeOf(path) }),
        cleanliness: "n/a",
        activeRefs: [],
        disposition: "active"
      }, now),
      ownerTerminal: false
    });
  }

  // 3d. Claude lifecycle plugin: Controller-owned, never auto-released.
  const pluginDirectory = join(home, "runtime", "claude-lifecycle-plugin");
  if (existsSync(pluginDirectory)) {
    discovered.push({
      record: createResourceRecord({
        kind: "runtime-artifact",
        path: resolve(pluginDirectory),
        owner: { home, basis: "descriptor" },
        ...(sizeOf(pluginDirectory) === undefined ? {} : { sizeBytes: sizeOf(pluginDirectory) }),
        cleanliness: "n/a",
        activeRefs: [],
        disposition: "active"
      }, now),
      ownerTerminal: false
    });
  }

  return discovered;
}

function attributeWorktreeOwner(
  home: string,
  project: Project,
  worktree: GitWorktreeEntry,
  managedWorkspaces: readonly ManagedWorkspace[]
): ResourceOwner {
  const path = resolve(worktree.path);
  // Durable managed workspace records are the strongest ownership proof.
  for (const workspace of managedWorkspaces) {
    if (resolve(workspace.root) === path
      || workspace.entries.some((entry) => resolve(entry.path) === path)) {
      return {
        home,
        projectId: project.id,
        taskId: "taskId" in workspace.owner ? workspace.owner.taskId : undefined,
        ...(workspace.owner.type === "work-item"
          ? { workItemId: workspace.owner.workItemId }
          : {}),
        ...(workspace.owner.type === "review-round"
          ? { reviewRoundId: workspace.owner.reviewRoundId }
          : {}),
        ...(workspace.owner.type === "integration-attempt"
          ? { integrationAttemptId: workspace.owner.integrationAttemptId }
          : {}),
        basis: "durable-record"
      };
    }
  }
  // Naming convention: a task-N or task-N-<hex> path segment.
  const taskId = extractTaskIdFromPath(path);
  if (taskId !== undefined) {
    return { home, projectId: project.id, taskId, basis: "naming-convention" };
  }
  return { home, projectId: project.id, basis: "unattributed" };
}

function attributeDeploymentOwner(
  home: string,
  name: string,
  taskStatusById: ReadonlyMap<string, string>
): ResourceOwner {
  const taskId = extractTaskIdFromPath(name);
  if (taskId !== undefined && taskStatusById.has(taskId)) {
    return { home, taskId, basis: "naming-convention" };
  }
  return { home, basis: "unattributed" };
}

/** Extract a `task-N` id from a path or name segment. */
export function extractTaskIdFromPath(value: string): string | undefined {
  // Match both `task-N` (managed workspace convention) and `taskN` (legacy
  // deployment naming such as `combined-task18-<sha>`).
  const match = value.match(/(?:^|[/_-])(task-?\d+)(?:-[a-f0-9]{8})?(?:[/_$-]|$)/u);
  if (match === null || match[1] === undefined) return undefined;
  return match[1].includes("-") ? match[1] : `task-${match[1].slice(4)}`;
}

function projectRepositoryPath(home: string, project: Project): string | undefined {
  if (project.ownership === "managed") {
    const path = managedProjectPath(home, project.id);
    return existsSync(path) ? path : undefined;
  }
  return existsSync(project.path) ? project.path : undefined;
}

/**
 * Read Git metadata for a deployment that is a linked worktree. The .git
 * file points to the worktree's gitdir, which records the common dir and
 * the original branch/head needed for a controlled restore.
 */
function readDeploymentGitMetadata(
  path: string
): { repositoryPath: string; commonDir?: string; branch?: string; head?: string } | undefined {
  try {
    const gitFile = join(path, ".git");
    const gitStat = lstatSync(gitFile);
    let gitDir: string;
    if (gitStat.isFile()) {
      const content = readFileSync(gitFile, "utf8").trim();
      if (!content.startsWith("gitdir: ")) return { repositoryPath: path };
      gitDir = content.slice("gitdir: ".length);
    } else if (gitStat.isDirectory()) {
      gitDir = gitFile;
    } else {
      return { repositoryPath: path };
    }
    const resolvedGitDir = resolve(gitDir);
    const commonDirFile = join(resolvedGitDir, "commondir");
    let commonDir: string | undefined;
    if (existsSync(commonDirFile)) {
      const raw = readFileSync(commonDirFile, "utf8").trim();
      commonDir = resolve(resolvedGitDir, raw);
    }
    const headFile = join(resolvedGitDir, "HEAD");
    let head: string | undefined;
    let branch: string | undefined;
    if (existsSync(headFile)) {
      const headContent = readFileSync(headFile, "utf8").trim();
      if (headContent.startsWith("ref: refs/heads/")) {
        branch = headContent.slice("ref: ".length);
        const refPath = join(commonDir ?? resolvedGitDir, headContent.slice("ref: ".length));
        if (existsSync(refPath)) {
          head = readFileSync(refPath, "utf8").trim();
        }
      } else if (/^[0-9a-f]{40}$/u.test(headContent)) {
        head = headContent;
      }
    }
    return {
      repositoryPath: path,
      ...(commonDir === undefined ? {} : { commonDir }),
      ...(branch === undefined ? {} : { branch }),
      ...(head === undefined ? {} : { head })
    };
  } catch {
    return { repositoryPath: path };
  }
}

function readTaskRuntimeMarker(
  generationRoot: string
): { workItemId?: string; reviewRoundId?: string } | undefined {
  try {
    const marker = JSON.parse(
      readFileSync(join(generationRoot, ".yui-task-runtime-owner.json"), "utf8")
    ) as { descriptor?: { workspace?: { owner?: Record<string, unknown> } } };
    const owner = marker.descriptor?.workspace?.owner;
    if (owner === undefined || owner === null) return {};
    return {
      ...(typeof owner.workItemId === "string" ? { workItemId: owner.workItemId } : {}),
      ...(typeof owner.reviewRoundId === "string" ? { reviewRoundId: owner.reviewRoundId } : {})
    };
  } catch {
    return undefined;
  }
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function safeReaddir(path: string): readonly import("node:fs").Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return Object.freeze([]);
  }
}

function sizeOf(path: string): number | undefined {
  try {
    const stats = statSync(path);
    if (stats.isFile()) return stats.size;
    return directorySize(path);
  } catch {
    return undefined;
  }
}

function directorySize(path: string): number | undefined {
  let total = 0;
  let entries: readonly import("node:fs").Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const size = directorySize(child);
      if (size === undefined) return undefined;
      total += size;
    } else if (entry.isFile()) {
      try {
        total += statSync(child).size;
      } catch {
        return undefined;
      }
    }
  }
  return total;
}

export function resourceKindLabel(kind: ResourceKind): string {
  return kind === "worktree"
    ? "worktree"
    : kind === "deployment"
      ? "deployment"
      : "runtime-artifact";
}

export function resourceOwnerLabel(owner: ResourceOwner): string {
  if (owner.basis === "unattributed") return "unattributed";
  const parts = [
    ...(owner.taskId === undefined ? [] : [owner.taskId]),
    ...(owner.workItemId === undefined ? [] : [owner.workItemId]),
    ...(owner.reviewRoundId === undefined ? [] : [owner.reviewRoundId]),
    ...(owner.integrationAttemptId === undefined ? [] : [owner.integrationAttemptId])
  ];
  return parts.length === 0 ? owner.basis : parts.join("/");
}

export { basename as resourceBasename };
