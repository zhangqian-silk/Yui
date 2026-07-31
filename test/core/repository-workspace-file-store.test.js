import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  recordRoleAgentSession,
  updateRoleAgentSessionStatus
} from "../../dist/executor/agentExecutor.js";
import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { runTaskIntegrationCommand } from "../../dist/commands/taskIntegrationCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { createRole, createRoleAgentBinding, updateRole } from "../../dist/role/role.js";
import { createAgentRun, yieldAgentRun } from "../../dist/run/agentRun.js";
import { createProject } from "../../dist/repository/project.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { TaskWorkspaceCoordinator } from "../../dist/repository/taskWorkspaceCoordinator.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, completeTask, createTask } from "../../dist/task/task.js";
import {
  createWorkItem,
  recordWorkItemWorkspaceDisposition,
  updateWorkItemWriteProjects,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { createRoleWorkspace } from "../../dist/worktree/roleWorkspace.js";
import { WorkItemChangeSetManager } from "../../dist/workspace/workItemChangeSetManager.js";

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

function liveSessionSet(status = "ready") {
  return {
    sessions: { codex: { status } },
    inFlight: null,
    pendingTurnCompletion: null
  };
}

test("workspace coordination stops a live Role only after a clean preflight", async () => {
  const events = [];
  const item = {
    id: "work-1",
    taskId: "task-1",
    assignee: "worker",
    writeProjectIds: ["project-1"],
    status: "pending"
  };
  const store = {
    findWorkItem: () => item,
    getTask: () => ({
      id: "task-1",
      status: "active",
      projectBindings: [{ projectId: "project-1" }]
    }),
    getActiveAgentRun: () => null,
    getRole: () => ({ name: "worker" }),
    getRoleWorkspace: () => null,
    getTaskRoleSessionSet: () => liveSessionSet()
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

test("workspace cleanup stops a restored Role before converging a missing worktree", async () => {
  const events = [];
  const item = {
    id: "work-1",
    taskId: "task-1",
    assignee: "worker",
    writeProjectIds: ["project-1"],
    status: "completed"
  };
  const coordinator = new TaskWorkspaceCoordinator({
    findWorkItem: () => item,
    getTaskRoleSessionSet: () => liveSessionSet()
  }, {
    async inspectWorkItemWorkspace() {
      events.push(["inspect"]);
      return "missing";
    },
    async cleanupWorkItemWorkspace(_id, disposition) {
      events.push(["cleanup", disposition]);
      return "missing";
    }
  }, {
    async stopTaskRoleSessions(taskId, roles) {
      events.push(["stop", taskId, roles]);
    }
  });

  assert.equal(await coordinator.cleanupWorkItem(item.id, "integrated"), "missing");
  assert.deepEqual(events, [
    ["inspect"],
    ["stop", "task-1", ["worker"]],
    ["cleanup", "integrated"]
  ]);
});

test("WorkItem isolation refreshes read context after the Task gains a Project", async () => {
  const item = {
    id: "work-1",
    taskId: "task-1",
    assignee: "worker",
    writeProjectIds: ["project-1"],
    status: "pending"
  };
  const task = {
    id: "task-1",
    status: "active",
    projectBindings: [{ projectId: "project-1" }, { projectId: "project-2" }]
  };
  const stale = {
    owner: { type: "work-item", workItemId: item.id },
    entries: [{ projectId: "project-1", access: "write" }]
  };
  const refreshed = {
    ...stale,
    entries: [
      { projectId: "project-1", access: "write" },
      { projectId: "project-2", access: "read" }
    ]
  };
  let refreshes = 0;
  const coordinator = new TaskWorkspaceCoordinator({
    findWorkItem: () => item,
    getTask: () => task,
    getRole: () => ({ name: "worker" }),
    getRoleWorkspace: () => stale,
    getActiveAgentRun: () => null,
    getTaskRoleSessionSet: () => null
  }, {
    async prepareTaskWorkspace() {},
    async prepareWorkItemWorkspace() {
      refreshes += 1;
      return refreshed;
    }
  }, {
    async stopTaskRoleSessions() {}
  });

  assert.equal(await coordinator.isolateWorkItem(item.id), refreshed);
  assert.equal(refreshes, 1);
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
    getTaskRoleSessionSet: () => liveSessionSet()
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
    getTask: () => ({
      id: "task-1",
      status: "active",
      projectBindings: [{ projectId: "project-1" }]
    }),
    getActiveAgentRun: () => null,
    getRole: () => ({ name: "worker" }),
    getRoleWorkspace: () => null,
    getTaskRoleSessionSet: () => liveSessionSet()
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
    getTaskRoleSessionSet: () => liveSessionSet()
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
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
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
  const main = join(workspace, "tasks", task.id, "main");
  const mainProject = join(workspace, "worktree", "Yui", task.id, "main");
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
    root: entry.root
  })), [{
    owner: { type: "task" },
    roleName: "leader",
    root: main
  }]);
  assert.equal(existsSync(join(mainProject, ".git")), true);
  assert.doesNotThrow(() => planner.plan({
    taskId: task.id,
    roleName: "reviewer",
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new"
  }));
});

