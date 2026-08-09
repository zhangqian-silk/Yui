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
import {
  attachReviewRoundWorkspace,
  recordReviewWorkspaceDisposition
} from "../review/reviewRound.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
import {
  createCandidateGitSnapshot,
  recordWorkItemWorkspaceDisposition,
  type CandidateGitSnapshot,
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
  reason?: string;
  resource?: string;
  retryable?: boolean;
}>;

export class WorkspaceCleanupBlockedError extends Error {
  constructor(
    readonly reason: string,
    readonly resource: string,
    readonly retryable: boolean,
    message: string
  ) {
    super(message);
    this.name = "WorkspaceCleanupBlockedError";
  }
}

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
              && !["completed", "failed", "retired"]
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

  async snapshotCandidateWorkspace(workspace: ManagedWorkspace): Promise<CandidateGitSnapshot> {
    if (workspace.owner.type === "review-round") {
      throw new Error("ReviewRound workspace cannot become a WorkItem Candidate source.");
    }
    if (workspace.owner.type !== "work-item") {
      throw new Error("Only a WorkItem workspace can become a Candidate source.");
    }
    const projects = [];
    for (const entry of workspace.entries) {
      if (!await this.git.isClean(entry.path)) {
        throw new Error(
          `Candidate Project workspace must be clean and committed before review: ${entry.projectId}.`
        );
      }
      const branch = await this.git.headRef(entry.path);
      if (branch !== entry.branch) {
        throw new Error(
          `Candidate Project workspace left its managed branch: ${entry.projectId}/${branch}.`
        );
      }
      projects.push({
        projectId: entry.projectId,
        commit: (await this.git.inspect(entry.path, "HEAD")).baseCommit
      });
    }
    return createCandidateGitSnapshot(workspace, projects);
  }

  async prepareWorkItemWorkspace(
    taskId: string,
    workItemId: string
  ): Promise<ManagedWorkspace> {
    const item = requireWorkItem(this.store, taskId, workItemId);
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

  async inspectWorkItemWorkspace(
    taskId: string,
    workItemId: string
  ): Promise<GitWorkspaceState> {
    const item = requireWorkItem(this.store, taskId, workItemId);
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
  async prepareReviewRoundWorkspace(
    taskId: string,
    reviewRoundId: string
  ): Promise<ManagedWorkspace> {
    const task = requireTask(this.store, taskId);
    const round = this.store.getReviewRound(task.id, reviewRoundId);
    if (round === null) throw new Error(`ReviewRound not found: ${task.id}/${reviewRoundId}.`);
    if (round.status !== "pending") {
      throw new Error(`ReviewRound workspace can only prepare while pending: ${round.id}.`);
    }
    const item = requireWorkItem(this.store, task.id, round.workItemId);
    const candidate = item.candidates.find(({ id }) => id === round.candidateId);
    if (candidate === undefined) {
      throw new Error(`ReviewRound Candidate not found: ${round.candidateId}.`);
    }
    const taskScope = (round.scope ?? "work-item") === "task";
    // A WorkItem ReviewRound is an immutable snapshot of Develop. A Task
    // ReviewRound intentionally uses the latest committed Integration heads
    // instead, while retaining the WorkItem/Candidate anchor for storage and
    // lifecycle compatibility.
    const develop = candidate.workspace;
    if (!taskScope && (develop === undefined || candidate.gitSnapshot === undefined)) {
      throw new Error(`Candidate has no frozen managed Git snapshot: ${candidate.id}.`);
    }
    if (!taskScope && candidate.gitSnapshot!.reviewBaseCommit !== round.reviewBaseCommit) {
      throw new Error(`ReviewRound base no longer matches its Candidate: ${round.id}.`);
    }
    const reviewer = this.store.getRole(task.id, round.reviewerRoleName);
    if (reviewer === null) {
      throw new Error(`Reviewer Role not found: ${task.id}/${round.reviewerRoleName}.`);
    }
    const snapshotCommits = new Map(
      (taskScope
        ? round.taskCandidate?.projects ?? []
        : candidate.gitSnapshot!.projects
      ).map(({ projectId, commit }) => [projectId, commit])
    );
    const frozenEntries = taskScope
      ? task.projectBindings.map((binding) => {
          const commit = snapshotCommits.get(binding.projectId);
          if (commit === undefined) {
            throw new Error(`Task Review candidate Project is missing: ${binding.projectId}.`);
          }
          const project = requireProject(this.store, binding.projectId);
          const identity = worktreeIdentity(task.id, round.id);
          return {
            projectId: binding.projectId,
            directory: binding.directory,
            access: "write" as const,
            path: join(this.#projectContainer(project.name), identity.directory),
            branch: identity.branch,
            baseRef: commit,
            baseCommit: commit
          };
        })
      : develop!.entries.map((entry) => {
          const commit = snapshotCommits.get(entry.projectId);
          if (commit === undefined) {
            throw new Error(`Candidate snapshot Project is missing: ${entry.projectId}.`);
          }
          return { ...entry, baseRef: commit, baseCommit: commit };
        });
    if (taskScope && snapshotCommits.size !== task.projectBindings.length) {
      throw new Error(`Task Review candidate Project scope changed: ${round.id}.`);
    }
    const expectedEntries = new Map(
      frozenEntries.map((entry) => [entry.projectId, entry] as const)
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
        if (round.workspace !== undefined && !isDeepStrictEqual(round.workspace, existing)) {
          throw new Error(`ReviewRound workspace record diverged: ${round.id}.`);
        }
        if (round.workspace === undefined) {
          this.store.saveReviewRound(task.id, attachReviewRoundWorkspace(round, existing));
        }
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
        ? frozenEntries.filter((source) => missing.has(source.projectId))
        : frozenEntries;
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
        ? frozenEntries.map((source) => {
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
      return this.store.transaction((tx) => {
        const currentRound = tx.getReviewRound(task.id, round.id);
        const currentItem = tx.getWorkItem(task.id, item.id);
        if (currentRound === null || currentRound.status !== "pending"
          || currentItem === null
          || !isDeepStrictEqual(
            currentItem.candidates.find(({ id }) => id === candidate.id),
            candidate
          )) {
          throw new Error(`ReviewRound changed while preparing its workspace: ${round.id}.`);
        }
        if (tx.getActiveAgentRun(task.id, reviewer.name) !== null) {
          throw new Error(`Reviewer Role has an active Run: ${task.id}/${reviewer.name}.`);
        }
        const currentWorkspace = tx.getReviewRoundWorkspace(task.id, round.id);
        if (currentWorkspace !== null
          && !sameManagedWorkspace(currentWorkspace, existing ?? stored)) {
          throw new Error(`ReviewRound workspace changed: ${task.id}/${round.id}.`);
        }
        const latestReviewer = tx.getRole(task.id, reviewer.name);
        if (latestReviewer === null) {
          throw new Error(`Reviewer Role not found: ${task.id}/${reviewer.name}.`);
        }
        const timestamp = this.now();
        tx.saveManagedWorkspace(stored);
        tx.saveReviewRound(task.id, attachReviewRoundWorkspace(currentRound, stored));
        if (latestReviewer.workspace !== stored.root) {
          retireWorkspaceBoundSession(tx, task.id, latestReviewer.name, timestamp);
          tx.saveRole(task.id, updateRole(
            latestReviewer,
            { workspace: stored.root },
            timestamp
          ));
        }
        return stored;
      });
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

  async inspectReviewRoundWorkspace(
    taskId: string,
    reviewRoundId: string
  ): Promise<GitWorkspaceState> {
    const round = this.store.getReviewRound(taskId, reviewRoundId);
    if (round === null) throw new Error(`ReviewRound not found: ${taskId}/${reviewRoundId}.`);
    const workspace = this.store.getReviewRoundWorkspace(taskId, reviewRoundId);
    if (workspace === null) return "missing";
    assertReviewRoundOwnsWorkspace(round.id, workspace);
    if (round.workspace !== undefined && !isDeepStrictEqual(round.workspace, workspace)) {
      throw new Error(`ReviewRound workspace record diverged: ${round.id}.`);
    }
    return this.#inspectEntries(taskId, round.id, workspace.entries);
  }

  async snapshotReviewRoundResult(
    taskId: string,
    reviewRoundId: string
  ): Promise<Readonly<{ evidenceCommit?: string }>> {
    const round = this.store.getReviewRound(taskId, reviewRoundId);
    if (round === null) throw new Error(`ReviewRound not found: ${taskId}/${reviewRoundId}.`);
    const workspace = this.store.getReviewRoundWorkspace(taskId, reviewRoundId);
    if (round.status !== "running" || workspace === null) {
      throw new Error(`ReviewRound is not running in a managed workspace: ${reviewRoundId}.`);
    }
    assertReviewRoundOwnsWorkspace(round.id, workspace);
    if (round.workspace === undefined || !isDeepStrictEqual(round.workspace, workspace)) {
      throw new Error(`ReviewRound workspace record diverged: ${round.id}.`);
    }
    const changed: string[] = [];
    for (const entry of workspace.entries) {
      if (await this.git.headRef(entry.path) !== entry.branch) {
        throw new Error(
          `Review Project workspace left its managed branch: ${round.id}/${entry.projectId}.`
        );
      }
      const head = (await this.git.inspect(entry.path, "HEAD")).baseCommit;
      const project = requireProject(this.store, entry.projectId);
      if (!await this.git.isAncestor(project.path, entry.baseCommit, head)) {
        throw new Error(
          `ReviewRound workspace HEAD does not descend from its frozen base for `
          + `${round.id}/${entry.projectId}: expected ancestor ${entry.baseCommit}, `
          + `physical HEAD ${head}.`
        );
      }
      if (head !== entry.baseCommit) changed.push(head);
    }
    if (changed.length > 1) {
      throw new Error(
        `ReviewRound has diagnostic commits in multiple Projects; preserve it for Leader routing: ${round.id}.`
      );
    }
    return changed.length === 0 ? {} : { evidenceCommit: changed[0]! };
  }

  async cleanupReviewRoundWorkspace(
    taskId: string,
    reviewRoundId: string
  ): Promise<GitWorkspaceRemoval> {
    const task = requireTask(this.store, taskId);
    const round = this.store.getReviewRound(task.id, reviewRoundId);
    if (round === null) throw new Error(`ReviewRound not found: ${task.id}/${reviewRoundId}.`);
    if (round.status !== "completed" && round.status !== "failed") {
      throw new Error(`ReviewRound must be terminal before cleanup: ${round.id}.`);
    }
    if (round.workspaceDisposition?.kind === "removed") return "missing";
    const workspace = this.store.getReviewRoundWorkspace(task.id, round.id);
    if (workspace === null || round.workspace === undefined) {
      throw new Error(`ReviewRound has no managed workspace: ${round.id}.`);
    }
    assertReviewRoundOwnsWorkspace(round.id, workspace);
    if (!isDeepStrictEqual(round.workspace, workspace)) {
      throw new Error(`ReviewRound workspace record diverged: ${round.id}.`);
    }
    assertWorkspaceSessionsRetirable(
      this.store,
      task.id,
      round.reviewerRoleName,
      this.now()
    );
    if (await this.#inspectEntries(
      task.id,
      managedWorktreeName(workspace.owner),
      workspace.entries
    ) === "dirty") return "dirty";
    let removed = false;
    for (const entry of workspace.entries) {
      const project = requireProject(this.store, entry.projectId);
      const result = await this.git.removeWorktree({
        repositoryPath: project.path,
        container: this.#projectContainer(project.name),
        taskId: task.id,
        roleName: managedWorktreeName(workspace.owner),
        deleteBranch: true
      });
      if (result === "dirty") {
        throw new Error(`Review workspace changed after cleanup preflight: ${round.id}.`);
      }
      removed ||= result === "removed";
    }
    await removeWorkspaceView(workspace.root);
    this.store.transaction((tx) => {
      const currentRound = tx.getReviewRound(task.id, round.id);
      const currentWorkspace = tx.getReviewRoundWorkspace(task.id, round.id);
      if (currentRound === null || currentRound.status !== round.status
        || currentRound.workspace === undefined
        || !isDeepStrictEqual(currentRound.workspace, workspace)
        || currentWorkspace === null
        || !sameManagedWorkspace(currentWorkspace, workspace)) {
        throw new Error(`ReviewRound changed before cleanup was recorded: ${round.id}.`);
      }
      tx.removeManagedWorkspace(workspace.owner);
      tx.saveReviewRound(task.id, recordReviewWorkspaceDisposition(
        currentRound,
        "removed",
        this.now()
      ));
      const reviewer = tx.getRole(task.id, round.reviewerRoleName);
      if (reviewer !== null && reviewer.workspace === workspace.root) {
        const main = tx.getTaskWorkspace(task.id);
        const target = main?.root ?? this.#fallbackWorkspace();
        const timestamp = this.now();
        retireWorkspaceBoundSession(tx, task.id, reviewer.name, timestamp);
        tx.saveRole(task.id, updateRole(reviewer, { workspace: target }, timestamp));
      }
    });
    return removed ? "removed" : "missing";
  }

  async cleanupWorkItemWorkspace(
    taskId: string,
    workItemId: string,
    disposition: WorkItemWorkspaceDisposition
  ): Promise<GitWorkspaceRemoval> {
    const item = requireWorkItem(this.store, taskId, workItemId);
    const task = requireTask(this.store, item.taskId);
    if (!["completed", "failed", "retired"].includes(item.status)) {
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
    const main = this.store.getTaskWorkspace(task.id);
    if (main === null) return "missing";
    if (main.owner.type !== "task") {
      throw new Error(`Task main workspace ownership is invalid: ${task.id}.`);
    }
    return this.#inspectEntries(task.id, MAIN_WORKTREE, main.entries);
  }

  async cleanupTaskForArchive(taskId: string): Promise<TaskWorkspaceCleanup> {
    const task = requireTask(this.store, taskId);
    assertTaskArchiveState(task, task);
    const isolated = this.store.listManagedWorkspaces(task.id)
      .filter(({ owner }) => owner.type !== "task");
    if (isolated.length > 0) {
      return {
        taskId,
        status: "failed",
        ...(task.cwd === undefined ? {} : { path: task.cwd }),
        error: `Managed workspaces require explicit cleanup: ${
          isolated.map(({ owner }) => managedWorkspaceKey(owner)).join(", ")
        }.`
      };
    }
    const main = this.store.getTaskWorkspace(task.id);
    if (main !== null) {
      assertTaskArchiveState(requireTask(this.store, task.id), task);
      if (await this.#inspectEntries(task.id, MAIN_WORKTREE, main.entries) === "dirty") {
        return {
          taskId,
          status: "retained-dirty",
          ...(task.cwd === undefined ? {} : { path: task.cwd })
        };
      }
      for (const entry of main.entries) {
        assertTaskArchiveState(requireTask(this.store, task.id), task);
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
      assertTaskArchiveState(requireTask(this.store, task.id), task);
      await removeWorkspaceView(main.root);
      assertTaskArchiveState(requireTask(this.store, task.id), task);
      this.#recordWorkspaceRemoval(task, main, this.#fallbackWorkspace());
    }
    this.#clearTaskWorkspace(task, this.#fallbackWorkspace());
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
      safePathSegment(taskId), "reviews", safePathSegment(reviewRoundId));
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
      if (workspace.owner.type === "task") {
        assertTaskArchiveState(requireTask(tx, task.id), task);
      }
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
      assertTaskArchiveState(latest, task);
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

function assertTaskArchiveState(current: Task, expected: Task): void {
  if ((current.status !== "completed" && current.status !== "retired")
    || !isDeepStrictEqual(current, expected)) {
    throw new WorkspaceCleanupBlockedError(
      "task-changed",
      `task:${expected.id}`,
      true,
      `Task changed during archive cleanup: ${expected.id}.`
    );
  }
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
  if (["completed", "failed", "retired"].includes(item.status)) {
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

function assertReviewRoundOwnsWorkspace(
  reviewRoundId: string,
  workspace: ManagedWorkspace
): void {
  if (workspace.owner.type !== "review-round"
    || workspace.owner.reviewRoundId !== reviewRoundId) {
    throw new Error(`ReviewRound does not own the Role workspace: ${reviewRoundId}.`);
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
