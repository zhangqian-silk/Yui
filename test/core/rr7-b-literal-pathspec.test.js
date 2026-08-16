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
import { enqueueIntegrationQueueEntry } from "../../dist/integration/integrationQueueService.js";
import { createProject } from "../../dist/repository/project.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";

const now = new Date("2026-08-14T02:00:00.000Z");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function createFixture(label = "queue") {
  const root = mkdtempSync(join(tmpdir(), `yui-task-16-rr7-${label}-`));
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

test("tree convergence treats captured Git paths literally", async () => {
  const fixture = createFixture("literal-pathspec");
  const path = ":(exclude)*";
  const changeSet = createStoredChangeSet(fixture, "change-set-1", {
    [path]: "candidate-only\n"
  });

  const result = await enqueue(fixture, changeSet);

  assert.equal(result.outcome, "queued");
  assert.equal(result.entry.status, "queued");
});
