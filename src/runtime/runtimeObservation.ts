import { createHash } from "node:crypto";

import type {
  AgentRuntimeObserverSource,
  AgentRuntimeOperation,
  AgentRuntimeWaitReason
} from "./agentDriver.js";
import { requireDriverId } from "./agentDriver.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { ProviderErrorCode } from "./providerErrorCodes.js";

export const RUNTIME_OBSERVATION_TASK_EVENT = "runtime.observation";

export type RuntimeObservationKind =
  | "host.observed"
  | "session.started"
  | "session.ready"
  | "session.ended"
  | "session.failed"
  | "conversation.observed"
  | "activation.started"
  | "activation.ended"
  | "activation.failed"
  | "turn.accepted"
  | "turn.waiting"
  | "turn.completed"
  | "turn.failed"
  | "turn.cancelled"
  | "operation.started"
  | "operation.completed"
  | "operation.failed"
  | "native-work.snapshot"
  | "continuation.started"
  | "continuation.reported"
  | "continuation.settled"
  | "input.accepted"
  | "input.delivery-unknown"
  | "activity.observed"
  | "observer.health";

export type RuntimeObservationAuthority =
  | "controller"
  | "transport"
  | "provider-structured"
  | "driver-inferred"
  | "host"
  | "diagnostic";

export type RuntimeObservationFence = Readonly<{
  taskId?: string;
  roleName: string;
  runId?: string;
  agentId: string;
  /** Open, namespaced Driver identity; never a closed provider union. */
  driverId: string;
  launchId: string;
  sessionGenerationId: string;
  conversationId?: string;
  activationId?: string;
  continuationId?: string;
  continuationGeneration?: number;
  parentContinuationId?: string;
  nativeSessionId?: string;
  nativeTurnId?: string;
  receiptId?: string;
}>;

export type RuntimeUsageSnapshot = Readonly<{
  /** Token-counter meaning; lifecycle code must never infer another meaning. */
  semantics: "cumulative-session" | "request-context" | "remaining-context";
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}>;

export type RuntimeTurnFailure = Readonly<{
  /** Structured Provider-neutral error code, when the driver could extract one. */
  errorCode?: ProviderErrorCode;
  code: string;
  details?: string;
  lastOutput?: string;
  /** Exact Provider evidence that this error irrecoverably covers the Yui Run. */
  runTerminal?: boolean;
  /** Trusted structured Provider backoff hint; free-form text is never parsed. */
  retryAfterMs?: number;
}>;

export type RuntimeObservationPayload = Readonly<{
  alive?: boolean;
  reason?: AgentRuntimeWaitReason;
  waitId?: string;
  operationId?: string;
  operation?: AgentRuntimeOperation;
  activity?: "model" | "tool" | "subagent" | "provider" | "resource";
  activityId?: string;
  usage?: RuntimeUsageSnapshot;
  observerSource?: AgentRuntimeObserverSource;
  sourceId?: string;
  observerStatus?: "healthy" | "degraded" | "unavailable";
  observerDetail?: string;
  failure?: RuntimeTurnFailure;
  summary?: string;
  execution?: "active" | "quiescent" | "unknown";
  outcome?: "pending" | "succeeded" | "failed" | "cancelled" | "unknown";
  attachment?: "attached" | "detached";
  observationQuality?: "exact" | "partial" | "unavailable";
  mayWriteWorkspace?: boolean;
  resultRef?: string;
  reportId?: string;
  providerDeliveryRef?: string;
  snapshotComplete?: boolean;
  recoverability?: "unknown" | "recoverable" | "unrecoverable";
}>;

export type RuntimeObservation = Readonly<{
  schemaVersion: 2;
  eventId: string;
  semanticKey: string;
  kind: RuntimeObservationKind;
  authority: RuntimeObservationAuthority;
  receivedAt: string;
  observedAt?: string;
  sequence?: number;
  /** Deterministic order for multiple canonical facts derived from one ingress. */
  ordinal?: number;
  fence: RuntimeObservationFence;
  payload: RuntimeObservationPayload;
}>;

/**
 * Numeric usage and value-less partial request boundaries are both durable
 * token-projection evidence. The latter deliberately carries no activityId so
 * it cannot be mistaken for lifecycle progress.
 */
