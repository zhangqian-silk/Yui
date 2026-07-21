import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runOperatorCommand } from "../../dist/commands/operatorCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import {
  createGlobalRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../../dist/role/role.js";
import { createAgentRun } from "../../dist/run/agentRun.js";
import { createRepository } from "../../dist/repository/repository.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";

const NOW = new Date("2026-07-19T12:00:00.000Z");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const codex = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  const claude = createConfiguredAgent("claude", "claude", "claude", [], [], NOW);
  const leader = createGlobalRole(
    "leader",
    [createRoleAgentBinding(codex)],
    codex.id,
    root,
    NOW
  );
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: codex.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(codex);
    tx.saveConfiguredAgent(claude);
    tx.saveGlobalRole(leader);
  });
  const calls = { changed: [], reconcile: [], enter: [] };
  const runtime = {
    notifyStateChanged(taskId) { calls.changed.push(taskId); },
    reconcileTask(taskId) { calls.reconcile.push(taskId); },
    prepareTaskRoleEnter(input) { calls.enter.push(input); }
  };
  const options = { runtime, now: () => new Date(NOW) };
  return { root, store, calls, options };
}

function run(args, store, options) {
  const result = runTaskCommand(args, store, options);
  assert.equal(result.kind, "output");
  return result.output;
}

function createTask(store, options, title = "Plan first") {
  run(["create", title], store, options);
  return store.listTasks().at(-1);
}

function markDelivered(store, run) {
  store.saveAgentRun({ ...run, deliveredAt: NOW.toISOString() });
}

test("Draft activation atomically creates one durable first Leader wake", (t) => {
  const { root, store, options } = fixture(t);
  store.saveRepository(createRepository("repo-1", "fixture", root, "main", NOW));
  run(["create", "Repository task", "--repository", "repo-1", "--base", "main"], store, options);
  const task = store.listTasks()[0];

  assert.equal(task.status, "draft");
  assert.equal(task.repositoryId, "repo-1");
  assert.equal(task.baseRef, "main");
  assert.equal(store.getRole(task.id, "leader")?.activeAgentId, "codex");
  assert.equal(store.getPendingWakeup(task.id), null);

  run(["activate", task.id], store, options);
  const first = store.getPendingWakeup(task.id);
  assert.equal(store.getTask(task.id)?.status, "active");
  assert.deepEqual(first?.reasons, ["task-created"]);
  assert.equal(first?.requestCount, 1);

  run(["activate", task.id], store, options);
  assert.deepEqual(store.getPendingWakeup(task.id), first);
});

test("invalid repository and Role options fail before mutating the aggregate", (t) => {
  const { store, options } = fixture(t);
  assert.throws(
    () => runTaskCommand(["create", "invalid", "--base", "main"], store, options),
    /requires --repository/i
  );
  assert.equal(store.listTasks().length, 0);
  const task = createTask(store, options, "Valid");
  assert.throws(
    () => runTaskCommand(["role", "add", task.id, "worker", "--agent", ""], store, options),
    /--agent is required/i
  );
  assert.equal(store.getRole(task.id, "worker"), null);
});

test("Task metadata can be updated and is visible in Task details", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Initial title");

  run([
    "update",
    task.id,
    "--title",
    "Release readiness",
    "--description",
    "Prepare the release candidate",
    "--priority",
    "high",
    "--tags",
    "release,backend",
    "--due-at",
    "2026-07-31T12:00:00.000Z"
  ], store, options);

  const updated = store.getTask(task.id);
  assert.equal(updated.title, "Release readiness");
  assert.equal(updated.description, "Prepare the release candidate");
  assert.equal(updated.priority, "high");
  assert.deepEqual(updated.tags, ["release", "backend"]);
  assert.equal(updated.dueAt, "2026-07-31T12:00:00.000Z");
  const shown = run(["show", task.id], store, options);
  assert.match(shown, /Description: Prepare the release candidate/);
  assert.match(shown, /Priority: high/);
  assert.match(shown, /Tags: release, backend/);
  assert.match(shown, /Due: 2026-07-31T12:00:00.000Z/);

  run([
    "update",
    task.id,
    "--clear-description",
    "--clear-priority",
    "--clear-tags",
    "--clear-due-at"
  ], store, options);
  const cleared = store.getTask(task.id);
  assert.equal(cleared.description, undefined);
  assert.equal(cleared.priority, undefined);
  assert.equal(cleared.tags, undefined);
  assert.equal(cleared.dueAt, undefined);

  assert.throws(
    () => runTaskCommand(["update", task.id, "--due-at", "July 31, 2026"], store, options),
    /ISO|RFC 3339/i
  );
  run(["update", task.id, "--due-at", "2026-07-31T20:00:00+08:00"], store, options);
  assert.equal(store.getTask(task.id).dueAt, "2026-07-31T12:00:00.000Z");
});

