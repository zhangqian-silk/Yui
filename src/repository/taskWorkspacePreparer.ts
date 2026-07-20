import { join, resolve } from "node:path";

import { updateRole } from "../role/role.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
import {
  NodeGitWorkspace,
  type GitWorkspacePort,
  type GitWorkspaceRemoval
} from "./gitWorkspace.js";

export type TaskWorkspacePreparation = Readonly<{
  taskId: string;
  status: "ready" | "draft" | "archived-clean" | "archived-dirty";
  path?: string;
}>;

export interface TaskWorkspacePreparer {
  prepareTaskWorkspace(taskId: string): Promise<TaskWorkspacePreparation>;
  prepareActiveTaskWorkspaces(): Promise<readonly TaskWorkspacePreparation[]>;
  cleanupArchivedTaskWorkspaces(): Promise<readonly TaskWorkspacePreparation[]>;
  reconcileTaskWorkspaces(): Promise<readonly TaskWorkspacePreparation[]>;
}

/**
 * Prepares one deterministic worktree per repository-backed Task. There is no
 * worktree ledger: Git and the deterministic path are the physical truth,
 * while Task.cwd is recorded only after ownership checks succeed.
 */
export class FileTaskWorkspacePreparer implements TaskWorkspacePreparer {
  readonly worktreeRoot: string;

  constructor(
    home: string,
    readonly store: TaskStore,
    readonly git: GitWorkspacePort = new NodeGitWorkspace(),
    readonly now: () => Date = () => new Date()
  ) {
    this.worktreeRoot = join(resolve(home), "worktrees");
  }

  async prepareTaskWorkspace(taskId: string): Promise<TaskWorkspacePreparation> {
    const task = requireTask(this.store, taskId);
    if (task.repositoryId === undefined) {
      return { taskId, status: task.status === "draft" ? "draft" : "ready", ...(task.cwd === undefined ? {} : { path: task.cwd }) };
    }
    const repository = this.store.getRepository(task.repositoryId);
    if (repository === null) throw new Error(`Repository not found: ${task.repositoryId}.`);
    if (task.status === "draft") return { taskId, status: "draft" };
    if (task.status === "archived") return this.#cleanupArchived(task, repository.path);

    const prepared = await this.git.ensureWorktree({
      repositoryPath: repository.path,
      container: this.worktreeRoot,
      taskId: task.id,
      baseRef: task.baseRef ?? repository.defaultBranch
    });
    if (task.cwd !== undefined && resolve(task.cwd) !== prepared.path) {
      throw new Error(`Task workspace does not match its deterministic path: ${task.id}.`);
    }

    const persisted = this.store.transaction((store) => {
      const latest = requireTask(store, task.id);
      if (latest.status === "archived") return false;
      if (latest.status !== "active") return false;
      if (latest.repositoryId !== repository.id) {
        throw new Error(`Task repository changed while preparing its workspace: ${task.id}.`);
      }
      if (latest.cwd === prepared.path
        && store.listRoles(task.id).every((role) => role.workspace === prepared.path)) {
        return true;
      }
      const now = this.now();
      store.saveTask({ ...latest, cwd: prepared.path, updatedAt: now.toISOString() });
      for (const role of store.listRoles(task.id)) {
        if (role.workspace !== prepared.path) {
          store.saveRole(task.id, updateRole(role, { workspace: prepared.path }, now));
        }
      }
      return true;
    });
    if (persisted) return { taskId, status: "ready", path: prepared.path };

    // Archive may win while Git is creating the worktree. Re-read the state
    // and apply the same non-destructive cleanup policy before scheduling.
    const latest = requireTask(this.store, task.id);
    if (latest.status === "archived") return this.#cleanupArchived(latest, repository.path);
    return { taskId, status: "draft" };
  }

  async reconcileTaskWorkspaces(): Promise<readonly TaskWorkspacePreparation[]> {
    return [
      ...await this.prepareActiveTaskWorkspaces(),
      ...await this.cleanupArchivedTaskWorkspaces()
    ];
  }

  async prepareActiveTaskWorkspaces(): Promise<readonly TaskWorkspacePreparation[]> {
    const results: TaskWorkspacePreparation[] = [];
    for (const task of this.store.listTasks()) {
      if (task.repositoryId === undefined || task.status !== "active" || task.cwd !== undefined) continue;
      results.push(await this.prepareTaskWorkspace(task.id));
    }
    return results;
  }

  async cleanupArchivedTaskWorkspaces(): Promise<readonly TaskWorkspacePreparation[]> {
    const results: TaskWorkspacePreparation[] = [];
    for (const task of this.store.listTasks()) {
      if (task.repositoryId === undefined || task.status !== "archived") continue;
      results.push(await this.prepareTaskWorkspace(task.id));
    }
    return results;
  }

  async #cleanupArchived(task: Task, repositoryPath: string): Promise<TaskWorkspacePreparation> {
    const removal = await this.git.removeWorktree({
      repositoryPath,
      container: this.worktreeRoot,
      taskId: task.id
    });
    if (removal === "dirty") {
      return { taskId: task.id, status: "archived-dirty", ...(task.cwd === undefined ? {} : { path: task.cwd }) };
    }
    this.#recordArchivedCleanup(task.id, repositoryPath, removal);
    return { taskId: task.id, status: "archived-clean" };
  }

  #recordArchivedCleanup(
    taskId: string,
    repositoryPath: string,
    _removal: Exclude<GitWorkspaceRemoval, "dirty">
  ): void {
    this.store.transaction((store) => {
      const latest = requireTask(store, taskId);
      if (latest.status !== "archived") return;
      const roles = store.listRoles(taskId);
      if (latest.cwd === undefined && roles.every((role) => role.workspace === repositoryPath)) return;
      const now = this.now();
      const { cwd: _cwd, ...withoutWorkspace } = latest;
      store.saveTask({ ...withoutWorkspace, updatedAt: now.toISOString() });
      for (const role of roles) {
        if (role.workspace !== repositoryPath) {
          store.saveRole(taskId, updateRole(role, { workspace: repositoryPath }, now));
        }
      }
    });
  }
}

function requireTask(store: TaskStore, taskId: string): Task {
  const task = store.getTask(taskId);
  if (task === null) throw new Error(`Task not found: ${taskId}.`);
  return task;
}
