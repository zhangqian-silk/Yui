import { createHash } from "node:crypto";

import { isInputRequestRecord, isInputResolutionRecord } from "../input/inputRecordCodec.js";
import { BUILTIN_TOPICS } from "../topic/topic.js";
import { hasExactOwnKeys, type InertJsonValue } from "./inertJson.js";

export type PortableLifecycle = "live" | "trash";

export type PortableReferenceTarget = {
  lifecycle: PortableLifecycle;
  authority: string;
  key: string;
};

export type PortableReferenceRequirement = {
  anyOf: readonly PortableReferenceTarget[];
};

export type PortablePayloadAgentRequirement = {
  agentId: string;
  adapterId?: string;
};

export type PortablePayloadMetadata = {
  agentRequirements: readonly PortablePayloadAgentRequirement[];
  referenceRequirements: readonly PortableReferenceRequirement[];
  inputPair?: PortableInputPairMetadata;
  inputRequester?: {
    roleKey: string;
    agentRunKey: string;
    roleName: string;
    agentId: string;
    adapterId: string;
  };
  topicScope?: PortableTopicScopeMetadata;
  declaredTopicIds?: readonly string[];
  workItemAssignee?: string;
  agentRunWorkItem?: { workItemKey: string; roleName: string };
  agentRunRoleName?: string;
};

export type PortableInputPairMetadata =
  | {
      kind: "request";
      status: "answered" | "auto-resolved";
      resolutionKey: string;
      choiceKeys: string[];
      recommendation?: { choiceKey: string; choiceLabel: string; reason: string };
      updatedAt: string;
    }
  | {
      kind: "resolution";
      source: "user" | "offline-recommended";
      requestKey: string;
      answerChoiceKey?: string;
      answerText: string;
      recommendationReason?: string;
      resolvedAt: string;
    };

export type PortableTopicScopeMetadata = {
  lifecycle: PortableLifecycle;
  taskId: string;
  topicIds: readonly string[];
};

const EMPTY_METADATA: PortablePayloadMetadata = Object.freeze({
  agentRequirements: Object.freeze([]),
  referenceRequirements: Object.freeze([])
});
const BUILTIN_TOPIC_IDS = new Set(BUILTIN_TOPICS.map((topic) => topic.id));

export function decodePortableSemanticPayload(
  authority: string,
  key: string,
  lifecycle: PortableLifecycle,
  payload: InertJsonValue
): PortablePayloadMetadata | null {
  const segments = key.split("/");
  switch (authority) {
    case "config":
      return decodeConfig(payload);
    case "global-role":
      return decodeRole(payload, key, undefined);
    case "task":
      return decodeTask(payload, key);
    case "task-topics":
      return decodeTaskTopics(payload);
    case "task-input-draft":
      return decodeTaskInputDraft(payload, key);
    case "input-request-history":
      return decodeInputRequest(payload, segments[0] as string, segments[1] as string, lifecycle);
    case "input-resolution":
      return decodeInputResolution(payload, segments[0] as string, segments[1] as string, lifecycle);
    case "task-schedule":
      return isTaskSchedule(payload) ? EMPTY_METADATA : null;
    case "cycle":
      return decodeCycle(payload, segments[0] as string, segments[1] as string, lifecycle);
    case "work-item":
      return decodeWorkItem(payload, segments[0] as string, segments[1] as string, lifecycle);
    case "task-role":
      return decodeRole(payload, segments[1] as string, segments[0] as string);
    case "child-role":
      return decodeChildRole(payload, segments[0] as string, segments[1] as string, lifecycle);
    case "agent-run-history":
      return decodeAgentRun(payload, segments[0] as string, segments[1] as string, lifecycle);
    case "task-brief":
    case "task-topic-summary":
    case "task-timeline":
    case "transcript":
      return typeof payload === "string" ? EMPTY_METADATA : null;
    case "configured-skill":
      return decodeConfiguredSkill(payload, key);
    case "milestone":
      return decodeMilestone(payload, segments[0] as string, segments[1] as string, lifecycle);
    case "decision":
      return decodeDecision(payload, segments[0] as string, segments[1] as string, lifecycle);
    case "comment":
      return decodeComment(payload, segments[0] as string, segments[1] as string, lifecycle);
    case "event":
      return decodeEvent(payload, segments[1] as string);
    default:
      return null;
  }
}

