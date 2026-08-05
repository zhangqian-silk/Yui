/**
 * Child-process worker for the F4 truly-concurrent stale-fence reclaim race test
 * (test/storage-upgrade-review-round1-regressions.test.js).
 *
 * Each worker:
 *   1. writes a `waiting.<pid>` marker so the parent knows it has reached the gate,
 *   2. busy-waits on a shared barrier file so ALL workers are released at once
 *      (a genuine race, not a sequential simulation),
 *   3. attempts `placeUpgradeFence` against a pre-seeded dead-owner stale fence,
 *   4. writes its result ({ pid, acquired, error }) atomically and exits.
 *
 * Usage: node fence-race-runner.mjs <home> <startBarrier> <resultPath> <waitDir>
 */
import { existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [home, startBarrier, resultPath, waitDir] = process.argv.slice(2);

async function main() {
  // Resolve the built fence module relative to this file's project root.
  const fenceUrl = pathToFileURL(
    join(process.cwd(), "dist", "storage", "upgradeFence.js")
  ).href;
  const { placeUpgradeFence } = await import(fenceUrl);

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
    placeUpgradeFence(home, {
      reason: `worker ${process.pid}`,
      createdAt: new Date(0).toISOString(),
      ownerPid: process.pid
    });
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
