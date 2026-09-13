import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { migrateSubmitIntent } from "../../dist/storage/migrations/submitIntent.js";
import { TASK_PLANNING_ENTERED_EVENT, draftHasEnteredPlanning } from "../../dist/task/taskSubmission.js";
import {
  applySubmitIntentFixtureSchema,
  buildSubmitIntentFixtureRows,
  createSubmitIntentFixtureDatabase,
  SUBMIT_INTENT_UNAFFECTED_TASKS
} from "../fixtures/submitIntentFixture.mjs";

const PLANNING_ENTERED = "task.planning-entered";

/** All planning-entered Events on a Task, id-ordered by their numeric suffix. */
function planningEnteredEvents(db, taskId) {
  return (db.prepare("SELECT event_id, payload FROM events WHERE task_id = ? AND type = ?")
    .all(taskId, PLANNING_ENTERED))
    .map((row) => ({ eventId: row.event_id, event: JSON.parse(row.payload) }))
    .sort((a, b) => Number(a.eventId.slice("event-".length)) - Number(b.eventId.slice("event-".length)));
}

test("historical planning events retain their wire name and are read by the current runtime", () => {
  // This literal is a stored contract, not an internal tuning constant. Keep
  // the independent expectation next to the actual migration/reader check.
  assert.equal(TASK_PLANNING_ENTERED_EVENT, PLANNING_ENTERED);
  const db = createSubmitIntentFixtureDatabase();
  const { expectedPlanningEntered } = buildSubmitIntentFixtureRows();
  try {
    migrateSubmitIntent(db);

    for (const [taskId, messageId] of expectedPlanningEntered) {
      const rows = planningEnteredEvents(db, taskId);
      assert.equal(rows.length, 1, `expected exactly one planning-entered Event on ${taskId}`);
      assert.equal(rows[0].event.type, TASK_PLANNING_ENTERED_EVENT);
      assert.equal(rows[0].event.payload.messageId, messageId,
        `${taskId} planning-entered must reference ${messageId}`);
      // Intent is recorded as discuss and never inferred from the body.
      assert.equal(rows[0].event.payload.intent, "discuss");
      assert.equal(draftHasEnteredPlanning({
        listEvents: () => rows.map(row => row.event),
        listRuns: () => [],
        getTaskRoleSessionSet: () => null
      }, { id: taskId, status: "draft" }), true,
      "Current planning must recognize the historical stored event, without a Run or Session.");
    }

    for (const taskId of SUBMIT_INTENT_UNAFFECTED_TASKS) {
      // task-8 pre-carries exactly one planning-entered Event (idempotency case);
      // every other unaffected Task must carry none.
      const rows = planningEnteredEvents(db, taskId);
      const expected = taskId === "task-8" ? 1 : 0;
      assert.equal(rows.length, expected,
        `${taskId} must have ${expected} planning-entered Event(s)`);
    }
  } finally {
    db.close();
  }
});

test("submit-intent migration preserves original events and is idempotent across repeated runs", () => {
  const db = createSubmitIntentFixtureDatabase();
  try {
    const originalMessages = db.prepare("SELECT task_id, event_id, payload FROM events WHERE type = 'message.sent' ORDER BY task_id, event_id").all();
    migrateSubmitIntent(db);
    assert.deepEqual(
      db.prepare("SELECT task_id, event_id, payload FROM events WHERE type = 'message.sent' ORDER BY task_id, event_id").all(),
      originalMessages, "migration must not touch existing message.sent events");
    const first = db.prepare("SELECT task_id, event_id, type, occurred_at, payload FROM events ORDER BY task_id, event_id").all();
    migrateSubmitIntent(db);
    migrateSubmitIntent(db);
    const third = db.prepare("SELECT task_id, event_id, type, occurred_at, payload FROM events ORDER BY task_id, event_id").all();
    assert.deepEqual(third, first, "re-running the migration must not add or change any Event");
  } finally {
    db.close();
  }
});

test("submit-intent migration allocates event ids above the existing high-water", () => {
  const db = createSubmitIntentFixtureDatabase();
  try {
    migrateSubmitIntent(db);
    // task-2 held message-1 + event-1 (message.sent) at high-water 1; the derived
    // planning-entered Event must be event-2 and the id_sequence must advance.
    const rows = planningEnteredEvents(db, "task-2");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].eventId, "event-2");
    const highWater = db.prepare("SELECT high_water FROM id_sequences WHERE task_id = ? AND kind = 'event'").get("task-2");
    assert.equal(highWater.high_water, 2);
  } finally {
    db.close();
  }
});

test("submit-intent migration never collides when id_sequences lags the events table", () => {
  // A historical database whose id_sequences under-counts the events actually
  // present must still allocate a fresh, non-colliding id.
  const db = new Database(":memory:");
  try {
    applySubmitIntentFixtureSchema(db);
    const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
    db.prepare("INSERT INTO tasks_catalog (task_id, status, lifecycle, is_active, created_at, updated_at) VALUES (?, 'draft', 'open', 0, ?, ?)")
      .run("task-lag", now, now);
    db.prepare("INSERT INTO messages (task_id, message_id, seq, payload, created_at) VALUES (?, 'message-1', 1, ?, ?)")
      .run("task-lag", JSON.stringify({
        schemaVersion: 3, id: "message-1", taskId: "task-lag", kind: "user",
        author: { type: "user" }, body: "planning please", wakePolicy: "leader", createdAt: now
      }), now);
    // events already hold event-1..event-5, but id_sequences claims high-water 2.
    for (let index = 1; index <= 5; index += 1) {
      db.prepare("INSERT INTO events (task_id, event_id, type, occurred_at, payload) VALUES (?, ?, 'message.sent', ?, ?)")
        .run("task-lag", `event-${index}`, now, JSON.stringify({
          schemaVersion: 2, id: `event-${index}`, taskId: "task-lag", type: "message.sent",
          payload: { messageId: "message-1", kind: "user" }, createdAt: now
        }));
    }
    db.prepare("INSERT INTO id_sequences (task_id, kind, high_water) VALUES (?, 'event', 2)").run("task-lag");

    migrateSubmitIntent(db);

    const rows = planningEnteredEvents(db, "task-lag");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].eventId, "event-6", "must allocate above the largest present event id");
    const highWater = db.prepare("SELECT high_water FROM id_sequences WHERE task_id = ? AND kind = 'event'").get("task-lag");
    assert.equal(highWater.high_water, 6);
  } finally {
    db.close();
  }
});

test("submit-intent migration on an empty database is a no-op", () => {
  const db = new Database(":memory:");
  try {
    applySubmitIntentFixtureSchema(db);
    migrateSubmitIntent(db);
    assert.equal(db.prepare("SELECT count(*) AS n FROM events").get().n, 0);
  } finally {
    db.close();
  }
});
