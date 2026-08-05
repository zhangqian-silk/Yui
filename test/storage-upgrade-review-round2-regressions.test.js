import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  utimesSync,
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
import { currentRecordVersions } from "../dist/storage/upgrade/recordVersions.js";
import { createUpdatePorts } from "../dist/cli/updatePorts.js";
import { writeSwitchProgress } from "../dist/storage/upgrade/switchProgress.js";
import {
  placeUpgradeFence,
  assertHomeWritable,
  readUpgradeFence,
  UpgradeFenceError,
  UPGRADE_FENCE_FILE
} from "../dist/storage/upgradeFence.js";

// ---------------------------------------------------------------------------
// Isolation: every fixture Home lives under the OS temp dir.
// ---------------------------------------------------------------------------

function currentHome(prefix = "yui-rr2-") {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const home = join(base, "home");
  assert.ok(home.startsWith(tmpdir()), `test Home must be under the temp dir, got ${home}`);
  mkdirSync(home, { recursive: true });
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfig({ ...store.getConfig(), timeZone: "UTC" });
  return { base, home };
}

// --- fake spawn plumbing ----------------------------------------------------

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
function rawOut(text, status = 0) {
  return spawnResult({ status, stdout: Buffer.from(text) });
}

/** A healthy `--json doctor` payload (all storage checks ok). */
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

/** Create a temp global prefix with a real bin/yui so existsSync passes. */
function fakeGlobalInstall() {
  const globalPrefix = mkdtempSync(join(tmpdir(), "yui-rr2-global-"));
  mkdirSync(join(globalPrefix, "bin"), { recursive: true });
  writeFileSync(join(globalPrefix, "bin", "yui"), "#!/bin/sh\n", { mode: 0o755 });
  return { globalPrefix, globalBinary: join(globalPrefix, "bin", "yui") };
}

// ===========================================================================
// R2-F1 — staged version must resolve to an EXACT version; never fall back to
// @latest. Activation pins it; verify requires the activated binary to match.
// ===========================================================================

/**
 * A spawn where the staged package has NO resolvable version: no staged
 * package.json on disk (we stage into a real tmp with no lib/node_modules) and
 * the staged binary's `--json version` returns nothing usable.
 */
function unresolvableVersionSpawn() {
  return (command, args) => {
    if (command === "npm" && args[0] === "install") return spawnResult({});
    if (args.includes("version")) return okData({ notVersion: "??" }); // no `version` field
    return spawnResult({});
  };
}

test("R2-F1 positive: stage FAILS (never @latest) when the exact version cannot be resolved", () => {
  const ports = createUpdatePorts(process.env, unresolvableVersionSpawn());
  assert.throws(
    () => ports.stage(),
    /resolve the exact staged package version|Refusing to proceed with a `@latest` fallback/i
  );
});

test("R2-F1 positive: stage succeeds and pins the exact version when resolvable", () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "npm" && args[0] === "install") return spawnResult({});
    if (args.includes("version")) return okData({ version: "9.9.9" });
    return spawnResult({});
  };
  const ports = createUpdatePorts(process.env, spawn);
  const staged = ports.stage();
  assert.equal(staged.version, "9.9.9");
  ports.activateBinary(staged);
  const install = calls.find((c) => c.command === "npm"
    && c.args[0] === "install" && c.args.includes("--global") && !c.args.includes("--prefix"));
  assert.ok(install.args.includes("@zq-silk/yui@9.9.9"), "activation pins the exact version");
  assert.equal(install.args.includes("@zq-silk/yui@latest"), false, "never @latest");
});

