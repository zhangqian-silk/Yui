import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TaskComment } from "../comment/comment.js";
import { dataError, usageError } from "../errors/cliError.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { GlobalRole, Role } from "../role/role.js";
import type { ConfiguredAgent } from "../agent/agent.js";
import { validateAgentBaseArguments } from "../agent/argumentPolicy.js";
import {
  FileTaskStore,
  nativeSessionIdentityKey,
  snapshotNativeSessionIdentityClaims,
  type NativeSessionIdentityClaim,
  type TaskReader,
  type TaskStore,
  type TaskmuxConfig
} from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
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
  enrollAgentCapabilityProbePin,
  type ProbeExecutableResolutionContext
} from "../executor/agentAdapter.js";
import {
  isConfiguredAgentRecord,
  isGlobalRoleRecord,
  isGlobalRoleSessionSetRecord,
  isSafeStorageSegment,
  isTaskRoleRecord,
  isTaskRoleSessionSetRecord,
  roleReferencesAreConsistent,
  sessionSetMatchesRole
} from "../storage/recordValidation.js";
import { primeResilientTaskStore } from "../storage/resilientTaskStore.js";
import {
  assertPathOutsideTaskmuxHome,
  canonicalProspectivePath
} from "../storage/storagePathBoundary.js";

type TaskSnapshot = {
  task: Task;
  roles: Array<{
    role: Role;
    sessionSet: TaskRoleSessionSet | null;
    transcript: string | null;
  }>;
  comments: TaskComment[];
  events: TaskEvent[];
};

type GlobalRoleSnapshot = {
  role: GlobalRole;
  sessionSet: GlobalRoleSessionSet | null;
};

type TaskmuxSnapshot = {
  schemaVersion: 2;
  exportedAt: string;
  config: TaskmuxConfig;
  nativeSessionIdentities: Record<string, NativeSessionIdentityClaim>;
  agents: ConfiguredAgent[];
  roles: GlobalRoleSnapshot[];
  tasks: TaskSnapshot[];
};

type ImportCommandOptions = {
  processEnvironment?: NodeJS.ProcessEnv;
  agentProbeResolution?: ProbeExecutableResolutionContext;
};

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

export function runExportCommand(args: string[], store: TaskStore): string {
  const output = readOption(args, "--output");
  const snapshot = store instanceof FileTaskStore
    ? exportFileStoreSnapshot(store, output)
    : store.runReadSnapshot((reader) => exportSnapshot(reader));
  writeExportFileAtomically(output, `${JSON.stringify(snapshot, null, 2)}\n`);

  return `Exported TaskMux data to ${output}\n`;
}

function exportFileStoreSnapshot(store: FileTaskStore, output: string): TaskmuxSnapshot {
  assertPathOutsideTaskmuxHome(output, store.rootDirectory(), "Export output");
  if (hasActiveDomainTransactionAuthority(store.rootDirectory())) {
    store.reconcileNativeSessionIdentityLedger();
    return exportSnapshot(store);
  }
  return executeDomainTransaction(
    store.rootDirectory(),
    `export-${randomUUID()}`,
    (workingRoot) => {
      const transactionStore = new FileTaskStore(workingRoot);
      transactionStore.reconcileNativeSessionIdentityLedger();
      return exportSnapshot(transactionStore);
    }
  );
}

function exportSnapshot(store: TaskReader): TaskmuxSnapshot {
  const { completionInstallations: _hostLocalCompletion, ...portableConfig } = store.getConfig();
  return {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    config: portableConfig,
    nativeSessionIdentities: Object.fromEntries(store.nativeSessionIdentityClaims()),
    agents: store.listConfiguredAgents().map(portableConfiguredAgent),
    roles: store.listGlobalRoles().map((role) => ({
      role,
      sessionSet: store.getGlobalRoleSessionSet(role.name)
    })),
    tasks: store.listTasks().map((task) => ({
      task,
      roles: store.listRoles(task.id).map((role) => {
        const worktree = store.getRoleWorktree(task.id, role.name);
        const portableRole = worktree !== null && role.workspace === worktree.path
          ? { ...role, workspace: worktree.repositoryRoot }
          : role;
        return {
          role: portableRole,
          sessionSet: store.getRoleSessionSet(task.id, role.name),
          transcript: store.readTranscript(task.id, role.name)
        };
      }),
      comments: store.listComments(task.id),
      events: store.listEvents(task.id)
    }))
  };
}

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
    renameSync(temporary, resolvedOutput);
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

