import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ensureStorageSchema,
  CURRENT_STORAGE_LAYOUT_VERSION,
  CURRENT_AGGREGATE_SCHEMA_VERSION
} from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { MigrationRegistry } from "../dist/storage/migration/index.js";
import { currentRecordVersions } from "../dist/storage/upgrade/recordVersions.js";
import { runStorageUpgrade } from "../dist/storage/upgrade/upgradeOrchestrator.js";
import { createHomeMigrationTarget } from "../dist/storage/upgrade/homeMigrationTarget.js";
import {
  placeUpgradeFence,
  readUpgradeFence,
  UPGRADE_FENCE_FILE
} from "../dist/storage/upgradeFence.js";
import { readSwitchProgress, writeSwitchProgress } from "../dist/storage/upgrade/switchProgress.js";
import { createUpdatePorts } from "../dist/cli/updatePorts.js";
import { runUpdate } from "../dist/cli/updateOrchestrator.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Isolation: every fixture Home lives under the OS temp dir.
// ---------------------------------------------------------------------------

function currentHome(prefix = "yui-rr1-") {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const home = join(base, "home");
  assert.ok(home.startsWith(tmpdir()), `test Home must be under the temp dir, got ${home}`);
  mkdirSync(home, { recursive: true });
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfig({ ...store.getConfig(), timeZone: "UTC" });
  return { base, home };
}

function migratableSetup() {
  const latest = {
    layout: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregate: CURRENT_AGGREGATE_SCHEMA_VERSION + 1,
    record: currentRecordVersions()
  };
  const registry = new MigrationRegistry();
  registry.register({
    axis: "aggregate",
    fromVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    toVersion: CURRENT_AGGREGATE_SCHEMA_VERSION + 1,
    preconditions: () => {},
    transform: (snapshot) => ({
      schemaManifest: { ...snapshot.schemaManifest, aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION },
      state: snapshot.state
    }),
    declaredEffects: []
  });
  return { latest, registry };
}

// ===========================================================================
// F1 — the staging basename is no longer excluded from every Home entry: a
// legit Home entry named like the staging dir survives the complete copy.
// ===========================================================================

test("F1 positive: a Home entry named like the staging dir basename is preserved", async () => {
  const { home } = currentHome("yui-rr1-f1-");
  // Production staging path is the sibling `${home}.upgrade-staging`; its basename
  // is `home.upgrade-staging`. A legit Home entry with that SAME name must survive.
  const collidingDir = join(home, "home.upgrade-staging");
  mkdirSync(collidingDir, { recursive: true });
  writeFileSync(join(collidingDir, "must-survive.txt"), "keep me\n");
  // Also a plain colliding file at the top level for good measure.
  writeFileSync(join(home, "home.upgrade-staging.txt"), "also keep\n");

  const { latest, registry } = migratableSetup();
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {},
    now: () => new Date("2026-08-06T12:00:00.000Z")
  });
  assert.equal(result.outcome, "upgraded");
  assert.equal(
    readFileSync(join(home, "home.upgrade-staging", "must-survive.txt"), "utf8"),
    "keep me\n",
    "the colliding-name directory entry must NOT be dropped (F1)"
  );
  assert.equal(readFileSync(join(home, "home.upgrade-staging.txt"), "utf8"), "also keep\n");
});

test("F1 unit: writeFreshOutput copies a colliding-name entry into staging", () => {
  const { home } = currentHome("yui-rr1-f1u-");
  const collidingDir = join(home, "home.upgrade-staging");
  mkdirSync(collidingDir, { recursive: true });
  writeFileSync(join(collidingDir, "keep.txt"), "x\n");
  const stagingPath = `${home}.upgrade-staging`;
  const target = createHomeMigrationTarget({ home, latest: migratableSetup().latest, stagingPath });
  target.writeFreshOutput(target.readSource());
  assert.equal(
    readFileSync(join(stagingPath, "home.upgrade-staging", "keep.txt"), "utf8"),
    "x\n",
    "colliding entry copied into staging"
  );
  target.discardFreshOutput();
});

