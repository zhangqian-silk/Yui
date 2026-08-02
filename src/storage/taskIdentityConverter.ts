import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  legacyEffectiveLaunchSnapshot,
  type EffectiveLaunchContext,
  type EffectiveLaunchWorkspace
} from "../executor/effectiveLaunch.js";
import type { AgentAdapterId } from "../agent/adapterCatalog.js";

import {
  formatAgentRunReceiptId,
  formatInputRequestReceiptId,
  TASK_RECORD_ID_PREFIXES,
  type TaskRecordKind
} from "../task/taskRecordReference.js";
import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION,
  ensureStorageSchema
} from "./storageSchema.js";
import { writeTextFileAtomically } from "./durableFile.js";
import { FileTaskStore, STORAGE_STATE_FILE } from "./taskStore.js";

const LEGACY_AGGREGATE_SCHEMA_VERSION = 10;
const LEGACY_TASK_AGGREGATE_SCHEMA_VERSION = 9;
export const IDENTITY_CONVERSION_REPORT_FILE = "identity-conversion.json";

type JsonObject = Record<string, unknown>;
type IdMaps = Record<TaskRecordKind, Map<string, string>>;

type TaskConversion = Readonly<{
  taskId: string;
  source: JsonObject;
  maps: IdMaps;
  candidateByWorkItem: Map<string, Map<string, string>>;
}>;

type EventReferenceKind = Exclude<TaskRecordKind, "event"> | "candidate";
type EventReferenceFields = Readonly<Record<string, EventReferenceKind>>;

const FAMILY_FIELDS: Readonly<Record<TaskRecordKind, string>> = {
  workItem: "workItems",
  agentRun: "agentRuns",
  reviewRound: "reviewRounds",
  changeSet: "changeSets",
  integrationAttempt: "integrationAttempts",
  message: "messages",
  inputRequest: "inputRequests",
  decision: "decisions",
  milestone: "milestones",
  event: "events"
};

const SOURCE_STATE_FIELDS = [
  "schemaVersion",
  "revision",
  "config",
  "configuredAgents",
  "projects",
  "agentProfiles",
  "globalRoles",
  "globalRoleSessionSets",
  "tasks",
  "mailboxes"
] as const;

