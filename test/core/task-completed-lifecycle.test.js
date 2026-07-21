import assert from "node:assert/strict";
import test from "node:test";

import {
  activateTask,
  archiveTask,
  completeTask,
  createTask,
  reopenTask
} from "../../dist/task/task.js";

const CREATED = new Date("2026-07-20T00:00:00.000Z");

test("Task completion is a reversible fence before terminal archive", () => {
  const draft = createTask("task-1", "Lifecycle", CREATED);
  const active = activateTask(draft, new Date("2026-07-20T00:01:00.000Z"));
  const completed = completeTask(active, new Date("2026-07-20T00:02:00.000Z"), {
    by: "leader",
    summary: "All requested work is done."
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.completedBy, "leader");
  assert.equal(completed.completionSummary, "All requested work is done.");
  assert.equal(completed.completedAt, "2026-07-20T00:02:00.000Z");
  assert.throws(() => activateTask(completed, CREATED), /reopen/i);

  const reopened = reopenTask(completed, new Date("2026-07-20T00:03:00.000Z"));
  assert.equal(reopened.status, "active");
  assert.equal("completedAt" in reopened, false);
  assert.equal("completedBy" in reopened, false);
  assert.equal("completionSummary" in reopened, false);

  const archived = archiveTask(reopened, new Date("2026-07-20T00:04:00.000Z"));
  assert.throws(() => reopenTask(archived, CREATED), /archived/i);
});

test("only active Tasks can become completed", () => {
  const draft = createTask("task-1", "Lifecycle", CREATED);
  assert.throws(
    () => completeTask(draft, CREATED, { by: "user", summary: "Not started." }),
    /active/i
  );
});
