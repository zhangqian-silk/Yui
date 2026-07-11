export type PendingWakeup = {
  schemaVersion: 1;
  taskId: string;
  reasons: string[];
  requestCount: number;
  firstRequestedAt: string;
  lastRequestedAt: string;
};

export function mergePendingWakeup(
  taskId: string,
  reason: string,
  now: Date,
  existing: PendingWakeup | null
): PendingWakeup {
  const trimmedReason = reason.trim();

  if (trimmedReason.length === 0) {
    throw new Error("Wakeup reason is required.");
  }

  const timestamp = now.toISOString();

  return {
    schemaVersion: 1,
    taskId,
    reasons: existing === null
      ? [trimmedReason]
      : [...new Set([...existing.reasons, trimmedReason])],
    requestCount: (existing?.requestCount ?? 0) + 1,
    firstRequestedAt: existing?.firstRequestedAt ?? timestamp,
    lastRequestedAt: timestamp
  };
}
