import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskComment } from "../comment/comment.js";
import { dataError, usageError } from "../errors/cliError.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { GlobalRole, Role } from "../role/role.js";
import type { ConfiguredAgent } from "../agent/agent.js";
import type { TaskReader, TaskStore, TaskmuxConfig } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
import {
  applyStorageRollbackInWorkingRoot,
  restoreStorageBackupInWorkingRoot
} from "../storage/storageBackup.js";
import { executeDomainTransaction } from "../storage/domainTransaction.js";
import {
  DomainTransactionRecoveryError,
  replayPendingDomainTransactions,
  type DomainTransactionOperation
} from "../storage/recoveryJournal.js";
import { pruneTerminalTransactionStaging } from "../storage/transactionStagingPrune.js";

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

export function runPruneCommand(args: string[], rootDir: string, now = new Date()): string {
  validatePruneArguments(args);
  const pruneTrash = hasFlag(args, "--trash");
  const pruneBackups = hasFlag(args, "--backups");
  const dryRun = hasFlag(args, "--dry-run");

  if (!pruneTrash && !pruneBackups) {
    throw usageError("At least one prune target is required: --trash or --backups.");
  }

  const lines: string[] = dryRun ? ["Dry run"] : [];
  const prefix = dryRun ? "Would prune" : "Pruned";

  if (pruneTrash) {
    lines.push(`${prefix} trash tasks: ${pruneTrashTasks(
      rootDir,
      parseKeepTrashDays(args),
      now,
      dryRun
    )}`);
  }

  if (pruneBackups) {
    lines.push(`${prefix} backups: ${pruneBackupsAfterKeep(
      rootDir,
      parseKeepBackups(args),
      dryRun
    )}`);
  }

  return `${lines.join("\n")}\n`;
}

export type RestoreCommandResult = {
  output: string;
  rollbackId: string;
};

export function runRestoreCommand(
  args: string[],
  workingRoot: string,
  now = new Date()
): RestoreCommandResult {
  const [backupId, ...options] = args;
  if (backupId === undefined || backupId.startsWith("--")) {
    throw usageError("Restore backup id is required.");
  }
  if (options.some((option) => option !== "--force")) {
    throw usageError(`Unknown restore option: ${options.find((option) => option !== "--force")}.`);
  }
  if (options.filter((option) => option === "--force").length > 1) {
    throw usageError("Duplicate restore option: --force.");
  }
  if (!options.includes("--force")) {
    throw usageError("Physical restore requires interactive confirmation or --force.");
  }
  const restored = restoreStorageBackupInWorkingRoot(workingRoot, backupId, now);
  return {
    output: `Restored backup ${restored.backupId}\nRollback backup: ${restored.rollbackId}\n`,
    rollbackId: restored.rollbackId
  };
}

export function executeRestoreCommand(
  rootDir: string,
  transactionId: string,
  args: string[],
  extraOperations: (result: RestoreCommandResult) => DomainTransactionOperation[] = () => [],
  options: {
    executeTransaction?: typeof executeDomainTransaction;
    replayPending?: typeof replayPendingDomainTransactions;
  } = {}
): RestoreCommandResult {
  let restoreResult: RestoreCommandResult | undefined;
  const failpoint = process.env.NODE_ENV === "test"
    ? process.env.TASKMUX_TEST_ONLY_RESTORE_FAILPOINT
    : undefined;
  try {
    return (options.executeTransaction ?? executeDomainTransaction)(
      rootDir,
      transactionId,
      (workingRoot) => {
        restoreResult = runRestoreCommand(args, workingRoot);
        return restoreResult;
      },
      extraOperations,
      {
        includeBackups: true,
        testFailAfterStage: failpoint === "after-stage" || failpoint === "crash-after-stage"
      }
    );
  } catch (error) {
    if (!(error instanceof DomainTransactionRecoveryError) || restoreResult === undefined) {
      throw error;
    }
    if (failpoint === "crash-after-stage") {
      throw error;
    }

    // The restore is durably committed once its journal is staged. Finish that
    // transaction first, then publish the pre-created rollback snapshot as one
    // second atomic domain transaction. No partial restored state is exposed.
    (options.replayPending ?? replayPendingDomainTransactions)(rootDir);
    executeDomainTransaction(
      rootDir,
      `${transactionId}-rollback`,
      (workingRoot) => applyStorageRollbackInWorkingRoot(
        workingRoot,
        restoreResult!.rollbackId
      ),
      () => [],
      { includeBackups: true }
    );
    throw new Error("Restore failed and was automatically rolled back.");
  }
}

