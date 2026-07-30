export type InputChoice = Readonly<{ key: string; label: string }>;
export type InputBlockedRef = Readonly<{ type: "work-item" | "run"; id: string }>;

export type InputRequester = Readonly<{
  roleName: "leader";
  agentId: string;
  runId: string;
  nativeSessionId?: string;
}>;

export type InputAnswer =
  | Readonly<{ choiceKey: string; text?: never }>
  | Readonly<{ text: string; choiceKey?: never }>;

export type InputRequestPolicy =
  | Readonly<{ kind: "required" }>
  | Readonly<{
      kind: "recommended";
      recommendedChoiceKey: string;
      timeoutAt: string;
    }>;

export type InputResolution = Readonly<{
  answer: Readonly<{ choiceKey?: string; text: string }>;
  answeredBy: "user" | "operator" | "agent-timeout";
  answeredAt: string;
}>;

export type InputCancellation = Readonly<{
  reason: string;
  cancelledAt: string;
}>;

type InputRequestBase = Readonly<{
  schemaVersion: 1;
  id: string;
  taskId: string;
  requester: InputRequester;
  question: string;
  choices: readonly InputChoice[];
  blockedRefs: readonly InputBlockedRef[];
  policy: InputRequestPolicy;
  createdAt: string;
  updatedAt: string;
}>;

export type InputRequest = InputRequestBase & (
  | Readonly<{ status: "open"; resolution?: never; cancellation?: never }>
  | Readonly<{ status: "answered"; resolution: InputResolution; cancellation?: never }>
  | Readonly<{ status: "cancelled"; cancellation: InputCancellation; resolution?: never }>
);

export type InputRequestStatus = InputRequest["status"];
export type CreateInputRequest = Readonly<{
  question: string;
  choices: readonly InputChoice[];
  blockedRefs: readonly InputBlockedRef[];
  policy?: InputRequestPolicy;
}>;

export class InputRequestStateError extends Error {
  constructor(readonly requestId: string, readonly status: InputRequestStatus) {
    super(`Input request ${requestId} is already ${status}.`);
    this.name = "InputRequestStateError";
  }
}

