/** The one production transition registry and its baseline-to-current delivery gate. */
import { generateHomeIdentity } from "../../repository/homeIdentity.js";
import { latestStorageVersionState } from "../upgrade/recordVersions.js";
import type { HomeSnapshot } from "../upgrade/homeMigrationTarget.js";
import { assertBaselineConsistency, baselineStorageVersionState } from "./baseline.js";
import { planMigration } from "./planner.js";
import { MigrationRegistry } from "./registry.js";
import type { CompatibleStep, MigrationStep, StorageVersionState } from "./types.js";

const FINAL_REVIEW_AGGREGATE_FROM_VERSION = 16;
const FINAL_REVIEW_AGGREGATE_TO_VERSION = 17;
const HOME_IDENTITY_AGGREGATE_FROM_VERSION = 17;
const HOME_IDENTITY_AGGREGATE_TO_VERSION = 18;
const RUNTIME_OBSERVATION_AGGREGATE_FROM_VERSION = 18;
const RUNTIME_OBSERVATION_AGGREGATE_TO_VERSION = 19;
const MULTI_AGENT_RUNTIME_AGGREGATE_FROM_VERSION = 19;
const MULTI_AGENT_RUNTIME_AGGREGATE_TO_VERSION = 20;
const SQLITE_LAYOUT_FROM_VERSION = 6;
const SQLITE_LAYOUT_TO_VERSION = 7;
const PROJECT_FROM_VERSION = 2;
const PROJECT_TO_VERSION = 3;
const TASK_FROM_VERSION = 3;
const TASK_TO_VERSION = 4;
const WORK_ITEM_FROM_VERSION = 6;
const WORK_ITEM_TO_VERSION = 7;
const WORK_ITEM_GIT_SNAPSHOT_FROM_VERSION = 7;
const WORK_ITEM_GIT_SNAPSHOT_TO_VERSION = 8;
const WORK_ITEM_GROUP_HISTORY_FROM_VERSION = 8;
const WORK_ITEM_GROUP_HISTORY_TO_VERSION = 9;
const AGENT_RUN_FROM_VERSION = 5;
const AGENT_RUN_TO_VERSION = 6;
/**
 * v7 combines the optional Issue 04 `providerRetry`/`yieldReceipt` fields and
 * Issue 05 Leader actionability fields. All are optional, so the transition is
 * a version-only rewrite; legacy v6 records without them remain valid.
 */
const AGENT_RUN_OPTIONAL_FIELDS_FROM_VERSION = 6;
const AGENT_RUN_OPTIONAL_FIELDS_TO_VERSION = 7;
const MESSAGE_WAKE_POLICY_FROM_VERSION = 2;
const MESSAGE_WAKE_POLICY_TO_VERSION = 3;
const REVIEW_ROUND_FROM_VERSION = 2;
const REVIEW_ROUND_TO_VERSION = 3;
const REVIEW_ROUND_GIT_SNAPSHOT_FROM_VERSION = 3;
const REVIEW_ROUND_GIT_SNAPSHOT_TO_VERSION = 4;
const ACTIVE_RUN_POINTER_FROM_VERSION = 1;
const ACTIVE_RUN_POINTER_TO_VERSION = 2;
const ACTIVE_RUN_POINTER_NAMESPACE_FROM_VERSION = 2;
const ACTIVE_RUN_POINTER_NAMESPACE_TO_VERSION = 3;
const MANAGED_WORKSPACE_FROM_VERSION = 1;
const MANAGED_WORKSPACE_TO_VERSION = 2;
const CHANGE_SET_MANIFEST_FROM_VERSION = 2;
const CHANGE_SET_MANIFEST_TO_VERSION = 3;
const INTEGRATION_ATTEMPT_FROM_VERSION = 2;
const INTEGRATION_ATTEMPT_TO_VERSION = 3;
const INTEGRATION_ATTEMPT_GATE_IDENTITY_FROM_VERSION = 3;
const INTEGRATION_ATTEMPT_GATE_IDENTITY_TO_VERSION = 4;
const INTEGRATION_QUEUE_FROM_VERSION = 0;
const INTEGRATION_QUEUE_TO_VERSION = 1;
const STORED_TASK_DURABLE_JOBS_FROM_VERSION = 14;
const STORED_TASK_DURABLE_JOBS_TO_VERSION = 15;
const STORED_TASK_JOB_CALLER_KEY_HASHES_FROM_VERSION = 15;
const STORED_TASK_JOB_CALLER_KEY_HASHES_TO_VERSION = 16;
const CAPABILITY_GRANT_FROM_VERSION = 0;
const CAPABILITY_GRANT_TO_VERSION = 1;
const RELEASE_WORKFLOW_FROM_VERSION = 0;
const RELEASE_WORKFLOW_TO_VERSION = 1;
const WORK_MAILBOX_FROM_VERSION = 1;
const WORK_MAILBOX_TO_VERSION = 2;
const TASK_ROLE_SESSION_SET_FROM_VERSION = 4;
const TASK_ROLE_SESSION_SET_TO_VERSION = 5;

/**
 * Build the authoritative production graph. Transition intent and executable
 * transforms are registered together here; compatible loading and offline
 * migration consume this same graph.
 */
export function createProductionStorageRegistry(): MigrationRegistry<HomeSnapshot> {
  assertBaselineConsistency();
  const registry = new MigrationRegistry<HomeSnapshot>().registerOfflineMigration({
    axis: "layout",
    fromVersion: SQLITE_LAYOUT_FROM_VERSION,
    toVersion: SQLITE_LAYOUT_TO_VERSION,
    preconditions: requireLayoutV6Snapshot,
    transform: migrateLayoutV6ToV7,
    declaredEffects: []
  })
    .registerOfflineMigration({
    axis: "aggregate",
    fromVersion: FINAL_REVIEW_AGGREGATE_FROM_VERSION,
    toVersion: FINAL_REVIEW_AGGREGATE_TO_VERSION,
    preconditions: requireAggregateV16Snapshot,
    transform: migrateAggregateV16ToV17,
    declaredEffects: []
  })
    .registerOfflineMigration({
      axis: "aggregate",
      fromVersion: HOME_IDENTITY_AGGREGATE_FROM_VERSION,
      toVersion: HOME_IDENTITY_AGGREGATE_TO_VERSION,
      preconditions: requireAggregateV17Snapshot,
      transform: migrateAggregateV17ToV18,
      declaredEffects: []
    })
    .registerOfflineMigration({
      axis: "aggregate",
      fromVersion: MULTI_AGENT_RUNTIME_AGGREGATE_FROM_VERSION,
      toVersion: MULTI_AGENT_RUNTIME_AGGREGATE_TO_VERSION,
      preconditions: requireAggregateV19Snapshot,
      transform: migrateAggregateV19ToV20,
      declaredEffects: []
    })
    .registerOfflineMigration({
      axis: "aggregate",
      fromVersion: RUNTIME_OBSERVATION_AGGREGATE_FROM_VERSION,
      toVersion: RUNTIME_OBSERVATION_AGGREGATE_TO_VERSION,
      preconditions: requireAggregateV18Snapshot,
      transform: migrateAggregateV18ToV19,
      declaredEffects: []
    })
    .registerOfflineMigration(projectOwnershipStep())
    .registerOfflineMigration(taskWorkspaceIdentityStep())
    .registerOfflineMigration(recordFamilyStep(
      "workItem",
      WORK_ITEM_FROM_VERSION,
      WORK_ITEM_TO_VERSION,
      "workItems"
    ))
    .registerOfflineMigration(recordFamilyStep(
      "workItem",
      WORK_ITEM_GIT_SNAPSHOT_FROM_VERSION,
      WORK_ITEM_GIT_SNAPSHOT_TO_VERSION,
      "workItems"
    ))
    .registerOfflineMigration(workItemExecutionGroupHistoryStep())
    .registerOfflineMigration(recordFamilyStep(
      "agentRun",
      AGENT_RUN_FROM_VERSION,
      AGENT_RUN_TO_VERSION,
      "agentRuns"
    ))
    .registerOfflineMigration(recordFamilyStep(
      "agentRun",
      AGENT_RUN_OPTIONAL_FIELDS_FROM_VERSION,
      AGENT_RUN_OPTIONAL_FIELDS_TO_VERSION,
      "agentRuns"
    ))
    .registerOfflineMigration(messageWakePolicyStep())
    .registerOfflineMigration(recordFamilyStep(
      "reviewRound",
      REVIEW_ROUND_FROM_VERSION,
      REVIEW_ROUND_TO_VERSION,
      "reviewRounds"
    ))
    .registerOfflineMigration(recordFamilyStep(
      "reviewRound",
      REVIEW_ROUND_GIT_SNAPSHOT_FROM_VERSION,
      REVIEW_ROUND_GIT_SNAPSHOT_TO_VERSION,
      "reviewRounds"
    ))
    .registerOfflineMigration(recordFamilyStep(
      "activeRunPointer",
      ACTIVE_RUN_POINTER_FROM_VERSION,
      ACTIVE_RUN_POINTER_TO_VERSION,
      "activeRuns"
    ))
    .registerOfflineMigration(managedWorkspaceFamilyStep())
    .registerOfflineMigration(activeRunPointerNamespaceStep())
    .registerOfflineMigration(changeSetManifestStep())
    .registerOfflineMigration(integrationAttemptSupersededStep())
    .registerOfflineMigration(recordFamilyStep(
      "integrationAttempt",
      INTEGRATION_ATTEMPT_GATE_IDENTITY_FROM_VERSION,
      INTEGRATION_ATTEMPT_GATE_IDENTITY_TO_VERSION,
      "integrationAttempts"
    ))
    .registerOfflineMigration(integrationQueueIntroductionStep())
    .registerCompatible(storedTaskDurableJobsStep())
    .registerCompatible(storedTaskJobCallerKeyHashesStep())
    .registerCompatible(durableJobIntroductionStep())
    .registerOfflineMigration(capabilityGrantIntroductionStep())
    .registerOfflineMigration(releaseWorkflowIntroductionStep())
    .registerOfflineMigration(workMailboxV2Step())
    .registerOfflineMigration(taskRoleSessionSetV5Step());

  assertRegistryCoversBaselineToCurrent(registry);
  return registry;
}

