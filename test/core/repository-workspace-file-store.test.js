import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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
  bindExecution,
  claimPending,
  createWorkMailbox,
  enqueueSignal
} from "../../dist/coordination/workMailbox.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  retireTaskRoleSessionsForWorkspace,
  roleAgentSessionResumeMode,
  updateRoleAgentSessionStatus
} from "../../dist/executor/agentExecutor.js";
import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { runTaskIntegrationCommand } from "../../dist/commands/taskIntegrationCommands.js";
import {
  dispatchPreparedReviewRound,
  runTaskCommand
} from "../../dist/commands/taskCommands.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import {
  createGlobalRole,
  createRole,
  createRoleAgentBinding,
  updateRole
} from "../../dist/role/role.js";
import { yieldAgentRun } from "../../dist/run/agentRun.js";
import { createStartupReadyClaudeAgent } from "../helpers/mockClaudeAgent.js";
import {
  createReviewRound,
  createTaskReviewRound
} from "../../dist/review/reviewRound.js";
import {
  createTaskFinalReviewContract
} from "../../dist/review/taskFinalReviewContract.js";
import {
  createAgentRun,
  recordRoleAgentSession,
  testEffectiveLaunch
} from "../helpers/effectiveLaunch.js";
import { exactTaskCliInvocation } from "../helpers/exactTaskCli.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createInputRequest } from "../../dist/input/inputRequest.js";
import {
  createIntegrationAttempt,
  updateIntegrationAttempt
} from "../../dist/integration/integrationAttempt.js";
import { createProject } from "../../dist/repository/project.js";
import {
  NodeGitWorkspace,
  worktreeIdentity
} from "../../dist/repository/gitWorkspace.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { TaskWorkspaceCoordinator } from "../../dist/repository/taskWorkspaceCoordinator.js";
import { stopFileTaskController } from "../../dist/controller/clientRuntime.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import {
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../../dist/runtime/lifecycleReservation.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, completeTask, createTask } from "../../dist/task/task.js";
import {
  createWorkItem,
  createCandidateGitSnapshot,
  recordWorkItemWorkspaceDisposition,
  submitWorkItemCandidate,
  updateWorkItemWriteProjects,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { yuiTmuxServerName } from "../../dist/tmux/tmuxManager.js";
import { WorkItemChangeSetManager } from "../../dist/workspace/workItemChangeSetManager.js";

const NOW = new Date("2026-07-19T12:00:00.000Z");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

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
    const stoppedTmux = spawnSync(
      process.env.YUI_TMUX_BIN ?? "tmux",
      ["-L", yuiTmuxServerName(home), "kill-server"],
      { encoding: "utf8", env: { ...process.env, YUI_HOME: home } }
    );
    assert.equal(
      stoppedTmux.status === 0
        || /no server running|failed to connect|error connecting/i.test(stoppedTmux.stderr ?? ""),
      true,
      `Fixture tmux cleanup failed: ${stoppedTmux.stderr || stoppedTmux.error?.message}`
    );
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

function addTaskRoles(
  store,
  task,
  repositoryPath,
  names = ["leader", "worker"],
  configuredAgent = undefined
) {
  const agent = configuredAgent
    ?? createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
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

function savePlannerRun(store, taskId, roleName, context = {}) {
  const run = createAgentRun(
    store.nextAgentRunId(taskId),
    taskId,
    roleName,
    "new",
    "Planner fixture launch.",
    NOW,
    context
  );
  store.saveAgentRun(run);
  store.saveActiveAgentRun(run);
  return run;
}

function markDelivered(store, run) {
  const deliveredAt = new Date(Math.max(
    NOW.getTime(),
    Date.parse(run.createdAt)
  ));
  store.transaction((tx) => {
    const target = { kind: "role", taskId: run.taskId, roleName: run.roleName };
    let mailbox = tx.getWorkMailbox(target) ?? createWorkMailbox(target);
    if (mailbox.processing === null) {
      if (mailbox.pending === null) {
        mailbox = enqueueSignal(mailbox, {
          reason: "fixture-run-dispatched",
          refs: [{ type: "run", taskId: run.taskId, id: run.id }],
          occurredAt: deliveredAt.toISOString()
        });
      }
      const batchId = `agent-run:${run.taskId}/${run.id}`;
      mailbox = bindExecution(
        claimPending(mailbox, {
          batchId,
          owner: "controller",
          startedAt: deliveredAt.toISOString()
        }),
        batchId,
        { type: "run", taskId: run.taskId, id: run.id }
      );
      tx.saveWorkMailbox(mailbox);
    }
    tx.saveAgentRun({
      ...run,
      pushedAt: deliveredAt.toISOString(),
      deliveredAt: deliveredAt.toISOString()
    });
  });
}

function spawnExactTaskCli(home, store, taskId, roleName, args) {
  const invocation = exactTaskCliInvocation({ home, store, taskId, roleName });
  return spawnSync(
    process.execPath,
    [invocation.cliEntry, ...invocation.prefix, ...args],
    { encoding: "utf8", env: invocation.environment }
  );
}

function liveSessionSet(status = "ready") {
  return {
    sessions: { codex: { status } },
    inFlight: null,
    pendingTurnCompletion: null
  };
}

function dormantClaudePlaceholder(launchId) {
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: "task-1",
    roleName: "worker"
  }, "codex", NOW);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "claude",
    adapterId: "claude",
    nativeSessionId: "aggregate-16-claude-placeholder",
    ...(launchId === undefined ? {} : { launchId }),
    policy: "fixed",
    status: "ready"
  }, NOW);
  return sessions;
}

function placeholderIsolationStore(initialSessions) {
  let sessions = initialSessions;
  const item = {
    id: "work-item-1",
    taskId: "task-1",
    assignee: "worker",
    writeProjectIds: ["project-1"],
    status: "pending"
  };
  const store = {
    getWorkItem: () => item,
    getTask: () => ({
      id: item.taskId,
      status: "active",
      projectBindings: [{ projectId: "project-1" }]
    }),
    getRole: () => ({ name: item.assignee }),
    getWorkItemWorkspace: () => null,
    getActiveAgentRun: () => null,
    listAgentRuns: () => [],
    getTaskRoleSessionSet: () => sessions,
    saveTaskRoleSessionSet(next) { sessions = next; },
    transaction(operation) { return operation(store); }
  };
  return { item, store, sessions: () => sessions };
}

test("workspace isolation preserves a dormant Claude placeholder while its exact Role pane is live", async () => {
  const fixture = placeholderIsolationStore(dormantClaudePlaceholder());
  const before = structuredClone(fixture.sessions());
  let stopped = 0;
  let prepared = false;
  const coordinator = new TaskWorkspaceCoordinator(fixture.store, {
    now: () => new Date(NOW),
    async prepareTaskWorkspace() {},
    async prepareWorkItemWorkspace() {
      prepared = true;
      return { path: "/must-not-be-created" };
    }
  }, {
    inspectTaskRolePanes() {
      return [{ roleName: "worker", dead: false }];
    },
    async stopTaskRoleSessions() { stopped += 1; }
  });

  await assert.rejects(
    coordinator.isolateWorkItem(fixture.item.taskId, fixture.item.id),
    /native pane must stop/i
  );
  assert.equal(stopped, 1);
  assert.equal(prepared, false);
  assert.deepEqual(fixture.sessions(), before);
});

test("workspace isolation preserves an absent but launch-bearing inactive Claude Session", async () => {
  const fixture = placeholderIsolationStore(
    dormantClaudePlaceholder("launch-real-claude")
  );
  const before = structuredClone(fixture.sessions());
  const coordinator = new TaskWorkspaceCoordinator(fixture.store, {
    now: () => new Date(NOW),
    async prepareTaskWorkspace() {},
    async prepareWorkItemWorkspace() {
      retireTaskRoleSessionsForWorkspace(fixture.sessions(), NOW);
    }
  }, {
    inspectTaskRolePanes() { return []; },
    async stopTaskRoleSessions() {}
  });

  await assert.rejects(
    coordinator.isolateWorkItem(fixture.item.taskId, fixture.item.id),
    /claude.*stopped|stopped.*claude/i
  );
  assert.deepEqual(fixture.sessions(), before);
});

test("workspace isolation rechecks a runless launch reservation before placeholder retirement", async () => {
  const fixture = placeholderIsolationStore(dormantClaudePlaceholder());
  const before = structuredClone(fixture.sessions());
  const target = runtimeLifecycleTarget({
    scope: "task",
    taskId: fixture.item.taskId,
    roleName: fixture.item.assignee
  });
  let mailbox = null;
  fixture.store.getWorkMailbox = () => mailbox;
  let prepared = false;
  let inspections = 0;
  const coordinator = new TaskWorkspaceCoordinator(fixture.store, {
    now: () => new Date(NOW),
    async prepareTaskWorkspace() {},
    async prepareWorkItemWorkspace() {
      prepared = true;
      return { path: "/must-not-be-created" };
    }
  }, {
    inspectTaskRolePanes() {
      inspections += 1;
      if (inspections === 1) {
        mailbox = claimPending(enqueueSignal(createWorkMailbox(target), {
          reason: "runtime-launch-reserved",
          refs: [{ type: "task", id: fixture.item.taskId }],
          occurredAt: NOW.toISOString()
        }), {
          batchId: "late-runless-launch",
          owner: "runtime-lifecycle",
          startedAt: NOW.toISOString()
        });
      }
      return [];
    },
    async stopTaskRoleSessions() {}
  });

  await assert.rejects(
    coordinator.isolateWorkItem(fixture.item.taskId, fixture.item.id),
    /runtime lifecycle|launch reservation|unsettled/i
  );
  assert.equal(inspections, 2);
  assert.equal(prepared, false);
  assert.deepEqual(fixture.sessions(), before);
  assert.equal(isRuntimeLaunchReservation(
    mailbox.processing,
    "late-runless-launch"
  ), true);
});

test("workspace coordination stops a live Role only after a clean preflight", async () => {
  const events = [];
  const item = {
    id: "work-item-1",
    taskId: "task-1",
    assignee: "worker",
    writeProjectIds: ["project-1"],
    status: "pending"
  };
  const store = {
    getWorkItem: () => item,
    getTask: () => ({
      id: "task-1",
      status: "active",
      projectBindings: [{ projectId: "project-1" }]
    }),
    getActiveAgentRun: () => null,
    listAgentRuns: () => [],
    listWorkItems: () => [item],
    getRole: () => ({ name: "worker" }),
    getWorkItemWorkspace: () => item.status === "completed"
      ? { owner: { type: "work-item", taskId: item.taskId, workItemId: item.id } }
      : null,
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
      return { path: "/workspace/worktree/task-1/work-item-1" };
    },
    async inspectWorkItemWorkspace() {
      events.push(["inspect"]);
      return "clean";
    },
    async cleanupWorkItemWorkspace(_taskId, _id, disposition) {
      events.push(["cleanup", disposition]);
      return "removed";
    }
  };
  const coordinator = new TaskWorkspaceCoordinator(store, preparer, runtime);

  await coordinator.isolateWorkItem(item.taskId, item.id);
  assert.deepEqual(events, [
    ["main"],
    ["stop", "task-1", ["worker"]],
    ["isolate"]
  ]);

  item.status = "completed";
  events.length = 0;
  await coordinator.cleanupWorkItem(item.taskId, item.id, "integrated");
  assert.deepEqual(events, [
    ["inspect"],
    ["stop", "task-1", ["worker"]],
    ["cleanup", "integrated"]
  ]);
});

test("workspace cleanup stops a restored Role before converging a missing worktree", async () => {
  const events = [];
  const item = {
    id: "work-item-1",
    taskId: "task-1",
    assignee: "worker",
    writeProjectIds: ["project-1"],
    status: "completed"
  };
  const coordinator = new TaskWorkspaceCoordinator({
    getWorkItem: () => item,
    listAgentRuns: () => [],
    listWorkItems: () => [item],
    getTaskRoleSessionSet: () => liveSessionSet()
  }, {
    async inspectWorkItemWorkspace() {
      events.push(["inspect"]);
      return "missing";
    },
    async cleanupWorkItemWorkspace(_taskId, _id, disposition) {
      events.push(["cleanup", disposition]);
      return "missing";
    }
  }, {
    async stopTaskRoleSessions(taskId, roles) {
      events.push(["stop", taskId, roles]);
    }
  });

  assert.equal(await coordinator.cleanupWorkItem(item.taskId, item.id, "integrated"), "missing");
  assert.deepEqual(events, [
    ["inspect"],
    ["stop", "task-1", ["worker"]],
    ["cleanup", "integrated"]
  ]);
});

