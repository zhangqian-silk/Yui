import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import {
  createSessionNotifyDispatcher,
  parseCodexSessionNotification,
  runSessionNotifyCommand
} from "../../dist/controller/sessionNotify.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import {
  createGlobalRole,
  createRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";

function fixture(t, adapterId = "codex") {
  const home = mkdtempSync(join(tmpdir(), "taskmux-managed-launch-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const now = new Date("2026-07-19T00:00:00.000Z");
  const agent = createConfiguredAgent(
    `${adapterId}-personal`, adapterId, `${adapterId}-test`, [], [], now
  );
  const binding = createRoleAgentBinding(agent);
  const task = activateTask(createTask("task-1", "Managed launch", now), now);
  const role = createRole(task.id, "leader", [binding], agent.id, home, now);
  const globalRole = createGlobalRole("operator", [binding], agent.id, home, now);
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveRole(task.id, role);
    tx.saveGlobalRole(globalRole);
  });
  return { home, store, task, role, globalRole, agent, now };
}

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
  }
  assert.equal(taskPlan.launch.env.TASKMUX_SESSION_SCOPE, "task");
  assert.equal(taskPlan.launch.env.TASKMUX_TASK_ID, task.id);
  assert.equal(globalPlan.launch.env.TASKMUX_SESSION_SCOPE, "global");
  assert.equal(globalPlan.launch.env.TASKMUX_TASK_ID, undefined);
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
  assert.equal(plan.session.nativeSessionId, "claude-native-1");
  assert.equal(plan.launch.args.some((argument) => argument.includes("TaskMux setup:")), false);
});

test("Codex notify payload is strictly converted to an internal fixed session bind", async (t) => {
  const { home, store, task, role, agent } = fixture(t);
  const environment = {
    TASKMUX_HOME: home,
    TASKMUX_SESSION_SCOPE: "task",
    TASKMUX_TASK_ID: task.id,
    TASKMUX_ROLE: role.name,
    TASKMUX_AGENT_ID: agent.id,
    TASKMUX_ADAPTER_ID: "codex"
  };
  const payload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "thread-native-1",
    "turn-id": "turn-1",
    cwd: home,
    "input-messages": [],
    "last-assistant-message": "done"
  });
  assert.equal(
    parseCodexSessionNotification(payload, environment).nativeSessionId,
    "thread-native-1"
  );

  const schedulerStore = new FileSchedulerStoreAdapter(store);
  const dispatch = createSessionNotifyDispatcher(schedulerStore);
  await runSessionNotifyCommand(payload, environment, async (calledHome, method, params) => {
    assert.equal(calledHome, home);
    assert.equal(method, "runtime.session.bind");
    return dispatch(method, params);
  });
  assert.equal(
    store.getRoleSession(task.id, role.name).nativeSessionId,
    "thread-native-1"
  );
  const revision = JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision;
  await runSessionNotifyCommand(payload, environment, async (_home, method, params) => (
    dispatch(method, params)
  ));
  assert.equal(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision, revision);
  const retryPlan = new FileRoleLaunchPlanner(home, store, { cliPath: "/dist/cli.js" }).plan({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    // The durable Run may still say new when Codex notify won the race. The
    // managed planner must recover the fixed thread, not create a second one.
    mode: "new"
  });
  assert.deepEqual(retryPlan.launch.args.slice(-2), ["resume", "thread-native-1"]);
  assert.equal(retryPlan.session.nativeSessionId, "thread-native-1");
  await assert.rejects(
    runSessionNotifyCommand(JSON.stringify({ type: "other", "thread-id": "x" }), environment),
    /payload type is invalid/
  );
});
