import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AGGREGATE_MIGRATIONS,
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION,
  CURRENT_STORAGE_SCHEMA_VERSION,
  dispatchStorageMigrations,
  dispatchAggregateMigrations,
  inspectStorageSchema,
  requireStorageSchema,
  STORAGE_MIGRATIONS
} from "../../dist/storage/storageSchema.js";

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), "yui-storage-schema-"));
}

function writeManifest(home, overrides = {}) {
  writeFileSync(join(home, "schema.json"), JSON.stringify({
    schemaVersion: 1,
    storageVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    activeGeneration: null,
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides
  }));
}

test("storage inspection keeps layout and aggregate schema versions separate", () => {
  const home = temporaryHome();
  assert.equal(CURRENT_STORAGE_SCHEMA_VERSION, CURRENT_STORAGE_LAYOUT_VERSION);
  assert.equal(CURRENT_AGGREGATE_SCHEMA_VERSION, 1);
  assert.deepEqual(STORAGE_MIGRATIONS, []);

  writeManifest(home);
  assert.deepEqual(inspectStorageSchema(home), {
    status: "current",
    currentVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    latestVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    currentLayoutVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    latestLayoutVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    currentAggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    latestAggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    activeGeneration: null,
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

test("every aggregate schema version other than 1 is rejected", () => {
  const home = temporaryHome();
  writeManifest(home, { aggregateSchemaVersion: 2 });

  assert.throws(
    () => requireStorageSchema(home),
    /aggregate schema 2 is newer than supported.*version 1/i
  );
});

test("aggregate migrations have an independent deterministic registry", () => {
  assert.deepEqual(AGGREGATE_MIGRATIONS, []);
  const migrations = [
    {
      fromVersion: 2,
      toVersion: 3,
      migrate: (state) => ({ ...state, second: true })
    },
    {
      fromVersion: 1,
      toVersion: 2,
      migrate: (state) => ({ ...state, first: true })
    }
  ];

  assert.deepEqual(
    dispatchAggregateMigrations({ schemaVersion: 1 }, 1, 3, migrations),
    { schemaVersion: 1, first: true, second: true }
  );
  assert.throws(
    () => dispatchAggregateMigrations({}, 1, 3, [migrations[1]]),
    /no migration is available/i
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
    /activeGeneration.*not supported/i
  );
});

test("migration dispatch validates the complete sequential chain before writing", () => {
  const applied = [];
  const migrations = [
    { fromVersion: 2, toVersion: 3, migrate: () => applied.push("2->3") },
    { fromVersion: 1, toVersion: 2, migrate: () => applied.push("1->2") }
  ];

  dispatchStorageMigrations("/unused", 1, 3, migrations);
  assert.deepEqual(applied, ["1->2", "2->3"]);

  applied.length = 0;
  assert.throws(
    () => dispatchStorageMigrations("/unused", 1, 3, [migrations[1]]),
    /no migration is available/i
  );
  assert.deepEqual(applied, []);
});

test("migration registry rejects ambiguous and non-sequential entries before writing", () => {
  const applied = [];
  const first = { fromVersion: 1, toVersion: 2, migrate: () => applied.push("first") };

  assert.throws(
    () => dispatchStorageMigrations("/unused", 1, 2, [
      first,
      { fromVersion: 1, toVersion: 2, migrate: () => applied.push("duplicate") }
    ]),
    /duplicate migration.*layout version 1/i
  );
  assert.deepEqual(applied, []);

  assert.throws(
    () => dispatchStorageMigrations("/unused", 1, 3, [
      { fromVersion: 1, toVersion: 3, migrate: () => applied.push("jump") }
    ]),
    /must advance exactly one layout version/i
  );
  assert.deepEqual(applied, []);
});