function decodeConfig(payload: InertJsonValue): PortablePayloadMetadata | null {
  if (!isRecord(payload) || !exact(payload, ["schemaVersion"], [
    "defaultAgentId", "currentTaskId", "lastTaskId"
  ]) || payload.schemaVersion !== 1 || !optionalId(payload.defaultAgentId) ||
      !optionalId(payload.currentTaskId) || !optionalId(payload.lastTaskId)) return null;
  const agentRequirements = payload.defaultAgentId === undefined
    ? []
    : [{ agentId: payload.defaultAgentId as string }];
  const references = uniqueStrings([payload.currentTaskId, payload.lastTaskId]
    .filter((value): value is string => typeof value === "string"))
    .map((taskId) => one({ lifecycle: "live", authority: "task", key: taskId }));
  return { agentRequirements, referenceRequirements: references };
}

function decodeTask(payload: InertJsonValue, taskId: string): PortablePayloadMetadata | null {
  if (!isRecord(payload) || !exact(payload,
    ["schemaVersion", "id", "title", "archived", "createdAt", "updatedAt"],
    ["description", "priority", "tags", "dueAt", "archivedAt", "archivedBy", "archiveReason", "archiveSummary"]
  ) || payload.schemaVersion !== 1 || payload.id !== taskId || !nonEmpty(payload.title) ||
      typeof payload.archived !== "boolean" || !instant(payload.createdAt) || !instant(payload.updatedAt) ||
      !optionalString(payload.description) || !optionalEnum(payload.priority, ["low", "medium", "high", "urgent"]) ||
      !optionalStringArray(payload.tags) || !optionalInstant(payload.dueAt) ||
      !optionalString(payload.archiveReason) || !optionalString(payload.archiveSummary)) return null;
  if (payload.archived) {
    if (!instant(payload.archivedAt) || !oneOf(payload.archivedBy, ["user", "operator", "leader"])) return null;
  } else if (payload.archivedAt !== undefined || payload.archivedBy !== undefined ||
      payload.archiveReason !== undefined || payload.archiveSummary !== undefined) {
    return null;
  }
  return EMPTY_METADATA;
}

function decodeRole(
  payload: InertJsonValue,
  roleName: string,
  taskId: string | undefined
): PortablePayloadMetadata | null {
  const required = taskId === undefined
    ? ["schemaVersion", "name", "activeAgentId", "agentBindings", "createdAt", "updatedAt"]
    : ["schemaVersion", "taskId", "name", "activeAgentId", "agentBindings", "createdAt", "updatedAt"];
  if (!isRecord(payload) || !exact(payload, required, [
    "description", "responsibilities", "constraints", "expectedOutput", "systemPrompt", "skills"
  ]) || payload.schemaVersion !== 1 || payload.name !== roleName ||
      (taskId !== undefined && payload.taskId !== taskId) || !id(payload.activeAgentId) ||
      !isRecord(payload.agentBindings) || !instant(payload.createdAt) || !instant(payload.updatedAt) ||
      !optionalString(payload.description) || !optionalStringArray(payload.responsibilities) ||
      !optionalStringArray(payload.constraints) || !optionalString(payload.expectedOutput) ||
      !optionalString(payload.systemPrompt) || !optionalSkillIds(payload.skills)) return null;

  const requirements: PortablePayloadAgentRequirement[] = [];
  const bindingEntries = Object.entries(payload.agentBindings);
  if (bindingEntries.length === 0) return null;
  for (const [agentId, candidate] of bindingEntries) {
    if (!id(agentId) || !isRecord(candidate) || !exact(candidate, ["agentId", "adapterId", "config"]) ||
        candidate.agentId !== agentId || (candidate.adapterId !== "codex" && candidate.adapterId !== "claude") ||
        !decodePortableRoleAgentConfig(candidate.config, candidate.adapterId)) return null;
    requirements.push({ agentId, adapterId: candidate.adapterId });
  }
  requirements.sort(compareAgentRequirement);
  if (!Object.hasOwn(payload.agentBindings, payload.activeAgentId as string)) return null;
  const skillReferences = payload.skills === undefined
    ? []
    : [...payload.skills as InertJsonValue[]]
      .map((skillId) => skillId as string)
      .sort(compareStrings)
      .map((skillId) => one({ lifecycle: "live", authority: "configured-skill", key: skillId }));
  return { agentRequirements: requirements, referenceRequirements: skillReferences };
}

