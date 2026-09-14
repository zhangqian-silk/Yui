/**
 * Agent Client Protocol (ACP) v1 codec.
 *
 * This module owns the protocol only. It knows nothing about which product is
 * on the other end of the pipe: every product-specific fact (executable,
 * arguments, version, authentication context) belongs to a product descriptor.
 * A second ACP product must be reachable by adding a descriptor alone.
 *
 * Field names and semantics follow the published v1 specification
 * (agentclientprotocol.com/protocol/v1). Where the specification leaves a
 * behavior optional, this codec reports the negotiated fact rather than
 * assuming the capability exists.
 */

export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC "Request Cancelled", used by ACP for `$/cancel_request`. */
export const ACP_REQUEST_CANCELLED_CODE = -32800;
export const ACP_METHOD_NOT_FOUND_CODE = -32601;

export type AcpJsonValue = Record<string, unknown>;

/**
 * Capabilities Yui advertises as an ACP client. The filesystem and terminal
 * entries are deliberately false: Yui does not expose either to the Agent
 * through this transport, so the Agent must not call `fs/*` or `terminal/*`.
 * Declaring a capability Yui does not implement would invite calls it must then
 * refuse.
 *
 * `session.configOptions.boolean` is likewise absent. ACP gates boolean config
 * options behind that capability, and Yui's Role configuration expresses model,
 * effort and permission mode as named values rather than flags. Advertising it
 * would invite boolean options Yui has nothing to bind them to; staying silent
 * means the Agent sends only the `select` options this client can actually act
 * on, which the specification requires it to support unconditionally.
 */
export const YUI_CLIENT_CAPABILITIES: AcpJsonValue = Object.freeze({
  fs: Object.freeze({ readTextFile: false, writeTextFile: false }),
  terminal: false
});

/** Negotiated Agent capabilities, reduced to the facts Yui acts on. */
export type AcpAgentCapabilities = Readonly<{
  /** `session/load` replays history; requires `loadSession`. */
  loadSession: boolean;
  /** `session/resume` restores without replay; requires `sessionCapabilities.resume`. */
  resumeSession: boolean;
  /** `session/close` releases a session; requires `sessionCapabilities.close`. */
  closeSession: boolean;
  /**
   * Whether extra workspace roots may accompany a session lifecycle request.
   * ACP states that Clients MUST only send `additionalDirectories` when the
   * Agent advertises `sessionCapabilities.additionalDirectories`, so an Agent
   * that stays silent gets a request without the field rather than one it is
   * entitled to reject.
   */
  additionalDirectories: boolean;
  promptImage: boolean;
  promptAudio: boolean;
  promptEmbeddedContext: boolean;
}>;

export type AcpAuthMethod = Readonly<{
  id: string;
  name?: string;
  description?: string;
}>;

/**
 * Per-Session facts an ACP launch carries that no command line can express.
 *
 * ACP Agents take no Yui flags: the process is started by the descriptor's own
 * `baseArgs`, and everything else is negotiated. Anything the Session needs —
 * the workspace roots to request, the bootstrap the model must read first —
 * therefore travels here and is applied by the protocol, exactly as Codex
 * carries its thread options.
 */
export type AcpSessionOptions = Readonly<{
  /** Absolute extra workspace roots; sent only if the Agent advertises them. */
  additionalDirectories?: readonly string[];
  /**
   * Bootstrap prepended to this Session's first prompt. ACP has no system
   * prompt and no `--append-system-prompt-file`, so the only place a managed
   * Session can state its own rules is inside the prompt itself.
   */
  sessionBootstrap?: string;
  /**
   * Model, effort and permission mode this launch asks the Session for, applied
   * through `session/set_config_option` once the Session exists and before any
   * prompt is sent. Carried here for the same reason the roots are: ACP takes no
   * launch flags, so a per-Session request has nowhere else to travel.
   */
  desiredConfiguration?: AcpDesiredConfigurationOptions;
}>;

