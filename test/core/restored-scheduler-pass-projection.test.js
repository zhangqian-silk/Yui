import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildTaskOverview } from "../../dist/commands/taskOverviewCommand.js";
import { readControllerDiscovery } from "../../dist/core/controllerClient.js";
import { encodeControllerRequest, parseControllerResponse } from "../../dist/core/protocol.js";
import {
  FileSchedulerStoreAdapter
} from "../../dist/controller/fileSchedulerStoreAdapter.js";
import {
  runControllerSchedulerPass,
  startFileTaskController
} from "../../dist/controller/controller.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { yieldAgentRun } from "../../dist/run/agentRun.js";
import { createAgentRun as createTestAgentRun } from "../helpers/effectiveLaunch.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createProject } from "../../dist/repository/project.js";

// Production field facts (task-18, 2026-08): 32.4 MiB state.json, 21 Tasks,
// 722 Runs, 26090 Events; one full/dirty scheduler pass re-read the same
// durable revision's large Task projection per phase and per Role, starving
// socket control commands (8.6s event-loop lag, 11.67s task list). These tests
// pin the amplification with attributable counters and the 3s fairness
// boundary on a controlled aggregate of the same shape.
const TASK_COUNT = 21;
const HOT_TASK_ID = "task-1";
const HOT_TASK_EVENTS = 30000;
const OTHER_TASK_EVENTS = 50;
const HISTORICAL_RUNS_HOT = 300;
const HISTORICAL_RUNS_OTHER = 17;
const THREE_SECONDS_MS = 3_000;

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

// Patches the store instance so the adapter's reads are attributable. The
// adapter holds this store and looks methods up at call time, so patching the
// instance before/after adapter construction both count every delegated read.
function instrumentStore(store, { onFirstListEvents } = {}) {
  const counts = { listEventsCalls: 0, eventsTouched: 0, listTasksCalls: 0 };
  let armed = false;
  let gateFired = false;
  const original = {
    listEvents: store.listEvents.bind(store),
    listTasks: store.listTasks.bind(store)
  };
  store.listEvents = (taskId) => {
    counts.listEventsCalls += 1;
    const result = original.listEvents(taskId);
    counts.eventsTouched += result.length;
    if (armed && !gateFired) {
      gateFired = true;
      onFirstListEvents?.();
    }
    return result;
  };
  store.listTasks = (...args) => {
    counts.listTasksCalls += 1;
    return original.listTasks(...args);
  };
  return {
    counts,
    arm() { armed = true; },
    get gateFired() { return gateFired; }
  };
}

function roleNamesFor(taskId) {
  if (taskId === HOT_TASK_ID) {
    return ["leader", ...Array.from({ length: 29 }, (_, index) => `worker-${index + 1}`)];
  }
  return ["leader", "worker-1"];
}