function decodePortableRoleAgentConfig(value: InertJsonValue, adapterId: "codex" | "claude"): boolean {
  if (!isRecord(value) || value.adapterId !== adapterId) return false;
  if (adapterId === "codex") {
    return exact(value, ["adapterId"], ["model", "effort", "permission", "search"]) &&
      optionalStructuralString(value.model) && optionalStructuralString(value.effort) &&
      (value.search === undefined || typeof value.search === "boolean") &&
      (value.permission === undefined || (isRecord(value.permission) &&
        exact(value.permission, [], ["sandbox", "approval"]) &&
        optionalEnum(value.permission.sandbox, ["read-only", "workspace-write", "danger-full-access"]) &&
        optionalEnum(value.permission.approval, ["untrusted", "on-request", "never"])));
  }
  return exact(value, ["adapterId"], ["model", "effort", "permission"]) &&
    optionalStructuralString(value.model) && optionalStructuralString(value.effort) &&
    (value.permission === undefined || (isRecord(value.permission) &&
      exact(value.permission, [], ["mode", "allowedTools", "disallowedTools"]) &&
      optionalStructuralString(value.permission.mode) && optionalSafeToolExpressions(value.permission.allowedTools) &&
      optionalSafeToolExpressions(value.permission.disallowedTools)));
}

function decodeTaskTopics(payload: InertJsonValue): PortablePayloadMetadata | null {
  if (!isRecord(payload) || !exact(payload, ["schemaVersion", "customTopics"]) || payload.schemaVersion !== 1 ||
      !Array.isArray(payload.customTopics)) return null;
  const topicIds: string[] = [];
  for (const topic of payload.customTopics) {
    if (!isRecord(topic) || !exact(topic, ["id", "name", "description", "createdBy", "createdAt"]) ||
        !topicId(topic.id) || BUILTIN_TOPIC_IDS.has(topic.id) || topicIds.includes(topic.id) ||
        !nonEmpty(topic.name) || !nonEmpty(topic.description) ||
        !oneOf(topic.createdBy, ["user", "operator", "leader"]) || !instant(topic.createdAt)) return null;
    topicIds.push(topic.id);
  }
  return { agentRequirements: [], referenceRequirements: [], declaredTopicIds: topicIds };
}

function decodeTaskInputDraft(payload: InertJsonValue, taskId: string): PortablePayloadMetadata | null {
  return isRecord(payload) && exact(payload, [
    "schemaVersion", "taskId", "body", "author", "createdAt", "updatedAt"
  ]) && payload.schemaVersion === 1 && payload.taskId === taskId && nonEmpty(payload.body) &&
    payload.author === "operator" && instant(payload.createdAt) && instant(payload.updatedAt)
    ? EMPTY_METADATA : null;
}

