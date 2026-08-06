import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateRoleRunStall,
  isRoleRunStalled,
  latestDurableProgressAt,
  latestRunProgressAt,
  projectRoleRunHealth,
  reconcileStalledRoleRuns
} from "../../dist/scheduler/roleRunStall.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { mergePendingWakeup } from "../../dist/scheduler/pendingWakeup.js";

const PROGRESS = "2026-08-05T00:00:00.000Z";
const NOW = new Date("2026-08-05T01:00:00.000Z");

test("stall evaluation treats checkpoints as progress but ignores bookkeeping timestamps", () => {
  assert.equal(
    latestDurableProgressAt({
      deliveredAt: PROGRESS,
      runUpdatedAt: PROGRESS,
      sessionUpdatedAt: "2026-08-05T00:50:00.000Z",
      latestCheckpointAt: "2026-08-05T00:20:00.000Z"
    }),
    "2026-08-05T00:20:00.000Z"
  );
  assert.deepEqual(
    evaluateRoleRunStall({
      progressAt: "2026-08-05T00:20:00.000Z",
      now: NOW,
      windowMs: 45 * 60_000
    }),
    {
      stalled: false,
      isNewEpisode: false,
      idleMs: 40 * 60_000,
      progressAt: "2026-08-05T00:20:00.000Z"
    }
  );
  assert.equal(
    evaluateRoleRunStall({
      progressAt: PROGRESS,
      now: NOW,
      windowMs: 30 * 60_000
    }).isNewEpisode,
    true
  );
});

test("late stale progress events cannot move the durable progress fence backwards", () => {
  const events = [
    createTaskEvent(
      "event-1",
      "task-1",
      "run.progress",
      { runId: "run-1", progressAt: "2026-08-05T00:30:00.000Z" },
      new Date("2026-08-05T00:30:00.000Z")
    ),
    createTaskEvent(
      "event-2",
      "task-1",
      "run.progress",
      { runId: "run-1", progressAt: "2026-08-05T00:10:00.000Z" },
      new Date("2026-08-05T00:40:00.000Z")
    )
  ];
  assert.equal(
    latestRunProgressAt(events, "run-1"),
    "2026-08-05T00:30:00.000Z"
  );
});

test("one health projection keeps live resource activity advisory and does not advance the clock", () => {
  const projection = projectRoleRunHealth({
    progressAt: PROGRESS,
    createdAt: PROGRESS,
    deliveredAt: PROGRESS,
    now: NOW,
    hostLiveness: "present",
    nativeSession: {
      status: "running",
      nativeSessionId: "native-1"
    },
    providerAcceptance: "accepted",
    resource: {
      observedAt: "2026-08-05T00:59:30.000Z",
      active: true,
      changed: true,
      cpuTimeMs: 10,
      rssBytes: 1024
    },
    roleName: "worker"
  });

  assert.equal(projection.candidate, true);
  assert.equal(projection.resourceActivity, true);
  assert.equal(projection.stalled, false);
  assert.equal(projection.progressAt, PROGRESS);
  assert.equal(projection.idleMs, 60 * 60_000);
});

test("resource activity cannot make an unknown host or native Session healthy", () => {
  const projection = projectRoleRunHealth({
    progressAt: PROGRESS,
    createdAt: PROGRESS,
    deliveredAt: PROGRESS,
    now: NOW,
    hostLiveness: "unknown",
    nativeSession: null,
    providerAcceptance: "accepted",
    resource: {
      observedAt: "2026-08-05T00:59:30.000Z",
      active: true,
      changed: true
    },
    roleName: "worker"
  });

  assert.equal(projection.resourceActivity, false);
  assert.equal(projection.stalled, false);
  assert.equal(projection.nativeSession, "missing");
});

test("an opaque SessionHost binding still routes a stalled accepted Run", async () => {
  const store = stallStore({ session: null });
  let inspected;
  const result = await reconcileStalledRoleRuns(
    store,
    {
      async inspectRole(input) {
        inspected = input;
        return "present";
      }
    },
    NOW,
    undefined,
    30 * 60_000
  );

  assert.equal(result[0]?.kind, "execution-stalled");
  assert.equal(store.events.filter((event) => event.type === "run.stalled").length, 1);
  assert.equal("nativeSessionId" in inspected, false);
});

test("stopped, broken, and identity-mismatched Sessions remain fail-closed", async () => {
  for (const session of [
    {
      agentId: "agent-1",
      adapterId: "codex",
      nativeSessionId: "native-1",
      status: "stopped"
    },
    {
      agentId: "agent-1",
      adapterId: "codex",
      nativeSessionId: "native-1",
      status: "broken"
    },
    {
      agentId: "other-agent",
      adapterId: "codex",
      nativeSessionId: "native-1",
      status: "running"
    }
  ]) {
    const store = stallStore({ session });
    const result = await reconcileStalledRoleRuns(
      store,
      { async inspectRole() { return "present"; } },
      NOW,
      undefined,
      30 * 60_000
    );
    assert.deepEqual(result, [], `unexpected stall for ${session.status}`);
    assert.equal(store.events.filter((event) => event.type === "run.stalled").length, 0);
  }
});

