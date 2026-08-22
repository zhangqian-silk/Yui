/**
 * Provider-neutral structured error taxonomy.
 *
 * Each Agent Driver parses its own Provider's raw failure text into one of
 * these codes at the driver boundary. The retry classifier then maps codes to
 * Yui error classes by lookup — no Provider-specific regex lives in the
 * classifier. Text matching remains only as a fallback for drivers that
 * cannot yet produce a structured code.
 */

import type { ProviderErrorClass } from "../lifecycle/providerErrorClass.js";

/**
 * Provider-neutral error codes. These describe transport/HTTP/protocol-level
 * failure modes, not Provider-specific strings.
 */
export type ProviderErrorCode =
  // ── Stream / transport ──────────────────────────────────────────────
  /** HTTP/2 RST_STREAM with INTERNAL_ERROR (e.g. "stream error: stream ID …; INTERNAL_ERROR"). */
  | "stream-internal-error"
  /** HTTP/2 RST_STREAM with PROTOCOL_ERROR or other stream-level reset. */
  | "stream-protocol-error"
  /** Generic stream-level failure without a more specific code. */
  | "stream-error"
  /** TCP connection reset by peer. */
  | "connection-reset"
  /** Connection lost / dropped. */
  | "connection-lost"
  /** Request or response timeout. */
  | "timeout"
  // ── HTTP status ─────────────────────────────────────────────────────
  /** 400-level client error (non-retryable). */
  | "http-4xx"
  /** 429 Too Many Requests. */
  | "http-429"
  /** 500-level server error. */
  | "http-5xx"
  // ── Provider capacity ───────────────────────────────────────────────
  /** Provider is overloaded. */
  | "overloaded"
  /** Generic server-side error message. */
  | "server-error"
  // ── Policy ──────────────────────────────────────────────────────────
  /** Content or usage policy denial (never retried automatically). */
  | "policy-denied"
  // ── Session lifecycle ───────────────────────────────────────────────
  /** Native session not found / no longer exists. */
  | "session-not-found"
  /** Native session has expired. */
  | "session-expired"
  /** Native session has ended. */
  | "session-ended"
  /** Native process has exited. */
  | "process-exited"
  // ── Request validity ────────────────────────────────────────────────
  /** Invalid request parameters or protocol error. */
  | "invalid-request"
  /** Unrecognized or unmapped error. */
  | "unknown";

/** A structured error extracted by a driver from raw Provider failure text. */
export type StructuredProviderError = Readonly<{
  code: ProviderErrorCode;
  /** Original raw error text, preserved for audit and debugging. */
  raw: string;
}>;

/**
 * Maps each structured code to its Yui error class. This is the single
 * authoritative lookup that replaces regex matching in the classifier.
 */
export const PROVIDER_ERROR_CODE_CLASS: Readonly<
  Record<ProviderErrorCode, ProviderErrorClass>
> = Object.freeze({
  // Stream/transport → transport-uncertain (delivery may have happened)
  "stream-internal-error": "transport-uncertain",
  "stream-protocol-error": "transport-uncertain",
  "stream-error": "transport-uncertain",
  "connection-reset": "transport-uncertain",
  "connection-lost": "transport-uncertain",
  timeout: "transport-uncertain",
  // HTTP 5xx / capacity → transient-provider
  "http-5xx": "transient-provider",
  overloaded: "transient-provider",
  "server-error": "transient-provider",
  // HTTP 429 → transient-provider (retryable with backoff)
  "http-429": "transient-provider",
  // HTTP 4xx → invalid-request (non-retryable)
  "http-4xx": "invalid-request",
  // Policy
  "policy-denied": "policy-denied",
  // Session
  "session-not-found": "session-dead",
  "session-expired": "session-dead",
  "session-ended": "session-dead",
  "process-exited": "session-dead",
  // Request
  "invalid-request": "invalid-request",
  unknown: "unclassified"
});

/** Whether a structured code is retryable in place. */
export function isRetryableErrorCode(code: ProviderErrorCode): boolean {
  const cls = PROVIDER_ERROR_CODE_CLASS[code];
  return cls === "transient-provider" || cls === "transport-uncertain";
}

// ── Claude Code driver ──────────────────────────────────────────────────

/**
 * Parses a Claude Code StopFailure `error` string into a structured code.
 *
 * Claude sends structured API error codes (server_error, overloaded_error,
 * rate_limit_error, etc.) as the `error` field, and raw transport text
 * ("stream error: stream ID …; INTERNAL_ERROR") in error_details or the
 * CLI's own output. This function handles both.
 */
