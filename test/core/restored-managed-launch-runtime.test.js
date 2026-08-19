import assert from "node:assert/strict";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import {
  createRuntimeLifecycleDispatcher,
  refreshAppliedTaskRuntimeDescriptor
} from "../../dist/controller/runtime.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import {
  parseCodexSessionNotification,
  runSessionNotifyCommand
} from "../../dist/controller/sessionNotify.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import {
  bindTaskRoleRun,
  clearTaskRoleRun,
  createRoleSessionSet,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import {
  MAX_SESSION_TITLE_LENGTH,
  taskRoleSessionTitle
} from "../../dist/runtime/sessionTitle.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import {
  createGlobalRole,
  createRole,
  createRoleAgentBinding,
  updateRole,
  updateRoleStatus
} from "../../dist/role/role.js";
import {
  markAgentRunDelivered,
  yieldAgentRun
} from "../../dist/run/agentRun.js";
import { createAgentRun } from "../helpers/effectiveLaunch.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import {
  YUI_CONTROL_PLANE_DESCRIPTOR,
  YUI_TASK_RUNTIME_DESCRIPTOR,
  assertExactTaskRuntimeState,
  createExactTaskRuntimeDescriptor,
  exactControlPlaneCommandPrefix,
  parseExactControlPlaneDescriptor,
  readExactTaskRuntimeDescriptorSource,
  refreshReusedTaskRuntimeDescriptorSource,
  serializeExactDescriptor
} from "../../dist/runtime/exactControlPlane.js";
import {
  createWorkItem,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { taskOwnedWorkspace } from "../helpers/taskWorkspace.js";

function fixture(t, adapterId = "codex") {
  const home = mkdtempSync(join(tmpdir(), "yui-managed-launch-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const now = new Date("2026-07-19T00:00:00.000Z");
  const agent = createConfiguredAgent(
    `${adapterId}-personal`, adapterId, `${adapterId}-test`, [], [], now
  );
  const binding = createRoleAgentBinding(agent);
  const task = activateTask(createTask("task-1", "Managed launch", now, {
    cwd: home
  }), now);
  const role = createRole(task.id, "leader", [binding], agent.id, home, now);
  const globalRole = createGlobalRole("operator", [binding], agent.id, home, now);
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveManagedWorkspace(taskOwnedWorkspace(task, now));
    tx.saveRole(task.id, role);
    tx.saveGlobalRole(globalRole);
  });
  return { home, store, task, role, globalRole, agent, now };
}

function recordParsedTurnCompletion(schedulerStore, payload, environment) {
  const input = parseCodexSessionNotification(payload, environment);
  assert.equal(input.scope, "task");
  return schedulerStore.recordRuntimeTurnCompleted({
    taskId: input.taskId,
    roleName: input.roleName,
    agentId: input.agentId,
    adapterId: input.adapterId,
    launchId: input.launchId,
    nativeSessionId: input.nativeSessionId,
    turnId: input.turnId,
    summary: input.lastAssistantMessage
  });
}

test("managed session titles stay compact without losing the role", () => {
  assert.equal(
    taskRoleSessionTitle({ id: "task-123", title: "A task" }, "worker"),
    "Yui · task-123 · worker · A task"
  );
  const title = taskRoleSessionTitle(
    { id: "task-123", title: "A".repeat(300) },
    "leader"
  );
  assert.equal(title.length, MAX_SESSION_TITLE_LENGTH);
  assert.match(title, /^Yui · task-123 · Leader · A+…$/);
});

test("Controller lifecycle dispatcher is the sole session creator for enter", async (t) => {
  const { store, task, role, globalRole } = fixture(t);
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  const starts = [];
  const sessionHost = {
    async start(request) {
      starts.push(request);
      return {
        id: `binding-${starts.length}`,
        launchId: request.launchId,
        owner: request.owner,
        agentId: request.agentId,
        adapterId: request.adapterId,
        hostRef: `host-${starts.length}`,
        hostCreated: true,
        nativeSessionId: request.owner.scope === "task" ? "thread-task" : "thread-global"
      };
    },
    async resume() {
      throw new Error("unexpected resume");
    }
  };
  const dispatch = createRuntimeLifecycleDispatcher(store, schedulerStore, sessionHost);

  await dispatch("runtime.ensure-role-session", {
    scope: "task",
    taskId: task.id,
    roleName: role.name
  });
  await dispatch("runtime.ensure-role-session", {
    scope: "global",
    roleName: globalRole.name
  });

  assert.deepEqual(starts.map(({ owner }) => owner), [
    { scope: "task", taskId: task.id, roleName: role.name },
    { scope: "global", roleName: globalRole.name }
  ]);
  assert.equal(store.getRoleSession(task.id, role.name).nativeSessionId, "thread-task");
  assert.equal(
    store.getGlobalRoleSessionSet(globalRole.name).sessions[globalRole.activeAgentId].nativeSessionId,
    "thread-global"
  );
});

test("Controller ensure refuses to rebind a live opaque Session", async (t) => {
  const { store, task, role, agent, now } = fixture(t);
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  schedulerStore.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: "thread-opaque-host"
  }, now);
  const sessions = store.getTaskRoleSessionSet(task.id, role.name);
  const opaque = { ...sessions.sessions[agent.id] };
  delete opaque.nativeSessionId;
  opaque.launchId = "opaque-launch-1";
  store.saveTaskRoleSessionSet({
    ...sessions,
    sessions: { ...sessions.sessions, [agent.id]: opaque }
  });
  let starts = 0;
  let resumes = 0;
  const dispatch = createRuntimeLifecycleDispatcher(store, schedulerStore, {
    async start() { starts += 1; throw new Error("must not start"); },
    async resume() { resumes += 1; throw new Error("must not resume"); }
  });

  await assert.rejects(
    dispatch("runtime.ensure-role-session", {
      scope: "task",
      taskId: task.id,
      roleName: role.name
    }),
    /no native Session identity/i
  );
  assert.equal(starts, 0);
  assert.equal(resumes, 0);
  assert.equal(
    store.getTaskRoleSessionSet(task.id, role.name).sessions[agent.id].launchId,
    "opaque-launch-1"
  );
});