test("an accepted live Run younger than ten minutes is not a stall candidate", async () => {
  const deliveredAt = new Date(NOW.getTime() - 5 * 60_000).toISOString();
  const store = stallStore({ createdAt: deliveredAt, deliveredAt });
  let inspections = 0;
  const result = await reconcileStalledRoleRuns(
    store,
    { async inspectRole() { inspections += 1; return "present"; } },
    NOW,
    undefined,
    30 * 60_000
  );
  assert.deepEqual(result, []);
  assert.equal(inspections, 0);
  assert.equal(store.events.length, 0);
});

test("an accepted Run past the candidate filter with recent progress is not stalled", async () => {
  const deliveredAt = new Date(NOW.getTime() - 20 * 60_000).toISOString();
  const store = stallStore({ createdAt: deliveredAt, deliveredAt });
  store.events.push(createTaskEvent(
    "event-1",
    "task-1",
    "run.progress",
    { runId: "run-1", note: "tool output persisted" },
    new Date(NOW.getTime() - 60_000)
  ));
  let inspections = 0;
  const result = await reconcileStalledRoleRuns(
    store,
    { async inspectRole() { inspections += 1; return "present"; } },
    NOW,
    undefined,
    30 * 60_000
  );
  assert.deepEqual(result, []);
  assert.equal(inspections, 1);
  assert.equal(store.events.filter((event) => event.type === "run.stalled").length, 0);
});

test("one scheduler resource sample suppresses an execution false positive without clearing attention", async () => {
  const store = stallStore();
  const resourceEvidence = new Map([
    ["task-1\0worker\0run-1", {
      observedAt: "2026-08-05T00:59:30.000Z",
      active: true,
      changed: true,
      cpuTimeMs: 20,
      rssBytes: 4096
    }]
  ]);
  const result = await reconcileStalledRoleRuns(
    store,
    { async inspectRole() { return "present"; } },
    NOW,
    undefined,
    30 * 60_000,
    undefined,
    resourceEvidence
  );
  assert.deepEqual(result, []);
  assert.equal(store.events.filter((event) => event.type === "run.stalled").length, 0);
});

test("a live accepted Run raises one idempotent needs-attention event without a Task Message", async () => {
  const store = stallStore();
  const delivery = { async inspectRole() { return "present"; } };

  const first = await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000);
  assert.deepEqual(first.map(({ status, runId }) => ({ status, runId })), [
    { status: "raised", runId: "run-1" }
  ]);
  assert.equal(store.events.filter((event) => event.type === "run.stalled").length, 1);
  assert.deepEqual(store.pending.reasons, ["existing-work", "role-run-stalled"]);
  assert.equal(store.pending.requestCount, 2);
  assert.deepEqual(store.messages, []);

  const second = await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000);
  assert.deepEqual(second, []);
  assert.equal(store.events.filter((event) => event.type === "run.stalled").length, 1);
  assert.equal(store.pending.requestCount, 2);

  // A real checkpoint proves recovery and clears the projection without any
  // automatic retry or terminal Run mutation.
  store.events.push(createTaskEvent(
    "event-2",
    "task-1",
    "run.progress",
    { runId: "run-1", note: "tool output persisted" },
    new Date("2026-08-05T01:05:00.000Z")
  ));
  assert.equal(isRoleRunStalled(store.events, "run-1"), false);
  assert.equal(store.runs[0].status, "active");
});

test("a live unaccepted Run is delivery-stalled without retrying or mutating its fence", async () => {
  const store = stallStore({ delivered: false });
  const before = JSON.stringify(store.runs[0]);
  const result = await reconcileStalledRoleRuns(
    store,
    { async inspectRole() { return "present"; } },
    NOW,
    undefined,
    30 * 60_000
  );
  assert.equal(result[0].kind, "delivery-stalled");
  assert.equal(store.runs[0].deliveredAt, undefined);
  assert.equal(JSON.stringify(store.runs[0]), before);
  assert.deepEqual(store.pending.reasons, ["existing-work", "role-run-stalled"]);
  assert.deepEqual(store.messages, []);
});

test("an unaccepted Run keeps its delivery clock at creation despite newer related records", async () => {
  const store = stallStore({ delivered: false });
  store.getRunDurableProgress = () => ({
    progressAt: "2026-08-05T00:55:00.000Z",
    evidence: "work-review-integration"
  });

  const result = await reconcileStalledRoleRuns(
    store,
    { async inspectRole() { return "present"; } },
    NOW,
    undefined,
    30 * 60_000
  );

  assert.equal(result[0].kind, "delivery-stalled");
  const stalled = store.events.find((event) => event.type === "run.stalled");
  assert.equal(stalled.payload.progressAt, PROGRESS);
  assert.equal(result[0].idleMs, 60 * 60_000);
});

