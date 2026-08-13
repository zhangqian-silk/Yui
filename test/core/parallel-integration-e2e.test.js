import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runTaskOverlapCommand } from "../../dist/commands/taskOverlapCommands.js";
import { createChangeSetManifest } from "../../dist/integration/changeSetManifest.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import {
  enqueueIntegrationQueueEntry,
  processIntegrationQueue
} from "../../dist/integration/integrationQueueService.js";
import { deriveManifestTags } from "../../dist/integration/manifestTags.js";
import { createProductionStorageRegistry } from "../../dist/storage/migration/productionRegistry.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { createProject } from "../../dist/repository/project.js";
import { createReviewRound, finishReviewRound } from "../../dist/review/reviewRound.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createWorkItem, submitWorkItemCandidate, updateWorkItemStatus } from "../../dist/workItem/workItem.js";
import { WorkItemChangeSetManager } from "../../dist/workspace/workItemChangeSetManager.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";

/**
 * Cross-Task parallel integration E2E.
 *
 * One fake repository, eight Tasks branched from the same base, developing
 * fully in parallel.  The matrix covers four scenario pairs:
 *
 *   - same runtime module (tasks 1/2, identical change)
 *   - unrelated files (tasks 3/4, disjoint paths)
 *   - same schema file (tasks 5/6, divergent content)
 *   - same snapshot (tasks 7/8, identical change)
 *
 * and asserts the whole story: overlap diagnostics flag the contract,
 * schema, and snapshot overlap before anything integrates; the per-Task
 * queues serialize into one clean exact-target chain across Tasks; the
 * schema collision is localized to its item and recovered by a rebase;
 * identical parallel changes converge without a second commit; and the
 * dev branches, records, and lifecycles of the eight Tasks stay
 * independent.  Supplementary cases cover ancestor convergence, evidence
 * reuse, and a migrated v2 ChangeSet.
 */

const now = new Date("2026-08-13T00:00:00.000Z");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

// --- Fixtures ---------------------------------------------------------------

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "yui-parallel-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
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
  return { root, repositoryPath, home, store, project, baseCommit };
}

function createParallelTask(fixture, options) {
  const task = activateTask(createTask(
    fixture.store.nextTaskId(),
    `Parallel task ${options.index}`,
    now,
    {
      projectBindings: [{
        projectId: fixture.project.id,
        directory: fixture.project.name,
        baseRef: "master"
      }]
    }
  ), now);
  fixture.store.saveTask(task);
  const grown = addParallelChange(fixture, task, options);
  return { task, ...grown };
}

function addParallelChange(fixture, task, options) {
  const branch = `parallel/${task.id}/${options.id}`;
  const worktree = join(fixture.root, `pc-${options.id}`);
  git(["-C", fixture.repositoryPath, "worktree", "add", "-b", branch, worktree, fixture.baseCommit]);
  try {
    for (const [path, content] of Object.entries(options.paths)) {
      const fullPath = join(worktree, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content);
    }
    git(["-C", worktree, "add", "-A"]);
    git([
      "-C", worktree,
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "commit", "-m", `change ${options.id}`
    ]);
  } finally {
    git(["-C", fixture.repositoryPath, "worktree", "remove", worktree]);
  }
  const headCommit = git(["-C", fixture.repositoryPath, "rev-parse", branch]).trim();
  const workItem = createWorkItem(
    fixture.store.nextWorkItemId(task.id),
    task.id,
    {
      title: `Parallel change ${options.id}`,
      acceptance: [],
      dependsOn: [],
      assignee: "leader",
      writeProjectIds: [fixture.project.id]
    },
    now
  );
  fixture.store.saveWorkItem(task.id, workItem);
  const changedPaths = Object.keys(options.paths);
  const tags = options.tags ?? deriveManifestTags({ changedPaths });
  const manifest = createChangeSetManifest({
    tags,
    deletedPaths: []
  });
  const changeSet = createWorkItemChangeSet({
    id: options.id,
    taskId: task.id,
    workItemId: workItem.id,
    projectId: fixture.project.id,
    baseCommit: fixture.baseCommit,
    headCommit,
    branch,
    changedPaths,
    manifest
  }, now);
  fixture.store.saveChangeSet(task.id, changeSet);
  return { workItem, changeSet, branch, headCommit };
}

