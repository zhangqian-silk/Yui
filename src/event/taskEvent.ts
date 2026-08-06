import { validateTaskRecordReference } from "../task/taskRecordReference.js";

export type TaskEventPayload = Record<string, string>;

export type TaskEvent = {
  schemaVersion: 2;
  id: string;
  taskId: string;
  type: string;
  payload: TaskEventPayload;
  createdAt: string;
};

export function createTaskEvent(
  id: string,
  taskId: string,
  type: string,
  payload: TaskEventPayload,
  now: Date
): TaskEvent {
  const event: TaskEvent = {
    schemaVersion: 2,
    id: requireText(id, "Task event id"),
    taskId: requireText(taskId, "Task event Task id"),
    type: requireText(type, "Task event type"),
    payload: normalizePayload(payload),
    createdAt: now.toISOString()
  };
  validateTaskRecordReference({ taskId: event.taskId, localId: event.id }, "event");
  return event;
}

/**
 * Builds the next Event history without mutating or replacing an existing entry.
 * Persistence adapters should enforce the same unique-id rule when appending.
 */
export function appendTaskEvent(
  history: readonly TaskEvent[],
  event: TaskEvent
): TaskEvent[] {
  if (history.some((existing) => existing.id === event.id)) {
    throw new Error(`Task event already exists: ${event.id}.`);
  }
  return [...history, { ...event, payload: { ...event.payload } }];
}

function normalizePayload(payload: TaskEventPayload): TaskEventPayload {
  const normalized: TaskEventPayload = {};
  for (const [key, value] of Object.entries(payload)) {
    const normalizedKey = requireText(key, "Task event payload key");
    if (["__proto__", "prototype", "constructor"].includes(normalizedKey)) {
      throw new Error(`Task event payload key is invalid: ${normalizedKey}.`);
    }
    if (Object.hasOwn(normalized, normalizedKey)) {
      throw new Error(`Task event payload key is duplicated: ${normalizedKey}.`);
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw new Error(`Task event payload value is invalid: ${normalizedKey}.`);
    }
    normalized[normalizedKey] = value;
  }
  return normalized;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