test("F1 negative: a staging path INSIDE the Home is refused at construction", () => {
  const { home } = currentHome("yui-rr1-f1n-");
  assert.throws(
    () => createHomeMigrationTarget({
      home,
      latest: migratableSetup().latest,
      stagingPath: join(home, "nested-staging")
    }),
    /must not be inside the Home/i
  );
});

// ===========================================================================
// F2 — every op after the first rename is phase-aware: an fsync/marker failure
// around the renames never collapses into a false "source unchanged".
// ===========================================================================

test("F2 positive: a clean switch still succeeds and clears the marker", async () => {
  const { home } = currentHome("yui-rr1-f2p-");
  const { latest, registry } = migratableSetup();
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {},
    now: () => new Date("2026-08-06T12:00:00.000Z")
  });
  assert.equal(result.outcome, "upgraded");
  assert.equal(readSwitchProgress(home), null);
});

test("F2 negative: post-backup fsync failure rolls back and reports source unchanged (not ambiguous)", () => {
  // The post-backup fsync fails but the rollback (backup -> home) succeeds, so the
  // Home ends up intact — a clean pre-switch failure, NOT a claimed switch.
  const { home } = currentHome("yui-rr1-f2a-");
  const { latest } = migratableSetup();
  const originalState = readFileSync(join(home, "state.json"), "utf8");
  const stagingPath = `${home}.upgrade-staging`;
  const target = createHomeMigrationTarget({
    home, latest, stagingPath,
    now: () => new Date("2026-08-06T12:00:00.000Z"),
    switchFaultHook: (step) => { if (step === "post-backup-fsync") throw new Error("injected fsync fault"); }
  });
  target.writeFreshOutput(target.readSource());
  assert.throws(() => target.atomicSwitchWithBackup(), /injected fsync fault/);
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), originalState, "rollback restored original");
  assert.equal(readSwitchProgress(home), null, "clean rollback clears the marker");
  target.discardFreshOutput();
});

test("F2 negative: post-backup fsync failure + failed rollback is AmbiguousSwitchError (interrupted)", () => {
  // The fsync after `home -> backup` fails AND the rollback rename also fails:
  // the Home is genuinely partially switched — must be ambiguous, never "unchanged".
  const { home } = currentHome("yui-rr1-f2b-");
  const { latest } = migratableSetup();
  const stagingPath = `${home}.upgrade-staging`;
  const target = createHomeMigrationTarget({
    home, latest, stagingPath,
    now: () => new Date("2026-08-06T12:00:00.000Z"),
    switchFaultHook: (step) => { if (step === "post-backup-fsync") throw new Error("injected fsync fault"); },
    renameImpl: (from, to) => {
      // Let the first rename (home -> backup) through, fail the rollback (backup -> home).
      if (from.endsWith(".upgrade-staging") || from.includes(".backup-")) {
        throw new Error("injected rollback rename fault");
      }
      // default: real rename for home -> backup
      throw new Error("unexpected rename");
    }
  });
  // The first rename (home->backup) is the built-in renameSync, not promoteRename,
  // so it commits; the fault hook then throws on post-backup-fsync; rollback uses
  // promoteRename which throws -> interrupted.
  target.writeFreshOutput(target.readSource());
  let thrown;
  try { target.atomicSwitchWithBackup(); } catch (e) { thrown = e; }
  assert.ok(thrown, "threw");
  assert.equal(thrown.name, "AmbiguousSwitchError");
  const progress = readSwitchProgress(home);
  assert.ok(progress, "marker present");
  assert.equal(progress.phase, "interrupted");
  target.discardFreshOutput();
});

