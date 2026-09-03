import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createTaskRemoteDeliveryProof } from "../../dist/commands/taskRemoteDeliveryCommand.js";
import { runTaskUpstreamCommand } from "../../dist/commands/taskUpstreamCommands.js";
import { GitIntegrationService } from "../../dist/integration/gitIntegrationService.js";
import {
  createIntegrationAttempt,
  recordResolutionDecision
} from "../../dist/integration/integrationAttempt.js";
import { createProject } from "../../dist/repository/project.js";
import { TaskWorkspaceCoordinator } from "../../dist/repository/taskWorkspaceCoordinator.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import {
  createTaskReviewRound,
  finishReviewRound
} from "../../dist/review/reviewRound.js";
import { createTaskFinalReviewContract } from "../../dist/review/taskFinalReviewContract.js";
import { latestStorageVersionState } from "../../dist/storage/upgrade/recordVersions.js";
import { inspectStorageSchema } from "../../dist/storage/storageSchema.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { projectNextAction } from "../../dist/task/nextAction.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import {
  createCandidateGitSnapshot,
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

const now = new Date("2026-08-27T00:00:00.000Z");
const userEnv = sanitizedTestEnv();
const gitEnv = sanitizedTestEnv({
  GIT_AUTHOR_NAME: "Yui Test",
  GIT_AUTHOR_EMAIL: "yui-test@example.com",
  GIT_COMMITTER_NAME: "Yui Test",
  GIT_COMMITTER_EMAIL: "yui-test@example.com"
});

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();
}

function commitFile(repo, name, body, message) {
  writeFileSync(join(repo, name), body);
  git(["add", "."], repo);
  git(["commit", "-m", message], repo);
}

function newHome(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-project-lifecycle-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function newStore(t, home) {
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  return store;
}

/**
 * A bare remote plus a Home-managed clone that has diverged from it: one
 * local-only commit on the checkout and one remote-only commit on the seed.
 */
function setupDivergedCheckout(home, projectId) {
  const remote = join(home, "remote.git");
  execFileSync("git", ["init", "--bare", "--initial-branch=master", remote], { env: gitEnv });
  const seed = join(home, "seed");
  execFileSync("git", ["clone", remote, seed], { env: gitEnv });
  commitFile(seed, "README.md", "# seed\n", "seed");
  git(["push", "origin", "master"], seed);
  mkdirSync(join(home, "projects"), { recursive: true });
  const checkout = join(home, "projects", projectId);
  execFileSync("git", ["clone", remote, checkout], { env: gitEnv });
  commitFile(checkout, "local.txt", "local\n", "local work");
  commitFile(seed, "remote.txt", "remote\n", "remote work");
  git(["push", "origin", "master"], seed);
  return { remote, seed, checkout };
}

function registerManagedProject(store, projectId, checkout, remote) {
  const project = createProject(
    projectId,
    "app",
    checkout,
    { stable: "master", development: "master" },
    now,
    { remoteUrl: remote, ownership: "managed" }
  );
  store.saveProject(project);
  return project;
}

test("Task activation clones the remote branch into an independent Task repository", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const workspaceRoot = mkdtempSync(join(tmpdir(), "yui-task-workspace-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  store.saveConfig({
    ...store.getConfig(),
    defaultWorkspace: workspaceRoot
  });
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  const remoteHead = git(["rev-parse", "refs/heads/master"], remote);
  const task = createTask(store.nextTaskId(), "Independent Task clone", now, {
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "master" }]
  });
  store.saveTask(task);

  const activated = await new FileTaskWorkspacePreparer(home, store)
    .activateTaskWorkspace(task.id);
  const persisted = store.getTask(task.id);
  const taskWorkspace = store.getTaskWorkspace(task.id);
  const taskEntry = taskWorkspace.entries[0];

  assert.equal(activated.status, "ready");
  assert.equal(persisted.status, "active");
  assert.equal(persisted.projectBindings[0].baseRef, "master");
  assert.equal(persisted.projectBindings[0].baseCommit, remoteHead);
  assert.equal(persisted.projectBindings[0].currentCommit, remoteHead);
  assert.notEqual(taskEntry.path, checkout);
  assert.equal(git(["rev-parse", "HEAD"], taskEntry.path), remoteHead);
  assert.notEqual(
    git(["rev-parse", "--path-format=absolute", "--git-common-dir"], taskEntry.path),
    git(["rev-parse", "--path-format=absolute", "--git-common-dir"], checkout)
  );
  assert.equal(existsSync(join(taskEntry.path, "local.txt")), false);
  assert.equal(
    store.listEvents(task.id).find(({ type }) => type === "task.base-provenance")?.payload.source,
    "remote-fetch"
  );
});