function workItemExecutionGroupHistoryStep(): MigrationStep<HomeSnapshot> {
  return {
    axis: "record",
    recordKind: "workItem",
    fromVersion: WORK_ITEM_GROUP_HISTORY_FROM_VERSION,
    toVersion: WORK_ITEM_GROUP_HISTORY_TO_VERSION,
    preconditions: (snapshot) => requireRecordFamilyVersion(
      snapshot,
      "workItem",
      WORK_ITEM_GROUP_HISTORY_FROM_VERSION,
      "workItems"
    ),
    transform: migrateWorkItemExecutionGroupHistory,
    declaredEffects: []
  };
}

/**
 * Task Messages gain an optional `wakePolicy` field (Issue 05). The field is
 * absent on every older record, so this adjacent step only advances the
 * family version; the strict current parser treats the omitted field as
 * "no explicit policy" and preserves the existing routing.
 */
function messageWakePolicyStep(): MigrationStep<HomeSnapshot> {
  return {
    axis: "record",
    recordKind: "message",
    fromVersion: MESSAGE_WAKE_POLICY_FROM_VERSION,
    toVersion: MESSAGE_WAKE_POLICY_TO_VERSION,
    preconditions: (snapshot) => requireMessageFamilyVersion(
      snapshot,
      MESSAGE_WAKE_POLICY_FROM_VERSION
    ),
    transform: migrateMessageWakePolicy,
    declaredEffects: []
  };
}

function requireMessageFamilyVersion(snapshot: HomeSnapshot, version: number): void {
  const manifestVersions = asObject(snapshot.schemaManifest.recordVersions, "schema manifest recordVersions");
  if (manifestVersions.message !== version) {
    throw new Error(`Message migration requires manifest version ${version}.`);
  }
  if (snapshot.state === null) return;
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    const messages = task.messages;
    if (messages === undefined) continue;
    const map = asObject(messages, `message map ${taskId}`);
    for (const [messageId, rawMessage] of Object.entries(map)) {
      const message = asObject(rawMessage, `message ${taskId}/${messageId}`);
      if (message.schemaVersion !== version) {
        throw new Error(`Message ${taskId}/${messageId} must use schemaVersion ${version}.`);
      }
    }
  }
}

function migrateMessageWakePolicy(snapshot: HomeSnapshot): HomeSnapshot {
  requireMessageFamilyVersion(snapshot, MESSAGE_WAKE_POLICY_FROM_VERSION);
  const manifestVersions = asObject(snapshot.schemaManifest.recordVersions, "schema manifest recordVersions");
  const schemaManifest = {
    ...snapshot.schemaManifest,
    recordVersions: {
      ...manifestVersions,
      message: MESSAGE_WAKE_POLICY_TO_VERSION
    }
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  const nextTasks: Record<string, unknown> = {};
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    if (task.messages === undefined) {
      nextTasks[taskId] = { ...task };
      continue;
    }
    const messages = asObject(task.messages, `message map ${taskId}`);
    const nextMessages: Record<string, unknown> = {};
    for (const [messageId, rawMessage] of Object.entries(messages)) {
      nextMessages[messageId] = {
        ...asObject(rawMessage, `message ${taskId}/${messageId}`),
        schemaVersion: MESSAGE_WAKE_POLICY_TO_VERSION
      };
    }
    nextTasks[taskId] = { ...task, messages: nextMessages };
  }
  return {
    schemaManifest,
    state: { ...snapshot.state, tasks: nextTasks }
  };
}

/**
 * ManagedWorkspace is stored once in the owner-keyed workspace map and copied
 * into Candidates, AgentRuns, and ReviewRounds as immutable lifecycle
 * evidence.  Those copies are the same record family, not independent parent
 * records: advancing only the map leaves an otherwise legal historical Home
 * unreadable by the strict current parser.
 */
function managedWorkspaceFamilyStep(): MigrationStep<HomeSnapshot> {
  return {
    axis: "record",
    recordKind: "managedWorkspace",
    fromVersion: MANAGED_WORKSPACE_FROM_VERSION,
    toVersion: MANAGED_WORKSPACE_TO_VERSION,
    preconditions: requireLegacyManagedWorkspaceFamily,
    transform: migrateManagedWorkspaceFamily,
    declaredEffects: []
  };
}

function requireLegacyManagedWorkspaceFamily(snapshot: HomeSnapshot): void {
  requireRecordFamilyVersion(
    snapshot,
    "managedWorkspace",
    MANAGED_WORKSPACE_FROM_VERSION,
    "managedWorkspaces"
  );
  visitEmbeddedManagedWorkspaces(snapshot, (workspace, label) => {
    requireManagedWorkspaceVersion(workspace, MANAGED_WORKSPACE_FROM_VERSION, label);
    return workspace;
  });
}

function migrateManagedWorkspaceFamily(snapshot: HomeSnapshot): HomeSnapshot {
  requireLegacyManagedWorkspaceFamily(snapshot);
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  const schemaManifest = {
    ...snapshot.schemaManifest,
    recordVersions: {
      ...manifestVersions,
      managedWorkspace: MANAGED_WORKSPACE_TO_VERSION
    }
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const migrated = visitEmbeddedManagedWorkspaces(
    snapshot,
    (workspace) => ({ ...workspace, schemaVersion: MANAGED_WORKSPACE_TO_VERSION })
  );
  return { schemaManifest, state: migrated.state };
}

/**
 * Rewrite every persisted ManagedWorkspace occurrence while preserving the
 * surrounding record bytes.  The direct map is handled by the ordinary
 * record-family migration; this traversal covers the immutable embedded
 * snapshots which the strict validators also treat as ManagedWorkspace.
 */
function visitEmbeddedManagedWorkspaces(
  snapshot: HomeSnapshot,
  visit: (
    workspace: Readonly<Record<string, unknown>>,
    label: string
  ) => Readonly<Record<string, unknown>>
): HomeSnapshot {
  if (snapshot.state === null) return snapshot;
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  const nextTasks: Record<string, unknown> = {};
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    const nextTask: Record<string, unknown> = { ...task };

    if (task.managedWorkspaces !== undefined) {
      const workspaces = asObject(task.managedWorkspaces, `managedWorkspace map ${taskId}`);
      nextTask.managedWorkspaces = Object.fromEntries(
        Object.entries(workspaces).map(([recordId, rawWorkspace]) => [
          recordId,
          visit(
            asObject(rawWorkspace, `managedWorkspace ${taskId}/${recordId}`),
            `managedWorkspace ${taskId}/${recordId}`
          )
        ])
      );
    }

    if (task.workItems !== undefined) {
      const workItems = asObject(task.workItems, `workItem map ${taskId}`);
      nextTask.workItems = Object.fromEntries(
        Object.entries(workItems).map(([workItemId, rawWorkItem]) => {
          const workItem = asObject(rawWorkItem, `workItem ${taskId}/${workItemId}`);
          if (workItem.candidates === undefined) return [workItemId, { ...workItem }];
          if (!Array.isArray(workItem.candidates)) {
            throw new Error(`workItem ${taskId}/${workItemId} candidates must be an array.`);
          }
          return [workItemId, {
            ...workItem,
            candidates: workItem.candidates.map((rawCandidate, index) => {
              const candidate = asObject(
                rawCandidate,
                `Candidate ${taskId}/${workItemId}/${index}`
              );
              return migrateOptionalManagedWorkspace(
                candidate,
                `Candidate ${taskId}/${workItemId}/${index}`,
                visit
              );
            })
          }];
        })
      );
    }

    for (const mapKey of ["agentRuns", "reviewRounds"] as const) {
      if (task[mapKey] === undefined) continue;
      const records = asObject(task[mapKey], `${mapKey} map ${taskId}`);
      nextTask[mapKey] = Object.fromEntries(
        Object.entries(records).map(([recordId, rawRecord]) => [
          recordId,
          migrateOptionalManagedWorkspace(
            asObject(rawRecord, `${mapKey} ${taskId}/${recordId}`),
            `${mapKey} ${taskId}/${recordId}`,
            visit
          )
        ])
      );
    }
    nextTasks[taskId] = nextTask;
  }
  return {
    schemaManifest: snapshot.schemaManifest,
    state: { ...snapshot.state, tasks: nextTasks }
  };
}

function migrateOptionalManagedWorkspace(
  record: Readonly<Record<string, unknown>>,
  label: string,
  visit: (
    workspace: Readonly<Record<string, unknown>>,
    label: string
  ) => Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  if (record.workspace === undefined) return { ...record };
  return {
    ...record,
    workspace: visit(asObject(record.workspace, `${label} workspace`), `${label} workspace`)
  };
}

function requireManagedWorkspaceVersion(
  workspace: Readonly<Record<string, unknown>>,
  version: number,
  label: string
): void {
  if (workspace.schemaVersion !== version) {
    throw new Error(`${label} must use schemaVersion ${version}.`);
  }
}

function migrateWorkItemExecutionGroupHistory(snapshot: HomeSnapshot): HomeSnapshot {
  requireRecordFamilyVersion(
    snapshot,
    "workItem",
    WORK_ITEM_GROUP_HISTORY_FROM_VERSION,
    "workItems"
  );
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  const schemaManifest = {
    ...snapshot.schemaManifest,
    recordVersions: { ...manifestVersions, workItem: WORK_ITEM_GROUP_HISTORY_TO_VERSION }
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  const nextTasks: Record<string, unknown> = {};
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    if (task.workItems === undefined) {
      nextTasks[taskId] = { ...task };
      continue;
    }
    const workItems = asObject(task.workItems, `workItem map ${taskId}`);
    const nextWorkItems: Record<string, unknown> = {};
    for (const [recordId, rawRecord] of Object.entries(workItems)) {
      const record = asObject(rawRecord, `workItem ${taskId}/${recordId}`);
      const { executionGroup, ...rest } = record;
      if (executionGroup !== undefined
        && (executionGroup === null || typeof executionGroup !== "object" || Array.isArray(executionGroup))) {
        throw new Error(`workItem ${taskId}/${recordId} executionGroup must be an object.`);
      }
      const groupId = executionGroup === undefined
        ? undefined
        : asObject(executionGroup, `ExecutionGroup ${taskId}/${recordId}`).id;
      if (groupId !== undefined && (typeof groupId !== "string" || groupId.trim().length === 0)) {
        throw new Error(`workItem ${taskId}/${recordId} executionGroup id is invalid.`);
      }
      nextWorkItems[recordId] = {
        ...rest,
        schemaVersion: WORK_ITEM_GROUP_HISTORY_TO_VERSION,
        executionGroups: executionGroup === undefined ? [] : [executionGroup],
        ...(groupId === undefined ? {} : { currentExecutionGroupId: groupId })
      };
    }
    nextTasks[taskId] = { ...task, workItems: nextWorkItems };
  }
  return {
    schemaManifest,
    state: { ...snapshot.state, tasks: nextTasks }
  };
}

