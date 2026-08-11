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
import { createEmptyRegistry } from "../../dist/storage/migration/index.js";
import { classifyHome } from "../../dist/storage/upgrade/homeClassification.js";
import { latestStorageVersionState } from "../../dist/storage/upgrade/recordVersions.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), "yui-storage-schema-"));
}

function writeManifest(home, overrides = {}) {
  writeFileSync(join(home, "schema.json"), JSON.stringify({
    schemaVersion: 1,
    storageVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
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
