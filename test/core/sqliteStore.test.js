import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { FileTaskStore, StorageConflictError, StorageRecordError } from "../../dist/storage/taskStore.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { migrateSqliteSchema, SQLITE_SCHEMA_TABLES } from "../../dist/storage/sqliteSchema.js";
import { openTaskStore, resolveTaskStoreBackend, SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createProject } from "../../dist/repository/project.js";
import { createDurableJob, startDurableJob } from "../../dist/job/durableJob.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import { createIntegrationQueueEntry, markIntegrationQueueRunning } from "../../dist/integration/integrationQueueEntry.js";

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), "yui-sqlite-store-"));
}

function makeTask(store, overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 4,
    id: store.nextTaskId(),
    title: "Test Task",
    projectBindings: [],
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function makeMessage(store, taskId, overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 3,
    id: store.nextMessageId(taskId),
    taskId,
    kind: "role-result",
    author: { type: "role", roleName: "leader" },
    body: "hello world",
    createdAt: now,
    ...overrides
  };
}

function makeEvent(store, taskId, overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    id: store.nextEventId(taskId),
    taskId,
    type: "runtime.provider-turn-progress",
    payload: {},
    createdAt: now,
    ...overrides
  };
}

function makeTelemetry(taskId, runId, generation, progressId, sequence) {
  return {
    taskId,
    roleName: "leader",
    runId,
    generation,
    progressId,
    sequence,
    payload: { i: sequence },
    receivedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

test("schema migration: fresh create applies every current migration and all tables", () => {
  const home = temporaryHome();
  const db = new Database(join(home, "yui.db"));
  const result = migrateSqliteSchema(db);
  assert.deepEqual(result.applied, [1, 2, 3, 4, 5, 6]);
  assert.equal(result.version, 6);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const table of SQLITE_SCHEMA_TABLES) {
    assert.ok(tables.includes(table), `missing table: ${table}`);
  }
  assert.ok(tables.includes("schema_migrations"), "schema_migrations table must exist");
  db.close();
});

test("schema migration: idempotent re-run applies nothing", () => {
  const home = temporaryHome();
  const db = new Database(join(home, "yui.db"));
  migrateSqliteSchema(db);
  const second = migrateSqliteSchema(db);
  assert.deepEqual(second.applied, []);
  assert.equal(second.version, 6);
  db.close();
});

test("schema migration: repairs the legacy global DurableJob key without losing rows", () => {
  const home = temporaryHome();
  const db = new Database(join(home, "yui.db"));
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      axis TEXT NOT NULL,
      record_kind TEXT,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    );
    INSERT INTO schema_migrations(version, axis, record_kind, applied_at, checksum)
      VALUES (1, 'layout', NULL, '2026-08-17T00:00:00.000Z', 'legacy-1'),
             (2, 'record', 'durableJob', '2026-08-17T00:00:00.000Z', 'legacy-2'),
             (3, 'record', 'jobCallerKeyHash', '2026-08-17T00:00:00.000Z', 'legacy-3');
    CREATE TABLE durable_jobs (
      job_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      idempotency_key TEXT,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE telemetry (
      task_id     TEXT NOT NULL,
      role_name   TEXT NOT NULL,
      run_id      TEXT NOT NULL,
      generation  TEXT NOT NULL,
      progress_id TEXT NOT NULL,
      sequence    INTEGER,
      payload     TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (task_id, role_name, run_id, generation, progress_id)
    ) WITHOUT ROWID;
    INSERT INTO durable_jobs
      (job_id, task_id, idempotency_key, status, payload, created_at, updated_at)
      VALUES ('job-7', 'task-legacy', 'key-7', 'queued', '{}',
              '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
  `);

  const result = migrateSqliteSchema(db);
  assert.deepEqual(result.applied, [4, 5, 6]);
  assert.equal(result.version, 6);
  const columns = db.prepare("PRAGMA table_info(durable_jobs)").all();
  assert.deepEqual(
    columns.filter(({ pk }) => pk > 0)
      .map(({ name, pk }) => [name, pk])
      .sort((left, right) => left[1] - right[1]),
    [["task_id", 1], ["job_id", 2]]
  );
  assert.deepEqual(
    db.prepare("SELECT task_id, job_id, status FROM durable_jobs").get(),
    { task_id: "task-legacy", job_id: "job-7", status: "queued" }
  );
  db.close();
});

test("schema migration: store constructor runs migration and sets WAL", () => {
  const home = temporaryHome();
  const store = new SqliteTaskStore(home);
  store.close();
  // journal_mode=WAL is persisted in the database header.
  const db = new Database(join(home, "yui.db"));
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  db.close();
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

test("CRUD: task save/get/list/update", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const task = makeTask(store);
  store.saveTask(task);
  assert.equal(store.getTask(task.id).id, task.id);
  assert.equal(store.listTasks().length, 1);
  assert.deepEqual(store.listActiveTaskIds(), [task.id]);

  const updated = { ...task, title: "Updated", status: "completed", updatedAt: new Date().toISOString() };
  store.saveTask(updated);
  assert.equal(store.getTask(task.id).title, "Updated");
  assert.equal(store.getTask(task.id).status, "completed");
  assert.equal(store.listActiveTaskIds().length, 0);
  store.close();
});

test("CRUD: message save/list with task-scoped IDs", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const task = makeTask(store);
  store.saveTask(task);
  const m1 = makeMessage(store, task.id);
  const m2 = makeMessage(store, task.id);
  store.saveMessage(task.id, m1);
  store.saveMessage(task.id, m2);
  const messages = store.listMessages(task.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, m1.id);
  assert.equal(messages[1].id, m2.id);
  store.close();
});

test("CRUD: event save/list (terminal, retained)", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const task = makeTask(store);
  store.saveTask(task);
  const e1 = makeEvent(store, task.id);
  store.saveEvent(task.id, e1);
  const events = store.listEvents(task.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, e1.id);
  assert.equal(events[0].type, "runtime.provider-turn-progress");
  store.close();
});

test("CRUD: SQLite integration queue round-trips and enforces transitions", () => {
  const home = temporaryHome();
  const store = new SqliteTaskStore(home);
  const now = new Date("2026-08-16T00:00:00.000Z");
  const project = createProject(
    store.nextProjectId(),
    "Queue Project",
    home,
    { stable: "main", development: "main" },
    now
  );
  store.saveProject(project);
  const task = makeTask(store, {
    projectBindings: [{ projectId: project.id, directory: "repo", baseRef: "main" }]
  });
  store.saveTask(task);
  const item = createWorkItem(store.nextWorkItemId(task.id), task.id, { title: "Queue work", writeProjectIds: [project.id] }, now);
  store.saveWorkItem(task.id, item);
  const baseCommit = "a".repeat(40);
  const headCommit = "b".repeat(40);
  const changeSet = createWorkItemChangeSet({
    id: store.nextChangeSetId(task.id),
    taskId: task.id,
    projectId: project.id,
    baseCommit,
    headCommit,
    branch: "feature/queue",
    changedPaths: ["src/queue.ts"],
    workItemId: item.id
  }, now);
  store.saveChangeSet(task.id, changeSet);
  const entry = createIntegrationQueueEntry({
    id: store.nextIntegrationQueueEntryId(task.id),
    taskId: task.id,
    projectId: project.id,
    changeSetId: changeSet.id,
    targetRef: "refs/heads/main"
  }, now);
  store.saveIntegrationQueueEntry(task.id, entry);
  assert.deepEqual(store.getIntegrationQueueEntry(task.id, entry.id), entry);
  assert.deepEqual(store.listIntegrationQueueEntries(task.id).map((value) => value.id), [entry.id]);
  const running = markIntegrationQueueRunning(entry, baseCommit, new Date("2026-08-16T00:00:01.000Z"));
  store.saveIntegrationQueueEntry(task.id, running);
  assert.equal(store.getIntegrationQueueEntry(task.id, entry.id).status, "running");
  assert.throws(() => store.saveIntegrationQueueEntry(task.id, { ...running, status: "queued" }), /transition is invalid/);
  store.close();
});

test("CRUD: config and home identity", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const config = store.getConfig();
  assert.equal(config.schemaVersion, 1);
  store.saveConfig({ schemaVersion: 1, defaultAgent: "leader" });
  assert.equal(store.getConfig().defaultAgent, "leader");

  const identity = store.getHomeIdentity();
  assert.ok(identity.homeId);
  assert.equal(identity.schemaVersion, 1);
  store.close();
});

test("CRUD: saving a record for another task is rejected", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const task = makeTask(store);
  store.saveTask(task);
  const foreign = makeMessage(store, task.id, { taskId: "task-999" });
  assert.throws(() => store.saveMessage(task.id, foreign), /belongs to another Task/);
  store.close();
});

test("CRUD: DurableJob IDs are isolated by Task in SQLite", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const taskA = makeTask(store);
  store.saveTask(taskA);
  const taskB = makeTask(store);
  store.saveTask(taskB);
  const now = new Date("2026-08-17T00:00:00.000Z");
  const create = (taskId, workspace) => createDurableJob({
    id: store.nextDurableJobId(taskId),
    taskId,
    owner: { kind: "task" },
    projectId: "project-1",
    head: "a".repeat(40),
    workspace,
    env: {},
    steps: [{ name: "check", command: "true" }],
    artifactsLocator: `artifacts/${taskId}`
  }, now);
  const jobA = create(taskA.id, "/tmp/task-a");
  const jobB = create(taskB.id, "/tmp/task-b");

  assert.equal(jobA.id, "job-1");
  assert.equal(jobB.id, "job-1");
  store.saveDurableJob(taskA.id, jobA);
  store.saveDurableJob(taskB.id, jobB);
  assert.deepEqual(store.listDurableJobs(taskA.id).map(({ id }) => id), ["job-1"]);
  assert.deepEqual(store.listDurableJobs(taskB.id).map(({ id }) => id), ["job-1"]);
  assert.equal(store.getDurableJob(taskA.id, "job-1").taskId, taskA.id);
  assert.equal(store.getDurableJob(taskB.id, "job-1").taskId, taskB.id);

  const runningA = startDurableJob(
    jobA,
    { pid: 101, startIdentity: "task-a" },
    new Date(now.getTime() + 1_000)
  );
  store.saveDurableJob(taskA.id, runningA);
  assert.equal(store.getDurableJob(taskA.id, "job-1").status, "running");
  assert.equal(store.getDurableJob(taskB.id, "job-1").status, "queued");
  store.close();
});

// ---------------------------------------------------------------------------
// Revision CAS
// ---------------------------------------------------------------------------

test("revision CAS: conflict on stale revision", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const rev = store.getRevision();
  store.transactionWithRevisionCas(rev, (s) => {
    s.saveTask(makeTask(s));
  });
  assert.equal(store.getRevision(), rev + 1);

  // Stale CAS must fail and roll back.
  const before = store.listTasks().length;
  assert.throws(
    () => store.transactionWithRevisionCas(rev, (s) => s.saveTask(makeTask(s))),
    StorageConflictError
  );
  assert.equal(store.getRevision(), rev + 1, "revision unchanged after failed CAS");
  assert.equal(store.listTasks().length, before, "no task persisted after failed CAS");
  store.close();
});

test("revision: every mutate bumps the revision", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const rev0 = store.getRevision();
  const task = makeTask(store);
  store.saveTask(task);
  assert.equal(store.getRevision(), rev0 + 1);
  const msg = makeMessage(store, task.id); // nextMessageId allocates -> bumps revision
  assert.equal(store.getRevision(), rev0 + 2);
  store.saveMessage(task.id, msg);
  assert.equal(store.getRevision(), rev0 + 3);
  store.close();
});

// ---------------------------------------------------------------------------
// Transaction rollback
// ---------------------------------------------------------------------------

test("transaction: thrown closure rolls back all writes", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const rev = store.getRevision();
  const count = store.listTasks().length;
  assert.throws(
    () => store.transaction((s) => {
      s.saveTask(makeTask(s));
      throw new Error("boom");
    }),
    /boom/
  );
  assert.equal(store.getRevision(), rev, "revision unchanged after rollback");
  assert.equal(store.listTasks().length, count, "no task persisted after rollback");
  store.close();
});

// ---------------------------------------------------------------------------
// Outbox idempotency
// ---------------------------------------------------------------------------

test("outbox: enqueue is idempotent by request_id", () => {
  const store = new SqliteTaskStore(temporaryHome());
  assert.equal(store.enqueueOutbox("req-1", { op: "do-thing" }), true);
  assert.equal(store.enqueueOutbox("req-1", { op: "do-thing" }), false);
  const pending = store.listPendingOutbox();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requestId, "req-1");
  assert.deepEqual(pending[0].command, { op: "do-thing" });

  store.markOutboxApplied("req-1");
  assert.equal(store.listPendingOutbox().length, 0);
  store.close();
});

test("outbox: transaction writes outbox row atomically", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const rev = store.getRevision();
  store.transaction(
    (s) => s.saveTask(makeTask(s)),
    { requestId: "req-tx-1", outboxCommand: { op: "task-saved" } }
  );
  assert.equal(store.listPendingOutbox().filter((r) => r.requestId === "req-tx-1").length, 1);
  assert.equal(store.getRevision(), rev + 1, "one revision bump for state + outbox");

  // Duplicate requestId in a transaction fails the whole transaction.
  assert.throws(
    () => store.transaction((s) => s.saveTask(makeTask(s)), { requestId: "req-tx-1" }),
    StorageConflictError
  );
  store.close();
});

// ---------------------------------------------------------------------------
// Telemetry bounded merge
// ---------------------------------------------------------------------------

test("telemetry: upsert merges by primary key", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const task = makeTask(store);
  store.saveTask(task);
  store.upsertTelemetryProgress(makeTelemetry(task.id, "agent-run-1", "g1", "p1", 1));
  store.upsertTelemetryProgress(makeTelemetry(task.id, "agent-run-1", "g1", "p1", 2));
  assert.equal(store.countTelemetry(task.id), 1);
  const rows = store.listTelemetry(task.id);
  assert.equal(rows[0].sequence, 2);
  assert.deepEqual(rows[0].payload, { i: 2 });
  store.close();
});

test("telemetry: prune keeps latest N per generation", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const task = makeTask(store);
  store.saveTask(task);
  for (let i = 0; i < 250; i++) {
    store.upsertTelemetryProgress(makeTelemetry(task.id, "agent-run-1", "g1", `p-${i}`, i));
  }
  assert.equal(store.countTelemetry(task.id), 250);
  const deleted = store.pruneTelemetry(task.id, "leader", "agent-run-1", "g1", 200);
  assert.equal(deleted, 50);
  assert.equal(store.countTelemetry(task.id), 200);
  // The newest 200 (highest sequence) survive.
  const rows = store.listTelemetry(task.id);
  const seqs = rows.map((r) => r.sequence).sort((a, b) => a - b);
  assert.equal(seqs[0], 50);
  assert.equal(seqs[199], 249);
  store.close();
});

test("telemetry: prune is scoped to one task/generation", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const taskA = makeTask(store);
  store.saveTask(taskA);
  const taskB = makeTask(store);
  store.saveTask(taskB);
  for (let i = 0; i < 10; i++) {
    store.upsertTelemetryProgress(makeTelemetry(taskA.id, "agent-run-1", "g1", `a-${i}`, i));
    store.upsertTelemetryProgress(makeTelemetry(taskB.id, "agent-run-1", "g1", `b-${i}`, i));
  }
  store.pruneTelemetry(taskA.id, "leader", "agent-run-1", "g1", 5);
  assert.equal(store.countTelemetry(taskA.id), 5);
  assert.equal(store.countTelemetry(taskB.id), 10, "task B untouched");
  store.close();
});

// ---------------------------------------------------------------------------
// task_id partitioning
// ---------------------------------------------------------------------------

test("partitioning: task-scoped reads do not leak across tasks", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const taskA = makeTask(store);
  store.saveTask(taskA);
  const taskB = makeTask(store);
  store.saveTask(taskB);

  store.saveMessage(taskA.id, makeMessage(store, taskA.id));
  store.saveMessage(taskA.id, makeMessage(store, taskA.id));
  store.saveMessage(taskB.id, makeMessage(store, taskB.id));
  store.saveEvent(taskA.id, makeEvent(store, taskA.id));

  assert.equal(store.listMessages(taskA.id).length, 2);
  assert.equal(store.listMessages(taskB.id).length, 1);
  assert.equal(store.listEvents(taskA.id).length, 1);
  assert.equal(store.listEvents(taskB.id).length, 0);
  assert.equal(store.listTasks().length, 2);
  store.close();
});

// ---------------------------------------------------------------------------
// Mailbox ordering
// ---------------------------------------------------------------------------

test("mailbox: signals are gapless per target", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const target = { kind: "task", taskId: "task-1" };
  const s1 = store.enqueueMailboxSignal(target, { reason: "turn", requestId: "r1" });
  const s2 = store.enqueueMailboxSignal(target, { reason: "turn", requestId: "r2" });
  const s3 = store.enqueueMailboxSignal(target, { reason: "turn", requestId: "r3" });
  assert.deepEqual([s1, s2, s3], [1, 2, 3]);
  const mb = store.getWorkMailbox(target);
  assert.equal(mb.nextSequence, 4);

  // A different target has its own sequence.
  const other = { kind: "operator" };
  assert.equal(store.enqueueMailboxSignal(other, { reason: "turn", requestId: "r4" }), 1);
  store.close();
});

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

test("crash recovery: committed data survives close and reopen", () => {
  const home = temporaryHome();
  const store1 = new SqliteTaskStore(home);
  const task = makeTask(store1);
  store1.saveTask(task);
  store1.saveMessage(task.id, makeMessage(store1, task.id));
  const rev = store1.getRevision();
  store1.close();

  const store2 = new SqliteTaskStore(home);
  assert.equal(store2.getTask(task.id).id, task.id);
  assert.equal(store2.listMessages(task.id).length, 1);
  assert.equal(store2.getRevision(), rev);
  store2.close();
});

test("crash recovery: uncommitted transaction is rolled back", () => {
  const home = temporaryHome();
  const store = new SqliteTaskStore(home);
  const task = makeTask(store);
  store.saveTask(task);
  store.close();

  // Simulate a crash: a separate connection begins a write and is killed
  // (closed) before COMMIT. SQLite WAL rolls back the uncommitted transaction.
  const raw = new Database(join(home, "yui.db"));
  raw.exec("BEGIN IMMEDIATE");
  raw.prepare("INSERT INTO outbox (request_id, command, state, created_at) VALUES (?, ?, 'pending', ?)")
    .run("crashed-req", "{}", new Date().toISOString());
  raw.close(); // no COMMIT -> rollback

  const reopened = new SqliteTaskStore(home);
  assert.equal(
    reopened.listPendingOutbox().filter((r) => r.requestId === "crashed-req").length,
    0,
    "uncommitted outbox row must not survive"
  );
  assert.equal(reopened.listTasks().length, 1, "committed task survives");
  reopened.close();
});

// ---------------------------------------------------------------------------
// Backend switch (design §6)
// ---------------------------------------------------------------------------

test("backend switch: resolveTaskStoreBackend and openTaskStore", () => {
  assert.equal(resolveTaskStoreBackend({}), "file");
  assert.equal(resolveTaskStoreBackend({ YUI_STORE_BACKEND: "sqlite" }), "sqlite");
  assert.equal(resolveTaskStoreBackend({ YUI_STORE_BACKED: "SQLITE" }), "file"); // typo ignored
  assert.equal(resolveTaskStoreBackend({ YUI_STORE_BACKEND: "bogus" }), "file");

  const home = temporaryHome();
  const sqlite = openTaskStore(home, "sqlite");
  assert.ok(sqlite instanceof SqliteTaskStore);
  sqlite.close();

  const fileHome = temporaryHome();
  ensureStorageSchema(fileHome);
  const file = openTaskStore(fileHome, "file");
  assert.ok(file instanceof FileTaskStore);
});


// ---------------------------------------------------------------------------
// Pending wakeups (leader-role work-mailbox projection)
// ---------------------------------------------------------------------------

function makeWakeup(taskId, requestCount, reasons = ["turn-requested"]) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    taskId,
    reasons,
    requestCount,
    firstRequestedAt: now,
    lastRequestedAt: now
  };
}

test("pending wakeup: save then get round-trips", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const task = makeTask(store);
  store.saveTask(task);
  const wakeup = makeWakeup(task.id, 2, ["turn-requested", "operator-nudge"]);
  store.savePendingWakeup(wakeup);

  const got = store.getPendingWakeup(task.id);
  assert.ok(got !== null);
  assert.equal(got.taskId, task.id);
  assert.equal(got.requestCount, 2);
  assert.deepEqual(got.reasons, ["turn-requested", "operator-nudge"]);
  assert.equal(got.firstRequestedAt, wakeup.firstRequestedAt);
  assert.equal(got.lastRequestedAt, wakeup.lastRequestedAt);

  // The leader mailbox exists and carries the pending batch.
  const mailbox = store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" });
  assert.ok(mailbox !== null);
  assert.ok(mailbox.pending !== null);
  assert.equal(mailbox.pending.requestCount, 2);
  store.close();
});

test("pending wakeup: get returns null when no leader mailbox", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const task = makeTask(store);
  store.saveTask(task);
  assert.equal(store.getPendingWakeup(task.id), null);
  store.close();
});

test("pending wakeup: list returns all leader wakeups sorted by taskId", () => {
  const store = new SqliteTaskStore(temporaryHome());
  // Create enough tasks to exercise numeric (not lexicographic) sort.
  const taskIds = [];
  for (let i = 0; i < 12; i++) {
    const task = makeTask(store);
    store.saveTask(task);
    taskIds.push(task.id);
    store.savePendingWakeup(makeWakeup(task.id, 1));
  }
  // A non-leader mailbox must not appear in the wakeup list.
  store.enqueueMailboxSignal({ kind: "operator" }, { reason: "turn", requestId: "op-1" });

  const listed = store.listPendingWakeups();
  assert.equal(listed.length, 12);
  const listedIds = listed.map((w) => w.taskId);
  const sortedIds = [...listedIds].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  assert.deepEqual(listedIds, sortedIds, "wakeups sorted by numeric taskId");
  store.close();
});

test("pending wakeup: clear removes the wakeup", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const task = makeTask(store);
  store.saveTask(task);
  store.savePendingWakeup(makeWakeup(task.id, 1));
  assert.ok(store.getPendingWakeup(task.id) !== null);
  store.clearPendingWakeup(task.id);
  assert.equal(store.getPendingWakeup(task.id), null);
  // Clearing again is a no-op (mailbox already gone).
  store.clearPendingWakeup(task.id);
  store.close();
});

test("pending wakeup: staleness check rejects non-increasing requestCount", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const task = makeTask(store);
  store.saveTask(task);
  store.savePendingWakeup(makeWakeup(task.id, 2));

  // Equal requestCount is stale.
  assert.throws(
    () => store.savePendingWakeup(makeWakeup(task.id, 2)),
    (err) => err instanceof StorageRecordError && /stale/.test(err.message)
  );
  // Lower requestCount is stale.
  assert.throws(
    () => store.savePendingWakeup(makeWakeup(task.id, 1)),
    (err) => err instanceof StorageRecordError && /stale/.test(err.message)
  );
  // Greater requestCount succeeds and updates the projection.
  store.savePendingWakeup(makeWakeup(task.id, 3));
  assert.equal(store.getPendingWakeup(task.id).requestCount, 3);
  store.close();
});

test("pending wakeup: sequence range extends with each save", () => {
  const store = new SqliteTaskStore(temporaryHome());
  const task = makeTask(store);
  store.saveTask(task);
  store.savePendingWakeup(makeWakeup(task.id, 2));
  let mailbox = store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" });
  assert.equal(mailbox.pending.fromSequence, 1);
  assert.equal(mailbox.pending.toSequence, 2);
  assert.equal(mailbox.nextSequence, 3);

  // A second save with a greater count reuses the pending fromSequence and
  // widens the range (mirrors FileTaskStore: existing.pending.fromSequence wins).
  store.savePendingWakeup(makeWakeup(task.id, 5));
  mailbox = store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" });
  assert.equal(mailbox.pending.fromSequence, 1);
  assert.equal(mailbox.pending.toSequence, 5);
  assert.equal(mailbox.nextSequence, 6);
  store.close();
});
