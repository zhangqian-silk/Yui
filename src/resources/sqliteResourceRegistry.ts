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
 * created by the current SQLite baseline.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import Database from "better-sqlite3";

import { migrateSqliteSchema } from "../storage/sqliteSchema.js";
import {
  emptyResourceRegistry,
  parseResourceRegistryState
} from "./resourceRegistry.js";
import {
  RESOURCE_REGISTRY_SCHEMA_VERSION,
  type ResourceRecord,
  type ResourceRegistryState
} from "./resourceTypes.js";

export const SQLITE_RESOURCE_REGISTRY_TABLE = "resource_registry";

/**
 * Each save applies only the caller's delta. Unrelated registrations survive;
 * a changed same-record snapshot fails closed instead of overwriting ownership.
 */
export class SqliteResourceRegistry {
  readonly #db: Database.Database;

  constructor(home: string) {
    const dbPath = join(home, "yui.db");
    if (!existsSync(dbPath)) {
      throw new Error(`SQLite database not found at ${dbPath}`);
    }
    this.#db = new Database(dbPath);
    try {
      this.#db.pragma("journal_mode = WAL");
      this.#db.pragma("foreign_keys = ON");
      this.#db.pragma("busy_timeout = 5000");
      migrateSqliteSchema(this.#db, { mode: "validate" });
    } catch (error) {
      this.#db.close();
      throw error;
    }
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
      } catch (error) {
        throw new Error(
          `SQLite resource registry has a corrupt payload: `
            + `${error instanceof Error ? error.message : "unknown error"}.`,
          { cause: error }
        );
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

  save(state: ResourceRegistryState, previous: ResourceRegistryState): void {
    const next = parseResourceRegistryState(state);
    const before = parseResourceRegistryState(previous);
    const ids = [...new Set([...Object.keys(before.records), ...Object.keys(next.records)])]
      .filter(id => !isDeepStrictEqual(before.records[id], next.records[id]));
    if (ids.length === 0) return;
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

    const tx = this.#db.transaction(() => {
      const read = this.#db.prepare(`SELECT payload FROM ${SQLITE_RESOURCE_REGISTRY_TABLE} WHERE id = ?`);
      for (const id of ids) {
        const row = read.get(id) as { payload: string } | undefined;
        const current = row === undefined ? undefined : parseResourceRegistryState({
          schemaVersion: RESOURCE_REGISTRY_SCHEMA_VERSION,
          records: { [id]: JSON.parse(row.payload) }
        }).records[id];
        if (!isDeepStrictEqual(current, before.records[id])) {
          throw new Error(`Resource registry record changed since inspection: ${id}. Inspect and retry.`);
        }
      }
      for (const id of ids) {
        const record = next.records[id];
        if (record === undefined) {
          remove.run(id);
          continue;
        }
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
    });
    tx.immediate();
  }

  close(): void {
    this.#db.close();
  }
}
