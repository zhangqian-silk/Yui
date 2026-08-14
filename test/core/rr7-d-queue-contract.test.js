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
import { dirname, join } from "node:path";
import test from "node:test";

import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import { createChangeSetManifest } from "../../dist/integration/changeSetManifest.js";
import {
  createIntegrationAttempt
} from "../../dist/integration/integrationAttempt.js";
import {
  markIntegrationQueueBlocked,
  markIntegrationQueueRunning,
  recordIntegrationQueueAttempt
} from "../../dist/integration/integrationQueueEntry.js";
import {
  enqueueIntegrationQueueEntry,
  processIntegrationQueue,
  requeueIntegrationQueueEntry
} from "../../dist/integration/integrationQueueService.js";
import { createProject } from "../../dist/repository/project.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import {
  createWorkItem,
  retireWorkItem
} from "../../dist/workItem/workItem.js";
import { WorkItemChangeSetManager } from "../../dist/workspace/workItemChangeSetManager.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";

const now = new Date("2026-08-14T02:00:00.000Z");

const EVIDENCE = createChangeSetManifest({
  tags: [],
  deletedPaths: [],
  evidenceRefs: ["review-round:review-round-1"]
});

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function createFixture(label = "queue") {
  const root = mkdtempSync(join(tmpdir(), `yui-task-16-rr7d-${label}-`));
  const repositoryPath = join(root, "repository");
  git(["init", "-b", "master", repositoryPath]);
  git(["-C", repositoryPath, "config", "user.name", "Test"]);
  git(["-C", repositoryPath, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repositoryPath, "base.txt"), "base\n");
  git(["-C", repositoryPath, "add", "base.txt"]);
  git(["-C", repositoryPath, "commit", "-m", "base"]);
  const baseCommit = git(["-C", repositoryPath, "rev-parse", "HEAD"]).trim();

  const home = join(root, "home");
  mkdirSync(home);
  ensureStorageSchema(home, now);
  const store = new FileTaskStore(home);
  const workspaceRoot = join(root, "workspace");
  mkdirSync(workspaceRoot);
  store.saveConfig({ schemaVersion: 1, defaultWorkspace: workspaceRoot });
  const project = createProject(
    store.nextProjectId(),
    "fixture",
    repositoryPath,
    { stable: "master", development: "master" },
    now
  );
  store.saveProject(project);
  const task = activateTask(createTask(store.nextTaskId(), "Queue task", now, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: "master" }]
  }), now);
  store.saveTask(task);
  return { root, repositoryPath, home, store, project, task, baseCommit };
}

