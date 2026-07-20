import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileTaskController,
  runControllerSchedulerPass,
  startFileTaskController
} from "../../dist/controller/controller.js";
import {
  DEFAULT_RECONCILIATION_INTERVAL_SECONDS,
  MAX_RECONCILIATION_INTERVAL_SECONDS,
  MIN_RECONCILIATION_INTERVAL_SECONDS,
  reconciliationIntervalMilliseconds
} from "../../dist/config/taskmuxConfig.js";
import { callController } from "../../dist/core/controllerClient.js";
import { ControllerClientError } from "../../dist/core/controllerClient.js";
import {
  FileTaskWorkflowRuntime,
  restartFileTaskController
} from "../../dist/controller/clientRuntime.js";
import { startFileTaskControllerRuntime } from "../../dist/controller/runtime.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";

function emptyStore(events = []) {
  return {
    listTasks() { events.push("list-tasks"); return []; },
    getTask() { return null; },
    listRoles() { return []; },
    getRole() { return null; },
    getActiveAgentRun() { return null; },
    getRoleSession() { return null; },
    nextAgentRunId() { return "run-1"; },
    getPendingWakeup() { return null; },
    listPendingWakeups() { events.push("list-wakeups"); return []; },
    savePendingWakeup() {},
    clearPendingWakeup() {},
    getLeaderFailure() { return null; },
    getOperatorNotification() { return null; },
    saveLeaderDispatch() {},
    saveRoleRunDelivery() {},
    saveLeaderDispatchFailure() {},
    saveExitedRoleRun() {},
    saveArchivedTaskStopped() {}
  };
}

const noTmux = {
  async prepareRoleSession() { throw new Error("unused"); },
  async waitUntilReady() { throw new Error("unused"); },
  async sendOnce() { throw new Error("unused"); },
  async inspectRole() { throw new Error("unused"); },
  async stopTask() { return false; }
};

test("controller scheduler reconciles liveness before processing wakeups", async () => {
  const events = [];
  const result = await runControllerSchedulerPass(emptyStore(events), noTmux, new Date(0));
  assert.deepEqual(result, {
    stoppedArchivedTaskIds: [], activeRunDeliveries: [], failedRunIds: [], wakeups: []
  });
  assert.deepEqual(events, ["list-tasks", "list-tasks", "list-tasks", "list-wakeups"]);
});

test("controller prepares active workspaces, stops archived tmux, then cleans archived worktrees", async () => {
  const events = [];
  const workspacePreparer = {
    async prepareActiveTaskWorkspaces() { events.push("prepare-active"); return []; },
    async cleanupArchivedTaskWorkspaces() { events.push("cleanup-archived"); return []; }
  };
  await runControllerSchedulerPass(
    emptyStore(events),
    noTmux,
    new Date(0),
    workspacePreparer
  );
  assert.deepEqual(events, [
    "prepare-active", "list-tasks", "cleanup-archived",
    "list-tasks", "list-tasks", "list-wakeups"
  ]);
});

