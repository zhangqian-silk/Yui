import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureStorageSchema,
  CURRENT_STORAGE_LAYOUT_VERSION,
  CURRENT_AGGREGATE_SCHEMA_VERSION
} from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import {
  MigrationRegistry,
  createEmptyRegistry,
  runMigration
} from "../dist/storage/migration/index.js";
import { createProductionRegistry } from "../dist/storage/migration/productionRegistry.js";
import {
  latestStorageVersionState,
  currentRecordVersions
} from "../dist/storage/upgrade/recordVersions.js";
import { runStorageUpgrade } from "../dist/storage/upgrade/upgradeOrchestrator.js";
import { createHomeMigrationTarget } from "../dist/storage/upgrade/homeMigrationTarget.js";
import { createSqliteMigrationTarget } from "../dist/storage/upgrade/sqliteMigrationTarget.js";
import {
  placeUpgradeFence,
  readUpgradeFence,
  UpgradeFenceError,
  UPGRADE_FENCE_FILE
} from "../dist/storage/upgradeFence.js";
import {
  readSwitchProgress,
  switchProgressPath
} from "../dist/storage/upgrade/switchProgress.js";
import {
  writeUpgradeReceipt,
  correlateUpgradeReceipt,
  upgradeReceiptPath
} from "../dist/storage/upgrade/upgradeReceipt.js";
import { runUpdate } from "../dist/cli/updateOrchestrator.js";
import { createUpdatePorts } from "../dist/cli/updatePorts.js";
import { runUpgradeCommand } from "../dist/cli/upgradeCommand.js";

// ---------------------------------------------------------------------------
// Shared isolation helpers — every fixture Home MUST live under the OS temp dir
// so this suite can never touch a real Yui Home, backup, or stable checkout.
// ---------------------------------------------------------------------------

/** A fresh, current, loadable Home under a temp base directory. */
function currentHome() {
  const base = mkdtempSync(join(tmpdir(), "yui-p2r2-"));
  const home = join(base, "home");
  assert.ok(home.startsWith(tmpdir()), `test Home must be under the temp dir, got ${home}`);
  mkdirSync(home, { recursive: true });
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfig({ ...store.getConfig(), timeZone: "UTC" });
  return { base, home };
}

/** The synthetic migratable setup (mirrors storage-upgrade-e2e). */
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
      schemaManifest: {
        ...snapshot.schemaManifest,
        aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION
      },
      state: snapshot.state
    }),
    declaredEffects: []
  });
  return { latest, registry };
}

/**
 * Issue 01: a healthy current layout-7 Home whose authoritative backend is
 * `yui.db` (built through the real 6→7 staged migration, so the fixture is a
 * genuine post-migration Home with yui.db + persistent receipt + state.json
 * retained). A layout-7 Home without `yui.db` is a pseudo-layout-7 Home, not a
 * current Home, so tests that assert current-Home verdicts must use this.
 */
function healthyLayout7Home() {
  const { base, home } = currentHome();
  const manifest = JSON.parse(readFileSync(join(home, "schema.json"), "utf8"));
  manifest.storageVersion = 6;
  writeFileSync(join(home, "schema.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const migrationTarget = createSqliteMigrationTarget({
    home,
    latest: latestStorageVersionState(),
    registry: createProductionRegistry()
  });
  const migration = runMigration({
    registry: createProductionRegistry(),
    target: migrationTarget,
    latest: latestStorageVersionState(),
    mode: "execute"
  });
  assert.equal(migration.outcome, "migrated");
  return { base, home };
}

// ===========================================================================
// P1-1 — Complete Home content preservation contract: the atomic switch must
// preserve runtime/inbox (authoritative), cache/, artifacts/ — no silent loss.
// ===========================================================================

/**
 * Seed extra persistent content across runtime discovery + rebuildable dirs.
 * NOTE: this intentionally does NOT seed `runtime/inbox/*` — a non-empty durable
 * inbox now (correctly) blocks the upgrade at drain-incomplete (R3-F4), which is
 * covered by its own test. Preservation here is proven for the content that a
 * clean (drained) upgrade actually switches: runtime discovery, cache/, artifacts/.
 */
