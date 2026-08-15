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

import { runTaskIntegrationCommand } from "../../dist/commands/taskIntegrationCommands.js";
import { runTaskIntegrationQueueCommand } from "../../dist/commands/taskIntegrationQueueCommands.js";
import { createChangeSetManifest } from "../../dist/integration/changeSetManifest.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import {
  createIntegrationAttempt,
  recordResolutionDecision,
  requireLeaderDecision,
  updateIntegrationAttempt
} from "../../dist/integration/integrationAttempt.js";
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
  recordIntegrationQueueAttempt,
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
import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
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

test("duplicate enqueue cannot silently discard a later explicit gate", async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  await enqueue(fixture, changeSet, { checkCommands: ["true"] });

  let rejected = false;
  try {
    await enqueue(fixture, changeSet, { checkCommands: ["false"] });
  } catch {
    rejected = true;
  }
  const active = fixture.store.listIntegrationQueueEntries(fixture.task.id)
    .filter((entry) => entry.status !== "superseded");

  assert.ok(
    rejected || (active.length === 1 && active[0].checkCommands.includes("false")),
    "a conflicting idempotency retry must fail closed or preserve the requested gate"
  );
});

test("duplicate enqueue cannot silently discard a later explicit target", async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  git(["-C", fixture.repositoryPath, "branch", "release", fixture.baseCommit]);
  await enqueue(fixture, changeSet, { targetRef: "master" });

  let rejected = false;
  try {
    await enqueue(fixture, changeSet, { targetRef: "release" });
  } catch {
    rejected = true;
  }
  const active = fixture.store.listIntegrationQueueEntries(fixture.task.id)
    .filter((entry) => entry.status !== "superseded");

  assert.ok(
    rejected || active.some((entry) => entry.targetRef === "release"),
    "a conflicting idempotency retry must fail closed or preserve the explicit target"
  );
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

test("a target advance during path-containment inspection cannot publish stale convergence", {
  skip: process.env.YUI_REVIEW_CONVERGENCE_RACE !== "1"
}, async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "candidate\n" }
  });

  // The target initially contains the candidate path together with unrelated
  // work, so only the path-containment proof (not whole-tree equality) can
  // converge it. Advance that same target path after the proof has observed
  // the old head but before enqueue persists its result.
  writeFileSync(join(fixture.repositoryPath, "a.txt"), "candidate\n");
  writeFileSync(join(fixture.repositoryPath, "other.txt"), "other\n");
  git(["-C", fixture.repositoryPath, "add", "a.txt", "other.txt"]);
  git(["-C", fixture.repositoryPath, "commit", "-m", "parallel landing"]);

  class AdvancingContainmentGit extends NodeGitWorkspace {
    advanced = false;

    async treesAgreeOnPaths(input) {
      const agrees = await super.treesAgreeOnPaths(input);
      if (agrees && !this.advanced) {
        this.advanced = true;
        writeFileSync(join(fixture.repositoryPath, "a.txt"), "concurrent overwrite\n");
        git(["-C", fixture.repositoryPath, "add", "a.txt"]);
        git(["-C", fixture.repositoryPath, "commit", "-m", "concurrent target advance"]);
      }
      return agrees;
    }
  }

  const result = await enqueue(fixture, changeSet, {
    git: new AdvancingContainmentGit()
  });

  assert.equal(
    result.outcome,
    "queued",
    "a containment proof for an old target head cannot terminalize the entry after that ref moved"
  );
  assert.equal(result.entry.status, "queued");
  assert.equal(readFileSync(join(fixture.repositoryPath, "a.txt"), "utf8"), "concurrent overwrite\n");
});

test("a target advance after the convergence re-read cannot publish stale convergence", {
  skip: process.env.YUI_REVIEW_POST_INSPECT_RACE !== "1"
}, async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "candidate\n" }
  });

  writeFileSync(join(fixture.repositoryPath, "a.txt"), "candidate\n");
  writeFileSync(join(fixture.repositoryPath, "other.txt"), "other\n");
  git(["-C", fixture.repositoryPath, "add", "a.txt", "other.txt"]);
  git(["-C", fixture.repositoryPath, "commit", "-m", "parallel landing"]);

  class PostInspectAdvancingGit extends NodeGitWorkspace {
    targetInspections = 0;
    advancedHead;

    async inspect(repositoryPath, baseRef) {
      const observed = await super.inspect(repositoryPath, baseRef);
      if (baseRef === "refs/heads/master") {
        this.targetInspections += 1;
        if (this.targetInspections === 2) {
          writeFileSync(join(fixture.repositoryPath, "a.txt"), "concurrent overwrite\n");
          git(["-C", fixture.repositoryPath, "add", "a.txt"]);
          git(["-C", fixture.repositoryPath, "commit", "-m", "post-inspect target advance"]);
          this.advancedHead = masterHead(fixture);
        }
      }
      return observed;
    }
  }

  const racingGit = new PostInspectAdvancingGit();
  const result = await enqueue(fixture, changeSet, {
    git: racingGit
  });
  const attempts = fixture.store.listIntegrationAttempts(fixture.task.id);

  assert.deepEqual(
    {
      outcome: result.outcome,
      entryStatus: result.entry.status,
      currentTarget: masterHead(fixture),
      recordedTarget: result.entry.targetAfter,
      attemptStatus: attempts[0]?.status,
      attemptTarget: attempts[0]?.candidateCommit
    },
    {
      outcome: "queued",
      entryStatus: "queued",
      currentTarget: racingGit.advancedHead,
      recordedTarget: undefined,
      attemptStatus: undefined,
      attemptTarget: undefined
    },
    "the re-read result cannot terminalize convergence after the target moved before persistence"
  );
  assert.equal(readFileSync(join(fixture.repositoryPath, "a.txt"), "utf8"), "concurrent overwrite\n");
});

