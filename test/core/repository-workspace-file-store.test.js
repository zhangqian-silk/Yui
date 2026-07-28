import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createProject } from "../../dist/repository/project.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { TaskWorkspaceCoordinator } from "../../dist/repository/taskWorkspaceCoordinator.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, completeTask, createTask } from "../../dist/task/task.js";
import {
  createWorkItem,
  recordWorkItemWorkspaceDisposition,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";

const NOW = new Date("2026-07-19T12:00:00.000Z");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-project-"));
  const home = join(root, "home");
  t.after(() => {
    const discovery = join(home, "runtime", "controller.json");
    if (existsSync(discovery)) {
      const stopped = spawnSync(
        process.execPath,
        [join(process.cwd(), "dist", "cli.js"), "controller", "stop"],
        {
          encoding: "utf8",
          env: { ...process.env, YUI_HOME: home },
          timeout: 10_000
        }
      );
      assert.equal(
        stopped.status,
        0,
        `Fixture Controller cleanup failed: ${stopped.stderr || stopped.error?.message}`
      );
    }
    rmSync(root, { recursive: true, force: true });
  });
  const workspace = join(root, "workspace");
  const repositoryPath = join(workspace, "Yui");
  execFileSync("git", ["init", "-q", repositoryPath]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.name", "Yui Test"]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(repositoryPath, "tracked.txt"), "initial\n");
  execFileSync("git", ["-C", repositoryPath, "add", "tracked.txt"]);
  execFileSync("git", ["-C", repositoryPath, "commit", "-qm", "initial"]);
  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);
  store.saveConfig({ schemaVersion: 1, defaultWorkspace: workspace });
  return { root, home, workspace, repositoryPath, store };
}

async function addProject(store, repositoryPath) {
  await runProjectCommand([
    "add", "Yui", repositoryPath,
    "--alias", "yui-cli",
    "--remote", "git@example.invalid:yui.git",
    "--stable", "HEAD",
    "--development", "HEAD"
  ], store, { now: () => new Date(NOW) });
  return store.listProjects()[0];
}

function addTaskRoles(store, task, repositoryPath, names = ["leader", "worker"]) {
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    for (const name of names) {
      tx.saveRole(task.id, createRole(
        task.id,
        name,
        [createRoleAgentBinding(agent)],
        agent.id,
        repositoryPath,
        NOW
      ));
    }
  });
  return agent;
}

test("workspace coordination stops a live Role only after a clean preflight", async () => {
  const events = [];
  const item = {
    id: "work-1",
    taskId: "task-1",
    assignee: "worker",
    status: "pending"
  };
  const store = {
    findWorkItem: () => item,
    getTask: () => ({ id: "task-1", status: "active", projectId: "project-1" }),
    getActiveAgentRun: () => null,
    getRole: () => ({ name: "worker" }),
    getRoleWorkspace: () => null,
    getRoleSession: () => ({ status: "ready" })
  };
  const runtime = {
    async stopTaskRoleSessions(taskId, roles) {
      events.push(["stop", taskId, roles]);
    }
  };
  const preparer = {
    async prepareTaskWorkspace() {
      events.push(["main"]);
    },
    async prepareWorkItemWorkspace() {
      events.push(["isolate"]);
      return { path: "/workspace/worktree/task-1/work-1" };
    },
    async inspectWorkItemWorkspace() {
      events.push(["inspect"]);
      return "clean";
    },
    async cleanupWorkItemWorkspace(_id, disposition) {
      events.push(["cleanup", disposition]);
      return "removed";
    }
  };
  const coordinator = new TaskWorkspaceCoordinator(store, preparer, runtime);

  await coordinator.isolateWorkItem(item.id);
  assert.deepEqual(events, [
    ["main"],
    ["stop", "task-1", ["worker"]],
    ["isolate"]
  ]);

  item.status = "completed";
  events.length = 0;
  await coordinator.cleanupWorkItem(item.id, "integrated");
  assert.deepEqual(events, [
    ["inspect"],
    ["stop", "task-1", ["worker"]],
    ["cleanup", "integrated"]
  ]);
});

