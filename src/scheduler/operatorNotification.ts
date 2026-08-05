export type LeaderRecoveryNotification = {
  schemaVersion: 1;
  taskId: string;
  type: "leader-recovery-failed";
  message: string;
  createdAt: string;
  updatedAt: string;
};

export type LeaderStallNotification = {
  schemaVersion: 1;
  taskId: string;
  type: "leader-stalled";
  message: string;
  runId: string;
  progressAt: string;
  classification: "truly-stalled";
  evidenceKey: string;
  createdAt: string;
  updatedAt: string;
};

export type OperatorNotification = LeaderRecoveryNotification | LeaderStallNotification;

export function createLeaderRecoveryNotification(
  taskId: string,
  message: string,
  now: Date,
  existing: OperatorNotification | null
): LeaderRecoveryNotification {
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

export function createLeaderStallNotification(
  taskId: string,
  runId: string,
  progressAt: string,
  evidenceKey: string,
  now: Date,
  existing: OperatorNotification | null
): LeaderStallNotification {
  const timestamp = now.toISOString();
  const previous = existing?.type === "leader-stalled"
    && existing.runId === runId
    && existing.progressAt === progressAt
    ? existing
    : undefined;
  return {
    schemaVersion: 1,
    taskId: requiredText(taskId, "Task id"),
    type: "leader-stalled",
    message: requiredText([
      `Leader Run ${runId} is truly stalled for Task ${taskId}.`,
      `lastProgressAt=${progressAt}`,
      `classification=truly-stalled`,
      `evidence=${evidenceKey}`,
      "Inspect the Task context and decide whether to continue, reset, retry, change Agent, or request user input; Controller performed no automatic action."
    ].join(" "), "Operator notification message"),
    runId: requiredText(runId, "Leader Run id"),
    progressAt: requiredText(progressAt, "Leader progress timestamp"),
    classification: "truly-stalled",
    evidenceKey: requiredText(evidenceKey, "Leader stall evidence"),
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