export function isRuntimeTokenEvidence(
  observation: Pick<RuntimeObservation, "kind" | "payload">
): boolean {
  return observation.kind === "activity.observed"
    && (observation.payload.usage !== undefined
      || (observation.payload.sourceId !== undefined
        && observation.payload.activityId === undefined
        && (observation.payload.observationQuality === "partial"
          || observation.payload.observationQuality === "unavailable")));
}

const KINDS: readonly RuntimeObservationKind[] = [
  "host.observed",
  "session.started",
  "session.ready",
  "session.ended",
  "session.failed",
  "conversation.observed",
  "activation.started",
  "activation.ended",
  "activation.failed",
  "turn.accepted",
  "turn.waiting",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "operation.started",
  "operation.completed",
  "operation.failed",
  "native-work.snapshot",
  "continuation.started",
  "continuation.reported",
  "continuation.settled",
  "input.accepted",
  "input.delivery-unknown",
  "activity.observed",
  "observer.health"
];

const AUTHORITIES: readonly RuntimeObservationAuthority[] = [
  "controller",
  "transport",
  "provider-structured",
  "driver-inferred",
  "host",
  "diagnostic"
];

const RUN_SCOPED: ReadonlySet<RuntimeObservationKind> = new Set([
  "turn.accepted",
  "turn.waiting",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "operation.started",
  "operation.completed",
  "operation.failed",
  "activity.observed",
  "observer.health"
]);

const CONTINUATION_SCOPED: ReadonlySet<RuntimeObservationKind> = new Set([
  "continuation.started",
  "continuation.reported",
  "continuation.settled"
]);

const PROVIDER_STATE: ReadonlySet<RuntimeObservationKind> = new Set([
  "session.started",
  "session.ready",
  "session.ended",
  "session.failed",
  "turn.accepted",
  "turn.waiting",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "operation.started",
  "operation.completed",
  "operation.failed"
]);

export function createRuntimeObservation(input: RuntimeObservation): RuntimeObservation {
  if (input.schemaVersion !== 2) throw new Error("Runtime observation schemaVersion must be 2.");
  if (!KINDS.includes(input.kind)) throw new Error("Runtime observation kind is invalid.");
  if (!AUTHORITIES.includes(input.authority)) throw new Error("Runtime observation authority is invalid.");
  if (input.kind === "host.observed" && input.authority !== "host" && input.authority !== "controller") {
    throw new Error("host.observed requires host or controller authority.");
  }
  if (PROVIDER_STATE.has(input.kind)
    && input.authority !== "provider-structured"
    && input.authority !== "controller") {
    throw new Error(`${input.kind} requires provider-structured or controller authority.`);
  }
  const fence = normalizeFence(input.fence);
  if (RUN_SCOPED.has(input.kind) && fence.runId === undefined) {
    throw new Error(`${input.kind} requires runId.`);
  }
  if (RUN_SCOPED.has(input.kind) && fence.nativeSessionId === undefined) {
    throw new Error(`${input.kind} requires nativeSessionId.`);
  }
  if (RUN_SCOPED.has(input.kind) && fence.nativeTurnId === undefined) {
    throw new Error(`${input.kind} requires nativeTurnId.`);
  }
  if ((input.kind.startsWith("activation.") || CONTINUATION_SCOPED.has(input.kind)
      || input.kind === "native-work.snapshot")
    && fence.activationId === undefined) {
    throw new Error(`${input.kind} requires activationId.`);
  }
  if ((input.kind === "conversation.observed" || input.kind.startsWith("activation.")
      || CONTINUATION_SCOPED.has(input.kind) || input.kind === "native-work.snapshot")
    && fence.conversationId === undefined) {
    throw new Error(`${input.kind} requires conversationId.`);
  }
  if (CONTINUATION_SCOPED.has(input.kind) && fence.continuationId === undefined) {
    throw new Error(`${input.kind} requires continuationId.`);
  }
  if (CONTINUATION_SCOPED.has(input.kind) && fence.continuationGeneration === undefined) {
    throw new Error(`${input.kind} requires continuationGeneration.`);
  }
  const payload = normalizePayload(input.kind, input.payload);
  const sequence = input.sequence;
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0)) {
    throw new Error("Runtime observation sequence must be a non-negative safe integer.");
  }
  const ordinal = input.ordinal;
  if (ordinal !== undefined && (!Number.isSafeInteger(ordinal) || ordinal < 0)) {
    throw new Error("Runtime observation ordinal must be a non-negative safe integer.");
  }
  return Object.freeze({
    schemaVersion: 2,
    eventId: requireIdentity(input.eventId, "Runtime observation event id"),
    semanticKey: requireIdentity(input.semanticKey, "Runtime observation semantic key"),
    kind: input.kind,
    authority: input.authority,
    receivedAt: requireTimestamp(input.receivedAt, "Runtime observation receivedAt"),
    ...(input.observedAt === undefined
      ? {}
      : { observedAt: requireTimestamp(input.observedAt, "Runtime observation observedAt") }),
    ...(sequence === undefined ? {} : { sequence }),
    ...(ordinal === undefined ? {} : { ordinal }),
    fence,
    payload
  });
}

