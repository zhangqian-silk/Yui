/**
 * The immutable post-baseline migration contract.
 *
 * This module is the single authoritative source for the Yui storage baseline:
 * the exact `layout`, `aggregate`, and per-record-family `version` snapshot that
 * this release ships as the earliest supported migration origin. Every value here
 * is a FROZEN literal — it is NOT derived from the live `CURRENT_*` version
 * constants, so bumping a current version never silently moves the baseline.
 *
 * ## Why a frozen baseline
 *
 * Before this task, Yui had no formal migration baseline: any schema change was
 * resolved by clearing the Home or guessing. From this baseline onward, every
 * version bump on any of the three axes (layout / aggregate / record family)
 * MUST be accompanied by an explicit adjacent migration step registered in the
 * production registry. Pre-baseline Homes (any axis strictly older than the
 * baseline) are NOT supported: there are no fabricated historical steps, and the
 * classifier reports `NEEDS_NEW_VERSION` with a precise `missing-step` reason so
 * the user either upgrades to a release that knows that version or performs a
 * one-time Home reset.
 *
 * ## Consistency
 *
 * `assertBaselineConsistency` is the machine-readable delivery gate: it verifies
 * that every baseline record family still exists in the live descriptor table
 * (families are never removed, only added), that every baseline version is a
 * positive integer no greater than the current version for that family, and that
 * the baseline layout/aggregate are no greater than the current layout/aggregate.
 * A drift here means the baseline was not advanced deliberately and the build
 * fails closed.
 */

import type { RecordAxisEntry, StorageVersionState } from "./types.js";
import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION
} from "../storageVersions.js";
import { currentRecordVersions } from "../upgrade/recordVersions.js";

/** Baseline on-disk layout version (`schema.json`, root `state.json`, locks). */
export const BASELINE_STORAGE_LAYOUT_VERSION = 6;

/** Baseline authoritative aggregate schema version. */
export const BASELINE_AGGREGATE_SCHEMA_VERSION = 16;

/**
 * The frozen baseline record-family version map. Keys are the authoritative
 * record family names; values are the baseline `schemaVersion` for each family.
 *
 * This is a literal snapshot taken at baseline time. To add a new family or bump
 * a version, update the live `CURRENT_RECORD_DESCRIPTORS` (in
 * `storage/upgrade/recordVersions.ts`) and — if the new version exceeds the
 * baseline — register the adjacent migration step(s) in the production registry.
 * Do NOT edit this map unless you are deliberately re-baselining.
 */
export const BASELINE_RECORD_VERSIONS: Readonly<Record<string, number>> = Object.freeze({
  config: 1,
  configuredAgent: 2,
  project: 2,
  agentProfile: 2,
  globalRole: 3,
  globalRoleSessionSet: 3,
  storedTask: 14,
  task: 3,
  taskBrief: 2,
  taskRole: 3,
  managedWorkspace: 1,
  taskRoleSessionSet: 4,
  workItem: 6,
  agentRun: 5,
  reviewRound: 2,
  changeSet: 2,
  integrationAttempt: 2,
  activeRunPointer: 1,
  message: 2,
  inputRequest: 2,
  decision: 1,
  milestone: 1,
  event: 2,
  leaderFailure: 1,
  operatorNotification: 1,
  workMailbox: 1
});

/**
 * The full baseline {@link StorageVersionState}. Record paths are sourced from
 * the live descriptor table (paths are stable locators; changing one is a
 * layout/aggregate concern, not a record-version bump), but the versions are the
 * frozen {@link BASELINE_RECORD_VERSIONS}.
 */
export const BASELINE_STORAGE_VERSION_STATE: StorageVersionState = buildBaselineState();

function buildBaselineState(): StorageVersionState {
  const current = currentRecordVersions();
  const record: Record<string, RecordAxisEntry> = {};
  for (const [kind, version] of Object.entries(BASELINE_RECORD_VERSIONS)) {
    const currentEntry = current[kind];
    if (currentEntry === undefined) {
      throw new Error(
        `Baseline record family '${kind}' is absent from the current descriptor table; `
          + "the baseline must be re-baselined or the family restored."
      );
    }
    record[kind] = Object.freeze({ version, path: currentEntry.path });
  }
  return Object.freeze({
    layout: BASELINE_STORAGE_LAYOUT_VERSION,
    aggregate: BASELINE_AGGREGATE_SCHEMA_VERSION,
    record: Object.freeze(record)
  });
}

/**
 * Assert that the frozen baseline is internally consistent and still aligns with
 * the live descriptor table. This is the delivery gate that prevents a current
 * version bump from silently leaving the baseline (and the required migration
 * steps) behind.
 *
 * Checks:
 *  - baseline layout ≤ current layout, baseline aggregate ≤ current aggregate;
 *  - every baseline record family exists in the current descriptor table;
 *  - every baseline record version is a positive integer ≤ the current version
 *    for that family;
 *  - every baseline record path matches the current descriptor path (a path
 *    change is a layout/aggregate change and must be versioned there).
 *
 * Throws on any drift.
 */
export function assertBaselineConsistency(): void {
  if (BASELINE_STORAGE_LAYOUT_VERSION > CURRENT_STORAGE_LAYOUT_VERSION) {
    throw new Error(
      `Baseline layout ${BASELINE_STORAGE_LAYOUT_VERSION} exceeds current layout `
        + `${CURRENT_STORAGE_LAYOUT_VERSION}; re-baseline or restore the layout version.`
    );
  }
  if (BASELINE_AGGREGATE_SCHEMA_VERSION > CURRENT_AGGREGATE_SCHEMA_VERSION) {
    throw new Error(
      `Baseline aggregate ${BASELINE_AGGREGATE_SCHEMA_VERSION} exceeds current aggregate `
        + `${CURRENT_AGGREGATE_SCHEMA_VERSION}; re-baseline or restore the aggregate version.`
    );
  }

  const current = currentRecordVersions();
  for (const [kind, baselineVersion] of Object.entries(BASELINE_RECORD_VERSIONS)) {
    const currentEntry = current[kind];
    if (currentEntry === undefined) {
      throw new Error(
        `Baseline record family '${kind}' is missing from the current descriptor table.`
      );
    }
    if (!Number.isSafeInteger(baselineVersion) || baselineVersion < 1) {
      throw new Error(
        `Baseline record family '${kind}' has an invalid version ${String(baselineVersion)}.`
      );
    }
    if (baselineVersion > currentEntry.version) {
      throw new Error(
        `Baseline record family '${kind}' version ${baselineVersion} exceeds current `
          + `version ${currentEntry.version}; re-baseline or restore the family version.`
      );
    }
    if (currentEntry.path !== BASELINE_STORAGE_VERSION_STATE.record[kind]?.path) {
      throw new Error(
        `Baseline record family '${kind}' path drift: baseline `
          + `'${BASELINE_STORAGE_VERSION_STATE.record[kind]?.path}' vs current `
          + `'${currentEntry.path}'. A path change requires a layout/aggregate version bump.`
      );
    }
  }
}
