import { createTaskEvent, type TaskEvent } from "../event/taskEvent.js";

export const TASK_RECORD_RETIRED_EVENT = "task.record-retired";

export const RETIRABLE_TASK_RECORD_KINDS = [
  "work-item",
  "message",
  "agent-run"
] as const;

export type RetirableTaskRecordKind = typeof RETIRABLE_TASK_RECORD_KINDS[number];
export type TaskRecordRetiredBy = "user" | "operator" | "leader";

export type TaskRecordRetirement = Readonly<{
  recordKind: RetirableTaskRecordKind;
  recordId: string;
  reason: string;
  retiredBy: TaskRecordRetiredBy;
}>;

/**
 * Appends a tombstone fact without rewriting the original record. Operational
 * projections ignore the retired identity; audit and list surfaces can still
 * render both the original bytes and this reasoned retirement event.
 */
export function createTaskRecordRetirement(
  input: Readonly<{
    eventId: string;
    taskId: string;
    recordKind: RetirableTaskRecordKind;
    recordId: string;
    reason: string;
    retiredBy: TaskRecordRetiredBy;
  }>,
  now: Date
): TaskEvent {
  return createTaskEvent(input.eventId, input.taskId, TASK_RECORD_RETIRED_EVENT, {
    recordKind: requireRecordKind(input.recordKind),
    recordId: requireText(input.recordId, "Task record id"),
    reason: requireText(input.reason, "Task record retirement reason"),
    retiredBy: requireRetiredBy(input.retiredBy)
  }, now);
}

export function taskRecordRetirement(
  event: TaskEvent
): TaskRecordRetirement | null {
  if (event.type !== TASK_RECORD_RETIRED_EVENT) return null;
  const recordKind = event.payload.recordKind;
  const retiredBy = event.payload.retiredBy;
  if (!RETIRABLE_TASK_RECORD_KINDS.includes(recordKind as RetirableTaskRecordKind)
    || (retiredBy !== "user" && retiredBy !== "operator" && retiredBy !== "leader")
    || event.payload.recordId?.trim().length === 0
    || event.payload.reason?.trim().length === 0) {
    return null;
  }
  return Object.freeze({
    recordKind: recordKind as RetirableTaskRecordKind,
    recordId: event.payload.recordId,
    reason: event.payload.reason,
    retiredBy
  });
}

export function retiredTaskRecordIds(
  events: readonly TaskEvent[],
  recordKind: RetirableTaskRecordKind
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const event of events) {
    const retirement = taskRecordRetirement(event);
    if (retirement?.recordKind === recordKind) ids.add(retirement.recordId);
  }
  return ids;
}

export function isTaskRecordRetired(
  events: readonly TaskEvent[],
  recordKind: RetirableTaskRecordKind,
  recordId: string
): boolean {
  return retiredTaskRecordIds(events, recordKind).has(recordId);
}

export function operationalTaskRecords<T extends Readonly<{ id: string }>>(
  records: readonly T[],
  events: readonly TaskEvent[],
  recordKind: RetirableTaskRecordKind
): T[] {
  const retired = retiredTaskRecordIds(events, recordKind);
  return retired.size === 0 ? [...records] : records.filter(({ id }) => !retired.has(id));
}

function requireRecordKind(value: RetirableTaskRecordKind): RetirableTaskRecordKind {
  if (!RETIRABLE_TASK_RECORD_KINDS.includes(value)) {
    throw new Error(`Task record retirement kind is invalid: ${String(value)}.`);
  }
  return value;
}

function requireRetiredBy(value: TaskRecordRetiredBy): TaskRecordRetiredBy {
  if (value !== "user" && value !== "operator" && value !== "leader") {
    throw new Error(`Task record retirement actor is invalid: ${String(value)}.`);
  }
  return value;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}