test("a target advance after the convergence verification read cannot publish stale convergence", {
  skip: process.env.YUI_REVIEW_FINAL_INSPECT_RACE !== "1"
}, async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "candidate\n" }
  });

  writeFileSync(join(fixture.repositoryPath, "a.txt"), "candidate\n");
  writeFileSync(join(fixture.repositoryPath, "other.txt"), "other\n");
  git(["-C", fixture.repositoryPath, "add", "a.txt", "other.txt"]);
  git(["-C", fixture.repositoryPath, "commit", "-m", "parallel landing"]);

  class FinalInspectAdvancingGit extends NodeGitWorkspace {
    targetInspections = 0;
    advancedHead;

    async inspect(repositoryPath, baseRef) {
      const observed = await super.inspect(repositoryPath, baseRef);
      if (baseRef === "refs/heads/master") {
        this.targetInspections += 1;
        if (this.targetInspections === 3) {
          writeFileSync(join(fixture.repositoryPath, "a.txt"), "concurrent overwrite\n");
          git(["-C", fixture.repositoryPath, "add", "a.txt"]);
          git(["-C", fixture.repositoryPath, "commit", "-m", "final-inspect target advance"]);
          this.advancedHead = masterHead(fixture);
        }
      }
      return observed;
    }
  }

  const racingGit = new FinalInspectAdvancingGit();
  const result = await enqueue(fixture, changeSet, {
    git: racingGit
  });
  const attempts = fixture.store.listIntegrationAttempts(fixture.task.id);

  assert.deepEqual(
    {
      outcome: result.outcome,
      entryStatus: result.entry.status,
      currentTarget: masterHead(fixture),
      recordedTarget: result.entry.targetAfter,
      attemptStatus: attempts[0]?.status,
      attemptTarget: attempts[0]?.candidateCommit
    },
    {
      outcome: "queued",
      entryStatus: "queued",
      currentTarget: racingGit.advancedHead,
      recordedTarget: undefined,
      attemptStatus: undefined,
      attemptTarget: undefined
    },
    "the final read cannot terminalize convergence after the target moved before persistence"
  );
  assert.equal(readFileSync(join(fixture.repositoryPath, "a.txt"), "utf8"), "concurrent overwrite\n");
});

test("a target advance after the final convergence read cannot publish stale convergence", {
  skip: process.env.YUI_REVIEW_POST_FINAL_INSPECT_RACE !== "1"
}, async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "candidate\n" }
  });

  writeFileSync(join(fixture.repositoryPath, "a.txt"), "candidate\n");
  writeFileSync(join(fixture.repositoryPath, "other.txt"), "other\n");
  git(["-C", fixture.repositoryPath, "add", "a.txt", "other.txt"]);
  git(["-C", fixture.repositoryPath, "commit", "-m", "parallel landing"]);

  class PostFinalInspectAdvancingGit extends NodeGitWorkspace {
    advancedHead;

    async assertRefAt(repositoryPath, ref, expectedCommit) {
      // Simulate a concurrent landing that advances the target after the
      // last inspect but before the CAS probe.  The CAS must detect this.
      if (ref === "refs/heads/master") {
        writeFileSync(join(fixture.repositoryPath, "a.txt"), "concurrent overwrite\n");
        git(["-C", fixture.repositoryPath, "add", "a.txt"]);
        git(["-C", fixture.repositoryPath, "commit", "-m", "post-final-inspect target advance"]);
        this.advancedHead = masterHead(fixture);
      }
      return super.assertRefAt(repositoryPath, ref, expectedCommit);
    }
  }

  const racingGit = new PostFinalInspectAdvancingGit();
  const result = await enqueue(fixture, changeSet, {
    git: racingGit
  });
  const attempts = fixture.store.listIntegrationAttempts(fixture.task.id);

  assert.deepEqual(
    {
      outcome: result.outcome,
      entryStatus: result.entry.status,
      currentTarget: masterHead(fixture),
      recordedTarget: result.entry.targetAfter,
      attemptStatus: attempts[0]?.status,
      attemptTarget: attempts[0]?.candidateCommit
    },
    {
      outcome: "queued",
      entryStatus: "queued",
      currentTarget: racingGit.advancedHead,
      recordedTarget: undefined,
      attemptStatus: undefined,
      attemptTarget: undefined
    },
    "the post-final-read window cannot terminalize convergence after the target moved before persistence"
  );
  assert.equal(readFileSync(join(fixture.repositoryPath, "a.txt"), "utf8"), "concurrent overwrite\n");
});

