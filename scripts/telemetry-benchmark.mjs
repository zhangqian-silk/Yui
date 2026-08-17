#!/usr/bin/env node
/**
 * Issue 09 acceptance benchmark — 25-Agent progress burst.
 *
 * Compares the legacy lane (every provider progress observation appended to
 * semantic Task events in a File store) with the bounded lane (observations
 * upserted into the telemetry sidecar): write volume, on-disk size, and
 * repeated read ("command") latency.
 *
 * Usage: node scripts/telemetry-benchmark.mjs [agents] [observationsPerAgent]
 * Defaults: 25 agents, 100 observations each (2,500 total).
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileTaskStore } from "../dist/storage/taskStore.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { createTask } from "../dist/task/task.js";
import { createTaskEvent } from "../dist/event/taskEvent.js";
import { SqliteTelemetryStore } from "../dist/telemetry/sqliteTelemetryStore.js";

const AGENTS = Number(process.argv[2] ?? 25);
const OBSERVATIONS = Number(process.argv[3] ?? 100);
const TOTAL = AGENTS * OBSERVATIONS;

function temporaryHome(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function percentile(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function progressPayload(runId, progressId, sequence, progressAt) {
  return {
    eventId: `event-${progressId}`,
    roleName: "leader",
    agentId: "codex",
    adapterId: "codex",
    launchId: `launch-${runId}`,
    nativeSessionId: `session-${runId}`,
    runId,
    progressId,
    progressAt,
    sequence: String(sequence)
  };
}

async function main() {
  const base = Date.parse("2026-08-17T00:00:00.000Z");

  // -- Legacy lane: semantic event appends in the File store --------------------
  const legacyHome = temporaryHome("yui-bench-legacy-");
  ensureStorageSchema(legacyHome);
  const legacyStore = new FileTaskStore(legacyHome);
  const now = new Date(base);
  for (let i = 1; i <= AGENTS; i++) {
    legacyStore.saveTask(createTask(`task-${i}`, `Bench ${i}`, now));
  }
  const legacyAppendLatencies = [];
  const legacyStart = process.hrtime.bigint();
  for (let agent = 1; agent <= AGENTS; agent++) {
    const taskId = `task-${agent}`;
    const runId = `run-${agent}`;
    for (let obs = 1; obs <= OBSERVATIONS; obs++) {
      const progressAt = new Date(base + ((agent - 1) * OBSERVATIONS + obs) * 1000).toISOString();
      const t0 = process.hrtime.bigint();
      legacyStore.saveEvent(taskId, createTaskEvent(
        legacyStore.nextEventId(taskId),
        taskId,
        "runtime.provider-turn-progress",
        progressPayload(runId, `progress-${agent}-${obs}`, obs, progressAt),
        new Date(progressAt)
      ));
      legacyAppendLatencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  }
  const legacyWriteMs = Number(process.hrtime.bigint() - legacyStart) / 1e6;
  const legacyStateBytes = statSync(join(legacyHome, "state.json")).size;

  // Legacy read latency: scan a Task's events for the latest progress per Run.
  const legacyReadLatencies = [];
  for (let rep = 0; rep < 50; rep++) {
    const t0 = process.hrtime.bigint();
    for (let agent = 1; agent <= AGENTS; agent++) {
      let latest = 0;
      for (const event of legacyStore.listEvents(`task-${agent}`)) {
        if (event.type !== "runtime.provider-turn-progress") continue;
        const at = Date.parse(event.payload.progressAt);
        if (at > latest) latest = at;
      }
      if (latest === 0) throw new Error("missing progress");
    }
    legacyReadLatencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  // -- Bounded lane: sidecar upserts -------------------------------------------
  const boundedHome = temporaryHome("yui-bench-bounded-");
  ensureStorageSchema(boundedHome);
  const telemetry = new SqliteTelemetryStore(boundedHome, {
    mode: "bounded",
    terminalKeep: 200,
    runCap: 50_000
  });
  const boundedObserveLatencies = [];
  const boundedStart = process.hrtime.bigint();
  for (let agent = 1; agent <= AGENTS; agent++) {
    const taskId = `task-${agent}`;
    const runId = `run-${agent}`;
    for (let obs = 1; obs <= OBSERVATIONS; obs++) {
      const progressAt = new Date(base + ((agent - 1) * OBSERVATIONS + obs) * 1000).toISOString();
      const t0 = process.hrtime.bigint();
      telemetry.observe({
        taskId,
        roleName: "leader",
        runId,
        generation: `launch-${runId}`,
        progressId: `progress-${agent}-${obs}`,
        sequence: obs,
        payload: progressPayload(runId, `progress-${agent}-${obs}`, obs, progressAt),
        receivedAt: progressAt
      });
      boundedObserveLatencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  }
  const boundedObserveMs = Number(process.hrtime.bigint() - boundedStart) / 1e6;
  const flushStart = process.hrtime.bigint();
  await telemetry.flush();
  const boundedFlushMs = Number(process.hrtime.bigint() - flushStart) / 1e6;
  const boundedDbBytes = statSync(join(boundedHome, "telemetry.db")).size
    + (existsSync(join(boundedHome, "telemetry.db-wal"))
      ? statSync(join(boundedHome, "telemetry.db-wal")).size
      : 0);
  const health = telemetry.health();

  // Bounded read latency: count + aggregate per Task.
  const boundedReadLatencies = [];
  for (let rep = 0; rep < 50; rep++) {
    const t0 = process.hrtime.bigint();
    for (let agent = 1; agent <= AGENTS; agent++) {
      const count = telemetry.count(`task-${agent}`);
      const aggregate = telemetry.aggregate(`task-${agent}`, `run-${agent}`);
      if (count !== OBSERVATIONS || aggregate?.count !== OBSERVATIONS) {
        throw new Error(`unexpected telemetry state for task-${agent}`);
      }
    }
    boundedReadLatencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  await telemetry.close();

  const report = {
    agents: AGENTS,
    observationsPerAgent: OBSERVATIONS,
    totalObservations: TOTAL,
    legacy: {
      semanticEvents: TOTAL,
      writeMs: round(legacyWriteMs),
      appendP50Ms: round(percentile(legacyAppendLatencies, 0.5)),
      appendP99Ms: round(percentile(legacyAppendLatencies, 0.99)),
      stateJsonBytes: legacyStateBytes,
      readP50Ms: round(percentile(legacyReadLatencies, 0.5)),
      readP99Ms: round(percentile(legacyReadLatencies, 0.99))
    },
    bounded: {
      sidecarRows: health.rows,
      dropped: health.dropped,
      coalesced: health.coalesced,
      observeMs: round(boundedObserveMs),
      flushMs: round(boundedFlushMs),
      telemetryDbBytes: boundedDbBytes,
      readP50Ms: round(percentile(boundedReadLatencies, 0.5)),
      readP99Ms: round(percentile(boundedReadLatencies, 0.99))
    }
  };
  console.log(JSON.stringify(report, null, 2));

  rmSync(legacyHome, { recursive: true, force: true });
  rmSync(boundedHome, { recursive: true, force: true });
}

function round(value) {
  return Math.round(value * 100) / 100;
}

await main();
