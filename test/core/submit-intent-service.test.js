import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import {
  sendTaskMessageCommand,
  runTaskCommand,
  submitOperatorMessage
} from "../../dist/commands/taskCommands.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { stopTaskExecutionCommand } from "../../dist/commands/taskExecutionCommands.js";
import { admitStoredTaskActivation } from "../../dist/task/taskActivationService.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";
import { pendingCompletionMessages } from "../../dist/task/completionReadiness.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";

/**
 * Integration coverage for the task-32 Requirement A shared submission service,
 * driven end to end through the public commands on a real SqliteTaskStore. The
 * pure decision layer is exhausted in submit-intent-routing.test.js; this file
 * proves the transaction actually saves the message, writes (or withholds) the
 * planning-entered fact, records a develop activation with the right origin and
 * identity, and never pre-enqueues a Draft Leader when it activates (§2.1–2.5).
 */

const now = () => new Date("2026-09-12T00:00:00.000Z");
// A plain terminal with no managed Session env resolves to user authority.
const userEnv = sanitizedTestEnv();

function newStore(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-submit-intent-"));
  const store = new SqliteTaskStore(join(root, "home"));
  store.workspaceRoot = join(root, "workspace");
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return store;
}

function newDraft(store, title = "Requirement A draft") {
  const task = createTask(store.nextTaskId(), title, now());
  store.saveTask(task);
  return task;
}

/**
 * Configure the global leader role and default agent, so createTaskAggregate can
 * mint a Draft's leader Role. Only the no-taskId submitOperatorMessage path needs
 * this; every other test drives an already-created Draft.
 */
function provisionLeader(store, workspace) {
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  store.saveConfiguredAgent(createConfiguredAgent("codex", "codex", "codex", [], [], now()));
  store.saveGlobalRole(createGlobalRole("leader", [binding], "codex", workspace, now()));
  store.saveConfig({ ...store.getConfig(), defaultAgent: "codex", defaultWorkspace: workspace });
}

function userSubmit(store, taskId, body, intent) {
  return sendTaskMessageCommand(store, taskId, body,
    { environment: userEnv, now }, undefined, intent);
}

function findMessage(store, taskId, messageId) {
  return store.listMessages(taskId).find((message) => message.id === messageId);
}

function events(store, taskId, type) {
  return store.listEvents(taskId).filter((event) => event.type === type);
}

/** The leader Role mailbox holds pending work — i.e. a Leader wake was queued. */
function leaderHasPending(store, taskId) {
  const mailbox = store.getWorkMailbox({ kind: "role", taskId, roleName: "leader" });
  return mailbox !== null && mailbox.pending !== null;
}

/** The Task mailbox holds pending work — i.e. activation processing was queued. */
function taskMailboxHasPending(store, taskId) {
  const mailbox = store.getWorkMailbox({ kind: "task", taskId });
  return mailbox !== null && mailbox.pending !== null;
}

test("record submission saves only: no planning-entered event, no Leader wake", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  const result = userSubmit(store, task.id, "just context", "record");

  assert.equal(result.feedback.saved.messageId, result.message.id);
  assert.equal(result.feedback.phase, "draft-unplanned");
  assert.equal(result.feedback.planning, "none");
  assert.equal(result.feedback.delivery, "none");
  assert.equal(result.queuedForLeader, false);
  assert.equal(events(store, task.id, "task.planning-entered").length, 0);
  assert.equal(leaderHasPending(store, task.id), false);
  // The message is persisted with its intent recorded, never re-derived.
  const saved = findMessage(store, task.id, result.message.id);
  assert.equal(saved.intent, "record");
  assert.equal(saved.kind, "user");
  runTaskCommand(["message", "update", `${task.id}/${saved.id}`, "edited context"],
    store, { environment: userEnv, now });
  assert.equal(findMessage(store, task.id, saved.id).intent, "record");
  assert.equal(leaderHasPending(store, task.id), false, "Editing save-only context cannot authorize a Leader wake.");
  assert.equal(events(store, task.id, "task.planning-entered").length, 0);
  // A later explicit handoff may queue the saved context. Completion reads
  // that pending reference rather than treating record intent as a permanent veto.
  enqueueWork(store, { kind: "role", taskId: task.id, roleName: "leader" },
    "explicit-handoff", now(), [{ type: "message", taskId: task.id, id: saved.id }]);
  assert.deepEqual(pendingCompletionMessages(store, task.id).map(message => message.id), [saved.id]);
});

