/**
 * Deterministic coverage for the per-Project maintenance fence:
 *
 *  - maintenance on the same Project contends: the loser fails closed with a
 *    retryable error and makes no changes;
 *  - maintenance on different Projects never blocks each other;
 *  - the Controller defers (never fails) a Task whose Project is fenced and
 *    prepares it normally once the fence is released;
 *  - a crashed holder (dead PID + aged lock) is reclaimed, while a live owner
 *    keeps the fence.
 *
 * Fixtures mirror task-workspace-rebuild.test.js: real git on disk, real
 * FileTaskStore, real FileTaskWorkspacePreparer.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { runControllerSchedulerPass } from "../../dist/controller/controller.js";
import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import {
  acquireProjectMaintenanceLock,
  isProjectMaintenanceFenced,
  ProjectMaintenanceLockedError,
  projectMaintenanceLockPath
} from "../../dist/repository/projectMaintenanceLock.js";
import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask } from "../../dist/task/task.js";
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
  return { root, home, workspace, store, projectIds, preparer };
}

const noTmux = {
  async prepareRoleSession() { throw new Error("unused"); },
  async waitUntilReady() { throw new Error("unused"); },
  async sendOnce() { throw new Error("unused"); },
  async inspectRole() { throw new Error("unused"); },
  async stopTask() { return false; }
};

test("same-Project maintenance contends: the loser fails closed, retryable", async (t) => {
  const { home, projectIds } = await fenceFixture(t);
  const release = acquireProjectMaintenanceLock(home, projectIds[0]);
  try {
    assert.equal(isProjectMaintenanceFenced(home, projectIds[0]), true);
    assert.throws(
      () => acquireProjectMaintenanceLock(home, projectIds[0]),
      (error) => error instanceof ProjectMaintenanceLockedError && error.retryable === true
    );
  } finally {
    release();
  }
  // Once released, the fence is open and acquisition succeeds.
  assert.equal(isProjectMaintenanceFenced(home, projectIds[0]), false);
  const again = acquireProjectMaintenanceLock(home, projectIds[0]);
  again();
});

test("maintenance on one Project never blocks another Project", async (t) => {
  const { home, projectIds } = await fenceFixture(t, { projects: 2 });
  const releaseA = acquireProjectMaintenanceLock(home, projectIds[0]);
  try {
    const releaseB = acquireProjectMaintenanceLock(home, projectIds[1]);
    releaseB();
  } finally {
    releaseA();
  }
});

test("the Controller defers a fenced Project's Task and prepares it after release", async (t) => {
  const { home, workspace, store, projectIds, preparer } = await fenceFixture(t);
  const created = runTaskCommand(
    ["create", "Fenced Task", "--project", projectIds[0]],
    store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;
  store.saveTask(activateTask(task, NOW));

  const release = acquireProjectMaintenanceLock(home, projectIds[0]);
  const deferred = [];
  try {
    await runControllerSchedulerPass(
      new FileSchedulerStoreAdapter(store),
      noTmux,
      NOW,
      preparer,
      { kind: "full" },
      false,
      [],
      undefined,
      undefined,
      (projectId) => isProjectMaintenanceFenced(home, projectId),
      (detail) => deferred.push(detail)
    );
  } finally {
    release();
  }

  assert.deepEqual(deferred, [{ taskId: task.id, projectIds: [projectIds[0]] }]);
  assert.equal(
    store.getTask(task.id).workspaceIdentity,
    undefined,
    "the fenced Task was not prepared"
  );

  // Once the fence is released, the next pass prepares the Task normally.
  await runControllerSchedulerPass(
    new FileSchedulerStoreAdapter(store),
    noTmux,
    NOW,
    preparer,
    { kind: "full" },
    false
  );
  const prepared = store.getTask(task.id);
  assert.ok(prepared.workspaceIdentity, "the Task is prepared after the fence releases");
  const segment = `${task.id}-${prepared.workspaceIdentity.token}`;
  assert.equal(existsSync(join(workspace, "worktree", "Repo0", segment, "main")), true);
});

test("a crashed holder is reclaimed; a live owner keeps the fence", async (t) => {
  const { home, projectIds } = await fenceFixture(t, { projects: 2 });
  const lock = projectMaintenanceLockPath(home, projectIds[0]);

  // A dead PID with an aged lock is a crashed holder: acquisition reclaims it.
  const deadRelease = acquireProjectMaintenanceLock(home, projectIds[0]);
  deadRelease();
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  writeFileSync(join(lock, "owner"), "99999999:1\n", { mode: 0o600 });
  const old = new Date(Date.now() - 5_000);
  utimesSync(lock, old, old);
  const reclaimed = acquireProjectMaintenanceLock(home, projectIds[0]);
  reclaimed();

  // A live owner (this process, with its real start identity) is not reclaimed.
  const liveRelease = acquireProjectMaintenanceLock(home, projectIds[1]);
  try {
    assert.throws(
      () => acquireProjectMaintenanceLock(home, projectIds[1]),
      ProjectMaintenanceLockedError
    );
  } finally {
    liveRelease();
  }
});

test("prepareTaskWorkspace holds the per-Project maintenance fence while preparing", async (t) => {
  const { home, projectIds, store } = await fenceFixture(t);
  const created = runTaskCommand(
    ["create", "Fenced Prepare Task", "--project", projectIds[0]],
    store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;

  // During ensureWorktree the prepare must hold the file-based fence: a
  // concurrent singular acquisition (the same entry migrate and the fence
  // probe use) fails fast with ProjectMaintenanceLockedError. The singular
  // entry always contends, so this proves the prepare took the lock rather
  // than relying on the Controller's check-then-call probe.
  const real = new NodeGitWorkspace();
  let checked = false;
  const fencingGit = new Proxy(real, {
    get(target, property) {
      if (property === "ensureWorktree" && !checked) {
        return async (input) => {
          checked = true;
          assert.throws(
            () => acquireProjectMaintenanceLock(home, projectIds[0]),
            ProjectMaintenanceLockedError
          );
          return target.ensureWorktree(input);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  const fencing = new FileTaskWorkspacePreparer(
    home,
    store,
    fencingGit,
    () => new Date(NOW)
  );
  await fencing.prepareTaskWorkspace(task.id);

  assert.ok(store.getTask(task.id).workspaceIdentity, "the Task is prepared");
  // The fence is released once the prepare returns.
  const release = acquireProjectMaintenanceLock(home, projectIds[0]);
  release();
});

test("prepare revalidates the Project catalog path and retries after a concurrent migrate", async (t) => {
  const { home, projectIds, store, workspace } = await fenceFixture(t);
  // A second repo stands in for the Home-managed repo a migrate switches to.
  const migratedPath = join(workspace, "Migrated");
  initRepository(migratedPath);
  const originalPath = store.getProject(projectIds[0]).path;
  assert.notEqual(originalPath, migratedPath);

  const created = runTaskCommand(
    ["create", "Migrate Race Task", "--project", projectIds[0]],
    store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;

  // During the first ensureWorktree a concurrent migrate switches the Project
  // catalog to the Home-managed repo. The revalidation inside the prepare
  // transaction catches the changed path and rides the StorageConflictError
  // retry channel; the retry re-reads the catalog and prepares against the
  // migrated repo.
  const real = new NodeGitWorkspace();
  let migrated = false;
  const racingGit = new Proxy(real, {
    get(target, property) {
      if (property === "ensureWorktree" && !migrated) {
        return async (input) => {
          migrated = true;
          const project = store.getProject(projectIds[0]);
          store.saveProject({ ...project, path: migratedPath });
          return target.ensureWorktree(input);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  const racing = new FileTaskWorkspacePreparer(
    home,
    store,
    racingGit,
    () => new Date(NOW)
  );
  await racing.prepareTaskWorkspace(task.id);

  // The prepare retried against the migrated path and bound the Task.
  const prepared = store.getTask(task.id);
  assert.ok(prepared.workspaceIdentity, "the Task is bound after the retry");
  const segment = `${task.id}-${prepared.workspaceIdentity.token}`;
  const branch = `yui/${segment}/main`;

  // The new worktree's branch lives in the migrated repo, not the original.
  assert.equal(
    git(migratedPath, ["rev-parse", branch]).length,
    40,
    "the branch exists in the migrated repo"
  );
  assert.throws(
    () => git(originalPath, ["rev-parse", branch]),
    undefined,
    "the original repo has no prepare branch (the failed attempt was cleaned up)"
  );
});
