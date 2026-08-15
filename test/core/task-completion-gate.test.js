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
  supersedeIntegration,
  updateIntegrationAttempt
} from "../../dist/integration/integrationAttempt.js";
import { enqueueIntegrationQueueEntry } from "../../dist/integration/integrationQueueService.js";
import { createInputRequest } from "../../dist/input/inputRequest.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import {
  attachReviewRoundWorkspace,
  createTaskReviewRound,
  finishReviewRound,
  startReviewRound
} from "../../dist/review/reviewRound.js";
import { yieldAgentRun } from "../../dist/run/agentRun.js";
import { createProject } from "../../dist/repository/project.js";
import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, completeTask, createTask } from "../../dist/task/task.js";
import {
  createWorkItem,
  retireWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { createAgentRun } from "../helpers/effectiveLaunch.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";

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
  const candidate = submitWorkItemCandidate(item, {
    summary: "Accepted candidate",
    source: { type: "direct" }
  }, NOW);
  fx.store.saveWorkItem(fx.task.id, updateWorkItemStatus(candidate, "completed", NOW, "Accepted"));
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
  return git(fx.seed, ["rev-parse", "HEAD"]);
}

function runCompletionCli(fx, completionArgs = ["--summary", "repeat completion"]) {
  return execFileSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "task", "complete", fx.task.id, ...completionArgs],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, YUI_HOME: fx.home }
    }
  );
}

