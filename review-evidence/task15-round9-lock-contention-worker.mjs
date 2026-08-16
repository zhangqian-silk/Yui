import { appendFileSync } from "node:fs";
import { acquireWorkflowFileLock } from "../dist/release/workflowFileLock.js";

// round9 P2 lock-contention worker: acquire the stale lock, log the hold
// interval, hold for a fixed duration, then release. Three of these run
// concurrently against one stale lock; the test verifies no two workers
// ever held the lock at the same time.

const [root, taskId, workflowId, logPath, holdMs] = process.argv.slice(2);
if (root === undefined || taskId === undefined || workflowId === undefined || logPath === undefined) {
  throw new Error("lock contention worker requires root, taskId, workflowId, logPath, [holdMs]");
}

const hold = Number(holdMs ?? 100);
const release = await acquireWorkflowFileLock(root, taskId, workflowId, { timeoutMs: 10_000 });
const start = Date.now();
appendFileSync(logPath, `acquire ${process.pid} ${start}\n`);
await new Promise((resolve) => setTimeout(resolve, hold));
const end = Date.now();
appendFileSync(logPath, `release ${process.pid} ${end}\n`);
release();
process.stdout.write(`done ${process.pid}\n`);
