import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runOperatorCommand } from "../../dist/commands/operatorCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import {
  createGlobalRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../../dist/role/role.js";
import { createAgentRun } from "../../dist/run/agentRun.js";
import { createRepository } from "../../dist/repository/repository.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";

const NOW = new Date("2026-07-19T12:00:00.000Z");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "taskmux-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const codex = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  const claude = createConfiguredAgent("claude", "claude", "claude", [], [], NOW);
  const leader = createGlobalRole(
    "leader",
    [createRoleAgentBinding(codex)],
    codex.id,
    root,
    NOW
  );
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: codex.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(codex);
    tx.saveConfiguredAgent(claude);
    tx.saveGlobalRole(leader);
  });
  const calls = { changed: [], reconcile: [], enter: [] };
  const runtime = {
    notifyStateChanged(taskId) { calls.changed.push(taskId); },
    reconcileTask(taskId) { calls.reconcile.push(taskId); },
    prepareTaskRoleEnter(input) { calls.enter.push(input); }
  };
  const options = { runtime, now: () => new Date(NOW) };
  return { root, store, calls, options };
}

function run(args, store, options) {
  const result = runTaskCommand(args, store, options);
  assert.equal(result.kind, "output");
  return result.output;
}

function createTask(store, options, title = "Plan first") {
  run(["create", title], store, options);
  return store.listTasks().at(-1);
}

test("Draft activation atomically creates one durable first Leader wake", (t) => {
  const { root, store, options } = fixture(t);
  store.saveRepository(createRepository("repo-1", "fixture", root, "main", NOW));
  run(["create", "Repository task", "--repository", "repo-1", "--base", "main"], store, options);
  const task = store.listTasks()[0];

  assert.equal(task.status, "draft");
  assert.equal(task.repositoryId, "repo-1");
  assert.equal(task.baseRef, "main");
  assert.equal(store.getRole(task.id, "leader")?.activeAgentId, "codex");
  assert.equal(store.getPendingWakeup(task.id), null);

  run(["activate", task.id], store, options);
  const first = store.getPendingWakeup(task.id);
  assert.equal(store.getTask(task.id)?.status, "active");
  assert.deepEqual(first?.reasons, ["task-created"]);
  assert.equal(first?.requestCount, 1);

  run(["activate", task.id], store, options);
  assert.deepEqual(store.getPendingWakeup(task.id), first);
});

test("invalid repository and Role options fail before mutating the aggregate", (t) => {
  const { store, options } = fixture(t);
  assert.throws(
    () => runTaskCommand(["create", "invalid", "--base", "main"], store, options),
    /requires --repository/i
  );
  assert.equal(store.listTasks().length, 0);
  const task = createTask(store, options, "Valid");
  assert.throws(
    () => runTaskCommand(["role", "add", task.id, "worker", "--agent", ""], store, options),
    /--agent is required/i
  );
  assert.equal(store.getRole(task.id, "worker"), null);
});

test("Operator submit creates a Draft and active Task messages wake its Leader", (t) => {
  const { store, options } = fixture(t);
  const created = runOperatorCommand(["submit", "Build the smallest useful workflow"], store, options);
  assert.equal(created.kind, "output");
  const task = store.listTasks()[0];
  assert.equal(task.status, "draft");
  assert.equal(store.listComments(task.id)[0].author, "operator");
  assert.equal(store.getPendingWakeup(task.id), null);

  run(["activate", task.id], store, options);
  const before = store.getPendingWakeup(task.id)?.requestCount;
  runOperatorCommand(["submit", "Continue here", "--task", task.id], store, options);
  assert.equal(store.listComments(task.id).at(-1).body, "Continue here");
  assert.equal(store.getPendingWakeup(task.id)?.requestCount, before + 1);
  assert.ok(store.getPendingWakeup(task.id)?.reasons.includes("operator-input"));
});

test("one Role has one active Run and Worker yield completes the workflow atomically", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Dispatch");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "first", "--role", "worker"], store, options);
  run(["work", "create", task.id, "second", "--role", "worker"], store, options);
  const [first, second] = store.listWorkItems(task.id);

  run(["work", "dispatch", first.id, "--input", "implement"], store, options);
  assert.throws(
    () => runTaskCommand(["work", "dispatch", second.id], store, options),
    /already has an active run/i
  );
  assert.equal(store.findWorkItem(second.id)?.status, "pending");
  const active = store.getActiveAgentRun(task.id, "worker");
  assert.equal(active?.workItemId, first.id);

  run(["run", "yield", active.id, "--summary", "implemented"], store, options);
  assert.equal(store.findAgentRun(active.id)?.status, "yielded");
  assert.equal(store.findWorkItem(first.id)?.status, "completed");
  assert.equal(store.getActiveAgentRun(task.id, "worker"), null);
  assert.equal(store.listComments(task.id).at(-1).author, "worker");
  assert.equal(store.listComments(task.id).at(-1).body, "implemented");
  assert.ok(store.getPendingWakeup(task.id)?.reasons.includes("role-result"));
});

