import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import {
  assertFileTaskControllerStorageCompatible,
  ensureFileTaskController,
  FileTaskWorkflowRuntime,
  restartFileTaskController
} from "../../dist/controller/clientRuntime.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import {
  createRuntimeLifecycleDispatcher,
  startFileTaskControllerRuntime
} from "../../dist/controller/runtime.js";
import { ControllerClientError } from "../../dist/core/controllerClient.js";
import { FILE_TASK_CONTROLLER_PROTOCOL_VERSION } from "../../dist/core/protocol.js";
import { YUI_VERSION, yuiVersionIdentity } from "../../dist/version.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import {
  createGlobalRole,
  createRole,
  createRoleAgentBinding,
  updateRole
} from "../../dist/role/role.js";
import { createAgentRun } from "../helpers/effectiveLaunch.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { repairOrphanedActiveTasks } from "../../dist/scheduler/activeTaskProgress.js";
import { mergePendingWakeup } from "../../dist/scheduler/pendingWakeup.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { createProject } from "../../dist/repository/project.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, archiveTask, completeTask, createTask } from "../../dist/task/task.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { TmuxSessionHost } from "../../dist/runtime/index.js";
import { taskOwnedWorkspace } from "../helpers/taskWorkspace.js";

const FIRST = new Date("2026-07-24T00:00:00.000Z");
const SECOND = new Date("2026-07-24T00:00:01.000Z");

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

test("storage writes reject a running Controller with an incompatible protocol", async () => {
  const identity = yuiVersionIdentity();
  await assert.rejects(
    assertFileTaskControllerStorageCompatible("/tmp/yui-old-controller", {
      call: async () => ({ running: true, pid: 42 })
    }),
    /Controller protocol is incompatible.*controller restart/i
  );
  await assert.doesNotReject(
    assertFileTaskControllerStorageCompatible("/tmp/yui-current-controller", {
      call: async () => ({
        running: true,
        pid: 43,
        protocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
        version: YUI_VERSION,
        storageLayoutVersion: identity.storageLayoutVersion,
        aggregateSchemaVersion: identity.aggregateSchemaVersion
      })
    })
  );
  await assert.rejects(
    assertFileTaskControllerStorageCompatible("/tmp/yui-stale-controller", {
      call: async () => ({
        running: true,
        pid: 44,
        protocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
        version: "0.2.9",
        storageLayoutVersion: identity.storageLayoutVersion,
        aggregateSchemaVersion: identity.aggregateSchemaVersion
      })
    }),
    /Controller version is incompatible.*controller restart/i
  );
  await assert.doesNotReject(
    assertFileTaskControllerStorageCompatible("/tmp/yui-no-controller", {
      call: async () => {
        throw new ControllerClientError(
          "CONTROLLER_NOT_RUNNING",
          "Controller is not running."
        );
      }
    })
  );
  await assert.rejects(
    assertFileTaskControllerStorageCompatible("/tmp/yui-wrong-aggregate-controller", {
      call: async () => ({
        running: true,
        pid: 45,
        protocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
        version: YUI_VERSION,
        storageLayoutVersion: identity.storageLayoutVersion,
        aggregateSchemaVersion: identity.aggregateSchemaVersion - 1
      })
    }),
    /Controller aggregate schema.*controller restart/i
  );
  await assert.rejects(
    ensureFileTaskController("/tmp/yui-old-controller", {
      call: async () => ({ running: true, pid: 42 })
    }),
    /Controller protocol is incompatible.*controller restart/i
  );
});

function fixture(t, adapterId = "codex") {
  const home = mkdtempSync(join(tmpdir(), "yui-runtime-hardening-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent(
    `${adapterId}-primary`,
    adapterId,
    `${adapterId}-test`,
    [],
    [],
    FIRST
  );
  const task = activateTask(createTask("task-1", "Runtime hardening", FIRST, {
    cwd: home
  }), FIRST);
  const role = createRole(
    task.id,
    "leader",
    [createRoleAgentBinding(agent)],
    agent.id,
    join(home, "role-workspace-hint"),
    FIRST
  );
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveManagedWorkspace(taskOwnedWorkspace(task, FIRST));
    tx.saveRole(task.id, role);
  });
  return { home, store, agent, task, role };
}

