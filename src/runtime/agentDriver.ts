import type {
  RuntimeObservationKind,
  RuntimeObservationPayload,
  RuntimeUsageSnapshot
} from "./runtimeObservation.js";

export type AgentDriverSurface = "managed-protocol" | "interactive-cli";
export type AgentRuntimeOperation = "model" | "tool" | "subagent";
export type AgentRuntimeWaitReason = "user" | "permission" | "external";
export type AgentRuntimeUsageMode =
  | "streaming-cumulative"
  | "event-snapshot"
  | "terminal-cumulative"
  | "unavailable";
export type AgentRuntimeDeliveryMode =
  | "ordered-replayable"
  | "ordered-best-effort"
  | "best-effort"
  | "host-only";
export type AgentRuntimeEvidenceQuality = "exact" | "partial" | "unavailable";
export type AgentHostLifecycle = "persistent";
export type ProviderProcessLifecycle = "persistent" | "per-turn";
export type NativeConversationResume = "exact" | "unsupported";
export type NativeCompactionCapability =
  | "automatic"
  | "native-explicit"
  | "unsupported"
  | "unknown";
export type NativeCompactionEvents = "exact" | "unavailable";
export type ContextUsageSemantics =
  | "per-request"
  | "remaining-context"
  | "cumulative-only"
  | "unavailable";
export type DeliveryDeduplication = "exact" | "unsupported";

export type AgentDriverCapabilities = Readonly<{
  surfaces: readonly AgentDriverSurface[];
  /**
   * Native-lifecycle facts used by recovery admission. These capabilities are
   * deliberately independent from transcript usage: cumulative token counters
   * can never prove that a native Session needs replacement.
   */
  lifecycle: Readonly<{
    host: AgentHostLifecycle;
    providerProcess: ProviderProcessLifecycle;
    nativeConversationResume: NativeConversationResume;
    compaction: NativeCompactionCapability;
    compactionEvents: NativeCompactionEvents;
    contextUsage: ContextUsageSemantics;
    inSessionContinuation: boolean;
    deliveryDeduplication: DeliveryDeduplication;
  }>;
  control: Readonly<{
    start: boolean;
    resume: boolean;
    sendTurn: boolean;
    interrupt: boolean;
    stop: boolean;
  }>;
  conversation: Readonly<{
    persistentIdentity: AgentRuntimeEvidenceQuality;
    crossProcessResume: boolean;
    readback: AgentRuntimeEvidenceQuality;
  }>;
  input: Readonly<{
    startTurn: boolean;
    steer: "fenced" | "unavailable";
    inject: "fenced" | "unavailable";
    acceptance: "exact" | "unavailable";
    idempotency: "exact" | "unavailable";
  }>;
  descendants: Readonly<{
    lineage: AgentRuntimeEvidenceQuality;
    detachedQuery: AgentRuntimeEvidenceQuality;
    resultRouting: AgentRuntimeEvidenceQuality;
  }>;
  bounded: Readonly<{
    structuredTerminal: boolean;
  }>;
  observation: Readonly<{
    sessionIdentity: "exact" | "unavailable";
    sessionBootstrap: "preallocated" | "discovered";
    preInputReadiness: "exact" | "unavailable";
    promptAcceptance: "exact" | "unavailable";
    turnLifecycle: "exact" | "partial" | "unavailable";
    operations: readonly AgentRuntimeOperation[];
    waiting: readonly AgentRuntimeWaitReason[];
    usage: AgentRuntimeUsageMode;
    delivery: AgentRuntimeDeliveryMode;
  }>;
}>;

/**
 * Provider-independent descriptor exchanged at the Agent Driver boundary.
 * `id` is intentionally open and namespaced: adding a Driver must not require a
 * Yui-core union change.
 */
export type AgentDriverDescriptor = Readonly<{
  id: string;
  label: string;
  protocolVersion: 1;
  capabilities: AgentDriverCapabilities;
}>;

export type AgentDriverNativeHook = Readonly<{
  hookEventName: string;
  payload: Readonly<Record<string, unknown>>;
  /** One ingress occurrence; used only when the provider exposes no native id. */
  occurrenceId?: string;
}>;

export type AgentRuntimeObserverSource = Readonly<{
  schemaVersion: 1;
  sourceId: string;
  transport: "append-only-jsonl";
  locator: string;
}>;

export type AgentRuntimeObserverCursor = Readonly<Record<string, unknown>>;