export function runImportCommand(
  args: string[],
  store: TaskStore,
  options: ImportCommandOptions = {}
): string {
  const [input] = args;

  if (input === undefined || input.trim().length === 0) {
    throw usageError("Import file is required.");
  }

  const snapshot = parseSnapshot(readFileSync(input, "utf8"));
  const processEnvironment = options.processEnvironment ?? process.env;
  validateSnapshot(snapshot, processEnvironment, options.agentProbeResolution);
  if (!(store instanceof FileTaskStore)) {
    throw dataError("Import requires a file-backed TaskMux store.");
  }
  if (!hasActiveDomainTransactionAuthority(store.rootDirectory())) {
    return executeDomainTransaction(
      store.rootDirectory(),
      `import-${randomUUID()}`,
      (workingRoot) => runImportCommand(
        args,
        new FileTaskStore(workingRoot),
        { ...options, processEnvironment }
      )
    );
  }

  validateImportSessionOwnership(snapshot, store);
  applySnapshot(snapshot, store, processEnvironment, options.agentProbeResolution);
  validateCompleteStoreGraph(store);

  return `Imported TaskMux data from ${input}\n`;
}

function validateImportSessionOwnership(snapshot: TaskmuxSnapshot, store: TaskStore): void {
  const initialSetsByOwner = new Map(
    store.listAllRoleSessionSets().map((sessionSet) => [sessionSetOwnerKey(sessionSet), sessionSet])
  );
  const finalSetsByOwner = new Map(initialSetsByOwner);

  for (const { role, sessionSet } of snapshot.roles) {
    replaceImportedSessionSet(finalSetsByOwner, globalSessionOwnerKey(role.name), sessionSet);
  }
  for (const taskSnapshot of snapshot.tasks) {
    for (const { role, sessionSet } of taskSnapshot.roles) {
      replaceImportedSessionSet(
        finalSetsByOwner,
        taskSessionOwnerKey(taskSnapshot.task.id, role.name),
        sessionSet
      );
    }
  }

  const initialOwners = new Map<string, string>();
  const retiredIdentities = new Set<string>();
  const importedClaims = snapshotNativeSessionIdentityClaims(snapshot.nativeSessionIdentities) as
    Record<string, NativeSessionIdentityClaim>;
  const targetClaims = store.nativeSessionIdentityClaims();
  for (const [identity, claim] of Object.entries(importedClaims)) {
    const targetClaim = targetClaims.get(identity);
    if (targetClaim !== undefined && !nativeSessionClaimsMatch(targetClaim, claim)) {
      throw dataError("Imported native session identity conflicts with the target ledger.");
    }
  }
  for (const [identity, claim] of targetClaims) {
    if (claim.state === "retired") {
      retiredIdentities.add(identity);
      continue;
    }
    initialOwners.set(identity, identityOwnerKeyFromClaim(claim));
  }
  for (const [identity, owner] of sessionIdentityOwners(initialSetsByOwner.values())) {
    if (retiredIdentities.has(identity)) {
      throw dataError("Native Agent session identity ledger conflicts with live Role Agent ownership.");
    }
    const historicalOwner = initialOwners.get(identity);
    if (historicalOwner !== undefined && historicalOwner !== owner) {
      throw dataError("Native Agent session identity ledger conflicts with live Role Agent ownership.");
    }
    initialOwners.set(identity, owner);
  }
  const finalOwners = sessionIdentityOwners(finalSetsByOwner.values());
  for (const identity of retiredIdentities) {
    if (finalOwners.has(identity)) {
      throw dataError("Import cannot revive a retired native session identity.");
    }
  }
  for (const [identity, initialOwner] of initialOwners) {
    const finalOwner = finalOwners.get(identity);
    if (finalOwner !== undefined && finalOwner !== initialOwner) {
      throw dataError("Import cannot transfer a native session identity between Role Agents.");
    }
  }
  for (const [identity, claim] of Object.entries(importedClaims)) {
    const finalOwner = finalOwners.get(identity);
    if (claim.state === "retired" && finalOwner !== undefined) {
      throw dataError("Import cannot revive a retired native session identity.");
    }
    if (
      claim.state === "owned" &&
      finalOwner !== undefined &&
      finalOwner !== identityOwnerKeyFromClaim(claim)
    ) {
      throw dataError("Imported native session identity conflicts with final Role Agent ownership.");
    }
  }
}

