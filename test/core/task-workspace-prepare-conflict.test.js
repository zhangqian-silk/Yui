/**
 * Deterministic coverage for the prepare single-writer guard:
 *
 *  - a prepare that loses the workspace identity race to a concurrent
 *    rebuild (or a concurrent prepare) discards its own worktrees and
 *    branches, retries, and converges to the winner's committed identity;
 *  - a rebuild that loses the race to a prepare fails closed and leaves no
 *    half-created refs behind;
 *  - a persistent StorageConflictError rides the same retry channel and is
 *    surfaced once the bound is exhausted, with no half-created branch,
 *    worktree, or catalog record left behind.
 *
 * Every race is injected at a deterministic git-port seam; no test relies
 * on timing or on an external checkout.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore, StorageConflictError } from "../../dist/storage/taskStore.js";
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

async function prepareFixture(t) {
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

function yuiBranches(fixture) {
  return git(fixture.project.path, ["for-each-ref", "--format=%(refname)"])
    .split("\n")
    .filter((ref) => ref.startsWith("refs/heads/yui/"))
    .sort();
}

function worktreePaths(fixture) {
  return git(fixture.project.path, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function expectedWorktreePath(fixture, taskId, identity) {
  return join(fixture.workspace, "worktree", "Yui", `${taskId}-${identity.token}`, "main");
}

/**
 * A git port that lets a competitor win the identity race after this
 * prepare minted its own identity but before it commits: the competitor
 * runs to completion inside the first `ensureWorktree` call, then the
 * racing prepare continues and must lose the transaction CAS.
 */