export type AgentRuntimeObserverSample = Readonly<{
  cursor: AgentRuntimeObserverCursor;
  status: "healthy" | "degraded" | "unavailable";
  detail?: string;
  usage?: RuntimeUsageSnapshot;
  activity?: "model" | "tool" | "subagent" | "provider" | "resource";
  activityId?: string;
}>;

export type AgentDriverMappedHook = Readonly<{
  kind: RuntimeObservationKind;
  payload: RuntimeObservationPayload;
  fence?: Readonly<{
    continuationId?: string;
    continuationGeneration?: number;
    parentContinuationId?: string;
  }>;
}>;

export type AgentDriverHookClassification = Readonly<{
  /** How a first Session Hook may establish identity before projection exists. */
  startupSession?: "preallocated" | "discovered";
  /** Terminal Hooks remain admissible after the exact Run has yielded. */
  terminal?: boolean;
  /** Existing native child identity that can recover its original Run fence. */
  continuationId?: string;
  continuationGeneration?: number;
}>;

/**
 * Executable runtime-observation plug-in. Native event names, provider payload
 * shapes and transcript formats terminate behind this boundary.
 */
export type AgentDriver = AgentDriverDescriptor & Readonly<{
  /** Existing launch/control adapter bridged to this observation Driver. */
  adapterId: string;
  runtime: Readonly<{
    /** Resolve the provider's stable Session identity at the Driver edge. */
    nativeSessionId(input: AgentDriverNativeHook): string | undefined;
    /** Resolve the provider's stable Turn identity without leaking its field names into core. */
    nativeTurnId(input: AgentDriverNativeHook): string | undefined;
    mapHook(input: AgentDriverNativeHook): AgentDriverMappedHook | readonly AgentDriverMappedHook[];
    classifyHook(input: AgentDriverNativeHook): AgentDriverHookClassification;
    /** Optional independent observation source, sampled outside the Hook path. */
    observer?: Readonly<{
      source(input: AgentDriverNativeHook): AgentRuntimeObserverSource | null;
      sample(
        source: AgentRuntimeObserverSource,
        cursor?: AgentRuntimeObserverCursor
      ): Promise<AgentRuntimeObserverSample>;
    }>;
  }>;
}>;

export type ManagedRuntimeAdmission =
  | Readonly<{ admitted: true }>
  | Readonly<{ admitted: false; missing: readonly string[] }>;

const SURFACES: readonly AgentDriverSurface[] = ["managed-protocol", "interactive-cli"];
const OPERATIONS: readonly AgentRuntimeOperation[] = ["model", "tool", "subagent"];
const WAIT_REASONS: readonly AgentRuntimeWaitReason[] = ["user", "permission", "external"];
const USAGE_MODES: readonly AgentRuntimeUsageMode[] = [
  "streaming-cumulative",
  "event-snapshot",
  "terminal-cumulative",
  "unavailable"
];
const DELIVERY_MODES: readonly AgentRuntimeDeliveryMode[] = [
  "ordered-replayable",
  "ordered-best-effort",
  "best-effort",
  "host-only"
];