test("a pre-base same-tree commit cannot swallow an intentional revert", async () => {
  const fixture = await createFixture();
  // The initial commit has the tree the WorkItem deliberately restores. The
  // ChangeSet is based on the later target commit, so the old tree is history,
  // not evidence that this new revert was integrated.
  writeFileSync(join(fixture.repositoryPath, "base.txt"), "changed after the old tree\n");
  git(["-C", fixture.repositoryPath, "add", "base.txt"]);
  git(["-C", fixture.repositoryPath, "commit", "-m", "advance beyond the old tree"]);
  const revertBase = masterHead(fixture);
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    base: revertBase,
    paths: { "base.txt": "base\n" }
  });

  const result = await enqueue(fixture, changeSet);

  assert.equal(
    result.outcome,
    "queued",
    "a same-tree commit older than the ChangeSet base cannot prove the revert landed"
  );
  assert.equal(result.entry.status, "queued");
  assert.equal(
    readFileSync(join(fixture.repositoryPath, "base.txt"), "utf8"),
    "changed after the old tree\n"
  );
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

test("evidence does not skip the gate across a target change", async () => {
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
  // The third item is disjoint from both: it adds c.txt and carries evidence
  // too, so it must still run its own gate against the current target.
  const third = await branchChangeSet(fixture, {
    id: "change-set-3",
    paths: { "c.txt": "c\n" },
    manifest: EVIDENCE
  });
  await enqueue(fixture, first, { checkCommands: ["true"] });
  await enqueue(fixture, second, { checkCommands: ["false"] });
  await enqueue(fixture, third, { checkCommands: ["true"] });
  const processed = await processQueue(fixture);
  assert.equal(processed.length, 3);
  assert.equal(processed[0].entry.status, "committed");
  // The second item carries evidence, but disjoint changedPaths do not rebind
  // it to the target the first commit produced: its gate runs against the new
  // target and fails instead of being skipped.
  assert.equal(processed[1].entry.status, "conflicted");
  assert.match(processed[1].entry.conflictSummary, /gate failed/);
  assert.deepEqual(processed[1].attempt.checkCommands, ["false"]);
  assert.equal(processed[1].attempt.checks[0].outcome, "failed");
  // The third item keeps its place and also runs its (passing) gate against
  // the exact current target before committing.
  assert.equal(processed[2].entry.status, "committed");
  assert.deepEqual(processed[2].attempt.checkCommands, ["true"]);
  assert.equal(processed[2].attempt.checks[0].outcome, "passed");
  assert.equal(existsSync(join(fixture.repositoryPath, "b.txt")), false);
  assert.equal(readFileSync(join(fixture.repositoryPath, "c.txt"), "utf8"), "c\n");
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
  const reconciled = await reconcileIntegrationQueueEntry(
    fixture.store,
    fixture.task.id,
    conflicted.id,
    new NodeGitWorkspace(),
    () => now
  );
  assert.equal(reconciled.status, "committed");
  assert.equal(reconciled.targetAfter, candidate);
});

test("recovery commands cannot discard a committed manual-resolution Attempt", async (t) => {
  for (const action of ["requeue", "supersede"]) {
    await t.test(action, async () => {
      const fixture = await createFixture();
      const changeSet = await branchChangeSet(fixture, {
        id: "change-set-1",
        paths: { "manual.txt": "resolved\n" }
      });
      const queued = await enqueue(fixture, changeSet, { checkCommands: ["true"] });
      let attempt = createIntegrationAttempt({
        id: fixture.store.nextIntegrationAttemptId(fixture.task.id),
        taskId: fixture.task.id,
        projectId: fixture.project.id,
        targetRef: "master",
        expectedHead: fixture.baseCommit,
        changeSetIds: [changeSet.id],
        checkCommands: ["true"]
      }, now);
      fixture.store.saveIntegrationAttempt(fixture.task.id, attempt);
      const running = recordIntegrationQueueAttempt(
        markIntegrationQueueRunning(queued.entry, fixture.baseCommit, now),
        attempt.id,
        now
      );
      fixture.store.saveIntegrationQueueEntry(fixture.task.id, running);
      attempt = requireLeaderDecision(attempt, {
        affectedPaths: ["manual.txt"],
        summary: "manual conflict resolution"
      }, now);
      fixture.store.saveIntegrationAttempt(fixture.task.id, attempt);
      fixture.store.saveIntegrationQueueEntry(
        fixture.task.id,
        markIntegrationQueueBlocked(running, "manual conflict resolution", now)
      );
      attempt = recordResolutionDecision(attempt, {
        action: "manual-resolution",
        rationale: "preserve the combined result"
      }, now);
      fixture.store.saveIntegrationAttempt(fixture.task.id, attempt);
      git(["-C", fixture.repositoryPath, "merge", "--ff-only", changeSet.branch]);
      attempt = updateIntegrationAttempt(attempt, {
        status: "validating",
        candidateCommit: changeSet.headCommit,
        checks: [{ name: "true", outcome: "passed" }]
      }, now);
      fixture.store.saveIntegrationAttempt(fixture.task.id, attempt);
      attempt = updateIntegrationAttempt(attempt, { status: "committed" }, now);
      fixture.store.saveIntegrationAttempt(fixture.task.id, attempt);

      assert.throws(
        () => action === "requeue"
          ? requeueIntegrationQueueEntry(
              fixture.store,
              fixture.task.id,
              queued.entry.id,
              () => now
            )
          : supersedeIntegrationQueueEntry(
              fixture.store,
              fixture.task.id,
              queued.entry.id,
              "do not discard committed provenance",
              () => now
            ),
        /committed.*reconcile|reconcile.*committed/iu
      );
    });
  }
});