test("a multi-Project Task and WorkItem expose one root with per-Project access", async (t) => {
  const { root, home, workspace, repositoryPath, store } = fixture(t);
  await runProjectCommand([
    "add", "Backend", repositoryPath,
    "--remote", "git@example.invalid:backend.git",
    "--stable", "HEAD",
    "--development", "HEAD"
  ], store, { now: () => new Date(NOW) });
  const frontendPath = join(root, "frontend");
  execFileSync("git", ["init", "-q", frontendPath]);
  execFileSync("git", ["-C", frontendPath, "config", "user.name", "Yui Test"]);
  execFileSync("git", ["-C", frontendPath, "config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(frontendPath, "tracked.txt"), "frontend\n");
  execFileSync("git", ["-C", frontendPath, "add", "tracked.txt"]);
  execFileSync("git", ["-C", frontendPath, "commit", "-qm", "initial"]);
  await runProjectCommand([
    "add", "Frontend", frontendPath,
    "--remote", "git@example.invalid:frontend.git",
    "--stable", "HEAD",
    "--development", "HEAD"
  ], store, { now: () => new Date(NOW) });
  const backend = store.listProjects().find(({ name }) => name === "Backend");
  const frontend = store.listProjects().find(({ name }) => name === "Frontend");
  assert.notEqual(backend, undefined);
  assert.notEqual(frontend, undefined);
  const task = activateTask(createTask("task-1", "Cross-repository change", NOW, {
    projectBindings: [
      { projectId: backend.id, directory: "backend", baseRef: backend.developmentBranch }
    ]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-1", task.id, {
    title: "Update backend using frontend context",
    assignee: "worker",
    writeProjectIds: [backend.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));

  await preparer.prepareTaskWorkspace(task.id);
  runTaskCommand([
    "project", "add", task.id, frontend.id, "--directory", "frontend"
  ], store, {
    now: () => new Date(NOW),
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  });
  const mainResult = await preparer.prepareTaskWorkspace(task.id);
  assert.equal(mainResult.path, join(workspace, "tasks", task.id, "main"));
  const main = store.getRoleWorkspace(task.id, "leader");
  assert.equal(main.root, mainResult.path);
  assert.deepEqual(main.entries.map(({ directory, access }) => ({ directory, access })), [
    { directory: "backend", access: "write" },
    { directory: "frontend", access: "write" }
  ]);

  const work = await preparer.prepareWorkItemWorkspace(item.id);
  assert.equal(work.root, join(workspace, "tasks", task.id, "work-items", item.id));
  assert.deepEqual(work.entries.map(({ directory, access }) => ({ directory, access })), [
    { directory: "backend", access: "write" },
    { directory: "frontend", access: "read" }
  ]);
  assert.notEqual(
    realpathSync(join(work.root, "backend")),
    realpathSync(join(main.root, "backend"))
  );
  assert.equal(
    realpathSync(join(work.root, "frontend")),
    realpathSync(join(main.root, "frontend"))
  );
  const isolatedPlan = new FileRoleLaunchPlanner(home, store, {
    cliPath: "/dist/cli.js",
    bubblewrapCommand: "/usr/bin/test-bwrap"
  }).plan({
    taskId: task.id,
    roleName: "worker",
    agentId: store.getRole(task.id, "worker").activeAgentId,
    adapterId: "codex",
    mode: "new"
  });
  assert.equal(isolatedPlan.launch.command, "/usr/bin/test-bwrap");
  const readOnlyBind = isolatedPlan.launch.args.indexOf("--ro-bind");
  assert.notEqual(readOnlyBind, -1);
  assert.deepEqual(
    isolatedPlan.launch.args.slice(readOnlyBind, readOnlyBind + 3),
    ["--ro-bind", main.entries[1].path, main.entries[1].path]
  );
  const frontendGitDirectory = execFileSync(
    "git",
    [
      "-C",
      main.entries[1].path,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir"
    ],
    { encoding: "utf8" }
  ).trim();
  assert.equal(
    isolatedPlan.launch.args.some((argument, index, args) => (
      argument === "--ro-bind"
      && args[index + 1] === frontendGitDirectory
      && args[index + 2] === frontendGitDirectory
    )),
    true
  );
  assert.match(isolatedPlan.launch.args.join(" "), /--chdir .*work-items.*work-1/);
  assert.throws(
    () => new FileRoleLaunchPlanner(home, store, {
      cliPath: "/dist/cli.js",
      environment: { PATH: join(root, "missing-bin") }
    }).plan({
      taskId: task.id,
      roleName: "worker",
      agentId: store.getRole(task.id, "worker").activeAgentId,
      adapterId: "codex",
      mode: "new"
    }),
    /bubblewrap is required.*read-only Project context/i
  );

  writeFileSync(join(work.root, "backend", "contract.txt"), "v2\n");
  execFileSync("git", ["-C", join(work.root, "backend"), "add", "contract.txt"]);
  execFileSync("git", [
    "-C", join(work.root, "backend"), "commit", "-qm", "update backend contract"
  ]);
  const backendBaseCommit = work.entries.find(
    ({ projectId }) => projectId === backend.id
  ).baseCommit;
  const expandedItem = updateWorkItemWriteProjects(
    item,
    [backend.id, frontend.id],
    new Date(NOW.getTime() + 1)
  );
  store.saveWorkItem(task.id, expandedItem);
  const expanded = await preparer.prepareWorkItemWorkspace(item.id);
  assert.deepEqual(
    expanded.entries.map(({ directory, access }) => ({ directory, access })),
    [
      { directory: "backend", access: "write" },
      { directory: "frontend", access: "write" }
    ]
  );
  assert.equal(
    expanded.entries.find(({ projectId }) => projectId === backend.id).baseCommit,
    backendBaseCommit
  );
  writeFileSync(join(expanded.root, "frontend", "client.txt"), "v2\n");
  execFileSync("git", ["-C", join(expanded.root, "frontend"), "add", "client.txt"]);
  execFileSync("git", [
    "-C", join(expanded.root, "frontend"), "commit", "-qm", "update frontend client"
  ]);

  const running = updateWorkItemStatus(
    expandedItem,
    "running",
    new Date(NOW.getTime() + 2)
  );
  store.saveWorkItem(task.id, running);
  store.saveWorkItem(
    task.id,
    updateWorkItemStatus(
      running,
      "awaiting_acceptance",
      new Date(NOW.getTime() + 3)
    )
  );
  const manager = new WorkItemChangeSetManager(
    store,
    () => new Date(NOW.getTime() + 4)
  );
  const changeSets = await manager.capture(item.id);
  assert.deepEqual(changeSets.map(({ projectId }) => projectId), [
    backend.id,
    frontend.id
  ]);
  const backendChangeSet = changeSets.find(({ projectId }) => projectId === backend.id);
  const frontendChangeSet = changeSets.find(({ projectId }) => projectId === frontend.id);
  assert.notEqual(backendChangeSet, undefined);
  assert.notEqual(frontendChangeSet, undefined);
  const backendIntegration = await runTaskIntegrationCommand([
    "start", task.id, "--project", backend.id, "--change-set", backendChangeSet.id
  ], store, home, { now: () => new Date(NOW.getTime() + 5) });
  assert.equal(backendIntegration.data.status, "committed");
  assert.equal(backendIntegration.data.attempt.projectId, backend.id);
  await assert.rejects(
    manager.assertIntegrated(item.id),
    new RegExp(`not integrated: ${frontendChangeSet.id}`, "i")
  );
  const frontendIntegration = await runTaskIntegrationCommand([
    "start", task.id, "--project", frontend.id, "--change-set", frontendChangeSet.id
  ], store, home, { now: () => new Date(NOW.getTime() + 6) });
  assert.equal(frontendIntegration.data.status, "committed");
  assert.equal(frontendIntegration.data.attempt.projectId, frontend.id);
  const proof = await manager.assertIntegrated(item.id);
  assert.deepEqual(
    proof.projects.map(({ projectId, changeSetId }) => ({ projectId, changeSetId })),
    [
      { projectId: backend.id, changeSetId: backendChangeSet.id },
      { projectId: frontend.id, changeSetId: frontendChangeSet.id }
    ]
  );
  assert.equal(readFileSync(join(main.root, "backend", "contract.txt"), "utf8"), "v2\n");
  assert.equal(readFileSync(join(main.root, "frontend", "client.txt"), "utf8"), "v2\n");
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
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath, ["leader"]);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));

  const prepared = await preparer.prepareTaskWorkspace(task.id);
  const preparedEntry = store.getRoleWorkspace(task.id, "leader").entries[0];
  assert.equal(
    execFileSync("git", ["-C", preparedEntry.path, "rev-parse", "HEAD"], {
      encoding: "utf8"
    }).trim(),
    collisionCommit
  );
  assert.equal(store.getRoleWorkspace(task.id, "leader").root, prepared.path);
  assert.equal(store.getTask(task.id).cwd, prepared.path);
});

test("a persisted Task workspace can restore its retained branch after the directory is lost", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Restore retained branch", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath, ["leader"]);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const first = await preparer.prepareTaskWorkspace(task.id);
  const firstEntry = store.getRoleWorkspace(task.id, "leader").entries[0];
  writeFileSync(join(firstEntry.path, "progress.txt"), "retained progress\n");
  execFileSync("git", ["-C", firstEntry.path, "add", "progress.txt"]);
  execFileSync("git", ["-C", firstEntry.path, "commit", "-qm", "retained progress"]);
  const retainedCommit = execFileSync(
    "git", ["-C", firstEntry.path, "rev-parse", "HEAD"], { encoding: "utf8" }
  ).trim();
  execFileSync("git", ["-C", repositoryPath, "worktree", "remove", firstEntry.path]);

  const restored = await preparer.prepareTaskWorkspace(task.id);
  assert.equal(restored.path, first.path);
  const restoredEntry = store.getRoleWorkspace(task.id, "leader").entries[0];
  assert.equal(
    execFileSync("git", ["-C", restoredEntry.path, "rev-parse", "HEAD"], {
      encoding: "utf8"
    }).trim(),
    retainedCommit
  );
});

