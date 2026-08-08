import assert from "node:assert/strict";
import test from "node:test";

import {
  createRoleRunStallSampler,
  reconcileStalledRoleRuns
} from "../../dist/scheduler/roleRunStall.js";
import { projectTaskExecution } from "../../dist/scheduler/taskExecutionProjection.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const EFFECTIVE = {
  schemaVersion: 2,
  sourceDesiredRevision: 1,
  agentId: "agent-1",
  adapterId: "codex",
  model: "gpt-5.6-sol",
  effort: "max",
  profileAccess: "read",
  search: false,
  permission: { strategy: "configured", sandbox: "read-only", approval: "never" },
  writeProjectIds: [],
  workspace: { root: "/tmp/task-14", entries: [] },
  context: {}
};

function task(status = "active") {
  return {
    schemaVersion: 3,
    id: "task-1",
    title: "Task-first",
    projectBindings: [],
    status,
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: NOW.toISOString()
  };
}

function run(roleName, overrides = {}) {
  return {
    schemaVersion: 5,
    id: `${roleName}-run-1`,
    taskId: "task-1",
    roleName,
    mode: "new",
    purpose: roleName === "reviewer" ? "review" : "execution",
    input: "advance",
    effective: EFFECTIVE,
    status: "active",
    createdAt: "2026-08-09T11:00:00.000Z",
    updatedAt: "2026-08-09T11:00:00.000Z",
    deliveredAt: "2026-08-09T11:00:00.000Z",
    ...overrides
  };
}

function role(name) {
  return {
    name,
    activeAgentId: "agent-1",
    adapterId: "codex",
    status: "running"
  };
}

function projection(overrides = {}) {
  return projectTaskExecution({
    task: task(),
    roles: [],
    runs: [],
    ...overrides
  });
}

test("an active Task with no executor is immediately actionable by the Leader", () => {
  const result = projection();
  assert.equal(result.status, "needs-leader-action");
  assert.equal(result.owner, "leader");
  assert.equal(result.action, "advance-task");
  assert.equal(result.reason, "no-executor");
  assert.equal(result.monitoring, "active");
});

test("active delegated execution is legal waiting-on-agents, not a Leader stall", () => {
  const result = projection({
    roles: [role("worker")],
    runs: [run("worker")]
  });
  assert.equal(result.status, "waiting-on-agents");
  assert.equal(result.owner, "worker");
  assert.equal(result.action, "wait-for-agents");
  assert.deepEqual(result.attention, []);
});

test("a Leader and multiple workers remain one waiting projection while workers progress", () => {
  const result = projection({
    roles: [role("leader"), role("worker"), role("reviewer")],
    runs: [run("leader"), run("worker"), run("reviewer")]
  });
  assert.equal(result.status, "waiting-on-agents");
  assert.equal(result.owner, "leader");
  assert.equal(result.activeExecutorCount, 3);
});

test("open user input remains explicit waiting-user state", () => {
  const result = projection({
    roles: [role("leader")],
    runs: [run("leader")],
    inputRequests: [{
      id: "input-1",
      status: "open",
      question: "Choose a port",
      requester: {
        runId: "leader-run-1",
        roleName: "leader",
        agentId: "agent-1"
      }
    }]
  });
  assert.equal(result.status, "waiting-user");
  assert.equal(result.owner, "user");
  assert.equal(result.action, "answer-input");
});

test("an unaccepted Run remains explicit recovering state instead of provider acceptance", () => {
  const result = projection({
    roles: [role("worker")],
    runs: [run("worker", { deliveredAt: undefined })]
  });
  assert.equal(result.status, "recovering");
  assert.equal(result.reason, "delivery-pending");
  assert.equal(result.action, "recover-leader");
});

test("a recovery wake is visible without inventing a second state machine", () => {
  const result = projection({
    pendingWakeup: { reasons: ["task-orphaned"] }
  });
  assert.equal(result.status, "recovering");
  assert.equal(result.action, "recover-leader");
});

