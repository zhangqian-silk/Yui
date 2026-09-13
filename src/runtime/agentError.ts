/**
 * Provider-neutral Agent failure facts.
 *
 * Drivers recognize provider-native failures. Core persists the resulting
 * facts and routes them to an Agent; it does not attach a recovery policy.
 * `unknown` is the required fallback and the complete native payload is always
 * retained in `raw`.
 */

export const AGENT_ERROR_CATEGORIES = Object.freeze([
  "availability",
  "rate-limit",
  "transport",
  "access",
  "invalid-request",
  "context",
  "session",
  "runtime",
  "conflict",
  "cancelled",
  "unknown"
] as const);

export type AgentErrorCategory = (typeof AGENT_ERROR_CATEGORIES)[number];
export type AgentErrorSource = "provider" | "driver" | "host" | "yui";

export type AgentErrorPhase =
  | "host-start"
  | "session-start"
  | "session-restore"
  | "turn-submit"
  | "turn-execute"
  | "turn-reconcile"
  | "host-stop";

export type AgentErrorInputDisposition = "accepted" | "not-accepted" | "unknown";
export type AgentErrorSessionDisposition = "recoverable" | "unrecoverable" | "unknown";

/**
 * Whether the durable Provider-AgentRun registration committed.
 *
 * This is a third fact, independent of whether the Provider accepted the
 * input. Registration runs before any Provider write, so a failed or
 * unconfirmed registration always means the Provider saw nothing — but an
 * unconfirmed one may still hold a durable record, so the submission occupancy
 * cannot be released as if nothing happened.
 */
export type AgentErrorRegistrationDisposition = "committed" | "not-committed" | "unknown";

export type AgentDriverErrorInput = Readonly<{
  /** Human-readable Provider message without losing the native payload. */
  message: string;
  /** Complete serialized Provider exception/payload. */
  raw: string;
}>;

/** Provider-specific recognition result. It contains facts, never strategy. */
export type AgentErrorClassification = Readonly<{
  category: AgentErrorCategory;
  /** Stable namespaced code such as `provider.model-capacity`. */
  code: string;
  inputDisposition?: AgentErrorInputDisposition;
  sessionDisposition?: AgentErrorSessionDisposition;
  /** Positive Driver evidence of a transient error; absent never grants replay. */
  retryable?: boolean;
  retryAfterMs?: number;
}>;

export type StandardAgentError = Readonly<{
  source: AgentErrorSource;
  phase: AgentErrorPhase;
  category: AgentErrorCategory;
  code: string;
  message: string;
  raw: string;
  inputDisposition: AgentErrorInputDisposition;
  sessionDisposition: AgentErrorSessionDisposition;
  retryAfterMs?: number;
  retryable?: boolean;
}>;

export function standardAgentError(input: Readonly<{
  source: AgentErrorSource;
  phase: AgentErrorPhase;
  classification?: AgentErrorClassification;
  message: string;
  raw: string;
  inputDisposition?: AgentErrorInputDisposition;
  sessionDisposition?: AgentErrorSessionDisposition;
  retryAfterMs?: number;
}>): StandardAgentError {
  const classification = input.classification ?? UNKNOWN_AGENT_ERROR_CLASSIFICATION;
  const retryAfterMs = input.retryAfterMs ?? classification.retryAfterMs;
  if (retryAfterMs !== undefined
    && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)) {
    throw new Error("Agent error retryAfterMs must be a non-negative safe integer.");
  }
  return Object.freeze({
    source: input.source,
    phase: input.phase,
    category: classification.category,
    code: requiredErrorText(classification.code, "Agent error code"),
    // Both readable fields pass the same redaction boundary. `message` is
    // often a Provider string interpolated by a caller, so it can carry a
    // credential even when `raw` is already clean.
    message: redactAgentErrorText(
      requiredErrorText(input.message, "Agent error message")
    ),
    raw: redactAgentErrorText(
      requiredErrorText(input.raw, "Agent error raw payload")
    ),
    inputDisposition: input.inputDisposition
      ?? classification.inputDisposition
      ?? "unknown",
    sessionDisposition: input.sessionDisposition
      ?? classification.sessionDisposition
      ?? "unknown",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(classification.retryable === undefined ? {} : { retryable: classification.retryable })
  });
}

