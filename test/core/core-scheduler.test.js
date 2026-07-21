import assert from "node:assert/strict";
import test from "node:test";

import { processLeaderWakeups } from "../../dist/scheduler/leaderWakeupProcessor.js";
import { reconcileExitedRoleRuns } from "../../dist/scheduler/roleRunLiveness.js";
import { mergePendingWakeup } from "../../dist/scheduler/pendingWakeup.js";
import { queueLeaderWakeupAfterYield } from "../../dist/scheduler/wakeupQueue.js";

const NOW = new Date("2026-07-19T12:00:00.000Z");

test("pending wakeups merge durably without losing request history", () => {
  const first = mergePendingWakeup("task-1", "role-result", NOW, null);
  const second = mergePendingWakeup(
    "task-1",
    "operator-input",
    new Date("2026-07-19T12:01:00.000Z"),
    first
  );
  const third = mergePendingWakeup(
    "task-1",
    "role-result",
    new Date("2026-07-19T12:02:00.000Z"),
    second
  );

  assert.deepEqual(third.reasons, ["role-result", "operator-input"]);
  assert.equal(third.requestCount, 3);
  assert.equal(third.firstRequestedAt, first.firstRequestedAt);
  assert.equal(third.lastRequestedAt, "2026-07-19T12:02:00.000Z");
});

test("a busy Leader retains its pending wakeup and receives no terminal delivery", async () => {
  const store = fakeStore();
  store.activeRuns.set(key("task-1", "leader"), activeRun("run-busy", "leader"));
  const delivery = fakeDelivery();

  const result = await processLeaderWakeups(store, delivery, NOW);

  assert.deepEqual(result, [{ taskId: "task-1", status: "skipped", reason: "busy" }]);
  assert.equal(store.pending.has("task-1"), true);
  assert.deepEqual(delivery.calls, []);
  assert.equal(store.savedDispatches.length, 0);
});

test("a repository Task retains wakeup until its worktree cwd is ready", async () => {
  const store = fakeStore();
  store.tasks[0] = { ...store.tasks[0], repositoryId: "repository-1" };
  const delivery = fakeDelivery();

  const result = await processLeaderWakeups(store, delivery, NOW);

  assert.equal(result[0].reason, "workspace-not-ready");
  assert.equal(store.pending.has("task-1"), true);
  assert.deepEqual(delivery.calls, []);
});

test("an idle Leader starts a real wakeup run, waits for readiness, sends once, then clears wake", async () => {
  const store = fakeStore();
  const delivery = fakeDelivery();

  const result = await processLeaderWakeups(store, delivery, NOW);

  assert.deepEqual(result, [{ taskId: "task-1", status: "dispatched" }]);
  assert.deepEqual(delivery.calls.map((call) => call.type), ["prepare", "ready", "sendOnce"]);
  assert.equal(delivery.calls[0].input.mode, "new");
  assert.equal(delivery.calls[2].input.receiptId.startsWith("agent-run:"), true);
  assert.equal(store.savedDispatches.length, 1);
  assert.equal(store.savedDispatches[0].run.mode, "new");
  assert.equal(store.savedDispatches[0].run.status, "active");
  assert.equal(store.savedDispatches[0].run.roleName, "leader");
  assert.match(store.savedDispatches[0].run.input, /role-result/);
  assert.match(store.savedDispatches[0].run.input, /taskmux task context task-1/);
  assert.doesNotMatch(store.savedDispatches[0].run.input, /taskmux task message list/);
  assert.equal(store.pending.has("task-1"), false);
  assert.deepEqual(store.operations.slice(-2), ["save-dispatch", "save-delivery"]);
});

test("Leader wakeup context includes the Brief and the latest active Decisions", async () => {
  const store = fakeStore({
    brief: {
      schemaVersion: 1,
      objective: "Restore useful task knowledge",
      boundaries: ["Keep the runtime lean"],
      currentFocus: "CLI integration",
      leaderSummary: "Storage is ready",
      updatedAt: NOW.toISOString(),
      updatedBy: "leader"
    },
    decisions: [1, 2, 3, 4].map((number) => ({
      schemaVersion: 1,
      id: `decision-${number}`,
      taskId: "task-1",
      title: `Decision ${number}`,
      rationale: `Reason ${number}`,
      status: "active",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString()
    }))
  });

  await processLeaderWakeups(store, fakeDelivery(), NOW);

  const input = store.savedDispatches[0].run.input;
  assert.match(input, /Objective: Restore useful task knowledge/);
  assert.match(input, /Keep the runtime lean/);
  assert.doesNotMatch(input, /Decision 1: Reason 1/);
  assert.match(input, /Decision 2: Reason 2/);
  assert.match(input, /Decision 4: Reason 4/);
});

