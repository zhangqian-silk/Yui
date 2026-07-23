import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compileReconcileSelection,
  FileTaskController,
  runControllerSchedulerPass,
  startFileTaskController
} from "../../dist/controller/controller.js";
import {
  DEFAULT_RECONCILIATION_INTERVAL_SECONDS,
  MAX_RECONCILIATION_INTERVAL_SECONDS,
  MIN_RECONCILIATION_INTERVAL_SECONDS,
  reconciliationIntervalMilliseconds
} from "../../dist/config/yuiConfig.js";
import {
  callController,
  ControllerClientError,
  readControllerDiscovery
} from "../../dist/core/controllerClient.js";
import {
  FileTaskWorkflowRuntime,
  restartFileTaskController
} from "../../dist/controller/clientRuntime.js";
import { startFileTaskControllerRuntime } from "../../dist/controller/runtime.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";

function emptyStore(events = []) {
  return {
    getPresentationContext() { return { timeZone: "Asia/Shanghai" }; },
    listTasks() { events.push("list-tasks"); return []; },
    getTask() { return null; },
    listRoles() { return []; },
    getRole() { return null; },
    getActiveAgentRun() { return null; },
    hasOpenInputRequest() { return false; },
    listOpenInputRequests() { return []; },
    listPendingRuntimeTurnCompletions() { return []; },
    getOperatorDeliveryTarget() { return null; },
    resolveExpiredInputRecommendations() { return []; },
    resolveDueRuntimeTurnCompletions() { return []; },
    getRoleSession() { return null; },
    hasInFlightTurn() { return false; },
    nextAgentRunId() { return "run-1"; },
    getWorkMailbox() { return null; },
    listWorkMailboxes() { return []; },
    claimWorkMailbox() { return { status: "empty" }; },
    completeWorkMailbox() { return false; },
    releaseWorkMailbox() { return false; },
    getPendingWakeup() { return null; },
    listPendingWakeups() { events.push("list-wakeups"); return []; },
    savePendingWakeup() {},
    clearPendingWakeup() {},
    getLeaderFailure() { return null; },
    getOperatorNotification() { return null; },
    getTaskBrief() { return null; },
    listDecisions() { return []; },
    listMilestones() { return []; },
    saveLeaderDispatch() {},
    saveRoleRunPrepared() {},
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

test("controller scheduler folds completion and liveness phases before wakeups", async () => {
  const events = [];
  const result = await runControllerSchedulerPass(emptyStore(events), noTmux, new Date(0));
  assert.deepEqual(result, {
    stoppedArchivedTaskIds: [],
    activeRunDeliveries: [],
    failedRunIds: [],
    wakeups: [],
    inputNotifications: [],
    autoResolvedInputs: []
  });
  assert.deepEqual(events, ["list-tasks", "list-tasks", "list-tasks", "list-wakeups"]);
});

test("periodic recovery skips active workspace scans without durable Task work", async () => {
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
    "list-tasks", "list-tasks", "list-tasks", "list-wakeups"
  ]);
});

test("Task mailbox is completed only after its targeted orchestration succeeds", async () => {
  const target = { kind: "task", taskId: "task-1" };
  const batch = {
    fromSequence: 1, toSequence: 1, reasons: ["task-activated"], refs: [],
    requestCount: 1, firstQueuedAt: new Date(0).toISOString(), lastQueuedAt: new Date(0).toISOString()
  };
  const mailbox = { schemaVersion: 1, target, nextSequence: 2, processing: null, pending: batch };
  const processing = {
    batchId: "task:task-1:1-1", batch, owner: "controller", startedAt: new Date(0).toISOString()
  };
  const calls = [];
  const store = emptyStore();
  store.getTask = () => ({ id: "task-1", status: "active" });
  store.getWorkMailbox = () => mailbox;
  store.claimWorkMailbox = () => { calls.push("claim"); return { status: "claimed", processing }; };
  store.completeWorkMailbox = (_target, batchId) => { calls.push(`complete:${batchId}`); return true; };
  const workspace = {
    async prepareTaskWorkspace() { calls.push("workspace"); return { taskId: "task-1", status: "ready" }; },
    async prepareActiveTaskWorkspaces() { return []; },
    async cleanupArchivedTaskWorkspaces() { return []; }
  };

  await runControllerSchedulerPass(store, noTmux, new Date(0), workspace, {
    kind: "dirty", keys: ["task:task-1"]
  });

  assert.deepEqual(calls, ["claim", "workspace", "complete:task:task-1:1-1"]);
});

