import type { TaskCompletedBy } from "../task/task.js";

export const CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION = 1 as const;

export type LeaderRecoveryOperatorNotification = {
  schemaVersion: typeof CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION;
  taskId: string;
  type: "leader-recovery-failed";
  message: string;
  createdAt: string;
  updatedAt: string;
};

export type LeaderStallNotification = {
  schemaVersion: typeof CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION;
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

export type TaskTerminalOperatorNotification = {
  schemaVersion: typeof CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION;
  taskId: string;
  type: "task-terminal";
  status: "completed" | "retired";
  by: TaskCompletedBy;
  summary: string;
  createdAt: string;
  updatedAt: string;
};

export type OperatorNotification =
  | LeaderRecoveryOperatorNotification
  | LeaderStallNotification
  | TaskTerminalOperatorNotification;
export function createLeaderRecoveryNotification(
  taskId: string,
  message: string,
  now: Date,
  existing: OperatorNotification | null
): LeaderRecoveryOperatorNotification {
  const timestamp = now.toISOString();
  return {
    schemaVersion: CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION,
    taskId: requiredText(taskId, "Task id"),
    type: "leader-recovery-failed",
    message: requiredText(message, "Operator notification message"),
    createdAt: existing?.type === "leader-recovery-failed"
      ? existing.createdAt
      : timestamp,
    updatedAt: timestamp
  };
}

export function createTaskTerminalNotification(
  taskId: string,
  status: "completed" | "retired",
  by: TaskCompletedBy,
  summary: string,
  now: Date
): TaskTerminalOperatorNotification {
  const timestamp = now.toISOString();
  return {
    schemaVersion: CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION,
    taskId: requiredText(taskId, "Task id"),
    type: "task-terminal",
    status,
    by,
    summary: requiredText(summary, "Task terminal summary"),
    createdAt: timestamp,
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
    schemaVersion: CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION,
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
