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
import {
  currentRecordVersions,
  latestStorageVersionState
} from "../../dist/storage/upgrade/recordVersions.js";
import { inspectSourceVersionState } from "../../dist/storage/upgrade/homeMigrationTarget.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), "yui-storage-schema-"));
}

function writeManifest(home, overrides = {}) {
  writeFileSync(join(home, "schema.json"), JSON.stringify({
    schemaVersion: 1,
    storageVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    recordVersions: currentRecordVersionManifest(),
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides
  }));
}

function currentRecordVersionManifest() {
  return Object.fromEntries(
    Object.entries(currentRecordVersions()).map(([kind, { version }]) => [kind, version])
  );
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
  // Read the default config once; tests that need state.json persist it explicitly.
  new FileTaskStore(home).getConfig();
  return home;
}

function setConfiguredAgentMemberVersions(home, versions) {
  const store = new FileTaskStore(home);
  store.saveConfig(store.getConfig());
  const path = join(home, "state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.configuredAgents = Object.fromEntries(versions.map((schemaVersion, index) => [
    `agent-${index + 1}`,
    { schemaVersion }
  ]));
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
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

test("a persisted manifest omission becomes explicit record-family version 0", () => {
  const home = currentHome();
  const recordVersions = currentRecordVersionManifest();
  delete recordVersions.operatorNotification;
  writeManifest(home, { recordVersions });

  const inspected = inspectSourceVersionState(home, latestStorageVersionState());
  assert.ok("source" in inspected);
  assert.equal(inspected.source.record.operatorNotification.version, 0);

  const result = classify(home);
  assert.equal(result.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(result.classification.blocker.reason, "missing-step");
  assert.equal(result.classification.blocker.axis, "record");
  assert.equal(result.classification.blocker.recordKind, "operatorNotification");
  assert.equal(result.classification.blocker.from, 0);
  assert.equal(result.classification.blocker.to, 1);
});

test("record-version manifests fail closed on malformed, unknown, and future families", () => {
  const malformed = currentHome();
  writeManifest(malformed, {
    recordVersions: {
      ...currentRecordVersionManifest(),
      operatorNotification: 0
    }
  });
  assert.equal(classify(malformed).classification.verdict, "CORRUPTED");

  const unknown = currentHome();
  writeManifest(unknown, {
    recordVersions: {
      ...currentRecordVersionManifest(),
      mysteryFamily: 1
    }
  });
  assert.equal(classify(unknown).classification.verdict, "CORRUPTED");

  const future = currentHome();
  writeManifest(future, {
    recordVersions: {
      ...currentRecordVersionManifest(),
      operatorNotification: currentRecordVersions().operatorNotification.version + 1
    }
  });
  const futureResult = classify(future);
  assert.equal(futureResult.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(futureResult.classification.blocker.reason, "future-version");
  assert.equal(futureResult.classification.blocker.recordKind, "operatorNotification");
});

test("mixed record-family members are corruption even when the manifest matches the minimum", () => {
  const home = currentHome();
  setConfiguredAgentMemberVersions(home, [1, 2]);
  writeManifest(home, {
    recordVersions: {
      ...currentRecordVersionManifest(),
      configuredAgent: 1
    }
  });

  const inspected = inspectSourceVersionState(home, latestStorageVersionState());
  assert.ok("corruption" in inspected);
  assert.match(inspected.corruption.detail, /configuredAgent.*mixed.*1.*2/i);
  assert.equal(classify(home).classification.verdict, "CORRUPTED");
});

test("mixed record-family members are corruption even when the manifest matches the maximum", () => {
  const home = currentHome();
  setConfiguredAgentMemberVersions(home, [2, 3]);
  writeManifest(home, {
    recordVersions: {
      ...currentRecordVersionManifest(),
      configuredAgent: 3
    }
  });

  const inspected = inspectSourceVersionState(home, latestStorageVersionState());
  assert.ok("corruption" in inspected);
  assert.match(inspected.corruption.detail, /configuredAgent.*mixed.*2.*3/i);
  assert.equal(classify(home).classification.verdict, "CORRUPTED");
});

test("the compatible store seam never bypasses a future record version", () => {
  const home = currentHome();
  writeManifest(home, {
    recordVersions: {
      ...currentRecordVersionManifest(),
      operatorNotification: currentRecordVersions().operatorNotification.version + 1
    }
  });

  assert.throws(
    () => new FileTaskStore(home, { normalizeState: (raw) => raw }),
    /newer than supported/i
  );
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

function preBaselineHome() {
  const home = temporaryHome();
  writeFileSync(join(home, "schema.json"), JSON.stringify({
    schemaVersion: 1,
    storageVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    updatedAt: "2026-07-20T00:00:00.000Z"
  }));
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

test("a pre-baseline Home reaches the explicit introduction boundary", () => {
  const home = preBaselineHome();
  const schema = inspectStorageSchema(home);
  assert.equal(schema.status, "unsupported");
  assert.equal(schema.incompatibleComponent, "record");

  const result = classifyHome({
    home,
    registry: createProductionRegistry(),
    latest: latestStorageVersionState()
  });
  assert.equal(result.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(result.classification.blocker.reason, "missing-step");
  assert.equal(result.classification.blocker.axis, "record");
});

test("upgrade dry-run blocks a pre-baseline Home without throwing", async () => {
  const result = await runStorageUpgrade({
    home: preBaselineHome(),
    registry: createProductionRegistry(),
    latest: latestStorageVersionState(),
    mode: "dry-run"
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "missing-step");
});

function manifestStateMismatchHome() {
  const home = currentHome();
  const store = new FileTaskStore(home);
  store.saveConfig(store.getConfig());
  const manifestPath = join(home, "schema.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.recordVersions.configuredAgent -= 1;
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const statePath = join(home, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.configuredAgents = {
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
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return home;
}

test("a non-empty manifest/state version mismatch is corruption", () => {
  const result = classifyHome({
    home: manifestStateMismatchHome(),
    registry: createProductionRegistry(),
    latest: latestStorageVersionState()
  });
  assert.equal(result.classification.verdict, "CORRUPTED");
  assert.match(result.classification.detail, /configuredAgent/);
});

test("upgrade dry-run blocks a manifest/state mismatch", async () => {
  const result = await runStorageUpgrade({
    home: manifestStateMismatchHome(),
    registry: createProductionRegistry(),
    latest: latestStorageVersionState(),
    mode: "dry-run"
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "corruption");
});
