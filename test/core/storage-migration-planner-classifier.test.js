import assert from "node:assert/strict";
import test from "node:test";

import {
  MigrationRegistry,
  MigrationRegistryError,
  classifyStorage,
  createEmptyRegistry,
  latestScalarVersions,
  planMigration
} from "../../dist/storage/migration/index.js";
import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION
} from "../../dist/storage/storageSchema.js";

// ---------------------------------------------------------------------------
// Synthetic, fully isolated version fixtures. These use hand-made version
// numbers and record families with NO relationship to any real historical
// on-disk format — the framework is future-facing and the registry ships empty.
// ---------------------------------------------------------------------------

function versionState({ layout = 1, aggregate = 1, record = {} } = {}) {
  return { layout, aggregate, record };
}

function recordEntry(version, path) {
  return { version, path };
}

/** A no-op-transform step whose only job is to advance one adjacent version. */
function scalarStep(axis, fromVersion, declaredEffects = []) {
  return {
    axis,
    fromVersion,
    toVersion: fromVersion + 1,
    preconditions: (input) => {
      if (input[axis] !== fromVersion) {
        throw new Error(`precondition: expected ${axis}=${fromVersion}`);
      }
    },
    transform: (input) => ({ ...input, [axis]: fromVersion + 1 }),
    declaredEffects
  };
}

function recordStep(recordKind, fromVersion, declaredEffects = []) {
  return {
    axis: "record",
    recordKind,
    fromVersion,
    toVersion: fromVersion + 1,
    preconditions: () => {},
    transform: (input) => ({
      ...input,
      record: {
        ...input.record,
        [recordKind]: {
          ...input.record[recordKind],
          version: fromVersion + 1
        }
      }
    }),
    declaredEffects
  };
}

// ---------------------------------------------------------------------------
// Registry: adjacency + discoverability, no version-magnitude guessing.
// ---------------------------------------------------------------------------

test("a fresh registry is EMPTY and discovers nothing", () => {
  const registry = createEmptyRegistry();
  assert.equal(registry.isEmpty(), true);
  assert.equal(registry.size, 0);
  assert.equal(registry.lookup("aggregate", undefined, 1), undefined);
  assert.equal(registry.lookup("record", "widget", 1), undefined);
});

test("registry rejects non-adjacent, wrong-axis, and duplicate steps", () => {
  const registry = new MigrationRegistry();

  assert.throws(
    () =>
      registry.register({
        axis: "aggregate",
        fromVersion: 1,
        toVersion: 3,
        preconditions: () => {},
        transform: (x) => ({ ...x }),
        declaredEffects: []
      }),
    MigrationRegistryError
  );
  assert.throws(
    () =>
      registry.register({
        axis: "aggregate",
        recordKind: "widget",
        fromVersion: 1,
        toVersion: 2,
        preconditions: () => {},
        transform: (x) => ({ ...x }),
        declaredEffects: []
      }),
    /must not declare a recordKind/
  );
  assert.throws(
    () =>
      registry.register({
        axis: "record",
        fromVersion: 1,
        toVersion: 2,
        preconditions: () => {},
        transform: (x) => ({ ...x }),
        declaredEffects: []
      }),
    /must declare a non-empty recordKind/
  );

  registry.register(scalarStep("aggregate", 1));
  assert.throws(() => registry.register(scalarStep("aggregate", 1)), /already registered/);
  assert.equal(registry.size, 1);
});

test("registry lookup returns only the exact adjacent step, never inferred by magnitude", () => {
  const registry = new MigrationRegistry();
  registry.register(scalarStep("aggregate", 1));
  registry.register(scalarStep("aggregate", 2));

  assert.notEqual(registry.lookup("aggregate", undefined, 1), undefined);
  assert.notEqual(registry.lookup("aggregate", undefined, 2), undefined);
  // No step registered from 3 even though 1->2 and 2->3 exist: no guessing.
  assert.equal(registry.lookup("aggregate", undefined, 3), undefined);
});

// ---------------------------------------------------------------------------
// Planner: multi-step chaining, missing-step, future-version, deterministic
// cross-axis order with aggregate -> nested-record dependency.
// ---------------------------------------------------------------------------