/**
 * Move the legacy `lane:<group>:<lane>` keys into a namespace that cannot be
 * mistaken for a legal Role identity.  A legacy key is only rewritten when
 * its pointed Run proves the lane lineage; otherwise a legal Role with that
 * exact name is retained.  Ambiguous or malformed lane-looking records fail
 * closed instead of guessing which active Run the old bytes meant.
 */
function activeRunPointerNamespaceStep(): MigrationStep<HomeSnapshot> {
  return {
    axis: "record",
    recordKind: "activeRunPointer",
    fromVersion: ACTIVE_RUN_POINTER_NAMESPACE_FROM_VERSION,
    toVersion: ACTIVE_RUN_POINTER_NAMESPACE_TO_VERSION,
    preconditions: (snapshot) => requireActiveRunPointerNamespaceVersion(snapshot),
    transform: (snapshot) => migrateActiveRunPointerNamespace(snapshot),
    declaredEffects: []
  };
}

function requireActiveRunPointerNamespaceVersion(snapshot: HomeSnapshot): void {
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  if (manifestVersions.activeRunPointer !== ACTIVE_RUN_POINTER_NAMESPACE_FROM_VERSION) {
    throw new Error(
      `Record activeRunPointer migration requires manifest version ${ACTIVE_RUN_POINTER_NAMESPACE_FROM_VERSION}.`
    );
  }
  if (snapshot.state === null) return;
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    const activeRuns = task.activeRuns;
    if (activeRuns === undefined) continue;
    const pointers = asObject(activeRuns, `activeRunPointer map ${taskId}`);
    for (const [key, rawPointer] of Object.entries(pointers)) {
      const pointer = asObject(rawPointer, `Active run ${taskId}/${key}`);
      if (pointer.schemaVersion !== ACTIVE_RUN_POINTER_NAMESPACE_FROM_VERSION) {
        throw new Error(
          `Active run ${taskId}/${key} must use schemaVersion ${ACTIVE_RUN_POINTER_NAMESPACE_FROM_VERSION}.`
        );
      }
      if (typeof pointer.runId !== "string" || pointer.runId.trim().length === 0) {
        throw new Error(`Active run ${taskId}/${key} has an invalid runId.`);
      }
    }
  }
}

function migrateActiveRunPointerNamespace(snapshot: HomeSnapshot): HomeSnapshot {
  requireActiveRunPointerNamespaceVersion(snapshot);
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  const schemaManifest = {
    ...snapshot.schemaManifest,
    recordVersions: {
      ...manifestVersions,
      activeRunPointer: ACTIVE_RUN_POINTER_NAMESPACE_TO_VERSION
    }
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  const nextTasks: Record<string, unknown> = {};
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    const rawActiveRuns = task.activeRuns;
    if (rawActiveRuns === undefined) {
      nextTasks[taskId] = { ...task };
      continue;
    }
    const activeRuns = asObject(rawActiveRuns, `activeRunPointer map ${taskId}`);
    const rawAgentRuns = asObject(task.agentRuns, `agentRun map ${taskId}`);
    const nextActiveRuns: Record<string, unknown> = {};
    for (const [key, rawPointer] of Object.entries(activeRuns)) {
      const pointer = asObject(rawPointer, `Active run ${taskId}/${key}`);
      const runId = typeof pointer.runId === "string" ? pointer.runId : "";
      const run = asObject(rawAgentRuns[runId], `Agent run ${taskId}/${runId}`);
      const lane = legacyLaneKeyParts(key);
      const migratedPointer = {
        ...pointer,
        schemaVersion: ACTIVE_RUN_POINTER_NAMESPACE_TO_VERSION
      };
      const addPointer = (nextKey: string): void => {
        if (nextActiveRuns[nextKey] !== undefined) {
          throw new Error(`Active run pointer key collides after migration: ${taskId}/${nextKey}.`);
        }
        nextActiveRuns[nextKey] = migratedPointer;
      };
      if (lane !== null) {
        const laneBacked = run.executionGroupId === lane.executionGroupId
          && run.executionLaneId === lane.executionLaneId;
        // The prior writer used the same map key for a legal Role and a Lane
        // when the Role itself happened to contain the `lane:g:l` shape.  The
        // v3 namespace must retain both identities instead of rejecting the
        // record or silently dropping the Role pointer.
        const roleBacked = run.roleName === key;
        if (!laneBacked && !roleBacked) {
          throw new Error(`Active run pointer lineage is invalid: ${taskId}/${key}.`);
        }
        if (roleBacked) addPointer(key);
        if (laneBacked) {
          addPointer(executionLaneNamespaceKey(lane.executionGroupId, lane.executionLaneId));
        }
      } else if (key.startsWith("lane:")) {
        // A malformed lane-looking key is allowed only when it is a legal
        // legacy Role pointer. It must not be silently reinterpreted.
        if (run.roleName !== key) {
          throw new Error(`Active run pointer key is malformed: ${taskId}/${key}.`);
        }
        addPointer(key);
      } else {
        // Role pointers remain keyed by the Role even when the pointed Run
        // also carries execution lineage (a shape emitted by the prior
        // writer).  The lane namespace above preserves that second identity.
        if (run.roleName !== key) {
          throw new Error(`Active run Role pointer is invalid: ${taskId}/${key}.`);
        }
        addPointer(key);
      }
    }
    nextTasks[taskId] = { ...task, activeRuns: nextActiveRuns };
  }
  return {
    schemaManifest,
    state: { ...snapshot.state, tasks: nextTasks }
  };
}

/**
 * ChangeSet v3 adds the optional integration manifest (tags, deleted paths,
 * target ref, evidence references).  The manifest is optional, so the
 * transition only rewrites the record version; legacy records without a
 * manifest remain valid and keep integrating.
 */
function changeSetManifestStep(): MigrationStep<HomeSnapshot> {
  return {
    axis: "record",
    recordKind: "changeSet",
    fromVersion: CHANGE_SET_MANIFEST_FROM_VERSION,
    toVersion: CHANGE_SET_MANIFEST_TO_VERSION,
    preconditions: requireChangeSetManifestVersion,
    transform: migrateChangeSetManifest,
    declaredEffects: []
  };
}

function requireChangeSetManifestVersion(snapshot: HomeSnapshot): void {
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  if (manifestVersions.changeSet !== CHANGE_SET_MANIFEST_FROM_VERSION) {
    throw new Error(
      `Record changeSet migration requires manifest version ${CHANGE_SET_MANIFEST_FROM_VERSION}.`
    );
  }
  if (snapshot.state === null) return;
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    if (task.changeSets === undefined) continue;
    const changeSets = asObject(task.changeSets, `changeSet map ${taskId}`);
    for (const [changeSetId, rawRecord] of Object.entries(changeSets)) {
      const record = asObject(rawRecord, `changeSet ${taskId}/${changeSetId}`);
      if (record.schemaVersion !== CHANGE_SET_MANIFEST_FROM_VERSION) {
        throw new Error(
          `changeSet ${taskId}/${changeSetId} must use schemaVersion ${CHANGE_SET_MANIFEST_FROM_VERSION}.`
        );
      }
    }
  }
}

function migrateChangeSetManifest(snapshot: HomeSnapshot): HomeSnapshot {
  requireChangeSetManifestVersion(snapshot);
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  const schemaManifest = {
    ...snapshot.schemaManifest,
    recordVersions: {
      ...manifestVersions,
      changeSet: CHANGE_SET_MANIFEST_TO_VERSION
    }
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  const nextTasks: Record<string, unknown> = {};
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    if (task.changeSets === undefined) {
      nextTasks[taskId] = { ...task };
      continue;
    }
    const changeSets = asObject(task.changeSets, `changeSet map ${taskId}`);
    const nextChangeSets: Record<string, unknown> = {};
    for (const [changeSetId, rawRecord] of Object.entries(changeSets)) {
      const record = asObject(rawRecord, `changeSet ${taskId}/${changeSetId}`);
      nextChangeSets[changeSetId] = {
        ...record,
        schemaVersion: CHANGE_SET_MANIFEST_TO_VERSION
      };
    }
    nextTasks[taskId] = { ...task, changeSets: nextChangeSets };
  }
  return {
    schemaManifest,
    state: { ...snapshot.state, tasks: nextTasks }
  };
}

/**
 * IntegrationAttempt v2->v3 adds the "superseded" terminal status for
 * committed Integrations that are obsolete.  The migration preserves all
 * existing fields and advances the schema version; the new status is
 * opt-in, so old records remain valid until explicitly superseded.
 */
function integrationAttemptSupersededStep(): MigrationStep<HomeSnapshot> {
  return {
    axis: "record",
    recordKind: "integrationAttempt",
    fromVersion: INTEGRATION_ATTEMPT_FROM_VERSION,
    toVersion: INTEGRATION_ATTEMPT_TO_VERSION,
    preconditions: requireIntegrationAttemptV2,
    transform: migrateIntegrationAttemptV2ToV3,
    declaredEffects: []
  };
}

function requireIntegrationAttemptV2(snapshot: HomeSnapshot): void {
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  if (manifestVersions.integrationAttempt !== INTEGRATION_ATTEMPT_FROM_VERSION) {
    throw new Error(
      `Record integrationAttempt migration requires manifest version ${INTEGRATION_ATTEMPT_FROM_VERSION}.`
    );
  }
  if (snapshot.state === null) return;
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    if (task.integrationAttempts === undefined) continue;
    const attempts = asObject(task.integrationAttempts, `integrationAttempt map ${taskId}`);
    for (const [attemptId, rawRecord] of Object.entries(attempts)) {
      const record = asObject(rawRecord, `integrationAttempt ${taskId}/${attemptId}`);
      if (record.schemaVersion !== INTEGRATION_ATTEMPT_FROM_VERSION) {
        throw new Error(
          `integrationAttempt ${taskId}/${attemptId} must use schemaVersion ${INTEGRATION_ATTEMPT_FROM_VERSION}.`
        );
      }
    }
  }
}

