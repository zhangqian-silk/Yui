import assert from "node:assert/strict";
import test from "node:test";

import {
  bindExecution,
  claimPending,
  completeProcessing,
  createWorkMailbox,
  enqueueSignal,
  mailboxTargetKey,
  releaseProcessing,
  validateWorkMailbox
} from "../../dist/coordination/workMailbox.js";

const FIRST = "2026-07-22T01:00:00.000Z";
const SECOND = "2026-07-22T01:01:00.000Z";
const THIRD = "2026-07-22T01:02:00.000Z";

const taskTarget = { kind: "task", taskId: "task-1" };
const roleTarget = { kind: "role", taskId: "task-1", roleName: "leader" };
const roleRuntimeTarget = {
  kind: "role-runtime",
  taskId: "task-1",
  roleName: "leader"
};
const globalRoleRuntimeTarget = {
  kind: "global-role-runtime",
  roleName: "operator"
};
const operatorTarget = { kind: "operator" };

test("WorkMailbox supports task, role, role-runtime, and operator targets", () => {
  assert.deepEqual(createWorkMailbox(taskTarget), {
    schemaVersion: 1,
    target: taskTarget,
    nextSequence: 1,
    processing: null,
    pending: null
  });
  assert.deepEqual(createWorkMailbox(roleTarget).target, roleTarget);
  assert.deepEqual(createWorkMailbox(roleRuntimeTarget).target, roleRuntimeTarget);
  assert.deepEqual(
    createWorkMailbox(globalRoleRuntimeTarget).target,
    globalRoleRuntimeTarget
  );
  assert.deepEqual(createWorkMailbox(operatorTarget).target, operatorTarget);
});

test("mailbox targets have stable collision-free canonical keys", () => {
  assert.equal(mailboxTargetKey(operatorTarget), "operator");
  assert.equal(mailboxTargetKey(taskTarget), "task/task-1");
  assert.equal(mailboxTargetKey(roleTarget), "role/task-1/leader");
  assert.equal(
    mailboxTargetKey(roleRuntimeTarget),
    "role-runtime/task-1/leader"
  );
  assert.equal(
    mailboxTargetKey(globalRoleRuntimeTarget),
    "global-role-runtime/operator"
  );
  assert.equal(
    mailboxTargetKey({ kind: "role", taskId: "task/1", roleName: "review lead" }),
    "role/task%2F1/review%20lead"
  );
});

test("persisted WorkMailbox records use a strict versioned shape", () => {
  const mailbox = createWorkMailbox(taskTarget);
  assert.deepEqual(validateWorkMailbox(mailbox), mailbox);
  assert.throws(() => validateWorkMailbox({ ...mailbox, schemaVersion: 2 }), /schemaVersion 1/i);
  assert.throws(() => validateWorkMailbox({ ...mailbox, extra: true }), /unknown field.*extra/i);
  const queued = enqueueSignal(mailbox, {
    reason: "task-activated",
    refs: [],
    occurredAt: FIRST
  });
  assert.throws(() => validateWorkMailbox({
    ...queued,
    pending: { ...queued.pending, availableAt: SECOND }
  }), /unknown field.*availableAt/i);
});

test("enqueueSignal immutably coalesces pending reasons and entity references", () => {
  const empty = createWorkMailbox(roleTarget);
  const first = enqueueSignal(empty, {
    reason: "worker-yield",
    refs: [{ type: "run", taskId: "task-1", id: "agent-run-1" }],
    occurredAt: FIRST
  });
  const second = enqueueSignal(first, {
    reason: "worker-yield",
    refs: [
      { type: "run", taskId: "task-1", id: "agent-run-1" },
      { type: "work-item", taskId: "task-1", id: "work-item-2" }
    ],
    occurredAt: SECOND
  });

  assert.equal(empty.pending, null);
  assert.equal(empty.nextSequence, 1);
  assert.notEqual(second, first);
  assert.deepEqual(second.pending, {
    fromSequence: 1,
    toSequence: 2,
    reasons: ["worker-yield"],
    refs: [
      { type: "run", taskId: "task-1", id: "agent-run-1" },
      { type: "work-item", taskId: "task-1", id: "work-item-2" }
    ],
    requestCount: 2,
    firstQueuedAt: FIRST,
    lastQueuedAt: SECOND
  });
  assert.equal(second.nextSequence, 3);
});

