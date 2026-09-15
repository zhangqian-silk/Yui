import { resolve } from "node:path";
import type { TaskStore } from "../storage/taskStore.js";
import type { DurableJob } from "./durableJob.js";

export class JobAssignmentScopeError extends Error {}

/** Authentication identifies the current Session; it does not grant another
 * Assignment's workspace. Share this check across admission, management and
 * the last pre-spawn boundary. Existing running Jobs settle independently. */
export function assertJobAssignmentScope(
  store: Pick<TaskStore, "getActiveRun" | "getWorkItem">,
  target: Pick<DurableJob, "taskId" | "owner" | "projectId" | "workspace">,
  caller: Readonly<{ scope: string; role?: string }>
): void {
  if (caller.scope !== "task" || caller.role === "leader") return;
  const run = caller.role === undefined ? null : store.getActiveRun(target.taskId, caller.role);
  const workspace = run?.workspace ?? run?.effective.workspace;
  const item = run?.workItemId === undefined ? null : store.getWorkItem(target.taskId, run.workItemId);
  if (run?.status !== "active" || run.reviewRoundId !== undefined
    || target.owner.kind !== "work-item" || target.owner.workItemId !== run.workItemId
    || item?.status !== "open" || item.assignee !== caller.role
    || !item.writeProjectIds.includes(target.projectId)
    || !run.effective.writeProjectIds.includes(target.projectId)
    || workspace === undefined || resolve(workspace.root) !== resolve(target.workspace)
    || !workspace.entries.some(entry => entry.projectId === target.projectId && entry.access === "write")) {
    throw new JobAssignmentScopeError("Job is outside the caller's current Assignment. Use the exact assigned WorkItem workspace and writable Project; this Job owner cannot represent a Review or replica Lane.");
  }
}