function seedExtraHomeContent(home) {
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(join(home, "runtime", "controller.json"), '{"pid":999999999}\n');
  mkdirSync(join(home, "cache"), { recursive: true });
  writeFileSync(join(home, "cache", "warmup.bin"), "cache-bytes");
  mkdirSync(join(home, "artifacts", "integration-checks"), { recursive: true });
  writeFileSync(join(home, "artifacts", "integration-checks", "check-1.log"), "check output");
}

test("P1-1 positive: a migrated switch preserves runtime/, cache/, artifacts/", async () => {
  const { home } = currentHome();
  seedExtraHomeContent(home);
  const { latest, registry } = migratableSetup();
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {},
    now: () => new Date("2026-08-06T12:00:00.000Z")
  });
  assert.equal(result.outcome, "upgraded");
  // Every runtime + rebuildable entry must survive the atomic switch.
  assert.equal(
    readFileSync(join(home, "runtime", "controller.json"), "utf8"),
    '{"pid":999999999}\n',
    "runtime discovery content must be preserved"
  );
  assert.equal(readFileSync(join(home, "cache", "warmup.bin"), "utf8"), "cache-bytes");
  assert.equal(
    readFileSync(join(home, "artifacts", "integration-checks", "check-1.log"), "utf8"),
    "check output"
  );
  // The migrated Home still loads through the real gate.
  assert.doesNotThrow(() => new FileTaskStore(home).listTasks());
});

test("P1-1 positive: the timestamped backup retains the original database bytes", async () => {
  const { home } = healthyLayout7Home();
  seedExtraHomeContent(home);
  const originalDb = readFileSync(join(home, "yui.db"));
  const { latest, registry } = migratableSetup();
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {},
    now: () => new Date("2026-08-06T12:00:00.000Z")
  });
  assert.equal(result.outcome, "upgraded");
  assert.ok(result.backupPath, "a backup path is reported");
  // A layout-7 Home's authoritative store is yui.db; the SQLite record target
  // backs up the database file (not a Home-directory copy). Extra Home content
  // (runtime/, cache/, artifacts/) is preserved in place by the sibling test,
  // not copied into the database backup.
  assert.equal(
    readFileSync(result.backupPath).toString("hex"),
    originalDb.toString("hex")
  );
});

test("P1-1 negative: the transient .state.lock is NOT promoted into the migrated Home", async () => {
  const { home } = currentHome();
  seedExtraHomeContent(home);
  // A stale, dead-owner lock present on the source: per-instance coordination
  // state, not authoritative content, so it must not survive the switch.
  mkdirSync(join(home, ".state.lock"), { recursive: true });
  writeFileSync(join(home, ".state.lock", "owner"), "999999999\n");
  const { latest, registry } = migratableSetup();
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {},
    now: () => new Date("2026-08-06T12:00:00.000Z")
  });
  assert.equal(result.outcome, "upgraded");
  assert.equal(existsSync(join(home, ".state.lock")), false, ".state.lock must not be promoted");
  // But real content is still there.
  assert.equal(existsSync(join(home, "cache", "warmup.bin")), true);
});

test("P1-1 target unit: writeFreshOutput stages a COMPLETE copy, not just schema+state", () => {
  const { home } = currentHome();
  seedExtraHomeContent(home);
  // Seed a nested runtime/inbox entry directly (this unit test drives the target,
  // bypassing the quiesce drain gate) to prove the complete copy includes even
  // deep authoritative content.
  mkdirSync(join(home, "runtime", "inbox"), { recursive: true });
  writeFileSync(join(home, "runtime", "inbox", "event-1.json"), '{"authoritative":true}\n');
  const stagingPath = `${home}.upgrade-staging`;
  const target = createHomeMigrationTarget({ home, latest: latestStorageVersionState(), stagingPath });
  target.writeFreshOutput(target.readSource());
  // Staging carries the extra dirs verbatim in addition to schema/state.
  const staged = readdirSync(stagingPath).sort();
  assert.ok(staged.includes("runtime"), "runtime/ carried into staging");
  assert.ok(staged.includes("cache"), "cache/ carried into staging");
  assert.ok(staged.includes("artifacts"), "artifacts/ carried into staging");
  assert.ok(staged.includes("schema.json"));
  assert.ok(staged.includes("state.json"));
  assert.equal(
    readFileSync(join(stagingPath, "runtime", "inbox", "event-1.json"), "utf8"),
    '{"authoritative":true}\n'
  );
  target.discardFreshOutput();
});

