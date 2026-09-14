import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import { createReviewRound, createTaskReviewRound, validateReviewRound } from "../../dist/review/reviewRound.js";
import { rebuildHistoricalFixture } from "../helpers/historicalHome.mjs";

test("Review scope is explicit after creation or migration without changing reviewed evidence", t => {
  const at = new Date("2026-09-14T00:00:00Z");
  const work = createReviewRound("review-round-1", "task-1", "work-item-1", "candidate-1",
    "reviewer", "leader", "a".repeat(40), at);
  const task = createTaskReviewRound("review-round-2", "task-1", "reviewer", "leader",
    { schemaVersion: 1, projects: [{ projectId: "project-1", commit: "b".repeat(40) }] }, at);
  const { scope: _scope, ...oldWork } = work;
  const home = mkdtempSync(join(tmpdir(), "yui-review-scope-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  new SqliteTaskStore(home).close();
  rebuildHistoricalFixture(home, 30);
  const db = new Database(join(home, "yui.db"));
  try {
    const insert = db.prepare("INSERT INTO review_rounds(task_id,review_round_id,status,payload,updated_at) VALUES(?,?,?,?,?)");
    for (const round of [oldWork, task]) {
      insert.run(round.taskId, round.id, round.status, JSON.stringify(round), round.createdAt);
    }
    const before = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    migrateSqliteSchema(db, { mode: "apply" });
    const rows = db.prepare("SELECT payload FROM review_rounds ORDER BY review_round_id").all();
    assert.deepEqual(validateReviewRound(JSON.parse(rows[0].payload)), { ...oldWork, scope: "work-item" });
    assert.equal(rows[1].payload, JSON.stringify(task), "Task-final candidate bytes must not change.");
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version <= 30 ORDER BY version").all(), before);
    assert.equal(work.scope, "work-item");
    assert.throws(() => validateReviewRound(oldWork), /scope/i);
  } finally { db.close(); }
});
