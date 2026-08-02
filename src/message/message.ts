import { validateTaskRecordReference } from "../task/taskRecordReference.js";

export const TASK_MESSAGE_KINDS = ["user", "operator", "role-result", "system"] as const;

export type TaskMessageKind = typeof TASK_MESSAGE_KINDS[number];

export type TaskMessageAuthor =
  | Readonly<{ type: "user" }>
  | Readonly<{ type: "operator" }>
  | Readonly<{ type: "role"; roleName: string }>
  | Readonly<{ type: "system" }>;

export type TaskMessage = {
  schemaVersion: 2;
  id: string;
  taskId: string;
  kind: TaskMessageKind;
  author: TaskMessageAuthor;
  body: string;
  runId?: string;
  workItemId?: string;
  createdAt: string;
};

export type TaskMessageContext = Readonly<{
  runId?: string;
  workItemId?: string;
}>;

export function createTaskMessage(
  id: string,
  taskId: string,
  body: string,
  kind: TaskMessageKind,
  author: TaskMessageAuthor,
  now: Date,
  context: TaskMessageContext = {}
): TaskMessage {
  validateKindAndAuthor(kind, author);
  const message: TaskMessage = {
    schemaVersion: 2,
    id: requireSafeIdentity(id, "Message id"),
    taskId: requireSafeIdentity(taskId, "Message Task id"),
    kind,
    author: normalizeAuthor(author),
    body: requireText(body, "Message body"),
    ...(context.runId === undefined
      ? {}
      : { runId: requireSafeIdentity(context.runId, "Message Run id") }),
    ...(context.workItemId === undefined
      ? {}
      : { workItemId: requireSafeIdentity(context.workItemId, "Message Work item id") }),
    createdAt: now.toISOString()
  };
  validateTaskMessage(message);
  return message;
}

export function taskMessageAuthorLabel(author: TaskMessageAuthor): string {
  return author.type === "role" ? author.roleName : author.type;
}

export function validateTaskMessage(message: TaskMessage): void {
  if (message.schemaVersion !== 2) throw new Error("Task Message must use schemaVersion 2.");
  validateTaskRecordReference({ taskId: message.taskId, localId: message.id }, "message");
  requireText(message.body, "Message body");
  validateKindAndAuthor(message.kind, message.author);
  normalizeAuthor(message.author);
  if (message.runId !== undefined) requireSafeIdentity(message.runId, "Message Run id");
  if (message.workItemId !== undefined) {
    validateTaskRecordReference({
      taskId: message.taskId,
      localId: message.workItemId
    }, "workItem");
  }
  if (message.runId !== undefined) {
    validateTaskRecordReference({ taskId: message.taskId, localId: message.runId }, "agentRun");
  }
  if (typeof message.createdAt !== "string" || Number.isNaN(Date.parse(message.createdAt))) {
    throw new Error("Message createdAt is invalid.");
  }
}

function validateKindAndAuthor(kind: TaskMessageKind, author: TaskMessageAuthor): void {
  if (!TASK_MESSAGE_KINDS.includes(kind)) throw new Error(`Message kind is invalid: ${String(kind)}.`);
  const expectedType = kind === "role-result" ? "role" : kind;
  if (author?.type !== expectedType) {
    const label = kind === "role-result" ? "Role result" : `Message kind ${kind}`;
    throw new Error(`${label} requires a ${expectedType} author.`);
  }
}

function normalizeAuthor(author: TaskMessageAuthor): TaskMessageAuthor {
  return author.type === "role"
    ? { type: "role", roleName: requireSafeIdentity(author.roleName, "Message Role name") }
    : { type: author.type };
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
