import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
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
import { MigrationRegistry } from "../dist/storage/migration/index.js";
import { currentRecordVersions } from "../dist/storage/upgrade/recordVersions.js";
import { runStorageUpgrade } from "../dist/storage/upgrade/upgradeOrchestrator.js";
import {
  writeUpgradeReceipt,
  correlateUpgradeReceipt
} from "../dist/storage/upgrade/upgradeReceipt.js";
import { createUpdatePorts } from "../dist/cli/updatePorts.js";

// ---------------------------------------------------------------------------
// Isolation: every fixture Home lives under the OS temp dir.
// ---------------------------------------------------------------------------

function currentHome(prefix = "yui-rr3-") {
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
function fakeGlobalInstall() {
  const globalPrefix = mkdtempSync(join(tmpdir(), "yui-rr3-global-"));
  mkdirSync(join(globalPrefix, "bin"), { recursive: true });
  writeFileSync(join(globalPrefix, "bin", "yui"), "#!/bin/sh\n", { mode: 0o755 });
  return { globalPrefix, globalBinary: join(globalPrefix, "bin", "yui") };
}

// ===========================================================================
// R3-F1 — a non-concrete "version" sentinel must never be accepted; stage fails
// closed and never lets activation synthesize @zq-silk/yui@latest.
// ===========================================================================

test("R3-F1 red/green: a staged version of 'latest' fails the stage (never activates @latest)", () => {
  // The staged binary reports version "latest" (a dist-tag sentinel, not a
  // concrete version). RED before the fix: stage() would return version:"latest"
  // and activateBinary would install @zq-silk/yui@latest. GREEN: stage fails.
  const spawn = (command, args) => {
    if (command === "npm" && args[0] === "install") return spawnResult({});
    if (args.includes("version")) return okData({ version: "latest" });
    return spawnResult({});
  };
  const ports = createUpdatePorts(process.env, spawn);
  assert.throws(
    () => ports.stage(),
    /resolve the exact staged package version|Refusing to proceed with a `@latest` fallback/i
  );
});

test("R3-F1 negative: a version-probe WITHOUT an ok:true envelope is rejected (stage fails)", () => {
  // The probe returns a concrete-looking version but NOT inside a success
  // envelope ({ ok:true, data }); it must not be trusted.
  const spawn = (command, args) => {
    if (command === "npm" && args[0] === "install") return spawnResult({});
    if (args.includes("version")) return rawOut(JSON.stringify({ ok: false, data: { version: "9.9.9" } }));
    return spawnResult({});
  };
  const ports = createUpdatePorts(process.env, spawn);
  assert.throws(() => ports.stage(), /resolve the exact staged package version/i);
});

test("R3-F1 positive: a concrete semver version stages and pins that exact version", () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "npm" && args[0] === "install") return spawnResult({});
    if (args.includes("version")) return okData({ version: "1.2.3" });
    return spawnResult({});
  };
  const ports = createUpdatePorts(process.env, spawn);
  const staged = ports.stage();
  assert.equal(staged.version, "1.2.3");
  ports.activateBinary(staged);
  const install = calls.find((c) => c.command === "npm" && c.args[0] === "install"
    && c.args.includes("--global") && !c.args.includes("--prefix"));
  assert.ok(install.args.includes("@zq-silk/yui@1.2.3"));
  assert.equal(install.args.includes("@zq-silk/yui@latest"), false);
});

// ===========================================================================
// R3-F2 — post-verify must require EVERY expected storage check present-and-ok,
// not merely trust healthy:true + an empty blocking array.
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

