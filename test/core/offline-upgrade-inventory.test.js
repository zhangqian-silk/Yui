import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyOfflineUpgradeFacts
} from "../../dist/storage/upgrade/offlineUpgradeInventory.js";

test("offline inventory blocks only active/in-flight/native-live/pending lifecycle facts", () => {
  const result = classifyOfflineUpgradeFacts({
    runs: [
      { taskId: "task-1", roleName: "leader", runId: "agent-run-1", status: "active" },
      { taskId: "task-2", roleName: "worker", runId: "agent-run-2", status: "yielded" }
    ],
    sessions: [
      {
        taskId: "task-3", roleName: "reviewer", nativeSessionId: "native-live",
        launchId: "launch-1", status: "running", processState: "live", history: false
      },
      {
        taskId: "task-4", roleName: "worker", nativeSessionId: "native-stopped",
        status: "stopped", processState: "stopped", history: true
      },
      {
        taskId: "task-5", roleName: "worker", nativeSessionId: "native-idle",
        status: "ready", processState: "stopped", history: false
      },
      {
        taskId: "task-6", roleName: "worker", nativeSessionId: "native-unknown",
        status: "running", processState: "unknown", history: false
      }
    ],
    inFlight: [
      { taskId: "task-7", roleName: "worker", runId: "agent-run-7", nativeSessionId: "native-7" }
    ],
    pendingCompletions: [
      { taskId: "task-8", roleName: "worker", runId: "agent-run-8", nativeSessionId: "native-8" }
    ],
    lifecycle: [
      { taskId: "task-9", roleName: "worker", reason: "pending-mailbox" },
      { reason: "pending-inbox" }
    ]
  });

  assert.equal(result.total, 7);
  assert.deepEqual(result.blockers.map(({ reason }) => reason), [
    "active-run",
    "native-session-live",
    "native-session-unknown",
    "in-flight-run",
    "pending-completion",
    "pending-mailbox",
    "pending-inbox"
  ]);
  assert.equal(result.blockers[0].taskId, "task-1");
  assert.equal(result.blockers[1].nativeSessionId, "native-live");
});

test("stopped/history and an idle Role without a native process do not block", () => {
  const result = classifyOfflineUpgradeFacts({
    runs: [
      { taskId: "task-1", roleName: "leader", runId: "agent-run-1", status: "yielded" },
      { taskId: "task-2", roleName: "worker", runId: "agent-run-2", status: "failed" }
    ],
    sessions: [
      {
        taskId: "task-1", roleName: "leader", nativeSessionId: "native-1",
        status: "stopped", processState: "stopped", history: false
      },
      {
        taskId: "task-2", roleName: "worker", nativeSessionId: "native-2",
        status: "running", processState: "stopped", history: false
      },
      {
        taskId: "task-3", roleName: "reviewer", nativeSessionId: "native-3",
        status: "broken", processState: "stopped", history: true
      }
    ],
    inFlight: [],
    pendingCompletions: [],
    lifecycle: []
  });
  assert.deepEqual(result, { total: 0, blockers: [] });
});

test("an undeterminable process or pane inventory fails closed as an unknown native Session", () => {
  const result = classifyOfflineUpgradeFacts({
    runs: [],
    sessions: [],
    inFlight: [],
    pendingCompletions: [],
    lifecycle: [],
    unknownRuntime: [
      { taskId: "task-4", roleName: "worker", nativeSessionId: "native-unknown" }
    ]
  });
  assert.deepEqual(result, {
    total: 1,
    blockers: [{
      taskId: "task-4",
      roleName: "worker",
      nativeSessionId: "native-unknown",
      reason: "native-session-unknown"
    }]
  });
});
