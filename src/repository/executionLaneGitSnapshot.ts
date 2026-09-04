import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

import type { TaskStore } from "../storage/taskStore.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";

export type ExecutionLaneGitSnapshot = Readonly<{
  schemaVersion: 1;
  projects: readonly Readonly<{
    projectId: string;
    headCommit: string;
    branch: string;
  }>[];
}>;

export type ExecutionLaneGitSnapshotResult =
  | Readonly<{ status: "captured"; snapshot: ExecutionLaneGitSnapshot }>
  | Readonly<{
      status: "failed";
      cause: "no-writable-project" | "workspace-unavailable" | "workspace-dirty" | "branch-mismatch";
      diagnostic: string;
    }>;

/**
 * Freeze the exact committed heads of a durable managed Lane workspace at the
 * synchronous runtime-terminalization boundary. Runtime event folds are
 * synchronous inside the SQLite aggregate transaction, so this small Git read
 * cannot use the asynchronous workspace-preparation port.
 */
export function snapshotExecutionLaneWorkspaceSync(
  store: Pick<TaskStore, "getManagedWorkspace">,
  workspace: ManagedWorkspace
): ExecutionLaneGitSnapshotResult {
  if (workspace.owner.type !== "execution-lane") {
    throw new Error("Only an Execution Lane workspace can freeze a producer result.");
  }
  const stored = store.getManagedWorkspace(workspace.owner);
  if (stored === null || !isDeepStrictEqual(stored, workspace)) {
    throw new Error("Execution Lane managed workspace is not the durable owner.");
  }
  const writable = workspace.entries.filter(({ access }) => access === "write");
  if (writable.length === 0) {
    return {
      status: "failed",
      cause: "no-writable-project",
      diagnostic: "Core could not freeze an Execution Lane with no writable Project."
    };
  }
  const projects: ExecutionLaneGitSnapshot["projects"][number][] = [];
  for (const entry of writable) {
    const status = git(entry.path, ["status", "--porcelain"]);
    if (status === undefined) {
      return {
        status: "failed",
        cause: "workspace-unavailable",
        diagnostic: `Core could not inspect writable Project ${entry.projectId} at ${entry.path}.`
      };
    }
    if (status.length > 0) {
      return {
        status: "failed",
        cause: "workspace-dirty",
        diagnostic: `Writable Project ${entry.projectId} is dirty; Core did not accept the Lane result.`
      };
    }
    const branch = git(entry.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const headCommit = git(entry.path, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (branch === undefined || headCommit === undefined) {
      return {
        status: "failed",
        cause: "workspace-unavailable",
        diagnostic: `Core could not resolve the branch and commit for writable Project ${entry.projectId}.`
      };
    }
    if (branch !== entry.branch) {
      return {
        status: "failed",
        cause: "branch-mismatch",
        diagnostic: `Writable Project ${entry.projectId} is on branch ${branch}; expected ${entry.branch}.`
      };
    }
    projects.push({
      projectId: entry.projectId,
      headCommit: headCommit.toLowerCase(),
      branch
    });
  }
  return {
    status: "captured",
    snapshot: { schemaVersion: 1, projects }
  };
}

function git(cwd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch {
    return undefined;
  }
}
