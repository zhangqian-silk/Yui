import type { TaskEvent } from "../event/taskEvent.js";
import { builtinDriverIdForAdapter } from "./builtinAgentDrivers.js";
import {
  runtimeObservationFromTaskEvent,
  type RuntimeObservation,
  type RuntimeUsageSnapshot
} from "./runtimeObservation.js";

/** Exact native Session generation whose token observations may be combined. */
export type SessionTokenIdentity = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  driverId: string;
  launchId: string;
  nativeSessionId: string;
  sessionGenerationId: string;
}>;

export type SessionCumulativeTokenMetric =
  | Readonly<{ status: "unobserved" }>
  | Readonly<{
      status: "observed";
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      /** Informational subset of inputTokens; never added to totalTokens. */
      cachedInputTokens?: number;
      /** Informational subset of outputTokens; never added to totalTokens. */
      reasoningTokens?: number;
    }>;

export type SessionMaximumRequestInputMetric =
  | Readonly<{ status: "unobserved" }>
  | Readonly<{
      status: "observed";
      inputTokens: number;
    }>;

export type SessionTokenMetrics = Readonly<{
  identity: SessionTokenIdentity | null;
  cumulativeTotal: SessionCumulativeTokenMetric;
  maximumRequestInput: SessionMaximumRequestInputMetric;
}>;

export type SessionTokenIdentityInput = Readonly<{
  taskId?: string;
  roleName?: string;
  agentId?: string;
  adapterId?: string;
  launchId?: string;
  nativeSessionId?: string;
}>;

const UNOBSERVED = Object.freeze({ status: "unobserved" as const });

export function resolveSessionTokenIdentity(
  input: SessionTokenIdentityInput | null | undefined
): SessionTokenIdentity | null {
  if (input?.taskId === undefined
    || input.roleName === undefined
    || input.agentId === undefined
    || input.adapterId === undefined
    || input.launchId === undefined
    || input.nativeSessionId === undefined) return null;
  let driverId: string;
  try {
    driverId = builtinDriverIdForAdapter(input.adapterId);
  } catch {
    return null;
  }
  return Object.freeze({
    taskId: input.taskId,
    roleName: input.roleName,
    agentId: input.agentId,
    driverId,
    launchId: input.launchId,
    nativeSessionId: input.nativeSessionId,
    sessionGenerationId: input.launchId
  });
}

/**
 * Read-only projection over canonical runtime observations. Token values never
 * decide lifecycle, health, scheduling, resource admission, or workflow state.
 */
export function projectSessionTokenMetrics(
  events: readonly TaskEvent[],
  identity: SessionTokenIdentity | null
): SessionTokenMetrics {
  if (identity === null) return unobservedSessionTokenMetrics();
  const observations = events
    .map(runtimeObservationFromTaskEvent)
    .filter((observation): observation is RuntimeObservation => (
      observation !== null
      && observation.kind === "activity.observed"
      && observation.payload.usage !== undefined
      && matchesSessionGeneration(observation, identity)
    ))
    .sort(compareObservations);
  const request = observations.filter(({ payload }) => (
    payload.usage!.semantics === "request-context"
  ));
  const cumulative = observations.filter(({ payload }) => (
    payload.usage!.semantics === "cumulative-session"
  ));

  // A generation cannot switch counter semantics without an explicit fact
  // explaining how the two streams overlap. Remaining-context is capacity,
  // not consumption, and is intentionally absent from both metrics.
  if (request.length > 0 && cumulative.length > 0) {
    return unobservedSessionTokenMetrics(identity);
  }
  if (request.length > 0) return projectRequestSnapshots(identity, request);
  if (cumulative.length > 0) return projectCumulativeSnapshots(identity, cumulative);
  return unobservedSessionTokenMetrics(identity);
}

export function unobservedSessionTokenMetrics(
  identity: SessionTokenIdentity | null = null
): SessionTokenMetrics {
  return Object.freeze({
    identity: identity === null ? null : Object.freeze({ ...identity }),
    cumulativeTotal: UNOBSERVED,
    maximumRequestInput: UNOBSERVED
  });
}

