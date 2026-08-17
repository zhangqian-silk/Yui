/**
 * SQLite-backed Resource registry (Issue 10, DB-only optimal).
 *
 * When the Home is SQLite-backed (`yui.db` exists), the resource registry
 * lives in the `resource_registry` table inside the same database.  This
 * keeps GC state transactional, crash-safe, and queryable alongside the
 * aggregate — no separate JSON file to corrupt or lose.
 *
 * The registry is GC's own state: it is not part of the aggregate and never
 * participates in aggregate versioning.  The `resource_registry` table is
 * created by schema migration 8.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  RESOURCE_REGISTRY_SCHEMA_VERSION,
  type ResourceRecord,
  type ResourceRegistryState
} from "./resourceTypes.js";
import {
  emptyResourceRegistry,
  parseResourceRegistryState
} from "./resourceRegistry.js";
import { migrateSqliteSchema } from "../storage/sqliteSchema.js";

export const SQLITE_RESOURCE_REGISTRY_TABLE = "resource_registry";

/**
 * A SQLite-backed resource registry store.  Each `save` is a single
 * transaction that upserts every record and removes rows that disappeared
 * from the in-memory state, so the on-disk table always matches the state
 * the GC engine computed.
 */
export class SqliteResourceRegistry {
  readonly #db: Database.Database;

  constructor(home: string) {
    const dbPath = join(home, "yui.db");
    if (!existsSync(dbPath)) {
      throw new Error(`SQLite database not found at ${dbPath}`);
    }
    this.#db = new Database(dbPath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    this.#db.pragma("busy_timeout = 5000");
    migrateSqliteSchema(this.#db);
  }

  load(): ResourceRegistryState {
    const rows = this.#db.prepare(
      `SELECT payload FROM ${SQLITE_RESOURCE_REGISTRY_TABLE}`
    ).all() as Array<{ payload: string }>;
    if (rows.length === 0) return emptyResourceRegistry();
    const records: Record<string, ResourceRecord> = {};
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload);
      } catch {
        continue;
      }
      const state = parseResourceRegistryState({
        schemaVersion: RESOURCE_REGISTRY_SCHEMA_VERSION,
        records: { [typeof parsed === "object" && parsed !== null && "id" in parsed
          ? String((parsed as Record<string, unknown>).id)
          : ""]: parsed }
      });
      Object.assign(records, state.records);
    }
    return Object.freeze({
      schemaVersion: RESOURCE_REGISTRY_SCHEMA_VERSION,
      records: Object.freeze(records)
    });
  }

  save(state: ResourceRegistryState): void {
    const upsert = this.#db.prepare(
      `INSERT INTO ${SQLITE_RESOURCE_REGISTRY_TABLE}
         (id, kind, path, disposition, task_id, payload, created_at, updated_at)
       VALUES
         (@id, @kind, @path, @disposition, @task_id, @payload, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         path = excluded.path,
         disposition = excluded.disposition,
         task_id = excluded.task_id,
         payload = excluded.payload,
         updated_at = excluded.updated_at`
    );
    const remove = this.#db.prepare(
      `DELETE FROM ${SQLITE_RESOURCE_REGISTRY_TABLE} WHERE id = ?`
    );

    const existingRows = this.#db.prepare(
      `SELECT id FROM ${SQLITE_RESOURCE_REGISTRY_TABLE}`
    ).all() as Array<{ id: string }>;
    const existingIds = new Set(existingRows.map((row) => row.id));
    const currentIds = new Set(Object.keys(state.records));

    const tx = this.#db.transaction(() => {
      for (const record of Object.values(state.records) as ResourceRecord[]) {
        upsert.run({
          id: record.id,
          kind: record.kind,
          path: record.path,
          disposition: record.disposition,
          task_id: record.owner.taskId ?? null,
          payload: JSON.stringify(record),
          created_at: record.createdAt ?? record.updatedAt,
          updated_at: record.updatedAt
        });
      }
      for (const id of existingIds) {
        if (!currentIds.has(id)) remove.run(id);
      }
    });
    tx();
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * Detect whether a Home uses SQLite storage (yui.db exists).
 */
export function isSqliteHome(home: string): boolean {
  return existsSync(join(home, "yui.db"));
}
