import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createTaskBrief } from "../../dist/brief/taskBrief.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createGlobalRole, createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { yieldAgentRun } from "../../dist/run/agentRun.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore, STORAGE_STATE_FILE } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createProject } from "../../dist/repository/project.js";
import { yuiVersionIdentity } from "../../dist/version.js";
import { createAgentRun as createTestAgentRun } from "../helpers/effectiveLaunch.js";
import { exactTaskCliInvocation } from "../helpers/exactTaskCli.js";

const NOW = new Date("2026-08-14T00:00:00.000Z");
const TASK_COUNT = 21;
const HOT_TASK_ID = "task-1";
const HOT_TASK_EVENTS = 30000;
const OTHER_TASK_EVENTS = 50;
const HISTORICAL_RUNS_HOT = 300;
const HISTORICAL_RUNS_OTHER = 17;
const EVENT_PADDING = 650;
const UN_WIDENED_TIMEOUT_MS = 3000;
const PRELOAD = join(process.cwd(), "test", "helpers", "countStateReads.cjs");

function roleNamesFor(taskId) {
  if (taskId === HOT_TASK_ID) {
    return ["leader", ...Array.from({ length: 29 }, (_, index) => `worker-${index + 1}`)];
  }
  return ["leader", "worker-1"];
}

// A production-shaped large Home: 21 Tasks, ~700 Runs, 31000 Events, ~32MiB
// state.json. Two full parses of this state plus the doubled per-Task fact
// reads push a managed `task list` past the un-widened 3000ms boundary.
function buildLargeFixture(home, now) {
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const deliveredAt = new Date(now.getTime() - 15 * 60_000);
  const runCreatedAt = new Date(now.getTime() - 20 * 60_000);
  const taskIds = [];
  store.transaction((tx) => {
    tx.saveProject(createProject("project-1", "Yui", home, { stable: "main", development: "main" }, now));
    for (let i = 1; i <= TASK_COUNT; i += 1) {
      const taskId = `task-${i}`;
      taskIds.push(taskId);
      const task = activateTask(createTask(taskId, `Task ${i}`, now, {
        projectBindings: [{ projectId: "project-1", directory: "Yui", baseRef: "main" }],
        cwd: home
      }), now);
      tx.saveTask(task);
      for (const name of roleNamesFor(taskId)) {
        const agentId = `codex-${name}`;
        const role = createRole(taskId, name, [createRoleAgentBinding(
          { id: agentId, adapterId: "codex" },
          { adapterId: "codex", model: "gpt-test", effort: "high" }
        )], agentId, home, now);
        tx.saveRole(taskId, role);
      }
    }
  });
  let runSeq = 0;
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
        const run = createTestAgentRun(runId, taskId, name, "new", "work", runCreatedAt,
          { agent: { agentId: `codex-${name}`, adapterId: "codex" } });
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
        const run = createTestAgentRun(runId, taskId, roleName, "new", "work", created,
          { agent: { agentId: `codex-${roleName}`, adapterId: "codex" } });
        const yielded = yieldAgentRun(run, "done", new Date(created.getTime() + 60_000));
        tx.saveAgentRun(yielded);
      }
      const allRunIds = [...activeRunIds.map((entry) => entry.id), ...historicalRunIds];
      let written = 0;
      for (const { id, roleName } of activeRunIds) {
        tx.saveEvent(taskId, createTaskEvent(tx.nextEventId(taskId), taskId, "run.progress",
          { runId: id, roleName, kind: "durable-fold", progressAt: deliveredAt.toISOString(), evidence: "x".repeat(EVENT_PADDING) },
          deliveredAt));
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
          ? { runId, roleName, kind: "execution-stalled", classification: "truly-stalled", progressAt: at.toISOString(), idleMs: "60000", evidenceKey: "fixture-stall", status: "needs-attention", evidence: "x".repeat(EVENT_PADDING) }
          : { runId, roleName, kind: "durable-fold", progressAt: at.toISOString(), evidence: "x".repeat(EVENT_PADDING) };
        tx.saveEvent(taskId, createTaskEvent(tx.nextEventId(taskId), taskId, stalled ? "run.stalled" : "run.progress", payload, at));
        written += 1;
        index += 1;
      }
      const finalAttentionAt = new Date(deliveredAt.getTime() + 120_000);
      for (const { id, roleName } of activeRunIds) {
        tx.saveEvent(taskId, createTaskEvent(tx.nextEventId(taskId), taskId, "run.stalled",
          { runId: id, roleName, kind: "execution-stalled", classification: "truly-stalled", progressAt: finalAttentionAt.toISOString(), idleMs: "60000", evidenceKey: "fixture-final-attention", status: "needs-attention", evidence: "x".repeat(EVENT_PADDING) },
          finalAttentionAt));
      }
    });
  }
  return { store };
}