test("a Worker stall is Leader-owned checkpoint attention, while a Leader stall is Operator-owned", () => {
  const workerEvent = {
    type: "run.stalled",
    createdAt: NOW.toISOString(),
    payload: { runId: "worker-run-1", roleName: "worker" }
  };
  const worker = projection({
    roles: [role("worker")],
    runs: [run("worker")],
    events: [workerEvent]
  });
  assert.equal(worker.status, "attention");
  assert.equal(worker.owner, "leader");
  assert.equal(worker.attention[0].kind, "checkpoint-overdue");

  const leaderNotice = {
    type: "leader-stalled",
    runId: "leader-run-1",
    progressAt: "2026-08-09T11:00:00.000Z",
    message: "Leader has no progress",
    updatedAt: NOW.toISOString()
  };
  const leader = projection({
    roles: [role("leader")],
    runs: [run("leader")],
    operatorNotification: leaderNotice
  });
  assert.equal(leader.status, "attention");
  assert.equal(leader.owner, "operator");
  assert.equal(leader.attention[0].kind, "leader-stalled");
});

test("provider/session identity mismatch fails closed", () => {
  const result = projection({
    roles: [{ ...role("worker"), activeAgentId: "different-agent" }],
    runs: [run("worker")]
  });
  assert.equal(result.status, "attention");
  assert.equal(result.failClosed, true);
  assert.equal(result.attention[0].kind, "identity-mismatch");
});

test("completed Tasks stop monitoring without archiving or mutation", () => {
  const result = projectTaskExecution({
    task: task("completed"),
    roles: [role("leader")],
    runs: [run("leader")]
  });
  assert.equal(result.status, "completed");
  assert.equal(result.monitoring, "stopped");
  assert.equal(result.action, "none");
});

test("candidate and integration facts route to Leader action", () => {
  const candidate = projection({
    workItems: [{ id: "work-1", status: "awaiting_acceptance" }]
  });
  assert.equal(candidate.status, "needs-leader-action");
  assert.equal(candidate.reason, "candidate-ready");

  const integration = projection({
    integrations: [{ id: "integration-1", status: "blocked", conflict: { summary: "conflict" } }]
  });
  assert.equal(integration.status, "blocked");
  assert.equal(integration.reason, "integration-blocked");
});

function stallFixture() {
  const currentRun = run("worker");
  const events = [];
  const store = {
    listTasks() { return [task()]; },
    listRoles() { return [role("worker")]; },
    getActiveAgentRun() { return currentRun; },
    getRoleSession() { return { agentId: "agent-1", adapterId: "codex", nativeSessionId: "native-1" }; },
    listEvents() { return events; },
    recordRoleRunStall(input) {
      if (events.some((event) => event.type === "run.stalled")) return "already-raised";
      events.push({
        type: "run.stalled",
        createdAt: input.now.toISOString(),
        payload: { runId: input.runId, progressAt: input.progressAt }
      });
      return "raised";
    },
    getWorkMailbox() { return { pending: null, processing: null }; }
  };
  return { store, events };
}

function activitySnapshot(overrides = {}) {
  return {
    status: "present",
    agentId: "agent-1",
    adapterId: "codex",
    nativeSessionId: "native-1",
    ...overrides
  };
}

test("three exact no-activity samples raise one internal stall without delivery retry", async () => {
  const { store, events } = stallFixture();
  const sampler = createRoleRunStallSampler();
  const delivery = {
    async inspectRole() { return "present"; },
    async inspectRoleActivity() { return activitySnapshot(); }
  };
  assert.deepEqual(await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000, undefined, sampler), []);
  assert.deepEqual(await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000, undefined, sampler), []);
  const raised = await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000, undefined, sampler);
  assert.equal(raised.length, 1);
  assert.equal(raised[0].status, "raised");
  assert.deepEqual(
    await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000, undefined, sampler),
    []
  );
  assert.equal(events.filter((event) => event.type === "run.stalled").length, 1);
});

test("semantic/provider/resource activity cancels the candidate window", async () => {
  const { store, events } = stallFixture();
  const sampler = createRoleRunStallSampler();
  let sample = activitySnapshot();
  const delivery = {
    async inspectRole() { return "present"; },
    async inspectRoleActivity() { return sample; }
  };
  await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000, undefined, sampler);
  sample = activitySnapshot({ cpuTimeMs: 1 });
  await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000, undefined, sampler);
  sample = activitySnapshot({ semanticActivity: true });
  await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000, undefined, sampler);
  sample = activitySnapshot({ ioWriteBytes: 1 });
  await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000, undefined, sampler);
  assert.equal(events.length, 0);
});

test("projection is read-only and duplicate derivation is stable", () => {
  const facts = Object.freeze({ task: Object.freeze(task()), roles: [], runs: [] });
  const first = projectTaskExecution(facts);
  const second = projectTaskExecution(facts);
  assert.deepEqual(second, first);
});
