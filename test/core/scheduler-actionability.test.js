import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { createAgentRun, yieldAgentRun } from "../../dist/run/agentRun.js";
import {
  collectTaskActionability,
  computeActionabilityDigest,
  decideOrphanWake,
  deriveLeaderRunDisposition
} from "../../dist/scheduler/actionability.js";
import { repairOrphanedActiveTasks } from "../../dist/scheduler/activeTaskProgress.js";
import {
  createProductionRegistry,
  planMigration
} from "../../dist/storage/migration/index.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import {
  currentRecordVersions,
  latestStorageVersionState
} from "../../dist/storage/upgrade/recordVersions.js";
import {
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { createReviewRound } from "../../dist/review/reviewRound.js";
import { testEffectiveLaunch } from "../helpers/effectiveLaunch.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");
const LATER = new Date("2026-08-17T04:00:00.000Z");
const REVIEW_BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

test("computeActionabilityDigest is deterministic and independent of fact order", () => {
  const input = {
    taskId: "task-1",
    taskStatus: "active",
    facts: [
      { key: "work-item:wi-1", value: "running|2026-08-17T00:00:00.000Z" },
      { key: "review:rr-1", value: "pending|2026-08-17T00:00:00.000Z" }
    ]
  };
  const reordered = { ...input, facts: [...input.facts].reverse() };
  assert.equal(
    computeActionabilityDigest(input),
    computeActionabilityDigest(reordered)
  );
});

test("computeActionabilityDigest changes when facts or task status change", () => {
  const input = {
    taskId: "task-1",
    taskStatus: "active",
    facts: [{ key: "work-item:wi-1", value: "running|2026-08-17T00:00:00.000Z" }]
  };
  const baseline = computeActionabilityDigest(input);
  assert.notEqual(
    baseline,
    computeActionabilityDigest({
      ...input,
      facts: [...input.facts, { key: "directive:m-2", value: "2026-08-17T00:01:00.000Z" }]
    })
  );
  assert.notEqual(
    baseline,
    computeActionabilityDigest({ ...input, taskStatus: "completed" })
  );
  assert.notEqual(
    baseline,
    computeActionabilityDigest({
      ...input,
      facts: [{ key: "work-item:wi-1", value: "completed|2026-08-17T00:00:00.000Z" }]
    })
  );
});

test("deriveLeaderRunDisposition maps projection status to a machine disposition", () => {
  const cases = [
    ["blocked", "active", "blocked"],
    ["waiting-on-agents", "active", "waiting"],
    ["waiting-user", "active", "waiting"],
    ["needs-leader-action", "active", "progress"],
    ["working", "active", "progress"],
    ["completed", "active", "completed"],
    ["blocked", "completed", "completed"],
    ["waiting-on-agents", "archived", "completed"]
  ];
  for (const [projectionStatus, taskStatus, expected] of cases) {
    assert.equal(
      deriveLeaderRunDisposition(projectionStatus, taskStatus),
      expected,
      `${projectionStatus}/${taskStatus}`
    );
  }
});

test("decideOrphanWake suppresses only a waiting/blocked Leader Run with the same digest", () => {
  const digest = "digest-1";
  const cases = [
    {
      name: "no prior Leader Run wakes",
      lastLeaderRun: null,
      want: "wake"
    },
    {
      name: "an active Leader Run always wakes",
      lastLeaderRun: { status: "active" },
      want: "wake"
    },
    {
      name: "a progress disposition wakes even with the same digest",
      lastLeaderRun: { status: "yielded", disposition: "progress", observedActionabilityDigest: digest },
      want: "wake"
    },
    {
      name: "a completed disposition wakes even with the same digest",
      lastLeaderRun: { status: "yielded", disposition: "completed", observedActionabilityDigest: digest },
      want: "wake"
    },
    {
      name: "a waiting Leader Run with the same digest suppresses",
      lastLeaderRun: { status: "yielded", disposition: "waiting", observedActionabilityDigest: digest },
      want: "suppress"
    },
    {
      name: "a blocked Leader Run with the same digest suppresses",
      lastLeaderRun: { status: "failed", disposition: "blocked", observedActionabilityDigest: digest },
      want: "suppress"
    },
    {
      name: "a waiting Leader Run with a changed digest wakes",
      lastLeaderRun: { status: "yielded", disposition: "waiting", observedActionabilityDigest: "other" },
      want: "wake"
    },
    {
      name: "a waiting Leader Run without a recorded digest wakes",
      lastLeaderRun: { status: "yielded", disposition: "waiting", observedActionabilityDigest: undefined },
      want: "wake"
    },
    {
      name: "a terminal Leader Run without a disposition wakes",
      lastLeaderRun: { status: "yielded", disposition: undefined, observedActionabilityDigest: digest },
      want: "wake"
    }
  ];
  for (const { name, lastLeaderRun, want } of cases) {
    const decision = decideOrphanWake({ currentDigest: digest, lastLeaderRun });
    assert.equal(decision.kind, want, name);
  }
});