test("planner chains adjacent steps v1->v2->v3 in order", () => {
  const registry = new MigrationRegistry();
  registry.register(scalarStep("aggregate", 1));
  registry.register(scalarStep("aggregate", 2));

  const plan = planMigration(registry, versionState({ aggregate: 1 }), versionState({ aggregate: 3 }));
  assert.equal(plan.kind, "runnable");
  assert.deepEqual(
    plan.steps.map((s) => [s.axis, s.fromVersion, s.toVersion]),
    [
      ["aggregate", 1, 2],
      ["aggregate", 2, 3]
    ]
  );
});

test("planner is a no-op when every axis is already current", () => {
  const registry = new MigrationRegistry();
  const state = versionState({ layout: 2, aggregate: 3, record: { widget: recordEntry(1, "w") } });
  const plan = planMigration(registry, state, state);
  assert.equal(plan.kind, "no-op");
});

test("planner fails closed with missing-step when a chain link is absent", () => {
  const registry = new MigrationRegistry();
  registry.register(scalarStep("aggregate", 1)); // 1->2 only; 2->3 missing

  const plan = planMigration(registry, versionState({ aggregate: 1 }), versionState({ aggregate: 3 }));
  assert.equal(plan.kind, "blocked");
  assert.equal(plan.blocker.reason, "missing-step");
  assert.equal(plan.blocker.axis, "aggregate");
  assert.equal(plan.blocker.from, 2);
  assert.equal(plan.blocker.to, 3);
  assert.match(plan.blocker.action, /newer release/i);
});

test("planner fails closed with future-version when source is newer than supported", () => {
  const registry = new MigrationRegistry();
  const plan = planMigration(registry, versionState({ aggregate: 5 }), versionState({ aggregate: 4 }));
  assert.equal(plan.kind, "blocked");
  assert.equal(plan.blocker.reason, "future-version");
  assert.equal(plan.blocker.found, 5);
  assert.equal(plan.blocker.supported, 4);
});

test("planner orders layout -> aggregate -> nested record families deterministically", () => {
  const registry = new MigrationRegistry();
  registry.register(scalarStep("layout", 1));
  registry.register(scalarStep("aggregate", 1));
  registry.register(scalarStep("aggregate", 2));
  registry.register(recordStep("beta", 1));
  registry.register(recordStep("alpha", 1));
  registry.register(recordStep("alpha", 2));

  const source = versionState({
    layout: 1,
    aggregate: 1,
    record: { beta: recordEntry(1, "b"), alpha: recordEntry(1, "a") }
  });
  const target = versionState({
    layout: 2,
    aggregate: 3,
    record: { beta: recordEntry(2, "b"), alpha: recordEntry(3, "a") }
  });

  const plan = planMigration(registry, source, target);
  assert.equal(plan.kind, "runnable");
  assert.deepEqual(
    plan.steps.map((s) => [s.axis, s.recordKind ?? null, s.fromVersion, s.toVersion]),
    [
      ["layout", null, 1, 2],
      ["aggregate", null, 1, 2],
      ["aggregate", null, 2, 3],
      // record families come AFTER the aggregate, sorted by kind (alpha < beta),
      // each ascending by version — nested-record depends on its container.
      ["record", "alpha", 1, 2],
      ["record", "alpha", 2, 3],
      ["record", "beta", 1, 2]
    ]
  );

  // Deterministic: planning again yields an identical order.
  const again = planMigration(registry, source, target);
  assert.deepEqual(
    again.steps.map((s) => [s.axis, s.recordKind ?? null, s.fromVersion, s.toVersion]),
    plan.steps.map((s) => [s.axis, s.recordKind ?? null, s.fromVersion, s.toVersion])
  );
});

test("planner blocks when a nested record family has a broken chain even if scalars are fine", () => {
  const registry = new MigrationRegistry();
  registry.register(scalarStep("aggregate", 1));
  registry.register(recordStep("widget", 1)); // 1->2 only; widget 2->3 missing

  const source = versionState({ aggregate: 1, record: { widget: recordEntry(1, "w") } });
  const target = versionState({ aggregate: 2, record: { widget: recordEntry(3, "w") } });
  const plan = planMigration(registry, source, target);
  assert.equal(plan.kind, "blocked");
  assert.equal(plan.blocker.reason, "missing-step");
  assert.equal(plan.blocker.axis, "record");
  assert.equal(plan.blocker.recordKind, "widget");
  assert.equal(plan.blocker.from, 2);
});

