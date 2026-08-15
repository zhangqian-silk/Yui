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
}>;

export interface RuntimeEventProcessorPort {
  drain(now: Date): RuntimeEventDrainResult;
}

/** The async counterpart: a processor whose folds run in the persistence worker. */
export interface AsyncRuntimeEventProcessorPort {
  drainAsync(now: Date): Promise<RuntimeEventDrainResult>;
}

export type FileRuntimeEventProcessorOptions = Readonly<{
  onTaskRuntimeApplied?: (input: Readonly<{
    taskId: string;
    roleName: string;
  }>) => void;
}>;

/** Folds immutable Hook facts one at a time before acknowledging them. */
export class FileRuntimeEventProcessor implements RuntimeEventProcessorPort {
  constructor(
    private readonly inbox: Pick<FileRuntimeEventInbox, "list" | "acknowledge">,
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
      return { acknowledgedEventIds, deferred, failed: [{ error }] };
    }
    for (const event of events) {
      try {
        if (event.type === "native-turn-completed") {
          const outcome = this.applyCodex(event, now);
          if (outcome === "deferred") {
            deferred.push(event);
            continue;
          }
        } else if (event.type === "claude-stop-failure") {
          this.applyClaudeStopFailure(event, now);
        } else if (event.type === "native-session-lifecycle") {
          const outcome = this.applySessionLifecycle(event, now);
          if (outcome === "deferred") {
            deferred.push(event);
            continue;
          }
        } else if (event.type === "native-turn-progress") {
          const outcome = this.applyProviderTurnProgress(event, now);
          if (outcome === "deferred") {
            deferred.push(event);
            continue;
          }
        } else {
          const outcome = this.applyPromptAccepted(event, now);
          if (outcome === "deferred") {
            deferred.push(event);
            continue;
          }
        }
        this.acknowledge(event.id, acknowledgedEventIds);
      } catch (error) {
        failed.push({ eventId: event.id, error });
      }
    }
    return { acknowledgedEventIds, deferred, failed };
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
    if (outcome === "applied") {
      this.options.onTaskRuntimeApplied?.({
        taskId: event.taskId,
        roleName: event.roleName
      });
    }
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
    if (outcome === "applied") {
      this.options.onTaskRuntimeApplied?.({
        taskId: event.taskId,
        roleName: event.roleName
      });
    }
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
      this.options.onTaskRuntimeApplied?.({
        taskId: event.taskId!,
        roleName: event.roleName
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

  private acknowledge(id: string, acknowledged: string[]): void {
    this.inbox.acknowledge(id);
    acknowledged.push(id);
  }
}

function isObsoleteRuntimeTurnObservation(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && (value as { disposition?: unknown }).disposition === "obsolete";
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
  classifyClaudeStopFailureEvent?(
    input: TaskClaudeStopFailureEvent
  ): Promise<"apply" | "obsolete">;
  observeClaudeStopFailureEvent?(
    input: TaskClaudeStopFailureEvent,
    now?: Date
  ): Promise<unknown>;
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
  observeProviderSessionLifecycle?(
    input: TaskProviderSessionLifecycle,
    now?: Date
  ): Promise<ProviderLifecycleObservation>;
  observeProviderPromptAccepted?(
    input: TaskProviderPromptAccepted,
    now?: Date
  ): Promise<ProviderLifecycleObservation>;
  observeProviderTurnProgress?(
    input: TaskProviderTurnProgress,
    now?: Date
  ): Promise<ProviderLifecycleObservation>;
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
    observeRuntimeTurnCompleted: (input, now) => withNow("observeRuntimeTurnCompleted", input, now),
    observeGlobalRuntimeTurnCompleted: (input, now) => withNow("observeGlobalRuntimeTurnCompleted", input, now),
    observeClaudeStopFailureEvent: (input, now) => withNow("observeClaudeStopFailureEvent", input, now),
    observeObsoleteRuntimeEvent: (input, now) => withNow("observeObsoleteRuntimeEvent", input, now),
    observeProviderSessionLifecycle: (input, now) =>
      withNow("observeProviderSessionLifecycle", input, now) as Promise<ProviderLifecycleObservation>,
    observeProviderPromptAccepted: (input, now) =>
      withNow("observeProviderPromptAccepted", input, now) as Promise<ProviderLifecycleObservation>,
    observeProviderTurnProgress: (input, now) =>
      withNow("observeProviderTurnProgress", input, now) as Promise<ProviderLifecycleObservation>
  };
}

/**
 * The async counterpart to {@link FileRuntimeEventProcessor}: folds immutable
 * Hook facts one at a time (awaiting the worker-hosted observer) before
 * acknowledging them. The inbox itself is file-based and stays on the main
 * thread; only the db-touching folds are proxied to the worker.
 */
export class AsyncRuntimeEventProcessor {
  constructor(
    private readonly inbox: Pick<FileRuntimeEventInbox, "list" | "acknowledge">,
    private readonly observer: AsyncRuntimeTurnEventObserver,
    private readonly options: FileRuntimeEventProcessorOptions = {}
  ) {}

