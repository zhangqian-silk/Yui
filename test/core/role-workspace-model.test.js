import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import {
  createRoleWorkspace,
  managedWorktreeName,
  validateRoleWorkspace
} from "../../dist/worktree/roleWorkspace.js";
import { worktreeIdentity } from "../../dist/repository/gitWorkspace.js";

const NOW = new Date("2026-07-20T12:00:00.000Z");

test("managed worktree records Task or WorkItem ownership independently from Role", () => {
  const path = join(process.cwd(), "worktree", "Yui", "task-1", "work-1");
  const workspace = createRoleWorkspace({
    taskId: "task-1",
    roleName: "worker",
    owner: { type: "work-item", workItemId: "work-1" },
    projectId: "project-1",
    path,
    branch: "yui/task-1/work-1",
    baseRef: "main",
    baseCommit: "0123456789abcdef0123456789abcdef01234567"
  }, NOW);

  assert.equal(workspace.schemaVersion, 2);
  assert.deepEqual(workspace.owner, { type: "work-item", workItemId: "work-1" });
  assert.equal(managedWorktreeName(workspace.owner), "work-1");
  assert.equal(validateRoleWorkspace(workspace), workspace);
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