// ===========================================================================
// P1-4 — partial (two-step) switch reporting: a second-rename failure whose
// rollback also fails must report ambiguous + backup recovery, never "unchanged".
// ===========================================================================

test("P1-4 positive: a clean two-step switch reports switched and clears its progress marker", async () => {
  const { home } = currentHome();
  const { latest, registry } = migratableSetup();
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {},
    now: () => new Date("2026-08-06T12:00:00.000Z")
  });
  assert.equal(result.outcome, "upgraded");
  // Marker cleared on a complete switch (not-started / interrupted are the other states).
  assert.equal(readSwitchProgress(home), null);
  assert.equal(existsSync(switchProgressPath(home)), false);
});

test("P1-4 negative: second-rename failure with SUCCESSFUL rollback restores the original (unchanged)", () => {
  const { home } = currentHome();
  const { latest } = migratableSetup();
  const originalState = readFileSync(join(home, "state.json"), "utf8");
  const stagingPath = `${home}.upgrade-staging`;
  // Fail ONLY the promote (staging -> home); let the rollback (backup -> home)
  // through, so the original is restored and the Home ends up byte-for-byte
  // unchanged — the switch honestly reports failure, not a partial state.
  const target = createHomeMigrationTarget({
    home, latest, stagingPath,
    now: () => new Date("2026-08-06T12:00:00.000Z"),
    renameImpl: (from, to) => {
      if (from === stagingPath) throw new Error("injected promote failure");
      renameSync(from, to); // rollback backup -> home succeeds
    }
  });
  target.writeFreshOutput(target.readSource());
  assert.throws(() => target.atomicSwitchWithBackup(), /injected promote failure/);
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), originalState,
    "rollback restored the original bytes");
  assert.equal(readSwitchProgress(home), null, "clean rollback clears the marker");
  target.discardFreshOutput();
});

test("P1-4 negative: when rollback ALSO fails, atomicSwitchWithBackup throws AmbiguousSwitchError and records interrupted", () => {
  const { home } = currentHome();
  const stagingPath = `${home}.upgrade-staging`;
  // A renameImpl that fails BOTH the promote (staging->home) and the rollback
  // (backup->home) — every call throws — so the switch is genuinely interrupted.
  const target = createHomeMigrationTarget({
    home, latest: latestStorageVersionState(), stagingPath,
    now: () => new Date("2026-08-06T12:00:00.000Z"),
    renameImpl: () => { throw new Error("injected rename failure (both directions)"); }
  });
  target.writeFreshOutput(target.readSource());
  let thrown;
  try {
    target.atomicSwitchWithBackup();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "an error was thrown");
  assert.equal(thrown.name, "AmbiguousSwitchError");
  assert.match(thrown.message, /AMBIGUOUS|partially-applied/i);
  assert.ok(thrown.backupPath, "carries the backup recovery path");
  // The interrupted phase is recorded durably for a later reader.
  const progress = readSwitchProgress(home);
  assert.ok(progress, "a switch-progress marker is present");
  assert.equal(progress.phase, "interrupted");
  assert.equal(progress.homePath, home);
  target.discardFreshOutput();
});

test("P1-4 orchestrator: an ambiguous switch blocks at switch-ambiguous, records interrupted, does not claim unchanged", async () => {
  const { home } = healthyLayout7Home();
  const { latest, registry } = migratableSetup();
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {},
    now: () => new Date("2026-08-06T12:00:00.000Z"),
    // Both renames fail → ambiguous, partially-applied switch.
    renameImpl: () => { throw new Error("injected two-way rename failure"); }
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "switch-ambiguous");
  assert.match(result.action, /mv |restore/i);
  // The honest durable signal is the interrupted switch-progress marker (NOT a
  // completion receipt, since the switch did not commit).
  const progress = readSwitchProgress(home);
  assert.ok(progress, "an interrupted switch-progress marker is present");
  assert.equal(progress.phase, "interrupted");
  assert.equal(existsSync(upgradeReceiptPath(home)), false,
    "no completion receipt is written for a switch that did not commit");
});

