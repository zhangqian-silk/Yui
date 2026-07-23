import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createRuntimeLifecycleDispatcher } from "../../dist/controller/runtime.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import {
  parseCodexSessionNotification,
  runSessionNotifyCommand
} from "../../dist/controller/sessionNotify.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import {
  createGlobalRole,
  createRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../../dist/role/role.js";
import {
  createAgentRun,
  markAgentRunDelivered
} from "../../dist/run/agentRun.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import {
  createWorkItem,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";

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

function recordParsedTurnCompletion(schedulerStore, payload, environment) {
  const input = parseCodexSessionNotification(payload, environment);
  assert.equal(input.scope, "task");
  return schedulerStore.recordRuntimeTurnCompleted({
    taskId: input.taskId,
    roleName: input.roleName,
    agentId: input.agentId,
    adapterId: input.adapterId,
    nativeSessionId: input.nativeSessionId,
    turnId: input.turnId,
    summary: input.lastAssistantMessage
  });
}

test("Controller lifecycle dispatcher is the sole session creator for enter", async (t) => {
  const { store, task, role, globalRole } = fixture(t);
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  const starts = [];
  const sessionHost = {
    async start(request) {
      starts.push(request);
      return {
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
  assert.equal(globalPlan.launch.env.YUI_SESSION_SCOPE, "global");
  assert.equal(globalPlan.launch.env.YUI_TASK_ID, undefined);
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
  assert.equal(plan.launch.args.some((argument) => argument.includes("Yui setup:")), false);
  const systemPromptIndex = plan.launch.args.indexOf("--append-system-prompt");
  assert.ok(systemPromptIndex >= 0);
  assert.match(plan.launch.args[systemPromptIndex + 1], /injected yui-leader/);
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

test("Codex notify payload is strictly converted to one durable runtime event", async (t) => {
  const { home, store, task, role, agent } = fixture(t);
  const environment = {
    YUI_HOME: home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: task.id,
    YUI_ROLE: role.name,
    YUI_AGENT_ID: agent.id,
    YUI_ADAPTER_ID: "codex"
  };
  const payload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "thread-native-1",
    "turn-id": "turn-1",
    cwd: home,
    "input-messages": ["Yui-Run-Id: agent-run-native-1\n\nDo the work"],
    "last-assistant-message": "done"
  });
  assert.equal(
    parseCodexSessionNotification(payload, environment).nativeSessionId,
    "thread-native-1"
  );

  await runSessionNotifyCommand(payload, environment, async (calledHome, method, params) => {
    assert.equal(calledHome, home);
    assert.equal(method, "scheduler.signal");
    assert.deepEqual(params, { key: `role:${task.id}/${role.name}` });
    return {};
  });
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
    runId: "agent-run-native-1",
    summary: "done"
  }]);
  const revision = JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision;
  await runSessionNotifyCommand(payload, environment, async () => ({}));
  assert.equal(inbox.list().length, 1);
  assert.equal(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision, revision);
  await assert.rejects(
    runSessionNotifyCommand(JSON.stringify({ type: "other", "thread-id": "x" }), environment),
    /payload type is invalid/
  );
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
    YUI_ADAPTER_ID: "codex"
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
    now
  ), now);
  store.transaction((tx) => {
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    tx.saveRole(task.id, updateRoleStatus(role, "running", now));
    enqueueWork(tx, { kind: "role", taskId: task.id, roleName: role.name }, "task-created", now);
  });
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  schedulerStore.claimWorkMailbox({
    target: { kind: "role", taskId: task.id, roleName: role.name },
    batchId: `agent-run:${run.id}`,
    owner: "controller",
    now,
    executionRef: { type: "run", id: run.id }
  });
  store.transaction((tx) => {
    enqueueWork(tx, { kind: "role", taskId: task.id, roleName: role.name }, "role-result", now, [
      { type: "run", id: run.id }
    ]);
  });

  const environment = {
    YUI_HOME: home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: task.id,
    YUI_ROLE: role.name,
    YUI_AGENT_ID: agent.id,
    YUI_ADAPTER_ID: "codex"
  };
  const payload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "thread-native-1",
    "turn-id": "turn-1",
    cwd: home,
    "input-messages": [],
    "last-assistant-message": "Workers dispatched; waiting for their results."
  });
  recordParsedTurnCompletion(schedulerStore, payload, environment);

  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.equal(store.findAgentRun(run.id).status, "yielded");
  assert.equal(
    store.findAgentRun(run.id).summary,
    "Workers dispatched; waiting for their results."
  );
  assert.equal(store.getRole(task.id, role.name).status, "idle");
  assert.equal(store.getRoleSession(task.id, role.name).status, "ready");
  assert.equal(store.getTask(task.id).status, "active");
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["role-result"]);
  assert.equal(store.listMessages(task.id).filter((message) => message.runId === run.id).length, 1);

  recordParsedTurnCompletion(schedulerStore, payload, environment);
  assert.equal(store.listMessages(task.id).filter((message) => message.runId === run.id).length, 1);
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
    now
  ), now);
  store.transaction((tx) => {
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    tx.saveRole(task.id, updateRoleStatus(role, "running", now));
    enqueueWork(tx, { kind: "role", taskId: task.id, roleName: role.name }, "role-result", now, [
      { type: "run", id: run.id }
    ]);
  });
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  schedulerStore.claimWorkMailbox({
    target: { kind: "role", taskId: task.id, roleName: role.name },
    batchId: `agent-run:${run.id}`,
    owner: "controller",
    now,
    executionRef: { type: "run", id: run.id }
  });
  const environment = {
    YUI_HOME: home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: task.id,
    YUI_ROLE: role.name,
    YUI_AGENT_ID: agent.id,
    YUI_ADAPTER_ID: "codex"
  };
  const payload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "thread-native-1",
    "turn-id": "turn-final",
    cwd: home,
    "input-messages": [],
    "last-assistant-message": "Analysis complete and verified."
  });
  recordParsedTurnCompletion(schedulerStore, payload, environment);

  assert.equal(store.getTask(task.id).status, "active");
  assert.equal(store.getTask(task.id).completionSummary, undefined);
  assert.equal(store.findAgentRun(run.id).status, "yielded");
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["leader-turn-unclosed"]);
});

