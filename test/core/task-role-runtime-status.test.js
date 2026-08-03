import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  declareTaskRoleSessionUnusable,
  markTaskRoleRunDelivered
} from "../../dist/executor/agentExecutor.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { createInputRequest } from "../../dist/input/inputRequest.js";
import {
  createGlobalRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../../dist/role/role.js";
import { createAgentRun, recordRoleAgentSession } from "../helpers/effectiveLaunch.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { updateWorkItemStatus } from "../../dist/workItem/workItem.js";
import {
  yuiTmuxTarget,
  TmuxManager
} from "../../dist/tmux/tmuxManager.js";
import { CommandExecutionError } from "../../dist/tmux/commandExecutor.js";

const NOW = new Date("2026-07-21T12:00:00.000Z");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-role-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const codex = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: codex.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(codex);
    const leader = createGlobalRole(
      "leader",
      [createRoleAgentBinding(codex)],
      codex.id,
      root,
      NOW
    );
    tx.saveGlobalRole(leader);
    tx.saveGlobalRole(createGlobalRole(
      "worker",
      [createRoleAgentBinding(codex)],
      codex.id,
      root,
      NOW
    ));
  });
  const paneReads = [];
  const runtime = {
    notifyStateChanged() {},
    reconcileTask() {},
    prepareTaskRoleEnter() {},
    inspectTaskRolePanes(taskId) {
      paneReads.push(taskId);
      return [{
        taskId,
        roleName: "worker",
        target: `${taskId}:worker`,
        dead: false,
        pid: 4321,
        currentCommand: "codex"
      }];
    }
  };
  const options = { runtime, now: () => new Date(NOW) };
  return { root, store, options, paneReads };
}

function execute(args, store, options) {
  const result = runTaskCommand(args, store, options);
  assert.equal(result.kind, "output");
  return result;
}

function dispatchTestRun(store, taskId, roleName, workItemId) {
  const role = store.getRole(taskId, roleName);
  const item = store.getWorkItem(taskId, workItemId);
  const run = createAgentRun(
    store.nextAgentRunId(taskId),
    taskId,
    roleName,
    "new",
    "test run",
    NOW,
    { workItemId }
  );
  store.transaction((tx) => {
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    tx.saveRole(taskId, updateRoleStatus(role, "running", NOW));
    tx.saveWorkItem(taskId, updateWorkItemStatus(item, "running", NOW));
  });
  return run;
}

function recordPendingSessionRetirement(store, taskId, roleName, run) {
  const role = store.getRole(taskId, roleName);
  let sessions = createRoleSessionSet(
    { scope: "task", taskId, roleName },
    role.activeAgentId,
    NOW
  );
  sessions = recordRoleAgentSession(sessions, {
    agentId: role.activeAgentId,
    adapterId: role.agentBindings[role.activeAgentId].adapterId,
    nativeSessionId: "native-unusable",
    launchId: "launch-unusable",
    policy: "fixed",
    status: "running"
  }, NOW);
  const fence = {
    agentId: role.activeAgentId,
    runId: run.id,
    receiptId: `agent-run:${taskId}/${run.id}`
  };
  sessions = bindTaskRoleRun(sessions, fence, NOW);
  sessions = markTaskRoleRunDelivered(sessions, fence, NOW);
  sessions = declareTaskRoleSessionUnusable(sessions, {
    id: `session-retirement-${run.id}`,
    taskId,
    roleName,
    agentId: role.activeAgentId,
    adapterId: role.agentBindings[role.activeAgentId].adapterId,
    runId: run.id,
    receiptId: fence.receiptId,
    nativeSessionId: "native-unusable",
    launchId: "launch-unusable",
    reason: "Operator confirmed this fixed Session cannot run another Turn."
  }, NOW);
  store.saveTaskRoleSessionSet(sessions);
  enqueueWork(
    store,
    { kind: "role-runtime", taskId, roleName },
    "runtime-cleanup-required",
    NOW
  );
}

