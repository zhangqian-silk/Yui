import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRun } from "../../dist/agentRun/agentRun.js";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { processActiveRoleRunDeliveries } from "../../dist/scheduler/activeRoleRunDelivery.js";
import { buildTaskExecutionProjection } from "../../dist/scheduler/taskExecutionProjection.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { AgentRuntimeObserver } from "../../dist/controller/agentRuntimeObserver.js";
import { runConfigCommand } from "../../dist/commands/configCommands.js";

test("missing authoritative reads cannot become empty evidence or authorize Provider delivery", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-strict-store-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const at = new Date("2026-09-15T00:00:00Z");
  const task = activateTask(createTask("task-1", "Keep delivery authority", at), at);
  store.saveTask(task);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(task.id, "leader", [binding], binding.agentId, home, at);
  store.saveRole(task.id, role);
  const run = createRun("run-1", task.id, role.name, "new", createRunInput({
    source: { type: "yui", channel: "task-dispatch" }, directive: "Original intent", deltaRefIds: []
  }), at, { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) });
  store.saveActiveRun(run);
  const adapter = new FileSchedulerStoreAdapter(store);
  let prepared = 0;
  const delivery = { prepareRoleSession: async () => { prepared++; throw new Error("Unexpected provider preparation"); } };
  adapter.getTaskRoleSessionSet = undefined;
  const outcome = await processActiveRoleRunDeliveries(adapter, delivery, at)
    .then(value => ({ value }), error => ({ error }));
  assert.equal(prepared, 0, "A missing reader must not reach Provider preparation.");
  assert.match(outcome.error?.message ?? "", /getTaskRoleSessionSet/);
  assert.equal(store.getActiveRun(task.id, role.name).id, run.id);
  const events = store.listEvents;
  store.listEvents = undefined;
  try { assert.throws(() => buildTaskExecutionProjection(store, task.id), /listEvents/); }
  finally { store.listEvents = events; }
  let saved = false;
  assert.throws(() => enqueueWork({
    getWorkMailbox: () => null, saveWorkMailbox: () => { saved = true; }
  }, { kind: "task", taskId: task.id }, "user-message", at), /getTask/);
  assert.equal(saved, false, "Missing archive authority cannot admit a queued signal.");
  await assert.rejects(new AgentRuntimeObserver({
    listTasks: () => assert.fail("A missing hot-set index must not select the full-scan path.")
  }, {}).sample(at), /listActiveTaskIds/);
  const config = store.getConfig();
  const getAgent = store.getConfiguredAgent;
  store.getConfiguredAgent = undefined;
  try {
    assert.throws(() => runConfigCommand("system", ["set", "default-agent", "missing"], store), /getConfiguredAgent/);
    assert.deepEqual(store.getConfig(), config, "Missing Agent evidence cannot authorize config mutation.");
  } finally { store.getConfiguredAgent = getAgent; }
});
