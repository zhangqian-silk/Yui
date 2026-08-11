import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeTextFileAtomically } from "./durableFile.js";
import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION
} from "./storageVersions.js";
import { currentRecordVersions } from "./upgrade/recordVersions.js";

// Re-export for backward compatibility with existing imports.
export { CURRENT_STORAGE_LAYOUT_VERSION, CURRENT_AGGREGATE_SCHEMA_VERSION };

export const STORAGE_SCHEMA_FILE = "schema.json";

export type StorageSchemaManifest = Readonly<{
  /** Schema version of this manifest record itself. */
  schemaVersion: 1;
  /** On-disk layout version. This is not a domain-record schema version. */
  storageVersion: number;
  aggregateSchemaVersion: number;
  /**
   * Per-record-family schema versions. The authoritative record of which record
   * families exist on disk and at what version. A map may omit a family that
   * was introduced after the persisted baseline; that omission is an older
   * record-axis state which the migration planner handles through an explicit
   * 0->1 introduction step. Unknown families or non-positive-integer versions
   * are rejected.
   */
  recordVersions: Readonly<Record<string, number>>;
  updatedAt: string;
}>;

export type StorageSchemaState =
  | Readonly<{
      status: "uninitialized";
      latestVersion: number;
      latestLayoutVersion: number;
      latestAggregateSchemaVersion: number;
      manifestPath: string;
    }>
  | Readonly<{
      status: "current";
      currentVersion: number;
      latestVersion: number;
      currentLayoutVersion: number;
      latestLayoutVersion: number;
      currentAggregateSchemaVersion: number;
      latestAggregateSchemaVersion: number;
      manifestPath: string;
    }>
  | Readonly<{
      status: "unsupported";
      incompatibleComponent: "layout" | "aggregate" | "record";
      direction: "older" | "newer";
      currentVersion: number;
      latestVersion: number;
      currentLayoutVersion: number;
      latestLayoutVersion: number;
      currentAggregateSchemaVersion: number;
      latestAggregateSchemaVersion: number;
      /** The record family that is incompatible, when `incompatibleComponent === "record"`. */
      recordFamily?: string;
      manifestPath: string;
    }>
  | Readonly<{
      status: "invalid";
      latestVersion: number;
      latestLayoutVersion: number;
      latestAggregateSchemaVersion: number;
      manifestPath: string;
      detail: string;
    }>;

export class StorageSchemaError extends Error {
  readonly code:
    | "STORAGE_UNINITIALIZED"
    | "STORAGE_SCHEMA_INVALID"
    | "STORAGE_SCHEMA_UNSUPPORTED";

  constructor(
    code: StorageSchemaError["code"],
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "StorageSchemaError";
    this.code = code;
  }
}

