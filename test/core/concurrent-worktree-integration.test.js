import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { runTaskIntegrationCommand } from "../../dist/commands/taskIntegrationCommands.js";
import { createIntegrationAttempt } from "../../dist/integration/integrationAttempt.js";
import { GitIntegrationService } from "../../dist/integration/gitIntegrationService.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createAgentRun, yieldAgentRun } from "../../dist/run/agentRun.js";
import { createProject } from "../../dist/repository/project.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import {
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { WorkItemChangeSetManager } from "../../dist/workspace/workItemChangeSetManager.js";

const now = new Date("2026-07-26T00:00:00.000Z");

test("same-file WorkItems run in separate worktrees and a conflicting integration waits for Leader", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-integration-"));
  const repositoryPath = join(root, "repository");
  git(["init", "-b", "master", repositoryPath]);
  git(["-C", repositoryPath, "config", "user.name", "Test"]);
  git(["-C", repositoryPath, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repositoryPath, "shared.txt"), "base\n");
  git(["-C", repositoryPath, "add", "shared.txt"]);
  git(["-C", repositoryPath, "commit", "-m", "base"]);
  const baseCommit = git(["-C", repositoryPath, "rev-parse", "HEAD"]).trim();

  const home = join(root, "home");
  mkdirSync(home);
  ensureStorageSchema(home, now);
  const store = new FileTaskStore(home);
  const workspaceRoot = join(root, "workspace");
  mkdirSync(workspaceRoot);
  store.saveConfig({ schemaVersion: 1, defaultWorkspace: workspaceRoot });
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  const project = createProject(
    store.nextProjectId(),
    "fixture",
    repositoryPath,
    { stable: "master", development: "master" },
    now
  );
  store.saveProject(project);
  const task = activateTask(createTask(store.nextTaskId(), "Concurrent edits", now, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: "master" }]
  }), now);
  store.saveTask(task);
  for (const roleName of ["leader", "worker-1", "worker-2"]) {
    store.saveRole(task.id, createRole(
      task.id,
      roleName,
      [createRoleAgentBinding(agent)],
      agent.id,
      repositoryPath,
      now
    ));
  }
  const first = createWorkItem(store.nextWorkItemId(task.id), task.id, {
    title: "First edit",
    acceptance: [],
    dependsOn: [],
    assignee: "worker-1",
    writeProjectIds: [project.id]
  }, now);
  store.saveWorkItem(task.id, first);
  const second = createWorkItem(store.nextWorkItemId(task.id), task.id, {
    title: "Second edit",
    acceptance: [],
    dependsOn: [],
    assignee: "worker-2",
    writeProjectIds: [project.id]
  }, now);
  store.saveWorkItem(task.id, second);
  const leaderOptions = {
    now: () => now,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };

  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => now);
  await preparer.prepareTaskWorkspace(task.id);
  const manager = new WorkItemChangeSetManager(store, () => now);
  const firstResult = await createWriteResult(store, preparer, manager, first, "first\n");
  const secondResult = await createWriteResult(
    store,
    preparer,
    manager,
    second,
    "second\n",
    { path: "later.txt", content: "later\n" }
  );

  assert.notEqual(firstResult.workspace.root, secondResult.workspace.root);
  assert.equal(firstResult.changeSet.baseCommit, baseCommit);
  assert.equal(secondResult.changeSet.baseCommit, baseCommit);
  assert.deepEqual(firstResult.changeSet.changedPaths, ["shared.txt"]);
  assert.deepEqual(secondResult.changeSet.changedPaths, ["later.txt", "shared.txt"]);
  await assert.rejects(
    manager.assertIntegrated(first.taskId, first.id),
    /ChangeSet is not integrated/
  );

  const failedCheckIntegration = createIntegrationAttempt({
    id: store.nextIntegrationAttemptId(task.id),
    taskId: task.id,
    projectId: project.id,
    targetRef: "master",
    expectedHead: baseCommit,
    changeSetIds: [firstResult.changeSet.id],
    checkCommands: [
      "i=0; while [ \"$i\" -lt 5000 ]; do printf 'verbose-payload-%s\\n' \"$i\"; i=$((i + 1)); done; printf 'important failure\\n'; exit 7"
    ]
  }, now);
  store.saveIntegrationAttempt(task.id, failedCheckIntegration);
  const failedCheckService = new GitIntegrationService(home, store, undefined, () => now);
  const failedCheck = await failedCheckService.integrate(task.id, failedCheckIntegration.id);
  assert.equal(failedCheck.status, "failed");
  assert.match(failedCheck.attempt.checks[0].details, /code 7/);
  assert.match(failedCheck.attempt.checks[0].details, /important failure/);
  assert.doesNotMatch(failedCheck.attempt.checks[0].details, /verbose-payload-0/);
  const failedCheckLog = join(home, failedCheck.attempt.checks[0].logPath);
  assert.match(readFileSync(failedCheckLog, "utf8"), /verbose-payload-0/);
  assert.match(readFileSync(failedCheckLog, "utf8"), /important failure/);
  assert.doesNotMatch(readFileSync(join(home, "state.json"), "utf8"), /verbose-payload-0/);
  assert.equal(await failedCheckService.cleanup(failedCheck.attempt), "removed");
  assert.equal(existsSync(failedCheckLog), false);

  const firstIntegration = createIntegrationAttempt({
    id: store.nextIntegrationAttemptId(task.id),
    taskId: task.id,
    projectId: project.id,
    targetRef: "master",
    expectedHead: baseCommit,
    changeSetIds: [firstResult.changeSet.id],
    checkCommands: [
      "printf 'successful-output-%s\\n' \"$$\"; printf 'successful-error-%s\\n' \"$$\" >&2"
    ]
  }, now);
  store.saveIntegrationAttempt(task.id, firstIntegration);
  const preparationFailure = createIntegrationAttempt({
    id: store.nextIntegrationAttemptId(task.id),
    taskId: task.id,
    projectId: project.id,
    targetRef: "master",
    expectedHead: baseCommit,
    changeSetIds: [firstResult.changeSet.id]
  }, now);
  store.saveIntegrationAttempt(task.id, preparationFailure);
  const failedPreparation = await new GitIntegrationService(home, store, {
    async ensureIntegrationWorktree() {
      throw new Error("fixture worktree preparation failed");
    }
  }, () => now).integrate(task.id, preparationFailure.id);
  assert.equal(failedPreparation.status, "failed");
  assert.equal(failedPreparation.attempt.status, "failed");
  assert.equal(failedPreparation.workspace, undefined);

  const firstIntegrated = await new GitIntegrationService(home, store, undefined, () => now)
    .integrate(task.id, firstIntegration.id);
  assert.equal(firstIntegrated.status, "committed");
  assert.equal(firstIntegrated.attempt.checks[0].outcome, "passed");
  assert.equal(firstIntegrated.attempt.checks[0].details, undefined);
  const successfulCheckLog = join(home, firstIntegrated.attempt.checks[0].logPath);
  const successfulOutput = readFileSync(successfulCheckLog, "utf8").trim().split("\n");
  assert.match(successfulOutput[0], /^successful-output-\d+$/);
  assert.match(successfulOutput[1], /^successful-error-\d+$/);
  assert.doesNotMatch(
    readFileSync(join(home, "state.json"), "utf8"),
    new RegExp(successfulOutput.join("|"))
  );
  assert.match(
    (await runTaskIntegrationCommand(
      ["show", `${task.id}/${firstIntegration.id}`],
      store,
      home
    )).output,
    new RegExp(firstIntegrated.attempt.checks[0].logPath)
  );
  assert.equal(existsSync(firstIntegrated.workspace.path), true);
  const advancedHead = git(["-C", repositoryPath, "rev-parse", "master"]).trim();
  assert.notEqual(advancedHead, baseCommit);
  assert.equal(readFileSync(join(repositoryPath, "shared.txt"), "utf8"), "first\n");
  assert.equal(git(["-C", repositoryPath, "status", "--porcelain"]), "");
  store.saveWorkItem(task.id, updateWorkItemStatus(
    store.getWorkItem(task.id, first.id),
    "completed",
    now,
    "Integrated and verified."
  ));
  assert.equal(
    await preparer.cleanupWorkItemWorkspace(task.id, first.id, "integrated"),
    "removed"
  );
  assert.match(
    (await runTaskIntegrationCommand(
      ["cleanup", `${task.id}/${firstIntegration.id}`],
      store,
      home
    )).output,
    /Cleaned Integration worktree/
  );
  assert.equal(existsSync(firstResult.workspace.root), false);
  assert.equal(existsSync(firstIntegrated.workspace.path), false);
  assert.equal(existsSync(successfulCheckLog), false);
  assert.throws(() => git([
    "-C", repositoryPath, "show-ref", "--verify", "--quiet",
    `refs/heads/${firstResult.entry.branch}`
  ]));
  assert.throws(() => git([
    "-C", repositoryPath, "show-ref", "--verify", "--quiet",
    `refs/heads/${firstIntegrated.workspace.branch}`
  ]));

  const secondIntegration = createIntegrationAttempt({
    id: store.nextIntegrationAttemptId(task.id),
    taskId: task.id,
    projectId: project.id,
    targetRef: "master",
    expectedHead: advancedHead,
    changeSetIds: [secondResult.changeSet.id],
    checkCommands: ["test -f later.txt"]
  }, now);
  store.saveIntegrationAttempt(task.id, secondIntegration);
  const conflicted = await new GitIntegrationService(home, store, undefined, () => now)
    .integrate(task.id, secondIntegration.id);
  assert.equal(conflicted.status, "blocked");
  assert.deepEqual(conflicted.attempt.conflict.affectedPaths, ["shared.txt"]);
  assert.equal(git(["-C", repositoryPath, "rev-parse", "master"]).trim(), advancedHead);
  assert.equal(existsSync(firstResult.workspace.root), false);
  assert.equal(existsSync(secondResult.workspace.root), true);
  assert.equal(existsSync(conflicted.workspace.path), true);
  assert.throws(() => git([
    "-C", repositoryPath, "show-ref", "--verify", "--quiet",
    `refs/heads/${firstResult.changeSet.branch}`
  ]));
  assert.doesNotThrow(() => git([
    "-C", repositoryPath, "show-ref", "--verify",
    `refs/heads/${conflicted.workspace.branch}`
  ]));

  writeFileSync(join(conflicted.workspace.path, "shared.txt"), "resolved\n");
  git(["-C", conflicted.workspace.path, "add", "shared.txt"]);
  await assert.rejects(
    runTaskIntegrationCommand([
      "resolve",
      `${task.id}/${conflicted.attempt.id}`,
      "--option",
      "manual-resolution",
      "--rationale",
      "Keep the intended combined behavior."
    ], store, home, {
      now: () => now,
      environment: {}
    }),
    /Only the Task Leader/
  );
  const resolution = await runTaskIntegrationCommand([
    "resolve",
    conflicted.attempt.id,
    "--option",
    "manual-resolution",
    "--rationale",
    "Keep the intended combined behavior."
  ], store, home, {
    now: () => now,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  });
  const resolved = resolution.data.integration;
  const checkedContinuation = await new GitIntegrationService(home, store, undefined, () => now)
    .integrate(task.id, resolved.id);
  assert.equal(checkedContinuation.status, "committed");
  assert.equal(existsSync(checkedContinuation.workspace.path), true);
  assert.equal(readFileSync(join(repositoryPath, "shared.txt"), "utf8"), "resolved\n");
  assert.equal(readFileSync(join(repositoryPath, "later.txt"), "utf8"), "later\n");
  assert.equal(git(["-C", repositoryPath, "status", "--porcelain"]), "");

  store.saveWorkItem(task.id, updateWorkItemStatus(
    store.getWorkItem(task.id, second.id),
    "completed",
    now,
    "Conflict resolved and verified."
  ));
  assert.equal(
    await preparer.cleanupWorkItemWorkspace(task.id, second.id, "integrated"),
    "removed"
  );
  assert.match(
    runTaskCommand(
      ["complete", task.id, "--summary", "Both changes integrated."],
      store,
      leaderOptions
    ).output,
    /Completed task/
  );
  assert.equal((await preparer.cleanupTaskForArchive(task.id)).status, "removed");
  assert.match(
    runTaskCommand(["archive", task.id, "--integrated"], store, leaderOptions).output,
    /Archived task/
  );
  await assert.rejects(
    runTaskIntegrationCommand([
      "start",
      task.id,
      "--change-set",
      secondResult.changeSet.id
    ], store, home, { now: () => now, environment: {} }),
    /Task is not active/
  );
});

