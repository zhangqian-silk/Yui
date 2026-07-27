import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION,
  inspectStorageSchema,
  requireStorageSchema
} from "../../dist/storage/storageSchema.js";

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
  assert.equal(CURRENT_AGGREGATE_SCHEMA_VERSION, 6);

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
  writeManifest(home, { aggregateSchemaVersion: 5 });

  assert.throws(
    () => requireStorageSchema(home),
    /aggregate schema 5 is older than required.*version 6.*no migration/i
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

test("the development schema exposes no migration API", async () => {
  const schema = await import("../../dist/storage/storageSchema.js");
  assert.equal("dispatchStorageMigrations" in schema, false);
  assert.equal("dispatchAggregateMigrations" in schema, false);
  assert.equal("STORAGE_MIGRATIONS" in schema, false);
  assert.equal("AGGREGATE_MIGRATIONS" in schema, false);
});
