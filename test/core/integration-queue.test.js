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

import { runTaskIntegrationQueueCommand } from "../../dist/commands/taskIntegrationQueueCommands.js";
import { createChangeSetManifest } from "../../dist/integration/changeSetManifest.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import { updateIntegrationAttempt } from "../../dist/integration/integrationAttempt.js";
import {
  createConvergedIntegrationQueueEntry,
  createIntegrationQueueEntry,
  markIntegrationQueueBlocked,
  markIntegrationQueueCommitted,
  markIntegrationQueueRequeued,
  markIntegrationQueueRunning,
  markIntegrationQueueSuperseded,
  markIntegrationQueueValidated,
  recordIntegrationQueueAffectedPaths,
  validateIntegrationQueueEntry
} from "../../dist/integration/integrationQueueEntry.js";
import {
  enqueueIntegrationQueueEntry,
  processIntegrationQueue,
  reconcileIntegrationQueueEntry,
  requeueIntegrationQueueEntry,
  supersedeIntegrationQueueEntry
} from "../../dist/integration/integrationQueueService.js";
import { createProductionStorageRegistry } from "../../dist/storage/migration/productionRegistry.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { createProject } from "../../dist/repository/project.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";

const now = new Date("2026-08-13T00:00:00.000Z");
const TARGET_BEFORE = "a".repeat(40);
const TARGET_AFTER = "b".repeat(40);
const EVIDENCE = createChangeSetManifest({
  tags: [],
  deletedPaths: [],
  evidenceRefs: ["review-round:review-round-1"]
});

function queuedEntry(overrides = {}) {
  return createIntegrationQueueEntry({
    id: "integration-queue-1",
    taskId: "task-1",
    projectId: "project-1",
    changeSetId: "change-set-1",
    targetRef: "master",
    ...overrides
  }, now);
}

function runningEntry() {
  return markIntegrationQueueRunning(queuedEntry(), TARGET_BEFORE, now);
}

function conflictedEntry() {
  return markIntegrationQueueBlocked(runningEntry(), "conflict", now);
}

// --- State machine ---------------------------------------------------------

test("a new entry starts queued with normalized lists", () => {
  const entry = queuedEntry({
    checkCommands: ["true", "echo ok"],
    evidenceRefs: ["review-round:review-round-1"]
  });
  assert.equal(entry.status, "queued");
  assert.deepEqual(entry.checkCommands, ["true", "echo ok"]);
  assert.deepEqual(entry.evidenceRefs, ["review-round:review-round-1"]);
  assert.equal(entry.targetBefore, undefined);
  assert.equal(entry.endedAt, undefined);
});

test("a converged entry commits immediately with its proof", () => {
  const entry = createConvergedIntegrationQueueEntry({
    id: "integration-queue-1",
    taskId: "task-1",
    projectId: "project-1",
    changeSetId: "change-set-1",
    targetRef: "master",
    targetHead: TARGET_BEFORE,
    proof: `ancestor-convergence:${TARGET_BEFORE}`
  }, now);
  assert.equal(entry.status, "committed");
  assert.equal(entry.targetBefore, TARGET_BEFORE);
  assert.equal(entry.targetAfter, TARGET_BEFORE);
  assert.equal(entry.endedAt, now.toISOString());
  assert.deepEqual(entry.evidenceRefs, [`ancestor-convergence:${TARGET_BEFORE}`]);
});

test("running records the exact target before and clears a prior conflict", () => {
  const running = markIntegrationQueueRunning(conflictedEntry(), TARGET_AFTER, now);
  assert.equal(running.status, "running");
  assert.equal(running.targetBefore, TARGET_AFTER);
  assert.equal(running.conflictSummary, undefined);
});

test("committed records the exact target after and closes the entry", () => {
  const committed = markIntegrationQueueCommitted(runningEntry(), TARGET_AFTER, now);
  assert.equal(committed.status, "committed");
  assert.equal(committed.targetBefore, TARGET_BEFORE);
  assert.equal(committed.targetAfter, TARGET_AFTER);
  assert.equal(committed.endedAt, now.toISOString());
});

