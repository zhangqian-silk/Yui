import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import {
  isTaskOwnedWorkspace,
  sameManagedWorkspaceIdentity,
  type WorkspaceProjectEntry
} from "../worktree/managedWorkspace.js";

export type WorkspacePhysicalInspection = Readonly<{
  physicalCommit: string;
  recordedBaseIsAncestor: boolean;
}>;

export type WorkspacePhysicalInspector = (
  entry: WorkspaceProjectEntry
) => WorkspacePhysicalInspection;

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
 * Provider failure, because retrying the same runtime generation will not change the
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
      turnId: string;
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
  activeTurn: { id: string; workspace?: ManagedWorkspace } | null,
  inspectPhysical?: WorkspacePhysicalInspector
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

  // 2. Turn snapshot validation: when the active Turn carries a workspace
  //    snapshot its launch-stable identity must match the durable
  //    ManagedWorkspace. Audit timestamps may change without changing the
  //    owner, root, or Project entries authorized for the Turn.
  if (activeTurn?.workspace !== undefined) {
    const durableRunWorkspace = store.getManagedWorkspace(activeTurn.workspace.owner);
    if (durableRunWorkspace === null
      || !sameManagedWorkspaceIdentity(durableRunWorkspace, activeTurn.workspace)) {
      const diff: string[] = [];
      if (durableRunWorkspace === null) {
        diff.push(`durable ManagedWorkspace for owner ${JSON.stringify(activeTurn.workspace.owner)} is missing`);
      } else {
        if (durableRunWorkspace.root !== activeTurn.workspace.root) {
          diff.push(`root: durable=${durableRunWorkspace.root} run=${activeTurn.workspace.root}`);
        }
        if (durableRunWorkspace.entries.length !== activeTurn.workspace.entries.length) {
          diff.push(`entries: durable=${durableRunWorkspace.entries.length} run=${activeTurn.workspace.entries.length}`);
        }
        for (const [index, entry] of activeTurn.workspace.entries.entries()) {
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
        reason: `Role Turn workspace is not the durable owner: ${task.id}/${roleName}.`,
        taskId: task.id,
        roleName,
        turnId: activeTurn.id,
        diff
      };
    }
  }

  // 3. Physical validation: committed work may advance a managed branch, so
  // HEAD need not equal its recorded base. It must, however, still descend
  // from that immutable boundary. A reset/repoint outside the lineage is
  // physical drift and must fail before Provider launch.
  if (inspectPhysical !== undefined) {
    const effective = activeTurn?.workspace ?? main;
    for (const entry of effective.entries) {
      const physical = inspectPhysical(entry);
      if (!physical.recordedBaseIsAncestor) {
        return {
          kind: "physical-drift",
          reason: `Managed workspace physical HEAD left its recorded lineage: ${task.id}/${roleName}.`,
          taskId: task.id,
          roleName,
          projectId: entry.projectId,
          expectedCommit: entry.baseCommit,
          physicalCommit: physical.physicalCommit
        };
      }
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
      lines.push(`  Turn ${classification.turnId} snapshot differs from the durable ManagedWorkspace:`);
      for (const entry of classification.diff) {
        lines.push(`    - ${entry}`);
      }
      lines.push("  This is a configuration error, not a transient Provider failure.");
      lines.push("  Use `yui task base status " + classification.taskId
        + "` to inspect the split state, then repair or re-sync the workspace.");
      break;
    case "physical-drift":
      lines.push(`  Project ${classification.projectId}: recorded base ${classification.expectedCommit}, physical HEAD is ${classification.physicalCommit}.`);
      lines.push("  The physical workspace has drifted from the recorded baseline.");
      lines.push("  Use `yui task base status " + classification.taskId + "` to inspect the drift.");
      break;
  }
  return lines.join("\n");
}
