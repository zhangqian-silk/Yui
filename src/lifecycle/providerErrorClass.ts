/**
 * Issue 04 — Provider error classification.
 *
 * Provider failures arrive at the driver boundary as opaque free text (Claude
 * StopFailure `error`/`errorDetails`, Codex turn-completion summaries). Each
 * driver parses its own Provider's format into a structured
 * {@link ProviderErrorCode} at the driver boundary. This module maps those
 * codes to provider-neutral error classes by lookup, falling back to text
 * matching only when the driver could not produce a structured code.
 *
 * The retry-in-place coordinator needs a stable, provider-neutral error class
 * before it can decide whether the original Session may be retried.
 *
 * Classes (Issue 04 §2):
 * - `transient-provider`   — 500/502/504, connection reset, backend capacity;
 *                            the original Session is retried in place.
 * - `transport-uncertain`  — the request may have been accepted but the
 *                            response was lost; native facts are consulted
 *                            before any resend.
 * - `policy-denied`        — cyber_policy / permission boundary; never retried
 *                            automatically, never worked around by switching
 *                            Session or widening permission.
 * - `session-dead`         — the process/tmux/native identity is gone; in-place
 *                            retry stops and a replacement blocker is raised.
 * - `invalid-request`      — deterministic parameter/protocol error; fail fast,
 *                            never call the Provider again.
 * - `unclassified`         — no conservative match; behaves like
 *                            `invalid-request` for retry purposes (old
 *                            terminalize-immediately behavior) while remaining
 *                            observable in shadow metrics.
 */

import type { ProviderErrorCode } from "../runtime/providerErrorCodes.js";
import { PROVIDER_ERROR_CODE_CLASS } from "../runtime/providerErrorCodes.js";


export type ProviderErrorClass =
  | "transient-provider"
  | "transport-uncertain"
  | "policy-denied"
  | "session-dead"
  | "invalid-request"
  | "unclassified";

/** Classes for which the original Session may be retried in place. */
export const RETRYABLE_PROVIDER_ERROR_CLASSES: readonly ProviderErrorClass[] = [
  "transient-provider",
  "transport-uncertain"
];

export function isRetryableProviderErrorClass(
  errorClass: ProviderErrorClass
): boolean {
  return RETRYABLE_PROVIDER_ERROR_CLASSES.includes(errorClass);
}


export type ProviderErrorClassificationInput = Readonly<{
  adapterId: string;
  /** Structured error code from the driver, when available. */
  errorCode?: ProviderErrorCode;
  /** Raw provider error text (e.g. Claude StopFailure `error`). */
  error?: string;
  /** Raw provider error detail text (e.g. Claude StopFailure `errorDetails`). */
  errorDetails?: string;
  /** Free-text summary (e.g. Codex last assistant message). */
  summary?: string;
}>;

type Pattern = Readonly<{ pattern: RegExp; label: string }>;

/**
 * Ordered pattern tables. The first class whose pattern matches wins, so the
 * table order is the precedence order. Patterns are matched case-insensitively
 * against the concatenation of every available text field.
 */
const SESSION_DEAD_PATTERNS: readonly Pattern[] = [
  { pattern: /session not found/iu, label: "session-not-found" },
  { pattern: /no such (session|thread)/iu, label: "no-such-session" },
  { pattern: /thread not found/iu, label: "thread-not-found" },
  { pattern: /session (has )?expired/iu, label: "session-expired" },
  { pattern: /session (has )?ended/iu, label: "session-ended" },
  { pattern: /session (is )?dead/iu, label: "session-dead" },
  { pattern: /session terminated/iu, label: "session-terminated" },
  { pattern: /process exited/iu, label: "process-exited" },
  { pattern: /pane (is )?dead/iu, label: "pane-dead" },
  { pattern: /target session/iu, label: "target-session" }
];

const POLICY_DENIED_PATTERNS: readonly Pattern[] = [
  { pattern: /cyber[_-]?policy/iu, label: "cyber-policy" },
  { pattern: /policy[_-]?violation/iu, label: "policy-violation" },
  { pattern: /usage[_-]?policy/iu, label: "usage-policy" },
  { pattern: /content[_-]?policy/iu, label: "content-policy" },
  { pattern: /safety[_-]?policy/iu, label: "safety-policy" },
  { pattern: /policy denial/iu, label: "policy-denial" }
];

const INVALID_REQUEST_PATTERNS: readonly Pattern[] = [
  { pattern: /invalid[_-]?request/iu, label: "invalid-request" },
  { pattern: /validation error/iu, label: "validation-error" },
  { pattern: /bad request/iu, label: "bad-request" },
  { pattern: /\b400\b/u, label: "http-400" },
  { pattern: /unknown (flag|tool|argument)/iu, label: "unknown-argument" },
  { pattern: /unexpected argument/iu, label: "unexpected-argument" },
  { pattern: /invalid schema/iu, label: "invalid-schema" }
];