test("Task mailbox is released when targeted orchestration fails", async () => {
  const target = { kind: "task", taskId: "task-1" };
  const batch = {
    fromSequence: 1, toSequence: 1, reasons: ["task-activated"], refs: [],
    requestCount: 1, firstQueuedAt: new Date(0).toISOString(), lastQueuedAt: new Date(0).toISOString()
  };
  const processing = {
    batchId: "task:task-1:1-1", batch, owner: "controller", startedAt: new Date(0).toISOString()
  };
  const store = emptyStore();
  store.getTask = () => ({ id: "task-1", status: "active" });
  store.getWorkMailbox = () => ({
    schemaVersion: 1, target, nextSequence: 2, processing: null, pending: batch
  });
  store.claimWorkMailbox = () => ({ status: "claimed", processing });
  let released = null;
  store.releaseWorkMailbox = (_target, batchId) => { released = batchId; return true; };
  const workspace = {
    async prepareTaskWorkspace() { throw new Error("workspace failed"); },
    async prepareActiveTaskWorkspaces() { return []; },
    async cleanupArchivedTaskWorkspaces() { return []; }
  };

  await assert.rejects(
    runControllerSchedulerPass(store, noTmux, new Date(0), workspace, {
      kind: "dirty", keys: ["task:task-1"]
    }),
    /workspace failed/
  );
  assert.equal(released, "task:task-1:1-1");
});

test("targeted archived cleanup returning failed releases its Task mailbox", async () => {
  const target = { kind: "task", taskId: "task-1" };
  const batch = {
    fromSequence: 1, toSequence: 1, reasons: ["task-archived"], refs: [],
    requestCount: 1, firstQueuedAt: new Date(0).toISOString(), lastQueuedAt: new Date(0).toISOString()
  };
  const processing = {
    batchId: "task:task-1:1-1", batch, owner: "controller", startedAt: new Date(0).toISOString()
  };
  const settled = [];
  const store = emptyStore();
  store.getTask = () => ({ id: "task-1", status: "archived", repositoryId: "repository-1" });
  store.getWorkMailbox = () => ({
    schemaVersion: 1, target, nextSequence: 2, processing: null, pending: batch
  });
  store.claimWorkMailbox = () => ({ status: "claimed", processing });
  store.completeWorkMailbox = () => { settled.push("complete"); return true; };
  store.releaseWorkMailbox = () => { settled.push("release"); return true; };
  const workspace = {
    async prepareTaskWorkspace() { return { taskId: "task-1", status: "failed", error: "git failed" }; },
    async prepareActiveTaskWorkspaces() { return []; },
    async cleanupArchivedTaskWorkspaces() { return []; }
  };

  await runControllerSchedulerPass(store, noTmux, new Date(0), workspace, {
    kind: "dirty", keys: ["task:task-1"]
  });

  assert.deepEqual(settled, ["release"]);
});

test("one targeted workspace failure does not skip or acknowledge later Tasks", async () => {
  const batch = {
    fromSequence: 1, toSequence: 1, reasons: ["task-archived"], refs: [],
    requestCount: 1, firstQueuedAt: new Date(0).toISOString(), lastQueuedAt: new Date(0).toISOString()
  };
  const targets = ["task-failed", "task-ok"].map((taskId) => ({ kind: "task", taskId }));
  const mailboxes = new Map(targets.map((target) => [target.taskId, {
    schemaVersion: 1, target, nextSequence: 2, processing: null, pending: batch
  }]));
  const attempted = [];
  const settled = [];
  const store = emptyStore();
  store.getTask = (taskId) => ({ id: taskId, status: "archived", repositoryId: "repository-1" });
  store.getWorkMailbox = (target) => mailboxes.get(target.taskId) ?? null;
  store.claimWorkMailbox = ({ target }) => ({
    status: "claimed",
    processing: {
      batchId: `task:${target.taskId}:1-1`, batch, owner: "controller", startedAt: new Date(0).toISOString()
    }
  });
  store.completeWorkMailbox = (target) => { settled.push(`complete:${target.taskId}`); return true; };
  store.releaseWorkMailbox = (target) => { settled.push(`release:${target.taskId}`); return true; };
  const workspace = {
    async prepareTaskWorkspace(taskId) {
      attempted.push(taskId);
      return taskId === "task-failed"
        ? { taskId, status: "failed", error: "git failed" }
        : { taskId, status: "archived-clean" };
    },
    async prepareActiveTaskWorkspaces() { return []; },
    async cleanupArchivedTaskWorkspaces() { return []; }
  };

  await runControllerSchedulerPass(store, noTmux, new Date(0), workspace, {
    kind: "dirty", keys: ["task:task-failed", "task:task-ok"]
  });

  assert.deepEqual(attempted, ["task-failed", "task-ok"]);
  assert.deepEqual(settled, ["release:task-failed", "complete:task-ok"]);
});

