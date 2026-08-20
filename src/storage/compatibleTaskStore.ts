import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MigrationRegistry,
  StorageCompatibilityError,
  loadCompatibleSnapshot,
  type StorageVersionState
} from "./migration/index.js";
import { createProductionStorageRegistry } from "./migration/productionRegistry.js";
import {
  FileTaskStore,
  STORAGE_STATE_FILE,
  type TaskStore,
  stateFileFingerprint,
  StorageRecordError,
  validateCurrentStorageStateSnapshot
} from "./taskStore.js";
import { readSqliteHomeIdentity, SqliteTaskStore } from "./sqliteStore.js";
import { COMMITTED_DATABASE_FILENAME } from "./upgrade/sqliteStateMigration.js";
import {
  validateHomeIdentity,
  type HomeIdentity
} from "../repository/homeIdentity.js";
import {
  ensureStorageSchema,
  inspectStorageSchema,
  readStorageSchemaManifest,
  STORAGE_SCHEMA_FILE
} from "./storageSchema.js";
import { classifyHome } from "./upgrade/homeClassification.js";
import {
  inspectSnapshotVersionState,
  type HomeSnapshot
} from "./upgrade/homeMigrationTarget.js";
import { latestStorageVersionState } from "./upgrade/recordVersions.js";

export { createProductionStorageRegistry } from "./migration/productionRegistry.js";

export type OpenCompatibleFileTaskStoreOptions = Readonly<{
  registry?: MigrationRegistry<HomeSnapshot>;
  latest?: StorageVersionState;
  /**
   * Force the file-document (`state.json`) open path even when a layout-7
   * Home has `yui.db`. Ordinary commands open the authoritative SQLite
   * backend; compatible-source validation must prove the *classified source*
   * (`state.json`) reaches the strict parser, so it never short-circuits to
   * the database (Issue 01).
   */
  forceStateSource?: boolean;
}>;

/**
 * Initialize a brand-new Home, or open an existing Home through the same
 * compatibility classification as every ordinary command. Setup is the one
 * ordinary flow that is also responsible for creating the initial manifest.
 */
export function initializeCompatibleFileTaskStore(
  home: string,
  options: OpenCompatibleFileTaskStoreOptions = {}
): TaskStore {
  if (inspectStorageSchema(home).status === "uninitialized") {
    ensureStorageSchema(home);
  }
  return openCompatibleFileTaskStore(home, options);
}

/**
 * Open current or explicitly compatible-old storage. Compatible records are
 * normalized in memory through strict old-shape validators; FileTaskStore then
 * runs its one current parser and its existing writer emits only current bytes.
 *
 * A current Home is opened from a single fingerprint-fenced `state.json`
 * snapshot: the same bytes drive the record-version inspection, the strict
 * shape/reference validation, and the returned store's initial cache seed, so
 * the open never re-reads the (large) state merely to construct or first use
 * the store.
 */