export function runtimeObservationFenceMatches(
  expected: RuntimeObservationFence,
  actual: RuntimeObservationFence
): boolean {
  for (const field of [
    "taskId",
    "roleName",
    "runId",
    "agentId",
    "driverId",
    "launchId",
    "sessionGenerationId",
    "conversationId",
    "activationId",
    "continuationId",
    "continuationGeneration",
    "parentContinuationId",
    "nativeSessionId",
    "nativeTurnId",
    "receiptId"
  ] as const) {
    if (expected[field] !== actual[field]) return false;
  }
  return true;
}

/**
 * Matches observations that belong to one durable Run/session generation.
 * A provider may advance its native Turn while background subagents from an
 * earlier Turn are still active and later mailbox activations use their own
 * exactly-once receipt, so nativeTurnId and receiptId are intentionally
 * excluded. Exact acceptance still validates both fields before persistence.
 */
export function runtimeObservationRunFenceMatches(
  expected: RuntimeObservationFence,
  actual: RuntimeObservationFence
): boolean {
  for (const field of [
    "taskId",
    "roleName",
    "runId",
    "agentId",
    "driverId",
    "launchId",
    "sessionGenerationId",
    "nativeSessionId"
  ] as const) {
    if (expected[field] !== actual[field]) return false;
  }
  return true;
}

/** Compact TaskEvent payload used for durable state-boundary observations. */
export function runtimeObservationTaskEventPayload(
  input: RuntimeObservation
): Readonly<Record<string, string>> {
  const observation = createRuntimeObservation(input);
  return Object.freeze({
    eventId: observation.eventId,
    semanticKey: observation.semanticKey,
    roleName: observation.fence.roleName,
    agentId: observation.fence.agentId,
    driverId: observation.fence.driverId,
    launchId: observation.fence.launchId,
    ...(observation.fence.taskId === undefined ? {} : { taskId: observation.fence.taskId }),
    ...(observation.fence.runId === undefined ? {} : { runId: observation.fence.runId }),
    ...(observation.fence.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: observation.fence.nativeSessionId }),
    kind: observation.kind,
    receivedAt: observation.receivedAt,
    observation: JSON.stringify(observation)
  });
}

export function runtimeObservationFromTaskEvent(
  event: TaskEvent
): RuntimeObservation | null {
  if (event.type !== RUNTIME_OBSERVATION_TASK_EVENT) return null;
  try {
    const parsed: unknown = JSON.parse(event.payload.observation ?? "");
    return createRuntimeObservation(parsed as RuntimeObservation);
  } catch {
    return null;
  }
}

