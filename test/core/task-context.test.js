import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createTaskBrief } from "../../dist/brief/taskBrief.js";
import {
  findCommandNode,
  listPublicCommandPaths
} from "../../dist/cli/commandCatalog.js";
import { resolveCompletionCandidates } from "../../dist/cli/dynamicCompletion.js";
import { findInteractionPolicy } from "../../dist/cli/interactionPolicy.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createDecision, supersedeDecision } from "../../dist/decision/decision.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { createMilestone } from "../../dist/milestone/milestone.js";
import {
  createGlobalRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";
import { createAgentRun } from "../../dist/run/agentRun.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import {
  createWorkItem,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";

const NOW = new Date("2026-07-21T08:00:00.000Z");

function atMinute(minute) {
  return new Date(NOW.getTime() + minute * 60_000);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "taskmux-context-"));
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

function output(args, store, options) {
  const result = runTaskCommand(args, store, options);
  assert.equal(result.kind, "output");
  return result;
}

function createTask(store, options, title) {
  output(["create", title], store, options);
  return store.listTasks().at(-1);
}

test("task context aggregates complete records and renders a compact recent summary", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Ship compact context");
  output(["role", "add", task.id, "worker", "--agent", "codex"], store, options);

  const brief = createTaskBrief({
    objective: "Give the Leader one useful read",
    boundaries: ["No cache", "No transcript"],
    currentFocus: "CLI aggregation",
    leaderSummary: "Models are already durable",
    updatedBy: "leader"
  }, atMinute(1));
  store.saveTaskBrief(task.id, brief);

  const activeDecision = createDecision(
    store.nextDecisionId(task.id),
    task.id,
    "Keep context read-only",
    "Aggregation does not need another model",
    atMinute(2)
  );
  store.saveDecision(task.id, activeDecision);
  const oldDecision = createDecision(
    store.nextDecisionId(task.id),
    task.id,
    "Cache context",
    "This was reconsidered",
    atMinute(3)
  );
  store.saveDecision(task.id, oldDecision);
  store.saveDecision(task.id, supersedeDecision(oldDecision, "Direct reads are sufficient", atMinute(4)));

  const milestones = [];
  for (let index = 1; index <= 6; index += 1) {
    const milestone = createMilestone(
      store.nextMilestoneId(task.id),
      task.id,
      `Milestone ${index}`,
      `Completed step ${index}`,
      atMinute(4 + index)
    );
    milestones.push(milestone);
    store.saveMilestone(task.id, milestone);
  }

  const workItem = createWorkItem(
    store.nextWorkItemId(task.id),
    task.id,
    { title: "Implement context", assignee: "worker" },
    atMinute(11)
  );
  store.saveWorkItem(task.id, workItem);
  const associatedRun = createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "worker",
    "new",
    "Implement the read model",
    atMinute(12),
    { workItemId: workItem.id }
  );
  store.saveAgentRun(associatedRun);
  store.saveAgentRun(createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "leader",
    "new",
    "Inspect progress",
    atMinute(13)
  ));

  const messages = [];
  for (let index = 1; index <= 6; index += 1) {
    const message = createTaskMessage(
      store.nextMessageId(task.id),
      `Message ${index}`,
      "user",
      { type: "user" },
      atMinute(13 + index)
    );
    messages.push(message);
    store.saveMessage(task.id, message);
  }
  for (let index = 1; index <= 6; index += 1) {
    store.saveEvent(task.id, createTaskEvent(
      store.nextEventId(task.id),
      `context.event.${index}`,
      { sequence: String(index) },
      atMinute(19 + index)
    ));
  }

  const result = output(["context", task.id], store, options);
  assert.deepEqual(result.data, {
    task,
    brief,
    activeDecisions: [activeDecision],
    milestones,
    roles: store.listRoles(task.id),
    workItems: [workItem],
    runs: [associatedRun],
    messages,
    events: store.listEvents(task.id)
  });
  assert.match(result.output, /^Task context: task-1/m);
  assert.match(result.output, /Objective: Give the Leader one useful read/);
  assert.match(result.output, /Keep context read-only/);
  assert.doesNotMatch(result.output, /Cache context/);
  assert.match(result.output, /Recent milestones \(5 of 6\)/);
  assert.doesNotMatch(result.output, /Milestone 1/);
  assert.match(result.output, /Milestone 6/);
  assert.match(result.output, /Implement context/);
  assert.match(result.output, /agent-run-1.*active/);
  assert.match(result.output, /Recent messages \(5 of 6\)/);
  assert.doesNotMatch(result.output, /Message 1/);
  assert.match(result.output, /Message 6/);
  assert.match(result.output, /Recent events \(5 of 7\)/);
});