export function openCompatibleFileTaskStore(
  home: string,
  options: OpenCompatibleFileTaskStoreOptions = {}
): TaskStore {
  const registry = options.registry ?? createProductionStorageRegistry();
  const latest = options.latest ?? latestStorageVersionState();
  const schema = inspectStorageSchema(home);
  // Issue 01: a layout-7 Home's authoritative backend is SQLite WAL. When
  // `yui.db` exists, open it directly — never fall back to a FileTaskStore
  // over a `state.json` that the repair may already have archived.
  if (
    !options.forceStateSource
    &&
    (schema.status === "current" || schema.status === "unsupported")
    && schema.currentLayoutVersion >= 7
    && existsSync(join(home, COMMITTED_DATABASE_FILENAME))
  ) {
    return new SqliteTaskStore(home);
  }
  if (schema.status === "current") {
    return openCurrentFileTaskStore(home, latest);
  }
  const classification = classifyHome({ home, registry, latest });
  switch (classification.classification.status) {
    case "current":
    case "needs-storage-repair":
      // A pseudo-layout-7 Home whose aggregate axis is also older cannot be
      // normalized in memory: the compatible loader (requireCompatibleStorageSchema)
      // only bypasses record-axis mismatches, not aggregate/layout ones. Such a
      // Home needs the offline migration path (repair + aggregate migration in
      // one upgrade), so surface the same migration-required error the pure
      // version classifier would have produced, rather than a lazy strict-schema
      // error from the first store read.
      if (
        classification.classification.status === "needs-storage-repair"
        && classification.aggregateVersion !== undefined
        && classification.aggregateVersion < latest.aggregate
      ) {
        throw new StorageCompatibilityError(
          "Storage requires an offline migration. Re-run `yui update` when active Sessions are clear."
        );
      }
      // A pseudo-layout-7 Home (manifest 7, no yui.db) may also carry
      // compatible-old record versions, so open with the same normalization
      // path as `compatible-old` rather than the strict current gate.
      return new FileTaskStore(home, {
        normalizeState: (raw) => normalizeState(home, raw, registry, latest)
      });
    case "compatible-old":
      return new FileTaskStore(home, {
        normalizeState: (raw) => normalizeState(home, raw, registry, latest)
      });
    case "migration-required":
      throw new StorageCompatibilityError(
        "Storage requires an offline migration. Re-run `yui update` when active Sessions are clear."
      );
    case "unsupported":
      throw new StorageCompatibilityError(describeUnsupported(classification.classification));
  }
}

/**
 * Read the one authoritative durable Home identity without creating runtime
 * state. SQLite is opened read-only; file-backed Homes read only the immutable
 * identity field, so an aggregate that requires offline migration can still
 * authenticate its already-running Controller before the migration stops it.
 */
