/**
 * Regression coverage for the archive-before-delete ordering of the legacy
 * Task ref archive (`task history archive`, with and without a taskId):
 *
 *  - a registered worktree checked out on the to-be-archived ref is removed
 *    before its branch is deleted, so no worktree is stranded with an
 *    unborn HEAD;
 *  - a dirty or unidentifiable registered worktree fails the whole archive
 *    closed: no archive ref, no ref deletion, no worktree removal;
 *  - every step is resumable: a same-commit archive ref resumes, a missing
 *    worktree and an already-deleted source are no-ops.
 *
 * The fixtures mirror task-workspace-rebuild.test.js: a pre-identity Task
 * with its managed worktree on `yui/task-N/main`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { runTaskWorkspaceCommand } from "../../dist/commands/taskWorkspaceCommands.js";
import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, archiveTask, completeTask } from "../../dist/task/task.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
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

async function archiveFixture(t) {
  const { root, home } = createIsolatedRuntime(t);
  installMockProviderCommands(home);
  const workspace = join(root, "workspace");
  const repositoryPath = join(workspace, "Yui");
  initRepository(repositoryPath);

  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.saveConfiguredAgent(agent);
  store.saveConfig({
    schemaVersion: 1,
    defaultWorkspace: workspace,
    defaultAgent: agent.id
  });
  await runProjectCommand(
    ["add", "Yui", repositoryPath, "--stable", "main", "--development", "main"],
    store,
    { now: () => new Date(NOW) }
  );
  const project = store.getProject("project-1");
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  return { root, home, workspace, repositoryPath, store, project, preparer };
}

/**
 * Build the pre-identity layout for a Task: a managed worktree at the bare
 * `task-N` segment (branch `yui/task-N/main`) and a v2 managed-workspace
 * record, with no workspace identity on the Task.
 */
async function legacyTask(fixture, title = "Legacy Task") {
  const { store, project, workspace } = fixture;
  const created = runTaskCommand(
    ["create", title, "--project", project.id],
    store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;
  const git = new NodeGitWorkspace();
  const physical = await git.ensureWorktree({
    repositoryPath: project.path,
    container: join(workspace, "worktree", project.name),
    taskSegment: task.id,
    roleName: "main",
    baseRef: task.projectBindings[0].baseRef
  });
  const root = join(workspace, "tasks", task.id, "main");
  const entry = {
    projectId: project.id,
    directory: project.name,
    access: "write",
    path: physical.path,
    branch: physical.branch,
    baseRef: task.projectBindings[0].baseRef,
    baseCommit: physical.baseCommit
  };
  const managed = createManagedWorkspace({
    owner: { type: "task", taskId: task.id },
    root,
    entries: [entry]
  }, NOW);
  store.saveManagedWorkspace(managed);
  return { task, managed, entry, legacyRef: physical.branch };
}

function retireTask(fixture, task) {
  const completed = completeTask(activateTask(task, NOW), NOW, { by: "leader", summary: "done" });
  fixture.store.saveTask(archiveTask(completed, NOW));
}

function archiveRefName(fixture, legacyRef) {
  return `refs/yui/archive/${fixture.store.getHomeIdentity().homeId}/heads/${legacyRef}`;
}

/** Every worktree Git still registers for the Project repository. */
function registeredWorktrees(repositoryPath) {
  const porcelain = git(repositoryPath, ["worktree", "list", "--porcelain"]);
  const found = [];
  let current;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      found.push(current);
    } else if (line.startsWith("branch ") && current !== undefined) {
      current.branch = line.slice("branch ".length);
    }
  }
  return found;
}

function archiveCommand(fixture, args = []) {
  return runTaskWorkspaceCommand(
    ["history", "archive", ...args],
    fixture.store,
    fixture.preparer,
    { now: () => new Date(NOW) }
  );
}

test("archive removes a registered worktree before deleting its ref", async (t) => {
  const fixture = await archiveFixture(t);
  const { task, legacyRef } = await legacyTask(fixture);
  const legacyCommit = git(fixture.project.path, ["rev-parse", legacyRef]);
  const legacyWorktree = join(fixture.workspace, "worktree", "Yui", task.id, "main");
  assert.equal(existsSync(legacyWorktree), true);
  retireTask(fixture, task);

  const result = await archiveCommand(fixture, [task.id]);
  assert.deepEqual(result.data.archived, [`project-1:refs/heads/${legacyRef}`]);

  // The worktree is gone, not stranded on a deleted branch.
  assert.equal(existsSync(legacyWorktree), false, "the registered worktree is removed");
  const registered = registeredWorktrees(fixture.project.path).map(({ path }) => path);
  assert.equal(registered.includes(legacyWorktree), false);
  for (const worktree of registeredWorktrees(fixture.project.path)) {
    assert.equal(
      git(worktree.path, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]).length,
      40,
      `no registered worktree has an unborn HEAD: ${worktree.path}`
    );
  }

  // The commit survives in the Home-scoped archive; the active ref is gone.
  assert.equal(git(fixture.project.path, ["rev-parse", archiveRefName(fixture, legacyRef)]), legacyCommit);
  assert.throws(() => git(fixture.project.path, ["rev-parse", legacyRef]));
});