test("Leader can directly create and clean a WorkItem-owned isolated worktree", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Parallel Task", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-1", task.id, {
    title: "Parallel edit",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const main = (await preparer.prepareTaskWorkspace(task.id)).path;
  const isolated = await preparer.prepareWorkItemWorkspace(item.id);
  const isolatedEntry = isolated.entries[0];
  assert.deepEqual(isolated.owner, { type: "work-item", workItemId: item.id });
  assert.equal(
    isolatedEntry.path,
    join(workspace, "worktree", "Yui", task.id, item.id)
  );
  assert.equal(store.getRole(task.id, "worker").workspace, isolated.root);
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
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, next);
  assert.throws(
    () => runTaskCommand(["work", "dispatch", next.id], store, { now: () => new Date(NOW) }),
    /work-1.*cleanup|cleanup.*work-1/i
  );

  const dirtyFile = join(isolatedEntry.path, "dirty.txt");
  writeFileSync(dirtyFile, "preserve\n");
  assert.equal(await preparer.cleanupWorkItemWorkspace(item.id, "integrated"), "dirty");
  assert.equal(existsSync(isolated.root), true);
  assert.deepEqual(store.getRoleWorkspace(task.id, "worker").owner, {
    type: "work-item",
    workItemId: item.id
  });
  unlinkSync(dirtyFile);
  assert.equal(await preparer.cleanupWorkItemWorkspace(item.id, "integrated"), "removed");
  assert.equal(existsSync(isolated.root), false);
  assert.equal(store.getRoleWorkspace(task.id, "worker"), null);
  assert.equal(store.getRole(task.id, "worker").workspace, main);
  assert.equal(store.getWorkItem(task.id, item.id).workspaceDisposition, "integrated");
  assert.throws(() => execFileSync(
    "git",
    ["-C", repositoryPath, "show-ref", "--verify", "refs/heads/yui/task-1/work-1"],
    { stdio: "ignore" }
  ));
});

