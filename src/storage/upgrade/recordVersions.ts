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
import {
  CURRENT_AGENT_RUN_SCHEMA_VERSION,
  CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION,
  CURRENT_CONFIG_SCHEMA_VERSION,
  CURRENT_STORED_TASK_SCHEMA_VERSION,
  CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION
} from "../taskStore.js";
import { CURRENT_LEADER_FAILURE_SCHEMA_VERSION } from "../../scheduler/leaderFailure.js";
import { CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION } from "../../scheduler/operatorNotification.js";
import type { RecordAxisEntry, StorageVersionState } from "../migration/index.js";

/** Every persisted record family directly owned by StorageState/StoredTask. */
const EXPECTED_RECORD_KINDS = [
  "config",
  "configuredAgent",
  "project",
  "agentProfile",
  "globalRole",
  "globalRoleSessionSet",
  "storedTask",
  "task",
  "taskBrief",
  "taskRole",
  "managedWorkspace",
  "taskRoleSessionSet",
  "workItem",
  "agentRun",
  "reviewRound",
  "changeSet",
  "integrationAttempt",
  "activeRunPointer",
  "message",
  "inputRequest",
  "decision",
  "milestone",
  "event",
  "leaderFailure",
  "operatorNotification",
  "workMailbox"
] as const;

/**
 * The record families present on the current baseline, each at its real
 * `schemaVersion`. `path` is a logical, human-readable location of where the
 * family's records live inside the authoritative store; the generic engine
 * treats it as opaque. Update this map whenever a family is added or its
 * `schemaVersion` changes — it tracks the live schema, it does not freeze it.
 */
const CURRENT_RECORD_VERSIONS: Readonly<Record<string, RecordAxisEntry>> = Object.freeze({
  config: { version: CURRENT_CONFIG_SCHEMA_VERSION, path: "state.json#/config" },
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
  taskRoleSessionSet: { version: 4, path: "state.json#/tasks/*/roleSessionSets" },
  workItem: { version: 6, path: "state.json#/tasks/*/workItems" },
  agentRun: { version: 5, path: "state.json#/tasks/*/agentRuns" },
  reviewRound: { version: 2, path: "state.json#/tasks/*/reviewRounds" },
  changeSet: { version: 2, path: "state.json#/tasks/*/changeSets" },
  integrationAttempt: { version: 2, path: "state.json#/tasks/*/integrationAttempts" },
  activeRunPointer: {
    version: CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION,
    path: "state.json#/tasks/*/activeRuns"
  },
  message: { version: 2, path: "state.json#/tasks/*/messages" },
  inputRequest: { version: 2, path: "state.json#/tasks/*/inputRequests" },
  decision: { version: 1, path: "state.json#/tasks/*/decisions" },
  milestone: { version: 1, path: "state.json#/tasks/*/milestones" },
  event: { version: 2, path: "state.json#/tasks/*/events" },
  leaderFailure: {
    version: CURRENT_LEADER_FAILURE_SCHEMA_VERSION,
    path: "state.json#/tasks/*/leaderFailure"
  },
  operatorNotification: {
    version: CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION,
    path: "state.json#/tasks/*/operatorNotification"
  },
  workMailbox: { version: 1, path: "state.json#/mailboxes" }
});

/** The record-axis map for the current baseline (a defensive shallow copy). */
export function currentRecordVersions(): Readonly<Record<string, RecordAxisEntry>> {
  assertTaskStoreRecordVersions();
  return { ...CURRENT_RECORD_VERSIONS };
}

/**
 * Fail closed if this centralized map drifts from the persisted boundary.
 * Completeness is checked separately from version alignment so adding a new
 * StorageState/StoredTask family cannot silently make a legal Home look
 * current. Version checks use the named parser/domain constants wherever the
 * strict loader or domain constructors own the value.
 */
function assertTaskStoreRecordVersions(): void {
  const mappedKinds = Object.keys(CURRENT_RECORD_VERSIONS);
  const missing = EXPECTED_RECORD_KINDS.filter((kind) => !Object.hasOwn(CURRENT_RECORD_VERSIONS, kind));
  const unexpected = mappedKinds.filter(
    (kind) => !(EXPECTED_RECORD_KINDS as readonly string[]).includes(kind)
  );
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Record version map completeness drift: missing=${missing.join(",") || "none"}; `
      + `unexpected=${unexpected.join(",") || "none"}.`
    );
  }

  const expected: Readonly<Record<string, number>> = {
    config: CURRENT_CONFIG_SCHEMA_VERSION,
    activeRunPointer: CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION,
    leaderFailure: CURRENT_LEADER_FAILURE_SCHEMA_VERSION,
    operatorNotification: CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION,
    storedTask: CURRENT_STORED_TASK_SCHEMA_VERSION,
    taskRoleSessionSet: CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION,
    agentRun: CURRENT_AGENT_RUN_SCHEMA_VERSION
  };
  for (const [kind, version] of Object.entries(expected)) {
    const mapped = CURRENT_RECORD_VERSIONS[kind]?.version;
    if (mapped !== version) {
      throw new Error(
        `Record version map drift for ${kind}: taskStore=${version}, map=${String(mapped)}.`
      );
    }
  }

  const expectedPaths: Readonly<Record<string, string>> = {
    config: "state.json#/config",
    activeRunPointer: "state.json#/tasks/*/activeRuns",
    leaderFailure: "state.json#/tasks/*/leaderFailure",
    operatorNotification: "state.json#/tasks/*/operatorNotification"
  };
  for (const [kind, path] of Object.entries(expectedPaths)) {
    if (CURRENT_RECORD_VERSIONS[kind]?.path !== path) {
      throw new Error(
        `Record version map drift for ${kind}: path=${String(CURRENT_RECORD_VERSIONS[kind]?.path)}.`
      );
    }
  }
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