function decodeInputRequest(
  payload: InertJsonValue,
  taskId: string,
  requestId: string,
  lifecycle: PortableLifecycle
): PortablePayloadMetadata | null {
  if (!isInputRequestRecord(payload, taskId, requestId) ||
      !exact(payload.requester as unknown as Record<string, InertJsonValue>, [
        "roleName", "agentId", "adapterId", "agentRunId"
      ]) || !id(payload.requester.agentId) || !adapterId(payload.requester.adapterId) ||
      !id(payload.requester.agentRunId) || payload.status === "open" ||
      payload.choices.some((choice) => !safeRenderedLabel(choice.label))) return null;

  const requirements: PortableReferenceRequirement[] = [
    one({ lifecycle, authority: "task-role", key: `${taskId}/leader` })
  ];
  for (const record of payload.blockedRefs) {
    if (record.type === "task") {
      requirements.push(record.id === taskId
        ? one({ lifecycle, authority: "task", key: record.id })
        : oneOfReferences(
            { lifecycle: "live", authority: "task", key: record.id },
            { lifecycle: "trash", authority: "task", key: record.id }
          ));
    } else {
      requirements.push(one({
        lifecycle,
        authority: record.type === "work-item" ? "work-item" : "decision",
        key: `${taskId}/${record.id}`
      }));
    }
  }
  let inputPair: PortableInputPairMetadata | undefined;
  switch (payload.status) {
    case "answered":
      requirements.push(one({
        lifecycle,
        authority: "input-resolution",
        key: `${taskId}/${payload.resolutionId}`
      }));
      inputPair = {
        kind: "request",
        status: "answered",
        resolutionKey: `${taskId}/${payload.resolutionId}`,
        choiceKeys: payload.choices.map((choice) => choice.key),
        updatedAt: payload.updatedAt
      };
      break;
    case "auto-resolved": {
      const policy = payload.resolutionPolicy;
      if (policy.mode !== "offline-recommended") return null;
      const choice = payload.choices.find((candidate) => candidate.key === policy.recommendation.choiceKey);
      if (choice === undefined) return null;
      requirements.push(one({
        lifecycle,
        authority: "input-resolution",
        key: `${taskId}/${payload.resolutionId}`
      }));
      inputPair = {
        kind: "request",
        status: "auto-resolved",
        resolutionKey: `${taskId}/${payload.resolutionId}`,
        choiceKeys: payload.choices.map((candidate) => candidate.key),
        recommendation: {
          choiceKey: policy.recommendation.choiceKey,
          choiceLabel: choice.label,
          reason: policy.recommendation.reason
        },
        updatedAt: payload.updatedAt
      };
      break;
    }
    case "cancelled":
      break;
    case "superseded":
      break;
    default:
      return null;
  }
  return {
    agentRequirements: [{
      agentId: payload.requester.agentId as string,
      adapterId: payload.requester.adapterId as string
    }],
    referenceRequirements: requirements,
    inputRequester: {
      roleKey: `${taskId}/leader`,
      agentRunKey: `${taskId}/${payload.requester.agentRunId}`,
      roleName: payload.requester.roleName,
      agentId: payload.requester.agentId,
      adapterId: payload.requester.adapterId
    },
    ...(inputPair === undefined ? {} : { inputPair })
  };
}

function decodeInputResolution(
  payload: InertJsonValue,
  taskId: string,
  resolutionId: string,
  lifecycle: PortableLifecycle
): PortablePayloadMetadata | null {
  if (!isInputResolutionRecord(payload, taskId, resolutionId)) return null;
  return {
    agentRequirements: [],
    referenceRequirements: [one({
      lifecycle,
      authority: "input-request-history",
      key: `${taskId}/${payload.requestId}`
    })],
    inputPair: {
      kind: "resolution",
      source: payload.source,
      requestKey: `${taskId}/${payload.requestId}`,
      ...(payload.answer.choiceKey === undefined ? {} : { answerChoiceKey: payload.answer.choiceKey }),
      answerText: payload.answer.text,
      ...(payload.recommendationReason === undefined
        ? {}
        : { recommendationReason: payload.recommendationReason }),
      resolvedAt: payload.resolvedAt
    }
  };
}

function isTaskSchedule(payload: InertJsonValue): boolean {
  return isRecord(payload) && exact(payload,
    ["schemaVersion", "inactivityMinutes", "cooldownMinutes", "updatedAt"], ["reviewAt", "recurring"]
  ) && payload.schemaVersion === 1 && nonNegative(payload.inactivityMinutes) &&
    nonNegative(payload.cooldownMinutes) && optionalInstant(payload.reviewAt) && instant(payload.updatedAt) &&
    (payload.recurring === undefined || (isRecord(payload.recurring) &&
      exact(payload.recurring, ["everyMinutes", "nextAt"]) && positive(payload.recurring.everyMinutes) &&
      instant(payload.recurring.nextAt)));
}

