import { isDeepStrictEqual } from "node:util";

import {
  createWorkItemChangeSet,
  type WorkItemChangeSet
} from "../integration/changeSet.js";
import { NodeGitWorkspace } from "../repository/gitWorkspace.js";
import type { TaskStore } from "../storage/taskStore.js";
import type {
  RoleWorkspace,
  WorkspaceProjectEntry
} from "../worktree/roleWorkspace.js";
import { captureManagedGitChanges } from "./gitChangeSetCapture.js";

const CAPTURABLE_WORK_ITEM_STATUSES = new Set([
  "awaiting_acceptance",
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "abandoned"
]);

export type ProjectIntegrationProof = Readonly<{
  projectId: string;
  baseCommit: string;
  headCommit: string;
  changeSetId?: string;
}>;

export type WorkItemIntegrationProof = Readonly<{
  workItemId: string;
  assignee: string;
  workspace: RoleWorkspace;
  projects: readonly ProjectIntegrationProof[];
}>;

export type TaskRetirementWorkspaceProof = Readonly<{
  roleName: string;
  workspace: RoleWorkspace;
  projects: readonly ProjectIntegrationProof[];
}>;

export type TaskRetirementProof = Readonly<{
  taskId: string;
  taskUpdatedAt: string;
  workspaces: readonly TaskRetirementWorkspaceProof[];
}>;

export class WorkItemChangeSetManager {
  constructor(
    readonly store: TaskStore,
    readonly now: () => Date = () => new Date()
  ) {}

  async capture(
    taskId: string,
    workItemId: string
  ): Promise<readonly WorkItemChangeSet[]> {
    const context = requireCapturableContext(this.store, taskId, workItemId);
    const captured: WorkItemChangeSet[] = [];
    for (const entry of writableEntries(context.workspace)) {
      const changeSet = await this.#captureProject(context, entry);
      if (changeSet !== null) captured.push(changeSet);
    }
    return captured;
  }

  async assertIntegrated(
    taskId: string,
    workItemId: string
  ): Promise<WorkItemIntegrationProof | null> {
    const item = this.store.getWorkItem(taskId, workItemId);
    if (item === null) throw new Error(`Work item not found: ${taskId}/${workItemId}.`);
    if (item.assignee === undefined) return null;
    const workspace = this.store.getRoleWorkspace(item.taskId, item.assignee);
    if (workspace?.owner.type === "review-round") {
      throw new Error(
        `ReviewRound-owned workspace cannot provide WorkItem integration proof: ${workspace.owner.reviewRoundId}.`
      );
    }
    if (
      workspace === null
      || workspace.owner.type !== "work-item"
      || workspace.owner.workItemId !== item.id
    ) return null;
    const git = new NodeGitWorkspace();
    const projects: ProjectIntegrationProof[] = [];
    for (const entry of writableEntries(workspace)) {
      if (!await git.isClean(entry.path)) {
        throw new Error(
          `WorkItem Project workspace is not clean: ${item.id}/${entry.projectId}.`
        );
      }
      const headCommit = (await git.inspect(entry.path, "HEAD")).baseCommit;
      const latest = latestWorkItemChangeSet(
        this.store,
        item.taskId,
        item.id,
        entry.projectId
      );
      if (headCommit === entry.baseCommit) {
        if (latest !== undefined) {
          throw new Error(
            `WorkItem Project no longer matches its latest ChangeSet: ${
              item.id
            }/${entry.projectId}.`
          );
        }
        projects.push({
          projectId: entry.projectId,
          baseCommit: entry.baseCommit,
          headCommit
        });
        continue;
      }
      if (
        latest === undefined
        || latest.baseCommit !== entry.baseCommit
        || latest.headCommit !== headCommit
        || latest.branch !== entry.branch
      ) {
        throw new Error(
          `WorkItem Project has uncaptured commits: ${item.id}/${entry.projectId}.`
        );
      }
      const integrated = this.store.listIntegrationAttempts(item.taskId).some(
        (integration) => (
          integration.status === "committed"
          && integration.projectId === entry.projectId
          && integration.changeSetIds.includes(latest.id)
        )
      );
      if (!integrated) {
        throw new Error(
          `WorkItem ChangeSet is not integrated: ${latest.id}.`
        );
      }
      projects.push({
        projectId: entry.projectId,
        baseCommit: entry.baseCommit,
        headCommit,
        changeSetId: latest.id
      });
    }
    return {
      workItemId: item.id,
      assignee: item.assignee,
      workspace,
      projects
    };
  }

