import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runMigration } from "../../dist/storage/migration/index.js";
import { MigrationRegistry } from "../../dist/storage/migration/registry.js";
import { writeTextFileAtomically } from "../../dist/storage/durableFile.js";

// ---------------------------------------------------------------------------
// A fully isolated, temp-directory fake MigrationTarget. The generic engine is
// parameterized over this abstraction and never touches a real Home. The fake
// stores the "source" document at source.json and stages migrated output at
// output.json; the atomic switch backs up the original with a stamp and renames
// the fresh output into place — reusing the repo's writeTextFileAtomically.
//
// Crucially, the engine forwards ONLY the union of the plan's declaredEffects to
// rebuildDerivedState. The fake records exactly what it received, letting the
// tests prove the engine hardcodes no domain derived-state list.
// ---------------------------------------------------------------------------

function tempDir() {
  return mkdtempSync(join(tmpdir(), "yui-migration-engine-"));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * @param {object} opts
 * @param {object} opts.source          initial source document (has {layout,aggregate,record})
 * @param {boolean} [opts.live]         detectLiveRuntime result
 * @param {(snapshot:object)=>void} [opts.validate]  throwing validator to model a gate failure
 * @param {(effects:string[])=>object} [opts.rebuild] custom rebuild summary
 */
function makeFakeTarget(opts) {
  const dir = tempDir();
  const sourcePath = join(dir, "source.json");
  const outputPath = join(dir, "output.json");
  writeFileSync(sourcePath, `${JSON.stringify(opts.source, null, 2)}\n`);

  const calls = {
    readSource: 0,
    writeFreshOutput: 0,
    rebuildEffects: null,
    rebuildCount: 0,
    validate: 0,
    switch: 0,
    discard: 0
  };

  const target = {
    dir,
    sourcePath,
    outputPath,
    calls,
    inspectVersions() {
      const doc = readJson(sourcePath);
      return { layout: doc.layout, aggregate: doc.aggregate, record: doc.record };
    },
    detectLiveRuntime() {
      return { active: opts.live === true, detail: opts.live === true ? "worker PID 123" : undefined };
    },
    readSource() {
      calls.readSource += 1;
      return readJson(sourcePath); // fresh parse each time: immutable to the engine
    },
    writeFreshOutput(snapshot) {
      calls.writeFreshOutput += 1;
      if (existsSync(outputPath)) {
        throw new Error("fresh output already exists; refusing to overwrite");
      }
      writeTextFileAtomically(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    },
    rebuildDerivedState(effects) {
      calls.rebuildCount += 1;
      calls.rebuildEffects = [...effects];
      if (opts.rebuild) return opts.rebuild(effects);
      return { rebuiltEffects: [...effects], details: { rebuiltCount: effects.length } };
    },
    validateCurrentState() {
      calls.validate += 1;
      const staged = readJson(outputPath);
      if (opts.validate) opts.validate(staged); // may throw to model a gate failure
      return { checks: [{ name: "loader-parse", outcome: "passed", detail: "staged output parsed" }] };
    },
    atomicSwitchWithBackup() {
      calls.switch += 1;
      const original = readFileSync(sourcePath, "utf8");
      const backupPath = join(dir, "source.json.bak-fixedstamp");
      writeTextFileAtomically(backupPath, original);
      const staged = readFileSync(outputPath, "utf8");
      writeTextFileAtomically(sourcePath, staged);
      return { backupPath, detail: "switched" };
    },
    discardFreshOutput() {
      calls.discard += 1;
    }
  };
  return target;
}

function synthState({ layout = 1, aggregate = 1, record = {} } = {}) {
  return { layout, aggregate, record };
}

/** A step that advances one scalar axis and declares synthetic effects. */
function scalarStep(axis, fromVersion, declaredEffects) {
  return {
    axis,
    fromVersion,
    toVersion: fromVersion + 1,
    preconditions: (input) => {
      if (input[axis] !== fromVersion) throw new Error(`bad precondition ${axis}`);
    },
    transform: (input) => ({ ...input, [axis]: fromVersion + 1 }),
    declaredEffects
  };
}

function registryWith(...steps) {
  const registry = new MigrationRegistry();
  for (const step of steps) registry.register(step);
  return registry;
}

// ---------------------------------------------------------------------------
// already-current / no-op
// ---------------------------------------------------------------------------

test("engine reports already-current and does nothing when versions match", () => {
  const latest = synthState({ layout: 2, aggregate: 3 });
  const target = makeFakeTarget({ source: latest });
  const report = runMigration({ registry: registryWith(), target, latest, mode: "execute" });

  assert.equal(report.outcome, "already-current");
  assert.equal(target.calls.readSource, 0);
  assert.equal(target.calls.switch, 0);
  assert.equal(existsSync(target.outputPath), false);
});

// ---------------------------------------------------------------------------
// blocked: missing-step & future-version fail closed, no writes
// ---------------------------------------------------------------------------

test("engine refuses (blocked) when a step is missing and never writes output", () => {
  const latest = synthState({ aggregate: 3 });
  const target = makeFakeTarget({ source: synthState({ aggregate: 1 }) });
  const report = runMigration({
    registry: registryWith(scalarStep("aggregate", 1, ["x"])), // 2->3 missing
    target,
    latest,
    mode: "execute"
  });

  assert.equal(report.outcome, "blocked");
  assert.equal(report.blocker.reason, "missing-step");
  assert.equal(target.calls.writeFreshOutput, 0);
  assert.equal(target.calls.switch, 0);
  assert.equal(existsSync(target.outputPath), false);
});

// ---------------------------------------------------------------------------
// active runtime: fail closed
// ---------------------------------------------------------------------------

test("engine fails closed when a live runtime is detected", () => {
  const latest = synthState({ aggregate: 2 });
  const target = makeFakeTarget({ source: synthState({ aggregate: 1 }), live: true });
  const report = runMigration({
    registry: registryWith(scalarStep("aggregate", 1, ["x"])),
    target,
    latest,
    mode: "execute"
  });

  assert.equal(report.outcome, "active-runtime");
  assert.match(report.detail, /PID/);
  assert.equal(target.calls.readSource, 0);
  assert.equal(target.calls.switch, 0);
  assert.equal(existsSync(target.outputPath), false);
});

// ---------------------------------------------------------------------------
// successful execute: atomic switch + backup, rebuild+validate called
// ---------------------------------------------------------------------------

test("engine executes: rebuild+validate gates run, then atomic switch with backup", () => {
  const latest = synthState({ layout: 2, aggregate: 2 });
  const target = makeFakeTarget({ source: synthState({ layout: 1, aggregate: 1 }) });
  const report = runMigration({
    registry: registryWith(
      scalarStep("layout", 1, ["counter:widget"]),
      scalarStep("aggregate", 1, ["reference-graph", "counter:widget"])
    ),
    target,
    latest,
    mode: "execute"
  });

  assert.equal(report.outcome, "migrated");
  assert.equal(report.steps.length, 2);
  // effects are the de-duplicated union of declared effects, in first-seen order
  assert.deepEqual(report.effects, ["counter:widget", "reference-graph"]);
  // engine forwarded exactly those synthetic effects — it has NO domain list
  assert.deepEqual(target.calls.rebuildEffects, ["counter:widget", "reference-graph"]);
  assert.equal(target.calls.rebuildCount, 1);
  assert.equal(target.calls.validate, 1);
  assert.equal(target.calls.switch, 1);

  // switch actually promoted the migrated document and made a backup
  assert.equal(readJson(target.sourcePath).layout, 2);
  assert.equal(readJson(target.sourcePath).aggregate, 2);
  const backups = readdirSync(target.dir).filter((f) => f.includes(".bak-"));
  assert.equal(backups.length, 1);
  assert.equal(readJson(join(target.dir, backups[0])).layout, 1);
});

// ---------------------------------------------------------------------------
// dry-run: validate but never switch or leave output
// ---------------------------------------------------------------------------

test("engine dry-run validates but discards output and never switches", () => {
  const latest = synthState({ aggregate: 2 });
  const target = makeFakeTarget({ source: synthState({ aggregate: 1 }) });
  const report = runMigration({
    registry: registryWith(scalarStep("aggregate", 1, ["reference-graph"])),
    target,
    latest,
    mode: "dry-run"
  });

  assert.equal(report.outcome, "dry-run");
  assert.equal(target.calls.rebuildCount, 1);
  assert.equal(target.calls.validate, 1);
  assert.equal(target.calls.switch, 0);
  assert.equal(target.calls.discard, 1);
  // source unchanged
  assert.equal(readJson(target.sourcePath).aggregate, 1);
});

// ---------------------------------------------------------------------------
// rebuildDerivedState proves the engine holds no domain list: whatever synthetic
// effect names the steps declare are exactly what the target receives.
// ---------------------------------------------------------------------------

test("engine forwards only step-declared synthetic effects to rebuildDerivedState", () => {
  const latest = synthState({ aggregate: 3 });
  const target = makeFakeTarget({ source: synthState({ aggregate: 1 }) });
  runMigration({
    registry: registryWith(
      scalarStep("aggregate", 1, ["totally-made-up-effect"]),
      scalarStep("aggregate", 2, ["another-synthetic-effect", "totally-made-up-effect"])
    ),
    target,
    latest,
    mode: "execute"
  });

  assert.deepEqual(target.calls.rebuildEffects, [
    "totally-made-up-effect",
    "another-synthetic-effect"
  ]);
});

// ---------------------------------------------------------------------------
// validateCurrentState failure aborts before the switch; source intact
// ---------------------------------------------------------------------------

test("engine aborts when validateCurrentState throws; source unchanged, no switch", () => {
  const latest = synthState({ aggregate: 2 });
  const target = makeFakeTarget({
    source: synthState({ aggregate: 1 }),
    validate: () => {
      throw new Error("reference graph is inconsistent after migration");
    }
  });
  const report = runMigration({
    registry: registryWith(scalarStep("aggregate", 1, ["reference-graph"])),
    target,
    latest,
    mode: "execute"
  });

  assert.equal(report.outcome, "failed");
  assert.equal(report.stage, "validate");
  assert.match(report.error, /reference graph is inconsistent/);
  assert.equal(target.calls.switch, 0);
  assert.equal(readJson(target.sourcePath).aggregate, 1); // source intact
});

// ---------------------------------------------------------------------------
// pre-switch failure rollback: a failing step transform leaves the source intact
// ---------------------------------------------------------------------------

test("engine rolls back (no switch) when a step transform throws; source intact", () => {
  const latest = synthState({ aggregate: 3 });
  const target = makeFakeTarget({ source: synthState({ aggregate: 1 }) });
  const explode = {
    axis: "aggregate",
    fromVersion: 2,
    toVersion: 3,
    preconditions: () => {},
    transform: () => {
      throw new Error("boom in transform");
    },
    declaredEffects: ["x"]
  };
  const report = runMigration({
    registry: registryWith(scalarStep("aggregate", 1, ["x"]), explode),
    target,
    latest,
    mode: "execute"
  });

  assert.equal(report.outcome, "failed");
  assert.equal(report.stage, "transform");
  assert.equal(report.stepsApplied.length, 1); // only 1->2 applied before boom
  assert.equal(target.calls.switch, 0);
  assert.equal(readJson(target.sourcePath).aggregate, 1); // source intact
});

// ---------------------------------------------------------------------------
// fresh-output refuses to overwrite: a leftover partial output aborts the run
// ---------------------------------------------------------------------------

test("engine's target refuses to overwrite an existing fresh output", () => {
  const latest = synthState({ aggregate: 2 });
  const target = makeFakeTarget({ source: synthState({ aggregate: 1 }) });
  // Simulate a leftover partial output from a previous interrupted run.
  writeFileSync(target.outputPath, "{}\n");

  const report = runMigration({
    registry: registryWith(scalarStep("aggregate", 1, ["x"])),
    target,
    latest,
    mode: "execute"
  });

  assert.equal(report.outcome, "failed");
  assert.equal(report.stage, "write-fresh-output");
  assert.match(report.error, /refusing to overwrite/);
  assert.equal(target.calls.switch, 0);
  assert.equal(readJson(target.sourcePath).aggregate, 1); // source intact
});

// ---------------------------------------------------------------------------
// idempotent re-run: after a successful migration, re-running is already-current
// ---------------------------------------------------------------------------

test("engine is idempotent: re-running after success is a no-op", () => {
  const latest = synthState({ layout: 2 });
  const target = makeFakeTarget({ source: synthState({ layout: 1 }) });
  const registry = registryWith(scalarStep("layout", 1, ["x"]));

  const first = runMigration({ registry, target, latest, mode: "execute" });
  assert.equal(first.outcome, "migrated");
  assert.equal(readJson(target.sourcePath).layout, 2);

  // Fresh target pointed at the now-migrated source: nothing left to do.
  const rerun = makeFakeTarget({ source: readJson(target.sourcePath) });
  const second = runMigration({ registry, target: rerun, latest, mode: "execute" });
  assert.equal(second.outcome, "already-current");
  assert.equal(rerun.calls.switch, 0);
});

// ---------------------------------------------------------------------------
// retriable after an interrupted run: delete the partial output and re-run
// ---------------------------------------------------------------------------

test("engine run is retriable after clearing a partial output", () => {
  const latest = synthState({ aggregate: 2 });
  const target = makeFakeTarget({ source: synthState({ aggregate: 1 }) });
  const registry = registryWith(scalarStep("aggregate", 1, ["x"]));

  // First attempt hits a stale output and fails at write-fresh-output.
  writeFileSync(target.outputPath, "{}\n");
  const failed = runMigration({ registry, target, latest, mode: "execute" });
  assert.equal(failed.outcome, "failed");
  assert.equal(readJson(target.sourcePath).aggregate, 1);

  // Recovery = delete the partial output and retry on a fresh target; no journal.
  const retry = makeFakeTarget({ source: readJson(target.sourcePath) });
  const ok = runMigration({ registry, target: retry, latest, mode: "execute" });
  assert.equal(ok.outcome, "migrated");
  assert.equal(readJson(retry.sourcePath).aggregate, 2);
});
