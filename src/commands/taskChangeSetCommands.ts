import { usageError } from "../errors/cliError.js";
import type { ChangeSet } from "../integration/changeSet.js";
import type { TaskStore } from "../storage/taskStore.js";
import { resolveTaskRecordReference } from "../task/taskRecordReference.js";

/** Read-only ChangeSet inspection, including its integration manifest. */
export async function runTaskChangeSetCommand(
  args: readonly string[],
  store: TaskStore
): Promise<Readonly<{ output: string; data?: unknown }>> {
  const [command, ...rest] = args;
  if (command === "show") return show(rest, store);
  throw usageError(command === undefined
    ? "Task ChangeSet command is required."
    : `Unknown command: task change-set ${command}`);
}

function show(
  args: readonly string[],
  store: TaskStore
): Readonly<{ output: string; data?: unknown }> {
  if (args.length !== 1) {
    throw usageError("Task ChangeSet show usage: yui task change-set show <task>/<change-set>.");
  }
  let reference;
  try {
    reference = resolveTaskRecordReference(args[0], {
      kind: "changeSet",
      label: "ChangeSet"
    });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  const changeSet = store.getChangeSet(reference.taskId, reference.localId);
  if (changeSet === null) {
    throw usageError(`ChangeSet not found: ${reference.taskId}/${reference.localId}.`);
  }
  return {
    output: renderChangeSet(changeSet),
    data: { changeSet }
  };
}

function renderChangeSet(changeSet: ChangeSet): string {
  const lines = [
    `ChangeSet: ${changeSet.id}`,
    `Task: ${changeSet.taskId}`,
    `WorkItem: ${changeSet.workItemId}`,
    `Project: ${changeSet.projectId}`,
    `Base: ${changeSet.baseCommit}`,
    `Head: ${changeSet.headCommit}`,
    `Branch: ${changeSet.branch}`,
    `Changed paths: ${changeSet.changedPaths.length}`,
    ...changeSet.changedPaths.map((path) => `  ${path}`),
    `Created: ${changeSet.createdAt}`
  ];
  const manifest = changeSet.manifest;
  lines.push(
    "Manifest:",
    `  Tags: ${manifest.tags.join(", ")}`,
    `  Deleted paths: ${manifest.deletedPaths.length}`,
    ...manifest.deletedPaths.map((path) => `    ${path}`),
    `  Target: ${manifest.targetRef ?? "-"}`
  );
  return `${lines.join("\n")}\n`;
}
