import assert from "node:assert/strict";
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
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../dist/agent/agent.js";
import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION,
  ensureStorageSchema
} from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { MigrationRegistry } from "../dist/storage/migration/index.js";
import { runMigration } from "../dist/storage/migration/index.js";
import { createProductionRegistry } from "../dist/storage/migration/productionRegistry.js";
import { runStorageUpgrade } from "../dist/storage/upgrade/upgradeOrchestrator.js";
import { latestStorageVersionState } from "../dist/storage/upgrade/recordVersions.js";
import { createSqliteMigrationTarget } from "../dist/storage/upgrade/sqliteMigrationTarget.js";
import { renderUpgradeResult } from "../dist/cli/upgradeCommand.js";

const NOW = new Date("2026-08-10T00:00:00.000Z");

function tempHome(t) {
  const base = mkdtempSync(join(tmpdir(), "yui-two-path-upgrade-"));
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfig({ ...store.getConfig(), timeZone: "UTC" });
  // Issue 01: a current layout-7 Home's authoritative backend is yui.db. Build
  // it through the real 6→7 staged migration so the fixture is a genuine
  // post-migration Home (yui.db + persistent receipt, state.json retained).
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
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, home };
}

function makeCompatibleOld(home, { unknown = false } = {}) {
  const store = new FileTaskStore(home);
  store.saveConfiguredAgent(createConfiguredAgent("codex", "codex", "codex", [], [], NOW));
  const statePath = join(home, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.configuredAgents.codex.schemaVersion = 1;
  delete state.configuredAgents.codex.environment;
  if (unknown) state.configuredAgents.codex.mystery = true;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const manifestPath = join(home, "schema.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.recordVersions.configuredAgent = 1;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function compatibleRegistry() {
  const registry = new MigrationRegistry();
  registry.registerCompatible({
    axis: "record", recordKind: "configuredAgent", fromVersion: 1, toVersion: 2,
    defaults: ["environment=[]"],
    validateSource: (snapshot) => {
      for (const agent of Object.values(snapshot.state.configuredAgents)) {
        assert.deepEqual(Object.keys(agent).sort(), [
          "adapterId", "baseArgs", "command", "createdAt", "id", "schemaVersion", "updatedAt"
        ]);
        assert.equal(agent.schemaVersion, 1);
      }
    },
    normalize: (snapshot) => ({
      ...snapshot,
      schemaManifest: {
        ...snapshot.schemaManifest,
        recordVersions: {
          ...snapshot.schemaManifest.recordVersions,
          configuredAgent: 2
        }
      },
      state: {
        ...snapshot.state,
        configuredAgents: Object.fromEntries(
          Object.entries(snapshot.state.configuredAgents).map(([id, agent]) => [
            id,
            { ...agent, schemaVersion: 2, environment: [] }
          ])
        )
      }
    })
  });
  return registry;
}

test("compatible dry-run is read-only and never creates a Home migration copy", async (t) => {
  const { home } = tempHome(t);
  makeCompatibleOld(home);
  const before = readFileSync(join(home, "state.json"));
  const result = await runStorageUpgrade({
    home,
    registry: compatibleRegistry(),
    latest: latestStorageVersionState(),
    mode: "dry-run",
    inspectOfflineInventory: async () => {
      throw new Error("compatible path must not wait for Sessions");
    }
  });
  assert.equal(result.outcome, "compatible");
  assert.equal(result.classification.classification.status, "compatible-old");
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
  assert.deepEqual(readFileSync(join(home, "state.json")), before);
});

test("green compatible update preflight reports source validation without staged validation", async (t) => {
  const { home } = tempHome(t);
  makeCompatibleOld(home);
  const before = readFileSync(join(home, "state.json"));
  const result = await runStorageUpgrade({
    home,
    registry: compatibleRegistry(),
    latest: latestStorageVersionState(),
    mode: "update-preflight",
    inspectOfflineInventory: async () => {
      throw new Error("compatible update preflight must not read offline inventory");
    },
    controllerStatus: async () => {
      throw new Error("compatible update preflight must not inspect Controller lifecycle");
    }
  });

  assert.equal(result.outcome, "update-preflight");
  assert.equal(result.status, "compatible");
  const rendered = renderUpgradeResult(result, "update-preflight");
  assert.match(rendered, /classification plus compatible-source validation/i);
  assert.match(rendered, /no staged-output loader validation was performed/i);
  assert.equal(existsSync(join(home, "runtime", "upgrade-fence.json")), false);
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
  assert.deepEqual(readFileSync(join(home, "state.json")), before);
});

test("compatible execute rejects an undeclared old-shape field before any lifecycle change", async (t) => {
  const { home } = tempHome(t);
  makeCompatibleOld(home, { unknown: true });
  const before = readFileSync(join(home, "state.json"));
  let controllerReads = 0;
  const result = await runStorageUpgrade({
    home,
    registry: compatibleRegistry(),
    latest: latestStorageVersionState(),
    mode: "execute",
    controllerStatus: async () => {
      controllerReads += 1;
      return { running: false };
    }
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.classification.classification.status, "unsupported");
  assert.equal(controllerReads, 0);
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
  assert.deepEqual(readFileSync(join(home, "state.json")), before);
});

test("compatible update preflight validates the source shape before any lifecycle change", async (t) => {
  const { base, home } = tempHome(t);
  makeCompatibleOld(home, { unknown: true });
  mkdirSync(join(home, "runtime"), { recursive: true });
  const controllerDiscovery = `${JSON.stringify({ pid: process.pid })}\n`;
  writeFileSync(join(home, "runtime", "controller.json"), controllerDiscovery);
  const beforeState = readFileSync(join(home, "state.json"));
  const beforeBaseEntries = readdirSync(base).sort();
  let controllerReads = 0;
  const result = await runStorageUpgrade({
    home,
    registry: compatibleRegistry(),
    latest: latestStorageVersionState(),
    mode: "update-preflight",
    inspectOfflineInventory: async () => {
      throw new Error("compatible update preflight must not read offline inventory");
    },
    controllerStatus: async () => {
      controllerReads += 1;
      throw new Error("compatible update preflight must not inspect Controller lifecycle");
    }
  });

  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "corruption");
  assert.equal(result.classification.classification.verdict, "CORRUPTED");
  assert.equal(result.classification.classification.status, "unsupported");
  assert.match(result.message, /Compatible source validation failed/i);
  assert.equal(controllerReads, 0);
  assert.deepEqual(readdirSync(base).sort(), beforeBaseEntries);
  assert.equal(existsSync(join(home, "runtime", "upgrade-fence.json")), false);
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
  assert.equal(
    readFileSync(join(home, "runtime", "controller.json"), "utf8"),
    controllerDiscovery
  );
  assert.deepEqual(readFileSync(join(home, "state.json")), beforeState);
});

test("offline blockers are reported before Controller, fence, binary, or Home mutation", async (t) => {
  const { home } = tempHome(t);
  const latest = {
    layout: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregate: CURRENT_AGGREGATE_SCHEMA_VERSION + 1,
    record: {}
  };
  const registry = new MigrationRegistry();
  registry.registerOfflineMigration({
    axis: "aggregate",
    fromVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    toVersion: CURRENT_AGGREGATE_SCHEMA_VERSION + 1,
    preconditions: () => {},
    transform: (snapshot) => ({ ...snapshot }),
    declaredEffects: []
  });
  const beforeSchema = readFileSync(join(home, "schema.json"));
  const beforeState = readFileSync(join(home, "state.json"));
  let controllerReads = 0;
  const blocker = {
    taskId: "task-3", roleName: "worker", runId: "agent-run-7",
    nativeSessionId: "native-7", reason: "active-run"
  };
  const result = await runStorageUpgrade({
    home,
    registry,
    latest,
    mode: "execute",
    inspectOfflineInventory: async () => ({ total: 1, blockers: [blocker] }),
    controllerStatus: async () => {
      controllerReads += 1;
      return { running: false };
    }
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "active-sessions");
  assert.equal(result.classification.classification.status, "migration-required");
  assert.deepEqual(result.blockers, [blocker]);
  assert.equal(result.retryCommand, "yui update");
  assert.equal(result.sceneUnchanged, true);
  assert.equal(controllerReads, 0);
  assert.equal(existsSync(join(home, "runtime", "upgrade-fence.json")), false);
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
  assert.deepEqual(readFileSync(join(home, "schema.json")), beforeSchema);
  assert.deepEqual(readFileSync(join(home, "state.json")), beforeState);

  const rerun = await runStorageUpgrade({
    home,
    registry,
    latest,
    mode: "execute",
    controllerLifecycle: "externally-quiesced",
    inspectOfflineInventory: async () => ({ total: 0, blockers: [] })
  });
  assert.equal(rerun.outcome, "upgraded");
  assert.ok(typeof rerun.backupPath === "string" && existsSync(rerun.backupPath));
});

test("execute rechecks offline blockers after fencing the preflight race window", async (t) => {
  const { home } = tempHome(t);
  const latest = {
    layout: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregate: CURRENT_AGGREGATE_SCHEMA_VERSION + 1,
    record: {}
  };
  const registry = new MigrationRegistry();
  registry.registerOfflineMigration({
    axis: "aggregate",
    fromVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    toVersion: CURRENT_AGGREGATE_SCHEMA_VERSION + 1,
    preconditions: () => {},
    transform: (snapshot) => ({ ...snapshot }),
    declaredEffects: []
  });
  const beforeSchema = readFileSync(join(home, "schema.json"));
  const beforeState = readFileSync(join(home, "state.json"));
  const raced = {
    taskId: "task-9",
    roleName: "worker",
    runId: "agent-run-11",
    nativeSessionId: "native-11",
    launchId: "launch-11",
    reason: "active-run"
  };
  let scans = 0;

  const result = await runStorageUpgrade({
    home,
    registry,
    latest,
    mode: "execute",
    controllerLifecycle: "externally-quiesced",
    inspectOfflineInventory: async () => {
      scans += 1;
      return scans === 1
        ? { total: 0, blockers: [] }
        : { total: 1, blockers: [raced] };
    }
  });

  assert.equal(scans, 2);
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "active-sessions");
  assert.deepEqual(result.blockers, [raced]);
  assert.equal(result.retryCommand, "yui update");
  assert.equal(existsSync(join(home, "runtime", "upgrade.fence")), false);
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
  assert.deepEqual(readFileSync(join(home, "schema.json")), beforeSchema);
  assert.deepEqual(readFileSync(join(home, "state.json")), beforeState);
});
