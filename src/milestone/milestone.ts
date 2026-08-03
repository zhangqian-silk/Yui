import { validateTaskRecordReference } from "../task/taskRecordReference.js";

export type Milestone = {
  schemaVersion: 1;
  id: string;
  taskId: string;
  title: string;
  summary: string;
  createdBy: "leader";
  createdAt: string;
};

export function createMilestone(
  id: string,
  taskId: string,
  title: string,
  summary: string,
  now: Date
): Milestone {
  return {
    schemaVersion: 1,
    id: validateTaskRecordReference({ taskId, localId: id }, "milestone").localId,
    taskId: requireSafeIdentity(taskId, "Task id"),
    title: requireText(title, "Milestone title"),
    summary: requireText(summary, "Milestone summary"),
    createdBy: "leader",
    createdAt: now.toISOString()
  };
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
