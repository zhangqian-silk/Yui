import type { SchedulerTask } from "../scheduler/ports.js";
import type {
  FileRuntimeEventInbox,
  RuntimeDurableJobTerminalEvent,
  RuntimeLifecycleEvent,
  RuntimeObservationInboxEvent,
  RuntimeTurnCompletedEvent
} from "./runtimeEventInbox.js";
import {
  isRuntimeTokenEvidence,
  type RuntimeObservation
} from "../runtime/runtimeObservation.js";
import type { AgentDriverRegistry } from "../runtime/agentDriver.js";
import { builtinAgentDriverRegistry } from "../runtime/builtinAgentDrivers.js";

export type ProviderLifecycleObservation = "applied" | "obsolete" | "deferred";

export type TaskRuntimeTurnCompleted = Readonly<{
  eventId?: string;
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  launchId?: string;
  nativeSessionId: string;
  turnId: string;
  runId?: string;
  summary: string;
}>;

export type GlobalRuntimeTurnCompleted = Readonly<{
  eventId?: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  launchId?: string;
  nativeSessionId: string;
  turnId: string;
  title?: string;
  summary: string;
}>;

export type RuntimeTurnEventObserver = Readonly<{
  /** Batch multiple inbox folds into one authoritative aggregate commit. */
  withRuntimeEventTransaction?<T>(execute: () => T): T;
  getTask(taskId: string): SchedulerTask | null;
  /** Applies one provider-neutral runtime state/activity observation. */
  observeRuntimeObservation?(
    input: RuntimeObservation,
    now?: Date
  ): ProviderLifecycleObservation;
  observeRuntimeTurnCompleted(
    input: TaskRuntimeTurnCompleted,
    now?: Date
  ): unknown;
  observeGlobalRuntimeTurnCompleted(
    input: GlobalRuntimeTurnCompleted,
    now?: Date
  ): unknown;
  classifyRuntimeTurnCompleted?(
    input: TaskRuntimeTurnCompleted
  ): "apply" | "deferred" | "obsolete";
  classifyGlobalRuntimeTurnCompleted?(
    input: GlobalRuntimeTurnCompleted
  ): "apply" | "obsolete";
  observeObsoleteRuntimeEvent?(
    input: Readonly<{
      eventId: string;
      eventType: RuntimeLifecycleEvent["type"];
      taskId: string;
      roleName: string;
      agentId: string;
      runId?: string;
      launchId?: string;
      nativeSessionId: string;
      reason: string;
    }>,
    now?: Date
  ): unknown;
}>;

export type RuntimeEventDrainFailure =
  | Readonly<{
      eventId: string;
      scope: "task";
      taskId: string;
      error: unknown;
    }>
  | Readonly<{
      eventId?: string;
      scope: "global" | "unknown";
      error: unknown;
    }>;

export type RuntimeEventDrainResult = Readonly<{
  acknowledgedEventIds: readonly string[];
  deferred: readonly RuntimeLifecycleEvent[];
  failed: readonly RuntimeEventDrainFailure[];
  remainingEventCount: number;
  metrics: RuntimeEventDrainMetrics;
}>;

export type RuntimeEventDrainMetrics = Readonly<{
  listedEventCount: number;
  selectedEventCount: number;
  semanticEventsSelected: number;
  progressEventsSelected: number;
  progressEventsCoalesced: number;
  stateTransactions: number;
  remainingSemanticEventCount: number;
  remainingProgressEventCount: number;
}>;

export interface RuntimeEventProcessorPort {
  drain(now: Date): RuntimeEventDrainResult;
}

/** The async counterpart: a processor whose folds run in the persistence worker. */
export interface AsyncRuntimeEventProcessorPort {
  drainAsync(now: Date): Promise<RuntimeEventDrainResult>;
}

export type TaskRuntimeAppliedInput = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  launchId?: string;
  nativeSessionId: string;
  runId?: string;
}>;

export type FileRuntimeEventProcessorOptions = Readonly<{
  /** Runtime-observation Driver catalog used to resolve Driver/adapter identity. */
  drivers?: AgentDriverRegistry;
  onTaskRuntimeApplied?: (input: TaskRuntimeAppliedInput) => void;
  /** Maximum folded representatives in one state transaction. */
  maxEventsPerDrain?: number;
}>;

type RuntimeEventInboxPort = Pick<FileRuntimeEventInbox, "list" | "acknowledge">
  & Partial<Pick<FileRuntimeEventInbox, "acknowledgeMany">>;

export type CoalescedRuntimeEvent = Readonly<{
  event: RuntimeLifecycleEvent;
  representedEventIds: readonly string[];
}>;

export type RuntimeProgressCoalescingInstrumentation = Readonly<{
  /** Test/diagnostic seam proving each progress fact receives bounded visits. */
  onProgressVisit?(): void;
}>;