test("recovery commands cannot race a manual-resolution Attempt commit", {
  skip: process.env.YUI_REVIEW_ATOMIC_QUEUE_RACE !== "1"
}, async () => {
  const invalidActions = [];
  for (const action of ["requeue", "supersede"]) {
    const fixture = await createFixture();
    const changeSet = await branchChangeSet(fixture, {
      id: "change-set-1",
      paths: { "manual.txt": "resolved\n" }
    });
    const queued = await enqueue(fixture, changeSet, { checkCommands: ["true"] });
    let attempt = createIntegrationAttempt({
      id: fixture.store.nextIntegrationAttemptId(fixture.task.id),
      taskId: fixture.task.id,
      projectId: fixture.project.id,
      targetRef: "master",
      expectedHead: fixture.baseCommit,
      changeSetIds: [changeSet.id],
      checkCommands: ["true"]
    }, now);
    fixture.store.saveIntegrationAttempt(fixture.task.id, attempt);
    const running = recordIntegrationQueueAttempt(
      markIntegrationQueueRunning(queued.entry, fixture.baseCommit, now),
      attempt.id,
      now
    );
    fixture.store.saveIntegrationQueueEntry(fixture.task.id, running);
    attempt = requireLeaderDecision(attempt, {
      affectedPaths: ["manual.txt"],
      summary: "manual conflict resolution"
    }, now);
    fixture.store.saveIntegrationAttempt(fixture.task.id, attempt);
    fixture.store.saveIntegrationQueueEntry(
      fixture.task.id,
      markIntegrationQueueBlocked(running, "manual conflict resolution", now)
    );
    attempt = recordResolutionDecision(attempt, {
      action: "manual-resolution",
      rationale: "preserve the combined result"
    }, now);
    fixture.store.saveIntegrationAttempt(fixture.task.id, attempt);
    const validating = updateIntegrationAttempt(attempt, {
      status: "validating",
      candidateCommit: changeSet.headCommit,
      checks: [{ name: "true", outcome: "passed" }]
    }, now);
    const committed = updateIntegrationAttempt(validating, { status: "committed" }, now);
    const competingStore = new FileTaskStore(fixture.home);
    let injectedCommit = false;
    const racingStore = new Proxy(fixture.store, {
      get(target, property) {
        if (property === "getIntegrationAttempt") {
          return (taskId, attemptId) => {
            const observed = target.getIntegrationAttempt(taskId, attemptId);
            if (!injectedCommit) {
              injectedCommit = true;
              competingStore.saveIntegrationAttempt(taskId, validating);
              git(["-C", fixture.repositoryPath, "merge", "--ff-only", changeSet.branch]);
              competingStore.saveIntegrationAttempt(taskId, committed);
            }
            return observed;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });

    if (action === "requeue") {
      requeueIntegrationQueueEntry(
        racingStore,
        fixture.task.id,
        queued.entry.id,
        () => now
      );
    } else {
      supersedeIntegrationQueueEntry(
        racingStore,
        fixture.task.id,
        queued.entry.id,
        "do not discard concurrently committed provenance",
        () => now
      );
    }

    const finalAttempt = fixture.store.getIntegrationAttempt(fixture.task.id, attempt.id);
    const finalEntry = fixture.store.getIntegrationQueueEntry(
      fixture.task.id,
      queued.entry.id
    );
    if (finalAttempt.status === "committed"
      && (finalEntry.status === "queued" || finalEntry.status === "superseded")) {
      invalidActions.push(action);
    }
  }
  assert.deepEqual(
    invalidActions,
    [],
    "a recovery write must not discard a concurrently committed Attempt"
  );
});

test("recovery commands cannot overtake a validating manual-resolution Attempt", {
  skip: process.env.YUI_REVIEW_VALIDATING_QUEUE_RACE !== "1"
}, async () => {
  const invalidActions = [];
  for (const action of ["requeue", "supersede"]) {
    const fixture = await createFixture();
    const changeSet = await branchChangeSet(fixture, {
      id: "change-set-1",
      paths: { "manual.txt": "resolved\n" }
    });
    const queued = await enqueue(fixture, changeSet, { checkCommands: ["true"] });
    let attempt = createIntegrationAttempt({
      id: fixture.store.nextIntegrationAttemptId(fixture.task.id),
      taskId: fixture.task.id,
      projectId: fixture.project.id,
      targetRef: "master",
      expectedHead: fixture.baseCommit,
      changeSetIds: [changeSet.id],
      checkCommands: ["true"]
    }, now);
    fixture.store.saveIntegrationAttempt(fixture.task.id, attempt);
    const running = recordIntegrationQueueAttempt(
      markIntegrationQueueRunning(queued.entry, fixture.baseCommit, now),
      attempt.id,
      now
    );
    fixture.store.saveIntegrationQueueEntry(fixture.task.id, running);
    attempt = requireLeaderDecision(attempt, {
      affectedPaths: ["manual.txt"],
      summary: "manual conflict resolution"
    }, now);
    fixture.store.saveIntegrationAttempt(fixture.task.id, attempt);
    fixture.store.saveIntegrationQueueEntry(
      fixture.task.id,
      markIntegrationQueueBlocked(running, "manual conflict resolution", now)
    );
    attempt = recordResolutionDecision(attempt, {
      action: "manual-resolution",
      rationale: "preserve the combined result"
    }, now);
    fixture.store.saveIntegrationAttempt(fixture.task.id, attempt);

    // GitIntegrationService persists `validating` before advancing the target.
    // Pause that supported continuation here, let queue recovery run, then
    // resume the exact CAS -> committed tail of the continuation.
    const validating = updateIntegrationAttempt(attempt, {
      status: "validating",
      candidateCommit: changeSet.headCommit,
      checks: [{ name: "true", outcome: "passed" }]
    }, now);
    fixture.store.saveIntegrationAttempt(fixture.task.id, validating);
    try {
      if (action === "requeue") {
        requeueIntegrationQueueEntry(
          fixture.store,
          fixture.task.id,
          queued.entry.id,
          () => now
        );
      } else {
        supersedeIntegrationQueueEntry(
          fixture.store,
          fixture.task.id,
          queued.entry.id,
          "do not discard an in-flight manual resolution",
          () => now
        );
      }
    } catch {
      // Fail-closed is the safe recovery result while the Attempt is in flight.
    }
    git(["-C", fixture.repositoryPath, "merge", "--ff-only", changeSet.branch]);
    fixture.store.saveIntegrationAttempt(
      fixture.task.id,
      updateIntegrationAttempt(validating, { status: "committed" }, now)
    );

    const finalAttempt = fixture.store.getIntegrationAttempt(fixture.task.id, attempt.id);
    const finalEntry = fixture.store.getIntegrationQueueEntry(
      fixture.task.id,
      queued.entry.id
    );
    if (finalAttempt.status === "committed"
      && (finalEntry.status === "queued" || finalEntry.status === "superseded")) {
      invalidActions.push(action);
    }
  }
  assert.deepEqual(
    invalidActions,
    [],
    "recovery must reject a queue entry while its manual-resolution Attempt is validating"
  );
});

test("a stale abort cannot overtake a validating manual-resolution Attempt", async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "manual.txt": "resolved\n" }
  });
  const queued = await enqueue(fixture, changeSet, { checkCommands: ["true"] });
  let attempt = createIntegrationAttempt({
    id: fixture.store.nextIntegrationAttemptId(fixture.task.id),
    taskId: fixture.task.id,
    projectId: fixture.project.id,
    targetRef: "master",
    expectedHead: fixture.baseCommit,
    changeSetIds: [changeSet.id],
    checkCommands: ["true"]
  }, now);
  fixture.store.saveIntegrationAttempt(fixture.task.id, attempt);
  const running = recordIntegrationQueueAttempt(
    markIntegrationQueueRunning(queued.entry, fixture.baseCommit, now),
    attempt.id,
    now
  );
  fixture.store.saveIntegrationQueueEntry(fixture.task.id, running);
  attempt = requireLeaderDecision(attempt, {
    affectedPaths: ["manual.txt"],
    summary: "manual conflict resolution"
  }, now);
  fixture.store.saveIntegrationAttempt(fixture.task.id, attempt);
  fixture.store.saveIntegrationQueueEntry(
    fixture.task.id,
    markIntegrationQueueBlocked(running, "manual conflict resolution", now)
  );
  attempt = recordResolutionDecision(attempt, {
    action: "manual-resolution",
    rationale: "preserve the combined result"
  }, now);
  fixture.store.saveIntegrationAttempt(fixture.task.id, attempt);

  // An abort command reads the blocked Attempt, while the supported continue
  // command advances it to validating in another process before abort saves.
  const validating = updateIntegrationAttempt(attempt, {
    status: "validating",
    candidateCommit: changeSet.headCommit,
    checks: [{ name: "true", outcome: "passed" }]
  }, now);
  const competingStore = new FileTaskStore(fixture.home);
  let injectedValidating = false;
  const racingStore = new Proxy(fixture.store, {
    get(target, property) {
      if (property === "getIntegrationAttempt") {
        return (taskId, attemptId) => {
          const observed = target.getIntegrationAttempt(taskId, attemptId);
          if (!injectedValidating) {
            injectedValidating = true;
            competingStore.saveIntegrationAttempt(taskId, validating);
          }
          return observed;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  let abortRejected = false;
  try {
    await runTaskIntegrationCommand(
      [
        "abort", `${fixture.task.id}/${attempt.id}`,
        "--reason", "stale operator request"
      ],
      racingStore,
      fixture.home,
      { now: () => now }
    );
  } catch {
    abortRejected = true;
  }

  // Resume the exact target-CAS -> committed tail of the continuation.
  git(["-C", fixture.repositoryPath, "merge", "--ff-only", changeSet.branch]);
  let continuationCommitRejected = false;
  try {
    fixture.store.saveIntegrationAttempt(
      fixture.task.id,
      updateIntegrationAttempt(validating, { status: "committed" }, now)
    );
  } catch {
    continuationCommitRejected = true;
  }

  assert.deepEqual(
    {
      abortRejected,
      targetAdvanced: masterHead(fixture) === changeSet.headCommit,
      attemptStatus: fixture.store.getIntegrationAttempt(fixture.task.id, attempt.id).status,
      continuationCommitRejected
    },
    {
      abortRejected: true,
      targetAdvanced: true,
      attemptStatus: "committed",
      continuationCommitRejected: false
    },
    "a stale abort must fail closed once the continuation is validating"
  );
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

// --- task-16 review regressions --------------------------------------------

test("a target commit does not rebind a waiting item's evidence to the new head", async () => {
  const fixture = await createFixture();
  const trigger = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "other.txt": "other\n" }
  });
  // The target item carries evidence but its gate reads a file it does not
  // touch: disjoint changedPaths must not mark it validated.
  const target = await branchChangeSet(fixture, {
    id: "change-set-2",
    paths: { "app.js": "app\n" },
    manifest: EVIDENCE
  });
  await enqueue(fixture, trigger, { checkCommands: ["true"] });
  await enqueue(fixture, target, { checkCommands: ["! grep -q THREE config.txt"] });
  const first = await processQueue(fixture, { limit: 1 });
  assert.equal(first.length, 1);
  assert.equal(first[0].entry.status, "committed");
  // The trigger landed, but the waiting item keeps its place: its evidence is
  // not rebound to the new target head and no evidence boundary is recorded.
  const waiting = fixture.store.getIntegrationQueueEntry(fixture.task.id, "integration-queue-2");
  assert.equal(waiting.status, "queued");
  assert.equal(waiting.evidenceTargetHead, undefined);
});

test("an out-of-band target advance invalidates reusable evidence and re-runs the gate", async () => {
  const fixture = await createFixture();
  const trigger = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "other.txt": "other\n" }
  });
  // The target item carries evidence and a gate that reads a file it does not
  // touch: the gate fails once config.txt says THREE.
  const target = await branchChangeSet(fixture, {
    id: "change-set-2",
    paths: { "app.js": "app\n" },
    manifest: EVIDENCE
  });
  await enqueue(fixture, trigger, { checkCommands: ["true"] });
  await enqueue(fixture, target, { checkCommands: ["! grep -q THREE config.txt"] });
  const first = await processQueue(fixture, { limit: 1 });
  assert.equal(first.length, 1);
  assert.equal(first[0].entry.status, "committed");
  // Record an exact-target evidence binding for the head the trigger produced
  // (the only sound form of validation: the evidence was checked against this
  // exact head), so the out-of-band fence has something to invalidate.
  const waiting = fixture.store.getIntegrationQueueEntry(fixture.task.id, "integration-queue-2");
  fixture.store.saveIntegrationQueueEntry(
    fixture.task.id,
    markIntegrationQueueValidated(waiting, now, first[0].entry.targetAfter)
  );
  // Another Task advances the shared target out of band, writing THREE to the
  // file the target item's gate reads.
  writeFileSync(join(fixture.repositoryPath, "config.txt"), "THREE\n");
  git(["-C", fixture.repositoryPath, "add", "config.txt"]);
  git(["-C", fixture.repositoryPath, "commit", "-m", "out-of-band config change"]);
  // Second run: the evidence no longer covers the target, so the item is
  // requeued and its gate runs (and fails) instead of committing unchecked.
  const second = await processQueue(fixture);
  assert.equal(second.length, 1);
  assert.equal(second[0].entry.status, "conflicted");
  assert.match(second[0].entry.conflictSummary, /gate failed/);
  assert.equal(second[0].attempt.checks.length, 1);
  assert.equal(second[0].attempt.checks[0].outcome, "failed");
  // The failed change never reached the target.
  assert.equal(existsSync(join(fixture.repositoryPath, "app.js")), false);
});

