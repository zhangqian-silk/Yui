/** Current record-family versions for the single SQLite storage contract. */

import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION
} from "../storageVersions.js";
import {
  CURRENT_TURN_SCHEMA_VERSION,
  CURRENT_AGENT_PROFILE_SCHEMA_VERSION,
  CURRENT_CAPABILITY_GRANT_SCHEMA_VERSION,
  CURRENT_CONFIG_SCHEMA_VERSION,
  CURRENT_CONFIGURED_AGENT_SCHEMA_VERSION,
  CURRENT_CHANGE_SET_SCHEMA_VERSION,
  CURRENT_CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  CURRENT_DECISION_SCHEMA_VERSION,
  CURRENT_EVENT_SCHEMA_VERSION,
  CURRENT_GLOBAL_ROLE_SCHEMA_VERSION,
  CURRENT_GLOBAL_ROLE_SESSION_SET_SCHEMA_VERSION,
  CURRENT_INPUT_REQUEST_SCHEMA_VERSION,
  CURRENT_INTEGRATION_ATTEMPT_SCHEMA_VERSION,
  CURRENT_INTEGRATION_QUEUE_SCHEMA_VERSION,
  CURRENT_MANAGED_WORKSPACE_SCHEMA_VERSION,
  CURRENT_MESSAGE_SCHEMA_VERSION,
  CURRENT_MILESTONE_SCHEMA_VERSION,
  CURRENT_PUBLICATION_REFERENCE_SCHEMA_VERSION,
  CURRENT_PROJECT_SCHEMA_VERSION,
  CURRENT_RELEASE_WORKFLOW_SCHEMA_VERSION,
  CURRENT_REVIEW_ROUND_SCHEMA_VERSION,
  CURRENT_TASK_BRIEF_SCHEMA_VERSION,
  CURRENT_TASK_ROLE_SCHEMA_VERSION,
  CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION,
  CURRENT_TASK_SCHEMA_VERSION,
  CURRENT_WORK_ITEM_SCHEMA_VERSION,
  CURRENT_WORK_MAILBOX_SCHEMA_VERSION
} from "../taskStore.js";
import { CURRENT_LEADER_FAILURE_SCHEMA_VERSION } from "../../scheduler/leaderFailure.js";
import { CURRENT_TASK_WAKE_SCHEMA_VERSION } from "../../scheduler/taskWake.js";
import { CURRENT_DURABLE_JOB_SCHEMA_VERSION } from "../../job/durableJob.js";
export type RecordAxisEntry = Readonly<{ version: number; path: string }>;
export type StorageVersionState = Readonly<{
  layout: number;
  aggregate: number;
  record: Readonly<Record<string, RecordAxisEntry>>;
}>;

function descriptor(kind: string, version: number): RecordAxisEntry {
  return Object.freeze({ version, path: `sqlite:${kind}` });
}