type FoldedRuntimeEvent = Readonly<{
  candidate: CoalescedRuntimeEvent;
  outcome: "applied" | "deferred" | "obsolete";
  notifyTaskRuntime: boolean;
}>;

const DEFAULT_MAX_RUNTIME_EVENTS_PER_DRAIN = 64;

/** Folds immutable Hook facts in one bounded transaction before acknowledging them. */
export class FileRuntimeEventProcessor implements RuntimeEventProcessorPort {
  private readonly drivers: AgentDriverRegistry;
  private drainLaneCursor = 0;

  constructor(
    private readonly inbox: RuntimeEventInboxPort,
    private readonly observer: RuntimeTurnEventObserver,
    private readonly options: FileRuntimeEventProcessorOptions = {}
  ) {
    this.drivers = options.drivers ?? builtinAgentDriverRegistry();
  }

  drain(now: Date): RuntimeEventDrainResult {
    const acknowledgedEventIds: string[] = [];
    const deferred: RuntimeLifecycleEvent[] = [];
    const failed: RuntimeEventDrainFailure[] = [];
    let events: readonly RuntimeLifecycleEvent[];
    try {
      events = this.inbox.list();
    } catch (error) {
      return emptyDrainFailure(error);
    }
    const coalesced = coalesceRuntimeProgress(events);
    const maximum = positiveInteger(
      this.options.maxEventsPerDrain,
      DEFAULT_MAX_RUNTIME_EVENTS_PER_DRAIN
    );
    const selection = selectDrainBatch(coalesced, maximum, this.drainLaneCursor);
    this.drainLaneCursor = selection.nextLaneCursor;
    const selected = selection.candidates;
    const failedTaskIds = new Set<string>();
    let stateTransactions = 0;
    if (selected.length > 0 && this.observer.withRuntimeEventTransaction !== undefined) {
      let offset = 0;
      while (offset < selected.length) {
        const wave = selectTaskOrderedWave(selected, offset, failedTaskIds);
        offset = wave.nextOffset;
        if (wave.candidates.length === 0) continue;
        try {
          stateTransactions += 1;
          const folded = this.observer.withRuntimeEventTransaction(() => (
            wave.candidates.map((candidate) => this.foldOne(candidate, now))
          ));
          for (const result of folded) {
            const failure = this.finalizeOne(result, acknowledgedEventIds, deferred);
            if (failure !== undefined) {
              recordDrainFailure(failure, failed, failedTaskIds);
            }
          }
        } catch {
          // A failed aggregate transaction commits nothing. Retry each candidate
          // independently so one bad event cannot strand unrelated Tasks.
          for (const candidate of wave.candidates) {
            if (isTaskCandidateBlocked(candidate.event, failedTaskIds)) continue;
            try {
              stateTransactions += 1;
              const folded = this.observer.withRuntimeEventTransaction(() => (
                this.foldOne(candidate, now)
              ));
              const failure = this.finalizeOne(folded, acknowledgedEventIds, deferred);
              if (failure !== undefined) {
                recordDrainFailure(failure, failed, failedTaskIds);
              }
            } catch (candidateError) {
              recordDrainFailure(
                candidateDrainFailure(candidate.event, candidateError),
                failed,
                failedTaskIds
              );
            }
          }
        }
      }
    } else {
      for (const candidate of selected) {
        if (isTaskCandidateBlocked(candidate.event, failedTaskIds)) continue;
        try {
          const folded = this.foldOne(candidate, now);
          const failure = this.finalizeOne(folded, acknowledgedEventIds, deferred);
          if (failure !== undefined) {
            recordDrainFailure(failure, failed, failedTaskIds);
          }
        } catch (error) {
          recordDrainFailure(
            candidateDrainFailure(candidate.event, error),
            failed,
            failedTaskIds
          );
        }
      }
    }
    const progressEventsSelected = selected.filter(({ event }) => (
      isRuntimeActivityEvent(event)
    )).length;
    const representedEventCount = selected.reduce((count, candidate) => (
      count + candidate.representedEventIds.length
    ), 0);
    const acknowledged = new Set(acknowledgedEventIds);
    const remaining = events.filter(({ id }) => !acknowledged.has(id));
    const remainingProgressEventCount = remaining.filter(isRuntimeActivityEvent).length;
    return {
      acknowledgedEventIds,
      deferred,
      failed,
      remainingEventCount: Math.max(0, events.length - acknowledgedEventIds.length),
      metrics: {
        listedEventCount: events.length,
        selectedEventCount: selected.length,
        semanticEventsSelected: selected.length - progressEventsSelected,
        progressEventsSelected,
        progressEventsCoalesced: representedEventCount - selected.length,
        stateTransactions,
        remainingSemanticEventCount: remaining.length - remainingProgressEventCount,
        remainingProgressEventCount
      }
    };
  }