const SOURCE_TASK_FIELDS = [
  "schemaVersion",
  "task",
  "brief",
  "changeSets",
  "integrationAttempts",
  "roles",
  "roleWorkspaces",
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

// This is the complete Task-owned reference contract emitted by production
// recordTaskEvent/createTaskEvent call sites. Globally stable Task/Project ids
// and every unlisted event type or payload key are intentionally left intact.
const EVENT_REFERENCE_FIELDS: Readonly<Record<string, EventReferenceFields>> = {
  "work.scope-updated": { workItemId: "workItem" },
  "work.updated": { workItemId: "workItem" },
  "work.accepted": {
    workItemId: "workItem",
    candidateId: "candidate",
    runId: "agentRun"
  },
  "work.rejected": { workItemId: "workItem", candidateId: "candidate" },
  "work.cancelled": { workItemId: "workItem" },
  "message.sent": { messageId: "message" },
  "input.requested": { requestId: "inputRequest", requesterRunId: "agentRun" },
  "input.answered": { requestId: "inputRequest" },
  "input.cancelled": { requestId: "inputRequest" },
  "input.auto-answered": { requestId: "inputRequest" },
  "decision.recorded": { decisionId: "decision" },
  "decision.superseded": { decisionId: "decision" },
  "milestone.added": { milestoneId: "milestone" }
};

export type TaskIdentityConversionReport = Readonly<{
  schemaVersion: 1;
  source: string;
  output: string;
  sourceAggregateSchemaVersion: 10;
  outputAggregateSchemaVersion: number;
  sourceStateSha256: string;
  taskIds: readonly string[];
  recordCounts: Readonly<Record<string, Readonly<Record<TaskRecordKind, number>>>>;
  convertedAt: string;
}>;

export function convertLegacyTaskIdentityStorage(input: Readonly<{
  source: string;
  output: string;
  now?: Date;
}>): TaskIdentityConversionReport {
  const now = input.now ?? new Date();
  const source = existingDirectory(input.source, "Conversion source");
  const output = freshDestination(input.output);
  assertDisjoint(source, output);

  const manifestPath = join(source, "schema.json");
  const statePath = join(source, STORAGE_STATE_FILE);
  const manifestBytes = readFileSync(manifestPath);
  const stateBytes = readFileSync(statePath);
  validateLegacyManifest(parseJson(manifestBytes, "Source storage manifest"));
  const sourceState = parseLegacyState(parseJson(stateBytes, "Source storage state"));
  const conversions = buildTaskConversions(sourceState);
  const convertedState = convertState(sourceState, conversions);

  assertSourceUnchanged(manifestPath, manifestBytes, statePath, stateBytes);
  if (existsSync(output)) throw new Error(`Conversion output must be fresh: ${output}.`);

  const report: TaskIdentityConversionReport = {
    schemaVersion: 1,
    source,
    output,
    sourceAggregateSchemaVersion: LEGACY_AGGREGATE_SCHEMA_VERSION,
    outputAggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    sourceStateSha256: sha256(stateBytes),
    taskIds: conversions.map(({ taskId }) => taskId),
    recordCounts: Object.fromEntries(conversions.map((conversion) => [
      conversion.taskId,
      Object.fromEntries((Object.keys(FAMILY_FIELDS) as TaskRecordKind[]).map((kind) => [
        kind,
        conversion.maps[kind].size
      ])) as Record<TaskRecordKind, number>
    ])),
    convertedAt: now.toISOString()
  };

  let created = false;
  try {
    mkdirSync(output, { mode: 0o700 });
    created = true;
    ensureStorageSchema(output, now);
    writeTextFileAtomically(
      join(output, STORAGE_STATE_FILE),
      `${JSON.stringify(convertedState, null, 2)}\n`
    );
    new FileTaskStore(output).listTasks();
    writeTextFileAtomically(
      join(output, IDENTITY_CONVERSION_REPORT_FILE),
      `${JSON.stringify(report, null, 2)}\n`
    );
    assertSourceUnchanged(manifestPath, manifestBytes, statePath, stateBytes);
    return report;
  } catch (error) {
    if (created) rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

function parseLegacyState(value: unknown): JsonObject {
  const state = exactObject(value, SOURCE_STATE_FIELDS, "Source storage state");
  if (state.schemaVersion !== LEGACY_AGGREGATE_SCHEMA_VERSION) {
    throw new Error(
      `Source storage state must use aggregate schema ${LEGACY_AGGREGATE_SCHEMA_VERSION}.`
    );
  }
  if (!Number.isSafeInteger(state.revision) || (state.revision as number) < 0) {
    throw new Error("Source storage revision is invalid.");
  }
  object(state.tasks, "Source Tasks");
  object(state.mailboxes, "Source WorkMailboxes");
  return clone(state);
}

function buildTaskConversions(state: JsonObject): TaskConversion[] {
  const tasks = object(state.tasks, "Source Tasks");
  return Object.keys(tasks).sort(compareText).map((taskId) => {
    const aggregate = exactObject(
      tasks[taskId], SOURCE_TASK_FIELDS, `Source Task aggregate ${taskId}`
    );
    if (aggregate.schemaVersion !== LEGACY_TASK_AGGREGATE_SCHEMA_VERSION) {
      throw new Error(
        `Source Task aggregate ${taskId} must use schema ${LEGACY_TASK_AGGREGATE_SCHEMA_VERSION}.`
      );
    }
    const task = object(aggregate.task, `Source Task ${taskId}`);
    if (task.id !== taskId) throw new Error(`Source Task identity is inconsistent: ${taskId}.`);
    const maps = {} as IdMaps;
    for (const kind of Object.keys(FAMILY_FIELDS) as TaskRecordKind[]) {
      maps[kind] = buildFamilyMap(aggregate, taskId, kind);
    }
    const candidateByWorkItem = new Map<string, Map<string, string>>();
    const sourceCandidateIds = new Set<string>();
    for (const oldWorkItemId of maps.workItem.keys()) {
      const item = recordById(aggregate, "workItems", oldWorkItemId, taskId);
      const candidates = array(item.candidates, `Work Item candidates ${taskId}/${oldWorkItemId}`);
      const candidateMap = new Map<string, string>();
      candidates.forEach((value, index) => {
        const candidate = object(value, `Work Item candidate ${taskId}/${oldWorkItemId}`);
        if (candidate.schemaVersion !== 1) {
          throw new Error("Source Work Item candidate must use schemaVersion 1.");
        }
        const oldCandidateId = text(candidate.id, "Source Candidate id");
        if (candidateMap.has(oldCandidateId) || sourceCandidateIds.has(oldCandidateId)) {
          throw new Error(`Source Candidate id is duplicated: ${taskId}/${oldCandidateId}.`);
        }
        const newCandidateId = `candidate-${index + 1}`;
        candidateMap.set(oldCandidateId, newCandidateId);
        sourceCandidateIds.add(oldCandidateId);
      });
      candidateByWorkItem.set(oldWorkItemId, candidateMap);
    }
    return { taskId, source: aggregate, maps, candidateByWorkItem };
  });
}

function buildFamilyMap(
  aggregate: JsonObject,
  taskId: string,
  kind: TaskRecordKind
): Map<string, string> {
  const field = FAMILY_FIELDS[kind];
  const records = object(aggregate[field], `Source ${field} ${taskId}`);
  const ordered = Object.entries(records).map(([key, value]) => {
    const record = object(value, `Source ${kind} ${taskId}/${key}`);
    if (record.id !== key) throw new Error(`Source ${kind} identity is inconsistent: ${key}.`);
    if (kind !== "message" && kind !== "event" && record.taskId !== taskId) {
      throw new Error(`Source ${kind} belongs to another Task: ${taskId}/${key}.`);
    }
    return { id: key, createdAt: timestamp(record.createdAt, `Source ${kind} createdAt`) };
  }).sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || compareText(left.id, right.id)
  ));
  return new Map(ordered.map(({ id }, index) => [
    id,
    `${TASK_RECORD_ID_PREFIXES[kind]}-${index + 1}`
  ]));
}

function convertState(state: JsonObject, conversions: readonly TaskConversion[]): JsonObject {
  const tasks: JsonObject = {};
  for (const conversion of conversions) {
    tasks[conversion.taskId] = convertTaskAggregate(conversion);
  }
  const owners = buildOwnerIndex(conversions);
  const mailboxes: JsonObject = {};
  for (const [key, value] of Object.entries(object(state.mailboxes, "Source WorkMailboxes"))) {
    mailboxes[key] = convertMailbox(value, owners);
  }
  const globalRoles = Object.fromEntries(Object.entries(
    object(state.globalRoles, "Source Global Roles")
  ).map(([name, value]) => [name, convertLegacyRole(value, `Global Role ${name}`)]));
  const globalRoleSessionSets = Object.fromEntries(Object.entries(object(
    state.globalRoleSessionSets,
    "Source Global Role sessions"
  )).map(([name, value]) => [name, convertRoleSessionSet(
    value,
    object(globalRoles[name], `Converted Global Role ${name}`),
    undefined
  )]));
  return {
    ...clone(state),
    schemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    globalRoles,
    globalRoleSessionSets,
    tasks,
    mailboxes
  };
}

function convertLegacyRole(value: unknown, label: string): JsonObject {
  const role = clone(object(value, label));
  if (role.schemaVersion !== 2) {
    throw new Error(`${label} must use legacy schemaVersion 2.`);
  }
  return {
    ...role,
    schemaVersion: 3,
    launchRevision: 1,
    // Legacy prompt/config did not prove an authorized write scope. The one
    // offline cutover therefore closes desired access to read-only.
    defaultAccess: "read"
  };
}

function legacyRoleContext(role: JsonObject): EffectiveLaunchContext {
  return {
    ...(role.description === undefined
      ? {}
      : { description: text(role.description, "Source Role description") }),
    ...(role.responsibilities === undefined
      ? {}
      : { responsibilities: array(role.responsibilities, "Source Role responsibilities").map(
          (value) => text(value, "Source Role responsibility")
        ) }),
    ...(role.constraints === undefined
      ? {}
      : { constraints: array(role.constraints, "Source Role constraints").map(
          (value) => text(value, "Source Role constraint")
        ) }),
    ...(role.expectedOutput === undefined
      ? {}
      : { expectedOutput: text(role.expectedOutput, "Source Role expected output") }),
    ...(role.systemPrompt === undefined
      ? {}
      : { systemPrompt: text(role.systemPrompt, "Source Role system prompt") }),
    ...(role.skills === undefined
      ? {}
      : { skills: array(role.skills, "Source Role Skills").map(
          (value) => text(value, "Source Role Skill id")
        ) })
  };
}

function legacyRoleWorkspace(
  roleValue: unknown,
  taskValue?: unknown
): EffectiveLaunchWorkspace {
  const role = roleValue === undefined ? undefined : object(roleValue, "Source Role");
  const task = taskValue === undefined ? undefined : object(taskValue, "Source Task");
  const root = role?.workspace ?? task?.cwd;
  return { root: text(root, "Source effective workspace"), entries: [] };
}

function effectiveWorkspace(value: unknown): EffectiveLaunchWorkspace {
  const workspace = object(value, "Converted managed workspace");
  return {
    root: text(workspace.root, "Converted workspace root"),
    entries: array(workspace.entries, "Converted workspace entries").map((entryValue) => {
      const entry = object(entryValue, "Converted workspace entry");
      const access = text(entry.access, "Converted workspace access");
      if (access !== "read" && access !== "write") {
        throw new Error(`Converted workspace access is invalid: ${access}.`);
      }
      return {
        projectId: text(entry.projectId, "Converted workspace Project id"),
        directory: text(entry.directory, "Converted workspace directory"),
        access,
        path: text(entry.path, "Converted workspace path"),
        branch: text(entry.branch, "Converted workspace branch"),
        baseRef: text(entry.baseRef, "Converted workspace base ref"),
        baseCommit: text(entry.baseCommit, "Converted workspace base commit")
      };
    })
  };
}

function agentAdapterId(value: unknown, label: string): AgentAdapterId {
  const result = text(value, label);
  if (result !== "codex" && result !== "claude") {
    throw new Error(`${label} is unsupported: ${result}.`);
  }
  return result;
}

function convertTaskAggregate(conversion: TaskConversion): JsonObject {
  const source = conversion.source;
  const roles = Object.fromEntries(Object.entries(object(
    source.roles,
    `Source Task Roles ${conversion.taskId}`
  )).map(([name, value]) => [name, convertLegacyRole(
    value,
    `Task Role ${conversion.taskId}/${name}`
  )]));
  const workspaces = convertNamedMap(source.roleWorkspaces, (value) => (
    convertWorkspace(value, conversion)
  ));
  return {
    ...clone(source),
    schemaVersion: 11,
    roles,
    idHighWaterMarks: Object.fromEntries(
      (Object.keys(FAMILY_FIELDS) as TaskRecordKind[]).map((kind) => [
        kind, conversion.maps[kind].size
      ])
    ),
    changeSets: convertFamily(conversion, "changeSet", (record, oldId, id) => ({
      ...record,
      schemaVersion: 2,
      id,
      taskId: conversion.taskId,
      workItemId: mapped(conversion, "workItem", record.workItemId, "ChangeSet Work Item")
    })),
    integrationAttempts: convertFamily(
      conversion, "integrationAttempt", (record, oldId, id) => ({
        ...record,
        id,
        taskId: conversion.taskId,
        changeSetIds: array(record.changeSetIds, "Integration ChangeSet ids").map((value) => (
          mapped(conversion, "changeSet", value, "Integration ChangeSet")
        ))
      })
    ),
    roleWorkspaces: workspaces,
    roleSessionSets: Object.fromEntries(Object.entries(object(
      source.roleSessionSets,
      `Source Task Role sessions ${conversion.taskId}`
    )).map(([name, value]) => [name, convertTaskRoleSessionSet(
      value,
      conversion,
      object(roles[name], `Converted Task Role ${conversion.taskId}/${name}`),
      workspaces[name]
    )])),
    workItems: convertFamily(conversion, "workItem", (record, oldId, id) => (
      convertWorkItem(record, oldId, id, conversion)
    )),
    agentRuns: convertFamily(conversion, "agentRun", (record, oldId, id) => (
      convertAgentRun(record, oldId, id, conversion)
    )),
    reviewRounds: convertFamily(conversion, "reviewRound", (record, oldId, id) => (
      convertReviewRound(record, id, conversion)
    )),
    activeRuns: convertNamedMap(source.activeRuns, (value) => {
      const pointer = object(value, "Active Run pointer");
      return {
        ...clone(pointer),
        runId: mapped(conversion, "agentRun", pointer.runId, "Active Run")
      };
    }),
    messages: convertFamily(conversion, "message", (record, oldId, id) => ({
      ...record,
      schemaVersion: 2,
      id,
      taskId: conversion.taskId,
      ...(record.runId === undefined
        ? {}
        : { runId: mapped(conversion, "agentRun", record.runId, "Message Run") }),
      ...(record.workItemId === undefined
        ? {}
        : { workItemId: mapped(
            conversion, "workItem", record.workItemId, "Message Work Item"
          ) })
    })),
    inputRequests: convertFamily(conversion, "inputRequest", (record, oldId, id) => (
      convertInputRequest(record, id, conversion)
    )),
    decisions: convertFamily(conversion, "decision", (record, oldId, id) => ({
      ...record, id, taskId: conversion.taskId
    })),
    milestones: convertFamily(conversion, "milestone", (record, oldId, id) => ({
      ...record, id, taskId: conversion.taskId
    })),
    events: convertFamily(conversion, "event", (record, oldId, id) => ({
      ...record,
      schemaVersion: 2,
      id,
      taskId: conversion.taskId,
      payload: convertTaskEventPayload(record, conversion)
    }))
  };
}

function convertTaskEventPayload(record: JsonObject, conversion: TaskConversion): JsonObject {
  const eventType = text(record.type, "Task Event type");
  const sourcePayload = object(record.payload, "Task Event payload");
  const payload = { ...sourcePayload };
  const referenceFields = EVENT_REFERENCE_FIELDS[eventType];
  if (referenceFields === undefined) return payload;
  const oldWorkItemId = sourcePayload.workItemId;
  for (const [key, kind] of Object.entries(referenceFields)) {
    if (!Object.hasOwn(sourcePayload, key)) continue;
    payload[key] = kind === "candidate"
      ? mappedCandidate(
          conversion,
          text(oldWorkItemId, `Task Event ${eventType} Work Item id`),
          sourcePayload[key]
        )
      : mapped(conversion, kind, sourcePayload[key], `Task Event ${eventType}.${key}`);
  }
  return payload;
}

function convertWorkItem(
  record: JsonObject,
  oldId: string,
  id: string,
  conversion: TaskConversion
): JsonObject {
  if (record.schemaVersion !== 5) throw new Error("Source WorkItem must use schemaVersion 5.");
  const candidateMap = conversion.candidateByWorkItem.get(oldId)!;
  const candidates = array(record.candidates, "Work Item candidates").map((value, index) => {
    const candidate = clone(object(value, "Work Item candidate"));
    const oldCandidateId = text(candidate.id, "Candidate id");
    const source = object(candidate.source, "Candidate source");
    const workspace = candidate.workspace === undefined
      ? undefined
      : convertWorkspace(candidate.workspace, conversion);
    return {
      ...candidate,
      schemaVersion: 2,
      id: candidateMap.get(oldCandidateId)!,
      taskId: conversion.taskId,
      workItemId: id,
      sequence: index + 1,
      source: source.type === "run"
        ? {
            ...clone(source),
            runId: mapped(conversion, "agentRun", source.runId, "Candidate source Run")
          }
        : clone(source),
      ...(workspace === undefined ? {} : { workspace })
    };
  });
  return {
    ...record,
    schemaVersion: 6,
    id,
    taskId: conversion.taskId,
    dependsOn: array(record.dependsOn, "Work Item dependencies").map((value) => (
      mapped(conversion, "workItem", value, "Work Item dependency")
    )),
    candidates
  };
}

function convertAgentRun(
  record: JsonObject,
  oldId: string,
  id: string,
  conversion: TaskConversion
): JsonObject {
  if (record.schemaVersion !== 3) throw new Error("Source AgentRun must use schemaVersion 3.");
  const agentId = text(record.agentId, "Source Agent Run agent id");
  const adapterId = agentAdapterId(record.adapterId, "Source Agent Run adapter id");
  const convertedWorkspace = record.workspace === undefined
    ? undefined
    : convertWorkspace(record.workspace, conversion);
  const role = object(conversion.source.roles, `Source Task Roles ${conversion.taskId}`)[
    text(record.roleName, "Source Agent Run Role name")
  ];
  const workspace = convertedWorkspace === undefined
    ? legacyRoleWorkspace(role, conversion.source.task)
    : effectiveWorkspace(convertedWorkspace);
  const convertedReviewRoundId = record.reviewRoundId === undefined
    ? undefined
    : mapped(conversion, "reviewRound", record.reviewRoundId, "Agent Run ReviewRound");
  if (convertedReviewRoundId !== undefined && record.status === "active") {
    throw new Error(
      `Source active review Run cannot be converted without frozen launch provenance: ${oldId}.`
    );
  }
  const { agentId: _agentId, adapterId: _adapterId, model: _model, effort: _effort, ...rest } = record;
  return {
    ...rest,
    schemaVersion: 4,
    id,
    taskId: conversion.taskId,
    input: rewriteManagedRunHeader(text(record.input, "Agent Run input"), oldId, id),
    ...(record.workItemId === undefined
      ? {}
      : { workItemId: mapped(conversion, "workItem", record.workItemId, "Agent Run Work Item") }),
    ...(convertedReviewRoundId === undefined
      ? {}
      : { reviewRoundId: convertedReviewRoundId }),
    ...(convertedWorkspace === undefined
      ? {}
      : { workspace: convertedWorkspace }),
    effective: clone(legacyEffectiveLaunchSnapshot({
      sourceDesiredRevision: 1,
      agentId,
      adapterId,
      ...(record.model === undefined ? {} : { model: text(record.model, "Source Agent Run model") }),
      ...(record.effort === undefined ? {} : { effort: text(record.effort, "Source Agent Run effort") }),
      workspace,
      context: role === undefined ? {} : legacyRoleContext(object(role, "Source Agent Run Role")),
      ...(convertedReviewRoundId === undefined
        ? {}
        : { reviewRoundId: convertedReviewRoundId })
    }))
  };
}

function convertReviewRound(
  record: JsonObject,
  id: string,
  conversion: TaskConversion
): JsonObject {
  const status = text(record.status, "Source ReviewRound status");
  if (status === "pending" || status === "running") {
    throw new Error(
      `Source active ReviewRound cannot be converted without a frozen Candidate commit: ${record.id}.`
    );
  }
  return {
    ...record,
    schemaVersion: 2,
    id,
    taskId: conversion.taskId,
    workItemId: mapped(conversion, "workItem", record.workItemId, "ReviewRound Work Item"),
    candidateId: mappedCandidate(
      conversion,
      text(record.workItemId, "ReviewRound Work Item id"),
      record.candidateId
    ),
    reviewBaseProvenance: "legacy-unavailable",
    checks: [],
    ...(record.reviewerRunId === undefined
      ? {}
      : { reviewerRunId: mapped(
          conversion, "agentRun", record.reviewerRunId, "ReviewRound Reviewer Run"
        ) })
  };
}

function convertInputRequest(
  record: JsonObject,
  id: string,
  conversion: TaskConversion
): JsonObject {
  if (record.schemaVersion !== 1) {
    throw new Error("Source InputRequest must use schemaVersion 1.");
  }
  const requester = object(record.requester, "Input requester");
  return {
    ...record,
    schemaVersion: 2,
    id,
    taskId: conversion.taskId,
    requester: {
      ...clone(requester),
      taskId: conversion.taskId,
      runId: mapped(conversion, "agentRun", requester.runId, "Input requester Run")
    },
    blockedRefs: array(record.blockedRefs, "Input blocked refs").map((value) => {
      const reference = object(value, "Input blocked ref");
      if (reference.type !== "run" && reference.type !== "work-item") {
        throw new Error("Input blocked reference type is invalid.");
      }
      return {
        type: reference.type,
        taskId: conversion.taskId,
        id: mapped(
          conversion,
          reference.type === "run" ? "agentRun" : "workItem",
          reference.id,
          "Input blocked reference"
        )
      };
    })
  };
}

function convertWorkspace(value: unknown, conversion: TaskConversion): JsonObject {
  const workspace = clone(object(value, "Managed workspace"));
  const owner = object(workspace.owner, "Managed workspace owner");
  return {
    ...workspace,
    taskId: conversion.taskId,
    owner: owner.type === "work-item"
      ? {
          type: "work-item",
          workItemId: mapped(
            conversion, "workItem", owner.workItemId, "Workspace Work Item"
          )
        }
      : clone(owner)
  };
}

function convertTaskRoleSessionSet(
  value: unknown,
  conversion: TaskConversion,
  role: JsonObject,
  workspaceValue: unknown
): JsonObject {
  const sessions = clone(object(value, "Task Role session set"));
  const owner = object(sessions.owner, "Task Role session owner");
  const inFlight = sessions.inFlight === null
    ? null
    : object(sessions.inFlight, "Task Role in-flight Run");
  const pending = sessions.pendingTurnCompletion === null
    ? null
    : object(sessions.pendingTurnCompletion, "Pending Turn completion");
  return {
    ...sessions,
    sessions: convertSessionMap(
      sessions.sessions,
      role,
      workspaceValue === undefined
        ? legacyRoleWorkspace(role, conversion.source.task)
        : effectiveWorkspace(workspaceValue)
    ),
    owner: { ...clone(owner), taskId: conversion.taskId },
    inFlight: inFlight === null
      ? null
      : {
          ...clone(inFlight),
          runId: mapped(conversion, "agentRun", inFlight.runId, "In-flight Run"),
          receiptId: formatAgentRunReceiptId(
            conversion.taskId,
            mapped(conversion, "agentRun", inFlight.runId, "In-flight Run")
          )
        },
    pendingTurnCompletion: pending === null
      ? null
      : {
          ...clone(pending),
          taskId: conversion.taskId,
          runId: mapped(conversion, "agentRun", pending.runId, "Pending completion Run")
        }
  };
}

function convertRoleSessionSet(
  value: unknown,
  role: JsonObject,
  workspaceValue: unknown
): JsonObject {
  const set = clone(object(value, "Global Role session set"));
  const workspace = workspaceValue === undefined
    ? legacyRoleWorkspace(role)
    : effectiveWorkspace(workspaceValue);
  return {
    ...set,
    sessions: convertSessionMap(set.sessions, role, workspace),
    ...(set.history === undefined
      ? {}
      : { history: convertSessionMap(set.history, role, workspace) })
  };
}

function convertSessionMap(
  value: unknown,
  role: JsonObject,
  workspace: EffectiveLaunchWorkspace
): JsonObject {
  return Object.fromEntries(Object.entries(object(value, "Source Role Agent sessions")).map(
    ([key, sessionValue]) => {
      const session = clone(object(sessionValue, `Source Role Agent session ${key}`));
      if (session.schemaVersion !== 2) {
        throw new Error("Source Role Agent session must use schemaVersion 2.");
      }
      const agentId = text(session.agentId, "Source Session Agent id");
      const adapterId = agentAdapterId(session.adapterId, "Source Session adapter id");
      const binding = object(role.agentBindings, "Source Role Agent bindings")[agentId];
      const config = binding === undefined
        ? undefined
        : object(object(binding, "Source Role Agent binding").config, "Source Role Agent config");
      return [key, {
        ...session,
        schemaVersion: 3,
        effective: clone(legacyEffectiveLaunchSnapshot({
          sourceDesiredRevision: 1,
          agentId,
          adapterId,
          ...(config?.model === undefined
            ? {}
            : { model: text(config.model, "Source Session model") }),
          ...(config?.effort === undefined
            ? {}
            : { effort: text(config.effort, "Source Session effort") }),
          workspace,
          context: legacyRoleContext(role)
        }))
      }];
    }
  ));
}

type OwnerIndex = Readonly<Record<"run" | "work-item" | "input" | "message", Map<
  string,
  readonly TaskConversion[]
>>>;

function buildOwnerIndex(conversions: readonly TaskConversion[]): OwnerIndex {
  const result = {
    run: new Map<string, TaskConversion[]>(),
    "work-item": new Map<string, TaskConversion[]>(),
    input: new Map<string, TaskConversion[]>(),
    message: new Map<string, TaskConversion[]>()
  };
  const kinds = {
    run: "agentRun",
    "work-item": "workItem",
    input: "inputRequest",
    message: "message"
  } as const;
  for (const conversion of conversions) {
    for (const [type, kind] of Object.entries(kinds) as Array<
      [keyof typeof kinds, typeof kinds[keyof typeof kinds]]
    >) {
      for (const id of conversion.maps[kind].keys()) {
        result[type].set(id, [...(result[type].get(id) ?? []), conversion]);
      }
    }
  }
  return result;
}

function convertMailbox(value: unknown, owners: OwnerIndex): JsonObject {
  const mailbox = clone(object(value, "Source WorkMailbox"));
  return {
    ...mailbox,
    processing: mailbox.processing === null
      ? null
      : convertProcessing(mailbox.processing, owners),
    pending: mailbox.pending === null ? null : convertBatch(mailbox.pending, owners)
  };
}

function convertProcessing(value: unknown, owners: OwnerIndex): JsonObject {
  const processing = clone(object(value, "Source processing batch"));
  const executionRef = processing.executionRef === undefined
    ? undefined
    : convertMailboxRef(processing.executionRef, owners);
  return {
    ...processing,
    batchId: rewriteGlobalString(owners, text(processing.batchId, "Mailbox batch id")),
    batch: convertBatch(processing.batch, owners),
    ...(executionRef === undefined ? {} : { executionRef })
  };
}

function convertBatch(value: unknown, owners: OwnerIndex): JsonObject {
  const batch = clone(object(value, "Source mailbox batch"));
  return {
    ...batch,
    reasons: array(batch.reasons, "Mailbox reasons").map((reason) => (
      rewriteGlobalString(owners, text(reason, "Mailbox reason"))
    )),
    refs: array(batch.refs, "Mailbox refs").map((reference) => (
      convertMailboxRef(reference, owners)
    ))
  };
}

function convertMailboxRef(value: unknown, owners: OwnerIndex): JsonObject {
  const reference = object(value, "Source mailbox ref");
  const type = text(reference.type, "Mailbox ref type");
  const id = text(reference.id, "Mailbox ref id");
  if (type === "task" || type === "session") return { type, id };
  if (type !== "run" && type !== "work-item" && type !== "input" && type !== "message") {
    throw new Error(`Source mailbox ref type is invalid: ${type}.`);
  }
  const conversion = uniqueOwner(owners, type, id);
  const kind = type === "run"
    ? "agentRun"
    : type === "work-item" ? "workItem" : type === "input" ? "inputRequest" : "message";
  return { type, taskId: conversion.taskId, id: mapped(conversion, kind, id, "Mailbox ref") };
}

function rewriteGlobalString(owners: OwnerIndex, value: string): string {
  if (value.startsWith("agent-run:")) {
    const oldId = value.slice("agent-run:".length);
    const conversion = uniqueOwner(owners, "run", oldId);
    return formatAgentRunReceiptId(
      conversion.taskId, mapped(conversion, "agentRun", oldId, "Run receipt")
    );
  }
  if (value.startsWith("input-request:")) {
    const oldId = value.slice("input-request:".length);
    const conversion = uniqueOwner(owners, "input", oldId);
    return formatInputRequestReceiptId(
      conversion.taskId, mapped(conversion, "inputRequest", oldId, "Input receipt")
    );
  }
  const separator = value.lastIndexOf(":");
  const prefix = separator < 0 ? "" : value.slice(0, separator + 1);
  const candidate = separator < 0 ? value : value.slice(separator + 1);
  const matches = mailboxOwnersForId(owners, candidate);
  if (matches.length === 0) return value;
  if (matches.length !== 1) throw new Error(`Source identity is ambiguous: ${candidate}.`);
  const { type, conversion } = matches[0]!;
  const kind = type === "run"
    ? "agentRun"
    : type === "work-item" ? "workItem" : type === "input" ? "inputRequest" : "message";
  return `${prefix}${conversion.taskId}/${mapped(conversion, kind, candidate, "Mailbox reason")}`;
}

function mapped(
  conversion: TaskConversion,
  kind: TaskRecordKind,
  value: unknown,
  label: string
): string {
  const oldId = text(value, label);
  const id = conversion.maps[kind].get(oldId);
  if (id === undefined) throw new Error(`${label} is dangling: ${conversion.taskId}/${oldId}.`);
  return id;
}

function mappedCandidate(
  conversion: TaskConversion,
  oldWorkItemId: string,
  value: unknown
): string {
  const oldCandidateId = text(value, "Candidate id");
  const id = conversion.candidateByWorkItem.get(oldWorkItemId)?.get(oldCandidateId);
  if (id === undefined) {
    throw new Error(
      `Candidate reference is dangling: ${conversion.taskId}/${oldWorkItemId}/${oldCandidateId}.`
    );
  }
  return id;
}

function convertFamily(
  conversion: TaskConversion,
  kind: TaskRecordKind,
  convert: (record: JsonObject, oldId: string, id: string) => JsonObject
): JsonObject {
  const output: JsonObject = {};
  for (const [oldId, id] of conversion.maps[kind]) {
    output[id] = convert(
      recordById(conversion.source, FAMILY_FIELDS[kind], oldId, conversion.taskId),
      oldId,
      id
    );
  }
  return output;
}

function convertNamedMap(
  value: unknown,
  convert: (value: unknown) => JsonObject
): JsonObject {
  return Object.fromEntries(Object.entries(object(value, "Source record map")).map(
    ([key, entry]) => [key, convert(entry)]
  ));
}

function recordById(
  aggregate: JsonObject,
  field: string,
  id: string,
  taskId: string
): JsonObject {
  const value = object(aggregate[field], `Source ${field} ${taskId}`)[id];
  return clone(object(value, `Source ${field} ${taskId}/${id}`));
}

function uniqueOwner(
  owners: OwnerIndex,
  type: keyof OwnerIndex,
  id: string
): TaskConversion {
  const matches = owners[type].get(id) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `Source ${type} reference is ${matches.length === 0 ? "dangling" : "ambiguous"}: ${id}.`
    );
  }
  return matches[0]!;
}

