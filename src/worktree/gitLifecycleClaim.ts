import { runtimeError } from "../errors/cliError.js";
import { parseRepositoryLineageId } from "./gitCommand.js";

/**
 * A typed, durable-effect claim. It intentionally contains no role/session
 * schema: Git lifecycle workers are fenced by this exact operation tuple.
 */
export type GitLifecycleClaim = Readonly<{
  operationId: string;
  ownerId: string;
  generation: number;
  fencingToken: number;
  leaseExpiresAt: string;
}>;

export function createGitLifecycleClaim(value: GitLifecycleClaim): GitLifecycleClaim {
  return parseGitLifecycleClaim(value);
}

export function parseGitLifecycleClaim(value: unknown): GitLifecycleClaim {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw runtimeError("Invalid Git lifecycle claim.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 5 ||
    !Object.hasOwn(record, "operationId") ||
    !Object.hasOwn(record, "ownerId") ||
    !Object.hasOwn(record, "generation") ||
    !Object.hasOwn(record, "fencingToken") ||
    !Object.hasOwn(record, "leaseExpiresAt")
  ) {
    throw runtimeError("Invalid Git lifecycle claim.");
  }
  const operationId = parseRepositoryLineageId(record.operationId);
  const ownerId = parseRepositoryLineageId(record.ownerId);
  if (ownerId === operationId) throw runtimeError("Invalid Git lifecycle claim owner.");
  if (
    typeof record.generation !== "number" ||
    !Number.isSafeInteger(record.generation) ||
    record.generation < 1 ||
    typeof record.fencingToken !== "number" ||
    !Number.isSafeInteger(record.fencingToken) ||
    record.fencingToken <= record.generation ||
    typeof record.leaseExpiresAt !== "string" ||
    !isCanonicalTimestamp(record.leaseExpiresAt)
  ) {
    throw runtimeError("Invalid Git lifecycle claim.");
  }
  return Object.freeze({
    operationId,
    ownerId,
    generation: record.generation,
    fencingToken: record.fencingToken,
    leaseExpiresAt: record.leaseExpiresAt
  });
}

export function assertGitLifecycleClaimActive(
  claim: GitLifecycleClaim,
  now: Date
): GitLifecycleClaim {
  const parsed = parseGitLifecycleClaim(claim);
  if (Date.parse(parsed.leaseExpiresAt) <= now.getTime()) {
    throw runtimeError("Git lifecycle claim lease has expired.");
  }
  return parsed;
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
