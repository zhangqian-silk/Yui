import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runTaskUpstreamCommand } from "../../dist/commands/taskUpstreamCommands.js";
import { createProject } from "../../dist/repository/project.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createAgentRun } from "../../dist/run/agentRun.js";

const now = new Date("2026-08-27T00:00:00.000Z");
const baseCommit = "a".repeat(40);
const upstreamCommit = "b".repeat(40);
const mergeCommit = "c".repeat(40);
const effective = {
  schemaVersion: 2,
  sourceDesiredRevision: 1,
  agentId: "agent",
  adapterId: "codex",
  profileAccess: "write",
  search: false,
  permission: { strategy: "default" },
  writeProjectIds: [],
  workspace: { root: "/tmp/yui-upstream-test", entries: [] },
  context: {}
};

function configuredStore(t, projectIds) {
  const home = mkdtempSync(join(tmpdir(), "yui-upstream-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  for (const projectId of projectIds) {
    store.saveProject(createProject(
      projectId,
      `${projectId}-name`,
      join(home, projectId),
      { stable: "main", development: "main" },
      now,
      { remoteUrl: `https://example.com/${projectId}.git` }
    ));
  }
  return store;
}

function activeTaskWithWorkspace(store, taskId, projectIds) {
  const task = activateTask(createTask(taskId, "upstream test", now, {
    type: "feature",
    projectBindings: projectIds.map((projectId) => ({
      projectId,
      directory: projectId,
      baseRef: "main"
    }))
  }), now);
  store.saveTask(task);
  const workspaceRoot = join(store.rootDirectory(), "workspace", taskId);
  store.saveManagedWorkspace({
    schemaVersion: 2,
    owner: { type: "task", taskId },
    root: workspaceRoot,
    entries: projectIds.map((projectId) => ({
      projectId,
      directory: projectId,
      access: "write",
      path: join(workspaceRoot, projectId),
      branch: taskId,
      baseRef: "main",
      baseCommit
    })),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  });
  return task;
}

/**
 * Mock GitWorkspacePort that tracks HEAD per path so mergeWorktree simulates
 * a --no-ff merge commit.  mergeFailures lists paths whose merge throws.
 */
function createMockGit({ mergeFailures = [] } = {}) {
  const heads = new Map();
  return {
    async resolveRemoteBaseline() {
      return { branch: "main", commit: upstreamCommit };
    },
    async inspect(path) {
      return {
        root: path,
        gitDirectory: join(path, ".git"),
        baseRef: "HEAD",
        baseCommit: heads.get(path) ?? baseCommit
      };
    },
    async mergeWorktree({ targetPath }) {
      if (mergeFailures.includes(targetPath)) {
        throw new Error(`Simulated merge conflict in ${targetPath}.`);
      }
      heads.set(targetPath, mergeCommit);
    },
    async resetWorktree({ targetPath, expectedHead, restoreHead }) {
      const current = heads.get(targetPath) ?? baseCommit;
      if (current !== expectedHead) {
        throw new Error(`Git reset target changed before compensation: ${targetPath} (${current}).`);
      }
      heads.set(targetPath, restoreHead);
    }
  };
}

test("upstream integrate records the actual merge commit HEAD, not the upstream commit", async () => {
  const store = configuredStore(test, ["project-1"]);
  activeTaskWithWorkspace(store, "task-1", ["project-1"]);
  const git = createMockGit();
  const result = await runTaskUpstreamCommand(
    ["integrate", "task-1", "--latest"],
    store,
    { git, now: () => now }
  );
  const integration = result.data.integrations[0];
  // mergeWorktree always creates a --no-ff merge commit; the recorded newHead
  // must be the actual HEAD (mergeCommit), not upstreamCommit.
  assert.equal(integration.newHead, mergeCommit);
  assert.notEqual(integration.newHead, upstreamCommit);
  const events = store.listEvents("task-1").filter((e) => e.type === "task.upstream-integrated");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.newHead, mergeCommit);
});

test("upstream integrate records each Project's event before a later Project fails", async () => {
  const store = configuredStore(test, ["project-1", "project-2"]);
  activeTaskWithWorkspace(store, "task-2", ["project-1", "project-2"]);
  const workspace = store.getTaskWorkspace("task-2");
  const failingPath = workspace.entries.find((e) => e.projectId === "project-2").path;
  const git = createMockGit({ mergeFailures: [failingPath] });
  await assert.rejects(
    () => runTaskUpstreamCommand(["integrate", "task-2", "--latest"], store, { git, now: () => now }),
    /Upstream integration failed for Project project-2/
  );
  // Project 1 merged successfully before Project 2 failed; its event must be
  // durable even though the overall command threw.
  const events = store.listEvents("task-2").filter((e) => e.type === "task.upstream-integrated");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.projectId, "project-1");
  assert.equal(events[0].payload.newHead, mergeCommit);
});

test("upstream integrate refuses while the Leader has an active Run", async () => {
  const store = configuredStore(test, ["project-1"]);
  activeTaskWithWorkspace(store, "task-3", ["project-1"]);
  const activeRun = createAgentRun(
    "agent-run-1",
    "task-3",
    "leader",
    "new",
    "active delivery",
    now,
    { effective }
  );
  store.saveActiveAgentRun(activeRun);
  const git = createMockGit();
  await assert.rejects(
    () => runTaskUpstreamCommand(["integrate", "task-3", "--latest"], store, { git, now: () => now }),
    /active Leader Run/
  );
  // No merge happened and no event was recorded.
  const events = store.listEvents("task-3").filter((e) => e.type === "task.upstream-integrated");
  assert.equal(events.length, 0);
});

test("upstream integrate restore path reports honest status on merge failure", async () => {
  const store = configuredStore(test, ["project-1"]);
  activeTaskWithWorkspace(store, "task-4", ["project-1"]);
  const workspace = store.getTaskWorkspace("task-4");
  const entryPath = workspace.entries[0].path;
  const git = createMockGit({ mergeFailures: [entryPath] });
  // The mock mergeWorktree throws without moving HEAD (like a conflict that
  // merge --abort cleaned up), so resetWorktree succeeds and the message says
  // the workspace was restored.
  await assert.rejects(
    () => runTaskUpstreamCommand(["integrate", "task-4", "--latest"], store, { git, now: () => now }),
    /workspace has been restored/
  );
});
