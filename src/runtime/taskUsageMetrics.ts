import type { AgentRun } from "../agentRun/agentRun.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { Task } from "../task/task.js";
import { builtinDriverIdForAdapter } from "./builtinAgentDrivers.js";
import {
  isRuntimeTokenEvidence,
  runtimeObservationFromTaskEvent,
  type RuntimeObservation
} from "./runtimeObservation.js";
import {
  projectSessionTokenObservations,
  unobservedSessionTokenMetrics,
  type SessionTokenIdentity,
  type SessionTokenMetrics
} from "./sessionTokenMetrics.js";

/** A known value is known only within the declared scope, never a billing claim. */
export type UsageMetric = Readonly<{
  value: number | null;
  status: "known" | "partial" | "unknown";
  reasons: readonly string[];
}>;

export type TaskUsageMetrics = Readonly<{
  /** Audit windows never turn a last cumulative snapshot into window consumption. */
  scope: "task-lifetime";
  taskId: string;
  workItemId?: string;
  observedThrough: string | null;
  tokens: UsageMetric;
  toolCalls: UsageMetric;
  elapsedSeconds: UsageMetric;
  executionSeconds: UsageMetric;
  coverage: Readonly<{
    basis: "task-fenced-observations";
    observedSessions: number;
    tokenSessions: number;
    /** No promise of Provider billing completeness or a coverage percentage. */
    completeness: "observed-sources-only";
  }>;
  sessions: readonly Readonly<{
    identity: SessionTokenIdentity;
    semantics: readonly string[];
    sources: readonly string[];
    observedThrough: string;
    tokens: UsageMetric;
    /** Raw Session counter, distinct from safely attributable Task consumption. */
    metrics: SessionTokenMetrics;
  }>[];
}>;

export type TaskUsageInput = Readonly<{
  task: Pick<Task, "id" | "status" | "createdAt" | "completedAt" | "retiredAt">;
  events: readonly TaskEvent[];
  runs: readonly AgentRun[];
  workItemId?: string;
  now?: Date;
}>;

/**
 * Pure lifetime projection. No transcript reads, collection, persistence,
 * lifecycle decisions, guessed Run identities, or cumulative counter allocation.
 */