test("R2-F1 negative: verify FAILS CLOSED when the activated binary version is unresolvable", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const globalBinary = join(globalPrefix, "bin", "yui");
  const spawn = (command, args) => {
    if (command === "npm" && args[0] === "prefix") return rawOut(globalPrefix);
    if (command === "npm" && args[0] === "install") return spawnResult({});
    // Staged binary reports 9.9.9; the ACTIVATED global binary reports no version.
    if (args.includes("version") && command === globalBinary) return okData({ notVersion: "x" });
    if (args.includes("version")) return okData({ version: "9.9.9" });
    if (args.includes("doctor")) return okData(healthyDoctorData());
    return spawnResult({});
  };
  const ports = createUpdatePorts(process.env, spawn);
  const staged = ports.stage();
  assert.equal(staged.version, "9.9.9");
  assert.throws(
    () => ports.verify(staged, "/home"),
    /could not determine the activated binary's version|identity cannot be confirmed/i
  );
});

test("R2-F1 negative: verify FAILS CLOSED when activated version differs from staged", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const globalBinary = join(globalPrefix, "bin", "yui");
  const spawn = (command, args) => {
    if (command === "npm" && args[0] === "prefix") return rawOut(globalPrefix);
    if (command === "npm" && args[0] === "install") return spawnResult({});
    if (args.includes("version") && command === globalBinary) return okData({ version: "8.8.8" });
    if (args.includes("version")) return okData({ version: "9.9.9" });
    if (args.includes("doctor")) return okData(healthyDoctorData());
    return spawnResult({});
  };
  const ports = createUpdatePorts(process.env, spawn);
  const staged = ports.stage();
  assert.throws(() => ports.verify(staged, "/home"),
    /activated binary is version 8\.8\.8.*staged.*9\.9\.9/s);
});

// ===========================================================================
// R2-F2 — post-verify parses/validates the doctor envelope BEFORE interpreting
// exit status: unhealthy(exit5) => blocked; unparseable/contradictory => closed.
// ===========================================================================

function verifySpawnWithDoctor(globalPrefix, doctorResult) {
  const globalBinary = join(globalPrefix, "bin", "yui");
  return (command, args) => {
    if (command === "npm" && args[0] === "prefix") return rawOut(globalPrefix);
    if (command === "npm" && args[0] === "install") return spawnResult({});
    if (args.includes("version")) return okData({ version: "9.9.9" });
    if (args.includes("doctor") && command === globalBinary) return doctorResult;
    if (args.includes("doctor")) return okData(healthyDoctorData());
    return spawnResult({});
  };
}

test("R2-F2 positive: healthy doctor at exit 0 passes verify", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const ports = createUpdatePorts(process.env, verifySpawnWithDoctor(globalPrefix, okData(healthyDoctorData(), 0)));
  const staged = ports.stage();
  assert.doesNotThrow(() => ports.verify(staged, "/home"));
});

test("R2-F2 negative: unhealthy doctor at EXIT 5 is parsed => blocked with recovery (not a generic exit error)", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const unhealthy = okData({
    checks: [{ name: "storage compatibility", status: "unsupported", detail: "NEEDS_NEW_VERSION" }],
    storage: { healthy: false, blocking: [{ name: "storage compatibility", status: "unsupported", detail: "NEEDS_NEW_VERSION" }] }
  }, 5); // real CLI sets exit 5 on unhealthy --json doctor
  const ports = createUpdatePorts(process.env, verifySpawnWithDoctor(globalPrefix, unhealthy));
  const staged = ports.stage();
  assert.throws(() => ports.verify(staged, "/home"), (error) => {
    // Must be the STRUCTURED unhealthy verdict + recovery, not "exited with status 5".
    assert.match(error.message, /not healthy|NEEDS_NEW_VERSION|Restore the timestamped backup/i);
    assert.doesNotMatch(error.message, /exited with status 5/i);
    return true;
  });
});

test("R2-F2 negative: unparseable doctor envelope fails closed", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const ports = createUpdatePorts(process.env, verifySpawnWithDoctor(globalPrefix, rawOut("not json at all", 0)));
  const staged = ports.stage();
  assert.throws(() => ports.verify(staged, "/home"),
    /did not return a parseable success envelope|cannot be confirmed healthy/i);
});

