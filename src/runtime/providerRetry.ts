import type { StandardAgentError } from "./agentError.js";
import type { ProviderRuntimeBinding, ProviderTurn } from "./providerRuntimeIdentity.js";

/** Existing durable input, not another copy of a Message or Assignment. */
export type ProviderInput = Readonly<
  | { kind: "run"; taskId: string; runId: string }
  | { kind: "wake"; taskId: string; wakeId: string }
  | { kind: "message"; roleName: string; messageId: string }
  // The controlled console has no Message. Its original input is stored once
  // at the same admission boundary as its owned delivery identity.
  | { kind: "text"; text: string }
>;

export type ProviderRetry = Readonly<{
  policyVersion: 1;
  chainId: string;
  status: "waiting" | "in-flight" | "recovered" | "cancelled" | "exhausted" | "needs-attention";
  input: ProviderInput;
  nativeSessionId: string;
  authorityEpoch: number;
  attempts: number;
  transportSequence: number;
  startedAt: string;
  intentAt: string;
  deadline: string;
  nextEligibleAt: string;
  updatedAt: string;
  failedAttemptId: string;
  failureAttemptId: string;
  failedNativeTurnId?: string;
  previousRunId?: string;
  currentAttemptId?: string;
  successorRunId?: string;
  successorReviewRoundId?: string;
  successorAutomatic?: boolean;
  failureRef: string;
  error: StandardAgentError;
  reason?: string;
}>;

export const PROVIDER_RETRY_LIMIT = 5;
export const PROVIDER_RETRY_BUDGET_MS = 600_000;

export function providerRetryPending(binding: ProviderRuntimeBinding | null | undefined): boolean {
  return binding?.retry?.status === "waiting" || binding?.retry?.status === "in-flight";
}

/** Called only in the transaction recording the exact failed/rejected input. */
export function recordProviderFailure(
  binding: ProviderRuntimeBinding,
  input: Readonly<{ error: StandardAgentError; failureRef: string; at: number; random?: () => number; noProviderWrite?: boolean }>
): ProviderRuntimeBinding {
  let turn = binding.run;
  const previous = binding.retry;
  if (turn === null || !["failed", "rejected", "delivery-unknown"].includes(turn.status)) return binding;
  turn = { ...turn, failure: { error: input.error, ref: input.failureRef } };
  binding = { ...binding, run: turn };
  if (turn.status === "delivery-unknown") return binding;
  if (previous?.currentAttemptId === turn.attemptId
    && ["cancelled", "exhausted", "needs-attention"].includes(previous.status)) return binding;
  if (previous?.failedAttemptId === turn.attemptId && previous.status !== "in-flight") return binding;
  if (input.error.retryable !== true || input.error.inputDisposition === "unknown"
    || input.error.sessionDisposition !== "recoverable"
    || binding.authority.owner !== "controller" || binding.retryDisabled === true
    || turn.status === "failed" && (turn.nativeTurnId === undefined || input.error.inputDisposition !== "accepted")) {
    return providerRetryPending(binding)
      ? cancelProviderRetry(binding, "failure-not-safely-retryable", input.at) : binding;
  }
  const continuing = previous?.status === "in-flight" && previous.currentAttemptId === turn.attemptId;
  const originalInput = continuing ? previous.input : turn.input;
  if (originalInput === undefined) return binding; // no owned input: never replay arbitrary native chat
  const current: ProviderRetry = {
    policyVersion: 1,
    chainId: continuing ? previous.chainId : turn.attemptId,
    status: "waiting",
    input: originalInput,
    nativeSessionId: binding.conversations.find(c => c.epoch === binding.currentConversationEpoch)!.conversationId,
    authorityEpoch: binding.authority.epoch,
    attempts: continuing ? previous.attempts - (input.noProviderWrite && previous.successorAutomatic !== false ? 1 : 0) : 0,
    transportSequence: continuing ? previous.transportSequence : 0,
    startedAt: continuing ? previous.startedAt : iso(input.at),
    intentAt: continuing ? previous.intentAt : turn.submittedAt,
    deadline: continuing ? previous.deadline : iso(input.at + PROVIDER_RETRY_BUDGET_MS),
    nextEligibleAt: iso(input.at),
    updatedAt: iso(input.at),
    failedAttemptId: turn.attemptId,
    failureAttemptId: turn.nativeTurnId !== undefined || !continuing ? turn.attemptId : previous.failureAttemptId,
    ...((turn.nativeTurnId ?? (continuing ? previous.failedNativeTurnId : undefined)) === undefined ? {}
      : { failedNativeTurnId: turn.nativeTurnId ?? previous!.failedNativeTurnId }),
    ...(turn.runId === undefined ? {} : { previousRunId: turn.runId }),
    failureRef: input.failureRef,
    error: input.error
  };
  const random = unitRandom(input.random ?? Math.random);
  const window = Math.min(60_000, 5_000 * 2 ** current.attempts);
  const backoff = Math.ceil(window * (0.5 + random / 2));
  const serverWait = input.error.retryAfterMs;
  const delay = serverWait === undefined ? backoff
    : Math.max(backoff, serverWait + 1 + Math.ceil(random * 1_000));
  const eligible = input.at + delay;
  const exhausted = current.attempts >= PROVIDER_RETRY_LIMIT || eligible >= Date.parse(current.deadline);
  return {
    ...binding,
    ...(!continuing && previous !== undefined
      ? { retryHistory: [...(binding.retryHistory ?? []), previous] } : {}),
    retry: {
      // A terminal chain has no next submission. Keep its bounded deadline
      // representable even for huge hints; the unshortened hint stays in error.
      ...current, nextEligibleAt: iso(exhausted ? Math.min(eligible, Date.parse(current.deadline)) : eligible),
      ...(turn.retrySupported !== true ? { status: "needs-attention", reason: "host-safe-retry-unsupported" }
        : exhausted ? { status: "exhausted", reason: current.attempts >= PROVIDER_RETRY_LIMIT
        ? "automatic-attempt-limit" : "retry-after-exceeds-deadline" } : {})
    }
  };
}