test("Controller keeps a live Session effective snapshot across desired drift", async (t) => {
  const { store, task, role, agent, now } = fixture(t);
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  schedulerStore.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: "thread-before-desired-drift"
  }, now);
  const immutable = structuredClone(store.getRoleSession(task.id, role.name).effective);
  store.saveRole(task.id, updateRole(role, {
    agentBindings: {
      [agent.id]: createRoleAgentBinding(agent, {
        adapterId: "codex",
        model: "gpt-next"
      })
    }
  }, new Date(now.getTime() + 1)));
  const resumes = [];
  const dispatch = createRuntimeLifecycleDispatcher(store, schedulerStore, {
    async start() { throw new Error("desired drift must not start over a live Session"); },
    async resume(request) {
      resumes.push(request);
      return {
        id: "binding-live-drift",
        launchId: request.launchId,
        owner: request.owner,
        agentId: request.agentId,
        adapterId: request.adapterId,
        hostRef: "host-live-drift",
        hostCreated: false,
        nativeSessionId: request.nativeSessionId
      };
    }
  });

  await dispatch("runtime.ensure-role-session", {
    scope: "task",
    taskId: task.id,
    roleName: role.name
  });

  assert.equal(resumes.length, 1);
  assert.deepEqual(resumes[0].effective, immutable);
  assert.equal(resumes[0].nativeSessionId, "thread-before-desired-drift");
  assert.deepEqual(store.getRoleSession(task.id, role.name).effective, immutable);
});

test("one planner adds Codex structured notify for Task and global launches", (t) => {
  const { home, store, task, role, globalRole, agent } = fixture(t);
  const planner = new FileRoleLaunchPlanner(home, store, { cliPath: "/dist/cli.js" });
  const taskPlan = planner.plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  });
  const globalPlan = planner.planGlobalRole({
    roleName: globalRole.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  });

  for (const plan of [taskPlan, globalPlan]) {
    const notifyIndex = plan.launch.args.findIndex((argument) => argument.startsWith("notify="));
    assert.ok(notifyIndex > 0);
    assert.equal(plan.launch.args[notifyIndex - 1], "--config");
    assert.deepEqual(JSON.parse(plan.launch.args[notifyIndex].slice("notify=".length)), [
      process.execPath, "/dist/cli.js", "internal", "session-notify"
    ]);
    assert.equal(plan.session, null);
    assert.ok(plan.launch.args.some((argument) => argument.startsWith("developer_instructions=")));
    assert.equal(plan.launch.args.some((argument) => argument.startsWith("skills.config=[")), false);
  }
  assert.ok(taskPlan.launch.args.some((argument) => argument.includes("injected yui-leader")));
  assert.ok(taskPlan.launch.args.some((argument) => argument.includes("skills/yui-leader")));
  assert.ok(globalPlan.launch.args.some((argument) => argument.includes("injected yui-operator")));
  assert.ok(globalPlan.launch.args.some((argument) => argument.includes("skills/yui-operator")));
  assert.equal(taskPlan.launch.args.some((argument) => argument === "Yui setup:"), false);
  assert.equal(taskPlan.launch.env.YUI_SESSION_SCOPE, "task");
  assert.equal(taskPlan.launch.env.YUI_TASK_ID, task.id);
  assert.equal(
    taskPlan.launch.env.YUI_SESSION_TITLE,
    "Yui · task-1 · Leader · Managed launch"
  );
  assert.equal(globalPlan.launch.env.YUI_SESSION_SCOPE, "global");
  assert.equal(globalPlan.launch.env.YUI_TASK_ID, undefined);
  assert.equal(globalPlan.launch.env.YUI_SESSION_TITLE, undefined);
  assert.equal(globalPlan.launch.env.YUI_AGENT_COMMAND, undefined);
  assert.equal(globalPlan.launch.env.YUI_AGENT_BASE_ARGS, undefined);
});

test("managed Task launch freezes the exact CLI/Home identity without writing a shared PATH launcher", (t) => {
  const { home, store, task, role, agent } = fixture(t);
  const cliPath = join(home, "current-cli.js");
  writeFileSync(
    cliPath,
    "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), home: process.env.YUI_HOME }));\n",
    { mode: 0o600 }
  );
  const plan = new FileRoleLaunchPlanner(home, store, {
    environment: { PATH: "/old-workspace/bin" },
    cliPath
  }).plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  });

  assert.equal(plan.launch.env.PATH, "/old-workspace/bin");
  assert.equal(existsSync(join(home, "runtime", "bin", "yui")), false);
  const control = parseExactControlPlaneDescriptor(
    plan.launch.env[YUI_CONTROL_PLANE_DESCRIPTOR]
  );
  const runtime = readExactTaskRuntimeDescriptorSource(
    plan.launch.env[YUI_TASK_RUNTIME_DESCRIPTOR],
    home
  );
  assert.equal(control.cliEntry, cliPath);
  assert.equal(control.yuiHome, home);
  assert.equal(runtime.taskId, task.id);
  assert.equal(runtime.roleName, role.name);
  assert.equal(runtime.workspace, plan.role.workspace);
  const command = exactControlPlaneCommandPrefix(control);
  assert.ok(plan.launch.args.some((argument) => (
    argument.startsWith("developer_instructions=")
      && argument.includes(command)
      && argument.includes("Bare `yui`")
  )));
});

