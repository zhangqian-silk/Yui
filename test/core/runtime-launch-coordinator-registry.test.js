import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { FileTaskController } from "../../dist/controller/controller.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { RuntimeLaunchCoordinator } from "../../dist/controller/runtimeLaunchCoordinator.js";
import { runClaudeLifecycleHookCommand } from "../../dist/controller/claudeLifecycleHook.js";
import { runCodexLifecycleHookCommand } from "../../dist/controller/codexLifecycleHook.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { FileRuntimeEventProcessor } from "../../dist/controller/runtimeEventProcessor.js";
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
import { FileTaskRuntimeIsolation } from "../../dist/runtime/taskRuntimeIsolation.js";
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
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";

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
  const hostCreated = options.hostCreated ?? false;
  return {
    id: `binding-${options.index ?? 1}`,
    launchId: request.launchId,
    owner: request.owner,
    agentId: request.agentId,
    adapterId: request.adapterId,
    hostRef: `host-${request.owner.roleName}`,
    hostCreated,
    ...(options.initialPromptRunId === undefined
      ? {}
      : { initialPromptRunId: options.initialPromptRunId }),
    ...(options.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: options.nativeSessionId })
  };
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

function taskRuntimeFixture(t, fx) {
  const runtimeRoot = `${fx.home}-task-runtimes`;
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const workspace = createManagedWorkspace({
    owner: { type: "task", taskId: fx.task.id },
    root: fx.home,
    entries: []
  }, NOW);
  const isolation = new FileTaskRuntimeIsolation({
    runtimeRoot,
    controlPlane: {
      yuiHome: fx.home,
      controllerSocketPath: join(fx.home, "controller.sock"),
      tmuxNamespace: "yui-test-control"
    }
  });
  return { isolation, workspace };
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
    async start(request, beforeHostStart) {
      const hostCreated = persistPrepared && (
        controls.starts.length === 0 || controls.recreateNextStart
      );
      controls.recreateNextStart = false;
      beforeHostStart?.({
        owner: request.owner,
        launchId: request.launchId,
        ...(request.runId === undefined ? {} : { runId: request.runId }),
        agentId: request.agentId,
        adapterId: request.adapterId,
        effective: request.effective,
        ...(persistPrepared ? { nativeSessionId: "claude-native-recovery" } : {})
      });
      controls.state = "running";
      controls.starts.push(request);
      if (hostCreated) controls.hostCreations += 1;
      return runtimeBinding(request, {
        index: controls.starts.length,
        hostCreated,
        ...(persistPrepared
          ? { nativeSessionId: "claude-native-recovery" }
          : {})
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

test("fresh Claude Leader and Worker reserve before start and their first matching Hook binds the native session", async (t) => {
  const fx = fixture(t, "claude");
  const starts = [];
  const host = {
    async start(request) {
      assertReservation(fx, request.owner.roleName, request.launchId);
      starts.push(request);
      return runtimeBinding(request, { index: starts.length, hostCreated: true });
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

test("fresh Claude SessionStart inside host start sees a durable pre-host fence", async (t) => {
  const fx = fixture(t, "claude");
  const roleName = "worker";
  const role = fx.roles.get(roleName);
  const effective = fx.schedulerStore.getRole(fx.task.id, roleName).effective;
  const run = createAgentRun(
    "agent-run-2",
    fx.task.id,
    roleName,
    "new",
    "deliver before provider process start",
    NOW,
    { effective }
  );
  const target = { kind: "role", taskId: fx.task.id, roleName };
  fx.store.transaction((tx) => {
    tx.saveRole(fx.task.id, updateRoleStatus(role, "running", NOW));
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, target, "run-dispatched", NOW, [
      { type: "run", taskId: fx.task.id, id: run.id }
    ]);
  });
  const nativeSessionId = "claude-native-pre-host-start";
  const inbox = new FileRuntimeEventInbox(fx.home, () => NOW);
  const processor = new FileRuntimeEventProcessor(inbox, fx.schedulerStore);
  let hookError;
  let drainResult;
  let hostStarts = 0;
  const host = {
    async start(request, beforeHostStart) {
      hostStarts += 1;
      assertReservation(fx, roleName, request.launchId, run.id);
      beforeHostStart?.({
        owner: request.owner,
        launchId: request.launchId,
        ...(request.runId === undefined ? {} : { runId: request.runId }),
        agentId: request.agentId,
        adapterId: request.adapterId,
        effective: request.effective,
        nativeSessionId
      });
      try {
        await runClaudeLifecycleHookCommand(
          JSON.stringify({
            hook_event_name: "SessionStart",
            session_id: nativeSessionId,
            source: "startup"
          }),
          {
            YUI_HOME: fx.home,
            YUI_SESSION_SCOPE: "task",
            YUI_WORKSPACE: fx.home,
            YUI_ADAPTER_ID: "claude",
            YUI_TASK_ID: fx.task.id,
            YUI_ROLE: roleName,
            YUI_AGENT_ID: fx.agent.id,
            YUI_LAUNCH_ID: request.launchId,
            YUI_RUN_ID: run.id,
            YUI_NATIVE_SESSION_ID: nativeSessionId
          },
          async () => {
            drainResult = processor.drain(NOW);
            return {};
          }
        );
      } catch (error) {
        hookError = error;
      }
      return runtimeBinding(request, { nativeSessionId, hostCreated: true });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() {},
    async inspect() { return { state: "running" }; },
    async inspectOwner() { return { state: "running" }; },
    async stopOwner() { return true; }
  };
  const coordinator = new RuntimeLaunchCoordinator(
    fx.schedulerStore,
    host,
    {
      createGenerationId: () => "pre-host-generation",
      now: () => NOW
    }
  );
  const delivery = registry(coordinator, host, async () => "delivered");

  const [result] = await processActiveRoleRunDeliveries(
    fx.schedulerStore,
    delivery,
    NOW
  );

  assert.equal(hostStarts, 1);
  assert.equal(hookError, undefined, hookError?.message);
  assert.deepEqual(drainResult?.failed, [], JSON.stringify(drainResult));
  assert.equal(
    fx.store.getTaskRoleSessionSet(fx.task.id, roleName)?.inFlight?.runId,
    run.id
  );
  assert.equal(
    fx.store.getRoleSession(fx.task.id, roleName)?.nativeSessionId,
    nativeSessionId
  );
  assert.equal(result.status, "delivered", result.error);
  assert.equal(fx.store.getAgentRun(fx.task.id, run.id).deliveredAt, undefined);
});

test("a synchronous fresh Codex SessionStart binds transport without claiming delivery", async (t) => {
  const fx = fixture(t, "codex");
  const roleName = "worker";
  const role = fx.roles.get(roleName);
  const effective = fx.schedulerStore.getRole(fx.task.id, roleName).effective;
  const run = createAgentRun(
    "agent-run-3",
    fx.task.id,
    roleName,
    "new",
    "deliver through Codex launch",
    NOW,
    { effective }
  );
  const target = { kind: "role", taskId: fx.task.id, roleName };
  fx.store.transaction((tx) => {
    tx.saveRole(fx.task.id, updateRoleStatus(role, "running", NOW));
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, target, "run-dispatched", NOW, [
      { type: "run", taskId: fx.task.id, id: run.id }
    ]);
  });
  const nativeSessionId = "codex-native-pre-host-start";
  const inbox = new FileRuntimeEventInbox(fx.home, () => NOW);
  const processor = new FileRuntimeEventProcessor(inbox, fx.schedulerStore);
  let hookError;
  let drainResult;
  const host = {
    async start(request, beforeHostStart) {
      assertReservation(fx, roleName, request.launchId, run.id);
      beforeHostStart?.({
        owner: request.owner,
        launchId: request.launchId,
        runId: request.runId,
        agentId: request.agentId,
        adapterId: request.adapterId,
        effective: request.effective
      });
      try {
        await runCodexLifecycleHookCommand(
          JSON.stringify({
            hook_event_name: "SessionStart",
            session_id: nativeSessionId
          }),
          {
            YUI_HOME: fx.home,
            YUI_SESSION_SCOPE: "task",
            YUI_WORKSPACE: fx.home,
            YUI_ADAPTER_ID: "codex",
            YUI_TASK_ID: fx.task.id,
            YUI_ROLE: roleName,
            YUI_AGENT_ID: fx.agent.id,
            YUI_LAUNCH_ID: request.launchId
          },
          async () => {
            drainResult = processor.drain(NOW);
            return {};
          }
        );
      } catch (error) {
        hookError = error;
      }
      return runtimeBinding(request, { hostCreated: true });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() {},
    async inspect() { return { state: "running" }; },
    async inspectOwner() { return { state: "running" }; },
    async stopOwner() { return true; }
  };
  const coordinator = new RuntimeLaunchCoordinator(
    fx.schedulerStore,
    host,
    {
      createGenerationId: () => "codex-pre-host-generation",
      now: () => NOW
    }
  );
  const delivery = registry(coordinator, host, async () => "delivered");

  const [result] = await processActiveRoleRunDeliveries(
    fx.schedulerStore,
    delivery,
    NOW
  );

  assert.equal(hookError, undefined, hookError?.message);
  assert.deepEqual(drainResult?.failed, [], JSON.stringify(drainResult));
  assert.equal(reservationMailbox(fx, roleName), null);
  assert.equal(
    fx.store.getRoleSession(fx.task.id, roleName)?.nativeSessionId,
    nativeSessionId
  );
  assert.equal(result.status, "delivered", result.error);
  const transported = fx.store.getAgentRun(fx.task.id, run.id);
  assert.equal(transported.status, "active");
  assert.notEqual(transported.pushedAt, undefined);
  assert.equal(transported.deliveredAt, undefined);
});

test("a fresh Codex launch-carried prompt waits asynchronously for provider acceptance without a duplicate push", async (t) => {
  const fx = fixture(t, "codex");
  const roleName = "worker";
  const role = fx.roles.get(roleName);
  const effective = fx.schedulerStore.getRole(fx.task.id, roleName).effective;
  const run = createAgentRun(
    "agent-run-4",
    fx.task.id,
    roleName,
    "new",
    "deliver through the Codex launch argument",
    NOW,
    { effective }
  );
  const target = { kind: "role", taskId: fx.task.id, roleName };
  fx.store.transaction((tx) => {
    tx.saveRole(fx.task.id, updateRoleStatus(role, "running", NOW));
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, target, "run-dispatched", NOW, [
      { type: "run", taskId: fx.task.id, id: run.id }
    ]);
  });
  let promptPushes = 0;
  let launchId;
  const host = {
    async start(request, beforeHostStart) {
      launchId = request.launchId;
      assertReservation(fx, roleName, request.launchId, run.id);
      beforeHostStart?.({
        owner: request.owner,
        launchId: request.launchId,
        runId: request.runId,
        agentId: request.agentId,
        adapterId: request.adapterId,
        effective: request.effective,
        initialPromptRunId: run.id
      });
      return runtimeBinding(request, {
        hostCreated: true,
        initialPromptRunId: run.id
      });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() {},
    async inspect() { return { state: "running" }; },
    async inspectOwner() { return { state: "running" }; },
    async stopOwner() { return true; }
  };
  const coordinator = new RuntimeLaunchCoordinator(
    fx.schedulerStore,
    host,
    {
      createGenerationId: () => "codex-asynchronous-provider-generation",
      now: () => NOW
    }
  );
  const delivery = registry(coordinator, host, async () => {
    promptPushes += 1;
    return "delivered";
  });

  const [result] = await processActiveRoleRunDeliveries(
    fx.schedulerStore,
    delivery,
    NOW
  );

  assert.equal(result.status, "delivered", result.error);
  assert.equal(promptPushes, 0);
  const transported = fx.store.getAgentRun(fx.task.id, run.id);
  assert.equal(transported.status, "active");
  assert.notEqual(transported.pushedAt, undefined);
  assert.equal(transported.deliveredAt, undefined);
  const mailbox = assertReservation(
    fx,
    roleName,
    launchId,
    run.id
  );
  assert.equal(mailbox.pending, null);

  const nativeSessionId = "codex-native-asynchronous-provider";
  const environment = {
    YUI_HOME: fx.home,
    YUI_SESSION_SCOPE: "task",
    YUI_WORKSPACE: fx.home,
    YUI_ADAPTER_ID: "codex",
    YUI_TASK_ID: fx.task.id,
    YUI_ROLE: roleName,
    YUI_AGENT_ID: fx.agent.id,
    YUI_LAUNCH_ID: launchId,
    YUI_RUN_ID: run.id
  };
  const processor = new FileRuntimeEventProcessor(
    new FileRuntimeEventInbox(fx.home),
    fx.schedulerStore
  );
  await runCodexLifecycleHookCommand(
    JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: nativeSessionId
    }),
    environment,
    async () => ({})
  );
  assert.deepEqual(processor.drain(NOW).failed, []);
  assert.equal(reservationMailbox(fx, roleName), null);
  assert.equal(
    fx.store.getRoleSession(fx.task.id, roleName)?.nativeSessionId,
    nativeSessionId
  );

  await runCodexLifecycleHookCommand(
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: nativeSessionId,
      prompt: run.input
    }),
    environment,
    async () => ({})
  );
  assert.deepEqual(processor.drain(NOW).failed, []);
  assert.notEqual(fx.store.getAgentRun(fx.task.id, run.id).deliveredAt, undefined);
});

test("a restart after synchronous fresh Codex SessionStart reuses the original launch", async (t) => {
  const fx = fixture(t, "codex");
  const roleName = "worker";
  const role = fx.roles.get(roleName);
  const effective = fx.schedulerStore.getRole(fx.task.id, roleName).effective;
  const run = createAgentRun(
    "agent-run-4",
    fx.task.id,
    roleName,
    "new",
    "deliver exactly once after restart",
    NOW,
    { effective }
  );
  const target = { kind: "role", taskId: fx.task.id, roleName };
  fx.store.transaction((tx) => {
    tx.saveRole(fx.task.id, updateRoleStatus(role, "running", NOW));
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, target, "run-dispatched", NOW, [
      { type: "run", taskId: fx.task.id, id: run.id }
    ]);
  });
  const nativeSessionId = "codex-native-restart";
  const inbox = new FileRuntimeEventInbox(fx.home, () => NOW);
  const processor = new FileRuntimeEventProcessor(inbox, fx.schedulerStore);
  let firstLaunchId;
  let promptPushes = 0;
  let hookError;
  let starts = 0;
  const persistPreStartFence = (store, preflight) => {
    store.saveRoleRunPrepared({
      task: store.getTask(fx.task.id),
      role: store.getRole(fx.task.id, roleName),
      run,
      session: preflight.nativeSessionId === undefined
        ? null
        : {
            agentId: preflight.agentId,
            adapterId: preflight.adapterId,
            nativeSessionId: preflight.nativeSessionId,
            launchId: preflight.launchId,
            status: "ready",
            effective: preflight.effective
          },
      launchId: preflight.launchId,
      now: NOW
    });
  };
  const host = {
    async start(request, beforeHostStart) {
      starts += 1;
      const restarted = starts > 1;
      beforeHostStart?.({
        owner: request.owner,
        launchId: request.launchId,
        runId: request.runId,
        agentId: request.agentId,
        adapterId: request.adapterId,
        effective: request.effective,
        ...(restarted ? { nativeSessionId } : { initialPromptRunId: run.id })
      });
      if (!restarted) {
        firstLaunchId = request.launchId;
        try {
          await runCodexLifecycleHookCommand(
            JSON.stringify({
              hook_event_name: "SessionStart",
              session_id: nativeSessionId
            }),
            {
              YUI_HOME: fx.home,
              YUI_SESSION_SCOPE: "task",
              YUI_WORKSPACE: fx.home,
              YUI_ADAPTER_ID: "codex",
              YUI_TASK_ID: fx.task.id,
              YUI_ROLE: roleName,
              YUI_AGENT_ID: fx.agent.id,
              YUI_LAUNCH_ID: request.launchId
            },
            async () => {
              processor.drain(NOW);
              return {};
            }
          );
        } catch (error) {
          hookError = error;
        }
      } else {
        throw new Error("A pushed Run must not launch a second Provider generation.");
      }
      return runtimeBinding(request, {
        nativeSessionId: restarted ? nativeSessionId : undefined,
        hostCreated: !restarted,
        ...(restarted ? {} : { initialPromptRunId: run.id })
      });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() {},
    async inspect() { return { state: "running" }; },
    async inspectOwner() { return { state: "running" }; },
    async stopOwner() { return true; }
  };
  const firstStore = fx.schedulerStore;
  const firstDelivery = registry(
    new RuntimeLaunchCoordinator(firstStore, host, {
      createGenerationId: () => "codex-restart-first",
      now: () => NOW
    }),
    host
  );
  const input = prepareInput(fx, roleName, run.id);
  const firstPrepared = await firstDelivery.prepareRoleSession({
    ...input,
    beforeHostStart: (preflight) => persistPreStartFence(firstStore, preflight)
  });
  assert.equal(firstPrepared.session, null);
  assert.equal(hookError, undefined, hookError?.message);
  assert.equal(
    fx.store.getRoleSession(fx.task.id, roleName)?.launchId,
    firstLaunchId
  );
  assert.notEqual(fx.store.getAgentRun(fx.task.id, run.id).pushedAt, undefined);

  const restartedStore = new FileTaskStore(fx.home);
  const restartedSchedulerStore = new FileSchedulerStoreAdapter(restartedStore);
  const restartedDelivery = registry(
    new RuntimeLaunchCoordinator(restartedSchedulerStore, host, {
      createGenerationId: () => "codex-restart-second",
      now: () => NOW
    }),
    host,
    async () => {
      promptPushes += 1;
      return "delivered";
    }
  );
  const recovered = await processActiveRoleRunDeliveries(
    restartedSchedulerStore,
    restartedDelivery,
    NOW
  );
  assert.deepEqual(recovered, []);
  assert.equal(starts, 1);
  assert.equal(
    restartedSchedulerStore.getRoleSession(fx.task.id, roleName).launchId,
    firstLaunchId
  );
  assert.equal(promptPushes, 0);
  assert.notEqual(restartedStore.getAgentRun(fx.task.id, run.id).pushedAt, undefined);
  assert.equal(restartedStore.getAgentRun(fx.task.id, run.id).deliveredAt, undefined);
  await assert.rejects(
    runCodexLifecycleHookCommand(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: nativeSessionId
      }),
      {
        YUI_HOME: fx.home,
        YUI_SESSION_SCOPE: "task",
        YUI_WORKSPACE: fx.home,
        YUI_ADAPTER_ID: "codex",
        YUI_TASK_ID: fx.task.id,
        YUI_ROLE: roleName,
        YUI_AGENT_ID: fx.agent.id,
        YUI_LAUNCH_ID: "stale-codex-launch"
      },
      async () => ({})
    ),
    /Session does not match its durable generation/i
  );
  await runCodexLifecycleHookCommand(
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: nativeSessionId
    }),
    {
      YUI_HOME: fx.home,
      YUI_SESSION_SCOPE: "task",
      YUI_WORKSPACE: fx.home,
      YUI_ADAPTER_ID: "codex",
      YUI_TASK_ID: fx.task.id,
      YUI_ROLE: roleName,
      YUI_AGENT_ID: fx.agent.id,
      YUI_LAUNCH_ID: firstLaunchId
    },
    async () => ({})
  );
  const accepted = new FileRuntimeEventProcessor(
    new FileRuntimeEventInbox(fx.home),
    restartedSchedulerStore
  ).drain(NOW);
  assert.deepEqual(accepted.failed, []);
  assert.notEqual(restartedStore.getAgentRun(fx.task.id, run.id).deliveredAt, undefined);
});