test("R2-F2 negative: a CONTRADICTORY envelope (healthy:true but a non-ok storage check) fails closed", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const contradictory = okData({
    checks: [{ name: "storage state", status: "invalid", detail: "corrupt" }],
    storage: { healthy: true, blocking: [] } // claims healthy, but a storage check is non-ok
  }, 0);
  const ports = createUpdatePorts(process.env, verifySpawnWithDoctor(globalPrefix, contradictory));
  const staged = ports.stage();
  assert.throws(() => ports.verify(staged, "/home"),
    /self-contradictory|refusing to trust|cannot be confirmed healthy/i);
});

test("R2-F2 negative: healthy checks but NON-ZERO exit fails closed (exit must agree)", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const ports = createUpdatePorts(process.env, verifySpawnWithDoctor(globalPrefix, okData(healthyDoctorData(), 3)));
  const staged = ports.stage();
  assert.throws(() => ports.verify(staged, "/home"),
    /exited with status 3|clean health check must exit 0|cannot be confirmed healthy/i);
});

test("R2-F2 negative: ok:false envelope fails closed even if it embeds healthy storage", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const notOk = spawnResult({ status: 0, stdout: Buffer.from(JSON.stringify({ ok: false, data: healthyDoctorData() })) });
  const ports = createUpdatePorts(process.env, verifySpawnWithDoctor(globalPrefix, notOk));
  const staged = ports.stage();
  assert.throws(() => ports.verify(staged, "/home"),
    /did not return a parseable success envelope|cannot be confirmed healthy/i);
});

// ===========================================================================
// R2-F3 — the interrupted marker is only actionable with filesystem evidence:
// an intact Home or a vanished backup makes a stale interrupted marker inert.
// ===========================================================================

test("R2-F3 negative: an INTACT Home + a stale 'interrupted' marker is NOT reported interrupted", () => {
  // Manual recovery already happened: the Home is fully initialized again, but a
  // leftover interrupted marker + backup dir remain. Must NOT emit a restore.
  const { home } = currentHome("yui-rr2-f3a-");
  const backupPath = `${home}.backup-old`;
  mkdirSync(backupPath, { recursive: true }); // backup still on disk
  writeSwitchProgress(home, {
    phase: "interrupted",
    homePath: home,
    backupPath,
    stagingPath: `${home}.upgrade-staging`,
    updatedAt: "2026-08-06T12:00:00.000Z"
  });
  const ports = createUpdatePorts(process.env, () => spawnResult({}));
  const probe = ports.probeStorage(home);
  assert.notEqual(probe.interrupted, true,
    "an intact Home must not be treated as an interrupted switch even with a stale marker");
});

test("R2-F3 negative: a stale 'interrupted' marker whose backup VANISHED triggers a re-probe (not a restore)", () => {
  const { home } = currentHome("yui-rr2-f3b-");
  writeSwitchProgress(home, {
    phase: "interrupted",
    homePath: home,
    backupPath: `${home}.backup-gone`, // does not exist
    stagingPath: `${home}.upgrade-staging`,
    updatedAt: "2026-08-06T12:00:00.000Z"
  });
  const ports = createUpdatePorts(process.env, () => spawnResult({}));
  const probe = ports.probeStorage(home);
  assert.notEqual(probe.interrupted, true, "no backup to restore => not interrupted; re-probe");
});

test("R2-F3 positive: an 'interrupted' marker WITH backup present and Home missing is still a restore", () => {
  // The genuine interrupted case remains actionable.
  const { base, home } = currentHome("yui-rr2-f3c-");
  const backupPath = join(base, "home.backup-live");
  // Move the whole Home aside so the logical Home path is gone.
  renameSync(home, backupPath);
  writeSwitchProgress(home, {
    phase: "interrupted",
    homePath: home,
    backupPath,
    stagingPath: `${home}.upgrade-staging`,
    updatedAt: "2026-08-06T12:00:00.000Z"
  });
  const ports = createUpdatePorts(process.env, () => spawnResult({}));
  const probe = ports.probeStorage(home);
  assert.equal(probe.interrupted, true);
  assert.equal(probe.backupPath, backupPath);
});

