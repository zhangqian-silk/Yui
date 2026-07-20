export type TaskEventPayload = Record<string, string>;

export type TaskEvent = {
  schemaVersion: 1;
  id: string;
  type: string;
  payload: TaskEventPayload;
  createdAt: string;
};

export function createTaskEvent(
  id: string,
  type: string,
  payload: TaskEventPayload,
  now: Date
): TaskEvent {
  return {
    schemaVersion: 1,
    id: requireText(id, "Task event id"),
    type: requireText(type, "Task event type"),
    payload: { ...payload },
    createdAt: now.toISOString()
  };
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