// ---------------------------------------------------------------------------
// Classifier: the four states, pure. CORRUPTED only when the caller signals it.
// ---------------------------------------------------------------------------

test("classifier: USABLE when every axis equals the current version", () => {
  const registry = createEmptyRegistry();
  const state = versionState({ layout: 2, aggregate: 3 });
  assert.deepEqual(classifyStorage(registry, state, state), { verdict: "USABLE" });
});

test("classifier: MIGRATABLE when strictly older with a complete step path", () => {
  const registry = new MigrationRegistry();
  registry.register(scalarStep("aggregate", 1));
  registry.register(scalarStep("aggregate", 2));
  const result = classifyStorage(
    registry,
    versionState({ aggregate: 1 }),
    versionState({ aggregate: 3 })
  );
  assert.equal(result.verdict, "MIGRATABLE");
  assert.equal(result.stepCount, 2);
});

test("classifier: NEEDS_NEW_VERSION with future-version reason when source is newer", () => {
  const registry = createEmptyRegistry();
  const result = classifyStorage(
    registry,
    versionState({ layout: 9 }),
    versionState({ layout: 6 })
  );
  assert.equal(result.verdict, "NEEDS_NEW_VERSION");
  assert.equal(result.blocker.reason, "future-version");
  assert.equal(result.blocker.axis, "layout");
});

test("classifier: NEEDS_NEW_VERSION with missing-step reason when older with a broken path", () => {
  const registry = new MigrationRegistry();
  registry.register(scalarStep("aggregate", 1)); // no 2->3
  const result = classifyStorage(
    registry,
    versionState({ aggregate: 1 }),
    versionState({ aggregate: 3 })
  );
  assert.equal(result.verdict, "NEEDS_NEW_VERSION");
  assert.equal(result.blocker.reason, "missing-step");
});

test("classifier: CORRUPTED only when the caller reports structural damage", () => {
  const registry = createEmptyRegistry();
  const older = versionState({ aggregate: 1 });
  const latest = versionState({ aggregate: 4 });

  // Same versions, but caller says the target failed to parse / broke an
  // invariant: corruption takes precedence over the version verdict.
  const corrupted = classifyStorage(registry, older, latest, {
    corrupted: true,
    detail: "state.json is not valid JSON"
  });
  assert.equal(corrupted.verdict, "CORRUPTED");
  assert.equal(corrupted.detail, "state.json is not valid JSON");

  // Without a corruption signal the very same older version is NOT corrupted —
  // it is a fail-closed NEEDS_NEW_VERSION under the empty registry.
  const notCorrupted = classifyStorage(registry, older, latest);
  assert.equal(notCorrupted.verdict, "NEEDS_NEW_VERSION");
});

test("classifier: under an EMPTY registry any strictly-older real version is NEEDS_NEW_VERSION", () => {
  const registry = createEmptyRegistry();
  const scalars = latestScalarVersions();
  assert.equal(scalars.layout, CURRENT_STORAGE_LAYOUT_VERSION);
  assert.equal(scalars.aggregate, CURRENT_AGGREGATE_SCHEMA_VERSION);

  const latest = versionState({ layout: scalars.layout, aggregate: scalars.aggregate });

  // Any older layout with the real baseline as target: fail-closed.
  const olderLayout = classifyStorage(
    registry,
    versionState({ layout: scalars.layout - 1, aggregate: scalars.aggregate }),
    latest
  );
  assert.equal(olderLayout.verdict, "NEEDS_NEW_VERSION");
  assert.equal(olderLayout.blocker.reason, "missing-step");

  // Any older aggregate too.
  const olderAggregate = classifyStorage(
    registry,
    versionState({ layout: scalars.layout, aggregate: scalars.aggregate - 1 }),
    latest
  );
  assert.equal(olderAggregate.verdict, "NEEDS_NEW_VERSION");
  assert.equal(olderAggregate.blocker.reason, "missing-step");
});
