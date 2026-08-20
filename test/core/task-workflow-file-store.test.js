import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createAgentProfile } from "../../dist/profile/agentProfile.js";
import { runOperatorCommand } from "../../dist/commands/operatorCommands.js";
import {
  assertTaskRoleWritableAttachAvailable,
  dispatchPreparedReviewRound,
  runTaskCommand
} from "../../dist/commands/taskCommands.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import {
  bindExecution,
  claimPending,
  createWorkMailbox,
  enqueueSignal
} from "../../dist/coordination/workMailbox.js";
import {
  createGlobalRole,
  createRoleAgentBinding,
  updateRole,
  updateRoleStatus
} from "../../dist/role/role.js";
import { createLeaderStallNotification } from "../../dist/scheduler/operatorNotification.js";
import {
  attachReviewRoundWorkspace,
  recordReviewWorkspaceDisposition
} from "../../dist/review/reviewRound.js";
import { terminalizeExactTaskRun } from "../../dist/lifecycle/exactRunTerminalization.js";
import { failAgentRun } from "../../dist/run/agentRun.js";
import { createAgentRun, recordRoleAgentSession } from "../helpers/effectiveLaunch.js";
import {
  markYuiRunInput,
  retagYuiRunInput,
  yuiRunIdFromInputMessages
} from "../../dist/run/runIdentity.js";
import { taskRoleSessionTitle } from "../../dist/runtime/sessionTitle.js";
import { createProject } from "../../dist/repository/project.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunDelivered
} from "../../dist/executor/agentExecutor.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { completeTask } from "../../dist/task/task.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import {
  createCandidateGitSnapshot,
  currentWorkItemExecutionGroup,
  recordWorkItemWorkspaceDisposition,
  submitWorkItemCandidate,
  updateWorkItemExecutionGroup,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { recordExecutionLaneResult } from "../../dist/execution/executionGroup.js";

const NOW = new Date("2026-07-19T12:00:00.000Z");
const REVIEW_PROJECT_ID = "review-project";
const REVIEW_BASE_COMMIT = "a".repeat(40);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const codex = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  const claude = createConfiguredAgent("claude", "claude", "claude", [], [], NOW);
  const leader = createGlobalRole(
    "leader",
    [createRoleAgentBinding(codex)],
    codex.id,
    root,
    NOW
  );
  const worker = createGlobalRole(
    "worker",
    [createRoleAgentBinding(codex)],
    codex.id,
    root,
    NOW
  );
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: codex.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(codex);
    tx.saveConfiguredAgent(claude);
    tx.saveGlobalRole(leader);
    tx.saveGlobalRole(worker);
  });
  const calls = { changed: [], reconcile: [], enter: [] };
  const runtime = {
    notifyStateChanged(taskId) { calls.changed.push(taskId); },
    reconcileTask(taskId) { calls.reconcile.push(taskId); },
    prepareTaskRoleEnter(input) { calls.enter.push(input); }
  };
  const options = {
    runtime,
    now: () => new Date(NOW),
    environment: { YUI_TASK_ID: "task-1" }
  };
  return { root, store, calls, options };
}

function run(args, store, options) {
  const taskId = options.environment?.YUI_TASK_ID;
  if (taskId !== undefined && store.getReviewConfig() !== null) {
    const workItemIds = reviewCandidateWorkItems(args, store, taskId);
    if (workItemIds.length > 0) {
      ensureSyntheticReviewCandidateWorkspace(store, taskId, workItemIds);
    }
  }
  const snapshotOptions = taskId === undefined
    ? options
    : withSyntheticCandidateSnapshot(args, store, taskId, options);
  const activeBefore = taskId === undefined
    ? null
    : args[0] === "run" && args[1] === "yield"
      ? store.getAgentRun(taskId, args[2]?.split("/").at(-1))
      : null;
  const commandOptions = activeBefore?.purpose === "review"
    ? { ...snapshotOptions, reviewWorkspaceResult: {} }
    : snapshotOptions;
  const result = runTaskCommand(args, store, commandOptions);
  assert.equal(result.kind, "output");
  if (taskId !== undefined) {
    dispatchSyntheticPendingReviews(store, taskId, options);
    if (activeBefore?.purpose === "review") {
      cleanupSyntheticReviewWorkspace(store, taskId, activeBefore.reviewRoundId);
    }
  }
  return result.output;
}

function reviewCandidateWorkItems(args, store, taskId) {
  if (args[0] === "work" && args[1] === "dispatch") {
    const item = store.getWorkItem(taskId, args[2]?.split("/").at(-1));
    return item === null ? [] : [item.id];
  }
  if (args[0] === "work" && args[1] === "update" && args[3] === "done") {
    const item = store.getWorkItem(taskId, args[2]?.split("/").at(-1));
    return item === null ? [] : [item.id];
  }
  return [];
}

function ensureSyntheticReviewCandidateWorkspace(store, taskId, workItemIds) {
  let task = store.getTask(taskId);
  if (task === null) return;
  const root = store.getConfig().defaultWorkspace;
  if (store.getProject(REVIEW_PROJECT_ID) === null) {
    store.saveProject(createProject(
      REVIEW_PROJECT_ID,
      "review-fixture",
      root,
      { stable: "main", development: "main" },
      NOW
    ));
  }
  if (!task.projectBindings.some(({ projectId }) => projectId === REVIEW_PROJECT_ID)) {
    store.saveTask({
      ...task,
      projectBindings: [{
        projectId: REVIEW_PROJECT_ID,
        directory: "review-fixture",
        baseRef: "main"
      }]
    });
    task = store.getTask(taskId);
  }
  if (store.getTaskWorkspace(taskId) === null) {
    const workspaceRoot = join(root, "synthetic-review", taskId, "main");
    const workspace = createManagedWorkspace({
      owner: { type: "task", taskId },
      root: workspaceRoot,
      entries: [{
        projectId: REVIEW_PROJECT_ID,
        directory: "review-fixture",
        access: "write",
        path: join(workspaceRoot, "review-fixture"),
        branch: `yui/${taskId}/main`,
        baseRef: "main",
        baseCommit: REVIEW_BASE_COMMIT
      }]
    }, NOW);
    store.transaction((tx) => {
      tx.saveManagedWorkspace(workspace);
      const leader = tx.getRole(taskId, "leader");
      if (leader !== null) {
        tx.saveRole(taskId, updateRole(leader, { workspace: workspace.root }, NOW));
      }
    });
  }
  for (const workItemId of new Set(workItemIds)) {
    if (store.getWorkItemWorkspace(taskId, workItemId) !== null) continue;
    const item = store.getWorkItem(taskId, workItemId);
    if (item === null) continue;
    const workspaceRoot = join(root, "synthetic-review", taskId, workItemId);
    const workspace = createManagedWorkspace({
      owner: { type: "work-item", taskId, workItemId },
      root: workspaceRoot,
      entries: [{
        projectId: REVIEW_PROJECT_ID,
        directory: "review-fixture",
        access: item.writeProjectIds.includes(REVIEW_PROJECT_ID) ? "write" : "read",
        path: join(workspaceRoot, "review-fixture"),
        branch: `yui/${taskId}/${workItemId}`,
        baseRef: "main",
        baseCommit: REVIEW_BASE_COMMIT
      }]
    }, NOW);
    store.saveManagedWorkspace(workspace);
  }
}

function withSyntheticCandidateSnapshot(args, store, taskId, options) {
  let workspace;
  if (args[0] === "run" && args[1] === "yield") {
    const run = store.getAgentRun(taskId, args[2]?.split("/").at(-1));
    if (run?.purpose === "execution") workspace = run.workspace;
  } else if (args[0] === "work" && args[1] === "update" && args[3] === "done") {
    workspace = store.getWorkItemWorkspace(taskId, args[2]?.split("/").at(-1));
  }
  if (workspace === undefined || workspace === null || workspace.entries.length === 0) {
    return options;
  }
  return {
    ...options,
    candidateGitSnapshot: createCandidateGitSnapshot(workspace, [{
      projectId: REVIEW_PROJECT_ID,
      commit: REVIEW_BASE_COMMIT
    }])
  };
}

function dispatchSyntheticPendingReviews(store, taskId, options) {
  for (const round of store.listReviewRounds(taskId).filter((entry) => (
    entry.status === "pending" && entry.workspace === undefined
  ))) {
    const root = store.getConfig().defaultWorkspace;
    const workspaceRoot = join(root, "synthetic-review", taskId, round.id);
    const workspace = createManagedWorkspace({
      owner: { type: "review-round", taskId, reviewRoundId: round.id },
      root: workspaceRoot,
      entries: [{
        projectId: REVIEW_PROJECT_ID,
        directory: "review-fixture",
        access: "write",
        path: join(workspaceRoot, "review-fixture"),
        branch: `yui/${taskId}/${round.id}`,
        baseRef: round.reviewBaseCommit,
        baseCommit: round.reviewBaseCommit
      }]
    }, NOW);
    store.transaction((tx) => {
      const reviewer = tx.getRole(taskId, round.reviewerRoleName);
      assert.notEqual(reviewer, null);
      tx.saveManagedWorkspace(workspace);
      tx.saveReviewRound(taskId, attachReviewRoundWorkspace(round, workspace));
      tx.saveRole(taskId, updateRole(reviewer, { workspace: workspace.root }, NOW));
    });
    dispatchPreparedReviewRound(taskId, round.id, store, options);
  }
}

function cleanupSyntheticReviewWorkspace(store, taskId, reviewRoundId) {
  if (reviewRoundId === undefined) return;
  const round = store.getReviewRound(taskId, reviewRoundId);
  if (round === null || (round.status !== "completed" && round.status !== "failed")) return;
  const workspace = store.getReviewRoundWorkspace(taskId, round.id);
  if (workspace?.owner.type !== "review-round"
    || workspace.owner.reviewRoundId !== round.id) return;
  store.transaction((tx) => {
    tx.removeManagedWorkspace(workspace.owner);
    tx.saveReviewRound(taskId, recordReviewWorkspaceDisposition(round, "removed", NOW));
  });
}

function createTask(store, options, title = "Plan first") {
  run(["create", title], store, options);
  return store.listTasks().at(-1);
}

function markDelivered(store, run) {
  store.transaction((tx) => {
    const target = { kind: "role", taskId: run.taskId, roleName: run.roleName };
    let mailbox = tx.getWorkMailbox(target) ?? createWorkMailbox(target);
    if (mailbox.processing === null) {
      if (mailbox.pending === null) {
        mailbox = enqueueSignal(mailbox, {
          reason: "fixture-run-dispatched",
          refs: [{ type: "run", taskId: run.taskId, id: run.id }],
          occurredAt: NOW.toISOString()
        });
      }
      const batchId = `agent-run:${run.taskId}/${run.id}`;
      mailbox = bindExecution(
        claimPending(mailbox, {
          batchId,
          owner: "controller",
          startedAt: NOW.toISOString()
        }),
        batchId,
        { type: "run", taskId: run.taskId, id: run.id }
      );
      tx.saveWorkMailbox(mailbox);
    }
    // Delivered (provider-accepted) implies the prompt was pushed first.
    tx.saveAgentRun({ ...run, pushedAt: NOW.toISOString(), deliveredAt: NOW.toISOString() });
  });
}

function recordReadyNativeSession(store, taskId, roleName, nativeSessionId) {
  const effective = store.listAgentRuns(taskId)
    .filter((run) => run.roleName === roleName)
    .at(-1)?.effective;
  assert.ok(effective, `missing historical effective launch for ${taskId}/${roleName}`);
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId,
    roleName
  }, effective.agentId, NOW);
  sessions = recordRoleAgentSession(sessions, {
    agentId: effective.agentId,
    adapterId: effective.adapterId,
    nativeSessionId,
    policy: "fixed",
    status: "ready",
    effective
  }, NOW);
  store.saveTaskRoleSessionSet(sessions);
}