test("controller delivers a queued Work AgentRun through tmux before liveness", async () => {
  const events = [];
  const task = { id: "task-1", status: "active" };
  const role = {
    taskId: task.id,
    name: "worker",
    activeAgentId: "codex",
    adapterId: "codex",
    status: "running"
  };
  const run = {
    schemaVersion: 1,
    id: "run-1",
    taskId: task.id,
    roleName: role.name,
    mode: "new",
    input: "implement it",
    workItemId: "work-1",
    status: "active",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  const store = emptyStore();
  store.listTasks = () => [task];
  store.listRoles = () => [role];
  store.getActiveAgentRun = () => run;
  store.saveRoleRunDelivery = ({ run: saved }) => events.push(`persist:${saved.id}`);
  const delivery = {
    async stopTask() { return false; },
    async prepareRoleSession() {
      events.push("prepare");
      return {
        deliveryId: "delivery-1", taskId: task.id, roleName: role.name,
        agentId: role.activeAgentId, adapterId: role.adapterId, mode: "new"
      };
    },
    async findExistingReceipt() { events.push("receipt"); return null; },
    async waitUntilReady(prepared) {
      events.push("ready");
      return { prepared, session: null };
    },
    async sendOnce({ receiptId, text }) {
      events.push(`send:${receiptId}:${text}`);
      return "sent";
    },
    async inspectRole() { events.push("inspect"); return "present"; }
  };

  const result = await runControllerSchedulerPass(store, delivery, new Date(0));

  assert.equal(result.activeRunDeliveries[0].status, "delivered");
  assert.deepEqual(events, [
    "prepare",
    "receipt",
    "ready",
    "send:agent-run:run-1:implement it",
    "persist:run-1",
    "inspect"
  ]);
});

test("controller archives are enforced by killing the tmux Task and stopping sessions", async () => {
  const task = { id: "task-archived", status: "archived" };
  const calls = [];
  const store = emptyStore();
  store.listTasks = () => [task];
  store.saveArchivedTaskStopped = (taskId) => calls.push(`stored:${taskId}`);
  const delivery = {
    ...noTmux,
    async stopTask(taskId) { calls.push(`tmux:${taskId}`); return true; }
  };

  const result = await runControllerSchedulerPass(store, delivery, new Date(0));

  assert.deepEqual(result.stoppedArchivedTaskIds, [task.id]);
  assert.deepEqual(calls, [`tmux:${task.id}`, `stored:${task.id}`]);
});

test("controller pump coalesces overlap into one non-overlapping follow-up pass", async () => {
  let listCalls = 0;
  let activeInspections = 0;
  let maxActive = 0;
  let inspections = 0;
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const store = emptyStore();
  store.listTasks = () => {
    listCalls += 1;
    return [{ id: "task-1", status: "active" }];
  };
  store.listRoles = () => [];
  const delivery = {
    ...noTmux,
    async inspectRole() {
      inspections += 1;
      activeInspections += 1;
      maxActive = Math.max(maxActive, activeInspections);
      if (inspections === 1) await firstBlocked;
      activeInspections -= 1;
      return "present";
    }
  };
  // Make the first liveness pass await inspectRole.
  store.listRoles = () => [{
    taskId: "task-1", name: "worker", activeAgentId: "codex", adapterId: "codex", status: "running"
  }];
  store.getActiveAgentRun = () => ({
    schemaVersion: 1,
    id: "run-1",
    taskId: "task-1",
    roleName: "worker",
    mode: "new",
    input: "work",
    status: "active",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  });

  const controller = new FileTaskController(store, delivery);
  const first = controller.pump();
  const joined = controller.pump();
  assert.equal(first, joined);
  releaseFirst();
  await first;

  // Each pass visits archived cleanup, queued Work delivery and liveness.
  assert.equal(listCalls, 6);
  assert.equal(inspections, 2);
  assert.equal(maxActive, 1);
  controller.stop();
});

test("controller reconciliation defaults to 30 seconds and accepts the configured range", () => {
  assert.equal(DEFAULT_RECONCILIATION_INTERVAL_SECONDS, 30);
  assert.equal(MIN_RECONCILIATION_INTERVAL_SECONDS, 5);
  assert.equal(MAX_RECONCILIATION_INTERVAL_SECONDS, 300);
  assert.equal(reconciliationIntervalMilliseconds(), 30_000);
  assert.equal(reconciliationIntervalMilliseconds(5), 5_000);
  assert.equal(reconciliationIntervalMilliseconds(300), 300_000);
  for (const value of [4, 301, 30.5, "30"]) {
    assert.throws(
      () => reconciliationIntervalMilliseconds(value),
      /reconciliationIntervalSeconds must be an integer from 5 to 300/
    );
  }
});

test("state changes still request an immediate Controller scan", async () => {
  const methods = [];
  let scanCompleted;
  const scanned = new Promise((resolve) => { scanCompleted = resolve; });
  const runtime = new FileTaskWorkflowRuntime(
    "/tmp/taskmux-state-change-scan",
    { getTask: () => null },
    {},
    {},
    {},
    undefined,
    {
      call: async (_home, method) => {
        methods.push(method);
        if (method === "controller.status") return { running: true };
        assert.equal(method, "scheduler.scan");
        scanCompleted();
        return {};
      }
    }
  );

  runtime.notifyStateChanged("task-1");
  await scanned;

  assert.deepEqual(methods, ["controller.status", "scheduler.scan"]);
});

test("foreground runtime prepares active Role worktrees but leaves archive cleanup to Controller order", async () => {
  for (const [status, expected] of [
    ["active", ["prepare", "controller.status", "scheduler.scan"]],
    ["archived", ["controller.status", "scheduler.scan"]]
  ]) {
    const events = [];
    let scanCompleted;
    const scanned = new Promise((resolve) => { scanCompleted = resolve; });
    const runtime = new FileTaskWorkflowRuntime(
      "/tmp/taskmux-workspace-order",
      { getTask: () => ({ id: "task-1", status, repositoryId: "repository-1" }) },
      {},
      {},
      {},
      { async prepareTaskWorkspace() { events.push("prepare"); return { taskId: "task-1", status: "ready" }; } },
      {
        call: async (_home, method) => {
          events.push(method);
          if (method === "controller.status") return { running: true };
          scanCompleted();
          return {};
        }
      }
    );

    runtime.notifyStateChanged("task-1");
    await scanned;
    assert.deepEqual(events, expected);
  }
});

test("background FileTask controller exposes status, scan and stop on one private home socket", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-file-controller-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const controller = await startFileTaskController(home, emptyStore(), noTmux, undefined, {
    intervalMs: 60_000
  });

  const status = await callController(home, "controller.status", {});
  assert.equal(status.running, true);
  assert.equal(status.pid, process.pid);
  assert.deepEqual(await callController(home, "scheduler.scan", {}), {
    stoppedArchivedTaskIds: [],
    activeRunDeliveries: [],
    failedRunIds: [],
    wakeups: []
  });
  assert.deepEqual(await callController(home, "controller.stop", {}), { stopped: true });
  await controller.closed;
});