test("fresh Claude SessionStart sees the durable Run fence before readiness returns", async (t) => {
  const fx = fixture(t, "claude");
  const roleName = "worker";
  const role = fx.roles.get(roleName);
  const effective = fx.schedulerStore.getRole(fx.task.id, roleName).effective;
  const run = createAgentRun(
    "agent-run-1",
    fx.task.id,
    roleName,
    "new",
    "deliver before Claude readiness",
    NOW,
    { effective }
  );
  const target = { kind: "role", taskId: fx.task.id, roleName };
  fx.store.transaction((tx) => {
    tx.saveRole(fx.task.id, updateRoleStatus(role, "running", NOW));
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, target, "run-dispatched", NOW, [
      { type: "run", taskId: fx.task.id, id: run.id }
    ]);
  });
  const launchId = "runtime-test:generation:claude-pre-input";
  fx.schedulerStore.reserveRuntimeLaunch({
    owner: owner(fx, roleName),
    launchId,
    runId: run.id
  }, () => {}, NOW);
  const nativeSessionId = "claude-native-pre-input";
  const preparedSession = {
    agentId: fx.agent.id,
    adapterId: fx.agent.adapterId,
    nativeSessionId,
    status: "ready",
    effective: run.effective
  };
  const inbox = new FileRuntimeEventInbox(fx.home, () => NOW);
  const processor = new FileRuntimeEventProcessor(inbox, fx.schedulerStore);
  let persistedBeforeReadiness = false;
  let hookError;
  const delivery = {
    async prepareRoleSession() {
      return {
        deliveryId: "delivery-claude-pre-input",
        taskId: fx.task.id,
        roleName,
        agentId: fx.agent.id,
        adapterId: fx.agent.adapterId,
        mode: "new",
        runId: run.id,
        launchId,
        sessionStarted: true,
        session: preparedSession
      };
    },
    async waitUntilReady(prepared) {
      const sessions = fx.store.getTaskRoleSessionSet(fx.task.id, roleName);
      persistedBeforeReadiness = sessions?.inFlight?.runId === run.id
        && fx.store.getRoleSession(fx.task.id, roleName)?.nativeSessionId === nativeSessionId;
      try {
        await runClaudeLifecycleHookCommand(
          JSON.stringify({
            hook_event_name: "SessionStart",
            session_id: nativeSessionId,
            source: "startup"
          }),
          {
            YUI_HOME: fx.home,
            YUI_SESSION_SCOPE: "task",
            YUI_WORKSPACE: fx.home,
            YUI_ADAPTER_ID: "claude",
            YUI_TASK_ID: fx.task.id,
            YUI_ROLE: roleName,
            YUI_AGENT_ID: fx.agent.id,
            YUI_LAUNCH_ID: launchId,
            YUI_RUN_ID: run.id,
            YUI_NATIVE_SESSION_ID: nativeSessionId
          },
          async () => {
            processor.drain(NOW);
            return {};
          }
        );
      } catch (error) {
        hookError = error;
      }
      return { prepared, session: preparedSession };
    },
    async sendOnce() { return "sent"; },
    async inspectRole() { return "present"; },
    forgetPrepared() {}
  };

  const [result] = await processActiveRoleRunDeliveries(
    fx.schedulerStore,
    delivery,
    NOW
  );

  assert.equal(persistedBeforeReadiness, true);
  assert.equal(hookError, undefined, hookError?.message);
  assert.equal(result.status, "delivered", result.error);
  assert.equal(fx.store.getAgentRun(fx.task.id, run.id).deliveredAt, undefined);
});