test("a replacement Controller cannot retarget an existing Task's exact control plane", (t) => {
  const { home, store, task, role, agent } = fixture(t);
  const oldCli = join(home, "old-cli.js");
  const newCli = join(home, "new-cli.js");
  writeFileSync(oldCli, "process.stdout.write('old');\n", { mode: 0o600 });
  writeFileSync(newCli, "process.stdout.write('new');\n", { mode: 0o600 });

  const input = {
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  };
  const oldPlan = new FileRoleLaunchPlanner(home, store, { cliPath: oldCli }).plan(input);
  const oldControl = parseExactControlPlaneDescriptor(
    oldPlan.launch.env[YUI_CONTROL_PLANE_DESCRIPTOR]
  );

  const newPlan = new FileRoleLaunchPlanner(home, store, { cliPath: newCli }).plan(input);
  const newControl = parseExactControlPlaneDescriptor(
    newPlan.launch.env[YUI_CONTROL_PLANE_DESCRIPTOR]
  );

  assert.equal(oldControl.cliEntry, oldCli);
  assert.equal(newControl.cliEntry, newCli);
  assert.notEqual(
    exactControlPlaneCommandPrefix(oldControl),
    exactControlPlaneCommandPrefix(newControl)
  );
  assert.equal(
    parseExactControlPlaneDescriptor(
      oldPlan.launch.env[YUI_CONTROL_PLANE_DESCRIPTOR]
    ).cliEntry,
    oldCli
  );
  assert.equal(existsSync(join(home, "runtime", "bin", "yui")), false);
});

test("a replacement Controller writes only its current source while the reused Hook self-refreshes its own", (t) => {
  const { home, store, task, role, agent, now } = fixture(t, "claude");
  const oldCli = join(home, "old-cli.js");
  const newCli = join(home, "new-cli.js");
  const historicalCli = join(home, "historical-cli.js");
  writeFileSync(oldCli, "process.stdout.write('old');\n", { mode: 0o600 });
  writeFileSync(newCli, "process.stdout.write('new');\n", { mode: 0o600 });
  writeFileSync(historicalCli, "process.stdout.write('historical');\n", { mode: 0o600 });
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  const oldPlanner = new FileRoleLaunchPlanner(home, store, { cliPath: oldCli });
  const oldPlan = oldPlanner.plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    effective,
    mode: "new",
    launchId: "launch-1"
  });
  const oldSource = oldPlan.launch.env[YUI_TASK_RUNTIME_DESCRIPTOR];
  const oldDescriptor = readExactTaskRuntimeDescriptorSource(oldSource, home);
  const currentNativeSessionId = oldPlan.session.nativeSessionId;
  writeFileSync(oldSource, `${serializeExactDescriptor(createExactTaskRuntimeDescriptor({
    ...oldDescriptor,
    runId: "agent-run-1",
    launchId: "launch-old",
    nativeSessionId: currentNativeSessionId
  }))}\n`);
  const oldBytes = readFileSync(oldSource);
  const historicalPlan = new FileRoleLaunchPlanner(home, store, {
    cliPath: historicalCli
  }).plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    effective,
    mode: "new",
    launchId: "historical-launch"
  });
  const historicalSource = historicalPlan.launch.env[YUI_TASK_RUNTIME_DESCRIPTOR];
  const historicalDescriptor = createExactTaskRuntimeDescriptor({
    ...readExactTaskRuntimeDescriptorSource(historicalSource, home),
    runId: "agent-run-1",
    launchId: "historical-launch",
    nativeSessionId: "historical-native"
  });
  writeFileSync(historicalSource, `${serializeExactDescriptor(historicalDescriptor)}\n`);
  const historicalBytes = readFileSync(historicalSource);
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  }, agent.id, now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: currentNativeSessionId,
    launchId: "launch-current",
    policy: "fixed",
    status: "running",
    effective
  }, now);
  sessions = bindTaskRoleRun(sessions, {
    agentId: agent.id,
    runId: "agent-run-2",
    receiptId: `agent-run:${task.id}/agent-run-2`
  }, new Date(now.getTime() + 1));
  const resumedRun = createAgentRun(
    "agent-run-2",
    task.id,
    role.name,
    "resume",
    "continue the fixed Session",
    new Date(now.getTime() + 1),
    { effective }
  );
  store.transaction((tx) => {
    tx.saveActiveAgentRun(resumedRun);
    tx.saveTaskRoleSessionSet(sessions);
  });

  new FileRoleLaunchPlanner(home, store, { cliPath: newCli })
    .refreshTaskRuntimeDescriptor({
      taskId: task.id,
      roleName: role.name,
      runId: resumedRun.id,
      launchId: "launch-current",
      nativeSessionId: currentNativeSessionId,
      agentId: agent.id,
      adapterId: agent.adapterId,
      workspace: effective.workspace.root
    });

  // The Controller writes only its current-control source; the reused pane's
  // original source is untouched until its own Hook self-refreshes.
  assert.deepEqual(readFileSync(oldSource), oldBytes);
  assert.deepEqual(readFileSync(historicalSource), historicalBytes);

  const reused = refreshReusedTaskRuntimeDescriptorSource(oldSource, home, store, {
    runId: resumedRun.id,
    launchId: "launch-current",
    nativeSessionId: currentNativeSessionId
  });
  assert.equal(reused.runId, "agent-run-2");
  assert.equal(reused.launchId, "launch-current");
  assert.equal(reused.nativeSessionId, currentNativeSessionId);
  assert.equal(
    reused.controlPlaneDigest,
    oldDescriptor.controlPlaneDigest
  );
  assert.deepEqual(readExactTaskRuntimeDescriptorSource(oldSource, home), reused);
  assert.throws(
    () => assertExactTaskRuntimeState(
      readExactTaskRuntimeDescriptorSource(historicalSource, home),
      store
    ),
    /not current/i
  );
});