const TRANSIENT_PROVIDER_PATTERNS: readonly Pattern[] = [
  { pattern: /\b50[024]\b/u, label: "http-5xx" },
  { pattern: /server[\s_-]?error/iu, label: "server-error" },
  { pattern: /internal server error/iu, label: "internal-server-error" },
  // HTTP/2 RST_STREAM / gRPC status carried by Claude Code and Codex streams
  // (Task-27: "stream error: stream ID …; INTERNAL_ERROR; received from peer").
  { pattern: /\binternal[\s_-]?error\b/iu, label: "internal-error" },
  { pattern: /connection lost/iu, label: "connection-lost" },
  { pattern: /connection reset/iu, label: "connection-reset" },
  { pattern: /econnreset/iu, label: "econnreset" },
  { pattern: /socket hang up/iu, label: "socket-hang-up" },
  { pattern: /kv[_-]?cache[_-]?allocate[_-]?failed/iu, label: "kv-cache-allocate-failed" },
  { pattern: /overloaded/iu, label: "overloaded" },
  { pattern: /\b429\b/u, label: "http-429" },
  { pattern: /rate[_-]?limit/iu, label: "rate-limit" },
  { pattern: /upstream/iu, label: "upstream" },
  { pattern: /bad gateway/iu, label: "bad-gateway" },
  { pattern: /gateway timeout/iu, label: "gateway-timeout" },
  { pattern: /service unavailable/iu, label: "service-unavailable" },
  { pattern: /temporarily unavailable/iu, label: "temporarily-unavailable" },
  { pattern: /try again/iu, label: "try-again" }
];

const TRANSPORT_UNCERTAIN_PATTERNS: readonly Pattern[] = [
  { pattern: /timed?[ -]?out/iu, label: "timeout" },
  { pattern: /etimedout/iu, label: "etimedout" },
  { pattern: /response lost/iu, label: "response-lost" },
  { pattern: /lost response/iu, label: "lost-response" },
  // A stream-level failure means the response may have been cut mid-turn;
  // the retry path consults durable completion facts before any resend.
  { pattern: /stream error/iu, label: "stream-error" },
  { pattern: /stream interrupted/iu, label: "stream-interrupted" },
  { pattern: /interrupted function/iu, label: "interrupted-function" },
  { pattern: /controller timeout/iu, label: "controller-timeout" },
  { pattern: /delivery (unconfirmed|uncertain|not confirmed)/iu, label: "delivery-unconfirmed" },
  { pattern: /unconfirmed delivery/iu, label: "unconfirmed-delivery" },
  { pattern: /no response/iu, label: "no-response" }
];

const CLASS_TABLE: readonly Readonly<{
  errorClass: ProviderErrorClass;
  patterns: readonly Pattern[];
}>[] = [
  { errorClass: "session-dead", patterns: SESSION_DEAD_PATTERNS },
  { errorClass: "policy-denied", patterns: POLICY_DENIED_PATTERNS },
  { errorClass: "invalid-request", patterns: INVALID_REQUEST_PATTERNS },
  { errorClass: "transient-provider", patterns: TRANSIENT_PROVIDER_PATTERNS },
  { errorClass: "transport-uncertain", patterns: TRANSPORT_UNCERTAIN_PATTERNS }
];

export type ProviderErrorClassification = Readonly<{
  errorClass: ProviderErrorClass;
  /** The structured code or pattern label that matched, or `none` for `unclassified`. */
  matched: string;
  /** How the classification was derived. */
  basis: "structured" | "text";
}>;

/**
 * Classifies one provider failure. When the driver produced a structured
 * {@link ProviderErrorCode}, the class is looked up directly. Otherwise the
 * raw text fields are matched against the fallback pattern tables. Every
 * available text field is concatenated so a class can be recognized
 * regardless of which field carried it.
 */
export function classifyProviderError(
  input: ProviderErrorClassificationInput
): ProviderErrorClassification {
  // Structured path: the driver already parsed the Provider's error format.
  if (input.errorCode !== undefined) {
    const errorClass = PROVIDER_ERROR_CODE_CLASS[input.errorCode];
    if (errorClass !== undefined) {
      return { errorClass, matched: input.errorCode, basis: "structured" };
    }
  }
  // Text fallback: for drivers that cannot yet produce a structured code.
  const text = [input.error, input.errorDetails, input.summary]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
  if (text.length === 0) return { errorClass: "unclassified", matched: "none", basis: "text" };
  for (const { errorClass, patterns } of CLASS_TABLE) {
    for (const { pattern, label } of patterns) {
      if (pattern.test(text)) return { errorClass, matched: label, basis: "text" };
    }
  }
  return { errorClass: "unclassified", matched: "none", basis: "text" };
}