test("Task list and show emit one-pass structured JSON for Agents", (t) => {
  const { root, store, options } = fixture(t);
  const task = createTask(store, options, "Agent-readable task");
  const runCli = (...args) => JSON.parse(execFileSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "--json", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, YUI_HOME: root }
    }
  ));

  assert.deepEqual(runCli("task", "list"), {
    ok: true,
    data: { tasks: [task] }
  });
  assert.deepEqual(runCli("task", "show", task.id), {
    ok: true,
    data: {
      task,
      counts: {
        roles: 1,
        messages: 0,
        decisions: 0,
        milestones: 0,
        events: 1,
        workItems: 0,
        runs: 0,
        openInputs: 0
      },
      hasBrief: false
    }
  });
});

test("Task lifecycle and messages append a durable Web timeline", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Timeline");
  run(["update", task.id, "--priority", "high"], store, options);
  run(["activate", task.id], store, options);
  run(["message", "send", task.id, "Proceed"], store, options);
  run(["complete", task.id, "--summary", "Finished"], store, options);
  run(["reopen", task.id], store, options);
  run(["archive", task.id], store, options);

  assert.deepEqual(
    store.listEvents(task.id).map((event) => event.type),
    [
      "task.created",
      "task.updated",
      "task.activated",
      "message.sent",
      "task.completed",
      "task.reopened",
      "task.archived"
    ]
  );
  assert.deepEqual(store.listEvents(task.id)[3].payload, {
    messageId: store.listMessages(task.id)[0].id,
    kind: "user"
  });
  const message = store.listMessages(task.id)[0];
  assert.throws(
    () => store.saveMessage(task.id, { ...message, body: "Rewritten history" }),
    /already exists/i
  );
});

test("Operator submit creates a Draft and active Task messages wake its Leader", (t) => {
  const { root, store, options } = fixture(t);
  const created = runOperatorCommand(["submit", "Build the smallest useful workflow"], store, options);
  assert.equal(created.kind, "output");
  const task = store.listTasks()[0];
  assert.equal(task.status, "draft");
  assert.deepEqual(store.listMessages(task.id)[0].author, { type: "operator" });
  assert.equal(store.listMessages(task.id)[0].kind, "operator");
  assert.equal(store.getPendingWakeup(task.id), null);

  run(["activate", task.id], store, options);
  const before = store.getPendingWakeup(task.id)?.requestCount;
  runOperatorCommand(["submit", "Continue here", "--task", task.id], store, options);
  assert.equal(store.listMessages(task.id).at(-1).body, "Continue here");
  assert.equal(store.getPendingWakeup(task.id)?.requestCount, before + 1);
  assert.ok(store.getPendingWakeup(task.id)?.reasons.includes("operator-input"));

  run(["message", "send", task.id, "User follow-up"], store, options);
  const userMessage = store.listMessages(task.id).at(-1);
  assert.equal(userMessage.kind, "user");
  assert.deepEqual(userMessage.author, { type: "user" });
  assert.ok(store.getPendingWakeup(task.id)?.reasons.includes("user-message"));

  const aggregate = JSON.parse(readFileSync(join(root, "state.json"), "utf8")).tasks[task.id];
  assert.ok(aggregate.messages[userMessage.id]);
  assert.equal("comments" in aggregate, false);
});