test("WorkItem isolation refreshes read context after the Task gains a Project", async () => {
  const item = {
    id: "work-item-1",
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
    getWorkItem: () => item,
    getTask: () => task,
    getRole: () => ({ name: "worker" }),
    getWorkItemWorkspace: () => stale,
    getActiveAgentRun: () => null,
    listAgentRuns: () => [],
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

  assert.equal(await coordinator.isolateWorkItem(item.taskId, item.id), refreshed);
  assert.equal(refreshes, 1);
});

test("dirty WorkItem preflight retains both runtime and worktree", async () => {
  const item = {
    id: "work-item-1",
    taskId: "task-1",
    assignee: "worker",
    status: "completed"
  };
  let stopped = false;
  let cleaned = false;
  const coordinator = new TaskWorkspaceCoordinator({
    getWorkItem: () => item,
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

  assert.equal(await coordinator.cleanupWorkItem(item.taskId, item.id, "abandoned"), "dirty");
  assert.equal(stopped, false);
  assert.equal(cleaned, false);
});

test("repeated final WorkItem cleanup cannot stop a reassigned Role", async () => {
  const item = {
    id: "work-item-1",
    taskId: "task-1",
    assignee: "worker",
    status: "completed",
    workspaceDisposition: "integrated"
  };
  let stopped = false;
  let inspected = false;
  const coordinator = new TaskWorkspaceCoordinator({
    getWorkItem: () => item
  }, {
    async inspectWorkItemWorkspace() {
      inspected = true;
      return "missing";
    }
  }, {
    async stopTaskRoleSessions() { stopped = true; }
  });

  assert.equal(await coordinator.cleanupWorkItem(item.taskId, item.id, "integrated"), "missing");
  assert.equal(inspected, false);
  assert.equal(stopped, false);
});

test("runtime-only WorkItem cleanup stops the host but preserves its resumable workspace", async () => {
  const item = {
    id: "work-item-1",
    taskId: "task-1",
    assignee: "worker",
    status: "running"
  };
  const effective = testEffectiveLaunch({
    agentId: "codex",
    adapterId: "codex",
    workspaceRoot: "/workspace/task-1/work-item-1"
  });
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: item.taskId,
    roleName: item.assignee
  }, "codex", NOW);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "native-work-item-1",
    policy: "fixed",
    effective,
    status: "ready"
  }, NOW);
  let inspected = false;
  let removed = false;
  const coordinator = new TaskWorkspaceCoordinator({
    getWorkItem: () => item,
    listAgentRuns: () => [],
    listWorkItems: () => [item],
    getTaskRoleSessionSet: () => sessions
  }, {
    async inspectWorkItemWorkspace() { inspected = true; },
    async cleanupWorkItemWorkspace() { removed = true; }
  }, {
    async stopTaskRoleSessions() {
      sessions = updateRoleAgentSessionStatus(sessions, "codex", "stopped", NOW);
    }
  });

  assert.equal(
    await coordinator.cleanupWorkItemRuntime(item.taskId, item.id),
    "released"
  );
  assert.equal(inspected, false);
  assert.equal(removed, false);
  assert.equal(sessions.sessions.codex.nativeSessionId, "native-work-item-1");
  assert.equal(sessions.sessions.codex.status, "stopped");
  assert.equal(roleAgentSessionResumeMode(sessions, "codex", effective), "resume");
});

test("runtime-only WorkItem cleanup does not disturb a Role serving another WorkItem", async () => {
  const item = {
    id: "work-item-1",
    taskId: "task-1",
    assignee: "worker",
    status: "running"
  };
  let stopped = false;
  const coordinator = new TaskWorkspaceCoordinator({
    getWorkItem: () => item,
    listAgentRuns: () => [{ id: "agent-run-2", status: "active", workItemId: "work-item-2" }],
    getTaskRoleSessionSet: () => null
  }, {}, {
    async stopTaskRoleSessions() { stopped = true; }
  });

  assert.equal(await coordinator.cleanupWorkItemRuntime(item.taskId, item.id), "released");
  assert.equal(stopped, false);
});

test("invalid WorkItem isolation leaves a live Role session untouched", async () => {
  const item = {
    id: "work-item-1",
    taskId: "task-1",
    assignee: "worker",
    status: "completed"
  };
  let preparedMain = false;
  let stopped = false;
  const coordinator = new TaskWorkspaceCoordinator({
    getWorkItem: () => item,
    getTask: () => ({
      id: "task-1",
      status: "active",
      projectBindings: [{ projectId: "project-1" }]
    }),
    getActiveAgentRun: () => null,
    listAgentRuns: () => [],
    getRole: () => ({ name: "worker" }),
    getWorkItemWorkspace: () => null,
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

  await assert.rejects(coordinator.isolateWorkItem(item.taskId, item.id), /already terminal/i);
  assert.equal(preparedMain, false);
  assert.equal(stopped, false);
});

test("invalid WorkItem cleanup leaves a live Role session untouched", async () => {
  const item = {
    id: "work-item-1",
    taskId: "task-1",
    assignee: "worker",
    status: "pending"
  };
  let inspected = false;
  let stopped = false;
  const coordinator = new TaskWorkspaceCoordinator({
    getWorkItem: () => item,
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

  await assert.rejects(coordinator.cleanupWorkItem(item.taskId, item.id, "integrated"), /must be terminal/i);
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
  assert.deepEqual(store.listManagedWorkspaces(task.id).map((entry) => ({
    owner: entry.owner,
    root: entry.root
  })), [{
    owner: { type: "task", taskId: task.id },
    root: main
  }]);
  assert.equal(existsSync(join(mainProject, ".git")), true);
  const reviewerRun = savePlannerRun(store, task.id, "reviewer", {
    workspace: store.getTaskWorkspace(task.id)
  });
  assert.doesNotThrow(() => planner.plan({
    taskId: task.id,
    roleName: "reviewer",
    agentId: agent.id,
    adapterId: agent.adapterId,
    effective: reviewerRun.effective,
    mode: "new"
  }));
});

test("a lazily copied reviewer starts from the prepared Project Task workspace", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Review a Project Task", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(agent)],
      agent.id,
      workspace,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "leader" }
    });
    tx.saveTask(task);
    for (const name of ["leader", "worker"]) {
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
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const main = (await preparer.prepareTaskWorkspace(task.id)).path;
  const item = createWorkItem("work-item-1", task.id, {
    title: "Review the result",
    assignee: "worker"
  }, NOW);
  store.saveWorkItem(task.id, item);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const developWorkspace = await preparer.prepareWorkItemWorkspace(task.id, item.id);
  const candidateRun = yieldAgentRun(createAgentRun(
    "agent-run-1",
    task.id,
    "worker",
    "new",
    "Produce a candidate.",
    NOW,
    { workItemId: item.id, workspace: developWorkspace }
  ), "Candidate ready.", NOW);
  store.saveAgentRun(candidateRun);
  const gitSnapshot = await preparer.snapshotCandidateWorkspace(developWorkspace);
  store.saveWorkItem(task.id, submitWorkItemCandidate(running, {
    summary: candidateRun.summary,
    source: { type: "run", runId: candidateRun.id },
    reviewPolicy: { roleName: "reviewer", trigger: "leader" },
    workspace: developWorkspace,
    gitSnapshot
  }, NOW));

  runTaskCommand(["work", "review", item.id], store, {
    now: () => new Date(NOW),
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  });

  const round = store.listReviewRounds(task.id)[0];
  assert.equal(round.status, "pending");
  const reviewWorkspace = await preparer.prepareReviewRoundWorkspace(task.id, round.id);
  const reviewRun = dispatchPreparedReviewRound(task.id, round.id, store, {
    now: () => new Date(NOW)
  });
  assert.notEqual(reviewWorkspace.root, main);
  assert.deepEqual(reviewWorkspace.owner, {
    type: "review-round",
    taskId: task.id,
    reviewRoundId: round.id
  });
  assert.equal(reviewWorkspace.entries.every(({ access }) => access === "write"), true);
  assert.equal(store.getRole(task.id, "reviewer").workspace, reviewWorkspace.root);
  assert.doesNotThrow(() => new FileRoleLaunchPlanner(home, store, {
    cliPath: "/dist/cli.js"
  }).plan({
    taskId: task.id,
    roleName: "reviewer",
    agentId: agent.id,
    adapterId: agent.adapterId,
    effective: reviewRun.effective,
    mode: "new"
  }));
});

test("a reviewer launches from the candidate Run workspace instead of its previous Role workspace", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Review an isolated candidate", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(agent)],
      agent.id,
      workspace,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "leader" }
    });
    tx.saveTask(task);
    for (const name of ["leader", "worker"]) {
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
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Review the isolated result",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const isolated = await preparer.prepareWorkItemWorkspace(item.taskId, item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const candidateRun = yieldAgentRun(createAgentRun(
    "agent-run-1",
    task.id,
    "worker",
    "new",
    "Produce an isolated candidate.",
    NOW,
    { workItemId: item.id, workspace: isolated }
  ), "Candidate ready.", NOW);
  store.saveAgentRun(candidateRun);
  const gitSnapshot = await preparer.snapshotCandidateWorkspace(isolated);
  store.saveWorkItem(task.id, submitWorkItemCandidate(running, {
    summary: candidateRun.summary,
    source: { type: "run", runId: candidateRun.id },
    reviewPolicy: { roleName: "reviewer", trigger: "leader" },
    workspace: isolated,
    gitSnapshot
  }, NOW));

  runTaskCommand(["work", "review", item.id], store, {
    now: () => new Date(NOW),
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  });

  const round = store.listReviewRounds(task.id)[0];
  const reviewWorkspace = await preparer.prepareReviewRoundWorkspace(task.id, round.id);
  const reviewRun = dispatchPreparedReviewRound(task.id, round.id, store, {
    now: () => new Date(NOW)
  });
  assert.notEqual(reviewRun.workspace.root, isolated.root);
  assert.deepEqual(reviewRun.workspace.owner, {
    type: "review-round",
    taskId: task.id,
    reviewRoundId: round.id
  });
  assert.equal(reviewRun.workspace.entries.every(({ access }) => access === "write"), true);
  const plan = new FileRoleLaunchPlanner(home, store, {
    cliPath: "/dist/cli.js"
  }).plan({
    taskId: task.id,
    roleName: "reviewer",
    agentId: agent.id,
    adapterId: agent.adapterId,
    effective: reviewRun.effective,
    mode: "new"
  });
  assert.equal(plan.role.workspace, reviewWorkspace.root);
  assert.equal(plan.launch.env.YUI_WORKSPACE, reviewWorkspace.root);
});