function replaceImportedSessionSet(
  sessionSets: Map<string, GlobalRoleSessionSet | TaskRoleSessionSet>,
  ownerKey: string,
  sessionSet: GlobalRoleSessionSet | TaskRoleSessionSet | null
): void {
  const merged = mergeImportedRoleSessionSets(sessionSets.get(ownerKey) ?? null, sessionSet);
  if (merged !== null) sessionSets.set(ownerKey, merged);
}

function nativeSessionClaimsMatch(
  left: NativeSessionIdentityClaim,
  right: NativeSessionIdentityClaim
): boolean {
  return left.state === right.state && (
    left.state === "retired" ||
    (right.state === "owned" && identityOwnerKeyFromClaim(left) === identityOwnerKeyFromClaim(right))
  );
}

function identityOwnerKeyFromClaim(
  claim: Extract<NativeSessionIdentityClaim, { state: "owned" }>
): string {
  return claim.owner.scope === "global"
    ? globalIdentityOwnerKey(claim.owner.roleName, claim.owner.agentId)
    : taskIdentityOwnerKey(
      claim.owner.taskId,
      claim.owner.roleName,
      claim.owner.agentId
    );
}

function sessionIdentityOwners(
  sessionSets: Iterable<GlobalRoleSessionSet | TaskRoleSessionSet>
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const sessionSet of sessionSets) {
    for (const [agentId, session] of Object.entries(sessionSet.sessions)) {
      const owner = sessionSet.owner.scope === "global"
        ? globalIdentityOwnerKey(sessionSet.owner.roleName, agentId)
        : taskIdentityOwnerKey(
          sessionSet.owner.taskId,
          sessionSet.owner.roleName,
          agentId
        );
      for (const nativeIdentity of roleAgentSessionIdentities(session)) {
        const identity = nativeSessionIdentityKey(nativeIdentity);
        const existingOwner = owners.get(identity);
        if (existingOwner !== undefined && existingOwner !== owner) {
          throw dataError("A native session identity is already owned by another Role Agent.");
        }
        owners.set(identity, owner);
      }
    }
  }
  return owners;
}

function globalSessionOwnerKey(roleName: string): string {
  return JSON.stringify(["global", roleName]);
}

function taskSessionOwnerKey(taskId: string, roleName: string): string {
  return JSON.stringify(["task", taskId, roleName]);
}

function globalIdentityOwnerKey(roleName: string, agentId: string): string {
  return JSON.stringify(["global", roleName, agentId]);
}

function taskIdentityOwnerKey(taskId: string, roleName: string, agentId: string): string {
  return JSON.stringify(["task", taskId, roleName, agentId]);
}

function applySnapshot(
  snapshot: TaskmuxSnapshot,
  store: TaskStore,
  processEnvironment: NodeJS.ProcessEnv,
  agentProbeResolution?: ProbeExecutableResolutionContext
): void {
  const targetCompletionInstallations = store.getConfig().completionInstallations;
  const { completionInstallations: _importedHostLocalCompletion, ...portableConfig } = snapshot.config;

  for (const agent of snapshot.agents) {
    persistImportedAgent(store, agent, processEnvironment, agentProbeResolution);
  }
  if (process.env.TASKMUX_IMPORT_FAILPOINT === "after-agents") {
    throw new Error("Injected import failure after Agent writes.");
  }
  store.saveConfig({ ...portableConfig, completionInstallations: targetCompletionInstallations });

  for (const { role, sessionSet } of snapshot.roles) {
    store.saveGlobalRoleWithSessionSet(
      role,
      mergeImportedRoleSessionSets(
        store.getGlobalRoleSessionSet(role.name),
        sessionSet
      ) as GlobalRoleSessionSet | null,
      true
    );
  }

  for (const taskSnapshot of snapshot.tasks) {
    store.saveTask(taskSnapshot.task);
    for (const { role, sessionSet, transcript } of taskSnapshot.roles) {
      store.saveRoleWithSessionSet(
        taskSnapshot.task.id,
        role,
        mergeImportedRoleSessionSets(
          store.getRoleSessionSet(taskSnapshot.task.id, role.name),
          sessionSet
        ) as TaskRoleSessionSet | null,
        true
      );
      if (transcript === null) store.clearTranscript(taskSnapshot.task.id, role.name);
      else store.saveTranscript(taskSnapshot.task.id, role.name, transcript);
    }

    const existingComments = new Map(
      store.listComments(taskSnapshot.task.id).map((comment) => [comment.id, comment])
    );
    for (const comment of taskSnapshot.comments) {
      const existing = existingComments.get(comment.id);
      if (existing === undefined) store.saveComment(taskSnapshot.task.id, comment);
      else if (JSON.stringify(existing) !== JSON.stringify(comment)) {
        throw dataError(`Imported comment conflicts with target record: ${taskSnapshot.task.id}/${comment.id}`);
      }
    }

    const existingEvents = new Map(
      store.listEvents(taskSnapshot.task.id).map((event) => [event.id, event])
    );
    for (const event of taskSnapshot.events) {
      const existing = existingEvents.get(event.id);
      if (existing === undefined) store.saveEvent(taskSnapshot.task.id, event);
      else if (JSON.stringify(existing) !== JSON.stringify(event)) {
        throw dataError(`Imported event conflicts with target record: ${taskSnapshot.task.id}/${event.id}`);
      }
    }
  }
  store.mergeImportedNativeSessionIdentityClaims(snapshot.nativeSessionIdentities);
}