export function executePruneCommand(
  rootDir: string,
  transactionId: string,
  args: string[],
  now = new Date()
): string {
  validatePruneArguments(args);
  const pruneTransactions = hasFlag(args, "--transactions");
  const physicalArgs = args.filter((arg) => arg !== "--transactions");
  const hasPhysicalTarget = hasFlag(args, "--trash") || hasFlag(args, "--backups");
  if (!hasPhysicalTarget && !pruneTransactions) {
    throw usageError("At least one prune target is required: --trash, --backups, or --transactions.");
  }

  let output = "";
  if (hasPhysicalTarget) {
    output = executeDomainTransaction(
      rootDir,
      transactionId,
      (workingRoot) => runPruneCommand(physicalArgs, workingRoot, now),
      () => [],
      { includeBackups: true }
    );
  }
  if (pruneTransactions) {
    const dryRun = hasFlag(args, "--dry-run");
    const count = pruneTerminalTransactionStaging(rootDir, dryRun);
    const prefix = dryRun ? "Would prune" : "Pruned";
    output += `${prefix} private transaction staging: ${count}\n`;
  }
  return output;
}

function pruneTrashTasks(rootDir: string, keepDays: number, now: Date, dryRun: boolean): number {
  const trashTasksDir = join(rootDir, "trash", "tasks");

  if (!existsSync(trashTasksDir)) {
    return 0;
  }

  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  const removable = readdirSync(trashTasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    // Zero is the explicit retire-all policy and must not depend on private
    // transaction workspace mtimes. Positive retention still uses the source
    // directory age when this pure command is called on a physical root.
    .filter((name) => keepDays === 0 || lstatSync(join(trashTasksDir, name)).mtimeMs <= cutoff)
    .sort();

  if (!dryRun) {
    for (const taskId of removable) {
      rmSync(join(trashTasksDir, taskId), { recursive: true, force: true });
    }
  }

  return removable.length;
}

function pruneBackupsAfterKeep(rootDir: string, keep: number, dryRun: boolean): number {
  const backupsDir = join(rootDir, "backups");

  if (!existsSync(backupsDir)) {
    return 0;
  }

  const backups = readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^backup-/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const removable = backups.slice(keep);

  if (!dryRun) {
    for (const backup of removable) {
      rmSync(join(backupsDir, backup), { recursive: true, force: true });
    }
  }

  return removable.length;
}

function parseKeepBackups(args: string[]): number {
  return parseNonNegativeIntegerOption(args, "--keep-backups", 3);
}

function parseKeepTrashDays(args: string[]): number {
  return parseNonNegativeIntegerOption(args, "--keep-trash-days", 0);
}

function parseNonNegativeIntegerOption(args: string[], name: string, fallback: number): number {
  const value = readOptionalOption(args, name);
  if (value === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw usageError(`${name} must be a non-negative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw usageError(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function validatePruneArguments(args: string[]): void {
  const flags = new Set(["--trash", "--backups", "--transactions", "--dry-run"]);
  const options = new Set(["--keep-backups", "--keep-trash-days"]);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (seen.has(arg)) throw usageError(`Duplicate prune option: ${arg}.`);
    seen.add(arg);
    if (flags.has(arg)) continue;
    if (options.has(arg)) {
      index += 1;
      if (args[index] === undefined || args[index]?.startsWith("--")) {
        throw usageError(`${arg} is required.`);
      }
      continue;
    }
    throw usageError(`Unknown prune option: ${arg}.`);
  }
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
