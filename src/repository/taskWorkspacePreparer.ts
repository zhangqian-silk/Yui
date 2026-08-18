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
import { updateRole, type TaskRole } from "../role/role.js";
import {
  hasRuntimeCleanupObligation,
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import {
  attachReviewRoundWorkspace,
  recordReviewWorkspaceDisposition
} from "../review/reviewRound.js";
import { StorageConflictError, type TaskStore } from "../storage/taskStore.js";
import {
  bindTaskWorkspaceIdentity,
  type Task
} from "../task/task.js";
import {
  createCandidateGitSnapshot,
  createDirectTaskMainSnapshot,
  workItemExecutionGroupById,
  currentWorkItemExecutionGroup,
  recordWorkItemWorkspaceDisposition,
  type CandidateGitSnapshot,
  type DirectTaskMainSnapshot,
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
import type { ExecutionLaneGitSnapshot } from "../execution/executionGroup.js";
import type { AgentRun } from "../run/agentRun.js";
import { formatAgentRunReceiptId } from "../task/taskRecordReference.js";
import {
  NodeGitWorkspace,
  worktreeIdentity,
  type GitWorkspacePort,
  type GitWorkspaceRemoval,
  type GitWorkspaceState
} from "./gitWorkspace.js";
import type { Project } from "./project.js";
import { acquireProjectMaintenanceLocks } from "./projectMaintenanceLock.js";
import {
  generateTaskWorkspaceIdentity,
  isLegacyTaskRef,
  taskArchiveRef,
  taskMainBranch,
  taskWorkspaceRefSegment,
  taskWorkspaceRefSegmentFromIdentity,
  TASK_WORKSPACE_TOKEN_PATTERN,
  validateTaskWorkspaceIdentity,
  type TaskWorkspaceIdentity
} from "./taskWorkspaceIdentity.js";
import { ResourceRegistrar } from "../resources/resourceRegistrar.js";

const MAIN_WORKTREE = "main";
const LEADER_ROLE = "leader";
/**
 * Bound for prepare attempts after a lost identity race or a storage
 * revision conflict. Each conflict already discarded the attempt's refs, so
 * retrying converges with the committed state; the bound stops a persistent
 * competitor from pinning this caller forever.
 */
const TASK_WORKSPACE_PREPARE_MAX_CONFLICT_RETRIES = 3;

type TaskWorkspaceBaseline = Readonly<{
  baseRef: string;
  recordedBaseRef: string;
  expectedCommit?: string;
  pinTask?: boolean;
}>;

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

export type TaskWorkspaceRebuildResult = Readonly<{
  task: Task;
  /** `<projectId>:<sourceRef>` pairs archived during this invocation. */
  archived: readonly string[];
  /** True when the Task already owned an identity and only cleanup resumed. */
  resumed: boolean;
}>;

export type LegacyTaskRef = Readonly<{
  projectId: string;
  taskId: string;
  ref: string;
}>;

export type LegacyTaskRefArchiveResult = Readonly<{
  archived: readonly string[];
  refused: readonly string[];
}>;

type LegacyRefArchiveTarget = Readonly<{
  project: Project;
  taskId: string;
  ref: string;
  archiveRef: string;
}>;

export type PreparedExecutionLane = Readonly<{
  workspace: ManagedWorkspace;
  persisted: boolean;
}>;

export type ExecutionGroupCandidateMaterialization = Readonly<{
  workspace?: ManagedWorkspace;
  snapshot?: CandidateGitSnapshot;
  restoreTargets: readonly Readonly<{
    path: string;
    head: string;
    mergedHead: string;
  }>[];
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

/** Existing ReviewRound workspace evidence must never be replaced during recovery. */
export class ReviewRoundWorkspaceEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewRoundWorkspaceEvidenceError";
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

  #resourceRegistrarValue: ResourceRegistrar | undefined;

  #resourceRegistrar(): ResourceRegistrar {
    return this.#resourceRegistrarValue ??= new ResourceRegistrar(this.home, this.now);
  }

  #registerWorkspace(workspace: ManagedWorkspace): void {
    this.#resourceRegistrar().registerManagedWorkspace(workspace);
  }

  async prepareTaskWorkspace(taskId: string): Promise<TaskWorkspacePreparation> {
    // The per-Project maintenance fence makes prepare mutually exclusive with
    // migrate/rebuild/archive: a concurrent migration must not switch the
    // Project catalog to the Home-managed repo while prepare is creating
    // worktrees from the old external checkout. The fence is acquired on
    // every conflict retry so the locked set always covers the Task's
    // current bindings. Gitless Tasks hold no fence. The Controller's
    // check-then-call probe is kept for scheduling deferral; the fence here
    // makes the prepare itself safe regardless.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const task = requireTask(this.store, taskId);
        const { release, current } = this.#acquireTaskProjectMaintenanceLocks(task);
        try {
          return await this.#prepareTaskWorkspaceLocked(current.id);
        } finally {
          release();
        }
      } catch (error) {
        if (error instanceof StorageConflictError
          && attempt < TASK_WORKSPACE_PREPARE_MAX_CONFLICT_RETRIES) {
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Acquire the per-Project maintenance fences for every Project bound to a
   * Task, then re-read the Task under those fences and prove its binding set
   * is still the one the fences cover. Gitless Tasks hold no fence.
   *
   * The returned Task is the fresh under-lock snapshot; callers MUST use it
   * (not the pre-lock snapshot) for every Project read and Git effect. A
   * binding-set change rides the StorageConflictError retry channel so the
   * caller re-reads the Task and re-acquires the correct fence set. The
   * caller owns `release` and MUST call it on every exit path.
   */
  #acquireTaskProjectMaintenanceLocks(task: Task): Readonly<{
    release: () => void;
    current: Task;
  }> {
    const projectIds = task.projectBindings.map(({ projectId }) => projectId);
    const release = projectIds.length === 0
      ? () => {}
      : acquireProjectMaintenanceLocks(this.home, projectIds);
    try {
      const current = requireTask(this.store, task.id);
      const currentIds = current.projectBindings.map(({ projectId }) => projectId).sort();
      const lockedIds = [...projectIds].sort();
      if (currentIds.length !== lockedIds.length
        || currentIds.some((id, index) => id !== lockedIds[index])) {
        throw new StorageConflictError(
          `Task Project bindings changed while its workspace fence was acquired: ${task.id}.`
        );
      }
      return { release, current };
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Acquire the per-Project maintenance fences for a Task's bindings and
   * return the under-lock Task snapshot plus the release handle. Used by the
   * dispatch preflight to hold ONE fence across new-Lane preparation and the
   * command's adoption transaction, so a migrate cannot switch the Project
   * catalog in that gap. The caller owns `release` and must call it on every
   * exit path.
   */
  acquireTaskProjectMaintenanceLocks(taskId: string): Readonly<{
    release: () => void;
    current: Task;
  }> {
    return this.#acquireTaskProjectMaintenanceLocks(requireTask(this.store, taskId));
  }

  async #prepareTaskWorkspaceLocked(taskId: string): Promise<TaskWorkspacePreparation> {
    const task = requireTask(this.store, taskId);
    if (!["draft", "active"].includes(task.status)) {
      throw new Error(`Task is not open for workspace preparation: ${task.id}.`);
    }
    if (task.projectBindings.length === 0) {
      const existing = this.store.getTaskWorkspace(task.id);
      const root = this.#taskWorkspaceRoot(task.id);
      if (existing !== null && (
        existing.owner.type !== "task"
        || existing.owner.taskId !== task.id
        || existing.root !== root
        || existing.entries.length !== 0
      )) {
        throw new Error(`Gitless Task workspace ownership is invalid: ${task.id}.`);
      }
      // Gitless Tasks still need a durable runtime owner. The empty view is
      // Task-specific, so launches cannot fall back to a global workspace or
      // repository root while no Project is bound.
      await ensureWorkspaceView(root, []);
      const workspace = createManagedWorkspace({
        owner: { type: "task", taskId: task.id },
        root,
        entries: []
      }, this.now());
      this.#registerWorkspace(workspace);
      this.store.transaction((tx) => {
        const latest = requireTask(tx, task.id);
        if (!['draft', 'active'].includes(latest.status)
          || latest.projectBindings.length !== 0) {
          throw new Error(`Task changed while preparing its Gitless workspace: ${task.id}.`);
        }
        const current = tx.getTaskWorkspace(task.id);
        // `createManagedWorkspace` stamps a fresh updatedAt on every call.
        // Gitless preparation is idempotent, so compare only stable identity
        // and retain the existing durable record verbatim.
        if (current !== null && !sameManagedWorkspaceIdentity(current, workspace)) {
          throw new Error(`Gitless Task workspace changed during preparation: ${task.id}.`);
        }
        const timestamp = this.now();
        if (latest.cwd !== root) {
          tx.saveTask({ ...latest, cwd: root, updatedAt: timestamp.toISOString() });
        }
        if (current === null) tx.saveManagedWorkspace(workspace);
        for (const role of tx.listRoles(task.id)) {
          if (role.workspace !== root) {
            retireWorkspaceBoundSession(tx, task.id, role.name, timestamp);
            tx.saveRole(task.id, updateRole(role, { workspace: root }, timestamp));
          }
        }
      });
      return { taskId, status: "ready", path: root };
    }
    const existing = this.store.getTaskWorkspace(task.id);
    if (existing !== null && existing.owner.type !== "task") {
      throw new Error(`Task main workspace ownership is invalid: ${task.id}.`);
    }

    // The durable workspace identity is minted once, only for a Task that has
    // never owned a managed Git workspace. A Task with an existing workspace
    // record predates the identity (legacy) and keeps its refs until the
    // controlled rebuild; a second prepare reuses the persisted identity.
    const workspaceIdentity = task.workspaceIdentity === undefined
      && (existing === null || existing.entries.length === 0)
      ? await this.#mintTaskWorkspaceIdentity(task)
      : undefined;
    const taskSegment = taskWorkspaceRefSegment(
      workspaceIdentity === undefined ? task : { ...task, workspaceIdentity }
    );

    const root = this.#taskWorkspaceRoot(task.id);
    const prepared: Array<Readonly<{ project: Project; entry: WorkspaceProjectEntry }>> = [];
    const defaultProjects = remoteDefaultProjects(this.store, task.id);
    const baselines = new Map<string, TaskWorkspaceBaseline>();
    try {
      // Resolve every first-use baseline before creating any managed worktree.
      // A later Project failure therefore cannot leave an earlier Project's
      // workspace behind, and the Task can only be pinned after all evidence
      // has been gathered successfully.
      for (const binding of task.projectBindings) {
        const project = requireProject(this.store, binding.projectId);
        const previous = existing?.entries.find(({ projectId }) => projectId === project.id);
        if (previous !== undefined) {
          baselines.set(project.id, {
            baseRef: previous.baseCommit,
            recordedBaseRef: previous.baseRef
          });
          continue;
        }
        const useRemoteDefault = defaultProjects.has(project.id)
          && project.remoteUrl !== undefined
          && !looksLikeCommit(binding.baseRef);
        if (useRemoteDefault) {
          const resolver = this.git.resolveRemoteBaseline;
          if (typeof resolver !== "function") {
            throw new Error(
              `Git workspace cannot resolve the remote baseline for Project: ${project.id}.`
            );
          }
          const remote = await resolver.call(this.git, {
            repositoryPath: project.path,
            remoteUrl: project.remoteUrl,
            // The binding captured the configured development ref at Task
            // creation; use that snapshot even if the Project catalog was
            // edited before this first workspace preparation.
            developmentRef: binding.baseRef
          });
          baselines.set(project.id, {
            baseRef: remote.commit,
            recordedBaseRef: remote.commit,
            expectedCommit: remote.commit,
            pinTask: true
          });
          continue;
        }
        // Validate local and explicit refs in the same preflight phase.  This
        // preserves the fail-closed boundary before any worktree is created.
        await this.git.inspect(project.path, binding.baseRef);
        baselines.set(project.id, {
          baseRef: binding.baseRef,
          recordedBaseRef: binding.baseRef
        });
      }
      for (const binding of task.projectBindings) {
        const project = requireProject(this.store, binding.projectId);
        const previous = existing?.entries.find(({ projectId }) => projectId === project.id);
        const baseline = baselines.get(project.id);
        if (baseline === undefined) {
          throw new Error(`Task Project baseline was not resolved: ${project.id}.`);
        }
        const physical = await this.git.ensureWorktree({
          repositoryPath: project.path,
          container: this.#projectContainer(project.name),
          taskSegment,
          roleName: MAIN_WORKTREE,
          baseRef: previous?.baseCommit ?? baseline.baseRef
        });
        if (baseline.expectedCommit !== undefined
          && physical.baseCommit !== baseline.expectedCommit) {
          throw new Error(
            `Task Project workspace did not start at the fetched remote baseline: ${project.id}.`
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
            baseRef: previous?.baseRef ?? baseline.recordedBaseRef,
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
      this.#registerWorkspace(workspace);
      this.store.transaction((tx) => {
        const latest = requireTask(tx, task.id);
        if (!["draft", "active"].includes(latest.status)) {
          throw new Error(`Task changed while preparing its workspace: ${task.id}.`);
        }
        if (!isDeepStrictEqual(latest.projectBindings, task.projectBindings)) {
          throw new Error(`Task Projects changed while preparing its workspace: ${task.id}.`);
        }
        // Revalidate the Project catalog path after acquiring the fence: a
        // concurrent migration must not leave a persisted worktree whose Git
        // common dir is the old external checkout. A changed path rides the
        // StorageConflictError retry channel so the retry re-reads the catalog
        // and prepares against the current (Home-managed) repository.
        for (const { project } of prepared) {
          const latestProject = requireProject(tx, project.id);
          if (latestProject.path !== project.path) {
            throw new StorageConflictError(
              `Project path changed while preparing its workspace: ${project.id}.`
            );
          }
        }
        const current = tx.getTaskWorkspace(task.id);
        if (current !== null && current.owner.type !== "task") {
          throw new Error(`Task main workspace ownership is invalid: ${task.id}.`);
        }
        // Single-writer CAS, mirroring the rebuild guard: this attempt only
        // commits while the Task is still unbound (or carries the identity it
        // started with). A concurrent prepare or rebuild that bound a
        // different identity wins; this attempt discards its refs and retries
        // through the StorageConflictError channel.
        if (workspaceIdentity !== undefined
          && latest.workspaceIdentity !== undefined
          && !isDeepStrictEqual(
            validateTaskWorkspaceIdentity(latest.workspaceIdentity),
            workspaceIdentity
          )) {
          throw new StorageConflictError(
            `Task workspace identity changed while preparing its workspace: ${task.id}.`
          );
        }
        if (current === null
          ? existing !== null
          : existing === null || !sameManagedWorkspace(current, existing)) {
          throw new StorageConflictError(
            `Task workspace changed while preparing its workspace: ${task.id}.`
          );
        }
        const pinnedBindings = latest.projectBindings.map((binding) => {
          const baseline = baselines.get(binding.projectId);
          return baseline?.pinTask === true
            ? { ...binding, baseRef: baseline.baseRef }
            : binding;
        });
        const timestamp = this.now();
        let persistedTask = isDeepStrictEqual(pinnedBindings, latest.projectBindings)
          ? latest
          : { ...latest, projectBindings: pinnedBindings, updatedAt: timestamp.toISOString() };
        if (workspaceIdentity !== undefined) {
          // The identity is persisted only now that every managed ref was
          // created successfully. A concurrent prepare that bound the same
          // identity is a no-op; a different one fails closed.
          persistedTask = bindTaskWorkspaceIdentity(persistedTask, workspaceIdentity, timestamp);
        }
        if (persistedTask.cwd !== root) {
          persistedTask = { ...persistedTask, cwd: root, updatedAt: timestamp.toISOString() };
        }
        if (!isDeepStrictEqual(persistedTask, latest)) {
          tx.saveTask(persistedTask);
        }
        tx.saveManagedWorkspace(preserveWorkspaceCreatedAt(workspace, current));
        for (const role of tx.listRoles(task.id)) {
          // The Role field is only a cwd/snapshot hint.  Preserve the hint for
          // an active WorkItem assignment; the durable owner is the WorkItem,
          // not this Role record.  Other Roles use Task main.
          // Prefer the active Run's exact WorkItem for this Role; fall back
          // to the first queued WorkItem only when no active Run owns the Role.
          const activeRoleRun = tx.getActiveAgentRun(task.id, role.name);
          const activeRunItem = activeRoleRun !== null
            && activeRoleRun.purpose === "execution"
            && activeRoleRun.workItemId !== undefined
            ? tx.getWorkItem(task.id, activeRoleRun.workItemId)
            : null;
          const assignedItem = activeRunItem !== null
            && activeRunItem.assignee === role.name
            && !["completed", "failed", "retired"].includes(activeRunItem.status)
            ? activeRunItem
            : tx.listWorkItems(task.id).find((candidate) => (
              candidate.assignee === role.name
                && !["completed", "failed", "retired"]
                  .includes(candidate.status)
            ));
          const assignedWorkspace = assignedItem === undefined
            ? null
            : tx.getWorkItemWorkspace(task.id, assignedItem.id);
          const target = assignedWorkspace?.root ?? root;
          if (role.workspace !== target) {
            if (
              assignedItem === undefined
              || assignedWorkspace === null
              || !canCorrectActiveWorkItemRoleWorkspaceHint(
                tx,
                task.id,
                role,
                assignedItem,
                assignedWorkspace
              )
            ) {
              retireWorkspaceBoundSession(tx, task.id, role.name, timestamp);
            }
            tx.saveRole(task.id, updateRole(role, { workspace: target }, timestamp));
          }
        }
      });
      return { taskId, status: "ready", path: root };
    } catch (error) {
      // A failed or conflicted preparation owns no durable record: drop the
      // branches too, so a retry mints a clean identity without half-created
      // refs behind. Adopted (already catalogued) worktrees are never touched.
      await this.#discardUnadoptedEntries(task, taskSegment, prepared, MAIN_WORKTREE, true);
      throw error;
    }
  }

  /**
   * The conflict-retry loop for a Task-main prepare, run with the caller's
   * fences already held. A lost identity/workspace CAS retries safely under
   * the same fence set; a binding-set change makes that fence set stale, so
   * the conflict is rethrown and only the caller (which can re-acquire) may
   * retry it.
   */
  async #prepareTaskWorkspaceWithRetries(
    taskId: string,
    lockedProjectIds: readonly string[]
  ): Promise<TaskWorkspacePreparation> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#prepareTaskWorkspaceLocked(taskId);
      } catch (error) {
        if (!(error instanceof StorageConflictError)
          || attempt >= TASK_WORKSPACE_PREPARE_MAX_CONFLICT_RETRIES) {
          throw error;
        }
        const current = requireTask(this.store, taskId);
        const currentIds = current.projectBindings.map(({ projectId }) => projectId).sort();
        const locked = [...lockedProjectIds].sort();
        if (currentIds.length !== locked.length
          || currentIds.some((id, index) => id !== locked[index])) {
          throw error;
        }
      }
    }
  }

  /**
   * Mint the Task's durable workspace identity with create-not-exists
   * semantics: the candidate main branch must not already exist in any bound
   * Project repository. On conflict (a stale ref from a crashed attempt, or
   * another Home's work) a fresh identity is generated; only an identity whose
   * refs were actually created is ever persisted.
   */
  async #mintTaskWorkspaceIdentity(task: Task): Promise<TaskWorkspaceIdentity> {
    const home = this.store.getHomeIdentity();
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const identity = generateTaskWorkspaceIdentity({
        home,
        taskId: task.id,
        now: this.now()
      });
      const mainBranch = taskMainBranch(taskWorkspaceRefSegmentFromIdentity(identity));
      let conflict = false;
      for (const binding of task.projectBindings) {
        const project = requireProject(this.store, binding.projectId);
        if (await this.git.refExists(project.path, mainBranch)) {
          conflict = true;
          break;
        }
      }
      if (!conflict) return identity;
    }
    throw new Error(`Could not mint a unique Task workspace identity for ${task.id}.`);
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

  /** Freeze every writable Project head from the exact managed Lane workspace. */
  async snapshotExecutionLaneWorkspace(
    workspace: ManagedWorkspace
  ): Promise<ExecutionLaneGitSnapshot | undefined> {
    if (workspace.owner.type !== "execution-lane"
      && workspace.owner.type !== "work-item"
      && workspace.owner.type !== "review-round") {
      throw new Error("Only a managed execution workspace can freeze Lane output.");
    }
    const stored = this.store.getManagedWorkspace(workspace.owner);
    if (stored === null || !isDeepStrictEqual(stored, workspace)) {
      throw new Error("Execution Lane managed workspace is not the durable owner.");
    }
    const writable = workspace.entries.filter(({ access }) => access === "write");
    // Read-only and Gitless Lanes still have a normal terminal lifecycle, but
    // they have no Git output boundary to freeze.  Keep the result absent
    // instead of inventing a snapshot from context-only worktrees.
    if (writable.length === 0) return undefined;
    const projects = [];
    for (const entry of writable) {
      if (!await this.git.isClean(entry.path)) {
        throw new Error(`Execution Lane Project workspace is dirty: ${entry.projectId}.`);
      }
      const branch = await this.git.headRef(entry.path);
      if (branch !== entry.branch) {
        throw new Error(
          `Execution Lane Project workspace left its managed branch: ${entry.projectId}/${branch}.`
        );
      }
      projects.push({
        projectId: entry.projectId,
        headCommit: (await this.git.inspect(entry.path, "HEAD")).baseCommit,
        branch
      });
    }
    return { schemaVersion: 1, projects };
  }

  async snapshotDirectTaskMain(
    workspace: ManagedWorkspace,
    projectIds: readonly string[]
  ): Promise<DirectTaskMainSnapshot> {
    if (workspace.owner.type !== "task") {
      throw new Error("Only Task main can become a direct Candidate source.");
    }
    const selected = new Set(projectIds);
    const entries = workspace.entries.filter(({ projectId }) => selected.has(projectId));
    if (entries.length !== selected.size) {
      throw new Error("Direct Candidate Project scope does not match Task main.");
    }
    const projects = [];
    for (const entry of entries) {
      if (entry.access !== "write") {
        throw new Error(`Direct Candidate Project is not writable: ${entry.projectId}.`);
      }
      if (!await this.git.isClean(entry.path)) {
        throw new Error(
          `Direct Candidate Task main must be clean and committed: ${entry.projectId}.`
        );
      }
      const branch = await this.git.headRef(entry.path);
      if (branch !== entry.branch) {
        throw new Error(
          `Direct Candidate Task main left its managed branch: ${entry.projectId}/${branch}.`
        );
      }
      const headCommit = (await this.git.inspect(entry.path, "HEAD")).baseCommit;
      if (!await this.git.isAncestor(entry.path, entry.baseCommit, headCommit)) {
        throw new Error(
          `Direct Candidate Task main does not descend from its recorded base: ${entry.projectId}.`
        );
      }
      projects.push({ projectId: entry.projectId, headCommit });
    }
    return createDirectTaskMainSnapshot(workspace, projectIds, projects);
  }

  async prepareWorkItemWorkspace(
    taskId: string,
    workItemId: string
  ): Promise<ManagedWorkspace> {
    const item = requireWorkItem(this.store, taskId, workItemId);
    const task = requireTask(this.store, item.taskId);
    assertWorkItemWorkspaceEligible(this.store, task, item);
    // Hold the per-Project maintenance fence across the ensure-main-prepared
    // and the WorkItem worktree creation, so a concurrent migrate/rebuild
    // cannot switch the Project catalog between the two. The under-lock Task
    // snapshot drives every Project read and Git effect below.
    const { release, current: lockedTask } = this.#acquireTaskProjectMaintenanceLocks(task);
    try {
      const lockedProjectIds = lockedTask.projectBindings.map(({ projectId }) => projectId);
      await this.#prepareTaskWorkspaceWithRetries(lockedTask.id, lockedProjectIds);
      // prepareTaskWorkspace may have just minted and persisted the workspace
      // identity; derive the segment from the persisted Task.
      const taskSegment = this.#taskSegment(requireTask(this.store, lockedTask.id));
      const main = this.store.getTaskWorkspace(lockedTask.id);
      if (main === null || main.owner.type !== "task") {
        throw new Error(`Task main workspace is not ready: ${lockedTask.id}.`);
      }
      const existing = this.store.getWorkItemWorkspace(lockedTask.id, item.id);
      if (existing !== null && (
        existing.owner.type !== "work-item"
        || existing.owner.workItemId !== item.id
      )) {
        throw new Error(`WorkItem workspace owner is invalid: ${lockedTask.id}/${item.id}.`);
      }
      if (item.assignee !== undefined) {
        assertWorkspaceSessionsRetirable(this.store, lockedTask.id, item.assignee, this.now());
      }

      const writeProjects = new Set(item.writeProjectIds);
      const boundProjects = new Set(lockedTask.projectBindings.map(({ projectId }) => projectId));
      for (const baseRef of item.baseRefs ?? []) {
        if (!boundProjects.has(baseRef.projectId)) {
          throw new Error(
            `WorkItem base-ref Project is not bound to its Task: ${item.id}/${baseRef.projectId}.`
          );
        }
        if (!writeProjects.has(baseRef.projectId)) {
          throw new Error(
            `WorkItem base-ref Project is not writable: ${item.id}/${baseRef.projectId}.`
          );
        }
      }
      const root = this.#workItemWorkspaceRoot(lockedTask.id, item.id);
      const prepared: Array<Readonly<{ project: Project; entry: WorkspaceProjectEntry }>> = [];
      try {
        for (const binding of lockedTask.projectBindings) {
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
          const requestedBaseRef = item.baseRefs?.find(({ projectId }) => (
            projectId === project.id
          ))?.baseRef;
          const baseRef = previous?.access === "write"
            ? previous.baseCommit
            : requestedBaseRef ?? head.baseCommit;
          const requestedBase = previous?.access === "write" || requestedBaseRef === undefined
            ? null
            : await this.git.inspect(project.path, requestedBaseRef);
          const physical = await this.git.ensureWorktree({
            repositoryPath: project.path,
            container: this.#projectContainer(project.name),
            taskSegment,
            roleName: item.id,
            baseRef
          });
          const entry: WorkspaceProjectEntry = {
            projectId: project.id,
            directory: binding.directory,
            access: "write",
            path: physical.path,
            branch: physical.branch,
            baseRef: previous?.access === "write" ? previous.baseRef : baseRef,
            // The recorded base is the immutable capture boundary. An existing
            // worktree reports its current HEAD from ensureWorktree(), which
            // may already contain committed Worker changes and must never
            // replace that boundary during scope expansion or reconciliation.
            baseCommit: previous?.access === "write"
              ? previous.baseCommit
              : physical.baseCommit
          };
          // Track the physical entry before any postcondition check. If a
          // freshly attached deterministic branch is rejected below, the
          // catch-path must remove its unadopted worktree even though no
          // durable ManagedWorkspace has been written yet.
          prepared.push({ project, entry });
          if (previous?.access === "write" && (
            physical.path !== previous.path
            || physical.branch !== previous.branch
          )) {
            throw new Error(
              `Existing WorkItem Project workspace identity changed: ${item.id}/${project.id}.`
            );
          }
          if (previous?.access === "write") {
            if (requestedBaseRef === undefined && previous.baseRef !== previous.baseCommit) {
              throw new Error(
                `Existing WorkItem Project base ref record changed: ${item.id}/${project.id}.`
              );
            }
            if (requestedBaseRef !== undefined && requestedBaseRef !== previous.baseRef) {
              throw new Error(
                `Existing WorkItem Project base ref changed: ${item.id}/${project.id}.`
              );
            }
            if (!await this.git.isAncestor(project.path, previous.baseCommit, physical.baseCommit)) {
              throw new Error(
                `Existing WorkItem Project HEAD does not descend from its frozen base: `
                + `${item.id}/${project.id}.`
              );
            }
          } else if (requestedBase !== null && physical.baseCommit !== requestedBase.baseCommit) {
            throw new Error(
              `WorkItem Project workspace did not start at its requested base ref: `
              + `${item.id}/${project.id}.`
            );
          }
        }
        await ensureWorkspaceView(root, prepared.map(({ entry }) => entry));
        const workspace = createManagedWorkspace({
          owner: { type: "work-item", taskId: lockedTask.id, workItemId: item.id },
          root,
          entries: prepared.map(({ entry }) => entry)
        }, this.now());
        this.#registerWorkspace(workspace);
        return this.store.transaction((tx) => {
          const latestTask = requireTask(tx, lockedTask.id);
          const latestItem = tx.getWorkItem(lockedTask.id, item.id);
          if (latestTask.status !== "active" || latestItem === null) {
            throw new Error(`Work item changed while preparing its workspace: ${item.id}.`);
          }
          if (latestItem.revision !== item.revision
            || !isDeepStrictEqual(latestItem.writeProjectIds, item.writeProjectIds)) {
            throw new Error(`Work item changed while preparing its workspace: ${item.id}.`);
          }
          const activeDevelopRun = tx.listAgentRuns(lockedTask.id)
            .find((run) => run.status === "active" && run.workItemId === item.id);
          if (activeDevelopRun !== undefined) {
            throw new Error(`Work Item already has an active Develop Run: ${activeDevelopRun.id}.`);
          }
          if (latestItem.assignee !== undefined
            && tx.getActiveAgentRun(lockedTask.id, latestItem.assignee) !== null) {
            throw new Error(`Role has an active Run: ${lockedTask.id}/${latestItem.assignee}.`);
          }
          const existingWorkspace = tx.getWorkItemWorkspace(lockedTask.id, item.id);
          if (existingWorkspace !== null && (
            existingWorkspace.owner.type !== "work-item"
            || existingWorkspace.owner.workItemId !== item.id
          )) {
            throw new Error(`WorkItem workspace changed: ${lockedTask.id}/${item.id}.`);
          }
          const timestamp = this.now();
          const stored = preserveWorkspaceCreatedAt(workspace, existingWorkspace);
          tx.saveManagedWorkspace(stored);
          if (latestItem.assignee !== undefined) {
            const latestRole = tx.getRole(lockedTask.id, latestItem.assignee);
            if (latestRole !== null && latestRole.workspace !== root) {
              retireWorkspaceBoundSession(tx, lockedTask.id, latestItem.assignee, timestamp);
              tx.saveRole(lockedTask.id, updateRole(latestRole, { workspace: root }, timestamp));
            }
          }
          return stored;
        });
      } catch (error) {
        await this.#discardUnadoptedEntries(lockedTask, taskSegment, prepared, item.id);
        throw error;
      }
    } finally {
      release();
    }
  }

  /**
   * Prepare/reuse a durable physical workspace for an ExecutionGroup Lane.
   * Git identity, ownership, and cleanup are delegated to this preparer; the
   * command layer only consumes the resulting managed record.
   */
  async prepareExecutionLaneWorkspace(
    taskId: string,
    executionGroupId: string,
    executionLaneId: string,
    hint?: Readonly<{
      purpose: "execution" | "review";
      workItemId?: string;
      reviewRoundId?: string;
    }>,
    heldFence?: Readonly<{ current: Task }>
  ): Promise<ManagedWorkspace> {
    const task = requireTask(this.store, taskId);
    // Hold the per-Project maintenance fence across Lane worktree creation
    // (both the reuse and the fresh-mint paths), so a concurrent
    // migrate/rebuild cannot switch the Project catalog mid-prepare. A
    // dispatch preflight that prepares a whole new Group passes the fence it
    // already holds (one locked boundary across preparation and adoption);
    // otherwise the fence is acquired here.
    const { release, current: lockedTask } = heldFence === undefined
      ? this.#acquireTaskProjectMaintenanceLocks(task)
      : { release: () => {}, current: heldFence.current };
    try {
      const lineage = executionLaneLineage(this.store, lockedTask, executionGroupId, executionLaneId, hint);
      const source = lineage.purpose === "execution"
        ? this.store.getWorkItemWorkspace(taskId, lineage.workItemId)
        : this.store.getReviewRoundWorkspace(taskId, lineage.reviewRoundId);
      if (source === null) {
        throw new Error(`Execution Lane source workspace is not ready: ${executionLaneId}.`);
      }
      const taskSegment = this.#taskSegment(lockedTask);
    const owner = lineage.purpose === "execution"
      ? {
          type: "execution-lane" as const,
          taskId,
          executionGroupId,
          executionLaneId,
          purpose: "execution" as const,
          workItemId: lineage.workItemId
        }
      : {
          type: "execution-lane" as const,
          taskId,
          executionGroupId,
          executionLaneId,
          purpose: "review" as const,
          reviewRoundId: lineage.reviewRoundId
        };
    const existing = this.store.getManagedWorkspace(owner);
    if (existing !== null) {
      if (existing.owner.type !== "execution-lane" || existing.root !== this.#executionLaneWorkspaceRoot(taskId, executionGroupId, executionLaneId)) {
        throw new Error(`Execution Lane managed workspace identity changed: ${taskId}/${executionLaneId}.`);
      }
      await ensureWorkspaceView(existing.root, existing.entries);
      this.#registerWorkspace(existing);
      for (const entry of existing.entries.filter(({ access }) => access === "write")) {
        const project = requireProject(this.store, entry.projectId);
        const physical = await this.git.ensureWorktree({
          repositoryPath: project.path,
          container: this.#projectContainer(project.name),
          taskSegment,
          roleName: managedWorktreeName(owner),
          baseRef: entry.baseCommit
        });
        if (physical.path !== entry.path || physical.branch !== entry.branch) {
          throw new Error(`Execution Lane physical identity changed: ${taskId}/${executionLaneId}/${entry.projectId}.`);
        }
      }
      return existing;
    }
    const item = lineage.purpose === "execution"
      ? this.store.getWorkItem(taskId, lineage.workItemId)
      : null;
    const writable = new Set(lineage.purpose === "execution"
      ? item?.writeProjectIds ?? []
      : lockedTask.projectBindings.map(({ projectId }) => projectId));
    const prepared: Array<Readonly<{ project: Project; entry: WorkspaceProjectEntry }>> = [];
    try {
      for (const binding of lockedTask.projectBindings) {
        const project = requireProject(this.store, binding.projectId);
        const sourceEntry = requireWorkspaceEntry(source, project.id);
        if (!writable.has(project.id)) {
          prepared.push({ project, entry: { ...sourceEntry, access: "read" } });
          continue;
        }
        const physical = await this.git.ensureWorktree({
          repositoryPath: project.path,
          container: this.#projectContainer(project.name),
          taskSegment,
          roleName: managedWorktreeName(owner),
          baseRef: sourceEntry.baseCommit
        });
        prepared.push({
          project,
          entry: {
            ...sourceEntry,
            access: "write",
            path: physical.path,
            branch: physical.branch,
            baseRef: sourceEntry.baseCommit,
            baseCommit: sourceEntry.baseCommit
          }
        });
      }
      const root = this.#executionLaneWorkspaceRoot(taskId, executionGroupId, executionLaneId);
      await ensureWorkspaceView(root, prepared.map(({ entry }) => entry));
      const workspace = createManagedWorkspace({
        owner,
        root,
        entries: prepared.map(({ entry }) => entry)
      }, this.now());
      this.#registerWorkspace(workspace);
      const durableLane = this.store.listWorkItems(taskId).some((item) => (
        workItemExecutionGroupById(item, executionGroupId)?.lanes.some(({ id }) => id === executionLaneId)
      )) || this.store.listReviewRounds(taskId).some((round) => (
        round.executionGroup?.id === executionGroupId
          && round.executionGroup.lanes.some(({ id }) => id === executionLaneId)
      ));
      if (durableLane) {
        return this.store.transaction((tx) => {
          const current = tx.getManagedWorkspace(owner);
          if (current !== null && !isDeepStrictEqual(current, workspace)) {
            throw new Error(`Execution Lane workspace changed before adoption: ${executionLaneId}.`);
          }
          tx.saveManagedWorkspace(current ?? workspace);
          return current ?? workspace;
        });
      }
      return workspace;
    } catch (error) {
      await this.#discardUnadoptedEntries(lockedTask, taskSegment, prepared, managedWorktreeName(owner), true);
      throw error;
    }
    } finally {
      release();
    }
  }

  /**
   * Compensate a command preflight when its later aggregate transaction does
   * not adopt the prepared Lane. Existing durable owners are never removed.
   */
  async discardUnadoptedExecutionLaneWorkspaces(
    workspaces: ReadonlyMap<string, ManagedWorkspace> | undefined
  ): Promise<void> {
    if (workspaces === undefined) return;
    for (const workspace of workspaces.values()) {
      if (this.store.getManagedWorkspace(workspace.owner) !== null) continue;
      const result = await this.discardUnadoptedExecutionLaneWorkspace(workspace);
      if (result === "dirty") {
        throw new Error(
          `Unadopted Execution Lane workspace is dirty and was retained: ${workspace.root}.`
        );
      }
    }
  }

  /** Merge every selected lane's committed output into the WorkItem owner. */
  async materializeExecutionGroupCandidate(
    taskId: string,
    workItemId: string,
    executionGroupId: string,
    selectedLaneIds: readonly string[]
  ): Promise<ExecutionGroupCandidateMaterialization> {
    const item = requireWorkItem(this.store, taskId, workItemId);
    const task = requireTask(this.store, taskId);
    const group = workItemExecutionGroupById(item, executionGroupId);
    if (group === undefined || group.id !== executionGroupId) {
      throw new Error(`ExecutionGroup is not attached to Work Item: ${executionGroupId}.`);
    }
    const workspace = this.store.getWorkItemWorkspace(taskId, workItemId);
    const selected = (selectedLaneIds.length === 0
      ? group.lanes.filter((lane) => lane.status === "yielded" || lane.status === "completed")
      : group.lanes.filter((lane) => selectedLaneIds.includes(lane.id)));
    if (selected.some((lane) => !["yielded", "completed"].includes(lane.status))) {
      throw new Error(`ExecutionGroup has a selected Lane without terminal output: ${executionGroupId}.`);
    }
    if (selected.length === 0) throw new Error(`ExecutionGroup has no selected Lane outputs: ${executionGroupId}.`);
    // A Gitless Task has no WorkItem workspace to materialize.  Its selected
    // Lane reports still form a valid non-Git Candidate; no fake workspace or
    // commit snapshot is introduced.
    if (workspace === null) {
      if (task.projectBindings.length === 0
        && selected.every((lane) => lane.result?.gitSnapshot === undefined)) {
        return { restoreTargets: [] };
      }
      throw new Error(`Work Item workspace is not ready for Candidate materialization: ${workItemId}.`);
    }
    if (workspace.owner.type !== "work-item") {
      throw new Error(`Work Item workspace owner is invalid for Candidate materialization: ${workItemId}.`);
    }
    const pendingMerges = new Map<string, string[]>();
    const restoreTargets: Array<{ path: string; head: string; mergedHead?: string }> = [];
    const writableProjectIds = workspace.entries
      .filter(({ access }) => access === "write")
      .map(({ projectId }) => projectId);
    if (writableProjectIds.length === 0) {
      for (const lane of selected) {
        if (lane.result?.gitSnapshot !== undefined) {
          throw new Error(`Read-only Lane must not carry a Git snapshot: ${lane.id}.`);
        }
      }
      return {
        workspace,
        // A read-only WorkItem has no Lane Git output, but its frozen
        // WorkItem workspace is still the legitimate Candidate review
        // context. Keep that Candidate snapshot separate from Lane output.
        snapshot: await this.snapshotCandidateWorkspace(workspace),
        restoreTargets: []
      };
    }
    for (const lane of selected) {
      const laneSnapshot = lane.result?.gitSnapshot;
      if (laneSnapshot === undefined) {
        throw new Error(`Selected Lane has no frozen Git snapshot: ${lane.id}.`);
      }
      const snapshotProjectIds = laneSnapshot.projects.map(({ projectId }) => projectId).sort();
      if (!isDeepStrictEqual(snapshotProjectIds, [...writableProjectIds].sort())) {
        throw new Error(`Selected Lane Git snapshot Project scope changed: ${lane.id}.`);
      }
      const laneWorkspace = this.store.getManagedWorkspace({
        type: "execution-lane",
        taskId,
        executionGroupId,
        executionLaneId: lane.id,
        purpose: "execution",
        workItemId
      });
      if (laneWorkspace === null) {
        // fixed(1) retains the WorkItem owner as its single normal-path workspace.
        if (group.lanes.length === 1) {
          for (const target of workspace.entries.filter(({ access }) => access === "write")) {
            const frozen = laneSnapshot.projects.find(({ projectId }) => projectId === target.projectId);
            if (frozen === undefined) throw new Error(`Selected Lane snapshot omits Project: ${lane.id}/${target.projectId}.`);
            if (await this.git.headRef(target.path) !== frozen.branch || !await this.git.isClean(target.path)) {
              throw new Error(`Single-Lane workspace is not clean on its managed branch: ${lane.id}/${target.projectId}.`);
            }
            const targetHead = (await this.git.inspect(target.path, "HEAD")).baseCommit;
            if (targetHead !== frozen.headCommit) {
              throw new Error(`Single-Lane workspace changed after yield: ${lane.id}/${target.projectId}.`);
            }
          }
          continue;
        }
        throw new Error(`Selected Execution Lane workspace is not adopted: ${lane.id}.`);
      }
      for (const target of workspace.entries.filter(({ access }) => access === "write")) {
        const source = laneWorkspace.entries.find(({ projectId }) => projectId === target.projectId);
        if (source === undefined) throw new Error(`Selected Lane omits Project: ${lane.id}/${target.projectId}.`);
        const frozen = laneSnapshot.projects.find(({ projectId }) => projectId === target.projectId);
        if (frozen === undefined) throw new Error(`Selected Lane snapshot omits Project: ${lane.id}/${target.projectId}.`);
        if (await this.git.headRef(source.path) !== frozen.branch || frozen.branch !== source.branch) {
          throw new Error(`Selected Lane left its managed branch: ${lane.id}/${target.projectId}.`);
        }
        if (!await this.git.isClean(source.path)) {
          throw new Error(`Selected Lane has uncommitted output: ${lane.id}/${target.projectId}.`);
        }
        const sourceHead = (await this.git.inspect(source.path, "HEAD")).baseCommit;
        if (sourceHead !== frozen.headCommit) {
          throw new Error(`Selected Lane advanced after yield: ${lane.id}/${target.projectId}.`);
        }
        const targetHead = (await this.git.inspect(target.path, "HEAD")).baseCommit;
        if (sourceHead !== targetHead && !await this.git.isAncestor(target.path, sourceHead, targetHead)) {
          const pending = pendingMerges.get(target.path) ?? [];
          pending.push(frozen.headCommit);
          pendingMerges.set(target.path, pending);
          if (!restoreTargets.some(({ path }) => path === target.path)) {
            restoreTargets.push({ path: target.path, head: targetHead });
          }
        }
      }
    }
    try {
      for (const [targetPath, sourceRefs] of pendingMerges) {
        await this.git.mergeWorktree({ targetPath, sourceRefs });
        const target = restoreTargets.find(({ path }) => path === targetPath);
        if (target !== undefined) {
          target.mergedHead = (await this.git.inspect(targetPath, "HEAD")).baseCommit;
        }
      }
      return {
        workspace,
        snapshot: await this.snapshotCandidateWorkspace(workspace),
        restoreTargets: restoreTargets
          .filter((target): target is { path: string; head: string; mergedHead: string } => (
            target.mergedHead !== undefined && target.mergedHead !== target.head
          ))
      };
    } catch (error) {
      for (const target of [...restoreTargets].reverse()) {
        if (target.mergedHead === undefined) continue;
        try {
          await this.git.resetWorktree({
            targetPath: target.path,
            expectedHead: target.mergedHead,
            restoreHead: target.head
          });
        } catch (restoreError) {
          throw new Error(
            `Candidate materialization failed and Git compensation could not restore ${target.path}.`,
            { cause: restoreError }
          );
        }
      }
      throw error;
    }
  }

  async restoreExecutionGroupCandidateMaterialization(
    materialization: ExecutionGroupCandidateMaterialization
  ): Promise<void> {
    for (const target of [...materialization.restoreTargets].reverse()) {
      const current = (await this.git.inspect(target.path, "HEAD")).baseCommit;
      if (current === target.head) continue;
      if (current !== target.mergedHead) {
        throw new Error(
          `Candidate materialization compensation found unexpected Git head: ${target.path}.`
        );
      }
      await this.git.resetWorktree({
        targetPath: target.path,
        expectedHead: target.mergedHead,
        restoreHead: target.head
      });
    }
  }

  async cleanupExecutionLaneWorkspace(
    taskId: string,
    executionGroupId: string,
    executionLaneId: string
  ): Promise<GitWorkspaceRemoval> {
    const task = requireTask(this.store, taskId);
    const lineage = executionLaneLineage(this.store, task, executionGroupId, executionLaneId);
    const item = lineage.purpose === "execution"
      ? this.store.getWorkItem(taskId, lineage.workItemId)
      : null;
    const group = lineage.purpose === "execution"
      ? (item === null ? undefined : workItemExecutionGroupById(item, executionGroupId))
      : this.store.getReviewRound(taskId, lineage.reviewRoundId)?.executionGroup;
    const lane = group?.lanes.find(({ id }) => id === executionLaneId);
    if (group === undefined
      || lane === undefined || !["completed", "failed", "yielded"].includes(lane.status)) {
      throw new Error(`Execution Lane is not terminally resolved: ${taskId}/${executionLaneId}.`);
    }
    const workspace = this.store.listManagedWorkspaces(taskId).find(({ owner }) => (
      owner.type === "execution-lane"
      && owner.executionGroupId === executionGroupId
      && owner.executionLaneId === executionLaneId
    ));
    if (workspace === undefined) return "missing";
    const state = await this.#inspectEntries(this.#taskSegment(task), managedWorktreeName(workspace.owner), workspace.entries.filter(({ access }) => access === "write"));
    if (state === "dirty") return "dirty";
    let removed = false;
    for (const entry of workspace.entries.filter(({ access }) => access === "write")) {
      const project = requireProject(this.store, entry.projectId);
      const result = await this.git.removeWorktree({
        repositoryPath: project.path,
        container: this.#projectContainer(project.name),
        taskSegment: this.#taskSegment(task),
        roleName: managedWorktreeName(workspace.owner),
        deleteBranch: true
      });
      if (result === "dirty") return "dirty";
      removed ||= result === "removed";
    }
    await removeWorkspaceView(workspace.root);
    this.#resourceRegistrar().markWorkspaceDeleted(workspace);
    this.store.removeManagedWorkspace(workspace.owner);
    return removed ? "removed" : "missing";
  }

  /** Remove a physical lane that was prepared but never adopted into a Group. */
  async discardUnadoptedExecutionLaneWorkspace(workspace: ManagedWorkspace): Promise<GitWorkspaceRemoval> {
    if (workspace.owner.type !== "execution-lane") {
      throw new Error("Only an execution-lane workspace can be discarded here.");
    }
    if (this.store.getManagedWorkspace(workspace.owner) !== null) return "missing";
    const task = requireTask(this.store, workspace.owner.taskId);
    const taskSegment = this.#taskSegment(task);
    const writable = workspace.entries.filter(({ access }) => access === "write");
    let state: GitWorkspaceState;
    try {
      state = await this.#inspectEntries(
        taskSegment,
        managedWorktreeName(workspace.owner),
        writable
      );
    } catch (error) {
      // A `project migrate` between preparation and compensation switches the
      // catalog, so the worktree's common-dir no longer matches the Project's
      // current repository. Fall back to removing the stranded worktree
      // through its own Git identity.
      if (!(error instanceof Error && error.message.includes("belongs to another project"))) {
        throw error;
      }
      let removed = false;
      for (const entry of writable) {
        const result = await this.git.removeStrandedWorktree(entry.path);
        if (result === "dirty") return "dirty";
        removed ||= result === "removed";
      }
      await removeWorkspaceView(workspace.root);
      return removed ? "removed" : "missing";
    }
    if (state === "dirty") return "dirty";
    let removed = false;
    for (const entry of writable) {
      const project = requireProject(this.store, entry.projectId);
      const result = await this.git.removeWorktree({
        repositoryPath: project.path,
        container: this.#projectContainer(project.name),
        taskSegment,
        roleName: managedWorktreeName(workspace.owner),
        deleteBranch: true
      });
      if (result === "dirty") return "dirty";
      removed ||= result === "removed";
    }
    await removeWorkspaceView(workspace.root);
    return removed ? "removed" : "missing";
  }

  async cleanupExecutionLaneWorkspacesForWorkItem(taskId: string, workItemId: string): Promise<GitWorkspaceRemoval> {
    let result: GitWorkspaceRemoval = "missing";
    const item = this.store.getWorkItem(taskId, workItemId);
    for (const group of item?.executionGroups ?? []) for (const lane of group.lanes) {
      const owner = this.store.listManagedWorkspaces(taskId).find(({ owner }) => (
        owner.type === "execution-lane" && owner.purpose === "execution"
          && owner.workItemId === workItemId && owner.executionLaneId === lane.id
      ));
      if (owner !== undefined) {
        if (owner.owner.type !== "execution-lane") continue;
        const cleaned = await this.cleanupExecutionLaneWorkspace(taskId, owner.owner.executionGroupId, lane.id);
        if (cleaned === "dirty") return cleaned;
        if (cleaned === "removed") result = cleaned;
      }
    }
    return result;
  }

  async cleanupExecutionLaneWorkspacesForReviewRound(taskId: string, reviewRoundId: string): Promise<GitWorkspaceRemoval> {
    let result: GitWorkspaceRemoval = "missing";
    const round = this.store.getReviewRound(taskId, reviewRoundId);
    for (const lane of round?.executionGroup?.lanes ?? []) {
      const owner = this.store.listManagedWorkspaces(taskId).find(({ owner }) => (
        owner.type === "execution-lane" && owner.purpose === "review"
          && owner.reviewRoundId === reviewRoundId && owner.executionLaneId === lane.id
      ));
      if (owner !== undefined) {
        if (owner.owner.type !== "execution-lane") continue;
        const cleaned = await this.cleanupExecutionLaneWorkspace(taskId, owner.owner.executionGroupId, lane.id);
        if (cleaned === "dirty") return cleaned;
        if (cleaned === "removed") result = cleaned;
      }
    }
    return result;
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
    const taskSnapshot = requireTask(this.store, taskId);
    const { release, current: task } = this.#acquireTaskProjectMaintenanceLocks(taskSnapshot);
    try {
    const taskSegment = this.#taskSegment(task);
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
          const identity = worktreeIdentity(taskSegment, round.id);
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
      if (!adopted) {
        throw new ReviewRoundWorkspaceEvidenceError(
          `ReviewRound workspace root changed: ${round.id}.`
        );
      }
      if (round.workspace !== undefined && !isDeepStrictEqual(round.workspace, existing)) {
        throw new ReviewRoundWorkspaceEvidenceError(
          `ReviewRound workspace record diverged: ${round.id}.`
        );
      }
      if (existing.entries.length !== expectedEntries.size) {
        throw new ReviewRoundWorkspaceEvidenceError(
          `ReviewRound workspace Project scope changed: ${round.id}.`
        );
      }
      for (const entry of existing.entries) {
        const source = expectedEntries.get(entry.projectId);
        if (source === undefined) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `ReviewRound workspace Project scope changed: ${round.id}/${entry.projectId}.`
          );
        }
        if (!sameCommit(entry.baseCommit, source.baseCommit)) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `ReviewRound workspace baseCommit record mismatch for ${round.id}/${entry.projectId}: `
            + `expected ${source.baseCommit}, recorded ${entry.baseCommit}.`
          );
        }
        if (entry.directory !== source.directory
          || entry.access !== "write"
          || !sameCommit(entry.baseRef, source.baseCommit)) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `ReviewRound workspace metadata changed for ${round.id}/${entry.projectId}.`
          );
        }
        const project = requireProject(this.store, entry.projectId);
        const identity = worktreeIdentity(taskSegment, round.id);
        const expectedPath = join(
          this.#projectContainer(project.name),
          identity.directory
        );
        if (entry.path !== expectedPath || entry.branch !== identity.branch) {
          throw new ReviewRoundWorkspaceEvidenceError(
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
          throw new ReviewRoundWorkspaceEvidenceError(
            `ReviewRound workspace cannot be inspected for ${round.id}/${entry.projectId}: `
            + `${error instanceof Error ? error.message : String(error)}`
          );
        }
        if (physical.root !== entry.path) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `ReviewRound workspace managed path mismatch for ${round.id}/${entry.projectId}.`
          );
        }
        const projectRoot = await this.git.inspect(project.path, "HEAD");
        if (physical.gitDirectory !== projectRoot.gitDirectory) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `ReviewRound workspace managed Project mismatch for ${round.id}/${entry.projectId}.`
          );
        }
        let branch: string | null;
        try {
          branch = await this.git.headRef(entry.path);
        } catch (error) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `ReviewRound workspace branch cannot be verified for `
            + `${round.id}/${entry.projectId}: `
            + `${error instanceof Error ? error.message : String(error)}`
          );
        }
        if (branch !== identity.branch) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `ReviewRound workspace managed branch mismatch for ${round.id}/${entry.projectId}: `
            + `expected ${identity.branch}, physical ${branch}.`
          );
        }
        let descendsFromBase: boolean;
        try {
          descendsFromBase = await this.git.isAncestor(
            project.path,
            entry.baseCommit,
            physical.baseCommit
          );
        } catch (error) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `ReviewRound workspace ancestry cannot be verified for `
            + `${round.id}/${entry.projectId}: `
            + `${error instanceof Error ? error.message : String(error)}`
          );
        }
        if (!descendsFromBase) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `ReviewRound workspace HEAD does not descend from its frozen base for `
            + `${round.id}/${entry.projectId}: expected ancestor ${entry.baseCommit}, `
            + `physical HEAD ${physical.baseCommit}.`
          );
        }
        retained.set(entry.projectId, { project, entry });
      }
      if (adopted && missing.size === 0) {
        try {
          await ensureWorkspaceView(reviewRoot, existing.entries);
          this.#registerWorkspace(existing);
        } catch (error) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `ReviewRound workspace view cannot be reused for ${round.id}: `
            + `${error instanceof Error ? error.message : String(error)}`
          );
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
          taskSegment,
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
          if (existing === null) {
            throw new Error(
              `ReviewRound workspace baseCommit mismatch for ${round.id}/${source.projectId}: `
              + `expected ${source.baseCommit}, physical HEAD ${physical.baseCommit}.`
            );
          }
          let descendsFromBase: boolean;
          try {
            descendsFromBase = await this.git.isAncestor(
              project.path,
              source.baseCommit,
              physical.baseCommit
            );
          } catch (error) {
            throw new ReviewRoundWorkspaceEvidenceError(
              `ReviewRound workspace ancestry cannot be verified for `
              + `${round.id}/${source.projectId}: `
              + `${error instanceof Error ? error.message : String(error)}`
            );
          }
          if (!descendsFromBase) {
            throw new ReviewRoundWorkspaceEvidenceError(
              `ReviewRound workspace HEAD does not descend from its frozen base for `
              + `${round.id}/${source.projectId}: expected ancestor ${source.baseCommit}, `
              + `physical HEAD ${physical.baseCommit}.`
            );
          }
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
      try {
        await ensureWorkspaceView(reviewRoot, entries);
      } catch (error) {
        if (existing !== null) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `ReviewRound workspace view cannot be reused for ${round.id}: `
            + `${error instanceof Error ? error.message : String(error)}`
          );
        }
        throw error;
      }
      const stored = existing ?? createManagedWorkspace({
        owner: { type: "review-round", taskId: task.id, reviewRoundId: round.id },
        root: reviewRoot,
        entries
      }, this.now());
      this.#registerWorkspace(stored);
      return this.store.transaction((tx) => {
        const currentRound = tx.getReviewRound(task.id, round.id);
        const currentItem = tx.getWorkItem(task.id, item.id);
        if (currentRound === null || currentRound.status !== "pending"
          || currentItem === null
          || !isDeepStrictEqual(
            currentItem.candidates.find(({ id }) => id === candidate.id),
            candidate
          )) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `ReviewRound changed while preparing its workspace: ${round.id}.`
          );
        }
        if (tx.getActiveAgentRun(task.id, reviewer.name) !== null) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `Reviewer Role has an active Run: ${task.id}/${reviewer.name}.`
          );
        }
        const currentWorkspace = tx.getReviewRoundWorkspace(task.id, round.id);
        if (existing !== null
          ? currentWorkspace === null || !sameManagedWorkspace(currentWorkspace, existing)
          : currentWorkspace !== null && !sameManagedWorkspace(currentWorkspace, stored)) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `ReviewRound workspace changed: ${task.id}/${round.id}.`
          );
        }
        const latestReviewer = tx.getRole(task.id, reviewer.name);
        if (latestReviewer === null) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `Reviewer Role not found: ${task.id}/${reviewer.name}.`
          );
        }
        if (currentRound.workspace !== undefined
          && !sameManagedWorkspace(currentRound.workspace, stored)) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `ReviewRound workspace record diverged: ${round.id}.`
          );
        }
        const timestamp = this.now();
        if (currentWorkspace === null) tx.saveManagedWorkspace(stored);
        if (currentRound.workspace === undefined) {
          tx.saveReviewRound(task.id, attachReviewRoundWorkspace(currentRound, stored));
        }
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
        taskSegment,
        prepared,
        round.id,
        existing === null,
        new Set([...retained.values()].map(({ entry }) => entry.path))
      );
      throw error;
    }
    } finally {
      release();
    }
  }

  async inspectReviewRoundWorkspace(
    taskId: string,
    reviewRoundId: string
  ): Promise<GitWorkspaceState> {
    const task = requireTask(this.store, taskId);
    const round = this.store.getReviewRound(taskId, reviewRoundId);
    if (round === null) throw new Error(`ReviewRound not found: ${taskId}/${reviewRoundId}.`);
    const workspace = this.store.getReviewRoundWorkspace(taskId, reviewRoundId);
    if (workspace === null) return "missing";
    assertReviewRoundOwnsWorkspace(round.id, workspace);
    if (round.workspace !== undefined && !isDeepStrictEqual(round.workspace, workspace)) {
      throw new Error(`ReviewRound workspace record diverged: ${round.id}.`);
    }
    return this.#inspectEntries(this.#taskSegment(task), round.id, workspace.entries);
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
    return this.#snapshotReviewWorkspaceEntries(round.id, workspace, round.reviewBaseCommit);
  }

  /**
   * Snapshot the exact workspace recorded on one Reviewer Run.  Panel Lanes
   * own separate durable workspaces; the ReviewRound's shared workspace is
   * not a valid substitute for a Lane's branch/head evidence.
   */
  async snapshotReviewRunResult(
    taskId: string,
    run: AgentRun
  ): Promise<Readonly<{ evidenceCommit?: string }>> {
    if (run.taskId !== taskId || run.purpose !== "review" || run.reviewRoundId === undefined) {
      throw new Error(`Run is not an exact ReviewRound Run: ${run.id}.`);
    }
    if (run.workspace === undefined) {
      throw new Error(`Review Run has no managed workspace: ${run.id}.`);
    }
    const round = this.store.getReviewRound(taskId, run.reviewRoundId);
    if (round === null || round.status !== "running") {
      throw new Error(`ReviewRound is not running for Review Run: ${run.id}.`);
    }
    const stored = this.store.getManagedWorkspace(run.workspace.owner);
    if (stored === null || !isDeepStrictEqual(stored, run.workspace)) {
      throw new Error(`Review Run workspace is not the durable owner: ${run.id}.`);
    }
    if (run.workspace.owner.type === "review-round") {
      if (run.workspace.owner.taskId !== taskId
        || run.workspace.owner.reviewRoundId !== round.id
        || round.workspace === undefined
        || !isDeepStrictEqual(round.workspace, run.workspace)) {
        throw new Error(`Review Run workspace owner does not match its ReviewRound: ${run.id}.`);
      }
      return this.#snapshotReviewWorkspaceEntries(round.id, run.workspace, round.reviewBaseCommit);
    }
    if (run.workspace.owner.type !== "execution-lane"
      || run.workspace.owner.taskId !== taskId
      || run.workspace.owner.purpose !== "review"
      || run.workspace.owner.reviewRoundId !== round.id
      || run.workspace.owner.executionGroupId !== run.executionGroupId
      || run.workspace.owner.executionLaneId !== run.executionLaneId) {
      throw new Error(`Review Run workspace owner does not match its Lane lineage: ${run.id}.`);
    }
    const lane = round.executionGroup?.lanes.find(({ id }) => id === run.executionLaneId);
    const writableProjectIds = run.workspace.entries
      .filter(({ access }) => access === "write")
      .map(({ projectId }) => projectId)
      .sort();
    if (lane === undefined
      || lane.runId !== run.id
      || lane.roleName !== run.roleName
      || lane.reviewRoundId !== round.id
      || lane.workspace?.root !== run.workspace.root
      || !isDeepStrictEqual(
        [...lane.workspace.writableProjectIds].sort(),
        writableProjectIds
      )
      || run.workspace.entries.length === 0
      || run.workspace.entries.some(({ access }) => access !== "write")) {
      throw new Error(`Review Run Lane workspace lineage is not exact: ${run.id}.`);
    }
    return this.#snapshotReviewWorkspaceEntries(round.id, run.workspace, round.reviewBaseCommit);
  }

  async inspectExecutionLaneWorkspace(
    taskId: string,
    executionGroupId: string,
    executionLaneId: string
  ): Promise<GitWorkspaceState> {
    const task = requireTask(this.store, taskId);
    const workspace = this.store.listManagedWorkspaces(taskId).find(({ owner }) => (
      owner.type === "execution-lane"
        && owner.executionGroupId === executionGroupId
        && owner.executionLaneId === executionLaneId
    ));
    if (workspace === undefined) return "missing";
    return this.#inspectEntries(
      this.#taskSegment(task),
      managedWorktreeName(workspace.owner),
      workspace.entries.filter(({ access }) => access === "write")
    );
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
    for (const lane of round.executionGroup?.lanes ?? []) {
      assertWorkspaceSessionsRetirable(this.store, task.id, lane.roleName, this.now());
    }
    if (await this.#inspectEntries(
      this.#taskSegment(task),
      managedWorktreeName(workspace.owner),
      workspace.entries
    ) === "dirty") return "dirty";
    let removed = false;
    for (const entry of workspace.entries) {
      const project = requireProject(this.store, entry.projectId);
      const result = await this.git.removeWorktree({
        repositoryPath: project.path,
        container: this.#projectContainer(project.name),
        taskSegment: this.#taskSegment(task),
        roleName: managedWorktreeName(workspace.owner),
        deleteBranch: true
      });
      if (result === "dirty") {
        throw new Error(`Review workspace changed after cleanup preflight: ${round.id}.`);
      }
      removed ||= result === "removed";
    }
    await removeWorkspaceView(workspace.root);
    this.#resourceRegistrar().markWorkspaceDeleted(workspace);
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
    for (const group of item.executionGroups) for (const lane of group.lanes) {
      assertWorkspaceSessionsRetirable(this.store, task.id, lane.roleName, this.now());
    }
    const writable = workspace.entries.filter(({ access }) => access === "write");
    if (await this.#inspectEntries(
      this.#taskSegment(task),
      managedWorktreeName(workspace.owner),
      writable
    ) === "dirty") return "dirty";
    let removed = false;
    for (const entry of writable) {
      const project = requireProject(this.store, entry.projectId);
      const result = await this.git.removeWorktree({
        repositoryPath: project.path,
        container: this.#projectContainer(project.name),
        taskSegment: this.#taskSegment(task),
        roleName: managedWorktreeName(workspace.owner),
        deleteBranch: true
      });
      if (result === "dirty") {
        throw new Error(`WorkItem workspace changed after cleanup preflight: ${item.id}.`);
      }
      removed ||= result === "removed";
    }
    await removeWorkspaceView(workspace.root);
    this.#resourceRegistrar().markWorkspaceDeleted(workspace);
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
    return this.#inspectEntries(this.#taskSegment(task), MAIN_WORKTREE, main.entries);
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
      if (await this.#inspectEntries(this.#taskSegment(task), MAIN_WORKTREE, main.entries) === "dirty") {
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
          taskSegment: this.#taskSegment(task),
          roleName: MAIN_WORKTREE
        });
        if (result === "dirty") {
          throw new Error(`Task workspace changed after cleanup preflight: ${task.id}.`);
        }
      }
      assertTaskArchiveState(requireTask(this.store, task.id), task);
      await removeWorkspaceView(main.root);
      this.#resourceRegistrar().markWorkspaceDeleted(main);
      assertTaskArchiveState(requireTask(this.store, task.id), task);
      this.#recordWorkspaceRemoval(task, main, this.#fallbackWorkspace());
    }
    this.#clearTaskWorkspace(task, this.#fallbackWorkspace());
    return { taskId, status: "removed" };
  }

  /**
   * Rebuild an eligible legacy Task's managed Git workspace under a fresh
   * workspace identity. Legacy refs are archived (never deleted outright),
   * the new main worktrees start from verified remote SHAs, and the Task
   * record switches only after every Git side effect succeeded, so a crash
   * at any point leaves the old layout usable and the command resumable.
   *
   * A Task that already carries an identity takes the resume path: only the
   * pending legacy archive and old-worktree removal run.
   */
  async rebuildTaskWorkspace(
    taskId: string,
    options: Readonly<{ latestRemote?: boolean }> = {}
  ): Promise<TaskWorkspaceRebuildResult> {
    const task = requireTask(this.store, taskId);
    if (!["draft", "active"].includes(task.status)) {
      throw new Error(`Only a draft or active Task can be rebuilt in place: ${task.id}/${task.status}.`);
    }
    // The rebuild holds every touched Project's maintenance fence for its
    // whole duration, so the Controller defers preparation and no other
    // maintenance interleaves. The resume path may clean up legacy
    // worktrees/refs in any Project; the fresh path touches its bound
    // Projects plus any still holding the Task's legacy refs.
    const projectIds = task.workspaceIdentity !== undefined
      ? this.store.listProjects().map(({ id }) => id)
      : [
          ...new Set([
            ...task.projectBindings.map(({ projectId }) => projectId),
            ...(await this.listLegacyTaskRefs(task.id)).map(({ projectId }) => projectId)
          ])
        ];
    const releaseMaintenance = acquireProjectMaintenanceLocks(this.home, projectIds);
    try {
      return await this.#rebuildTaskWorkspaceLocked(task, options);
    } finally {
      releaseMaintenance();
    }
  }

  async #rebuildTaskWorkspaceLocked(
    task: Task,
    options: Readonly<{ latestRemote?: boolean }>
  ): Promise<TaskWorkspaceRebuildResult> {
    if (task.workspaceIdentity !== undefined) {
      const current = this.store.getTaskWorkspace(task.id);
      if (current !== null && current.owner.type === "task") {
        await ensureWorkspaceView(current.root, current.entries);
      }
      // Remove the legacy worktrees before archiving their refs: a worktree
      // whose checked-out branch was just deleted reports an unborn-branch
      // ("dirty") status and can no longer be removed cleanly.
      await this.#removeLegacyWorktrees(
        task,
        this.store.listProjects().map((project) => project.id)
      );
      const archived = await this.#archiveLegacyRefs(task);
      // Reclaim token worktrees/branches a crashed prepare or rebuild left
      // behind without a catalog record, so they do not accumulate.
      await this.#reclaimOrphanedTaskWorktrees(task);
      return { task: requireTask(this.store, task.id), archived, resumed: true };
    }
    assertTaskHasNoEvidence(this.store, task.id);
    const existing = this.store.getTaskWorkspace(task.id);
    if (existing !== null && existing.owner.type !== "task") {
      throw new Error(`Task main workspace ownership is invalid: ${task.id}.`);
    }
    if (existing !== null
      && await this.#inspectLegacyTaskEntries(task, existing.entries) === "dirty") {
      throw new Error(`Task workspace is dirty and blocks the rebuild: ${task.id}.`);
    }

    // Reclaim token worktrees/branches a crashed prepare or rebuild left
    // behind without a catalog record, before minting a new identity. A hard
    // crash after `ensureWorktree` but before the Task/catalog transaction
    // leaves the Task unbound; without this reaping the fresh path would
    // report success and leave the orphaned token worktree/branch behind.
    await this.#reclaimOrphanedTaskWorktrees(task);

    // Resolve verified remote SHAs before any Git side effect, mirroring the
    // first-prepare pinning: a remote default Project is fetched and its
    // exact advertised SHA is pinned; a local or explicit ref is validated.
    const defaultProjects = remoteDefaultProjects(this.store, task.id);
    const pins = new Map<string, string>();
    for (const binding of task.projectBindings) {
      const project = requireProject(this.store, binding.projectId);
      // `--latest` explicitly re-resolves every remote-backed Project. Without
      // it, only a still-symbolic creation default is refreshed; an explicit
      // or previously pinned commit retains the established rebuild behavior.
      const useRemoteDefault = (options.latestRemote === true
          || (defaultProjects.has(project.id) && !looksLikeCommit(binding.baseRef)))
        && project.remoteUrl !== undefined;
      if (useRemoteDefault) {
        const resolver = this.git.resolveRemoteBaseline;
        if (typeof resolver !== "function") {
          throw new Error(
            `Git workspace cannot resolve the remote baseline for Project: ${project.id}.`
          );
        }
        const remote = await resolver.call(this.git, {
          repositoryPath: project.path,
          remoteUrl: project.remoteUrl,
          developmentRef: options.latestRemote === true
            ? project.developmentBranch
            : binding.baseRef
        });
        pins.set(project.id, remote.commit);
      } else {
        await this.git.inspect(project.path, binding.baseRef);
      }
    }

    const identity = await this.#mintTaskWorkspaceIdentity(task);
    const taskSegment = taskWorkspaceRefSegmentFromIdentity(identity);
    const root = this.#taskWorkspaceRoot(task.id);
    const prepared: Array<Readonly<{ project: Project; entry: WorkspaceProjectEntry }>> = [];
    try {
      for (const binding of task.projectBindings) {
        const project = requireProject(this.store, binding.projectId);
        const baseRef = pins.get(project.id) ?? binding.baseRef;
        const physical = await this.git.ensureWorktree({
          repositoryPath: project.path,
          container: this.#projectContainer(project.name),
          taskSegment,
          roleName: MAIN_WORKTREE,
          baseRef
        });
        if (pins.has(project.id) && physical.baseCommit !== pins.get(project.id)) {
          throw new Error(
            `Task Project workspace did not start at the fetched remote baseline: ${project.id}.`
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
            baseRef,
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
      this.#registerWorkspace(workspace);
      // Switch the durable record only now that every new ref/worktree exists.
      this.store.transaction((tx) => {
        const latest = requireTask(tx, task.id);
        if (!["draft", "active"].includes(latest.status)
          || latest.workspaceIdentity !== undefined
          || !isDeepStrictEqual(latest.projectBindings, task.projectBindings)) {
          throw new Error(`Task changed while rebuilding its workspace: ${task.id}.`);
        }
        assertTaskHasNoEvidence(tx, task.id);
        const current = tx.getTaskWorkspace(task.id);
        if (current === null
          ? existing !== null
          : existing === null || !sameManagedWorkspace(current, existing)) {
          throw new Error(`Task workspace changed while rebuilding: ${task.id}.`);
        }
        const pinnedBindings = latest.projectBindings.map((binding) => {
          const pinned = pins.get(binding.projectId);
          return pinned !== undefined ? { ...binding, baseRef: pinned } : binding;
        });
        const timestamp = this.now();
        let persistedTask = isDeepStrictEqual(pinnedBindings, latest.projectBindings)
          ? latest
          : { ...latest, projectBindings: pinnedBindings, updatedAt: timestamp.toISOString() };
        persistedTask = bindTaskWorkspaceIdentity(persistedTask, identity, timestamp);
        if (persistedTask.cwd !== root) {
          persistedTask = { ...persistedTask, cwd: root, updatedAt: timestamp.toISOString() };
        }
        if (!isDeepStrictEqual(persistedTask, latest)) {
          tx.saveTask(persistedTask);
        }
        if (existing !== null) tx.removeManagedWorkspace(existing.owner);
        tx.saveManagedWorkspace(workspace);
      });
      // Record switched: retire the legacy layout. The worktrees leave first
      // (their branches are retained), then the refs are archived and
      // deleted; each step is resumable.
      await this.#removeLegacyWorktrees(
        task,
        existing === null
          ? this.store.listProjects().map((project) => project.id)
          : existing.entries.map(({ projectId }) => projectId)
      );
      const archived = await this.#archiveLegacyRefs(
        task,
        existing === null ? undefined : [...new Set(existing.entries.map(({ projectId }) => projectId))]
      );
      return { task: requireTask(this.store, task.id), archived, resumed: false };
    } catch (error) {
      await this.#discardUnadoptedEntries(task, taskSegment, prepared, MAIN_WORKTREE, true);
      throw error;
    }
  }

  /**
   * List legacy (pre-identity) Task refs across the Home's Project
   * repositories, optionally restricted to one Task. Identity-bearing
   * branches (`yui/task-N-<8hex>/...`) are never legacy.
   */
  async listLegacyTaskRefs(taskId?: string): Promise<LegacyTaskRef[]> {
    const found: LegacyTaskRef[] = [];
    for (const project of this.store.listProjects()) {
      let refs: string[];
      try {
        refs = await this.git.listRefs(project.path, "refs/heads/yui/");
      } catch (error) {
        // A deleted external checkout has no refs to scan; skip it.
        if (isMissingPath(error)) continue;
        throw error;
      }
      for (const ref of refs) {
        if (!isLegacyTaskRef(ref)) continue;
        const ownerTaskId = ref.slice("refs/heads/yui/".length).split("/")[0]!;
        if (taskId !== undefined && ownerTaskId !== taskId) continue;
        found.push({ projectId: project.id, taskId: ownerTaskId, ref });
      }
    }
    return found;
  }

  /**
   * Archive legacy Task refs into the Home-scoped archive namespace
   * (`refs/yui/archive/<homeId>/heads/...`). Refs owned by a draft/active
   * Task are refused: their worktrees may still be live. Terminal and
   * unknown-owner refs are archived; an already-archived or missing ref is
   * simply absent on retry.
   *
   * Every registered worktree on a to-be-archived ref is preflighted before
   * the first side effect: a dirty or unidentifiable one fails the whole
   * archive with nothing created, deleted, or removed. A same-repo worktree
   * this Home does not manage that still has the ref checked out fails the
   * archive closed as well, so deleting the ref cannot strand it.
   */
  async archiveLegacyTaskRefs(taskId?: string): Promise<LegacyTaskRefArchiveResult> {
    const home = this.store.getHomeIdentity();
    const refused: string[] = [];
    const archived: string[] = [];
    // The pre-lock scan discovers ONLY the sorted Project lock set. The pending
    // set is rebuilt under the fence (below) by re-listing refs and
    // re-classifying their owners, so a Task that transitions terminal ->
    // active between the scan and the lock is refused rather than archived.
    const scanned = await this.listLegacyTaskRefs(taskId);
    const projectIds = [...new Set(scanned.map(({ projectId }) => projectId))].sort();
    // The fence covers preflight and archive alike: a concurrent rebuild
    // must not remove a worktree between its inspection and its ref's
    // archival.
    const releaseMaintenance = projectIds.length === 0
      ? () => {}
      : acquireProjectMaintenanceLocks(this.home, projectIds);
    try {
      const locked = new Set(projectIds);
      const pending: LegacyRefArchiveTarget[] = [];
      for (const entry of await this.listLegacyTaskRefs(taskId)) {
        if (!locked.has(entry.projectId)) continue; // added after the pre-lock scan; not fenced.
        const owner = this.store.getTask(entry.taskId);
        if (owner !== null && ["draft", "active"].includes(owner.status)) {
          refused.push(`${entry.projectId}:${entry.ref}`);
          continue;
        }
        pending.push({
          project: requireProject(this.store, entry.projectId),
          taskId: entry.taskId,
          ref: entry.ref,
          archiveRef: taskArchiveRef(home.homeId, entry.ref)
        });
      }
      for (const target of pending) {
        await this.#assertLegacyRefWorktreeArchivable(target);
      }
      for (const target of pending) {
        // Re-validate under the fence: a Task reopened after classification
        // but before this point must not have its ref deleted.
        const current = this.store.getTask(target.taskId);
        if (current !== null && ["draft", "active"].includes(current.status)) {
          refused.push(`${target.project.id}:${target.ref}`);
          continue;
        }
        await this.#archiveLegacyRef(target);
        archived.push(`${target.project.id}:${target.ref}`);
      }
      return { archived, refused };
    } finally {
      releaseMaintenance();
    }
  }

  async #inspectEntries(
    taskSegment: string,
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
        taskSegment,
        roleName
      });
      if (state === "dirty") return "dirty";
      found ||= state === "clean";
    }
    return found ? "clean" : "missing";
  }

  async #snapshotReviewWorkspaceEntries(
    reviewRoundId: string,
    workspace: ManagedWorkspace,
    reviewBaseCommit: string
  ): Promise<Readonly<{ evidenceCommit?: string }>> {
    const changed: string[] = [];
    let dirty = false;
    for (const entry of workspace.entries) {
      if (await this.git.headRef(entry.path) !== entry.branch) {
        throw new Error(
          `Review Project workspace left its managed branch: ${reviewRoundId}/${entry.projectId}.`
        );
      }
      const head = (await this.git.inspect(entry.path, "HEAD")).baseCommit;
      const project = requireProject(this.store, entry.projectId);
      if (!await this.git.isAncestor(project.path, entry.baseCommit, head)) {
        throw new Error(
          `Review workspace HEAD does not descend from its frozen base for `
          + `${reviewRoundId}/${entry.projectId}: expected ancestor ${entry.baseCommit}, `
          + `physical HEAD ${head}.`
        );
      }
      if (head !== entry.baseCommit) changed.push(head);
      if (!await this.git.isClean(entry.path)) dirty = true;
    }
    if (changed.length > 1) {
      throw new Error(
        `Review workspace has diagnostic commits in multiple Projects; preserve it for Leader routing: ${reviewRoundId}.`
      );
    }
    // A dirty worktree has uncommitted diagnostics: no single commit captures
    // the tree the checks ran on, so no evidenceCommit can attest it and the
    // queue must re-run the gate.  A clean worktree attests that checks ran on
    // the recorded tree: the frozen base when the reviewer made no commits, or
    // the reviewer's single diagnostic commit otherwise.
    if (dirty) return {};
    return changed.length === 0
      ? { evidenceCommit: reviewBaseCommit }
      : { evidenceCommit: changed[0]! };
  }

  #projectContainer(projectName: string): string {
    return join(resolveWorktreeRoot(this.home, this.store.getConfig().defaultWorkspace),
      safePathSegment(projectName));
  }

  /**
   * The Task workspace ref segment for Git worktree derivation: the
   * token-bearing segment for a Task with a persisted identity, its bare id
   * for a pre-identity record. Every managed ref/path for one Task resolves
   * through this single helper.
   */
  #taskSegment(task: Task): string {
    return taskWorkspaceRefSegment(task);
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

  #executionLaneWorkspaceRoot(taskId: string, groupId: string, laneId: string): string {
    return join(
      resolveTaskRoot(this.home, this.store.getConfig().defaultWorkspace),
      safePathSegment(taskId),
      "execution-lanes",
      safePathSegment(groupId),
      safePathSegment(laneId)
    );
  }

  #fallbackWorkspace(): string {
    return this.store.getConfig().defaultWorkspace ?? process.cwd();
  }

  async #discardUnadoptedEntries(
    task: Task,
    taskSegment: string,
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
        taskSegment,
        roleName,
        ...(deleteBranch ? { deleteBranch: true } : {})
      });
      if (removal === "dirty") {
        throw new Error(
          `Unadopted managed worktree is dirty and was retained at ${entry.path}; inspect it and retry.`
        );
      }
      this.#resourceRegistrar().markPathsDeleted([entry.path]);
    }
  }

  /**
   * Archive one Task's legacy refs (`refs/heads/yui/<taskId>/...`) into the
   * Home-scoped archive namespace across the given Project repositories. When
   * no Project list is given, every Project in the Home is scanned, so the
   * resume path also finds refs in Projects that left the Task binding.
   */
  async #archiveLegacyRefs(task: Task, projectIds?: readonly string[]): Promise<string[]> {
    const home = this.store.getHomeIdentity();
    const projects = projectIds === undefined
      ? this.store.listProjects()
      : projectIds.map((id) => requireProject(this.store, id));
    const seen = new Set<string>();
    const archived: string[] = [];
    for (const project of projects) {
      let refs: string[];
      try {
        refs = await this.git.listRefs(project.path, `refs/heads/yui/${task.id}/`);
      } catch (error) {
        // A deleted external checkout has no refs to archive; skip it.
        if (isMissingPath(error)) continue;
        throw error;
      }
      for (const ref of refs) {
        const ownerTaskId = ref.slice("refs/heads/yui/".length).split("/")[0];
        if (ownerTaskId !== task.id || !isLegacyTaskRef(ref)) continue;
        const key = `${project.id}:${ref}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await this.#archiveLegacyRef({
          project,
          taskId: task.id,
          ref,
          archiveRef: taskArchiveRef(home.homeId, ref)
        });
        archived.push(key);
      }
    }
    return archived;
  }

  /**
   * The recorded worktree of a legacy Task ref, when the ref is the Task's
   * main branch. The legacy layout registers exactly one worktree per Task
   * and Project (`<taskId>/main` on `yui/<taskId>/main`); every other legacy
   * ref has no registered worktree and is archived directly.
   */
  #legacyRefWorktree(target: LegacyRefArchiveTarget) {
    const identity = worktreeIdentity(target.taskId, MAIN_WORKTREE);
    if (target.ref !== `refs/heads/${identity.branch}`) return undefined;
    const container = this.#projectContainer(target.project.name);
    return {
      repositoryPath: target.project.path,
      container,
      path: join(container, target.taskId, MAIN_WORKTREE),
      branch: identity.branch,
      taskSegment: target.taskId,
      roleName: MAIN_WORKTREE
    };
  }

  /**
   * Preflight the worktree of a to-be-archived ref: a registered worktree
   * must be clean (or absent) before the archive may touch any ref. An
   * unidentifiable worktree makes `inspectRecordedWorktree` throw, which
   * likewise fails the archive closed.
   */
  async #assertLegacyRefWorktreeArchivable(target: LegacyRefArchiveTarget): Promise<void> {
    const worktree = this.#legacyRefWorktree(target);
    if (worktree === undefined) return;
    const state = await this.git.inspectRecordedWorktree(worktree);
    if (state === "dirty") {
      throw new Error(
        `Legacy Task worktree is dirty and blocks the archive: ${target.taskId}/${target.project.id}.`
      );
    }
  }

  /**
   * Archive one legacy ref after removing its registered worktree. The
   * worktree leaves first (its commit retained in the archive ref), then the
   * active ref is deleted; a dirty worktree fails the ref closed. Each step
   * is resumable: a same-commit archive ref resumes, a missing worktree and
   * an already-deleted source are no-ops.
   *
   * Before any mutation, a same-repo worktree this Home does not manage that
   * still has the ref checked out fails the archive closed: `archiveRef`
   * deletes the ref with `update-ref -d`, which bypasses git's
   * worktree-occupancy check and would strand that worktree with an unborn
   * HEAD. The recorded worktree removed below is excluded from the check.
   */
  async #archiveLegacyRef(target: LegacyRefArchiveTarget): Promise<void> {
    const worktree = this.#legacyRefWorktree(target);
    await this.git.assertNoForeignWorktreeOnRef({
      repositoryPath: target.project.path,
      ref: target.ref,
      excludeWorktreePath: worktree?.path
    });
    if (worktree !== undefined) {
      const removal = await this.git.removeRecordedWorktree({
        ...worktree,
        retainedRef: target.archiveRef
      });
      if (removal === "dirty") {
        throw new Error(
          `Legacy Task worktree is dirty and blocks the archive: ${target.taskId}/${target.project.id}.`
        );
      }
      this.#resourceRegistrar().markPathsDeleted([worktree.path]);
    }
    await this.git.archiveRef({
      repositoryPath: target.project.path,
      sourceRef: target.ref,
      archiveRef: target.archiveRef
    });
  }

  /**
   * Remove the legacy worktrees of a Task (the bare `<taskId>/main` layout).
   * A missing worktree is expected on retry and ignored; a dirty one blocks.
   */
  async #removeLegacyWorktrees(task: Task, projectIds: readonly string[]): Promise<void> {
    for (const projectId of projectIds) {
      const project = requireProject(this.store, projectId);
      const container = this.#projectContainer(project.name);
      const branch = worktreeIdentity(task.id, MAIN_WORKTREE).branch;
      const removal = await this.git.removeRecordedWorktree({
        repositoryPath: project.path,
        container,
        path: join(container, task.id, MAIN_WORKTREE),
        branch,
        retainedRef: taskArchiveRef(
          this.store.getHomeIdentity().homeId,
          `refs/heads/${branch}`
        ),
        taskSegment: task.id,
        roleName: MAIN_WORKTREE
      });
      if (removal === "dirty") {
        throw new Error(`Legacy Task worktree is dirty and blocks the rebuild: ${task.id}/${project.id}.`);
      }
      this.#resourceRegistrar().markPathsDeleted([join(container, task.id, MAIN_WORKTREE)]);
    }
  }

  /**
   * Reclaim token worktrees of this Task that no catalog record owns. A
   * crashed prepare or rebuild (SIGKILL before the catalog transaction) leaves
   * a token-bearing worktree and branch behind; a retry mints a fresh token,
   * so the old one is orphaned. The resume path scans this Home's project
   * containers for `task-N-<token>` directories and removes any the catalog
   * no longer owns, reusing the recorded-worktree mechanism: prove the exact
   * identity, retain the commit in the Home archive, remove the worktree, then
   * archive and delete its now-unchecked-out branch.
   *
   * Only this Home's project containers are scanned, and every candidate must
   * pass the exact recorded-worktree proof (its branch retained in this
   * Home's Project repository) before it is removed. A deleted external
   * checkout orphans the worktree directory, which `removeRecordedWorktree`
   * removes outright; its branch is gone with the repository and needs no
   * further action.
   */
  async #reclaimOrphanedTaskWorktrees(task: Task): Promise<void> {
    const cataloged = new Set(
      this.store.listManagedWorkspaces(task.id)
        .flatMap((workspace) => workspace.entries.map(({ path }) => path))
    );
    const homeId = this.store.getHomeIdentity().homeId;
    for (const project of this.store.listProjects()) {
      const container = this.#projectContainer(project.name);
      for (const segment of await listTaskTokenSegments(container, task.id)) {
        const worktreePath = join(container, segment, MAIN_WORKTREE);
        if (cataloged.has(worktreePath)) continue;
        const branch = worktreeIdentity(segment, MAIN_WORKTREE).branch;
        const archiveRef = taskArchiveRef(homeId, `refs/heads/${branch}`);
        const removal = await this.git.removeRecordedWorktree({
          repositoryPath: project.path,
          container,
          path: worktreePath,
          branch,
          retainedRef: archiveRef,
          taskSegment: segment,
          roleName: MAIN_WORKTREE
        });
        if (removal === "dirty") {
          throw new Error(
            `Orphaned Task worktree is dirty and blocks the rebuild: ${task.id}/${project.id}.`
          );
        }
        this.#resourceRegistrar().markPathsDeleted([worktreePath]);
        // The worktree is gone; archive+delete its now-unchecked-out branch.
        // A deleted external checkout takes the branch with it, so a missing
        // repository or an already-absent branch is a no-op.
        let branchExists = false;
        try {
          branchExists = await this.git.refExists(project.path, `refs/heads/${branch}`);
        } catch (error) {
          if (!isMissingPath(error)) throw error;
        }
        if (branchExists) {
          await this.git.archiveRef({
            repositoryPath: project.path,
            sourceRef: `refs/heads/${branch}`,
            archiveRef
          });
        }
      }
    }
  }

  async #inspectLegacyTaskEntries(
    task: Task,
    entries: readonly WorkspaceProjectEntry[]
  ): Promise<GitWorkspaceState> {
    let found = false;
    for (const entry of entries) {
      const project = requireProject(this.store, entry.projectId);
      const state = await this.git.inspectRecordedWorktree({
        repositoryPath: project.path,
        container: this.#projectContainer(project.name),
        path: entry.path,
        branch: entry.branch,
        taskSegment: task.id,
        roleName: MAIN_WORKTREE
      });
      if (state === "dirty") return state;
      found ||= state === "clean";
    }
    return found ? "clean" : "missing";
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

/**
 * A controlled rebuild is only safe for a Task that owns no delivery
 * evidence: a Run, WorkItem, ChangeSet, or Integration would pin the old
 * refs and worktrees as historical proof.
 */
function assertTaskHasNoEvidence(store: TaskStore, taskId: string): void {
  if (store.listAgentRuns(taskId).length > 0
    || store.listWorkItems(taskId).length > 0
    || store.listChangeSets(taskId).length > 0
    || store.listIntegrationAttempts(taskId).length > 0) {
    throw new Error(
      `Task has Run, Work item, Change set, or Integration evidence and cannot be rebuilt in place: ${taskId}.`
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

type ExecutionLaneLineage = Readonly<{
  purpose: "execution" | "review";
  workItemId: string;
  reviewRoundId: string;
}>;

function executionLaneLineage(
  store: TaskStore,
  task: Task,
  executionGroupId: string,
  executionLaneId: string,
  hint?: Readonly<{ purpose: "execution" | "review"; workItemId?: string; reviewRoundId?: string }>
): ExecutionLaneLineage {
  if (hint?.purpose === "execution" && hint.workItemId !== undefined) {
    return { purpose: "execution", workItemId: hint.workItemId, reviewRoundId: "" };
  }
  if (hint?.purpose === "review" && hint.reviewRoundId !== undefined) {
    const round = store.getReviewRound(task.id, hint.reviewRoundId);
    if (round === null) throw new Error(`ReviewRound not found: ${hint.reviewRoundId}.`);
    return { purpose: "review", workItemId: round.workItemId, reviewRoundId: round.id };
  }
  // Prefer the active Run's exact WorkItem for this Lane; fall back to the
  // first queued WorkItem only when no active Run owns the Lane.
  const activeLaneRun = store.listAgentRuns(task.id)
    .find((run) => run.status === "active"
      && run.purpose === "execution"
      && run.executionGroupId === executionGroupId
      && run.executionLaneId === executionLaneId
      && run.workItemId !== undefined);
  if (activeLaneRun?.workItemId !== undefined) {
    return { purpose: "execution", workItemId: activeLaneRun.workItemId, reviewRoundId: "" };
  }
  for (const item of store.listWorkItems(task.id)) {
    if (workItemExecutionGroupById(item, executionGroupId)?.lanes.some(({ id }) => id === executionLaneId)) {
      return { purpose: "execution", workItemId: item.id, reviewRoundId: "" };
    }
  }
  for (const round of store.listReviewRounds(task.id)) {
    if (round.executionGroup?.id === executionGroupId
      && round.executionGroup.lanes.some(({ id }) => id === executionLaneId)) {
      return { purpose: "review", workItemId: round.workItemId, reviewRoundId: round.id };
    }
  }
  throw new Error(`Execution Lane lineage not found: ${task.id}/${executionGroupId}/${executionLaneId}.`);
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

function canCorrectActiveWorkItemRoleWorkspaceHint(
  store: TaskStore,
  taskId: string,
  role: TaskRole,
  item: WorkItem,
  workspace: ManagedWorkspace
): boolean {
  if (
    role.taskId !== taskId
    || role.status !== "running"
    || item.taskId !== taskId
    || item.assignee !== role.name
    || ["completed", "failed", "retired"].includes(item.status)
    || workspace.owner.type !== "work-item"
    || workspace.owner.taskId !== taskId
    || workspace.owner.workItemId !== item.id
  ) return false;

  const writableProjects = workspace.entries
    .filter(({ access }) => access === "write")
    .map(({ projectId }) => projectId)
    .sort();
  if (!isDeepStrictEqual(writableProjects, [...item.writeProjectIds].sort())) return false;

  const run = store.getActiveAgentRun(taskId, role.name);
  if (
    run === null
    || run.status !== "active"
    || run.purpose !== "execution"
    || run.workItemId !== item.id
    || run.workspace === undefined
    || !sameManagedWorkspaceIdentity(run.workspace, workspace)
    || run.effective.agentId !== role.activeAgentId
    || !sameEffectiveWorkspace(run.effective.workspace, workspace)
  ) return false;

  const sessions = store.getTaskRoleSessionSet(taskId, role.name);
  const session = sessions?.sessions[sessions.activeAgentId];
  if (
    sessions === null
    || sessions.owner.scope !== "task"
    || sessions.owner.taskId !== taskId
    || sessions.owner.roleName !== role.name
    || sessions.activeAgentId !== role.activeAgentId
    || sessions.inFlight === null
    || sessions.inFlight.agentId !== role.activeAgentId
    || sessions.inFlight.runId !== run.id
    || sessions.inFlight.receiptId !== formatAgentRunReceiptId(taskId, run.id)
    || session === undefined
    || session.agentId !== role.activeAgentId
    || session.adapterId !== run.effective.adapterId
    || session.launchId === undefined
    || session.nativeSessionId === undefined
    || !["ready", "running"].includes(session.status)
    || !isDeepStrictEqual(session.effective, run.effective)
    || !sameEffectiveWorkspace(session.effective.workspace, workspace)
  ) return false;

  const lifecycleMailbox = store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId,
    roleName: role.name
  }));
  if (hasRuntimeCleanupObligation(lifecycleMailbox)) return false;
  const lifecycle = lifecycleMailbox?.processing;
  if (lifecycle !== null
    && lifecycle !== undefined
    && isRuntimeLaunchReservation(lifecycle)) {
    const executionRef = lifecycle.executionRef;
    if (
      !isRuntimeLaunchReservation(lifecycle, session.launchId)
      || executionRef?.type !== "run"
      || executionRef.taskId !== taskId
      || executionRef.id !== run.id
    ) return false;
  }
  return true;
}

function sameEffectiveWorkspace(
  effective: AgentRun["effective"]["workspace"],
  workspace: ManagedWorkspace
): boolean {
  return effective.root === workspace.root
    && isDeepStrictEqual(effective.entries, workspace.entries);
}

function sameManagedWorkspace(left: ManagedWorkspace, right: ManagedWorkspace): boolean {
  return isDeepStrictEqual(left, right);
}

function sameManagedWorkspaceIdentity(left: ManagedWorkspace, right: ManagedWorkspace): boolean {
  return isDeepStrictEqual(
    { owner: left.owner, root: left.root, entries: left.entries },
    { owner: right.owner, root: right.root, entries: right.entries }
  );
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * The token-bearing ref segments (`task-N-<8hex>`) under a Project's worktree
 * container for one Task. A missing container yields no segments; legacy
 * (`task-N`) and foreign-Task directories are ignored.
 */
async function listTaskTokenSegments(container: string, taskId: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(container, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
  const prefix = `${taskId}-`;
  const segments: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(prefix)) continue;
    if (!TASK_WORKSPACE_TOKEN_PATTERN.test(entry.name.slice(prefix.length))) continue;
    segments.push(entry.name);
  }
  return segments.sort();
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

function remoteDefaultProjects(store: TaskStore, taskId: string): Set<string> {
  const projectIds = new Set<string>();
  for (const event of store.listEvents(taskId)) {
    if (event.type === "task.created") {
      for (const projectId of (event.payload.defaultProjectIds ?? "").split(",")) {
        const normalized = projectId.trim();
        if (normalized.length > 0) projectIds.add(normalized);
      }
    }
  }
  return projectIds;
}

function looksLikeCommit(value: string): boolean {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(value);
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