test("F2 negative: promoting-marker write failure + failed rollback is ambiguous", () => {
  const { home } = currentHome("yui-rr1-f2c-");
  const { latest } = migratableSetup();
  const stagingPath = `${home}.upgrade-staging`;
  const target = createHomeMigrationTarget({
    home, latest, stagingPath,
    now: () => new Date("2026-08-06T12:00:00.000Z"),
    switchFaultHook: (step) => { if (step === "promoting-marker") throw new Error("injected marker fault"); },
    renameImpl: () => { throw new Error("injected rollback fault"); }
  });
  target.writeFreshOutput(target.readSource());
  let thrown;
  try { target.atomicSwitchWithBackup(); } catch (e) { thrown = e; }
  assert.equal(thrown?.name, "AmbiguousSwitchError");
  assert.equal(readSwitchProgress(home)?.phase, "interrupted");
  target.discardFreshOutput();
});

test("F2 negative: post-PROMOTE fsync failure does NOT fail the switch (new Home is correct)", () => {
  // After promotion commits, the new Home is in place. A failing post-promote
  // fsync/marker-clear is best-effort durability, not correctness: the switch
  // still succeeds rather than rolling back a good migrated Home.
  const { home } = currentHome("yui-rr1-f2d-");
  const { latest } = migratableSetup();
  const stagingPath = `${home}.upgrade-staging`;
  const target = createHomeMigrationTarget({
    home, latest, stagingPath,
    now: () => new Date("2026-08-06T12:00:00.000Z"),
    switchFaultHook: (step) => { if (step === "post-promote-fsync") throw new Error("injected post-promote fsync fault"); }
  });
  target.writeFreshOutput(target.readSource());
  const outcome = target.atomicSwitchWithBackup();
  assert.equal(outcome.status, "switched", "a post-promote durability fault must not fail a committed switch");
  assert.doesNotThrow(() => new FileTaskStore(home).listTasks(), "migrated Home loads");
});

test("F2 orchestrator: a phase-aware post-backup failure surfaces switch-ambiguous (not failed/unchanged)", async () => {
  const { home } = currentHome("yui-rr1-f2o-");
  const { latest, registry } = migratableSetup();
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {},
    now: () => new Date("2026-08-06T12:00:00.000Z"),
    switchFaultHook: (step) => { if (step === "post-backup-fsync") throw new Error("injected post-backup fsync"); },
    renameImpl: () => { throw new Error("injected rollback fault"); }
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "switch-ambiguous", "post-backup failure with failed rollback is ambiguous, not a plain failed");
  assert.match(result.action, /mv |restore/i);
  assert.ok(
    !/the authoritative Home is unchanged/i.test(result.action ?? ""),
    "must NOT claim the Home is unchanged"
  );
});

// ===========================================================================
// F3 — a valid backing-up/promoting crash marker (original at backup, no Home)
// is treated as interrupted with the exact backup restore, not a glob/retry.
// ===========================================================================

/** Simulate a crash mid-switch: original moved to backup, Home gone, marker at `phase`. */
function simulateCrashMidSwitch(phase) {
  const { base, home } = currentHome(`yui-rr1-f3-${phase}-`);
  const backupPath = `${home}.backup-crash`;
  // Move the whole Home aside to the backup, then leave the logical Home absent.
  execFileSync("mv", [home, backupPath]);
  assert.equal(existsSync(home), false, "Home path is absent after the simulated crash");
  writeSwitchProgress(home, {
    phase,
    homePath: home,
    backupPath,
    stagingPath: `${home}.upgrade-staging`,
    updatedAt: "2026-08-06T12:00:00.000Z"
  });
  return { base, home, backupPath };
}

