import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { resolveProject } from "../repository/project.js";
import { NodeGitWorkspace } from "../repository/gitWorkspace.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  enqueueIntegrationQueueEntry,
  processIntegrationQueue,
  reconcileIntegrationQueueEntry,
  requeueIntegrationQueueEntry,
  supersedeIntegrationQueueEntry,
  type EnqueueIntegrationQueueResult
} from "../integration/integrationQueueService.js";
import type { IntegrationQueueEntry } from "../integration/integrationQueueEntry.js";
import { taskLocalActor } from "./taskActor.js";
import { parseRepeatable } from "./taskIntegrationCommands.js";
import { resolveTaskRecordReference } from "../task/taskRecordReference.js";
import type { TaskIntegrationCommandOptions } from "./taskIntegrationCommands.js";

/**
 * `yui task integration queue` — the serialized merge queue.  Only terminal
 * Candidates explicitly enqueued enter the queue; the queue never blocks
 * parallel development, it orders exact-commit integration.
 */
export async function runTaskIntegrationQueueCommand(
  args: readonly string[],
  store: TaskStore,
  home: string,
  options: TaskIntegrationCommandOptions = {}
): Promise<Readonly<{ output: string; data?: unknown }>> {
  const [command, ...rest] = args;
  if (command === "enqueue") return enqueue(rest, store, options, home);
  if (command === "list") return list(rest, store);
  if (command === "show") return show(rest, store, options.environment);
  if (command === "process") return process(rest, store, home, options);
  if (command === "supersede") return supersede(rest, store, options, home);
  if (command === "requeue") return requeue(rest, store, options, home);
  if (command === "reconcile") return reconcile(rest, store, options, home);
  throw usageError(command === undefined
    ? "Task Integration queue command is required."
    : `Unknown command: task integration queue ${command}`);
}

async function enqueue(
  args: readonly string[],
  store: TaskStore,
  options: TaskIntegrationCommandOptions,
  home: string
): Promise<Readonly<{ output: string; data?: unknown }>> {
  const usage = "Task Integration queue enqueue usage: yui task integration queue enqueue <task> --project <project> --change-set <id> [--target <ref>] [--check <command> ...].";
  const parsed = parseRepeatable(
    args,
    new Set(["--check"]),
    new Set(["--project", "--change-set", "--target"]),
    usage
  );
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const task = requireActiveTask(store, parsed.positionals[0]);
  requireTaskControlActor(store, options.environment, task.id, home);
  const projectRef = parsed.one.get("--project");
  const changeSetId = parsed.one.get("--change-set");
  if (projectRef === undefined || changeSetId === undefined) throw usageError(usage);
  const projectId = resolveProjectId(store, projectRef);
  const result: EnqueueIntegrationQueueResult = await enqueueIntegrationQueueEntry({
    store,
    taskId: task.id,
    projectId,
    changeSetId,
    targetRef: parsed.one.get("--target"),
    checkCommands: parsed.many.get("--check") ?? [],
    now: options.now
  });
  const label = {
    queued: "Enqueued",
    "already-queued": "Already queued",
    "already-committed": "Already committed",
    converged: "Converged"
  }[result.outcome];
  return {
    output: `${label} ${result.entry.changeSetId} as ${result.entry.id} (${result.entry.status})\n`,
    data: result
  };
}

