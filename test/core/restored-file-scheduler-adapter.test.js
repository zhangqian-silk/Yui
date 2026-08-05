import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { FileRuntimeEventProcessor } from "../../dist/controller/runtimeEventProcessor.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { updateRoleAgentSessionStatus } from "../../dist/executor/agentExecutor.js";
import {
  createGlobalRole,
  createRole,
  createRoleAgentBinding,
  updateRole
} from "../../dist/role/role.js";
import { createAgentRun, yieldAgentRun } from "../../dist/run/agentRun.js";
import { processActiveRoleRunDeliveries } from "../../dist/scheduler/activeRoleRunDelivery.js";
import { processLeaderWakeups } from "../../dist/scheduler/leaderWakeupProcessor.js";
import { processOperatorInputNotifications } from "../../dist/scheduler/operatorInputNotificationProcessor.js";
import {
  isRoleRunStalled,
  reconcileStalledRoleRuns,
  RUN_PROGRESS_EVENT,
  RUN_RECOVERED_EVENT
} from "../../dist/scheduler/roleRunStall.js";
import { createLeaderStallNotification } from "../../dist/scheduler/operatorNotification.js";
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
    [createRoleAgentBinding(
      { id: "codex", adapterId: "codex" },
      { adapterId: "codex", model: "gpt-test", effort: "high" }
    )],
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

function seedLeaderStall(store, task, run, now) {
  store.transaction((tx) => {
    const progressAt = run.createdAt;
    tx.saveEvent(task.id, createTaskEvent(
      tx.nextEventId(task.id),
      "run.stalled",
      {
        runId: run.id,
        roleName: run.roleName,
        kind: "execution-stalled",
        classification: "truly-stalled",
        progressAt,
        idleMs: "1800000",
        evidenceKey: "provider-neutral-test",
        status: "needs-attention"
      },
      now
    ));
    tx.saveOperatorNotification(createLeaderStallNotification(
      task.id,
      run.id,
      progressAt,
      "provider-neutral-test",
      now,
      null
    ));
  });
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

test("Leader delivery stall is routed through the existing Operator notification lane", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun("agent-run-leader-stall", task.id, role.name, "new", "continue", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  const result = await reconcileStalledRoleRuns(
    adapter,
    { async inspectRole() { return "present"; } },
    new Date(now.getTime() + 31 * 60_000),
    undefined,
    30 * 60_000
  );
  assert.equal(result[0].kind, "delivery-stalled");
  assert.equal(result[0].classification, "truly-stalled");
  const stalled = store.listEvents(task.id).find((event) => event.type === "run.stalled");
  assert.equal(stalled.payload.runId, run.id);
  assert.equal(stalled.payload.kind, "delivery-stalled");
  assert.equal(store.getPendingWakeup(task.id), null);
  assert.equal(store.getOperatorNotification(task.id).type, "leader-stalled");
  const operatorMailbox = store.getWorkMailbox({ kind: "operator" });
  assert.equal(operatorMailbox.pending.reasons.includes("leader-run-stalled"), true);
});

test("accepted Leader delivery records progress/recovery and clears only its stall attention", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun(
    "agent-run-delivery-recovery",
    task.id,
    role.name,
    "new",
    "continue",
    now
  );
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  seedLeaderStall(store, task, run, now);
  assert.equal(isRoleRunStalled(store.listEvents(task.id), run.id), true);

  const deliveredAt = new Date(now.getTime() + 1_000);
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    now: deliveredAt
  });

  assert.equal(store.getAgentRun(task.id, run.id).deliveredAt, deliveredAt.toISOString());
  const events = store.listEvents(task.id);
  const progress = events.filter((event) => (
    event.type === RUN_PROGRESS_EVENT && event.payload.runId === run.id
  ));
  const recovered = events.filter((event) => (
    event.type === RUN_RECOVERED_EVENT && event.payload.runId === run.id
  ));
  assert.equal(progress.length, 1);
  assert.equal(progress[0].payload.kind, "delivery");
  assert.equal(progress[0].payload.progressAt, deliveredAt.toISOString());
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].payload.kind, "delivery");
  assert.equal(isRoleRunStalled(events, run.id), false);
  assert.equal(store.getOperatorNotification(task.id), null);

  const stateBeforeDuplicate = readFileSync(join(home, "state.json"), "utf8");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    now: new Date(deliveredAt.getTime() + 1_000)
  });
  assert.equal(
    store.listEvents(task.id).filter((event) => (
      event.type === RUN_PROGRESS_EVENT && event.payload.runId === run.id
    )).length,
    1
  );
  assert.equal(
    store.listEvents(task.id).filter((event) => (
      event.type === RUN_RECOVERED_EVENT && event.payload.runId === run.id
    )).length,
    1
  );
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), stateBeforeDuplicate);

  store.saveOperatorNotification(createLeaderStallNotification(
    task.id,
    "agent-run-newer-delivery",
    deliveredAt.toISOString(),
    "newer-run",
    deliveredAt,
    null
  ));
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    now: new Date(deliveredAt.getTime() + 2_000)
  });
  assert.equal(store.getOperatorNotification(task.id).runId, "agent-run-newer-delivery");
});

