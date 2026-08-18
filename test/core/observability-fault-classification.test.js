import assert from "node:assert/strict";
import test from "node:test";

import {
  NO_FAULT,
  classifyAgentRunFailure,
  classifyIntegrationAttempt,
  classifyReviewRound,
  classifyWakeReasons,
  countFaultClasses,
  emptyFaultClassCounts
} from "../../dist/observability/faultClassification.js";

test("agent run failures classify provider transient faults from historical summaries", () => {
  const cases = [
    ["Claude StopFailure.\nerror: server_error\nlast_assistant_message: API Error: 504 Gateway Time-out.", "provider-transient"],
    ["Claude StopFailure. API Error: Connection lost mid-response.", "provider-transient"],
    ["The role's tmux session exited before the run yielded.", "session-dead"],
    ["Leader dispatch failed: Live Role Agent native session cannot be replaced: claude.", "session-dead"],
    ["Leader dispatch failed: COMMAND_TIMED_OUT", "storage-backend-lock"],
    ["Leader dispatch failed: Runtime launch reservation belongs to stale Role or Agent state: leader.", "stale-base-target-cas"],
    ["Role Run could not start: Command execution failed.", "session-dead"],
    ["Something unfamiliar went wrong", "other"]
  ];
  for (const [summary, expected] of cases) {
    const classification = classifyAgentRunFailure({ status: "failed", summary });
    assert.equal(classification.faultClass, expected, summary);
    assert.equal(classification.basis, "text-historical");
    assert.ok(classification.evidence.length > 0);
  }
});

test("structured hints take precedence over text for agent run failures", () => {
  const classification = classifyAgentRunFailure(
    { status: "failed", summary: "tmux session exited" },
    { faultClass: "provider-transient", evidence: "capability provider" }
  );
  assert.equal(classification.faultClass, "provider-transient");
  assert.equal(classification.basis, "structured");
  assert.equal(classification.evidence, "capability provider");
});

test("non-failed runs are not classified", () => {
  assert.deepEqual(classifyAgentRunFailure({ status: "yielded", summary: "ok" }), NO_FAULT);
  assert.deepEqual(classifyAgentRunFailure({ status: "active", summary: undefined }), NO_FAULT);
});

test("review rounds separate execution failure from semantic negatives", () => {
  const infra = classifyReviewRound({ status: "failed", checks: [] });
  assert.equal(infra.faultClass, "review-infra");
  assert.equal(infra.basis, "structured");
  const semantic = classifyReviewRound({
    status: "completed",
    checks: [
      { name: "build", outcome: "passed" },
      { name: "tests", outcome: "failed", details: "2 failing" }
    ]
  });
  assert.equal(semantic.faultClass, "review-semantic-negative");
  const clean = classifyReviewRound({
    status: "completed",
    checks: [{ name: "build", outcome: "passed" }]
  });
  assert.deepEqual(clean, NO_FAULT);
});

test("integration attempts separate environment, stale-base, and candidate failures", () => {
  const environment = classifyIntegrationAttempt({
    status: "failed",
    checks: [{ name: "verify", outcome: "failed", details: "tsc: not found" }],
    conflict: undefined
  });
  assert.equal(environment.faultClass, "integration-environment");
  assert.equal(environment.basis, "text-historical");
  const stale = classifyIntegrationAttempt({
    status: "failed",
    checks: [],
    conflict: { affectedPaths: ["a.ts"], summary: "expected head moved" }
  });
  assert.equal(stale.faultClass, "stale-base-target-cas");
  assert.equal(stale.basis, "structured");
  const candidate = classifyIntegrationAttempt({
    status: "failed",
    checks: [{ name: "tests", outcome: "failed", details: "assertion failed" }],
    conflict: undefined
  });
  assert.equal(candidate.faultClass, "integration-candidate-failure");
  const committed = classifyIntegrationAttempt({
    status: "committed",
    checks: [],
    conflict: undefined
  });
  assert.deepEqual(committed, NO_FAULT);
});

test("wake reasons classify orphan wakes as duplicate/suppressed", () => {
  const orphan = classifyWakeReasons(["task-orphaned"]);
  assert.equal(orphan.faultClass, "scheduler-duplicate-suppressed-wake");
  const mixed = classifyWakeReasons(["user-message", "task-orphaned"]);
  assert.equal(mixed.faultClass, "scheduler-duplicate-suppressed-wake");
  assert.deepEqual(classifyWakeReasons(["user-message"]), NO_FAULT);
});

test("fault class counts cover the whole taxonomy", () => {
  const counts = countFaultClasses([
    classifyAgentRunFailure({ status: "failed", summary: "API Error: 500" }),
    classifyAgentRunFailure({ status: "failed", summary: "API Error: 502" }),
    classifyReviewRound({ status: "failed", checks: [] })
  ]);
  assert.equal(counts["provider-transient"], 2);
  assert.equal(counts["review-infra"], 1);
  assert.equal(counts["session-dead"], 0);
  const empty = emptyFaultClassCounts();
  for (const value of Object.values(empty)) assert.equal(value, 0);
});
