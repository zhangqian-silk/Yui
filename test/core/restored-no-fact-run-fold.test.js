import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileSchedulerStoreAdapter
} from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { runControllerSchedulerPass } from "../../dist/controller/controller.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createAgentRun as createTestAgentRun } from "../helpers/effectiveLaunch.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createProject } from "../../dist/repository/project.js";
import { reconcileStalledRoleRuns } from "../../dist/scheduler/roleRunStall.js";

// task-18 P1 follow-up: the revision-scoped fold must be authoritative for
// delivered active Runs that have neither retained progress nor stall facts.
// A Run with an empty fold entry (lifecycle events only) or no fold entry at
// all (zero events) still fell back to per-candidate full-history scans, so one
// read-only pass over 10k unrelated events became O(candidates x events) reads
// and starved socket control commands. These tests pin the iteration bound
// with attributable counters and prove the legacy scan survives only when the
// fold port itself is absent.
const TASK_ID = "task-1";
const WORKER_COUNT = 30;
const UNRELATED_EVENTS = 10_000;

function presentDelivery() {
  return {
    async prepareRoleSession() { throw new Error("unused"); },
    async waitUntilReady() { throw new Error("unused"); },
    async sendOnce() { throw new Error("unused"); },
    async inspectRole() { return "present"; },
    async inspectRoles(inputs) {
      return inputs.map(({ taskId, roleName }) => ({ taskId, roleName, status: "present" }));
    },
    async stopTask() { return false; }
  };
}

function unusedWorkspacePreparer() {
  return { async prepareTaskWorkspace() { throw new Error("unused"); } };
}

// Wraps the store's listEvents result in a counting Proxy. The adapter caches
// one projection per durable revision, so the first listEvents call's Proxy is
// reused by every per-candidate read in a read-only pass. Each for...of over
// the cached array is one Symbol.iterator consumption; every element yielded
// is one visited element. Indexed access (.some/.find/.length) is not counted,
// isolating the actual legacy history iterations.
function instrumentEventHistory(store) {
  const counts = { consumptions: 0, elementsVisited: 0 };
  const original = store.listEvents.bind(store);
  store.listEvents = (taskId) => {
    const events = original(taskId);
    return new Proxy(events, {
      get(target, prop, receiver) {
        if (prop === Symbol.iterator) {
          return function* () {
            counts.consumptions += 1;
            for (const event of target) {
              counts.elementsVisited += 1;
              yield event;
            }
          };
        }
        return Reflect.get(target, prop, receiver);
      }
    });
  };
  return counts;
}

function roleNames() {
  return ["leader", ...Array.from({ length: WORKER_COUNT }, (_, index) => `worker-${index + 1}`)];
}

