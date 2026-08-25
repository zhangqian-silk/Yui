import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import { effectiveLaunchSnapshotsCompatibleForTaskMain } from "../../dist/executor/effectiveLaunch.js";
import { createProject } from "../../dist/repository/project.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { finishReviewRound } from "../../dist/review/reviewRound.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { projectCompletionReadiness } from "../../dist/task/completionReadiness.js";
import { projectNextAction } from "../../dist/task/nextAction.js";
import { planRepairWave } from "../../dist/task/repairWave.js";
import { createTask } from "../../dist/task/task.js";

const now = new Date("2026-08-24T00:00:00.000Z");
const binding = {
  projectId: "project-1",
  directory: "app",
  baseRef: "master"
};

function nextActionFacts(task) {
  return {
    task,
    workItems: [],
    changeSets: [],
    integrations: [],
    reviewRounds: [],
    taskFinalReviewContractEvents: [],
    reviewConfig: { roleName: "reviewer", trigger: "final" },
    openInputRequests: [],
    activeRuns: [],
    leaderRuns: []
  };
}

function completionFacts(task, overrides = {}) {
  return {
    ...nextActionFacts(task),
    agentRuns: [],
    roleSessionSets: [],
    managedWorkspaces: [],
    durableJobs: [],
    integrationQueueEntries: [],
    reviewFindings: [],
    reviewFindingLedgerMode: "off",
    events: [],
    ...overrides
  };
}

function configuredStore(t, prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  store.saveConfiguredAgent(createConfiguredAgent(
    "codex",
    "codex",
    "codex",
    [],
    [],
    now
  ));
  store.saveConfig({ ...store.getConfig(), defaultAgent: "codex" });
  store.saveGlobalRole(createGlobalRole(
    "reviewer",
    [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
    "codex",
    home,
    now
  ));
  store.saveProject(createProject(
    binding.projectId,
    "app",
    home,
    { stable: "master", development: "master" },
    now
  ));
  return store;
}

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8"
  }).trim();
}

test("Project Tasks describe intent while the Leader owns delivery topology", () => {
  assert.equal(createTask("task-1", "metadata", now).type, undefined);
  const bugfix = {
    ...createTask("task-2", "fast fix", now, {
      type: "bugfix",
      projectBindings: [binding]
    }),
    status: "active"
  };
  const feature = {
    ...createTask("task-3", "larger change", now, {
      type: "feature",
      projectBindings: [binding]
    }),
    status: "active"
  };
  assert.equal(bugfix.type, "bugfix");
  assert.equal(feature.type, "feature");

  const bugfixAction = projectNextAction(nextActionFacts(bugfix));
  assert.equal(bugfixAction.kind, "complete-task");
  assert.equal(bugfixAction.alternatives?.[0]?.kind, "request-final-review");

  const featureAction = projectNextAction(nextActionFacts(feature));
  assert.equal(featureAction.kind, "complete-task");
  assert.match(featureAction.judgmentRequired, /WorkItem/u);

  const obligated = projectNextAction({
    ...nextActionFacts(bugfix),
    reviewRounds: [{
      id: "review-round-1",
      taskId: bugfix.id,
      scope: "task",
      status: "pending",
      reviewerRoleName: "reviewer"
    }]
  });
  assert.equal(obligated.kind, "resume-review");
  assert.equal(obligated.recommendedCommand, "yui task review retry task-2/review-round-1");
});

test("the CLI records feature or bugfix intent and rejects delivery-mode selection", (t) => {
  const store = configuredStore(t, "yui-agile-delivery-");
  const bugfix = runTaskCommand([
    "create", "fast fix", "--project", binding.projectId, "--type", "bugfix"
  ], store, { now: () => now });
  assert.equal(bugfix.data.task.type, "bugfix");
  assert.match(bugfix.output, /Type: bugfix/u);

  const feature = runTaskCommand([
    "create", "larger change", "--project", binding.projectId, "--type", "feature"
  ], store, { now: () => now });
  assert.equal(feature.data.task.type, "feature");

  assert.throws(() => runTaskCommand([
    "create", "obsolete selection", "--project", binding.projectId,
    "--delivery", "integrated"
  ], store, { now: () => now }), /Unsupported option: --delivery/u);
  assert.throws(() => runTaskCommand([
    "create", "obsolete flag", "--project", binding.projectId,
    "--require-integration"
  ], store, { now: () => now }), /Unsupported option: --require-integration/u);
});

