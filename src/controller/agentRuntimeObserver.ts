import { createHash } from "node:crypto";

import type {
  AgentRuntimeObserverCursor,
  AgentRuntimeObserverSample,
  AgentRuntimeObserverSource
} from "../runtime/agentDriver.js";
import { AgentDriverRegistry } from "../runtime/agentDriver.js";
import { builtinAgentDriverRegistry } from "../runtime/builtinAgentDrivers.js";
import {
  createRuntimeObservation,
  runtimeObservationFromTaskEvent,
  type RuntimeObservation,
  type RuntimeObservationFence,
  type RuntimeUsageSnapshot
} from "../runtime/runtimeObservation.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { MailboxKey } from "./controller.js";
import { FileRuntimeEventInbox } from "./runtimeEventInbox.js";

type ObserverStore = Pick<
  TaskStore,
  "listTasks" | "getTask" | "listAgentRuns" | "getActiveAgentRun" | "listEvents"
> & Readonly<{
  /** SQLite exposes this bounded production hot-set projection. */
  listActiveTaskIds?: () => readonly string[];
}>;

type ObserverState = {
  cursor?: AgentRuntimeObserverCursor;
  health?: string;
  usage?: RuntimeUsageSnapshot;
  usageEventId?: string;
  usageOccurrenceId?: string;
  usageOccurrenceCheckpoint?: string;
  activityId?: string;
};

export interface AgentRuntimeObserverPort {
  sample(now?: Date): Promise<readonly MailboxKey[]>;
}

export type AgentRuntimeObserverOptions = Readonly<{
  maxConcurrentSamples?: number;
}>;

const DEFAULT_MAX_CONCURRENT_SAMPLES = 8;
const MAX_CONCURRENT_SAMPLES = 64;

/**
 * Controller-owned, provider-independent sampler. Drivers own source parsing;
 * this component owns active-Run discovery, cursor lifetime, canonical event
 * creation, and low-latency mailbox wakes.
 */
export class AgentRuntimeObserver implements AgentRuntimeObserverPort {
  readonly #states = new Map<string, ObserverState>();
  readonly #maxConcurrentSamples: number;
  #sequence = 0;

  constructor(
    readonly store: ObserverStore,
    readonly inbox: FileRuntimeEventInbox,
    readonly drivers: AgentDriverRegistry = builtinAgentDriverRegistry(),
    options: AgentRuntimeObserverOptions = {}
  ) {
    this.#maxConcurrentSamples = sampleConcurrency(options.maxConcurrentSamples);
  }