function normalizeFence(input: RuntimeObservationFence): RuntimeObservationFence {
  return Object.freeze({
    ...(input.taskId === undefined ? {} : { taskId: requireIdentity(input.taskId, "Task id") }),
    roleName: requireIdentity(input.roleName, "Role name"),
    ...(input.runId === undefined ? {} : { runId: requireIdentity(input.runId, "Run id") }),
    agentId: requireIdentity(input.agentId, "Agent id"),
    driverId: requireDriverId(input.driverId),
    launchId: requireIdentity(input.launchId, "Launch id"),
    sessionGenerationId: requireIdentity(input.sessionGenerationId, "Session generation id"),
    ...(input.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: requireIdentity(input.nativeSessionId, "Native Session id") }),
    ...(input.nativeTurnId === undefined
      ? {}
      : { nativeTurnId: requireIdentity(input.nativeTurnId, "Native Turn id") }),
    ...(input.receiptId === undefined
      ? {}
      : { receiptId: requireIdentity(input.receiptId, "Receipt id") }),
    ...(input.conversationId === undefined
      ? {}
      : { conversationId: requireIdentity(input.conversationId, "Provider Conversation id") }),
    ...(input.activationId === undefined
      ? {}
      : { activationId: requireIdentity(input.activationId, "Provider Activation id") }),
    ...(input.continuationId === undefined
      ? {}
      : { continuationId: requireIdentity(input.continuationId, "Provider Continuation id") }),
    ...(input.continuationGeneration === undefined
      ? {}
      : {
          continuationGeneration: requireNonNegativeInteger(
            input.continuationGeneration,
            1,
            "Provider Continuation generation"
          )
        }),
    ...(input.parentContinuationId === undefined
      ? {}
      : {
          parentContinuationId: requireIdentity(
            input.parentContinuationId,
            "Parent Provider Continuation id"
          )
        })
  });
}