test("a ReviewRound worktree starts at the frozen Candidate commit and cleans up independently", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Review an immutable Candidate", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath, ["leader", "worker", "reviewer"]);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Review the isolated result",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const workerWorkspace = await preparer.prepareWorkItemWorkspace(task.id, item.id);
  const workerEntry = workerWorkspace.entries[0];
  writeFileSync(join(workerEntry.path, "candidate.txt"), "candidate bytes\n");
  execFileSync("git", ["-C", workerEntry.path, "add", "candidate.txt"]);
  execFileSync("git", ["-C", workerEntry.path, "commit", "-qm", "candidate"]);
  const candidateCommit = execFileSync("git", ["-C", workerEntry.path, "rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();
  const candidateBytes = readFileSync(join(workerEntry.path, "candidate.txt"), "utf8");
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const candidateRun = yieldAgentRun(createAgentRun(
    "agent-run-1",
    task.id,
    "worker",
    "new",
    "Produce the Candidate.",
    NOW,
    { workItemId: item.id, workspace: workerWorkspace }
  ), "Candidate ready.", NOW);
  store.saveAgentRun(candidateRun);
  const gitSnapshot = createCandidateGitSnapshot(workerWorkspace, [{
    projectId: project.id,
    commit: candidateCommit
  }]);
  const submitted = submitWorkItemCandidate(running, {
    summary: candidateRun.summary,
    source: { type: "run", runId: candidateRun.id },
    reviewPolicy: { roleName: "reviewer", trigger: "leader" },
    workspace: workerWorkspace,
    gitSnapshot
  }, NOW);
  store.saveWorkItem(task.id, submitted);
  const round = createReviewRound(
    "review-round-1",
    task.id,
    item.id,
    submitted.candidates[0].id,
    "reviewer",
    "leader",
    candidateCommit,
    NOW
  );
  store.saveReviewRound(task.id, round);

  const reviewWorkspace = await preparer.prepareReviewRoundWorkspace(task.id, round.id);
  const reviewRun = dispatchPreparedReviewRound(task.id, round.id, store, {
    now: () => new Date(NOW)
  });
  markDelivered(store, reviewRun);
  const reviewEntry = reviewWorkspace.entries[0];
  assert.deepEqual(reviewWorkspace.owner, {
    type: "review-round",
    taskId: task.id,
    reviewRoundId: round.id
  });
  assert.equal(reviewEntry.access, "write");
  assert.notEqual(reviewEntry.path, workerEntry.path);
  assert.equal(
    execFileSync("git", ["-C", reviewEntry.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    candidateCommit
  );
  writeFileSync(join(reviewEntry.path, "reproduction.test.js"), "review evidence\n");
  execFileSync("git", ["-C", reviewEntry.path, "add", "reproduction.test.js"]);
  execFileSync("git", ["-C", reviewEntry.path, "commit", "-qm", "diagnostic evidence"]);
  const evidenceCommit = execFileSync(
    "git",
    ["-C", reviewEntry.path, "rev-parse", "HEAD"],
    { encoding: "utf8" }
  ).trim();
  assert.notEqual(evidenceCommit, candidateCommit);
  assert.equal(
    execFileSync("git", ["-C", workerEntry.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    candidateCommit
  );
  assert.equal(readFileSync(join(workerEntry.path, "candidate.txt"), "utf8"), candidateBytes);

  const candidateCount = store.getWorkItem(task.id, item.id).candidates.length;
  runTaskCommand([
    "run", "yield", reviewRun.id,
    "--summary", JSON.stringify({
      summary: "Diagnostic evidence recorded.",
      checks: [{ name: "fixture test", outcome: "passed" }],
      evidenceCommit
    })
  ], store, {
    now: () => new Date(NOW),
    environment: { YUI_TASK_ID: task.id },
    reviewWorkspaceResult: {
      evidenceCommit
    }
  });
  assert.equal(store.getReviewRound(task.id, round.id).evidenceCommit, evidenceCommit);
  assert.equal(store.getReviewRound(task.id, round.id).status, "completed");
  assert.deepEqual(store.getReviewRound(task.id, round.id).checks, [{
    name: "fixture test",
    outcome: "passed"
  }]);
  assert.equal(store.getWorkItem(task.id, item.id).candidates.length, candidateCount);
  assert.deepEqual(store.listChangeSets(task.id), []);
  assert.throws(
    () => runTaskCommand([
      "run", "yield", reviewRun.id,
      "--summary", "Late duplicate."
    ], store, {
      now: () => new Date(NOW),
      environment: { YUI_TASK_ID: task.id }
    }),
    /already terminal/i
  );
  assert.throws(
    () => store.saveChangeSet(task.id, createWorkItemChangeSet({
      id: store.nextChangeSetId(task.id),
      taskId: task.id,
      workItemId: item.id,
      projectId: project.id,
      baseCommit: candidateCommit,
      headCommit: evidenceCommit,
      branch: reviewEntry.branch,
      changedPaths: ["reproduction.test.js"]
    }, NOW)),
    /ReviewRound evidence commit.*cannot become a ChangeSet/i
  );
  assert.throws(
    () => runTaskCommand([
      "work", "accept", item.id,
      "--summary", "Do not accept review evidence."
    ], store, {
      now: () => new Date(NOW),
      environment: {
        YUI_SESSION_SCOPE: "task",
        YUI_TASK_ID: task.id,
        YUI_ROLE: "leader"
      },
      workItemIntegrationProof: {
        workItemId: item.id,
        assignee: "reviewer",
        workspace: reviewWorkspace,
        projects: [{
          projectId: project.id,
          baseCommit: candidateCommit,
          headCommit: evidenceCommit
        }]
      }
    }),
    /ReviewRound-owned workspace.*acceptance/i
  );
  store.transaction((tx) => {
    tx.saveRole(task.id, updateRole(
      tx.getRole(task.id, "reviewer"),
      { workspace: workerWorkspace.root },
      new Date(NOW.getTime() + 1)
    ));
  });
  assert.equal(await preparer.cleanupReviewRoundWorkspace(task.id, round.id), "removed");
  assert.equal(existsSync(reviewEntry.path), false);
  assert.equal(existsSync(workerEntry.path), true);
  assert.deepEqual(store.getWorkItemWorkspace(task.id, item.id), workerWorkspace);
  assert.equal(store.getRole(task.id, "reviewer").workspace, workerWorkspace.root);
  assert.equal(store.getReviewRound(task.id, round.id).workspaceDisposition.kind, "removed");
  assert.equal(
    execFileSync("git", ["-C", workerEntry.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    candidateCommit
  );
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
  const item = createWorkItem("work-item-1", task.id, {
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
  const main = store.getTaskWorkspace(task.id);
  assert.equal(main.root, mainResult.path);
  assert.deepEqual(main.entries.map(({ directory, access }) => ({ directory, access })), [
    { directory: "backend", access: "write" },
    { directory: "frontend", access: "write" }
  ]);

  const work = await preparer.prepareWorkItemWorkspace(item.taskId, item.id);
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
  const workerRun = savePlannerRun(store, task.id, "worker", {
    workItemId: item.id,
    workspace: work
  });
  const isolatedPlan = new FileRoleLaunchPlanner(home, store, {
    cliPath: "/dist/cli.js"
  }).plan({
    taskId: task.id,
    roleName: "worker",
    agentId: store.getRole(task.id, "worker").activeAgentId,
    adapterId: "codex",
    effective: workerRun.effective,
    mode: "new"
  });
  assert.equal(isolatedPlan.launch.command, "codex");
  assert.deepEqual(JSON.parse(isolatedPlan.launch.env.YUI_WRITABLE_PROJECT_IDS), [backend.id]);
  assert.deepEqual(JSON.parse(isolatedPlan.launch.env.YUI_CONTEXT_PROJECT_IDS), [frontend.id]);
  const directAgentPlan = new FileRoleLaunchPlanner(home, store, {
    cliPath: "/dist/cli.js",
    environment: { PATH: join(root, "missing-bin") }
  }).plan({
    taskId: task.id,
    roleName: "worker",
    agentId: store.getRole(task.id, "worker").activeAgentId,
    adapterId: "codex",
    effective: workerRun.effective,
    mode: "new"
  });
  assert.equal(directAgentPlan.launch.command, "codex");
  assert.deepEqual(JSON.parse(directAgentPlan.launch.env.YUI_CONTEXT_PROJECT_IDS), [frontend.id]);
  store.transaction((tx) => {
    tx.saveAgentRun(yieldAgentRun(workerRun, "Planner probe finished.", NOW));
    tx.clearActiveAgentRun(task.id, "worker");
  });

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
  const expanded = await preparer.prepareWorkItemWorkspace(item.taskId, item.id);
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
  const candidateRun = yieldAgentRun(createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "worker",
    "new",
    "Prepare multi-Project candidate.",
    new Date(NOW.getTime() + 3),
    { workItemId: item.id, workspace: expanded }
  ), "Candidate ready.", new Date(NOW.getTime() + 3));
  store.saveAgentRun(candidateRun);
  store.saveWorkItem(
    task.id,
    submitWorkItemCandidate(running, {
      summary: candidateRun.summary,
      source: { type: "run", runId: candidateRun.id },
      workspace: expanded
    }, new Date(NOW.getTime() + 3))
  );
  const manager = new WorkItemChangeSetManager(
    store,
    () => new Date(NOW.getTime() + 4)
  );
  const changeSets = await manager.capture(item.taskId, item.id);
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
    manager.assertIntegrated(item.taskId, item.id),
    new RegExp(`not integrated: ${frontendChangeSet.id}`, "i")
  );
  const frontendIntegration = await runTaskIntegrationCommand([
    "start", task.id, "--project", frontend.id, "--change-set", frontendChangeSet.id
  ], store, home, { now: () => new Date(NOW.getTime() + 6) });
  assert.equal(frontendIntegration.data.status, "committed");
  assert.equal(frontendIntegration.data.attempt.projectId, frontend.id);
  const proof = await manager.assertIntegrated(item.taskId, item.id);
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
  const preparedEntry = store.getTaskWorkspace(task.id).entries[0];
  assert.equal(
    execFileSync("git", ["-C", preparedEntry.path, "rev-parse", "HEAD"], {
      encoding: "utf8"
    }).trim(),
    collisionCommit
  );
  assert.equal(store.getTaskWorkspace(task.id).root, prepared.path);
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
  const firstEntry = store.getTaskWorkspace(task.id).entries[0];
  writeFileSync(join(firstEntry.path, "progress.txt"), "retained progress\n");
  execFileSync("git", ["-C", firstEntry.path, "add", "progress.txt"]);
  execFileSync("git", ["-C", firstEntry.path, "commit", "-qm", "retained progress"]);
  const retainedCommit = execFileSync(
    "git", ["-C", firstEntry.path, "rev-parse", "HEAD"], { encoding: "utf8" }
  ).trim();
  execFileSync("git", ["-C", repositoryPath, "worktree", "remove", firstEntry.path]);

  const restored = await preparer.prepareTaskWorkspace(task.id);
  assert.equal(restored.path, first.path);
  const restoredEntry = store.getTaskWorkspace(task.id).entries[0];
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
  const item = createWorkItem("work-item-1", task.id, {
    title: "Parallel edit",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const main = (await preparer.prepareTaskWorkspace(task.id)).path;
  const isolated = await preparer.prepareWorkItemWorkspace(item.taskId, item.id);
  const isolatedEntry = isolated.entries[0];
  assert.deepEqual(isolated.owner, {
    type: "work-item",
    taskId: task.id,
    workItemId: item.id
  });
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
  const next = createWorkItem("work-item-2", task.id, {
    title: "Next edit",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, next);
  assert.throws(
    () => runTaskCommand(
      ["work", "dispatch", `${task.id}/${next.id}`],
      store,
      { now: () => new Date(NOW) }
    ),
    /work-item-2.*isolated|isolate.*work-item-2/i
  );

  const dirtyFile = join(isolatedEntry.path, "dirty.txt");
  writeFileSync(dirtyFile, "preserve\n");
  assert.equal(await preparer.cleanupWorkItemWorkspace(item.taskId, item.id, "integrated"), "dirty");
  assert.equal(existsSync(isolated.root), true);
  assert.deepEqual(store.getWorkItemWorkspace(task.id, item.id).owner, {
    type: "work-item",
    taskId: task.id,
    workItemId: item.id
  });
  unlinkSync(dirtyFile);
  assert.equal(await preparer.cleanupWorkItemWorkspace(item.taskId, item.id, "integrated"), "removed");
  assert.equal(existsSync(isolated.root), false);
  assert.equal(store.getWorkItemWorkspace(task.id, item.id), null);
  assert.equal(store.getRole(task.id, "worker").workspace, main);
  assert.equal(store.getWorkItem(task.id, item.id).workspaceDisposition, "integrated");
  assert.throws(() => execFileSync(
    "git",
    ["-C", repositoryPath, "show-ref", "--verify", "refs/heads/yui/task-1/work-item-1"],
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
  const item = createWorkItem("work-item-1", task.id, {
    title: "No-change review",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const isolated = await preparer.prepareWorkItemWorkspace(item.taskId, item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const yielded = yieldAgentRun(createAgentRun(
    "agent-run-1",
    task.id,
    "worker",
    "new",
    "Review without changes",
    NOW,
    { workItemId: item.id, workspace: isolated }
  ), "No changes required.", NOW);
  store.saveAgentRun(yielded);
  store.saveWorkItem(task.id, submitWorkItemCandidate(running, {
    summary: yielded.summary,
    source: { type: "run", runId: yielded.id },
    workspace: isolated
  }, NOW));
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
    .assertIntegrated(item.taskId, item.id);
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
  const item = createWorkItem("work-item-1", task.id, {
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

  await preparer.prepareWorkItemWorkspace(item.taskId, item.id);
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

  assert.equal(await preparer.cleanupWorkItemWorkspace(item.taskId, item.id, "integrated"), "removed");
  assert.equal(store.getRoleSession(task.id, "worker"), null);
});

test("an inactive never-started Claude placeholder does not block isolation or disturb the active Leader", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Isolate before Claude starts", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const claude = createConfiguredAgent("claude", "claude", "claude", [], [], NOW);
  const worker = store.getRole(task.id, "worker");
  store.transaction((tx) => {
    tx.saveConfiguredAgent(claude);
    tx.saveRole(task.id, updateRole(worker, {
      agentBindings: {
        ...worker.agentBindings,
        [claude.id]: createRoleAgentBinding(claude)
      }
    }, NOW));
  });

  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  let leaderSessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: "leader"
  }, "codex", NOW);
  leaderSessions = recordRoleAgentSession(leaderSessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "leader-main-session",
    policy: "fixed",
    status: "running"
  }, NOW);
  store.saveTaskRoleSessionSet(leaderSessions);
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: "worker"
  }, "codex", NOW);
  sessions = recordRoleAgentSession(sessions, {
    agentId: claude.id,
    adapterId: claude.adapterId,
    nativeSessionId: "aggregate-16-never-started-claude",
    policy: "fixed",
    status: "ready"
  }, NOW);
  // The aggregate-16 placeholder belongs to a configured but inactive Agent;
  // status correctly projects no active native Session or launch.
  sessions = { ...sessions, activeAgentId: "codex" };
  store.saveTaskRoleSessionSet(sessions);

  const status = runTaskCommand(["role", "status", task.id, "worker"], store, {
    now: () => new Date(NOW),
    runtime: {
      inspectTaskRolePanes: () => []
    },
    environment: {}
  });
  assert.equal(status.kind, "output");
  assert.equal(status.data.role.health, "idle");
  assert.equal(status.data.role.activeRun, null);
  assert.equal(status.data.role.activeWork, null);
  assert.equal(status.data.role.effectiveLaunch, null);
  assert.equal(status.data.role.nativeSession, null);
  assert.equal(status.data.role.tmux.state, "missing");
  assert.equal(status.data.role.freshLaunchAllowed, true);
  assert.equal(status.data.role.runSessionDrift, false);

  const item = createWorkItem("work-item-1", task.id, {
    title: "Start in an isolated workspace",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const stopped = [];
  const coordinator = new TaskWorkspaceCoordinator(store, preparer, {
    inspectTaskRolePanes() {
      return [];
    },
    async stopTaskRoleSessions(taskId, roles) {
      stopped.push([taskId, roles]);
    }
  });
  const isolated = await coordinator.isolateWorkItem(task.id, item.id);

  assert.equal(isolated.owner.type, "work-item");
  assert.equal(isolated.owner.workItemId, item.id);
  assert.deepEqual(stopped, []);
  const retired = store.getTaskRoleSessionSet(task.id, "worker");
  assert.deepEqual(retired.sessions, {});
  assert.deepEqual(retired.history.map(({ agentId, status: state }) => ({
    agentId, status: state
  })), [{ agentId: claude.id, status: "broken" }]);
  assert.ok(Object.hasOwn(store.getRole(task.id, "worker").agentBindings, claude.id));
  assert.equal(
    store.getRoleSession(task.id, "leader").nativeSessionId,
    "leader-main-session"
  );
  assert.equal(store.getRoleSession(task.id, "leader").status, "running");
});

test("a runless runtime launch reservation blocks isolation without retiring a never-started Claude placeholder", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Fence runless Role launch", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const claude = createConfiguredAgent("claude", "claude", "claude", [], [], NOW);
  const worker = store.getRole(task.id, "worker");
  store.transaction((tx) => {
    tx.saveConfiguredAgent(claude);
    tx.saveRole(task.id, updateRole(worker, {
      agentBindings: {
        ...worker.agentBindings,
        [claude.id]: createRoleAgentBinding(claude)
      }
    }, NOW));
  });
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: worker.name
  }, "codex", NOW);
  sessions = recordRoleAgentSession(sessions, {
    agentId: claude.id,
    adapterId: claude.adapterId,
    nativeSessionId: "aggregate-16-never-started-claude",
    policy: "fixed",
    status: "ready"
  }, NOW);
  sessions = { ...sessions, activeAgentId: "codex" };
  store.saveTaskRoleSessionSet(sessions);
  const before = structuredClone(sessions);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Do not migrate across a reserved launch",
    assignee: worker.name,
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const scheduler = new FileSchedulerStoreAdapter(store);
  const owner = { scope: "task", taskId: task.id, roleName: worker.name };
  scheduler.reserveRuntimeLaunch({
    owner,
    launchId: "runless-launch"
  }, () => {}, NOW);
  assert.equal(store.getActiveAgentRun(task.id, worker.name), null);
  assert.equal(store.getTaskRoleSessionSet(task.id, worker.name).inFlight, null);
  assert.equal(isRuntimeLaunchReservation(store.getWorkMailbox(
    runtimeLifecycleTarget(owner)
  )?.processing, "runless-launch"), true);
  let stopped = 0;
  const coordinator = new TaskWorkspaceCoordinator(store, preparer, {
    inspectTaskRolePanes: () => [],
    async stopTaskRoleSessions() { stopped += 1; }
  });

  await assert.rejects(
    coordinator.isolateWorkItem(task.id, item.id),
    /runtime lifecycle|launch reservation|unsettled/i
  );
  assert.equal(stopped, 0);
  assert.equal(store.getWorkItemWorkspace(task.id, item.id), null);
  assert.deepEqual(store.getTaskRoleSessionSet(task.id, worker.name), before);
  assert.equal(isRuntimeLaunchReservation(store.getWorkMailbox(
    runtimeLifecycleTarget(owner)
  )?.processing, "runless-launch"), true);
});

test("Leader can capture, integrate, and clean an isolated Role result before follow-up work", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Long-running Role delivery", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Implement the first increment",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const main = store.getTaskWorkspace(task.id).entries[0].path;
  const isolated = await preparer.prepareWorkItemWorkspace(item.taskId, item.id);
  writeFileSync(join(isolated.entries[0].path, "delivered.txt"), "first increment\n");
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  store.saveWorkItem(
    task.id,
    updateWorkItemStatus(running, "completed", NOW, "Implemented and tested.")
  );

  const capture = spawnSync(
    process.execPath,
    [
      join(process.cwd(), "dist", "cli.js"),
      "task", "work", "capture", `${task.id}/${item.id}`
    ],
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
    [
      join(process.cwd(), "dist", "cli.js"),
      "task", "work", "capture", `${task.id}/${item.id}`
    ],
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
    [
      join(process.cwd(), "dist", "cli.js"),
      "task", "work", "capture", `${task.id}/${item.id}`
    ],
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
      "task", "work", "cleanup", `${task.id}/${item.id}`, "--integrated"
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
    .assertIntegrated(item.taskId, item.id);
  assert.equal(proof.workItemId, item.id);
  assert.equal(proof.assignee, "worker");
  assert.equal(proof.workspace.root, isolated.root);
  assert.equal(proof.projects[0].headCommit, latestChangeSet.headCommit);
  assert.equal(proof.projects[0].changeSetId, latestChangeSet.id);

  const cleanup = spawnSync(
    process.execPath,
    [
      join(process.cwd(), "dist", "cli.js"),
      "task", "work", "cleanup", `${task.id}/${item.id}`, "--integrated"
    ],
    {
      encoding: "utf8",
      env: { ...process.env, YUI_HOME: home },
      timeout: 10_000
    }
  );
  assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.error?.message);
  assert.equal(existsSync(isolated.entries[0].path), false);
  assert.equal(store.getWorkItemWorkspace(task.id, item.id), null);

  const followUp = createWorkItem("work-item-2", task.id, {
    title: "Implement the follow-up increment",
    assignee: "worker",
    writeProjectIds: [project.id],
    dependsOn: [item.id]
  }, NOW);
  store.saveWorkItem(task.id, followUp);
  await preparer.prepareWorkItemWorkspace(followUp.taskId, followUp.id);
  assert.doesNotThrow(
    () => runTaskCommand(["work", "dispatch", `${task.id}/${followUp.id}`], store, {
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
  const item = createWorkItem("work-item-1", task.id, {
    title: "Commit before yielding",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const isolated = await preparer.prepareWorkItemWorkspace(item.taskId, item.id);
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
      "task", "work", "cleanup", `${task.id}/${item.id}`, "--integrated"
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
  assert.equal(store.getWorkItemWorkspace(task.id, item.id)?.owner.workItemId, item.id);
  assert.equal(store.listChangeSets(task.id).length, 0);
});

test("concurrent WorkItem capture persists one semantic ChangeSet", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Capture one durable result", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Commit once",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const isolated = await preparer.prepareWorkItemWorkspace(item.taskId, item.id);
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
    new WorkItemChangeSetManager(new FileTaskStore(home), () => new Date(NOW))
      .capture(item.taskId, item.id),
    new WorkItemChangeSetManager(new FileTaskStore(home), () => new Date(NOW))
      .capture(item.taskId, item.id)
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
  const item = createWorkItem("work-item-1", task.id, {
    title: "Revise before acceptance",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const isolated = await preparer.prepareWorkItemWorkspace(item.taskId, item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const candidateRun = yieldAgentRun(createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "worker",
    "new",
    "Prepare successive results.",
    NOW,
    { workItemId: item.id, workspace: isolated }
  ), "Candidate ready.", NOW);
  store.saveAgentRun(candidateRun);
  store.saveWorkItem(
    task.id,
    submitWorkItemCandidate(running, {
      summary: candidateRun.summary,
      source: { type: "run", runId: candidateRun.id },
      workspace: isolated
    }, NOW)
  );
  const manager = new WorkItemChangeSetManager(store, () => new Date(NOW));

  writeFileSync(join(isolated.entries[0].path, "reviewed.txt"), "round one\n");
  const [first] = await manager.capture(item.taskId, item.id);
  assert.notEqual(first, undefined);
  assert.equal((await manager.capture(item.taskId, item.id))[0].id, first.id);

  writeFileSync(join(isolated.entries[0].path, "reviewed.txt"), "round two\n");
  const [second] = await manager.capture(item.taskId, item.id);
  assert.notEqual(second, undefined);
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.headCommit, first.headCommit);
  assert.ok(Date.parse(second.createdAt) > Date.parse(first.createdAt));
  assert.equal(store.listChangeSets(task.id).length, 2);
  await assert.rejects(manager.assertIntegrated(item.taskId, item.id), new RegExp(second.id));
});

test("WorkItem cleanup validates its disposition before removing the worktree", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Disposition safety", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Parallel edit",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const isolated = await preparer.prepareWorkItemWorkspace(item.taskId, item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const completed = updateWorkItemStatus(running, "completed", NOW, "Integrated.");
  store.saveWorkItem(task.id, completed);
  store.saveWorkItem(
    task.id,
    recordWorkItemWorkspaceDisposition(completed, "integrated", NOW)
  );

  await assert.rejects(
    preparer.cleanupWorkItemWorkspace(item.taskId, item.id, "abandoned"),
    /already recorded as integrated/i
  );
  assert.equal(existsSync(isolated.entries[0].path), true);
  assert.notEqual(store.getWorkItemWorkspace(task.id, item.id), null);
});

test("WorkItem cleanup reports a post-removal race and converges on retry", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Cleanup retry", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Remove an isolated result",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const setup = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await setup.prepareTaskWorkspace(task.id);
  await setup.prepareWorkItemWorkspace(item.taskId, item.id);
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
    preparer.cleanupWorkItemWorkspace(item.taskId, item.id, "integrated"),
    /worktree was removed.*durable cleanup was not recorded.*retry/i
  );
  assert.notEqual(store.getWorkItemWorkspace(task.id, item.id), null);
  assert.equal(store.getWorkItem(task.id, item.id).workspaceDisposition, undefined);

  const coordinator = new TaskWorkspaceCoordinator(store, preparer, {
    async stopTaskRoleSessions() {
      const sessions = store.getTaskRoleSessionSet(task.id, "worker");
      store.saveTaskRoleSessionSet(
        updateRoleAgentSessionStatus(sessions, "codex", "stopped", NOW)
      );
    }
  });
  assert.equal(await coordinator.cleanupWorkItem(item.taskId, item.id, "integrated"), "missing");
  assert.equal(store.getWorkItemWorkspace(task.id, item.id), null);
  assert.equal(store.getWorkItem(task.id, item.id).workspaceDisposition, "integrated");
});

test("WorkItem cleanup cannot commit across a newly prepared in-flight Role run", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Cleanup in-flight fence", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Remove after run settles",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const setup = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await setup.prepareTaskWorkspace(task.id);
  await setup.prepareWorkItemWorkspace(item.taskId, item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  store.saveWorkItem(task.id, updateWorkItemStatus(
    running,
    "completed",
    NOW,
    "Ready for cleanup."
  ));
  const racingRun = createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "worker",
    "new",
    "Prepared during cleanup",
    NOW
  );
  store.saveAgentRun(racingRun);

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
        runId: racingRun.id,
        receiptId: `agent-run:${task.id}/${racingRun.id}`
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
    preparer.cleanupWorkItemWorkspace(item.taskId, item.id, "integrated"),
    /worktree was removed.*durable cleanup was not recorded.*retry/i
  );
  assert.notEqual(store.getWorkItemWorkspace(task.id, item.id), null);
  assert.equal(store.getWorkItem(task.id, item.id).workspaceDisposition, undefined);
  assert.equal(
    store.getTaskRoleSessionSet(task.id, "worker").inFlight.runId,
    racingRun.id
  );
});

test("late WorkItem cleanup preserves a replacement workspace owned by newer work", async (t) => {
  const { root, home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Cleanup workspace CAS", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const first = createWorkItem("work-item-1", task.id, {
    title: "Old isolated work",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  const second = createWorkItem("work-item-2", task.id, {
    title: "New isolated work",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, first);
  store.saveWorkItem(task.id, second);
  const setup = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await setup.prepareTaskWorkspace(task.id);
  const oldWorkspace = await setup.prepareWorkItemWorkspace(first.taskId, first.id);
  const running = updateWorkItemStatus(first, "running", NOW);
  store.saveWorkItem(task.id, running);
  store.saveWorkItem(task.id, updateWorkItemStatus(
    running,
    "completed",
    NOW,
    "Ready for cleanup."
  ));
  const replacement = createManagedWorkspace({
    owner: { type: "work-item", taskId: task.id, workItemId: second.id },
    root: join(root, "replacement"),
    entries: [{
      ...oldWorkspace.entries[0],
      path: join(root, "replacement-worktree"),
      branch: "yui/task-1/work-item-2"
    }]
  }, new Date(NOW.getTime() + 1));

  const racingGit = {
    async inspectWorktree() {
      return "missing";
    },
    async removeWorktree() {
      store.transaction((tx) => {
        tx.saveManagedWorkspace(replacement);
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
    await preparer.cleanupWorkItemWorkspace(first.taskId, first.id, "integrated"),
    "removed"
  );
  assert.deepEqual(store.getWorkItemWorkspace(task.id, second.id), replacement);
  assert.equal(store.getRole(task.id, "worker").workspace, store.getTaskWorkspace(task.id).root);
  assert.equal(store.getWorkItem(task.id, first.id).workspaceDisposition, "integrated");
});

test("WorkItem cleanup cannot record a disposition without an isolated worktree", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "No isolation", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = updateWorkItemStatus(createWorkItem("work-item-1", task.id, {
    title: "Shared work",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW), "completed", NOW, "Done in main.");
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);

  await assert.rejects(
    preparer.cleanupWorkItemWorkspace(item.taskId, item.id, "integrated"),
    /no managed isolated worktree/i
  );
  assert.equal(store.getWorkItem(task.id, item.id).workspaceDisposition, undefined);

  store.saveWorkItem(task.id, recordWorkItemWorkspaceDisposition(item, "integrated", NOW));
  assert.equal(await preparer.cleanupWorkItemWorkspace(item.taskId, item.id, "integrated"), "missing");
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
  const mainEntry = store.getTaskWorkspace(active.id).entries[0];
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

test("Task retirement preflight is read-only and fails closed on dirty managed state", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Retire only when safe", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const item = submitWorkItemCandidate(updateWorkItemStatus(createWorkItem(
    "work-item-1",
    task.id,
    { title: "Preserve this result", writeProjectIds: [project.id] },
    NOW
  ), "running", NOW), {
    summary: "Candidate evidence",
    source: { type: "direct" }
  }, NOW);
  store.saveWorkItem(task.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const workspace = await preparer.prepareTaskWorkspace(task.id);
  const dirtyPath = join(workspace.path, project.name, "retirement-dirty.txt");
  writeFileSync(dirtyPath, "must survive\n");
  const before = {
    task: store.getTask(task.id),
    item: store.getWorkItem(task.id, item.id),
    events: store.listEvents(task.id),
    workspaces: store.listManagedWorkspaces(task.id)
  };

  await assert.rejects(
    new WorkItemChangeSetManager(store).assertRetirable(task.id),
    /retirement workspace is not clean/i
  );

  assert.deepEqual(store.getTask(task.id), before.task);
  assert.deepEqual(store.getWorkItem(task.id, item.id), before.item);
  assert.deepEqual(store.listEvents(task.id), before.events);
  assert.deepEqual(store.listManagedWorkspaces(task.id), before.workspaces);
  assert.equal(existsSync(dirtyPath), true);
});

test("Task retirement settles the aggregate but preserves Candidate, Git, Integration, Session, and workspace history", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Retire stale aggregate", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const main = await preparer.prepareTaskWorkspace(task.id);
  const workspace = store.getTaskWorkspace(task.id);
  const entry = workspace.entries[0];
  writeFileSync(join(entry.path, "retirement-proof.txt"), "captured evidence\n");
  execFileSync("git", ["-C", entry.path, "add", "retirement-proof.txt"]);
  execFileSync("git", ["-C", entry.path, "commit", "-qm", "retirement proof"]);
  const head = execFileSync("git", ["-C", entry.path, "rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();

  const item = submitWorkItemCandidate(updateWorkItemStatus(createWorkItem(
    "work-item-1",
    task.id,
    { title: "Historical candidate", writeProjectIds: [project.id] },
    NOW
  ), "running", NOW), {
    summary: "Keep this candidate verbatim",
    source: { type: "direct" }
  }, NOW);
  const changeSet = createWorkItemChangeSet({
    id: "change-set-1",
    taskId: task.id,
    workItemId: item.id,
    projectId: project.id,
    baseCommit: entry.baseCommit,
    headCommit: head,
    branch: entry.branch,
    changedPaths: ["retirement-proof.txt"]
  }, NOW);
  const integration = updateIntegrationAttempt(createIntegrationAttempt({
    id: "integration-1",
    taskId: task.id,
    projectId: project.id,
    targetRef: entry.branch,
    expectedHead: entry.baseCommit,
    changeSetIds: [changeSet.id]
  }, NOW), {
    status: "committed",
    candidateCommit: head
  }, NOW);
  const historicalRun = yieldAgentRun(createAgentRun(
    "agent-run-1",
    task.id,
    "leader",
    "new",
    "Historical input owner.",
    NOW
  ), "Historical input owner settled.", NOW);
  const input = createInputRequest(
    "input-1",
    task.id,
    {
      taskId: task.id,
      roleName: "leader",
      agentId: "codex",
      runId: historicalRun.id,
      nativeSessionId: "native-history"
    },
    {
      question: "Still continue?",
      choices: [{ key: "yes", label: "Continue" }],
      blockedRefs: [{ type: "work-item", taskId: task.id, id: item.id }]
    },
    NOW
  );
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: "worker"
  }, "codex", NOW);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "native-history",
    policy: "fixed",
    status: "ready"
  }, NOW);
  store.transaction((tx) => {
    tx.saveAgentRun(historicalRun);
    tx.saveWorkItem(task.id, item);
    tx.saveChangeSet(task.id, changeSet);
    tx.saveIntegrationAttempt(task.id, integration);
    tx.saveInputRequest(task.id, input);
    tx.saveTaskRoleSessionSet(sessions);
  });
  const workspacesBefore = store.listManagedWorkspaces(task.id);
  const sessionsBefore = store.getTaskRoleSessionSet(task.id, "worker");
  const proof = await new WorkItemChangeSetManager(store).assertRetirable(task.id);

  const result = runTaskCommand([
    "retire", task.id, "--summary", "The intent is no longer current."
  ], store, {
    now: () => new Date(NOW),
    taskRetirementProof: proof,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  });

  assert.equal(result.kind, "output");
  assert.equal(store.getTask(task.id).status, "retired");
  assert.equal(store.getTask(task.id).retirementSummary, "The intent is no longer current.");
  assert.equal(store.getWorkItem(task.id, item.id).status, "retired");
  assert.equal(store.getWorkItem(task.id, item.id).candidates[0].summary, "Keep this candidate verbatim");
  assert.deepEqual(store.listChangeSets(task.id), [changeSet]);
  assert.deepEqual(store.listIntegrationAttempts(task.id), [integration]);
  assert.equal(store.getInputRequest(task.id, input.id).status, "cancelled");
  assert.deepEqual(store.getTaskRoleSessionSet(task.id, "worker"), sessionsBefore);
  assert.equal(store.getWorkMailbox({
    kind: "role-runtime",
    taskId: task.id,
    roleName: "worker"
  }), null);
  assert.deepEqual(store.listManagedWorkspaces(task.id), workspacesBefore);
  assert.equal(store.getTask(task.id).cwd, main.path);
  assert.equal(existsSync(entry.path), true);
  assert.equal(store.listEvents(task.id).at(-1).type, "task.retired");
});

test("Task archive cleanup disposes a retained terminal WorkItem and preserves its record", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const active = activateTask(createTask("task-1", "Archive isolated work", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, active, repositoryPath);
  const item = createWorkItem("work-item-1", active.id, {
    title: "Isolated edit",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(active.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const main = (await preparer.prepareTaskWorkspace(active.id)).path;
  const isolated = await preparer.prepareWorkItemWorkspace(item.taskId, item.id);
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

  const stopped = [];
  const coordinator = new TaskWorkspaceCoordinator(store, preparer, {
    async stopTaskRoleSessions(taskId, roles) {
      stopped.push([taskId, roles]);
    }
  });
  assert.equal((await coordinator.cleanupTaskForArchive(active.id, "integrated")).status, "removed");
  runTaskCommand(["archive", active.id, "--integrated"], store, { now: () => new Date(NOW) });
  assert.equal(store.getTask(active.id).status, "archived");
  assert.equal(store.getWorkItem(active.id, item.id).workspaceDisposition, "integrated");
  assert.equal(existsSync(main), false);
  assert.equal(existsSync(isolated.entries[0].path), false);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0][0], active.id);
  assert.deepEqual(new Set(stopped[0][1]), new Set(["leader", "worker"]));
});

test("Task archive cleanup stops when the terminal Task is concurrently reopened", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const active = activateTask(createTask("task-1", "Reopen during cleanup", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  addTaskRoles(store, active, repositoryPath);
  const item = createWorkItem("work-item-1", active.id, {
    title: "Retained result",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(active.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const main = (await preparer.prepareTaskWorkspace(active.id)).path;
  const isolated = await preparer.prepareWorkItemWorkspace(item.taskId, item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(active.id, running);
  store.saveWorkItem(active.id, updateWorkItemStatus(
    running,
    "completed",
    NOW,
    "Ready for archive."
  ));
  store.saveTask(completeTask(store.getTask(active.id), NOW, {
    summary: "Initially complete",
    by: "user"
  }));
  const workspacesBefore = store.listManagedWorkspaces(active.id);

  const coordinator = new TaskWorkspaceCoordinator(store, preparer, {
    async stopTaskRoleSessions() {
      runTaskCommand(["reopen", active.id], store, {
        now: () => new Date(NOW.getTime() + 1_000),
        environment: {}
      });
    }
  });
  const result = await coordinator.cleanupTaskForArchive(active.id, "integrated");

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "task-changed");
  assert.equal(result.resource, `task:${active.id}`);
  assert.equal(result.retryable, true);
  assert.equal(store.getTask(active.id).status, "active");
  assert.equal(store.getTask(active.id).cwd, main);
  assert.deepEqual(store.listManagedWorkspaces(active.id), workspacesBefore);
  assert.equal(store.getWorkItem(active.id, item.id).workspaceDisposition, undefined);
  assert.equal(existsSync(main), true);
  assert.equal(existsSync(isolated.entries[0].path), true);
});

test("Task abandon archives a completed WorkItem without inventing Integration", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const active = activateTask(createTask("task-1", "Abandon isolated work", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, active, repositoryPath);
  const item = createWorkItem("work-item-1", active.id, {
    title: "Discarded edit",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(active.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(active.id);
  const isolated = await preparer.prepareWorkItemWorkspace(item.taskId, item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(active.id, running);
  store.saveWorkItem(active.id, updateWorkItemStatus(
    running,
    "completed",
    NOW,
    "Result deliberately discarded."
  ));
  store.saveTask(completeTask(store.getTask(active.id), NOW, {
    summary: "No delivery retained",
    by: "user"
  }));

  const coordinator = new TaskWorkspaceCoordinator(store, preparer, {
    async stopTaskRoleSessions() {}
  });
  assert.equal((await coordinator.cleanupTaskForArchive(active.id, "abandoned")).status, "removed");
  runTaskCommand(["archive", active.id, "--abandon"], store, { now: () => new Date(NOW) });
  assert.equal(store.getTask(active.id).status, "archived");
  assert.equal(store.getWorkItem(active.id, item.id).workspaceDisposition, "abandoned");
  assert.equal(existsSync(isolated.entries[0].path), false);
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

test("a Task-final ReviewRound worktree starts at its frozen integrated head", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Review the integrated Task", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath, ["leader", "reviewer"]);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const taskWorkspace = store.getTaskWorkspace(task.id);
  const taskMainEntry = taskWorkspace.entries[0];
  const taskMainCommit = git(["-C", taskMainEntry.path, "rev-parse", "HEAD"]).trim();

  const item = createWorkItem("work-item-1", task.id, {
    title: "Leader-direct metadata",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const contract = createTaskFinalReviewContract({
    taskId: task.id,
    reviewerRoleName: "reviewer",
    controlPlaneDigest: "a".repeat(64)
  });
  const submitted = submitWorkItemCandidate(running, {
    summary: "metadata-only Candidate",
    source: { type: "direct" },
    reviewPolicy: { roleName: "reviewer", trigger: "final" },
    taskFinalReviewContract: contract
  }, NOW);
  store.saveWorkItem(task.id, submitted);

  writeFileSync(join(repositoryPath, "integrated.txt"), "integrated head\n");
  git(["-C", repositoryPath, "add", "integrated.txt"]);
  git(["-C", repositoryPath, "commit", "-qm", "integrated head"]);
  const integratedCommit = git(["-C", repositoryPath, "rev-parse", "HEAD"]).trim();
  assert.notEqual(integratedCommit, taskMainCommit);

  const candidate = submitted.candidates[0];
  const round = createTaskReviewRound(
    "review-round-1",
    task.id,
    item.id,
    candidate.id,
    "reviewer",
    "policy",
    {
      schemaVersion: 1,
      projects: [{ projectId: project.id, commit: integratedCommit }]
    },
    NOW,
    contract
  );
  store.saveReviewRound(task.id, round);

  const reviewWorkspace = await preparer.prepareReviewRoundWorkspace(task.id, round.id);
  const reviewEntry = reviewWorkspace.entries[0];
  assert.equal(candidate.workspace, undefined);
  assert.equal(reviewEntry.baseCommit, integratedCommit);
  assert.equal(git(["-C", reviewEntry.path, "rev-parse", "HEAD"]).trim(), integratedCommit);
  assert.equal(readFileSync(join(reviewEntry.path, "integrated.txt"), "utf8"), "integrated head\n");
  assert.equal(
    git(["-C", taskMainEntry.path, "rev-parse", "HEAD"]).trim(),
    taskMainCommit
  );
});

test("a reviewer launches from a fresh ReviewRound workspace frozen from the Candidate", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Review an isolated candidate", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(agent)],
      agent.id,
      workspace,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "leader" }
    });
    tx.saveTask(task);
    for (const name of ["leader", "worker"]) {
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
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Review the isolated result",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const isolated = await preparer.prepareWorkItemWorkspace(task.id, item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const candidateRun = yieldAgentRun(createAgentRun(
    "agent-run-1",
    task.id,
    "worker",
    "new",
    "Produce an isolated candidate.",
    NOW,
    { workItemId: item.id, workspace: isolated }
  ), "Candidate ready.", NOW);
  store.saveAgentRun(candidateRun);
  store.saveWorkItem(task.id, submitWorkItemCandidate(running, {
    summary: candidateRun.summary,
    source: { type: "run", runId: candidateRun.id },
    reviewPolicy: { roleName: "reviewer", trigger: "leader" },
    workspace: isolated,
    gitSnapshot: await preparer.snapshotCandidateWorkspace(isolated)
  }, NOW));

  runTaskCommand(["work", "review", item.id], store, {
    now: () => new Date(NOW),
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  });

  const round = store.listReviewRounds(task.id)[0];
  assert.equal(round.status, "pending");
  await preparer.prepareReviewRoundWorkspace(task.id, round.id);
  const reviewRun = dispatchPreparedReviewRound(task.id, round.id, store, {
    now: () => new Date(NOW)
  });
  assert.notEqual(reviewRun.workspace.root, isolated.root);
  assert.equal(reviewRun.workspace.owner.type, "review-round");
  assert.equal(reviewRun.workspace.owner.taskId, task.id);
  assert.equal(reviewRun.workspace.entries.every(({ access }) => access === "write"), true);
  const plan = new FileRoleLaunchPlanner(home, store, {
    cliPath: "/dist/cli.js"
  }).plan({
    taskId: task.id,
    roleName: "reviewer",
    agentId: agent.id,
    adapterId: agent.adapterId,
    effective: reviewRun.effective,
    mode: "new"
  });
  assert.equal(plan.role.workspace, reviewRun.workspace.root);
  assert.equal(plan.launch.env.YUI_WORKSPACE, reviewRun.workspace.root);
});

test("public review delivery binds the physical ReviewRound workspace before notification", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Review before delivery", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  const agent = addTaskRoles(store, task, repositoryPath);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(agent)],
      agent.id,
      workspace,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "leader" }
    });
  });
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Review the physical handoff",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const develop = await preparer.prepareWorkItemWorkspace(task.id, item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const candidateRun = yieldAgentRun(createAgentRun(
    "agent-run-1",
    task.id,
    "worker",
    "new",
    "Produce a candidate.",
    NOW,
    { workItemId: item.id, workspace: develop }
  ), "Candidate ready.", NOW);
  store.saveAgentRun(candidateRun);
  store.saveWorkItem(task.id, submitWorkItemCandidate(running, {
    summary: candidateRun.summary,
    source: { type: "run", runId: candidateRun.id },
    reviewPolicy: { roleName: "reviewer", trigger: "leader" },
    workspace: develop,
    gitSnapshot: await preparer.snapshotCandidateWorkspace(develop)
  }, NOW));
  const result = spawnExactTaskCli(
    home,
    store,
    task.id,
    "leader",
    ["task", "work", "review", item.id]
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const round = store.listReviewRounds(task.id)[0];
  const reviewRun = store.getActiveAgentRun(task.id, "reviewer");
  assert.equal(round.status, "running");
  assert.equal(reviewRun.deliveredAt, undefined);
  assert.equal(
    reviewRun.workspace.root,
    join(workspace, "tasks", task.id, "reviews", round.id)
  );
  assert.equal(store.getReviewRoundWorkspace(task.id, round.id).root, reviewRun.workspace.root);
  assert.equal(existsSync(reviewRun.workspace.root), true);
  assert.match(reviewRun.input, new RegExp(reviewRun.workspace.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const reviewMailbox = store.getWorkMailbox({
    kind: "role",
    taskId: task.id,
    roleName: "reviewer"
  });
  const queuedRefs = reviewMailbox.pending?.refs
    ?? reviewMailbox.processing?.batch.refs
    ?? [];
  assert.equal(queuedRefs.some((ref) => ref.type === "run" && ref.id === reviewRun.id), true);

  const frozenReviewBase = store.getReviewRoundWorkspace(task.id, round.id)
    .entries[0].baseCommit;
  const diagnosticPath = join(reviewRun.workspace.entries[0].path, "review-diagnostic.txt");
  writeFileSync(diagnosticPath, "diagnostic evidence\n");
  execFileSync("git", ["-C", reviewRun.workspace.entries[0].path, "add", "review-diagnostic.txt"]);
  execFileSync("git", [
    "-C", reviewRun.workspace.entries[0].path,
    "commit", "-qm", "review diagnostic evidence"
  ]);

  const contextAfterDiagnostic = spawnExactTaskCli(
    home,
    store,
    task.id,
    "leader",
    ["task", "show", task.id]
  );
  assert.equal(
    contextAfterDiagnostic.status,
    0,
    contextAfterDiagnostic.stderr || contextAfterDiagnostic.stdout
  );
  assert.equal(
    store.getReviewRoundWorkspace(task.id, round.id).entries[0].baseCommit,
    frozenReviewBase
  );
  const captureAfterDiagnostic = spawnExactTaskCli(
    home,
    store,
    task.id,
    "leader",
    ["task", "work", "capture", item.id]
  );
  assert.equal(captureAfterDiagnostic.status, 0, captureAfterDiagnostic.stderr);
  assert.match(captureAfterDiagnostic.stdout, /no changes to capture/i);
  assert.equal(store.listChangeSets(task.id).length, 0);

  // A reviewer may add diagnostic descendants, but an unrelated branch
  // rewrite must fail closed rather than silently rebinding the ReviewRound.
  const unrelatedBranch = "yui-review-unrelated";
  execFileSync("git", ["-C", reviewRun.workspace.entries[0].path, "checkout", "--orphan", unrelatedBranch]);
  writeFileSync(
    join(reviewRun.workspace.entries[0].path, "unrelated-review-rewrite.txt"),
    "unrelated review rewrite\n"
  );
  execFileSync("git", ["-C", reviewRun.workspace.entries[0].path, "add", "--all"]);
  execFileSync("git", [
    "-C", reviewRun.workspace.entries[0].path,
    "commit", "-qm", "unrelated review rewrite"
  ]);
  const identity = worktreeIdentity(task.id, round.id);
  execFileSync("git", [
    "-C", reviewRun.workspace.entries[0].path,
    "branch", "-f", identity.branch, "HEAD"
  ]);
  execFileSync("git", ["-C", reviewRun.workspace.entries[0].path, "checkout", "-q", identity.branch]);
  execFileSync("git", ["-C", reviewRun.workspace.entries[0].path, "branch", "-D", unrelatedBranch]);
  await assert.rejects(
    preparer.snapshotReviewRoundResult(task.id, round.id),
    /does not descend from its frozen base/i
  );
});

test("ReviewRound preparation rejects a stale deterministic branch instead of relabelling it", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Reject stale review worktree", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  const agent = addTaskRoles(store, task, repositoryPath);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(agent)],
      agent.id,
      workspace,
      NOW
    ));
    tx.saveConfig({ ...tx.getConfig(), review: { roleName: "reviewer", trigger: "leader" } });
  });
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Review a frozen candidate",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const develop = await preparer.prepareWorkItemWorkspace(task.id, item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const candidateRun = yieldAgentRun(createAgentRun(
    "agent-run-1",
    task.id,
    "worker",
    "new",
    "Prepare a frozen candidate.",
    NOW,
    { workItemId: item.id, workspace: develop }
  ), "Candidate ready.", NOW);
  store.saveAgentRun(candidateRun);
  store.saveWorkItem(task.id, submitWorkItemCandidate(running, {
    summary: candidateRun.summary,
    source: { type: "run", runId: candidateRun.id },
    reviewPolicy: { roleName: "reviewer", trigger: "leader" },
    workspace: develop,
    gitSnapshot: await preparer.snapshotCandidateWorkspace(develop)
  }, NOW));

  runTaskCommand(["work", "review", item.id], store, {
    now: () => new Date(NOW),
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  });
  const round = store.listReviewRounds(task.id)[0];
  assert.equal(round.status, "pending");
  const placeholder = store.getReviewRoundWorkspace(task.id, round.id);
  assert.equal(placeholder, null);

  writeFileSync(join(repositoryPath, "stale-review.txt"), "stale branch\n");
  execFileSync("git", ["-C", repositoryPath, "add", "stale-review.txt"]);
  execFileSync("git", ["-C", repositoryPath, "commit", "-qm", "stale review branch"]);
  const identity = worktreeIdentity(task.id, round.id);
  const stalePath = join(workspace, "worktree", project.name, identity.directory);
  mkdirSync(join(stalePath, ".."), { recursive: true });
  execFileSync("git", [
    "-C", repositoryPath,
    "worktree", "add", "-b", identity.branch,
    stalePath,
    "HEAD"
  ], { stdio: "ignore" });

  await assert.rejects(
    preparer.prepareReviewRoundWorkspace(task.id, round.id),
    /ReviewRound workspace baseCommit mismatch/i
  );
  assert.equal(store.getReviewRoundWorkspace(task.id, round.id), null);
  assert.equal(existsSync(stalePath), false);
  assert.throws(() => execFileSync(
    "git",
    ["-C", repositoryPath, "show-ref", "--verify", `refs/heads/${identity.branch}`],
    { stdio: "ignore" }
  ));
});

test("multi-Project ReviewRound preparation discards earlier worktrees when a later Project fails", async (t) => {
  const { root, home, workspace, repositoryPath, store } = fixture(t);
  const firstProject = await addProject(store, repositoryPath);
  const secondRepositoryPath = join(root, "frontend");
  execFileSync("git", ["init", "-q", secondRepositoryPath]);
  execFileSync("git", ["-C", secondRepositoryPath, "config", "user.name", "Yui Test"]);
  execFileSync("git", ["-C", secondRepositoryPath, "config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(secondRepositoryPath, "tracked.txt"), "frontend\n");
  execFileSync("git", ["-C", secondRepositoryPath, "add", "tracked.txt"]);
  execFileSync("git", ["-C", secondRepositoryPath, "commit", "-qm", "initial"]);
  await runProjectCommand([
    "add", "Frontend", secondRepositoryPath,
    "--remote", "git@example.invalid:frontend.git",
    "--stable", "HEAD",
    "--development", "HEAD"
  ], store, { now: () => new Date(NOW) });
  const secondProject = store.listProjects().find(({ name }) => name === "Frontend");
  assert.notEqual(secondProject, undefined);
  const task = activateTask(createTask("task-1", "Review two Projects", NOW, {
    projectBindings: [
      {
        projectId: firstProject.id,
        directory: firstProject.name,
        baseRef: firstProject.developmentBranch
      },
      {
        projectId: secondProject.id,
        directory: secondProject.name,
        baseRef: secondProject.developmentBranch
      }
    ]
  }), NOW);
  const agent = addTaskRoles(store, task, repositoryPath);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(agent)],
      agent.id,
      workspace,
      NOW
    ));
    tx.saveConfig({ ...tx.getConfig(), review: { roleName: "reviewer", trigger: "leader" } });
  });
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Review both Project results",
    assignee: "worker",
    writeProjectIds: [firstProject.id, secondProject.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const develop = await preparer.prepareWorkItemWorkspace(task.id, item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const candidateRun = yieldAgentRun(createAgentRun(
    "agent-run-1",
    task.id,
    "worker",
    "new",
    "Prepare a two-Project candidate.",
    NOW,
    { workItemId: item.id, workspace: develop }
  ), "Candidate ready.", NOW);
  store.saveAgentRun(candidateRun);
  store.saveWorkItem(task.id, submitWorkItemCandidate(running, {
    summary: candidateRun.summary,
    source: { type: "run", runId: candidateRun.id },
    reviewPolicy: { roleName: "reviewer", trigger: "leader" },
    workspace: develop,
    gitSnapshot: await preparer.snapshotCandidateWorkspace(develop)
  }, NOW));
  runTaskCommand(["work", "review", item.id], store, {
    now: () => new Date(NOW),
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  });
  const round = store.listReviewRounds(task.id)[0];
  const placeholder = store.getReviewRoundWorkspace(task.id, round.id);
  assert.equal(placeholder, null);

  const realGit = new NodeGitWorkspace();
  let ensureCalls = 0;
  const failingGit = {
    inspect: (...args) => realGit.inspect(...args),
    ensureWorktree: async (input) => {
      ensureCalls += 1;
      if (ensureCalls === 2) throw new Error("synthetic later Project failure");
      return realGit.ensureWorktree(input);
    },
    removeWorktree: (input) => realGit.removeWorktree(input)
  };
  const failingPreparer = new FileTaskWorkspacePreparer(
    home,
    store,
    failingGit,
    () => new Date(NOW)
  );
  await assert.rejects(
    failingPreparer.prepareReviewRoundWorkspace(task.id, round.id),
    /synthetic later Project failure/
  );
  assert.equal(ensureCalls, 2);
  const firstPhysical = join(
    workspace,
    "worktree",
    firstProject.name,
    task.id,
    round.id
  );
  const secondPhysical = join(
    workspace,
    "worktree",
    secondProject.name,
    task.id,
    round.id
  );
  assert.equal(existsSync(firstPhysical), false);
  assert.equal(existsSync(secondPhysical), false);
  assert.throws(() => execFileSync(
    "git",
    ["-C", repositoryPath, "show-ref", "--verify", `refs/heads/yui/task-1/${round.id}`],
    { stdio: "ignore" }
  ));
  assert.throws(() => execFileSync(
    "git",
    ["-C", secondRepositoryPath, "show-ref", "--verify", `refs/heads/yui/task-1/${round.id}`],
    { stdio: "ignore" }
  ));
  assert.equal(store.getReviewRoundWorkspace(task.id, round.id), null);
});

test("multi-Project ReviewRound recovery preserves diagnostic descendants while recreating missing entries", async (t) => {
  const { root, home, workspace, repositoryPath, store } = fixture(t);
  const firstProject = await addProject(store, repositoryPath);
  const secondRepositoryPath = join(root, "frontend");
  execFileSync("git", ["init", "-q", secondRepositoryPath]);
  execFileSync("git", ["-C", secondRepositoryPath, "config", "user.name", "Yui Test"]);
  execFileSync("git", ["-C", secondRepositoryPath, "config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(secondRepositoryPath, "tracked.txt"), "frontend\n");
  execFileSync("git", ["-C", secondRepositoryPath, "add", "tracked.txt"]);
  execFileSync("git", ["-C", secondRepositoryPath, "commit", "-qm", "initial"]);
  await runProjectCommand([
    "add", "Frontend", secondRepositoryPath,
    "--remote", "git@example.invalid:frontend.git",
    "--stable", "HEAD",
    "--development", "HEAD"
  ], store, { now: () => new Date(NOW) });
  const secondProject = store.listProjects().find(({ name }) => name === "Frontend");
  assert.notEqual(secondProject, undefined);
  const task = activateTask(createTask("task-1", "Recover ReviewRound entries", NOW, {
    projectBindings: [
      {
        projectId: firstProject.id,
        directory: firstProject.name,
        baseRef: firstProject.developmentBranch
      },
      {
        projectId: secondProject.id,
        directory: secondProject.name,
        baseRef: secondProject.developmentBranch
      }
    ]
  }), NOW);
  const agent = addTaskRoles(store, task, repositoryPath);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(agent)],
      agent.id,
      workspace,
      NOW
    ));
    tx.saveConfig({ ...tx.getConfig(), review: { roleName: "reviewer", trigger: "leader" } });
  });
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Recover both Project review worktrees",
    assignee: "worker",
    writeProjectIds: [firstProject.id, secondProject.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const develop = await preparer.prepareWorkItemWorkspace(task.id, item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const candidateRun = yieldAgentRun(createAgentRun(
    "agent-run-1",
    task.id,
    "worker",
    "new",
    "Prepare a recoverable two-Project candidate.",
    NOW,
    { workItemId: item.id, workspace: develop }
  ), "Candidate ready.", NOW);
  store.saveAgentRun(candidateRun);
  store.saveWorkItem(task.id, submitWorkItemCandidate(running, {
    summary: candidateRun.summary,
    source: { type: "run", runId: candidateRun.id },
    reviewPolicy: { roleName: "reviewer", trigger: "leader" },
    workspace: develop,
    gitSnapshot: await preparer.snapshotCandidateWorkspace(develop)
  }, NOW));
  runTaskCommand(["work", "review", item.id], store, {
    now: () => new Date(NOW),
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  });
  const round = store.listReviewRounds(task.id)[0];
  const adopted = await preparer.prepareReviewRoundWorkspace(task.id, round.id);
  const frozenByProject = new Map(
    adopted.entries.map((entry) => [entry.projectId, entry.baseCommit])
  );
  const retained = adopted.entries.find(({ projectId }) => projectId === firstProject.id);
  const missing = adopted.entries.find(({ projectId }) => projectId === secondProject.id);
  assert.notEqual(retained, undefined);
  assert.notEqual(missing, undefined);

  writeFileSync(join(retained.path, "review-diagnostic.txt"), "diagnostic descendant\n");
  execFileSync("git", ["-C", retained.path, "add", "review-diagnostic.txt"]);
  execFileSync("git", ["-C", retained.path, "commit", "-qm", "review diagnostic descendant"]);
  const diagnosticHead = execFileSync(
    "git", ["-C", retained.path, "rev-parse", "HEAD"], { encoding: "utf8" }
  ).trim();
  const removed = await new NodeGitWorkspace().removeWorktree({
    repositoryPath: secondProject.path,
    container: join(workspace, "worktree", secondProject.name),
    taskId: task.id,
    roleName: round.id
  });
  assert.equal(removed, "removed");
  assert.equal(existsSync(missing.path), false);

  const repaired = await preparer.prepareReviewRoundWorkspace(task.id, round.id);
  assert.equal(existsSync(missing.path), true);
  assert.equal(
    execFileSync("git", ["-C", retained.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    diagnosticHead
  );
  assert.deepEqual(
    new Map(repaired.entries.map((entry) => [entry.projectId, entry.baseCommit])),
    frozenByProject
  );
  for (const entry of repaired.entries) {
    assert.equal(
      realpathSync(join(repaired.root, entry.directory)),
      entry.path
    );
  }
});

test("public terminal ReviewRound cleanup removes its clean workspace", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Review cleanup", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  const agent = addTaskRoles(
    store,
    task,
    repositoryPath,
    ["leader", "worker"],
    createStartupReadyClaudeAgent(home, NOW, "claude-mock")
  );
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(agent)],
      agent.id,
      workspace,
      NOW
    ));
    tx.saveConfig({ ...tx.getConfig(), review: { roleName: "reviewer", trigger: "leader" } });
  });
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Review then clean",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const develop = await preparer.prepareWorkItemWorkspace(task.id, item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const candidateRun = yieldAgentRun(createAgentRun(
    "agent-run-1", task.id, "worker", "new", "Candidate", NOW,
    { workItemId: item.id, workspace: develop }
  ), "Candidate ready.", NOW);
  store.saveAgentRun(candidateRun);
  store.saveWorkItem(task.id, submitWorkItemCandidate(running, {
    summary: candidateRun.summary,
    source: { type: "run", runId: candidateRun.id },
    reviewPolicy: { roleName: "reviewer", trigger: "leader" },
    workspace: develop,
    gitSnapshot: await preparer.snapshotCandidateWorkspace(develop)
  }, NOW));
  const queued = spawnExactTaskCli(
    home,
    store,
    task.id,
    "leader",
    ["task", "work", "review", item.id]
  );
  assert.equal(queued.status, 0, queued.stderr || queued.stdout);
  const round = store.listReviewRounds(task.id)[0];
  const reviewRun = store.getActiveAgentRun(task.id, "reviewer");
  markDelivered(store, reviewRun);
  const finished = spawnExactTaskCli(
    home,
    store,
    task.id,
    "reviewer",
    ["task", "run", "yield", reviewRun.id, "--summary", "Review complete"]
  );
  assert.equal(finished.status, 0, finished.stderr || finished.stdout);
  assert.equal(store.getReviewRound(task.id, round.id).status, "completed");
  const reviewRoot = join(workspace, "tasks", task.id, "reviews", round.id);
  assert.equal(existsSync(reviewRoot), true);

  const dirtyMarker = join(reviewRoot, project.name, "review-dirty.txt");
  writeFileSync(dirtyMarker, "retain this evidence\n");
  const retained = spawnExactTaskCli(
    home,
    store,
    task.id,
    "leader",
    ["task", "work", "review", "cleanup", round.id]
  );
  assert.notEqual(retained.status, 0);
  assert.match(retained.stderr, /dirty/i);
  assert.notEqual(store.getReviewRoundWorkspace(task.id, round.id), null);
  assert.equal(existsSync(reviewRoot), true);
  unlinkSync(dirtyMarker);

  const cleaned = spawnExactTaskCli(
    home,
    store,
    task.id,
    "leader",
    ["task", "work", "review", "cleanup", round.id]
  );
  assert.equal(cleaned.status, 0, cleaned.stderr || cleaned.stdout);
  assert.equal(store.getReviewRoundWorkspace(task.id, round.id), null);
  assert.equal(existsSync(reviewRoot), false);
});