test("a running entry whose attempt committed before the settle converges on restart", async () => {
  const fixture = await createFixture();
  const first = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  // A second, unaffected entry with reusable evidence: its evidence-only
  // commit after the restart proves the reconciled commit replayed the same
  // downstream affected/evidence updates as a normal settle.
  const second = await branchChangeSet(fixture, {
    id: "change-set-2",
    paths: { "b.txt": "b\n" },
    manifest: EVIDENCE
  });
  const queued = await enqueue(fixture, first, { checkCommands: ["true"] });
  await enqueue(fixture, second, { checkCommands: ["true"] });

  // Simulate the crash window: the entry is claimed and running, its attempt
  // commits and advances the target, but the process dies before the settle
  // transaction writes the entry back.
  const attempt = createIntegrationAttempt({
    id: fixture.store.nextIntegrationAttemptId(fixture.task.id),
    taskId: fixture.task.id,
    projectId: fixture.project.id,
    targetRef: "master",
    expectedHead: fixture.baseCommit,
    changeSetIds: [first.id],
    checkCommands: ["true"]
  }, now);
  fixture.store.saveIntegrationAttempt(fixture.task.id, attempt);
  fixture.store.saveIntegrationQueueEntry(
    fixture.task.id,
    recordIntegrationQueueAttempt(
      markIntegrationQueueRunning(queued.entry, fixture.baseCommit, now),
      attempt.id,
      now
    )
  );
  git(["-C", fixture.repositoryPath, "merge", "--ff-only", first.branch]);
  const validating = updateIntegrationAttempt(attempt, {
    status: "validating",
    candidateCommit: first.headCommit,
    checks: [{ name: "true", outcome: "passed" }]
  }, now);
  fixture.store.saveIntegrationAttempt(fixture.task.id, validating);
  fixture.store.saveIntegrationAttempt(
    fixture.task.id,
    updateIntegrationAttempt(validating, { status: "committed" }, now)
  );

  // Restart: the next process pass must converge the stuck entry instead of
  // leaving it running forever.
  const processed = await processQueue(fixture);

  const reconciled = fixture.store.getIntegrationQueueEntry(
    fixture.task.id,
    queued.entry.id
  );
  assert.equal(reconciled.status, "committed");
  assert.equal(reconciled.targetAfter, first.headCommit);
  assert.ok(reconciled.endedAt !== undefined);
  // The reconciled commit replayed the downstream updates: the unaffected
  // second entry kept its place and committed against the advanced target.
  // Evidence is no longer rebound in-band (the P1 fix): it runs its checks
  // against the exact target rather than skipping them.
  assert.equal(processed.length, 1);
  assert.equal(processed[0].entry.id, "integration-queue-2");
  assert.equal(processed[0].entry.status, "committed");
  assert.deepEqual(processed[0].attempt.checkCommands, ["true"]);
  assert.deepEqual(
    processed[0].attempt.checks.map(({ outcome }) => outcome),
    ["passed"]
  );
});