function mailboxOwnersForId(
  owners: OwnerIndex,
  id: string
): Array<{ type: keyof OwnerIndex; conversion: TaskConversion }> {
  return (Object.keys(owners) as Array<keyof OwnerIndex>).flatMap((type) => (
    (owners[type].get(id) ?? []).map((conversion) => ({ type, conversion }))
  ));
}

function rewriteManagedRunHeader(input: string, oldId: string, id: string): string {
  const lines = input.replace(/\r/g, "").split("\n");
  const suffix = ` · Run ${oldId}`;
  if (lines.length >= 3 && lines[1] === "" && lines[0]?.endsWith(suffix)) {
    lines[0] = `${lines[0].slice(0, -suffix.length)} · Run ${id}`;
    return lines.join("\n");
  }
  return input;
}

function validateLegacyManifest(value: unknown): void {
  const manifest = exactObject(
    value,
    ["schemaVersion", "storageVersion", "aggregateSchemaVersion", "updatedAt"],
    "Source storage manifest"
  );
  if (manifest.schemaVersion !== 1
    || manifest.storageVersion !== CURRENT_STORAGE_LAYOUT_VERSION
    || manifest.aggregateSchemaVersion !== LEGACY_AGGREGATE_SCHEMA_VERSION) {
    throw new Error(
      `Source must use storage layout ${CURRENT_STORAGE_LAYOUT_VERSION} and aggregate schema ${LEGACY_AGGREGATE_SCHEMA_VERSION}.`
    );
  }
  timestamp(manifest.updatedAt, "Source storage manifest updatedAt");
}