  async drainAsync(now: Date): Promise<RuntimeEventDrainResult> {
    const acknowledgedEventIds: string[] = [];
    const deferred: RuntimeLifecycleEvent[] = [];
    const failed: RuntimeEventDrainFailure[] = [];
    let events: readonly RuntimeLifecycleEvent[];
    try {
      events = this.inbox.list();
    } catch (error) {
      return { acknowledgedEventIds, deferred, failed: [{ error }] };
    }
    for (const event of events) {
      try {
        if (event.type === "native-turn-completed") {
          const outcome = await this.applyCodex(event, now);
          if (outcome === "deferred") {
            deferred.push(event);
            continue;
          }
        } else if (event.type === "claude-stop-failure") {
          await this.applyClaudeStopFailure(event, now);
        } else if (event.type === "native-session-lifecycle") {
          const outcome = await this.applySessionLifecycle(event, now);
          if (outcome === "deferred") {
            deferred.push(event);
            continue;
          }
        } else if (event.type === "native-turn-progress") {
          const outcome = await this.applyProviderTurnProgress(event, now);
          if (outcome === "deferred") {
            deferred.push(event);
            continue;
          }
        } else {
          const outcome = await this.applyPromptAccepted(event, now);
          if (outcome === "deferred") {
            deferred.push(event);
            continue;
          }
        }
        this.acknowledge(event.id, acknowledgedEventIds);
      } catch (error) {
        failed.push({ eventId: event.id, error });
      }
    }
    return { acknowledgedEventIds, deferred, failed };
  }

  private async applySessionLifecycle(
    event: RuntimeSessionLifecycleEvent,
    now: Date
  ): Promise<"applied" | "deferred" | "obsolete"> {
    const task = await this.observer.getTask(event.taskId);
    if (task === null || task.status !== "active") return "obsolete";
    if (this.observer.observeProviderSessionLifecycle === undefined) return "obsolete";
    const outcome = await this.observer.observeProviderSessionLifecycle({
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
    if (outcome === "applied") {
      this.options.onTaskRuntimeApplied?.({
        taskId: event.taskId,
        roleName: event.roleName
      });
    }
    return outcome === "deferred" ? "deferred" : outcome;
  }

  private async applyPromptAccepted(
    event: RuntimePromptAcceptedEvent,
    now: Date
  ): Promise<"applied" | "deferred" | "obsolete"> {
    const task = await this.observer.getTask(event.taskId);
    if (task === null || task.status !== "active") return "obsolete";
    if (this.observer.observeProviderPromptAccepted === undefined) return "obsolete";
    const outcome = await this.observer.observeProviderPromptAccepted({
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
    if (outcome === "applied") {
      this.options.onTaskRuntimeApplied?.({
        taskId: event.taskId,
        roleName: event.roleName
      });
    }
    return outcome === "deferred" ? "deferred" : outcome;
  }

  private async applyProviderTurnProgress(
    event: RuntimeProviderProgressEvent,
    now: Date
  ): Promise<"applied" | "deferred" | "obsolete"> {
    const task = await this.observer.getTask(event.taskId);
    if (task === null || task.status !== "active") return "obsolete";
    if (this.observer.observeProviderTurnProgress === undefined) return "obsolete";
    const outcome = await this.observer.observeProviderTurnProgress({
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

  private async applyCodex(
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
      if (task.status !== "active") {
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
        roleName: event.roleName
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

  private async applyClaudeStopFailure(
    event: RuntimeClaudeStopFailureEvent,
    now: Date
  ): Promise<void> {
    const task = await this.observer.getTask(event.taskId);
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
      || (await this.observer.classifyClaudeStopFailureEvent?.(input)) === "obsolete") {
      await this.recordObsolete(
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
    await this.observer.observeClaudeStopFailureEvent(input, now);
  }

  private async recordObsolete(event: RuntimeLifecycleEvent, reason: string, now: Date): Promise<void> {
    if (event.scope !== "task" || event.taskId === undefined) return;
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

  private acknowledge(id: string, acknowledged: string[]): void {
    this.inbox.acknowledge(id);
    acknowledged.push(id);
  }
}
