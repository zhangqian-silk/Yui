import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
import { MigrationRegistry, createEmptyRegistry } from "../dist/storage/migration/index.js";
import { latestStorageVersionState, currentRecordVersions }
  from "../dist/storage/upgrade/recordVersions.js";
import { runStorageUpgrade } from "../dist/storage/upgrade/upgradeOrchestrator.js";
import { createHomeMigrationTarget } from "../dist/storage/upgrade/homeMigrationTarget.js";
import { renderUpgradeResult } from "../dist/cli/upgradeCommand.js";
import {
  placeUpgradeFence,
  readUpgradeFence,
  assertHomeWritable,
  UpgradeFenceError
} from "../dist/storage/upgradeFence.js";
import { runUpdate } from "../dist/cli/updateOrchestrator.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

/** Build a fresh, current, loadable Home under a temp base directory. */
function currentHome() {
  const base = mkdtempSync(join(tmpdir(), "yui-upgrade-e2e-"));
  const home = join(base, "home");
  // Isolation guard: every fixture Home MUST live under the OS temp dir so this
  // suite can never touch a real Yui Home, backup, or stable checkout.
  assert.ok(
    home.startsWith(tmpdir()),
    `test Home must be under the temp dir, got ${home}`
  );
  mkdirSync(home, { recursive: true });
  ensureStorageSchema(home);
  // Force a store write so state.json exists on disk (ensureStorageSchema only
  // writes schema.json; state.json is created on the first mutation).
  const store = new FileTaskStore(home);
  store.saveConfig({ ...store.getConfig(), timeZone: "UTC" });
  return { base, home };
}

/** Overwrite the schema manifest's version fields (to synthesize older/newer). */
function rewriteManifest(home, overrides) {
  const path = join(home, "schema.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, `${JSON.stringify({ ...manifest, ...overrides }, null, 2)}\n`);
}

/** Run the CLI with a temp Home and stripped managed env; return stdout+status. */
function runCli(home, args) {
  const env = { ...process.env, YUI_HOME: home, NO_COLOR: "1" };
  for (const name of [
    "YUI_SESSION_SCOPE", "YUI_TASK_ID", "YUI_ROLE", "YUI_AGENT_ID", "YUI_ADAPTER_ID",
    "YUI_WORKSPACE", "YUI_SESSION_TITLE", "YUI_LAUNCH_ID", "YUI_RUN_ID",
    "YUI_NATIVE_SESSION_ID", "YUI_WRITABLE_PROJECT_IDS", "YUI_CONTEXT_PROJECT_IDS",
    "YUI_WORKSPACE_PROJECTS", "FORCE_COLOR"
  ]) delete env[name];
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env,
      encoding: "utf8"
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout?.toString() ?? "" };
  }
}