async function enqueueChange(fixture, task, changeSet, enqueueOptions = {}) {
  return enqueueIntegrationQueueEntry({
    store: fixture.store,
    taskId: task.id,
    projectId: fixture.project.id,
    changeSetId: changeSet.id,
    targetRef: "master",
    now: () => now,
    ...enqueueOptions
  });
}

async function processTask(fixture, task, options = {}) {
  return processIntegrationQueue(
    fixture.store,
    fixture.home,
    task.id,
    { now: () => now, ...options }
  );
}

function masterHead(fixture) {
  return git(["-C", fixture.repositoryPath, "rev-parse", "master"]).trim();
}

function masterFile(fixture, path) {
  return readFileSync(join(fixture.repositoryPath, path), "utf8");
}

function masterCommitCount(fixture) {
  return Number(git(["-C", fixture.repositoryPath, "rev-list", "--count", "master"]).trim());
}

// --- Capturable WorkItem fixtures (production capture path) -----------------

/**
 * A WorkItem in a capturable state with a persistent develop worktree on a
 * managed branch, registered as its managed workspace.  The production
 * capture manager reads the ChangeSet straight from this workspace, so the
 * test exercises the real capture path instead of hand-writing a record.
 */
function createCapturableWorkItem(fixture, task, options) {
  // Production lifecycle: pending -> running -> submit candidate -> awaiting
  // acceptance, which is the state capture expects.
  const running = updateWorkItemStatus(
    createWorkItem(
      fixture.store.nextWorkItemId(task.id),
      task.id,
      {
        title: `Capturable change ${options.label}`,
        acceptance: [],
        dependsOn: [],
        writeProjectIds: [fixture.project.id]
      },
      now
    ),
    "running",
    now
  );
  const workItem = submitWorkItemCandidate(
    running,
    { summary: `Change ${options.label}`, source: { type: "direct" } },
    now
  );
  fixture.store.saveWorkItem(task.id, workItem);

  const branch = `develop/${task.id}/${workItem.id}`;
  const worktree = join(fixture.root, `dw-${workItem.id}`);
  git(["-C", fixture.repositoryPath, "worktree", "add", "-b", branch, worktree, fixture.baseCommit]);
  for (const [path, content] of Object.entries(options.paths)) {
    const fullPath = join(worktree, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  git(["-C", worktree, "add", "-A"]);
  git([
    "-C", worktree,
    "-c", "user.name=Test",
    "-c", "user.email=test@example.com",
    "commit", "-m", `change ${options.label}`
  ]);
  const headCommit = git(["-C", worktree, "rev-parse", "HEAD"]).trim();

  const workspace = createManagedWorkspace({
    owner: { type: "work-item", taskId: task.id, workItemId: workItem.id },
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
  }, now);
  fixture.store.saveManagedWorkspace(workspace);
  return { workItem, workspace, headCommit, worktree, branch };
}

/**
 * A completed ReviewRound for a WorkItem's exact candidate.  The reviewer's
 * diagnostic `evidenceCommit` is a real commit that intentionally differs
 * from `reviewBaseCommit`, so a test can prove the capture links evidence to
 * the reviewed base rather than the diagnostic commit.
 */
function createCompletedReviewRound(fixture, task, workItem, reviewBaseCommit) {
  const reviewBranch = `review/${task.id}/${workItem.id}`;
  const reviewWorktree = join(fixture.root, `rw-${workItem.id}`);
  git(["-C", fixture.repositoryPath, "worktree", "add", "-b", reviewBranch, reviewWorktree, reviewBaseCommit]);
  let evidenceCommit;
  try {
    writeFileSync(join(reviewWorktree, "review-diagnostic.txt"), "diagnostic\n");
    git(["-C", reviewWorktree, "add", "-A"]);
    git([
      "-C", reviewWorktree,
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "commit", "-m", "review diagnostic"
    ]);
    evidenceCommit = git(["-C", reviewWorktree, "rev-parse", "HEAD"]).trim();
  } finally {
    git(["-C", fixture.repositoryPath, "worktree", "remove", reviewWorktree]);
  }
  const pending = createReviewRound(
    fixture.store.nextReviewRoundId(task.id),
    task.id,
    workItem.id,
    "candidate-1",
    "reviewer",
    "leader",
    reviewBaseCommit,
    now
  );
  const completed = finishReviewRound(pending, "completed", "Candidate reviewed.", now, {
    checks: [{ name: "review", outcome: "passed", details: "candidate verified" }],
    evidenceCommit
  });
  fixture.store.saveReviewRound(task.id, completed);
  return completed;
}

// --- The eight-Task matrix --------------------------------------------------

test("eight same-base Tasks: diagnostics, exact-target queue, localized conflict, independence", async () => {
  const fixture = await createFixture();

  // Four scenario pairs, all branched from the same base in parallel.
  const t1 = createParallelTask(fixture, { index: 1, id: "change-set-101", paths: { "src/runtime/index.ts": "runtime v1\n" } });
  const t2 = createParallelTask(fixture, { index: 2, id: "change-set-102", paths: { "src/runtime/index.ts": "runtime v1\n" } });
  const t3 = createParallelTask(fixture, { index: 3, id: "change-set-103", paths: { "src/feature-a.ts": "a\n" } });
  const t4 = createParallelTask(fixture, { index: 4, id: "change-set-104", paths: { "src/feature-b.ts": "b\n" } });
  const t5 = createParallelTask(fixture, { index: 5, id: "change-set-105", paths: { "src/storage/storageSchema.ts": "schema v1\n" } });
  const t6 = createParallelTask(fixture, { index: 6, id: "change-set-106", paths: { "src/storage/storageSchema.ts": "schema v2\n" } });
  const t7 = createParallelTask(fixture, { index: 7, id: "change-set-107", paths: { "test/__snapshots__/cli.test.js.snap": "snap v1\n" } });
  const t8 = createParallelTask(fixture, { index: 8, id: "change-set-108", paths: { "test/__snapshots__/cli.test.js.snap": "snap v1\n" } });

  // Overlap diagnostics run BEFORE any integration.
  const overlap = await runTaskOverlapCommand([], fixture.store);
  const findings = overlap.data.report.findings;
  // Findings and order key ChangeSets by qualified taskId/changeSetId so
  // same-local-id ChangeSets from different Tasks stay distinct.
  const ref = (grown) => `${grown.task.id}/${grown.changeSet.id}`;
  const contract = findings.find((item) => item.kind === "contract");
  assert.ok(contract, "the runtime-module pair must surface a contract finding");
  assert.equal(contract.risk, "high");
  assert.deepEqual(contract.changeSetIds, [ref(t1), ref(t2)]);
  const schema = findings.find((item) => item.kind === "schema-migration");
  assert.ok(schema, "the schema pair must surface a schema-migration finding");
  assert.equal(schema.risk, "medium");
  assert.deepEqual(schema.changeSetIds, [ref(t5), ref(t6)]);
  const cliSurface = findings.find((item) => item.kind === "cli-surface");
  assert.ok(cliSurface, "the snapshot pair must surface a cli-surface finding");
  assert.equal(cliSurface.risk, "medium");
  assert.deepEqual(cliSurface.changeSetIds, [ref(t7), ref(t8)]);
  // The unrelated-files pair produces no findings.
  assert.ok(!findings.some((item) =>
    item.changeSetIds.includes(ref(t3)) || item.changeSetIds.includes(ref(t4))));
  // Suggested order: schema-bearing ChangeSets first, then ascending
  // high-risk finding count (the contract pair carries the only high-risk
  // finding and lands last), then qualified ChangeSet reference.
  assert.deepEqual(overlap.data.report.suggestedOrder, [
    ref(t5), ref(t6),
    ref(t3), ref(t4),
    ref(t7), ref(t8),
    ref(t1), ref(t2)
  ]);
  assert.ok(overlap.data.report.reviewAreas.some((area) => area.startsWith("public contract")));
  assert.ok(overlap.data.report.reviewAreas.some((area) => area.startsWith("schema/migration")));

  // Serialize the eight per-Task queues in id order.  Each committed entry
  // records the exact target before/after; the chain spans Tasks.
  const chain = [];
  let enqueued = await enqueueChange(fixture, t1.task, t1.changeSet, { checkCommands: ["true"] });
  assert.equal(enqueued.outcome, "queued");
  let processed = await processTask(fixture, t1.task);
  assert.equal(processed[0].entry.status, "committed");
  assert.equal(processed[0].entry.targetBefore, fixture.baseCommit);
  chain.push(processed[0].entry);

  // Task 2 developed the identical change in parallel: it converges against
  // the tree task 1 just landed, with no new commit and no conflict.
  enqueued = await enqueueChange(fixture, t2.task, t2.changeSet);
  assert.equal(enqueued.outcome, "converged");
  assert.equal(enqueued.entry.status, "committed");
  assert.ok(enqueued.entry.evidenceRefs[0].startsWith("tree-convergence:"));
  assert.equal(enqueued.entry.targetBefore, enqueued.entry.targetAfter);
  chain.push(enqueued.entry);

  enqueued = await enqueueChange(fixture, t3.task, t3.changeSet, { checkCommands: ["true"] });
  assert.equal(enqueued.outcome, "queued");
  processed = await processTask(fixture, t3.task);
  assert.equal(processed[0].entry.status, "committed");
  chain.push(processed[0].entry);

  enqueued = await enqueueChange(fixture, t4.task, t4.changeSet, { checkCommands: ["true"] });
  assert.equal(enqueued.outcome, "queued");
  processed = await processTask(fixture, t4.task);
  assert.equal(processed[0].entry.status, "committed");
  chain.push(processed[0].entry);

  enqueued = await enqueueChange(fixture, t5.task, t5.changeSet, { checkCommands: ["true"] });
  assert.equal(enqueued.outcome, "queued");
  processed = await processTask(fixture, t5.task);
  assert.equal(processed[0].entry.status, "committed");
  chain.push(processed[0].entry);

  // Task 6 diverged on the schema file: the collision is localized to its
  // item, the target does not move, and no content is silently overwritten.
  const headBeforeTask6 = masterHead(fixture);
  enqueued = await enqueueChange(fixture, t6.task, t6.changeSet, { checkCommands: ["true"] });
  assert.equal(enqueued.outcome, "queued");
  processed = await processTask(fixture, t6.task);
  assert.equal(processed[0].entry.status, "conflicted");
  assert.match(processed[0].entry.conflictSummary, /conflicts with master/);
  assert.equal(processed[0].entry.targetBefore, headBeforeTask6);
  assert.equal(processed[0].entry.targetAfter, undefined);
  assert.equal(masterHead(fixture), headBeforeTask6);
  assert.equal(masterFile(fixture, "src/storage/storageSchema.ts"), "schema v1\n");
  const task6Conflict = processed[0].entry;

  // The conflict does not block the remaining Tasks' queues.
  enqueued = await enqueueChange(fixture, t7.task, t7.changeSet, { checkCommands: ["true"] });
  assert.equal(enqueued.outcome, "queued");
  processed = await processTask(fixture, t7.task);
  assert.equal(processed[0].entry.status, "committed");
  chain.push(processed[0].entry);

  enqueued = await enqueueChange(fixture, t8.task, t8.changeSet);
  assert.equal(enqueued.outcome, "converged");
  assert.equal(enqueued.entry.status, "committed");
  assert.ok(enqueued.entry.evidenceRefs[0].startsWith("tree-convergence:"));
  chain.push(enqueued.entry);

  // Every committed entry saw the exact current target: an unbroken chain
  // from the common base to the final master head.
  let expected = fixture.baseCommit;
  for (const entry of chain) {
    assert.equal(entry.targetBefore, expected);
    expected = entry.targetAfter;
  }
  assert.equal(expected, masterHead(fixture));

  // Dedup: re-enqueue lands on the existing entries instead of duplicating.
  assert.equal((await enqueueChange(fixture, t1.task, t1.changeSet)).outcome, "already-committed");
  assert.equal((await enqueueChange(fixture, t2.task, t2.changeSet)).outcome, "already-committed");
  // The two converged pairs produced no extra commits: base + five landings.
  assert.equal(masterCommitCount(fixture), 6);
  // No silent overwrite anywhere.
  assert.equal(masterFile(fixture, "src/runtime/index.ts"), "runtime v1\n");
  assert.equal(masterFile(fixture, "src/feature-a.ts"), "a\n");
  assert.equal(masterFile(fixture, "src/feature-b.ts"), "b\n");
  assert.equal(masterFile(fixture, "test/__snapshots__/cli.test.js.snap"), "snap v1\n");

  // Recovery: rebase task 6's intent onto the current target and re-enter
  // the queue with a fresh ChangeSet.  The conflicted entry is preserved.
  const recoveryBase = masterHead(fixture);
  const recoveryBranch = "parallel/task-6-rebased";
  const recoveryWorktree = join(fixture.root, "pc-task-6-recovery");
  git(["-C", fixture.repositoryPath, "worktree", "add", "-b", recoveryBranch, recoveryWorktree, recoveryBase]);
  let recoveryHead;
  try {
    const recoveryFile = join(recoveryWorktree, "src/storage/storageSchema.ts");
    mkdirSync(dirname(recoveryFile), { recursive: true });
    writeFileSync(recoveryFile, "schema v2\n");
    git(["-C", recoveryWorktree, "add", "-A"]);
    git([
      "-C", recoveryWorktree,
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "commit", "-m", "task 6 rebased"
    ]);
    recoveryHead = git(["-C", fixture.repositoryPath, "rev-parse", recoveryBranch]).trim();
  } finally {
    git(["-C", fixture.repositoryPath, "worktree", "remove", recoveryWorktree]);
  }
  const recoveryChangeSet = createWorkItemChangeSet({
    id: "change-set-602",
    taskId: t6.task.id,
    workItemId: t6.workItem.id,
    projectId: fixture.project.id,
    baseCommit: recoveryBase,
    headCommit: recoveryHead,
    branch: recoveryBranch,
    changedPaths: ["src/storage/storageSchema.ts"],
    manifest: createChangeSetManifest({ tags: ["schema"], deletedPaths: [] })
  }, now);
  fixture.store.saveChangeSet(t6.task.id, recoveryChangeSet);
  enqueued = await enqueueChange(fixture, t6.task, recoveryChangeSet, { checkCommands: ["true"] });
  assert.equal(enqueued.outcome, "queued");
  processed = await processTask(fixture, t6.task);
  assert.equal(processed[0].entry.status, "committed");
  assert.equal(processed[0].entry.targetBefore, recoveryBase);
  chain.push(processed[0].entry);
  assert.equal(masterFile(fixture, "src/storage/storageSchema.ts"), "schema v2\n");
  // The exact-target chain stays unbroken through recovery.
  expected = fixture.baseCommit;
  for (const entry of chain) {
    assert.equal(entry.targetBefore, expected);
    expected = entry.targetAfter;
  }
  assert.equal(expected, masterHead(fixture));
  // The failed attempt's entry remains as durable evidence.
  assert.equal(
    fixture.store.getIntegrationQueueEntry(t6.task.id, task6Conflict.id).status,
    "conflicted"
  );

  // Independence: dev branches never moved, records stay Task-scoped, and
  // every Task lifecycle is untouched by the others' integrations.
  for (const grown of [t1, t2, t3, t4, t5, t6, t7, t8]) {
    assert.equal(
      git(["-C", fixture.repositoryPath, "rev-parse", grown.branch]).trim(),
      grown.headCommit
    );
    assert.equal(fixture.store.getTask(grown.task.id).status, "active");
    assert.ok(fixture.store.listChangeSets(grown.task.id)
      .every((item) => item.taskId === grown.task.id));
    assert.ok(fixture.store.listWorkItems(grown.task.id)
      .every((item) => item.taskId === grown.task.id));
  }
  // Task 6 alone carries the recovery ChangeSet.
  assert.equal(fixture.store.listChangeSets(t6.task.id).length, 2);
});

// --- Supplementary cross-Task cases ----------------------------------------

test("enqueue converges when the ChangeSet head is already a target ancestor", async () => {
  const fixture = await createFixture();
  const grown = createParallelTask(fixture, {
    index: 1,
    id: "change-set-201",
    paths: { "src/remote.ts": "remote\n" }
  });
  // The equivalent change lands on the target out of band (another Task or
  // a remote merge): the branch head becomes a master ancestor.
  git(["-C", fixture.repositoryPath, "merge", "--ff-only", grown.branch]);
  const result = await enqueueChange(fixture, grown.task, grown.changeSet);
  assert.equal(result.outcome, "converged");
  assert.equal(result.entry.status, "committed");
  assert.deepEqual(result.entry.evidenceRefs, [`ancestor-convergence:${grown.changeSet.headCommit}`]);
  assert.equal(result.entry.targetBefore, result.entry.targetAfter);
  assert.equal(masterCommitCount(fixture), 2);
});

test("reusable evidence validates a waiting WorkItem without re-running its gate", async () => {
  const fixture = await createFixture();
  // One Task, two WorkItems with disjoint paths, captured through the
  // production capture manager.  The second carries a completed ReviewRound
  // whose reviewBaseCommit is the exact captured candidate, so its evidence
  // is reusable; its gate is a failing command that must never run.
  const task = activateTask(createTask(
    fixture.store.nextTaskId(),
    "Evidence task",
    now,
    {
      projectBindings: [{
        projectId: fixture.project.id,
        directory: fixture.project.name,
        baseRef: "master"
      }]
    }
  ), now);
  fixture.store.saveTask(task);
  const first = createCapturableWorkItem(fixture, task, {
    label: "first",
    paths: { "src/feature-a.ts": "a\n" }
  });
  const second = createCapturableWorkItem(fixture, task, {
    label: "second",
    paths: { "src/feature-b.ts": "b\n" }
  });
  // A completed review of the second WorkItem's exact candidate.  The
  // diagnostic evidence commit differs from the reviewed base on purpose.
  const round = createCompletedReviewRound(fixture, task, second.workItem, second.headCommit);

  const manager = new WorkItemChangeSetManager(fixture.store, () => now);
  const firstSets = await manager.capture(task.id, first.workItem.id);
  const secondSets = await manager.capture(task.id, second.workItem.id);
  assert.equal(firstSets.length, 1);
  assert.equal(secondSets.length, 1);
  const firstChangeSet = firstSets[0];
  const secondChangeSet = secondSets[0];
  // Production capture persisted the evidence link from the real ReviewRound
  // (keyed on reviewBaseCommit, not the differing diagnostic evidenceCommit).
  assert.deepEqual(secondChangeSet.manifest.evidenceRefs, [`review-round:${round.id}`]);
  assert.deepEqual(firstChangeSet.manifest.evidenceRefs, []);

  await enqueueChange(fixture, task, firstChangeSet, { checkCommands: ["true"] });
  await enqueueChange(fixture, task, secondChangeSet, { checkCommands: ["false"] });
  const processed = await processTask(fixture, task);
  assert.equal(processed.length, 2);
  assert.equal(processed[0].entry.changeSetId, firstChangeSet.id);
  assert.equal(processed[0].entry.status, "committed");
  assert.equal(processed[1].entry.changeSetId, secondChangeSet.id);
  assert.equal(processed[1].entry.status, "committed");
  // The second WorkItem was validated by the first landing: its failing gate
  // never ran because the reusable evidence covered the exact candidate.
  assert.deepEqual(processed[1].attempt.checkCommands, []);
  assert.deepEqual(processed[1].attempt.checks, []);
  assert.equal(masterFile(fixture, "src/feature-a.ts"), "a\n");
  assert.equal(masterFile(fixture, "src/feature-b.ts"), "b\n");
});

test("a migrated v2 ChangeSet degrades to path-only diagnostics and still integrates", async () => {
  const fixture = await createFixture();
  const task = activateTask(createTask(
    fixture.store.nextTaskId(),
    "Legacy task",
    now,
    {
      projectBindings: [{
        projectId: fixture.project.id,
        directory: fixture.project.name,
        baseRef: "master"
      }]
    }
  ), now);
  fixture.store.saveTask(task);

  // A legacy v2 record as an old Yui release would have written it: real
  // commits on a dev branch, no manifest.
  const branch = "parallel/legacy";
  const worktree = join(fixture.root, "pc-legacy");
  git(["-C", fixture.repositoryPath, "worktree", "add", "-b", branch, worktree, fixture.baseCommit]);
  let headCommit;
  try {
    const legacyFile = join(worktree, "src/legacy.ts");
    mkdirSync(dirname(legacyFile), { recursive: true });
    writeFileSync(legacyFile, "legacy\n");
    git(["-C", worktree, "add", "-A"]);
    git([
      "-C", worktree,
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "commit", "-m", "legacy change"
    ]);
    headCommit = git(["-C", fixture.repositoryPath, "rev-parse", branch]).trim();
  } finally {
    git(["-C", fixture.repositoryPath, "worktree", "remove", worktree]);
  }
  const workItem = createWorkItem(
    fixture.store.nextWorkItemId(task.id),
    task.id,
    {
      title: "Legacy change",
      acceptance: [],
      dependsOn: [],
      assignee: "leader",
      writeProjectIds: [fixture.project.id]
    },
    now
  );
  fixture.store.saveWorkItem(task.id, workItem);
  const legacy = {
    schemaVersion: 2,
    id: "change-set-401",
    taskId: task.id,
    workItemId: workItem.id,
    projectId: fixture.project.id,
    baseCommit: fixture.baseCommit,
    headCommit,
    branch,
    changedPaths: ["src/legacy.ts"],
    createdAt: now.toISOString()
  };

  // The production 2->3 record migration rewrites the version and preserves
  // the record; the migrated shape satisfies current validation.
  const registry = createProductionStorageRegistry();
  const step = registry.lookup("record", "changeSet", 2);
  assert.ok(step, "changeSet 2->3 step must be registered");
  const migrated = step.transform({
    schemaManifest: {
      schemaVersion: 1,
      storageVersion: 6,
      aggregateSchemaVersion: 18,
      recordVersions: { changeSet: 2 },
      updatedAt: now.toISOString()
    },
    state: {
      tasks: {
        [task.id]: { changeSets: { "change-set-401": legacy } }
      }
    }
  });
  const record = migrated.state.tasks[task.id].changeSets["change-set-401"];
  assert.equal(record.schemaVersion, 3);
  assert.equal(record.manifest, undefined);
  const accepted = createWorkItemChangeSet({
    id: record.id,
    taskId: record.taskId,
    workItemId: record.workItemId,
    projectId: record.projectId,
    baseCommit: record.baseCommit,
    headCommit: record.headCommit,
    branch: record.branch,
    changedPaths: record.changedPaths
  }, now);
  fixture.store.saveChangeSet(task.id, accepted);

  // A modern ChangeSet on the same path with a contract tag still only
  // yields a path-only finding against the manifest-less legacy record.
  const modern = createParallelTask(fixture, {
    index: 2,
    id: "change-set-402",
    paths: { "src/legacy.ts": "modern\n" },
    tags: ["contract"]
  });
  const overlap = await runTaskOverlapCommand([], fixture.store);
  const pair = overlap.data.report.findings.find((item) =>
    item.changeSetIds.includes(`${task.id}/change-set-401`)
    && item.changeSetIds.includes(`${modern.task.id}/change-set-402`));
  assert.ok(pair, "the legacy/modern pair must share the path");
  assert.equal(pair.kind, "path-only");
  assert.equal(pair.risk, "low");

  // The migrated change integrates through the queue like any other.
  const result = await enqueueChange(fixture, task, accepted, { checkCommands: ["true"] });
  assert.equal(result.outcome, "queued");
  const processed = await processTask(fixture, task);
  assert.equal(processed[0].entry.status, "committed");
  assert.equal(masterFile(fixture, "src/legacy.ts"), "legacy\n");
});