function decodeCycle(
  payload: InertJsonValue,
  taskId: string,
  cycleId: string,
  lifecycle: PortableLifecycle
): PortablePayloadMetadata | null {
  if (!isRecord(payload) || !exact(payload, [
    "schemaVersion", "id", "taskId", "cause", "summary", "topics", "status", "createdAt", "updatedAt"
  ], ["endedAt"]) || payload.schemaVersion !== 1 || payload.id !== cycleId || payload.taskId !== taskId ||
      !oneOf(payload.cause, ["task-created", "user-comment", "schedule", "review-time", "operator-input",
        "role-result", "inactivity", "explicit-wake"]) || !nonEmpty(payload.summary) ||
      !topicIdArray(payload.topics) || !oneOf(payload.status, ["active", "ended"]) ||
      !instant(payload.createdAt) || !instant(payload.updatedAt) ||
      (payload.status === "ended" ? !instant(payload.endedAt) : payload.endedAt !== undefined)) return null;
  return topicMetadata(taskId, lifecycle, payload.topics);
}

function decodeWorkItem(
  payload: InertJsonValue,
  taskId: string,
  workItemId: string,
  lifecycle: PortableLifecycle
): PortablePayloadMetadata | null {
  if (!isRecord(payload) || !exact(payload, [
    "schemaVersion", "id", "taskId", "title", "assignee", "topics", "status", "createdAt", "updatedAt"
  ], ["cycleId", "outcome", "endedAt"]) || payload.schemaVersion !== 1 || payload.id !== workItemId ||
      payload.taskId !== taskId || !nonEmpty(payload.title) || !id(payload.assignee) ||
      !topicIdArray(payload.topics) || !oneOf(payload.status, [
        "pending", "running", "completed", "failed", "cancelled", "superseded"
      ]) || !optionalId(payload.cycleId) || !optionalString(payload.outcome) ||
      !instant(payload.createdAt) || !instant(payload.updatedAt) || !optionalInstant(payload.endedAt)) return null;
  const terminal = ["completed", "failed", "cancelled", "superseded"].includes(payload.status as string);
  if (terminal !== (payload.endedAt !== undefined) || (terminal && !nonEmpty(payload.outcome))) return null;
  const requirements: PortableReferenceRequirement[] = [one({
    lifecycle,
    authority: "task-role",
    key: `${taskId}/${payload.assignee as string}`
  })];
  if (payload.cycleId !== undefined) {
    requirements.push(one({ lifecycle, authority: "cycle", key: `${taskId}/${payload.cycleId as string}` }));
  }
  const topics = topicMetadata(taskId, lifecycle, payload.topics);
  if (topics === null) return null;
  return {
    ...topics,
    referenceRequirements: [...requirements, ...topics.referenceRequirements],
    workItemAssignee: payload.assignee as string
  };
}

function decodeChildRole(
  payload: InertJsonValue,
  taskId: string,
  roleName: string,
  lifecycle: PortableLifecycle
): PortablePayloadMetadata | null {
  if (!isRecord(payload) || !exact(payload, [
    "schemaVersion", "name", "architecture", "parentRole", "description", "responsibilities",
    "constraints", "expectedOutput", "createdAt", "updatedAt"
  ]) || payload.schemaVersion !== 1 || payload.name !== roleName || payload.architecture !== "child" ||
      !id(payload.parentRole) || !nonEmpty(payload.description) || !stringArray(payload.responsibilities) ||
      !stringArray(payload.constraints) || !nonEmpty(payload.expectedOutput) ||
      !instant(payload.createdAt) || !instant(payload.updatedAt)) return null;
  return {
    agentRequirements: [],
    referenceRequirements: [one({
      lifecycle,
      authority: "task-role",
      key: `${taskId}/${payload.parentRole as string}`
    })]
  };
}

