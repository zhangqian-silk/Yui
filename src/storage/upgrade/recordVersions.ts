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
 * doctor/inspect and the migration planner can reason about record families.
 * Post-baseline record changes require an explicit adjacent registration and
 * transform in the production migration graph.
 */

import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION
} from "../storageVersions.js";
import {
  CURRENT_AGENT_RUN_SCHEMA_VERSION,
  CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION,
  CURRENT_AGENT_PROFILE_SCHEMA_VERSION,
  CURRENT_CONFIG_SCHEMA_VERSION,
  CURRENT_CONFIGURED_AGENT_SCHEMA_VERSION,
  CURRENT_CHANGE_SET_SCHEMA_VERSION,
  CURRENT_DECISION_SCHEMA_VERSION,
  CURRENT_EVENT_SCHEMA_VERSION,
  CURRENT_GLOBAL_ROLE_SCHEMA_VERSION,
  CURRENT_GLOBAL_ROLE_SESSION_SET_SCHEMA_VERSION,
  CURRENT_INPUT_REQUEST_SCHEMA_VERSION,
  CURRENT_INTEGRATION_ATTEMPT_SCHEMA_VERSION,
  CURRENT_MANAGED_WORKSPACE_SCHEMA_VERSION,
  CURRENT_MESSAGE_SCHEMA_VERSION,
  CURRENT_MILESTONE_SCHEMA_VERSION,
  CURRENT_PROJECT_SCHEMA_VERSION,
  CURRENT_REVIEW_ROUND_SCHEMA_VERSION,
  CURRENT_STORED_TASK_SCHEMA_VERSION,
  CURRENT_TASK_BRIEF_SCHEMA_VERSION,
  CURRENT_TASK_ROLE_SCHEMA_VERSION,
  CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION,
  CURRENT_TASK_SCHEMA_VERSION,
  CURRENT_WORK_ITEM_SCHEMA_VERSION,
  CURRENT_WORK_MAILBOX_SCHEMA_VERSION
} from "../taskStore.js";
import { CURRENT_LEADER_FAILURE_SCHEMA_VERSION } from "../../scheduler/leaderFailure.js";
import { CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION } from "../../scheduler/operatorNotification.js";
import type { RecordAxisEntry, StorageVersionState } from "../migration/index.js";

function descriptor(version: number, path: string): RecordAxisEntry {
  return Object.freeze({ version, path });
}

/**
 * Independent persisted-boundary contract for the direct family keys and
 * locators. The upgrade descriptor table is checked against this contract so
 * omitting a newly persisted family or changing a locator cannot make the
 * scanner silently skip that family.
 */
const EXPECTED_DIRECT_RECORD_LOCATORS: Readonly<Record<string, string>> = Object.freeze({
  config: "state.json#/config",
  configuredAgent: "state.json#/configuredAgents",
  project: "state.json#/projects",
  agentProfile: "state.json#/agentProfiles",
  globalRole: "state.json#/globalRoles",
  globalRoleSessionSet: "state.json#/globalRoleSessionSets",
  storedTask: "state.json#/tasks/*",
  task: "state.json#/tasks/*/task",
  taskBrief: "state.json#/tasks/*/brief",
  taskRole: "state.json#/tasks/*/roles",
  managedWorkspace: "state.json#/tasks/*/managedWorkspaces",
  taskRoleSessionSet: "state.json#/tasks/*/roleSessionSets",
  workItem: "state.json#/tasks/*/workItems",
  agentRun: "state.json#/tasks/*/agentRuns",
  reviewRound: "state.json#/tasks/*/reviewRounds",
  changeSet: "state.json#/tasks/*/changeSets",
  integrationAttempt: "state.json#/tasks/*/integrationAttempts",
  activeRunPointer: "state.json#/tasks/*/activeRuns",
  message: "state.json#/tasks/*/messages",
  inputRequest: "state.json#/tasks/*/inputRequests",
  decision: "state.json#/tasks/*/decisions",
  milestone: "state.json#/tasks/*/milestones",
  event: "state.json#/tasks/*/events",
  leaderFailure: "state.json#/tasks/*/leaderFailure",
  operatorNotification: "state.json#/tasks/*/operatorNotification",
  workMailbox: "state.json#/mailboxes"
});

