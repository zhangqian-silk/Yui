import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import {
  sendTaskMessageCommand,
  submitOperatorMessage
} from "../../dist/commands/taskCommands.js";
import {
  startTaskExecutionCommand,
  stopTaskExecutionCommand
} from "../../dist/commands/taskExecutionCommands.js";
import { cancelTaskActivation } from "../../dist/task/taskActivationService.js";
import { createTask } from "../../dist/task/task.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

/**
 * task-32 §2.3 keyed submission idempotency, driven end to end through the public
 * submission commands on a real SqliteTaskStore. The narrow persistent fact is
 * the saved Message's own submission key: a retry under the same key returns the
 * original Message and routing with no second Message, planning entry, activation
 * request or Leader wake; a same-key retry with different input is a conflict.
 *
 * The routing table itself is proven in submit-intent-routing/-service; this file
 * covers only what keying adds — replay identity, effect-suppression on replay,
 * conflict detection, and the task-less operator-create dedup.
 */

const now = () => new Date("2026-09-12T00:00:00.000Z");
const userEnv = sanitizedTestEnv();

function newStore(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-submit-idem-"));
  const store = new SqliteTaskStore(join(root, "home"));
  store.workspaceRoot = join(root, "workspace");
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return store;
}

function newDraft(store, title = "Idempotency draft") {
  const task = createTask(store.nextTaskId(), title, now());
  store.saveTask(task);
  return task;
}

function provisionLeader(store, workspace) {
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  store.saveConfiguredAgent(createConfiguredAgent("codex", "codex", "codex", [], [], now()));
  store.saveGlobalRole(createGlobalRole("leader", [binding], "codex", workspace, now()));
  store.saveConfig({ ...store.getConfig(), defaultAgent: "codex", defaultWorkspace: workspace });
}

function submit(store, taskId, body, intent, key) {
  return sendTaskMessageCommand(store, taskId, body,
    { environment: userEnv, now }, undefined, intent, key);
}

test("a same-key discuss retry replays the original message and enters planning once", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  const first = submit(store, task.id, "let's plan", "discuss", "key-1");
  const replay = submit(store, task.id, "let's plan", "discuss", "key-1");

  // Same Message, not a second one, and only one saved on the Task.
  assert.equal(replay.message.id, first.message.id);
  assert.equal(store.listMessages(task.id).length, 1);
  // The routing result is reproduced from the durable planning-entered fact.
  assert.equal(replay.feedback.planning, "entered");
  assert.equal(replay.feedback.phase, "draft-planning");
  // Exactly one planning-entered event; the replay wrote nothing.
  assert.equal(
    store.listEvents(task.id).filter((e) => e.type === "task.planning-entered").length,
    1
  );
  // The replay itself queues no fresh Leader wake.
  assert.equal(replay.queuedForLeader, false);
});

test("a same-key retry with different input is a conflict, not an overwrite", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  submit(store, task.id, "original body", "discuss", "key-1");

  assert.throws(
    () => submit(store, task.id, "different body", "discuss", "key-1"),
    (error) => error.name === "StorageConflictError"
  );
  // The original message is untouched and no second message was appended.
  const messages = store.listMessages(task.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, "original body");
});

test("a same-key retry with a different intent is a conflict", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  submit(store, task.id, "same body", "discuss", "key-1");

  assert.throws(
    () => submit(store, task.id, "same body", "develop", "key-1"),
    (error) => error.name === "StorageConflictError"
  );
});

test("a develop retry under the same key replays the original activation, never a second", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  const first = submit(store, task.id, "build it", "develop", "key-1");
  const firstRequestId = store.getTask(task.id).activationRequest.operation.requestId;

  const replay = submit(store, task.id, "build it", "develop", "key-1");
  assert.equal(replay.message.id, first.message.id);
  assert.equal(replay.feedback.activation, "requested");
  // The activation request is still the original one; no second request appeared.
  assert.equal(store.getTask(task.id).activationRequest.operation.requestId, firstRequestId);
  assert.equal(
    store.listEvents(task.id).filter((e) => e.type === "task.activation-requested").length,
    1
  );
});

test("the submission key is persisted on the saved message", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  const result = submit(store, task.id, "keep this", "record", "key-1");
  const saved = store.listMessages(task.id).find((m) => m.id === result.message.id);
  assert.equal(saved.submissionKey, "key-1");
});

test("distinct keys on the same Task are independent submissions", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  submit(store, task.id, "first", "record", "key-1");
  submit(store, task.id, "second", "record", "key-2");
  assert.equal(store.listMessages(task.id).length, 2);
});

test("a task-less operator submit is idempotent across the create boundary", (t) => {
  const store = newStore(t);
  provisionLeader(store, store.workspaceRoot);
  submitOperatorMessage("brand new requirement", undefined, store,
    { environment: userEnv, now }, "discuss", "key-1");
  submitOperatorMessage("brand new requirement", undefined, store,
    { environment: userEnv, now }, "discuss", "key-1");

  // Only one Draft was created; the retry replayed into the same one.
  const drafts = store.listTasks().filter((task) => task.status === "draft");
  assert.equal(drafts.length, 1);
  assert.equal(store.listMessages(drafts[0].id).length, 1);
});