function recordOpaqueRoleSession(store, taskId, roleName, run, status = "ready") {
  const timestamp = NOW.toISOString();
  const sessions = createRoleSessionSet({
    scope: "task",
    taskId,
    roleName
  }, run.effective.agentId, NOW);
  store.saveTaskRoleSessionSet({
    ...sessions,
    sessions: {
      [run.effective.agentId]: {
        schemaVersion: 3,
        agentId: run.effective.agentId,
        adapterId: run.effective.adapterId,
        launchId: `opaque-launch-${taskId}-${roleName}`,
        policy: "fixed",
        effective: run.effective,
        status,
        recentCompletedTurnIds: [],
        createdAt: timestamp,
        updatedAt: timestamp
      }
    }
  });
}

test("CLI yield clears matching Leader stall attention and rejects duplicate terminalization", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Recover Leader attention");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "Leader recovery"], store, options);
  const item = store.listWorkItems(task.id)[0];
  const active = dispatchTestRun(store, task.id, "leader", item.id);
  markDelivered(store, active);
  store.transaction((tx) => {
    tx.saveEvent(task.id, createTaskEvent(
      tx.nextEventId(task.id),
      task.id,
      "run.stalled",
      {
        runId: active.id,
        roleName: "leader",
        kind: "workflow-not-progressing",
        classification: "truly-stalled",
        progressAt: active.createdAt,
        idleMs: "1800000",
        evidenceKey: "cli-yield-test",
        status: "needs-attention"
      },
      NOW
    ));
    tx.saveOperatorNotification(createLeaderStallNotification(
      task.id,
      active.id,
      active.createdAt,
      "cli-yield-test",
      NOW,
      null
    ));
  });

  run(["run", "yield", active.id, "--summary", "Leader recovered"], store, options);
  assert.equal(store.getOperatorNotification(task.id), null);
  assert.equal(store.getActiveAgentRun(task.id, "leader"), null);
  assert.equal(
    store.listEvents(task.id).filter(({ type, payload }) => (
      type === "run.recovered" && payload.runId === active.id
    )).length,
    1
  );
  assert.throws(
    () => run(["run", "yield", active.id, "--summary", "duplicate"], store, options),
    /already terminal/u
  );
  assert.equal(store.getOperatorNotification(task.id), null);
});

test("Work Item rejection and cancellation close the acceptance loop without new states", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options);
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "Review result"], store, options);
  const rejected = store.listWorkItems(task.id).at(-1);
  const running = updateWorkItemStatus(rejected, "running", NOW);
  store.saveWorkItem(task.id, running);
  store.saveWorkItem(
    task.id,
    submitWorkItemCandidate(running, {
      summary: "Candidate ready.",
      source: { type: "direct" }
    }, NOW)
  );

  assert.throws(
    () => runTaskCommand(
      ["work", "reject", rejected.id, "--summary", "Needs another pass."],
      store,
      options
    ),
    /Only the Task Leader may reject/
  );
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  assert.match(
    run(["work", "reject", rejected.id, "--summary", "Needs another pass."], store, leaderOptions),
    /Rejected Work Item/
  );
  assert.equal(store.getWorkItem(task.id, rejected.id).status, "failed");

  assert.match(
    run([
      "work", "retire", rejected.id, "--summary", "No longer needed."
    ], store, leaderOptions),
    /Retired Work Item/
  );
  assert.equal(store.getWorkItem(task.id, rejected.id).status, "retired");
  assert.equal(
    store.listEvents(task.id).some(({ type }) => type === "work.rejected"),
    true
  );
  assert.equal(
    store.listEvents(task.id).some(({ type }) => type === "work.retired"),
    true
  );
});

function dispatchTestRun(store, taskId, roleName, workItemId, input = "test run") {
  if (store.getReviewConfig() !== null) {
    ensureSyntheticReviewCandidateWorkspace(store, taskId, [workItemId]);
  }
  const role = store.getRole(taskId, roleName);
  if (store.getActiveAgentRun(taskId, roleName) !== null) {
    throw new Error(`${taskId}/${roleName} already has an active run.`);
  }
  const runId = store.nextAgentRunId(taskId);
  const workspace = store.getWorkItemWorkspace(taskId, workItemId) ?? createManagedWorkspace({
    owner: { type: "work-item", taskId, workItemId },
    root: join(store.rootDirectory(), "test-workspaces", taskId, workItemId),
    entries: []
  }, NOW);
  const run = createAgentRun(
    runId,
    taskId,
    roleName,
    "new",
    markYuiRunInput(
      input,
      runId,
      taskRoleSessionTitle(store.getTask(taskId), roleName)
    ),
    NOW,
    { workItemId, ...(workspace === undefined ? {} : { workspace }) }
  );
  store.transaction((tx) => {
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    tx.saveRole(taskId, updateRoleStatus(role, "running", NOW));
    const currentItem = tx.getWorkItem(taskId, workItemId);
    tx.saveWorkItem(taskId, updateWorkItemStatus(currentItem, "running", NOW));
    const target = { kind: "role", taskId, roleName };
    const mailbox = enqueueSignal(tx.getWorkMailbox(target) ?? createWorkMailbox(target), {
      reason: "run-dispatched",
      refs: [
        { type: "run", taskId, id: run.id },
        { type: "work-item", taskId, id: workItemId }
      ],
      occurredAt: NOW.toISOString()
    });
    tx.saveWorkMailbox(mailbox);
  });
  return run;
}

test("Draft activation atomically creates one durable first Leader wake", (t) => {
  const { root, store, options } = fixture(t);
  store.saveProject(createProject(
    "repo-1",
    "fixture",
    root,
    { stable: "main", development: "main" },
    NOW
  ));
  run(["create", "Project task", "--project", "repo-1", "--base", "main"], store, options);
  const task = store.listTasks()[0];

  assert.equal(task.status, "draft");
  assert.deepEqual(task.projectBindings, [{
    projectId: "repo-1",
    directory: "fixture",
    baseRef: "main"
  }]);
  assert.equal(store.getRole(task.id, "leader")?.activeAgentId, "codex");
  assert.equal(store.getPendingWakeup(task.id), null);

  run(["activate", task.id], store, options);
  const first = store.getPendingWakeup(task.id);
  assert.equal(store.getTask(task.id)?.status, "active");
  assert.deepEqual(first?.reasons, ["task-created"]);
  assert.equal(first?.requestCount, 1);

  run(["activate", task.id], store, options);
  assert.deepEqual(store.getPendingWakeup(task.id), first);
});

test("Task create binds multiple Projects with independent base refs", (t) => {
  const { root, store, options } = fixture(t);
  store.saveProject(createProject(
    "repo-1",
    "backend",
    join(root, "backend"),
    { stable: "main", development: "develop" },
    NOW
  ));
  store.saveProject(createProject(
    "repo-2",
    "frontend",
    join(root, "frontend"),
    { stable: "main", development: "release" },
    NOW
  ));

  run([
    "create",
    "Coordinated release",
    "--project", "backend",
    "--project", "frontend",
    "--base", "backend=develop",
    "--base", "frontend=release",
    "--require-integration"
  ], store, options);
  const task = store.listTasks()[0];

  assert.deepEqual(task.projectBindings, [
    { projectId: "repo-1", directory: "backend", baseRef: "develop" },
    { projectId: "repo-2", directory: "frontend", baseRef: "release" }
  ]);
  assert.equal(task.requireIntegration, true);
  assert.match(run(["project", "list", task.id], store, options), /backend\s+repo-1\s+develop/);
  assert.match(run(["project", "list", task.id], store, options), /frontend\s+repo-2\s+release/);
  const context = run(["context", task.id], store, options);
  assert.match(context, /- backend: repo-1 @ develop/);
  assert.match(context, /- frontend: repo-2 @ release/);

  assert.throws(
    () => runTaskCommand([
      "create",
      "Ambiguous bases",
      "--project", "backend",
      "--project", "frontend",
      "--base", "main"
    ], store, options),
    /must use <project>=<ref>.*multiple Projects/i
  );
  assert.equal(store.listTasks().length, 1);
});

test("Leader can expand an active Task and WorkItem Project scope", (t) => {
  const { root, store, options } = fixture(t);
  for (const [id, name] of [["repo-1", "backend"], ["repo-2", "frontend"]]) {
    store.saveProject(createProject(
      id,
      name,
      join(root, id),
      { stable: "main", development: "main" },
      NOW
    ));
  }
  run(["create", "Cross-project change", "--project", "repo-1"], store, options);
  const task = store.listTasks()[0];
  run(["activate", task.id], store, options);
  const leader = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };

  run(["project", "add", task.id, "repo-2"], store, leader);
  assert.deepEqual(store.getTask(task.id).projectBindings.map(({ projectId }) => projectId), [
    "repo-1",
    "repo-2"
  ]);
  run(["role", "add", task.id, "worker"], store, leader);
  run([
    "work", "create", task.id, "Update both",
    "--project", "repo-1",
    "--role", "worker"
  ], store, leader);
  const item = store.listWorkItems(task.id)[0];
  run([
    "work", "scope", item.id,
    "--project", "repo-1",
    "--project", "repo-2"
  ], store, leader);
  assert.deepEqual(store.getWorkItem(task.id, item.id).writeProjectIds, [
    "repo-1",
    "repo-2"
  ]);
  const expanded = store.getWorkItem(task.id, item.id);
  const eventCount = store.listEvents(task.id).length;
  assert.match(run([
    "work", "scope", item.id,
    "--project", "repo-2",
    "--project", "repo-1"
  ], store, leader), /Unchanged Work Item Project scope/i);
  assert.equal(store.getWorkItem(task.id, item.id).revision, expanded.revision);
  assert.equal(store.listEvents(task.id).length, eventCount);
  assert.throws(
    () => run([
      "work", "scope", item.id,
      "--project", "repo-2"
    ], store, leader),
    /cannot remove.*repo-1/i
  );
  assert.throws(
    () => run(["work", "dispatch", item.id], store, leader),
    /must be isolated.*Project scope/i
  );
});

test("invalid project and Role options fail before mutating the aggregate", (t) => {
  const { store, options } = fixture(t);
  assert.throws(
    () => runTaskCommand(["create", "invalid", "--base", "main"], store, options),
    /requires --project/i
  );
  assert.equal(store.listTasks().length, 0);
  const task = createTask(store, options, "Valid");
  assert.throws(
    () => runTaskCommand(["role", "add", task.id, "worker", "--agent", ""], store, options),
    /--agent is required/i
  );
  assert.equal(store.getRole(task.id, "worker"), null);
});

test("Task metadata can be updated and is visible in Task details", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Initial title");

  run([
    "update",
    task.id,
    "--title",
    "Release readiness",
    "--description",
    "Prepare the release candidate",
    "--priority",
    "high",
    "--tags",
    "release,backend",
    "--due-at",
    "2026-07-31T12:00:00.000Z"
  ], store, options);

  const updated = store.getTask(task.id);
  assert.equal(updated.title, "Release readiness");
  assert.equal(updated.description, "Prepare the release candidate");
  assert.equal(updated.priority, "high");
  assert.deepEqual(updated.tags, ["release", "backend"]);
  assert.equal(updated.dueAt, "2026-07-31T12:00:00.000Z");
  const shown = run(["show", task.id], store, options);
  assert.match(shown, /Description: Prepare the release candidate/);
  assert.match(shown, /Priority: high/);
  assert.match(shown, /Tags: release, backend/);
  assert.match(shown, /Due: 2026-07-31 20:00:00 \+08:00/);

  run([
    "update",
    task.id,
    "--clear-description",
    "--clear-priority",
    "--clear-tags",
    "--clear-due-at"
  ], store, options);
  const cleared = store.getTask(task.id);
  assert.equal(cleared.description, undefined);
  assert.equal(cleared.priority, undefined);
  assert.equal(cleared.tags, undefined);
  assert.equal(cleared.dueAt, undefined);

  assert.throws(
    () => runTaskCommand(["update", task.id, "--due-at", "July 31, 2026"], store, options),
    /ISO|RFC 3339/i
  );
  run(["update", task.id, "--due-at", "2026-07-31T20:00:00+08:00"], store, options);
  assert.equal(store.getTask(task.id).dueAt, "2026-07-31T12:00:00.000Z");
});