function persistImportedAgent(
  store: TaskStore,
  agent: ConfiguredAgent,
  processEnvironment: NodeJS.ProcessEnv,
  agentProbeResolution?: ProbeExecutableResolutionContext
): void {
  const {
    probePin: _importedHostBoundProbePin,
    probePinRefreshRequired: _importedHostRefreshState,
    ...portableAgent
  } = agent;
  const existing = store.getConfiguredAgent(agent.id);
  const targetProbePin = existing !== null &&
      existing.adapterId === agent.adapterId &&
      existing.command === agent.command &&
      existing.probePin !== undefined
    ? existing.probePin
    : enrollAgentCapabilityProbePin(
      { adapterId: agent.adapterId, command: agent.command },
      processEnvironment,
      agentProbeResolution
    );
  const targetProbePinRefreshRequired = targetProbePin === undefined &&
    existing !== null &&
    existing.adapterId === agent.adapterId &&
    existing.command === agent.command &&
    existing.probePinRefreshRequired === true;
  const persisted = existing === null
    ? store.createConfiguredAgentIfAbsent({
      ...portableAgent,
      ...(targetProbePin === undefined ? {} : { probePin: targetProbePin })
    })
    : store.updateConfiguredAgent(
      agent.id,
      {
        adapterId: agent.adapterId,
        command: agent.command,
        baseArgs: agent.baseArgs,
        environment: agent.environment,
        probePin: targetProbePin ?? null,
        probePinRefreshRequired: targetProbePinRefreshRequired ? true : null
      },
      new Date(agent.updatedAt)
    )?.agent ?? null;
  if (persisted === null) {
    throw dataError(`Agent registry changed during import: ${agent.id}.`);
  }
}

function portableConfiguredAgent(agent: ConfiguredAgent): ConfiguredAgent {
  const {
    probePin: _hostBoundProbePin,
    probePinRefreshRequired: _hostBoundRefreshState,
    ...portable
  } = agent;
  return portable;
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

function parseSnapshot(raw: string): TaskmuxSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw dataError("Invalid TaskMux export snapshot");
  }
  if (!isRecord(value)) throw dataError("Invalid TaskMux export snapshot");
  if (value.schemaVersion !== 2) {
    const version = typeof value.schemaVersion === "number" ? String(value.schemaVersion) : "unknown";
    throw dataError(`Unsupported TaskMux export snapshot version: ${version}.`);
  }
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "exportedAt",
      "config",
      "nativeSessionIdentities",
      "agents",
      "roles",
      "tasks"
    ]) ||
    typeof value.exportedAt !== "string" ||
    !isRecord(value.config) ||
    snapshotNativeSessionIdentityClaims(value.nativeSessionIdentities) === null ||
    !Array.isArray(value.agents) ||
    !Array.isArray(value.roles) ||
    !Array.isArray(value.tasks)
  ) {
    throw dataError("Invalid TaskMux export snapshot");
  }
  return value as unknown as TaskmuxSnapshot;
}