test("production FileTask controller composition starts without compact SQLite runtime", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-file-runtime-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const controller = await startFileTaskControllerRuntime(home, { intervalMs: 60_000 });

  assert.equal((await callController(home, "controller.status", {})).running, true);
  assert.equal(controller.store.rootDirectory(), home);
  assert.equal(controller.runtime.reconciliationIntervalMs, 60_000);
  await controller.close();
});

test("production Controller reads reconciliationIntervalSeconds from TaskMux config", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-file-runtime-config-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const { FileTaskStore } = await import("../../dist/storage/taskStore.js");
  const store = new FileTaskStore(home);
  store.saveConfig({ schemaVersion: 1, reconciliationIntervalSeconds: 45 });

  const controller = await startFileTaskControllerRuntime(home, { store });

  assert.equal(controller.runtime.reconciliationIntervalMs, 45_000);
  await controller.close();
});

test("controller restart waits for the old process and starts the current runtime without tmux effects", async () => {
  const events = [];
  let phase = "running";
  let stoppingStatusCalls = 0;
  const call = async (_home, method) => {
    events.push(method);
    if (method === "controller.stop") {
      phase = "stopping";
      return { stopped: true };
    }
    assert.equal(method, "controller.status");
    if (phase === "running") return { running: true, pid: 10 };
    if (phase === "started") return { running: true, pid: 20 };
    if (stoppingStatusCalls++ === 0) return { running: true, pid: 10 };
    throw new ControllerClientError("CONTROLLER_UNAVAILABLE", "Controller is unavailable.");
  };

  const result = await restartFileTaskController("/tmp/taskmux-restart-test", {
    call,
    pollIntervalMs: 1,
    startupTimeoutMs: 100,
    spawnController: () => {
      events.push("spawn");
      phase = "started";
    }
  });

  assert.deepEqual(result, { restarted: true, previousPid: 10, pid: 20 });
  assert.deepEqual(events, [
    "controller.status",
    "controller.stop",
    "controller.status",
    "controller.status",
    "controller.status",
    "spawn",
    "controller.status"
  ]);
});