test("Leader yield does not self-wake and preserves a wake queued while busy", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Leader work");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "coordinate"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const runRecord = store.getActiveAgentRun(task.id, "leader");
  const pending = store.getPendingWakeup(task.id);

  run(["run", "yield", runRecord.id, "--summary", "coordinated"], store, options);
  assert.deepEqual(store.getPendingWakeup(task.id), pending);
  assert.equal(store.findWorkItem(item.id)?.status, "completed");
});

test("Leader control Run without a WorkItem can yield and release the pending wake boundary", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Leader wake");
  run(["activate", task.id], store, options);
  const pending = store.getPendingWakeup(task.id);
  const leader = store.getRole(task.id, "leader");
  const controlRun = createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "leader",
    "new",
    "Review pending Task events",
    NOW
  );
  store.transaction((tx) => {
    tx.saveActiveAgentRun(controlRun);
    tx.saveRole(task.id, updateRoleStatus(leader, "running", NOW));
  });

  run(["run", "yield", controlRun.id, "--summary", "reviewed"], store, options);
  assert.equal(store.findAgentRun(controlRun.id)?.status, "yielded");
  assert.equal(store.getActiveAgentRun(task.id, "leader"), null);
  assert.equal(store.getRole(task.id, "leader")?.status, "idle");
  assert.deepEqual(store.getPendingWakeup(task.id), pending);
  assert.equal(store.listComments(task.id).at(-1).body, "reviewed");
});

test("a rejected Worker control yield rolls back all staged FileTaskStore writes", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Atomic yield");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  const worker = store.getRole(task.id, "worker");
  const invalidRun = createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "worker",
    "new",
    "invalid control run",
    NOW
  );
  store.transaction((tx) => {
    tx.saveActiveAgentRun(invalidRun);
    tx.saveRole(task.id, updateRoleStatus(worker, "running", NOW));
  });
  const beforeMessages = store.listComments(task.id);

  assert.throws(
    () => runTaskCommand(["run", "yield", invalidRun.id, "--summary", "must roll back"], store, options),
    /not a work run/i
  );
  assert.equal(store.findAgentRun(invalidRun.id)?.status, "active");
  assert.equal(store.getActiveAgentRun(task.id, "worker")?.id, invalidRun.id);
  assert.equal(store.getRole(task.id, "worker")?.status, "running");
  assert.deepEqual(store.listComments(task.id), beforeMessages);
});

test("Role bind switches the active Agent while enter remains a foreground CLI action", (t) => {
  const { store, options, calls } = fixture(t);
  const task = createTask(store, options, "Sessions");
  run(["role", "bind", task.id, "leader", "claude"], store, options);
  assert.equal(store.getRole(task.id, "leader")?.activeAgentId, "claude");
  assert.equal(store.getTaskRoleSessionSet(task.id, "leader")?.activeAgentId, "claude");

  assert.throws(
    () => runTaskCommand(["role", "enter", task.id, "leader"], store, options),
    /Draft.*activate/i
  );
  run(["activate", task.id], store, options);
  const execution = runTaskCommand(["enter", task.id], store, options);
  assert.deepEqual(execution, {
    kind: "enter",
    taskId: task.id,
    roleName: "leader",
    output: `Prepared role leader for ${task.id}\n`
  });
  assert.deepEqual(calls.enter, [{ taskId: task.id, roleName: "leader" }]);
});

test("archive fences active work and clears pending wake in one transaction", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Archive");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "unfinished"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const active = store.getActiveAgentRun(task.id, "leader");

  run(["archive", task.id], store, options);
  assert.equal(store.getTask(task.id)?.status, "archived");
  assert.equal(store.findAgentRun(active.id)?.status, "failed");
  assert.equal(store.findWorkItem(item.id)?.status, "failed");
  assert.equal(store.getActiveAgentRun(task.id, "leader"), null);
  assert.equal(store.getPendingWakeup(task.id), null);
  assert.throws(
    () => runTaskCommand(["message", "send", task.id, "too late"], store, options),
    /archived/i
  );
});

test("reconcile only requests the Controller runtime", (t) => {
  const { store, options, calls } = fixture(t);
  const task = createTask(store, options, "Reconcile");
  run(["reconcile", task.id], store, options);
  assert.deepEqual(calls.reconcile, [task.id]);
  assert.equal(store.getTask(task.id)?.status, "draft");
});
