/**
 * Delivery-gate regression for the post-baseline migration contract.
 *
 * Proves three things:
 *  1. The frozen baseline passes: `createProductionRegistry` succeeds,
 *     `assertBaselineConsistency` and `assertRegistryCoversBaselineToCurrent`
 *     pass across the shipped aggregate 16->17 step.
 *  2. Any synthetic current version above the baseline requires every adjacent
 *     production Registry step; a missing transition fails closed with a
 *     precise `missing-step` blocker.
 *  3. A complete adjacent step chain passes (the planner returns `runnable`).
 *
 * The delivery gate (`assertRegistryCoversBaselineToCurrent`) checks the real
 * baseline→current range. Synthetic source→target ranges additionally exercise
 * missing and complete chains beyond the shipped transition because the gate
 * and planner share the identical adjacent-step lookup contract.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBaselineConsistency,
  assertRegistryCoversBaselineToCurrent,
  BASELINE_AGGREGATE_SCHEMA_VERSION,
  BASELINE_STORAGE_LAYOUT_VERSION,
  BASELINE_RECORD_VERSIONS,
  BASELINE_STORAGE_VERSION_STATE,
  createEmptyRegistry,
  createProductionRegistry,
  planMigration
} from "../../dist/storage/migration/index.js";
import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION
} from "../../dist/storage/storageVersions.js";
import { latestStorageVersionState } from "../../dist/storage/upgrade/recordVersions.js";

/** A no-op migration step for a given axis/version transition. */
function noopStep(axis, recordKind, fromVersion) {
  return {
    axis,
    ...(recordKind ? { recordKind } : {}),
    fromVersion,
    toVersion: fromVersion + 1,
    preconditions: () => {},
    transform: (input) => input,
    declaredEffects: []
  };
}

test("frozen baseline passes: consistency and production registry coverage", () => {
  // Baseline layout/aggregate must not exceed current.
  assert.ok(BASELINE_STORAGE_LAYOUT_VERSION <= CURRENT_STORAGE_LAYOUT_VERSION);
  assert.ok(BASELINE_AGGREGATE_SCHEMA_VERSION <= CURRENT_AGGREGATE_SCHEMA_VERSION);

  // Every baseline record family exists in the current descriptor table and its
  // version is no greater than the current version.
  const current = latestStorageVersionState();
  for (const [kind, baselineVersion] of Object.entries(BASELINE_RECORD_VERSIONS)) {
    assert.ok(kind in current.record, `baseline family ${kind} must exist in current`);
    assert.ok(
      baselineVersion <= current.record[kind].version,
      `baseline ${kind} version ${baselineVersion} must not exceed current ${current.record[kind].version}`
    );
  }

  // The consistency assertion and the production registry both succeed.
  assert.doesNotThrow(() => assertBaselineConsistency());
  const registry = createProductionRegistry();
  assert.doesNotThrow(() => assertRegistryCoversBaselineToCurrent(registry));
});