test("dirty WorkItem preflight retains both runtime and worktree", async () => {
  const item = {
    id: "work-1",
    taskId: "task-1",
    assignee: "worker",
    status: "completed"
  };
  let stopped = false;
  let cleaned = false;
  const coordinator = new TaskWorkspaceCoordinator({
    findWorkItem: () => item,
    getRoleSession: () => ({ status: "ready" })
  }, {
    async inspectWorkItemWorkspace() { return "dirty"; },
    async cleanupWorkItemWorkspace() {
      cleaned = true;
      return "removed";
    }
  }, {
    async stopTaskRoleSessions() { stopped = true; }
  });

  assert.equal(await coordinator.cleanupWorkItem(item.id, "abandoned"), "dirty");
  assert.equal(stopped, false);
  assert.equal(cleaned, false);
});

test("invalid WorkItem isolation leaves a live Role session untouched", async () => {
  const item = {
    id: "work-1",
    taskId: "task-1",
    assignee: "worker",
    status: "completed"
  };
  let preparedMain = false;
  let stopped = false;
  const coordinator = new TaskWorkspaceCoordinator({
    findWorkItem: () => item,
    getTask: () => ({ id: "task-1", status: "active", projectId: "project-1" }),
    getActiveAgentRun: () => null,
    getRole: () => ({ name: "worker" }),
    getRoleWorkspace: () => null,
    getRoleSession: () => ({ status: "ready" })
  }, {
    async prepareTaskWorkspace() {
      preparedMain = true;
    },
    async prepareWorkItemWorkspace() {
      throw new Error(`Work item is already terminal: ${item.id}.`);
    }
  }, {
    async stopTaskRoleSessions() {
      stopped = true;
    }
  });

  await assert.rejects(coordinator.isolateWorkItem(item.id), /already terminal/i);
  assert.equal(preparedMain, false);
  assert.equal(stopped, false);
});

test("invalid WorkItem cleanup leaves a live Role session untouched", async () => {
  const item = {
    id: "work-1",
    taskId: "task-1",
    assignee: "worker",
    status: "pending"
  };
  let inspected = false;
  let stopped = false;
  const coordinator = new TaskWorkspaceCoordinator({
    findWorkItem: () => item,
    getRoleSession: () => ({ status: "ready" })
  }, {
    async inspectWorkItemWorkspace() {
      inspected = true;
      return "clean";
    },
    async cleanupWorkItemWorkspace() {
      throw new Error(`Work item must be terminal before cleanup: ${item.id}.`);
    }
  }, {
    async stopTaskRoleSessions() {
      stopped = true;
    }
  });

  await assert.rejects(coordinator.cleanupWorkItem(item.id, "integrated"), /must be terminal/i);
  assert.equal(inspected, false);
  assert.equal(stopped, false);
});

test("Project Catalog persists aliases, remote, branches, and Yui-owned knowledge", async (t) => {
  const { repositoryPath, store } = fixture(t);
  const discovered = await runProjectCommand(["discover", "yui"], store);
  assert.equal(discovered.data.projects[0].path, realpathSync(repositoryPath));
  assert.equal(
    discovered.data.projects[0].branch,
    execFileSync(
      "git",
      ["-C", repositoryPath, "branch", "--show-current"],
      { encoding: "utf8" }
    ).trim()
  );
  assert.equal(discovered.data.projects[0].registeredProjectId, undefined);
  const output = await addProject(store, repositoryPath);
  assert.match(output.name, /Yui/);
  const project = store.listProjects()[0];
  assert.deepEqual(project, {
    schemaVersion: 2,
    id: "project-1",
    name: "Yui",
    aliases: ["yui-cli"],
    path: realpathSync(repositoryPath),
    remoteUrl: "git@example.invalid:yui.git",
    stableBranch: "HEAD",
    developmentBranch: "HEAD",
    knowledge: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  });
  assert.match((await runProjectCommand(["show", "yui-cli"], store)).output, /Development: HEAD/);
  assert.match((await runProjectCommand([
    "knowledge", "add", "Yui", "Release policy", "--body", "Release from a clean main branch."
  ], store, { now: () => new Date(NOW) })).output, /knowledge-1/);
  assert.match(
    (await runProjectCommand(["knowledge", "show", "project-1", "knowledge-1"], store)).output,
    /Release from a clean main branch/
  );
  const knowledge = await runProjectCommand([
    "knowledge", "show", "Yui", "knowledge-1"
  ], store);
  assert.equal(knowledge.data.knowledge.body, "Release from a clean main branch.");
  assert.equal(knowledge.data.knowledge.status, "active");

  const updatedKnowledge = await runProjectCommand([
    "knowledge", "update", "Yui", "knowledge-1",
    "--title", "Current release policy",
    "--body", "Release from the stable checkout."
  ], store, { now: () => new Date(NOW) });
  assert.equal(updatedKnowledge.data.knowledge.title, "Current release policy");
  assert.equal(updatedKnowledge.data.knowledge.body, "Release from the stable checkout.");
  const retired = await runProjectCommand([
    "knowledge", "retire", "Yui", "knowledge-1"
  ], store, { now: () => new Date(NOW) });
  assert.equal(retired.data.knowledge.status, "retired");
  assert.match(
    (await runProjectCommand(["knowledge", "list", "Yui"], store)).output,
    /No project knowledge/
  );
  assert.match(
    (await runProjectCommand(["knowledge", "list", "Yui", "--all"], store)).output,
    /knowledge-1.*retired/
  );

  const updatedProject = await runProjectCommand([
    "update", "Yui",
    "--alias", "yui-next",
    "--clear-remote",
    "--stable", "HEAD",
    "--development", "HEAD"
  ], store, { now: () => new Date(NOW) });
  assert.deepEqual(updatedProject.data.project.aliases, ["yui-next"]);
  assert.equal(updatedProject.data.project.remoteUrl, undefined);
  assert.equal((await runProjectCommand(["show", "yui-next"], store)).data.project.id, project.id);
});

