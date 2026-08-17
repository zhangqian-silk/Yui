/**
 * Four-state classification of a real Yui Home.
 *
 * This layers real, I/O-based corruption detection onto the pure WI-3
 * classifier. It reports exactly one shared product state — current,
 * compatible-old, migration-required, or unsupported — together with the
 * on-disk layout and aggregate versions and, when the store cannot be used, the
 * incompatible component (layout vs aggregate).
 *
 * Corruption is only ever reported from a *real* structural failure: a
 * `state.json` that is not parseable / not shaped like the record locators
 * describe / carries a record with an invalid `schemaVersion`, a broken reference
 * graph (detected by the strict loader once every axis is already current), or a
 * `schema.json` manifest that is not valid. It is never inferred from version
 * magnitude. An older or newer version — on ANY axis, including a single older
 * record family — is a version verdict (`COMPATIBLE` for an all-compatible path,
 * `MIGRATABLE` for an offline path, otherwise `NEEDS_NEW_VERSION`), never
 * `CORRUPTED`. An older Home without a complete declared path fails closed with
 * a precise missing declaration/step reason.
 *
 * The three axes are independent: record versions come from the durable
 * manifest and raw `state.json` is traversed structurally only to verify that
 * non-empty families agree. This keeps a record-only-older Home on its version
 * axis without letting an empty target family masquerade as current.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  classifyStorage,
  type Classification,
  type CorruptionSignal,
  type MigrationRegistry,
  type StorageVersionState
} from "../migration/index.js";
import {
  inspectStorageSchema,
  type StorageSchemaState
} from "../storageSchema.js";
import { FileTaskStore, STORAGE_STATE_FILE, StorageRecordError } from "../taskStore.js";
import { SqliteTaskStore } from "../sqliteStore.js";
import {
  inspectSourceVersionState,
  type HomeSnapshot
} from "./homeMigrationTarget.js";
import { readMigrationReceipt } from "./migrationReceipt.js";

/** The rich, presentation-ready classification of a Home. */
export type HomeClassification = Readonly<{
  classification: Classification;
  /** On-disk layout version, when the manifest was readable. */
  layoutVersion?: number;
  /** On-disk aggregate version, when the manifest was readable. */
  aggregateVersion?: number;
  /** Latest supported layout version. */
  latestLayoutVersion: number;
  /** Latest supported aggregate version. */
  latestAggregateVersion: number;
  /** Which scalar component is incompatible, when a version blocks use. */
  incompatibleComponent?: "layout" | "aggregate" | "record";
  /** Set when the Home has never been initialized (`yui setup` needed). */
  uninitialized?: true;
}>;

export type ClassifyHomeOptions<Snapshot> = Readonly<{
  home: string;
  registry: MigrationRegistry<Snapshot>;
  latest: StorageVersionState;
}>;

/**
 * Classify a real Home. Reads `schema.json` (and, for a current Home,
 * `state.json` through the strict loader) read-only; never mutates the Home.
 */
