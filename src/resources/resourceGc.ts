/**
 * Resource GC engine (Issue 10).
 *
 * Quarantine-first garbage collection for managed worktrees, deployments, and
 * runtime artifacts. Permanent deletion is always delayed behind an
 * observation window; anything whose ownership, cleanliness, or liveness
 * cannot be proven is retained and reported.
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  loadResourceRegistry,
  removeResourceRecord,
  resourceQuarantineRoot,
  saveResourceRegistry,
  upsertResourceRecord
} from "./resourceRegistry.js";
import {
  isReleasable,
  isTerminalTaskStatus,
  type ResourceRecord,
  type ResourceRegistryState
} from "./resourceTypes.js";
import { scanLiveReferences, type LiveReferenceScan } from "./liveReferences.js";
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
  projects: readonly import("../repository/project.js").Project[];
  managedWorkspaces: readonly import("../worktree/managedWorkspace.js").ManagedWorkspace[];
  taskStatusById: ReadonlyMap<string, string>;
  mode: GcMode;
  now: Date;
  quarantineTtlHours?: number;
  environment?: NodeJS.ProcessEnv;
  tmuxServerName?: string;
}>;

/**
 * Plan a GC pass: discover resources, scan live references, and classify each
 * record. Planning never mutates disk state.
 */
