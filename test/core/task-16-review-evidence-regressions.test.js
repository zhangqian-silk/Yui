import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  enqueueIntegrationQueueEntry,
  processIntegrationQueue
} from "../../dist/integration/integrationQueueService.js";
import { createProject } from "../../dist/repository/project.js";
import { createReviewRound, finishReviewRound } from "../../dist/review/reviewRound.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import {
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { WorkItemChangeSetManager } from "../../dist/workspace/workItemChangeSetManager.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";

/**
 * Formal regressions for review-round-6 findings 1 and 2:
 *
 *   1. A completed ReviewRound whose checks failed (requires-repair) is not
 *      reusable verification evidence: only a round with an explicit positive
 *      verdict may feed a ChangeSet's evidenceRefs.
 *   2. Reusable evidence is never rebound across a target change: after a
 *      queue item commits, a waiting item with disjoint changedPaths still
 *      runs its gate against the new target instead of being marked
 *      validated by path metadata alone.
 */

const now = new Date("2026-08-14T00:00:00.000Z");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "yui-task-16-evidence-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  const repositoryPath = join(root, "repository");
  git(["init", "-b", "master", repositoryPath]);
  git(["-C", repositoryPath, "config", "user.name", "Test"]);
  git(["-C", repositoryPath, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repositoryPath, "base.txt"), "base\n");
  writeFileSync(join(repositoryPath, "config.txt"), "ONE\n");
  git(["-C", repositoryPath, "add", "-A"]);
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
  const task = activateTask(createTask(store.nextTaskId(), "Task 16 evidence", now, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: "master" }]
  }), now);
  store.saveTask(task);
  return { root, repositoryPath, home, store, project, task, baseCommit };
}

function createCapturedWorkItem(fixture, label, paths) {
  const running = updateWorkItemStatus(createWorkItem(
    fixture.store.nextWorkItemId(fixture.task.id),
    fixture.task.id,
    {
      title: label,
      acceptance: [],
      dependsOn: [],
      writeProjectIds: [fixture.project.id]
    },
    now
  ), "running", now);
  const workItem = submitWorkItemCandidate(
    running,
    { summary: label, source: { type: "direct" } },
    now
  );
  fixture.store.saveWorkItem(fixture.task.id, workItem);

  const branch = `evidence-regression/${fixture.task.id}/${workItem.id}`;
  const worktree = join(fixture.root, `worktree-${workItem.id}`);
  git([
    "-C", fixture.repositoryPath,
    "worktree", "add", "-b", branch, worktree, fixture.baseCommit
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
  const headCommit = git(["-C", worktree, "rev-parse", "HEAD"]).trim();
  fixture.store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "work-item", taskId: fixture.task.id, workItemId: workItem.id },
    root: worktree,
    entries: [{
      projectId: fixture.project.id,
      directory: fixture.project.name,
      access: "write",
      path: worktree,
      branch,
      baseRef: "master",
      baseCommit: fixture.baseCommit
    }]
  }, now));
  return { workItem, headCommit };
}

