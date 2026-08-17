/**
 * Tests for the SQLite-backed record migration target (Issue 01 Phase 2).
 *
 * A layout-7 Home's authoritative store is `yui.db`; `state.json` may have
 * been archived by the pseudo-layout-7 repair. These tests verify that
 * record-family migrations work on such a Home:
 *
 *  1. `readStateFromSqlite` round-trip: reconstructed state checksums match
 *     the database checksums (lossless reconstruction).
 *  2. A record migration on a SQLite-backed Home with `state.json` archived
 *     succeeds, updates `yui.db`, and leaves the archive untouched.
 *  3. A dry-run never switches and leaves no staged database.
 */
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { FileTaskStore } from "../dist/storage/taskStore.js";
import { SqliteTaskStore } from "../dist/storage/sqliteStore.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { runMigration } from "../dist/storage/migration/index.js";
import { MigrationRegistry } from "../dist/storage/migration/index.js";
import { createProductionRegistry } from "../dist/storage/migration/productionRegistry.js";
import { latestStorageVersionState, currentRecordVersions }
  from "../dist/storage/upgrade/recordVersions.js";
import { runStorageUpgrade } from "../dist/storage/upgrade/upgradeOrchestrator.js";
import { createSqliteMigrationTarget } from "../dist/storage/upgrade/sqliteMigrationTarget.js";
import {
  computeDbFamilyChecksums,
  computeStateFamilyChecksums,
  readStateFromSqlite
} from "../dist/storage/upgrade/sqliteStateMigration.js";
import { CURRENT_TASK_SCHEMA_VERSION } from "../dist/storage/taskStore.js";

const NOW = "2026-08-15T12:00:00.000Z";

// -- helpers ----------------------------------------------------------------

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), "yui-sqlite-record-migration-"));
}

/**
 * Build a current layout-7 Home with `yui.db` by running the real 6→7 staged
 * migration. The Home starts at layout 6 with a config and one task, then
 * migrates to layout 7 so `yui.db` is the authoritative store.
 */
function setupLayout7Home() {
  const home = temporaryHome();
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfig({ ...store.getConfig(), timeZone: "UTC" });
  store.saveTask({
    schemaVersion: CURRENT_TASK_SCHEMA_VERSION,
    id: "task-1",
    title: "Record migration fixture",
    projectBindings: [],
    status: "active",
    createdAt: NOW,
    updatedAt: NOW
  });

  // Downgrade to layout 6 so the 6→7 migration runs.
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
  return home;
}

/** Archive `state.json` (simulate the post-pseudo-layout-7-repair state). */
function archiveStateJson(home) {
  const statePath = join(home, "state.json");
  const archivePath = join(home, "state.json.archived");
  renameSync(statePath, archivePath);
  return archivePath;
}

// -- tests ------------------------------------------------------------------

test("readStateFromSqlite reconstructs a lossless state snapshot", () => {
  const home = setupLayout7Home();

  const state = readStateFromSqlite(home);
  const stateChecksums = computeStateFamilyChecksums(state);
  const dbChecksums = computeDbFamilyChecksums(home, "yui.db");

  // Every family must match in count and content hash.
  const families = new Set([...Object.keys(stateChecksums), ...Object.keys(dbChecksums)]);
  const mismatches = [];
  for (const family of families) {
    const e = stateChecksums[family];
    const a = dbChecksums[family];
    if (e === undefined || a === undefined || e.count !== a.count || e.hash !== a.hash) {
      mismatches.push(family);
    }
  }
  assert.deepEqual(mismatches, [], `checksum mismatch in families: ${mismatches.join(", ")}`);

  // Spot-check key reconstruction: the task and config survived.
  assert.equal(state.config.timeZone, "UTC");
  const tasks = state.tasks;
  assert.ok(tasks["task-1"], "task-1 reconstructed");
  assert.equal(tasks["task-1"].task.id, "task-1");
  assert.equal(tasks["task-1"].task.schemaVersion, CURRENT_TASK_SCHEMA_VERSION);
});

test("readStateFromSqlite opens the database read-only", () => {
  const home = setupLayout7Home();
  const before = readFileSync(join(home, "yui.db"));
  readStateFromSqlite(home);
  const after = readFileSync(join(home, "yui.db"));
  assert.deepEqual(before, after, "readStateFromSqlite must not mutate yui.db");
});

