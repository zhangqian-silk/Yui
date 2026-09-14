/**
 * What a live Agent Session can be asked about the run configuration it is
 * actually operating under.
 *
 * Yui already records what a launch *requested*: a Role's model, reasoning
 * effort and permission strategy resolve into an effective launch snapshot that
 * every `show` surface prints. That snapshot is an expectation, and it is
 * complete on its own terms. What it cannot answer is whether the Agent agreed:
 * a requested model the Agent does not offer, a permission mode it silently
 * substituted, or an axis it reset when a later call landed are all invisible to
 * a record written before the process started.
 *
 * This is the read path for that second question, and it is deliberately
 * separate from the first. Presenting configuration expectation as execution
 * fact is the specific failure this vocabulary exists to prevent, so every
 * value here carries how it was learned, and the three ways of not knowing stay
 * distinct instead of collapsing into one blank:
 *
 * - `unknown` means nobody could be asked. There is no live Session, or the
 *   Session exists but could not be reached. It says nothing about the Agent.
 * - `unsupported` means this Session implementation has no observation reader.
 *   It does not claim the underlying product can never report these facts.
 * - `observed` carries what the Agent itself reported, and only that.
 *
 * Nothing here performs I/O or holds a product name. A Session that can answer
 * projects its own protocol's report into this shape; a Session that cannot
 * returns the `unsupported` branch. Reading it never sends a protocol message,
 * because a query that configured or prompted the Agent would change the thing
 * it claims to describe.
 */

import type { AgentHandshakeObservation } from "../executor/agentConfigurationCatalog.js";

/**
 * The configurable axes Yui itself names, shared with Role and Profile
 * configuration so one word means one thing across expectation and observation.
 */
export type AgentRunConfigurationField = "model" | "effort" | "permission";

/**
 * One axis the Agent reports as configurable, projected off any single protocol.
 *
 * `offered` is the Agent's own complete enumeration for the axis. It is what
 * makes a rejected request explainable in the Agent's terms instead of as
 * advice, and it is empty only when the Agent enumerated nothing.
 *
 * `current` carries the same evidence answer a requested value does, and for the
 * same reason: an axis can be listed while its value is not something the Agent
 * has stated since Yui last changed it. Using one vocabulary for both means a
 * reader does not have to learn that the two tables label evidence differently.
 */
export type AgentRunConfigurationAxis = Readonly<{
  /** The axis id as the Agent names it, not as Yui would. */
  key: string;
  /** The axis this option belongs to, when the Agent named one. */
  category?: string;
  current: AgentRunConfigurationCurrentValue;
  offered: readonly string[];
}>;

/**
 * The Agent's current value for a requested axis, or why there is none to read.
 *
 * The second branch covers an axis the current peer no longer reports.
 * Missing evidence is distinct from both agreement and drift.
 */
export type AgentRunConfigurationCurrentValue =
  | Readonly<{ status: "observed"; value: string }>
  | Readonly<{ status: "unobserved"; reason: string }>;

/**
 * What became of one value this launch asked the Agent for.
 *
 * `confirmation` is evidence about the moment the request was applied, stated at
 * the strength the protocol supported: `observed` means the Agent's own report
 * carried the value back, `already` means the Agent was holding it before Yui
 * asked. `acknowledged` remains readable in stored diagnostic evidence but is
 * not produced by current ACP configuration or accepted as its verification.
 *
 * `current` is a separate, later reading: what the Agent reports for that axis
 * now. Both are needed because an Agent may move an axis after confirming it —
 * selecting a model resets reasoning effort on real Agents — and a launch-time
 * confirmation alone would then describe a configuration the Session has left.
 */
export type AgentRunConfigurationRequest = Readonly<{
  field: AgentRunConfigurationField;
  /** The axis id this request was applied through. */
  key: string;
  /** The value the launch asked for. */
  value: string;
  confirmation: "already" | "observed" | "acknowledged";
  current: AgentRunConfigurationCurrentValue;
}>;