test("applied runtime refresh uses the exact active generation, rejects drift, and skips terminal Runs", (t) => {
  const { home, store, task, role, agent, now } = fixture(t, "claude");
  const cli = join(home, "generation-fence-cli.js");
  writeFileSync(cli, "process.stdout.write('fenced');\n", { mode: 0o600 });
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  const planner = new FileRoleLaunchPlanner(home, store, { cliPath: cli });
  const planA = planner.plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    effective,
    mode: "new",
    launchId: "launch-a"
  });
  const source = planA.launch.env[YUI_TASK_RUNTIME_DESCRIPTOR];
  const nativeSessionId = planA.session.nativeSessionId;
  writeFileSync(source, `${serializeExactDescriptor(createExactTaskRuntimeDescriptor({
    ...readExactTaskRuntimeDescriptorSource(source, home),
    runId: "agent-run-1",
    launchId: "launch-a",
    nativeSessionId
  }))}\n`);
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  }, agent.id, now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId,
    launchId: "launch-a",
    policy: "fixed",
    status: "running",
    effective
  }, now);
  sessions = bindTaskRoleRun(sessions, {
    agentId: agent.id,
    runId: "agent-run-1",
    receiptId: `agent-run:${task.id}/agent-run-1`
  }, now);
  const runA = createAgentRun(
    "agent-run-1",
    task.id,
    role.name,
    "resume",
    "applied generation",
    now,
    { effective }
  );
  store.transaction((tx) => {
    tx.saveTaskRoleSessionSet(sessions);
    tx.saveActiveAgentRun(runA);
  });

  const applied = {
    taskId: task.id,
    roleName: role.name,
    runId: "agent-run-1",
    launchId: "launch-a",
    nativeSessionId,
    agentId: agent.id,
    adapterId: agent.adapterId
  };
  const refreshes = [];
  refreshAppliedTaskRuntimeDescriptor(store, {
    refreshTaskRuntimeDescriptor(input) {
      refreshes.push(input);
      planner.refreshTaskRuntimeDescriptor(input);
    }
  }, applied);
  assert.deepEqual(refreshes, [{
    ...applied,
    workspace: effective.workspace.root
  }]);
  const bytesA = readFileSync(source);

  const runB = createAgentRun(
    "agent-run-2",
    task.id,
    role.name,
    "resume",
    "current generation",
    new Date(now.getTime() + 1),
    { effective }
  );
  sessions = clearTaskRoleRun(sessions, {
    agentId: agent.id,
    runId: runA.id,
    receiptId: `agent-run:${task.id}/${runA.id}`
  }, new Date(now.getTime() + 1));
  sessions = bindTaskRoleRun(sessions, {
    agentId: agent.id,
    runId: runB.id,
    receiptId: `agent-run:${task.id}/${runB.id}`
  }, new Date(now.getTime() + 1));
  store.transaction((tx) => {
    tx.clearActiveAgentRun(task.id, role.name);
    tx.saveTaskRoleSessionSet(sessions);
    tx.saveActiveAgentRun(runB);
  });

  assert.throws(
    () => refreshAppliedTaskRuntimeDescriptor(store, planner, applied),
    /Prepared Task runtime generation is not current/i
  );
  assert.deepEqual(readFileSync(source), bytesA);

  store.saveAgentRun(yieldAgentRun(runA, "terminal completion applied", new Date(now.getTime() + 2)));
  let terminalRefreshes = 0;
  assert.doesNotThrow(() => refreshAppliedTaskRuntimeDescriptor(store, {
    refreshTaskRuntimeDescriptor() { terminalRefreshes += 1; }
  }, applied));
  assert.equal(terminalRefreshes, 0);
  assert.deepEqual(readFileSync(source), bytesA);
});

test("a Task Session without an active Run refreshes its exact native generation", (t) => {
  const { home, store, task, role, agent, now } = fixture(t, "claude");
  const cli = join(home, "no-run-cli.js");
  writeFileSync(cli, "process.stdout.write('no-run');\n", { mode: 0o600 });
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  const planner = new FileRoleLaunchPlanner(home, store, { cliPath: cli });
  const plan = planner.plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    effective,
    mode: "new",
    launchId: "launch-no-run"
  });
  const source = plan.launch.env[YUI_TASK_RUNTIME_DESCRIPTOR];
  const nativeSessionId = plan.session.nativeSessionId;
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  }, agent.id, now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId,
    launchId: "launch-no-run",
    policy: "fixed",
    status: "running",
    effective
  }, now);
  store.saveTaskRoleSessionSet(sessions);

  assert.doesNotThrow(() => refreshAppliedTaskRuntimeDescriptor(store, planner, {
    taskId: task.id,
    roleName: role.name,
    launchId: "launch-no-run",
    nativeSessionId,
    agentId: agent.id,
    adapterId: agent.adapterId
  }));
  const refreshed = readExactTaskRuntimeDescriptorSource(source, home);
  assert.equal(refreshed.runId, undefined);
  assert.equal(refreshed.launchId, "launch-no-run");
  assert.equal(refreshed.nativeSessionId, nativeSessionId);
});

test("managed Codex Task Run installs lifecycle hooks while native identity remains provider-discovered", (t) => {
  const { home, store, task, role, agent, now } = fixture(t);
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  store.saveActiveAgentRun(createAgentRun(
    "agent-run-1",
    task.id,
    role.name,
    "new",
    "test hooks",
    now,
    { effective }
  ));
  const plan = new FileRoleLaunchPlanner(home, store, { cliPath: "/dist/cli.js" }).plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new",
    runId: "agent-run-1",
    launchId: "launch-1",
    effective
  });

  assert.equal(plan.session, null);
  assert.equal(plan.launch.env.YUI_RUN_ID, "agent-run-1");
  assert.equal(plan.launch.env.YUI_LAUNCH_ID, "launch-1");
  assert.equal(plan.launch.env.YUI_NATIVE_SESSION_ID, undefined);
  const hooksIndex = plan.launch.args.indexOf("--enable");
  assert.deepEqual(
    plan.launch.args.slice(hooksIndex, hooksIndex + 4),
    [
      "--enable",
      "hooks",
      "--config",
      "hooks={SessionStart=[{hooks=[{type=\"command\",command=\"'"
        + `${process.execPath}' '/dist/cli.js' internal codex-hook\"}]}],`
        + "UserPromptSubmit=[{hooks=[{type=\"command\",command=\"'"
        + `${process.execPath}' '/dist/cli.js' internal codex-hook\"}]}]}`
    ]
  );
  assert.ok(plan.launch.args.includes("--dangerously-bypass-hook-trust"));
  assert.equal(plan.launch.args.at(-2), "--");
  assert.equal(plan.launch.args.at(-1), "test hooks");
  assert.equal(plan.initialPromptRunId, "agent-run-1");
  assert.ok(plan.launch.args.includes(
    `projects={${JSON.stringify(home)}={trust_level="trusted"}}`
  ));
});

