export type LeaderFailure = {
  schemaVersion: 1;
  taskId: string;
  nativeSessionId: string;
  message: string;
  attemptCount: number;
  firstFailedAt: string;
  lastFailedAt: string;
};

export function recordLeaderFailure(
  taskId: string,
  nativeSessionId: string,
  message: string,
  now: Date,
  existing: LeaderFailure | null
): LeaderFailure {
  const timestamp = now.toISOString();
  return {
    schemaVersion: 1,
    taskId: requiredText(taskId, "Task id"),
    nativeSessionId: requiredText(nativeSessionId, "Native session id"),
    message: requiredText(message, "Leader failure message"),
    attemptCount: (existing?.attemptCount ?? 0) + 1,
    firstFailedAt: existing?.firstFailedAt ?? timestamp,
    lastFailedAt: timestamp
  };
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