export function readCompatibleHomeIdentity(
  home: string,
  options: OpenCompatibleFileTaskStoreOptions = {}
): HomeIdentity {
  const schema = inspectStorageSchema(home);
  if (
    !options.forceStateSource
    && (schema.status === "current" || schema.status === "unsupported")
    && schema.currentLayoutVersion >= 7
    && existsSync(join(home, COMMITTED_DATABASE_FILENAME))
  ) {
    return readSqliteHomeIdentity(home, COMMITTED_DATABASE_FILENAME);
  }
  if (!existsSync(join(home, STORAGE_STATE_FILE))) {
    throw new StorageRecordError("Durable Home identity is missing.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(home, STORAGE_STATE_FILE), "utf8")) as unknown;
  } catch {
    throw new StorageRecordError("Durable Home identity state is invalid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StorageRecordError("Durable Home identity state is invalid.");
  }
  try {
    return validateHomeIdentity(
      (parsed as { homeIdentity?: unknown }).homeIdentity as HomeIdentity
    );
  } catch {
    throw new StorageRecordError("Durable Home identity is invalid.");
  }
}

/**
 * The one-snapshot open for a Home whose manifest is already current. A single
 * fingerprint-fenced read of `state.json` supplies:
 *  - the record-version inspection (structural scan cross-checked against the
 *    durable manifest, never the strict loader),
 *  - the strict shape/reference validation (the store's own parser, run while
 *    seeding its cache), and
 *  - the returned store's initial cache seed under the same fingerprint.
 *
 * A fingerprint that drifts across the read retries once and then fails
 * closed; a later external writer still invalidates the seeded cache on the
 * store's next read. Corruption surfaces as the same `StorageCompatibilityError`
 * diagnosis the classifier produced before this fast path existed.
 */
function openCurrentFileTaskStore(
  home: string,
  latest: StorageVersionState
): FileTaskStore {
  const statePath = join(home, STORAGE_STATE_FILE);
  if (!existsSync(statePath)) {
    // No state.json yet: the store's own missing-file path seeds an empty
    // state without reading anything.
    return new FileTaskStore(home);
  }
  const manifest = readStorageSchemaManifest(home);
  const snapshot = readFingerprintFencedState(statePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.raw) as unknown;
  } catch (error) {
    throw new StorageCompatibilityError(
      `Invalid state.json: state.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(parsed)) {
    throw new StorageCompatibilityError("Invalid state.json: state.json is not a JSON object.");
  }
  const inspection = inspectSnapshotVersionState(
    Object.freeze({ schemaManifest: manifest, state: parsed }),
    latest
  );
  if ("corruption" in inspection) {
    throw new StorageCompatibilityError(`Invalid state.json: ${inspection.corruption.detail}`);
  }
  try {
    return new FileTaskStore(home, {
      initialStateSnapshot: { fingerprint: snapshot.fingerprint, raw: snapshot.raw }
    });
  } catch (error) {
    if (error instanceof StorageRecordError) {
      throw new StorageCompatibilityError(`Invalid state.json: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Read `state.json` once, fenced by the same fingerprint the store's read cache
 * is keyed on. A fingerprint that changes between the before and after stat
 * means a concurrent writer is mid-update: retry once (bounded), then fail
 * closed rather than seed a store from bytes that may be torn.
 */
export function readFingerprintFencedState(
  statePath: string,
  io: {
    fingerprint?: (path: string) => string;
    read?: (path: string) => string;
  } = {}
): { raw: string; fingerprint: string } {
  const fingerprint = io.fingerprint ?? stateFileFingerprint;
  const read = io.read ?? ((path) => readFileSync(path, "utf8"));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = fingerprint(statePath);
    const raw = read(statePath);
    const after = fingerprint(statePath);
    if (before === after) return { raw, fingerprint: after };
  }
  throw new StorageCompatibilityError(
    "state.json changed while opening; a concurrent writer is updating the Home. Retry the command."
  );
}

/**
 * Eagerly prove that a compatible-old Home reaches the strict current parser.
 * Staged update/upgrade preflight uses this before any Controller or binary
 * action; ordinary commands may keep the store's normal lazy-read behavior.
 */
export function validateCompatibleFileTaskStore(
  home: string,
  options: OpenCompatibleFileTaskStoreOptions = {}
): void {
  openCompatibleFileTaskStore(home, { ...options, forceStateSource: true }).getConfig();
}

function normalizeState(
  home: string,
  raw: string,
  registry: MigrationRegistry<HomeSnapshot>,
  latest: StorageVersionState
): string {
  let state: unknown;
  try {
    state = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new StorageCompatibilityError(
      `Compatible state is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(state)) {
    throw new StorageCompatibilityError("Compatible state must be a JSON object.");
  }
  const schemaManifest = JSON.parse(
    readFileSync(join(home, STORAGE_SCHEMA_FILE), "utf8")
  ) as unknown;
  if (!isRecord(schemaManifest)) {
    throw new StorageCompatibilityError("Compatible schema manifest must be a JSON object.");
  }
  const snapshot: HomeSnapshot = { schemaManifest, state };
  const source = versionsOf(snapshot, latest);
  const normalized = loadCompatibleSnapshot({
    registry,
    source,
    latest,
    snapshot,
    inspectVersions: (candidate) => versionsOf(candidate, latest),
    validateCurrent: (candidate) => {
      if (candidate.state === null) {
        throw new StorageCompatibilityError("Compatible state unexpectedly disappeared.");
      }
      validateCurrentStorageStateSnapshot(candidate.state);
    }
  });
  return `${JSON.stringify(normalized.state)}\n`;
}

function versionsOf(
  snapshot: HomeSnapshot,
  latest: StorageVersionState
): StorageVersionState {
  const inspection = inspectSnapshotVersionState(snapshot, latest);
  if ("corruption" in inspection) {
    throw new StorageCompatibilityError(inspection.corruption.detail);
  }
  return inspection.source;
}

function describeUnsupported(
  classification: ReturnType<typeof classifyHome>["classification"]
): string {
  if (classification.verdict === "CORRUPTED") {
    return `Invalid state.json: ${classification.detail}`;
  }
  if (classification.verdict === "NEEDS_NEW_VERSION") {
    return classification.blocker.message;
  }
  return "Storage is unsupported by this Yui release.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
