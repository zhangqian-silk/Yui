import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { FILE_TASK_CONTROLLER_PROTOCOL_VERSION } from "../../dist/core/protocol.js";
import { YUI_VERSION, yuiVersionIdentity } from "../../dist/version.js";
import {
  FileTaskWorkflowRuntime,
  restartFileTaskController,
  stopFileTaskController
} from "../../dist/controller/clientRuntime.js";
import { startFileTaskControllerRuntime } from "../../dist/controller/runtime.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { testEffectiveLaunch } from "../helpers/effectiveLaunch.js";

function currentControllerStatus(pid) {
  const identity = yuiVersionIdentity();
  return {
    running: true,
    pid,
    protocolVersion: identity.controllerProtocolVersion,
    version: identity.version,
    storageLayoutVersion: identity.storageLayoutVersion,
    aggregateSchemaVersion: identity.aggregateSchemaVersion
  };
}

function emptyStore(events = []) {
  return {
    getPresentationContext() { return { timeZone: "Asia/Shanghai" }; },
    listTasks() { events.push("list-tasks"); return []; },
    getTask() { return null; },
    getTaskWorkspace() { return null; },
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
    peekNextAgentRunId() { return "agent-run-1"; },
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
    saveRoleRunDeliveryFailure() { return "state-changed"; },
    saveLeaderDispatchFailure() {},
    saveExitedRoleRun() {}
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
    activeRunDeliveries: [],
    failedRunRefs: [],
    wakeups: [],
    inputNotifications: [],
    autoResolvedInputs: []
  });
  assert.deepEqual(events, ["list-tasks", "list-tasks", "list-tasks", "list-wakeups"]);
});

test("full controller liveness and stall phases reuse one Role inventory", async () => {
  const task = { id: "task-1", title: "shared inventory", status: "active", projectBindings: [] };
  const role = {
    taskId: task.id,
    name: "worker",
    activeAgentId: "codex",
    adapterId: "codex",
    workspace: "/tmp/work",
    status: "running"
  };
  const run = {
    schemaVersion: 3,
    id: "agent-run-1",
    taskId: task.id,
    roleName: role.name,
    mode: "new",
    input: "work",
    purpose: "execution",
    status: "active",
    effective: testEffectiveLaunch({
      agentId: role.activeAgentId,
      adapterId: role.adapterId,
      workspaceRoot: role.workspace
    }),
    deliveredAt: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  const store = emptyStore();
  const events = [];
  let inventoryCalls = 0;
  let singleInspections = 0;
  store.listTasks = () => [task];
  store.getTask = (id) => id === task.id ? task : null;
  store.listRoles = () => [role];
  store.getRole = (_taskId, name) => name === role.name ? role : null;
  store.getActiveAgentRun = () => run;
  store.getRoleSession = () => ({
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "native-1",
    status: "running",
    effective: run.effective
  });
  store.listEvents = () => events;
  const newerProgressAt = new Date(60_000).toISOString();
  events.push({
    type: "run.progress",
    createdAt: newerProgressAt,
    payload: { runId: run.id, progressAt: newerProgressAt }
  });
  let stallRecords = 0;
  store.recordRoleRunStall = () => {
    stallRecords += 1;
    return "raised";
  };
  store.hasOpenInputRequest = () => false;
  store.getWorkMailbox = () => null;
  store.listPendingWakeups = () => [];
  store.listWorkMailboxes = () => [];
  const delivery = {
    ...noTmux,
    async inspectRole() {
      singleInspections += 1;
      return "present";
    },
    async inspectRoles(inputs, requested) {
      inventoryCalls += 1;
      assert.equal(requested.length, 1);
      const resourceInput = requested[0];
      assert.equal(resourceInput.progressAt, newerProgressAt);
      return inputs.map((input) => ({
        taskId: input.taskId,
        roleName: input.roleName,
        status: "present",
        resource: {
          observedAt: new Date(31 * 60_000).toISOString(),
          progressAt: resourceInput.progressAt,
          identity: {
            taskId: resourceInput.taskId,
            roleName: resourceInput.roleName,
            runId: resourceInput.runId,
            agentId: resourceInput.agentId,
            adapterId: resourceInput.adapterId,
            nativeSessionId: resourceInput.nativeSessionId
          },
          active: true,
          changed: true,
          cpuTimeMs: 20,
          rssBytes: 4096
        }
      }));
    }
  };

  const resourceSuppressionKeys = new Set();
  await runControllerSchedulerPass(
    store,
    delivery,
    new Date(31 * 60_000),
    undefined,
    { kind: "full" },
    true,
    [],
    undefined,
    30 * 60_000,
    resourceSuppressionKeys
  );
  assert.equal(inventoryCalls, 1);
  assert.equal(singleInspections, 0);
  assert.equal(stallRecords, 0);

  // The same advisory sample cannot keep the same stale Run healthy forever.
  await runControllerSchedulerPass(
    store,
    delivery,
    new Date(31 * 60_000),
    undefined,
    { kind: "full" },
    true,
    [],
    undefined,
    30 * 60_000,
    resourceSuppressionKeys
  );
  assert.equal(stallRecords, 1);
});

test("a due native Turn completion forgets the finalized Run preparation", async () => {
  const store = emptyStore();
  store.listPendingRuntimeTurnCompletions = () => [{
    taskId: "task-1",
    roleName: "worker",
    runId: "agent-run-1",
    dueAt: new Date(0).toISOString()
  }];
  store.resolveDueRuntimeTurnCompletions = () => ["task-1/agent-run-1"];
  const forgotten = [];
  const delivery = {
    ...noTmux,
    forgetPrepared(input) { forgotten.push(input); }
  };

  await runControllerSchedulerPass(
    store,
    delivery,
    new Date(1),
    undefined,
    { kind: "full" }
  );

  assert.deepEqual(forgotten, [{
    taskId: "task-1",
    roleName: "worker",
    runId: "agent-run-1"
  }]);
});

test("a finalized local Run ref forgets only its owning Task preparation", async () => {
  const store = emptyStore();
  store.listPendingRuntimeTurnCompletions = () => ["task-1", "task-2"].map(
    (taskId) => ({
      taskId,
      roleName: "worker",
      runId: "agent-run-1",
      dueAt: new Date(0).toISOString()
    })
  );
  store.resolveDueRuntimeTurnCompletions = () => ["task-1/agent-run-1"];
  const forgotten = [];

  await runControllerSchedulerPass(store, {
    ...noTmux,
    forgetPrepared(input) { forgotten.push(input); }
  }, new Date(1), undefined, { kind: "full" });

  assert.deepEqual(forgotten, [{
    taskId: "task-1",
    roleName: "worker",
    runId: "agent-run-1"
  }]);
});

test("periodic recovery skips active workspace scans without durable Task work", async () => {
  const events = [];
  const workspacePreparer = {
  };
  await runControllerSchedulerPass(
    emptyStore(events),
    noTmux,
    new Date(0),
    workspacePreparer
  );
  assert.deepEqual(events, [
    "list-tasks", "list-tasks", "list-tasks", "list-tasks", "list-wakeups"
  ]);
});

test("full recovery inventories dormant Task and global sessions once and stops only confirmed absences", async () => {
  const taskCandidate = {
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "codex-task",
    adapterId: "codex",
    nativeSessionId: "thread-task",
    sessionUpdatedAt: new Date(0).toISOString()
  };
  const globalCandidate = {
    owner: { scope: "global", roleName: "operator" },
    agentId: "codex-global",
    adapterId: "codex",
    nativeSessionId: "thread-global",
    sessionUpdatedAt: new Date(0).toISOString()
  };
  const store = emptyStore();
  const marked = [];
  let candidateScans = 0;
  store.listDormantRuntimeOwners = () => {
    candidateScans += 1;
    return [taskCandidate, globalCandidate];
  };
  store.markRuntimeOwnerStopped = (candidate) => {
    marked.push(candidate);
    return true;
  };
  let inventoryCalls = 0;
  const lifecycleHost = {
    async inspectOwner() { throw new Error("batch inventory must be used"); },
    async inspectOwners(owners) {
      inventoryCalls += 1;
      assert.deepEqual(owners, [taskCandidate.owner, globalCandidate.owner]);
      return [
        { owner: taskCandidate.owner, inspection: { state: "stopped" } },
        { owner: globalCandidate.owner, inspection: { state: "running" } }
      ];
    },
    async stopOwner() { throw new Error("unused"); }
  };

  await runControllerSchedulerPass(
    store,
    noTmux,
    new Date(1),
    undefined,
    { kind: "full" },
    true,
    [],
    lifecycleHost
  );

  assert.equal(candidateScans, 1);
  assert.equal(inventoryCalls, 1);
  assert.deepEqual(marked, [taskCandidate]);
});

test("dirty recovery never performs the dormant native-session inventory", async () => {
  const store = emptyStore();
  store.listDormantRuntimeOwners = () => {
    throw new Error("dirty reconciliation must not scan dormant sessions");
  };
  const lifecycleHost = {
    async inspectOwner() { throw new Error("unused"); },
    async inspectOwners() { throw new Error("unused"); },
    async stopOwner() { throw new Error("unused"); }
  };

  await runControllerSchedulerPass(
    store,
    noTmux,
    new Date(1),
    undefined,
    { kind: "dirty", keys: ["role:task-1/leader"] },
    true,
    [],
    lifecycleHost
  );
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
  store.getTask = () => ({ id: "task-1", status: "active", projectBindings: [] });
  store.getWorkMailbox = () => mailbox;
  store.claimWorkMailbox = () => { calls.push("claim"); return { status: "claimed", processing }; };
  store.completeWorkMailbox = (_target, batchId) => { calls.push(`complete:${batchId}`); return true; };
  const workspace = {
    async prepareTaskWorkspace() { calls.push("workspace"); return { taskId: "task-1", status: "ready" }; },
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
  store.getTask = () => ({ id: "task-1", status: "active", projectBindings: [] });
  store.getWorkMailbox = () => ({
    schemaVersion: 1, target, nextSequence: 2, processing: null, pending: batch
  });
  store.claimWorkMailbox = () => ({ status: "claimed", processing });
  let released = null;
  store.releaseWorkMailbox = (_target, batchId) => { released = batchId; return true; };
  const workspace = {
    async prepareTaskWorkspace() { throw new Error("workspace failed"); },
  };

  await runControllerSchedulerPass(store, noTmux, new Date(0), workspace, {
    kind: "dirty", keys: ["task:task-1"]
  });
  assert.equal(released, "task:task-1:1-1");
});

test("a main full pass never consumes the Operator mailbox", async () => {
  const store = emptyStore();
  store.getWorkMailbox = (target) => {
    if (target.kind === "operator") {
      throw new Error("Operator mailbox belongs to the Operator lane");
    }
    return null;
  };

  await runControllerSchedulerPass(
    store,
    noTmux,
    new Date(0),
    undefined,
    { kind: "full" },
    false
  );
});

test("dirty reconciliation does not synthesize an orphan Leader wake", async () => {
  const saved = [];
  const store = emptyStore();
  store.getTask = () => ({ id: "task-1", status: "active", projectBindings: [] });
  store.savePendingWakeup = (wakeup) => saved.push(wakeup);

  await runControllerSchedulerPass(store, noTmux, new Date(0), undefined, {
    kind: "dirty",
    keys: ["role:task-1/worker"]
  });

  assert.deepEqual(saved, []);
});

test("failed stale Role cleanup is released and retried before normal scheduling", async () => {
  const target = { kind: "role-runtime", taskId: "task-1", roleName: "worker" };
  const batch = {
    fromSequence: 1, toSequence: 1, reasons: ["runtime-cleanup-required"],
    refs: [{ type: "role", id: "worker" }], requestCount: 1,
    firstQueuedAt: new Date(0).toISOString(),
    lastQueuedAt: new Date(0).toISOString()
  };
  let mailbox = {
    schemaVersion: 1, target, nextSequence: 2, processing: null, pending: batch
  };
  let stopCalls = 0;
  let secondStop;
  const secondStopped = new Promise((resolve) => { secondStop = resolve; });
  const store = emptyStore();
  store.getTask = () => ({ id: "task-1", status: "active", projectBindings: [] });
  store.getRole = () => role("task-1", "worker");
  store.getWorkMailbox = (mailboxTarget) => (
    mailboxTarget.kind === "role-runtime" ? mailbox : null
  );
  store.claimWorkMailbox = ({ batchId, owner, now, executionRef }) => {
    if (mailbox.processing !== null) {
      return { status: "processing", processing: mailbox.processing };
    }
    if (mailbox.pending === null) return { status: "empty" };
    mailbox = {
      ...mailbox,
      pending: null,
      processing: {
        batchId, batch: mailbox.pending, owner, startedAt: now.toISOString(),
        ...(executionRef === undefined ? {} : { executionRef })
      }
    };
    return { status: "claimed", processing: mailbox.processing };
  };
  store.releaseWorkMailbox = (_target, batchId) => {
    if (mailbox.processing?.batchId !== batchId) return false;
    mailbox = { ...mailbox, pending: mailbox.processing.batch, processing: null };
    return true;
  };
  store.completeWorkMailbox = (_target, batchId) => {
    if (mailbox.processing?.batchId !== batchId) return false;
    mailbox = { ...mailbox, processing: null };
    return true;
  };
  store.completeRuntimeCleanup = () => {
    if (mailbox.pending === null && mailbox.processing === null) return false;
    mailbox = { ...mailbox, pending: null, processing: null };
    return true;
  };
  const lifecycleHost = {
    async stopOwner() {
      stopCalls += 1;
      if (stopCalls === 1) throw new Error("tmux is temporarily unavailable");
      secondStop();
      return true;
    },
    async inspectOwner() { throw new Error("unused"); }
  };
  const controller = new FileTaskController(store, noTmux, {
    signalWindowMs: 1,
    deliveryRetryMs: 2,
    deliveryRetryLimit: 2,
    onError() {},
    lifecycleHost
  });

  controller.signal("role:task-1/worker");
  let timeout;
  await Promise.race([
    secondStopped,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Controller did not retry stale Role cleanup.")),
        1_000
      );
    })
  ]);
  clearTimeout(timeout);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stopCalls, 2);
  assert.equal(mailbox.pending, null);
  assert.equal(mailbox.processing, null);
  controller.stop();
});