test("concurrent enqueues of the same ChangeSet create a single entry across store instances", async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  const otherStore = new FileTaskStore(fixture.home);
  const shared = {
    taskId: fixture.task.id,
    projectId: fixture.project.id,
    changeSetId: changeSet.id,
    targetRef: "master",
    now: () => now
  };
  const [first, second] = await Promise.all([
    enqueueIntegrationQueueEntry({ store: fixture.store, ...shared }),
    enqueueIntegrationQueueEntry({ store: otherStore, ...shared })
  ]);
  const outcomes = [first.outcome, second.outcome].sort();
  assert.deepEqual(outcomes, ["already-queued", "queued"]);
  assert.equal(first.entry.id, second.entry.id);
  assert.equal(fixture.store.listIntegrationQueueEntries(fixture.task.id).length, 1);
});

test("concurrent process calls claim a waiting entry exactly once across store instances", async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  await enqueue(fixture, changeSet, { checkCommands: ["true"] });
  const otherStore = new FileTaskStore(fixture.home);
  const [first, second] = await Promise.all([
    processQueue(fixture),
    processIntegrationQueue(otherStore, fixture.home, fixture.task.id, { now: () => now })
  ]);
  const processed = [...first, ...second];
  assert.equal(processed.length, 1);
  assert.equal(processed[0].entry.status, "committed");
  const attempts = fixture.store.listIntegrationAttempts(fixture.task.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "committed");
  const entry = fixture.store.getIntegrationQueueEntry(fixture.task.id, "integration-queue-1");
  assert.equal(entry.status, "committed");
});

