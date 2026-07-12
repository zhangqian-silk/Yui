import type { InputRequest, InputResolution } from "./inputRequest.js";

const CHOICE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const POINTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const MAX_INPUT_QUESTION_LENGTH = 16_384;
export const MAX_INPUT_ANSWER_LENGTH = 16_384;
export const MAX_INPUT_CHOICE_LABEL_LENGTH = 1_024;
export const MAX_INPUT_CHOICE_DESCRIPTION_LENGTH = 4_096;
export const MAX_INPUT_REASON_LENGTH = 4_096;
export const MAX_INPUT_CHOICES = 100;
export const MAX_INPUT_BLOCKED_REFS = 1_000;
export const MAX_INPUT_REQUESTER_FIELD_LENGTH = 1_024;

export function isInputRequestRecord(
  value: unknown,
  expectedTaskId: string,
  expectedRequestId: string
): value is InputRequest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "id",
      "taskId",
      "requester",
      "question",
      "choices",
      "blockedRefs",
      "resolutionPolicy",
      "status",
      "resolutionId",
      "cancelled",
      "superseded",
      "createdAt",
      "updatedAt"
    ]) ||
    value.schemaVersion !== 1 ||
    value.id !== expectedRequestId ||
    value.taskId !== expectedTaskId ||
    !POINTER_ID_PATTERN.test(expectedTaskId) ||
    !POINTER_ID_PATTERN.test(expectedRequestId) ||
    !isRequester(value.requester) ||
    !isNormalizedText(value.question, MAX_INPUT_QUESTION_LENGTH) ||
    !isChoices(value.choices) ||
    !isBlockedRefs(value.blockedRefs) ||
    !isResolutionPolicy(value.resolutionPolicy, value.choices) ||
    !["open", "answered", "auto-resolved", "cancelled", "superseded"].includes(String(value.status)) ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    return false;
  }

  switch (value.status) {
    case "open":
      return !("resolutionId" in value) && !("cancelled" in value) && !("superseded" in value);
    case "answered":
      return typeof value.resolutionId === "string" &&
        POINTER_ID_PATTERN.test(value.resolutionId) &&
        !("cancelled" in value) &&
        !("superseded" in value);
    case "auto-resolved":
      return value.resolutionPolicy.mode === "offline-recommended" &&
        typeof value.resolutionId === "string" &&
        POINTER_ID_PATTERN.test(value.resolutionId) &&
        !("cancelled" in value) &&
        !("superseded" in value);
    case "cancelled":
      return !("resolutionId" in value) &&
        isCancellation(value.cancelled, value.updatedAt) &&
        !("superseded" in value);
    case "superseded":
      return !("resolutionId" in value) &&
        !("cancelled" in value) &&
        isSupersession(value.superseded, value.updatedAt, expectedRequestId);
    default:
      return false;
  }
}

export function isInputResolutionRecord(
  value: unknown,
  expectedTaskId: string,
  expectedResolutionId: string
): value is InputResolution {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "id",
      "requestId",
      "taskId",
      "source",
      "answer",
      "recommendationReason",
      "operatorPresence",
      "resolvedAt"
    ]) ||
    value.schemaVersion !== 1 ||
    value.id !== expectedResolutionId ||
    value.taskId !== expectedTaskId ||
    !POINTER_ID_PATTERN.test(expectedTaskId) ||
    !POINTER_ID_PATTERN.test(expectedResolutionId) ||
    typeof value.requestId !== "string" ||
    !POINTER_ID_PATTERN.test(value.requestId) ||
    !isAnswer(value.answer) ||
    !["online", "offline"].includes(String(value.operatorPresence)) ||
    !isIsoTimestamp(value.resolvedAt)
  ) {
    return false;
  }

  if (value.source === "user") {
    return !("recommendationReason" in value);
  }
  return value.source === "offline-recommended" &&
    value.operatorPresence === "offline" &&
    typeof value.answer.choiceKey === "string" &&
    isNormalizedText(value.recommendationReason, MAX_INPUT_REASON_LENGTH);
}