test("one stale Role cleanup failure does not block another Role delivery", async () => {
  const tasks = new Map([
    ["task-cleanup", gitlessTask("task-cleanup")],
    ["task-delivery", gitlessTask("task-delivery")]
  ]);
  const roles = new Map([
    ["task-cleanup\0worker", role("task-cleanup", "worker")],
    ["task-delivery\0worker", role("task-delivery", "worker")]
  ]);
  const cleanupTarget = {
    kind: "role-runtime", taskId: "task-cleanup", roleName: "worker"
  };
  const deliveryTarget = {
    kind: "role", taskId: "task-delivery", roleName: "worker"
  };
  const cleanupBatch = {
    fromSequence: 1, toSequence: 1, reasons: ["runtime-cleanup-required"],
    refs: [{ type: "role", id: "worker" }], requestCount: 1,
    firstQueuedAt: new Date(0).toISOString(),
    lastQueuedAt: new Date(0).toISOString()
  };
  const deliveryBatch = {
    fromSequence: 1, toSequence: 1, reasons: ["run-dispatched"],
    refs: [{ type: "run", taskId: "task-delivery", id: "agent-run-91" }], requestCount: 1,
    firstQueuedAt: new Date(0).toISOString(),
    lastQueuedAt: new Date(0).toISOString()
  };
  const mailboxKey = (target) => `${target.kind}\0${target.taskId}\0${target.roleName}`;
  const mailboxes = new Map([
    [mailboxKey(cleanupTarget), {
      schemaVersion: 1, target: cleanupTarget, nextSequence: 2,
      processing: null, pending: cleanupBatch
    }],
    [mailboxKey(deliveryTarget), {
      schemaVersion: 1, target: deliveryTarget, nextSequence: 2,
      processing: null, pending: deliveryBatch
    }]
  ]);
  let run = {
    ...deliveredRun("task-delivery", "worker"),
    pushedAt: undefined,
    deliveredAt: undefined
  };
  const events = [];
  const store = emptyStore();
  store.getTask = (taskId) => tasks.get(taskId) ?? null;
  store.getTaskWorkspace = (taskId) => taskOwnedWorkspace(tasks.get(taskId));
  store.getRole = (taskId, roleName) => roles.get(`${taskId}\0${roleName}`) ?? null;
  store.getActiveAgentRun = (taskId) => (
    taskId === "task-delivery" ? run : null
  );
  store.getWorkMailbox = (target) => mailboxes.get(mailboxKey(target)) ?? null;
  store.claimWorkMailbox = ({ target, batchId, owner, now, executionRef }) => {
    const key = mailboxKey(target);
    const mailbox = mailboxes.get(key);
    if (mailbox === undefined || mailbox.pending === null) {
      return mailbox?.processing === null || mailbox === undefined
        ? { status: "empty" }
        : { status: "processing", processing: mailbox.processing };
    }
    const processing = {
      batchId, batch: mailbox.pending, owner, startedAt: now.toISOString(),
      ...(executionRef === undefined ? {} : { executionRef })
    };
    mailboxes.set(key, { ...mailbox, pending: null, processing });
    return { status: "claimed", processing };
  };
  store.releaseWorkMailbox = (target, batchId) => {
    const key = mailboxKey(target);
    const mailbox = mailboxes.get(key);
    if (mailbox?.processing?.batchId !== batchId) return false;
    mailboxes.set(key, {
      ...mailbox, pending: mailbox.processing.batch, processing: null
    });
    return true;
  };
  store.completeRuntimeCleanup = () => {
    throw new Error("failed cleanup must not be acknowledged");
  };
  store.saveRoleRunPrepared = () => {};
  store.saveRoleRunDelivery = ({ now }) => {
    run = { ...run, pushedAt: now.toISOString() };
    const mailbox = mailboxes.get(mailboxKey(deliveryTarget));
    mailboxes.set(mailboxKey(deliveryTarget), {
      ...mailbox, processing: null
    });
  };
  const lifecycleHost = {
    async stopOwner(owner) {
      events.push(`stop:${owner.taskId}`);
      throw new Error("cleanup A failed");
    },
    async inspectOwner() { throw new Error("unused"); }
  };
  const delivery = {
    ...noTmux,
    async prepareRoleSession(input) {
      events.push(`prepare:${input.taskId}`);
      return { ...input, deliveryId: "delivery-b", sessionStarted: true };
    },
    async waitUntilReady(prepared) { return { prepared, session: null }; },
    async sendOnce({ delivery: { prepared } }) {
      events.push(`send:${prepared.taskId}`);
      return "sent";
    },
    async inspectRole() { return "present"; }
  };

  const result = await runControllerSchedulerPass(
    store,
    delivery,
    new Date(1),
    undefined,
    {
      kind: "dirty",
      keys: [
        "role:task-cleanup/worker",
        "role:task-delivery/worker"
      ]
    },
    true,
    [],
    lifecycleHost
  );

  assert.deepEqual(events, [
    "stop:task-cleanup",
    "prepare:task-delivery",
    "send:task-delivery"
  ]);
  assert.deepEqual(result.activeRunDeliveries, [{
    taskId: "task-delivery",
    roleName: "worker",
    runId: run.id,
    status: "delivered"
  }]);
  assert.equal(
    mailboxes.get(mailboxKey(cleanupTarget)).pending,
    cleanupBatch
  );
  assert.equal(run.pushedAt, new Date(1).toISOString());
});

