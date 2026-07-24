import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RECENT_TURN_ID_LIMIT,
  createPendingTurnCompletion,
  hasRecentTurnId,
  rememberRecentTurnId,
  validatePendingTurnCompletion,
  validateRecentTurnIds
} from "../../dist/runtime/index.js";

const OBSERVED_AT = new Date("2026-07-23T01:00:00.000Z");
const DUE_AT = new Date("2026-07-23T01:00:02.000Z");

function pendingInput(overrides = {}) {
  return {
    taskId: " task-1 ",
    roleName: " leader ",
    agentId: " codex-personal ",
    nativeSessionId: " thread-1 ",
    turnId: " turn-1 ",
    runId: " run-1 ",
    summary: " Finished inspecting the task. ",
    observedAt: OBSERVED_AT,
    dueAt: DUE_AT,
    ...overrides
  };
}

test("pending Turn completion preserves the exact Run and native session boundary", () => {
  assert.deepEqual(createPendingTurnCompletion(pendingInput()), {
    schemaVersion: 1,
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex-personal",
    nativeSessionId: "thread-1",
    turnId: "turn-1",
    runId: "run-1",
    summary: "Finished inspecting the task.",
    observedAt: OBSERVED_AT.toISOString(),
    dueAt: DUE_AT.toISOString()
  });
});

test("persisted pending Turn completion records have a strict versioned shape", () => {
  const pending = createPendingTurnCompletion(pendingInput());

  assert.deepEqual(validatePendingTurnCompletion(pending), pending);
  assert.throws(
    () => validatePendingTurnCompletion({ ...pending, schemaVersion: 2 }),
    /schemaVersion 1/u
  );
  assert.throws(
    () => validatePendingTurnCompletion({ ...pending, extra: true }),
    /unknown field.*extra/u
  );
  const { runId: _runId, ...withoutRun } = pending;
  assert.throws(
    () => validatePendingTurnCompletion(withoutRun),
    /missing field.*runId/u
  );
});

test("pending Turn completion rejects unsafe identities and invalid time boundaries", () => {
  assert.throws(
    () => createPendingTurnCompletion(pendingInput({ turnId: "../turn-1" })),
    /Turn id is invalid/u
  );
  assert.throws(
    () => createPendingTurnCompletion(pendingInput({ summary: " " })),
    /Turn summary is required/u
  );
  assert.throws(
    () => createPendingTurnCompletion(pendingInput({
      observedAt: DUE_AT,
      dueAt: OBSERVED_AT
    })),
    /dueAt must not be earlier than observedAt/u
  );

  const pending = createPendingTurnCompletion(pendingInput());
  assert.throws(
    () => validatePendingTurnCompletion({ ...pending, observedAt: "yesterday" }),
    /observedAt must be a valid timestamp/u
  );
  assert.throws(
    () => validatePendingTurnCompletion({
      ...pending,
      dueAt: "2026-07-23T00:59:59.000Z"
    }),
    /dueAt must not be earlier than observedAt/u
  );
});

test("recent Turn ids are deduplicated, newest-last, immutable, and bounded", () => {
  const original = ["turn-1", "turn-2"];
  const moved = rememberRecentTurnId(original, "turn-1", 3);
  const bounded = rememberRecentTurnId(moved, "turn-3", 2);

  assert.deepEqual(original, ["turn-1", "turn-2"]);
  assert.deepEqual(moved, ["turn-2", "turn-1"]);
  assert.deepEqual(bounded, ["turn-1", "turn-3"]);
  assert.equal(hasRecentTurnId(bounded, "turn-1"), true);
  assert.equal(hasRecentTurnId(bounded, "turn-2"), false);
});

test("recent Turn id validation rejects duplicates, unsafe ids, and invalid bounds", () => {
  assert.equal(DEFAULT_RECENT_TURN_ID_LIMIT, 32);
  assert.deepEqual(validateRecentTurnIds(["turn-1", "turn-2"]), ["turn-1", "turn-2"]);
  assert.throws(
    () => validateRecentTurnIds(["turn-1", "turn-1"]),
    /must not contain duplicates/u
  );
  assert.throws(
    () => validateRecentTurnIds(["../turn-1"]),
    /Recent Turn id is invalid/u
  );
  assert.throws(
    () => validateRecentTurnIds(["turn-1", "turn-2"], 1),
    /must not contain more than 1/u
  );
  assert.throws(
    () => rememberRecentTurnId([], "turn-1", 0),
    /limit must be a positive integer/u
  );
});
