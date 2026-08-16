import assert from "node:assert/strict";
import test from "node:test";

import {
  createChangeSetManifest,
  validateChangeSetManifest,
  CHANGE_SET_MANIFEST_TAGS
} from "../../dist/integration/changeSetManifest.js";
import {
  createWorkItemChangeSet,
  validateChangeSet
} from "../../dist/integration/changeSet.js";
import { deriveManifestTags } from "../../dist/integration/manifestTags.js";
import { createProductionStorageRegistry } from "../../dist/storage/migration/productionRegistry.js";

const now = new Date("2026-08-13T00:00:00.000Z");
const BASE = "0".repeat(40);
const HEAD = "1".repeat(40);

function changeSetInput(overrides = {}) {
  return {
    id: "change-set-1",
    taskId: "task-1",
    workItemId: "work-item-1",
    projectId: "project-1",
    baseCommit: BASE,
    headCommit: HEAD,
    branch: "yui/task-1/main",
    changedPaths: ["src/foo.ts"],
    ...overrides
  };
}

test("tagger derives every tag category from path shape", () => {
  const cases = [
    { paths: ["src/index.ts"], expected: "contract" },
    { paths: ["src/storage/storageSchema.ts"], expected: "schema" },
    { paths: ["src/storage/migration/engine.ts"], expected: "migration" },
    { paths: ["src/commands/taskCommands.ts"], expected: "command" },
    { paths: ["test/core/foo.test.js"], expected: "test" },
    { paths: ["test/__snapshots__/bar.test.js.snap"], expected: "snapshot" },
    { paths: ["package.json"], expected: "package" }
  ];
  for (const { paths, expected } of cases) {
    const tags = deriveManifestTags({ changedPaths: paths });
    assert.ok(tags.includes(expected), `${paths[0]} should derive ${expected}, got ${tags.join(",")}`);
  }
  const withDeletion = deriveManifestTags({
    changedPaths: ["src/foo.ts", "src/old.ts"],
    deletedPaths: ["src/old.ts"]
  });
  assert.ok(withDeletion.includes("deletion"));
  assert.deepEqual([...withDeletion], [...new Set(withDeletion)]);
});

test("tagger result is sorted in the canonical tag order", () => {
  const tags = deriveManifestTags({
    changedPaths: ["package.json", "src/index.ts", "src/commands/x.ts", "test/x.test.js"]
  });
  const order = CHANGE_SET_MANIFEST_TAGS;
  const indices = tags.map((tag) => order.indexOf(tag));
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
});

test("manifest allows empty tags and rejects unknown tags", () => {
  const empty = createChangeSetManifest({ tags: [], deletedPaths: [] });
  assert.deepEqual(empty.tags, []);
  assert.throws(
    () => createChangeSetManifest({ tags: ["nope"], deletedPaths: [] }),
    /tag is invalid/
  );
  assert.throws(
    () => validateChangeSetManifest({
      schemaVersion: 1,
      tags: "schema",
      deletedPaths: [],
      evidenceRefs: []
    }),
    /tags must be an array/
  );
});

test("manifest normalizes and freezes its lists", () => {
  const manifest = createChangeSetManifest({
    tags: ["schema", "migration"],
    deletedPaths: ["src/old.ts"],
    targetRef: "master",
    evidenceRefs: ["review-round:review-round-1"]
  });
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.tags, ["schema", "migration"]);
  assert.ok(Object.isFrozen(manifest.tags));
  assert.equal(manifest.targetRef, "master");
  assert.deepEqual(manifest.evidenceRefs, ["review-round:review-round-1"]);
});

test("ChangeSet v3 accepts an optional manifest", () => {
  const withManifest = createWorkItemChangeSet(changeSetInput({
    changedPaths: ["src/foo.ts", "src/old.ts"],
    manifest: createChangeSetManifest({
      tags: ["deletion"],
      deletedPaths: ["src/old.ts"]
    })
  }), now);
  assert.equal(withManifest.schemaVersion, 3);
  assert.equal(withManifest.manifest?.deletedPaths[0], "src/old.ts");
  validateChangeSet(withManifest);

  const withoutManifest = createWorkItemChangeSet(changeSetInput(), now);
  assert.equal(withoutManifest.schemaVersion, 3);
  assert.equal(withoutManifest.manifest, undefined);
  validateChangeSet(withoutManifest);
});

test("ChangeSet v3 rejects a manifest deleted path that is not changed", () => {
  assert.throws(
    () => createWorkItemChangeSet(changeSetInput({
      manifest: createChangeSetManifest({
        tags: ["deletion"],
        deletedPaths: ["src/missing.ts"]
      })
    }), now),
    /not a changed path/
  );
});

test("changeSet 2->3 migration rewrites versions and preserves records", () => {
  const registry = createProductionStorageRegistry();
  const step = registry.lookup("record", "changeSet", 2);
  assert.ok(step, "changeSet 2->3 step must be registered");
  const legacy = {
    schemaVersion: 2,
    id: "change-set-1",
    taskId: "task-1",
    workItemId: "work-item-1",
    projectId: "project-1",
    baseCommit: BASE,
    headCommit: HEAD,
    branch: "yui/task-1/main",
    changedPaths: ["src/foo.ts"],
    createdAt: now.toISOString()
  };
  const snapshot = {
    schemaManifest: {
      schemaVersion: 1,
      storageVersion: 6,
      aggregateSchemaVersion: 18,
      recordVersions: { changeSet: 2 },
      updatedAt: now.toISOString()
    },
    state: {
      tasks: {
        "task-1": {
          changeSets: { "change-set-1": legacy }
        }
      }
    }
  };
  step.preconditions?.(snapshot);
  const migrated = step.transform(snapshot);
  assert.equal(migrated.schemaManifest.recordVersions.changeSet, 3);
  const record = migrated.state.tasks["task-1"].changeSets["change-set-1"];
  assert.equal(record.schemaVersion, 3);
  assert.equal(record.manifest, undefined);
  assert.equal(record.headCommit, HEAD);
  // A migrated legacy record (no manifest) still passes current validation.
  validateChangeSet({ ...record, schemaVersion: 3 });
});

test("changeSet 2->3 migration preconditions reject the wrong source version", () => {
  const registry = createProductionStorageRegistry();
  const step = registry.lookup("record", "changeSet", 2);
  const snapshot = {
    schemaManifest: {
      schemaVersion: 1,
      storageVersion: 6,
      aggregateSchemaVersion: 18,
      recordVersions: { changeSet: 3 },
      updatedAt: now.toISOString()
    },
    state: null
  };
  assert.throws(() => step.preconditions?.(snapshot), /requires manifest version 2/);
});

test("validateChangeSetManifest accepts the stored manifest shape", () => {
  const stored = validateChangeSetManifest({
    schemaVersion: 1,
    tags: ["contract", "test"],
    deletedPaths: [],
    evidenceRefs: []
  });
  assert.deepEqual(stored.tags, ["contract", "test"]);
});
