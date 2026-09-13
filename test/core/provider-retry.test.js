import assert from "node:assert/strict";
import test from "node:test";
import {
  beginProviderTurn, acceptProviderTurn, settleProviderTurn,
  createProviderRuntimeBinding, settleProviderTurnSubmission
} from "../../dist/runtime/providerRuntimeIdentity.js";
import {
  recordProviderFailure, admitProviderRetry, providerRetryProjection,
  cancelProviderRetry, deferProviderRetry, providerRetryAttemptId, providerRetryPrompt
} from "../../dist/runtime/providerRetry.js";
import { mapCodexAgentError } from "../../dist/runtime/builtinAgentErrorMappers.js";

const epoch = Date.parse("2026-09-13T00:00:00Z");
const iso = ms => new Date(ms).toISOString();
const failure = {
  source: "provider", phase: "turn-execute", category: "rate-limit",
  code: "provider.rate-limit", message: "Too many requests",
  raw: '{"codexErrorInfo":{"responseTooManyFailedAttempts":{"httpStatusCode":429}}}',
  inputDisposition: "accepted", sessionDisposition: "recoverable",
  retryable: true
};
function binding() {
  let value = createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "test",
    conversationId: "same-session", startedAt: iso(epoch)
  });
  value = beginProviderTurn(value, {
    attemptId: "original", authorityEpoch: 1, submittedAt: iso(epoch),
    input: { kind: "text", text: "Finish the existing work." }, retrySupported: true
  });
  return acceptProviderTurn(value, {
    attemptId: "original", nativeTurnId: "turn-0", acceptedAt: iso(epoch)
  });
}
function fail(value, at) {
  value = settleProviderTurn(value, {
    attemptId: value.run.attemptId, nativeTurnId: value.run.nativeTurnId,
    status: "failed", settledAt: iso(at)
  });
  return recordProviderFailure(value, { error: failure, failureRef: value.run.attemptId, at, random: () => 0 });
}

test("five consecutive automatic attempts survive new Turns; only exact success resets the chain", () => {
  let value = fail(binding(), epoch);
  for (let n = 1; n <= 5; n++) {
    const due = Date.parse(value.retry.nextEligibleAt);
    value = admitProviderRetry(value, { attemptId: `retry-${n}`, at: due });
    value = beginProviderTurn(value, {
      attemptId: `retry-${n}`, authorityEpoch: 1, submittedAt: iso(due), retrySupported: true
    });
    value = acceptProviderTurn(value, {
      attemptId: `retry-${n}`, nativeTurnId: `turn-${n}`, acceptedAt: iso(due)
    });
    assert.equal(value.retry.attempts, n, "acceptance must not reset the failure streak");
    value = fail(value, due + 1);
    value = JSON.parse(JSON.stringify(value)); // persisted/reloaded state is sufficient
  }
  assert.equal(value.retry.status, "exhausted");
  assert.throws(() => admitProviderRetry(value, { attemptId: "sixth-retry", at: epoch + 600_000 }));

  let recovered = fail(binding(), epoch);
  const due = Date.parse(recovered.retry.nextEligibleAt);
  recovered = admitProviderRetry(recovered, { attemptId: "recovered", at: due });
  recovered = beginProviderTurn(recovered, {
    attemptId: "recovered", authorityEpoch: 1, submittedAt: iso(due), retrySupported: true
  });
  recovered = acceptProviderTurn(recovered, {
    attemptId: "recovered", nativeTurnId: "success", acceptedAt: iso(due)
  });
  recovered = settleProviderTurn(recovered, {
    attemptId: "recovered", nativeTurnId: "success", status: "completed", settledAt: iso(due + 1)
  });
  assert.equal(recovered.retry.status, "recovered");
  assert.equal(providerRetryProjection(recovered).attempts, 0);
  recovered = beginProviderTurn(recovered, {
    attemptId: "new-work", authorityEpoch: 1, submittedAt: iso(due + 2),
    input: { kind: "text", text: "Next work" }, retrySupported: true
  });
  recovered = acceptProviderTurn(recovered, {
    attemptId: "new-work", nativeTurnId: "new-turn", acceptedAt: iso(due + 2)
  });
  recovered = fail(recovered, due + 3);
  assert.equal(recovered.retry.attempts, 0);
  assert.equal(recovered.retryHistory.length, 1);
  for (let n = 1; n <= 5; n++) {
    const due = Date.parse(recovered.retry.nextEligibleAt);
    const attemptId = providerRetryAttemptId(recovered.retry);
    recovered = admitProviderRetry(recovered, { attemptId, at: due });
    recovered = beginProviderTurn(recovered, {
      attemptId, authorityEpoch: 1, submittedAt: iso(due), retrySupported: true
    });
    recovered = acceptProviderTurn(recovered, { attemptId, nativeTurnId: `fresh-${n}`, acceptedAt: iso(due) });
    recovered = fail(recovered, due + 1);
    assert.equal(recovered.retry.attempts, n);
  }
  assert.equal(recovered.retry.status, "exhausted");
});

