import { enqueueWork, type WorkMailboxQueueStore } from "../coordination/workMailboxQueue.js";
import { createTaskEvent, type TaskEvent, type TaskEventPayload } from "../event/taskEvent.js";
import type { PendingWakeup } from "./pendingWakeup.js";
import { queueLeaderWakeup } from "./wakeupQueue.js";

export const LEADER_ATTENTION_REQUIRED_EVENT = "leader.attention-required";

type OperatorEventStore = WorkMailboxQueueStore & Readonly<{
  nextEventId(taskId: string): string;
  saveEvent(taskId: string, event: TaskEvent): void;
}>;

type RoleEventStore = WorkMailboxQueueStore & Readonly<{
  getPendingWakeup(taskId: string): PendingWakeup | null;
  savePendingWakeup(wakeup: PendingWakeup): void;
}>;

/** The sole Task-event boundary into the global Operator mailbox. */
export function enqueueOperatorEvent(
  store: WorkMailboxQueueStore,
  event: TaskEvent,
  reason: string,
  now: Date
): void {
  enqueueWork(store, { kind: "operator" }, reason, now, [
    { type: "event", taskId: event.taskId, id: event.id }
  ], {
    source: "task-event",
    dedupeKey: `operator-event:${event.taskId}:${event.id}`
  });
}

/** Routes one Role fact to its supervisor without exposing Provider details to Operator code. */
export function routeRoleEvent(
  store: RoleEventStore,
  event: TaskEvent,
  roleName: string,
  reason: string,
  now: Date
): void {
  if (roleName === "leader") {
    enqueueOperatorEvent(store, event, reason, now);
    return;
  }
  enqueueWork(
    store,
    { kind: "role", taskId: event.taskId, roleName: "leader" },
    reason,
    now,
    [{ type: "event", taskId: event.taskId, id: event.id }],
    {
      source: "task-event",
      dedupeKey: `leader-event:${event.taskId}:${event.id}`
    }
  );
  queueLeaderWakeup(store, event.taskId, reason, now);
}

/** Records the semantic boundary used when a Leader can no longer continue. */
export function recordLeaderAttentionRequired(
  store: OperatorEventStore,
  input: Readonly<{
    taskId: string;
    reason: string;
    payload?: TaskEventPayload;
    now: Date;
  }>
): TaskEvent {
  const event = createTaskEvent(
    store.nextEventId(input.taskId),
    input.taskId,
    LEADER_ATTENTION_REQUIRED_EVENT,
    { ...(input.payload ?? {}), reason: input.reason },
    input.now
  );
  store.saveEvent(input.taskId, event);
  enqueueOperatorEvent(
    store,
    event,
    "leader-attention-required",
    input.now
  );
  return event;
}