/**
 * The requested run configuration in launch-payload form.
 *
 * Structurally identical to what the Session applies, but declared here so the
 * launch payload stays a protocol-layer type: `permissionMode` is the exact id
 * the Agent must offer, and `permissionBypass` is the user's explicit request
 * for elevation, which resolves to a value only through the execution component.
 * They are mutually exclusive; absence of both means Yui states no mode.
 */
export type AcpDesiredConfigurationOptions = Readonly<{
  model?: string;
  effort?: string;
  permissionMode?: string;
  permissionBypass?: boolean;
}>;

export type AcpInitializeResult = Readonly<{
  protocolVersion: number;
  capabilities: AcpAgentCapabilities;
  authMethods: readonly AcpAuthMethod[];
  agentName?: string;
  agentVersion?: string;
}>;

/**
 * A permission decision Yui is willing to return. Yui never selects an
 * "allow" option on the user's behalf: an Agent asking for authority that the
 * user has not granted is refused, and the refusal is reported as a fact.
 */
export type AcpPermissionDecision =
  | Readonly<{ outcome: "selected"; optionId: string; kind: AcpPermissionOptionKind }>
  | Readonly<{ outcome: "cancelled" }>;

export type AcpPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export type AcpPermissionOption = Readonly<{
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
}>;

export function acpInitializeRequest(clientVersion: string): AcpJsonValue {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: YUI_CLIENT_CAPABILITIES,
    clientInfo: { name: "yui", title: "Yui", version: clientVersion }
  };
}

/**
 * Read an `initialize` result. The specification allows the Agent to answer
 * with the newest version it supports; a client that cannot use that version
 * must stop rather than continue on a guessed dialect.
 */
export function readAcpInitializeResult(value: unknown): AcpInitializeResult {
  const result = asObject(value);
  if (result === null) throw new Error("ACP initialize result is not an object.");
  const negotiated = result.protocolVersion;
  if (typeof negotiated !== "number" || !Number.isSafeInteger(negotiated)) {
    throw new Error("ACP initialize result is missing an integer protocolVersion.");
  }
  if (negotiated !== ACP_PROTOCOL_VERSION) {
    throw new Error(
      `ACP Agent negotiated protocol version ${negotiated}; Yui implements version `
      + `${ACP_PROTOCOL_VERSION}. Select an Agent build that speaks this version.`
    );
  }
  const capabilities = asObject(result.agentCapabilities) ?? {};
  const prompt = asObject(capabilities.promptCapabilities) ?? {};
  const session = asObject(capabilities.sessionCapabilities) ?? {};
  const info = asObject(result.agentInfo) ?? {};
  return Object.freeze({
    protocolVersion: negotiated,
    capabilities: Object.freeze({
      loadSession: capabilities.loadSession === true,
      // A capability object being present (even empty) is how ACP signals
      // support for these; absence or false means unsupported.
      resumeSession: isCapabilityPresent(session.resume),
      closeSession: isCapabilityPresent(session.close),
      additionalDirectories: isCapabilityPresent(session.additionalDirectories),
      promptImage: prompt.image === true,
      promptAudio: prompt.audio === true,
      promptEmbeddedContext: prompt.embeddedContext === true
    }),
    authMethods: Object.freeze(readAuthMethods(result.authMethods)),
    ...(optionalText(info.name) === undefined ? {} : { agentName: optionalText(info.name)! }),
    ...(optionalText(info.version) === undefined
      ? {}
      : { agentVersion: optionalText(info.version)! })
  });
}

function isCapabilityPresent(value: unknown): boolean {
  return value === true || (value !== null && typeof value === "object" && !Array.isArray(value));
}

function readAuthMethods(value: unknown): AcpAuthMethod[] {
  if (!Array.isArray(value)) return [];
  const methods: AcpAuthMethod[] = [];
  for (const entry of value) {
    const method = asObject(entry);
    const id = method === null ? undefined : optionalText(method.id);
    if (method === null || id === undefined) continue;
    methods.push(Object.freeze({
      id,
      ...(optionalText(method.name) === undefined ? {} : { name: optionalText(method.name)! }),
      ...(optionalText(method.description) === undefined
        ? {}
        : { description: optionalText(method.description)! })
    }));
  }
  return methods;
}

