import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import { createInputRequest } from "../../dist/input/inputRequest.js";
import {
  createGlobalRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import {
  yuiTmuxTarget,
  TmuxManager
} from "../../dist/tmux/tmuxManager.js";

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
    tx.saveGlobalRole(createGlobalRole(
      "leader",
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

test("Task Role list uses one tmux snapshot and returns structured runtime summaries", (t) => {
  const { root, store, options, paneReads } = fixture(t);
  execute(["create", "Runtime status"], store, options);
  const task = store.listTasks()[0];
  execute(["role", "add", task.id, "worker"], store, options);
  execute(["work", "create", task.id, "Implement", "--role", "worker"], store, options);
  execute(["activate", task.id], store, options);
  const work = store.listWorkItems(task.id)[0];
  execute(["work", "dispatch", work.id], store, options);
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

test("Task Role list emits its runtime summaries as a structured JSON array", (t) => {
  const { root, store, options } = fixture(t);
  execute(["create", "JSON role status"], store, options);
  const task = store.listTasks()[0];
  const response = JSON.parse(execFileSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "--json", "task", "role", "list", task.id],
    { encoding: "utf8", env: { ...process.env, YUI_HOME: root } }
  ));

  assert.equal(response.ok, true);
  assert.equal(Array.isArray(response.data.roles), true);
  assert.equal(response.data.roles[0].roleName, "leader");
  assert.equal(response.data.roles[0].health, "idle");
});

test("Task Role health distinguishes queued, orphaned delivered, and exited runtime states", (t) => {
  const { store, options } = fixture(t);
  execute(["create", "Health states"], store, options);
  const task = store.listTasks()[0];
  execute(["role", "add", task.id, "worker"], store, options);
  execute(["work", "create", task.id, "Run it", "--role", "worker"], store, options);
  execute(["activate", task.id], store, options);
  execute(["work", "dispatch", store.listWorkItems(task.id)[0].id], store, options);
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
  const { root, store, options } = fixture(t);
  execute(["create", "Await user"], store, options);
  const task = store.listTasks()[0];
  execute(["role", "add", task.id, "worker"], store, options);
  const request = createInputRequest(
    store.nextInputRequestId(task.id),
    task.id,
    { roleName: "leader", agentId: "codex", runId: "run-origin" },
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

  const json = JSON.parse(execFileSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "--json", "task", "role", "list", task.id],
    { encoding: "utf8", env: { ...process.env, YUI_HOME: root } }
  ));
  assert.equal(
    json.data.roles.find((role) => role.roleName === "leader").openInputRequestCount,
    1
  );
  assert.equal(
    json.data.roles.find((role) => role.roleName === "worker").openInputRequestCount,
    0
  );

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
      assert.equal(args[0], "list-panes");
      return [
        "leader\u001f0\u001f111\u001fcodex",
        "worker\u001f1\u001f222\u001fzsh"
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