function saveCompletedReview(
  fixture,
  workItem,
  reviewBaseCommit,
  checks,
  evidenceCommit
) {
  const pending = createReviewRound(
    fixture.store.nextReviewRoundId(fixture.task.id),
    fixture.task.id,
    workItem.id,
    "candidate-1",
    "reviewer",
    "leader",
    reviewBaseCommit,
    now
  );
  const completed = finishReviewRound(
    pending,
    "completed",
    "Reviewer yielded its findings.",
    now,
    { checks, ...(evidenceCommit === undefined ? {} : { evidenceCommit }) }
  );
  fixture.store.saveReviewRound(fixture.task.id, completed);
  return completed;
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

// --- Finding 1: review evidence requires a positive verdict -----------------

test("a completed review with a failed check is not reusable verification evidence", async () => {
  const fixture = await createFixture();
  const candidate = createCapturedWorkItem(fixture, "candidate", {
    "src/candidate.js": "candidate\n"
  });
  saveCompletedReview(
    fixture,
    candidate.workItem,
    candidate.headCommit,
    [{ name: "review gate", outcome: "failed", details: "candidate is not acceptable" }]
  );

  const [changeSet] = await new WorkItemChangeSetManager(fixture.store, () => now)
    .capture(fixture.task.id, candidate.workItem.id);

  assert.deepEqual(changeSet.manifest.evidenceRefs, []);
});

test("a completed review without checks has no positive verdict and is not reused", async () => {
  const fixture = await createFixture();
  const candidate = createCapturedWorkItem(fixture, "candidate", {
    "src/candidate.js": "candidate\n"
  });
  saveCompletedReview(fixture, candidate.workItem, candidate.headCommit, []);

  const [changeSet] = await new WorkItemChangeSetManager(fixture.store, () => now)
    .capture(fixture.task.id, candidate.workItem.id);

  assert.deepEqual(changeSet.manifest.evidenceRefs, []);
});

test("a completed review with a passed check links reusable evidence", async () => {
  const fixture = await createFixture();
  const candidate = createCapturedWorkItem(fixture, "candidate", {
    "src/candidate.js": "candidate\n"
  });
  const round = saveCompletedReview(
    fixture,
    candidate.workItem,
    candidate.headCommit,
    [
      { name: "review gate", outcome: "passed" },
      { name: "advisory", outcome: "skipped" }
    ],
    candidate.headCommit
  );

  const [changeSet] = await new WorkItemChangeSetManager(fixture.store, () => now)
    .capture(fixture.task.id, candidate.workItem.id);

  assert.deepEqual(changeSet.manifest.evidenceRefs, [`review-round:${round.id}`]);
});

test("checks run on a diagnostic commit cannot waive the frozen candidate gate", async () => {
  const fixture = await createFixture();
  const candidate = createCapturedWorkItem(fixture, "candidate", {
    "src/candidate.js": "candidate\n"
  });
  const reviewWorktree = join(fixture.root, "review-worktree");
  git([
    "-C", fixture.repositoryPath,
    "worktree", "add", "-b", "review-diagnostic", reviewWorktree, candidate.headCommit
  ]);
  writeFileSync(join(reviewWorktree, "review-only.txt"), "diagnostic\n");
  git(["-C", reviewWorktree, "add", "review-only.txt"]);
  git(["-C", reviewWorktree, "commit", "-m", "review diagnostic"]);
  const diagnosticCommit = git(["-C", reviewWorktree, "rev-parse", "HEAD"]).trim();
  const gate = "test -f review-only.txt";
  execFileSync("sh", ["-c", gate], { cwd: reviewWorktree });
  saveCompletedReview(
    fixture,
    candidate.workItem,
    candidate.headCommit,
    [{ name: gate, outcome: "passed" }],
    diagnosticCommit
  );

  const [changeSet] = await new WorkItemChangeSetManager(fixture.store, () => now)
    .capture(fixture.task.id, candidate.workItem.id);
  await enqueue(fixture, changeSet, [gate]);
  const [processed] = await processIntegrationQueue(
    fixture.store,
    fixture.home,
    fixture.task.id,
    { now: () => now }
  );

  assert.equal(
    processed.entry.status,
    "conflicted",
    "a check proved only on the Reviewer's diagnostic tree must run on the frozen candidate"
  );
  assert.equal(processed.attempt.checks[0].outcome, "failed");
  assert.equal(existsSync(join(fixture.repositoryPath, "src/candidate.js")), false);
});

test("checks run with uncommitted review diagnostics cannot waive the frozen candidate gate", {
  skip: process.env.YUI_REVIEW_DIRTY_EVIDENCE !== "1"
}, async () => {
  const fixture = await createFixture();
  const candidate = createCapturedWorkItem(fixture, "candidate", {
    "src/candidate.js": "candidate\n"
  });
  const reviewWorktree = join(fixture.root, "review-worktree");
  git([
    "-C", fixture.repositoryPath,
    "worktree", "add", "-b", "review-dirty", reviewWorktree, candidate.headCommit
  ]);
  writeFileSync(join(reviewWorktree, "review-only.txt"), "diagnostic\n");
  const gate = "test -f review-only.txt";
  execFileSync("sh", ["-c", gate], { cwd: reviewWorktree });

  // snapshotReviewRunResult intentionally permits this supported dirty
  // Reviewer workflow and records no evidenceCommit.  That absence must not
  // be interpreted as proof that the check ran on the frozen candidate tree.
  saveCompletedReview(
    fixture,
    candidate.workItem,
    candidate.headCommit,
    [{ name: gate, outcome: "passed" }]
  );

  const [changeSet] = await new WorkItemChangeSetManager(fixture.store, () => now)
    .capture(fixture.task.id, candidate.workItem.id);
  await enqueue(fixture, changeSet, [gate]);
  const [processed] = await processIntegrationQueue(
    fixture.store,
    fixture.home,
    fixture.task.id,
    { now: () => now }
  );

  assert.equal(
    processed.entry.status,
    "conflicted",
    "a check proved only by uncommitted Reviewer diagnostics must run on the frozen candidate"
  );
  assert.equal(processed.attempt.checks[0].outcome, "failed");
  assert.equal(existsSync(join(fixture.repositoryPath, "src/candidate.js")), false);
});

// --- Finding 2: evidence is not rebound across a target change --------------

test("evidence for the original candidate cannot be rebound across a target change", async () => {
  const fixture = await createFixture();
  const first = createCapturedWorkItem(fixture, "change config", {
    "config.txt": "THREE\n"
  });
  const second = createCapturedWorkItem(fixture, "add app", {
    "src/app.js": "app\n"
  });
  // The second candidate carries a positive review, so its ChangeSet links
  // reusable evidence.  Its integration gate reads config.txt, which the
  // first WorkItem changes: disjoint changedPaths must not skip the gate.
  saveCompletedReview(
    fixture,
    second.workItem,
    second.headCommit,
    [{ name: "review gate", outcome: "passed" }],
    second.headCommit
  );
  const manager = new WorkItemChangeSetManager(fixture.store, () => now);
  const [firstChangeSet] = await manager.capture(fixture.task.id, first.workItem.id);
  const [secondChangeSet] = await manager.capture(fixture.task.id, second.workItem.id);
  assert.deepEqual(secondChangeSet.manifest.evidenceRefs.length, 1);
  await enqueue(fixture, firstChangeSet, ["true"]);
  await enqueue(fixture, secondChangeSet, ["! grep -q THREE config.txt"]);

  const processed = await processIntegrationQueue(
    fixture.store,
    fixture.home,
    fixture.task.id,
    { now: () => now }
  );

  assert.equal(processed[0].entry.status, "committed");
  // The second item ran its gate against the target the first commit
  // produced; the gate failed instead of being skipped by evidence rebinding.
  assert.equal(processed[1].entry.status, "conflicted");
  assert.equal(processed[1].attempt.checks[0].outcome, "failed");
  assert.equal(existsSync(join(fixture.repositoryPath, "src/app.js")), false);
});
