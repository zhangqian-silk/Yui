import {
  continuationOwnsWriterUmbrella,
  observeProviderContinuation,
  providerContinuationKey,
  type ProviderContinuation
} from "./providerContinuation.js";

export type ProviderContinuationQueryResult = Readonly<{
  quality: "exact" | "partial" | "unavailable";
  continuations: readonly Readonly<{
    key: string;
    execution: "active" | "quiescent" | "unknown";
    outcome: "pending" | "succeeded" | "failed" | "cancelled" | "unknown";
    resultRef?: string;
    mayWriteWorkspace: boolean;
    providerSequence?: number;
  }>[];
  detail?: string;
}>;

export interface ProviderContinuationMetadataPort {
  /** Metadata-only exact/partial query. Implementations must never start a model Turn. */
  queryKnownContinuations(input: Readonly<{
    providerNamespace: string;
    accountScope: string;
    conversationId: string;
    activationId: string;
    continuations: readonly Readonly<{ continuationId: string; generation: number }>[];
  }>): Promise<ProviderContinuationQueryResult>;
}

export type ProviderReconcileSchedule = Readonly<{
  key: string;
  attempts: number;
  consecutiveErrors: number;
  nextReconcileAt: string;
  circuitOpenUntil?: string;
}>;

export type ProviderReconcileResult = Readonly<{
  continuations: readonly ProviderContinuation[];
  schedule: ProviderReconcileSchedule | null;
  quality: "exact" | "partial" | "unavailable";
  changed: boolean;
}>;

const BASE_RECONCILE_MS = 2_000;
const MAX_RECONCILE_MS = 5 * 60_000;
const CIRCUIT_ERROR_LIMIT = 5;
const QUERY_TIMEOUT_MS = 5_000;

/**
 * Reconciles only already-known children, grouped under one Conversation and
 * Activation generation. Missing entries settle ownership only for an exact
 * snapshot; partial/unavailable absence is never terminal evidence.
 */