// ---------------------------------------------------------------------------
// collectTaskActionability folding
// ---------------------------------------------------------------------------

test("collectTaskActionability folds durable records into stable actionable facts", () => {
  const store = orphanFakeStore();
  store.runs.push({
    id: "agent-run-active",
    taskId: "task-1",
    roleName: "worker",
    status: "active",
    workItemId: "wi-1",
    reviewRoundId: undefined,
    updatedAt: NOW.toISOString()
  });
  store.workItems.push(
    { id: "wi-1", taskId: "task-1", status: "running", updatedAt: NOW.toISOString() },
    { id: "wi-2", taskId: "task-1", status: "completed", updatedAt: NOW.toISOString() },
    { id: "wi-3", taskId: "task-1", status: "retired", updatedAt: NOW.toISOString() }
  );
  store.reviewRounds.push(
    { id: "rr-1", taskId: "task-1", status: "pending", createdAt: NOW.toISOString(), endedAt: undefined },
    { id: "rr-2", taskId: "task-1", status: "completed", createdAt: NOW.toISOString(), endedAt: NOW.toISOString() }
  );
  store.integrationAttempts.push(
    { id: "ia-1", taskId: "task-1", status: "running", updatedAt: NOW.toISOString() },
    { id: "ia-2", taskId: "task-1", status: "committed", updatedAt: NOW.toISOString() }
  );
  store.durableJobs.push(
    { id: "dj-1", taskId: "task-1", status: "succeeded", updatedAt: NOW.toISOString(), terminalAt: NOW.toISOString() },
    { id: "dj-2", taskId: "task-1", status: "running", updatedAt: NOW.toISOString(), terminalAt: undefined }
  );
  store.inputRequests.push(
    { id: "ir-1", taskId: "task-1", status: "open", updatedAt: NOW.toISOString() }
  );
  store.messages.push(
    { id: "m-1", taskId: "task-1", kind: "user", wakePolicy: "leader", createdAt: NOW.toISOString() },
    { id: "m-2", taskId: "task-1", kind: "user", wakePolicy: "none", createdAt: NOW.toISOString() },
    { id: "m-3", taskId: "task-1", kind: "user", createdAt: NOW.toISOString() }
  );

  const input = collectTaskActionability(store, "task-1");
  assert.equal(input.taskStatus, "active");
  assert.deepEqual(
    input.facts.map((fact) => fact.key).sort(),
    [
      "active-run:agent-run-active",
      "directive:m-1",
      "durable-job:dj-1",
      "input:ir-1",
      "integration:ia-1",
      "review:rr-1",
      "work-item:wi-1"
    ]
  );
});

test("collectTaskActionability treats absent record families as empty", () => {
  const store = {
    getTask: () => ({ id: "task-1", status: "active" }),
    listAgentRuns: () => []
  };
  const input = collectTaskActionability(store, "task-1");
  assert.deepEqual(input.facts, []);
  assert.equal(input.taskStatus, "active");
});

test("collectTaskActionability fails closed when the Task is missing", () => {
  const store = orphanFakeStore();
  assert.throws(
    () => collectTaskActionability(store, "missing"),
    /Task not found for actionability projection/
  );
});

