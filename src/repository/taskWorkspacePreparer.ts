import {
  lstat,
  mkdir,
  readlink,
  readdir,
  rm,
  rmdir,
  symlink,
  unlink
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { retireTaskRoleSessionsForWorkspace } from "../executor/agentExecutor.js";
import { formatWorkspacePreflightError } from "../executor/workspacePreflightClassification.js";
import { updateRole, type TaskRole } from "../role/role.js";
import {
  hasRuntimeCleanupObligation,
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import {
  attachReviewRoundWorkspace,
  recordReviewWorkspaceDisposition,
  type ReviewRound
} from "../review/reviewRound.js";
import { StorageConflictError, type TaskStore } from "../storage/taskStore.js";
import {
  activateTask,
  bindTaskProjectCommits,
  bindTaskWorkspaceIdentity,
  synchronizeTaskProjectCommits,
  type Task
} from "../task/task.js";
import { validateDraftTaskForActivation } from "../task/draftPlan.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { enqueueWork } from "../coordination/workMailboxQueue.js";
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
  isTaskOwnedWorkspace,
  managedWorkspaceKey,
  managedWorktreeName,
  sameManagedWorkspaceIdentity,
  type ManagedWorkspace,
  type WorkspaceProjectEntry
} from "../worktree/managedWorkspace.js";
import {
  validateExecutionGroup,
  type ExecutionGroup,
  type ExecutionLaneGitSnapshot
} from "../execution/executionGroup.js";
import type { Turn } from "../turn/turn.js";
import { formatTurnReceiptId } from "../task/taskRecordReference.js";
import {
  NodeGitWorkspace,
  worktreeIdentity,
  type GitRemoteBaseline,
  type GitWorkspacePort,
  type GitWorkspaceRemoval,
  type GitWorkspaceState
} from "./gitWorkspace.js";
import type { Project } from "./project.js";
import { acquireProjectMaintenanceLocks } from "./projectMaintenanceLock.js";
import {
  generateTaskWorkspaceIdentity,
  taskWorkspaceRefSegment,
  validateTaskWorkspaceIdentity,
  type TaskWorkspaceIdentity
} from "./taskWorkspaceIdentity.js";
import { ResourceRegistrar } from "../resources/resourceRegistrar.js";
import {
  captureTaskBaseProvenance,
  recordTaskBaseProvenanceEvents,
  type TaskBaseProvenance
} from "./taskBaseFreshness.js";

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
  remoteBaseline?: GitRemoteBaseline;
}>;

export type TaskWorkspacePreparation = Readonly<{
  taskId: string;
  status: "ready" | "failed";
  path?: string;
  error?: string;
}>;