test("Task and global cleanup obligations supersede launch reservations atomically", async () => {
  const targets = [
    { kind: "role-runtime", taskId: "task-1", roleName: "worker" },
    { kind: "global-role-runtime", roleName: "operator" }
  ];
  const key = (target) => target.kind === "role-runtime"
    ? `task:${target.taskId}/${target.roleName}`
    : `global:${target.roleName}`;
  const reservationBatch = {
    fromSequence: 1, toSequence: 1, reasons: ["runtime-launch-reserved"],
    refs: [], requestCount: 1,
    firstQueuedAt: new Date(0).toISOString(),
    lastQueuedAt: new Date(0).toISOString()
  };
  const cleanupBatch = {
    fromSequence: 2, toSequence: 2, reasons: ["runtime-cleanup-required"],
    refs: [], requestCount: 1,
    firstQueuedAt: new Date(1).toISOString(),
    lastQueuedAt: new Date(1).toISOString()
  };
  const mailboxes = new Map(targets.map((target) => [key(target), {
    schemaVersion: 1,
    target,
    nextSequence: 3,
    processing: {
      batchId: `launch:${key(target)}`,
      batch: reservationBatch,
      owner: "runtime-lifecycle",
      startedAt: new Date(0).toISOString()
    },
    pending: cleanupBatch
  }]));
  const stopped = [];
  const store = emptyStore();
  store.getTask = () => ({ id: "task-1", status: "active", projectBindings: [] });
  store.getRole = () => role("task-1", "worker");
  store.getWorkMailbox = (target) => mailboxes.get(key(target)) ?? null;
  store.completeRuntimeCleanup = (target) => {
    const mailbox = mailboxes.get(key(target));
    if (mailbox === undefined || mailbox.pending === null) return false;
    mailboxes.set(key(target), { ...mailbox, processing: null, pending: null });
    return true;
  };
  const lifecycleHost = {
    async stopOwner(owner) {
      stopped.push(owner);
      return true;
    },
    async inspectOwner() { throw new Error("unused"); }
  };
  const forgotten = [];
  const delivery = {
    ...noTmux,
    forgetPrepared(input) { forgotten.push(input); }
  };

  await runControllerSchedulerPass(
    store,
    delivery,
    new Date(2),
    undefined,
    {
      kind: "dirty",
      keys: ["role:task-1/worker", "global-role:operator"]
    },
    true,
    [],
    lifecycleHost
  );

  assert.deepEqual(stopped, [
    { scope: "task", taskId: "task-1", roleName: "worker" },
    { scope: "global", roleName: "operator" }
  ]);
  assert.deepEqual(forgotten, [{
    taskId: "task-1",
    roleName: "worker"
  }]);
  for (const target of targets) {
    assert.equal(mailboxes.get(key(target)).processing, null);
    assert.equal(mailboxes.get(key(target)).pending, null);
  }
});

test("full recovery probes old reservations without stopping a healthy host", async () => {
  const runningTarget = { kind: "global-role-runtime", roleName: "operator" };
  const stoppedTarget = { kind: "global-role-runtime", roleName: "reviewer" };
  const reservation = (target) => ({
    schemaVersion: 1,
    target,
    nextSequence: 2,
    processing: {
      batchId: `launch:${target.roleName}`,
      batch: {
        fromSequence: 1, toSequence: 1, reasons: ["runtime-launch-reserved"],
        refs: [], requestCount: 1,
        firstQueuedAt: new Date(0).toISOString(),
        lastQueuedAt: new Date(0).toISOString()
      },
      owner: "runtime-lifecycle",
      startedAt: new Date(0).toISOString()
    },
    pending: null
  });
  const mailboxes = new Map([
    [runningTarget.roleName, reservation(runningTarget)],
    [stoppedTarget.roleName, reservation(stoppedTarget)]
  ]);
  const inspected = [];
  const store = emptyStore();
  store.listWorkMailboxes = () => [...mailboxes.values()];
  store.getWorkMailbox = (target) => target.kind === "global-role-runtime"
    ? mailboxes.get(target.roleName) ?? null
    : null;
  store.completeWorkMailbox = (target, batchId) => {
    const mailbox = mailboxes.get(target.roleName);
    if (mailbox?.processing?.batchId !== batchId) return false;
    mailboxes.set(target.roleName, { ...mailbox, processing: null });
    return true;
  };
  const lifecycleHost = {
    async inspectOwner(owner) {
      inspected.push(owner);
      return {
        state: owner.roleName === runningTarget.roleName ? "running" : "stopped"
      };
    },
    async stopOwner() {
      throw new Error("reservation-only recovery must not kill a host");
    }
  };

  await runControllerSchedulerPass(
    store,
    noTmux,
    new Date(120_001),
    undefined,
    { kind: "full" },
    false,
    [],
    lifecycleHost
  );

  assert.deepEqual(inspected, [
    { scope: "global", roleName: "operator" },
    { scope: "global", roleName: "reviewer" }
  ]);
  assert.notEqual(mailboxes.get(runningTarget.roleName).processing, null);
  assert.equal(mailboxes.get(stoppedTarget.roleName).processing, null);
});

test("an unavailable stale reservation is re-inspected by its exact dirty retry", async () => {
  const target = { kind: "global-role-runtime", roleName: "operator" };
  let mailbox = {
    schemaVersion: 1,
    target,
    nextSequence: 2,
    processing: {
      batchId: "launch-stale",
      batch: {
        fromSequence: 1, toSequence: 1,
        reasons: ["runtime-launch-reserved"], refs: [], requestCount: 1,
        firstQueuedAt: new Date(0).toISOString(),
        lastQueuedAt: new Date(0).toISOString()
      },
      owner: "runtime-lifecycle",
      startedAt: new Date(0).toISOString()
    },
    pending: null
  };
  const store = emptyStore();
  store.listWorkMailboxes = () => mailbox === null ? [] : [mailbox];
  store.getWorkMailbox = (mailboxTarget) => (
    mailboxTarget.kind === "global-role-runtime" ? mailbox : null
  );
  let completionBatchId;
  store.completeStoppedRuntimeReservation = (_target, batchId) => {
    if (mailbox?.processing?.batchId !== batchId) return false;
    completionBatchId = batchId;
    mailbox = null;
    return true;
  };
  let inspections = 0;
  let resolveStopped;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });
  const lifecycleHost = {
    async inspectOwner(owner) {
      assert.deepEqual(owner, { scope: "global", roleName: "operator" });
      inspections += 1;
      if (inspections === 1) return { state: "unavailable" };
      resolveStopped();
      return { state: "stopped" };
    },
    async stopOwner() { throw new Error("reservation recovery must not kill"); }
  };
  const controller = new FileTaskController(store, noTmux, {
    now: () => new Date(120_001),
    signalWindowMs: 1,
    deliveryRetryMs: 2,
    deliveryRetryLimit: 2,
    lifecycleHost,
    onError() {}
  });

  await controller.pump();
  let timeout;
  await Promise.race([
    stopped,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("stale reservation dirty retry did not run")),
        1_000
      );
    })
  ]);
  clearTimeout(timeout);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(inspections, 2);
  assert.equal(completionBatchId, "launch-stale");
  assert.equal(mailbox, null);
  controller.stop();
});

