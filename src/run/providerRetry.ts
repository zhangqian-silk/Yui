import { requireIdentity, requireText, requireTimestamp } from "../domain/validation.js";
import type { ProviderErrorClass } from "../lifecycle/providerErrorClass.js";

/**
 * Issue 04 — durable in-place retry projection for one AgentRun.
 *
 * While a transient Provider failure is being retried on the original Run and
 * Native Session, the Run stays `active` and carries this small projection.
 * It is the durable timer: `nextAttemptAt` survives a Controller restart, and
 * `attempt` preserves the retry lineage. Old readers ignore the field; when
 * the feature is disabled the projection is never written.
 */
export type AgentRunProviderRetry = Readonly<{
  schemaVersion: 1;
  /** The classified failure that is being retried. */
  errorClass: ProviderErrorClass;
  /** Consecutive transient failures observed on this Run lineage. */
  attempt: number;
  firstFailureAt: string;
  lastFailureAt: string;
  /**
   * When the Controller may re-push the original input. `undefined` while the
   * Run is in-flight (a retry was dispatched and no outcome is known yet) or
   * when the class blocks automatic retry (e.g. `policy-denied`).
   */
  nextAttemptAt?: string;
  /** Exact launch identity being retried; proves the Session never changed. */
  launchId?: string;
  /** Exact native Session identity being retried. */
  nativeSessionId?: string;
  lastErrorSummary: string;
}>;

export const PROVIDER_RETRY_BASE_DELAY_MS = 1_000;
export const PROVIDER_RETRY_MAX_DELAY_MS = 60_000;

/**
 * Bounded exponential backoff. The delay is uncapped in attempt count (Issue
 * 04 retries transient failures indefinitely with backoff) but capped in
 * interval so a hot loop can never occupy the control plane.
 */
export function nextProviderRetryDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error(`Provider retry attempt must be a positive integer: ${String(attempt)}.`);
  }
  const exponent = Math.min(attempt - 1, 10);
  return Math.min(
    PROVIDER_RETRY_MAX_DELAY_MS,
    PROVIDER_RETRY_BASE_DELAY_MS * (2 ** exponent)
  );
}

export function validateAgentRunProviderRetry(
  value: AgentRunProviderRetry
): AgentRunProviderRetry {
  if (value.schemaVersion !== 1) {
    throw new Error("Agent run providerRetry must use schemaVersion 1.");
  }
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 1) {
    throw new Error("Agent run providerRetry attempt must be a positive integer.");
  }
  requireTimestamp(value.firstFailureAt, "Agent run providerRetry firstFailureAt");
  requireTimestamp(value.lastFailureAt, "Agent run providerRetry lastFailureAt");
  if (Date.parse(value.lastFailureAt) < Date.parse(value.firstFailureAt)) {
    throw new Error("Agent run providerRetry lastFailureAt must not precede firstFailureAt.");
  }
  if (value.nextAttemptAt !== undefined) {
    requireTimestamp(value.nextAttemptAt, "Agent run providerRetry nextAttemptAt");
  }
  if (value.launchId !== undefined) {
    requireIdentity(value.launchId, "Agent run providerRetry launchId");
  }
  if (value.nativeSessionId !== undefined) {
    requireIdentity(value.nativeSessionId, "Agent run providerRetry nativeSessionId");
  }
  requireText(value.lastErrorSummary, "Agent run providerRetry lastErrorSummary");
  return value;
}

export type ScheduleProviderRetryInput = Readonly<{
  errorClass: ProviderErrorClass;
  launchId?: string;
  nativeSessionId?: string;
  lastErrorSummary: string;
  /**
   * When false, no `nextAttemptAt` is scheduled (e.g. `policy-denied`, which
   * blocks automatic retry and waits for an explicit Leader decision).
   */
  scheduleNextAttempt?: boolean;
}>;

/**
 * Records one more transient failure on a Run lineage. A fresh lineage starts
 * at attempt 1; an existing projection increments its attempt and keeps the
 * original `firstFailureAt`.
 */
export function scheduleProviderRetry(
  previous: AgentRunProviderRetry | undefined,
  input: ScheduleProviderRetryInput,
  now: Date
): AgentRunProviderRetry {
  const timestamp = now.toISOString();
  const attempt = (previous?.attempt ?? 0) + 1;
  const scheduleNextAttempt = input.scheduleNextAttempt ?? true;
  return validateAgentRunProviderRetry({
    schemaVersion: 1,
    errorClass: input.errorClass,
    attempt,
    firstFailureAt: previous?.firstFailureAt ?? timestamp,
    lastFailureAt: timestamp,
    ...(scheduleNextAttempt
      ? {
          nextAttemptAt: new Date(
            now.getTime() + nextProviderRetryDelayMs(attempt)
          ).toISOString()
        }
      : {}),
    ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
    ...(input.nativeSessionId === undefined ? {} : { nativeSessionId: input.nativeSessionId }),
    lastErrorSummary: input.lastErrorSummary
  });
}

/**
 * Marks the projection in-flight: the retry has been dispatched and no
 * `nextAttemptAt` is due until the next outcome arrives.
 */
export function markProviderRetryInFlight(
  value: AgentRunProviderRetry,
  now: Date
): AgentRunProviderRetry {
  if (value.nextAttemptAt === undefined) return value;
  // Omit `nextAttemptAt` entirely (not `undefined`, which the file store
  // rejects) so the projection is durably in-flight until the next outcome.
  const { nextAttemptAt: _nextAttemptAt, ...rest } = value;
  return validateAgentRunProviderRetry({
    ...rest,
    lastFailureAt: now.toISOString()
  });
}

/** True when the projection is due for another attempt at `now`. */
export function providerRetryIsDue(
  value: AgentRunProviderRetry,
  now: Date
): boolean {
  return value.nextAttemptAt !== undefined
    && Date.parse(value.nextAttemptAt) <= now.getTime();
}
