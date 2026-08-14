import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureManagedGitChanges } from "../../dist/workspace/gitChangeSetCapture.js";
import { createChangeSetManifest } from "../../dist/integration/changeSetManifest.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import { enqueueIntegrationQueueEntry } from "../../dist/integration/integrationQueueService.js";
import { deriveManifestTags } from "../../dist/integration/manifestTags.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { createProject } from "../../dist/repository/project.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";

/**
 * Rename subtree convergence (review finding p1-rename-subtree-convergence).
 *
 * A pure rename must be captured as add+delete: the source path lands in
 * touched paths and in deletedPaths.  Otherwise a target that added the same
 * file in parallel (but kept the source) converges on a partial-tree proof,
 * reporting a complete integration while the deletion semantics are missing.
 */

const now = new Date("2026-08-13T00:00:00.000Z");
const SAME_CONTENT = "same content\n";

function git(args, cwd) {
  return execFileSync("git", args, { encoding: "utf8", cwd });
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "yui-rename-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  const repositoryPath = join(root, "repository");
  git(["init", "-b", "master", repositoryPath]);
  git(["-C", repositoryPath, "config", "user.name", "Test"]);
  git(["-C", repositoryPath, "config", "user.email", "test@example.com"]);
  mkdirSync(join(repositoryPath, "src"));
  writeFileSync(join(repositoryPath, "src", "old.ts"), SAME_CONTENT);
  writeFileSync(join(repositoryPath, "base.txt"), "base\n");
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
  return { root, repositoryPath, home, store, project, baseCommit };
}

/**
 * Commit a 100% rename (src/old.ts -> src/new.ts, identical content) on a
 * Task branch and capture it through the real managed-capture path.
 */
async function captureRename(fixture, branch) {
  const worktree = join(fixture.root, "rename-worktree");
  git(["-C", fixture.repositoryPath, "worktree", "add", "-b", branch, worktree, fixture.baseCommit]);
  try {
    git(["-C", worktree, "mv", "src/old.ts", "src/new.ts"]);
    git([
      "-C", worktree,
      "-c", "user.name=Test",
      "-c", "user.email=test@example.com",
      "commit", "-m", "rename old to new"
    ]);
    const captured = await captureManagedGitChanges({
      path: worktree,
      branch,
      baseCommit: fixture.baseCommit,
      commitMessage: "yui: work item work-item-1 (fixture)",
      identity: "work-item-1/project-1"
    });
    if (captured === null) throw new Error("rename capture returned no changes");
    return captured;
  } finally {
    git(["-C", fixture.repositoryPath, "worktree", "remove", worktree]);
  }
}

function enqueue(fixture, task, changeSet) {
  return enqueueIntegrationQueueEntry({
    store: fixture.store,
    taskId: task.id,
    projectId: fixture.project.id,
    changeSetId: changeSet.id,
    targetRef: "master",
    now: () => now
  });
}

test("capture records a rename source as touched and deleted", async () => {
  const fixture = createFixture();
  const captured = await captureRename(fixture, "yui/task-rename/capture");
  assert.deepEqual([...captured.changedPaths].sort(), ["src/new.ts", "src/old.ts"]);
  assert.deepEqual(captured.deletedPaths, ["src/old.ts"]);
});