test("public dispatch prepares a WorkItem-owned read-only Develop workspace before yield", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Read-only WorkItem", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  addTaskRoles(
    store,
    task,
    repositoryPath,
    ["leader", "worker"],
    createStartupReadyClaudeAgent(home, NOW, "claude-mock")
  );
  const item = createWorkItem("work-item-1", task.id, {
    title: "Inspect without writes",
    assignee: "worker",
    writeProjectIds: []
  }, NOW);
  store.saveWorkItem(task.id, item);
  const dispatched = spawnExactTaskCli(
    home,
    store,
    task.id,
    "leader",
    ["task", "work", "dispatch", item.id]
  );
  assert.equal(dispatched.status, 0, dispatched.stderr || dispatched.stdout);

  const workspaceRecord = store.getWorkItemWorkspace(task.id, item.id);
  assert.deepEqual(workspaceRecord.owner, {
    type: "work-item",
    taskId: task.id,
    workItemId: item.id
  });
  assert.equal(workspaceRecord.entries.every(({ access }) => access === "read"), true);
  assert.equal(workspaceRecord.root, join(workspace, "tasks", task.id, "work-items", item.id));
  assert.equal(existsSync(workspaceRecord.root), true);
  const active = store.getActiveAgentRun(task.id, "worker");
  assert.deepEqual(active.workspace.owner, workspaceRecord.owner);
  markDelivered(store, active);

  const yielded = spawnExactTaskCli(
    home,
    store,
    task.id,
    "worker",
    ["task", "run", "yield", active.id, "--summary", "Read-only result ready"]
  );
  assert.equal(yielded.status, 0, yielded.stderr || yielded.stdout);
  const candidateItem = store.getWorkItem(task.id, item.id);
  assert.equal(candidateItem.status, "awaiting_acceptance");
  const candidate = candidateItem.candidates.at(-1);
  assert.deepEqual(candidate.source, { type: "run", runId: active.id });
  assert.deepEqual(candidate.workspace.owner, workspaceRecord.owner);
});