test("Task activation rolls back every fresh clone when one remote cannot be cloned", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const workspaceRoot = mkdtempSync(join(tmpdir(), "yui-task-workspace-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  store.saveConfig({ ...store.getConfig(), defaultWorkspace: workspaceRoot });
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  const secondCheckout = join(home, "projects", "project-2");
  execFileSync("git", ["clone", remote, secondCheckout], { env: gitEnv });
  store.saveProject(createProject(
    "project-2",
    "broken",
    secondCheckout,
    { stable: "master", development: "master" },
    now,
    { remoteUrl: join(home, "missing.git"), ownership: "managed" }
  ));
  const task = createTask(store.nextTaskId(), "Atomic activation", now, {
    projectBindings: [
      { projectId: "project-1", directory: "app", baseRef: "master" },
      { projectId: "project-2", directory: "broken", baseRef: "master" }
    ]
  });
  store.saveTask(task);

  await assert.rejects(
    new FileTaskWorkspacePreparer(home, store).activateTaskWorkspace(task.id),
    /clone|repository|remote|missing/iu
  );

  const persisted = store.getTask(task.id);
  assert.equal(persisted.status, "draft");
  assert.equal(persisted.cwd, undefined);
  assert.equal(persisted.workspaceIdentity, undefined);
  assert.equal(store.getTaskWorkspace(task.id), null);
  assert.deepEqual(store.listManagedWorkspaces(task.id), []);
  assert.deepEqual(store.listTurns(task.id), []);
  assert.equal(existsSync(join(workspaceRoot, "tasks", task.id)), false);
});

test("WorkItem no-op Integration records the decision and archive removes all code workspaces", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const workspaceRoot = mkdtempSync(join(tmpdir(), "yui-task-workspace-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  store.saveConfig({ ...store.getConfig(), defaultWorkspace: workspaceRoot });
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  const task = createTask(store.nextTaskId(), "No-op delivery", now, {
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "master" }]
  });
  store.saveTask(task);
  const preparer = new FileTaskWorkspacePreparer(home, store);
  await preparer.activateTaskWorkspace(task.id);
  const taskWorkspace = store.getTaskWorkspace(task.id);
  const taskEntry = taskWorkspace.entries[0];
  const beforeCommit = store.getTask(task.id).projectBindings[0].currentCommit;

  let item = createWorkItem(
    store.nextWorkItemId(task.id),
    task.id,
    { title: "Confirm existing behavior", writeProjectIds: ["project-1"] },
    now
  );
  item = updateWorkItemStatus(item, "running", now);
  store.saveWorkItem(task.id, item);
  const workItemWorkspace = await preparer.prepareWorkItemWorkspace(task.id, item.id);
  const resultCommit = git(["rev-parse", "HEAD"], workItemWorkspace.entries[0].path);
  item = submitWorkItemCandidate(item, {
    summary: "The requested behavior is already present.",
    source: { type: "direct" },
    workspace: workItemWorkspace,
    gitSnapshot: createCandidateGitSnapshot(workItemWorkspace, [{
      projectId: "project-1",
      commit: resultCommit
    }])
  }, now);
  store.saveWorkItem(task.id, item);

  const attempt = createIntegrationAttempt({
    id: store.nextIntegrationAttemptId(task.id),
    taskId: task.id,
    projectId: "project-1",
    targetRef: taskEntry.branch,
    beforeCommit,
    source: {
      kind: "work-item",
      workItemId: item.id,
      startCommit: resultCommit,
      resultCommit,
      strategy: "manual"
    }
  }, now);
  store.saveIntegrationAttempt(task.id, attempt);
  const service = new GitIntegrationService(home, store);
  const blocked = await service.integrate(task.id, attempt.id);
  assert.equal(blocked.status, "blocked");
  const rationale = "The Leader confirmed that this WorkItem requires no code change.";
  store.saveIntegrationAttempt(task.id, recordResolutionDecision(blocked.attempt, {
    action: "manual-resolution",
    rationale
  }, "leader", now));
  const integrated = await service.integrate(task.id, attempt.id);

  assert.equal(integrated.status, "committed", JSON.stringify(integrated.attempt, null, 2));
  assert.equal(integrated.attempt.beforeCommit, beforeCommit);
  assert.equal(integrated.attempt.afterCommit, beforeCommit);
  assert.match(integrated.attempt.summary, /intentionally not applied/iu);
  assert.match(integrated.attempt.summary, new RegExp(rationale, "u"));
  assert.equal(git(["rev-parse", "HEAD"], taskEntry.path), beforeCommit);
  assert.equal(store.listChangeSets(task.id).length, 0);

  store.saveWorkItem(task.id, updateWorkItemStatus(item, "completed", now, "accepted no-op"));
  runTaskCommand([
    "complete",
    task.id,
    "--summary",
    "No code change was required."
  ], store, {
    now: () => now,
    environment: userEnv,
    actualTaskReviewCandidate: {
      schemaVersion: 1,
      projects: [{ projectId: "project-1", commit: beforeCommit }]
    }
  });
  const archiveRemoteDeliveryProof = createTaskRemoteDeliveryProof(
    store,
    store.getTask(task.id)
  );
  const coordinator = new TaskWorkspaceCoordinator(store, preparer, {
    async stopTaskRoleSessions() {},
    async assertTaskPhysicalResourcesReleased() {}
  });
  const cleaned = await coordinator.cleanupTaskForArchive(task.id, "integrated");
  assert.equal(cleaned.status, "removed");
  assert.equal(existsSync(taskEntry.path), false);
  assert.deepEqual(store.listManagedWorkspaces(task.id), []);

  runTaskCommand(["archive", task.id, "--integrated"], store, {
    now: () => now,
    environment: userEnv,
    archiveRemoteDeliveryProof
  });
  assert.equal(store.getTask(task.id).status, "archived");
  assert.equal(store.getWorkItem(task.id, item.id).status, "completed");
  assert.equal(store.getIntegrationAttempt(task.id, attempt.id).status, "committed");
});