export function inspectStorageSchema(rootDir: string): StorageSchemaState {
  const manifestPath = join(rootDir, STORAGE_SCHEMA_FILE);
  const raw = readOptionalText(manifestPath);
  if (raw === null) {
    return {
      status: "uninitialized",
      latestVersion: CURRENT_STORAGE_LAYOUT_VERSION,
      latestLayoutVersion: CURRENT_STORAGE_LAYOUT_VERSION,
      latestAggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
      manifestPath
    };
  }

  let manifest: ParsedStorageManifest;
  try {
    manifest = parseStorageManifest(raw);
  } catch (error) {
    return {
      status: "invalid",
      latestVersion: CURRENT_STORAGE_LAYOUT_VERSION,
      latestLayoutVersion: CURRENT_STORAGE_LAYOUT_VERSION,
      latestAggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
      manifestPath,
      detail: error instanceof Error ? error.message : String(error)
    };
  }

  if (manifest.storageVersion !== CURRENT_STORAGE_LAYOUT_VERSION) {
    return {
      status: "unsupported",
      incompatibleComponent: "layout",
      direction: manifest.storageVersion < CURRENT_STORAGE_LAYOUT_VERSION ? "older" : "newer",
      currentVersion: manifest.storageVersion,
      latestVersion: CURRENT_STORAGE_LAYOUT_VERSION,
      currentLayoutVersion: manifest.storageVersion,
      latestLayoutVersion: CURRENT_STORAGE_LAYOUT_VERSION,
      currentAggregateSchemaVersion: manifest.aggregateSchemaVersion,
      latestAggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
      manifestPath
    };
  }
  if (manifest.aggregateSchemaVersion !== CURRENT_AGGREGATE_SCHEMA_VERSION) {
    return {
      status: "unsupported",
      incompatibleComponent: "aggregate",
      direction: manifest.aggregateSchemaVersion < CURRENT_AGGREGATE_SCHEMA_VERSION
        ? "older"
        : "newer",
      currentVersion: manifest.aggregateSchemaVersion,
      latestVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
      currentLayoutVersion: manifest.storageVersion,
      latestLayoutVersion: CURRENT_STORAGE_LAYOUT_VERSION,
      currentAggregateSchemaVersion: manifest.aggregateSchemaVersion,
      latestAggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
      manifestPath
    };
  }

  // Record-axis check: every current record family must be at the current
  // version. A pre-baseline manifest (no recordVersions field) is
  // treated as an older, unsupported Home — there are no fabricated historical
  // steps. A missing/unknown/invalid family inside recordVersions is a
  // structural "invalid" error (caught by the parser); an older/newer version
  // is a version "unsupported" verdict that the classifier/doctor/upgrade flow
  // maps to NEEDS_NEW_VERSION.
  const currentRecords = currentRecordVersions();
  if (manifest.recordVersions === undefined) {
    // Pre-baseline manifest: written before the recordVersions field existed.
    // Only report this when the scalar axes are already current; otherwise the
    // scalar mismatch takes precedence (it carries a more precise reason).
    if (manifest.storageVersion === CURRENT_STORAGE_LAYOUT_VERSION
      && manifest.aggregateSchemaVersion === CURRENT_AGGREGATE_SCHEMA_VERSION) {
      return {
        status: "unsupported",
        incompatibleComponent: "record",
        direction: "older",
        currentVersion: 0,
        latestVersion: 1,
        currentLayoutVersion: manifest.storageVersion,
        latestLayoutVersion: CURRENT_STORAGE_LAYOUT_VERSION,
        currentAggregateSchemaVersion: manifest.aggregateSchemaVersion,
        latestAggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
        manifestPath
      };
    }
  } else {
    for (const [kind, currentEntry] of Object.entries(currentRecords)) {
      const onDisk = manifest.recordVersions[kind];
      if (onDisk === undefined) {
        // A current family absent from the manifest's recordVersions map means
        // the Home predates that family. The persisted record axis is version 0
        // until an explicit family-introduction migration supplies it.
        return {
          status: "unsupported",
          incompatibleComponent: "record",
          direction: "older",
          currentVersion: 0,
          latestVersion: currentEntry.version,
          currentLayoutVersion: manifest.storageVersion,
          latestLayoutVersion: CURRENT_STORAGE_LAYOUT_VERSION,
          currentAggregateSchemaVersion: manifest.aggregateSchemaVersion,
          latestAggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
          recordFamily: kind,
          manifestPath
        };
      }
      if (onDisk !== currentEntry.version) {
        return {
          status: "unsupported",
          incompatibleComponent: "record",
          direction: onDisk < currentEntry.version ? "older" : "newer",
          currentVersion: onDisk,
          latestVersion: currentEntry.version,
          currentLayoutVersion: manifest.storageVersion,
          latestLayoutVersion: CURRENT_STORAGE_LAYOUT_VERSION,
          currentAggregateSchemaVersion: manifest.aggregateSchemaVersion,
          latestAggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
          recordFamily: kind,
          manifestPath
        };
      }
    }
  }

  return {
    status: "current",
    currentVersion: manifest.storageVersion,
    latestVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    currentLayoutVersion: manifest.storageVersion,
    latestLayoutVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    currentAggregateSchemaVersion: manifest.aggregateSchemaVersion,
    latestAggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    manifestPath
  };
}

export function ensureStorageSchema(rootDir: string, now = new Date()): void {
  const state = inspectStorageSchema(rootDir);
  if (state.status === "uninitialized") {
    writeStorageManifest(rootDir, now);
    return;
  }
  requireInspectedSchema(state);
}

export function requireStorageSchema(rootDir: string): void {
  requireInspectedSchema(inspectStorageSchema(rootDir));
}