/** A synthetic registry + latest state that makes a current Home "MIGRATABLE". */
function migratableSetup() {
  // Bump the aggregate axis by one and register the adjacent step, so the real
  // current Home (aggregate = N) is one step behind the synthetic latest (N+1).
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
    // Keep the on-disk aggregate at the real current version so the switched
    // Home still passes the real loader gate (which only knows the current
    // version). This is a synthetic future step exercising the switch machinery;
    // it is intentionally unrelated to the production historical graph.
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

test("doctor presents the four storage states", () => {
  const cur = currentHome();
  assert.match(runCli(cur.home, ["doctor"]).stdout, /storage compatibility.*USABLE/s);

  const fut = currentHome();
  rewriteManifest(fut.home, { aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION + 1 });
  assert.match(runCli(fut.home, ["doctor"]).stdout, /storage compatibility.*NEEDS_NEW_VERSION/s);

  const old = currentHome();
  rewriteManifest(old.home, { aggregateSchemaVersion: 7 });
  assert.match(runCli(old.home, ["doctor"]).stdout, /storage compatibility.*NEEDS_NEW_VERSION/s);

  const cor = currentHome();
  writeFileSync(join(cor.home, "state.json"), "{ broken");
  assert.match(runCli(cor.home, ["doctor"]).stdout, /storage compatibility.*CORRUPTED/s);
});

test("P1-3 --json doctor emits a machine-readable storage-health verdict and exit code", () => {
  // A healthy current Home: storage.healthy=true and exit 0.
  const cur = currentHome();
  const healthy = runCli(cur.home, ["--json", "doctor"]);
  assert.equal(healthy.status, 0);
  const healthyData = JSON.parse(healthy.stdout);
  assert.equal(healthyData.ok, true);
  assert.equal(healthyData.data.storage.healthy, true);
  assert.deepEqual(healthyData.data.storage.blocking, []);
  assert.ok(Array.isArray(healthyData.data.checks), "checks array is present");

  // A version-mismatched Home: storage.healthy=false, a blocking check, exit 5.
  const fut = currentHome();
  rewriteManifest(fut.home, { aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION + 1 });
  const unhealthy = runCli(fut.home, ["--json", "doctor"]);
  assert.equal(unhealthy.status, 5, "unhealthy storage exits non-zero under --json");
  const unhealthyData = JSON.parse(unhealthy.stdout);
  assert.equal(unhealthyData.data.storage.healthy, false);
  assert.ok(
    unhealthyData.data.storage.blocking.length > 0,
    "at least one blocking storage check is reported"
  );
});

test("upgrade --dry-run never writes output and never switches", async () => {
  const { base, home } = currentHome();
  const { latest, registry } = migratableSetup();
  const before = readdirSync(base).sort();
  const result = await runStorageUpgrade({ home, registry, latest, mode: "dry-run" });
  assert.equal(result.outcome, "dry-run");
  // No staging directory and no backup left behind; base dir unchanged.
  assert.deepEqual(readdirSync(base).sort(), before);
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
  // Source manifest still at the current (pre-synthetic) aggregate version.
  const manifest = JSON.parse(readFileSync(join(home, "schema.json"), "utf8"));
  assert.equal(manifest.aggregateSchemaVersion, CURRENT_AGGREGATE_SCHEMA_VERSION);
});

test("upgrade --dry-run preserves an active-runtime engine result as a truthful blocker", async () => {
  const { base, home } = currentHome();
  const { latest, registry } = migratableSetup();
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(
    join(home, "runtime", "controller.json"),
    `${JSON.stringify({ pid: process.pid })}\n`
  );
  const before = readdirSync(base).sort();

  const result = await runStorageUpgrade({
    home,
    registry,
    latest,
    mode: "dry-run",
    inspectOfflineInventory: async () => ({ total: 0, blockers: [] })
  });

  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "active-runtime");
  assert.equal(result.report?.outcome, "active-runtime");
  assert.deepEqual(readdirSync(base).sort(), before);
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
  const rendered = renderUpgradeResult(result, "dry-run");
  assert.match(rendered, /Dry run blocked at active-runtime/i);
  assert.doesNotMatch(rendered, /validated|loader gate/i);
});

test("internal update preflight classifies a migratable Home while its old Controller is live", async () => {
  const { base, home } = currentHome();
  const { latest, registry } = migratableSetup();
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(
    join(home, "runtime", "controller.json"),
    `${JSON.stringify({ pid: process.pid })}\n`
  );
  const before = readdirSync(base).sort();
  let lifecycleProbeCount = 0;

  const result = await runStorageUpgrade({
    home,
    registry,
    latest,
    mode: "update-preflight",
    inspectOfflineInventory: async () => ({ total: 0, blockers: [] }),
    controllerStatus: async () => {
      lifecycleProbeCount += 1;
      throw new Error("update preflight must not inspect or mutate Controller lifecycle");
    }
  });

  assert.equal(result.outcome, "update-preflight");
  assert.equal(result.status, "migration-required");
  assert.equal(result.stepCount, 1);
  assert.equal(lifecycleProbeCount, 0);
  assert.deepEqual(readdirSync(base).sort(), before);
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
  assert.equal(readUpgradeFence(home), null);
  assert.equal(
    readFileSync(join(home, "runtime", "controller.json"), "utf8"),
    `${JSON.stringify({ pid: process.pid })}\n`
  );
  const rendered = renderUpgradeResult(result, "update-preflight");
  assert.match(rendered, /classification plus a clear offline runtime inventory/i);
  assert.doesNotMatch(rendered, /validated|loader gate/i);
});

test("the staged updater's internal CLI flag emits its distinct machine contract", () => {
  const { base, home } = currentHome();
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(
    join(home, "runtime", "controller.json"),
    `${JSON.stringify({ pid: process.pid })}\n`
  );
  const before = readdirSync(base).sort();

  const command = runCli(home, ["--json", "upgrade", "--update-preflight"]);

  assert.equal(command.status, 0);
  const envelope = JSON.parse(command.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.outcome, "update-preflight");
  assert.equal(envelope.data.status, "already-current");
  assert.equal(envelope.data.stepCount, 0);
  assert.deepEqual(readdirSync(base).sort(), before);
  assert.equal(readUpgradeFence(home), null);
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
});

