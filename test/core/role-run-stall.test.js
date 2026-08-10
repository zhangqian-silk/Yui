import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateRoleRunStall,
  isRoleRunStalled,
  latestDurableProgressAt,
  latestRunActivityAt,
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

test("provider-native turn progress advances the exact Run progress fence", async () => {
  const progressAt = "2026-08-05T00:55:00.000Z";
  const store = stallStore();
  store.events.push(createTaskEvent(
    "event-3",
    "task-1",
    "runtime.provider-turn-progress",
    {
      runId: "run-1",
      roleName: "worker",
      agentId: "agent-1",
      adapterId: "codex",
      nativeSessionId: "native-1",
      launchId: "launch-1",
      progressId: "tool-1",
      progressAt
    },
    new Date(progressAt)
  ));

  assert.equal(latestRunProgressAt(store.events, "run-1"), progressAt);
  assert.deepEqual(
    await reconcileStalledRoleRuns(
      store,
      { async inspectRole() { return "present"; } },
      NOW,
      undefined,
      30 * 60_000
    ),
    []
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

test("RSS-only residency does not suppress a stale accepted Run", () => {
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
      changed: false,
      cpuTimeMs: 99,
      rssBytes: 1024 * 1024
    },
    roleName: "worker"
  });

  assert.equal(projection.resourceActivity, false);
  assert.equal(projection.stalled, true);
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
      progressAt: PROGRESS,
      identity: {
        taskId: "task-1",
        roleName: "worker",
        runId: "run-1",
        agentId: "agent-1",
        adapterId: "codex",
        nativeSessionId: "native-1"
      },
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

test("continued resource activity is bounded by the semantic progress gap", async () => {
  const store = stallStore();
  let recorded = false;
  store.recordRoleRunResourceSuppression = () => {
    if (recorded) return "already-recorded";
    recorded = true;
    return "recorded";
  };
  const evidenceAt = (now) => new Map([[
    "task-1\0worker\0run-1",
    {
      observedAt: new Date(now.getTime() - 30_000).toISOString(),
      progressAt: PROGRESS,
      identity: {
        taskId: "task-1",
        roleName: "worker",
        runId: "run-1",
        agentId: "agent-1",
        adapterId: "codex",
        nativeSessionId: "native-1"
      },
      active: true,
      changed: true,
      cpuTimeMs: now.getTime()
    }
  ]]);
  const delivery = { async inspectRole() { return "present"; } };

  assert.deepEqual(await reconcileStalledRoleRuns(
    store,
    delivery,
    NOW,
    undefined,
    30 * 60_000,
    undefined,
    evidenceAt(NOW)
  ), []);
  const stillBounded = new Date("2026-08-05T01:20:00.000Z");
  assert.deepEqual(await reconcileStalledRoleRuns(
    store,
    delivery,
    stillBounded,
    undefined,
    30 * 60_000,
    undefined,
    evidenceAt(stillBounded)
  ), []);

  const expired = new Date("2026-08-05T01:30:00.000Z");
  const result = await reconcileStalledRoleRuns(
    store,
    delivery,
    expired,
    undefined,
    30 * 60_000,
    undefined,
    evidenceAt(expired)
  );
  assert.equal(result[0]?.runId, "run-1");
  assert.equal(store.events.filter((event) => event.type === "run.stalled").length, 1);
});

test("launch identity can fence advisory resource activity when native Session id is opaque", async () => {
  const store = stallStore({
    session: {
      agentId: "agent-1",
      adapterId: "codex",
      launchId: "launch-1",
      status: "running"
    }
  });
  const result = await reconcileStalledRoleRuns(
    store,
    { async inspectRole() { return "present"; } },
    NOW,
    undefined,
    30 * 60_000,
    undefined,
    new Map([[
      "task-1\0worker\0run-1",
      {
        observedAt: "2026-08-05T00:59:30.000Z",
        progressAt: PROGRESS,
        identity: {
          taskId: "task-1",
          roleName: "worker",
          runId: "run-1",
          agentId: "agent-1",
          adapterId: "codex",
          launchId: "launch-1"
        },
        active: true,
        changed: true
      }
    ]])
  );
  assert.deepEqual(result, []);
  assert.equal(store.events.filter((event) => event.type === "run.stalled").length, 0);
});

test("a concurrent suppression CAS change cannot leave a stale changed sample healthy", async () => {
  const store = stallStore();
  store.recordRoleRunResourceSuppression = () => "state-changed";
  const result = await reconcileStalledRoleRuns(
    store,
    { async inspectRole() { return "present"; } },
    NOW,
    undefined,
    30 * 60_000,
    undefined,
    new Map([[
      "task-1\0worker\0run-1",
      {
        observedAt: "2026-08-05T00:59:30.000Z",
        progressAt: PROGRESS,
        identity: {
          taskId: "task-1",
          roleName: "worker",
          runId: "run-1",
          agentId: "agent-1",
          adapterId: "codex",
          nativeSessionId: "native-1"
        },
        active: true,
        changed: true
      }
    ]])
  );
  assert.equal(result[0]?.runId, "run-1");
  assert.equal(store.events.filter((event) => event.type === "run.stalled").length, 1);
});

test("stale Run, Session-generation, and progress-fence samples cannot suppress the current stall", async () => {
  for (const { identity, sampleProgressAt } of [
    { identity: {
      taskId: "task-1",
      roleName: "worker",
      runId: "old-run",
      agentId: "agent-1",
      adapterId: "codex",
      nativeSessionId: "native-1"
    }, sampleProgressAt: PROGRESS },
    { identity: {
      taskId: "task-1",
      roleName: "worker",
      runId: "run-1",
      agentId: "agent-1",
      adapterId: "codex",
      nativeSessionId: "old-native"
    }, sampleProgressAt: PROGRESS },
    { identity: {
      taskId: "task-1",
      roleName: "worker",
      runId: "run-1",
      agentId: "agent-1",
      adapterId: "codex",
      nativeSessionId: "native-1"
    }, sampleProgressAt: "2026-08-04T23:59:00.000Z" }
  ]) {
    const store = stallStore();
    const result = await reconcileStalledRoleRuns(
      store,
      { async inspectRole() { return "present"; } },
      NOW,
      undefined,
      30 * 60_000,
      undefined,
      new Map([
        // This broad key models the old task/role fallback and must be ignored.
        ["task-1\0worker", {
          observedAt: "2026-08-05T00:59:30.000Z",
          progressAt: sampleProgressAt,
          identity,
          active: true,
          changed: true
        }],
        // Even an exact current-Run key is unsafe when its Session generation is stale.
        ["task-1\0worker\0run-1", {
          observedAt: "2026-08-05T00:59:30.000Z",
          progressAt: sampleProgressAt,
          identity,
          active: true,
          changed: true
        }]
      ])
    );
    assert.equal(result[0]?.runId, "run-1");
    assert.equal(store.events.filter((event) => event.type === "run.stalled").length, 1);
    assert.equal(
      store.events.filter((event) => event.type === "run.resource-suppressed").length,
      0
    );
  }
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

test("a Leader with a single stalled Worker keeps the recovery Leader-owned on the same pass", async () => {
  const store = stallStore({ roleName: "leader", downstream: true, downstreamStalled: true });
  const delivery = { async inspectRole() { return "present"; } };
  const first = await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000);
  // Only the Worker's run.stalled is recorded; the Leader is not escalated to
  // the Operator in the same reconciliation that first observed the stall.
  const stalled = store.events.filter((event) => event.type === "run.stalled");
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].payload.runId, "run-worker");
  assert.deepEqual(
    first.map(({ runId, classification }) => ({ runId, classification })),
    [{ runId: "run-worker", classification: "truly-stalled" }]
  );

  // A repeated pass is idempotent: no duplicate and still no Leader escalation.
  await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000);
  assert.equal(store.events.filter((event) => event.type === "run.stalled").length, 1);
  assert.equal(
    store.events.some((event) => (
      event.type === "run.stalled" && event.payload.runId === "run-1"
    )),
    false
  );
});

