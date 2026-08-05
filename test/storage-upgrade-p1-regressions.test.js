import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureStorageSchema,
  CURRENT_STORAGE_LAYOUT_VERSION,
  CURRENT_AGGREGATE_SCHEMA_VERSION
} from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { MigrationRegistry, createEmptyRegistry, planMigration } from "../dist/storage/migration/index.js";
import {
  latestStorageVersionState,
  currentRecordVersions
} from "../dist/storage/upgrade/recordVersions.js";
import { classifyHome } from "../dist/storage/upgrade/homeClassification.js";
import { runStorageUpgrade } from "../dist/storage/upgrade/upgradeOrchestrator.js";
import {
  inspectHomeRuntime,
  homeRuntimeIsActive,
  inspectSourceVersionState
} from "../dist/storage/upgrade/homeMigrationTarget.js";
import { scanSourceRecordVersions } from "../dist/storage/upgrade/recordVersionScan.js";
import {
  readUpgradeReceipt,
  writeUpgradeReceipt,
  clearUpgradeReceipt,
  upgradeReceiptPath
} from "../dist/storage/upgrade/upgradeReceipt.js";
import { runUpdate } from "../dist/cli/updateOrchestrator.js";
import { createUpdatePorts } from "../dist/cli/updatePorts.js";

// ---------------------------------------------------------------------------
// Shared isolation helpers — every fixture Home MUST live under the OS temp dir.
// ---------------------------------------------------------------------------

/** A fresh, current, loadable Home under a temp base directory. */
function currentHome() {
  const base = mkdtempSync(join(tmpdir(), "yui-p1-"));
  const home = join(base, "home");
  assert.ok(home.startsWith(tmpdir()), `test Home must be under the temp dir, got ${home}`);
  mkdirSync(home, { recursive: true });
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfig({ ...store.getConfig(), timeZone: "UTC" });
  return { base, home };
}

