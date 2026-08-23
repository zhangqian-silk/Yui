import assert from "node:assert/strict";
import test from "node:test";

import {
  createCanonicalLifecycleEvent,
  foldCanonicalLifecycleEvent
} from "../../dist/lifecycle/canonicalLifecycleEvent.js";

const fence = {
  taskId: "task-1",
  roleName: "leader",
  agentId: "claude",
  adapterId: "claude",
  runId: "agent-run-1",
  nativeSessionId: "native-session-1",
  launchId: "launch-1",
  receiptId: "agent-run:task-1/agent-run-1"
};

function expectation(overrides = {}) {
  return {
    fence,
    sessionStarted: true,
    ready: true,
    pushed: false,
    accepted: false,
    terminal: false,
    boundNativeSessionId: fence.nativeSessionId,
    ...overrides
  };
}

test("exact provider acceptance before transport persistence is deferred and replayable", () => {
  const accepted = createCanonicalLifecycleEvent({
    phase: "provider-accepted",
    source: "provider-native",
    evidence: "provider-native-durable",
    fence
  });

  assert.deepEqual(foldCanonicalLifecycleEvent(accepted, expectation()), {
    outcome: "deferred",
    reason: "accept-before-push"
  });
  assert.deepEqual(foldCanonicalLifecycleEvent(accepted, expectation({ pushed: true })), {
    outcome: "advance-accepted"
  });
});