test("P1-4 SQLite ambiguous switch restore command targets yui.db, not the Home directory", async () => {
  const { home } = healthyLayout7Home();
  const { latest, registry } = migratableSetup();
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {},
    now: () => new Date("2026-08-06T12:00:00.000Z"),
    renameImpl: () => { throw new Error("injected two-way rename failure"); }
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "switch-ambiguous");
  // A SQLite backup is the committed yui.db file moved aside INSIDE the Home;
  // the restore command must rename it back onto yui.db, not onto the Home
  // directory (which would nest the file).
  const stamp = "2026-08-06T12-00-00-000Z";
  const backupPath = join(home, `yui.db.backup-${stamp}`);
  const committedDbPath = join(home, "yui.db");
  assert.ok(
    result.action.includes(`mv "${backupPath}" "${committedDbPath}"`),
    `expected SQLite restore command targeting yui.db, got: ${result.action}`
  );
});

test("P1-4 update: a switch-ambiguous activation is NOT reported recoverable; it points at the backup", () => {
  // The staged binary's `yui upgrade` returns a switch-ambiguous blocked result;
  // `yui update` must treat it as ambiguous (restore the backup), never a clean
  // recoverable refusal.
  const spy = {};
  const result = runUpdate(
    {
      stage: () => ({ binaryPath: "/staged/yui", version: "9.9.9" }),
      preflight: () => ({ status: "migratable", summary: "1 step" }),
      activateStorage: () => ({
        status: "ambiguous",
        detail: "the storage switch was left partially applied"
      }),
      activateBinary: () => { spy.activatedBinary = true; },
      verify: () => { spy.verified = true; },
      probeStorage: () => ({ switched: false, interrupted: true, schemaCurrent: false, backupPath: "/home.backup-int" }),
      cleanup: () => { spy.cleaned = true; }
    },
    { home: "/home" }
  );
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.switched, false);
  assert.match(result.message, /INTERRUPTED|partially/i);
  assert.match(result.action, /mv .*home\.backup-int|restore/i);
  assert.equal("recoverable" in result, false, "an interrupted switch is never a recoverable no-op");
  assert.equal(spy.activatedBinary, undefined, "binary must NOT be promoted");
});

// ===========================================================================
// P2-5 — concurrent fence: two entrants, exactly one acquires (atomic O_EXCL).
// ===========================================================================

test("P2-5 positive: two concurrent placeUpgradeFence entrants, exactly one acquires", () => {
  const { home } = currentHome();
  // Two DIFFERENT live owners racing. pid 1 (init) is always alive; this process
  // is alive. The first create wins; the second sees a live foreign owner and
  // fails closed. (Owners differ so neither is treated as idempotent re-entry.)
  let firstOk = false;
  let firstErr;
  try {
    placeUpgradeFence(home, { reason: "A", createdAt: "2026-08-06T00:00:00.000Z", ownerPid: 1 });
    firstOk = true;
  } catch (error) { firstErr = error; }
  assert.equal(firstOk, true, "the first entrant acquired");
  assert.equal(firstErr, undefined);

  let secondOk = false;
  let secondErr;
  try {
    placeUpgradeFence(home, { reason: "B", createdAt: "2026-08-06T00:00:01.000Z", ownerPid: process.pid });
    secondOk = true;
  } catch (error) { secondErr = error; }
  assert.equal(secondOk, false, "the second entrant must be refused");
  assert.ok(secondErr instanceof UpgradeFenceError, "refusal is an UpgradeFenceError");
  // The winner's fence is the one on disk.
  assert.equal(readUpgradeFence(home).ownerPid, 1);
});

