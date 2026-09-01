/**
 * Resource GC engine (Issue 10).
 *
 * Quarantine-first garbage collection for managed worktrees, deployments, and
 * runtime artifacts. Permanent deletion is always delayed behind an
 * observation window; anything whose ownership, cleanliness, or liveness
 * cannot be proven is retained and reported.
 *
 * Safety model:
 * - `planResourceGc` is strictly read-only: it discovers, scans, classifies,
 *   and returns a plan. It never writes the registry or moves files.
 * - `applyResourceGc` re-discovers and re-scans live references immediately
 *   before each mutation, so a stale plan can never release a resource that
 *   gained a reference after planning.
 * - `purgeResourceQuarantine` scans both the original and quarantine paths;
 *   a file held open inside quarantine triggers a restore instead of deletion.
 * - `restoreAllResourceGc` is the explicit rollback entry point.
 */

import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  removeResourceRecord,
  isResourceQuarantinePath,
  resourceQuarantineRoot,
  upsertResourceRecord
} from "./resourceRegistry.js";
import type { ResourceRegistryStore } from "./resourceRegistryStore.js";
import { createResourceRegistryStore } from "./resourceRegistryStore.js";
import {
  isReleasable,
  isTerminalTaskStatus,
  type ResourceRecord,
  type ResourceRegistryState
} from "./resourceTypes.js";
import {
  scanLiveReferences,
  type LiveReferencePorts,
  type LiveReferenceScan
} from "./liveReferences.js";
import {
  discoverResources,
  type DiscoveredResource
} from "./resourceDiscovery.js";

const executeFile = promisify(execFile);

export const DEFAULT_QUARANTINE_TTL_HOURS = 24;

export type GcMode = "report" | "quarantine";

export type GcPlan = Readonly<{
  home: string;
  mode: GcMode;
  generatedAt: string;
  records: readonly ResourceRecord[];
  releasable: readonly ResourceRecord[];
  retained: readonly ResourceRecord[];
  quarantined: readonly ResourceRecord[];
  deleted: readonly ResourceRecord[];
  scan: LiveReferenceScan;
}>;

export type GcResult = Readonly<{
  planned: GcPlan;
  applied: readonly ResourceRecord[];
  failed: readonly ResourceRecord[];
  restored: readonly ResourceRecord[];
  purged: readonly ResourceRecord[];
}>;

export type ResourceGcInput = Readonly<{
  home: string;
  /** Registry store; when omitted the GC engine creates one from the Home. */
  registryStore?: ResourceRegistryStore;
  projects: readonly import("../repository/project.js").Project[];
  managedWorkspaces: readonly import("../worktree/managedWorkspace.js").ManagedWorkspace[];
  taskStatusById: ReadonlyMap<string, string>;
  mode: GcMode;
  now: Date;
  quarantineTtlHours?: number;
  environment?: NodeJS.ProcessEnv;
  tmuxServerName?: string;
  /** Test seam for live-reference sources; production callers omit it. */
  liveReferencePorts?: LiveReferencePorts;
  /**
   * Workspace paths claimed by active durable Jobs (Turns). Production
   * callers compute these from the TaskStore; tests may omit them.
   */
  activeWorkspaceOwnerPaths?: readonly string[];
}>;

type ClassifiedResource = Readonly<{
  record: ResourceRecord;
  ownerTerminal: boolean;
}>;

/**
 * Plan a GC pass: discover resources, scan live references, and classify each
 * record. Planning is strictly read-only — it never writes the registry,
 * moves files, or restores quarantined resources.
 */