test("Task Role list uses one tmux snapshot and returns structured runtime summaries", (t) => {
  const { root, store, options, paneReads } = fixture(t);
  execute(["create", "Runtime status"], store, options);
  const task = store.listTasks()[0];
  execute(["role", "add", task.id, "worker"], store, options);
  execute(["work", "create", task.id, "Implement"], store, options);
  execute(["activate", task.id], store, options);
  const work = store.listWorkItems(task.id)[0];
  dispatchTestRun(store, task.id, "worker", work.id);
  const activeRun = store.getActiveAgentRun(task.id, "worker");
  store.saveAgentRun({ ...activeRun, deliveredAt: NOW.toISOString() });

  let sessions = createRoleSessionSet(
    { scope: "task", taskId: task.id, roleName: "worker" },
    "codex",
    NOW
  );
  sessions = recordRoleAgentSession(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-worker",
    policy: "fixed",
    status: "running"
  }, NOW);
  store.saveTaskRoleSessionSet(sessions);

  const before = readFileSync(join(root, "state.json"), "utf8");
  const result = execute(["role", "list", task.id], store, options);
  assert.deepEqual(paneReads, [task.id]);
  assert.match(result.output, /Agent\s+Health\s+Open input\s+Active work\s+Native session\s+tmux/);
  assert.match(result.output, /worker\s+codex\s+running/);
  assert.match(result.output, /running/);
  assert.doesNotMatch(result.output, /thread-worker/);
  assert.equal(result.data.roles.length, 2);
  const worker = result.data.roles.find((role) => role.roleName === "worker");
  assert.equal(worker.health, "running");
  assert.equal(worker.activeRun.workItemId, work.id);
  assert.equal(worker.activeWork.id, work.id);
  assert.equal(worker.nativeSession.nativeSessionId, "thread-worker");
  assert.deepEqual(worker.tmux, {
    state: "running",
    target: `${task.id}:worker`,
    dead: false,
    pid: 4321,
    currentCommand: "codex"
  });
  const status = execute(["role", "status", task.id, "worker"], store, options);
  assert.match(status.output, /thread-worker/);
  assert.equal(readFileSync(join(root, "state.json"), "utf8"), before);
});

test("Task Role status explains persisted and live state without capturing output", (t) => {
  const { store, options, paneReads } = fixture(t);
  execute(["create", "Inspect role"], store, options);
  const task = store.listTasks()[0];
  execute(["role", "add", task.id, "worker"], store, options);

  const result = execute(["role", "status", task.id, "worker"], store, options);
  assert.deepEqual(paneReads, [task.id]);
  assert.match(result.output, new RegExp(`Task Role status: ${task.id}/worker`));
  assert.match(result.output, /Health\s+ready/);
  assert.match(result.output, /Workspace\s+/);
  assert.match(result.output, /Native session\s+not recorded/);
  assert.match(result.output, /tmux pane\s+running/);
  assert.equal(result.data.role.health, "ready");
  assert.equal(result.data.role.nativeSession, null);
});

test("Task Role status separates live runtime from an Operator-declared unusable Session", (t) => {
  const { store, options } = fixture(t);
  execute(["create", "Inspect unusable Session"], store, options);
  const task = store.listTasks()[0];
  execute(["role", "add", task.id, "worker"], store, options);
  execute(["work", "create", task.id, "Run it"], store, options);
  execute(["activate", task.id], store, options);
  const run = dispatchTestRun(store, task.id, "worker", store.listWorkItems(task.id)[0].id);
  store.saveAgentRun({ ...run, deliveredAt: NOW.toISOString() });
  recordPendingSessionRetirement(store, task.id, "worker", run);

  const result = execute(["role", "status", task.id, "worker"], store, options);
  assert.equal(result.data.role.tmux.state, "running");
  assert.equal(result.data.role.health, "needs-attention");
  assert.equal(result.data.role.sessionRetirement.state, "cleanup-pending");
  assert.equal(result.data.role.sessionRetirement.nativeSessionId, "native-unusable");
  assert.equal(result.data.role.runtimeCleanupPending, true);
  assert.equal(result.data.role.freshLaunchAllowed, false);
  assert.match(result.output, /Session usability\s+operator-declared-unusable \(cleanup-pending\)/);
  assert.match(result.output, /Operator confirmed this fixed Session cannot run another Turn\./);
  assert.match(result.output, /Runtime cleanup\s+pending/);
  assert.match(result.output, /Fresh launch\s+blocked/);
  assert.match(result.output, /tmux pane\s+running/);

  const list = execute(["role", "list", task.id], store, options);
  const listedWorker = list.data.roles.find((status) => status.roleName === "worker");
  assert.equal(listedWorker.health, "needs-attention");
  assert.equal(listedWorker.sessionRetirement.state, "cleanup-pending");
  assert.match(list.output, /unusable/);
  assert.match(list.output, /\(cleanup-pending\)/);
});

