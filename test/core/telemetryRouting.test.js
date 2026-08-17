import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { openTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask } from "../../dist/task/task.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { routeProviderProgress } from "../../dist/telemetry/telemetryRouter.js";
import { NullTelemetrySink } from "../../dist/telemetry/telemetryStore.js";
import { SqliteTelemetryStore } from "../../dist/telemetry/sqliteTelemetryStore.js";

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), "yui-telemetry-routing-"));
}

function entry(overrides = {}) {
  return {
    taskId: "task-1",
    roleName: "leader",
    runId: "run-1",
    generation: "launch-1",
    progressId: "progress-1",
    sequence: 1,
    payload: { runId: "run-1", progressId: "progress-1", progressAt: "2026-08-17T00:00:00.000Z" },
    receivedAt: "2026-08-17T00:00:00.000Z",
    ...overrides
  };
}

class RecordingSink extends NullTelemetrySink {
  constructor(mode) {
    super(mode);
    this.observed = [];
  }
  observe(value) {
    this.observed.push(value);
  }
}

class ThrowingSink extends NullTelemetrySink {
  observe() {
    throw new Error("sidecar is down");
  }
}

test("router: legacy writes semantic only", () => {
  const sink = new RecordingSink("legacy");
  let semanticWrites = 0;
  routeProviderProgress({
    mode: "legacy",
    entry: entry(),
    semanticExists: false,
    writeSemantic: () => { semanticWrites++; },
    sink
  });
  assert.equal(semanticWrites, 1);
  assert.equal(sink.observed.length, 0);
});

test("router: dual writes semantic and sidecar", () => {
  const sink = new RecordingSink("dual");
  let semanticWrites = 0;
  routeProviderProgress({
    mode: "dual",
    entry: entry(),
    semanticExists: false,
    writeSemantic: () => { semanticWrites++; },
    sink
  });
  assert.equal(semanticWrites, 1);
  assert.equal(sink.observed.length, 1);
});

test("router: bounded writes sidecar only", () => {
  const sink = new RecordingSink("bounded");
  let semanticWrites = 0;
  routeProviderProgress({
    mode: "bounded",
    entry: entry(),
    semanticExists: false,
    writeSemantic: () => { semanticWrites++; },
    sink
  });
  assert.equal(semanticWrites, 0);
  assert.equal(sink.observed.length, 1);
});

test("router: idempotent replay in legacy/dual does not rewrite semantic", () => {
  for (const mode of ["legacy", "dual"]) {
    const sink = new RecordingSink(mode);
    let semanticWrites = 0;
    routeProviderProgress({
      mode,
      entry: entry(),
      semanticExists: true,
      writeSemantic: () => { semanticWrites++; },
      sink
    });
    assert.equal(semanticWrites, 0);
    assert.equal(sink.observed.length, 0);
  }
});

test("router: broken sink never blocks the semantic lane", () => {
  let semanticWrites = 0;
  assert.doesNotThrow(() => {
    routeProviderProgress({
      mode: "dual",
      entry: entry(),
      semanticExists: false,
      writeSemantic: () => { semanticWrites++; },
      sink: new ThrowingSink("dual")
    });
  });
  assert.equal(semanticWrites, 1);
});

test("adapter projection merges sidecar progress in bounded mode", async () => {
  const home = temporaryHome();
  try {
    const store = openTaskStore(home, "sqlite");
    const now = new Date("2026-08-17T00:00:00.000Z");
    store.saveTask(createTask("task-1", "Test", now));
    store.saveEvent("task-1", createTaskEvent(
      store.nextEventId("task-1"),
      "task-1",
      "run.dispatched",
      { runId: "run-1" },
      now
    ));
    const telemetry = new SqliteTelemetryStore(home, { mode: "bounded" });
    telemetry.observe(entry({ runId: "run-1", progressId: "p-1", sequence: 1, receivedAt: "2026-08-17T00:00:05.000Z" }));
    telemetry.observe(entry({ runId: "run-1", progressId: "p-2", sequence: 2, receivedAt: "2026-08-17T00:00:09.000Z" }));
    await telemetry.flush();

    const adapter = new FileSchedulerStoreAdapter(store, {
      mode: "bounded",
      sink: telemetry,
      reader: telemetry
    });
    const events = adapter.listEvents("task-1");
    assert.equal(events.length, 2);
    assert.ok(events.some((event) => event.type === "run.dispatched"));
    const synthesized = events.find((event) => event.type === "runtime.provider-turn-progress");
    assert.equal(synthesized.payload.progressId, "p-2");
    assert.equal(synthesized.payload.progressAt, "2026-08-17T00:00:09.000Z");

    const facts = adapter.getRunProgressFacts("task-1", "run-1");
    assert.equal(facts.latestCheckpointAt, "2026-08-17T00:00:09.000Z");
    assert.equal(facts.latestActivityAt, "2026-08-17T00:00:09.000Z");

    // A newer sidecar revision invalidates the cached projection.
    telemetry.observe(entry({ runId: "run-1", progressId: "p-3", sequence: 3, receivedAt: "2026-08-17T00:00:12.000Z" }));
    await telemetry.flush();
    const refreshed = adapter.listEvents("task-1");
    assert.equal(refreshed.find((event) => event.type === "runtime.provider-turn-progress").payload.progressId, "p-3");
    await telemetry.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("adapter without telemetry keeps master behavior", () => {
  const home = temporaryHome();
  try {
    ensureStorageSchema(home);
    const store = new FileTaskStore(home);
    const now = new Date("2026-08-17T00:00:00.000Z");
    store.saveTask(createTask("task-1", "Test", now));
    store.saveEvent("task-1", createTaskEvent(
      store.nextEventId("task-1"),
      "task-1",
      "runtime.provider-turn-progress",
      { runId: "run-1", progressId: "p-1", progressAt: "2026-08-17T00:00:05.000Z" },
      now
    ));
    const adapter = new FileSchedulerStoreAdapter(store);
    const events = adapter.listEvents("task-1");
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "runtime.provider-turn-progress");
    const facts = adapter.getRunProgressFacts("task-1", "run-1");
    assert.equal(facts.latestCheckpointAt, "2026-08-17T00:00:05.000Z");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
