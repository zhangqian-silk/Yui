import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { FileTaskController } from "../../dist/controller/controller.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { RuntimeLaunchCoordinator } from "../../dist/controller/runtimeLaunchCoordinator.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { ExecutorRegistry } from "../../dist/executor/executorRegistry.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunDelivered,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import {
  RUNTIME_CLEANUP_REQUIRED_REASON,
  RUNTIME_LAUNCH_RESERVED_REASON,
  hasRuntimeCleanupObligation,
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../../dist/runtime/lifecycleReservation.js";
import { createExactInitialPromptReceipt } from "../../dist/runtime/index.js";
import {
  createRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../../dist/role/role.js";
import { createAgentRun } from "../helpers/effectiveLaunch.js";
import { failAgentRun } from "../../dist/run/agentRun.js";
import { processActiveRoleRunDeliveries } from "../../dist/scheduler/activeRoleRunDelivery.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import {
  createWorkItem,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";

const NOW = new Date("2026-07-24T00:00:00.000Z");

function fixture(t, adapterId = "codex") {
  const home = mkdtempSync(join(tmpdir(), "yui-launch-coordinator-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  const agent = createConfiguredAgent(
    `${adapterId}-personal`,
    adapterId,
    `${adapterId}-test`,
    [],
    [],
    NOW
  );
  const task = activateTask(createTask("task-1", "Runtime launch", NOW), NOW);
  const binding = createRoleAgentBinding(agent);
  const roles = ["leader", "worker"].map((roleName) => (
    createRole(task.id, roleName, [binding], agent.id, home, NOW)
  ));
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    for (const role of roles) tx.saveRole(task.id, role);
  });
  return {
    home,
    store,
    schedulerStore,
    agent,
    task,
    roles: new Map(roles.map((role) => [role.name, role]))
  };
}

function owner(fx, roleName) {
  return { scope: "task", taskId: fx.task.id, roleName };
}

function reservationMailbox(fx, roleName) {
  return fx.store.getWorkMailbox(runtimeLifecycleTarget(owner(fx, roleName)));
}

function assertReservation(fx, roleName, launchId, runId) {
  const mailbox = reservationMailbox(fx, roleName);
  assert.ok(mailbox);
  assert.equal(isRuntimeLaunchReservation(mailbox.processing, launchId), true);
  assert.deepEqual(mailbox.processing.batch.reasons, [
    RUNTIME_LAUNCH_RESERVED_REASON
  ]);
  if (runId !== undefined) {
    assert.deepEqual(mailbox.processing.executionRef, {
      type: "run",
      taskId: fx.task.id,
      id: runId
    });
  }
  return mailbox;
}

function runtimeBinding(request, options = {}) {
  const hostCreated = options.hostCreated ?? true;
  const initialPromptReceipt = options.omitInitialPromptReceipt === true
    ? undefined
    : options.initialPromptReceipt
      ?? (hostCreated
        && request.owner.scope === "task"
        && request.adapterId === "codex"
        && request.runId !== undefined
          ? exactPromptReceipt(request)
          : undefined);
  return {
    id: `binding-${options.index ?? 1}`,
    launchId: request.launchId,
    owner: request.owner,
    agentId: request.agentId,
    adapterId: request.adapterId,
    hostRef: `host-${request.owner.roleName}`,
    hostCreated,
    ...(initialPromptReceipt === undefined
      ? {}
      : { initialPromptReceipt }),
    ...(options.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: options.nativeSessionId })
  };
}

function exactPromptReceipt(request) {
  return createExactInitialPromptReceipt({
    owner: request.owner,
    agentId: request.agentId,
    adapterId: request.adapterId,
    runId: request.runId,
    launchId: request.launchId,
    workspace: request.workspace,
    ...(request.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: request.nativeSessionId })
  });
}

function unusedTmux(roleStatus = "exited") {
  return {
    ensureRoleWindow() { throw new Error("legacy launch must not run"); },
    waitUntilReady() { throw new Error("legacy readiness must not run"); },
    sendRoleInputOnce() { throw new Error("legacy delivery must not run"); },
    sendRoleInputOnceIfReady() { return "unavailable"; },
    probeRoleStatus() { return roleStatus; },
    killRole() {},
    stopTask() { return false; }
  };
}

function registry(
  coordinator,
  host,
  promptPush = async () => "busy",
  tmux = unusedTmux()
) {
  return new ExecutorRegistry(
    { plan() { throw new Error("legacy planner must not run"); } },
    tmux,
    undefined,
    {
      sessionHost: host,
      launchCoordinator: coordinator,
      promptPush: { tryPush: promptPush }
    }
  );
}

function prepareInput(fx, roleName, runId, adapterId = fx.agent.adapterId) {
  const effective = fx.schedulerStore.getRole(fx.task.id, roleName).effective;
  if (fx.store.getAgentRun(fx.task.id, runId) === null) {
    fx.store.saveAgentRun(createAgentRun(
      runId,
      fx.task.id,
      roleName,
      "new",
      `prepare ${runId}`,
      NOW,
      {
        effective
      }
    ));
  }
  return {
    taskId: fx.task.id,
    roleName,
    agentId: fx.agent.id,
    adapterId,
    workspace: fx.home,
    mode: "new",
    runId,
    effective
  };
}