  /**
   * Fail-closed proof that retiring the aggregate will not hide unrecorded Git
   * state. It never removes or modifies a worktree.
   */
  async assertRetirable(taskId: string): Promise<TaskRetirementProof> {
    const task = this.store.getTask(taskId);
    if (task === null) throw new Error(`Task not found: ${taskId}.`);
    if (task.status !== "active" && task.status !== "draft") {
      throw new Error(`Task cannot be retired from ${task.status}: ${task.id}.`);
    }
    const unresolved = this.store.listIntegrationAttempts(task.id).find((attempt) => (
      attempt.status === "running"
      || attempt.status === "blocked"
      || attempt.status === "validating"
    ));
    if (unresolved !== undefined) {
      throw new Error(
        `Task has an unresolved Integration Attempt: ${task.id}/${unresolved.id}.`
      );
    }
    const git = new NodeGitWorkspace();
    const workspaces: TaskRetirementWorkspaceProof[] = [];
    for (const workspace of this.store.listRoleWorkspaces(task.id)) {
      const projects: ProjectIntegrationProof[] = [];
      for (const entry of workspace.entries) {
        if (!await git.isClean(entry.path)) {
          throw new Error(
            `Task retirement workspace is not clean: ${task.id}/${entry.projectId}.`
          );
        }
        const headCommit = (await git.inspect(entry.path, "HEAD")).baseCommit;
        if (headCommit !== entry.baseCommit) {
          if (workspace.owner.type === "work-item") {
            const latest = latestWorkItemChangeSet(
              this.store,
              task.id,
              workspace.owner.workItemId,
              entry.projectId
            );
            if (
              latest === undefined
              || latest.baseCommit !== entry.baseCommit
              || latest.headCommit !== headCommit
              || latest.branch !== entry.branch
            ) {
              throw new Error(
                `Task retirement would hide uncaptured WorkItem commits: `
                + `${workspace.owner.workItemId}/${entry.projectId}.`
              );
            }
            projects.push({
              projectId: entry.projectId,
              baseCommit: entry.baseCommit,
              headCommit,
              changeSetId: latest.id
            });
            continue;
          }
          const committed = this.store.listIntegrationAttempts(task.id).find((attempt) => (
            attempt.status === "committed"
            && attempt.projectId === entry.projectId
            && attempt.candidateCommit === headCommit
          ));
          if (committed === undefined) {
            throw new Error(
              `Task retirement would hide uncaptured Task workspace commits: `
              + `${task.id}/${entry.projectId}.`
            );
          }
        }
        projects.push({
          projectId: entry.projectId,
          baseCommit: entry.baseCommit,
          headCommit
        });
      }
      workspaces.push({ roleName: workspace.roleName, workspace, projects });
    }
    return {
      taskId: task.id,
      taskUpdatedAt: task.updatedAt,
      workspaces
    };
  }

  async #captureProject(
    context: CapturableContext,
    entry: WorkspaceProjectEntry
  ): Promise<WorkItemChangeSet | null> {
    const result = await captureManagedGitChanges({
      path: entry.path,
      branch: entry.branch,
      baseCommit: entry.baseCommit,
      commitMessage: `yui: work item ${context.workItemId} (${entry.directory})`,
      identity: `${context.workItemId}/${entry.projectId}`
    });
    if (result === null) return null;
    const existing = findWorkItemChangeSet(
      this.store,
      context.taskId,
      context.workItemId,
      entry.projectId,
      entry.baseCommit,
      result.headCommit
    );
    if (existing !== undefined) return existing;
    return this.store.transaction((tx) => {
      assertCaptureStillCurrent(tx, context);
      const concurrent = findWorkItemChangeSet(
        tx,
        context.taskId,
        context.workItemId,
        entry.projectId,
        entry.baseCommit,
        result.headCommit
      );
      if (concurrent !== undefined) {
        if (!sameCapturedResult(concurrent, {
          ...concurrent,
          projectId: entry.projectId,
          branch: entry.branch,
          changedPaths: result.changedPaths
        })) {
          throw new Error(
            `Work item ChangeSet is immutable: ${context.workItemId}/${entry.projectId}.`
          );
        }
        return concurrent;
      }
      const changeSet = createWorkItemChangeSet({
        id: tx.nextChangeSetId(context.taskId),
        taskId: context.taskId,
        workItemId: context.workItemId,
        projectId: entry.projectId,
        baseCommit: entry.baseCommit,
        headCommit: result.headCommit,
        branch: entry.branch,
        changedPaths: result.changedPaths
      }, nextCaptureTime(
        tx,
        context.taskId,
        context.workItemId,
        entry.projectId,
        this.now()
      ));
      tx.saveChangeSet(context.taskId, changeSet);
      return changeSet;
    });
  }
}

type CapturableContext = Readonly<{
  taskId: string;
  workItemId: string;
  assignee: string;
  expectedRevision: number;
  workspace: RoleWorkspace;
}>;

