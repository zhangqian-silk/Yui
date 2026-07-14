import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataError } from "../errors/cliError.js";
import { assertTaskmuxHomeReady } from "./taskStore.js";

export const CURRENT_STORAGE_SCHEMA_VERSION = 3;
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

  if (manifest.storageVersion !== CURRENT_STORAGE_SCHEMA_VERSION) {
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
    case "unsupported":
      throw unsupportedStorageSchema(state.currentVersion, state.latestVersion);
    case "invalid":
      throw dataError(`Invalid storage schema manifest: ${state.manifestPath}.`);
  }
}

export function requireStorageSchema(rootDir: string): void {
  assertTaskmuxHomeReady(rootDir);
  const state = inspectStorageSchema(rootDir);

  switch (state.status) {
    case "uninitialized":
      throw dataError("TaskMux is not initialized. Run `taskmux setup`.");
    case "current":
      return;
    case "unsupported":
      throw unsupportedStorageSchema(state.currentVersion, state.latestVersion);
    case "invalid":
      throw dataError(`Invalid storage schema manifest: ${state.manifestPath}.`);
  }
}

function unsupportedStorageSchema(currentVersion: number, requiredVersion: number): ReturnType<typeof dataError> {
  return dataError(
    `Unsupported storage schema version: ${currentVersion}. This TaskMux requires storage schema ${requiredVersion}. Reinitialize TASKMUX_HOME.`
  );
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