// One active Task with 31 Roles. The Leader Run was delivered 5 minutes ago
// (inside the 10-minute candidate window, so it is never scanned). The 30
// worker Runs were delivered 15 minutes ago: each is a stall candidate but
// still inside the 30-minute stall window, so the pass stays read-only.
//
// The workers split three ways to cover both no-progress and no-stall:
//   agent-run-2..11  : lifecycle events only (run.pushed/run.delivered carry
//                      the runId) -> an EMPTY fold entry {} (no checkpoint,
//                      no stall)
//   agent-run-12..21 : one run.progress at deliveredAt -> fold has checkpoint
//                      and activity but NO latestStall (the no-stall case)
//   agent-run-22..31 : zero events -> NO fold entry (the missing-entry case)
// 10,000 unrelated message.sent events without a runId are the noise every
// legacy per-candidate scan re-reads.
function buildNoFactFixture(home, now) {
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const deliveredAt = new Date(now.getTime() - 15 * 60_000);
  const leaderDeliveredAt = new Date(now.getTime() - 5 * 60_000);
  const runCreatedAt = new Date(now.getTime() - 20 * 60_000);
  const names = roleNames();

  store.transaction((tx) => {
    tx.saveProject(createProject(
      "project-1", "Yui", home,
      { stable: "main", development: "main" }, now
    ));
    const task = activateTask(createTask(TASK_ID, "Task 1", now, {
      projectBindings: [{ projectId: "project-1", directory: "Yui", baseRef: "main" }],
      cwd: home
    }), now);
    tx.saveTask(task);
    tx.saveManagedWorkspace(createManagedWorkspace({
      owner: { type: "task", taskId: TASK_ID },
      root: home,
      entries: [{
        projectId: "project-1",
        directory: "Yui",
        access: "write",
        path: home,
        branch: "main",
        baseRef: "main",
        baseCommit: "0".repeat(40)
      }]
    }, now));
    for (const name of names) {
      const agentId = `codex-${name}`;
      const role = createRole(
        TASK_ID,
        name,
        [createRoleAgentBinding(
          { id: agentId, adapterId: "codex" },
          { adapterId: "codex", model: "gpt-test", effort: "high" }
        )],
        agentId,
        home,
        now
      );
      tx.saveRole(TASK_ID, role);
    }
    let runSeq = 0;
    for (const name of names) {
      runSeq += 1;
      const runId = `agent-run-${runSeq}`;
      const run = createTestAgentRun(
        runId, TASK_ID, name, "new", "work", runCreatedAt,
        { agent: { agentId: `codex-${name}`, adapterId: "codex" } }
      );
      const delivered = name === "leader" ? leaderDeliveredAt : deliveredAt;
      run.deliveredAt = delivered.toISOString();
      run.pushedAt = run.deliveredAt;
      tx.saveAgentRun(run);
      tx.saveActiveAgentRun(run);
    }
  });

  let runSpecificEvents = 0;
  store.transaction((tx) => {
    // Group 1: lifecycle events only -> empty fold entry {}.
    for (let runSeq = 2; runSeq <= 11; runSeq += 1) {
      const runId = `agent-run-${runSeq}`;
      const roleName = `worker-${runSeq - 1}`;
      tx.saveEvent(TASK_ID, createTaskEvent(
        tx.nextEventId(TASK_ID), TASK_ID, "run.pushed",
        { runId, roleName }, deliveredAt
      ));
      tx.saveEvent(TASK_ID, createTaskEvent(
        tx.nextEventId(TASK_ID), TASK_ID, "run.delivered",
        { runId, roleName }, deliveredAt
      ));
      runSpecificEvents += 2;
    }
    // Group 2: one run.progress -> checkpoint/activity facts, no latestStall.
    for (let runSeq = 12; runSeq <= 21; runSeq += 1) {
      const runId = `agent-run-${runSeq}`;
      const roleName = `worker-${runSeq - 1}`;
      tx.saveEvent(TASK_ID, createTaskEvent(
        tx.nextEventId(TASK_ID), TASK_ID, "run.progress",
        {
          runId,
          roleName,
          kind: "durable-fold",
          progressAt: deliveredAt.toISOString(),
          evidence: ""
        },
        deliveredAt
      ));
      runSpecificEvents += 1;
    }
    // Group 3: no events at all -> no fold entry.
    // 10,000 unrelated events without a runId.
    for (let index = 0; index < UNRELATED_EVENTS; index += 1) {
      tx.saveEvent(TASK_ID, createTaskEvent(
        tx.nextEventId(TASK_ID), TASK_ID, "message.sent",
        { content: `unrelated-${index}` },
        new Date(deliveredAt.getTime() + index * 1_000)
      ));
    }
  });

  return { store, totalEvents: UNRELATED_EVENTS + runSpecificEvents };
}

test("one read-only pass over no-fact Runs iterates the event history a bounded number of times", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-no-fact-run-fold-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date("2026-08-15T00:00:00.000Z");
  const { store, totalEvents } = buildNoFactFixture(home, now);
  const counts = instrumentEventHistory(store);
  const adapter = new FileSchedulerStoreAdapter(store);

  const revisionBefore = store.getStateRevision();
  await runControllerSchedulerPass(
    adapter,
    presentDelivery(),
    now,
    unusedWorkspacePreparer(),
    { kind: "full" }
  );
  const revisionAfter = store.getStateRevision();

  // The pass must stay read-only: every candidate is inside the 30-minute
  // stall window, so no stall episode or progress fact is persisted.
  assert.equal(
    revisionAfter,
    revisionBefore,
    "read-only pass over no-fact candidates must not advance the durable revision"
  );

  // The one O(events) fold ran: it touches every event exactly once.
  assert.ok(
    counts.elementsVisited >= totalEvents,
    `expected the fold to visit at least ${totalEvents} events, visited ${counts.elementsVisited}`
  );

  // Old path: every no-fact candidate re-scanned the whole history per progress
  // query (checkpoint, activity, stall attention, evidence key) across the
  // liveness and stall phases, touching ~1.8M elements for 30 candidates.
  // New path: the revision-scoped fold is authoritative, so a missing per-Run
  // entry is an empty fold and no per-candidate scan runs. Allow a small
  // constant number of O(events) passes beyond the fold.
  assert.ok(
    counts.elementsVisited <= 4 * totalEvents,
    `pass touched ${counts.elementsVisited} elements across ${counts.consumptions} consumptions, `
      + `expected at most ${4 * totalEvents} (one bounded fold per task, no per-candidate history scans)`
  );
  assert.ok(
    counts.consumptions <= 8,
    `pass consumed the event iterator ${counts.consumptions} times, expected at most 8 `
      + `(one fold plus bounded phase slack, not one scan per candidate)`
  );
});