test("Project Catalog enforces one reference namespace at the storage boundary", async (t) => {
  const { root, repositoryPath, store } = fixture(t);
  const first = createProject(
    "project-1",
    "First",
    repositoryPath,
    { stable: "HEAD", development: "HEAD" },
    NOW,
    { aliases: ["project-2"] }
  );
  store.saveProject(first);
  const secondPath = join(root, "second");
  execFileSync("git", ["clone", "-q", repositoryPath, secondPath]);
  const second = createProject(
    "project-2",
    "Second",
    secondPath,
    { stable: "HEAD", development: "HEAD" },
    NOW
  );

  assert.equal(store.createProjectIfAbsent(second), null);
  assert.throws(() => store.saveProject(second), /Project reference.*project-2/i);
  assert.deepEqual(store.listProjects().map(({ id }) => id), ["project-1"]);
});

test("Project Catalog validation precedes local branch creation", async (t) => {
  const { root, repositoryPath, store } = fixture(t);
  const canonicalPath = realpathSync(repositoryPath);
  let branchCreations = 0;
  const git = {
    async inspect(_path, baseRef = "HEAD") {
      return {
        root: canonicalPath,
        gitDirectory: join(canonicalPath, ".git"),
        baseRef,
        baseCommit: "a".repeat(40)
      };
    },
    async isClean() {
      return true;
    },
    async ensureLocalBranch() {
      branchCreations += 1;
    }
  };

  await assert.rejects(
    runProjectCommand([
      "add", "../invalid", repositoryPath,
      "--stable", "main",
      "--development", "develop"
    ], store, { git }),
    /Project name is invalid/i
  );
  assert.equal(branchCreations, 0);

  store.saveProject(createProject(
    "project-1",
    "First",
    canonicalPath,
    { stable: "main", development: "main" },
    NOW
  ));
  store.saveProject(createProject(
    "project-2",
    "Second",
    join(root, "second"),
    { stable: "main", development: "main" },
    NOW
  ));

  await assert.rejects(
    runProjectCommand([
      "update", "First",
      "--alias", "Second",
      "--development", "develop"
    ], store, { git }),
    /Project reference is already registered/i
  );
  assert.equal(branchCreations, 0);
});

