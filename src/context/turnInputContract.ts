import {
  normalizedUniqueText,
  requireIdentity,
  requireText
} from "../domain/validation.js";
import {
  validateContextSnapshotRef,
  type ContextSnapshotRef
} from "./contextSnapshot.js";

export const TURN_INPUT_PROTOCOL_VERSION = 1 as const;
export const TURN_INPUT_PROTOCOL = "yui-turn/v1" as const;
export const TURN_INPUT_MAX_BYTES = 4 * 1024;
export const TURN_INPUT_MAX_DELTAS = 16;

export type TurnPurpose = "execution" | "review" | "global";
export const YUI_TURN_INPUT_CHANNELS = [
  "user-message",
  "input-response",
  "task-dispatch",
  "workitem-dispatch",
  "leader-wakeup",
  "leader-forced-wakeup"
] as const;

/**
 * Audit-only provenance for the party that submitted this input to the
 * Provider. Every input routed through Yui is `type: "yui"`, including a
 * relayed human message. Native provider UI input remains `user/direct`.
 */
export type TurnInputSource =
  | Readonly<{
      type: "yui";
      channel: typeof YUI_TURN_INPUT_CHANNELS[number];
    }>
  | Readonly<{ type: "user"; channel: "direct" }>
  | Readonly<{ type: "provider"; channel: "goal-continuation" }>;
export type TurnSubject = Readonly<{
  taskId?: string;
  workItemId?: string;
  reviewRoundId?: string;
  executionGroupId?: string;
  executionLaneId?: string;
  sourceExecutionGroupId?: string;
}>;

export type TurnInput = Readonly<{
  schemaVersion: typeof TURN_INPUT_PROTOCOL_VERSION;
  source: TurnInputSource;
  directive?: string;
  contextSnapshotRef?: ContextSnapshotRef;
  deltaRefIds: readonly string[];
}>;

export type TurnInputEnvelopeContext = Readonly<{
  turnId: string;
  roleName: string;
  purpose: TurnPurpose;
  subject: TurnSubject;
}>;

export type TurnInputEnvelope = Readonly<{
  protocol: typeof TURN_INPUT_PROTOCOL;
  turnId: string;
  source: TurnInputSource;
  roleName: string;
  purpose: TurnPurpose;
  subject: TurnSubject;
  contextSnapshotRef?: ContextSnapshotRef;
  deltaRefIds: readonly string[];
}>;

export function createTurnInput(
  input: Omit<TurnInput, "schemaVersion">
): TurnInput {
  const common = normalizeInput(input);
  return Object.freeze({
    schemaVersion: TURN_INPUT_PROTOCOL_VERSION,
    ...common,
    ...(input.directive === undefined
      ? {}
      : { directive: requireText(input.directive, "Turn input directive") })
  });
}

export function validateTurnInput(value: TurnInput): TurnInput {
  if (value.schemaVersion !== TURN_INPUT_PROTOCOL_VERSION) {
    throw new Error("Turn input must use schemaVersion 1.");
  }
  const normalized = createTurnInput(value);
  if (JSON.stringify(normalized) !== JSON.stringify(value)) {
    throw new Error("Turn input is not canonical.");
  }
  return value;
}

export function createTurnInputEnvelope(
  context: TurnInputEnvelopeContext,
  input: TurnInput
): TurnInputEnvelope {
  validateTurnInput(input);
  const normalized = normalizeEnvelopeContext(context, input);
  return Object.freeze({
    protocol: TURN_INPUT_PROTOCOL,
    turnId: normalized.turnId,
    source: input.source,
    roleName: normalized.roleName,
    purpose: normalized.purpose,
    subject: normalized.subject,
    ...(input.contextSnapshotRef === undefined
      ? {}
      : { contextSnapshotRef: input.contextSnapshotRef }),
    deltaRefIds: input.deltaRefIds
  });
}