const CHOICE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function createInputRequest(
  id: string,
  taskId: string,
  requester: InputRequester,
  input: CreateInputRequest,
  now: Date
): InputRequest {
  const timestamp = requireDate(now, "Input request creation time");
  const choices = normalizeChoices(input.choices);
  return validateInputRequest({
    schemaVersion: 1,
    id: requireIdentity(id, "Input request id"),
    taskId: requireIdentity(taskId, "Input request Task id"),
    requester: normalizeRequester(requester),
    question: requireText(input.question, "Input request question"),
    choices,
    blockedRefs: normalizeBlockedRefs(input.blockedRefs),
    policy: normalizePolicy(input.policy, choices, timestamp),
    status: "open",
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function answerInputRequest(
  request: InputRequest,
  answer: InputAnswer,
  answeredBy: InputResolution["answeredBy"],
  now: Date
): InputRequest & { status: "answered"; resolution: InputResolution } {
  validateInputRequest(request);
  assertOpen(request);
  if (answeredBy !== "user" && answeredBy !== "operator" && answeredBy !== "agent-timeout") {
    throw new Error("Input answerer must be user, operator, or agent-timeout.");
  }
  const answeredAt = transitionTime(request, now);
  const normalizedAnswer = normalizeAnswer(request, answer);
  if (answeredBy === "agent-timeout") {
    assertAgentTimeoutAnswer(request, normalizedAnswer, answeredAt);
  }
  return validateInputRequest({
    ...request,
    status: "answered",
    resolution: {
      answer: normalizedAnswer,
      answeredBy,
      answeredAt
    },
    updatedAt: answeredAt
  }) as InputRequest & { status: "answered"; resolution: InputResolution };
}

export function cancelInputRequest(request: InputRequest, reason: string, now: Date): InputRequest {
  validateInputRequest(request);
  assertOpen(request);
  const cancelledAt = transitionTime(request, now);
  return validateInputRequest({
    ...request,
    status: "cancelled",
    cancellation: {
      reason: requireText(reason, "Input cancellation reason"),
      cancelledAt
    },
    updatedAt: cancelledAt
  });
}

export function validateInputRequest(value: unknown): InputRequest {
  const request = record(value, "Input request");
  const terminalField = request.status === "answered"
    ? ["resolution"]
    : request.status === "cancelled" ? ["cancellation"] : [];
  exact(request, [
    "schemaVersion", "id", "taskId", "requester", "question", "choices",
    "blockedRefs", "policy", "status", "createdAt", "updatedAt", ...terminalField
  ], "Input request");
  if (request.schemaVersion !== 1) throw new Error("Input request must use schemaVersion 1.");
  const choices = validateChoices(request.choices);
  const createdAt = requireTimestamp(request.createdAt, "Input request createdAt");
  const base: InputRequestBase = {
    schemaVersion: 1,
    id: requireIdentity(request.id, "Input request id"),
    taskId: requireIdentity(request.taskId, "Input request Task id"),
    requester: normalizeRequester(request.requester as InputRequester),
    question: requireNormalizedText(request.question, "Input request question"),
    choices,
    blockedRefs: validateBlockedRefs(request.blockedRefs),
    policy: normalizePolicy(request.policy as InputRequestPolicy, choices, createdAt),
    createdAt,
    updatedAt: requireTimestamp(request.updatedAt, "Input request updatedAt")
  };
  if (Date.parse(base.updatedAt) < Date.parse(base.createdAt)) {
    throw new Error("Input request updatedAt cannot precede createdAt.");
  }
  if (request.status === "open") return { ...base, status: "open" };
  if (request.status === "answered") {
    const resolution = record(request.resolution, "Input resolution");
    exact(resolution, ["answer", "answeredBy", "answeredAt"], "Input resolution");
    const answer = validatePersistedAnswer(base.choices, resolution.answer);
    if (resolution.answeredBy !== "user"
      && resolution.answeredBy !== "operator"
      && resolution.answeredBy !== "agent-timeout") {
      throw new Error("Input resolution answerer must be user, operator, or agent-timeout.");
    }
    const answeredAt = requireTimestamp(resolution.answeredAt, "Input resolution answeredAt");
    if (answeredAt !== base.updatedAt) throw new Error("Input resolution answeredAt must match updatedAt.");
    if (resolution.answeredBy === "agent-timeout") {
      assertAgentTimeoutAnswer(base, answer, answeredAt);
    }
    return {
      ...base,
      status: "answered",
      resolution: {
        answer,
        answeredBy: resolution.answeredBy,
        answeredAt
      }
    };
  }
  if (request.status === "cancelled") {
    const cancellation = record(request.cancellation, "Input cancellation");
    exact(cancellation, ["reason", "cancelledAt"], "Input cancellation");
    const cancelledAt = requireTimestamp(cancellation.cancelledAt, "Input cancellation cancelledAt");
    if (cancelledAt !== base.updatedAt) throw new Error("Input cancellation cancelledAt must match updatedAt.");
    return {
      ...base,
      status: "cancelled",
      cancellation: {
        reason: requireNormalizedText(cancellation.reason, "Input cancellation reason"),
        cancelledAt
      }
    };
  }
  throw new Error(`Input request status is invalid: ${String(request.status)}.`);
}

function normalizeChoices(value: readonly InputChoice[]): InputChoice[] {
  if (!Array.isArray(value)) throw new Error("Input choices must be an array.");
  const choices = value.map((choice) => {
    const item = record(choice, "Input choice");
    exact(item, ["key", "label"], "Input choice");
    return {
      key: requireChoiceKey(item.key),
      label: requireText(item.label, "Input choice label")
    };
  });
  if (new Set(choices.map(({ key }) => key)).size !== choices.length) {
    throw new Error("Input choice keys must be unique.");
  }
  return choices;
}

function validateChoices(value: unknown): InputChoice[] {
  const choices = normalizeChoices(value as InputChoice[]);
  if (JSON.stringify(choices) !== JSON.stringify(value)) throw new Error("Input choices must be normalized.");
  return choices;
}

function normalizeBlockedRefs(value: readonly InputBlockedRef[]): InputBlockedRef[] {
  if (!Array.isArray(value)) throw new Error("Input blocked references must be an array.");
  const references: InputBlockedRef[] = value.map((reference): InputBlockedRef => {
    const item = record(reference, "Input blocked reference");
    exact(item, ["type", "id"], "Input blocked reference");
    if (item.type !== "work-item" && item.type !== "run") {
      throw new Error("Input blocked reference type must be work-item or run.");
    }
    return { type: item.type, id: requireIdentity(item.id, "Input blocked reference id") };
  });
  const keys = references.map(({ type, id }) => `${type}:${id}`);
  if (new Set(keys).size !== keys.length) throw new Error("Input blocked references must be unique.");
  return references;
}

function normalizePolicy(
  value: InputRequestPolicy | undefined,
  choices: readonly InputChoice[],
  createdAt: string
): InputRequestPolicy {
  if (value === undefined) return { kind: "required" };
  const policy = record(value, "Input request policy");
  if (policy.kind === "required") {
    exact(policy, ["kind"], "Input request policy");
    return { kind: "required" };
  }
  if (policy.kind !== "recommended") {
    throw new Error("Input request policy kind is invalid.");
  }
  exact(
    policy,
    ["kind", "recommendedChoiceKey", "timeoutAt"],
    "Input request policy"
  );
  if (choices.length === 0) {
    throw new Error("Recommended input request requires choices.");
  }
  const recommendedChoiceKey = requireChoiceKey(policy.recommendedChoiceKey);
  if (!choices.some((choice) => choice.key === recommendedChoiceKey)) {
    throw new Error(`Recommended input choice does not exist: ${recommendedChoiceKey}.`);
  }
  const timeoutAt = requireTimestamp(policy.timeoutAt, "Input request timeoutAt");
  if (Date.parse(timeoutAt) <= Date.parse(createdAt)) {
    throw new Error("Input request timeoutAt must be after creation.");
  }
  return { kind: "recommended", recommendedChoiceKey, timeoutAt };
}

function validateBlockedRefs(value: unknown): InputBlockedRef[] {
  const references = normalizeBlockedRefs(value as InputBlockedRef[]);
  if (JSON.stringify(references) !== JSON.stringify(value)) {
    throw new Error("Input blocked references must be normalized.");
  }
  return references;
}

function normalizeRequester(value: InputRequester): InputRequester {
  const requester = record(value, "Input requester");
  exact(
    requester,
    requester.nativeSessionId === undefined
      ? ["roleName", "agentId", "runId"]
      : ["roleName", "agentId", "runId", "nativeSessionId"],
    "Input requester"
  );
  if (requester.roleName !== "leader") throw new Error("Input requester must be the Task Leader.");
  return {
    roleName: "leader",
    agentId: requireIdentity(requester.agentId, "Input requester Agent id"),
    runId: requireIdentity(requester.runId, "Input requester Run id"),
    ...(requester.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: requireIdentity(requester.nativeSessionId, "Input requester native session id") })
  };
}

function normalizeAnswer(request: InputRequest, answer: InputAnswer): InputResolution["answer"] {
  const value = record(answer, "Input answer");
  if (request.choices.length === 0) {
    if (value.choiceKey !== undefined) throw new Error("Free-text input request does not accept a choice.");
    exact(value, ["text"], "Input answer");
    return { text: requireText(value.text, "Input answer") };
  }
  if (value.text !== undefined) {
    throw new Error("Choice input request requires a choice answer.");
  }
  exact(value, ["choiceKey"], "Input answer");
  const key = requireChoiceKey(value.choiceKey);
  const choice = request.choices.find((candidate) => candidate.key === key);
  if (choice === undefined) throw new Error(`Input answer choice does not exist: ${key}.`);
  return { choiceKey: choice.key, text: choice.label };
}

function assertAgentTimeoutAnswer(
  request: Pick<InputRequestBase, "policy">,
  answer: InputResolution["answer"],
  answeredAt: string
): void {
  if (request.policy.kind !== "recommended") {
    throw new Error("Required input request cannot be answered by Agent timeout.");
  }
  if (Date.parse(answeredAt) < Date.parse(request.policy.timeoutAt)) {
    throw new Error("Input request has not reached its timeout.");
  }
  if (answer.choiceKey !== request.policy.recommendedChoiceKey) {
    throw new Error("Agent timeout must use the recommended choice.");
  }
}

function assertOpen(request: InputRequest): asserts request is InputRequest & { status: "open" } {
  if (request.status !== "open") throw new InputRequestStateError(request.id, request.status);
}

function transitionTime(request: InputRequest, now: Date): string {
  const timestamp = requireDate(now, "Input request transition time");
  if (Date.parse(timestamp) < Date.parse(request.createdAt)) {
    throw new Error("Input request transition cannot predate creation.");
  }
  return timestamp;
}

function requireChoiceKey(value: unknown): string {
  if (typeof value !== "string" || !CHOICE_KEY.test(value)) throw new Error("Input choice key is invalid.");
  return value;
}

function validatePersistedAnswer(
  choices: readonly InputChoice[],
  value: unknown
): InputResolution["answer"] {
  const answer = record(value, "Input resolution answer");
  if (choices.length === 0) {
    exact(answer, ["text"], "Input resolution answer");
    return { text: requireNormalizedText(answer.text, "Input answer") };
  }
  exact(answer, ["choiceKey", "text"], "Input resolution answer");
  const choiceKey = requireChoiceKey(answer.choiceKey);
  const choice = choices.find((candidate) => candidate.key === choiceKey);
  if (choice === undefined) throw new Error(`Input answer choice does not exist: ${choiceKey}.`);
  const text = requireNormalizedText(answer.text, "Input answer");
  if (text !== choice.label) throw new Error("Input answer text does not match the selected choice label.");
  return { choiceKey, text };
}

function requireIdentity(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(text) || /[\/\\\0]/.test(text)) {
    throw new Error(`${label} is invalid.`);
  }
  return text;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const text = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  if (text.length === 0) throw new Error(`${label} is required.`);
  return text;
}

function requireNormalizedText(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (text !== value) throw new Error(`${label} must be normalized.`);
  return text;
}

function requireDate(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${label} is invalid.`);
  return value.toISOString();
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid.`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new Error(`${label} has unknown field: ${unknown}.`);
  const missing = fields.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new Error(`${label} is missing field: ${missing}.`);
}