// P1a regression (message-11): a replay must reproduce the disposition the
// original submission recorded, never recompute it from the Task's *current*
// state. A state change between the first submission and the retry is exactly what
// used to fabricate a false "requested" receipt.

test("a develop blocked by a stopped gate still replays 'blocked' after the gate is enabled", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  stopTaskExecutionCommand({ taskId: task.id, reason: "hold" }, store, { environment: userEnv, now });

  // First submit: unplanned Draft, gate stopped -> saved only, no activation request.
  const first = submit(store, task.id, "build it", "develop", "key-1");
  assert.equal(first.feedback.activation, "execution-stopped");
  assert.equal(store.getTask(task.id).activationRequest, undefined);

  // The gate is enabled after the fact. Recomputing routing now would resolve to
  // `activate`/`requested`, but no request was ever recorded.
  startTaskExecutionCommand(task.id, store, { environment: userEnv, now });

  const replay = submit(store, task.id, "build it", "develop", "key-1");
  assert.equal(replay.message.id, first.message.id);
  // Reproduced from the receipt: still execution-stopped, still no request, no wake.
  assert.equal(replay.feedback.activation, "execution-stopped");
  assert.deepEqual(replay.feedback.nextStep, { kind: "start-execution", taskId: task.id });
  assert.equal(store.getTask(task.id).activationRequest, undefined);
  assert.equal(
    store.listEvents(task.id).filter((e) => e.type === "task.activation-requested").length,
    0
  );
  assert.equal(replay.queuedForLeader, false);
});

test("a develop retry after its pending activation was cancelled replays 'requested', not a rebuilt state", (t) => {
  const store = newStore(t);
  const task = newDraft(store);

  // First submit records the activation request and reports it as requested.
  const first = submit(store, task.id, "build it", "develop", "key-1");
  assert.equal(first.feedback.activation, "requested");
  const requestId = store.getTask(task.id).activationRequest.operation.requestId;

  // The pending request is cancelled out of band; draftActivationState now reads
  // `none`, so a recompute would fabricate a fresh activate/requested outcome.
  cancelTaskActivation(store, task.id, requestId, "operator cancelled", now());
  assert.equal(store.getTask(task.id).activationRequest.disposition, "cancelled");

  const replay = submit(store, task.id, "build it", "develop", "key-1");
  assert.equal(replay.message.id, first.message.id);
  // The receipt still names the original request; no second request is minted.
  assert.equal(replay.feedback.activation, "requested");
  assert.equal(store.getTask(task.id).activationRequest.operation.requestId, requestId);
  assert.equal(store.getTask(task.id).activationRequest.disposition, "cancelled");
  assert.equal(
    store.listEvents(task.id).filter((e) => e.type === "task.activation-requested").length,
    1
  );
});

test("the receipt records the routing and target the submission actually received", (t) => {
  const store = newStore(t);
  const task = newDraft(store);
  const result = submit(store, task.id, "let's plan", "discuss", "key-1");
  const saved = store.listMessages(task.id).find((m) => m.id === result.message.id);

  assert.equal(saved.submissionReceipt.routing.kind, "enter-planning");
  assert.deepEqual(saved.submissionReceipt.target, { kind: "task", taskId: task.id });
  assert.equal(saved.submissionReceipt.feedback.planning, "entered");
});

// P1b regression (message-11): a key is bound to its first input's target. A key
// first used on a specific Task cannot be reused by a task-less create, and a
// task-less create key locates the original created Draft, never an addressed
// message that merely shares the key.

test("a key bound to a specific Task conflicts when reused by a task-less create", (t) => {
  const store = newStore(t);
  provisionLeader(store, store.workspaceRoot);
  const task = newDraft(store);
  submit(store, task.id, "addressed body", "discuss", "shared-key");

  assert.throws(
    () => submitOperatorMessage("addressed body", undefined, store,
      { environment: userEnv, now }, "discuss", "shared-key"),
    (error) => error.name === "StorageConflictError"
  );
  // No new Draft was created by the rejected task-less create.
  const drafts = store.listTasks().filter((t2) => t2.id !== task.id && t2.status === "draft");
  assert.equal(drafts.length, 0);
});

test("a task-less create retry replays the original created Draft, not an addressed same-key message", (t) => {
  const store = newStore(t);
  provisionLeader(store, store.workspaceRoot);

  // A task-less create binds `create-key` to the create target.
  submitOperatorMessage("new requirement", undefined, store,
    { environment: userEnv, now }, "discuss", "create-key");
  const created = store.listTasks().filter((task) => task.status === "draft");
  assert.equal(created.length, 1);
  const createdId = created[0].id;

  // An unrelated Task carries the same key value bound to *its* target. The
  // task-less retry must ignore it and land on the create target's Draft.
  const other = newDraft(store, "Unrelated draft");
  submit(store, other.id, "unrelated body", "discuss", "create-key");

  submitOperatorMessage("new requirement", undefined, store,
    { environment: userEnv, now }, "discuss", "create-key");

  // Still exactly one create-target Draft, with its single original message.
  const createTargets = store.listTasks().filter((task) =>
    task.status === "draft"
    && store.listMessages(task.id).some((m) => m.submissionReceipt?.target.kind === "create"));
  assert.equal(createTargets.length, 1);
  assert.equal(createTargets[0].id, createdId);
  assert.equal(store.listMessages(createdId).length, 1);
});