test("managed Codex resume submits the exact first Run prompt after the native session id", (t) => {
  const { home, store, task, role, agent, now } = fixture(t);
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  }, agent.id, now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: "codex-existing",
    policy: "fixed",
    status: "ready",
    effective
  }, now);
  store.saveTaskRoleSessionSet(sessions);
  store.saveActiveAgentRun(createAgentRun(
    "agent-run-1",
    task.id,
    role.name,
    "resume",
    "-prompt that begins like an option",
    now,
    { effective }
  ));

  const plan = new FileRoleLaunchPlanner(home, store, { cliPath: "/dist/cli.js" }).plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "resume",
    runId: "agent-run-1",
    launchId: "launch-1",
    nativeSessionId: "codex-existing",
    effective
  });

  assert.deepEqual(
    plan.launch.args.slice(-4),
    ["resume", "codex-existing", "--", "-prompt that begins like an option"]
  );
  assert.equal(plan.initialPromptRunId, "agent-run-1");
});

test("managed Codex launch refuses to replace an existing native notify callback", (t) => {
  const { home, store, task, role, agent } = fixture(t);
  const codexHome = join(home, "native-codex");
  mkdirSync(codexHome);
  writeFileSync(
    join(codexHome, "config.toml"),
    'notify = ["existing-notifier"]\n',
    { mode: 0o600 }
  );
  const planner = new FileRoleLaunchPlanner(home, store, {
    environment: { CODEX_HOME: codexHome },
    cliPath: "/dist/cli.js"
  });

  assert.throws(() => planner.plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  }), /notify.*already configured.*exclusive ownership/i);
});

test("Claude new launch is preallocated once and persisted without a prompt", (t) => {
  const { home, store, task, role, agent } = fixture(t, "claude");
  const planner = new FileRoleLaunchPlanner(home, store, {
    createNativeSessionId: () => "claude-native-1"
  });
  const plan = planner.plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  });

  assert.deepEqual(plan.launch.args.slice(-2), ["--session-id", "claude-native-1"]);
  assert.deepEqual(
    plan.launch.args.slice(plan.launch.args.indexOf("--name"), plan.launch.args.indexOf("--name") + 2),
    ["--name", "Yui · task-1 · Leader · Managed launch"]
  );
  assert.equal(plan.session.nativeSessionId, "claude-native-1");
  assert.equal(plan.launch.args.some((argument) => argument.includes("Yui setup:")), false);
  const systemPromptIndex = plan.launch.args.indexOf("--append-system-prompt-file");
  assert.ok(systemPromptIndex >= 0);
  const contextFile = plan.launch.args[systemPromptIndex + 1];
  assert.match(contextFile, /runtime\/session-contexts\/[a-f0-9]+\.md$/);
  assert.match(readFileSync(contextFile, "utf8"), /injected yui-leader/);
  assert.equal(statSync(contextFile).mode & 0o777, 0o600);
});

test("Claude resume preserves a user-renamed native session", (t) => {
  const { home, store, task, role, agent, now } = fixture(t, "claude");
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  }, agent.id, now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: "claude-existing",
    policy: "fixed",
    status: "ready",
    effective: resolveEffectiveLaunch({ role, purpose: "execution" })
  }, now);
  store.saveTaskRoleSessionSet(sessions);
  const planner = new FileRoleLaunchPlanner(home, store);
  const plan = planner.plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "resume",
    nativeSessionId: "claude-existing"
  });

  assert.equal(plan.launch.args.includes("--name"), false);
  assert.deepEqual(plan.launch.args.slice(-2), ["--resume", "claude-existing"]);
});

test("an incompatible stopped Session cannot turn a new Run into a native resume", (t) => {
  const { home, store, task, role, agent, now } = fixture(t, "claude");
  const previous = resolveEffectiveLaunch({ role, purpose: "execution" });
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  }, agent.id, now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: "claude-stopped-old",
    policy: "fixed",
    status: "stopped",
    effective: previous
  }, now);
  store.saveTaskRoleSessionSet(sessions);

  const effective = { ...previous, model: "claude-next" };
  const run = createAgentRun(
    "agent-run-1",
    task.id,
    role.name,
    "new",
    "Use the new effective snapshot",
    now,
    { effective }
  );
  store.saveAgentRun(run);
  store.saveActiveAgentRun(run);
  const plan = new FileRoleLaunchPlanner(home, store, {
    createNativeSessionId: () => "claude-native-new"
  }).plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    effective,
    mode: "new"
  });

  assert.equal(plan.launch.args.includes("--resume"), false);
  assert.deepEqual(plan.launch.args.slice(-2), ["--session-id", "claude-native-new"]);
  assert.equal(plan.session.nativeSessionId, "claude-native-new");
});

test("planner resumes a live Session with its immutable effective snapshot after desired drift", (t) => {
  const { home, store, task, role, agent, now } = fixture(t, "claude");
  const immutable = resolveEffectiveLaunch({ role, purpose: "execution" });
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  }, agent.id, now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: "claude-live-before-drift",
    policy: "fixed",
    status: "ready",
    effective: immutable
  }, now);
  store.saveTaskRoleSessionSet(sessions);
  store.saveRole(task.id, updateRole(role, {
    agentBindings: {
      [agent.id]: createRoleAgentBinding(agent, {
        adapterId: "claude",
        model: "claude-next"
      })
    }
  }, new Date(now.getTime() + 1)));

  const plan = new FileRoleLaunchPlanner(home, store).plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    effective: immutable,
    mode: "resume",
    nativeSessionId: "claude-live-before-drift"
  });

  assert.deepEqual(plan.session.effective, immutable);
  assert.deepEqual(plan.launch.args.slice(-2), ["--resume", "claude-live-before-drift"]);
  assert.equal(plan.launch.args.includes("claude-next"), false);
});