for (const phase of ["backing-up", "promoting"]) {
  test(`F3 positive: a '${phase}' crash marker + backup + missing Home is interrupted, points at backup`, () => {
    const { home, backupPath } = simulateCrashMidSwitch(phase);
    const ports = createUpdatePorts(process.env, () => ({
      pid: 0, output: [], stdout: Buffer.from(""), stderr: Buffer.from(""), status: 0, signal: null
    }));
    const probe = ports.probeStorage(home);
    assert.equal(probe.interrupted, true, `a '${phase}' marker with fs evidence must read as interrupted`);
    assert.equal(probe.switched, false);
    assert.equal(probe.backupPath, backupPath);

    // The end-to-end update recovery names the exact restore, not a glob/retry.
    const result = runUpdate(
      {
        stage: () => ({ binaryPath: "/staged/yui", version: "9.9.9" }),
        preflight: () => ({ status: "migratable", summary: "1 step" }),
        activateStorage: () => ({ status: "ambiguous", detail: "child died mid-switch" }),
        activateBinary: () => { throw new Error("must not promote"); },
        verify: () => {},
        probeStorage: (h) => ports.probeStorage(h),
        cleanup: () => {}
      },
      { home }
    );
    assert.equal(result.outcome, "ambiguous");
    assert.match(result.action, new RegExp(backupPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.action, /mv |restore/i);
    assert.doesNotMatch(result.action, /most likely did not commit|backup-\*/i);
  });
}

test("F3 negative: a 'backing-up' marker with an INTACT Home and no backup is not treated as interrupted", () => {
  // Pre-start crash: the marker was written but the rename never happened, so the
  // Home is fully intact and there is nothing to restore.
  const { home } = currentHome("yui-rr1-f3n-");
  writeSwitchProgress(home, {
    phase: "backing-up",
    homePath: home,
    backupPath: `${home}.backup-never`,
    stagingPath: `${home}.upgrade-staging`,
    updatedAt: "2026-08-06T12:00:00.000Z"
  });
  const ports = createUpdatePorts(process.env, () => ({
    pid: 0, output: [], stdout: Buffer.from(""), stderr: Buffer.from(""), status: 0, signal: null
  }));
  const probe = ports.probeStorage(home);
  assert.notEqual(probe.interrupted, true, "an intact Home with no backup is not an interrupted switch");
});

// ===========================================================================
// F4 — stale-owner fence reclaim is atomic (compare-and-delete): a new live
// fence created between observe and delete is never clobbered, and truly
// concurrent entrants never both acquire.
// ===========================================================================

test("F4 unit: reclaim never deletes a NEW live fence that replaced the stale bytes", () => {
  // Seed a dead-owner (stale) fence. Then a racer replaces it with a live fence
  // (different bytes). A reclaim keyed on the OLD bytes must not delete the new one.
  const { home } = currentHome("yui-rr1-f4u-");
  mkdirSync(join(home, "runtime"), { recursive: true });
  const fencePath = join(home, UPGRADE_FENCE_FILE);
  // The stale fence (dead pid).
  writeFileSync(fencePath, `${JSON.stringify({ schemaVersion: 1, ownerPid: 999999999, reason: "stale", createdAt: "" }, null, 2)}\n`);
  // A live foreign owner replaces it (pid 1 = init, always alive).
  writeFileSync(fencePath, `${JSON.stringify({ schemaVersion: 1, ownerPid: 1, reason: "fresh-live", createdAt: "2026-08-06T00:00:00.000Z" }, null, 2)}\n`);
  // A fresh entrant now runs: it sees the LIVE fence (pid 1) and must fail closed,
  // never reclaim it — the stale bytes are gone, replaced by a live owner.
  assert.throws(
    () => placeUpgradeFence(home, { reason: "mine", createdAt: "2026-08-06T00:00:01.000Z", ownerPid: process.pid }),
    /fenced|in-progress upgrade/i
  );
  // The live fence is intact.
  assert.equal(readUpgradeFence(home).ownerPid, 1);
});

test("F4 concurrency: N real processes racing to reclaim one stale fence — never two acquirers", () => {
  // A genuine multi-process race (not a sequential simulation): several child
  // processes simultaneously attempt placeUpgradeFence against a pre-seeded
  // dead-owner stale fence, released together by a shared start barrier. The
  // atomic compare-and-delete reclaim + O_EXCL create must yield AT MOST ONE
  // acquirer per round, with the on-disk owner equal to that sole winner.
  const runner = join(HERE, "helpers", "fence-race-runner.mjs");
  assert.ok(existsSync(runner), `race runner helper must exist at ${runner}`);
  const projectRoot = join(HERE, "..");

  const ROUNDS = 10;
  const WORKERS = 4;
  let roundsWithWinner = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const { home } = currentHome(`yui-rr1-f4c-${round}-`);
    const waitDir = join(home, "runtime");
    mkdirSync(waitDir, { recursive: true });
    // Seed a stale (dead-owner) fence so the reclaim path is exercised.
    writeFileSync(
      join(home, UPGRADE_FENCE_FILE),
      `${JSON.stringify({ schemaVersion: 1, ownerPid: 999999999, reason: "stale", createdAt: "" }, null, 2)}\n`
    );
    const startBarrier = join(home, "runtime", "start.barrier");

    const results = raceFenceWorkers({
      runner, projectRoot, home, startBarrier, waitDir, workers: WORKERS
    });

    const acquired = results.filter((r) => r.acquired);
    assert.ok(
      acquired.length <= 1,
      `round ${round}: at most one worker may acquire, got ${acquired.length}: ${JSON.stringify(results)}`
    );
    if (acquired.length === 1) {
      roundsWithWinner += 1;
      const owner = readUpgradeFence(home);
      if (owner !== null) {
        assert.equal(
          owner.ownerPid, acquired[0].pid,
          `round ${round}: on-disk fence owner must be the sole winner`
        );
      }
    }
  }
  // The race really ran: at least one round produced a genuine acquirer.
  assert.ok(roundsWithWinner > 0, "expected at least one round to produce an acquirer");
});