test("Operator can clone and bind a remote Project into the configured workspace", async (t) => {
  const { root, workspace, store } = fixture(t);
  const remote = join(root, "remote");
  execFileSync("git", ["init", "-q", remote]);
  execFileSync("git", ["-C", remote, "config", "user.name", "Yui Test"]);
  execFileSync("git", ["-C", remote, "config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(remote, "README.md"), "remote\n");
  execFileSync("git", ["-C", remote, "add", "README.md"]);
  execFileSync("git", ["-C", remote, "commit", "-qm", "initial"]);

  const result = await runProjectCommand([
    "clone", "RemoteProject", remote, "--stable", "HEAD", "--development", "HEAD"
  ], store, { now: () => new Date(NOW) });
  assert.match(result.output, /Added project project-1/);
  assert.equal(result.data.project.id, "project-1");
  assert.equal(store.listProjects()[0].path, realpathSync(join(workspace, "RemoteProject")));
  assert.equal(store.listProjects()[0].remoteUrl, remote);
});

test("Project clone stays inside workspace and removes an unbound checkout", async (t) => {
  const { root, workspace, store } = fixture(t);
  let cloneCalls = 0;
  const git = {
    async clone() {
      cloneCalls += 1;
      throw new Error("clone must not run");
    },
    async inspect() {
      throw new Error("inspect must not run");
    }
  };
  await assert.rejects(
    runProjectCommand(["clone", "../outside", "git@example.invalid:yui.git"], store, { git }),
    /Project name is invalid/
  );
  assert.equal(cloneCalls, 0);
  assert.equal(existsSync(join(root, "outside")), false);

  await assert.rejects(
    runProjectCommand(["clone", "worktree", "git@example.invalid:yui.git"], store, { git }),
    /managed worktree|reserved/i
  );
  assert.equal(cloneCalls, 0);

  let inspectCalls = 0;
  await assert.rejects(
    runProjectCommand([
      "add", "Nested", join(workspace, "worktree", "Nested")
    ], store, {
      git: {
        async inspect() {
          inspectCalls += 1;
          throw new Error("inspect must not run");
        }
      }
    }),
    /managed worktree|reserved/i
  );
  assert.equal(inspectCalls, 0);

  const remote = join(root, "remote-invalid-development");
  execFileSync("git", ["init", "-q", "-b", "main", remote]);
  execFileSync("git", ["-C", remote, "config", "user.name", "Yui Test"]);
  execFileSync("git", ["-C", remote, "config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(remote, "README.md"), "remote\n");
  execFileSync("git", ["-C", remote, "add", "README.md"]);
  execFileSync("git", ["-C", remote, "commit", "-qm", "initial"]);

  await assert.rejects(
    runProjectCommand([
      "clone", "Unbound", remote, "--stable", "main", "--development", "missing"
    ], store),
    /single revision|unknown revision|not a valid object name/i
  );
  assert.equal(existsSync(join(workspace, "Unbound")), false);
  assert.equal(store.listProjects().length, 0);
});

test("Project add rejects dirty checkouts and paths that contain managed worktrees", async (t) => {
  const { workspace, repositoryPath, store } = fixture(t);
  writeFileSync(join(repositoryPath, "uncommitted.txt"), "not committed\n");
  await assert.rejects(
    runProjectCommand([
      "add", "Dirty", repositoryPath, "--stable", "HEAD", "--development", "HEAD"
    ], store),
    /clean|dirty|uncommitted/i
  );
  assert.equal(store.listProjects().length, 0);

  await assert.rejects(
    runProjectCommand(["add", "WorkspaceRoot", workspace], store, {
      git: {
        async inspect(_path, baseRef = "HEAD") {
          return {
            root: workspace,
            gitDirectory: join(workspace, ".git"),
            baseRef,
            baseCommit: "a".repeat(40)
          };
        }
      }
    }),
    /managed worktree|reserved/i
  );
  assert.equal(store.listProjects().length, 0);

  unlinkSync(join(repositoryPath, "uncommitted.txt"));
  await runProjectCommand([
    "add", "Clean", repositoryPath, "--stable", "HEAD", "--development", "HEAD"
  ], store);
  writeFileSync(join(repositoryPath, "uncommitted.txt"), "not committed\n");
  await runProjectCommand(["update", "Clean", "--alias", "new-alias"], store);
  assert.deepEqual(store.listProjects()[0].aliases, ["new-alias"]);
  await assert.rejects(
    runProjectCommand(["update", "Clean", "--stable", "HEAD"], store),
    /clean|dirty|uncommitted/i
  );
});

test("Project add resolves a development branch that only exists on origin", async (t) => {
  const { root, workspace, store } = fixture(t);
  const remote = join(root, "remote-add-branches");
  execFileSync("git", ["init", "-q", "-b", "main", remote]);
  execFileSync("git", ["-C", remote, "config", "user.name", "Yui Test"]);
  execFileSync("git", ["-C", remote, "config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(remote, "tracked.txt"), "main\n");
  execFileSync("git", ["-C", remote, "add", "tracked.txt"]);
  execFileSync("git", ["-C", remote, "commit", "-qm", "main"]);
  execFileSync("git", ["-C", remote, "checkout", "-qb", "develop"]);
  writeFileSync(join(remote, "tracked.txt"), "develop\n");
  execFileSync("git", ["-C", remote, "commit", "-qam", "develop"]);
  execFileSync("git", ["-C", remote, "checkout", "-q", "main"]);
  const checkout = join(workspace, "Existing");
  execFileSync("git", ["clone", "-q", "--branch", "main", "--single-branch", remote, checkout]);
  execFileSync("git", ["-C", checkout, "fetch", "-q", "origin", "develop:refs/remotes/origin/develop"]);

  await runProjectCommand([
    "add", "Existing", checkout, "--stable", "main", "--development", "develop"
  ], store);
  assert.doesNotThrow(() => execFileSync(
    "git",
    ["-C", checkout, "rev-parse", "--verify", "develop^{commit}"],
    { stdio: "ignore" }
  ));
});

test("Project clone rejects add-only remote metadata", async (t) => {
  const { store } = fixture(t);
  await assert.rejects(
    runProjectCommand([
      "clone", "RemoteProject", "git@example.invalid:yui.git",
      "--remote", "git@example.invalid:other.git"
    ], store),
    /unknown option.*--remote/i
  );
});

test("Project ids, names, and aliases share one reference namespace", async (t) => {
  const { root, store } = fixture(t);
  const first = join(root, "first");
  const second = join(root, "second");
  for (const path of [first, second]) {
    execFileSync("git", ["init", "-q", path]);
    execFileSync("git", ["-C", path, "config", "user.name", "Yui Test"]);
    execFileSync("git", ["-C", path, "config", "user.email", "yui@example.invalid"]);
    writeFileSync(join(path, "tracked.txt"), `${path}\n`);
    execFileSync("git", ["-C", path, "add", "tracked.txt"]);
    execFileSync("git", ["-C", path, "commit", "-qm", "initial"]);
  }

  await runProjectCommand([
    "add", "Alpha", first, "--alias", "project-2"
  ], store, { now: () => new Date(NOW) });
  await assert.rejects(
    runProjectCommand(["add", "Beta", second], store, { now: () => new Date(NOW) }),
    /already registered|reference/i
  );
  assert.equal(store.listProjects().length, 1);
});

test("Project clone keeps the stable checkout on stable while resolving development", async (t) => {
  const { root, workspace, store } = fixture(t);
  const remote = join(root, "remote-branches");
  execFileSync("git", ["init", "-q", "-b", "main", remote]);
  execFileSync("git", ["-C", remote, "config", "user.name", "Yui Test"]);
  execFileSync("git", ["-C", remote, "config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(remote, "tracked.txt"), "main\n");
  execFileSync("git", ["-C", remote, "add", "tracked.txt"]);
  execFileSync("git", ["-C", remote, "commit", "-qm", "main"]);
  execFileSync("git", ["-C", remote, "checkout", "-qb", "develop"]);
  writeFileSync(join(remote, "tracked.txt"), "develop\n");
  execFileSync("git", ["-C", remote, "commit", "-qam", "develop"]);

  await runProjectCommand([
    "clone", "Branched", remote, "--stable", "main", "--development", "develop"
  ], store);
  const checkout = join(workspace, "Branched");
  assert.equal(
    execFileSync("git", ["-C", checkout, "branch", "--show-current"], { encoding: "utf8" }).trim(),
    "main"
  );
  assert.doesNotThrow(() => execFileSync(
    "git",
    ["-C", checkout, "rev-parse", "--verify", "develop^{commit}"],
    { stdio: "ignore" }
  ));
  assert.equal(store.listProjects()[0].stableBranch, "main");
  assert.equal(store.listProjects()[0].developmentBranch, "develop");
});

test("Project knowledge appends inside one storage transaction", async (t) => {
  const { repositoryPath, store } = fixture(t);
  await addProject(store, repositoryPath);
  let transactionDepth = 0;
  let transactionCalls = 0;
  const guarded = {
    nextProjectId: () => store.nextProjectId(),
    createProjectIfAbsent: (project) => store.createProjectIfAbsent(project),
    saveProject(project) {
      assert.ok(transactionDepth > 0, "Project knowledge must not overwrite a stale snapshot");
      store.saveProject(project);
    },
    listProjects: () => store.listProjects(),
    getConfig: () => store.getConfig(),
    transaction(execute) {
      transactionCalls += 1;
      return store.transaction(() => {
        transactionDepth += 1;
        try {
          return execute(guarded);
        } finally {
          transactionDepth -= 1;
        }
      });
    }
  };

  await runProjectCommand([
    "knowledge", "add", "Yui", "Atomic", "--body", "Append under the store lock."
  ], guarded, { now: () => new Date(NOW) });
  assert.equal(transactionCalls, 1);
  assert.deepEqual(store.getProject("project-1").knowledge.map(({ title }) => title), [
    "Atomic"
  ]);
});

test("a Project-backed Task owns one main worktree shared by Roles", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Project Task", NOW, {
    projectId: project.id,
    baseRef: project.developmentBranch
  }), NOW);
  const agent = addTaskRoles(store, task, repositoryPath, ["leader", "worker", "reviewer"]);
  const planner = new FileRoleLaunchPlanner(home, store, { cliPath: "/dist/cli.js" });
  assert.throws(() => planner.plan({
    taskId: task.id,
    roleName: "leader",
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  }), /workspace is not ready/i);

  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const main = join(workspace, "worktree", "Yui", task.id, "main");
  assert.deepEqual(await preparer.prepareTaskWorkspace(task.id), {
    taskId: task.id,
    status: "ready",
    path: main
  });
  assert.equal(store.getTask(task.id).cwd, main);
  assert.deepEqual(store.listRoles(task.id).map(({ workspace: path }) => path), [main, main, main]);
  assert.deepEqual(store.listRoleWorkspaces(task.id).map((entry) => ({
    owner: entry.owner,
    roleName: entry.roleName,
    path: entry.path
  })), [{
    owner: { type: "task" },
    roleName: "leader",
    path: main
  }]);
  assert.equal(existsSync(join(main, ".git")), true);
  assert.doesNotThrow(() => planner.plan({
    taskId: task.id,
    roleName: "reviewer",
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  }));
});

test("a new Task reuses its managed branch after interrupted preparation", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const baseCommit = execFileSync(
    "git", ["-C", repositoryPath, "rev-parse", "HEAD"], { encoding: "utf8" }
  ).trim();
  execFileSync("git", [
    "-C", repositoryPath, "commit", "--allow-empty", "-qm", "unowned managed branch"
  ]);
  const collisionCommit = execFileSync(
    "git", ["-C", repositoryPath, "rev-parse", "HEAD"], { encoding: "utf8" }
  ).trim();
  execFileSync("git", [
    "-C", repositoryPath, "branch", "yui/task-1/main", collisionCommit
  ]);
  execFileSync("git", ["-C", repositoryPath, "reset", "--hard", "-q", baseCommit]);

  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Reject branch collision", NOW, {
    projectId: project.id,
    baseRef: project.developmentBranch
  }), NOW);
  addTaskRoles(store, task, repositoryPath, ["leader"]);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));

  const prepared = await preparer.prepareTaskWorkspace(task.id);
  assert.equal(
    execFileSync("git", ["-C", prepared.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    collisionCommit
  );
  assert.equal(store.getRoleWorkspace(task.id, "leader").path, prepared.path);
  assert.equal(store.getTask(task.id).cwd, prepared.path);
});