test("Claude global Operator keeps its native conversation title", (t) => {
  const { home, store, globalRole, agent } = fixture(t, "claude");
  const planner = new FileRoleLaunchPlanner(home, store, {
    createNativeSessionId: () => "claude-operator-native-1"
  });
  const plan = planner.planGlobalRole({
    roleName: globalRole.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  });

  assert.equal(plan.launch.args.includes("--name"), false);
  assert.equal(plan.launch.env.YUI_SESSION_TITLE, undefined);
  assert.deepEqual(
    plan.launch.args.slice(-2),
    ["--session-id", "claude-operator-native-1"]
  );
});

test("Claude launch identity is deterministic for one durable launch across retries", (t) => {
  const { home, store, task, role, agent } = fixture(t, "claude");
  const planner = new FileRoleLaunchPlanner(home, store, {
    createNativeSessionId: () => { throw new Error("durable launch must not allocate randomly"); }
  });
  const input = {
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new",
    launchId: "durable-agent-run-1"
  };

  const first = planner.plan(input);
  const retry = planner.plan(input);

  assert.equal(first.session.nativeSessionId, retry.session.nativeSessionId);
  assert.deepEqual(first.launch.args.slice(-2), ["--session-id", first.session.nativeSessionId]);
});

test("managed Claude Task Runs inject the lifecycle hooks and exact explicit-yield access", (t) => {
  const { home, store, task, role, agent, now } = fixture(t, "claude");
  const controlledRole = createRole(
    task.id,
    role.name,
    [createRoleAgentBinding(agent, {
      adapterId: "claude",
      permission: {
        strategy: "configured",
        mode: "dontAsk",
        allowedTools: [
          "Read",
          "Bash(yui task run yield *)",
          "Bash(yui --json task context *)",
          "Bash(yui:*)"
        ]
      }
    })],
    agent.id,
    role.workspace,
    now
  );
  const item = updateWorkItemStatus(createWorkItem(
    "work-item-1",
    task.id,
    { title: "Exact Claude result", assignee: role.name },
    now
  ), "running", now);
  const effective = resolveEffectiveLaunch({
    role: controlledRole,
    purpose: "execution"
  });
  const run = createAgentRun(
    "agent-run-1",
    task.id,
    role.name,
    "new",
    "Return the exact result",
    now,
    {
      workItemId: item.id,
      effective
    }
  );
  store.transaction((tx) => {
    tx.saveRole(task.id, controlledRole);
    tx.saveWorkItem(task.id, item);
    tx.saveActiveAgentRun(run);
  });
  const plan = new FileRoleLaunchPlanner(home, store, { cliPath: "/dist/cli.js" }).plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new",
    runId: run.id,
    launchId: "launch-1",
    effective: run.effective
  });

  const pluginIndex = plan.launch.args.indexOf("--plugin-dir");
  assert.ok(pluginIndex >= 0);
  const pluginRoot = plan.launch.args[pluginIndex + 1];
  assert.ok(pluginRoot.startsWith(join(home, "runtime")));
  const hooks = JSON.parse(readFileSync(join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(
    Object.keys(hooks.hooks).sort(),
    ["PostToolUse", "SessionStart", "StopFailure", "UserPromptSubmit"]
  );
  for (const eventKey of ["SessionStart", "UserPromptSubmit", "PostToolUse", "StopFailure"]) {
    const command = hooks.hooks[eventKey][0].hooks[0];
    assert.equal(command.command, process.execPath, eventKey);
    assert.deepEqual(command.args, ["/dist/cli.js", "internal", "claude-hook"], eventKey);
  }
  assert.equal(plan.launch.env.YUI_RUN_ID, run.id);
  assert.equal(plan.launch.env.YUI_LAUNCH_ID, "launch-1");
  assert.equal(plan.launch.env.YUI_NATIVE_SESSION_ID, plan.session.nativeSessionId);
  const allowedIndex = plan.launch.args.indexOf("--allowed-tools");
  assert.ok(allowedIndex >= 0);
  const allowed = plan.launch.args.slice(allowedIndex + 1, pluginIndex);
  const exact = exactControlPlaneCommandPrefix(parseExactControlPlaneDescriptor(
    plan.launch.env[YUI_CONTROL_PLANE_DESCRIPTOR]
  ));
  assert.ok(allowed.includes(`Bash(${exact} --json task context ${task.id})`));
  assert.ok(allowed.includes(`Bash(${exact} --json task work list ${task.id})`));
  assert.ok(allowed.includes(`Bash(${exact} --json task work show ${item.id})`));
  assert.ok(allowed.includes(
    `Bash(${exact} task run yield ${run.id} --summary-file -:*)`
  ));
  assert.ok(!allowed.some((rule) => rule.startsWith("Bash(yui")));
  assert.ok(!allowed.includes("Bash(yui task run yield *)"));
  assert.ok(!allowed.includes("Bash(yui --json task context *)"));
  assert.ok(!allowed.includes("Bash(yui:*)"));
  assert.equal(plan.launch.command, process.execPath);
  assert.deepEqual(plan.launch.args.slice(0, 4), [
    "/dist/cli.js", "internal", "managed-claude-run", "--"
  ]);
  const providerArgs = plan.launch.args.slice(5);
  assert.equal(plan.launch.args[4], "claude-test");
  assert.ok(providerArgs.includes("-p"));
  assert.deepEqual(
    providerArgs.slice(providerArgs.indexOf("--output-format"), providerArgs.indexOf("--output-format") + 2),
    ["--output-format", "stream-json"]
  );
  assert.deepEqual(
    providerArgs.slice(providerArgs.indexOf("--input-format"), providerArgs.indexOf("--input-format") + 2),
    ["--input-format", "stream-json"]
  );
  assert.ok(providerArgs.includes("--verbose"));
  assert.equal(plan.launch.args.includes(run.input), false);
  assert.equal(plan.initialPromptRunId, run.id);
});

