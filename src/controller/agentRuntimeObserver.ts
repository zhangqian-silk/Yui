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
  runtimeObservationFenceMatches,
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
  "listTasks" | "listAgentRuns" | "getActiveAgentRun" | "listEvents"
>;

type ObserverState = {
  cursor?: AgentRuntimeObserverCursor;
  health?: string;
  usage?: RuntimeUsageSnapshot;
  activityId?: string;
};

export interface AgentRuntimeObserverPort {
  sample(now?: Date): Promise<readonly MailboxKey[]>;
}

/**
 * Controller-owned, provider-independent sampler. Drivers own source parsing;
 * this component owns active-Run discovery, cursor lifetime, canonical event
 * creation, and low-latency mailbox wakes.
 */
export class AgentRuntimeObserver implements AgentRuntimeObserverPort {
  readonly #states = new Map<string, ObserverState>();
  #sequence = 0;

  constructor(
    readonly store: ObserverStore,
    readonly inbox: FileRuntimeEventInbox,
    readonly drivers: AgentDriverRegistry = builtinAgentDriverRegistry()
  ) {}

  async sample(now = new Date()): Promise<readonly MailboxKey[]> {
    const active = this.activeSources();
    const activeKeys = new Set(active.map(({ key }) => key));
    for (const key of this.#states.keys()) {
      if (!activeKeys.has(key)) this.#states.delete(key);
    }
    const dirty = new Set<MailboxKey>();
    await Promise.all(active.map(async ({ key, fence, source, freshSession, persistedState }) => {
      const existingState = this.#states.get(key);
      // Cursor state is intentionally process-local, but the latest canonical
      // usage/activity baseline is durable. Rehydrate it after Controller
      // restart so rereading the bounded transcript tail cannot manufacture a
      // fresh activity edge from tokens that were already observed.
      const state = existingState ?? { ...persistedState };
      const driver = this.drivers.require(fence.driverId);
      const observer = driver.runtime.observer;
      if (observer === undefined) return;
      let sample: AgentRuntimeObserverSample;
      try {
        sample = await observer.sample(source, state.cursor);
      } catch (error) {
        sample = Object.freeze({
          cursor: state.cursor ?? Object.freeze({}),
          status: "unavailable" as const,
          detail: error instanceof Error ? error.message : String(error)
        });
      }
      state.cursor = sample.cursor;
      const at = now.toISOString();
      const sequence = this.#sequence++;
      if (existingState === undefined && freshSession && state.usage === undefined) {
        const zero = Object.freeze({ inputTokens: 0, outputTokens: 0 });
        this.inbox.enqueueObservation(createRuntimeObservation({
          schemaVersion: 1,
          eventId: observationId("baseline", fence, source.sourceId, "zero"),
          kind: "activity.observed",
          authority: "controller",
          receivedAt: at,
          sequence,
          ordinal: 1,
          fence,
          payload: { activity: "model", usage: zero }
        }));
        state.usage = zero;
        dirty.add(`role:${fence.taskId}/${fence.roleName}`);
      }
      const health = JSON.stringify([sample.status, sample.detail ?? null]);
      if (state.health !== health) {
        this.inbox.enqueueObservation(createRuntimeObservation({
          schemaVersion: 1,
          eventId: observationId("health", fence, source.sourceId, health),
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
      const usageChanged = sample.usage !== undefined
        && !sameUsage(state.usage, sample.usage);
      const activityChanged = sample.activityId !== undefined
        && sample.activityId !== state.activityId;
      if (usageChanged || (activityChanged && state.cursor !== undefined)) {
        const usage = sample.usage;
        this.inbox.enqueueObservation(createRuntimeObservation({
          schemaVersion: 1,
          eventId: observationId(
            "activity",
            fence,
            source.sourceId,
            JSON.stringify([usage ?? null, sample.activityId ?? null])
          ),
          kind: "activity.observed",
          authority: "driver-inferred",
          receivedAt: at,
          sequence,
          ordinal: 2,
          fence,
          payload: {
            activity: sample.activity ?? "model",
            ...(sample.activityId === undefined ? {} : { activityId: sample.activityId }),
            ...(usage === undefined ? {} : { usage })
          }
        }));
        dirty.add(`role:${fence.taskId}/${fence.roleName}`);
      }
      if (sample.usage !== undefined) state.usage = sample.usage;
      if (sample.activityId !== undefined) state.activityId = sample.activityId;
      this.#states.set(key, state);
    }));
    return Object.freeze([...dirty].sort());
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
    for (const task of this.store.listTasks()) {
      if (task.status !== "active") continue;
      const observations = this.store.listEvents(task.id)
        .map(runtimeObservationFromTaskEvent)
        .filter((value): value is RuntimeObservation => value !== null);
      for (const run of this.store.listAgentRuns(task.id)) {
        if (run.status !== "active"
          || this.store.getActiveAgentRun(task.id, run.roleName)?.id !== run.id) continue;
        const accepted = observations
          .filter((observation) => observation.kind === "turn.accepted"
            && observation.fence.runId === run.id
            && observation.fence.roleName === run.roleName
            && observation.fence.agentId === run.effective.agentId
            && observation.payload.observerSource !== undefined)
          .sort(compareObservations)
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
        const exact = observations
          .filter((observation) => runtimeObservationFenceMatches(fence, observation.fence))
          .sort(compareObservations);
        const persistedUsage = exact.filter((observation) => (
          observation.kind === "activity.observed"
          && observation.payload.usage !== undefined
        )).at(-1);
        const persistedHealth = exact.filter((observation) => (
          observation.kind === "observer.health"
          && observation.payload.sourceId === source.sourceId
        )).at(-1);
        result.push(Object.freeze({
          key: JSON.stringify([
            fence.driverId,
            fence.sessionGenerationId,
            fence.nativeSessionId,
            fence.nativeTurnId,
            fence.runId,
            source.sourceId
          ]),
          fence,
          source,
          freshSession: run.mode === "new",
          persistedState: Object.freeze({
            ...(persistedUsage?.payload.usage === undefined
              ? {}
              : { usage: persistedUsage.payload.usage }),
            ...(persistedUsage?.payload.activityId === undefined
              ? {}
              : { activityId: persistedUsage.payload.activityId }),
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
    return result;
  }
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

function sameUsage(
  left: RuntimeUsageSnapshot | undefined,
  right: RuntimeUsageSnapshot
): boolean {
  return left !== undefined
    && left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.cachedInputTokens === right.cachedInputTokens
    && left.reasoningTokens === right.reasoningTokens;
}