let largeFixture;
function largeTaskFixture() {
  if (largeFixture === undefined) {
    const home = mkdtempSync(join(tmpdir(), "yui-cli-read-amplification-"));
    const { store } = buildLargeFixture(home, NOW);
    largeFixture = { home, store };
  }
  return largeFixture;
}

after(() => {
  if (largeFixture !== undefined) {
    rmSync(largeFixture.home, { recursive: true, force: true });
  }
});

const COUNTED_METHODS = [
  "getConfig",
  "listTasks",
  "getTask",
  "getTaskBrief",
  "getRole",
  "listRoles",
  "listWorkItems",
  "listInputRequests",
  "listAgentRuns",
  "listEvents",
  "getLeaderFailure",
  "getOperatorNotification",
  "getPendingWakeup",
  "getWorkMailbox",
  "listReviewRounds",
  "listChangeSets",
  "listIntegrationAttempts",
  "getRoleSession"
];

// Every counted read is a full JSON round-trip clone of the stored collection,
// so the counters below are also clone counters for the large Home.
class CountingStore extends FileTaskStore {
  constructor(home) {
    super(home);
    this.counts = {};
  }
}
for (const method of COUNTED_METHODS) {
  CountingStore.prototype[method] = function countedMethod(...args) {
    this.counts[method] = (this.counts[method] ?? 0) + 1;
    return FileTaskStore.prototype[method].apply(this, args);
  };
}

test("task list reads each per-Task fact at most once and reuses it for the execution projection", () => {
  const { home } = largeTaskFixture();
  const countingStore = new CountingStore(home);
  const result = runTaskCommand(["list"], countingStore, { now: () => new Date(NOW) });
  assert.equal(result.kind, "output");
  assert.equal(result.data.tasks.length, TASK_COUNT);
  const counts = countingStore.counts;
  const oncePerTask = [
    "getTaskBrief",
    "listRoles",
    "listWorkItems",
    "listInputRequests",
    "listAgentRuns",
    "listEvents",
    "getLeaderFailure",
    "getOperatorNotification",
    "getWorkMailbox",
    "listReviewRounds",
    "listChangeSets",
    "listIntegrationAttempts"
  ];
  for (const method of oncePerTask) {
    assert.equal(
      counts[method] ?? 0,
      TASK_COUNT,
      `${method} read ${counts[method] ?? 0} times; expected ${TASK_COUNT} (once per Task). `
      + `Full counts: ${JSON.stringify(counts)}`
    );
  }
  assert.equal(counts.getRole ?? 0, 0, "the leader Role is derived from the single listRoles read");
  assert.equal(counts.getPendingWakeup ?? 0, 0, "pendingWakeup is derived from the single leader mailbox read");
  assert.equal(counts.getTask ?? 0, 0, "the listTasks row is reused as the projection Task");
  assert.equal(
    counts.getRoleSession ?? 0,
    70,
    "one session read per Role (30 on the hot Task, 2 on each of the other 20)"
  );
  assert.equal(counts.listTasks, 1);
  assert.equal(counts.getConfig, 1);
});

function readReport(reportPath) {
  try {
    return JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return undefined;
  }
}

