/**
 * Resource GC data model (Issue 10).
 *
 * A Resource record describes one disk object Yui created — a managed Git
 * worktree, a deployment, or a runtime artifact — together with everything GC
 * needs to decide whether it may be released. The registry is GC's own state;
 * it never owns the resource lifecycle of another Issue.
 */

import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

export type ResourceKind = "worktree" | "deployment" | "runtime-artifact";

/**
 * The GC lifecycle of one resource.
 *
 * - `active`            referenced by a live owner; must never be touched.
 * - `releasable`        proven unreferenced, clean, and owner-terminal; a
 *                       quarantine candidate.
 * - `quarantined`       moved into the Home-local quarantine; recoverable.
 * - `deleted`           permanently removed after the observation window.
 * - `retained-dirty`    a Git worktree with uncommitted changes; kept.
 * - `retained-unowned`  ownership cannot be proven; reported, never removed.
 * - `cleanup-failed`    a removal attempt failed; the resource stayed in
 *                       place and the step is retryable.
 */
export type ResourceDisposition =
  | "active"
  | "releasable"
  | "quarantined"
  | "deleted"
  | "retained-dirty"
  | "retained-unowned"
  | "cleanup-failed";

/** How the owner of a resource was established. */
export type ResourceOwnerBasis =
  | "durable-record"
  | "marker"
  | "descriptor"
  | "naming-convention"
  | "unattributed";

export type ResourceOwner = Readonly<{
  home: string;
  projectId?: string;
  taskId?: string;
  workItemId?: string;
  reviewRoundId?: string;
  integrationAttemptId?: string;
  basis: ResourceOwnerBasis;
}>;

export type ResourceGitMetadata = Readonly<{
  repositoryPath: string;
  commonDir?: string;
  branch?: string;
  head?: string;
}>;

export type ResourceCleanliness = "clean" | "dirty" | "unknown" | "n/a";

export type ResourceQuarantineState = Readonly<{
  path: string;
  originalPath: string;
  movedAt: string;
}>;

export type ResourceCleanupReceipt = Readonly<{
  removedAt: string;
  method: "git-worktree-remove" | "quarantine-purge";
}>;

export type ResourceRecord = Readonly<{
  schemaVersion: 1;
  id: string;
  kind: ResourceKind;
  path: string;
  owner: ResourceOwner;
  git?: ResourceGitMetadata;
  createdAt?: string;
  lastReferencedAt?: string;
  sizeBytes?: number;
  cleanliness: ResourceCleanliness;
  /** Stable tokens describing who still references the resource. */
  activeRefs: readonly string[];
  disposition: ResourceDisposition;
  /** Why the resource is retained or failed, when applicable. */
  blocker?: string;
  quarantine?: ResourceQuarantineState;
  cleanupReceipt?: ResourceCleanupReceipt;
  updatedAt: string;
}>;

export type ResourceRegistryState = Readonly<{
  schemaVersion: 1;
  records: Readonly<Record<string, ResourceRecord>>;
}>;

export const RESOURCE_REGISTRY_SCHEMA_VERSION = 1 as const;

/** Stable record identity: the same kind+path always maps to the same id. */
export function resourceId(kind: ResourceKind, path: string): string {
  return createHash("sha256").update(`${kind}\u0000${path}`).digest("hex").slice(0, 16);
}

export function createResourceRecord(
  input: Readonly<Omit<ResourceRecord, "schemaVersion" | "id" | "updatedAt">>,
  now: Date
): ResourceRecord {
  return Object.freeze({
    schemaVersion: RESOURCE_REGISTRY_SCHEMA_VERSION,
    id: resourceId(input.kind, input.path),
    ...input,
    updatedAt: now.toISOString()
  });
}

/** A resource may be quarantined only when every live reference is gone. */
export function isReleasable(record: ResourceRecord): boolean {
  return record.disposition === "releasable"
    && record.activeRefs.length === 0
    && record.cleanliness !== "dirty";
}

/** Terminal Task statuses: a terminal owner keeps no active runtime claim. */
export function isTerminalTaskStatus(
  status: "draft" | "active" | "completed" | "retired" | "archived" | undefined
): boolean {
  return status === "completed" || status === "retired" || status === "archived";
}

/**
 * The immutable release namespace owned by the package installer (Issue 02).
 * GC never registers, quarantines, or deletes anything below it.
 */
export function isReleaseNamespacePath(home: string, path: string): boolean {
  const rel = relative(resolve(home), resolve(path));
  return rel === "runtime/releases" || rel.startsWith("runtime/releases/");
}
