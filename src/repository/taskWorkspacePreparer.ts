import { rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { updateRole } from "../role/role.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
import {
  recordWorkItemWorkspaceDisposition,
  type WorkItemWorkspaceDisposition
} from "../workItem/workItem.js";
import {
  createRoleWorkspace,
  managedWorktreeName,
  type RoleWorkspace
} from "../worktree/roleWorkspace.js";
import {
  NodeGitWorkspace,
  type GitWorkspacePort,
  type GitWorkspaceRemoval,
  type GitWorkspaceState
} from "./gitWorkspace.js";

const MAIN_WORKTREE = "main";
const LEADER_ROLE = "leader";

export type TaskWorkspacePreparation = Readonly<{
  taskId: string;
  status: "ready" | "failed";
  path?: string;
  error?: string;
}>;

export type TaskWorkspaceCleanup = Readonly<{
  taskId: string;
  status: "removed" | "retained-dirty" | "failed";
  path?: string;
  error?: string;
}>;

export interface TaskWorkspacePreparer {
  prepareTaskWorkspace(taskId: string): Promise<TaskWorkspacePreparation>;
}

/**
 * Projects remain stable checkouts. A Project-backed Task owns one main
 * worktree, while an optional additional worktree is owned by a WorkItem and
 * merely assigned to the Role executing it.
 */
export class FileTaskWorkspacePreparer implements TaskWorkspacePreparer {
  constructor(
    readonly home: string,
    readonly store: TaskStore,
    readonly git: GitWorkspacePort = new NodeGitWorkspace(),
    readonly now: () => Date = () => new Date()
  ) {}

  async prepareTaskWorkspace(taskId: string): Promise<TaskWorkspacePreparation> {
    const task = requireTask(this.store, taskId);
    if (task.projectId === undefined) {
      return {
        taskId,
        status: "ready",
        ...(task.cwd === undefined ? {} : { path: task.cwd })
      };
    }
    const project = this.store.getProject(task.projectId);
    if (project === null) throw new Error(`Project not found: ${task.projectId}.`);
    if (!["draft", "active"].includes(task.status)) {
      throw new Error(`Task is not open for workspace preparation: ${task.id}.`);
    }

    const leader = this.store.getRole(task.id, LEADER_ROLE);
    if (leader === null) throw new Error(`Task leader Role not found: ${task.id}.`);
    const existing = this.store.getRoleWorkspace(task.id, LEADER_ROLE);
    if (existing !== null && existing.owner.type !== "task") {
      throw new Error(`Task main worktree ownership is invalid: ${task.id}.`);
    }
    const container = this.#projectContainer(project.name);
    const baseRef = task.baseRef ?? project.developmentBranch;
    const physical = await this.git.ensureWorktree({
      repositoryPath: project.path,
      container,
      taskId: task.id,
      roleName: MAIN_WORKTREE,
      baseRef: existing?.baseCommit ?? baseRef
    });
    const workspace = existing ?? createRoleWorkspace({
      taskId: task.id,
      roleName: LEADER_ROLE,
      owner: { type: "task" },
      projectId: project.id,
      path: physical.path,
      branch: physical.branch,
      baseRef,
      baseCommit: physical.baseCommit
    }, this.now());
    assertWorkspaceIdentity(workspace, {
      taskId: task.id,
      roleName: LEADER_ROLE,
      projectId: project.id,
      path: physical.path,
      branch: physical.branch,
      baseRef
    });

    try {
      this.store.transaction((tx) => {
        const latest = requireTask(tx, task.id);
        if (!["draft", "active"].includes(latest.status)) {
          throw new Error(`Task changed while preparing its worktree: ${task.id}.`);
        }
        if (latest.projectId !== project.id) {
          throw new Error(`Task Project changed while preparing its worktree: ${task.id}.`);
        }
        const current = tx.getRoleWorkspace(task.id, LEADER_ROLE);
        if (current !== null) {
          if (current.owner.type !== "task") {
            throw new Error(`Task main worktree ownership is invalid: ${task.id}.`);
          }
          assertWorkspaceIdentity(current, {
            taskId: task.id,
            roleName: LEADER_ROLE,
            projectId: project.id,
            path: physical.path,
            branch: physical.branch,
            baseRef
          });
        } else {
          tx.saveRoleWorkspace(task.id, workspace);
        }
        const timestamp = this.now();
        for (const role of tx.listRoles(task.id)) {
          const isolated = tx.getRoleWorkspace(task.id, role.name);
          if (isolated !== null && isolated.owner.type === "work-item") continue;
          if (role.workspace !== physical.path) {
            tx.saveRole(task.id, updateRole(role, { workspace: physical.path }, timestamp));
          }
        }
        if (latest.cwd !== physical.path) {
          tx.saveTask({ ...latest, cwd: physical.path, updatedAt: timestamp.toISOString() });
        }
      });
    } catch (error) {
      await this.#discardUnadoptedWorkspace(project.path, project.name, workspace);
      throw error;
    }
    return {
      taskId,
      status: "ready",
      path: physical.path
    };
  }

  async prepareWorkItemWorkspace(workItemId: string): Promise<RoleWorkspace> {
    const item = this.store.findWorkItem(workItemId);
    if (item === null) throw new Error(`Work item not found: ${workItemId}.`);
    const task = requireTask(this.store, item.taskId);
    if (task.status !== "active") throw new Error(`Task is not active: ${task.id}.`);
    if (task.projectId === undefined) {
      throw new Error(`WorkItem isolation requires a Project-backed Task: ${task.id}.`);
    }
    if (item.assignee === LEADER_ROLE) {
      throw new Error("The Leader must remain in the Task main worktree.");
    }
    if (["completed", "failed", "cancelled", "superseded"].includes(item.status)) {
      throw new Error(`Work item is already terminal: ${item.id}.`);
    }
    if (this.store.getActiveAgentRun(task.id, item.assignee) !== null) {
      throw new Error(`Role has an active Run: ${task.id}/${item.assignee}.`);
    }
    const project = this.store.getProject(task.projectId);
    if (project === null) throw new Error(`Project not found: ${task.projectId}.`);
    await this.prepareTaskWorkspace(task.id);
    const main = this.store.getRoleWorkspace(task.id, LEADER_ROLE);
    if (main === null || main.owner.type !== "task") {
      throw new Error(`Task main worktree is not ready: ${task.id}.`);
    }
    const role = this.store.getRole(task.id, item.assignee);
    if (role === null) throw new Error(`Role not found: ${task.id}/${item.assignee}.`);
    const existing = this.store.getRoleWorkspace(task.id, role.name);
    if (existing !== null) {
      if (existing.owner.type === "work-item" && existing.owner.workItemId === item.id) return existing;
      throw new Error(`Role already has an isolated WorkItem worktree: ${task.id}/${role.name}.`);
    }
    const head = await this.git.inspect(main.path, "HEAD");
    const physical = await this.git.ensureWorktree({
      repositoryPath: project.path,
      container: this.#projectContainer(project.name),
      taskId: task.id,
      roleName: item.id,
      baseRef: head.baseCommit
    });
    const workspace = createRoleWorkspace({
      taskId: task.id,
      roleName: role.name,
      owner: { type: "work-item", workItemId: item.id },
      projectId: project.id,
      path: physical.path,
      branch: physical.branch,
      baseRef: head.baseCommit,
      baseCommit: physical.baseCommit
    }, this.now());
    try {
      return this.store.transaction((tx) => {
        const latestTask = requireTask(tx, task.id);
        if (latestTask.status !== "active") {
          throw new Error(`Task is not active: ${latestTask.id}.`);
        }
        const latestItem = tx.getWorkItem(task.id, item.id);
        if (latestItem === null || latestItem.assignee !== role.name) {
          throw new Error(`Work item changed while preparing isolation: ${item.id}.`);
        }
        if (["completed", "failed", "cancelled", "superseded"].includes(latestItem.status)) {
          throw new Error(`Work item is already terminal: ${item.id}.`);
        }
        if (tx.getActiveAgentRun(task.id, role.name) !== null) {
          throw new Error(`Role has an active Run: ${task.id}/${role.name}.`);
        }
        const latestRole = tx.getRole(task.id, role.name);
        if (latestRole === null) throw new Error(`Role not found: ${task.id}/${role.name}.`);
        const current = tx.getRoleWorkspace(task.id, role.name);
        if (current !== null) {
          if (current.owner.type === "work-item"
            && current.owner.workItemId === item.id) return current;
          throw new Error(`Role workspace changed: ${task.id}/${role.name}.`);
        }
        tx.saveRoleWorkspace(task.id, workspace);
        tx.saveRole(task.id, updateRole(latestRole, { workspace: workspace.path }, this.now()));
        return workspace;
      });
    } catch (error) {
      await this.#discardUnadoptedWorkspace(project.path, project.name, workspace);
      throw error;
    }
  }

  async inspectWorkItemWorkspace(workItemId: string): Promise<GitWorkspaceState> {
    const item = this.store.findWorkItem(workItemId);
    if (item === null) throw new Error(`Work item not found: ${workItemId}.`);
    const workspace = this.store.getRoleWorkspace(item.taskId, item.assignee);
    if (workspace === null) return "missing";
    if (workspace.owner.type !== "work-item" || workspace.owner.workItemId !== item.id) {
      throw new Error(`WorkItem does not own the Role workspace: ${item.id}.`);
    }
    const project = this.store.getProject(workspace.projectId);
    if (project === null) throw new Error(`Project not found: ${workspace.projectId}.`);
    return this.git.inspectWorktree({
      repositoryPath: project.path,
      container: this.#projectContainer(project.name),
      taskId: item.taskId,
      roleName: managedWorktreeName(workspace.owner)
    });
  }

  async cleanupWorkItemWorkspace(
    workItemId: string,
    disposition: WorkItemWorkspaceDisposition
  ): Promise<GitWorkspaceRemoval> {
    const item = this.store.findWorkItem(workItemId);
    if (item === null) throw new Error(`Work item not found: ${workItemId}.`);
    const task = requireTask(this.store, item.taskId);
    if (!["completed", "failed", "cancelled", "superseded"].includes(item.status)) {
      throw new Error(`Work item must be terminal before cleanup: ${item.id}.`);
    }
    if (item.workspaceDisposition !== undefined
      && item.workspaceDisposition !== disposition) {
      throw new Error(
        `Work item workspace is already recorded as ${item.workspaceDisposition}.`
      );
    }
    const workspace = this.store.getRoleWorkspace(task.id, item.assignee);
    if (workspace === null) {
      if (item.workspaceDisposition === disposition) return "missing";
      throw new Error(`WorkItem has no managed isolated worktree: ${item.id}.`);
    }
    if (workspace.owner.type !== "work-item" || workspace.owner.workItemId !== item.id) {
      throw new Error(`WorkItem does not own the Role workspace: ${item.id}.`);
    }
    const project = this.store.getProject(workspace.projectId);
    if (project === null) throw new Error(`Project not found: ${workspace.projectId}.`);
    const removal = await this.git.removeWorktree({
      repositoryPath: project.path,
      container: this.#projectContainer(project.name),
      taskId: task.id,
      roleName: managedWorktreeName(workspace.owner),
      deleteBranch: true
    });
    if (removal === "dirty") return removal;
    this.#recordWorkspaceRemoval(task, workspace, project.path, {
      workItemId: item.id,
      disposition
    });
    return removal;
  }

  async inspectTaskMainWorkspace(taskId: string): Promise<GitWorkspaceState> {
    const task = requireTask(this.store, taskId);
    const isolated = this.store.listRoleWorkspaces(task.id)
      .filter(({ owner }) => owner.type === "work-item");
    if (isolated.length > 0) {
      throw new Error(
        `Task has WorkItem worktrees that require explicit cleanup: ${
          isolated.map(({ owner }) => owner.type === "work-item" ? owner.workItemId : "")
            .join(", ")
        }.`
      );
    }
    const main = this.store.getRoleWorkspace(task.id, LEADER_ROLE);
    if (main === null || task.projectId === undefined) return "missing";
    if (main.owner.type !== "task") {
      throw new Error(`Task main worktree ownership is invalid: ${task.id}.`);
    }
    const project = this.store.getProject(task.projectId);
    if (project === null) throw new Error(`Project not found: ${task.projectId}.`);
    return this.git.inspectWorktree({
      repositoryPath: project.path,
      container: this.#projectContainer(project.name),
      taskId: task.id,
      roleName: managedWorktreeName(main.owner)
    });
  }

  async cleanupTaskForArchive(taskId: string): Promise<TaskWorkspaceCleanup> {
    const task = requireTask(this.store, taskId);
    if (task.projectId === undefined) {
      this.#clearTaskWorkspace(
        task,
        this.store.getConfig().defaultWorkspace ?? process.cwd()
      );
      return { taskId, status: "removed" };
    }
    const project = this.store.getProject(task.projectId);
    if (project === null) throw new Error(`Project not found: ${task.projectId}.`);
    const isolated = this.store.listRoleWorkspaces(task.id)
      .filter(({ owner }) => owner.type === "work-item");
    if (isolated.length > 0) {
      return {
        taskId,
        status: "failed",
        ...(task.cwd === undefined ? {} : { path: task.cwd }),
        error: `WorkItem worktrees require explicit cleanup: ${
          isolated.map(({ owner }) => owner.type === "work-item" ? owner.workItemId : "")
            .join(", ")
        }.`
      };
    }
    const main = this.store.getRoleWorkspace(task.id, LEADER_ROLE);
    if (main !== null) {
      const removal = await this.git.removeWorktree({
        repositoryPath: project.path,
        container: this.#projectContainer(project.name),
        taskId: task.id,
        roleName: managedWorktreeName(main.owner)
      });
      if (removal === "dirty") {
        return {
          taskId,
          status: "retained-dirty",
          ...(task.cwd === undefined ? {} : { path: task.cwd })
        };
      }
      this.#recordWorkspaceRemoval(task, main, project.path);
    }
    this.#clearTaskWorkspace(requireTask(this.store, task.id), project.path);
    await removeEmptyDirectory(this.#taskContainer(project.name, task.id));
    return { taskId, status: "removed" };
  }

  #projectContainer(projectName: string): string {
    return join(resolveWorktreeRoot(this.home, this.store.getConfig().defaultWorkspace),
      safePathSegment(projectName));
  }

  #taskContainer(projectName: string, taskId: string): string {
    return join(this.#projectContainer(projectName), taskId);
  }

  async #discardUnadoptedWorkspace(
    repositoryPath: string,
    projectName: string,
    workspace: RoleWorkspace
  ): Promise<void> {
    const current = this.store.getRoleWorkspace(workspace.taskId, workspace.roleName);
    if (current !== null
      && managedWorktreeName(current.owner) === managedWorktreeName(workspace.owner)
      && current.path === workspace.path) return;
    const removal = await this.git.removeWorktree({
      repositoryPath,
      container: this.#projectContainer(projectName),
      taskId: workspace.taskId,
      roleName: managedWorktreeName(workspace.owner)
    });
    if (removal === "dirty") {
      throw new Error(
        `Unadopted managed worktree is dirty and was retained at ${workspace.path}; inspect it and retry.`
      );
    }
  }

  #recordWorkspaceRemoval(
    task: Task,
    workspace: RoleWorkspace,
    fallback: string,
    workItem?: Readonly<{
      workItemId: string;
      disposition: WorkItemWorkspaceDisposition;
    }>
  ): void {
    this.store.transaction((tx) => {
      const role = tx.getRole(task.id, workspace.roleName);
      tx.removeRoleWorkspace(task.id, workspace.roleName);
      const main = tx.getRoleWorkspace(task.id, LEADER_ROLE);
      const target = workspace.owner.type === "task" ? fallback : main?.path ?? fallback;
      if (role !== null && role.workspace !== target) {
        tx.saveRole(task.id, updateRole(role, { workspace: target }, this.now()));
      }
      if (workItem !== undefined) {
        const item = tx.getWorkItem(task.id, workItem.workItemId);
        if (item === null) throw new Error(`Work item not found: ${workItem.workItemId}.`);
        tx.saveWorkItem(task.id, recordWorkItemWorkspaceDisposition(
          item,
          workItem.disposition,
          this.now()
        ));
      }
    });
  }

  #clearTaskWorkspace(task: Task, fallback: string): void {
    this.store.transaction((tx) => {
      const latest = requireTask(tx, task.id);
      for (const role of tx.listRoles(task.id)) {
        if (role.workspace !== fallback) {
          tx.saveRole(task.id, updateRole(role, { workspace: fallback }, this.now()));
        }
      }
      if (latest.cwd !== undefined) {
        const { cwd: _cwd, ...withoutCwd } = latest;
        tx.saveTask({ ...withoutCwd, updatedAt: this.now().toISOString() });
      }
    });
  }
}

