import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createAgentRun, yieldAgentRun } from "../../dist/run/agentRun.js";
import { processActiveRoleRunDeliveries } from "../../dist/scheduler/activeRoleRunDelivery.js";
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
  const mailbox = store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: role.name });
  assert.equal(mailbox.processing.executionRef.type, "run");
  assert.equal(mailbox.processing.executionRef.id, run.id);
  assert.equal(mailbox.pending, null);
  assert.equal(store.getActiveAgentRun(task.id, role.name).id, run.id);
  assert.equal(store.getRole(task.id, role.name).status, "running");
  assert.equal(store.getRoleSession(task.id, role.name).nativeSessionId, "thread-1");
  assert.equal(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision, before + 1);
});

test("runtime Turn completion waits for the two-second grace deadline before closing a Leader Run", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun("agent-run-grace", task.id, role.name, "new", "continue", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "thread-grace",
      status: "ready"
    },
    now
  });

  const observed = adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-grace",
    turnId: "turn-grace",
    summary: "I forgot to yield."
  }, now);

  assert.equal(observed.pendingRunId, run.id);
  assert.equal(store.getActiveAgentRun(task.id, role.name).id, run.id);
  assert.equal(store.getRoleSession(task.id, role.name).status, "running");
  assert.deepEqual(
    adapter.resolveDueRuntimeTurnCompletions(new Date(now.getTime() + 1_999)),
    []
  );
  assert.deepEqual(
    adapter.resolveDueRuntimeTurnCompletions(new Date(now.getTime() + 2_000)),
    [run.id]
  );
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.equal(store.findAgentRun(run.id).status, "yielded");
  assert.equal(store.getRoleSession(task.id, role.name).status, "ready");
  assert.equal(store.getTaskRoleSessionSet(task.id, role.name).inFlight, null);
});

test("an explicit yield retains the Turn fence until its matching Hook arrives", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const first = createAgentRun("agent-run-first", task.id, role.name, "new", "first", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run: first,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run: first,
    session: {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "thread-first",
      status: "ready"
    },
    now
  });
  store.transaction((tx) => {
    tx.saveAgentRun(yieldAgentRun(tx.getActiveAgentRun(task.id, role.name), "done", now));
    tx.clearActiveAgentRun(task.id, role.name);
  });

  const second = createAgentRun("agent-run-second", task.id, role.name, "resume", "second", now);
  assert.throws(
    () => store.saveActiveAgentRun(second),
    /still has an in-flight Turn/u
  );

  adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-first",
    turnId: "turn-first",
    summary: "done"
  }, now);
  assert.doesNotThrow(() => store.saveActiveAgentRun(second));
});

test("generic mailbox claim and release preserve signals queued during processing", (t) => {
  const { store, task, now, adapter } = fixture(t);
  const target = { kind: "task", taskId: task.id };
  enqueueWork(store, target, "task-activated", now);

  const claim = adapter.claimWorkMailbox({
    target,
    batchId: "batch-1",
    owner: "controller",
    now
  });
  assert.equal(claim.status, "claimed");

  enqueueWork(store, target, "workspace-ready", new Date(now.getTime() + 1_000));
  assert.equal(adapter.releaseWorkMailbox(target, "batch-1"), true);
  const released = store.getWorkMailbox(target);
  assert.equal(released.processing, null);
  assert.deepEqual(released.pending.reasons, ["task-activated", "workspace-ready"]);
  assert.equal(released.pending.requestCount, 2);
});

test("Worker delivery claims and binds its mailbox before external work, then releases on failure", async (t) => {
  const { store, task, now, adapter } = fixture(t);
  const worker = createRole(
    task.id,
    "worker",
    [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
    "codex",
    "/repo",
    now
  );
  const run = createAgentRun("agent-run-worker", task.id, worker.name, "new", "work", now);
  const target = { kind: "role", taskId: task.id, roleName: worker.name };
  store.transaction((tx) => {
    tx.saveRole(task.id, worker);
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, target, "run-dispatched", now, [{ type: "run", id: run.id }]);
  });
  let observedBound = false;
  const delivery = {
    async prepareRoleSession() {
      const processing = store.getWorkMailbox(target).processing;
      observedBound = processing?.executionRef?.type === "run"
        && processing.executionRef.id === run.id;
      throw new Error("launch failed");
    },
    async waitUntilReady() { throw new Error("unexpected readiness"); },
    async sendOnce() { throw new Error("unexpected send"); },
    async inspectRole() { return "present"; },
    async stopTask() { return true; }
  };

  const [result] = await processActiveRoleRunDeliveries(adapter, delivery, now);

  assert.equal(observedBound, true);
  assert.equal(result.status, "failed");
  const released = store.getWorkMailbox(target);
  assert.equal(released.processing, null);
  assert.ok(released.pending.refs.some((ref) => ref.type === "run" && ref.id === run.id));
});

test("Worker busy retry persists and reuses the hosted native session before delivery", async (t) => {
  const { store, task, now, adapter } = fixture(t);
  const worker = createRole(
    task.id,
    "worker",
    [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
    "codex",
    "/repo",
    now
  );
  const run = createAgentRun("agent-run-worker", task.id, worker.name, "new", "work", now);
  const target = { kind: "role", taskId: task.id, roleName: worker.name };
  store.transaction((tx) => {
    tx.saveRole(task.id, worker);
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, target, "run-dispatched", now, [{ type: "run", id: run.id }]);
  });
  let sends = 0;
  const delivery = {
    async prepareRoleSession(input) {
      return { ...input, deliveryId: "delivery-worker" };
    },
    async findExistingReceipt() { return null; },
    async waitUntilReady(prepared) {
      const persisted = store.getRoleSession(task.id, worker.name)?.nativeSessionId;
      return {
        prepared,
        session: {
          agentId: worker.activeAgentId,
          adapterId: "codex",
          nativeSessionId: persisted ?? "hosted-native-b",
          status: "ready"
        }
      };
    },
    async sendOnce() { sends += 1; return sends === 1 ? "busy" : "sent"; },
    async inspectRole() { return "present"; },
    async stopTask() { return true; }
  };

  assert.equal((await processActiveRoleRunDeliveries(adapter, delivery, now))[0].reason, "not-ready");
  assert.equal(store.getRoleSession(task.id, worker.name).nativeSessionId, "hosted-native-b");
  assert.equal(store.getActiveAgentRun(task.id, worker.name).deliveredAt, undefined);

  const [retried] = await processActiveRoleRunDeliveries(adapter, delivery, now);
  assert.equal(retried.status, "delivered", retried.error);
  assert.equal(store.getRoleSession(task.id, worker.name).nativeSessionId, "hosted-native-b");
  assert.notEqual(store.getActiveAgentRun(task.id, worker.name).deliveredAt, undefined);
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
    enqueueWork(tx, { kind: "role", taskId: task.id, roleName: role.name }, "run-dispatched", now, [
      { type: "run", id: run.id }
    ]);
  });
  adapter.claimWorkMailbox({
    target: { kind: "role", taskId: task.id, roleName: role.name },
    batchId: `agent-run:${run.id}`,
    owner: "controller",
    now,
    executionRef: { type: "run", id: run.id }
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
  assert.equal(
    store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: role.name }).processing,
    null
  );
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