test("one Role has one active Run and Worker yield completes the workflow atomically", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Dispatch");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "first", "--role", "worker"], store, options);
  run(["work", "create", task.id, "second", "--role", "worker"], store, options);
  const [first, second] = store.listWorkItems(task.id);

  run(["work", "dispatch", first.id, "--input", "implement"], store, options);
  assert.throws(
    () => runTaskCommand(["work", "dispatch", second.id], store, options),
    /already has an active run/i
  );
  assert.equal(store.findWorkItem(second.id)?.status, "pending");
  const active = store.getActiveAgentRun(task.id, "worker");
  assert.equal(active?.workItemId, first.id);

  markDelivered(store, active);
  run(["run", "yield", active.id, "--summary", "implemented"], store, options);
  assert.equal(store.findAgentRun(active.id)?.status, "yielded");
  assert.equal(store.findWorkItem(first.id)?.status, "completed");
  assert.equal(store.getActiveAgentRun(task.id, "worker"), null);
  const resultMessage = store.listMessages(task.id).at(-1);
  assert.deepEqual(resultMessage.author, { type: "role", roleName: "worker" });
  assert.equal(resultMessage.kind, "role-result");
  assert.equal(resultMessage.runId, active.id);
  assert.equal(resultMessage.workItemId, first.id);
  assert.equal(resultMessage.body, "implemented");
  assert.ok(store.getPendingWakeup(task.id)?.reasons.includes("role-result"));
});

test("Leader yield does not self-wake and preserves a wake queued while busy", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Leader work");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "coordinate"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const runRecord = store.getActiveAgentRun(task.id, "leader");
  const pending = store.getPendingWakeup(task.id);

  markDelivered(store, runRecord);
  run(["run", "yield", runRecord.id, "--summary", "coordinated"], store, options);
  assert.deepEqual(store.getPendingWakeup(task.id), pending);
  assert.equal(store.findWorkItem(item.id)?.status, "completed");
});

test("Leader control Run without a WorkItem can yield and release the pending wake boundary", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Leader wake");
  run(["activate", task.id], store, options);
  const pending = store.getPendingWakeup(task.id);
  const leader = store.getRole(task.id, "leader");
  const controlRun = createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "leader",
    "new",
    "Review pending Task events",
    NOW
  );
  controlRun.deliveredAt = NOW.toISOString();
  store.transaction((tx) => {
    tx.saveActiveAgentRun(controlRun);
    tx.saveRole(task.id, updateRoleStatus(leader, "running", NOW));
  });

  run(["run", "yield", controlRun.id, "--summary", "reviewed"], store, options);
  assert.equal(store.findAgentRun(controlRun.id)?.status, "yielded");
  assert.equal(store.getActiveAgentRun(task.id, "leader"), null);
  assert.equal(store.getRole(task.id, "leader")?.status, "idle");
  assert.deepEqual(store.getPendingWakeup(task.id), pending);
  assert.equal(store.listMessages(task.id).at(-1).body, "reviewed");
});

test("a rejected Worker control yield rolls back all staged FileTaskStore writes", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Atomic yield");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  const worker = store.getRole(task.id, "worker");
  const invalidRun = createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "worker",
    "new",
    "invalid control run",
    NOW
  );
  invalidRun.deliveredAt = NOW.toISOString();
  store.transaction((tx) => {
    tx.saveActiveAgentRun(invalidRun);
    tx.saveRole(task.id, updateRoleStatus(worker, "running", NOW));
  });
  const beforeMessages = store.listMessages(task.id);

  assert.throws(
    () => runTaskCommand(["run", "yield", invalidRun.id, "--summary", "must roll back"], store, options),
    /not a work run/i
  );
  assert.equal(store.findAgentRun(invalidRun.id)?.status, "active");
  assert.equal(store.getActiveAgentRun(task.id, "worker")?.id, invalidRun.id);
  assert.equal(store.getRole(task.id, "worker")?.status, "running");
  assert.deepEqual(store.listMessages(task.id), beforeMessages);
});