test("validated requires reusable evidence and requeue invalidates it", () => {
  assert.throws(
    () => markIntegrationQueueValidated(queuedEntry(), now),
    /reusable evidence/
  );
  const validated = markIntegrationQueueValidated(
    queuedEntry({ evidenceRefs: ["review-round:review-round-1"] }),
    now
  );
  assert.equal(validated.status, "validated");
  const requeued = markIntegrationQueueRequeued(validated, now);
  assert.equal(requeued.status, "queued");
});

test("affected paths merge in sorted order while the entry waits", () => {
  const once = recordIntegrationQueueAffectedPaths(
    queuedEntry(),
    ["src/b.ts", "src/a.ts"],
    now
  );
  assert.deepEqual(once.affectedPaths, ["src/a.ts", "src/b.ts"]);
  const twice = recordIntegrationQueueAffectedPaths(once, ["src/a.ts", "src/c.ts"], now);
  assert.deepEqual(twice.affectedPaths, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  const validated = markIntegrationQueueValidated(
    queuedEntry({ evidenceRefs: ["review-round:review-round-1"] }),
    now
  );
  assert.deepEqual(
    recordIntegrationQueueAffectedPaths(validated, ["src/a.ts"], now).affectedPaths,
    ["src/a.ts"]
  );
});

test("supersede closes waiting items with a reason and an end time", () => {
  const cases = [
    queuedEntry(),
    conflictedEntry(),
    markIntegrationQueueValidated(
      queuedEntry({ evidenceRefs: ["review-round:review-round-1"] }),
      now
    )
  ];
  for (const entry of cases) {
    const superseded = markIntegrationQueueSuperseded(entry, "replaced by change-set-2", now);
    assert.equal(superseded.status, "superseded");
    assert.equal(superseded.supersedeReason, "replaced by change-set-2");
    assert.equal(superseded.endedAt, now.toISOString());
  }
});

test("invalid transitions fail closed", () => {
  const committed = markIntegrationQueueCommitted(runningEntry(), TARGET_AFTER, now);
  assert.throws(
    () => markIntegrationQueueRunning(committed, TARGET_BEFORE, now),
    /cannot run/
  );
  assert.throws(
    () => markIntegrationQueueCommitted(queuedEntry(), TARGET_AFTER, now),
    /cannot commit/
  );
  assert.throws(
    () => markIntegrationQueueBlocked(queuedEntry(), "conflict", now),
    /not running/
  );
  assert.throws(
    () => markIntegrationQueueSuperseded(runningEntry(), "reason", now),
    /cannot be superseded/
  );
  assert.throws(
    () => markIntegrationQueueRequeued(queuedEntry(), now),
    /cannot requeue/
  );
  assert.throws(
    () => recordIntegrationQueueAffectedPaths(committed, ["a.ts"], now),
    /cannot recompute/
  );
});

test("terminal entries require an end time and running entries an exact target before", () => {
  const committed = markIntegrationQueueCommitted(runningEntry(), TARGET_AFTER, now);
  const { endedAt: _endedAt, ...open } = committed;
  assert.throws(() => validateIntegrationQueueEntry(open), /endedAt/);
  assert.throws(
    () => validateIntegrationQueueEntry({ ...runningEntry(), targetBefore: "not-a-commit" }),
    /targetBefore/
  );
});

// --- 0->1 introduction migration ------------------------------------------

test("integrationQueue 0->1 introduction adds empty maps and the record version", () => {
  const registry = createProductionStorageRegistry();
  const step = registry.lookup("record", "integrationQueue", 0);
  assert.ok(step, "integrationQueue 0->1 step must be registered");
  assert.equal(step.introduction, true);
  const snapshot = {
    schemaManifest: {
      schemaVersion: 1,
      storageVersion: 6,
      aggregateSchemaVersion: 18,
      recordVersions: {},
      updatedAt: now.toISOString()
    },
    state: { tasks: { "task-1": { changeSets: {} } } }
  };
  step.preconditions?.(snapshot);
  const migrated = step.transform(snapshot);
  assert.equal(migrated.schemaManifest.recordVersions.integrationQueue, 1);
  assert.deepEqual(migrated.state.tasks["task-1"].integrationQueue, {});
  const empty = step.transform({ ...snapshot, state: null });
  assert.equal(empty.state, null);
  assert.equal(empty.schemaManifest.recordVersions.integrationQueue, 1);
  assert.throws(
    () => step.preconditions?.({
      ...snapshot,
      schemaManifest: { ...snapshot.schemaManifest, recordVersions: { integrationQueue: 1 } }
    }),
    /already introduced/
  );
});

// --- Service fixtures -------------------------------------------------------

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "yui-queue-"));
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
  const task = activateTask(createTask(store.nextTaskId(), "Queue task", now, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: "master" }]
  }), now);
  store.saveTask(task);
  return { root, repositoryPath, home, store, project, task, baseCommit };
}

