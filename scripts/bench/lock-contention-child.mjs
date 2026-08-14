#!/usr/bin/env node
// lock-contention-child.mjs — child process for the cross-process lock contention probe.
//
// Opens a FileTaskStore against a temp Home copy and does M transactions
// (saveEvent, same shape as Phase 2), retrying on StorageConflictError
// (lock timeout or revision mismatch).  Prints one JSON line per transaction
// to stdout for the parent to aggregate.
//
// Usage:
//   node scripts/bench/lock-contention-child.mjs \
//     --home <temp-home> --iterations <n> --child-id <n>

import { performance } from "node:perf_hooks";
import { FileTaskStore, StorageConflictError } from "../../dist/storage/taskStore.js";

function parseArgs(argv) {
  const args = { home: null, iterations: 2, childId: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home") args.home = argv[++i];
    else if (a === "--iterations") args.iterations = parseInt(argv[++i], 10);
    else if (a === "--child-id") args.childId = parseInt(argv[++i], 10);
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.home) {
  console.error("FATAL: --home is required");
  process.exit(1);
}

const store = new FileTaskStore(args.home);
const taskId = "task-4";
const MAX_ATTEMPTS = 15;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

for (let i = 0; i < args.iterations; i++) {
  const start = performance.now();
  let lockTimeouts = 0;
  let revisionConflicts = 0;
  let success = false;
  let attempt = 0;

  while (!success && attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      store.transaction((tx) => {
        const id = tx.nextEventId(taskId);
        tx.saveEvent(taskId, {
          schemaVersion: 2,
          id,
          taskId,
          type: "bench.lock-contention",
          payload: {
            child: String(args.childId),
            iteration: String(i + 1),
            attempt: String(attempt)
          },
          createdAt: new Date().toISOString()
        });
      });
      success = true;
    } catch (error) {
      if (error instanceof StorageConflictError) {
        if (error.message.includes("Timed out waiting for storage lock")) {
          lockTimeouts++;
        } else {
          revisionConflicts++;
        }
        // Jittered back-off before retry to avoid thundering herd.
        sleep(50 + Math.floor(Math.random() * 100));
      } else {
        // Unexpected error — record and rethrow.
        console.log(JSON.stringify({
          childId: args.childId,
          iteration: i + 1,
          wallMs: performance.now() - start,
          lockTimeouts,
          revisionConflicts,
          attempts: attempt,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }));
        throw error;
      }
    }
  }

  console.log(JSON.stringify({
    childId: args.childId,
    iteration: i + 1,
    wallMs: performance.now() - start,
    lockTimeouts,
    revisionConflicts,
    attempts: attempt,
    success
  }));
}

process.exit(0);