test("discuss submission enters planning: one planning-entered event, Leader queued", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  const result = userSubmit(store, task.id, "let's plan this", "discuss");

  assert.equal(result.feedback.planning, "entered");
  assert.equal(result.feedback.phase, "draft-planning");
  assert.equal(result.feedback.delivery, "queued");
  assert.equal(result.queuedForLeader, true);
  assert.equal(leaderHasPending(store, task.id), true);
  const entered = events(store, task.id, "task.planning-entered");
  assert.equal(entered.length, 1);
  assert.equal(entered[0].payload.messageId, result.message.id);
  assert.equal(entered[0].payload.intent, "discuss");
});

test("a second discuss continues planning without a second planning-entered event", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  userSubmit(store, task.id, "first", "discuss");
  const second = userSubmit(store, task.id, "second", "discuss");

  assert.equal(second.feedback.planning, "continued");
  assert.equal(second.feedback.phase, "draft-planning");
  assert.equal(second.queuedForLeader, true);
  // Derivation is monotonic: still exactly one planning-entered fact.
  assert.equal(events(store, task.id, "task.planning-entered").length, 1);
});

test("an omitted intent defaults to discuss and enters planning", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  const result = userSubmit(store, task.id, "no explicit intent", undefined);

  assert.equal(result.feedback.planning, "entered");
  assert.equal(findMessage(store, task.id, result.message.id).intent, "discuss");
});

test("develop on an unplanned Draft records a submit-develop activation and queues only activation", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  const result = userSubmit(store, task.id, "build it", "develop");

  assert.equal(result.feedback.activation, "requested");
  assert.equal(result.feedback.planning, "none");
  // develop never pre-enqueues a Draft Leader (§2.3): delivery stays none and the
  // Leader mailbox holds no wake — only the Task mailbox gets activation work.
  assert.equal(result.feedback.delivery, "none");
  assert.equal(result.queuedForLeader, false);
  assert.equal(leaderHasPending(store, task.id), false);
  assert.equal(taskMailboxHasPending(store, task.id), true);
  assert.equal(events(store, task.id, "task.planning-entered").length, 0);

  const request = store.getTask(task.id).activationRequest;
  assert.notEqual(request, undefined);
  assert.equal(request.disposition, "pending");
  assert.equal(request.startMode, "immediate");
  assert.equal(request.environmentPlan.kind, "empty");
  assert.equal(request.operation.requestId, `submit-${result.message.id}`);
  assert.equal(admitStoredTaskActivation(store, task.id).disposition, "ready");
  // The request is recorded but Task.status is still the only lifecycle: the
  // shared service records the request and queues processing; it does not flip
  // the Task to active inside the submission transaction.
  assert.equal(store.getTask(task.id).status, "draft");
});

test("a repeated develop submission never creates a second activation request", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  const first = userSubmit(store, task.id, "build it", "develop");
  const firstRequestId = store.getTask(task.id).activationRequest.operation.requestId;

  // A fresh develop message on the same still-unplanned, still-pending Draft is
  // routed as await-activation and references the existing request rather than
  // recording a second one (§2.1 pending / §2.3 dedup).
  const second = userSubmit(store, task.id, "build it again", "develop");
  assert.equal(second.feedback.activation, "pending");
  assert.notEqual(second.message.id, first.message.id);
  assert.equal(store.getTask(task.id).activationRequest.operation.requestId, firstRequestId);
  assert.equal(second.queuedForLeader, false);
});