test("global Role cleanup retries on its own key without consuming Operator work", async () => {
  const target = { kind: "global-role-runtime", roleName: "operator" };
  const batch = {
    fromSequence: 1, toSequence: 1, reasons: ["runtime-cleanup-required"],
    refs: [], requestCount: 1,
    firstQueuedAt: new Date(0).toISOString(),
    lastQueuedAt: new Date(0).toISOString()
  };
  let mailbox = {
    schemaVersion: 1, target, nextSequence: 2, processing: null, pending: batch
  };
  let stopCalls = 0;
  let operatorReads = 0;
  let resolveStopped;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });
  const store = emptyStore();
  store.getWorkMailbox = (mailboxTarget) => {
    if (mailboxTarget.kind === "operator") {
      operatorReads += 1;
      return null;
    }
    return mailboxTarget.kind === "global-role-runtime" ? mailbox : null;
  };
  store.completeRuntimeCleanup = () => {
    mailbox = { ...mailbox, pending: null, processing: null };
    return true;
  };
  const lifecycleHost = {
    async stopOwner(owner) {
      assert.deepEqual(owner, { scope: "global", roleName: "operator" });
      stopCalls += 1;
      if (stopCalls === 1) return false;
      resolveStopped();
      return true;
    },
    async inspectOwner() { throw new Error("unused"); }
  };
  const controller = new FileTaskController(store, noTmux, {
    signalWindowMs: 1,
    deliveryRetryMs: 2,
    deliveryRetryLimit: 2,
    onError() {},
    lifecycleHost
  });

  controller.signal("global-role:operator");
  let timeout;
  await Promise.race([
    stopped,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("global Role cleanup retry did not run")),
        1_000
      );
    })
  ]);
  clearTimeout(timeout);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stopCalls, 2);
  assert.ok(operatorReads >= 1);
  assert.equal(mailbox.pending, null);
  assert.equal(mailbox.processing, null);
  controller.stop();
});

test("stale Role cleanup finishes before a concurrently queued Run may launch", async () => {
  const task = gitlessTask("task-1");
  const roleValue = role(task.id, "worker");
  const cleanupTarget = {
    kind: "role-runtime", taskId: task.id, roleName: roleValue.name
  };
  const runTarget = { kind: "role", taskId: task.id, roleName: roleValue.name };
  const cleanupBatch = {
    fromSequence: 1, toSequence: 1, reasons: ["runtime-cleanup-required"],
    refs: [{ type: "role", id: roleValue.name }], requestCount: 1,
    firstQueuedAt: new Date(0).toISOString(),
    lastQueuedAt: new Date(0).toISOString()
  };
  const runBatch = {
    fromSequence: 2, toSequence: 2, reasons: ["run-dispatched"],
    refs: [{ type: "run", taskId: task.id, id: "agent-run-92" }], requestCount: 1,
    firstQueuedAt: new Date(1).toISOString(),
    lastQueuedAt: new Date(1).toISOString()
  };
  let cleanupMailbox = {
    schemaVersion: 1, target: cleanupTarget, nextSequence: 2,
    processing: null, pending: cleanupBatch
  };
  let runMailbox = {
    schemaVersion: 1, target: runTarget, nextSequence: 2,
    processing: null, pending: null
  };
  let run = null;
  let releaseStop;
  let announceStop;
  const stopBlocked = new Promise((resolve) => { releaseStop = resolve; });
  const stopStarted = new Promise((resolve) => { announceStop = resolve; });
  const events = [];
  const store = emptyStore();
  store.getTask = () => task;
  store.getTaskWorkspace = () => taskOwnedWorkspace(task);
  store.getRole = () => roleValue;
  store.getActiveAgentRun = () => run;
  store.getWorkMailbox = (mailboxTarget) => {
    if (mailboxTarget.kind === "role-runtime") return cleanupMailbox;
    if (mailboxTarget.kind === "role") return runMailbox;
    return null;
  };
  store.claimWorkMailbox = ({ target, batchId, owner, now, executionRef }) => {
    let mailbox = target.kind === "role-runtime" ? cleanupMailbox : runMailbox;
    if (mailbox.processing !== null) {
      return { status: "processing", processing: mailbox.processing };
    }
    if (mailbox.pending === null) return { status: "empty" };
    mailbox = {
      ...mailbox,
      pending: null,
      processing: {
        batchId, batch: mailbox.pending, owner, startedAt: now.toISOString(),
        ...(executionRef === undefined ? {} : { executionRef })
      }
    };
    if (target.kind === "role-runtime") cleanupMailbox = mailbox;
    else runMailbox = mailbox;
    return { status: "claimed", processing: mailbox.processing };
  };
  store.completeWorkMailbox = (target, batchId) => {
    let mailbox = target.kind === "role-runtime" ? cleanupMailbox : runMailbox;
    if (mailbox.processing?.batchId !== batchId) return false;
    mailbox = { ...mailbox, processing: null };
    if (target.kind === "role-runtime") cleanupMailbox = mailbox;
    else runMailbox = mailbox;
    return true;
  };
  store.completeRuntimeCleanup = () => {
    cleanupMailbox = { ...cleanupMailbox, pending: null, processing: null };
    return true;
  };
  store.releaseWorkMailbox = () => false;
  store.saveRoleRunPrepared = () => {};
  store.saveRoleRunDelivery = ({ now }) => {
    run = { ...run, pushedAt: now.toISOString() };
    runMailbox = { ...runMailbox, processing: null };
  };
  const lifecycleHost = {
    async stopOwner() {
      events.push("stop-started");
      announceStop();
      await stopBlocked;
      events.push("stop-finished");
      return true;
    },
    async inspectOwner() { throw new Error("unused"); }
  };
  const delivery = {
    ...noTmux,
    async prepareRoleSession(input) {
      events.push("prepare-new");
      return { ...input, deliveryId: "delivery-new", sessionStarted: true };
    },
    async waitUntilReady(prepared) { return { prepared, session: null }; },
    async sendOnce() { events.push("send-new"); return "sent"; },
    async inspectRole() { return "present"; }
  };

  const pass = runControllerSchedulerPass(
    store,
    delivery,
    new Date(2),
    undefined,
    {
      kind: "dirty",
      keys: ["role:task-1/worker"]
    },
    true,
    [],
    lifecycleHost
  );
  await stopStarted;
  run = {
    ...deliveredRun(task.id, roleValue.name),
    id: "agent-run-92",
    pushedAt: undefined,
    deliveredAt: undefined
  };
  runMailbox = { ...runMailbox, pending: runBatch, nextSequence: 3 };
  assert.deepEqual(events, ["stop-started"]);

  releaseStop();
  await pass;

  assert.deepEqual(events, [
    "stop-started",
    "stop-finished",
    "prepare-new",
    "send-new"
  ]);
  assert.notEqual(run.pushedAt, undefined);
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
  store.listTasks = () => targets.map(({ taskId }) => ({
    id: taskId,
    status: "active",
    projectBindings: []
  }));
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
  };

  await runControllerSchedulerPass(store, noTmux, new Date(0), workspace);

  assert.deepEqual(settled, ["complete:task-ok", "release:task-failed"]);
});