test("an active Role Run may launch from its snapshotted workspace", async (t) => {
  const { home, store, agent, task, role } = fixture(t);
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  const reviewer = createRole(
    task.id,
    "reviewer",
    [createRoleAgentBinding(agent)],
    agent.id,
    home,
    FIRST
  );
  const workspace = store.getTaskWorkspace(task.id);
  assert.notEqual(workspace, null);
  const run = createAgentRun(
    "agent-run-101",
    task.id,
    reviewer.name,
    "new",
    "Review the candidate.",
    FIRST,
    {
      workspace,
      effective: resolveEffectiveLaunch({
        role: reviewer,
        purpose: "execution",
        workspace
      })
    }
  );
  const target = { kind: "role", taskId: task.id, roleName: reviewer.name };
  store.transaction((tx) => {
    tx.saveRole(task.id, reviewer);
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, target, "review-requested", FIRST, [
      { type: "run", taskId: task.id, id: run.id }
    ]);
  });
  const starts = [];
  const sessionHost = {
    async start(request, beforeHostStart) {
      starts.push(request);
      beforeHostStart?.({
        owner: request.owner,
        launchId: request.launchId,
        ...(request.runId === undefined ? {} : { runId: request.runId }),
        agentId: request.agentId,
        adapterId: request.adapterId,
        effective: request.effective
      });
      return {
        id: "binding-workspace",
        launchId: request.launchId,
        owner: request.owner,
        agentId: request.agentId,
        adapterId: request.adapterId,
        hostRef: "opaque-workspace",
        hostCreated: false
      };
    },
    async resume() { throw new Error("unexpected resume"); },
    async stop() {},
    async inspect() { return { state: "running" }; },
    async inspectOwner() { return { state: "running" }; }
  };
  const running = await startFileTaskControllerRuntime(home, {
    store,
    schedulerStore,
    planner: {},
    tmux: { probeRoleStatus() { return "running"; } },
    sessionHost,
    promptPush: { async tryPush() { return "delivered"; } },
    workspacePreparer: {
      async prepareTaskWorkspace() { return { taskId: task.id, status: "ready" }; }
    },
    runtimeEventProcessor: {
      drain() { return { appliedEventIds: [], acknowledgedEventIds: [], failed: [] }; }
    },
    intervalMs: 60_000,
    now: () => FIRST
  });
  t.after(() => running.close());

  await running.runtime.pump();

  const reviewerStart = starts.find(({ owner }) => owner.roleName === reviewer.name);
  assert.ok(reviewerStart);
  assert.equal(reviewerStart.workspace, workspace.root);
  assert.notEqual(reviewerStart.workspace, role.workspace);
  assert.notEqual(store.getActiveAgentRun(task.id, reviewer.name).pushedAt, undefined);
});

async function lifecycleDispatchAfterTaskMainChange(t, change) {
  const { home, store, agent, role: initialRole } = fixture(t, "claude");
  const task = activateTask(createTask("task-1", "Runtime hardening", FIRST, {
    projectBindings: [{ projectId: "project-1", directory: "Yui", baseRef: "main" }],
    cwd: home
  }), FIRST);
  store.transaction((tx) => {
    tx.saveProject(createProject(
      "project-1",
      "Yui",
      home,
      { stable: "main", development: "main" },
      FIRST
    ));
    tx.saveTask(task);
  });
  const beforeWorkspace = store.getTaskWorkspace(task.id);
  const oldCommit = "a".repeat(40);
  const newCommit = "b".repeat(40);
  const withCommit = (workspace, baseCommit, updatedAt) => ({
    ...workspace,
    entries: [{
      projectId: "project-1",
      directory: "Yui",
      access: "write",
      path: home,
      branch: "main",
      baseRef: "main",
      baseCommit
    }],
    updatedAt: updatedAt.toISOString()
  });
  const oldWorkspace = withCommit(beforeWorkspace, oldCommit, FIRST);
  store.saveManagedWorkspace(oldWorkspace);
  const immutable = resolveEffectiveLaunch({
    role: initialRole,
    purpose: "execution",
    workspace: oldWorkspace
  });
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: initialRole.name
  }, agent.id, FIRST);
  sessions = recordRoleAgentSession(sessions, {
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: "claude-fixed-before-main-advance",
    policy: "fixed",
    status: "ready",
    effective: immutable
  }, FIRST);
  store.saveTaskRoleSessionSet(sessions);
  const { workspace: changedWorkspace, role: changedRole = initialRole } = change({
    home,
    workspace: withCommit(oldWorkspace, newCommit, SECOND),
    role: initialRole,
    agent
  });
  if (changedRole !== initialRole) store.saveRole(task.id, changedRole);
  const advancedWorkspace = {
    ...changedWorkspace,
    updatedAt: SECOND.toISOString()
  };
  store.saveManagedWorkspace(advancedWorkspace);
  const runEffective = resolveEffectiveLaunch({
    role: changedRole,
    purpose: "execution",
    workspace: advancedWorkspace
  });
  const run = createAgentRun(
    "agent-run-102",
    task.id,
    changedRole.name,
    "resume",
    "Continue after Task main advanced.",
    SECOND,
    { workspace: advancedWorkspace, effective: runEffective }
  );
  store.saveActiveAgentRun(run);

  const planner = new FileRoleLaunchPlanner(home, store, { cliPath: "/dist/cli.js" });
  const planned = [];
  const host = new TmuxSessionHost(planner, {
    async ensureRoleWindowAsync(_taskId, _plannedRole, launch) {
      planned.push(launch);
      return false;
    },
    async probeRoleStatusAsync() { return "running"; },
    killRole() {}
  }, { createBindingId: () => "binding-after-main-advance" });
  const dispatch = createRuntimeLifecycleDispatcher(store, new FileSchedulerStoreAdapter(store), host);

  return {
    dispatch: () => dispatch("runtime.ensure-role-session", {
      scope: "task",
      taskId: task.id,
      roleName: changedRole.name
    }),
    home,
    store,
    role: changedRole,
    run,
    runEffective,
    immutable,
    planned
  };
}

