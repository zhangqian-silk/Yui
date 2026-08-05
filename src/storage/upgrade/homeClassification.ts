/**
 * Four-state classification of a real Yui Home.
 *
 * This layers real, I/O-based corruption detection onto the pure WI-3
 * classifier. It reports exactly one verdict —
 * `USABLE` / `MIGRATABLE` / `NEEDS_NEW_VERSION` / `CORRUPTED` — together with the
 * on-disk layout and aggregate versions and, when the store cannot be used, the
 * incompatible component (layout vs aggregate).
 *
 * Corruption is only ever reported from a *real* structural failure: a
 * `state.json` that fails the strict `parseState` gate (bad record shape, a
 * broken reference graph), or a `schema.json` manifest that is not valid. It is
 * never inferred from version magnitude. An older or newer version is a version
 * verdict (`MIGRATABLE` when a complete step path exists, else
 * `NEEDS_NEW_VERSION`), never `CORRUPTED`. With the registry shipping EMPTY, any
 * strictly-older Home is `NEEDS_NEW_VERSION` via a precise `missing-step` reason.
 */

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
import { FileTaskStore, StorageRecordError } from "../taskStore.js";
import type { HomeSnapshot } from "./homeMigrationTarget.js";

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
  incompatibleComponent?: "layout" | "aggregate";
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
    return { ...base, classification: { verdict: "USABLE" }, uninitialized: true };
  }

  if (schema.status === "invalid") {
    // A malformed manifest is real structural damage, not a version verdict.
    return {
      ...base,
      classification: {
        verdict: "CORRUPTED",
        detail: `Storage schema manifest is invalid: ${schema.detail}`
      }
    };
  }

  const source: StorageVersionState = {
    layout: schema.currentLayoutVersion,
    aggregate: schema.currentAggregateSchemaVersion,
    // See homeMigrationTarget: the scalar axes block first in planner order, so
    // the source record map is only consulted once layout+aggregate are current,
    // at which point parseState has proven every record is at its current version.
    record: latest.record
  };

  const corruption = schema.status === "current"
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
 * Load a *current-version* Home through the strict `FileTaskStore` gate to
 * detect real structural/reference corruption. A version error cannot occur
 * here (the manifest already reported `current`), so any throw is corruption.
 */
function detectCurrentHomeCorruption(home: string): CorruptionSignal | undefined {
  try {
    const store = new FileTaskStore(home);
    store.getConfig();
    store.listTasks();
    store.listProjects();
    store.listConfiguredAgents();
    store.listWorkMailboxes();
    return undefined;
  } catch (error) {
    if (error instanceof StorageRecordError) {
      return { corrupted: true, detail: error.message };
    }
    // A non-record error (e.g. an unexpected I/O fault) is surfaced, not
    // silently swallowed as "usable".
    throw error;
  }
}

function incompatibleComponentOf(
  schema: StorageSchemaState
): "layout" | "aggregate" | undefined {
  return schema.status === "unsupported" ? schema.incompatibleComponent : undefined;
}

/** A structural corruption check over an already-read snapshot (for tests/reports). */
export function snapshotHasState(snapshot: HomeSnapshot): boolean {
  return snapshot.state !== null;
}