test("controller delivers a queued Work AgentRun through tmux before liveness", async () => {
  const events = [];
  const task = gitlessTask("task-1");
  const role = {
    taskId: task.id,
    name: "worker",
    activeAgentId: "codex",
    adapterId: "codex",
    effective: testEffectiveLaunch({ agentId: "codex" }),
    workspace: "/fixture/workspace",
    status: "running"
  };
  const run = {
    schemaVersion: 6,
    id: "agent-run-1",
    taskId: task.id,
    roleName: role.name,
    mode: "new",
    input: "implement it",
    purpose: "execution",
    effective: testEffectiveLaunch({ agentId: "codex" }),
    workItemId: "work-item-1",
    status: "active",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  const store = emptyStore();
  store.listTasks = () => [task];
  store.getTask = (taskId) => taskId === task.id ? task : null;
  store.getTaskWorkspace = () => taskOwnedWorkspace(task);
  store.listRoles = () => [role];
  store.getActiveAgentRun = () => run;
  store.claimWorkMailbox = () => ({
    status: "claimed",
    processing: {
      batchId: `agent-run:${task.id}/${run.id}`,
      batch: {
        fromSequence: 1, toSequence: 1, reasons: ["work-dispatched"],
        refs: [{ type: "run", taskId: task.id, id: run.id }],
        requestCount: 1, firstQueuedAt: new Date(0).toISOString(), lastQueuedAt: new Date(0).toISOString()
      },
      owner: "controller",
      startedAt: new Date(0).toISOString(),
      executionRef: { type: "run", taskId: task.id, id: run.id }
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
    "ready",
    "send:agent-run:task-1/agent-run-1:implement it",
    "persist:agent-run-1",
    "inspect"
  ]);
});

test("archived Tasks do not trigger implicit Controller runtime cleanup", async () => {
  const task = { id: "task-archived", status: "archived", projectBindings: [] };
  const calls = [];
  const store = emptyStore();
  store.listTasks = () => [task];
  store.getTask = (taskId) => taskId === task.id ? task : null;
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

  assert.equal("stoppedArchivedTaskIds" in result, false);
  assert.deepEqual(calls, []);
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

test("dirty Task reconciliation prepares active work without implicit runtime teardown", async () => {
  const events = [];
  const active = { id: "task-active", status: "active", projectBindings: [{ projectId: "project-1" }] };
  const archived = { id: "task-archived", status: "archived", projectBindings: [{ projectId: "project-1" }] };
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
  };
  const delivery = {
    ...noTmux,
    async stopTask() { throw new Error("Controller must not tear down an archived Task"); }
  };

  await runControllerSchedulerPass(store, delivery, new Date(0), workspace, {
    kind: "dirty",
    keys: ["task:task-active", "task:task-archived"]
  });

  assert.equal(events.includes("workspace:task-active"), true);
  assert.equal(events.includes("workspace:task-archived"), false);
  assert.deepEqual(events.filter((event) => event.startsWith("deadlines:")), [
    "deadlines:task-active,task-archived"
  ]);
  assert.deepEqual([...new Set(events.filter((event) => event.startsWith("wake:")))].sort(), [
    "wake:task-active", "wake:task-archived"
  ]);
});

test("dirty Role reconciliation inspects only that Role while retaining the Task Leader closure", async () => {
  const task = { id: "task-1", status: "active", projectBindings: [] };
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
    schemaVersion: 6,
    id: roleName === "worker" ? "agent-run-1" : "agent-run-2",
    taskId: task.id,
    roleName,
    mode: "new",
    input: roleName,
    purpose: "execution",
    status: "active",
    effective: testEffectiveLaunch({ agentId: `codex-${roleName}` }),
    pushedAt: new Date(0).toISOString(),
    deliveredAt: new Date(0).toISOString(),
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
  // The Task pass performs one O(1) mailbox check after it can create
  // Operator attention; the queued Operator-only fold does not rescan it.
  assert.equal(operatorReads, 2);
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
    return [{ id: "task-1", status: "active", projectBindings: [] }];
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
    schemaVersion: 6,
    id: "agent-run-1",
    taskId: "task-1",
    roleName: "worker",
    mode: "new",
    input: "work",
    purpose: "execution",
    status: "active",
    effective: testEffectiveLaunch({ agentId: "codex" }),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  });

  const controller = new FileTaskController(store, delivery);
  const first = controller.pump();
  const joined = controller.pump();
  assert.equal(first, joined);
  releaseFirst();
  await first;

  // Each pass visits queued Work delivery, liveness, and orphan recovery.
  // Unsupported readiness recovery does not add another Task scan.
  assert.equal(listCalls, 6);
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
        if (method === "controller.status") {
          return { running: true, protocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION };
        }
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
    { getTask: () => ({ id: "task-1", status: "active", projectBindings: [] }) },
    {},
    { plan() { throw new Error("CLI planner must not run"); } },
    { ensureRoleWindow() { throw new Error("CLI tmux creator must not run"); } },
    { async prepareTaskWorkspace() { calls.push(["prepare-task-workspace"]); } },
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
    ["prepare-task-workspace"],
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

test("Gitless reconciliation prepares its Task owner before the Controller scan", async () => {
  const events = [];
  let scanCompleted;
  const scanned = new Promise((resolve) => { scanCompleted = resolve; });
  const runtime = new FileTaskWorkflowRuntime(
    "/tmp/yui-gitless-reconcile",
    { getTask: () => ({ id: "task-1", status: "active", projectBindings: [] }) },
    {}, {}, {},
    { async prepareTaskWorkspace() { events.push("prepare"); } },
    {
      call: async (_home, method) => {
        events.push(method);
        if (method === "controller.status") {
          return { running: true, protocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION };
        }
        scanCompleted();
        return {};
      }
    }
  );
  runtime.reconcileTask("task-1");
  await scanCompleted;
  assert.deepEqual(events, ["prepare", "scheduler.scan"]);
});

test("workspace transitions stop the existing Role runtime before changing cwd", async () => {
  const events = [];
  let session = { status: "ready" };
  const runtime = new FileTaskWorkflowRuntime(
    "/tmp/yui-workspace-transition",
    {
      getActiveAgentRun: () => null,
      getRoleSession: () => session,
      getWorkMailbox: () => null
    },
    {
      enqueueRuntimeCleanup(owner) {
        events.push(["enqueue", owner]);
        return { kind: "role-runtime", taskId: owner.taskId, roleName: owner.roleName };
      }
    },
    {},
    {},
    undefined,
    {
      call: async (_home, method, params) => {
        events.push([method, params]);
        session = { status: "stopped" };
        return {};
      }
    }
  );

  await runtime.stopTaskRoleSessions("task-1", ["worker"]);

  assert.deepEqual(events, [
    ["enqueue", { scope: "task", taskId: "task-1", roleName: "worker" }],
    ["scheduler.scan", {}]
  ]);
});

test("Operator session transitions stop the one global runtime before changing history", async () => {
  const events = [];
  let session = { status: "ready" };
  const runtime = new FileTaskWorkflowRuntime(
    "/tmp/yui-operator-session-transition",
    {
      getGlobalRole: () => ({ name: "operator" }),
      getGlobalRoleSessionSet: () => ({
        activeAgentId: "codex",
        sessions: { codex: session }
      }),
      getWorkMailbox: () => null
    },
    {
      enqueueRuntimeCleanup(owner) {
        events.push(["enqueue", owner]);
        return { kind: "global-role-runtime", roleName: owner.roleName };
      }
    },
    {},
    {},
    undefined,
    {
      call: async (_home, method, params) => {
        events.push([method, params]);
        session = { status: "stopped" };
        return {};
      }
    }
  );

  await runtime.stopGlobalRoleSession("operator");

  assert.deepEqual(events, [
    ["enqueue", { scope: "global", roleName: "operator" }],
    ["scheduler.scan", {}]
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
      { getTask: () => ({ id: "task-1", status, projectBindings: [{ projectId: "project-1" }] }) },
      {},
      {},
      {},
      { async prepareTaskWorkspace() { events.push("prepare"); return { taskId: "task-1", status: "ready" }; } },
      {
        call: async (_home, method) => {
          events.push(method);
          if (method === "controller.status") {
            return { running: true, protocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION };
          }
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

test("a failed Task workspace is retried without starving peers and stops at the retry bound", async () => {
  const target = { kind: "task", taskId: "task-1" };
  const batch = {
    fromSequence: 1, toSequence: 1, reasons: ["task-updated"], refs: [],
    requestCount: 1, firstQueuedAt: new Date(0).toISOString(),
    lastQueuedAt: new Date(0).toISOString()
  };
  let mailbox = {
    schemaVersion: 1, target, nextSequence: 2, processing: null, pending: batch
  };
  let attempts = 0;
  const store = emptyStore();
  store.getTask = () => ({ id: "task-1", status: "active", projectBindings: [] });
  store.getWorkMailbox = (mailboxTarget) => (
    mailboxTarget.kind === "task" ? mailbox : null
  );
  store.claimWorkMailbox = ({ batchId, owner, now }) => {
    if (mailbox.processing !== null) {
      return { status: "processing", processing: mailbox.processing };
    }
    if (mailbox.pending === null) return { status: "empty" };
    mailbox = {
      ...mailbox,
      pending: null,
      processing: { batchId, batch: mailbox.pending, owner, startedAt: now.toISOString() }
    };
    return { status: "claimed", processing: mailbox.processing };
  };
  store.releaseWorkMailbox = (_target, batchId) => {
    if (mailbox.processing?.batchId !== batchId) return false;
    mailbox = {
      ...mailbox,
      pending: mailbox.processing.batch,
      processing: null
    };
    return true;
  };
  store.completeWorkMailbox = () => { throw new Error("failed work must not be acknowledged"); };
  const workspace = {
    async prepareTaskWorkspace() {
      attempts += 1;
      throw new Error("transient workspace failure");
    },
  };
  const controller = new FileTaskController(store, noTmux, {
    signalWindowMs: 1,
    deliveryRetryMs: 2,
    deliveryRetryLimit: 2,
    workspacePreparer: workspace,
    onError() {}
  });

  controller.signal("task:task-1");
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(attempts, 3);
  assert.notEqual(mailbox.pending, null);
  controller.stop();
});

test("an existing busy Operator gets bounded delivery retries without startup arming", async () => {
  const fixture = operatorRuntimeFixture();
  fixture.enqueue();
  let sends = 0;
  const delivery = {
    ...noTmux,
    async notifyOperatorInputOnce() {
      sends += 1;
      return sends === 1 ? "not-ready" : "sent";
    }
  };
  const controller = new FileTaskController(fixture.store, delivery, {
    signalWindowMs: 1,
    deliveryRetryMs: 2,
    deliveryRetryLimit: 2
  });

  controller.signal("operator");
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(sends, 2);
  assert.equal(fixture.mailbox.pending, null);
  assert.equal(fixture.mailbox.processing, null);
  controller.stop();
});

test("an unchanged Operator mailbox is not re-signalled by repeated full passes", async () => {
  const fixture = operatorRuntimeFixture();
  fixture.store.getOperatorDeliveryTarget = () => null;
  fixture.enqueue();
  const claim = fixture.store.claimWorkMailbox;
  let operatorClaims = 0;
  fixture.store.claimWorkMailbox = (input) => {
    if (input.target.kind === "operator") operatorClaims += 1;
    return claim(input);
  };
  const controller = new FileTaskController(fixture.store, noTmux, {
    signalWindowMs: 1
  });

  await controller.pump();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await controller.pump();
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The first full pass arms the Operator lane. The unchanged pending batch
  // must not create another zero-delay Operator pass on the second full scan.
  assert.equal(operatorClaims, 1);
  controller.stop();
});

test("a dirty Hook fold signals Operator work created after scheduler phases", async () => {
  const fixture = operatorRuntimeFixture();
  let drains = 0;
  let sends = 0;
  const delivery = {
    ...noTmux,
    async notifyOperatorInputOnce() {
      sends += 1;
      return "sent";
    }
  };
  const controller = new FileTaskController(fixture.store, delivery, {
    signalWindowMs: 1,
    runtimeEventProcessor: {
      drain() {
        drains += 1;
        if (drains === 2) fixture.enqueue();
        return { acknowledgedEventIds: [], deferred: [], failed: [] };
      }
    }
  });

  controller.signal("role:task-1/leader");
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(drains, 2);
  assert.equal(sends, 1);
  assert.equal(fixture.mailbox.pending, null);
  controller.stop();
});

test("continuous progress passes yield so control requests are not starved", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-controller-progress-fairness-"));
  const controllerStore = emptyStore();
  let drains = 0;
  const runtimeEventProcessor = {
    drain() {
      drains += 1;
      return {
        acknowledgedEventIds: [`progress-${drains}`],
        deferred: [],
        failed: [],
        remainingEventCount: 1,
        metrics: {
          listedEventCount: 1,
          selectedEventCount: 1,
          semanticEventsSelected: 0,
          progressEventsSelected: 1,
          progressEventsCoalesced: 0,
          stateTransactions: 1,
          remainingSemanticEventCount: 0,
          remainingProgressEventCount: 1
        }
      };
    }
  };
  const controller = await startFileTaskController(
    home,
    controllerStore,
    noTmux,
    async (method) => ({ method }),
    { intervalMs: 60_000, signalWindowMs: 1, runtimeEventProcessor }
  );
  t.after(async () => {
    await controller.close();
    rmSync(home, { recursive: true, force: true });
  });

  while (drains < 4) await new Promise((resolve) => setImmediate(resolve));
  const commandNames = ["task.query", "task.write", "task.run.yield"];
  const results = await Promise.all(commandNames.map((method) => (
    callController(home, method, {}, { timeoutMs: 3_000 })
  )));

  assert.deepEqual(results.map(({ method }) => method), commandNames);
  assert.ok(drains > 4);
  const status = await callController(home, "controller.status", {}, { timeoutMs: 3_000 });
  assert.ok(status.runtime.commands.completed >= 3);
  assert.equal(status.runtime.commands.inFlight, 0);
  assert.ok(status.runtime.commands.latencyBuckets.le3000ms >= 3);
});

test("restart progress backlog continues bounded drains until it is empty", async () => {
  let depth = 150;
  let drains = 0;
  const runtimeEventProcessor = {
    drain() {
      drains += 1;
      const listed = depth;
      const selected = Math.min(depth, 64);
      depth -= selected;
      return {
        acknowledgedEventIds: Array.from(
          { length: selected },
          (_, index) => `event-${drains}-${index}`
        ),
        deferred: [],
        failed: [],
        remainingEventCount: depth,
        metrics: {
          listedEventCount: listed,
          selectedEventCount: selected,
          semanticEventsSelected: 0,
          progressEventsSelected: selected,
          progressEventsCoalesced: 0,
          stateTransactions: selected === 0 ? 0 : 1,
          remainingSemanticEventCount: 0,
          remainingProgressEventCount: depth
        }
      };
    }
  };
  const controller = new FileTaskController(emptyStore(), noTmux, {
    runtimeEventProcessor
  });

  await controller.pump();

  assert.equal(depth, 0);
  assert.equal(drains, 4);
  assert.deepEqual(controller.runtimeMetrics(), {
    inbox: { depth: 0, semanticDepth: 0, progressDepth: 0 },
    drain: {
      passes: 4,
      listedEvents: 258,
      selectedEvents: 150,
      progressEventsCoalesced: 0,
      stateTransactions: 3
    }
  });
  controller.stop();
});

test("a non-ready Role delivery uses bounded queued retries instead of blocking readiness polling", async () => {
  const task = gitlessTask("task-1");
  const roleValue = role(task.id, "worker");
  let run = deliveredRun(task.id, roleValue.name);
  delete run.pushedAt;
  delete run.deliveredAt;
  let sends = 0;
  const store = emptyStore();
  store.getTask = () => task;
  store.getTaskWorkspace = () => taskOwnedWorkspace(task);
  store.getRole = () => roleValue;
  store.getActiveAgentRun = () => run;
  store.claimWorkMailbox = () => ({
    status: "processing",
    processing: {
      batchId: `agent-run:${task.id}/${run.id}`,
      batch: {
        fromSequence: 1, toSequence: 1, reasons: ["run-dispatched"],
        refs: [{ type: "run", taskId: task.id, id: run.id }],
        requestCount: 1, firstQueuedAt: new Date(0).toISOString(), lastQueuedAt: new Date(0).toISOString()
      },
      owner: "controller", startedAt: new Date(0).toISOString(),
      executionRef: { type: "run", taskId: task.id, id: run.id }
    }
  });
  store.saveRoleRunDelivery = ({ now }) => { run = { ...run, pushedAt: now.toISOString() }; };
  const delivery = {
    ...noTmux,
    async prepareRoleSession(input) {
      return { ...input, deliveryId: "delivery-1", sessionStarted: true };
    },
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
  assert.notEqual(run.pushedAt, undefined);
  controller.stop();
});

test("exhausting Role delivery retries terminalizes the exact prepared Run before forgetting it", async () => {
  const task = gitlessTask("task-1");
  const roleValue = role(task.id, "worker");
  let run = deliveredRun(task.id, roleValue.name);
  delete run.pushedAt;
  delete run.deliveredAt;
  const runId = run.id;
  const session = {
    agentId: run.effective.agentId,
    adapterId: run.effective.adapterId,
    nativeSessionId: "native-retry-exhausted",
    status: "running",
    effective: run.effective
  };
  const now = new Date("2025-01-02T03:04:05.000Z");
  const store = emptyStore();
  store.getTask = () => task;
  store.getTaskWorkspace = () => taskOwnedWorkspace(task);
  store.getRole = () => roleValue;
  store.getActiveAgentRun = () => run;
  store.getRoleSession = () => session;
  store.claimWorkMailbox = () => ({
    status: "processing",
    processing: {
      batchId: `agent-run:${task.id}/${run.id}`,
      batch: {
        fromSequence: 1, toSequence: 1,
        reasons: ["run-dispatched"],
        refs: [{ type: "run", taskId: task.id, id: run.id }],
        requestCount: 1,
        firstQueuedAt: new Date(0).toISOString(),
        lastQueuedAt: new Date(0).toISOString()
      },
      owner: "controller",
      startedAt: new Date(0).toISOString(),
      executionRef: { type: "run", taskId: task.id, id: run.id }
    }
  });
  const events = [];
  const failures = [];
  store.saveRoleRunDeliveryFailure = (input) => {
    events.push("terminalized");
    failures.push(input);
    run = null;
    return "failed";
  };
  let sends = 0;
  const forgotten = [];
  const delivery = {
    ...noTmux,
    async prepareRoleSession(input) {
      return {
        ...input,
        deliveryId: "delivery-retry-exhausted",
        launchId: "launch-retry-exhausted",
        sessionStarted: false
      };
    },
    async waitUntilReady(prepared) {
      return { prepared, session };
    },
    async sendOnce() {
      sends += 1;
      return "busy";
    },
    async inspectRole() { return "present"; },
    forgetPrepared(input) {
      events.push("forgotten");
      forgotten.push(input);
    }
  };
  const controller = new FileTaskController(store, delivery, {
    signalWindowMs: 1,
    deliveryRetryMs: 2,
    deliveryRetryLimit: 2,
    now: () => now
  });

  controller.signal("role:task-1/worker");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(sends, 3);
  assert.deepEqual(failures, [{
    taskId: task.id,
    roleName: roleValue.name,
    agentId: run?.effective.agentId ?? session.effective.agentId,
    adapterId: run?.effective.adapterId ?? session.effective.adapterId,
    runId,
    mailboxBatchId: `agent-run:${task.id}/${runId}`,
    nativeSessionId: session.nativeSessionId,
    launchId: "launch-retry-exhausted",
    now
  }]);
  assert.deepEqual(forgotten, [{
    taskId: task.id,
    roleName: roleValue.name,
    runId,
    launchId: "launch-retry-exhausted"
  }]);
  assert.deepEqual(events, ["terminalized", "forgotten"]);
  controller.stop();
});

test("a fresh Controller retries an undelivered Run in an existing busy pane", async () => {
  const task = gitlessTask("task-1");
  const roleValue = role(task.id, "worker");
  const run = {
    ...deliveredRun(task.id, roleValue.name),
    mode: "resume"
  };
  delete run.pushedAt;
  delete run.deliveredAt;
  let sends = 0;
  const store = emptyStore();
  store.getTask = () => task;
  store.getTaskWorkspace = () => taskOwnedWorkspace(task);
  store.getRole = () => roleValue;
  store.getActiveAgentRun = () => run;
  store.getRoleSession = () => ({
    agentId: roleValue.activeAgentId,
    adapterId: roleValue.adapterId,
    nativeSessionId: "thread-existing",
    status: "running",
    effective: run.effective
  });
  store.claimWorkMailbox = () => ({
    status: "processing",
    processing: {
      batchId: `agent-run:${task.id}/${run.id}`,
      batch: {
        fromSequence: 1, toSequence: 1, reasons: ["run-dispatched"],
        refs: [{ type: "run", taskId: task.id, id: run.id }],
        requestCount: 1, firstQueuedAt: new Date(0).toISOString(), lastQueuedAt: new Date(0).toISOString()
      },
      owner: "controller", startedAt: new Date(0).toISOString(),
      executionRef: { type: "run", taskId: task.id, id: run.id }
    }
  });
  const delivery = {
    ...noTmux,
    async prepareRoleSession(input) {
      return { ...input, deliveryId: "delivery-resume", sessionStarted: false };
    },
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
  const deadline = Date.now() + 250;
  while (sends < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(sends, 3);
  controller.stop();
});

test("a resumed Role retries startup readiness when prepare created its missing pane", async () => {
  const task = gitlessTask("task-1");
  const roleValue = role(task.id, "worker");
  const run = { ...deliveredRun(task.id, roleValue.name), mode: "resume" };
  delete run.pushedAt;
  delete run.deliveredAt;
  let sends = 0;
  const store = emptyStore();
  store.getTask = () => task;
  store.getTaskWorkspace = () => taskOwnedWorkspace(task);
  store.getRole = () => roleValue;
  store.getActiveAgentRun = () => run;
  store.getRoleSession = () => ({
    agentId: roleValue.activeAgentId,
    adapterId: roleValue.adapterId,
    nativeSessionId: "thread-existing",
    status: "running",
    effective: run.effective
  });
  store.claimWorkMailbox = () => ({
    status: "processing",
    processing: {
      batchId: `agent-run:${task.id}/${run.id}`,
      batch: {
        fromSequence: 1, toSequence: 1, reasons: ["run-dispatched"],
        refs: [{ type: "run", taskId: task.id, id: run.id }], requestCount: 1,
        firstQueuedAt: new Date(0).toISOString(),
        lastQueuedAt: new Date(0).toISOString()
      },
      owner: "controller", startedAt: new Date(0).toISOString(),
      executionRef: { type: "run", taskId: task.id, id: run.id }
    }
  });
  const delivery = {
    ...noTmux,
    async prepareRoleSession(input) {
      return { ...input, deliveryId: "delivery-resume-recreated", sessionStarted: true };
    },
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
  const deadline = Date.now() + 250;
  while (sends < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

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

test("a failed pass cannot postpone a pending Turn completion deadline to the full-scan interval", async () => {
  const deadline = Date.now() + 20;
  let pending = true;
  let failWakeupScan = true;
  const store = emptyStore();
  store.listPendingRuntimeTurnCompletions = () => pending
    ? [{
        taskId: "task-1",
        roleName: "leader",
        runId: "agent-run-1",
        dueAt: new Date(deadline).toISOString()
      }]
    : [];
  store.resolveDueRuntimeTurnCompletions = (now) => {
    if (pending && now.getTime() >= deadline) pending = false;
    return pending ? [] : ["task-1/agent-run-1"];
  };
  store.listPendingWakeups = () => {
    if (failWakeupScan) {
      failWakeupScan = false;
      throw new Error("transient wakeup scan failure");
    }
    return [];
  };
  const controller = new FileTaskController(store, noTmux, {
    intervalMs: 60_000,
    signalWindowMs: 1,
    deliveryRetryMs: 2,
    onError() {}
  });

  await assert.rejects(controller.pump(), /transient wakeup scan failure/);
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(pending, false);
  controller.stop();
});

test("an overdue semantic deadline uses bounded pass backoff instead of a zero-delay loop", async () => {
  let failures = 0;
  const store = emptyStore();
  store.listPendingRuntimeTurnCompletions = () => [{
    taskId: "task-1",
    roleName: "leader",
    runId: "agent-run-1",
    dueAt: new Date(Date.now() - 1_000).toISOString()
  }];
  store.listPendingWakeups = () => {
    failures += 1;
    throw new Error("persistent scheduler failure");
  };
  const controller = new FileTaskController(store, noTmux, {
    signalWindowMs: 1,
    deliveryRetryMs: 2,
    deliveryRetryLimit: 2,
    onError() {}
  });

  await assert.rejects(controller.pump(), /persistent scheduler failure/);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(failures, 3);
  controller.stop();
});

function role(taskId, name) {
  const agentId = `codex-${name}`;
  return {
    taskId,
    name,
    activeAgentId: agentId,
    adapterId: "codex",
    effective: testEffectiveLaunch({ agentId }),
    workspace: "/fixture/workspace",
    status: "running"
  };
}

function gitlessTask(id) {
  return {
    id,
    title: id,
    status: "active",
    projectBindings: [],
    cwd: "/fixture/workspace"
  };
}

function taskOwnedWorkspace(task) {
  if (task === undefined || task === null) return null;
  const at = new Date(0).toISOString();
  return {
    schemaVersion: 2,
    owner: { type: "task", taskId: task.id },
    root: task.cwd,
    entries: [],
    createdAt: at,
    updatedAt: at
  };
}

function deliveredRun(taskId, roleName) {
  const at = new Date(0).toISOString();
  const agentId = `codex-${roleName}`;
  return {
    schemaVersion: 6, id: "agent-run-1", taskId, roleName,
    mode: "new", input: "work", purpose: "execution", status: "active",
    pushedAt: at, deliveredAt: at,
    effective: testEffectiveLaunch({ agentId }),
    createdAt: at, updatedAt: at
  };
}

function operatorRuntimeFixture() {
  const target = { kind: "operator" };
  const request = {
    schemaVersion: 2,
    id: "input-1",
    taskId: "task-1",
    requester: {
      taskId: "task-1",
      roleName: "leader",
      agentId: "codex",
      runId: "agent-run-93"
    },
    question: "Choose a recovery path?",
    choices: [],
    blockedRefs: [],
    policy: { kind: "required" },
    status: "open",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  const batch = {
    fromSequence: 1,
    toSequence: 1,
    reasons: ["input-requested"],
    refs: [{ type: "input", taskId: request.taskId, id: request.id }],
    requestCount: 1,
    firstQueuedAt: new Date(0).toISOString(),
    lastQueuedAt: new Date(0).toISOString()
  };
  let mailbox = {
    schemaVersion: 1,
    target,
    nextSequence: 2,
    processing: null,
    pending: null
  };
  const store = emptyStore();
  store.getInputRequest = (_taskId, inputRequestId) => (
    inputRequestId === request.id ? request : null
  );
  store.getOperatorDeliveryTarget = () => ({ roleName: "operator", adapterId: "codex" });
  store.getWorkMailbox = (mailboxTarget) => (
    mailboxTarget.kind === "operator" ? mailbox : null
  );
  store.claimWorkMailbox = ({ batchId, owner, now }) => {
    if (mailbox.processing !== null) {
      return { status: "processing", processing: mailbox.processing };
    }
    if (mailbox.pending === null) return { status: "empty" };
    mailbox = {
      ...mailbox,
      pending: null,
      processing: { batchId, batch: mailbox.pending, owner, startedAt: now.toISOString() }
    };
    return { status: "claimed", processing: mailbox.processing };
  };
  store.releaseWorkMailbox = (_target, batchId) => {
    if (mailbox.processing?.batchId !== batchId) return false;
    mailbox = { ...mailbox, pending: mailbox.processing.batch, processing: null };
    return true;
  };
  store.completeWorkMailbox = (_target, batchId) => {
    if (mailbox.processing?.batchId !== batchId) return false;
    mailbox = { ...mailbox, processing: null };
    return true;
  };
  return {
    store,
    get mailbox() { return mailbox; },
    enqueue() {
      if (mailbox.pending !== null || mailbox.processing !== null) return;
      mailbox = { ...mailbox, pending: batch };
    }
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
  store.listTasks = () => [{ id: "task-1", status: "active", projectBindings: [] }];
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
  assert.equal(status.protocolVersion, FILE_TASK_CONTROLLER_PROTOCOL_VERSION);
  assert.equal(status.version, YUI_VERSION);
  assert.equal(status.storageLayoutVersion, yuiVersionIdentity().storageLayoutVersion);
  assert.equal(status.aggregateSchemaVersion, yuiVersionIdentity().aggregateSchemaVersion);
  assert.deepEqual(status.runtime.inbox, {
    depth: 0,
    semanticDepth: 0,
    progressDepth: 0
  });
  assert.ok(status.runtime.drain.passes >= 0);
  assert.equal(status.runtime.drain.listedEvents, 0);
  assert.equal(status.runtime.drain.selectedEvents, 0);
  assert.equal(status.runtime.drain.progressEventsCoalesced, 0);
  assert.equal(status.runtime.drain.stateTransactions, 0);
  assert.equal(status.runtime.commands.inFlight, 0);
  assert.equal(status.runtime.commands.completed, 0);
  assert.equal(status.runtime.commands.maximumLatencyMs, 0);
  assert.deepEqual(Object.keys(status.runtime.commands.latencyBuckets), [
    "le10ms", "le50ms", "le100ms", "le250ms", "le500ms", "le1000ms", "le3000ms"
  ]);
  assert.deepEqual(await callController(home, "controller.identity", {}), {
    executablePath: process.execPath,
    args: process.argv.slice(1),
    version: YUI_VERSION
  });
  assert.deepEqual(
    await callController(home, "scheduler.signal", { key: "task:task-1" }),
    { accepted: true }
  );
  assert.deepEqual(await callController(home, "scheduler.scan", {}), {
    activeRunDeliveries: [],
    failedRunRefs: [],
    wakeups: [],
    inputNotifications: [],
    autoResolvedInputs: []
  });
  assert.deepEqual(await callController(home, "scheduler.configure", {}), {
    configured: true,
    reconciliationIntervalMs: 60_000
  });
  assert.equal(controller.runtime.reconciliationIntervalMs, 60_000);
  await assert.rejects(
    callController(home, "scheduler.configure", {
      reconciliationIntervalSeconds: 45
    }),
    /params are invalid/i
  );
  assert.deepEqual(await callController(home, "controller.stop", {}), { stopped: true });
  await controller.closed;
});

test("a Task-isolated client follows its Home Controller discovery across TMPDIR boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-controller-cross-tmp-"));
  const serverTmp = join(root, "server-tmp");
  const clientTmp = join(root, "client-tmp");
  const home = join(root, "home");
  mkdirSync(serverTmp);
  mkdirSync(clientTmp);
  const originalTmpdir = process.env.TMPDIR;
  let controller;
  try {
    process.env.TMPDIR = serverTmp;
    controller = await startFileTaskController(home, emptyStore(), noTmux, undefined, {
      intervalMs: 60_000
    });

    process.env.TMPDIR = clientTmp;
    const status = await callController(home, "controller.status", {});
    assert.equal(status.running, true);
    assert.equal(status.pid, process.pid);
  } finally {
    process.env.TMPDIR = serverTmp;
    await controller?.close();
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Controller stop keeps discovery owned until in-flight work has drained", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-file-controller-drain-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let release;
  let started;
  const blocked = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const store = emptyStore();
  store.listTasks = () => [{ id: "task-1", status: "active", projectBindings: [] }];
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
  const { FileTaskStore } = await import("../../dist/storage/taskStore.js");
  new FileTaskStore(home).saveConfig({
    schemaVersion: 1,
    defaultWorkspace: `${home}-workspace`
  });
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
  store.saveConfig({
    schemaVersion: 1,
    defaultWorkspace: `${home}-workspace`,
    reconciliationIntervalSeconds: 45
  });

  const controller = await startFileTaskControllerRuntime(home, { store });

  assert.equal(controller.runtime.reconciliationIntervalMs, 45_000);

  store.saveConfig({
    schemaVersion: 1,
    defaultWorkspace: `${home}-workspace`,
    reconciliationIntervalSeconds: 30
  });
  assert.deepEqual(await callController(home, "scheduler.configure", {}), {
    configured: true,
    reconciliationIntervalMs: 30_000
  });
  assert.equal(controller.runtime.reconciliationIntervalMs, 30_000);

  store.saveConfig({
    schemaVersion: 1,
    defaultWorkspace: `${home}-workspace`,
    reconciliationIntervalSeconds: 20
  });
  await controller.runtime.pump();
  assert.equal(controller.runtime.reconciliationIntervalMs, 20_000);
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
    if (phase === "running") {
      return currentControllerStatus(10);
    }
    if (phase === "started") {
      return currentControllerStatus(20);
    }
    if (stoppingStatusCalls++ === 0) {
      return currentControllerStatus(10);
    }
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

test("controller stop waits until the owned process is no longer reachable", async () => {
  const events = [];
  let statusCalls = 0;
  const call = async (_home, method) => {
    events.push(method);
    if (method === "controller.stop") return { stopped: true };
    assert.equal(method, "controller.status");
    if (statusCalls++ < 2) {
      return { running: true, pid: 10, protocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION };
    }
    throw new ControllerClientError("CONTROLLER_UNAVAILABLE", "Controller is unavailable.");
  };

  const result = await stopFileTaskController("/tmp/yui-stop-test", {
    call,
    pollIntervalMs: 1,
    shutdownTimeoutMs: 100
  });

  assert.deepEqual(result, { stopped: true, pid: 10 });
  assert.deepEqual(events, [
    "controller.status",
    "controller.stop",
    "controller.status",
    "controller.status"
  ]);
});

test("fenced Controller stop requires the authenticated replacement PID", async () => {
  const events = [];
  let statusCalls = 0;
  const call = async (_home, method, params) => {
    events.push({ method, params });
    if (method === "controller.stop") {
      assert.deepEqual(params, { expectedPid: 20 });
      return { stopped: true, pid: 20 };
    }
    assert.equal(method, "controller.status");
    if (statusCalls++ === 0) return { running: true, pid: 20 };
    throw new ControllerClientError("CONTROLLER_UNAVAILABLE", "Controller is unavailable.");
  };

  const result = await stopFileTaskController("/tmp/yui-fenced-stop", {
    call,
    expectedPid: 20,
    pollIntervalMs: 1,
    shutdownTimeoutMs: 100
  });
  assert.deepEqual(result, { stopped: true, pid: 20 });
  assert.deepEqual(events, [
    { method: "controller.status", params: {} },
    { method: "controller.stop", params: { expectedPid: 20 } },
    { method: "controller.status", params: {} }
  ]);
});

test("fenced Controller stop refuses a PID mismatch without issuing stop", async () => {
  let stopCalls = 0;
  const call = async (_home, method) => {
    if (method === "controller.stop") {
      stopCalls += 1;
      return { stopped: true, pid: 21 };
    }
    return { running: true, pid: 21 };
  };
  await assert.rejects(
    stopFileTaskController("/tmp/yui-fenced-stop-mismatch", { call, expectedPid: 20 }),
    /ownership changed.*expected PID 20.*found 21/i
  );
  assert.equal(stopCalls, 0);
});