// ---------------------------------------------------------------------------
// repairOrphanedActiveTasks suppression (fake store, scheduler-level)
// ---------------------------------------------------------------------------

test("100 scans of an unchanged waiting Task are fully silent: zero wakes, zero writes", () => {
  const store = orphanFakeStore();
  seedWaitingLeaderRun(store, "agent-run-1", NOW);
  for (let i = 0; i < 100; i += 1) {
    const repaired = repairOrphanedActiveTasks(store, NOW);
    assert.deepEqual(repaired, []);
  }
  assert.equal(store.pending, null);
  assert.deepEqual(store.progressCalls, []);
});

test("a new actionable fact wakes exactly once; later scans do not duplicate it", () => {
  const store = orphanFakeStore();
  seedWaitingLeaderRun(store, "agent-run-1", NOW);
  assert.deepEqual(repairOrphanedActiveTasks(store, NOW), []);

  // A new user directive changes the digest.
  store.messages.push({
    id: "m-1",
    taskId: "task-1",
    kind: "user",
    wakePolicy: "leader",
    createdAt: LATER.toISOString()
  });
  const repaired = repairOrphanedActiveTasks(store, LATER);
  assert.deepEqual(repaired, ["task-1"]);
  assert.deepEqual(store.pending.reasons, ["task-orphaned"]);
  assert.equal(store.pending.requestCount, 1);

  // Ten more scans of the same digest must not create a second wake: the
  // pending wakeup is the single durable claim, so later scans skip the Task.
  for (let i = 0; i < 10; i += 1) {
    repairOrphanedActiveTasks(store, LATER);
  }
  assert.equal(store.pending.requestCount, 1);
  assert.deepEqual(store.pending.reasons, ["task-orphaned"]);
});

test("a failing actionability computation fails open and records the error", () => {
  const store = orphanFakeStore();
  seedWaitingLeaderRun(store, "agent-run-1", NOW);
  store.listAgentRuns = () => {
    throw new Error("projection boom");
  };
  const repaired = repairOrphanedActiveTasks(store, NOW);
  assert.deepEqual(repaired, ["task-1"]);
  assert.deepEqual(
    store.progressCalls.map((call) => call.reason),
    ["actionability-unknown"]
  );
  assert.deepEqual(store.pending.reasons, ["task-orphaned"]);
});

test("a progress disposition always wakes even with a matching digest", () => {
  const store = orphanFakeStore();
  seedWaitingLeaderRun(store, "agent-run-1", NOW, { disposition: "progress" });
  const repaired = repairOrphanedActiveTasks(store, NOW);
  assert.deepEqual(repaired, ["task-1"]);
  assert.deepEqual(store.pending.reasons, ["task-orphaned"]);
});

// ---------------------------------------------------------------------------
// FileTaskStore end-to-end: waiting -> new Review result -> exactly one wake
// ---------------------------------------------------------------------------