test("P2-5 positive: the acquisition is a single atomic file create (no check-then-write)", () => {
  const { home } = currentHome();
  const release = placeUpgradeFence(home, {
    reason: "solo", createdAt: "2026-08-06T00:00:00.000Z", ownerPid: process.pid
  });
  // The fence marker exists as a real file at the expected path.
  assert.equal(existsSync(join(home, UPGRADE_FENCE_FILE)), true);
  // Idempotent re-entry by the same owner succeeds (does not throw).
  assert.doesNotThrow(() => placeUpgradeFence(home, {
    reason: "solo-again", createdAt: "2026-08-06T00:00:02.000Z", ownerPid: process.pid
  }));
  release();
  assert.equal(readUpgradeFence(home), null);
});

test("P2-5 negative: a dead-owner stale fence is reclaimed so a new entrant acquires", () => {
  const { home } = currentHome();
  // Pre-place a fence owned by a dead pid (stale from a crashed upgrade).
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(
    join(home, UPGRADE_FENCE_FILE),
    `${JSON.stringify({ schemaVersion: 1, ownerPid: 999999999, reason: "crashed", createdAt: "" }, null, 2)}\n`
  );
  // A fresh entrant reclaims the dead owner's fence and acquires.
  const release = placeUpgradeFence(home, {
    reason: "fresh", createdAt: "2026-08-06T00:00:00.000Z", ownerPid: process.pid
  });
  assert.equal(readUpgradeFence(home).ownerPid, process.pid);
  release();
});

// ===========================================================================
// P2-6 — interrupted-retry receipt validation: an old receipt is only trusted
// when it CORRESPONDS to the current Home/backup; otherwise re-probe.
// ===========================================================================

test("P2-6 positive: a corresponding receipt (matching home, existing backup) is trusted", () => {
  const { home } = currentHome();
  const backupPath = `${home}.backup-x`;
  mkdirSync(backupPath, { recursive: true });
  writeUpgradeReceipt(home, {
    switched: true, homePath: home, backupPath,
    completedAt: "2026-08-06T00:00:00.000Z"
  });
  const correlation = correlateUpgradeReceipt(home);
  assert.equal(correlation.corresponds, true);
  assert.equal(correlation.receipt.backupPath, backupPath);
});

test("P2-6 negative: a receipt whose backup no longer exists does NOT correspond (re-probe)", () => {
  const { home } = currentHome();
  writeUpgradeReceipt(home, {
    switched: true, homePath: home, backupPath: `${home}.backup-gone`,
    completedAt: "2026-08-06T00:00:00.000Z"
  });
  const correlation = correlateUpgradeReceipt(home);
  assert.equal(correlation.corresponds, false);
  assert.match(correlation.reason, /no longer exists|already restored|cleaned/i);
});

test("P2-6 negative: a receipt naming a DIFFERENT home does not correspond", () => {
  const { home } = currentHome();
  const backupPath = `${home}.backup-x`;
  mkdirSync(backupPath, { recursive: true });
  writeUpgradeReceipt(home, {
    switched: true, homePath: `${home}-somewhere-else`, backupPath,
    completedAt: "2026-08-06T00:00:00.000Z"
  });
  const correlation = correlateUpgradeReceipt(home);
  assert.equal(correlation.corresponds, false);
  assert.match(correlation.reason, /different Home/i);
});

test("P2-6 probeStorage: a stale (backup-gone) receipt reports switched=false so the caller re-probes", () => {
  const { home } = currentHome();
  writeUpgradeReceipt(home, {
    switched: true, homePath: home, backupPath: `${home}.backup-gone`,
    completedAt: "2026-08-06T00:00:00.000Z"
  });
  const ports = createUpdatePorts(process.env, () => ({
    pid: 0, output: [], stdout: Buffer.from(""), stderr: Buffer.from(""), status: 0, signal: null
  }));
  const probe = ports.probeStorage(home);
  assert.equal(probe.switched, false, "a non-corresponding receipt must not read as switched");
});

// ===========================================================================
// P2-7 — uninitialized Home: upgrade returns a structured "run yui setup"
// blocker (not a runtime error, not a USABLE no-op).
// ===========================================================================