export const UNKNOWN_AGENT_ERROR_CLASSIFICATION: AgentErrorClassification = Object.freeze({
  category: "unknown",
  code: "unknown"
});

/**
 * Why a managed Provider write did not reach `delivered`.
 *
 * The Agent Host owns these facts; every layer above it forwards this record
 * unchanged instead of re-deriving a reason from a collapsed string enum. It
 * deliberately carries no `category`/`code`: driver classification stays at
 * the single `recordAgentError` boundary that already owns it.
 *
 * `inputDisposition` is the load-bearing field. `not-accepted` means the
 * Provider provably never saw the input and the attempt may be retried;
 * `unknown` forbids automatic replay.
 */
export type ProviderDeliveryFailure = Readonly<{
  /**
   * Short readable cause. Redacted and clipped to a display bound, so it is a
   * projection: when it ends in a truncation marker the complete redacted
   * chain is in `raw`, never only here.
   */
  detail: string;
  /**
   * Complete redacted cause chain, bounded only by the persisted-payload cap.
   * This is the authorized-readable original detail that survives a clipped
   * `detail`, and it retains nested `cause` links rather than a wrapper string.
   */
  raw?: string;
  /** Failure class name (e.g. `ProviderTurnRejectedError`) when the Host knew it. */
  errorName?: string;
  /** Class name of the innermost `cause`, which is usually the real reason. */
  causeName?: string;
  phase: AgentErrorPhase;
  /** Observed Agent Host provider state at the failure. */
  hostState?: string;
  attemptId?: string;
  inputDisposition: AgentErrorInputDisposition;
  /** Durable registration outcome, when the failure happened around it. */
  registrationDisposition?: AgentErrorRegistrationDisposition;
  sessionDisposition?: AgentErrorSessionDisposition;
}>;

export function providerDeliveryFailure(
  input: ProviderDeliveryFailure
): ProviderDeliveryFailure {
  const raw = input.raw === undefined ? undefined : serializeAgentErrorRaw(input.raw);
  return Object.freeze({
    ...definedDeliveryFields(input),
    detail: boundDisplayText(
      redactAgentErrorText(
        requiredErrorText(input.detail, "Provider delivery failure detail")
      )
    ),
    ...(raw === undefined ? {} : { raw }),
    phase: input.phase,
    inputDisposition: input.inputDisposition
  });
}

/** Forward facts owned by the failing operation without parsing its prose. */
export function providerDeliveryFailureFacts(failure: ProviderDeliveryFailure | undefined): Readonly<
  Pick<ProviderDeliveryFailure, "sessionDisposition" | "registrationDisposition"
    | "errorName" | "causeName" | "attemptId" | "hostState">
> {
  if (failure === undefined) return {};
  return {
    ...(failure.sessionDisposition === undefined ? {} : { sessionDisposition: failure.sessionDisposition }),
    ...(failure.registrationDisposition === undefined ? {} : { registrationDisposition: failure.registrationDisposition }),
    ...(failure.errorName === undefined ? {} : { errorName: failure.errorName }),
    ...(failure.causeName === undefined ? {} : { causeName: failure.causeName }),
    ...(failure.hostState === undefined ? {} : { hostState: failure.hostState }),
    ...(failure.attemptId === undefined ? {} : { attemptId: failure.attemptId })
  };
}

/**
 * Builds a delivery failure from a thrown error, keeping the structured cause.
 *
 * Call sites used to interpolate `error.message` into a sentence, which
 * discarded the class name and the whole `cause` chain. Here `detail` stays the
 * readable projection while `raw`/`errorName`/`causeName` carry the structure.
 */
export function providerDeliveryFailureFrom(
  error: unknown,
  input: Omit<ProviderDeliveryFailure, "detail" | "raw" | "errorName" | "causeName">
    & Readonly<{ detail?: string }>
): ProviderDeliveryFailure {
  const causeName = innermostCauseName(error);
  return providerDeliveryFailure({
    ...input,
    detail: input.detail ?? errorMessageText(error),
    raw: serializeAgentErrorRaw(error),
    ...(error instanceof Error ? { errorName: error.name } : {}),
    ...(causeName === undefined ? {} : { causeName })
  });
}

