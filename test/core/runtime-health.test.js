import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRuntimeHealth,
  createRuntimeProjection,
  projectRuntimeObservation
} from "../../dist/runtime/runtimeProjection.js";
import { createRuntimeObservation } from "../../dist/runtime/runtimeObservation.js";
import {
  DEFAULT_RUNTIME_HEALTH_POLICY,
  RUNTIME_QUIET_AFTER_MS,
  RUNTIME_DIAGNOSTIC_AFTER_MS,
  SEMANTIC_STALL_WINDOW_MS
} from "../../dist/runtime/runtimeHealthPolicy.js";
import {
  DEFAULT_STALL_WINDOW_MS,
  DEFAULT_WORKFLOW_STALL_CANDIDATE_AGE_MS
} from "../../dist/scheduler/roleRunStall.js";

const fence = {
  taskId: "task-1",
  roleName: "leader",
  runId: "agent-run-1",
  agentId: "claude",
  driverId: "anthropic/claude-code",
  launchId: "launch-1",
  sessionGenerationId: "launch-1",
  nativeSessionId: "native-session-1",
  nativeTurnId: "turn-1",
  receiptId: "agent-run:task-1/agent-run-1"
};

const t0 = new Date("2026-08-22T00:00:00.000Z");

function acceptedTurnProjection() {
  let projection = createRuntimeProjection(fence, t0.toISOString());
  projection = projectRuntimeObservation(projection, createRuntimeObservation({
    schemaVersion: 2,
    eventId: "obs-turn-accepted",
    semanticKey: "obs-turn-accepted",
    kind: "turn.accepted",
    authority: "provider-structured",
    receivedAt: t0.toISOString(),
    fence,
    payload: {}
  }));
  return projection;
}

function classify(projection, now, semanticProgressAt = t0.toISOString()) {
  return classifyRuntimeHealth({ projection, semanticProgressAt, now });
}

test("the scheduler stall thresholds come from the shared runtime health policy", () => {
  assert.equal(DEFAULT_STALL_WINDOW_MS, SEMANTIC_STALL_WINDOW_MS);
  assert.equal(DEFAULT_WORKFLOW_STALL_CANDIDATE_AGE_MS, RUNTIME_DIAGNOSTIC_AFTER_MS);
  assert.equal(DEFAULT_RUNTIME_HEALTH_POLICY.quietAfterMs, RUNTIME_QUIET_AFTER_MS);
  assert.equal(DEFAULT_RUNTIME_HEALTH_POLICY.diagnosticAfterMs, RUNTIME_DIAGNOSTIC_AFTER_MS);
  assert.equal(DEFAULT_RUNTIME_HEALTH_POLICY.stallWindowMs, SEMANTIC_STALL_WINDOW_MS);
});

test("short silence stays healthy: 8 minutes quiet is not a failure (Case A)", () => {
  const projection = acceptedTurnProjection();
  const at8m = classify(projection, new Date(t0.getTime() + 8 * 60_000));
  assert.equal(at8m.layer, "quiet");
  assert.equal(at8m.runtimeIdleMs, 8 * 60_000);
  assert.equal(at8m.semanticIdleMs, 8 * 60_000);
});

test("the quiet boundary is exact: below 5 minutes active-quiet, at/above quiet", () => {
  const projection = acceptedTurnProjection();
  const before = classify(projection, new Date(t0.getTime() + RUNTIME_QUIET_AFTER_MS - 1));
  assert.equal(before.layer, "active-quiet");
  const at = classify(projection, new Date(t0.getTime() + RUNTIME_QUIET_AFTER_MS));
  assert.equal(at.layer, "quiet");
});

test("the diagnostic boundary is exact: below 10 minutes quiet, at/above diagnostic-needed", () => {
  const projection = acceptedTurnProjection();
  const before = classify(projection, new Date(t0.getTime() + RUNTIME_DIAGNOSTIC_AFTER_MS - 1));
  assert.equal(before.layer, "quiet");
  const at = classify(projection, new Date(t0.getTime() + RUNTIME_DIAGNOSTIC_AFTER_MS));
  assert.equal(at.layer, "diagnostic-needed");
});

test("a deterministic host exit is stopped immediately without waiting for any window (Case D)", () => {
  let projection = acceptedTurnProjection();
  projection = projectRuntimeObservation(projection, createRuntimeObservation({
    schemaVersion: 2,
    eventId: "obs-host-exited",
    semanticKey: "obs-host-exited",
    kind: "host.observed",
    authority: "host",
    receivedAt: new Date(t0.getTime() + 60_000).toISOString(),
    fence,
    payload: { alive: false }
  }));
  const at1m = classify(projection, new Date(t0.getTime() + 60_000));
  assert.equal(at1m.layer, "stopped");
});

test("an active subagent operation keeps the parent run subagent-active while quiet (Case E)", () => {
  let projection = acceptedTurnProjection();
  projection = projectRuntimeObservation(projection, createRuntimeObservation({
    schemaVersion: 2,
    eventId: "obs-subagent-started",
    semanticKey: "obs-subagent-started",
    kind: "operation.started",
    authority: "provider-structured",
    receivedAt: t0.toISOString(),
    fence,
    payload: { operationId: "op-1", operation: "subagent" }
  }));
  const at8m = classify(projection, new Date(t0.getTime() + 8 * 60_000));
  assert.equal(at8m.layer, "subagent-active");
  assert.deepEqual(at8m.activeOperations, ["subagent:op-1"]);
});

test("a degraded observer warrants a read-only diagnostic (Case C)", () => {
  let projection = acceptedTurnProjection();
  projection = projectRuntimeObservation(projection, createRuntimeObservation({
    schemaVersion: 2,
    eventId: "obs-observer-degraded",
    semanticKey: "obs-observer-degraded",
    kind: "observer.health",
    authority: "diagnostic",
    receivedAt: t0.toISOString(),
    fence,
    payload: { sourceId: "test-observer", observerStatus: "degraded" }
  }));
  const at2m = classify(projection, new Date(t0.getTime() + 2 * 60_000));
  assert.equal(at2m.layer, "diagnostic-needed");
  assert.equal(at2m.observerStatus, "degraded");
});

test("token/usage activity does not advance the semantic progress clock (Case B)", () => {
  let projection = acceptedTurnProjection();
  // Continuous token activity every minute for 20 minutes, but no durable
  // semantic checkpoint: the semantic clock must still reach diagnostic.
  for (let minute = 1; minute <= 20; minute += 1) {
    projection = projectRuntimeObservation(projection, createRuntimeObservation({
      schemaVersion: 2,
      eventId: `obs-activity-${minute}`,
      semanticKey: `obs-activity-${minute}`,
      kind: "activity.observed",
      authority: "provider-structured",
      receivedAt: new Date(t0.getTime() + minute * 60_000).toISOString(),
      fence,
      payload: {
        activity: "model",
        usage: { inputTokens: minute * 100, outputTokens: minute * 50 }
      }
    }));
  }
  const at20m = classify(projection, new Date(t0.getTime() + 20 * 60_000));
  assert.equal(at20m.layer, "diagnostic-needed");
  assert.equal(at20m.semanticIdleMs, 20 * 60_000);
  assert.equal(at20m.runtimeIdleMs, 0);
});

test("active-quiet copy does not imply failure", () => {
  const projection = acceptedTurnProjection();
  const at2m = classify(projection, new Date(t0.getTime() + 2 * 60_000));
  assert.equal(at2m.layer, "active-quiet");
  assert.doesNotMatch(at2m.reason, /fail|error|stall/i);
});
