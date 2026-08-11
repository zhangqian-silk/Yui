import assert from "node:assert/strict";
import test from "node:test";

import {
  MigrationRegistry,
  classifyStorage,
  loadCompatibleSnapshot,
  writeCurrentSnapshot
} from "../../dist/storage/migration/index.js";

const SOURCE = {
  layout: 1,
  aggregate: 1,
  record: {
    task: { version: 1, path: "state.json#/tasks" }
  }
};

const TARGET = {
  layout: 1,
  aggregate: 1,
  record: {
    task: { version: 2, path: "state.json#/tasks" }
  }
};

const INTRODUCTION_SOURCE = {
  layout: 1,
  aggregate: 1,
  record: {}
};

const INTRODUCTION_TARGET = {
  layout: 1,
  aggregate: 1,
  record: {
    widget: { version: 1, path: "state.json#/widgets" }
  }
};

test("a target-only record family without an introduction declaration fails closed", () => {
  const classification = classifyStorage(
    new MigrationRegistry(),
    INTRODUCTION_SOURCE,
    INTRODUCTION_TARGET
  );

  assert.equal(classification.status, "unsupported");
  assert.equal(classification.blocker.reason, "missing-step");
  assert.equal(classification.blocker.axis, "record");
  assert.equal(classification.blocker.recordKind, "widget");
  assert.equal(classification.blocker.from, 0);
  assert.equal(classification.blocker.to, 1);
});

test("an explicit compatible 0->1 introduction normalizes deterministically", () => {
  const registry = new MigrationRegistry();
  registry.registerCompatible({
    axis: "record",
    recordKind: "widget",
    fromVersion: 0,
    toVersion: 1,
    introduction: true,
    defaults: ["widgets={}"],
    validateSource: (snapshot) => {
      assert.equal(snapshot.schemaManifest.recordVersions.widget, undefined);
      assert.equal(snapshot.state.widgets, undefined);
    },
    normalize: (snapshot) => ({
      schemaManifest: {
        ...snapshot.schemaManifest,
        recordVersions: {
          ...snapshot.schemaManifest.recordVersions,
          widget: 1
        }
      },
      state: { ...snapshot.state, widgets: {} }
    })
  });
  const sourceSnapshot = {
    schemaManifest: { recordVersions: {} },
    state: {}
  };
  const inspectVersions = (snapshot) => ({
    ...INTRODUCTION_TARGET,
    record: {
      widget: {
        version: snapshot.schemaManifest.recordVersions.widget ?? 0,
        path: "state.json#/widgets"
      }
    }
  });

  const normalized = loadCompatibleSnapshot({
    registry,
    source: {
      ...INTRODUCTION_SOURCE,
      record: { widget: { version: 0, path: "state.json#/widgets" } }
    },
    latest: INTRODUCTION_TARGET,
    snapshot: sourceSnapshot,
    inspectVersions,
    validateCurrent: (snapshot) => {
      assert.equal(snapshot.schemaManifest.recordVersions.widget, 1);
      assert.deepEqual(snapshot.state.widgets, {});
    }
  });

  assert.deepEqual(normalized, {
    schemaManifest: { recordVersions: { widget: 1 } },
    state: { widgets: {} }
  });
  assert.deepEqual(sourceSnapshot, {
    schemaManifest: { recordVersions: {} },
    state: {}
  });
});

test("an explicit offline 0->1 introduction selects the offline path and needs a transform", () => {
  const declarationOnly = new MigrationRegistry();
  declarationOnly.declareOfflineMigration({
    axis: "record",
    recordKind: "widget",
    fromVersion: 0,
    toVersion: 1,
    introduction: true
  });
  const missingTransform = classifyStorage(
    declarationOnly,
    INTRODUCTION_SOURCE,
    INTRODUCTION_TARGET
  );
  assert.equal(missingTransform.status, "unsupported");
  assert.equal(missingTransform.blocker.reason, "missing-step");

  const registry = new MigrationRegistry();
  registry.registerOfflineMigration({
    axis: "record",
    recordKind: "widget",
    fromVersion: 0,
    toVersion: 1,
    introduction: true,
    preconditions: () => {},
    transform: (snapshot) => ({ ...snapshot }),
    declaredEffects: []
  });
  const classification = classifyStorage(
    registry,
    INTRODUCTION_SOURCE,
    INTRODUCTION_TARGET
  );
  assert.equal(classification.status, "migration-required");
  assert.equal(classification.stepCount, 1);
});

test("an explicitly compatible adjacent record change is compatible-old", () => {
  const registry = new MigrationRegistry();
  registry.registerCompatible({
    axis: "record",
    recordKind: "task",
    fromVersion: 1,
    toVersion: 2,
    defaults: ["labels=[]"],
    validateSource: () => {},
    normalize: (snapshot) => ({
      ...snapshot,
      schemaVersion: 2,
      labels: snapshot.labels ?? []
    })
  });

  const classification = classifyStorage(registry, SOURCE, TARGET);
  assert.equal(classification.status, "compatible-old");
});