  async sample(now = new Date()): Promise<readonly MailboxKey[]> {
    const active = this.activeSources();
    const activeKeys = new Set(active.map(({ key }) => key));
    for (const key of this.#states.keys()) {
      if (!activeKeys.has(key)) this.#states.delete(key);
    }
    const dirty = new Set<MailboxKey>();
    const sequenceBase = this.#sequence;
    this.#sequence += active.length;
    await forEachConcurrent(
      active,
      this.#maxConcurrentSamples,
      async ({ key, fence, source, freshSession, persistedState }, index) => {
        const existingState = this.#states.get(key);
        // Cursor state is intentionally process-local, but the latest canonical
        // usage/activity baseline is durable. Rehydrate it after Controller
        // restart so rereading the bounded transcript tail cannot manufacture a
        // fresh activity edge from tokens that were already observed.
        const state = existingState ?? { ...persistedState };
        const restoredUsageEventId = existingState === undefined
          ? persistedState.usageEventId
          : undefined;
        const driver = this.drivers.require(fence.driverId);
        const observer = driver.runtime.observer;
        if (observer === undefined) return;
        let sample: AgentRuntimeObserverSample;
        try {
          sample = await observer.sample(source, state.cursor, {
            ...(state.usageOccurrenceId === undefined
              ? {}
              : { latestOccurrenceId: state.usageOccurrenceId }),
            ...(state.usageOccurrenceCheckpoint === undefined
              ? {}
              : { latestCheckpoint: state.usageOccurrenceCheckpoint })
          });
        } catch (error) {
          sample = Object.freeze({
            cursor: state.cursor ?? Object.freeze({}),
            status: "unavailable" as const,
            detail: error instanceof Error ? error.message : String(error)
          });
        }
        state.cursor = sample.cursor;
        const at = now.toISOString();
        // Reserve sequence numbers in source-key order before sampling. Provider
        // latency can change completion order without changing observation
        // identity or the canonical sequence assigned to a source.
        const sequence = sequenceBase + index;
        let usages = sample.usages ?? [];
        if (state.usage === undefined) {
          // Cumulative counters need a lower bound: a fresh native Session
          // begins at zero, while a resumed Session freezes its first sample
          // so earlier conversation usage is not charged to this Run. Request
          // snapshots already describe one complete occurrence and must not be
          // mixed with a synthetic cumulative fact.
          const latestOccurrence = usages.at(-1);
          const completeFreshBaseline = freshSession
            && latestOccurrence?.observationQuality !== "partial";
          const baseline = latestOccurrence?.usage.semantics !== "cumulative-session"
            ? undefined
            : completeFreshBaseline
              ? Object.freeze({
                  semantics: "cumulative-session" as const,
                  inputTokens: 0,
                  outputTokens: 0
                })
              : latestOccurrence.usage;
          if (baseline !== undefined) {
            const baselineKey = completeFreshBaseline ? "zero" : latestOccurrence!.occurrenceId;
            const identity = completeFreshBaseline
              ? tokenObservationIdentity("baseline", fence, source.sourceId, baselineKey)
              : usageObservationIdentity(fence, source.sourceId, latestOccurrence!);
            this.inbox.enqueueObservation(createRuntimeObservation({
              schemaVersion: 2,
              eventId: identity.eventId,
              semanticKey: identity.semanticKey,
              kind: "activity.observed",
              authority: completeFreshBaseline ? "controller" : "driver-inferred",
              receivedAt: at,
              sequence,
              ordinal: 1,
              fence,
              payload: {
                activity: "model",
                sourceId: source.sourceId,
                usage: baseline,
                ...(completeFreshBaseline
                  || latestOccurrence?.observationQuality === undefined
                  ? {}
                  : { observationQuality: latestOccurrence.observationQuality })
              }
            }));
            state.usage = baseline;
            state.usageEventId = identity.eventId;
            state.usageOccurrenceId = completeFreshBaseline
              ? undefined
              : latestOccurrence!.occurrenceId;
            state.usageOccurrenceCheckpoint = completeFreshBaseline
              ? undefined
              : latestOccurrence!.resumeCheckpoint;
            if (!completeFreshBaseline) usages = [];
          }
        }
        const health = JSON.stringify([sample.status, sample.detail ?? null]);
        if (state.health !== health) {
          this.inbox.enqueueObservation(createRuntimeObservation({
            schemaVersion: 2,
            eventId: observationId("health", fence, source.sourceId, health),
            semanticKey: observationId("health", fence, source.sourceId, health),
            kind: "observer.health",
            authority: "diagnostic",
            receivedAt: at,
            sequence,
            ordinal: 0,
            fence,
            payload: {
              sourceId: source.sourceId,
              observerStatus: sample.status,
              ...(sample.detail === undefined ? {} : { observerDetail: sample.detail })
            }
          }));
          state.health = health;
          dirty.add(`role:${fence.taskId}/${fence.roleName}`);
        }
        const activityChanged = sample.activityId !== undefined
          && sample.activityId !== state.activityId;
        if (restoredUsageEventId !== undefined) {
          let persistedIndex = -1;
          for (let usageIndex = usages.length - 1; usageIndex >= 0; usageIndex -= 1) {
            if (usageObservationIdentity(fence, source.sourceId, usages[usageIndex]!).eventId
              === restoredUsageEventId) {
              persistedIndex = usageIndex;
              break;
            }
          }
          if (persistedIndex >= 0) {
            usages = usages.slice(persistedIndex + 1);
          } else if (state.usage?.semantics === "cumulative-session") {
            // The durable counter proves the latest cumulative total, but an
            // initial bounded read that cannot recover that occurrence may
            // have skipped intermediate request boundaries while the
            // Controller was stopped. Preserve the total and fail closed only
            // for the derived maximum-request metric.
            usages = usages.map((occurrence) => (
              occurrence.usage.semantics !== "cumulative-session"
                ? occurrence
                : Object.freeze({ ...occurrence, observationQuality: "partial" as const })
            ));
          }
        }
        usages.forEach((occurrence, usageIndex) => {
          const identity = usageObservationIdentity(fence, source.sourceId, occurrence);
          this.inbox.enqueueObservation(createRuntimeObservation({
            schemaVersion: 2,
            eventId: identity.eventId,
            semanticKey: identity.semanticKey,
            kind: "activity.observed",
            authority: "driver-inferred",
            receivedAt: at,
            sequence,
            ordinal: 2 + usageIndex,
            fence,
            payload: {
              activity: sample.activity ?? "model",
              sourceId: source.sourceId,
              ...(occurrence.activityId === undefined
                ? {}
                : { activityId: occurrence.activityId }),
              ...(occurrence.observationQuality === undefined
                ? {}
                : { observationQuality: occurrence.observationQuality }),
              usage: occurrence.usage
            }
          }));
          state.usage = occurrence.usage;
          state.usageEventId = identity.eventId;
          state.usageOccurrenceId = occurrence.occurrenceId;
          state.usageOccurrenceCheckpoint = occurrence.resumeCheckpoint;
        });
        if (activityChanged && state.cursor !== undefined) {
          this.inbox.enqueueObservation(createRuntimeObservation({
            schemaVersion: 2,
            eventId: observationId("activity", fence, source.sourceId, sample.activityId!),
            semanticKey: observationId("activity", fence, source.sourceId, sample.activityId!),
            kind: "activity.observed",
            authority: "driver-inferred",
            receivedAt: at,
            sequence,
            ordinal: 2 + usages.length,
            fence,
            payload: {
              activity: sample.activity ?? "model",
              sourceId: source.sourceId,
              activityId: sample.activityId!
            }
          }));
          dirty.add(`role:${fence.taskId}/${fence.roleName}`);
        }
        if (sample.activityId !== undefined) state.activityId = sample.activityId;
        this.#states.set(key, state);
      }
    );
    return Object.freeze([...dirty].sort(numericCompare));
  }