export type AgentRunConfigurationObservation =
  | Readonly<{
      status: "unknown";
      /**
       * Why nobody could be asked: no live Session, or one that could not be
       * reached. This is about Yui's reach, never about the Agent's answer.
       */
      reason: string;
    }>
  | Readonly<{
      status: "unsupported";
      /** Why this connection can report nothing: it negotiates no such state. */
      reason: string;
    }>
  | Readonly<{
      status: "observed";
      /**
       * When the axes below were read from the Session's latest report.
       *
       * Every read is taken fresh from the live Session, so this is a read
       * timestamp rather than a launch one. An Agent may change its own options
       * mid-Session and does so by notification; without this, a value the
       * Session has since replaced would be indistinguishable from a current one.
       */
      observedAt: string;
      /** What the peer reported about itself when the connection opened. */
      handshake: AgentHandshakeObservation;
      /**
       * Values this launch explicitly asked for, in application order. Empty
       * when the launch requested nothing, which is a real request: a Role that
       * names no model is asking for the Agent's own default.
       */
      requested: readonly AgentRunConfigurationRequest[];
      /** Yui-supported configuration axes only; arbitrary peer settings are not exposed. */
      axes: readonly AgentRunConfigurationAxis[];
    }>;

/**
 * The answer when there is no live Session to ask, or it could not be reached.
 *
 * Kept apart from `unsupported` because the two would otherwise both render as
 * "no data" while meaning opposite things: this one says Yui did not get an
 * answer, the other says the Agent has none to give.
 */
export function unknownAgentRunConfiguration(
  reason: string
): AgentRunConfigurationObservation {
  return Object.freeze({ status: "unknown", reason });
}

/**
 * The answer for a Session implementation without a run-configuration reader.
 *
 * Stated once so the two implementations that share this position cannot drift
 * into describing it differently, and so the reason travels with the status
 * instead of being reconstructed by whoever renders it.
 */
export function unsupportedAgentRunConfiguration(
  protocolDescription: string
): AgentRunConfigurationObservation {
  return Object.freeze({
    status: "unsupported",
    reason: `${protocolDescription}: this Yui Session implementation exposes no run configuration observation, so Yui cannot `
      + `confirm which model, reasoning effort or permission mode this Session is `
      + `operating under. See the Session's pinned launch request; current Role settings may differ.`
  });
}

/**
 * Project a negotiated capability exchange into the shared handshake shape.
 *
 * The parameter is described structurally rather than by naming a protocol type,
 * so this module stays free of any one protocol while still being the single
 * place the projection happens. That matters because the two callers learn the
 * same facts at different moments — a capability probe before any Session
 * exists, and a live Session at launch — and a second copy of this mapping would
 * let `yui config agent capabilities` and a Session inspect disagree about the
 * same Agent's advertised capabilities.
 *
 * Only enabled capabilities are listed, and a silent Agent stays `unknown`
 * rather than being resolved into a product by anything Yui knows about the
 * command it ran.
 */
export function handshakeObservationFrom(
  negotiated: Readonly<{
    protocolVersion: number;
    capabilities: Readonly<Record<string, boolean>>;
    authMethods: readonly Readonly<{ id: string }>[];
    agentName?: string;
    agentVersion?: string;
  }>
): AgentHandshakeObservation {
  return Object.freeze({
    status: "observed",
    protocolVersion: negotiated.protocolVersion,
    agentName: negotiated.agentName ?? "unknown",
    agentVersion: negotiated.agentVersion ?? "unknown",
    capabilities: Object.freeze(Object.entries(negotiated.capabilities)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .sort()),
    authMethods: Object.freeze(negotiated.authMethods.map((method) => method.id).sort())
  });
}

/**
 * Read an observation back from a parsed control response.
 *
 * This value is produced inside the Agent Host and read by a CLI process, so it
 * arrives as untyped JSON from another program. A malformed one must not
 * degrade into a confident-looking partial reading: an entry missing its
 * confirmation would render as a blank cell that looks like agreement. So
 * anything that does not parse becomes `unknown` with the reason saying so,
 * which is the same answer as a Session that could not be reached — because
 * that is exactly what it is.
 */
