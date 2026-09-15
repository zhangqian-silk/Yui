import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { createTask, setTaskActivationRequest } from "../../dist/task/task.js";
import { createTaskActivationRequest, validateTaskActivationRequest } from "../../dist/task/taskActivation.js";
import { admitStoredTaskActivation } from "../../dist/task/taskActivationService.js";
import { createTaskMessage, validateTaskMessage } from "../../dist/message/message.js";
import { rebuildHistoricalFixture } from "../helpers/historicalHome.mjs";
import { runControllerSchedulerPass } from "../../dist/controller/controller.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";

const at = new Date("2026-09-15T00:00:00Z");

test("input cutover preserves original evidence and blocks a pending request that was not auto-adoptable", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-input-contract-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const request = createTaskActivationRequest("task-1", {
    requestId: "keep-intent", actorId: "user:local", authorityRef: "user:local",
    startMode: "immediate", environmentPlan: { kind: "empty" }
  }, at);
  const task = setTaskActivationRequest(createTask("task-1", "Keep pending authority", at), request, at);
  const store = new SqliteTaskStore(home);
  try {
    store.saveTask(task);
    for (const id of ["message-1", "message-2"]) {
      store.saveMessage(task.id, createTaskMessage(id, task.id, id, "user", { type: "user" }, at));
    }
  } finally { store.close(); }
  rebuildHistoricalFixture(home, 33);
  const db = new Database(join(home, "yui.db"));
  let originalTask;
  let originals;
  try {
    db.exec(`UPDATE messages SET payload=json_remove(payload,'$.intent');
      UPDATE messages SET payload=json_set(payload,'$.wakePolicy','none') WHERE message_id='message-1';
      INSERT INTO id_sequences(task_id,kind,high_water) VALUES('task-1','event',70)
        ON CONFLICT(task_id,kind) DO UPDATE SET high_water=70;`);
    originals = db.prepare("SELECT payload FROM messages ORDER BY seq").all().map(row => row.payload);
    const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    for (const mode of ["dry-run", "update-preflight"]) {
      const result = await runStorageUpgrade({ home, mode });
      assert.equal(result.outcome, "blocked");
      assert.match(result.message, /origin-less pending request: task-1/);
      assert.equal(result.sceneUnchanged, true);
    }
    assert.throws(() => migrateSqliteSchema(db, { mode: "apply" }), /origin-less pending request/);
    assert.deepEqual(db.prepare("SELECT payload FROM messages ORDER BY seq").all().map(row => row.payload), originals);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), ledger);
    db.exec("UPDATE task_records SET payload=json_set(payload,'$.executionGate.state','disabled')");
    assert.equal((await runStorageUpgrade({ home, mode: "update-preflight" })).outcome, "blocked",
      "Stopping execution cannot authorize a formerly manual-only request after upgrade.");
    // Independent v33 representation of an explicitly admitted request.
    originalTask = JSON.stringify({ ...task, activationRequest: { ...request, origin: "explicit" } });
    db.prepare("UPDATE task_records SET payload=? WHERE task_id=?").run(originalTask, task.id);
    db.exec("UPDATE messages SET payload=json_set(payload,'$.wakePolicy','unknown') WHERE message_id='message-2'");
    assert.throws(() => migrateSqliteSchema(db, { mode: "apply" }), /Invalid historical Message/);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), ledger);
    assert.equal(db.prepare("SELECT count(*) AS total FROM events").get().total, 0,
      "A failed cutover must roll back earlier audit writes in the same migration.");
    db.prepare("UPDATE messages SET payload=? WHERE message_id='message-2'").run(originals[1]);
    migrateSqliteSchema(db, { mode: "apply" });
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version<=33 ORDER BY version").all(), ledger);
  } finally { db.close(); }
  const current = new SqliteTaskStore(home);
  try {
    const messages = current.listMessages(task.id);
    assert.deepEqual(messages.map(message => message.intent), ["record", "discuss"]);
    assert.ok(messages.every(message => !Object.hasOwn(message, "wakePolicy")));
    assert.deepEqual(current.getTask(task.id), task);
    assert.equal(admitStoredTaskActivation(current, task.id).disposition, "ready");
    const events = current.listEvents(task.id);
    assert.deepEqual(events.filter(event => event.type === "message.input-contract-retired")
      .map(event => event.payload.record), originals);
    assert.equal(events.find(event => event.type === "task.activation-origin-retired").payload.record, originalTask);
    assert.ok(Number(current.nextEventId(task.id).slice(6)) > 73);
    assert.throws(() => validateTaskMessage({ ...messages[0], wakePolicy: "none" }), /retired/);
    assert.throws(() => validateTaskMessage({ ...messages[0], intent: undefined }), /intent is required/);
    assert.throws(() => validateTaskActivationRequest({ ...request, origin: "explicit" }), /retired/);
  } finally { current.close(); }
});

test("current activation trusts admitted requests but still honors planning deferral and cancellation", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-current-activation-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  try {
    const request = createTaskActivationRequest("task-1", {
      requestId: "deferred", actorId: "task:task-1/role:leader", authorityRef: "fixture:planning",
      startMode: "after-planning-turn", afterPlanningRun: "run-1", environmentPlan: { kind: "empty" }
    }, at);
    store.saveTask(setTaskActivationRequest(createTask("task-1", "Wait for planning", at), request, at));
    const reader = { getTask: id => store.getTask(id), getRun: () => ({ status: "active" }) };
    assert.equal(admitStoredTaskActivation(reader, "task-1").disposition, "deferred");
    reader.getRun = () => ({ status: "completed" });
    assert.equal(admitStoredTaskActivation(reader, "task-1").disposition, "ready");
    store.saveTask({ ...store.getTask("task-1"), activationRequest: { ...request, disposition: "cancelled" } });
    assert.equal(admitStoredTaskActivation(reader, "task-1").disposition, "settled");
    let adopted = 0;
    const pass = () => runControllerSchedulerPass(new FileSchedulerStoreAdapter(store), {
      inspectRole: async () => "absent",
      prepareRoleSession: async () => assert.fail("No Provider should be launched by this fixture.")
    }, at, {
      prepareTaskWorkspace: async () => {},
      activateTaskWorkspace: async id => { assert.equal(id, "task-1"); adopted++; }
    }, { kind: "full" }, false);
    await pass();
    assert.equal(adopted, 0, "The Controller must not revive a cancelled request.");
    store.saveTask({ ...store.getTask("task-1"), activationRequest: {
      ...createTaskActivationRequest("task-1", {
        requestId: "current-immediate", actorId: "user:local", authorityRef: "user:local",
        startMode: "immediate", environmentPlan: { kind: "empty" }
      }, at)
    } });
    await pass();
    assert.equal(adopted, 1, "The current Controller continues an admitted request without an origin gate.");
  } finally { store.close(); }
});
