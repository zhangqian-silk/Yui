/**
 * The single, centralized production migration registry.
 *
 * Every production caller (`yui upgrade`, `yui doctor`, the update preflight)
 * MUST obtain its registry from {@link createProductionRegistry}. The test-only
 * `createEmptyRegistry` is reserved for unit tests and explicit fixtures.
 *
 * ## Contract
 *
 * The registry only ever carries strictly adjacent `N -> N+1` steps from the
 * {@link BASELINE_STORAGE_VERSION_STATE} to the current
 * {@link latestStorageVersionState}. There is no jumping, no field-existence
 * guessing, and no implicit compatibility: a version gap without an explicitly
 * registered adjacent step is fail-closed (`missing-step` ->
 * `NEEDS_NEW_VERSION`).
 *
 * At the frozen baseline the registry was empty. The current release is the
 * first post-baseline delivery and therefore ships the explicit aggregate
 * `16 -> 17` step. Every later bump likewise MUST register its adjacent step(s)
 * here; {@link assertRegistryCoversBaselineToCurrent} enforces this at
 * build/test time so a forgotten step cannot ship.
 *
 * Even a no-op version bump (a version that changes no bytes) MUST register an
 * explicit no-op step: the registry is the authoritative record of "this
 * release understands how to get from version N to N+1", and an unregistered
 * gap means "this release does NOT understand that transition".
 */

import {
  BASELINE_STORAGE_VERSION_STATE,
  assertBaselineConsistency
} from "./baseline.js";
import { createEmptyRegistry, type MigrationRegistry } from "./registry.js";
import type { MigrationAxis, MigrationStep, StorageVersionState } from "./types.js";
import type { HomeSnapshot } from "../upgrade/homeMigrationTarget.js";
import { latestStorageVersionState } from "../upgrade/recordVersions.js";

const FINAL_REVIEW_AGGREGATE_FROM_VERSION = 16;
const FINAL_REVIEW_AGGREGATE_TO_VERSION = 17;

/**
 * Build the production migration registry. This is the ONLY registry production
 * callers should use.
 *
 * The returned registry contains every adjacent step required to migrate from
 * the baseline to the current version state. This release contains the first
 * such step, aggregate `16 -> 17`.
 */
export function createProductionRegistry(): MigrationRegistry<HomeSnapshot> {
  assertBaselineConsistency();
  const registry = createEmptyRegistry<HomeSnapshot>();
  registerBaselineToCurrentSteps(registry);
  assertRegistryCoversBaselineToCurrent(registry);
  return registry;
}

/**
 * Register all adjacent steps from the baseline to the current version state.
 *
 * Each step MUST be adjacent (`fromVersion + 1 === toVersion`) and MUST be the
 * only step for its `(axis, recordKind, fromVersion)` key (the registry enforces
 * uniqueness).
 */
function registerBaselineToCurrentSteps(
  registry: MigrationRegistry<HomeSnapshot>
): void {
  const baseline = BASELINE_STORAGE_VERSION_STATE;
  const current = latestStorageVersionState();

  // Layout axis: register every adjacent step baseline.layout -> current.layout.
  registerScalarAxisSteps(registry, "layout", baseline.layout, current.layout);

  // Aggregate axis: register every adjacent step baseline.aggregate -> current.aggregate.
  registerScalarAxisSteps(registry, "aggregate", baseline.aggregate, current.aggregate);

  // Record axis: for every family, register adjacent steps baseline.version -> current.version.
  for (const kind of Object.keys(current.record)) {
    const baselineEntry = baseline.record[kind];
    const currentEntry = current.record[kind];
    if (currentEntry === undefined) continue;
    registerRecordAxisSteps(
      registry,
      kind,
      baselineEntry?.version ?? 0,
      currentEntry.version
    );
  }
}

function registerScalarAxisSteps(
  registry: MigrationRegistry<HomeSnapshot>,
  axis: Extract<MigrationAxis, "layout" | "aggregate">,
  from: number,
  to: number
): void {
  for (let version = from; version < to; version += 1) {
    const step = productionStepFor(axis, undefined, version);
    if (step !== null) registry.register(step);
  }
}

function registerRecordAxisSteps(
  registry: MigrationRegistry<HomeSnapshot>,
  recordKind: string,
  from: number,
  to: number
): void {
  for (let version = from; version < to; version += 1) {
    const step = productionStepFor("record", recordKind, version);
    if (step !== null) registry.register(step);
  }
}

