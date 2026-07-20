import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTaskBrief, updateTaskBrief } from "../../dist/brief/taskBrief.js";
import { createDecision, supersedeDecision } from "../../dist/decision/decision.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createMilestone } from "../../dist/milestone/milestone.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { createTask } from "../../dist/task/task.js";

const NOW = new Date("2026-07-20T08:00:00.000Z");
const LATER = new Date("2026-07-20T08:05:00.000Z");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "taskmux-knowledge-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  store.saveTask(createTask("task-1", "Knowledge persistence", NOW));
  store.saveTask(createTask("task-2", "Ownership boundary", NOW));
  return { root, store };
}

test("TaskBrief is one replaceable snapshot that can be cleared and reloaded", (t) => {
  const { root, store } = fixture(t);
  const brief = createTaskBrief({
    objective: "Restore useful knowledge",
    boundaries: ["No Topic", "No Schedule"],
    currentFocus: "Storage",
    leaderSummary: "Domain model is ready",
    updatedBy: "leader"
  }, NOW);

  assert.equal(store.getTaskBrief("task-1"), null);
  store.saveTaskBrief("task-1", brief);
  assert.deepEqual(new FileTaskStore(root).getTaskBrief("task-1"), brief);

  const updated = updateTaskBrief(brief, {
    currentFocus: "Validation",
    leaderSummary: "Storage is connected"
  }, "operator", LATER);
  store.saveTaskBrief("task-1", updated);
  assert.deepEqual(store.getTaskBrief("task-1"), updated);

  store.clearTaskBrief("task-1");
  assert.equal(new FileTaskStore(root).getTaskBrief("task-1"), null);
});

test("Decision IDs are generated globally and only allow active to superseded updates", (t) => {
  const { root, store } = fixture(t);
  const decision = createDecision(
    store.nextDecisionId("task-1"),
    "task-1",
    "Keep storage compact",
    "One aggregate is sufficient for the current release",
    NOW
  );
  store.saveDecision("task-1", decision);

  assert.equal(store.nextDecisionId("task-2"), "decision-2");
  const invalidInitialState = supersedeDecision(
    createDecision("decision-2", "task-2", "Already stale", "Invalid initial state", NOW),
    "No active record was persisted",
    LATER
  );
  assert.throws(
    () => store.saveDecision("task-2", invalidInitialState),
    /must start active/i
  );
  assert.throws(() => store.saveDecision("task-1", decision), /cannot be overwritten/i);
  assert.throws(
    () => store.saveDecision("task-2", { ...decision, id: "decision-2" }),
    /belongs to another Task/i
  );

  const superseded = supersedeDecision(decision, "Generation storage will replace it", LATER);
  store.saveDecision("task-1", superseded);
  assert.deepEqual(new FileTaskStore(root).listDecisions("task-1"), [superseded]);
  const {
    supersededReason: _supersededReason,
    supersededAt: _supersededAt,
    ...rolledBack
  } = superseded;
  assert.throws(
    () => store.saveDecision("task-1", { ...rolledBack, status: "active" }),
    /cannot be overwritten/i
  );
  assert.throws(
    () => store.saveDecision("task-1", { ...superseded, title: "Mutated title" }),
    /cannot be overwritten/i
  );
});

test("Milestones are append-only and enforce Task ownership", (t) => {
  const { root, store } = fixture(t);
  const milestone = createMilestone(
    store.nextMilestoneId("task-1"),
    "task-1",
    "Knowledge connected",
    "Brief, Decision, Milestone, and Event are durable",
    NOW
  );
  store.saveMilestone("task-1", milestone);

  assert.equal(store.nextMilestoneId("task-2"), "milestone-2");
  assert.deepEqual(new FileTaskStore(root).listMilestones("task-1"), [milestone]);
  assert.throws(
    () => store.saveMilestone("task-1", { ...milestone, summary: "Overwritten" }),
    /already exists/i
  );
  assert.throws(
    () => store.saveMilestone("task-2", { ...milestone, id: "milestone-2" }),
    /belongs to another Task/i
  );
});

test("TaskEvent persistence is truly append-only", (t) => {
  const { root, store } = fixture(t);
  const event = createTaskEvent(
    store.nextEventId("task-1"),
    "task.created",
    { status: "draft" },
    NOW
  );
  store.saveEvent("task-1", event);

  assert.equal(store.nextEventId("task-2"), "event-2");
  assert.deepEqual(new FileTaskStore(root).listEvents("task-1"), [event]);
  assert.throws(
    () => store.saveEvent("task-1", { ...event, type: "task.activated" }),
    /already exists/i
  );
  assert.deepEqual(new FileTaskStore(root).listEvents("task-1"), [event]);
});
