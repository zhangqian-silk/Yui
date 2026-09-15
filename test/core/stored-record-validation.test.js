import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask } from "../../dist/task/task.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { validateCurrentTaskStore } from "../../dist/storage/currentTaskStore.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { getDoctorChecks } from "../../dist/doctor/doctor.js";

test("current record validation rejects invalid writes, reads and current-Home health checks", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-record-validation-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  const at = new Date("2026-09-15T12:00:00Z");
  const message = createTaskMessage("message-1", "task-1", "Original input", "user", { type: "user" }, at);
  try {
    store.saveTask(createTask("task-1", "Current records", at));
    const revision = store.getRevision();
    assert.throws(() => store.saveMessage("task-1", { ...message, schemaVersion: 999 }), /Message|messages/);
    assert.equal(store.getRevision(), revision);
    assert.deepEqual(store.listMessages("task-1"), []);
    store.saveMessage("task-1", message);
    assert.throws(() => store.updateMessage("task-1", { ...message, intent: undefined }), /intent|messages/);
    assert.deepEqual(store.listMessages("task-1"), [message]);
  } finally { store.close(); }
  const db = new Database(join(home, "yui.db"));
  try { db.exec("UPDATE messages SET payload=json_set(payload,'$.schemaVersion',999)"); }
  finally { db.close(); }
  const invalid = new SqliteTaskStore(home);
  try {
    assert.throws(() => invalid.listMessages("task-1"), /Message|messages/);
    assert.throws(() => invalid.queryContextRecords("task-1", { family: "task-message", limit: 1 }), /Message|messages/);
  }
  finally { invalid.close(); }
  assert.throws(() => validateCurrentTaskStore(home), /Message|messages/);
  const check = await runStorageUpgrade({ home, mode: "dry-run" });
  assert.equal(check.outcome, "blocked");
  assert.equal(check.stage, "corruption");
  assert.equal(check.sceneUnchanged, true);
  const doctor = getDoctorChecks({ HOME: home, YUI_HOME: home, CODEX_HOME: home }, { run: () => "fixture" });
  assert.equal(doctor.find(check => check.name === "storage state").status, "invalid");
});