test("R3-F2 red/green: healthy:true but a MISSING storage check fails closed", () => {
  const { globalPrefix } = fakeGlobalInstall();
  // Only one of the three expected storage checks is present; healthy:true and an
  // empty blocking array would (RED) have passed. GREEN: fail closed.
  const missingChecks = okData({
    checks: [{ name: "storage state", status: "ok", detail: "readable" }],
    storage: { healthy: true, blocking: [] }
  }, 0);
  const ports = createUpdatePorts(process.env, verifySpawnWithDoctor(globalPrefix, missingChecks));
  const staged = ports.stage();
  assert.throws(() => ports.verify(staged, "/home"),
    /missing or has malformed storage checks|every expected check present/i);
});

test("R3-F2 negative: a DUPLICATED storage check fails closed", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const dup = okData({
    checks: [
      { name: "storage schema", status: "ok", detail: "current" },
      { name: "storage compatibility", status: "ok", detail: "USABLE" },
      { name: "storage state", status: "ok", detail: "a" },
      { name: "storage state", status: "ok", detail: "b" } // duplicate
    ],
    storage: { healthy: true, blocking: [] }
  }, 0);
  const ports = createUpdatePorts(process.env, verifySpawnWithDoctor(globalPrefix, dup));
  const staged = ports.stage();
  assert.throws(() => ports.verify(staged, "/home"), /duplicated|missing or has malformed/i);
});

test("R3-F2 positive: all three expected checks present-and-ok passes", () => {
  const { globalPrefix } = fakeGlobalInstall();
  const ports = createUpdatePorts(process.env, verifySpawnWithDoctor(globalPrefix, okData(healthyDoctorData(), 0)));
  const staged = ports.stage();
  assert.doesNotThrow(() => ports.verify(staged, "/home"));
});

// ===========================================================================
// R3-F3 — preflight/activation must require an ok:true success envelope before
// trusting data.outcome.
// ===========================================================================

test("R3-F3 red/green preflight: an ok:false envelope with outcome=dry-run is BLOCKED, not trusted", () => {
  // RED: interpretPreflight trusted data.outcome regardless of ok. GREEN: blocked.
  const spawn = (command, args) => {
    if (command === "npm" && args[0] === "install") return spawnResult({});
    if (args.includes("version")) return okData({ version: "9.9.9" });
    if (args.includes("upgrade")) {
      // A well-formed dry-run outcome but wrapped in an ok:false envelope.
      return spawnResult({ status: 0, stdout: Buffer.from(JSON.stringify({ ok: false, data: { outcome: "dry-run" } })) });
    }
    return spawnResult({});
  };
  const ports = createUpdatePorts(process.env, spawn);
  const staged = ports.stage();
  const preflight = ports.preflight(staged, "/home");
  assert.equal(preflight.status, "blocked");
  assert.match(preflight.message, /did not return a valid success envelope|unverifiable/i);
});

test("R3-F3 red/green activation: an ok:false envelope with outcome=upgraded is AMBIGUOUS, not migrated", () => {
  const spawn = (command, args) => {
    if (command === "npm" && args[0] === "install") return spawnResult({});
    if (args.includes("version")) return okData({ version: "9.9.9" });
    if (args.includes("upgrade")) {
      return spawnResult({ status: 0, stdout: Buffer.from(JSON.stringify({ ok: false, data: { outcome: "upgraded" } })) });
    }
    return spawnResult({});
  };
  const ports = createUpdatePorts(process.env, spawn);
  const staged = ports.stage();
  const activation = ports.activateStorage(staged, "/home");
  assert.equal(activation.status, "ambiguous", "an ok:false success outcome must never read as migrated");
});

test("R3-F3 positive: a proper ok:true dry-run envelope is migratable", () => {
  const spawn = (command, args) => {
    if (command === "npm" && args[0] === "install") return spawnResult({});
    if (args.includes("version")) return okData({ version: "9.9.9" });
    if (args.includes("upgrade")) return okData({ outcome: "dry-run", report: { steps: [{}] } });
    return spawnResult({});
  };
  const ports = createUpdatePorts(process.env, spawn);
  const staged = ports.stage();
  const preflight = ports.preflight(staged, "/home");
  assert.equal(preflight.status, "migratable");
});