test("Task-final Reviews target the frozen Task rather than a synthetic WorkItem", async (t) => {
  const { createTaskReviewRound } = await import("../../dist/review/reviewRound.js");
  const round = createTaskReviewRound(
    "review-round-1",
    "task-1",
    "reviewer",
    "leader",
    {
      schemaVersion: 1,
      projects: [{ projectId: binding.projectId, commit: "a".repeat(40) }]
    },
    now
  );
  assert.equal(round.scope, "task");
  assert.equal(round.workItemId, undefined);
  assert.equal(round.candidateId, undefined);

  const store = configuredStore(t, "yui-agile-task-review-");
  const task = {
    ...createTask("task-1", "leader-owned fix", now, {
      type: "bugfix",
      projectBindings: [binding]
    }),
    status: "active"
  };
  store.saveTask(task);
  const requested = runTaskCommand([
    "review", "request", task.id, "--role", "reviewer"
  ], store, {
    now: () => now,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    },
    actualTaskReviewCandidate: {
      schemaVersion: 1,
      projects: [{ projectId: binding.projectId, commit: "b".repeat(40) }]
    }
  });
  assert.match(requested.output, /Task-final Review requested/u);
  assert.equal(requested.data.reviewRound.workItemId, undefined);
  assert.equal(requested.data.reviewRound.candidateId, undefined);
  const target = requested.data.reviewRound.executionGroup.target;
  assert.equal(target.kind, "task-final-review");
  assert.equal(target.workItemId, undefined);
  assert.equal(target.candidateId, undefined);
  assert.equal(target.revision, 1);
  assert.deepEqual(target.projects, [{
    projectId: binding.projectId,
    commit: "b".repeat(40)
  }]);
});

test("one Reviewer Session can continue across Task-final ReviewRounds", () => {
  const oldCommit = "a".repeat(40);
  const newCommit = "b".repeat(40);
  const entry = {
    projectId: binding.projectId,
    directory: binding.directory,
    access: "write",
    path: "/tmp/task-1/reviews/reviewer-reviewer/app",
    branch: "yui/task-1/reviewer-reviewer",
    baseRef: oldCommit,
    baseCommit: oldCommit
  };
  const effective = {
    schemaVersion: 2,
    sourceDesiredRevision: 1,
    agentId: "codex",
    adapterId: "codex",
    profileAccess: "write",
    search: false,
    permission: { strategy: "default" },
    writeProjectIds: [binding.projectId],
    workspace: { root: "/tmp/task-1/reviews/reviewer-reviewer", entries: [entry] },
    context: {},
    reviewRoundId: "review-round-1",
    reviewBaseCommit: oldCommit
  };
  const desired = {
    ...effective,
    sourceDesiredRevision: 2,
    reviewRoundId: "review-round-2",
    reviewBaseCommit: newCommit,
    workspace: {
      ...effective.workspace,
      entries: [{ ...entry, baseRef: newCommit, baseCommit: newCommit }]
    }
  };
  const workspace = {
    schemaVersion: 2,
    owner: { type: "review-round", taskId: "task-1", reviewRoundId: "review-round-2" },
    ...desired.workspace,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  assert.equal(
    effectiveLaunchSnapshotsCompatibleForTaskMain(effective, desired, workspace),
    true
  );
  assert.equal(
    effectiveLaunchSnapshotsCompatibleForTaskMain(effective, {
      ...desired,
      workspace: { ...desired.workspace, root: "/tmp/different-reviewer-workspace" }
    }, {
      ...workspace,
      root: "/tmp/different-reviewer-workspace"
    }),
    false
  );

  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: "task-1",
    roleName: "reviewer"
  }, "codex", now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "reviewer-session",
    launchId: "review-launch-1",
    status: "running",
    policy: "fixed",
    effective
  }, now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "reviewer-session",
    launchId: "review-launch-2",
    status: "running",
    policy: "fixed",
    effective: desired
  }, new Date("2026-08-24T00:01:00.000Z"));
  assert.equal(sessions.sessions.codex.nativeSessionId, "reviewer-session");
  // Session identity keeps its original launch snapshot; the new AgentRun
  // carries `desired`, including ReviewRound 2 and its exact frozen commit.
  assert.equal(sessions.sessions.codex.effective.reviewRoundId, "review-round-1");
});

