import { requireText } from "./validation.js";

export const DEFAULT_RECENT_TURN_ID_LIMIT = 32;

export function validateRecentTurnIds(
  value: unknown,
  limit = DEFAULT_RECENT_TURN_ID_LIMIT
): readonly string[] {
  const normalizedLimit = requireLimit(limit);
  if (!Array.isArray(value)) throw new Error("Recent Turn ids must be an array.");
  if (value.length > normalizedLimit) {
    throw new Error(`Recent Turn ids must not contain more than ${normalizedLimit} entries.`);
  }
  const result = value.map((turnId) => requireTextValue(turnId, "Recent Turn id"));
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
  return validateRecentTurnIds(recentTurnIds).includes(requireText(turnId, "Recent Turn id"));
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