function migrateIntegrationAttemptV2ToV3(snapshot: HomeSnapshot): HomeSnapshot {
  requireIntegrationAttemptV2(snapshot);
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  const schemaManifest = {
    ...snapshot.schemaManifest,
    recordVersions: {
      ...manifestVersions,
      integrationAttempt: INTEGRATION_ATTEMPT_TO_VERSION
    }
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  const nextTasks: Record<string, unknown> = {};
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    if (task.integrationAttempts === undefined) {
      nextTasks[taskId] = { ...task };
      continue;
    }
    const attempts = asObject(task.integrationAttempts, `integrationAttempt map ${taskId}`);
    const nextAttempts: Record<string, unknown> = {};
    for (const [attemptId, rawRecord] of Object.entries(attempts)) {
      const record = asObject(rawRecord, `integrationAttempt ${taskId}/${attemptId}`);
      nextAttempts[attemptId] = {
        ...record,
        schemaVersion: INTEGRATION_ATTEMPT_TO_VERSION
      };
    }
    nextTasks[taskId] = { ...task, integrationAttempts: nextAttempts };
  }
  return {
    schemaManifest,
    state: { ...snapshot.state, tasks: nextTasks }
  };
}

/**
 * The integration queue is a post-baseline per-Task record family.  Its
 * explicit 0->1 introduction adds the empty map and its id high-water mark to
 * every Task aggregate and the family to the record manifest; old Homes keep
 * integrating without it until the queue is first used.
 */
function integrationQueueIntroductionStep(): MigrationStep<HomeSnapshot> {
  return {
    axis: "record",
    recordKind: "integrationQueue",
    fromVersion: INTEGRATION_QUEUE_FROM_VERSION,
    toVersion: INTEGRATION_QUEUE_TO_VERSION,
    introduction: true,
    preconditions: requireIntegrationQueueIntroduction,
    transform: introduceIntegrationQueue,
    declaredEffects: []
  };
}

function requireIntegrationQueueIntroduction(snapshot: HomeSnapshot): void {
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  if (manifestVersions.integrationQueue !== undefined) {
    throw new Error("integrationQueue is already introduced in the record manifest.");
  }
  if (snapshot.state === null) return;
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    if (task.integrationQueue !== undefined) {
      throw new Error(`Task aggregate already carries an integrationQueue map: ${taskId}.`);
    }
  }
}

function introduceIntegrationQueue(snapshot: HomeSnapshot): HomeSnapshot {
  requireIntegrationQueueIntroduction(snapshot);
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  const schemaManifest = {
    ...snapshot.schemaManifest,
    recordVersions: {
      ...manifestVersions,
      integrationQueue: INTEGRATION_QUEUE_TO_VERSION
    }
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  const nextTasks: Record<string, unknown> = {};
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    const highWaterMarks = asObject(
      task.idHighWaterMarks ?? {},
      `Task id high-water marks ${taskId}`
    );
    nextTasks[taskId] = {
      ...task,
      idHighWaterMarks: { ...highWaterMarks, integrationQueue: 0 },
      integrationQueue: {}
    };
  }
  return {
    schemaManifest,
    state: { ...snapshot.state, tasks: nextTasks }
  };
}

function legacyLaneKeyParts(key: string):
  { executionGroupId: string; executionLaneId: string } | null {
  const match = /^lane:([^:]+):([^:]+)$/u.exec(key);
  if (match === null) return null;
  return { executionGroupId: match[1], executionLaneId: match[2] };
}

function executionLaneNamespaceKey(executionGroupId: string, executionLaneId: string): string {
  return `/execution-lane/${encodeLaneKeyPart(executionGroupId)}:${encodeLaneKeyPart(executionLaneId)}`;
}

function encodeLaneKeyPart(value: string): string {
  return encodeURIComponent(value).replace(/:/gu, "%3A");
}

/**
 * The StoredTask aggregate gains the `durableJobs` record family. Every v14
 * task defaults to an empty map; the compatible normalizer adds it in place
 * without rewriting any other field. The strict source validator rejects
 * unknown fields so a pre-v15 Home cannot smuggle an unrecognized shape.
 */
function storedTaskDurableJobsStep(): CompatibleStep<HomeSnapshot> {
  return {
    kind: "compatible",
    axis: "record",
    recordKind: "storedTask",
    fromVersion: STORED_TASK_DURABLE_JOBS_FROM_VERSION,
    toVersion: STORED_TASK_DURABLE_JOBS_TO_VERSION,
    defaults: [
      "durableJobs defaults to an empty map on every Task aggregate",
      "idHighWaterMarks.durableJob defaults to 0 on every Task aggregate"
    ],
    validateSource: (snapshot) => requireStoredTaskV14Shape(snapshot),
    normalize: (snapshot) => normalizeStoredTaskV14ToV15(snapshot)
  };
}

const STORED_TASK_V14_FIELDS = [
  "schemaVersion",
  "task",
  "idHighWaterMarks",
  "brief",
  "changeSets",
  "integrationAttempts",
  "integrationQueue",
  // durableJobs may already be present on a v14 task when the Home was
  // written by a build that had the family before the storedTask version
  // advanced (or after a state.json→SQLite repair round-trip, which
  // reconstructs every current family map). The 14→15 normalizer preserves
  // existing records instead of overwriting them with an empty map.
  "durableJobs",
  // jobCallerKeyHashes is introduced at v16 but the state.json→SQLite repair
  // round-trip reconstructs every current family map, so a v14 task may carry
  // an empty map after the repair. The 14→15 normalizer preserves it.
  "jobCallerKeyHashes",
  "capabilityGrants",
  "releaseWorkflows",
  "roles",
  "managedWorkspaces",
  "roleSessionSets",
  "workItems",
  "agentRuns",
  "reviewRounds",
  "activeRuns",
  "messages",
  "inputRequests",
  "decisions",
  "milestones",
  "events",
  "leaderFailure",
  "operatorNotification"
] as const;

function requireStoredTaskV14Shape(snapshot: HomeSnapshot): void {
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  if (manifestVersions.storedTask !== STORED_TASK_DURABLE_JOBS_FROM_VERSION) {
    throw new Error(
      `Record storedTask compatible step requires manifest version ${STORED_TASK_DURABLE_JOBS_FROM_VERSION}.`
    );
  }
  if (snapshot.state === null) return;
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    if (task.schemaVersion !== STORED_TASK_DURABLE_JOBS_FROM_VERSION) {
      throw new Error(
        `Task aggregate ${taskId} must use schemaVersion ${STORED_TASK_DURABLE_JOBS_FROM_VERSION}.`
      );
    }
    const allowed = new Set<string>(STORED_TASK_V14_FIELDS);
    const unknown = Object.keys(task).find((key) => !allowed.has(key));
    if (unknown !== undefined) {
      throw new Error(
        `Task aggregate ${taskId} has an unknown v14 field: ${unknown}.`
      );
    }
  }
}

function normalizeStoredTaskV14ToV15(snapshot: HomeSnapshot): HomeSnapshot {
  requireStoredTaskV14Shape(snapshot);
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  const schemaManifest = {
    ...snapshot.schemaManifest,
    recordVersions: {
      ...manifestVersions,
      storedTask: STORED_TASK_DURABLE_JOBS_TO_VERSION
    }
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  const nextTasks: Record<string, unknown> = {};
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    // The v14 high-water marks have no durableJob family; the strict current
    // parser requires every family key, so the normalizer supplies the zero
    // default in the same pass as the empty durableJobs map.
    const highWaterMarks = asObject(
      task.idHighWaterMarks,
      `Task aggregate ${taskId} idHighWaterMarks`
    );
    const existingJobs = task.durableJobs === undefined
      ? {}
      : asObject(task.durableJobs, `Task aggregate ${taskId} durableJobs`);
    const existingJobMark = highWaterMarks.durableJob;
    nextTasks[taskId] = {
      ...task,
      schemaVersion: STORED_TASK_DURABLE_JOBS_TO_VERSION,
      idHighWaterMarks: {
        ...highWaterMarks,
        durableJob: typeof existingJobMark === "number" ? existingJobMark : 0
      },
      durableJobs: existingJobs
    };
  }
  return {
    schemaManifest,
    state: { ...snapshot.state, tasks: nextTasks }
  };
}

/**
 * rr13: The StoredTask aggregate gains the `jobCallerKeyHashes` map. Every v15
 * task defaults to an empty map; the compatible normalizer adds it in place
 * without rewriting any other field. A v15 task must not already carry the
 * field. No legacy fallback: a Session whose hash is absent is rejected at the
 * Controller boundary (fail-closed).
 */
function storedTaskJobCallerKeyHashesStep(): CompatibleStep<HomeSnapshot> {
  return {
    kind: "compatible",
    axis: "record",
    recordKind: "storedTask",
    fromVersion: STORED_TASK_JOB_CALLER_KEY_HASHES_FROM_VERSION,
    toVersion: STORED_TASK_JOB_CALLER_KEY_HASHES_TO_VERSION,
    defaults: [
      "jobCallerKeyHashes defaults to an empty map on every Task aggregate"
    ],
    validateSource: (snapshot) => requireStoredTaskV15Shape(snapshot),
    normalize: (snapshot) => normalizeStoredTaskV15ToV16(snapshot)
  };
}

const STORED_TASK_V15_FIELDS = [
  "schemaVersion",
  "task",
  "idHighWaterMarks",
  "brief",
  "changeSets",
  "integrationAttempts",
  "integrationQueue",
  "durableJobs",
  // May already be present after a state.json→SQLite repair round-trip (the
  // reverse reader reconstructs every current family map). The 15→16
  // normalizer preserves existing hashes instead of overwriting them.
  "jobCallerKeyHashes",
  "capabilityGrants",
  "releaseWorkflows",
  "roles",
  "managedWorkspaces",
  "roleSessionSets",
  "workItems",
  "agentRuns",
  "reviewRounds",
  "activeRuns",
  "messages",
  "inputRequests",
  "decisions",
  "milestones",
  "events",
  "leaderFailure",
  "operatorNotification"
] as const;

