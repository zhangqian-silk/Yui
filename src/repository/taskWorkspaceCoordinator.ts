import { isDeepStrictEqual } from "node:util";

import { retireConfirmedAbsentInactiveTaskRolePlaceholders } from "../executor/agentExecutor.js";
import {
  hasRuntimeLifecycleWork,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import type { ReviewRound } from "../review/reviewRound.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
import type {
  WorkItem,
  WorkItemWorkspaceDisposition
} from "../workItem/workItem.js";
import {
  managedWorkspaceKey,
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
import type { GitWorkspaceRemoval } from "./gitWorkspace.js";
import { acquireProjectMaintenanceLocks } from "./projectMaintenanceLock.js";
import {
  FileTaskWorkspacePreparer,
  WorkspaceCleanupBlockedError,
  type TaskWorkspaceCleanup
} from "./taskWorkspacePreparer.js";

export { WorkspaceCleanupBlockedError } from "./taskWorkspacePreparer.js";

export type TaskRoleRuntimeStopper = Readonly<{
  stopTaskRoleSessions(taskId: string, roleNames: readonly string[]): Promise<void>;
  inspectTaskRolePanes?(taskId: string): readonly Readonly<{
    roleName: string;
    dead: boolean;
  }>[];
  /**
   * Issue 03 archive postcondition. Proves the Task owns no live physical
   * Session resources (Provider roots, tmux panes) before its workspaces are
   * deleted. Implementations must no-op in the default `report` reconcile
   * mode; in `exact-owner-cleanup` mode they throw
   * {@link WorkspaceCleanupBlockedError} while owned resources remain live.
   */
  assertTaskPhysicalResourcesReleased?(taskId: string): Promise<void>;
}>;

type TaskArchiveSnapshot = Readonly<{
  task: Task;
  managedWorkspaces: readonly ManagedWorkspace[];
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
    const activeDevelopRun = this.store.listAgentRuns(item.taskId)
      .find((run) => run.status === "active" && run.workItemId === item.id);
    if (activeDevelopRun !== undefined) {
      throw new Error(`Work Item already has an active Develop Run: ${activeDevelopRun.id}.`);
    }
    const task = this.store.getTask(item.taskId)!;
    const taskProjectIds = task.projectBindings.map(({ projectId }) => projectId);
    const existing = this.store.getWorkItemWorkspace(item.taskId, item.id);
    if (existing !== null
      && existing.owner.type === "work-item"
      && existing.owner.workItemId === item.id
      && sameProjectScope(existing, taskProjectIds, item.writeProjectIds)
      && item.baseRefs === undefined) return existing;
    if (existing !== null) {
      if (existing.owner.type !== "work-item" || existing.owner.workItemId !== item.id) {
        throw new Error(`WorkItem already has another managed workspace: ${item.taskId}/${item.id}.`);
      }
    }
    await this.preparer.prepareTaskWorkspace(item.taskId);
    const prepared = this.store.getWorkItemWorkspace(item.taskId, item.id);
    if (prepared !== null
      && prepared.owner.type === "work-item"
      && prepared.owner.workItemId === item.id
      && sameProjectScope(prepared, taskProjectIds, item.writeProjectIds)
      && item.baseRefs === undefined) return prepared;
    if (prepared !== null) {
      if (prepared.owner.type !== "work-item" || prepared.owner.workItemId !== item.id) {
        throw new Error(`WorkItem already has another managed workspace: ${item.taskId}/${item.id}.`);
      }
    }
    if (assignee !== undefined) await this.#stopLiveRoles(item.taskId, [assignee]);
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
    if (item.workspaceDisposition !== undefined
      && item.workspaceDisposition !== disposition) {
      throw new Error(
        `Work item workspace is already recorded as ${item.workspaceDisposition}.`
      );
    }
    if (item.workspaceDisposition === disposition) return "missing";
    // Hold the per-Project maintenance fence so a concurrent migrate/rebuild/
    // archive cannot interleave with worktree removal.
    const workspace = this.store.getWorkItemWorkspace(item.taskId, item.id);
    const projectIds = workspace === null
      ? []
      : workspace.entries
        .filter(({ access }) => access === "write")
        .map(({ projectId }) => projectId);
    const releaseMaintenance = projectIds.length === 0
      ? () => {}
      : acquireProjectMaintenanceLocks(this.preparer.home, projectIds);
    try {
      const state = await this.preparer.inspectWorkItemWorkspace(item.taskId, item.id);
      if (state === "dirty") return "dirty";
      this.#assertWorkItemRuntimeQuiescent(item);
      this.#assertNoActiveWorkItemDurableJobs(item);
      await this.#stopLiveRoles(item.taskId, this.#workItemRoleNames(item));
      const laneCleanup = await this.preparer.cleanupExecutionLaneWorkspacesForWorkItem(
        item.taskId,
        item.id
      );
      if (laneCleanup === "dirty") return "dirty";
      return this.preparer.cleanupWorkItemWorkspace(item.taskId, item.id, disposition);
    } finally {
      releaseMaintenance();
    }
  }

  async cleanupWorkItemRuntime(
    taskId: string,
    workItemId: string
  ): Promise<"released"> {
    const item = this.store.getWorkItem(taskId, workItemId);
    if (item === null) throw new Error(`Work item not found: ${taskId}/${workItemId}.`);
    this.#assertWorkItemRuntimeQuiescent(item);
    await this.#stopLiveRoles(item.taskId, this.#workItemRoleNames(item));
    return "released";
  }

  /**
   * Stops one Task Role's physical runtime without changing its workspace.
   * The caller owns the subsequent atomic record retirement and wake.
   */
  async cleanupTaskRoleRuntime(
    taskId: string,
    roleName: string
  ): Promise<"released"> {
    await this.#stopLiveRoles(taskId, [roleName]);
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
    if (round.workspaceDisposition?.kind === "reassigned") return "missing";
    // Hold the per-Project maintenance fence so a concurrent migrate/rebuild/
    // archive cannot interleave with worktree removal.
    const workspace = this.store.getReviewRoundWorkspace(taskId, reviewRoundId);
    const projectIds = workspace === null
      ? []
      : workspace.entries
        .filter(({ access }) => access === "write")
        .map(({ projectId }) => projectId);
    const releaseMaintenance = projectIds.length === 0
      ? () => {}
      : acquireProjectMaintenanceLocks(this.preparer.home, projectIds);
    try {
      const state = await this.preparer.inspectReviewRoundWorkspace(taskId, reviewRoundId);
      if (state === "dirty") return "dirty";
      await this.#stopLiveRoles(taskId, this.#reviewRoundRoleNames(round));
      const laneCleanup = await this.preparer.cleanupExecutionLaneWorkspacesForReviewRound(
        taskId,
        reviewRoundId
      );
      if (laneCleanup === "dirty") return "dirty";
      return this.preparer.cleanupReviewRoundWorkspace(taskId, reviewRoundId);
    } finally {
      releaseMaintenance();
    }
  }

  async cleanupTaskForArchive(
    taskId: string,
    disposition: WorkItemWorkspaceDisposition
  ): Promise<TaskWorkspaceCleanup> {
    let releaseMaintenance: (() => void) | undefined;
    try {
      const task = this.store.getTask(taskId);
      if (task === null) throw new Error(`Task not found: ${taskId}.`);
      if (task.status !== "completed" && task.status !== "retired") {
        throw new Error(`Task must be completed or retired before archive cleanup: ${task.id}.`);
      }
      const managedWorkspaces = [...this.store.listManagedWorkspaces(task.id)]
        .sort((left, right) => managedWorkspaceKey(left.owner)
          .localeCompare(managedWorkspaceKey(right.owner)));
      // Archive cleanup removes worktrees from every Project the Task uses:
      // hold each Project's maintenance fence so the Controller defers
      // preparation and no migrate/rebuild/archive interleaves.
      const projectIds = new Set(task.projectBindings.map(({ projectId }) => projectId));
      for (const workspace of managedWorkspaces) {
        for (const entry of workspace.entries) projectIds.add(entry.projectId);
      }
      releaseMaintenance = acquireProjectMaintenanceLocks(this.preparer.home, projectIds);
      const laneWorkspaces = managedWorkspaces.filter(({ owner }) => owner.type === "execution-lane");
      const workspaces = managedWorkspaces
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
        managedWorkspaces,
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
      for (const workspace of laneWorkspaces) {
        if (workspace.owner.type !== "execution-lane") continue;
        if (await this.preparer.inspectExecutionLaneWorkspace(
          task.id,
          workspace.owner.executionGroupId,
          workspace.owner.executionLaneId
        ) === "dirty") {
          return {
            taskId,
            status: "retained-dirty",
            ...(task.cwd === undefined ? {} : { path: task.cwd }),
            error: `Execution Lane worktree is dirty: ${managedWorkspaceKey(workspace.owner)}.`,
            reason: "dirty-worktree",
            resource: managedWorkspaceKey(workspace.owner),
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
      await this.runtime.assertTaskPhysicalResourcesReleased?.(task.id);
      this.#assertTaskArchiveSnapshot(snapshot);
      for (const workspace of laneWorkspaces) {
        this.#assertTaskArchiveLifecycle(task);
        if (workspace.owner.type === "execution-lane") {
          await this.preparer.cleanupExecutionLaneWorkspace(
            task.id,
            workspace.owner.executionGroupId,
            workspace.owner.executionLaneId
          );
        }
      }
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
    } finally {
      releaseMaintenance?.();
    }
  }

  #assertTaskArchiveSnapshot(snapshot: TaskArchiveSnapshot): void {
    this.#assertTaskArchiveLifecycle(snapshot.task);
    const managedWorkspaces = [...this.store.listManagedWorkspaces(snapshot.task.id)]
      .sort((left, right) => managedWorkspaceKey(left.owner)
        .localeCompare(managedWorkspaceKey(right.owner)));
    const workItems = [...this.store.listWorkItems(snapshot.task.id)]
      .sort((left, right) => left.id.localeCompare(right.id));
    const reviewRounds = [...this.store.listReviewRounds(snapshot.task.id)]
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!isDeepStrictEqual(managedWorkspaces, snapshot.managedWorkspaces)
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

  #assertWorkItemRuntimeQuiescent(item: WorkItem): void {
    const activeRun = this.store.listAgentRuns(item.taskId)
      .find((run) => run.status === "active" && run.workItemId === item.id);
    if (activeRun !== undefined) {
      throw new WorkspaceCleanupBlockedError(
        "active-run",
        `work-item:${item.taskId}/${item.id}`,
        true,
        `Work item still has an active Run: ${item.taskId}/${item.id}.`
      );
    }
  }

  /**
   * rr5/f4: A WorkItem workspace must not be removed while a DurableJob it
   * owns could still be using it. Queued, running, and unacknowledged
   * unknown-needs-attention jobs are unsettled — the runner (or its corpse)
   * may still hold the worktree. Acknowledged unknown jobs are settled: a
   * human/Leader has taken responsibility for the outcome.
   */
  #assertNoActiveWorkItemDurableJobs(item: WorkItem): void {
    const jobs = this.store.listDurableJobs?.(item.taskId);
    if (jobs === undefined) return;
    const blocking = jobs.filter((job) => (
      job.owner.kind === "work-item"
      && job.owner.workItemId === item.id
      && (
        job.status === "queued"
        || job.status === "running"
        || (job.status === "unknown-needs-attention" && job.acknowledgedAt === undefined)
      )
    ));
    if (blocking.length > 0) {
      throw new WorkspaceCleanupBlockedError(
        "active-durable-job",
        `work-item:${item.taskId}/${item.id}`,
        true,
        `Work item ${item.id} still has ${blocking.length} active DurableJob(s): `
        + `${blocking.map((job) => `${job.id}/${job.status}`).join(", ")}. `
        + "Cancel or acknowledge them before cleanup."
      );
    }
  }

  #workItemRoleNames(item: WorkItem): readonly string[] {
    return [
      ...(item.assignee === undefined ? [] : [item.assignee]),
      ...(item.executionGroups.flatMap((group) => group.lanes.map(({ roleName }) => roleName)))
    ];
  }

  #reviewRoundRoleNames(round: ReviewRound): readonly string[] {
    return [
      round.reviewerRoleName,
      ...(round.executionGroup?.lanes.map(({ roleName }) => roleName) ?? [])
    ];
  }

  async #stopLiveRoles(taskId: string, roleNames: readonly string[]): Promise<void> {
    const targets = [...new Set(roleNames)];
    const getActiveRun = this.store.getActiveAgentRun?.bind(this.store);
    for (const roleName of targets) {
      if (getActiveRun !== undefined && getActiveRun(taskId, roleName) !== null) {
        throw new Error(`Role has an active Run: ${taskId}/${roleName}.`);
      }
      const sessions = this.store.getTaskRoleSessionSet(taskId, roleName);
      if (sessions?.inFlight !== null && sessions?.inFlight !== undefined) {
        throw new Error(`Role has unsettled Run state: ${taskId}/${roleName}.`);
      }
      if (this.store.getWorkMailbox !== undefined && hasRuntimeLifecycleWork(
        this.store.getWorkMailbox(
          runtimeLifecycleTarget({ scope: "task", taskId, roleName })
        )
      )) {
        throw new Error(`Role has unsettled runtime lifecycle state: ${taskId}/${roleName}.`);
      }
    }
    const inspect = this.runtime.inspectTaskRolePanes?.bind(this.runtime);
    const observedPanes = inspect?.(taskId);
    const live = targets.filter((roleName) => {
      const sessions = this.store.getTaskRoleSessionSet(taskId, roleName);
      return observedPanes?.some((pane) => pane.roleName === roleName && !pane.dead) === true
        // A terminal current Session can still carry a resumable native id or
        // Provider binding. Exact cleanup retires both before a workspace or
        // release-control transition is allowed to wake this Role again.
        || (sessions !== null && (
          Object.keys(sessions.sessions).length > 0
          || sessions.providerBinding !== null
        ));
    });
    if (live.length > 0) await this.runtime.stopTaskRoleSessions(taskId, live);

    // The aggregate-16 dormant Claude placeholder is the sole exception to
    // strict workspace-session retirement. The synchronous pane inspection is
    // performed while holding the Task store transaction so a normal launch
    // cannot reserve a Run/Session between absence proof and terminalization.
    if (inspect === undefined || this.store.transaction === undefined) return;
    this.store.transaction((tx) => {
      const panes = inspect(taskId);
      for (const roleName of targets) {
        if (panes.some((pane) => pane.roleName === roleName && !pane.dead)) {
          throw new Error(`Task Role native pane must stop before workspace migration: ${roleName}.`);
        }
        if (tx.getActiveAgentRun(taskId, roleName) !== null) {
          throw new Error(`Role has an active Run: ${taskId}/${roleName}.`);
        }
        if (tx.getWorkMailbox !== undefined && hasRuntimeLifecycleWork(
          tx.getWorkMailbox(
            runtimeLifecycleTarget({ scope: "task", taskId, roleName })
          )
        )) {
          throw new Error(`Role has unsettled runtime lifecycle state: ${taskId}/${roleName}.`);
        }
        const sessions = tx.getTaskRoleSessionSet(taskId, roleName);
        if (sessions === null) continue;
        const retired = retireConfirmedAbsentInactiveTaskRolePlaceholders(
          sessions,
          this.preparer.now()
        );
        if (retired !== sessions) tx.saveTaskRoleSessionSet(retired);
      }
    });
  }

  #workItemIsolationAssignee(item: WorkItem): string | undefined {
    const task = this.store.getTask(item.taskId);
    if (task === null) throw new Error(`Task not found: ${item.taskId}.`);
    if (task.status !== "active") throw new Error(`Task is not active: ${task.id}.`);
    if (task.projectBindings.length === 0) {
      throw new Error(`WorkItem isolation requires a Project-backed Task: ${task.id}.`);
    }
    if (item.assignee === "leader") {
      throw new Error("The Leader must remain in the Task main worktree.");
    }
    if (isTerminalWorkItem(item)) {
      throw new Error(`Work item is already terminal: ${item.id}.`);
    }
    if (item.assignee !== undefined && this.store.getActiveAgentRun(task.id, item.assignee) !== null) {
      throw new Error(`Role has an active Run: ${task.id}/${item.assignee}.`);
    }
    if (item.assignee !== undefined && this.store.getRole(task.id, item.assignee) === null) {
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
