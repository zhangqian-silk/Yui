import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

import type { ExecutionLaneGitSnapshot } from "../execution/executionGroup.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";

/**
 * Freeze the exact committed heads of a durable managed Lane workspace at the
 * synchronous runtime-terminalization boundary. Runtime event folds are
 * synchronous inside the SQLite aggregate transaction, so this small Git read
 * cannot use the asynchronous workspace-preparation port.
 */
export function snapshotExecutionLaneWorkspaceSync(
  store: Pick<TaskStore, "getManagedWorkspace">,
  workspace: ManagedWorkspace
): ExecutionLaneGitSnapshot | undefined {
  if (workspace.owner.type !== "execution-lane") {
    throw new Error("Only an Execution Lane workspace can freeze a producer result.");
  }
  const stored = store.getManagedWorkspace(workspace.owner);
  if (stored === null || !isDeepStrictEqual(stored, workspace)) {
    throw new Error("Execution Lane managed workspace is not the durable owner.");
  }
  const writable = workspace.entries.filter(({ access }) => access === "write");
  if (writable.length === 0) return undefined;
  const projects: ExecutionLaneGitSnapshot["projects"][number][] = [];
  for (const entry of writable) {
    const status = git(entry.path, ["status", "--porcelain"]);
    if (status === undefined || status.length > 0) return undefined;
    const branch = git(entry.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const headCommit = git(entry.path, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (branch !== entry.branch || headCommit === undefined) return undefined;
    projects.push({
      projectId: entry.projectId,
      headCommit: headCommit.toLowerCase(),
      branch
    });
  }
  return { schemaVersion: 1, projects };
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