export function projectTaskUsageMetrics(input: TaskUsageInput): TaskUsageMetrics {
  const now = input.now ?? new Date();
  const events = input.events.filter((event) => event.taskId === input.task.id);
  const observations = events.flatMap((event) => {
    const observation = runtimeObservationFromTaskEvent(event);
    return observation !== null
      && observation.fence.taskId === input.task.id
      && Date.parse(observation.receivedAt) <= now.getTime()
      ? [observation] : [];
  }).sort(compare);
  const runs = new Map(input.runs.filter((run) => run.taskId === input.task.id).map((run) => [run.id, run]));
  const inScope = (observation: RuntimeObservation): boolean => {
    if (input.workItemId === undefined) return true;
    const run = exactRun(observation, runs);
    return run?.workItemId === input.workItemId;
  };
  const scoped = observations.filter(inScope);
  const buckets = new Map<string, { identity: SessionTokenIdentity; observations: RuntimeObservation[] }>();
  for (const observation of observations) {
    const identity = sessionIdentity(observation);
    if (identity === null) continue;
    const key = identityKey(identity);
    const bucket = buckets.get(key) ?? { identity, observations: [] };
    bucket.observations.push(observation);
    buckets.set(key, bucket);
  }
  const resourceOwners = new Map<string, Set<string>>();
  for (const { identity, observations: all } of buckets.values()) {
    if (!all.some((observation) => !child(observation) && usageAuthority(observation))) continue;
    const resource = resourceKey(identity);
    const owners = resourceOwners.get(resource) ?? new Set<string>();
    owners.add(identity.roleName);
    resourceOwners.set(resource, owners);
  }
  const sessions = [...buckets.values()]
    .sort((a, b) => identityKey(a.identity).localeCompare(identityKey(b.identity)))
    .flatMap(({ identity, observations: all }) => {
      if (!all.some(inScope)) return [];
      const main = all.filter((observation) => !child(observation) && usageAuthority(observation));
      const evidence = main.filter(isRuntimeTokenEvidence);
      const metrics = projectSessionTokenObservations(main, identity);
      let displayedMetrics = input.workItemId === undefined ? metrics : unobservedSessionTokenMetrics(identity);
      const reasons: string[] = [];
      if (all.some(child)) reasons.push("child-usage-overlap-unproven");
      if (evidence.some(({ payload }) => payload.observationQuality === "partial"
        || payload.observationQuality === "unavailable")) reasons.push("source-coverage-partial");
      let tokens = attributableTokens(evidence, metrics);
      if (input.workItemId !== undefined) {
        // Establish semantics and request ownership before filtering. Filtering
        // first could hide a mixed stream or allocate a revised request twice.
        if (metrics.cumulativeTotal.status !== "observed") {
          tokens = metric(null, ["session-usage-unavailable"]);
        } else if (evidence.some(({ payload }) => payload.usage?.semantics === "cumulative-session")) {
          tokens = metric(null, ["cumulative-not-allocatable-to-work-item"]);
        } else {
          const requests = new Map<string, RuntimeObservation[]>();
          for (const observation of evidence) {
            if (observation.payload.usage?.semantics !== "request-context") continue;
            const key = observation.payload.activityId ?? observation.semanticKey;
            requests.set(key, [...(requests.get(key) ?? []), observation]);
          }
          const selected: RuntimeObservation[] = [];
          for (const versions of requests.values()) {
            if (!versions.some(inScope)) continue;
            const owners = new Set(versions.map((observation) => exactRun(observation, runs)?.id));
            if (owners.size !== 1 || owners.has(undefined) || !versions.every(inScope)) {
              reasons.push("request-run-attribution-conflict");
            } else {
              selected.push(...versions);
            }
          }
          displayedMetrics = projectSessionTokenObservations(selected, identity);
          const subtotal = displayedMetrics.cumulativeTotal;
          tokens = metric(subtotal.status === "observed" ? subtotal.totalTokens : null,
            subtotal.status === "observed" ? [] : ["no-attributable-request-usage"]);
        }
      }
      if ((resourceOwners.get(resourceKey(identity))?.size ?? 0) > 1) {
        tokens = metric(null, ["native-session-role-overlap"]);
        displayedMetrics = unobservedSessionTokenMetrics(identity);
      }
      tokens = metric(tokens.value, [...tokens.reasons, ...reasons]);
      return [{
        identity,
        semantics: [...new Set(evidence.flatMap(({ payload }) => payload.usage === undefined ? [] : [payload.usage.semantics]))].sort(),
        sources: [...new Set(evidence.map(({ authority, payload }) => payload.observerSource?.sourceId ?? authority))].sort(),
        observedThrough: all.filter(inScope).at(-1)!.receivedAt,
        tokens,
        metrics: displayedMetrics
      }];
    });
  const reasons: string[] = [];
  if (scoped.some((observation) => sessionIdentity(observation) === null)) reasons.push("session-identity-missing");
  for (const run of runs.values()) {
    if (input.workItemId !== undefined && run.workItemId !== input.workItemId) continue;
    if (!observations.some((observation) => exactRun(observation, runs)?.id === run.id
      && usageAuthority(observation) && isRuntimeTokenEvidence(observation))) reasons.push("run-usage-unobserved");
  }
  const tokenValues = sessions.flatMap(({ tokens }) => tokens.value === null ? [] : [tokens.value]);
  const sum = safeSum(tokenValues);
  const tokens = metric(tokenValues.length === 0 ? null : sum,
    [...reasons, ...sessions.flatMap(({ tokens }) => tokens.reasons),
      ...(sum === null ? ["counter-overflow"] : []),
      ...(sessions.length === 0 ? ["no-token-evidence"] : [])]);

  const operations = new Map<string, RuntimeObservation[]>();
  for (const observation of observations) {
    const identity = sessionIdentity(observation);
    const { nativeTurnId } = observation.fence;
    if (!usageAuthority(observation) || child(observation) || identity === null || nativeTurnId === undefined
      || !observation.kind.startsWith("operation.")
      || observation.payload.operation !== "tool" || observation.payload.operationId === undefined) continue;
    const key = JSON.stringify([resourceKey(identity), nativeTurnId, observation.payload.operationId]);
    const versions = operations.get(key) ?? [];
    versions.push(observation);
    operations.set(key, versions);
  }
  const toolCount = [...operations.values()].filter((versions) => {
    if (input.workItemId === undefined) return true;
    const owners = new Set(versions.map((observation) => exactRun(observation, runs)?.id));
    return owners.size === 1 && !owners.has(undefined) && versions.every(inScope);
  }).length;
  return {
    scope: "task-lifetime", taskId: input.task.id,
    ...(input.workItemId === undefined ? {} : { workItemId: input.workItemId }),
    observedThrough: scoped.at(-1)?.receivedAt ?? null,
    tokens,
    toolCalls: metric(toolCount === 0 ? null : toolCount, ["tool-history-compacted"]),
    elapsedSeconds: input.workItemId === undefined
      ? taskElapsed(input.task, events, now) : metric(null, ["work-item-lifecycle-not-task-elapsed"]),
    executionSeconds: executionDuration(scoped, now),
    coverage: {
      basis: "task-fenced-observations",
      observedSessions: sessions.length,
      tokenSessions: tokenValues.length,
      completeness: "observed-sources-only"
    },
    sessions
  };
}

