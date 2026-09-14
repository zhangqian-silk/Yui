import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import { routeInvocation } from "../../dist/cli/invocationRouter.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createIntegrationAttempt, recordIntegrationConflict } from "../../dist/integration/integrationAttempt.js";
import { projectCompletionReadiness } from "../../dist/task/completionReadiness.js";

test("retiring the integration queue preserves original intent and active attempts without replay", t => {
  assert.equal(routeInvocation(["task", "integration", "queue", "process", "task-1"]).kind, "path-error");
  const home = mkdtempSync(join(tmpdir(), "yui-atomic-entrypoints-"));
  const db = new Database(join(home, "yui.db"));
  t.after(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  migrateSqliteSchema(db, { mode: "apply", throughVersion: 28 });
  const now = new Date("2026-09-14T00:00:00Z");
  const task = activateTask(createTask("task-1", "Preserve queued delivery", now), now);
  db.prepare("INSERT INTO tasks_catalog(task_id, status, lifecycle, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(task.id, task.status, "execution", 1, task.createdAt, task.updatedAt);
  db.prepare("INSERT INTO task_records(task_id, payload, updated_at) VALUES (?, ?, ?)")
    .run(task.id, JSON.stringify(task), now.toISOString());
  const prior = createTaskEvent("event-8", task.id, "user.requirement", { body: "Keep my work" }, now);
  db.prepare("INSERT INTO events(task_id, event_id, type, occurred_at, payload) VALUES (?, ?, ?, ?, ?)")
    .run(task.id, prior.id, prior.type, prior.createdAt, JSON.stringify(prior));
  db.prepare("INSERT INTO id_sequences(task_id, kind, high_water) VALUES (?, 'event', 20)").run(task.id);
  const attempt = createIntegrationAttempt({
    id: "integration-1", taskId: task.id, projectId: "project-1", targetRef: "main",
    beforeCommit: "a".repeat(40), source: {
      kind: "work-item", workItemId: "work-item-1", startCommit: "a".repeat(40),
      resultCommit: "b".repeat(40), strategy: "cherry-pick"
    }
  }, now);
  db.prepare("INSERT INTO integration_attempts(task_id, integration_id, status, payload, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(task.id, attempt.id, attempt.status, JSON.stringify(attempt), now.toISOString());
  const originals = ["queued", "running"].map((status, index) => JSON.stringify({
    schemaVersion: 1, id: `integration-queue-${index + 1}`, taskId: task.id,
    projectId: "project-1", changeSetId: `change-set-${index + 1}`, targetRef: "main",
    status, checkCommands: ["node check.mjs"], evidenceRefs: [],
    ...(status === "running" ? { integrationAttemptId: attempt.id, targetBefore: attempt.beforeCommit } : {}),
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  }));
  for (const payload of originals) {
    const entry = JSON.parse(payload);
    db.prepare("INSERT INTO integration_queue(queue_id, task_id, project_id, change_set, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(entry.id, task.id, entry.projectId, entry.changeSetId, entry.status, payload, entry.createdAt, entry.updatedAt);
  }
  const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  const taskBefore = db.prepare("SELECT * FROM task_records").all();
  const attemptsBefore = db.prepare("SELECT * FROM integration_attempts").all();
  db.exec(`CREATE TRIGGER refuse_retirement BEFORE INSERT ON events
    WHEN NEW.type = 'integration.queue-retired' BEGIN SELECT RAISE(ABORT, 'fixture retirement failure'); END;`);
  assert.throws(() => migrateSqliteSchema(db, { mode: "apply" }), /fixture retirement failure/);
  assert.deepEqual(db.prepare("SELECT payload FROM integration_queue ORDER BY queue_id").all().map(row => row.payload), originals);
  assert.deepEqual(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), ledger);
  db.exec("DROP TRIGGER refuse_retirement");
  migrateSqliteSchema(db, { mode: "apply" });
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='integration_queue'").get().n, 0);
  assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version <= 28 ORDER BY version").all(), ledger);
  assert.deepEqual(db.prepare("SELECT * FROM task_records").all(), taskBefore);
  assert.deepEqual(db.prepare("SELECT * FROM integration_attempts").all(), attemptsBefore);
  const readiness = projectCompletionReadiness({
    task, workItems: [], changeSets: [], integrations: [
      recordIntegrationConflict(attempt, { affectedPaths: ["file"], summary: "Resolve existing conflict" }, now)
    ],
    reviewRounds: [], reviewConfig: null, openInputRequests: [], activeRuns: [], leaderRuns: [],
    managedWorkspaces: [], durableJobs: []
  });
  assert.ok(readiness.blockers.some(blocker => blocker.code === "unresolved-integration"),
    "Retiring a queue cannot make its still-conflicted Integration look complete.");
  const events = db.prepare("SELECT payload FROM events WHERE type='integration.queue-retired' ORDER BY event_id").all()
    .map(row => JSON.parse(row.payload));
  assert.deepEqual(events.map(event => event.id), ["event-21", "event-22"]);
  assert.deepEqual(events.map(event => event.payload.record), originals);
  assert.ok(events.every(event => event.payload.disposition === "retired-without-replay"));
  for (const event of events) assert.deepEqual(
    createTaskEvent(event.id, event.taskId, event.type, event.payload, new Date(event.createdAt)), event
  );
  assert.deepEqual(JSON.parse(db.prepare("SELECT payload FROM events WHERE event_id='event-8'").get().payload), prior);
  assert.equal(db.prepare("SELECT high_water FROM id_sequences WHERE task_id=? AND kind='event'").get(task.id).high_water, 22);
  migrateSqliteSchema(db, { mode: "apply" });
  assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE type='integration.queue-retired'").get().n, 2);
});