test("Leader acceptance consumes an exact workspace integration proof", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Acceptance proof", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-1", task.id, {
    title: "No-change review",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const isolated = await preparer.prepareWorkItemWorkspace(item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  store.saveWorkItem(task.id, updateWorkItemStatus(
    running,
    "awaiting_acceptance",
    NOW
  ));
  const yielded = yieldAgentRun(createAgentRun(
    "run-1",
    task.id,
    "worker",
    "new",
    "Review without changes",
    NOW,
    { workItemId: item.id }
  ), "No changes required.", NOW);
  store.saveAgentRun(yielded);
  const leader = {
    now: () => new Date(NOW),
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };

  assert.throws(
    () => runTaskCommand(
      ["work", "accept", item.id, "--summary", "Reviewed."],
      store,
      {
        ...leader,
        verifiedWorkItemId: item.id,
        workItemIntegrationProof: {
          workItemId: item.id,
          assignee: "worker",
          workspace: isolated,
          projects: [{
            projectId: project.id,
            baseCommit: isolated.entries[0].baseCommit,
            headCommit: "b".repeat(40)
          }]
        }
      }
    ),
    /integration verification is stale/i
  );
  assert.equal(store.getWorkItem(task.id, item.id).status, "awaiting_acceptance");

  const proof = await new WorkItemChangeSetManager(store, () => new Date(NOW))
    .assertIntegrated(item.id);
  assert.notEqual(proof, null);
  runTaskCommand(
    ["work", "accept", item.id, "--summary", "Reviewed."],
    store,
    { ...leader, workItemIntegrationProof: proof }
  );
  assert.equal(store.getWorkItem(task.id, item.id).status, "completed");
});

test("a Role workspace migration retires its cwd-bound stopped native session", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Move a persistent Role", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-1", task.id, {
    title: "Use an isolated cwd",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: "worker"
  }, "codex", NOW);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "native-main-cwd",
    policy: "fixed",
    status: "stopped"
  }, NOW);
  store.saveTaskRoleSessionSet(sessions);

  await preparer.prepareWorkItemWorkspace(item.id);
  assert.equal(store.getRoleSession(task.id, "worker"), null);

  sessions = recordRoleAgentSession(
    store.getTaskRoleSessionSet(task.id, "worker"),
    {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "native-isolated-cwd",
      policy: "fixed",
      status: "stopped"
    },
    NOW
  );
  store.saveTaskRoleSessionSet(sessions);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const completed = updateWorkItemStatus(running, "completed", NOW, "Done.");
  store.saveWorkItem(task.id, completed);

  assert.equal(await preparer.cleanupWorkItemWorkspace(item.id, "integrated"), "removed");
  assert.equal(store.getRoleSession(task.id, "worker"), null);
});