test("a roleless Project WorkItem follows isolate, Candidate, Integration, acceptance, and cleanup", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Roleless WorkItem lifecycle", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath, ["leader"]);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Leader-managed isolated change",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);

  const runAsLeader = (args) => spawnExactTaskCli(
    home,
    store,
    task.id,
    "leader",
    args
  );
  const isolated = runAsLeader(["task", "work", "isolate", item.id]);
  assert.equal(isolated.status, 0, isolated.stderr || isolated.stdout);
  const develop = store.getWorkItemWorkspace(task.id, item.id);
  assert.notEqual(develop, null);
  assert.deepEqual(develop.owner, {
    type: "work-item",
    taskId: task.id,
    workItemId: item.id
  });
  assert.equal(store.getWorkItem(task.id, item.id).assignee, undefined);

  const started = runAsLeader(["task", "work", "update", item.id, "running"]);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  assert.equal(store.getWorkItem(task.id, item.id).status, "running");
  assert.equal(store.getWorkItem(task.id, item.id).candidates.length, 0);

  const isolatedPath = develop.entries[0].path;
  writeFileSync(join(isolatedPath, "roleless.txt"), "roleless result\n");
  execFileSync("git", ["-C", isolatedPath, "add", "roleless.txt"]);
  execFileSync("git", ["-C", isolatedPath, "commit", "-qm", "roleless result"]);
  const completed = runAsLeader([
    "task", "work", "update", item.id, "done", "--summary", "Ready for integration"
  ]);
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  const candidateItem = store.getWorkItem(task.id, item.id);
  assert.equal(candidateItem.status, "awaiting_acceptance");
  const candidate = candidateItem.candidates.at(-1);
  assert.deepEqual(candidate.source, { type: "direct" });
  assert.deepEqual(candidate.workspace.owner, develop.owner);
  assert.equal(candidate.gitSnapshot, undefined);
  assert.notEqual(
    execFileSync("git", ["-C", isolatedPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    candidate.workspace.entries[0].baseCommit
  );

  const bypassed = runAsLeader([
    "task", "work", "update", item.id, "done", "--summary", "Bypass attempt"
  ]);
  assert.notEqual(bypassed.status, 0);
  assert.match(bypassed.stderr, /awaiting acceptance|task work accept/i);
  assert.equal(store.getWorkItem(task.id, item.id).status, "awaiting_acceptance");

  const captured = runAsLeader(["task", "work", "capture", item.id]);
  assert.equal(captured.status, 0, captured.stderr || captured.stdout);
  const [changeSet] = store.listChangeSets(task.id);
  assert.notEqual(changeSet, undefined);
  assert.equal(changeSet.workItemId, item.id);

  const integration = runAsLeader([
    "task", "integration", "start", task.id, "--change-set", changeSet.id
  ]);
  assert.equal(integration.status, 0, integration.stderr || integration.stdout);
  assert.match(integration.stdout, /Integrated/i);

  const accepted = runAsLeader([
    "task", "work", "accept", item.id, "--summary", "Integrated and accepted"
  ]);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  assert.equal(store.getWorkItem(task.id, item.id).status, "completed");

  const cleaned = runAsLeader([
    "task", "work", "cleanup", item.id, "--integrated"
  ]);
  assert.equal(cleaned.status, 0, cleaned.stderr || cleaned.stdout);
  assert.equal(store.getWorkItemWorkspace(task.id, item.id), null);
  assert.equal(store.getWorkItem(task.id, item.id).workspaceDisposition, "integrated");
  assert.equal(store.getWorkItem(task.id, item.id).assignee, undefined);
  assert.equal(existsSync(isolatedPath), false);
  assert.throws(() => execFileSync(
    "git",
    ["-C", repositoryPath, "show-ref", "--verify", "refs/heads/yui/task-1/work-1"],
    { stdio: "ignore" }
  ));
  assert.equal(existsSync(join(workspace, "tasks", task.id, "work-items", item.id)), false);
});