export function parseClaudeError(
  error: string,
  details?: string
): StructuredProviderError {
  const text = [error, details]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join("\n");

  // ── Structured Claude API error codes ──────────────────────────────
  // Claude's StopFailure hook sends these as the `error` field.
  if (/^server_error$/iu.test(text)) {
    return { code: "server-error", raw: error };
  }
  if (/^overloaded_error$/iu.test(text)) {
    return { code: "overloaded", raw: error };
  }
  if (/^rate_limit_error$/iu.test(text)) {
    return { code: "http-429", raw: error };
  }
  if (/^invalid_request_error$/iu.test(text)) {
    return { code: "invalid-request", raw: error };
  }
  if (/^(authentication_error|permission_error)$/iu.test(text)) {
    return { code: "policy-denied", raw: error };
  }
  if (/^not_found_error$/iu.test(text)) {
    return { code: "session-not-found", raw: error };
  }
  if (/^api_error$/iu.test(text)) {
    return { code: "server-error", raw: error };
  }

  // Claude CLI structured error codes (e.g. "[claude-code:unrecognized_model]")
  if (/\[claude-code:(unrecognized_model|invalid_model|model_not_found)\]/iu.test(text)) {
    return { code: "invalid-request", raw: error };
  }

  // HTTP/2 RST_STREAM (the Task-27 failure mode)
  if (/stream error:.*INTERNAL_ERROR/iu.test(text)) {
    return { code: "stream-internal-error", raw: error };
  }
  if (/stream error:.*PROTOCOL_ERROR/iu.test(text)) {
    return { code: "stream-protocol-error", raw: error };
  }
  if (/stream error/iu.test(text)) {
    return { code: "stream-error", raw: error };
  }

  // "Server error mid-response" and similar
  if (/server[\s_-]?error/iu.test(text)) {
    return { code: "server-error", raw: error };
  }

  // HTTP status codes
  if (/\b429\b/u.test(text)) return { code: "http-429", raw: error };
  if (/\b40[0-9]\b/u.test(text)) return { code: "http-4xx", raw: error };
  if (/\b50[024]\b/u.test(text)) return { code: "http-5xx", raw: error };

  // Connection
  if (/connection[\s_-]?reset/iu.test(text)) return { code: "connection-reset", raw: error };
  if (/connection[\s_-]?lost/iu.test(text)) return { code: "connection-lost", raw: error };
  if (/econnreset/iu.test(text)) return { code: "connection-reset", raw: error };
  if (/socket hang up/iu.test(text)) return { code: "connection-reset", raw: error };

  // Timeout
  if (/timed?[ -]?out/iu.test(text)) return { code: "timeout", raw: error };
  if (/etimedout/iu.test(text)) return { code: "timeout", raw: error };

  // Capacity
  if (/overloaded/iu.test(text)) return { code: "overloaded", raw: error };
  if (/rate[\s_-]?limit/iu.test(text)) return { code: "http-429", raw: error };

  // Policy
  if (/cyber[_-]?policy/iu.test(text)) return { code: "policy-denied", raw: error };
  if (/policy[\s_-]?violation/iu.test(text)) return { code: "policy-denied", raw: error };
  if (/usage[\s_-]?policy/iu.test(text)) return { code: "policy-denied", raw: error };
  if (/content[\s_-]?policy/iu.test(text)) return { code: "policy-denied", raw: error };
  if (/safety[\s_-]?policy/iu.test(text)) return { code: "policy-denied", raw: error };

  // Session lifecycle
  if (/session[\s_-]?not[\s_-]?found/iu.test(text)) return { code: "session-not-found", raw: error };
  if (/no[\s_-]?such[\s_-]?(session|thread)/iu.test(text)) return { code: "session-not-found", raw: error };
  if (/thread[\s_-]?not[\s_-]?found/iu.test(text)) return { code: "session-not-found", raw: error };
  if (/session[\s_-]?(has[\s_-]?)?expired/iu.test(text)) return { code: "session-expired", raw: error };
  if (/session[\s_-]?(has[\s_-]?)?ended/iu.test(text)) return { code: "session-ended", raw: error };
  if (/process[\s_-]?exited/iu.test(text)) return { code: "process-exited", raw: error };

  // Request validity
  if (/invalid[\s_-]?request/iu.test(text)) return { code: "invalid-request", raw: error };
  if (/validation[\s_-]?error/iu.test(text)) return { code: "invalid-request", raw: error };
  if (/bad[\s_-]?request/iu.test(text)) return { code: "http-4xx", raw: error };
  if (/unknown[\s_-]?(flag|tool|argument)/iu.test(text)) return { code: "invalid-request", raw: error };

  return { code: "unknown", raw: error };
}

// ── Codex driver ────────────────────────────────────────────────────────

/**
 * Parses a Codex CLI failure into a structured code.
 *
 * Codex surfaces errors through process exit, transcript messages, and
 * stream-level failures. Its error formats overlap with Claude's (HTTP/2
 * stream errors, API status codes) but also include Codex-specific patterns.
 */
