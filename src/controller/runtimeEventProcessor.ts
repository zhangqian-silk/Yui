import type { SchedulerTask } from "../scheduler/ports.js";
import type { FileRuntimeEventInbox } from "./runtimeEventInbox.js";
import type { RuntimeTurnCompletedEvent } from "./runtimeEventInbox.js";

type TaskRuntimeTurnCompleted = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  turnId: string;
  runId?: string;
  summary: string;
}>;

type GlobalRuntimeTurnCompleted = Readonly<{
  roleName: string;
  agentId: string;
  adapterId: string;
  nativeSessionId: string;
  turnId: string;
}>;

export type RuntimeTurnEventObserver = Readonly<{
  getTask(taskId: string): SchedulerTask | null;
  observeRuntimeNativeSessionFact?(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId: string;
  }>, now?: Date): boolean;
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
}>;

export type RuntimeEventDrainFailure = Readonly<{
  eventId: string;
  error: unknown;
}>;

export type RuntimeEventDrainResult = Readonly<{
  acknowledgedEventIds: readonly string[];
  deferred: readonly RuntimeTurnCompletedEvent[];
  failed: readonly RuntimeEventDrainFailure[];
}>;

export interface RuntimeEventProcessorPort {
  drain(now: Date): RuntimeEventDrainResult;
}

/**
 * Folds immutable Hook facts into the authoritative state one event at a time.
 * An event is acknowledged only after its state transaction succeeds. A late
 * event for an already archived/deleted Task is obsolete and can be discarded.
 */
export class FileRuntimeEventProcessor implements RuntimeEventProcessorPort {
  constructor(
    private readonly inbox: Pick<FileRuntimeEventInbox, "list" | "acknowledge">,
    private readonly observer: RuntimeTurnEventObserver
  ) {}

  drain(now: Date): RuntimeEventDrainResult {
    const acknowledgedEventIds: string[] = [];
    const deferred: RuntimeTurnCompletedEvent[] = [];
    const failed: RuntimeEventDrainFailure[] = [];
    for (const event of this.inbox.list()) {
      try {
        if (event.scope === "task") {
          const task = this.observer.getTask(event.taskId!);
          if (task === null || task.status === "archived") {
            this.acknowledge(event.id, acknowledgedEventIds);
            continue;
          }
          const input = {
            taskId: event.taskId!,
            roleName: event.roleName,
            agentId: event.agentId,
            adapterId: event.adapterId,
            nativeSessionId: event.nativeSessionId,
            turnId: event.turnId,
            ...(event.runId === undefined ? {} : { runId: event.runId }),
            summary: event.summary
          };
          this.observer.observeRuntimeNativeSessionFact?.({
            taskId: input.taskId,
            roleName: input.roleName,
            agentId: input.agentId,
            adapterId: input.adapterId,
            nativeSessionId: input.nativeSessionId
          }, now);
          const disposition = this.observer.classifyRuntimeTurnCompleted?.(input)
            ?? "apply";
          if (disposition === "deferred") {
            deferred.push(event);
            continue;
          }
          if (disposition === "obsolete") {
            this.acknowledge(event.id, acknowledgedEventIds);
            continue;
          }
          this.observer.observeRuntimeTurnCompleted(input, now);
        } else {
          const input = {
            roleName: event.roleName,
            agentId: event.agentId,
            adapterId: event.adapterId,
            nativeSessionId: event.nativeSessionId,
            turnId: event.turnId
          };
          if (this.observer.classifyGlobalRuntimeTurnCompleted?.(input) !== "obsolete") {
            this.observer.observeGlobalRuntimeTurnCompleted(input, now);
          }
        }
        this.acknowledge(event.id, acknowledgedEventIds);
      } catch (error) {
        failed.push({ eventId: event.id, error });
      }
    }
    return { acknowledgedEventIds, deferred, failed };
  }

  private acknowledge(id: string, acknowledged: string[]): void {
    this.inbox.acknowledge(id);
    acknowledged.push(id);
  }
}