  private activeSources(): readonly Readonly<{
    key: string;
    fence: RuntimeObservationFence & Required<Pick<RuntimeObservationFence, "taskId" | "runId">>;
    source: AgentRuntimeObserverSource;
    freshSession: boolean;
    persistedState: ObserverState;
  }>[] {
    const result: Array<Readonly<{
      key: string;
      fence: RuntimeObservationFence & Required<Pick<RuntimeObservationFence, "taskId" | "runId">>;
      source: AgentRuntimeObserverSource;
      freshSession: boolean;
      persistedState: ObserverState;
    }>> = [];
    const indexedTaskIds = this.store.listActiveTaskIds?.();
    // FileTaskStore remains a development/compatibility fallback. The normal
    // Controller store is SQLite and must discover only its indexed hot set.
    const activeTasks = indexedTaskIds === undefined
      ? this.store.listTasks().filter((task) => task.status === "active")
      : [...new Set(indexedTaskIds)]
        .sort(numericCompare)
        .map((taskId) => this.store.getTask(taskId))
        .filter((task): task is NonNullable<typeof task> => (
          task !== null && task.status === "active"
        ));
    for (const task of activeTasks) {
      // A Task still incurs one O(E) event projection. Group those observations
      // by Run and sort each group once so every active Run can reuse the same
      // ordered slice instead of repeatedly filtering/sorting all E events.
      const observationsByRunId = new Map<string, RuntimeObservation[]>();
      const taskObservations: RuntimeObservation[] = [];
      for (const event of this.store.listEvents(task.id)) {
        const observation = runtimeObservationFromTaskEvent(event);
        const runId = observation?.fence.runId;
        if (observation === null || runId === undefined) continue;
        taskObservations.push(observation);
        const grouped = observationsByRunId.get(runId);
        if (grouped === undefined) {
          observationsByRunId.set(runId, [observation]);
        } else {
          grouped.push(observation);
        }
      }
      for (const observations of observationsByRunId.values()) {
        observations.sort(compareObservations);
      }
      taskObservations.sort(compareObservations);
      for (const run of this.store.listAgentRuns(task.id)) {
        if (run.status !== "active"
          || this.store.getActiveAgentRun(task.id, run.roleName)?.id !== run.id) continue;
        const observations = observationsByRunId.get(run.id) ?? [];
        const accepted = observations
          .filter((observation) => observation.kind === "turn.accepted"
            && observation.fence.runId === run.id
            && observation.fence.roleName === run.roleName
            && observation.fence.agentId === run.effective.agentId
            && observation.payload.observerSource !== undefined)
          .at(-1);
        const source = accepted?.payload.observerSource;
        if (accepted === undefined || source === undefined
          || accepted.fence.taskId === undefined || accepted.fence.runId === undefined) continue;
        try {
          if (this.drivers.require(accepted.fence.driverId).runtime.observer === undefined) continue;
        } catch {
          continue;
        }
        const fence = accepted.fence as RuntimeObservationFence
          & Required<Pick<RuntimeObservationFence, "taskId" | "runId">>;
        const generation = taskObservations.filter((observation) => (
          sessionGenerationFenceMatches(fence, observation.fence)
          && observation.payload.sourceId === source.sourceId
        ));
        const persistedUsage = generation.filter((observation) => (
          observation.kind === "activity.observed"
          && observation.payload.usage !== undefined
        )).at(-1);
        const persistedActivity = generation.filter((observation) => (
          observation.kind === "activity.observed"
          && observation.payload.activityId !== undefined
          && observation.payload.usage === undefined
        )).at(-1);
        const persistedHealth = generation.filter((observation) => (
          observation.kind === "observer.health"
          && observation.payload.sourceId === source.sourceId
        )).at(-1);
        const persistedUsageResume = persistedUsage === undefined
          ? undefined
          : usageObservationResume(persistedUsage.semanticKey);
        result.push(Object.freeze({
          key: JSON.stringify([
            fence.taskId,
            fence.roleName,
            fence.runId,
            fence.agentId,
            fence.driverId,
            fence.launchId,
            fence.sessionGenerationId,
            fence.nativeSessionId,
            source.sourceId
          ]),
          fence,
          source,
          freshSession: run.mode === "new",
          persistedState: Object.freeze({
            ...(persistedUsage?.payload.usage === undefined
              ? {}
              : { usage: persistedUsage.payload.usage }),
            ...(persistedUsage === undefined
              ? {}
              : {
                  usageEventId: persistedUsage.eventId,
                  ...(persistedUsageResume === undefined
                    ? {}
                    : {
                        usageOccurrenceId: persistedUsageResume.occurrenceId,
                        ...(persistedUsageResume.checkpoint === undefined
                          ? {}
                          : { usageOccurrenceCheckpoint: persistedUsageResume.checkpoint })
                      })
                }),
            ...(persistedActivity?.payload.activityId === undefined
              ? {}
              : { activityId: persistedActivity.payload.activityId }),
            ...(persistedHealth === undefined
              ? {}
              : {
                  health: JSON.stringify([
                    persistedHealth.payload.observerStatus,
                    persistedHealth.payload.observerDetail ?? null
                  ])
                })
          })
        }));
      }
    }
    return Object.freeze(result.sort((left, right) => numericCompare(left.key, right.key)));
  }
}