test("upstream rebase uses the unified Integration lifecycle without ChangeSets", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const workspaceRoot = mkdtempSync(join(tmpdir(), "yui-task-workspace-"));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  store.saveConfig({ ...store.getConfig(), defaultWorkspace: workspaceRoot });
  const { remote, seed, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  const task = createTask(store.nextTaskId(), "Upstream rebase", now, {
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "master" }]
  });
  store.saveTask(task);
  const preparer = new FileTaskWorkspacePreparer(home, store);
  await preparer.activateTaskWorkspace(task.id);
  const taskEntry = store.getTaskWorkspace(task.id).entries[0];
  commitFile(taskEntry.path, "task.txt", "task\n", "task change");
  const beforeCommit = git(["rev-parse", "HEAD"], taskEntry.path);
  assert.notEqual(
    store.getTask(task.id).projectBindings[0].currentCommit,
    beforeCommit,
    "the command should synchronize a direct Task-main commit before Integration"
  );
  commitFile(seed, "remote-2.txt", "remote 2\n", "remote change 2");
  git(["push", "origin", "master"], seed);
  const remoteCommit = git(["rev-parse", "HEAD"], seed);

  const commandResult = await runTaskUpstreamCommand(
    ["integrate", task.id, "--latest"],
    store,
    home,
    { now: () => now, environment: userEnv }
  );
  const integrated = commandResult.data.integrations[0];

  assert.equal(integrated.status, "committed", JSON.stringify(integrated.attempt, null, 2));
  assert.equal(integrated.attempt.beforeCommit, beforeCommit);
  assert.notEqual(integrated.attempt.afterCommit, beforeCommit);
  assert.equal(git(["rev-parse", "HEAD^"], taskEntry.path), remoteCommit);
  assert.ok(existsSync(join(taskEntry.path, "task.txt")));
  assert.ok(existsSync(join(taskEntry.path, "remote-2.txt")));
  assert.equal(
    store.getTask(task.id).projectBindings[0].currentCommit,
    integrated.attempt.afterCommit
  );
  assert.equal(store.listChangeSets(task.id).length, 0);
  assert.equal(integrated.attempt.source.kind, "upstream");
  assert.match(commandResult.output, /Upstream Integration results/u);
  const integrationWorkspace = store.getIntegrationWorkspace(task.id, integrated.attempt.id);
  assert.ok(integrationWorkspace);
  const integrationEntry = integrationWorkspace.entries[0];
  assert.equal(
    git(["symbolic-ref", "--short", "HEAD"], integrationEntry.path),
    integrationEntry.branch
  );
  assert.equal(
    await preparer.cleanupIntegrationWorkspace(task.id, integrated.attempt.id),
    "removed"
  );
  assert.equal(existsSync(integrationEntry.path), false);
});

