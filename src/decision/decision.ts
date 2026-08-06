import { validateTaskRecordReference } from "../task/taskRecordReference.js";

export type DecisionStatus = "active" | "superseded";

export type Decision = {
  schemaVersion: 1;
  id: string;
  taskId: string;
  title: string;
  rationale: string;
  status: DecisionStatus;
  supersededReason?: string;
  supersededAt?: string;
  createdAt: string;
  updatedAt: string;
};

export function createDecision(
  id: string,
  taskId: string,
  title: string,
  rationale: string,
  now: Date
): Decision {
  const timestamp = now.toISOString();
  return {
    schemaVersion: 1,
    id: validateTaskRecordReference({ taskId, localId: id }, "decision").localId,
    taskId: requireSafeIdentity(taskId, "Task id"),
    title: requireText(title, "Decision title"),
    rationale: requireText(rationale, "Decision rationale"),
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function supersedeDecision(decision: Decision, reason: string, now: Date): Decision {
  if (decision.status === "superseded") {
    throw new Error(`Decision is already superseded: ${decision.id}.`);
  }
  const timestamp = now.toISOString();
  return {
    ...decision,
    status: "superseded",
    supersededReason: requireText(reason, "Decision supersede reason"),
    supersededAt: timestamp,
    updatedAt: timestamp
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