function writeStorageManifest(rootDir: string, now: Date): void {
  const recordVersions: Record<string, number> = {};
  for (const [kind, entry] of Object.entries(currentRecordVersions())) {
    recordVersions[kind] = entry.version;
  }
  const manifest: StorageSchemaManifest = {
    schemaVersion: 1,
    storageVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    recordVersions,
    updatedAt: now.toISOString()
  };
  writeTextFileAtomically(
    join(rootDir, STORAGE_SCHEMA_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

function requireInspectedSchema(state: StorageSchemaState): void {
  switch (state.status) {
    case "current":
      return;
    case "uninitialized":
      throw new StorageSchemaError(
        "STORAGE_UNINITIALIZED",
        "Yui storage is not initialized. Run `yui setup`."
      );
    case "invalid":
      throw new StorageSchemaError(
        "STORAGE_SCHEMA_INVALID",
        `Invalid storage schema manifest at ${state.manifestPath}: ${state.detail}`
      );
    case "unsupported":
      throw unsupportedVersion(
        state.currentVersion,
        state.latestVersion,
        state.incompatibleComponent,
        state.recordFamily
      );
  }
}

function unsupportedVersion(
  current: number,
  required: number,
  component: "layout" | "aggregate" | "record",
  recordFamily?: string
): StorageSchemaError {
  if (component === "record" && recordFamily === undefined) {
    // Pre-baseline manifest: the recordVersions field is absent, meaning this
    // Home was written before the migration baseline existed. No historical
    // steps are fabricated; the user must reset or use a compatible release.
    return new StorageSchemaError(
      "STORAGE_SCHEMA_UNSUPPORTED",
      "This Home was created before the Yui migration baseline and cannot be migrated by this release. "
        + "Reset your Home (yui setup) or use a Yui release that supports this Home's version."
    );
  }
  const label = component === "layout"
    ? "Storage layout"
    : component === "aggregate"
      ? "Aggregate schema"
      : `Record family '${recordFamily}'`;
  if (current < required) {
    return new StorageSchemaError(
      "STORAGE_SCHEMA_UNSUPPORTED",
      `${label} ${current} is older than required ${component} version ${required}; no migration is available in this Yui release.`
    );
  }
  return new StorageSchemaError(
    "STORAGE_SCHEMA_UNSUPPORTED",
    `${label} ${current} is newer than supported ${component} version ${required}; use a newer Yui release.`
  );
}

type ParsedStorageManifest = Readonly<{
  schemaVersion: 1;
  storageVersion: number;
  aggregateSchemaVersion: number;
  /**
   * The per-family record version map. Absent in pre-baseline manifests
   * (written before the record-versions manifest field existed); callers treat
   * an absent map as a pre-baseline, unsupported Home.
   */
  recordVersions?: Readonly<Record<string, number>>;
  updatedAt: string;
}>;

function parseStorageManifest(raw: string): ParsedStorageManifest {
  const value = parseJsonObject(raw, "Storage schema manifest");
  assertKeys(
    value,
    ["schemaVersion", "storageVersion", "aggregateSchemaVersion", "updatedAt"],
    ["recordVersions"],
    "Storage schema manifest"
  );
  if (value.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (!Number.isInteger(value.storageVersion) || (value.storageVersion as number) < 1) {
    throw new Error("storageVersion must be a positive integer");
  }
  const aggregateSchemaVersion = value.aggregateSchemaVersion;
  if (!Number.isInteger(aggregateSchemaVersion) || (aggregateSchemaVersion as number) < 1) {
    throw new Error("aggregateSchemaVersion must be a positive integer");
  }
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("updatedAt must be an ISO timestamp");
  }

  // recordVersions is optional: a pre-baseline manifest omits it. When present,
  // validate it strictly (known families, positive-integer versions). When
  // absent, the caller treats the Home as pre-baseline / unsupported.
  let recordVersions: Readonly<Record<string, number>> | undefined;
  if (Object.hasOwn(value, "recordVersions")) {
    const recordVersionsRaw = value.recordVersions;
    if (!isRecord(recordVersionsRaw)) {
      throw new Error("recordVersions must be an object");
    }
    const currentRecords = currentRecordVersions();
    const actualKinds = Object.keys(recordVersionsRaw);
    const unknown = actualKinds.filter((kind) => !Object.hasOwn(currentRecords, kind));
    if (unknown.length > 0) {
      throw new Error(`recordVersions has unknown family: ${unknown[0]}`);
    }
    const parsed: Record<string, number> = {};
    for (const kind of actualKinds) {
      const version = recordVersionsRaw[kind];
      if (!Number.isInteger(version) || (version as number) < 1) {
        throw new Error(`recordVersions['${kind}'] must be a positive integer`);
      }
      parsed[kind] = version as number;
    }
    recordVersions = Object.freeze(parsed);
  }

  return {
    schemaVersion: 1,
    storageVersion: value.storageVersion as number,
    aggregateSchemaVersion: aggregateSchemaVersion as number,
    ...(recordVersions === undefined ? {} : { recordVersions }),
    updatedAt: value.updatedAt
  };
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function assertKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string
): void {
  const expected = new Set([...requiredKeys, ...optionalKeys]);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = requiredKeys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0) throw new Error(`${label} has unknown field: ${unknown[0]}`);
  if (missing.length > 0) throw new Error(`${label} is missing field: ${missing[0]}`);
}


function readOptionalText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
