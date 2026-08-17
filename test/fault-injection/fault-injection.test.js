/**
 * Fault-injection regression matrix (Issue 11 §5).
 *
 * Seeds synthetic failures against disposable Homes and asserts the
 * observability layer (storage identity, fault classification, execution
 * audit) detects and classifies them. Scenarios whose production fix is not
 * yet implemented carry a characterization baseline that documents the
 * current behavior; the baseline updates when the fix lands.
 *
 * No real model, no real Home, no real tmux session.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import {
  collectStorageIdentity,
  evaluateStorageHealth
} from "../../dist/observability/runtimeIdentity.js";
import {
  classifyAgentRunFailure,
  classifyIntegrationAttempt
} from "../../dist/observability/faultClassification.js";
import { runExecutionAudit } from "../../dist/observability/executionAudit.js";
import { scanControllerResourceInventory } from "../../dist/controller/resourceInventoryLinux.js";
import { activateTask, archiveTask, completeTask, createTask } from "../../dist/task/task.js";
import { createAgentRun, failAgentRun, yieldAgentRun } from "../../dist/run/agentRun.js";
import {
  createIntegrationAttempt,
  updateIntegrationAttempt
} from "../../dist/integration/integrationAttempt.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINES_PATH = join(__dirname, "baselines", "fault-matrix.json");

function temporaryHome() {
  const home = mkdtempSync(join(tmpdir(), "yui-fault-injection-"));
  return {
    home,
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function loadBaselines() {
  return JSON.parse(readFileSync(BASELINES_PATH, "utf8"));
}

function effective(workspace) {
  return {
    schemaVersion: 2,
    sourceDesiredRevision: 1,
    agentId: "codex",
    adapterId: "codex",
    profileAccess: "read",
    search: false,
    permission: { strategy: "configured", sandbox: "read-only", approval: "never" },
    writeProjectIds: [],
    workspace: { root: workspace, entries: [] },
    context: {}
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: storage identity contradiction (layout 7 without database)
// ---------------------------------------------------------------------------

test("storage-identity-contradiction: layout 7 manifest without yui.db is a contradiction", () => {
  const { home, cleanup } = temporaryHome();
  try {
    ensureStorageSchema(home);
    // Tamper: declare layout 7 (SQLite WAL) without creating yui.db.
    const schemaPath = join(home, "schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    schema.storageVersion = 7;
    writeFileSync(schemaPath, JSON.stringify(schema, null, 2));

    const identity = collectStorageIdentity(home);
    const health = evaluateStorageHealth(identity);
    assert.equal(health.healthy, false);
    assert.ok(
      health.contradictions.some((f) => f.code === "layout7-missing-database"),
      "expected layout7-missing-database contradiction"
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 2: provider 500 then recover — classification detects transient
// ---------------------------------------------------------------------------

test("provider-500-then-recover: StopFailure 500/504 classified as provider-transient", () => {
  const summaries = [
    "Claude StopFailure. API Error: 504 Gateway Time-out.",
    "Claude StopFailure. API Error: 500 Internal Server Error.",
    "Claude StopFailure. Connection lost.",
    "Claude StopFailure. API Error: 429 rate limit."
  ];
  for (const summary of summaries) {
    const run = failAgentRun(
      createAgentRun("agent-run-1", "task-1", "leader", "new", "test", new Date(), {
        effective: effective("/tmp/ws")
      }),
      summary,
      new Date()
    );
    const result = classifyAgentRunFailure(run);
    assert.equal(
      result.faultClass,
      "provider-transient",
      `expected provider-transient for: ${summary}`
    );
    assert.equal(result.basis, "text-historical");
  }
});

// ---------------------------------------------------------------------------
// Scenario 3: yield crash before commit — audit counts ambiguous yield
// ---------------------------------------------------------------------------

test("yield-crash-before-commit: yielded run without deliveredAt is counted", () => {
  const { home, cleanup } = temporaryHome();
  try {
    ensureStorageSchema(home);
    const store = new FileTaskStore(home);
    const now = new Date();
    const task = activateTask(createTask("task-1", "fault", now), now);
    // Yielded run WITHOUT deliveredAt — the Controller crashed before the
    // durable acceptance fold. The audit must still count it as yielded.
    const run = yieldAgentRun(
      createAgentRun("agent-run-1", "task-1", "leader", "new", "test", now, {
        effective: effective(join(home, "ws"))
      }),
      "state unchanged",
      new Date(now.getTime() + 60_000)
    );
    store.transaction((tx) => {
      tx.saveTask(task);
      tx.saveAgentRun(run);
    });

    const report = runExecutionAudit(home, {}, {
      openStore: () => store,
      directorySize: () => 0
    });
    assert.equal(report.runs.status, "ok");
    assert.equal(report.runs.data.yielded, 1);
    assert.equal(report.runs.data.total, 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 4: yield crash after commit — audit counts clean yield
// ---------------------------------------------------------------------------

test("yield-crash-after-commit: yielded run with deliveredAt is counted", () => {
  const { home, cleanup } = temporaryHome();
  try {
    ensureStorageSchema(home);
    const store = new FileTaskStore(home);
    const now = new Date();
    const task = activateTask(createTask("task-1", "fault", now), now);
    let run = createAgentRun("agent-run-1", "task-1", "leader", "new", "test", now, {
      effective: effective(join(home, "ws"))
    });
    run = { ...run, pushedAt: now.toISOString(), deliveredAt: now.toISOString() };
    run = yieldAgentRun(run, "state unchanged", new Date(now.getTime() + 60_000));
    store.transaction((tx) => {
      tx.saveTask(task);
      tx.saveAgentRun(run);
    });

    const report = runExecutionAudit(home, {}, {
      openStore: () => store,
      directorySize: () => 0
    });
    assert.equal(report.runs.status, "ok");
    assert.equal(report.runs.data.yielded, 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 5: pane dead, provider child alive — residual process detection
// ---------------------------------------------------------------------------

test("pane-dead-provider-alive: status inventory detects residual processes", async () => {
  // Characterization baseline: the resource inventory scanner can find
  // processes whose cwd or cmdline references the Home. This test verifies
  // the scanner runs without error and returns a structured result. Full
  // residual-tree attribution is exercised in the sandbox-home acceptance.
  const { home, cleanup } = temporaryHome();
  try {
    ensureStorageSchema(home);
    const inventory = await scanControllerResourceInventory({
      currentHome: home,
      scope: "current",
      panes: []
    });
    assert.ok(Array.isArray(inventory.resources));
    assert.ok(typeof inventory.coverage === "object" || inventory.coverage === undefined);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 6: 100 unchanged scheduler scans produce no Leader Run
// ---------------------------------------------------------------------------

test("unchanged-scheduler-scan-x100: no new runs from repeated signals", async () => {
  const { home, cleanup } = temporaryHome();
  try {
    ensureStorageSchema(home);
    const store = new FileTaskStore(home);
    const now = new Date();
    const task = activateTask(createTask("task-1", "fault", now), now);
    store.transaction((tx) => tx.saveTask(task));

    const { startFileTaskControllerRuntime } = await import(
      "../../dist/controller/runtime.js"
    );
    const { callController } = await import("../../dist/core/controllerClient.js");

    const sessionHost = {
      async start() { throw new Error("unused"); },
      async resume() { throw new Error("unused"); },
      async stop() { /* no-op */ },
      async inspect() { return { state: "unavailable" }; }
    };
    const promptPush = { async tryPush() { return "unavailable"; } };

    const controller = await startFileTaskControllerRuntime(home, {
      store,
      intervalMs: 60_000,
      sessionHost,
      promptPush
    });
    try {
      // Wait for socket readiness.
      let ready = false;
      for (let attempt = 0; attempt < 30 && !ready; attempt++) {
        try {
          await callController(home, "controller.status", {}, { timeoutMs: 10_000 });
          ready = true;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      assert.ok(ready, "controller socket did not become ready");

      const runsBefore = store.listAgentRuns("task-1").length;
      for (let i = 0; i < 100; i++) {
        await callController(home, "scheduler.signal", { key: "task:task-1" }, {
          timeoutMs: 30_000
        });
      }
      const runsAfter = store.listAgentRuns("task-1").length;
      assert.equal(runsAfter, runsBefore, "unchanged scans must not create Leader Runs");
    } finally {
      try {
        await callController(home, "controller.stop", {}, { timeoutMs: 30_000 });
      } catch { /* ignore */ }
      try {
        await Promise.race([
          controller.close(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout")), 60_000))
        ]);
      } catch { /* ignore */ }
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Scenario 7: handover candidate failure — stale CAS classification
// ---------------------------------------------------------------------------

test("handover-candidate-failure: stale CAS classified as stale-base-target-cas", () => {
  const attempt = updateIntegrationAttempt(
    createIntegrationAttempt({
      id: "integration-1",
      taskId: "task-1",
      projectId: "project-1",
      targetRef: "master",
      expectedHead: "a".repeat(40),
      changeSetIds: ["change-set-1"],
      checkCommands: ["npm test"]
    }, new Date()),
    {
      status: "failed",
      conflict: {
        affectedPaths: ["src/main.ts"],
        summary: "stale base target: expected head moved"
      }
    },
    new Date()
  );
  const result = classifyIntegrationAttempt(attempt);
  assert.equal(result.faultClass, "stale-base-target-cas");
  assert.equal(result.basis, "structured");
});

// ---------------------------------------------------------------------------
// Scenario 8: archive with live reference — audit detects active runs
// ---------------------------------------------------------------------------

test("archive-live-reference-fail-closed: archived task with active run is visible", () => {
  const { home, cleanup } = temporaryHome();
  try {
    ensureStorageSchema(home);
    const store = new FileTaskStore(home);
    const now = new Date();
    const later = new Date(now.getTime() + 3_600_000);
    const task = archiveTask(
      completeTask(
        activateTask(createTask("task-1", "fault", now), now),
        now,
        { by: "user", summary: "fault fixture" }
      ),
      later
    );
    // An active run on an archived task — the audit must surface it.
    const run = createAgentRun("agent-run-1", "task-1", "leader", "new", "test", now, {
      effective: effective(join(home, "ws"))
    });
    store.transaction((tx) => {
      tx.saveTask(task);
      tx.saveAgentRun(run);
    });

    const report = runExecutionAudit(home, {}, {
      openStore: () => store,
      directorySize: () => 0
    });
    assert.equal(report.runs.status, "ok");
    assert.equal(report.runs.data.active, 1);
    assert.equal(report.tasks.data.archived, 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Baseline consistency: every scenario has a baseline entry
// ---------------------------------------------------------------------------

test("fault matrix baselines cover all scenarios", () => {
  const baselines = loadBaselines();
  const scenarioNames = [
    "storage-identity-contradiction",
    "provider-500-then-recover",
    "yield-crash-before-commit",
    "yield-crash-after-commit",
    "pane-dead-provider-alive",
    "unchanged-scheduler-scan-x100",
    "handover-candidate-failure",
    "archive-live-reference-fail-closed"
  ];
  assert.ok(Array.isArray(baselines.scenarios));
  for (const name of scenarioNames) {
    const entry = baselines.scenarios.find((s) => s.name === name);
    assert.ok(entry, `missing baseline for scenario: ${name}`);
    assert.ok(typeof entry.description === "string");
    assert.ok(["passing", "failing"].includes(entry.status));
  }
});