test("adapter delivery progress ignores a newer Work Item timestamp before acceptance", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const createdAt = new Date(now.getTime() - 60 * 60_000);
  const item = updateWorkItemStatus(createWorkItem(
    "work-item-delivery-clock",
    task.id,
    { title: "Delivery boundary" },
    createdAt
  ), "running", new Date(now.getTime() - 60_000));
  const run = createAgentRun(
    "agent-run-delivery-clock",
    task.id,
    role.name,
    "new",
    "continue",
    createdAt,
    { workItemId: item.id }
  );
  store.transaction((tx) => {
    tx.saveWorkItem(task.id, item);
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
  });

  const progress = adapter.getRunDurableProgress(task.id, role.name, run.id);
  assert.equal(progress.progressAt, createdAt.toISOString());
  assert.equal(progress.evidence, "work-review-integration");
  const result = await reconcileStalledRoleRuns(
    adapter,
    { async inspectRole() { return "present"; } },
    now,
    undefined,
    30 * 60_000
  );
  assert.equal(result[0].kind, "delivery-stalled");
});

test("native and Controller recovery clear only the matching Leader stall attention", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun("agent-run-native-recovery", task.id, role.name, "new", "continue", now);
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
      nativeSessionId: "thread-native-recovery",
      status: "ready"
    },
    now
  });
  seedLeaderStall(store, task, run, now);

  const observed = adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-native-recovery",
    turnId: "turn-native-recovery",
    runId: run.id,
    summary: "native progress"
  }, now);
  assert.equal(observed.pendingRunId, run.id);
  assert.equal(store.getOperatorNotification(task.id), null);

  const duplicate = adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-native-recovery",
    turnId: "turn-native-recovery",
    runId: run.id,
    summary: "native progress"
  }, now);
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.getOperatorNotification(task.id), null);

  const controllerFixture = fixture(t);
  const controllerStore = controllerFixture.store;
  const controllerTask = controllerFixture.task;
  const controllerRole = controllerFixture.role;
  const controllerAdapter = controllerFixture.adapter;
  const controllerNow = controllerFixture.now;
  const controllerRun = {
    ...createAgentRun(
      "agent-run-controller-recovery",
      controllerTask.id,
      controllerRole.name,
      "new",
      "continue",
      controllerNow
    ),
    deliveredAt: controllerNow.toISOString()
  };
  assert.equal(controllerAdapter.saveLeaderDispatch({
    task: controllerTask,
    role: controllerAdapter.getRole(controllerTask.id, controllerRole.name),
    run: controllerRun,
    session: {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "thread-native-recovery",
      status: "ready"
    },
    wakeup: controllerStore.getPendingWakeup(controllerTask.id),
    now: controllerNow
  }), "claimed");
  controllerAdapter.saveRoleRunDelivery({
    task: controllerTask,
    role: controllerAdapter.getRole(controllerTask.id, controllerRole.name),
    run: controllerRun,
    session: {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "thread-native-recovery",
      status: "ready"
    },
    now: controllerNow
  });
  seedLeaderStall(controllerStore, controllerTask, controllerRun, controllerNow);
  controllerAdapter.recoverReadyRoleRun({
    taskId: controllerTask.id,
    roleName: controllerRole.name,
    runId: controllerRun.id,
    now: controllerNow
  });
  assert.equal(controllerStore.getOperatorNotification(controllerTask.id), null);
  assert.equal(controllerStore.getActiveAgentRun(controllerTask.id, controllerRole.name), null);
});

test("Leader dispatch rejects a stale launch configuration snapshot", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const snapshot = adapter.getRole(task.id, role.name);
  const changedAt = new Date(now.getTime() + 1);
  store.saveRole(task.id, updateRole(role, {
    agentBindings: {
      ...role.agentBindings,
      codex: createRoleAgentBinding(
        { id: "codex", adapterId: "codex" },
        { adapterId: "codex", model: "gpt-new", effort: "medium" }
      )
    }
  }, changedAt));
  const run = createAgentRun("agent-run-stale", task.id, role.name, "resume", "continue", now);

  const result = adapter.saveLeaderDispatch({
    task,
    role: snapshot,
    run,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  });

  assert.equal(result, "state-changed");
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.notEqual(store.getPendingWakeup(task.id), null);
  assert.equal(adapter.getRole(task.id, role.name).model, "gpt-new");
  assert.equal(adapter.getRole(task.id, role.name).effort, "medium");
  assert.equal(adapter.getRole(task.id, role.name).workspace, home);

  const current = adapter.getRole(task.id, role.name);
  const mismatchedRun = createAgentRun(
    "agent-run-mismatched",
    task.id,
    role.name,
    "resume",
    "continue",
    now,
    {
      agent: {
        agentId: current.activeAgentId,
        adapterId: current.adapterId,
        model: "gpt-test",
        effort: "high"
      }
    }
  );
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: current,
    run: mismatchedRun,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "state-changed");
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
});

test("a busy Leader claim is retried through active Run delivery without another wakeup", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  let sends = 0;
  const delivery = {
    async prepareRoleSession(input) {
      return { ...input, deliveryId: `delivery-${input.runId}`, sessionStarted: false };
    },
    async waitUntilReady(prepared) { return { prepared, session: null }; },
    async sendOnce() {
      sends += 1;
      return sends === 1 ? "busy" : "sent";
    }
  };

  const [claimed] = await processLeaderWakeups(adapter, delivery, now);
  assert.equal(claimed.reason, "not-ready");
  assert.equal(store.getPendingWakeup(task.id), null);
  const active = store.getActiveAgentRun(task.id, role.name);
  assert.equal(active.deliveredAt, undefined);
  assert.equal(active.agentId, role.activeAgentId);
  assert.equal(active.adapterId, "codex");
  assert.equal(active.model, "gpt-test");
  assert.equal(active.effort, "high");

  const [retried] = await processActiveRoleRunDeliveries(adapter, delivery, now);
  assert.equal(retried.status, "delivered");
  assert.equal(sends, 2);
  assert.notEqual(store.getActiveAgentRun(task.id, role.name).deliveredAt, undefined);
});