function requireTask(store: TaskStore, taskId: string): Task {
  const task = store.getTask(taskId);
  if (task === null) throw new Error(`Task not found: ${taskId}.`);
  return task;
}

function assertWorkspaceIdentity(
  workspace: RoleWorkspace,
  expected: Readonly<{
    taskId: string;
    roleName: string;
    projectId: string;
    path: string;
    branch: string;
    baseRef: string;
  }>
): void {
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (workspace[key] !== expected[key]) {
      throw new Error(`Managed worktree identity changed: ${expected.taskId}/${expected.roleName}.`);
    }
  }
}

function safePathSegment(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || [".", ".."].includes(normalized) || /[\/\\\0]/.test(normalized)) {
    throw new Error("Project name is invalid for managed workspace layout.");
  }
  return normalized;
}

function resolveWorktreeRoot(home: string, workspace: string | undefined): string {
  if (workspace === undefined) {
    throw new Error("Project workspace is not configured; run yui setup.");
  }
  const homeRoot = resolve(home);
  const workspaceRoot = resolve(workspace);
  const fromHome = relative(homeRoot, workspaceRoot);
  if (fromHome === "" || (!fromHome.startsWith("..") && !isAbsolute(fromHome))) {
    throw new Error("Project workspace must be outside YUI_HOME.");
  }
  return join(workspaceRoot, "worktree");
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error
      && ["ENOENT", "ENOTEMPTY"].includes(String((error as { code?: unknown }).code))) return;
    throw error;
  }
}
