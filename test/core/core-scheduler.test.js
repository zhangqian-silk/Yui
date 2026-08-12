import assert from "node:assert/strict";
import test from "node:test";

import { processLeaderWakeups } from "../../dist/scheduler/leaderWakeupProcessor.js";
import { reconcileExitedRoleRuns } from "../../dist/scheduler/roleRunLiveness.js";
import { reconcileStalledRoleRuns } from "../../dist/scheduler/roleRunStall.js";
import { processOperatorInputNotifications } from "../../dist/scheduler/operatorInputNotificationProcessor.js";
import { repairOrphanedActiveTasks } from "../../dist/scheduler/activeTaskProgress.js";
import { mergePendingWakeup } from "../../dist/scheduler/pendingWakeup.js";
import { queueLeaderWakeupAfterYield } from "../../dist/scheduler/wakeupQueue.js";
import {
  claimPending,
  completeProcessing,
  createWorkMailbox,
  enqueueSignal,
  releaseProcessing
} from "../../dist/coordination/workMailbox.js";
import { testEffectiveLaunch } from "../helpers/effectiveLaunch.js";

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

test("periodic recovery gives an orphan active Task one durable Leader wake", () => {
  const store = fakeStore();
  store.pending.clear();
  store.getWorkMailbox = () => null;

  assert.deepEqual(repairOrphanedActiveTasks(store, NOW), ["task-1"]);
  assert.deepEqual(store.pending.get("task-1").reasons, ["task-orphaned"]);
  assert.deepEqual(repairOrphanedActiveTasks(store, NOW), []);
});

test("periodic recovery does not wake a Task already owned by an active Worker", () => {
  const store = fakeStore();
  store.pending.clear();
  store.getWorkMailbox = () => null;
  store.roles.push(role("worker"));
  store.activeRuns.set(key("task-1", "worker"), activeRun("agent-run-2", "worker"));

  assert.deepEqual(repairOrphanedActiveTasks(store, NOW), []);
  assert.equal(store.pending.has("task-1"), false);
});

test("a Task mailbox trigger does not count as an owner of an active Task", () => {
  const store = fakeStore();
  store.pending.clear();
  store.getWorkMailbox = (target) => target.kind === "task"
    ? {
        target,
        pending: { reasons: ["task-updated"] },
        processing: null
      }
    : null;

  assert.deepEqual(repairOrphanedActiveTasks(store, NOW), ["task-1"]);
  assert.deepEqual(store.pending.get("task-1").reasons, ["task-orphaned"]);
});

test("a busy Leader retains its pending wakeup and receives no terminal delivery", async () => {
  const store = fakeStore();
  store.activeRuns.set(key("task-1", "leader"), activeRun("agent-run-3", "leader"));
  const delivery = fakeDelivery();

  const result = await processLeaderWakeups(store, delivery, NOW);

  assert.deepEqual(result, [{ taskId: "task-1", status: "skipped", reason: "busy" }]);
  assert.equal(store.pending.has("task-1"), true);
  assert.deepEqual(delivery.calls, []);
  assert.equal(store.savedDispatches.length, 0);
});

test("an open InputRequest retains pending wakeups until it is resolved", async () => {
  const store = fakeStore();
  store.openInputTasks.add("task-1");
  const delivery = fakeDelivery();

  assert.deepEqual(await processLeaderWakeups(store, delivery, NOW), [
    { taskId: "task-1", status: "skipped", reason: "waiting-input" }
  ]);
  assert.equal(store.pending.has("task-1"), true);
  assert.deepEqual(delivery.calls, []);

  store.openInputTasks.delete("task-1");
  assert.equal((await processLeaderWakeups(store, delivery, NOW))[0].status, "dispatched");
  assert.equal(store.pending.has("task-1"), false);
});

test("a project Task retains wakeup until its worktree cwd is ready", async () => {
  const store = fakeStore();
  store.getTaskWorkspace = () => null;
  store.tasks[0] = {
    ...store.tasks[0],
    projectBindings: [{
      projectId: "project-1",
      directory: "fixture",
      baseRef: "main"
    }]
  };
  const delivery = fakeDelivery();

  const result = await processLeaderWakeups(store, delivery, NOW);

  assert.equal(result[0].reason, "workspace-not-ready");
  assert.equal(store.pending.has("task-1"), true);
  assert.deepEqual(delivery.calls, []);
});