test("a persisted Task workspace can restore its retained branch after the directory is lost", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Restore retained branch", NOW, {
    projectId: project.id,
    baseRef: project.developmentBranch
  }), NOW);
  addTaskRoles(store, task, repositoryPath, ["leader"]);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const first = await preparer.prepareTaskWorkspace(task.id);
  writeFileSync(join(first.path, "progress.txt"), "retained progress\n");
  execFileSync("git", ["-C", first.path, "add", "progress.txt"]);
  execFileSync("git", ["-C", first.path, "commit", "-qm", "retained progress"]);
  const retainedCommit = execFileSync(
    "git", ["-C", first.path, "rev-parse", "HEAD"], { encoding: "utf8" }
  ).trim();
  execFileSync("git", ["-C", repositoryPath, "worktree", "remove", first.path]);

  const restored = await preparer.prepareTaskWorkspace(task.id);
  assert.equal(restored.path, first.path);
  assert.equal(
    execFileSync("git", ["-C", restored.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    retainedCommit
  );
});

test("Leader can directly create and clean a WorkItem-owned isolated worktree", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Parallel Task", NOW, {
    projectId: project.id
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-1", task.id, {
    title: "Parallel edit",
    assignee: "worker"
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const main = (await preparer.prepareTaskWorkspace(task.id)).path;
  const isolated = await preparer.prepareWorkItemWorkspace(item.id);
  assert.deepEqual(isolated.owner, { type: "work-item", workItemId: item.id });
  assert.equal(isolated.path, join(workspace, "worktree", "Yui", task.id, item.id));
  assert.equal(store.getRole(task.id, "worker").workspace, isolated.path);
  assert.equal(store.getTask(task.id).cwd, main);

  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  store.saveWorkItem(
    task.id,
    updateWorkItemStatus(running, "completed", NOW, "Integrated into main.")
  );
  const planner = new FileRoleLaunchPlanner(home, store, { cliPath: "/dist/cli.js" });
  assert.throws(() => planner.plan({
    taskId: task.id,
    roleName: "worker",
    agentId: store.getRole(task.id, "worker").activeAgentId,
    adapterId: "codex",
    mode: "new"
  }), /workspace is not ready/i);
  const next = createWorkItem("work-2", task.id, {
    title: "Next edit",
    assignee: "worker"
  }, NOW);
  store.saveWorkItem(task.id, next);
  assert.throws(
    () => runTaskCommand(["work", "dispatch", next.id], store, { now: () => new Date(NOW) }),
    /work-1.*cleanup|cleanup.*work-1/i
  );

  const dirtyFile = join(isolated.path, "dirty.txt");
  writeFileSync(dirtyFile, "preserve\n");
  assert.equal(await preparer.cleanupWorkItemWorkspace(item.id, "integrated"), "dirty");
  assert.equal(existsSync(isolated.path), true);
  assert.deepEqual(store.getRoleWorkspace(task.id, "worker").owner, {
    type: "work-item",
    workItemId: item.id
  });
  unlinkSync(dirtyFile);
  assert.equal(await preparer.cleanupWorkItemWorkspace(item.id, "integrated"), "removed");
  assert.equal(existsSync(isolated.path), false);
  assert.equal(store.getRoleWorkspace(task.id, "worker"), null);
  assert.equal(store.getRole(task.id, "worker").workspace, main);
  assert.equal(store.getWorkItem(task.id, item.id).workspaceDisposition, "integrated");
  assert.throws(() => execFileSync(
    "git",
    ["-C", repositoryPath, "show-ref", "--verify", "refs/heads/yui/task-1/work-1"],
    { stdio: "ignore" }
  ));
});