function attributableTokens(
  evidence: readonly RuntimeObservation[], metrics: SessionTokenMetrics
): UsageMetric {
  const total = metrics.cumulativeTotal;
  if (total.status !== "observed") return metric(null, ["session-usage-unavailable"]);
  const cumulative = evidence.filter(({ payload }) => payload.usage?.semantics === "cumulative-session");
  if (cumulative.length === 0) return metric(total.totalTokens);
  const first = cumulative[0]!.payload.usage!;
  const baseline = first.inputTokens + first.outputTokens;
  if (baseline === 0) return metric(total.totalTokens);
  // session.started also occurs on resume: it cannot prove a fresh counter.
  // A nonzero first counter may predate this Task, so exclude it. A single
  // snapshot does not prove even a zero delta.
  return cumulative.length < 2
    ? metric(null, ["nonzero-session-baseline"])
    : metric(total.totalTokens - baseline, ["nonzero-session-baseline"]);
}

function exactRun(observation: RuntimeObservation, runs: ReadonlyMap<string, AgentRun>): AgentRun | undefined {
  const { fence } = observation;
  const run = fence.runId === undefined ? undefined : runs.get(fence.runId);
  if (run === undefined || fence.nativeSessionId === undefined || run.roleName !== fence.roleName
    || run.effective.agentId !== fence.agentId) return undefined;
  try {
    return builtinDriverIdForAdapter(run.effective.adapterId) === fence.driverId ? run : undefined;
  } catch {
    return undefined;
  }
}

function sessionIdentity({ fence }: RuntimeObservation): SessionTokenIdentity | null {
  return fence.taskId === undefined || fence.nativeSessionId === undefined ? null : {
    taskId: fence.taskId, roleName: fence.roleName, agentId: fence.agentId,
    driverId: fence.driverId, nativeSessionId: fence.nativeSessionId
  };
}

function identityKey(identity: SessionTokenIdentity): string {
  return JSON.stringify([identity.taskId, identity.roleName, identity.agentId, identity.driverId, identity.nativeSessionId]);
}

function resourceKey(identity: SessionTokenIdentity): string {
  return JSON.stringify([identity.agentId, identity.driverId, identity.nativeSessionId]);
}