test("claim freezes pending and signals arriving during processing form the next batch", () => {
  const queued = enqueueSignal(createWorkMailbox(roleTarget), {
    reason: "activated",
    refs: [{ type: "task", id: "task-1" }],
    occurredAt: FIRST
  });
  const claimed = claimPending(queued, {
    batchId: "batch-1",
    owner: "controller-1",
    startedAt: SECOND
  });

  assert.equal(queued.processing, null);
  assert.equal(claimed.pending, null);
  assert.deepEqual(claimed.processing, {
    batchId: "batch-1",
    batch: queued.pending,
    owner: "controller-1",
    startedAt: SECOND
  });

  const signalled = enqueueSignal(claimed, {
    reason: "activated",
    refs: [{ type: "run", taskId: "task-1", id: "agent-run-2" }],
    occurredAt: THIRD
  });
  assert.deepEqual(signalled.processing, claimed.processing);
  assert.deepEqual(signalled.pending, {
    fromSequence: 2,
    toSequence: 2,
    reasons: ["activated"],
    refs: [{ type: "run", taskId: "task-1", id: "agent-run-2" }],
    requestCount: 1,
    firstQueuedAt: THIRD,
    lastQueuedAt: THIRD
  });
});

test("claim requires pending work and rejects concurrent processing", () => {
  const empty = createWorkMailbox(taskTarget);
  assert.throws(() => claimPending(empty, {
    batchId: "batch-1",
    owner: "controller-1",
    startedAt: FIRST
  }), /no pending work/i);

  const queued = enqueueSignal(empty, {
    reason: "activated",
    refs: [],
    occurredAt: FIRST
  });
  const claimed = claimPending(queued, {
    batchId: "batch-1",
    owner: "controller-1",
    startedAt: SECOND
  });
  const withNext = enqueueSignal(claimed, {
    reason: "workspace-changed",
    refs: [],
    occurredAt: THIRD
  });
  assert.throws(() => claimPending(withNext, {
    batchId: "batch-2",
    owner: "controller-2",
    startedAt: THIRD
  }), /already processing/i);
});

test("bindExecution and completeProcessing use the batch id as a compare-and-set fence", () => {
  const queued = enqueueSignal(createWorkMailbox(roleTarget), {
    reason: "run-pending",
    refs: [{ type: "run", taskId: "task-1", id: "agent-run-1" }],
    occurredAt: FIRST
  });
  const claimed = claimPending(queued, {
    batchId: "batch-1",
    owner: "controller-1",
    startedAt: SECOND
  });

  assert.throws(
    () => bindExecution(claimed, "stale-batch", {
      type: "run", taskId: "task-1", id: "agent-run-1"
    }),
    /batch id/i
  );
  const bound = bindExecution(claimed, "batch-1", {
    type: "run", taskId: "task-1", id: "agent-run-1"
  });
  assert.equal(claimed.processing.executionRef, undefined);
  assert.deepEqual(bound.processing.executionRef, {
    type: "run", taskId: "task-1", id: "agent-run-1"
  });
  assert.throws(() => completeProcessing(bound, "stale-batch"), /batch id/i);

  const withNext = enqueueSignal(bound, {
    reason: "user-message",
    refs: [{ type: "message", taskId: "task-1", id: "message-1" }],
    occurredAt: THIRD
  });
  const completed = completeProcessing(withNext, "batch-1");
  assert.equal(completed.processing, null);
  assert.deepEqual(completed.pending, withNext.pending);
});

test("releaseProcessing merges the frozen batch before signals in the next pending batch", () => {
  const first = enqueueSignal(createWorkMailbox(roleTarget), {
    reason: "worker-yield",
    refs: [{ type: "run", taskId: "task-1", id: "agent-run-1" }],
    occurredAt: FIRST
  });
  const claimed = claimPending(first, {
    batchId: "batch-1",
    owner: "controller-1",
    startedAt: SECOND
  });
  const withNext = enqueueSignal(claimed, {
    reason: "user-message",
    refs: [
      { type: "run", taskId: "task-1", id: "agent-run-1" },
      { type: "message", taskId: "task-1", id: "message-1" }
    ],
    occurredAt: THIRD
  });

  assert.throws(() => releaseProcessing(withNext, "stale-batch"), /batch id/i);
  const released = releaseProcessing(withNext, "batch-1");
  assert.equal(released.processing, null);
  assert.deepEqual(released.pending, {
    fromSequence: 1,
    toSequence: 2,
    reasons: ["worker-yield", "user-message"],
    refs: [
      { type: "run", taskId: "task-1", id: "agent-run-1" },
      { type: "message", taskId: "task-1", id: "message-1" }
    ],
    requestCount: 2,
    firstQueuedAt: FIRST,
    lastQueuedAt: THIRD
  });
  assert.deepEqual(withNext.processing, claimed.processing);
});