test("the same Run + progress point stays one episode while a missing pane is left to fenced liveness", async () => {
  const store = stallStore();
  const live = { async inspectRole() { return "present"; } };
  await reconcileStalledRoleRuns(store, live, NOW, undefined, 30 * 60_000);
  store.roles[0].status = "detached";
  await reconcileStalledRoleRuns(store, live, NOW, undefined, 30 * 60_000);
  assert.equal(store.events.filter((event) => event.type === "run.stalled").length, 1);

  const absentStore = stallStore();
  await reconcileStalledRoleRuns(absentStore, { async inspectRole() { return "absent"; } }, NOW, undefined, 30 * 60_000);
  assert.equal(absentStore.events.length, 0);
  assert.deepEqual(absentStore.pending.reasons, ["existing-work"]);
});

test("Leader stall scan leaves waiting-user and healthy waiting-on-workers Runs alone", async () => {
  const waitingUser = stallStore({ roleName: "leader", openInput: true });
  const healthyWorker = stallStore({ roleName: "leader", downstream: true });
  const delivery = { async inspectRole() { return "present"; } };
  assert.deepEqual(
    await reconcileStalledRoleRuns(waitingUser, delivery, NOW, undefined, 30 * 60_000),
    []
  );
  assert.deepEqual(
    await reconcileStalledRoleRuns(healthyWorker, delivery, NOW, undefined, 30 * 60_000),
    []
  );
  assert.equal(waitingUser.events.length, 0);
  assert.equal(healthyWorker.events.length, 0);
});

function stallStore(options = {}) {
  const task = { id: "task-1", title: "stall", status: "active", projectBindings: [] };
  const role = {
    taskId: task.id,
    name: options.roleName ?? "worker",
    activeAgentId: "agent-1",
    adapterId: "codex",
    workspace: "/tmp/work",
    status: "running"
  };
  const createdAt = options.createdAt ?? PROGRESS;
  const deliveredAt = options.deliveredAt
    ?? (options.delivered === false ? undefined : PROGRESS);
  const run = {
    schemaVersion: 3,
    id: "run-1",
    taskId: task.id,
    roleName: role.name,
    mode: "new",
    input: "work",
    purpose: "execution",
    status: "active",
    effective: {
      agentId: role.activeAgentId,
      adapterId: role.adapterId
    },
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
    createdAt,
    updatedAt: createdAt,
    workItemId: "work-1"
  };
  const session = options.session === null
    ? null
    : options.session ?? {
        agentId: role.activeAgentId,
        adapterId: role.adapterId,
        nativeSessionId: "native-1",
        status: "running",
        updatedAt: PROGRESS
      };
  const downstreamRole = {
    ...role,
    name: "worker",
    activeAgentId: "agent-worker",
    workspace: "/tmp/worker"
  };
  const downstreamRun = {
    ...run,
    id: "run-worker",
    roleName: "worker",
    deliveredAt: "2026-08-05T00:40:00.000Z",
    createdAt: "2026-08-05T00:40:00.000Z",
    updatedAt: "2026-08-05T00:40:00.000Z",
    effective: {
      agentId: downstreamRole.activeAgentId,
      adapterId: downstreamRole.adapterId
    }
  };
  const store = {
    tasks: [task],
    roles: options.downstream ? [role, downstreamRole] : [role],
    runs: options.downstream ? [run, downstreamRun] : [run],
    session,
    events: [],
    messages: [],
    pending: mergePendingWakeup(task.id, "existing-work", new Date(PROGRESS), null),
    listTasks() { return this.tasks; },
    getTask(id) { return this.tasks.find((candidate) => candidate.id === id) ?? null; },
    listRoles() { return this.roles; },
    getRole(_taskId, name) { return this.roles.find((candidate) => candidate.name === name) ?? null; },
    getActiveAgentRun(_taskId, name) {
      return this.runs.find((candidate) => candidate.roleName === name) ?? null;
    },
    getRoleSession(_taskId, name) {
      if (name === "worker" && options.downstream && this.session !== null) {
        return { ...this.session, agentId: "agent-worker" };
      }
      return this.session;
    },
    hasOpenInputRequest() { return options.openInput === true; },
    getWorkMailbox() { return { pending: null }; },
    listEvents() { return this.events; },
    recordRoleRunStall(input) {
      const existing = this.events.find((event) => (
        event.type === "run.stalled"
        && event.payload.runId === input.runId
        && event.payload.progressAt === input.progressAt
        && event.payload.evidenceKey === input.evidenceKey
      ));
      if (existing !== undefined) return "already-raised";
      this.events.push(createTaskEvent(
        `event-${this.events.length + 1}`,
        this.tasks[0].id,
        "run.stalled",
        {
          runId: input.runId,
          progressAt: input.progressAt,
          evidenceKey: input.evidenceKey
        },
        input.now
      ));
      this.pending = mergePendingWakeup(this.tasks[0].id, "role-run-stalled", input.now, this.pending);
      return "raised";
    }
  };
  return store;
}