// ===========================================================================
// R3-F4 — quiesce must prove the DURABLE runtime inbox is empty, not only the
// state.json mailboxes.
// ===========================================================================

test("R3-F4 red/green: a non-empty runtime/inbox blocks the upgrade at drain-incomplete", async () => {
  const { home } = currentHome("yui-rr3-f4a-");
  const { latest, registry } = migratableSetup();
  // A durable inbox event on disk (authoritative, not-yet-applied). RED before the
  // fix: quiesce only checked mailboxes and the switch would proceed, silently
  // dropping the event. GREEN: drain-incomplete, source unchanged.
  mkdirSync(join(home, "runtime", "inbox"), { recursive: true });
  writeFileSync(
    join(home, "runtime", "inbox", "turn-abc.json"),
    JSON.stringify({ type: "native-turn-completed" })
  );
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {} // pretend controller already drained/absent
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "drain-incomplete");
  assert.match(result.message, /durable inbox/i);
  // Source unchanged: no staging, no switch.
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
});

test("R3-F4 negative: an in-progress temporary inbox write also blocks (drain-incomplete)", async () => {
  const { home } = currentHome("yui-rr3-f4b-");
  const { latest, registry } = migratableSetup();
  mkdirSync(join(home, "runtime", "inbox"), { recursive: true });
  writeFileSync(join(home, "runtime", "inbox", ".turn-x.tmp-123-abc"), "partial");
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "drain-incomplete");
});

test("R3-F4 negative: a quarantined inbox-invalid entry blocks (drain-incomplete)", async () => {
  const { home } = currentHome("yui-rr3-f4c-");
  const { latest, registry } = migratableSetup();
  mkdirSync(join(home, "runtime", "inbox-invalid"), { recursive: true });
  writeFileSync(join(home, "runtime", "inbox-invalid", "turn-bad.json.uuid"), "garbage");
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "drain-incomplete");
});

test("R3-F4 positive: an empty (or absent) runtime/inbox does not block a clean upgrade", async () => {
  const { home } = currentHome("yui-rr3-f4d-");
  const { latest, registry } = migratableSetup();
  // No inbox seeded: the upgrade proceeds and switches.
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {},
    now: () => new Date("2026-08-06T12:00:00.000Z")
  });
  assert.equal(result.outcome, "upgraded");
});

// ===========================================================================
// R3-F5 — the reclaim-lock owner file must not leak a file descriptor per
// reclaim. Bounded repeated reclaim keeps the fd count stable.
// ===========================================================================

test("R3-F5 red/green: repeated stale-fence reclaim does not leak file descriptors", async () => {
  const { placeUpgradeFence, UPGRADE_FENCE_FILE } = await import("../dist/storage/upgradeFence.js");
  const { readdirSync } = await import("node:fs");
  const fdDir = `/proc/${process.pid}/fd`;
  const countFds = () => {
    try { return readdirSync(fdDir).length; } catch { return null; }
  };

  const { home } = currentHome("yui-rr3-f5-");
  mkdirSync(join(home, "runtime"), { recursive: true });

  // Warm up once (module init / first-touch allocations) before measuring.
  seedStale(home, UPGRADE_FENCE_FILE);
  placeUpgradeFence(home, { reason: "warm", createdAt: "x", ownerPid: process.pid })();

  const before = countFds();
  // Many reclaim cycles: each seeds a fresh dead-owner fence, then a new entrant
  // reclaims it (exercising writeFenceLockOwner's open/close).
  for (let i = 0; i < 200; i += 1) {
    seedStale(home, UPGRADE_FENCE_FILE);
    placeUpgradeFence(home, { reason: `r${i}`, createdAt: "x", ownerPid: process.pid })();
  }
  const after = countFds();

  if (before !== null && after !== null) {
    // Allow a tiny slack for unrelated runtime fds; a per-reclaim leak over 200
    // iterations would blow far past this.
    assert.ok(after - before <= 5,
      `fd count must stay bounded across repeated reclaim; before=${before} after=${after}`);
  }
});