/**
 * The one authoritative descriptor table for every direct StorageState and
 * StoredTask record family. `path` is a logical, human-readable location of
 * where the family's records live inside the authoritative store; the generic
 * engine treats it as opaque. Update this table whenever a family is added or
 * its `schemaVersion` changes — it tracks the live schema, it does not freeze
 * it.
 *
 * Lazy-initialized to avoid a circular-dependency TDZ: `recordVersions.ts`
 * imports the `CURRENT_*_SCHEMA_VERSION` constants from `taskStore.ts`, which
 * imports `requireStorageSchema` from `storageSchema.ts`, which (via the
 * provider pattern) depends on this module. Building the descriptors lazily
 * means the constants are only read at runtime, after every module has loaded.
 */
let currentRecordDescriptors: Readonly<Record<string, RecordAxisEntry>> | null = null;
function getCurrentRecordDescriptors(): Readonly<Record<string, RecordAxisEntry>> {
  if (currentRecordDescriptors === null) {
    currentRecordDescriptors = Object.freeze({
      config: descriptor(CURRENT_CONFIG_SCHEMA_VERSION, "state.json#/config"),
      configuredAgent: descriptor(
        CURRENT_CONFIGURED_AGENT_SCHEMA_VERSION,
        "state.json#/configuredAgents"
      ),
      project: descriptor(CURRENT_PROJECT_SCHEMA_VERSION, "state.json#/projects"),
      agentProfile: descriptor(CURRENT_AGENT_PROFILE_SCHEMA_VERSION, "state.json#/agentProfiles"),
      globalRole: descriptor(CURRENT_GLOBAL_ROLE_SCHEMA_VERSION, "state.json#/globalRoles"),
      globalRoleSessionSet: descriptor(
        CURRENT_GLOBAL_ROLE_SESSION_SET_SCHEMA_VERSION,
        "state.json#/globalRoleSessionSets"
      ),
      // The task aggregate is itself a versioned record family. Keep this family
      // alongside (and distinct from) the nested `task` record family: an older
      // aggregate wrapper must be classified on the record axis before the strict
      // loader is asked to parse its nested members.
      storedTask: descriptor(CURRENT_STORED_TASK_SCHEMA_VERSION, "state.json#/tasks/*"),
      task: descriptor(CURRENT_TASK_SCHEMA_VERSION, "state.json#/tasks/*/task"),
      taskBrief: descriptor(CURRENT_TASK_BRIEF_SCHEMA_VERSION, "state.json#/tasks/*/brief"),
      taskRole: descriptor(CURRENT_TASK_ROLE_SCHEMA_VERSION, "state.json#/tasks/*/roles"),
      managedWorkspace: descriptor(
        CURRENT_MANAGED_WORKSPACE_SCHEMA_VERSION,
        "state.json#/tasks/*/managedWorkspaces"
      ),
      taskRoleSessionSet: descriptor(
        CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION,
        "state.json#/tasks/*/roleSessionSets"
      ),
      workItem: descriptor(CURRENT_WORK_ITEM_SCHEMA_VERSION, "state.json#/tasks/*/workItems"),
      agentRun: descriptor(CURRENT_AGENT_RUN_SCHEMA_VERSION, "state.json#/tasks/*/agentRuns"),
      reviewRound: descriptor(
        CURRENT_REVIEW_ROUND_SCHEMA_VERSION,
        "state.json#/tasks/*/reviewRounds"
      ),
      changeSet: descriptor(CURRENT_CHANGE_SET_SCHEMA_VERSION, "state.json#/tasks/*/changeSets"),
      integrationAttempt: descriptor(
        CURRENT_INTEGRATION_ATTEMPT_SCHEMA_VERSION,
        "state.json#/tasks/*/integrationAttempts"
      ),
      activeRunPointer: descriptor(
        CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION,
        "state.json#/tasks/*/activeRuns"
      ),
      message: descriptor(CURRENT_MESSAGE_SCHEMA_VERSION, "state.json#/tasks/*/messages"),
      inputRequest: descriptor(
        CURRENT_INPUT_REQUEST_SCHEMA_VERSION,
        "state.json#/tasks/*/inputRequests"
      ),
      decision: descriptor(CURRENT_DECISION_SCHEMA_VERSION, "state.json#/tasks/*/decisions"),
      milestone: descriptor(CURRENT_MILESTONE_SCHEMA_VERSION, "state.json#/tasks/*/milestones"),
      event: descriptor(CURRENT_EVENT_SCHEMA_VERSION, "state.json#/tasks/*/events"),
      leaderFailure: descriptor(
        CURRENT_LEADER_FAILURE_SCHEMA_VERSION,
        "state.json#/tasks/*/leaderFailure"
      ),
      operatorNotification: descriptor(
        CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION,
        "state.json#/tasks/*/operatorNotification"
      ),
      workMailbox: descriptor(CURRENT_WORK_MAILBOX_SCHEMA_VERSION, "state.json#/mailboxes")
    });
  }
  return currentRecordDescriptors;
}

