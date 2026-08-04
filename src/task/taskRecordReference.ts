import { requireIdentity } from "../domain/validation.js";

export const TASK_RECORD_ID_PREFIXES = {
  workItem: "work-item",
  agentRun: "agent-run",
  reviewRound: "review-round",
  changeSet: "change-set",
  integrationAttempt: "integration",
  message: "message",
  inputRequest: "input",
  decision: "decision",
  milestone: "milestone",
  event: "event"
} as const;

export type TaskRecordKind = keyof typeof TASK_RECORD_ID_PREFIXES;

export type TaskRecordReference = Readonly<{
  taskId: string;
  localId: string;
}>;

export function formatTaskRecordReference(
  taskId: string,
  localId: string,
  kind: TaskRecordKind
): string {
  const reference = validateTaskRecordReference({ taskId, localId }, kind);
  return `${reference.taskId}/${reference.localId}`;
}

export function formatAgentRunReceiptId(taskId: string, runId: string): string {
  return `agent-run:${formatTaskRecordReference(taskId, runId, "agentRun")}`;
}

export function formatInputRequestReceiptId(taskId: string, requestId: string): string {
  return `input-request:${formatTaskRecordReference(taskId, requestId, "inputRequest")}`;
}

export function resolveTaskRecordReference(
  value: string,
  options: Readonly<{
    kind: TaskRecordKind;
    contextTaskId?: string;
    label: string;
  }>
): TaskRecordReference {
  const reference = normalizedReference(value, options.label);
  const firstSeparator = reference.indexOf("/");
  if (firstSeparator < 0) {
    if (options.contextTaskId === undefined) {
      throw new Error(
        `${options.label} has no Task context: ${reference}; `
        + `use task-<n>/${reference}.`
      );
    }
    return validateTaskRecordReference({
      taskId: options.contextTaskId,
      localId: reference
    }, options.kind);
  }
  if (firstSeparator === 0
    || firstSeparator === reference.length - 1
    || reference.indexOf("/", firstSeparator + 1) >= 0) {
    throw new Error(`${options.label} must use taskId/localId.`);
  }
  return validateTaskRecordReference({
    taskId: reference.slice(0, firstSeparator),
    localId: reference.slice(firstSeparator + 1)
  }, options.kind);
}

export function validateTaskRecordReference(
  value: TaskRecordReference,
  kind: TaskRecordKind
): TaskRecordReference {
  const taskId = requireIdentity(value.taskId, "Task id");
  const localId = requireIdentity(value.localId, `${TASK_RECORD_ID_PREFIXES[kind]} local id`);
  const match = new RegExp(`^${TASK_RECORD_ID_PREFIXES[kind]}-([1-9]\\d*)$`).exec(localId);
  if (match === null || !Number.isSafeInteger(Number(match[1]))) {
    throw new Error(
      `${TASK_RECORD_ID_PREFIXES[kind]} local id is invalid: ${localId}.`
    );
  }
  return { taskId, localId };
}

function normalizedReference(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  if (normalized !== value) throw new Error(`${label} must be normalized.`);
  return normalized;
}