test("Codex notify payload is strictly converted to one durable runtime event", async (t) => {
  const { home, store, task, role, agent, now } = fixture(t);
  store.saveAgentRun(createAgentRun(
    "agent-run-1",
    task.id,
    role.name,
    "new",
    "Do the work",
    now,
    { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }
  ));
  const environment = {
    YUI_HOME: home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: task.id,
    YUI_ROLE: role.name,
    YUI_AGENT_ID: agent.id,
    YUI_ADAPTER_ID: "codex",
    YUI_LAUNCH_ID: "launch-notify-strict",
    YUI_SESSION_TITLE: "Yui · task-1 · Leader · Managed launch",
    YUI_AGENT_COMMAND: "codex-test",
    YUI_AGENT_BASE_ARGS: "[\"--profile\",\"test\"]"
  };
  const payload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "thread-native-1",
    "turn-id": "turn-1",
    cwd: home,
    "input-messages": [
      "Yui · task-1 · Leader · Managed launch · Run agent-run-1\n\nDo the work"
    ],
    "last-assistant-message": "done"
  });
  assert.equal(
    parseCodexSessionNotification(payload, environment).nativeSessionId,
    "thread-native-1"
  );

  const names = [];
  await runSessionNotifyCommand(
    payload,
    environment,
    async (calledHome, method, params) => {
      assert.equal(calledHome, home);
      assert.equal(method, "scheduler.signal");
      assert.deepEqual(params, { key: `role:${task.id}/${role.name}` });
      return {};
    },
    async (request) => { names.push(request); }
  );
  assert.deepEqual(names, [{
    command: "codex-test",
    baseArgs: ["--profile", "test"],
    environment,
    threadId: "thread-native-1",
    name: "Yui · task-1 · Leader · Managed launch"
  }]);
  const inbox = new FileRuntimeEventInbox(home);
  assert.deepEqual(inbox.list().map((event) => ({
    scope: event.scope,
    taskId: event.taskId,
    roleName: event.roleName,
    nativeSessionId: event.nativeSessionId,
    turnId: event.turnId,
    runId: event.runId,
    summary: event.summary
  })), [{
    scope: "task",
    taskId: task.id,
    roleName: role.name,
    nativeSessionId: "thread-native-1",
    turnId: "turn-1",
    runId: "agent-run-1",
    summary: "done"
  }]);
  const revision = JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision;
  await runSessionNotifyCommand(
    payload,
    environment,
    async () => ({}),
    async (request) => { names.push(request); }
  );
  assert.equal(names.length, 1);
  assert.equal(inbox.list().length, 1);
  assert.equal(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision, revision);
  await assert.rejects(
    runSessionNotifyCommand(JSON.stringify({ type: "other", "thread-id": "x" }), environment),
    /payload type is invalid/
  );
});

test("Codex global Operator keeps the native title from its first user message", async (t) => {
  const { home, globalRole, agent } = fixture(t);
  const environment = {
    YUI_HOME: home,
    YUI_SESSION_SCOPE: "global",
    YUI_ROLE: globalRole.name,
    YUI_AGENT_ID: agent.id,
    YUI_ADAPTER_ID: "codex",
    YUI_LAUNCH_ID: "launch-operator-native"
  };
  const payload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "thread-operator-native",
    "turn-id": "turn-operator-native",
    cwd: home,
    "input-messages": ["Plan the next release"],
    "last-assistant-message": "I created the plan."
  });
  const names = [];

  await runSessionNotifyCommand(
    payload,
    environment,
    async () => ({}),
    async (request) => { names.push(request); }
  );

  assert.deepEqual(names, []);
  const [event] = new FileRuntimeEventInbox(home).list();
  assert.equal(event.scope, "global");
  assert.equal(event.title, "Plan the next release");
});

test("Codex notify remains queued when the Controller is offline", async (t) => {
  const { home, store, task, role, agent } = fixture(t);
  await runSessionNotifyCommand(JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "thread-offline",
    "turn-id": "turn-offline",
    cwd: home,
    "input-messages": [],
    "last-assistant-message": "done"
  }), {
    YUI_HOME: home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: task.id,
    YUI_ROLE: role.name,
    YUI_AGENT_ID: agent.id,
    YUI_ADAPTER_ID: "codex",
    YUI_LAUNCH_ID: "launch-offline"
  });

  assert.equal(store.getRoleSession(task.id, role.name), null);
  const [event] = new FileRuntimeEventInbox(home).list();
  assert.equal(event.nativeSessionId, "thread-offline");
  assert.equal(event.turnId, "turn-offline");
});