export function acpNewSessionRequest(
  cwd: string,
  additionalDirectories: readonly string[] = []
): AcpJsonValue {
  // `mcpServers` is required by the specification; Yui exposes none over ACP.
  return {
    cwd,
    mcpServers: [],
    // Clients MUST only send `additionalDirectories` when the Agent advertised
    // `sessionCapabilities.additionalDirectories`, so the caller gates this and
    // passes an empty list for an Agent that never offered the field. Omitting
    // the key entirely — rather than sending `[]` — keeps the request byte-wise
    // identical to what an Agent without the capability expects.
    ...(additionalDirectories.length === 0
      ? {}
      : { additionalDirectories: [...additionalDirectories] })
  };
}

export function acpPromptRequest(sessionId: string, text: string): AcpJsonValue {
  // Text is the baseline ContentBlock every ACP Agent must accept, so a prompt
  // never depends on a negotiated prompt capability.
  return { sessionId, prompt: [{ type: "text", text }] };
}

/**
 * A value an Agent offers for one `select` config option.
 *
 * `value` is the wire identity Yui sends back; `name` is the Agent's own label
 * for it. Yui never derives meaning from either — matching is by exact `value`,
 * so an Agent renaming a label cannot change which option Yui selects.
 */
export type AcpConfigOptionValue = Readonly<{
  value: string;
  name: string;
  description?: string;
}>;

/**
 * One negotiated session config option.
 *
 * ACP's optional `category` is UX metadata, not a contract: it tells a client
 * which axis an option belongs to (`mode`, `model`, `model_config`,
 * `thought_level`) without fixing the option's id. Yui reads it as a hint and
 * keeps the id, because the id is what `session/set_config_option` takes.
 *
 * Only `select` options are represented. Yui does not advertise the boolean
 * capability, so an Agent must not send boolean options; one that arrives
 * anyway is dropped by the reader rather than coerced into a select, exactly as
 * the specification's "Clients SHOULD ignore unrecognized types" requires.
 */
export type AcpConfigOption = Readonly<{
  id: string;
  name: string;
  description?: string;
  category?: string;
  currentValue: string;
  options: readonly AcpConfigOptionValue[];
}>;

/**
 * Read a `configOptions` array from a session setup or set-option result.
 *
 * Returns undefined when the field is absent, which is how an Agent that
 * predates config options answers; that is a different fact from an Agent
 * answering with an empty list, which offers nothing configurable. Callers must
 * be able to tell those apart, so the absence is not flattened to `[]`.
 */
export function readAcpConfigOptions(value: unknown): readonly AcpConfigOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: AcpConfigOption[] = [];
  for (const entry of value) {
    const option = asObject(entry);
    if (option === null) continue;
    const id = optionalText(option.id);
    // A select option's current value and choices are what make it settable.
    // An entry missing either cannot be acted on, and inventing a default here
    // would let Yui report a selection the Agent never offered.
    const currentValue = optionalText(option.currentValue);
    if (id === undefined || currentValue === undefined) continue;
    if (option.type !== undefined && option.type !== "select") continue;
    if (!Array.isArray(option.options)) continue;
    const values: AcpConfigOptionValue[] = [];
    for (const candidate of option.options) {
      const choice = asObject(candidate);
      const choiceValue = choice === null ? undefined : optionalText(choice.value);
      if (choice === null || choiceValue === undefined) continue;
      values.push(Object.freeze({
        value: choiceValue,
        name: optionalText(choice.name) ?? choiceValue,
        ...(optionalText(choice.description) === undefined
          ? {}
          : { description: optionalText(choice.description)! })
      }));
    }
    options.push(Object.freeze({
      id,
      name: optionalText(option.name) ?? id,
      ...(optionalText(option.description) === undefined
        ? {}
        : { description: optionalText(option.description)! }),
      ...(optionalText(option.category) === undefined
        ? {}
        : { category: optionalText(option.category)! }),
      currentValue,
      options: Object.freeze(values)
    }));
  }
  return Object.freeze(options);
}

