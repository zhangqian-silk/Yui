import assert from "node:assert/strict";
import test from "node:test";

import {
  bindTaskRoleRun,
  clearTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunDelivered,
  recordObservedTaskRoleCompletion,
  recordRoleAgentSession,
  settleTaskRoleCompletion,
  validateRoleSessionSet
} from "../../dist/executor/agentExecutor.js";
import { createPendingTurnCompletion } from "../../dist/runtime/turnCompletion.js";

const PREPARED_AT = new Date("2026-07-23T02:00:00.000Z");
const DELIVERED_AT = new Date("2026-07-23T02:00:01.000Z");
const OBSERVED_AT = new Date("2026-07-23T02:01:00.000Z");
const DUE_AT = new Date("2026-07-23T02:01:02.000Z");
const SETTLED_AT = new Date("2026-07-23T02:01:03.000Z");

function taskSet() {
  return createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "leader" },
    "codex",
    PREPARED_AT
  );
}

function pending(overrides = {}) {
  return createPendingTurnCompletion({
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex",
    nativeSessionId: "thread-1",
    turnId: "turn-1",
    runId: "run-1",
    summary: "Leader finished the turn.",
    observedAt: OBSERVED_AT,
    dueAt: DUE_AT,
    ...overrides
  });
}

function bind(set = taskSet()) {
  return bindTaskRoleRun(set, {
    agentId: "codex",
    runId: "run-1",
    receiptId: "agent-run:run-1"
  }, PREPARED_AT);
}

function deliver(set = bind()) {
  return markTaskRoleRunDelivered(set, {
    agentId: "codex",
    runId: "run-1",
    receiptId: "agent-run:run-1"
  }, DELIVERED_AT);
}

test("a fresh Task Role can bind and deliver one exact Run before its native session is known", () => {
  const fresh = taskSet();
  assert.equal(fresh.schemaVersion, 2);
  assert.equal(fresh.sessions.codex, undefined);
  assert.equal(fresh.inFlight, null);
  assert.equal(fresh.pendingTurnCompletion, null);

  const bound = bind(fresh);
  assert.deepEqual(bound.inFlight, {
    agentId: "codex",
    runId: "run-1",
    receiptId: "agent-run:run-1",
    preparedAt: PREPARED_AT.toISOString()
  });
  assert.equal(bound.pendingTurnCompletion, null);
  assert.equal(fresh.inFlight, null);

  const delivered = deliver(bound);
  assert.equal(delivered.inFlight.deliveredAt, DELIVERED_AT.toISOString());
  assert.equal(bound.inFlight.deliveredAt, undefined);
});

test("Global Role session sets do not carry or accept Task Run fences", () => {
  const global = createRoleSessionSet(
    { scope: "global", roleName: "operator" },
    "codex",
    PREPARED_AT
  );

  assert.equal(global.schemaVersion, 2);
  assert.equal(Object.hasOwn(global, "inFlight"), false);
  assert.equal(Object.hasOwn(global, "pendingTurnCompletion"), false);
  assert.throws(() => bind(global), /Task Role session set/u);
  assert.throws(
    () => validateRoleSessionSet({ ...global, inFlight: null }),
    /Global Role session set must not contain.*inFlight/u
  );
});

test("observed completion is fenced by Task, Role, Agent, native session, and Run", () => {
  let set = deliver();
  set = recordRoleAgentSession(set, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-1",
    policy: "fixed",
    status: "running"
  }, DELIVERED_AT);

  const observed = recordObservedTaskRoleCompletion(set, pending());
  assert.deepEqual(observed.pendingTurnCompletion, pending());
  assert.equal(set.pendingTurnCompletion, null);

  assert.throws(
    () => recordObservedTaskRoleCompletion(set, pending({ runId: "run-old" })),
    /Run does not match.*in-flight/u
  );
  assert.throws(
    () => recordObservedTaskRoleCompletion(set, pending({ nativeSessionId: "thread-old" })),
    /native session does not match/u
  );
  const undelivered = recordRoleAgentSession(bind(), {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-1",
    policy: "fixed",
    status: "running"
  }, DELIVERED_AT);
  assert.throws(
    () => recordObservedTaskRoleCompletion(undelivered, pending()),
    /must be delivered/u
  );
});

test("settling an observed completion clears the fence and remembers bounded Turn ids", () => {
  let set = deliver();
  set = recordRoleAgentSession(set, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-1",
    policy: "fixed",
    status: "running"
  }, DELIVERED_AT);
  set = recordObservedTaskRoleCompletion(set, pending());
  const settled = settleTaskRoleCompletion(set, {
    agentId: "codex",
    runId: "run-1",
    turnId: "turn-1"
  }, SETTLED_AT);

  assert.equal(settled.inFlight, null);
  assert.equal(settled.pendingTurnCompletion, null);
  assert.deepEqual(settled.sessions.codex.recentCompletedTurnIds, ["turn-1"]);
  assert.equal(settled.updatedAt, SETTLED_AT.toISOString());
  assert.notEqual(settled.sessions.codex, set.sessions.codex);

  const duplicate = recordObservedTaskRoleCompletion(settled, pending());
  assert.equal(duplicate, settled);

  const rerecorded = recordRoleAgentSession(settled, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-1",
    policy: "fixed",
    status: "ready"
  }, new Date("2026-07-23T02:02:00.000Z"));
  assert.deepEqual(rerecorded.sessions.codex.recentCompletedTurnIds, ["turn-1"]);
});

test("clear and transition operations reject stale receipts and overlapping Runs", () => {
  const bound = bind();
  assert.throws(
    () => bindTaskRoleRun(bound, {
      agentId: "codex",
      runId: "run-2",
      receiptId: "agent-run:run-2"
    }, PREPARED_AT),
    /already has an in-flight Run/u
  );
  assert.throws(
    () => markTaskRoleRunDelivered(bound, {
      agentId: "codex",
      runId: "run-1",
      receiptId: "agent-run:stale"
    }, DELIVERED_AT),
    /receipt does not match/u
  );

  const cleared = clearTaskRoleRun(bound, {
    agentId: "codex",
    runId: "run-1",
    receiptId: "agent-run:run-1"
  }, DELIVERED_AT);
  assert.equal(cleared.inFlight, null);
  assert.equal(cleared.pendingTurnCompletion, null);
  assert.equal(bound.inFlight.runId, "run-1");
});
