/**
 * Generic, pure storage-migration core.
 *
 * A future-facing, fully unit-testable migration framework over three
 * independent monotonic version axes (layout / aggregate / record, where the
 * record axis is a `recordKind -> {version, path}` map). The transactional engine
 * is parameterized over an abstract {@link MigrationTarget}, so it neither
 * touches a real Home nor hardcodes any domain derived-state list. Real wiring
 * (the production step graph, canonical rebuild/validate boundary, and target)
 * is injected elsewhere.
 */

import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION
} from "../storageSchema.js";

export * from "./types.js";
export {
  MigrationRegistry,
  MigrationRegistryError,
  createEmptyRegistry
} from "./registry.js";
export { planMigration } from "./planner.js";
export {
  classifyStorage,
  type Classification,
  type CorruptionSignal
} from "./classifier.js";
export {
  runMigration,
  type RunMigrationOptions
} from "./engine.js";
export {
  collectEffects,
  describeReport,
  toStepSummary
} from "./report.js";

/**
 * The current baseline scalar versions, sourced from the single authoritative
 * definitions in `storageSchema.ts` (never re-hardcoded here). Callers compose a
 * full {@link StorageVersionState} by supplying the record-family map for the
 * families they own — the generic core intentionally holds no record list.
 */
export function latestScalarVersions(): Readonly<{
  layout: number;
  aggregate: number;
}> {
  return {
    layout: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregate: CURRENT_AGGREGATE_SCHEMA_VERSION
  };
}