test("an exact direct Candidate captures clean Task main and records already-contained Integration", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Direct Task-main delivery", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }],
    requireIntegration: true
  }), NOW);
  addTaskRoles(store, task, repositoryPath, ["leader"]);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const prepared = await preparer.prepareTaskWorkspace(task.id);
  const taskWorkspace = store.getTaskWorkspace(task.id);
  const taskEntry = taskWorkspace.entries.find(({ projectId }) => projectId === project.id);
  const mainPath = join(prepared.path, project.name);
  const item = updateWorkItemStatus(createWorkItem("work-item-1", task.id, {
    title: "Package exact direct delivery",
    writeProjectIds: [project.id]
  }, NOW), "running", NOW);
  const invocation = exactTaskCliInvocation({
    home,
    store,
    taskId: task.id,
    roleName: "leader",
    taskFinalReviewerRole: "reviewer"
  });
  const contract = createTaskFinalReviewContract({
    taskId: task.id,
    reviewerRoleName: "reviewer",
    controlPlaneDigest: invocation.controlDigest
  });
  store.saveWorkItem(task.id, submitWorkItemCandidate(item, {
    summary: "Direct Task main is ready for provenance capture.",
    source: { type: "direct" },
    reviewPolicy: { roleName: "reviewer", trigger: "final" },
    taskFinalReviewContract: contract
  }, NOW));
  writeFileSync(join(mainPath, "direct-main.txt"), "direct main delivery\n");
  git(["-C", mainPath, "add", "direct-main.txt"]);
  git(["-C", mainPath, "commit", "-qm", "direct main delivery"]);
  const head = git(["-C", mainPath, "rev-parse", "HEAD"]).trim();
  const manager = new WorkItemChangeSetManager(store, () => new Date(NOW));

  await assert.rejects(
    manager.capture(task.id, item.id),
    /no managed workspace/i
  );
  await assert.rejects(
    manager.capture(task.id, item.id, {
      taskFinalReviewContract: createTaskFinalReviewContract({
        taskId: task.id,
        reviewerRoleName: "reviewer",
        controlPlaneDigest: "b".repeat(64)
      })
    }),
    /Task-final contract|direct Candidate/i
  );
  writeFileSync(join(mainPath, "dirty.txt"), "must not be captured\n");
  await assert.rejects(
    manager.capture(task.id, item.id, { taskFinalReviewContract: contract }),
    /Task main.*clean/i
  );
  unlinkSync(join(mainPath, "dirty.txt"));

  const captured = spawnSync(process.execPath, [
    invocation.cliEntry,
    ...invocation.prefix,
    "task", "work", "capture", item.id
  ], { encoding: "utf8", env: invocation.environment });
  assert.equal(captured.status, 0, captured.stderr || captured.stdout);
  const [changeSet] = store.listChangeSets(task.id);
  assert.notEqual(changeSet, undefined);
  assert.equal(changeSet.workItemId, item.id);
  assert.equal(changeSet.baseCommit, taskEntry.baseCommit);
  assert.equal(changeSet.headCommit, head);
  assert.deepEqual(changeSet.changedPaths, ["direct-main.txt"]);

  const result = await runTaskIntegrationCommand([
    "start", task.id, "--change-set", changeSet.id
  ], store, home, { now: () => new Date(NOW) });
  assert.match(result.output, /Integrated/i);
  const [integration] = store.listIntegrationAttempts(task.id);
  assert.equal(integration.status, "committed");
  assert.equal(integration.expectedHead, head);
  assert.equal(integration.candidateCommit, head);
  assert.deepEqual(integration.changeSetIds, [changeSet.id]);
  assert.equal(git(["-C", mainPath, "rev-parse", "HEAD"]).trim(), head);
});

