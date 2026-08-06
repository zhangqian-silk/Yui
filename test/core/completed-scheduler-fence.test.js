import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { processLeaderWakeups } from "../../dist/scheduler/leaderWakeupProcessor.js";
import { queueLeaderWakeup } from "../../dist/scheduler/wakeupQueue.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, completeTask, createTask } from "../../dist/task/task.js";

const NOW = new Date("2026-07-20T10:00:00.000Z");

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-completed-fence-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);
  const task = activateTask(createTask("task-1", "Completion race", NOW), NOW);
  const role = createRole(
    task.id,
    "leader",
    [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
    "codex",
    home,
    NOW
  );
  store.transaction((tx) => {
    tx.saveTask(task);
    tx.saveRole(task.id, role);
    queueLeaderWakeup(tx, task.id, "user-message", NOW);
  });
  return { store, task, role, adapter: new FileSchedulerStoreAdapter(store) };
}

test("a durable Leader claim fences completion while tmux is still preparing", async (t) => {
  const { store, task, adapter } = fixture(t);
  let sent = false;
  let completionError;
  const delivery = {
    async prepareRoleSession(input) {
      return { deliveryId: "delivery-1", ...input };
    },
    async waitUntilReady(prepared) {
      try {
        runTaskCommand(
          ["complete", task.id, "--summary", "Completed during preparation"],
          store,
          {
            now: () => new Date(NOW),
            environment: {
              YUI_SESSION_SCOPE: "task",
              YUI_TASK_ID: task.id,
              YUI_ROLE: "leader"
            }
          }
        );
      } catch (error) {
        completionError = error;
      }
      return { prepared, session: null };
    },
    async sendOnce() { sent = true; return "sent"; },
    async inspectRole() { return "present"; },
    async stopTask() { return true; }
  };

  const result = await processLeaderWakeups(adapter, delivery, NOW);

  assert.match(String(completionError), /delivery is still pending/i);
  assert.equal(sent, true);
  assert.equal(store.getTask(task.id)?.status, "active");
  assert.notEqual(store.getActiveAgentRun(task.id, "leader")?.pushedAt, undefined);
  assert.deepEqual(result, [{
    taskId: task.id,
    runId: "agent-run-1",
    status: "dispatched"
  }]);
});

test("a claimed but undelivered Leader run fences completion before tmux input", async (t) => {
  const { store, task, adapter } = fixture(t);
  let completionError;
  const delivery = {
    async prepareRoleSession(input) {
      return { deliveryId: "delivery-1", ...input };
    },
    async waitUntilReady(prepared) { return { prepared, session: null }; },
    async sendOnce() {
      try {
        runTaskCommand(
          ["complete", task.id, "--summary", "Completed during delivery"],
          store,
          {
            now: () => new Date(NOW),
            environment: {
              YUI_SESSION_SCOPE: "task",
              YUI_TASK_ID: task.id,
              YUI_ROLE: "leader"
            }
          }
        );
      } catch (error) {
        completionError = error;
      }
      return "sent";
    },
    async inspectRole() { return "present"; },
    async stopTask() { return true; }
  };

  const result = await processLeaderWakeups(adapter, delivery, NOW);

  assert.match(String(completionError), /delivery is still pending/i);
  assert.equal(store.getTask(task.id)?.status, "active");
  assert.notEqual(store.getActiveAgentRun(task.id, "leader")?.pushedAt, undefined);
  assert.deepEqual(result, [{
    taskId: task.id,
    runId: "agent-run-1",
    status: "dispatched"
  }]);
});

test("late Codex session registration cannot reactivate a completed Task", (t) => {
  const { store, task, role, adapter } = fixture(t);
  store.transaction((tx) => {
    tx.saveTask(completeTask(task, NOW, { by: "leader", summary: "Done" }));
    tx.clearPendingWakeup(task.id);
  });

  assert.throws(() => adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "late-thread"
  }), /not active|completed/i);
  assert.equal(store.getRoleSession(task.id, role.name), null);
});