test("a running first entry prevents another processor from claiming its successor", async () => {
  const fixture = await createFixture();
  const first = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  const second = await branchChangeSet(fixture, {
    id: "change-set-2",
    paths: { "b.txt": "b\n" }
  });
  await enqueue(fixture, first, { checkCommands: ["true"] });
  await enqueue(fixture, second, { checkCommands: ["true"] });

  let notifyPaused;
  const paused = new Promise((resolve) => { notifyPaused = resolve; });
  let releaseFirst;
  const released = new Promise((resolve) => { releaseFirst = resolve; });
  class PausingGitWorkspace extends NodeGitWorkspace {
    paused = false;

    async ensureIntegrationWorktree(input) {
      if (!this.paused) {
        this.paused = true;
        notifyPaused();
        await released;
      }
      return super.ensureIntegrationWorktree(input);
    }
  }

  // The first processor claims the first entry and pauses mid-integration,
  // holding the entry `running`.
  const firstProcessor = processQueue(fixture, {
    git: new PausingGitWorkspace(),
    limit: 1
  });
  await paused;
  assert.equal(
    fixture.store.getIntegrationQueueEntry(fixture.task.id, "integration-queue-1").status,
    "running"
  );
  // A second processor over a fresh store instance must not claim the
  // successor while the first entry is running.
  const secondProcessor = await processIntegrationQueue(
    new FileTaskStore(fixture.home),
    fixture.home,
    fixture.task.id,
    { limit: 1, now: () => now }
  );
  releaseFirst();
  await firstProcessor;

  assert.equal(secondProcessor.length, 0);
  assert.equal(
    fixture.store.getIntegrationQueueEntry(fixture.task.id, "integration-queue-2").status,
    "queued"
  );
});