/** Current ACP configuration contract for both new and loaded Sessions. */
export type AcpSessionConfiguration = Readonly<{
  options: readonly AcpConfigOption[];
}>;

/** The config option id ACP uses for a session's permission mode. */
export const ACP_MODE_CONFIG_ID = "mode";

export function readAcpSessionConfiguration(value: unknown): AcpSessionConfiguration {
  const result = asObject(value);
  const options = readAcpConfigOptions(result?.configOptions);
  if (options === undefined) {
    throw new Error("ACP Session must report configOptions; mode-only peers are unsupported.");
  }
  return Object.freeze({ options });
}

export function acpSetConfigOptionRequest(
  sessionId: string,
  configId: string,
  value: string
): AcpJsonValue {
  return { sessionId, configId, value };
}

export function acpCancelNotification(sessionId: string): AcpJsonValue {
  return { sessionId };
}

/** The five `stopReason` values defined by ACP v1. */
export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

const STOP_REASONS: readonly AcpStopReason[] = [
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled"
];

export function readAcpStopReason(value: unknown): AcpStopReason | undefined {
  const result = asObject(value);
  const reason = result?.stopReason;
  return STOP_REASONS.find((candidate) => candidate === reason);
}

/**
 * Map a stop reason onto Yui's terminal vocabulary. Only `end_turn` is a
 * completed Turn: a token or request ceiling and a refusal each ended the Turn
 * without delivering the requested work, and reporting them as success would
 * hide a real outcome from the Task record.
 */
