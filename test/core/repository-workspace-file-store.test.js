import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runRepositoryCommand } from "../../dist/commands/repositoryCommands.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import {
  createRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, archiveTask, createTask } from "../../dist/task/task.js";

const NOW = new Date("2026-07-19T12:00:00.000Z");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "taskmux-repository-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const repositoryPath = join(root, "repository");
  execFileSync("git", ["init", "-q", repositoryPath]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.name", "TaskMux Test"]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.email", "taskmux@example.invalid"]);
  writeFileSync(join(repositoryPath, "tracked.txt"), "initial\n");
  execFileSync("git", ["-C", repositoryPath, "add", "tracked.txt"]);
  execFileSync("git", ["-C", repositoryPath, "commit", "-qm", "initial"]);
  ensureStorageSchema(home, NOW);
  return { root, home, repositoryPath, store: new FileTaskStore(home) };
}

test("repository add validates Git and persists the canonical root", async (t) => {
  const { repositoryPath, store } = fixture(t);
  const output = await runRepositoryCommand(
    ["add", "TaskMux", join(repositoryPath, "."), "--base", "HEAD"],
    store,
    { now: () => new Date(NOW) }
  );
  assert.match(output, /Added repository repository-1/);
  assert.deepEqual(store.listRepositories(), [{
    schemaVersion: 1,
    id: "repository-1",
    name: "TaskMux",
    path: realpathSync(repositoryPath),
    defaultBranch: "HEAD",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  }]);
  assert.match(await runRepositoryCommand(["list"], store), /TaskMux/);

  await assert.rejects(
    runRepositoryCommand(["add", "Broken", repositoryPath, "--base", "missing-ref"], store),
    /Git command failed/i
  );
  assert.equal(store.listRepositories().length, 1);
});

test("active repository Task gets one deterministic worktree and atomic Role workspaces", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  await runRepositoryCommand(["add", "TaskMux", repositoryPath], store, {
    now: () => new Date(NOW)
  });
  const repository = store.listRepositories()[0];
  execFileSync("git", ["-C", repositoryPath, "branch", "temporary-base"]);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  const task = activateTask(createTask("task-1", "Repository Task", NOW, {
    repositoryId: repository.id,
    baseRef: "temporary-base"
  }), NOW);
  const leader = createRole(
    task.id,
    "leader",
    [createRoleAgentBinding(agent)],
    agent.id,
    repository.path,
    NOW
  );
  const worker = createRole(
    task.id,
    "worker",
    [createRoleAgentBinding(agent)],
    agent.id,
    repository.path,
    NOW
  );
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveRole(task.id, leader);
    tx.saveRole(task.id, worker);
  });

  const planner = new FileRoleLaunchPlanner(home, store, { cliPath: "/dist/cli.js" });
  assert.throws(() => planner.plan({
    taskId: task.id,
    roleName: leader.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  }), /workspace is not ready/i);

  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const first = await preparer.prepareTaskWorkspace(task.id);
  const expected = join(home, "worktrees", task.id);
  assert.deepEqual(first, { taskId: task.id, status: "ready", path: expected });
  assert.equal(store.getTask(task.id).cwd, expected);
  assert.deepEqual(store.listRoles(task.id).map(({ workspace }) => workspace), [expected, expected]);
  assert.equal(existsSync(join(expected, ".git")), true);

  const revision = JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision;
  execFileSync("git", ["-C", repositoryPath, "branch", "-D", "temporary-base"]);
  assert.deepEqual(await preparer.prepareTaskWorkspace(task.id), first);
  assert.equal(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision, revision);

  store.saveTask(archiveTask(store.getTask(task.id), NOW));
  assert.deepEqual(await preparer.prepareTaskWorkspace(task.id), {
    taskId: task.id,
    status: "archived-clean"
  });
  assert.equal(existsSync(expected), false);
  assert.equal(store.getTask(task.id).cwd, undefined);
  assert.deepEqual(store.listRoles(task.id).map(({ workspace }) => workspace), [
    repository.path,
    repository.path
  ]);
  assert.equal((await preparer.prepareTaskWorkspace(task.id)).status, "archived-clean");
});

test("archived repository Task never creates a worktree", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  await runRepositoryCommand(["add", "TaskMux", repositoryPath], store);
  const repository = store.listRepositories()[0];
  const task = archiveTask(createTask("task-1", "Archived", NOW, {
    repositoryId: repository.id
  }), NOW);
  store.saveTask(task);

  const result = await new FileTaskWorkspacePreparer(home, store).prepareTaskWorkspace(task.id);
  assert.equal(result.status, "archived-clean");
  assert.equal(existsSync(join(home, "worktrees", task.id)), false);
});