function list(
  args: readonly string[],
  store: TaskStore
): Readonly<{ output: string; data: unknown }> {
  const usage = "Task Integration queue list usage: yui task integration queue list <task> [--project <project>].";
  const parsed = parseRepeatable(args, new Set(), new Set(["--project"]), usage);
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const task = requireActiveTask(store, parsed.positionals[0]);
  const projectRef = parsed.one.get("--project");
  const projectId = projectRef === undefined ? undefined : resolveProjectId(store, projectRef);
  // The store already returns entries in numeric id order; trust it instead of
  // re-sorting with a lexicographic compare (which yields 1, 10, 2, ...).
  const entries = store.listIntegrationQueueEntries(task.id)
    .filter((entry) => projectId === undefined || entry.projectId === projectId);
  const output = entries.length === 0
    ? "Integration queue is empty.\n"
    : `${renderTable(
        `Integration queue: ${task.id}`,
        [
          { header: "Entry", minWidth: 12, maxWidth: 24 },
          { header: "Project", minWidth: 8, maxWidth: 20 },
          { header: "ChangeSet", minWidth: 10, maxWidth: 20 },
          { header: "Target", minWidth: 8, maxWidth: 30 },
          { header: "Status", minWidth: 8, maxWidth: 16 }
        ],
        entries.map((entry) => [
          entry.id,
          entry.projectId,
          entry.changeSetId,
          entry.targetRef,
          entry.status
        ]),
        defaultTableWidth()
      )}\n`;
  return { output, data: { entries } };
}

function show(
  args: readonly string[],
  store: TaskStore,
  environment: NodeJS.ProcessEnv | undefined
): Readonly<{ output: string; data: unknown }> {
  const usage = "Task Integration queue show usage: yui task integration queue show <task>/<entry>.";
  if (args.length !== 1) throw usageError(usage);
  const entry = requireQueueEntry(store, args[0], environment);
  const lines = [
    `Integration queue entry: ${entry.id}`,
    `Task: ${entry.taskId}`,
    `Project: ${entry.projectId}`,
    `ChangeSet: ${entry.changeSetId}`,
    `Target: ${entry.targetRef}`,
    `Status: ${entry.status}`,
    `Target before: ${entry.targetBefore ?? "-"}`,
    `Target after: ${entry.targetAfter ?? "-"}`,
    `Integration: ${entry.integrationAttemptId ?? "-"}`,
    `Affected paths: ${entry.affectedPaths === undefined ? "-" : entry.affectedPaths.join(", ")}`,
    `Evidence: ${entry.evidenceRefs.length === 0 ? "-" : entry.evidenceRefs.join(", ")}`,
    `Conflict: ${entry.conflictSummary ?? "-"}`,
    `Superseded: ${entry.supersedeReason ?? "-"}`
  ];
  return { output: `${lines.join("\n")}\n`, data: { entry } };
}

async function process(
  args: readonly string[],
  store: TaskStore,
  home: string,
  options: TaskIntegrationCommandOptions
): Promise<Readonly<{ output: string; data?: unknown }>> {
  const usage = "Task Integration queue process usage: yui task integration queue process <task> [--project <project>] [--limit <n>].";
  const parsed = parseRepeatable(args, new Set(), new Set(["--project", "--limit"]), usage);
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const task = requireActiveTask(store, parsed.positionals[0]);
  requireTaskControlActor(store, options.environment, task.id, home);
  const limitValue = parsed.one.get("--limit");
  const limit = limitValue === undefined ? undefined : Number.parseInt(limitValue, 10);
  if (limitValue !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1)) {
    throw usageError(`--limit must be a positive integer: ${limitValue}.`);
  }
  const projectRef = parsed.one.get("--project");
  const projectId = projectRef === undefined ? undefined : resolveProjectId(store, projectRef);
  const processed = await processIntegrationQueue(store, home, task.id, {
    projectId,
    limit,
    now: options.now,
    environment: options.environment
  });
  const lines = processed.map(({ entry, result }) => {
    if (result.status === "committed") {
      return `${entry.id} committed ${entry.changeSetId} -> ${entry.targetAfter ?? "-"}`;
    }
    if (result.status === "blocked") {
      return `${entry.id} conflicted ${entry.changeSetId}: ${entry.conflictSummary ?? "blocked"}`;
    }
    return `${entry.id} conflicted ${entry.changeSetId}: ${entry.conflictSummary ?? "gate failure"}`;
  });
  const output = processed.length === 0
    ? "Integration queue: nothing to process.\n"
    : `${lines.join("\n")}\n`;
  return { output, data: { processed } };
}