test("E2E: waiting Task stays silent for 100 scans, then a new Review result wakes once", (t) => {
  const { store, adapter, task } = e2eFixture(t);

  // A terminal waiting Leader Run that observed the current digest.
  const run = yieldAgentRun(
    createAgentRun(
      store.nextAgentRunId(task.id),
      task.id,
      "leader",
      "new",
      "Advance the Task.",
      NOW,
      { effective: testEffectiveLaunch({ agentId: "codex", adapterId: "codex" }) }
    ),
    "Waiting on delegated work.",
    NOW
  );
  const observedDigest = computeActionabilityDigest(
    collectTaskActionability(adapter, task.id)
  );
  store.transaction((tx) => {
    tx.saveAgentRun({
      ...run,
      disposition: "waiting",
      observedActionabilityDigest: observedDigest
    });
  });

  // 100 scans: zero new Leader Runs.
  for (let i = 0; i < 100; i += 1) {
    assert.deepEqual(repairOrphanedActiveTasks(adapter, NOW), []);
  }
  assert.equal(adapter.getPendingWakeup(task.id), null);

  // A new Review result arrives (WorkItem + Candidate + pending ReviewRound).
  const workItem = createWorkItem(
    store.nextWorkItemId(task.id),
    task.id,
    { title: "Implement feature", acceptance: [], dependsOn: [] },
    NOW
  );
  const running = updateWorkItemStatus(workItem, "running", NOW);
  const withCandidate = submitWorkItemCandidate(
    running,
    { summary: "candidate-1", source: { type: "direct" } },
    NOW
  );
  store.transaction((tx) => {
    tx.saveWorkItem(task.id, withCandidate);
    tx.saveReviewRound(
      task.id,
      createReviewRound(
        store.nextReviewRoundId(task.id),
        task.id,
        workItem.id,
        withCandidate.candidates[0].id,
        "reviewer",
        "leader",
        REVIEW_BASE_COMMIT,
        NOW
      )
    );
  });

  // Exactly one wake.
  assert.deepEqual(repairOrphanedActiveTasks(adapter, LATER), [task.id]);
  const pending = adapter.getPendingWakeup(task.id);
  assert.ok(pending);
  assert.deepEqual(pending.reasons, ["task-orphaned"]);
  assert.equal(pending.requestCount, 1);

  // Ten concurrent scans must not create a second Leader Run.
  for (let i = 0; i < 10; i += 1) {
    repairOrphanedActiveTasks(adapter, LATER);
  }
  const stillOne = adapter.getPendingWakeup(task.id);
  assert.ok(stillOne);
  assert.equal(stillOne.requestCount, 1);
  assert.deepEqual(stillOne.reasons, ["task-orphaned"]);
});

test("E2E: read-only task queries write no Message, Event, AgentRun, or wake", (t) => {
  const { store, adapter, task } = e2eFixture(t);
  const before = {
    messages: store.listMessages(task.id).length,
    events: store.listEvents(task.id).length,
    runs: store.listAgentRuns(task.id).length,
    wakeup: adapter.getPendingWakeup(task.id)
  };

  runTaskCommand(["list"], store, { now: () => NOW });
  runTaskCommand(["show", task.id], store, { now: () => NOW });
  runTaskCommand(["context", task.id], store, { now: () => NOW });

  assert.equal(store.listMessages(task.id).length, before.messages);
  assert.equal(store.listEvents(task.id).length, before.events);
  assert.equal(store.listAgentRuns(task.id).length, before.runs);
  assert.equal(adapter.getPendingWakeup(task.id), before.wakeup);
});

// ---------------------------------------------------------------------------
// SQLite end-to-end: the receipt survives a Controller restart (db-only path)
// ---------------------------------------------------------------------------

test("E2E (SQLite): receipt survives store reopen; 100 scans silent, new Review result wakes once", (t) => {
  const fixture = sqliteE2eFixture(t);
  const { root, store, task } = fixture;

  // A terminal waiting Leader Run that observed the current digest.
  const run = yieldAgentRun(
    createAgentRun(
      store.nextAgentRunId(task.id),
      task.id,
      "leader",
      "new",
      "Advance the Task.",
      NOW,
      { effective: testEffectiveLaunch({ agentId: "codex", adapterId: "codex" }) }
    ),
    "Waiting on delegated work.",
    NOW
  );
  const observedDigest = computeActionabilityDigest(
    collectTaskActionability(fixture.adapter, task.id)
  );
  store.transaction((tx) => {
    tx.saveAgentRun({
      ...run,
      disposition: "waiting",
      observedActionabilityDigest: observedDigest
    });
  });

  // Simulate a Controller restart: close and reopen the database. The receipt
  // must survive in yui.db so the post-restart scheduler stays quiescent.
  store.close();
  const reopened = new SqliteTaskStore(root);
  t.after(() => {
    if (reopened.databaseHandle().open) reopened.close();
  });
  const adapter = new FileSchedulerStoreAdapter(reopened);

  // 100 scans after restart: zero new Leader Runs, zero writes.
  for (let i = 0; i < 100; i += 1) {
    assert.deepEqual(repairOrphanedActiveTasks(adapter, NOW), []);
  }
  assert.equal(adapter.getPendingWakeup(task.id), null);

  // A new Review result arrives (WorkItem + Candidate + pending ReviewRound).
  const workItem = createWorkItem(
    reopened.nextWorkItemId(task.id),
    task.id,
    { title: "Implement feature", acceptance: [], dependsOn: [] },
    NOW
  );
  const running = updateWorkItemStatus(workItem, "running", NOW);
  const withCandidate = submitWorkItemCandidate(
    running,
    { summary: "candidate-1", source: { type: "direct" } },
    NOW
  );
  reopened.transaction((tx) => {
    tx.saveWorkItem(task.id, withCandidate);
    tx.saveReviewRound(
      task.id,
      createReviewRound(
        reopened.nextReviewRoundId(task.id),
        task.id,
        workItem.id,
        withCandidate.candidates[0].id,
        "reviewer",
        "leader",
        REVIEW_BASE_COMMIT,
        NOW
      )
    );
  });

  // Exactly one wake.
  assert.deepEqual(repairOrphanedActiveTasks(adapter, LATER), [task.id]);
  const pending = adapter.getPendingWakeup(task.id);
  assert.ok(pending);
  assert.deepEqual(pending.reasons, ["task-orphaned"]);
  assert.equal(pending.requestCount, 1);

  // Ten concurrent scans must not create a second Leader Run.
  for (let i = 0; i < 10; i += 1) {
    repairOrphanedActiveTasks(adapter, LATER);
  }
  const stillOne = adapter.getPendingWakeup(task.id);
  assert.ok(stillOne);
  assert.equal(stillOne.requestCount, 1);
  assert.deepEqual(stillOne.reasons, ["task-orphaned"]);
});

