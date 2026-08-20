import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  StorageConflictError,
  StorageRecordError
} from "../../dist/storage/taskStore.js";
import { openAsyncTaskStoreClient } from "../../dist/storage/storeRpc.js";

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), "yui-persistence-worker-"));
}

function makeTask(id, overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 4,
    id,
    title: "Test Task",
    projectBindings: [],
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function makeMessage(id, taskId, overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 3,
    id,
    taskId,
    kind: "role-result",
    author: { type: "role", roleName: "leader" },
    body: "hello world",
    createdAt: now,
    ...overrides
  };
}

function makeEvent(id, taskId, overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    id,
    taskId,
    type: "run.progress",
    payload: {},
    createdAt: now,
    ...overrides
  };
}

/** Poll a condition on the event loop until it holds or the deadline passes. */
async function waitFor(condition, { timeoutMs = 5000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Open a client and register its close on the test context. */
function openClient(home, options = {}) {
  const client = openAsyncTaskStoreClient(home, options);
  return client;
}

function outboxCount(home, requestId) {
  const db = new Database(join(home, "yui.db"), { readonly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE request_id = ?")
      .get(requestId);
    return row.n;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// CRUD round-trip
// ---------------------------------------------------------------------------

test("CRUD round-trip: task, message, event, revision", async (t) => {
  const home = temporaryHome();
  const store = openClient(home);
  t.after(() => store.close());

  const taskId = await store.nextTaskId();
  assert.ok(typeof taskId === "string" && taskId.length > 0);

  const task = makeTask(taskId, { title: "Round-trip Task" });
  await store.saveTask(task);

  const loaded = await store.getTask(taskId);
  assert.ok(loaded !== null);
  assert.equal(loaded.id, taskId);
  assert.equal(loaded.title, "Round-trip Task");
  assert.equal(loaded.status, "active");

  const messageId = await store.nextMessageId(taskId);
  await store.saveMessage(taskId, makeMessage(messageId, taskId, { body: "first" }));
  const messages = await store.listMessages(taskId);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, "first");

  const eventId = await store.nextEventId(taskId);
  await store.saveEvent(taskId, makeEvent(eventId, taskId));
  const events = await store.listEvents(taskId);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, eventId);

  const revision = await store.getRevision();
  assert.equal(typeof revision, "number");
  assert.ok(revision >= 3, "writes should bump the revision");
});

test("reads do not block on the writer (read pool)", async (t) => {
  const home = temporaryHome();
  const store = openClient(home);
  t.after(() => store.close());

  const taskId = await store.nextTaskId();
  await store.saveTask(makeTask(taskId));

  // Interleave reads and writes; reads use the read pool and must not deadlock
  // against the single writer.
  const reads = [];
  for (let i = 0; i < 8; i += 1) {
    reads.push(store.getTask(taskId));
  }
  const write = store.saveTask(makeTask(await store.nextTaskId(), { title: "concurrent" }));
  const results = await Promise.all([...reads, write]);
  assert.equal(results.length, 9);
  for (let i = 0; i < 8; i += 1) {
    assert.ok(results[i] !== null);
  }
});

// ---------------------------------------------------------------------------
// Backpressure
// ---------------------------------------------------------------------------

test("backpressure: bounded in-flight, callers await, socket keeps draining", async (t) => {
  const home = temporaryHome();
  const store = openClient(home, { maxInFlight: 2, maxQueue: 4 });
  t.after(() => store.close());

  const count = 12;
  const writes = [];
  for (let i = 0; i < count; i += 1) {
    const id = `bp-${i}`;
    // No await: flood the channel. The semaphore bounds in-flight to 2 and the
    // queue to 4; the rest wait on backpressure (callers await; the socket
    // keeps accepting and draining).
    writes.push(store.saveTask(makeTask(id, { title: `BP ${i}` })));
  }

  // The bound must never be exceeded while the burst is in flight.
  assert.ok(store.inFlight <= 2, `inFlight ${store.inFlight} exceeded maxInFlight 2`);

  await Promise.all(writes);

  // Every write landed: the socket drained the backlog without deadlock.
  for (let i = 0; i < count; i += 1) {
    const task = await store.getTask(`bp-${i}`);
    assert.ok(task !== null, `task bp-${i} missing`);
    assert.equal(task.title, `BP ${i}`);
  }
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test("cancellation: abort rolls back an open transaction (db unchanged)", async (t) => {
  const home = temporaryHome();
  const store = openClient(home);
  t.after(() => store.close());

  const taskIds = [];
  for (let i = 0; i < 10; i += 1) {
    taskIds.push(await store.nextTaskId());
  }
  const commands = taskIds.map((id) => ({
    op: "saveTask",
    args: [makeTask(id, { title: `Cancel ${id}` })]
  }));

  const controller = new AbortController();
  const promise = store.transactionAsync(commands, {
    signal: controller.signal,
    requestId: "cancel-batch"
  });

  // Wait until the batch request is in flight on the worker, then abort. The
  // worker checks shouldCancel before each command and before commit, so a
  // cancel that arrives before the batch starts (or mid-batch) always rolls
  // back. A blind setImmediate wait could race the commit under CI load.
  await waitFor(() => store.inFlight === 1, { label: "batch in flight" });
  controller.abort();

  await assert.rejects(promise, /abort|cancel/i);

  // The db is unchanged: none of the batch's tasks were committed.
  for (const id of taskIds) {
    const task = await store.getTask(id);
    assert.equal(task, null, `task ${id} should not exist after rollback`);
  }
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("idempotency: same requestId twice applies the effect once", async (t) => {
  const home = temporaryHome();
  const store = openClient(home);
  t.after(() => store.close());

  const taskId = await store.nextTaskId();
  await store.saveTask(makeTask(taskId, { title: "Idempotent" }));
  const messageId = await store.nextMessageId(taskId);
  const batch = [
    { op: "saveTask", args: [makeTask(taskId, { title: "Idempotent" })] },
    { op: "saveMessage", args: [taskId, makeMessage(messageId, taskId)] }
  ];

  const first = await store.transactionAsync(batch, { requestId: "idem-1" });
  assert.ok(Array.isArray(first), "first call returns the command results");

  // The retry is deduped by the durable outbox: the worker short-circuits
  // without re-executing the batch.
  const second = await store.transactionAsync(batch, { requestId: "idem-1" });
  assert.equal(second, undefined, "retried requestId is already-applied");

  // Exactly one effect: one task, one message, one outbox row.
  const task = await store.getTask(taskId);
  assert.ok(task !== null);
  assert.equal(task.title, "Idempotent");
  const messages = await store.listMessages(taskId);
  assert.equal(messages.length, 1);
  assert.equal(outboxCount(home, "idem-1"), 1);
});

test("idempotency: individual write call with requestId is deduped", async (t) => {
  const home = temporaryHome();
  const store = openClient(home);
  t.after(() => store.close());

  const taskId = await store.nextTaskId();
  const task = makeTask(taskId, { title: "Single Idem" });

  await store.saveTask(task, { requestId: "single-idem" });
  const retry = await store.saveTask(task, { requestId: "single-idem" });
  assert.equal(retry, undefined, "retried write is already-applied");

  const loaded = await store.getTask(taskId);
  assert.ok(loaded !== null);
  assert.equal(loaded.title, "Single Idem");
  assert.equal(outboxCount(home, "single-idem"), 1);
});

// ---------------------------------------------------------------------------
// Fault injection: kill the worker mid-op, restart, replay
// ---------------------------------------------------------------------------

test("fault injection: worker crash mid-op restarts and replays without loss or double-apply", async (t) => {
  const home = temporaryHome();
  const store = openClient(home);
  t.after(() => store.close());

  const taskId = await store.nextTaskId();
  const batch = [
    { op: "saveTask", args: [makeTask(taskId, { title: "Crash Recovery" })] }
  ];

  // Start the write, then kill the worker before it responds. The client
  // observes the non-zero exit, restarts the worker, and replays the
  // unacknowledged request with the same requestId.
  const promise = store.transactionAsync(batch, { requestId: "crash-1" });
  await store.crashForTest();

  // The write must not be lost: it resolves after restart + replay.
  const result = await promise;
  // Either the original committed before the crash (already-applied on replay)
  // or the replay executed it; both are exactly-once.
  assert.ok(result === undefined || Array.isArray(result));

  const task = await store.getTask(taskId);
  assert.ok(task !== null, "write must survive the crash");
  assert.equal(task.title, "Crash Recovery");
  // No double-apply: exactly one outbox row for the requestId.
  assert.equal(outboxCount(home, "crash-1"), 1);
});

test("fault injection: in-flight reads survive a worker restart", async (t) => {
  const home = temporaryHome();
  const store = openClient(home);
  t.after(() => store.close());

  const taskId = await store.nextTaskId();
  await store.saveTask(makeTask(taskId, { title: "Read Survives" }));

  // Start a read, kill the worker, and verify the read still resolves after
  // the restart (the client replays unacknowledged requests).
  const promise = store.getTask(taskId);
  await store.crashForTest();
  const task = await promise;
  assert.ok(task !== null);
  assert.equal(task.title, "Read Survives");
});

// ---------------------------------------------------------------------------
// transactionAsync batch atomicity
// ---------------------------------------------------------------------------

test("transactionAsync: a failing command rolls back the whole batch", async (t) => {
  const home = temporaryHome();
  const store = openClient(home);
  t.after(() => store.close());

  const taskId = await store.nextTaskId();
  await store.saveTask(makeTask(taskId, { title: "Atomic" }));
  const messageId = await store.nextMessageId(taskId);
  const batch = [
    { op: "saveTask", args: [makeTask(taskId, { title: "Atomic" })] },
    { op: "saveMessage", args: [taskId, makeMessage(messageId, taskId)] },
    // An unknown op forces #executeCommand to throw mid-batch.
    { op: "thisMethodDoesNotExist", args: [] }
  ];

  await assert.rejects(
    store.transactionAsync(batch, { requestId: "atomic-fail" }),
    StorageRecordError
  );

  // The whole batch rolled back: the message (inserted by the batch) did not
  // commit. The task was saved before the batch, so it is unaffected.
  const task = await store.getTask(taskId);
  assert.ok(task !== null, "pre-saved task is unaffected by the batch rollback");
  const messages = await store.listMessages(taskId);
  assert.equal(messages.length, 0, "message should not exist after batch rollback");
});

test("transactionAsync: a successful batch commits all commands atomically", async (t) => {
  const home = temporaryHome();
  const store = openClient(home);
  t.after(() => store.close());

  const taskId = await store.nextTaskId();
  await store.saveTask(makeTask(taskId, { title: "All In" }));
  const messageId = await store.nextMessageId(taskId);
  const eventId = await store.nextEventId(taskId);
  const batch = [
    { op: "saveTask", args: [makeTask(taskId, { title: "All In" })] },
    { op: "saveMessage", args: [taskId, makeMessage(messageId, taskId)] },
    { op: "saveEvent", args: [taskId, makeEvent(eventId, taskId)] }
  ];

  const results = await store.transactionAsync(batch, { requestId: "atomic-ok" });
  assert.equal(results.length, 3);

  const task = await store.getTask(taskId);
  assert.ok(task !== null);
  assert.equal(task.title, "All In");
  const messages = await store.listMessages(taskId);
  assert.equal(messages.length, 1);
  const events = await store.listEvents(taskId);
  assert.equal(events.length, 1);
});

// ---------------------------------------------------------------------------
// Revision CAS
// ---------------------------------------------------------------------------

test("revision CAS: a stale expectedRevision fails with StorageConflictError", async (t) => {
  const home = temporaryHome();
  const store = openClient(home);
  t.after(() => store.close());

  const taskA = makeTask(await store.nextTaskId(), { title: "CAS A" });
  const taskB = makeTask(await store.nextTaskId(), { title: "CAS B" });

  const revision = await store.getRevision();

  // The first write succeeds at the current revision and bumps it.
  await store.transactionAsync(
    [{ op: "saveTask", args: [taskA] }],
    { expectedRevision: revision }
  );

  // The second write uses the now-stale revision and must fail the CAS.
  await assert.rejects(
    store.transactionAsync(
      [{ op: "saveTask", args: [taskB] }],
      { expectedRevision: revision }
    ),
    StorageConflictError
  );

  // The conflicting write did not commit.
  const taskBLoaded = await store.getTask(taskB.id);
  assert.equal(taskBLoaded, null, "conflicting write must not commit");
  const taskALoaded = await store.getTask(taskA.id);
  assert.ok(taskALoaded !== null, "the first write must commit");
});

test("revision CAS: a fresh expectedRevision succeeds", async (t) => {
  const home = temporaryHome();
  const store = openClient(home);
  t.after(() => store.close());

  const task = makeTask(await store.nextTaskId(), { title: "Fresh CAS" });
  const revision = await store.getRevision();

  await store.transactionAsync(
    [{ op: "saveTask", args: [task] }],
    { expectedRevision: revision, requestId: "fresh-cas" }
  );

  const loaded = await store.getTask(task.id);
  assert.ok(loaded !== null);
  assert.equal(loaded.title, "Fresh CAS");
});