function isRequester(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, ["roleName", "agentId", "adapterId", "nativeSessionId", "agentRunId"]) &&
    value.roleName === "leader" &&
    isInputRequesterField(value.agentId) &&
    isInputRequesterField(value.adapterId) &&
    (value.nativeSessionId === undefined || isInputRequesterField(value.nativeSessionId)) &&
    isInputRequesterField(value.agentRunId);
}

function isChoices(value: unknown): value is InputRequest["choices"] {
  if (!Array.isArray(value) || value.length > MAX_INPUT_CHOICES) {
    return false;
  }
  const keys = new Set<string>();
  for (const choice of value) {
    if (
      !isRecord(choice) ||
      !hasOnlyKeys(choice, ["key", "label", "description"]) ||
      typeof choice.key !== "string" ||
      !CHOICE_KEY_PATTERN.test(choice.key) ||
      !isNormalizedText(choice.label, MAX_INPUT_CHOICE_LABEL_LENGTH) ||
      (choice.description !== undefined &&
        !isNormalizedText(choice.description, MAX_INPUT_CHOICE_DESCRIPTION_LENGTH)) ||
      keys.has(choice.key)
    ) {
      return false;
    }
    keys.add(choice.key);
  }
  return true;
}

function isBlockedRefs(value: unknown): boolean {
  return Array.isArray(value) &&
    value.length <= MAX_INPUT_BLOCKED_REFS &&
    value.every((reference) =>
    isRecord(reference) &&
    hasOnlyKeys(reference, ["type", "id"]) &&
    ["work-item", "decision", "task"].includes(String(reference.type)) &&
    typeof reference.id === "string" &&
    POINTER_ID_PATTERN.test(reference.id)
  );
}

function isResolutionPolicy(
  value: unknown,
  choices: InputRequest["choices"]
): value is InputRequest["resolutionPolicy"] {
  if (!isRecord(value)) {
    return false;
  }
  if (value.mode === "user-required") {
    return hasOnlyKeys(value, ["mode"]);
  }
  const recommendation = value.recommendation;
  if (
    value.mode !== "offline-recommended" ||
    !hasOnlyKeys(value, ["mode", "recommendation", "offlineTimeoutMs"]) ||
    !isRecord(recommendation) ||
    !hasOnlyKeys(recommendation, ["choiceKey", "reason"]) ||
    typeof recommendation.choiceKey !== "string" ||
    !choices.some((choice) => choice.key === recommendation.choiceKey) ||
    !isNormalizedText(recommendation.reason, MAX_INPUT_REASON_LENGTH) ||
    !Number.isSafeInteger(value.offlineTimeoutMs) ||
    Number(value.offlineTimeoutMs) <= 0
  ) {
    return false;
  }
  return true;
}

function isCancellation(value: unknown, expectedAt: string): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, ["reason", "cancelledAt"]) &&
    isNormalizedText(value.reason, MAX_INPUT_REASON_LENGTH) &&
    isIsoTimestamp(value.cancelledAt) &&
    value.cancelledAt === expectedAt;
}

function isSupersession(value: unknown, expectedAt: string, requestId: string): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, ["replacementRequestId", "reason", "supersededAt"]) &&
    typeof value.replacementRequestId === "string" &&
    POINTER_ID_PATTERN.test(value.replacementRequestId) &&
    value.replacementRequestId !== requestId &&
    isNormalizedText(value.reason, MAX_INPUT_REASON_LENGTH) &&
    isIsoTimestamp(value.supersededAt) &&
    value.supersededAt === expectedAt;
}

function isAnswer(value: unknown): value is InputResolution["answer"] {
  return isRecord(value) &&
    hasOnlyKeys(value, ["choiceKey", "text"]) &&
    (value.choiceKey === undefined || (
      typeof value.choiceKey === "string" && CHOICE_KEY_PATTERN.test(value.choiceKey)
    )) &&
    isNormalizedText(value.text, MAX_INPUT_ANSWER_LENGTH);
}

export function isInputRequesterField(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    isWellFormedUtf16(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_INPUT_REQUESTER_FIELD_LENGTH;
}

function isNormalizedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value === value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim() &&
    isWellFormedUtf16(value) &&
    Buffer.byteLength(value, "utf8") <= maxBytes;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) {
        return false;
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
