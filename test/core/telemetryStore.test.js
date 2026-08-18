import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import { COMMITTED_DATABASE_FILENAME } from "../../dist/storage/upgrade/sqliteStateMigration.js";
import { SqliteTelemetryStore } from "../../dist/telemetry/sqliteTelemetryStore.js";
import { NullTelemetrySink } from "../../dist/telemetry/telemetryStore.js";
import { openSchedulerTelemetry } from "../../dist/telemetry/telemetryWiring.js";

// Telemetry lives in the Home's authoritative `yui.db`; tests provision a
// real migrated database so the store opens exactly as in production.
function temporaryHome() {
  const home = mkdtempSync(join(tmpdir(), "yui-telemetry-store-"));
  const db = new Database(join(home, COMMITTED_DATABASE_FILENAME));
  db.pragma("journal_mode = WAL");
  migrateSqliteSchema(db);
  db.close();
  return home;
}

function entry(overrides = {}) {
  return {
    taskId: "task-1",
    roleName: "leader",
    runId: "run-1",
    generation: "launch-1",
    progressId: "progress-1",
    payload: { runId: "run-1", progressId: "progress-1", progressAt: "2026-08-17T00:00:00.000Z" },
    receivedAt: "2026-08-17T00:00:00.000Z",
    ...overrides
  };
}

