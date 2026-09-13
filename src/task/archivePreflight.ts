import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "./task.js";
import { readArchiveDelivery } from "../repository/workspaceCleanupInspection.js";
import type { TaskWorkspaceCoordinator } from "../repository/taskWorkspaceCoordinator.js";
import { WorkspaceCleanupBlockedError } from "../repository/taskWorkspacePreparer.js";
import { managedWorkspaceKey } from "../worktree/managedWorkspace.js";
import { hasRuntimeLifecycleWork, runtimeLifecycleTarget } from "../runtime/lifecycleReservation.js";
import { cleanupCheckFromError, renderCleanupCheck, type CleanupCheck } from "../workspace/cleanupInspection.js";

export type ArchiveInspectionRequest = Readonly<{
  taskId: string; disposition: "integrated" | "abandoned"; force: boolean;
}>;

/** Semantic admission facts. Cleanup still has its own resource boundary. */
export function archiveSettlementChecks(store: TaskStore, task: Task): CleanupCheck[] {
  const checks: CleanupCheck[] = [];
  const add = (resource: string, reason: string, detail: string, expected: unknown, observed: unknown, action: string) =>
    checks.push({ resource, reason, status: "blocked", detail, expected, observed, sources: [resource], actions: [action] });
  for (const input of store.listInputRequests(task.id).filter(i => i.status === "open")) {
    add(`input:${task.id}/${input.id}`, "unresolved-input", "Open user input is not answered by archive.",
      "resolved input", input.status, `yui task input show ${task.id}/${input.id}`);
  }
  for (const item of store.listWorkItems(task.id).filter(i => i.status === "open")) {
    add(`work-item:${task.id}/${item.id}`, "owner-unsettled", "WorkItem must be accepted or explicitly retired before archive.",
      ["accepted", "retired"], item.status, `yui task work show ${task.id}/${item.id}`);
  }
  for (const attempt of store.listIntegrationAttempts(task.id).filter(a =>
    ["running", "blocked", "conflicted", "validating"].includes(a.status))) {
    add(`integration-attempt:${task.id}/${attempt.id}`, "unresolved-integration", "Task has an unresolved Integration Attempt.",
      "terminal attempt", attempt.status, `yui task integration show ${task.id}/${attempt.id}`);
  }
  for (const job of store.listDurableJobs(task.id).filter(j =>
    ["queued", "running"].includes(j.status) || (j.status === "unknown-needs-attention" && j.acknowledgedAt === undefined))) {
    add(`job:${task.id}/${job.id}`, "active-durable-job", "Task has an active or unacknowledged DurableJob.",
      "settled job", job.status, `yui job get --task ${task.id} --job ${job.id}`);
  }
  return checks;
}

/** Unknown execution is never permission to remove workspaces, even after
 * force admission. These facts are reloaded in the actual force cleanup path.
 */
export function archiveExecutionChecks(store: TaskStore, taskId: string): CleanupCheck[] {
  const checks: CleanupCheck[] = [];
  const add = (resource: string, reason: string, detail: string, observed: unknown, action: string) =>
    checks.push({ resource, reason, status: "unknown", detail, expected: "settled execution",
      observed, sources: [resource], actions: [action] });
  for (const run of store.listRuns(taskId).filter(r => r.status === "active")) {
    add(`run:${taskId}/${run.id}`, "active-turn", "AgentRun remains active; archive is not stop evidence.",
      run.status, `yui task run show ${taskId}/${run.id}`);
  }
  for (const job of store.listDurableJobs(taskId).filter(j =>
    ["queued", "running", "unknown-needs-attention"].includes(j.status))) {
    add(`job:${taskId}/${job.id}`, "unresolved-execution", "DurableJob may still hold resources; acknowledgement is not physical exit evidence.",
      job.status, `yui job get --task ${taskId} --job ${job.id}`);
  }
  for (const role of store.listRoles(taskId)) {
    const resource = `role:${taskId}/${role.name}`;
    const action = `yui task role session inspect ${taskId} ${role.name}`;
    const provider = store.getTaskRoleSessionSet(taskId, role.name)?.providerBinding;
    const mailbox = store.getWorkMailbox({ kind: "role", taskId, roleName: role.name });
    if (provider?.run != null && !["completed", "failed", "cancelled"].includes(provider.run.status)) {
      add(resource, "unresolved-provider-input", "Original provider input outcome is unresolved; do not replay it.",
        { attemptId: provider.run.attemptId, status: provider.run.status }, action);
    }
    if (mailbox?.processing != null && (provider?.run == null
      || !["completed", "failed", "cancelled"].includes(provider.run.status))) {
      add(resource, "unresolved-mailbox", "Original mailbox claim has no proven terminal; archive does not acknowledge it.",
        { batchId: mailbox.processing.batchId }, action);
    }
    if (hasRuntimeLifecycleWork(store.getWorkMailbox(runtimeLifecycleTarget({ scope: "task", taskId, roleName: role.name })))) {
      add(resource, "unresolved-runtime-lifecycle", "Role has unsettled runtime lifecycle work.", "pending", action);
    }
  }
  return checks;
}

