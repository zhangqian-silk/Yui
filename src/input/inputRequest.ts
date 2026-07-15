import {
  MAX_INPUT_ANSWER_LENGTH,
  MAX_INPUT_CHOICE_DESCRIPTION_LENGTH,
  MAX_INPUT_CHOICE_LABEL_LENGTH,
  MAX_INPUT_BLOCKED_REFS,
  MAX_INPUT_CHOICES,
  MAX_INPUT_QUESTION_LENGTH,
  MAX_INPUT_REASON_LENGTH,
  isInputRequesterField,
  isInputRequestRecord,
  isInputResolutionRecord
} from "./inputRecordCodec.js";
import {
  isCanonicalNativeSessionId,
  isCanonicalNativeSessionRoot
} from "../executor/nativeSessionIdentity.js";

export {
  MAX_INPUT_ANSWER_LENGTH,
  MAX_INPUT_CHOICE_DESCRIPTION_LENGTH,
  MAX_INPUT_CHOICE_LABEL_LENGTH,
  MAX_INPUT_BLOCKED_REFS,
  MAX_INPUT_CHOICES,
  MAX_INPUT_QUESTION_LENGTH,
  MAX_INPUT_REASON_LENGTH
} from "./inputRecordCodec.js";

export type InputChoice = {
  key: string;
  label: string;
  description?: string;
};

export type BlockedRef =
  | { type: "work-item"; id: string }
  | { type: "decision"; id: string }
  | { type: "task"; id: string };

export type ResolutionPolicy =
  | { mode: "user-required" }
  | {
      mode: "offline-recommended";
      recommendation: { choiceKey: string; reason: string };
      offlineTimeoutMs: number;
    };

type InputRequesterIdentity = {
  roleName: "leader";
  agentId: string;
  adapterId: string;
  agentRunId: string;
};

export type InputRequesterWithNativeSession = InputRequesterIdentity & {
  sessionRoot: string;
  nativeSessionId: string;
};

export type InputRequesterHistory = InputRequesterIdentity & {
  sessionRoot?: never;
  nativeSessionId?: never;
};

/**
 * Terminal input history may retain the logical requester identity without
 * retaining the host-native session tuple. Open input always uses the native
 * session form, which is required for blocking and wakeup delivery.
 */
export type InputRequester = InputRequesterWithNativeSession | InputRequesterHistory;

export type InputRequestStatus = "open" | "answered" | "auto-resolved" | "cancelled" | "superseded";

export type InputRequest = {
  schemaVersion: 1;
  id: string;
  taskId: string;
  requester: InputRequester;
  question: string;
  choices: InputChoice[];
  blockedRefs: BlockedRef[];
  resolutionPolicy: ResolutionPolicy;
  status: InputRequestStatus;
  resolutionId?: string;
  cancelled?: { reason: string; cancelledAt: string };
  superseded?: { replacementRequestId: string; reason: string; supersededAt: string };
  createdAt: string;
  updatedAt: string;
};

export type CreateInputRequest = Pick<
  InputRequest,
  "question" | "choices" | "blockedRefs" | "resolutionPolicy"
>;

export type OperatorPresence = "online" | "offline";

export type InputResolution = {
  schemaVersion: 1;
  id: string;
  requestId: string;
  taskId: string;
  source: "user" | "offline-recommended";
  answer: {
    choiceKey?: string;
    text: string;
  };
  recommendationReason?: string;
  operatorPresence: OperatorPresence;
  resolvedAt: string;
};

export type InputResolutionResult = {
  request: InputRequest & { requester: InputRequesterWithNativeSession };
  resolution: InputResolution;
};

export class InputRequestStateError extends Error {
  constructor(readonly requestId: string, readonly status: InputRequestStatus) {
    super(`Input request ${requestId} is already ${status}.`);
    this.name = "InputRequestStateError";
  }
}