test("Leader preparation owns its durable Run before awaiting tmux", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  let announcePreparation;
  let releasePreparation;
  const preparationStarted = new Promise((resolve) => { announcePreparation = resolve; });
  const preparationBlocked = new Promise((resolve) => { releasePreparation = resolve; });
  const delivery = {
    async prepareRoleSession(input) {
      announcePreparation();
      return { ...input, deliveryId: `delivery-${input.runId}`, sessionStarted: true };
    },
    async waitUntilReady(prepared) {
      await preparationBlocked;
      return { prepared, session: null };
    },
    async sendOnce() { return "sent"; }
  };

  const processing = processLeaderWakeups(adapter, delivery, now);
  await preparationStarted;

  const claimed = store.getActiveAgentRun(task.id, role.name);
  assert.notEqual(claimed, null);
  assert.equal(store.getPendingWakeup(task.id), null);
  assert.throws(
    () => store.saveActiveAgentRun(createAgentRun(
      "agent-run-concurrent",
      task.id,
      role.name,
      "new",
      "concurrent work",
      new Date(now.getTime() + 1)
    )),
    /already has an active Agent run/
  );

  releasePreparation();
  assert.equal((await processing)[0].status, "dispatched");
});

test("Leader dispatch rejects a Run id that already exists in Task history", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const historic = createAgentRun(
    "agent-run-existing",
    task.id,
    role.name,
    "new",
    "historic",
    now
  );
  store.saveAgentRun(historic);

  const result = adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run: createAgentRun(
      historic.id,
      task.id,
      role.name,
      "new",
      "replacement",
      new Date(now.getTime() + 1)
    ),
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  });

  assert.equal(result, "state-changed");
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.notEqual(store.getPendingWakeup(task.id), null);
  assert.equal(store.getAgentRun(task.id, historic.id).input, "historic");
});

test("prepare failure terminates a claimed Run with an existing fixed session", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-existing"
  }, now);
  adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-existing",
    turnId: "turn-before-wakeup",
    summary: "idle"
  }, now);
  assert.equal(adapter.getRoleSession(task.id, role.name).status, "ready");

  const [result] = await processLeaderWakeups(adapter, {
    async prepareRoleSession() {
      throw new Error("tmux resume failed");
    }
  }, now);

  assert.equal(result.status, "failed");
  assert.match(result.error, /tmux resume failed/);
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.notEqual(store.getPendingWakeup(task.id), null);
  assert.equal(store.getRole(task.id, role.name).status, "failed");
  assert.equal(store.getRoleSession(task.id, role.name).status, "broken");
  assert.match(store.getLeaderFailure(task.id).message, /tmux resume failed/);
});

test("a stale Leader preparation failure cannot overwrite a newer active Run", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const wakeup = store.getPendingWakeup(task.id);
  const replacement = createAgentRun(
    "agent-run-replacement",
    task.id,
    role.name,
    "new",
    "newer work",
    new Date(now.getTime() + 1_000)
  );
  store.saveActiveAgentRun(replacement);

  const result = adapter.saveLeaderDispatchFailure({
    task,
    role: adapter.getRole(task.id, role.name),
    session: null,
    claimed: {
      run: createAgentRun(
        "agent-run-stale",
        task.id,
        role.name,
        "new",
        "stale work",
        now
      ),
      wakeup
    },
    failure: {
      schemaVersion: 1,
      taskId: task.id,
      nativeSessionId: "(unregistered)",
      message: "stale preparation failed",
      attemptCount: 1,
      firstFailedAt: now.toISOString(),
      lastFailedAt: now.toISOString()
    },
    notification: {
      schemaVersion: 1,
      taskId: task.id,
      type: "leader-recovery-failed",
      message: "stale preparation failed",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    },
    now
  });

  assert.equal(result, "state-changed");
  assert.equal(store.getActiveAgentRun(task.id, role.name).id, replacement.id);
  assert.equal(store.getRole(task.id, role.name).status, "idle");
  assert.equal(store.getLeaderFailure(task.id), null);
  assert.equal(store.getOperatorNotification(task.id), null);
  assert.deepEqual(store.getPendingWakeup(task.id), wakeup);
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
    runId: run.id,
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
  assert.equal(store.getTask(task.id).status, "active");
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["leader-turn-unclosed"]);
});

test("an unrelated Hook cannot prove that a prepared Leader Run was delivered", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun("agent-run-prepared", task.id, role.name, "new", "continue", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "thread-prepared",
      status: "ready"
    },
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");

  const observed = adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-prepared",
    turnId: "turn-unrelated",
    runId: "agent-run-older-turn",
    summary: "This was an unrelated native turn."
  }, now);

  assert.equal(observed.pendingRunId, undefined);
  assert.equal(store.getActiveAgentRun(task.id, role.name).deliveredAt, undefined);
  const sessions = store.getTaskRoleSessionSet(task.id, role.name);
  assert.equal(sessions.inFlight.runId, run.id);
  assert.equal(sessions.inFlight.deliveredAt, undefined);
  assert.equal(sessions.pendingTurnCompletion, null);
  assert.deepEqual(
    sessions.sessions[role.activeAgentId].recentCompletedTurnIds,
    []
  );
});