test("an active read-only Task can enable integration evidence exactly once", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Investigate first");
  run(["activate", task.id], store, options);

  assert.match(
    run(["update", task.id, "--require-integration"], store, options),
    /Completion evidence enabled/
  );
  assert.equal(store.getTask(task.id).requireIntegration, true);
  assert.match(run(["show", task.id], store, options), /Completion evidence: required/);
  assert.deepEqual(store.listEvents(task.id).at(-1).payload, {
    status: "active",
    completionEvidence: "integration-required"
  });

  assert.match(
    run(["update", task.id, "--require-integration"], store, options),
    /already enabled/
  );

  const completed = createTask(store, options, "Completed investigation");
  run(["activate", completed.id], store, options);
  run(["complete", completed.id, "--summary", "Investigation done"], store, options);
  assert.throws(
    () => run(["update", completed.id, "--require-integration"], store, options),
    /reopen/i
  );
});

test("Task list and show emit one-pass structured JSON for Agents", (t) => {
  const { root, store, options } = fixture(t);
  const task = createTask(store, options, "Agent-readable task");
  const runCli = (...args) => JSON.parse(execFileSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "--json", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, YUI_HOME: root }
    }
  ));

  const listed = runCli("task", "list");
  assert.equal(listed.ok, true);
  assert.equal(listed.data.tasks.length, 1);
  assert.deepEqual(
    Object.fromEntries(Object.keys(task).map((key) => [key, listed.data.tasks[0][key]])),
    task
  );
  assert.equal(listed.data.tasks[0].summaryStatus, "missing");
  assert.deepEqual(listed.data.tasks[0].work.counts, {
    total: 0,
    pending: 0,
    running: 0,
    awaiting_acceptance: 0,
    completed: 0,
    failed: 0,
    retired: 0
  });
  assert.deepEqual(listed.data.tasks[0].input, { open: [], openCount: 0 });
  assert.deepEqual(listed.data.tasks[0].blockers, []);
  assert.deepEqual(runCli("task", "show", task.id), {
    ok: true,
    data: {
      task,
      counts: {
        messages: 0,
        decisions: 0,
        milestones: 0,
        events: 1,
        workItems: 0,
        agentRuns: 0,
        changeSets: 0,
        integrations: 0,
        openInputs: 0
      },
      hasBrief: false
    }
  });
  assert.deepEqual(runCli("task", "work", "list", task.id), {
    ok: true,
    data: { workItems: [] }
  });
});

test("Task lifecycle and messages append a durable Web timeline", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Timeline");
  run(["update", task.id, "--priority", "high"], store, options);
  run(["activate", task.id], store, options);
  run(["message", "send", task.id, "Proceed"], store, options);
  run(["complete", task.id, "--summary", "Finished"], store, options);
  run(["reopen", task.id], store, options);
  run(["complete", task.id, "--summary", "Finished after reopen"], store, options);
  assert.throws(
    () => run(["archive", task.id], store, options),
    /--integrated|--abandon/
  );
  run(["archive", task.id, "--integrated"], store, options);

  assert.deepEqual(
    store.listEvents(task.id).map((event) => event.type),
    [
      "task.created",
      "task.updated",
      "task.activated",
      "message.sent",
      "task.completed",
      "task.reopened",
      "task.completed",
      "task.archived"
    ]
  );
  assert.deepEqual(store.listEvents(task.id)[3].payload, {
    messageId: store.listMessages(task.id)[0].id,
    kind: "user"
  });
  assert.equal(store.listEvents(task.id).at(-1).payload.workspaceDisposition, "integrated");
  const message = store.listMessages(task.id)[0];
  assert.throws(
    () => store.saveMessage(task.id, { ...message, body: "Rewritten history" }),
    /already exists/i
  );
});

test("Operator submit creates a Draft and active Task messages wake its Leader", (t) => {
  const { root, store, options } = fixture(t);
  const created = runOperatorCommand(["submit", "Build the smallest useful workflow"], store, options);
  assert.equal(created.kind, "output");
  const task = store.listTasks()[0];
  assert.equal(task.status, "draft");
  assert.deepEqual(store.listMessages(task.id)[0].author, { type: "operator" });
  assert.equal(store.listMessages(task.id)[0].kind, "operator");
  assert.equal(store.getPendingWakeup(task.id), null);

  run(["activate", task.id], store, options);
  const before = store.getPendingWakeup(task.id)?.requestCount;
  runOperatorCommand(["submit", "Continue here", "--task", task.id], store, options);
  assert.equal(store.listMessages(task.id).at(-1).body, "Continue here");
  assert.equal(store.getPendingWakeup(task.id)?.requestCount, before + 1);
  assert.ok(store.getPendingWakeup(task.id)?.reasons.includes("operator-input"));

  run(["message", "send", task.id, "User follow-up"], store, {
    ...options,
    environment: {}
  });
  const userMessage = store.listMessages(task.id).at(-1);
  assert.equal(userMessage.kind, "user");
  assert.deepEqual(userMessage.author, { type: "user" });
  assert.ok(store.getPendingWakeup(task.id)?.reasons.includes("user-message"));

  const beforeManagedOperator = store.getPendingWakeup(task.id)?.requestCount;
  run(["message", "send", task.id, "Operator decision"], store, {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "global",
      YUI_ROLE: "operator"
    }
  });
  const operatorMessage = store.listMessages(task.id).at(-1);
  assert.equal(operatorMessage.kind, "operator");
  assert.deepEqual(operatorMessage.author, { type: "operator" });
  assert.equal(store.getPendingWakeup(task.id)?.requestCount, beforeManagedOperator + 1);
  assert.ok(store.getPendingWakeup(task.id)?.reasons.includes("operator-input"));

  const aggregate = JSON.parse(readFileSync(join(root, "state.json"), "utf8")).tasks[task.id];
  assert.ok(aggregate.messages[userMessage.id]);
  assert.ok(aggregate.messages[operatorMessage.id]);
  assert.equal("comments" in aggregate, false);
});

test("matching Leader message send records one explicit semantic Message without self-wake", (t) => {
  const { store, options, calls } = fixture(t);
  const task = createTask(store, options, "Leader conclusion");
  run(["activate", task.id], store, options);
  store.clearPendingWakeup(task.id);
  const changedBeforeSend = calls.changed.length;

  run(["message", "send", task.id, "The implementation evidence is accepted."], store, {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  });

  const [message] = store.listMessages(task.id);
  assert.equal(store.listMessages(task.id).length, 1);
  assert.equal(message.kind, "role-result");
  assert.deepEqual(message.author, { type: "role", roleName: "leader" });
  assert.equal(message.body, "The implementation evidence is accepted.");
  assert.equal(message.runId, undefined);
  assert.equal(store.getPendingWakeup(task.id), null);
  assert.equal(calls.changed.length, changedBeforeSend);
  assert.equal(store.listEvents(task.id).filter(({ type }) => type === "message.sent").length, 1);
  assert.deepEqual(store.listEvents(task.id).at(-1).payload, {
    messageId: message.id,
    kind: "role-result"
  });
  assert.match(run(["message", "list", task.id], store, options), /leader.*implementation evidence/u);
  const context = run(["context", task.id], store, options);
  assert.match(context, /\[leader\]/u);
  assert.match(context, /The implementation evidence is accepted\./u);
});

test("managed non-Leader and incomplete identities cannot send a Task Message", (t) => {
  const { store, options, calls } = fixture(t);
  const task = createTask(store, options, "Fenced message");
  run(["activate", task.id], store, options);
  store.clearPendingWakeup(task.id);
  const eventsBeforeSend = store.listEvents(task.id);
  const changedBeforeSend = calls.changed.length;

  assert.throws(
    () => runTaskCommand(["message", "send", task.id, "Worker conclusion"], store, {
      ...options,
      environment: {
        YUI_SESSION_SCOPE: "task",
        YUI_TASK_ID: task.id,
        YUI_ROLE: "worker"
      }
    }),
    /managed Task Session.*matching Leader/iu
  );
  assert.throws(
    () => runTaskCommand(["message", "send", task.id, "Incomplete conclusion"], store, {
      ...options,
      environment: { YUI_ROLE: "leader" }
    }),
    /identity is incomplete/iu
  );

  assert.deepEqual(store.listMessages(task.id), []);
  assert.deepEqual(store.listEvents(task.id), eventsBeforeSend);
  assert.equal(store.getPendingWakeup(task.id), null);
  assert.equal(calls.changed.length, changedBeforeSend);
});

test("assigned Work dispatch honors dependencies and Worker yield awaits Leader acceptance", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Dispatch");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "first", "--role", "worker"], store, options);
  const first = store.listWorkItems(task.id)[0];
  run([
    "work", "create", task.id, "second", "--role", "worker",
    "--after", first.id
  ], store, options);
  const second = store.listWorkItems(task.id)[1];

  assert.throws(
    () => run(["work", "dispatch", second.id], store, options),
    new RegExp(`Work Item dependency is not completed: ${first.id}`)
  );
  run(["work", "dispatch", first.id, "--input", "implement"], store, options);
  assert.equal(store.getWorkItem(second.taskId, second.id)?.status, "pending");
  const active = store.getActiveAgentRun(task.id, "worker");
  assert.equal(active?.workItemId, first.id);
  assert.equal(active?.effective.agentId, "codex");
  assert.equal(active?.effective.adapterId, "codex");
  const workerMailbox = store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "worker" });
  assert.deepEqual(workerMailbox.pending.reasons, ["run-dispatched"]);
  assert.ok(workerMailbox.pending.refs.some((ref) => ref.type === "run" && ref.id === active.id));

  markDelivered(store, active);
  const messagesBeforeYield = store.listMessages(task.id);
  run(["run", "yield", active.id, "--summary", "implemented"], store, options);
  const yieldedRun = store.getAgentRun(active.taskId, active.id);
  assert.equal(yieldedRun?.status, "yielded");
  assert.equal(yieldedRun?.summary, "implemented");
  assert.equal(store.getWorkItem(first.taskId, first.id)?.status, "awaiting_acceptance");
  assert.equal(store.getActiveAgentRun(task.id, "worker"), null);
  assert.deepEqual(store.listMessages(task.id), messagesBeforeYield);
  const candidate = store.getWorkItem(first.taskId, first.id)?.candidates.at(-1);
  assert.equal(candidate?.summary, "implemented");
  assert.deepEqual(candidate?.source, { type: "run", runId: active.id });
  assert.ok(store.getPendingWakeup(task.id)?.reasons.includes("candidate-ready"));
  const leaderMailbox = store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" });
  assert.ok(leaderMailbox.pending.refs.some((ref) => ref.type === "run" && ref.id === active.id));
  assert.ok(leaderMailbox.pending.refs.every((ref) => ref.type !== "message"));
  const contextAfterYield = run(["context", task.id], store, options);
  assert.match(contextAfterYield, new RegExp(`${active.id} \\[yielded/execution\\]`));
  assert.match(contextAfterYield, /Result: implemented/);
  assert.match(contextAfterYield, /Recent messages \(0\):\n  None\./);
  assert.throws(
    () => run(
      ["work", "update", first.id, "done", "--summary", "bypassed review"],
      store,
      options
    ),
    /assigned Work Item.*accept or reject/iu
  );
  assert.equal(store.getWorkItem(first.taskId, first.id)?.status, "awaiting_acceptance");

  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  run(["work", "accept", first.id, "--summary", "reviewed"], store, leaderOptions);
  assert.equal(store.getWorkItem(first.taskId, first.id)?.status, "completed");
  run(["work", "dispatch", second.id], store, options);
  assert.equal(store.getWorkItem(second.taskId, second.id)?.status, "running");
});