test("full recovery releases only Task mailboxes whose isolated workspace work failed", async () => {
  const batch = {
    fromSequence: 1, toSequence: 1, reasons: ["task-updated"], refs: [],
    requestCount: 1, firstQueuedAt: new Date(0).toISOString(), lastQueuedAt: new Date(0).toISOString()
  };
  const targets = ["task-ok", "task-failed"].map((taskId) => ({ kind: "task", taskId }));
  const mailboxes = new Map(targets.map((target) => [target.taskId, {
    schemaVersion: 1, target, nextSequence: 2, processing: null, pending: batch
  }]));
  const settled = [];
  const store = emptyStore();
  store.listWorkMailboxes = () => [...mailboxes.values()];
  store.getTask = (taskId) => ({ id: taskId, status: "active" });
  store.getWorkMailbox = (target) => mailboxes.get(target.taskId) ?? null;
  store.claimWorkMailbox = ({ target }) => ({
    status: "claimed",
    processing: {
      batchId: `task:${target.taskId}:1-1`, batch, owner: "controller", startedAt: new Date(0).toISOString()
    }
  });
  store.completeWorkMailbox = (target) => { settled.push(`complete:${target.taskId}`); return true; };
  store.releaseWorkMailbox = (target) => { settled.push(`release:${target.taskId}`); return true; };
  const workspace = {
    async prepareTaskWorkspace(taskId) {
      return taskId === "task-failed"
        ? { taskId, status: "failed", error: "git failed" }
        : { taskId, status: "ready" };
    },
    async prepareActiveTaskWorkspaces() { throw new Error("periodic full scan is forbidden"); },
    async cleanupArchivedTaskWorkspaces() { return []; }
  };

  await runControllerSchedulerPass(store, noTmux, new Date(0), workspace);

  assert.deepEqual(settled, ["complete:task-ok", "release:task-failed"]);
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
  store.getTask = (taskId) => taskId === task.id ? task : null;
  store.listRoles = () => [role];
  store.getActiveAgentRun = () => run;
  store.claimWorkMailbox = () => ({
    status: "claimed",
    processing: {
      batchId: "agent-run:run-1",
      batch: {
        fromSequence: 1, toSequence: 1, reasons: ["work-dispatched"], refs: [{ type: "run", id: run.id }],
        requestCount: 1, firstQueuedAt: new Date(0).toISOString(), lastQueuedAt: new Date(0).toISOString()
      },
      owner: "controller",
      startedAt: new Date(0).toISOString(),
      executionRef: { type: "run", id: run.id }
    }
  });
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
  store.getTask = (taskId) => taskId === task.id ? task : null;
  store.saveArchivedTaskStopped = (taskId) => calls.push(`stored:${taskId}`);
  const delivery = {
    ...noTmux,
    async stopTask(taskId) { calls.push(`tmux:${taskId}`); return true; }
  };

  const result = await runControllerSchedulerPass(
    store,
    delivery,
    new Date(0),
    undefined,
    { kind: "dirty", keys: [`task:${task.id}`] }
  );

  assert.deepEqual(result.stoppedArchivedTaskIds, [task.id]);
  assert.deepEqual(calls, [`tmux:${task.id}`, `stored:${task.id}`]);
});

test("dirty mailbox keys compile into exact task, role and operator selections", () => {
  const selection = compileReconcileSelection({
    kind: "dirty",
    keys: [
      "task:task-1", "role:task-2/worker", "operator", "role:task-2/reviewer",
      "role:task%2F3/review%2Fer"
    ]
  });

  assert.equal(selection.full, false);
  assert.deepEqual([...selection.taskIds], ["task-1", "task-2", "task/3"]);
  assert.deepEqual([...selection.allRoleTaskIds], ["task-1"]);
  assert.deepEqual([...selection.rolesByTask.get("task-2")], ["worker", "reviewer"]);
  assert.deepEqual([...selection.rolesByTask.get("task/3")], ["review/er"]);
  assert.equal(selection.operator, true);
  assert.throws(
    () => compileReconcileSelection({ kind: "dirty", keys: ["role:task-1"] }),
    /mailbox key/i
  );
});

test("dirty Task reconciliation filters every Task phase and preserves workspace ordering", async () => {
  const events = [];
  const active = { id: "task-active", status: "active", repositoryId: "repository-1" };
  const archived = { id: "task-archived", status: "archived", repositoryId: "repository-1" };
  const tasks = new Map([[active.id, active], [archived.id, archived]]);
  const store = emptyStore(events);
  store.listTasks = () => { throw new Error("dirty pass must not list every Task"); };
  store.getTask = (taskId) => tasks.get(taskId) ?? null;
  store.listRoles = (taskId) => { events.push(`roles:${taskId}`); return []; };
  store.getPendingWakeup = (taskId) => { events.push(`wake:${taskId}`); return null; };
  store.resolveExpiredInputRecommendations = (_now, taskIds) => {
    events.push(`deadlines:${[...taskIds].join(",")}`);
    return [];
  };
  store.listOpenInputRequests = () => { throw new Error("Task pass must not notify Operator"); };
  const workspace = {
    async prepareTaskWorkspace(taskId) { events.push(`workspace:${taskId}`); return { taskId, status: "ready" }; },
    async prepareActiveTaskWorkspaces() { throw new Error("dirty pass must not prepare all Tasks"); },
    async cleanupArchivedTaskWorkspaces() { throw new Error("dirty pass must not clean all Tasks"); }
  };
  const delivery = {
    ...noTmux,
    async stopTask(taskId) { events.push(`stop:${taskId}`); return true; }
  };

  await runControllerSchedulerPass(store, delivery, new Date(0), workspace, {
    kind: "dirty",
    keys: ["task:task-active", "task:task-archived"]
  });

  assert.ok(events.indexOf("workspace:task-active") < events.indexOf("stop:task-archived"));
  assert.ok(events.indexOf("stop:task-archived") < events.indexOf("workspace:task-archived"));
  assert.deepEqual(events.filter((event) => event.startsWith("deadlines:")), [
    "deadlines:task-active,task-archived"
  ]);
  assert.deepEqual([...new Set(events.filter((event) => event.startsWith("wake:")))].sort(), [
    "wake:task-active", "wake:task-archived"
  ]);
});