// ===========================================================================
// R2-F4 — an orphaned reclaim.lock (crashed holder) must NOT permanently block
// admission: it is reclaimed by owner-pid/age, and assertHomeWritable never
// falsely reports writable while a stale fence is still present.
// ===========================================================================

/** Seed a dead-owner (stale) fence at a Home. */
function seedStaleFence(home, reason = "stale") {
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(
    join(home, UPGRADE_FENCE_FILE),
    `${JSON.stringify({ schemaVersion: 1, ownerPid: 999999999, reason, createdAt: "" }, null, 2)}\n`
  );
}

/** Seed an ORPHANED reclaim.lock (crashed holder): dead owner + old mtime. */
function seedOrphanedReclaimLock(home, { deadOwner = true, old = true } = {}) {
  const lock = `${join(home, UPGRADE_FENCE_FILE)}.reclaim.lock`;
  mkdirSync(lock, { recursive: true });
  if (deadOwner) writeFileSync(join(lock, "owner"), "999999999\n");
  if (old) {
    const past = new Date(Date.now() - 60_000);
    utimesSync(lock, past, past);
  }
  return lock;
}

test("R2-F4 positive: an orphaned reclaim.lock (dead owner, old) does NOT block reclaiming a stale fence", () => {
  const { home } = currentHome("yui-rr2-f4a-");
  seedStaleFence(home);
  seedOrphanedReclaimLock(home, { deadOwner: true, old: true });
  // A fresh entrant must reclaim the orphaned lock, then the stale fence, and win.
  const release = placeUpgradeFence(home, {
    reason: "fresh", createdAt: "2026-08-06T00:00:00.000Z", ownerPid: process.pid
  });
  assert.equal(readUpgradeFence(home).ownerPid, process.pid, "acquired despite the orphaned reclaim.lock");
  release();
});

test("R2-F4 positive: assertHomeWritable clears a stale fence even past an orphaned reclaim.lock", () => {
  const { home } = currentHome("yui-rr2-f4b-");
  seedStaleFence(home);
  seedOrphanedReclaimLock(home, { deadOwner: true, old: true });
  // The stale (dead-owner) fence is reclaimable, so a writer must not be blocked.
  assert.doesNotThrow(() => assertHomeWritable(home, process.pid));
});

test("R2-F4 negative: assertHomeWritable does NOT report writable while a LIVE fence is present", () => {
  const { home } = currentHome("yui-rr2-f4c-");
  // A live foreign owner (pid 1 = init) holds the fence: must fail closed.
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(
    join(home, UPGRADE_FENCE_FILE),
    `${JSON.stringify({ schemaVersion: 1, ownerPid: 1, reason: "live upgrade", createdAt: "2026-08-06T00:00:00.000Z" }, null, 2)}\n`
  );
  assert.throws(() => assertHomeWritable(home, process.pid), UpgradeFenceError);
});

test("R2-F4 negative: a FRESH orphaned-looking reclaim.lock (no age) is given the benefit of the doubt", () => {
  // A reclaim.lock that is too fresh (owner may be mid-acquire) is not stolen; a
  // live reclaimer will finish. The entrant fails closed rather than racing it.
  const { home } = currentHome("yui-rr2-f4d-");
  seedStaleFence(home);
  // Fresh lock, owner is THIS live process (so processIsAlive => true): not orphaned.
  const lock = `${join(home, UPGRADE_FENCE_FILE)}.reclaim.lock`;
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner"), `${process.pid}\n`);
  // placeUpgradeFence should not reclaim a live-held lock; it fails closed on the
  // still-present stale fence rather than acquiring.
  assert.throws(
    () => placeUpgradeFence(home, { reason: "mine", createdAt: "x", ownerPid: process.pid + 1 }),
    UpgradeFenceError
  );
  // The stale fence is still there (not clobbered by a blocked reclaim).
  assert.ok(readUpgradeFence(home) !== null);
});
