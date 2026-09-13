import { isDeepStrictEqual } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
  createWorkItemChangeSet,
  type WorkItemChangeSet
} from "../integration/changeSet.js";
import { createChangeSetManifest } from "../integration/changeSetManifest.js";
import { deriveManifestTags } from "../integration/manifestTags.js";
import { NodeGitWorkspace } from "../repository/gitWorkspace.js";
import {
  sameTaskFinalReviewContract,
  type TaskFinalReviewContract
} from "../review/taskFinalReviewContract.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  governingWorkItemCandidate,
  type DirectTaskMainSnapshot
} from "../workItem/workItem.js";
import type {
  ManagedWorkspace,
  WorkspaceProjectEntry
} from "../worktree/managedWorkspace.js";
import { managedWorkspaceKey } from "../worktree/managedWorkspace.js";
import { captureManagedGitChanges } from "./gitChangeSetCapture.js";
import { CleanupInspectionError, cleanupCheckFromError, workspacePathValue, type CleanupCheck } from "./cleanupInspection.js";

const CAPTURABLE_WORK_ITEM_STATUSES = new Set([
  "open",
  "accepted",
  "retired"
]);

export type ProjectIntegrationProof = Readonly<{
  projectId: string;
  baseCommit: string;
  headCommit: string;
  publishedCommit?: string;
}>;

export type WorkItemIntegrationProof = Readonly<{
  workItemId: string;
  assignee?: string;
  workspace: ManagedWorkspace;
  projects: readonly ProjectIntegrationProof[];
}>;