test("WorkItem cleanup validates its disposition before removing the worktree", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Disposition safety", NOW, {
    projectId: project.id
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-1", task.id, {
    title: "Parallel edit",
    assignee: "worker"
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const isolated = await preparer.prepareWorkItemWorkspace(item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const completed = updateWorkItemStatus(running, "completed", NOW, "Integrated.");
  store.saveWorkItem(task.id, completed);
  store.saveWorkItem(
    task.id,
    recordWorkItemWorkspaceDisposition(completed, "integrated", NOW)
  );

  await assert.rejects(
    preparer.cleanupWorkItemWorkspace(item.id, "abandoned"),
    /already recorded as integrated/i
  );
  assert.equal(existsSync(isolated.path), true);
  assert.notEqual(store.getRoleWorkspace(task.id, "worker"), null);
});

test("WorkItem cleanup cannot record a disposition without an isolated worktree", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "No isolation", NOW, {
    projectId: project.id
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = updateWorkItemStatus(createWorkItem("work-1", task.id, {
    title: "Shared work",
    assignee: "worker"
  }, NOW), "completed", NOW, "Done in main.");
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);

  await assert.rejects(
    preparer.cleanupWorkItemWorkspace(item.id, "integrated"),
    /no managed isolated worktree/i
  );
  assert.equal(store.getWorkItem(task.id, item.id).workspaceDisposition, undefined);

  store.saveWorkItem(task.id, recordWorkItemWorkspaceDisposition(item, "integrated", NOW));
  assert.equal(await preparer.cleanupWorkItemWorkspace(item.id, "integrated"), "missing");
});