test("dirty Role reconciliation inspects only that Role while retaining the Task Leader closure", async () => {
  const task = { id: "task-1", status: "active" };
  const roles = ["worker", "reviewer"].map((name) => ({
    taskId: task.id, name, activeAgentId: `codex-${name}`, adapterId: "codex", status: "running"
  }));
  const inspected = [];
  const store = emptyStore();
  store.getTask = (taskId) => taskId === task.id ? task : null;
  store.getRole = (taskId, roleName) => roles.find(
    (role) => role.taskId === taskId && role.name === roleName
  ) ?? null;
  store.getActiveAgentRun = (_taskId, roleName) => ({
    schemaVersion: 1, id: `run-${roleName}`, taskId: task.id, roleName,
    mode: "new", input: roleName, status: "active", deliveredAt: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  });
  store.resolveExpiredInputRecommendations = () => [];
  const delivery = {
    ...noTmux,
    async inspectRole(input) { inspected.push(input.roleName); return "present"; }
  };
  const workspace = {
    async prepareTaskWorkspace() {
      throw new Error("Role-only pass must not prepare the Task workspace");
    },
    async prepareActiveTaskWorkspaces() {
      throw new Error("Role-only pass must not prepare all Task workspaces");
    },
    async cleanupArchivedTaskWorkspaces() {
      throw new Error("Role-only pass must not clean archived Task workspaces");
    }
  };

  await runControllerSchedulerPass(store, delivery, new Date(0), workspace, {
    kind: "dirty", keys: ["role:task-1/worker"]
  });

  assert.deepEqual(inspected, ["worker"]);
});

test("an Operator-only dirty pass does not scan Task phases", async () => {
  const store = emptyStore();
  store.listTasks = () => { throw new Error("operator pass must not list Tasks"); };
  store.getTask = () => { throw new Error("operator pass must not read Tasks"); };
  let mailboxReads = 0;
  store.getWorkMailbox = (target) => { mailboxReads += 1; assert.equal(target.kind, "operator"); return null; };

  await runControllerSchedulerPass(store, noTmux, new Date(0), undefined, {
    kind: "dirty", keys: ["operator"]
  });

  assert.equal(mailboxReads, 1);
});

test("Operator attention is not blocked by a slow Task reconciliation", async () => {
  let releaseWorkspace;
  let workspaceStarted;
  const blocked = new Promise((resolve) => { releaseWorkspace = resolve; });
  const started = new Promise((resolve) => { workspaceStarted = resolve; });
  let operatorReads = 0;
  const store = emptyStore();
  store.getTask = (taskId) => taskId === "task-1"
    ? { id: taskId, status: "active" }
    : null;
  store.getWorkMailbox = (target) => {
    if (target.kind === "operator") operatorReads += 1;
    return null;
  };
  const workspace = {
    async prepareTaskWorkspace() {
      workspaceStarted();
      await blocked;
      return { taskId: "task-1", status: "ready" };
    },
    async prepareActiveTaskWorkspaces() { return []; },
    async cleanupArchivedTaskWorkspaces() { return []; }
  };
  const controller = new FileTaskController(store, noTmux, {
    signalWindowMs: 1,
    workspacePreparer: workspace
  });

  controller.signal("task:task-1");
  await started;
  controller.signal("operator");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(operatorReads, 1);
  releaseWorkspace();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(operatorReads, 1);
  controller.stop();
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

  // Each pass visits queued Work delivery, liveness, and orphan recovery. The
  // first full pass also bootstraps exact missing-Hook recovery deadlines.
  assert.equal(listCalls, 7);
  assert.equal(inspections, 2);
  assert.equal(maxActive, 1);
  controller.stop();
});

test("an unapplied Hook event fences destructive scheduler phases", async () => {
  let schedulerReads = 0;
  const store = emptyStore();
  store.listTasks = () => {
    schedulerReads += 1;
    return [];
  };
  const controller = new FileTaskController(store, noTmux, {
    runtimeEventProcessor: {
      drain() {
        return {
          acknowledgedEventIds: [],
          failed: [{ eventId: "turn-failed", error: new Error("state unavailable") }]
        };
      }
    }
  });

  await assert.rejects(controller.pump(), /native Turn events could not be applied/i);

  assert.equal(schedulerReads, 0);
  controller.stop();
});

