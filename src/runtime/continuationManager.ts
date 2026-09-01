import { createHash } from "node:crypto";

import type { MailboxEntityRef, WorkSignal } from "../coordination/workMailbox.js";
import {
  createProviderContinuation,
  observeProviderContinuation,
  providerContinuationKey,
  recordProviderReport,
  type ProviderContinuation,
  type ProviderContinuationIdentity
} from "./providerContinuation.js";
import { createRuntimeObservation, type RuntimeObservation } from "./runtimeObservation.js";

export type ContinuationFoldResult = Readonly<{
  disposition: "created" | "updated" | "reported" | "settled" | "conflict" | "duplicate";
  continuation: ProviderContinuation;
}>;

export type ContinuationManagerStore = Readonly<{
  transaction<T>(callback: (store: ContinuationManagerTransaction) => T): T;
}>;

export type ContinuationManagerTransaction = Readonly<{
  getProviderContinuation(key: string): ProviderContinuation | null;
  saveProviderContinuation(value: ProviderContinuation): void;
  /** Returns false when the same semantic fact was already committed. */
  appendContinuationFactOnce(
    semanticKey: string,
    observation: RuntimeObservation,
    continuation: ProviderContinuation
  ): boolean;
  enqueueContinuationSignal(input: Readonly<{
    taskId: string;
    roleName: string;
    signal: WorkSignal;
  }>): void;
}>;

export function foldContinuationObservation(
  existing: ProviderContinuation | null,
  raw: RuntimeObservation
): ContinuationFoldResult {
  const observation = createRuntimeObservation(raw);
  if (!observation.kind.startsWith("continuation.")) {
    throw new Error("ContinuationManager requires a continuation observation.");
  }
  const identity = continuationIdentity(observation);
  const payload = observation.payload;
  const base = existing ?? createProviderContinuation({
    taskId: observation.fence.taskId!,
    roleName: observation.fence.roleName,
    turnId: observation.fence.turnId!,
    identity,
    ...(observation.fence.parentContinuationId === undefined
      ? {}
      : { parentContinuationId: observation.fence.parentContinuationId }),
    attachment: payload.attachment!,
    observation: payload.observationQuality!,
    // A report is model-visible information, not settlement evidence. When
    // it arrives before start, keep a conservative writer umbrella until an
    // exact continuation.settled or complete native-work snapshot releases it.
    mayWriteWorkspace: observation.kind === "continuation.reported"
      ? true
      : payload.mayWriteWorkspace!,
    observedAt: observation.observedAt ?? observation.receivedAt,
    ...(observation.sequence === undefined ? {} : { providerSequence: observation.sequence })
  });
  if (existing !== null && providerContinuationKey(existing.identity) !== providerContinuationKey(identity)) {
    throw new Error("Continuation observation identity does not match the existing projection.");
  }
  if (observation.kind === "continuation.reported") {
    const resultReceipt = durableResultReceipt(payload.summary);
    const next = recordProviderReport(base, {
      reportId: payload.reportId!,
      ...(payload.resultRef === undefined ? {} : { resultRef: payload.resultRef }),
      ...(payload.providerDeliveryRef === undefined
        ? {}
        : { providerDeliveryRef: payload.providerDeliveryRef }),
      ...resultReceipt,
      observedAt: observation.observedAt ?? observation.receivedAt
    }, observation.sequence);
    return {
      disposition: next === base ? "duplicate" : "reported",
      continuation: next
    };
  }
  const next = observeProviderContinuation(base, {
    execution: payload.execution!,
    outcome: payload.outcome!,
    attachment: payload.attachment!,
    observation: payload.observationQuality!,
    mayWriteWorkspace: payload.mayWriteWorkspace!,
    observedAt: observation.observedAt ?? observation.receivedAt,
    ...(payload.resultRef === undefined ? {} : { resultRef: payload.resultRef }),
    ...(observation.sequence === undefined ? {} : { providerSequence: observation.sequence })
  });
  return {
    disposition: next === base
      ? existing === null ? "created" : "duplicate"
      : next.identityConflict ? "conflict"
      : observation.kind === "continuation.settled" ? "settled"
      : existing === null ? "created" : "updated",
    continuation: next
  };
}

/**
 * The durable-result receipt for a native child report. Yui only claims
 * "durable-result" durability when it has actually persisted result content;
 * the sha256 digest makes replays idempotent and lets recovery verify the
 * result by digest. A report without persisted content stays best-effort.
 */
function durableResultReceipt(summary: string | undefined): Readonly<{
  resultDigest?: string;
  resultSize?: number;
}> {
  if (summary === undefined || summary.trim().length === 0) return {};
  return Object.freeze({
    resultDigest: createHash("sha256").update(summary).digest("hex"),
    resultSize: summary.length
  });
}

/**
 * Commits the semantic continuation fact and its Leader notification before
 * releasing child ownership. The surrounding TaskStore transaction is the
 * crash boundary; a replay with the same semanticKey becomes a no-op.
 */
export function applyContinuationObservationAtomically(
  store: ContinuationManagerStore,
  raw: RuntimeObservation,
  factRef: MailboxEntityRef
): ContinuationFoldResult {
  const observation = createRuntimeObservation(raw);
  const identity = continuationIdentity(observation);
  return store.transaction((tx) => {
    const result = foldContinuationObservation(
      tx.getProviderContinuation(providerContinuationKey(identity)),
      observation
    );
    if (!tx.appendContinuationFactOnce(
      observation.semanticKey,
      observation,
      result.continuation
    )) {
      return { disposition: "duplicate", continuation: result.continuation };
    }
    tx.saveProviderContinuation(result.continuation);
    if (result.disposition === "reported" || result.disposition === "settled"
      || result.disposition === "conflict") {
      tx.enqueueContinuationSignal({
        taskId: result.continuation.taskId,
        roleName: "leader",
        signal: {
          reason: result.disposition === "reported"
            ? "provider-continuation-report"
            : result.disposition === "settled"
              ? "provider-continuation-settled"
              : "provider-continuation-identity-conflict",
          refs: [factRef],
          occurredAt: observation.observedAt ?? observation.receivedAt,
          source: "continuation-manager",
          dedupeKey: observation.semanticKey
        }
      });
    }
    return result;
  });
}

function continuationIdentity(observation: RuntimeObservation): ProviderContinuationIdentity {
  const fence = observation.fence;
  if (fence.taskId === undefined || fence.turnId === undefined
    || fence.conversationId === undefined || fence.activationId === undefined
    || fence.continuationId === undefined) {
    throw new Error("Continuation observation fence is incomplete.");
  }
  return {
    providerNamespace: fence.driverId,
    accountScope: fence.agentId,
    conversationId: fence.conversationId,
    activationId: fence.activationId,
    continuationId: fence.continuationId,
    generation: fence.continuationGeneration!
  };
}
