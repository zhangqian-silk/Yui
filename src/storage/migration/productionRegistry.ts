/** The one production transition registry and its baseline-to-current delivery gate. */
import { latestStorageVersionState } from "../upgrade/recordVersions.js";
import type { HomeSnapshot } from "../upgrade/homeMigrationTarget.js";
import { assertBaselineConsistency, baselineStorageVersionState } from "./baseline.js";
import { planMigration } from "./planner.js";
import { MigrationRegistry } from "./registry.js";
import type { MigrationStep, StorageVersionState } from "./types.js";

const FINAL_REVIEW_AGGREGATE_FROM_VERSION = 16;
const FINAL_REVIEW_AGGREGATE_TO_VERSION = 17;
const WORK_ITEM_FROM_VERSION = 6;
const WORK_ITEM_TO_VERSION = 7;
const AGENT_RUN_FROM_VERSION = 5;
const AGENT_RUN_TO_VERSION = 6;
const REVIEW_ROUND_FROM_VERSION = 2;
const REVIEW_ROUND_TO_VERSION = 3;
const ACTIVE_RUN_POINTER_FROM_VERSION = 1;
const ACTIVE_RUN_POINTER_TO_VERSION = 2;

/**
 * Build the authoritative production graph. Transition intent and executable
 * transforms are registered together here; compatible loading and offline
 * migration consume this same graph.
 */
export function createProductionStorageRegistry(): MigrationRegistry<HomeSnapshot> {
  assertBaselineConsistency();
  const registry = new MigrationRegistry<HomeSnapshot>().registerOfflineMigration({
    axis: "aggregate",
    fromVersion: FINAL_REVIEW_AGGREGATE_FROM_VERSION,
    toVersion: FINAL_REVIEW_AGGREGATE_TO_VERSION,
    preconditions: requireAggregateV16Snapshot,
    transform: migrateAggregateV16ToV17,
    declaredEffects: []
  })
    .registerOfflineMigration(recordFamilyStep(
      "workItem",
      WORK_ITEM_FROM_VERSION,
      WORK_ITEM_TO_VERSION,
      "workItems"
    ))
    .registerOfflineMigration(recordFamilyStep(
      "agentRun",
      AGENT_RUN_FROM_VERSION,
      AGENT_RUN_TO_VERSION,
      "agentRuns"
    ))
    .registerOfflineMigration(recordFamilyStep(
      "reviewRound",
      REVIEW_ROUND_FROM_VERSION,
      REVIEW_ROUND_TO_VERSION,
      "reviewRounds"
    ))
    .registerOfflineMigration(recordFamilyStep(
      "activeRunPointer",
      ACTIVE_RUN_POINTER_FROM_VERSION,
      ACTIVE_RUN_POINTER_TO_VERSION,
      "activeRuns"
    ));

  assertRegistryCoversBaselineToCurrent(registry);
  return registry;
}

/**
 * Upgrade one nested Task record family without guessing fields or repairing
 * malformed state. The new execution lineage fields are optional, so legal
 * old single-lane records retain their direct shape; the next dispatch creates
 * the unified one-lane Group explicitly. The version transition is still
 * durable and centralized, which keeps old Homes out of the strict current
 * parser until this step has run.
 */
function recordFamilyStep(
  recordKind: string,
  fromVersion: number,
  toVersion: number,
  taskMapKey: "workItems" | "agentRuns" | "reviewRounds" | "activeRuns"
): MigrationStep<HomeSnapshot> {
  return {
    axis: "record",
    recordKind,
    fromVersion,
    toVersion,
    preconditions: (snapshot) => requireRecordFamilyVersion(
      snapshot,
      recordKind,
      fromVersion,
      taskMapKey
    ),
    transform: (snapshot) => migrateRecordFamily(
      snapshot,
      recordKind,
      fromVersion,
      toVersion,
      taskMapKey
    ),
    declaredEffects: []
  };
}

function requireRecordFamilyVersion(
  snapshot: HomeSnapshot,
  recordKind: string,
  fromVersion: number,
  taskMapKey: "workItems" | "agentRuns" | "reviewRounds" | "activeRuns"
): void {
  const manifestVersions = asObject(snapshot.schemaManifest.recordVersions, "schema manifest recordVersions");
  if (manifestVersions[recordKind] !== fromVersion) {
    throw new Error(
      `Record ${recordKind} migration requires manifest version ${fromVersion}.`
    );
  }
  if (snapshot.state === null) return;
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    const records = task[taskMapKey];
    if (records === undefined) continue;
    const map = asObject(records, `${recordKind} map ${taskId}`);
    for (const [recordId, rawRecord] of Object.entries(map)) {
      const record = asObject(rawRecord, `${recordKind} ${taskId}/${recordId}`);
      if (record.schemaVersion !== fromVersion) {
        throw new Error(
          `Record ${recordKind} ${taskId}/${recordId} must use schemaVersion ${fromVersion}.`
        );
      }
    }
  }
}

function migrateRecordFamily(
  snapshot: HomeSnapshot,
  recordKind: string,
  fromVersion: number,
  toVersion: number,
  taskMapKey: "workItems" | "agentRuns" | "reviewRounds" | "activeRuns"
): HomeSnapshot {
  // Keep the same source-shape checks in the transform so a direct caller
  // cannot bypass the migration's precondition contract.
  requireRecordFamilyVersion(snapshot, recordKind, fromVersion, taskMapKey);
  const manifestVersions = asObject(snapshot.schemaManifest.recordVersions, "schema manifest recordVersions");
  const schemaManifest = {
    ...snapshot.schemaManifest,
    recordVersions: {
      ...manifestVersions,
      [recordKind]: toVersion
    }
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  const nextTasks: Record<string, unknown> = {};
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    const records = task[taskMapKey];
    if (records === undefined) {
      nextTasks[taskId] = { ...task };
      continue;
    }
    const map = asObject(records, `${recordKind} map ${taskId}`);
    const nextMap: Record<string, unknown> = {};
    for (const [recordId, rawRecord] of Object.entries(map)) {
      nextMap[recordId] = {
        ...asObject(rawRecord, `${recordKind} ${taskId}/${recordId}`),
        schemaVersion: toVersion
      };
    }
    nextTasks[taskId] = { ...task, [taskMapKey]: nextMap };
  }
  return {
    schemaManifest,
    state: { ...snapshot.state, tasks: nextTasks }
  };
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/** Historical public spelling retained as an alias to the single graph. */
export const createProductionRegistry = createProductionStorageRegistry;

/** Advance the aggregate identity after proving manifest/root agreement at v16. */
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
 * A version bump is deliverable only when the shared planner resolves the full
 * adjacent path. This also covers target-only record families as explicit 0->1
 * introductions and rejects offline declarations without executable steps.
 */
export function assertRegistryCoversBaselineToCurrent<Snapshot>(
  registry: MigrationRegistry<Snapshot>,
  baseline: StorageVersionState = baselineStorageVersionState(),
  current: StorageVersionState = latestStorageVersionState()
): void {
  const plan = planMigration(registry, baseline, current);
  if (plan.kind !== "blocked") return;
  const coordinate = plan.blocker.axis === "record"
    ? `record/${plan.blocker.recordKind ?? "?"}`
    : plan.blocker.axis;
  throw new Error(
    `Storage migration delivery gate failed for ${coordinate}: ${plan.blocker.message}`
  );
}