async function waitFor(predicate, label, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}.`);
}

async function controllerRecoveryFixture(t, persistPrepared) {
  const fx = fixture(t, persistPrepared ? "claude" : "codex");
  const roleName = "worker";
  const role = fx.roles.get(roleName);
  const item = updateWorkItemStatus(createWorkItem(
    "work-item-1",
    fx.task.id,
    { title: "Recover one exact delivery" },
    NOW
  ), "running", NOW);
  const run = createAgentRun(
    "agent-run-1",
    fx.task.id,
    roleName,
    "new",
    "deliver after Controller restart",
    NOW,
    {
      purpose: "execution",
      workItemId: item.id,
      effective: fx.schedulerStore.getRole(fx.task.id, roleName).effective
    }
  );
  const target = { kind: "role", taskId: fx.task.id, roleName };
  fx.store.transaction((store) => {
    store.saveWorkItem(fx.task.id, item);
    store.saveRole(
      fx.task.id,
      updateRoleStatus(role, "running", NOW)
    );
    store.saveActiveAgentRun(run);
    enqueueWork(store, target, "run-dispatched", NOW, [
      { type: "run", taskId: fx.task.id, id: run.id }
    ]);
  });

  const controls = {
    state: "running",
    inspections: [],
    recreateNextStart: false,
    allowStopOwner: true,
    pushOutcome: "busy",
    starts: [],
    hostCreations: 0,
    stopCalls: 0,
    stopOwnerCalls: 0,
    stoppedBindings: [],
    stoppedOwners: []
  };
  const host = {
    async start(request) {
      const hostCreated = controls.starts.length === 0
        || controls.recreateNextStart;
      controls.recreateNextStart = false;
      controls.state = "running";
      controls.starts.push(request);
      if (hostCreated) controls.hostCreations += 1;
      return runtimeBinding(request, {
        index: controls.starts.length,
        hostCreated,
        ...(persistPrepared
          ? { nativeSessionId: "claude-native-recovery" }
          : { initialPromptReceipt: exactPromptReceipt(request) })
      });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop(binding) {
      controls.stopCalls += 1;
      controls.stoppedBindings.push(binding.owner.roleName);
      controls.state = "stopped";
    },
    async inspect() { return { state: controls.state }; },
    async inspectOwner() {
      return {
        state: controls.inspections.shift() ?? controls.state
      };
    },
    async stopOwner(owner) {
      controls.stopOwnerCalls += 1;
      controls.stoppedOwners.push(owner.roleName);
      if (!controls.allowStopOwner) return false;
      controls.state = "stopped";
      return true;
    }
  };
  const initialCoordinator = new RuntimeLaunchCoordinator(
    fx.schedulerStore,
    host,
    {
      createGenerationId: () => "original-generation",
      now: () => NOW
    }
  );
  let launchId;
  let session;
  if (persistPrepared) {
    const initialDelivery = registry(
      initialCoordinator,
      host,
      async () => "busy",
      unusedTmux("running")
    );
    const [initial] = await processActiveRoleRunDeliveries(
      fx.schedulerStore,
      initialDelivery,
      NOW
    );
    assert.equal(initial.reason, "not-ready");
    session = fx.store.getRoleSession(fx.task.id, roleName);
    launchId = session.launchId;
    assert.equal(session.nativeSessionId, "claude-native-recovery");
  } else {
    const claim = fx.schedulerStore.claimWorkMailbox({
      target,
      batchId: `agent-run:${fx.task.id}/${run.id}`,
      owner: "controller",
      now: NOW,
      executionRef: { type: "run", taskId: fx.task.id, id: run.id }
    });
    assert.equal(claim.status, "claimed");
    const binding = await initialCoordinator.prepare({
      owner: owner(fx, roleName),
      agentId: fx.agent.id,
      adapterId: fx.agent.adapterId,
      effective: run.effective,
      workspace: fx.home,
      mode: "new",
      runId: run.id
    }, "deferred");
    launchId = binding.launchId;
    session = null;
    assert.equal(binding.nativeSessionId, undefined);
    assert.equal(fx.store.getTaskRoleSessionSet(fx.task.id, roleName), null);
  }
  assertReservation(fx, roleName, launchId, run.id);
  assert.equal(
    fx.store.getWorkMailbox(target).processing.executionRef.id,
    run.id
  );
  assert.equal(
    fx.store.getWorkMailbox(target).processing.batchId,
    `agent-run:${fx.task.id}/${run.id}`
  );
  if (persistPrepared) {
    assert.equal(
      fx.store.getTaskRoleSessionSet(fx.task.id, roleName).inFlight.runId,
      run.id
    );
  }

  return {
    ...fx,
    roleName,
    role,
    item,
    run,
    target,
    launchId,
    session,
    controls,
    host,
    startController(deliveryRetryLimit = 2) {
      const store = new FileTaskStore(fx.home);
      const adapter = new FileSchedulerStoreAdapter(store);
      const delivery = registry(
        new RuntimeLaunchCoordinator(adapter, host, {
          createGenerationId: () => "must-not-replace-original",
          now: () => NOW
        }),
        host,
        async () => controls.pushOutcome,
        unusedTmux("running")
      );
      const errors = [];
      const controller = new FileTaskController(adapter, delivery, {
        signalWindowMs: 1,
        deliveryRetryMs: 2,
        deliveryRetryLimit,
        now: () => NOW,
        onError: (error) => errors.push(error),
        lifecycleHost: host
      });
      t.after(() => controller.stop());
      return { store, adapter, delivery, controller, errors };
    }
  };
}

function preparedControllerRecoveryFixture(t) {
  return controllerRecoveryFixture(t, true);
}

function prePreparedControllerRecoveryFixture(t) {
  return controllerRecoveryFixture(t, false);
}

test("fresh Codex Leader and Worker reserve before start and their first matching Hook binds the native session", async (t) => {
  const fx = fixture(t);
  const starts = [];
  const host = {
    async start(request) {
      assertReservation(fx, request.owner.roleName, request.launchId);
      starts.push(request);
      return runtimeBinding(request, { index: starts.length });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() {},
    async inspect() { return { state: "running" }; },
    async inspectOwner() { return { state: "running" }; },
    async stopOwner() { return true; }
  };
  const generations = ["leader-generation", "worker-generation"];
  const coordinator = new RuntimeLaunchCoordinator(
    fx.schedulerStore,
    host,
    {
      createGenerationId: () => generations.shift(),
      now: () => NOW
    }
  );
  const delivery = registry(coordinator, host);

  for (const [index, roleName] of ["leader", "worker"].entries()) {
    const input = prepareInput(fx, roleName, `agent-run-${index + 1}`);
    const prepared = await delivery.prepareRoleSession(input);
    const ready = await delivery.waitUntilReady(prepared);

    assert.equal(ready.session, null);
    assert.equal(prepared.sessionStarted, true);
    assertReservation(fx, roleName, prepared.launchId);

    const hook = {
      taskId: fx.task.id,
      roleName,
      agentId: fx.agent.id,
      adapterId: fx.agent.adapterId,
      launchId: prepared.launchId,
      nativeSessionId: `thread-${roleName}`,
      turnId: `turn-${roleName}`,
      runId: input.runId,
      summary: `${roleName} ready`
    };
    assert.equal(
      fx.schedulerStore.classifyRuntimeTurnCompleted(hook),
      "apply"
    );
    fx.schedulerStore.observeRuntimeTurnCompleted(hook, NOW);

    assert.equal(
      fx.store.getRoleSession(fx.task.id, roleName).nativeSessionId,
      hook.nativeSessionId
    );
    assert.equal(reservationMailbox(fx, roleName), null);
  }

  assert.deepEqual(
    starts.map((request) => request.owner.roleName),
    ["leader", "worker"]
  );
});

test("a fresh Codex argv prompt without its exact receipt retains the reservation and never falls back to push", async (t) => {
  const fx = fixture(t);
  let pushes = 0;
  const host = {
    async start(request) {
      return runtimeBinding(request, { omitInitialPromptReceipt: true });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() { throw new Error("an unacknowledged binding must not be trusted"); },
    async inspect() { return { state: "running" }; },
    async inspectOwner() { return { state: "running" }; },
    async stopOwner() { return true; }
  };
  const delivery = registry(
    new RuntimeLaunchCoordinator(fx.schedulerStore, host, {
      createGenerationId: () => "missing-receipt-generation",
      now: () => NOW
    }),
    host,
    async () => {
      pushes += 1;
      return "delivered";
    }
  );

  await assert.rejects(
    delivery.prepareRoleSession(prepareInput(fx, "worker", "agent-run-1")),
    /initial prompt.*receipt|binding that does not match/i
  );
  const mailbox = reservationMailbox(fx, "worker");
  assert.ok(mailbox);
  assert.equal(isRuntimeLaunchReservation(mailbox.processing), true);
  assert.deepEqual(mailbox.processing.batch.reasons, [RUNTIME_LAUNCH_RESERVED_REASON]);
  assert.deepEqual(mailbox.processing.executionRef, {
    type: "run",
    taskId: fx.task.id,
    id: "agent-run-1"
  });
  assert.deepEqual(mailbox.pending.reasons, [RUNTIME_CLEANUP_REQUIRED_REASON]);
  assert.equal(pushes, 0);
});

test("a busy retry for one delivery reuses the prepared binding without starting twice", async (t) => {
  const fx = fixture(t);
  let starts = 0;
  const host = {
    async start(request) {
      starts += 1;
      // An already-running Role pane receives this new Run through the active
      // push path; no launch argv receipt exists for the new prompt.
      return runtimeBinding(request, { hostCreated: false });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() {},
    async inspect() { return { state: "running" }; },
    async inspectOwner() { return { state: "running" }; },
    async stopOwner() { return true; }
  };
  const coordinator = new RuntimeLaunchCoordinator(fx.schedulerStore, host, {
    createGenerationId: () => "busy-generation",
    now: () => NOW
  });
  let pushes = 0;
  const delivery = registry(coordinator, host, async () => {
    pushes += 1;
    return "busy";
  });
  const input = prepareInput(fx, "worker", "agent-run-1");

  const first = await delivery.prepareRoleSession(input);
  const ready = await delivery.waitUntilReady(first);
  assert.equal(await delivery.sendOnce({
    delivery: ready,
    receiptId: `agent-run:${fx.task.id}/agent-run-1`,
    text: "work"
  }), "busy");
  const retried = await delivery.prepareRoleSession(input);

  assert.equal(retried, first);
  assert.equal(starts, 1);
  assert.equal(pushes, 1);
  assertReservation(fx, "worker", first.launchId);
});

test("a known Claude preparation retains its exact Run reservation until delivery", async (t) => {
  const fx = fixture(t, "claude");
  let hostPresent = false;
  let createdHosts = 0;
  let starts = 0;
  const host = {
    async start(request) {
      assertReservation(fx, request.owner.roleName, request.launchId);
      starts += 1;
      const hostCreated = !hostPresent;
      hostPresent = true;
      if (hostCreated) createdHosts += 1;
      return runtimeBinding(request, {
        nativeSessionId: "claude-native-1",
        hostCreated
      });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() {},
    async inspect() { return { state: "running" }; },
    async inspectOwner() { return { state: "running" }; },
    async stopOwner() { return true; }
  };
  const coordinator = new RuntimeLaunchCoordinator(fx.schedulerStore, host, {
    createGenerationId: () => "claude-generation",
    now: () => NOW
  });
  const delivery = registry(coordinator, host);
  const input = prepareInput(fx, "worker", "agent-run-1");
  const run = createAgentRun(
    input.runId,
    fx.task.id,
    input.roleName,
    "new",
    "work",
    NOW,
    { effective: input.effective }
  );
  fx.store.transaction((tx) => {
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    tx.saveRole(
      fx.task.id,
      updateRoleStatus(fx.roles.get(input.roleName), "running", NOW)
    );
  });

  const prepared = await delivery.prepareRoleSession(input);
  const ready = await delivery.waitUntilReady(prepared);
  assert.equal(ready.session.nativeSessionId, "claude-native-1");
  assertReservation(fx, input.roleName, prepared.launchId);

  fx.schedulerStore.saveRoleRunPrepared({
    task: fx.schedulerStore.getTask(fx.task.id),
    role: fx.schedulerStore.getRole(fx.task.id, input.roleName),
    run,
    session: ready.session,
    launchId: prepared.launchId,
    now: NOW
  });

  assert.equal(
    fx.store.getRoleSession(fx.task.id, input.roleName).nativeSessionId,
    "claude-native-1"
  );
  assertReservation(fx, input.roleName, prepared.launchId, input.runId);

  const restartedStore = new FileTaskStore(fx.home);
  const restartedSchedulerStore = new FileSchedulerStoreAdapter(restartedStore);
  const restartedDelivery = registry(
    new RuntimeLaunchCoordinator(restartedSchedulerStore, host, {
      createGenerationId: () => "must-not-replace-prepared-generation",
      now: () => NOW
    }),
    host
  );
  const recovered = await restartedDelivery.prepareRoleSession(input);
  const recoveredReady = await restartedDelivery.waitUntilReady(recovered);

  assert.equal(recovered.launchId, prepared.launchId);
  assert.equal(recovered.sessionStarted, false);
  assert.equal(recoveredReady.session.nativeSessionId, "claude-native-1");
  assert.equal(createdHosts, 1);
  assert.equal(starts, 2);
  assertReservation(fx, input.roleName, prepared.launchId, input.runId);

  restartedSchedulerStore.saveRoleRunDelivery({
    task: restartedSchedulerStore.getTask(fx.task.id),
    role: restartedSchedulerStore.getRole(fx.task.id, input.roleName),
    run,
    session: recoveredReady.session,
    launchId: prepared.launchId,
    now: NOW
  });

  assert.equal(reservationMailbox(fx, input.roleName), null);
  assert.notEqual(fx.store.getAgentRun(fx.task.id, run.id).pushedAt, undefined);
});

for (const inspectionState of ["stopped", "running", "unavailable"]) {
  test(`start failure with owner ${inspectionState} ${
    inspectionState === "stopped" ? "clears the reservation" : "retains reservation plus cleanup"
  }`, async (t) => {
    const fx = fixture(t);
    const host = {
      async start(request) {
        assertReservation(fx, request.owner.roleName, request.launchId);
        throw new Error(`start failed: ${inspectionState}`);
      },
      async resume() { throw new Error("resume is not expected"); },
      async stop() {},
      async inspect() { return { state: inspectionState }; },
      async inspectOwner() { return { state: inspectionState }; },
      async stopOwner() { return false; }
    };
    const coordinator = new RuntimeLaunchCoordinator(fx.schedulerStore, host, {
      createGenerationId: () => `${inspectionState}-generation`,
      now: () => NOW
    });
    const delivery = registry(coordinator, host);

    await assert.rejects(
      delivery.prepareRoleSession(
        prepareInput(fx, "worker", "agent-run-1")
      ),
      new RegExp(`start failed: ${inspectionState}`)
    );

    const mailbox = reservationMailbox(fx, "worker");
    if (inspectionState === "stopped") {
      assert.equal(mailbox, null);
    } else {
      assert.ok(mailbox);
      assert.equal(isRuntimeLaunchReservation(mailbox.processing), true);
      assert.deepEqual(mailbox.pending.reasons, [
        RUNTIME_CLEANUP_REQUIRED_REASON
      ]);
    }
  });
}

test("after Controller restart an existing running host reuses its generation without creating another host", async (t) => {
  const fx = fixture(t);
  let hostPresent = false;
  let createdHosts = 0;
  const starts = [];
  const host = {
    async start(request) {
      const hostCreated = !hostPresent;
      hostPresent = true;
      if (hostCreated) createdHosts += 1;
      starts.push(request);
      return runtimeBinding(request, {
        index: starts.length,
        hostCreated,
        initialPromptReceipt: exactPromptReceipt(request)
      });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() { hostPresent = false; },
    async inspect() {
      return { state: hostPresent ? "running" : "stopped" };
    },
    async inspectOwner() {
      return { state: hostPresent ? "running" : "stopped" };
    },
    async stopOwner() {
      hostPresent = false;
      return true;
    }
  };
  const firstCoordinator = new RuntimeLaunchCoordinator(
    fx.schedulerStore,
    host,
    {
      createGenerationId: () => "before-restart",
      now: () => NOW
    }
  );
  const first = await registry(firstCoordinator, host).prepareRoleSession(
    prepareInput(fx, "leader", "agent-run-1")
  );
  assertReservation(fx, "leader", first.launchId);

  const restartedStore = new FileTaskStore(fx.home);
  const restartedReservations = new FileSchedulerStoreAdapter(restartedStore);
  const restartedCoordinator = new RuntimeLaunchCoordinator(
    restartedReservations,
    host,
    {
      createGenerationId: () => "unused-restart-candidate",
      now: () => NOW
    }
  );
  const recovered = await registry(
    restartedCoordinator,
    host
  ).prepareRoleSession(
    prepareInput(fx, "leader", "agent-run-1")
  );

  assert.equal(recovered.launchId, first.launchId);
  assert.equal(recovered.sessionStarted, false);
  assert.equal(createdHosts, 1);
  assert.equal(starts.length, 2);
  assert.equal(starts[1].launchId, first.launchId);
  assertReservation(fx, "leader", first.launchId);
});

for (const inspectionState of ["starting", "unavailable"]) {
  test(`same-Run ${inspectionState} recovery retains its exact generation as retryable`, async (t) => {
    const fx = fixture(t);
    let state = "running";
    let starts = 0;
    const host = {
      async start(request) {
        starts += 1;
        return runtimeBinding(request, { index: starts, hostCreated: true });
      },
      async resume() { throw new Error("resume is not expected"); },
      async stop() {},
      async inspect() { return { state }; },
      async inspectOwner() { return { state }; },
      async stopOwner() { return true; }
    };
    const input = prepareInput(fx, "worker", "agent-run-1");
    const first = await registry(
      new RuntimeLaunchCoordinator(fx.schedulerStore, host, {
        createGenerationId: () => `${inspectionState}-generation`,
        now: () => NOW
      }),
      host
    ).prepareRoleSession(input);
    state = inspectionState;

    const restarted = registry(
      new RuntimeLaunchCoordinator(
        new FileSchedulerStoreAdapter(new FileTaskStore(fx.home)),
        host,
        {
          createGenerationId: () => "must-not-renew",
          now: () => NOW
        }
      ),
      host
    );
    await assert.rejects(
      restarted.prepareRoleSession(input),
      (error) => {
        assert.equal(error.name, "RuntimeLaunchError");
        assert.equal(error.retryable, true);
        assert.equal(error.launchId, first.launchId);
        return true;
      }
    );

    assert.equal(starts, 1);
    assertReservation(fx, "worker", first.launchId, input.runId);
  });
}

test("a confirmed-stopped generation is lost for the same active Run instead of renewed", async (t) => {
  const fx = fixture(t);
  let hostPresent = false;
  let starts = 0;
  const host = {
    async start(request) {
      starts += 1;
      hostPresent = true;
      return runtimeBinding(request, { index: starts, hostCreated: true });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() { hostPresent = false; },
    async inspect() { return { state: hostPresent ? "running" : "stopped" }; },
    async inspectOwner() { return { state: hostPresent ? "running" : "stopped" }; },
    async stopOwner() { hostPresent = false; return true; }
  };
  const input = prepareInput(fx, "worker", "agent-run-1");
  const first = await registry(
    new RuntimeLaunchCoordinator(fx.schedulerStore, host, {
      createGenerationId: () => "stopped-generation",
      now: () => NOW
    }),
    host
  ).prepareRoleSession(input);
  hostPresent = false;

  const restarted = registry(
    new RuntimeLaunchCoordinator(
      new FileSchedulerStoreAdapter(new FileTaskStore(fx.home)),
      host,
      {
        createGenerationId: () => "forbidden-renewal",
        now: () => NOW
      }
    ),
    host
  );
  await assert.rejects(
    restarted.prepareRoleSession(input),
    (error) => {
      assert.equal(error.name, "RuntimeLaunchError");
      assert.equal(error.retryable, false);
      assert.equal(error.launchId, first.launchId);
      return true;
    }
  );

  assert.equal(starts, 1);
  assertReservation(fx, "worker", first.launchId, input.runId);
});

test("a host recreated after a same-Run running probe reports generation loss without renewal", async (t) => {
  const fx = fixture(t);
  let hostPresent = false;
  let starts = 0;
  let stops = 0;
  const host = {
    async start(request) {
      starts += 1;
      if (starts === 2) {
        // The old pane exits after inspectOwner reported running but before
        // ensureRoleWindow. Reusing its generation would admit an ABA Hook.
        hostPresent = false;
      }
      const hostCreated = !hostPresent;
      hostPresent = true;
      return runtimeBinding(request, {
        index: starts,
        hostCreated,
        initialPromptReceipt: exactPromptReceipt(request)
      });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() {
      stops += 1;
      hostPresent = false;
    },
    async inspect() {
      return { state: hostPresent ? "running" : "stopped" };
    },
    async inspectOwner() {
      return { state: hostPresent ? "running" : "stopped" };
    },
    async stopOwner() {
      hostPresent = false;
      return true;
    }
  };
  const first = await registry(
    new RuntimeLaunchCoordinator(fx.schedulerStore, host, {
      createGenerationId: () => "old-generation",
      now: () => NOW
    }),
    host
  ).prepareRoleSession(
    prepareInput(fx, "leader", "agent-run-1")
  );
  assertReservation(fx, "leader", first.launchId, "agent-run-1");

  const restartedCoordinator = new RuntimeLaunchCoordinator(
    new FileSchedulerStoreAdapter(new FileTaskStore(fx.home)),
    host,
    {
      createGenerationId: () => "must-not-renew",
      now: () => NOW
    }
  );
  await assert.rejects(
    restartedCoordinator.prepare({
      owner: owner(fx, "leader"),
      agentId: fx.agent.id,
      adapterId: fx.agent.adapterId,
      effective: fx.schedulerStore.getRole(fx.task.id, "leader").effective,
      workspace: fx.home,
      mode: "new",
      runId: "agent-run-1"
    }, "deferred"),
    (error) => {
      assert.equal(error.name, "RuntimeLaunchError");
      assert.equal(error.retryable, false);
      assert.equal(error.launchId, first.launchId);
      return true;
    }
  );

  assert.equal(stops, 0);
  assert.equal(hostPresent, true);
  assertReservation(fx, "leader", first.launchId, "agent-run-1");
});

for (const initialRecoveryState of ["running", "starting"]) {
  test(`Controller restart recovers a same-Run ${initialRecoveryState} host and delivers on its original generation`, async (t) => {
    const fx = await preparedControllerRecoveryFixture(t);
    if (initialRecoveryState === "starting") {
      fx.controls.inspections.push("starting", "running");
    }
    fx.controls.pushOutcome = "sent";
    const recovery = fx.startController(2);

    recovery.controller.signal(`role:${fx.task.id}/${fx.roleName}`);
    await waitFor(
      () => recovery.store.getAgentRun(fx.task.id, fx.run.id)?.pushedAt !== undefined,
      "the original Run to be delivered"
    );

    const delivered = recovery.store.getAgentRun(fx.task.id, fx.run.id);
    assert.equal(delivered.status, "active");
    assert.equal(fx.controls.hostCreations, 1);
    assert.equal(fx.controls.starts.length, 2);
    assert.deepEqual(
      new Set(fx.controls.starts.map((request) => request.launchId)),
      new Set([fx.launchId])
    );
    assert.equal(
      recovery.store.getRoleSession(fx.task.id, fx.roleName).nativeSessionId,
      fx.session.nativeSessionId
    );
    assert.equal(reservationMailbox(fx, fx.roleName), null);
    const item = recovery.store.getWorkItem(fx.task.id, fx.item.id);
    assert.equal(item.status, "running");
    assert.equal(item.candidates.length, 0);
    assert.deepEqual(recovery.errors, []);
  });
}

for (const runtimeState of ["starting", "unavailable"]) {
  test(`Controller exhausts same-Run ${runtimeState} recovery through exact failure and confirmed cleanup`, async (t) => {
    const fx = await preparedControllerRecoveryFixture(t);
    fx.controls.state = runtimeState;
    fx.controls.allowStopOwner = false;
    const recovery = fx.startController(1);

    recovery.controller.signal(`role:${fx.task.id}/${fx.roleName}`);
    await waitFor(
      () => recovery.store.getAgentRun(fx.task.id, fx.run.id)?.status === "failed",
      `the ${runtimeState} Run to fail exactly`
    );

    assert.equal(
      recovery.store.getRoleSession(fx.task.id, fx.roleName).status === "stopped",
      false
    );
    assert.equal(
      hasRuntimeCleanupObligation(reservationMailbox(fx, fx.roleName)),
      true
    );
    assert.equal(recovery.store.getActiveAgentRun(fx.task.id, fx.roleName), null);
    const failedItem = recovery.store.getWorkItem(fx.task.id, fx.item.id);
    assert.equal(failedItem.status, "failed");
    assert.equal(failedItem.candidates.length, 0);
    assert.equal(
      fx.controls.starts.filter((request) => request.owner.roleName === fx.roleName).length,
      1
    );
    assert.equal(
      recovery.store.getRoleSession(fx.task.id, fx.roleName).nativeSessionId,
      fx.session.nativeSessionId
    );
    await waitFor(
      () => fx.controls.stoppedOwners.includes(fx.roleName),
      `the ${runtimeState} cleanup attempt`
    );
    assert.notEqual(
      recovery.store.getRoleSession(fx.task.id, fx.roleName).status,
      "stopped"
    );

    fx.controls.allowStopOwner = true;
    recovery.controller.signal(`role:${fx.task.id}/${fx.roleName}`);
    await waitFor(
      () => recovery.store.getRoleSession(fx.task.id, fx.roleName).status === "stopped",
      `the ${runtimeState} owner cleanup confirmation`
    );
    assert.equal(reservationMailbox(fx, fx.roleName), null);
  });
}

for (const recoveryLoss of ["stopped", "recreated"]) {
  test(`Controller terminalizes same-Run ${recoveryLoss} generation loss without renewal`, async (t) => {
    const fx = await preparedControllerRecoveryFixture(t);
    if (recoveryLoss === "stopped") {
      fx.controls.state = "stopped";
    } else {
      fx.controls.state = "running";
      fx.controls.recreateNextStart = true;
    }
    const recovery = fx.startController(3);

    recovery.controller.signal(`role:${fx.task.id}/${fx.roleName}`);
    await waitFor(
      () => recovery.store.getAgentRun(fx.task.id, fx.run.id)?.status === "failed"
        && recovery.store.getRoleSession(fx.task.id, fx.roleName)?.status === "stopped",
      `the ${recoveryLoss} generation to terminalize and clean up`
    );

    assert.equal(recovery.store.getActiveAgentRun(fx.task.id, fx.roleName), null);
    assert.equal(fx.controls.stoppedBindings.includes(fx.roleName), false);
    assert.equal(
      fx.controls.stoppedOwners.filter((roleName) => roleName === fx.roleName).length,
      1
    );
    const workerStarts = fx.controls.starts.filter(
      (request) => request.owner.roleName === fx.roleName
    );
    assert.deepEqual(
      new Set(workerStarts.map((request) => request.launchId)),
      new Set([fx.launchId])
    );
    assert.equal(
      workerStarts.length,
      recoveryLoss === "stopped" ? 1 : 2
    );
    assert.equal(
      recovery.store.getRoleSession(fx.task.id, fx.roleName).nativeSessionId,
      fx.session.nativeSessionId
    );
    assert.equal(reservationMailbox(fx, fx.roleName), null);
    const failedItem = recovery.store.getWorkItem(fx.task.id, fx.item.id);
    assert.equal(failedItem.status, "failed");
    assert.equal(failedItem.candidates.length, 0);
    assert.equal(recovery.adapter.classifyRuntimeTurnCompleted({
      taskId: fx.task.id,
      roleName: fx.roleName,
      agentId: fx.agent.id,
      adapterId: fx.agent.adapterId,
      launchId: fx.launchId,
      nativeSessionId: fx.session.nativeSessionId,
      turnId: `late-${recoveryLoss}`,
      runId: fx.run.id
    }), "obsolete");
    const lateDeliveries = await processActiveRoleRunDeliveries(
      recovery.adapter,
      recovery.delivery,
      NOW
    );
    assert.equal(lateDeliveries.some((delivery) => (
      delivery.roleName === fx.roleName && delivery.runId === fx.run.id
    )), false);
    assert.equal(
      recovery.store.getWorkItem(fx.task.id, fx.item.id).candidates.length,
      0
    );
  });
}

for (const runtimeState of ["starting", "unavailable"]) {
  test(`Controller bounds pre-prepared same-Run ${runtimeState} recovery and fails it exactly once`, async (t) => {
    const fx = await prePreparedControllerRecoveryFixture(t);
    fx.controls.state = runtimeState;
    fx.controls.allowStopOwner = false;
    const recovery = fx.startController(1);

    recovery.controller.signal(`role:${fx.task.id}/${fx.roleName}`);
    await waitFor(
      () => recovery.store.getAgentRun(fx.task.id, fx.run.id)?.status === "failed",
      `the pre-prepared ${runtimeState} Run to exhaust its bounded retry`
    );
    await waitFor(
      () => fx.controls.stoppedOwners.includes(fx.roleName),
      `the pre-prepared ${runtimeState} cleanup attempt`
    );

    assert.equal(recovery.store.getActiveAgentRun(fx.task.id, fx.roleName), null);
    assert.equal(recovery.store.getTaskRoleSessionSet(fx.task.id, fx.roleName), null);
    assert.equal(
      hasRuntimeCleanupObligation(reservationMailbox(fx, fx.roleName)),
      true
    );
    const failedItem = recovery.store.getWorkItem(fx.task.id, fx.item.id);
    assert.equal(failedItem.status, "failed");
    assert.equal(failedItem.candidates.length, 0);
    const workerStarts = fx.controls.starts.filter(
      (request) => request.owner.roleName === fx.roleName
    );
    assert.equal(workerStarts.length, 1);
    assert.deepEqual(
      new Set(workerStarts.map((request) => request.launchId)),
      new Set([fx.launchId])
    );
    assert.equal(fx.controls.hostCreations, 1);

    fx.controls.allowStopOwner = true;
    recovery.controller.signal(`role:${fx.task.id}/${fx.roleName}`);
    await waitFor(
      () => reservationMailbox(fx, fx.roleName) === null,
      `the pre-prepared ${runtimeState} cleanup confirmation`
    );
    assert.equal(recovery.adapter.classifyRuntimeTurnCompleted({
      taskId: fx.task.id,
      roleName: fx.roleName,
      agentId: fx.agent.id,
      adapterId: fx.agent.adapterId,
      launchId: fx.launchId,
      nativeSessionId: "late-native-prepared-gap",
      turnId: `late-pre-prepared-${runtimeState}`,
      runId: fx.run.id
    }), "obsolete");

    const failureEvents = recovery.store.listEvents(fx.task.id).filter(
      (event) => event.type === "runtime.role-delivery-failed"
        && event.payload.runId === fx.run.id
    ).length;
    assert.equal(failureEvents, 1);
    const workerStartCount = workerStarts.length;
    const restarted = fx.startController(1);
    await restarted.controller.pump();
    assert.equal(
      fx.controls.starts.filter(
        (request) => request.owner.roleName === fx.roleName
      ).length,
      workerStartCount
    );
    assert.equal(restarted.store.listEvents(fx.task.id).filter(
      (event) => event.type === "runtime.role-delivery-failed"
        && event.payload.runId === fx.run.id
    ).length, failureEvents);
    assert.equal(
      restarted.store.getWorkItem(fx.task.id, fx.item.id).candidates.length,
      0
    );
  });
}

for (const recoveryLoss of ["stopped", "recreated"]) {
  test(`Controller immediately terminalizes a pre-prepared same-Run ${recoveryLoss} generation loss`, async (t) => {
    const fx = await prePreparedControllerRecoveryFixture(t);
    fx.controls.allowStopOwner = false;
    if (recoveryLoss === "stopped") {
      fx.controls.state = "stopped";
    } else {
      fx.controls.state = "running";
      fx.controls.recreateNextStart = true;
    }
    const recovery = fx.startController(10);

    await recovery.controller.pump();
    assert.equal(
      recovery.store.getAgentRun(fx.task.id, fx.run.id).status,
      "failed"
    );
    assert.equal(recovery.store.getActiveAgentRun(fx.task.id, fx.roleName), null);
    assert.equal(recovery.store.getTaskRoleSessionSet(fx.task.id, fx.roleName), null);
    assert.equal(
      hasRuntimeCleanupObligation(reservationMailbox(fx, fx.roleName)),
      true
    );
    const workerStarts = fx.controls.starts.filter(
      (request) => request.owner.roleName === fx.roleName
    );
    assert.equal(workerStarts.length, recoveryLoss === "stopped" ? 1 : 2);
    assert.deepEqual(
      new Set(workerStarts.map((request) => request.launchId)),
      new Set([fx.launchId])
    );
    assert.equal(
      recovery.store.getWorkItem(fx.task.id, fx.item.id).candidates.length,
      0
    );

    await waitFor(
      () => fx.controls.stoppedOwners.includes(fx.roleName),
      `the pre-prepared ${recoveryLoss} cleanup attempt`
    );
    fx.controls.allowStopOwner = true;
    recovery.controller.signal(`role:${fx.task.id}/${fx.roleName}`);
    await waitFor(
      () => reservationMailbox(fx, fx.roleName) === null,
      `the pre-prepared ${recoveryLoss} cleanup confirmation`
    );
    assert.equal(recovery.adapter.classifyRuntimeTurnCompleted({
      taskId: fx.task.id,
      roleName: fx.roleName,
      agentId: fx.agent.id,
      adapterId: fx.agent.adapterId,
      launchId: fx.launchId,
      nativeSessionId: "late-native-prepared-gap",
      turnId: `late-pre-prepared-${recoveryLoss}`,
      runId: fx.run.id
    }), "obsolete");
  });
}

for (const initialState of ["starting", "unavailable"]) {
  test(`Controller persists and delivers a pre-prepared ${initialState}-to-running Run on its original generation`, async (t) => {
    const fx = await prePreparedControllerRecoveryFixture(t);
    fx.controls.inspections.push(initialState, "running");
    fx.controls.pushOutcome = "sent";
    const recovery = fx.startController(2);

    recovery.controller.signal(`role:${fx.task.id}/${fx.roleName}`);
    await waitFor(
      () => recovery.store.getAgentRun(fx.task.id, fx.run.id)?.pushedAt !== undefined,
      `the pre-prepared ${initialState} Run to deliver`
    );

    const delivered = recovery.store.getAgentRun(fx.task.id, fx.run.id);
    assert.equal(delivered.status, "active");
    const sessions = recovery.store.getTaskRoleSessionSet(
      fx.task.id,
      fx.roleName
    );
    assert.equal(sessions.sessions[fx.agent.id], undefined);
    assert.equal(sessions.inFlight.runId, fx.run.id);
    assert.notEqual(sessions.inFlight.pushedAt, undefined);
    assert.equal(sessions.inFlight.deliveredAt, undefined);
    const workerStarts = fx.controls.starts.filter(
      (request) => request.owner.roleName === fx.roleName
    );
    assert.equal(workerStarts.length, 2);
    assert.equal(fx.controls.hostCreations, 1);
    assert.deepEqual(
      new Set(workerStarts.map((request) => request.launchId)),
      new Set([fx.launchId])
    );
    assertReservation(fx, fx.roleName, fx.launchId, fx.run.id);
    const item = recovery.store.getWorkItem(fx.task.id, fx.item.id);
    assert.equal(item.status, "running");
    assert.equal(item.candidates.length, 0);
    assert.deepEqual(recovery.errors, []);
  });
}

for (const conflict of ["session", "in-flight"]) {
  test(`pre-prepared exact failure keeps the existing ${conflict} fence strict`, async (t) => {
    const fx = await prePreparedControllerRecoveryFixture(t);
    let sessions = createRoleSessionSet(
      owner(fx, fx.roleName),
      fx.agent.id,
      NOW
    );
    if (conflict === "session") {
      sessions = recordRoleAgentSession(sessions, {
        agentId: fx.agent.id,
        adapterId: fx.agent.adapterId,
        nativeSessionId: "unexpected-native-session",
        launchId: fx.launchId,
        policy: "fixed",
        status: "running",
        effective: fx.run.effective
      }, NOW);
    } else {
      sessions = bindTaskRoleRun(sessions, {
        agentId: fx.agent.id,
        runId: fx.run.id,
        receiptId: `agent-run:${fx.task.id}/${fx.run.id}`
      }, NOW);
      sessions = markTaskRoleRunDelivered(sessions, {
        agentId: fx.agent.id,
        runId: fx.run.id,
        receiptId: `agent-run:${fx.task.id}/${fx.run.id}`
      }, NOW);
    }
    fx.store.saveTaskRoleSessionSet(sessions);
    const roleMailbox = fx.store.getWorkMailbox(fx.target);

    assert.equal(fx.schedulerStore.saveRoleRunDeliveryFailure({
      taskId: fx.task.id,
      roleName: fx.roleName,
      agentId: fx.agent.id,
      adapterId: fx.agent.adapterId,
      runId: fx.run.id,
      mailboxBatchId: roleMailbox.processing.batchId,
      launchId: fx.launchId,
      now: NOW
    }), "state-changed");
    assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).status, "active");
    assert.equal(fx.store.getActiveAgentRun(fx.task.id, fx.roleName).id, fx.run.id);
    assertReservation(fx, fx.roleName, fx.launchId, fx.run.id);
    assert.equal(
      fx.store.getWorkItem(fx.task.id, fx.item.id).candidates.length,
      0
    );
  });
}

test("a foreground preflight failure cannot enqueue cleanup for an existing healthy generation", async (t) => {
  const fx = fixture(t);
  let hostPresent = false;
  let rejectRebind = false;
  let stops = 0;
  const host = {
    async start(request) {
      if (rejectRebind) {
        assert.equal(
          request.environment.CODEX_HOME,
          join(fx.home, "foreground-codex")
        );
        throw new Error("foreground Codex config conflict");
      }
      hostPresent = true;
      return runtimeBinding(request, { hostCreated: true });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() {
      stops += 1;
      hostPresent = false;
    },
    async inspect() {
      return { state: hostPresent ? "running" : "stopped" };
    },
    async inspectOwner() {
      return { state: hostPresent ? "running" : "stopped" };
    },
    async stopOwner() {
      stops += 1;
      hostPresent = false;
      return true;
    }
  };
  const firstCoordinator = new RuntimeLaunchCoordinator(
    fx.schedulerStore,
    host,
    {
      createGenerationId: () => "healthy-generation",
      now: () => NOW
    }
  );
  const first = await registry(firstCoordinator, host).prepareRoleSession(
    prepareInput(fx, "leader", "agent-run-1")
  );
  rejectRebind = true;

  const restartedCoordinator = new RuntimeLaunchCoordinator(
    new FileSchedulerStoreAdapter(new FileTaskStore(fx.home)),
    host,
    {
      createGenerationId: () => "must-not-replace",
      now: () => NOW
    }
  );
  await assert.rejects(
    restartedCoordinator.prepare({
      owner: owner(fx, "leader"),
      agentId: fx.agent.id,
      adapterId: fx.agent.adapterId,
      effective: fx.schedulerStore.getRole(fx.task.id, "leader").effective,
      workspace: fx.home,
      environment: { CODEX_HOME: join(fx.home, "foreground-codex") },
      mode: "new"
    }, "immediate"),
    /foreground Codex config conflict/i
  );

  const mailbox = assertReservation(fx, "leader", first.launchId);
  assert.equal(mailbox.pending, null);
  assert.equal(hostPresent, true);
  assert.equal(stops, 0);
});

for (const [label, corrupt] of [
  ["launch id", (binding) => ({ ...binding, launchId: "wrong-generation" })],
  ["owner", (binding, fx) => ({
    ...binding,
    owner: owner(fx, "worker")
  })],
  ["Agent", (binding) => ({ ...binding, agentId: "wrong-agent" })],
  ["adapter", (binding) => ({ ...binding, adapterId: "claude" })]
]) {
  test(`a host binding with the wrong ${label} is fenced into owner cleanup`, async (t) => {
    const fx = fixture(t);
    let stops = 0;
    const host = {
      async start(request) {
        return corrupt(runtimeBinding(request), fx);
      },
      async resume() { throw new Error("resume is not expected"); },
      async stop() { stops += 1; },
      async inspect() { return { state: "running" }; },
      async inspectOwner() { return { state: "running" }; },
      async stopOwner() { stops += 1; return true; }
    };
    const coordinator = new RuntimeLaunchCoordinator(
      fx.schedulerStore,
      host,
      {
        createGenerationId: () => `wrong-${label.replaceAll(" ", "-")}`,
        now: () => NOW
      }
    );

    await assert.rejects(
      coordinator.prepare({
        owner: owner(fx, "leader"),
        agentId: fx.agent.id,
        adapterId: fx.agent.adapterId,
        effective: fx.schedulerStore.getRole(fx.task.id, "leader").effective,
        workspace: fx.home,
        mode: "new"
      }, "deferred"),
      /binding that does not match/i
    );
    const mailbox = reservationMailbox(fx, "leader");
    assert.equal(isRuntimeLaunchReservation(mailbox.processing), true);
    assert.deepEqual(mailbox.pending.reasons, [
      RUNTIME_CLEANUP_REQUIRED_REASON
    ]);
    assert.equal(fx.store.getRoleSession(fx.task.id, "leader"), null);
    assert.equal(fx.store.getRoleSession(fx.task.id, "worker"), null);
    assert.equal(stops, 0);
  });
}

test("a resume binding with the wrong native identity is fenced into owner cleanup", async (t) => {
  const fx = fixture(t);
  fx.schedulerStore.recordRuntimeNativeSession({
    taskId: fx.task.id,
    roleName: "leader",
    agentId: fx.agent.id,
    adapterId: fx.agent.adapterId,
    nativeSessionId: "thread-current"
  }, NOW);
  const host = {
    async start() { throw new Error("new is not expected"); },
    async resume(request) {
      return runtimeBinding(request, { nativeSessionId: "thread-wrong" });
    },
    async stop() { throw new Error("untrusted binding must not be stopped"); },
    async inspect() { return { state: "running" }; },
    async inspectOwner() { return { state: "running" }; },
    async stopOwner() { return true; }
  };
  const coordinator = new RuntimeLaunchCoordinator(
    fx.schedulerStore,
    host,
    {
      createGenerationId: () => "wrong-resume-native",
      now: () => NOW
    }
  );

  await assert.rejects(
    coordinator.prepare({
      owner: owner(fx, "leader"),
      agentId: fx.agent.id,
      adapterId: fx.agent.adapterId,
      effective: fx.schedulerStore.getRole(fx.task.id, "leader").effective,
      workspace: fx.home,
      mode: "resume",
      nativeSessionId: "thread-current"
    }, "immediate"),
    /binding that does not match/i
  );
  const mailbox = reservationMailbox(fx, "leader");
  assert.equal(isRuntimeLaunchReservation(mailbox.processing), true);
  assert.deepEqual(mailbox.pending.reasons, [
    RUNTIME_CLEANUP_REQUIRED_REASON
  ]);
  assert.equal(
    fx.store.getRoleSession(fx.task.id, "leader").nativeSessionId,
    "thread-current"
  );
});

test("a stopped pre-binding host gets a new generation and the old generation Hook is obsolete", async (t) => {
  const fx = fixture(t);
  let hostPresent = false;
  let createdHosts = 0;
  const starts = [];
  const host = {
    async start(request) {
      hostPresent = true;
      createdHosts += 1;
      starts.push(request);
      return runtimeBinding(request, {
        index: starts.length,
        hostCreated: true
      });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() { hostPresent = false; },
    async inspect() {
      return { state: hostPresent ? "running" : "stopped" };
    },
    async inspectOwner() {
      return { state: hostPresent ? "running" : "stopped" };
    },
    async stopOwner() {
      hostPresent = false;
      return true;
    }
  };
  const firstCoordinator = new RuntimeLaunchCoordinator(
    fx.schedulerStore,
    host,
    {
      createGenerationId: () => "old-generation",
      now: () => NOW
    }
  );
  const first = await registry(firstCoordinator, host).prepareRoleSession(
    prepareInput(fx, "worker", "agent-run-1")
  );
  hostPresent = false;

  const restartedStore = new FileTaskStore(fx.home);
  const restartedReservations = new FileSchedulerStoreAdapter(restartedStore);
  const restartedCoordinator = new RuntimeLaunchCoordinator(
    restartedReservations,
    host,
    {
      createGenerationId: () => "new-generation",
      now: () => NOW
    }
  );
  const laterInput = prepareInput(fx, "worker", "agent-run-2");
  await assert.rejects(
    registry(restartedCoordinator, host).prepareRoleSession(laterInput),
    /reservation changed during recovery/i
  );
  assertReservation(fx, "worker", first.launchId, "agent-run-1");

  const priorRun = fx.store.getAgentRun(fx.task.id, "agent-run-1");
  fx.store.saveAgentRun(failAgentRun(
    priorRun,
    "prior Run terminal before replacement",
    new Date(NOW.getTime() + 1)
  ));
  const recovered = await registry(
    restartedCoordinator,
    host
  ).prepareRoleSession(laterInput);

  assert.notEqual(recovered.launchId, first.launchId);
  assert.equal(recovered.sessionStarted, true);
  assert.equal(createdHosts, 2);
  assertReservation(fx, "worker", recovered.launchId);

  const oldHook = {
    taskId: fx.task.id,
    roleName: "worker",
    agentId: fx.agent.id,
    adapterId: fx.agent.adapterId,
    launchId: first.launchId,
    nativeSessionId: "thread-old",
    turnId: "turn-old",
    runId: "agent-run-1"
  };
  const currentHook = {
    ...oldHook,
    launchId: recovered.launchId,
    nativeSessionId: "thread-current",
    turnId: "turn-current",
    runId: "agent-run-2"
  };
  assert.equal(
    restartedReservations.classifyRuntimeTurnCompleted(oldHook),
    "obsolete"
  );
  assert.equal(
    restartedReservations.classifyRuntimeTurnCompleted(currentHook),
    "apply"
  );
});