test("dirty worktrees keep a completed Task out of Archived while its record remains", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const active = activateTask(createTask("task-1", "Archive safely", NOW, {
    projectId: project.id
  }), NOW);
  addTaskRoles(store, active, repositoryPath);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const main = (await preparer.prepareTaskWorkspace(active.id)).path;
  store.saveTask(completeTask(store.getTask(active.id), NOW, {
    summary: "Done",
    by: "user"
  }));
  const dirtyFile = join(main, "dirty.txt");
  writeFileSync(dirtyFile, "preserve\n");
  assert.equal((await preparer.cleanupTaskForArchive(active.id)).status, "retained-dirty");
  assert.equal(store.getTask(active.id).status, "completed");
  assert.equal(existsSync(main), true);
  unlinkSync(dirtyFile);
  assert.equal((await preparer.cleanupTaskForArchive(active.id)).status, "removed");
  const result = runTaskCommand(
    ["archive", active.id, "--integrated"],
    store,
    { now: () => new Date(NOW) }
  );
  assert.equal(result.kind, "output");
  assert.equal(store.getTask(active.id).status, "archived");
  assert.equal(store.getTask(active.id).cwd, undefined);
  assert.equal(existsSync(main), false);
  assert.equal(store.listEvents(active.id).at(-1).payload.workspaceDisposition, "integrated");
});