test("archive fails closed on a dirty registered worktree", async (t) => {
  const fixture = await archiveFixture(t);
  const { task, legacyRef, entry } = await legacyTask(fixture);
  writeFileSync(join(entry.path, "uncommitted.txt"), "dirty\n");
  retireTask(fixture, task);

  await assert.rejects(archiveCommand(fixture, [task.id]), /dirty and blocks the archive/i);

  // Nothing was archived, deleted, or removed.
  assert.equal(existsSync(entry.path), true, "the dirty worktree is retained");
  assert.equal(
    git(fixture.project.path, ["rev-parse", legacyRef]).length,
    40,
    "the active ref is retained"
  );
  assert.throws(
    () => git(fixture.project.path, ["rev-parse", archiveRefName(fixture, legacyRef)]),
    undefined,
    "no archive ref was created"
  );
  assert.equal(
    git(entry.path, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]).length,
    40,
    "the retained worktree still has a valid HEAD"
  );
});

test("archive is idempotent and resumes a partial archive", async (t) => {
  const fixture = await archiveFixture(t);
  const { task, legacyRef } = await legacyTask(fixture);
  const legacyCommit = git(fixture.project.path, ["rev-parse", legacyRef]);
  const legacyWorktree = join(fixture.workspace, "worktree", "Yui", task.id, "main");
  retireTask(fixture, task);

  const first = await archiveCommand(fixture, [task.id]);
  assert.deepEqual(first.data.archived, [`project-1:refs/heads/${legacyRef}`]);

  // A second run is a no-op: the ref is already gone.
  const second = await archiveCommand(fixture, [task.id]);
  assert.match(second.output, /No legacy Task refs to archive/);

  // Partial state: the archive ref and the worktree survived a previous
  // attempt (its commit was retained before the worktree was removed).
  // Re-archiving removes the worktree and deletes the source, converging.
  const partial = await archiveFixture(t);
  const partialTask = await legacyTask(partial);
  const partialCommit = git(partial.project.path, ["rev-parse", partialTask.legacyRef]);
  const partialWorktree = join(partial.workspace, "worktree", "Yui", partialTask.task.id, "main");
  retireTask(partial, partialTask.task);
  git(partial.project.path, ["update-ref", archiveRefName(partial, partialTask.legacyRef), partialCommit]);

  await archiveCommand(partial, [partialTask.task.id]);
  assert.equal(existsSync(partialWorktree), false, "the partial run resumes and removes the worktree");
  assert.throws(() => git(partial.project.path, ["rev-parse", partialTask.legacyRef]));
  assert.equal(
    git(partial.project.path, ["rev-parse", archiveRefName(partial, partialTask.legacyRef)]),
    partialCommit
  );

  // Partial state: the archive ref exists but the source survived.
  // Re-archiving deletes the source and keeps the same archive ref.
  git(fixture.project.path, ["update-ref", `refs/heads/${legacyRef}`, legacyCommit]);
  const resumed = await archiveCommand(fixture, [task.id]);
  assert.deepEqual(resumed.data.archived, [`project-1:refs/heads/${legacyRef}`]);
  assert.throws(() => git(fixture.project.path, ["rev-parse", legacyRef]));
  assert.equal(git(fixture.project.path, ["rev-parse", archiveRefName(fixture, legacyRef)]), legacyCommit);
});

test("the no-taskId archive scan applies the same worktree ordering", async (t) => {
  const fixture = await archiveFixture(t);
  const { task, legacyRef } = await legacyTask(fixture);
  const legacyCommit = git(fixture.project.path, ["rev-parse", legacyRef]);
  const legacyWorktree = join(fixture.workspace, "worktree", "Yui", task.id, "main");
  retireTask(fixture, task);

  const result = await archiveCommand(fixture);
  assert.deepEqual(result.data.archived, [`project-1:refs/heads/${legacyRef}`]);
  assert.equal(existsSync(legacyWorktree), false, "the scan removes the worktree before deleting the ref");
  assert.equal(git(fixture.project.path, ["rev-parse", archiveRefName(fixture, legacyRef)]), legacyCommit);
  assert.throws(() => git(fixture.project.path, ["rev-parse", legacyRef]));
  assert.equal(
    registeredWorktrees(fixture.project.path).some(({ path }) => path === legacyWorktree),
    false
  );
});
