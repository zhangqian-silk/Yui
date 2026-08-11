import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { reconcileTaskRemoteBaselines } from "../../dist/commands/taskCompletionGate.js";
import { preflightTaskCompletion } from "../../dist/commands/taskCommands.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import {
  createIntegrationAttempt,
  updateIntegrationAttempt
} from "../../dist/integration/integrationAttempt.js";
import { createInputRequest } from "../../dist/input/inputRequest.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { yieldAgentRun } from "../../dist/run/agentRun.js";
import { createProject } from "../../dist/repository/project.js";
import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, completeTask, createTask } from "../../dist/task/task.js";
import { createWorkItem, updateWorkItemStatus } from "../../dist/workItem/workItem.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { createAgentRun } from "../helpers/effectiveLaunch.js";

const NOW = new Date("2026-08-12T00:00:00.000Z");

function git(path, args) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-task-completion-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const checkout = join(root, "checkout");
  const home = join(root, "home");
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  git(seed, ["config", "user.name", "Yui Test"]);
  git(seed, ["config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(seed, "tracked.txt"), "base\n");
  git(seed, ["add", "tracked.txt"]);
  git(seed, ["commit", "-qm", "base"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-q", "origin", "main"]);
  const base = git(seed, ["rev-parse", "HEAD"]);
  execFileSync("git", ["clone", "-q", "--branch", "main", remote, checkout]);
  git(checkout, ["config", "user.name", "Yui Test"]);
  git(checkout, ["config", "user.email", "yui@example.invalid"]);
  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);
  store.saveConfig({ schemaVersion: 1, defaultWorkspace: root });
  const project = createProject(
    "project-1",
    "project",
    checkout,
    { stable: "main", development: "main" },
    NOW,
    { remoteUrl: remote }
  );
  store.saveProject(project);
  const task = activateTask(createTask("task-1", "Remote baseline", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: "main" }],
    requireIntegration: true
  }), NOW);
  store.saveTask(task);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  return { root, remote, seed, checkout, home, store, project, task, base, preparer };
}

async function seedCommittedIntegration(fx) {
  await fx.preparer.prepareTaskWorkspace(fx.task.id);
  const main = fx.store.getTaskWorkspace(fx.task.id);
  const entry = main.entries[0];
  writeFileSync(join(entry.path, "task.txt"), "Task change\n");
  git(entry.path, ["add", "task.txt"]);
  git(entry.path, ["commit", "-qm", "Task change"]);
  const taskHead = git(entry.path, ["rev-parse", "HEAD"]);
  const item = updateWorkItemStatus(createWorkItem("work-item-1", fx.task.id, {
    title: "Integrated change",
    writeProjectIds: [fx.project.id]
  }, NOW), "running", NOW);
  fx.store.saveWorkItem(fx.task.id, updateWorkItemStatus(item, "completed", NOW, "Accepted"));
  const changeSet = createWorkItemChangeSet({
    id: "change-set-1",
    taskId: fx.task.id,
    projectId: fx.project.id,
    workItemId: item.id,
    baseCommit: fx.base,
    headCommit: taskHead,
    branch: entry.branch,
    changedPaths: ["task.txt"]
  }, NOW);
  const previous = updateIntegrationAttempt(createIntegrationAttempt({
    id: "integration-1",
    taskId: fx.task.id,
    projectId: fx.project.id,
    targetRef: entry.branch,
    expectedHead: fx.base,
    changeSetIds: [changeSet.id],
    checkCommands: []
  }, NOW), { status: "committed", candidateCommit: taskHead }, NOW);
  fx.store.transaction((tx) => {
    tx.saveChangeSet(fx.task.id, changeSet);
    tx.saveIntegrationAttempt(fx.task.id, previous);
  });
  return { entry, taskHead };
}

function advanceRemote(fx) {
  writeFileSync(join(fx.seed, "remote.txt"), "Remote change\n");
  git(fx.seed, ["add", "remote.txt"]);
  git(fx.seed, ["commit", "-qm", "Remote change"]);
  git(fx.seed, ["push", "-q", "origin", "main"]);
}

function runCompletionCli(fx) {
  return execFileSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "task", "complete", fx.task.id,
      "--summary", "repeat completion"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, YUI_HOME: fx.home }
    }
  );
}