test("Task archive requires explicit WorkItem cleanup and preserves its record", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const active = activateTask(createTask("task-1", "Archive isolated work", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: project.developmentBranch }]
  }), NOW);
  addTaskRoles(store, active, repositoryPath);
  const item = createWorkItem("work-item-1", active.id, {
    title: "Isolated edit",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(active.id, item);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const main = (await preparer.prepareTaskWorkspace(active.id)).path;
  const isolated = await preparer.prepareWorkItemWorkspace(active.id, item.id);
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
  assert.match(blocked.error, /explicit cleanup.*work-item-1/i);
  assert.equal(existsSync(main), true);
  assert.equal(existsSync(isolated.entries[0].path), true);
  assert.equal(store.getTask(active.id).cwd, main);

  assert.equal(await preparer.cleanupWorkItemWorkspace(active.id, item.id, "integrated"), "removed");
  assert.equal((await preparer.cleanupTaskForArchive(active.id)).status, "removed");
  runTaskCommand(["archive", active.id, "--integrated"], store, { now: () => new Date(NOW) });
  assert.equal(store.getTask(active.id).status, "archived");
  assert.equal(store.getWorkItem(active.id, item.id).workspaceDisposition, "integrated");
});

test("public Task archive cleans terminal ReviewRound workspaces before archiving", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Archive review evidence", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  const agent = addTaskRoles(
    store,
    task,
    repositoryPath,
    ["leader", "worker"],
    createStartupReadyClaudeAgent(home, NOW, "claude-mock")
  );
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(agent)],
      agent.id,
      workspace,
      NOW
    ));
    tx.saveConfig({ ...tx.getConfig(), review: { roleName: "reviewer", trigger: "leader" } });
  });
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const main = (await preparer.prepareTaskWorkspace(task.id)).path;
  const item = createWorkItem("work-item-1", task.id, {
    title: "Reviewable result",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const develop = await preparer.prepareWorkItemWorkspace(task.id, item.id);
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const candidateRun = yieldAgentRun(createAgentRun(
    "agent-run-1", task.id, "worker", "new", "Candidate", NOW,
    { workItemId: item.id, workspace: develop }
  ), "Candidate ready.", NOW);
  store.saveAgentRun(candidateRun);
  store.saveWorkItem(task.id, submitWorkItemCandidate(running, {
    summary: candidateRun.summary,
    source: { type: "run", runId: candidateRun.id },
    reviewPolicy: { roleName: "reviewer", trigger: "leader" },
    workspace: develop,
    gitSnapshot: await preparer.snapshotCandidateWorkspace(develop)
  }, NOW));
  const queued = spawnExactTaskCli(
    home,
    store,
    task.id,
    "leader",
    ["task", "work", "review", item.id]
  );
  assert.equal(queued.status, 0, queued.stderr || queued.stdout);
  const round = store.listReviewRounds(task.id)[0];
  const reviewRun = store.getActiveAgentRun(task.id, "reviewer");
  markDelivered(store, reviewRun);
  // The review result durably queues a Leader wake.  Quiesce this fixture's
  // exact Controller before completing the terminal Task so its asynchronous
  // scheduler cannot race archive preflight by creating the expected Leader
  // Run.  The yield still folds the durable result; omitting the optional
  // runtime signal here preserves the pending wake for the archive scanner.
  await stopFileTaskController(home);
  const finished = runTaskCommand(
    ["run", "yield", `${task.id}/${reviewRun.id}`, "--summary", "Review complete"],
    store,
    {
      environment: {},
      yuiHome: home,
      reviewWorkspaceResult: await preparer.snapshotReviewRoundResult(task.id, round.id)
    }
  );
  assert.equal(finished.kind, "output");
  const completedItem = updateWorkItemStatus(
    store.getWorkItem(task.id, item.id),
    "completed",
    NOW,
    "Accepted after review."
  );
  store.saveWorkItem(task.id, completedItem);
  assert.equal(await preparer.cleanupWorkItemWorkspace(task.id, item.id, "integrated"), "removed");
  store.saveTask(completeTask(store.getTask(task.id), NOW, {
    summary: "Task complete.",
    by: "leader"
  }));

  const archived = spawnSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "task", "archive", task.id, "--integrated"],
    { encoding: "utf8", env: { ...process.env, YUI_HOME: home } }
  );
  assert.equal(archived.status, 0, archived.stderr || archived.stdout);
  assert.equal(store.getTask(task.id).status, "archived");
  assert.equal(store.getReviewRoundWorkspace(task.id, round.id), null);
  assert.equal(existsSync(join(workspace, "tasks", task.id, "reviews", round.id)), false);
  assert.equal(existsSync(main), false);
});