const CHOICE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const POINTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function createInputRequest(
  id: string,
  taskId: string,
  requester: InputRequesterWithNativeSession,
  input: CreateInputRequest,
  now: Date
): InputRequest {
  assertPointerId(id, "Input request id");
  assertPointerId(taskId, "Task id");
  const normalizedRequester = normalizeRequester(requester);

  const timestamp = now.toISOString();
  const question = normalizeText(input.question);
  if (question.length === 0) {
    throw new Error("Input request question is required.");
  }
  assertTextEncodingAndSize(question, "Input request question", MAX_INPUT_QUESTION_LENGTH);

  if (!isDenseArray(input.choices)) {
    throw new Error("Input choices must be a dense array.");
  }
  if (input.choices.length > MAX_INPUT_CHOICES) {
    throw new Error(`Too many input choices (maximum ${MAX_INPUT_CHOICES}).`);
  }
  const choices = input.choices.map(normalizeChoice);
  if (new Set(choices.map((choice) => choice.key)).size !== choices.length) {
    throw new Error("Choice keys must be unique.");
  }

  if (!isDenseArray(input.blockedRefs)) {
    throw new Error("Blocked references must be a dense array.");
  }
  if (input.blockedRefs.length > MAX_INPUT_BLOCKED_REFS) {
    throw new Error(`Too many blocked references (maximum ${MAX_INPUT_BLOCKED_REFS}).`);
  }
  const blockedRefs = input.blockedRefs.map(normalizeBlockedRef);
  const resolutionPolicy = normalizeResolutionPolicy(input.resolutionPolicy, choices);

  return {
    schemaVersion: 1,
    id,
    taskId,
    requester: normalizedRequester,
    question,
    choices,
    blockedRefs,
    resolutionPolicy,
    status: "open",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function answerInputRequest(
  request: InputRequest,
  resolutionId: string,
  answer: InputResolution["answer"],
  operatorPresence: OperatorPresence,
  now: Date
): InputResolutionResult {
  assertValidInputRequest(request);
  assertOpen(request);
  assertPointerId(resolutionId, "Input resolution id");
  assertOperatorPresence(operatorPresence);

  const normalizedAnswer = normalizeAnswer(request, answer);
  const resolvedAt = transitionTimestamp(request, now);
  return {
    request: {
      ...request,
      status: "answered",
      resolutionId,
      updatedAt: resolvedAt
    },
    resolution: {
      schemaVersion: 1,
      id: resolutionId,
      requestId: request.id,
      taskId: request.taskId,
      source: "user",
      answer: normalizedAnswer,
      operatorPresence,
      resolvedAt
    }
  };
}

export function autoResolveInputRequest(
  request: InputRequest,
  resolutionId: string,
  operatorPresence: OperatorPresence,
  now: Date
): InputResolutionResult {
  assertValidInputRequest(request);
  assertOpen(request);
  assertPointerId(resolutionId, "Input resolution id");
  if (operatorPresence !== "offline") {
    throw new Error("Automatic resolution requires offline Operator presence.");
  }
  if (request.resolutionPolicy.mode !== "offline-recommended") {
    throw new Error(`Input request ${request.id} does not allow automatic resolution.`);
  }

  const policy = request.resolutionPolicy;
  const choice = request.choices.find(
    (candidate) => candidate.key === policy.recommendation.choiceKey
  );
  if (choice === undefined) {
    throw new Error("Recommended choice does not exist.");
  }

  const resolvedAt = transitionTimestamp(request, now);
  return {
    request: {
      ...request,
      status: "auto-resolved",
      resolutionId,
      updatedAt: resolvedAt
    },
    resolution: {
      schemaVersion: 1,
      id: resolutionId,
      requestId: request.id,
      taskId: request.taskId,
      source: "offline-recommended",
      answer: { choiceKey: choice.key, text: choice.label },
      recommendationReason: policy.recommendation.reason,
      operatorPresence: "offline",
      resolvedAt
    }
  };
}

export function cancelInputRequest(request: InputRequest, reason: string, now: Date): InputRequest {
  assertValidInputRequest(request);
  assertOpen(request);
  const normalizedReason = requiredText(reason, "Input request cancellation reason", MAX_INPUT_REASON_LENGTH);
  const cancelledAt = transitionTimestamp(request, now);
  return {
    ...request,
    status: "cancelled",
    cancelled: { reason: normalizedReason, cancelledAt },
    updatedAt: cancelledAt
  };
}

export function supersedeInputRequest(
  request: InputRequest,
  replacementRequestId: string,
  reason: string,
  now: Date
): InputRequest {
  assertValidInputRequest(request);
  assertOpen(request);
  assertPointerId(replacementRequestId, "Replacement input request id");
  if (replacementRequestId === request.id) {
    throw new Error("Replacement input request must be different from the superseded request.");
  }

  const normalizedReason = requiredText(reason, "Input request supersede reason", MAX_INPUT_REASON_LENGTH);
  const supersededAt = transitionTimestamp(request, now);
  return {
    ...request,
    status: "superseded",
    superseded: { replacementRequestId, reason: normalizedReason, supersededAt },
    updatedAt: supersededAt
  };
}

function normalizeChoice(choice: InputChoice): InputChoice {
  if (typeof choice?.key !== "string") {
    throw new Error("Invalid choice key.");
  }
  const key = choice.key.trim();
  if (!CHOICE_KEY_PATTERN.test(key)) {
    throw new Error("Invalid choice key.");
  }

  const label = requiredText(choice.label, "Choice label", MAX_INPUT_CHOICE_LABEL_LENGTH);
  return {
    key,
    label,
    ...(choice.description === undefined
      ? {}
      : {
          description: requiredText(
            choice.description,
            "Choice description",
            MAX_INPUT_CHOICE_DESCRIPTION_LENGTH
          )
        })
  };
}

function normalizeBlockedRef(reference: BlockedRef): BlockedRef {
  if (
    !["work-item", "decision", "task"].includes(reference.type) ||
    typeof reference.id !== "string" ||
    !POINTER_ID_PATTERN.test(reference.id.trim())
  ) {
    throw new Error("Invalid blocked reference.");
  }
  return { type: reference.type, id: reference.id.trim() };
}

function normalizeResolutionPolicy(policy: ResolutionPolicy, choices: InputChoice[]): ResolutionPolicy {
  if (policy.mode === "user-required") {
    return { mode: "user-required" };
  }

  if (choices.length === 0) {
    throw new Error("Offline recommendation requires at least one choice.");
  }
  const choiceKey = policy.recommendation.choiceKey.trim();
  if (!choices.some((choice) => choice.key === choiceKey)) {
    throw new Error("Recommended choice does not exist.");
  }
  const reason = requiredText(policy.recommendation.reason, "Recommendation reason", MAX_INPUT_REASON_LENGTH);
  if (!Number.isSafeInteger(policy.offlineTimeoutMs) || policy.offlineTimeoutMs <= 0) {
    throw new Error("Offline timeout must be positive whole milliseconds.");
  }

  return {
    mode: "offline-recommended",
    recommendation: { choiceKey, reason },
    offlineTimeoutMs: policy.offlineTimeoutMs
  };
}

function normalizeAnswer(request: InputRequest, answer: InputResolution["answer"]): InputResolution["answer"] {
  if (request.choices.length === 0) {
    if (answer.choiceKey !== undefined) {
      throw new Error("Free-text input request does not accept a choice key.");
    }
    return { text: requiredText(answer.text, "Input answer", MAX_INPUT_ANSWER_LENGTH) };
  }

  const choiceKey = answer.choiceKey?.trim();
  const choice = request.choices.find((candidate) => candidate.key === choiceKey);
  if (choiceKey === undefined || choice === undefined) {
    throw new Error("Invalid answer choice.");
  }
  return { choiceKey, text: choice.label };
}

function assertOpen(
  request: InputRequest
): asserts request is InputRequest & { status: "open"; requester: InputRequesterWithNativeSession } {
  if (request.status !== "open") {
    throw new InputRequestStateError(request.id, request.status);
  }
  assertInputRequesterWithNativeSession(request.requester);
}

export function assertValidInputRequest(value: unknown): asserts value is InputRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("taskId" in value) ||
    !("id" in value) ||
    typeof value.taskId !== "string" ||
    typeof value.id !== "string" ||
    !isInputRequestRecord(value, value.taskId, value.id)
  ) {
    throw new Error("Invalid input request record.");
  }
}