test("a recent Leader mailbox action is not escalated even while a Worker is stalled", async () => {
  const store = stallStore({
    roleName: "leader",
    downstream: true,
    downstreamStalled: true,
    leaderMailboxQueuedAt: new Date(NOW.getTime() - 15 * 60_000).toISOString()
  });
  const delivery = { async inspectRole() { return "present"; } };
  await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000);
  const stalled = store.events.filter((event) => event.type === "run.stalled");
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].payload.runId, "run-worker");
});

test("a stale Leader mailbox action escalates the Leader once alongside the Worker stall", async () => {
  const store = stallStore({
    roleName: "leader",
    downstream: true,
    downstreamStalled: true,
    leaderMailboxQueuedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString()
  });
  const delivery = { async inspectRole() { return "present"; } };
  const first = await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000);
  assert.deepEqual(
    first.map(({ runId, classification }) => ({ runId, classification })).sort((a, b) => (
      a.runId.localeCompare(b.runId)
    )),
    [
      { runId: "run-1", classification: "truly-stalled" },
      { runId: "run-worker", classification: "truly-stalled" }
    ]
  );
  assert.equal(
    store.events.filter((event) => (
      event.type === "run.stalled" && event.payload.runId === "run-1"
    )).length,
    1
  );

  // The Leader escalation is one-shot for the same Run + progress point.
  await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000);
  assert.equal(
    store.events.filter((event) => (
      event.type === "run.stalled" && event.payload.runId === "run-1"
    )).length,
    1
  );
});

