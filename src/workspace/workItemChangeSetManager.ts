import {
  createWorkItemChangeSet,
  type WorkItemChangeSet
} from "../integration/changeSet.js";
import { NodeGitWorkspace } from "../repository/gitWorkspace.js";
import type { TaskStore } from "../storage/taskStore.js";
import { captureManagedGitChanges } from "./gitChangeSetCapture.js";
import type { RoleWorkspace } from "../worktree/roleWorkspace.js";

const CAPTURABLE_WORK_ITEM_STATUSES = new Set([
  "awaiting_acceptance",
  "completed",
  "failed",
  "cancelled",
  "superseded"
]);

export type WorkItemIntegrationProof = Readonly<{
  workItemId: string;
  assignee: string;
  workspace: RoleWorkspace;
  headCommit: string;
  changeSetId?: string;
}>;

export class WorkItemChangeSetManager {
  constructor(
    readonly store: TaskStore,
    readonly now: () => Date = () => new Date()
  ) {}

  async capture(workItemId: string): Promise<WorkItemChangeSet | null> {
    const item = this.store.findWorkItem(workItemId);
    if (item === null) throw new Error(`Work item not found: ${workItemId}.`);
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
    const assignee = item.assignee;
    const task = this.store.getTask(item.taskId);
    if (task === null) throw new Error(`Task not found: ${item.taskId}.`);
    if (task.status !== "active") {
      throw new Error(`Task is not active: ${task.id}/${task.status}.`);
    }
    if (task.projectId === undefined) {
      throw new Error(`Work item requires a Project-backed Task: ${item.id}.`);
    }
    const workspace = this.store.getRoleWorkspace(task.id, assignee);
    if (workspace === null) {
      throw new Error(`Work item has no managed isolated worktree: ${item.id}.`);
    }
    if (
      workspace.owner.type !== "work-item"
      || workspace.owner.workItemId !== item.id
    ) {
      throw new Error(`Work item does not own the Role workspace: ${item.id}.`);
    }
    if (workspace.projectId !== task.projectId) {
      throw new Error(`Work item workspace Project does not match Task: ${item.id}.`);
    }
    const expectedRevision = item.revision;

    const captured = await captureManagedGitChanges({
      path: workspace.path,
      branch: workspace.branch,
      baseCommit: workspace.baseCommit,
      commitMessage: `yui: work item ${item.id}`,
      identity: item.id
    });
    if (captured === null) return null;
    const existing = findWorkItemChangeSet(
      this.store,
      task.id,
      item.id,
      workspace.baseCommit,
      captured.headCommit
    );
    if (existing !== undefined) return existing;
    return this.store.transaction((tx) => {
      assertCaptureStillCurrent(tx, {
        taskId: task.id,
        workItemId: item.id,
        assignee,
        expectedRevision,
        workspace
      });
      const concurrent = findWorkItemChangeSet(
        tx,
        task.id,
        item.id,
        workspace.baseCommit,
        captured.headCommit
      );
      if (concurrent !== undefined) {
        if (!sameCapturedResult(concurrent, {
          ...concurrent,
          projectId: workspace.projectId,
          branch: workspace.branch,
          changedPaths: captured.changedPaths
        })) {
          throw new Error(`Work item ChangeSet is immutable: ${item.id}.`);
        }
        return concurrent;
      }
      const changeSet = createWorkItemChangeSet({
        id: tx.nextChangeSetId(task.id),
        taskId: task.id,
        workItemId: item.id,
        projectId: workspace.projectId,
        baseCommit: workspace.baseCommit,
        headCommit: captured.headCommit,
        branch: workspace.branch,
        changedPaths: captured.changedPaths
      }, nextCaptureTime(tx, task.id, item.id, this.now()));
      tx.saveChangeSet(task.id, changeSet);
      return changeSet;
    });
  }

  async assertIntegrated(workItemId: string): Promise<WorkItemIntegrationProof | null> {
    const item = this.store.findWorkItem(workItemId);
    if (item === null) throw new Error(`Work item not found: ${workItemId}.`);
    if (item.assignee === undefined) return null;
    const workspace = this.store.getRoleWorkspace(item.taskId, item.assignee);
    if (
      workspace === null
      || workspace.owner.type !== "work-item"
      || workspace.owner.workItemId !== item.id
    ) return null;
    const git = new NodeGitWorkspace();
    if (!await git.isClean(workspace.path)) {
      throw new Error(
        `WorkItem workspace is not clean: ${item.id}. Finish or discard current edits first.`
      );
    }
    const head = (await git.inspect(workspace.path, "HEAD")).baseCommit;
    const latest = latestWorkItemChangeSet(this.store, item.taskId, item.id);
    if (head === workspace.baseCommit) {
      if (latest !== undefined) {
        throw new Error(
          `WorkItem HEAD no longer matches its latest ChangeSet: ${latest.id}. Capture the current result.`
        );
      }
      return {
        workItemId: item.id,
        assignee: item.assignee,
        workspace,
        headCommit: head
      };
    }
    if (
      latest === undefined
      || latest.baseCommit !== workspace.baseCommit
      || latest.headCommit !== head
      || latest.projectId !== workspace.projectId
      || latest.branch !== workspace.branch
    ) {
      throw new Error(
        `WorkItem has uncaptured commits: ${item.id}. Capture it before integrated cleanup.`
      );
    }
    const integrated = this.store.listIntegrationAttempts(item.taskId).some(
      (integration) => (
        integration.status === "committed"
        && integration.changeSetIds.includes(latest.id)
      )
    );
    if (!integrated) {
      throw new Error(
        `WorkItem ChangeSet is not integrated: ${latest.id}. Integrate it before cleanup.`
      );
    }
    return {
      workItemId: item.id,
      assignee: item.assignee,
      workspace,
      headCommit: head,
      changeSetId: latest.id
    };
  }
}

function assertCaptureStillCurrent(
  store: TaskStore,
  expected: Readonly<{
    taskId: string;
    workItemId: string;
    assignee: string;
    expectedRevision: number;
    workspace: NonNullable<ReturnType<TaskStore["getRoleWorkspace"]>>;
  }>
): void {
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
    || workspace.path !== expected.workspace.path
    || workspace.branch !== expected.workspace.branch
    || workspace.baseCommit !== expected.workspace.baseCommit
    || workspace.projectId !== expected.workspace.projectId
    || workspace.owner.type !== "work-item"
    || workspace.owner.workItemId !== expected.workItemId
  ) {
    throw new Error(
      `WorkItem changed while its ChangeSet was being captured: ${expected.workItemId}. Retry capture.`
    );
  }
}

function latestWorkItemChangeSet(
  store: TaskStore,
  taskId: string,
  workItemId: string,
  commits?: Readonly<{ baseCommit: string; headCommit: string }>
): WorkItemChangeSet | undefined {
  return store.listChangeSets(taskId).filter(
    (changeSet): changeSet is WorkItemChangeSet => (
      changeSet.schemaVersion === 2
      && changeSet.workItemId === workItemId
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
  baseCommit: string,
  headCommit: string
): WorkItemChangeSet | undefined {
  return latestWorkItemChangeSet(store, taskId, workItemId, {
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
  candidate: Date
): Date {
  const latest = latestWorkItemChangeSet(store, taskId, workItemId);
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