export function readAgentRunConfigurationObservation(
  value: unknown
): AgentRunConfigurationObservation {
  const malformed = unknownAgentRunConfiguration(
    "The Agent Host reported run configuration in a shape this build does not "
    + "recognize, so nothing about the live Session's configuration can be shown."
  );
  const observation = asRecord(value);
  if (observation === undefined) return malformed;
  if (observation.status === "unknown" || observation.status === "unsupported") {
    const reason = text(observation.reason);
    if (reason === undefined) return malformed;
    return Object.freeze({ status: observation.status, reason });
  }
  if (observation.status !== "observed") return malformed;
  const observedAt = text(observation.observedAt);
  const handshake = readHandshake(observation.handshake);
  if (observedAt === undefined || !Number.isFinite(Date.parse(observedAt))
    || handshake === undefined) return malformed;
  if (!Array.isArray(observation.requested) || !Array.isArray(observation.axes)) return malformed;
  const requested: AgentRunConfigurationRequest[] = [];
  for (const entry of observation.requested) {
    const request = readRequest(entry);
    // One unreadable entry cannot be skipped: the list would then look complete
    // while silently omitting a requested value, which is the difference between
    // "not requested" and "requested, outcome lost".
    if (request === undefined) return malformed;
    requested.push(request);
  }
  const axes: AgentRunConfigurationAxis[] = [];
  for (const entry of observation.axes) {
    const axis = readAxis(entry);
    if (axis === undefined) return malformed;
    axes.push(axis);
  }
  return Object.freeze({
    status: "observed",
    observedAt,
    handshake,
    requested: Object.freeze(requested),
    axes: Object.freeze(axes)
  });
}

function readRequest(value: unknown): AgentRunConfigurationRequest | undefined {
  const entry = asRecord(value);
  if (entry === undefined) return undefined;
  const field = entry.field;
  const key = text(entry.key);
  const requestedValue = text(entry.value);
  const confirmation = entry.confirmation;
  if (field !== "model" && field !== "effort" && field !== "permission") return undefined;
  if (key === undefined || requestedValue === undefined) return undefined;
  if (confirmation !== "already" && confirmation !== "observed" && confirmation !== "acknowledged") {
    return undefined;
  }
  const current = readCurrentValue(entry.current);
  if (current === undefined) return undefined;
  return Object.freeze({ field, key, value: requestedValue, confirmation, current });
}

/**
 * Read the current value and its evidence, shared by both tables.
 *
 * One reader because one shape: an axis and a requested value answer the same
 * question about evidence, and a second implementation is where the two would
 * eventually come to disagree about what counts as observed.
 */
function readCurrentValue(value: unknown): AgentRunConfigurationCurrentValue | undefined {
  const current = asRecord(value);
  if (current === undefined) return undefined;
  if (current.status === "observed") {
    const observed = text(current.value);
    return observed === undefined
      ? undefined
      : Object.freeze({ status: "observed", value: observed });
  }
  if (current.status !== "unobserved") return undefined;
  const reason = text(current.reason);
  return reason === undefined ? undefined : Object.freeze({ status: "unobserved", reason });
}

function readAxis(value: unknown): AgentRunConfigurationAxis | undefined {
  const entry = asRecord(value);
  if (entry === undefined) return undefined;
  const key = text(entry.key);
  const current = readCurrentValue(entry.current);
  if (key === undefined || current === undefined) return undefined;
  if (!Array.isArray(entry.offered)) return undefined;
  const offered: string[] = [];
  for (const candidate of entry.offered) {
    const offer = text(candidate);
    if (offer === undefined) return undefined;
    offered.push(offer);
  }
  const category = text(entry.category);
  return Object.freeze({
    key,
    ...(category === undefined ? {} : { category }),
    current,
    offered: Object.freeze(offered)
  });
}

function readHandshake(value: unknown): AgentHandshakeObservation | undefined {
  const handshake = asRecord(value);
  if (handshake === undefined) return undefined;
  if (handshake.status === "unsupported") {
    const reason = text(handshake.reason);
    return reason === undefined ? undefined : Object.freeze({ status: "unsupported", reason });
  }
  if (handshake.status !== "observed") return undefined;
  const protocolVersion = handshake.protocolVersion;
  const agentName = text(handshake.agentName);
  const agentVersion = text(handshake.agentVersion);
  if (typeof protocolVersion !== "number" || !Number.isSafeInteger(protocolVersion)) return undefined;
  if (agentName === undefined || agentVersion === undefined) return undefined;
  if (!Array.isArray(handshake.capabilities) || !Array.isArray(handshake.authMethods)) {
    return undefined;
  }
  const capabilities: string[] = [];
  for (const candidate of handshake.capabilities) {
    const capability = text(candidate);
    if (capability === undefined) return undefined;
    capabilities.push(capability);
  }
  const authMethods: string[] = [];
  for (const candidate of handshake.authMethods) {
    const method = text(candidate);
    if (method === undefined) return undefined;
    authMethods.push(method);
  }
  return Object.freeze({
    status: "observed",
    protocolVersion,
    agentName,
    agentVersion,
    capabilities: Object.freeze(capabilities),
    authMethods: Object.freeze(authMethods)
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