test("an exact current Leader processing batch ages into one Operator-owned stall", async () => {
  const store = stallStore({
    roleName: "leader",
    downstream: true,
    downstreamStalled: true,
    leaderProcessing: {
      startedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      executionRef: { type: "run", taskId: "task-1", id: "run-1" }
    }
  });
  const delivery = { async inspectRole() { return "present"; } };
  const first = await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000);
  assert.deepEqual(
    first.map(({ runId, classification }) => ({ runId, classification })).sort((a, b) => (
      a.runId.localeCompare(b.runId)
    )),
    [
      { runId: "run-1", classification: "truly-stalled" },
      { runId: "run-worker", classification: "truly-stalled" }
    ]
  );
  assert.equal(
    store.events.filter((event) => (
      event.type === "run.stalled" && event.payload.runId === "run-1"
    )).length,
    1
  );

  // Reconciliation is one-shot for this exact Run + progress point.
  await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000);
  assert.equal(
    store.events.filter((event) => (
      event.type === "run.stalled" && event.payload.runId === "run-1"
    )).length,
    1
  );
});

test("a recent exact Leader processing batch keeps Worker recovery Leader-owned", async () => {
  const store = stallStore({
    roleName: "leader",
    downstream: true,
    downstreamStalled: true,
    leaderProcessing: {
      startedAt: new Date(NOW.getTime() - 15 * 60_000).toISOString(),
      executionRef: { type: "run", taskId: "task-1", id: "run-1" }
    }
  });
  const delivery = { async inspectRole() { return "present"; } };
  const first = await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000);
  assert.deepEqual(first.map(({ runId }) => runId), ["run-worker"]);
  assert.equal(
    store.events.some((event) => event.type === "run.stalled" && event.payload.runId === "run-1"),
    false
  );
});

test("a newer durable Leader progress fence keeps an old processing batch quiet", async () => {
  const store = stallStore({
    roleName: "leader",
    downstream: true,
    downstreamStalled: true,
    leaderProcessing: {
      startedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      executionRef: { type: "run", taskId: "task-1", id: "run-1" }
    }
  });
  store.events.push(createTaskEvent(
    "event-3",
    "task-1",
    "run.progress",
    {
      runId: "run-1",
      progressAt: new Date(NOW.getTime() - 5 * 60_000).toISOString()
    },
    new Date(NOW.getTime() - 5 * 60_000)
  ));
  const delivery = { async inspectRole() { return "present"; } };
  const first = await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000);
  assert.deepEqual(first.map(({ runId }) => runId), ["run-worker"]);
  assert.equal(
    store.events.some((event) => event.type === "run.stalled" && event.payload.runId === "run-1"),
    false
  );
});

test("a Leader processing action escalates after its newer progress fence ages out", async () => {
  const store = stallStore({
    roleName: "leader",
    downstream: true,
    downstreamStalled: true,
    leaderProcessing: {
      startedAt: "2026-08-05T00:10:00.000Z",
      executionRef: { type: "run", taskId: "task-1", id: "run-1" }
    }
  });
  store.events.push(createTaskEvent(
    "event-3",
    "task-1",
    "run.progress",
    {
      runId: "run-1",
      progressAt: "2026-08-05T00:20:00.000Z"
    },
    new Date("2026-08-05T00:20:00.000Z")
  ));
  const delivery = { async inspectRole() { return "present"; } };
  const result = await reconcileStalledRoleRuns(
    store,
    delivery,
    new Date("2026-08-05T01:20:00.000Z"),
    undefined,
    30 * 60_000
  );
  assert.equal(result.some(({ runId }) => runId === "run-1"), true);
  assert.equal(
    store.events.filter((event) => event.type === "run.stalled" && event.payload.runId === "run-1").length,
    1
  );
});

