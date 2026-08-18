#!/usr/bin/env node
// control-plane-slo.mjs — 25-agent control-plane SLO benchmark (Issue 11).
//
// Drives the real file-backed Controller over its Unix socket under synthetic
// 25-agent telemetry load and checks the Issue 11 SLO thresholds:
//
//   command p99          <  50 ms
//   event-loop delay max < 500 ms
//   persistence p99      < 100 ms
//   command timeouts     == 0
//   semantic events lost == 0
//
// SAFETY
// -------
// Hermetic: every run seeds a fresh disposable temp Home (task + leader Role +
// Session + active Run).  The real Yui Home is never touched.  Pass
// --slo to exit non-zero on any threshold violation (CI release gate).
//
// USAGE
// -----
//   node scripts/bench/control-plane-slo.mjs [options]
//
//   --agents <n>            Simulated agents (default 25).
//   --rounds <n>            Load rounds per agent (default 3; use 1 for CI).
//   --slo                   Gate on SLO thresholds; exit 1 on violation.
//   --baseline <path>       Compare against a saved JSON baseline.
//   --write-baseline <path> Save current measurements as JSON baseline.
//   --out <path>            Write JSON artifact (default: stdout summary only).
//   -h, --help              Show this help.

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { startFileTaskControllerRuntime } from "../../dist/controller/runtime.js";
import { callController } from "../../dist/core/controllerClient.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createAgentRun } from "../../dist/run/agentRun.js";
import { createTaskMessage } from "../../dist/message/message.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// SLO thresholds (Issue 11 §4)
// ---------------------------------------------------------------------------

export const SLO_THRESHOLDS = Object.freeze({
  commandP99Ms: 50,
  eldMaxMs: 500,
  persistenceP99Ms: 100,
  commandTimeouts: 0,
  semanticLost: 0
});

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Usage: node scripts/bench/control-plane-slo.mjs [options]

Options:
  --agents <n>            Simulated agents (default 25).
  --rounds <n>            Load rounds per agent (default 3; use 1 for CI).
  --slo                   Gate on SLO thresholds; exit 1 on violation.
  --baseline <path>       Compare against a saved JSON baseline.
  --write-baseline <path> Save current measurements as JSON baseline.
  --out <path>            Write JSON artifact.
  -h, --help              Show this help.