// ---------------------------------------------------------------------------
// Force-wake escape hatch and message wake policy (CLI)
// ---------------------------------------------------------------------------

test("task wake --force bypasses the digest and records an auditable reason", (t) => {
  const { store, task } = e2eFixture(t);
  const result = runTaskCommand(
    ["wake", task.id, "--force", "--reason", "manual investigation"],
    store,
    { now: () => NOW }
  );
  assert.match(result.output, /Woke task-/);
  const pending = store.getPendingWakeup(task.id);
  assert.ok(pending);
  assert.deepEqual(pending.reasons, ["force-wake:manual investigation"]);
  const forced = store.listEvents(task.id).find((event) => event.type === "task.wake-forced");
  assert.ok(forced);
  assert.equal(forced.payload.reason, "force-wake:manual investigation");
});

test("task wake requires --force", (t) => {
  const { store, task } = e2eFixture(t);
  assert.throws(
    () => runTaskCommand(["wake", task.id, "--reason", "no force"], store, { now: () => NOW }),
    /--force is required/
  );
  assert.equal(store.getPendingWakeup(task.id), null);
});

test("task message send --wake-policy none persists context without waking the Leader", (t) => {
  const { store, adapter, task } = e2eFixture(t);
  runTaskCommand(
    ["message", "send", task.id, "FYI only", "--wake-policy", "none"],
    store,
    { now: () => NOW }
  );
  const messages = store.listMessages(task.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].wakePolicy, "none");
  assert.equal(adapter.getPendingWakeup(task.id), null);
});

test("task message send --wake-policy leader wakes the Leader", (t) => {
  const { store, adapter, task } = e2eFixture(t);
  runTaskCommand(
    ["message", "send", task.id, "please continue", "--wake-policy", "leader"],
    store,
    { now: () => NOW }
  );
  const messages = store.listMessages(task.id);
  assert.equal(messages[0].wakePolicy, "leader");
  const pending = adapter.getPendingWakeup(task.id);
  assert.ok(pending);
  assert.deepEqual(pending.reasons, ["user-message"]);
});

test("task message send defaults to waking the Leader for backward compatibility", (t) => {
  const { store, adapter, task } = e2eFixture(t);
  runTaskCommand(
    ["message", "send", task.id, "continue"],
    store,
    { now: () => NOW }
  );
  const messages = store.listMessages(task.id);
  assert.equal(messages[0].wakePolicy, undefined);
  assert.ok(adapter.getPendingWakeup(task.id));
});

test("task message send rejects an invalid wake policy", (t) => {
  const { store, task } = e2eFixture(t);
  assert.throws(
    () => runTaskCommand(
      ["message", "send", task.id, "x", "--wake-policy", "bogus"],
      store,
      { now: () => NOW }
    ),
    /--wake-policy must be 'leader' or 'none'/
  );
});