export function parseCodexError(
  error: string,
  details?: string
): StructuredProviderError {
  const text = [error, details]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join("\n");

  // ── Structured API error codes ────────────────────────────────────
  if (/^server_error$/iu.test(text)) {
    return { code: "server-error", raw: error };
  }
  if (/^overloaded_error$/iu.test(text)) {
    return { code: "overloaded", raw: error };
  }
  if (/^rate_limit_error$/iu.test(text)) {
    return { code: "http-429", raw: error };
  }
  if (/^invalid_request_error$/iu.test(text)) {
    return { code: "invalid-request", raw: error };
  }
  if (/^(authentication_error|permission_error)$/iu.test(text)) {
    return { code: "policy-denied", raw: error };
  }

  // Codex CLI structured error codes
  if (/\[codex:(unrecognized_model|invalid_model|model_not_found)\]/iu.test(text)) {
    return { code: "invalid-request", raw: error };
  }

  // ── Stream / transport ────────────────────────────────────────────
  if (/stream error:.*INTERNAL_ERROR/iu.test(text)) {
    return { code: "stream-internal-error", raw: error };
  }
  if (/stream error:.*PROTOCOL_ERROR/iu.test(text)) {
    return { code: "stream-protocol-error", raw: error };
  }
  if (/stream error/iu.test(text)) {
    return { code: "stream-error", raw: error };
  }

  // ── HTTP status codes ─────────────────────────────────────────────
  if (/\b429\b/u.test(text)) return { code: "http-429", raw: error };
  if (/\b40[0-9]\b/u.test(text)) return { code: "http-4xx", raw: error };
  if (/\b50[024]\b/u.test(text)) return { code: "http-5xx", raw: error };

  // ── Server / capacity ─────────────────────────────────────────────
  if (/server[\s_-]?error/iu.test(text)) {
    return { code: "server-error", raw: error };
  }
  if (/overloaded/iu.test(text)) return { code: "overloaded", raw: error };
  if (/rate[\s_-]?limit/iu.test(text)) return { code: "http-429", raw: error };
  if (/bad gateway/iu.test(text)) return { code: "http-5xx", raw: error };
  if (/gateway timeout/iu.test(text)) return { code: "timeout", raw: error };
  if (/service unavailable/iu.test(text)) return { code: "http-5xx", raw: error };
  if (/temporarily unavailable/iu.test(text)) return { code: "http-5xx", raw: error };

  // ── Connection ────────────────────────────────────────────────────
  if (/connection[\s_-]?reset/iu.test(text)) return { code: "connection-reset", raw: error };
  if (/connection[\s_-]?lost/iu.test(text)) return { code: "connection-lost", raw: error };
  if (/econnreset/iu.test(text)) return { code: "connection-reset", raw: error };
  if (/socket hang up/iu.test(text)) return { code: "connection-reset", raw: error };

  // ── Timeout ───────────────────────────────────────────────────────
  if (/timed?[ -]?out/iu.test(text)) return { code: "timeout", raw: error };
  if (/etimedout/iu.test(text)) return { code: "timeout", raw: error };

  // ── Policy ────────────────────────────────────────────────────────
  if (/cyber[_-]?policy/iu.test(text)) return { code: "policy-denied", raw: error };
  if (/policy[\s_-]?violation/iu.test(text)) return { code: "policy-denied", raw: error };
  if (/usage[\s_-]?policy/iu.test(text)) return { code: "policy-denied", raw: error };
  if (/content[\s_-]?policy/iu.test(text)) return { code: "policy-denied", raw: error };

  // ── Session ───────────────────────────────────────────────────────
  if (/session[\s_-]?not[\s_-]?found/iu.test(text)) return { code: "session-not-found", raw: error };
  if (/no[\s_-]?such[\s_-]?(session|thread)/iu.test(text)) return { code: "session-not-found", raw: error };
  if (/session[\s_-]?(has[\s_-]?)?expired/iu.test(text)) return { code: "session-expired", raw: error };
  if (/session[\s_-]?(has[\s_-]?)?ended/iu.test(text)) return { code: "session-ended", raw: error };
  if (/process[\s_-]?exited/iu.test(text)) return { code: "process-exited", raw: error };

  // ── Request validity ──────────────────────────────────────────────
  if (/invalid[\s_-]?request/iu.test(text)) return { code: "invalid-request", raw: error };
  if (/validation[\s_-]?error/iu.test(text)) return { code: "invalid-request", raw: error };
  if (/bad[\s_-]?request/iu.test(text)) return { code: "http-4xx", raw: error };
  if (/unknown[\s_-]?(flag|tool|argument)/iu.test(text)) return { code: "invalid-request", raw: error };

  return { code: "unknown", raw: error };
}