test("a Gitless Leader wake uses the durable empty Task workspace", async () => {
  const store = fakeStore({
    taskWorkspace: {
      schemaVersion: 2,
      owner: { type: "task", taskId: "task-1" },
      root: "/repo",
      entries: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString()
    }
  });
  const delivery = fakeDelivery();
  const result = await processLeaderWakeups(store, delivery, NOW);
  assert.deepEqual(result, [{ taskId: "task-1", runId: "agent-run-1", status: "dispatched" }]);
  assert.equal(delivery.calls[0].input.managedWorkspace?.root, "/repo");
});

test("an idle Leader starts a real wakeup run, waits for readiness, sends once, then clears wake", async () => {
  const store = fakeStore();
  const delivery = fakeDelivery();

  const result = await processLeaderWakeups(store, delivery, NOW);

  assert.deepEqual(result, [{ taskId: "task-1", runId: "agent-run-1", status: "dispatched" }]);
  assert.deepEqual(delivery.calls.map((call) => call.type), ["prepare", "ready", "sendOnce"]);
  assert.equal(delivery.calls[0].input.mode, "new");
  assert.equal(delivery.calls[2].input.receiptId.startsWith("agent-run:"), true);
  assert.equal(store.savedDispatches.length, 1);
  assert.equal(store.savedDispatches[0].run.mode, "new");
  assert.equal(store.savedDispatches[0].run.status, "active");
  assert.equal(store.savedDispatches[0].run.roleName, "leader");
  assert.equal(
    store.savedDispatches[0].run.input.startsWith(
      "Yui · task-1 · Leader · Test task · Run agent-run-1\n\n"
    ),
    true
  );
  assert.match(store.savedDispatches[0].run.input, /role-result/);
  assert.match(store.savedDispatches[0].run.input, /yui task context task-1/);
  assert.match(store.savedDispatches[0].run.input, /Current Leader Run: agent-run-1/);
  assert.match(
    store.savedDispatches[0].run.input,
    /YUI_LEADER_ACTION_RUN_ID=agent-run-1 YUI_LEADER_ACTION_RECEIPT_ID=agent-run:task-1\/agent-run-1/
  );
  assert.match(store.savedDispatches[0].run.input, /yui task run yield agent-run-1/);
  assert.match(store.savedDispatches[0].run.input, /yui task complete task-1 --summary/);
  assert.doesNotMatch(store.savedDispatches[0].run.input, /yui task message list/);
  assert.equal(store.pending.has("task-1"), false);
  assert.deepEqual(
    store.operations.slice(-3),
    ["save-prepared", "save-prepared", "save-delivery"]
  );
});

test("a launch-carried Codex Leader prompt records transport without a duplicate push", async () => {
  const store = fakeStore();
  const delivery = fakeDelivery({ session: null, inputSubmittedAtLaunch: true });

  const [result] = await processLeaderWakeups(store, delivery, NOW);

  assert.deepEqual(result, {
    taskId: "task-1",
    runId: "agent-run-1",
    status: "dispatched"
  });
  assert.deepEqual(delivery.calls.map(({ type }) => type), ["prepare", "ready", "forget"]);
  assert.equal(store.operations.at(-1), "save-delivery");
  assert.equal(store.pending.has("task-1"), false);
});

test("a launch-carried Leader prompt preserves uncertainty across readiness and persistence failures", async () => {
  for (const failure of ["readiness", "persistence"]) {
    const store = fakeStore();
    const delivery = fakeDelivery({ session: null, inputSubmittedAtLaunch: true });
    if (failure === "readiness") {
      delivery.waitUntilReady = async (prepared) => {
        delivery.calls.push({ type: "ready", prepared });
        throw new Error("provider readiness lost");
      };
    } else {
      store.saveRoleRunDelivery = () => { throw new Error("aggregate write failed"); };
    }

    const [result] = await processLeaderWakeups(store, delivery, NOW);

    assert.equal(result.status, "failed", failure);
    assert.equal(result.reason, "delivery-uncertain", failure);
    assert.equal(store.savedFailures.length, 0, failure);
    assert.equal(store.activeRuns.get(key("task-1", "leader")).id, "agent-run-1", failure);
    assert.equal(
      delivery.calls.some((call) => call.type === "forget"),
      false,
      failure
    );
  }
});