test("a fixed Leader Session resumes through the real planner after Task main advances", async (t) => {
  const fx = await lifecycleDispatchAfterTaskMainChange(t, ({ workspace }) => ({ workspace }));

  await fx.dispatch();

  assert.equal(fx.planned.length, 1);
  const resumeIndex = fx.planned[0].args.indexOf("--resume");
  assert.notEqual(resumeIndex, -1);
  assert.equal(fx.planned[0].args[resumeIndex + 1], "claude-fixed-before-main-advance");
  assert.equal(fx.planned[0].env.YUI_RUN_ID, fx.run.id);
  assert.equal(fx.runEffective.workspace.entries[0].baseCommit, "b".repeat(40));
  assert.deepEqual(
    fx.store.getRoleSession(fx.run.taskId, fx.role.name).effective,
    fx.immutable
  );
});

for (const [name, change] of [
  ["path", ({ home, workspace }) => ({
    workspace: {
      ...workspace,
      entries: workspace.entries.map((entry) => ({ ...entry, path: join(home, "other") }))
    }
  })],
  ["branch", ({ workspace }) => ({
    workspace: {
      ...workspace,
      entries: workspace.entries.map((entry) => ({ ...entry, branch: "other-main" }))
    }
  })],
  ["access policy", ({ workspace, role }) => ({
    workspace,
    role: updateRole(role, { defaultAccess: "read" }, SECOND)
  })],
  ["Agent config", ({ workspace, role, agent }) => ({
    workspace,
    role: updateRole(role, {
      agentBindings: {
        [agent.id]: createRoleAgentBinding(agent, {
          adapterId: "claude",
          model: "claude-next"
        })
      }
    }, SECOND)
  })]
]) {
  test(`lifecycle dispatch fails closed when Task main ${name} changes`, async (t) => {
    const fx = await lifecycleDispatchAfterTaskMainChange(t, change);

    await assert.rejects(fx.dispatch(), /incompatible with the next effective launch/i);
    assert.equal(fx.planned.length, 0);
    assert.deepEqual(
      fx.store.getRoleSession(fx.run.taskId, fx.role.name).effective,
      fx.immutable
    );
  });
}

test("a Role host created after Task archival is stopped without a false cleanup signal", async (t) => {
  const { store, task, role } = fixture(t);
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  let releaseStart;
  let announceStart;
  const startBlocked = new Promise((resolve) => { releaseStart = resolve; });
  const startEntered = new Promise((resolve) => { announceStart = resolve; });
  const runtimeBinding = {
    id: "binding-1",
    launchId: "launch-1",
    owner: { scope: "task", taskId: task.id, roleName: role.name },
    agentId: role.activeAgentId,
    adapterId: "codex",
    hostRef: "opaque",
    hostCreated: true
  };
  const stopped = [];
  let hostStopped = false;
  const sessionHost = {
    async start(request) {
      announceStart();
      await startBlocked;
      return { ...runtimeBinding, launchId: request.launchId };
    },
    async resume() { throw new Error("unexpected resume"); },
    async stop(binding) {
      stopped.push(binding);
      hostStopped = true;
    },
    async inspect() { return { state: "running" }; },
    async inspectOwner() {
      return { state: hostStopped ? "stopped" : "running" };
    }
  };
  const dispatch = createRuntimeLifecycleDispatcher(store, schedulerStore, sessionHost);
  const entering = dispatch("runtime.ensure-role-session", {
    scope: "task",
    taskId: task.id,
    roleName: role.name
  });
  await startEntered;
  store.saveTask(archiveTask(
    completeTask(store.getTask(task.id), FIRST, {
      by: "leader",
      summary: "Fixture complete."
    }),
    SECOND
  ));

  releaseStart();

  await assert.rejects(entering, /archived|state changed|no longer active/i);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].id, runtimeBinding.id);
  assert.deepEqual(stopped[0].owner, runtimeBinding.owner);
  assert.match(stopped[0].launchId, /^runtime-.*:generation:/);
  assert.equal(
    store.getWorkMailbox({
      kind: "role-runtime",
      taskId: task.id,
      roleName: role.name
    }),
    null
  );
});

test("failed stale-host cleanup is durable and fences a replacement launch", async (t) => {
  const { store, task, role } = fixture(t);
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  let releaseStart;
  let announceStart;
  let starts = 0;
  const startBlocked = new Promise((resolve) => { releaseStart = resolve; });
  const startEntered = new Promise((resolve) => { announceStart = resolve; });
  const runtimeBinding = {
    id: "binding-1",
    launchId: "launch-1",
    owner: { scope: "task", taskId: task.id, roleName: role.name },
    agentId: role.activeAgentId,
    adapterId: "codex",
    hostRef: "opaque",
    hostCreated: true
  };
  const sessionHost = {
    async start(request) {
      starts += 1;
      announceStart();
      await startBlocked;
      return { ...runtimeBinding, launchId: request.launchId };
    },
    async resume() { throw new Error("unexpected resume"); },
    async stop() { throw new Error("transient kill failure"); },
    async inspect() { return { state: "running" }; }
  };
  const cleanupSignals = [];
  const dispatch = createRuntimeLifecycleDispatcher(
    store,
    schedulerStore,
    sessionHost,
    undefined,
    (target) => cleanupSignals.push(target)
  );
  const entering = dispatch("runtime.ensure-role-session", {
    scope: "task",
    taskId: task.id,
    roleName: role.name
  });
  await startEntered;
  assert.equal(store.removeTaskRole(task.id, role.name), true);
  releaseStart();

  await assert.rejects(entering, /cleanup also failed.*transient kill failure/i);
  assert.deepEqual(
    store.getWorkMailbox({
      kind: "role-runtime",
      taskId: task.id,
      roleName: role.name
    }).pending.reasons,
    ["runtime-cleanup-required"]
  );
  assert.deepEqual(cleanupSignals, [{
    kind: "role-runtime",
    taskId: task.id,
    roleName: role.name
  }]);
  await assert.rejects(
    dispatch("runtime.ensure-role-session", {
      scope: "task",
      taskId: task.id,
      roleName: role.name
    }),
    /cleanup is still pending/i
  );
  assert.equal(starts, 1);
});

