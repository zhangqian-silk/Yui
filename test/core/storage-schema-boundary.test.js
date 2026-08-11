import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION,
  ensureStorageSchema,
  inspectStorageSchema,
  requireStorageSchema
} from "../../dist/storage/storageSchema.js";
import {
  createEmptyRegistry,
  createProductionRegistry
} from "../../dist/storage/migration/index.js";
import { classifyHome } from "../../dist/storage/upgrade/homeClassification.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { currentRecordVersions, latestStorageVersionState } from "../../dist/storage/upgrade/recordVersions.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), "yui-storage-schema-"));
}

function currentRecordVersionsMap() {
  const map = {};
  for (const [kind, entry] of Object.entries(currentRecordVersions())) {
    map[kind] = entry.version;
  }
  return map;
}

function writeManifest(home, overrides = {}) {
  writeFileSync(join(home, "schema.json"), JSON.stringify({
    schemaVersion: 1,
    storageVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    recordVersions: currentRecordVersionsMap(),
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides
  }));
}

test("storage inspection keeps layout and aggregate schema versions separate", () => {
  const home = temporaryHome();
  assert.equal(CURRENT_AGGREGATE_SCHEMA_VERSION, 17);

  writeManifest(home);
  assert.deepEqual(inspectStorageSchema(home), {
    status: "current",
    currentVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    latestVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    currentLayoutVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    latestLayoutVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    currentAggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    latestAggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    manifestPath: join(home, "schema.json")
  });
  assert.doesNotThrow(() => requireStorageSchema(home));
});

test("a manifest without an aggregate version is invalid in this fresh-only release", () => {
  const home = temporaryHome();
  writeManifest(home, { aggregateSchemaVersion: undefined });

  const state = inspectStorageSchema(home);
  assert.deepEqual(state, {
    status: "invalid",
    latestVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    latestLayoutVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    latestAggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    manifestPath: join(home, "schema.json"),
    detail: "Storage schema manifest is missing field: aggregateSchemaVersion"
  });
  assert.throws(() => requireStorageSchema(home), /missing field: aggregateSchemaVersion/i);
});

test("the previous aggregate schema is rejected without migration", () => {
  const home = temporaryHome();
  writeManifest(home, { aggregateSchemaVersion: 7 });

  assert.throws(
    () => requireStorageSchema(home),
    /aggregate schema 7 is older than required.*version 17.*no migration/i
  );
});

test("storage inspection rejects future layout and aggregate versions", () => {
  const home = temporaryHome();

  writeManifest(home, { storageVersion: CURRENT_STORAGE_LAYOUT_VERSION + 1 });
  assert.throws(
    () => requireStorageSchema(home),
    /storage layout .* newer than supported/i
  );

  writeManifest(home, { aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION + 1 });
  assert.throws(
    () => requireStorageSchema(home),
    /aggregate schema .* newer than supported/i
  );

  writeManifest(home, { activeGeneration: "generation-000001" });
  assert.throws(
    () => requireStorageSchema(home),
    /unknown field: activeGeneration/i
  );
});

test("storageSchema itself stays a fresh-only strict gate with no first-release logic", async () => {
  // The centralized migration framework lives in ../migration and ../upgrade, not
  // inside storageSchema. This module must not grow in-module migration dispatch
  // or any first-release / pre-release detection (formatEpoch, releaseBaselineId,
  // reset/cutover helpers) — message-8 §1/§6. It stays the strict version gate.
  const schema = await import("../../dist/storage/storageSchema.js");
  for (const forbidden of [
    "dispatchStorageMigrations",
    "dispatchAggregateMigrations",
    "STORAGE_MIGRATIONS",
    "AGGREGATE_MIGRATIONS",
    "formatEpoch",
    "releaseBaselineId",
    "resetStorage",
    "cutover"
  ]) {
    assert.equal(forbidden in schema, false, `storageSchema must not export ${forbidden}`);
  }
});

function currentHome() {
  const home = temporaryHome();
  ensureStorageSchema(home);
  // Touch the store so state.json exists and is loadable by the classifier.
  new FileTaskStore(home).getConfig();
  return home;
}

function classify(home) {
  return classifyHome({
    home,
    registry: createEmptyRegistry(),
    latest: latestStorageVersionState()
  });
}

