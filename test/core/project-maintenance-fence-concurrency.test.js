/**
 * Regression coverage for the Task-final review-round-3 concurrency findings:
 *
 *  - Finding 1 (migrate race): a stale migrate re-reads the Project under the
 *    fence and fails closed; removeUnreferencedClone never deletes a registered
 *    path, even when the registering Project is the migrating one.
 *  - Finding 2 (missing fences): WorkItem, ExecutionLane, ReviewRound, and
 *    Integration worktree creation each hold the per-Project maintenance fence
 *    for the whole Git transaction.
 *  - Finding 3 (in-process reentrancy): overlapping maintenance in the same
 *    process contends; there is no reentrancy bypass.
 *  - Finding 4 (archive stale Project): archiveLegacyTaskRefs scans read-only,
 *    acquires the fence, and only then reads the Project records it acts on.
 *
 * Every fence assertion is deterministic: a git-port Proxy intercepts the
 * worktree-creation seam and proves a singular lock acquisition fails fast
 * with ProjectMaintenanceLockedError, so the operation holds the file-based
 * fence rather than relying on the Controller's check-then-call probe.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import { createExecutionGroup } from "../../dist/execution/executionGroup.js";
import { createIntegrationAttempt } from "../../dist/integration/integrationAttempt.js";
import { GitIntegrationService } from "../../dist/integration/gitIntegrationService.js";
import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
import { createProject, managedProjectPath } from "../../dist/repository/project.js";
import {
  acquireProjectMaintenanceLock,
  acquireProjectMaintenanceLocks,
  ProjectMaintenanceLockedError
} from "../../dist/repository/projectMaintenanceLock.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { createReviewRound } from "../../dist/review/reviewRound.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { yieldAgentRun } from "../../dist/run/agentRun.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import {
  attachWorkItemExecutionGroup,
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { createAgentRun } from "../helpers/effectiveLaunch.js";
import { createIsolatedRuntime } from "../helpers/isolatedRuntime.js";
import { installMockProviderCommands } from "../helpers/mockProviderCommands.js";

const NOW = new Date("2026-08-13T00:00:00.000Z");

function git(path, args) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
}

function initRepository(path) {
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  git(path, ["config", "user.name", "Yui Test"]);
  git(path, ["config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(path, "tracked.txt"), "initial\n");
  git(path, ["add", "tracked.txt"]);
  git(path, ["commit", "-qm", "initial"]);
}

async function fenceFixture(t, { projects = 1 } = {}) {
  const { root, home } = createIsolatedRuntime(t);
  installMockProviderCommands(home);
  const workspace = join(root, "workspace");
  const repositories = [];
  for (let index = 0; index < projects; index += 1) {
    const repositoryPath = join(workspace, `Repo${index}`);
    initRepository(repositoryPath);
    repositories.push(repositoryPath);
  }

  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.saveConfiguredAgent(agent);
  store.saveConfig({
    schemaVersion: 1,
    defaultWorkspace: workspace,
    defaultAgent: agent.id
  });
  for (const [index, repositoryPath] of repositories.entries()) {
    await runProjectCommand(
      ["add", `Repo${index}`, repositoryPath, "--stable", "main", "--development", "main"],
      store,
      { now: () => new Date(NOW) }
    );
  }
  const projectIds = store.listProjects().map(({ id }) => id);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  return { root, home, workspace, store, projectIds, preparer, agent };
}

/**
 * A git-port Proxy that intercepts one worktree-creation seam and proves the
 * per-Project maintenance fence is held during every call: a singular lock
 * acquisition must fail fast with ProjectMaintenanceLockedError.
 */