export function validateTurnInputEnvelope(
  value: TurnInputEnvelope
): TurnInputEnvelope {
  if (value.protocol !== TURN_INPUT_PROTOCOL) {
    throw new Error("Turn input protocol is unsupported.");
  }
  normalizeEnvelope(value);
  const serialized = serializeTurnInputEnvelope(value);
  if (Buffer.byteLength(serialized, "utf8") > TURN_INPUT_MAX_BYTES) {
    throw new Error("Turn input envelope exceeds its protocol byte limit.");
  }
  return value;
}

export function serializeTurnInputEnvelope(value: TurnInputEnvelope): string {
  if (value.protocol !== TURN_INPUT_PROTOCOL) {
    throw new Error("Turn input protocol is unsupported.");
  }
  const normalized = normalizeEnvelope(value);
  const subject = Object.entries(normalized.subject)
    .map(([key, id]) => `${key}:${id}`)
    .join(",");
  const snapshot = normalized.contextSnapshotRef;
  const lines = [
    "Yui Turn input. Follow the Session Manifest and injected Skills.",
    `${normalized.subject.taskId === undefined ? "" : `task=${normalized.subject.taskId} `}turn=${normalized.turnId} role=${normalized.roleName}`,
    `source=${normalized.source.type}/${normalized.source.channel} purpose=${normalized.purpose} subject=${subject || "global"} snapshot=${snapshot === undefined ? "none" : `${snapshot.id}@${snapshot.digest}`}`,
    normalized.deltaRefIds.length === 0
      ? "delta=none"
      : `delta=${normalized.deltaRefIds.join(",")}`,
    "Load the exact Turn context before acting; fail closed if it is unavailable or mismatched."
  ];
  const serialized = lines.join("\n");
  if (Buffer.byteLength(serialized, "utf8") > TURN_INPUT_MAX_BYTES) {
    throw new Error("Turn input envelope exceeds its protocol byte limit.");
  }
  return serialized;
}

/**
 * Bounded infrastructure-recovery input for an already-submitted Turn. It resumes
 * the provider-native transcript after Host/child replacement and never
 * replays the Assignment or its directive.
 */
export function serializeTurnHostRecoveryEnvelope(
  value: TurnInputEnvelope
): string {
  const normalized = normalizeEnvelope(value);
  const serialized = [
    "Yui Host recovery for an existing Turn.",
    `${normalized.subject.taskId === undefined ? "" : `task=${normalized.subject.taskId} `}turn=${normalized.turnId} role=${normalized.roleName}`,
    "Resume the same native conversation from its latest durable state. Do not repeat completed work or replay the original input.",
    "Load the exact Turn context or delta only if needed, then continue the same Turn."
  ].join("\n");
  if (Buffer.byteLength(serialized, "utf8") > TURN_INPUT_MAX_BYTES) {
    throw new Error("Turn Host recovery envelope exceeds its protocol byte limit.");
  }
  return serialized;
}

function normalizeInput(input: Readonly<{
  source: TurnInputSource;
  contextSnapshotRef?: ContextSnapshotRef;
  deltaRefIds: readonly string[];
}>): Omit<TurnInput, "schemaVersion" | "directive"> {
  const source = normalizeSource(input.source);
  const snapshot = input.contextSnapshotRef === undefined
    ? undefined
    : validateContextSnapshotRef(input.contextSnapshotRef);
  const deltaRefIds = normalizedUniqueText(
    input.deltaRefIds,
    "Turn input delta ref"
  );
  if (deltaRefIds.length > TURN_INPUT_MAX_DELTAS) {
    throw new Error(`Turn input supports at most ${TURN_INPUT_MAX_DELTAS} delta refs.`);
  }
  return {
    source,
    ...(snapshot === undefined ? {} : { contextSnapshotRef: snapshot }),
    deltaRefIds
  };
}