test("Role bind switches the active Agent while enter remains a foreground CLI action", (t) => {
  const { store, options, calls } = fixture(t);
  const task = createTask(store, options, "Sessions");
  run(["role", "bind", task.id, "leader", "claude"], store, options);
  assert.equal(store.getRole(task.id, "leader")?.activeAgentId, "claude");
  assert.equal(store.getTaskRoleSessionSet(task.id, "leader")?.activeAgentId, "claude");
  run(["role", "bind", task.id, "leader", "codex"], store, options);
  assert.equal(store.getRole(task.id, "leader")?.activeAgentId, "codex");
  run(["role", "bind", task.id, "leader", "claude"], store, options);
  assert.equal(store.getRole(task.id, "leader")?.activeAgentId, "claude");

  assert.throws(
    () => runTaskCommand(["role", "enter", task.id, "leader"], store, options),
    /Draft.*activate/i
  );
  run(["activate", task.id], store, options);
  const execution = runTaskCommand(["enter", task.id], store, options);
  assert.deepEqual(execution, {
    kind: "enter",
    taskId: task.id,
    roleName: "leader",
    output: `Prepared role leader for ${task.id}\n`
  });
  assert.deepEqual(calls.enter, [{ taskId: task.id, roleName: "leader" }]);
});

test("Task Role add, update, show, and remove preserve lean field-level configuration", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Role settings");

  run([
    "role", "add", task.id, "reviewer", "--agent", "codex",
    "--description", "Review changes", "--model", "gpt-5.6-sol",
    "--effort", "high", "--sandbox", "read-only"
  ], store, options);
  run([
    "role", "update", task.id, "reviewer", "--agent", "codex",
    "--clear-model", "--approval", "never", "--description", "Review safely"
  ], store, options);

  const role = store.getRole(task.id, "reviewer");
  assert.equal(role.description, "Review safely");
  assert.deepEqual(role.agentBindings.codex.config, {
    adapterId: "codex",
    effort: "high",
    permission: { sandbox: "read-only", approval: "never" }
  });

  run([
    "role", "update", task.id, "reviewer", "--agent", "claude",
    "--model", "claude-opus", "--permission-mode", "acceptEdits"
  ], store, options);
  const withClaude = store.getRole(task.id, "reviewer");
  assert.equal(withClaude.activeAgentId, "codex");
  assert.deepEqual(withClaude.agentBindings.claude.config, {
    adapterId: "claude",
    model: "claude-opus",
    permission: { mode: "acceptEdits" }
  });

  const shown = run(["role", "show", task.id, "reviewer"], store, options);
  assert.match(shown, /Task Role: reviewer/);
  assert.match(shown, /CLI default/);
  assert.match(shown, /read-only/);
  assert.doesNotMatch(shown, /\{"adapterId"/);

  const listed = run(["role", "list", task.id], store, options);
  assert.match(listed, /Agent/);
  assert.match(listed, /Health/);
  assert.match(listed, /Native session/);
  assert.doesNotMatch(listed, /Workspace/);

  assert.match(run(["role", "remove", task.id, "reviewer"], store, options), /Removed role reviewer/);
  assert.equal(store.getRole(task.id, "reviewer"), null);
});

test("Task Role removal is blocked for Leader and active Runs", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Role removal guard");
  assert.throws(
    () => runTaskCommand(["role", "remove", task.id, "leader"], store, options),
    /Leader role cannot be removed/i
  );

  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "active", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["activate", task.id], store, options);
  run(["work", "dispatch", item.id], store, options);
  assert.throws(
    () => runTaskCommand(["role", "remove", task.id, "worker"], store, options),
    /active Run/i
  );
  assert.notEqual(store.getRole(task.id, "worker"), null);
});

test("archive fences active work and clears pending wake in one transaction", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Archive");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "unfinished"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const active = store.getActiveAgentRun(task.id, "leader");

  run(["archive", task.id], store, options);
  assert.equal(store.getTask(task.id)?.status, "archived");
  assert.equal(store.findAgentRun(active.id)?.status, "failed");
  assert.equal(store.findWorkItem(item.id)?.status, "failed");
  assert.equal(store.getActiveAgentRun(task.id, "leader"), null);
  assert.equal(store.getPendingWakeup(task.id), null);
  assert.throws(
    () => runTaskCommand(["message", "send", task.id, "too late"], store, options),
    /archived/i
  );
});