export async function reconcileKnownDetachedContinuations(input: Readonly<{
  port: ProviderContinuationMetadataPort;
  continuations: readonly ProviderContinuation[];
  previous?: ProviderReconcileSchedule;
  now: Date;
}>): Promise<ProviderReconcileResult> {
  const candidates = input.continuations.filter((entry) => (
    entry.attachment === "detached" && continuationOwnsWriterUmbrella(entry)
  ));
  if (candidates.length === 0) {
    return { continuations: input.continuations, schedule: null, quality: "exact", changed: false };
  }
  const first = candidates[0]!;
  const groupKey = [
    first.identity.providerNamespace,
    first.identity.accountScope,
    first.identity.conversationId,
    first.identity.activationId
  ].join("\u0000");
  if (candidates.some((entry) => [
    entry.identity.providerNamespace,
    entry.identity.accountScope,
    entry.identity.conversationId,
    entry.identity.activationId
  ].join("\u0000") !== groupKey)) {
    throw new Error("Provider reconcile input must contain one Conversation/Activation group.");
  }
  const nowMs = input.now.getTime();
  if (input.previous?.circuitOpenUntil !== undefined
    && Date.parse(input.previous.circuitOpenUntil) > nowMs) {
    return {
      continuations: input.continuations,
      schedule: input.previous,
      quality: "unavailable",
      changed: false
    };
  }
  let result: ProviderContinuationQueryResult;
  try {
    const raw = await withTimeout(input.port.queryKnownContinuations({
      providerNamespace: first.identity.providerNamespace,
      accountScope: first.identity.accountScope,
      conversationId: first.identity.conversationId,
      activationId: first.identity.activationId,
      continuations: Object.freeze(candidates.map((entry) => Object.freeze({
        continuationId: entry.identity.continuationId,
        generation: entry.identity.generation
      })))
    }), QUERY_TIMEOUT_MS);
    result = validateQueryResult(raw, new Set(candidates.map((entry) => (
      providerContinuationKey(entry.identity)
    ))));
  } catch {
    const errors = (input.previous?.consecutiveErrors ?? 0) + 1;
    const delay = backoff(input.previous?.attempts ?? 0);
    const circuitOpenUntil = errors >= CIRCUIT_ERROR_LIMIT
      ? new Date(nowMs + MAX_RECONCILE_MS).toISOString()
      : undefined;
    return {
      continuations: input.continuations,
      schedule: {
        key: groupKey,
        attempts: (input.previous?.attempts ?? 0) + 1,
        consecutiveErrors: errors,
        nextReconcileAt: new Date(nowMs + delay).toISOString(),
        ...(circuitOpenUntil === undefined ? {} : { circuitOpenUntil })
      },
      quality: "unavailable",
      changed: false
    };
  }
  const observations = new Map(result.continuations.map((entry) => [entry.key, entry]));
  let changed = false;
  const updated = input.continuations.map((continuation) => {
    const observed = observations.get(providerContinuationKey(continuation.identity));
    if (observed === undefined) {
      // Exact absence closes a known child mechanically, without inventing a
      // successful outcome or ResultRef. Partial absence preserves ownership.
      if (result.quality !== "exact") return continuation;
      const next = observeProviderContinuation(continuation, {
        execution: "quiescent",
        outcome: "unknown",
        attachment: "detached",
        observation: "exact",
        mayWriteWorkspace: false,
        observedAt: input.now.toISOString()
      });
      changed ||= next !== continuation;
      return next;
    }
    const next = observeProviderContinuation(continuation, {
      execution: observed.execution,
      outcome: observed.outcome,
      attachment: "detached",
      observation: result.quality,
      mayWriteWorkspace: observed.mayWriteWorkspace,
      observedAt: input.now.toISOString(),
      ...(observed.resultRef === undefined ? {} : { resultRef: observed.resultRef }),
      ...(observed.providerSequence === undefined
        ? {}
        : { providerSequence: observed.providerSequence })
    });
    changed ||= next !== continuation;
    return next;
  });
  const unsettled = updated.some((entry) => (
    entry.attachment === "detached" && continuationOwnsWriterUmbrella(entry)
  ));
  return {
    continuations: Object.freeze(updated),
    schedule: unsettled
      ? {
          key: groupKey,
          attempts: (input.previous?.attempts ?? 0) + 1,
          consecutiveErrors: 0,
          nextReconcileAt: new Date(nowMs + backoff(input.previous?.attempts ?? 0)).toISOString()
        }
      : null,
    quality: result.quality,
    changed
  };
}

function validateQueryResult(
  input: ProviderContinuationQueryResult,
  expectedKeys: ReadonlySet<string>
): ProviderContinuationQueryResult {
  if (input === null || typeof input !== "object"
    || !["exact", "partial", "unavailable"].includes(input.quality)
    || !Array.isArray(input.continuations)) {
    throw new Error("Provider continuation metadata response is invalid.");
  }
  const seen = new Set<string>();
  for (const entry of input.continuations) {
    if (entry === null || typeof entry !== "object"
      || typeof entry.key !== "string" || !expectedKeys.has(entry.key)
      || seen.has(entry.key)
      || !["active", "quiescent", "unknown"].includes(entry.execution)
      || !["pending", "succeeded", "failed", "cancelled", "unknown"].includes(entry.outcome)
      || typeof entry.mayWriteWorkspace !== "boolean"
      || (entry.execution === "active" && entry.outcome !== "pending")
      || (entry.execution === "quiescent" && entry.outcome === "pending")
      || (entry.providerSequence !== undefined
        && (!Number.isSafeInteger(entry.providerSequence) || entry.providerSequence < 0))) {
      throw new Error("Provider continuation metadata entry is invalid or conflicting.");
    }
    seen.add(entry.key);
  }
  return input;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Provider continuation metadata query timed out.")),
          timeoutMs
        );
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function backoff(attempts: number): number {
  return Math.min(MAX_RECONCILE_MS, BASE_RECONCILE_MS * (2 ** Math.min(attempts, 8)));
}