/**
 * Class name of the innermost `cause`, which is usually the real reason a
 * wrapped failure occurred. Bounded: a malformed chain must not spin here.
 */
export function innermostCauseName(error: unknown): string | undefined {
  let current: unknown = error instanceof Error ? error.cause : undefined;
  let name: string | undefined;
  for (let depth = 0; depth < 16 && current instanceof Error; depth += 1) {
    name = current.name;
    current = current.cause;
  }
  return name;
}

function errorMessageText(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim().length > 0 ? error.message : error.name;
  }
  return String(error ?? "unknown error");
}

/**
 * Renders a delivery failure as one readable line for a AgentRun summary. The
 * complete record stays available on `runtime.agent-error`; this is the
 * bounded projection, never a replacement for the original cause.
 */
export function formatProviderDeliveryFailure(
  failure: ProviderDeliveryFailure
): string {
  const fields = [
    `phase=${failure.phase}`,
    `inputDisposition=${failure.inputDisposition}`
  ];
  if (failure.hostState !== undefined) fields.push(`hostState=${failure.hostState}`);
  if (failure.errorName !== undefined) fields.push(`error=${failure.errorName}`);
  if (failure.causeName !== undefined) fields.push(`cause=${failure.causeName}`);
  if (failure.attemptId !== undefined) fields.push(`attemptId=${failure.attemptId}`);
  if (failure.registrationDisposition !== undefined) {
    fields.push(`registration=${failure.registrationDisposition}`);
  }
  if (failure.sessionDisposition !== undefined) {
    fields.push(`sessionDisposition=${failure.sessionDisposition}`);
  }
  // A clipped projection must say where the complete cause is, or a reader
  // takes the visible fragment for the whole reason.
  if (isTruncatedText(failure.detail)) fields.push("detailTruncated=see-raw");
  return `${failure.detail} (${fields.join(" ")})`;
}

/**
 * Drops absent fields and passes every retained readable one through the same
 * redaction and display bound as `detail`. These fields carry a class name or
 * an id today, but they are persisted and publicly readable, so they must not
 * be the one path that skips the boundary.
 */
function definedDeliveryFields(
  value: ProviderDeliveryFailure
): ProviderDeliveryFailure {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .map(([key, member]) => [
        key,
        typeof member === "string" ? boundDisplayText(redactAgentErrorText(member)) : member
      ])
  ) as unknown as ProviderDeliveryFailure;
}

export function isAgentErrorCategory(value: unknown): value is AgentErrorCategory {
  return typeof value === "string"
    && (AGENT_ERROR_CATEGORIES as readonly string[]).includes(value);
}

export function isStandardAgentError(value: unknown): value is StandardAgentError {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const error = value as Partial<StandardAgentError>;
  return ["provider", "driver", "host", "yui"].includes(error.source ?? "")
    && [
      "host-start",
      "session-start",
      "session-restore",
      "turn-submit",
      "turn-execute",
      "turn-reconcile",
      "host-stop"
    ].includes(error.phase ?? "")
    && isAgentErrorCategory(error.category)
    && isErrorText(error.code)
    && isErrorText(error.message)
    && isErrorText(error.raw)
    && ["accepted", "not-accepted", "unknown"].includes(error.inputDisposition ?? "")
    && ["recoverable", "unrecoverable", "unknown"].includes(
      error.sessionDisposition ?? ""
    )
    && (error.retryAfterMs === undefined
      || (Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs >= 0))
    && (error.retryable === undefined || typeof error.retryable === "boolean");
}

/**
 * Upper bound for one persisted raw payload. A Provider stack trace or a
 * transport dump stays readable well below this; anything larger keeps its
 * head and its tail with an explicit marker between them.
 */
const MAX_RAW_CHARS = 16_000;

/**
 * Bound for a one-line readable projection such as `detail` or a summary. The
 * complete redacted chain lives in `raw`, so clipping here loses nothing.
 */
const MAX_DISPLAY_CHARS = 2_000;

/**
 * Bound for one field inside a serialized payload. Sized so a deep chain of
 * wrapped errors still fits under `MAX_RAW_CHARS` with its causes intact.
 */
