import Database from "better-sqlite3";
import { createTaskEvent } from "../../dist/event/taskEvent.js";

/**
 * Deterministic v18 ("Home version 18") fixture for the task-32 Requirement A
 * submit-intent migration (`migrateSubmitIntent`, dist/storage/migrations/
 * submitIntent.js).
 *
 * Kept as a test fixture (test/fixtures) rather than under src/ so no test-only
 * database scaffolding is compiled into dist/ or pinned into the release bundle:
 * the runtime assembler sweeps every src/**\/*.ts into the package, and this
 * helper is for tests alone. It follows the house fixture convention — a plain
 * .mjs importing the compiled runtime from dist/.
 *
 * Message rows use a frozen v18 encoding, independent of current constructors:
 * schemaVersion 3, optional wakePolicy, and no intent field. Current constructor
 * defaults must never rewrite the input of this historical migration test.
 *
 * The migration reads only four tables — `tasks_catalog`, `messages`, `events`,
 * `id_sequences` — so `seedSubmitIntentFixture` seeds exactly those and the
 * minimal schema is a faithful surface for testing the helper in isolation.
 * `buildSubmitIntentFixtureRows` exposes the same rows for the artifacts
 * WorkItem to insert into a full-schema v18 database when it exercises the
 * unified 18 -> 19 migration end to end.
 *
 * @typedef {{ authorKind: "user" | "operator" | "role-result",
 *   wakePolicy?: "leader" | "none", recipientWorkItemId?: string }} FixtureMessage
 * @typedef {{ taskId: string,
 *   status: "draft" | "active" | "completed" | "cancelled" | "archived",
 *   messages: readonly FixtureMessage[], preExistingPlanningEntered?: boolean,
 *   expectPlanningEnteredForMessageIndex: number | null }} FixtureCase
 */

const PLANNING_ENTERED_EVENT_TYPE = "task.planning-entered";

/**
 * The behavioural matrix. Task ids are deterministic and independent so the set
 * can be reordered or extended without perturbing other cases.
 * @type {readonly FixtureCase[]}
 */
const CASES = [
  // A Draft whose only submission is a legacy default (no wakePolicy): the
  // pre-Requirement-A Leader-waking discussion. It must gain the fact.
  { taskId: "task-1", status: "draft",
    messages: [{ authorKind: "user" }],
    expectPlanningEnteredForMessageIndex: 0 },
  // Same, with an explicit leader wake policy.
  { taskId: "task-2", status: "draft",
    messages: [{ authorKind: "user", wakePolicy: "leader" }],
    expectPlanningEnteredForMessageIndex: 0 },
  // A Draft whose only submission was save-only (old `none`, the shape `record`
  // now names): it stays legitimately unplanned and must NOT gain the fact.
  { taskId: "task-3", status: "draft",
    messages: [{ authorKind: "user", wakePolicy: "none" }],
    expectPlanningEnteredForMessageIndex: null },
  // An Operator submission is a user-authority submission and qualifies.
  { taskId: "task-4", status: "draft",
    messages: [{ authorKind: "operator" }],
    expectPlanningEnteredForMessageIndex: 0 },
  // An addressed continuation is not a submission; excluded by the recipient
  // filter even though it is a user Message with a Leader-waking default.
  { taskId: "task-5", status: "draft",
    messages: [{ authorKind: "user", recipientWorkItemId: "work-item-1" }],
    expectPlanningEnteredForMessageIndex: null },
  // A save-only Message followed by a real planning submission: the fact must
  // reference the FIRST qualifying Message (index 1), not the skipped save-only.
  { taskId: "task-6", status: "draft",
    messages: [
      { authorKind: "user", wakePolicy: "none" },
      { authorKind: "user", wakePolicy: "leader" }
    ],
    expectPlanningEnteredForMessageIndex: 1 },
  // An active Task is past the planning question: the helper filters on Draft,
  // so even a Leader-waking submission produces no fact.
  { taskId: "task-7", status: "active",
    messages: [{ authorKind: "user", wakePolicy: "leader" }],
    expectPlanningEnteredForMessageIndex: null },
  // A Draft that already carries the fact (from a real runtime planning entry):
  // idempotent, no second Event.
  { taskId: "task-8", status: "draft",
    messages: [{ authorKind: "user", wakePolicy: "leader" }],
    preExistingPlanningEntered: true,
    expectPlanningEnteredForMessageIndex: null },
  // A Draft whose only Message is an internal role result never gains develop
  // authority and is excluded by the kind filter.
  { taskId: "task-9", status: "draft",
    messages: [{ authorKind: "role-result" }],
    expectPlanningEnteredForMessageIndex: null },
  // A Draft with no Messages at all: nothing to derive from.
  { taskId: "task-10", status: "draft",
    messages: [],
    expectPlanningEnteredForMessageIndex: null }
];

const FIXTURE_EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);
/** One deterministic minute per allocated record keeps ordering and uniqueness
 *  stable without any wall-clock read. */
const TICK_MS = 60_000;

/**
 * Build every pre-migration row deterministically, plus the expected result.
 *
 * Ids follow the runtime's own allocation: `nextMessageId` and `nextEventId` are
 * independent per-Task sequences, and each saved Message also writes a
 * `message.sent` Event under the same timestamp, so a Task with M Messages holds
 * message-1..M and event-1..M before any planning-entered Event.
 *
 * @returns {{ tasksCatalog: object[], messages: object[], events: object[],
 *   idSequences: object[], expectedPlanningEntered: Map<string, string> }}
 */