// ---------------------------------------------------------------------------
// Migrations: AgentRun 6->7 and TaskMessage 2->3
// ---------------------------------------------------------------------------

test("migration: AgentRun 6->7 advances the family and keeps record fields", () => {
  const sourceRecord = Object.fromEntries(
    Object.entries(currentRecordVersions()).map(([kind, entry]) => [kind, { ...entry }])
  );
  sourceRecord.agentRun = { ...sourceRecord.agentRun, version: 6 };
  const source = {
    schemaManifest: {
      schemaVersion: 1,
      storageVersion: 7,
      aggregateSchemaVersion: 17,
      recordVersions: Object.fromEntries(
        Object.entries(sourceRecord).map(([kind, entry]) => [kind, entry.version])
      )
    },
    state: {
      schemaVersion: 17,
      tasks: {
        "task-1": {
          agentRuns: {
            "agent-run-1": {
              schemaVersion: 6,
              roleName: "leader",
              status: "yielded",
              summary: "done"
            }
          }
        }
      }
    }
  };
  const plan = planMigration(
    createProductionRegistry(),
    { layout: 7, aggregate: 17, record: sourceRecord },
    latestStorageVersionState()
  );
  assert.equal(plan.kind, "runnable");
  const step = plan.steps.find(
    (candidate) => candidate.recordKind === "agentRun" && candidate.fromVersion === 6
  );
  assert.ok(step);
  step.step.preconditions(source);
  const migrated = step.step.transform(source);
  assert.equal(migrated.schemaManifest.recordVersions.agentRun, 7);
  assert.equal(
    migrated.state.tasks["task-1"].agentRuns["agent-run-1"].schemaVersion,
    7
  );
  assert.equal(
    migrated.state.tasks["task-1"].agentRuns["agent-run-1"].summary,
    "done"
  );
});