test("a record migration on a SQLite-backed Home (state.json archived) succeeds", async () => {
  const home = setupLayout7Home();
  const archivePath = archiveStateJson(home);
  const archiveBefore = readFileSync(archivePath, "utf8");

  // Synthetic record step: bump the `task` family version by one.
  const TASK_TO = CURRENT_TASK_SCHEMA_VERSION + 1;
  const latest = {
    layout: latestStorageVersionState().layout,
    aggregate: latestStorageVersionState().aggregate,
    record: {
      ...currentRecordVersions(),
      task: { version: TASK_TO, path: "state.json#/tasks/*/task" }
    }
  };
  const registry = new MigrationRegistry();
  registry.register({
    axis: "record",
    recordKind: "task",
    fromVersion: CURRENT_TASK_SCHEMA_VERSION,
    toVersion: TASK_TO,
    preconditions: () => {},
    transform: (snapshot) => {
      const state = snapshot.state;
      if (state === null) return snapshot;
      const tasks = { ...state.tasks };
      for (const [taskId, stored] of Object.entries(tasks)) {
        tasks[taskId] = {
          ...stored,
          task: { ...stored.task, schemaVersion: TASK_TO }
        };
      }
      const manifestVersions = {
        ...snapshot.schemaManifest.recordVersions,
        task: TASK_TO
      };
      return {
        schemaManifest: { ...snapshot.schemaManifest, recordVersions: manifestVersions },
        state: { ...state, tasks }
      };
    },
    declaredEffects: []
  });

  const result = await runStorageUpgrade({
    home,
    registry,
    latest,
    mode: "execute",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "upgraded");
  assert.ok(result.backupPath, "a backup path is reported");

  // The task's schemaVersion is bumped in yui.db.
  const store = new SqliteTaskStore(home);
  try {
    const tasks = store.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].schemaVersion, TASK_TO);
  } finally {
    store.close();
  }

  // The manifest's record version is advanced.
  const manifest = JSON.parse(readFileSync(join(home, "schema.json"), "utf8"));
  assert.equal(manifest.recordVersions.task, TASK_TO);

  // state.json was NOT recreated; the archive is untouched.
  assert.equal(existsSync(join(home, "state.json")), false);
  assert.equal(readFileSync(archivePath, "utf8"), archiveBefore);

  // The staged database was consumed by the switch.
  assert.equal(existsSync(join(home, "yui.db.staged")), false);
});

test("a dry-run record migration on a SQLite-backed Home never switches", async () => {
  const home = setupLayout7Home();
  archiveStateJson(home);
  const dbBefore = readFileSync(join(home, "yui.db")).toString("hex");

  const TASK_TO = CURRENT_TASK_SCHEMA_VERSION + 1;
  const latest = {
    layout: latestStorageVersionState().layout,
    aggregate: latestStorageVersionState().aggregate,
    record: {
      ...currentRecordVersions(),
      task: { version: TASK_TO, path: "state.json#/tasks/*/task" }
    }
  };
  const registry = new MigrationRegistry();
  registry.register({
    axis: "record",
    recordKind: "task",
    fromVersion: CURRENT_TASK_SCHEMA_VERSION,
    toVersion: TASK_TO,
    preconditions: () => {},
    transform: (snapshot) => {
      const state = snapshot.state;
      if (state === null) return snapshot;
      const tasks = { ...state.tasks };
      for (const [taskId, stored] of Object.entries(tasks)) {
        tasks[taskId] = {
          ...stored,
          task: { ...stored.task, schemaVersion: TASK_TO }
        };
      }
      return {
        schemaManifest: {
          ...snapshot.schemaManifest,
          recordVersions: { ...snapshot.schemaManifest.recordVersions, task: TASK_TO }
        },
        state: { ...state, tasks }
      };
    },
    declaredEffects: []
  });

  const result = await runStorageUpgrade({
    home,
    registry,
    latest,
    mode: "dry-run",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "dry-run");

  // yui.db is unchanged; no staged database remains.
  assert.equal(readFileSync(join(home, "yui.db")).toString("hex"), dbBefore);
  assert.equal(existsSync(join(home, "yui.db.staged")), false);

  // The manifest's record version is NOT advanced (no switch).
  const manifest = JSON.parse(readFileSync(join(home, "schema.json"), "utf8"));
  assert.equal(manifest.recordVersions.task, CURRENT_TASK_SCHEMA_VERSION);
});
