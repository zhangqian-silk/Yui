import type { SchedulerTask } from "../scheduler/ports.js";
import type {
  FileRuntimeEventInbox,
  RuntimeClaudeStopFailureEvent,
  RuntimeLifecycleEvent,
  RuntimePromptAcceptedEvent,
  RuntimeProviderProgressEvent,
  RuntimeSessionLifecycleEvent,
  RuntimeTurnCompletedEvent
} from "./runtimeEventInbox.js";

export type TaskProviderSessionLifecycle = Readonly<{
  eventId: string;
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: "codex" | "claude";
  launchId: string;
  nativeSessionId: string;
  runId?: string;
  sessionSource?: string;
}>;

export type TaskProviderPromptAccepted = Readonly<{
  eventId: string;
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: "codex" | "claude";
  launchId: string;
  nativeSessionId: string;
  runId: string;
  receiptId: string;
}>;

export type TaskProviderTurnProgress = Readonly<{
  eventId: string;
  /** Immutable inbox admission time; provider activity must not use drain time. */
  receivedAt: string;
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: "codex" | "claude";
  launchId: string;
  nativeSessionId: string;
  runId: string;
  progressId: string;
  sequence?: number;
}>;

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

export type TaskClaudeStopFailureEvent = Readonly<{
  eventId: string;
  type: "claude-stop-failure";
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: "claude";
  launchId: string;
  nativeSessionId: string;
  runId: string;
  error: string;
  errorDetails?: string;
  lastAssistantMessage?: string;
}>;

export type RuntimeTurnEventObserver = Readonly<{
  /** Batch multiple inbox folds into one authoritative aggregate commit. */
  withRuntimeEventTransaction?<T>(execute: () => T): T;
  getTask(taskId: string): SchedulerTask | null;
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
  classifyClaudeStopFailureEvent?(
    input: TaskClaudeStopFailureEvent
  ): "apply" | "obsolete";
  observeClaudeStopFailureEvent?(
    input: TaskClaudeStopFailureEvent,
    now?: Date
  ): unknown;
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
  /** Folds a provider session-lifecycle fact through the canonical contract. */
  observeProviderSessionLifecycle?(
    input: TaskProviderSessionLifecycle,
    now?: Date
  ): ProviderLifecycleObservation;
  /** Folds a provider prompt-acceptance fact; only this may advance delivered. */
  observeProviderPromptAccepted?(
    input: TaskProviderPromptAccepted,
    now?: Date
  ): ProviderLifecycleObservation;
  /** Folds a provider-native in-turn progress fact through the canonical contract. */
  observeProviderTurnProgress?(
    input: TaskProviderTurnProgress,
    now?: Date
  ): ProviderLifecycleObservation;
}>;