test("task context bounds human-readable history while preserving complete data", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Bounded context");
  output(["role", "add", task.id, "worker", "--agent", "codex"], store, options);

  for (let index = 1; index <= 7; index += 1) {
    store.saveDecision(task.id, createDecision(
      store.nextDecisionId(task.id),
      task.id,
      `Active decision ${index}`,
      `Rationale ${index}`,
      atMinute(index)
    ));
    const created = createWorkItem(
      store.nextWorkItemId(task.id),
      task.id,
      { title: `Historical work ${index}`, assignee: "worker" },
      atMinute(index)
    );
    store.saveWorkItem(
      task.id,
      updateWorkItemStatus(created, "completed", `Outcome ${index}`, atMinute(index + 1))
    );
  }
  store.saveMessage(task.id, createTaskMessage(
    store.nextMessageId(task.id),
    `Large message ${"x".repeat(1_000)}`,
    "user",
    { type: "user" },
    atMinute(20)
  ));

  const result = output(["context", task.id], store, options);
  assert.equal(result.data.activeDecisions.length, 7);
  assert.equal(result.data.workItems.length, 7);
  assert.equal(result.data.messages[0].body.length, 1_014);
  assert.match(result.output, /Active decisions \(5 of 7\)/);
  assert.doesNotMatch(result.output, /Active decision 1/);
  assert.match(result.output, /Active decision 7/);
  assert.match(result.output, /Current and recent work items \(5 of 7\)/);
  assert.doesNotMatch(result.output, /Historical work 1/);
  assert.match(result.output, /Historical work 7/);
  assert.doesNotMatch(result.output, /x{500}/);
});

test("task context keeps empty knowledge and work explicit and reads terminal Task states", (t) => {
  const { store, options } = fixture(t);
  const completed = createTask(store, options, "Completed context");
  output(["activate", completed.id], store, options);
  output(["complete", completed.id, "--summary", "Finished"], store, options);
  const archived = createTask(store, options, "Archived context");
  output(["archive", archived.id], store, options);

  for (const [taskId, status] of [[completed.id, "completed"], [archived.id, "archived"]]) {
    const result = output(["context", taskId], store, options);
    assert.equal(result.data.task.status, status);
    assert.equal(result.data.brief, null);
    assert.deepEqual(result.data.activeDecisions, []);
    assert.deepEqual(result.data.milestones, []);
    assert.deepEqual(result.data.workItems, []);
    assert.deepEqual(result.data.runs, []);
    assert.deepEqual(result.data.messages, []);
    assert.match(result.output, /Brief:\n  No brief\./);
    assert.match(result.output, /Active decisions \(0\):\n  None\./);
    assert.match(result.output, /Current and recent work items \(0\):\n  None\./);
  }
});

test("task context emits its structured payload in the CLI top-level data field", (t) => {
  const { root, store, options } = fixture(t);
  const task = createTask(store, options, "Machine-readable context");
  const response = JSON.parse(execFileSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "--json", "task", "context", task.id],
    { encoding: "utf8", env: { ...process.env, TASKMUX_HOME: root } }
  ));

  assert.equal(response.ok, true);
  assert.equal(response.output, undefined);
  assert.equal(response.data.task.id, task.id);
  assert.equal(response.data.brief, null);
  assert.deepEqual(response.data.activeDecisions, []);
  assert.ok(Array.isArray(response.data.events));
});

test("task context is public, interactively selects any Task state, and completes Task IDs", async () => {
  assert.ok(listPublicCommandPaths().includes("task context"));
  const node = findCommandNode(["task", "context"]);
  assert.ok(node);
  const policy = findInteractionPolicy(node);
  assert.deepEqual(policy?.selectors, [{
    argumentIndex: 2,
    entity: "task",
    provider: "tasks",
    actionTarget: true
  }]);

  const tasks = [
    { id: "task-draft", title: "Draft", status: "draft" },
    { id: "task-completed", title: "Completed", status: "completed" },
    { id: "task-archived", title: "Archived", status: "archived" }
  ];
  const candidates = await resolveCompletionCandidates({
    words: ["task", "context"],
    current: "task-",
    ports: { call: (method) => method === "task.list" ? tasks : [] }
  });
  assert.deepEqual(candidates, tasks.map(({ id }) => id));
});

