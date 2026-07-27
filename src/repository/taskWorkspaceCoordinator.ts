import type { TaskStore } from "../storage/taskStore.js";
import type {
  WorkItem,
  WorkItemWorkspaceDisposition
} from "../workItem/workItem.js";
import type { GitWorkspaceRemoval } from "./gitWorkspace.js";
import {
  FileTaskWorkspacePreparer,
  type TaskWorkspaceCleanup
} from "./taskWorkspacePreparer.js";

export type TaskRoleRuntimeStopper = Readonly<{
  stopTaskRoleSessions(taskId: string, roleNames: readonly string[]): Promise<void>;
}>;

/**
 * Coordinates persisted Role cwd changes with the runtime that may still be
 * executing in the previous directory.
 */
export class TaskWorkspaceCoordinator {
  constructor(
    readonly store: TaskStore,
    readonly preparer: FileTaskWorkspacePreparer,
    readonly runtime: TaskRoleRuntimeStopper
  ) {}

  async isolateWorkItem(workItemId: string) {
    const item = this.store.findWorkItem(workItemId);
    if (item === null) throw new Error(`Work item not found: ${workItemId}.`);
    const assignee = this.#workItemIsolationAssignee(item);
    const existing = this.store.getRoleWorkspace(item.taskId, assignee);
    if (existing !== null
      && existing.owner.type === "work-item"
      && existing.owner.workItemId === item.id) return existing;
    if (existing !== null) {
      throw new Error(
        `Role already has an isolated WorkItem worktree: ${item.taskId}/${assignee}.`
      );
    }
    await this.preparer.prepareTaskWorkspace(item.taskId);
    const prepared = this.store.getRoleWorkspace(item.taskId, assignee);
    if (prepared !== null
      && prepared.owner.type === "work-item"
      && prepared.owner.workItemId === item.id) return prepared;
    if (prepared !== null) {
      throw new Error(
        `Role already has an isolated WorkItem worktree: ${item.taskId}/${assignee}.`
      );
    }
    await this.#stopLiveRoles(item.taskId, [assignee]);
    return this.preparer.prepareWorkItemWorkspace(workItemId);
  }

  async cleanupWorkItem(
    workItemId: string,
    disposition: WorkItemWorkspaceDisposition
  ): Promise<GitWorkspaceRemoval> {
    const item = this.store.findWorkItem(workItemId);
    if (item === null) throw new Error(`Work item not found: ${workItemId}.`);
    if (!isTerminalWorkItem(item)) {
      throw new Error(`Work item must be terminal before cleanup: ${item.id}.`);
    }
    if (item.assignee === undefined) {
      throw new Error(`Work item has no Task Role workspace: ${item.id}.`);
    }
    if (item.workspaceDisposition !== undefined
      && item.workspaceDisposition !== disposition) {
      throw new Error(
        `Work item workspace is already recorded as ${item.workspaceDisposition}.`
      );
    }
    const state = await this.preparer.inspectWorkItemWorkspace(item.id);
    if (state === "dirty") return "dirty";
    if (state === "clean") await this.#stopLiveRoles(item.taskId, [item.assignee]);
    return this.preparer.cleanupWorkItemWorkspace(item.id, disposition);
  }

  async cleanupTaskForArchive(taskId: string): Promise<TaskWorkspaceCleanup> {
    try {
      const state = await this.preparer.inspectTaskMainWorkspace(taskId);
      if (state === "dirty") {
        const task = this.store.getTask(taskId);
        return {
          taskId,
          status: "retained-dirty",
          ...(task?.cwd === undefined ? {} : { path: task.cwd })
        };
      }
      await this.#stopLiveRoles(
        taskId,
        this.store.listRoles(taskId).map(({ name }) => name)
      );
      return this.preparer.cleanupTaskForArchive(taskId);
    } catch (error) {
      const task = this.store.getTask(taskId);
      return {
        taskId,
        status: "failed",
        ...(task?.cwd === undefined ? {} : { path: task.cwd }),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async #stopLiveRoles(taskId: string, roleNames: readonly string[]): Promise<void> {
    const live = roleNames.filter((roleName) => {
      const session = this.store.getRoleSession(taskId, roleName);
      return session !== null && session.status !== "stopped";
    });
    if (live.length > 0) await this.runtime.stopTaskRoleSessions(taskId, live);
  }

  #workItemIsolationAssignee(item: WorkItem): string {
    const task = this.store.getTask(item.taskId);
    if (task === null) throw new Error(`Task not found: ${item.taskId}.`);
    if (task.status !== "active") throw new Error(`Task is not active: ${task.id}.`);
    if (task.projectId === undefined) {
      throw new Error(`WorkItem isolation requires a Project-backed Task: ${task.id}.`);
    }
    if (item.assignee === undefined) {
      throw new Error(`WorkItem isolation requires a Task Role assignee: ${item.id}.`);
    }
    if (item.assignee === "leader") {
      throw new Error("The Leader must remain in the Task main worktree.");
    }
    if (isTerminalWorkItem(item)) {
      throw new Error(`Work item is already terminal: ${item.id}.`);
    }
    if (this.store.getActiveAgentRun(task.id, item.assignee) !== null) {
      throw new Error(`Role has an active Run: ${task.id}/${item.assignee}.`);
    }
    if (this.store.getRole(task.id, item.assignee) === null) {
      throw new Error(`Role not found: ${task.id}/${item.assignee}.`);
    }
    return item.assignee;
  }
}

function isTerminalWorkItem(item: WorkItem): boolean {
  return ["completed", "failed", "cancelled", "superseded"].includes(item.status);
}
