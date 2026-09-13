import { createTaskEvent } from "../event/taskEvent.js";
import type { TaskStore } from "../storage/taskStore.js";
import { StorageRecordError, StorageConflictError, StorageCancelledError } from "../storage/taskStore.js";
import { StorageSchemaError } from "../storage/storageSchema.js";
import type { Task } from "./task.js";
import type { TaskRemoteDelivery } from "./remoteDelivery.js";
import { managedWorkspaceKey } from "../worktree/managedWorkspace.js";

export type ArchiveDiagnostic = Readonly<{
  resource: string;
  detail: string;
  paths?: readonly string[];
}>;

export class ArchiveAuditPersistenceError extends Error {
  constructor(cause: unknown) {
    super(`Archive audit could not be persisted: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "ArchiveAuditPersistenceError";
  }
}

export function isArchivePersistenceFailure(error: unknown): boolean {
  return error instanceof ArchiveAuditPersistenceError
    || error instanceof StorageRecordError || error instanceof StorageConflictError
    || error instanceof StorageCancelledError || error instanceof StorageSchemaError
    || (error instanceof Error && (
      ("code" in error && String(error.code).startsWith("SQLITE_"))
      || (error.cause !== undefined && error.cause !== error && isArchivePersistenceFailure(error.cause))
    ));
}

/** Current resource references, not another cleanup queue or writable status. */
export function archiveRetainedResources(store: TaskStore, task: Task): ArchiveDiagnostic[] {
  const workspaces = store.listManagedWorkspaces(task.id);
  const resources: ArchiveDiagnostic[] = workspaces.map(workspace => ({
    resource: managedWorkspaceKey(workspace.owner),
    detail: "Managed workspace retained; removal has not been recorded.",
    paths: [workspace.root, ...workspace.entries.filter(e => e.access === "write").map(e => e.path)]
  }));
  if (task.cwd !== undefined && !workspaces.some(w => w.owner.type === "task")) {
    resources.push({ resource: `task:${task.id}`, detail: "Task workspace reference retained.", paths: [task.cwd] });
  }
  for (const run of store.listRuns(task.id).filter(r => r.status === "active")) {
    resources.push({ resource: `run:${task.id}/${run.id}`,
      detail: `AgentRun remains active (${run.roleName}); archive is not stop evidence.` });
  }
  for (const job of store.listDurableJobs(task.id).filter(j =>
    ["queued", "running", "unknown-needs-attention"].includes(j.status))) {
    resources.push({ resource: `job:${task.id}/${job.id}`, detail: `DurableJob remains ${job.status}.` });
  }
  for (const attempt of store.listIntegrationAttempts(task.id).filter(a =>
    ["running", "blocked", "conflicted", "validating"].includes(a.status))) {
    resources.push({ resource: `integration-attempt:${task.id}/${attempt.id}`,
      detail: `Integration remains ${attempt.status}.` });
  }
  for (const item of store.listWorkItems(task.id).filter(i => i.status === "open")) {
    resources.push({ resource: `work-item:${task.id}/${item.id}`, detail: "WorkItem remains unaccepted." });
  }
  for (const round of store.listReviewRounds(task.id).filter(r =>
    !["completed", "failed"].includes(r.status))) {
    resources.push({ resource: `review-round:${task.id}/${round.id}`, detail: `Review remains ${round.status}.` });
  }
  for (const input of store.listInputRequests(task.id).filter(i => i.status === "open")) {
    resources.push({ resource: `input:${task.id}/${input.id}`, detail: "Unresolved input preserved; not answered by archive." });
  }
  for (const role of store.listRoles(task.id)) {
    const sessions = store.getTaskRoleSessionSet(task.id, role.name);
    for (const session of Object.values(sessions?.sessions ?? {})) {
      if (session.status === "ended") continue;
      resources.push({ resource: `session:${task.id}/${role.name}/${session.agentId}/${session.nativeSessionId}`,
        detail: `Session is ${session.status}; physical quiescence is not established by archive.` });
    }
    const provider = sessions?.providerBinding;
    if (provider !== undefined && provider !== null && provider.run != null
      && !["completed", "failed", "cancelled"].includes(provider.run.status)) {
      resources.push({ resource: `provider-input:${task.id}/${role.name}/${provider.run.attemptId}`,
        detail: `Provider input is ${provider.run.status}; exact input identity is retained.` });
    }
  }
  for (const mailbox of store.listWorkMailboxes()) {
    const target = mailbox.target;
    if (!("taskId" in target) || target.taskId !== task.id) continue;
    if (mailbox.processing === null && mailbox.pending === null) continue;
    resources.push({
      resource: `mailbox:${target.kind}:${task.id}${"roleName" in target ? `/${target.roleName}` : ""}`,
      detail: `Original mailbox retained${mailbox.processing === null ? "" : ` (${mailbox.processing.batchId})`}; not replayed or acknowledged by archive.`
    });
  }
  return resources;
}

export function archiveDeliveryWarnings(delivery: TaskRemoteDelivery): ArchiveDiagnostic[] {
  return delivery.projects.filter(p => p.codeDelivery !== "none" && (!p.merged || !p.verified))
    .map(p => ({ resource: `delivery:${delivery.taskId}/${p.projectId}`,
      detail: `${p.coverage}: ${p.reason} Merged=${p.merged}; verified=${p.verified}.` }));
}

/** Every completed/failed resource attempt is committed before trying the next.
 * Do not catch storage failures: callers must not report unrecorded cleanup as success.
 */
export function recordArchiveCleanup(
  store: TaskStore, taskId: string, diagnostic: ArchiveDiagnostic,
  status: "started" | "removed" | "missing" | "released" | "retained" | "finished",
  now = new Date()
): void {
  try {
    store.transaction(tx => {
      if (tx.getTask(taskId)?.status !== "archived") throw new Error(`Task is not archived: ${taskId}.`);
      tx.saveEvent(taskId, createTaskEvent(tx.nextEventId(taskId), taskId, "task.archive-cleanup", {
        resource: diagnostic.resource, detail: diagnostic.detail, status,
        ...(diagnostic.paths === undefined ? {} : { paths: JSON.stringify(diagnostic.paths) })
      }, now));
    });
  } catch (error) {
    throw new ArchiveAuditPersistenceError(error);
  }
}

export function taskArchiveDiagnostics(store: TaskStore, task: Task) {
  const events = store.listEvents(task.id);
  const archive = events.filter(e => e.type === "task.archived").at(-1);
  const cleanup = events.filter(e => e.type === "task.archive-cleanup");
  const warnings: ArchiveDiagnostic[] = archive?.payload.warnings === undefined
    ? [] : JSON.parse(archive.payload.warnings);
  // These are historical attempt diagnostics; current references below remain
  // authoritative even when explicit later resource cleanup has succeeded.
  for (const event of cleanup.filter(e => e.payload.status === "retained")) {
    warnings.push({ resource: event.payload.resource!, detail: event.payload.detail!,
      ...(event.payload.paths === undefined ? {} : { paths: JSON.parse(event.payload.paths) }) });
  }
  const forced = archive?.payload.force === "true";
  const cleanupFinished = !forced || cleanup.some(e => e.payload.status === "finished");
  if (forced && !cleanupFinished) warnings.push({ resource: `task:${task.id}`,
    detail: "Archive committed; cleanup has not finished. Retained references require explicit inspection; archive retry does not replay cleanup." });
  return { archived: task.status === "archived", forced,
    disposition: archive?.payload.workspaceDisposition ?? null,
    cleanupFinished, warnings, retainedResources: archiveRetainedResources(store, task),
    cleanupEvents: cleanup };
}

export function renderArchiveDiagnostics(data: ReturnType<typeof taskArchiveDiagnostics>): string {
  return [
    `Archived: ${data.archived}; forced: ${data.forced}; cleanup finished: ${data.cleanupFinished}`,
    `Retained references: ${data.retainedResources.length}; a finished cleanup attempt is not physical resource release evidence.`,
    ...data.warnings.map(w => `Warning [${w.resource}]: ${w.detail}`),
    ...data.retainedResources.map(r => `Retained [${r.resource}]: ${r.detail}${r.paths ? ` (${r.paths.join(", ")})` : ""}`)
  ].join("\n") + "\n";
}