test("a matching Hook proves delivery across the receipt persistence crash window", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun("agent-run-crash-window", task.id, role.name, "new", "continue", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "thread-crash-window",
      status: "ready"
    },
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  const inbox = new FileRuntimeEventInbox(home, () => now);
  inbox.enqueueTurnCompleted({
    scope: "task",
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-crash-window",
    turnId: "turn-after-send",
    runId: run.id,
    summary: "sent before Controller persisted delivery"
  });
  const processor = new FileRuntimeEventProcessor(inbox, adapter);

  const beforeReceipt = processor.drain(now);
  assert.equal(beforeReceipt.acknowledgedEventIds.length, 1);
  assert.equal(beforeReceipt.deferred.length, 0);
  assert.equal(inbox.list().length, 0);
  assert.notEqual(store.getActiveAgentRun(task.id, role.name).deliveredAt, undefined);
  assert.equal(
    store.getTaskRoleSessionSet(task.id, role.name).pendingTurnCompletion.runId,
    run.id
  );
});

test("a Hook replay is idempotent after state commit succeeds and inbox ack crashes", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun("agent-run-ack-crash", task.id, role.name, "new", "continue", now);
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
      nativeSessionId: "thread-ack-crash",
      status: "ready"
    },
    now
  });
  const inbox = new FileRuntimeEventInbox(home, () => now);
  inbox.enqueueTurnCompleted({
    scope: "task",
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-ack-crash",
    turnId: "turn-ack-crash",
    runId: run.id,
    summary: "state committed before ack"
  });
  const crashingProcessor = new FileRuntimeEventProcessor({
    list: () => inbox.list(),
    acknowledge() {
      throw new Error("process crashed before inbox ack");
    }
  }, adapter);

  const first = crashingProcessor.drain(now);
  assert.equal(first.failed.length, 1);
  const pendingBeforeRestart = store
    .getTaskRoleSessionSet(task.id, role.name)
    .pendingTurnCompletion;
  const stateBeforeReplay = readFileSync(join(home, "state.json"), "utf8");
  assert.equal(inbox.list().length, 1);

  const restartedStore = new FileTaskStore(home);
  const restartedAdapter = new FileSchedulerStoreAdapter(restartedStore);
  const replayed = new FileRuntimeEventProcessor(inbox, restartedAdapter).drain(
    new Date(now.getTime() + 500)
  );

  assert.equal(replayed.failed.length, 0);
  assert.equal(replayed.acknowledgedEventIds.length, 1);
  assert.deepEqual(
    restartedStore.getTaskRoleSessionSet(task.id, role.name).pendingTurnCompletion,
    pendingBeforeRestart
  );
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), stateBeforeReplay);
  assert.deepEqual(inbox.list(), []);
  assert.deepEqual(
    restartedAdapter.resolveDueRuntimeTurnCompletions(
      new Date(now.getTime() + 2_000)
    ),
    [run.id]
  );
  assert.equal(restartedStore.getActiveAgentRun(task.id, role.name), null);
});

test("an obsolete Hook cannot claim the native session of the current Run", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun("agent-run-current-native", task.id, role.name, "new", "continue", now);
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
    session: null,
    now
  });
  adapter.reserveRuntimeLaunch({
    owner: {
      scope: "task",
      taskId: task.id,
      roleName: role.name
    },
    launchId: "launch-current-native"
  }, () => {});
  const times = [
    now,
    new Date(now.getTime() + 1)
  ];
  const inbox = new FileRuntimeEventInbox(home, () => times.shift());
  const common = {
    scope: "task",
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    launchId: "launch-current-native",
    summary: "done"
  };
  inbox.enqueueTurnCompleted({
    ...common,
    nativeSessionId: "thread-obsolete",
    turnId: "turn-obsolete",
    runId: "agent-run-obsolete"
  });
  inbox.enqueueTurnCompleted({
    ...common,
    nativeSessionId: "thread-current",
    turnId: "turn-current",
    runId: run.id
  });
  assert.equal(
    adapter.classifyRuntimeTurnCompleted({
      ...common,
      nativeSessionId: "thread-current",
      turnId: "turn-current",
      runId: run.id
    }),
    "apply"
  );
  assert.equal(inbox.list()[1].launchId, "launch-current-native");

  const result = new FileRuntimeEventProcessor(inbox, adapter).drain(
    new Date(now.getTime() + 2)
  );

  assert.equal(result.failed.length, 0);
  assert.equal(result.acknowledgedEventIds.length, 2);
  const sessions = store.getTaskRoleSessionSet(task.id, role.name);
  assert.equal(sessions.sessions[role.activeAgentId].nativeSessionId, "thread-current");
  assert.equal(sessions.pendingTurnCompletion.runId, run.id);
  assert.deepEqual(inbox.list(), []);
});

for (const terminalStatus of ["stopped", "broken"]) {
  test(`a late Hook preserves a ${terminalStatus} native session`, (t) => {
    const { store, task, role, now, adapter } = fixture(t);
    adapter.recordRuntimeNativeSession({
      taskId: task.id,
      roleName: role.name,
      agentId: role.activeAgentId,
      adapterId: "codex",
      nativeSessionId: `thread-${terminalStatus}`
    }, now);
    store.transaction((tx) => {
      const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
      tx.saveTaskRoleSessionSet(updateRoleAgentSessionStatus(
        sessions,
        role.activeAgentId,
        terminalStatus,
        new Date(now.getTime() + 1)
      ));
    });

    adapter.observeRuntimeTurnCompleted({
      taskId: task.id,
      roleName: role.name,
      agentId: role.activeAgentId,
      adapterId: "codex",
      nativeSessionId: `thread-${terminalStatus}`,
      turnId: `turn-late-${terminalStatus}`,
      summary: "late native completion"
    }, new Date(now.getTime() + 2));

    const session = store.getRoleSession(task.id, role.name);
    assert.equal(session.status, terminalStatus);
    assert.deepEqual(session.recentCompletedTurnIds, [`turn-late-${terminalStatus}`]);
  });
}

