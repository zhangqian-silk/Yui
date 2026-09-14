import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";

/**
 * Build an actual historical schema with unchanged fixture records.
 * Test-only: the caller owns this temporary Home and has closed every handle.
 * A table no longer present in the current fixture stays empty in the older
 * schema; changing columns requires a fixture-specific transform, not guessing.
 */
export function rebuildHistoricalFixture(home, throughVersion) {
  const path = join(home, "yui.db");
  const seed = join(home, `fixture-source-${randomUUID()}.db`);
  renameSync(path, seed);
  const db = new Database(path);
  const quote = name => `"${name.replaceAll('"', '""')}"`;
  try {
    migrateSqliteSchema(db, { mode: "apply", throughVersion });
    db.pragma("foreign_keys = OFF");
    db.prepare("ATTACH DATABASE ? AS fixture_source").run(seed);
    const sources = new Set(db.prepare("SELECT name FROM fixture_source.sqlite_master WHERE type='table'")
      .all().map(row => row.name));
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      if (name === "schema_migrations" || name.startsWith("sqlite_") || !sources.has(name)) continue;
      const table = quote(name);
      assert.deepEqual(db.prepare(`PRAGMA main.table_info(${table})`).all().map(row => row.name),
        db.prepare(`PRAGMA fixture_source.table_info(${table})`).all().map(row => row.name),
        `Historical fixture needs an explicit column transform: ${name}`);
      db.exec(`INSERT OR REPLACE INTO main.${table} SELECT * FROM fixture_source.${table}`);
    }
  } finally {
    db.close();
    rmSync(seed);
  }
}