test("develop on a planning Draft needs manual activation, never a new activation", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  userSubmit(store, task.id, "let's plan", "discuss");
  const result = userSubmit(store, task.id, "now build it", "develop");

  assert.equal(result.feedback.activation, "manual-required");
  assert.deepEqual(result.feedback.nextStep, { kind: "activate-manually", taskId: task.id });
  // No activation request was recorded by a develop that reached a planned Draft.
  assert.equal(store.getTask(task.id).activationRequest, undefined);
  assert.equal(result.queuedForLeader, false);
});

test("develop on a stopped-gate Draft saves the message but records no activation", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  stopTaskExecutionCommand({ taskId: task.id, reason: "hold" }, store, { environment: userEnv, now });
  const result = userSubmit(store, task.id, "build it", "develop");

  assert.equal(result.feedback.activation, "execution-stopped");
  assert.deepEqual(result.feedback.nextStep, { kind: "start-execution", taskId: task.id });
  // The saved facet still holds even though nothing was activated (§2.5).
  assert.equal(findMessage(store, task.id, result.message.id).body, "build it");
  assert.equal(store.getTask(task.id).activationRequest, undefined);
});

test("active Task submissions preserve execution state for both discuss and develop", (t) => {
  const store = newStore(t);
  const active = activateTask(createTask(store.nextTaskId(), "Active task", now()), now());
  store.saveTask(active);
  for (const intent of ["discuss", "develop"]) {
    const result = userSubmit(store, active.id, "a delivery note", intent);
    assert.equal(result.feedback.phase, "active");
    assert.equal(result.feedback.planning, "none");
    assert.equal(result.feedback.delivery, "queued");
    assert.equal(result.queuedForLeader, true);
    assert.equal(store.getTask(active.id).status, "active");
    assert.equal(events(store, active.id, "task.planning-entered").length, 0);
    assert.equal(store.getTask(active.id).activationRequest, undefined);
  }
});

test("an operator submission carries user authority and enters planning like a user discuss", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  const output = submitOperatorMessage("plan via operator", task.id, store,
    { environment: userEnv, now }, "discuss");

  assert.ok(output.includes(task.id));
  const entered = events(store, task.id, "task.planning-entered");
  assert.equal(entered.length, 1);
  // The saved message is an operator message, not a user message.
  const message = findMessage(store, task.id, entered[0].payload.messageId);
  assert.equal(message.kind, "operator");
});

test("submitOperatorMessage with no task creates a fresh Draft and routes its first submission", (t) => {
  const store = newStore(t);
  provisionLeader(store, store.workspaceRoot);
  const output = submitOperatorMessage("brand new requirement", undefined, store,
    { environment: userEnv, now }, "discuss");
  assert.match(output, /Created Draft task/);
  // The first submission on the brand-new Draft is routed through the shared
  // service exactly as the §2.1 table prescribes for an unplanned Draft: discuss
  // enters planning and records the fact in the same transaction.
  const created = store.getTask("task-1");
  assert.notEqual(created, null);
  assert.equal(created.status, "draft");
  assert.equal(events(store, created.id, "task.planning-entered").length, 1);
});

test("a managed Task Session cannot carry a develop submission and persists nothing", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  // A managed Leader Session environment must never acquire develop authority
  // through an intent argument (§2.5). Whether it is refused at the native-Session
  // authority check or the intent guard, the invariant is the same: the develop
  // submission is rejected and leaves no message and no activation behind.
  const leaderEnv = sanitizedTestEnv({
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: task.id,
    YUI_ROLE: "leader"
  });
  assert.throws(() => sendTaskMessageCommand(store, task.id, "sneaky",
    { environment: leaderEnv, now }, undefined, "develop"));
  assert.equal(store.getTask(task.id).activationRequest, undefined);
  assert.equal(store.listMessages(task.id).length, 0);
  assert.equal(events(store, task.id, "task.planning-entered").length, 0);
});