export async function planResourceGc(input: ResourceGcInput): Promise<GcPlan> {
  const home = resolve(input.home);
  const registryStore = input.registryStore ?? createResourceRegistryStore(home);
  const discovered = await discoverResources({
    home,
    projects: input.projects,
    managedWorkspaces: input.managedWorkspaces,
    taskStatusById: input.taskStatusById,
    now: input.now
  });
  const paths = discovered.map(({ record }) => record.path);
  // Also scan original paths of quarantined records so a new reference is
  // visible in the plan (restore itself happens in apply/purge/restore-all).
  const registry = registryStore.load();
  appendRegistryScanPaths(registry, paths, home);
  const scan = await scanLiveReferences({
    home,
    paths,
    environment: input.environment,
    tmuxServerName: input.tmuxServerName,
    ports: {
      ...input.liveReferencePorts,
      managedWorkspaces: () => input.managedWorkspaces,
      activeWorkspaceOwners: () => collectActiveWorkspaceOwners(input)
    }
  });

  const classified = classifyDiscoveredResources(discovered, registry, scan, input, home);
  const records = classified.map(({ record }) => record);

  // Include quarantined records whose original path no longer hosts the
  // resource. They are reported as-is; restore is an explicit apply action.
  const discoveredIds = new Set(records.map((record) => record.id));
  for (const record of Object.values(registry.records) as ResourceRecord[]) {
    if (record.disposition !== "quarantined" || discoveredIds.has(record.id)) continue;
    records.push(record);
  }

  return Object.freeze({
    home,
    mode: input.mode,
    generatedAt: input.now.toISOString(),
    records: Object.freeze(records),
    releasable: Object.freeze(records.filter((record) => record.disposition === "releasable")),
    retained: Object.freeze(records.filter((record) =>
      record.disposition === "active"
      || record.disposition === "retained-dirty"
      || record.disposition === "retained-unowned"
      || record.disposition === "retained-unproven"
      || record.disposition === "cleanup-failed"
    )),
    quarantined: Object.freeze(records.filter((record) => record.disposition === "quarantined")),
    deleted: Object.freeze(records.filter((record) => record.disposition === "deleted")),
    scan
  });
}

function appendRegistryScanPaths(
  registry: ResourceRegistryState,
  paths: string[],
  home: string
): void {
  for (const record of Object.values(registry.records) as ResourceRecord[]) {
    if (record.disposition === "quarantined" && record.quarantine !== undefined) {
      paths.push(record.quarantine.originalPath);
      continue;
    }
    if (record.disposition === "deleted") continue;
    if (isResourceQuarantinePath(home, record.path)) continue;
    if (existsSync(record.path)) paths.push(record.path);
  }
}

function classifyDiscoveredResources(
  discovered: readonly DiscoveredResource[],
  registry: ResourceRegistryState,
  scan: LiveReferenceScan,
  input: ResourceGcInput,
  home: string
): ClassifiedResource[] {
  const classified: ClassifiedResource[] = discovered.map(({ record, ownerTerminal }) => ({
    record: classifyRecord(record, ownerTerminal, scan, registry, input.now),
    ownerTerminal
  }));
  const discoveredIds = new Set(classified.map(({ record }) => record.id));
  for (const record of Object.values(registry.records) as ResourceRecord[]) {
    if (discoveredIds.has(record.id)) continue;
    if (record.disposition === "quarantined" || record.disposition === "deleted") {
      classified.push({ record, ownerTerminal: false });
      continue;
    }
    if (isResourceQuarantinePath(home, record.path) || !existsSync(record.path)) continue;
    const ownerTerminal = record.owner.taskId === undefined
      ? false
      : isTerminalTaskStatus(input.taskStatusById.get(record.owner.taskId) as never);
    classified.push({
      record: classifyRecord(record, ownerTerminal, scan, registry, input.now),
      ownerTerminal
    });
  }
  return classified;
}

/**
 * Collect active workspace owner path fragments from durable state.
 * These protect resources that an active Session, Job, or Turn still
 * references even when the Task itself is terminal.
 */
function collectActiveWorkspaceOwners(input: ResourceGcInput): readonly string[] {
  return input.activeWorkspaceOwnerPaths ?? [];
}

function classifyRecord(
  record: ResourceRecord,
  ownerTerminal: boolean,
  scan: LiveReferenceScan,
  registry: ResourceRegistryState,
  now: Date
): ResourceRecord {
  const liveRefs = scan.refsByPath.get(record.path) ?? [];
  const existing = registry.records[record.id];

  // A quarantined resource stays quarantined until purged or restored.
  if (existing?.disposition === "quarantined") {
    return existing;
  }
  if (existing?.disposition === "deleted") {
    return existing;
  }

  if (scan.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return {
      ...record,
      activeRefs: Object.freeze([...liveRefs]),
      disposition: "retained-unproven",
      blocker: "Live-reference source is untrusted; retained.",
      updatedAt: now.toISOString()
    };
  }

  const refs = [...liveRefs];
  if (refs.length > 0) {
    return { ...record, activeRefs: Object.freeze(refs), disposition: "active", updatedAt: now.toISOString() };
  }
  if (record.cleanliness === "dirty") {
    return {
      ...record,
      activeRefs: Object.freeze([]),
      disposition: "retained-dirty",
      blocker: dirtyWorktreeSuggestion(record),
      updatedAt: now.toISOString()
    };
  }
  if (record.cleanliness === "unknown") {
    return {
      ...record,
      activeRefs: Object.freeze([]),
      disposition: "retained-unproven",
      blocker: "Cleanliness cannot be proven; retained. Verify the worktree state manually.",
      updatedAt: now.toISOString()
    };
  }
  if (record.owner.basis === "unattributed") {
    return {
      ...record,
      activeRefs: Object.freeze([]),
      disposition: "retained-unowned",
      blocker: "Ownership cannot be proven; reported, never removed.",
      updatedAt: now.toISOString()
    };
  }
  if (!ownerTerminal) {
    return {
      ...record,
      activeRefs: Object.freeze([]),
      disposition: "active",
      blocker: "Owner is not terminal.",
      updatedAt: now.toISOString()
    };
  }
  return {
    ...record,
    activeRefs: Object.freeze([]),
    disposition: "releasable",
    updatedAt: now.toISOString()
  };
}