test("failed stale global host cleanup is durable in an isolated global lane", async (t) => {
  const { home, store, agent } = fixture(t);
  const role = createGlobalRole(
    "reviewer",
    [createRoleAgentBinding(agent)],
    agent.id,
    home,
    FIRST
  );
  store.saveGlobalRole(role);
  let releaseStart;
  let announceStart;
  const startBlocked = new Promise((resolve) => { releaseStart = resolve; });
  const startEntered = new Promise((resolve) => { announceStart = resolve; });
  const sessionHost = {
    async start(request) {
      announceStart();
      await startBlocked;
      return {
        id: "global-binding",
        launchId: request.launchId,
        owner: request.owner,
        agentId: request.agentId,
        adapterId: request.adapterId,
        hostRef: "global-opaque",
        hostCreated: true
      };
    },
    async resume() { throw new Error("unexpected resume"); },
    async stop() { throw new Error("global tmux unavailable"); },
    async inspect() { return { state: "running" }; }
  };
  const signals = [];
  const dispatch = createRuntimeLifecycleDispatcher(
    store,
    new FileSchedulerStoreAdapter(store),
    sessionHost,
    undefined,
    (target) => signals.push(target)
  );
  const entering = dispatch("runtime.ensure-role-session", {
    scope: "global",
    roleName: role.name
  });
  await startEntered;
  assert.equal(store.removeGlobalRole(role.name), true);
  releaseStart();

  await assert.rejects(entering, /cleanup also failed.*global tmux unavailable/i);
  const target = { kind: "global-role-runtime", roleName: role.name };
  assert.deepEqual(
    store.getWorkMailbox(target).pending.reasons,
    ["runtime-cleanup-required"]
  );
  assert.deepEqual(signals, [target]);
  await assert.rejects(
    dispatch("runtime.ensure-role-session", {
      scope: "global",
      roleName: role.name
    }),
    /cleanup is still pending/i
  );
});

test("replacement launch waits until stale-host compensation has finished", async (t) => {
  const { store, task, role } = fixture(t);
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  let releaseFirstStart;
  let announceFirstStart;
  let releaseStop;
  let announceStop;
  let starts = 0;
  const firstStartBlocked = new Promise((resolve) => { releaseFirstStart = resolve; });
  const firstStartEntered = new Promise((resolve) => { announceFirstStart = resolve; });
  const stopBlocked = new Promise((resolve) => { releaseStop = resolve; });
  const stopEntered = new Promise((resolve) => { announceStop = resolve; });
  let hostStopped = false;
  const binding = (id, request) => ({
    id,
    launchId: request.launchId,
    owner: request.owner,
    agentId: request.agentId,
    adapterId: request.adapterId,
    hostRef: id,
    hostCreated: true
  });
  const sessionHost = {
    async start(request) {
      starts += 1;
      hostStopped = false;
      if (starts === 1) {
        announceFirstStart();
        await firstStartBlocked;
      }
      return binding(`binding-${starts}`, request);
    },
    async resume() { throw new Error("unexpected resume"); },
    async stop() {
      announceStop();
      await stopBlocked;
      hostStopped = true;
    },
    async inspect() { return { state: "running" }; },
    async inspectOwner() {
      return { state: hostStopped ? "stopped" : "running" };
    }
  };
  const dispatch = createRuntimeLifecycleDispatcher(store, schedulerStore, sessionHost);
  const staleEnter = dispatch("runtime.ensure-role-session", {
    scope: "task",
    taskId: task.id,
    roleName: role.name
  });
  await firstStartEntered;
  store.saveRole(task.id, updateRole(role, {
    workspace: `${role.workspace}-replacement`
  }, SECOND));
  const replacementEnter = dispatch("runtime.ensure-role-session", {
    scope: "task",
    taskId: task.id,
    roleName: role.name
  });
  releaseFirstStart();
  await stopEntered;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);

  releaseStop();
  await assert.rejects(staleEnter, /launch state changed/i);
  assert.deepEqual(await replacementEnter, {
    ensured: true,
    sessionStarted: true,
    scope: "task",
    roleName: role.name,
    taskId: task.id
  });
  assert.equal(starts, 2);
});

