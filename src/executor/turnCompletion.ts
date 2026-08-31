import { requireSafeIdentity, requireText, requireTimestamp } from "../runtime/validation.js";

export const DEFAULT_RECENT_TURN_ID_LIMIT = 32;

export type PendingTurnCompletion = Readonly<{
  schemaVersion: 1;
  taskId: string;
  roleName: string;
  agentId: string;
  nativeSessionId: string;
  turnId: string;
  runId: string;
  summary: string;
  observedAt: string;
  dueAt: string;
}>;

export type CreatePendingTurnCompletionInput = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  nativeSessionId: string;
  turnId: string;
  runId: string;
  summary: string;
  observedAt: Date;
  dueAt: Date;
}>;

const PENDING_TURN_COMPLETION_FIELDS = [
  "schemaVersion",
  "taskId",
  "roleName",
  "agentId",
  "nativeSessionId",
  "turnId",
  "runId",
  "summary",
  "observedAt",
  "dueAt"
] as const;

export function createPendingTurnCompletion(
  input: CreatePendingTurnCompletionInput
): PendingTurnCompletion {
  const observedAt = requireTimestamp(input.observedAt, "Turn observedAt");
  const dueAt = requireTimestamp(input.dueAt, "Turn dueAt");
  requireOrderedTimestamps(observedAt, dueAt);
  return {
    schemaVersion: 1,
    taskId: requireSafeIdentity(input.taskId, "Task id"),
    roleName: requireSafeIdentity(input.roleName, "Role name"),
    agentId: requireSafeIdentity(input.agentId, "Agent id"),
    nativeSessionId: requireText(input.nativeSessionId, "Native session id"),
    turnId: requireText(input.turnId, "Turn id"),
    runId: requireSafeIdentity(input.runId, "Run id"),
    summary: requireText(input.summary, "Turn summary"),
    observedAt,
    dueAt
  };
}

export function validatePendingTurnCompletion(value: unknown): PendingTurnCompletion {
  const input = requireRecord(value, "PendingTurnCompletion");
  requireExactFields(input, PENDING_TURN_COMPLETION_FIELDS, "PendingTurnCompletion");
  if (input.schemaVersion !== 1) {
    throw new Error("PendingTurnCompletion must use schemaVersion 1.");
  }
  const observedAt = requirePersistedTimestamp(
    input.observedAt,
    "PendingTurnCompletion observedAt"
  );
  const dueAt = requirePersistedTimestamp(
    input.dueAt,
    "PendingTurnCompletion dueAt"
  );
  requireOrderedTimestamps(observedAt, dueAt);
  return {
    schemaVersion: 1,
    taskId: requireSafeIdentityValue(input.taskId, "Task id"),
    roleName: requireSafeIdentityValue(input.roleName, "Role name"),
    agentId: requireSafeIdentityValue(input.agentId, "Agent id"),
    nativeSessionId: requireTextValue(input.nativeSessionId, "Native session id"),
    turnId: requireTextValue(input.turnId, "Turn id"),
    runId: requireSafeIdentityValue(input.runId, "Run id"),
    summary: requireTextValue(input.summary, "Turn summary"),
    observedAt,
    dueAt
  };
}

export function validateRecentTurnIds(
  value: unknown,
  limit = DEFAULT_RECENT_TURN_ID_LIMIT
): readonly string[] {
  const normalizedLimit = requireLimit(limit);
  if (!Array.isArray(value)) throw new Error("Recent Turn ids must be an array.");
  if (value.length > normalizedLimit) {
    throw new Error(`Recent Turn ids must not contain more than ${normalizedLimit} entries.`);
  }
  const result = value.map(
    (turnId) => requireTextValue(turnId, "Recent Turn id")
  );
  if (new Set(result).size !== result.length) {
    throw new Error("Recent Turn ids must not contain duplicates.");
  }
  return result;
}

export function rememberRecentTurnId(
  recentTurnIds: readonly string[],
  turnId: string,
  limit = DEFAULT_RECENT_TURN_ID_LIMIT
): readonly string[] {
  const normalizedLimit = requireLimit(limit);
  const existing = validateRecentTurnIds(recentTurnIds, normalizedLimit);
  const normalizedTurnId = requireText(turnId, "Recent Turn id");
  return [
    ...existing.filter((candidate) => candidate !== normalizedTurnId),
    normalizedTurnId
  ].slice(-normalizedLimit);
}

export function hasRecentTurnId(
  recentTurnIds: readonly string[],
  turnId: string
): boolean {
  const existing = validateRecentTurnIds(recentTurnIds);
  return existing.includes(requireText(turnId, "Recent Turn id"));
}

function requireOrderedTimestamps(observedAt: string, dueAt: string): void {
  if (Date.parse(dueAt) < Date.parse(observedAt)) {
    throw new Error("PendingTurnCompletion dueAt must not be earlier than observedAt.");
  }
}

function requirePersistedTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a valid timestamp.`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a valid timestamp.`);
  const canonical = new Date(timestamp).toISOString();
  if (value !== canonical) throw new Error(`${label} must be a canonical timestamp.`);
  return canonical;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string
): void {
  const expected = new Set(fields);
  const unknown = Object.keys(value).find((field) => !expected.has(field));
  if (unknown !== undefined) throw new Error(`${label} has unknown field: ${unknown}.`);
  const missing = fields.find((field) => !Object.hasOwn(value, field));
  if (missing !== undefined) throw new Error(`${label} is missing field: ${missing}.`);
}

function requireSafeIdentityValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  return requireSafeIdentity(value, label);
}

function requireTextValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  return requireText(value, label);
}

function requireLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Recent Turn id limit must be a positive integer.");
  }
  return value;
}