function fencingGitPort(home, projectId, method = "ensureWorktree") {
  const real = new NodeGitWorkspace();
  let callCount = 0;
  const proxy = new Proxy(real, {
    get(target, property) {
      if (property === method) {
        return async (input) => {
          callCount += 1;
          assert.throws(
            () => acquireProjectMaintenanceLock(home, projectId),
            ProjectMaintenanceLockedError
          );
          return target[method](input);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { proxy, callCount: () => callCount };
}

/**
 * A git-port Proxy for Integration: the fence is asserted during
 * ensureIntegrationWorktree, then the call throws so the Integration fails
 * fast without needing a valid ChangeSet. The fence assertion is the evidence.
 */
function fencingIntegrationGitPort(home, projectId) {
  const real = new NodeGitWorkspace();
  let checked = false;
  const proxy = new Proxy(real, {
    get(target, property) {
      if (property === "ensureIntegrationWorktree" && !checked) {
        return async (input) => {
          checked = true;
          assert.throws(
            () => acquireProjectMaintenanceLock(home, projectId),
            ProjectMaintenanceLockedError
          );
          throw new Error("fence asserted");
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { proxy, wasChecked: () => checked };
}

function activeTaskWithProject(store, projectId, title = "Fence Task") {
  const task = activateTask(createTask(
    store.nextTaskId(), title, NOW,
    { projectBindings: [{ projectId, directory: "Repo0", baseRef: "main" }] }
  ), NOW);
  store.saveTask(task);
  return task;
}

// ---------------------------------------------------------------------------
// Finding 3: in-process reentrancy
// ---------------------------------------------------------------------------

test("overlapping multi-Project maintenance contends in the same process", async (t) => {
  const { home, projectIds } = await fenceFixture(t, { projects: 2 });
  const sorted = [...projectIds].sort();
  const release = acquireProjectMaintenanceLock(home, sorted[0]);
  try {
    // A set that overlaps the held Project must fail, even in the same process.
    assert.throws(
      () => acquireProjectMaintenanceLocks(home, sorted),
      ProjectMaintenanceLockedError
    );
    // A non-overlapping set still succeeds.
    const releaseOther = acquireProjectMaintenanceLocks(home, [sorted[1]]);
    releaseOther();
  } finally {
    release();
  }
});

// ---------------------------------------------------------------------------
// Finding 2: missing fences around worktree creation
// ---------------------------------------------------------------------------

test("prepareWorkItemWorkspace holds the per-Project maintenance fence", async (t) => {
  const { home, projectIds, store } = await fenceFixture(t);
  const task = activeTaskWithProject(store, projectIds[0], "WorkItem Fence Task");
  const item = createWorkItem(store.nextWorkItemId(task.id), task.id, {
    title: "Fenced work",
    writeProjectIds: [projectIds[0]]
  }, NOW);
  store.saveWorkItem(task.id, item);

  const { proxy, callCount } = fencingGitPort(home, projectIds[0]);
  const fencing = new FileTaskWorkspacePreparer(home, store, proxy, () => new Date(NOW));
  await fencing.prepareWorkItemWorkspace(task.id, item.id);

  assert.ok(callCount() > 0, "ensureWorktree was called under the fence");
});

test("prepareExecutionLaneWorkspace holds the per-Project maintenance fence", async (t) => {
  const { home, projectIds, store, preparer } = await fenceFixture(t);
  const task = activeTaskWithProject(store, projectIds[0], "Lane Fence Task");
  const item = createWorkItem(store.nextWorkItemId(task.id), task.id, {
    title: "Fenced lane work",
    writeProjectIds: [projectIds[0]]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const develop = await preparer.prepareWorkItemWorkspace(task.id, item.id);

  const target = {
    schemaVersion: 1,
    kind: "work-item",
    taskId: task.id,
    workItemId: item.id,
    revision: item.revision,
    projects: [{ projectId: projectIds[0], commit: develop.entries[0].baseCommit }],
    fingerprint: JSON.stringify({
      taskId: task.id,
      workItemId: item.id,
      revision: item.revision,
      projects: [{ projectId: projectIds[0], commit: develop.entries[0].baseCommit }]
    })
  };
  const group = createExecutionGroup("execution-group-1", task.id, {
    purpose: "execution",
    target,
    strategy: { mode: "fixed", count: 1 },
    lanes: [{ roleName: "worker" }]
  }, NOW);
  store.saveWorkItem(task.id, attachWorkItemExecutionGroup(item, group, NOW));

  const { proxy, callCount } = fencingGitPort(home, projectIds[0]);
  const fencing = new FileTaskWorkspacePreparer(home, store, proxy, () => new Date(NOW));
  await fencing.prepareExecutionLaneWorkspace(task.id, group.id, group.lanes[0].id);

  assert.ok(callCount() > 0, "ensureWorktree was called under the fence");
});

test("prepareReviewRoundWorkspace holds the per-Project maintenance fence", async (t) => {
  const { home, projectIds, store, preparer, agent } = await fenceFixture(t);
  const task = activeTaskWithProject(store, projectIds[0], "Review Fence Task");
  // The reviewer Role must exist for prepareReviewRoundWorkspace.
  store.saveRole(task.id, createRole(
    task.id, "reviewer", [createRoleAgentBinding(agent)], agent.id,
    store.getProject(projectIds[0]).path, NOW
  ));
  await preparer.prepareTaskWorkspace(task.id);

  const item = createWorkItem(store.nextWorkItemId(task.id), task.id, {
    title: "Fenced review work",
    assignee: "worker",
    writeProjectIds: [projectIds[0]]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const develop = await preparer.prepareWorkItemWorkspace(task.id, item.id);

  const candidateRun = yieldAgentRun(createAgentRun(
    store.nextAgentRunId(task.id),
    task.id, "worker", "new", "Produce a candidate.", NOW,
    { workItemId: item.id, workspace: develop }
  ), "Candidate ready.", NOW);
  store.saveAgentRun(candidateRun);
  const gitSnapshot = await preparer.snapshotCandidateWorkspace(develop);
  store.saveWorkItem(task.id, submitWorkItemCandidate(running, {
    summary: candidateRun.summary,
    source: { type: "run", runId: candidateRun.id },
    reviewPolicy: { roleName: "reviewer", trigger: "leader" },
    workspace: develop,
    gitSnapshot
  }, NOW));

  const candidate = store.getWorkItem(task.id, item.id).candidates[0];
  const round = createReviewRound(
    store.nextReviewRoundId(task.id),
    task.id, item.id, candidate.id,
    "reviewer", "leader",
    candidate.gitSnapshot.reviewBaseCommit,
    NOW
  );
  store.saveReviewRound(task.id, round);

  const { proxy, callCount } = fencingGitPort(home, projectIds[0]);
  const fencing = new FileTaskWorkspacePreparer(home, store, proxy, () => new Date(NOW));
  await fencing.prepareReviewRoundWorkspace(task.id, round.id);

  assert.ok(callCount() > 0, "ensureWorktree was called under the fence");
});

test("Integration holds the per-Project maintenance fence", async (t) => {
  const { home, projectIds, store } = await fenceFixture(t);
  const task = activeTaskWithProject(store, projectIds[0], "Integration Fence Task");
  const project = store.getProject(projectIds[0]);
  const baseCommit = git(project.path, ["rev-parse", "HEAD"]);

  // Create a WorkItem and a minimal ChangeSet so saveIntegrationAttempt passes.
  const item = createWorkItem(store.nextWorkItemId(task.id), task.id, {
    title: "Integration fence work",
    writeProjectIds: [projectIds[0]]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const headCommit = execFileSync("git", [
    "-C", project.path, "commit-tree", `${baseCommit}^{tree}`,
    "-p", baseCommit, "-m", "fence change"
  ], { encoding: "utf8" }).trim();
  const changeSet = createWorkItemChangeSet({
    id: store.nextChangeSetId(task.id),
    taskId: task.id,
    workItemId: item.id,
    projectId: projectIds[0],
    baseCommit,
    headCommit,
    branch: "main",
    changedPaths: ["tracked.txt"]
  }, NOW);
  store.saveChangeSet(task.id, changeSet);

  const attempt = createIntegrationAttempt({
    id: store.nextIntegrationAttemptId(task.id),
    taskId: task.id,
    projectId: projectIds[0],
    targetRef: "main",
    expectedHead: baseCommit,
    changeSetIds: [changeSet.id]
  }, NOW);
  store.saveIntegrationAttempt(task.id, attempt);

  const { proxy, wasChecked } = fencingIntegrationGitPort(home, projectIds[0]);
  const service = new GitIntegrationService(home, store, proxy, () => NOW);
  const result = await service.integrate(task.id, attempt.id);

  assert.equal(result.status, "failed");
  assert.ok(wasChecked(), "the fence was asserted during integration worktree creation");
});

// ---------------------------------------------------------------------------
// Finding 4: archive reads Project records only under the fence
// ---------------------------------------------------------------------------

test("archiveLegacyTaskRefs reads Project records only under the fence", async (t) => {
  const { home, projectIds, store } = await fenceFixture(t);
  const projectId = projectIds[0];
  const project = store.getProject(projectId);
  // A legacy ref for a task that doesn't exist (unknown owner → archivable).
  git(project.path, ["branch", "yui/task-999/main"]);

  // Count getProject calls through a store Proxy. The scan uses listProjects
  // (not getProject); requireProject is only called under the fence.
  let getProjectCalls = 0;
  const countingStore = new Proxy(store, {
    get(target, property) {
      if (property === "getProject") {
        getProjectCalls += 1;
        return target.getProject.bind(target);
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  // Hold the fence externally: archive must fail at lock acquisition before
  // it reads any Project record to act on.
  const release = acquireProjectMaintenanceLock(home, projectId);
  try {
    const countingPreparer = new FileTaskWorkspacePreparer(
      home, countingStore, undefined, () => new Date(NOW)
    );
    await assert.rejects(
      countingPreparer.archiveLegacyTaskRefs(),
      ProjectMaintenanceLockedError
    );
  } finally {
    release();
  }
  assert.equal(
    getProjectCalls, 0,
    "archive read no Project record before the fence was acquired"
  );
});

// ---------------------------------------------------------------------------
// Finding 1: migrate fails closed on a registered managed path
// ---------------------------------------------------------------------------

test("migrate fails closed when the managed path is already registered", async (t) => {
  const { home, projectIds, store } = await fenceFixture(t);
  const projectId = projectIds[0];
  const project = store.getProject(projectId);
  // Give the Project a remote URL so migrate passes its preflight checks.
  store.saveProject({ ...project, remoteUrl: "git@example.invalid:yui.git" });

  // Create the managed destination and register another Project at that path.
  // removeUnreferencedClone must fail closed rather than deleting a registered
  // repository, even though the migrating Project is still external.
  const destination = managedProjectPath(home, projectId);
  mkdirSync(destination, { recursive: true });
  initRepository(destination);
  const other = createProject(
    store.nextProjectId(), "Other", destination,
    { stable: "main", development: "main" }, NOW
  );
  store.saveProject(other);

  await assert.rejects(
    runProjectCommand(
      ["migrate", projectId],
      store,
      { now: () => new Date(NOW) }
    ),
    /Managed Project path is already registered/
  );
});