test("a completed Review remains usable information after the Task head changes", () => {
  const oldCommit = "a".repeat(40);
  const currentCommit = "b".repeat(40);
  const task = activateTask(createTask("task-1", "Review information", now, {
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "master" }]
  }), now);
  const contract = createTaskFinalReviewContract({
    taskId: task.id,
    reviewerRoleName: "reviewer",
    controlPlaneDigest: "c".repeat(64)
  });
  const round = finishReviewRound(createTaskReviewRound(
    "review-round-1",
    task.id,
    "reviewer",
    "leader",
    {
      schemaVersion: 1,
      projects: [{ projectId: "project-1", commit: oldCommit }]
    },
    now,
    contract
  ), "completed", "Reviewed the earlier head.", now, {
    checks: [{ name: "review", outcome: "passed" }],
    evidenceCommit: oldCommit
  });

  const action = projectNextAction({
    task,
    workItems: [],
    changeSets: [],
    integrations: [],
    integrationQueueEntries: [],
    reviewRounds: [round],
    reviewConfig: { roleName: "reviewer", trigger: "final" },
    openInputRequests: [],
    activeTurns: [],
    leaderTurns: [],
    currentTaskReviewCandidate: {
      schemaVersion: 1,
      projects: [{ projectId: "project-1", commit: currentCommit }]
    }
  });

  assert.equal(action.kind, "complete-task");
  assert.doesNotMatch(action.reason, /no valid Task-final Review/iu);
});

test("project reset refuses divergence without --discard-local and lists the local commits", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  const localHead = git(["rev-parse", "HEAD"], checkout);

  await assert.rejects(
    runProjectCommand(["reset", "project-1"], store, { now: () => now, environment: userEnv }),
    /diverged[\s\S]*local work[\s\S]*--discard-local/u
  );
  // The refusal must not have moved the checkout.
  assert.equal(git(["rev-parse", "HEAD"], checkout), localHead);
});

