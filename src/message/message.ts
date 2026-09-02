import { validateTaskRecordReference } from "../task/taskRecordReference.js";

export const TASK_MESSAGE_KINDS = ["user", "operator", "role-result", "system"] as const;

export type TaskMessageKind = typeof TASK_MESSAGE_KINDS[number];

export type TaskMessageAuthor =
  | Readonly<{ type: "user" }>
  | Readonly<{ type: "operator" }>
  | Readonly<{ type: "role"; roleName: string }>
  | Readonly<{ type: "system" }>;

export type TaskMessage = {
  schemaVersion: 3;
  id: string;
  taskId: string;
  kind: TaskMessageKind;
  author: TaskMessageAuthor;
  body: string;
  /**
   * Machine-readable wake policy for user/operator messages (Issue 05).
   * - `leader`: the message is a directive that should wake the Leader.
   * - `none`: the message is informational context only; it must not wake
   *   the Leader or create a Leader Turn.
   * Absent on older messages and on role-result/system messages, which keep
   * their existing routing.
   */
  wakePolicy?: "leader" | "none";
  turnId?: string;
  workItemId?: string;
  createdAt: string;
};

export type TaskMessageContext = Readonly<{
  turnId?: string;
  workItemId?: string;
  wakePolicy?: "leader" | "none";
}>;

export type TaskMessageDraftUpdate = Readonly<{
  body: string;
  wakePolicy?: "leader" | "none";
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
    schemaVersion: 3,
    id: requireSafeIdentity(id, "Message id"),
    taskId: requireSafeIdentity(taskId, "Message Task id"),
    kind,
    author: normalizeAuthor(author),
    body: requireBody(body),
    ...(context.wakePolicy === undefined
      ? {}
      : { wakePolicy: context.wakePolicy }),
    ...(context.turnId === undefined
      ? {}
      : { turnId: requireSafeIdentity(context.turnId, "Message Turn id") }),
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

/** Replace only the mutable content of a Draft user/operator Message. */
export function updateDraftTaskMessage(
  message: TaskMessage,
  update: TaskMessageDraftUpdate
): TaskMessage {
  validateTaskMessage(message);
  if (message.kind !== "user" && message.kind !== "operator") {
    throw new Error(`Only user/operator Task Messages can be updated: ${message.id}.`);
  }
  const updated: TaskMessage = {
    ...message,
    body: requireBody(update.body),
    ...(update.wakePolicy === undefined
      ? {}
      : { wakePolicy: update.wakePolicy })
  };
  validateTaskMessage(updated);
  return updated;
}

export function validateTaskMessage(message: TaskMessage): void {
  if (message.schemaVersion !== 3) throw new Error("Task Message must use schemaVersion 3.");
  validateTaskRecordReference({ taskId: message.taskId, localId: message.id }, "message");
  requireText(message.body, "Message body");
  validateKindAndAuthor(message.kind, message.author);
  normalizeAuthor(message.author);
  if (message.wakePolicy !== undefined
    && message.wakePolicy !== "leader"
    && message.wakePolicy !== "none") {
    throw new Error(`Message wakePolicy is invalid: ${String(message.wakePolicy)}.`);
  }
  if (message.wakePolicy !== undefined
    && message.kind !== "user"
    && message.kind !== "operator") {
    throw new Error("Message wakePolicy is only valid for user/operator messages.");
  }
  if (message.turnId !== undefined) requireSafeIdentity(message.turnId, "Message Turn id");
  if (message.workItemId !== undefined) {
    validateTaskRecordReference({
      taskId: message.taskId,
      localId: message.workItemId
    }, "workItem");
  }
  if (message.turnId !== undefined) {
    validateTaskRecordReference({ taskId: message.taskId, localId: message.turnId }, "turn");
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

function requireBody(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Message body is invalid.");
  }
  if (value.trim().length === 0) throw new Error("Message body is required.");
  return value;
}