test("Leader can capture, integrate, and clean an isolated Role result before follow-up work", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Long-running Role delivery", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-1", task.id, {
    title: "Implement the first increment",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const main = store.getRoleWorkspace(task.id, "leader").entries[0].path;
  const isolated = await preparer.prepareWorkItemWorkspace(item.id);
  writeFileSync(join(isolated.entries[0].path, "delivered.txt"), "first increment\n");
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  store.saveWorkItem(
    task.id,
    updateWorkItemStatus(running, "completed", NOW, "Implemented and tested.")
  );

  const capture = spawnSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "task", "work", "capture", item.id],
    {
      encoding: "utf8",
      env: { ...process.env, YUI_HOME: home },
      timeout: 10_000
    }
  );
  assert.equal(capture.status, 0, capture.stderr || capture.error?.message);
  assert.match(capture.stdout, /Captured ChangeSet/);
  const [changeSet] = store.listChangeSets(task.id);
  assert.equal(changeSet.schemaVersion, 2);
  assert.equal(changeSet.workItemId, item.id);
  assert.deepEqual(changeSet.changedPaths, ["delivered.txt"]);
  const repeatedCapture = spawnSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "task", "work", "capture", item.id],
    {
      encoding: "utf8",
      env: { ...process.env, YUI_HOME: home },
      timeout: 10_000
    }
  );
  assert.equal(repeatedCapture.status, 0, repeatedCapture.stderr || repeatedCapture.error?.message);
  assert.match(repeatedCapture.stdout, new RegExp(changeSet.id));
  assert.equal(store.listChangeSets(task.id).length, 1);
  const lateFile = join(isolated.entries[0].path, "late-mutation.txt");
  writeFileSync(lateFile, "must not alter the captured result\n");
  const mutatedCapture = spawnSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "task", "work", "capture", item.id],
    {
      encoding: "utf8",
      env: { ...process.env, YUI_HOME: home },
      timeout: 10_000
    }
  );
  assert.equal(mutatedCapture.status, 0, mutatedCapture.stderr || mutatedCapture.error?.message);
  const latestChangeSet = store.listChangeSets(task.id).find(
    ({ id }) => id !== changeSet.id
  );
  assert.notEqual(latestChangeSet, undefined);
  assert.match(mutatedCapture.stdout, new RegExp(latestChangeSet.id));
  assert.equal(store.listChangeSets(task.id).length, 2);
  assert.equal(
    execFileSync("git", ["-C", isolated.entries[0].path, "status", "--porcelain"], {
      encoding: "utf8"
    }),
    ""
  );

  const prematureCleanup = spawnSync(
    process.execPath,
    [
      join(process.cwd(), "dist", "cli.js"),
      "task", "work", "cleanup", item.id, "--integrated"
    ],
    {
      encoding: "utf8",
      env: { ...process.env, YUI_HOME: home },
      timeout: 10_000
    }
  );
  assert.equal(prematureCleanup.status, 2);
  assert.match(prematureCleanup.stderr, /ChangeSet is not integrated/);
  assert.equal(existsSync(isolated.entries[0].path), true);

  const integration = await runTaskIntegrationCommand([
    "start",
    task.id,
    "--change-set",
    latestChangeSet.id,
    "--check",
    "test -f delivered.txt && test -f late-mutation.txt"
  ], store, home, { now: () => new Date(NOW) });
  assert.match(integration.output, /Integrated/);
  assert.equal(readFileSync(join(main, "delivered.txt"), "utf8"), "first increment\n");
  const proof = await new WorkItemChangeSetManager(store, () => new Date(NOW))
    .assertIntegrated(item.id);
  assert.equal(proof.workItemId, item.id);
  assert.equal(proof.assignee, "worker");
  assert.equal(proof.workspace.root, isolated.root);
  assert.equal(proof.projects[0].headCommit, latestChangeSet.headCommit);
  assert.equal(proof.projects[0].changeSetId, latestChangeSet.id);

  const cleanup = spawnSync(
    process.execPath,
    [
      join(process.cwd(), "dist", "cli.js"),
      "task", "work", "cleanup", item.id, "--integrated"
    ],
    {
      encoding: "utf8",
      env: { ...process.env, YUI_HOME: home },
      timeout: 10_000
    }
  );
  assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.error?.message);
  assert.equal(existsSync(isolated.entries[0].path), false);
  assert.equal(store.getRoleWorkspace(task.id, "worker"), null);

  const followUp = createWorkItem("work-2", task.id, {
    title: "Implement the follow-up increment",
    assignee: "worker",
    writeProjectIds: [project.id],
    dependsOn: [item.id]
  }, NOW);
  store.saveWorkItem(task.id, followUp);
  await preparer.prepareWorkItemWorkspace(followUp.id);
  assert.doesNotThrow(
    () => runTaskCommand(["work", "dispatch", followUp.id], store, {
      now: () => new Date(NOW)
    })
  );
});