/** Suggest how to preserve dirty evidence before releasing a worktree. */
function dirtyWorktreeSuggestion(record: ResourceRecord): string {
  const path = record.path;
  return [
    "Worktree has uncommitted changes; preserve dirty evidence before release.",
    `  git -C ${path} diff > ${path}.patch`,
    `  git -C ${path} bundle create ${path}.bundle --all`,
    "  or commit the changes to a branch."
  ].join("\n");
}

/**
 * Apply a GC plan: quarantine every releasable resource. In `report` mode this
 * is a shadow pass — the plan is returned unchanged and nothing is mutated.
 *
 * Before each mutation the engine re-discovers and re-scans live references,
 * so a plan that went stale after generation cannot release a resource that
 * gained a reference.
 */
export async function applyResourceGc(
  input: ResourceGcInput,
  plan: GcPlan
): Promise<GcResult> {
  if (plan.mode === "report") {
    return Object.freeze({
      planned: plan,
      applied: Object.freeze([]),
      failed: Object.freeze([]),
      restored: Object.freeze([]),
      purged: Object.freeze([])
    });
  }

  const home = resolve(input.home);
  const now = input.now;
  const registryStore = input.registryStore ?? createResourceRegistryStore(home);
  let registry = registryStore.load();
  const applied: ResourceRecord[] = [];
  const failed: ResourceRecord[] = [];
  const restored: ResourceRecord[] = [];

  // Re-discover and re-scan with fresh state so the plan is validated against
  // the world as it exists right now, not when the plan was generated.
  const discovered = await discoverResources({
    home,
    projects: input.projects,
    managedWorkspaces: input.managedWorkspaces,
    taskStatusById: input.taskStatusById,
    now
  });
  const freshPaths = discovered.map(({ record }) => record.path);
  appendRegistryScanPaths(registry, freshPaths, home);
  const freshScan = await scanLiveReferences({
    home,
    paths: freshPaths,
    environment: input.environment,
    tmuxServerName: input.tmuxServerName,
    ports: {
      ...input.liveReferencePorts,
      managedWorkspaces: () => input.managedWorkspaces,
      activeWorkspaceOwners: () => collectActiveWorkspaceOwners(input)
    }
  });

  const freshClassified = classifyDiscoveredResources(
    discovered,
    registry,
    freshScan,
    input,
    home
  );
  const freshById = new Map(freshClassified.map(({ record }) => [record.id, record]));

  // Restore quarantined records whose owner is no longer terminal or that
  // gained a live reference. This is the apply-time counterpart of the old
  // planning-time restore: planning is read-only, so restore happens here.
  for (const record of Object.values(registry.records) as ResourceRecord[]) {
    if (record.disposition !== "quarantined" || record.quarantine === undefined) continue;
    const ownerTaskId = record.owner.taskId;
    const ownerNoLongerTerminal = ownerTaskId !== undefined
      && input.taskStatusById.has(ownerTaskId)
      && !isTerminalTaskStatus(input.taskStatusById.get(ownerTaskId) as never);
    const originalRefs = freshScan.refsByPath.get(record.quarantine.originalPath) ?? [];
    if (ownerNoLongerTerminal || originalRefs.length > 0) {
      const restoredRecord = restoreQuarantinedRecord(record, originalRefs, now);
      registry = upsertResourceRecord(registry, restoredRecord);
      if (restoredRecord.disposition === "active") {
        restored.push(restoredRecord);
      } else {
        failed.push(restoredRecord);
      }
    }
  }

  for (const planned of plan.records) {
    if (!isReleasable(planned)) continue;

    // Re-validate against fresh state: the resource must still exist, still
    // be clean, and still have zero live references.
    const fresh = freshById.get(planned.id);
    if (fresh === undefined) {
      // Resource disappeared since planning; reconcile the stale record.
      registry = removeResourceRecord(registry, planned.id);
      continue;
    }
    if (!isReleasable(fresh)) {
      // Fresh liveness, cleanliness, ownership, or diagnostic evidence changed
      // since planning: retain the resource and reconcile its registry record.
      registry = upsertResourceRecord(registry, fresh);
      continue;
    }

    const result = await quarantineResource(home, fresh, now);
    registry = upsertResourceRecord(registry, result.record);
    if (result.ok) {
      applied.push(result.record);
    } else {
      failed.push(result.record);
    }
  }

  registryStore.save(registry);
  registryStore.close();
  return Object.freeze({
    planned: plan,
    applied: Object.freeze(applied),
    failed: Object.freeze(failed),
    restored: Object.freeze(restored),
    purged: Object.freeze([])
  });
}