// A narrow store that predates the fold port must keep its per-candidate
// scans: the legacy fallback is preserved only when the port itself is absent.
// Methods are bound to the real adapter so its private read projection keeps
// working; only the two fold-port methods are hidden.
function narrowStoreWithoutFoldPort(adapter) {
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === "getRunProgressFacts" || prop === "getRunDurableProgress") {
        return undefined;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function buildStalledFixture(home, now) {
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const deliveredAt = new Date(now.getTime() - 40 * 60_000);
  const runCreatedAt = new Date(now.getTime() - 45 * 60_000);
  const roleName = "worker-1";
  const runId = "agent-run-1";

  store.transaction((tx) => {
    tx.saveProject(createProject(
      "project-1", "Yui", home,
      { stable: "main", development: "main" }, now
    ));
    const task = activateTask(createTask(TASK_ID, "Task 1", now, {
      projectBindings: [{ projectId: "project-1", directory: "Yui", baseRef: "main" }],
      cwd: home
    }), now);
    tx.saveTask(task);
    tx.saveManagedWorkspace(createManagedWorkspace({
      owner: { type: "task", taskId: TASK_ID },
      root: home,
      entries: [{
        projectId: "project-1",
        directory: "Yui",
        access: "write",
        path: home,
        branch: "main",
        baseRef: "main",
        baseCommit: "0".repeat(40)
      }]
    }, now));
    const agentId = "codex-worker-1";
    const role = createRole(
      TASK_ID,
      roleName,
      [createRoleAgentBinding(
        { id: agentId, adapterId: "codex" },
        { adapterId: "codex", model: "gpt-test", effort: "high" }
      )],
      agentId,
      home,
      now
    );
    tx.saveRole(TASK_ID, role);
    // A leader Role must exist so the stall wakeup's leader mailbox target is
    // valid; it carries no active Run.
    const leaderAgentId = "codex-leader";
    const leaderRole = createRole(
      TASK_ID,
      "leader",
      [createRoleAgentBinding(
        { id: leaderAgentId, adapterId: "codex" },
        { adapterId: "codex", model: "gpt-test", effort: "high" }
      )],
      leaderAgentId,
      home,
      now
    );
    tx.saveRole(TASK_ID, leaderRole);
    const run = createTestAgentRun(
      runId, TASK_ID, roleName, "new", "work", runCreatedAt,
      { agent: { agentId, adapterId: "codex" } }
    );
    run.deliveredAt = deliveredAt.toISOString();
    run.pushedAt = run.deliveredAt;
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
  });

  return { store, runId };
}

test("legacy per-candidate scans still raise a stall when the fold port is absent", async (t) => {
  const now = new Date("2026-08-15T00:00:00.000Z");

  // With the fold port present, the fold-authoritative path raises the stall.
  const foldHome = mkdtempSync(join(tmpdir(), "yui-legacy-fold-port-"));
  t.after(() => rmSync(foldHome, { recursive: true, force: true }));
  const foldFixture = buildStalledFixture(foldHome, now);
  const foldAdapter = new FileSchedulerStoreAdapter(foldFixture.store);
  const foldRaised = await reconcileStalledRoleRuns(
    foldAdapter,
    presentDelivery(),
    now
  );
  assert.equal(foldRaised.length, 1);
  assert.equal(foldRaised[0].runId, foldFixture.runId);

  // With the fold port absent, the legacy per-candidate scans raise the same
  // stall for the same fixture shape.
  const legacyHome = mkdtempSync(join(tmpdir(), "yui-legacy-scan-"));
  t.after(() => rmSync(legacyHome, { recursive: true, force: true }));
  const legacyFixture = buildStalledFixture(legacyHome, now);
  const legacyAdapter = new FileSchedulerStoreAdapter(legacyFixture.store);
  const legacyRaised = await reconcileStalledRoleRuns(
    narrowStoreWithoutFoldPort(legacyAdapter),
    presentDelivery(),
    now
  );
  assert.equal(legacyRaised.length, 1);
  assert.equal(legacyRaised[0].runId, legacyFixture.runId);
});