function existingDirectory(value: string, label: string): string {
  const path = realpathSync(resolve(text(value, label)));
  if (!statSync(path).isDirectory()) throw new Error(`${label} must be a directory.`);
  return path;
}

function freshDestination(value: string): string {
  const requested = resolve(text(value, "Conversion output"));
  if (existsSync(requested)) {
    const contents = statSync(requested).isDirectory() ? readdirSync(requested) : ["not-directory"];
    throw new Error(
      contents.length === 0
        ? `Conversion output must not already exist: ${requested}.`
        : `Conversion output must be fresh: ${requested}.`
    );
  }
  const parent = realpathSync(dirname(requested));
  if (!statSync(parent).isDirectory()) throw new Error("Conversion output parent is invalid.");
  return join(parent, basename(requested));
}

function assertDisjoint(source: string, output: string): void {
  if (source === output || source.startsWith(`${output}${sep}`) || output.startsWith(`${source}${sep}`)) {
    throw new Error("Conversion source and output must be disjoint directories.");
  }
}

function assertSourceUnchanged(
  manifestPath: string,
  manifest: Buffer,
  statePath: string,
  state: Buffer
): void {
  if (!manifest.equals(readFileSync(manifestPath)) || !state.equals(readFileSync(statePath))) {
    throw new Error("Conversion source changed while the offline snapshot was being converted.");
  }
}

function parseJson(value: Buffer, label: string): unknown {
  try {
    return JSON.parse(value.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}

function exactObject(
  value: unknown,
  fields: readonly string[],
  label: string
): JsonObject {
  const result = object(value, label);
  const expected = new Set(fields);
  const unknown = Object.keys(result).find((field) => !expected.has(field));
  const missing = fields.find((field) => !Object.hasOwn(result, field));
  if (unknown !== undefined) throw new Error(`${label} has unknown field: ${unknown}.`);
  if (missing !== undefined) throw new Error(`${label} is missing field: ${missing}.`);
  return result;
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} is invalid.`);
  return result;
}

function clone<T extends JsonObject>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