test("a transient Hook apply failure retries quickly without another external signal", async () => {
  let drains = 0;
  let schedulerReads = 0;
  const store = emptyStore();
  store.listTasks = () => {
    schedulerReads += 1;
    return [];
  };
  const controller = new FileTaskController(store, noTmux, {
    deliveryRetryMs: 2,
    runtimeEventProcessor: {
      drain() {
        drains += 1;
        return drains === 1
          ? {
              acknowledgedEventIds: [],
              deferred: [],
              failed: [{ eventId: "turn-transient", error: new Error("locked") }]
            }
          : { acknowledgedEventIds: [], deferred: [], failed: [] };
      }
    }
  });

  await assert.rejects(controller.pump(), /native Turn events could not be applied/i);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(drains >= 3);
  assert.ok(schedulerReads > 0);
  controller.stop();
});

test("controller recovery reconciliation defaults to 120 seconds and accepts the configured range", () => {
  assert.equal(DEFAULT_RECONCILIATION_INTERVAL_SECONDS, 120);
  assert.equal(MIN_RECONCILIATION_INTERVAL_SECONDS, 5);
  assert.equal(MAX_RECONCILIATION_INTERVAL_SECONDS, 300);
  assert.equal(reconciliationIntervalMilliseconds(), 120_000);
  assert.equal(reconciliationIntervalMilliseconds(5), 5_000);
  assert.equal(reconciliationIntervalMilliseconds(300), 300_000);
  for (const value of [4, 301, 30.5, "30"]) {
    assert.throws(
      () => reconciliationIntervalMilliseconds(value),
      /reconciliationIntervalSeconds must be an integer from 5 to 300/
    );
  }
});

test("state changes enqueue a Controller signal without waiting for a full scan", async () => {
  const methods = [];
  const params = [];
  let signalCompleted;
  const signalled = new Promise((resolve) => { signalCompleted = resolve; });
  const runtime = new FileTaskWorkflowRuntime(
    "/tmp/yui-state-change-scan",
    { getTask: () => null },
    {},
    {},
    {},
    undefined,
    {
      call: async (_home, method, input) => {
        methods.push(method);
        params.push(input);
        if (method === "controller.status") return { running: true };
        assert.equal(method, "scheduler.signal");
        signalCompleted();
        return { accepted: true };
      }
    }
  );

  runtime.notifyStateChanged("task-1");
  await signalled;

  assert.deepEqual(methods, ["scheduler.signal"]);
  assert.deepEqual(params, [{ key: "task:task-1" }]);
});

test("foreground enter asks the Controller to own session creation", async () => {
  const calls = [];
  const runtime = new FileTaskWorkflowRuntime(
    "/tmp/yui-controller-owned-session",
    {},
    {},
    { plan() { throw new Error("CLI planner must not run"); } },
    { ensureRoleWindow() { throw new Error("CLI tmux creator must not run"); } },
    undefined,
    {
      call: async (_home, method, params) => {
        calls.push([method, params]);
        return { ensured: true };
      }
    }
  );

  await runtime.prepareTaskRoleEnter({ taskId: "task-1", roleName: "leader" });
  await runtime.prepareGlobalRoleEnter("operator");

  assert.deepEqual(calls, [
    ["runtime.ensure-role-session", {
      scope: "task",
      taskId: "task-1",
      roleName: "leader"
    }],
    ["runtime.ensure-role-session", {
      scope: "global",
      roleName: "operator"
    }],
    ["scheduler.signal", {
      key: "operator"
    }]
  ]);
});

test("explicit reconciliation prepares active Role worktrees before requesting a full scan", async () => {
  for (const [status, expected] of [
    ["active", ["prepare", "scheduler.scan"]],
    ["archived", ["scheduler.scan"]]
  ]) {
    const events = [];
    let scanCompleted;
    const scanned = new Promise((resolve) => { scanCompleted = resolve; });
    const runtime = new FileTaskWorkflowRuntime(
      "/tmp/yui-workspace-order",
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

    runtime.reconcileTask("task-1");
    await scanned;
    assert.deepEqual(events, expected);
  }
});

test("Controller signals coalesce a burst into one delayed targeted pass", async () => {
  const taskReads = [];
  const store = emptyStore();
  store.getTask = (taskId) => { taskReads.push(taskId); return null; };
  const controller = new FileTaskController(store, noTmux, { signalWindowMs: 5 });

  controller.signal("task:task-1");
  controller.signal("task:task-1");
  controller.signal("task:task-2");
  assert.deepEqual(taskReads, []);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual([...new Set(taskReads)].sort(), ["task-1", "task-2"]);
  controller.stop();
});

test("signals received during a pass are frozen into the next non-overlapping batch", async () => {
  const tasks = ["task-1", "task-2"].map((id) => ({ id, status: "active" }));
  let releaseFirst;
  let announceFirst;
  const firstStarted = new Promise((resolve) => { announceFirst = resolve; });
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const inspected = [];
  let active = 0;
  let maxActive = 0;
  const store = emptyStore();
  store.getTask = (taskId) => tasks.find((task) => task.id === taskId) ?? null;
  store.getRole = (taskId, roleName) => roleName === "worker" ? role(taskId, roleName) : null;
  store.getActiveAgentRun = (taskId, roleName) => deliveredRun(taskId, roleName);
  const delivery = {
    ...noTmux,
    async inspectRole(input) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      inspected.push(input.taskId);
      if (input.taskId === "task-1") {
        announceFirst();
        await firstBlocked;
      }
      active -= 1;
      return "present";
    }
  };
  const controller = new FileTaskController(store, delivery, { signalWindowMs: 1 });

  controller.signal("role:task-1/worker");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await firstStarted;
  controller.signal("role:task-2/worker");
  await new Promise((resolve) => setTimeout(resolve, 5));
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(inspected, ["task-1", "task-2"]);
  assert.equal(maxActive, 1);
  controller.stop();
});