for (const terminalStatus of ["stopped", "broken"]) {
  test(`a late global Hook preserves a ${terminalStatus} native session`, (t) => {
    const { home, store, now, adapter } = fixture(t);
    const role = createGlobalRole(
      `operator-${terminalStatus}`,
      [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
      "codex",
      home,
      now
    );
    store.saveGlobalRole(role);
    adapter.recordGlobalRuntimeNativeSession({
      roleName: role.name,
      agentId: role.activeAgentId,
      adapterId: "codex",
      nativeSessionId: `thread-global-${terminalStatus}`
    }, now);
    store.transaction((tx) => {
      const sessions = tx.getGlobalRoleSessionSet(role.name);
      tx.saveGlobalRoleSessionSet(updateRoleAgentSessionStatus(
        sessions,
        role.activeAgentId,
        terminalStatus,
        new Date(now.getTime() + 1)
      ));
    });

    adapter.observeGlobalRuntimeTurnCompleted({
      roleName: role.name,
      agentId: role.activeAgentId,
      adapterId: "codex",
      nativeSessionId: `thread-global-${terminalStatus}`,
      turnId: `turn-global-late-${terminalStatus}`
    }, new Date(now.getTime() + 2));

    const session = store.getGlobalRoleSessionSet(role.name).sessions[role.activeAgentId];
    assert.equal(session.status, terminalStatus);
    assert.deepEqual(
      session.recentCompletedTurnIds,
      [`turn-global-late-${terminalStatus}`]
    );
  });
}

test("a Hook classified for Run A cannot close Run B after an intervening dispatch", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const first = createAgentRun("agent-run-race-a", task.id, role.name, "new", "A", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run: first,
    session: {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "thread-race",
      status: "ready"
    },
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run: first,
    session: store.getRoleSession(task.id, role.name),
    now
  });
  const event = {
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-race",
    turnId: "turn-race-a",
    runId: first.id,
    summary: "A ended"
  };
  assert.equal(adapter.classifyRuntimeTurnCompleted(event), "apply");

  adapter.recordRuntimeTurnCompleted({
    ...event,
    expectedRunId: first.id
  }, now);
  const second = createAgentRun("agent-run-race-b", task.id, role.name, "resume", "B", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run: second,
    session: store.getRoleSession(task.id, role.name),
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run: second,
    session: store.getRoleSession(task.id, role.name),
    now
  });

  adapter.observeRuntimeTurnCompleted(event, new Date(now.getTime() + 1_000));

  assert.equal(store.getActiveAgentRun(task.id, role.name).id, second.id);
  assert.equal(
    store.getTaskRoleSessionSet(task.id, role.name).pendingTurnCompletion,
    null
  );
});

test("a Hook for an older Run is acknowledged without closing the fresh Run", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun("agent-run-fresh-send", task.id, role.name, "new", "continue", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "thread-fresh-send",
      status: "ready"
    },
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  const inbox = new FileRuntimeEventInbox(home, () => now);
  inbox.enqueueTurnCompleted({
    scope: "task",
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-fresh-send",
    turnId: "turn-before-send",
    runId: "agent-run-before-fresh-send",
    summary: "old turn"
  });
  const processor = new FileRuntimeEventProcessor(inbox, adapter);
  const beforeSend = processor.drain(now);

  assert.equal(beforeSend.deferred.length, 0);
  assert.equal(beforeSend.acknowledgedEventIds.length, 1);
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "thread-fresh-send",
      status: "ready"
    },
    now
  });
  assert.equal(processor.drain(now).acknowledgedEventIds.length, 0);
  assert.equal(store.getTaskRoleSessionSet(task.id, role.name).pendingTurnCompletion, null);
});

test("a second Hook waits behind the first grace closure instead of poisoning reconciliation", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun("agent-run-two-hooks", task.id, role.name, "new", "continue", now);
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
      nativeSessionId: "thread-two-hooks",
      status: "ready"
    },
    now
  });
  const inbox = new FileRuntimeEventInbox(home, () => now);
  const common = {
    scope: "task",
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-two-hooks",
    runId: run.id,
    summary: "done"
  };
  inbox.enqueueTurnCompleted({ ...common, turnId: "turn-first" });
  const processor = new FileRuntimeEventProcessor(inbox, adapter);
  assert.equal(processor.drain(now).failed.length, 0);
  inbox.enqueueTurnCompleted({ ...common, turnId: "turn-second" });

  const blocked = processor.drain(new Date(now.getTime() + 1_000));
  assert.equal(blocked.failed.length, 0);
  assert.deepEqual(blocked.deferred.map((event) => event.turnId), ["turn-second"]);
  adapter.resolveDueRuntimeTurnCompletions(new Date(now.getTime() + 2_000));
  const settled = processor.drain(new Date(now.getTime() + 2_000));

  assert.equal(settled.failed.length, 0);
  assert.equal(inbox.list().length, 0);
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
});

