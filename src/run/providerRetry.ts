import { createHash } from "node:crypto";
import { requireIdentity, requireText, requireTimestamp } from "../domain/validation.js";
import type { ProviderErrorClass } from "../lifecycle/providerErrorClass.js";

export type ProviderRetryState = "scheduled" | "dispatching" | "awaiting-progress" | "blocked";

/**
 * One bounded failure episode on an unchanged Run + native Session lineage.
 * Historical events retain prior episodes; this active projection is deleted
 * as soon as correlated provider input/output progress is durable.
 */
export type AgentRunProviderRetry = Readonly<{
  schemaVersion: 2;
  episodeId: string;
  /** Exact canonical failure event that most recently advanced this episode. */
  failureEventId: string;
  policyVersion: 1;
  state: ProviderRetryState;
  errorClass: ProviderErrorClass;
  /** Failures in the current episode, including the initial failed request. */
  consecutiveFailures: number;
  /** Continuation retries actually dispatched after the initial failure. */
  dispatchedRetries: number;
  maxRetries: number;
  firstFailureAt: string;
  lastFailureAt: string;
  episodeDeadlineAt: string;
  nextAttemptAt?: string;
  lastRetryReceiptId?: string;
  launchId?: string;
  nativeSessionId?: string;
  failedNativeTurnId?: string;
  lastErrorSummary: string;
}>;

export const PROVIDER_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000, 15_000] as const);
export const PROVIDER_RETRY_MAX_DISPATCHES = PROVIDER_RETRY_DELAYS_MS.length;
export const PROVIDER_RETRY_EPISODE_WINDOW_MS = 600_000;
/** Durable configuration keeps the historical name for compatibility. */
export const PROVIDER_RETRY_MAX_WINDOW_MS = PROVIDER_RETRY_EPISODE_WINDOW_MS;

export function nextProviderRetryDelayMs(retryIndex: number): number {
  if (!Number.isSafeInteger(retryIndex)
    || retryIndex < 1
    || retryIndex > PROVIDER_RETRY_MAX_DISPATCHES) {
    throw new Error(`Provider retry index is out of range: ${String(retryIndex)}.`);
  }
  return PROVIDER_RETRY_DELAYS_MS[retryIndex - 1]!;
}

/**
 * True when the retry lineage has used its total wall-clock budget. The
 * budget is measured from the first classified failure, so repeated failures
 * never extend it.
 */
export function providerRetryBudgetExhausted(
  value: AgentRunProviderRetry,
  now: Date,
  maxWindowMs: number = PROVIDER_RETRY_MAX_WINDOW_MS
): boolean {
  if (!Number.isSafeInteger(maxWindowMs) || maxWindowMs <= 0) {
    throw new Error(`Provider retry max window must be a positive integer: ${String(maxWindowMs)}.`);
  }
  return Math.min(
    Date.parse(value.episodeDeadlineAt),
    Date.parse(value.firstFailureAt) + maxWindowMs
  ) <= now.getTime();
}

