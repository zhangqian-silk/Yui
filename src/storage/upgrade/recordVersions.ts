/**
 * The current-baseline record-axis version map.
 *
 * The three storage axes are `layout`, `aggregate`, and `record`. The layout and
 * aggregate axes are scalars sourced from `storageSchema.ts`; the record axis is
 * a `recordKind -> { version, path }` map because every record family versions
 * independently (see the generic migration core in `../migration`).
 *
 * This map is a SNAPSHOT of the record families that exist on the current
 * baseline, enumerated from their real `schemaVersion`s in `taskStore.ts` and the
 * per-record modules. It is intentionally NOT a frozen "first release" set: as
 * the schema evolves (a new record family, a bumped family version), this map is
 * updated in lockstep, exactly like the scalar constants. It exists so
 * doctor/inspect and the migration planner can reason about record families;
 * with the registry shipping EMPTY, no record step ever runs against a real Home.
 */

import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION
} from "../storageSchema.js";
import { CURRENT_STORED_TASK_SCHEMA_VERSION } from "../taskStore.js";
import type { RecordAxisEntry, StorageVersionState } from "../migration/index.js";

/**
 * The record families present on the current baseline, each at its real
 * `schemaVersion`. `path` is a logical, human-readable location of where the
 * family's records live inside the authoritative store; the generic engine
 * treats it as opaque. Update this map whenever a family is added or its
 * `schemaVersion` changes — it tracks the live schema, it does not freeze it.
 */
const CURRENT_RECORD_VERSIONS: Readonly<Record<string, RecordAxisEntry>> = Object.freeze({
  configuredAgent: { version: 2, path: "state.json#/configuredAgents" },
  project: { version: 2, path: "state.json#/projects" },
  agentProfile: { version: 2, path: "state.json#/agentProfiles" },
  globalRole: { version: 3, path: "state.json#/globalRoles" },
  globalRoleSessionSet: { version: 3, path: "state.json#/globalRoleSessionSets" },
  // The task aggregate is itself a versioned record family. Keep this family
  // alongside (and distinct from) the nested `task` record family: an older
  // aggregate wrapper must be classified on the record axis before the strict
  // loader is asked to parse its nested members.
  storedTask: {
    version: CURRENT_STORED_TASK_SCHEMA_VERSION,
    path: "state.json#/tasks/*"
  },
  task: { version: 3, path: "state.json#/tasks/*/task" },
  taskBrief: { version: 2, path: "state.json#/tasks/*/brief" },
  taskRole: { version: 3, path: "state.json#/tasks/*/roles" },
  managedWorkspace: { version: 1, path: "state.json#/tasks/*/managedWorkspaces" },
  taskRoleSessionSet: { version: 3, path: "state.json#/tasks/*/roleSessionSets" },
  workItem: { version: 6, path: "state.json#/tasks/*/workItems" },
  agentRun: { version: 4, path: "state.json#/tasks/*/agentRuns" },
  reviewRound: { version: 2, path: "state.json#/tasks/*/reviewRounds" },
  changeSet: { version: 2, path: "state.json#/tasks/*/changeSets" },
  integrationAttempt: { version: 2, path: "state.json#/tasks/*/integrationAttempts" },
  message: { version: 2, path: "state.json#/tasks/*/messages" },
  inputRequest: { version: 2, path: "state.json#/tasks/*/inputRequests" },
  decision: { version: 1, path: "state.json#/tasks/*/decisions" },
  milestone: { version: 1, path: "state.json#/tasks/*/milestones" },
  event: { version: 2, path: "state.json#/tasks/*/events" },
  workMailbox: { version: 1, path: "state.json#/mailboxes" }
});

/** The record-axis map for the current baseline (a defensive shallow copy). */
export function currentRecordVersions(): Readonly<Record<string, RecordAxisEntry>> {
  return { ...CURRENT_RECORD_VERSIONS };
}

/**
 * The full latest-supported {@link StorageVersionState} this release understands:
 * the scalar layout/aggregate versions plus the current record map. The engine
 * and classifier compare a source against this to decide the four-state verdict.
 */
export function latestStorageVersionState(): StorageVersionState {
  return {
    layout: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregate: CURRENT_AGGREGATE_SCHEMA_VERSION,
    record: currentRecordVersions()
  };
}
