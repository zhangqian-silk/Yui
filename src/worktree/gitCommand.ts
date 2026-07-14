import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { runtimeError } from "../errors/cliError.js";

export type GitObjectFormat = "sha1" | "sha256";

/**
 * Data-only exact-ref mutation authority. A physical executor must preserve
 * every reflog byte and identity. It may never create, append, unlink, or
 * rename a reflog; a different effect domain owns reflog maintenance.
 */
export type ExactRefEffect =
  | Readonly<{
      kind: "exact-ref-create";
      objectFormat: GitObjectFormat;
      fullRef: string;
      newOid: string;
    }>
  | Readonly<{
      kind: "exact-ref-delete";
      objectFormat: GitObjectFormat;
      fullRef: string;
      expectedOid: string;
    }>;

export type ExactRefInvocationPlan = Readonly<{
  repositoryLineageId: string;
  effect: ExactRefEffect;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_GIT_REF_BYTES = 1024;

export function parseGitObjectFormat(value: unknown): GitObjectFormat {
  if (value === "sha1" || value === "sha256") return value;
  throw runtimeError("Invalid Git object format.");
}

export function parseRepositoryLineageId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw runtimeError("Invalid repository lineage id.");
  }
  return value;
}

export function parseFullLocalBranchRef(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_GIT_REF_BYTES ||
    !value.startsWith("refs/heads/") ||
    value.length <= "refs/heads/".length ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    /[\u0000-\u0020\u007f-\u009f~^:?*\[\\]/u.test(value)
  ) {
    throw runtimeError("Invalid local branch ref.");
  }
  for (const segment of value.split("/")) {
    if (segment.length === 0 || segment === "." || segment === ".." || segment.endsWith(".lock")) {
      throw runtimeError("Invalid local branch ref.");
    }
  }
  return value;
}

export function parseExactRefEffect(value: unknown): ExactRefEffect {
  const record = exactRecord(value, "exact ref effect");
  if (record.kind === "exact-ref-create") {
    requireKeys(record, ["kind", "objectFormat", "fullRef", "newOid"], "exact ref effect");
    const objectFormat = parseGitObjectFormat(record.objectFormat);
    return Object.freeze({
      kind: "exact-ref-create" as const,
      objectFormat,
      fullRef: parseFullLocalBranchRef(record.fullRef),
      newOid: parseObjectId(record.newOid, objectFormat)
    });
  }
  if (record.kind === "exact-ref-delete") {
    requireKeys(record, ["kind", "objectFormat", "fullRef", "expectedOid"], "exact ref effect");
    const objectFormat = parseGitObjectFormat(record.objectFormat);
    return Object.freeze({
      kind: "exact-ref-delete" as const,
      objectFormat,
      fullRef: parseFullLocalBranchRef(record.fullRef),
      expectedOid: parseObjectId(record.expectedOid, objectFormat)
    });
  }
  throw runtimeError("Invalid exact ref effect.");
}

export function parseExactRefInvocationPlan(value: unknown): ExactRefInvocationPlan {
  const record = exactRecord(value, "exact ref invocation");
  requireKeys(record, ["repositoryLineageId", "effect"], "exact ref invocation");
  return Object.freeze({
    repositoryLineageId: parseRepositoryLineageId(record.repositoryLineageId),
    effect: parseExactRefEffect(record.effect)
  });
}

export function digestExactRefEffect(value: ExactRefEffect): string {
  const effect = parseExactRefEffect(value);
  return digestCanonical({
    schemaVersion: 1,
    domain: "taskmux.exact-ref-effect",
    effect
  });
}

export function digestExactRefInvocation(value: ExactRefInvocationPlan): string {
  const plan = parseExactRefInvocationPlan(value);
  return digestCanonical({
    schemaVersion: 1,
    domain: "taskmux.exact-ref-invocation",
    repositoryLineageId: plan.repositoryLineageId,
    effect: plan.effect
  });
}

export function parseObjectId(
  value: unknown,
  objectFormat: GitObjectFormat
): string {
  const length = objectFormat === "sha1" ? 40 : 64;
  if (typeof value !== "string" || value.length !== length || !/^[0-9a-f]+$/.test(value)) {
    throw runtimeError("Invalid Git object id.");
  }
  return value;
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw runtimeError(`Invalid ${label}.`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") throw runtimeError(`Invalid ${label}.`);
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw runtimeError(`Invalid ${label}.`);
    }
  }
  return record;
}

function requireKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const keys = Object.keys(record);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) {
    throw runtimeError(`Invalid ${label}.`);
  }
}
