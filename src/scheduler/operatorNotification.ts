export type OperatorNotification = {
  schemaVersion: 1;
  taskId: string;
  type: "leader-recovery-failed";
  message: string;
  createdAt: string;
  updatedAt: string;
};

export function createLeaderRecoveryNotification(
  taskId: string,
  message: string,
  now: Date,
  existing: OperatorNotification | null
): OperatorNotification {
  const timestamp = now.toISOString();
  return {
    schemaVersion: 1,
    taskId: requiredText(taskId, "Task id"),
    type: "leader-recovery-failed",
    message: requiredText(message, "Operator notification message"),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