function commitOnWorktree(fixture, label, paths, base = fixture.baseCommit) {
  const branch = `review-round-7/${label}`;
  const worktree = join(fixture.root, `worktree-${label}`);
  git([
    "-C", fixture.repositoryPath,
    "worktree", "add", "-b", branch, worktree, base
  ]);
  for (const [path, content] of Object.entries(paths)) {
    const absolute = join(worktree, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  git(["-C", worktree, "add", "-A"]);
  git([
    "-C", worktree,
    "-c", "user.name=Test",
    "-c", "user.email=test@example.com",
    "commit", "-m", label
  ]);
  return {
    branch,
    worktree,
    headCommit: git(["-C", worktree, "rev-parse", "HEAD"]).trim()
  };
}

function createStoredChangeSet(fixture, id, paths, options = {}) {
  const committed = commitOnWorktree(fixture, id, paths, options.base);
  git(["-C", fixture.repositoryPath, "worktree", "remove", committed.worktree]);
  const workItem = createWorkItem(
    fixture.store.nextWorkItemId(fixture.task.id),
    fixture.task.id,
    {
      title: id,
      acceptance: [],
      dependsOn: [],
      writeProjectIds: [fixture.project.id]
    },
    now
  );
  fixture.store.saveWorkItem(fixture.task.id, workItem);
  const changeSet = createWorkItemChangeSet({
    id,
    taskId: fixture.task.id,
    workItemId: workItem.id,
    projectId: fixture.project.id,
    baseCommit: options.base ?? fixture.baseCommit,
    headCommit: committed.headCommit,
    branch: committed.branch,
    changedPaths: Object.keys(paths),
    ...(options.manifest === undefined ? {} : { manifest: options.manifest })
  }, now);
  fixture.store.saveChangeSet(fixture.task.id, changeSet);
  return changeSet;
}

async function enqueue(fixture, changeSet, checkCommands = []) {
  return enqueueIntegrationQueueEntry({
    store: fixture.store,
    taskId: fixture.task.id,
    projectId: fixture.project.id,
    changeSetId: changeSet.id,
    targetRef: "master",
    checkCommands,
    now: () => now
  });
}

async function processQueue(fixture, options = {}) {
  return processIntegrationQueue(fixture.store, fixture.home, fixture.task.id, {
    now: () => now,
    ...options
  });
}

// --- Finding 5: enqueue terminal-Candidate/lifecycle fence ------------------

test("enqueue refuses a captured retired WorkItem that never produced a Candidate", async () => {
  const fixture = createFixture("candidate-fence");
  const retired = retireWorkItem(createWorkItem(
    fixture.store.nextWorkItemId(fixture.task.id),
    fixture.task.id,
    {
      title: "abandoned",
      acceptance: [],
      dependsOn: [],
      writeProjectIds: [fixture.project.id]
    },
    now
  ), { by: "leader", summary: "abandoned before Candidate" }, now);
  fixture.store.saveWorkItem(fixture.task.id, retired);
  const committed = commitOnWorktree(fixture, "abandoned", {
    "abandoned.txt": "must not land\n"
  });
  fixture.store.saveManagedWorkspace(createManagedWorkspace({
    owner: {
      type: "work-item",
      taskId: fixture.task.id,
      workItemId: retired.id
    },
    root: committed.worktree,
    entries: [{
      projectId: fixture.project.id,
      directory: fixture.project.name,
      access: "write",
      path: committed.worktree,
      branch: committed.branch,
      baseRef: "master",
      baseCommit: fixture.baseCommit
    }]
  }, now));
  const [changeSet] = await new WorkItemChangeSetManager(fixture.store, () => now)
    .capture(fixture.task.id, retired.id);
  assert.equal(retired.candidates.length, 0);

  await assert.rejects(enqueue(fixture, changeSet), /Candidate/);
});

// --- Finding 6: lane barrier blocks a requeued predecessor ------------------

test("a running lane blocks a requeued predecessor as well as its successors", async () => {
  const fixture = createFixture("running-lane");
  const first = createStoredChangeSet(fixture, "change-set-1", {
    "first.txt": "first\n"
  });
  const second = createStoredChangeSet(fixture, "change-set-2", {
    "second.txt": "second\n"
  });
  const firstQueued = await enqueue(fixture, first, ["true"]);
  const secondQueued = await enqueue(fixture, second, ["true"]);
  const firstRunning = markIntegrationQueueRunning(
    firstQueued.entry,
    fixture.baseCommit,
    now
  );
  fixture.store.saveIntegrationQueueEntry(fixture.task.id, firstRunning);
  fixture.store.saveIntegrationQueueEntry(
    fixture.task.id,
    markIntegrationQueueBlocked(firstRunning, "retry later", now)
  );
  const secondAttempt = createIntegrationAttempt({
    id: fixture.store.nextIntegrationAttemptId(fixture.task.id),
    taskId: fixture.task.id,
    projectId: fixture.project.id,
    targetRef: "master",
    expectedHead: fixture.baseCommit,
    changeSetIds: [second.id],
    checkCommands: ["true"]
  }, now);
  fixture.store.saveIntegrationAttempt(fixture.task.id, secondAttempt);
  fixture.store.saveIntegrationQueueEntry(
    fixture.task.id,
    recordIntegrationQueueAttempt(
      markIntegrationQueueRunning(secondQueued.entry, fixture.baseCommit, now),
      secondAttempt.id,
      now
    )
  );
  requeueIntegrationQueueEntry(
    fixture.store,
    fixture.task.id,
    firstQueued.entry.id,
    () => now
  );

  const processed = await processQueue(fixture, { limit: 1 });

  assert.equal(processed.length, 0);
  assert.equal(
    fixture.store.getIntegrationQueueEntry(fixture.task.id, firstQueued.entry.id).status,
    "queued"
  );
});

// --- Finding 7: exact-SHA evidence -> validated -> skip checks --------------

test("durable exact-SHA evidence validates an unchanged-target entry and a target advance re-runs its checks", async () => {
  const fixture = createFixture("evidence-reuse");

  // An entry with positive exact-SHA evidence on an unchanged target is
  // validated at enqueue and commits without running its checks.
  const first = createStoredChangeSet(fixture, "change-set-1", {
    "first.txt": "first\n"
  }, { manifest: EVIDENCE });
  const enqueued = await enqueue(fixture, first, ["false"]);
  assert.equal(enqueued.outcome, "queued");
  assert.equal(enqueued.entry.status, "validated");
  assert.equal(enqueued.entry.evidenceTargetHead, fixture.baseCommit);

  const processed = await processQueue(fixture);
  assert.equal(processed.length, 1);
  assert.equal(processed[0].entry.status, "committed");
  // The evidence covered the exact target, so the checks were skipped: the
  // "false" gate never ran (it would have failed the entry otherwise).
  assert.deepEqual(processed[0].attempt.checkCommands, []);
  assert.deepEqual(processed[0].attempt.checks, []);
  assert.equal(
    readFileSync(join(fixture.repositoryPath, "first.txt"), "utf8"),
    "first\n"
  );

  // A second evidenced entry is validated at enqueue against the advanced
  // target; an out-of-band advance then invalidates the evidence, so its
  // checks run against the new target instead of being skipped.
  const targetAfterFirst = processed[0].entry.targetAfter;
  const second = createStoredChangeSet(fixture, "change-set-2", {
    "second.txt": "second\n"
  }, { base: targetAfterFirst, manifest: EVIDENCE });
  const secondEnqueued = await enqueue(fixture, second, ["false"]);
  assert.equal(secondEnqueued.entry.status, "validated");
  assert.equal(secondEnqueued.entry.evidenceTargetHead, targetAfterFirst);

  // An out-of-band advance on a disjoint path moves the target.
  writeFileSync(join(fixture.repositoryPath, "advanced.txt"), "advanced\n");
  git(["-C", fixture.repositoryPath, "add", "advanced.txt"]);
  git(["-C", fixture.repositoryPath, "commit", "-m", "out-of-band advance"]);

  const secondPass = await processQueue(fixture);
  assert.equal(secondPass.length, 1);
  assert.equal(secondPass[0].entry.status, "conflicted");
  // The evidence was invalidated: the checks ran (and failed) on the new
  // target rather than being skipped.
  assert.deepEqual(secondPass[0].attempt.checkCommands, ["false"]);
  assert.equal(secondPass[0].attempt.checks[0].outcome, "failed");
  // The failed change never reached the target.
  assert.equal(
    existsSync(join(fixture.repositoryPath, "second.txt")),
    false
  );
});