test("a spawned exact managed task list reads the unchanged Home state through one verified store and finishes inside 3000ms", (t) => {
  const { home, store } = largeTaskFixture();
  const invocation = exactTaskCliInvocation({
    home,
    store,
    taskId: HOT_TASK_ID,
    roleName: "leader",
    controlIdentity: yuiVersionIdentity()
  });
  t.after(() => {
    invocation.stopFixtureController();
  });
  const reportPath = join(tmpdir(), `yui-state-read-report-${process.pid}-${Date.now()}.json`);
  t.after(() => rmSync(reportPath, { force: true }));
  const started = Date.now();
  const result = spawnSync(process.execPath, [
    invocation.cliEntry,
    ...invocation.prefix,
    "task", "list", "--json"
  ], {
    encoding: "utf8",
    env: {
      ...invocation.environment,
      NODE_OPTIONS: `--require ${PRELOAD}`,
      YUI_TEST_STATE_READ_PATH: resolve(join(home, STORAGE_STATE_FILE)),
      YUI_TEST_STATE_READ_REPORT: reportPath
    },
    timeout: UN_WIDENED_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024
  });
  const duration = Date.now() - started;
  const report = readReport(reportPath);
  assert.equal(
    result.status,
    0,
    `exact managed task list was killed at the un-widened ${UN_WIDENED_TIMEOUT_MS}ms boundary `
    + `(signal ${result.signal}, error ${result.error?.code ?? "none"}, duration ${duration}ms, `
    + `state.json reads ${report?.reads ?? "unknown"}).`
  );
  assert.ok(duration < UN_WIDENED_TIMEOUT_MS, `exact managed task list took ${duration}ms`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.tasks.length, TASK_COUNT);
  assert.ok(
    statSync(join(home, STORAGE_STATE_FILE)).size > 30 * 1024 * 1024,
    "the fixture must stay production-shaped (~32MiB state)"
  );
  // The read budget for one managed invocation: the version scan and the
  // corruption-detect strict load inside openCompatibleFileTaskStore's
  // unchanged classification fence, plus the single strict parse of the
  // preflight-verified store the command reuses. The command path opens no
  // second store, so the unchanged revision is never parsed by a second
  // instance. The old implementation read state.json six times (two opens,
  // each scanning, detecting, and parsing).
  assert.equal(
    report?.reads,
    3,
    `state.json was read ${report?.reads ?? 0} times; expected 3 (version scan, `
    + `corruption-detect strict load, and one verified-store parse reused by the command).`
  );
});

test("a reused preflight store observes an external writer's new revision before the command reads", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-cli-read-external-writer-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, NOW);
  const writer = new FileTaskStore(home);
  const codex = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  writer.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: codex.id, defaultWorkspace: home });
    tx.saveConfiguredAgent(codex);
    tx.saveGlobalRole(createGlobalRole(
      "leader",
      [createRoleAgentBinding(codex)],
      codex.id,
      home,
      NOW
    ));
  });
  const options = { now: () => new Date(NOW) };
  const created = runTaskCommand(["create", "External writer Task"], writer, options);
  assert.equal(created.kind, "output");
  const taskId = writer.listTasks().at(-1).id;
  runTaskCommand(["activate", taskId], writer, options);
  writer.saveTaskBrief(taskId, createTaskBrief({
    objective: "Original objective",
    boundaries: ["read-only"],
    currentFocus: "before the external writer",
    leaderSummary: "preflight summary",
    updatedBy: "leader"
  }, NOW));

  // The preflight-verified store instance the command will reuse. Its first
  // read warms the per-instance fingerprint cache with the original revision.
  const preflightStore = new FileTaskStore(home);
  assert.equal(preflightStore.getTaskBrief(taskId).leaderSummary, "preflight summary");

  // An external writer commits through a different store instance, changing
  // fingerprint and revision after the preflight read.
  const later = new Date(NOW.getTime() + 60_000);
  writer.saveTaskBrief(taskId, createTaskBrief({
    objective: "Original objective",
    boundaries: ["read-only"],
    currentFocus: "after the external writer",
    leaderSummary: "post-write summary",
    updatedBy: "leader"
  }, later));

  // The reused store must invalidate its warm cache on the next read and
  // observe the new revision; a stale snapshot must never reach the command.
  const result = runTaskCommand(["list"], preflightStore, options);
  assert.equal(result.kind, "output");
  const overview = result.data.tasks.find((task) => task.id === taskId);
  assert.equal(overview.leaderSummary, "post-write summary");
  assert.equal(overview.currentFocus, "after the external writer");
  assert.equal(overview.summaryUpdatedAt, later.toISOString());
  assert.equal(preflightStore.getTaskBrief(taskId).leaderSummary, "post-write summary");
});