test("fixed multi-Lane Worker execution waits for explicit Leader group resolution", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Worker panel");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["role", "add", task.id, "worker-2"], store, options);
  run(["work", "create", task.id, "parallel work", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run([
    "work", "dispatch", item.id,
    "--strategy", "fixed:2",
    "--lane-role", "worker",
    "--lane-role", "worker-2"
  ], store, options);
  const activeRuns = store.listAgentRuns(task.id).filter(({ purpose, status }) => (
    purpose === "execution" && status === "active"
  ));
  assert.equal(activeRuns.length, 2);
  const running = store.getWorkItem(task.id, item.id);
  assert.equal(running.status, "running");
  assert.equal(currentWorkItemExecutionGroup(running).lanes.length, 2);
  assert.notEqual(currentWorkItemExecutionGroup(running).lanes[0].roleName, currentWorkItemExecutionGroup(running).lanes[1].roleName);

  for (const active of activeRuns) {
    markDelivered(store, active);
    run(["run", "yield", active.id, "--summary", `${active.roleName} result`], store, options);
    const after = store.getWorkItem(task.id, item.id);
    assert.equal(after.status, "running");
    assert.equal(after.candidates.length, 0);
  }
  const completeGroup = currentWorkItemExecutionGroup(store.getWorkItem(task.id, item.id));
  assert.ok(completeGroup.lanes.every(({ status }) => status === "completed"));
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  run([
    "work", "group", "resolve", item.id,
    "--decision", "accept",
    "--summary", "Leader accepted the combined evidence"
  ], store, leaderOptions);
  const accepted = store.getWorkItem(task.id, item.id);
  assert.equal(accepted.status, "awaiting_acceptance");
  assert.equal(currentWorkItemExecutionGroup(accepted).resolution.decision, "accept");
  assert.equal(accepted.candidates.length, 1);
  assert.match(accepted.candidates[0].summary, /Leader accepted the combined evidence/);
  assert.match(accepted.candidates[0].summary, /worker result/);
  assert.match(accepted.candidates[0].summary, /worker-2 result/);
});

test("adaptive Worker execution can append a bounded Lane before resolution", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Adaptive panel");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["role", "add", task.id, "worker-2"], store, options);
  run(["work", "create", task.id, "adaptive work", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id, "--strategy", "adaptive:3"], store, options);
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  run([
    "work", "dispatch", item.id,
    "--lane-role", "worker-2"
  ], store, leaderOptions);
  const running = store.getWorkItem(task.id, item.id);
  assert.equal(currentWorkItemExecutionGroup(running).strategy.mode, "adaptive");
  assert.equal(currentWorkItemExecutionGroup(running).strategy.max, 3);
  assert.equal(currentWorkItemExecutionGroup(running).lanes.length, 2);
  assert.equal(store.listAgentRuns(task.id).filter(({ status }) => status === "active").length, 2);
});

test("accept defaults to usable terminal Lanes when one panel Lane failed", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Partial panel resolution");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["role", "add", task.id, "worker-2"], store, options);
  run(["work", "create", task.id, "partial panel", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run([
    "work", "dispatch", item.id,
    "--strategy", "fixed:2",
    "--lane-role", "worker",
    "--lane-role", "worker-2"
  ], store, options);
  const activeRuns = store.listAgentRuns(task.id).filter(({ purpose, status }) => (
    purpose === "execution" && status === "active"
  ));
  const failed = activeRuns.find(({ roleName }) => roleName === "worker-2");
  const yielded = activeRuns.find(({ roleName }) => roleName === "worker");
  markDelivered(store, failed);
  markDelivered(store, yielded);
  run(["run", "yield", yielded.id, "--summary", "lane yielded"], store, options);
  store.transaction((tx) => {
    const failedRun = tx.getAgentRun(task.id, failed.id);
    tx.saveAgentRun(failAgentRun(failedRun, "lane failed", NOW));
    tx.clearActiveAgentRun(task.id, failed.roleName);
    tx.saveRole(task.id, updateRoleStatus(tx.getRole(task.id, failed.roleName), "idle", NOW));
    tx.saveWorkItem(task.id, updateWorkItemExecutionGroup(
      tx.getWorkItem(task.id, item.id),
      recordExecutionLaneResult(
        currentWorkItemExecutionGroup(tx.getWorkItem(task.id, item.id)),
        failed.executionLaneId,
        { summary: "lane failed" },
        "failed",
        NOW
      ),
      NOW
    ));
  });
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  run(["work", "group", "resolve", item.id, "--decision", "accept", "--summary", "accept usable lane"], store, leaderOptions);
  const resolved = currentWorkItemExecutionGroup(store.getWorkItem(task.id, item.id));
  assert.deepEqual(
    resolved.resolution.selectedLaneIds,
    [resolved.lanes.find(({ roleName }) => roleName === "worker").id]
  );
  assert.match(store.getWorkItem(task.id, item.id).candidates[0].summary, /worker result|lane yielded/);
});

test("desired Agent drift preserves the in-flight Run's exact yield authority", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Immutable yield identity");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "implementation", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];

  run(["work", "dispatch", item.id], store, options);
  const active = store.getActiveAgentRun(task.id, "worker");
  assert.equal(active?.effective.agentId, "codex");
  markDelivered(store, active);
  recordReadyNativeSession(store, task.id, "worker", "codex-session");
  store.transaction((tx) => {
    const fence = {
      agentId: active.effective.agentId,
      runId: active.id,
      receiptId: `agent-run:${task.id}/${active.id}`
    };
    const sessions = tx.getTaskRoleSessionSet(task.id, "worker");
    tx.saveTaskRoleSessionSet(markTaskRoleRunDelivered(
      bindTaskRoleRun(sessions, fence, NOW),
      fence,
      NOW
    ));
  });

  const runSnapshot = structuredClone(active.effective);
  run(["role", "bind", task.id, "worker", "claude"], store, options);
  assert.equal(store.getRole(task.id, "worker")?.activeAgentId, "claude");
  assert.deepEqual(store.getActiveAgentRun(task.id, "worker")?.effective, runSnapshot);
  assert.equal(store.getTaskRoleSessionSet(task.id, "worker")?.activeAgentId, "codex");
  assert.equal(store.getTaskRoleSessionSet(task.id, "worker")?.inFlight?.agentId, "codex");

  run(["run", "yield", active.id, "--summary", "old snapshot completed"], store, options);
  assert.equal(store.getAgentRun(task.id, active.id)?.status, "yielded");
  assert.equal(store.getActiveAgentRun(task.id, "worker"), null);
  assert.equal(store.getTaskRoleSessionSet(task.id, "worker")?.inFlight, null);
  assert.equal(store.getTaskRoleSessionSet(task.id, "worker")?.activeAgentId, "codex");
  assert.equal(store.getRole(task.id, "worker")?.activeAgentId, "claude");
  assert.deepEqual(store.getAgentRun(task.id, active.id)?.effective, runSnapshot);
});

test("always review creates a ReviewRound under the same WorkItem and never reviews the review", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "always" }
    });
  });
  const task = createTask(store, options, "Automatic review");
  assert.deepEqual(store.getReviewConfig(), {
    roleName: "reviewer",
    trigger: "always"
  });
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "candidate", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const execution = store.getActiveAgentRun(task.id, "worker");
  assert.equal(execution.purpose, "execution");
  markDelivered(store, execution);
  const messagesBeforeExecutionYield = store.listMessages(task.id);
  run(["run", "yield", execution.id, "--summary", "candidate ready"], store, options);
  assert.deepEqual(store.listMessages(task.id), messagesBeforeExecutionYield);

  assert.equal(store.listWorkItems(task.id).length, 1);
  const rounds = store.listReviewRounds(task.id);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].workItemId, item.id);
  const candidate = store.getWorkItem(task.id, item.id).candidates.at(-1);
  assert.equal(rounds[0].candidateId, candidate.id);
  assert.equal(candidate.workItemRevision, store.getWorkItem(task.id, item.id).revision);
  assert.equal(candidate.summary, "candidate ready");
  assert.deepEqual(candidate.source, { type: "run", runId: execution.id });
  assert.equal(rounds[0].status, "running");
  const reviewRun = store.getActiveAgentRun(task.id, "reviewer");
  assert.equal(reviewRun.purpose, "review");
  assert.equal(reviewRun.reviewRoundId, rounds[0].id);
  assert.match(reviewRun.input, /freely edit source\/tests/);
  assert.match(reviewRun.input, /only inside this ReviewRound-owned workspace/);
  assert.match(reviewRun.input, /Do not push, integrate, mutate Task state/);
  assert.match(reviewRun.input, /candidate summary is a pointer, not proof/i);
  assert.match(reviewRun.input, /Review yield completes only this Round and creates no Candidate or ChangeSet/);
  assert.match(reviewRun.input, /The Leader alone interprets and routes evidence/);
  assert.match(reviewRun.input, /clear Markdown or JSON/);
  assert.match(reviewRun.input, /no fixed wording or field list is required/);

  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  assert.throws(
    () => run(["work", "accept", item.id, "--summary", "accept"], store, leaderOptions),
    /ReviewRound.*running/
  );
  assert.throws(
    () => run(["work", "reject", item.id, "--summary", "reject early"], store, leaderOptions),
    /ReviewRound is still active/
  );

  markDelivered(store, reviewRun);
  run(["run", "yield", reviewRun.id, "--summary", JSON.stringify({
    summary: "One issue to consider.",
    checks: [{ name: "inspection", outcome: "passed", details: "Reviewed candidate evidence." }]
  })], store, options);
  assert.deepEqual(store.listMessages(task.id), messagesBeforeExecutionYield);
  assert.equal(store.listReviewRounds(task.id).length, 1);
  assert.equal(store.listWorkItems(task.id).length, 1);
  const completedRound = store.getReviewRound(task.id, rounds[0].id);
  assert.equal(completedRound.reviewerRunId, reviewRun.id);
  assert.equal(completedRound.status, "completed");
  assert.equal(completedRound.summary, "One issue to consider.");
  assert.deepEqual(completedRound.checks, [{
    name: "inspection",
    outcome: "passed",
    details: "Reviewed candidate evidence."
  }]);
  assert.equal(completedRound.reviewBaseCommit, REVIEW_BASE_COMMIT);
  assert.equal(completedRound.workspace.owner.type, "review-round");
  assert.equal(completedRound.workspace.owner.reviewRoundId, completedRound.id);
  assert.equal(completedRound.workspaceDisposition.kind, "removed");
  assert.equal(completedRound.endedAt, NOW.toISOString());
  assert.equal(store.getWorkItem(item.taskId, item.id)?.status, "awaiting_acceptance");
  run(["work", "accept", item.id, "--summary", "Leader considered the review."], store, leaderOptions);
  assert.equal(store.getWorkItem(item.taskId, item.id)?.status, "completed");
});