test("a Leader send or post-send persistence uncertainty preserves the claimed Run and receipt", async () => {
  for (const failAt of ["send", "persist"]) {
    const store = fakeStore();
    if (failAt === "persist") {
      store.saveRoleRunDelivery = () => { throw new Error("aggregate write failed"); };
    }
    const delivery = fakeDelivery();
    if (failAt === "send") {
      delivery.sendOnce = async (input) => {
        delivery.calls.push({ type: "sendOnce", input });
        throw new Error("receipt response lost");
      };
    }

    const [result] = await processLeaderWakeups(store, delivery, NOW);

    assert.equal(result.status, "failed");
    assert.equal(result.reason, "delivery-uncertain");
    assert.equal(store.savedFailures.length, 0);
    assert.equal(store.activeRuns.get(key("task-1", "leader")).id, "agent-run-1");
    assert.equal(
      delivery.calls.some((call) => call.type === "forget"),
      false
    );
  }
});

test("a pre-send Leader failure forgets its transient prepared binding", async () => {
  const store = fakeStore();
  const delivery = fakeDelivery();
  delivery.waitUntilReady = async (prepared) => {
    delivery.calls.push({ type: "ready", prepared });
    throw new Error("process inspection failed");
  };

  const [result] = await processLeaderWakeups(store, delivery, NOW);

  assert.equal(result.status, "failed");
  assert.deepEqual(
    delivery.calls.find((call) => call.type === "forget")?.input,
    {
      taskId: "task-1",
      roleName: "leader",
      runId: "agent-run-1"
    }
  );
});

