import assert from "node:assert/strict";
import test from "node:test";

import {
  completeWorkExecution,
  enqueueWork
} from "../../dist/coordination/workMailboxQueue.js";
import {
  bindExecution,
  claimPending,
  createWorkMailbox
} from "../../dist/coordination/workMailbox.js";

function memoryStore(initial = []) {
  const mailboxes = new Map(initial.map((mailbox) => [JSON.stringify(mailbox.target), mailbox]));
  return {
    getWorkMailbox(target) {
      return mailboxes.get(JSON.stringify(target)) ?? null;
    },
    saveWorkMailbox(mailbox) {
      mailboxes.set(JSON.stringify(mailbox.target), mailbox);
    }
  };
}

test("enqueueWork creates and merges a mailbox using the store", () => {
  const store = memoryStore();
  const target = { kind: "role", taskId: "task-1", roleName: "leader" };

  enqueueWork(store, target, "operator-input", new Date("2026-07-22T01:00:00.000Z"), [
    { type: "message", id: "message-1" }
  ]);
  const mailbox = enqueueWork(store, target, "brief-updated", new Date("2026-07-22T01:00:01.000Z"));

  assert.deepEqual(mailbox.pending.reasons, ["operator-input", "brief-updated"]);
  assert.deepEqual(mailbox.pending.refs, [{ type: "message", id: "message-1" }]);
  assert.equal(mailbox.pending.requestCount, 2);
});

test("completeWorkExecution only completes the processing batch bound to the execution", () => {
  const target = { kind: "role", taskId: "task-1", roleName: "worker" };
  const pending = enqueueWork(memoryStore(), target, "dispatch", new Date("2026-07-22T01:00:00.000Z"));
  const processing = bindExecution(
    claimPending(pending, {
      batchId: "batch-1",
      owner: "controller",
      startedAt: "2026-07-22T01:00:01.000Z"
    }),
    "batch-1",
    { type: "run", id: "run-1" }
  );
  const store = memoryStore([processing]);

  assert.equal(completeWorkExecution(store, target, { type: "run", id: "run-other" }), false);
  assert.notEqual(store.getWorkMailbox(target).processing, null);
  assert.equal(completeWorkExecution(store, target, { type: "run", id: "run-1" }), true);
  assert.equal(store.getWorkMailbox(target).processing, null);
});
