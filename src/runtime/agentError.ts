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
  const retryAfterMs = input.retryAfterMs;
  if (retryAfterMs !== undefined
    && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)) {
    throw new Error("Agent error retryAfterMs must be a non-negative safe integer.");
  }
  return Object.freeze({
    source: input.source,
    phase: input.phase,
    category: classification.category,
    code: requiredErrorText(classification.code, "Agent error code"),
    message: requiredErrorText(input.message, "Agent error message"),
    raw: requiredErrorText(input.raw, "Agent error raw payload"),
    inputDisposition: input.inputDisposition
      ?? classification.inputDisposition
      ?? "unknown",
    sessionDisposition: input.sessionDisposition
      ?? classification.sessionDisposition
      ?? "unknown",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs })
  });
}

export const UNKNOWN_AGENT_ERROR_CLASSIFICATION: AgentErrorClassification = Object.freeze({
  category: "unknown",
  code: "unknown"
});

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
      || (Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs >= 0));
}

export function serializeAgentErrorRaw(value: unknown): string {
  if (typeof value === "string") return requiredErrorText(value, "Agent error raw payload");
  if (value === undefined) return "Agent operation failed without an error payload.";
  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_key, member: unknown) => {
      if (typeof member === "bigint") return member.toString();
      if (member !== null && typeof member === "object") {
        if (seen.has(member)) return "[Circular]";
        seen.add(member);
        if (member instanceof Error) {
          return Object.fromEntries(Object.getOwnPropertyNames(member).map((name) => [
            name,
            (member as unknown as Record<string, unknown>)[name]
          ]));
        }
      }
      return member;
    });
    return serialized === undefined
      ? String(value)
      : requiredErrorText(serialized, "Agent error raw payload");
  } catch {
    return requiredErrorText(String(value), "Agent error raw payload");
  }
}

function isErrorText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function requiredErrorText(value: string, label: string): string {
  if (!isErrorText(value)) throw new Error(`${label} is required.`);
  return value;
}
