import {
  mkdir,
  readlink,
  readdir,
  rmdir,
  symlink,
  unlink
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { retireTaskRoleSessionsForWorkspace } from "../executor/agentExecutor.js";
import { updateRole } from "../role/role.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
import {
  recordWorkItemWorkspaceDisposition,
  type WorkItem,
  type WorkItemWorkspaceDisposition
} from "../workItem/workItem.js";
import {
  createRoleWorkspace,
  managedWorktreeName,
  type RoleWorkspace,
  type WorkspaceProjectEntry
} from "../worktree/roleWorkspace.js";
import {
  NodeGitWorkspace,
  type GitWorkspacePort,
  type GitWorkspaceRemoval,
  type GitWorkspaceState
} from "./gitWorkspace.js";
import type { Project } from "./project.js";

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
 * A Task owns one workspace root containing every bound Project. A WorkItem
 * owns another root: writable Projects point at isolated worktrees while the
 * remaining entries point at the Task main worktrees as read-only context.
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
    if (!["draft", "active"].includes(task.status)) {
      throw new Error(`Task is not open for workspace preparation: ${task.id}.`);
    }
    if (task.projectBindings.length === 0) {
      return {
        taskId,
        status: "ready",
        ...(task.cwd === undefined ? {} : { path: task.cwd })
      };
    }
    const leader = this.store.getRole(task.id, LEADER_ROLE);
    if (leader === null) throw new Error(`Task leader Role not found: ${task.id}.`);
    const existing = this.store.getRoleWorkspace(task.id, LEADER_ROLE);
    if (existing !== null && existing.owner.type !== "task") {
      throw new Error(`Task main workspace ownership is invalid: ${task.id}.`);
    }

    const root = this.#taskWorkspaceRoot(task.id);
    const prepared: Array<Readonly<{ project: Project; entry: WorkspaceProjectEntry }>> = [];
    try {
      for (const binding of task.projectBindings) {
        const project = requireProject(this.store, binding.projectId);
        const previous = existing?.entries.find(({ projectId }) => projectId === project.id);
        const physical = await this.git.ensureWorktree({
          repositoryPath: project.path,
          container: this.#projectContainer(project.name),
          taskId: task.id,
          roleName: MAIN_WORKTREE,
          baseRef: previous?.baseCommit ?? binding.baseRef
        });
        prepared.push({
          project,
          entry: {
            projectId: project.id,
            directory: binding.directory,
            access: "write",
            path: physical.path,
            branch: physical.branch,
            baseRef: binding.baseRef,
            baseCommit: physical.baseCommit
          }
        });
      }
      await ensureWorkspaceView(root, prepared.map(({ entry }) => entry));
      const workspace = createRoleWorkspace({
        taskId: task.id,
        roleName: LEADER_ROLE,
        owner: { type: "task" },
        root,
        entries: prepared.map(({ entry }) => entry)
      }, this.now());
      this.store.transaction((tx) => {
        const latest = requireTask(tx, task.id);
        if (!["draft", "active"].includes(latest.status)) {
          throw new Error(`Task changed while preparing its workspace: ${task.id}.`);
        }
        if (!isDeepStrictEqual(latest.projectBindings, task.projectBindings)) {
          throw new Error(`Task Projects changed while preparing its workspace: ${task.id}.`);
        }
        const current = tx.getRoleWorkspace(task.id, LEADER_ROLE);
        if (current !== null && current.owner.type !== "task") {
          throw new Error(`Task main workspace ownership is invalid: ${task.id}.`);
        }
        tx.saveRoleWorkspace(task.id, preserveWorkspaceCreatedAt(workspace, current));
        const timestamp = this.now();
        for (const role of tx.listRoles(task.id)) {
          const assigned = tx.getRoleWorkspace(task.id, role.name);
          if (assigned !== null && assigned.owner.type === "work-item") continue;
          if (role.workspace !== root) {
            retireWorkspaceBoundSession(tx, task.id, role.name, timestamp);
            tx.saveRole(task.id, updateRole(role, { workspace: root }, timestamp));
          }
        }
        if (latest.cwd !== root) {
          tx.saveTask({ ...latest, cwd: root, updatedAt: timestamp.toISOString() });
        }
      });
      return { taskId, status: "ready", path: root };
    } catch (error) {
      await this.#discardUnadoptedEntries(task, prepared, MAIN_WORKTREE);
      throw error;
    }
  }

  async prepareWorkItemWorkspace(
    taskId: string,
    workItemId: string
  ): Promise<RoleWorkspace> {
    const item = requireWorkItem(this.store, taskId, workItemId);
    const task = requireTask(this.store, item.taskId);
    assertWorkItemWorkspaceEligible(this.store, task, item);
    await this.prepareTaskWorkspace(task.id);
    const main = this.store.getRoleWorkspace(task.id, LEADER_ROLE);
    if (main === null || main.owner.type !== "task") {
      throw new Error(`Task main workspace is not ready: ${task.id}.`);
    }
    const role = this.store.getRole(task.id, item.assignee!);
    if (role === null) throw new Error(`Role not found: ${task.id}/${item.assignee}.`);
    const existing = this.store.getRoleWorkspace(task.id, role.name);
    if (existing !== null && (
      existing.owner.type !== "work-item"
      || existing.owner.workItemId !== item.id
    )) {
      throw new Error(`Role already has another WorkItem workspace: ${task.id}/${role.name}.`);
    }
    assertWorkspaceSessionsRetirable(this.store, task.id, role.name, this.now());

    const writeProjects = new Set(item.writeProjectIds);
    const root = this.#workItemWorkspaceRoot(task.id, item.id);
    const prepared: Array<Readonly<{ project: Project; entry: WorkspaceProjectEntry }>> = [];
    try {
      for (const binding of task.projectBindings) {
        const project = requireProject(this.store, binding.projectId);
        const mainEntry = requireWorkspaceEntry(main, project.id);
        if (!writeProjects.has(project.id)) {
          prepared.push({
            project,
            entry: { ...mainEntry, access: "read" }
          });
          continue;
        }
        const previous = existing?.entries.find(({ projectId }) => projectId === project.id);
        const head = await this.git.inspect(mainEntry.path, "HEAD");
        const physical = await this.git.ensureWorktree({
          repositoryPath: project.path,
          container: this.#projectContainer(project.name),
          taskId: task.id,
          roleName: item.id,
          baseRef: previous?.access === "write" ? previous.baseCommit : head.baseCommit
        });
        if (previous?.access === "write" && (
          physical.path !== previous.path
          || physical.branch !== previous.branch
        )) {
          throw new Error(
            `Existing WorkItem Project workspace identity changed: ${item.id}/${project.id}.`
          );
        }
        prepared.push({
          project,
          entry: {
            projectId: project.id,
            directory: binding.directory,
            access: "write",
            path: physical.path,
            branch: physical.branch,
            baseRef: previous?.access === "write" ? previous.baseRef : head.baseCommit,
            // The recorded base is the immutable capture boundary. An existing
            // worktree reports its current HEAD from ensureWorktree(), which
            // may already contain committed Worker changes and must never
            // replace that boundary during scope expansion or reconciliation.
            baseCommit: previous?.access === "write"
              ? previous.baseCommit
              : physical.baseCommit
          }
        });
      }
      await ensureWorkspaceView(root, prepared.map(({ entry }) => entry));
      const workspace = createRoleWorkspace({
        taskId: task.id,
        roleName: role.name,
        owner: { type: "work-item", workItemId: item.id },
        root,
        entries: prepared.map(({ entry }) => entry)
      }, this.now());
      return this.store.transaction((tx) => {
        const latestTask = requireTask(tx, task.id);
        const latestItem = tx.getWorkItem(task.id, item.id);
        if (latestTask.status !== "active" || latestItem === null) {
          throw new Error(`Work item changed while preparing its workspace: ${item.id}.`);
        }
        if (latestItem.revision !== item.revision
          || latestItem.assignee !== role.name
          || !isDeepStrictEqual(latestItem.writeProjectIds, item.writeProjectIds)) {
          throw new Error(`Work item changed while preparing its workspace: ${item.id}.`);
        }
        if (tx.getActiveAgentRun(task.id, role.name) !== null) {
          throw new Error(`Role has an active Run: ${task.id}/${role.name}.`);
        }
        const latestRole = tx.getRole(task.id, role.name);
        if (latestRole === null) throw new Error(`Role not found: ${task.id}/${role.name}.`);
        const current = tx.getRoleWorkspace(task.id, role.name);
        if (current !== null && (
          current.owner.type !== "work-item"
          || current.owner.workItemId !== item.id
        )) {
          throw new Error(`Role workspace changed: ${task.id}/${role.name}.`);
        }
        const timestamp = this.now();
        retireWorkspaceBoundSession(tx, task.id, role.name, timestamp);
        const stored = preserveWorkspaceCreatedAt(workspace, current);
        tx.saveRoleWorkspace(task.id, stored);
        tx.saveRole(task.id, updateRole(latestRole, { workspace: root }, timestamp));
        return stored;
      });
    } catch (error) {
      await this.#discardUnadoptedEntries(task, prepared, item.id);
      throw error;
    }
  }

  async inspectWorkItemWorkspace(
    taskId: string,
    workItemId: string
  ): Promise<GitWorkspaceState> {
    const item = requireWorkItem(this.store, taskId, workItemId);
    if (item.assignee === undefined) return "missing";
    const workspace = this.store.getRoleWorkspace(item.taskId, item.assignee);
    if (workspace === null) return "missing";
    assertWorkItemOwnsWorkspace(item, workspace);
    return this.#inspectEntries(
      item.taskId,
      managedWorktreeName(workspace.owner),
      workspace.entries.filter(({ access }) => access === "write")
    );
  }

  async cleanupWorkItemWorkspace(
    taskId: string,
    workItemId: string,
    disposition: WorkItemWorkspaceDisposition
  ): Promise<GitWorkspaceRemoval> {
    const item = requireWorkItem(this.store, taskId, workItemId);
    const task = requireTask(this.store, item.taskId);
    if (!["completed", "failed", "cancelled", "superseded"].includes(item.status)) {
      throw new Error(`Work item must be terminal before cleanup: ${item.id}.`);
    }
    if (item.workspaceDisposition !== undefined && item.workspaceDisposition !== disposition) {
      throw new Error(`Work item workspace is already recorded as ${item.workspaceDisposition}.`);
    }
    if (item.assignee === undefined) {
      throw new Error(`WorkItem has no Task Role workspace: ${item.id}.`);
    }
    const workspace = this.store.getRoleWorkspace(task.id, item.assignee);
    if (workspace === null) {
      if (item.workspaceDisposition === disposition) return "missing";
      throw new Error(`WorkItem has no managed isolated worktree workspace: ${item.id}.`);
    }
    assertWorkItemOwnsWorkspace(item, workspace);
    assertWorkspaceSessionsRetirable(this.store, task.id, workspace.roleName, this.now());
    const writable = workspace.entries.filter(({ access }) => access === "write");
    if (await this.#inspectEntries(
      task.id,
      managedWorktreeName(workspace.owner),
      writable
    ) === "dirty") return "dirty";
    let removed = false;
    for (const entry of writable) {
      const project = requireProject(this.store, entry.projectId);
      const result = await this.git.removeWorktree({
        repositoryPath: project.path,
        container: this.#projectContainer(project.name),
        taskId: task.id,
        roleName: managedWorktreeName(workspace.owner),
        deleteBranch: true
      });
      if (result === "dirty") {
        throw new Error(`WorkItem workspace changed after cleanup preflight: ${item.id}.`);
      }
      removed ||= result === "removed";
    }
    await removeWorkspaceView(workspace.root);
    try {
      this.#recordWorkspaceRemoval(task, workspace, this.#fallbackWorkspace(), {
        workItemId: item.id,
        disposition
      });
    } catch (error) {
      if (!removed) throw error;
      throw new Error(
        `WorkItem worktree was removed but durable cleanup was not recorded; retry cleanup: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return removed ? "removed" : "missing";
  }

  async inspectTaskMainWorkspace(taskId: string): Promise<GitWorkspaceState> {
    const task = requireTask(this.store, taskId);
    const isolated = this.store.listRoleWorkspaces(task.id)
      .filter(({ owner }) => owner.type === "work-item");
    if (isolated.length > 0) {
      throw new Error(
        `Task has WorkItem workspaces that require explicit cleanup: ${
          isolated.map(({ owner }) => owner.type === "work-item" ? owner.workItemId : "").join(", ")
        }.`
      );
    }
    const main = this.store.getRoleWorkspace(task.id, LEADER_ROLE);
    if (main === null) return "missing";
    if (main.owner.type !== "task") {
      throw new Error(`Task main workspace ownership is invalid: ${task.id}.`);
    }
    return this.#inspectEntries(task.id, MAIN_WORKTREE, main.entries);
  }

  async cleanupTaskForArchive(taskId: string): Promise<TaskWorkspaceCleanup> {
    const task = requireTask(this.store, taskId);
    const isolated = this.store.listRoleWorkspaces(task.id)
      .filter(({ owner }) => owner.type === "work-item");
    if (isolated.length > 0) {
      return {
        taskId,
        status: "failed",
        ...(task.cwd === undefined ? {} : { path: task.cwd }),
        error: `WorkItem workspaces require explicit cleanup: ${
          isolated.map(({ owner }) => owner.type === "work-item" ? owner.workItemId : "").join(", ")
        }.`
      };
    }
    const main = this.store.getRoleWorkspace(task.id, LEADER_ROLE);
    if (main !== null) {
      if (await this.#inspectEntries(task.id, MAIN_WORKTREE, main.entries) === "dirty") {
        return {
          taskId,
          status: "retained-dirty",
          ...(task.cwd === undefined ? {} : { path: task.cwd })
        };
      }
      for (const entry of main.entries) {
        const project = requireProject(this.store, entry.projectId);
        const result = await this.git.removeWorktree({
          repositoryPath: project.path,
          container: this.#projectContainer(project.name),
          taskId: task.id,
          roleName: MAIN_WORKTREE
        });
        if (result === "dirty") {
          throw new Error(`Task workspace changed after cleanup preflight: ${task.id}.`);
        }
      }
      await removeWorkspaceView(main.root);
      this.#recordWorkspaceRemoval(task, main, this.#fallbackWorkspace());
    }
    this.#clearTaskWorkspace(requireTask(this.store, task.id), this.#fallbackWorkspace());
    return { taskId, status: "removed" };
  }

  async #inspectEntries(
    taskId: string,
    roleName: string,
    entries: readonly WorkspaceProjectEntry[]
  ): Promise<GitWorkspaceState> {
    if (entries.length === 0) return "missing";
    let found = false;
    for (const entry of entries) {
      const project = requireProject(this.store, entry.projectId);
      const state = await this.git.inspectWorktree({
        repositoryPath: project.path,
        container: this.#projectContainer(project.name),
        taskId,
        roleName
      });
      if (state === "dirty") return "dirty";
      found ||= state === "clean";
    }
    return found ? "clean" : "missing";
  }

  #projectContainer(projectName: string): string {
    return join(resolveWorktreeRoot(this.home, this.store.getConfig().defaultWorkspace),
      safePathSegment(projectName));
  }

  #taskWorkspaceRoot(taskId: string): string {
    return join(resolveTaskRoot(this.home, this.store.getConfig().defaultWorkspace),
      safePathSegment(taskId), "main");
  }

  #workItemWorkspaceRoot(taskId: string, workItemId: string): string {
    return join(resolveTaskRoot(this.home, this.store.getConfig().defaultWorkspace),
      safePathSegment(taskId), "work-items", safePathSegment(workItemId));
  }

  #fallbackWorkspace(): string {
    return this.store.getConfig().defaultWorkspace ?? process.cwd();
  }

  async #discardUnadoptedEntries(
    task: Task,
    prepared: readonly Readonly<{ project: Project; entry: WorkspaceProjectEntry }>[],
    roleName: string
  ): Promise<void> {
    const adoptedPaths = new Set(this.store.listRoleWorkspaces(task.id)
      .flatMap((workspace) => workspace.entries.map(({ path }) => path)));
    for (const { project, entry } of prepared.filter(
      ({ entry }) => entry.access === "write" && !adoptedPaths.has(entry.path)
    )) {
      const removal = await this.git.removeWorktree({
        repositoryPath: project.path,
        container: this.#projectContainer(project.name),
        taskId: task.id,
        roleName
      });
      if (removal === "dirty") {
        throw new Error(
          `Unadopted managed worktree is dirty and was retained at ${entry.path}; inspect it and retry.`
        );
      }
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
      const current = tx.getRoleWorkspace(task.id, workspace.roleName);
      if (current === null || !sameRoleWorkspace(current, workspace)) {
        if (workItem === undefined) {
          throw new Error(`Managed workspace changed before cleanup was recorded: ${
            task.id
          }/${workspace.roleName}.`);
        }
        recordWorkspaceDisposition(tx, task.id, workItem, this.now());
        return;
      }
      const role = tx.getRole(task.id, workspace.roleName);
      tx.removeRoleWorkspace(task.id, workspace.roleName);
      const main = tx.getRoleWorkspace(task.id, LEADER_ROLE);
      const target = workspace.owner.type === "task" ? fallback : main?.root ?? fallback;
      if (role !== null && role.workspace !== target) {
        const timestamp = this.now();
        retireWorkspaceBoundSession(tx, task.id, role.name, timestamp);
        tx.saveRole(task.id, updateRole(role, { workspace: target }, timestamp));
      }
      if (workItem !== undefined) {
        recordWorkspaceDisposition(tx, task.id, workItem, this.now());
      }
    });
  }

  #clearTaskWorkspace(task: Task, fallback: string): void {
    this.store.transaction((tx) => {
      const latest = requireTask(tx, task.id);
      for (const role of tx.listRoles(task.id)) {
        if (role.workspace !== fallback) {
          const timestamp = this.now();
          retireWorkspaceBoundSession(tx, task.id, role.name, timestamp);
          tx.saveRole(task.id, updateRole(role, { workspace: fallback }, timestamp));
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

function requireProject(store: TaskStore, projectId: string): Project {
  const project = store.getProject(projectId);
  if (project === null) throw new Error(`Project not found: ${projectId}.`);
  return project;
}

function requireWorkItem(
  store: TaskStore,
  taskId: string,
  workItemId: string
): WorkItem {
  const item = store.getWorkItem(taskId, workItemId);
  if (item === null) throw new Error(`Work item not found: ${taskId}/${workItemId}.`);
  return item;
}

function requireWorkspaceEntry(
  workspace: RoleWorkspace,
  projectId: string
): WorkspaceProjectEntry {
  const entry = workspace.entries.find((candidate) => candidate.projectId === projectId);
  if (entry === undefined) throw new Error(`Workspace Project not found: ${projectId}.`);
  return entry;
}

function assertWorkItemWorkspaceEligible(
  store: TaskStore,
  task: Task,
  item: WorkItem
): void {
  if (task.status !== "active") throw new Error(`Task is not active: ${task.id}.`);
  if (item.assignee === undefined) {
    throw new Error(`WorkItem workspace requires a Task Role assignee: ${item.id}.`);
  }
  if (item.assignee === LEADER_ROLE) {
    throw new Error("The Leader must remain in the Task main workspace.");
  }
  if (["completed", "failed", "cancelled", "superseded"].includes(item.status)) {
    throw new Error(`Work item is already terminal: ${item.id}.`);
  }
  if (store.getActiveAgentRun(task.id, item.assignee) !== null) {
    throw new Error(`Role has an active Run: ${task.id}/${item.assignee}.`);
  }
}

function assertWorkItemOwnsWorkspace(item: WorkItem, workspace: RoleWorkspace): void {
  if (workspace.owner.type !== "work-item" || workspace.owner.workItemId !== item.id) {
    throw new Error(`WorkItem does not own the Role workspace: ${item.id}.`);
  }
}

function preserveWorkspaceCreatedAt(
  workspace: RoleWorkspace,
  previous: RoleWorkspace | null
): RoleWorkspace {
  return previous === null
    ? workspace
    : { ...workspace, createdAt: previous.createdAt };
}

function assertWorkspaceSessionsRetirable(
  store: TaskStore,
  taskId: string,
  roleName: string,
  now: Date
): void {
  if (store.getActiveAgentRun(taskId, roleName) !== null) {
    throw new Error(`Role has an active Run: ${taskId}/${roleName}.`);
  }
  const sessions = store.getTaskRoleSessionSet(taskId, roleName);
  if (sessions !== null) retireTaskRoleSessionsForWorkspace(sessions, now);
}

function retireWorkspaceBoundSession(
  store: TaskStore,
  taskId: string,
  roleName: string,
  now: Date
): void {
  if (store.getActiveAgentRun(taskId, roleName) !== null) {
    throw new Error(`Role has an active Run: ${taskId}/${roleName}.`);
  }
  const sessions = store.getTaskRoleSessionSet(taskId, roleName);
  if (sessions !== null) {
    store.saveTaskRoleSessionSet(retireTaskRoleSessionsForWorkspace(sessions, now));
  }
}

function sameRoleWorkspace(left: RoleWorkspace, right: RoleWorkspace): boolean {
  return isDeepStrictEqual(left, right);
}

function recordWorkspaceDisposition(
  store: TaskStore,
  taskId: string,
  workItem: Readonly<{
    workItemId: string;
    disposition: WorkItemWorkspaceDisposition;
  }>,
  now: Date
): void {
  const item = store.getWorkItem(taskId, workItem.workItemId);
  if (item === null) throw new Error(`Work item not found: ${workItem.workItemId}.`);
  store.saveWorkItem(taskId, recordWorkItemWorkspaceDisposition(
    item,
    workItem.disposition,
    now
  ));
}

async function ensureWorkspaceView(
  root: string,
  entries: readonly WorkspaceProjectEntry[]
): Promise<void> {
  await mkdir(root, { recursive: true });
  const expected = new Map(entries.map((entry) => [entry.directory, entry.path]));
  for (const current of await readdir(root, { withFileTypes: true })) {
    const target = expected.get(current.name);
    if (!current.isSymbolicLink()) {
      throw new Error(`Managed workspace contains an unexpected entry: ${join(root, current.name)}.`);
    }
    const path = join(root, current.name);
    const linked = resolve(root, await readlink(path));
    if (target === undefined) {
      await unlink(path);
      continue;
    }
    if (linked !== target) {
      await unlink(path);
      await symlink(target, path, "dir");
    }
    expected.delete(current.name);
  }
  for (const [directory, target] of expected) {
    await symlink(target, join(root, directory), "dir");
  }
}

async function removeWorkspaceView(root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) {
      throw new Error(`Managed workspace contains an unexpected entry: ${join(root, entry.name)}.`);
    }
    await unlink(join(root, entry.name));
  }
  await rmdir(root);
}

function safePathSegment(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || [".", ".."].includes(normalized) || /[\/\\\0]/.test(normalized)) {
    throw new Error("Identity is invalid for managed workspace layout.");
  }
  return normalized;
}

export function resolveWorktreeRoot(home: string, workspace: string | undefined): string {
  return join(resolveWorkspaceRoot(home, workspace), "worktree");
}

export function resolveTaskRoot(home: string, workspace: string | undefined): string {
  return join(resolveWorkspaceRoot(home, workspace), "tasks");
}

function resolveWorkspaceRoot(home: string, workspace: string | undefined): string {
  if (workspace === undefined) {
    throw new Error("Project workspace is not configured; run yui setup.");
  }
  const homeRoot = resolve(home);
  const workspaceRoot = resolve(workspace);
  const fromHome = relative(homeRoot, workspaceRoot);
  if (fromHome === "" || (!fromHome.startsWith("..") && !isAbsolute(fromHome))) {
    throw new Error("Project workspace must be outside YUI_HOME.");
  }
  return workspaceRoot;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
