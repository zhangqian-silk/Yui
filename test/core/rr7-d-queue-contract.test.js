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
import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
import { createReviewRound, finishReviewRound } from "../../dist/review/reviewRound.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import {
  createWorkItem,
  retryFailedWorkItem,
  retireWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { WorkItemChangeSetManager } from "../../dist/workspace/workItemChangeSetManager.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";

const now = new Date("2026-08-14T02:00:00.000Z");

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

/**
 * A ChangeSet whose manifest carries a real ReviewRound evidence ref.  The
 * round's single passed check covers `options.checkName` so the queue can
 * validate the entry and skip that exact gate.
 */
function createEvidencedChangeSet(fixture, id, paths, options = {}) {
  const committed = commitOnWorktree(fixture, id, paths, options.base);
  git(["-C", fixture.repositoryPath, "worktree", "remove", committed.worktree]);
  const workItem = createWorkItem(
    fixture.store.nextWorkItemId(fixture.task.id),
    fixture.task.id,
    { title: id, acceptance: [], dependsOn: [], writeProjectIds: [fixture.project.id] },
    now
  );
  const running = updateWorkItemStatus(workItem, "running", now);
  fixture.store.saveWorkItem(fixture.task.id, running);
  const withCandidate = submitWorkItemCandidate(
    running,
    { summary: id, source: { type: "direct" } },
    now
  );
  fixture.store.saveWorkItem(fixture.task.id, withCandidate);
  const round = finishReviewRound(createReviewRound(
    fixture.store.nextReviewRoundId(fixture.task.id),
    fixture.task.id,
    workItem.id,
    withCandidate.candidates[0].id,
    "reviewer",
    "leader",
    committed.headCommit,
    now
  ), "completed", "reviewed", now, {
    checks: [{ name: options.checkName ?? "false", outcome: "passed" }]
  });
  fixture.store.saveReviewRound(fixture.task.id, round);
  const changeSet = createWorkItemChangeSet({
    id,
    taskId: fixture.task.id,
    workItemId: workItem.id,
    projectId: fixture.project.id,
    baseCommit: options.base ?? fixture.baseCommit,
    headCommit: committed.headCommit,
    branch: committed.branch,
    changedPaths: Object.keys(paths),
    manifest: createChangeSetManifest({
      tags: [],
      deletedPaths: [],
      evidenceRefs: [`review-round:${round.id}`]
    })
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

test("a running lane blocks an equivalent full-ref target spelling", async () => {
  const fixture = createFixture("running-ref-alias");
  const first = createStoredChangeSet(fixture, "change-set-1", {
    "first.txt": "first\n"
  });
  const second = createStoredChangeSet(fixture, "change-set-2", {
    "second.txt": "second\n"
  });
  const firstQueued = await enqueue(fixture, first, ["true"]);
  await enqueueIntegrationQueueEntry({
    store: fixture.store,
    taskId: fixture.task.id,
    projectId: fixture.project.id,
    changeSetId: second.id,
    targetRef: "refs/heads/master",
    checkCommands: ["true"],
    now: () => now
  });
  fixture.store.saveIntegrationQueueEntry(
    fixture.task.id,
    markIntegrationQueueRunning(firstQueued.entry, fixture.baseCommit, now)
  );

  const processed = await processQueue(fixture, { limit: 1 });

  assert.equal(
    processed.length,
    0,
    "short and full ref spellings of the same branch must share one running barrier"
  );
});

test("a short branch target cannot converge against an ambiguous same-named tag", async () => {
  const fixture = createFixture("target-ref-tag-ambiguity");
  const candidate = createCandidateWorkspace(fixture, "tagged-candidate", {
    "candidate.txt": "candidate\n"
  });
  const changeSet = await captureCandidate(fixture, candidate);
  // Git permits a branch and tag to share a name. A short target names the
  // branch throughout Integration, while generic rev-parse resolves the tag
  // first. Pointing the tag at the ChangeSet must not create a false
  // convergence proof for the still-unchanged branch.
  git(["-C", fixture.repositoryPath, "tag", "master", changeSet.headCommit]);

  const enqueued = await enqueue(fixture, changeSet);

  assert.equal(
    enqueued.outcome,
    "queued",
    "the queue must inspect refs/heads/master, not a same-named tag"
  );
  assert.equal(
    git(["-C", fixture.repositoryPath, "rev-parse", "refs/heads/master"]).trim(),
    fixture.baseCommit
  );
});

// --- Finding 7: exact-SHA evidence -> validated -> skip checks --------------

test("durable exact-SHA evidence validates an unchanged-target entry and a target advance re-runs its checks", async () => {
  const fixture = createFixture("evidence-reuse");

  // An entry with positive exact-SHA evidence on an unchanged target is
  // validated at enqueue and commits without running its checks.  The
  // evidence is a real ReviewRound whose passed check covers the exact
  // queue gate command.
  const first = createEvidencedChangeSet(fixture, "change-set-1", {
    "first.txt": "first\n"
  });
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
  const second = createEvidencedChangeSet(fixture, "change-set-2", {
    "second.txt": "second\n"
  }, { base: targetAfterFirst });
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

// --- Task-final reviewer diagnostics ---------------------------------------

function createCandidateWorkspace(fixture, label, paths, options = {}) {
  const committed = commitOnWorktree(fixture, label, paths);
  if (options.distinctCommitter === true) {
    git([
      "-C", committed.worktree,
      "-c", "user.name=Reviewed Worker",
      "-c", "user.email=reviewed-worker@example.com",
      "commit", "--amend", "--no-edit"
    ]);
    committed.headCommit = git([
      "-C", committed.worktree, "rev-parse", "HEAD"
    ]).trim();
  }
  const workItem = submitWorkItemCandidate(
    updateWorkItemStatus(createWorkItem(
      fixture.store.nextWorkItemId(fixture.task.id),
      fixture.task.id,
      {
        title: label,
        acceptance: [],
        dependsOn: [],
        writeProjectIds: [fixture.project.id]
      },
      now
    ), "running", now),
    { summary: label, source: { type: "direct" } },
    now
  );
  fixture.store.saveWorkItem(fixture.task.id, workItem);
  fixture.store.saveManagedWorkspace(createManagedWorkspace({
    owner: {
      type: "work-item",
      taskId: fixture.task.id,
      workItemId: workItem.id
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
  return { workItem, ...committed };
}

function savePositiveReview(fixture, candidate, checks) {
  const round = finishReviewRound(createReviewRound(
    fixture.store.nextReviewRoundId(fixture.task.id),
    fixture.task.id,
    candidate.workItem.id,
    "candidate-1",
    "reviewer",
    "leader",
    candidate.headCommit,
    now
  ), "completed", "reviewed", now, { checks });
  fixture.store.saveReviewRound(fixture.task.id, round);
  return round;
}

async function captureCandidate(fixture, candidate) {
  const [changeSet] = await new WorkItemChangeSetManager(fixture.store, () => now)
    .capture(fixture.task.id, candidate.workItem.id);
  return changeSet;
}

test("enqueue refuses a ChangeSet captured from a superseded Candidate", async () => {
  const fixture = createFixture("candidate-current-fence");
  const firstCandidate = createCandidateWorkspace(fixture, "candidate-1", {
    "candidate.txt": "rejected\n"
  });
  const rejectedChangeSet = await captureCandidate(fixture, firstCandidate);

  const failed = updateWorkItemStatus(
    firstCandidate.workItem,
    "failed",
    now,
    "candidate rejected"
  );
  fixture.store.saveWorkItem(fixture.task.id, failed);
  const retried = retryFailedWorkItem(failed, now);
  fixture.store.saveWorkItem(fixture.task.id, retried);

  writeFileSync(join(firstCandidate.worktree, "candidate.txt"), "accepted\n");
  git(["-C", firstCandidate.worktree, "add", "candidate.txt"]);
  git(["-C", firstCandidate.worktree, "commit", "-m", "candidate-2"]);
  const current = submitWorkItemCandidate(
    retried,
    { summary: "candidate-2", source: { type: "direct" } },
    now
  );
  fixture.store.saveWorkItem(fixture.task.id, current);
  await captureCandidate(fixture, { workItem: current });

  await assert.rejects(
    enqueue(fixture, rejectedChangeSet, ["true"]),
    /current Candidate|superseded Candidate/
  );
});

test("enqueue refuses a rejected ChangeSet while its WorkItem retry has no current Candidate", async () => {
  const fixture = createFixture("candidate-retry-window");
  const rejectedCandidate = createCandidateWorkspace(fixture, "rejected-candidate", {
    "candidate.txt": "rejected\n"
  });
  const rejectedChangeSet = await captureCandidate(fixture, rejectedCandidate);
  const failed = updateWorkItemStatus(
    rejectedCandidate.workItem,
    "failed",
    now,
    "candidate rejected"
  );
  fixture.store.saveWorkItem(fixture.task.id, failed);
  const retrying = retryFailedWorkItem(failed, now);
  fixture.store.saveWorkItem(fixture.task.id, retrying);
  assert.equal(retrying.status, "running");

  await assert.rejects(
    enqueue(fixture, rejectedChangeSet, ["true"]),
    /current Candidate|superseded Candidate/,
    "a historical Candidate must not become current merely because the worktree HEAD has not moved yet"
  );
});

test("enqueue rechecks the current Candidate after asynchronous target inspection", async () => {
  const fixture = createFixture("candidate-enqueue-race");
  const rejectedCandidate = createCandidateWorkspace(fixture, "racing-candidate", {
    "candidate.txt": "rejected\n"
  });
  const rejectedChangeSet = await captureCandidate(fixture, rejectedCandidate);

  let notifyPaused;
  const paused = new Promise((resolve) => { notifyPaused = resolve; });
  let releaseTargetInspection;
  const released = new Promise((resolve) => { releaseTargetInspection = resolve; });
  class PausingTargetGit extends NodeGitWorkspace {
    async inspect(repositoryPath, baseRef) {
      const result = await super.inspect(repositoryPath, baseRef);
      if (repositoryPath === fixture.repositoryPath && baseRef === "refs/heads/master") {
        notifyPaused();
        await released;
      }
      return result;
    }
  }

  const enqueueing = enqueueIntegrationQueueEntry({
    store: fixture.store,
    taskId: fixture.task.id,
    projectId: fixture.project.id,
    changeSetId: rejectedChangeSet.id,
    targetRef: "master",
    checkCommands: ["true"],
    git: new PausingTargetGit(),
    now: () => now
  });
  await paused;

  try {
    const concurrentStore = new FileTaskStore(fixture.home);
    const current = concurrentStore.getWorkItem(fixture.task.id, rejectedCandidate.workItem.id);
    const failed = updateWorkItemStatus(current, "failed", now, "candidate rejected");
    concurrentStore.saveWorkItem(fixture.task.id, failed);
    concurrentStore.saveWorkItem(fixture.task.id, retryFailedWorkItem(failed, now));
  } finally {
    releaseTargetInspection();
  }

  await assert.rejects(
    enqueueing,
    /current Candidate|superseded Candidate/,
    "the enqueue transaction must not commit after the checked Candidate became historical"
  );
});

test("queue processing does not land an entry after its Candidate enters retry", async () => {
  const fixture = createFixture("candidate-process-retry");
  const rejectedCandidate = createCandidateWorkspace(fixture, "queued-candidate", {
    "candidate.txt": "rejected\n"
  });
  const rejectedChangeSet = await captureCandidate(fixture, rejectedCandidate);
  await enqueue(fixture, rejectedChangeSet, ["true"]);

  const failed = updateWorkItemStatus(
    rejectedCandidate.workItem,
    "failed",
    now,
    "candidate rejected"
  );
  fixture.store.saveWorkItem(fixture.task.id, failed);
  fixture.store.saveWorkItem(fixture.task.id, retryFailedWorkItem(failed, now));

  const processed = await processQueue(fixture, { limit: 1 });

  assert.equal(
    git(["-C", fixture.repositoryPath, "rev-parse", "refs/heads/master"]).trim(),
    fixture.baseCommit,
    "a queued historical Candidate must fail closed instead of advancing the target"
  );
  assert.deepEqual(
    processed,
    [],
    "a stale entry is diagnosed at claim time without starting an Integration Attempt"
  );
  const stale = fixture.store.getIntegrationQueueEntry(
    fixture.task.id,
    "integration-queue-1"
  );
  assert.equal(
    stale.status,
    "conflicted",
    "the failed-closed diagnosis must persist so the Leader can supersede it"
  );
  assert.match(stale.conflictSummary, /current Candidate|superseded Candidate/);
  assert.deepEqual(fixture.store.listIntegrationAttempts(fixture.task.id), []);
});

test("review evidence cannot waive a different queue gate", async () => {
  const fixture = createFixture("evidence-command-scope");
  const candidate = createCandidateWorkspace(fixture, "reviewed-command", {
    "reviewed.txt": "reviewed\n"
  });
  savePositiveReview(fixture, candidate, [
    { name: "true", outcome: "passed" }
  ]);
  const changeSet = await captureCandidate(fixture, candidate);
  assert.equal(changeSet.manifest.evidenceRefs.length, 1);

  await enqueue(fixture, changeSet, ["false"]);
  const [processed] = await processQueue(fixture);

  assert.deepEqual(processed.attempt.checkCommands, ["false"]);
  assert.equal(processed.entry.status, "conflicted");
  assert.equal(existsSync(join(fixture.repositoryPath, "reviewed.txt")), false);
});

test("exact-SHA evidence is not rebound to a cherry-picked candidate SHA", async () => {
  const fixture = createFixture("evidence-candidate-sha");
  const candidate = createCandidateWorkspace(fixture, "reviewed-sha", {
    "sha.txt": "reviewed\n"
  }, { distinctCommitter: true });
  const exactHeadCheck = `test "$(git rev-parse HEAD)" = '${candidate.headCommit}'`;
  savePositiveReview(fixture, candidate, [
    { name: exactHeadCheck, outcome: "passed" }
  ]);
  const changeSet = await captureCandidate(fixture, candidate);

  await enqueue(fixture, changeSet, [exactHeadCheck]);
  const [processed] = await processQueue(fixture);
  if (processed.entry.status === "committed") {
    assert.equal(
      processed.entry.targetAfter,
      changeSet.headCommit,
      "evidence may skip the gate only if the integrated candidate remains the reviewed SHA"
    );
  } else {
    assert.equal(processed.entry.status, "conflicted");
    assert.ok(processed.attempt.checks.some(({ outcome }) => outcome === "failed"));
  }
});

test("an identical-tree target advance still invalidates exact-SHA evidence", async () => {
  const fixture = createFixture("evidence-empty-target-advance");
  const candidate = createCandidateWorkspace(fixture, "reviewed-empty-advance", {
    "sha.txt": "reviewed\n"
  });
  const exactHeadCheck = `test "$(git rev-parse HEAD)" = '${candidate.headCommit}'`;
  savePositiveReview(fixture, candidate, [
    { name: exactHeadCheck, outcome: "passed" }
  ]);
  const changeSet = await captureCandidate(fixture, candidate);
  const enqueued = await enqueue(fixture, changeSet, [exactHeadCheck]);
  assert.equal(enqueued.entry.status, "validated");

  git([
    "-C", fixture.repositoryPath,
    "commit", "--allow-empty", "-m", "metadata-only target advance"
  ]);
  const advancedHead = git([
    "-C", fixture.repositoryPath,
    "rev-parse", "refs/heads/master"
  ]).trim();
  assert.notEqual(advancedHead, fixture.baseCommit);
  assert.equal(
    git(["-C", fixture.repositoryPath, "diff", "--name-only", fixture.baseCommit, advancedHead]),
    "",
    "the target SHA changed while its file tree stayed identical"
  );

  const [processed] = await processQueue(fixture, { limit: 1 });
  assert.deepEqual({
    checkCommands: processed.attempt.checkCommands,
    status: processed.entry.status,
    targetHead: git([
      "-C", fixture.repositoryPath,
      "rev-parse", "refs/heads/master"
    ]).trim()
  }, {
    checkCommands: [exactHeadCheck],
    status: "conflicted",
    targetHead: advancedHead
  }, "evidence for the old exact target must not waive a gate on a new commit identity");
});

test("tree or ancestor convergence still honors an explicitly requested gate", async () => {
  const fixture = createFixture("convergence-gate");
  const candidate = createCandidateWorkspace(fixture, "already-landed", {
    "landed.txt": "landed\n"
  });
  const changeSet = await captureCandidate(fixture, candidate);
  git(["-C", fixture.repositoryPath, "merge", "--ff-only", candidate.branch]);
  writeFileSync(join(fixture.repositoryPath, "broken.txt"), "broken\n");
  git(["-C", fixture.repositoryPath, "add", "broken.txt"]);
  git(["-C", fixture.repositoryPath, "commit", "-m", "break the target"]);

  const enqueued = await enqueue(fixture, changeSet, ["test ! -f broken.txt"]);
  const finalEntry = enqueued.outcome === "converged"
    ? enqueued.entry
    : (await processQueue(fixture))[0].entry;
  const attempt = fixture.store.getIntegrationAttempt(
    fixture.task.id,
    finalEntry.integrationAttemptId
  );

  assert.deepEqual(attempt.checkCommands, ["test ! -f broken.txt"]);
  assert.equal(finalEntry.status, "conflicted");
});

test("recovery replay does not invalidate evidence with commits older than the entry", async () => {
  const fixture = createFixture("recovery-history-boundary");
  const historical = createStoredChangeSet(fixture, "change-set-1", {
    "shared.txt": "historical\n"
  });
  await enqueue(fixture, historical, ["true"]);
  const [landed] = await processQueue(fixture);
  assert.equal(landed.entry.status, "committed");

  // This candidate and its evidence are based on the target *after* the first
  // queue entry committed. Historical queue records therefore cannot describe
  // a target advance that happened after this entry was enqueued.
  const currentHead = landed.entry.targetAfter;
  const reviewed = createEvidencedChangeSet(fixture, "change-set-2", {
    "shared.txt": "reviewed\n"
  }, { base: currentHead, checkName: "false" });
  const enqueued = await enqueue(fixture, reviewed, ["false"]);
  assert.equal(enqueued.entry.status, "validated");
  assert.equal(enqueued.entry.evidenceTargetHead, currentHead);

  const [processed] = await processQueue(fixture);
  assert.equal(processed.entry.status, "committed");
  assert.deepEqual(
    processed.attempt.checkCommands,
    [],
    "an older committed entry must not revoke exact-head evidence for a later enqueue"
  );
});

test("recovery replay ignores every historical ancestor of a later entry base", async () => {
  const fixture = createFixture("recovery-transitive-history-boundary");
  const firstHistorical = createStoredChangeSet(fixture, "change-set-1", {
    "shared.txt": "historical-1\n"
  });
  await enqueue(fixture, firstHistorical, ["true"]);
  const [firstLanded] = await processQueue(fixture);
  assert.equal(firstLanded.entry.status, "committed");

  const secondHistorical = createStoredChangeSet(fixture, "change-set-2", {
    "shared.txt": "historical-2\n"
  }, { base: firstLanded.entry.targetAfter });
  await enqueue(fixture, secondHistorical, ["true"]);
  const [secondLanded] = await processQueue(fixture);
  assert.equal(secondLanded.entry.status, "committed");

  const currentHead = secondLanded.entry.targetAfter;
  const reviewed = createEvidencedChangeSet(fixture, "change-set-3", {
    "shared.txt": "reviewed\n"
  }, { base: currentHead, checkName: "false" });
  const enqueued = await enqueue(fixture, reviewed, ["false"]);
  assert.equal(enqueued.entry.status, "validated");

  const [processed] = await processQueue(fixture);
  assert.equal(processed.entry.status, "committed");
  assert.deepEqual(
    processed.attempt.checkCommands,
    [],
    "every commit already contained in the entry base must stay outside the replay window"
  );
});

test("ancestry recompute cannot overwrite a concurrently recorded conflict", async () => {
  const fixture = createFixture("recompute-conflict-race");
  const firstCandidate = createCandidateWorkspace(fixture, "race-first", {
    "shared.txt": "first\n"
  });
  const secondCandidate = createCandidateWorkspace(fixture, "race-second", {
    "shared.txt": "second\n"
  });
  const first = await captureCandidate(fixture, firstCandidate);
  const second = await captureCandidate(fixture, secondCandidate);
  await enqueue(fixture, first, ["true"]);
  await enqueue(fixture, second, ["true"]);

  let notifyPaused;
  const paused = new Promise((resolve) => { notifyPaused = resolve; });
  let releaseRecompute;
  const released = new Promise((resolve) => { releaseRecompute = resolve; });
  class PausingAncestryGit extends NodeGitWorkspace {
    paused = false;

    async isAncestor(repositoryPath, ancestor, descendant) {
      const result = await super.isAncestor(repositoryPath, ancestor, descendant);
      if (!this.paused) {
        this.paused = true;
        notifyPaused();
        await released;
      }
      return result;
    }
  }

  // Processor A commits the first entry, then pauses after reading the second
  // as queued but before persisting its overlap recompute.
  const firstProcessor = processQueue(fixture, {
    git: new PausingAncestryGit(),
    limit: 1
  });
  await paused;

  let concurrent;
  try {
    // Processor B observes the committed first entry, claims the second, and
    // records its real Git conflict while A still holds a stale queued value.
    concurrent = await processIntegrationQueue(
      new FileTaskStore(fixture.home),
      fixture.home,
      fixture.task.id,
      { limit: 1, now: () => now }
    );
    assert.equal(concurrent[0].entry.status, "conflicted");
  } finally {
    releaseRecompute();
  }
  await firstProcessor;

  const finalEntry = fixture.store.getIntegrationQueueEntry(
    fixture.task.id,
    "integration-queue-2"
  );
  assert.equal(
    finalEntry.status,
    "conflicted",
    "a stale affected-path write must not silently requeue a conflicted entry"
  );
  assert.equal(finalEntry.integrationAttemptId, concurrent[0].attempt.id);
  assert.equal(
    fixture.store.getIntegrationAttempt(fixture.task.id, concurrent[0].attempt.id).status,
    "blocked"
  );
});

test("a target advance recomputes overlap only within its target lane", async () => {
  const fixture = createFixture("target-lane-overlap");
  git(["-C", fixture.repositoryPath, "branch", "release", fixture.baseCommit]);
  const masterChange = createStoredChangeSet(fixture, "change-set-1", {
    "shared.txt": "master\n"
  });
  const releaseChange = createEvidencedChangeSet(fixture, "change-set-2", {
    "shared.txt": "release\n"
  }, { checkName: "false" });

  await enqueue(fixture, masterChange, ["true"]);
  const releaseQueued = await enqueueIntegrationQueueEntry({
    store: fixture.store,
    taskId: fixture.task.id,
    projectId: fixture.project.id,
    changeSetId: releaseChange.id,
    targetRef: "release",
    checkCommands: ["false"],
    now: () => now
  });
  assert.equal(releaseQueued.entry.status, "validated");

  const processed = await processQueue(fixture);
  assert.equal(processed.length, 2);
  assert.deepEqual(
    processed.map(({ entry }) => entry.status),
    ["committed", "committed"]
  );
  assert.deepEqual(
    processed[1].attempt.checkCommands,
    [],
    "advancing master must not revoke evidence for an independent release lane"
  );
});
