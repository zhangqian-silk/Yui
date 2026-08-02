import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { RuntimeLaunchCoordinator } from "../../dist/controller/runtimeLaunchCoordinator.js";
import { ExecutorRegistry } from "../../dist/executor/executorRegistry.js";
import {
  RUNTIME_CLEANUP_REQUIRED_REASON,
  RUNTIME_LAUNCH_RESERVED_REASON,
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../../dist/runtime/lifecycleReservation.js";
import {
  createRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../../dist/role/role.js";
import { createAgentRun } from "../helpers/effectiveLaunch.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";

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
  return {
    id: `binding-${options.index ?? 1}`,
    launchId: request.launchId,
    owner: request.owner,
    agentId: request.agentId,
    adapterId: request.adapterId,
    hostRef: `host-${request.owner.roleName}`,
    hostCreated: options.hostCreated ?? true,
    ...(options.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: options.nativeSessionId })
  };
}

function unusedTmux() {
  return {
    ensureRoleWindow() { throw new Error("legacy launch must not run"); },
    waitUntilReady() { throw new Error("legacy readiness must not run"); },
    sendRoleInputOnce() { throw new Error("legacy delivery must not run"); },
    sendRoleInputOnceIfReady() { return "unavailable"; },
    probeRoleStatus() { return "exited"; },
    killRole() {},
    stopTask() { return false; }
  };
}

function registry(coordinator, host, promptPush = async () => "busy") {
  return new ExecutorRegistry(
    { plan() { throw new Error("legacy planner must not run"); } },
    unusedTmux(),
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

test("a busy retry for one delivery reuses the prepared binding without starting twice", async (t) => {
  const fx = fixture(t);
  let starts = 0;
  const host = {
    async start(request) {
      starts += 1;
      return runtimeBinding(request);
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
  assert.notEqual(fx.store.getAgentRun(fx.task.id, run.id).deliveredAt, undefined);
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
        hostCreated
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

test("a host recreated after a running reservation probe is fenced into a fresh generation", async (t) => {
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
      return runtimeBinding(request, { index: starts, hostCreated });
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
  assertReservation(fx, "leader", first.launchId);

  const generations = ["unused-existing-candidate", "fresh-generation"];
  const restartedCoordinator = new RuntimeLaunchCoordinator(
    new FileSchedulerStoreAdapter(new FileTaskStore(fx.home)),
    host,
    {
      createGenerationId: () => generations.shift(),
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
    /recreated while recovering an existing generation/i
  );

  assert.equal(stops, 1);
  assert.equal(hostPresent, false);
  assert.equal(reservationMailbox(fx, "leader"), null);

  const recovered = await restartedCoordinator.prepare({
    owner: owner(fx, "leader"),
    agentId: fx.agent.id,
    adapterId: fx.agent.adapterId,
    effective: fx.schedulerStore.getRole(fx.task.id, "leader").effective,
    workspace: fx.home,
    mode: "new",
    runId: "agent-run-1"
  }, "deferred");

  assert.notEqual(recovered.launchId, first.launchId);
  assert.match(recovered.launchId, /fresh-generation$/);
  assert.equal(recovered.hostCreated, true);
  assertReservation(fx, "leader", recovered.launchId);
});

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
  const recovered = await registry(
    restartedCoordinator,
    host
  ).prepareRoleSession(
    prepareInput(fx, "worker", "agent-run-2")
  );

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