export function classifyHome<Snapshot>(
  options: ClassifyHomeOptions<Snapshot>
): HomeClassification {
  const { home, registry, latest } = options;
  const schema = inspectStorageSchema(home);
  const base = {
    latestLayoutVersion: latest.layout,
    latestAggregateVersion: latest.aggregate
  } as const;

  if (schema.status === "uninitialized") {
    return {
      ...base,
      classification: { verdict: "USABLE", status: "current" },
      uninitialized: true
    };
  }

  if (schema.status === "invalid") {
    // A malformed manifest is real structural damage, not a version verdict.
    return {
      ...base,
      classification: {
        verdict: "CORRUPTED",
        status: "unsupported",
        detail: `Storage schema manifest is invalid: ${schema.detail}`
      }
    };
  }

  // Read all three durable axes read-only, then structurally cross-check raw
  // state.json without invoking the strict current loader. Version differences
  // remain version facts; manifest/state contradictions surface as corruption.
  const inspected = inspectSourceVersionState(home, latest);
  if ("corruption" in inspected) {
    return {
      ...base,
      classification: {
        verdict: "CORRUPTED",
        status: "unsupported",
        detail: inspected.corruption.detail
      },
      layoutVersion: schema.currentLayoutVersion,
      aggregateVersion: schema.currentAggregateSchemaVersion,
      ...(incompatibleComponentOf(schema) === undefined
        ? {}
        : { incompatibleComponent: incompatibleComponentOf(schema) })
    };
  }
  const source: StorageVersionState = inspected.source;

  // Layout 7 physical-backend invariant (Issue 01): the manifest claims SQLite
  // WAL as the authoritative store, so `yui.db` must exist and be healthy. A
  // layout-7 Home without `yui.db` is a *pseudo-layout-7* Home — repairable
  // when `state.json` is strictly readable, corrupted otherwise. A Home with
  // both `state.json` and `yui.db` but no persistent migration receipt is an
  // ambiguous dual-copy conflict. These are physical-backend facts, not
  // version verdicts, so they are decided before the pure classifier runs.
  if (source.layout === latest.layout && latest.layout >= 7) {
    const physical = inspectLayout7PhysicalBackend(home);
    if (physical !== undefined) {
      return {
        ...base,
        classification: physical,
        layoutVersion: schema.currentLayoutVersion,
        aggregateVersion: schema.currentAggregateSchemaVersion,
        ...(incompatibleComponentOf(schema) === undefined
          ? {}
          : { incompatibleComponent: incompatibleComponentOf(schema) })
      };
    }
  }

  // The reference graph can only be validated by the strict loader, which only
  // understands the current versions. So run it exactly when every axis is
  // already current (the plan would be a no-op); a throw there is genuine
  // structural/reference corruption, never a version mismatch. An older/newer
  // axis skips the loader and is decided purely by the planner below.
  //
  // Crucially, the strict loader is ONLY invoked when the manifest itself is
  // `current`. An `unsupported` manifest (e.g. a pre-baseline Home with no
  // recordVersions field) must never reach FileTaskStore: requireStorageSchema
  // would throw StorageSchemaError, which doctor/upgrade must surface as a
  // structured NEEDS_NEW_VERSION verdict, not as an invalid/corruption error.
  const corruption = (schema.status === "current" && isFullyCurrent(source, latest))
    ? detectCurrentHomeCorruption(home)
    : undefined;

  const classification = classifyStorage(registry, source, latest, corruption);
  return {
    ...base,
    classification,
    layoutVersion: schema.currentLayoutVersion,
    aggregateVersion: schema.currentAggregateSchemaVersion,
    ...(incompatibleComponentOf(schema) === undefined
      ? {}
      : { incompatibleComponent: incompatibleComponentOf(schema) })
  };
}

/**
 * Load a Home whose every axis is already current through the strict store
 * gate to detect real structural/reference corruption. This is only ever
 * called when the source equals `latest` across all three axes, so a version
 * error cannot occur here and any throw is genuine corruption (bad record
 * shape, a broken reference graph, or a damaged SQLite database).
 *
 * A layout-7 Home whose authoritative store is `yui.db` is verified through
 * {@link SqliteTaskStore}; a layout-7 Home that still uses the aggregate
 * `state.json` (or a layout-6 Home in tests) is verified through
 * {@link FileTaskStore}.
 */
function detectCurrentHomeCorruption(home: string): CorruptionSignal | undefined {
  try {
    if (existsSync(`${home}/yui.db`)) {
      const store = new SqliteTaskStore(home);
      try {
        store.getConfig();
        store.listTasks();
        store.listProjects();
        store.listConfiguredAgents();
        store.listWorkMailboxes();
      } finally {
        store.close();
      }
    } else {
      const store = new FileTaskStore(home);
      store.getConfig();
      store.listTasks();
      store.listProjects();
      store.listConfiguredAgents();
      store.listWorkMailboxes();
    }
    return undefined;
  } catch (error) {
    if (error instanceof StorageRecordError) {
      return { corrupted: true, detail: error.message };
    }
    // A SQLite-level error (corrupt database file, I/O fault) is structural
    // damage, not a version mismatch.
    if (error instanceof Error && (error.name === "SqliteError" || error.message.includes("SQLite"))) {
      return { corrupted: true, detail: error.message };
    }
    // A non-record error (e.g. an unexpected I/O fault) is surfaced, not
    // silently swallowed as "usable".
    throw error;
  }
}