const MAX_FIELD_CHARS = 2_000;

const TRUNCATION_MARKER = "…[truncated";

/**
 * Serializes any failure into one bounded, secret-redacted payload.
 *
 * `raw` is the authoritative cause and is persisted verbatim on
 * `runtime.agent-error`, so it is the last boundary before a Provider
 * credential could reach durable storage or a public read. Redaction happens
 * here rather than at each call site: an unredacted path added later would
 * otherwise silently leak. `cause` chains and non-enumerable Error fields are
 * retained because they usually carry the real reason.
 */
export function serializeAgentErrorRaw(value: unknown): string {
  return boundRawPayload(redactAgentErrorText(rawPayloadText(value)));
}

function rawPayloadText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "Agent operation failed without an error payload.";
  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (key, member: unknown) => {
      // AgentRun input is the Agent's prompt: Task context, quoted files, whatever
      // the Role was told. It is not a failure fact, and it reaches the same
      // durable, publicly-readable record as the rest of this payload. A
      // transport client that echoes its own request into the thrown error
      // carries it here without any call site intending to persist it.
      if (PROVIDER_INPUT_KEYS.has(key)) return "[PROVIDER-INPUT-OMITTED]";
      // Each field is clipped on its own so no single oversized message or
      // stack can push the rest of the chain past the payload bound. Clipping
      // the whole payload instead lost the innermost `cause`, which is the one
      // field that usually states the real reason.
      if (typeof member === "string") return boundFieldText(member);
      if (typeof member === "bigint") return member.toString();
      if (member !== null && typeof member === "object") {
        if (seen.has(member)) return "[Circular]";
        seen.add(member);
        if (member instanceof Error) {
          // Error's own fields are non-enumerable, and `cause` is where a
          // wrapped transport/controller failure keeps its real reason.
          // `stack` is emitted last so a clip at any level takes the trace
          // before it takes the identifying fields or the nested cause.
          const own = Object.getOwnPropertyNames(member)
            .filter((name) => name !== "stack");
          return Object.fromEntries([
            ...own.map((name) => [
              name,
              (member as unknown as Record<string, unknown>)[name]
            ]),
            ...(typeof member.stack === "string" ? [["stack", member.stack]] : [])
          ]);
        }
      }
      return member;
    });
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

/**
 * Payload keys that carry Provider input rather than a failure fact. `text`
 * and `body` are the shapes an HTTP or SDK client uses when it attaches the
 * failed request to its error.
 */
const PROVIDER_INPUT_KEYS = new Set([
  "boundedText",
  "text",
  "prompt",
  "input",
  "body",
  "content",
  "messages"
]);

const SECRET_LABEL =
  "api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|cookie|authorization";
const SECRET_ASSIGNMENT_START = new RegExp(
  `(${SECRET_LABEL})(\\\\*["']?\\s*[=:]\\s*)`,
  "gi"
);
/**
 * `Authorization: Basic <base64>` and friends. The generic assignment pattern
 * consumed only the scheme word and left the credential itself readable.
 */
