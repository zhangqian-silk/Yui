import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyProviderError,
  isRetryableProviderErrorClass,
  RETRYABLE_PROVIDER_ERROR_CLASSES
} from "../../dist/lifecycle/providerErrorClass.js";

/**
 * Issue 04 — Provider error classification table.
 *
 * The classifier is the single, provider-neutral gate in front of the
 * in-place retry coordinator. These cases pin the conservative precedence
 * order (session-dead > policy-denied > invalid-request > transient-provider
 * > transport-uncertain > unclassified) so a later table edit cannot silently
 * widen retry onto a fatal class.
 */

const CLASS_CASES = [
  // transient-provider: the original Session is retried in place.
  ["transient-provider", "error", "500"],
  ["transient-provider", "error", "502"],
  ["transient-provider", "error", "504"],
  ["transient-provider", "error", "server_error"],
  ["transient-provider", "errorDetails", "upstream 503"],
  ["transient-provider", "error", "Connection lost mid-response"],
  ["transient-provider", "error", "connection reset by peer"],
  ["transient-provider", "error", "ECONNRESET"],
  ["transient-provider", "error", "socket hang up"],
  ["transient-provider", "error", "kv_cache_allocate_failed"],
  ["transient-provider", "error", "overloaded"],
  ["transient-provider", "error", "429"],
  ["transient-provider", "error", "rate_limit exceeded"],
  ["transient-provider", "error", "bad gateway"],
  ["transient-provider", "error", "gateway timeout"],
  ["transient-provider", "error", "service unavailable"],
  ["transient-provider", "error", "temporarily unavailable, try again"],
  ["transient-provider", "summary", "The provider returned an internal server error."],

  // transport-uncertain: the request may have been accepted; consult native
  // facts before resending.
  ["transport-uncertain", "error", "request timed out"],
  ["transport-uncertain", "error", "ETIMEDOUT"],
  ["transport-uncertain", "error", "response lost"],
  ["transport-uncertain", "error", "stream interrupted"],
  ["transport-uncertain", "error", "controller timeout"],
  ["transport-uncertain", "error", "delivery unconfirmed"],
  ["transport-uncertain", "error", "no response from provider"],

  // policy-denied: never retried, never worked around.
  ["policy-denied", "error", "cyber_policy violation"],
  ["policy-denied", "error", "cyber-policy denial"],
  ["policy-denied", "error", "policy_violation"],
  ["policy-denied", "error", "usage_policy breach"],
  ["policy-denied", "error", "content policy denial"],
  ["policy-denied", "error", "safety_policy"],

  // session-dead: stop in-place retry, raise a replacement blocker.
  ["session-dead", "error", "session not found"],
  ["session-dead", "error", "no such session"],
  ["session-dead", "error", "thread not found"],
  ["session-dead", "error", "session has expired"],
  ["session-dead", "error", "session ended"],
  ["session-dead", "error", "session is dead"],
  ["session-dead", "error", "session terminated"],
  ["session-dead", "error", "process exited"],
  ["session-dead", "error", "pane is dead"],

  // invalid-request: deterministic, fail fast.
  ["invalid-request", "error", "invalid_request"],
  ["invalid-request", "error", "validation error"],
  ["invalid-request", "error", "bad request"],
  ["invalid-request", "error", "400"],
  ["invalid-request", "error", "unknown flag --bogus"],
  ["invalid-request", "error", "unexpected argument"],
  ["invalid-request", "error", "invalid schema"]
];

for (const [expected, field, text] of CLASS_CASES) {
  test(`classifies ${expected} from ${field}: ${text}`, () => {
    const result = classifyProviderError({
      adapterId: "claude",
      [field]: text
    });
    assert.equal(result.errorClass, expected);
    assert.notEqual(result.matched, "none");
  });
}

test("empty input is unclassified and keeps the legacy fail-immediately behavior", () => {
  assert.deepEqual(classifyProviderError({ adapterId: "claude" }), {
    errorClass: "unclassified",
    matched: "none"
  });
  assert.deepEqual(
    classifyProviderError({ adapterId: "claude", error: "  ", errorDetails: "" }),
    { errorClass: "unclassified", matched: "none" }
  );
});

test("unknown free text is unclassified", () => {
  const result = classifyProviderError({
    adapterId: "claude",
    error: "the provider sent a puzzling haiku"
  });
  assert.equal(result.errorClass, "unclassified");
});

test("precedence: a session-dead signal beats a transient 500 in the same text", () => {
  const result = classifyProviderError({
    adapterId: "claude",
    error: "500 server_error",
    errorDetails: "session not found"
  });
  assert.equal(result.errorClass, "session-dead");
});

test("precedence: a policy denial beats a transient 503 in the same text", () => {
  const result = classifyProviderError({
    adapterId: "claude",
    error: "upstream 503",
    errorDetails: "cyber_policy violation"
  });
  assert.equal(result.errorClass, "policy-denied");
});

test("precedence: an invalid request beats a transient timeout", () => {
  const result = classifyProviderError({
    adapterId: "claude",
    error: "request timed out",
    errorDetails: "invalid_request"
  });
  assert.equal(result.errorClass, "invalid-request");
});

test("only transient-provider and transport-uncertain are retryable in place", () => {
  assert.ok(isRetryableProviderErrorClass("transient-provider"));
  assert.ok(isRetryableProviderErrorClass("transport-uncertain"));
  for (const nonRetryable of [
    "policy-denied",
    "session-dead",
    "invalid-request",
    "unclassified"
  ]) {
    assert.equal(
      isRetryableProviderErrorClass(nonRetryable),
      false,
      `${nonRetryable} must not be retried in place`
    );
  }
  assert.deepEqual(
    [...RETRYABLE_PROVIDER_ERROR_CLASSES].sort(),
    ["transient-provider", "transport-uncertain"]
  );
});

test("classification is case-insensitive and field-agnostic", () => {
  assert.equal(
    classifyProviderError({ adapterId: "claude", error: "SERVER_ERROR" }).errorClass,
    "transient-provider"
  );
  assert.equal(
    classifyProviderError({ adapterId: "claude", summary: "Cyber_Policy" }).errorClass,
    "policy-denied"
  );
});