export async function inspectTaskArchive(coordinator: TaskWorkspaceCoordinator, request: ArchiveInspectionRequest) {
  const { store, preparer, runtime } = coordinator;
  const task = store.getTask(request.taskId);
  if (task === null) throw new Error(`Task not found: ${request.taskId}.`);
  const settlement = archiveSettlementChecks(store, task);
  const delivery = await readArchiveDelivery(store, preparer.git, task, request.force);
  const deliveryChecks: CleanupCheck[] = delivery.projects.filter(p => p.codeDelivery !== "none" && (!p.merged || !p.verified))
    .map(p => ({ resource: `delivery:${task.id}/${p.projectId}`, reason: "delivery-coverage", status: "blocked",
      detail: p.reason, expected: { merged: true, verified: true, localCommit: p.expectedLocalCommit },
      observed: { coverage: p.coverage, merged: p.merged, verified: p.verified, localCommit: p.publication?.localCommit ?? null },
      sources: [`task:${task.id}`, ...(p.publication === null ? [] : [`publication:${task.id}/${p.publication.id}`])],
      actions: [`yui task remote-delivery ${task.id}`] }));
  const execution = archiveExecutionChecks(store, task.id);
  const runtimeResource = `runtime:${task.id}`;
  if (runtime.assertTaskPhysicalResourcesReleased === undefined) {
    execution.push(...cleanupCheckFromError(null, runtimeResource, [`task:${task.id}`],
      [`yui task role status ${task.id}`]));
  } else {
    try { await runtime.assertTaskPhysicalResourcesReleased(task.id); }
    catch (error) {
      execution.push({ resource: runtimeResource, reason: "physical-resources-unreleased", status: "unknown",
        detail: error instanceof WorkspaceCleanupBlockedError ? error.message
          : "Exact physical resource release is not established by the runtime inspection.",
        expected: "proven physical absence",
        observed: error instanceof WorkspaceCleanupBlockedError ? { reason: error.reason, resource: error.resource } : "unavailable",
        sources: [`task:${task.id}`],
        actions: [`yui task role status ${task.id}`, `yui session reconcile --report`] });
    }
  }
  const resources = [];
  for (const workspace of store.listManagedWorkspaces(task.id)) {
    const disposition = workspace.owner.type === "work-item"
      && store.getWorkItem(task.id, workspace.owner.workItemId)?.status === "retired" ? "abandoned" : request.disposition;
    let checks: CleanupCheck[];
    try { checks = await preparer.inspectWorkspaceCleanup(workspace, disposition, request.force); }
    catch (error) { checks = cleanupCheckFromError(error, managedWorkspaceKey(workspace.owner),
      [managedWorkspaceKey(workspace.owner)], [`yui task show ${task.id}`]); }
    resources.push({ resource: managedWorkspaceKey(workspace.owner), owner: workspace.owner,
      status: checks.some(c => c.status === "unknown") ? "unknown" : checks.length > 0 ? "blocked" : "checked",
      checks });
  }
  const eligible = ["completed", "cancelled", "archived"].includes(task.status);
  return { taskId: task.id, observedAt: new Date().toISOString(), disposition: request.disposition, force: request.force,
    readOnly: true, authorizesCleanup: false,
    archive: { status: task.status, eligible, alreadyArchived: task.status === "archived",
      settlement, delivery: deliveryChecks, forceBypassesSettlement: request.force,
      requiresIndependentAuthorization: true },
    cleanup: { execution, resources },
    note: "Current observations only. Execution reloads the checks. Force commits archive first and retains unsafe resources; a finished attempt does not prove resource release." };
}

export function renderTaskArchivePreflight(data: Awaited<ReturnType<typeof inspectTaskArchive>>): string {
  return [
    `Archive preflight: ${data.taskId} (${data.disposition}${data.force ? ", force" : ""}); read-only, not authorization`,
    `Task: ${data.archive.status}; terminal eligibility: ${data.archive.eligible}`,
    ...data.archive.settlement.map(c => `Admission${data.force ? " (force preserves)" : ""}: ${renderCleanupCheck(c)}`),
    ...data.archive.delivery.map(c => `Delivery${data.force || data.disposition === "abandoned" ? " (advisory for admission)" : ""}: ${renderCleanupCheck(c)}`),
    ...data.cleanup.execution.map(c => `Cleanup: ${renderCleanupCheck(c)}`),
    ...data.cleanup.resources.flatMap(r => [
      `Workspace [${r.resource}]: ${r.status}`,
      ...r.checks.map(c => `  ${renderCleanupCheck(c)}`)
    ]),
    data.note
  ].join("\n") + "\n";
}