test("a stale unrelated pending Leader batch cannot override fresh current processing progress", async () => {
  const store = stallStore({
    roleName: "leader",
    downstream: true,
    downstreamStalled: true,
    leaderProcessing: {
      startedAt: "2026-08-05T00:00:00.000Z",
      executionRef: { type: "run", taskId: "task-1", id: "run-1" },
      refs: [{ type: "work-item", taskId: "task-1", id: "work-1" }]
    }
  });
  store.events.push(createTaskEvent(
    "event-3",
    "task-1",
    "work.retired",
    {
      workItemId: "work-1",
      summary: "retired"
    },
    new Date("2026-08-05T00:20:00.000Z")
  ));
  const originalMailbox = store.getWorkMailbox.bind(store);
  store.getWorkMailbox = (selector) => {
    const mailbox = originalMailbox(selector);
    if (selector?.kind !== "role" || selector.roleName !== "leader") return mailbox;
    return {
      ...mailbox,
      pending: {
        lastQueuedAt: "2026-08-05T00:00:00.000Z",
        refs: [{ type: "run", taskId: "task-other", id: "run-other" }]
      }
    };
  };
  const delivery = { async inspectRole() { return "present"; } };
  const result = await reconcileStalledRoleRuns(
    store,
    delivery,
    new Date("2026-08-05T00:40:00.000Z"),
    undefined,
    30 * 60_000
  );
  assert.deepEqual(result.map(({ runId }) => runId), ["run-worker"]);
  assert.equal(
    store.events.some((event) => event.type === "run.stalled" && event.payload.runId === "run-1"),
    false
  );
});

test("current Leader action lifecycle progress is bounded to its processing batch", async () => {
  const store = stallStore({
    roleName: "leader",
    downstream: true,
    downstreamStalled: true,
    leaderProcessing: {
      startedAt: "2026-08-05T00:00:00.000Z",
      executionRef: { type: "run", taskId: "task-1", id: "run-1" },
      refs: [{ type: "work-item", taskId: "task-1", id: "work-1" }]
    }
  });
  store.events.push(createTaskEvent(
    "event-3",
    "task-1",
    "work.retired",
    { workItemId: "work-1", summary: "retired" },
    new Date("2026-08-05T00:20:00.000Z")
  ));
  const delivery = { async inspectRole() { return "present"; } };
  const result = await reconcileStalledRoleRuns(
    store,
    delivery,
    new Date("2026-08-05T00:40:00.000Z"),
    undefined,
    30 * 60_000
  );
  assert.deepEqual(result.map(({ runId }) => runId), ["run-worker"]);
  assert.equal(
    store.events.some((event) => event.type === "run.stalled" && event.payload.runId === "run-1"),
    false
  );
});

test("Task-scoped milestone progress requires the exact current action reason and Task ref", async () => {
  const store = stallStore({
    roleName: "leader",
    downstream: true,
    downstreamStalled: true,
    leaderProcessing: {
      startedAt: "2026-08-05T00:00:00.000Z",
      executionRef: { type: "run", taskId: "task-1", id: "run-1" },
      reasons: ["milestone-added"],
      refs: [{ type: "task", id: "task-1" }]
    }
  });
  store.events.push(createTaskEvent(
    "event-4",
    "task-1",
    "milestone.added",
    { milestoneId: "milestone-1", title: "checkpoint" },
    new Date("2026-08-05T00:20:00.000Z")
  ));
  const delivery = { async inspectRole() { return "present"; } };
  const result = await reconcileStalledRoleRuns(
    store,
    delivery,
    new Date("2026-08-05T00:40:00.000Z"),
    undefined,
    30 * 60_000
  );
  assert.deepEqual(result.map(({ runId }) => runId), ["run-worker"]);
});

test("a stamped Leader event from another Task cannot refresh a local Run-id collision", async () => {
  const store = stallStore({
    roleName: "leader",
    downstream: true,
    downstreamStalled: true,
    leaderProcessing: {
      startedAt: "2026-08-05T00:00:00.000Z",
      executionRef: { type: "run", taskId: "task-1", id: "run-1" }
    }
  });
  store.events.push(createTaskEvent(
    "event-1",
    "task-other",
    "decision.recorded",
    { leaderRunId: "run-1", decisionId: "decision-1" },
    new Date("2026-08-05T00:20:00.000Z")
  ));
  const delivery = { async inspectRole() { return "present"; } };
  const result = await reconcileStalledRoleRuns(
    store,
    delivery,
    new Date("2026-08-05T00:40:00.000Z"),
    undefined,
    30 * 60_000
  );
  assert.deepEqual(
    result.map(({ runId }) => runId).sort(),
    ["run-1", "run-worker"]
  );
});