test("integrated cleanup retains a clean self-committed Role result until it is captured", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Preserve uncaptured delivery", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-1", task.id, {
    title: "Commit before yielding",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const isolated = await preparer.prepareWorkItemWorkspace(item.id);
  writeFileSync(join(isolated.entries[0].path, "self-committed.txt"), "preserve me\n");
  execFileSync("git", ["-C", isolated.entries[0].path, "add", "self-committed.txt"]);
  execFileSync("git", ["-C", isolated.entries[0].path, "commit", "-qm", "worker result"]);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  store.saveWorkItem(
    task.id,
    updateWorkItemStatus(running, "completed", NOW, "Committed and yielded.")
  );

  const cleanup = spawnSync(
    process.execPath,
    [
      join(process.cwd(), "dist", "cli.js"),
      "task", "work", "cleanup", item.id, "--integrated"
    ],
    {
      encoding: "utf8",
      env: { ...process.env, YUI_HOME: home },
      timeout: 10_000
    }
  );

  assert.equal(cleanup.status, 2);
  assert.match(cleanup.stderr, /uncaptured commits/i);
  assert.equal(existsSync(isolated.entries[0].path), true);
  assert.equal(store.getRoleWorkspace(task.id, "worker")?.owner.workItemId, item.id);
  assert.equal(store.listChangeSets(task.id).length, 0);
});