function decodeAgentRun(
  payload: InertJsonValue,
  taskId: string,
  runId: string,
  lifecycle: PortableLifecycle
): PortablePayloadMetadata | null {
  if (!isRecord(payload) || !exact(payload, [
    "schemaVersion", "id", "taskId", "roleName", "mode", "input", "status", "summary",
    "createdAt", "updatedAt", "endedAt"
  ], ["workItemId", "topics"]) || payload.schemaVersion !== 1 || payload.id !== runId ||
      payload.taskId !== taskId || !id(payload.roleName) || !oneOf(payload.mode, ["new", "resume"]) ||
      typeof payload.input !== "string" || !oneOf(payload.status, ["yielded", "failed", "expired"]) ||
      !nonEmpty(payload.summary) || !optionalId(payload.workItemId) ||
      (payload.topics !== undefined && !topicIdArray(payload.topics)) ||
      !instant(payload.createdAt) || !instant(payload.updatedAt) || !instant(payload.endedAt)) return null;
  const requirements = [one({
    lifecycle,
    authority: "task-role",
    key: `${taskId}/${payload.roleName as string}`
  })];
  if (payload.workItemId !== undefined) {
    requirements.push(one({
      lifecycle,
      authority: "work-item",
      key: `${taskId}/${payload.workItemId as string}`
    }));
  }
  const topics = topicMetadata(taskId, lifecycle, payload.topics ?? []);
  if (topics === null) return null;
  return {
    ...topics,
    referenceRequirements: [...requirements, ...topics.referenceRequirements],
    agentRunRoleName: payload.roleName as string,
    ...(payload.workItemId === undefined
      ? {}
      : {
          agentRunWorkItem: {
            workItemKey: `${taskId}/${payload.workItemId as string}`,
            roleName: payload.roleName as string
          }
        })
  };
}

function decodeMilestone(
  payload: InertJsonValue,
  taskId: string,
  milestoneId: string,
  lifecycle: PortableLifecycle
): PortablePayloadMetadata | null {
  if (!isRecord(payload) || !exact(payload, [
    "schemaVersion", "id", "taskId", "title", "summary", "topics", "createdBy", "createdAt"
  ]) || payload.schemaVersion !== 1 || payload.id !== milestoneId || payload.taskId !== taskId ||
      !nonEmpty(payload.title) || !nonEmpty(payload.summary) || !topicIdArray(payload.topics) ||
      payload.createdBy !== "leader" || !instant(payload.createdAt)) return null;
  return topicMetadata(taskId, lifecycle, payload.topics);
}

function decodeDecision(
  payload: InertJsonValue,
  taskId: string,
  decisionId: string,
  lifecycle: PortableLifecycle
): PortablePayloadMetadata | null {
  if (!isRecord(payload) || !exact(payload, [
    "schemaVersion", "id", "taskId", "title", "rationale", "topics", "status", "createdAt", "updatedAt"
  ], ["supersededReason"]) || payload.schemaVersion !== 1 || payload.id !== decisionId ||
      payload.taskId !== taskId || !nonEmpty(payload.title) || !nonEmpty(payload.rationale) ||
      !topicIdArray(payload.topics) || !oneOf(payload.status, ["active", "superseded"]) ||
      !instant(payload.createdAt) || !instant(payload.updatedAt) ||
      (payload.status === "superseded"
        ? !nonEmpty(payload.supersededReason)
        : payload.supersededReason !== undefined)) return null;
  return topicMetadata(taskId, lifecycle, payload.topics);
}

function decodeComment(
  payload: InertJsonValue,
  taskId: string,
  commentId: string,
  lifecycle: PortableLifecycle
): PortablePayloadMetadata | null {
  if (!isRecord(payload) || !exact(payload, ["schemaVersion", "id", "body", "topics", "createdAt"], ["author"]) ||
      payload.schemaVersion !== 1 || payload.id !== commentId || !nonEmpty(payload.body) ||
      !topicIdArray(payload.topics) || !optionalEnum(payload.author, ["user", "operator", "leader"]) ||
      !instant(payload.createdAt)) return null;
  return topicMetadata(taskId, lifecycle, payload.topics);
}