function child({ fence }: RuntimeObservation): boolean {
  return fence.continuationId !== undefined || fence.parentContinuationId !== undefined;
}

function usageAuthority(observation: RuntimeObservation): boolean {
  return observation.authority === "provider-structured" || observation.authority === "driver-inferred";
}

function compare(left: RuntimeObservation, right: RuntimeObservation): number {
  return left.receivedAt.localeCompare(right.receivedAt)
    || (left.sequence ?? -1) - (right.sequence ?? -1)
    || (left.ordinal ?? -1) - (right.ordinal ?? -1)
    || left.eventId.localeCompare(right.eventId);
}

function metric(value: number | null, reasons: readonly string[] = []): UsageMetric {
  return {
    value, status: value === null ? "unknown" : reasons.length === 0 ? "known" : "partial",
    reasons: [...new Set(reasons)].sort()
  };
}

function safeSum(values: readonly number[]): number | null {
  const sum = values.reduce((a, b) => a + b, 0);
  return Number.isSafeInteger(sum) && sum >= 0 ? sum : null;
}

function taskElapsed(task: TaskUsageInput["task"], events: readonly TaskEvent[], now: Date): UsageMetric {
  const terminal = task.status === "completed"
    || task.status === "cancelled" || task.status === "archived";
  const cancelledAt = events.filter((event) => event.type === "task.cancelled")
    .map(({ createdAt }) => createdAt).sort().at(-1);
  const end = terminal ? task.completedAt ?? task.retiredAt ?? cancelledAt : now.toISOString();
  const elapsed = end === undefined ? NaN : (Date.parse(end) - Date.parse(task.createdAt)) / 1000;
  return Number.isFinite(elapsed) && elapsed >= 0
    ? metric(elapsed) : metric(null, ["task-lifecycle-time-missing"]);
}

function executionDuration(observations: readonly RuntimeObservation[], now: Date): UsageMetric {
  const turns = new Map<string, { resource: string; start?: number; end?: number }>();
  for (const observation of observations) {
    const identity = sessionIdentity(observation);
    const { nativeTurnId } = observation.fence;
    if (identity === null || nativeTurnId === undefined || child(observation) || !usageAuthority(observation)) continue;
    const resource = resourceKey(identity);
    const key = JSON.stringify([resource, nativeTurnId]);
    const turn = turns.get(key) ?? { resource };
    const time = Date.parse(observation.observedAt ?? observation.receivedAt);
    if (observation.kind === "turn.accepted") turn.start = Math.min(turn.start ?? time, time);
    if (["turn.completed", "turn.failed", "turn.cancelled"].includes(observation.kind)) {
      turn.end = Math.max(turn.end ?? time, time);
    }
    turns.set(key, turn);
  }
  const intervals = new Map<string, [number, number][]>();
  for (const turn of turns.values()) {
    if (turn.start === undefined || turn.end === undefined || turn.end < turn.start || turn.end > now.getTime()) continue;
    intervals.set(turn.resource, [...(intervals.get(turn.resource) ?? []), [turn.start, turn.end]]);
  }
  let milliseconds = 0;
  for (const ranges of intervals.values()) {
    ranges.sort((a, b) => a[0] - b[0]);
    let end = -Infinity;
    for (const range of ranges) {
      milliseconds += Math.max(0, range[1] - Math.max(end, range[0]));
      end = Math.max(end, range[1]);
    }
  }
  return metric(intervals.size === 0 ? null : milliseconds / 1000, ["native-turn-history-compacted"]);
}

/** CLI/audit formatting shares the same metric contract; Web localizes labels. */
export function formatUsageMetric(metric: UsageMetric, suffix = ""): string {
  return metric.value === null ? `unknown (${metric.reasons.join(", ")})`
    : `${metric.value}${suffix}${metric.status === "partial" ? ` (partial: ${metric.reasons.join(", ")})` : ""}`;
}