test("consecutive Task-final ReviewRounds reassign one clean Reviewer workspace", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-agile-review-workspace-"));
  const home = join(root, "home");
  const repository = join(root, "repository");
  const workspaceRoot = join(root, "workspaces");
  mkdirSync(home, { recursive: true });
  mkdirSync(repository, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main", repository]);
  git(repository, "config", "user.email", "yui@example.invalid");
  git(repository, "config", "user.name", "Yui Test");
  writeFileSync(join(repository, "value.txt"), "first\n");
  git(repository, "add", "value.txt");
  git(repository, "commit", "-m", "first");
  const firstCommit = git(repository, "rev-parse", "HEAD");

  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  store.saveConfiguredAgent(createConfiguredAgent(
    "codex", "codex", "codex", [], [], now
  ));
  store.saveConfig({
    ...store.getConfig(),
    defaultAgent: "codex",
    defaultWorkspace: workspaceRoot
  });
  store.saveGlobalRole(createGlobalRole(
    "reviewer",
    [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
    "codex",
    home,
    now
  ));
  store.saveProject(createProject(
    binding.projectId,
    "app",
    repository,
    { stable: "main", development: "main" },
    now
  ));
  const task = {
    ...createTask("task-1", "review continuity", now, {
      type: "feature",
      projectBindings: [{ ...binding, baseRef: "main" }]
    }),
    status: "active"
  };
  store.saveTask(task);
  const environment = {
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: task.id,
    YUI_ROLE: "leader"
  };
  const first = runTaskCommand([
    "review", "request", task.id, "--role", "reviewer"
  ], store, {
    now: () => now,
    environment,
    actualTaskReviewCandidate: {
      schemaVersion: 1,
      projects: [{ projectId: binding.projectId, commit: firstCommit }]
    }
  }).data.reviewRound;
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => now);
  const firstWorkspace = await preparer.prepareReviewRoundWorkspace(task.id, first.id);
  store.saveReviewRound(task.id, finishReviewRound(
    store.getReviewRound(task.id, first.id),
    "completed",
    "accepted",
    now,
    { evidenceCommit: firstCommit }
  ));

  writeFileSync(join(repository, "value.txt"), "second\n");
  git(repository, "add", "value.txt");
  git(repository, "commit", "-m", "second");
  const secondCommit = git(repository, "rev-parse", "HEAD");
  const second = runTaskCommand([
    "review", "request", task.id, "--role", "reviewer"
  ], store, {
    now: () => new Date("2026-08-24T00:01:00.000Z"),
    environment,
    actualTaskReviewCandidate: {
      schemaVersion: 1,
      projects: [{ projectId: binding.projectId, commit: secondCommit }]
    }
  }).data.reviewRound;
  const secondWorkspace = await preparer.prepareReviewRoundWorkspace(task.id, second.id);

  assert.equal(secondWorkspace.root, firstWorkspace.root);
  assert.equal(secondWorkspace.entries[0].path, firstWorkspace.entries[0].path);
  assert.equal(git(secondWorkspace.entries[0].path, "rev-parse", "HEAD"), secondCommit);
  assert.equal(store.getReviewRoundWorkspace(task.id, first.id), null);
  assert.equal(store.getReviewRound(task.id, first.id).workspaceDisposition.kind, "reassigned");
  assert.equal(store.getReviewRoundWorkspace(task.id, second.id).owner.reviewRoundId, second.id);
});

test("Leader-owned Project completion still requires a CLI-verified committed head", (t) => {
  const store = configuredStore(t, "yui-agile-completion-");
  const task = {
    ...createTask("task-1", "fast fix", now, { projectBindings: [binding] }),
    status: "active"
  };
  store.saveTask(task);
  assert.throws(() => runTaskCommand([
    "complete", task.id, "--summary", "done"
  ], store, { now: () => now }), /Project heads were not verified for delivery/u);

  const commit = "a".repeat(40);
  const completed = runTaskCommand([
    "complete", task.id, "--summary", "verified direct fix"
  ], store, {
    now: () => now,
    actualTaskReviewCandidate: {
      schemaVersion: 1,
      projects: [{ projectId: binding.projectId, commit }]
    }
  });
  assert.match(completed.output, /Completed task task-1/u);
  assert.equal(store.getTask(task.id).status, "completed");
  const event = store.listEvents(task.id).find(({ type }) => type === "task.completed");
  assert.equal(event?.payload.deliveryPath, undefined);
  assert.equal(event?.payload.projectHeads, `${binding.projectId}@${commit}`);
});

test("terminal child worktrees advise at completion and repair defaults converge", () => {
  const task = {
    ...createTask("task-1", "guarded fix", now, { projectBindings: [binding] }),
    status: "active"
  };
  const readiness = projectCompletionReadiness(completionFacts(task, {
    workItems: [{ id: "work-item-1", status: "completed", candidates: [] }],
    managedWorkspaces: [{
      schemaVersion: 2,
      owner: { type: "work-item", taskId: task.id, workItemId: "work-item-1" },
      root: "/tmp/work-item-1",
      entries: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    }]
  }));
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.advisories.map(({ code }) => code), [
    "work-item-workspace-undisposed"
  ]);

  const findings = [
    { id: "finding-1", severity: "p1", summary: "first", paths: ["src/one.ts"], source: "structured" },
    { id: "finding-2", severity: "p2", summary: "second", paths: ["src/two.ts"], source: "structured" }
  ];
  assert.equal(planRepairWave("review-round-1", findings).groups.length, 1);
  assert.equal(planRepairWave("review-round-1", findings, "parallel").groups.length, 2);
});
