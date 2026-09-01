import { usageError } from "../errors/cliError.js";
import { createMilestone } from "../milestone/milestone.js";
import type { FileTaskWorkspacePreparer } from "../repository/taskWorkspacePreparer.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
import { runTaskCommand } from "./taskCommands.js";

export type TaskWorkspaceCommandResult = Readonly<{
  output: string;
  data?: unknown;
}>;

/**
 * Task workspace lifecycle command that sits outside the sync task command
 * surface because replacement preserves the terminal Task and creates a new
 * current-contract Task.
 */
export async function runTaskWorkspaceCommand(
  args: readonly string[],
  store: TaskStore,
  preparer: FileTaskWorkspacePreparer,
  options: { now?: () => Date } = {}
): Promise<TaskWorkspaceCommandResult> {
  const [command, ...rest] = args;
  void preparer;
  if (command === "replace") return replaceTaskCommand(rest, store, options);
  throw usageError("Unknown task workspace command. Available: yui task replace <task>.");
}

/**
 * A terminal (retired/completed/archived) Task is never rewritten in place.
 * This creates a fresh draft Task bound to the same Projects at the same
 * bases and records the relationship as a milestone on the replacement, so
 * the original Task, its refs, and its evidence stay untouched.
 */
function replaceTaskCommand(
  args: readonly string[],
  store: TaskStore,
  options: { now?: () => Date }
): TaskWorkspaceCommandResult {
  const usage = "Task replace usage: yui task replace <task> [--title <text>].";
  const oldId = args[0];
  if (oldId === undefined) throw usageError(usage);
  const old = store.getTask(oldId);
  if (old === null) throw usageError(`Task not found: ${oldId}.`);
  if (old.status === "draft") {
    throw usageError(
      `Draft Task ${old.id} owns no completed history to replace; activate it or retire it and create a new Draft.`
    );
  }
  if (old.status === "active") {
    throw usageError(`Active Task cannot be replaced: ${old.id}.`);
  }
  let title = `Replaces ${old.id}: ${old.title}`;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === "--title") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw usageError(usage);
      title = value;
      index += 1;
      continue;
    }
    throw usageError(usage);
  }
  const createArgs = ["create", title];
  for (const binding of old.projectBindings) {
    createArgs.push("--project", binding.projectId);
    createArgs.push("--base", `${binding.projectId}=${binding.baseRef}`);
  }
  if (old.type !== undefined) createArgs.push("--type", old.type);
  const created = runTaskCommand(createArgs, store);
  if (created.kind !== "output") {
    throw new Error(`Task replacement could not be created for ${old.id}.`);
  }
  const data = created.data as { task?: Task } | undefined;
  const replacement = data?.task;
  if (replacement === undefined) {
    throw new Error(`Task replacement result did not name the new Task for ${old.id}.`);
  }
  const now = options.now?.() ?? new Date();
  const milestone = createMilestone(
    store.nextMilestoneId(replacement.id),
    replacement.id,
    `Replaces ${old.id}`,
    `Replacement Task for ${old.id} (${old.status}); the original Task, its refs, `
      + "and its evidence are preserved and were not rewritten.",
    "user",
    now
  );
  store.saveMilestone(replacement.id, milestone);
  return {
    output: `${created.output}\nRecorded replacement of ${old.id} on ${replacement.id} `
      + `(milestone ${milestone.id}).`,
    data: { task: replacement, replaces: old.id, milestone: milestone.id }
  };
}