function validateSnapshot(
  snapshot: TaskmuxSnapshot,
  processEnvironment: NodeJS.ProcessEnv,
  agentProbeResolution?: ProbeExecutableResolutionContext
): void {
  const store = FileTaskStore.createEphemeralWorkspace("taskmux-import-preflight-");
  try {
    if (Object.hasOwn(snapshot.config, "completionInstallations")) {
      throw dataError("Invalid TaskMux export snapshot config");
    }
    rejectDuplicate(snapshot.agents, (agent) => recordIdentity(agent, "id", "agent"), "agent");
    for (const agent of snapshot.agents) {
      if (
        !isRecord(agent) ||
        typeof agent.adapterId !== "string" ||
        !Array.isArray(agent.baseArgs) ||
        !agent.baseArgs.every((value) => typeof value === "string")
      ) {
        throw dataError("Invalid agent record");
      }
      validateAgentBaseArguments(agent.adapterId, agent.baseArgs);
      if (!isConfiguredAgentRecord(agent) || !isSafeStorageSegment(agent.id)) {
        throw dataError("Invalid agent record");
      }
      persistImportedAgent(store, agent, processEnvironment, agentProbeResolution);
      store.getConfiguredAgent(agent.id);
    }
    const agents = new Map(store.listConfiguredAgents().map((agent) => [agent.id, agent]));
    if (snapshot.config.defaultAgent !== undefined && !agents.has(snapshot.config.defaultAgent)) {
      throw dataError("TaskMux export snapshot references an unknown default Agent.");
    }
    store.saveConfig(snapshot.config);
    store.getConfig();

    rejectDuplicate(
      snapshot.roles,
      (entry) => isRecord(entry) && isRecord(entry.role)
        ? recordIdentity(entry.role, "name", "global role")
        : invalidIdentity("global role"),
      "global role"
    );
    for (const entry of snapshot.roles) {
      if (!isRecord(entry) || !hasExactKeys(entry, ["role", "sessionSet"]) || !isRecord(entry.role)) {
        throw dataError("Invalid global role snapshot");
      }
      const role = entry.role;
      if (
        !isGlobalRoleRecord(role) ||
        !isSafeStorageSegment(role.name) ||
        (entry.sessionSet !== null && (
          !isGlobalRoleSessionSetRecord(entry.sessionSet, role.name) ||
          !sessionSetMatchesRole(entry.sessionSet, role)
        ))
      ) {
        throw dataError("Invalid global role record");
      }
      store.saveGlobalRoleWithSessionSet(role, entry.sessionSet);
      const decoded = store.getGlobalRole(role.name);
      if (decoded === null || !roleReferencesAreConsistent(decoded, agents)) {
        throw dataError(`Invalid global role record: ${role.name}`);
      }
    }

    rejectDuplicate(
      snapshot.tasks,
      (entry) => isRecord(entry) && isRecord(entry.task)
        ? recordIdentity(entry.task, "id", "task")
        : invalidIdentity("task"),
      "task"
    );
    for (const entry of snapshot.tasks) {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, ["task", "roles", "comments", "events"]) ||
        !isLogicalTaskRecord(entry.task) ||
        !Array.isArray(entry.roles) ||
        !Array.isArray(entry.comments) ||
        !Array.isArray(entry.events)
      ) {
        throw dataError("Invalid TaskMux export snapshot");
      }
      const taskId = entry.task.id;
      store.saveTask(entry.task);
      if (store.getTask(taskId) === null) throw dataError(`Invalid task record: ${taskId}`);

      rejectDuplicate(
        entry.roles,
        (item) => isRecord(item) && isRecord(item.role)
          ? recordIdentity(item.role, "name", "role")
          : invalidIdentity("role"),
        `role in ${taskId}`
      );
      for (const item of entry.roles) {
        if (
          !isRecord(item) ||
          !hasExactKeys(item, ["role", "sessionSet", "transcript"]) ||
          !isRecord(item.role) ||
          !isTaskRoleRecord(item.role, taskId) ||
          item.role.taskId !== taskId ||
          (item.sessionSet !== null && (
            !isTaskRoleSessionSetRecord(item.sessionSet, taskId, item.role.name) ||
            !sessionSetMatchesRole(item.sessionSet, item.role)
          )) ||
          (item.transcript !== null && typeof item.transcript !== "string")
        ) {
          throw dataError(`Invalid role record: ${taskId}`);
        }
        store.saveRoleWithSessionSet(taskId, item.role, item.sessionSet);
        const role = store.getRole(taskId, item.role.name);
        if (role === null || !roleReferencesAreConsistent(role, agents)) {
          throw dataError(`Invalid role record: ${item.role.name}`);
        }
      }

      rejectDuplicate(
        entry.comments,
        (comment) => recordIdentity(comment, "id", "comment"),
        `comment in ${taskId}`
      );
      for (const comment of entry.comments) store.saveComment(taskId, comment);
      store.listComments(taskId);
      rejectDuplicate(
        entry.events,
        (event) => recordIdentity(event, "id", "event"),
        `event in ${taskId}`
      );
      for (const event of entry.events) store.saveEvent(taskId, event);
      store.listEvents(taskId);
    }

    const taskIds = new Set(snapshot.tasks.map((entry) => entry.task.id));
    for (const pointer of [snapshot.config.currentTaskId, snapshot.config.lastTaskId]) {
      if (pointer !== undefined && !taskIds.has(pointer)) {
        throw dataError("TaskMux export snapshot config references an unknown Task.");
      }
    }
    const importedClaims = snapshotNativeSessionIdentityClaims(snapshot.nativeSessionIdentities) as
      Record<string, NativeSessionIdentityClaim>;
    for (const [identity, physicalClaim] of store.nativeSessionIdentityClaims()) {
      const importedClaim = importedClaims[identity];
      if (importedClaim === undefined || !nativeSessionClaimsMatch(physicalClaim, importedClaim)) {
        throw dataError(
          "TaskMux export snapshot omits or conflicts with a physical native session identity."
        );
      }
    }
    store.mergeImportedNativeSessionIdentityClaims(importedClaims);
    store.reconcileNativeSessionIdentityLedger();
  } finally {
    store.disposeEphemeralWorkspace();
  }
}

