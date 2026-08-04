import type { TaskCompletedBy } from "../task/task.js";

export type LeaderRecoveryOperatorNotification = {
  schemaVersion: 1;
  taskId: string;
  type: "leader-recovery-failed";
  message: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskTerminalOperatorNotification = {
  schemaVersion: 1;
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
  | TaskTerminalOperatorNotification;

export function createLeaderRecoveryNotification(
  taskId: string,
  message: string,
  now: Date,
  existing: OperatorNotification | null
): LeaderRecoveryOperatorNotification {
  const timestamp = now.toISOString();
  return {
    schemaVersion: 1,
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
    schemaVersion: 1,
    taskId: requiredText(taskId, "Task id"),
    type: "task-terminal",
    status,
    by,
    summary: requiredText(summary, "Task terminal summary"),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