export function validateAgentRunProviderRetry(
  value: AgentRunProviderRetry
): AgentRunProviderRetry {
  if (value.schemaVersion !== 2) {
    throw new Error("Agent run providerRetry must use schemaVersion 2.");
  }
  if (!["scheduled", "dispatching", "awaiting-progress", "blocked"].includes(value.state)) {
    throw new Error("Agent run providerRetry state is invalid.");
  }
  requireIdentity(value.episodeId, "Agent run providerRetry episodeId");
  requireIdentity(value.failureEventId, "Agent run providerRetry failureEventId");
  if (value.policyVersion !== 1) throw new Error("Provider retry policy version is invalid.");
  if (!Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures < 1) {
    throw new Error("Agent run providerRetry consecutiveFailures must be positive.");
  }
  if (!Number.isSafeInteger(value.dispatchedRetries)
    || value.dispatchedRetries < 0
    || value.dispatchedRetries > value.maxRetries) {
    throw new Error("Agent run providerRetry dispatchedRetries is invalid.");
  }
  if (value.maxRetries !== PROVIDER_RETRY_MAX_DISPATCHES) {
    throw new Error("Agent run providerRetry maxRetries is invalid.");
  }
  requireTimestamp(value.firstFailureAt, "Agent run providerRetry firstFailureAt");
  requireTimestamp(value.lastFailureAt, "Agent run providerRetry lastFailureAt");
  requireTimestamp(value.episodeDeadlineAt, "Agent run providerRetry episodeDeadlineAt");
  if (Date.parse(value.lastFailureAt) < Date.parse(value.firstFailureAt)) {
    throw new Error("Agent run providerRetry lastFailureAt precedes firstFailureAt.");
  }
  if (Date.parse(value.episodeDeadlineAt) <= Date.parse(value.firstFailureAt)) {
    throw new Error("Agent run providerRetry deadline must follow firstFailureAt.");
  }
  if ((value.state === "scheduled") !== (value.nextAttemptAt !== undefined)) {
    throw new Error("Only a scheduled providerRetry may carry nextAttemptAt.");
  }
  if (value.nextAttemptAt !== undefined) {
    requireTimestamp(value.nextAttemptAt, "Agent run providerRetry nextAttemptAt");
    if (Date.parse(value.nextAttemptAt) > Date.parse(value.episodeDeadlineAt)) {
      throw new Error("Agent run providerRetry next attempt exceeds its episode deadline.");
    }
  }
  if ((value.state === "dispatching" || value.state === "awaiting-progress")
    !== (value.lastRetryReceiptId !== undefined)) {
    throw new Error("An in-flight providerRetry requires one retry receipt identity.");
  }
  if (value.lastRetryReceiptId !== undefined) {
    requireIdentity(value.lastRetryReceiptId, "Agent run providerRetry receipt id");
  }
  if (value.launchId !== undefined) requireIdentity(value.launchId, "Agent run providerRetry launchId");
  if (value.nativeSessionId !== undefined) {
    requireIdentity(value.nativeSessionId, "Agent run providerRetry nativeSessionId");
  }
  if (value.failedNativeTurnId !== undefined) {
    requireIdentity(value.failedNativeTurnId, "Agent run providerRetry failed native Turn id");
  }
  requireText(value.lastErrorSummary, "Agent run providerRetry lastErrorSummary");
  return value;
}

export type ScheduleProviderRetryInput = Readonly<{
  failureEventId: string;
  errorClass: ProviderErrorClass;
  launchId?: string;
  nativeSessionId?: string;
  failedNativeTurnId?: string;
  lastErrorSummary: string;
  scheduleNextAttempt?: boolean;
  retryAfterMs?: number;
}>;

export type ProviderRetryScheduleDecision =
  | Readonly<{ outcome: "scheduled" | "blocked"; retry: AgentRunProviderRetry }>
  | Readonly<{ outcome: "exhausted"; reason: "attempts" | "window" | "retry-after-window" }>;

/** Advance one failure episode without ever changing the native Session. */
export function scheduleProviderRetry(
  previous: AgentRunProviderRetry | undefined,
  input: ScheduleProviderRetryInput,
  now: Date
): ProviderRetryScheduleDecision {
  const at = now.toISOString();
  const firstFailureAt = previous?.firstFailureAt ?? at;
  const episodeDeadlineAt = previous?.episodeDeadlineAt
    ?? new Date(now.getTime() + PROVIDER_RETRY_EPISODE_WINDOW_MS).toISOString();
  if (now.getTime() >= Date.parse(episodeDeadlineAt)) {
    return Object.freeze({ outcome: "exhausted", reason: "window" });
  }
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const dispatchedRetries = previous?.dispatchedRetries ?? 0;
  const schedule = input.scheduleNextAttempt ?? true;
  if (schedule && dispatchedRetries >= PROVIDER_RETRY_MAX_DISPATCHES) {
    return Object.freeze({ outcome: "exhausted", reason: "attempts" });
  }
  const state: ProviderRetryState = schedule ? "scheduled" : "blocked";
  const retryAfterMs = input.retryAfterMs;
  if (retryAfterMs !== undefined && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0)) {
    throw new Error("Provider retry Retry-After must be a positive safe integer.");
  }
  const delayMs = schedule
    ? Math.max(nextProviderRetryDelayMs(dispatchedRetries + 1), retryAfterMs ?? 0)
    : undefined;
  const nextAttemptAt = delayMs === undefined
    ? undefined
    : new Date(now.getTime() + delayMs).toISOString();
  if (nextAttemptAt !== undefined && Date.parse(nextAttemptAt) > Date.parse(episodeDeadlineAt)) {
    return Object.freeze({
      outcome: "exhausted",
      reason: retryAfterMs === undefined ? "window" : "retry-after-window"
    });
  }
  const retry = validateAgentRunProviderRetry({
    schemaVersion: 2,
    episodeId: previous?.episodeId ?? createHash("sha256")
      .update(`${firstFailureAt}\0${input.nativeSessionId ?? "unknown"}\0${input.launchId ?? "unknown"}`)
      .digest("hex"),
    failureEventId: requireIdentity(input.failureEventId, "Provider failure event id"),
    policyVersion: 1,
    state,
    errorClass: input.errorClass,
    consecutiveFailures,
    dispatchedRetries,
    maxRetries: PROVIDER_RETRY_MAX_DISPATCHES,
    firstFailureAt,
    lastFailureAt: at,
    episodeDeadlineAt,
    ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
    ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
    ...(input.nativeSessionId === undefined ? {} : { nativeSessionId: input.nativeSessionId }),
    ...(input.failedNativeTurnId === undefined
      ? {}
      : { failedNativeTurnId: input.failedNativeTurnId }),
    lastErrorSummary: input.lastErrorSummary
  });
  return Object.freeze({ outcome: schedule ? "scheduled" : "blocked", retry });
}