test("the production registry registers every adjacent post-baseline step", () => {
  const registry = createProductionRegistry();
  assert.equal(BASELINE_AGGREGATE_SCHEMA_VERSION, 16);
  assert.equal(CURRENT_AGGREGATE_SCHEMA_VERSION, 18);
  assert.equal(registry.size, 23);
  const step = registry.lookup("aggregate", undefined, 16);
  assert.notEqual(step, undefined);
  assert.equal(step.toVersion, 17);
  const homeIdentityStep = registry.lookup("aggregate", undefined, 17);
  assert.notEqual(homeIdentityStep, undefined);
  assert.equal(homeIdentityStep.toVersion, 18);
  const projectOwnershipStep = registry.lookup("record", "project", 2);
  assert.notEqual(projectOwnershipStep, undefined);
  assert.equal(projectOwnershipStep.toVersion, 3);
  const taskWorkspaceIdentityStep = registry.lookup("record", "task", 3);
  assert.notEqual(taskWorkspaceIdentityStep, undefined);
  assert.equal(taskWorkspaceIdentityStep.toVersion, 4);
  const changeSetManifestStep = registry.lookup("record", "changeSet", 2);
  assert.notEqual(changeSetManifestStep, undefined);
  assert.equal(changeSetManifestStep.toVersion, 3);
  const integrationAttemptStep = registry.lookup("record", "integrationAttempt", 2);
  assert.notEqual(integrationAttemptStep, undefined);
  assert.equal(integrationAttemptStep.toVersion, 3);
  const integrationQueueIntroduction = registry.lookup("record", "integrationQueue", 0);
  assert.notEqual(integrationQueueIntroduction, undefined);
  assert.equal(integrationQueueIntroduction.toVersion, 1);
  assert.equal(integrationQueueIntroduction.introduction, true);
  const durableJobsStep = registry.lookupDeclaration("record", "storedTask", 14);
  assert.notEqual(durableJobsStep, undefined);
  assert.equal(durableJobsStep.toVersion, 15);
  const jobCallerKeyHashesStep = registry.lookupDeclaration("record", "storedTask", 15);
  assert.notEqual(jobCallerKeyHashesStep, undefined);
  assert.equal(jobCallerKeyHashesStep.toVersion, 16);
  const durableJobIntroduction = registry.lookupDeclaration("record", "durableJob", 0);
  assert.notEqual(durableJobIntroduction, undefined);
  assert.equal(durableJobIntroduction.toVersion, 1);
  const capabilityGrantIntroduction = registry.lookup("record", "capabilityGrant", 0);
  assert.notEqual(capabilityGrantIntroduction, undefined);
  assert.equal(capabilityGrantIntroduction.toVersion, 1);
  assert.equal(capabilityGrantIntroduction.introduction, true);
  const releaseWorkflowIntroduction = registry.lookup("record", "releaseWorkflow", 0);
  assert.notEqual(releaseWorkflowIntroduction, undefined);
  assert.equal(releaseWorkflowIntroduction.toVersion, 1);
  assert.equal(releaseWorkflowIntroduction.introduction, true);
});

test("a synthetic current above baseline fails closed when an adjacent step is missing", () => {
  const baseline = BASELINE_STORAGE_VERSION_STATE;
  // Build a synthetic "current" state one version above the baseline on the
  // layout axis. The registry is empty, so the planner must report a
  // missing-step blocker for the exact transition.
  const target = {
    ...baseline,
    layout: baseline.layout + 1
  };
  const registry = createEmptyRegistry();

  const plan = planMigration(registry, baseline, target);
  assert.equal(plan.kind, "blocked");
  assert.equal(plan.blocker.reason, "missing-step");
  assert.equal(plan.blocker.axis, "layout");
  assert.equal(plan.blocker.from, baseline.layout);
  assert.equal(plan.blocker.to, baseline.layout + 1);
  assert.match(plan.blocker.message, new RegExp(`${baseline.layout}->${baseline.layout + 1}`));
});

test("a complete adjacent chain from baseline to a higher version passes", () => {
  const baseline = BASELINE_STORAGE_VERSION_STATE;
  // Synthetic current: layout two versions above baseline.
  const target = {
    ...baseline,
    layout: baseline.layout + 2
  };
  const registry = createEmptyRegistry();

  // Without steps: blocked.
  assert.equal(planMigration(registry, baseline, target).kind, "blocked");

  // Register both adjacent steps: the chain is now complete.
  registry.register(noopStep("layout", undefined, baseline.layout));
  registry.register(noopStep("layout", undefined, baseline.layout + 1));

  const plan = planMigration(registry, baseline, target);
  assert.equal(plan.kind, "runnable");
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].fromVersion, baseline.layout);
  assert.equal(plan.steps[0].toVersion, baseline.layout + 1);
  assert.equal(plan.steps[1].fromVersion, baseline.layout + 1);
  assert.equal(plan.steps[1].toVersion, baseline.layout + 2);
});

test("a partial adjacent chain fails closed at the first missing transition", () => {
  const baseline = BASELINE_STORAGE_VERSION_STATE;
  const target = {
    ...baseline,
    layout: baseline.layout + 3
  };
  const registry = createEmptyRegistry();

  // Register only the first step; the second transition is missing.
  registry.register(noopStep("layout", undefined, baseline.layout));

  const plan = planMigration(registry, baseline, target);
  assert.equal(plan.kind, "blocked");
  assert.equal(plan.blocker.reason, "missing-step");
  assert.equal(plan.blocker.from, baseline.layout + 1);
  assert.equal(plan.blocker.to, baseline.layout + 2);
});

