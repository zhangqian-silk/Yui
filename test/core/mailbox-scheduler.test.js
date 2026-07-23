import assert from "node:assert/strict";
import test from "node:test";

import { MailboxScheduler } from "../../dist/coordination/mailboxScheduler.js";

test("signals share one fixed window and deliver unique keys in insertion order", async () => {
  const clock = fakeClock();
  const batches = [];
  const scheduler = new MailboxScheduler(
    async (keys) => batches.push([...keys]),
    { windowMs: 75, setTimer: clock.setTimer, clearTimer: clock.clearTimer }
  );

  scheduler.signal("task-1");
  scheduler.signal("task-2");
  scheduler.signal("task-1");

  assert.equal(clock.pendingCount(), 1);
  assert.equal(clock.nextDelay(), 75);
  assert.deepEqual(batches, []);

  clock.fireNext();
  await scheduler.drain();

  assert.deepEqual(batches, [["task-1", "task-2"]]);
});

test("signals received while draining form a non-overlapping next batch", async () => {
  const clock = fakeClock();
  const firstBatchGate = deferred();
  const batches = [];
  let activeCallbacks = 0;
  let maximumActiveCallbacks = 0;
  const scheduler = new MailboxScheduler(
    async (keys) => {
      activeCallbacks += 1;
      maximumActiveCallbacks = Math.max(maximumActiveCallbacks, activeCallbacks);
      batches.push([...keys]);
      if (batches.length === 1) await firstBatchGate.promise;
      activeCallbacks -= 1;
    },
    { windowMs: 50, setTimer: clock.setTimer, clearTimer: clock.clearTimer }
  );

  scheduler.signal("task-1");
  const firstDrain = scheduler.drain();
  await Promise.resolve();

  scheduler.signal("task-2");
  scheduler.signal("task-2");
  scheduler.signal("task-3");
  assert.equal(clock.pendingCount(), 1);

  clock.fireNext();
  assert.deepEqual(batches, [["task-1"]]);

  firstBatchGate.resolve();
  await firstDrain;

  assert.deepEqual(batches, [["task-1"], ["task-2", "task-3"]]);
  assert.equal(maximumActiveCallbacks, 1);
});

test("a next batch waits for its own window when the current drain finishes early", async () => {
  const clock = fakeClock();
  const firstBatchGate = deferred();
  const batches = [];
  const scheduler = new MailboxScheduler(
    async (keys) => {
      batches.push([...keys]);
      if (batches.length === 1) await firstBatchGate.promise;
    },
    { windowMs: 40, setTimer: clock.setTimer, clearTimer: clock.clearTimer }
  );

  scheduler.signal("task-1");
  const firstDrain = scheduler.drain();
  await Promise.resolve();
  scheduler.signal("task-2");

  firstBatchGate.resolve();
  await firstDrain;

  assert.deepEqual(batches, [["task-1"]]);
  assert.equal(clock.pendingCount(), 1);

  clock.fireNext();
  await scheduler.drain();
  assert.deepEqual(batches, [["task-1"], ["task-2"]]);
});

test("a reentrant drain request cannot overlap the active callback", async () => {
  const clock = fakeClock();
  const batches = [];
  let activeCallbacks = 0;
  let maximumActiveCallbacks = 0;
  let scheduler;
  scheduler = new MailboxScheduler(
    async (keys) => {
      activeCallbacks += 1;
      maximumActiveCallbacks = Math.max(maximumActiveCallbacks, activeCallbacks);
      batches.push([...keys]);
      if (batches.length === 1) {
        scheduler.signal("task-2");
        void scheduler.drain();
        await Promise.resolve();
      }
      activeCallbacks -= 1;
    },
    { setTimer: clock.setTimer, clearTimer: clock.clearTimer }
  );

  scheduler.signal("task-1");
  await scheduler.drain();

  assert.deepEqual(batches, [["task-1"], ["task-2"]]);
  assert.equal(maximumActiveCallbacks, 1);
});

test("manual drain cancels the window and stop prevents later work", async () => {
  const clock = fakeClock();
  const batches = [];
  const scheduler = new MailboxScheduler(
    async (keys) => batches.push([...keys]),
    { setTimer: clock.setTimer, clearTimer: clock.clearTimer }
  );

  scheduler.signal("task-1");
  assert.equal(clock.pendingCount(), 1);

  await scheduler.drain();
  assert.equal(clock.pendingCount(), 0);
  assert.equal(clock.clearedCount(), 1);
  assert.deepEqual(batches, [["task-1"]]);

  scheduler.signal("task-2");
  scheduler.stop();
  scheduler.signal("task-3");
  await scheduler.drain();

  assert.equal(clock.pendingCount(), 0);
  assert.deepEqual(batches, [["task-1"]]);
});

test("a failed batch does not strand signals queued while it was running", async () => {
  const clock = fakeClock();
  const firstBatchGate = deferred();
  const batches = [];
  const errors = [];
  const scheduler = new MailboxScheduler(
    async (keys) => {
      batches.push([...keys]);
      if (batches.length === 1) {
        await firstBatchGate.promise;
        throw new Error("first batch failed");
      }
    },
    {
      windowMs: 50,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onError: (error) => errors.push(error)
    }
  );

  scheduler.signal("task-1");
  clock.fireNext();
  await Promise.resolve();
  scheduler.signal("task-2");
  clock.fireNext();
  firstBatchGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(errors.length, 1);
  assert.deepEqual(batches, [["task-1"], ["task-2"]]);
});

function fakeClock() {
  let nextId = 0;
  let cleared = 0;
  const timers = new Map();
  return {
    setTimer(callback, delayMs) {
      const id = ++nextId;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimer(id) {
      if (timers.delete(id)) cleared += 1;
    },
    pendingCount() {
      return timers.size;
    },
    clearedCount() {
      return cleared;
    },
    nextDelay() {
      return timers.values().next().value?.delayMs;
    },
    fireNext() {
      const entry = timers.entries().next().value;
      assert.notEqual(entry, undefined, "expected a scheduled timer");
      const [id, timer] = entry;
      timers.delete(id);
      timer.callback();
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
