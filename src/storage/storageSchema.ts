import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeTextFileAtomically } from "./durableFile.js";
import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION
} from "./storageVersions.js";
import { currentRecordVersions } from "./upgrade/recordVersions.js";

export { CURRENT_STORAGE_LAYOUT_VERSION, CURRENT_AGGREGATE_SCHEMA_VERSION };
export const STORAGE_SCHEMA_FILE = "schema.json";

export type StorageSchemaManifest = Readonly<{
  /** Schema version of this manifest record itself. */
  schemaVersion: 1;
  /** On-disk layout version. This is not a domain-record schema version. */
  storageVersion: number;
  aggregateSchemaVersion: number;
  /** Authoritative persisted version for each record family known to this Home. */
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

  const currentRecords = currentRecordVersions();
  if (manifest.recordVersions === undefined) {
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
  for (const [kind, currentEntry] of Object.entries(currentRecords)) {
    const persisted = manifest.recordVersions[kind];
    if (persisted === undefined) {
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
    if (persisted !== currentEntry.version) {
      return {
        status: "unsupported",
        incompatibleComponent: "record",
        direction: persisted < currentEntry.version ? "older" : "newer",
        currentVersion: persisted,
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
    writeCurrentStorageManifest(rootDir, now);
    return;
  }
  requireInspectedSchema(state);
}

export function requireStorageSchema(rootDir: string): void {
  requireInspectedSchema(inspectStorageSchema(rootDir));
}

/**
 * Compatible readers may bypass only a record-axis mismatch. Layout,
 * aggregate, syntax, and initialization remain strict.
 */
export function requireCompatibleStorageSchema(rootDir: string): void {
  const state = inspectStorageSchema(rootDir);
  if (state.status === "current") return;
  if (state.status === "unsupported"
    && state.incompatibleComponent === "record"
    && state.direction === "older") return;
  requireInspectedSchema(state);
}

/** Persist the current three-axis manifest through the existing atomic-file seam. */
export function writeCurrentStorageManifest(rootDir: string, now = new Date()): void {
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
    return new StorageSchemaError(
      "STORAGE_SCHEMA_UNSUPPORTED",
      "This Home predates the durable record-version manifest and cannot be opened without explicit introduction migrations."
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

export type ParsedStorageManifest = Readonly<{
  schemaVersion: 1;
  storageVersion: number;
  aggregateSchemaVersion: number;
  recordVersions?: Readonly<Record<string, number>>;
  updatedAt: string;
}>;

function parseStorageManifest(raw: string): ParsedStorageManifest {
  const value = parseJsonObject(raw, "Storage schema manifest");
  return parseStorageSchemaManifest(value);
}

/** Strictly parse one already-decoded manifest object through the shared contract. */
export function parseStorageSchemaManifest(value: unknown): ParsedStorageManifest {
  if (!isRecord(value)) throw new Error("Storage schema manifest must be an object");
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
  let recordVersions: Readonly<Record<string, number>> | undefined;
  if (Object.hasOwn(value, "recordVersions")) {
    if (!isRecord(value.recordVersions)) throw new Error("recordVersions must be an object");
    const known = currentRecordVersions();
    const kinds = Object.keys(value.recordVersions);
    const unknown = kinds.filter((kind) => !Object.hasOwn(known, kind));
    if (unknown.length > 0) {
      throw new Error(`recordVersions has unknown family: ${unknown[0]}`);
    }
    const parsed: Record<string, number> = {};
    for (const kind of kinds) {
      const version = value.recordVersions[kind];
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

/** Read and strictly parse the durable manifest through the same contract. */
export function readStorageSchemaManifest(rootDir: string): ParsedStorageManifest {
  return parseStorageManifest(readFileSync(join(rootDir, STORAGE_SCHEMA_FILE), "utf8"));
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