test("a WorkItem can provision from an explicit Project ref and capture only its descendants", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const developmentBranch = execFileSync(
    "git", ["-C", repositoryPath, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }
  ).trim();
  git(["-C", repositoryPath, "checkout", "-q", "-b", "latest-master"]);
  writeFileSync(join(repositoryPath, "latest.txt"), "latest\n");
  git(["-C", repositoryPath, "add", "latest.txt"]);
  git([
    "-C", repositoryPath,
    "-c", "user.name=Yui Test",
    "-c", "user.email=yui@example.invalid",
    "commit", "-qm", "latest master"
  ]);
  const latestCommit = git(["-C", repositoryPath, "rev-parse", "HEAD"]).trim();
  git(["-C", repositoryPath, "branch", "origin/master", "latest-master"]);
  git(["-C", repositoryPath, "checkout", "-q", developmentBranch]);

  const task = activateTask(createTask("task-1", "Explicit base", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: "HEAD"
    }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const result = runTaskCommand([
    "work", "create", task.id, "Use latest master",
    "--project", project.id,
    "--base-ref", `${project.id}=origin/master`,
    "--role", "worker"
  ], store, { now: () => new Date(NOW) });
  assert.equal(result.data.workItem.baseRefs[0].baseRef, "origin/master");

  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  const main = await preparer.prepareTaskWorkspace(task.id);
  const workspace = await preparer.prepareWorkItemWorkspace(task.id, result.data.workItem.id);
  const entry = workspace.entries.find(({ access }) => access === "write");
  assert.equal(entry.baseRef, "origin/master");
  assert.equal(entry.baseCommit, latestCommit);
  assert.equal(
    git(["-C", entry.path, "rev-parse", "HEAD"]).trim(),
    latestCommit
  );
  assert.equal(
    git(["-C", join(main.path, project.name), "rev-parse", "HEAD"]).trim(),
    git(["-C", repositoryPath, "rev-parse", developmentBranch]).trim()
  );

  const running = updateWorkItemStatus(result.data.workItem, "running", NOW);
  store.saveWorkItem(task.id, running);
  const candidateRun = yieldAgentRun(createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "worker",
    "new",
    "Prepare explicit-base candidate.",
    NOW,
    { workItemId: result.data.workItem.id, workspace }
  ), "Candidate ready.", NOW);
  store.saveAgentRun(candidateRun);
  store.saveWorkItem(task.id, submitWorkItemCandidate(running, {
    summary: candidateRun.summary,
    source: { type: "run", runId: candidateRun.id },
    workspace
  }, NOW));
  writeFileSync(join(entry.path, "change.txt"), "descendant\n");
  git(["-C", entry.path, "add", "change.txt"]);
  git([
    "-C", entry.path,
    "-c", "user.name=Yui Test",
    "-c", "user.email=yui@example.invalid",
    "commit", "-qm", "descendant change"
  ]);
  const manager = new WorkItemChangeSetManager(store, () => new Date(NOW));
  const [changeSet] = await manager.capture(task.id, result.data.workItem.id);
  assert.equal(changeSet.baseCommit, latestCommit);

  const tree = git(["-C", entry.path, "rev-parse", "HEAD^{tree}"]).trim();
  const unrelated = git([
    "-C", entry.path,
    "-c", "user.name=Yui Test",
    "-c", "user.email=yui@example.invalid",
    "commit-tree", tree,
    "-m", "unrelated history"
  ]).trim();
  git(["-C", entry.path, "reset", "--hard", unrelated]);
  await assert.rejects(
    preparer.prepareWorkItemWorkspace(task.id, result.data.workItem.id),
    /does not descend from its frozen base/u
  );
  await assert.rejects(
    manager.capture(task.id, result.data.workItem.id),
    /does not descend from its recorded base/u
  );
});

test("explicit base mismatch does not retain an unadopted WorkItem worktree", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const requestedBaseCommit = execFileSync(
    "git", ["-C", repositoryPath, "rev-parse", "HEAD"], { encoding: "utf8" }
  ).trim();
  execFileSync("git", [
    "-C", repositoryPath,
    "commit", "--allow-empty", "-qm", "stale managed branch"
  ]);
  const staleBranchCommit = execFileSync(
    "git", ["-C", repositoryPath, "rev-parse", "HEAD"], { encoding: "utf8" }
  ).trim();
  execFileSync("git", [
    "-C", repositoryPath, "branch", "origin/master", requestedBaseCommit
  ]);

  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Reject stale explicit base", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: "HEAD"
    }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const result = runTaskCommand([
    "work", "create", task.id, "Stale explicit base",
    "--project", project.id,
    "--base-ref", `${project.id}=origin/master`,
    "--role", "worker"
  ], store, { now: () => new Date(NOW) });
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const identity = worktreeIdentity(task.id, result.data.workItem.id);
  execFileSync("git", [
    "-C", repositoryPath, "branch", identity.branch, staleBranchCommit
  ]);

  await assert.rejects(
    preparer.prepareWorkItemWorkspace(task.id, result.data.workItem.id),
    /did not start at its requested base ref/u
  );
  assert.equal(store.getWorkItemWorkspace(task.id, result.data.workItem.id), null);
  assert.equal(
    existsSync(join(workspace, "worktree", project.name, identity.directory)),
    false
  );
  assert.equal(
    execFileSync("git", ["-C", repositoryPath, "rev-parse", identity.branch], {
      encoding: "utf8"
    }).trim(),
    staleBranchCommit
  );
});

test("explicit WorkItem base refs reject unbound, read-only, and invalid refs without creating a workspace", async (t) => {
  const { home, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Reject explicit base", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: "HEAD"
    }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const environment = {
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: task.id,
    YUI_ROLE: "leader"
  };
  assert.throws(
    () => runTaskCommand([
      "work", "create", task.id, "Unbound ref",
      "--base-ref", "project-999=origin/master"
    ], store, { now: () => new Date(NOW), environment }),
    /Task Project not found/u
  );
  assert.throws(
    () => runTaskCommand([
      "work", "create", task.id, "Read-only ref",
      "--base-ref", `${project.id}=origin/master`
    ], store, { now: () => new Date(NOW), environment }),
    /must be writable/u
  );
  const created = runTaskCommand([
    "work", "create", task.id, "Invalid ref",
    "--project", project.id,
    "--base-ref", `${project.id}=does-not-exist`
  ], store, { now: () => new Date(NOW), environment });
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  await assert.rejects(
    preparer.prepareWorkItemWorkspace(task.id, created.data.workItem.id),
    /Git command failed|does-not-exist/u
  );
  assert.equal(store.getWorkItemWorkspace(task.id, created.data.workItem.id), null);
});
