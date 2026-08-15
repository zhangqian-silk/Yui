/**
 * Child-process worker for the project maintenance lock stale-reclaim race
 * (test/core/project-maintenance-fence-round6.test.js).
 *
 * Each worker:
 *   1. writes a `waiting.<pid>` marker so the parent knows it has reached the gate,
 *   2. busy-waits on a shared barrier file so ALL workers are released at once
 *      (a genuine race, not a sequential simulation),
 *   3. attempts `acquireProjectMaintenanceLock` against a pre-seeded dead-owner
 *      stale lock,
 *   4. writes its result ({ pid, acquired, error }) atomically and exits.
 *
 * The winner holds the lock without releasing: a released lock could let a
 * still-spinning loser acquire second in the same round, which would defeat
 * the at-most-one-holder assertion. The parent cleans up the whole home.
 *
 * Usage: node project-lock-race-runner.mjs <home> <projectId> <startBarrier> <resultPath> <waitDir>
 */
import { existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [home, projectId, startBarrier, resultPath, waitDir] = process.argv.slice(2);

async function main() {
  // Resolve the built lock module relative to this file's project root.
  const lockUrl = pathToFileURL(
    join(process.cwd(), "dist", "repository", "projectMaintenanceLock.js")
  ).href;
  const { acquireProjectMaintenanceLock } = await import(lockUrl);

  // 1) Announce arrival at the gate.
  writeFileSync(join(waitDir, `waiting.${process.pid}`), "1");

  // 2) Busy-wait on the barrier so all workers race simultaneously.
  const deadline = Date.now() + 10000;
  while (!existsSync(startBarrier)) {
    if (Date.now() > deadline) break;
    // Tight spin with a tiny yield.
    await new Promise((r) => setImmediate(r));
  }

  // 3) Race to acquire.
  let result;
  try {
    acquireProjectMaintenanceLock(home, projectId);
    result = { pid: process.pid, acquired: true };
  } catch (error) {
    result = { pid: process.pid, acquired: false, error: String(error && error.message) };
  }

  // 4) Write the result atomically (temp + rename) so the parent never reads a
  // partial file.
  const tmp = `${resultPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(result));
  renameSync(tmp, resultPath);
}

main().then(
  () => process.exit(0),
  (error) => {
    try {
      writeFileSync(resultPath, JSON.stringify({ pid: process.pid, acquired: false, error: String(error) }));
    } catch { /* ignore */ }
    process.exit(1);
  }
);