test("enqueue refuses tree convergence while the target keeps the renamed source", async () => {
  const fixture = createFixture();
  const task = activateTask(createTask(
    fixture.store.nextTaskId(),
    "Rename task",
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
  const workItem = createWorkItem(
    fixture.store.nextWorkItemId(task.id),
    task.id,
    {
      title: "Rename old to new",
      acceptance: [],
      dependsOn: [],
      assignee: "leader",
      writeProjectIds: [fixture.project.id]
    },
    now
  );
  fixture.store.saveWorkItem(task.id, workItem);

  // The Candidate: a 100% rename captured through the real path.
  const captured = await captureRename(fixture, `yui/${task.id}/rename-kept`);
  const changeSet = createWorkItemChangeSet({
    id: "change-set-501",
    taskId: task.id,
    workItemId: workItem.id,
    projectId: fixture.project.id,
    baseCommit: fixture.baseCommit,
    headCommit: captured.headCommit,
    branch: `yui/${task.id}/rename-kept`,
    changedPaths: captured.changedPaths,
    manifest: createChangeSetManifest({
      tags: deriveManifestTags({
        changedPaths: captured.changedPaths,
        deletedPaths: captured.deletedPaths
      }),
      deletedPaths: captured.deletedPaths,
      targetRef: "master"
    })
  }, now);
  fixture.store.saveChangeSet(task.id, changeSet);

  // The target independently adds identical content at the new path...
  writeFileSync(join(fixture.repositoryPath, "src", "new.ts"), SAME_CONTENT);
  git(["-C", fixture.repositoryPath, "add", "-A"]);
  git(["-C", fixture.repositoryPath, "commit", "-m", "parallel add new.ts"]);
  // ...but keeps the renamed source: the deletion semantics are missing.
  assert.equal(readFileSync(join(fixture.repositoryPath, "src", "old.ts"), "utf8"), SAME_CONTENT);

  const result = await enqueue(fixture, task, changeSet);
  assert.equal(result.outcome, "queued");
  assert.notEqual(result.entry.status, "committed");
});

test("a migrated manifestless rename cannot converge on its destination alone", async () => {
  const fixture = createFixture();
  const task = activateTask(createTask(
    fixture.store.nextTaskId(),
    "Legacy rename task",
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
  const workItem = createWorkItem(
    fixture.store.nextWorkItemId(task.id),
    task.id,
    {
      title: "Legacy rename old to new",
      acceptance: [],
      dependsOn: [],
      assignee: "leader",
      writeProjectIds: [fixture.project.id]
    },
    now
  );
  fixture.store.saveWorkItem(task.id, workItem);

  const branch = `yui/${task.id}/legacy-rename`;
  const captured = await captureRename(fixture, branch);
  // A valid v2 record captured before --no-renames reported only the rename
  // destination.  The 2->3 migration preserves that path list and leaves the
  // new manifest absent, so current code must not treat it as a complete
  // containment proof.
  const migrated = createWorkItemChangeSet({
    id: "change-set-503",
    taskId: task.id,
    workItemId: workItem.id,
    projectId: fixture.project.id,
    baseCommit: fixture.baseCommit,
    headCommit: captured.headCommit,
    branch,
    changedPaths: ["src/new.ts"]
  }, now);
  fixture.store.saveChangeSet(task.id, migrated);

  writeFileSync(join(fixture.repositoryPath, "src", "new.ts"), SAME_CONTENT);
  git(["-C", fixture.repositoryPath, "add", "-A"]);
  git(["-C", fixture.repositoryPath, "commit", "-m", "parallel add new.ts"]);
  assert.equal(readFileSync(join(fixture.repositoryPath, "src", "old.ts"), "utf8"), SAME_CONTENT);

  const result = await enqueue(fixture, task, migrated);
  assert.equal(result.outcome, "queued");
  assert.notEqual(result.entry.status, "committed");
});

test("enqueue converges once the target also dropped the renamed source", async () => {
  const fixture = createFixture();
  const task = activateTask(createTask(
    fixture.store.nextTaskId(),
    "Rename task",
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
  const workItem = createWorkItem(
    fixture.store.nextWorkItemId(task.id),
    task.id,
    {
      title: "Rename old to new",
      acceptance: [],
      dependsOn: [],
      assignee: "leader",
      writeProjectIds: [fixture.project.id]
    },
    now
  );
  fixture.store.saveWorkItem(task.id, workItem);

  const captured = await captureRename(fixture, `yui/${task.id}/rename-gone`);
  const changeSet = createWorkItemChangeSet({
    id: "change-set-502",
    taskId: task.id,
    workItemId: workItem.id,
    projectId: fixture.project.id,
    baseCommit: fixture.baseCommit,
    headCommit: captured.headCommit,
    branch: `yui/${task.id}/rename-gone`,
    changedPaths: captured.changedPaths,
    manifest: createChangeSetManifest({
      tags: deriveManifestTags({
        changedPaths: captured.changedPaths,
        deletedPaths: captured.deletedPaths
      }),
      deletedPaths: captured.deletedPaths,
      targetRef: "master"
    })
  }, now);
  fixture.store.saveChangeSet(task.id, changeSet);

  // The target lands the same rename plus an unrelated tweak in one commit:
  // no target commit shares the Candidate tree, but every touched path agrees.
  git(["-C", fixture.repositoryPath, "mv", "src/old.ts", "src/new.ts"]);
  writeFileSync(join(fixture.repositoryPath, "base.txt"), "base changed\n");
  git(["-C", fixture.repositoryPath, "add", "-A"]);
  git(["-C", fixture.repositoryPath, "commit", "-m", "rename plus unrelated tweak"]);

  const result = await enqueue(fixture, task, changeSet);
  assert.equal(result.outcome, "converged");
  assert.equal(result.entry.status, "committed");
  assert.ok(result.entry.evidenceRefs[0]?.startsWith("tree-convergence:"));
});
