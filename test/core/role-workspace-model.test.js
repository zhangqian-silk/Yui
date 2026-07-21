import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import {
  createRoleWorkspace,
  validateRoleWorkspace
} from "../../dist/worktree/roleWorkspace.js";
import { worktreeIdentity } from "../../dist/repository/gitWorkspace.js";

const NOW = new Date("2026-07-20T12:00:00.000Z");

test("RoleWorkspace records the minimal durable Role worktree identity", () => {
  const path = join(process.cwd(), "worktrees", "task-1", "worker");
  const workspace = createRoleWorkspace({
    taskId: "task-1",
    roleName: "worker",
    repositoryId: "repository-1",
    path,
    branch: "yui/task-1/worker",
    baseRef: "main",
    baseCommit: "0123456789abcdef0123456789abcdef01234567"
  }, NOW);

  assert.deepEqual(workspace, {
    schemaVersion: 1,
    taskId: "task-1",
    roleName: "worker",
    repositoryId: "repository-1",
    path,
    branch: "yui/task-1/worker",
    baseRef: "main",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  });
  assert.equal(validateRoleWorkspace(workspace), workspace);
});

test("Role worktree identity is deterministic per Task and Role", () => {
  assert.deepEqual(worktreeIdentity("task-1", "worker"), {
    directory: join("task-1", "worker"),
    branch: "yui/task-1/worker"
  });
  assert.throws(() => worktreeIdentity("task-1", "../worker"), /Role name is invalid/);
});

test("Role names remain usable when Git cannot use them as ref segments", () => {
  const first = worktreeIdentity("task-1", "review role@{one}");
  const second = worktreeIdentity("task-1", "review role@{one}");

  assert.equal(first.directory, join("task-1", "review role@{one}"));
  assert.match(first.branch, /^yui\/task-1\/encoded-[a-f0-9]{24}$/);
  assert.deepEqual(second, first);
  assert.doesNotThrow(() => execFileSync("git", ["check-ref-format", "--branch", first.branch]));
});