test("ready-composer recovery closes a fresh Leader run without a native session id", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun(
    "agent-run-fresh-missing-hook",
    task.id,
    role.name,
    "new",
    "continue",
    now
  );
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
    session: null,
    now
  });

  adapter.recoverReadyRoleRun({
    taskId: task.id,
    roleName: role.name,
    runId: run.id,
    now: new Date(now.getTime() + 120_000)
  });

  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.equal(store.getTaskRoleSessionSet(task.id, role.name).inFlight, null);
  assert.equal(store.getAgentRun(task.id, run.id).status, "yielded");
  assert.deepEqual(
    store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: role.name }).pending.reasons,
    ["leader-turn-unclosed"]
  );
});

test("ready-composer failure for a Leader WorkItem clears only matching stall attention", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const item = updateWorkItemStatus(createWorkItem(
    "work-item-ready-recovery",
    task.id,
    { title: "Ready recovery" },
    now
  ), "running", now);
  const run = createAgentRun(
    "agent-run-ready-work-item",
    task.id,
    role.name,
    "new",
    "continue",
    now,
    { workItemId: item.id }
  );
  store.transaction((tx) => {
    tx.saveWorkItem(task.id, item);
  });
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
    session: null,
    now
  });
  seedLeaderStall(store, task, run, now);

  const recoveredAt = new Date(now.getTime() + 1_000);
  adapter.recoverReadyRoleRun({
    taskId: task.id,
    roleName: role.name,
    runId: run.id,
    now: recoveredAt
  });

  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.equal(store.getWorkItem(task.id, item.id).status, "failed");
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.equal(store.getTaskRoleSessionSet(task.id, role.name).inFlight, null);
  assert.equal(store.getOperatorNotification(task.id), null);

  store.saveOperatorNotification(createLeaderStallNotification(
    task.id,
    "agent-run-newer-ready",
    recoveredAt.toISOString(),
    "newer-run",
    recoveredAt,
    null
  ));
  adapter.recoverReadyRoleRun({
    taskId: task.id,
    roleName: role.name,
    runId: run.id,
    now: new Date(recoveredAt.getTime() + 1_000)
  });
  assert.equal(store.getOperatorNotification(task.id).runId, "agent-run-newer-ready");
});

test("native completion failure for a Leader WorkItem clears only matching stall attention", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const item = updateWorkItemStatus(createWorkItem(
    "work-item-native-failure",
    task.id,
    { title: "Native failure" },
    now
  ), "running", now);
  const run = createAgentRun(
    "agent-run-native-work-item",
    task.id,
    role.name,
    "new",
    "continue",
    now,
    { workItemId: item.id }
  );
  store.transaction((tx) => {
    tx.saveWorkItem(task.id, item);
  });
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
      nativeSessionId: "thread-native-work-item",
      status: "ready"
    },
    now
  });
  seedLeaderStall(store, task, run, now);

  const completedAt = new Date(now.getTime() + 1_000);
  const completion = adapter.recordRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-native-work-item",
    turnId: "turn-native-work-item",
    expectedRunId: run.id,
    summary: "WorkItem completion did not yield the Run.",
    origin: "native"
  }, completedAt);

  assert.equal(completion.finalizedRunId, run.id);
  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.equal(store.getWorkItem(task.id, item.id).status, "failed");
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.equal(store.getTaskRoleSessionSet(task.id, role.name).inFlight, null);
  assert.equal(store.getOperatorNotification(task.id), null);

  store.saveOperatorNotification(createLeaderStallNotification(
    task.id,
    "agent-run-newer-native",
    completedAt.toISOString(),
    "newer-run",
    completedAt,
    null
  ));
  const duplicate = adapter.recordRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-native-work-item",
    turnId: "turn-native-work-item",
    expectedRunId: run.id,
    summary: "duplicate completion",
    origin: "native"
  }, new Date(completedAt.getTime() + 1_000));
  assert.equal(duplicate.finalizedRunId, undefined);
  assert.equal(store.getOperatorNotification(task.id).runId, "agent-run-newer-native");
});

test("a quiescent result-driven Leader Turn is recovered instead of inferring Task completion", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  store.transaction((tx) => {
    tx.clearPendingWakeup(task.id);
    enqueueWork(
      tx,
      { kind: "role", taskId: task.id, roleName: role.name },
      "role-result",
      now,
      [{ type: "task", id: task.id }]
    );
  });
  const run = createAgentRun("agent-run-result", task.id, role.name, "new", "synthesize", now);
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
      nativeSessionId: "thread-result",
      status: "ready"
    },
    now
  });
  adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-result",
    turnId: "turn-result",
    runId: run.id,
    summary: "The synthesis looks complete, but no terminal command was issued."
  }, now);

  adapter.resolveDueRuntimeTurnCompletions(new Date(now.getTime() + 2_000));

  assert.equal(store.getTask(task.id).status, "active");
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["leader-turn-unclosed"]);
  assert.equal(
    store.listEvents(task.id).some((event) => event.type === "task.completed"),
    false
  );
});