/** Atomically called at the shared native write admission, never by a timer alone. */
export function admitProviderRetry(
  binding: ProviderRuntimeBinding,
  input: Readonly<{ attemptId: string; at: number }>
): ProviderRuntimeBinding {
  const retry = binding.retry;
  if (retry?.status === "in-flight" && retry.currentAttemptId === input.attemptId) return binding;
  if (retry?.status !== "waiting"
    || input.at < Date.parse(retry.nextEligibleAt)
    || retry.successorAutomatic !== false && (binding.retryDisabled === true
      || input.at >= Date.parse(retry.deadline) || retry.attempts >= PROVIDER_RETRY_LIMIT)
    || binding.authority.owner !== "controller" || binding.authority.epoch !== retry.authorityEpoch
    || binding.conversations.find(c => c.epoch === binding.currentConversationEpoch)?.conversationId !== retry.nativeSessionId
    || binding.run?.attemptId !== retry.failedAttemptId
    || !["failed", "rejected", "deferred"].includes(binding.run.status)) {
    throw new Error("Provider retry is not eligible under the current input, Session, authority or budget.");
  }
  return { ...binding, retry: {
    ...retry, status: "in-flight", attempts: retry.attempts + (retry.successorAutomatic === false ? 0 : 1),
    transportSequence: retry.transportSequence + 1,
    currentAttemptId: input.attemptId, updatedAt: iso(input.at)
  } };
}

/** Busy/preflight refusal is not a model attempt. Keep its exact receipt visible. */
export function deferProviderRetry(
  binding: ProviderRuntimeBinding, at: number, reason?: string
): ProviderRuntimeBinding {
  const retry = binding.retry;
  if (retry?.status !== "in-flight" || retry.currentAttemptId !== binding.run?.attemptId) return binding;
  const { currentAttemptId: _attempt, successorRunId, ...remaining } = retry;
  return { ...binding, retry: {
    ...remaining, attempts: retry.attempts - (retry.successorAutomatic === false ? 0 : 1),
    failedAttemptId: binding.run!.attemptId,
    ...(reason === undefined && successorRunId !== undefined ? { successorRunId } : {}),
    ...(reason !== undefined && binding.run?.runId !== undefined ? { previousRunId: binding.run.runId } : {}),
    status: reason === undefined ? "waiting" : "needs-attention",
    nextEligibleAt: iso(Math.min(at + 1_000, Date.parse(retry.deadline))),
    updatedAt: iso(at), ...(reason === undefined ? {} : { reason })
  } };
}

export function cancelProviderRetry(
  binding: ProviderRuntimeBinding, reason: string, at: number
): ProviderRuntimeBinding {
  return !providerRetryPending(binding) ? binding : {
    ...binding, retry: { ...binding.retry!, status: "cancelled", reason, updatedAt: iso(at) }
  };
}

export function completeProviderRetry(
  binding: ProviderRuntimeBinding, turn: ProviderTurn
): ProviderRuntimeBinding {
  const retry = binding.retry;
  return retry === undefined || !["in-flight", "cancelled", "needs-attention"].includes(retry.status)
    || retry.currentAttemptId !== turn.attemptId
    || turn.status !== "completed" ? binding : {
      ...binding, retry: { ...retry, status: "recovered", updatedAt: turn.updatedAt }
    };
}