test("record-family axis also requires strictly adjacent steps", () => {
  const baseline = BASELINE_STORAGE_VERSION_STATE;
  // Pick the first baseline record family and bump its target version by 1.
  const firstKind = Object.keys(baseline.record)[0];
  const baselineVersion = baseline.record[firstKind].version;
  const target = {
    ...baseline,
    record: {
      ...baseline.record,
      [firstKind]: { ...baseline.record[firstKind], version: baselineVersion + 1 }
    }
  };
  const registry = createEmptyRegistry();

  // Missing step for the record family -> blocked.
  const plan = planMigration(registry, baseline, target);
  assert.equal(plan.kind, "blocked");
  assert.equal(plan.blocker.reason, "missing-step");
  assert.equal(plan.blocker.axis, "record");
  assert.equal(plan.blocker.recordKind, firstKind);
  assert.equal(plan.blocker.from, baselineVersion);
  assert.equal(plan.blocker.to, baselineVersion + 1);

  // Register the adjacent step -> runnable.
  registry.register(noopStep("record", firstKind, baselineVersion));
  const plan2 = planMigration(registry, baseline, target);
  assert.equal(plan2.kind, "runnable");
  assert.equal(plan2.steps.length, 1);
});

test("a post-baseline record family requires an explicit 0->1 introduction step", () => {
  const baseline = BASELINE_STORAGE_VERSION_STATE;
  const recordKind = "postBaselineRecord";
  const target = {
    ...baseline,
    record: {
      ...baseline.record,
      [recordKind]: { version: 1, path: "state.json#/postBaselineRecords" }
    }
  };
  const registry = createEmptyRegistry();

  // A target-only family is a real migration boundary, not an aggregate
  // transform that the planner may silently skip.
  const blocked = planMigration(registry, baseline, target);
  assert.equal(blocked.kind, "blocked");
  assert.equal(blocked.blocker.reason, "missing-step");
  assert.equal(blocked.blocker.axis, "record");
  assert.equal(blocked.blocker.recordKind, recordKind);
  assert.equal(blocked.blocker.from, 0);
  assert.equal(blocked.blocker.to, 1);

  registry.register({
    ...noopStep("record", recordKind, 0),
    introduction: true
  });
  const runnable = planMigration(registry, baseline, target);
  assert.equal(runnable.kind, "runnable");
  assert.equal(runnable.steps.length, 1);
  assert.equal(runnable.steps[0].fromVersion, 0);
  assert.equal(runnable.steps[0].toVersion, 1);
});

test("the production delivery gate checks target-only families instead of skipping them", () => {
  const baseline = BASELINE_STORAGE_VERSION_STATE;
  const recordKind = "postBaselineRecord";
  const target = {
    ...baseline,
    record: {
      ...baseline.record,
      [recordKind]: { version: 1, path: "state.json#/postBaselineRecords" }
    }
  };
  const registry = createEmptyRegistry();
  assert.throws(
    () => assertRegistryCoversBaselineToCurrent(registry, baseline, target),
    /record\/postBaselineRecord.*0->1/i
  );
  registry.register({
    ...noopStep("record", recordKind, 0),
    introduction: true
  });
  assert.doesNotThrow(() => assertRegistryCoversBaselineToCurrent(registry, baseline, target));
});

test("the frozen baseline rejects record locator drift without a scalar migration boundary", () => {
  const baseline = BASELINE_STORAGE_VERSION_STATE;
  const drifted = {
    ...baseline,
    record: {
      ...baseline.record,
      configuredAgent: {
        ...baseline.record.configuredAgent,
        path: "state.json#/renamedConfiguredAgents"
      }
    }
  };

  assert.throws(() => assertBaselineConsistency(drifted), /configuredAgent.*path drift/i);
});