test("Task Role health distinguishes queued, orphaned delivered, and exited runtime states", (t) => {
  const { store, options } = fixture(t);
  execute(["create", "Health states"], store, options);
  const task = store.listTasks()[0];
  execute(["role", "add", task.id, "worker"], store, options);
  execute(["work", "create", task.id, "Run it"], store, options);
  execute(["activate", task.id], store, options);
  dispatchTestRun(store, task.id, "worker", store.listWorkItems(task.id)[0].id);
  const withoutPane = {
    ...options,
    runtime: { ...options.runtime, inspectTaskRolePanes: () => [] }
  };

  assert.equal(
    execute(["role", "status", task.id, "worker"], store, withoutPane).data.role.health,
    "starting"
  );
  const activeRun = store.getActiveAgentRun(task.id, "worker");
  store.saveAgentRun({ ...activeRun, deliveredAt: NOW.toISOString() });
  assert.equal(
    execute(["role", "status", task.id, "worker"], store, withoutPane).data.role.health,
    "needs-attention"
  );
  const deadPane = {
    ...options,
    runtime: {
      ...options.runtime,
      inspectTaskRolePanes: () => [{
        taskId: task.id,
        roleName: "worker",
        target: `${task.id}:worker`,
        dead: true,
        currentCommand: "codex"
      }]
    }
  };
  assert.equal(
    execute(["role", "status", task.id, "worker"], store, deadPane).data.role.health,
    "failed"
  );
});

test("an open InputRequest blocks a healthy Leader and exposes only its count", (t) => {
  const { store, options } = fixture(t);
  execute(["create", "Await user"], store, options);
  const task = store.listTasks()[0];
  execute(["role", "add", task.id, "worker"], store, options);
  const origin = createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "leader",
    "new",
    "Ask for input",
    NOW
  );
  store.saveAgentRun(origin);
  const request = createInputRequest(
    store.nextInputRequestId(task.id),
    task.id,
    { taskId: task.id, roleName: "leader", agentId: "codex", runId: origin.id },
    { question: "Choose the rollout?", choices: [], blockedRefs: [] },
    NOW
  );
  store.saveInputRequest(task.id, request);
  const noPanes = {
    ...options,
    runtime: { ...options.runtime, inspectTaskRolePanes: () => [] }
  };

  const status = execute(["role", "status", task.id, "leader"], store, noPanes);
  assert.equal(status.data.role.health, "blocked-input");
  assert.equal(status.data.role.openInputRequestCount, 1);
  assert.match(status.output, /Health\s+blocked-input/);
  assert.match(status.output, /Open inputs\s+1/);
  assert.doesNotMatch(status.output, /Choose the rollout/);

  const list = execute(["role", "list", task.id], store, noPanes);
  assert.match(list.output, /Open input/);
  assert.match(list.output, /leader\s+codex\s+blocked-input\s+1/);
  const leader = list.data.roles.find((role) => role.roleName === "leader");
  const worker = list.data.roles.find((role) => role.roleName === "worker");
  assert.equal(leader.openInputRequestCount, 1);
  assert.equal(worker.openInputRequestCount, 0);
  assert.equal(worker.health, "idle");
  assert.equal(Object.hasOwn(leader, "inputRequests"), false);

  const deadLeader = {
    ...options,
    runtime: {
      ...options.runtime,
      inspectTaskRolePanes: () => [{
        taskId: task.id,
        roleName: "leader",
        target: `${task.id}:leader`,
        dead: true,
        currentCommand: "codex"
      }]
    }
  };
  assert.equal(
    execute(["role", "status", task.id, "leader"], store, deadLeader).data.role.health,
    "failed"
  );
});

test("Tmux Role inspection reads all panes in one command and never captures pane output", () => {
  const calls = [];
  const tmux = new TmuxManager("tmux-test", {
    run(command, args) {
      calls.push({ command, args });
      assert.equal(args[0], "-L");
      assert.match(args[1], /^yui-[a-f0-9]{24}$/);
      assert.equal(args[2], "list-panes");
      return [
        "leader\\0370\\037111\\037codex",
        "worker\\0371\\037222\\037zsh"
      ].join("\n");
    }
  }, { yuiHome: "/tmp/yui-role-status" });

  assert.deepEqual(tmux.inspectTaskRolePanes("task-1"), [
    {
      taskId: "task-1",
      roleName: "leader",
      target: yuiTmuxTarget("/tmp/yui-role-status", "task-1", "leader"),
      dead: false,
      pid: 111,
      currentCommand: "codex"
    },
    {
      taskId: "task-1",
      roleName: "worker",
      target: yuiTmuxTarget("/tmp/yui-role-status", "task-1", "worker"),
      dead: true,
      pid: 222,
      currentCommand: "zsh"
    }
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls.some(({ args }) => args.includes("capture-pane")), false);
});

test("Tmux Role inspection treats an unopened tmux server as an empty snapshot", () => {
  const tmux = new TmuxManager("tmux-test", {
    run() {
      throw new CommandExecutionError(
        "COMMAND_FAILED",
        1,
        "error connecting to /tmp/tmux-1001/default (No such file or directory)\n"
      );
    }
  }, { yuiHome: "/tmp/yui-role-status" });

  assert.deepEqual(tmux.inspectTaskRolePanes("task-1"), []);
});