function normalizePayload(
  kind: RuntimeObservationKind,
  input: RuntimeObservationPayload
): RuntimeObservationPayload {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Runtime observation payload must be an object.");
  }
  if (kind === "host.observed" && typeof input.alive !== "boolean") {
    throw new Error("host.observed requires payload.alive.");
  }
  if (kind === "turn.waiting"
    && input.reason !== "user"
    && input.reason !== "permission"
    && input.reason !== "external") {
    throw new Error("turn.waiting requires a supported reason.");
  }
  if (kind === "turn.waiting") requireIdentity(input.waitId, "Runtime wait id");
  if (kind.startsWith("operation.")) {
    requireIdentity(input.operationId, "Runtime operation id");
    if (input.operation !== "model" && input.operation !== "tool" && input.operation !== "subagent") {
      throw new Error("Runtime operation kind is invalid.");
    }
  }
  if (kind === "activity.observed") {
    if (!["model", "tool", "subagent", "provider", "resource"].includes(input.activity ?? "")) {
      throw new Error("activity.observed requires an activity kind.");
    }
    if (input.usage !== undefined) {
      const usage = input.usage as RuntimeUsageSnapshot & { semantics?: RuntimeUsageSnapshot["semantics"] };
      validateUsage(usage.semantics === undefined
        ? { ...usage, semantics: "cumulative-session" }
        : usage);
    }
  }
  if (kind === "observer.health") {
    requireIdentity(input.sourceId, "Runtime observer source id");
    if (!['healthy', 'degraded', 'unavailable'].includes(input.observerStatus ?? "")) {
      throw new Error("observer.health requires a supported status.");
    }
  }
  const observerSource = input.observerSource === undefined
    ? undefined
    : normalizeObserverSource(input.observerSource);
  if (kind === "turn.failed" && input.failure === undefined) {
    throw new Error("turn.failed requires normalized failure evidence.");
  }
  if (kind === "conversation.observed"
    && !["unknown", "recoverable", "unrecoverable"].includes(input.recoverability ?? "")) {
    throw new Error("conversation.observed requires recoverability.");
  }
  if (kind === "native-work.snapshot") {
    if (typeof input.snapshotComplete !== "boolean"
      || !["exact", "partial", "unavailable"].includes(input.observationQuality ?? "")) {
      throw new Error("native-work.snapshot requires completeness and observation quality.");
    }
    if (input.snapshotComplete && input.observationQuality !== "exact") {
      throw new Error("A complete native-work.snapshot requires exact observation quality.");
    }
  }
  if (kind.startsWith("continuation.")) {
    if (!["active", "quiescent", "unknown"].includes(input.execution ?? "")) {
      throw new Error(`${kind} requires continuation execution.`);
    }
    if (!["pending", "succeeded", "failed", "cancelled", "unknown"].includes(
      input.outcome ?? ""
    )) {
      throw new Error(`${kind} requires continuation outcome.`);
    }
    if (input.attachment !== "attached" && input.attachment !== "detached") {
      throw new Error(`${kind} requires continuation attachment.`);
    }
    if (!["exact", "partial", "unavailable"].includes(input.observationQuality ?? "")) {
      throw new Error(`${kind} requires continuation observation quality.`);
    }
    if (typeof input.mayWriteWorkspace !== "boolean") {
      throw new Error(`${kind} requires mayWriteWorkspace.`);
    }
    if (kind === "continuation.reported") requireIdentity(input.reportId, "Provider report id");
    if (kind === "continuation.settled" && input.observationQuality !== "exact") {
      throw new Error("continuation.settled requires exact observation quality.");
    }
  }
  const failure = input.failure === undefined
    ? undefined
    : normalizeFailure(input.failure);
  return Object.freeze({
    ...(input.alive === undefined ? {} : { alive: input.alive }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.waitId === undefined ? {} : { waitId: requireIdentity(input.waitId, "Runtime wait id") }),
    ...(input.operationId === undefined
      ? {}
      : { operationId: requireIdentity(input.operationId, "Runtime operation id") }),
    ...(input.operation === undefined ? {} : { operation: input.operation }),
    ...(input.activity === undefined ? {} : { activity: input.activity }),
    ...(input.activityId === undefined
      ? {}
      : { activityId: requireIdentity(input.activityId, "Runtime activity id") }),
    ...(input.usage === undefined
      ? {}
      : { usage: Object.freeze({
          ...input.usage,
          semantics: input.usage.semantics ?? "cumulative-session"
        }) }),
    ...(observerSource === undefined ? {} : { observerSource }),
    ...(input.sourceId === undefined
      ? {}
      : { sourceId: requireIdentity(input.sourceId, "Runtime observer source id") }),
    ...(input.observerStatus === undefined ? {} : { observerStatus: input.observerStatus }),
    ...(input.observerDetail === undefined
      ? {}
      : { observerDetail: requireText(input.observerDetail, "Runtime observer detail") }),
    ...(failure === undefined ? {} : { failure }),
    ...(input.summary === undefined ? {} : { summary: requireText(input.summary, "Runtime summary") }),
    ...(input.execution === undefined ? {} : { execution: input.execution }),
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    ...(input.attachment === undefined ? {} : { attachment: input.attachment }),
    ...(input.observationQuality === undefined
      ? {}
      : { observationQuality: input.observationQuality }),
    ...(input.mayWriteWorkspace === undefined
      ? {}
      : { mayWriteWorkspace: input.mayWriteWorkspace }),
    ...(input.resultRef === undefined
      ? {}
      : { resultRef: requireIdentity(input.resultRef, "Provider result ref") }),
    ...(input.reportId === undefined
      ? {}
      : { reportId: requireIdentity(input.reportId, "Provider report id") }),
    ...(input.providerDeliveryRef === undefined
      ? {}
      : {
          providerDeliveryRef: requireIdentity(
            input.providerDeliveryRef,
            "Provider delivery ref"
          )
        }),
    ...(input.snapshotComplete === undefined
      ? {}
      : { snapshotComplete: input.snapshotComplete }),
    ...(input.recoverability === undefined
      ? {}
      : { recoverability: input.recoverability })
  });
}