test("Task archive requires explicit WorkItem cleanup and preserves its record", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const active = activateTask(createTask("task-1", "Archive isolated work", NOW, {
    projectId: project.id
  }), NOW);
  addTaskRoles(store, active, repositoryPath);
  const item = createWorkItem("work-1", active.id, {
    title: "Isolated edit",
    assignee: "worker"
  }, NOW);
  store.saveWorkItem(active.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const main = (await preparer.prepareTaskWorkspace(active.id)).path;
  const isolated = await preparer.prepareWorkItemWorkspace(item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(active.id, running);
  store.saveWorkItem(active.id, updateWorkItemStatus(
    running,
    "completed",
    NOW,
    "Integrated into main."
  ));
  store.saveTask(completeTask(store.getTask(active.id), NOW, {
    summary: "Done",
    by: "user"
  }));

  const blocked = await preparer.cleanupTaskForArchive(active.id);
  assert.equal(blocked.status, "failed");
  assert.match(blocked.error, /explicit cleanup.*work-1/i);
  assert.equal(existsSync(main), true);
  assert.equal(existsSync(isolated.path), true);
  assert.equal(store.getTask(active.id).cwd, main);

  assert.equal(await preparer.cleanupWorkItemWorkspace(item.id, "integrated"), "removed");
  assert.equal((await preparer.cleanupTaskForArchive(active.id)).status, "removed");
  runTaskCommand(["archive", active.id, "--integrated"], store, { now: () => new Date(NOW) });
  assert.equal(store.getTask(active.id).status, "archived");
  assert.equal(store.getWorkItem(active.id, item.id).workspaceDisposition, "integrated");
});

test("Project Task creation persists before reporting a missing Git base", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  await addProject(store, repositoryPath);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.saveConfiguredAgent(agent);
  store.saveConfig({
    schemaVersion: 1,
    defaultWorkspace: workspace,
    defaultAgent: agent.id
  });
  const cli = join(process.cwd(), "dist", "cli.js");
  const result = spawnSync(
    process.execPath,
    [
      cli, "--json", "task", "create", "Invalid base",
      "--project", "Yui", "--base", "missing-ref"
    ],
    {
      encoding: "utf8",
      env: { ...process.env, YUI_HOME: home }
    }
  );

  const response = JSON.parse(result.stdout);
  assert.equal(result.status, 0);
  assert.equal(response.ok, true);
  assert.equal(response.data.workspace.status, "failed");
  assert.match(response.data.workspace.error, /missing-ref|single revision|unknown revision/i);
  assert.equal(new FileTaskStore(home).listTasks().length, 1);
});

test("Project Task create returns the current Task, Leader, and workspace state", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  await addProject(store, repositoryPath);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.saveConfiguredAgent(agent);
  store.saveConfig({
    schemaVersion: 1,
    defaultWorkspace: workspace,
    defaultAgent: agent.id
  });

  const result = JSON.parse(execFileSync(
    process.execPath,
    [
      join(process.cwd(), "dist", "cli.js"),
      "--json",
      "task", "create", "Current response", "--project", "Yui"
    ],
    {
      encoding: "utf8",
      env: { ...process.env, YUI_HOME: home }
    }
  ));

  assert.equal(result.ok, true);
  assert.equal(result.data.workspace.status, "ready");
  assert.equal(result.data.task.cwd, result.data.workspace.path);
  assert.equal(result.data.leader.workspace, result.data.workspace.path);
  assert.deepEqual(result.data.task, new FileTaskStore(home).getTask(result.data.task.id));
  assert.deepEqual(
    result.data.leader,
    new FileTaskStore(home).getRole(result.data.task.id, "leader")
  );
});
