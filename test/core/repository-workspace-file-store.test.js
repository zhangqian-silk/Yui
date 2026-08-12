import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
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
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
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
  updateRole,
  updateRoleStatus
} from "../../dist/role/role.js";
import { failAgentRun, yieldAgentRun } from "../../dist/run/agentRun.js";
import { terminalizeExactTaskRun } from "../../dist/lifecycle/exactRunTerminalization.js";
import { formatAgentRunReceiptId } from "../../dist/task/taskRecordReference.js";
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
import { taskWorkspaceRefSegment } from "../../dist/repository/taskWorkspaceIdentity.js";
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
  attachWorkItemExecutionGroup,
  currentWorkItemExecutionGroup,
  recordWorkItemWorkspaceDisposition,
  submitWorkItemCandidate,
  updateWorkItemExecutionGroup,
  updateWorkItemWriteProjects,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import {
  createExecutionGroup,
  recordExecutionLaneResult,
  resolveExecutionGroup
} from "../../dist/execution/executionGroup.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { WorkItemChangeSetManager } from "../../dist/workspace/workItemChangeSetManager.js";
import { createIsolatedRuntime } from "../helpers/isolatedRuntime.js";
import { installMockProviderCommands } from "../helpers/mockProviderCommands.js";

const NOW = new Date("2026-07-19T12:00:00.000Z");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function fixture(t) {
  const { root, home } = createIsolatedRuntime(t);
  installMockProviderCommands(home);
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
    executionGroups: [],
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
    executionGroups: [],
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
    },
    async cleanupExecutionLaneWorkspacesForWorkItem() {
      return "missing";
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
    executionGroups: [],
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
    },
    async cleanupExecutionLaneWorkspacesForWorkItem() {
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
    executionGroups: [],
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
    executionGroups: [],
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
    schemaVersion: 3,
    id: "project-1",
    name: "Yui",
    aliases: ["yui-cli"],
    path: realpathSync(repositoryPath),
    ownership: "external",
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

test("Operator can clone and bind a remote Project into the Home-managed catalog", async (t) => {
  const { root, home, workspace, store } = fixture(t);
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
  // A remote URL-only clone defaults to Home-managed ownership: the canonical
  // checkout lives with the Home, not in the configured workspace.
  assert.equal(store.listProjects()[0].path, realpathSync(join(home, "projects", "project-1")));
  assert.equal(store.listProjects()[0].ownership, "managed");
  assert.equal(store.listProjects()[0].remoteUrl, remote);
  assert.equal(existsSync(join(workspace, "RemoteProject")), false);
  assert.equal(
    execFileSync(
      "git",
      ["-C", join(home, "projects", "project-1"), "rev-parse", "HEAD"],
      { encoding: "utf8" }
    ).trim(),
    execFileSync("git", ["-C", remote, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  );
});

test("Project clone stays inside workspace and removes an unbound checkout", async (t) => {
  const { root, home, workspace, store } = fixture(t);
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

  // The reserved-worktree guard only applies to the explicit external checkout
  // mode; a managed clone never targets the workspace.
  await assert.rejects(
    runProjectCommand(["clone", "worktree", "git@example.invalid:yui.git", "--external"], store, { git }),
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
  assert.equal(existsSync(join(home, "projects", "project-1")), false);
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
  const { root, home, store } = fixture(t);
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
  const checkout = join(home, "projects", "project-1");
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
  assert.deepEqual(await preparer.prepareTaskWorkspace(task.id), {
    taskId: task.id,
    status: "ready",
    path: main
  });
  const preparedTask = store.getTask(task.id);
  const segment = taskWorkspaceRefSegment(preparedTask);
  assert.match(segment, new RegExp(`^${task.id}-[a-f0-9]{8}$`));
  const mainProject = join(workspace, "worktree", "Yui", segment, "main");
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
  assert.equal(
    execFileSync("git", ["-C", mainProject, "branch", "--show-current"], { encoding: "utf8" }).trim(),
    `yui/${segment}/main`
  );
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
  assert.equal(plan.role.cwd, reviewWorkspace.entries[0].path);
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
  assert.equal(isolatedPlan.role.workspace, work.root);
  assert.equal(isolatedPlan.role.cwd, undefined);
  for (const entry of work.entries) {
    assert.deepEqual(
      isolatedPlan.launch.args.slice(
        isolatedPlan.launch.args.indexOf(entry.path) - 1,
        isolatedPlan.launch.args.indexOf(entry.path) + 1
      ),
      ["--add-dir", entry.path]
    );
  }
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

test("execution Lane workspaces are managed, retry-reused, merged into Candidate, and cleaned", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Managed execution lanes", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const item = createWorkItem("work-item-1", task.id, {
    title: "parallel implementation",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const develop = await preparer.prepareWorkItemWorkspace(task.id, item.id);
  const target = {
    schemaVersion: 1,
    kind: "work-item",
    taskId: task.id,
    workItemId: item.id,
    revision: item.revision,
    projects: [{ projectId: project.id, commit: develop.entries[0].baseCommit }],
    fingerprint: JSON.stringify({ taskId: task.id, workItemId: item.id, revision: item.revision, projects: [{ projectId: project.id, commit: develop.entries[0].baseCommit }] })
  };
  let group = createExecutionGroup("execution-group-1", task.id, {
    purpose: "execution",
    target,
    strategy: { mode: "fixed", count: 2 },
    lanes: [{ roleName: "worker" }, { roleName: "worker-2" }]
  }, NOW);
  store.saveWorkItem(task.id, attachWorkItemExecutionGroup(item, group, NOW));
  const lane1 = await preparer.prepareExecutionLaneWorkspace(task.id, group.id, group.lanes[0].id);
  const lane2 = await preparer.prepareExecutionLaneWorkspace(task.id, group.id, group.lanes[1].id);
  assert.notEqual(lane1.root, lane2.root);
  assert.notEqual(lane1.entries[0].path, lane2.entries[0].path);
  assert.equal(store.getManagedWorkspace(lane1.owner)?.root, lane1.root);
  const lane1Again = await preparer.prepareExecutionLaneWorkspace(task.id, group.id, group.lanes[0].id);
  assert.equal(lane1Again.root, lane1.root);
  writeFileSync(join(lane1.entries[0].path, "lane-one.txt"), "one\n");
  execFileSync("git", ["-C", lane1.entries[0].path, "add", "lane-one.txt"]);
  execFileSync("git", ["-C", lane1.entries[0].path, "commit", "-qm", "lane one"]);
  writeFileSync(join(lane2.entries[0].path, "lane-two.txt"), "two\n");
  execFileSync("git", ["-C", lane2.entries[0].path, "add", "lane-two.txt"]);
  execFileSync("git", ["-C", lane2.entries[0].path, "commit", "-qm", "lane two"]);
  writeFileSync(join(lane1.entries[0].path, "dirty-lane.txt"), "dirty\n");
  await assert.rejects(
    preparer.snapshotExecutionLaneWorkspace(lane1),
    /workspace is dirty/i
  );
  unlinkSync(join(lane1.entries[0].path, "dirty-lane.txt"));
  const lane1Branch = lane1.entries[0].branch;
  execFileSync("git", ["-C", lane1.entries[0].path, "checkout", "-qb", "wrong-lane-branch"]);
  await assert.rejects(
    preparer.snapshotExecutionLaneWorkspace(lane1),
    /left its managed branch/i
  );
  execFileSync("git", ["-C", lane1.entries[0].path, "checkout", "-q", lane1Branch]);
  const lane1Snapshot = await preparer.snapshotExecutionLaneWorkspace(lane1);
  const lane2Snapshot = await preparer.snapshotExecutionLaneWorkspace(lane2);
  group = recordExecutionLaneResult(group, group.lanes[0].id, { summary: "one", gitSnapshot: lane1Snapshot }, "completed", NOW);
  group = recordExecutionLaneResult(group, group.lanes[1].id, { summary: "two", gitSnapshot: lane2Snapshot }, "completed", NOW);
  group = resolveExecutionGroup(group, {
    decision: "accept",
    summary: "accepted",
    selectedLaneIds: group.lanes.map(({ id }) => id)
  }, NOW);
  store.saveWorkItem(task.id, updateWorkItemExecutionGroup(
    store.getWorkItem(task.id, item.id),
    group,
    NOW
  ));
  execFileSync("git", ["-C", lane1.entries[0].path, "checkout", "-qb", "wrong-after-yield"]);
  await assert.rejects(
    preparer.materializeExecutionGroupCandidate(
      task.id, item.id, group.id, group.lanes.map(({ id }) => id)
    ),
    /left its managed branch/i
  );
  execFileSync("git", ["-C", lane1.entries[0].path, "checkout", "-q", lane1Branch]);
  const materialized = await preparer.materializeExecutionGroupCandidate(
    task.id,
    item.id,
    group.id,
    group.lanes.map(({ id }) => id)
  );
  assert.match(readFileSync(join(materialized.workspace.entries[0].path, "lane-one.txt"), "utf8"), /one/);
  assert.match(readFileSync(join(materialized.workspace.entries[0].path, "lane-two.txt"), "utf8"), /two/);
  const materializedHead = execFileSync(
    "git", ["-C", materialized.workspace.entries[0].path, "rev-parse", "HEAD"], { encoding: "utf8" }
  ).trim();
  assert.notEqual(materializedHead, develop.entries[0].baseCommit);
  await preparer.restoreExecutionGroupCandidateMaterialization(materialized);
  assert.equal(
    execFileSync("git", ["-C", materialized.workspace.entries[0].path, "rev-parse", "HEAD"], {
      encoding: "utf8"
    }).trim(),
    develop.entries[0].baseCommit
  );
  assert.equal(execFileSync(
    "git", ["-C", materialized.workspace.entries[0].path, "status", "--porcelain"], { encoding: "utf8" }
  ).trim(), "");
  // A later Leader transaction failure must compensate the exact materialized
  // Git heads before the caller retries resolution.
  const rematerialized = await preparer.materializeExecutionGroupCandidate(
    task.id,
    item.id,
    group.id,
    group.lanes.map(({ id }) => id)
  );
  await preparer.restoreExecutionGroupCandidateMaterialization(rematerialized);
  // A post-yield branch advance is not a new Lane output: materialization
  // must reject it rather than silently reading the live branch.
  writeFileSync(join(lane1.entries[0].path, "lane-conflict.txt"), "lane one\n");
  execFileSync("git", ["-C", lane1.entries[0].path, "add", "lane-conflict.txt"]);
  execFileSync("git", ["-C", lane1.entries[0].path, "commit", "-qm", "lane one conflict"]);
  writeFileSync(join(lane2.entries[0].path, "lane-conflict.txt"), "lane two\n");
  execFileSync("git", ["-C", lane2.entries[0].path, "add", "lane-conflict.txt"]);
  execFileSync("git", ["-C", lane2.entries[0].path, "commit", "-qm", "lane two conflict"]);
  const targetPath = materialized.workspace.entries[0].path;
  const targetHeadBeforeConflict = execFileSync(
    "git", ["-C", targetPath, "rev-parse", "HEAD"], { encoding: "utf8" }
  ).trim();
  await assert.rejects(
    preparer.materializeExecutionGroupCandidate(
      task.id,
      item.id,
      group.id,
      group.lanes.map(({ id }) => id)
    ),
    /advanced after yield/i
  );
  assert.equal(
    execFileSync("git", ["-C", targetPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    targetHeadBeforeConflict
  );
  assert.equal(execFileSync(
    "git", ["-C", targetPath, "status", "--porcelain"], { encoding: "utf8" }
  ).trim(), "");
  const cleaned = await Promise.all(group.lanes.map(({ id }) => preparer.cleanupExecutionLaneWorkspace(task.id, group.id, id)));
  assert.deepEqual(cleaned, ["removed", "removed"]);
  assert.equal(store.listManagedWorkspaces(task.id).some(({ owner }) => owner.type === "execution-lane"), false);
  assert.equal(existsSync(join(workspace, "worktree", project.name, task.id, `execution-lane-${group.id}-${group.lanes[0].id}`)), false);
  const unadopted = await preparer.prepareExecutionLaneWorkspace(
    task.id,
    "execution-group-unadopted",
    "execution-group-unadopted-lane-1",
    { purpose: "execution", workItemId: item.id }
  );
  assert.equal(store.getManagedWorkspace(unadopted.owner), null);
  await preparer.discardUnadoptedExecutionLaneWorkspaces(
    new Map([["execution-group-unadopted-lane-1", unadopted]])
  );
  assert.equal(existsSync(unadopted.entries[0].path), false);
});

test("public fixed multi-Lane dispatch yields isolated roots and resolves one aggregate Candidate", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Public Lane dispatch", NOW, {
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
    ["leader", "worker", "worker-2"],
    createStartupReadyClaudeAgent(home, NOW, "claude-mock")
  );
  const item = createWorkItem("work-item-1", task.id, {
    title: "Public fixed panel",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);

  const dispatched = spawnExactTaskCli(home, store, task.id, "leader", [
    "task", "work", "dispatch", item.id,
    "--strategy", "fixed:2",
    "--lane-role", "worker-2"
  ]);
  assert.equal(dispatched.status, 0, dispatched.stderr || dispatched.stdout);
  await stopFileTaskController(home);
  const activeRuns = store.listAgentRuns(task.id).filter(({ purpose, status }) => (
    purpose === "execution" && status === "active"
  ));
  assert.equal(activeRuns.length, 2);
  assert.notEqual(activeRuns[0].workspace, undefined);
  assert.notEqual(activeRuns[1].workspace, undefined);
  assert.notEqual(activeRuns[0].workspace.root, activeRuns[1].workspace.root);
  assert.equal(activeRuns[0].workspace.owner.type, "execution-lane");
  assert.equal(activeRuns[1].workspace.owner.type, "execution-lane");

  for (const run of activeRuns) {
    const entry = run.workspace.entries.find(({ access }) => access === "write");
    writeFileSync(join(entry.path, `${run.roleName}.txt`), `${run.roleName}\n`);
    execFileSync("git", ["-C", entry.path, "add", `${run.roleName}.txt`]);
    execFileSync("git", ["-C", entry.path, "commit", "-qm", `${run.roleName} result`]);
    markDelivered(store, run);
    const yielded = spawnExactTaskCli(home, store, task.id, run.roleName, [
      "task", "run", "yield", run.id, "--summary", `${run.roleName} result`
    ]);
    assert.equal(yielded.status, 0, yielded.stderr || yielded.stdout);
  }

  const resolved = spawnExactTaskCli(home, store, task.id, "leader", [
    "task", "work", "group", "resolve", item.id,
    "--decision", "accept",
    "--summary", "Leader accepted the public panel"
  ]);
  assert.equal(resolved.status, 0, resolved.stderr || resolved.stdout);
  const accepted = store.getWorkItem(task.id, item.id);
  assert.equal(accepted.status, "awaiting_acceptance");
  assert.equal(accepted.candidates.length, 1);
  assert.match(accepted.candidates[0].summary, /worker result/);
  assert.match(accepted.candidates[0].summary, /worker-2 result/);
  const candidateWorkspace = store.getWorkItemWorkspace(task.id, item.id);
  assert.notEqual(candidateWorkspace, null);
  assert.equal(readFileSync(join(candidateWorkspace.entries[0].path, "worker.txt"), "utf8"), "worker\n");
  assert.equal(readFileSync(join(candidateWorkspace.entries[0].path, "worker-2.txt"), "utf8"), "worker-2\n");
  assert.equal(existsSync(join(workspace, "tasks", task.id, "execution-lanes")), true);

  const firstIteration = store.getWorkItem(task.id, item.id);
  const firstGroup = structuredClone(currentWorkItemExecutionGroup(firstIteration));
  const firstCandidate = structuredClone(firstIteration.candidates[0]);
  const rejected = spawnExactTaskCli(home, store, task.id, "leader", [
    "task", "work", "reject", item.id,
    "--summary", "Apply one more bounded revision"
  ]);
  assert.equal(rejected.status, 0, rejected.stderr || rejected.stdout);
  const redispatched = spawnExactTaskCli(home, store, task.id, "leader", [
    "task", "work", "dispatch", item.id,
    "--strategy", "fixed:2",
    "--lane-role", "worker-2"
  ]);
  assert.equal(redispatched.status, 0, redispatched.stderr || redispatched.stdout);
  await stopFileTaskController(home);

  const secondRuns = store.listAgentRuns(task.id).filter(({ purpose, status }) => (
    purpose === "execution" && status === "active"
  ));
  assert.equal(secondRuns.length, 2);
  const iterating = store.getWorkItem(task.id, item.id);
  assert.equal(iterating.executionGroups.length, 2);
  assert.deepEqual(iterating.executionGroups[0], firstGroup);
  assert.equal(iterating.candidates[0].id, firstCandidate.id);
  assert.equal(iterating.candidates[0].executionGroupId, firstGroup.id);
  assert.equal(iterating.currentExecutionGroupId, iterating.executionGroups[1].id);

  for (const run of secondRuns) {
    const entry = run.workspace.entries.find(({ access }) => access === "write");
    const name = `round-2-${run.roleName}.txt`;
    writeFileSync(join(entry.path, name), `${run.roleName} round two\n`);
    execFileSync("git", ["-C", entry.path, "add", name]);
    execFileSync("git", ["-C", entry.path, "commit", "-qm", `${run.roleName} round two`]);
    markDelivered(store, run);
    const yielded = spawnExactTaskCli(home, store, task.id, run.roleName, [
      "task", "run", "yield", run.id, "--summary", `${run.roleName} round two`
    ]);
    assert.equal(yielded.status, 0, yielded.stderr || yielded.stdout);
  }
  const resolvedAgain = spawnExactTaskCli(home, store, task.id, "leader", [
    "task", "work", "group", "resolve", item.id,
    "--decision", "accept",
    "--summary", "Leader accepted the second public panel"
  ]);
  assert.equal(resolvedAgain.status, 0, resolvedAgain.stderr || resolvedAgain.stdout);
  const secondIteration = store.getWorkItem(task.id, item.id);
  assert.equal(secondIteration.executionGroups.length, 2);
  assert.deepEqual(secondIteration.executionGroups[0], firstGroup);
  assert.equal(secondIteration.candidates.length, 2);
  assert.equal(secondIteration.candidates[1].executionGroupId, secondIteration.executionGroups[1].id);

  const reloaded = new FileTaskStore(home).getWorkItem(task.id, item.id);
  assert.deepEqual(reloaded.executionGroups, secondIteration.executionGroups);
  assert.deepEqual(reloaded.candidates, secondIteration.candidates);

  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  for (const group of secondIteration.executionGroups) {
    for (const lane of group.lanes) {
      assert.equal(
        await preparer.cleanupExecutionLaneWorkspace(task.id, group.id, lane.id),
        "removed"
      );
    }
  }
  assert.equal(store.listManagedWorkspaces(task.id).some(({ owner }) => (
    owner.type === "execution-lane" && owner.workItemId === item.id
  )), false);
  assert.deepEqual(
    new FileTaskStore(home).getWorkItem(task.id, item.id).executionGroups,
    secondIteration.executionGroups
  );
});

test("execution Lane snapshots freeze every writable Project before aggregate materialization", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const secondRepositoryPath = join(workspace, "Second");
  execFileSync("git", ["init", "-q", secondRepositoryPath]);
  execFileSync("git", ["-C", secondRepositoryPath, "config", "user.name", "Yui Test"]);
  execFileSync("git", ["-C", secondRepositoryPath, "config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(secondRepositoryPath, "tracked.txt"), "second initial\n");
  execFileSync("git", ["-C", secondRepositoryPath, "add", "tracked.txt"]);
  execFileSync("git", ["-C", secondRepositoryPath, "commit", "-qm", "second initial"]);
  const firstProject = await addProject(store, repositoryPath);
  await runProjectCommand([
    "add", "Second", secondRepositoryPath,
    "--alias", "second-cli",
    "--remote", "git@example.invalid:second.git",
    "--stable", "HEAD", "--development", "HEAD"
  ], store, { now: () => new Date(NOW) });
  const secondProject = store.listProjects().find(({ name }) => name === "Second");
  assert.notEqual(secondProject, undefined);
  const task = activateTask(createTask("task-1", "Multi-project Lane snapshot", NOW, {
    projectBindings: [firstProject, secondProject].map((project) => ({
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }))
  }), NOW);
  addTaskRoles(store, task, repositoryPath, ["leader", "worker", "worker-2"]);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Multi-project outputs",
    assignee: "worker",
    writeProjectIds: [firstProject.id, secondProject.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const develop = await preparer.prepareWorkItemWorkspace(task.id, item.id);
  const target = {
    schemaVersion: 1,
    kind: "work-item",
    taskId: task.id,
    workItemId: item.id,
    revision: item.revision,
    projects: develop.entries.filter(({ access }) => access === "write")
      .map(({ projectId, baseCommit }) => ({ projectId, commit: baseCommit })),
    fingerprint: "multi-project-lane-snapshot"
  };
  let group = createExecutionGroup("execution-group-1", task.id, {
    purpose: "execution",
    target,
    strategy: { mode: "fixed", count: 2 },
    lanes: [{ roleName: "worker" }, { roleName: "worker-2" }]
  }, NOW);
  store.saveWorkItem(task.id, attachWorkItemExecutionGroup(item, group, NOW));
  const lanes = await Promise.all(group.lanes.map(({ id }) => (
    preparer.prepareExecutionLaneWorkspace(task.id, group.id, id)
  )));
  for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
    const lane = lanes[laneIndex];
    for (const entry of lane.entries.filter(({ access }) => access === "write")) {
      const name = `${entry.projectId}-lane-${laneIndex + 1}.txt`;
      writeFileSync(join(entry.path, name), `${entry.projectId}-${laneIndex + 1}\n`);
      execFileSync("git", ["-C", entry.path, "add", name]);
      execFileSync("git", ["-C", entry.path, "commit", "-qm", name]);
    }
  }
  const snapshots = await Promise.all(lanes.map((lane) => preparer.snapshotExecutionLaneWorkspace(lane)));
  assert.deepEqual(snapshots.map(({ projects }) => projects.length), [2, 2]);
  group = recordExecutionLaneResult(group, group.lanes[0].id, { summary: "one", gitSnapshot: snapshots[0] }, "completed", NOW);
  group = recordExecutionLaneResult(group, group.lanes[1].id, { summary: "two", gitSnapshot: snapshots[1] }, "completed", NOW);
  store.saveWorkItem(task.id, updateWorkItemExecutionGroup(
    store.getWorkItem(task.id, item.id),
    group,
    NOW
  ));
  const materialized = await preparer.materializeExecutionGroupCandidate(
    task.id, item.id, group.id, group.lanes.map(({ id }) => id)
  );
  for (const entry of materialized.workspace.entries.filter(({ access }) => access === "write")) {
    assert.match(readFileSync(join(entry.path, `${entry.projectId}-lane-1.txt`), "utf8"), /-1$/m);
    assert.match(readFileSync(join(entry.path, `${entry.projectId}-lane-2.txt`), "utf8"), /-2$/m);
  }
  await preparer.restoreExecutionGroupCandidateMaterialization(materialized);
  await Promise.all(group.lanes.map(({ id }) => preparer.cleanupExecutionLaneWorkspace(task.id, group.id, id)));
});

test("public adaptive singleton yields, appends one Lane, and resolves frozen outputs", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Public adaptive expansion", NOW, {
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
    ["leader", "worker", "worker-2"],
    createStartupReadyClaudeAgent(home, NOW, "claude-mock")
  );
  const item = createWorkItem("work-item-1", task.id, {
    title: "Adaptive singleton",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);

  const firstDispatch = spawnExactTaskCli(home, store, task.id, "leader", [
    "task", "work", "dispatch", item.id,
    "--strategy", "adaptive:2"
  ]);
  assert.equal(firstDispatch.status, 0, firstDispatch.stderr || firstDispatch.stdout);
  await stopFileTaskController(home);
  let active = store.listAgentRuns(task.id).find(({ purpose, status }) => (
    purpose === "execution" && status === "active"
  ));
  assert.notEqual(active, undefined);
  assert.equal(active.workspace.owner.type, "execution-lane");
  let entry = active.workspace.entries.find(({ access }) => access === "write");
  writeFileSync(join(entry.path, "first-lane.txt"), "first\n");
  execFileSync("git", ["-C", entry.path, "add", "first-lane.txt"]);
  execFileSync("git", ["-C", entry.path, "commit", "-qm", "first lane"]);
  markDelivered(store, active);
  const firstYield = spawnExactTaskCli(home, store, task.id, active.roleName, [
    "task", "run", "yield", active.id, "--summary", "first lane"
  ]);
  assert.equal(firstYield.status, 0, firstYield.stderr || firstYield.stdout);
  assert.equal(store.getWorkItem(task.id, item.id).status, "running");
  assert.equal(currentWorkItemExecutionGroup(store.getWorkItem(task.id, item.id)).lanes.length, 1);
  assert.equal(currentWorkItemExecutionGroup(store.getWorkItem(task.id, item.id)).lanes[0].result.gitSnapshot.projects.length, 1);

  const append = spawnExactTaskCli(home, store, task.id, "leader", [
    "task", "work", "dispatch", item.id,
    "--lane-role", "worker-2"
  ]);
  assert.equal(append.status, 0, append.stderr || append.stdout);
  await stopFileTaskController(home);
  active = store.listAgentRuns(task.id).find(({ purpose, status, roleName }) => (
    purpose === "execution" && status === "active" && roleName === "worker-2"
  ));
  assert.notEqual(active, undefined);
  assert.notEqual(active.workspace.root, store.getWorkItemWorkspace(task.id, item.id).root);
  entry = active.workspace.entries.find(({ access }) => access === "write");
  writeFileSync(join(entry.path, "second-lane.txt"), "second\n");
  execFileSync("git", ["-C", entry.path, "add", "second-lane.txt"]);
  execFileSync("git", ["-C", entry.path, "commit", "-qm", "second lane"]);
  markDelivered(store, active);
  const secondYield = spawnExactTaskCli(home, store, task.id, active.roleName, [
    "task", "run", "yield", active.id, "--summary", "second lane"
  ]);
  assert.equal(secondYield.status, 0, secondYield.stderr || secondYield.stdout);

  const resolved = spawnExactTaskCli(home, store, task.id, "leader", [
    "task", "work", "group", "resolve", item.id,
    "--decision", "accept", "--summary", "adaptive outputs accepted"
  ]);
  assert.equal(resolved.status, 0, resolved.stderr || resolved.stdout);
  const accepted = store.getWorkItem(task.id, item.id);
  assert.equal(accepted.status, "awaiting_acceptance");
  assert.equal(currentWorkItemExecutionGroup(accepted).lanes.length, 2);
  assert.equal(accepted.candidates.length, 1);
  const candidateWorkspace = store.getWorkItemWorkspace(task.id, item.id);
  assert.equal(readFileSync(join(candidateWorkspace.entries[0].path, "first-lane.txt"), "utf8"), "first\n");
  assert.equal(readFileSync(join(candidateWorkspace.entries[0].path, "second-lane.txt"), "utf8"), "second\n");
  assert.equal(existsSync(join(workspace, "tasks", task.id, "execution-lanes")), true);
});

test("failed public multi-Lane dispatch compensates unadopted Lane workspaces", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Compensated Lane dispatch", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath, ["leader", "worker"]);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Dispatch rollback",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);

  const failed = spawnExactTaskCli(home, store, task.id, "leader", [
    "task", "work", "dispatch", item.id,
    "--strategy", "fixed:2",
    "--lane-role", "worker",
    "--lane-role", "missing-role"
  ]);
  assert.notEqual(failed.status, 0);
  assert.match(`${failed.stderr}${failed.stdout}`, /Role not found|Task Role|missing-role/);
  assert.equal(
    store.listManagedWorkspaces(task.id).some(({ owner }) => owner.type === "execution-lane"),
    false
  );
  const laneBranch = "yui/task-1/execution-lane-execution-group-agent-run-1-execution-group-agent-run-1-lane-1";
  assert.equal(
    existsSync(join(workspace, "worktree", project.name, task.id, "execution-lane-execution-group-agent-run-1-execution-group-agent-run-1-lane-1")),
    false
  );
  assert.throws(() => execFileSync(
    "git", ["-C", repositoryPath, "show-ref", "--verify", `refs/heads/${laneBranch}`], { stdio: "ignore" }
  ));
});

test("a new Task never adopts a stale legacy branch and keeps its own token branch", async (t) => {
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
  // A stale branch from a crashed pre-identity attempt: the legacy bare-id
  // segment must never be adopted as the Task's managed branch.
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
  const segment = taskWorkspaceRefSegment(store.getTask(task.id));
  assert.match(segment, new RegExp(`^${task.id}-[a-f0-9]{8}$`));
  const preparedEntry = store.getTaskWorkspace(task.id).entries[0];
  assert.equal(
    execFileSync("git", ["-C", preparedEntry.path, "rev-parse", "HEAD"], {
      encoding: "utf8"
    }).trim(),
    baseCommit
  );
  assert.equal(
    execFileSync("git", ["-C", preparedEntry.path, "branch", "--show-current"], {
      encoding: "utf8"
    }).trim(),
    `yui/${segment}/main`
  );
  // The stale legacy branch is preserved untouched for the history cleanup.
  assert.equal(
    execFileSync("git", ["-C", repositoryPath, "rev-parse", "yui/task-1/main"], {
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
  const segment = taskWorkspaceRefSegment(store.getTask(task.id));
  const isolated = await preparer.prepareWorkItemWorkspace(item.taskId, item.id);
  const isolatedEntry = isolated.entries[0];
  assert.deepEqual(isolated.owner, {
    type: "work-item",
    taskId: task.id,
    workItemId: item.id
  });
  assert.equal(
    isolatedEntry.path,
    join(workspace, "worktree", "Yui", segment, item.id)
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
    ["-C", repositoryPath, "show-ref", "--verify", `refs/heads/yui/${segment}/work-item-1`],
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
      "task", "create", "Current response", "--project", "Yui", "--base", "HEAD"
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
  addTaskRoles(
    store,
    task,
    repositoryPath,
    ["leader", "reviewer"],
    createStartupReadyClaudeAgent(home, NOW, "claude-pending-final")
  );
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

async function pendingExactTaskReviewFixture(t, title) {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", title, NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), NOW);
  addTaskRoles(store, task, repositoryPath, ["leader", "reviewer"]);
  store.saveConfig({
    ...store.getConfig(),
    defaultWorkspace: workspace,
    review: { roleName: "reviewer", trigger: "final" }
  });
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const taskEntry = store.getTaskWorkspace(task.id).entries[0];
  const taskHead = git(["-C", taskEntry.path, "rev-parse", "HEAD"]).trim();
  const firstInvocation = exactTaskCliInvocation({
    home,
    store,
    taskId: task.id,
    roleName: "leader",
    taskFinalReviewerRole: "reviewer"
  });
  const contract = createTaskFinalReviewContract({
    taskId: task.id,
    reviewerRoleName: "reviewer",
    controlPlaneDigest: firstInvocation.controlDigest
  });
  const item = updateWorkItemStatus(createWorkItem("work-item-1", task.id, {
    title: "Accepted delivery awaiting final Review",
    writeProjectIds: [project.id]
  }, NOW), "running", NOW);
  const submitted = submitWorkItemCandidate(item, {
    summary: "Accepted delivery",
    source: { type: "direct" },
    reviewPolicy: { roleName: "reviewer", trigger: "final" },
    taskFinalReviewContract: contract
  }, NOW);
  store.saveWorkItem(task.id, updateWorkItemStatus(
    submitted,
    "completed",
    NOW,
    "Accepted before final Review."
  ));

  // Simulate the first exact CLI process ending immediately after its command
  // transaction commits the pending Round, before workspace preparation or
  // Reviewer dispatch runs in the outer CLI layer.
  const first = runTaskCommand([
    "complete", task.id, "--summary", "Request the final Review."
  ], store, {
    now: () => new Date(NOW),
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    },
    taskFinalReviewContract: contract,
    actualTaskReviewCandidate: {
      schemaVersion: 1,
      projects: [{ projectId: project.id, commit: taskHead }]
    }
  });
  assert.match(first.output, /Final Task Review requested as review-round-1/);
  const pending = store.getReviewRound(task.id, "review-round-1");
  assert.equal(pending.status, "pending");
  assert.equal(pending.reviewerRunId, undefined);
  assert.equal(pending.workspace, undefined);
  assert.equal(store.getReviewRoundWorkspace(task.id, pending.id), null);
  assert.equal(store.listAgentRuns(task.id).filter(({ purpose }) => purpose === "review").length, 0);

  return {
    home,
    workspace,
    repositoryPath,
    store,
    project,
    task,
    preparer,
    pending
  };
}

function spawnExactFinalTaskComplete(fx, summary) {
  const store = new FileTaskStore(fx.home);
  const invocation = exactTaskCliInvocation({
    home: fx.home,
    store,
    taskId: fx.task.id,
    roleName: "leader",
    taskFinalReviewerRole: "reviewer"
  });
  return spawnSync(process.execPath, [
    invocation.cliEntry,
    ...invocation.prefix,
    "task", "complete", fx.task.id, "--summary", summary
  ], { encoding: "utf8", env: invocation.environment });
}

function saveDeliveredLeaderControlRun(fx) {
  const leader = fx.store.getRole(fx.task.id, "leader");
  const workspace = fx.store.getTaskWorkspace(fx.task.id);
  const run = createAgentRun(
    fx.store.nextAgentRunId(fx.task.id),
    fx.task.id,
    leader.name,
    "resume",
    "Resume exact Task-final Review recovery.",
    NOW,
    {
      workspace,
      effective: resolveEffectiveLaunch({
        role: leader,
        purpose: "execution",
        workspace
      })
    }
  );
  fx.store.transaction((tx) => {
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    tx.saveRole(fx.task.id, updateRoleStatus(leader, "running", NOW));
  });
  markDelivered(fx.store, run);
  return fx.store.getAgentRun(fx.task.id, run.id);
}

test("exact Task complete resumes one durably pending final Review after the prior process exits", async (t) => {
  const fx = await pendingExactTaskReviewFixture(t, "Resume the interrupted final Review");

  // A new process and store instance must resume that exact durable Round.
  const reopened = new FileTaskStore(fx.home);
  assert.deepEqual(reopened.getReviewRound(fx.task.id, fx.pending.id), fx.pending);
  const recovered = spawnExactFinalTaskComplete(fx, "Resume the interrupted final Review.");
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.match(recovered.stdout, /Review queued as review-round-1 \(agent-run-1\)/);

  const afterRecovery = new FileTaskStore(fx.home);
  const rounds = afterRecovery.listReviewRounds(fx.task.id);
  const reviewRuns = afterRecovery.listAgentRuns(fx.task.id)
    .filter(({ purpose }) => purpose === "review");
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].id, fx.pending.id);
  assert.equal(rounds[0].status, "running", rounds[0].summary);
  assert.equal(rounds[0].reviewerRunId, "agent-run-1");
  assert.equal(reviewRuns.length, 1);
  assert.equal(reviewRuns[0].reviewRoundId, fx.pending.id);

  const repeated = spawnExactFinalTaskComplete(fx, "Do not duplicate the recovered Review.");
  assert.equal(repeated.error, undefined);
  const afterRepeated = new FileTaskStore(fx.home);
  assert.equal(afterRepeated.listReviewRounds(fx.task.id).length, 1);
  assert.equal(
    afterRepeated.listAgentRuns(fx.task.id).filter(({ purpose }) => purpose === "review").length,
    1
  );
});

test("resumed pending Task-final Review preserves history when the dispatch HEAD fence drifts", async (t) => {
  const fx = await pendingExactTaskReviewFixture(t, "Reject a late Task HEAD drift");
  const taskEntry = fx.store.getTaskWorkspace(fx.task.id).entries[0];
  const trigger = join(fx.repositoryPath, ".git", "hooks", "late-head-drift.trigger");
  const hook = join(fx.repositoryPath, ".git", "hooks", "post-checkout");
  writeFileSync(trigger, "advance Task main during Review workspace preparation\n");
  writeFileSync(hook, [
    "#!/bin/sh",
    `if [ -f ${JSON.stringify(trigger)} ]; then`,
    `  rm ${JSON.stringify(trigger)}`,
    `  printf 'late drift\\n' > ${JSON.stringify(join(taskEntry.path, "late-drift.txt"))}`,
    `  git -C ${JSON.stringify(taskEntry.path)} add late-drift.txt`,
    `  git -C ${JSON.stringify(taskEntry.path)} commit -qm 'late Task head drift'`,
    "fi",
    ""
  ].join("\n"));
  chmodSync(hook, 0o755);

  const rejected = spawnExactFinalTaskComplete(
    fx,
    "Reject the Task head that moved after workspace preparation."
  );
  assert.notEqual(rejected.status, 0, rejected.stderr || rejected.stdout);
  assert.match(
    rejected.stderr,
    /freezes a candidate that is no longer the current Task candidate/i
  );

  const stored = new FileTaskStore(fx.home);
  const round = stored.getReviewRound(fx.task.id, fx.pending.id);
  assert.equal(round.status, "pending");
  assert.equal(round.reviewerRunId, undefined);
  assert.deepEqual(round.taskCandidate, fx.pending.taskCandidate);
  assert.deepEqual(round.taskFinalReviewContract, fx.pending.taskFinalReviewContract);
  assert.notEqual(round.workspace, undefined);
  assert.equal(stored.listReviewRounds(fx.task.id).length, 1);
  assert.equal(stored.listAgentRuns(fx.task.id).filter(({ purpose }) => purpose === "review").length, 0);
});

test("Task-final recovery head mismatch rolls back exact Leader terminalization", async (t) => {
  const fx = await pendingExactTaskReviewFixture(
    t,
    "Keep the exact Leader fence on an earlier Task head mismatch"
  );
  const leaderRun = saveDeliveredLeaderControlRun(fx);
  const taskEntry = fx.store.getTaskWorkspace(fx.task.id).entries[0];
  writeFileSync(join(taskEntry.path, "earlier-head-drift.txt"), "earlier head drift\n");
  git(["-C", taskEntry.path, "add", "earlier-head-drift.txt"]);
  git(["-C", taskEntry.path, "commit", "-qm", "earlier Task head drift"]);

  const rejected = spawnExactFinalTaskComplete(
    fx,
    "Reject the mismatched head before committing Leader terminalization."
  );
  assert.notEqual(rejected.status, 0, rejected.stderr || rejected.stdout);
  assert.match(
    rejected.stderr,
    /freezes a candidate that is no longer the current Task candidate/i
  );

  const stored = new FileTaskStore(fx.home);
  assert.equal(stored.getTask(fx.task.id).status, "active");
  assert.equal(stored.getAgentRun(fx.task.id, leaderRun.id).status, "active");
  assert.equal(stored.getActiveAgentRun(fx.task.id, "leader").id, leaderRun.id);
  assert.deepEqual(stored.getReviewRound(fx.task.id, fx.pending.id), fx.pending);
  assert.equal(
    stored.getWorkMailbox({
      kind: "role",
      taskId: fx.task.id,
      roleName: "leader"
    }).pending,
    null
  );
  assert.equal(stored.listAgentRuns(fx.task.id).filter(({ purpose }) => purpose === "review").length, 0);
});

test("late drift after exact Leader terminalization fails the resumed final Review and wakes one Leader", async (t) => {
  const fx = await pendingExactTaskReviewFixture(
    t,
    "Retain a durable owner after late final Review drift"
  );
  const leaderRun = saveDeliveredLeaderControlRun(fx);
  assert.equal(leaderRun.status, "active");
  assert.notEqual(leaderRun.pushedAt, undefined);
  assert.notEqual(leaderRun.deliveredAt, undefined);

  const taskEntry = fx.store.getTaskWorkspace(fx.task.id).entries[0];
  const trigger = join(fx.repositoryPath, ".git", "hooks", "late-leader-drift.trigger");
  const hook = join(fx.repositoryPath, ".git", "hooks", "post-checkout");
  writeFileSync(trigger, "advance Task main after exact Leader terminalization\n");
  writeFileSync(hook, [
    "#!/bin/sh",
    `if [ -f ${JSON.stringify(trigger)} ]; then`,
    `  rm ${JSON.stringify(trigger)}`,
    `  printf 'late Leader drift\\n' > ${JSON.stringify(join(taskEntry.path, "late-leader-drift.txt"))}`,
    `  git -C ${JSON.stringify(taskEntry.path)} add late-leader-drift.txt`,
    `  git -C ${JSON.stringify(taskEntry.path)} commit -qm 'late Leader Task head drift'`,
    "fi",
    ""
  ].join("\n"));
  chmodSync(hook, 0o755);

  const completed = spawnExactFinalTaskComplete(
    fx,
    "Terminalize the exact Leader before the late Review drift."
  );
  const stored = new FileTaskStore(fx.home);
  const round = stored.getReviewRound(fx.task.id, fx.pending.id);
  const terminalLeader = stored.getAgentRun(fx.task.id, leaderRun.id);
  const leaderMailbox = stored.getWorkMailbox({
    kind: "role",
    taskId: fx.task.id,
    roleName: "leader"
  });
  const observed = {
    taskStatus: stored.getTask(fx.task.id).status,
    leaderStatus: terminalLeader.status,
    activeLeaderRunId: stored.getActiveAgentRun(fx.task.id, "leader")?.id ?? null,
    roundStatus: round.status,
    reviewerRunId: round.reviewerRunId,
    reviewRunCount: stored.listAgentRuns(fx.task.id)
      .filter(({ purpose }) => purpose === "review").length,
    leaderWakeReasons: leaderMailbox?.pending?.reasons ?? []
  };
  assert.deepEqual(observed, {
    taskStatus: "active",
    leaderStatus: "yielded",
    activeLeaderRunId: null,
    roundStatus: "failed",
    reviewerRunId: undefined,
    reviewRunCount: 0,
    leaderWakeReasons: ["review-failed"]
  }, `reachable stranded lifecycle state: ${JSON.stringify(observed)}`);
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  assert.match(completed.stdout, /Review could not start/);
  assert.match(round.summary, /no longer the current Task candidate/i);
  assert.deepEqual(round.taskCandidate, fx.pending.taskCandidate);
  assert.deepEqual(round.taskFinalReviewContract, fx.pending.taskFinalReviewContract);
  assert.notEqual(round.workspace, undefined);
  assert.deepEqual(stored.getReviewRoundWorkspace(fx.task.id, round.id), round.workspace);
  assert.equal(stored.listReviewRounds(fx.task.id).length, 1);
  assert.deepEqual(leaderMailbox.pending?.refs, [{
    type: "work-item",
    taskId: fx.task.id,
    id: fx.pending.workItemId
  }]);
  assert.equal(leaderMailbox.pending?.requestCount, 1);
});

test("pending Task-final recovery safely reuses a retained diagnostic branch", async (t) => {
  const fx = await pendingExactTaskReviewFixture(t, "Reuse retained Review diagnostics");
  const workspace = await fx.preparer.prepareReviewRoundWorkspace(
    fx.task.id,
    fx.pending.id
  );
  const entry = workspace.entries[0];
  writeFileSync(join(entry.path, "retained-diagnostic.txt"), "retained diagnostic\n");
  git(["-C", entry.path, "add", "retained-diagnostic.txt"]);
  git(["-C", entry.path, "commit", "-qm", "retained Review diagnostic"]);
  const diagnosticHead = git(["-C", entry.path, "rev-parse", "HEAD"]).trim();
  const reviewSegment = taskWorkspaceRefSegment(fx.store.getTask(fx.task.id));
  assert.equal(await new NodeGitWorkspace().removeWorktree({
    repositoryPath: fx.project.path,
    container: join(fx.workspace, "worktree", fx.project.name),
    taskSegment: reviewSegment,
    roleName: fx.pending.id
  }), "removed");
  assert.equal(existsSync(entry.path), false);

  const recovered = spawnExactFinalTaskComplete(
    fx,
    "Resume from the retained diagnostic branch."
  );
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  const stored = new FileTaskStore(fx.home);
  const round = stored.getReviewRound(fx.task.id, fx.pending.id);
  assert.equal(
    round.status,
    "running",
    recovered.stderr || recovered.stdout || round.summary
  );
  assert.equal(git(["-C", entry.path, "rev-parse", "HEAD"]).trim(), diagnosticHead);
  assert.equal(stored.listReviewRounds(fx.task.id).length, 1);
  assert.equal(stored.listAgentRuns(fx.task.id).filter(({ purpose }) => purpose === "review").length, 1);
});

test("pending Task-final recovery preserves incompatible physical workspace evidence", async (t) => {
  const fx = await pendingExactTaskReviewFixture(t, "Reject drifted Review workspace evidence");
  const workspace = await fx.preparer.prepareReviewRoundWorkspace(
    fx.task.id,
    fx.pending.id
  );
  const entry = workspace.entries[0];
  git(["-C", entry.path, "checkout", "--detach"]);
  const frozenRound = structuredClone(
    new FileTaskStore(fx.home).getReviewRound(fx.task.id, fx.pending.id)
  );

  const rejected = spawnExactFinalTaskComplete(fx, "Do not adopt drifted workspace evidence.");
  assert.notEqual(rejected.status, 0, rejected.stderr || rejected.stdout);
  assert.match(rejected.stderr, /ReviewRound workspace managed branch mismatch/i);
  let stored = new FileTaskStore(fx.home);
  assert.deepEqual(stored.getReviewRound(fx.task.id, fx.pending.id), frozenRound);
  assert.equal(stored.listReviewRounds(fx.task.id).length, 1);
  assert.equal(stored.listAgentRuns(fx.task.id).filter(({ purpose }) => purpose === "review").length, 0);

  git(["-C", entry.path, "checkout", "-q", entry.branch]);
  const recovered = spawnExactFinalTaskComplete(fx, "Resume after restoring exact workspace evidence.");
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  stored = new FileTaskStore(fx.home);
  assert.equal(stored.listReviewRounds(fx.task.id).length, 1);
  assert.equal(stored.listAgentRuns(fx.task.id).filter(({ purpose }) => purpose === "review").length, 1);
});

test("ordinary pending Task-final workspace preparation failure records the Round as failed", async (t) => {
  const fx = await pendingExactTaskReviewFixture(t, "Fail an ordinary Review preparation");
  writeFileSync(join(fx.repositoryPath, "stale-review.txt"), "stale branch\n");
  git(["-C", fx.repositoryPath, "add", "stale-review.txt"]);
  git(["-C", fx.repositoryPath, "commit", "-qm", "stale review branch"]);
  const identity = worktreeIdentity(
    taskWorkspaceRefSegment(fx.store.getTask(fx.task.id)),
    fx.pending.id
  );
  const stalePath = join(fx.workspace, "worktree", fx.project.name, identity.directory);
  mkdirSync(join(stalePath, ".."), { recursive: true });
  execFileSync("git", [
    "-C", fx.repositoryPath,
    "worktree", "add", "-b", identity.branch,
    stalePath,
    "HEAD"
  ], { stdio: "ignore" });

  const failed = spawnExactFinalTaskComplete(fx, "Record the ordinary preparation failure.");
  assert.equal(failed.status, 0, failed.stderr || failed.stdout);
  assert.match(failed.stdout, /Review could not start:.*baseCommit mismatch/is);
  const stored = new FileTaskStore(fx.home);
  const round = stored.getReviewRound(fx.task.id, fx.pending.id);
  assert.equal(round.status, "failed");
  assert.match(round.summary, /baseCommit mismatch/i);
  assert.equal(stored.listReviewRounds(fx.task.id).length, 1);
  assert.equal(stored.listAgentRuns(fx.task.id).filter(({ purpose }) => purpose === "review").length, 0);
});

test("exact Task completion rejects Task-main drift after the latest Integration", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Review the actual Task head", NOW, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }],
    requireIntegration: true
  }), NOW);
  addTaskRoles(store, task, repositoryPath, ["leader", "reviewer"]);
  store.saveConfig({
    ...store.getConfig(),
    defaultWorkspace: workspace,
    review: { roleName: "reviewer", trigger: "final" }
  });
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const taskEntry = store.getTaskWorkspace(task.id).entries[0];
  const baseCommit = git(["-C", taskEntry.path, "rev-parse", "HEAD"]).trim();
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
  const item = updateWorkItemStatus(createWorkItem("work-item-1", task.id, {
    title: "Integrated delivery",
    writeProjectIds: [project.id]
  }, NOW), "running", NOW);
  const submitted = submitWorkItemCandidate(item, {
    summary: "Integrated delivery",
    source: { type: "direct" },
    reviewPolicy: { roleName: "reviewer", trigger: "final" },
    taskFinalReviewContract: contract
  }, NOW);
  store.saveWorkItem(task.id, updateWorkItemStatus(
    submitted,
    "completed",
    NOW,
    "Accepted for final Review."
  ));

  writeFileSync(join(taskEntry.path, "integrated.txt"), "integrated\n");
  git(["-C", taskEntry.path, "add", "integrated.txt"]);
  git(["-C", taskEntry.path, "commit", "-qm", "integrated"]);
  const integratedCommit = git(["-C", taskEntry.path, "rev-parse", "HEAD"]).trim();
  const changeSet = createWorkItemChangeSet({
    id: "change-set-1",
    taskId: task.id,
    projectId: project.id,
    workItemId: item.id,
    baseCommit,
    headCommit: integratedCommit,
    branch: taskEntry.branch,
    changedPaths: ["integrated.txt"]
  }, NOW);
  const integration = updateIntegrationAttempt(createIntegrationAttempt({
    id: "integration-1",
    taskId: task.id,
    projectId: project.id,
    targetRef: taskEntry.branch,
    expectedHead: baseCommit,
    changeSetIds: [changeSet.id],
    checkCommands: []
  }, NOW), { status: "committed", candidateCommit: integratedCommit }, NOW);
  store.transaction((tx) => {
    tx.saveChangeSet(task.id, changeSet);
    tx.saveIntegrationAttempt(task.id, integration);
  });

  writeFileSync(join(taskEntry.path, "drift.txt"), "unintegrated drift\n");
  git(["-C", taskEntry.path, "add", "drift.txt"]);
  git(["-C", taskEntry.path, "commit", "-qm", "post-integration drift"]);
  const actualCommit = git(["-C", taskEntry.path, "rev-parse", "HEAD"]).trim();
  assert.notEqual(actualCommit, integratedCommit);

  const result = spawnSync(process.execPath, [
    invocation.cliEntry,
    ...invocation.prefix,
    "task", "complete", task.id, "--summary", "Request exact final Review."
  ], { encoding: "utf8", env: invocation.environment });
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /actual Task head.*latest committed Integration/i);
  assert.equal(store.listReviewRounds(task.id).length, 0);
  assert.equal(store.getTask(task.id).status, "active");
});

test("a reviewer launches from a fresh ReviewRound workspace and leaves Project Skills to the Agent", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const projectSkillDirectory = join(
    repositoryPath,
    ".agents",
    "skills",
    "project-review"
  );
  mkdirSync(projectSkillDirectory, { recursive: true });
  writeFileSync(
    join(projectSkillDirectory, "SKILL.md"),
    "# Project review\n\nUse the Project review workflow.\n"
  );
  execFileSync("git", ["-C", repositoryPath, "add", ".agents"]);
  execFileSync("git", ["-C", repositoryPath, "commit", "-qm", "add project skill"]);
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
  assert.equal(plan.role.cwd, reviewRun.workspace.entries[0].path);
  assert.equal(plan.launch.env.YUI_WORKSPACE, reviewRun.workspace.root);
  assert.deepEqual(
    plan.launch.args.slice(
      plan.launch.args.indexOf(reviewRun.workspace.root) - 1,
      plan.launch.args.indexOf(reviewRun.workspace.root) + 1
    ),
    ["--add-dir", reviewRun.workspace.root]
  );
  const developerInstructions = plan.launch.args.find((argument) => (
    argument.startsWith("developer_instructions=")
  ));
  assert.ok(developerInstructions);
  assert.match(developerInstructions, /injected yui-reviewer/u);
  assert.match(developerInstructions, /skills\/yui-reviewer/u);
  assert.doesNotMatch(developerInstructions, /skills\/yui-worker/u);
  assert.equal(existsSync(join(
    reviewRun.workspace.entries[0].path,
    ".agents",
    "skills",
    "project-review",
    "SKILL.md"
  )), true);
  assert.doesNotMatch(developerInstructions, /project-review|Project review workflow/u);
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
  const agent = addTaskRoles(
    store,
    task,
    repositoryPath,
    ["leader", "worker"],
    createStartupReadyClaudeAgent(home, NOW, "claude-review-delivery")
  );
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
  // The CLI has durably queued the Review. Quiesce the fixture Controller
  // before reading that handoff so a real local adapter cannot terminalize
  // the Run during this deterministic workspace test.
  await stopFileTaskController(home);

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
  const identity = worktreeIdentity(taskWorkspaceRefSegment(store.getTask(task.id)), round.id);
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
  const identity = worktreeIdentity(taskWorkspaceRefSegment(store.getTask(task.id)), round.id);
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
    taskSegment: taskWorkspaceRefSegment(store.getTask(task.id)),
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
  // This test drives the Mock review result explicitly.  The public CLI may
  // have started the fixture Controller to deliver the queued wake, so stop
  // that exact Controller before reading and mutating the Run deterministically.
  await stopFileTaskController(home);
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
  // Keep this deterministic workspace assertion independent of the fixture
  // Controller's asynchronous Mock delivery and terminalization path.
  await stopFileTaskController(home);

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
  assert.notEqual(candidate.gitSnapshot, undefined);
  assert.equal(candidate.gitSnapshot.projects.length, 1);
});

test("public fixed(1) Worker yield freezes a Candidate Git snapshot", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Fixed one snapshot", NOW, {
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
    title: "One Lane output",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const dispatched = spawnExactTaskCli(home, store, task.id, "leader", [
    "task", "work", "dispatch", item.id
  ]);
  assert.equal(dispatched.status, 0, dispatched.stderr || dispatched.stdout);
  await stopFileTaskController(home);
  const active = store.listAgentRuns(task.id).find(({ purpose, status, roleName }) => (
    purpose === "execution" && status === "active" && roleName === "worker"
  ));
  assert.notEqual(active, undefined);
  const entry = active.workspace.entries.find(({ access }) => access === "write");
  writeFileSync(join(entry.path, "fixed-one.txt"), "fixed one\n");
  execFileSync("git", ["-C", entry.path, "add", "fixed-one.txt"]);
  execFileSync("git", ["-C", entry.path, "commit", "-qm", "fixed one"]);
  const commit = execFileSync("git", ["-C", entry.path, "rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();
  markDelivered(store, active);
  const yielded = spawnExactTaskCli(home, store, task.id, "worker", [
    "task", "run", "yield", active.id, "--summary", "fixed one result"
  ]);
  assert.equal(yielded.status, 0, yielded.stderr || yielded.stdout);
  const candidate = store.getWorkItem(task.id, item.id).candidates.at(-1);
  assert.notEqual(candidate, undefined);
  assert.equal(candidate.gitSnapshot.projects.length, 1);
  assert.equal(candidate.gitSnapshot.projects[0].projectId, project.id);
  assert.equal(candidate.gitSnapshot.projects[0].commit, commit);
  assert.equal(candidate.workspace.root, join(workspace, "tasks", task.id, "work-items", item.id));
});

test("public Gitless Worker yield completes without inventing Git output", async (t) => {
  const { home, workspace, store, repositoryPath } = fixture(t);
  const task = activateTask(createTask("task-1", "Gitless execution", NOW), NOW);
  addTaskRoles(
    store,
    task,
    repositoryPath,
    ["leader", "worker"],
    createStartupReadyClaudeAgent(home, NOW, "claude-mock")
  );
  const item = createWorkItem("work-item-1", task.id, {
    title: "Report-only output",
    assignee: "worker",
    writeProjectIds: []
  }, NOW);
  store.saveWorkItem(task.id, item);
  const dispatched = spawnExactTaskCli(home, store, task.id, "leader", [
    "task", "work", "dispatch", item.id
  ]);
  assert.equal(dispatched.status, 0, dispatched.stderr || dispatched.stdout);
  const taskWorkspace = store.getTaskWorkspace(task.id);
  assert.notEqual(taskWorkspace, null);
  assert.deepEqual(taskWorkspace.owner, { type: "task", taskId: task.id });
  assert.equal(taskWorkspace.root, join(workspace, "tasks", task.id, "main"));
  assert.deepEqual(taskWorkspace.entries, []);
  assert.equal(store.getTask(task.id).cwd, taskWorkspace.root);
  assert.equal(store.getRole(task.id, "worker").workspace, taskWorkspace.root);
  const active = store.getActiveAgentRun(task.id, "worker");
  assert.notEqual(active, null);
  // Establish the Mock Session delivery fence before stopping the isolated
  // Controller; this keeps the test independent of stop-vs-launch timing.
  markDelivered(store, active);
  await stopFileTaskController(home);
  const yielded = spawnExactTaskCli(home, store, task.id, "worker", [
    "task", "run", "yield", active.id, "--summary", "report-only result"
  ]);
  assert.equal(yielded.status, 0, yielded.stderr || yielded.stdout);
  const candidate = store.getWorkItem(task.id, item.id).candidates.at(-1);
  assert.equal(store.getWorkItem(task.id, item.id).status, "awaiting_acceptance");
  assert.equal(candidate.workspace, undefined);
  assert.equal(candidate.gitSnapshot, undefined);
});

test("Gitless Task workspace preparation is idempotent and archive cleanup removes its owner", async (t) => {
  const { home, workspace, store, repositoryPath } = fixture(t);
  const task = activateTask(createTask("task-1", "Gitless lifecycle", NOW), NOW);
  addTaskRoles(store, task, repositoryPath, ["leader"]);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));

  await preparer.prepareTaskWorkspace(task.id);
  const first = store.getTaskWorkspace(task.id);
  assert.notEqual(first, null);
  const firstRecord = structuredClone(first);
  await preparer.prepareTaskWorkspace(task.id);
  assert.deepEqual(store.getTaskWorkspace(task.id), firstRecord);

  store.saveTask(completeTask(store.getTask(task.id), NOW, {
    summary: "Gitless lifecycle complete",
    by: "leader"
  }));
  const cleaned = await preparer.cleanupTaskForArchive(task.id);
  assert.equal(cleaned.status, "removed");
  assert.equal(store.getTaskWorkspace(task.id), null);
  assert.equal(existsSync(join(workspace, "tasks", task.id, "main")), false);
  runTaskCommand(["archive", task.id, "--integrated"], store, { now: () => new Date(NOW) });
  assert.equal(store.getTask(task.id).status, "archived");
});

