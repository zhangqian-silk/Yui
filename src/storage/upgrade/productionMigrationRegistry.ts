import { MigrationRegistry } from "../migration/index.js";
import type { HomeSnapshot } from "./homeMigrationTarget.js";

const FINAL_REVIEW_AGGREGATE_FROM_VERSION = 16;
const FINAL_REVIEW_AGGREGATE_TO_VERSION = 17;

/**
 * Build the explicit migration graph shipped by this release.
 *
 * This is the single production registry used by both doctor classification and
 * the upgrade command. It is deliberately a factory: callers receive an
 * isolated immutable-in-practice graph and cannot leak test registrations into
 * another command.
 */
export function createProductionMigrationRegistry(): MigrationRegistry<HomeSnapshot> {
  return new MigrationRegistry<HomeSnapshot>().register({
    axis: "aggregate",
    fromVersion: FINAL_REVIEW_AGGREGATE_FROM_VERSION,
    toVersion: FINAL_REVIEW_AGGREGATE_TO_VERSION,
    preconditions: requireAggregateV16Snapshot,
    transform: migrateAggregateV16ToV17,
    declaredEffects: []
  });
}

/**
 * Aggregate v17 makes persisted `review.trigger=final` an explicit storage
 * capability. No nested record shape changes: the transform only advances the
 * manifest and root aggregate identities, after proving they agree at v16.
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