function validateCompleteStoreGraph(store: TaskStore): void {
  primeResilientTaskStore(store);
  const agents = new Map(store.listConfiguredAgents().map((agent) => [agent.id, agent]));
  const config = store.getConfig();
  if (config.defaultAgent !== undefined && !agents.has(config.defaultAgent)) {
    throw dataError("TaskMux config references an unknown default Agent.");
  }
  for (const role of store.listGlobalRoles()) {
    if (!roleReferencesAreConsistent(role, agents)) {
      throw dataError(`Global Role references an inconsistent Agent: ${role.name}`);
    }
  }
  const tasks = store.listTasks();
  const taskIds = new Set(tasks.map((task) => task.id));
  for (const pointer of [config.currentTaskId, config.lastTaskId]) {
    if (pointer !== undefined && !taskIds.has(pointer)) {
      throw dataError("TaskMux config references an unknown Task.");
    }
  }
  for (const task of tasks) {
    for (const role of store.listRoles(task.id)) {
      if (!roleReferencesAreConsistent(role, agents)) {
        throw dataError(`TaskRole references an inconsistent Agent: ${task.id}/${role.name}`);
      }
    }
  }
}

function rejectDuplicate<T>(values: T[], identity: (value: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const id = identity(value);
    if (seen.has(id)) throw dataError(`Duplicate ${label} identity.`);
    seen.add(id);
  }
}

function recordIdentity(value: unknown, key: string, label: string): string {
  if (!isRecord(value) || !isSafeStorageSegment(value[key])) return invalidIdentity(label);
  return value[key];
}

function invalidIdentity(label: string): never {
  throw dataError(`Invalid ${label} identity.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key));
}

function isLogicalTaskRecord(value: unknown): value is Task {
  if (
    !isRecord(value) ||
    !hasExactKeysWithOptional(
      value,
      ["schemaVersion", "id", "title", "archived", "createdAt", "updatedAt"],
      [
        "description",
        "priority",
        "tags",
        "dueAt",
        "archivedAt",
        "archivedBy",
        "archiveReason",
        "archiveSummary"
      ]
    )
  ) return false;
  return value.schemaVersion === 1 &&
    isSafeStorageSegment(value.id) &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    typeof value.archived === "boolean" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.priority === undefined || ["low", "medium", "high", "urgent"].includes(String(value.priority))) &&
    (value.tags === undefined || (
      Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string")
    )) &&
    (value.dueAt === undefined || typeof value.dueAt === "string") &&
    (value.archivedAt === undefined || typeof value.archivedAt === "string") &&
    (value.archivedBy === undefined || ["user", "operator", "leader"].includes(String(value.archivedBy))) &&
    (value.archiveReason === undefined || typeof value.archiveReason === "string") &&
    (value.archiveSummary === undefined || typeof value.archiveSummary === "string");
}

function hasExactKeysWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[]
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
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
