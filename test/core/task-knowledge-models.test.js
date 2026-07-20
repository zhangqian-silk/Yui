import assert from "node:assert/strict";
import test from "node:test";

import { createTaskBrief, updateTaskBrief } from "../../dist/brief/taskBrief.js";
import { createDecision, supersedeDecision } from "../../dist/decision/decision.js";
import { appendTaskEvent, createTaskEvent } from "../../dist/event/taskEvent.js";
import { createMilestone } from "../../dist/milestone/milestone.js";

const now = new Date("2026-07-20T08:00:00.000Z");
const later = new Date("2026-07-20T08:05:00.000Z");

test("TaskBrief is a normalized replaceable current snapshot", () => {
  const boundaries = [" stay local ", "", "stay local", "no schedules"];
  const brief = createTaskBrief({
    objective: " restore the useful task model ",
    boundaries,
    currentFocus: " domain records ",
    leaderSummary: " implementation has started ",
    updatedBy: " leader "
  }, now);

  boundaries.push("mutated afterwards");
  assert.deepEqual(brief, {
    schemaVersion: 1,
    objective: "restore the useful task model",
    boundaries: ["stay local", "no schedules"],
    currentFocus: "domain records",
    leaderSummary: "implementation has started",
    updatedAt: now.toISOString(),
    updatedBy: "leader"
  });

  const updated = updateTaskBrief(brief, {
    currentFocus: " storage integration ",
    leaderSummary: " domain records are ready "
  }, "operator", later);

  assert.equal(brief.currentFocus, "domain records");
  assert.equal(updated.objective, brief.objective);
  assert.equal(updated.currentFocus, "storage integration");
  assert.equal(updated.leaderSummary, "domain records are ready");
  assert.equal(updated.updatedBy, "operator");
  assert.equal(updated.updatedAt, later.toISOString());
});

test("TaskBrief rejects empty required content", () => {
  assert.throws(() => createTaskBrief({
    objective: " ",
    boundaries: [],
    currentFocus: "focus",
    leaderSummary: "summary",
    updatedBy: "leader"
  }, now), /objective.*required/i);
  assert.throws(() => createTaskBrief({
    objective: "objective",
    boundaries: [],
    currentFocus: "focus",
    leaderSummary: "summary",
    updatedBy: "\0leader"
  }, now), /updated by.*invalid/i);
});

test("Decision has a one-way active to superseded lifecycle", () => {
  const decision = createDecision(
    "decision-1",
    "task-1",
    " Keep models small ",
    " The current product does not need Topic or Cycle. ",
    now
  );
  assert.deepEqual(decision, {
    schemaVersion: 1,
    id: "decision-1",
    taskId: "task-1",
    title: "Keep models small",
    rationale: "The current product does not need Topic or Cycle.",
    status: "active",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  });

  const superseded = supersedeDecision(decision, " Replaced by decision-2 ", later);
  assert.equal(decision.status, "active");
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.supersededReason, "Replaced by decision-2");
  assert.equal(superseded.supersededAt, later.toISOString());
  assert.throws(() => supersedeDecision(superseded, "again", later), /already superseded/i);
});

test("Decision and Milestone reject unsafe aggregate identities", () => {
  assert.throws(
    () => createDecision("../decision", "task-1", "title", "reason", now),
    /Decision id is invalid/i
  );
  assert.throws(
    () => createMilestone("milestone-1", "../task", "title", "summary", now),
    /Task id is invalid/i
  );
});

test("Milestone is a leader-authored append-only fact", () => {
  const milestone = createMilestone(
    "milestone-1",
    "task-1",
    " Domain restored ",
    " Brief, Decision, and Milestone are available. ",
    now
  );

  assert.deepEqual(milestone, {
    schemaVersion: 1,
    id: "milestone-1",
    taskId: "task-1",
    title: "Domain restored",
    summary: "Brief, Decision, and Milestone are available.",
    createdBy: "leader",
    createdAt: now.toISOString()
  });
});

test("TaskEvent appends without replacing an existing event", () => {
  const sourcePayload = { title: "Created", status: "draft" };
  const first = createTaskEvent("event-1", " task.created ", sourcePayload, now);
  sourcePayload.status = "active";
  const second = createTaskEvent("event-2", "task.activated", { status: "active" }, later);

  const history = appendTaskEvent([first], second);
  assert.deepEqual(history.map((event) => event.id), ["event-1", "event-2"]);
  assert.equal(history[0].payload.status, "draft");
  assert.equal(first.type, "task.created");
  assert.throws(() => appendTaskEvent(history, {
    ...second,
    type: "task.changed"
  }), /already exists/i);
});