export function acpTerminalStatus(reason: AcpStopReason): "completed" | "failed" | "cancelled" {
  switch (reason) {
    case "end_turn":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

export function acpStopReasonDetail(reason: AcpStopReason): string {
  switch (reason) {
    case "max_tokens":
      return "ACP Agent stopped at its token limit (stopReason=max_tokens).";
    case "max_turn_requests":
      return "ACP Agent stopped at its per-Turn model request limit "
        + "(stopReason=max_turn_requests).";
    case "refusal":
      return "ACP Agent refused to continue the Turn (stopReason=refusal).";
    case "cancelled":
      return "ACP Agent reported the Turn as cancelled (stopReason=cancelled).";
    case "end_turn":
      return "ACP Agent completed the Turn (stopReason=end_turn).";
  }
}

export type AcpSessionUpdate =
  | Readonly<{ kind: "agent-message"; text: string }>
  | Readonly<{ kind: "tool-call"; toolCallId: string; title?: string; status?: string }>
  | Readonly<{ kind: "tool-call-update"; toolCallId: string; status?: string }>
  | Readonly<{ kind: "plan" }>
  | Readonly<{ kind: "usage"; used?: number; size?: number }>
  /**
   * The Agent changed the session configuration itself. ACP sends the complete
   * option list, not a delta, so this replaces what Yui last observed rather
   * than merging into it.
   */
  | Readonly<{ kind: "config-options"; options: readonly AcpConfigOption[] }>
  | Readonly<{ kind: "other"; sessionUpdate: string }>;

/** Decode a `session/update` notification payload for the given session. */
export function readAcpSessionUpdate(
  params: unknown,
  sessionId: string
): AcpSessionUpdate | undefined {
  const value = asObject(params);
  if (value === null || optionalText(value.sessionId) !== sessionId) return undefined;
  const update = asObject(value.update);
  const kind = update === null ? undefined : optionalText(update.sessionUpdate);
  if (update === null || kind === undefined) return undefined;
  switch (kind) {
    case "agent_message_chunk": {
      const text = readContentText(update.content);
      return text === undefined ? undefined : Object.freeze({ kind: "agent-message", text });
    }
    case "tool_call": {
      const toolCallId = optionalText(update.toolCallId);
      if (toolCallId === undefined) return undefined;
      return Object.freeze({
        kind: "tool-call",
        toolCallId,
        ...(optionalText(update.title) === undefined
          ? {}
          : { title: optionalText(update.title)! }),
        ...(optionalText(update.status) === undefined
          ? {}
          : { status: optionalText(update.status)! })
      });
    }
    case "tool_call_update": {
      const toolCallId = optionalText(update.toolCallId);
      if (toolCallId === undefined) return undefined;
      return Object.freeze({
        kind: "tool-call-update",
        toolCallId,
        ...(optionalText(update.status) === undefined
          ? {}
          : { status: optionalText(update.status)! })
      });
    }
    case "plan":
      return Object.freeze({ kind: "plan" });
    case "config_option_update": {
      const options = readAcpConfigOptions(update.configOptions);
      return options === undefined
        ? undefined
        : Object.freeze({ kind: "config-options", options });
    }
    case "usage_update":
      return Object.freeze({
        kind: "usage",
        ...(safeCount(update.used) === undefined ? {} : { used: safeCount(update.used)! }),
        ...(safeCount(update.size) === undefined ? {} : { size: safeCount(update.size)! })
      });
    default:
      return Object.freeze({ kind: "other", sessionUpdate: kind });
  }
}

function readContentText(value: unknown): string | undefined {
  const content = asObject(value);
  if (content === null || content.type !== "text") return undefined;
  return typeof content.text === "string" ? content.text : undefined;
}

export type AcpPermissionRequest = Readonly<{
  sessionId: string;
  toolCallId?: string;
  options: readonly AcpPermissionOption[];
}>;

export function readAcpPermissionRequest(params: unknown): AcpPermissionRequest | undefined {
  const value = asObject(params);
  const sessionId = value === null ? undefined : optionalText(value.sessionId);
  if (value === null || sessionId === undefined) return undefined;
  const toolCall = asObject(value.toolCall);
  const options: AcpPermissionOption[] = [];
  if (Array.isArray(value.options)) {
    for (const entry of value.options) {
      const option = asObject(entry);
      const optionId = option === null ? undefined : optionalText(option.optionId);
      const kind = option === null ? undefined : optionalText(option.kind);
      if (option === null || optionId === undefined || !isPermissionOptionKind(kind)) continue;
      options.push(Object.freeze({
        optionId,
        name: optionalText(option.name) ?? optionId,
        kind
      }));
    }
  }
  const toolCallId = toolCall === null ? undefined : optionalText(toolCall.toolCallId);
  return Object.freeze({
    sessionId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    options: Object.freeze(options)
  });
}

function isPermissionOptionKind(value: string | undefined): value is AcpPermissionOptionKind {
  return value === "allow_once" || value === "allow_always"
    || value === "reject_once" || value === "reject_always";
}

/**
 * Choose a permission response without ever granting authority on the user's
 * behalf. Yui holds no interactive consent on this transport, so an Agent's
 * request to act is declined: an explicit reject option when the Agent offered
 * one, otherwise the `cancelled` outcome the specification always permits.
 * Escalating to an allow option here would silently convert an absent user
 * decision into a granted one.
 */
export function acpDeclinePermission(request: AcpPermissionRequest): AcpPermissionDecision {
  const reject = request.options.find((option) => option.kind === "reject_once")
    ?? request.options.find((option) => option.kind === "reject_always");
  return reject === undefined
    ? Object.freeze({ outcome: "cancelled" })
    : Object.freeze({ outcome: "selected", optionId: reject.optionId, kind: reject.kind });
}

export function acpPermissionResult(decision: AcpPermissionDecision): AcpJsonValue {
  return decision.outcome === "selected"
    ? { outcome: { outcome: "selected", optionId: decision.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

export function acpPermissionSummary(
  request: AcpPermissionRequest,
  decision: AcpPermissionDecision
): string {
  const target = request.toolCallId === undefined
    ? "an operation"
    : `tool call ${request.toolCallId}`;
  return decision.outcome === "selected"
    ? `Yui declined ACP permission for ${target} using option ${decision.optionId}.`
    : `Yui returned the cancelled outcome for an ACP permission request covering ${target}.`;
}

export function asObject(value: unknown): AcpJsonValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as AcpJsonValue
    : null;
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0")
    ? value.trim()
    : undefined;
}

function safeCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}
