import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runJobCommand } from "../../dist/commands/jobCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";

const NOW = new Date("2026-07-19T15:00:00.000Z");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "taskmux-jobs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(agent);
    tx.saveGlobalRole(createGlobalRole(
      "leader",
      [createRoleAgentBinding(agent)],
      agent.id,
      root,
      NOW
    ));
  });
  const changed = [];
  const runtime = {
    notifyStateChanged(taskId) { changed.push(taskId); },
    reconcileTask() {},
    prepareTaskRoleEnter() {}
  };
  const options = { runtime, now: () => new Date(NOW) };
  const created = runTaskCommand(["create", "Recover leader"], store, options);
  assert.equal(created.kind, "output");
  const task = store.listTasks()[0];
  runTaskCommand(["activate", task.id], store, options);
  return { store, task, runtime, changed };
}

function saveRecovery(store, taskId) {
  store.transaction((tx) => {
    tx.saveLeaderFailure({
      schemaVersion: 1,
      taskId,
      nativeSessionId: "native-1",
      message: "resume failed",
      attemptCount: 2,
      firstFailedAt: NOW.toISOString(),
      lastFailedAt: NOW.toISOString()
    });
    tx.saveOperatorNotification({
      schemaVersion: 1,
      taskId,
      type: "leader-recovery-failed",
      message: "Leader needs recovery",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString()
    });
  });
}

test("jobs list presents pending wakeups and Leader recovery with stable ids", (t) => {
  const { store, task } = fixture(t);
  saveRecovery(store, task.id);

  const output = runJobCommand(["list"], store);
  assert.match(output, new RegExp(`leader-wakeup:${task.id}`));
  assert.match(output, new RegExp(`leader-recovery:${task.id}`));
  assert.match(output, /task-created/);
  assert.match(output, /resume failed/);
});

test("jobs retry atomically replaces recovery state with a recovery-retry wake", (t) => {
  const { store, task, runtime, changed } = fixture(t);
  saveRecovery(store, task.id);
  store.clearPendingWakeup(task.id);

  const output = runJobCommand(
    ["retry", `leader-recovery:${task.id}`],
    store,
    { runtime, now: () => new Date(NOW) }
  );

  assert.match(output, /Retry requested/);
  assert.equal(store.getLeaderFailure(task.id), null);
  assert.equal(store.getOperatorNotification(task.id), null);
  assert.deepEqual(store.getPendingWakeup(task.id)?.reasons, ["recovery-retry"]);
  assert.equal(store.getPendingWakeup(task.id)?.requestCount, 1);
  assert.equal(changed.at(-1), task.id);
});

test("jobs retry rejects wakeup ids and missing runtime without changing recovery state", (t) => {
  const { store, task } = fixture(t);
  saveRecovery(store, task.id);
  const beforeFailure = store.getLeaderFailure(task.id);
  const beforeWake = store.getPendingWakeup(task.id);

  assert.throws(
    () => runJobCommand(["retry", `leader-wakeup:${task.id}`], store),
    /not retryable/i
  );
  assert.throws(
    () => runJobCommand(["retry", `leader-recovery:${task.id}`], store),
    /runtime is not configured/i
  );
  assert.deepEqual(store.getLeaderFailure(task.id), beforeFailure);
  assert.deepEqual(store.getPendingWakeup(task.id), beforeWake);
});
