import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import {
  createManagedWorkspace,
  managedWorktreeName,
  validateManagedWorkspace
} from "../../dist/worktree/managedWorkspace.js";
import { worktreeIdentity } from "../../dist/repository/gitWorkspace.js";

const NOW = new Date("2026-07-20T12:00:00.000Z");

test("managed workspace records a root with per-Project read and write entries", () => {
  const root = join(process.cwd(), "tasks", "task-1", "work-items", "work-1");
  const backend = join(process.cwd(), "worktree", "backend", "task-1", "work-1");
  const frontend = join(process.cwd(), "worktree", "frontend", "task-1", "main");
  const workspace = createManagedWorkspace({
    owner: { type: "work-item", taskId: "task-1", workItemId: "work-1" },
    root,
    entries: [
      {
        projectId: "project-1",
        directory: "backend",
        access: "write",
        path: backend,
        branch: "yui/task-1/work-1",
        baseRef: "main",
        baseCommit: "0123456789abcdef0123456789abcdef01234567"
      },
      {
        projectId: "project-2",
        directory: "frontend",
        access: "read",
        path: frontend,
        branch: "yui/task-1/main",
        baseRef: "main",
        baseCommit: "fedcba9876543210fedcba9876543210fedcba98"
      }
    ]
  }, NOW);

  assert.equal(workspace.schemaVersion, 1);
  assert.deepEqual(workspace.owner, {
    type: "work-item",
    taskId: "task-1",
    workItemId: "work-1"
  });
  assert.equal(workspace.root, root);
  assert.deepEqual(workspace.entries.map(({ projectId, access }) => ({ projectId, access })), [
    { projectId: "project-1", access: "write" },
    { projectId: "project-2", access: "read" }
  ]);
  assert.equal(managedWorktreeName(workspace.owner), "work-1");
  assert.equal(validateManagedWorkspace(workspace), workspace);
});

test("worktree identity is deterministic per Task and lifecycle owner", () => {
  assert.deepEqual(worktreeIdentity("task-1", "main"), {
    directory: join("task-1", "main"),
    branch: "yui/task-1/main"
  });
  assert.throws(() => worktreeIdentity("task-1", "../worker"), /Role name is invalid/);
});

test("owner identities remain usable when Git cannot use them as ref segments", () => {
  const first = worktreeIdentity("task-1", "review role@{one}");
  const second = worktreeIdentity("task-1", "review role@{one}");
  assert.match(first.branch, /^yui\/task-1\/encoded-[a-f0-9]{24}$/);
  assert.deepEqual(second, first);
  assert.doesNotThrow(() => execFileSync("git", ["check-ref-format", "--branch", first.branch]));
});