test("multiple compatible hops stay online while one offline hop selects migration", () => {
  const source = {
    ...SOURCE,
    record: { task: { version: 1, path: "state.json#/tasks" } }
  };
  const target = {
    ...TARGET,
    record: { task: { version: 3, path: "state.json#/tasks" } }
  };
  const compatible = new MigrationRegistry();
  compatible.registerCompatible({
    axis: "record", recordKind: "task", fromVersion: 1, toVersion: 2,
    defaults: ["labels=[]"], validateSource: () => {},
    normalize: (value) => ({ ...value, schemaVersion: 2 })
  });
  compatible.registerCompatible({
    axis: "record", recordKind: "task", fromVersion: 2, toVersion: 3,
    defaults: ["owner=null"], validateSource: () => {},
    normalize: (value) => ({ ...value, schemaVersion: 3 })
  });
  assert.equal(classifyStorage(compatible, source, target).status, "compatible-old");

  const mixed = new MigrationRegistry();
  mixed.registerCompatible({
    axis: "record", recordKind: "task", fromVersion: 1, toVersion: 2,
    defaults: ["labels=[]"], validateSource: () => {},
    normalize: (value) => ({ ...value, schemaVersion: 2 })
  });
  mixed.registerOfflineMigration({
    axis: "record", recordKind: "task", fromVersion: 2, toVersion: 3,
    preconditions: () => {},
    transform: (value) => ({ ...value, schemaVersion: 3 }),
    declaredEffects: []
  });
  assert.equal(classifyStorage(mixed, source, target).status, "migration-required");
});

test("a transform without a declaration and an offline declaration without a step fail closed", () => {
  const orphanTransform = new MigrationRegistry();
  orphanTransform.registerMigrationStep({
    axis: "record", recordKind: "task", fromVersion: 1, toVersion: 2,
    preconditions: () => {}, transform: (value) => ({ ...value }), declaredEffects: []
  });
  const missingDeclaration = classifyStorage(orphanTransform, SOURCE, TARGET);
  assert.equal(missingDeclaration.status, "unsupported");
  assert.equal(missingDeclaration.blocker.reason, "missing-declaration");

  const orphanDeclaration = new MigrationRegistry();
  orphanDeclaration.declareOfflineMigration({
    axis: "record", recordKind: "task", fromVersion: 1, toVersion: 2
  });
  const missingStep = classifyStorage(orphanDeclaration, SOURCE, TARGET);
  assert.equal(missingStep.status, "unsupported");
  assert.equal(missingStep.blocker.reason, "missing-step");
});

test("compatible declarations reject scalar axes at the runtime API boundary", () => {
  const registry = new MigrationRegistry();
  assert.throws(
    () => registry.registerCompatible({
      axis: "aggregate",
      fromVersion: 1,
      toVersion: 2,
      defaults: ["value=[]"],
      validateSource: () => {},
      normalize: (value) => ({ ...value })
    }),
    /record axis/i
  );
  assert.equal(registry.isEmpty(), true);
});

test("a failed combined registration does not leave a runnable partial declaration", () => {
  const registry = new MigrationRegistry();
  const transform = {
    axis: "record", recordKind: "task", fromVersion: 1, toVersion: 2,
    preconditions: () => {}, transform: (value) => ({ ...value }), declaredEffects: []
  };
  registry.registerMigrationStep(transform);
  assert.throws(() => registry.registerOfflineMigration(transform), /already registered/i);

  const classification = classifyStorage(registry, SOURCE, TARGET);
  assert.equal(classification.status, "unsupported");
  assert.equal(classification.blocker.reason, "missing-declaration");
});

test("compatible loading normalizes to the current model and writing emits only current records", () => {
  const registry = new MigrationRegistry();
  registry.registerCompatible({
    axis: "record",
    recordKind: "task",
    fromVersion: 1,
    toVersion: 2,
    defaults: ["labels=[]"],
    validateSource: () => {},
    normalize: (record) => ({ schemaVersion: 2, id: record.id, labels: record.labels ?? [] })
  });
  const inspectVersions = (record) => ({
    ...TARGET,
    record: {
      task: { version: record.schemaVersion, path: "state.json#/tasks" }
    }
  });
  const validateCurrent = (record) => {
    assert.deepEqual(Object.keys(record).sort(), ["id", "labels", "schemaVersion"]);
    assert.equal(record.schemaVersion, 2);
    assert.ok(Array.isArray(record.labels));
  };

  const model = loadCompatibleSnapshot({
    registry,
    source: SOURCE,
    latest: TARGET,
    snapshot: { schemaVersion: 1, id: "task-1" },
    inspectVersions,
    validateCurrent
  });
  assert.deepEqual(model, { schemaVersion: 2, id: "task-1", labels: [] });

  const stored = writeCurrentSnapshot({
    model,
    latest: TARGET,
    encode: (current) => ({ ...current }),
    inspectVersions,
    validateCurrent
  });
  assert.deepEqual(stored, model);
});