test("P2-7 positive: upgrade on an uninitialized Home blocks with a 'run yui setup' action", async () => {
  const base = mkdtempSync(join(tmpdir(), "yui-p2r2-uninit-"));
  const home = join(base, "never-setup");
  assert.ok(home.startsWith(tmpdir()));
  // No ensureStorageSchema: the Home is genuinely uninitialized.
  const result = await runStorageUpgrade({
    home,
    registry: createEmptyRegistry(),
    latest: latestStorageVersionState(),
    mode: "execute",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "uninitialized");
  assert.match(result.action, /yui setup/);
  // It is NOT reported as a USABLE success and never switches.
  assert.notEqual(result.outcome, "already-current");
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
});

test("P2-7 command: `yui upgrade` on an uninitialized Home exits non-zero with the setup blocker", async () => {
  const base = mkdtempSync(join(tmpdir(), "yui-p2r2-uninit-cmd-"));
  const home = join(base, "never-setup");
  const result = await runUpgradeCommand([], home);
  assert.equal(result.exitCode, 5, "a blocked upgrade exits 5");
  assert.match(result.output, /uninitialized/);
  assert.match(result.output, /yui setup/);
});

test("P2-7 negative: an initialized, current Home is already-current (no false setup blocker)", async () => {
  const { home } = healthyLayout7Home();
  const result = await runStorageUpgrade({
    home,
    registry: createEmptyRegistry(),
    latest: latestStorageVersionState(),
    mode: "execute",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "already-current");
});

// ===========================================================================
// P1-2 — exit status / JSON outcome consistency: a success-class outcome must
// be paired with exit 0; a contradiction is ambiguous, never a false success.
// ===========================================================================

function spawnResult(overrides) {
  return {
    pid: 0, output: [],
    stdout: Buffer.from(""), stderr: Buffer.from(""),
    status: 0, signal: null, ...overrides
  };
}
function okData(data, status = 0) {
  return spawnResult({ status, stdout: Buffer.from(JSON.stringify({ ok: true, data })) });
}

/** A fake spawn that returns a fixed result for the staged binary's upgrade. */
function upgradeSpawn(activateResult, stageVersion = "9.9.9") {
  return (command, args) => {
    if (command === "npm" && args[0] === "prefix") return spawnResult({ stdout: Buffer.from("") });
    if (command === "npm" && args[0] === "install") return spawnResult({});
    if (args.includes("version")) return okData({ version: stageVersion });
    if (args.includes("doctor")) return okData({ storage: { healthy: true, blocking: [] } });
    if (args.includes("upgrade")) return activateResult;
    return spawnResult({});
  };
}

test("P1-2 positive: outcome=upgraded WITH exit 0 is treated as migrated", () => {
  const ports = createUpdatePorts(process.env, upgradeSpawn(
    okData({ outcome: "upgraded", backupPath: "/home.backup-ok" }, 0)
  ));
  const activation = ports.activateStorage({ binaryPath: "/staged/yui", version: "9.9.9" }, "/home");
  assert.equal(activation.status, "migrated");
  assert.equal(activation.backupPath, "/home.backup-ok");
});

test("P1-2 negative: outcome=upgraded but exit!=0 is AMBIGUOUS, not a false success", () => {
  const ports = createUpdatePorts(process.env, upgradeSpawn(
    okData({ outcome: "upgraded", backupPath: "/home.backup-x" }, 3)
  ));
  const activation = ports.activateStorage({ binaryPath: "/staged/yui", version: "9.9.9" }, "/home");
  assert.equal(activation.status, "ambiguous", "a success outcome with a non-zero exit must be ambiguous");
  assert.match(activation.detail, /exit|status 3|must exit 0/i);
});

test("P1-2 negative: outcome=already-current but exit!=0 is AMBIGUOUS", () => {
  const ports = createUpdatePorts(process.env, upgradeSpawn(
    okData({ outcome: "already-current" }, 1)
  ));
  const activation = ports.activateStorage({ binaryPath: "/staged/yui", version: "9.9.9" }, "/home");
  assert.equal(activation.status, "ambiguous");
});

test("P1-2 negative: exit 0 with NO outcome is NOT treated as success (ambiguous)", () => {
  const ports = createUpdatePorts(process.env, upgradeSpawn(okData({ note: "no outcome field" }, 0)));
  const activation = ports.activateStorage({ binaryPath: "/staged/yui", version: "9.9.9" }, "/home");
  assert.equal(activation.status, "ambiguous");
  assert.match(activation.detail, /unrecognized outcome/i);
});

test("P1-2 blocker exemption: a clean blocked outcome with exit 5 stays a clean blocked", () => {
  const ports = createUpdatePorts(process.env, upgradeSpawn(
    okData({ outcome: "blocked", stage: "active-runtime", message: "busy", action: "stop it" }, 5)
  ));
  const activation = ports.activateStorage({ binaryPath: "/staged/yui", version: "9.9.9" }, "/home");
  assert.equal(activation.status, "blocked", "a non-zero exit is EXPECTED for a blocked outcome");
  assert.equal(activation.stage, "active-runtime");
});

// ===========================================================================
// P1-3 — post-verify parses the doctor machine-readable result: unhealthy
// storage blocks even when the process exits 0.
// ===========================================================================

/** Create a temp global prefix with a real bin/yui so existsSync passes. */
function fakeGlobalInstall() {
  const globalPrefix = mkdtempSync(join(tmpdir(), "yui-p2r2-global-"));
  mkdirSync(join(globalPrefix, "bin"), { recursive: true });
  writeFileSync(join(globalPrefix, "bin", "yui"), "#!/bin/sh\n", { mode: 0o755 });
  return { globalPrefix, globalBinary: join(globalPrefix, "bin", "yui") };
}

/** A healthy `--json doctor` payload: all storage checks ok + healthy verdict. */
function healthyDoctorData() {
  return {
    checks: [
      { name: "storage schema", status: "ok", detail: "current" },
      { name: "storage compatibility", status: "ok", detail: "USABLE" },
      { name: "storage state", status: "ok", detail: "readable" }
    ],
    storage: { healthy: true, blocking: [] }
  };
}

/** A fake spawn whose activated global doctor returns a chosen result. */
function verifySpawn(globalPrefix, doctorResult, stageVersion = "9.9.9") {
  const globalBinary = join(globalPrefix, "bin", "yui");
  return (command, args) => {
    if (command === "npm" && args[0] === "prefix") return spawnResult({ stdout: Buffer.from(globalPrefix) });
    if (command === "npm" && args[0] === "install") return spawnResult({});
    if (args.includes("version")) return okData({ version: stageVersion });
    if (args.includes("doctor") && command === globalBinary) return doctorResult;
    if (args.includes("doctor")) return okData(healthyDoctorData());
    return spawnResult({});
  };
}

test("P1-3 positive: verify passes when doctor reports healthy storage (exit 0)", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const ports = createUpdatePorts(process.env, verifySpawn(
    globalPrefix, okData(healthyDoctorData(), 0)
  ));
  const staged = ports.stage();
  assert.doesNotThrow(() => ports.verify(staged, "/home"));
});

test("P1-3 negative: verify FAILS CLOSED when doctor reports unhealthy storage despite exit 0", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const ports = createUpdatePorts(process.env, verifySpawn(
    globalPrefix,
    okData({
      checks: [{ name: "storage compatibility", status: "unsupported", detail: "NEEDS_NEW_VERSION" }],
      storage: {
        healthy: false,
        blocking: [{ name: "storage compatibility", status: "unsupported", detail: "NEEDS_NEW_VERSION" }]
      }
    }, 0) // exit 0 but storage unhealthy — the old bug would have passed.
  ));
  const staged = ports.stage();
  assert.throws(() => ports.verify(staged, "/home"),
    /not healthy|unsupported|NEEDS_NEW_VERSION|restore the timestamped backup/i);
});

test("P1-3 negative: verify FAILS CLOSED when doctor returns an unparseable storage result", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const ports = createUpdatePorts(process.env, verifySpawn(
    globalPrefix, okData({ note: "no storage field" }, 0)
  ));
  const staged = ports.stage();
  assert.throws(() => ports.verify(staged, "/home"),
    /did not return a parseable storage-health result|cannot be confirmed healthy/i);
});