test("record locator drift requires a complete offline scalar migration path", () => {
  const baseline = BASELINE_STORAGE_VERSION_STATE;

  for (const axis of ["layout", "aggregate"]) {
    const target = {
      ...baseline,
      [axis]: baseline[axis] + 1,
      record: {
        ...baseline.record,
        configuredAgent: {
          ...baseline.record.configuredAgent,
          path: "state.json#/renamedConfiguredAgents"
        }
      }
    };

    assert.doesNotThrow(() => assertBaselineConsistency(target));

    const declarationOnly = createEmptyRegistry();
    declarationOnly.declareOfflineMigration({
      axis,
      fromVersion: baseline[axis],
      toVersion: target[axis]
    });
    assert.throws(
      () => assertRegistryCoversBaselineToCurrent(declarationOnly, baseline, target),
      new RegExp(`${axis}.*no migration step`, "i")
    );

    const complete = createEmptyRegistry();
    complete.registerOfflineMigration({
      axis,
      fromVersion: baseline[axis],
      toVersion: target[axis],
      preconditions: () => {},
      transform: (snapshot) => ({ ...snapshot }),
      declaredEffects: []
    });
    assert.doesNotThrow(
      () => assertRegistryCoversBaselineToCurrent(complete, baseline, target)
    );
  }
});

test("a target-family introduction must be declared and executable", () => {
  const baseline = BASELINE_STORAGE_VERSION_STATE;
  const target = {
    ...baseline,
    record: {
      ...baseline.record,
      postBaselineRecord: { version: 1, path: "state.json#/postBaselineRecords" }
    }
  };

  const compatible = createEmptyRegistry();
  compatible.registerCompatible({
    axis: "record",
    recordKind: "postBaselineRecord",
    fromVersion: 0,
    toVersion: 1,
    introduction: true,
    defaults: ["postBaselineRecords={}"],
    validateSource: () => {},
    normalize: (snapshot) => ({ ...snapshot })
  });
  assert.doesNotThrow(
    () => assertRegistryCoversBaselineToCurrent(compatible, baseline, target)
  );

  const declarationOnly = createEmptyRegistry();
  declarationOnly.declareOfflineMigration({
    axis: "record",
    recordKind: "postBaselineRecord",
    fromVersion: 0,
    toVersion: 1,
    introduction: true
  });
  assert.throws(
    () => assertRegistryCoversBaselineToCurrent(declarationOnly, baseline, target),
    /no migration step/i
  );
});

test("integrationAttempt v2 to v3 migration runs on a real snapshot", () => {
  // rr4/finding-9: The baseline declares integrationAttempt at v2 and the
  // production registry registers the 2→3 step. This test runs that step on a
  // real v2 snapshot and verifies every record advances to v3.
  const current = latestStorageVersionState();
  const sourceRecord = Object.fromEntries(
    Object.entries(current.record).map(([kind, entry]) => [kind, { ...entry }])
  );
  sourceRecord.integrationAttempt = { ...sourceRecord.integrationAttempt, version: 2 };

  const source = {
    schemaManifest: {
      schemaVersion: 1,
      storageVersion: 6,
      aggregateSchemaVersion: 18,
      recordVersions: Object.fromEntries(
        Object.entries(sourceRecord).map(([kind, entry]) => [kind, entry.version])
      )
    },
    state: {
      schemaVersion: 18,
      tasks: {
        "task-1": {
          integrationAttempts: {
            "integration-1": {
              schemaVersion: 2,
              id: "integration-1",
              taskId: "task-1",
              projectId: "project-1",
              status: "committed",
              createdAt: "2026-01-01T00:00:00.000Z"
            }
          }
        }
      }
    }
  };

  const plan = planMigration(
    createProductionRegistry(),
    { layout: 6, aggregate: 18, record: sourceRecord },
    current
  );
  assert.equal(plan.kind, "runnable");
  const integrationSteps = plan.steps.filter(
    (step) => step.recordKind === "integrationAttempt"
  );
  assert.equal(integrationSteps.length, 1);
  assert.equal(integrationSteps[0].fromVersion, 2);
  assert.equal(integrationSteps[0].toVersion, 3);

  let migrated = structuredClone(source);
  for (const planned of plan.steps) {
    planned.step.preconditions(migrated);
    migrated = planned.step.transform(migrated);
  }

  assert.equal(migrated.schemaManifest.recordVersions.integrationAttempt, 3);
  const attempt = migrated.state.tasks["task-1"].integrationAttempts["integration-1"];
  assert.equal(attempt.schemaVersion, 3);
  // The original snapshot must not be mutated.
  assert.equal(
    source.state.tasks["task-1"].integrationAttempts["integration-1"].schemaVersion,
    2
  );
});