function requireCapturableContext(
  store: TaskStore,
  taskId: string,
  workItemId: string
): CapturableContext {
  const item = store.getWorkItem(taskId, workItemId);
  if (item === null) throw new Error(`Work item not found: ${taskId}/${workItemId}.`);
  if (!CAPTURABLE_WORK_ITEM_STATUSES.has(item.status)) {
    throw new Error(
      `Work item must be awaiting acceptance or terminal before capture: ${item.id}.`
    );
  }
  if (item.workspaceDisposition !== undefined) {
    throw new Error(
      `Work item workspace is already recorded as ${item.workspaceDisposition}: ${item.id}.`
    );
  }
  if (item.assignee === undefined) {
    throw new Error(`Work item has no Task Role workspace: ${item.id}.`);
  }
  const task = store.getTask(item.taskId);
  if (task === null) throw new Error(`Task not found: ${item.taskId}.`);
  if (task.status !== "active") {
    throw new Error(`Task is not active: ${task.id}/${task.status}.`);
  }
  const workspace = store.getRoleWorkspace(task.id, item.assignee);
  if (workspace?.owner.type === "review-round") {
    throw new Error(
      `ReviewRound-owned workspace cannot be captured: ${workspace.owner.reviewRoundId}.`
    );
  }
  if (
    workspace === null
    || workspace.owner.type !== "work-item"
    || workspace.owner.workItemId !== item.id
  ) {
    throw new Error(`Work item has no managed workspace: ${item.id}.`);
  }
  const actualWriteProjects = writableEntries(workspace).map(({ projectId }) => projectId).sort();
  const expectedWriteProjects = [...item.writeProjectIds].sort();
  if (!isDeepStrictEqual(actualWriteProjects, expectedWriteProjects)) {
    throw new Error(`Work item workspace scope is stale: ${item.id}.`);
  }
  return {
    taskId: task.id,
    workItemId: item.id,
    assignee: item.assignee,
    expectedRevision: item.revision,
    workspace
  };
}

function assertCaptureStillCurrent(store: TaskStore, expected: CapturableContext): void {
  const task = store.getTask(expected.taskId);
  const item = store.getWorkItem(expected.taskId, expected.workItemId);
  const workspace = store.getRoleWorkspace(expected.taskId, expected.assignee);
  if (
    task?.status !== "active"
    || item === null
    || item.revision !== expected.expectedRevision
    || !CAPTURABLE_WORK_ITEM_STATUSES.has(item.status)
    || item.workspaceDisposition !== undefined
    || workspace === null
    || !isDeepStrictEqual(workspace, expected.workspace)
  ) {
    throw new Error(
      `WorkItem changed while its ChangeSets were being captured: ${
        expected.workItemId
      }. Retry capture.`
    );
  }
}

function writableEntries(workspace: RoleWorkspace): readonly WorkspaceProjectEntry[] {
  return workspace.entries.filter(({ access }) => access === "write");
}

function latestWorkItemChangeSet(
  store: TaskStore,
  taskId: string,
  workItemId: string,
  projectId: string,
  commits?: Readonly<{ baseCommit: string; headCommit: string }>
): WorkItemChangeSet | undefined {
  return store.listChangeSets(taskId).filter(
    (changeSet): changeSet is WorkItemChangeSet => (
      changeSet.schemaVersion === 2
      && changeSet.workItemId === workItemId
      && changeSet.projectId === projectId
      && (commits === undefined
        || (changeSet.baseCommit === commits.baseCommit
          && changeSet.headCommit === commits.headCommit))
    )
  ).sort(compareNewestFirst)[0];
}

function findWorkItemChangeSet(
  store: TaskStore,
  taskId: string,
  workItemId: string,
  projectId: string,
  baseCommit: string,
  headCommit: string
): WorkItemChangeSet | undefined {
  return latestWorkItemChangeSet(store, taskId, workItemId, projectId, {
    baseCommit,
    headCommit
  });
}

function compareNewestFirst(left: WorkItemChangeSet, right: WorkItemChangeSet): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function nextCaptureTime(
  store: TaskStore,
  taskId: string,
  workItemId: string,
  projectId: string,
  candidate: Date
): Date {
  const latest = latestWorkItemChangeSet(store, taskId, workItemId, projectId);
  if (latest === undefined) return candidate;
  const minimum = Date.parse(latest.createdAt) + 1;
  return candidate.getTime() >= minimum ? candidate : new Date(minimum);
}

function sameCapturedResult(
  left: WorkItemChangeSet,
  right: WorkItemChangeSet
): boolean {
  return left.taskId === right.taskId
    && left.workItemId === right.workItemId
    && left.projectId === right.projectId
    && left.baseCommit === right.baseCommit
    && left.headCommit === right.headCommit
    && left.branch === right.branch
    && left.changedPaths.length === right.changedPaths.length
    && left.changedPaths.every((path, index) => path === right.changedPaths[index]);
}
