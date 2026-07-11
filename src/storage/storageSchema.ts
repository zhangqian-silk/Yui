import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataError } from "../errors/cliError.js";
import { migrateStorageV0ToV1, type StorageMigration } from "./migrations/v0ToV1.js";
import { migrateStorageV1ToV2 } from "./migrations/v1ToV2.js";
import { createStorageBackup, type StorageBackupResult } from "./storageBackup.js";

export const CURRENT_STORAGE_SCHEMA_VERSION = 2;
export const STORAGE_SCHEMA_FILE = "schema.json";

export type StorageSchemaManifest = {
  schemaVersion: 1;
  storageVersion: number;
  updatedAt: string;
};

export type StorageSchemaState =
  | {
      status: "uninitialized";
      latestVersion: number;
      manifestPath: string;
    }
  | {
      status: "current";
      currentVersion: number;
      latestVersion: number;
      manifestPath: string;
    }
  | {
      status: "upgrade-required";
      currentVersion: number;
      latestVersion: number;
      manifestPath: string;
    }
  | {
      status: "unsupported";
      currentVersion: number;
      latestVersion: number;
      manifestPath: string;
    }
  | {
      status: "invalid";
      latestVersion: number;
      manifestPath: string;
      detail: string;
    };

export type StorageMigrationResult = {
  fromVersion: number | null;
  toVersion: number;
  changed: boolean;
  backup?: StorageBackupResult;
};

const migrations: StorageMigration[] = [migrateStorageV0ToV1, migrateStorageV1ToV2];

export function inspectStorageSchema(rootDir: string): StorageSchemaState {
  const manifestPath = storageSchemaFile(rootDir);
  const raw = readOptionalText(manifestPath);

  if (raw === null) {
    return {
      status: "uninitialized",
      latestVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      manifestPath
    };
  }

  const manifest = parseStorageManifest(raw);

  if (manifest === null) {
    return {
      status: "invalid",
      latestVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      manifestPath,
      detail: "invalid manifest"
    };
  }

  if (manifest.storageVersion < CURRENT_STORAGE_SCHEMA_VERSION) {
    return {
      status: "upgrade-required",
      currentVersion: manifest.storageVersion,
      latestVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      manifestPath
    };
  }

  if (manifest.storageVersion > CURRENT_STORAGE_SCHEMA_VERSION) {
    return {
      status: "unsupported",
      currentVersion: manifest.storageVersion,
      latestVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      manifestPath
    };
  }

  return {
    status: "current",
    currentVersion: manifest.storageVersion,
    latestVersion: CURRENT_STORAGE_SCHEMA_VERSION,
    manifestPath
  };
}

export function ensureStorageSchema(rootDir: string): void {
  const state = inspectStorageSchema(rootDir);

  switch (state.status) {
    case "uninitialized":
      writeStorageManifest(rootDir, CURRENT_STORAGE_SCHEMA_VERSION, new Date());
      return;
    case "current":
      return;
    case "upgrade-required":
      throw dataError(
        `Storage schema upgrade required: ${state.currentVersion} -> ${state.latestVersion}. Run \`taskmux migrate\`.`
      );
    case "unsupported":
      throw dataError(
        `Unsupported storage schema version: ${state.currentVersion}. This TaskMux supports storage schema ${state.latestVersion}.`
      );
    case "invalid":
      throw dataError(`Invalid storage schema manifest: ${state.manifestPath}.`);
  }
}

export function requireStorageSchema(rootDir: string): void {
  const state = inspectStorageSchema(rootDir);

  switch (state.status) {
    case "uninitialized":
      throw dataError("TaskMux is not initialized. Run `taskmux setup`.");
    case "current":
      return;
    case "upgrade-required":
      throw dataError(
        `Storage schema upgrade required: ${state.currentVersion} -> ${state.latestVersion}. Run \`taskmux migrate\`.`
      );
    case "unsupported":
      throw dataError(
        `Unsupported storage schema version: ${state.currentVersion}. This TaskMux supports storage schema ${state.latestVersion}.`
      );
    case "invalid":
      throw dataError(`Invalid storage schema manifest: ${state.manifestPath}.`);
  }
}

export function runStorageMigrations(rootDir: string, now = new Date()): StorageMigrationResult {
  const state = inspectStorageSchema(rootDir);

  if (state.status === "uninitialized") {
    throw dataError("TaskMux is not initialized. Run `taskmux setup`.");
  }

  if (state.status === "current") {
    return {
      fromVersion: state.currentVersion,
      toVersion: state.currentVersion,
      changed: false
    };
  }

  if (state.status === "unsupported") {
    throw dataError(
      `Unsupported storage schema version: ${state.currentVersion}. This TaskMux supports storage schema ${state.latestVersion}.`
    );
  }

  if (state.status === "invalid") {
    throw dataError(`Invalid storage schema manifest: ${state.manifestPath}.`);
  }

  const fromVersion = state.currentVersion;
  let currentVersion = state.currentVersion;
  const backup = createStorageBackup(rootDir, now);

  while (currentVersion < CURRENT_STORAGE_SCHEMA_VERSION) {
    const migration = migrations.find((item) => item.fromVersion === currentVersion);

    if (migration === undefined) {
      throw dataError(
        `No storage migration path from ${currentVersion} to ${CURRENT_STORAGE_SCHEMA_VERSION}.`
      );
    }

    migration.run(rootDir);
    currentVersion = migration.toVersion;
  }

  writeStorageManifest(rootDir, currentVersion, now);

  return {
    fromVersion,
    toVersion: currentVersion,
    changed: true,
    backup
  };
}

function writeStorageManifest(rootDir: string, storageVersion: number, now: Date): void {
  const manifest: StorageSchemaManifest = {
    schemaVersion: 1,
    storageVersion,
    updatedAt: now.toISOString()
  };

  mkdirSync(rootDir, { recursive: true });
  writeFileSync(storageSchemaFile(rootDir), `${JSON.stringify(manifest, null, 2)}\n`);
}

function storageSchemaFile(rootDir: string): string {
  return join(rootDir, STORAGE_SCHEMA_FILE);
}

function readOptionalText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function parseStorageManifest(raw: string): StorageSchemaManifest | null {
  let value: unknown;

  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const storageVersion = value.storageVersion;

  if (
    value.schemaVersion !== 1 ||
    typeof storageVersion !== "number" ||
    !Number.isInteger(storageVersion) ||
    storageVersion < 0 ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return value as StorageSchemaManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
