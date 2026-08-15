// Tests for the resource inventory Worker Thread (task-21, work-item-6).
//
// Covers:
//   - a real /proc scan round-trips through the worker with the same shape as
//     the direct call (behavior unchanged);
//   - a blocking scan in the worker does not stall the main event loop, while
//     the same block on the main thread does (the acceptance criterion);
//   - backpressure (maxInFlight bounds concurrent scans);
//   - cancellation (an aborted scan rejects promptly and releases its slot);
//   - fault injection (a crashed worker restarts and replays the in-flight scan);
//   - the ephemeral reaper consumes an injected scan override (no regression).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ResourceInventoryClient } from "../../dist/controller/resourceInventoryRpc.js";
import { scanControllerResourceInventory } from "../../dist/controller/resourceInventoryLinux.js";
import { createEphemeralResourceReaper } from "../../dist/controller/ephemeralResourceReaper.js";

const blockingWorkerUrl = new URL("./resourceInventoryBlockingWorker.js", import.meta.url);

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), "yui-inventory-worker-"));
}

const setImmediateAsync = () => new Promise((resolve) => setImmediate(resolve));

// Poll until a predicate holds (the worker ready handshake is async, so the
// first scan may not be in-flight after a couple of setImmediates).
async function waitFor(predicate, timeoutMs = 5000, intervalMs = 5) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// -- Real scan round-trip -----------------------------------------------------

test("a real scan round-trips through the worker with the same shape as the direct call", async () => {
  const home = temporaryHome();
  const client = new ResourceInventoryClient();
  try {
    const [direct, viaWorker] = await Promise.all([
      scanControllerResourceInventory({ currentHome: home, scope: "current" }),
      client.scan({ currentHome: home, scope: "current" })
    ]);
    assert.equal(viaWorker.schemaVersion, 1);
    assert.equal(viaWorker.scope, "current");
    assert.equal(viaWorker.currentHome, direct.currentHome);
    assert.equal(typeof viaWorker.observedAt, "string");
    assert.deepEqual(
      Object.keys(viaWorker.summary).sort(),
      Object.keys(direct.summary).sort()
    );
    // Both scans run in this process (worker threads share the pid) and exclude
    // the same controller pid, so they observe the same resource set.
    assert.equal(viaWorker.summary.resourceCount, direct.summary.resourceCount);
    assert.equal(viaWorker.summary.liveProcessCount, direct.summary.liveProcessCount);
  } finally {
    await client.close();
  }
});

// -- Event-loop delay (the acceptance criterion) ------------------------------

test("a blocking inventory scan in the worker does not stall the main event loop", async () => {
  const home = temporaryHome();
  const client = new ResourceInventoryClient({ workerScript: blockingWorkerUrl });
  try {
    let maxGap = 0;
    let last = performance.now();
    // A 250ms blocking scan runs in the worker; the main thread stays free.
    const scanPromise = client.scan({ currentHome: home, scope: "current", busyMs: 250 });
    for (let i = 0; i < 100; i += 1) {
      await setImmediateAsync();
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }
    const inventory = await scanPromise;
    assert.equal(inventory.schemaVersion, 1);
    // The main thread was never blocked for the 250ms scan: no setImmediate gap
    // approaches the block length.
    assert.ok(maxGap < 150, `expected max setImmediate gap < 150ms, got ${maxGap.toFixed(1)}ms`);
  } finally {
    await client.close();
  }
});

test("control: the drift probe detects a 250ms synchronous block on the main thread", async () => {
  let observed = 0;
  const before = performance.now();
  setImmediate(() => {
    observed = performance.now() - before;
  });
  // Block the main thread synchronously; the setImmediate cannot fire.
  const end = Date.now() + 250;
  while (Date.now() < end) {
    // spin
  }
  assert.equal(observed, 0, "setImmediate fired during a synchronous block?");
  await setImmediateAsync();
  assert.ok(observed >= 200, `expected drift >= 200ms, got ${observed.toFixed(1)}ms`);
});

// -- Backpressure --------------------------------------------------------------

test("backpressure: maxInFlight bounds concurrent scans and the queue drains", async () => {
  const home = temporaryHome();
  const client = new ResourceInventoryClient({
    maxInFlight: 1,
    maxQueue: 8,
    workerScript: blockingWorkerUrl
  });
  try {
    const scans = [
      client.scan({ currentHome: home, scope: "current", busyMs: 30 }),
      client.scan({ currentHome: home, scope: "current", busyMs: 30 }),
      client.scan({ currentHome: home, scope: "current", busyMs: 30 })
    ];
    // Wait for the first scan to take the slot and the rest to queue.
    await waitFor(() => client.inFlight === 1 && client.queueDepth >= 2);
    assert.equal(client.inFlight, 1);
    assert.ok(client.queueDepth >= 2, `expected queueDepth >= 2, got ${client.queueDepth}`);
    const results = await Promise.all(scans);
    assert.equal(results.length, 3);
    assert.ok(results.every((inventory) => inventory.schemaVersion === 1));
    assert.equal(client.inFlight, 0);
    assert.equal(client.queueDepth, 0);
  } finally {
    await client.close();
  }
});

// -- Cancellation ---------------------------------------------------------------

test("cancellation: an aborted scan rejects promptly and releases its slot", async () => {
  const home = temporaryHome();
  const client = new ResourceInventoryClient({
    maxInFlight: 1,
    maxQueue: 4,
    workerScript: blockingWorkerUrl
  });
  try {
    const controller = new AbortController();
    const scanPromise = client.scan(
      { currentHome: home, scope: "current", busyMs: 500 },
      { signal: controller.signal }
    );
    // Wait for the scan to be in-flight before aborting.
    await waitFor(() => client.inFlight === 1);
    assert.equal(client.inFlight, 1);
    controller.abort();
    await assert.rejects(scanPromise, /aborted/i);
    // The slot was released even though the worker is still busy-waiting.
    assert.equal(client.inFlight, 0);
  } finally {
    await client.close();
  }
});

// -- Fault injection -------------------------------------------------------------

test("fault injection: a crashed worker restarts and the in-flight scan is replayed", async () => {
  const home = temporaryHome();
  const client = new ResourceInventoryClient({
    workerScript: blockingWorkerUrl,
    restartBackoffMs: 5
  });
  try {
    // A long enough scan that it is still in-flight when we crash the worker.
    const scanPromise = client.scan({ currentHome: home, scope: "current", busyMs: 200 });
    await waitFor(() => client.inFlight === 1);
    await client.crashForTest();
    // The client restarts the worker and replays the scan; it resolves.
    const inventory = await scanPromise;
    assert.equal(inventory.schemaVersion, 1);
  } finally {
    await client.close();
  }
});

// -- Ephemeral reaper no-regression ----------------------------------------------

test("the ephemeral reaper consumes an injected scan override", async () => {
  const home = temporaryHome();
  let scanCalls = 0;
  const reaper = createEphemeralResourceReaper({
    currentHome: home,
    scope: "current",
    scan: async () => {
      scanCalls += 1;
      return scanControllerResourceInventory({ currentHome: home, scope: "current" });
    }
  });
  const result = await reaper();
  // No expired ephemeral resources in a fresh temp home: one scan, no cleanup.
  assert.equal(scanCalls, 1);
  assert.equal(result.candidates, 0);
  assert.equal(result.cleaned, 0);
  assert.equal(result.failed.length, 0);
});