// Builds a real FileTaskStore shaped like the production Home: one hot Task
// carrying the bulk of the Event history, ~700 Runs (mostly historical), and
// one delivered active Run per Role aged into the 10-minute stall-candidate
// window but still inside the 30-minute stall window, so a full pass reads
// every candidate's history without mutating.
function buildLargeFixture(home, now) {
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const deliveredAt = new Date(now.getTime() - 15 * 60_000);
  const runCreatedAt = new Date(now.getTime() - 20 * 60_000);
  const taskIds = [];

  store.transaction((tx) => {
    tx.saveProject(createProject(
      "project-1", "Yui", home,
      { stable: "main", development: "main" }, now
    ));
    for (let i = 1; i <= TASK_COUNT; i += 1) {
      const taskId = `task-${i}`;
      taskIds.push(taskId);
      const task = activateTask(createTask(taskId, `Task ${i}`, now, {
        projectBindings: [{ projectId: "project-1", directory: "Yui", baseRef: "main" }],
        cwd: home
      }), now);
      tx.saveTask(task);
      tx.saveManagedWorkspace(createManagedWorkspace({
        owner: { type: "task", taskId },
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
      for (const name of roleNamesFor(taskId)) {
        const agentId = `codex-${name}`;
        const role = createRole(
          taskId,
          name,
          [createRoleAgentBinding(
            { id: agentId, adapterId: "codex" },
            { adapterId: "codex", model: "gpt-test", effort: "high" }
          )],
          agentId,
          home,
          now
        );
        tx.saveRole(taskId, role);
      }
    }
  });

  let runSeq = 0;
  let totalEvents = 0;
  for (const taskId of taskIds) {
    const names = roleNamesFor(taskId);
    const isHot = taskId === HOT_TASK_ID;
    const eventBudget = isHot ? HOT_TASK_EVENTS : OTHER_TASK_EVENTS;
    const historicalCount = isHot ? HISTORICAL_RUNS_HOT : HISTORICAL_RUNS_OTHER;
    store.transaction((tx) => {
      const activeRunIds = [];
      for (const name of names) {
        runSeq += 1;
        const runId = `agent-run-${runSeq}`;
        activeRunIds.push({ id: runId, roleName: name });
        const run = createTestAgentRun(
          runId, taskId, name, "new", "work", runCreatedAt,
          { agent: { agentId: `codex-${name}`, adapterId: "codex" } }
        );
        run.deliveredAt = deliveredAt.toISOString();
        run.pushedAt = deliveredAt.toISOString();
        tx.saveAgentRun(run);
        tx.saveActiveAgentRun(run);
      }
      const historicalRunIds = [];
      for (let h = 0; h < historicalCount; h += 1) {
        runSeq += 1;
        const runId = `agent-run-${runSeq}`;
        historicalRunIds.push(runId);
        const roleName = names[h % names.length];
        const created = new Date(runCreatedAt.getTime() - (h + 2) * 60_000);
        const run = createTestAgentRun(
          runId, taskId, roleName, "new", "work", created,
          { agent: { agentId: `codex-${roleName}`, adapterId: "codex" } }
        );
        const yielded = yieldAgentRun(run, "done", new Date(created.getTime() + 60_000));
        tx.saveAgentRun(yielded);
      }
      const allRunIds = [...activeRunIds.map((entry) => entry.id), ...historicalRunIds];
      let written = 0;
      for (const { id, roleName } of activeRunIds) {
        tx.saveEvent(taskId, createTaskEvent(
          tx.nextEventId(taskId), taskId, "run.progress",
          {
            runId: id,
            roleName,
            kind: "durable-fold",
            progressAt: deliveredAt.toISOString(),
            evidence: ""
          },
          deliveredAt
        ));
        written += 1;
      }
      let index = 0;
      while (written < eventBudget) {
        const runId = allRunIds[index % allRunIds.length];
        const active = activeRunIds.find((entry) => entry.id === runId);
        const roleName = active?.roleName ?? names[index % names.length];
        const at = new Date(deliveredAt.getTime() + (index % 100) * 1_000);
        const stalled = index % 10 === 9;
        const payload = stalled
          ? {
              runId,
              roleName,
              kind: "execution-stalled",
              classification: "truly-stalled",
              progressAt: at.toISOString(),
              idleMs: "60000",
              evidenceKey: "fixture-stall",
              status: "needs-attention"
            }
          : {
              runId,
              roleName,
              kind: "durable-fold",
              progressAt: at.toISOString(),
              evidence: ""
            };
        tx.saveEvent(taskId, createTaskEvent(
          tx.nextEventId(taskId), taskId,
          stalled ? "run.stalled" : "run.progress",
          payload, at
        ));
        written += 1;
        index += 1;
      }
      // One final stall attention per active Run, newer than every checkpoint,
      // so the pass's recovery loop observes progressAt <= last attention and
      // stays read-only: the counters below then measure pure read
      // amplification, not mutation churn.
      const finalAttentionAt = new Date(deliveredAt.getTime() + 120_000);
      for (const { id, roleName } of activeRunIds) {
        tx.saveEvent(taskId, createTaskEvent(
          tx.nextEventId(taskId), taskId, "run.stalled",
          {
            runId: id,
            roleName,
            kind: "execution-stalled",
            classification: "truly-stalled",
            progressAt: finalAttentionAt.toISOString(),
            idleMs: "60000",
            evidenceKey: "fixture-final-attention",
            status: "needs-attention"
          },
          finalAttentionAt
        ));
        written += 1;
      }
    });
    totalEvents += eventBudget + names.length;
  }

  return { store, taskIds, totalEvents, taskCount: taskIds.length };
}

test("one full pass reads each task's event history a bounded number of times", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-scheduler-pass-projection-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date("2026-08-14T00:00:00.000Z");
  const { store, totalEvents, taskCount } = buildLargeFixture(home, now);
  const instrument = instrumentStore(store);
  const adapter = new FileSchedulerStoreAdapter(store);

  await runControllerSchedulerPass(
    adapter,
    presentDelivery(),
    now,
    unusedWorkspacePreparer(),
    { kind: "full" }
  );

  // The same durable revision must be projected once per Task, not once per
  // Role per phase. Old path: every stall candidate re-clones the whole Task
  // event history (listEvents) and re-scans it per progress query, so the hot
  // Task's 30000 events are touched ~2x per candidate.
  assert.ok(
    instrument.counts.eventsTouched <= 4 * totalEvents,
    `full pass touched ${instrument.counts.eventsTouched} events, expected at most ${4 * totalEvents} (one bounded projection per task)`
  );
  assert.ok(
    instrument.counts.listEventsCalls <= taskCount + 4,
    `full pass called listEvents ${instrument.counts.listEventsCalls} times, expected at most ${taskCount + 4} (once per task plus bounded phase slack)`
  );
});

test("control status and task-list selection stay under 3s during a full pass over a large aggregate", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-scheduler-pass-fairness-"));
  const now = new Date("2026-08-14T00:00:00.000Z");
  const { store } = buildLargeFixture(home, now);

  let sentAt;
  let selectionScheduledAt;
  let selectionLatencyMs;
  let requestToken;
  let statusSocket;
  let controller;
  let pumped;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    statusSocket?.destroy();
    if (pumped !== undefined) await Promise.allSettled([pumped]);
    await controller?.close();
    rmSync(home, { recursive: true, force: true });
  };
  t.after(cleanup);

  const instrument = instrumentStore(store, {
    onFirstListEvents() {
      // The pass has entered the large-projection hot path. Write the control
      // request into the socket buffer and schedule the equivalent task-list
      // selection; both must be served before the 3s boundary.
      sentAt = performance.now();
      selectionScheduledAt = performance.now();
      statusSocket.write(encodeControllerRequest({
        id: "projection-fairness-status",
        token: requestToken,
        method: "controller.status",
        params: {}
      }));
      setImmediate(() => {
        buildTaskOverview(store, { all: false });
        selectionLatencyMs = performance.now() - selectionScheduledAt;
      });
    }
  });

  try {
    const adapter = new FileSchedulerStoreAdapter(store);
    controller = await startFileTaskController(
      home,
      adapter,
      presentDelivery(),
      undefined,
      {
        intervalMs: 60_000,
        now: () => now,
        workspacePreparer: unusedWorkspacePreparer()
      }
    );
    // Drain the startup pass so the measured pass starts from a quiet state.
    await controller.runtime.pump();

    const discovery = await readControllerDiscovery(home);
    requestToken = discovery.token;
    statusSocket = createConnection(discovery.socketPath);
    await new Promise((resolve, reject) => {
      statusSocket.once("connect", resolve);
      statusSocket.once("error", reject);
    });
    const statusResponse = new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      statusSocket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(0x0a);
        if (newline >= 0) resolve(buffer.subarray(0, newline).toString("utf8"));
      });
      statusSocket.once("error", reject);
    });

    // A second process advances the durable revision after the startup pass,
    // so the measured pass must rebuild its projection (and re-enter the large
    // projection hot path) instead of serving a warm cache. The event carries
    // no runId: it advances the revision without touching the per-Run progress
    // fold, so the measured pass stays read-only.
    const externalWriter = new FileTaskStore(home);
    externalWriter.transaction((tx) => {
      tx.saveEvent(HOT_TASK_ID, createTaskEvent(
        tx.nextEventId(HOT_TASK_ID), HOT_TASK_ID, "message.sent",
        { content: "projection-fairness-external-writer" },
        now
      ));
    });

    instrument.arm();
    pumped = controller.runtime.pump();
    await pumped;

    let responseTimer;
    let line;
    try {
      line = await Promise.race([
        statusResponse,
        new Promise((_, reject) => {
          responseTimer = setTimeout(
            () => reject(new Error("controller.status response did not arrive")),
            30_000
          );
          responseTimer.unref();
        })
      ]);
    } finally {
      clearTimeout(responseTimer);
    }
    const latencyMs = performance.now() - sentAt;

    const parsed = parseControllerResponse(line, "projection-fairness-status");
    assert.equal(parsed.ok, true);
    assert.equal(instrument.gateFired, true, "the measured pass must enter the large-projection hot path");
    assert.ok(
      latencyMs < THREE_SECONDS_MS,
      `controller.status took ${Math.round(latencyMs)}ms during a full pass over the large aggregate`
    );
    assert.ok(
      selectionLatencyMs !== undefined && selectionLatencyMs < THREE_SECONDS_MS,
      `task-list selection took ${Math.round(selectionLatencyMs ?? -1)}ms during a full pass over the large aggregate`
    );
  } finally {
    await cleanup();
  }
});