test("the running barrier is re-checked inside the claim transaction", async () => {
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
  // Block the first entry; with limit 1 the second stays queued behind it.
  const blocked = await processQueue(fixture, { limit: 1 });
  assert.equal(blocked[0].entry.status, "conflicted");

  let notifyPaused;
  const paused = new Promise((resolve) => { notifyPaused = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  class PausingInspectGit extends NodeGitWorkspace {
    paused = false;

    async inspect(repositoryPath, ref) {
      if (!this.paused) {
        this.paused = true;
        notifyPaused();
        await released;
      }
      return super.inspect(repositoryPath, ref);
    }
  }

  // The processor selects the second entry (the first is conflicted) and
  // pauses between selection and claim.
  const processor = processQueue(fixture, { git: new PausingInspectGit() });
  await paused;
  // Another actor requeues and claims the first entry in the meantime.
  requeueIntegrationQueueEntry(fixture.store, fixture.task.id, "integration-queue-1", () => now);
  const claimed = fixture.store.getIntegrationQueueEntry(fixture.task.id, "integration-queue-1");
  const attempt = createIntegrationAttempt({
    id: fixture.store.nextIntegrationAttemptId(fixture.task.id),
    taskId: fixture.task.id,
    projectId: fixture.project.id,
    targetRef: "master",
    expectedHead: fixture.baseCommit,
    changeSetIds: [claimed.changeSetId],
    checkCommands: claimed.checkCommands
  }, now);
  fixture.store.saveIntegrationAttempt(fixture.task.id, attempt);
  fixture.store.saveIntegrationQueueEntry(
    fixture.task.id,
    recordIntegrationQueueAttempt(
      markIntegrationQueueRunning(claimed, fixture.baseCommit, now),
      attempt.id,
      now
    )
  );
  release();
  const processed = await processor;

  // The claim transaction saw the first entry running and stood down; the
  // second entry stays queued.
  assert.equal(processed.length, 0);
  assert.equal(
    fixture.store.getIntegrationQueueEntry(fixture.task.id, "integration-queue-2").status,
    "queued"
  );
});

test("process and list honor numeric id order past ten entries", async () => {
  const fixture = await createFixture();
  for (let index = 1; index <= 11; index += 1) {
    const changeSet = await branchChangeSet(fixture, {
      id: `change-set-${index}`,
      paths: { [`file-${index}.txt`]: `${index}\n` }
    });
    await enqueue(fixture, changeSet, { checkCommands: ["true"] });
  }
  const listed = await runTaskIntegrationQueueCommand(
    ["list", fixture.task.id],
    fixture.store,
    fixture.home,
    {}
  );
  assert.deepEqual(
    listed.data.entries.map(({ id }) => id),
    Array.from({ length: 11 }, (_, index) => `integration-queue-${index + 1}`)
  );
  const processed = await processQueue(fixture);
  assert.equal(processed.length, 11);
  assert.deepEqual(
    processed.map(({ entry }) => entry.id),
    Array.from({ length: 11 }, (_, index) => `integration-queue-${index + 1}`)
  );
});

test("a dirty checked-out target fails before the check commands run", async () => {
  const fixture = await createFixture();
  const changeSet = await branchChangeSet(fixture, {
    id: "change-set-1",
    paths: { "a.txt": "a\n" }
  });
  const marker = join(fixture.root, "check-ran-marker");
  await enqueue(fixture, changeSet, { checkCommands: [`printf ran > ${marker}`] });
  // Another Task leaves the checked-out target worktree dirty.
  writeFileSync(join(fixture.repositoryPath, "dirty.txt"), "dirty\n");
  const processed = await processQueue(fixture);
  assert.equal(processed.length, 1);
  assert.equal(processed[0].entry.status, "conflicted");
  assert.match(processed[0].entry.conflictSummary, /not clean/);
  // The check command never ran: no marker file, and the only recorded check
  // is the static preflight failure rather than the command itself.
  assert.equal(existsSync(marker), false);
  assert.deepEqual(processed[0].attempt.checks.map(({ name }) => name), ["integration"]);
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