test("project reset --discard-local hard-resets the checkout to the verified remote baseline", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);

  const result = await runProjectCommand(
    ["reset", "project-1", "--discard-local"],
    store,
    { now: () => now, environment: userEnv }
  );
  const remoteHead = git(["--git-dir", remote, "rev-parse", "master"], home);
  assert.match(result.output, /Reset project project-1/u);
  assert.equal(git(["rev-parse", "HEAD"], checkout), remoteHead);
  assert.ok(!existsSync(join(checkout, "local.txt")), "the discarded local commit's files must be gone");
  assert.ok(existsSync(join(checkout, "remote.txt")), "the remote commit's files must be present");
});

test("project reset fast-forwards a checkout that is only behind the remote", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, seed, checkout } = setupDivergedCheckout(home, "project-1");
  // Undo the local-only commit so the checkout is merely behind.
  git(["reset", "--hard", "HEAD~1"], checkout);
  registerManagedProject(store, "project-1", checkout, remote);

  const result = await runProjectCommand(
    ["reset", "project-1"],
    store,
    { now: () => now, environment: userEnv }
  );
  const remoteHead = git(["--git-dir", remote, "rev-parse", "master"], home);
  assert.match(result.output, /fast-forward/u);
  assert.equal(git(["rev-parse", "HEAD"], checkout), remoteHead);
  assert.ok(existsSync(join(checkout, "remote.txt")));
  assert.ok(!existsSync(join(seed, "local.txt")));
});

test("project reset refuses a dirty checkout", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  writeFileSync(join(checkout, "uncommitted.txt"), "dirty\n");

  await assert.rejects(
    runProjectCommand(["reset", "project-1", "--discard-local"], store, { now: () => now, environment: userEnv }),
    /clean/u
  );
});

test("project reset refuses a managed Task Session", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);

  await assert.rejects(
    runProjectCommand(
      ["reset", "project-1", "--discard-local"],
      store,
      { now: () => now, environment: { YUI_SESSION_SCOPE: "task" } }
    ),
    /Operator authority/u
  );
});

test("project replace re-clones the checkout and preserves Yui-local refs", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, seed, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  // A Yui-local ref that must survive the checkout replacement.
  const oldHead = git(["rev-parse", "HEAD"], checkout);
  git(["branch", "yui/task-1/worker"], checkout);
  // Advance the remote so the replace actually changes content.
  commitFile(seed, "remote2.txt", "remote2\n", "remote work 2");
  git(["push", "origin", "master"], seed);

  const result = await runProjectCommand(
    ["replace", "project-1", "--discard-local"],
    store,
    { now: () => now, environment: userEnv }
  );
  const remoteHead = git(["--git-dir", remote, "rev-parse", "master"], home);
  assert.match(result.output, /Replaced project project-1/u);
  assert.equal(git(["rev-parse", "HEAD"], checkout), remoteHead);
  assert.equal(git(["rev-parse", "yui/task-1/worker"], checkout), oldHead);
  assert.ok(existsSync(join(checkout, "remote2.txt")));
  assert.ok(
    !existsSync(join(home, "projects", ".replace-project-1")),
    "the staging clone must be gone after a successful replace"
  );
});

test("project replace requires --discard-local", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);

  await assert.rejects(
    runProjectCommand(["replace", "project-1"], store, { now: () => now, environment: userEnv }),
    /--discard-local/u
  );
});

test("project replace refuses a dirty checkout", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  writeFileSync(join(checkout, "uncommitted.txt"), "dirty\n");
  const headBefore = git(["rev-parse", "HEAD"], checkout);

  await assert.rejects(
    runProjectCommand(["replace", "project-1", "--discard-local"], store, { now: () => now, environment: userEnv }),
    /clean/u
  );
  // The refusal must not have moved the checkout or left swap debris.
  assert.equal(git(["rev-parse", "HEAD"], checkout), headBefore);
  assert.ok(existsSync(join(checkout, "uncommitted.txt")));
  assert.ok(!existsSync(join(home, "projects", ".replace-project-1")));
  assert.ok(!existsSync(join(home, "projects", ".replace-backup-project-1")));
});

