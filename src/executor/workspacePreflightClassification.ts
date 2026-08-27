import { isDeepStrictEqual } from "node:util";

import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import { isTaskOwnedWorkspace } from "../worktree/managedWorkspace.js";

function ownerLabel(owner: ManagedWorkspace["owner"]): string {
  switch (owner.type) {
    case "task":
      return owner.taskId;
    case "work-item":
      return `${owner.taskId}/${owner.workItemId}`;
    case "review-round":
      return `${owner.taskId}/${owner.reviewRoundId}`;
    case "integration-attempt":
      return `${owner.taskId}/${owner.integrationAttemptId}`;
    case "execution-lane":
      return `${owner.taskId}/${owner.executionGroupId}/${owner.executionLaneId}`;
  }
}

/**
 * Quick Win (EXE-04/EXE-08): classified workspace preflight failures.
 *
 * A split-brain workspace state must never be reported as a transient
 * Provider failure, because retrying the same launch will not change the
 * configuration.  Each classification carries the precise diff between the
 * authoritative records so the Operator can decide whether to repair the
 * workspace, re-sync the baseline, or recreate the Task.
 */
export type WorkspacePreflightClassification =
  | Readonly<{
      kind: "owner-invalid";
      reason: string;
      taskId: string;
      roleName: string;
      expected: string;
      actual: string;
    }>
  | Readonly<{
      kind: "workspace-stale";
      reason: string;
      taskId: string;
      roleName: string;
      runId: string;
      diff: readonly string[];
    }>
  | Readonly<{
      kind: "physical-drift";
      reason: string;
      taskId: string;
      roleName: string;
      projectId: string;
      expectedCommit: string;
      physicalCommit: string;
    }>;

/**
 * Classify a workspace preflight failure.  Returns `null` when the workspace
 * is healthy and the launch may proceed.
 *
 * This is a read-only check: it never mutates Git state, creates Sessions, or
 * writes recovery records.
 */
export function classifyWorkspacePreflight(
  store: TaskStore,
  task: Task,
  roleName: string,
  activeRun: { id: string; workspace?: ManagedWorkspace } | null
): WorkspacePreflightClassification | null {
  const main = store.getTaskWorkspace(task.id);
  const bindings = task.projectBindings.map(
    ({ projectId, directory }) => ({ projectId, directory })
  );

  // 1. Owner validation: the Task main workspace must be a durable,
  //    Task-owned ManagedWorkspace whose root matches the Task cwd and whose
  //    entries match the Project bindings.
  const mainForDiagnostic = main;
  if (!isTaskOwnedWorkspace(main, task.id, task.cwd, bindings)) {
    const expected = `task-owned @ ${task.cwd ?? "(no cwd)"} with ${bindings.length} project binding(s)`;
    const actual = mainForDiagnostic === null
      ? "no ManagedWorkspace"
      : `${mainForDiagnostic.owner.type}/${ownerLabel(mainForDiagnostic.owner)} @ ${mainForDiagnostic.root} with ${mainForDiagnostic.entries.length} entries`;
    return {
      kind: "owner-invalid",
      reason: `Task main workspace is not a durable Task-owned workspace: ${task.id}/${roleName}.`,
      taskId: task.id,
      roleName,
      expected,
      actual
    };
  }

  // 2. Run snapshot validation: when the active Run carries a workspace
  //    snapshot it must match the durable ManagedWorkspace exactly.  A
  //    mismatch means the Run was created against a stale baseline.
  if (activeRun?.workspace !== undefined) {
    const durableRunWorkspace = store.getManagedWorkspace(activeRun.workspace.owner);
    if (durableRunWorkspace === null || !isDeepStrictEqual(durableRunWorkspace, activeRun.workspace)) {
      const diff: string[] = [];
      if (durableRunWorkspace === null) {
        diff.push(`durable ManagedWorkspace for owner ${JSON.stringify(activeRun.workspace.owner)} is missing`);
      } else {
        if (durableRunWorkspace.root !== activeRun.workspace.root) {
          diff.push(`root: durable=${durableRunWorkspace.root} run=${activeRun.workspace.root}`);
        }
        if (durableRunWorkspace.entries.length !== activeRun.workspace.entries.length) {
          diff.push(`entries: durable=${durableRunWorkspace.entries.length} run=${activeRun.workspace.entries.length}`);
        }
        for (const [index, entry] of activeRun.workspace.entries.entries()) {
          const durableEntry = durableRunWorkspace.entries[index];
          if (durableEntry === undefined) {
            diff.push(`entry[${index}] ${entry.projectId}: missing from durable`);
            continue;
          }
          if (durableEntry.baseCommit !== entry.baseCommit) {
            diff.push(`entry[${index}] ${entry.projectId} baseCommit: durable=${durableEntry.baseCommit} run=${entry.baseCommit}`);
          }
          if (durableEntry.branch !== entry.branch) {
            diff.push(`entry[${index}] ${entry.projectId} branch: durable=${durableEntry.branch} run=${entry.branch}`);
          }
        }
      }
      return {
        kind: "workspace-stale",
        reason: `Role Run workspace is not the durable owner: ${task.id}/${roleName}.`,
        taskId: task.id,
        roleName,
        runId: activeRun.id,
        diff
      };
    }
  }

  return null;
}

/**
 * Format a classification as a human-readable error message that includes the
 * precise diff between authoritative records.
 */
export function formatWorkspacePreflightError(
  classification: WorkspacePreflightClassification
): string {
  const lines = [classification.reason];
  switch (classification.kind) {
    case "owner-invalid":
      lines.push(`  expected: ${classification.expected}`);
      lines.push(`  actual:   ${classification.actual}`);
      lines.push("  Use `yui task base status " + classification.taskId
        + "` to inspect the binding, ManagedWorkspace, and physical HEAD.");
      break;
    case "workspace-stale":
      lines.push(`  Run ${classification.runId} snapshot differs from the durable ManagedWorkspace:`);
      for (const entry of classification.diff) {
        lines.push(`    - ${entry}`);
      }
      lines.push("  This is a configuration error, not a transient Provider failure.");
      lines.push("  Use `yui task base status " + classification.taskId
        + "` to inspect the split state, then repair or re-sync the workspace.");
      break;
    case "physical-drift":
      lines.push(`  Project ${classification.projectId}: expected ${classification.expectedCommit}, physical HEAD is ${classification.physicalCommit}.`);
      lines.push("  The physical workspace has drifted from the recorded baseline.");
      lines.push("  Use `yui task base status " + classification.taskId + "` to inspect the drift.");
      break;
  }
  return lines.join("\n");
}
