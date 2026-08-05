import {
  lstat,
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
  createManagedWorkspace,
  managedWorkspaceKey,
  managedWorktreeName,
  type ManagedWorkspace,
  type WorkspaceProjectEntry
} from "../worktree/managedWorkspace.js";
import {
  NodeGitWorkspace,
  worktreeIdentity,
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

export type ReviewWorkspaceCleanup = "removed" | "missing" | "dirty";

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
    const existing = this.store.getTaskWorkspace(task.id);
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
      const workspace = createManagedWorkspace({
        owner: { type: "task", taskId: task.id },
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
        const current = tx.getTaskWorkspace(task.id);
        if (current !== null && current.owner.type !== "task") {
          throw new Error(`Task main workspace ownership is invalid: ${task.id}.`);
        }
        tx.saveManagedWorkspace(preserveWorkspaceCreatedAt(workspace, current));
        const timestamp = this.now();
        for (const role of tx.listRoles(task.id)) {
          // The Role field is only a cwd/snapshot hint.  Preserve the hint for
          // an active WorkItem assignment; the durable owner is the WorkItem,
          // not this Role record.  Other Roles use Task main.
          const assignedItem = tx.listWorkItems(task.id).find((candidate) => (
            candidate.assignee === role.name
              && !["completed", "failed", "cancelled", "superseded"]
                .includes(candidate.status)
          ));
          const assignedWorkspace = assignedItem === undefined
            ? null
            : tx.getWorkItemWorkspace(task.id, assignedItem.id);
          const target = assignedWorkspace?.root ?? root;
          if (role.workspace !== target) {
            retireWorkspaceBoundSession(tx, task.id, role.name, timestamp);
            tx.saveRole(task.id, updateRole(role, { workspace: target }, timestamp));
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

  async prepareWorkItemWorkspace(workItemId: string): Promise<ManagedWorkspace> {
    const item = requireWorkItem(this.store, workItemId);
    const task = requireTask(this.store, item.taskId);
    assertWorkItemWorkspaceEligible(this.store, task, item);
    await this.prepareTaskWorkspace(task.id);
    const main = this.store.getTaskWorkspace(task.id);
    if (main === null || main.owner.type !== "task") {
      throw new Error(`Task main workspace is not ready: ${task.id}.`);
    }
    const existing = this.store.getWorkItemWorkspace(task.id, item.id);
    if (existing !== null && (
      existing.owner.type !== "work-item"
      || existing.owner.workItemId !== item.id
    )) {
      throw new Error(`WorkItem workspace owner is invalid: ${task.id}/${item.id}.`);
    }
    if (item.assignee !== undefined) {
      assertWorkspaceSessionsRetirable(this.store, task.id, item.assignee, this.now());
    }

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
      const workspace = createManagedWorkspace({
        owner: { type: "work-item", taskId: task.id, workItemId: item.id },
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
          || !isDeepStrictEqual(latestItem.writeProjectIds, item.writeProjectIds)) {
          throw new Error(`Work item changed while preparing its workspace: ${item.id}.`);
        }
        const activeDevelopRun = tx.listAgentRuns(task.id)
          .find((run) => run.status === "active" && run.workItemId === item.id);
        if (activeDevelopRun !== undefined) {
          throw new Error(`Work Item already has an active Develop Run: ${activeDevelopRun.id}.`);
        }
        if (latestItem.assignee !== undefined
          && tx.getActiveAgentRun(task.id, latestItem.assignee) !== null) {
          throw new Error(`Role has an active Run: ${task.id}/${latestItem.assignee}.`);
        }
        const current = tx.getWorkItemWorkspace(task.id, item.id);
        if (current !== null && (
          current.owner.type !== "work-item"
          || current.owner.workItemId !== item.id
        )) {
          throw new Error(`WorkItem workspace changed: ${task.id}/${item.id}.`);
        }
        const timestamp = this.now();
        const stored = preserveWorkspaceCreatedAt(workspace, current);
        tx.saveManagedWorkspace(stored);
        if (latestItem.assignee !== undefined) {
          const latestRole = tx.getRole(task.id, latestItem.assignee);
          if (latestRole !== null && latestRole.workspace !== root) {
            retireWorkspaceBoundSession(tx, task.id, latestItem.assignee, timestamp);
            tx.saveRole(task.id, updateRole(latestRole, { workspace: root }, timestamp));
          }
        }
        return stored;
      });
    } catch (error) {
      await this.#discardUnadoptedEntries(task, prepared, item.id);
      throw error;
    }
  }

  async inspectWorkItemWorkspace(workItemId: string): Promise<GitWorkspaceState> {
    const item = requireWorkItem(this.store, workItemId);
    const workspace = this.store.getWorkItemWorkspace(item.taskId, item.id);
    if (workspace === null) return "missing";
    assertWorkItemOwnsWorkspace(item, workspace);
    return this.#inspectEntries(
      item.taskId,
      managedWorktreeName(workspace.owner),
      workspace.entries.filter(({ access }) => access === "write")
    );
  }

  /** Prepare a fresh, reviewer-writable workspace from the candidate's
   * frozen Develop snapshot.  This record is owned by the ReviewRound; it is
   * never used as a ChangeSet capture source. */
  async prepareReviewRoundWorkspace(reviewRoundId: string): Promise<ManagedWorkspace> {
    const owningTask = this.store.listTasks()
      .find((task) => this.store.getReviewRound(task.id, reviewRoundId) !== null);
    if (owningTask === undefined) throw new Error(`ReviewRound not found: ${reviewRoundId}.`);
    const round = this.store.getReviewRound(owningTask.id, reviewRoundId);
    if (round === null) throw new Error(`ReviewRound not found: ${reviewRoundId}.`);
    const task = requireTask(this.store, round.taskId);
    const item = this.store.getWorkItem(task.id, round.workItemId);
    if (item === null) throw new Error(`Work item not found: ${round.workItemId}.`);
    const candidate = item.candidates.find(({ id }) => id === round.candidateId);
    if (candidate === undefined) throw new Error(`Candidate not found: ${round.candidateId}.`);
    // A Candidate is an immutable snapshot of Develop.  Always prefer that
    // snapshot over the current WorkItem workspace: the Worker may have
    // continued (or a retry may have replaced) Develop after yielding, but a
    // ReviewRound must start from the exact Candidate commit and scope.
    const develop = candidate.workspace
      ?? this.store.getWorkItemWorkspace(task.id, item.id)
      ?? this.store.getTaskWorkspace(task.id);
    if (develop === null || develop === undefined) {
      throw new Error(`Candidate has no Develop workspace: ${round.candidateId}.`);
    }
    const expectedEntries = new Map(
      develop.entries.map((entry) => [entry.projectId, entry] as const)
    );
    const existing = this.store.getReviewRoundWorkspace(task.id, round.id);
    const reviewRoot = this.#reviewRoundWorkspaceRoot(task.id, round.id);
    const retained = new Map<string, Readonly<{ project: Project; entry: WorkspaceProjectEntry }>>();
    const missing = new Set<string>();
    const adopted = existing?.root === reviewRoot;
    if (existing !== null) {
      if (existing.entries.length !== expectedEntries.size) {
        throw new Error(
          `ReviewRound workspace Project scope changed: ${round.id}.`
        );
      }
      for (const entry of existing.entries) {
        const source = expectedEntries.get(entry.projectId);
        if (source === undefined) {
          throw new Error(
            `ReviewRound workspace Project scope changed: ${round.id}/${entry.projectId}.`
          );
        }
        if (!sameCommit(entry.baseCommit, source.baseCommit)) {
          throw new Error(
            `ReviewRound workspace baseCommit record mismatch for ${round.id}/${entry.projectId}: `
            + `expected ${source.baseCommit}, recorded ${entry.baseCommit}.`
          );
        }
        if (!adopted) continue;
        const project = requireProject(this.store, entry.projectId);
        const identity = worktreeIdentity(task.id, round.id);
        const expectedPath = join(
          this.#projectContainer(project.name),
          identity.directory
        );
        if (entry.path !== expectedPath || entry.branch !== identity.branch) {
          throw new Error(
            `ReviewRound workspace managed identity mismatch for ${round.id}/${entry.projectId}.`
          );
        }
        let physical;
        try {
          physical = await this.git.inspect(entry.path, "HEAD");
        } catch (error) {
          try {
            await lstat(entry.path);
          } catch (probeError) {
            if (isMissingPath(probeError)) {
              missing.add(entry.projectId);
              continue;
            }
          }
          throw error;
        }
        if (physical.root !== entry.path) {
          throw new Error(
            `ReviewRound workspace managed path mismatch for ${round.id}/${entry.projectId}.`
          );
        }
        const projectRoot = await this.git.inspect(project.path, "HEAD");
        if (physical.gitDirectory !== projectRoot.gitDirectory) {
          throw new Error(
            `ReviewRound workspace managed Project mismatch for ${round.id}/${entry.projectId}.`
          );
        }
        const branch = await this.git.headRef(entry.path);
        if (branch !== identity.branch) {
          throw new Error(
            `ReviewRound workspace managed branch mismatch for ${round.id}/${entry.projectId}: `
            + `expected ${identity.branch}, physical ${branch}.`
          );
        }
        if (!await this.git.isAncestor(project.path, entry.baseCommit, physical.baseCommit)) {
          throw new Error(
            `ReviewRound workspace HEAD does not descend from its frozen base for `
            + `${round.id}/${entry.projectId}: expected ancestor ${entry.baseCommit}, `
            + `physical HEAD ${physical.baseCommit}.`
          );
        }
        retained.set(entry.projectId, { project, entry });
      }
      if (adopted && missing.size === 0) {
        return existing;
      }
      // The durable owner record can outlive a controller crash before the
      // physical review worktrees were adopted.  Recreate only missing
      // physical entries; existing reviewer diagnostics remain attached to
      // their frozen Candidate provenance.
    }
    const prepared: Array<Readonly<{ project: Project; entry: WorkspaceProjectEntry }>> = [];
    try {
      const sources = adopted
        ? develop.entries.filter((source) => missing.has(source.projectId))
        : develop.entries;
      for (const source of sources) {
        const project = requireProject(this.store, source.projectId);
        const physical = await this.git.ensureWorktree({
          repositoryPath: project.path,
          container: this.#projectContainer(project.name),
          taskId: task.id,
          roleName: round.id,
          baseRef: source.baseCommit
        });
        const entry = {
          ...source,
          access: "write" as const,
          path: physical.path,
          branch: physical.branch,
          baseRef: source.baseCommit,
          baseCommit: source.baseCommit
        };
        prepared.push({ project, entry });
        if (!sameCommit(physical.baseCommit, source.baseCommit)) {
          throw new Error(
            `ReviewRound workspace baseCommit mismatch for ${round.id}/${source.projectId}: `
            + `expected ${source.baseCommit}, physical HEAD ${physical.baseCommit}.`
          );
        }
      }
      const preparedByProject = new Map(
        prepared.map(({ project, entry }) => [project.id, entry] as const)
      );
      const entries = adopted
        ? develop.entries.map((source) => {
          const retainedEntry = retained.get(source.projectId)?.entry;
          if (retainedEntry !== undefined) return retainedEntry;
          const preparedEntry = preparedByProject.get(source.projectId);
          if (preparedEntry === undefined) {
            throw new Error(
              `ReviewRound workspace Project could not be reconstructed: `
              + `${round.id}/${source.projectId}.`
            );
          }
          return preparedEntry;
        })
        : prepared.map(({ entry }) => entry);
      await ensureWorkspaceView(reviewRoot, entries);
      const workspace = createManagedWorkspace({
        owner: { type: "review-round", taskId: task.id, reviewRoundId: round.id },
        root: reviewRoot,
        entries
      }, this.now());
      const stored = preserveWorkspaceCreatedAt(workspace, existing);
      this.store.saveManagedWorkspace(stored);
      return stored;
    } catch (error) {
      await this.#discardUnadoptedEntries(
        task,
        prepared,
        round.id,
        true,
        new Set([...retained.values()].map(({ entry }) => entry.path))
      );
      throw error;
    }
  }

  async cleanupReviewRoundWorkspace(reviewRoundId: string): Promise<ReviewWorkspaceCleanup> {
    const round = this.store.listTasks()
      .map((task) => this.store.getReviewRound(task.id, reviewRoundId))
      .find((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (round === undefined) throw new Error(`ReviewRound not found: ${reviewRoundId}.`);
    if (round.status !== "completed" && round.status !== "failed") {
      throw new Error(`ReviewRound is not terminal: ${round.id}/${round.status}.`);
    }
    const workspace = this.store.getReviewRoundWorkspace(round.taskId, round.id);
    if (workspace === null) return "missing";
    if (await this.#inspectEntries(
      round.taskId,
      managedWorktreeName(workspace.owner),
      workspace.entries
    ) === "dirty") return "dirty";
    let removed = false;
    for (const entry of workspace.entries) {
      const project = requireProject(this.store, entry.projectId);
      const result = await this.git.removeWorktree({
        repositoryPath: project.path,
        container: this.#projectContainer(project.name),
        taskId: round.taskId,
        roleName: managedWorktreeName(workspace.owner),
        deleteBranch: true
      });
      if (result === "dirty") return "dirty";
      removed ||= result === "removed";
    }
    await removeWorkspaceView(workspace.root);
    this.store.removeManagedWorkspace(workspace.owner);
    return removed ? "removed" : "missing";
  }

  async cleanupWorkItemWorkspace(
    workItemId: string,
    disposition: WorkItemWorkspaceDisposition
  ): Promise<GitWorkspaceRemoval> {
    const item = requireWorkItem(this.store, workItemId);
    const task = requireTask(this.store, item.taskId);
    if (!["completed", "failed", "cancelled", "superseded"].includes(item.status)) {
      throw new Error(`Work item must be terminal before cleanup: ${item.id}.`);
    }
    if (item.workspaceDisposition !== undefined && item.workspaceDisposition !== disposition) {
      throw new Error(`Work item workspace is already recorded as ${item.workspaceDisposition}.`);
    }
    const workspace = this.store.getWorkItemWorkspace(task.id, item.id);
    if (workspace === null) {
      if (item.workspaceDisposition === disposition) return "missing";
      throw new Error(`WorkItem has no managed isolated worktree workspace: ${item.id}.`);
    }
    assertWorkItemOwnsWorkspace(item, workspace);
    if (item.assignee !== undefined) {
      assertWorkspaceSessionsRetirable(this.store, task.id, item.assignee, this.now());
    }
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
    const isolated = this.store.listManagedWorkspaces(task.id)
      .filter(({ owner }) => owner.type === "work-item");
    if (isolated.length > 0) {
      throw new Error(
        `Task has WorkItem workspaces that require explicit cleanup: ${
          isolated.map(({ owner }) => owner.type === "work-item" ? owner.workItemId : "").join(", ")
        }.`
      );
    }
    const main = this.store.getTaskWorkspace(task.id);
    if (main === null) return "missing";
    if (main.owner.type !== "task") {
      throw new Error(`Task main workspace ownership is invalid: ${task.id}.`);
    }
    return this.#inspectEntries(task.id, MAIN_WORKTREE, main.entries);
  }

  async cleanupTaskForArchive(taskId: string): Promise<TaskWorkspaceCleanup> {
    const task = requireTask(this.store, taskId);
    const isolated = this.store.listManagedWorkspaces(task.id)
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
    const main = this.store.getTaskWorkspace(task.id);
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

  #reviewRoundWorkspaceRoot(taskId: string, reviewRoundId: string): string {
    return join(resolveTaskRoot(this.home, this.store.getConfig().defaultWorkspace),
      safePathSegment(taskId), "review-rounds", safePathSegment(reviewRoundId));
  }

  #fallbackWorkspace(): string {
    return this.store.getConfig().defaultWorkspace ?? process.cwd();
  }

  async #discardUnadoptedEntries(
    task: Task,
    prepared: readonly Readonly<{ project: Project; entry: WorkspaceProjectEntry }>[],
    roleName: string,
    deleteBranch = false,
    adoptedPaths = new Set(this.store.listManagedWorkspaces(task.id)
      .flatMap((workspace) => workspace.entries.map(({ path }) => path)))
  ): Promise<void> {
    for (const { project, entry } of prepared.filter(
      ({ entry }) => entry.access === "write" && !adoptedPaths.has(entry.path)
    )) {
      const removal = await this.git.removeWorktree({
        repositoryPath: project.path,
        container: this.#projectContainer(project.name),
        taskId: task.id,
        roleName,
        ...(deleteBranch ? { deleteBranch: true } : {})
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
    workspace: ManagedWorkspace,
    fallback: string,
    workItem?: Readonly<{
      workItemId: string;
      disposition: WorkItemWorkspaceDisposition;
    }>
  ): void {
    this.store.transaction((tx) => {
      const current = tx.listManagedWorkspaces(task.id)
        .find((entry) => managedWorkspaceKey(entry.owner) === managedWorkspaceKey(workspace.owner))
        ?? null;
      if (current === null || !sameManagedWorkspace(current, workspace)) {
        if (workItem === undefined) {
          throw new Error(`Managed workspace changed before cleanup was recorded: ${
            task.id
          }/${managedWorkspaceKey(workspace.owner)}.`);
        }
        recordWorkspaceDisposition(tx, task.id, workItem, this.now());
        return;
      }
      const roleName = workspace.owner.type === "work-item"
        ? tx.getWorkItem(task.id, workspace.owner.workItemId)?.assignee
        : workspace.owner.type === "task" ? LEADER_ROLE : undefined;
      const role = roleName === undefined ? null : tx.getRole(task.id, roleName);
      tx.removeManagedWorkspace(workspace.owner);
      const main = tx.getTaskWorkspace(task.id);
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

function requireWorkItem(store: TaskStore, workItemId: string): WorkItem {
  const item = store.findWorkItem(workItemId);
  if (item === null) throw new Error(`Work item not found: ${workItemId}.`);
  return item;
}

function requireWorkspaceEntry(
  workspace: ManagedWorkspace,
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
  if (["completed", "failed", "cancelled", "superseded"].includes(item.status)) {
    throw new Error(`Work item is already terminal: ${item.id}.`);
  }
  const activeDevelopRun = store.listAgentRuns(task.id)
    .find((run) => run.status === "active" && run.workItemId === item.id);
  if (activeDevelopRun !== undefined) {
    throw new Error(`Work Item already has an active Develop Run: ${activeDevelopRun.id}.`);
  }
  if (item.assignee !== undefined && store.getActiveAgentRun(task.id, item.assignee) !== null) {
    throw new Error(`Role has an active Run: ${task.id}/${item.assignee}.`);
  }
}

function assertWorkItemOwnsWorkspace(item: WorkItem, workspace: ManagedWorkspace): void {
  if (workspace.owner.type !== "work-item" || workspace.owner.workItemId !== item.id) {
    throw new Error(`WorkItem does not own the managed workspace: ${item.id}.`);
  }
}

function preserveWorkspaceCreatedAt(
  workspace: ManagedWorkspace,
  previous: ManagedWorkspace | null
): ManagedWorkspace {
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

function sameManagedWorkspace(left: ManagedWorkspace, right: ManagedWorkspace): boolean {
  return isDeepStrictEqual(left, right);
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
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

function sameCommit(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
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