async function branchChangeSet(fixture, options) {
  const { repositoryPath, store, task, project } = fixture;
  const id = options.id;
  const base = options.base ?? fixture.baseCommit;
  const branch = `queue/${id}`;
  const worktree = join(fixture.root, `wt-${id}`);
  git(["-C", repositoryPath, "worktree", "add", "-b", branch, worktree, base]);
  try {
    for (const [path, content] of Object.entries(options.paths)) {
      writeFileSync(join(worktree, path), content);
    }
    git(["-C", worktree, "add", "-A"]);
    git([
      "-C", worktree,
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "commit", "-m", `change ${id}`
    ]);
  } finally {
    git(["-C", repositoryPath, "worktree", "remove", worktree]);
  }
  const headCommit = git(["-C", repositoryPath, "rev-parse", branch]).trim();
  const workItem = createWorkItem(store.nextWorkItemId(task.id), task.id, {
    title: `Change ${id}`,
    acceptance: [],
    dependsOn: [],
    assignee: "leader",
    writeProjectIds: [project.id]
  }, now);
  store.saveWorkItem(task.id, workItem);
  const changeSet = createWorkItemChangeSet({
    id,
    taskId: task.id,
    workItemId: workItem.id,
    projectId: project.id,
    baseCommit: base,
    headCommit,
    branch,
    changedPaths: Object.keys(options.paths),
    ...(options.manifest === undefined ? {} : { manifest: options.manifest })
  }, now);
  store.saveChangeSet(task.id, changeSet);
  return changeSet;
}

async function enqueue(fixture, changeSet, options = {}) {
  return enqueueIntegrationQueueEntry({
    store: fixture.store,
    taskId: fixture.task.id,
    projectId: fixture.project.id,
    changeSetId: changeSet.id,
    targetRef: "master",
    now: () => now,
    ...options
  });
}

async function processQueue(fixture, options = {}) {
  return processIntegrationQueue(fixture.store, fixture.home, fixture.task.id, {
    now: () => now,
    ...options
  });
}

function masterHead(fixture) {
  return git(["-C", fixture.repositoryPath, "rev-parse", "master"]).trim();
}

// --- Enqueue semantics ------------------------------------------------------

test("enqueue is idempotent per Project and ChangeSet", async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  const first = await enqueue(fixture, changeSet);
  assert.equal(first.outcome, "queued");
  assert.equal(first.entry.id, "integration-queue-1");
  const second = await enqueue(fixture, changeSet);
  assert.equal(second.outcome, "already-queued");
  assert.equal(second.entry.id, first.entry.id);
});