test("10,000 identical progress replays keep one latest row", async () => {
  const home = temporaryHome();
  try {
    const store = new SqliteTelemetryStore(home, { mode: "dual" });
    for (let i = 0; i < 10_000; i++) {
      store.observe(entry({ sequence: i + 1, receivedAt: `2026-08-17T00:00:${String(i % 60).padStart(2, "0")}.000Z` }));
    }
    await store.flush();
    assert.equal(store.count("task-1", "run-1"), 1);
    const page = store.list("task-1", "run-1");
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].sequence, 10_000);
    assert.equal(store.health().coalesced, 9_999);
    await store.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sequence and receivedAt only move forward", async () => {
  const home = temporaryHome();
  try {
    const store = new SqliteTelemetryStore(home, { mode: "dual" });
    store.observe(entry({ sequence: 5, receivedAt: "2026-08-17T00:00:05.000Z" }));
    await store.flush();
    store.observe(entry({ sequence: 3, receivedAt: "2026-08-17T00:00:10.000Z" }));
    await store.flush();
    let row = store.list("task-1", "run-1").items[0];
    assert.equal(row.sequence, 5);
    assert.equal(row.receivedAt, "2026-08-17T00:00:05.000Z");
    store.observe(entry({ sequence: 7, receivedAt: "2026-08-17T00:00:01.000Z" }));
    await store.flush();
    row = store.list("task-1", "run-1").items[0];
    assert.equal(row.sequence, 7);
    await store.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("terminal prune keeps the newest 200 rows and an accurate aggregate", async () => {
  const home = temporaryHome();
  try {
    const store = new SqliteTelemetryStore(home, { mode: "bounded", terminalKeep: 200 });
    for (let i = 1; i <= 250; i++) {
      store.observe(entry({
        progressId: `progress-${i}`,
        sequence: i,
        payload: { runId: "run-1", progressId: `progress-${i}`, progressAt: `2026-08-17T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z` },
        receivedAt: `2026-08-17T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`
      }));
    }
    await store.flush();
    assert.equal(store.count("task-1", "run-1"), 250);
    const deleted = store.pruneGeneration("task-1", "leader", "run-1", "launch-1", 200);
    assert.equal(deleted, 50);
    assert.equal(store.count("task-1", "run-1"), 200);
    const aggregate = store.aggregateGeneration("task-1", "leader", "run-1", "launch-1");
    assert.equal(aggregate.count, 250);
    assert.equal(aggregate.maxSequence, 250);
    assert.equal(aggregate.firstAt, "2026-08-17T00:00:01.000Z");
    assert.equal(aggregate.lastAt, "2026-08-17T00:04:10.000Z");
    const rows = store.list("task-1", "run-1", { limit: 500, offset: 0 }).items;
    assert.equal(rows[0].progressId, "progress-51");
    assert.equal(rows[199].progressId, "progress-250");
    await store.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("active run hard cap trims oldest rows", async () => {
  const home = temporaryHome();
  try {
    const store = new SqliteTelemetryStore(home, { mode: "bounded", runCap: 100 });
    for (let i = 1; i <= 150; i++) {
      const receivedAt = new Date(Date.parse("2026-08-17T00:00:00.000Z") + i * 1000).toISOString();
      store.observe(entry({
        progressId: `progress-${i}`,
        sequence: i,
        payload: { runId: "run-1", progressId: `progress-${i}`, progressAt: receivedAt },
        receivedAt
      }));
    }
    await store.flush();
    const deleted = store.capRun("task-1", "run-1", 100);
    assert.equal(deleted, 50);
    assert.equal(store.count("task-1", "run-1"), 100);
    const rows = store.list("task-1", "run-1", { limit: 500, offset: 0 }).items;
    assert.equal(rows[0].progressId, "progress-51");
    await store.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("missing database fails isolated: observe never throws and only increments dropped", async () => {
  const home = join(temporaryHome(), "not-a-directory");
  writeFileSync(home, "blocking file");
  try {
    const store = new SqliteTelemetryStore(home, { mode: "dual" });
    store.observe(entry());
    store.observe(entry({ progressId: "progress-2" }));
    const health = store.health();
    assert.equal(health.available, false);
    assert.equal(health.dropped, 2);
    assert.equal(health.lastError !== null, true);
    assert.match(health.lastError, /Telemetry database not found/);
    assert.equal(store.count("task-1"), 0);
    assert.deepEqual(store.list("task-1").items, []);
    assert.equal(store.aggregate("task-1", "run-1"), null);
    await store.close();
  } finally {
    rmSync(home, { force: true });
  }
});

test("paged reads report nextOffset", async () => {
  const home = temporaryHome();
  try {
    const store = new SqliteTelemetryStore(home, { mode: "dual" });
    for (let i = 1; i <= 25; i++) {
      store.observe(entry({
        progressId: `progress-${i}`,
        sequence: i,
        receivedAt: `2026-08-17T00:00:${String(i % 60).padStart(2, "0")}.000Z`
      }));
    }
    await store.flush();
    const page1 = store.list("task-1", "run-1", { limit: 10, offset: 0 });
    assert.equal(page1.items.length, 10);
    assert.equal(page1.nextOffset, 10);
    const page3 = store.list("task-1", "run-1", { limit: 10, offset: 20 });
    assert.equal(page3.items.length, 5);
    assert.equal(page3.nextOffset, null);
    await store.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("revision advances with applied writes", async () => {
  const home = temporaryHome();
  try {
    const store = new SqliteTelemetryStore(home, { mode: "dual" });
    assert.equal(store.revision(), 0);
    store.observe(entry());
    await store.flush();
    assert.equal(store.revision(), 1);
    store.observe(entry({ progressId: "progress-2" }));
    store.observe(entry({ progressId: "progress-3" }));
    await store.flush();
    assert.equal(store.revision(), 3);
    await store.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("latestProgressEvents synthesizes one event per Run", async () => {
  const home = temporaryHome();
  try {
    const store = new SqliteTelemetryStore(home, { mode: "bounded" });
    store.observe(entry({ runId: "run-1", progressId: "p-1", sequence: 1, receivedAt: "2026-08-17T00:00:01.000Z" }));
    store.observe(entry({ runId: "run-1", progressId: "p-2", sequence: 2, receivedAt: "2026-08-17T00:00:02.000Z" }));
    store.observe(entry({ runId: "run-2", progressId: "p-3", sequence: 1, receivedAt: "2026-08-17T00:00:03.000Z" }));
    await store.flush();
    const events = store.latestProgressEvents("task-1");
    assert.equal(events.length, 2);
    const run1 = events.find((event) => event.payload.runId === "run-1");
    assert.equal(run1.payload.progressId, "p-2");
    assert.equal(run1.type, "runtime.provider-turn-progress");
    assert.equal(run1.payload.progressAt, "2026-08-17T00:00:02.000Z");
    await store.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("aggregate merges generations and importGeneration overrides totals", async () => {
  const home = temporaryHome();
  try {
    const store = new SqliteTelemetryStore(home, { mode: "bounded" });
    store.observe(entry({ generation: "g-1", progressId: "p-1", sequence: 4, receivedAt: "2026-08-17T00:00:04.000Z" }));
    store.observe(entry({ generation: "g-2", progressId: "p-2", sequence: 9, receivedAt: "2026-08-17T00:00:09.000Z" }));
    await store.flush();
    const merged = store.aggregate("task-1", "run-1");
    assert.equal(merged.count, 2);
    assert.equal(merged.maxSequence, 9);
    assert.equal(merged.firstAt, "2026-08-17T00:00:04.000Z");
    assert.equal(merged.lastAt, "2026-08-17T00:00:09.000Z");
    store.importGeneration(
      [entry({ generation: "g-1", progressId: "p-1", sequence: 4, receivedAt: "2026-08-17T00:00:04.000Z" })],
      {
        taskId: "task-1", roleName: "leader", runId: "run-1", generation: "g-1",
        firstAt: "2026-08-17T00:00:00.000Z", lastAt: "2026-08-17T00:00:04.000Z",
        count: 400, maxSequence: 400, errorCount: 2
      }
    );
    const exact = store.aggregateGeneration("task-1", "leader", "run-1", "g-1");
    assert.equal(exact.count, 400);
    assert.equal(exact.maxSequence, 400);
    assert.equal(exact.errorCount, 2);
    await store.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("NullTelemetrySink is inert", async () => {
  const sink = new NullTelemetrySink();
  sink.observe(entry());
  assert.equal(sink.health().available, false);
  await sink.close();
});

test("wiring returns null in legacy mode and fails closed without a database", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-telemetry-nodb-"));
  try {
    assert.equal(openSchedulerTelemetry(home, { YUI_TELEMETRY_MODE: "legacy" }), null);
    assert.throws(
      () => openSchedulerTelemetry(home, { YUI_TELEMETRY_MODE: "dual" }),
      /requires SQLite storage/
    );
    assert.throws(
      () => openSchedulerTelemetry(home, { YUI_TELEMETRY_MODE: "bounded" }),
      /requires SQLite storage/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("wiring opens the sidecar when the Home already has yui.db", () => {
  const home = temporaryHome();
  try {
    const wired = openSchedulerTelemetry(home, { YUI_TELEMETRY_MODE: "bounded" });
    assert.notEqual(wired, null);
    assert.equal(wired.mode, "bounded");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
