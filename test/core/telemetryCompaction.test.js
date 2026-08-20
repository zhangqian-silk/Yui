import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openTaskStore } from "../../dist/storage/sqliteStore.js";
import { COMMITTED_DATABASE_FILENAME } from "../../dist/storage/upgrade/sqliteStateMigration.js";
import { createTask } from "../../dist/task/task.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import {
  applyTelemetryCompaction,
  planTelemetryCompaction,
  PROGRESS_EVENT_TYPE
} from "../../dist/telemetry/telemetryCompaction.js";
import { SqliteTelemetryStore } from "../../dist/telemetry/sqliteTelemetryStore.js";

function temporaryHome(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function progressEvent(store, taskId, runId, sequence, now, overrides = {}) {
  const progressAt = new Date(now.getTime() + sequence * 1000).toISOString();
  return createTaskEvent(
    store.nextEventId(taskId),
    taskId,
    PROGRESS_EVENT_TYPE,
    {
      eventId: `event-progress-${runId}-${sequence}`,
      roleName: "leader",
      agentId: "codex",
      adapterId: "codex",
      launchId: `launch-${runId}`,
      nativeSessionId: `session-${runId}`,
      runId,
      progressId: `progress-${runId}-${sequence}`,
      progressAt,
      sequence: String(sequence),
      ...overrides
    },
    new Date(progressAt)
  );
}

function semanticEvent(store, taskId, type, payload, now) {
  return createTaskEvent(store.nextEventId(taskId), taskId, type, payload, now);
}

function buildFixtureHome() {
  const home = temporaryHome("yui-telemetry-compaction-");
  const store = openTaskStore(home, "sqlite");
  const now = new Date("2026-08-17T00:00:00.000Z");
  for (const taskId of ["task-1", "task-2"]) {
    store.saveTask(createTask(taskId, `Test ${taskId}`, now));
    store.saveWorkItem(taskId, createWorkItem(
      store.nextWorkItemId(taskId),
      taskId,
      { title: "do work", assignee: "leader" },
      now
    ));
    store.saveMessage(taskId, {
      schemaVersion: 2,
      id: store.nextMessageId(taskId),
      taskId,
      kind: "role-result",
      author: { type: "role", roleName: "leader" },
      body: "hello",
      createdAt: now.toISOString()
    });
    store.saveEvent(taskId, semanticEvent(store, taskId, "run.dispatched", { runId: `${taskId}-run-1` }, now));
    store.saveEvent(taskId, semanticEvent(store, taskId, "runtime.role-session-reset", { runId: `${taskId}-run-1` }, now));
  }
  // task-1: one Run with 250 progress events (over the 200 window).
  for (let i = 1; i <= 250; i++) {
    store.saveEvent("task-1", progressEvent(store, "task-1", "task-1-run-1", i, now));
  }
  // task-1: a second Run with 50 progress events.
  for (let i = 1; i <= 50; i++) {
    store.saveEvent("task-1", progressEvent(store, "task-1", "task-1-run-2", i, now));
  }
  // task-2: one Run with 30 progress events, one carrying an error.
  for (let i = 1; i <= 30; i++) {
    store.saveEvent("task-2", progressEvent(store, "task-2", "task-2-run-1", i, now, i === 30 ? { error: "provider-500" } : {}));
  }
  store.close();
  return home;
}

function copyHome(source) {
  const staged = temporaryHome("yui-telemetry-staged-");
  for (const filename of [
    COMMITTED_DATABASE_FILENAME,
    `${COMMITTED_DATABASE_FILENAME}-wal`,
    `${COMMITTED_DATABASE_FILENAME}-shm`
  ]) {
    const sourcePath = join(source, filename);
    try {
      cpSync(sourcePath, join(staged, filename));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return staged;
}

function eventFingerprint(events) {
  return events
    .filter((event) => event.type !== PROGRESS_EVENT_TYPE)
    .map((event) => `${event.id}:${event.type}:${JSON.stringify(event.payload)}`)
    .sort()
    .join("\n");
}

test("plan identifies progress events, windows, and aggregates", () => {
  const home = buildFixtureHome();
  try {
    const store = openTaskStore(home, "sqlite");
    const plan = planTelemetryCompaction(store, { terminalKeep: 200 });
    assert.equal(plan.totals.tasks, 2);
    assert.equal(plan.totals.progressEvents, 330);
    assert.equal(plan.totals.generations, 3);
    assert.equal(plan.totals.telemetryRows, 200 + 50 + 30);
    const task1 = plan.tasks.find((task) => task.taskId === "task-1");
    const run1 = task1.generations.find((generation) => generation.runId === "task-1-run-1");
    assert.equal(run1.window.length, 200);
    assert.equal(run1.aggregate.count, 250);
    assert.equal(run1.aggregate.maxSequence, 250);
    assert.equal(run1.window[0].progressId, "progress-task-1-run-1-51");
    assert.equal(run1.window[199].progressId, "progress-task-1-run-1-250");
    const task2 = plan.tasks.find((task) => task.taskId === "task-2");
    assert.equal(task2.generations[0].aggregate.errorCount, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dry-run changes nothing", () => {
  const home = buildFixtureHome();
  const staged = copyHome(home);
  try {
    const store = openTaskStore(staged, "sqlite");
    const telemetry = new SqliteTelemetryStore(staged, { mode: "bounded" });
    const before = eventFingerprint(store.listEvents("task-1"));
    const plan = planTelemetryCompaction(store, { terminalKeep: 200 });
    const receipt = applyTelemetryCompaction(store, telemetry, plan, {
      dryRun: true,
      source: home,
      terminalKeep: 200
    });
    assert.equal(receipt.dryRun, true);
    assert.equal(receipt.totals.progressEvents, 330);
    assert.equal(eventFingerprint(store.listEvents("task-1")), before);
    assert.equal(store.listEvents("task-1").filter((event) => event.type === PROGRESS_EVENT_TYPE).length, 300);
    assert.equal(telemetry.count("task-1"), 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(staged, { recursive: true, force: true });
  }
});

test("staged compaction keeps semantic records and validates aggregates", () => {
  const home = buildFixtureHome();
  const staged = copyHome(home);
  try {
    const sourceStore = openTaskStore(home, "sqlite");
    const semanticBefore = new Map(
      sourceStore.listTasks().map((task) => [task.id, eventFingerprint(sourceStore.listEvents(task.id))])
    );
    const store = openTaskStore(staged, "sqlite");
    const telemetry = new SqliteTelemetryStore(staged, { mode: "bounded" });
    const plan = planTelemetryCompaction(store, { terminalKeep: 200 });
    const receipt = applyTelemetryCompaction(store, telemetry, plan, {
      dryRun: false,
      source: home,
      terminalKeep: 200
    });
    assert.equal(receipt.validation, "passed");
    assert.equal(receipt.tasks.find((task) => task.taskId === "task-1").removedProgressEvents, 300);
    assert.equal(receipt.tasks.find((task) => task.taskId === "task-2").removedProgressEvents, 30);

    // Semantic (non-progress) events are byte-identical to the source.
    for (const [taskId, fingerprint] of semanticBefore) {
      assert.equal(eventFingerprint(store.listEvents(taskId)), fingerprint);
    }
    // No progress events remain in semantic history.
    for (const task of store.listTasks()) {
      assert.equal(
        store.listEvents(task.id).filter((event) => event.type === PROGRESS_EVENT_TYPE).length,
        0
      );
    }
    // Other record families are untouched.
    assert.equal(store.listWorkItems("task-1").length, 1);
    assert.equal(store.listMessages("task-1").length, 1);
    assert.equal(store.listWorkItems("task-2").length, 1);

    // Sidecar holds the bounded window and accurate aggregates.
    assert.equal(telemetry.count("task-1", "task-1-run-1"), 200);
    assert.equal(telemetry.count("task-1", "task-1-run-2"), 50);
    assert.equal(telemetry.count("task-2", "task-2-run-1"), 30);
    const aggregate = telemetry.aggregateGeneration("task-1", "leader", "task-1-run-1", "launch-task-1-run-1");
    assert.equal(aggregate.count, 250);
    assert.equal(aggregate.maxSequence, 250);
    assert.equal(aggregate.firstAt, new Date(Date.parse("2026-08-17T00:00:00.000Z") + 1000).toISOString());
    assert.equal(aggregate.lastAt, new Date(Date.parse("2026-08-17T00:00:00.000Z") + 250000).toISOString());
    const errorAggregate = telemetry.aggregateGeneration("task-2", "leader", "task-2-run-1", "launch-task-2-run-1");
    assert.equal(errorAggregate.errorCount, 1);

    // The receipt returned to the caller (the CLI persists it next to the
    // staged Home).
    assert.equal(receipt.validation, "passed");
    assert.equal(receipt.totals.progressEvents, 330);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(staged, { recursive: true, force: true });
  }
});

test("validation failure throws and leaves semantic history intact", () => {
  const home = buildFixtureHome();
  const staged = copyHome(home);
  try {
    const store = openTaskStore(staged, "sqlite");
    // A sidecar that accepts imports but cannot serve aggregates: validation
    // must fail before semantic history is touched.
    const plan = planTelemetryCompaction(store, { terminalKeep: 200 });
    const telemetry = {
      importGeneration: () => {},
      aggregateGeneration: () => null
    };
    assert.throws(
      () => applyTelemetryCompaction(store, telemetry, plan, {
        dryRun: false,
        source: home,
        terminalKeep: 200
      }),
      /missing aggregate/
    );
    // The semantic removal is transactional: progress events are still present.
    assert.equal(
      store.listEvents("task-1").filter((event) => event.type === PROGRESS_EVENT_TYPE).length,
      300
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(staged, { recursive: true, force: true });
  }
});

test("malformed progress events are kept semantic and reported", () => {
  const home = temporaryHome("yui-telemetry-malformed-");
  try {
    const store = openTaskStore(home, "sqlite");
    const now = new Date("2026-08-17T00:00:00.000Z");
    store.saveTask(createTask("task-1", "Test", now));
    store.saveEvent("task-1", createTaskEvent(
      store.nextEventId("task-1"),
      "task-1",
      PROGRESS_EVENT_TYPE,
      { note: "missing runId/progressId" },
      now
    ));
    const plan = planTelemetryCompaction(store, { terminalKeep: 200 });
    assert.equal(plan.tasks[0].progressEventIds.length, 0);
    assert.equal(plan.tasks[0].malformedKept, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