test("project replace heals a crashed swap and completes", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, seed, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  commitFile(seed, "remote2.txt", "remote2\n", "remote work 2");
  git(["push", "origin", "master"], seed);
  // Simulate a crash between the two swap renames: the live checkout is gone
  // and the previous checkout is parked at the backup path.
  const backup = join(home, "projects", ".replace-backup-project-1");
  renameSync(checkout, backup);

  const result = await runProjectCommand(
    ["replace", "project-1", "--discard-local"],
    store,
    { now: () => now, environment: userEnv }
  );
  const remoteHead = git(["--git-dir", remote, "rev-parse", "master"], home);
  assert.match(result.output, /Replaced project project-1/u);
  assert.equal(git(["rev-parse", "HEAD"], checkout), remoteHead);
  assert.ok(existsSync(join(checkout, "remote2.txt")));
  assert.ok(!existsSync(join(checkout, "local.txt")), "the discarded local commit must be gone");
  assert.ok(!existsSync(backup), "the backup must be removed after the healed swap");
  assert.ok(!existsSync(join(home, "projects", ".replace-project-1")), "the staging clone must be gone");
});

test("project retire records the audit trail and blocks further mutation", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);

  const result = await runProjectCommand(
    ["retire", "project-1", "--reason", "superseded by app-ng"],
    store,
    { now: () => now, environment: userEnv }
  );
  assert.match(result.output, /Retired project project-1/u);
  const retired = store.listProjects().find(({ id }) => id === "project-1");
  assert.equal(retired.status, "retired");
  assert.equal(retired.retirement.reason, "superseded by app-ng");
  assert.equal(retired.retirement.retiredBy, "user");
  assert.equal(retired.retirement.retiredAt, now.toISOString());

  // Read-only inspection still works and shows the lifecycle state.
  const shown = await runProjectCommand(["show", "project-1"], store, { now: () => now, environment: userEnv });
  assert.match(shown.output, /Status: retired/u);
  assert.match(shown.output, /Retirement reason: superseded by app-ng/u);

  // Every mutation path is now closed.
  await assert.rejects(
    runProjectCommand(["retire", "project-1", "--reason", "again"], store, { now: () => now, environment: userEnv }),
    /retired/u
  );
  await assert.rejects(
    runProjectCommand(["refresh", "project-1"], store, { now: () => now, environment: userEnv }),
    /retired/u
  );
  await assert.rejects(
    runProjectCommand(["update", "project-1", "--alias", "renamed"], store, { now: () => now, environment: userEnv }),
    /retired/u
  );
  await assert.rejects(
    runProjectCommand(["reset", "project-1", "--discard-local"], store, { now: () => now, environment: userEnv }),
    /retired/u
  );
});

test("project retire refuses while an active Task binds the Project", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  const task = activateTask(createTask(store.nextTaskId(), "Active delivery", now, {
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "master" }]
  }), now);
  store.saveTask(task);

  await assert.rejects(
    runProjectCommand(["retire", "project-1", "--reason", "x"], store, { now: () => now, environment: userEnv }),
    /active Task/u
  );
  assert.equal(store.listProjects()[0].status, "active");
});

test("project delete requires a retired Project and an exact --confirm", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);

  await assert.rejects(
    runProjectCommand(["delete", "project-1", "--confirm", "project-1"], store, { now: () => now, environment: userEnv }),
    /retired/u
  );
  await runProjectCommand(["retire", "project-1", "--reason", "done"], store, { now: () => now, environment: userEnv });
  await assert.rejects(
    runProjectCommand(["delete", "project-1", "--confirm", "wrong"], store, { now: () => now, environment: userEnv }),
    /--confirm project-1/u
  );
  assert.ok(store.listProjects().length === 1, "the wrong confirm must not delete the record");
});

