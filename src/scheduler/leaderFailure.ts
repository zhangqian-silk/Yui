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
    taskId,
    nativeSessionId,
    message,
    attemptCount: (existing?.attemptCount ?? 0) + 1,
    firstFailedAt: existing?.firstFailedAt ?? timestamp,
    lastFailedAt: timestamp
  };
}