test("ChangeSet capture rejects a branch escape and a HEAD unrelated to the recorded base", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-change-set-integrity-"));
  const repositoryPath = join(root, "repository");
  git(["init", "-b", "master", repositoryPath]);
  git(["-C", repositoryPath, "config", "user.name", "Test"]);
  git(["-C", repositoryPath, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repositoryPath, "shared.txt"), "base\n");
  git(["-C", repositoryPath, "add", "shared.txt"]);
  git(["-C", repositoryPath, "commit", "-m", "base"]);

  const home = join(root, "home");
  mkdirSync(home);
  ensureStorageSchema(home, now);
  const store = new FileTaskStore(home);
  const workspaceRoot = join(root, "workspace");
  mkdirSync(workspaceRoot);
  store.saveConfig({ schemaVersion: 1, defaultWorkspace: workspaceRoot });
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  const project = createProject(
    store.nextProjectId(),
    "fixture",
    repositoryPath,
    { stable: "master", development: "master" },
    now
  );
  store.saveProject(project);
  const task = activateTask(createTask(store.nextTaskId(), "ChangeSet integrity", now, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: "master" }]
  }), now);
  store.saveTask(task);
  for (const roleName of ["leader", "branch-worker", "ancestry-worker"]) {
    store.saveRole(task.id, createRole(
      task.id,
      roleName,
      [createRoleAgentBinding(agent)],
      agent.id,
      repositoryPath,
      now
    ));
  }
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => now);
  await preparer.prepareTaskWorkspace(task.id);
  const manager = new WorkItemChangeSetManager(store, () => now);

  const branchWork = createWorkItem(store.nextWorkItemId(task.id), task.id, {
    title: "Branch escape",
    acceptance: [],
    dependsOn: [],
    assignee: "branch-worker",
    writeProjectIds: [project.id]
  }, now);
  store.saveWorkItem(task.id, branchWork);
  const branchWorkspace = await preparer.prepareWorkItemWorkspace(task.id, branchWork.id);
  const branchEntry = branchWorkspace.entries.find(({ access }) => access === "write");
  const branchRunning = updateWorkItemStatus(branchWork, "running", now);
  store.saveWorkItem(task.id, branchRunning);
  saveAwaitingCandidate(store, branchRunning);
  git(["-C", branchEntry.path, "checkout", "-b", "unexpected-branch"]);
  writeFileSync(join(branchEntry.path, "shared.txt"), "unexpected\n");
  await assert.rejects(
    manager.capture(task.id, branchWork.id),
    /left its managed branch/
  );
  assert.equal(
    git(["-C", branchEntry.path, "rev-parse", "HEAD"]).trim(),
    branchEntry.baseCommit
  );
  assert.match(
    git(["-C", branchEntry.path, "status", "--porcelain", "--untracked-files=all"]),
    /shared\.txt/
  );

  const ancestryWork = createWorkItem(store.nextWorkItemId(task.id), task.id, {
    title: "Unrelated history",
    acceptance: [],
    dependsOn: [],
    assignee: "ancestry-worker",
    writeProjectIds: [project.id]
  }, now);
  store.saveWorkItem(task.id, ancestryWork);
  const ancestryWorkspace = await preparer.prepareWorkItemWorkspace(task.id, ancestryWork.id);
  const ancestryEntry = ancestryWorkspace.entries.find(({ access }) => access === "write");
  const ancestryRunning = updateWorkItemStatus(ancestryWork, "running", now);
  store.saveWorkItem(task.id, ancestryRunning);
  saveAwaitingCandidate(store, ancestryRunning);
  const tree = git(["-C", ancestryEntry.path, "rev-parse", "HEAD^{tree}"]).trim();
  const unrelatedCommit = git([
    "-C", ancestryEntry.path,
    "-c", "user.name=Test",
    "-c", "user.email=test@example.com",
    "commit-tree", tree,
    "-m", "unrelated root"
  ]).trim();
  git(["-C", ancestryEntry.path, "reset", "--hard", unrelatedCommit]);
  await assert.rejects(
    manager.capture(task.id, ancestryWork.id),
    /does not descend from its recorded base/
  );
});