export function assertValidInputResolution(value: unknown): asserts value is InputResolution {
  if (
    typeof value !== "object" ||
    value === null ||
    !("taskId" in value) ||
    !("id" in value) ||
    typeof value.taskId !== "string" ||
    typeof value.id !== "string" ||
    !isInputResolutionRecord(value, value.taskId, value.id)
  ) {
    throw new Error("Invalid input resolution record.");
  }
}

export function createInputRequestEventPayload(request: InputRequest): Record<string, string> {
  assertValidInputRequest(request);
  return {
    taskId: request.taskId,
    requestId: request.id,
    ...(request.status === "superseded"
      ? { replacementRequestId: request.superseded!.replacementRequestId }
      : {}),
    status: request.status,
    policy: request.resolutionPolicy.mode
  };
}

export function createInputResolutionEventPayload(resolution: InputResolution): Record<string, string> {
  assertValidInputResolution(resolution);
  return {
    taskId: resolution.taskId,
    requestId: resolution.requestId,
    resolutionId: resolution.id,
    source: resolution.source
  };
}

export function inputResolutionSourceLabel(source: InputResolution["source"]): string {
  return source === "user" ? "User answer" : "Offline recommendation";
}

export function assertInputRequesterWithNativeSession(
  requester: InputRequester
): asserts requester is InputRequesterWithNativeSession {
  if (!isInputRequesterWithNativeSession(requester)) {
    throw new Error("Input requester native session is unavailable.");
  }
}