test("a mailbox reason prefix cannot claim a different Leader lifecycle event", async () => {
  const store = stallStore({
    roleName: "leader",
    downstream: true,
    downstreamStalled: true,
    leaderProcessing: {
      startedAt: "2026-08-05T00:00:00.000Z",
      executionRef: { type: "run", taskId: "task-1", id: "run-1" },
      reasons: ["milestone-added-extra"],
      refs: [{ type: "task", id: "task-1" }]
    }
  });
  store.events.push(createTaskEvent(
    "event-1",
    "task-1",
    "milestone.added",
    { milestoneId: "milestone-1", title: "Not the claimed reason" },
    new Date("2026-08-05T00:20:00.000Z")
  ));
  const delivery = { async inspectRole() { return "present"; } };
  const result = await reconcileStalledRoleRuns(
    store,
    delivery,
    new Date("2026-08-05T00:40:00.000Z"),
    undefined,
    30 * 60_000
  );
  assert.deepEqual(
    result.map(({ runId }) => runId).sort(),
    ["run-1", "run-worker"]
  );
});

test("provider activity lookup uses the immutable progress timestamp, not drain time", () => {
  const receivedAt = "2026-08-05T00:05:00.000Z";
  const events = [createTaskEvent(
    "event-3",
    "task-1",
    "runtime.provider-turn-progress",
    {
      runId: "run-1",
      roleName: "worker",
      agentId: "agent-1",
      adapterId: "codex",
      nativeSessionId: "native-1",
      launchId: "launch-1",
      progressAt: receivedAt
    },
    NOW
  )];
  assert.equal(latestRunActivityAt(events, "run-1"), receivedAt);
});

test("malformed provider progress cannot become durable activity through event creation time", () => {
  const events = [createTaskEvent(
    "event-4",
    "task-1",
    "runtime.provider-turn-progress",
    { runId: "run-1" },
    NOW
  )];
  assert.equal(latestRunActivityAt(events, "run-1"), undefined);
  assert.equal(latestRunProgressAt(events, "run-1"), undefined);
});

test("mismatched Leader processing is not current action evidence", async () => {
  const store = stallStore({
    roleName: "leader",
    downstream: true,
    downstreamStalled: true,
    leaderProcessing: {
      startedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      executionRef: { type: "run", taskId: "task-other", id: "run-other" }
    }
  });
  const delivery = { async inspectRole() { return "present"; } };
  const first = await reconcileStalledRoleRuns(store, delivery, NOW, undefined, 30 * 60_000);
  assert.deepEqual(
    first.map(({ runId }) => runId),
    ["run-worker"]
  );
  assert.equal(
    store.events.some((event) => (
      event.type === "run.stalled" && event.payload.runId === "run-1"
    )),
    false
  );
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
    deliveredAt: options.downstreamStalled ? PROGRESS : "2026-08-05T00:40:00.000Z",
    createdAt: options.downstreamStalled ? PROGRESS : "2026-08-05T00:40:00.000Z",
    updatedAt: options.downstreamStalled ? PROGRESS : "2026-08-05T00:40:00.000Z",
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
    getWorkMailbox(selector) {
      if (
        selector !== undefined
        && selector.kind === "role"
        && selector.roleName === "leader"
        && options.leaderMailboxQueuedAt !== undefined
      ) {
        return { pending: { lastQueuedAt: options.leaderMailboxQueuedAt } };
      }
      if (
        selector !== undefined
        && selector.kind === "role"
        && selector.roleName === "leader"
        && options.leaderProcessing !== undefined
      ) {
        return {
          pending: null,
          processing: {
            batchId: "task-1/leader-batch-1",
            batch: {
              fromSequence: 1,
              toSequence: 1,
              reasons: options.leaderProcessing.reasons ?? ["leader-action"],
              refs: options.leaderProcessing.refs ?? [],
              requestCount: 1,
              firstQueuedAt: options.leaderProcessing.startedAt,
              lastQueuedAt: options.leaderProcessing.startedAt
            },
            owner: "controller",
            startedAt: options.leaderProcessing.startedAt,
            executionRef: options.leaderProcessing.executionRef
          }
        };
      }
      return { pending: null };
    },
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