  private foldOne(
    candidate: CoalescedRuntimeEvent,
    now: Date
  ): FoldedRuntimeEvent {
    const event = candidate.event;
    let outcome: "applied" | "deferred" | "obsolete" = "applied";
    if (event.type === "native-turn-completed") {
      outcome = this.applyNativeTurnCompleted(event, now);
    } else if (event.type === "runtime-observation") {
      outcome = this.applyRuntimeObservation(event, now);
    } else {
      // f7/rr5: The supervisor already transitioned the job and
      // enqueued the Leader wakeup. This event is the durable terminal
      // channel: acknowledge it so the Controller's event pipeline
      // converges without re-processing. No state change to apply.
      this.applyDurableJobTerminal(event);
    }
    return {
      candidate,
      outcome,
      notifyTaskRuntime: outcome === "applied" && (
        (event.type === "runtime-observation" && event.scope === "task"
          && ["session.started", "session.ready", "turn.accepted", "turn.completed"]
            .includes(event.observation.kind))
        || (event.type === "native-turn-completed" && event.scope === "task")
      )
    };
  }

  private applyRuntimeObservation(
    event: RuntimeObservationInboxEvent,
    now: Date
  ): "applied" | "deferred" | "obsolete" {
    const taskId = event.observation.fence.taskId;
    if (taskId !== undefined) {
      const task = this.observer.getTask(taskId);
      if (task === null
        || task.status !== "active"
        || task.executionGate.state !== "enabled") return "obsolete";
    }
    return this.observer.observeRuntimeObservation?.(event.observation, now) ?? "obsolete";
  }

  private finalizeOne(
    folded: FoldedRuntimeEvent,
    acknowledged: string[],
    deferred: RuntimeLifecycleEvent[]
  ): RuntimeEventDrainFailure | undefined {
    const { candidate, outcome } = folded;
    try {
      if (outcome === "deferred") {
        deferred.push(candidate.event);
        this.acknowledge(
          candidate.representedEventIds.filter((id) => id !== candidate.event.id),
          acknowledged
        );
        return undefined;
      }
      if (folded.notifyTaskRuntime) {
        const event = candidate.event;
        if (event.scope === "task"
          && event.taskId !== undefined
          && event.type !== "durable-job-terminal") {
          if (event.type === "runtime-observation") {
            const fence = event.observation.fence;
            if (fence.taskId !== undefined && fence.nativeSessionId !== undefined) {
              this.options.onTaskRuntimeApplied?.({
                taskId: fence.taskId,
                roleName: fence.roleName,
                agentId: fence.agentId,
                adapterId: this.drivers.require(fence.driverId).adapterId,
                launchId: fence.launchId,
                nativeSessionId: fence.nativeSessionId,
                ...(fence.runId === undefined ? {} : { runId: fence.runId })
              });
            }
          } else if (event.type === "native-turn-completed") {
            this.options.onTaskRuntimeApplied?.({
              taskId: event.taskId,
              roleName: event.roleName,
              agentId: event.agentId,
              adapterId: event.adapterId,
              ...(event.launchId === undefined ? {} : { launchId: event.launchId }),
              nativeSessionId: event.nativeSessionId,
              ...(event.runId === undefined ? {} : { runId: event.runId })
            });
          }
        }
      }
      this.acknowledge(candidate.representedEventIds, acknowledged);
      return undefined;
    } catch (error) {
      return candidateDrainFailure(candidate.event, error);
    }
  }

  /**
   * f7/rr5: Acknowledge a durable-job-terminal event. The supervisor
   * already committed the terminal transition and the Leader wakeup;
   * this event only needs to be acknowledged so it leaves the inbox.
   */
  private applyDurableJobTerminal(event: RuntimeDurableJobTerminalEvent): void {
    // The event is a notification of a committed state change. No observer
    // call is needed — the Leader wakeup was enqueued in the same
    // transaction as the terminal transition.
    void event;
  }