test("terminal proof, Retry-After, deadline and cancellation bound automatic admission", () => {
  const active = binding();
  assert.equal(recordProviderFailure(active, {
    error: failure, failureRef: "internal-retry", at: epoch, random: () => 0
  }), active, "native internal retries must not create another Turn");
  const failed = settleProviderTurn(active, {
    attemptId: "original", nativeTurnId: "turn-0", status: "failed", settledAt: iso(epoch)
  });
  for (const error of [
    { ...failure, inputDisposition: "unknown" },
    { ...failure, retryable: undefined },
    { ...failure, retryable: false, category: "access" }
  ]) assert.equal(recordProviderFailure(failed, { error, failureRef: "f", at: epoch, random: () => 0 }).retry, undefined);
  const waiting = recordProviderFailure(failed, {
    error: { ...failure, retryAfterMs: 30_000 }, failureRef: "f", at: epoch, random: () => 0
  });
  assert.ok(Date.parse(waiting.retry.nextEligibleAt) > epoch + 30_000);
  assert.throws(() => admitProviderRetry(waiting, { attemptId: "early", at: epoch + 29_999 }));
  const exhausted = recordProviderFailure(failed, {
    error: { ...failure, retryAfterMs: 600_000 }, failureRef: "f", at: epoch, random: () => 0
  });
  assert.equal(exhausted.retry.status, "exhausted");
  const distant = recordProviderFailure(failed, {
    error: { ...failure, retryAfterMs: Number.MAX_SAFE_INTEGER }, failureRef: "distant", at: epoch, random: () => 1
  });
  assert.equal(distant.retry.status, "exhausted");
  assert.equal(distant.retry.error.retryAfterMs, Number.MAX_SAFE_INTEGER);
  assert.throws(() => admitProviderRetry(distant, { attemptId: "too-early", at: epoch + 600_000 }));
  const cancelled = cancelProviderRetry(waiting, "user-cancelled", epoch + 1);
  assert.equal(cancelled.retry.status, "cancelled");
  assert.throws(() => admitProviderRetry(cancelled, { attemptId: "late", at: epoch + 60_000 }));
  assert.equal(mapCodexAgentError({ message: "Some text mentions 429", raw: "429" }).retryable, undefined);
  assert.equal(mapCodexAgentError({
    message: "quota", raw: '{"code":"insufficient_quota","statusCode":429}'
  }).retryable, false);
  assert.equal(mapCodexAgentError({
    message: "limited", raw: '{"statusCode":429,"headers":{"Retry-After":"30"}}'
  }).retryAfterMs, 30_000);
});

test("busy admission has a fresh transport identity without spending a model attempt or changing recovery intent", () => {
  let value = fail(binding(), epoch);
  const before = providerRetryPrompt(value.retry, "Original reference");
  const firstId = providerRetryAttemptId(value.retry);
  const due = Date.parse(value.retry.nextEligibleAt);
  value = admitProviderRetry(value, { attemptId: firstId, at: due });
  value = beginProviderTurn(value, {
    attemptId: firstId, authorityEpoch: 1, submittedAt: iso(due), retrySupported: true
  });
  value = settleProviderTurnSubmission(value, {
    attemptId: firstId, status: "deferred", resolvedAt: iso(due), reason: "native busy"
  });
  value = deferProviderRetry(value, due);
  assert.equal(value.retry.attempts, 0);
  assert.notEqual(providerRetryAttemptId(value.retry), firstId);
  assert.equal(providerRetryPrompt(value.retry, "Original reference"), before);
  const nextId = providerRetryAttemptId(value.retry);
  const nextAt = Date.parse(value.retry.nextEligibleAt);
  value = admitProviderRetry(value, { attemptId: nextId, at: nextAt });
  value = beginProviderTurn(value, {
    attemptId: nextId, runId: "refused-run", authorityEpoch: 1, submittedAt: iso(nextAt), retrySupported: true
  });
  value = settleProviderTurnSubmission(value, {
    attemptId: nextId, status: "rejected", resolvedAt: iso(nextAt), reason: "metadata unavailable before native write"
  });
  value = deferProviderRetry(value, nextAt, "metadata unavailable before native write");
  assert.equal(value.retry.attempts, 0);
  assert.equal(value.retry.previousRunId, "refused-run", "Explicit recovery must retry the latest refused Run.");
  assert.equal(value.retry.successorRunId, undefined);
});