function supersede(
  args: readonly string[],
  store: TaskStore,
  options: TaskIntegrationCommandOptions,
  home: string
): Readonly<{ output: string; data: unknown }> {
  const usage = "Task Integration queue supersede usage: yui task integration queue supersede <task>/<entry> --reason <text>.";
  const parsed = parseRepeatable(args, new Set(), new Set(["--reason"]), usage);
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const entry = requireQueueEntry(store, parsed.positionals[0], options.environment);
  const actor = requireTaskControlActor(store, options.environment, entry.taskId, home);
  const reason = parsed.one.get("--reason");
  if (reason === undefined) throw usageError(usage);
  const superseded = supersedeIntegrationQueueEntry(
    store,
    entry.taskId,
    entry.id,
    reason,
    actor,
    options.now ?? (() => new Date())
  );
  return {
    output: `Superseded ${superseded.id}: ${reason}\n`,
    data: { entry: superseded }
  };
}

function requeue(
  args: readonly string[],
  store: TaskStore,
  options: TaskIntegrationCommandOptions,
  home: string
): Readonly<{ output: string; data: unknown }> {
  const usage = "Task Integration queue requeue usage: yui task integration queue requeue <task>/<entry>.";
  if (args.length !== 1) throw usageError(usage);
  const entry = requireQueueEntry(store, args[0], options.environment);
  const actor = requireTaskControlActor(store, options.environment, entry.taskId, home);
  const waiting = requeueIntegrationQueueEntry(
    store,
    entry.taskId,
    entry.id,
    actor,
    options.now ?? (() => new Date())
  );
  return {
    output: `Requeued ${waiting.id}; it will be processed again on the next queue run\n`,
    data: { entry: waiting }
  };
}

async function reconcile(
  args: readonly string[],
  store: TaskStore,
  options: TaskIntegrationCommandOptions,
  home: string
): Promise<Readonly<{ output: string; data: unknown }>> {
  const usage = "Task Integration queue reconcile usage: yui task integration queue reconcile <task>/<entry>.";
  if (args.length !== 1) throw usageError(usage);
  const entry = requireQueueEntry(store, args[0], options.environment);
  requireTaskControlActor(store, options.environment, entry.taskId, home);
  const committed = await reconcileIntegrationQueueEntry(
    store,
    entry.taskId,
    entry.id,
    new NodeGitWorkspace(),
    options.now ?? (() => new Date())
  );
  return {
    output: `Reconciled ${committed.id} as committed -> ${committed.targetAfter ?? "-"}\n`,
    data: { entry: committed }
  };
}

function requireActiveTask(store: TaskStore, taskId: string) {
  const task = store.getTask(taskId);
  if (task === null) throw usageError(`Task not found: ${taskId}.`);
  if (task.status !== "active") {
    throw usageError(`Task is not active: ${task.id}/${task.status}.`);
  }
  return task;
}

function resolveProjectId(store: TaskStore, reference: string): string {
  const project = resolveProject(store.listProjects(), reference);
  if (project === null) throw usageError(`Project not found: ${reference}.`);
  return project.id;
}

function requireQueueEntry(
  store: TaskStore,
  value: string,
  environment: NodeJS.ProcessEnv | undefined
): IntegrationQueueEntry {
  let reference;
  try {
    reference = resolveTaskRecordReference(value, {
      kind: "integrationQueue",
      contextTaskId: environment?.YUI_TASK_ID,
      label: "Integration queue entry"
    });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  const entry = store.getIntegrationQueueEntry(reference.taskId, reference.localId);
  if (entry === null) {
    throw usageError(
      `Integration queue entry not found: ${reference.taskId}/${reference.localId}.`
    );
  }
  return entry;
}

function requireTaskControlActor(
  store: TaskStore,
  environment: NodeJS.ProcessEnv | undefined,
  taskId: string,
  home?: string
) {
  return taskLocalActor(store, environment, taskId);
}