test("a current Home classifies USABLE under the empty registry", () => {
  const result = classify(currentHome());
  assert.equal(result.classification.verdict, "USABLE");
  assert.equal(result.layoutVersion, CURRENT_STORAGE_LAYOUT_VERSION);
  assert.equal(result.aggregateVersion, CURRENT_AGGREGATE_SCHEMA_VERSION);
});

test("a manifest that omits a record family reaches the explicit introduction boundary", () => {
  const home = currentHome();
  const recordVersions = currentRecordVersionsMap();
  delete recordVersions.operatorNotification;
  writeManifest(home, { recordVersions });

  const schema = inspectStorageSchema(home);
  assert.equal(schema.status, "unsupported");
  assert.equal(schema.incompatibleComponent, "record");
  assert.equal(schema.recordFamily, "operatorNotification");
  assert.equal(schema.currentVersion, 0);

  const result = classify(home);
  assert.equal(result.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(result.classification.blocker.reason, "missing-step");
  assert.equal(result.classification.blocker.axis, "record");
  assert.equal(result.classification.blocker.recordKind, "operatorNotification");
  assert.equal(result.classification.blocker.from, 0);
  assert.equal(result.classification.blocker.to, 1);
});

test("final review policy is fenced from aggregate-v16 consumers", () => {
  const home = temporaryHome();
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfig({
    ...store.getConfig(),
    review: { roleName: "reviewer", trigger: "final" }
  });

  const current = latestStorageVersionState();
  const legacyV16 = { ...current, aggregate: 16 };
  const result = classifyHome({
    home,
    registry: createEmptyRegistry(),
    latest: legacyV16
  });

  assert.equal(result.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(result.classification.blocker.reason, "future-version");
  assert.equal(result.classification.blocker.axis, "aggregate");
  assert.equal(result.classification.blocker.found, 17);
  assert.equal(result.classification.blocker.supported, 16);
});

test("an aggregate-v16 Home containing final fails at the storage gate", () => {
  const home = temporaryHome();
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfig({
    ...store.getConfig(),
    review: { roleName: "reviewer", trigger: "final" }
  });

  const manifestPath = join(home, "schema.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.aggregateSchemaVersion = 16;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const statePath = join(home, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.schemaVersion = 16;
  writeFileSync(statePath, JSON.stringify(state));

  assert.throws(
    () => new FileTaskStore(home),
    /Aggregate schema 16 is older than required aggregate version 17/
  );
  const result = classify(home);
  assert.equal(result.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(result.classification.blocker.reason, "missing-step");
  assert.equal(result.classification.blocker.axis, "aggregate");
});
test("a strictly-older Home fails closed as NEEDS_NEW_VERSION/missing-step", () => {
  const home = currentHome();
  writeManifest(home, { aggregateSchemaVersion: 7 });
  const result = classify(home);
  assert.equal(result.classification.verdict, "NEEDS_NEW_VERSION");
  // Empty registry => no adjacent step => a precise missing-step reason, never a
  // version-magnitude guess and never CORRUPTED.
  assert.equal(result.classification.blocker.reason, "missing-step");
  assert.equal(result.incompatibleComponent, "aggregate");
});

test("a future Home fails closed as NEEDS_NEW_VERSION/future-version", () => {
  const home = currentHome();
  writeManifest(home, { aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION + 1 });
  const result = classify(home);
  assert.equal(result.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(result.classification.blocker.reason, "future-version");
  assert.equal(result.incompatibleComponent, "aggregate");
});

test("a future layout is reported against the layout component", () => {
  const home = currentHome();
  writeManifest(home, { storageVersion: CURRENT_STORAGE_LAYOUT_VERSION + 1 });
  const result = classify(home);
  assert.equal(result.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(result.incompatibleComponent, "layout");
});

test("real structural damage classifies CORRUPTED, not a version verdict", () => {
  const home = currentHome();
  // Current manifest, but a broken state.json: only a real parse/reference
  // failure is CORRUPTED. The classifier never infers corruption from versions.
  writeFileSync(join(home, "state.json"), "{ not valid json");
  const result = classify(home);
  assert.equal(result.classification.verdict, "CORRUPTED");
  assert.match(result.classification.detail, /state\.json/i);
});

/**
 * Pre-baseline boundary: a schema.json at the current layout and aggregate
 * versions but WITHOUT a recordVersions field is a pre-baseline Home. It must
 * NOT reach the strict FileTaskStore loader (which would throw
 * StorageSchemaError), and classifyHome / upgrade dry-run / doctor must return
 * a structured NEEDS_NEW_VERSION / blocked result — preserving the
 * no-fabricated-history-migration contract.
 */
function preBaselineHome() {
  const home = temporaryHome();
  writeFileSync(join(home, "schema.json"), JSON.stringify({
    schemaVersion: 1,
    storageVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    updatedAt: "2026-07-20T00:00:00.000Z"
    // NOTE: no recordVersions field — this is the pre-baseline signal.
  }));
  // state.json carries current record versions, but the manifest does not
  // declare them. The classifier must NOT trust state.json for a pre-baseline
  // Home; it must treat the record axis as pre-baseline (version 0).
  writeFileSync(join(home, "state.json"), JSON.stringify({
    schemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    config: { schemaVersion: 1, defaultAgent: "codex" },
    configuredAgents: {},
    projects: {},
    agentProfiles: {},
    globalRoles: {},
    globalRoleSessionSets: {},
    tasks: {},
    mailboxes: {}
  }));
  return home;
}

test("a pre-baseline Home (no recordVersions) classifies NEEDS_NEW_VERSION, not throws", () => {
  const home = preBaselineHome();
  // inspectStorageSchema reports unsupported on the record axis.
  const schema = inspectStorageSchema(home);
  assert.equal(schema.status, "unsupported");
  assert.equal(schema.incompatibleComponent, "record");

  // classifyHome must NOT throw StorageSchemaError and must NOT open the
  // strict FileTaskStore. It returns NEEDS_NEW_VERSION with a missing-step
  // reason because no pre-baseline->current migration steps exist.
  const result = classifyHome({
    home,
    registry: createProductionRegistry(),
    latest: latestStorageVersionState()
  });
  assert.equal(result.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(result.classification.blocker.reason, "missing-step");
  assert.equal(result.classification.blocker.axis, "record");
  assert.equal(result.incompatibleComponent, "record");
});

test("upgrade dry-run on a pre-baseline Home returns blocked, not throws", async () => {
  const home = preBaselineHome();
  const result = await runStorageUpgrade({
    home,
    registry: createProductionRegistry(),
    latest: latestStorageVersionState(),
    mode: "dry-run"
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "missing-step");
  assert.match(result.message, /no migration step/i);
});

/**
 * Manifest/state record-version mismatch: schema.json declares a record family
 * at an older version than current, but state.json carries that family at the
 * current version. The manifest's recordVersions is the authoritative
 * declaration; a disagreement with state.json means the Home is internally
 * inconsistent (a migration updated the state without updating the manifest,
 * or vice versa). This must NOT be treated as USABLE or already-current — it
 * must fail closed as CORRUPTED with clear evidence.
 */
function manifestStateMismatchHome() {
  const home = temporaryHome();
  const manifest = {
    schemaVersion: 1,
    storageVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    recordVersions: currentRecordVersionsMap(),
    updatedAt: "2026-07-20T00:00:00.000Z"
  };
  // Declare configuredAgent one version below current in the manifest.
  manifest.recordVersions.configuredAgent -= 1;
  writeFileSync(join(home, "schema.json"), JSON.stringify(manifest));
  // state.json carries configuredAgent at the CURRENT version — a mismatch.
  writeFileSync(join(home, "state.json"), JSON.stringify({
    schemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    revision: 0,
    config: { schemaVersion: 1 },
    configuredAgents: {
      claude: {
        schemaVersion: manifest.recordVersions.configuredAgent + 1,
        id: "claude",
        adapterId: "claude",
        command: "claude",
        baseArgs: [],
        environment: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    },
    projects: {},
    agentProfiles: {},
    globalRoles: {},
    globalRoleSessionSets: {},
    tasks: {},
    mailboxes: {}
  }));
  return home;
}

test("a manifest/state record-version mismatch classifies CORRUPTED, not USABLE", () => {
  const home = manifestStateMismatchHome();
  const result = classifyHome({
    home,
    registry: createProductionRegistry(),
    latest: latestStorageVersionState()
  });
  assert.equal(result.classification.verdict, "CORRUPTED");
  assert.match(result.classification.detail, /configuredAgent/);
});

test("upgrade dry-run on a manifest/state mismatch Home returns blocked, not already-current", async () => {
  const home = manifestStateMismatchHome();
  const result = await runStorageUpgrade({
    home,
    registry: createProductionRegistry(),
    latest: latestStorageVersionState(),
    mode: "dry-run"
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "corruption");
});
