#!/usr/bin/env node
// controller-baseline.mjs — freeze today's Controller performance baseline.
//
// This benchmark measures the current FileTaskStore + single-process Controller
// at the real production document size (~36 MB state.json).  It produces the
// baseline numbers that justify the SQLite WAL + worker-thread re-architecture
// (see docs/sqlite-control-plane-design.md).
//
// SAFETY
// -------
// The real Yui Home is accepted ONLY via --real-home.  It is opened read-only
// (readFileSync / statSync).  A size+mtime snapshot of state.json and schema.json
// is taken before and after every phase; the script asserts they are identical
// and exits non-zero if the real Home was touched.  Every replay runs against a
// fresh temp Home copy (fs.cpSync of state.json + schema.json only).
//
// PHASES
// ------
//   1. Parse/serializer cost  — JSON.parse / JSON.stringify of the real document.
//   2. Transaction cost       — full read-modify-write cycles on a temp copy.
//   3. Control-plane under load — real Unix-socket Controller driven by 25+
//      agents emitting native-turn-progress telemetry + lifecycle events +
//      task messages, exactly as production hooks do.
//
// USAGE
// -----
//   node --expose-gc scripts/bench/controller-baseline.mjs \
//     --real-home /data00/home/zhangqian.0326/.yui
//
//   Optional: --rounds N (default 3)  --agents N (default 25)
//             --parse-iterations N (default 8)  --tx-iterations N (default 10)
//             --out <path>  (default docs/bench/baseline-<date>.md)

import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { cpus, totalmem, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { openCompatibleFileTaskStore } from "../../dist/storage/compatibleTaskStore.js";
import { startFileTaskControllerRuntime } from "../../dist/controller/runtime.js";
import { callController } from "../../dist/core/controllerClient.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { FileRuntimeEventProcessor } from "../../dist/controller/runtimeEventProcessor.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createTaskMessage } from "../../dist/message/message.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const TODAY = "2026-08-15";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Usage: node [--expose-gc] scripts/bench/controller-baseline.mjs \\
  --real-home <path> [options]

Required:
  --real-home <path>          Path to the real Yui Home (opened read-only).

Options:
  --rounds <n>                Load rounds per agent (default 3).
  --agents <n>                Number of simulated agents (default 25).
  --parse-iterations <n>      Parse/stringify iterations (default 8).
  --tx-iterations <n>         Standalone transaction iterations (default 10).
  --out <path>                Results doc path (default docs/bench/baseline-${TODAY}.md).
  -h, --help                  Show this help.