test("a fresh Codex argv prompt without provider acknowledgement retains the reservation and never falls back to push", async (t) => {
  const fx = fixture(t);
  const item = updateWorkItemStatus(createWorkItem(
    "work-item-1",
    fx.task.id,
    { title: "Fresh Codex bounded gap", assignee: "worker" },
    NOW
  ), "running", NOW);
  fx.store.saveWorkItem(fx.task.id, item);
  const effective = fx.schedulerStore.getRole(fx.task.id, "worker").effective;
  fx.store.saveAgentRun(createAgentRun(
    "agent-run-1",
    fx.task.id,
    "worker",
    "new",
    "prepare agent-run-1",
    NOW,
    { effective, workItemId: item.id }
  ));
  let pushes = 0;
  const host = {
    async start(request) {
      return runtimeBinding(request, { hostCreated: true });
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
    /cannot acknowledge the exact launch-carried prompt/i
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
  const run = fx.store.getAgentRun(fx.task.id, "agent-run-1");
  assert.equal(run.pushedAt, undefined);
  assert.equal(run.deliveredAt, undefined);
  assert.equal(
    fx.store.listEvents(fx.task.id).filter(({ type }) => (
      type === "run.pushed" || type === "run.delivered"
    )).length,
    0
  );
  assert.equal(fx.store.getWorkItem(fx.task.id, item.id).candidates.length, 0);
});

test("a launch-carried Codex prompt for another Run is fenced into cleanup", async (t) => {
  const fx = fixture(t, "codex");
  const host = {
    async start(request, beforeHostStart) {
      beforeHostStart?.({
        owner: request.owner,
        launchId: request.launchId,
        runId: request.runId,
        agentId: request.agentId,
        adapterId: request.adapterId,
        effective: request.effective,
        initialPromptRunId: request.runId
      });
      return runtimeBinding(request, {
        hostCreated: true,
        initialPromptRunId: "agent-run-other"
      });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() { throw new Error("a mismatched binding must not be trusted"); },
    async inspect() { return { state: "running" }; },
    async inspectOwner() { return { state: "running" }; },
    async stopOwner() { return true; }
  };
  const delivery = registry(
    new RuntimeLaunchCoordinator(fx.schedulerStore, host, {
      createGenerationId: () => "wrong-prompt-run-generation",
      now: () => NOW
    }),
    host
  );

  await assert.rejects(
    delivery.prepareRoleSession(prepareInput(fx, "worker", "agent-run-1")),
    /launch-carried prompt for another Run/u
  );
  const mailbox = reservationMailbox(fx, "worker");
  assert.ok(mailbox);
  assert.deepEqual(mailbox.pending.reasons, [RUNTIME_CLEANUP_REQUIRED_REASON]);
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
  assert.equal(prepared.session.nativeSessionId, "claude-native-1");
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

test("same-Run recovery without provider acknowledgement retains its generation and fails closed", async (t) => {
  const fx = fixture(t);
  let hostPresent = true;
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
  await assert.rejects(
    registry(restartedCoordinator, host).prepareRoleSession(
      prepareInput(fx, "leader", "agent-run-1")
    ),
    /cannot acknowledge the exact launch-carried prompt/i
  );

  assert.equal(createdHosts, 0);
  assert.equal(starts.length, 2);
  assert.equal(starts[1].launchId, first.launchId);
  const mailbox = assertReservation(fx, "leader", first.launchId);
  assert.deepEqual(mailbox.pending.reasons, [RUNTIME_CLEANUP_REQUIRED_REASON]);
});

for (const inspectionState of ["starting", "unavailable"]) {
  test(`same-Run ${inspectionState} recovery retains its exact generation as retryable`, async (t) => {
    const fx = fixture(t);
    let state = "running";
    let starts = 0;
    const host = {
      async start(request) {
        starts += 1;
        return runtimeBinding(request, { index: starts, hostCreated: false });
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
  let hostPresent = true;
  let starts = 0;
  const host = {
    async start(request) {
      starts += 1;
      hostPresent = true;
      return runtimeBinding(request, { index: starts, hostCreated: false });
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
  const fx = fixture(t, "claude");
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
        hostCreated
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
    assert.equal(fx.controls.hostCreations, 0);

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
  test(`Controller terminalizes a pre-prepared same-Run ${recoveryLoss} generation loss and queues cleanup`, async (t) => {
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
    if (recoveryLoss === "recreated") {
      const settledSessions = recovery.store.getTaskRoleSessionSet(fx.task.id, fx.roleName);
      assert.ok(settledSessions);
      assert.deepEqual(settledSessions.sessions, {});
      assert.equal(settledSessions.inFlight, null);
    } else {
      assert.equal(recovery.store.getTaskRoleSessionSet(fx.task.id, fx.roleName), null);
    }
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

    recovery.controller.signal(`role:${fx.task.id}/${fx.roleName}`);
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
  test(`Controller fails closed when pre-prepared ${initialState}-to-running Codex recovery lacks provider acknowledgement`, async (t) => {
    const fx = await prePreparedControllerRecoveryFixture(t);
    fx.controls.inspections.push(initialState, "running");
    fx.controls.allowStopOwner = false;
    fx.controls.pushOutcome = "sent";
    const recovery = fx.startController(2);

    recovery.controller.signal(`role:${fx.task.id}/${fx.roleName}`);
    await waitFor(
      () => recovery.store.getAgentRun(fx.task.id, fx.run.id)?.status === "failed",
      `the pre-prepared ${initialState} Run to fail closed`
    );

    const failed = recovery.store.getAgentRun(fx.task.id, fx.run.id);
    assert.equal(failed.pushedAt, undefined);
    assert.equal(failed.deliveredAt, undefined);
    const settledSessions = recovery.store.getTaskRoleSessionSet(fx.task.id, fx.roleName);
    assert.ok(settledSessions);
    assert.deepEqual(settledSessions.sessions, {});
    assert.equal(settledSessions.inFlight, null);
    const workerStarts = fx.controls.starts.filter(
      (request) => request.owner.roleName === fx.roleName
    );
    assert.equal(workerStarts.length, 2);
    assert.equal(fx.controls.hostCreations, 0);
    assert.deepEqual(
      new Set(workerStarts.map((request) => request.launchId)),
      new Set([fx.launchId])
    );
    assert.equal(
      hasRuntimeCleanupObligation(reservationMailbox(fx, fx.roleName)),
      true
    );
    const item = recovery.store.getWorkItem(fx.task.id, fx.item.id);
    assert.equal(item.status, "failed");
    assert.equal(item.candidates.length, 0);
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
  let hostPresent = true;
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
      return runtimeBinding(request, { hostCreated: false });
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
  const fx = fixture(t, "claude");
  const taskRuntime = taskRuntimeFixture(t, fx);
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
      now: () => NOW,
      runtimeIsolation: taskRuntime.isolation
    }
  );
  const first = await registry(firstCoordinator, host).prepareRoleSession(
    {
      ...prepareInput(fx, "worker", "agent-run-1"),
      managedWorkspace: taskRuntime.workspace
    }
  );
  const oldGenerationRoot = starts[0].runtimeIsolation.roots.generation;
  assert.equal(existsSync(oldGenerationRoot), true);
  hostPresent = false;

  const restartedStore = new FileTaskStore(fx.home);
  const restartedReservations = new FileSchedulerStoreAdapter(restartedStore);
  const restartedCoordinator = new RuntimeLaunchCoordinator(
    restartedReservations,
    host,
    {
      createGenerationId: () => "new-generation",
      now: () => NOW,
      runtimeIsolation: taskRuntime.isolation
    }
  );
  const laterInput = {
    ...prepareInput(fx, "worker", "agent-run-2"),
    managedWorkspace: taskRuntime.workspace
  };
  await assert.rejects(
    registry(restartedCoordinator, host).prepareRoleSession(laterInput),
    /reservation changed during recovery/i
  );
  assertReservation(fx, "worker", first.launchId, "agent-run-1");
  assert.equal(existsSync(oldGenerationRoot), true);

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
  assert.equal(existsSync(oldGenerationRoot), false);
  assert.equal(existsSync(starts.at(-1).runtimeIsolation.roots.generation), true);
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

test("a stopped reservation cleanup failure keeps the old launch fenced and blocks renewal", async (t) => {
  const fx = fixture(t, "claude");
  const taskRuntime = taskRuntimeFixture(t, fx);
  let hostPresent = false;
  const starts = [];
  const host = {
    async start(request) {
      hostPresent = true;
      starts.push(request);
      return runtimeBinding(request, { index: starts.length, hostCreated: true });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() { hostPresent = false; },
    async inspect() { return { state: hostPresent ? "running" : "stopped" }; },
    async inspectOwner() { return { state: hostPresent ? "running" : "stopped" }; },
    async stopOwner() { hostPresent = false; return true; }
  };
  const firstCoordinator = new RuntimeLaunchCoordinator(
    fx.schedulerStore,
    host,
    {
      createGenerationId: () => "old-cleanup-blocked",
      now: () => NOW,
      runtimeIsolation: taskRuntime.isolation
    }
  );
  const first = await registry(firstCoordinator, host).prepareRoleSession({
    ...prepareInput(fx, "worker", "agent-run-1"),
    managedWorkspace: taskRuntime.workspace
  });
  const oldGenerationRoot = starts[0].runtimeIsolation.roots.generation;
  hostPresent = false;
  fx.store.saveAgentRun(failAgentRun(
    fx.store.getAgentRun(fx.task.id, "agent-run-1"),
    "old Run is terminal",
    new Date(NOW.getTime() + 1)
  ));

  const cleanupCalls = [];
  const blockedIsolation = {
    preflight: (input) => taskRuntime.isolation.preflight(input),
    activate: (preparation) => taskRuntime.isolation.activate(preparation),
    cleanup: (preparation, reason) => taskRuntime.isolation.cleanup(preparation, reason),
    cleanupTaskLaunch(input) {
      cleanupCalls.push(input);
      throw new Error("exact old generation cleanup is ambiguous");
    }
  };
  const restartedCoordinator = new RuntimeLaunchCoordinator(
    new FileSchedulerStoreAdapter(new FileTaskStore(fx.home)),
    host,
    {
      createGenerationId: () => "must-not-renew",
      now: () => NOW,
      runtimeIsolation: blockedIsolation
    }
  );

  await assert.rejects(
    registry(restartedCoordinator, host).prepareRoleSession({
      ...prepareInput(fx, "worker", "agent-run-2"),
      managedWorkspace: taskRuntime.workspace
    }),
    /exact old generation cleanup is ambiguous/i
  );
  assert.deepEqual(cleanupCalls, [{
    taskId: fx.task.id,
    launchId: first.launchId,
    reason: "interruption"
  }]);
  assert.equal(existsSync(oldGenerationRoot), true);
  assert.equal(starts.length, 1);
  assertReservation(fx, "worker", first.launchId, "agent-run-1");
  assert.equal(
    hasRuntimeCleanupObligation(reservationMailbox(fx, "worker")),
    true
  );
});

test("a reused generation is cleaned when its failed call confirms the owner stopped", async (t) => {
  const fx = fixture(t, "claude");
  const taskRuntime = taskRuntimeFixture(t, fx);
  let hostPresent = false;
  let rejectRebind = false;
  const starts = [];
  const host = {
    async start(request) {
      starts.push(request);
      if (rejectRebind) {
        hostPresent = false;
        throw new Error("reused generation call failed after host stop");
      }
      hostPresent = true;
      return runtimeBinding(request, { index: starts.length, hostCreated: true });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() { hostPresent = false; },
    async inspect() { return { state: hostPresent ? "running" : "stopped" }; },
    async inspectOwner() { return { state: hostPresent ? "running" : "stopped" }; },
    async stopOwner() { hostPresent = false; return true; }
  };
  const firstCoordinator = new RuntimeLaunchCoordinator(
    fx.schedulerStore,
    host,
    {
      createGenerationId: () => "reused-generation",
      now: () => NOW,
      runtimeIsolation: taskRuntime.isolation
    }
  );
  const input = {
    ...prepareInput(fx, "worker", "agent-run-1"),
    managedWorkspace: taskRuntime.workspace
  };
  const first = await registry(firstCoordinator, host).prepareRoleSession(input);
  const generationRoot = starts[0].runtimeIsolation.roots.generation;
  assert.equal(existsSync(generationRoot), true);
  rejectRebind = true;

  const restartedCoordinator = new RuntimeLaunchCoordinator(
    new FileSchedulerStoreAdapter(new FileTaskStore(fx.home)),
    host,
    {
      createGenerationId: () => "unused-replacement",
      now: () => NOW,
      runtimeIsolation: taskRuntime.isolation
    }
  );
  await assert.rejects(
    registry(restartedCoordinator, host).prepareRoleSession(input),
    /reused generation call failed after host stop/i
  );

  assert.equal(starts[1].launchId, first.launchId);
  assert.equal(existsSync(generationRoot), false);
  assert.equal(reservationMailbox(fx, "worker"), null);
});

test("Task launch rejects a Role-only workspace before reservation or host side effects", async (t) => {
  const fx = fixture(t, "claude");
  let starts = 0;
  const host = {
    async start(request) {
      starts += 1;
      return runtimeBinding(request, { hostCreated: true });
    },
    async resume() { throw new Error("resume is not expected"); },
    async stop() { throw new Error("stop is not expected"); },
    async inspect() { return { state: "stopped" }; },
    async inspectOwner() { return { state: "stopped" }; },
    async stopOwner() { throw new Error("owner cleanup is not expected"); }
  };
  const coordinator = new RuntimeLaunchCoordinator(
    fx.schedulerStore,
    host,
    {
      createGenerationId: () => "missing-workspace-owner",
      now: () => NOW,
      runtimeIsolation: {
        preflight() { throw new Error("preflight must not receive an ownerless request"); },
        activate() { throw new Error("activation is not expected"); },
        cleanup() { throw new Error("cleanup is not expected"); }
      }
    }
  );
  const input = prepareInput(fx, "leader", "agent-run-1");

  await assert.rejects(
    coordinator.prepare({
      owner: owner(fx, "leader"),
      agentId: input.agentId,
      adapterId: input.adapterId,
      effective: input.effective,
      workspace: input.workspace,
      mode: input.mode,
      runId: input.runId
    }, "deferred"),
    /authoritative ManagedWorkspace owner is required/i
  );
  assert.equal(starts, 0);
  assert.equal(reservationMailbox(fx, "leader"), null);
});