test("project delete fails closed while any Task record references the Project", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  // A historical (completed) Task binding: the evidence must stay resolvable.
  const task = createTask(store.nextTaskId(), "Shipped feature", now, {
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "master" }]
  });
  store.saveTask(task);
  await runProjectCommand(["retire", "project-1", "--reason", "done"], store, { now: () => now, environment: userEnv });

  await assert.rejects(
    runProjectCommand(["delete", "project-1", "--confirm", "project-1"], store, { now: () => now, environment: userEnv }),
    /Task records reference/u
  );
  assert.ok(store.listProjects().length === 1);
});

test("project delete removes the catalog record and, with --checkout, the managed checkout", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  await runProjectCommand(["retire", "project-1", "--reason", "done"], store, { now: () => now, environment: userEnv });

  const result = await runProjectCommand(
    ["delete", "project-1", "--checkout", "--confirm", "project-1"],
    store,
    { now: () => now, environment: userEnv }
  );
  assert.match(result.output, /Deleted project project-1/u);
  assert.equal(store.listProjects().length, 0);
  assert.ok(!existsSync(checkout), "the managed checkout must be removed with --checkout");
  assert.ok(!existsSync(join(home, "projects", ".delete-project-1")), "the tombstone must be gone");
});

test("project delete --checkout refuses linked worktrees before touching the catalog", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  await runProjectCommand(["retire", "project-1", "--reason", "done"], store, { now: () => now, environment: userEnv });
  // A linked worktree that shares the checkout's object store.
  const linked = join(home, "linked-wt");
  git(["worktree", "add", "--detach", linked, "HEAD"], checkout);
  t.after(() => rmSync(linked, { recursive: true, force: true }));

  await assert.rejects(
    runProjectCommand(
      ["delete", "project-1", "--checkout", "--confirm", "project-1"],
      store,
      { now: () => now, environment: userEnv }
    ),
    /linked worktrees/u
  );
  // The refusal must leave both the catalog record and the checkout intact.
  assert.equal(store.listProjects().length, 1, "the catalog record must survive the refusal");
  assert.ok(existsSync(checkout), "the checkout must survive the refusal");
  assert.ok(existsSync(join(checkout, "local.txt")));
  assert.ok(!existsSync(join(home, "projects", ".delete-project-1")), "no tombstone may be left behind");
});

test("project delete --checkout refuses a dirty checkout", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  await runProjectCommand(["retire", "project-1", "--reason", "done"], store, { now: () => now, environment: userEnv });
  writeFileSync(join(checkout, "uncommitted.txt"), "dirty\n");

  await assert.rejects(
    runProjectCommand(
      ["delete", "project-1", "--checkout", "--confirm", "project-1"],
      store,
      { now: () => now, environment: userEnv }
    ),
    /clean/u
  );
  assert.equal(store.listProjects().length, 1, "the catalog record must survive the refusal");
  assert.ok(existsSync(join(checkout, "uncommitted.txt")), "the dirty checkout must be untouched");
  assert.ok(!existsSync(join(home, "projects", ".delete-project-1")), "no tombstone may be left behind");
});

test("project delete --checkout restores the checkout when the catalog removal is refused", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  // A historical (completed) Task binding keeps the catalog removal refused.
  const task = createTask(store.nextTaskId(), "Shipped feature", now, {
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "master" }]
  });
  store.saveTask(task);
  await runProjectCommand(["retire", "project-1", "--reason", "done"], store, { now: () => now, environment: userEnv });
  const headBefore = git(["rev-parse", "HEAD"], checkout);

  await assert.rejects(
    runProjectCommand(
      ["delete", "project-1", "--checkout", "--confirm", "project-1"],
      store,
      { now: () => now, environment: userEnv }
    ),
    /Task records reference/u
  );
  // The two-phase flow must have rolled the tombstone rename back: catalog
  // record and checkout agree as if the delete never ran.
  assert.equal(store.listProjects().length, 1, "the catalog record must survive the refusal");
  assert.equal(git(["rev-parse", "HEAD"], checkout), headBefore, "the checkout must be restored intact");
  assert.ok(existsSync(join(checkout, "local.txt")));
  assert.ok(!existsSync(join(home, "projects", ".delete-project-1")), "the tombstone must be gone after rollback");
});