test("enqueue converges when the ChangeSet head is already a target ancestor", async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  git(["-C", fixture.repositoryPath, "merge", "--ff-only", changeSet.branch]);
  const result = await enqueue(fixture, changeSet);
  assert.equal(result.outcome, "converged");
  assert.equal(result.entry.status, "committed");
  assert.deepEqual(result.entry.evidenceRefs, [`ancestor-convergence:${changeSet.headCommit}`]);
  assert.equal(result.entry.targetBefore, result.entry.targetAfter);
  const again = await enqueue(fixture, changeSet);
  assert.equal(again.outcome, "already-committed");
  assert.equal(again.entry.id, result.entry.id);
});

test("enqueue converges on a tree-equivalent target commit", async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  // Land the same tree through a different commit on master.
  writeFileSync(join(fixture.repositoryPath, "a.txt"), "a\n");
  git(["-C", fixture.repositoryPath, "add", "a.txt"]);
  git(["-C", fixture.repositoryPath, "commit", "-m", "equivalent change"]);
  const equivalent = masterHead(fixture);
  const result = await enqueue(fixture, changeSet);
  assert.equal(result.outcome, "converged");
  assert.equal(result.entry.status, "committed");
  assert.deepEqual(result.entry.evidenceRefs, [`tree-convergence:${equivalent}`]);
});

test("enqueue converges when the identical change already landed with other work", async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  // A parallel Task lands the same change together with unrelated work, so
  // no master commit shares the ChangeSet's whole tree.
  writeFileSync(join(fixture.repositoryPath, "a.txt"), "a\n");
  writeFileSync(join(fixture.repositoryPath, "other.txt"), "other\n");
  git(["-C", fixture.repositoryPath, "add", "a.txt", "other.txt"]);
  git(["-C", fixture.repositoryPath, "commit", "-m", "parallel landing"]);
  const landed = masterHead(fixture);
  const result = await enqueue(fixture, changeSet);
  assert.equal(result.outcome, "converged");
  assert.equal(result.entry.status, "committed");
  assert.deepEqual(result.entry.evidenceRefs, [`tree-convergence:${landed}`]);
  assert.equal(result.entry.targetBefore, result.entry.targetAfter);
  assert.equal(masterHead(fixture), landed);
});

// --- Process semantics ------------------------------------------------------

test("process commits the exact head and records the target before and after", async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  await enqueue(fixture, changeSet, { checkCommands: ["true"] });
  const processed = await processQueue(fixture);
  assert.equal(processed.length, 1);
  assert.equal(processed[0].result.status, "committed");
  assert.equal(processed[0].entry.status, "committed");
  assert.equal(processed[0].entry.targetBefore, fixture.baseCommit);
  assert.equal(processed[0].entry.targetAfter, masterHead(fixture));
  assert.equal(readFileSync(join(fixture.repositoryPath, "a.txt"), "utf8"), "a\n");
  assert.deepEqual(processed[0].attempt.checks.map(({ outcome }) => outcome), ["passed"]);
});

test("a conflict blocks only its item while siblings keep integrating", async () => {
  const fixture = await createFixture();
  const first = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "shared.txt": "first\n" }
  });
  const second = await branchChangeSet(fixture, {
    id: "change-set-2",
    paths: { "shared.txt": "second\n" }
  });
  const third = await branchChangeSet(fixture, {
    id: "change-set-3",
    paths: { "other.txt": "third\n" }
  });
  await enqueue(fixture, first, { checkCommands: ["true"] });
  await enqueue(fixture, second, { checkCommands: ["true"] });
  await enqueue(fixture, third, { checkCommands: ["true"] });
  const processed = await processQueue(fixture);
  assert.equal(processed.length, 3);
  assert.equal(processed[0].entry.status, "committed");
  assert.equal(processed[1].entry.status, "conflicted");
  assert.match(processed[1].entry.conflictSummary, /conflicts with master/);
  assert.equal(processed[2].entry.status, "committed");
  // master carries the first and third changes, never the second
  assert.equal(readFileSync(join(fixture.repositoryPath, "shared.txt"), "utf8"), "first\n");
  assert.equal(readFileSync(join(fixture.repositoryPath, "other.txt"), "utf8"), "third\n");
  const requeued = requeueIntegrationQueueEntry(
    fixture.store,
    fixture.task.id,
    processed[1].entry.id,
    () => now
  );
  assert.equal(requeued.status, "queued");
});