/** Seed a dead-owner (stale) fence so the reclaim path runs. */
function seedStale(home, fenceFile) {
  writeFileSync(
    join(home, fenceFile),
    `${JSON.stringify({ schemaVersion: 1, ownerPid: 999999999, reason: "stale", createdAt: "" }, null, 2)}\n`
  );
}

// ===========================================================================
// R3-F6 — receipt correlation must validate the backup is THIS Home's expected
// timestamped sibling, not merely an existing path; legacy/foreign receipts
// re-probe.
// ===========================================================================

test("R3-F6 red/green: a receipt whose backup is an UNRELATED existing dir does not correspond", () => {
  const { base, home } = currentHome("yui-rr3-f6a-");
  // An unrelated but existing directory (not `<home>.backup-*`). RED before the
  // fix: existence alone made it "correspond". GREEN: rejected -> re-probe.
  const unrelated = join(base, "some-other-dir");
  mkdirSync(unrelated, { recursive: true });
  writeUpgradeReceipt(home, {
    switched: true, homePath: home, backupPath: unrelated,
    completedAt: "2026-08-06T00:00:00.000Z"
  });
  const correlation = correlateUpgradeReceipt(home);
  assert.equal(correlation.corresponds, false);
  assert.match(correlation.reason, /expected timestamped sibling|unrelated evidence/i);
});

test("R3-F6 negative: a legacy receipt with NO homePath does not correspond (re-probe)", () => {
  const { base, home } = currentHome("yui-rr3-f6b-");
  const backup = join(base, "home.backup-2026");
  mkdirSync(backup, { recursive: true });
  // No homePath (legacy/degraded): must not be trusted even with a plausible backup.
  writeUpgradeReceipt(home, {
    switched: true, backupPath: backup,
    completedAt: "2026-08-06T00:00:00.000Z"
  });
  const correlation = correlateUpgradeReceipt(home);
  assert.equal(correlation.corresponds, false);
  assert.match(correlation.reason, /no homePath|legacy/i);
});

test("R3-F6 negative: a receipt with NO backupPath does not correspond (re-probe)", () => {
  const { home } = currentHome("yui-rr3-f6c-");
  writeUpgradeReceipt(home, {
    switched: true, homePath: home,
    completedAt: "2026-08-06T00:00:00.000Z"
  });
  const correlation = correlateUpgradeReceipt(home);
  assert.equal(correlation.corresponds, false);
  assert.match(correlation.reason, /no backupPath|cannot correlate/i);
});

test("R3-F6 negative: a receipt whose expected-sibling backup is a FILE (not a dir) does not correspond", () => {
  const { base, home } = currentHome("yui-rr3-f6d-");
  const backupFile = join(base, "home.backup-2026");
  writeFileSync(backupFile, "not a dir");
  writeUpgradeReceipt(home, {
    switched: true, homePath: home, backupPath: backupFile,
    completedAt: "2026-08-06T00:00:00.000Z"
  });
  const correlation = correlateUpgradeReceipt(home);
  assert.equal(correlation.corresponds, false);
  assert.match(correlation.reason, /absent or not a directory/i);
});

test("R3-F6 positive: a receipt with the expected `<home>.backup-*` real dir corresponds", () => {
  const { home } = currentHome("yui-rr3-f6e-");
  const backup = `${home}.backup-2026-08-06T12-00-00-000Z`;
  mkdirSync(backup, { recursive: true });
  writeUpgradeReceipt(home, {
    switched: true, homePath: home, backupPath: backup,
    completedAt: "2026-08-06T00:00:00.000Z"
  });
  const correlation = correlateUpgradeReceipt(home);
  assert.equal(correlation.corresponds, true);
  assert.equal(correlation.receipt.backupPath, backup);
});