function racingGitPort(competitor) {
  const real = new NodeGitWorkspace();
  let raced = false;
  return new Proxy(real, {
    get(target, property) {
      if (property === "ensureWorktree" && !raced) {
        return async (input) => {
          raced = true;
          await competitor();
          return target.ensureWorktree(input);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

test("a prepare that loses the identity race to a rebuild discards its refs and converges", async (t) => {
  const fixture = await prepareFixture(t);
  const created = runTaskCommand(
    ["create", "Rebuild Race Task", "--project", "project-1"],
    fixture.store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;

  // The competitor rebuild runs with the real git port and the same store.
  const rebuildPreparer = new FileTaskWorkspacePreparer(
    fixture.home,
    fixture.store,
    undefined,
    () => new Date(NOW)
  );
  const racing = new FileTaskWorkspacePreparer(
    fixture.home,
    fixture.store,
    racingGitPort(() => rebuildPreparer.rebuildTaskWorkspace(task.id)),
    () => new Date(NOW)
  );

  await racing.prepareTaskWorkspace(task.id);

  // Only the rebuild's identity survived; the racing prepare converged to it.
  const winner = fixture.store.getTask(task.id).workspaceIdentity;
  assert.ok(winner, "the rebuild bound its identity");
  const workspace = fixture.store.getTaskWorkspace(task.id);
  assert.equal(workspace.entries.length, 1);
  assert.equal(workspace.entries[0].branch, `yui/${task.id}-${winner.token}/main`);
  assert.equal(workspace.entries[0].path, expectedWorktreePath(fixture, task.id, winner));

  // The losing prepare left no half-created branch or worktree behind.
  assert.deepEqual(yuiBranches(fixture), [`refs/heads/yui/${task.id}-${winner.token}/main`]);
  const paths = worktreePaths(fixture);
  assert.deepEqual(paths, [fixture.project.path, expectedWorktreePath(fixture, task.id, winner)]);
  assert.equal(existsSync(join(fixture.workspace, "tasks", task.id, "main", "Yui")), true);
});

test("a prepare that loses the identity race to a concurrent prepare converges to the winner", async (t) => {
  const fixture = await prepareFixture(t);
  const created = runTaskCommand(
    ["create", "Prepare Race Task", "--project", "project-1"],
    fixture.store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;

  // The competitor is a second prepare over the same store and repository.
  const competing = new FileTaskWorkspacePreparer(
    fixture.home,
    fixture.store,
    undefined,
    () => new Date(NOW)
  );
  const racing = new FileTaskWorkspacePreparer(
    fixture.home,
    fixture.store,
    racingGitPort(() => competing.prepareTaskWorkspace(task.id)),
    () => new Date(NOW)
  );

  await racing.prepareTaskWorkspace(task.id);

  const winner = fixture.store.getTask(task.id).workspaceIdentity;
  assert.ok(winner, "one prepare bound its identity");
  assert.deepEqual(yuiBranches(fixture), [`refs/heads/yui/${task.id}-${winner.token}/main`]);
  assert.deepEqual(worktreePaths(fixture), [
    fixture.project.path,
    expectedWorktreePath(fixture, task.id, winner)
  ]);
});

test("a rebuild that loses the identity race to a prepare fails without half-created refs", async (t) => {
  const fixture = await prepareFixture(t);
  const created = runTaskCommand(
    ["create", "Rebuild Loses Task", "--project", "project-1"],
    fixture.store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;

  // A prepare wins the identity race while the rebuild is creating its worktrees.
  const competing = new FileTaskWorkspacePreparer(
    fixture.home,
    fixture.store,
    undefined,
    () => new Date(NOW)
  );
  const racingRebuild = new FileTaskWorkspacePreparer(
    fixture.home,
    fixture.store,
    racingGitPort(() => competing.prepareTaskWorkspace(task.id)),
    () => new Date(NOW)
  );

  await assert.rejects(
    racingRebuild.rebuildTaskWorkspace(task.id),
    /Task changed while rebuilding its workspace/
  );

  // The prepare's identity is the single winner; the rebuild left no residue.
  const winner = fixture.store.getTask(task.id).workspaceIdentity;
  assert.ok(winner, "the prepare bound its identity");
  assert.deepEqual(yuiBranches(fixture), [`refs/heads/yui/${task.id}-${winner.token}/main`]);
  assert.deepEqual(worktreePaths(fixture), [
    fixture.project.path,
    expectedWorktreePath(fixture, task.id, winner)
  ]);

  // A retry of the rebuild takes the resume path and succeeds.
  const retried = await fixture.preparer.rebuildTaskWorkspace(task.id);
  assert.equal(retried.resumed, true);
});

test("a persistent storage conflict surfaces StorageConflictError without half-created refs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-prepare-conflict-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "yui-home");
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
  const created = runTaskCommand(
    ["create", "Conflict Task", "--project", "project-1"],
    store,
    { now: () => new Date(NOW) }
  );
  const task = created.data.task;

  // Every prepare attempt reads through to the real store but its commit
  // transaction loses to a simulated concurrent writer.
  let attempts = 0;
  const conflicting = new Proxy(store, {
    get(target, property) {
      if (property === "transaction") {
        return (callback) => {
          attempts += 1;
          throw new StorageConflictError("simulated persistent storage revision conflict");
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const preparer = new FileTaskWorkspacePreparer(home, conflicting, undefined, () => new Date(NOW));

  await assert.rejects(
    preparer.prepareTaskWorkspace(task.id),
    (error) => error instanceof StorageConflictError
      && /simulated persistent storage revision conflict/.test(error.message)
  );

  // One initial attempt plus the bounded retries; the last conflict surfaces.
  assert.equal(attempts, 4);
  // Nothing half-created: no identity, no catalog record, no branch, no worktree.
  assert.equal(store.getTask(task.id).workspaceIdentity, undefined);
  assert.equal(store.getTaskWorkspace(task.id), null);
  assert.deepEqual(
    git(project.path, ["for-each-ref", "--format=%(refname)"])
      .split("\n")
      .filter((ref) => ref.startsWith("refs/heads/yui/")),
    []
  );
  assert.deepEqual(
    git(project.path, ["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length)),
    [project.path]
  );
});