function isInputRequesterWithNativeSession(
  requester: InputRequester
): requester is InputRequesterWithNativeSession {
  return requester.roleName === "leader" &&
    [requester.agentId, requester.adapterId, requester.agentRunId].every(isInputRequesterField) &&
    isCanonicalNativeSessionRoot(requester.sessionRoot) &&
    isInputRequesterField(requester.nativeSessionId) &&
    isCanonicalNativeSessionId(requester.nativeSessionId);
}

function normalizeRequester(
  requester: InputRequesterWithNativeSession
): InputRequesterWithNativeSession {
  if (
    requester.roleName !== "leader" ||
    [requester.agentId, requester.adapterId, requester.agentRunId].some(
      (value) => !isInputRequesterField(value)
    ) ||
    !isCanonicalNativeSessionRoot(requester.sessionRoot) ||
    !isInputRequesterField(requester.nativeSessionId) ||
    !isCanonicalNativeSessionId(requester.nativeSessionId)
  ) {
    throw new Error("Invalid input requester.");
  }
  return {
    roleName: "leader",
    agentId: requester.agentId,
    adapterId: requester.adapterId,
    sessionRoot: requester.sessionRoot,
    nativeSessionId: requester.nativeSessionId,
    agentRunId: requester.agentRunId
  };
}

function transitionTimestamp(request: InputRequest, now: Date): string {
  const timestamp = now.toISOString();
  if (timestamp < request.createdAt) {
    throw new Error(`Input request ${request.id} transition cannot predate request creation.`);
  }
  return timestamp;
}

function assertPointerId(value: string, label: string): void {
  if (typeof value !== "string" || !POINTER_ID_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertOperatorPresence(value: OperatorPresence): void {
  if (value !== "online" && value !== "offline") {
    throw new Error(`Invalid Operator presence: ${String(value)}.`);
  }
}

function requiredText(value: string, label: string, maxBytes: number): string {
  const normalized = normalizeText(value);
  if (normalized.length === 0) {
    throw new Error(`${label} is required.`);
  }
  assertTextEncodingAndSize(normalized, label, maxBytes);
  return normalized;
}

function assertTextEncodingAndSize(value: string, label: string, maxBytes: number): void {
  if (!isWellFormedUtf16(value)) {
    throw new Error(`${label} is not valid Unicode.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${label} is too long (maximum ${maxBytes} UTF-8 bytes).`);
  }
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

function normalizeText(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      return false;
    }
  }
  return true;
}