// --- concurrency helper -----------------------------------------------------

/**
 * Launch `workers` detached child processes that each reach a barrier, then are
 * released together to race for the fence. Returns the collected results
 * [{ pid, acquired }]. The barrier + waiting markers make the acquire attempts
 * overlap as tightly as the OS allows (a real race, not a sequential loop).
 */
function raceFenceWorkers({ runner, projectRoot, home, startBarrier, waitDir, workers }) {
  const children = [];
  for (let i = 0; i < workers; i += 1) {
    const resultPath = join(waitDir, `result.${i}.json`);
    const child = spawn(process.execPath, [runner, home, startBarrier, resultPath, waitDir], {
      cwd: projectRoot,
      stdio: "ignore"
    });
    children.push({ i, resultPath, child });
  }
  // Wait until every worker has reached the barrier, then release them at once.
  waitForAllWaiting(waitDir, workers);
  writeFileSync(startBarrier, "go");
  return collectFenceResults(children);
}

function waitForAllWaiting(waitDir, workers) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const waiting = readdirSync(waitDir).filter((f) => f.startsWith("waiting.")).length;
    if (waiting >= workers) return;
    sleepMs(15);
  }
}

function collectFenceResults(children) {
  const deadline = Date.now() + 12000;
  const results = new Array(children.length).fill(null);
  while (Date.now() < deadline) {
    let done = 0;
    for (const { i, resultPath } of children) {
      if (results[i] !== null) { done += 1; continue; }
      if (existsSync(resultPath)) {
        try { results[i] = JSON.parse(readFileSync(resultPath, "utf8")); done += 1; }
        catch { /* mid-write; retry */ }
      }
    }
    if (done === children.length) break;
    sleepMs(20);
  }
  for (const { child } of children) { try { child.kill(); } catch { /* already exited */ } }
  return results.filter((r) => r !== null);
}

/** A blocking sleep for the parent test loop (Atomics.wait on a throwaway buffer). */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