async function createWriteResult(
  store,
  preparer,
  manager,
  workItem,
  content,
  additionalCommit
) {
  const workspace = await preparer.prepareWorkItemWorkspace(workItem.taskId, workItem.id);
  const entry = workspace.entries.find(({ access }) => access === "write");
  writeFileSync(join(entry.path, "shared.txt"), content);
  if (additionalCommit !== undefined) {
    git(["-C", entry.path, "add", "shared.txt"]);
    git([
      "-C", entry.path,
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "commit", "-m", "first change"
    ]);
    writeFileSync(
      join(entry.path, additionalCommit.path),
      additionalCommit.content
    );
  }
  const running = updateWorkItemStatus(workItem, "running", now);
  store.saveWorkItem(workItem.taskId, running);
  saveAwaitingCandidate(store, running);
  const [changeSet] = await manager.capture(workItem.taskId, workItem.id);
  assert.notEqual(changeSet, undefined);
  return { workspace, entry, changeSet };
}

function saveAwaitingCandidate(store, running) {
  const run = yieldAgentRun(createAgentRun(
    store.nextAgentRunId(running.taskId),
    running.taskId,
    running.assignee ?? "leader",
    "new",
    "Prepare candidate.",
    now,
    { workItemId: running.id }
  ), "Candidate ready.", now);
  store.saveAgentRun(run);
  store.saveWorkItem(running.taskId, submitWorkItemCandidate(running, {
    summary: run.summary,
    source: { type: "run", runId: run.id }
  }, now));
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}