test("the admission fence blocks new writers and exempts its owner", () => {
  const { home } = currentHome();
  // A fence owned by another (live) process refuses writes at the store commit.
  const release = placeUpgradeFence(home, {
    reason: "test upgrade",
    createdAt: new Date().toISOString(),
    ownerPid: process.pid
  });
  // The owner (this process) is exempt; a foreign owner is refused.
  assert.doesNotThrow(() => assertHomeWritable(home, process.pid));
  assert.throws(() => assertHomeWritable(home, process.pid + 1), UpgradeFenceError);
  // A real store write from a "foreign" pid perspective: simulate by asserting
  // the fence is observed at the commit choke point via a direct store write
  // while a foreign-owned fence is present.
  release();

  const foreign = placeUpgradeFence(home, {
    reason: "foreign upgrade",
    createdAt: new Date().toISOString(),
    ownerPid: 999_999_999 // not a live pid on this host
  });
  // A fence owned by a dead pid is reclaimed, so writes proceed again.
  assert.doesNotThrow(() => assertHomeWritable(home));
  assert.equal(readUpgradeFence(home), null);
  foreign();
});

test("a live fence refuses a real FileTaskStore write", () => {
  const { home } = currentHome();
  // Place a fence owned by a *different live* pid: pid 1 (init) always exists.
  placeUpgradeFence(home, {
    reason: "live foreign upgrade",
    createdAt: new Date().toISOString(),
    ownerPid: 1
  });
  const store = new FileTaskStore(home);
  assert.throws(() => store.saveConfig({ schemaVersion: 1, timeZone: "UTC" }), /fenced/i);
});

test("quiesce fails closed when a foreign write lock is held", async () => {
  const { home } = currentHome();
  const { latest, registry } = migratableSetup();
  // Simulate another live writer holding the storage lock (owner pid 1 = init).
  mkdirSync(join(home, ".state.lock"), { recursive: true });
  writeFileSync(join(home, ".state.lock", "owner"), "1\n");
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {} // pretend controller already drained
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "active-runtime");
  // Source unchanged; no switch.
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
});

test("quiesce fails closed when a runtime lifecycle mailbox is not drained", async () => {
  const { home } = currentHome();
  const { latest, registry } = migratableSetup();
  // Inject an undrained runtime lifecycle mailbox through the real store API so
  // it is a valid record with the correct map key, then classify: an undrained
  // global-role-runtime lane must fail quiesce with drain-incomplete.
  const store = new FileTaskStore(home);
  store.saveWorkMailbox({
    schemaVersion: 1,
    target: { kind: "global-role-runtime", roleName: "operator" },
    nextSequence: 2,
    processing: null,
    pending: {
      fromSequence: 1, toSequence: 1, reasons: ["cleanup"], refs: [],
      requestCount: 1, firstQueuedAt: "2026-01-01T00:00:00.000Z",
      lastQueuedAt: "2026-01-01T00:00:00.000Z"
    }
  });
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "drain-incomplete");
});

test("a future-version Home is NEEDS_NEW_VERSION and never switches", async () => {
  const { home } = currentHome();
  rewriteManifest(home, { aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION + 1 });
  const result = await runStorageUpgrade({
    home,
    registry: createEmptyRegistry(),
    latest: latestStorageVersionState(),
    mode: "execute",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "future-version");
});

test("a corrupted Home is CORRUPTED and never switches", async () => {
  const { home } = currentHome();
  writeFileSync(join(home, "state.json"), "{ not valid json");
  const result = await runStorageUpgrade({
    home,
    registry: createEmptyRegistry(),
    latest: latestStorageVersionState(),
    mode: "execute",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "corruption");
});

test("an empty registry makes any strictly-older Home NEEDS_NEW_VERSION", async () => {
  const { home } = currentHome();
  rewriteManifest(home, { aggregateSchemaVersion: 7 });
  const result = await runStorageUpgrade({
    home,
    registry: createEmptyRegistry(),
    latest: latestStorageVersionState(),
    mode: "execute",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "missing-step");
});

test("a migratable Home switches atomically with a timestamped backup", async () => {
  const { base, home } = currentHome();
  const { latest, registry } = migratableSetup();
  const originalState = readFileSync(join(home, "state.json"), "utf8");
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {},
    now: () => new Date("2026-08-05T12:00:00.000Z")
  });
  assert.equal(result.outcome, "upgraded");
  assert.ok(result.backupPath, "a backup path is reported");
  // The timestamped backup holds the original bytes.
  assert.equal(readFileSync(join(result.backupPath, "state.json"), "utf8"), originalState);
  // The promoted Home loads through the real gate.
  assert.doesNotThrow(() => new FileTaskStore(home).listTasks());
  // Staging directory consumed by the switch.
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
  void base;
});

test("post-switch health-check failure is reported and aborts", async () => {
  const { home } = currentHome();
  const { latest } = migratableSetup();
  // A registry whose transform corrupts the fresh output so the loader gate
  // fails: the engine's validate stage catches it and never switches.
  const registry = new MigrationRegistry();
  registry.register({
    axis: "aggregate",
    fromVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    toVersion: CURRENT_AGGREGATE_SCHEMA_VERSION + 1,
    preconditions: () => {},
    transform: (snapshot) => ({
      schemaManifest: snapshot.schemaManifest,
      // Break the state so parseState throws at the validate gate.
      state: { ...snapshot.state, schemaVersion: 999 }
    }),
    declaredEffects: []
  });
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "validate");
  // Never switched: the original still loads and no backup was made.
  assert.doesNotThrow(() => new FileTaskStore(home).listTasks());
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
});