test("migration: TaskMessage 2->3 advances the family without adding wakePolicy", () => {
  const sourceRecord = Object.fromEntries(
    Object.entries(currentRecordVersions()).map(([kind, entry]) => [kind, { ...entry }])
  );
  sourceRecord.message = { ...sourceRecord.message, version: 2 };
  const source = {
    schemaManifest: {
      schemaVersion: 1,
      storageVersion: 7,
      aggregateSchemaVersion: 17,
      recordVersions: Object.fromEntries(
        Object.entries(sourceRecord).map(([kind, entry]) => [kind, entry.version])
      )
    },
    state: {
      schemaVersion: 17,
      tasks: {
        "task-1": {
          messages: {
            "message-1": {
              schemaVersion: 2,
              kind: "user",
              body: "context only"
            }
          }
        }
      }
    }
  };
  const plan = planMigration(
    createProductionRegistry(),
    { layout: 7, aggregate: 17, record: sourceRecord },
    latestStorageVersionState()
  );
  assert.equal(plan.kind, "runnable");
  const step = plan.steps.find(
    (candidate) => candidate.recordKind === "message" && candidate.fromVersion === 2
  );
  assert.ok(step);
  step.step.preconditions(source);
  const migrated = step.step.transform(source);
  assert.equal(migrated.schemaManifest.recordVersions.message, 3);
  const message = migrated.state.tasks["task-1"].messages["message-1"];
  assert.equal(message.schemaVersion, 3);
  assert.equal(message.wakePolicy, undefined);
  assert.equal(message.body, "context only");
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function orphanFakeStore() {
  const task = {
    id: "task-1",
    title: "Quiescence fixture",
    status: "active",
    projectBindings: [],
    cwd: "/repo"
  };
  const workspace = {
    schemaVersion: 2,
    owner: { type: "task", taskId: "task-1" },
    root: "/repo",
    entries: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
  const store = {
    tasks: [task],
    roles: [
      {
        taskId: "task-1",
        name: "leader",
        activeAgentId: "codex-leader",
        adapterId: "codex",
        effective: testEffectiveLaunch({ agentId: "codex-leader", workspaceRoot: "/repo" }),
        workspace: "/repo",
        status: "running"
      }
    ],
    runs: [],
    workItems: [],
    reviewRounds: [],
    integrationAttempts: [],
    durableJobs: [],
    inputRequests: [],
    messages: [],
    pending: null,
    progressCalls: [],
    listTasks: () => store.tasks,
    getTask: (taskId) => store.tasks.find((candidate) => candidate.id === taskId) ?? null,
    listRoles: (taskId) => store.roles.filter((role) => role.taskId === taskId),
    getActiveAgentRun: () => null,
    hasInFlightTurn: () => false,
    hasOpenInputRequest: () => false,
    getWorkMailbox: () => null,
    getPendingWakeup: (taskId) =>
      store.pending !== null && store.pending.taskId === taskId ? store.pending : null,
    savePendingWakeup: (wakeup) => {
      store.pending = wakeup;
    },
    getLeaderFailure: () => null,
    getOperatorNotification: () => null,
    getTaskWorkspace: () => workspace,
    queueTaskProgress: (taskId, reason, now) => {
      store.progressCalls.push({ taskId, reason, at: now.toISOString() });
    },
    listAgentRuns: (taskId) => store.runs.filter((run) => run.taskId === taskId),
    listWorkItems: (taskId) => store.workItems.filter((item) => item.taskId === taskId),
    listReviewRounds: (taskId) =>
      store.reviewRounds.filter((round) => round.taskId === taskId),
    listIntegrationAttempts: (taskId) =>
      store.integrationAttempts.filter((attempt) => attempt.taskId === taskId),
    listDurableJobs: (taskId) => store.durableJobs.filter((job) => job.taskId === taskId),
    listInputRequests: (taskId) =>
      store.inputRequests.filter((request) => request.taskId === taskId),
    listMessages: (taskId) => store.messages.filter((message) => message.taskId === taskId)
  };
  return store;
}

function seedWaitingLeaderRun(store, id, now, overrides = {}) {
  const run = yieldAgentRun(
    createAgentRun(
      id,
      "task-1",
      "leader",
      "new",
      "Advance the Task.",
      now,
      { effective: testEffectiveLaunch({ agentId: "codex-leader", workspaceRoot: "/repo" }) }
    ),
    "Waiting on delegated work.",
    now
  );
  const digest = computeActionabilityDigest(collectTaskActionability(store, "task-1"));
  const terminal = {
    ...run,
    disposition: "waiting",
    observedActionabilityDigest: digest,
    ...overrides
  };
  store.runs.push(terminal);
  return terminal;
}

function e2eFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-issue05-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(agent);
  });
  const options = { now: () => NOW };
  runTaskCommand(["create", "Issue 05 quiescence Task"], store, options);
  const task = store.listTasks()[0];
  runTaskCommand(["activate", task.id], store, options);
  // Activation enqueues a `task-created` wake for the first Leader Run. The
  // fixture simulates that Run having claimed it before yielding, so every
  // test starts from a quiescent baseline.
  store.clearPendingWakeup(task.id);
  const adapter = new FileSchedulerStoreAdapter(store);
  return { root, store, adapter, task, agent };
}

/**
 * SQLite-backed fixture (layout-7 db-only path). The store constructor creates
 * `yui.db` and runs the schema migrations; the same `runTaskCommand` seeding
 * flow as the file-store fixture exercises the real persistence boundary.
 */
function sqliteE2eFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-issue05-sqlite-"));
  const store = new SqliteTaskStore(root);
  t.after(() => {
    if (store.databaseHandle().open) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(agent);
  });
  const options = { now: () => NOW };
  runTaskCommand(["create", "Issue 05 quiescence Task (SQLite)"], store, options);
  const task = store.listTasks()[0];
  runTaskCommand(["activate", task.id], store, options);
  // Activation enqueues a `task-created` wake for the first Leader Run. The
  // fixture simulates that Run having claimed it before yielding, so every
  // test starts from a quiescent baseline.
  store.clearPendingWakeup(task.id);
  const adapter = new FileSchedulerStoreAdapter(store);
  return { root, store, adapter, task, agent };
}
