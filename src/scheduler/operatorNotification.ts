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
    taskId,
    type: "leader-recovery-failed",
    message,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}
