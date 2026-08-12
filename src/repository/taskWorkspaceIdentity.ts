import { createHash, randomBytes } from "node:crypto";

import type { HomeIdentity } from "./homeIdentity.js";

/**
 * The durable, cross-Home-unique identity of a Task's managed Git workspace.
 *
 * The token binds the persistent Home identity, the Task id, this identity's
 * persistent generation time, and 128 bits of entropy through an unambiguous
 * length-prefixed SHA-256 encoding; only the first 8 lowercase hex chars are
 * used as the ref discriminator. Two Homes (or a stale ref from a crashed
 * attempt) therefore cannot silently share `yui/task-N-<token>/...`.
 *
 * The identity is generated once and persisted on the Task; restart, reconcile,
 * attach, and repeated preparation all reuse it. It is never derived from
 * Math.random, the process id, or the wall clock alone.
 */
export type TaskWorkspaceIdentity = Readonly<{
  schemaVersion: 1;
  homeId: string;
  taskId: string;
  token: string;
  generatedAt: string;
  entropy: string;
}>;

export const TASK_WORKSPACE_TOKEN_PATTERN = /^[a-f0-9]{8}$/;
/** Strict on-disk ref segment for a Task's managed worktrees. */
export const TASK_WORKSPACE_REF_SEGMENT_PATTERN = /^(task-[0-9]+)-[a-f0-9]{8}$/;
const TASK_WORKSPACE_ENTROPY_BYTES = 16;
const TASK_WORKSPACE_IDENTITY_DOMAIN = "yui-task-workspace-identity/v1";

/** Unambiguous length-prefixed encoding: every field is `<byteLen>:<value>`. */
function lengthPrefixedEncoding(parts: readonly string[]): string {
  return parts
    .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
    .join("\n");
}

export function deriveTaskWorkspaceToken(input: Readonly<{
  homeId: string;
  taskId: string;
  generatedAt: string;
  entropy: string;
}>): string {
  const encoding = lengthPrefixedEncoding([
    TASK_WORKSPACE_IDENTITY_DOMAIN,
    input.homeId,
    input.taskId,
    input.generatedAt,
    input.entropy
  ]);
  return createHash("sha256").update(encoding, "utf8").digest("hex").slice(0, 8);
}

export type TaskWorkspaceIdentityInput = Readonly<{
  home: HomeIdentity;
  taskId: string;
  now: Date;
  /** Injectable entropy source; production defaults to crypto.randomBytes(16). */
  entropy?: Buffer;
}>;

export function generateTaskWorkspaceIdentity(
  input: TaskWorkspaceIdentityInput
): TaskWorkspaceIdentity {
  const homeId = requireIdentityPart(input.home.homeId, "Home id");
  const taskId = requireIdentityPart(input.taskId, "Task id");
  const generatedAt = input.now.toISOString();
  const entropy = (input.entropy ?? randomBytes(TASK_WORKSPACE_ENTROPY_BYTES))
    .toString("hex");
  const token = deriveTaskWorkspaceToken({ homeId, taskId, generatedAt, entropy });
  return validateTaskWorkspaceIdentity({
    schemaVersion: 1,
    homeId,
    taskId,
    token,
    generatedAt,
    entropy
  });
}

/**
 * The ref segment shared by every managed worktree of one Task, e.g.
 * `task-2-a1b2c3d4`. Git refs and worktree directories are derived from this
 * segment, never from the bare Task id.
 */
export function taskWorkspaceRefSegmentFromIdentity(
  identity: TaskWorkspaceIdentity
): string {
  const valid = validateTaskWorkspaceIdentity(identity);
  return `${valid.taskId}-${valid.token}`;
}

/**
 * The durable ref segment for a Task. A Task with a persisted workspace
 * identity always uses its token-bearing segment; a pre-identity record (a
 * valid v4 Task that never had a managed Git workspace, or one awaiting the
 * controlled rebuild) keeps its bare Task id so its existing worktrees remain
 * addressable until they are rebuilt.
 */
export function taskWorkspaceRefSegment(
  task: Readonly<{ id: string; workspaceIdentity?: TaskWorkspaceIdentity }>
): string {
  if (task.workspaceIdentity === undefined) return task.id;
  return taskWorkspaceRefSegmentFromIdentity(task.workspaceIdentity);
}

/**
 * The strict main-branch ref for a Task workspace. The main branch is always
 * `yui/task-N-<8hex>/main`; any other shape is a foreign or legacy ref.
 */