/** Kept as the public-facing name used by upgrade callers and tests. */
const CURRENT_RECORD_VERSIONS = getCurrentRecordDescriptors;

/** The record-axis map for the current baseline (a defensive shallow copy). */
export function currentRecordVersions(
  candidate: Readonly<Record<string, RecordAxisEntry>> = CURRENT_RECORD_VERSIONS()
): Readonly<Record<string, RecordAxisEntry>> {
  assertRecordVersionDescriptors(candidate);
  return { ...candidate };
}

/**
 * Fail closed if a record descriptor map drifts from the one authoritative
 * table. The candidate parameter is exported so the regression suite can
 * exercise an unchecked-family version/path drift directly; production callers
 * use the default current descriptor table.
 */
export function assertRecordVersionDescriptors(
  candidate: Readonly<Record<string, RecordAxisEntry>> = CURRENT_RECORD_VERSIONS()
): void {
  const expectedKinds = Object.keys(EXPECTED_DIRECT_RECORD_LOCATORS);
  const mappedKinds = Object.keys(candidate);
  const missing = expectedKinds.filter((kind) => !Object.hasOwn(candidate, kind));
  const unexpected = mappedKinds.filter((kind) => !Object.hasOwn(EXPECTED_DIRECT_RECORD_LOCATORS, kind));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Record version map completeness drift: missing=${missing.join(",") || "none"}; `
      + `unexpected=${unexpected.join(",") || "none"}.`
    );
  }

  const descriptors = getCurrentRecordDescriptors();
  for (const kind of expectedKinds) {
    const expected = descriptors[kind];
    const expectedPath = EXPECTED_DIRECT_RECORD_LOCATORS[kind]!;
    const mapped = candidate[kind];
    if (expected === undefined
      || mapped === undefined
      || mapped === null
      || mapped.version !== expected.version
      || mapped.path !== expectedPath) {
      throw new Error(
        `Record version map drift for ${kind}: expected=${String(expected?.version)}@${expectedPath}; `
        + `actual=${String(mapped?.version)}@${String(mapped?.path)}.`
      );
    }
  }
}

/**
 * The full latest-supported {@link StorageVersionState} this release understands:
 * the scalar layout/aggregate versions plus the current record map. The engine
 * and classifier compare a source against this to decide the four-state verdict.
 */
export function latestStorageVersionState(
  recordDescriptors: Readonly<Record<string, RecordAxisEntry>> = CURRENT_RECORD_VERSIONS()
): StorageVersionState {
  return {
    layout: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregate: CURRENT_AGGREGATE_SCHEMA_VERSION,
    record: currentRecordVersions(recordDescriptors)
  };
}