export function providerRetryAttemptId(retry: ProviderRetry): string {
  return `provider-retry:${retry.chainId}/${retry.transportSequence + 1}`;
}

export function providerRetryPrompt(retry: ProviderRetry, original: string): string {
  if (retry.failedNativeTurnId === undefined) return original;
  return [
    "Yui infrastructure recovery, not new user authorization.",
    `Continue the existing input after failed attempt ${retry.failureAttemptId}`,
    `(native Turn ${retry.failedNativeTurnId}; failure ${retry.failureRef}).`,
    "Read current authorized context and the original input. Inspect existing work and receipts first;",
    "continue only unfinished work. Preserve local changes and do not repeat confirmed side effects.",
    original
  ].join("\n");
}

/** The same presentation is consumed by CLI, Context and Web. */
export function providerRetryProjection(binding: ProviderRuntimeBinding | null | undefined) {
  const retry = binding?.retry;
  if (retry === undefined) return null;
  return {
    chainId: retry.chainId,
    status: retry.status === "in-flight" && binding?.run?.status === "delivery-unknown"
      ? "delivery-unknown" as const : retry.status,
    attempts: retry.status === "recovered" ? 0 : retry.attempts,
    limit: PROVIDER_RETRY_LIMIT, nextEligibleAt: retry.nextEligibleAt, deadline: retry.deadline,
    category: retry.error.category, preservesWork: true, nativeSessionId: retry.nativeSessionId,
    ...(retry.reason === undefined ? {} : { reason: retry.reason }),
    failureRef: retry.failureRef,
    ...(retry.previousRunId === undefined ? {} : { previousRunId: retry.previousRunId }),
    ...(retry.successorRunId === undefined ? {} : { successorRunId: retry.successorRunId })
  };
}

export function controlProviderRetry(
  binding: ProviderRuntimeBinding, action: "cancel" | "disable" | "enable", at: number
): ProviderRuntimeBinding {
  if (action === "enable") return { ...binding, retryDisabled: false };
  return { ...cancelProviderRetry(binding, `user-${action}`, at),
    ...(action === "disable" ? { retryDisabled: true } : {}) };
}

export function renderProviderRetry(binding: ProviderRuntimeBinding | null | undefined): string {
  const view = providerRetryProjection(binding);
  return view === null ? `Provider retry: ${binding?.retryDisabled ? "disabled" : "none"}`
    : `Provider retry: ${view.category}/${view.status}; ${view.attempts}/${view.limit}; next=${view.nextEligibleAt}; `
      + `deadline=${view.deadline}; existing work preserved${view.reason === undefined ? "" : `; ${view.reason}`}`;
}

export function validateProviderRetry(retry: ProviderRetry): void {
  if (retry.policyVersion !== 1 || !["waiting", "in-flight", "recovered", "cancelled", "exhausted", "needs-attention"].includes(retry.status)
    || !Number.isSafeInteger(retry.attempts) || retry.attempts < 0 || retry.attempts > PROVIDER_RETRY_LIMIT
    || !Number.isSafeInteger(retry.transportSequence) || retry.transportSequence < retry.attempts
    || !Number.isSafeInteger(retry.authorityEpoch) || retry.authorityEpoch < 1
    || [retry.chainId, retry.nativeSessionId, retry.failedAttemptId, retry.failureRef].some(v => typeof v !== "string" || v.length === 0)
    || [retry.startedAt, retry.intentAt, retry.deadline, retry.nextEligibleAt, retry.updatedAt].some(v => !Number.isFinite(Date.parse(v)))
    || Date.parse(retry.deadline) - Date.parse(retry.startedAt) !== PROVIDER_RETRY_BUDGET_MS
    || retry.status === "in-flight" && !retry.currentAttemptId) throw new Error("Invalid Provider retry record.");
  validateProviderInput(retry.input);
}

export function validateProviderInput(input: ProviderInput): void {
  const fields = input.kind === "run" ? [input.taskId, input.runId]
    : input.kind === "wake" ? [input.taskId, input.wakeId]
    : input.kind === "message" ? [input.roleName, input.messageId]
    : input.kind === "text" ? [input.text] : [];
  if (fields.length === 0 || fields.some(v => typeof v !== "string" || !v.trim())) {
    throw new Error("Invalid owned Provider input.");
  }
}

function iso(at: number): string { return new Date(at).toISOString(); }
function unitRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Retry RNG must return a unit fraction.");
  return value;
}
