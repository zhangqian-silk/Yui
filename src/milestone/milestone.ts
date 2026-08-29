import { validateTaskRecordReference } from "../task/taskRecordReference.js";
import type { TaskCompletedBy } from "../task/task.js";

export type Milestone = {
  schemaVersion: 2;
  id: string;
  taskId: string;
  title: string;
  summary: string;
  createdBy: TaskCompletedBy;
  createdAt: string;
};

export function createMilestone(
  id: string,
  taskId: string,
  title: string,
  summary: string,
  createdBy: TaskCompletedBy,
  now: Date
): Milestone {
  return {
    schemaVersion: 2,
    id: validateTaskRecordReference({ taskId, localId: id }, "milestone").localId,
    taskId: requireSafeIdentity(taskId, "Task id"),
    title: requireText(title, "Milestone title"),
    summary: requireText(summary, "Milestone summary"),
    createdBy: requireTaskControlActor(createdBy),
    createdAt: now.toISOString()
  };
}

function requireTaskControlActor(value: TaskCompletedBy): TaskCompletedBy {
  if (value !== "user" && value !== "operator" && value !== "leader") {
    throw new Error(`Milestone createdBy is invalid: ${String(value)}.`);
  }
  return value;
}

function requireSafeIdentity(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(normalized)
    || /[\/\\\0]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
