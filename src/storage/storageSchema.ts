import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeTextFileAtomically } from "./durableFile.js";

export const CURRENT_STORAGE_SCHEMA_VERSION = 5;
export const STORAGE_SCHEMA_FILE = "schema.json";

export type StorageSchemaManifest = Readonly<{
  schemaVersion: 1;
  storageVersion: number;
  updatedAt: string;
}>;

export type StorageMigration = Readonly<{
  fromVersion: number;
  toVersion: number;
  migrate(rootDir: string): void;
}>;

/**
 * The dispatcher is intentionally present from the first v5 release. There
 * are no v4-to-v5 migrations: v5 is a fresh authoritative storage contract.
 */
export const STORAGE_MIGRATIONS: readonly StorageMigration[] = Object.freeze([]);

export type StorageSchemaState =
  | Readonly<{
      status: "uninitialized";
      latestVersion: number;
      manifestPath: string;
    }>
  | Readonly<{
      status: "current";
      currentVersion: number;
      latestVersion: number;
      manifestPath: string;
    }>
  | Readonly<{
      status: "unsupported";
      direction: "older" | "newer";
      currentVersion: number;
      latestVersion: number;
      manifestPath: string;
    }>
  | Readonly<{
      status: "invalid";
      latestVersion: number;
      manifestPath: string;
      detail: string;
    }>;

export class StorageSchemaError extends Error {
  readonly code: "STORAGE_UNINITIALIZED" | "STORAGE_SCHEMA_INVALID" | "STORAGE_SCHEMA_UNSUPPORTED";

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
      latestVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      manifestPath
    };
  }

  try {
    const manifest = parseStorageManifest(raw);
    if (manifest.storageVersion === CURRENT_STORAGE_SCHEMA_VERSION) {
      return {
        status: "current",
        currentVersion: manifest.storageVersion,
        latestVersion: CURRENT_STORAGE_SCHEMA_VERSION,
        manifestPath
      };
    }
    return {
      status: "unsupported",
      direction: manifest.storageVersion < CURRENT_STORAGE_SCHEMA_VERSION ? "older" : "newer",
      currentVersion: manifest.storageVersion,
      latestVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      manifestPath
    };
  } catch (error) {
    return {
      status: "invalid",
      latestVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      manifestPath,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
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

export function dispatchStorageMigrations(
  rootDir: string,
  fromVersion: number,
  targetVersion = CURRENT_STORAGE_SCHEMA_VERSION,
  migrations: readonly StorageMigration[] = STORAGE_MIGRATIONS
): void {
  let current = fromVersion;
  while (current < targetVersion) {
    const migration = migrations.find((candidate) => candidate.fromVersion === current);
    if (migration === undefined || migration.toVersion <= current || migration.toVersion > targetVersion) {
      throw unsupportedVersion(current, targetVersion);
    }
    migration.migrate(rootDir);
    current = migration.toVersion;
  }
  if (current !== targetVersion) throw unsupportedVersion(current, targetVersion);
}

function writeStorageManifest(rootDir: string, now: Date): void {
  const manifest: StorageSchemaManifest = {
    schemaVersion: 1,
    storageVersion: CURRENT_STORAGE_SCHEMA_VERSION,
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
        "TaskMux storage is not initialized. Run `taskmux setup`."
      );
    case "invalid":
      throw new StorageSchemaError(
        "STORAGE_SCHEMA_INVALID",
        `Invalid storage schema manifest at ${state.manifestPath}: ${state.detail}`
      );
    case "unsupported":
      throw unsupportedVersion(state.currentVersion, state.latestVersion);
  }
}

function unsupportedVersion(current: number, required: number): StorageSchemaError {
  if (current < required) {
    return new StorageSchemaError(
      "STORAGE_SCHEMA_UNSUPPORTED",
      `Storage schema ${current} is older than required schema ${required}; no migration is available in this TaskMux release.`
    );
  }
  return new StorageSchemaError(
    "STORAGE_SCHEMA_UNSUPPORTED",
    `Storage schema ${current} is newer than supported schema ${required}; use a newer TaskMux release.`
  );
}

function parseStorageManifest(raw: string): StorageSchemaManifest {
  const value = parseJsonObject(raw, "Storage schema manifest");
  assertExactKeys(value, ["schemaVersion", "storageVersion", "updatedAt"], "Storage schema manifest");
  if (value.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (!Number.isInteger(value.storageVersion) || (value.storageVersion as number) < 1) {
    throw new Error("storageVersion must be a positive integer");
  }
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("updatedAt must be an ISO timestamp");
  }
  return value as StorageSchemaManifest;
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

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
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
