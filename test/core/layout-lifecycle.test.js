import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { GitIntegrationService } from "../../dist/integration/gitIntegrationService.js";
import { createIntegrationAttempt } from "../../dist/integration/integrationAttempt.js";
import { createProject } from "../../dist/repository/project.js";
import {
  FileTaskWorkspacePreparer,
  integrationWorkspaceRoot
} from "../../dist/repository/taskWorkspacePreparer.js";
import {
  managedTaskRoot,
} from "../../dist/storage/homeLayout.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask } from "../../dist/task/task.js";
import {
  createCandidateGitSnapshot,
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemWriteProjects,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

// End-to-end proof of the v20 single-layer layout (acceptance criterion 1):
// every managed worktree the runtime creates for a new Task — its main, a
// WorkItem, an Integration attempt — is a REAL directory at
// `<home>/workspaces/tasks/<taskId>/<owner>/<projectDirectory>`, addressed by
// the BOUND directory (honoring a `--directory` override), never under the
// legacy `worktree/` root and never nested inside another Project's Git
// worktree. Drives the actual preparer and integration service against private
// disposable Homes with local Git remotes; no real models, shared resources, or
// current-environment mutation.

const now = new Date("2026-09-01T00:00:00.000Z");
const gitEnv = sanitizedTestEnv({
  GIT_AUTHOR_NAME: "Yui Test",
  GIT_AUTHOR_EMAIL: "yui-test@example.com",
  GIT_COMMITTER_NAME: "Yui Test",
  GIT_COMMITTER_EMAIL: "yui-test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null"
});

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();
}

function commitFile(repo, name, body, message) {
  writeFileSync(join(repo, name), body);
  git(["add", "."], repo);
  git(["commit", "-m", message], repo);
}