function requireStoredTaskV15Shape(snapshot: HomeSnapshot): void {
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  if (manifestVersions.storedTask !== STORED_TASK_JOB_CALLER_KEY_HASHES_FROM_VERSION) {
    throw new Error(
      `Record storedTask compatible step requires manifest version ${STORED_TASK_JOB_CALLER_KEY_HASHES_FROM_VERSION}.`
    );
  }
  if (snapshot.state === null) return;
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    if (task.schemaVersion !== STORED_TASK_JOB_CALLER_KEY_HASHES_FROM_VERSION) {
      throw new Error(
        `Task aggregate ${taskId} must use schemaVersion ${STORED_TASK_JOB_CALLER_KEY_HASHES_FROM_VERSION}.`
      );
    }
    const allowed = new Set<string>(STORED_TASK_V15_FIELDS);
    const unknown = Object.keys(task).find((key) => !allowed.has(key));
    if (unknown !== undefined) {
      throw new Error(
        `Task aggregate ${taskId} has an unknown v15 field: ${unknown}.`
      );
    }
  }
}

function normalizeStoredTaskV15ToV16(snapshot: HomeSnapshot): HomeSnapshot {
  requireStoredTaskV15Shape(snapshot);
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  const schemaManifest = {
    ...snapshot.schemaManifest,
    recordVersions: {
      ...manifestVersions,
      storedTask: STORED_TASK_JOB_CALLER_KEY_HASHES_TO_VERSION
    }
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  const nextTasks: Record<string, unknown> = {};
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    const existingHashes = task.jobCallerKeyHashes === undefined
      ? {}
      : asObject(task.jobCallerKeyHashes, `Task aggregate ${taskId} jobCallerKeyHashes`);
    nextTasks[taskId] = {
      ...task,
      schemaVersion: STORED_TASK_JOB_CALLER_KEY_HASHES_TO_VERSION,
      jobCallerKeyHashes: existingHashes
    };
  }
  return {
    schemaManifest,
    state: { ...snapshot.state, tasks: nextTasks }
  };
}

/**
 * The durableJob record family is introduced alongside the StoredTask v15
 * aggregate. A pre-baseline Home has no durableJobs map and no manifest entry;
 * the introduction declares the family at version 1. The StoredTask 14->15
 * compatible step supplies the empty map; this step only advances the manifest
 * record version so the planner can resolve the 0->1 boundary.
 */
function durableJobIntroductionStep(): CompatibleStep<HomeSnapshot> {
  return {
    kind: "compatible",
    axis: "record",
    recordKind: "durableJob",
    fromVersion: 0,
    toVersion: 1,
    introduction: true,
    defaults: ["durableJob family is introduced as an empty map on every Task"],
    validateSource: (snapshot) => {
      const manifestVersions = asObject(
        snapshot.schemaManifest.recordVersions,
        "schema manifest recordVersions"
      );
      const declared = manifestVersions.durableJob;
      if (declared !== undefined && declared !== 0) {
        throw new Error(
          `Record durableJob introduction requires manifest version 0 or absent, found ${String(declared)}.`
        );
      }
      if (snapshot.state === null) return;
      const tasks = asObject(snapshot.state.tasks, "state tasks");
      for (const [taskId, rawTask] of Object.entries(tasks)) {
        const task = asObject(rawTask, `Task aggregate ${taskId}`);
        if (task.durableJobs !== undefined) {
          const jobs = asObject(task.durableJobs, `durableJobs map ${taskId}`);
          if (Object.keys(jobs).length > 0) {
            throw new Error(
              `Task aggregate ${taskId} must not carry durableJobs before introduction.`
            );
          }
        }
      }
    },
    normalize: (snapshot) => {
      const manifestVersions = asObject(
        snapshot.schemaManifest.recordVersions,
        "schema manifest recordVersions"
      );
      return {
        schemaManifest: {
          ...snapshot.schemaManifest,
          recordVersions: {
            ...manifestVersions,
            durableJob: 1
          }
        },
        state: snapshot.state === null
          ? null
          : { ...snapshot.state }
      };
    }
  };
}

/**
 * Upgrade one nested Task record family without guessing fields or repairing
 * malformed state. The new execution lineage fields are optional, so legal
 * old single-lane records retain their direct shape; the next dispatch creates
 * the unified one-lane Group explicitly. The version transition is still
 * durable and centralized, which keeps old Homes out of the strict current
 * parser until this step has run.
 */
/**
 * The post-baseline introduction of the task-scoped CapabilityGrant family.
 * A pre-introduction Home names no capabilityGrant manifest version and its
 * Task aggregates carry no `capabilityGrants` map; this explicit 0->1 step
 * adds the empty family to every Task (plus the matching high-water mark) so
 * the strict current parser can open the migrated state.
 */
function capabilityGrantIntroductionStep(): MigrationStep<HomeSnapshot> {
  return {
    axis: "record",
    recordKind: "capabilityGrant",
    fromVersion: CAPABILITY_GRANT_FROM_VERSION,
    toVersion: CAPABILITY_GRANT_TO_VERSION,
    introduction: true,
    preconditions: requireCapabilityGrantIntroduction,
    transform: introduceCapabilityGrantFamily,
    declaredEffects: []
  };
}

function requireCapabilityGrantIntroduction(snapshot: HomeSnapshot): void {
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  const namedVersion = manifestVersions.capabilityGrant;
  if (namedVersion !== undefined && namedVersion !== CAPABILITY_GRANT_FROM_VERSION) {
    throw new Error(
      `Record capabilityGrant introduction requires an absent manifest version or ${CAPABILITY_GRANT_FROM_VERSION}.`
    );
  }
  if (snapshot.state === null) return;
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    if (task.capabilityGrants !== undefined) {
      const grants = asObject(task.capabilityGrants, `capabilityGrant map ${taskId}`);
      if (Object.keys(grants).length > 0) {
        throw new Error(
          `Capability grant introduction found existing records: ${taskId}.`
        );
      }
    }
    const marks = task.idHighWaterMarks;
    if (marks !== undefined) {
      const highWaterMarks = asObject(marks, `Task id high-water marks ${taskId}`);
      const mark = highWaterMarks.capabilityGrant;
      if (mark !== undefined && mark !== CAPABILITY_GRANT_FROM_VERSION) {
        throw new Error(
          `Capability grant introduction found a high-water mark: ${taskId}.`
        );
      }
    }
  }
}

function introduceCapabilityGrantFamily(snapshot: HomeSnapshot): HomeSnapshot {
  requireCapabilityGrantIntroduction(snapshot);
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  const schemaManifest = {
    ...snapshot.schemaManifest,
    recordVersions: {
      ...manifestVersions,
      capabilityGrant: CAPABILITY_GRANT_TO_VERSION
    }
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  const nextTasks: Record<string, unknown> = {};
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    const marks = asObject(task.idHighWaterMarks, `Task id high-water marks ${taskId}`);
    nextTasks[taskId] = {
      ...task,
      idHighWaterMarks: { ...marks, capabilityGrant: CAPABILITY_GRANT_FROM_VERSION },
      capabilityGrants: {}
    };
  }
  return {
    schemaManifest,
    state: { ...snapshot.state, tasks: nextTasks }
  };
}

/**
 * The post-baseline introduction of the task-scoped ReleaseWorkflow family.
 * A pre-introduction Home names no releaseWorkflow manifest version and its
 * Task aggregates carry no `releaseWorkflows` map; this explicit 0->1 step
 * adds the empty family to every Task (plus the matching high-water mark) so
 * the strict current parser can open the migrated state.
 */
function releaseWorkflowIntroductionStep(): MigrationStep<HomeSnapshot> {
  return {
    axis: "record",
    recordKind: "releaseWorkflow",
    fromVersion: RELEASE_WORKFLOW_FROM_VERSION,
    toVersion: RELEASE_WORKFLOW_TO_VERSION,
    introduction: true,
    preconditions: requireReleaseWorkflowIntroduction,
    transform: introduceReleaseWorkflowFamily,
    declaredEffects: []
  };
}

function requireReleaseWorkflowIntroduction(snapshot: HomeSnapshot): void {
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  const namedVersion = manifestVersions.releaseWorkflow;
  if (namedVersion !== undefined && namedVersion !== RELEASE_WORKFLOW_FROM_VERSION) {
    throw new Error(
      `Record releaseWorkflow introduction requires an absent manifest version or ${RELEASE_WORKFLOW_FROM_VERSION}.`
    );
  }
  if (snapshot.state === null) return;
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    if (task.releaseWorkflows !== undefined) {
      const workflows = asObject(task.releaseWorkflows, `releaseWorkflow map ${taskId}`);
      if (Object.keys(workflows).length > 0) {
        throw new Error(
          `Release workflow introduction found existing records: ${taskId}.`
        );
      }
    }
    const marks = task.idHighWaterMarks;
    if (marks !== undefined) {
      const highWaterMarks = asObject(marks, `Task id high-water marks ${taskId}`);
      const mark = highWaterMarks.releaseWorkflow;
      if (mark !== undefined && mark !== RELEASE_WORKFLOW_FROM_VERSION) {
        throw new Error(
          `Release workflow introduction found a high-water mark: ${taskId}.`
        );
      }
    }
  }
}

function introduceReleaseWorkflowFamily(snapshot: HomeSnapshot): HomeSnapshot {
  requireReleaseWorkflowIntroduction(snapshot);
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  const schemaManifest = {
    ...snapshot.schemaManifest,
    recordVersions: {
      ...manifestVersions,
      releaseWorkflow: RELEASE_WORKFLOW_TO_VERSION
    }
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  const nextTasks: Record<string, unknown> = {};
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const task = asObject(rawTask, `Task aggregate ${taskId}`);
    const marks = asObject(task.idHighWaterMarks, `Task id high-water marks ${taskId}`);
    nextTasks[taskId] = {
      ...task,
      idHighWaterMarks: { ...marks, releaseWorkflow: RELEASE_WORKFLOW_FROM_VERSION },
      releaseWorkflows: {}
    };
  }
  return {
    schemaManifest,
    state: { ...snapshot.state, tasks: nextTasks }
  };
}