test("a gate failure blocks only its item", async () => {
  const fixture = await createFixture();
  const first = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  const second = await branchChangeSet(fixture, {
    id: "change-set-2",
    paths: { "b.txt": "b\n" }
  });
  await enqueue(fixture, first, { checkCommands: ["false"] });
  await enqueue(fixture, second, { checkCommands: ["true"] });
  const processed = await processQueue(fixture);
  assert.equal(processed[0].entry.status, "conflicted");
  assert.match(processed[0].entry.conflictSummary, /gate failed/);
  assert.equal(processed[1].entry.status, "committed");
  assert.equal(readFileSync(join(fixture.repositoryPath, "b.txt"), "utf8"), "b\n");
  // the failed change never reached master
  assert.equal(existsSync(join(fixture.repositoryPath, "a.txt")), false);
});

test("reusable evidence validates an unaffected item without re-running its checks", async () => {
  const fixture = await createFixture();
  const first = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  const second = await branchChangeSet(fixture, {
    id: "change-set-2",
    paths: { "b.txt": "b\n" },
    manifest: EVIDENCE
  });
  // The third item builds on top of the second: it touches b.txt (so the
  // second landing affects it) but cherry-picks cleanly onto the new target.
  const third = await branchChangeSet(fixture, {
    id: "change-set-3",
    base: second.headCommit,
    paths: { "b.txt": "b-again\n" },
    manifest: EVIDENCE
  });
  await enqueue(fixture, first, { checkCommands: ["true"] });
  await enqueue(fixture, second, { checkCommands: ["false"] });
  await enqueue(fixture, third, { checkCommands: ["false"] });
  const processed = await processQueue(fixture);
  assert.equal(processed[0].entry.status, "committed");
  // The second item was validated by evidence and skipped its (failing) checks.
  assert.equal(processed[1].entry.status, "committed");
  assert.deepEqual(processed[1].attempt.checkCommands, []);
  assert.deepEqual(processed[1].attempt.checks, []);
  // The third item lost evidence coverage when the second landed b.txt, so
  // its checks ran and the failing gate blocked it.
  assert.equal(processed[2].entry.status, "conflicted");
  assert.match(processed[2].entry.conflictSummary, /gate failed/);
  const stored = fixture.store.getIntegrationQueueEntry(fixture.task.id, processed[2].entry.id);
  assert.deepEqual(stored.affectedPaths, ["b.txt"]);
});

test("supersede closes a waiting item and frees its ChangeSet for a fresh enqueue", async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  const queued = await enqueue(fixture, changeSet);
  const superseded = supersedeIntegrationQueueEntry(
    fixture.store,
    fixture.task.id,
    queued.entry.id,
    "replaced by a newer candidate",
    () => now
  );
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.supersedeReason, "replaced by a newer candidate");
  const again = await enqueue(fixture, changeSet);
  assert.equal(again.outcome, "queued");
  assert.notEqual(again.entry.id, superseded.id);
});