async function forEachConcurrent<T>(
  values: readonly T[],
  limit: number,
  visit: (value: T, index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workers = Math.min(limit, values.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await visit(values[index]!, index);
    }
  }));
}

function sampleConcurrency(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_CONCURRENT_SAMPLES;
  if (!Number.isSafeInteger(resolved)
    || resolved < 1
    || resolved > MAX_CONCURRENT_SAMPLES) {
    throw new Error(
      `Agent runtime observer maxConcurrentSamples must be between 1 and ${MAX_CONCURRENT_SAMPLES}.`
    );
  }
  return resolved;
}

function numericCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

function compareObservations(left: RuntimeObservation, right: RuntimeObservation): number {
  return left.receivedAt.localeCompare(right.receivedAt)
    || (left.sequence ?? -1) - (right.sequence ?? -1)
    || (left.ordinal ?? -1) - (right.ordinal ?? -1)
    || left.eventId.localeCompare(right.eventId);
}

function observationId(
  kind: string,
  fence: RuntimeObservationFence,
  sourceId: string,
  value: string
): string {
  return `runtime-observer-${createHash("sha256")
    .update(JSON.stringify([kind, fence, sourceId, value]))
    .digest("hex")}`;
}

function usageObservationIdentity(
  fence: RuntimeObservationFence,
  sourceId: string,
  occurrence: Readonly<{ occurrenceId: string; resumeCheckpoint?: string }>
): Readonly<{ eventId: string; semanticKey: string }> {
  const eventId = tokenObservationId("usage", fence, sourceId, occurrence.occurrenceId);
  const encodedOccurrenceId = Buffer.from(occurrence.occurrenceId, "utf8").toString("base64url");
  return Object.freeze({
    eventId,
    semanticKey: `${eventId}:occurrence:${encodedOccurrenceId}${
      occurrence.resumeCheckpoint === undefined
        ? ""
        : `:checkpoint:${Buffer.from(occurrence.resumeCheckpoint, "utf8").toString("base64url")}`
    }`
  });
}