export async function planResourceGc(input: ResourceGcInput): Promise<GcPlan> {
  const home = resolve(input.home);
  const discovered = await discoverResources({
    home,
    projects: input.projects,
    managedWorkspaces: input.managedWorkspaces,
    taskStatusById: input.taskStatusById,
    now: input.now
  });
  const paths = discovered.map(({ record }) => record.path);
  // Also scan original paths of quarantined records so a new reference can
  // trigger a restore.
  const registry = loadResourceRegistry(home);
  for (const record of Object.values(registry.records) as ResourceRecord[]) {
    if (record.disposition === "quarantined" && record.quarantine !== undefined) {
      paths.push(record.quarantine.originalPath);
    }
  }
  const scan = await scanLiveReferences({
    home,
    paths,
    environment: input.environment,
    tmuxServerName: input.tmuxServerName
  });

  const records = discovered.map(({ record, ownerTerminal }) =>
    classifyRecord(record, ownerTerminal, scan, registry, input.now)
  );

  // Include quarantined records whose original path no longer hosts the
  // resource (it was moved into quarantine). These are evaluated for restore
  // when a new live reference appears.
  const discoveredIds = new Set(records.map((record) => record.id));
  for (const record of Object.values(registry.records) as ResourceRecord[]) {
    if (record.disposition !== "quarantined" || discoveredIds.has(record.id)) continue;
    const liveRefs = scan.refsByPath.get(record.quarantine?.originalPath ?? record.path) ?? [];
    const ownerTaskId = record.owner.taskId;
    const ownerNoLongerTerminal = ownerTaskId !== undefined
      && input.taskStatusById.has(ownerTaskId)
      && !isTerminalTaskStatus(input.taskStatusById.get(ownerTaskId) as never);
    if (liveRefs.length > 0 || ownerNoLongerTerminal) {
      records.push(restoreQuarantinedRecord(record, liveRefs, input.now));
    } else {
      records.push(record);
    }
  }

  // Reconcile registry records whose disk resource disappeared (e.g. removed
  // by an external flow): keep deleted receipts, drop stale active records.
  const reconciled = reconcileRegistry(registry, records, input.now);
  if (reconciled !== registry) {
    saveResourceRegistry(home, reconciled);
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
      || record.disposition === "cleanup-failed"
    )),
    quarantined: Object.freeze(records.filter((record) => record.disposition === "quarantined")),
    deleted: Object.freeze(records.filter((record) => record.disposition === "deleted")),
    scan
  });
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
    if (liveRefs.length > 0) {
      // A new reference appeared: restore instead of purging.
      return restoreQuarantinedRecord(existing, liveRefs, now);
    }
    return existing;
  }
  if (existing?.disposition === "deleted") {
    return existing;
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
      blocker: "Worktree has uncommitted changes; preserve dirty evidence before release.",
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

function restoreQuarantinedRecord(
  record: ResourceRecord,
  liveRefs: readonly string[],
  now: Date
): ResourceRecord {
  const quarantine = record.quarantine;
  if (quarantine === undefined) return record;
  try {
    if (existsSync(quarantine.path) && !existsSync(quarantine.originalPath)) {
      mkdirSync(resolve(quarantine.originalPath, ".."), { recursive: true });
      renameSync(quarantine.path, quarantine.originalPath);
    }
  } catch {
    // Restore failed: keep quarantined; the next pass retries.
    return record;
  }
  return {
    ...record,
    disposition: "active",
    activeRefs: Object.freeze([...liveRefs]),
    quarantine: undefined,
    blocker: "Restored from quarantine after a new live reference appeared.",
    updatedAt: now.toISOString()
  };
}

function reconcileRegistry(
  registry: ResourceRegistryState,
  current: readonly ResourceRecord[],
  now: Date
): ResourceRegistryState {
  let state = registry;
  const currentIds = new Set(current.map((record) => record.id));
  for (const record of Object.values(registry.records) as ResourceRecord[]) {
    if (currentIds.has(record.id)) continue;
    if (record.disposition === "deleted") continue;
    if (record.disposition === "quarantined") {
      // Quarantined resources are no longer at their original path; keep them.
      continue;
    }
    // The disk resource disappeared without a receipt: drop the stale record.
    state = removeResourceRecord(state, record.id);
  }
  for (const record of current) {
    const existing = state.records[record.id];
    if (existing === undefined
      || existing.disposition !== record.disposition
      || existing.activeRefs.length !== record.activeRefs.length) {
      state = upsertResourceRecord(state, record);
    }
  }
  return state === registry && state.records === registry.records
    ? registry
    : state;
}

/**
 * Apply a GC plan: quarantine every releasable resource. In `report` mode this
 * is a shadow pass — the plan is returned unchanged and nothing is mutated.
 */
export async function applyResourceGc(plan: GcPlan): Promise<GcResult> {
  if (plan.mode === "report") {
    return Object.freeze({
      planned: plan,
      applied: Object.freeze([]),
      failed: Object.freeze([]),
      restored: Object.freeze([]),
      purged: Object.freeze([])
    });
  }

  const home = plan.home;
  const now = new Date(plan.generatedAt);
  let registry = loadResourceRegistry(home);
  const applied: ResourceRecord[] = [];
  const failed: ResourceRecord[] = [];
  const restored: ResourceRecord[] = [];

  for (const record of plan.records) {
    if (record.disposition === "active" && record.quarantine !== undefined) {
      // A restore happened during planning; persist it.
      registry = upsertResourceRecord(registry, record);
      restored.push(record);
      continue;
    }
    if (!isReleasable(record)) continue;
    const result = await quarantineResource(home, record, now);
    if (result.ok) {
      registry = upsertResourceRecord(registry, result.record);
      applied.push(result.record);
    } else {
      registry = upsertResourceRecord(registry, result.record);
      failed.push(result.record);
    }
  }

  saveResourceRegistry(home, registry);
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
  try {
    if (record.kind === "worktree" && record.git !== undefined) {
      // Controlled Git removal; the metadata receipt stays in the registry.
      await executeFile(
        "git",
        ["-C", record.git.repositoryPath, "worktree", "remove", "--", record.path],
        { timeout: 30_000 }
      );
      writeQuarantineReceipt(home, record, now, "git-worktree-remove");
      return {
        ok: true,
        record: {
          ...record,
          disposition: "quarantined",
          quarantine: {
            path: quarantinePath,
            originalPath: record.path,
            movedAt: now.toISOString()
          },
          updatedAt: now.toISOString()
        }
      };
    }
    // Non-Git artifact: move into the Home-local quarantine.
    mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
    renameSync(record.path, quarantinePath);
    writeQuarantineReceipt(home, record, now, "quarantine-move");
    return {
      ok: true,
      record: {
        ...record,
        disposition: "quarantined",
        quarantine: {
          path: quarantinePath,
          originalPath: record.path,
          movedAt: now.toISOString()
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
  method: string
): void {
  const receiptPath = join(resourceQuarantineRoot(home), record.id, ".quarantine-receipt.json");
  try {
    mkdirSync(join(resourceQuarantineRoot(home), record.id), { recursive: true, mode: 0o700 });
    writeFileSync(receiptPath, `${JSON.stringify({
      schemaVersion: 1,
      id: record.id,
      kind: record.kind,
      originalPath: record.path,
      owner: record.owner,
      method,
      movedAt: now.toISOString()
    }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A missing receipt does not block quarantine; the registry is authoritative.
  }
}

/**
 * Permanently delete quarantined resources whose observation window has
 * elapsed. A resource with a new live reference is restored instead.
 */
export async function purgeResourceQuarantine(
  home: string,
  options: { now: Date; ttlHours?: number; environment?: NodeJS.ProcessEnv; tmuxServerName?: string }
): Promise<GcResult> {
  const resolvedHome = resolve(home);
  const ttlHours = options.ttlHours ?? DEFAULT_QUARANTINE_TTL_HOURS;
  const ttlMs = ttlHours * 3_600_000;
  const registry = loadResourceRegistry(resolvedHome);
  const quarantined = Object.values(registry.records)
    .filter((record) => record.disposition === "quarantined");

  // Re-scan live references for quarantined resources before purging.
  const paths = quarantined
    .map((record) => record.quarantine?.originalPath)
    .filter((path): path is string => path !== undefined);
  const scan = await scanLiveReferences({
    home: resolvedHome,
    paths,
    environment: options.environment,
    tmuxServerName: options.tmuxServerName
  });

  let state = registry;
  const purged: ResourceRecord[] = [];
  const restored: ResourceRecord[] = [];
  const failed: ResourceRecord[] = [];

  for (const record of quarantined) {
    const quarantine = record.quarantine;
    if (quarantine === undefined) continue;
    const ageMs = options.now.getTime() - Date.parse(quarantine.movedAt);
    if (!Number.isFinite(ageMs) || ageMs < ttlMs) continue;

    const liveRefs = scan.refsByPath.get(quarantine.originalPath) ?? [];
    if (liveRefs.length > 0) {
      const restoredRecord = restoreQuarantinedRecord(record, liveRefs, options.now);
      state = upsertResourceRecord(state, restoredRecord);
      restored.push(restoredRecord);
      continue;
    }

    try {
      if (existsSync(quarantine.path)) {
        rmSync(quarantine.path, { recursive: true, force: true });
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

  saveResourceRegistry(resolvedHome, state);
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