test("Leader wakeup directs the Agent to CLI context without embedding records", async () => {
  const store = fakeStore({
    brief: {
      schemaVersion: 2,
      objective: "Restore useful task knowledge",
      boundaries: ["Keep the runtime lean"],
      technicalApproach: "Keep the Task Brief as the current plan.",
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
  assert.match(input, /yui task context task-1/);
  assert.match(input, /This Task has no bound Project Policy/);
  assert.doesNotMatch(input, /yui project knowledge list/);
  assert.doesNotMatch(input, /Restore useful task knowledge/);
  assert.doesNotMatch(input, /Keep the runtime lean/);
  assert.doesNotMatch(input, /Decision 1: Reason 1/);
  assert.doesNotMatch(input, /Decision 2: Reason 2/);
  assert.doesNotMatch(input, /Decision 4: Reason 4/);
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

test("a live opaque Leader retains its wake until exact cleanup instead of rebinding", async () => {
  const session = roleSession({ launchId: "launch-opaque-leader", status: "running" });
  delete session.nativeSessionId;
  const store = fakeStore({ session });
  const delivery = fakeDelivery({ inspect: "present" });

  const result = await processLeaderWakeups(store, delivery, NOW);

  assert.deepEqual(result, [{
    taskId: "task-1",
    status: "skipped",
    reason: "recovery-blocked"
  }]);
  assert.equal(store.pending.has("task-1"), true);
  assert.equal(store.savedDispatches.length, 0);
  assert.deepEqual(delivery.calls.map((call) => call.type), ["inspect"]);
  assert.equal("nativeSessionId" in delivery.calls[0].input, false);
});

test("Leader resume refuses a replacement native session", async () => {
  const existing = roleSession({ nativeSessionId: "native-leader-1", status: "ready" });
  const replacement = roleSession({ nativeSessionId: "native-leader-2", status: "running" });
  const store = fakeStore({ session: existing });
  const delivery = fakeDelivery({ session: replacement });

  const result = await processLeaderWakeups(store, delivery, NOW);

  assert.equal(result[0].status, "failed");
  assert.match(result[0].error, /fixed native session id/);
  assert.equal(store.savedDispatches.length, 1);
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

test("a stale Leader preparation failure is ignored after authoritative state changes", async () => {
  const store = fakeStore();
  store.saveLeaderDispatchFailure = (input) => {
    store.activeRuns.delete(key(input.task.id, input.role.name));
    store.pending.set(input.task.id, input.claimed.wakeup);
    return "state-changed";
  };
  const delivery = fakeDelivery({ prepareError: new Error("stale tmux launch failure") });

  const [result] = await processLeaderWakeups(store, delivery, NOW);

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "state-changed");
  assert.equal(store.pending.has("task-1"), true);
  assert.equal(store.savedFailures.length, 0);
});

test("a missing Worker tmux fails its run and queues a Leader wakeup", async () => {
  const store = fakeStore();
  store.roles.push(role("worker"));
  store.activeRuns.set(key("task-1", "worker"), {
    ...activeRun("agent-run-2", "worker"),
    workItemId: "work-item-1"
  });
  store.sessions.set(key("task-1", "worker"), roleSession({ agentId: "codex-worker" }));
  const delivery = fakeDelivery({ inspect: "absent" });

  const failed = await reconcileExitedRoleRuns(store, delivery, NOW);

  assert.deepEqual(failed, ["task-1/agent-run-2"]);
  assert.equal(store.savedExitedRuns.length, 1);
  assert.deepEqual(
    delivery.calls.find((call) => call.type === "forget")?.input,
    { taskId: "task-1", roleName: "worker", runId: "agent-run-2" }
  );
  assert.deepEqual(store.pending.get("task-1").reasons, ["role-result", "role-run-failed"]);
});

test("a liveness probe error makes no state change", async () => {
  const store = fakeStore();
  store.roles.push(role("worker"));
  store.activeRuns.set(key("task-1", "worker"), activeRun("agent-run-2", "worker"));
  const delivery = fakeDelivery();
  delivery.inspectRole = async () => {
    throw new Error("tmux unavailable");
  };

  await assert.rejects(reconcileExitedRoleRuns(store, delivery, NOW), /tmux unavailable/);
  assert.equal(store.savedExitedRuns.length, 0);
  assert.deepEqual(store.pending.get("task-1").reasons, ["role-result"]);
});

test("an observed Turn completion fences destructive liveness reconciliation", async () => {
  const store = fakeStore();
  store.roles.push(role("worker"));
  const run = activeRun("agent-run-2", "worker");
  store.activeRuns.set(key("task-1", "worker"), run);
  store.listPendingRuntimeTurnCompletions = () => [{
    taskId: "task-1",
    roleName: "worker",
    runId: run.id
  }];
  const delivery = fakeDelivery({ inspect: "absent" });

  assert.deepEqual(await reconcileExitedRoleRuns(store, delivery, NOW), []);
  assert.equal(store.savedExitedRuns.length, 0);
});

test("a delivery-uncertain Run is not failed by liveness in the same pass", async () => {
  const store = fakeStore();
  store.roles.push(role("worker"));
  const run = activeRun("agent-run-2", "worker");
  store.activeRuns.set(key("task-1", "worker"), run);
  const delivery = fakeDelivery({ inspect: "absent" });

  assert.deepEqual(
    await reconcileExitedRoleRuns(
      store,
      delivery,
      NOW,
      undefined,
      new Set([`task-1/${run.id}`])
    ),
    []
  );
  assert.equal(store.savedExitedRuns.length, 0);
});

test("full liveness inventory includes delivery-uncertain Runs for the shared stall pass", async () => {
  const store = fakeStore();
  store.roles.push(role("worker"));
  const run = {
    ...activeRun("agent-run-100", "worker"),
    createdAt: new Date(NOW.getTime() - 31 * 60_000).toISOString()
  };
  store.activeRuns.set(key("task-1", "worker"), run);
  const delivery = fakeDelivery({ inspect: "present" });
  const liveStatuses = new Map();

  assert.deepEqual(
    await reconcileExitedRoleRuns(
      store,
      delivery,
      NOW,
      undefined,
      new Set([`task-1/${run.id}`]),
      liveStatuses
    ),
    []
  );
  assert.equal(store.savedExitedRuns.length, 0);
  assert.equal(liveStatuses.get("task-1\0worker"), "present");

  const stalled = await reconcileStalledRoleRuns(
    store,
    delivery,
    NOW,
    undefined,
    30 * 60_000,
    liveStatuses
  );
  assert.deepEqual(stalled.map(({ runId, kind }) => ({ runId, kind })), [
    { runId: run.id, kind: "delivery-stalled" }
  ]);
  assert.equal(store.savedExitedRuns.length, 0);
});

test("cheap liveness shares one pane inventory while resource inputs stay behind the ten-minute gate", async () => {
  const store = fakeStore();
  const youngRole = role("worker");
  const oldRole = { ...role("worker-2"), name: "worker-2", activeAgentId: "codex-worker-2" };
  store.roles.push(youngRole, oldRole);
  store.activeRuns.set(key("task-1", youngRole.name), {
    ...activeRun("agent-run-101", youngRole.name),
    deliveredAt: new Date(NOW.getTime() - 5 * 60_000).toISOString()
  });
  store.activeRuns.set(key("task-1", oldRole.name), {
    ...activeRun("agent-run-102", oldRole.name),
    deliveredAt: new Date(NOW.getTime() - 11 * 60_000).toISOString()
  });
  let paneInventories = 0;
  let resourceInputs;
  const delivery = {
    async inspectRole() { throw new Error("single-Run probing is not allowed"); },
    async inspectRoles(inputs, requested) {
      paneInventories += 1;
      assert.equal(inputs.length, 2);
      resourceInputs = requested;
      return inputs.map((input) => ({
        taskId: input.taskId,
        roleName: input.roleName,
        status: "present"
      }));
    }
  };

  assert.deepEqual(await reconcileExitedRoleRuns(store, delivery, NOW), []);
  assert.equal(paneInventories, 1);
  assert.deepEqual(resourceInputs.map(({ runId }) => runId), ["agent-run-102"]);
  assert.equal(store.savedExitedRuns.length, 0);
});

test("a delivery-uncertain local Run id does not fence another Task", async () => {
  const store = fakeStore();
  store.roles.push(role("worker"));
  store.activeRuns.set(
    key("task-1", "worker"),
    activeRun("agent-run-2", "worker")
  );
  store.tasks.push({ ...store.tasks[0], id: "task-2", title: "Second Task" });
  store.roles.push({ ...role("worker"), taskId: "task-2" });
  store.activeRuns.set(key("task-2", "worker"), {
    ...activeRun("agent-run-2", "worker"),
    taskId: "task-2"
  });
  const delivery = fakeDelivery({ inspect: "absent" });

  assert.deepEqual(
    await reconcileExitedRoleRuns(
      store,
      delivery,
      NOW,
      undefined,
      new Set(["task-1/agent-run-2"])
    ),
    ["task-2/agent-run-2"]
  );
});

test("a present Role remains active until its native Turn Hook is observed", async () => {
  const store = fakeStore();
  store.roles.push(role("worker"));
  const run = {
    ...activeRun("agent-run-2", "worker"),
    deliveredAt: new Date(NOW.getTime() - 120_000).toISOString()
  };
  store.activeRuns.set(key("task-1", "worker"), run);
  const delivery = {
    ...fakeDelivery({ inspect: "present" }),
    async inspectRoleReadiness() {
      throw new Error("process readiness is not a native Turn boundary");
    }
  };

  assert.deepEqual(await reconcileExitedRoleRuns(store, delivery, NOW), []);
  assert.equal(store.activeRuns.get(key("task-1", "worker")), run);
  assert.equal(store.savedExitedRuns.length, 0);
});

test("an incomplete batch liveness snapshot is non-destructive", async () => {
  const store = fakeStore();
  store.roles.push(role("worker"));
  store.activeRuns.set(key("task-1", "worker"), activeRun("agent-run-2", "worker"));
  const delivery = fakeDelivery();
  delivery.inspectRoles = async () => [];

  await assert.rejects(
    reconcileExitedRoleRuns(store, delivery, NOW),
    /incomplete|invalid/i
  );
  assert.equal(store.savedExitedRuns.length, 0);
});

test("liveness reconciliation uses one batch inventory for all active Roles", async () => {
  const store = fakeStore();
  store.roles.push(role("worker"));
  store.activeRuns.set(key("task-1", "leader"), activeRun("agent-run-4", "leader"));
  store.activeRuns.set(key("task-1", "worker"), activeRun("agent-run-2", "worker"));
  let inventoryCalls = 0;
  const delivery = {
    async inspectRole() {
      throw new Error("per-Role inspection must not run");
    },
    async inspectRoles(inputs) {
      inventoryCalls += 1;
      return inputs.map((input) => ({
        taskId: input.taskId,
        roleName: input.roleName,
        status: "present"
      }));
    }
  };

  assert.deepEqual(await reconcileExitedRoleRuns(store, delivery, NOW), []);
  assert.equal(inventoryCalls, 1);
  assert.equal(store.savedExitedRuns.length, 0);
});

test("a missing Leader tmux queues recovery, while Leader yield never self-wakes", async () => {
  const store = fakeStore();
  const leaderRun = activeRun("agent-run-4", "leader");
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
  const leaderRun = activeRun("agent-run-4", "leader");
  store.activeRuns.set(key("task-1", "leader"), leaderRun);
  const delivery = fakeDelivery();

  assert.equal((await processLeaderWakeups(store, delivery, NOW))[0].reason, "busy");
  store.activeRuns.delete(key("task-1", "leader"));
  assert.equal(queueLeaderWakeupAfterYield(store, store.tasks[0], leaderRun, NOW), null);

  assert.equal((await processLeaderWakeups(store, delivery, NOW))[0].status, "dispatched");
  assert.equal(store.pending.has("task-1"), false);
});

test("Operator delivery releases a partial batch and receipts make the retry safe", async () => {
  const requests = [operatorRequest("input-1"), operatorRequest("input-2")];
  const store = operatorStore(requests);
  const outcomes = ["sent", "already-sent", "sent"];
  const receipts = [];
  const delivery = {
    async notifyOperatorInputOnce(input) {
      receipts.push(input.receiptId);
      return outcomes.shift();
    }
  };

  const first = await processOperatorInputNotifications(store, delivery);
  assert.deepEqual(first.map((result) => result.status), ["sent", "skipped"]);
  assert.equal(store.mailbox.processing, null);
  assert.notEqual(store.mailbox.pending, null);

  const second = await processOperatorInputNotifications(store, delivery);
  assert.deepEqual(second.map((result) => result.status), ["already-sent", "sent"]);
  assert.deepEqual(receipts, [
    "input-request:task-1/input-1",
    "input-request:task-1/input-1",
    "input-request:task-1/input-2"
  ]);
  assert.equal(store.mailbox.processing, null);
  assert.equal(store.mailbox.pending, null);
});

test("Operator delivery keeps equal local input ids from separate Tasks", async () => {
  const requests = [
    operatorRequest("input-1", "task-1"),
    operatorRequest("input-1", "task-2")
  ];
  const store = operatorStore(requests);
  const receipts = [];
  const results = await processOperatorInputNotifications(store, {
    async notifyOperatorInputOnce(input) {
      receipts.push(input.receiptId);
      return "already-sent";
    }
  });

  assert.deepEqual(results.map(({ taskId, inputRequestId }) => ({
    taskId,
    inputRequestId
  })), [
    { taskId: "task-1", inputRequestId: "input-1" },
    { taskId: "task-2", inputRequestId: "input-1" }
  ]);
  assert.deepEqual(receipts, [
    "input-request:task-1/input-1",
    "input-request:task-2/input-1"
  ]);
});

test("Operator busy and delivery errors release the claimed mailbox batch", async () => {
  for (const attempt of [
    async () => "not-ready",
    async () => { throw new Error("delivery failed"); }
  ]) {
    const store = operatorStore([operatorRequest("input-1")]);
    const [result] = await processOperatorInputNotifications(store, {
      notifyOperatorInputOnce: attempt
    });
    assert.equal(result.status === "failed" || result.reason === "operator-not-ready", true);
    assert.equal(store.mailbox.processing, null);
    assert.notEqual(store.mailbox.pending, null);
  }
});

test("Operator delivery sends one informational Task terminal notification", async () => {
  const notification = {
    schemaVersion: 1,
    taskId: "task-1",
    type: "task-terminal",
    status: "completed",
    by: "leader",
    summary: "Integrated and verified.",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
  const store = operatorStore([], [notification]);
  const deliveries = [];

  const result = await processOperatorInputNotifications(store, {
    async notifyOperatorInputOnce(input) {
      deliveries.push(input);
      return "sent";
    }
  });

  assert.deepEqual(result, [{
    terminalTaskId: "task-1",
    taskId: "task-1",
    status: "sent"
  }]);
  assert.equal(deliveries[0].receiptId, `task-terminal:task-1:completed:${NOW.toISOString()}`);
  assert.match(deliveries[0].text, /Integrated and verified/);
  assert.equal(store.mailbox.pending, null);
  assert.equal(store.mailbox.processing, null);
});

function operatorRequest(id, taskId = "task-1") {
  return {
    schemaVersion: 2,
    id,
    taskId,
    requester: {
      taskId,
      roleName: "leader",
      agentId: "codex",
      runId: "agent-run-1"
    },
    question: `Question ${id}?`,
    choices: [],
    blockedRefs: [],
    policy: { kind: "required" },
    status: "open",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
}

function operatorStore(requests, notifications = []) {
  let mailbox = createWorkMailbox({ kind: "operator" });
  for (const request of requests) {
    mailbox = enqueueSignal(mailbox, {
      reason: "input-requested",
      refs: [{ type: "input", taskId: request.taskId, id: request.id }],
      occurredAt: NOW.toISOString()
    });
  }
  for (const notification of notifications) {
    mailbox = enqueueSignal(mailbox, {
      reason: "task-terminal",
      refs: [{ type: "task", id: notification.taskId }],
      occurredAt: NOW.toISOString()
    });
  }
  const byId = new Map(requests.map((request) => [
    `${request.taskId}/${request.id}`,
    request
  ]));
  const notificationsByTask = new Map(notifications.map((notification) => [
    notification.taskId,
    notification
  ]));
  const store = {
    get mailbox() { return mailbox; },
    getPresentationContext: () => ({ timeZone: "Asia/Shanghai" }),
    getWorkMailbox: () => mailbox,
    getInputRequest: (taskId, id) => byId.get(`${taskId}/${id}`) ?? null,
    getOperatorNotification: (taskId) => notificationsByTask.get(taskId) ?? null,
    getOperatorDeliveryTarget: () => ({ roleName: "operator", adapterId: "codex" }),
    claimWorkMailbox(input) {
      if (mailbox.processing !== null) {
        return { status: "processing", processing: mailbox.processing };
      }
      if (mailbox.pending === null) return { status: "empty" };
      mailbox = claimPending(mailbox, {
        batchId: input.batchId,
        owner: input.owner,
        startedAt: input.now.toISOString()
      });
      return { status: "claimed", processing: mailbox.processing };
    },
    completeWorkMailbox(_target, batchId) {
      if (mailbox.processing?.batchId !== batchId) return false;
      mailbox = completeProcessing(mailbox, batchId);
      return true;
    },
    releaseWorkMailbox(_target, batchId) {
      if (mailbox.processing?.batchId !== batchId) return false;
      mailbox = releaseProcessing(mailbox, batchId);
      return true;
    }
  };
  return store;
}

function fakeStore(options = {}) {
  const task = {
    id: "task-1",
    title: "Test task",
    status: "active",
    projectBindings: [],
    cwd: options.taskWorkspace?.root ?? "/repo"
  };
  const taskWorkspace = options.taskWorkspace ?? {
    schemaVersion: 2,
    owner: { type: "task", taskId: "task-1" },
    root: "/repo",
    entries: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
  const roles = [
    {
      ...role("leader"),
      managedWorkspace: taskWorkspace
    }
  ];
  const pending = new Map([["task-1", mergePendingWakeup("task-1", "role-result", NOW, null)]]);
  const sessions = new Map();
  if (options.session !== undefined) sessions.set(key("task-1", "leader"), options.session);
  const store = {
    tasks: [task],
    roles,
    pending,
    sessions,
    activeRuns: new Map(),
    openInputTasks: new Set(),
    savedDispatches: [],
    savedFailures: [],
    savedExitedRuns: [],
    events: [],
    operations: [],
    getPresentationContext: () => ({ timeZone: "Asia/Shanghai" }),
    listTasks: () => store.tasks,
    getTask: (taskId) => store.tasks.find((candidate) => candidate.id === taskId) ?? null,
    getTaskWorkspace: () => taskWorkspace,
    listRoles: (taskId) => store.roles.filter((candidate) => candidate.taskId === taskId),
    getRole: (taskId, roleName) => store.roles.find(
      (candidate) => candidate.taskId === taskId && candidate.name === roleName
    ) ?? null,
    getActiveAgentRun: (taskId, roleName) => store.activeRuns.get(key(taskId, roleName)) ?? null,
    hasOpenInputRequest: (taskId) => store.openInputTasks.has(taskId),
    hasInFlightTurn: () => false,
    listPendingRuntimeTurnCompletions: () => [],
    getRoleSession: (taskId, roleName) => store.sessions.get(key(taskId, roleName)) ?? null,
    getWorkMailbox: () => null,
    releaseWorkMailbox: () => false,
    peekNextAgentRunId: () => `agent-run-${store.savedDispatches.length + 1}`,
    getPendingWakeup: (taskId) => store.pending.get(taskId) ?? null,
    listPendingWakeups: () => [...store.pending.values()],
    savePendingWakeup: (wakeup) => store.pending.set(wakeup.taskId, wakeup),
    clearPendingWakeup: (taskId) => {
      store.operations.push("clear-wakeup");
      store.pending.delete(taskId);
    },
    getLeaderFailure: () => null,
    getOperatorNotification: () => null,
    listEvents: () => store.events,
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
    saveRoleRunPrepared: (input) => {
      store.operations.push("save-prepared");
      store.sessions.set(key(input.task.id, input.role.name), input.session);
    },
    saveRoleRunDelivery: (input) => {
      store.operations.push("save-delivery");
      store.activeRuns.set(key(input.task.id, input.role.name), {
        ...input.run,
        deliveredAt: input.now.toISOString()
      });
    },
    saveLeaderDispatchFailure: (input) => {
      store.savedFailures.push(input);
      store.activeRuns.delete(key(input.task.id, input.role.name));
      store.pending.set(input.task.id, input.claimed.wakeup);
      return "failed";
    },
    saveExitedRoleRun: (input) => {
      store.savedExitedRuns.push(input);
      store.activeRuns.delete(key(input.task.id, input.role.name));
    },
    recordRoleRunStall: (input) => {
      store.events.push({
        type: "run.stalled",
        createdAt: input.now.toISOString(),
        payload: {
          runId: input.runId,
          progressAt: input.progressAt,
          evidenceKey: input.evidenceKey
        }
      });
      return "raised";
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
        mode: input.mode,
        ...(options.inputSubmittedAtLaunch === undefined
          ? {}
          : { inputSubmittedAtLaunch: options.inputSubmittedAtLaunch })
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
    forgetPrepared: (input) => {
      calls.push({ type: "forget", input });
    },
    inspectRole: async (input) => {
      calls.push({ type: "inspect", input });
      return options.inspect ?? "present";
    }
  };
  return delivery;
}

function role(name) {
  const agentId = name === "leader" ? "codex-leader" : "codex-worker";
  return {
    taskId: "task-1",
    name,
    activeAgentId: agentId,
    adapterId: "codex",
    effective: testEffectiveLaunch({ agentId, workspaceRoot: "/repo" }),
    workspace: "/repo",
    status: "running"
  };
}

function roleSession(patch = {}) {
  const session = {
    agentId: "codex-leader",
    adapterId: "codex",
    nativeSessionId: "native-leader-1",
    status: "running",
    ...patch
  };
  return {
    ...session,
    effective: patch.effective ?? testEffectiveLaunch({
      agentId: session.agentId,
      adapterId: session.adapterId,
      workspaceRoot: "/repo"
    })
  };
}

function activeRun(id, roleName) {
  return {
    schemaVersion: 4,
    id,
    taskId: "task-1",
    roleName,
    mode: "new",
    input: "continue",
    purpose: "execution",
    effective: testEffectiveLaunch({
      agentId: roleName === "leader" ? "codex-leader" : "codex-worker",
      workspaceRoot: "/repo"
    }),
    status: "active",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
}

function key(taskId, roleName) {
  return `${taskId}/${roleName}`;
}