test("update keeps the old binary+Home when preflight is blocked", () => {
  let activatedBinary = false;
  let activatedStorage = false;
  const result = runUpdate(
    {
      stage: () => ({ binaryPath: "/staged/yui", version: "9.9.9" }),
      preflight: () => ({
        status: "blocked",
        stage: "future-version",
        message: "newer than supported",
        action: "install a newer release"
      }),
      activateStorage: () => { activatedStorage = true; return { status: "already-current" }; },
      activateBinary: () => { activatedBinary = true; },
      verify: () => {},
      cleanup: () => {}
    },
    { home: "/unused" }
  );
  assert.equal(result.outcome, "aborted");
  assert.equal(result.phase, "preflight");
  assert.equal(result.recoverable, true);
  assert.equal(activatedStorage, false, "storage must not be touched after a blocked preflight");
  assert.equal(activatedBinary, false, "binary must not be replaced after a blocked preflight");
});

test("update is recoverable before the switch and not auto-downgraded after writes", () => {
  // Before switch: a storage-activation failure keeps everything recoverable.
  const beforeSwitch = runUpdate(
    {
      stage: () => ({ binaryPath: "/staged/yui", version: "9.9.9" }),
      preflight: () => ({ status: "migratable", summary: "1 step" }),
      activateStorage: () => ({
        status: "blocked", stage: "active-runtime",
        message: "runtime active", action: "stop runtime"
      }),
      activateBinary: () => { throw new Error("must not run"); },
      verify: () => {},
      cleanup: () => {}
    },
    { home: "/unused" }
  );
  assert.equal(beforeSwitch.outcome, "aborted");
  assert.equal(beforeSwitch.phase, "activate-storage");
  assert.equal(beforeSwitch.recoverable, true);

  // After switch: a binary-activation failure is NOT recoverable automatically;
  // it reports a backup-based manual recovery instead of an auto-downgrade.
  const afterSwitch = runUpdate(
    {
      stage: () => ({ binaryPath: "/staged/yui", version: "9.9.9" }),
      preflight: () => ({ status: "migratable", summary: "1 step" }),
      activateStorage: () => ({ status: "migrated", backupPath: "/home.backup-x" }),
      activateBinary: () => { throw new Error("npm failed"); },
      verify: () => {},
      cleanup: () => {}
    },
    { home: "/unused" }
  );
  assert.equal(afterSwitch.outcome, "aborted");
  assert.equal(afterSwitch.phase, "activate-binary");
  assert.equal(afterSwitch.recoverable, false, "no auto-downgrade once storage switched");
  assert.match(afterSwitch.action, /restore the backup|\/home\.backup-x/);
});

test("update post-verify failure after switch points at the backup", () => {
  const result = runUpdate(
    {
      stage: () => ({ binaryPath: "/staged/yui", version: "9.9.9" }),
      preflight: () => ({ status: "migratable", summary: "1 step" }),
      activateStorage: () => ({ status: "migrated", backupPath: "/home.backup-y" }),
      activateBinary: () => {},
      verify: () => { throw new Error("loader failed"); },
      cleanup: () => {}
    },
    { home: "/unused" }
  );
  assert.equal(result.outcome, "aborted");
  assert.equal(result.phase, "post-verify");
  assert.equal(result.recoverable, false);
  assert.match(result.action, /\/home\.backup-y/);
});

test("writeFreshOutput refuses to overwrite an existing staged output", () => {
  const { home } = currentHome();
  const target = createHomeMigrationTarget({
    home,
    latest: latestStorageVersionState()
  });
  const snapshot = target.readSource();
  target.writeFreshOutput(snapshot);
  // A second write to the same staging path must refuse.
  assert.throws(() => target.writeFreshOutput(snapshot), /Refusing to overwrite/);
  target.discardFreshOutput();
});

test("readSource never mutates the source Home", () => {
  const { home } = currentHome();
  const before = readFileSync(join(home, "state.json"), "utf8");
  const target = createHomeMigrationTarget({ home, latest: latestStorageVersionState() });
  target.readSource();
  target.readSource();
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), before);
});
