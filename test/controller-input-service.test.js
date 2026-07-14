import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent, configuredAgentToDefinition } from "../dist/agent/agent.js";
import { ControllerInputService } from "../dist/input/controllerInputService.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../dist/executor/agentExecutor.js";
import {
  createRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../dist/role/role.js";
import { createAgentRun } from "../dist/run/agentRun.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createTask } from "../dist/task/task.js";

const seedNow = new Date("2026-07-14T08:00:00.000Z");

function createHome(t) {
  const home = mkdtempSync(join(tmpdir(), "taskmux-controller-input-"));
  ensureStorageSchema(home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function requester() {
  return {
    roleName: "leader",
    agentId: "codex",
    adapterId: "codex",
    sessionRoot: "/tmp",
    nativeSessionId: "leader-native-1",
    agentRunId: "leader-run-1"
  };
}

function seedLeader(home) {
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], seedNow);
  const binding = createRoleAgentBinding(configuredAgentToDefinition(agent));
  const role = updateRoleStatus(createRole(
    "task-1",
    "leader",
    [binding],
    "codex",
    "/workspace/task-1",
    seedNow
  ), "running", seedNow);
  const run = createAgentRun(
    "leader-run-1",
    "task-1",
    "leader",
    "resume",
    "Continue leadership",
    seedNow
  );
  const sessionSet = recordRoleAgentSession(
    createRoleSessionSet(
      { scope: "task", taskId: "task-1", roleName: "leader" },
      "codex",
      seedNow
    ),
    {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "leader-native-1",
      policy: "fixed",
      status: "running",
      sessionRoot: "/tmp",
      configFingerprint: {
        overall: "a".repeat(64),
        replayable: "a".repeat(64),
        permission: "a".repeat(64),
        sessionBound: "a".repeat(64)
      },
      permissionEnvelope: { adapterId: "codex" }
    },
    seedNow
  );
  store.saveTask(createTask("task-1", "Task one", seedNow));
  store.saveRole("task-1", role);
  store.saveRoleSessionSet(sessionSet);
  store.saveAgentRun(run);
  store.saveActiveAgentRun(run);
}

function ids() {
  return {
    nextRequestId: () => "input-1",
    nextResolutionId: () => "resolution-1",
    nextDeliveryId: () => "delivery-1"
  };
}

test("Controller atomically creates a task-owned request, blocks its exact Leader run, and emits one pointer delivery", (t) => {
  const home = createHome(t);
  seedLeader(home);
  const service = new ControllerInputService(home, ids());

  const request = service.create("input-create-1", {
    taskId: "task-1",
    requester: requester(),
    input: {
      question: "Which deployment path?",
      choices: [{ key: "safe", label: "Safe path" }],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    }
  }, new Date("2026-07-14T08:00:01.000Z"));

  const store = new FileTaskStore(home);
  assert.equal(request.id, "input-1");
  assert.equal(store.getInputRequest("task-1", "input-1").status, "open");
  assert.equal(store.getActiveAgentRun("task-1", "leader").status, "blocked");
  assert.deepEqual(store.listOperatorDeliveries().map((delivery) => ({
    taskId: delivery.taskId,
    requestId: delivery.requestId,
    status: delivery.status
  })), [{ taskId: "task-1", requestId: "input-1", status: "pending" }]);
});

test("Controller resolution terminalizes request, revokes unaccepted transport work, and wakes only the exact blocked Leader", (t) => {
  const home = createHome(t);
  seedLeader(home);
  const service = new ControllerInputService(home, ids());
  service.create("input-create-1", {
    taskId: "task-1",
    requester: requester(),
    input: {
      question: "Which deployment path?",
      choices: [{ key: "safe", label: "Safe path" }],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    }
  }, new Date("2026-07-14T08:00:01.000Z"));

  const result = service.resolve("input-resolve-1", {
    requestId: "input-1",
    answer: { choiceKey: "safe", text: "ignored" },
    operatorPresence: "online"
  }, new Date("2026-07-14T08:00:02.000Z"));

  const store = new FileTaskStore(home);
  assert.equal(result.request.status, "answered");
  assert.equal(store.getInputResolution("task-1", "resolution-1").source, "user");
  assert.equal(store.listOperatorDeliveries()[0].status, "revoked");
  const wakeup = store.getInputResolutionWakeup("task-1", "input-1");
  assert.deepEqual({
    ...wakeup,
    deliveryId: undefined
  }, {
    schemaVersion: 1,
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex",
    requestId: "input-1",
    resolutionId: "resolution-1",
    agentRunId: "leader-run-1",
    adapterId: "codex",
    sessionRoot: "/tmp",
    nativeSessionId: "leader-native-1",
    deliveryId: undefined,
    status: "pending",
    createdAt: "2026-07-14T08:00:02.000Z",
    updatedAt: "2026-07-14T08:00:02.000Z"
  });
  assert.match(wakeup.deliveryId, /^input-resolution-[a-f0-9]{64}$/);
});

test("Controller cancellation is atomic and cannot be called by another Leader origin", (t) => {
  const home = createHome(t);
  seedLeader(home);
  const service = new ControllerInputService(home, ids());
  service.create("input-create-1", {
    taskId: "task-1",
    requester: requester(),
    input: {
      question: "Which deployment path?",
      choices: [],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    }
  }, new Date("2026-07-14T08:00:01.000Z"));

  assert.throws(() => service.cancel("input-cancel-stale", {
    taskId: "task-1",
    requestId: "input-1",
    requester: { ...requester(), nativeSessionId: "wrong-session" },
    reason: "No longer relevant"
  }, new Date("2026-07-14T08:00:02.000Z")), /origin/i);

  const cancelled = service.cancel("input-cancel-1", {
    taskId: "task-1",
    requestId: "input-1",
    requester: requester(),
    reason: "No longer relevant"
  }, new Date("2026-07-14T08:00:02.000Z"));

  const store = new FileTaskStore(home);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(store.listOperatorDeliveries()[0].status, "revoked");
  assert.equal(store.getInputResolutionWakeup("task-1", "input-1"), null);
});
