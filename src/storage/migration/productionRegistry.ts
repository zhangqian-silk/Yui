/** The one production transition registry and its baseline-to-current delivery gate. */
import { generateHomeIdentity } from "../../repository/homeIdentity.js";
import { latestStorageVersionState } from "../upgrade/recordVersions.js";
import type { HomeSnapshot } from "../upgrade/homeMigrationTarget.js";
import { assertBaselineConsistency, baselineStorageVersionState } from "./baseline.js";
import { planMigration } from "./planner.js";
import { MigrationRegistry } from "./registry.js";
import type { MigrationStep, StorageVersionState } from "./types.js";

const FINAL_REVIEW_AGGREGATE_FROM_VERSION = 16;
const FINAL_REVIEW_AGGREGATE_TO_VERSION = 17;
const HOME_IDENTITY_AGGREGATE_FROM_VERSION = 17;
const HOME_IDENTITY_AGGREGATE_TO_VERSION = 18;
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
const INTEGRATION_QUEUE_FROM_VERSION = 0;
const INTEGRATION_QUEUE_TO_VERSION = 1;

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
    .registerOfflineMigration({
      axis: "aggregate",
      fromVersion: HOME_IDENTITY_AGGREGATE_FROM_VERSION,
      toVersion: HOME_IDENTITY_AGGREGATE_TO_VERSION,
      preconditions: requireAggregateV17Snapshot,
      transform: migrateAggregateV17ToV18,
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
    .registerOfflineMigration(integrationQueueIntroductionStep());

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
      task.idHighWaterMarks,
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
  taskMapKey: "workItems" | "agentRuns" | "reviewRounds" | "activeRuns" | "managedWorkspaces"
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
  taskMapKey: "workItems" | "agentRuns" | "reviewRounds" | "activeRuns" | "managedWorkspaces"
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
  taskMapKey: "workItems" | "agentRuns" | "reviewRounds" | "activeRuns" | "managedWorkspaces"
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
