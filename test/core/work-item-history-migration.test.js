import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import { createTask } from "../../dist/task/task.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { rebuildHistoricalFixture } from "../helpers/historicalHome.mjs";

test("old WorkItem execution state becomes audit evidence without changing current work or reusing event ids", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-work-history-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const at = new Date("2026-09-15T00:00:00Z");
  const store = new SqliteTaskStore(home);
  const item = createWorkItem("work-item-1", "task-1", { title: "Original work", objective: "Keep current scope" }, at);
  const existing = createTaskEvent("event-8", "task-1", "work.created", { workItemId: item.id }, at);
  try {
    store.saveTask(createTask("task-1", "Preserve history", at));
    store.saveWorkItem("task-1", item);
    store.saveEvent("task-1", existing);
  } finally { store.close(); }
  rebuildHistoricalFixture(home, 31);
  const old = { ...item, historicalState: { status: "running", outcome: "Original diagnostic" } };
  const db = new Database(join(home, "yui.db"));
  try {
    db.prepare("UPDATE work_items SET payload=? WHERE task_id=? AND work_item_id=?")
      .run(JSON.stringify(old), item.taskId, item.id);
    db.prepare("UPDATE id_sequences SET high_water=2 WHERE task_id=? AND kind='event'").run(item.taskId);
    const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    db.prepare("UPDATE work_items SET payload=?").run(JSON.stringify({ ...old, historicalState: { status: "unknown-shape" } }));
    assert.throws(() => migrateSqliteSchema(db, { mode: "apply" }), /Invalid historical WorkItem/);
    assert.equal(JSON.parse(db.prepare("SELECT payload FROM work_items").get().payload).historicalState.status, "unknown-shape");
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), ledger);
    db.prepare("UPDATE work_items SET payload=?").run(JSON.stringify(old));
    migrateSqliteSchema(db, { mode: "apply" });
    assert.deepEqual(JSON.parse(db.prepare("SELECT payload FROM work_items").get().payload), item);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version <= 31 ORDER BY version").all(), ledger);
  } finally { db.close(); }
  const current = new SqliteTaskStore(home);
  try {
    assert.deepEqual(current.getWorkItem(item.taskId, item.id), item);
    const events = current.listEvents(item.taskId);
    assert.deepEqual(events[0], existing);
    assert.equal(events[1].id, "event-9");
    assert.equal(events[1].type, "work-item.execution-state-retired");
    assert.equal(events[1].payload.record, JSON.stringify(old));
    assert.equal(current.nextEventId(item.taskId), "event-10");
    assert.throws(() => current.saveWorkItem(item.taskId, old), /historicalState/);
    assert.equal(current.listRuns(item.taskId).length, 0);
  } finally { current.close(); }
});