test("concurrent WorkItem capture persists one semantic ChangeSet", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Capture one durable result", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-1", task.id, {
    title: "Commit once",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const isolated = await preparer.prepareWorkItemWorkspace(item.id);
  writeFileSync(join(isolated.entries[0].path, "concurrent.txt"), "one semantic result\n");
  execFileSync("git", ["-C", isolated.entries[0].path, "add", "concurrent.txt"]);
  execFileSync("git", ["-C", isolated.entries[0].path, "commit", "-qm", "worker result"]);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  store.saveWorkItem(
    task.id,
    updateWorkItemStatus(running, "completed", NOW, "Ready for capture.")
  );

  const [[first], [second]] = await Promise.all([
    new WorkItemChangeSetManager(new FileTaskStore(home), () => new Date(NOW)).capture(item.id),
    new WorkItemChangeSetManager(new FileTaskStore(home), () => new Date(NOW)).capture(item.id)
  ]);

  assert.notEqual(first, null);
  assert.notEqual(second, null);
  assert.equal(first.id, second.id);
  assert.equal(new FileTaskStore(home).listChangeSets(task.id).length, 1);
});

test("an awaiting WorkItem can capture successive immutable ChangeSets", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Review successive results", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-1", task.id, {
    title: "Revise before acceptance",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const isolated = await preparer.prepareWorkItemWorkspace(item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  store.saveWorkItem(
    task.id,
    updateWorkItemStatus(running, "awaiting_acceptance", NOW)
  );
  const manager = new WorkItemChangeSetManager(store, () => new Date(NOW));

  writeFileSync(join(isolated.entries[0].path, "reviewed.txt"), "round one\n");
  const [first] = await manager.capture(item.id);
  assert.notEqual(first, undefined);
  assert.equal((await manager.capture(item.id))[0].id, first.id);

  writeFileSync(join(isolated.entries[0].path, "reviewed.txt"), "round two\n");
  const [second] = await manager.capture(item.id);
  assert.notEqual(second, undefined);
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.headCommit, first.headCommit);
  assert.ok(Date.parse(second.createdAt) > Date.parse(first.createdAt));
  assert.equal(store.listChangeSets(task.id).length, 2);
  await assert.rejects(manager.assertIntegrated(item.id), new RegExp(second.id));
});

test("WorkItem cleanup validates its disposition before removing the worktree", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Disposition safety", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-1", task.id, {
    title: "Parallel edit",
    assignee: "worker",
    writeProjectIds: [project.id]
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
  assert.equal(existsSync(isolated.entries[0].path), true);
  assert.notEqual(store.getRoleWorkspace(task.id, "worker"), null);
});