test("a failed dirty scope is retained and joins the next event batch", async () => {
  const tasks = new Map([
    ["task-1", { id: "task-1", status: "active" }],
    ["task-2", { id: "task-2", status: "active" }]
  ]);
  const calls = [];
  let failFirst = true;
  const store = emptyStore();
  store.getTask = (taskId) => tasks.get(taskId) ?? null;
  const workspace = {
    async prepareTaskWorkspace(taskId) {
      calls.push(taskId);
      if (taskId === "task-1" && failFirst) {
        failFirst = false;
        throw new Error("transient workspace failure");
      }
      return { taskId, status: "ready" };
    },
    async prepareActiveTaskWorkspaces() { return []; },
    async cleanupArchivedTaskWorkspaces() { return []; }
  };
  const controller = new FileTaskController(store, noTmux, {
    signalWindowMs: 1,
    workspacePreparer: workspace,
    onError() {}
  });

  controller.signal("task:task-1");
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.signal("task:task-2");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(calls, ["task-1", "task-1", "task-2"]);
  controller.stop();
});

test("a non-ready Role delivery uses bounded queued retries instead of blocking readiness polling", async () => {
  const task = { id: "task-1", status: "active" };
  const roleValue = role(task.id, "worker");
  let run = deliveredRun(task.id, roleValue.name);
  delete run.deliveredAt;
  let sends = 0;
  const store = emptyStore();
  store.getTask = () => task;
  store.getRole = () => roleValue;
  store.getActiveAgentRun = () => run;
  store.claimWorkMailbox = () => ({
    status: "processing",
    processing: {
      batchId: `agent-run:${run.id}`,
      batch: {
        fromSequence: 1, toSequence: 1, reasons: ["run-dispatched"], refs: [{ type: "run", id: run.id }],
        requestCount: 1, firstQueuedAt: new Date(0).toISOString(), lastQueuedAt: new Date(0).toISOString()
      },
      owner: "controller", startedAt: new Date(0).toISOString(),
      executionRef: { type: "run", id: run.id }
    }
  });
  store.saveRoleRunDelivery = ({ now }) => { run = { ...run, deliveredAt: now.toISOString() }; };
  const delivery = {
    ...noTmux,
    async prepareRoleSession(input) {
      return { ...input, deliveryId: "delivery-1", sessionStarted: true };
    },
    async findExistingReceipt() { return null; },
    async waitUntilReady(prepared) { return { prepared, session: null }; },
    async sendOnce() { sends += 1; return sends < 4 ? "busy" : "sent"; },
    async inspectRole() { return "present"; }
  };
  const controller = new FileTaskController(store, delivery, {
    signalWindowMs: 1,
    deliveryRetryMs: 2,
    deliveryRetryLimit: 5
  });

  controller.signal("role:task-1/worker");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(sends, 4);
  assert.notEqual(run.deliveredAt, undefined);
  controller.stop();
});