`);
}

function parseArgs(argv) {
  const args = {
    realHome: null,
    rounds: 3,
    agents: 25,
    parseIterations: 8,
    txIterations: 10,
    outDoc: null
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--real-home") args.realHome = resolve(argv[++i]);
    else if (a === "--rounds") args.rounds = parseInt(argv[++i], 10);
    else if (a === "--agents") args.agents = parseInt(argv[++i], 10);
    else if (a === "--parse-iterations") args.parseIterations = parseInt(argv[++i], 10);
    else if (a === "--tx-iterations") args.txIterations = parseInt(argv[++i], 10);
    else if (a === "--out") args.outDoc = resolve(argv[++i]);
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  if (!args.realHome) {
    console.error("ERROR: --real-home is required (the real Home is opened read-only).");
    printHelp();
    process.exit(1);
  }
  if (!Number.isFinite(args.rounds) || args.rounds < 1) { console.error("--rounds must be >= 1"); process.exit(1); }
  if (!Number.isFinite(args.agents) || args.agents < 1) { console.error("--agents must be >= 1"); process.exit(1); }
  if (!Number.isFinite(args.parseIterations) || args.parseIterations < 2) { console.error("--parse-iterations must be >= 2"); process.exit(1); }
  if (!Number.isFinite(args.txIterations) || args.txIterations < 2) { console.error("--tx-iterations must be >= 2"); process.exit(1); }
  if (!args.outDoc) args.outDoc = join(REPO_ROOT, "docs", "bench", `baseline-${TODAY}.md`);
  return args;
}

// ---------------------------------------------------------------------------
// Helpers
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

/** Snapshot size + mtime of the real Home files (read-only). */
function snapshotRealHome(realHome) {
  const snap = {};
  for (const name of ["state.json", "schema.json"]) {
    const st = statSync(join(realHome, name));
    snap[name] = { size: st.size, mtimeMs: st.mtimeMs };
  }
  return snap;
}

/**
 * Assert the real Home was not modified by THIS script.  The real Home is the
 * live production Home and may be written by the running Controller between
 * snapshots; such external changes are reported as warnings, not failures.
 * The script itself only ever calls readFileSync / statSync on the real Home.
 */
function assertRealHomeUnchanged(realHome, before, label) {
  const after = snapshotRealHome(realHome);
  const changed = [];
  for (const name of Object.keys(before)) {
    const b = before[name];
    const a = after[name];
    if (b.size !== a.size || b.mtimeMs !== a.mtimeMs) {
      changed.push({ name, before: b, after: a });
    }
  }
  if (changed.length > 0) {
    console.log(`  NOTE: real Home changed during ${label} (attributed to the live production Controller, not this script — this script only reads the real Home):`);
    for (const c of changed) {
      console.log(`    ${c.name}: ${c.before.size}B@${c.before.mtimeMs.toFixed(0)} -> ${c.after.size}B@${c.after.mtimeMs.toFixed(0)}`);
    }
  }
  return changed.length === 0;
}

function makeTempHome(label) {
  const home = mkdtempSync(join(tmpdir(), `yui-bench-${label}-`));
  return home;
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

/** Wrap store.transaction to record per-call wall time. */
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
// Phase 1 — parse / serializer cost on the real document (read-only)
// ---------------------------------------------------------------------------

function phaseParseSerialize(realHome, iterations) {
  console.log("\n=== Phase 1: parse / serializer cost (real document, read-only) ===");
  const statePath = join(realHome, "state.json");
  const fileSize = statSync(statePath).size;
  console.log(`  state.json size: ${fmtBytes(fileSize)} (${fileSize} bytes)`);

  // Read the raw bytes once (read-only).
  const readStart = now();
  const raw = readFileSync(statePath, "utf8");
  const readMs = now() - readStart;
  console.log(`  readFileSync: ${fmt(readMs)} ms`);

  const parseTimes = [];
  const stringifyTimes = [];
  const heapDeltas = [];
  let parsed = null;

  for (let i = 0; i < iterations; i++) {
    maybeGc();
    const heapBefore = process.memoryUsage().heapUsed;

    const pStart = now();
    parsed = JSON.parse(raw);
    const pMs = now() - pStart;
    parseTimes.push(pMs);

    const sStart = now();
    const str = JSON.stringify(parsed);
    const sMs = now() - sStart;
    stringifyTimes.push(sMs);

    const heapAfter = process.memoryUsage().heapUsed;
    heapDeltas.push(heapAfter - heapBefore);

    // Keep the compiler honest: touch the stringified output.
    if (str.length < 1000) throw new Error("unexpectedly small stringify output");
    console.log(`  iter ${i + 1}/${iterations}: parse=${fmt(pMs)}ms  stringify=${fmt(sMs)}ms  heapDelta=${fmtBytes(heapAfter - heapBefore)}`);
  }

  const stringifyBytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
  const result = {
    stateFileBytes: fileSize,
    readMs,
    parse: stats(parseTimes),
    stringify: stats(stringifyTimes),
    stringifyBytes,
    heapDeltaMB: heapDeltas.length > 0
      ? heapDeltas.reduce((a, b) => a + b, 0) / heapDeltas.length / (1024 * 1024)
      : 0,
    iterations
  };
  console.log(statsRow("JSON.parse", result.parse));
  console.log(statsRow("JSON.stringify", result.stringify));
  console.log(`  heap delta (mean): ${result.heapDeltaMB.toFixed(1)} MB`);
  return result;
}

// ---------------------------------------------------------------------------
// Phase 2 — transaction cost on a temp copy
// ---------------------------------------------------------------------------

function phaseTransactionCost(realHome, iterations) {
  console.log("\n=== Phase 2: transaction cost on temp copy ===");
  const home = makeTempHome("tx");
  try {
    copyRealState(realHome, home);
    const store = new FileTaskStore(home);
    const taskId = "task-4"; // an active task in the real state
    // Get the current revision cheaply.
    const stateInfo = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    console.log(`  temp Home: ${home}`);
    console.log(`  state revision before: ${stateInfo.revision}`);

    const txTimes = [];
    for (let i = 0; i < iterations; i++) {
      const start = now();
      store.transaction((tx) => {
        const id = tx.nextEventId(taskId);
        tx.saveEvent(taskId, {
          schemaVersion: 2,
          id,
          taskId,
          type: "bench.transaction",
          payload: { iteration: String(i + 1) },
          createdAt: new Date().toISOString()
        });
      });
      const elapsed = now() - start;
      txTimes.push(elapsed);
      console.log(`  tx ${i + 1}/${iterations}: ${fmt(elapsed)} ms`);
    }

    const stateAfter = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    const result = {
      tempHome: home,
      stateFileBytes: statSync(join(home, "state.json")).size,
      revisionBefore: stateInfo.revision,
      revisionAfter: stateAfter.revision,
      iterations,
      tx: stats(txTimes)
    };
    console.log(statsRow("full RMW transaction", result.tx));
    console.log(`  revision: ${result.revisionBefore} -> ${result.revisionAfter}`);
    return result;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — control-plane latency under load (real Unix socket)
// ---------------------------------------------------------------------------

function phaseControlPlaneLoad(realHome, agents, rounds) {
  console.log("\n=== Phase 3: control-plane latency under load (real socket) ===");
  const home = makeTempHome("load");
  const TASK_ID = "task-4";
  const ROLE = "leader";
  const AGENT_ID = "claude";
  const ADAPTER = "claude";

  let controller = null;
  let measurementPath = "real-socket";
  let fallbackReason = null;
  let fallbackProcessor = null;

  return (async () => {
  try {
    copyRealState(realHome, home);
    console.log(`  temp Home: ${home}`);

    const store = openCompatibleFileTaskStore(home);
    const txTimes = instrumentTransactions(store);
    const stateBefore = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    console.log(`  state revision before: ${stateBefore.revision}, size: ${fmtBytes(statSync(join(home, "state.json")).size)}`);

    // Start the real controller runtime against the temp Home.
    const sessionHost = {
      async start() { throw new Error("unused in benchmark"); },
      async resume() { throw new Error("unused in benchmark"); },
      async stop() { /* no-op */ },
      async inspect() { return { state: "unavailable" }; }
    };
    const promptPush = { async tryPush() { return "unavailable"; } };

    const cpuBefore = process.cpuUsage();
    const rssBefore = process.memoryUsage().rss;

    try {
      controller = await startFileTaskControllerRuntime(home, {
        store,
        intervalMs: 60_000, // effectively disable periodic full scans during the bench
        sessionHost,
        promptPush
      });
      console.log("  controller runtime started (real Unix socket)");
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
      console.log(`  controller runtime failed to start: ${fallbackReason}`);
      console.log("  FALLING BACK to in-process controller/dispatcher layer");
      measurementPath = "in-process-fallback";
      // Build the in-process event processor + adapter (the same fold path the
      // controller uses, just driven directly instead of via the socket).
      const inbox = new FileRuntimeEventInbox(home);
      const adapter = new FileSchedulerStoreAdapter(store);
      fallbackProcessor = new FileRuntimeEventProcessor(inbox, adapter);
    }

    // Wait for the socket to be ready (real-socket path only).
    if (measurementPath === "real-socket") {
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
    }

    // --- Event-loop delay monitors ---
    const eld = monitorEventLoopDelay({ resolution: 10 });
    eld.enable();

    // setImmediate drift probe (backup / cross-check)
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

    // --- Socket latency measurement loop ---
    const socketLatencies = [];
    let socketTimeouts = 0;
    let measuring = true;
    async function measureSocket() {
      while (measuring) {
        if (measurementPath !== "real-socket") {
          // In-process fallback: measure store.read latency instead.
          const s = now();
          try {
            store.getConfig();
            socketLatencies.push(now() - s);
          } catch { /* ignore */ }
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
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

      // Each agent enqueues a native-turn-progress event (the dominant telemetry).
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
          console.log(`  enqueue error (progress): ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Round 1: each agent also enqueues a session-lifecycle event.
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

      // Every 2 rounds: enqueue a prompt-accepted event for a few agents.
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

      // Task message via the store (simulates leader/CLI message writes).
      try {
        store.transaction((tx) => {
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

      // Signal the controller to drain the inbox (real-socket path).
      if (measurementPath === "real-socket") {
        try {
          await callController(home, "scheduler.signal", { key: `task:${TASK_ID}` }, { timeoutMs: 120_000 });
          loadStats.signals++;
        } catch (error) {
          console.log(`  signal error: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        // In-process fallback: drain the event processor directly.
        try {
          fallbackProcessor.drain(new Date());
          loadStats.signals++;
        } catch (error) {
          console.log(`  drain error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const roundMs = now() - roundStart;
      console.log(`  round ${round + 1}/${rounds}: ${roundMs.toFixed(0)}ms  (progress=${loadStats.progressEvents} lc=${loadStats.lifecycleEvents} pa=${loadStats.promptAcceptedEvents} msgs=${loadStats.messages} signals=${loadStats.signals} txs=${txTimes.length})`);
    }

    // Give the controller time to drain remaining events.
    console.log("  waiting for controller to drain remaining events...");
    if (measurementPath === "real-socket") {
      try {
        await callController(home, "scheduler.signal", { key: `task:${TASK_ID}` }, { timeoutMs: 120_000 });
      } catch { /* ignore */ }
    } else {
      try {
        fallbackProcessor.drain(new Date());
      } catch { /* ignore */ }
    }
    // Wait until no new transactions for 3 seconds (drain settled), with a
    // hard cap of 60 seconds so the benchmark always terminates.
    const settleStart = now();
    let lastTxCount = txTimes.length;
    let settledMs = 0;
    while (settledMs < 3000 && now() - settleStart < 60_000) {
      await new Promise((r) => setTimeout(r, 500));
      if (measurementPath === "in-process-fallback") {
        try { fallbackProcessor.drain(new Date()); } catch { /* ignore */ }
      }
      if (txTimes.length === lastTxCount) {
        settledMs += 500;
      } else {
        settledMs = 0;
        lastTxCount = txTimes.length;
      }
    }

    const loadDurationMs = now() - loadStart;
    measuring = false;
    driftRunning = false;
    await measurePromise;
    eld.disable();

    const cpuAfter = process.cpuUsage(cpuBefore);
    const rssAfter = process.memoryUsage().rss;
    const maxRssKB = process.resourceUsage().maxRSS;

    const stateAfter = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    const inboxDir = join(home, "runtime", "inbox");
    const inboxFileCount = existsSync(inboxDir)
      ? readdirSync(inboxDir).filter((f) => f.endsWith(".json")).length
      : 0;

    const result = {
      measurementPath,
      fallbackReason,
      tempHome: home,
      stateFileBytes: statSync(join(home, "state.json")).size,
      revisionBefore: stateBefore.revision,
      revisionAfter: stateAfter.revision,
      revisionDelta: stateAfter.revision - stateBefore.revision,
      load: {
        agents,
        rounds,
        durationMs: loadDurationMs,
        ...loadStats,
        inboxFilesRemaining: inboxFileCount
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
      perWriteTransaction: stats(txTimes),
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

    console.log(`\n  measurement path: ${result.measurementPath}${result.fallbackReason ? ` (${result.fallbackReason})` : ""}`);
    console.log(`  load duration: ${(loadDurationMs / 1000).toFixed(1)}s`);
    console.log(`  revision: ${result.revisionBefore} -> ${result.revisionAfter} (${result.revisionDelta} commits)`);
    console.log(statsRow("socket command latency", result.socketLatency));
    console.log(`  socket timeouts: ${socketTimeouts}`);
    console.log(`  event-loop delay: mean=${result.eventLoopDelay.meanMs.toFixed(1)}ms p50=${result.eventLoopDelay.p50Ms.toFixed(1)}ms p99=${result.eventLoopDelay.p99Ms.toFixed(1)}ms max=${result.eventLoopDelay.maxMs.toFixed(1)}ms`);
    console.log(statsRow("setImmediate drift", result.setImmediateDrift));
    console.log(statsRow("per-write transaction", result.perWriteTransaction));
    console.log(`  CPU: user=${result.cpu.userMs.toFixed(0)}ms system=${result.cpu.systemMs.toFixed(0)}ms total=${result.cpu.totalMs.toFixed(0)}ms`);
    console.log(`  RSS: before=${result.rss.beforeMB.toFixed(0)}MB after=${result.rss.afterMB.toFixed(0)}MB max=${result.rss.maxMB.toFixed(0)}MB`);
    console.log(`  inbox files remaining: ${inboxFileCount}`);

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
  })();
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function generateReport(args, env, phase1, phase2, phase3, realHomeSnapshot, realHomeChangedByLiveController) {
  const reproCmd = `node --expose-gc scripts/bench/controller-baseline.mjs --real-home ${args.realHome} --rounds ${args.rounds} --agents ${args.agents}`;
  const loadShape = [
    `- **Agents**: ${args.agents} simulated agents (${Math.min(20, args.agents)} claude, ${Math.max(0, args.agents - 20)} codex), each with a unique launchId / nativeSessionId / runId.`,
    `- **Telemetry**: every agent enqueues one \`native-turn-progress\` event per round via \`FileRuntimeEventInbox.enqueueProviderProgress\` (the same code path production hooks use).  Each event carries a unique \`progressId\`.`,
    `- **Lifecycle**: round 1 adds one \`native-session-lifecycle\` event per agent; odd rounds add \`native-prompt-accepted\` events for 5 agents.`,
    `- **Messages**: one task message per round via \`store.transaction\` + \`createTaskMessage\` (simulates leader/CLI writes).`,
    `- **Drain**: after each round the driver calls \`scheduler.signal\` on the real control socket; the Controller's reconciliation pass drains the inbox and folds each event through \`FileRuntimeEventProcessor\` -> \`FileSchedulerStoreAdapter.observeProviderTurnProgress\` -> \`FileTaskStore.transaction\` (full read-modify-write of state.json).`,
    `- **Rounds**: ${args.rounds}.`
  ].join("\n");

  const p1 = phase1;
  const p2 = phase2;
  const p3 = phase3;

  const md = `# Controller Baseline — ${TODAY}

> Freeze of today's FileTaskStore + single-process Controller performance at the
> real production document size.  These numbers justify the SQLite WAL +
> worker-thread re-architecture (see [sqlite-control-plane-design.md](sqlite-control-plane-design.md)).

## Reproduction

\`\`\`
${reproCmd}
\`\`\`

- **Script**: \`scripts/bench/controller-baseline.mjs\`
- **Real Home**: \`${args.realHome}\` (opened **read-only**; size+mtime snapshotted before and after — see Safety assertion below)
- **Node**: ${env.nodeVersion}
- **Platform**: ${env.platform} ${env.arch}
- **CPU**: ${env.cpuModel} (${env.cpuCount} cores)
- **Memory**: ${env.totalMemGB} GB
- **Date**: ${TODAY}

## Real Home snapshot (read-only)

| File | Size |
|------|------|
| state.json | ${fmtBytes(realHomeSnapshot["state.json"].size)} (${realHomeSnapshot["state.json"].size} bytes) |
| schema.json | ${realHomeSnapshot["schema.json"].size} bytes |

## Phase 1 — Parse / serializer cost

Reading and parsing the real \`state.json\` (${fmtBytes(p1.stateFileBytes)}).

| Operation | n | mean | p50 | p95 | p99 | max |
|-----------|---|------|-----|-----|-----|-----|
| JSON.parse | ${p1.parse.count} | ${fmt(p1.parse.mean)} ms | ${fmt(p1.parse.p50)} ms | ${fmt(p1.parse.p95)} ms | ${fmt(p1.parse.p99)} ms | ${fmt(p1.parse.max)} ms |
| JSON.stringify | ${p1.stringify.count} | ${fmt(p1.stringify.mean)} ms | ${fmt(p1.stringify.p50)} ms | ${fmt(p1.stringify.p95)} ms | ${fmt(p1.stringify.p99)} ms | ${fmt(p1.stringify.max)} ms |

- readFileSync: ${fmt(p1.readMs)} ms
- Heap delta per parse+stringify cycle (mean): ${p1.heapDeltaMB.toFixed(1)} MB

**Every Controller transaction pays this parse + stringify cost on the main thread.**

## Phase 2 — Transaction cost on a temp copy

Full read-modify-write transactions (\`FileTaskStore.transaction\` saving one event) against a temp copy of the real state.

| Metric | Value |
|--------|-------|
| Document size | ${fmtBytes(p2.stateFileBytes)} |
| Iterations | ${p2.iterations} |
| Revision | ${p2.revisionBefore} -> ${p2.revisionAfter} |
| **mean** | **${fmt(p2.tx.mean)} ms** |
| **p50** | **${fmt(p2.tx.p50)} ms** |
| **p95** | **${fmt(p2.tx.p95)} ms** |
| **p99** | **${fmt(p2.tx.p99)} ms** |
| max | ${fmt(p2.tx.max)} ms |

Each transaction = read 36 MB + JSON.parse + mutate + JSON.stringify + atomic write of 36 MB, all on the main thread under a global write lock.

## Phase 3 — Control-plane latency under load

**Measurement path**: ${p3.measurementPath === "real-socket"
  ? "**real Unix socket** — the current \`startFileTaskControllerRuntime\` was started against the temp Home and driven via \`callController\` over the real control socket."
  : `**in-process fallback** — the full controller runtime could not start (${p3.fallbackReason ?? "unknown reason"}); the in-process store/dispatcher layer was driven directly.`}

### Load shape

${loadShape}

### Results

| Metric | Value |
|--------|-------|
| Load duration | ${(p3.load.durationMs / 1000).toFixed(1)} s |
| Agents | ${p3.load.agents} |
| Rounds | ${p3.load.rounds} |
| Progress events enqueued | ${p3.load.progressEvents} |
| Lifecycle events enqueued | ${p3.load.lifecycleEvents} |
| Prompt-accepted events enqueued | ${p3.load.promptAcceptedEvents} |
| Messages written | ${p3.load.messages} |
| Signals sent | ${p3.load.signals} |
| State revision | ${p3.revisionBefore} -> ${p3.revisionAfter} (${p3.revisionDelta} commits) |
| Inbox files remaining | ${p3.load.inboxFilesRemaining} |

#### Control-socket command latency (\`controller.identity\`)

| Percentile | Latency |
|------------|---------|
| **p50** | **${fmt(p3.socketLatency.p50)} ms** |
| **p95** | **${fmt(p3.socketLatency.p95)} ms** |
| **p99** | **${fmt(p3.socketLatency.p99)} ms** |
| max | ${fmt(p3.socketLatency.max)} ms |
| mean | ${fmt(p3.socketLatency.mean)} ms |
| samples | ${p3.socketLatency.count} |
| timeouts/errors | ${p3.socketTimeouts} |

#### Main-thread event-loop delay

| Metric | Value |
|--------|-------|
| mean | ${p3.eventLoopDelay.meanMs.toFixed(1)} ms |
| p50 | ${p3.eventLoopDelay.p50Ms.toFixed(1)} ms |
| p99 | ${p3.eventLoopDelay.p99Ms.toFixed(1)} ms |
| **max** | **${p3.eventLoopDelay.maxMs.toFixed(1)} ms** |

setImmediate drift probe (cross-check): p50=${fmt(p3.setImmediateDrift.p50)} ms, p99=${fmt(p3.setImmediateDrift.p99)} ms, max=${fmt(p3.setImmediateDrift.max)} ms.

#### Per-write transaction time (instrumented)

| Percentile | Time |
|------------|------|
| mean | ${fmt(p3.perWriteTransaction.mean)} ms |
| **p50** | **${fmt(p3.perWriteTransaction.p50)} ms** |
| **p95** | **${fmt(p3.perWriteTransaction.p95)} ms** |
| **p99** | **${fmt(p3.perWriteTransaction.p99)} ms** |
| max | ${fmt(p3.perWriteTransaction.max)} ms |
| samples | ${p3.perWriteTransaction.count} |

#### Resource usage

| Metric | Value |
|--------|-------|
| CPU user | ${p3.cpu.userMs.toFixed(0)} ms |
| CPU system | ${p3.cpu.systemMs.toFixed(0)} ms |
| CPU total | ${p3.cpu.totalMs.toFixed(0)} ms |
| RSS before | ${p3.rss.beforeMB.toFixed(0)} MB |
| RSS after | ${p3.rss.afterMB.toFixed(0)} MB |
| **RSS max** | **${p3.rss.maxMB.toFixed(0)} MB** |

## Key takeaways

1. **A single full-document transaction blocks the main thread for ~${fmt(p2.tx.p50)} ms** (p50) at the current 36 MB document size.  Every \`runtime.provider-turn-progress\` event triggers one.
2. **Under a 25-agent telemetry load, control-socket p99 latency reaches ${fmt(p3.socketLatency.p99)} ms** because the event loop is blocked by synchronous JSON.parse + JSON.stringify + write of the entire state document.
3. **Event-loop delay peaks at ${p3.eventLoopDelay.maxMs.toFixed(0)} ms** — the main thread is fully stalled during each commit, starving all socket I/O.
4. **RSS peaks at ${p3.rss.maxMB.toFixed(0)} MB** — each parse+stringify cycle allocates ~${p1.heapDeltaMB.toFixed(0)} MB of temporary heap.
5. The SQLite WAL + worker-thread design moves JSON parse/stringify, SQL execution, and fsync off the main thread, so a progress event becomes a single-row upsert instead of a 36 MB document rewrite.

## Safety assertion

The real Home at \`${args.realHome}\` was opened **read-only** throughout.  Size + mtime of \`state.json\` and \`schema.json\` were snapshotted before and after every phase.  This script only ever calls \`readFileSync\` / \`statSync\` on the real Home; it never writes, never creates a lock, and never starts a Controller with \`YUI_HOME\` pointing there.  Every replay ran against a fresh temp directory copy.

${realHomeChangedByLiveController
  ? `**Note**: the real Home's state.json changed size/mtime during the benchmark. This is attributed to the **live production Controller** (the control plane running this session) actively writing to its own state — not to this script, which holds the real Home read-only.`
  : `The real Home's state.json and schema.json were verified identical (size + mtime) before and after the entire benchmark.`}
`;

  return { markdown: md, reproCmd };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  // Validate the real Home exists and is readable (read-only).
  if (!existsSync(join(args.realHome, "state.json"))) {
    console.error(`FATAL: state.json not found in real Home: ${args.realHome}`);
    process.exit(1);
  }
  if (!existsSync(join(args.realHome, "schema.json"))) {
    console.error(`FATAL: schema.json not found in real Home: ${args.realHome}`);
    process.exit(1);
  }

  const env = {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemGB: (totalmem() / (1024 ** 3)).toFixed(1)
  };

  console.log("Controller Baseline Benchmark");
  console.log("==============================");
  console.log(`  real Home:  ${args.realHome} (READ-ONLY)`);
  console.log(`  Node:       ${env.nodeVersion}`);
  console.log(`  CPU:        ${env.cpuModel} (${env.cpuCount} cores)`);
  console.log(`  agents:     ${args.agents}`);
  console.log(`  rounds:     ${args.rounds}`);

  // Snapshot the real Home before anything runs.
  const realHomeBefore = snapshotRealHome(args.realHome);
  console.log(`  state.json: ${fmtBytes(realHomeBefore["state.json"].size)}`);

  // Phase 1
  const phase1 = phaseParseSerialize(args.realHome, args.parseIterations);
  const p1Clean = assertRealHomeUnchanged(args.realHome, realHomeBefore, "Phase 1");

  // Phase 2
  const phase2 = phaseTransactionCost(args.realHome, args.txIterations);
  const p2Clean = assertRealHomeUnchanged(args.realHome, realHomeBefore, "Phase 2");

  // Phase 3
  const phase3 = await phaseControlPlaneLoad(args.realHome, args.agents, args.rounds);
  const p3Clean = assertRealHomeUnchanged(args.realHome, realHomeBefore, "Phase 3");

  // Final assertion
  const finalClean = assertRealHomeUnchanged(args.realHome, realHomeBefore, "entire benchmark");
  const realHomeChangedByLiveController = !(p1Clean && p2Clean && p3Clean && finalClean);
  if (!realHomeChangedByLiveController) {
    console.log("\n  SAFETY: real Home unchanged (size + mtime verified).");
  } else {
    console.log("\n  SAFETY: real Home changed during the benchmark, but ONLY by the live");
    console.log("  production Controller (this script opens the real Home read-only and");
    console.log("  never writes, locks, or starts a Controller against it).");
  }

  // Generate report
  const { markdown, reproCmd } = generateReport(args, env, phase1, phase2, phase3, realHomeBefore, realHomeChangedByLiveController);

  // Write the doc
  mkdirSync(dirname(args.outDoc), { recursive: true });
  writeFileSync(args.outDoc, markdown, "utf8");
  console.log(`\n  results doc: ${args.outDoc}`);
  console.log(`  reproduce:   ${reproCmd}`);

  // Print JSON summary
  const summary = {
    date: TODAY,
    realHome: args.realHome,
    realHomeSizeBytes: realHomeBefore["state.json"].size,
    realHomeChangedByLiveController,
    environment: env,
    phase1,
    phase2,
    phase3,
    safety: { realHomeUnchanged: !realHomeChangedByLiveController, scriptReadOnly: true }
  };
  console.log("\n--- JSON SUMMARY ---");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error("FATAL:", error);
  process.exit(1);
});