test("project delete --checkout heals a crashed first attempt", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  await runProjectCommand(["retire", "project-1", "--reason", "done"], store, { now: () => now, environment: userEnv });
  // Simulate a crash after phase 1: the checkout is parked at its tombstone.
  const tombstone = join(home, "projects", ".delete-project-1");
  renameSync(checkout, tombstone);

  const result = await runProjectCommand(
    ["delete", "project-1", "--checkout", "--confirm", "project-1"],
    store,
    { now: () => now, environment: userEnv }
  );
  assert.match(result.output, /Deleted project project-1/u);
  assert.equal(store.listProjects().length, 0);
  assert.ok(!existsSync(checkout), "the restored checkout must be removed by the healed run");
  assert.ok(!existsSync(tombstone), "the tombstone must be gone");
});

test("task create refuses to bind a retired Project", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  await runProjectCommand(["retire", "project-1", "--reason", "done"], store, { now: () => now, environment: userEnv });

  assert.throws(
    () => runTaskCommand(["create", "New delivery", "--project", "project-1"], store, { now: () => now, environment: userEnv }),
    /retired/u
  );
});

test("a retired Project refuses every knowledge write while keeping reads", async (t) => {
  const home = newHome(t);
  const store = newStore(t, home);
  const { remote, checkout } = setupDivergedCheckout(home, "project-1");
  registerManagedProject(store, "project-1", checkout, remote);
  await runProjectCommand(["retire", "project-1", "--reason", "done"], store, { now: () => now, environment: userEnv });

  const writeAttempts = [
    ["knowledge", "add", "project-1", "title", "--body", "body"],
    ["knowledge", "retire", "project-1", "knowledge-1"],
    ["knowledge", "propose", "project-1", "--title", "t", "--body", "b", "--task", "task-1"],
    ["knowledge", "accept", "project-1", "proposal-1"],
    ["knowledge", "reject", "project-1", "proposal-1", "--reason", "x"]
  ];
  for (const args of writeAttempts) {
    await assert.rejects(
      runProjectCommand(args, store, { now: () => now, environment: userEnv }),
      /retired/u,
      `expected ${args.join(" ")} to be refused on a retired Project`
    );
  }
  // No write may have landed.
  const retired = store.listProjects().find(({ id }) => id === "project-1");
  assert.equal(retired.knowledge.length, 0);
  assert.equal(retired.knowledgeProposals.length, 0);

  // Read-only inspection stays open so historical evidence stays auditable.
  const listed = await runProjectCommand(["knowledge", "list", "project-1"], store, { now: () => now, environment: userEnv });
  assert.match(listed.output, /No project knowledge found/u);
  const proposals = await runProjectCommand(
    ["knowledge", "proposals", "list", "project-1"],
    store,
    { now: () => now, environment: userEnv }
  );
  assert.ok(proposals.output.length > 0, "the proposals read path must stay open");
});

test("production storage rejects historical record versions", () => {
  const latest = latestStorageVersionState();
  const home = mkdtempSync(join(tmpdir(), "yui-historical-record-"));
  try {
    writeFileSync(join(home, "schema.json"), JSON.stringify({
      schemaVersion: 1,
      storageVersion: latest.layout,
      aggregateSchemaVersion: latest.aggregate,
      recordVersions: {
        ...Object.fromEntries(Object.entries(latest.record).map(([kind, entry]) => [kind, entry.version])),
        project: latest.record.project.version - 1
      },
      updatedAt: now.toISOString()
    }));
    const state = inspectStorageSchema(home);
    assert.equal(state.status, "unsupported");
    assert.equal(state.incompatibleComponent, "record");
    assert.equal(state.recordFamily, "project");
    assert.equal(state.direction, "older");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
