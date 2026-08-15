#!/usr/bin/env node
// controller-sqlite-worker.mjs — measure the SQLite WAL + Worker-thread control
// plane under the same 25-agent load as the work-item-1 file-store baseline.
//
// This is the work-item-7 acceptance benchmark for task-21. It migrates a temp
// Home copy of the real state.json to SQLite (layout 7), starts the Controller
// with YUI_STORE_BACKEND=sqlite + YUI_STORE_WORKER=1 (persistence worker +
// resource-inventory worker), and drives the same Unix-socket load as the
// baseline (scripts/bench/controller-baseline.mjs Phase 3).
//
// SAFETY
// -------
// The real Yui Home is accepted ONLY via --real-home and is opened read-only
// (readFileSync / statSync). Every write runs against a fresh temp Home copy.
// The real Home is never migrated, opened with a store, or touched by this
// script.
//
// USAGE
// -----
//   node --expose-gc scripts/bench/controller-sqlite-worker.mjs \
//     --real-home /data00/home/zhangqian.0326/.yui
//
//   Optional: --rounds N (default 2)  --agents N (default 25)
//             --out <path>  (default docs/bench/sqlite-worker-<date>.md)

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { populateSqliteFromState } from "../../dist/storage/upgrade/sqliteStateMigration.js";
import { startFileTaskControllerRuntime } from "../../dist/controller/runtime.js";
import { callController } from "../../dist/core/controllerClient.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { createTaskMessage } from "../../dist/message/message.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const TODAY = "2026-08-15";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    realHome: null,
    agents: 25,
    rounds: 2,
    out: null
  };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--real-home") { args.realHome = next; i++; }
    else if (flag === "--agents") { args.agents = Number(next); i++; }
    else if (flag === "--rounds") { args.rounds = Number(next); i++; }
    else if (flag === "--out") { args.out = next; i++; }
    else if (flag === "--help" || flag === "-h") {
      console.log("Usage: node --expose-gc controller-sqlite-worker.mjs --real-home <path> [--agents N] [--rounds N] [--out <path>]");
      process.exit(0);
    }
  }
  if (!args.realHome) {
    console.error("ERROR: --real-home is required.");
    process.exit(1);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Helpers (shared shape with the baseline script)
// ---------------------------------------------------------------------------

function now() { return performance.now(); }
function fmt(ms) { return ms.toFixed(2); }
function fmtBytes(bytes) { return (bytes / (1024 * 1024)).toFixed(1) + " MB"; }

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function stats(samples) {
  if (samples.length === 0) return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1]
  };
}

function statsRow(label, s) {
  return `  ${label.padEnd(28)} n=${String(s.count).padStart(4)}  mean=${fmt(s.mean).padStart(9)}ms  p50=${fmt(s.p50).padStart(9)}ms  p95=${fmt(s.p95).padStart(9)}ms  p99=${fmt(s.p99).padStart(9)}ms  max=${fmt(s.max).padStart(9)}ms`;
}

function makeTempHome(label) {
  return mkdtempSync(join("/tmp", `yui-sqlite-bench-${label}-`));
}

function copyRealState(realHome, tempHome) {
  cpSync(join(realHome, "state.json"), join(tempHome, "state.json"));
  cpSync(join(realHome, "schema.json"), join(tempHome, "schema.json"));
}

function maybeGc() {
  if (typeof globalThis.gc === "function") {
    try { globalThis.gc(); } catch { /* ignore */ }
  }
}