export type TaskRetirementWorkspaceProof = Readonly<{
  ownerKey: string;
  workspace: ManagedWorkspace;
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
    workItemId: string,
    options: Readonly<{
      taskFinalReviewContract?: TaskFinalReviewContract;
    }> = {}
  ): Promise<readonly WorkItemChangeSet[]> {
    const context = requireCapturableContext(
      this.store,
      taskId,
      workItemId,
      options.taskFinalReviewContract
    );
    const entries = capturableEntries(context);
    if (context.source === "task-main") {
      const git = new NodeGitWorkspace();
      for (const { entry, expectedHead } of entries) {
        if (!await git.isClean(entry.path)) {
          throw new Error(
            `Exact direct Candidate Task main must be clean: ${
              context.workItemId
            }/${entry.projectId}.`
          );
        }
        const branch = await git.headRef(entry.path);
        const headCommit = (await git.inspect(entry.path, "HEAD")).baseCommit;
        if (branch !== entry.branch || headCommit !== expectedHead) {
          throw new Error(
            `Exact direct Candidate Task main no longer matches its frozen snapshot: ${
              context.workItemId
            }/${entry.projectId}.`
          );
        }
      }
    }
    const captured: WorkItemChangeSet[] = [];
    for (const entry of entries) {
      const changeSet = await this.#captureProject(context, entry);
      if (changeSet !== null) captured.push(changeSet);
    }
    return captured;
  }

  async assertIntegrated(
    taskId: string,
    workItemId: string,
    candidateId?: string
  ): Promise<WorkItemIntegrationProof | null> {
    const inspection = await this.inspectIntegrated(taskId, workItemId, candidateId);
    if (inspection.checks.length > 0) throw new CleanupInspectionError(inspection.checks);
    return inspection.proof;
  }

  async inspectIntegrated(
    taskId: string,
    workItemId: string,
    candidateId?: string
  ): Promise<Readonly<{ proof: WorkItemIntegrationProof | null; checks: readonly CleanupCheck[] }>> {
    const item = this.store.getWorkItem(taskId, workItemId);
    if (item === null) throw new Error(`Work item not found: ${taskId}/${workItemId}.`);
    const candidate = candidateId === undefined ? governingWorkItemCandidate(item)
      : item.candidates.find(({ id }) => id === candidateId);
    if (candidateId !== undefined && candidate === undefined) {
      throw new Error(`Candidate not found: ${taskId}/${workItemId}/${candidateId}.`);
    }
    const workspace = this.store.getWorkItemWorkspace(item.taskId, item.id);
    if (workspace === null) return { proof: null, checks: [] };
    const git = new NodeGitWorkspace();
    const projects: ProjectIntegrationProof[] = [];
    const checks: CleanupCheck[] = [];
    const sources = [`work-item:${taskId}/${workItemId}`,
      `candidate:${taskId}/${workItemId}/${candidate?.id ?? "missing"}`, managedWorkspaceKey(workspace.owner)];
    const actions = [`yui task work show ${taskId}/${workItemId}`, `yui task integration list ${taskId}`];
    const add = (resource: string, reason: string, detail: string, expected: unknown, observed: unknown) => {
      checks.push({ resource, reason, detail, expected, observed, status: "blocked", sources, actions });
    };
    const resource = `work-item:${taskId}/${workItemId}`;
    if (workspace.owner.type !== "work-item" || workspace.owner.taskId !== taskId || workspace.owner.workItemId !== item.id) {
      add(resource, "workspace-identity-mismatch", "Managed workspace is not owned by this WorkItem.",
        { type: "work-item", taskId, workItemId }, "different owner");
      return { proof: null, checks };
    }
    if (candidate?.workspace === undefined) {
      add(resource, "candidate-workspace-missing", "The governing Candidate has no frozen workspace.",
        "frozen WorkItem workspace", null);
    } else if (!isDeepStrictEqual(candidate.workspace, workspace)) {
      const frozen = candidate.workspace;
      if (!isDeepStrictEqual(frozen.owner, workspace.owner)) {
        add(resource, "workspace-identity-mismatch", "Frozen and current workspace owners differ.",
          frozen.owner, workspace.owner);
      }
      // Paths remain frozen evidence. A path-shaped difference alone is NOT a
      // receipt proving that migration moved this exact Candidate safely.
      if (frozen.root !== workspace.root) {
        add(resource, "workspace-path-mismatch", "Workspace roots differ; relocation is not proven.",
          workspacePathValue(workspace, frozen.root), workspacePathValue(workspace, workspace.root));
      }
      if (!isDeepStrictEqual(frozen.entries.map(e => e.projectId), workspace.entries.map(e => e.projectId))) {
        add(resource, "workspace-identity-mismatch", "Frozen and current Project scope/order differ.",
          frozen.entries.map(e => e.projectId), workspace.entries.map(e => e.projectId));
      }
      for (const entry of workspace.entries) {
        const previous = frozen.entries.find(e => e.projectId === entry.projectId);
        if (previous === undefined) continue;
        const entryResource = `${resource}/${entry.projectId}`;
        if (previous.path !== entry.path) {
          add(entryResource, "workspace-path-mismatch",
            "Frozen and current Project paths differ; no relocation receipt is available. Historical evidence is unchanged.",
            workspacePathValue(workspace, previous.path), workspacePathValue(workspace, entry.path));
        }
        for (const key of ["directory", "access", "branch", "baseRef", "baseCommit"] as const) {
          if (previous[key] !== entry[key]) add(entryResource, "workspace-identity-mismatch",
            `Frozen and current ${key} differ.`, { [key]: previous[key] }, { [key]: entry[key] });
        }
      }
      for (const key of ["schemaVersion", "createdAt", "updatedAt"] as const) {
        if (frozen[key] !== workspace[key]) add(resource, "workspace-metadata-mismatch",
          `Frozen and current ${key} differ.`, { [key]: frozen[key] }, { [key]: workspace[key] });
      }
    }
    for (const entry of writableEntries(workspace)) {
      const projectResource = `${resource}/${entry.projectId}`;
      const resultCommit = candidate?.gitSnapshot?.projects.find(
        ({ projectId }) => projectId === entry.projectId
      )?.commit;
      if (resultCommit === undefined) add(projectResource, "frozen-commit-missing",
        "The governing Candidate has no frozen Project commit.", "frozen commit", null);
      if (resultCommit !== undefined) {
        // An explicit historical selection is proved against its immutable
        // integrated commit, not mislabeled as the workspace's current HEAD.
        const integrated = this.store.listIntegrationAttempts(item.taskId).some(integration =>
          integration.status === "committed"
          && integration.projectId === entry.projectId
          && integration.source.kind === "work-item"
          && integration.source.workItemId === item.id
          && integration.source.startCommit === entry.baseCommit
          && integration.source.resultCommit === resultCommit);
        if (!integrated) {
          add(projectResource, "result-not-integrated", "WorkItem result is not integrated.",
            { baseCommit: entry.baseCommit, resultCommit }, "no committed Integration with these exact commits");
        }
        projects.push({ projectId: entry.projectId, baseCommit: entry.baseCommit, headCommit: resultCommit });
      }
      if (entry.path !== join(workspace.root, entry.directory)) {
        add(projectResource, "workspace-path-mismatch", "Current path differs from the exact owner-root/Project location.",
          workspacePathValue(workspace, join(workspace.root, entry.directory)), workspacePathValue(workspace, entry.path));
        continue;
      }
      try {
        const path = await lstat(entry.path).catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (path !== null && (path.isSymbolicLink() || await realpath(entry.path) !== entry.path)) {
          add(projectResource, "workspace-identity-mismatch", "WorkItem path resolves through a symbolic link.",
            "real owned directory", "symbolic link");
          continue;
        }
        // Absence is a filesystem fact, not proof of integration or Git cleanup.
        // Check any retained branch against the same frozen Candidate; the
        // cleanup primitive separately removes its exact Git registration.
        const repository = this.store.getTaskWorkspace(taskId)?.entries.find(e => e.projectId === entry.projectId);
        const workspaceHeadCommit = path !== null ? (await git.inspect(entry.path, "HEAD")).baseCommit
          : repository !== undefined && await git.refExists(repository.path, entry.branch)
            ? (await git.inspect(repository.path, entry.branch)).baseCommit
            : resultCommit;
        if (candidateId === undefined && resultCommit !== undefined && resultCommit !== workspaceHeadCommit) {
          add(projectResource, "head-mismatch", "Current HEAD no longer matches the frozen result.",
            resultCommit, workspaceHeadCommit ?? null);
        }
        if (path !== null && !await git.inspectClean(entry.path)) {
          add(projectResource, "dirty-worktree", "WorkItem Project workspace is not clean.", "clean", "dirty");
        }
      } catch (error) {
        checks.push(...cleanupCheckFromError(error, projectResource, sources, actions));
      }
    }
    return { checks, proof: checks.length > 0 ? null : {
      workItemId: item.id,
      ...(item.assignee === undefined ? {} : { assignee: item.assignee }),
      workspace,
      projects
    } };
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
      || attempt.status === "conflicted"
      || attempt.status === "validating"
    ));
    if (unresolved !== undefined) {
      throw new Error(
        `Task has an unresolved Integration Attempt: ${task.id}/${unresolved.id}.`
      );
    }
    const git = new NodeGitWorkspace();
    const remoteHeads = new Map<string, string>();
    const findPublishedCommit = async (
      entry: WorkspaceProjectEntry,
      headCommit: string
    ): Promise<string | null> => {
      const project = this.store.getProject(entry.projectId);
      if (project?.remoteUrl === undefined) return null;
      let remoteHead = remoteHeads.get(project.id);
      if (remoteHead === undefined) {
        remoteHead = (await git.fetchRemoteHeadIntoWorktree({
          repositoryPath: entry.path,
          remoteUrl: project.remoteUrl,
          branch: project.developmentBranch
        })).commit;
        remoteHeads.set(project.id, remoteHead);
      }
      return git.findCommitWithSameTreeInHistory({
        repositoryPath: entry.path,
        sourceCommit: headCommit,
        historyHead: remoteHead
      });
    };
    const workspaces: TaskRetirementWorkspaceProof[] = [];
    for (const workspace of this.store.listManagedWorkspaces(task.id)) {
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
              const publishedCommit = await findPublishedCommit(entry, headCommit);
              if (publishedCommit === null) {
                throw new Error(
                  `Task retirement would hide uncaptured WorkItem commits: `
                  + `${workspace.owner.workItemId}/${entry.projectId}.`
                );
              }
              projects.push({
                projectId: entry.projectId,
                baseCommit: entry.baseCommit,
                headCommit,
                publishedCommit
              });
              continue;
            }
            projects.push({
              projectId: entry.projectId,
              baseCommit: entry.baseCommit,
              headCommit
            });
            continue;
          }
          const committed = this.store.listIntegrationAttempts(task.id).find((attempt) => (
            attempt.status === "committed"
            && attempt.projectId === entry.projectId
            && attempt.candidateCommit === headCommit
          ));
          if (committed === undefined) {
            const publishedCommit = await findPublishedCommit(entry, headCommit);
            if (publishedCommit === null) {
              throw new Error(
                `Task retirement would hide uncaptured Task workspace commits: `
                + `${task.id}/${entry.projectId}.`
              );
            }
            projects.push({
              projectId: entry.projectId,
              baseCommit: entry.baseCommit,
              headCommit,
              publishedCommit
            });
            continue;
          }
        }
        projects.push({
          projectId: entry.projectId,
          baseCommit: entry.baseCommit,
          headCommit
        });
      }
      workspaces.push({ ownerKey: managedWorkspaceKey(workspace.owner), workspace, projects });
    }
    return {
      taskId: task.id,
      taskUpdatedAt: task.updatedAt,
      workspaces
    };
  }

  async #captureProject(
    context: CapturableContext,
    project: CapturableProject
  ): Promise<WorkItemChangeSet | null> {
    const { entry, expectedHead } = project;
    const result = await captureManagedGitChanges({
      path: entry.path,
      branch: entry.branch,
      baseCommit: entry.baseCommit,
      commitMessage: `yui: work item ${context.workItemId} (${entry.directory})`,
      identity: `${context.workItemId}/${entry.projectId}`,
      ...(context.source === "task-main" ? { requireClean: true, expectedHead } : {})
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
    const targetRef = captureTargetRef(this.store, context.taskId, entry.projectId);
    const manifest = createChangeSetManifest({
      tags: deriveManifestTags({
        changedPaths: result.changedPaths,
        deletedPaths: result.deletedPaths
      }),
      deletedPaths: result.deletedPaths,
      ...(targetRef === undefined ? {} : { targetRef })
    });
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
        changedPaths: result.changedPaths,
        manifest
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
  assignee?: string;
  expectedRevision: number;
  source: "work-item" | "task-main";
  writeProjectIds: readonly string[];
  taskFinalReviewContract?: TaskFinalReviewContract;
  taskMainSnapshot?: DirectTaskMainSnapshot;
  workspace: ManagedWorkspace;
}>;

type CapturableProject = Readonly<{
  entry: WorkspaceProjectEntry;
  expectedHead?: string;
}>;

function requireCapturableContext(
  store: TaskStore,
  taskId: string,
  workItemId: string,
  taskFinalReviewContract: TaskFinalReviewContract | undefined
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
  const task = store.getTask(item.taskId);
  if (task === null) throw new Error(`Task not found: ${item.taskId}.`);
  if (task.status !== "active") {
    throw new Error(`Task is not active: ${task.id}/${task.status}.`);
  }
  const workspace = store.getWorkItemWorkspace(task.id, item.id);
  if (workspace?.owner.type === "review-round") {
    throw new Error(
      `ReviewRound-owned workspace cannot be captured as WorkItem Develop: ${item.id}.`
    );
  }
  const exactWorkItemWorkspace = workspace !== null
    && workspace.owner.type === "work-item"
    && workspace.owner.workItemId === item.id;
  let selectedWorkspace: ManagedWorkspace;
  let source: CapturableContext["source"];
  let taskMainSnapshot: DirectTaskMainSnapshot | undefined;
  if (exactWorkItemWorkspace) {
    selectedWorkspace = workspace;
    source = "work-item";
  } else {
    if (taskFinalReviewContract === undefined) {
      throw new Error(`Work item has no managed workspace: ${item.id}.`);
    }
    const candidate = governingWorkItemCandidate(item);
    if (
      candidate === undefined
      || !sameTaskFinalReviewContract(
        candidate.taskFinalReviewContract,
        taskFinalReviewContract
      )
    ) {
      throw new Error(
        `Work item has no matching exact Task-final direct Candidate: ${item.id}.`
      );
    }
    if (candidate.taskMainSnapshot === undefined) {
      throw new Error(
        `Exact Task-final direct Candidate has no frozen Task-main snapshot: ${item.id}.`
      );
    }
    if (latestExactDirectAnchorId(
      store,
      task.id,
      taskFinalReviewContract
    ) !== item.id) {
      throw new Error(
        `Only the latest exact Task-final direct Candidate may capture Task main: ${item.id}.`
      );
    }
    const taskWorkspace = store.getTaskWorkspace(task.id);
    if (
      taskWorkspace === null
      || taskWorkspace.owner.type !== "task"
      || taskWorkspace.owner.taskId !== task.id
    ) {
      throw new Error(`Task has no authoritative main workspace: ${task.id}.`);
    }
    selectedWorkspace = taskWorkspace;
    source = "task-main";
    taskMainSnapshot = candidate.taskMainSnapshot;
  }
  const expectedWriteProjects = [...item.writeProjectIds].sort();
  const availableWriteProjects = writableEntries(selectedWorkspace)
    .map(({ projectId }) => projectId);
  const actualWriteProjects = availableWriteProjects
    .filter((projectId) => expectedWriteProjects.includes(projectId))
    .sort();
  if (!isDeepStrictEqual(actualWriteProjects, expectedWriteProjects)) {
    throw new Error(`Work item workspace scope is stale: ${item.id}.`);
  }
  if (source === "task-main") {
    const snapshotProjects = taskMainSnapshot!.projects
      .map(({ projectId }) => projectId)
      .sort();
    if (!isDeepStrictEqual(snapshotProjects, expectedWriteProjects)) {
      throw new Error(`Direct Candidate snapshot scope is stale: ${item.id}.`);
    }
    for (const snapshot of taskMainSnapshot!.projects) {
      const current = selectedWorkspace.entries.find(
        ({ projectId }) => projectId === snapshot.projectId
      );
      if (current === undefined
        || current.access !== "write"
        || current.directory !== snapshot.directory
        || current.branch !== snapshot.branch) {
        throw new Error(
          `Direct Candidate Task-main identity is stale: ${item.id}/${snapshot.projectId}.`
        );
      }
    }
  }
  return {
    taskId: task.id,
    workItemId: item.id,
    ...(item.assignee === undefined ? {} : { assignee: item.assignee }),
    expectedRevision: item.revision,
    source,
    writeProjectIds: expectedWriteProjects,
    ...(source === "task-main" ? { taskFinalReviewContract, taskMainSnapshot } : {}),
    workspace: selectedWorkspace
  };
}

function assertCaptureStillCurrent(store: TaskStore, expected: CapturableContext): void {
  const task = store.getTask(expected.taskId);
  const item = store.getWorkItem(expected.taskId, expected.workItemId);
  const workspace = expected.source === "task-main"
    ? store.getTaskWorkspace(expected.taskId)
    : store.getWorkItemWorkspace(expected.taskId, expected.workItemId);
  const candidate = item === null ? undefined : governingWorkItemCandidate(item);
  if (
    task?.status !== "active"
    || item === null
    || item.revision !== expected.expectedRevision
    || !CAPTURABLE_WORK_ITEM_STATUSES.has(item.status)
    || item.workspaceDisposition !== undefined
    || workspace === null
    || (expected.source === "task-main"
      ? !sameTaskMainWorkspaceIdentity(workspace, expected.workspace)
      : !isDeepStrictEqual(workspace, expected.workspace))
    || (expected.source === "task-main" && (
      candidate?.source.type !== "direct"
      || !isDeepStrictEqual(candidate.taskMainSnapshot, expected.taskMainSnapshot)
      || !sameTaskFinalReviewContract(
        candidate.taskFinalReviewContract,
        expected.taskFinalReviewContract
      )
      || latestExactDirectAnchorId(
        store,
        expected.taskId,
        expected.taskFinalReviewContract
      ) !== expected.workItemId
    ))
  ) {
    throw new Error(
      `WorkItem changed while its ChangeSets were being captured: ${
        expected.workItemId
      }. Retry capture.`
    );
  }
}

function sameTaskMainWorkspaceIdentity(
  current: ManagedWorkspace,
  expected: ManagedWorkspace
): boolean {
  return current.owner.type === "task"
    && expected.owner.type === "task"
    && current.owner.taskId === expected.owner.taskId
    && current.root === expected.root
    && current.entries.length === expected.entries.length
    && current.entries.every((entry, index) => {
      const frozen = expected.entries[index];
      return frozen !== undefined
        && entry.projectId === frozen.projectId
        && entry.directory === frozen.directory
        && entry.access === frozen.access
        && entry.path === frozen.path
        && entry.branch === frozen.branch;
    });
}

function latestExactDirectAnchorId(
  store: TaskStore,
  taskId: string,
  contract: TaskFinalReviewContract | undefined
): string | undefined {
  if (contract === undefined) return undefined;
  return store.listWorkItems(taskId)
    .filter((item) => {
      const candidate = governingWorkItemCandidate(item);
      return candidate?.source.type === "direct"
        && sameTaskFinalReviewContract(candidate.taskFinalReviewContract, contract);
    })
    .sort((left, right) => (
      left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
    ))
    .at(-1)?.id;
}

function capturableEntries(
  context: CapturableContext
): readonly CapturableProject[] {
  const allowed = new Set(context.writeProjectIds);
  return writableEntries(context.workspace)
    .filter(({ projectId }) => allowed.has(projectId))
    .map((entry) => {
      if (context.source !== "task-main") return { entry };
      const snapshot = context.taskMainSnapshot!.projects.find(
        ({ projectId }) => projectId === entry.projectId
      )!;
      return {
        entry: {
          ...entry,
          branch: snapshot.branch,
          baseCommit: snapshot.baseCommit
        },
        expectedHead: snapshot.headCommit
      };
    });
}

function writableEntries(workspace: ManagedWorkspace): readonly WorkspaceProjectEntry[] {
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
    (changeSet) => (
      changeSet.workItemId === workItemId
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

/**
 * The intended integration target for a captured Project change: the Task
 * main worktree branch for that Project, matching the Integration default.
 * Returns undefined when the Task main worktree is not ready yet.
 */
function captureTargetRef(
  store: TaskStore,
  taskId: string,
  projectId: string
): string | undefined {
  const mainWorkspace = store.getTaskWorkspace(taskId);
  if (mainWorkspace === null) return undefined;
  const entry = mainWorkspace.entries.find(
    (candidate) => candidate.projectId === projectId
  );
  return entry?.branch;
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
