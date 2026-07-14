import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptInputResolutionWakeupTransport,
  claimInputResolutionWakeup,
  completeAcceptedInputResolutionWakeup,
  createInputResolutionWakeup,
  isInputResolutionWakeup
} from "../dist/scheduler/inputResolutionWakeup.js";

const createdAt = new Date("2026-07-14T10:00:00.000Z");

function createWakeup() {
  return createInputResolutionWakeup({
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex",
    requestId: "input-1",
    resolutionId: "resolution-1",
    agentRunId: "leader-run-1",
    adapterId: "codex",
    sessionRoot: "/tmp",
    nativeSessionId: "leader-native-1"
  }, createdAt);
}

test("resolution wakeups preserve the exact Leader adapter, session root, and native session tuple", () => {
  const pending = createWakeup();
  assert.equal(isInputResolutionWakeup(pending, "task-1", "input-1"), true);

  const claimed = claimInputResolutionWakeup(pending, {
    controllerId: "controller-1",
    controllerGeneration: "generation-1",
    claimId: "claim-1",
    expiresAt: "2026-07-14T10:00:30.000Z"
  }, new Date("2026-07-14T10:00:01.000Z"));
  const accepted = acceptInputResolutionWakeupTransport(claimed, {
    controllerId: "controller-1",
    controllerGeneration: "generation-1",
    claimId: "claim-1"
  }, {
    deliveryId: claimed.deliveryId,
    transport: "tmux"
  }, new Date("2026-07-14T10:00:02.000Z"));
  const completed = completeAcceptedInputResolutionWakeup(
    accepted,
    new Date("2026-07-14T10:00:03.000Z")
  );

  assert.deepEqual(
    {
      roleName: completed.roleName,
      agentId: completed.agentId,
      adapterId: completed.adapterId,
      sessionRoot: completed.sessionRoot,
      nativeSessionId: completed.nativeSessionId,
      deliveryId: completed.deliveryId,
      receipt: completed.receipt.deliveryId,
      status: completed.status
    },
    {
      roleName: "leader",
      agentId: "codex",
      adapterId: "codex",
      sessionRoot: "/tmp",
      nativeSessionId: "leader-native-1",
      deliveryId: completed.deliveryId,
      receipt: completed.deliveryId,
      status: "completed"
    }
  );
});