export function runtimeObservationSemanticKey(input: Readonly<{
  eventId: string;
  kind: RuntimeObservationKind;
  fence: RuntimeObservationFence;
  sequence?: number;
  payload?: RuntimeObservationPayload;
}>): string {
  const fence = input.fence;
  const continuationIdentity = [
    fence.driverId,
    fence.agentId,
    fence.conversationId ?? fence.nativeSessionId ?? fence.launchId,
    fence.activationId ?? fence.launchId,
    fence.continuationId ?? "none",
    fence.continuationGeneration ?? "none"
  ];
  // Terminal boundaries are semantic facts. Providers may replay them with a
  // fresh transport sequence after reconnect, so terminal identity must win
  // over occurrence ordering or one SessionEnd storm becomes many facts.
  if (["session.ended", "session.failed", "activation.ended", "activation.failed",
    "turn.completed", "turn.failed", "turn.cancelled", "continuation.settled"].includes(input.kind)) {
    return [
      "terminal",
      ...continuationIdentity,
      fence.continuationId ?? fence.nativeTurnId ?? "none",
      input.kind,
      input.payload?.outcome ?? input.payload?.failure?.code ?? "terminal",
      input.kind === "continuation.settled" ? input.payload?.resultRef ?? "none" : "none",
      input.kind === "turn.failed" && input.payload?.failure?.runTerminal === true
        ? "run-terminal"
        : "turn-terminal"
    ].join(":");
  }
  if (input.kind === "continuation.reported") {
    const summary = input.payload?.summary?.trim();
    const resultIdentity = summary === undefined || summary.length === 0
      ? input.payload?.reportId ?? "missing"
      : `sha256:${createHash("sha256").update(summary).digest("hex")}`;
    return ["continuation-report", ...continuationIdentity, resultIdentity]
      .join(":");
  }
  if (input.kind === "continuation.started") {
    return [
      "continuation-state",
      ...continuationIdentity,
      input.payload?.execution ?? "unknown",
      input.payload?.attachment ?? "unknown",
      input.payload?.observationQuality ?? "unknown",
      input.payload?.mayWriteWorkspace === true ? "writer" : "read-only",
      input.payload?.outcome ?? "unknown",
      input.payload?.resultRef ?? "none"
    ].join(":");
  }
  if (input.sequence !== undefined) {
    return [
      "provider-sequence",
      fence.driverId,
      fence.conversationId ?? fence.nativeSessionId ?? fence.launchId,
      fence.activationId ?? fence.launchId,
      fence.continuationId ?? fence.nativeTurnId ?? "none",
      fence.continuationGeneration ?? "none",
      input.sequence,
      input.kind
    ].join(":");
  }
  return `provider-event:${requireIdentity(input.eventId, "Runtime observation event id")}`;
}

function normalizeObserverSource(input: AgentRuntimeObserverSource): AgentRuntimeObserverSource {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Runtime observer source must be an object.");
  }
  if (input.schemaVersion !== 1 || input.transport !== "append-only-jsonl") {
    throw new Error("Runtime observer source is invalid.");
  }
  return Object.freeze({
    schemaVersion: 1,
    sourceId: requireIdentity(input.sourceId, "Runtime observer source id"),
    transport: "append-only-jsonl",
    locator: requireText(input.locator, "Runtime observer locator")
  });
}

function normalizeFailure(input: RuntimeTurnFailure): RuntimeTurnFailure {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Runtime failure evidence must be an object.");
  }
  return Object.freeze({
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    code: requireText(input.code, "Runtime failure code"),
    ...(input.details === undefined
      ? {}
      : { details: requireText(input.details, "Runtime failure details") }),
    ...(input.lastOutput === undefined
      ? {}
      : { lastOutput: requireText(input.lastOutput, "Runtime failure last output") }),
    ...(input.runTerminal === undefined
      ? {}
      : { runTerminal: requireBoolean(input.runTerminal, "Runtime failure runTerminal") }),
    ...(input.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: requirePositiveMilliseconds(input.retryAfterMs) })
  });
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}

function requirePositiveMilliseconds(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Runtime failure retryAfterMs must be a positive safe integer.");
  }
  return value;
}

function validateUsage(input: RuntimeUsageSnapshot): void {
  if (!["cumulative-session", "request-context", "remaining-context"].includes(
    input.semantics
  )) {
    throw new Error("Runtime usage semantics are invalid.");
  }
  for (const [name, value] of Object.entries(input).filter(([name]) => name !== "semantics")) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Runtime usage ${name} must be a non-negative safe integer.`);
    }
  }
  if (input.inputTokens === undefined || input.outputTokens === undefined) {
    throw new Error("Runtime usage requires inputTokens and outputTokens.");
  }
}

function requireTimestamp(value: string, label: string): string {
  const timestamp = requireText(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} is invalid.`);
  return timestamp;
}

function requireNonNegativeInteger(value: number, minimum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} is invalid.`);
  return value;
}

function requireIdentity(value: unknown, label: string): string {
  const identity = requireText(value, label);
  if (identity.includes("/../") || identity === "__proto__") throw new Error(`${label} is invalid.`);
  return identity;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 32 * 1024) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}