const AUTH_SCHEME_PATTERN =
  /((?:authorization|proxy-authorization)(?:\\?["']?\s*[=:]\s*\\?["']?)\s*)(basic|bearer|token|digest|negotiate)(\s+)[A-Za-z0-9._~+/=-]{4,}/gi;
// Word boundary keeps "task-5-…" workspace paths from being mistaken for keys.
const PROVIDER_KEY_PATTERN = /\b(?:(?:sk|pat)-|(?:ghp|gho|ghs|github_pat)_)[A-Za-z0-9_-]{6,}/gu;
// Digest credentials are an entire parameter list, not a single scheme token.
// Cover raw headers and escaped headers embedded in JSON error strings without
// consuming the enclosing serialized error and its subsequent cause fields.
const DIGEST_AUTH_PATTERN =
  /((?:proxy-)?authorization(?:\\?["']?\s*[=:]\s*\\?["']?)\s*digest\s+)(?:[\w-]+\s*=\s*(?:\\"(?:[^"\\]|\\(?!"))*\\"|"(?:\\.|[^"\\])*"|'[^']*'|[^,\s"}]+)\s*(?:,\s*)?)+/gi;
const BEARER_PATTERN = /\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;

/**
 * Redacts credential-shaped text from a failure payload. This mirrors the
 * launch-diagnostic redaction but is applied to the Agent error chain, whose
 * payloads are persisted and publicly readable through the Task event.
 */
export function redactAgentErrorText(value: string): string {
  return redactSecretAssignments(value
    .replace(PROVIDER_KEY_PATTERN, "[REDACTED]")
    .replace(DIGEST_AUTH_PATTERN, "$1 [REDACTED]")
    .replace(AUTH_SCHEME_PATTERN, "$1$2$3[REDACTED]")
    .replace(BEARER_PATTERN, "$1[REDACTED]"));
}

/**
 * A quoted diagnostic may itself be inside a JSON string. Its delimiter is
 * then `\"`, not `"`, and a generic backslash escape regex can eat the closing
 * delimiter and the rest of the cause. Match the opening escape depth, retain
 * both delimiters, and replace only their secret value. This is also stable
 * when already redacted raw crosses another error boundary.
 */
function redactSecretAssignments(value: string): string {
  let cursor = 0;
  let redacted = "";
  for (const match of value.matchAll(SECRET_ASSIGNMENT_START)) {
    if (match.index < cursor) continue;
    const start = match.index + match[0].length;
    if (value.startsWith("[REDACTED]", start)) continue;
    const opening = /^(\\*)(["'])/u.exec(value.slice(start));
    let end = start;
    let replacement = "[REDACTED]";
    if (opening !== null) {
      const delimiter = opening[0];
      const quote = opening[2]!;
      const escapeDepth = opening[1]!.length;
      let backslashes = 0;
      end += delimiter.length;
      for (; end < value.length; end += 1) {
        const char = value[end];
        if (char === "\\") {
          backslashes += 1;
          continue;
        }
        if (char === quote && backslashes % (2 * (escapeDepth + 1)) === escapeDepth) break;
        backslashes = 0;
      }
      replacement = `${delimiter}[REDACTED]${end < value.length ? delimiter : ""}`;
      if (end < value.length) end += 1;
    } else {
      // No explicit quote means spaces may be part of the credential.
      while (end < value.length && !/[,;"'\\\n\r}\]]/u.test(value[end]!)) end += 1;
    }
    if (end === start) continue;
    redacted += value.slice(cursor, start) + replacement;
    cursor = end;
  }
  return redacted + value.slice(cursor);
}

/**
 * Clips a persisted payload while keeping both ends.
 *
 * Per-field clipping already keeps the cause chain within bounds, so this only
 * guards a pathologically wide payload. Keeping a tail slice means a reader
 * still sees how the record ends rather than only its head.
 */
function boundRawPayload(value: string): string {
  const text = isErrorText(value) ? value : "Agent operation failed without a readable error payload.";
  if (text.length <= MAX_RAW_CHARS) return text;
  const headChars = Math.floor(MAX_RAW_CHARS * 0.75);
  const tailChars = MAX_RAW_CHARS - headChars;
  return `${text.slice(0, headChars)}${TRUNCATION_MARKER} ${
    text.length - MAX_RAW_CHARS
  } chars of ${text.length}]${text.slice(text.length - tailChars)}`;
}

function boundFieldText(value: string): string {
  if (value.length <= MAX_FIELD_CHARS) return value;
  return `${value.slice(0, MAX_FIELD_CHARS)}${TRUNCATION_MARKER} ${
    value.length - MAX_FIELD_CHARS
  } chars of ${value.length}]`;
}

/**
 * Clips a one-line projection. Unlike `raw` this may lose content, so the
 * marker is the reader's signal to consult the complete payload.
 */
function boundDisplayText(value: string): string {
  if (value.length <= MAX_DISPLAY_CHARS) return value;
  return `${value.slice(0, MAX_DISPLAY_CHARS)}${TRUNCATION_MARKER} ${
    value.length - MAX_DISPLAY_CHARS
  } chars of ${value.length}]`;
}

export function isTruncatedText(value: string): boolean {
  return value.includes(TRUNCATION_MARKER);
}

function isErrorText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function requiredErrorText(value: string, label: string): string {
  if (!isErrorText(value)) throw new Error(`${label} is required.`);
  return value;
}