test("launch identity and deterministic Claude session ids are fenced by Agent identity", async (t) => {
  const { home, store, task, role, agent } = fixture(t, "claude");
  const secondAgent = createConfiguredAgent(
    "claude-secondary",
    "claude",
    "claude-test",
    [],
    [],
    SECOND
  );
  const withBothAgents = updateRole(role, {
    agentBindings: {
      ...role.agentBindings,
      [secondAgent.id]: createRoleAgentBinding(secondAgent)
    }
  }, SECOND);
  store.transaction((tx) => {
    tx.saveConfiguredAgent(secondAgent);
    tx.saveRole(task.id, withBothAgents);
  });
  const planner = new FileRoleLaunchPlanner(home, store, {
    createNativeSessionId: () => {
      throw new Error("durable launches must not allocate randomly");
    }
  });
  const common = {
    taskId: task.id,
    roleName: role.name,
    adapterId: "claude",
    mode: "new",
    launchId: "same-logical-launch"
  };
  const firstPlan = planner.plan({ ...common, agentId: agent.id });
  const launchIds = [];
  const sessionHost = {
    async start(request) {
      launchIds.push(request.launchId);
      return {
        id: `binding-${launchIds.length}`,
        launchId: request.launchId,
        owner: request.owner,
        agentId: request.agentId,
        adapterId: request.adapterId,
        hostRef: `opaque-${launchIds.length}`,
        hostCreated: true
      };
    },
    async resume() { throw new Error("unexpected resume"); },
    async stop() {},
    async inspect() { return { state: "running" }; }
  };
  const dispatch = createRuntimeLifecycleDispatcher(
    store,
    new FileSchedulerStoreAdapter(store),
    sessionHost
  );
  await dispatch("runtime.ensure-role-session", {
    scope: "task",
    taskId: task.id,
    roleName: role.name
  });
  const firstLifecycleMailbox = store.getWorkMailbox({
    kind: "role-runtime",
    taskId: task.id,
    roleName: role.name
  });
  new FileSchedulerStoreAdapter(store).completeRuntimeLaunchReservation(
    { scope: "task", taskId: task.id, roleName: role.name },
    firstLifecycleMailbox.processing.batchId
  );

  const switched = updateRole(store.getRole(task.id, role.name), {
    activeAgentId: secondAgent.id
  }, new Date(SECOND.getTime() + 1));
  store.saveRole(task.id, switched);
  const secondPlan = planner.plan({ ...common, agentId: secondAgent.id });
  await dispatch("runtime.ensure-role-session", {
    scope: "task",
    taskId: task.id,
    roleName: role.name
  });

  assert.notEqual(firstPlan.session.nativeSessionId, secondPlan.session.nativeSessionId);
  assert.notEqual(launchIds[0], launchIds[1]);
});

test("an old launch generation Hook cannot bind a newer reservation", (t) => {
  const { store, task, role, agent } = fixture(t);
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  const owner = {
    scope: "task",
    taskId: task.id,
    roleName: role.name
  };
  assert.deepEqual(
    schedulerStore.reserveRuntimeLaunch(
      { owner, launchId: "launch-generation-old" },
      () => {}
    ),
    { status: "reserved", launchId: "launch-generation-old" }
  );
  assert.equal(
    schedulerStore.completeRuntimeLaunchReservation(
      owner,
      "launch-generation-old"
    ),
    true
  );
  assert.deepEqual(
    schedulerStore.reserveRuntimeLaunch(
      { owner, launchId: "launch-generation-new" },
      () => {}
    ),
    { status: "reserved", launchId: "launch-generation-new" }
  );

  const common = {
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: "native-old",
    turnId: "turn-old"
  };
  assert.equal(
    schedulerStore.classifyRuntimeTurnCompleted({
      ...common,
      launchId: "launch-generation-old"
    }),
    "obsolete"
  );
  assert.throws(
    () => schedulerStore.observeRuntimeTurnCompleted({
      ...common,
      launchId: "launch-generation-old",
      summary: "late old Hook"
    }),
    /does not match the launch reservation/i
  );
  assert.equal(store.getRoleSession(task.id, role.name), null);

  assert.equal(
    schedulerStore.classifyRuntimeTurnCompleted({
      ...common,
      launchId: "launch-generation-new",
      nativeSessionId: "native-new",
      turnId: "turn-new"
    }),
    "apply"
  );
  schedulerStore.observeRuntimeTurnCompleted({
    ...common,
    launchId: "launch-generation-new",
    nativeSessionId: "native-new",
    turnId: "turn-new",
    summary: "current Hook"
  });
  assert.equal(
    store.getRoleSession(task.id, role.name).nativeSessionId,
    "native-new"
  );
  assert.equal(store.getWorkMailbox({
    kind: "role-runtime",
    taskId: task.id,
    roleName: role.name
  }), null);
});

test("a first Task or global Hook without a launch reservation is obsolete", (t) => {
  const { home, store, task, role, agent } = fixture(t);
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  const taskHook = {
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    launchId: "unreserved-task-launch",
    nativeSessionId: "unreserved-task-native",
    turnId: "unreserved-task-turn"
  };
  assert.equal(
    schedulerStore.classifyRuntimeTurnCompleted(taskHook),
    "obsolete"
  );
  assert.throws(
    () => schedulerStore.observeRuntimeTurnCompleted({
      ...taskHook,
      summary: "must not bind"
    }),
    /does not match the launch reservation/i
  );
  assert.equal(store.getRoleSession(task.id, role.name), null);

  const globalRole = createGlobalRole(
    "unreserved-global",
    [createRoleAgentBinding(agent)],
    agent.id,
    home,
    FIRST
  );
  store.saveGlobalRole(globalRole);
  const globalHook = {
    roleName: globalRole.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    launchId: "unreserved-global-launch",
    nativeSessionId: "unreserved-global-native",
    turnId: "unreserved-global-turn"
  };
  assert.equal(
    schedulerStore.classifyGlobalRuntimeTurnCompleted(globalHook),
    "obsolete"
  );
  assert.throws(
    () => schedulerStore.observeGlobalRuntimeTurnCompleted(globalHook),
    /does not match the global launch reservation/i
  );
  assert.equal(store.getGlobalRoleSessionSet(globalRole.name), null);
});