function decodeEvent(payload: InertJsonValue, eventId: string): PortablePayloadMetadata | null {
  return isRecord(payload) && exact(payload, ["schemaVersion", "id", "type", "payload", "createdAt"]) &&
    payload.schemaVersion === 1 && payload.id === eventId && eventType(payload.type) &&
    isRecord(payload.payload) && Object.values(payload.payload).every((value) => typeof value === "string") &&
    instant(payload.createdAt) ? EMPTY_METADATA : null;
}

function decodeConfiguredSkill(payload: InertJsonValue, skillId: string): PortablePayloadMetadata | null {
  return isRecord(payload) && exact(payload, ["schemaVersion", "id", "content", "sha256"]) &&
    payload.schemaVersion === 1 && payload.id === skillId && configuredSkillId(payload.id) &&
    nonEmpty(payload.content) && isWellFormedUnicode(payload.content) &&
    typeof payload.sha256 === "string" && /^[a-f0-9]{64}$/.test(payload.sha256) &&
    createHash("sha256").update(payload.content).digest("hex") === payload.sha256
    ? EMPTY_METADATA : null;
}

function one(target: PortableReferenceTarget): PortableReferenceRequirement {
  return { anyOf: [target] };
}

function oneOfReferences(...targets: PortableReferenceTarget[]): PortableReferenceRequirement {
  return { anyOf: targets };
}

function exact(
  value: Record<string, InertJsonValue>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  return hasExactOwnKeys(value, required, optional);
}

function isRecord(value: unknown): value is Record<string, InertJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value &&
    value !== "." && value !== ".." && value !== "__proto__" && value !== "prototype" &&
    value !== "constructor" &&
    !/[\/\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) && !/\p{Bidi_Control}/u.test(value);
}

function adapterId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeRenderedLabel(value: string): boolean {
  return !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) && !/\p{Bidi_Control}/u.test(value);
}

function optionalSafeToolExpressions(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || !value.every((item) =>
    typeof item === "string" && nonEmpty(item) && safeRenderedLabel(item) &&
    !/[\/\\]/u.test(item) &&
    !/(?:api[-_]?key|token|secret|password|credential|authorization|Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,})/iu.test(item))) {
    return false;
  }
  return new Set(value).size === value.length;
}

function optionalStructuralString(value: unknown): boolean {
  return value === undefined || structuralString(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function topicId(value: unknown): value is string {
  return structuralString(value);
}

function topicIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(topicId) && new Set(value).size === value.length;
}

function topicMetadata(
  taskId: string,
  lifecycle: PortableLifecycle,
  topicIds: string[]
): PortablePayloadMetadata {
  const requiresCustomTopics = topicIds.some((topicId) => !BUILTIN_TOPIC_IDS.has(topicId));
  return {
    agentRequirements: [],
    referenceRequirements: requiresCustomTopics
      ? [one({ lifecycle, authority: "task-topics", key: taskId })]
      : [],
    topicScope: { lifecycle, taskId, topicIds: [...topicIds] }
  };
}

function eventType(value: unknown): value is string {
  return structuralString(value);
}

function structuralString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) && !/\p{Bidi_Control}/u.test(value);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || stringArray(value);
}

function optionalSkillIds(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(configuredSkillId) &&
    new Set(value).size === value.length);
}

function configuredSkillId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function optionalId(value: unknown): boolean {
  return value === undefined || id(value);
}

function instant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function optionalInstant(value: unknown): boolean {
  return value === undefined || instant(value);
}

function oneOf(value: unknown, choices: readonly string[]): value is string {
  return typeof value === "string" && choices.includes(value);
}

function optionalEnum(value: unknown, choices: readonly string[]): boolean {
  return value === undefined || oneOf(value, choices);
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareAgentRequirement(
  left: PortablePayloadAgentRequirement,
  right: PortablePayloadAgentRequirement
): number {
  return compareStrings(left.agentId, right.agentId);
}
