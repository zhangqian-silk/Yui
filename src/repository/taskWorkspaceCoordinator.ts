import { isDeepStrictEqual } from "node:util";

import type { ReviewRound } from "../review/reviewRound.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
import type {
  WorkItem,
  WorkItemWorkspaceDisposition
} from "../workItem/workItem.js";
import type { RoleWorkspace } from "../worktree/roleWorkspace.js";
import type { GitWorkspaceRemoval } from "./gitWorkspace.js";
import {
  FileTaskWorkspacePreparer,
  WorkspaceCleanupBlockedError,
  type TaskWorkspaceCleanup
} from "./taskWorkspacePreparer.js";

export { WorkspaceCleanupBlockedError } from "./taskWorkspacePreparer.js";

export type TaskRoleRuntimeStopper = Readonly<{
  stopTaskRoleSessions(taskId: string, roleNames: readonly string[]): Promise<void>;
}>;

type TaskArchiveSnapshot = Readonly<{
  task: Task;
  roleWorkspaces: readonly RoleWorkspace[];
  workItems: readonly WorkItem[];
  reviewRounds: readonly ReviewRound[];
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

  async isolateWorkItem(taskId: string, workItemId: string) {
    const item = this.store.getWorkItem(taskId, workItemId);
    if (item === null) throw new Error(`Work item not found: ${taskId}/${workItemId}.`);
    const assignee = this.#workItemIsolationAssignee(item);
    const task = this.store.getTask(item.taskId)!;
    const taskProjectIds = task.projectBindings.map(({ projectId }) => projectId);
    const existing = this.store.getRoleWorkspace(item.taskId, assignee);
    if (existing !== null
      && existing.owner.type === "work-item"
      && existing.owner.workItemId === item.id
      && sameProjectScope(existing, taskProjectIds, item.writeProjectIds)) return existing;
    if (existing !== null) {
      if (existing.owner.type !== "work-item" || existing.owner.workItemId !== item.id) {
        throw new Error(`Role already has another WorkItem workspace: ${item.taskId}/${assignee}.`);
      }
    }
    await this.preparer.prepareTaskWorkspace(item.taskId);
    const prepared = this.store.getRoleWorkspace(item.taskId, assignee);
    if (prepared !== null
      && prepared.owner.type === "work-item"
      && prepared.owner.workItemId === item.id
      && sameProjectScope(prepared, taskProjectIds, item.writeProjectIds)) return prepared;
    if (prepared !== null) {
      if (prepared.owner.type !== "work-item" || prepared.owner.workItemId !== item.id) {
        throw new Error(`Role already has another WorkItem workspace: ${item.taskId}/${assignee}.`);
      }
    }
    await this.#stopLiveRoles(item.taskId, [assignee]);
    return this.preparer.prepareWorkItemWorkspace(item.taskId, item.id);
  }

  async cleanupWorkItem(
    taskId: string,
    workItemId: string,
    disposition: WorkItemWorkspaceDisposition
  ): Promise<GitWorkspaceRemoval> {
    const item = this.store.getWorkItem(taskId, workItemId);
    if (item === null) throw new Error(`Work item not found: ${taskId}/${workItemId}.`);
    if (!isTerminalWorkItem(item)) {
      throw new Error(`Work item must be terminal before cleanup: ${item.id}.`);
    }
    if (item.assignee === undefined) {
      throw new WorkspaceCleanupBlockedError(
        "work-item-no-role",
        `work-item:${item.taskId}/${item.id}`,
        false,
        `Work item has no Task Role workspace: ${item.id}.`
      );
    }
    if (item.workspaceDisposition !== undefined
      && item.workspaceDisposition !== disposition) {
      throw new Error(
        `Work item workspace is already recorded as ${item.workspaceDisposition}.`
      );
    }
    if (item.workspaceDisposition === disposition) return "missing";
    const state = await this.preparer.inspectWorkItemWorkspace(item.taskId, item.id);
    if (state === "dirty") return "dirty";
    this.#assertWorkItemRuntimeOwner(item);
    await this.runtime.stopTaskRoleSessions(item.taskId, [item.assignee]);
    return this.preparer.cleanupWorkItemWorkspace(item.taskId, item.id, disposition);
  }

  async cleanupWorkItemRuntime(
    taskId: string,
    workItemId: string
  ): Promise<"released"> {
    const item = this.store.getWorkItem(taskId, workItemId);
    if (item === null) throw new Error(`Work item not found: ${taskId}/${workItemId}.`);
    this.#assertWorkItemRuntimeOwner(item);
    await this.runtime.stopTaskRoleSessions(item.taskId, [item.assignee!]);
    return "released";
  }

  async cleanupReviewRound(
    taskId: string,
    reviewRoundId: string
  ): Promise<GitWorkspaceRemoval> {
    const round = this.store.getReviewRound(taskId, reviewRoundId);
    if (round === null) throw new Error(`ReviewRound not found: ${taskId}/${reviewRoundId}.`);
    if (round.status !== "completed" && round.status !== "failed") {
      throw new Error(`ReviewRound must be terminal before cleanup: ${round.id}.`);
    }
    const state = await this.preparer.inspectReviewRoundWorkspace(taskId, reviewRoundId);
    if (state === "dirty") return "dirty";
    await this.#stopLiveRoles(taskId, [round.reviewerRoleName]);
    return this.preparer.cleanupReviewRoundWorkspace(taskId, reviewRoundId);
  }

  async cleanupTaskForArchive(
    taskId: string,
    disposition: WorkItemWorkspaceDisposition
  ): Promise<TaskWorkspaceCleanup> {
    try {
      const task = this.store.getTask(taskId);
      if (task === null) throw new Error(`Task not found: ${taskId}.`);
      if (task.status !== "completed" && task.status !== "retired") {
        throw new Error(`Task must be completed or retired before archive cleanup: ${task.id}.`);
      }
      const roleWorkspaces = [...this.store.listRoleWorkspaces(task.id)]
        .sort((left, right) => left.roleName.localeCompare(right.roleName));
      const workspaces = roleWorkspaces
        .filter(({ owner }) => owner.type === "work-item");
      const workItems = workspaces.map((workspace) => {
        const workItemId = workspace.owner.type === "work-item"
          ? workspace.owner.workItemId
          : "";
        const item = this.store.getWorkItem(task.id, workItemId);
        if (item === null) throw new Error(`Work item not found: ${task.id}/${workItemId}.`);
        if (item.status !== "completed" && item.status !== "retired") {
          throw new Error(`Work item must be completed or retired before archive cleanup: ${item.id}.`);
        }
        return item;
      });
      const allWorkItems = [...this.store.listWorkItems(task.id)]
        .sort((left, right) => left.id.localeCompare(right.id));
      const allReviewRounds = [...this.store.listReviewRounds(task.id)]
        .sort((left, right) => left.id.localeCompare(right.id));
      const reviewRounds = allReviewRounds.filter((round) => (
        round.workspace !== undefined && round.workspaceDisposition?.kind !== "removed"
      ));
      const snapshot: TaskArchiveSnapshot = {
        task,
        roleWorkspaces,
        workItems: allWorkItems,
        reviewRounds: allReviewRounds
      };
      for (const round of reviewRounds) {
        if (round.status !== "completed" && round.status !== "failed") {
          throw new Error(`ReviewRound must be terminal before archive cleanup: ${round.id}.`);
        }
        if (await this.preparer.inspectReviewRoundWorkspace(task.id, round.id) === "dirty") {
          return {
            taskId,
            status: "retained-dirty",
            ...(task.cwd === undefined ? {} : { path: task.cwd }),
            error: `ReviewRound worktree is dirty: ${round.id}.`,
            reason: "dirty-worktree",
            resource: `review-round:${task.id}/${round.id}`,
            retryable: true
          };
        }
      }
      for (const item of workItems) {
        if (await this.preparer.inspectWorkItemWorkspace(task.id, item.id) === "dirty") {
          return {
            taskId,
            status: "retained-dirty",
            ...(task.cwd === undefined ? {} : { path: task.cwd }),
            error: `WorkItem worktree is dirty: ${item.id}.`,
            reason: "dirty-worktree",
            resource: `work-item:${task.id}/${item.id}`,
            retryable: true
          };
        }
      }
      const state = await this.preparer.inspectTaskMainWorkspace(taskId);
      if (state === "dirty") {
        return {
          taskId,
          status: "retained-dirty",
          ...(task.cwd === undefined ? {} : { path: task.cwd }),
          error: `Task main worktree is dirty: ${task.id}.`,
          reason: "dirty-worktree",
          resource: `task-worktree:${task.id}`,
          retryable: true
        };
      }
      const activeRole = this.store.listRoles(taskId)
        .find((role) => this.store.getActiveAgentRun(taskId, role.name) !== null);
      if (activeRole !== undefined) {
        throw new WorkspaceCleanupBlockedError(
          "active-run",
          `role:${task.id}/${activeRole.name}`,
          true,
          `Task Role still has an active Run: ${task.id}/${activeRole.name}.`
        );
      }
      const roleNames = this.store.listRoles(taskId).map(({ name }) => name);
      if (roleNames.length > 0) {
        await this.runtime.stopTaskRoleSessions(taskId, roleNames);
      }
      this.#assertTaskArchiveSnapshot(snapshot);
      for (const round of reviewRounds) {
        this.#assertTaskArchiveLifecycle(task);
        await this.preparer.cleanupReviewRoundWorkspace(task.id, round.id);
      }
      for (const item of workItems) {
        this.#assertTaskArchiveLifecycle(task);
        await this.preparer.cleanupWorkItemWorkspace(
          task.id,
          item.id,
          item.status === "completed" ? disposition : "abandoned"
        );
      }
      this.#assertTaskArchiveLifecycle(task);
      return this.preparer.cleanupTaskForArchive(taskId);
    } catch (error) {
      const task = this.store.getTask(taskId);
      return {
        taskId,
        status: "failed",
        ...(task?.cwd === undefined ? {} : { path: task.cwd }),
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof WorkspaceCleanupBlockedError
          ? {
              reason: error.reason,
              resource: error.resource,
              retryable: error.retryable
            }
          : {
              reason: "cleanup-failed",
              resource: `task:${taskId}`,
              retryable: true
            })
      };
    }
  }

  #assertTaskArchiveSnapshot(snapshot: TaskArchiveSnapshot): void {
    this.#assertTaskArchiveLifecycle(snapshot.task);
    const roleWorkspaces = [...this.store.listRoleWorkspaces(snapshot.task.id)]
      .sort((left, right) => left.roleName.localeCompare(right.roleName));
    const workItems = [...this.store.listWorkItems(snapshot.task.id)]
      .sort((left, right) => left.id.localeCompare(right.id));
    const reviewRounds = [...this.store.listReviewRounds(snapshot.task.id)]
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!isDeepStrictEqual(roleWorkspaces, snapshot.roleWorkspaces)
      || !isDeepStrictEqual(workItems, snapshot.workItems)
      || !isDeepStrictEqual(reviewRounds, snapshot.reviewRounds)) {
      throw new WorkspaceCleanupBlockedError(
        "task-changed",
        `task:${snapshot.task.id}`,
        true,
        `Task resources changed while archive cleanup stopped runtimes: ${snapshot.task.id}.`
      );
    }
  }

  #assertTaskArchiveLifecycle(expected: Task): void {
    const current = this.store.getTask(expected.id);
    if (current === null || !isDeepStrictEqual(current, expected)) {
      throw new WorkspaceCleanupBlockedError(
        "task-changed",
        `task:${expected.id}`,
        true,
        `Task changed during archive cleanup: ${expected.id}.`
      );
    }
  }

  #assertWorkItemRuntimeOwner(item: WorkItem): void {
    if (item.assignee === undefined) {
      throw new WorkspaceCleanupBlockedError(
        "work-item-no-role",
        `work-item:${item.taskId}/${item.id}`,
        false,
        `Work item has no Task Role runtime: ${item.id}.`
      );
    }
    const activeRun = this.store.getActiveAgentRun(item.taskId, item.assignee);
    if (activeRun !== null) {
      if (activeRun.workItemId !== item.id) {
        throw new WorkspaceCleanupBlockedError(
          "role-reassigned",
          `role:${item.taskId}/${item.assignee}`,
          true,
          `Task Role already serves Work Item ${activeRun.workItemId ?? "none"}: `
          + `${item.taskId}/${item.assignee}.`
        );
      }
      throw new WorkspaceCleanupBlockedError(
        "active-run",
        `work-item:${item.taskId}/${item.id}`,
        true,
        `Work item still has an active Run: ${item.taskId}/${item.id}.`
      );
    }
    const workspace = this.store.getRoleWorkspace(item.taskId, item.assignee);
    if (workspace?.owner.type !== "work-item"
      || workspace.owner.workItemId !== item.id) {
      const owner = workspace?.owner.type === "work-item"
        ? workspace.owner.workItemId
        : workspace?.owner.type ?? "none";
      throw new WorkspaceCleanupBlockedError(
        "role-reassigned",
        `role:${item.taskId}/${item.assignee}`,
        true,
        `Task Role no longer serves Work Item ${item.id} (current owner: ${owner}): `
        + `${item.taskId}/${item.assignee}.`
      );
    }
  }

  async #stopLiveRoles(taskId: string, roleNames: readonly string[]): Promise<void> {
    const live = roleNames.filter((roleName) => {
      const sessions = this.store.getTaskRoleSessionSet(taskId, roleName);
      return sessions !== null && (
        sessions.inFlight !== null
        || sessions.pendingTurnCompletion !== null
        || Object.values(sessions.sessions).some(
          ({ status }) => status !== "stopped" && status !== "broken"
        )
      );
    });
    if (live.length > 0) await this.runtime.stopTaskRoleSessions(taskId, live);
  }

  #workItemIsolationAssignee(item: WorkItem): string {
    const task = this.store.getTask(item.taskId);
    if (task === null) throw new Error(`Task not found: ${item.taskId}.`);
    if (task.status !== "active") throw new Error(`Task is not active: ${task.id}.`);
    if (task.projectBindings.length === 0) {
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

function sameProjectScope(
  workspace: Readonly<{ entries: readonly Readonly<{ projectId: string; access: string }>[] }>,
  taskProjectIds: readonly string[],
  writeProjectIds: readonly string[]
): boolean {
  const actualProjects = workspace.entries.map(({ projectId }) => projectId).sort();
  const expectedProjects = [...taskProjectIds].sort();
  const actual = workspace.entries
    .filter(({ access }) => access === "write")
    .map(({ projectId }) => projectId)
    .sort();
  const expected = [...writeProjectIds].sort();
  return actualProjects.length === expectedProjects.length
    && actualProjects.every((projectId, index) => projectId === expectedProjects[index])
    && actual.length === expected.length
    && actual.every((projectId, index) => projectId === expected[index]);
}

function isTerminalWorkItem(item: WorkItem): boolean {
  return ["completed", "failed", "retired"].includes(item.status);
}