/**
 * Return the production migration step for `axis/recordKind` advancing
 * `fromVersion -> fromVersion + 1`, or `null` when no step has been authored
 * for that transition.
 *
 * Implementations are keyed by `(axis, recordKind, fromVersion)`. A `null`
 * return for a transition that the baseline->current range requires is caught
 * by {@link assertRegistryCoversBaselineToCurrent}.
 */
function productionStepFor(
  axis: MigrationAxis,
  recordKind: string | undefined,
  fromVersion: number
): MigrationStep<HomeSnapshot> | null {
  if (axis === "aggregate"
    && recordKind === undefined
    && fromVersion === FINAL_REVIEW_AGGREGATE_FROM_VERSION) {
    return {
      axis: "aggregate",
      fromVersion: FINAL_REVIEW_AGGREGATE_FROM_VERSION,
      toVersion: FINAL_REVIEW_AGGREGATE_TO_VERSION,
      preconditions: requireAggregateV16Snapshot,
      transform: migrateAggregateV16ToV17,
      declaredEffects: []
    };
  }
  // Every later version bump adds its adjacent concrete step here. The
  // delivery gate below ensures a missing step for a required transition fails
  // the build rather than being inferred from fields or version magnitude.
  return null;
}

/**
 * Aggregate v17 makes persisted `review.trigger=final` an explicit storage
 * capability. No nested record shape changes: the transform only advances the
 * manifest and root aggregate identities after proving they agree at v16.
 */
function migrateAggregateV16ToV17(snapshot: HomeSnapshot): HomeSnapshot {
  return {
    schemaManifest: {
      ...snapshot.schemaManifest,
      aggregateSchemaVersion: FINAL_REVIEW_AGGREGATE_TO_VERSION
    },
    state: snapshot.state === null
      ? null
      : {
          ...snapshot.state,
          schemaVersion: FINAL_REVIEW_AGGREGATE_TO_VERSION
        }
  };
}

function requireAggregateV16Snapshot(snapshot: HomeSnapshot): void {
  if (snapshot.schemaManifest.aggregateSchemaVersion
    !== FINAL_REVIEW_AGGREGATE_FROM_VERSION) {
    throw new Error(
      "Aggregate 16->17 migration requires schema.json aggregateSchemaVersion 16."
    );
  }
  if (snapshot.state !== null
    && snapshot.state.schemaVersion !== FINAL_REVIEW_AGGREGATE_FROM_VERSION) {
    throw new Error(
      "Aggregate 16->17 migration requires state.json schemaVersion 16 to match schema.json."
    );
  }
}

/**
 * Delivery gate: assert that the registry contains a complete adjacent step
 * chain from the baseline to the current version state on every axis.
 *
 * For each axis where `current > baseline`, every adjacent
 * `N -> N+1` step in `[baseline, current)` must be registered. If any step is
 * missing, this throws — the build fails closed so a release cannot ship with a
 * version bump but no migration.
 *
 * When `baseline === current` (baseline delivery), no steps are required and
 * this passes trivially.
 */
export function assertRegistryCoversBaselineToCurrent<Snapshot>(
  registry: MigrationRegistry<Snapshot>,
  baseline: StorageVersionState = BASELINE_STORAGE_VERSION_STATE,
  current: StorageVersionState = latestStorageVersionState()
): void {
  // Layout
  assertAxisCovered(registry, "layout", undefined, baseline.layout, current.layout);
  // Aggregate
  assertAxisCovered(registry, "aggregate", undefined, baseline.aggregate, current.aggregate);
  // Record families
  for (const kind of Object.keys(current.record)) {
    const baselineEntry = baseline.record[kind];
    const currentEntry = current.record[kind];
    if (currentEntry === undefined) continue;
    assertAxisCovered(
      registry,
      "record",
      kind,
      baselineEntry?.version ?? 0,
      currentEntry.version
    );
  }
}

function assertAxisCovered<Snapshot>(
  registry: MigrationRegistry<Snapshot>,
  axis: MigrationAxis,
  recordKind: string | undefined,
  from: number,
  to: number
): void {
  for (let version = from; version < to; version += 1) {
    const step = registry.lookup(axis, recordKind, version);
    if (step === undefined) {
      const label = axis === "record" ? `record/${recordKind}` : axis;
      throw new Error(
        `Delivery gate failed: no production migration step registered for ${label} `
          + `${version}->${version + 1}. A version bump above the baseline requires an `
          + "explicit adjacent migration step; register it in createProductionRegistry."
      );
    }
  }
}