test("global review policy is snapshotted by each candidate, not by Task creation", (t) => {
  const { root, store, options } = fixture(t);
  const task = createTask(store, options, "Live global review policy");
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "always" }
    });
  });
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "candidate", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const firstExecution = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, firstExecution);
  run(["run", "yield", firstExecution.id, "--summary", "first candidate"], store, options);

  const firstCandidate = store.getWorkItem(task.id, item.id).candidates.at(-1);
  assert.deepEqual(firstCandidate.reviewPolicy, {
    roleName: "reviewer",
    trigger: "always"
  });
  assert.equal(store.listReviewRounds(task.id).length, 1);

  const { review: _review, ...configWithoutReview } = store.getConfig();
  store.saveConfig(configWithoutReview);
  const firstReview = store.getActiveAgentRun(task.id, "reviewer");
  markDelivered(store, firstReview);
  run(["run", "yield", firstReview.id, "--summary", JSON.stringify({
    summary: "reviewed first candidate",
    checks: [{ name: "inspection", outcome: "passed" }]
  })], store, options);
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  recordReadyNativeSession(store, task.id, "worker", "native-worker-policy-snapshot");
  run(["work", "reject", item.id, "--summary", "repair"], store, leaderOptions);
  run(["work", "dispatch", item.id, "--input", "repair the candidate"], store, options);
  const secondExecution = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, secondExecution);
  run(["run", "yield", secondExecution.id, "--summary", "second candidate"], store, options);

  const updated = store.getWorkItem(task.id, item.id);
  assert.equal(updated.candidates.length, 2);
  assert.equal(updated.candidates[0].id, firstCandidate.id);
  assert.equal(updated.candidates[1].reviewPolicy, undefined);
  assert.equal(store.listReviewRounds(task.id).length, 1);
  run(["work", "accept", item.id, "--summary", "accepted without a cleared policy"], store, leaderOptions);
});

test("always review covers a Leader-managed WorkItem without inventing an execution Run", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "always" }
    });
  });
  const task = createTask(store, options, "Review native subagent work");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "native candidate"], store, options);
  const item = store.listWorkItems(task.id)[0];
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };

  run(["work", "update", item.id, "running"], store, leaderOptions);
  const running = store.getWorkItem(task.id, item.id);
  const foreignWorkspace = createManagedWorkspace({
    owner: { type: "task", taskId: "foreign-task" },
    root,
    entries: []
  }, new Date(NOW));
  assert.throws(
    () => store.saveWorkItem(task.id, submitWorkItemCandidate(running, {
      summary: "Invalid cross-Task candidate.",
      source: { type: "direct" },
      reviewPolicy: { roleName: "reviewer", trigger: "leader" },
      workspace: foreignWorkspace
    }, NOW)),
    /WorkItem-owned workspace/
  );
  run([
    "work", "update", item.id, "done",
    "--summary", "Native subagent result is ready."
  ], store, leaderOptions);

  const awaiting = store.getWorkItem(item.taskId, item.id);
  assert.equal(awaiting.status, "awaiting_acceptance");
  assert.deepEqual(store.listAgentRuns(task.id).filter(({ purpose }) => purpose === "execution"), []);
  const [round] = store.listReviewRounds(task.id);
  const candidate = awaiting.candidates.at(-1);
  assert.equal(round.candidateId, candidate.id);
  assert.equal(candidate.workItemRevision, awaiting.revision);
  assert.equal(candidate.summary, "Native subagent result is ready.");
  assert.deepEqual(candidate.source, { type: "direct" });
  assert.equal(round.status, "running");
  const reviewRun = store.getActiveAgentRun(task.id, "reviewer");
  assert.equal(reviewRun.purpose, "review");
  assert.match(reviewRun.input, /Native subagent result is ready\./);
});

test("always review covers a yielded Leader execution candidate", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "always" }
    });
  });
  const task = createTask(store, options, "Review Leader execution");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "leader candidate"], store, options);
  const item = store.listWorkItems(task.id)[0];
  const execution = dispatchTestRun(store, task.id, "leader", item.id);
  markDelivered(store, execution);

  run(["run", "yield", execution.id, "--summary", "Leader candidate ready."], store, options);

  assert.equal(store.getWorkItem(item.taskId, item.id).status, "awaiting_acceptance");
  const candidate = store.getWorkItem(task.id, item.id).candidates.at(-1);
  assert.equal(store.listReviewRounds(task.id)[0].candidateId, candidate.id);
  assert.equal(candidate.summary, "Leader candidate ready.");
  assert.deepEqual(candidate.source, { type: "run", runId: execution.id });
  assert.equal(store.getActiveAgentRun(task.id, "reviewer").purpose, "review");
});

test("review fails closed when the reviewer Role produced the candidate", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "worker",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "worker", trigger: "always" }
    });
  });
  const task = createTask(store, options, "Self review lifecycle");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "candidate", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const execution = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, execution);

  run(["run", "yield", execution.id, "--summary", "candidate ready"], store, options);

  const [round] = store.listReviewRounds(task.id);
  assert.equal(store.getActiveAgentRun(task.id, "worker"), null);
  assert.equal(round.status, "failed");
  assert.match(round.summary, /separate from the Candidate producer/);
  assert.equal(round.workspace, undefined);
  assert.equal(store.getRole(task.id, "worker").status, "idle");
});

test("a failed ReviewRound remains evidence but does not override Leader judgment", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "always" }
    });
  });
  const task = createTask(store, options, "Review failure judgment");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "candidate", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const execution = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, execution);
  run(["run", "yield", execution.id, "--summary", "candidate ready"], store, options);
  const reviewRun = store.getActiveAgentRun(task.id, "reviewer");
  store.transaction((tx) => {
    const result = terminalizeExactTaskRun(tx, {
      taskId: task.id,
      roleName: reviewRun.roleName,
      agentId: reviewRun.effective.agentId,
      runId: reviewRun.id,
      receiptId: `agent-run:${task.id}/${reviewRun.id}`,
      outcome: { status: "failed", summary: "Reviewer runtime unavailable." }
    }, NOW);
    assert.equal(result.disposition, "applied");
  });
  assert.equal(store.listReviewRounds(task.id)[0].status, "failed");

  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  run([
    "work", "accept", item.id,
    "--summary", "User authorized acceptance after the review failure."
  ], store, leaderOptions);
  assert.equal(store.getWorkItem(item.taskId, item.id).status, "completed");
});

test("leader-triggered review starts only when the Leader requests it", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "leader" }
    });
  });
  const task = createTask(store, options, "Leader review");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "candidate", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const execution = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, execution);
  run(["run", "yield", execution.id, "--summary", "candidate ready"], store, options);
  assert.deepEqual(store.listReviewRounds(task.id), []);

  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  assert.match(
    run(["work", "review", item.id], store, leaderOptions),
    /Review requested/
  );
  assert.equal(store.listReviewRounds(task.id).length, 1);
  assert.equal(store.getActiveAgentRun(task.id, "reviewer")?.purpose, "review");
});

test("a repeated Leader review request resumes a pending Round that never launched", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "leader" }
    });
  });
  const task = createTask(store, options, "Resumable Leader review");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "candidate", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const execution = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, execution);
  run(["run", "yield", execution.id, "--summary", "candidate ready"], store, options);

  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  const first = runTaskCommand(["work", "review", item.id], store, leaderOptions);
  assert.match(first.output, /Review requested/);
  const round = store.listReviewRounds(task.id)[0];
  assert.equal(round.status, "pending");
  assert.equal(round.reviewerRunId, undefined);
  assert.equal(store.getActiveAgentRun(task.id, "reviewer"), null);

  const second = runTaskCommand(["work", "review", item.id], store, leaderOptions);
  assert.match(second.output, /Review request .* is pending; resuming dispatch/);
  assert.deepEqual(store.listReviewRounds(task.id), [round]);

  dispatchSyntheticPendingReviews(store, task.id, options);
  assert.equal(store.getActiveAgentRun(task.id, "reviewer")?.purpose, "review");
});

test("the latest ReviewRound stays authoritative when timestamps tie", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "leader" }
    });
  });
  const task = createTask(store, options, "Many review rounds");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "candidate", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const execution = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, execution);
  run(["run", "yield", execution.id, "--summary", "candidate ready"], store, options);
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };

  for (let round = 1; round <= 10; round += 1) {
    run(["work", "review", item.id], store, leaderOptions);
    const reviewRun = store.getActiveAgentRun(task.id, "reviewer");
    markDelivered(store, reviewRun);
    run(["run", "yield", reviewRun.id, "--summary", JSON.stringify({
      summary: `review ${round}`,
      checks: [{ name: "inspection", outcome: "passed" }]
    })], store, options);
  }
  run(["work", "review", item.id], store, leaderOptions);

  assert.throws(
    () => run(["work", "accept", item.id, "--summary", "accept"], store, leaderOptions),
    /ReviewRound.*running/
  );
});

test("leader-triggered review can inspect a Leader-managed direct candidate", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "leader" }
    });
  });
  const task = createTask(store, options, "Leader direct review");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "direct candidate"], store, options);
  const item = store.listWorkItems(task.id)[0];
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };

  run(["work", "update", item.id, "running"], store, leaderOptions);
  run([
    "work", "update", item.id, "done",
    "--summary", "Leader-managed candidate is ready."
  ], store, leaderOptions);

  const awaiting = store.getWorkItem(task.id, item.id);
  assert.equal(awaiting.status, "awaiting_acceptance");
  const candidate = awaiting.candidates.at(-1);
  assert.equal(candidate.workItemRevision, awaiting.revision);
  assert.equal(candidate.summary, "Leader-managed candidate is ready.");
  assert.deepEqual(candidate.source, { type: "direct" });
  assert.deepEqual(store.listReviewRounds(task.id), []);
  assert.match(
    run(["work", "review", item.id], store, leaderOptions),
    /Review requested/
  );
  assert.equal(store.listReviewRounds(task.id)[0].candidateId, candidate.id);
});

test("a failed automatic review after Leader yield durably wakes the Leader", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "always" }
    });
  });
  const task = createTask(store, options, "Failed review handoff");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "leader candidate"], store, options);
  const item = store.listWorkItems(task.id)[0];
  const execution = dispatchTestRun(store, task.id, "leader", item.id);
  markDelivered(store, execution);
  assert.equal(store.removeGlobalRole("reviewer"), true);

  run(["run", "yield", execution.id, "--summary", "Candidate ready."], store, options);

  const [round] = store.listReviewRounds(task.id);
  assert.equal(round.status, "failed");
  assert.match(round.summary, /Global Role not found/);
  const leaderMailbox = store.getWorkMailbox({
    kind: "role",
    taskId: task.id,
    roleName: "leader"
  });
  assert.deepEqual(leaderMailbox.pending?.reasons, ["review-failed"]);
  assert.equal(
    leaderMailbox.pending?.refs.some((ref) => ref.type === "work-item" && ref.id === item.id),
    true
  );
});

test("Leader rejection preserves a Worker WorkItem for another dispatch round", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Review rounds");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "iterate", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const first = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, first);
  run(["run", "yield", first.id, "--summary", "first pass"], store, options);

  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  run(["work", "reject", item.id, "--summary", "Fix the review findings."], store, leaderOptions);
  run(["work", "dispatch", item.id, "--input", "Apply the review findings."], store, options);

  const second = store.getActiveAgentRun(task.id, "worker");
  assert.notEqual(second.id, first.id);
  assert.equal(second.mode, "new");
  assert.equal(second.workItemId, item.id);
  const iterated = store.getWorkItem(item.taskId, item.id);
  assert.equal(iterated.status, "running");
  assert.equal(iterated.executionGroups.length, 2);
  assert.notEqual(iterated.executionGroups[0].id, iterated.executionGroups[1].id);
  assert.equal(iterated.currentExecutionGroupId, iterated.executionGroups[1].id);
  assert.equal(iterated.candidates[0].executionGroupId, iterated.executionGroups[0].id);
});

test("retry replaces the old causal Run marker instead of reusing it", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Retry marker");
  run(["activate", task.id], store, options);
  const failed = failAgentRun(createAgentRun(
    "agent-run-99",
    task.id,
    "leader",
    "new",
    markYuiRunInput(
      "recover",
      "agent-run-99",
      `Yui · ${task.id} · Leader · Retry marker`
    ),
    NOW
  ), "failed before delivery", NOW);
  store.saveAgentRun(failed);

  run(["run", "retry", failed.id], store, options);

  const retried = store.getActiveAgentRun(task.id, "leader");
  const markers = retried.input.match(/^Yui · .+ · Leader · Retry marker · Run .+$/gm);
  assert.deepEqual(markers, [
    `Yui · ${task.id} · Leader · Retry marker · Run ${retried.id}`
  ]);
  assert.equal(retried.input.includes("Run agent-run-old"), false);
  assert.equal(yuiRunIdFromInputMessages([retried.input]), retried.id);
});