test("a fresh Controller retries an undelivered Run in an existing busy pane", async () => {
  const task = { id: "task-1", status: "active" };
  const roleValue = role(task.id, "worker");
  const run = {
    ...deliveredRun(task.id, roleValue.name),
    mode: "resume"
  };
  delete run.deliveredAt;
  let sends = 0;
  const store = emptyStore();
  store.getTask = () => task;
  store.getRole = () => roleValue;
  store.getActiveAgentRun = () => run;
  store.getRoleSession = () => ({
    agentId: roleValue.activeAgentId,
    adapterId: roleValue.adapterId,
    nativeSessionId: "thread-existing",
    status: "running"
  });
  store.claimWorkMailbox = () => ({
    status: "processing",
    processing: {
      batchId: `agent-run:${run.id}`,
      batch: {
        fromSequence: 1, toSequence: 1, reasons: ["run-dispatched"], refs: [{ type: "run", id: run.id }],
        requestCount: 1, firstQueuedAt: new Date(0).toISOString(), lastQueuedAt: new Date(0).toISOString()
      },
      owner: "controller", startedAt: new Date(0).toISOString(),
      executionRef: { type: "run", id: run.id }
    }
  });
  const delivery = {
    ...noTmux,
    async prepareRoleSession(input) {
      return { ...input, deliveryId: "delivery-resume", sessionStarted: false };
    },
    async findExistingReceipt() { return null; },
    async waitUntilReady(prepared) {
      return { prepared, session: store.getRoleSession() };
    },
    async sendOnce() { sends += 1; return sends < 3 ? "busy" : "sent"; },
    async inspectRole() { return "present"; }
  };
  const controller = new FileTaskController(store, delivery, {
    signalWindowMs: 1,
    deliveryRetryMs: 2,
    deliveryRetryLimit: 2
  });

  controller.signal("role:task-1/worker");
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(sends, 3);
  controller.stop();
});

test("a resumed Role retries startup readiness when prepare created its missing pane", async () => {
  const task = { id: "task-1", status: "active" };
  const roleValue = role(task.id, "worker");
  const run = { ...deliveredRun(task.id, roleValue.name), mode: "resume" };
  delete run.deliveredAt;
  let sends = 0;
  const store = emptyStore();
  store.getTask = () => task;
  store.getRole = () => roleValue;
  store.getActiveAgentRun = () => run;
  store.getRoleSession = () => ({
    agentId: roleValue.activeAgentId,
    adapterId: roleValue.adapterId,
    nativeSessionId: "thread-existing",
    status: "running"
  });
  store.claimWorkMailbox = () => ({
    status: "processing",
    processing: {
      batchId: `agent-run:${run.id}`,
      batch: {
        fromSequence: 1, toSequence: 1, reasons: ["run-dispatched"],
        refs: [{ type: "run", id: run.id }], requestCount: 1,
        firstQueuedAt: new Date(0).toISOString(),
        lastQueuedAt: new Date(0).toISOString()
      },
      owner: "controller", startedAt: new Date(0).toISOString(),
      executionRef: { type: "run", id: run.id }
    }
  });
  const delivery = {
    ...noTmux,
    async prepareRoleSession(input) {
      return { ...input, deliveryId: "delivery-resume-recreated", sessionStarted: true };
    },
    async findExistingReceipt() { return null; },
    async waitUntilReady(prepared) {
      return { prepared, session: store.getRoleSession() };
    },
    async sendOnce() { sends += 1; return sends === 1 ? "busy" : "sent"; },
    async inspectRole() { return "present"; }
  };
  const controller = new FileTaskController(store, delivery, {
    signalWindowMs: 1,
    deliveryRetryMs: 2,
    deliveryRetryLimit: 2
  });

  controller.signal("role:task-1/worker");
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(sends, 2);
  controller.stop();
});

test("a full pump dominates dirty keys queued during the current pass", async () => {
  const tasks = ["task-1", "task-2"].map((id) => ({ id, status: "active" }));
  let releaseFirst;
  let announceFirst;
  const firstStarted = new Promise((resolve) => { announceFirst = resolve; });
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const inspections = new Map();
  const store = emptyStore();
  store.listTasks = () => tasks;
  store.getTask = (taskId) => tasks.find((task) => task.id === taskId) ?? null;
  store.listRoles = (taskId) => [role(taskId, "worker")];
  store.getRole = (taskId, roleName) => roleName === "worker" ? role(taskId, roleName) : null;
  store.getActiveAgentRun = (taskId, roleName) => deliveredRun(taskId, roleName);
  const delivery = {
    ...noTmux,
    async inspectRole(input) {
      inspections.set(input.taskId, (inspections.get(input.taskId) ?? 0) + 1);
      if (input.taskId === "task-1" && inspections.get(input.taskId) === 1) {
        announceFirst();
        await firstBlocked;
      }
      return "present";
    }
  };
  const controller = new FileTaskController(store, delivery, { signalWindowMs: 1 });

  controller.signal("role:task-1/worker");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await firstStarted;
  controller.signal("role:task-2/worker");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const full = controller.pump();
  releaseFirst();
  await full;

  assert.equal(inspections.get("task-1"), 2);
  assert.equal(inspections.get("task-2"), 1);
  controller.stop();
});

test("Controller schedules recommended InputRequest deadlines independently of recovery scans", async () => {
  const deadline = Date.now() + 20;
  let open = true;
  const resolutionScopes = [];
  const store = emptyStore();
  store.listOpenInputRequests = () => open
    ? [{ id: "input-1", taskId: "task-1", policy: {
        kind: "recommended", recommendedChoiceKey: "safe",
        timeoutAt: new Date(deadline).toISOString()
      } }]
    : [];
  store.resolveExpiredInputRecommendations = (now, taskIds) => {
    resolutionScopes.push(taskIds === undefined ? "full" : [...taskIds]);
    if (now.getTime() >= deadline) open = false;
    return [];
  };
  const controller = new FileTaskController(store, noTmux, { intervalMs: 60_000 });

  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(open, false);
  assert.equal(resolutionScopes[0], "full");
  assert.deepEqual(resolutionScopes.find((scope) => Array.isArray(scope)), ["task-1"]);
  controller.stop();
});