async function seedCommittedIntegrationWithDistinctSource(fx) {
  await fx.preparer.prepareTaskWorkspace(fx.task.id);
  const main = fx.store.getTaskWorkspace(fx.task.id);
  const entry = main.entries[0];
  writeFileSync(join(entry.path, "task.txt"), "Task change\n");
  git(entry.path, ["add", "task.txt"]);
  git(entry.path, ["commit", "-qm", "Task change in Task workspace"]);
  const taskHead = git(entry.path, ["rev-parse", "HEAD"]);

  // The ChangeSet comes from a normal isolated WorkItem clone. Its source
  // commit has the same tree change but a different hash from the commit
  // produced when the first Integration cherry-picks it into Task main.
  const source = join(fx.root, "work-item-source");
  execFileSync("git", ["-C", fx.checkout, "worktree", "add", "--detach", "-q", source, fx.base]);
  git(source, ["config", "user.name", "Yui Test"]);
  git(source, ["config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(source, "task.txt"), "Task change\n");
  git(source, ["add", "task.txt"]);
  git(source, ["commit", "-qm", "Task change from WorkItem"]);
  const sourceHead = git(source, ["rev-parse", "HEAD"]);
  assert.notEqual(sourceHead, taskHead);

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
    headCommit: sourceHead,
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
  return { entry, taskHead, sourceHead };
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

test("remote completion fetch and merge do not depend on shared FETCH_HEAD", async (t) => {
  const fx = fixture(t);
  const { entry } = await seedCommittedIntegration(fx);
  // Seed the pseudo-ref through the supported Git transport while the remote
  // still points at the original base. Newer Git versions reject update-ref
  // against FETCH_HEAD directly.
  git(entry.path, ["fetch", "--no-tags", fx.remote, "refs/heads/main"]);
  assert.equal(git(entry.path, ["rev-parse", "FETCH_HEAD"]), fx.base);
  const remoteHead = advanceRemote(fx);
  const gitWorkspace = new NodeGitWorkspace();

  const fetched = await gitWorkspace.fetchRemoteHeadIntoWorktree({
    repositoryPath: entry.path,
    remoteUrl: fx.remote,
    branch: "main"
  });
  assert.equal(fetched.commit, remoteHead);
  assert.equal(git(entry.path, ["rev-parse", "FETCH_HEAD"]), fx.base);
  assert.equal(
    git(entry.path, ["for-each-ref", "--format=%(refname)", "refs/yui/task-baselines"]),
    ""
  );

  // The managed Integration merge must consume its own fetched commit rather
  // than the repository-global FETCH_HEAD left by another operation.
  const result = await gitWorkspace.mergeRemoteIntoWorktree({
    repositoryPath: entry.path,
    remoteUrl: fx.remote,
    branch: "main"
  });
  assert.equal(result.changed, true);
  assert.equal(
    git(entry.path, ["merge-base", "--is-ancestor", remoteHead, "HEAD"]),
    ""
  );
  assert.equal(
    git(entry.path, ["for-each-ref", "--format=%(refname)", "refs/yui/task-baselines"]),
    ""
  );
});

test("remote-only reconciliation does not replay a distinct isolated WorkItem source commit", async (t) => {
  const fx = fixture(t);
  const { entry, taskHead, sourceHead } = await seedCommittedIntegrationWithDistinctSource(fx);
  const remoteHead = advanceRemote(fx);

  const reconciled = await reconcileTaskRemoteBaselines(
    fx.task.id,
    fx.store,
    fx.home,
    { git: new NodeGitWorkspace(), now: () => new Date(NOW) }
  );

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].remote.commit, remoteHead);
  assert.notEqual(sourceHead, taskHead);
  assert.equal(fx.store.getIntegrationAttempt(fx.task.id, reconciled[0].integrationId).status, "committed");
  assert.equal(git(entry.path, ["show", "HEAD:task.txt"]), "Task change");
  assert.equal(git(entry.path, ["show", "HEAD:remote.txt"]), "Remote change");
  assert.equal(fx.store.listIntegrationAttempts(fx.task.id).length, 2);
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

test("CLI completion skips remote reconciliation for a pending Task-final ReviewRound", async (t) => {
  const fx = fixture(t);
  const { taskHead } = await seedCommittedIntegration(fx);
  fx.store.saveReviewRound(fx.task.id, createTaskReviewRound(
    "review-round-1",
    fx.task.id,
    "work-item-1",
    "candidate-1",
    "reviewer",
    "leader",
    { schemaVersion: 1, projects: [{ projectId: fx.project.id, commit: taskHead }] },
    NOW
  ));
  const beforeHead = git(fx.store.getTaskWorkspace(fx.task.id).entries[0].path, ["rev-parse", "HEAD"]);
  const beforeIntegrations = fx.store.listIntegrationAttempts(fx.task.id).length;
  advanceRemote(fx);

  assert.throws(() => runCompletionCli(fx), /Final Task Review is still active/u);
  assert.equal(fx.store.listIntegrationAttempts(fx.task.id).length, beforeIntegrations);
  assert.equal(
    git(fx.store.getTaskWorkspace(fx.task.id).entries[0].path, ["rev-parse", "HEAD"]),
    beforeHead
  );
});

test("completion preflight marks a runless running Task-final ReviewRound for the same skip path", async (t) => {
  const fx = fixture(t);
  const { entry, taskHead } = await seedCommittedIntegration(fx);
  let round = createTaskReviewRound(
    "review-round-1",
    fx.task.id,
    "work-item-1",
    "candidate-1",
    "reviewer",
    "leader",
    { schemaVersion: 1, projects: [{ projectId: fx.project.id, commit: taskHead }] },
    NOW
  );
  const workspace = createManagedWorkspace({
    owner: { type: "review-round", taskId: fx.task.id, reviewRoundId: round.id },
    root: fx.root,
    entries: [{
      projectId: fx.project.id,
      directory: fx.project.name,
      access: "write",
      path: entry.path,
      branch: entry.branch,
      baseRef: entry.baseRef,
      baseCommit: taskHead
    }]
  }, NOW);
  const pendingRound = attachReviewRoundWorkspace(round, workspace);
  fx.store.saveReviewRound(fx.task.id, pendingRound);
  fx.store.saveAgentRun(yieldAgentRun(
    createAgentRun("agent-run-1", fx.task.id, "reviewer", "new", "Review", NOW, {
      workItemId: "work-item-1",
      purpose: "review",
      reviewRoundId: round.id,
      workspace
    }),
    "Review paused",
    NOW
  ));
  round = startReviewRound(pendingRound, "agent-run-1");
  fx.store.saveReviewRound(fx.task.id, round);

  const result = preflightTaskCompletion(fx.task.id, fx.store);
  assert.equal(result.activeTaskReview, true);
});

test("CLI completion validates summary before any remote reconciliation", async (t) => {
  for (const completionArgs of [
    [],
    ["--summary-file", join("/tmp", "yui-task-21-missing-summary.txt")]
  ]) {
    const fx = fixture(t);
    const { taskHead } = await seedCommittedIntegration(fx);
    const beforeIntegrations = fx.store.listIntegrationAttempts(fx.task.id).length;
    advanceRemote(fx);

    assert.throws(() => runCompletionCli(fx, completionArgs));
    assert.equal(fx.store.listIntegrationAttempts(fx.task.id).length, beforeIntegrations);
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

test("completion preflight rejects non-terminal integration queue work", async (t) => {
  const fx = fixture(t);
  await seedCommittedIntegration(fx);

  const source = join(fx.root, "queued-source");
  execFileSync("git", [
    "-C", fx.checkout, "worktree", "add", "--detach", "-q", source, fx.base
  ]);
  git(source, ["config", "user.name", "Yui Test"]);
  git(source, ["config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(source, "queued.txt"), "still waiting\n");
  git(source, ["add", "queued.txt"]);
  git(source, ["commit", "-qm", "queued but not settled"]);
  const queuedHead = git(source, ["rev-parse", "HEAD"]);

  let item = createWorkItem("work-item-2", fx.task.id, {
    title: "Retired after enqueue",
    writeProjectIds: [fx.project.id]
  }, NOW);
  item = updateWorkItemStatus(item, "running", NOW);
  item = submitWorkItemCandidate(item, {
    summary: "Candidate later abandoned",
    source: { type: "direct" }
  }, NOW);
  fx.store.saveWorkItem(fx.task.id, item);
  const changeSet = createWorkItemChangeSet({
    id: "change-set-2",
    taskId: fx.task.id,
    projectId: fx.project.id,
    workItemId: item.id,
    baseCommit: fx.base,
    headCommit: queuedHead,
    branch: "queued-source",
    changedPaths: ["queued.txt"]
  }, NOW);
  fx.store.saveChangeSet(fx.task.id, changeSet);
  const queued = await enqueueIntegrationQueueEntry({
    store: fx.store,
    taskId: fx.task.id,
    projectId: fx.project.id,
    changeSetId: changeSet.id,
    targetRef: "main",
    now: () => NOW
  });
  assert.equal(queued.entry.status, "queued");
  fx.store.saveWorkItem(fx.task.id, retireWorkItem(item, {
    by: "leader",
    summary: "abandon this Candidate"
  }, NOW));

  assert.throws(
    () => preflightTaskCompletion(fx.task.id, fx.store),
    /integration queue|queue entry/iu
  );
});

test("completion reconciliation skips a moved remote for a frozen Task baseline", async (t) => {
  const fx = fixture(t);
  const { entry, taskHead } = await seedCommittedIntegration(fx);
  // A completed Task-final Review for the exact current head freezes the
  // Task baseline: the delivery has been reviewed and approved, so the
  // completion gate must not merge unreviewed remote changes.
  const round = finishReviewRound(
    createTaskReviewRound(
      "review-round-1",
      fx.task.id,
      "work-item-1",
      "candidate-1",
      "reviewer",
      "leader",
      { schemaVersion: 1, projects: [{ projectId: fx.project.id, commit: taskHead }] },
      NOW
    ),
    "completed",
    "Clean Task-final review",
    NOW
  );
  fx.store.saveReviewRound(fx.task.id, round);
  const beforeIntegrations = fx.store.listIntegrationAttempts(fx.task.id).length;
  advanceRemote(fx);

  const reconciled = await reconcileTaskRemoteBaselines(
    fx.task.id,
    fx.store,
    fx.home,
    { git: new NodeGitWorkspace(), now: () => new Date(NOW) }
  );
  assert.equal(reconciled.length, 0);
  assert.equal(fx.store.listIntegrationAttempts(fx.task.id).length, beforeIntegrations);
  assert.equal(git(entry.path, ["rev-parse", "HEAD"]), taskHead);
});

test("supersedeIntegration marks a committed Integration obsolete with an audit trail", (t) => {
  const fx = fixture(t);
  const committed = updateIntegrationAttempt(createIntegrationAttempt({
    id: "integration-1",
    taskId: fx.task.id,
    projectId: fx.project.id,
    targetRef: "main",
    expectedHead: fx.base,
    changeSetIds: ["change-set-1"],
    checkCommands: []
  }, NOW), { status: "committed", candidateCommit: fx.base }, NOW);

  const superseded = supersedeIntegration(committed, "Polluted by remote SQLite merge", NOW);
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.candidateCommit, fx.base);
  assert.equal(superseded.endedAt, NOW.toISOString());
  const audit = superseded.checks?.find((check) => check.name === "superseded");
  assert.ok(audit);
  assert.equal(audit.outcome, "failed");
  assert.equal(audit.details, "Polluted by remote SQLite merge");
});

test("supersedeIntegration rejects a non-committed or already superseded Integration", (t) => {
  const fx = fixture(t);
  const running = createIntegrationAttempt({
    id: "integration-1",
    taskId: fx.task.id,
    projectId: fx.project.id,
    targetRef: "main",
    expectedHead: fx.base,
    changeSetIds: ["change-set-1"],
    checkCommands: []
  }, NOW);
  assert.throws(
    () => supersedeIntegration(running, "not committed yet", NOW),
    /cannot be superseded from running/u
  );
  const superseded = supersedeIntegration(
    updateIntegrationAttempt(running, { status: "committed", candidateCommit: fx.base }, NOW),
    "first",
    NOW
  );
  assert.throws(
    () => supersedeIntegration(superseded, "already obsolete", NOW),
    /cannot be superseded from superseded/u
  );
});

test("CLI task integration supersede marks a committed Integration obsolete", async (t) => {
  const fx = fixture(t);
  const { taskHead } = await seedCommittedIntegration(fx);

  const cliEnv = { ...process.env, YUI_HOME: fx.home };
  delete cliEnv.YUI_CONTROL_PLANE_DESCRIPTOR;
  delete cliEnv.YUI_TASK_RUNTIME_DESCRIPTOR;
  delete cliEnv.YUI_SESSION_SCOPE;
  const output = execFileSync(
    process.execPath,
    [
      join(process.cwd(), "dist", "cli.js"),
      "task", "integration", "supersede",
      `${fx.task.id}/integration-1`,
      "--reason", "Polluted by remote SQLite merge"
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: cliEnv
    }
  );
  assert.match(output, /Superseded Integration integration-1/u);
  const stored = fx.store.getIntegrationAttempt(fx.task.id, "integration-1");
  assert.equal(stored.status, "superseded");
  assert.ok(stored.endedAt);
  const audit = stored.checks?.find((check) => check.name === "superseded");
  assert.ok(audit);
  assert.equal(audit.details, "Polluted by remote SQLite merge");
});

test("task integration supersede rejects a managed non-Leader session", async (t) => {
  const fx = fixture(t);
  await seedCommittedIntegration(fx);

  // Test the authorization fence directly: a managed Worker session
  // must not be able to supersede a committed Integration
  const { taskActor } = await import("../../dist/commands/taskActor.js");
  assert.throws(
    () => taskActor(
      { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: fx.task.id, YUI_ROLE: "worker" },
      fx.task.id
    ),
    /only as the matching Leader|may perform this action only/u
  );
  // A Leader session is allowed
  assert.equal(
    taskActor(
      { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: fx.task.id, YUI_ROLE: "leader" },
      fx.task.id
    ),
    "leader"
  );
  // A user session (no managed env) is allowed
  assert.equal(taskActor({}, fx.task.id), "user");
});

test("task integration supersede rejects a queue-backed committed Attempt", async (t) => {
  const fx = fixture(t);
  await seedCommittedIntegration(fx);

  // Create a queue entry that references the committed Integration
  const queueEntry = {
    schemaVersion: 1,
    id: "integration-queue-1",
    taskId: fx.task.id,
    projectId: fx.project.id,
    changeSetId: "change-set-1",
    targetRef: fx.store.getTaskWorkspace(fx.task.id).entries[0].branch,
    checkCommands: [],
    evidenceRefs: [],
    status: "committed",
    targetAfter: fx.store.getIntegrationAttempt(fx.task.id, "integration-1").candidateCommit,
    integrationAttemptId: "integration-1",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    endedAt: NOW.toISOString()
  };
  fx.store.saveIntegrationQueueEntry(fx.task.id, queueEntry);

  const cliEnv = { ...process.env, YUI_HOME: fx.home };
  delete cliEnv.YUI_CONTROL_PLANE_DESCRIPTOR;
  delete cliEnv.YUI_TASK_RUNTIME_DESCRIPTOR;
  delete cliEnv.YUI_SESSION_SCOPE;
  assert.throws(
    () => execFileSync(
      process.execPath,
      [
        join(process.cwd(), "dist", "cli.js"),
        "task", "integration", "supersede",
        `${fx.task.id}/integration-1`,
        "--reason", "Queue-backed attempt"
      ],
      { cwd: process.cwd(), encoding: "utf8", env: cliEnv }
    ),
    /queue entry|backed by a committed queue/u
  );
  const stored = fx.store.getIntegrationAttempt(fx.task.id, "integration-1");
  assert.equal(stored.status, "committed");
});

test("task integration supersede rejects a crash-window queue-backed committed Attempt", async (t) => {
  const fx = fixture(t);
  await seedCommittedIntegration(fx);

  // This is the supported recovery state produced when the Integration target
  // and Attempt commit, but the queue processor exits before settling the
  // running entry. processIntegrationQueue normally converges it on restart.
  const queueEntry = {
    schemaVersion: 1,
    id: "integration-queue-1",
    taskId: fx.task.id,
    projectId: fx.project.id,
    changeSetId: "change-set-1",
    targetRef: fx.store.getTaskWorkspace(fx.task.id).entries[0].branch,
    checkCommands: [],
    evidenceRefs: [],
    status: "running",
    targetBefore: fx.base,
    integrationAttemptId: "integration-1",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
  fx.store.saveIntegrationQueueEntry(fx.task.id, queueEntry);

  const cliEnv = { ...process.env, YUI_HOME: fx.home };
  delete cliEnv.YUI_CONTROL_PLANE_DESCRIPTOR;
  delete cliEnv.YUI_TASK_RUNTIME_DESCRIPTOR;
  delete cliEnv.YUI_SESSION_SCOPE;
  let rejected = false;
  try {
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), "dist", "cli.js"),
        "task", "integration", "supersede",
        `${fx.task.id}/integration-1`,
        "--reason", "Queue settle crash window"
      ],
      { cwd: process.cwd(), encoding: "utf8", env: cliEnv }
    );
  } catch (error) {
    assert.match(String(error), /queue entry|backed by a committed queue/u);
    rejected = true;
  }
  assert.deepEqual({
    rejected,
    attemptStatus: fx.store.getIntegrationAttempt(fx.task.id, "integration-1").status,
    entryStatus: fx.store.getIntegrationQueueEntry(fx.task.id, "integration-queue-1").status
  }, {
    rejected: true,
    attemptStatus: "committed",
    entryStatus: "running"
  });
});

test("completion reconciliation re-checks frozen baseline after async fetch", async (t) => {
  const fx = fixture(t);
  const { taskHead } = await seedCommittedIntegration(fx);
  advanceRemote(fx);

  // Create a completed Task-final Review for the exact current head
  const round = finishReviewRound(
    createTaskReviewRound(
      "review-round-1",
      fx.task.id,
      "work-item-1",
      "candidate-1",
      "reviewer",
      "leader",
      { schemaVersion: 1, projects: [{ projectId: fx.project.id, commit: taskHead }] },
      NOW
    ),
    "completed",
    "Clean review for frozen baseline",
    NOW
  );
  fx.store.saveReviewRound(fx.task.id, round);

  // The reconciliation should skip this Project because the baseline is frozen
  const reconciled = await reconcileTaskRemoteBaselines(fx.task.id, fx.store, fx.home, {
    now: () => NOW,
    environment: { ...process.env, YUI_HOME: fx.home }
  });
  assert.equal(reconciled.length, 0);
});