function usageObservationResume(
  semanticKey: string
): Readonly<{ occurrenceId: string; checkpoint?: string }> | undefined {
  const occurrenceMarker = ":occurrence:";
  const checkpointMarker = ":checkpoint:";
  const occurrenceIndex = semanticKey.lastIndexOf(occurrenceMarker);
  if (occurrenceIndex < 0) return undefined;
  const checkpointIndex = semanticKey.indexOf(
    checkpointMarker,
    occurrenceIndex + occurrenceMarker.length
  );
  const encodedOccurrence = semanticKey.slice(
    occurrenceIndex + occurrenceMarker.length,
    checkpointIndex < 0 ? undefined : checkpointIndex
  );
  if (encodedOccurrence.length === 0) return undefined;
  try {
    const occurrenceId = Buffer.from(encodedOccurrence, "base64url").toString("utf8");
    if (occurrenceId.length === 0) return undefined;
    if (checkpointIndex < 0) return Object.freeze({ occurrenceId });
    const encodedCheckpoint = semanticKey.slice(checkpointIndex + checkpointMarker.length);
    if (encodedCheckpoint.length === 0) return undefined;
    const checkpoint = Buffer.from(encodedCheckpoint, "base64url").toString("utf8");
    return checkpoint.length === 0
      ? undefined
      : Object.freeze({ occurrenceId, checkpoint });
  } catch {
    return undefined;
  }
}

function tokenObservationIdentity(
  kind: string,
  fence: RuntimeObservationFence,
  sourceId: string,
  value: string
): Readonly<{ eventId: string; semanticKey: string }> {
  const eventId = tokenObservationId(kind, fence, sourceId, value);
  return Object.freeze({ eventId, semanticKey: eventId });
}

function tokenObservationId(
  kind: string,
  fence: RuntimeObservationFence,
  sourceId: string,
  value: string
): string {
  return `runtime-observer-${createHash("sha256").update(JSON.stringify([
    kind,
    fence.taskId ?? null,
    fence.roleName,
    fence.agentId,
    fence.driverId,
    fence.launchId,
    fence.sessionGenerationId,
    fence.nativeSessionId ?? null,
    sourceId,
    value
  ])).digest("hex")}`;
}

function sessionGenerationFenceMatches(
  expected: RuntimeObservationFence,
  actual: RuntimeObservationFence
): boolean {
  for (const field of [
    "taskId",
    "roleName",
    "agentId",
    "driverId",
    "launchId",
    "sessionGenerationId",
    "nativeSessionId"
  ] as const) {
    if (expected[field] !== actual[field]) return false;
  }
  return true;
}