test("completion fences active behavior until an explicit reopen", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Complete and reopen");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "in flight", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);

  assert.throws(
    () => runTaskCommand(["complete", task.id, "--summary", "premature"], store, options),
    /active run|running work/i
  );
  const workerRun = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, workerRun);
  run(["run", "yield", workerRun.id, "--summary", "done"], store, options);

  run(["complete", task.id, "--summary", "Everything requested is done."], store, options);
  const completed = store.getTask(task.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.completionSummary, "Everything requested is done.");
  assert.equal(store.getPendingWakeup(task.id), null);
  assert.equal(store.getLeaderFailure(task.id), null);
  assert.equal(store.getOperatorNotification(task.id), null);
  assert.throws(
    () => runTaskCommand(["message", "send", task.id, "continue"], store, options),
    /completed.*reopen/i
  );
  assert.throws(
    () => runTaskCommand(["enter", task.id], store, options),
    /completed.*reopen/i
  );

  run(["reopen", task.id], store, options);
  assert.equal(store.getTask(task.id)?.status, "active");
  assert.deepEqual(store.getPendingWakeup(task.id)?.reasons, ["task-reopened"]);
  run(["message", "send", task.id, "continue"], store, options);
  assert.ok(store.getPendingWakeup(task.id)?.reasons.includes("user-message"));
});

test("a Leader control Run can complete its Task atomically", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Leader completes");
  run(["activate", task.id], store, options);
  const leader = store.getRole(task.id, "leader");
  const controlRun = createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "leader",
    "new",
    "Review final state",
    NOW
  );
  controlRun.deliveredAt = NOW.toISOString();
  store.transaction((tx) => {
    tx.saveActiveAgentRun(controlRun);
    tx.saveRole(task.id, updateRoleStatus(leader, "running", NOW));
  });

  run(
    ["complete", task.id, "--summary", "Final review passed."],
    store,
    {
      ...options,
      environment: {
        YUI_SESSION_SCOPE: "task",
        YUI_TASK_ID: task.id,
        YUI_ROLE: "leader"
      }
    }
  );

  assert.equal(store.getTask(task.id)?.status, "completed");
  assert.equal(store.findAgentRun(controlRun.id)?.status, "yielded");
  assert.equal(store.findAgentRun(controlRun.id)?.summary, "Final review passed.");
  assert.equal(store.getActiveAgentRun(task.id, "leader"), null);
  assert.equal(store.getRole(task.id, "leader")?.status, "idle");
});

test("a Leader session cannot complete another Task as that Task's Leader", (t) => {
  const { store, options } = fixture(t);
  const source = createTask(store, options, "Source Task");
  run(["activate", source.id], store, options);
  const target = createTask(store, options, "Target Task");
  run(["activate", target.id], store, options);
  const targetLeader = store.getRole(target.id, "leader");
  const targetRun = createAgentRun(
    store.nextAgentRunId(target.id),
    target.id,
    "leader",
    "new",
    "Target control run",
    NOW
  );
  targetRun.deliveredAt = NOW.toISOString();
  store.transaction((tx) => {
    tx.saveActiveAgentRun(targetRun);
    tx.saveRole(target.id, updateRoleStatus(targetLeader, "running", NOW));
  });

  assert.throws(
    () => runTaskCommand(
      ["complete", target.id, "--summary", "Wrong Task"],
      store,
      {
        ...options,
        environment: {
          YUI_SESSION_SCOPE: "task",
          YUI_TASK_ID: source.id,
          YUI_ROLE: "leader"
        }
      }
    ),
    /active Leader run/i
  );
  assert.equal(store.getTask(target.id)?.status, "active");
  assert.equal(store.getActiveAgentRun(target.id, "leader")?.id, targetRun.id);
});

test("reconcile only requests the Controller runtime", (t) => {
  const { store, options, calls } = fixture(t);
  const task = createTask(store, options, "Reconcile");
  run(["reconcile", task.id], store, options);
  assert.deepEqual(calls.reconcile, [task.id]);
  assert.equal(store.getTask(task.id)?.status, "draft");
});