`);
}

function parseArgs(argv) {
  const args = {
    agents: 25,
    rounds: 3,
    slo: false,
    baseline: null,
    writeBaseline: null,
    out: null
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agents") args.agents = parseInt(argv[++i], 10);
    else if (a === "--rounds") args.rounds = parseInt(argv[++i], 10);
    else if (a === "--slo") args.slo = true;
    else if (a === "--baseline") args.baseline = resolve(argv[++i]);
    else if (a === "--write-baseline") args.writeBaseline = resolve(argv[++i]);
    else if (a === "--out") args.out = resolve(argv[++i]);
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  if (!Number.isFinite(args.agents) || args.agents < 1) {
    console.error("--agents must be >= 1");
    process.exit(1);
  }
  if (!Number.isFinite(args.rounds) || args.rounds < 1) {
    console.error("--rounds must be >= 1");
    process.exit(1);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = () => performance.now();

function stats(samples) {
  if (samples.length === 0) {
    return { count: 0, min: 0, mean: 0, p50: 0, p99: 0, max: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    mean: sum / sorted.length,
    p50: pct(0.5),
    p99: pct(0.99),
    max: sorted[sorted.length - 1]
  };
}

function statsRow(label, s) {
  return `  ${label}: n=${s.count} min=${s.min.toFixed(1)}ms mean=${s.mean.toFixed(1)}ms p50=${s.p50.toFixed(1)}ms p99=${s.p99.toFixed(1)}ms max=${s.max.toFixed(1)}ms`;
}

function instrumentTransactions(store) {
  const times = [];
  const orig = store.transaction.bind(store);
  store.transaction = function (execute) {
    const start = now();
    try {
      return orig(execute);
    } finally {
      times.push(now() - start);
    }
  };
  return times;
}

// ---------------------------------------------------------------------------
// Seed — minimal hermetic Home
// ---------------------------------------------------------------------------

const TASK_ID = "task-slo";
const ROLE = "leader";
const AGENT_ID = "codex";
const ADAPTER = "codex";
const RUN_ID = "agent-run-1";
const LAUNCH_ID = "slo-launch-1";
const NATIVE_SESSION_ID = "slo-session-1";
const RECEIPT_ID = `agent-run:${TASK_ID}/${RUN_ID}`;

function seedHome(home) {
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const timestamp = new Date();
  const workspace = join(home, "workspace");

  const effective = {
    schemaVersion: 2,
    sourceDesiredRevision: 1,
    agentId: AGENT_ID,
    adapterId: ADAPTER,
    profileAccess: "read",
    search: false,
    permission: { strategy: "configured", sandbox: "read-only", approval: "never" },
    writeProjectIds: [],
    workspace: { root: workspace, entries: [] },
    context: {}
  };

  const task = activateTask(createTask(TASK_ID, "SLO benchmark", timestamp), timestamp);
  const role = createRole(
    TASK_ID,
    ROLE,
    [createRoleAgentBinding({ id: AGENT_ID, adapterId: ADAPTER })],
    AGENT_ID,
    workspace,
    timestamp
  );
  let sessionSet = createRoleSessionSet(
    { scope: "task", taskId: TASK_ID, roleName: ROLE },
    AGENT_ID,
    timestamp
  );
  sessionSet = recordRoleAgentSession(sessionSet, {
    agentId: AGENT_ID,
    adapterId: ADAPTER,
    nativeSessionId: NATIVE_SESSION_ID,
    launchId: LAUNCH_ID,
    policy: "fixed",
    status: "running",
    effective
  }, timestamp);
  sessionSet = bindTaskRoleRun(sessionSet, {
    agentId: AGENT_ID,
    runId: RUN_ID,
    receiptId: RECEIPT_ID
  }, timestamp);

  const run = createAgentRun(RUN_ID, TASK_ID, ROLE, "new", "SLO load", timestamp, {
    effective
  });

  store.transaction((tx) => {
    tx.saveTask(task);
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    tx.saveTaskRoleWithSessionSet(role, sessionSet);
  });
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

async function runBenchmark(agents, rounds) {
  const home = mkdtempSync(join(tmpdir(), "yui-slo-bench-"));
  console.log(`  temp Home: ${home}`);
  seedHome(home);

  const store = new FileTaskStore(home);
  const txTimes = instrumentTransactions(store);

  const sessionHost = {
    async start() { throw new Error("unused in benchmark"); },
    async resume() { throw new Error("unused in benchmark"); },
    async stop() { /* no-op */ },
    async inspect() { return { state: "unavailable" }; }
  };
  const promptPush = { async tryPush() { return "unavailable"; } };

  let controller = null;
  try {
    controller = await startFileTaskControllerRuntime(home, {
      store,
      intervalMs: 60_000,
      sessionHost,
      promptPush
    });
    console.log("  controller runtime started (real Unix socket)");

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
    if (!ready) throw new Error("controller socket did not become ready");
    console.log("  socket ready");

    // --- Monitors ---
    const eld = monitorEventLoopDelay({ resolution: 10 });
    eld.enable();

    const commandLatencies = [];
    let commandTimeouts = 0;
    let measuring = true;
    async function measureCommands() {
      while (measuring) {
        const s = now();
        try {
          await callController(home, "controller.status", {}, { timeoutMs: 120_000 });
          commandLatencies.push(now() - s);
        } catch {
          commandTimeouts++;
        }
      }
    }
    const measurePromise = measureCommands();

    // --- Load generator ---
    const inbox = new FileRuntimeEventInbox(home);
    const loadStats = {
      rounds: 0,
      progressEvents: 0,
      lifecycleEvents: 0,
      promptAcceptedEvents: 0,
      messages: 0,
      signals: 0,
      eventApplyErrors: 0
    };

    const loadStart = now();
    for (let round = 0; round < rounds; round++) {
      loadStats.rounds++;
      const roundStart = now();

      // Each agent enqueues a progress event (dominant telemetry).
      for (let a = 0; a < agents; a++) {
        try {
          inbox.enqueueProviderProgress({
            scope: "task",
            taskId: TASK_ID,
            roleName: ROLE,
            agentId: AGENT_ID,
            adapterId: ADAPTER,
            launchId: LAUNCH_ID,
            nativeSessionId: NATIVE_SESSION_ID,
            runId: RUN_ID,
            progressId: `slo-progress-${round}-${a}-${Date.now()}`
          });
          loadStats.progressEvents++;
        } catch {
          loadStats.eventApplyErrors++;
        }
      }

      // Round 0: lifecycle events.
      if (round === 0) {
        for (let a = 0; a < agents; a++) {
          try {
            inbox.enqueueSessionLifecycle({
              scope: "task",
              taskId: TASK_ID,
              roleName: ROLE,
              agentId: AGENT_ID,
              adapterId: ADAPTER,
              launchId: LAUNCH_ID,
              nativeSessionId: NATIVE_SESSION_ID,
              runId: RUN_ID
            });
            loadStats.lifecycleEvents++;
          } catch {
            loadStats.eventApplyErrors++;
          }
        }
      }

      // Every 2 rounds: prompt-accepted for a few agents.
      if (round % 2 === 1) {
        for (let a = 0; a < Math.min(5, agents); a++) {
          try {
            inbox.enqueuePromptAccepted({
              scope: "task",
              taskId: TASK_ID,
              roleName: ROLE,
              agentId: AGENT_ID,
              adapterId: ADAPTER,
              launchId: LAUNCH_ID,
              nativeSessionId: NATIVE_SESSION_ID,
              runId: RUN_ID,
              receiptId: RECEIPT_ID
            });
            loadStats.promptAcceptedEvents++;
          } catch {
            loadStats.eventApplyErrors++;
          }
        }
      }

      // Task message (simulates leader/CLI writes).
      try {
        store.transaction((tx) => {
          const id = tx.nextMessageId(TASK_ID);
          const msg = createTaskMessage(
            id, TASK_ID,
            `slo round ${round + 1}`,
            "user",
            { type: "user" },
            new Date()
          );
          tx.saveMessage(TASK_ID, msg);
        });
        loadStats.messages++;
      } catch {
        loadStats.eventApplyErrors++;
      }

      // Signal the controller to drain.
      try {
        await callController(home, "scheduler.signal", { key: `task:${TASK_ID}` }, { timeoutMs: 120_000 });
        loadStats.signals++;
      } catch {
        loadStats.eventApplyErrors++;
      }

      const roundMs = now() - roundStart;
      console.log(`  round ${round + 1}/${rounds}: ${roundMs.toFixed(0)}ms (progress=${loadStats.progressEvents} lc=${loadStats.lifecycleEvents} pa=${loadStats.promptAcceptedEvents} msgs=${loadStats.messages} signals=${loadStats.signals})`);
    }

    // Drain remaining events.
    try {
      await callController(home, "scheduler.signal", { key: `task:${TASK_ID}` }, { timeoutMs: 120_000 });
    } catch { /* ignore */ }

    // Wait for drain to settle (no new transactions for 2s, hard cap 30s).
    const settleStart = now();
    let lastTxCount = txTimes.length;
    let settledMs = 0;
    while (settledMs < 2000 && now() - settleStart < 30_000) {
      await new Promise((r) => setTimeout(r, 500));
      if (txTimes.length === lastTxCount) {
        settledMs += 500;
      } else {
        settledMs = 0;
        lastTxCount = txTimes.length;
      }
    }

    const loadDurationMs = now() - loadStart;
    measuring = false;
    await measurePromise;
    eld.disable();

    // Semantic lost: inbox files remaining after drain.
    const inboxDir = join(home, "runtime", "inbox");
    const inboxFilesRemaining = existsSync(inboxDir)
      ? readdirSync(inboxDir).filter((f) => f.endsWith(".json")).length
      : 0;

    const result = {
      timestamp: new Date().toISOString(),
      tempHome: home,
      load: {
        agents,
        rounds,
        durationMs: loadDurationMs,
        ...loadStats,
        inboxFilesRemaining
      },
      commandLatency: stats(commandLatencies),
      commandTimeouts,
      eventLoopDelay: {
        meanMs: eld.mean / 1e6,
        p50Ms: (typeof eld.p50 === "number" ? eld.p50 : 0) / 1e6,
        p99Ms: (typeof eld.p99 === "number" ? eld.p99 : 0) / 1e6,
        maxMs: eld.max / 1e6
      },
      persistence: stats(txTimes),
      semanticLost: inboxFilesRemaining + loadStats.eventApplyErrors
    };

    console.log(`\n  load duration: ${(loadDurationMs / 1000).toFixed(1)}s`);
    console.log(statsRow("command latency", result.commandLatency));
    console.log(`  command timeouts: ${commandTimeouts}`);
    console.log(`  event-loop delay: mean=${result.eventLoopDelay.meanMs.toFixed(1)}ms p50=${result.eventLoopDelay.p50Ms.toFixed(1)}ms p99=${result.eventLoopDelay.p99Ms.toFixed(1)}ms max=${result.eventLoopDelay.maxMs.toFixed(1)}ms`);
    console.log(statsRow("persistence tx", result.persistence));
    console.log(`  semantic lost: ${result.semanticLost} (inbox remaining=${inboxFilesRemaining}, apply errors=${loadStats.eventApplyErrors})`);

    return result;
  } finally {
    if (controller) {
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
    rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// SLO gate
// ---------------------------------------------------------------------------

function evaluateSlo(result) {
  const violations = [];
  if (result.commandLatency.p99 >= SLO_THRESHOLDS.commandP99Ms) {
    violations.push(`command p99 ${result.commandLatency.p99.toFixed(1)}ms >= ${SLO_THRESHOLDS.commandP99Ms}ms`);
  }
  if (result.eventLoopDelay.maxMs >= SLO_THRESHOLDS.eldMaxMs) {
    violations.push(`ELD max ${result.eventLoopDelay.maxMs.toFixed(1)}ms >= ${SLO_THRESHOLDS.eldMaxMs}ms`);
  }
  if (result.persistence.p99 >= SLO_THRESHOLDS.persistenceP99Ms) {
    violations.push(`persistence p99 ${result.persistence.p99.toFixed(1)}ms >= ${SLO_THRESHOLDS.persistenceP99Ms}ms`);
  }
  if (result.commandTimeouts > SLO_THRESHOLDS.commandTimeouts) {
    violations.push(`command timeouts ${result.commandTimeouts} > ${SLO_THRESHOLDS.commandTimeouts}`);
  }
  if (result.semanticLost > SLO_THRESHOLDS.semanticLost) {
    violations.push(`semantic lost ${result.semanticLost} > ${SLO_THRESHOLDS.semanticLost}`);
  }
  return violations;
}

function compareBaseline(result, baselinePath) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (error) {
    console.error(`  WARNING: could not read baseline ${baselinePath}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  console.log(`\n  baseline comparison (vs ${baselinePath}):`);
  const rows = [
    ["command p99", baseline.commandLatency?.p99, result.commandLatency.p99, "ms"],
    ["ELD max", baseline.eventLoopDelay?.maxMs, result.eventLoopDelay.maxMs, "ms"],
    ["persistence p99", baseline.persistence?.p99, result.persistence.p99, "ms"],
    ["timeouts", baseline.commandTimeouts, result.commandTimeouts, ""],
    ["semantic lost", baseline.semanticLost, result.semanticLost, ""]
  ];
  for (const [label, oldVal, newVal, unit] of rows) {
    if (oldVal === undefined) continue;
    const delta = newVal - oldVal;
    const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "=";
    console.log(`    ${label}: ${oldVal.toFixed(1)}${unit} → ${newVal.toFixed(1)}${unit} ${arrow} ${Math.abs(delta).toFixed(1)}${unit}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  console.log(`=== Control-plane SLO benchmark (agents=${args.agents}, rounds=${args.rounds}) ===`);

  const result = await runBenchmark(args.agents, args.rounds);

  if (args.writeBaseline) {
    writeFileSync(args.writeBaseline, JSON.stringify(result, null, 2) + "\n");
    console.log(`\n  baseline written to ${args.writeBaseline}`);
  }

  if (args.baseline) {
    compareBaseline(result, args.baseline);
  }

  if (args.out) {
    writeFileSync(args.out, JSON.stringify(result, null, 2) + "\n");
    console.log(`  artifact written to ${args.out}`);
  }

  if (args.slo) {
    const violations = evaluateSlo(result);
    if (violations.length > 0) {
      console.log("\n  SLO VIOLATIONS:");
      for (const v of violations) console.log(`    ✗ ${v}`);
      process.exit(1);
    }
    console.log("\n  ✓ All SLO thresholds satisfied.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