export type TaskWorkspaceActivation = TaskWorkspacePreparation & Readonly<{
  task: Task;
  changed: boolean;
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

export type PreparedExecutionLane = Readonly<{
  workspace: ManagedWorkspace;
  persisted: boolean;
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
  activateTaskWorkspace(taskId: string): Promise<TaskWorkspaceActivation>;
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
    // Project maintenance and Task archive cleanup: a concurrent migration must not switch the
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
          return await this.#prepareTaskWorkspaceLocked(current.id, false);
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
   * Prepare every physical Task-main resource and adopt it in the same store
   * transaction that moves the Task from Draft to active. A Draft never owns a
   * durable writable workspace before this boundary, and any failed attempt
   * discards its unadopted refs/worktrees.
   */
  async activateTaskWorkspace(taskId: string): Promise<TaskWorkspaceActivation> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const task = requireTask(this.store, taskId);
        if (task.status === "active") {
          const workspace = this.store.getTaskWorkspace(task.id);
          if (!isTaskOwnedWorkspace(
            workspace,
            task.id,
            task.cwd,
            task.projectBindings.map(({ projectId, directory }) => ({ projectId, directory }))
          )) {
            throw new Error(`Active Task workspace adoption is invalid: ${task.id}.`);
          }
          return {
            task,
            taskId: task.id,
            status: "ready",
            ...(task.cwd === undefined ? {} : { path: task.cwd }),
            changed: false
          };
        }
        validateDraftTaskForActivation(this.store, task);
        const { release, current } = this.#acquireTaskProjectMaintenanceLocks(task);
        try {
          return await this.#prepareTaskWorkspaceLocked(current.id, true);
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

  async #prepareTaskWorkspaceLocked(
    taskId: string,
    activate: boolean
  ): Promise<TaskWorkspaceActivation> {
    const task = requireTask(this.store, taskId);
    if (activate && task.status !== "draft") {
      throw new Error(`Only a Draft Task can atomically adopt a workspace: ${task.id}/${task.status}.`);
    }
    if (!activate && task.status === "draft") {
      throw new Error(
        `Draft Task workspace must be adopted by task activation: ${task.id}.`
      );
    }
    if (!activate && task.status !== "active") {
      throw new Error(`Task is not open for workspace preparation: ${task.id}.`);
    }
    if (activate) validateDraftTaskForActivation(this.store, task);
    const existing = this.store.getTaskWorkspace(task.id);
    if (activate && (
      task.workspaceIdentity !== undefined
      || task.cwd !== undefined
      || existing !== null
    )) {
      throw new Error(
        `Draft Task already has adopted workspace state: ${task.id}. `
        + "Inspect it with `yui task base status`, then retire and recreate the Draft."
      );
    }
    if (!activate && existing === null) {
      throw new Error(
        `Active Task has no durable workspace owner: ${task.id}. `
        + "Use `yui task base status` to diagnose the incomplete activation."
      );
    }
    if (task.projectBindings.length === 0) {
      const root = this.#taskWorkspaceRoot(task.id);
      try {
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
        const persisted = this.store.transaction((tx) => {
          const latest = requireTask(tx, task.id);
          if (latest.status !== task.status
            || latest.projectBindings.length !== 0) {
            throw new Error(`Task changed while preparing its Gitless workspace: ${task.id}.`);
          }
          if (activate) validateDraftTaskForActivation(tx, latest);
          const current = tx.getTaskWorkspace(task.id);
          // `createManagedWorkspace` stamps a fresh updatedAt on every call.
          // Gitless preparation is idempotent, so compare only stable identity
          // and retain the existing durable record verbatim.
          if (current !== null && !sameManagedWorkspaceIdentity(current, workspace)) {
            throw new Error(`Gitless Task workspace changed during preparation: ${task.id}.`);
          }
          const timestamp = this.now();
          let next = latest.cwd === root
            ? latest
            : { ...latest, cwd: root, updatedAt: timestamp.toISOString() };
          if (activate) next = activateTask(next, timestamp);
          if (!isDeepStrictEqual(next, latest)) tx.saveTask(next);
          if (current === null) tx.saveManagedWorkspace(workspace);
          for (const role of tx.listRoles(task.id)) {
            if (role.workspace !== root) {
              retireWorkspaceBoundSession(tx, task.id, role.name, timestamp);
              tx.saveRole(task.id, updateRole(role, { workspace: root }, timestamp));
            }
          }
          if (activate) recordTaskActivation(tx, latest, next, timestamp);
          return next;
        });
        return {
          task: persisted,
          taskId,
          status: "ready",
          path: root,
          changed: activate
        };
      } catch (error) {
        if (activate) await removeWorkspaceView(root);
        throw error;
      }
    }
    if (existing !== null && existing.owner.type !== "task") {
      throw new Error(`Task main workspace ownership is invalid: ${task.id}.`);
    }

    if (task.workspaceIdentity === undefined
      && existing !== null
      && existing.entries.length > 0) {
      throw new Error(
        `Task workspace does not use the current identity contract: ${task.id}. `
        + "Preserve the old Home for diagnosis and let the Operator create a new Task."
      );
    }
    // The durable workspace identity is minted once before the first managed
    // Git workspace is adopted; every later prepare reuses it.
    const workspaceIdentity = task.workspaceIdentity === undefined
      && (existing === null || existing.entries.length === 0)
      ? await this.#mintTaskWorkspaceIdentity(task)
      : undefined;
    const taskSegment = taskWorkspaceRefSegment(
      workspaceIdentity === undefined ? task : { ...task, workspaceIdentity }
    );

    const root = this.#taskWorkspaceRoot(task.id);
    const prepared: Array<Readonly<{
      project: Project;
      entry: WorkspaceProjectEntry;
      currentCommit: string;
      provenance: TaskBaseProvenance;
    }>> = [];
    const createdClonePaths = new Set<string>();
    const baselines = new Map<string, TaskWorkspaceBaseline>();
    try {
      // Resolve every remote baseline before creating any Task clone. A later
      // Project failure therefore cannot leave an earlier Project adopted,
      // and activation remains one all-or-nothing boundary.
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
        if (project.remoteUrl === undefined) {
          throw new Error(
            `Task activation requires a configured remoteUrl for Project: ${project.id}.`
          );
        }
        const remote = await this.git.resolveRemoteHead({
          remoteUrl: project.remoteUrl,
          // The binding captures the configured development branch at Draft
          // creation. Project checkout state is intentionally irrelevant.
          branch: binding.baseRef
        });
        baselines.set(project.id, {
          baseRef: remote.commit,
          recordedBaseRef: binding.baseRef,
          expectedCommit: remote.commit,
          remoteBaseline: remote
        });
      }
      for (const binding of task.projectBindings) {
        const project = requireProject(this.store, binding.projectId);
        const previous = existing?.entries.find(({ projectId }) => projectId === project.id);
        const baseline = baselines.get(project.id);
        if (baseline === undefined) {
          throw new Error(`Task Project baseline was not resolved: ${project.id}.`);
        }
        const identity = worktreeIdentity(taskSegment, MAIN_WORKTREE);
        const destination = join(this.#projectContainer(project.name), identity.directory);
        const physical = previous === undefined
          ? await this.git.clone({
              remoteUrl: project.remoteUrl!,
              destination,
              branch: baseline.remoteBaseline!.branch,
              localBranch: identity.branch
            })
          : await this.git.inspect(previous.path, "HEAD");
        if (previous === undefined) createdClonePaths.add(physical.root);
        const physicalBranch = await this.git.headRef(physical.root);
        if (physical.root !== (previous?.path ?? destination)
          || physicalBranch !== (previous?.branch ?? identity.branch)) {
          throw new Error(
            `Task main clone identity changed: ${task.id}/${project.id}.`
          );
        }
        if (previous !== undefined
          && !await this.git.isAncestor(previous.path, previous.baseCommit, physical.baseCommit)) {
          throw new Error(formatWorkspacePreflightError({
            kind: "physical-drift",
            reason: `Task main physical HEAD left its recorded lineage: ${task.id}/${project.id}.`,
            taskId: task.id,
            roleName: LEADER_ROLE,
            projectId: project.id,
            expectedCommit: previous.baseCommit,
            physicalCommit: physical.baseCommit
          }));
        }
        if (baseline.expectedCommit !== undefined
          && physical.baseCommit !== baseline.expectedCommit) {
          throw new Error(
            `Task Project clone did not start at the fetched remote baseline: ${project.id}.`
          );
        }
        const provenance = await captureTaskBaseProvenance({
          git: this.git,
          project,
          binding,
          baseRef: previous?.baseRef ?? baseline.recordedBaseRef,
          baseCommit: physical.baseCommit,
          ...(baseline.remoteBaseline === undefined ? {} : { remoteBaseline: baseline.remoteBaseline })
        });
        prepared.push({
          project,
          entry: {
            projectId: project.id,
            directory: binding.directory,
            access: "write",
            path: physical.root,
            branch: previous?.branch ?? identity.branch,
            baseRef: previous?.baseRef ?? baseline.recordedBaseRef,
            baseCommit: previous?.baseCommit ?? physical.baseCommit
          },
          currentCommit: physical.baseCommit,
          provenance
        });
      }
      await ensureWorkspaceView(root, prepared.map(({ entry }) => entry));
      const workspace = createManagedWorkspace({
        owner: { type: "task", taskId: task.id },
        root,
        entries: prepared.map(({ entry }) => entry)
      }, this.now());
      this.#registerWorkspace(workspace);
      const persisted = this.store.transaction((tx) => {
        const latest = requireTask(tx, task.id);
        if (latest.status !== task.status) {
          throw new Error(`Task changed while preparing its workspace: ${task.id}.`);
        }
        if (!isDeepStrictEqual(latest.projectBindings, task.projectBindings)) {
          throw new Error(`Task Projects changed while preparing its workspace: ${task.id}.`);
        }
        if (activate) validateDraftTaskForActivation(tx, latest);
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
        // Single-writer CAS: this attempt only
        // commits while the Task is still unbound (or carries the identity it
        // started with). A concurrent prepare that bound a
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
        const timestamp = this.now();
        let persistedTask = latest;
        if (activate) {
          persistedTask = bindTaskProjectCommits(
            persistedTask,
            prepared.map(({ entry }) => ({
              projectId: entry.projectId,
              commit: entry.baseCommit
            })),
            timestamp
          );
        } else {
          persistedTask = synchronizeTaskProjectCommits(
            persistedTask,
            prepared.map(({ entry, currentCommit }) => ({
              projectId: entry.projectId,
              commit: currentCommit
            })),
            timestamp
          );
        }
        if (workspaceIdentity !== undefined) {
          // The identity is persisted only now that every managed ref was
          // created successfully. A concurrent prepare that bound the same
          // identity is a no-op; a different one fails closed.
          persistedTask = bindTaskWorkspaceIdentity(persistedTask, workspaceIdentity, timestamp);
        }
        if (persistedTask.cwd !== root) {
          persistedTask = { ...persistedTask, cwd: root, updatedAt: timestamp.toISOString() };
        }
        if (activate) persistedTask = activateTask(persistedTask, timestamp);
        if (!isDeepStrictEqual(persistedTask, latest)) {
          tx.saveTask(persistedTask);
        }
        tx.saveManagedWorkspace(preserveWorkspaceCreatedAt(workspace, current));
        const adoptedProvenance = prepared
          .filter(({ entry }) => (
            current?.entries.every(({ projectId }) => projectId !== entry.projectId) ?? true
          ))
          .map(({ provenance }) => provenance);
        if (adoptedProvenance.length > 0) {
          recordTaskBaseProvenanceEvents(
            tx,
            task.id,
            adoptedProvenance,
            timestamp
          );
        }
        for (const role of tx.listRoles(task.id)) {
          // The Role field is only a cwd/snapshot hint. Preserve it while a
          // durable WorkItem or ReviewRound workspace owns that cwd; Task-main
          // preparation must not move a Reviewer Session out from under an
          // active or retained ReviewRound. Other Roles use Task main.
          // Prefer the active Turn's exact WorkItem for this Role; fall back
          // to the first queued WorkItem only when no active Turn owns the Role.
          const activeRoleTurn = tx.getActiveTurn(task.id, role.name);
          const activeTurnItem = activeRoleTurn !== null
            && activeRoleTurn.purpose === "execution"
            && activeRoleTurn.workItemId !== undefined
            ? tx.getWorkItem(task.id, activeRoleTurn.workItemId)
            : null;
          const assignedItem = activeTurnItem !== null
            && activeTurnItem.assignee === role.name
            && !["completed", "failed", "retired"].includes(activeTurnItem.status)
            ? activeTurnItem
            : tx.listWorkItems(task.id).find((candidate) => (
              candidate.assignee === role.name
                && !["completed", "failed", "retired"]
                  .includes(candidate.status)
            ));
          const assignedWorkspace = assignedItem === undefined
            ? null
            : tx.getWorkItemWorkspace(task.id, assignedItem.id);
          const reviewWorkspace = tx.listManagedWorkspaces(task.id).find((candidate) => {
            if (candidate.owner.type !== "review-round"
              || candidate.root !== role.workspace) return false;
            return tx.getReviewRound(task.id, candidate.owner.reviewRoundId)
              ?.reviewerRoleName === role.name;
          });
          const target = assignedWorkspace?.root ?? reviewWorkspace?.root ?? root;
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
        if (activate) recordTaskActivation(tx, latest, persistedTask, timestamp);
        return persistedTask;
      });
      return {
        task: persisted,
        taskId,
        status: "ready",
        path: root,
        changed: activate
      };
    } catch (error) {
      // A failed or conflicted preparation owns no durable record: drop the
      // branches too, so a retry mints a clean identity without half-created
      // refs behind. Adopted (already catalogued) worktrees are never touched.
      await this.#discardUnadoptedEntries(task, taskSegment, prepared, MAIN_WORKTREE, true);
      const recorded = new Set(prepared.map(({ entry }) => entry.path));
      for (const path of createdClonePaths) {
        if (recorded.has(path)) continue;
        const removal = await this.git.removeStrandedWorktree(path);
        if (removal === "dirty") {
          throw new Error(
            `Unadopted Task clone is dirty and was retained at ${path}; inspect it and retry.`
          );
        }
      }
      if (activate) await removeWorkspaceView(root);
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
        return await this.#prepareTaskWorkspaceLocked(taskId, false);
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
    return generateTaskWorkspaceIdentity({
      home,
      taskId: task.id,
      now: this.now()
    });
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

  /** Freeze one clean committed source head set before any replicated Lane is minted. */
  async snapshotExecutionLaneInputHeads(
    workspace: ManagedWorkspace,
    projectIds: readonly string[]
  ): Promise<readonly Readonly<{ projectId: string; headCommit: string }>[]> {
    if (workspace.owner.type !== "task" && workspace.owner.type !== "work-item") {
      throw new Error("Execution Lane input must come from Task main or a WorkItem workspace.");
    }
    const stored = this.store.getManagedWorkspace(workspace.owner);
    if (stored === null || !isDeepStrictEqual(stored, workspace)) {
      throw new Error("Execution Lane input workspace is not the durable owner.");
    }
    return this.#snapshotWorkspaceHeads(workspace, projectIds, "Execution Lane input");
  }

  async snapshotDirectTaskMain(
    workspace: ManagedWorkspace,
    projectIds: readonly string[]
  ): Promise<DirectTaskMainSnapshot> {
    if (workspace.owner.type !== "task") {
      throw new Error("Only Task main can become a direct Candidate source.");
    }
    const projects = await this.#snapshotWorkspaceHeads(
      workspace,
      projectIds,
      "Direct Candidate"
    );
    return createDirectTaskMainSnapshot(workspace, projectIds, projects);
  }

  async #snapshotWorkspaceHeads(
    workspace: ManagedWorkspace,
    projectIds: readonly string[],
    boundary: string
  ): Promise<readonly Readonly<{ projectId: string; headCommit: string }>[]> {
    const selected = new Set(projectIds);
    if (selected.size !== projectIds.length) {
      throw new Error(`${boundary} Project scope is duplicated.`);
    }
    const entries = workspace.entries.filter(({ projectId }) => selected.has(projectId));
    if (entries.length !== selected.size) {
      throw new Error(`${boundary} Project scope does not match its managed workspace.`);
    }
    const projects = [];
    for (const entry of entries) {
      if (entry.access !== "write") {
        throw new Error(`${boundary} Project is not writable: ${entry.projectId}.`);
      }
      if (!await this.git.isClean(entry.path)) {
        throw new Error(
          `${boundary} workspace must be clean and committed: ${entry.projectId}.`
        );
      }
      const branch = await this.git.headRef(entry.path);
      if (branch !== entry.branch) {
        throw new Error(
          `${boundary} workspace left its managed branch: ${entry.projectId}/${branch}.`
        );
      }
      const headCommit = (await this.git.inspect(entry.path, "HEAD")).baseCommit;
      if (!await this.git.isAncestor(entry.path, entry.baseCommit, headCommit)) {
        throw new Error(
          `${boundary} workspace does not descend from its recorded base: ${entry.projectId}.`
        );
      }
      projects.push({ projectId: entry.projectId, headCommit });
    }
    return projects;
  }

  async prepareWorkItemWorkspace(
    taskId: string,
    workItemId: string
  ): Promise<ManagedWorkspace> {
    const item = requireWorkItem(this.store, taskId, workItemId);
    const task = requireTask(this.store, item.taskId);
    assertWorkItemWorkspaceEligible(this.store, task, item);
    // Hold the per-Project maintenance fence across the ensure-main-prepared
    // and the WorkItem worktree creation, so concurrent Project maintenance
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
            : await this.git.inspect(mainEntry.path, requestedBaseRef);
          const physical = await this.git.ensureWorktree({
            repositoryPath: mainEntry.path,
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
            if (!await this.git.isAncestor(mainEntry.path, previous.baseCommit, physical.baseCommit)) {
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
          const activeDevelopTurn = tx.listTurns(lockedTask.id)
            .find((run) => run.status === "active" && run.workItemId === item.id);
          if (activeDevelopTurn !== undefined) {
            throw new Error(`Work Item already has an active Develop Turn: ${activeDevelopTurn.id}.`);
          }
          if (latestItem.assignee !== undefined
            && tx.getActiveTurn(lockedTask.id, latestItem.assignee) !== null) {
            throw new Error(`Role has an active Turn: ${lockedTask.id}/${latestItem.assignee}.`);
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
      inputHeads?: readonly Readonly<{ projectId: string; headCommit: string }>[];
    }>,
    heldFence?: Readonly<{ current: Task }>
  ): Promise<ManagedWorkspace> {
    const task = requireTask(this.store, taskId);
    // Hold the per-Project maintenance fence across Lane worktree creation
    // (both the reuse and the fresh-mint paths), so a concurrent
    // Project maintenance cannot switch the Project catalog mid-prepare. A
    // dispatch preflight that prepares a whole new Group passes the fence it
    // already holds (one locked boundary across preparation and adoption);
    // otherwise the fence is acquired here.
    const { release, current: lockedTask } = heldFence === undefined
      ? this.#acquireTaskProjectMaintenanceLocks(task)
      : { release: () => {}, current: heldFence.current };
    try {
      const lineage = executionLaneLineage(this.store, lockedTask, executionGroupId, executionLaneId, hint);
      const item = lineage.purpose === "execution"
        ? this.store.getWorkItem(taskId, lineage.workItemId)
        : null;
      const source = lineage.purpose === "execution"
        ? item?.assignee === LEADER_ROLE
          ? this.store.getTaskWorkspace(taskId)
          : this.store.getWorkItemWorkspace(taskId, lineage.workItemId)
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
      const writable = new Set(lineage.purpose === "execution"
        ? item?.writeProjectIds ?? []
        : lockedTask.projectBindings.map(({ projectId }) => projectId));
      const inputHeadByProject = new Map(
        (hint?.inputHeads ?? []).map(({ projectId, headCommit }) => [projectId, headCommit])
      );
      if (hint?.inputHeads !== undefined
        && (inputHeadByProject.size !== hint.inputHeads.length
          || inputHeadByProject.size !== writable.size
          || [...writable].some((projectId) => !inputHeadByProject.has(projectId)))) {
        throw new Error(`Execution Lane input heads do not match writable scope: ${executionLaneId}.`);
      }
      const existing = this.store.getManagedWorkspace(owner);
      if (existing !== null) {
        if (existing.owner.type !== "execution-lane" || existing.root !== this.#executionLaneWorkspaceRoot(taskId, executionGroupId, executionLaneId)) {
          throw new Error(`Execution Lane managed workspace identity changed: ${taskId}/${executionLaneId}.`);
        }
        await ensureWorkspaceView(existing.root, existing.entries);
        this.#registerWorkspace(existing);
        for (const entry of existing.entries.filter(({ access }) => access === "write")) {
          const inputHead = inputHeadByProject.get(entry.projectId);
          if (hint?.inputHeads !== undefined && inputHead !== entry.baseCommit) {
            throw new Error(`Execution Lane input head changed: ${executionLaneId}/${entry.projectId}.`);
          }
          const project = requireProject(this.store, entry.projectId);
          const physical = await this.git.ensureWorktree({
            repositoryPath: this.#taskRepositoryPath(taskId, project.id),
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
      const prepared: Array<Readonly<{ project: Project; entry: WorkspaceProjectEntry }>> = [];
      try {
        for (const binding of lockedTask.projectBindings) {
          const project = requireProject(this.store, binding.projectId);
          const sourceEntry = requireWorkspaceEntry(source, project.id);
          if (!writable.has(project.id)) {
            prepared.push({ project, entry: { ...sourceEntry, access: "read" } });
            continue;
          }
          const inputHead = inputHeadByProject.get(project.id) ?? sourceEntry.baseCommit;
          const physical = await this.git.ensureWorktree({
            repositoryPath: this.#taskRepositoryPath(taskId, project.id),
            container: this.#projectContainer(project.name),
            taskSegment,
            roleName: managedWorktreeName(owner),
            baseRef: inputHead
          });
          if (physical.baseCommit !== inputHead) {
            throw new Error(`Execution Lane physical input head changed: ${executionLaneId}/${project.id}.`);
          }
          prepared.push({
            project,
            entry: {
              ...sourceEntry,
              access: "write",
              path: physical.path,
              branch: physical.branch,
              baseRef: inputHead,
              baseCommit: inputHead
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


  async cleanupExecutionLaneWorkspace(
    taskId: string,
    executionGroupId: string,
    executionLaneId: string
  ): Promise<GitWorkspaceRemoval> {
    const task = requireTask(this.store, taskId);
    const located = cleanupExecutionLaneLineage(
      this.store,
      task,
      executionGroupId,
      executionLaneId
    );
    const { lineage, legacyGroup } = located;
    const item = lineage.purpose === "execution"
      ? this.store.getWorkItem(taskId, lineage.workItemId)
      : null;
    const group = legacyGroup ?? (lineage.purpose === "execution"
      ? (item === null ? undefined : workItemExecutionGroupById(item, executionGroupId))
      : this.store.getReviewRound(taskId, lineage.reviewRoundId)?.executionGroup);
    const lane = group?.lanes.find(({ id }) => id === executionLaneId);
    const terminal = legacyGroup !== undefined
      ? lane !== undefined
      : lane === undefined
      ? false
      : "disposition" in lane
        ? lane.disposition !== "open"
        : ["completed", "failed", "skipped"].includes(lane.status);
    if (group === undefined
      || lane === undefined || !terminal) {
      throw new Error(`Execution Lane is not terminally resolved: ${taskId}/${executionLaneId}.`);
    }
    const workspace = this.store.listManagedWorkspaces(taskId).find(({ owner }) => (
      owner.type === "execution-lane"
      && owner.executionGroupId === executionGroupId
      && owner.executionLaneId === executionLaneId
    ));
    if (workspace === undefined) return "missing";
    const state = await this.#inspectEntries(
      task.id,
      this.#taskSegment(task),
      managedWorktreeName(workspace.owner),
      workspace.entries.filter(({ access }) => access === "write")
    );
    if (state === "dirty") return "dirty";
    let removed = false;
    for (const entry of workspace.entries.filter(({ access }) => access === "write")) {
      const project = requireProject(this.store, entry.projectId);
      const result = await this.git.removeWorktree({
        repositoryPath: this.#taskRepositoryPath(task.id, project.id),
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
        task.id,
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
        repositoryPath: this.#taskRepositoryPath(task.id, project.id),
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
    const groups = item === null
      ? []
      : [...item.executionGroups, ...legacyExecutionGroups(item)];
    for (const group of groups) for (const lane of group.lanes) {
      const owner = this.store.listManagedWorkspaces(taskId).find(({ owner }) => (
        owner.type === "execution-lane" && owner.purpose === "execution"
          && owner.workItemId === workItemId
          && owner.executionGroupId === group.id
          && owner.executionLaneId === lane.id
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
      this.#taskSegment(requireTask(this.store, item.taskId)),
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
    const taskScope = (round.scope ?? "work-item") === "task";
    const item = taskScope || round.workItemId === undefined
      ? undefined
      : requireWorkItem(this.store, task.id, round.workItemId);
    const candidate = taskScope
      ? undefined
      : item?.candidates.find(({ id }) => id === round.candidateId);
    if (!taskScope && candidate === undefined) {
      throw new Error(`ReviewRound Candidate not found: ${round.candidateId}.`);
    }
    // A WorkItem ReviewRound is an immutable snapshot of Develop. A Task
    // ReviewRound instead freezes every bound Project at the unified Task
    // heads and deliberately has no WorkItem/Candidate anchor.
    const develop = candidate?.workspace;
    if (!taskScope && (develop === undefined || candidate?.gitSnapshot === undefined)) {
      throw new Error(`Candidate has no frozen managed Git snapshot: ${candidate?.id ?? "unknown"}.`);
    }
    if (!taskScope && candidate!.gitSnapshot!.reviewBaseCommit !== round.reviewBaseCommit) {
      throw new Error(`ReviewRound base no longer matches its Candidate: ${round.id}.`);
    }
    const reviewer = this.store.getRole(task.id, round.reviewerRoleName);
    if (reviewer === null) {
      throw new Error(`Reviewer Role not found: ${task.id}/${round.reviewerRoleName}.`);
    }
    const snapshotCommits = new Map(
      (taskScope
        ? round.taskCandidate?.projects ?? []
        : candidate!.gitSnapshot!.projects
      ).map(({ projectId, commit }) => [projectId, commit])
    );
    const frozenEntries = taskScope
      ? task.projectBindings.map((binding) => {
          const commit = snapshotCommits.get(binding.projectId);
          if (commit === undefined) {
            throw new Error(`Task Review candidate Project is missing: ${binding.projectId}.`);
          }
          const project = requireProject(this.store, binding.projectId);
          const identity = worktreeIdentity(taskSegment, this.#reviewWorktreeName(round));
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
    const reviewRoot = this.#reviewRoundWorkspaceRoot(task.id, round);
    if (taskScope && existing === null) {
      const reassigned = await this.#reassignTaskReviewWorkspace(
        task,
        round,
        reviewer,
        reviewRoot,
        frozenEntries
      );
      if (reassigned !== null) return reassigned;
    }
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
        const identity = worktreeIdentity(taskSegment, this.#reviewWorktreeName(round));
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
        const taskRepository = this.#taskRepositoryPath(task.id, project.id);
        const projectRoot = await this.git.inspect(taskRepository, "HEAD");
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
            taskRepository,
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
          repositoryPath: this.#taskRepositoryPath(task.id, project.id),
          container: this.#projectContainer(project.name),
          taskSegment,
          roleName: this.#reviewWorktreeName(round),
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
              this.#taskRepositoryPath(task.id, project.id),
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
        const currentItem = item === undefined ? null : tx.getWorkItem(task.id, item.id);
        const candidateChanged = taskScope
          ? currentRound === null
            || !isDeepStrictEqual(currentRound.taskCandidate, round.taskCandidate)
          : currentItem === null
            || !isDeepStrictEqual(
              currentItem.candidates.find(({ id }) => id === candidate!.id),
              candidate
            );
        if (currentRound === null || currentRound.status !== "pending"
          || candidateChanged) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `ReviewRound changed while preparing its workspace: ${round.id}.`
          );
        }
        if (tx.getActiveTurn(task.id, reviewer.name) !== null) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `Reviewer Role has an active Turn: ${task.id}/${reviewer.name}.`
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
        this.#reviewWorktreeName(round),
        existing === null,
        new Set([...retained.values()].map(({ entry }) => entry.path))
      );
      throw error;
    }
    } finally {
      release();
    }
  }

  /**
   * Keep one physical workspace per Task Reviewer Role. A new semantic Round
   * receives a new immutable ManagedWorkspace owner and frozen base record,
   * while a clean, unmodified terminal workspace is reset in place so the
   * provider-native Reviewer Session can continue at the same cwd.
   */
  async #reassignTaskReviewWorkspace(
    task: Task,
    round: ReviewRound,
    reviewer: TaskRole,
    reviewRoot: string,
    frozenEntries: readonly WorkspaceProjectEntry[]
  ): Promise<ManagedWorkspace | null> {
    const previous = this.store.listReviewRounds(task.id)
      .filter((candidate) => (
        candidate.id !== round.id
        && (candidate.scope ?? "work-item") === "task"
        && candidate.reviewerRoleName === round.reviewerRoleName
        && (candidate.status === "completed" || candidate.status === "failed")
        && candidate.workspaceDisposition?.kind !== "removed"
        && candidate.workspaceDisposition?.kind !== "reassigned"
      ))
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id, undefined, { numeric: true })
      ))
      .at(-1);
    if (previous === undefined) return null;
    const previousWorkspace = this.store.getReviewRoundWorkspace(task.id, previous.id);
    if (previousWorkspace === null) return null;
    if (previous.workspace === undefined
      || !isDeepStrictEqual(previous.workspace, previousWorkspace)
      || previousWorkspace.root !== reviewRoot) {
      throw new ReviewRoundWorkspaceEvidenceError(
        `Previous Task-final Review workspace cannot be continued: ${previous.id}.`
      );
    }
    if (this.store.getActiveTurn(task.id, reviewer.name) !== null) {
      throw new ReviewRoundWorkspaceEvidenceError(
        `Reviewer Role has an active Turn: ${task.id}/${reviewer.name}.`
      );
    }
    const expected = new Map(frozenEntries.map((entry) => [entry.projectId, entry] as const));
    if (previousWorkspace.entries.length !== expected.size) {
      throw new ReviewRoundWorkspaceEvidenceError(
        `Task-final Review Project scope changed for Reviewer ${reviewer.name}.`
      );
    }
    const nextEntries: WorkspaceProjectEntry[] = [];
    const reset: Array<Readonly<{ path: string; previousHead: string; nextHead: string }>> = [];
    for (const prior of previousWorkspace.entries) {
      const next = expected.get(prior.projectId);
      if (next === undefined
        || prior.path !== next.path
        || prior.branch !== next.branch
        || prior.directory !== next.directory
        || prior.access !== "write") {
        throw new ReviewRoundWorkspaceEvidenceError(
          `Task-final Review workspace identity changed for ${reviewer.name}/${prior.projectId}.`
        );
      }
      const physical = await this.git.inspect(prior.path, "HEAD");
      if (!await this.git.isClean(prior.path)
        || !sameCommit(physical.baseCommit, prior.baseCommit)) {
        throw new ReviewRoundWorkspaceEvidenceError(
          `Previous Task-final Review workspace contains retained diagnostics: `
          + `${previous.id}/${prior.projectId}; preserve or clean it before continuing the Reviewer Session.`
        );
      }
      nextEntries.push({
        ...next,
        path: prior.path,
        branch: prior.branch,
        baseRef: next.baseCommit,
        baseCommit: next.baseCommit
      });
      if (!sameCommit(physical.baseCommit, next.baseCommit)) {
        reset.push({
          path: prior.path,
          previousHead: physical.baseCommit,
          nextHead: next.baseCommit
        });
      }
    }
    const stored = createManagedWorkspace({
      owner: { type: "review-round", taskId: task.id, reviewRoundId: round.id },
      root: reviewRoot,
      entries: nextEntries
    }, this.now());
    try {
      for (const entry of reset) {
        await this.git.resetWorktree({
          targetPath: entry.path,
          expectedHead: entry.previousHead,
          restoreHead: entry.nextHead
        });
      }
      await ensureWorkspaceView(reviewRoot, nextEntries);
      const reassigned = this.store.transaction((tx) => {
        const currentPrevious = tx.getReviewRound(task.id, previous.id);
        const currentRound = tx.getReviewRound(task.id, round.id);
        const currentPreviousWorkspace = tx.getReviewRoundWorkspace(task.id, previous.id);
        if (currentPrevious === null
          || currentPrevious.status !== previous.status
          || currentPrevious.workspaceDisposition?.kind === "removed"
          || currentPrevious.workspaceDisposition?.kind === "reassigned"
          || currentPreviousWorkspace === null
          || !sameManagedWorkspace(currentPreviousWorkspace, previousWorkspace)
          || currentRound === null
          || currentRound.status !== "pending"
          || currentRound.workspace !== undefined
          || !isDeepStrictEqual(currentRound.taskCandidate, round.taskCandidate)
          || tx.getReviewRoundWorkspace(task.id, round.id) !== null
          || tx.getActiveTurn(task.id, reviewer.name) !== null) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `Task-final Review workspace changed before reassignment: ${previous.id}/${round.id}.`
          );
        }
        const latestReviewer = tx.getRole(task.id, reviewer.name);
        if (latestReviewer === null || latestReviewer.workspace !== reviewRoot) {
          throw new ReviewRoundWorkspaceEvidenceError(
            `Reviewer Role workspace changed before reassignment: ${reviewer.name}.`
          );
        }
        tx.removeManagedWorkspace(previousWorkspace.owner);
        tx.saveReviewRound(task.id, recordReviewWorkspaceDisposition(
          currentPrevious,
          "reassigned",
          this.now()
        ));
        tx.saveManagedWorkspace(stored);
        tx.saveReviewRound(task.id, attachReviewRoundWorkspace(currentRound, stored));
        return stored;
      });
      this.#registerWorkspace(reassigned);
      return reassigned;
    } catch (error) {
      for (const entry of [...reset].reverse()) {
        try {
          await this.git.resetWorktree({
            targetPath: entry.path,
            expectedHead: entry.nextHead,
            restoreHead: entry.previousHead
          });
        } catch {
          // Keep the original failure; the durable owner still names the
          // previous Round and exposes any compensation problem for cleanup.
        }
      }
      await ensureWorkspaceView(reviewRoot, previousWorkspace.entries);
      throw error;
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
    return this.#inspectEntries(
      task.id,
      this.#taskSegment(task),
      this.#reviewWorktreeName(round),
      workspace.entries
    );
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
   * Snapshot the exact workspace recorded on one Reviewer Turn. Panel Lanes
   * own separate durable workspaces; the ReviewRound's shared workspace is
   * not a valid substitute for a Lane's branch/head evidence.
   */
  async snapshotReviewRunResult(
    taskId: string,
    run: Turn
  ): Promise<Readonly<{ evidenceCommit?: string }>> {
    if (run.taskId !== taskId || run.purpose !== "review" || run.reviewRoundId === undefined) {
      throw new Error(`Turn is not an exact ReviewRound Turn: ${run.id}.`);
    }
    if (run.workspace === undefined) {
      throw new Error(`Review Turn has no managed workspace: ${run.id}.`);
    }
    const round = this.store.getReviewRound(taskId, run.reviewRoundId);
    if (round === null || round.status !== "running") {
      throw new Error(`ReviewRound is not running for Review Turn: ${run.id}.`);
    }
    const stored = this.store.getManagedWorkspace(run.workspace.owner);
    if (stored === null || !isDeepStrictEqual(stored, run.workspace)) {
      throw new Error(`Review Turn workspace is not the durable owner: ${run.id}.`);
    }
    if (run.workspace.owner.type === "review-round") {
      if (run.workspace.owner.taskId !== taskId
        || run.workspace.owner.reviewRoundId !== round.id
        || round.workspace === undefined
        || !isDeepStrictEqual(round.workspace, run.workspace)) {
        throw new Error(`Review Turn workspace owner does not match its ReviewRound: ${run.id}.`);
      }
      return this.#snapshotReviewWorkspaceEntries(round.id, run.workspace, round.reviewBaseCommit);
    }
    if (run.workspace.owner.type !== "execution-lane"
      || run.workspace.owner.taskId !== taskId
      || run.workspace.owner.purpose !== "review"
      || run.workspace.owner.reviewRoundId !== round.id
      || run.workspace.owner.executionGroupId !== run.executionGroupId
      || run.workspace.owner.executionLaneId !== run.executionLaneId) {
      throw new Error(`Review Turn workspace owner does not match its Lane lineage: ${run.id}.`);
    }
    const lane = round.executionGroup?.lanes.find(({ id }) => id === run.executionLaneId);
    const writableProjectIds = run.workspace.entries
      .filter(({ access }) => access === "write")
      .map(({ projectId }) => projectId)
      .sort();
    if (lane === undefined
      || lane.turnId !== run.id
      || lane.roleName !== run.roleName
      || lane.reviewRoundId !== round.id
      || lane.workspace?.root !== run.workspace.root
      || !isDeepStrictEqual(
        [...lane.workspace.writableProjectIds].sort(),
        writableProjectIds
      )
      || run.workspace.entries.length === 0
      || run.workspace.entries.some(({ access }) => access !== "write")) {
      throw new Error(`Review Turn Lane workspace lineage is not exact: ${run.id}.`);
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
      task.id,
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
    if (round.workspaceDisposition?.kind === "removed"
      || round.workspaceDisposition?.kind === "reassigned") return "missing";
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
      task.id,
      this.#taskSegment(task),
      this.#reviewWorktreeName(round),
      workspace.entries
    ) === "dirty") return "dirty";
    let removed = false;
    for (const entry of workspace.entries) {
      const project = requireProject(this.store, entry.projectId);
      const result = await this.git.removeWorktree({
        repositoryPath: this.#taskRepositoryPath(task.id, project.id),
        container: this.#projectContainer(project.name),
        taskSegment: this.#taskSegment(task),
        roleName: this.#reviewWorktreeName(round),
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
      task.id,
      this.#taskSegment(task),
      managedWorktreeName(workspace.owner),
      writable
    ) === "dirty") return "dirty";
    let removed = false;
    for (const entry of writable) {
      const project = requireProject(this.store, entry.projectId);
      const result = await this.git.removeWorktree({
        repositoryPath: this.#taskRepositoryPath(task.id, project.id),
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

  async inspectIntegrationWorkspace(
    taskId: string,
    integrationId: string
  ): Promise<GitWorkspaceState> {
    const workspace = this.store.getIntegrationWorkspace(taskId, integrationId);
    if (workspace === null) return "missing";
    if (workspace.owner.type !== "integration-attempt"
      || workspace.owner.integrationAttemptId !== integrationId) {
      throw new Error(`Integration workspace ownership is invalid: ${taskId}/${integrationId}.`);
    }
    let found = false;
    for (const entry of workspace.entries.filter(({ access }) => access === "write")) {
      try {
        if (!await this.git.isClean(entry.path)) return "dirty";
        found = true;
      } catch (error) {
        if (error instanceof Error && error.message.includes("No such file")) continue;
        throw error;
      }
    }
    return found ? "clean" : "missing";
  }

  async cleanupIntegrationWorkspace(
    taskId: string,
    integrationId: string
  ): Promise<GitWorkspaceRemoval> {
    const task = requireTask(this.store, taskId);
    const attempt = this.store.getIntegrationAttempt(task.id, integrationId);
    if (attempt === null) {
      throw new Error(`IntegrationAttempt not found: ${task.id}/${integrationId}.`);
    }
    if (attempt.status === "running"
      || attempt.status === "blocked"
      || attempt.status === "validating") {
      throw new Error(`IntegrationAttempt must be terminal before cleanup: ${attempt.id}.`);
    }
    const workspace = this.store.getIntegrationWorkspace(task.id, attempt.id);
    const project = requireProject(this.store, attempt.projectId);
    const result = await this.git.removeIntegrationWorktree({
      repositoryPath: this.#taskRepositoryPath(task.id, project.id),
      container: this.#projectContainer(project.name),
      taskSegment: this.#taskSegment(task),
      integrationId: attempt.id,
      discardChanges: attempt.status === "failed"
    });
    if (result !== "dirty") {
      if (workspace !== null) this.#resourceRegistrar().markWorkspaceDeleted(workspace);
      await rm(join(
        this.home,
        "artifacts",
        "integration-checks",
        task.id,
        attempt.id
      ), { recursive: true, force: true });
      this.store.removeManagedWorkspace({
        type: "integration-attempt",
        taskId: task.id,
        integrationAttemptId: attempt.id
      });
    }
    return result;
  }

  async inspectTaskMainWorkspace(taskId: string): Promise<GitWorkspaceState> {
    const task = requireTask(this.store, taskId);
    const main = this.store.getTaskWorkspace(task.id);
    if (main === null) return "missing";
    if (main.owner.type !== "task") {
      throw new Error(`Task main workspace ownership is invalid: ${task.id}.`);
    }
    return this.#inspectEntries(task.id, this.#taskSegment(task), MAIN_WORKTREE, main.entries);
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
      if (await this.#inspectEntries(
        task.id,
        this.#taskSegment(task),
        MAIN_WORKTREE,
        main.entries
      ) === "dirty") {
        return {
          taskId,
          status: "retained-dirty",
          ...(task.cwd === undefined ? {} : { path: task.cwd })
        };
      }
      for (const entry of main.entries) {
        assertTaskArchiveState(requireTask(this.store, task.id), task);
        const result = await this.git.removeStrandedWorktree(entry.path);
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

  async #inspectEntries(
    taskId: string,
    taskSegment: string,
    roleName: string,
    entries: readonly WorkspaceProjectEntry[]
  ): Promise<GitWorkspaceState> {
    if (entries.length === 0) return "missing";
    let found = false;
    for (const entry of entries) {
      const project = requireProject(this.store, entry.projectId);
      const state = await this.git.inspectWorktree({
        repositoryPath: this.#taskRepositoryPath(taskId, project.id),
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
      const taskId = workspace.owner.taskId;
      if (!await this.git.isAncestor(
        this.#taskRepositoryPath(taskId, entry.projectId),
        entry.baseCommit,
        head
      )) {
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

  #reviewRoundWorkspaceRoot(taskId: string, round: ReviewRound): string {
    return join(resolveTaskRoot(this.home, this.store.getConfig().defaultWorkspace),
      safePathSegment(taskId), "reviews", safePathSegment(this.#reviewWorktreeName(round)));
  }

  #reviewWorktreeName(round: ReviewRound): string {
    return (round.scope ?? "work-item") === "task"
      ? `reviewer-${round.reviewerRoleName}`
      : round.id;
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
      if (roleName === MAIN_WORKTREE) {
        const removal = await this.git.removeStrandedWorktree(entry.path);
        if (removal === "dirty") {
          throw new Error(
            `Unadopted Task clone is dirty and was retained at ${entry.path}; inspect it and retry.`
          );
        }
        this.#resourceRegistrar().markPathsDeleted([entry.path]);
        continue;
      }
      const removal = await this.git.removeWorktree({
        repositoryPath: this.#taskRepositoryPath(task.id, project.id),
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

  #taskRepositoryPath(taskId: string, projectId: string): string {
    const workspace = this.store.getTaskWorkspace(taskId);
    if (workspace === null || workspace.owner.type !== "task") {
      throw new Error(`Task main workspace is unavailable: ${taskId}.`);
    }
    const entry = workspace.entries.find((candidate) => candidate.projectId === projectId);
    if (entry === undefined) {
      throw new Error(`Task main Project workspace is unavailable: ${taskId}/${projectId}.`);
    }
    return entry.path;
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

function recordTaskActivation(
  store: TaskStore,
  previous: Task,
  active: Task,
  now: Date
): void {
  enqueueWork(
    store,
    { kind: "role", taskId: active.id, roleName: LEADER_ROLE },
    "task-created",
    now,
    [{ type: "task", id: active.id }]
  );
  enqueueWork(
    store,
    { kind: "task", taskId: active.id },
    "task-activated",
    now,
    [{ type: "task", id: active.id }]
  );
  store.saveEvent(active.id, createTaskEvent(
    store.nextEventId(active.id),
    active.id,
    "task.activated",
    { fromStatus: previous.status, status: active.status },
    now
  ));
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

type ExecutionLaneLineage = Readonly<
  | { purpose: "execution"; workItemId: string; reviewRoundId: "" }
  | { purpose: "review"; reviewRoundId: string; workItemId?: undefined }
>;

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
    return { purpose: "review", reviewRoundId: round.id };
  }
  // Prefer the active Turn's exact WorkItem for this Lane; fall back to the
  // first queued WorkItem only when no active Turn owns the Lane.
  const activeLaneRun = store.listTurns(task.id)
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
      return { purpose: "review", reviewRoundId: round.id };
    }
  }
  throw new Error(`Execution Lane lineage not found: ${task.id}/${executionGroupId}/${executionLaneId}.`);
}

type CleanupExecutionLaneLineage = Readonly<{
  lineage: ExecutionLaneLineage;
  /** Pre-v14 history is retired authority and is reachable here only for cleanup. */
  legacyGroup?: ExecutionGroup;
}>;

function cleanupExecutionLaneLineage(
  store: TaskStore,
  task: Task,
  executionGroupId: string,
  executionLaneId: string
): CleanupExecutionLaneLineage {
  try {
    return {
      lineage: executionLaneLineage(store, task, executionGroupId, executionLaneId)
    };
  } catch (error) {
    for (const item of store.listWorkItems(task.id)) {
      const group = legacyExecutionGroups(item).find((candidate) => (
        candidate.id === executionGroupId
          && candidate.lanes.some(({ id }) => id === executionLaneId)
      ));
      if (group !== undefined) {
        return {
          lineage: { purpose: "execution", workItemId: item.id, reviewRoundId: "" },
          legacyGroup: group
        };
      }
    }
    throw error;
  }
}

function legacyExecutionGroups(item: WorkItem): readonly ExecutionGroup[] {
  return (item.legacyExecutionGroups ?? []).map((group) => (
    validateExecutionGroup(group as ExecutionGroup)
  ));
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
  const activeDevelopTurn = store.listTurns(task.id)
    .find((run) => run.status === "active" && run.workItemId === item.id);
  if (activeDevelopTurn !== undefined) {
    throw new Error(`Work Item already has an active Develop Turn: ${activeDevelopTurn.id}.`);
  }
  if (item.assignee !== undefined && store.getActiveTurn(task.id, item.assignee) !== null) {
    throw new Error(`Role has an active Turn: ${task.id}/${item.assignee}.`);
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
  if (store.getActiveTurn(taskId, roleName) !== null) {
    throw new Error(`Role has an active Turn: ${taskId}/${roleName}.`);
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
  if (store.getActiveTurn(taskId, roleName) !== null) {
    throw new Error(`Role has an active Turn: ${taskId}/${roleName}.`);
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

  const run = store.getActiveTurn(taskId, role.name);
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
      || executionRef?.type !== "turn"
      || executionRef.taskId !== taskId
      || executionRef.id !== run.id
    ) return false;
  }
  return true;
}

function sameEffectiveWorkspace(
  effective: Turn["effective"]["workspace"],
  workspace: ManagedWorkspace
): boolean {
  return effective.root === workspace.root
    && isDeepStrictEqual(effective.entries, workspace.entries);
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