export type RuntimeEventDrainFailure = Readonly<{
  eventId?: string;
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

export type FileRuntimeEventProcessorOptions = Readonly<{
  onTaskRuntimeApplied?: (input: Readonly<{
    taskId: string;
    roleName: string;
  }>) => void;
  /** Maximum folded representatives in one state transaction. */
  maxEventsPerDrain?: number;
}>;

type RuntimeEventInboxPort = Pick<FileRuntimeEventInbox, "list" | "acknowledge">
  & Partial<Pick<FileRuntimeEventInbox, "acknowledgeMany">>;

type CoalescedRuntimeEvent = Readonly<{
  event: RuntimeLifecycleEvent;
  representedEventIds: readonly string[];
}>;

type FoldedRuntimeEvent = Readonly<{
  candidate: CoalescedRuntimeEvent;
  outcome: "applied" | "deferred" | "obsolete";
  notifyTaskRuntime: boolean;
}>;

const DEFAULT_MAX_RUNTIME_EVENTS_PER_DRAIN = 64;

/** Folds immutable Hook facts in one bounded transaction before acknowledging them. */
export class FileRuntimeEventProcessor implements RuntimeEventProcessorPort {
  constructor(
    private readonly inbox: RuntimeEventInboxPort,
    private readonly observer: RuntimeTurnEventObserver,
    private readonly options: FileRuntimeEventProcessorOptions = {}
  ) {}

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
    const selected = selectDrainBatch(coalesced, maximum);
    let stateTransactions = 0;
    if (selected.length > 0 && this.observer.withRuntimeEventTransaction !== undefined) {
      try {
        stateTransactions += 1;
        const folded = this.observer.withRuntimeEventTransaction(() => (
          selected.map((candidate) => this.foldOne(candidate, now))
        ));
        for (const result of folded) {
          this.finalizeOne(result, acknowledgedEventIds, deferred, failed);
        }
      } catch {
        // A failed aggregate transaction commits nothing. Retry each candidate
        // independently so one bad event cannot strand unrelated facts.
        for (const candidate of selected) {
          try {
            stateTransactions += 1;
            const folded = this.observer.withRuntimeEventTransaction(() => (
              this.foldOne(candidate, now)
            ));
            this.finalizeOne(folded, acknowledgedEventIds, deferred, failed);
          } catch (candidateError) {
            failed.push({ eventId: candidate.event.id, error: candidateError });
          }
        }
      }
    } else {
      for (const candidate of selected) {
        try {
          const folded = this.foldOne(candidate, now);
          this.finalizeOne(folded, acknowledgedEventIds, deferred, failed);
        } catch (error) {
          failed.push({ eventId: candidate.event.id, error });
        }
      }
    }
    const progressEventsSelected = selected.filter(({ event }) => (
      event.type === "native-turn-progress"
    )).length;
    const representedEventCount = selected.reduce((count, candidate) => (
      count + candidate.representedEventIds.length
    ), 0);
    const acknowledged = new Set(acknowledgedEventIds);
    const remaining = events.filter(({ id }) => !acknowledged.has(id));
    const remainingProgressEventCount = remaining.filter(({ type }) => (
      type === "native-turn-progress"
    )).length;
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
      outcome = this.applyCodex(event, now);
    } else if (event.type === "claude-stop-failure") {
      this.applyClaudeStopFailure(event, now);
    } else if (event.type === "native-session-lifecycle") {
      outcome = this.applySessionLifecycle(event, now);
    } else if (event.type === "native-turn-progress") {
      outcome = this.applyProviderTurnProgress(event, now);
    } else {
      outcome = this.applyPromptAccepted(event, now);
    }
    return {
      candidate,
      outcome,
      notifyTaskRuntime: outcome === "applied" && (
        event.type === "native-session-lifecycle"
        || event.type === "native-prompt-accepted"
        || (event.type === "native-turn-completed" && event.scope === "task")
      )
    };
  }

  private finalizeOne(
    folded: FoldedRuntimeEvent,
    acknowledged: string[],
    deferred: RuntimeLifecycleEvent[],
    failed: RuntimeEventDrainFailure[]
  ): void {
    const { candidate, outcome } = folded;
    try {
      if (outcome === "deferred") {
        deferred.push(candidate.event);
        this.acknowledge(
          candidate.representedEventIds.filter((id) => id !== candidate.event.id),
          acknowledged
        );
        return;
      }
      if (folded.notifyTaskRuntime) {
        const event = candidate.event;
        if (event.scope === "task" && event.taskId !== undefined) {
          this.options.onTaskRuntimeApplied?.({
            taskId: event.taskId,
            roleName: event.roleName
          });
        }
      }
      this.acknowledge(candidate.representedEventIds, acknowledged);
    } catch (error) {
      failed.push({ eventId: candidate.event.id, error });
    }
  }

  private applySessionLifecycle(
    event: RuntimeSessionLifecycleEvent,
    now: Date
  ): "applied" | "deferred" | "obsolete" {
    const task = this.observer.getTask(event.taskId);
    if (task === null || task.status !== "active") return "obsolete";
    if (this.observer.observeProviderSessionLifecycle === undefined) return "obsolete";
    const outcome = this.observer.observeProviderSessionLifecycle({
      eventId: event.id,
      taskId: event.taskId,
      roleName: event.roleName,
      agentId: event.agentId,
      adapterId: event.adapterId,
      launchId: event.launchId,
      nativeSessionId: event.nativeSessionId,
      ...(event.runId === undefined ? {} : { runId: event.runId }),
      ...(event.sessionSource === undefined ? {} : { sessionSource: event.sessionSource })
    }, now);
    return outcome === "deferred" ? "deferred" : outcome;
  }

  private applyPromptAccepted(
    event: RuntimePromptAcceptedEvent,
    now: Date
  ): "applied" | "deferred" | "obsolete" {
    const task = this.observer.getTask(event.taskId);
    if (task === null || task.status !== "active") return "obsolete";
    if (this.observer.observeProviderPromptAccepted === undefined) return "obsolete";
    const outcome = this.observer.observeProviderPromptAccepted({
      eventId: event.id,
      taskId: event.taskId,
      roleName: event.roleName,
      agentId: event.agentId,
      adapterId: event.adapterId,
      launchId: event.launchId,
      nativeSessionId: event.nativeSessionId,
      runId: event.runId,
      receiptId: event.receiptId
    }, now);
    return outcome === "deferred" ? "deferred" : outcome;
  }

  private applyProviderTurnProgress(
    event: RuntimeProviderProgressEvent,
    now: Date
  ): "applied" | "deferred" | "obsolete" {
    const task = this.observer.getTask(event.taskId);
    if (task === null || task.status !== "active") return "obsolete";
    if (this.observer.observeProviderTurnProgress === undefined) return "obsolete";
    const outcome = this.observer.observeProviderTurnProgress({
      eventId: event.id,
      receivedAt: event.receivedAt,
      taskId: event.taskId,
      roleName: event.roleName,
      agentId: event.agentId,
      adapterId: event.adapterId,
      launchId: event.launchId,
      nativeSessionId: event.nativeSessionId,
      runId: event.runId,
      progressId: event.progressId,
      ...(event.sequence === undefined ? {} : { sequence: event.sequence })
    }, now);
    return outcome === "deferred" ? "deferred" : "applied";
  }

  private applyCodex(
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
      if (task.status !== "active") {
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

  private applyClaudeStopFailure(
    event: RuntimeClaudeStopFailureEvent,
    now: Date
  ): void {
    const task = this.observer.getTask(event.taskId);
    if (task === null) return;
    const input: TaskClaudeStopFailureEvent = {
      eventId: event.id,
      type: event.type,
      taskId: event.taskId,
      roleName: event.roleName,
      agentId: event.agentId,
      adapterId: event.adapterId,
      launchId: event.launchId,
      nativeSessionId: event.nativeSessionId,
      runId: event.runId,
      error: event.error,
      ...(event.errorDetails === undefined ? {} : { errorDetails: event.errorDetails }),
      ...(event.lastAssistantMessage === undefined
        ? {}
        : { lastAssistantMessage: event.lastAssistantMessage })
    };
    if (task.status !== "active"
      || this.observer.classifyClaudeStopFailureEvent?.(input) === "obsolete") {
      this.recordObsolete(
        event,
        task.status === "archived"
          ? "task-archived"
          : task.status !== "active"
            ? "task-retired"
            : "identity-mismatch-or-terminal",
        now
      );
      return;
    }
    if (this.observer.observeClaudeStopFailureEvent === undefined) {
      throw new Error("Claude StopFailure observer is unavailable.");
    }
    this.observer.observeClaudeStopFailureEvent(input, now);
  }

  private recordObsolete(event: RuntimeLifecycleEvent, reason: string, now: Date): void {
    if (event.scope !== "task" || event.taskId === undefined) return;
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

function coalesceRuntimeProgress(
  events: readonly RuntimeLifecycleEvent[]
): CoalescedRuntimeEvent[] {
  const result: CoalescedRuntimeEvent[] = [];
  let segment = new Map<string, CoalescedRuntimeEvent>();
  const flush = (): void => {
    result.push(...segment.values());
    segment = new Map();
  };
  for (const event of events) {
    if (event.type !== "native-turn-progress") {
      flush();
      result.push({ event, representedEventIds: [event.id] });
      continue;
    }
    const key = progressStreamKey(event);
    const existing = segment.get(key);
    segment.set(key, {
      event,
      representedEventIds: [
        ...(existing?.representedEventIds ?? []),
        event.id
      ]
    });
  }
  flush();
  return result;
}

function selectDrainBatch(
  events: readonly CoalescedRuntimeEvent[],
  maximum: number
): CoalescedRuntimeEvent[] {
  // A batch is always an arrival-order prefix. Admission and drain coalescing
  // keep a progress flood bounded without allowing a later semantic fact to
  // overtake an earlier progress fence from another Run.
  return events.slice(0, maximum);
}

function progressStreamKey(event: RuntimeProviderProgressEvent): string {
  return JSON.stringify([
    event.taskId,
    event.roleName,
    event.agentId,
    event.adapterId,
    event.launchId,
    event.nativeSessionId,
    event.runId
  ]);
}

function emptyDrainFailure(error: unknown): RuntimeEventDrainResult {
  return {
    acknowledgedEventIds: [],
    deferred: [],
    failed: [{ error }],
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