test("completion reconciliation merges a moved remote only in managed Integration state", async (t) => {
  const fx = fixture(t);
  await fx.preparer.prepareTaskWorkspace(fx.task.id);
  const main = fx.store.getTaskWorkspace(fx.task.id);
  const entry = main.entries[0];

  writeFileSync(join(entry.path, "task.txt"), "Task change\n");
  git(entry.path, ["add", "task.txt"]);
  git(entry.path, ["commit", "-qm", "Task change"]);
  const taskHead = git(entry.path, ["rev-parse", "HEAD"]);
  const item = updateWorkItemStatus(createWorkItem("work-item-1", fx.task.id, {
    title: "Integrated change",
    writeProjectIds: [fx.project.id]
  }, NOW), "running", NOW);
  fx.store.saveWorkItem(fx.task.id, updateWorkItemStatus(item, "completed", NOW, "Accepted"));
  const changeSet = createWorkItemChangeSet({
    id: "change-set-1",
    taskId: fx.task.id,
    projectId: fx.project.id,
    workItemId: item.id,
    baseCommit: fx.base,
    headCommit: taskHead,
    branch: entry.branch,
    changedPaths: ["task.txt"]
  }, NOW);
  const previous = updateIntegrationAttempt(createIntegrationAttempt({
    id: "integration-1",
    taskId: fx.task.id,
    projectId: fx.project.id,
    targetRef: entry.branch,
    expectedHead: fx.base,
    changeSetIds: [changeSet.id],
    checkCommands: []
  }, NOW), { status: "committed", candidateCommit: taskHead }, NOW);
  fx.store.transaction((tx) => {
    tx.saveChangeSet(fx.task.id, changeSet);
    tx.saveIntegrationAttempt(fx.task.id, previous);
  });

  // Advance the remote on a separate line so the managed Task branch needs a
  // semantic merge. The stable checkout stays at the original base commit.
  writeFileSync(join(fx.seed, "remote.txt"), "Remote change\n");
  git(fx.seed, ["add", "remote.txt"]);
  git(fx.seed, ["commit", "-qm", "Remote change"]);
  const remoteHead = git(fx.seed, ["rev-parse", "HEAD"]);
  git(fx.seed, ["push", "-q", "origin", "main"]);
  assert.equal(git(fx.checkout, ["rev-parse", "HEAD"]), fx.base);

  const reconciled = await reconcileTaskRemoteBaselines(
    fx.task.id,
    fx.store,
    fx.home,
    { git: new NodeGitWorkspace(), now: () => new Date(NOW) }
  );
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].remote.commit, remoteHead);
  assert.notEqual(reconciled[0].toCommit, taskHead);
  assert.equal(git(entry.path, ["rev-parse", "HEAD"]), reconciled[0].toCommit);
  assert.equal(git(fx.checkout, ["rev-parse", "HEAD"]), fx.base);
  assert.equal(
    git(entry.path, ["merge-base", "--is-ancestor", remoteHead, "HEAD"]),
    ""
  );
  assert.equal(fx.store.getIntegrationAttempt(fx.task.id, reconciled[0].integrationId).status, "committed");
});

test("completion reconciliation fails closed when a configured remote cannot be resolved", async (t) => {
  const fx = fixture(t);
  await fx.preparer.prepareTaskWorkspace(fx.task.id);
  fx.store.saveProject({ ...fx.project, remoteUrl: join(fx.root, "missing.git") });
  const before = git(fx.checkout, ["rev-parse", "HEAD"]);
  await assert.rejects(
    reconcileTaskRemoteBaselines(fx.task.id, fx.store, fx.home),
    /remote target could not be resolved|remote.*could not be resolved/i
  );
  assert.equal(git(fx.checkout, ["rev-parse", "HEAD"]), before);
});

test("CLI completion preserves completed idempotence before remote reconciliation", async (t) => {
  const fx = fixture(t);
  const { taskHead } = await seedCommittedIntegration(fx);
  fx.store.saveTask(completeTask(fx.store.getTask(fx.task.id), NOW, {
    by: "user",
    summary: "Already delivered"
  }));
  advanceRemote(fx);

  assert.match(runCompletionCli(fx), /already completed/u);
  assert.equal(fx.store.getTask(fx.task.id).status, "completed");
  assert.equal(fx.store.listIntegrationAttempts(fx.task.id).length, 1);
  assert.equal(git(fx.store.getTaskWorkspace(fx.task.id).entries[0].path, ["rev-parse", "HEAD"]), taskHead);
});

test("CLI completion preflight blocks remote writes for open inputs, active reviews, and Integrations", async (t) => {
  for (const blocker of ["input", "review", "integration"]) {
    const fx = fixture(t);
    const { taskHead } = await seedCommittedIntegration(fx);
    advanceRemote(fx);
    if (blocker === "input") {
      const requesterRun = createAgentRun(
        "agent-run-1",
        fx.task.id,
        "leader",
        "new",
        "Request input",
        NOW
      );
      fx.store.saveAgentRun(yieldAgentRun(requesterRun, "Input request submitted", NOW));
      fx.store.saveInputRequest(fx.task.id, createInputRequest(
        "input-1",
        fx.task.id,
        { taskId: fx.task.id, roleName: "leader", agentId: "codex", runId: "agent-run-1" },
        { question: "Choose", choices: [{ key: "yes", label: "Yes" }], blockedRefs: [] },
        NOW
      ));
    } else if (blocker === "review") {
      fx.store.saveRole(fx.task.id, createRole(
        fx.task.id,
        "reviewer",
        [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
        "codex",
        fx.root,
        NOW
      ));
      fx.store.saveActiveAgentRun(createAgentRun(
        "agent-run-1",
        fx.task.id,
        "reviewer",
        "new",
        "Review exact Task head",
        NOW
      ));
    } else {
      fx.store.saveIntegrationAttempt(fx.task.id, createIntegrationAttempt({
        id: "integration-2",
        taskId: fx.task.id,
        projectId: fx.project.id,
        targetRef: fx.store.getTaskWorkspace(fx.task.id).entries[0].branch,
        expectedHead: taskHead,
        changeSetIds: ["change-set-1"],
        checkCommands: []
      }, NOW));
    }

    assert.throws(
      () => runCompletionCli(fx),
      (error) => /open input|active run for Role reviewer|unresolved Integration/u.test(
        error?.stderr?.toString() ?? ""
      )
    );
    assert.equal(fx.store.listIntegrationAttempts(fx.task.id).length, blocker === "integration" ? 2 : 1);
    assert.equal(
      git(fx.store.getTaskWorkspace(fx.task.id).entries[0].path, ["rev-parse", "HEAD"]),
      taskHead
    );
  }
});

test("completion preflight returns a no-op for a completed Task without inspecting its workspace", (t) => {
  const fx = fixture(t);
  fx.store.saveTask(completeTask(fx.task, NOW, { by: "user", summary: "Done" }));

  const result = preflightTaskCompletion(fx.task.id, fx.store);
  assert.equal(result.completed, true);
  assert.equal(result.task.id, fx.task.id);
});