test("a confirmed stopped host is relaunched with a fresh generation", async (t) => {
  const { store, task, role } = fixture(t);
  const launchIds = [];
  const sessionHost = {
    async start(request) {
      launchIds.push(request.launchId);
      return {
        id: `binding-${launchIds.length}`,
        launchId: request.launchId,
        owner: request.owner,
        agentId: request.agentId,
        adapterId: request.adapterId,
        hostRef: `opaque-${launchIds.length}`,
        hostCreated: true
      };
    },
    async resume() { throw new Error("unexpected resume"); },
    async stop() {},
    async inspect() { return { state: "stopped" }; },
    async inspectOwner() { return { state: "stopped" }; },
    async stopOwner() { return true; }
  };
  const dispatch = createRuntimeLifecycleDispatcher(
    store,
    new FileSchedulerStoreAdapter(store),
    sessionHost
  );
  const request = {
    scope: "task",
    taskId: task.id,
    roleName: role.name
  };

  await dispatch("runtime.ensure-role-session", request);
  await dispatch("runtime.ensure-role-session", request);

  assert.equal(launchIds.length, 2);
  assert.notEqual(launchIds[0], launchIds[1]);
});

test("Controller startup forwards only operational names and declared Agent environment sources", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-controller-env-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfiguredAgent(createConfiguredAgent(
    "codex-env",
    "codex",
    "codex",
    [],
    [{
      target: "OPENAI_API_KEY",
      source: "process",
      sourceName: "DECLARED_CONTROLLER_SECRET",
      required: true
    }],
    FIRST
  ));
  let running = false;
  let spawnedEnvironment;
  const unavailable = () => new ControllerClientError(
    "CONTROLLER_UNAVAILABLE",
    "Controller unavailable"
  );

  await ensureFileTaskController(home, {
    environment: {
      PATH: "/test/bin",
      HOME: "/test/home",
      LANG: "C.UTF-8",
      CODEX_HOME: "/test/codex-home",
      TMUX_TMPDIR: "/test/tmux-tmp",
      DECLARED_CONTROLLER_SECRET: "declared-value",
      UNDECLARED_CONTROLLER_SECRET: "must-not-cross",
      YUI_TASK_ID: "parent-task",
      YUI_ROLE: "leader",
      YUI_HOME: "/forged/home"
    },
    call: async () => {
      if (!running) throw unavailable();
      return currentControllerStatus(42);
    },
    spawnController(_home, environment) {
      spawnedEnvironment = environment;
      running = true;
    }
  });

  assert.equal(spawnedEnvironment.PATH, "/test/bin");
  assert.equal(spawnedEnvironment.HOME, "/test/home");
  assert.equal(spawnedEnvironment.CODEX_HOME, "/test/codex-home");
  assert.equal(spawnedEnvironment.TMUX_TMPDIR, "/test/tmux-tmp");
  assert.equal(spawnedEnvironment.DECLARED_CONTROLLER_SECRET, "declared-value");
  assert.equal(spawnedEnvironment.UNDECLARED_CONTROLLER_SECRET, undefined);
  assert.equal(spawnedEnvironment.YUI_TASK_ID, undefined);
  assert.equal(spawnedEnvironment.YUI_ROLE, undefined);
  assert.equal(spawnedEnvironment.YUI_HOME, home);
  assert.equal(existsSync(join(home, "controller.log")), false);
});

test("foreground enter sends only fresh declared environment sources to an existing Controller", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-foreground-env-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent(
    "codex-foreground",
    "codex",
    "codex",
    [],
    [{
      target: "OPENAI_API_KEY",
      source: "process",
      sourceName: "CALLER_TOKEN",
      required: true
    }],
    FIRST
  );
  const task = activateTask(createTask("task-1", "Foreground environment", FIRST), FIRST);
  const role = createRole(
    task.id,
    "leader",
    [createRoleAgentBinding(agent)],
    agent.id,
    home,
    FIRST
  );
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveRole(task.id, role);
  });
  const calls = [];
  const runtime = new FileTaskWorkflowRuntime(
    home,
    store,
    {},
    {},
    {},
    undefined,
    {
      environment: {
        CODEX_HOME: "/caller/codex-home",
        CALLER_TOKEN: "fresh-value",
        UNDECLARED_TOKEN: "must-not-cross",
        YUI_TASK_ID: "parent-task",
        YUI_ROLE: "worker"
      },
      call: async (_home, method, params) => {
        calls.push([method, params]);
        return { ensured: true };
      }
    }
  );

  await runtime.prepareTaskRoleEnter({ taskId: task.id, roleName: role.name });

  assert.deepEqual(calls, [[
    "runtime.ensure-role-session",
    {
      scope: "task",
      taskId: task.id,
      roleName: role.name,
      environment: {
        PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
        HOME: homedir(),
        TERM: "xterm-256color",
        TMPDIR: tmpdir(),
        CODEX_HOME: "/caller/codex-home",
        CALLER_TOKEN: "fresh-value"
      }
    }
  ]]);
});