async function quarantineResource(
  home: string,
  record: ResourceRecord,
  now: Date
): Promise<{ ok: boolean; record: ResourceRecord }> {
  const quarantineRoot = resourceQuarantineRoot(home);
  const quarantinePath = join(quarantineRoot, record.id);
  const receiptPath = `${quarantinePath}.receipt.json`;
  try {
    if (isGitWorktreePath(record.path)) {
      // Move the linked worktree, including its exact checkout and Git
      // metadata, into the Home-local quarantine. Restore is the inverse
      // move, so the recorded HEAD cannot drift with a branch.
      mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
      await executeFile(
        "git",
        ["-C", record.path, "worktree", "move", "--", record.path, quarantinePath],
        { timeout: 30_000 }
      );
      writeQuarantineReceipt(home, record, now, "move", receiptPath);
      return {
        ok: true,
        record: {
          ...record,
          disposition: "quarantined",
          quarantine: {
            path: quarantinePath,
            originalPath: record.path,
            movedAt: now.toISOString(),
            method: "move",
            ...(record.git === undefined ? {} : {
              gitRestore: {
                repositoryPath: record.git.repositoryPath,
                ...(record.git.branch === undefined ? {} : { branch: record.git.branch }),
                ...(record.git.head === undefined ? {} : { head: record.git.head })
              }
            })
          },
          updatedAt: now.toISOString()
        }
      };
    }
    // Non-Git artifact: move into the Home-local quarantine.
    mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
    renameSync(record.path, quarantinePath);
    writeQuarantineReceipt(home, record, now, "move", receiptPath);
    return {
      ok: true,
      record: {
        ...record,
        disposition: "quarantined",
        quarantine: {
          path: quarantinePath,
          originalPath: record.path,
          movedAt: now.toISOString(),
          method: "move"
        },
        updatedAt: now.toISOString()
      }
    };
  } catch (error) {
    return {
      ok: false,
      record: {
        ...record,
        disposition: "cleanup-failed",
        blocker: `Quarantine failed: ${error instanceof Error ? error.message : "unknown error"}`,
        updatedAt: now.toISOString()
      }
    };
  }
}

