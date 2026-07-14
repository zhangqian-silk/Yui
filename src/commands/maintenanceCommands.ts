import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskComment } from "../comment/comment.js";
import { dataError, usageError } from "../errors/cliError.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { GlobalRole, Role } from "../role/role.js";
import type { ConfiguredAgent } from "../agent/agent.js";
import type { TaskReader, TaskStore, TaskmuxConfig } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";

type TaskSnapshot = {
  task: Task;
  roles: Array<{ role: Role; transcript: string | null }>;
  comments: TaskComment[];
  events: TaskEvent[];
};

type TaskmuxSnapshot = {
  schemaVersion: 1;
  exportedAt: string;
  config: TaskmuxConfig;
  agents: ConfiguredAgent[];
  roles?: GlobalRole[];
  tasks: TaskSnapshot[];
};

export function runExportCommand(args: string[], store: TaskStore): string {
  const output = readOption(args, "--output");
  const snapshot = store.runReadSnapshot((reader) => exportSnapshot(reader));

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);

  return `Exported TaskMux data to ${output}\n`;
}

function exportSnapshot(store: TaskReader): TaskmuxSnapshot {
  const { completionInstallations: _hostLocalCompletion, ...portableConfig } = store.getConfig();
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    config: portableConfig,
    agents: store.listConfiguredAgents(),
    roles: store.listGlobalRoles(),
    tasks: store.listTasks().map((task) => ({
      task,
      roles: store.listRoles(task.id).map((role) => ({
        role,
        transcript: store.readTranscript(task.id, role.name)
      })),
      comments: store.listComments(task.id),
      events: store.listEvents(task.id)
    }))
  };
}

export function runImportCommand(args: string[], store: TaskStore): string {
  const [input] = args;

  if (input === undefined || input.trim().length === 0) {
    throw usageError("Import file is required.");
  }

  const snapshot = parseSnapshot(readFileSync(input, "utf8"));

  const targetCompletionInstallations = store.getConfig().completionInstallations;
  const { completionInstallations: _importedHostLocalCompletion, ...portableConfig } = snapshot.config;
  store.saveConfig({ ...portableConfig, completionInstallations: targetCompletionInstallations });

  for (const agent of snapshot.agents) {
    store.saveConfiguredAgent(agent);
  }

  for (const role of snapshot.roles ?? []) {
    store.saveGlobalRole(role);
  }

  for (const taskSnapshot of snapshot.tasks) {
    store.saveTask(taskSnapshot.task);

    for (const { role, transcript } of taskSnapshot.roles) {
      store.saveRole(taskSnapshot.task.id, role);

      if (transcript !== null) {
        store.saveTranscript(taskSnapshot.task.id, role.name, transcript);
      }
    }

    for (const comment of taskSnapshot.comments) {
      store.saveComment(taskSnapshot.task.id, comment);
    }

    for (const event of taskSnapshot.events) {
      store.saveEvent(taskSnapshot.task.id, event);
    }
  }

  return `Imported TaskMux data from ${input}\n`;
}

export function runPruneCommand(args: string[], rootDir: string): string {
  const pruneTrash = hasFlag(args, "--trash");
  const pruneBackups = hasFlag(args, "--backups");

  if (!pruneTrash && !pruneBackups) {
    throw usageError("At least one prune target is required: --trash or --backups.");
  }

  const lines: string[] = [];

  if (pruneTrash) {
    lines.push(`Pruned trash tasks: ${pruneTrashTasks(rootDir)}`);
  }

  if (pruneBackups) {
    lines.push(`Pruned backups: ${pruneBackupsAfterKeep(rootDir, parseKeepBackups(args))}`);
  }

  return `${lines.join("\n")}\n`;
}

function pruneTrashTasks(rootDir: string): number {
  const trashTasksDir = join(rootDir, "trash", "tasks");

  if (!existsSync(trashTasksDir)) {
    return 0;
  }

  const count = readdirSync(trashTasksDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  rmSync(trashTasksDir, { recursive: true, force: true });

  return count;
}

function pruneBackupsAfterKeep(rootDir: string, keep: number): number {
  const backupsDir = join(rootDir, "backups");

  if (!existsSync(backupsDir)) {
    return 0;
  }

  const backups = readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const removable = backups.slice(keep);

  for (const backup of removable) {
    rmSync(join(backupsDir, backup), { recursive: true, force: true });
  }

  return removable.length;
}

function parseKeepBackups(args: string[]): number {
  const value = readOptionalOption(args, "--keep-backups");

  if (value === undefined) {
    return 3;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw usageError("--keep-backups must be a non-negative integer.");
  }

  return parsed;
}

function parseSnapshot(raw: string): TaskmuxSnapshot {
  const value = JSON.parse(raw) as unknown;

  if (!isSnapshot(value)) {
    throw dataError("Invalid TaskMux export snapshot");
  }

  return value;
}

function isSnapshot(value: unknown): value is TaskmuxSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
    Array.isArray((value as { tasks?: unknown }).tasks) &&
    Array.isArray((value as { agents?: unknown }).agents) &&
    typeof (value as { config?: unknown }).config === "object"
  );
}

function readOption(args: string[], name: string): string {
  const value = readOptionalOption(args, name);

  if (value === undefined) {
    throw usageError(`${name} is required.`);
  }

  return value;
}

function readOptionalOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  if (args[index + 1] === undefined || args[index + 1].startsWith("--")) {
    throw usageError(`${name} is required.`);
  }

  return args[index + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}