/** Mark that one short continuation request was dispatched and now awaits any correlated progress. */
export function prepareProviderRetryDispatch(
  value: AgentRunProviderRetry,
  receiptId: string,
  now: Date
): AgentRunProviderRetry {
  if (value.state !== "scheduled" || value.nextAttemptAt === undefined) return value;
  if (now.getTime() > Date.parse(value.episodeDeadlineAt)) {
    throw new Error("Provider retry episode expired before dispatch.");
  }
  const { nextAttemptAt: _nextAttemptAt, ...rest } = value;
  return validateAgentRunProviderRetry({
    ...rest,
    state: "dispatching",
    lastRetryReceiptId: requireIdentity(receiptId, "Provider retry receipt id")
  });
}

export function markProviderRetryDispatched(
  value: AgentRunProviderRetry
): AgentRunProviderRetry {
  if (value.state !== "dispatching") return value;
  return validateAgentRunProviderRetry({
    ...value,
    state: "awaiting-progress",
    dispatchedRetries: value.dispatchedRetries + 1
  });
}

export function providerRetryIsDue(value: AgentRunProviderRetry, now: Date): boolean {
  return value.state === "scheduled"
    && value.nextAttemptAt !== undefined
    && Date.parse(value.nextAttemptAt) <= now.getTime();
}

/**
 * Next Controller wake for an active automatic retry episode. Scheduled
 * retries wake to dispatch; an in-flight retry wakes only at the episode
 * deadline so silence cannot strand the Run forever. Blocked states are
 * intentionally excluded because they require native/user evidence rather
 * than an automatic lifecycle transition.
 */
export function providerRetryWakeAt(value: AgentRunProviderRetry): string | null {
  if (value.state === "scheduled") return value.nextAttemptAt ?? null;
  if (value.state === "dispatching" || value.state === "awaiting-progress") {
    return value.episodeDeadlineAt;
  }
  return null;
}

/** Delay a control-plane recovery gap without changing either failure counter. */
export function deferProviderRetry(
  value: AgentRunProviderRetry,
  now: Date
): AgentRunProviderRetry | null {
  const deadline = Date.parse(value.episodeDeadlineAt);
  if (now.getTime() >= deadline) return null;
  const { lastRetryReceiptId: _receipt, nextAttemptAt: _next, ...rest } = value;
  return validateAgentRunProviderRetry({
    ...rest,
    state: "scheduled",
    nextAttemptAt: new Date(Math.min(now.getTime() + 15_000, deadline)).toISOString()
  });
}

/** Short recovery instruction; it cannot repeat the Task Assignment body. */
export function serializeProviderRetryEnvelope(input: Readonly<{
  taskId: string;
  runId: string;
  roleName: string;
  retry: AgentRunProviderRetry;
}>): string {
  validateAgentRunProviderRetry(input.retry);
  const retryOrdinal = input.retry.state === "dispatching"
    ? input.retry.dispatchedRetries + 1
    : input.retry.dispatchedRetries;
  return [
    "Yui managed in-Session continuation retry.",
    `task=${requireIdentity(input.taskId, "Provider retry task id")} run=${requireIdentity(input.runId, "Provider retry run id")} role=${requireIdentity(input.roleName, "Provider retry role")}`,
    `episode=${input.retry.episodeId} retry=${retryOrdinal}/${PROVIDER_RETRY_MAX_DISPATCHES} receipt=${input.retry.lastRetryReceiptId ?? "pending"}`,
    `failureEvent=${input.retry.failureEventId}`,
    ...(input.retry.failedNativeTurnId === undefined
      ? []
      : [`retryOfTurn=${input.retry.failedNativeTurnId}`]),
    "Continue the existing native conversation from its latest accepted state. Do not repeat completed work; load exact Run deltas if needed."
  ].join("\n");
}

export type PendingProviderRetry = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  state: Exclude<ProviderRetryState, "blocked">;
  /** Dispatch time for scheduled work, episode deadline for in-flight work. */
  dueAt: string;
}>;