function projectRequestSnapshots(
  identity: SessionTokenIdentity,
  observations: readonly RuntimeObservation[]
): SessionTokenMetrics {
  if (observations.some(({ payload }) => (
    payload.observationQuality === "partial"
    || payload.observationQuality === "unavailable"
  ))) return unobservedSessionTokenMetrics(identity);
  const requests = new Map<string, RuntimeUsageSnapshot>();
  for (const observation of observations) {
    const usage = observation.payload.usage!;
    const requestId = observation.payload.activityId ?? observation.semanticKey;
    // Structured providers may publish multiple snapshots for one stable
    // request identity. The latest snapshot supersedes the earlier delivery;
    // replays with the same identity never become a second request.
    requests.set(requestId, usage);
  }
  const values = [...requests.values()];
  const inputTokens = safeSum(values.map((usage) => usage.inputTokens));
  const outputTokens = safeSum(values.map((usage) => usage.outputTokens));
  if (inputTokens === null || outputTokens === null) {
    return unobservedSessionTokenMetrics(identity);
  }
  const totalTokens = safeAdd(inputTokens, outputTokens);
  if (totalTokens === null) return unobservedSessionTokenMetrics(identity);
  const cachedInputTokens = values.every((usage) => usage.cachedInputTokens !== undefined)
    ? safeSum(values.map((usage) => usage.cachedInputTokens!))
    : null;
  const reasoningTokens = values.every((usage) => usage.reasoningTokens !== undefined)
    ? safeSum(values.map((usage) => usage.reasoningTokens!))
    : null;
  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    cumulativeTotal: Object.freeze({
      status: "observed" as const,
      totalTokens,
      inputTokens,
      outputTokens,
      ...(cachedInputTokens === null ? {} : { cachedInputTokens }),
      ...(reasoningTokens === null ? {} : { reasoningTokens })
    }),
    maximumRequestInput: Object.freeze({
      status: "observed" as const,
      inputTokens: Math.max(...values.map((usage) => usage.inputTokens))
    })
  });
}

function projectCumulativeSnapshots(
  identity: SessionTokenIdentity,
  observations: readonly RuntimeObservation[]
): SessionTokenMetrics {
  const values = observations.map(({ payload }) => payload.usage!);
  const requestBoundaryIncomplete = observations.some(({ payload }) => (
    payload.observationQuality === "partial"
    || payload.observationQuality === "unavailable"
  ));
  let counterRollback = false;
  let maximumRequestInput: number | null = null;
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]!;
    const current = values[index]!;
    if (current.inputTokens < previous.inputTokens
      || current.outputTokens < previous.outputTokens) counterRollback = true;
    const requestInput = Math.max(0, current.inputTokens - previous.inputTokens);
    maximumRequestInput = maximumRequestInput === null
      ? requestInput
      : Math.max(maximumRequestInput, requestInput);
  }
  const latest = values.at(-1)!;
  const totalTokens = safeAdd(latest.inputTokens, latest.outputTokens);
  const cumulativeTotal: SessionCumulativeTokenMetric = counterRollback || totalTokens === null
    ? UNOBSERVED
    : Object.freeze({
        status: "observed" as const,
        totalTokens,
        inputTokens: latest.inputTokens,
        outputTokens: latest.outputTokens,
        ...(latest.cachedInputTokens === undefined
          ? {}
          : { cachedInputTokens: latest.cachedInputTokens }),
        ...(latest.reasoningTokens === undefined
          ? {}
          : { reasoningTokens: latest.reasoningTokens })
      });
  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    cumulativeTotal,
    maximumRequestInput: counterRollback
      || requestBoundaryIncomplete
      || maximumRequestInput === null
      ? UNOBSERVED
      : Object.freeze({ status: "observed" as const, inputTokens: maximumRequestInput })
  });
}

function matchesSessionGeneration(
  observation: RuntimeObservation,
  identity: SessionTokenIdentity
): boolean {
  const fence = observation.fence;
  return fence.taskId === identity.taskId
    && fence.roleName === identity.roleName
    && fence.agentId === identity.agentId
    && fence.driverId === identity.driverId
    && fence.launchId === identity.launchId
    && fence.nativeSessionId === identity.nativeSessionId
    && fence.sessionGenerationId === identity.sessionGenerationId;
}

function compareObservations(left: RuntimeObservation, right: RuntimeObservation): number {
  return left.receivedAt.localeCompare(right.receivedAt)
    || (left.sequence ?? -1) - (right.sequence ?? -1)
    || (left.ordinal ?? -1) - (right.ordinal ?? -1)
    || left.eventId.localeCompare(right.eventId);
}

function safeSum(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    total = safeAdd(total, value) ?? Number.NaN;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function safeAdd(left: number, right: number): number | null {
  const total = left + right;
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}
