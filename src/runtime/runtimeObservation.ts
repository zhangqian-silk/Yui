import type {
  AgentRuntimeObserverSource,
  AgentRuntimeOperation,
  AgentRuntimeWaitReason
} from "./agentDriver.js";
import { requireDriverId } from "./agentDriver.js";
import type { TaskEvent } from "../event/taskEvent.js";

export const RUNTIME_OBSERVATION_TASK_EVENT = "runtime.observation";

export type RuntimeObservationKind =
  | "host.observed"
  | "session.started"
  | "session.ready"
  | "session.ended"
  | "session.failed"
  | "turn.accepted"
  | "turn.waiting"
  | "turn.completed"
  | "turn.failed"
  | "turn.cancelled"
  | "operation.started"
  | "operation.completed"
  | "operation.failed"
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
  nativeSessionId?: string;
  nativeTurnId?: string;
  receiptId?: string;
}>;

export type RuntimeUsageSnapshot = Readonly<{
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}>;

export type RuntimeTurnFailure = Readonly<{
  code: string;
  details?: string;
  lastOutput?: string;
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
}>;

export type RuntimeObservation = Readonly<{
  schemaVersion: 1;
  eventId: string;
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

const KINDS: readonly RuntimeObservationKind[] = [
  "host.observed",
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
  "operation.failed",
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
  if (input.schemaVersion !== 1) throw new Error("Runtime observation schemaVersion must be 1.");
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
    schemaVersion: 1,
    eventId: requireIdentity(input.eventId, "Runtime observation event id"),
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
    "nativeSessionId",
    "nativeTurnId",
    "receiptId"
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
      : { receiptId: requireIdentity(input.receiptId, "Receipt id") })
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
    if (input.usage !== undefined) validateUsage(input.usage);
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
    ...(input.usage === undefined ? {} : { usage: Object.freeze({ ...input.usage }) }),
    ...(observerSource === undefined ? {} : { observerSource }),
    ...(input.sourceId === undefined
      ? {}
      : { sourceId: requireIdentity(input.sourceId, "Runtime observer source id") }),
    ...(input.observerStatus === undefined ? {} : { observerStatus: input.observerStatus }),
    ...(input.observerDetail === undefined
      ? {}
      : { observerDetail: requireText(input.observerDetail, "Runtime observer detail") }),
    ...(failure === undefined ? {} : { failure }),
    ...(input.summary === undefined ? {} : { summary: requireText(input.summary, "Runtime summary") })
  });
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
    code: requireText(input.code, "Runtime failure code"),
    ...(input.details === undefined
      ? {}
      : { details: requireText(input.details, "Runtime failure details") }),
    ...(input.lastOutput === undefined
      ? {}
      : { lastOutput: requireText(input.lastOutput, "Runtime failure last output") })
  });
}

function validateUsage(input: RuntimeUsageSnapshot): void {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 0) {
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