test("Codex turn completion releases a forgotten Leader active fence exactly once", async (t) => {
  const { home, store, task, role, agent, now } = fixture(t);
  const run = markAgentRunDelivered(createAgentRun(
    "agent-run-1",
    task.id,
    role.name,
    "new",
    "dispatch workers",
    now,
    { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }
  ), now);
  store.transaction((tx) => {
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    tx.saveRole(task.id, updateRoleStatus(role, "running", now));
    enqueueWork(tx, { kind: "role", taskId: task.id, roleName: role.name }, "task-created", now);
  });
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  schedulerStore.reserveRuntimeLaunch({
    owner: { scope: "task", taskId: task.id, roleName: role.name },
    launchId: "launch-leader-turn"
  }, () => {}, now);
  schedulerStore.claimWorkMailbox({
    target: { kind: "role", taskId: task.id, roleName: role.name },
    batchId: `agent-run:${run.id}`,
    owner: "controller",
    now,
    executionRef: { type: "run", taskId: task.id, id: run.id }
  });
  store.transaction((tx) => {
    enqueueWork(tx, { kind: "role", taskId: task.id, roleName: role.name }, "role-result", now, [
      { type: "run", taskId: task.id, id: run.id }
    ]);
  });

  const environment = {
    YUI_HOME: home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: task.id,
    YUI_ROLE: role.name,
    YUI_AGENT_ID: agent.id,
    YUI_ADAPTER_ID: "codex",
    YUI_LAUNCH_ID: "launch-leader-turn"
  };
  const payload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "thread-native-1",
    "turn-id": "turn-1",
    cwd: home,
    "input-messages": [],
    "last-assistant-message": "Workers dispatched; waiting for their results."
  });
  const messagesBeforeCompletion = store.listMessages(task.id);
  recordParsedTurnCompletion(schedulerStore, payload, environment);

  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.equal(store.getAgentRun(task.id, run.id).status, "yielded");
  assert.equal(
    store.getAgentRun(task.id, run.id).summary,
    "Workers dispatched; waiting for their results."
  );
  assert.equal(store.getRole(task.id, role.name).status, "idle");
  assert.equal(store.getRoleSession(task.id, role.name).status, "ready");
  assert.equal(store.getTask(task.id).status, "active");
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["role-result"]);
  assert.deepEqual(store.listMessages(task.id), messagesBeforeCompletion);

  recordParsedTurnCompletion(schedulerStore, payload, environment);
  assert.deepEqual(store.listMessages(task.id), messagesBeforeCompletion);
  assert.equal(store.getRoleSession(task.id, role.name).status, "ready");
});

test("a quiescent result-driven Leader turn queues recovery when the Agent forgets", async (t) => {
  const { home, store, task, role, agent, now } = fixture(t);
  const run = markAgentRunDelivered(createAgentRun(
    "agent-run-1",
    task.id,
    role.name,
    "new",
    "synthesize worker results",
    now,
    { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }
  ), now);
  store.transaction((tx) => {
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    tx.saveRole(task.id, updateRoleStatus(role, "running", now));
    enqueueWork(tx, { kind: "role", taskId: task.id, roleName: role.name }, "role-result", now, [
      { type: "run", taskId: task.id, id: run.id }
    ]);
  });
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  schedulerStore.reserveRuntimeLaunch({
    owner: { scope: "task", taskId: task.id, roleName: role.name },
    launchId: "launch-final-turn"
  }, () => {}, now);
  schedulerStore.claimWorkMailbox({
    target: { kind: "role", taskId: task.id, roleName: role.name },
    batchId: `agent-run:${run.id}`,
    owner: "controller",
    now,
    executionRef: { type: "run", taskId: task.id, id: run.id }
  });
  const environment = {
    YUI_HOME: home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: task.id,
    YUI_ROLE: role.name,
    YUI_AGENT_ID: agent.id,
    YUI_ADAPTER_ID: "codex",
    YUI_LAUNCH_ID: "launch-final-turn"
  };
  const payload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "thread-native-1",
    "turn-id": "turn-final",
    cwd: home,
    "input-messages": [],
    "last-assistant-message": "Analysis complete and verified."
  });
  const messagesBeforeCompletion = store.listMessages(task.id);
  recordParsedTurnCompletion(schedulerStore, payload, environment);

  assert.equal(store.getTask(task.id).status, "active");
  assert.equal(store.getTask(task.id).completionSummary, undefined);
  assert.equal(store.getAgentRun(task.id, run.id).status, "yielded");
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["leader-turn-unclosed"]);
  assert.deepEqual(store.listMessages(task.id), messagesBeforeCompletion);
});

test("a Worker turn that forgets to yield fails visibly and wakes the Leader", async (t) => {
  const { home, store, task, agent, now } = fixture(t);
  const binding = createRoleAgentBinding(agent);
  const worker = createRole(task.id, "worker", [binding], agent.id, home, now);
  const item = updateWorkItemStatus(createWorkItem(
    "work-item-1",
    task.id,
    { title: "Analyze" },
    now
  ), "running", now);
  const run = markAgentRunDelivered(createAgentRun(
    "agent-run-1",
    task.id,
    worker.name,
    "new",
    "analyze",
    now,
    {
      workItemId: item.id,
      effective: resolveEffectiveLaunch({
        role: worker,
        purpose: "execution",
        workItemWriteProjectIds: item.writeProjectIds
      })
    }
  ), now);
  store.transaction((tx) => {
    tx.saveRole(task.id, updateRoleStatus(worker, "running", now));
    tx.saveWorkItem(task.id, item);
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, { kind: "role", taskId: task.id, roleName: worker.name }, "run-dispatched", now, [
      { type: "run", taskId: task.id, id: run.id }
    ]);
  });
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  schedulerStore.reserveRuntimeLaunch({
    owner: { scope: "task", taskId: task.id, roleName: worker.name },
    launchId: "launch-worker-turn"
  }, () => {}, now);
  schedulerStore.claimWorkMailbox({
    target: { kind: "role", taskId: task.id, roleName: worker.name },
    batchId: `agent-run:${run.id}`,
    owner: "controller",
    now,
    executionRef: { type: "run", taskId: task.id, id: run.id }
  });
  const payload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "thread-worker-1",
    "turn-id": "turn-worker-1",
    cwd: home,
    "input-messages": [],
    "last-assistant-message": "I returned without calling Yui yield."
  });
  recordParsedTurnCompletion(schedulerStore, payload, {
    YUI_HOME: home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: task.id,
    YUI_ROLE: worker.name,
    YUI_AGENT_ID: agent.id,
    YUI_ADAPTER_ID: "codex",
    YUI_LAUNCH_ID: "launch-worker-turn"
  });

  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.match(store.getAgentRun(task.id, run.id).summary, /without yui task run yield/i);
  assert.equal(store.getWorkItem(task.id, item.id).status, "failed");
  assert.equal(store.getActiveAgentRun(task.id, worker.name), null);
  assert.equal(store.getRole(task.id, worker.name).status, "idle");
  assert.equal(store.getRoleSession(task.id, worker.name).status, "ready");
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["role-run-failed"]);
});