test("a repeated unclosed Leader recovery escalates and notifies Operator once", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  store.transaction((tx) => {
    tx.clearPendingWakeup(task.id);
    enqueueWork(
      tx,
      { kind: "role", taskId: task.id, roleName: role.name },
      "leader-turn-unclosed",
      now,
      [{ type: "task", id: task.id }]
    );
  });
  const run = createAgentRun("agent-run-recovery", task.id, role.name, "new", "recover", now);
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
      nativeSessionId: "thread-recovery",
      status: "ready"
    },
    now
  });
  adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-recovery",
    turnId: "turn-recovery",
    runId: run.id,
    summary: "The recovery Turn also forgot to close."
  }, now);

  adapter.resolveDueRuntimeTurnCompletions(new Date(now.getTime() + 2_000));

  assert.equal(store.getPendingWakeup(task.id), null);
  assert.equal(store.getLeaderFailure(task.id).attemptCount, 1);
  assert.equal(store.getOperatorNotification(task.id).type, "leader-recovery-failed");
  assert.deepEqual(
    store.getWorkMailbox({ kind: "operator" }).pending.reasons,
    ["leader-recovery-failed"]
  );

  const deliveries = [];
  adapter.getOperatorDeliveryTarget = () => ({
    roleName: "operator",
    adapterId: "codex"
  });
  const result = await processOperatorInputNotifications(adapter, {
    async notifyOperatorInputOnce(input) {
      deliveries.push(input);
      return "sent";
    }
  });
  assert.deepEqual(result, [{
    recoveryTaskId: task.id,
    taskId: task.id,
    status: "sent"
  }]);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].receiptId, /^leader-recovery:task-1:/);
  assert.match(deliveries[0].text, /needs user attention/i);
  assert.equal(store.getWorkMailbox({ kind: "operator" }).processing, null);
});

test("a partial low-level Run mutation remains fenced until its matching Hook repairs it", (t) => {
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
    runId: first.id,
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

test("Worker delivery claims and binds its mailbox before external work, then fails deterministically before send", async (t) => {
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
  const forgotten = [];
  const delivery = {
    async prepareRoleSession() {
      const processing = store.getWorkMailbox(target).processing;
      observedBound = processing?.executionRef?.type === "run"
        && processing.executionRef.id === run.id;
      throw new Error("launch failed");
    },
    async waitUntilReady() { throw new Error("unexpected readiness"); },
    async sendOnce() { throw new Error("unexpected send"); },
    forgetPrepared(input) { forgotten.push(input); },
    async inspectRole() { return "present"; },
    async stopTask() { return true; }
  };

  const [result] = await processActiveRoleRunDeliveries(adapter, delivery, now);

  assert.equal(observedBound, true);
  assert.equal(result.status, "failed");
  assert.deepEqual(forgotten, [{
    taskId: task.id,
    roleName: worker.name,
    runId: run.id
  }]);
  const completed = store.getWorkMailbox(target);
  assert.equal(completed.processing, null);
  assert.equal(completed.pending, null);
  assert.equal(store.getActiveAgentRun(task.id, worker.name), null);
  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.ok(store.getPendingWakeup(task.id).reasons.includes("role-run-failed"));
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
    { title: "Implement" },
    now
  ), "running", now);
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
  const deliveredAt = new Date(now.getTime() + 1_000).toISOString();
  store.saveActiveAgentRun({ ...run, deliveredAt });
  seedLeaderStall(store, task, { ...run, deliveredAt }, now);

  assert.equal(adapter.saveExitedRoleRun({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: adapter.getRoleSession(task.id, role.name),
    summary: "tmux exited",
    now
  }), "failed");

  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.equal(store.getAgentRun(task.id, run.id).deliveredAt, deliveredAt);
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.equal(store.getWorkItem(task.id, item.id).status, "failed");
  assert.equal(store.getRole(task.id, role.name).status, "exited");
  assert.equal(store.getRoleSession(task.id, role.name).status, "stopped");
  assert.equal(store.getOperatorNotification(task.id), null);
  assert.equal(
    store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: role.name }).processing,
    null
  );
  assert.ok(store.getPendingWakeup(task.id).reasons.includes("leader-run-failed"));

  assert.equal(adapter.saveExitedRoleRun({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: adapter.getRoleSession(task.id, role.name),
    summary: "duplicate pane absence",
    now
  }), "state-changed");
  assert.equal(store.getOperatorNotification(task.id), null);

  const replacement = createAgentRun(
    "agent-run-replacement",
    task.id,
    role.name,
    "new",
    "replacement",
    now
  );
  store.transaction((tx) => {
    tx.saveActiveAgentRun(replacement);
    enqueueWork(tx, {
      kind: "role",
      taskId: task.id,
      roleName: role.name
    }, "run-dispatched", now, [{ type: "run", id: replacement.id }]);
  });
  adapter.claimWorkMailbox({
    target: { kind: "role", taskId: task.id, roleName: role.name },
    batchId: `agent-run:${replacement.id}`,
    owner: "controller",
    now,
    executionRef: { type: "run", id: replacement.id }
  });
  store.saveOperatorNotification(createLeaderStallNotification(
    task.id,
    replacement.id,
    replacement.createdAt,
    "newer-run",
    now,
    null
  ));

  assert.equal(adapter.saveExitedRoleRun({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: adapter.getRoleSession(task.id, role.name),
    summary: "stale liveness snapshot",
    now
  }), "state-changed");
  assert.equal(store.getActiveAgentRun(task.id, role.name).id, replacement.id);
  assert.equal(store.getOperatorNotification(task.id).runId, replacement.id);
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

