import { rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { updateRole } from "../role/role.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
import {
  createRoleWorkspace,
  type RoleWorkspace
} from "../worktree/roleWorkspace.js";
import {
  NodeGitWorkspace,
  type GitWorkspacePort,
  type GitWorkspaceRemoval
} from "./gitWorkspace.js";

export type TaskWorkspacePreparation = Readonly<{
  taskId: string;
  status: "ready" | "pending" | "draft" | "archived-clean" | "archived-dirty" | "failed";
  path?: string;
  error?: string;
}>;

export interface TaskWorkspacePreparer {
  prepareTaskWorkspace(taskId: string): Promise<TaskWorkspacePreparation>;
  prepareActiveTaskWorkspaces(): Promise<readonly TaskWorkspacePreparation[]>;
  cleanupArchivedTaskWorkspaces(): Promise<readonly TaskWorkspacePreparation[]>;
  reconcileTaskWorkspaces(): Promise<readonly TaskWorkspacePreparation[]>;
}

/**
 * Prepares one deterministic worktree per Task Role. Git and the deterministic
 * path remain the physical truth; the compact RoleWorkspace records only the
 * identity needed to validate launches and safely reconcile archive cleanup.
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
      return {
        taskId,
        status: task.status === "draft" ? "draft" : "ready",
        ...(task.cwd === undefined ? {} : { path: task.cwd })
      };
    }
    const repository = this.store.getRepository(task.repositoryId);
    if (repository === null) throw new Error(`Repository not found: ${task.repositoryId}.`);
    if (task.status === "draft") return { taskId, status: "draft" };
    if (task.status === "archived") return this.#cleanupArchived(task, repository.path);

    const taskRoot = this.#taskRoot(task.id);
    if (task.cwd !== undefined && resolve(task.cwd) !== taskRoot) {
      throw new Error(`Task workspace root does not match its deterministic path: ${task.id}.`);
    }
    const baseRef = task.baseRef ?? repository.defaultBranch;
    // A Task base branch may be deleted after its first Role worktree is
    // created. The persisted starting commit remains a stable base for Roles
    // added later without introducing a separate ref ledger.
    const physicalBase = this.store.listRoleWorkspaces(task.id)[0]?.baseCommit ?? baseRef;
    const prepared = [] as Array<Readonly<{
      roleName: string;
      path: string;
      branch: string;
      baseCommit: string;
    }>>;
    for (const role of this.store.listRoles(task.id)) {
      const workspace = await this.git.ensureWorktree({
        repositoryPath: repository.path,
        container: this.worktreeRoot,
        taskId: task.id,
        roleName: role.name,
        baseRef: physicalBase
      });
      prepared.push({ roleName: role.name, ...workspace });
    }

    const ready = this.store.transaction((store) => {
      const latest = requireTask(store, task.id);
      if (latest.status !== "active") return false;
      if (latest.repositoryId !== repository.id) {
        throw new Error(`Task repository changed while preparing its workspaces: ${task.id}.`);
      }
      const now = this.now();
      for (const physical of prepared) {
        const role = store.getRole(task.id, physical.roleName);
        if (role === null) continue;
        const existing = store.getRoleWorkspace(task.id, role.name);
        const workspace = existing ?? createRoleWorkspace({
          taskId: task.id,
          roleName: role.name,
          repositoryId: repository.id,
          path: physical.path,
          branch: physical.branch,
          baseRef,
          baseCommit: physical.baseCommit
        }, now);
        assertWorkspaceIdentity(workspace, {
          taskId: task.id,
          roleName: role.name,
          repositoryId: repository.id,
          path: physical.path,
          branch: physical.branch,
          baseRef
        });
        if (role.workspace !== workspace.path) {
          store.saveRole(task.id, updateRole(role, { workspace: workspace.path }, now));
        }
        if (existing === null) store.saveRoleWorkspace(task.id, workspace);
      }

      const roles = store.listRoles(task.id);
      const allReady = roles.length > 0 && roles.every((role) => {
        const workspace = store.getRoleWorkspace(task.id, role.name);
        return workspace !== null
          && workspace.repositoryId === repository.id
          && workspace.path === role.workspace;
      });
      if (allReady && latest.cwd !== taskRoot) {
        store.saveTask({ ...latest, cwd: taskRoot, updatedAt: now.toISOString() });
      } else if (!allReady && latest.cwd !== undefined) {
        const { cwd: _cwd, ...withoutWorkspace } = latest;
        store.saveTask({ ...withoutWorkspace, updatedAt: now.toISOString() });
      }
      return allReady;
    });
    if (ready) return { taskId, status: "ready", path: taskRoot };

    // Archive may win while Git is creating worktrees. Re-read state and use
    // the same dirty-preserving archive policy before any scheduler delivery.
    const latest = requireTask(this.store, task.id);
    if (latest.status === "archived") return this.#cleanupArchived(latest, repository.path);
    return { taskId, status: latest.status === "draft" ? "draft" : "pending" };
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
      if (task.repositoryId === undefined || task.status !== "active") continue;
      try {
        results.push(await this.prepareTaskWorkspace(task.id));
      } catch (error) {
        results.push(failedPreparation(task.id, error));
      }
    }
    return results;
  }

  async cleanupArchivedTaskWorkspaces(): Promise<readonly TaskWorkspacePreparation[]> {
    const results: TaskWorkspacePreparation[] = [];
    for (const task of this.store.listTasks()) {
      if (task.repositoryId === undefined || task.status !== "archived") continue;
      try {
        results.push(await this.prepareTaskWorkspace(task.id));
      } catch (error) {
        results.push(failedPreparation(task.id, error));
      }
    }
    return results;
  }

  async #cleanupArchived(
    task: Task,
    repositoryPath: string
  ): Promise<TaskWorkspacePreparation> {
    const removals = new Map<string, GitWorkspaceRemoval>();
    const failures: string[] = [];
    for (const role of this.store.listRoles(task.id)) {
      try {
        const removal = await this.git.removeWorktree({
          repositoryPath,
          container: this.worktreeRoot,
          taskId: task.id,
          roleName: role.name
        });
        removals.set(role.name, removal);
        if (removal !== "dirty") {
          this.#recordArchivedRoleCleanup(task.id, repositoryPath, role.name);
        }
      } catch (error) {
        failures.push(`${role.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const dirty = [...removals.values()].some((removal) => removal === "dirty");
    if (failures.length > 0) {
      return {
        taskId: task.id,
        status: "failed",
        path: this.#taskRoot(task.id),
        error: `Role worktree cleanup failed (${failures.join("; ")})`
      };
    }
    this.#recordArchivedTaskCleanup(task.id, dirty);
    if (!dirty) await removeEmptyDirectory(this.#taskRoot(task.id));
    return dirty
      ? { taskId: task.id, status: "archived-dirty", path: this.#taskRoot(task.id) }
      : { taskId: task.id, status: "archived-clean" };
  }

  #recordArchivedRoleCleanup(
    taskId: string,
    repositoryPath: string,
    roleName: string
  ): void {
    this.store.transaction((store) => {
      const latest = requireTask(store, taskId);
      if (latest.status !== "archived") return;
      const now = this.now();
      const role = store.getRole(taskId, roleName);
      if (role === null) return;
      if (role.workspace === repositoryPath
        && store.getRoleWorkspace(taskId, role.name) === null) return;
      if (role.workspace !== repositoryPath) {
        store.saveRole(taskId, updateRole(role, { workspace: repositoryPath }, now));
      }
      store.removeRoleWorkspace(taskId, role.name);
    });
  }

  #recordArchivedTaskCleanup(taskId: string, dirty: boolean): void {
    this.store.transaction((store) => {
      const latest = requireTask(store, taskId);
      if (latest.status !== "archived") return;
      if (!dirty && latest.cwd !== undefined) {
        const { cwd: _cwd, ...withoutWorkspace } = latest;
        store.saveTask({ ...withoutWorkspace, updatedAt: this.now().toISOString() });
      }
    });
  }

  #taskRoot(taskId: string): string {
    return join(this.worktreeRoot, taskId);
  }
}

function failedPreparation(taskId: string, error: unknown): TaskWorkspacePreparation {
  return {
    taskId,
    status: "failed",
    error: error instanceof Error ? error.message : String(error)
  };
}

function assertWorkspaceIdentity(
  workspace: RoleWorkspace,
  expected: Readonly<{
    taskId: string;
    roleName: string;
    repositoryId: string;
    path: string;
    branch: string;
    baseRef: string;
  }>
): void {
  for (const key of [
    "taskId", "roleName", "repositoryId", "path", "branch", "baseRef"
  ] as const) {
    if (workspace[key] !== expected[key]) {
      throw new Error(`RoleWorkspace ${key} does not match its deterministic identity: ${expected.taskId}/${expected.roleName}.`);
    }
  }
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTEMPTY")) throw error;
  }
}

function isErrno(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value
    && (value as { code?: unknown }).code === code;
}

function requireTask(store: TaskStore, taskId: string): Task {
  const task = store.getTask(taskId);
  if (task === null) throw new Error(`Task not found: ${taskId}.`);
  return task;
}