function normalizeEnvelopeContext(
  context: TurnInputEnvelopeContext,
  input: TurnInput
): TurnInputEnvelopeContext {
  const normalized = normalizeEnvelope({
    protocol: TURN_INPUT_PROTOCOL,
    turnId: context.turnId,
    source: input.source,
    roleName: context.roleName,
    purpose: context.purpose,
    subject: context.subject,
    ...(input.contextSnapshotRef === undefined
      ? {}
      : { contextSnapshotRef: input.contextSnapshotRef }),
    deltaRefIds: input.deltaRefIds
  });
  return {
    turnId: normalized.turnId,
    roleName: normalized.roleName,
    purpose: normalized.purpose,
    subject: normalized.subject
  };
}

function normalizeEnvelope(input: TurnInputEnvelope): TurnInputEnvelope {
  if (!(["execution", "review", "global"] as const).includes(input.purpose)) {
    throw new Error("Turn input purpose is invalid.");
  }
  const normalizedInput = normalizeInput(input);
  const subject = normalizeSubject(input.subject);
  if (normalizedInput.contextSnapshotRef !== undefined
    && normalizedInput.contextSnapshotRef.taskId !== subject.taskId) {
    throw new Error("Turn input Context Snapshot belongs to another Task.");
  }
  if (input.purpose !== "global" && subject.taskId === undefined) {
    throw new Error("A Task Turn input requires a Task subject.");
  }
  if (input.purpose === "review" && subject.reviewRoundId === undefined) {
    throw new Error("A review Turn input requires a ReviewRound subject.");
  }
  return {
    protocol: TURN_INPUT_PROTOCOL,
    turnId: requireIdentity(input.turnId, "Turn input Turn id"),
    source: normalizedInput.source,
    roleName: requireIdentity(input.roleName, "Turn input Role name"),
    purpose: input.purpose,
    subject,
    ...(normalizedInput.contextSnapshotRef === undefined
      ? {}
      : { contextSnapshotRef: normalizedInput.contextSnapshotRef }),
    deltaRefIds: normalizedInput.deltaRefIds
  };
}

function normalizeSubject(subject: TurnSubject): TurnSubject {
  const normalized = Object.fromEntries(
    Object.entries(subject).map(([key, value]) => [
      key,
      requireIdentity(value, `Turn input ${key}`)
    ])
  ) as TurnSubject;
  const allowed = [
    "taskId",
    "workItemId",
    "reviewRoundId",
    "executionGroupId",
    "executionLaneId",
    "sourceExecutionGroupId"
  ];
  if (Object.keys(normalized).some((key) => !allowed.includes(key))) {
    throw new Error("Turn input subject contains an unknown field.");
  }
  if ((normalized.executionGroupId === undefined) !== (normalized.executionLaneId === undefined)) {
    throw new Error("Turn input execution lineage is incomplete.");
  }
  if (normalized.sourceExecutionGroupId !== undefined
    && ((normalized.workItemId === undefined && normalized.reviewRoundId === undefined)
      || normalized.executionGroupId !== undefined)) {
    throw new Error(
      "Turn input source ExecutionGroup requires a WorkItem or Review main subject."
    );
  }
  if (normalized.taskId === undefined
    && (normalized.workItemId !== undefined || normalized.reviewRoundId !== undefined
      || normalized.executionGroupId !== undefined
      || normalized.sourceExecutionGroupId !== undefined)) {
    throw new Error("Turn input child subject requires a Task id.");
  }
  return Object.freeze(normalized);
}

function normalizeSource(source: TurnInputSource): TurnInputSource {
  if (source.type === "yui" && YUI_TURN_INPUT_CHANNELS.includes(source.channel)) {
    return Object.freeze({ type: "yui", channel: source.channel });
  }
  if (source.type === "user" && source.channel === "direct") {
    return Object.freeze({ type: "user", channel: "direct" });
  }
  if (source.type === "provider" && source.channel === "goal-continuation") {
    return Object.freeze({ type: "provider", channel: "goal-continuation" });
  }
  throw new Error("Turn input source is invalid.");
}