function recordFamilyStep(
  recordKind: string,
  fromVersion: number,
  toVersion: number,
  taskMapKey: "workItems" | "agentRuns" | "reviewRounds" | "activeRuns" | "managedWorkspaces" | "integrationAttempts"
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

/**
 * The snapshot boundary is nested inside WorkItem/ReviewRound ExecutionGroup
 * results.  The parent record versions make that persisted shape explicit;
 * this adjacent step intentionally performs no field rewrite, preserving old
 * records while preventing a pre-v8/pre-v4 Home from entering the strict
 * current parser without the declared transition.
 */

function requireRecordFamilyVersion(
  snapshot: HomeSnapshot,
  recordKind: string,
  fromVersion: number,
  taskMapKey: "workItems" | "agentRuns" | "reviewRounds" | "activeRuns" | "managedWorkspaces" | "integrationAttempts"
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
  taskMapKey: "workItems" | "agentRuns" | "reviewRounds" | "activeRuns" | "managedWorkspaces" | "integrationAttempts"
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

/**
 * Layout 6 -> 7 is the state.json -> SQLite WAL transition (task-21 §8). The
 * transform only advances the manifest's layout version; the staged SQLite
 * database is populated by the migration target's `writeFreshOutput`, and the
 * `state.json` document is retained read-only for rollback. The precondition
 * requires a layout-6 manifest so a future layout cannot be silently regressed.
 */
function requireLayoutV6Snapshot(snapshot: HomeSnapshot): void {
  if (snapshot.schemaManifest.storageVersion !== SQLITE_LAYOUT_FROM_VERSION) {
    throw new Error(
      `Layout ${SQLITE_LAYOUT_FROM_VERSION}->${SQLITE_LAYOUT_TO_VERSION} migration requires ` +
      `schema.json storageVersion ${SQLITE_LAYOUT_FROM_VERSION}.`
    );
  }
}

function migrateLayoutV6ToV7(snapshot: HomeSnapshot): HomeSnapshot {
  requireLayoutV6Snapshot(snapshot);
  return {
    schemaManifest: {
      ...snapshot.schemaManifest,
      storageVersion: SQLITE_LAYOUT_TO_VERSION
    },
    state: snapshot.state
  };
}

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
 * Introduce the durable Home identity. A v18 aggregate always carries one; a
 * Home with no state.json yet gets its identity when its first state is
 * written, so this step only mints one when state.json already exists.
 */
function migrateAggregateV17ToV18(snapshot: HomeSnapshot): HomeSnapshot {
  const schemaManifest = {
    ...snapshot.schemaManifest,
    aggregateSchemaVersion: HOME_IDENTITY_AGGREGATE_TO_VERSION
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const state = snapshot.state;
  if (state.homeIdentity !== undefined) {
    throw new Error("Aggregate 17->18 migration found an unexpected homeIdentity.");
  }
  return {
    schemaManifest,
    state: {
      ...state,
      schemaVersion: HOME_IDENTITY_AGGREGATE_TO_VERSION,
      homeIdentity: generateHomeIdentity(new Date())
    }
  };
}

function requireAggregateV17Snapshot(snapshot: HomeSnapshot): void {
  if (snapshot.schemaManifest.aggregateSchemaVersion
    !== HOME_IDENTITY_AGGREGATE_FROM_VERSION) {
    throw new Error(
      "Aggregate 17->18 migration requires schema.json aggregateSchemaVersion 17."
    );
  }
  if (snapshot.state !== null
    && snapshot.state.schemaVersion !== HOME_IDENTITY_AGGREGATE_FROM_VERSION) {
    throw new Error(
      "Aggregate 17->18 migration requires state.json schemaVersion 17 to match schema.json."
    );
  }
}

/**
 * Runtime state is now projected exclusively from canonical
 * `runtime.observation` events. Offline upgrade inventory proves there are no
 * active Runs or live Sessions. A retired Task has also explicitly abandoned
 * its runtime, so its stored runtime inconsistencies no longer block the Home;
 * the anomalous records themselves remain available as history. Non-retired
 * Tasks still fail closed and receive the supported retirement command.
 */
function migrateAggregateV18ToV19(snapshot: HomeSnapshot): HomeSnapshot {
  requireAggregateV18Snapshot(snapshot);
  const schemaManifest = {
    ...snapshot.schemaManifest,
    aggregateSchemaVersion: RUNTIME_OBSERVATION_AGGREGATE_TO_VERSION
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  const nextTasks: Record<string, unknown> = {};
  for (const [taskId, rawStoredTask] of Object.entries(tasks)) {
    const storedTask = asObject(rawStoredTask, `Task aggregate ${taskId}`);
    const rawTask = storedTask.task;
    const task = rawTask !== null && typeof rawTask === "object" && !Array.isArray(rawTask)
      ? rawTask as Record<string, unknown>
      : undefined;
    if (task?.status === "retired") {
      nextTasks[taskId] = { ...storedTask };
      continue;
    }
    requireResolvableActiveRunPointers(taskId, storedTask);
    nextTasks[taskId] = { ...storedTask };
  }
  return {
    schemaManifest,
    state: {
      ...snapshot.state,
      schemaVersion: RUNTIME_OBSERVATION_AGGREGATE_TO_VERSION,
      tasks: nextTasks
    }
  };
}

function requireResolvableActiveRunPointers(
  taskId: string,
  storedTask: Record<string, unknown>
): void {
  if (storedTask.activeRuns === undefined) return;
  const activeRuns = asObject(storedTask.activeRuns, `activeRunPointer map ${taskId}`);
  if (Object.keys(activeRuns).length === 0) return;
  const agentRuns = asObject(storedTask.agentRuns, `agentRun map ${taskId}`);
  for (const [pointer, rawActiveRun] of Object.entries(activeRuns)) {
    const activeRun = asObject(rawActiveRun, `Active run ${taskId}/${pointer}`);
    const runId = typeof activeRun.runId === "string" ? activeRun.runId.trim() : "";
    if (runId.length === 0) {
      throw new Error(
        `Active run pointer ${taskId}/${pointer} has an invalid runId. `
        + taskRetirementUpgradeHint(taskId)
      );
    }
    if (agentRuns[runId] === undefined) {
      throw new Error(
        `Active run pointer ${taskId}/${pointer} references missing agent run ${runId}. `
        + taskRetirementUpgradeHint(taskId)
      );
    }
  }
}

function taskRetirementUpgradeHint(taskId: string): string {
  return `Retire Task ${taskId} with `
    + `\`yui task retire ${taskId} --summary "abandon inconsistent runtime state"\`, `
    + "then retry `yui update`.";
}

function requireAggregateV18Snapshot(snapshot: HomeSnapshot): void {
  if (snapshot.schemaManifest.aggregateSchemaVersion
    !== RUNTIME_OBSERVATION_AGGREGATE_FROM_VERSION) {
    throw new Error(
      "Aggregate 18->19 migration requires schema.json aggregateSchemaVersion 18."
    );
  }
  if (snapshot.state !== null
    && snapshot.state.schemaVersion !== RUNTIME_OBSERVATION_AGGREGATE_FROM_VERSION) {
    throw new Error(
      "Aggregate 18->19 migration requires state.json schemaVersion 18 to match schema.json."
    );
  }
}

function requireAggregateV19Snapshot(snapshot: HomeSnapshot): void {
  if (snapshot.schemaManifest.aggregateSchemaVersion
    !== MULTI_AGENT_RUNTIME_AGGREGATE_FROM_VERSION) {
    throw new Error("Aggregate 19->20 migration requires schema.json aggregateSchemaVersion 19.");
  }
  if (snapshot.state !== null
    && snapshot.state.schemaVersion !== MULTI_AGENT_RUNTIME_AGGREGATE_FROM_VERSION) {
    throw new Error(
      "Aggregate 19->20 migration requires state.json schemaVersion 19 to match schema.json."
    );
  }
}

function migrateAggregateV19ToV20(snapshot: HomeSnapshot): HomeSnapshot {
  requireAggregateV19Snapshot(snapshot);
  const schemaManifest = {
    ...snapshot.schemaManifest,
    aggregateSchemaVersion: MULTI_AGENT_RUNTIME_AGGREGATE_TO_VERSION
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  const nextTasks: Record<string, unknown> = {};
  for (const [taskId, rawAggregate] of Object.entries(tasks)) {
    const aggregate = asObject(rawAggregate, `Task aggregate ${taskId}`);
    const events = asObject(aggregate.events, `Task events ${taskId}`);
    const nextEvents: Record<string, unknown> = {};
    for (const [eventId, rawEvent] of Object.entries(events)) {
      const event = asObject(rawEvent, `Task event ${taskId}/${eventId}`);
      nextEvents[eventId] = event.type === "runtime.observation"
        ? migrateRuntimeObservationEventV1ToV2(event, taskId, eventId)
        : { ...event };
    }
    nextTasks[taskId] = { ...aggregate, events: nextEvents };
  }
  return {
    schemaManifest,
    state: {
      ...snapshot.state,
      schemaVersion: MULTI_AGENT_RUNTIME_AGGREGATE_TO_VERSION,
      tasks: nextTasks
    }
  };
}

function migrateRuntimeObservationEventV1ToV2(
  event: Record<string, unknown>,
  taskId: string,
  eventId: string
): Record<string, unknown> {
  const payload = asObject(event.payload, `Runtime observation event payload ${taskId}/${eventId}`);
  if (typeof payload.observation !== "string") {
    throw new Error(`Runtime observation event has no canonical observation: ${taskId}/${eventId}.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payload.observation);
  } catch {
    throw new Error(`Runtime observation event JSON is invalid: ${taskId}/${eventId}.`);
  }
  const observation = asObject(raw, `Runtime observation ${taskId}/${eventId}`);
  if (observation.schemaVersion !== 1) {
    throw new Error(`Runtime observation ${taskId}/${eventId} must use schemaVersion 1.`);
  }
  const fence = asObject(observation.fence, `Runtime observation fence ${taskId}/${eventId}`);
  const kind = String(observation.kind);
  const semanticKey = migratedRuntimeObservationSemanticKey(observation, fence);
  const nextObservation = {
    ...observation,
    schemaVersion: 2,
    semanticKey,
    fence: {
      ...fence,
      ...(fence.nativeSessionId === undefined
        ? {}
        : { conversationId: String(fence.nativeSessionId) }),
      activationId: String(fence.launchId)
    }
  };
  return {
    ...event,
    payload: {
      ...payload,
      semanticKey,
      kind,
      observation: JSON.stringify(nextObservation)
    }
  };
}

function migratedRuntimeObservationSemanticKey(
  observation: Record<string, unknown>,
  fence: Record<string, unknown>
): string {
  const kind = String(observation.kind);
  if (Number.isSafeInteger(observation.sequence)) {
    return `provider-sequence:${String(fence.driverId)}:${String(fence.nativeSessionId ?? fence.launchId)}:${String(observation.sequence)}:${kind}`;
  }
  const terminal = [
    "session.ended",
    "session.failed",
    "turn.completed",
    "turn.failed",
    "turn.cancelled"
  ].includes(kind);
  if (terminal) {
    const payload = asObject(observation.payload, "Runtime observation payload");
    const failure = payload.failure === undefined
      ? undefined
      : asObject(payload.failure, "Runtime observation failure");
    return [
      "terminal",
      String(fence.driverId),
      String(fence.nativeSessionId ?? fence.launchId),
      String(fence.launchId),
      String(fence.nativeTurnId ?? "none"),
      kind,
      String(payload.outcome ?? failure?.code ?? "terminal")
    ].join(":");
  }
  return `provider-event:${String(observation.eventId)}`;
}

function workMailboxV2Step(): MigrationStep<HomeSnapshot> {
  return {
    axis: "record",
    recordKind: "workMailbox",
    fromVersion: WORK_MAILBOX_FROM_VERSION,
    toVersion: WORK_MAILBOX_TO_VERSION,
    preconditions: requireWorkMailboxV1Family,
    transform: migrateWorkMailboxV1ToV2,
    declaredEffects: []
  };
}

function requireWorkMailboxV1Family(snapshot: HomeSnapshot): void {
  const versions = asObject(snapshot.schemaManifest.recordVersions, "schema manifest recordVersions");
  if (versions.workMailbox !== WORK_MAILBOX_FROM_VERSION) {
    throw new Error(`Record workMailbox migration requires manifest version ${WORK_MAILBOX_FROM_VERSION}.`);
  }
  if (snapshot.state === null) return;
  const mailboxes = asObject(snapshot.state.mailboxes, "state mailboxes");
  for (const [key, rawMailbox] of Object.entries(mailboxes)) {
    const mailbox = asObject(rawMailbox, `WorkMailbox ${key}`);
    if (mailbox.schemaVersion !== WORK_MAILBOX_FROM_VERSION) {
      throw new Error(`WorkMailbox ${key} must use schemaVersion ${WORK_MAILBOX_FROM_VERSION}.`);
    }
    if (mailbox.pending !== null) asObject(mailbox.pending, `WorkMailbox ${key} pending`);
    if (mailbox.processing !== null) asObject(mailbox.processing, `WorkMailbox ${key} processing`);
  }
}

function migrateWorkMailboxV1ToV2(snapshot: HomeSnapshot): HomeSnapshot {
  requireWorkMailboxV1Family(snapshot);
  const versions = asObject(snapshot.schemaManifest.recordVersions, "schema manifest recordVersions");
  const schemaManifest = {
    ...snapshot.schemaManifest,
    recordVersions: { ...versions, workMailbox: WORK_MAILBOX_TO_VERSION }
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const mailboxes = asObject(snapshot.state.mailboxes, "state mailboxes");
  const nextMailboxes: Record<string, unknown> = {};
  for (const [key, rawMailbox] of Object.entries(mailboxes)) {
    const mailbox = asObject(rawMailbox, `WorkMailbox ${key}`);
    const pending = mailbox.pending === null
      ? null
      : migrateMailboxBatchV1(mailbox.pending, key, "pending");
    const migratedProcessing = mailbox.processing === null
      ? null
      : migrateMailboxProcessingV1(mailbox.processing, key);
    const continuationDelivery = migratedProcessing === null
      ? null
      : migrateMailboxContinuationDeliveryV1(
          snapshot,
          mailbox,
          migratedProcessing,
          key
        );
    nextMailboxes[key] = {
      ...mailbox,
      schemaVersion: WORK_MAILBOX_TO_VERSION,
      processing: continuationDelivery === null ? migratedProcessing : null,
      pending: {
        normal: pending,
        userCorrection: null,
        cursors: { normal: 0, userCorrection: 0 },
        recentDedupeKeys: []
      },
      inputDelivery: continuationDelivery
    };
  }
  return {
    schemaManifest,
    state: { ...snapshot.state, mailboxes: nextMailboxes }
  };
}

/**
 * v1 used `processing` for both internal/initial dispatch ownership and later
 * model input.  A crashed later input may already have reached the provider;
 * migrate it to an explicit delivery-unknown fence instead of making it
 * eligible for a blind resend.  Other processing batches retain their old
 * controller ownership semantics.
 */
function migrateMailboxContinuationDeliveryV1(
  snapshot: HomeSnapshot,
  mailbox: Record<string, unknown>,
  processing: Record<string, unknown>,
  mailboxKey: string
): Record<string, unknown> | null {
  const batchId = String(processing.batchId ?? "");
  if (!batchId.startsWith("agent-input:")) return null;
  const target = asObject(mailbox.target, `WorkMailbox ${mailboxKey} target`);
  if (target.kind !== "role") {
    throw new Error(`WorkMailbox ${mailboxKey} continuation input requires a Role target.`);
  }
  const executionRef = asObject(
    processing.executionRef,
    `WorkMailbox ${mailboxKey} continuation executionRef`
  );
  if (executionRef.type !== "run") {
    throw new Error(`WorkMailbox ${mailboxKey} continuation input requires a Run reference.`);
  }
  const taskId = String(target.taskId);
  const roleName = String(target.roleName);
  const tasks = asObject(snapshot.state!.tasks, "state tasks");
  const aggregate = asObject(tasks[taskId], `Task aggregate ${taskId}`);
  const sets = asObject(aggregate.roleSessionSets, `Task Role session sets ${taskId}`);
  const set = asObject(sets[roleName], `Task Role session set ${taskId}/${roleName}`);
  const sessions = asObject(set.sessions, `Task Role sessions ${taskId}/${roleName}`);
  const active = asObject(
    sessions[String(set.activeAgentId)],
    `Task Role active Session ${taskId}/${roleName}`
  );
  const activationId = String(active.launchId ?? asObject(
    set.inFlight,
    `Task Role in-flight Run ${taskId}/${roleName}`
  ).receiptId);
  return {
    attemptId: batchId,
    lane: "normal",
    mode: "followup",
    batch: processing.batch,
    owner: processing.owner,
    status: "delivery-unknown",
    startedAt: processing.startedAt,
    pushedAt: processing.startedAt,
    unknownReason: "migrated-unconfirmed-provider-acceptance",
    executionRef,
    providerFence: {
      conversationId: String(active.nativeSessionId),
      activationId
    }
  };
}

function migrateMailboxProcessingV1(
  value: unknown,
  mailboxKey: string
): Record<string, unknown> {
  const processing = asObject(value, `WorkMailbox ${mailboxKey} processing`);
  return {
    ...processing,
    lane: "normal",
    batch: migrateMailboxBatchV1(processing.batch, mailboxKey, "processing")
  };
}

function migrateMailboxBatchV1(
  value: unknown,
  mailboxKey: string,
  location: string
): Record<string, unknown> {
  const batch = asObject(value, `WorkMailbox ${mailboxKey} ${location} batch`);
  const from = batch.fromSequence;
  const to = batch.toSequence;
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new Error(`WorkMailbox ${mailboxKey} ${location} sequence range is invalid.`);
  }
  return {
    ...batch,
    sources: ["migration-v1"],
    dedupeKeys: [`mailbox-v1:${mailboxKey}:${String(from)}-${String(to)}`],
    deliveryModes: ["followup"]
  };
}

function taskRoleSessionSetV5Step(): MigrationStep<HomeSnapshot> {
  return {
    axis: "record",
    recordKind: "taskRoleSessionSet",
    fromVersion: TASK_ROLE_SESSION_SET_FROM_VERSION,
    toVersion: TASK_ROLE_SESSION_SET_TO_VERSION,
    preconditions: requireTaskRoleSessionSetV4Family,
    transform: migrateTaskRoleSessionSetV4ToV5,
    declaredEffects: []
  };
}

function requireTaskRoleSessionSetV4Family(snapshot: HomeSnapshot): void {
  const versions = asObject(snapshot.schemaManifest.recordVersions, "schema manifest recordVersions");
  if (versions.taskRoleSessionSet !== TASK_ROLE_SESSION_SET_FROM_VERSION) {
    throw new Error(
      `Record taskRoleSessionSet migration requires manifest version ${TASK_ROLE_SESSION_SET_FROM_VERSION}.`
    );
  }
  if (snapshot.state === null) return;
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  for (const [taskId, rawAggregate] of Object.entries(tasks)) {
    const aggregate = asObject(rawAggregate, `Task aggregate ${taskId}`);
    const sets = asObject(aggregate.roleSessionSets, `Task Role session sets ${taskId}`);
    for (const [roleName, rawSet] of Object.entries(sets)) {
      const set = asObject(rawSet, `Task Role session set ${taskId}/${roleName}`);
      if (set.schemaVersion !== TASK_ROLE_SESSION_SET_FROM_VERSION) {
        throw new Error(
          `Task Role session set ${taskId}/${roleName} must use schemaVersion ${TASK_ROLE_SESSION_SET_FROM_VERSION}.`
        );
      }
    }
  }
}

function migrateTaskRoleSessionSetV4ToV5(snapshot: HomeSnapshot): HomeSnapshot {
  requireTaskRoleSessionSetV4Family(snapshot);
  const versions = asObject(snapshot.schemaManifest.recordVersions, "schema manifest recordVersions");
  const schemaManifest = {
    ...snapshot.schemaManifest,
    recordVersions: {
      ...versions,
      taskRoleSessionSet: TASK_ROLE_SESSION_SET_TO_VERSION
    }
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  const nextTasks: Record<string, unknown> = {};
  for (const [taskId, rawAggregate] of Object.entries(tasks)) {
    const aggregate = asObject(rawAggregate, `Task aggregate ${taskId}`);
    const rawSets = asObject(aggregate.roleSessionSets, `Task Role session sets ${taskId}`);
    const nextSets: Record<string, unknown> = {};
    let events = { ...asObject(aggregate.events, `Task events ${taskId}`) };
    const highWater = { ...asObject(aggregate.idHighWaterMarks, `Task id high-water marks ${taskId}`) };
    let eventHighWater = Number(highWater.event ?? 0);
    if (!Number.isSafeInteger(eventHighWater) || eventHighWater < 0) {
      throw new Error(`Task event high-water mark is invalid: ${taskId}.`);
    }
    for (const [roleName, rawSet] of Object.entries(rawSets)) {
      const set = asObject(rawSet, `Task Role session set ${taskId}/${roleName}`);
      const sessions = asObject(set.sessions, `Task Role sessions ${taskId}/${roleName}`);
      const inFlight = set.inFlight === null
        ? null
        : asObject(set.inFlight, `Task Role in-flight Run ${taskId}/${roleName}`);
      const pending = set.pendingTurnCompletion === null
        ? null
        : asObject(set.pendingTurnCompletion, `Task Role Turn completion ${taskId}/${roleName}`);
      const activeAgentId = String(set.activeAgentId ?? "");
      const activeSession = sessions[activeAgentId] === undefined
        ? null
        : asObject(sessions[activeAgentId], `Task Role active Session ${taskId}/${roleName}`);
      if (inFlight !== null && activeSession === null) {
        throw new Error(`Task Role in-flight Run has no active Session: ${taskId}/${roleName}.`);
      }
      const nextSessions = { ...sessions };
      if (pending !== null) {
        if (activeSession === null
          || pending.agentId !== activeAgentId
          || pending.runId !== inFlight?.runId
          || pending.nativeSessionId !== activeSession.nativeSessionId) {
          throw new Error(`Task Role Turn completion identity is inconsistent: ${taskId}/${roleName}.`);
        }
        const recent = Array.isArray(activeSession.recentCompletedTurnIds)
          ? activeSession.recentCompletedTurnIds.map(String)
          : [];
        const turnId = String(pending.turnId);
        nextSessions[activeAgentId] = {
          ...activeSession,
          recentCompletedTurnIds: recent.includes(turnId) ? recent : [...recent, turnId],
          updatedAt: String(pending.observedAt)
        };
        eventHighWater += 1;
        const eventId = `event-${eventHighWater}`;
        const driverId = migratedDriverId(String(activeSession.adapterId));
        const launchId = String(activeSession.launchId ?? inFlight?.receiptId ?? `legacy-${eventId}`);
        const observation = {
          schemaVersion: 2,
          eventId: `migrated-turn-completed:${taskId}:${roleName}:${turnId}`,
          semanticKey: [
            "terminal",
            driverId,
            activeAgentId,
            String(activeSession.nativeSessionId),
            launchId,
            "none",
            "none",
            turnId,
            "turn.completed",
            "terminal",
            "none",
            "turn-terminal"
          ].join(":"),
          kind: "turn.completed",
          authority: "controller",
          receivedAt: String(pending.observedAt),
          observedAt: String(pending.observedAt),
          fence: {
            taskId,
            roleName,
            runId: String(pending.runId),
            agentId: activeAgentId,
            driverId,
            launchId,
            sessionGenerationId: launchId,
            conversationId: String(activeSession.nativeSessionId),
            activationId: launchId,
            nativeSessionId: String(activeSession.nativeSessionId),
            nativeTurnId: turnId
          },
          payload: { summary: String(pending.summary) }
        };
        events[eventId] = {
          schemaVersion: 2,
          id: eventId,
          taskId,
          type: "runtime.observation",
          payload: {
            eventId: observation.eventId,
            roleName,
            agentId: activeAgentId,
            driverId,
            launchId,
            taskId,
            runId: String(pending.runId),
            nativeSessionId: String(activeSession.nativeSessionId),
            kind: "turn.completed",
            receivedAt: String(pending.observedAt),
            observation: JSON.stringify(observation)
          },
          createdAt: String(pending.observedAt)
        };
      }
      const providerBinding = inFlight === null || activeSession === null
        ? null
        : migratedProviderBinding(activeSession, inFlight);
      const { pendingTurnCompletion: _removed, ...withoutPending } = set;
      void _removed;
      nextSets[roleName] = {
        ...withoutPending,
        schemaVersion: TASK_ROLE_SESSION_SET_TO_VERSION,
        sessions: nextSessions,
        providerBinding
      };
    }
    highWater.event = eventHighWater;
    nextTasks[taskId] = {
      ...aggregate,
      roleSessionSets: nextSets,
      events,
      idHighWaterMarks: highWater
    };
  }
  return {
    schemaManifest,
    state: { ...snapshot.state, tasks: nextTasks }
  };
}

function migratedProviderBinding(
  session: Record<string, unknown>,
  inFlight: Record<string, unknown>
): Record<string, unknown> {
  const conversationId = String(session.nativeSessionId);
  const activationId = String(session.launchId ?? inFlight.receiptId);
  const startedAt = String(inFlight.preparedAt);
  const live = session.status !== "stopped" && session.status !== "broken";
  return {
    schemaVersion: 1,
    providerNamespace: migratedDriverId(String(session.adapterId)),
    accountScope: String(session.agentId),
    runId: String(inFlight.runId),
    currentConversationEpoch: 1,
    conversations: [{
      conversationId,
      epoch: 1,
      status: "current",
      recoverability: "unknown",
      createdAt: String(session.createdAt ?? startedAt)
    }],
    activations: [{
      activationId,
      conversationId,
      generation: 1,
      status: live ? "active" : session.status === "broken" ? "failed" : "ended",
      writerLease: live,
      startedAt,
      ...(live ? {} : { endedAt: String(session.updatedAt) })
    }]
  };
}

function migratedDriverId(adapterId: string): string {
  if (adapterId === "claude") return "anthropic/claude-code";
  if (adapterId === "codex") return "openai/codex";
  return adapterId.includes("/") ? adapterId : `legacy/${adapterId}`;
}

/**
 * Project ownership is a new required field. Every pre-v3 Project is a
 * user-registered checkout, so the historical binding is `external`; a managed
 * Home-owned repository is only ever created explicitly by the new binding
 * path. The version transition is durable and centralized.
 */
function projectOwnershipStep(): MigrationStep<HomeSnapshot> {
  return {
    axis: "record",
    recordKind: "project",
    fromVersion: PROJECT_FROM_VERSION,
    toVersion: PROJECT_TO_VERSION,
    preconditions: requireProjectV2Family,
    transform: migrateProjectV2ToV3,
    declaredEffects: []
  };
}

function requireProjectV2Family(snapshot: HomeSnapshot): void {
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  if (manifestVersions.project !== PROJECT_FROM_VERSION) {
    throw new Error(
      `Record project migration requires manifest version ${PROJECT_FROM_VERSION}.`
    );
  }
  if (snapshot.state === null) return;
  const projects = snapshot.state.projects;
  if (projects === undefined) return;
  const map = asObject(projects, "project map");
  for (const [projectId, rawProject] of Object.entries(map)) {
    const project = asObject(rawProject, `Project ${projectId}`);
    if (project.schemaVersion !== PROJECT_FROM_VERSION) {
      throw new Error(
        `Project ${projectId} must use schemaVersion ${PROJECT_FROM_VERSION}.`
      );
    }
  }
}

function migrateProjectV2ToV3(snapshot: HomeSnapshot): HomeSnapshot {
  requireProjectV2Family(snapshot);
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  const schemaManifest = {
    ...snapshot.schemaManifest,
    recordVersions: { ...manifestVersions, project: PROJECT_TO_VERSION }
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const projects = snapshot.state.projects;
  if (projects === undefined) {
    return { schemaManifest, state: { ...snapshot.state } };
  }
  const map = asObject(projects, "project map");
  const nextProjects: Record<string, unknown> = {};
  for (const [projectId, rawProject] of Object.entries(map)) {
    const project = asObject(rawProject, `Project ${projectId}`);
    nextProjects[projectId] = {
      ...project,
      schemaVersion: PROJECT_TO_VERSION,
      ownership: "external"
    };
  }
  return {
    schemaManifest,
    state: { ...snapshot.state, projects: nextProjects }
  };
}

/**
 * Task v4 adds the optional durable workspace identity. Historical Tasks have
 * no identity; they keep working against their existing (legacy) refs until the
 * controlled rebuild mints one. This adjacent step performs no field rewrite,
 * preserving old records while keeping a pre-v4 Task out of the strict current
 * parser.
 */
function taskWorkspaceIdentityStep(): MigrationStep<HomeSnapshot> {
  return {
    axis: "record",
    recordKind: "task",
    fromVersion: TASK_FROM_VERSION,
    toVersion: TASK_TO_VERSION,
    preconditions: requireTaskV3Family,
    transform: migrateTaskV3ToV4,
    declaredEffects: []
  };
}

function requireTaskV3Family(snapshot: HomeSnapshot): void {
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  if (manifestVersions.task !== TASK_FROM_VERSION) {
    throw new Error(
      `Record task migration requires manifest version ${TASK_FROM_VERSION}.`
    );
  }
  if (snapshot.state === null) return;
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const aggregate = asObject(rawTask, `Task aggregate ${taskId}`);
    const task = aggregate.task;
    if (task === undefined) continue;
    const record = asObject(task, `Task ${taskId}`);
    if (record.schemaVersion !== TASK_FROM_VERSION) {
      throw new Error(`Task ${taskId} must use schemaVersion ${TASK_FROM_VERSION}.`);
    }
  }
}

function migrateTaskV3ToV4(snapshot: HomeSnapshot): HomeSnapshot {
  requireTaskV3Family(snapshot);
  const manifestVersions = asObject(
    snapshot.schemaManifest.recordVersions,
    "schema manifest recordVersions"
  );
  const schemaManifest = {
    ...snapshot.schemaManifest,
    recordVersions: { ...manifestVersions, task: TASK_TO_VERSION }
  };
  if (snapshot.state === null) return { schemaManifest, state: null };
  const tasks = asObject(snapshot.state.tasks, "state tasks");
  const nextTasks: Record<string, unknown> = {};
  for (const [taskId, rawTask] of Object.entries(tasks)) {
    const aggregate = asObject(rawTask, `Task aggregate ${taskId}`);
    if (aggregate.task === undefined) {
      nextTasks[taskId] = { ...aggregate };
      continue;
    }
    const task = asObject(aggregate.task, `Task ${taskId}`);
    nextTasks[taskId] = {
      ...aggregate,
      task: { ...task, schemaVersion: TASK_TO_VERSION }
    };
  }
  return {
    schemaManifest,
    state: { ...snapshot.state, tasks: nextTasks }
  };
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
