import { existsSync } from "node:fs";
import { join } from "node:path";

import type { HomeIdentity } from "../repository/homeIdentity.js";
import type { TaskStore } from "./taskStore.js";
import { StorageRecordError } from "./taskStore.js";
import { readSqliteHomeIdentity, SqliteTaskStore } from "./sqliteStore.js";
import { ensureStorageSchema, inspectStorageSchema } from "./storageSchema.js";

export const CURRENT_DATABASE_FILENAME = "yui.db";

/** Initialize a new Home, or open an existing Home at the exact current contract. */
export function initializeCurrentTaskStore(home: string): TaskStore {
  if (inspectStorageSchema(home).status === "uninitialized") {
    ensureStorageSchema(home);
    return new SqliteTaskStore(home);
  }
  return openCurrentTaskStore(home);
}

/** Open only the current SQLite contract. Historical Homes are never normalized. */
export function openCurrentTaskStore(home: string): SqliteTaskStore {
  const schema = inspectStorageSchema(home);
  if (schema.status !== "current") {
    throw new StorageRecordError(
      "This Home does not use the current storage contract. Preserve it for read-only history and initialize a new Home."
    );
  }
  if (!existsSync(join(home, CURRENT_DATABASE_FILENAME))) {
    throw new StorageRecordError(
      "The current Home is incomplete: yui.db is missing. Preserve it for diagnosis and initialize a new Home."
    );
  }
  return new SqliteTaskStore(home);
}

/** Read the durable identity from the one authoritative current database. */
export function readCurrentHomeIdentity(home: string): HomeIdentity {
  const schema = inspectStorageSchema(home);
  if (schema.status !== "current") {
    throw new StorageRecordError("Durable Home storage contract is not current.");
  }
  if (!existsSync(join(home, CURRENT_DATABASE_FILENAME))) {
    throw new StorageRecordError("Durable Home database is missing.");
  }
  return readSqliteHomeIdentity(home, CURRENT_DATABASE_FILENAME);
}

/** Eagerly prove that the current database reaches the strict loader. */
export function validateCurrentTaskStore(home: string): void {
  const store = openCurrentTaskStore(home);
  try {
    store.getConfig();
  } finally {
    store.close();
  }
}
