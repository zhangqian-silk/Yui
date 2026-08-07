import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createTaskBrief } from "../../dist/brief/taskBrief.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createInputRequest } from "../../dist/input/inputRequest.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createLeaderStallNotification } from "../../dist/scheduler/operatorNotification.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import {
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { createAgentRun } from "../helpers/effectiveLaunch.js";

const NOW = new Date("2026-08-07T08:00:00.000Z");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-task-list-overview-"));
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
  const options = { now: () => new Date(NOW) };
  return { root, store, options };
}

function createTask(store, options, title) {
  const result = runTaskCommand(["create", title], store, options);
  assert.equal(result.kind, "output");
  return store.listTasks().at(-1);
}

function saveBrief(store, taskId, values = {}) {
  store.saveTaskBrief(taskId, createTaskBrief({
    objective: "Keep the Task understandable",
    boundaries: ["read-only"],
    currentFocus: values.currentFocus ?? "CLI projection",
    leaderSummary: values.leaderSummary ?? "Durable records are available",
    updatedBy: "leader"
  }, values.updatedAt ?? NOW));
}

test("task list defaults to unarchived overview records with durable Leader facts", (t) => {
  const { store, options } = fixture(t);
  const active = createTask(store, options, "Visible Task");
  saveBrief(store, active.id);
  const archived = createTask(store, options, "Archived Task");
  runTaskCommand(["activate", archived.id], store, options);
  runTaskCommand(["complete", archived.id, "--summary", "Finished"], store, options);
  runTaskCommand(["archive", archived.id, "--integrated"], store, options);

  const result = runTaskCommand(["list"], store, options);
  assert.equal(result.kind, "output");
  assert.deepEqual(result.data.tasks.map(({ id }) => id), [active.id]);
  const overview = result.data.tasks[0];
  assert.equal(overview.title, "Visible Task");
  assert.equal(overview.status, "draft");
  assert.equal(overview.leaderSummary, "Durable records are available");
  assert.equal(overview.currentFocus, "CLI projection");
  assert.equal(overview.summaryUpdatedAt, NOW.toISOString());
  assert.equal(overview.summaryStatus, "available");
  assert.match(result.output, /Tasks \(unarchived\)/);
  assert.match(result.output, /Visible Task/);
  assert.doesNotMatch(result.output, /Archived Task/);
  assert.match(result.output, /Durable records are available/);
  assert.match(result.output, /CLI projection/);
});

test("task list --all/--verbose retains history and expands context without writing", (t) => {
  const { root, store, options } = fixture(t);
  const task = createTask(store, options, "Long task title that must remain complete in JSON");
  runTaskCommand(["update", task.id, "--description", "A detailed description for operators"], store, options);
  saveBrief(store, task.id, {
    leaderSummary: "s".repeat(700),
    currentFocus: "Detailed focus"
  });
  const archived = createTask(store, options, "History");
  runTaskCommand(["activate", archived.id], store, options);
  runTaskCommand(["complete", archived.id, "--summary", "Finished"], store, options);
  runTaskCommand(["archive", archived.id, "--integrated"], store, options);

  const before = readFileSync(join(root, "state.json"), "utf8");
  const result = runTaskCommand(["list", "--all", "--verbose"], store, options);
  const after = readFileSync(join(root, "state.json"), "utf8");
  assert.equal(before, after);
  assert.deepEqual(result.data.tasks.map(({ id }) => id), [archived.id, task.id].sort());
  assert.match(result.output, /Tasks \(all\)/);
  assert.match(result.output, /Description: A detailed description for operators/);
  assert.match(result.output, /Current focus: Detailed focus/);
  assert.match(result.output, /Projects: none/);

  const response = JSON.parse(execFileSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "--json", "task", "list"],
    { encoding: "utf8", env: { ...process.env, YUI_HOME: root } }
  ));
  assert.equal(response.ok, true);
  const jsonTask = response.data.tasks.find(({ id }) => id === task.id);
  assert.equal(jsonTask.leaderSummary, "s".repeat(700));
  assert.equal(jsonTask.currentFocus, "Detailed focus");
  assert.equal(jsonTask.description, "A detailed description for operators");
  assert.equal(response.data.tasks.some(({ id }) => id === archived.id), false);
});

test("task overview makes missing summary and structured blockers actionable", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Blocked Task");
  runTaskCommand(["activate", task.id], store, options);
  const failed = createWorkItem(
    store.nextWorkItemId(task.id), task.id, { title: "Failed work", assignee: "worker" }, NOW
  );
  store.saveWorkItem(task.id, updateWorkItemStatus(
    failed, "failed", new Date(NOW.getTime() + 60_000), "Worker reported a failure"
  ));
  let awaiting = createWorkItem(
    store.nextWorkItemId(task.id), task.id, { title: "Await acceptance" }, NOW
  );
  awaiting = updateWorkItemStatus(awaiting, "running", NOW);
  awaiting = submitWorkItemCandidate(awaiting, {
    summary: "Ready for Leader acceptance",
    source: { type: "direct" }
  }, NOW);
  store.saveWorkItem(task.id, awaiting);

  const run = createAgentRun(
    store.nextAgentRunId(task.id), task.id, "leader", "new", "Ask for a decision", NOW,
    { agent: { agentId: "codex", adapterId: "codex" } }
  );
  store.saveAgentRun(run);
  const request = createInputRequest(
    store.nextInputRequestId(task.id),
    task.id,
    { taskId: task.id, roleName: "leader", agentId: "codex", runId: run.id },
    {
      question: "Choose the safe path",
      choices: [{ key: "safe", label: "Safe" }],
      blockedRefs: [{ type: "work-item", taskId: task.id, id: awaiting.id }]
    },
    NOW
  );
  store.saveInputRequest(task.id, request);
  store.saveOperatorNotification(createLeaderStallNotification(
    task.id, run.id, NOW.toISOString(), "fixture-stall", NOW, null
  ));
  store.saveEvent(task.id, createTaskEvent(
    store.nextEventId(task.id), task.id, "run.stalled",
    {
      runId: run.id,
      progressAt: NOW.toISOString(),
      kind: "execution-stalled",
      classification: "truly-stalled",
      evidenceKey: "fixture-stall"
    },
    NOW
  ));

  const result = runTaskCommand(["list"], store, options);
  assert.equal(result.kind, "output");
  const overview = result.data.tasks[0];
  assert.equal(overview.summaryStatus, "missing");
  assert.equal(overview.leaderSummary, null);
  assert.equal(overview.currentFocus, null);
  assert.equal(overview.input.openCount, 1);
  assert.equal(overview.work.counts.failed, 1);
  assert.equal(overview.work.counts.awaiting_acceptance, 1);
  assert.equal(overview.attention[0].kind, "leader-stalled");
  assert.ok(overview.blockers.some(({ kind, id }) => kind === "input" && id === request.id));
  assert.ok(overview.blockers.some(({ kind, id }) => kind === "work" && id === failed.id));
  assert.equal(overview.nextAction, "answer-input");
  assert.equal(overview.nextOwner, "user");
  assert.match(result.output, /missing summary/);
  assert.match(result.output, new RegExp(`input:${request.id}`));
  assert.match(result.output, /answer-input \/ user/);
});