test("WorkItem cleanup reports a post-removal race and converges on retry", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Cleanup retry", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-1", task.id, {
    title: "Remove an isolated result",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const setup = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await setup.prepareTaskWorkspace(task.id);
  await setup.prepareWorkItemWorkspace(item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  store.saveWorkItem(
    task.id,
    updateWorkItemStatus(running, "completed", NOW, "Ready for cleanup.")
  );

  let removalCount = 0;
  const racingGit = {
    async inspectWorktree() {
      return "missing";
    },
    async removeWorktree() {
      if (removalCount++ === 0) {
        let sessions = createRoleSessionSet({
          scope: "task",
          taskId: task.id,
          roleName: "worker"
        }, "codex", NOW);
        sessions = recordRoleAgentSession(sessions, {
          agentId: "codex",
          adapterId: "codex",
          nativeSessionId: "restored-during-cleanup",
          policy: "fixed",
          status: "ready"
        }, NOW);
        store.saveTaskRoleSessionSet(sessions);
        return "removed";
      }
      return "missing";
    }
  };
  const preparer = new FileTaskWorkspacePreparer(
    home,
    store,
    racingGit,
    () => new Date(NOW)
  );

  await assert.rejects(
    preparer.cleanupWorkItemWorkspace(item.id, "integrated"),
    /worktree was removed.*durable cleanup was not recorded.*retry/i
  );
  assert.notEqual(store.getRoleWorkspace(task.id, "worker"), null);
  assert.equal(store.getWorkItem(task.id, item.id).workspaceDisposition, undefined);

  const coordinator = new TaskWorkspaceCoordinator(store, preparer, {
    async stopTaskRoleSessions() {
      const sessions = store.getTaskRoleSessionSet(task.id, "worker");
      store.saveTaskRoleSessionSet(
        updateRoleAgentSessionStatus(sessions, "codex", "stopped", NOW)
      );
    }
  });
  assert.equal(await coordinator.cleanupWorkItem(item.id, "integrated"), "missing");
  assert.equal(store.getRoleWorkspace(task.id, "worker"), null);
  assert.equal(store.getWorkItem(task.id, item.id).workspaceDisposition, "integrated");
});

test("WorkItem cleanup cannot commit across a newly prepared in-flight Role run", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Cleanup in-flight fence", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-1", task.id, {
    title: "Remove after run settles",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const setup = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await setup.prepareTaskWorkspace(task.id);
  await setup.prepareWorkItemWorkspace(item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  store.saveWorkItem(task.id, updateWorkItemStatus(
    running,
    "completed",
    NOW,
    "Ready for cleanup."
  ));

  const racingGit = {
    async inspectWorktree() {
      return "missing";
    },
    async removeWorktree() {
      let sessions = createRoleSessionSet({
        scope: "task",
        taskId: task.id,
        roleName: "worker"
      }, "codex", NOW);
      sessions = bindTaskRoleRun(sessions, {
        agentId: "codex",
        runId: "run-prepared-during-cleanup",
        receiptId: "receipt-prepared-during-cleanup"
      }, NOW);
      store.saveTaskRoleSessionSet(sessions);
      return "removed";
    }
  };
  const preparer = new FileTaskWorkspacePreparer(
    home,
    store,
    racingGit,
    () => new Date(NOW)
  );

  await assert.rejects(
    preparer.cleanupWorkItemWorkspace(item.id, "integrated"),
    /worktree was removed.*durable cleanup was not recorded.*retry/i
  );
  assert.notEqual(store.getRoleWorkspace(task.id, "worker"), null);
  assert.equal(store.getWorkItem(task.id, item.id).workspaceDisposition, undefined);
  assert.equal(
    store.getTaskRoleSessionSet(task.id, "worker").inFlight.runId,
    "run-prepared-during-cleanup"
  );
});

test("late WorkItem cleanup preserves a replacement workspace owned by newer work", async (t) => {
  const { root, home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Cleanup workspace CAS", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const first = createWorkItem("work-1", task.id, {
    title: "Old isolated work",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  const second = createWorkItem("work-2", task.id, {
    title: "New isolated work",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, first);
  store.saveWorkItem(task.id, second);
  const setup = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await setup.prepareTaskWorkspace(task.id);
  const oldWorkspace = await setup.prepareWorkItemWorkspace(first.id);
  const running = updateWorkItemStatus(first, "running", NOW);
  store.saveWorkItem(task.id, running);
  store.saveWorkItem(task.id, updateWorkItemStatus(
    running,
    "completed",
    NOW,
    "Ready for cleanup."
  ));
  const replacement = createRoleWorkspace({
    taskId: task.id,
    roleName: "worker",
    owner: { type: "work-item", workItemId: second.id },
    root: join(root, "replacement"),
    entries: [{
      ...oldWorkspace.entries[0],
      path: join(root, "replacement-worktree"),
      branch: "yui/task-1/work-2"
    }]
  }, new Date(NOW.getTime() + 1));

  const racingGit = {
    async inspectWorktree() {
      return "missing";
    },
    async removeWorktree() {
      store.transaction((tx) => {
        tx.saveRoleWorkspace(task.id, replacement);
        tx.saveRole(task.id, updateRole(
          tx.getRole(task.id, "worker"),
          { workspace: replacement.root },
          new Date(NOW.getTime() + 1)
        ));
      });
      return "removed";
    }
  };
  const preparer = new FileTaskWorkspacePreparer(
    home,
    store,
    racingGit,
    () => new Date(NOW)
  );

  assert.equal(
    await preparer.cleanupWorkItemWorkspace(first.id, "integrated"),
    "removed"
  );
  assert.deepEqual(store.getRoleWorkspace(task.id, "worker"), replacement);
  assert.equal(store.getRole(task.id, "worker").workspace, replacement.root);
  assert.equal(store.getWorkItem(task.id, first.id).workspaceDisposition, "integrated");
});

test("WorkItem cleanup cannot record a disposition without an isolated worktree", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "No isolation", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = updateWorkItemStatus(createWorkItem("work-1", task.id, {
    title: "Shared work",
    assignee: "worker",
    writeProjectIds: [project.id]
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
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, active, repositoryPath);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const main = (await preparer.prepareTaskWorkspace(active.id)).path;
  const mainEntry = store.getRoleWorkspace(active.id, "leader").entries[0];
  store.saveTask(completeTask(store.getTask(active.id), NOW, {
    summary: "Done",
    by: "user"
  }));
  const dirtyFile = join(mainEntry.path, "dirty.txt");
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
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, active, repositoryPath);
  const item = createWorkItem("work-1", active.id, {
    title: "Isolated edit",
    assignee: "worker",
    writeProjectIds: [project.id]
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
  assert.equal(existsSync(isolated.entries[0].path), true);
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
