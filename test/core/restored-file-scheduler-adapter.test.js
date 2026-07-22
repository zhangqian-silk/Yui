import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createAgentRun } from "../../dist/run/agentRun.js";
import { queueLeaderWakeup } from "../../dist/scheduler/wakeupQueue.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, archiveTask, createTask } from "../../dist/task/task.js";
import { createWorkItem, updateWorkItemStatus } from "../../dist/workItem/workItem.js";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-scheduler-store-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const now = new Date("2026-07-19T00:00:00.000Z");
  const task = activateTask(createTask("task-1", "Run workflow", now), now);
  const role = createRole(
    task.id,
    "leader",
    [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
    "codex",
    home,
    now
  );
  store.transaction((tx) => {
    tx.saveTask(task);
    tx.saveRole(task.id, role);
    queueLeaderWakeup(tx, task.id, "task-created", now);
  });
  return { home, store, task, role, now, adapter: new FileSchedulerStoreAdapter(store) };
}

test("FileSchedulerStoreAdapter commits Leader run, Role and fixed session together", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const before = JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision;
  const run = createAgentRun("agent-run-1", task.id, role.name, "resume", "continue", now);

  const result = adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "thread-1",
      status: "ready"
    },
    wakeup: store.getPendingWakeup(task.id),
    now
  });

  assert.equal(result, "claimed");
  assert.equal(store.getPendingWakeup(task.id), null);
  assert.equal(store.getActiveAgentRun(task.id, role.name).id, run.id);
  assert.equal(store.getRole(task.id, role.name).status, "running");
  assert.equal(store.getRoleSession(task.id, role.name).nativeSessionId, "thread-1");
  assert.equal(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision, before + 1);
});

test("runtime native session registration is structured and exited work fails atomically", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const registered = adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, now);
  assert.equal(registered.nativeSessionId, "thread-1");

  const item = updateWorkItemStatus(createWorkItem(
    "work-item-1",
    task.id,
    { title: "Implement", assignee: role.name },
    now
  ), "running", undefined, now);
  const run = createAgentRun(
    "agent-run-1",
    task.id,
    role.name,
    "resume",
    "work",
    now,
    { workItemId: item.id }
  );
  store.transaction((tx) => {
    tx.saveWorkItem(task.id, item);
    tx.saveActiveAgentRun(run);
  });

  adapter.saveExitedRoleRun({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: adapter.getRoleSession(task.id, role.name),
    summary: "tmux exited",
    now
  });

  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.equal(store.getWorkItem(task.id, item.id).status, "failed");
  assert.equal(store.getRole(task.id, role.name).status, "exited");
  assert.equal(store.getRoleSession(task.id, role.name).status, "stopped");
});

test("reconfirming an already delivered active run does not rewrite authoritative state", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun(
    "agent-run-1",
    task.id,
    role.name,
    "new",
    "work",
    now,
    { workItemId: "work-item-1" }
  );
  run.deliveredAt = now.toISOString();
  store.transaction((tx) => {
    tx.saveRole(task.id, { ...role, status: "running" });
    tx.saveActiveAgentRun(run);
  });
  const before = JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision;

  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    now: new Date(now.getTime() + 1_000)
  });

  assert.equal(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision, before);
});

test("a late Codex notify cannot reactivate a session after Task archive", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  store.saveTask(archiveTask(task, new Date(now.getTime() + 1_000)));

  assert.throws(() => adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "late-thread"
  }), /archived Task/);
  assert.equal(store.getRoleSession(task.id, role.name), null);
});