/** Read + mutate + write the raw state.json (bypassing the strict store). */
function editState(home, mutate) {
  const path = join(home, "state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  mutate(state);
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Install a syntactically-valid ConfiguredAgent record at a chosen version. */
function setConfiguredAgent(home, schemaVersion) {
  editState(home, (state) => {
    state.configuredAgents = {
      claude: {
        schemaVersion,
        id: "claude",
        adapterId: "claude",
        command: "claude",
        baseArgs: [],
        environment: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    };
  });
}

const EMPTY = () => createEmptyRegistry();
const LATEST = () => latestStorageVersionState();

// ===========================================================================
// P1-1 — the record version axis is wired: a record-only-older Home is a
// version verdict, never a false CORRUPTED.
// ===========================================================================

test("P1-1 positive: a record-only-older Home is NEEDS_NEW_VERSION, not CORRUPTED", () => {
  const { home } = currentHome();
  setConfiguredAgent(home, 1); // configuredAgent latest is 2; scalar axes current.
  const result = classifyHome({ home, registry: EMPTY(), latest: LATEST() });
  assert.equal(result.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(result.classification.blocker.reason, "missing-step");
  assert.equal(result.classification.blocker.axis, "record");
  assert.equal(result.classification.blocker.recordKind, "configuredAgent");
  assert.equal(result.classification.blocker.from, 1);
  assert.equal(result.classification.blocker.to, 2);
});

test("P1-1 positive: a record-only-older Home with a registered step is MIGRATABLE", () => {
  const { home } = currentHome();
  setConfiguredAgent(home, 1);
  // A synthetic registry that supplies exactly the record step configuredAgent 1->2.
  const registry = new MigrationRegistry();
  registry.register({
    axis: "record",
    recordKind: "configuredAgent",
    fromVersion: 1,
    toVersion: 2,
    preconditions: () => {},
    transform: (snapshot) => ({ ...snapshot }),
    declaredEffects: []
  });
  const result = classifyHome({ home, registry, latest: LATEST() });
  assert.equal(result.classification.verdict, "MIGRATABLE");
  assert.equal(result.classification.stepCount, 1);
});

test("P1-1 positive: a mixed scalar+record-older Home plans in layout->aggregate->record order", () => {
  const { home } = currentHome();
  // aggregate one behind + configuredAgent one behind: a cross-axis plan.
  editState(home, (state) => { state.configuredAgents = {}; });
  setConfiguredAgent(home, 1);
  const latest = {
    layout: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregate: CURRENT_AGGREGATE_SCHEMA_VERSION + 1,
    record: currentRecordVersions()
  };
  const source = inspectSourceVersionState(home, latest);
  assert.ok("source" in source, "source versions were extracted, not a corruption");
  assert.equal(source.source.aggregate, CURRENT_AGGREGATE_SCHEMA_VERSION);
  assert.equal(source.source.record.configuredAgent.version, 1);

  const registry = new MigrationRegistry();
  registry.register({
    axis: "aggregate",
    fromVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    toVersion: CURRENT_AGGREGATE_SCHEMA_VERSION + 1,
    preconditions: () => {},
    transform: (s) => ({ ...s }),
    declaredEffects: []
  });
  registry.register({
    axis: "record",
    recordKind: "configuredAgent",
    fromVersion: 1,
    toVersion: 2,
    preconditions: () => {},
    transform: (s) => ({ ...s }),
    declaredEffects: []
  });
  const plan = planMigration(registry, source.source, latest);
  assert.equal(plan.kind, "runnable");
  assert.deepEqual(
    plan.steps.map((s) => `${s.axis}${s.recordKind ? `/${s.recordKind}` : ""}`),
    ["aggregate", "record/configuredAgent"]
  );
});

test("P1-1 negative: a structurally-broken state.json is still CORRUPTED", () => {
  const { home } = currentHome();
  writeFileSync(join(home, "state.json"), "{ not valid json");
  const result = classifyHome({ home, registry: EMPTY(), latest: LATEST() });
  assert.equal(result.classification.verdict, "CORRUPTED");
});

test("P1-1 negative: a record with a missing/invalid schemaVersion is CORRUPTED", () => {
  const { home } = currentHome();
  editState(home, (state) => {
    state.configuredAgents = { claude: { id: "claude" /* no schemaVersion */ } };
  });
  const result = classifyHome({ home, registry: EMPTY(), latest: LATEST() });
  assert.equal(result.classification.verdict, "CORRUPTED");
});

test("P1-1 negative: a record family NEWER than supported is future-version, not CORRUPTED", () => {
  const { home } = currentHome();
  setConfiguredAgent(home, 99);
  const result = classifyHome({ home, registry: EMPTY(), latest: LATEST() });
  assert.equal(result.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(result.classification.blocker.reason, "future-version");
  assert.equal(result.classification.blocker.axis, "record");
});

test("P1-1 scan: an absent/empty family is treated as already-latest", () => {
  const { home } = currentHome();
  editState(home, (state) => { state.configuredAgents = {}; });
  const scan = scanSourceRecordVersions(home, currentRecordVersions());
  assert.ok("record" in scan);
  // configuredAgent absent-on-disk collapses to the latest version (nothing to migrate).
  assert.equal(scan.record.configuredAgent.version, currentRecordVersions().configuredAgent.version);
});

test("P1-1 upgrade: a record-only-older Home blocks with missing-step and never switches", async () => {
  const { home } = currentHome();
  setConfiguredAgent(home, 1);
  const result = await runStorageUpgrade({
    home, registry: EMPTY(), latest: LATEST(), mode: "execute",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "missing-step");
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
  // The record verdict, not corruption.
  assert.equal(result.classification.classification.verdict, "NEEDS_NEW_VERSION");
});

// ===========================================================================
// P1-2 — an activation with no parseable receipt is AMBIGUOUS, never a false
// "recoverable/unchanged".
// ===========================================================================

/** Fake ports whose activateStorage is ambiguous; probe drives the resolution. */
function ambiguousPorts(probeStorage, spy = {}) {
  return {
    stage: () => ({ binaryPath: "/staged/yui", version: "9.9.9" }),
    preflight: () => ({ status: "migratable", summary: "1 step" }),
    activateStorage: () => ({ status: "ambiguous", detail: "terminated by SIGTERM" }),
    activateBinary: () => { spy.activatedBinary = true; },
    verify: () => { spy.verified = true; },
    probeStorage,
    cleanup: () => { spy.cleaned = true; }
  };
}

test("P1-2 kill-after-switch (receipt present): ambiguous, points at backup, binary NOT promoted", () => {
  const spy = {};
  const result = runUpdate(
    ambiguousPorts(() => ({ switched: true, backupPath: "/home.backup-x", schemaCurrent: true }), spy),
    { home: "/unused" }
  );
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.switched, true);
  assert.equal(result.storageBackupPath, "/home.backup-x");
  assert.match(result.action, /home\.backup-x|yui doctor/);
  assert.equal(spy.activatedBinary, undefined, "binary must NOT be promoted on an ambiguous switch");
  assert.equal(spy.cleaned, true, "staging is still cleaned up");
  // Must not masquerade as a completed update or a recoverable no-op.
  assert.notEqual(result.outcome, "updated");
  assert.equal("recoverable" in result, false);
});

test("P1-2 switch-then-crash (no receipt): ambiguous, reports likely-not-committed, never recoverable", () => {
  const result = runUpdate(
    ambiguousPorts(() => ({ switched: false, schemaCurrent: true })),
    { home: "/unused" }
  );
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.switched, false);
  assert.match(result.action, /yui doctor|re-run/);
  assert.equal("recoverable" in result, false);
});

test("P1-2 probe failure: maximum uncertainty, still ambiguous (never recoverable)", () => {
  const result = runUpdate(
    ambiguousPorts(() => { throw new Error("probe blew up"); }),
    { home: "/unused" }
  );
  assert.equal(result.outcome, "ambiguous");
  assert.match(result.message, /unknown/i);
  assert.match(result.action, /Do NOT assume/);
});

test("P1-2 interpretActivation: a signal-killed child with no JSON maps to ambiguous", () => {
  // Exercises the REAL port logic: the staged binary is killed after switching.
  const spawn = fakeSpawn({
    stageVersion: "9.9.9",
    activate: killed("SIGKILL")
  });
  const ports = createUpdatePorts(process.env, spawn);
  const activation = ports.activateStorage({ binaryPath: "/staged/yui", version: "9.9.9" }, "/home");
  assert.equal(activation.status, "ambiguous");
  assert.match(activation.detail, /SIGKILL|terminated/);
});

test("P1-2 interpretActivation: non-zero exit with garbage stdout is ambiguous, not blocked", () => {
  const spawn = fakeSpawn({ stageVersion: "9.9.9", activate: exitWith(1, "not json") });
  const ports = createUpdatePorts(process.env, spawn);
  const activation = ports.activateStorage({ binaryPath: "/staged/yui", version: "9.9.9" }, "/home");
  assert.equal(activation.status, "ambiguous");
});

test("P1-2 interpretActivation: a clean 'upgraded' receipt maps to migrated", () => {
  const spawn = fakeSpawn({
    stageVersion: "9.9.9",
    activate: okData({ outcome: "upgraded", backupPath: "/home.backup-y" })
  });
  const ports = createUpdatePorts(process.env, spawn);
  const activation = ports.activateStorage({ binaryPath: "/staged/yui", version: "9.9.9" }, "/home");
  assert.equal(activation.status, "migrated");
  assert.equal(activation.backupPath, "/home.backup-y");
});

test("P1-2 interpretActivation: a clean 'blocked' receipt stays a clean blocked", () => {
  const spawn = fakeSpawn({
    stageVersion: "9.9.9",
    activate: okData({ outcome: "blocked", stage: "active-runtime", message: "busy", action: "stop it" })
  });
  const ports = createUpdatePorts(process.env, spawn);
  const activation = ports.activateStorage({ binaryPath: "/staged/yui", version: "9.9.9" }, "/home");
  assert.equal(activation.status, "blocked");
  assert.equal(activation.stage, "active-runtime");
});

test("P1-2 receipt: round-trips at a sibling path and is cleared cleanly", () => {
  const { home } = currentHome();
  assert.equal(readUpgradeReceipt(home), null);
  assert.equal(upgradeReceiptPath(home).startsWith(tmpdir()), true);
  writeUpgradeReceipt(home, { switched: true, completedAt: "2026-08-06T00:00:00.000Z", backupPath: `${home}.backup-z` });
  const read = readUpgradeReceipt(home);
  assert.equal(read.switched, true);
  assert.equal(read.backupPath, `${home}.backup-z`);
  clearUpgradeReceipt(home);
  assert.equal(readUpgradeReceipt(home), null);
});

test("P1-2 receipt: a clean upgrade leaves NO receipt behind (written then cleared)", async () => {
  const { home } = currentHome();
  const { latest, registry } = migratableSetup();
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {},
    now: () => new Date("2026-08-06T12:00:00.000Z")
  });
  assert.equal(result.outcome, "upgraded");
  // On a fully-verified success the ambiguity marker is cleared.
  assert.equal(readUpgradeReceipt(home), null);
  assert.equal(existsSync(upgradeReceiptPath(home)), false);
});

// ===========================================================================
// P1-3 — the SAME staged artifact is promoted, and the ACTUALLY-ACTIVATED
// binary is verified (identity must match, else fail closed).
// ===========================================================================

test("P1-3 activateBinary promotes the exact staged version, not a bare @latest", () => {
  const calls = [];
  const spawn = fakeSpawn({ stageVersion: "9.9.9", record: calls });
  const ports = createUpdatePorts(process.env, spawn);
  const staged = ports.stage();
  assert.equal(staged.version, "9.9.9", "stage resolved the exact version");
  ports.activateBinary(staged);
  const install = calls.find((c) => c.command === "npm"
    && c.args[0] === "install" && c.args.includes("--global") && !c.args.includes("--prefix"));
  assert.ok(install, "a global install (activation) was invoked");
  assert.ok(
    install.args.includes("@zq-silk/yui@9.9.9"),
    `activation must pin the staged version, got ${JSON.stringify(install.args)}`
  );
  assert.equal(
    install.args.includes("@zq-silk/yui@latest"), false,
    "activation must NOT re-resolve a bare @latest"
  );
});

test("P1-3 verify runs the activated global binary (not the staging path) and matches identity", () => {
  const { globalPrefix, globalBinary } = fakeGlobalInstall("9.9.9");
  const calls = [];
  const spawn = fakeSpawn({ stageVersion: "9.9.9", globalPrefix, activatedVersion: "9.9.9", record: calls });
  const ports = createUpdatePorts(process.env, spawn);
  const staged = ports.stage();
  assert.doesNotThrow(() => ports.verify(staged, "/home"));
  // The doctor health check ran against the ACTIVATED binary, never the staging path.
  const doctor = calls.find((c) => c.args.includes("doctor"));
  assert.ok(doctor, "a doctor health check ran");
  assert.equal(doctor.command, globalBinary, "verify used the activated global binary");
  assert.notEqual(doctor.command, staged.binaryPath, "verify must NOT re-check the staging binary");
});

test("P1-3 verify fails closed when the activated binary's version differs from staged (A vs B)", () => {
  // Staged A=9.9.9 but the live global resolved to B=8.8.8 (a moved @latest).
  const { globalPrefix } = fakeGlobalInstall("8.8.8");
  const spawn = fakeSpawn({ stageVersion: "9.9.9", globalPrefix, activatedVersion: "8.8.8" });
  const ports = createUpdatePorts(process.env, spawn);
  const staged = ports.stage();
  assert.throws(() => ports.verify(staged, "/home"), /activated binary is version 8\.8\.8.*staged.*9\.9\.9/s);
});

// ===========================================================================
// P1-4 — quiesce fails closed on an undeterminable write lock / discovery.
// ===========================================================================

const NOT_ME = 424242; // a pid that is not this process (and almost surely dead).

test("P1-4 lock dir with a missing owner file is unknown-active (fail closed)", () => {
  const { home } = currentHome();
  mkdirSync(join(home, ".state.lock"));
  const signals = inspectHomeRuntime(home, NOT_ME);
  assert.deepEqual(signals.foreignWriteLock, { state: "unknown" });
  assert.equal(homeRuntimeIsActive(signals), true);
});

test("P1-4 lock dir with a non-integer owner is unknown-active (fail closed)", () => {
  const { home } = currentHome();
  mkdirSync(join(home, ".state.lock"));
  writeFileSync(join(home, ".state.lock", "owner"), "not-a-pid\n");
  const signals = inspectHomeRuntime(home, NOT_ME);
  assert.deepEqual(signals.foreignWriteLock, { state: "unknown" });
  assert.equal(homeRuntimeIsActive(signals), true);
});

test("P1-4 lock dir with an empty owner file is unknown-active (fail closed)", () => {
  const { home } = currentHome();
  mkdirSync(join(home, ".state.lock"));
  writeFileSync(join(home, ".state.lock", "owner"), "");
  const signals = inspectHomeRuntime(home, NOT_ME);
  assert.deepEqual(signals.foreignWriteLock, { state: "unknown" });
  assert.equal(homeRuntimeIsActive(signals), true);
});

test("P1-4 a malformed controller.json is unknown-active (fail closed), not 'no controller'", () => {
  const { home } = currentHome();
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(join(home, "runtime", "controller.json"), "{ broken");
  const signals = inspectHomeRuntime(home, NOT_ME);
  assert.deepEqual(signals.liveController, { state: "unknown" });
  assert.equal(homeRuntimeIsActive(signals), true);
});

test("P1-4 positive: a live owner is recognized as active", () => {
  const { home } = currentHome();
  mkdirSync(join(home, ".state.lock"));
  writeFileSync(join(home, ".state.lock", "owner"), "1\n"); // pid 1 (init) is always alive.
  const signals = inspectHomeRuntime(home, NOT_ME);
  assert.equal(signals.foreignWriteLock.state, "live");
  assert.equal(signals.foreignWriteLock.ownerPid, 1);
  assert.equal(homeRuntimeIsActive(signals), true);
});

test("P1-4 negative: a provably-dead owner is reclaimable (not active)", () => {
  const { home } = currentHome();
  mkdirSync(join(home, ".state.lock"));
  writeFileSync(join(home, ".state.lock", "owner"), "999999999\n"); // not a live pid.
  const signals = inspectHomeRuntime(home, NOT_ME);
  assert.equal(signals.foreignWriteLock, null);
  assert.equal(homeRuntimeIsActive(signals), false);
});

test("P1-4 no lock directory at all means no writer", () => {
  const { home } = currentHome();
  const signals = inspectHomeRuntime(home, NOT_ME);
  assert.equal(signals.foreignWriteLock, null);
});

test("P1-4 upgrade fails closed with active-runtime on an undeterminable lock", async () => {
  const { home } = currentHome();
  const { latest, registry } = migratableSetup();
  mkdirSync(join(home, ".state.lock")); // present but ownerless: unknown => active.
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "active-runtime");
  assert.match(result.message, /undeterminable|cannot be ruled out/i);
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
});

// ---------------------------------------------------------------------------
// Local helpers (kept at the bottom for readability).
// ---------------------------------------------------------------------------

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

// --- fake spawn plumbing for the real update ports -------------------------

function spawnResult(overrides) {
  return {
    pid: 0,
    output: [],
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
    status: 0,
    signal: null,
    ...overrides
  };
}
function okData(data) {
  return spawnResult({ stdout: Buffer.from(JSON.stringify({ ok: true, data })) });
}
function rawOut(text) {
  return spawnResult({ stdout: Buffer.from(text) });
}
function killed(signal) {
  return spawnResult({ status: null, signal });
}
function exitWith(code, text) {
  return spawnResult({ status: code, stdout: Buffer.from(text) });
}

/**
 * Build a fake spawn dispatching on (command, args). Records calls in `record`.
 * Recognizes: npm install (stage/activate), npm prefix -g, `<bin> --json version`,
 * `<bin> --json doctor`, `<bin> --json upgrade [--dry-run]`.
 */
function fakeSpawn(config) {
  const record = config.record ?? [];
  return (command, args, _options) => {
    record.push({ command, args: [...args] });
    if (command === "npm" && args[0] === "prefix") {
      return rawOut(config.globalPrefix ?? "");
    }
    if (command === "npm" && args[0] === "install") {
      return spawnResult({}); // stage / activate succeed
    }
    // A `yui` binary invocation.
    const isVersion = args.includes("version");
    const isDoctor = args.includes("doctor");
    const isUpgrade = args.includes("upgrade");
    const isGlobalBinary = config.globalPrefix !== undefined
      && command === join(config.globalPrefix, "bin", "yui");
    if (isVersion) {
      const version = isGlobalBinary
        ? (config.activatedVersion ?? config.stageVersion)
        : config.stageVersion;
      return okData({ version });
    }
    if (isDoctor) {
      // The real `--json doctor` returns { checks, storage: { healthy, blocking } };
      // the post-verify parses storage.healthy (P1-3). Default to healthy unless a
      // test overrides config.doctor to inject an unhealthy or unparseable result.
      return config.doctor ?? okData({
        checks: [{ name: "storage state", status: "ok", detail: "readable" }],
        storage: { healthy: true, blocking: [] }
      });
    }
    if (isUpgrade) {
      return config.activate ?? okData({ outcome: "already-current" });
    }
    return spawnResult({});
  };
}

/** Create a temp global prefix with a real bin/yui file so existsSync passes. */
function fakeGlobalInstall(_version) {
  const globalPrefix = mkdtempSync(join(tmpdir(), "yui-global-"));
  mkdirSync(join(globalPrefix, "bin"), { recursive: true });
  writeFileSync(join(globalPrefix, "bin", "yui"), "#!/bin/sh\n", { mode: 0o755 });
  return { globalPrefix, globalBinary: join(globalPrefix, "bin", "yui") };
}