// Lazy construction avoids the taskStore -> storageSchema -> recordVersions
// initialization cycle while keeping one canonical family list.
let currentDescriptors: Readonly<Record<string, RecordAxisEntry>> | null = null;
function getCurrentRecordDescriptors(): Readonly<Record<string, RecordAxisEntry>> {
  if (currentDescriptors === null) {
    const versions: Readonly<Record<string, number>> = {
      config: CURRENT_CONFIG_SCHEMA_VERSION,
      configuredAgent: CURRENT_CONFIGURED_AGENT_SCHEMA_VERSION,
      project: CURRENT_PROJECT_SCHEMA_VERSION,
      agentProfile: CURRENT_AGENT_PROFILE_SCHEMA_VERSION,
      globalRole: CURRENT_GLOBAL_ROLE_SCHEMA_VERSION,
      globalRoleSessionSet: CURRENT_GLOBAL_ROLE_SESSION_SET_SCHEMA_VERSION,
      task: CURRENT_TASK_SCHEMA_VERSION,
      taskBrief: CURRENT_TASK_BRIEF_SCHEMA_VERSION,
      taskRole: CURRENT_TASK_ROLE_SCHEMA_VERSION,
      managedWorkspace: CURRENT_MANAGED_WORKSPACE_SCHEMA_VERSION,
      taskRoleSessionSet: CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION,
      workItem: CURRENT_WORK_ITEM_SCHEMA_VERSION,
      contextSnapshot: CURRENT_CONTEXT_SNAPSHOT_SCHEMA_VERSION,
      turn: CURRENT_TURN_SCHEMA_VERSION,
      reviewRound: CURRENT_REVIEW_ROUND_SCHEMA_VERSION,
      changeSet: CURRENT_CHANGE_SET_SCHEMA_VERSION,
      integrationAttempt: CURRENT_INTEGRATION_ATTEMPT_SCHEMA_VERSION,
      integrationQueue: CURRENT_INTEGRATION_QUEUE_SCHEMA_VERSION,
      durableJob: CURRENT_DURABLE_JOB_SCHEMA_VERSION,
      message: CURRENT_MESSAGE_SCHEMA_VERSION,
      inputRequest: CURRENT_INPUT_REQUEST_SCHEMA_VERSION,
      decision: CURRENT_DECISION_SCHEMA_VERSION,
      milestone: CURRENT_MILESTONE_SCHEMA_VERSION,
      event: CURRENT_EVENT_SCHEMA_VERSION,
      taskWake: CURRENT_TASK_WAKE_SCHEMA_VERSION,
      capabilityGrant: CURRENT_CAPABILITY_GRANT_SCHEMA_VERSION,
      releaseWorkflow: CURRENT_RELEASE_WORKFLOW_SCHEMA_VERSION,
      publicationReference: CURRENT_PUBLICATION_REFERENCE_SCHEMA_VERSION,
      leaderFailure: CURRENT_LEADER_FAILURE_SCHEMA_VERSION,
      workMailbox: CURRENT_WORK_MAILBOX_SCHEMA_VERSION
    };
    currentDescriptors = Object.freeze(Object.fromEntries(
      Object.entries(versions).map(([kind, version]) => [kind, descriptor(kind, version)])
    ));
  }
  return currentDescriptors;
}

/** Defensive copy of the current record-family contract. */
export function currentRecordVersions(
  candidate: Readonly<Record<string, RecordAxisEntry>> = getCurrentRecordDescriptors()
): Readonly<Record<string, RecordAxisEntry>> {
  assertRecordVersionDescriptors(candidate);
  return { ...candidate };
}

/** Reject missing, extra, stale, or non-SQLite record descriptors. */
export function assertRecordVersionDescriptors(
  candidate: Readonly<Record<string, RecordAxisEntry>> = getCurrentRecordDescriptors()
): void {
  const expected = getCurrentRecordDescriptors();
  const expectedKinds = Object.keys(expected);
  const mappedKinds = Object.keys(candidate);
  const missing = expectedKinds.filter((kind) => !Object.hasOwn(candidate, kind));
  const unexpected = mappedKinds.filter((kind) => !Object.hasOwn(expected, kind));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Record version map completeness drift: missing=${missing.join(",") || "none"}; `
      + `unexpected=${unexpected.join(",") || "none"}.`
    );
  }
  for (const kind of expectedKinds) {
    const wanted = expected[kind]!;
    const found = candidate[kind];
    if (found?.version !== wanted.version || found.path !== wanted.path) {
      throw new Error(
        `Record version map drift for ${kind}: expected=${wanted.version}@${wanted.path}; `
        + `actual=${String(found?.version)}@${String(found?.path)}.`
      );
    }
  }
}

export function latestStorageVersionState(
  recordDescriptors: Readonly<Record<string, RecordAxisEntry>> = getCurrentRecordDescriptors()
): StorageVersionState {
  return {
    layout: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregate: CURRENT_AGGREGATE_SCHEMA_VERSION,
    record: currentRecordVersions(recordDescriptors)
  };
}