test("confirmed Task and global runtime cleanup also stops their persisted sessions", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const globalRole = createGlobalRole(
    "operator",
    [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
    "codex",
    home,
    now
  );
  store.saveGlobalRole(globalRole);
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-task"
  }, now);
  adapter.recordGlobalRuntimeNativeSession({
    roleName: globalRole.name,
    agentId: globalRole.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-global"
  }, now);
  const taskOwner = {
    scope: "task", taskId: task.id, roleName: role.name
  };
  const globalOwner = { scope: "global", roleName: globalRole.name };
  assert.deepEqual(
    adapter.listDormantRuntimeOwners().map((candidate) => candidate.owner),
    [taskOwner, globalOwner]
  );
  const taskTarget = adapter.enqueueRuntimeCleanup(taskOwner, now);
  const globalTarget = adapter.enqueueRuntimeCleanup(globalOwner, now);
  const stoppedAt = new Date(now.getTime() + 1);

  assert.equal(adapter.completeRuntimeCleanup(taskTarget, stoppedAt), true);
  assert.equal(adapter.completeRuntimeCleanup(globalTarget, stoppedAt), true);

  assert.equal(store.getRoleSession(task.id, role.name).status, "stopped");
  assert.equal(
    store.getGlobalRoleSessionSet(globalRole.name)
      .sessions[globalRole.activeAgentId].status,
    "stopped"
  );
  assert.equal(store.getWorkMailbox(taskTarget), null);
  assert.equal(store.getWorkMailbox(globalTarget), null);
});

test("a confirmed-absent exact reservation is cleared with its Task session stopped", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const owner = { scope: "task", taskId: task.id, roleName: role.name };
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-old"
  }, now);
  adapter.reserveRuntimeLaunch(
    { owner, launchId: "launch-stale" },
    () => {},
    now
  );

  assert.equal(adapter.completeStoppedRuntimeReservation(
    { kind: "role-runtime", taskId: task.id, roleName: role.name },
    "launch-stale",
    new Date(now.getTime() + 1)
  ), true);

  assert.equal(store.getRoleSession(task.id, role.name).status, "stopped");
  assert.equal(
    store.getWorkMailbox({
      kind: "role-runtime", taskId: task.id, roleName: role.name
    }),
    null
  );
});

test("settling a stopped launch handles the exact reservation and Hook-won race atomically", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const owner = { scope: "task", taskId: task.id, roleName: role.name };
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, now);
  adapter.reserveRuntimeLaunch(
    { owner, launchId: "launch-exact" },
    () => {},
    now
  );

  assert.equal(adapter.settleStoppedRuntimeLaunch({
    owner,
    launchId: "launch-exact",
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, new Date(now.getTime() + 1)), true);
  assert.equal(store.getRoleSession(task.id, role.name).status, "stopped");

  adapter.reserveRuntimeLaunch(
    { owner, launchId: "launch-hook-won" },
    () => {},
    new Date(now.getTime() + 2)
  );
  adapter.recordReservedRuntimeNativeSession({
    owner,
    launchId: "launch-hook-won",
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, () => {}, new Date(now.getTime() + 3));
  assert.equal(
    store.getWorkMailbox({
      kind: "role-runtime", taskId: task.id, roleName: role.name
    }),
    null
  );

  assert.equal(adapter.settleStoppedRuntimeLaunch({
    owner,
    launchId: "launch-hook-won",
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, new Date(now.getTime() + 4)), true);
  assert.equal(store.getRoleSession(task.id, role.name).status, "stopped");
});

test("stopped-launch and dormant-session CAS fences preserve newer lifecycle facts", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const owner = { scope: "task", taskId: task.id, roleName: role.name };
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, now);
  const [candidate] = adapter.listDormantRuntimeOwners();
  assert.deepEqual(candidate.owner, owner);

  adapter.reserveRuntimeLaunch(
    { owner, launchId: "launch-newer" },
    () => {},
    new Date(now.getTime() + 1)
  );
  assert.equal(adapter.settleStoppedRuntimeLaunch({
    owner,
    launchId: "launch-older",
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, new Date(now.getTime() + 2)), false);
  assert.equal(
    adapter.markRuntimeOwnerStopped(candidate, new Date(now.getTime() + 2)),
    false
  );
  assert.equal(store.getRoleSession(task.id, role.name).status, "running");
  assert.equal(adapter.completeRuntimeLaunchReservation(owner, "launch-newer"), true);

  const run = createAgentRun(
    "run-newer",
    task.id,
    role.name,
    "resume",
    "newer work",
    new Date(now.getTime() + 3)
  );
  store.saveActiveAgentRun(run);
  assert.equal(adapter.settleStoppedRuntimeLaunch({
    owner,
    launchId: "launch-older",
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, new Date(now.getTime() + 4)), false);
  assert.equal(
    adapter.markRuntimeOwnerStopped(candidate, new Date(now.getTime() + 4)),
    false
  );
  assert.equal(store.getRoleSession(task.id, role.name).status, "running");
});

test("dormant-session CAS rejects a Hook-updated session and stops an unchanged one", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, now);
  const [stale] = adapter.listDormantRuntimeOwners();
  store.transaction((tx) => {
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    tx.saveTaskRoleSessionSet(updateRoleAgentSessionStatus(
      sessions,
      role.activeAgentId,
      "ready",
      new Date(now.getTime() + 1)
    ));
  });

  assert.equal(
    adapter.markRuntimeOwnerStopped(stale, new Date(now.getTime() + 2)),
    false
  );
  const [current] = adapter.listDormantRuntimeOwners();
  assert.equal(
    adapter.markRuntimeOwnerStopped(current, new Date(now.getTime() + 3)),
    true
  );
  assert.equal(store.getRoleSession(task.id, role.name).status, "stopped");
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
