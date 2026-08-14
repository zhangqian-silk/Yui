import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import {
  createIntegrationAttempt,
  updateIntegrationAttempt
} from "../../dist/integration/integrationAttempt.js";
import {
  markIntegrationQueueBlocked,
  markIntegrationQueueRunning,
  recordIntegrationQueueAttempt
} from "../../dist/integration/integrationQueueEntry.js";
import {
  enqueueIntegrationQueueEntry,
  processIntegrationQueue,
  reconcileIntegrationQueueEntry,
  requeueIntegrationQueueEntry,
  supersedeIntegrationQueueEntry
} from "../../dist/integration/integrationQueueService.js";
import { createProject } from "../../dist/repository/project.js";
import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
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

// Review-round-7, Bucket C (convergence lifecycle):
//  - finding 3 (P1): a converged queue entry must supply the Integration
//    proof required for WorkItem acceptance.
//  - finding 4 (P1): a restart must settle a running queue entry whose linked
//    Attempt already reached a terminal failed/blocked state.
//  - finding 8 (P2): manual reconciliation must replay the affected-path
//    recompute for waiting successors.

const now = new Date("2026-08-14T02:00:00.000Z");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function createFixture(label = "queue") {
  const root = mkdtempSync(join(tmpdir(), `yui-task-16-rr7-c-${label}-`));
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

function commitOnWorktree(fixture, label, paths) {
  const branch = `review-round-7/${label}`;
  const worktree = join(fixture.root, `worktree-${label}`);
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
  return {
    branch,
    worktree,
    headCommit: git(["-C", worktree, "rev-parse", "HEAD"]).trim()
  };
}

function createStoredChangeSet(fixture, id, paths) {
  const committed = commitOnWorktree(fixture, id, paths);
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
    baseCommit: fixture.baseCommit,
    headCommit: committed.headCommit,
    branch: committed.branch,
    changedPaths: Object.keys(paths)
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

test("a converged queue entry supplies the Integration proof required for WorkItem acceptance", async () => {
  const fixture = createFixture("convergence-proof");
  const created = createWorkItem(
    fixture.store.nextWorkItemId(fixture.task.id),
    fixture.task.id,
    {
      title: "candidate",
      acceptance: [],
      dependsOn: [],
      writeProjectIds: [fixture.project.id]
    },
    now
  );
  const candidate = submitWorkItemCandidate(
    updateWorkItemStatus(created, "running", now),
    { summary: "candidate", source: { type: "direct" } },
    now
  );
  fixture.store.saveWorkItem(fixture.task.id, candidate);
  const committed = commitOnWorktree(fixture, "candidate", {
    "candidate.txt": "candidate\n"
  });
  fixture.store.saveManagedWorkspace(createManagedWorkspace({
    owner: {
      type: "work-item",
      taskId: fixture.task.id,
      workItemId: candidate.id
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
  const manager = new WorkItemChangeSetManager(fixture.store, () => now);
  const [changeSet] = await manager.capture(fixture.task.id, candidate.id);
  git(["-C", fixture.repositoryPath, "merge", "--ff-only", committed.branch]);

  const result = await enqueue(fixture, changeSet);
  assert.equal(result.outcome, "converged");
  const proof = await manager.assertIntegrated(fixture.task.id, candidate.id);

  assert.equal(proof.projects[0].changeSetId, changeSet.id);
});

test("restart settles a running queue entry whose linked Attempt already failed", async () => {
  const fixture = createFixture("failed-attempt");
  const changeSet = createStoredChangeSet(fixture, "change-set-1", {
    "failed.txt": "failed\n"
  });
  const queued = await enqueue(fixture, changeSet, ["false"]);
  const attempt = createIntegrationAttempt({
    id: fixture.store.nextIntegrationAttemptId(fixture.task.id),
    taskId: fixture.task.id,
    projectId: fixture.project.id,
    targetRef: "master",
    expectedHead: fixture.baseCommit,
    changeSetIds: [changeSet.id],
    checkCommands: ["false"]
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
  fixture.store.saveIntegrationAttempt(
    fixture.task.id,
    updateIntegrationAttempt(attempt, {
      status: "failed",
      checks: [{ name: "false", outcome: "failed" }]
    }, now)
  );

  await processIntegrationQueue(fixture.store, fixture.home, fixture.task.id, {
    now: () => now
  });
  const recovered = fixture.store.getIntegrationQueueEntry(
    fixture.task.id,
    queued.entry.id
  );

  assert.equal(recovered.status, "conflicted");
  assert.equal(recovered.conflictSummary, "gate failed: false");
});

test("restart settles a running queue entry whose linked Attempt is blocked", async () => {
  const fixture = createFixture("blocked-attempt");
  const changeSet = createStoredChangeSet(fixture, "change-set-1", {
    "blocked.txt": "blocked\n"
  });
  const queued = await enqueue(fixture, changeSet, ["true"]);
  const attempt = createIntegrationAttempt({
    id: fixture.store.nextIntegrationAttemptId(fixture.task.id),
    taskId: fixture.task.id,
    projectId: fixture.project.id,
    targetRef: "master",
    expectedHead: fixture.baseCommit,
    changeSetIds: [changeSet.id],
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
  fixture.store.saveIntegrationAttempt(
    fixture.task.id,
    updateIntegrationAttempt(attempt, {
      status: "blocked",
      conflict: {
        affectedPaths: ["blocked.txt"],
        summary: "semantic conflict needs a leader decision"
      }
    }, now)
  );

  await processIntegrationQueue(fixture.store, fixture.home, fixture.task.id, {
    now: () => now
  });
  const recovered = fixture.store.getIntegrationQueueEntry(
    fixture.task.id,
    queued.entry.id
  );

  assert.equal(recovered.status, "conflicted");
  assert.equal(recovered.conflictSummary, "semantic conflict needs a leader decision");
});

test("queue recovery cannot silently leave its linked blocked Attempt unresolved", async (t) => {
  const recoveries = [
    {
      name: "requeue",
      apply: (fixture, entry) => requeueIntegrationQueueEntry(
        fixture.store,
        fixture.task.id,
        entry.id,
        () => now
      )
    },
    {
      name: "supersede",
      apply: (fixture, entry) => supersedeIntegrationQueueEntry(
        fixture.store,
        fixture.task.id,
        entry.id,
        "replaced by a corrected ChangeSet",
        () => now
      )
    }
  ];

  for (const recovery of recoveries) {
    await t.test(recovery.name, async () => {
      const fixture = createFixture(`blocked-${recovery.name}`);
      const changeSet = createStoredChangeSet(fixture, "change-set-1", {
        "blocked.txt": "blocked\n"
      });
      const queued = await enqueue(fixture, changeSet, ["true"]);
      const attempt = createIntegrationAttempt({
        id: fixture.store.nextIntegrationAttemptId(fixture.task.id),
        taskId: fixture.task.id,
        projectId: fixture.project.id,
        targetRef: "master",
        expectedHead: fixture.baseCommit,
        changeSetIds: [changeSet.id],
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
      fixture.store.saveIntegrationAttempt(
        fixture.task.id,
        updateIntegrationAttempt(attempt, {
          status: "blocked",
          conflict: {
            affectedPaths: ["blocked.txt"],
            summary: "semantic conflict needs a leader decision"
          }
        }, now)
      );
      await processIntegrationQueue(fixture.store, fixture.home, fixture.task.id, {
        now: () => now
      });
      const conflicted = fixture.store.getIntegrationQueueEntry(
        fixture.task.id,
        queued.entry.id
      );

      try {
        recovery.apply(fixture, conflicted);
      } catch (error) {
        assert.match(String(error), /blocked|Integration Attempt/);
        return;
      }

      await assert.doesNotReject(
        () => new WorkItemChangeSetManager(fixture.store, () => now)
          .assertRetirable(fixture.task.id),
        `successful ${recovery.name} must not strand the Task behind ${attempt.id}`
      );
    });
  }
});

test("committed-attempt recovery replays downstream overlap after a crash during the settle", async () => {
  const fixture = createFixture("committed-recovery-atomicity");
  const first = createStoredChangeSet(fixture, "change-set-1", {
    "shared.txt": "first\n"
  });
  const second = createStoredChangeSet(fixture, "change-set-2", {
    "shared.txt": "second\n"
  });
  const firstQueued = await enqueue(fixture, first, ["true"]);
  const secondQueued = await enqueue(fixture, second, ["true"]);
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
      markIntegrationQueueRunning(firstQueued.entry, fixture.baseCommit, now),
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

  let injectCrash = true;
  const crashingStore = new Proxy(fixture.store, {
    get(target, property) {
      if (property === "saveIntegrationQueueEntry") {
        return (taskId, entry) => {
          target.saveIntegrationQueueEntry(taskId, entry);
          if (
            injectCrash
            && entry.id === firstQueued.entry.id
            && entry.status === "committed"
          ) {
            injectCrash = false;
            throw new Error("simulated crash after queue settle");
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  await assert.rejects(
    processIntegrationQueue(crashingStore, fixture.home, fixture.task.id, {
      projectId: "project-not-in-task",
      now: () => now
    }),
    /simulated crash after queue settle/
  );
  assert.equal(
    fixture.store.getIntegrationQueueEntry(fixture.task.id, firstQueued.entry.id).status,
    "committed"
  );
  assert.equal(
    fixture.store.getIntegrationQueueEntry(fixture.task.id, secondQueued.entry.id).affectedPaths,
    undefined
  );

  // A normal restart must finish the interrupted recovery.  Today the first
  // entry is already terminal, so reconciliation skips it and the overlap is
  // lost permanently.
  await processIntegrationQueue(fixture.store, fixture.home, fixture.task.id, {
    projectId: "project-not-in-task",
    now: () => now
  });
  const waiting = fixture.store.getIntegrationQueueEntry(
    fixture.task.id,
    secondQueued.entry.id
  );
  assert.deepEqual(waiting.affectedPaths, ["shared.txt"]);
});

test("manual reconciliation replays affected-path updates for waiting entries", async () => {
  const fixture = createFixture("manual-reconcile");
  const first = createStoredChangeSet(fixture, "change-set-1", {
    "shared.txt": "first\n"
  });
  const second = createStoredChangeSet(fixture, "change-set-2", {
    "shared.txt": "second\n"
  });
  const firstQueued = await enqueue(fixture, first, ["true"]);
  const secondQueued = await enqueue(fixture, second, ["true"]);
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
  const running = recordIntegrationQueueAttempt(
    markIntegrationQueueRunning(firstQueued.entry, fixture.baseCommit, now),
    attempt.id,
    now
  );
  fixture.store.saveIntegrationQueueEntry(fixture.task.id, running);
  fixture.store.saveIntegrationQueueEntry(
    fixture.task.id,
    markIntegrationQueueBlocked(running, "resolved manually", now)
  );
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

  await reconcileIntegrationQueueEntry(
    fixture.store,
    fixture.task.id,
    firstQueued.entry.id,
    new NodeGitWorkspace(),
    () => now
  );
  const waiting = fixture.store.getIntegrationQueueEntry(
    fixture.task.id,
    secondQueued.entry.id
  );

  assert.deepEqual(waiting.affectedPaths, ["shared.txt"]);
});