test("public multi-Lane retry reuses the failed Lane workspace", async (t) => {
  const { home, workspace, repositoryPath, store } = fixture(t);
  const project = await addProject(store, repositoryPath);
  const task = activateTask(createTask("task-1", "Retry one Lane", NOW, {
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
    ["leader", "worker", "worker-2"],
    createStartupReadyClaudeAgent(home, NOW, "claude-mock")
  );
  const item = createWorkItem("work-item-1", task.id, {
    title: "Retry a failed panel Lane",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, NOW);
  store.saveWorkItem(task.id, item);
  const dispatched = spawnExactTaskCli(home, store, task.id, "leader", [
    "task", "work", "dispatch", item.id,
    "--strategy", "fixed:2", "--lane-role", "worker-2"
  ]);
  assert.equal(dispatched.status, 0, dispatched.stderr || dispatched.stdout);
  await stopFileTaskController(home);
  const activeRuns = store.listAgentRuns(task.id).filter(({ purpose, status }) => (
    purpose === "execution" && status === "active"
  ));
  const failed = activeRuns.find(({ roleName }) => roleName === "worker-2");
  const survivor = activeRuns.find(({ roleName }) => roleName === "worker");
  assert.notEqual(failed, undefined);
  assert.notEqual(survivor, undefined);
  const originalRoot = failed.workspace.root;
  markDelivered(store, failed);
  const failedAt = new Date(Math.max(Date.now(), Date.parse(
    store.getWorkItem(task.id, item.id).updatedAt
  )));
  store.transaction((tx) => {
    const result = terminalizeExactTaskRun(tx, {
      taskId: task.id,
      roleName: failed.roleName,
      agentId: failed.effective.agentId,
      runId: failed.id,
      receiptId: formatAgentRunReceiptId(task.id, failed.id),
      nativeSessionId: tx.getTaskRoleSessionSet(task.id, failed.roleName)
        ?.sessions[failed.effective.agentId]?.nativeSessionId,
      outcome: { status: "failed", summary: "transient lane failure" }
    }, failedAt);
    assert.equal(result.disposition, "applied");
  });
  const retried = spawnExactTaskCli(home, store, task.id, "leader", [
    "task", "run", "retry", failed.id
  ]);
  assert.equal(retried.status, 0, retried.stderr || retried.stdout);
  await stopFileTaskController(home);
  const retryRun = store.getActiveAgentRun(task.id, failed.roleName);
  assert.notEqual(retryRun, null);
  assert.equal(retryRun.executionLaneId, failed.executionLaneId);
  assert.equal(retryRun.workspace.root, originalRoot);
  assert.equal(store.getWorkItem(task.id, item.id).status, "running");
  assert.equal(currentWorkItemExecutionGroup(store.getWorkItem(task.id, item.id)).lanes.length, 2);
  assert.equal(store.getActiveAgentRun(task.id, survivor.roleName).id, survivor.id);
  assert.equal(existsSync(join(workspace, "tasks", task.id, "execution-lanes")), true);
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
  assert.notEqual(candidate.gitSnapshot, undefined);
  assert.equal(candidate.gitSnapshot.projects[0].projectId, project.id);
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
  store.saveWorkItem(task.id, item);
  writeFileSync(join(mainPath, "direct-main.txt"), "direct main delivery\n");
  git(["-C", mainPath, "add", "direct-main.txt"]);
  git(["-C", mainPath, "commit", "-qm", "direct main delivery"]);
  const head = git(["-C", mainPath, "rev-parse", "HEAD"]).trim();
  const submitted = spawnSync(process.execPath, [
    invocation.cliEntry,
    ...invocation.prefix,
    "task", "work", "update", item.id, "done",
    "--summary", "Direct Task main is ready for provenance capture."
  ], { encoding: "utf8", env: invocation.environment });
  assert.equal(submitted.status, 0, submitted.stderr || submitted.stdout);
  const candidate = store.getWorkItem(task.id, item.id).candidates.at(-1);
  assert.equal(candidate.source.type, "direct");
  assert.deepEqual(candidate.taskMainSnapshot.projects, [{
    projectId: project.id,
    directory: taskEntry.directory,
    branch: taskEntry.branch,
    baseCommit: taskEntry.baseCommit,
    headCommit: head
  }]);

  // A normal Controller preparation observes the physical HEAD and advances
  // the mutable Task workspace record. Capture must still use the Candidate's
  // frozen boundary rather than silently reporting an empty result.
  await preparer.prepareTaskWorkspace(task.id);
  assert.equal(
    store.getTaskWorkspace(task.id).entries.find(({ projectId }) => projectId === project.id)
      .baseCommit,
    head
  );
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

  const captureInvocation = exactTaskCliInvocation({
    home,
    store,
    taskId: task.id,
    roleName: "leader",
    taskFinalReviewerRole: "reviewer"
  });
  const captured = spawnSync(process.execPath, [
    captureInvocation.cliEntry,
    ...captureInvocation.prefix,
    "task", "work", "capture", item.id
  ], { encoding: "utf8", env: captureInvocation.environment });
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
  // The review result durably queues a Leader wake.  Quiesce this fixture's
  // exact Controller before reading or completing the review so its
  // asynchronous scheduler cannot race the test's explicit state driver.
  await stopFileTaskController(home);
  const round = store.listReviewRounds(task.id)[0];
  const reviewRun = store.getActiveAgentRun(task.id, "reviewer");
  markDelivered(store, reviewRun);
  // The direct yield still folds the durable result; omitting the optional
  // runtime signal here preserves the pending wake for the archive scanner.
  const finished = runTaskCommand(
    ["run", "yield", `${task.id}/${reviewRun.id}`, "--summary", "Review complete"],
    store,
    {
      environment: {},
      yuiHome: home,
      reviewWorkspaceResult: await preparer.snapshotReviewRunResult(task.id, reviewRun),
      executionLaneGitSnapshot: await preparer.snapshotExecutionLaneWorkspace(reviewRun.workspace)
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
  const identity = worktreeIdentity(
    taskWorkspaceRefSegment(store.getTask(task.id)),
    result.data.workItem.id
  );
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
