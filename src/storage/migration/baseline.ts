/**
 * Immutable post-baseline storage contract.
 *
 * Current versions may advance, but this snapshot moves only through an
 * explicit re-baseline decision. Versions and locators are literal values so a
 * live descriptor edit cannot silently rewrite the earliest supported origin.
 */
import type { RecordAxisEntry, StorageVersionState } from "./types.js";
import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION
} from "../storageVersions.js";
import { currentRecordVersions } from "../upgrade/recordVersions.js";

export const BASELINE_STORAGE_LAYOUT_VERSION = 6;
export const BASELINE_AGGREGATE_SCHEMA_VERSION = 16;

const BASELINE_RECORD_DESCRIPTORS: Readonly<Record<string, RecordAxisEntry>> = Object.freeze({
  config: descriptor(1, "state.json#/config"),
  configuredAgent: descriptor(2, "state.json#/configuredAgents"),
  project: descriptor(2, "state.json#/projects"),
  agentProfile: descriptor(2, "state.json#/agentProfiles"),
  globalRole: descriptor(3, "state.json#/globalRoles"),
  globalRoleSessionSet: descriptor(3, "state.json#/globalRoleSessionSets"),
  storedTask: descriptor(14, "state.json#/tasks/*"),
  task: descriptor(3, "state.json#/tasks/*/task"),
  taskBrief: descriptor(2, "state.json#/tasks/*/brief"),
  taskRole: descriptor(3, "state.json#/tasks/*/roles"),
  managedWorkspace: descriptor(1, "state.json#/tasks/*/managedWorkspaces"),
  taskRoleSessionSet: descriptor(4, "state.json#/tasks/*/roleSessionSets"),
  workItem: descriptor(6, "state.json#/tasks/*/workItems"),
  agentRun: descriptor(5, "state.json#/tasks/*/agentRuns"),
  reviewRound: descriptor(2, "state.json#/tasks/*/reviewRounds"),
  changeSet: descriptor(2, "state.json#/tasks/*/changeSets"),
  integrationAttempt: descriptor(2, "state.json#/tasks/*/integrationAttempts"),
  activeRunPointer: descriptor(1, "state.json#/tasks/*/activeRuns"),
  message: descriptor(2, "state.json#/tasks/*/messages"),
  inputRequest: descriptor(2, "state.json#/tasks/*/inputRequests"),
  decision: descriptor(1, "state.json#/tasks/*/decisions"),
  milestone: descriptor(1, "state.json#/tasks/*/milestones"),
  event: descriptor(2, "state.json#/tasks/*/events"),
  leaderFailure: descriptor(1, "state.json#/tasks/*/leaderFailure"),
  operatorNotification: descriptor(1, "state.json#/tasks/*/operatorNotification"),
  workMailbox: descriptor(1, "state.json#/mailboxes")
});

/** Frozen baseline record-family version map retained as a public delivery contract. */
export const BASELINE_RECORD_VERSIONS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    Object.entries(BASELINE_RECORD_DESCRIPTORS).map(([kind, entry]) => [kind, entry.version])
  )
);

export function baselineStorageVersionState(): StorageVersionState {
  return Object.freeze({
    layout: BASELINE_STORAGE_LAYOUT_VERSION,
    aggregate: BASELINE_AGGREGATE_SCHEMA_VERSION,
    record: Object.freeze({ ...BASELINE_RECORD_DESCRIPTORS })
  });
}

/** Constant spelling used by delivery-gate callers and historical tests. */
export const BASELINE_STORAGE_VERSION_STATE = baselineStorageVersionState();

/**
 * Fail the delivery gate if the immutable baseline is ahead of the live schema,
 * loses a record family, or changes a locator without an explicit scalar
 * storage boundary. The production registry gate separately proves the full
 * executable baseline-to-current transition path.
 */
export function assertBaselineConsistency(
  current: StorageVersionState = {
    layout: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregate: CURRENT_AGGREGATE_SCHEMA_VERSION,
    record: currentRecordVersions()
  }
): void {
  if (BASELINE_STORAGE_LAYOUT_VERSION > current.layout) {
    throw new Error(
      `Baseline layout ${BASELINE_STORAGE_LAYOUT_VERSION} exceeds current layout ${current.layout}.`
    );
  }
  if (BASELINE_AGGREGATE_SCHEMA_VERSION > current.aggregate) {
    throw new Error(
      `Baseline aggregate ${BASELINE_AGGREGATE_SCHEMA_VERSION} exceeds current aggregate ${current.aggregate}.`
    );
  }

  const scalarVersionAdvanced =
    current.layout > BASELINE_STORAGE_LAYOUT_VERSION
    || current.aggregate > BASELINE_AGGREGATE_SCHEMA_VERSION;
  for (const [kind, baselineEntry] of Object.entries(BASELINE_RECORD_DESCRIPTORS)) {
    const currentEntry = current.record[kind];
    if (!Number.isSafeInteger(baselineEntry.version) || baselineEntry.version < 1) {
      throw new Error(
        `Baseline record family '${kind}' has invalid version ${String(baselineEntry.version)}.`
      );
    }
    if (currentEntry === undefined || baselineEntry.version > currentEntry.version) {
      throw new Error(`Baseline record family '${kind}' is ahead of or missing from current.`);
    }
    if (baselineEntry.path !== currentEntry.path && !scalarVersionAdvanced) {
      throw new Error(
        `Baseline record family '${kind}' path drift requires a layout or aggregate version change.`
      );
    }
  }
}

function descriptor(version: number, path: string): RecordAxisEntry {
  return Object.freeze({ version, path });
}