test("external writer advancing the revision invalidates the read projection", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-scheduler-pass-invalidation-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date("2026-08-14T00:00:00.000Z");
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const taskId = "task-1";
  const roleName = "leader";
  const runId = "agent-run-1";
  store.transaction((tx) => {
    tx.saveProject(createProject(
      "project-1", "Yui", home,
      { stable: "main", development: "main" }, now
    ));
    const task = activateTask(createTask(taskId, "Task 1", now, {
      projectBindings: [{ projectId: "project-1", directory: "Yui", baseRef: "main" }],
      cwd: home
    }), now);
    tx.saveTask(task);
    const agentId = "codex-leader";
    const role = createRole(
      taskId, roleName,
      [createRoleAgentBinding(
        { id: agentId, adapterId: "codex" },
        { adapterId: "codex", model: "gpt-test", effort: "high" }
      )],
      agentId, home, now
    );
    tx.saveRole(taskId, role);
    const run = createTestAgentRun(
      runId, taskId, roleName, "new", "work",
      new Date(now.getTime() - 20 * 60_000),
      { agent: { agentId, adapterId: "codex" } }
    );
    run.deliveredAt = new Date(now.getTime() - 15 * 60_000).toISOString();
    run.pushedAt = run.deliveredAt;
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    for (let i = 0; i < 3; i += 1) {
      tx.saveEvent(taskId, createTaskEvent(
        tx.nextEventId(taskId), taskId, "run.progress",
        { runId, roleName, kind: "durable-fold", progressAt: run.deliveredAt, evidence: "" },
        now
      ));
    }
  });

  const adapter = new FileSchedulerStoreAdapter(store);
  assert.equal(adapter.listEvents(taskId).length, 3);

  // A second process advances the durable revision.
  const other = new FileTaskStore(home);
  other.transaction((tx) => {
    tx.saveEvent(taskId, createTaskEvent(
      tx.nextEventId(taskId), taskId, "message.sent",
      { runId, content: "external-writer" },
      now
    ));
  });

  // The adapter must not serve the stale projection.
  const afterExternal = adapter.listEvents(taskId);
  assert.equal(afterExternal.length, 4);
  assert.ok(
    afterExternal.some((event) => event.payload.content === "external-writer"),
    "external writer event must be visible after the revision advanced"
  );

  // A mutation after the external write must fold on top of it, not lose it.
  const result = adapter.recordRoleRunProgress({
    taskId,
    roleName,
    runId,
    progressAt: new Date(now.getTime() + 1_000).toISOString(),
    now
  });
  assert.notEqual(result, "state-changed");
  const finalEvents = store.listEvents(taskId);
  assert.ok(
    finalEvents.some((event) => event.payload.content === "external-writer"),
    "external writer event must survive the adapter mutation"
  );
  assert.ok(
    finalEvents.some((event) => event.type === "run.progress"),
    "adapter mutation must be recorded"
  );
});