export function buildSubmitIntentFixtureRows() {
  const tasksCatalog = [];
  const messages = [];
  const events = [];
  const idSequences = [];
  const expectedPlanningEntered = new Map();
  let tick = 0;
  const nextDate = () => new Date(FIXTURE_EPOCH + (tick++) * TICK_MS);

  for (const kase of CASES) {
    const createdAt = new Date(FIXTURE_EPOCH).toISOString();
    tasksCatalog.push({
      task_id: kase.taskId,
      status: kase.status,
      lifecycle: kase.status === "draft" || kase.status === "active" ? "open" : "closed",
      is_active: kase.status === "active" ? 1 : 0,
      created_at: createdAt,
      updated_at: createdAt
    });

    let eventSeq = 0;
    kase.messages.forEach((spec, index) => {
      const messageId = `message-${index + 1}`;
      const now = nextDate();
      const author = spec.authorKind === "operator"
        ? { type: "operator" }
        : spec.authorKind === "role-result"
          ? { type: "role", roleName: "leader" }
          : { type: "user" };
      const kind = spec.authorKind === "role-result" ? "role-result" : spec.authorKind;
      const context = {
        ...(spec.wakePolicy === undefined ? {} : { wakePolicy: spec.wakePolicy }),
        ...(spec.recipientWorkItemId === undefined
          ? {}
          : { recipient: { roleName: "leader", workItemId: spec.recipientWorkItemId } })
      };
      const message = {
        schemaVersion: 3, id: messageId, taskId: kase.taskId,
        body: `${kase.taskId} ${messageId} body`, kind, author, ...context,
        createdAt: now.toISOString()
      };
      messages.push({
        task_id: kase.taskId, message_id: message.id, seq: index + 1,
        payload: JSON.stringify(message), created_at: message.createdAt
      });
      // Every saved Message also wrote its message.sent Event at the same instant.
      const sent = createTaskEvent(`event-${++eventSeq}`, kase.taskId, "message.sent",
        { messageId: message.id, kind: message.kind }, now);
      events.push({
        task_id: kase.taskId, event_id: sent.id, type: sent.type,
        occurred_at: sent.createdAt, payload: JSON.stringify(sent)
      });
    });

    if (kase.preExistingPlanningEntered) {
      const planned = createTaskEvent(`event-${++eventSeq}`, kase.taskId, PLANNING_ENTERED_EVENT_TYPE,
        { messageId: "message-1", intent: "discuss" }, nextDate());
      events.push({
        task_id: kase.taskId, event_id: planned.id, type: planned.type,
        occurred_at: planned.createdAt, payload: JSON.stringify(planned)
      });
    }

    if (kase.messages.length > 0) {
      idSequences.push({ task_id: kase.taskId, kind: "message", high_water: kase.messages.length });
    }
    if (eventSeq > 0) {
      idSequences.push({ task_id: kase.taskId, kind: "event", high_water: eventSeq });
    }

    if (kase.expectPlanningEnteredForMessageIndex !== null) {
      expectedPlanningEntered.set(kase.taskId,
        `message-${kase.expectPlanningEnteredForMessageIndex + 1}`);
    }
  }

  return { tasksCatalog, messages, events, idSequences, expectedPlanningEntered };
}

/** The task ids the migration must NOT alter, for negative assertions. */
export const SUBMIT_INTENT_UNAFFECTED_TASKS =
  CASES.filter((kase) => kase.expectPlanningEnteredForMessageIndex === null).map((kase) => kase.taskId);

/**
 * Create exactly the four tables the migration reads, with the v18 column shapes.
 * `IF NOT EXISTS` keeps this a safe no-op when applied to a full-schema database.
 * @param {Database.Database} db
 */
export function applySubmitIntentFixtureSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS tasks_catalog (
  task_id     TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  lifecycle   TEXT NOT NULL,
  is_active   INTEGER NOT NULL CHECK (is_active IN (0,1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  task_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, message_id)
);
CREATE TABLE IF NOT EXISTS events (
  task_id     TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  type        TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (task_id, event_id)
);
CREATE TABLE IF NOT EXISTS id_sequences (
  task_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  high_water INTEGER NOT NULL,
  PRIMARY KEY (task_id, kind)
);
`);
}

/**
 * Insert every fixture row into a database whose schema already exists.
 * @param {Database.Database} db
 */
export function seedSubmitIntentFixture(db) {
  const rows = buildSubmitIntentFixtureRows();
  const insert = (table, row) => {
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...columns.map((column) => row[column]));
  };
  const tx = db.transaction(() => {
    for (const row of rows.tasksCatalog) insert("tasks_catalog", row);
    for (const row of rows.messages) insert("messages", row);
    for (const row of rows.events) insert("events", row);
    for (const row of rows.idSequences) insert("id_sequences", row);
  });
  tx();
}

/**
 * Convenience for isolated helper tests: an in-memory v18 subset, seeded.
 * @returns {Database.Database}
 */
export function createSubmitIntentFixtureDatabase() {
  const db = new Database(":memory:");
  applySubmitIntentFixtureSchema(db);
  seedSubmitIntentFixture(db);
  return db;
}