test("reconcile closes a conflicted item whose attempt later committed", async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "shared.txt": "first\n" }
  });
  const other = await branchChangeSet(fixture, {
    id: "change-set-2",
    paths: { "shared.txt": "second\n" }
  });
  await enqueue(fixture, changeSet, { checkCommands: ["true"] });
  await enqueue(fixture, other, { checkCommands: ["true"] });
  const processed = await processQueue(fixture);
  const conflicted = processed[1].entry;
  assert.equal(conflicted.status, "conflicted");
  // The blocked attempt is resolved and committed out of band, walking the
  // same blocked -> validating -> committed transitions as a manual resolve.
  const attempt = fixture.store.getIntegrationAttempt(fixture.task.id, conflicted.integrationAttemptId);
  const candidate = "c".repeat(40);
  fixture.store.saveIntegrationAttempt(
    fixture.task.id,
    updateIntegrationAttempt(attempt, { status: "validating", candidateCommit: candidate }, now)
  );
  fixture.store.saveIntegrationAttempt(
    fixture.task.id,
    updateIntegrationAttempt(
      fixture.store.getIntegrationAttempt(fixture.task.id, conflicted.integrationAttemptId),
      { status: "committed" },
      now
    )
  );
  const reconciled = reconcileIntegrationQueueEntry(
    fixture.store,
    fixture.task.id,
    conflicted.id,
    () => now
  );
  assert.equal(reconciled.status, "committed");
  assert.equal(reconciled.targetAfter, candidate);
});

test("queue entries round-trip through the store and reject an updatedAt move backwards", async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  const queued = await enqueue(fixture, changeSet);
  assert.deepEqual(fixture.store.getIntegrationQueueEntry(fixture.task.id, queued.entry.id), queued.entry);
  assert.deepEqual(fixture.store.listIntegrationQueueEntries(fixture.task.id), [queued.entry]);
  const later = new Date(now.getTime() + 1000);
  fixture.store.saveIntegrationQueueEntry(
    fixture.task.id,
    markIntegrationQueueRunning(queued.entry, fixture.baseCommit, later)
  );
  assert.throws(
    () => fixture.store.saveIntegrationQueueEntry(
      fixture.task.id,
      markIntegrationQueueRunning(queued.entry, fixture.baseCommit, now)
    ),
    /updatedAt cannot move backwards/
  );
});

// --- CLI --------------------------------------------------------------------

test("the queue CLI enqueues, lists, shows and processes as the Task Leader", async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  const leader = {
    now: () => now,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: fixture.task.id,
      YUI_ROLE: "leader"
    }
  };
  const empty = await runTaskIntegrationQueueCommand(
    ["list", fixture.task.id],
    fixture.store,
    fixture.home,
    {}
  );
  assert.match(empty.output, /Integration queue is empty/);
  const enqueued = await runTaskIntegrationQueueCommand(
    [
      "enqueue", fixture.task.id,
      "--project", fixture.project.id,
      "--change-set", changeSet.id,
      "--target", "master",
      "--check", "true"
    ],
    fixture.store,
    fixture.home,
    leader
  );
  assert.match(enqueued.output, /Enqueued change-set-1 as integration-queue-1 \(queued\)/);
  const shown = await runTaskIntegrationQueueCommand(
    ["show", `${fixture.task.id}/integration-queue-1`],
    fixture.store,
    fixture.home,
    {}
  );
  assert.match(shown.output, /Status: queued/);
  const processed = await runTaskIntegrationQueueCommand(
    ["process", fixture.task.id],
    fixture.store,
    fixture.home,
    leader
  );
  assert.match(processed.output, /integration-queue-1 committed change-set-1 ->/);
  const listed = await runTaskIntegrationQueueCommand(
    ["list", fixture.task.id],
    fixture.store,
    fixture.home,
    {}
  );
  assert.match(listed.output, /integration-queue-1/);
  assert.match(listed.output, /committed/);
});

test("the queue CLI refuses non-Leader actors", async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  await enqueue(fixture, changeSet);
  const worker = {
    now: () => now,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: fixture.task.id,
      YUI_ROLE: "worker-1"
    }
  };
  await assert.rejects(
    () => runTaskIntegrationQueueCommand(
      [
        "supersede", `${fixture.task.id}/integration-queue-1`,
        "--reason", "not allowed"
      ],
      fixture.store,
      fixture.home,
      worker
    ),
    /Leader/
  );
  await assert.rejects(
    () => runTaskIntegrationQueueCommand(
      ["process", fixture.task.id],
      fixture.store,
      fixture.home,
      worker
    ),
    /Leader/
  );
});