test("a Worker turn that forgets to yield fails visibly and wakes the Leader", async (t) => {
  const { home, store, task, agent, now } = fixture(t);
  const binding = createRoleAgentBinding(agent);
  const worker = createRole(task.id, "worker", [binding], agent.id, home, now);
  const item = updateWorkItemStatus(createWorkItem(
    "work-item-1",
    task.id,
    { title: "Analyze", assignee: worker.name },
    now
  ), "running", undefined, now);
  const run = markAgentRunDelivered(createAgentRun(
    "agent-run-1",
    task.id,
    worker.name,
    "new",
    "analyze",
    now,
    { workItemId: item.id }
  ), now);
  store.transaction((tx) => {
    tx.saveRole(task.id, updateRoleStatus(worker, "running", now));
    tx.saveWorkItem(task.id, item);
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, { kind: "role", taskId: task.id, roleName: worker.name }, "run-dispatched", now, [
      { type: "run", id: run.id }
    ]);
  });
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  schedulerStore.claimWorkMailbox({
    target: { kind: "role", taskId: task.id, roleName: worker.name },
    batchId: `agent-run:${run.id}`,
    owner: "controller",
    now,
    executionRef: { type: "run", id: run.id }
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
    YUI_ADAPTER_ID: "codex"
  });

  assert.equal(store.findAgentRun(run.id).status, "failed");
  assert.match(store.findAgentRun(run.id).summary, /without yui task run yield/i);
  assert.equal(store.getWorkItem(task.id, item.id).status, "failed");
  assert.equal(store.getActiveAgentRun(task.id, worker.name), null);
  assert.equal(store.getRole(task.id, worker.name).status, "idle");
  assert.equal(store.getRoleSession(task.id, worker.name).status, "ready");
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["role-run-failed"]);
});
