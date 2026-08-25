import { usageError } from "../errors/cliError.js";
import { createMilestone } from "../milestone/milestone.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import type {
  FileTaskWorkspacePreparer,
  LegacyTaskRef
} from "../repository/taskWorkspacePreparer.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
import { runTaskCommand } from "./taskCommands.js";

export type TaskWorkspaceCommandResult = Readonly<{
  output: string;
  data?: unknown;
}>;

/**
 * Task workspace lifecycle commands that sit outside the sync task command
 * surface because they drive Git: controlled rebuild of a legacy Task
 * workspace, legacy ref history inspection/archival, and the
 * replacement-creating path for terminal Tasks.
 */
export async function runTaskWorkspaceCommand(
  args: readonly string[],
  store: TaskStore,
  preparer: FileTaskWorkspacePreparer,
  options: { now?: () => Date } = {}
): Promise<TaskWorkspaceCommandResult> {
  const [command, ...rest] = args;
  if (command === "rebuild") return rebuildTaskCommand(rest, preparer);
  if (command === "history") return historyCommand(rest, preparer);
  if (command === "replace") return replaceTaskCommand(rest, store, options);
  throw usageError(
    "Unknown task workspace command. Available: yui task rebuild <task>, "
      + "yui task history list|archive [task], yui task replace <task>."
  );
}

async function rebuildTaskCommand(
  args: readonly string[],
  preparer: FileTaskWorkspacePreparer
): Promise<TaskWorkspaceCommandResult> {
  const usage = "Task rebuild usage: yui task rebuild <task> [--latest].";
  const taskId = args[0];
  const options = new Set(args.slice(1));
  if (taskId === undefined
    || options.size !== args.length - 1
    || [...options].some((option) => option !== "--latest")) {
    throw usageError(usage);
  }
  const result = await preparer.rebuildTaskWorkspace(taskId, {
    latestRemote: options.has("--latest")
  });
  const archived = result.archived.length === 0
    ? "no legacy refs"
    : `${result.archived.length} legacy ref(s) archived`;
  const resumed = result.resumed ? " (resumed pending cleanup)" : "";
  return {
    output: `Rebuilt Task workspace ${result.task.id} at ${result.task.cwd ?? "its configured workspace"}: `
      + `${archived}${resumed}.`,
    data: {
      taskId: result.task.id,
      archived: result.archived,
      resumed: result.resumed,
      latestRemote: options.has("--latest")
    }
  };
}

async function historyCommand(
  args: readonly string[],
  preparer: FileTaskWorkspacePreparer
): Promise<TaskWorkspaceCommandResult> {
  const usage = "Task history usage: yui task history list|archive [task].";
  const action = args[0];
  if (action !== "list" && action !== "archive") throw usageError(usage);
  const taskId = args[1];
  if (args.length > 2) throw usageError(usage);
  if (action === "list") {
    const refs = await preparer.listLegacyTaskRefs(taskId);
    if (refs.length === 0) {
      return { output: "No legacy Task refs.", data: { refs: [] } };
    }
    return {
      output: renderTable(
        "Legacy Task refs",
        [
          { header: "Project", minWidth: 8, maxWidth: 24 },
          { header: "Task", minWidth: 8, maxWidth: 16 },
          { header: "Legacy ref", minWidth: 16, maxWidth: 64 }
        ],
        refs.map((entry: LegacyTaskRef) => [entry.projectId, entry.taskId, entry.ref]),
        defaultTableWidth()
      ),
      data: { refs }
    };
  }
  const result = await preparer.archiveLegacyTaskRefs(taskId);
  const lines: string[] = [];
  if (result.archived.length > 0) {
    lines.push(`Archived ${result.archived.length} legacy ref(s):`);
    lines.push(...result.archived.map((entry) => `  ${entry}`));
  }
  if (result.refused.length > 0) {
    lines.push(`Refused ${result.refused.length} live ref(s) owned by an open Task:`);
    lines.push(...result.refused.map((entry) => `  ${entry}`));
  }
  if (lines.length === 0) lines.push("No legacy Task refs to archive.");
  return {
    output: lines.join("\n"),
    data: { archived: result.archived, refused: result.refused }
  };
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
  if (old.status === "draft" || old.status === "active") {
    throw usageError(`Task is open and can be rebuilt instead of replaced: ${old.id}.`);
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
    now
  );
  store.saveMilestone(replacement.id, milestone);
  return {
    output: `${created.output}\nRecorded replacement of ${old.id} on ${replacement.id} `
      + `(milestone ${milestone.id}).`,
    data: { task: replacement, replaces: old.id, milestone: milestone.id }
  };
}
