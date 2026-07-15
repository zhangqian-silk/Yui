import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { CliError, dataError, usageError } from "../errors/cliError.js";
import { FileTaskStore } from "../storage/taskStore.js";
import {
  applyStorageRollbackInWorkingRoot,
  restoreStorageBackupInWorkingRoot
} from "../storage/storageBackup.js";
import {
  executeDomainTransaction,
  hasActiveDomainTransactionAuthority
} from "../storage/domainTransaction.js";
import type { NativePinnedRootReader } from "../storage/nativeStorageFs.js";
import {
  DomainTransactionRecoveryError,
  replayPendingDomainTransactions,
  type DomainTransactionOperation
} from "../storage/recoveryJournal.js";
import { pruneTerminalTransactionStaging } from "../storage/transactionStagingPrune.js";
import {
  roleAgentSessionIdentities,
  sameNativeSessionIdentity,
  type GlobalRoleSessionSet,
  type RoleAgentSession,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import {
  assertPathOutsideTaskmuxHome,
  canonicalProspectivePath
} from "../storage/storagePathBoundary.js";
import {
  MAX_PORTABLE_SNAPSHOT_BYTES
} from "../storage/portableSchema.js";
import { renderPortableSnapshotV3 } from "../storage/portableExport.js";
import {
  PortableImportError,
  applyPortableImportPlanInTransaction,
  planPortableImport,
  type PortableWorkspaceBindingMapping
} from "../storage/portableImport.js";
import {
  createPortableFileStoreImportTarget,
  createPortableFileStoreSnapshotReader
} from "../storage/portableFileStore.js";

export function mergeImportedRoleSessionSets(
  existing: GlobalRoleSessionSet | TaskRoleSessionSet | null,
  imported: GlobalRoleSessionSet | TaskRoleSessionSet | null
): GlobalRoleSessionSet | TaskRoleSessionSet | null {
  if (imported === null) return existing;
  if (existing === null) return imported;
  if (sessionSetOwnerKey(existing) !== sessionSetOwnerKey(imported)) {
    throw dataError("Imported Role session owner does not match the existing owner.");
  }

  const sessions: Record<string, RoleAgentSession> = { ...imported.sessions };
  for (const [agentId, existingSession] of Object.entries(existing.sessions)) {
    const importedSession = imported.sessions[agentId];
    if (importedSession === undefined) {
      sessions[agentId] = existingSession;
      continue;
    }
    const existingIdentities = roleAgentSessionIdentities(existingSession);
    const importedIdentities = roleAgentSessionIdentities(importedSession);
    if (identitySequenceIsPrefix(existingIdentities, importedIdentities)) {
      sessions[agentId] = importedSession;
    } else if (identitySequenceIsPrefix(importedIdentities, existingIdentities)) {
      sessions[agentId] = existingSession;
    } else {
      throw dataError(`Imported Role Agent session lineage diverges: ${agentId}.`);
    }
  }
  return { ...imported, sessions } as GlobalRoleSessionSet | TaskRoleSessionSet;
}

function identitySequenceIsPrefix(
  prefix: ReturnType<typeof roleAgentSessionIdentities>,
  sequence: ReturnType<typeof roleAgentSessionIdentities>
): boolean {
  return prefix.length <= sequence.length && prefix.every((identity, index) =>
    sameNativeSessionIdentity(identity, sequence[index] as (typeof sequence)[number]));
}

function sessionSetOwnerKey(sessionSet: GlobalRoleSessionSet | TaskRoleSessionSet): string {
  return sessionSet.owner.scope === "global"
    ? JSON.stringify(["global", sessionSet.owner.roleName])
    : JSON.stringify(["task", sessionSet.owner.taskId, sessionSet.owner.roleName]);
}

export type PortableExportPublication = Readonly<{
  output: string;
  manifest: string;
}>;

function writeExportFileAtomically(output: string, contents: string): void {
  const resolvedOutput = canonicalProspectivePath(output);
  const outputDir = dirname(resolvedOutput);
  mkdirSync(outputDir, { recursive: true });
  const temporary = join(outputDir, `.${basename(resolvedOutput)}.taskmux-export-${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    chmodSync(temporary, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    if (process.env.TASKMUX_EXPORT_FAILPOINT === "before-rename") {
      throw new Error("Injected export failure before rename.");
    }
    // `rename` would silently replace a concurrent caller's export. Publishing
    // through a hard link preserves the atomic no-clobber contract instead.
    linkSync(temporary, resolvedOutput);
    unlinkSync(temporary);
    fsyncDirectory(outputDir);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
    fsyncDirectory(outputDir);
    throw error;
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Exports only the portable v3 semantic graph. Host-bound authorities remain
 * exclusively in physical backup/restore and are never inspected here.
 */
export function preparePortableExport(
  args: string[],
  store: FileTaskStore,
  publishedTaskmuxHome = store.rootDirectory()
): PortableExportPublication {
  if (hasActiveDomainTransactionAuthority(store.rootDirectory())) {
    throw dataError("Portable export must run as a post-commit effect.");
  }
  const output = parsePortableExportOutput(args);
  assertPathOutsideTaskmuxHome(output, publishedTaskmuxHome, "Export output");
  const rendered = store.runReadSnapshot((reader) => renderPortableSnapshotV3(
    createPortableFileStoreSnapshotReader(reader),
    new Date().toISOString(),
    MAX_PORTABLE_SNAPSHOT_BYTES
  ));
  return Object.freeze({ output, manifest: rendered.manifest });
}

export function publishPortableExport(publication: PortableExportPublication): string {
  writeExportFileAtomically(publication.output, publication.manifest);
  return `Exported TaskMux portable data to ${publication.output}\n`;
}

export function runExportCommand(args: string[], store: FileTaskStore): string {
  return publishPortableExport(preparePortableExport(args, store));
}

/**
 * Applies a v3 plan only against the FileTaskStore workspace already supplied
 * by the CLI or Controller domain transaction. This intentionally never starts
 * a nested transaction.
 */
export function runImportCommand(args: string[], store: FileTaskStore): string {
  const { input, workspaceMappings } = parsePortableImportArguments(args);
  const raw = readPortableImportFile(input);
  if (!hasActiveDomainTransactionAuthority(store.rootDirectory())) {
    throw dataError("Portable import requires a caller-owned FileTaskStore transaction.");
  }

  try {
    const target = createPortableFileStoreImportTarget(store);
    const plan = planPortableImport(raw, workspaceMappings, target, {
      maxBytes: MAX_PORTABLE_SNAPSHOT_BYTES
    });
    const result = applyPortableImportPlanInTransaction(plan, target);
    if (process.env.NODE_ENV === "test" &&
        process.env.TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT === "after-apply") {
      throw new Error("Injected portable import failure after apply.");
    }
    return `Imported TaskMux portable data from ${input}\nCreated: ${result.created}\nNo-op: ${result.noOp}\n`;
  } catch (error) {
    if (error instanceof PortableImportError) throw dataError(error.message);
    if (error instanceof CliError) throw error;
    throw dataError("Portable import failed.");
  }
}

function parsePortableExportOutput(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--output" || args[1] === undefined ||
      args[1].trim().length === 0 || args[1].startsWith("--")) {
    throw usageError("Portable export usage: taskmux export --output <file>.");
  }
  return args[1];
}

function parsePortableImportArguments(args: readonly string[]): {
  input: string;
  workspaceMappings: PortableWorkspaceBindingMapping[];
} {
  let input: string | undefined;
  const workspaceMappings: PortableWorkspaceBindingMapping[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] as string;
    if (value === "--workspace-map") {
      const mapping = args[index + 1];
      if (mapping === undefined || mapping.startsWith("--")) {
        throw usageError("--workspace-map is required.");
      }
      workspaceMappings.push(parseWorkspaceMap(mapping));
      index += 1;
      continue;
    }
    if (value.startsWith("--")) {
      throw usageError(`Unknown portable import option: ${value}.`);
    }
    if (input !== undefined) {
      throw usageError("Portable import accepts exactly one input file.");
    }
    input = value;
  }
  if (input === undefined || input.trim().length === 0) {
    throw usageError("Import file is required.");
  }
  return { input, workspaceMappings };
}

function parseWorkspaceMap(value: string): PortableWorkspaceBindingMapping {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw usageError(
      "--workspace-map must be <source-binding-id>=<target-binding-id|absolute-workspace-path>."
    );
  }
  const sourceBindingId = value.slice(0, separator);
  const target = value.slice(separator + 1);
  if (!isPortableBindingId(sourceBindingId)) {
    throw usageError("--workspace-map source must be a portable binding ID.");
  }
  if (isPortableBindingId(target)) {
    return { schemaVersion: 1, sourceBindingId, targetBindingId: target };
  }
  if (isAbsolute(target)) {
    return { schemaVersion: 1, sourceBindingId, targetWorkspacePath: target };
  }
  throw usageError("--workspace-map target must be a portable binding ID or an absolute workspace path.");
}

function isPortableBindingId(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
}

function readPortableImportFile(input: string): string {
  let raw: Buffer;
  try {
    raw = readFileSync(input);
  } catch {
    throw dataError("Portable import file cannot be read.");
  }
  if (raw.byteLength > MAX_PORTABLE_SNAPSHOT_BYTES) {
    throw dataError("Portable import snapshot exceeds the 8 MiB limit.");
  }
  return raw.toString("utf8");
}

type PruneCommandPlan = Readonly<{
  trashTaskIds?: readonly string[];
}>;

export function runPruneCommand(
  args: string[],
  rootDir: string,
  now = new Date(),
  plan: PruneCommandPlan = {}
): string {
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
    const taskIds = plan.trashTaskIds ?? selectExpiredTrashTaskIds(rootDir, parseKeepTrashDays(args), now);
    lines.push(`${prefix} trash tasks: ${pruneTrashTasks(
      rootDir,
      taskIds,
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
      (workingRoot, sourceReader) => runPruneCommand(physicalArgs, workingRoot, now, {
        ...(hasFlag(physicalArgs, "--trash")
          ? {
            trashTaskIds: selectExpiredTrashTaskIdsFromPinnedSource(
              sourceReader,
              parseKeepTrashDays(physicalArgs),
              now
            )
          }
          : {})
      }),
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

function selectExpiredTrashTaskIds(rootDir: string, keepDays: number, now: Date): string[] {
  const trashTasksDir = join(rootDir, "trash", "tasks");

  if (!existsSync(trashTasksDir)) {
    return [];
  }

  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  return readdirSync(trashTasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => keepDays === 0 || lstatSync(join(trashTasksDir, name)).mtimeMs <= cutoff)
    .sort();
}

function selectExpiredTrashTaskIdsFromPinnedSource(
  reader: NativePinnedRootReader,
  keepDays: number,
  now: Date
): string[] {
  const trashTasksDir = "trash/tasks";
  if (reader.lstat(trashTasksDir) === undefined) return [];
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  return reader.readdir(trashTasksDir)
    .flatMap((name) => {
      const metadata = reader.lstat(`${trashTasksDir}/${name}`);
      return metadata !== undefined && isDirectoryReceipt(metadata)
        ? [{ name, mtimeMs: metadata.mtimeMs }]
        : [];
    })
    .filter(({ mtimeMs }) => keepDays === 0 || mtimeMs <= cutoff)
    .map(({ name }) => name)
    .sort();
}

function pruneTrashTasks(rootDir: string, taskIds: readonly string[], dryRun: boolean): number {
  const removable = [...new Set(taskIds)].sort();

  if (!dryRun) {
    new FileTaskStore(rootDir).pruneTrashedTasks(removable);
  }

  return removable.length;
}

function isDirectoryReceipt(receipt: { mode: bigint }): boolean {
  return (receipt.mode & 0o170000n) === 0o040000n;
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