export function taskMainBranch(refSegment: string): string {
  if (!TASK_WORKSPACE_REF_SEGMENT_PATTERN.test(refSegment)) {
    throw new Error(`Task workspace ref segment is invalid: ${refSegment}.`);
  }
  return `yui/${refSegment}/main`;
}

/**
 * A derived managed branch for one Task workspace member (WorkItem,
 * ReviewRound, or execution lane worktree name). Every derived ref stays
 * under the Task's token-bearing segment, so capture, review, integration,
 * and cleanup fences all resolve through the same persisted identity.
 */
export function taskDerivedBranch(refSegment: string, member: string): string {
  if (!TASK_WORKSPACE_REF_SEGMENT_PATTERN.test(refSegment)) {
    throw new Error(`Task workspace ref segment is invalid: ${refSegment}.`);
  }
  const memberSegment = member.trim();
  if (memberSegment.length === 0 || /[~^:?*[\]\s]/.test(memberSegment)
    || memberSegment.includes("..") || memberSegment.startsWith("-")) {
    throw new Error(`Task workspace member is invalid: ${member}.`);
  }
  return `yui/${refSegment}/${memberSegment}`;
}

/** The Integration Attempt branch derived from the Task workspace identity. */
export function taskIntegrationBranch(refSegment: string, integrationId: string): string {
  return taskDerivedBranch(refSegment, `integration/${integrationId}`);
}

/**
 * The non-colliding, auditable archive ref for a legacy Task ref. The Home id
 * in the path keeps two Homes' archives apart even when they share a Project
 * repository; the full original ref name is preserved verbatim.
 * Legacy refs live at `refs/heads/yui/task-N/...`; archives at
 * `refs/yui/archive/<homeId>/heads/yui/task-N/...`.
 */
export function taskArchiveRef(homeId: string, sourceRef: string): string {
  const id = requireIdentityPart(homeId, "Home id");
  const ref = sourceRef.trim();
  if (!ref.startsWith("refs/")
    || ref.includes("..")
    || /[~^:?*[\]\s]/.test(ref)) {
    throw new Error(`Archive source ref is invalid: ${sourceRef}.`);
  }
  return `refs/yui/archive/${id}/${ref.slice("refs/".length)}`;
}

/**
 * Whether a managed branch belongs to the legacy (pre-identity) layout:
 * `yui/task-N/...` with a bare Task id segment. Identity-bearing branches
 * (`yui/task-N-<8hex>/...`) are never legacy.
 */
export function isLegacyTaskRef(refName: string): boolean {
  const match = /^refs\/heads\/(yui\/(task-[0-9]+)\/.+)$/.exec(refName);
  return match !== null && !TASK_WORKSPACE_REF_SEGMENT_PATTERN.test(match[2]!);
}

export function validateTaskWorkspaceIdentity(
  identity: TaskWorkspaceIdentity
): TaskWorkspaceIdentity {
  if (identity.schemaVersion !== 1) {
    throw new Error("Task workspace identity must use schemaVersion 1.");
  }
  const homeId = requireIdentityPart(identity.homeId, "Home id");
  const taskId = requireIdentityPart(identity.taskId, "Task id");
  if (typeof identity.generatedAt !== "string"
    || !Number.isFinite(Date.parse(identity.generatedAt))) {
    throw new Error("Task workspace identity generatedAt is invalid.");
  }
  if (typeof identity.entropy !== "string"
    || !/^[a-f0-9]{32}$/.test(identity.entropy)) {
    throw new Error("Task workspace identity entropy is invalid.");
  }
  if (typeof identity.token !== "string"
    || !TASK_WORKSPACE_TOKEN_PATTERN.test(identity.token)) {
    throw new Error("Task workspace identity token is invalid.");
  }
  // The token must be the exact SHA-256 discriminator of the persisted fields;
  // a mismatched token is malformed state and is rejected, never repaired.
  const expected = deriveTaskWorkspaceToken({
    homeId,
    taskId,
    generatedAt: identity.generatedAt,
    entropy: identity.entropy
  });
  if (expected !== identity.token) {
    throw new Error("Task workspace identity token does not match its persisted fields.");
  }
  return identity;
}

function requireIdentityPart(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} is required.`);
  if (/[\/\\]/.test(trimmed)) throw new Error(`${label} must not contain a path separator.`);
  return trimmed;
}