test("a fresh runtime-discovered Leader may register its native session after dispatch", async () => {
  const store = fakeStore();
  const delivery = fakeDelivery({ session: null });

  const result = await processLeaderWakeups(store, delivery, NOW);

  assert.equal(result[0].status, "dispatched");
  assert.equal(store.savedDispatches[0].session, null);
  assert.equal(store.savedDispatches[0].run.mode, "new");
});

test("an idle Leader resumes its fixed native session", async () => {
  const session = roleSession({ nativeSessionId: "native-leader-1", status: "ready" });
  const store = fakeStore({ session });
  const delivery = fakeDelivery({ session });

  await processLeaderWakeups(store, delivery, NOW);

  assert.equal(delivery.calls[0].input.mode, "resume");
  assert.equal(delivery.calls[0].input.nativeSessionId, "native-leader-1");
  assert.equal(store.savedDispatches[0].session.nativeSessionId, "native-leader-1");
});

test("Leader resume refuses a replacement native session", async () => {
  const existing = roleSession({ nativeSessionId: "native-leader-1", status: "ready" });
  const replacement = roleSession({ nativeSessionId: "native-leader-2", status: "running" });
  const store = fakeStore({ session: existing });
  const delivery = fakeDelivery({ session: replacement });

  const result = await processLeaderWakeups(store, delivery, NOW);

  assert.equal(result[0].status, "failed");
  assert.match(result[0].error, /fixed native session id/);
  assert.equal(store.savedDispatches.length, 0);
  assert.equal(store.pending.has("task-1"), true);
});

test("Leader dispatch failure remains pending and records durable Operator recovery state", async () => {
  const store = fakeStore();
  const delivery = fakeDelivery({ prepareError: new Error("tmux launch failed") });

  const result = await processLeaderWakeups(store, delivery, NOW);

  assert.equal(result[0].status, "failed");
  assert.match(result[0].error, /tmux launch failed/);
  assert.equal(store.pending.has("task-1"), true);
  assert.equal(store.savedFailures.length, 1);
  assert.match(store.savedFailures[0].failure.message, /tmux launch failed/);
  assert.equal(store.savedFailures[0].notification.type, "leader-recovery-failed");
});

test("a missing Worker tmux fails its run and queues a Leader wakeup", async () => {
  const store = fakeStore();
  store.roles.push(role("worker"));
  store.activeRuns.set(key("task-1", "worker"), {
    ...activeRun("run-worker", "worker"),
    workItemId: "work-1"
  });
  store.sessions.set(key("task-1", "worker"), roleSession({ agentId: "codex-worker" }));
  const delivery = fakeDelivery({ inspect: "absent" });

  const failed = await reconcileExitedRoleRuns(store, delivery, NOW);

  assert.deepEqual(failed, ["run-worker"]);
  assert.equal(store.savedExitedRuns.length, 1);
  assert.deepEqual(store.pending.get("task-1").reasons, ["role-result", "role-run-failed"]);
});

test("a liveness probe error makes no state change", async () => {
  const store = fakeStore();
  store.roles.push(role("worker"));
  store.activeRuns.set(key("task-1", "worker"), activeRun("run-worker", "worker"));
  const delivery = fakeDelivery();
  delivery.inspectRole = async () => {
    throw new Error("tmux unavailable");
  };

  await assert.rejects(reconcileExitedRoleRuns(store, delivery, NOW), /tmux unavailable/);
  assert.equal(store.savedExitedRuns.length, 0);
  assert.deepEqual(store.pending.get("task-1").reasons, ["role-result"]);
});

test("a missing Leader tmux queues recovery, while Leader yield never self-wakes", async () => {
  const store = fakeStore();
  const leaderRun = activeRun("run-leader", "leader");
  store.activeRuns.set(key("task-1", "leader"), leaderRun);
  const delivery = fakeDelivery({ inspect: "absent" });

  const yieldedWake = queueLeaderWakeupAfterYield(store, store.tasks[0], leaderRun, NOW);
  assert.equal(yieldedWake, null);
  assert.deepEqual(store.pending.get("task-1").reasons, ["role-result"]);

  await reconcileExitedRoleRuns(store, delivery, NOW);
  assert.deepEqual(store.pending.get("task-1").reasons, ["role-result", "leader-run-failed"]);
});

test("Leader yield makes an existing pending wakeup dispatchable without adding a self-wake", async () => {
  const store = fakeStore();
  const leaderRun = activeRun("run-leader", "leader");
  store.activeRuns.set(key("task-1", "leader"), leaderRun);
  const delivery = fakeDelivery();

  assert.equal((await processLeaderWakeups(store, delivery, NOW))[0].reason, "busy");
  store.activeRuns.delete(key("task-1", "leader"));
  assert.equal(queueLeaderWakeupAfterYield(store, store.tasks[0], leaderRun, NOW), null);

  assert.equal((await processLeaderWakeups(store, delivery, NOW))[0].status, "dispatched");
  assert.equal(store.pending.has("task-1"), false);
});