test("a failed Worker Run can retry its failed WorkItem", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Retry Worker work");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "recover", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const active = store.getActiveAgentRun(task.id, "worker");
  active.input = markYuiRunInput(
    "legacy Worker dispatch without an explicit yield requirement",
    active.id,
    `Yui · ${task.id} · Worker · Retry Worker work`
  );
  store.transaction((tx) => {
    tx.saveAgentRun(failAgentRun(active, "transient failure", NOW));
    tx.clearActiveAgentRun(task.id, "worker");
    tx.saveRole(task.id, updateRoleStatus(
      tx.getRole(task.id, "worker"),
      "idle",
      NOW
    ));
    // Mirror the runtime failure path: a failed execution Run terminalizes its
    // bound lane before the WorkItem is failed, so the lane reaches a retryable
    // terminal state instead of being stranded in "running". Each record moves
    // by exactly one revision, matching the runtime terminalization ordering.
    const failedItem = tx.getWorkItem(task.id, item.id);
    tx.saveWorkItem(task.id, updateWorkItemExecutionGroup(
      failedItem,
      recordExecutionLaneResult(
        currentWorkItemExecutionGroup(failedItem),
        active.executionLaneId,
        { summary: "transient failure" },
        "failed",
        NOW
      ),
      NOW
    ));
    tx.saveWorkItem(task.id, updateWorkItemStatus(
      tx.getWorkItem(task.id, item.id),
      "failed",
      NOW,
      "transient failure"
    ));
  });

  run(["run", "retry", active.id], store, options);

  assert.equal(store.getWorkItem(item.taskId, item.id)?.status, "running");
  const retried = store.getActiveAgentRun(task.id, "worker");
  assert.equal(retried?.workItemId, item.id);
  assert.match(retried.input, /yui task run yield <current-run-id>/);
  assert.match(retried.input, /final response alone does neither/i);
});

test("opaque live Sessions fail closed for public Work dispatch and Run retry", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Opaque dispatch fences");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "dispatch", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const first = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, first);
  run(["run", "yield", first.id, "--summary", "first candidate"], store, options);
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  run(["work", "reject", item.id, "--summary", "repair"], store, leaderOptions);
  recordOpaqueRoleSession(store, task.id, "worker", first);

  assert.throws(
    () => runTaskCommand(["work", "dispatch", item.id], store, options),
    /no native Session identity/i
  );
  assert.equal(store.getActiveAgentRun(task.id, "worker"), null);

  const failed = failAgentRun(createAgentRun(
    "agent-run-77",
    task.id,
    "worker",
    "new",
    markYuiRunInput(
      "retry the failed opaque WorkItem",
      "agent-run-77",
      taskRoleSessionTitle(task, "worker")
    ),
    NOW,
    {
      workItemId: item.id,
      ...(first.workspace === undefined ? {} : { workspace: first.workspace }),
      effective: first.effective
    }
  ), "transient failure", NOW);
  store.saveAgentRun(failed);
  assert.throws(
    () => runTaskCommand(["run", "retry", failed.id], store, options),
    /no native Session identity/i
  );
  assert.equal(store.getActiveAgentRun(task.id, "worker"), null);
});

test("Run marker handling preserves user-authored marker lines outside the managed header", () => {
  const userInput = [
    "Analyze this exact payload:",
    "Yui-Run: example-from-user",
    "keep the line above"
  ].join("\n");

  const marked = markYuiRunInput(
    userInput,
    "agent-run-current",
    "Yui · task-7 · Worker · Test Task"
  );
  const retried = retagYuiRunInput(
    marked,
    "agent-run-retried",
    "Yui · task-7 · Worker · Test Task"
  );

  assert.equal(marked.includes("Yui-Run: example-from-user"), true);
  assert.equal(retried.includes("Yui-Run: example-from-user"), true);
  assert.equal(
    retried.startsWith(
      "Yui · task-7 · Worker · Test Task · Run agent-run-retried\n\n"
    ),
    true
  );
  assert.equal(yuiRunIdFromInputMessages([retried]), "agent-run-retried");
  assert.equal(yuiRunIdFromInputMessages([userInput]), undefined);
});

test("first Run marking preserves a user lookalike at the start of the body", () => {
  const userInput = [
    "Yui-Run: example-from-user",
    "",
    "This is user-authored content, not a managed envelope."
  ].join("\n");

  const marked = markYuiRunInput(
    userInput,
    "agent-run-current",
    "Yui · task-7 · Worker · Test Task"
  );

  assert.equal(
    marked,
    `Yui · task-7 · Worker · Test Task · Run agent-run-current\n\n${userInput}`
  );
  assert.equal(yuiRunIdFromInputMessages([marked]), "agent-run-current");
});

test("Run parsing rejects previous marker formats", () => {
  const legacy = "Yui-Run-Id: agent-run-legacy\n\nContinue the existing Run.";

  assert.equal(yuiRunIdFromInputMessages([legacy]), undefined);
  assert.throws(
    () => retagYuiRunInput(
      legacy,
      "agent-run-current",
      "Yui · task-7 · Leader · Existing Task"
    ),
    /managed Run input header is required/iu
  );
});

test("Run retagging rejects input without a managed envelope", () => {
  assert.throws(
    () => retagYuiRunInput(
      "plain user input",
      "agent-run-retried",
      "Yui · task-7 · Worker · Test Task"
    ),
    /managed Run input header is required/iu
  );
});

test("Leader yield does not self-wake and preserves a wake queued while busy", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Leader work");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "coordinate"], store, options);
  const item = store.listWorkItems(task.id)[0];
  dispatchTestRun(store, task.id, "leader", item.id);
  const runRecord = store.getActiveAgentRun(task.id, "leader");

  markDelivered(store, runRecord);
  run(["message", "send", task.id, "arrived while Leader was busy"], store, options);
  const pending = store.getPendingWakeup(task.id);
  run(["run", "yield", runRecord.id, "--summary", "coordinated"], store, options);
  assert.deepEqual(store.getPendingWakeup(task.id), pending);
  assert.equal(store.getWorkItem(item.taskId, item.id)?.status, "completed");
});

test("Leader can track conversation-internal work without a Task Role", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Native subagent work");
  run(["activate", task.id], store, options);
  run([
    "work", "create", task.id, "Review the implementation",
    "--objective", "Use a native subagent and validate its findings.",
    "--accept", "Findings are reviewed and recorded."
  ], store, options);
  const item = store.listWorkItems(task.id).at(-1);
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };

  assert.throws(
    () => run(["work", "dispatch", item.id], store, leaderOptions),
    /Task Leader must run "yui task work update .* running".*native subagent/u
  );
  assert.throws(
    () => run(["work", "update", item.id, "running"], store, options),
    /Only the Task Leader may update unassigned Work Item execution/u
  );
  run([
    "work", "update", item.id, "running",
    "--summary", "executor=subagent; profile=reviewer@3; model=inherited"
  ], store, leaderOptions);
  assert.equal(store.getWorkItem(item.taskId, item.id)?.status, "running");
  assert.equal(store.getWorkItem(item.taskId, item.id)?.outcome, undefined);
  assert.equal(store.getActiveAgentRun(task.id, "leader"), null);

  run([
    "work", "update", item.id, "done",
    "--summary", "Leader reviewed the native subagent result and verified the evidence."
  ], store, leaderOptions);
  assert.equal(store.getWorkItem(item.taskId, item.id)?.status, "completed");
  assert.equal(
    store.getWorkItem(item.taskId, item.id)?.outcome,
    "Leader reviewed the native subagent result and verified the evidence."
  );
  const progress = store.listEvents(task.id)
    .filter(({ type }) => type === "work.updated");
  assert.equal(progress.length, 2);
  assert.deepEqual(progress[0].payload, {
    workItemId: item.id,
    status: "running",
    summary: "executor=subagent; profile=reviewer@3; model=inherited"
  });
  assert.deepEqual(progress[1].payload, {
    workItemId: item.id,
    status: "completed",
    summary: "Leader reviewed the native subagent result and verified the evidence."
  });
});

test("Leader-owned work honors dependencies and can retry directly", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Native work recovery");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "Establish the contract"], store, options);
  const prerequisite = store.listWorkItems(task.id).at(-1);
  run([
    "work", "create", task.id, "Implement the contract",
    "--after", prerequisite.id
  ], store, options);
  const implementation = store.listWorkItems(task.id).at(-1);
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };

  assert.throws(
    () => run(["work", "update", implementation.id, "running"], store, leaderOptions),
    new RegExp(`Work Item dependency is not completed: ${prerequisite.id}`)
  );
  run(["work", "update", prerequisite.id, "running"], store, leaderOptions);
  run([
    "work", "update", prerequisite.id, "done",
    "--summary", "Contract established."
  ], store, leaderOptions);
  run(["work", "update", implementation.id, "running"], store, leaderOptions);
  run([
    "work", "update", implementation.id, "failed",
    "--summary", "First native subagent result did not pass review."
  ], store, leaderOptions);
  run(["work", "update", implementation.id, "running"], store, leaderOptions);
  assert.equal(store.getWorkItem(implementation.taskId, implementation.id)?.status, "running");
  assert.equal(store.getWorkItem(implementation.taskId, implementation.id)?.outcome, undefined);
});

test("Leader control Run without a WorkItem can yield and release the pending wake boundary", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Leader wake");
  run(["activate", task.id], store, options);
  const leader = store.getRole(task.id, "leader");
  const controlRun = createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "leader",
    "new",
    "Review pending Task events",
    NOW
  );
  controlRun.pushedAt = NOW.toISOString();
  controlRun.deliveredAt = NOW.toISOString();
  store.transaction((tx) => {
    tx.saveActiveAgentRun(controlRun);
    tx.saveRole(task.id, updateRoleStatus(leader, "running", NOW));
  });
  markDelivered(store, controlRun);
  store.transaction((tx) => {
    const fence = {
      agentId: leader.activeAgentId,
      runId: controlRun.id,
      receiptId: `agent-run:${task.id}/${controlRun.id}`
    };
    const sessions = tx.getTaskRoleSessionSet(task.id, "leader")
      ?? createRoleSessionSet(
        { scope: "task", taskId: task.id, roleName: "leader" },
        leader.activeAgentId,
        NOW
      );
    tx.saveTaskRoleSessionSet(markTaskRoleRunDelivered(
      bindTaskRoleRun(sessions, fence, NOW),
      fence,
      NOW
    ));
  });

  const messagesBeforeYield = store.listMessages(task.id);
  run(["run", "yield", controlRun.id, "--summary", "reviewed"], store, options);
  const yielded = store.getAgentRun(controlRun.taskId, controlRun.id);
  assert.equal(yielded?.status, "yielded");
  assert.equal(yielded?.summary, "reviewed");
  assert.equal(store.getActiveAgentRun(task.id, "leader"), null);
  assert.equal(store.getRole(task.id, "leader")?.status, "idle");
  assert.equal(store.getPendingWakeup(task.id), null);
  assert.deepEqual(store.listMessages(task.id), messagesBeforeYield);
  assert.equal(store.getTaskRoleSessionSet(task.id, "leader").inFlight, null);
  assert.equal(store.getTaskRoleSessionSet(task.id, "leader").pendingTurnCompletion, null);
});

