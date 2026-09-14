import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createRole, createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet, validateRoleSessionSet } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createRun, completeRun } from "../../dist/agentRun/agentRun.js";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { rebuildHistoricalFixture } from "../helpers/historicalHome.mjs";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { createWorkMailbox, enqueueSignal, claimPending } from "../../dist/coordination/workMailbox.js";

test("notification migration preserves delivery and history while refusing live Run links", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-notification-migration-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const at = new Date("2026-09-14T00:00:00Z");
  const store = new SqliteTaskStore(home);
  let run;
  try {
    const task = activateTask(createTask("task-1", "Keep original work", at, { cwd: home }), at);
    store.saveTask(task);
    const agent = createConfiguredAgent("codex", "codex", "codex", [], [], at);
    const binding = createRoleAgentBinding(agent);
    store.saveConfiguredAgent(agent);
    const role = createRole(task.id, "leader", [binding], agent.id, home, at);
    store.saveRole(task.id, role);
    store.saveGlobalRole(createGlobalRole("operator", [binding], agent.id, home, at));
    store.saveGlobalRoleSessionSet(createRoleSessionSet({ scope: "global", roleName: "operator" }, agent.id, at));
    run = createRun("run-1", task.id, role.name, "new", createRunInput({
      source: { type: "yui", channel: "task-dispatch" }, directive: "Original execution", deltaRefIds: []
    }), at, { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) });
    store.saveActiveRun(run);
  } finally { store.close(); }
  rebuildHistoricalFixture(home, 29);
  const oldWake = {
    schemaVersion: 1, id: "wake-1", taskId: "task-1", seq: 1,
    reasons: ["execution-started"], runId: run.id, status: "dispatched",
    fromCursor: at.toISOString(), toCursor: at.toISOString(), createdAt: at.toISOString()
  };
  const notification = {
    schemaVersion: 1, id: "wake-2", taskId: "task-1", seq: 2, refs: [],
    reasons: ["user-message"], status: "consumed", consumedAt: at.toISOString(),
    fromCursor: at.toISOString(), toCursor: at.toISOString(), createdAt: at.toISOString()
  };
  const db = new Database(join(home, "yui.db"));
  const terminal = completeRun(run, "Original terminal evidence", at);
  try {
    db.exec("UPDATE global_role_session_sets SET payload=json_remove(payload, '$.providerBinding')");
    for (const wake of [oldWake, notification]) {
      db.prepare(`INSERT INTO task_wakes(task_id,wake_id,seq,status,turn_id,from_cursor,to_cursor,reasons,payload,created_at,consumed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(wake.taskId, wake.id, wake.seq, wake.status, wake.runId ?? null,
        wake.fromCursor, wake.toCursor, JSON.stringify(wake.reasons), JSON.stringify(wake), wake.createdAt, wake.consumedAt ?? null);
    }
    db.prepare("INSERT INTO id_sequences(task_id,kind,high_water) VALUES('task-1','taskWake',2)").run();
    const before = db.prepare("SELECT * FROM task_wakes").all();
    for (const mode of ["dry-run", "update-preflight"]) {
      const result = await runStorageUpgrade({ home, mode });
      assert.equal(result.outcome, "blocked");
      assert.equal(result.stage, "in-flight");
      assert.match(result.message, /task-1\/wake-1/);
      assert.equal(result.sceneUnchanged, true);
    }
    assert.throws(() => migrateSqliteSchema(db, { mode: "apply" }), /Run-linked wake still owns unsettled input/);
    assert.deepEqual(db.prepare("SELECT * FROM task_wakes").all(), before);
    assert.equal(db.prepare("SELECT max(version) AS version FROM schema_migrations").get().version, 29);
    db.prepare("UPDATE turns SET status=?,payload=? WHERE task_id=? AND turn_id=?")
      .run(terminal.status, JSON.stringify(terminal), run.taskId, run.id);
    db.prepare("DELETE FROM active_turns WHERE task_id=?").run(run.taskId);
    const claimed = claimPending(enqueueSignal(createWorkMailbox({
      kind: "role", taskId: run.taskId, roleName: "leader"
    }), { reason: "user-message", occurredAt: at.toISOString(), refs: [] }), {
      batchId: "notification:task-1/wake-1/unconfirmed", owner: "leader-notification:wake-1",
      startedAt: at.toISOString()
    });
    db.prepare(`INSERT INTO mailboxes(target_kind,task_id,role_name,target_key,next_sequence,processing,pending,recent_dedupe_keys)
      VALUES('role','task-1','leader','role/task-1/leader',?,?,NULL,'[]')`)
      .run(claimed.nextSequence, JSON.stringify(claimed.processing));
    assert.throws(() => migrateSqliteSchema(db, { mode: "apply" }), /unsettled input/,
      "An unknown notification claim must remain resolvable before its wake retires.");
    db.prepare("DELETE FROM mailboxes WHERE target_key='role/task-1/leader'").run();
    migrateSqliteSchema(db, { mode: "apply" });
    assert.equal(db.prepare("PRAGMA table_info(task_wakes)").all().some(column => column.name === "turn_id"), false);
  } finally { db.close(); }
  const current = new SqliteTaskStore(home);
  try {
    assert.deepEqual(current.getRun(run.taskId, run.id), terminal);
    assert.deepEqual(current.listTaskWakes(run.taskId), [{ ...notification, schemaVersion: 2 }]);
    assert.equal(current.nextTaskWakeId(run.taskId), "wake-3", "Retirement must not reuse a historical wake identity.");
    const audit = current.listEvents(run.taskId).filter(event => event.type === "wake.run-link-retired");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].payload.record, JSON.stringify(oldWake));
    const global = validateRoleSessionSet(current.getGlobalRoleSessionSet("operator"));
    assert.equal(global.providerBinding, null);
    assert.throws(() => current.saveTaskWake(run.taskId, { ...notification, schemaVersion: 2, runId: run.id }), /Run-backed/);
  } finally { current.close(); }
});