function fakeStore(options = {}) {
  const task = { id: "task-1", status: "active" };
  const roles = [role("leader")];
  const pending = new Map([["task-1", mergePendingWakeup("task-1", "role-result", NOW, null)]]);
  const sessions = new Map();
  if (options.session !== undefined) sessions.set(key("task-1", "leader"), options.session);
  const store = {
    tasks: [task],
    roles,
    pending,
    sessions,
    activeRuns: new Map(),
    savedDispatches: [],
    savedFailures: [],
    savedExitedRuns: [],
    operations: [],
    listTasks: () => store.tasks,
    getTask: (taskId) => store.tasks.find((candidate) => candidate.id === taskId) ?? null,
    listRoles: (taskId) => store.roles.filter((candidate) => candidate.taskId === taskId),
    getRole: (taskId, roleName) => store.roles.find(
      (candidate) => candidate.taskId === taskId && candidate.name === roleName
    ) ?? null,
    getActiveAgentRun: (taskId, roleName) => store.activeRuns.get(key(taskId, roleName)) ?? null,
    getRoleSession: (taskId, roleName) => store.sessions.get(key(taskId, roleName)) ?? null,
    nextAgentRunId: () => `run-${store.savedDispatches.length + 1}`,
    getPendingWakeup: (taskId) => store.pending.get(taskId) ?? null,
    listPendingWakeups: () => [...store.pending.values()],
    savePendingWakeup: (wakeup) => store.pending.set(wakeup.taskId, wakeup),
    clearPendingWakeup: (taskId) => {
      store.operations.push("clear-wakeup");
      store.pending.delete(taskId);
    },
    getLeaderFailure: () => null,
    getOperatorNotification: () => null,
    getTaskBrief: () => options.brief ?? null,
    listDecisions: () => options.decisions ?? [],
    listMilestones: () => options.milestones ?? [],
    saveLeaderDispatch: (input) => {
      store.operations.push("save-dispatch");
      store.savedDispatches.push(input);
      store.activeRuns.set(key(input.task.id, input.role.name), input.run);
      store.sessions.set(key(input.task.id, input.role.name), input.session);
      store.pending.delete(input.task.id);
      return "claimed";
    },
    saveRoleRunDelivery: (input) => {
      store.operations.push("save-delivery");
      store.activeRuns.set(key(input.task.id, input.role.name), {
        ...input.run,
        deliveredAt: input.now.toISOString()
      });
    },
    saveLeaderDispatchFailure: (input) => store.savedFailures.push(input),
    saveExitedRoleRun: (input) => {
      store.savedExitedRuns.push(input);
      store.activeRuns.delete(key(input.task.id, input.role.name));
    }
  };
  return store;
}

function fakeDelivery(options = {}) {
  const calls = [];
  const delivery = {
    calls,
    prepareRoleSession: async (input) => {
      calls.push({ type: "prepare", input });
      if (options.prepareError !== undefined) throw options.prepareError;
      return {
        deliveryId: "delivery-1",
        taskId: input.taskId,
        roleName: input.roleName,
        agentId: input.agentId,
        adapterId: input.adapterId,
        mode: input.mode
      };
    },
    waitUntilReady: async (prepared) => {
      calls.push({ type: "ready", prepared });
      return {
        prepared,
        session: Object.hasOwn(options, "session") ? options.session : roleSession({
          agentId: prepared.agentId,
          nativeSessionId: "native-created-1",
          status: "running"
        })
      };
    },
    sendOnce: async (input) => {
      calls.push({ type: "sendOnce", input });
      return "sent";
    },
    inspectRole: async (input) => {
      calls.push({ type: "inspect", input });
      return options.inspect ?? "present";
    }
  };
  return delivery;
}

function role(name) {
  return {
    taskId: "task-1",
    name,
    activeAgentId: name === "leader" ? "codex-leader" : "codex-worker",
    adapterId: "codex",
    status: "running"
  };
}

function roleSession(patch = {}) {
  return {
    agentId: "codex-leader",
    adapterId: "codex",
    nativeSessionId: "native-leader-1",
    status: "running",
    ...patch
  };
}

function activeRun(id, roleName) {
  return {
    schemaVersion: 1,
    id,
    taskId: "task-1",
    roleName,
    mode: "new",
    input: "continue",
    status: "active",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
}

function key(taskId, roleName) {
  return `${taskId}/${roleName}`;
}