function writeQuarantineReceipt(
  home: string,
  record: ResourceRecord,
  now: Date,
  method: "move" | "git-worktree-remove",
  receiptPath: string
): void {
  try {
    mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
    writeFileSync(receiptPath, `${JSON.stringify({
      schemaVersion: 1,
      id: record.id,
      kind: record.kind,
      originalPath: record.path,
      owner: record.owner,
      method,
      ...(record.git === undefined ? {} : { git: record.git }),
      movedAt: now.toISOString()
    }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A missing receipt does not block quarantine; the registry is authoritative.
  }
}

function isGitWorktreePath(path: string): boolean {
  return existsSync(join(path, ".git"));
}

/**
 * Restore a quarantined resource to its original path. Move-based Git
 * quarantine is reversed with `git worktree move`, preserving the exact
 * checkout. Legacy remove-based receipts rebuild a detached worktree at the
 * recorded HEAD; a branch tip is never used as a substitute.
 */
function restoreQuarantinedRecord(
  record: ResourceRecord,
  liveRefs: readonly string[],
  now: Date
): ResourceRecord {
  const quarantine = record.quarantine;
  if (quarantine === undefined) return record;
  try {
    if (quarantine.method === "git-worktree-remove" && quarantine.gitRestore !== undefined) {
      const git = quarantine.gitRestore;
      if (existsSync(quarantine.originalPath)) {
        return {
          ...record,
          disposition: "cleanup-failed",
          blocker: `Restore failed: original path already exists: ${quarantine.originalPath}`,
          updatedAt: now.toISOString()
        };
      }
      mkdirSync(dirname(quarantine.originalPath), { recursive: true });
      if (git.head !== undefined) {
        execFileSync(
          "git",
          ["-C", git.repositoryPath, "worktree", "add", "--detach", "--", quarantine.originalPath, git.head]
        );
      } else {
        throw new Error("no head recorded for Git worktree restore");
      }
    } else {
      // Move-based restore: rename the quarantine directory back.
      if (!existsSync(quarantine.path)) {
        return {
          ...record,
          disposition: "cleanup-failed",
          blocker: `Restore failed: quarantine path missing: ${quarantine.path}`,
          updatedAt: now.toISOString()
        };
      }
      if (existsSync(quarantine.originalPath)) {
        return {
          ...record,
          disposition: "cleanup-failed",
          blocker: `Restore failed: original path already exists: ${quarantine.originalPath}`,
          updatedAt: now.toISOString()
        };
      }
      if (isGitWorktreePath(quarantine.path)) {
        mkdirSync(dirname(quarantine.originalPath), { recursive: true });
        execFileSync(
          "git",
          ["-C", quarantine.path, "worktree", "move", "--", quarantine.path, quarantine.originalPath],
          { timeout: 30_000 }
        );
      } else {
        mkdirSync(dirname(quarantine.originalPath), { recursive: true });
        renameSync(quarantine.path, quarantine.originalPath);
      }
    }
  } catch (error) {
    return {
      ...record,
      disposition: "cleanup-failed",
      blocker: `Restore failed: ${error instanceof Error ? error.message : "unknown error"}`,
      updatedAt: now.toISOString()
    };
  }
  return {
    ...record,
    disposition: "active",
    activeRefs: Object.freeze([...liveRefs]),
    quarantine: undefined,
    blocker: "Restored from quarantine.",
    updatedAt: now.toISOString()
  };
}

/**
 * Permanently delete quarantined resources whose observation window has
 * elapsed. A resource with a new live reference — on either the original or
 * the quarantine path — is restored instead.
 */
export async function purgeResourceQuarantine(
  home: string,
  options: {
    now: Date;
    ttlHours?: number;
    environment?: NodeJS.ProcessEnv;
    tmuxServerName?: string;
    managedWorkspaces?: readonly import("../worktree/managedWorkspace.js").ManagedWorkspace[];
    /** Test seam for live-reference sources; production callers omit it. */
    liveReferencePorts?: LiveReferencePorts;
  }
): Promise<GcResult> {
  const resolvedHome = resolve(home);
  const ttlHours = options.ttlHours ?? DEFAULT_QUARANTINE_TTL_HOURS;
  const ttlMs = ttlHours * 3_600_000;
  const registryStore = createResourceRegistryStore(resolvedHome);
  const registry = registryStore.load();
  const quarantined = Object.values(registry.records)
    .filter((record) => record.quarantine !== undefined
      && (record.disposition === "quarantined" || record.disposition === "cleanup-failed"));

  // Re-scan live references for both original AND quarantine paths before
  // purging. A file held open inside quarantine must block deletion.
  const paths: string[] = [];
  for (const record of quarantined) {
    if (record.quarantine === undefined) continue;
    paths.push(record.quarantine.originalPath);
    paths.push(record.quarantine.path);
  }
  const scan = await scanLiveReferences({
    home: resolvedHome,
    paths,
    environment: options.environment,
    tmuxServerName: options.tmuxServerName,
    ports: {
      ...options.liveReferencePorts,
      managedWorkspaces: () => options.managedWorkspaces ?? [],
      activeWorkspaceOwners: () => []
    }
  });

  let state = registry;
  const purged: ResourceRecord[] = [];
  const restored: ResourceRecord[] = [];
  const failed: ResourceRecord[] = [];
  const scanUntrusted = scan.diagnostics.some((diagnostic) => diagnostic.severity === "error");

  for (const record of quarantined) {
    const quarantine = record.quarantine;
    if (quarantine === undefined) continue;
    const ageMs = options.now.getTime() - Date.parse(quarantine.movedAt);
    if (!Number.isFinite(ageMs) || ageMs < ttlMs) continue;
    // A live-reference source that cannot be trusted fails closed: keep the
    // resource quarantined instead of permanently deleting it.
    if (scanUntrusted) continue;

    const originalRefs = scan.refsByPath.get(quarantine.originalPath) ?? [];
    const quarantineRefs = scan.refsByPath.get(quarantine.path) ?? [];
    const allRefs = [...originalRefs, ...quarantineRefs];
    if (allRefs.length > 0) {
      const restoredRecord = restoreQuarantinedRecord(record, allRefs, options.now);
      state = upsertResourceRecord(state, restoredRecord);
      if (restoredRecord.disposition === "active") {
        restored.push(restoredRecord);
      } else {
        failed.push(restoredRecord);
      }
      continue;
    }

    try {
      if (existsSync(quarantine.path)) {
        if (isGitWorktreePath(quarantine.path)) {
          await executeFile(
            "git",
            ["-C", quarantine.path, "worktree", "remove", "--force", "--", quarantine.path],
            { timeout: 30_000 }
          );
        }
        rmSync(quarantine.path, { recursive: true, force: true });
      }
      // Also remove the receipt sibling.
      const receiptPath = `${quarantine.path}.receipt.json`;
      if (existsSync(receiptPath)) {
        rmSync(receiptPath, { force: true });
      }
      const deleted: ResourceRecord = {
        ...record,
        disposition: "deleted",
        quarantine: undefined,
        cleanupReceipt: {
          removedAt: options.now.toISOString(),
          method: "quarantine-purge"
        },
        updatedAt: options.now.toISOString()
      };
      state = upsertResourceRecord(state, deleted);
      purged.push(deleted);
    } catch (error) {
      const failedRecord: ResourceRecord = {
        ...record,
        disposition: "cleanup-failed",
        blocker: `Purge failed: ${error instanceof Error ? error.message : "unknown error"}`,
        updatedAt: options.now.toISOString()
      };
      state = upsertResourceRecord(state, failedRecord);
      failed.push(failedRecord);
    }
  }

  registryStore.save(state);
  registryStore.close();
  return Object.freeze({
    planned: Object.freeze({
      home: resolvedHome,
      mode: "quarantine",
      generatedAt: options.now.toISOString(),
      records: Object.freeze([]),
      releasable: Object.freeze([]),
      retained: Object.freeze([]),
      quarantined: Object.freeze(quarantined),
      deleted: Object.freeze([]),
      scan
    }),
    applied: Object.freeze([]),
    failed: Object.freeze(failed),
    restored: Object.freeze(restored),
    purged: Object.freeze(purged)
  });
}

/**
 * Explicitly restore every quarantined resource to its original path. This is
 * the rollback entry point: it does not require live references and does not
 * depend on the GC mode.
 */
export async function restoreAllResourceGc(
  home: string,
  options: { now: Date }
): Promise<GcResult> {
  const resolvedHome = resolve(home);
  const registryStore = createResourceRegistryStore(resolvedHome);
  const registry = registryStore.load();
  const quarantined = Object.values(registry.records)
    .filter((record) => record.quarantine !== undefined
      && (record.disposition === "quarantined" || record.disposition === "cleanup-failed"));

  let state = registry;
  const restored: ResourceRecord[] = [];
  const failed: ResourceRecord[] = [];

  for (const record of quarantined) {
    const restoredRecord = restoreQuarantinedRecord(record, [], options.now);
    state = upsertResourceRecord(state, restoredRecord);
    if (restoredRecord.disposition === "active") {
      restored.push(restoredRecord);
    } else {
      failed.push(restoredRecord);
    }
  }

  registryStore.save(state);
  registryStore.close();
  return Object.freeze({
    planned: Object.freeze({
      home: resolvedHome,
      mode: "quarantine",
      generatedAt: options.now.toISOString(),
      records: Object.freeze([]),
      releasable: Object.freeze([]),
      retained: Object.freeze([]),
      quarantined: Object.freeze(quarantined),
      deleted: Object.freeze([]),
      scan: Object.freeze({
        refsByPath: new Map(),
        protectedPaths: Object.freeze([]),
        diagnostics: Object.freeze([])
      })
    }),
    applied: Object.freeze([]),
    failed: Object.freeze(failed),
    restored: Object.freeze(restored),
    purged: Object.freeze([])
  });
}