function requireCapabilityObject(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Agent Driver ${label} capabilities must be an object.`);
  }
  return value as Record<string, unknown>;
}

function evidenceQuality(value: unknown, label: string): AgentRuntimeEvidenceQuality {
  if (value !== "exact" && value !== "partial" && value !== "unavailable") {
    throw new Error(`${label} capability is invalid.`);
  }
  return value;
}

export function validateAgentDriverCapabilities(
  input: AgentDriverCapabilities
): AgentDriverCapabilities {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Agent Driver capabilities must be an object.");
  }
  const surfaces = uniqueMembers(input.surfaces, SURFACES, "Agent Driver surface");
  if (surfaces.length === 0) throw new Error("Agent Driver must expose at least one surface.");
  const control = input.control;
  if (control === null || typeof control !== "object" || Array.isArray(control)) {
    throw new Error("Agent Driver control capabilities must be an object.");
  }
  for (const name of ["start", "resume", "sendTurn", "interrupt", "stop"] as const) {
    if (typeof control[name] !== "boolean") {
      throw new Error(`Agent Driver control capability ${name} must be boolean.`);
    }
  }
  const lifecycle = input.lifecycle;
  if (lifecycle === null || typeof lifecycle !== "object" || Array.isArray(lifecycle)) {
    throw new Error("Agent Driver lifecycle capabilities must be an object.");
  }
  if (lifecycle.host !== "persistent") {
    throw new Error("Managed Agent Host lifecycle must be persistent.");
  }
  if (lifecycle.providerProcess !== "persistent" && lifecycle.providerProcess !== "per-turn") {
    throw new Error("Provider process lifecycle capability is invalid.");
  }
  if (lifecycle.nativeConversationResume !== "exact"
    && lifecycle.nativeConversationResume !== "unsupported") {
    throw new Error("Native conversation resume capability is invalid.");
  }
  if (!["automatic", "native-explicit", "unsupported", "unknown"].includes(
    lifecycle.compaction
  )) {
    throw new Error("Native compaction capability is invalid.");
  }
  if (lifecycle.compactionEvents !== "exact" && lifecycle.compactionEvents !== "unavailable") {
    throw new Error("Native compaction event capability is invalid.");
  }
  if (!["per-request", "remaining-context", "cumulative-only", "unavailable"].includes(
    lifecycle.contextUsage
  )) {
    throw new Error("Context usage capability is invalid.");
  }
  if (typeof lifecycle.inSessionContinuation !== "boolean") {
    throw new Error("In-Session continuation capability must be boolean.");
  }
  if (lifecycle.deliveryDeduplication !== "exact"
    && lifecycle.deliveryDeduplication !== "unsupported") {
    throw new Error("Delivery deduplication capability is invalid.");
  }
  const observation = input.observation;
  if (observation === null || typeof observation !== "object" || Array.isArray(observation)) {
    throw new Error("Agent Driver observation capabilities must be an object.");
  }
  if (observation.sessionIdentity !== "exact" && observation.sessionIdentity !== "unavailable") {
    throw new Error("Agent Driver session identity capability is invalid.");
  }
  if (observation.sessionBootstrap !== "preallocated"
    && observation.sessionBootstrap !== "discovered") {
    throw new Error("Agent Driver Session bootstrap capability is invalid.");
  }
  if (observation.preInputReadiness !== "exact"
    && observation.preInputReadiness !== "unavailable") {
    throw new Error("Agent Driver pre-input readiness capability is invalid.");
  }
  if (observation.promptAcceptance !== "exact" && observation.promptAcceptance !== "unavailable") {
    throw new Error("Agent Driver prompt acceptance capability is invalid.");
  }
  if (!["exact", "partial", "unavailable"].includes(observation.turnLifecycle)) {
    throw new Error("Agent Driver turn lifecycle capability is invalid.");
  }
  if (!USAGE_MODES.includes(observation.usage)) {
    throw new Error("Agent Driver usage capability is invalid.");
  }
  if (!DELIVERY_MODES.includes(observation.delivery)) {
    throw new Error("Agent Driver delivery capability is invalid.");
  }
  const conversation = requireCapabilityObject(input.conversation, "conversation");
  evidenceQuality(conversation.persistentIdentity, "Provider Conversation identity");
  evidenceQuality(conversation.readback, "Provider Conversation readback");
  if (typeof conversation.crossProcessResume !== "boolean") {
    throw new Error("Agent Driver Conversation resume capability must be boolean.");
  }
  const inputRouting = requireCapabilityObject(input.input, "input");
  if (typeof inputRouting.startTurn !== "boolean"
    || !["fenced", "unavailable"].includes(String(inputRouting.steer))
    || !["fenced", "unavailable"].includes(String(inputRouting.inject))
    || !["exact", "unavailable"].includes(String(inputRouting.acceptance))
    || !["exact", "unavailable"].includes(String(inputRouting.idempotency))) {
    throw new Error("Agent Driver input routing capabilities are invalid.");
  }
  const descendants = requireCapabilityObject(input.descendants, "descendants");
  evidenceQuality(descendants.lineage, "Provider descendant lineage");
  evidenceQuality(descendants.detachedQuery, "Provider detached descendant query");
  evidenceQuality(descendants.resultRouting, "Provider descendant result routing");
  const bounded = requireCapabilityObject(input.bounded, "bounded");
  if (typeof bounded.structuredTerminal !== "boolean") {
    throw new Error("Agent Driver bounded terminal capability must be boolean.");
  }
  return Object.freeze({
    surfaces: Object.freeze(surfaces),
    lifecycle: Object.freeze({
      host: lifecycle.host,
      providerProcess: lifecycle.providerProcess,
      nativeConversationResume: lifecycle.nativeConversationResume,
      compaction: lifecycle.compaction,
      compactionEvents: lifecycle.compactionEvents,
      contextUsage: lifecycle.contextUsage,
      inSessionContinuation: lifecycle.inSessionContinuation,
      deliveryDeduplication: lifecycle.deliveryDeduplication
    }),
    control: Object.freeze({
      start: control.start,
      resume: control.resume,
      sendTurn: control.sendTurn,
      interrupt: control.interrupt,
      stop: control.stop
    }),
    conversation: Object.freeze({
      persistentIdentity: conversation.persistentIdentity as AgentRuntimeEvidenceQuality,
      crossProcessResume: conversation.crossProcessResume as boolean,
      readback: conversation.readback as AgentRuntimeEvidenceQuality
    }),
    input: Object.freeze({
      startTurn: inputRouting.startTurn as boolean,
      steer: inputRouting.steer as "fenced" | "unavailable",
      inject: inputRouting.inject as "fenced" | "unavailable",
      acceptance: inputRouting.acceptance as "exact" | "unavailable",
      idempotency: inputRouting.idempotency as "exact" | "unavailable"
    }),
    descendants: Object.freeze({
      lineage: descendants.lineage as AgentRuntimeEvidenceQuality,
      detachedQuery: descendants.detachedQuery as AgentRuntimeEvidenceQuality,
      resultRouting: descendants.resultRouting as AgentRuntimeEvidenceQuality
    }),
    bounded: Object.freeze({ structuredTerminal: bounded.structuredTerminal as boolean }),
    observation: Object.freeze({
      sessionIdentity: observation.sessionIdentity,
      sessionBootstrap: observation.sessionBootstrap,
      preInputReadiness: observation.preInputReadiness,
      promptAcceptance: observation.promptAcceptance,
      turnLifecycle: observation.turnLifecycle,
      operations: Object.freeze(uniqueMembers(
        observation.operations,
        OPERATIONS,
        "Agent Driver operation"
      )),
      waiting: Object.freeze(uniqueMembers(
        observation.waiting,
        WAIT_REASONS,
        "Agent Driver wait reason"
      )),
      usage: observation.usage,
      delivery: observation.delivery
    })
  });
}

export function managedRuntimeAdmission(
  capabilities: AgentDriverCapabilities
): ManagedRuntimeAdmission {
  const actual = validateAgentDriverCapabilities(capabilities);
  const missing: string[] = [];
  if (!actual.control.start) missing.push("start");
  if (!actual.control.resume || !actual.conversation.crossProcessResume) missing.push("resume");
  if (!actual.control.sendTurn || !actual.input.startTurn) missing.push("send-turn");
  if (!actual.control.interrupt) missing.push("interrupt");
  if (!actual.control.stop) missing.push("stop");
  if (actual.observation.sessionIdentity !== "exact"
    || actual.conversation.persistentIdentity !== "exact") missing.push("exact-session-identity");
  if (actual.observation.promptAcceptance !== "exact"
    || actual.input.acceptance !== "exact") missing.push("exact-prompt-acceptance");
  if (actual.lifecycle.host !== "persistent") missing.push("persistent-agent-host");
  if (actual.lifecycle.nativeConversationResume !== "exact") {
    missing.push("exact-native-conversation-resume");
  }
  if (!actual.lifecycle.inSessionContinuation) missing.push("in-session-continuation");
  if (actual.observation.turnLifecycle !== "exact") missing.push("exact-turn-lifecycle");
  return missing.length === 0
    ? Object.freeze({ admitted: true })
    : Object.freeze({ admitted: false, missing: Object.freeze(missing) });
}

export function boundedRuntimeAdmission(
  capabilities: AgentDriverCapabilities
): ManagedRuntimeAdmission {
  const actual = validateAgentDriverCapabilities(capabilities);
  const missing: string[] = [];
  if (!actual.control.start) missing.push("start");
  if (!actual.bounded.structuredTerminal) missing.push("structured-terminal");
  return missing.length === 0
    ? Object.freeze({ admitted: true })
    : Object.freeze({ admitted: false, missing: Object.freeze(missing) });
}

export class AgentDriverRegistry {
  readonly #drivers = new Map<string, AgentDriver>();
  readonly #driverIdsByAdapter = new Map<string, string>();

  register(input: AgentDriver): AgentDriver {
    const id = requireDriverId(input.id);
    if (this.#drivers.has(id)) throw new Error(`Agent Driver is already registered: ${id}.`);
    const adapterId = requireAdapterId(input.adapterId);
    const existingDriverId = this.#driverIdsByAdapter.get(adapterId);
    if (existingDriverId !== undefined) {
      throw new Error(
        `Agent adapter ${adapterId} is already owned by Driver ${existingDriverId}.`
      );
    }
    if (input.protocolVersion !== 1) {
      throw new Error(`Agent Driver protocol version is unsupported: ${String(input.protocolVersion)}.`);
    }
    if (input.runtime === null || typeof input.runtime !== "object") {
      throw new Error("Agent Driver runtime must be an object.");
    }
    if (typeof input.runtime.nativeSessionId !== "function"
      || typeof input.runtime.nativeTurnId !== "function"
      || typeof input.runtime.mapHook !== "function"
      || typeof input.runtime.classifyHook !== "function"
      || (input.runtime.observer !== undefined
        && (typeof input.runtime.observer.source !== "function"
          || typeof input.runtime.observer.sample !== "function"))) {
      throw new Error("Agent Driver runtime observation functions are invalid.");
    }
    const driver = Object.freeze({
      id,
      label: requireText(input.label, "Agent Driver label"),
      protocolVersion: 1 as const,
      adapterId,
      capabilities: validateAgentDriverCapabilities(input.capabilities),
      runtime: Object.freeze({
        nativeSessionId: input.runtime.nativeSessionId,
        nativeTurnId: input.runtime.nativeTurnId,
        mapHook: input.runtime.mapHook,
        classifyHook: input.runtime.classifyHook,
        ...(input.runtime.observer === undefined
          ? {}
          : { observer: Object.freeze({
              source: input.runtime.observer.source,
              sample: input.runtime.observer.sample
            }) })
      })
    });
    this.#drivers.set(id, driver);
    this.#driverIdsByAdapter.set(adapterId, id);
    return driver;
  }

  find(id: string): AgentDriver | null {
    return this.#drivers.get(id) ?? null;
  }

  require(id: string): AgentDriver {
    const driver = this.find(id);
    if (driver === null) throw new Error(`Agent Driver is not registered: ${id}.`);
    return driver;
  }

  findByAdapterId(adapterId: string): AgentDriver | null {
    const driverId = this.#driverIdsByAdapter.get(adapterId);
    return driverId === undefined ? null : this.require(driverId);
  }

  requireByAdapterId(adapterId: string): AgentDriver {
    const driver = this.findByAdapterId(adapterId);
    if (driver === null) {
      throw new Error(`Agent Driver is not registered for adapter: ${adapterId}.`);
    }
    return driver;
  }

  list(): readonly AgentDriver[] {
    return [...this.#drivers.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}

export function requireDriverId(value: string): string {
  const id = requireText(value, "Agent Driver id");
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u.test(id)) {
    throw new Error("Agent Driver id must be a lowercase namespaced identity.");
  }
  return id;
}

export function normalizeAgentDriverHookClassification(
  input: AgentDriverHookClassification
): Required<Pick<AgentDriverHookClassification, "terminal">>
  & Pick<AgentDriverHookClassification,
    "startupSession" | "continuationId" | "continuationGeneration"> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Agent Driver Hook classification must be an object.");
  }
  if (input.startupSession !== undefined
    && input.startupSession !== "preallocated"
    && input.startupSession !== "discovered") {
    throw new Error("Agent Driver Hook startup Session classification is invalid.");
  }
  if (input.terminal !== undefined && typeof input.terminal !== "boolean") {
    throw new Error("Agent Driver Hook terminal classification is invalid.");
  }
  if (input.continuationId !== undefined) {
    requireText(input.continuationId, "Agent Driver Hook continuation id");
    if (!Number.isSafeInteger(input.continuationGeneration)
      || input.continuationGeneration! < 1) {
      throw new Error("Agent Driver Hook continuation generation is invalid.");
    }
  } else if (input.continuationGeneration !== undefined) {
    throw new Error("Agent Driver Hook continuation generation requires an id.");
  }
  return Object.freeze({
    ...(input.startupSession === undefined ? {} : { startupSession: input.startupSession }),
    ...(input.continuationId === undefined ? {} : {
      continuationId: input.continuationId,
      continuationGeneration: input.continuationGeneration
    }),
    terminal: input.terminal ?? false
  });
}

function uniqueMembers<T extends string>(
  input: readonly T[],
  supported: readonly T[],
  label: string
): T[] {
  if (!Array.isArray(input)) throw new Error(`${label}s must be an array.`);
  const result: T[] = [];
  for (const value of input) {
    if (!supported.includes(value)) throw new Error(`${label} is invalid: ${String(value)}.`);
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 1_024) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requireAdapterId(value: string): string {
  const id = requireText(value, "Agent adapter id");
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
    throw new Error("Agent adapter id must be a lowercase identity.");
  }
  return id;
}
