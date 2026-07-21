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
  const normalizedTaskId = requiredText(taskId, "Task id");
  const normalizedReason = requiredText(reason, "Wakeup reason");
  if (existing !== null && existing.taskId !== normalizedTaskId) {
    throw new Error(`Pending wakeup belongs to another Task: ${existing.taskId}.`);
  }
  const timestamp = now.toISOString();
  return {
    schemaVersion: 1,
    taskId: normalizedTaskId,
    reasons: existing === null
      ? [normalizedReason]
      : [...new Set([...existing.reasons, normalizedReason])],
    requestCount: (existing?.requestCount ?? 0) + 1,
    firstRequestedAt: existing?.firstRequestedAt ?? timestamp,
    lastRequestedAt: timestamp
  };
}

export function pendingWakeupsMatch(left: PendingWakeup, right: PendingWakeup): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.taskId === right.taskId &&
    left.requestCount === right.requestCount &&
    left.firstRequestedAt === right.firstRequestedAt &&
    left.lastRequestedAt === right.lastRequestedAt &&
    left.reasons.length === right.reasons.length &&
    left.reasons.every((reason, index) => reason === right.reasons[index]);
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