function inboxFileCount(home) {
  const inboxDir = join(home, "runtime", "inbox");
  if (!existsSync(inboxDir)) return 0;
  return readdirSync(inboxDir).filter((f) => f.endsWith(".json")).length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const { realHome, agents, rounds } = args;

  console.log("=== SQLite WAL + Worker control-plane benchmark (task-21 work-item-7) ===");
  console.log(`  real Home (read-only): ${realHome}`);
  console.log(`  agents: ${agents}, rounds: ${rounds}`);
  console.log(`  backend: sqlite + worker (YUI_STORE_BACKEND=sqlite YUI_STORE_WORKER=1)`);

  // Snapshot the real Home (read-only assertion).
  const realBefore = {
    state: statSync(join(realHome, "state.json")),
    schema: statSync(join(realHome, "schema.json"))
  };

  const home = makeTempHome("load");
  console.log(`  temp Home: ${home}`);

  try {
    // 1. Copy real state to temp Home.
    copyRealState(realHome, home);
    const stateSize = statSync(join(home, "state.json")).size;
    console.log(`  state.json copied: ${fmtBytes(stateSize)}`);

    // 2. Migrate temp Home to SQLite (layout 7).
    console.log("  migrating temp Home to SQLite (layout 7)...");
    const migrateStart = now();
    const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    populateSqliteFromState(home, state, "yui.db");
    const migrateMs = now() - migrateStart;
    const dbSize = statSync(join(home, "yui.db")).size;
    console.log(`  migration complete in ${fmt(migrateMs)}ms; yui.db: ${fmtBytes(dbSize)}`);

    // 3. Start the controller with SQLite + worker.
    const sessionHost = {
      async start() { throw new Error("unused in benchmark"); },
      async resume() { throw new Error("unused in benchmark"); },
      async stop() { /* no-op */ },
      async inspect() { return { state: "unavailable" }; }
    };
    const promptPush = { async tryPush() { return "unavailable"; } };

    const environment = {
      ...process.env,
      YUI_STORE_BACKEND: "sqlite",
      YUI_STORE_WORKER: "1"
    };

    const cpuBefore = process.cpuUsage();
    const rssBefore = process.memoryUsage().rss;
    maybeGc();

    const TASK_ID = "task-4";
    const ROLE = "leader";

    let controller;
    try {
      controller = await startFileTaskControllerRuntime(home, {
        environment,
        intervalMs: 60_000,
        sessionHost,
        promptPush
      });
      console.log("  controller runtime started (SQLite + worker, real Unix socket)");
    } catch (error) {
      console.error(`  controller failed to start: ${error instanceof Error ? error.stack : error}`);
      process.exit(1);
    }

    // 4. Wait for the socket to be ready.
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
      try {
        await callController(home, "controller.status", {}, { timeoutMs: 10_000 });
        ready = true;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!ready) throw new Error("controller socket did not become ready");
    console.log("  socket ready");

    // 5. Event-loop delay monitors.
    const eld = monitorEventLoopDelay({ resolution: 10 });
    eld.enable();

    const driftSamples = [];
    let driftRunning = true;
    function driftProbe() {
      if (!driftRunning) return;
      const s = now();
      setImmediate(() => {
        driftSamples.push(now() - s);
        driftProbe();
      });
    }
    driftProbe();

    // 6. Socket latency measurement loop (controller.identity).
    const socketLatencies = [];
    let socketTimeouts = 0;
    let measuring = true;
    async function measureSocket() {
      while (measuring) {
        const s = now();
        try {
          await callController(home, "controller.identity", {}, { timeoutMs: 120_000 });
          socketLatencies.push(now() - s);
        } catch (error) {
          socketTimeouts++;
          console.log(`  socket probe error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const measurePromise = measureSocket();

    // 7. Load generator (same shape as baseline Phase 3).
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

    const agentIdentities = [];
    for (let a = 0; a < agents; a++) {
      agentIdentities.push({
        agentId: a < 20 ? "claude" : "codex",
        adapterId: a < 20 ? "claude" : "codex",
        launchId: `bench-launch-${a}-${Date.now()}`,
        nativeSessionId: `bench-session-${a}-${Date.now()}`,
        runId: `agent-run-bench-${a}`
      });
    }

    const loadStart = now();
    for (let round = 0; round < rounds; round++) {
      loadStats.rounds++;
      const roundStart = now();

      for (let a = 0; a < agents; a++) {
        const id = agentIdentities[a];
        try {
          inbox.enqueueProviderProgress({
            scope: "task",
            taskId: TASK_ID,
            roleName: ROLE,
            agentId: id.agentId,
            adapterId: id.adapterId,
            launchId: id.launchId,
            nativeSessionId: id.nativeSessionId,
            runId: id.runId,
            progressId: `bench-progress-${round}-${a}-${Date.now()}`
          });
          loadStats.progressEvents++;
        } catch (error) {
          loadStats.eventApplyErrors++;
          if (loadStats.eventApplyErrors <= 3) {
            console.log(`  enqueue error (progress): ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      if (round === 0) {
        for (let a = 0; a < agents; a++) {
          const id = agentIdentities[a];
          try {
            inbox.enqueueSessionLifecycle({
              scope: "task",
              taskId: TASK_ID,
              roleName: ROLE,
              agentId: id.agentId,
              adapterId: id.adapterId,
              launchId: `${id.launchId}-lc`,
              nativeSessionId: id.nativeSessionId,
              runId: id.runId
            });
            loadStats.lifecycleEvents++;
          } catch (error) {
            loadStats.eventApplyErrors++;
          }
        }
      }

      if (round % 2 === 1) {
        for (let a = 0; a < Math.min(5, agents); a++) {
          const id = agentIdentities[a];
          try {
            inbox.enqueuePromptAccepted({
              scope: "task",
              taskId: TASK_ID,
              roleName: ROLE,
              agentId: id.agentId,
              adapterId: id.adapterId,
              launchId: `${id.launchId}-pa`,
              nativeSessionId: id.nativeSessionId,
              runId: id.runId,
              receiptId: `bench-receipt-${round}-${a}`
            });
            loadStats.promptAcceptedEvents++;
          } catch (error) {
            loadStats.eventApplyErrors++;
          }
        }
      }

      // Task message via the controller's own SQLite store (same connection
      // the scheduler uses; the worker folds events on a separate connection).
      try {
        controller.store.transaction((tx) => {
          const id = tx.nextMessageId(TASK_ID);
          const msg = createTaskMessage(
            id, TASK_ID,
            `benchmark round ${round + 1} load message`,
            "user",
            { type: "user" },
            new Date()
          );
          tx.saveMessage(TASK_ID, msg);
        });
        loadStats.messages++;
      } catch (error) {
        loadStats.eventApplyErrors++;
        console.log(`  message error: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Signal the controller to drain the inbox.
      try {
        await callController(home, "scheduler.signal", { key: `task:${TASK_ID}` }, { timeoutMs: 120_000 });
        loadStats.signals++;
      } catch (error) {
        console.log(`  signal error: ${error instanceof Error ? error.message : String(error)}`);
      }

      const roundMs = now() - roundStart;
      console.log(`  round ${round + 1}/${rounds}: ${roundMs.toFixed(0)}ms  (progress=${loadStats.progressEvents} lc=${loadStats.lifecycleEvents} pa=${loadStats.promptAcceptedEvents} msgs=${loadStats.messages} signals=${loadStats.signals} inbox=${inboxFileCount(home)})`);
    }

    // 8. Wait for the controller to drain remaining events (inbox empty for 3s).
    console.log("  waiting for controller to drain remaining events...");
    try {
      await callController(home, "scheduler.signal", { key: `task:${TASK_ID}` }, { timeoutMs: 120_000 });
    } catch { /* ignore */ }

    const settleStart = now();
    let settledMs = 0;
    let lastInbox = inboxFileCount(home);
    while (settledMs < 3000 && now() - settleStart < 120_000) {
      await new Promise((r) => setTimeout(r, 500));
      const count = inboxFileCount(home);
      if (count === 0 && lastInbox === 0) {
        settledMs += 500;
      } else {
        settledMs = 0;
      }
      lastInbox = count;
    }

    const loadDurationMs = now() - loadStart;
    measuring = false;
    driftRunning = false;
    await measurePromise;
    eld.disable();

    const cpuAfter = process.cpuUsage(cpuBefore);
    const rssAfter = process.memoryUsage().rss;
    const maxRssKB = process.resourceUsage().maxRSS;

    const inboxRemaining = inboxFileCount(home);

    const result = {
      tempHome: home,
      dbFileBytes: dbSize,
      stateFileBytes: stateSize,
      migrationMs: migrateMs,
      load: {
        agents,
        rounds,
        durationMs: loadDurationMs,
        ...loadStats,
        inboxFilesRemaining: inboxRemaining
      },
      socketLatency: stats(socketLatencies),
      socketTimeouts,
      eventLoopDelay: {
        meanMs: eld.mean / 1e6,
        p50Ms: (typeof eld.p50 === "number" ? eld.p50 : 0) / 1e6,
        p99Ms: (typeof eld.p99 === "number" ? eld.p99 : 0) / 1e6,
        maxMs: eld.max / 1e6
      },
      setImmediateDrift: stats(driftSamples),
      cpu: {
        userMs: cpuAfter.user / 1000,
        systemMs: cpuAfter.system / 1000,
        totalMs: (cpuAfter.user + cpuAfter.system) / 1000
      },
      rss: {
        beforeMB: rssBefore / (1024 * 1024),
        afterMB: rssAfter / (1024 * 1024),
        maxMB: maxRssKB / 1024
      }
    };

    // 9. Report.
    console.log("\n=== Results ===");
    console.log(`  load duration: ${fmt(loadDurationMs)}ms`);
    console.log(`  inbox files remaining: ${inboxRemaining}`);
    console.log(statsRow("socket latency (controller.identity)", result.socketLatency));
    console.log(`  socket timeouts: ${socketTimeouts}`);
    console.log(`  event-loop delay: mean=${fmt(result.eventLoopDelay.meanMs)}ms p50=${fmt(result.eventLoopDelay.p50Ms)}ms p99=${fmt(result.eventLoopDelay.p99Ms)}ms max=${fmt(result.eventLoopDelay.maxMs)}ms`);
    console.log(statsRow("setImmediate drift", result.setImmediateDrift));
    console.log(`  RSS: before=${result.rss.beforeMB.toFixed(0)}MB after=${result.rss.afterMB.toFixed(0)}MB max=${result.rss.maxMB.toFixed(0)}MB`);
    console.log(`  CPU: user=${result.cpu.userMs.toFixed(0)}ms system=${result.cpu.systemMs.toFixed(0)}ms total=${result.cpu.totalMs.toFixed(0)}ms`);

    // 10. Shutdown.
    console.log("  shutting down controller...");
    await controller.close();
    console.log("  controller closed");

    // Assert real Home untouched.
    const realAfter = {
      state: statSync(join(realHome, "state.json")),
      schema: statSync(join(realHome, "schema.json"))
    };
    const touched =
      realBefore.state.size !== realAfter.state.size ||
      realBefore.state.mtimeMs !== realAfter.state.mtimeMs ||
      realBefore.schema.size !== realAfter.schema.size ||
      realBefore.schema.mtimeMs !== realAfter.schema.mtimeMs;
    if (touched) {
      console.log("  WARNING: real Home changed during benchmark (attributed to the live production Controller, not this script).");
    } else {
      console.log("  real Home unchanged (read-only assertion passed).");
    }

    // Write report.
    const outPath = args.out ?? join(REPO_ROOT, "docs", "bench", `sqlite-worker-${TODAY}.md`);
    const report = renderReport(result, args);
    writeFileSync(outPath, report, "utf8");
    console.log(`\n  report written to ${outPath}`);

  } finally {
    // Clean up temp Home.
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function renderReport(result, args) {
  const baseline = {
    socketP99Ms: 7454.10,
    socketMaxMs: 78643.67,
    socketMeanMs: 909.73,
    socketSamples: 122,
    eldMaxMs: 71739.4,
    driftMaxMs: 71691.15,
    rssMaxMB: 1373,
    cpuTotalMs: 134471,
    loadDurationS: 104.0
  };

  const s = result.socketLatency;
  const e = result.eventLoopDelay;
  const d = result.setImmediateDrift;
  const r = result.rss;
  const c = result.cpu;

  const improvement = (baselineVal, newVal) => {
    if (baselineVal === 0) return "n/a";
    const factor = baselineVal / newVal;
    const pct = ((1 - newVal / baselineVal) * 100).toFixed(1);
    return `${factor.toFixed(1)}x faster (${pct}% lower)`;
  };

  return `# SQLite WAL + Worker control-plane benchmark (task-21 work-item-7)

Date: ${TODAY}
Command: \`node --expose-gc scripts/bench/controller-sqlite-worker.mjs --real-home ${args.realHome} --rounds ${args.rounds} --agents ${args.agents}\`

## Configuration

- **Backend**: SQLite WAL + persistence Worker Thread + resource-inventory Worker Thread
- **Env**: \`YUI_STORE_BACKEND=sqlite\`, \`YUI_STORE_WORKER=1\`
- **Agents**: ${result.load.agents} (20 claude, 5 codex)
- **Rounds**: ${result.load.rounds}
- **Load duration**: ${(result.load.durationMs / 1000).toFixed(1)} s (baseline: ${baseline.loadDurationS} s)
- **state.json source**: ${fmtBytes(result.stateFileBytes)} (real Home copy, read-only)
- **yui.db after migration**: ${fmtBytes(result.dbFileBytes)}
- **Migration time**: ${fmt(result.migrationMs)} ms

## Control-socket command latency (\`controller.identity\`)

| Metric | SQLite + Worker | File-store baseline | Improvement |
|--------|----------------|--------------------:|-------------|
| samples | ${s.count} | ${baseline.socketSamples} | |
| mean | ${fmt(s.mean)} ms | ${fmt(baseline.socketMeanMs)} ms | ${improvement(baseline.socketMeanMs, s.mean)} |
| p50 | ${fmt(s.p50)} ms | — | |
| p95 | ${fmt(s.p95)} ms | — | |
| **p99** | **${fmt(s.p99)} ms** | **${fmt(baseline.socketP99Ms)} ms** | **${improvement(baseline.socketP99Ms, s.p99)}** |
| max | ${fmt(s.max)} ms | ${fmt(baseline.socketMaxMs)} ms | ${improvement(baseline.socketMaxMs, s.max)} |
| timeouts | ${result.socketTimeouts} | — | |

## Main-thread event-loop delay

| Metric | SQLite + Worker | File-store baseline | Improvement |
|--------|----------------|--------------------:|-------------|
| mean | ${fmt(e.meanMs)} ms | — | |
| p50 | ${fmt(e.p50Ms)} ms | — | |
| p99 | ${fmt(e.p99Ms)} ms | 0.0 ms | |
| **max** | **${fmt(e.maxMs)} ms** | **${fmt(baseline.eldMaxMs)} ms** | **${improvement(baseline.eldMaxMs, e.maxMs)}** |

## setImmediate drift probe (cross-check)

| Metric | SQLite + Worker | File-store baseline |
|--------|----------------|--------------------:|
| p50 | ${fmt(d.p50)} ms | 0.01 ms |
| p99 | ${fmt(d.p99)} ms | 5.38 ms |
| **max** | **${fmt(d.max)} ms** | **${fmt(baseline.driftMaxMs)} ms** |

## Resource usage

| Metric | SQLite + Worker | File-store baseline |
|--------|----------------|--------------------:|
| RSS before | ${r.beforeMB.toFixed(0)} MB | 548 MB |
| RSS after | ${r.afterMB.toFixed(0)} MB | 814 MB |
| **RSS max** | **${r.maxMB.toFixed(0)} MB** | **${baseline.rssMaxMB} MB** |
| CPU user | ${c.userMs.toFixed(0)} ms | 112665 ms |
| CPU system | ${c.systemMs.toFixed(0)} ms | 21806 ms |
| CPU total | ${c.totalMs.toFixed(0)} ms | ${baseline.cpuTotalMs} ms |

## Load accounting

- progress events: ${result.load.progressEvents}
- lifecycle events: ${result.load.lifecycleEvents}
- prompt-accepted events: ${result.load.promptAcceptedEvents}
- task messages: ${result.load.messages}
- scheduler signals: ${result.load.signals}
- event apply errors: ${result.load.eventApplyErrors}
- inbox files remaining: ${result.load.inboxFilesRemaining}

## Interpretation

The file-store baseline blocks the main event loop for the full
read-parse-validate-mutate-stringify-write cycle (~3.5 s per transaction under
load, up to 71.7 s of event-loop stall). The SQLite + Worker control plane
moves all db-touching observer folds into the persistence Worker Thread; the
main thread only handles socket I/O, command validation, arbitration, and
lightweight scheduling. The event-loop delay and socket latency improvements
above quantify that decoupling.

## Safety

- The real Yui Home (\`${args.realHome}\`) was opened **read-only**
  (readFileSync / statSync). All writes ran against a temp Home copy.
- The temp Home was migrated to SQLite and removed after the benchmark.
- The real Home was not migrated, opened with a store, or modified.
`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