function role(taskId, name) {
  return {
    taskId, name, activeAgentId: `codex-${name}`, adapterId: "codex", status: "running"
  };
}

function deliveredRun(taskId, roleName) {
  const at = new Date(0).toISOString();
  return {
    schemaVersion: 1, id: `run-${taskId}-${roleName}`, taskId, roleName,
    mode: "new", input: "work", status: "active", deliveredAt: at,
    createdAt: at, updatedAt: at
  };
}

test("a stopped Controller instance cannot be restarted or accept signals", () => {
  const controller = new FileTaskController(emptyStore(), noTmux);
  controller.stop();
  assert.throws(() => controller.start(), /stopped/i);
  assert.throws(() => controller.signal("task:task-1"), /stopped/i);
});

test("Controller shutdown waits for the in-flight reconciliation to drain", async () => {
  let release;
  let started;
  const blocked = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const store = emptyStore();
  store.listTasks = () => [{ id: "task-1", status: "active" }];
  store.listRoles = () => [role("task-1", "worker")];
  store.getActiveAgentRun = () => deliveredRun("task-1", "worker");
  const delivery = {
    ...noTmux,
    async inspectRole() {
      started();
      await blocked;
      return "present";
    }
  };
  const controller = new FileTaskController(store, delivery);
  const pass = controller.pump();
  await entered;
  let drained = false;
  const shutdown = controller.shutdownAndDrain().then(() => { drained = true; });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(drained, false);
  release();
  await Promise.all([pass, shutdown]);
  assert.equal(drained, true);
});

test("background FileTask controller exposes status, scan and stop on one private home socket", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-file-controller-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const controller = await startFileTaskController(home, emptyStore(), noTmux, undefined, {
    intervalMs: 60_000
  });

  const status = await callController(home, "controller.status", {});
  assert.equal(status.running, true);
  assert.equal(status.pid, process.pid);
  assert.deepEqual(
    await callController(home, "scheduler.signal", { key: "task:task-1" }),
    { accepted: true }
  );
  assert.deepEqual(await callController(home, "scheduler.scan", {}), {
    stoppedArchivedTaskIds: [],
    activeRunDeliveries: [],
    failedRunIds: [],
    wakeups: [],
    inputNotifications: [],
    autoResolvedInputs: []
  });
  assert.deepEqual(await callController(home, "scheduler.configure", {
    reconciliationIntervalSeconds: 45
  }), {
    configured: true,
    reconciliationIntervalMs: 45_000
  });
  assert.equal(controller.runtime.reconciliationIntervalMs, 45_000);
  assert.deepEqual(await callController(home, "controller.stop", {}), { stopped: true });
  await controller.closed;
});

test("Controller stop keeps discovery owned until in-flight work has drained", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-file-controller-drain-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let release;
  let started;
  const blocked = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const store = emptyStore();
  store.listTasks = () => [{ id: "task-1", status: "active" }];
  store.listRoles = () => [role("task-1", "worker")];
  store.getActiveAgentRun = () => deliveredRun("task-1", "worker");
  const delivery = {
    ...noTmux,
    async inspectRole() {
      started();
      await blocked;
      return "present";
    }
  };
  const controller = await startFileTaskController(home, store, delivery, undefined, {
    intervalMs: 60_000
  });
  await entered;

  assert.deepEqual(await callController(home, "controller.stop", {}), { stopped: true });
  assert.equal((await readControllerDiscovery(home)).pid, process.pid);
  release();
  await controller.closed;
  await assert.rejects(readControllerDiscovery(home), /not running/i);
});

test("production FileTask controller composition starts without compact SQLite runtime", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-file-runtime-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const sessionHost = {
    async start() { throw new Error("unused"); },
    async resume() { throw new Error("unused"); },
    async stop() {},
    async inspect() { return { state: "unavailable" }; }
  };
  const promptPush = { async tryPush() { return "unavailable"; } };
  const controller = await startFileTaskControllerRuntime(home, {
    intervalMs: 60_000,
    sessionHost,
    promptPush
  });

  assert.equal((await callController(home, "controller.status", {})).running, true);
  assert.equal(controller.store.rootDirectory(), home);
  assert.equal(controller.runtime.reconciliationIntervalMs, 60_000);
  assert.equal(controller.sessionHost, sessionHost);
  assert.equal(controller.promptPush, promptPush);
  await controller.close();
});

test("production Controller reads reconciliationIntervalSeconds from Yui config", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-file-runtime-config-"));
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

  const result = await restartFileTaskController("/tmp/yui-restart-test", {
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