test("launch environment keeps native context and excludes other Agents' credentials", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-agent-env-isolation-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const current = createConfiguredAgent(
    "codex-current",
    "codex",
    "codex",
    [],
    [{
      target: "OPENAI_API_KEY",
      source: "process",
      sourceName: "CURRENT_AGENT_SECRET",
      required: true
    }],
    FIRST
  );
  const other = createConfiguredAgent(
    "claude-other",
    "claude",
    "claude",
    [],
    [{
      target: "ANTHROPIC_API_KEY",
      source: "process",
      sourceName: "OTHER_AGENT_SECRET",
      required: true
    }],
    FIRST
  );
  const task = activateTask(createTask("task-1", "Environment isolation", FIRST, {
    cwd: home
  }), FIRST);
  const role = createRole(
    task.id,
    "leader",
    [createRoleAgentBinding(current)],
    current.id,
    home,
    FIRST
  );
  store.transaction((tx) => {
    tx.saveConfiguredAgent(current);
    tx.saveConfiguredAgent(other);
    tx.saveTask(task);
    tx.saveManagedWorkspace(taskOwnedWorkspace(task, FIRST));
    tx.saveRole(task.id, role);
  });
  const codexHome = join(home, "native-codex-home");
  const planner = new FileRoleLaunchPlanner(home, store, {
    environment: {
      PATH: "/native/bin",
      HOME: "/native/home",
      TERM: "screen-256color",
      CODEX_HOME: codexHome,
      CURRENT_AGENT_SECRET: "current-value",
      OTHER_AGENT_SECRET: "must-not-cross",
      UNDECLARED_SECRET: "must-not-cross"
    }
  });

  const plan = planner.plan({
    taskId: task.id,
    roleName: role.name,
    agentId: current.id,
    adapterId: current.adapterId,
    mode: "new",
    launchId: "environment-isolation"
  });

  assert.equal(
    plan.launch.env.PATH,
    "/native/bin"
  );
  assert.equal(plan.launch.env.HOME, "/native/home");
  assert.equal(plan.launch.env.TERM, "screen-256color");
  assert.equal(plan.launch.env.CODEX_HOME, codexHome);
  assert.equal(plan.launch.env.OPENAI_API_KEY, "current-value");
  assert.equal(plan.launch.env.CURRENT_AGENT_SECRET, undefined);
  assert.equal(plan.launch.env.OTHER_AGENT_SECRET, undefined);
  assert.equal(plan.launch.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(plan.launch.env.UNDECLARED_SECRET, undefined);

  const fallbackPlan = new FileRoleLaunchPlanner(home, store, {
    environment: {
      PATH: "",
      HOME: "",
      TERM: "dumb",
      TMPDIR: "",
      COLORTERM: "",
      LANG: "",
      CODEX_HOME: join(home, "clean-codex-home"),
      CURRENT_AGENT_SECRET: "current-value"
    }
  }).plan({
    taskId: task.id,
    roleName: role.name,
    agentId: current.id,
    adapterId: current.adapterId,
    mode: "new",
    launchId: "environment-fallbacks"
  });
  assert.match(
    fallbackPlan.launch.env.PATH,
    new RegExp(
      `^${dirname(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
      + `${delimiter}`
    )
  );
  assert.equal(fallbackPlan.launch.env.HOME, homedir());
  assert.equal(fallbackPlan.launch.env.TERM, "xterm-256color");
  assert.equal(fallbackPlan.launch.env.TMPDIR, tmpdir());
  assert.equal(fallbackPlan.launch.env.COLORTERM, undefined);
  assert.equal(fallbackPlan.launch.env.LANG, undefined);
});

test("foreground CODEX_HOME is authoritative for native config inspection", (t) => {
  const { home, store, task, role, agent } = fixture(t);
  const callerCodexHome = join(home, "caller-codex-home");
  mkdirSync(callerCodexHome, { recursive: true });
  writeFileSync(
    join(callerCodexHome, "config.toml"),
    'developer_instructions = "native policy"\n',
    "utf8"
  );
  const planner = new FileRoleLaunchPlanner(home, store, {
    environment: {
      PATH: "/controller/bin",
      HOME: "/controller/home",
      TERM: "xterm-controller"
    }
  });

  assert.throws(() => planner.plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new",
    launchId: "caller-config",
    environment: {
      PATH: "/caller/bin",
      HOME: "/caller/home",
      TERM: "xterm-caller",
      CODEX_HOME: callerCodexHome
    }
  }), /developer_instructions is already configured.*caller-codex-home/i);
});

test("Controller restart gives shutdown drain an independent timeout budget", async () => {
  let phase = "running";
  let stoppingPolls = 0;
  const unavailable = () => new ControllerClientError(
    "CONTROLLER_UNAVAILABLE",
    "Controller unavailable"
  );
  const call = async (_home, method) => {
    if (method === "controller.stop") {
      phase = "stopping";
      return { stopped: true };
    }
    if (phase === "running") {
      return currentControllerStatus(10);
    }
    if (phase === "stopping") {
      if (stoppingPolls++ < 2) {
        return currentControllerStatus(10);
      }
      phase = "stopped";
      throw unavailable();
    }
    if (phase === "stopped") throw unavailable();
    return currentControllerStatus(20);
  };

  const result = await restartFileTaskController("/tmp/yui-restart-long-drain", {
    call,
    pollIntervalMs: 5,
    startupTimeoutMs: 1,
    shutdownTimeoutMs: 100,
    spawnController() { phase = "started"; }
  });

  assert.deepEqual(result, { restarted: true, previousPid: 10, pid: 20 });
});

test("Controller restart default shutdown budget exceeds lifecycle request timeout", async (t) => {
  const originalNow = Date.now;
  let currentTime = 0;
  let phase = "running";
  let stoppingPolls = 0;
  Date.now = () => currentTime;
  t.after(() => { Date.now = originalNow; });
  const unavailable = () => new ControllerClientError(
    "CONTROLLER_UNAVAILABLE",
    "Controller unavailable"
  );
  const call = async (_home, method) => {
    if (method === "controller.stop") {
      phase = "stopping";
      return { stopped: true };
    }
    if (phase === "running") {
      return currentControllerStatus(10);
    }
    if (phase === "stopping") {
      if (stoppingPolls++ === 0) {
        currentTime = 40_000;
        return currentControllerStatus(10);
      }
      phase = "stopped";
      throw unavailable();
    }
    if (phase === "stopped") throw unavailable();
    return currentControllerStatus(20);
  };

  const result = await restartFileTaskController("/tmp/yui-restart-default-drain", {
    call,
    pollIntervalMs: 1,
    spawnController() { phase = "started"; }
  });

  assert.deepEqual(result, { restarted: true, previousPid: 10, pid: 20 });
});

test("orphan recovery uses the store's atomic Leader enqueue operation", () => {
  const queued = [];
  const task = {
    id: "task-1",
    title: "Atomic orphan recovery",
    status: "active",
    projectBindings: [],
    cwd: "/tmp/yui-orphan-task-1"
  };
  const workspace = createManagedWorkspace({
    owner: { type: "task", taskId: task.id },
    root: task.cwd,
    entries: []
  }, FIRST);
  const store = {
    listTasks: () => [task],
    getTask: () => task,
    getTaskWorkspace: () => workspace,
    listRoles: () => [],
    getActiveAgentRun: () => null,
    hasInFlightTurn: () => false,
    hasOpenInputRequest: () => false,
    getLeaderFailure: () => null,
    getOperatorNotification: () => null,
    getPendingWakeup: () => null,
    getWorkMailbox: () => null,
    releaseWorkMailbox: () => false,
    enqueueLeaderWakeup(taskId, reason, now) {
      queued.push({ taskId, reason, now });
      return mergePendingWakeup(taskId, reason, now, null);
    },
    savePendingWakeup() {
      throw new Error("legacy read-merge-write path must not be used");
    }
  };

  assert.deepEqual(repairOrphanedActiveTasks(store, SECOND), [task.id]);
  assert.deepEqual(queued, [{
    taskId: task.id,
    reason: "task-orphaned",
    now: SECOND
  }]);
});

test("orphan recovery atomically releases processing and retains concurrent Leader signals", (t) => {
  const { store, task, role } = fixture(t);
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  const target = {
    kind: "role",
    taskId: task.id,
    roleName: role.name
  };
  store.transaction((tx) => {
    enqueueWork(tx, target, "claimed-work", FIRST);
  });
  const claim = schedulerStore.claimWorkMailbox({
    target,
    batchId: "stranded-leader-run",
    owner: "controller",
    now: FIRST
  });
  assert.equal(claim.status, "claimed");
  store.transaction((tx) => {
    enqueueWork(tx, target, "concurrent-signal", SECOND);
  });

  assert.deepEqual(
    repairOrphanedActiveTasks(
      schedulerStore,
      new Date(SECOND.getTime() + 1)
    ),
    [task.id]
  );

  const mailbox = store.getWorkMailbox(target);
  assert.equal(mailbox.processing, null);
  assert.deepEqual(mailbox.pending.reasons, [
    "claimed-work",
    "concurrent-signal",
    "task-orphaned"
  ]);
  assert.equal(mailbox.pending.requestCount, 3);
});

test("a stale equal-count pending wakeup cannot overwrite a concurrent mailbox signal", (t) => {
  const { store, task, role } = fixture(t);
  const staleRecovery = mergePendingWakeup(task.id, "task-orphaned", FIRST, null);
  store.transaction((tx) => {
    enqueueWork(
      tx,
      { kind: "role", taskId: task.id, roleName: role.name },
      "operator-input",
      SECOND
    );
  });

  assert.throws(
    () => store.savePendingWakeup(staleRecovery),
    /stale/i
  );
  assert.deepEqual(
    store.getWorkMailbox({
      kind: "role",
      taskId: task.id,
      roleName: role.name
    }).pending.reasons,
    ["operator-input"]
  );
});