test("a rejected Worker control yield rolls back all staged FileTaskStore writes", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Atomic yield");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  const worker = store.getRole(task.id, "worker");
  const invalidRun = createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "worker",
    "new",
    "invalid control run",
    NOW
  );
  invalidRun.pushedAt = NOW.toISOString();
  invalidRun.deliveredAt = NOW.toISOString();
  store.transaction((tx) => {
    tx.saveActiveAgentRun(invalidRun);
    tx.saveRole(task.id, updateRoleStatus(worker, "running", NOW));
  });
  markDelivered(store, invalidRun);
  const beforeMessages = store.listMessages(task.id);

  assert.throws(
    () => runTaskCommand(
      ["run", "yield", invalidRun.id, "--summary", "must roll back"],
      store,
      options
    ),
    /not a work run/i
  );
  assert.equal(store.getAgentRun(invalidRun.taskId, invalidRun.id)?.status, "active");
  assert.equal(store.getActiveAgentRun(task.id, "worker")?.id, invalidRun.id);
  assert.equal(store.getRole(task.id, "worker")?.status, "running");
  assert.deepEqual(store.listMessages(task.id), beforeMessages);
});

test("Role bind switches the active Agent while enter remains a foreground CLI action", (t) => {
  const { store, options, calls } = fixture(t);
  const task = createTask(store, options, "Sessions");
  run(["role", "bind", task.id, "leader", "claude"], store, options);
  assert.equal(store.getRole(task.id, "leader")?.activeAgentId, "claude");
  assert.equal(store.getTaskRoleSessionSet(task.id, "leader")?.activeAgentId, "claude");
  run(["role", "bind", task.id, "leader", "codex"], store, options);
  assert.equal(store.getRole(task.id, "leader")?.activeAgentId, "codex");
  run(["role", "bind", task.id, "leader", "claude"], store, options);
  assert.equal(store.getRole(task.id, "leader")?.activeAgentId, "claude");

  assert.throws(
    () => runTaskCommand(["role", "enter", task.id, "leader"], store, options),
    /Draft.*activate/i
  );
  run(["activate", task.id], store, options);
  const execution = runTaskCommand(["enter", task.id], store, options);
  assert.deepEqual(execution, {
    kind: "enter",
    taskId: task.id,
    roleName: "leader",
    access: "read-only",
    output: `Attaching to leader for ${task.id} (read-only)\n`
  });
  assert.deepEqual(calls.enter, []);

  assert.deepEqual(
    runTaskCommand(["role", "enter", task.id, "leader", "--read-write"], store, options),
    {
      kind: "enter",
      taskId: task.id,
      roleName: "leader",
      access: "read-write",
      output: `Attaching to leader for ${task.id} (read-write)\n`
    }
  );
  let claudeSessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: "leader"
  }, "claude", NOW);
  claudeSessions = recordRoleAgentSession(claudeSessions, {
    agentId: "claude",
    adapterId: "claude",
    nativeSessionId: "claude-process-still-exiting",
    launchId: "claude-old-launch",
    policy: "fixed",
    status: "running"
  }, NOW);
  store.saveTaskRoleSessionSet(claudeSessions);
  assert.throws(
    () => runTaskCommand([
      "role", "enter", task.id, "leader", "--read-write"
    ], store, options),
    /managed Claude process.*still running/i
  );
  claudeSessions = recordRoleAgentSession(claudeSessions, {
    agentId: "claude",
    adapterId: "claude",
    nativeSessionId: "claude-process-still-exiting",
    launchId: "claude-old-launch",
    policy: "fixed",
    status: "stopped"
  }, new Date(NOW.getTime() + 1_000));
  store.saveTaskRoleSessionSet(claudeSessions);
  assert.throws(
    () => assertTaskRoleWritableAttachAvailable(
      store,
      task.id,
      "leader",
      { isManagedProcessRunning: () => true }
    ),
    /managed Claude process.*still running/i
  );
  assert.throws(
    () => runTaskCommand([
      "enter", task.id, "--read-only", "--read-write"
    ], store, options),
    /mutually exclusive/i
  );
});

test("Task Role add, update, show, and remove preserve lean field-level configuration", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Role settings");

  run([
    "role", "add", task.id, "reviewer", "--agent", "codex",
    "--description", "Review changes", "--model", "gpt-5.6-sol",
    "--effort", "high", "--permission-strategy", "configured",
    "--sandbox", "read-only", "--approval", "never"
  ], store, options);
  run([
    "role", "update", task.id, "reviewer", "--agent", "codex",
    "--clear-model", "--description", "Review safely"
  ], store, options);

  const role = store.getRole(task.id, "reviewer");
  assert.equal(role.description, "Review safely");
  assert.deepEqual(role.agentBindings.codex.config, {
    adapterId: "codex",
    effort: "high",
    permission: {
      strategy: "configured",
      sandbox: "read-only",
      approval: "never"
    }
  });

  run([
    "role", "update", task.id, "reviewer", "--agent", "claude",
    "--model", "claude-opus", "--permission-strategy", "configured",
    "--permission-mode", "dontAsk",
    "--allowed-tool", "Bash(yui task run yield *)",
    "--allowed-tool", "Read", "--allowed-tool", "Grep", "--allowed-tool", "Glob",
    "--disallowed-tool", "Edit"
  ], store, options);
  const withClaude = store.getRole(task.id, "reviewer");
  assert.equal(withClaude.activeAgentId, "codex");
  assert.deepEqual(withClaude.agentBindings.claude.config, {
    adapterId: "claude",
    model: "claude-opus",
    permission: {
      strategy: "configured",
      mode: "dontAsk",
      allowedTools: ["Bash(yui task run yield *)", "Read", "Grep", "Glob"],
      disallowedTools: ["Edit"]
    }
  });
  const shownWithToolRules = run(["role", "show", task.id, "reviewer"], store, options);
  assert.match(shownWithToolRules, /mode=dontAsk/u);
  assert.match(
    shownWithToolRules,
    /allow=Bash\(yui task[\s\S]*run yield \*\),\s+Read,\s+Grep,\s+Glob;/u
  );
  assert.match(shownWithToolRules, /deny=Edit/u);

  run([
    "role", "update", task.id, "reviewer", "--agent", "claude",
    "--clear-allowed-tools", "--clear-disallowed-tools"
  ], store, options);
  assert.deepEqual(store.getRole(task.id, "reviewer").agentBindings.claude.config, {
    adapterId: "claude",
    model: "claude-opus",
    permission: { strategy: "configured", mode: "dontAsk" }
  });

  const shown = run(["role", "show", task.id, "reviewer"], store, options);
  assert.match(shown, /Task Role: reviewer/);
  assert.match(shown, /CLI default/);
  assert.match(shown, /read-only/);
  assert.doesNotMatch(shown, /\{"adapterId"/);

  const listed = run(["role", "list", task.id], store, options);
  assert.match(listed, /Agent/);
  assert.match(listed, /Health/);
  assert.match(listed, /Native session/);
  assert.doesNotMatch(listed, /Workspace/);

  assert.match(run(["role", "remove", task.id, "reviewer"], store, options), /Removed role reviewer/);
  assert.equal(store.getRole(task.id, "reviewer"), null);
});

test("Task Role creation copies the global worker Role's complete Agent binding and reports it", (t) => {
  const { root, store, options } = fixture(t);
  store.saveGlobalRole(createGlobalRole(
    "worker",
    [createRoleAgentBinding(
      store.getConfiguredAgent("claude"),
      {
        adapterId: "claude",
        model: "sonnet",
        effort: "max",
        permission: { strategy: "bypass" }
      }
    )],
    "claude",
    root,
    NOW
  ));
  const task = createTask(store, options, "Copy configured Worker Role");

  const receipt = run(["role", "add", task.id, "investigator"], store, options);

  assert.deepEqual(
    store.getRole(task.id, "investigator")?.agentBindings.claude.config,
    {
      adapterId: "claude",
      model: "sonnet",
      effort: "max",
      permission: { strategy: "bypass" }
    }
  );
  assert.match(receipt, /Runtime source: Global Role worker/);
  assert.match(receipt, /Agent: claude\/claude/);
  assert.match(receipt, /Model: sonnet; effort: max; permission: bypass/);
  const context = run(["context", task.id], store, options);
  assert.match(context, /Runtime source at creation: Global Role worker/);
  assert.match(context, /Model: sonnet; effort: max; permission: bypass/);
});

test("integration-required Task cannot complete without delivery evidence", (t) => {
  const { store, options } = fixture(t);
  const created = run(
    ["create", "Deliver a change", "--require-integration"],
    store,
    options
  );
  const task = store.listTasks().at(-1);
  assert.match(created, /Completion: WorkItem, ChangeSet, and committed Integration required/);
  run(["activate", task.id], store, options);

  assert.throws(
    () => runTaskCommand(["complete", task.id, "--summary", "Done"], store, options),
    /requires at least one WorkItem/i
  );
});

test("file-backed Agent text preserves shell metacharacters literally", (t) => {
  const { root, store, options } = fixture(t);
  const task = createTask(store, options, "Preserve Agent text");
  const bodyPath = join(root, "message.txt");
  writeFileSync(bodyPath, "Total is -$12.34 and shell token is $0.\n");

  run(["message", "send", task.id, "--body-file", bodyPath], store, options);

  assert.equal(
    store.listMessages(task.id).at(-1).body,
    "Total is -$12.34 and shell token is $0."
  );
});

test("Leader creates a profiled Worker instance, binds Claude config, then launches Claude", (t) => {
  const { root, store, options } = fixture(t);
  const task = createTask(store, options, "Generic Worker instance");
  store.saveAgentProfile(createAgentProfile({
    id: "implementer",
    defaultAccess: "write",
    description: "Implement one bounded change.",
    instructions: "Follow the WorkItem and return validation evidence.",
    model: "profile-model-hint"
  }, NOW));

  run([
    "role", "add", task.id, "worker",
    "--profile", "implementer",
    "--agent", "codex"
  ], store, options);
  run([
    "role", "update", task.id, "worker",
    "--agent", "claude",
    "--model", "claude-opus",
    "--permission-strategy", "bypass"
  ], store, options);
  run(["role", "bind", task.id, "worker", "claude"], store, options);

  const worker = store.getRole(task.id, "worker");
  assert.equal(worker.description, "Implement one bounded change.");
  assert.equal(
    worker.systemPrompt,
    "Follow the WorkItem and return validation evidence."
  );
  assert.equal(worker.activeAgentId, "claude");
  assert.deepEqual(Object.keys(worker.agentBindings).sort(), ["claude", "codex"]);
  assert.deepEqual(worker.agentBindings.claude.config, {
    adapterId: "claude",
    model: "claude-opus",
    permission: { strategy: "bypass" }
  });
  assert.equal(worker.agentBindings.codex.config.model, undefined);

  run(["activate", task.id], store, options);
  run([
    "work", "create", task.id, "Implement the change",
    "--role", "worker"
  ], store, options);
  const item = store.listWorkItems(task.id).at(-1);
  run(["work", "dispatch", item.id], store, options);
  assert.equal(store.getRole(task.id, "worker")?.activeAgentId, "claude");
  store.saveTask({
    ...store.getTask(task.id),
    cwd: root
  });
  const taskWorkspace = createManagedWorkspace({
    owner: { type: "task", taskId: task.id },
    root,
    entries: []
  }, NOW);
  store.saveManagedWorkspace(taskWorkspace);

  const plan = new FileRoleLaunchPlanner(root, store, {
    createNativeSessionId: () => "claude-worker-session"
  }).plan({
    taskId: task.id,
    roleName: "worker",
    agentId: "claude",
    adapterId: "claude",
    mode: "new",
    effective: store.getActiveAgentRun(task.id, "worker").effective
  });
  assert.equal(plan.launch.command, "claude");
  assert.deepEqual(
    plan.launch.args.slice(
      plan.launch.args.indexOf("--model"),
      plan.launch.args.indexOf("--model") + 2
    ),
    ["--model", "claude-opus"]
  );
  assert.equal(plan.session.effective.profileAccess, "write");
  assert.deepEqual(plan.session.effective.writeProjectIds, []);
  assert.equal(plan.session.effective.permission.strategy, "bypass");
  assert.equal(plan.launch.args.includes("--dangerously-skip-permissions"), true);
  assert.equal(plan.launch.args.includes("--permission-mode"), false);
  assert.equal(plan.launch.args.includes("--disallowed-tools"), false);
  assert.equal(plan.session.nativeSessionId, "claude-worker-session");
});