  private applyNativeTurnCompleted(
    event: RuntimeTurnCompletedEvent,
    now: Date
  ): "applied" | "deferred" | "obsolete" {
    if (event.scope === "task") {
      const task = this.observer.getTask(event.taskId!);
      const input: TaskRuntimeTurnCompleted = {
        eventId: event.id,
        taskId: event.taskId!,
        roleName: event.roleName,
        agentId: event.agentId,
        adapterId: event.adapterId,
        ...(event.launchId === undefined ? {} : { launchId: event.launchId }),
        nativeSessionId: event.nativeSessionId,
        turnId: event.turnId,
        ...(event.runId === undefined ? {} : { runId: event.runId }),
        summary: event.summary
      };
      if (task === null) return "obsolete";
      if (task.status !== "active" || task.executionGate.state !== "enabled") {
        this.recordObsolete(
          event,
          task.status === "archived" ? "task-archived" : "task-retired",
          now
        );
        return "obsolete";
      }
      const disposition = this.observer.classifyRuntimeTurnCompleted?.(input) ?? "apply";
      if (disposition === "deferred") return disposition;
      if (disposition === "obsolete") {
        this.recordObsolete(event, "identity-mismatch-or-terminal", now);
        return disposition;
      }
      const observed = this.observer.observeRuntimeTurnCompleted(input, now);
      if (isObsoleteRuntimeTurnObservation(observed)) {
        this.recordObsolete(event, "runtime-cleanup-or-stopped-session", now);
        return "obsolete";
      }
      return "applied";
    }
    const input: GlobalRuntimeTurnCompleted = {
      eventId: event.id,
      roleName: event.roleName,
      agentId: event.agentId,
      adapterId: event.adapterId,
      ...(event.launchId === undefined ? {} : { launchId: event.launchId }),
      nativeSessionId: event.nativeSessionId,
      turnId: event.turnId,
      ...(event.title === undefined ? {} : { title: event.title }),
      summary: event.summary
    };
    if (this.observer.classifyGlobalRuntimeTurnCompleted?.(input) !== "obsolete") {
      this.observer.observeGlobalRuntimeTurnCompleted(input, now);
      return "applied";
    }
    return "obsolete";
  }

  private recordObsolete(event: RuntimeLifecycleEvent, reason: string, now: Date): void {
    if (event.scope !== "task" || event.taskId === undefined) return;
    if (event.type === "runtime-observation") {
      const fence = event.observation.fence;
      if (fence.nativeSessionId === undefined) return;
      this.observer.observeObsoleteRuntimeEvent?.({
        eventId: event.id,
        eventType: event.type,
        taskId: event.taskId,
        roleName: fence.roleName,
        agentId: fence.agentId,
        ...(fence.runId === undefined ? {} : { runId: fence.runId }),
        launchId: fence.launchId,
        nativeSessionId: fence.nativeSessionId,
        reason
      }, now);
      return;
    }
    // durable-job-terminal events have no provider identity; they are never
    // recorded as obsolete.
    if (!("roleName" in event) || !("nativeSessionId" in event)) return;
    this.observer.observeObsoleteRuntimeEvent?.({
      eventId: event.id,
      eventType: event.type,
      taskId: event.taskId,
      roleName: event.roleName,
      agentId: event.agentId,
      ...(event.runId === undefined ? {} : { runId: event.runId }),
      ...(event.launchId === undefined ? {} : { launchId: event.launchId }),
      nativeSessionId: event.nativeSessionId,
      reason
    }, now);
  }

  private acknowledge(ids: readonly string[], acknowledged: string[]): void {
    if (this.inbox.acknowledgeMany !== undefined) {
      acknowledged.push(...this.inbox.acknowledgeMany(ids));
      return;
    }
    for (const id of ids) {
      if (this.inbox.acknowledge(id)) acknowledged.push(id);
    }
  }
}

export function coalesceRuntimeProgress(
  events: readonly RuntimeLifecycleEvent[],
  instrumentation: RuntimeProgressCoalescingInstrumentation = {}
): CoalescedRuntimeEvent[] {
  const result: CoalescedRuntimeEvent[] = [];
  let segment: RuntimeObservationInboxEvent[] = [];
  const flush = (): void => {
    if (segment.length === 0) return;
    const indicesByStream = new Map<string, number[]>();
    for (let index = 0; index < segment.length; index += 1) {
      instrumentation.onProgressVisit?.();
      const event = segment[index]!;
      const key = progressStreamKey(event);
      const indices = indicesByStream.get(key) ?? [];
      indices.push(index);
      indicesByStream.set(key, indices);
    }
    const representedByIndex = new Map<number, string[]>();
    for (const indices of indicesByStream.values()) {
      const hasUsage = isRuntimeTokenEvidence(segment[indices[0]!]!.observation);
      // Usage facts and incomplete boundaries are authoritative history for
      // read-only Session token projection, so ingress never coalesces them.
      const retainedPositions = hasUsage ? indices.map((_, position) => position) : [];
      const lastPosition = indices.length - 1;
      if (retainedPositions.at(-1) !== lastPosition) retainedPositions.push(lastPosition);
      let previousRetainedPosition = -1;
      for (const retainedPosition of retainedPositions) {
        const retainedIndex = indices[retainedPosition]!;
        representedByIndex.set(
          retainedIndex,
          indices.slice(previousRetainedPosition + 1, retainedPosition + 1)
            .map((index) => segment[index]!.id)
        );
        previousRetainedPosition = retainedPosition;
      }
    }
    for (let index = 0; index < segment.length; index += 1) {
      const representedEventIds = representedByIndex.get(index);
      if (representedEventIds === undefined) continue;
      result.push({ event: segment[index]!, representedEventIds });
    }
    segment = [];
  };
  for (const event of events) {
    if (!isRuntimeActivityEvent(event)) {
      flush();
      result.push({ event, representedEventIds: [event.id] });
      continue;
    }
    segment.push(event);
  }
  flush();
  return result;
}

