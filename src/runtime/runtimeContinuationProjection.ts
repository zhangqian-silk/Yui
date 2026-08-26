import type { TaskEvent } from "../event/taskEvent.js";
import { foldContinuationObservation } from "./continuationManager.js";
import {
  continuationOwnsWriterUmbrella,
  providerContinuationKey,
  type ProviderContinuation
} from "./providerContinuation.js";
import {
  runtimeObservationFromTaskEvent,
  type RuntimeObservation
} from "./runtimeObservation.js";

export function projectProviderContinuations(
  events: readonly TaskEvent[]
): readonly ProviderContinuation[] {
  const projected = new Map<string, ProviderContinuation>();
  const observations = events
    .map(runtimeObservationFromTaskEvent)
    .filter((entry): entry is RuntimeObservation => (
      entry !== null && entry.kind.startsWith("continuation.")
    ));
  // Fold in durable Task-event order. Provider sequence is an identity-local
  // monotonic fence applied by ProviderContinuation; it is not a global clock.
  // In particular, Controller-derived exact snapshots intentionally have no
  // Provider sequence and must not be moved before the Provider start fact.
  for (const observation of observations) {
    const fence = observation.fence;
    if (fence.conversationId === undefined || fence.activationId === undefined
      || fence.continuationId === undefined || fence.continuationGeneration === undefined) {
      continue;
    }
    const key = [
      fence.driverId,
      fence.agentId,
      fence.conversationId,
      fence.activationId,
      fence.continuationId,
      fence.continuationGeneration
    ].join("\u0000");
    const result = foldContinuationObservation(projected.get(key) ?? null, observation);
    projected.set(providerContinuationKey(result.continuation.identity), result.continuation);
  }
  return Object.freeze([...projected.values()].sort((left, right) => (
    providerContinuationKey(left.identity).localeCompare(providerContinuationKey(right.identity))
  )));
}

export function blockingProviderContinuations(
  events: readonly TaskEvent[]
): readonly ProviderContinuation[] {
  return projectProviderContinuations(events).filter((entry) => (
    continuationOwnsWriterUmbrella(entry) || entry.identityConflict
  ));
}

/** Exact Run-scoped writer fence shared by terminalization and retry paths. */
export function runOwnsBlockingProviderContinuation(
  events: readonly TaskEvent[],
  owner: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    agentId: string;
  }>
): boolean {
  return blockingProviderContinuations(events).some((continuation) => (
    continuation.taskId === owner.taskId
    && continuation.roleName === owner.roleName
    && continuation.runId === owner.runId
    && continuation.identity.accountScope === owner.agentId
  ));
}