test("reapplying a Worker Profile replaces portable behavior without changing Agent bindings", (t) => {
  const { root, store, options } = fixture(t);
  const localOptions = { ...options, yuiHome: root };
  mkdirSync(join(root, "skills", "review-policy"), { recursive: true });
  writeFileSync(
    join(root, "skills", "review-policy", "SKILL.md"),
    "# Review policy\n",
    "utf8"
  );
  const task = createTask(store, localOptions, "Replace Worker Profile");
  store.saveAgentProfile(createAgentProfile({
    id: "rich-worker",
    description: "Implement a bounded change.",
    instructions: "Modify the implementation.",
    skills: ["review-policy"]
  }, NOW));
  store.saveAgentProfile(createAgentProfile({
    id: "plain-worker"
  }, NOW));

  run([
    "role", "add", task.id, "worker",
    "--profile", "rich-worker",
    "--agent", "codex"
  ], store, localOptions);
  run([
    "role", "update", task.id, "worker",
    "--agent", "claude",
    "--model", "claude-opus"
  ], store, localOptions);
  const before = store.getRole(task.id, "worker");

  run([
    "role", "update", task.id, "worker",
    "--profile", "plain-worker"
  ], store, localOptions);
  const after = store.getRole(task.id, "worker");

  assert.equal(after.description, undefined);
  assert.equal(after.systemPrompt, undefined);
  assert.equal(after.skills, undefined);
  assert.deepEqual(after.constraints, ["Do not modify files or external state."]);
  assert.deepEqual(after.agentBindings, before.agentBindings);
  assert.equal(after.activeAgentId, before.activeAgentId);
});

test("Task Role removal is blocked for Leader and active Runs", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Role removal guard");
  assert.throws(
    () => runTaskCommand(["role", "remove", task.id, "leader"], store, options),
    /Leader role cannot be removed/i
  );

  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "active"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["activate", task.id], store, options);
  dispatchTestRun(store, task.id, "worker", item.id);
  assert.throws(
    () => runTaskCommand(["role", "remove", task.id, "worker"], store, options),
    /active Run/i
  );
  assert.notEqual(store.getRole(task.id, "worker"), null);
});

test("archive refuses active work and leaves its runtime ownership intact", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Archive");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "unfinished"], store, options);
  const item = store.listWorkItems(task.id)[0];
  dispatchTestRun(store, task.id, "leader", item.id);
  const active = store.getActiveAgentRun(task.id, "leader");

  assert.throws(
    () => run(["archive", task.id, "--integrated"], store, options),
    /must be completed/i
  );
  assert.equal(store.getTask(task.id)?.status, "active");
  assert.equal(store.getAgentRun(active.taskId, active.id)?.status, "active");
  assert.equal(store.getWorkItem(item.taskId, item.id)?.status, "running");
  assert.equal(store.getActiveAgentRun(task.id, "leader")?.id, active.id);
});

test("archive fails closed instead of terminalizing a residual active Run", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Residual runtime");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "residual work"], store, options);
  const item = store.listWorkItems(task.id)[0];
  dispatchTestRun(store, task.id, "leader", item.id);
  const active = store.getActiveAgentRun(task.id, "leader");
  store.saveTask(completeTask(store.getTask(task.id), NOW, {
    by: "user",
    summary: "Synthetic terminal state for the archive boundary."
  }));

  assert.throws(
    () => run(["archive", task.id, "--abandon"], store, options),
    /active Run.*Leader|Role leader.*stop its runtime/i
  );
  assert.equal(store.getTask(task.id).status, "completed");
  assert.equal(store.getAgentRun(active.taskId, active.id).status, "active");
  assert.equal(store.getActiveAgentRun(task.id, "leader").id, active.id);
  assert.equal(store.getWorkItem(task.id, item.id).status, "running");
});

test("completion fences active behavior until an explicit reopen", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Complete and reopen");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "in flight"], store, options);
  const item = store.listWorkItems(task.id)[0];
  dispatchTestRun(store, task.id, "worker", item.id);

  assert.throws(
    () => runTaskCommand(["complete", task.id, "--summary", "premature"], store, options),
    /active run|running work|unaccepted work/i
  );
  const workerRun = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, workerRun);
  run(["run", "yield", workerRun.id, "--summary", "done"], store, options);
  run([
    "work", "accept", item.id, "--summary", "reviewed"
  ], store, {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  });
  let leaderSessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: "leader"
  }, "codex", NOW);
  leaderSessions = recordRoleAgentSession(leaderSessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "leader-native-session",
    policy: "fixed",
    status: "ready"
  }, NOW);
  store.saveTaskRoleSessionSet(leaderSessions);

  run(["complete", task.id, "--summary", "Everything requested is done."], store, options);
  const completed = store.getTask(task.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.completionSummary, "Everything requested is done.");
  assert.equal(store.getPendingWakeup(task.id), null);
  assert.equal(store.getLeaderFailure(task.id), null);
  assert.deepEqual(store.getOperatorNotification(task.id), {
    schemaVersion: 1,
    taskId: task.id,
    type: "task-terminal",
    status: "completed",
    by: "user",
    summary: "Everything requested is done.",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  });
  assert.deepEqual(
    store.getWorkMailbox({ kind: "operator" }).pending.reasons,
    ["task-terminal"]
  );
  assert.equal(store.getWorkMailbox({
    kind: "role-runtime",
    taskId: task.id,
    roleName: "leader"
  }), null);
  assert.throws(
    () => runTaskCommand(["message", "send", task.id, "continue"], store, options),
    /completed.*reopen/i
  );
  assert.throws(
    () => runTaskCommand(["enter", task.id], store, options),
    /completed.*reopen/i
  );

  run(["reopen", task.id], store, options);
  assert.equal(store.getTask(task.id)?.status, "active");
  assert.deepEqual(store.getPendingWakeup(task.id)?.reasons, ["task-reopened"]);
  run(["message", "send", task.id, "continue"], store, options);
  assert.ok(store.getPendingWakeup(task.id)?.reasons.includes("user-message"));
});

test("Task completion requires every WorkItem to be terminal", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Settle work first");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "not needed"], store, options);
  const item = store.listWorkItems(task.id)[0];

  assert.throws(
    () => runTaskCommand(["complete", task.id, "--summary", "Done"], store, options),
    /unsettled work|work-item-1/i
  );
  assert.equal(store.getTask(task.id)?.status, "active");

  run([
    "work", "retire", item.id, "--summary", "No longer needed."
  ], store, {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  });
  run(["complete", task.id, "--summary", "Done"], store, options);
  assert.equal(store.getTask(task.id)?.status, "completed");
  assert.equal(store.getWorkItem(item.taskId, item.id)?.status, "retired");
});

test("a failed WorkItem can be explicitly retired after its isolated workspace was abandoned", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Recover failed isolated work");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "first attempt", "--role", "leader"], store, options);
  const item = store.listWorkItems(task.id)[0];
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const failed = updateWorkItemStatus(running, "failed", NOW, "Native session exited.");
  store.saveWorkItem(task.id, failed);
  store.saveWorkItem(
    task.id,
    recordWorkItemWorkspaceDisposition(failed, "abandoned", NOW)
  );

  run(
    ["work", "retire", item.id, "--summary", "No deliverable remains."],
    store,
    {
      ...options,
      environment: {
        YUI_SESSION_SCOPE: "task",
        YUI_TASK_ID: task.id,
        YUI_ROLE: "leader"
      }
    }
  );
  run(["complete", task.id, "--summary", "Recovered and delivered."], store, options);

  assert.equal(store.getTask(task.id)?.status, "completed");
  assert.equal(store.getWorkItem(item.taskId, item.id)?.status, "retired");
  assert.equal(store.getWorkItem(item.taskId, item.id)?.workspaceDisposition, "abandoned");
});

test("a Leader control Run can complete its Task atomically", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Leader completes");
  run(["activate", task.id], store, options);
  const leader = store.getRole(task.id, "leader");
  const controlRun = createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "leader",
    "new",
    "Review final state",
    NOW
  );
  controlRun.pushedAt = NOW.toISOString();
  controlRun.deliveredAt = NOW.toISOString();
  store.transaction((tx) => {
    tx.saveActiveAgentRun(controlRun);
    tx.saveRole(task.id, updateRoleStatus(leader, "running", NOW));
  });
  markDelivered(store, controlRun);

  run(
    ["complete", task.id, "--summary", "Final review passed."],
    store,
    {
      ...options,
      environment: {
        YUI_SESSION_SCOPE: "task",
        YUI_TASK_ID: task.id,
        YUI_ROLE: "leader"
      }
    }
  );

  assert.equal(store.getTask(task.id)?.status, "completed");
  assert.equal(store.getAgentRun(controlRun.taskId, controlRun.id)?.status, "yielded");
  assert.equal(store.getAgentRun(controlRun.taskId, controlRun.id)?.summary, "Final review passed.");
  assert.equal(store.getActiveAgentRun(task.id, "leader"), null);
  assert.equal(store.getRole(task.id, "leader")?.status, "idle");
  assert.deepEqual(store.getOperatorNotification(task.id), {
    schemaVersion: 1,
    taskId: task.id,
    type: "task-terminal",
    status: "completed",
    by: "leader",
    summary: "Final review passed.",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  });
  assert.deepEqual(
    store.getWorkMailbox({ kind: "operator" }).pending.reasons,
    ["task-terminal"]
  );
  assert.equal(store.getWorkMailbox({
    kind: "role-runtime",
    taskId: task.id,
    roleName: "leader"
  }), null);

  run(["reopen", task.id], store, options);
  assert.equal(store.getOperatorNotification(task.id), null);
});

test("a Leader session cannot complete another Task as that Task's Leader", (t) => {
  const { store, options } = fixture(t);
  const source = createTask(store, options, "Source Task");
  run(["activate", source.id], store, options);
  const target = createTask(store, options, "Target Task");
  run(["activate", target.id], store, options);
  const targetLeader = store.getRole(target.id, "leader");
  const targetRun = createAgentRun(
    store.nextAgentRunId(target.id),
    target.id,
    "leader",
    "new",
    "Target control run",
    NOW
  );
  targetRun.pushedAt = NOW.toISOString();
  targetRun.deliveredAt = NOW.toISOString();
  store.transaction((tx) => {
    tx.saveActiveAgentRun(targetRun);
    tx.saveRole(target.id, updateRoleStatus(targetLeader, "running", NOW));
  });

  assert.throws(
    () => runTaskCommand(
      ["complete", target.id, "--summary", "Wrong Task"],
      store,
      {
        ...options,
        environment: {
          YUI_SESSION_SCOPE: "task",
          YUI_TASK_ID: source.id,
          YUI_ROLE: "leader"
        }
      }
    ),
    /managed Task Session.*matching Leader/i
  );
  assert.equal(store.getTask(target.id)?.status, "active");
  assert.equal(store.getActiveAgentRun(target.id, "leader")?.id, targetRun.id);
});

test("reconcile only requests the Controller runtime", (t) => {
  const { store, options, calls } = fixture(t);
  const task = createTask(store, options, "Reconcile");
  run(["reconcile", task.id], store, options);
  assert.deepEqual(calls.reconcile, [task.id]);
  assert.equal(store.getTask(task.id)?.status, "draft");
});