/** True when the source is already at `latest` on every axis (a no-op plan). */
function isFullyCurrent(
  source: StorageVersionState,
  latest: StorageVersionState
): boolean {
  if (source.layout !== latest.layout || source.aggregate !== latest.aggregate) {
    return false;
  }
  // Every family shared by source and target must already match; a family
  // present on only one side is a difference the planner reasons about, not a
  // "current" match, so it is not fully current.
  const kinds = new Set([
    ...Object.keys(source.record),
    ...Object.keys(latest.record)
  ]);
  for (const kind of kinds) {
    const from = source.record[kind]?.version;
    const to = latest.record[kind]?.version;
    if (from !== to) return false;
  }
  return true;
}

function incompatibleComponentOf(
  schema: StorageSchemaState
): "layout" | "aggregate" | "record" | undefined {
  return schema.status === "unsupported" ? schema.incompatibleComponent : undefined;
}

/**
 * Inspect the physical-backend invariant of a layout-7 Home (Issue 01):
 * `yui.db` must exist and be healthy. Returns a classification verdict when
 * the invariant is violated, or `undefined` when the Home is physically sound
 * (the pure classifier then decides the version verdict).
 *
 *  - manifest=7, no `yui.db`, `state.json` strictly readable →
 *    `NEEDS_STORAGE_REPAIR` (pseudo-layout-7);
 *  - manifest=7, no `yui.db`, no readable `state.json` → `CORRUPTED`
 *    (no authoritative backend);
 *  - `yui.db` unopenable or failing `PRAGMA quick_check` → `CORRUPTED`
 *    (damaged database);
 *  - both `state.json` and `yui.db` without a persistent migration receipt →
 *    `CORRUPTED` (dual-copy conflict; never guess which copy is newer).
 */
function inspectLayout7PhysicalBackend(home: string): Classification | undefined {
  const dbPath = join(home, "yui.db");
  const statePath = join(home, STORAGE_STATE_FILE);
  if (!existsSync(dbPath)) {
    if (isReadableStateObject(statePath)) {
      return {
        verdict: "NEEDS_STORAGE_REPAIR",
        status: "needs-storage-repair",
        detail:
          "Storage declares layout 7 but has no yui.db; state.json is the only "
          + "authoritative copy (pseudo-layout-7). Run `yui upgrade` to rebuild "
          + "the SQLite database."
      };
    }
    return {
      verdict: "CORRUPTED",
      status: "unsupported",
      detail:
        "Storage declares layout 7 but has neither yui.db nor a readable "
        + "state.json; there is no authoritative backend."
    };
  }

  // `yui.db` exists: it must open and pass an integrity check.
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const integrity = db.pragma("quick_check", { simple: true });
      if (integrity !== "ok") {
        return {
          verdict: "CORRUPTED",
          status: "unsupported",
          detail: `SQLite integrity check failed: ${String(integrity)}.`
        };
      }
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      verdict: "CORRUPTED",
      status: "unsupported",
      detail:
        `SQLite database cannot be opened: ${error instanceof Error ? error.message : String(error)}.`
    };
  }

  // A healthy `yui.db` plus `state.json` is only legitimate right after a
  // certified switch; without the persistent migration receipt it is a
  // dual-copy conflict.
  if (existsSync(statePath) && readMigrationReceipt(home) === null) {
    return {
      verdict: "CORRUPTED",
      status: "unsupported",
      detail:
        "Both state.json and yui.db exist without a migration receipt; the "
        + "authoritative copy is ambiguous. Restore one copy from a backup; do "
        + "not guess which is newer."
    };
  }
  return undefined;
}

/** True when `state.json` exists and parses as a strict JSON object. */
function isReadableStateObject(statePath: string): boolean {
  if (!existsSync(statePath)) return false;
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** A structural corruption check over an already-read snapshot (for tests/reports). */
export function snapshotHasState(snapshot: HomeSnapshot): boolean {
  return snapshot.state !== null;
}