function newHome(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-layout-lifecycle-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** A bare remote plus a Home-managed clone catalogued as the Project checkout. */
function seedManagedProject(home, projectId, projectName) {
  const remote = join(home, "remotes", `${projectId}.git`);
  mkdirSync(join(home, "remotes"), { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=master", remote], { env: gitEnv });
  const seed = join(home, "seeds", projectId);
  mkdirSync(dirname(seed), { recursive: true });
  execFileSync("git", ["clone", remote, seed], { env: gitEnv });
  commitFile(seed, "README.md", `# ${projectName}\n`, "seed");
  git(["push", "origin", "master"], seed);
  mkdirSync(join(home, "projects"), { recursive: true });
  const checkout = join(home, "projects", projectId);
  execFileSync("git", ["clone", remote, checkout], { env: gitEnv });
  return { remote, checkout };
}

function registerProject(store, projectId, projectName, checkout, remote) {
  const project = createProject(
    projectId, projectName, checkout,
    { stable: "master", development: "master" }, now,
    { remoteUrl: remote, ownership: "managed" }
  );
  store.saveProject(project);
  return project;
}

/** True when `child` is a real directory strictly inside `parent`. */
function isRealDirUnder(parent, child) {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && lstatSync(child).isDirectory()
    && !lstatSync(child).isSymbolicLink();
}

/** Assert one managed worktree entry sits at the v20 single-layer path. */
function assertSingleLayerEntry(home, entry, ownerRoot, boundDirectory) {
  // The entry path is a REAL directory at join(ownerRoot, boundDirectory),
  // addressed by the bound directory rather than the Project name.
  assert.equal(entry.directory, boundDirectory, "entry directory is the bound directory");
  assert.equal(entry.path, join(ownerRoot, boundDirectory), "entry path is the single-layer path");
  assert.equal(lstatSync(entry.path).isDirectory(), true, "entry path is a real directory");
  assert.equal(lstatSync(entry.path).isSymbolicLink(), false, "entry path is not a symlink view");
  // It is a valid, independent Git work tree.
  assert.equal(git(["-C", entry.path, "rev-parse", "--is-inside-work-tree"]), "true");
  // It is NOT under the legacy physical worktree root.
  assert.equal(
    relative(join(home, "workspaces", "worktree"), entry.path).startsWith(".."), true,
    "worktree is not under the legacy worktree/ root"
  );
  // It IS under the managed tasks/ root.
  assert.equal(
    isRealDirUnder(managedTaskRoot(home), entry.path), true,
    "worktree is under the managed tasks/ root"
  );
}

test("new Task multi-project lifecycle lands every worktree at the single-layer Task/owner path", async (t) => {
  const home = newHome(t);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  // A disposable defaultWorkspace so any cleanup-path fallback can never point at
  // the real repository cwd; managed worktree placement does not depend on it.
  const workspaceRoot = mkdtempSync(join(tmpdir(), "yui-default-workspace-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  store.saveConfig({ ...store.getConfig(), defaultWorkspace: workspaceRoot });

  // Two managed Projects; the SECOND is bound to a directory that DIFFERS from
  // its Project name (a `--directory` override), proving the layout addresses by
  // the bound directory, not the Project name.
  const app = seedManagedProject(home, "project-1", "app");
  const lib = seedManagedProject(home, "project-2", "lib");
  registerProject(store, "project-1", "app", app.checkout, app.remote);
  registerProject(store, "project-2", "lib", lib.checkout, lib.remote);

  const taskId = store.nextTaskId();
  const task = createTask(taskId, "Multi-project layout", now, {
    projectBindings: [
      { projectId: "project-1", directory: "app", baseRef: "master" },
      { projectId: "project-2", directory: "lib-src", baseRef: "master" }
    ]
  });
  store.saveTask(task);

  const preparer = new FileTaskWorkspacePreparer(home, store);
  await preparer.activateTaskWorkspace(task.id);

  // (1) Task main: one real worktree per Project at tasks/<taskId>/main/<dir>.
  const taskWorkspace = store.getTaskWorkspace(task.id);
  const taskMainRoot = join(managedTaskRoot(home), taskId, "main");
  assert.equal(taskWorkspace.root, taskMainRoot, "task main workspace root is the owner directory");
  const appMain = taskWorkspace.entries.find((e) => e.projectId === "project-1");
  const libMain = taskWorkspace.entries.find((e) => e.projectId === "project-2");
  assertSingleLayerEntry(home, appMain, taskMainRoot, "app");
  assertSingleLayerEntry(home, libMain, taskMainRoot, "lib-src");
  // The two Project worktrees are siblings, neither nested inside the other's Git tree.
  assert.equal(
    relative(appMain.path, libMain.path).startsWith(".."), true,
    "the lib worktree is not nested inside the app worktree"
  );
  assert.equal(
    relative(libMain.path, appMain.path).startsWith(".."), true,
    "the app worktree is not nested inside the lib worktree"
  );

  // (2) A WorkItem writing project-2 (the `--directory` override Project) gets
  // its own isolated write worktree under tasks/<taskId>/work-items/<id>/,
  // addressed by the bound directory `lib-src`; the other Project is a READ view.
  let item = createWorkItem(
    store.nextWorkItemId(task.id), task.id,
    { title: "Change lib", writeProjectIds: ["project-2"] }, now
  );
  item = updateWorkItemStatus(item, "open", now);
  store.saveWorkItem(task.id, item);
  const workItemWorkspace = await preparer.prepareWorkItemWorkspace(task.id, item.id);
  const workItemRoot = join(managedTaskRoot(home), taskId, "work-items", item.id);
  assert.equal(workItemWorkspace.root, workItemRoot, "work-item workspace root is the owner directory");
  const writeEntry = workItemWorkspace.entries.find((e) => e.access === "write");
  assert.equal(writeEntry.projectId, "project-2", "the writable Project is project-2");
  assertSingleLayerEntry(home, writeEntry, workItemRoot, "lib-src");
  const readEntry = workItemWorkspace.entries.find((e) => e.access === "read");
  assert.equal(readEntry.projectId, "project-1", "the read-only Project is project-1");

  // Scope expansion promotes an owned read view into an independent worktree.
  const promotedPath = join(workItemRoot, "app");
  assert.equal(lstatSync(promotedPath).isSymbolicLink(), true);
  item = updateWorkItemWriteProjects(item, ["project-1", "project-2"], now);
  store.saveWorkItem(task.id, item);
  const expanded = await preparer.prepareWorkItemWorkspace(task.id, item.id);
  const promoted = expanded.entries.find((entry) => entry.projectId === "project-1");
  assert.equal(promoted.access, "write");
  assertSingleLayerEntry(home, promoted, workItemRoot, "app");
  assert.equal(git(["rev-parse", "--show-toplevel"], promotedPath), promotedPath);

  // (3) An Integration attempt for project-2 gets a worktree under
  // tasks/<taskId>/integrations/<id>/<boundDirectory>, addressed by the BOUND
  // directory `lib-src` — the exact case the 19->20 migration reshapes for
  // legacy Homes that stored the integration entry under the Project name.
  const beforeCommit = store.getTask(task.id).projectBindings
    .find((b) => b.projectId === "project-2").currentCommit;
  const resultCommit = git(["rev-parse", "HEAD"], writeEntry.path);
  // The candidate snapshot must cover every workspace entry, so record the
  // read-only Project's main HEAD alongside the write Project's result commit.
  const readCommit = git(["rev-parse", "HEAD"], readEntry.path);
  item = submitWorkItemCandidate(item, {
    summary: "The requested behavior is already present.",
    source: { type: "direct" },
    workspace: workItemWorkspace,
    gitSnapshot: createCandidateGitSnapshot(workItemWorkspace, [
      { projectId: "project-1", commit: readCommit },
      { projectId: "project-2", commit: resultCommit }
    ])
  }, now);
  store.saveWorkItem(task.id, item);

  const attempt = createIntegrationAttempt({
    id: store.nextIntegrationAttemptId(task.id),
    taskId: task.id,
    projectId: "project-2",
    targetRef: libMain.branch,
    beforeCommit,
    source: {
      kind: "work-item",
      workItemId: item.id,
      startCommit: resultCommit,
      resultCommit,
      strategy: "manual"
    }
  }, now);
  store.saveIntegrationAttempt(task.id, attempt);
  const service = new GitIntegrationService(home, store);
  // A no-op WorkItem Integration blocks pending a resolution decision, but the
  // integration worktree + managed workspace are materialized and persisted
  // before that — enough to assert the on-disk single-layer shape.
  const integrated = await service.integrate(task.id, attempt.id);
  assert.equal(integrated.status, "blocked", JSON.stringify(integrated.attempt, null, 2));

  const integrationWorkspace = store.getIntegrationWorkspace(task.id, attempt.id);
  assert.notEqual(integrationWorkspace, null, "integration workspace was persisted");
  const integrationRoot = integrationWorkspaceRoot(home, taskId, attempt.id);
  assert.equal(
    integrationRoot, join(managedTaskRoot(home), taskId, "integrations", attempt.id),
    "integration owner root is tasks/<taskId>/integrations/<id>"
  );
  const integrationEntry = integrationWorkspace.entries[0];
  assertSingleLayerEntry(home, integrationEntry, integrationRoot, "lib-src");
  assert.equal(
    integrationWorkspace.root, integrationEntry.path,
    "integration workspace root is the worktree leaf itself"
  );

  // Nothing at all was written under the legacy physical worktree root.
  assert.equal(
    existsSync(join(home, "workspaces", "worktree")), false,
    "the collapsed layout never creates the legacy worktree/ root"
  );
});