type DrainBatchSelection = Readonly<{
  candidates: readonly CoalescedRuntimeEvent[];
  nextLaneCursor: number;
}>;

function selectDrainBatch(
  events: readonly CoalescedRuntimeEvent[],
  maximum: number,
  laneCursor = 0
): DrainBatchSelection {
  // Select one candidate per Task per round. A poison prefix from one Task
  // therefore cannot consume the whole bounded batch before a later Task gets
  // a chance to fold. Each lane itself remains in arrival order, preserving
  // the same-Task semantic fence; only cross-Task order is interleaved.
  const lanes = new Map<string, CoalescedRuntimeEvent[]>();
  for (const candidate of events) {
    const key = drainLaneKey(candidate.event);
    const lane = lanes.get(key);
    if (lane === undefined) lanes.set(key, [candidate]);
    else lane.push(candidate);
  }
  const laneStates = [...lanes.values()].map((candidates) => ({
    candidates,
    offset: 0
  }));
  if (laneStates.length === 0) {
    return { candidates: [], nextLaneCursor: 0 };
  }
  const startLane = positiveModulo(laneCursor, laneStates.length);
  const selected: CoalescedRuntimeEvent[] = [];
  let lastLane = startLane;
  while (selected.length < maximum) {
    let progressed = false;
    for (let laneOffset = 0; laneOffset < laneStates.length; laneOffset += 1) {
      const laneIndex = (startLane + laneOffset) % laneStates.length;
      const lane = laneStates[laneIndex]!;
      const candidate = lane.candidates[lane.offset];
      if (candidate === undefined) continue;
      lane.offset += 1;
      selected.push(candidate);
      lastLane = laneIndex;
      progressed = true;
      if (selected.length >= maximum) break;
    }
    // Every non-empty lane advances its offset when selected. Keep this
    // guard explicit so malformed/empty input cannot create a zero-progress
    // drain loop.
    if (!progressed) break;
  }
  return {
    candidates: selected,
    nextLaneCursor: (lastLane + 1) % laneStates.length
  };
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function drainLaneKey(event: RuntimeLifecycleEvent): string {
  const taskId = candidateTaskId(event);
  return taskId === undefined ? "global" : `task:${taskId}`;
}

function progressStreamKey(event: RuntimeObservationInboxEvent): string {
  const { fence, payload } = event.observation;
  return JSON.stringify([
    fence.taskId ?? null,
    fence.roleName,
    fence.agentId,
    fence.driverId,
    fence.launchId,
    fence.nativeSessionId ?? null,
    fence.runId ?? null,
    payload.activity,
    isRuntimeTokenEvidence(event.observation) ? "usage" : "signal"
  ]);
}

function isRuntimeActivityEvent(
  event: RuntimeLifecycleEvent
): event is RuntimeObservationInboxEvent {
  return event.type === "runtime-observation"
    && event.observation.kind === "activity.observed";
}

function emptyDrainFailure(error: unknown): RuntimeEventDrainResult {
  return {
    acknowledgedEventIds: [],
    deferred: [],
    failed: [{ scope: "unknown", error }],
    remainingEventCount: 0,
    metrics: {
      listedEventCount: 0,
      selectedEventCount: 0,
      semanticEventsSelected: 0,
      progressEventsSelected: 0,
      progressEventsCoalesced: 0,
      stateTransactions: 0,
      remainingSemanticEventCount: 0,
      remainingProgressEventCount: 0
    }
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError("Runtime event drain limit must be a positive integer.");
  }
  return resolved;
}

function isObsoleteRuntimeTurnObservation(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && (value as { disposition?: unknown }).disposition === "obsolete";
}

function candidateDrainFailure(
  event: RuntimeLifecycleEvent,
  error: unknown
): RuntimeEventDrainFailure {
  const eventId = nonEmptyString(event.id);
  if (event.scope === "task") {
    const taskId = nonEmptyString(event.taskId);
    if (eventId === undefined || taskId === undefined) {
      // A Task failure must carry a durable inbox fence. If an injected port
      // violates that parsed-event contract, do not incorrectly isolate it.
      return {
        ...(eventId === undefined ? {} : { eventId }),
        scope: "unknown",
        error
      };
    }
    return { eventId, scope: "task", taskId, error };
  }
  return {
    ...(eventId === undefined ? {} : { eventId }),
    scope: "global",
    error
  };
}

function selectTaskOrderedWave(
  candidates: readonly CoalescedRuntimeEvent[],
  offset: number,
  failedTaskIds: ReadonlySet<string>
): Readonly<{
  candidates: readonly CoalescedRuntimeEvent[];
  nextOffset: number;
}> {
  const selected: CoalescedRuntimeEvent[] = [];
  const selectedTaskIds = new Set<string>();
  let nextOffset = offset;
  while (nextOffset < candidates.length) {
    const candidate = candidates[nextOffset]!;
    const taskId = candidateTaskId(candidate.event);
    if (taskId !== undefined && failedTaskIds.has(taskId)) {
      nextOffset += 1;
      continue;
    }
    if (taskId !== undefined && selectedTaskIds.has(taskId)) break;
    selected.push(candidate);
    if (taskId !== undefined) selectedTaskIds.add(taskId);
    nextOffset += 1;
  }
  return { candidates: selected, nextOffset };
}

function recordDrainFailure(
  failure: RuntimeEventDrainFailure,
  failed: RuntimeEventDrainFailure[],
  failedTaskIds: Set<string>
): void {
  failed.push(failure);
  if (failure.scope === "task") failedTaskIds.add(failure.taskId);
}

function isTaskCandidateBlocked(
  event: RuntimeLifecycleEvent,
  failedTaskIds: ReadonlySet<string>
): boolean {
  const taskId = candidateTaskId(event);
  return taskId !== undefined && failedTaskIds.has(taskId);
}

function candidateTaskId(event: RuntimeLifecycleEvent): string | undefined {
  if (event.scope !== "task" || nonEmptyString(event.id) === undefined) return undefined;
  return nonEmptyString(event.taskId);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// -- async variant (worker backend) ------------------------------------------

/**
 * The async counterpart to {@link RuntimeTurnEventObserver}: every fold returns
 * a promise because the observer is hosted by the persistence worker (the
 * `FileSchedulerStoreAdapter` folds run off the main event loop). The main
 * thread only awaits; it never touches the db.
 */
export type AsyncRuntimeTurnEventObserver = Readonly<{
  getTask(taskId: string): Promise<SchedulerTask | null>;
  observeRuntimeObservation?(
    input: RuntimeObservation,
    now?: Date
  ): Promise<ProviderLifecycleObservation>;
  observeRuntimeTurnCompleted(
    input: TaskRuntimeTurnCompleted,
    now?: Date
  ): Promise<unknown>;
  observeGlobalRuntimeTurnCompleted(
    input: GlobalRuntimeTurnCompleted,
    now?: Date
  ): Promise<unknown>;
  classifyRuntimeTurnCompleted?(
    input: TaskRuntimeTurnCompleted
  ): Promise<"apply" | "deferred" | "obsolete">;
  classifyGlobalRuntimeTurnCompleted?(
    input: GlobalRuntimeTurnCompleted
  ): Promise<"apply" | "obsolete">;
  observeObsoleteRuntimeEvent?(
    input: Readonly<{
      eventId: string;
      eventType: RuntimeLifecycleEvent["type"];
      taskId: string;
      roleName: string;
      agentId: string;
      runId?: string;
      launchId?: string;
      nativeSessionId: string;
      reason: string;
    }>,
    now?: Date
  ): Promise<unknown>;
}>;

/** A generic invoker that ships an observer call to the worker (AsyncTaskStoreClient.invokeObserver). */
export type AsyncObserverInvoker = (method: string, args: unknown[]) => Promise<unknown>;

/**
 * Build an {@link AsyncRuntimeTurnEventObserver} that forwards every fold to the
 * worker-hosted adapter via {@link AsyncObserverInvoker}. The adapter's fold
 * logic (read-then-write transactions) runs in the worker, off the main event
 * loop; the main thread only awaits the result.
 */
export function createAsyncRuntimeObserver(invoke: AsyncObserverInvoker): AsyncRuntimeTurnEventObserver {
  const call = (method: string, args: unknown[]) => invoke(method, args);
  const withNow = (method: string, input: unknown, now?: Date) =>
    now === undefined ? call(method, [input]) : call(method, [input, now]);
  return {
    getTask: (taskId) => call("getTask", [taskId]) as Promise<SchedulerTask | null>,
    observeRuntimeObservation: (input, now) =>
      withNow("observeRuntimeObservation", input, now) as Promise<ProviderLifecycleObservation>,
    observeRuntimeTurnCompleted: (input, now) => withNow("observeRuntimeTurnCompleted", input, now),
    observeGlobalRuntimeTurnCompleted: (input, now) => withNow("observeGlobalRuntimeTurnCompleted", input, now),
    classifyRuntimeTurnCompleted: (input) => (
      call("classifyRuntimeTurnCompleted", [input]) as Promise<"apply" | "deferred" | "obsolete">
    ),
    classifyGlobalRuntimeTurnCompleted: (input) => (
      call("classifyGlobalRuntimeTurnCompleted", [input]) as Promise<"apply" | "obsolete">
    ),
    observeObsoleteRuntimeEvent: (input, now) => withNow("observeObsoleteRuntimeEvent", input, now)
  };
}

/**
 * The async counterpart to {@link FileRuntimeEventProcessor}: folds immutable
 * Hook facts one at a time (awaiting the worker-hosted observer) before
 * acknowledging them. The inbox itself is file-based and stays on the main
 * thread; only the db-touching folds are proxied to the worker.
 */
export class AsyncRuntimeEventProcessor {
  private readonly drivers: AgentDriverRegistry;
  private drainLaneCursor = 0;

  constructor(
    private readonly inbox: RuntimeEventInboxPort,
    private readonly observer: AsyncRuntimeTurnEventObserver,
    private readonly options: FileRuntimeEventProcessorOptions = {}
  ) {
    this.drivers = options.drivers ?? builtinAgentDriverRegistry();
  }

  async drainAsync(now: Date): Promise<RuntimeEventDrainResult> {
    const acknowledgedEventIds: string[] = [];
    const deferred: RuntimeLifecycleEvent[] = [];
    const failed: RuntimeEventDrainFailure[] = [];
    let events: readonly RuntimeLifecycleEvent[];
    try {
      events = this.inbox.list();
    } catch (error) {
      return emptyDrainFailure(error);
    }
    const coalesced = coalesceRuntimeProgress(events);
    const maximum = positiveInteger(
      this.options.maxEventsPerDrain,
      DEFAULT_MAX_RUNTIME_EVENTS_PER_DRAIN
    );
    const selection = selectDrainBatch(coalesced, maximum, this.drainLaneCursor);
    this.drainLaneCursor = selection.nextLaneCursor;
    const selected = selection.candidates;
    const failedTaskIds = new Set<string>();
    for (const candidate of selected) {
      const event = candidate.event;
      if (isTaskCandidateBlocked(event, failedTaskIds)) continue;
      try {
        let outcome: "applied" | "deferred" | "obsolete" = "applied";
        if (event.type === "native-turn-completed") {
          outcome = await this.applyNativeTurnCompleted(event, now);
        } else if (event.type === "runtime-observation") {
          outcome = await this.applyRuntimeObservation(event, now);
        } else {
          // f7/rr5: The supervisor already transitioned the job and
          // enqueued the Leader wakeup. This event is the durable terminal
          // channel: acknowledge it so the pipeline converges without
          // re-processing. No state change to apply.
        }
        if (outcome === "deferred") {
          deferred.push(event);
          this.acknowledge(
            candidate.representedEventIds.filter((id) => id !== event.id),
            acknowledgedEventIds
          );
          continue;
        }
        this.acknowledge(candidate.representedEventIds, acknowledgedEventIds);
      } catch (error) {
        recordDrainFailure(
          candidateDrainFailure(event, error),
          failed,
          failedTaskIds
        );
      }
    }
    const acknowledged = new Set(acknowledgedEventIds);
    const remaining = events.filter(({ id }) => !acknowledged.has(id));
    const progressEventsSelected = selected.filter(({ event }) => (
      isRuntimeActivityEvent(event)
    )).length;
    const representedEventCount = selected.reduce((count, candidate) => (
      count + candidate.representedEventIds.length
    ), 0);
    const remainingProgressEventCount = remaining.filter(isRuntimeActivityEvent).length;
    return {
      acknowledgedEventIds,
      deferred,
      failed,
      remainingEventCount: remaining.length,
      metrics: {
        listedEventCount: events.length,
        selectedEventCount: selected.length,
        semanticEventsSelected: selected.length - progressEventsSelected,
        progressEventsSelected,
        progressEventsCoalesced: representedEventCount - selected.length,
        stateTransactions: 0,
        remainingSemanticEventCount: remaining.length - remainingProgressEventCount,
        remainingProgressEventCount
      }
    };
  }

  private async applyRuntimeObservation(
    event: RuntimeObservationInboxEvent,
    now: Date
  ): Promise<"applied" | "deferred" | "obsolete"> {
    const taskId = event.observation.fence.taskId;
    if (taskId !== undefined) {
      const task = await this.observer.getTask(taskId);
      if (task === null
        || task.status !== "active"
        || task.executionGate.state !== "enabled") return "obsolete";
    }
    const outcome = (await this.observer.observeRuntimeObservation?.(event.observation, now))
      ?? "obsolete";
    const fence = event.observation.fence;
    if (outcome === "applied"
      && fence.taskId !== undefined
      && fence.nativeSessionId !== undefined
      && ["session.started", "session.ready", "turn.accepted", "turn.completed"]
        .includes(event.observation.kind)) {
      this.options.onTaskRuntimeApplied?.({
        taskId: fence.taskId,
        roleName: fence.roleName,
        agentId: fence.agentId,
        adapterId: this.drivers.require(fence.driverId).adapterId,
        launchId: fence.launchId,
        nativeSessionId: fence.nativeSessionId,
        ...(fence.runId === undefined ? {} : { runId: fence.runId })
      });
    }
    return outcome;
  }

  private async applyNativeTurnCompleted(
    event: RuntimeTurnCompletedEvent,
    now: Date
  ): Promise<"applied" | "deferred" | "obsolete"> {
    if (event.scope === "task") {
      const task = await this.observer.getTask(event.taskId!);
      const input: TaskRuntimeTurnCompleted = {
        eventId: event.id,
        taskId: event.taskId!,
        roleName: event.roleName,
        agentId: event.agentId,
        adapterId: event.adapterId,
        ...(event.launchId === undefined ? {} : { launchId: event.launchId }),
        nativeSessionId: event.nativeSessionId,
        turnId: event.turnId,
        ...(event.runId === undefined ? {} : { runId: event.runId }),
        summary: event.summary
      };
      if (task === null) return "obsolete";
      if (task.status !== "active" || task.executionGate.state !== "enabled") {
        await this.recordObsolete(
          event,
          task.status === "archived" ? "task-archived" : "task-retired",
          now
        );
        return "obsolete";
      }
      const disposition = (await this.observer.classifyRuntimeTurnCompleted?.(input)) ?? "apply";
      if (disposition === "deferred") return disposition;
      if (disposition === "obsolete") {
        await this.recordObsolete(event, "identity-mismatch-or-terminal", now);
        return disposition;
      }
      const observed = await this.observer.observeRuntimeTurnCompleted(input, now);
      if (isObsoleteRuntimeTurnObservation(observed)) {
        await this.recordObsolete(event, "runtime-cleanup-or-stopped-session", now);
        return "obsolete";
      }
      this.options.onTaskRuntimeApplied?.({
        taskId: event.taskId!,
        roleName: event.roleName,
        agentId: event.agentId,
        adapterId: event.adapterId,
        ...(event.launchId === undefined ? {} : { launchId: event.launchId }),
        nativeSessionId: event.nativeSessionId,
        ...(event.runId === undefined ? {} : { runId: event.runId })
      });
      return "applied";
    }
    const input: GlobalRuntimeTurnCompleted = {
      eventId: event.id,
      roleName: event.roleName,
      agentId: event.agentId,
      adapterId: event.adapterId,
      ...(event.launchId === undefined ? {} : { launchId: event.launchId }),
      nativeSessionId: event.nativeSessionId,
      turnId: event.turnId,
      ...(event.title === undefined ? {} : { title: event.title }),
      summary: event.summary
    };
    if ((await this.observer.classifyGlobalRuntimeTurnCompleted?.(input)) !== "obsolete") {
      await this.observer.observeGlobalRuntimeTurnCompleted(input, now);
      return "applied";
    }
    return "obsolete";
  }

  private async recordObsolete(event: RuntimeLifecycleEvent, reason: string, now: Date): Promise<void> {
    if (event.scope !== "task" || event.taskId === undefined || event.type === "durable-job-terminal") return;
    if (event.type === "runtime-observation") {
      const fence = event.observation.fence;
      if (fence.nativeSessionId === undefined) return;
      await this.observer.observeObsoleteRuntimeEvent?.({
        eventId: event.id,
        eventType: event.type,
        taskId: event.taskId,
        roleName: fence.roleName,
        agentId: fence.agentId,
        ...(fence.runId === undefined ? {} : { runId: fence.runId }),
        launchId: fence.launchId,
        nativeSessionId: fence.nativeSessionId,
        reason
      }, now);
      return;
    }
    await this.observer.observeObsoleteRuntimeEvent?.({
      eventId: event.id,
      eventType: event.type,
      taskId: event.taskId,
      roleName: event.roleName,
      agentId: event.agentId,
      ...(event.runId === undefined ? {} : { runId: event.runId }),
      ...(event.launchId === undefined ? {} : { launchId: event.launchId }),
      nativeSessionId: event.nativeSessionId,
      reason
    }, now);
  }

  private acknowledge(ids: readonly string[], acknowledged: string[]): void {
    if (this.inbox.acknowledgeMany !== undefined) {
      acknowledged.push(...this.inbox.acknowledgeMany(ids));
      return;
    }
    for (const id of ids) {
      if (this.inbox.acknowledge(id)) acknowledged.push(id);
    }
  }
}
