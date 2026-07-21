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
  const root = mkdtempSync(join(tmpdir(), "yui-repository-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const repositoryPath = join(root, "repository");
  execFileSync("git", ["init", "-q", repositoryPath]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.name", "Yui Test"]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(repositoryPath, "tracked.txt"), "initial\n");
  execFileSync("git", ["-C", repositoryPath, "add", "tracked.txt"]);
  execFileSync("git", ["-C", repositoryPath, "commit", "-qm", "initial"]);
  ensureStorageSchema(home, NOW);
  return { root, home, repositoryPath, store: new FileTaskStore(home) };
}

test("repository add validates Git and persists the canonical root", async (t) => {
  const { repositoryPath, store } = fixture(t);
  const output = await runRepositoryCommand(
    ["add", "Yui", join(repositoryPath, "."), "--base", "HEAD"],
    store,
    { now: () => new Date(NOW) }
  );
  assert.match(output, /Added repository repository-1/);
  assert.deepEqual(store.listRepositories(), [{
    schemaVersion: 1,
    id: "repository-1",
    name: "Yui",
    path: realpathSync(repositoryPath),
    defaultBranch: "HEAD",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  }]);
  assert.match(await runRepositoryCommand(["list"], store), /Yui/);

  await assert.rejects(
    runRepositoryCommand(["add", "Broken", repositoryPath, "--base", "missing-ref"], store),
    /Git command failed/i
  );
  assert.equal(store.listRepositories().length, 1);
});

test("active repository Task gets one deterministic worktree per Role", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  await runRepositoryCommand(["add", "Yui", repositoryPath], store, {
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
  const taskRoot = join(home, "worktrees", task.id);
  const leaderPath = join(taskRoot, "leader");
  const workerPath = join(taskRoot, "worker");
  assert.deepEqual(first, { taskId: task.id, status: "ready", path: taskRoot });
  assert.equal(store.getTask(task.id).cwd, taskRoot);
  assert.deepEqual(store.listRoles(task.id).map(({ workspace }) => workspace), [
    leaderPath,
    workerPath
  ]);
  assert.deepEqual(store.listRoleWorkspaces(task.id).map((workspace) => ({
    roleName: workspace.roleName,
    repositoryId: workspace.repositoryId,
    path: workspace.path,
    branch: workspace.branch,
    baseRef: workspace.baseRef
  })), [
    {
      roleName: "leader",
      repositoryId: repository.id,
      path: leaderPath,
      branch: `yui/${task.id}/leader`,
      baseRef: "temporary-base"
    },
    {
      roleName: "worker",
      repositoryId: repository.id,
      path: workerPath,
      branch: `yui/${task.id}/worker`,
      baseRef: "temporary-base"
    }
  ]);
  assert.equal(existsSync(join(leaderPath, ".git")), true);
  assert.equal(existsSync(join(workerPath, ".git")), true);
  assert.equal(
    execFileSync("git", ["-C", leaderPath, "branch", "--show-current"], { encoding: "utf8" }).trim(),
    `yui/${task.id}/leader`
  );
  assert.equal(
    execFileSync("git", ["-C", workerPath, "branch", "--show-current"], { encoding: "utf8" }).trim(),
    `yui/${task.id}/worker`
  );

  const revision = JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision;
  execFileSync("git", ["-C", repositoryPath, "branch", "-D", "temporary-base"]);
  assert.deepEqual(await preparer.prepareTaskWorkspace(task.id), first);
  assert.equal(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision, revision);

  const reviewer = createRole(
    task.id,
    "reviewer",
    [createRoleAgentBinding(agent)],
    agent.id,
    repository.path,
    NOW
  );
  store.saveRole(task.id, reviewer);
  assert.throws(() => planner.plan({
    taskId: task.id,
    roleName: reviewer.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  }), /workspace is not ready/i);
  assert.equal((await preparer.prepareActiveTaskWorkspaces())[0].status, "ready");
  const reviewerPath = join(taskRoot, "reviewer");
  assert.equal(store.getRole(task.id, reviewer.name).workspace, reviewerPath);
  assert.equal(store.getRoleWorkspace(task.id, reviewer.name).path, reviewerPath);

  writeFileSync(join(workerPath, "dirty.txt"), "preserve me\n");
  store.saveTask(archiveTask(store.getTask(task.id), NOW));
  assert.deepEqual(await preparer.prepareTaskWorkspace(task.id), {
    taskId: task.id,
    status: "archived-dirty",
    path: taskRoot
  });
  assert.equal(existsSync(leaderPath), false);
  assert.equal(existsSync(reviewerPath), false);
  assert.equal(existsSync(workerPath), true);
  assert.equal(store.getTask(task.id).cwd, taskRoot);
  assert.deepEqual(store.listRoles(task.id).map(({ workspace }) => workspace), [
    repository.path,
    repository.path,
    workerPath
  ]);
  assert.deepEqual(store.listRoleWorkspaces(task.id).map(({ roleName }) => roleName), ["worker"]);

  rmSync(join(workerPath, "dirty.txt"));
  assert.deepEqual(await preparer.prepareTaskWorkspace(task.id), {
    taskId: task.id,
    status: "archived-clean"
  });
  assert.equal(existsSync(taskRoot), false);
  assert.equal(store.getTask(task.id).cwd, undefined);
  assert.deepEqual(store.listRoles(task.id).map(({ workspace }) => workspace), [
    repository.path,
    repository.path,
    repository.path
  ]);
  assert.deepEqual(store.listRoleWorkspaces(task.id), []);
  assert.equal((await preparer.prepareTaskWorkspace(task.id)).status, "archived-clean");
});

test("archived repository Task never creates a worktree", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  await runRepositoryCommand(["add", "Yui", repositoryPath], store);
  const repository = store.listRepositories()[0];
  const task = archiveTask(createTask("task-1", "Archived", NOW, {
    repositoryId: repository.id
  }), NOW);
  store.saveTask(task);

  const result = await new FileTaskWorkspacePreparer(home, store).prepareTaskWorkspace(task.id);
  assert.equal(result.status, "archived-clean");
  assert.equal(existsSync(join(home, "worktrees", task.id)), false);
});

test("one broken Task workspace does not block preparation of other Tasks", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  await runRepositoryCommand(["add", "Yui", repositoryPath], store);
  const repository = store.listRepositories()[0];
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.saveConfiguredAgent(agent);
  for (const id of ["task-1", "task-2"]) {
    const task = activateTask(createTask(id, id, NOW, { repositoryId: repository.id }), NOW);
    store.transaction((tx) => {
      tx.saveTask(task);
      tx.saveRole(id, createRole(
        id,
        "leader",
        [createRoleAgentBinding(agent)],
        agent.id,
        repository.path,
        NOW
      ));
    });
  }
  const git = {
    async inspect() { throw new Error("unused"); },
    async ensureWorktree(input) {
      if (input.taskId === "task-1") throw new Error("detached worktree");
      return {
        path: join(input.container, input.taskId, input.roleName),
        branch: `yui/${input.taskId}/${input.roleName}`,
        baseCommit: "0123456789abcdef0123456789abcdef01234567"
      };
    },
    async removeWorktree() { return "missing"; }
  };

  const results = await new FileTaskWorkspacePreparer(
    home,
    store,
    git,
    () => new Date(NOW)
  ).prepareActiveTaskWorkspaces();

  assert.deepEqual(results.map(({ taskId, status }) => ({ taskId, status })), [
    { taskId: "task-1", status: "failed" },
    { taskId: "task-2", status: "ready" }
  ]);
  assert.match(results[0].error, /detached worktree/);
  assert.equal(store.getTask("task-2").cwd, join(home, "worktrees", "task-2"));
});

test("archive records each successful Role cleanup before a later Role fails", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  await runRepositoryCommand(["add", "Yui", repositoryPath], store);
  const repository = store.listRepositories()[0];
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  const task = activateTask(createTask("task-1", "Archive partial cleanup", NOW, {
    repositoryId: repository.id
  }), NOW);
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    for (const name of ["leader", "worker"]) {
      tx.saveRole(task.id, createRole(
        task.id,
        name,
        [createRoleAgentBinding(agent)],
        agent.id,
        repository.path,
        NOW
      ));
    }
  });
  await new FileTaskWorkspacePreparer(home, store).prepareTaskWorkspace(task.id);
  store.saveTask(archiveTask(store.getTask(task.id), NOW));
  const git = {
    async inspect() { throw new Error("unused"); },
    async ensureWorktree() { throw new Error("unused"); },
    async removeWorktree({ roleName }) {
      if (roleName === "worker") throw new Error("worker cleanup failed");
      return "removed";
    }
  };

  const result = await new FileTaskWorkspacePreparer(home, store, git).prepareTaskWorkspace(task.id);

  assert.equal(result.status, "failed");
  assert.match(result.error, /worker cleanup failed/);
  assert.equal(store.getRoleWorkspace(task.id, "leader"), null);
  assert.equal(store.getRole(task.id, "leader").workspace, repository.path);
  assert.notEqual(store.getRoleWorkspace(task.id, "worker"), null);
});
