import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createProject } from "../dist/repository/project.js";
import { createTask, completeTask, archiveTask, activateTask } from "../dist/task/task.js";
import {
  planResourceGc,
  applyResourceGc,
  purgeResourceQuarantine
} from "../dist/resources/resourceGc.js";
import { loadResourceRegistry } from "../dist/resources/resourceRegistry.js";

const now = new Date("2026-08-17T00:00:00.000Z");

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}

function createGitRepo(root) {
  mkdirSync(root, { recursive: true });
  git(["init", "--bare", root], root);
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  git(["init", work], work);
  writeFileSync(join(work, "README.md"), "# test\n", "utf8");
  git(["add", "."], work);
  git(["commit", "-m", "initial"], work);
  git(["branch", "-M", "main"], work);
  git(["remote", "add", "origin", root], work);
  git(["push", "-u", "origin", "main"], work);
  return work;
}

function createHomeWithStore(root) {
  const home = join(root, "yui-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  ensureStorageSchema(home, now);
  const store = new FileTaskStore(home);
  return { home, store };
}

test("GC quarantines clean unreferenced worktree and purges after TTL", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-e2e-"));
  try {
    const repo = createGitRepo(join(root, "repo"));
    const { home, store } = createHomeWithStore(root);
    const project = createProject("project-1", "Test", repo, {
      stable: "main",
      development: "main"
    }, now, { ownership: "external" });
    store.transaction((tx) => tx.saveProject(project));
    const task = createTask("task-1", "Test task", now, { projectBindings: [{ projectId: project.id, directory: "repo", baseRef: "main" }] });
    store.transaction((tx) => tx.saveTask(task));
    store.transaction((tx) => {
      const active = activateTask(task, now);
      const completed = completeTask(active, now, { by: "user", summary: "done" });
      tx.saveTask(archiveTask(completed, now));
    });

    // Create a worktree for the task.
    const wtPath = join(root, "worktrees", "task-1", "main");
    mkdirSync(join(root, "worktrees", "task-1"), { recursive: true });
    git(["worktree", "add", wtPath, "-b", "yui/task-1-abcdef12/main"], repo);

    // Plan: should find the worktree as releasable (task archived, no refs).
    const plan = await planResourceGc({
      home,
      projects: store.listProjects(),
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now
    });
    const wtRecord = plan.records.find((r) => r.path === wtPath);
    assert.ok(wtRecord, "worktree should be discovered");
    assert.equal(wtRecord.disposition, "releasable");
    assert.equal(wtRecord.cleanliness, "clean");

    // Apply: quarantine the worktree.
    const result = await applyResourceGc(plan);
    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].disposition, "quarantined");
    assert.ok(!existsSync(wtPath), "worktree should be removed from original path");

    // Purge before TTL: should not delete.
    const earlyPurge = await purgeResourceQuarantine(home, {
      now: new Date(now.getTime() + 3600_000),
      ttlHours: 24
    });
    assert.equal(earlyPurge.purged.length, 0);

    // Purge after TTL: should delete.
    const latePurge = await purgeResourceQuarantine(home, {
      now: new Date(now.getTime() + 25 * 3600_000),
      ttlHours: 24
    });
    assert.equal(latePurge.purged.length, 1);
    assert.equal(latePurge.purged[0].disposition, "deleted");

    // Registry should record the deletion.
    const registry = loadResourceRegistry(home);
    const deleted = Object.values(registry.records).find(
      (r) => r.disposition === "deleted"
    );
    assert.ok(deleted, "deleted record should remain in registry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC retains dirty worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-dirty-"));
  try {
    const repo = createGitRepo(join(root, "repo"));
    const { home, store } = createHomeWithStore(root);
    const project = createProject("project-1", "Test", repo, {
      stable: "main",
      development: "main"
    }, now, { ownership: "external" });
    store.transaction((tx) => tx.saveProject(project));
    const task = createTask("task-1", "Test task", now, { projectBindings: [{ projectId: project.id, directory: "repo", baseRef: "main" }] });
    store.transaction((tx) => tx.saveTask(task));
    store.transaction((tx) => {
      const active = activateTask(task, now);
      const completed = completeTask(active, now, { by: "user", summary: "done" });
      tx.saveTask(archiveTask(completed, now));
    });

    const wtPath = join(root, "worktrees", "task-1", "main");
    mkdirSync(join(root, "worktrees", "task-1"), { recursive: true });
    git(["worktree", "add", wtPath, "-b", "yui/task-1-abcdef12/main"], repo);
    // Make it dirty.
    writeFileSync(join(wtPath, "uncommitted.txt"), "dirty\n", "utf8");

    const plan = await planResourceGc({
      home,
      projects: store.listProjects(),
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now
    });
    const wtRecord = plan.records.find((r) => r.path === wtPath);
    assert.ok(wtRecord);
    assert.equal(wtRecord.disposition, "retained-dirty");
    assert.ok(wtRecord.blocker?.includes("uncommitted"));

    // Apply should not quarantine it.
    const result = await applyResourceGc(plan);
    assert.equal(result.applied.length, 0);
    assert.ok(existsSync(wtPath), "dirty worktree should remain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC retains unattributed worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-unowned-"));
  try {
    const repo = createGitRepo(join(root, "repo"));
    const { home, store } = createHomeWithStore(root);
    const project = createProject("project-1", "Test", repo, {
      stable: "main",
      development: "main"
    }, now, { ownership: "external" });
    store.transaction((tx) => tx.saveProject(project));

    // Worktree with no task-N naming and no durable record.
    const wtPath = join(root, "worktrees", "scratch");
    mkdirSync(join(root, "worktrees"), { recursive: true });
    git(["worktree", "add", wtPath, "-b", "scratch"], repo);

    const plan = await planResourceGc({
      home,
      projects: store.listProjects(),
      managedWorkspaces: [],
      taskStatusById: new Map(),
      mode: "quarantine",
      now
    });
    const wtRecord = plan.records.find((r) => r.path === wtPath);
    assert.ok(wtRecord);
    assert.equal(wtRecord.disposition, "retained-unowned");

    const result = await applyResourceGc(plan);
    assert.equal(result.applied.length, 0);
    assert.ok(existsSync(wtPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC blocks on live process cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-live-"));
  try {
    const repo = createGitRepo(join(root, "repo"));
    const { home, store } = createHomeWithStore(root);
    const project = createProject("project-1", "Test", repo, {
      stable: "main",
      development: "main"
    }, now, { ownership: "external" });
    store.transaction((tx) => tx.saveProject(project));
    const task = createTask("task-1", "Test task", now, { projectBindings: [{ projectId: project.id, directory: "repo", baseRef: "main" }] });
    store.transaction((tx) => tx.saveTask(task));
    store.transaction((tx) => {
      const active = activateTask(task, now);
      const completed = completeTask(active, now, { by: "user", summary: "done" });
      tx.saveTask(archiveTask(completed, now));
    });

    const wtPath = join(root, "worktrees", "task-1", "main");
    mkdirSync(join(root, "worktrees", "task-1"), { recursive: true });
    git(["worktree", "add", wtPath, "-b", "yui/task-1-abcdef12/main"], repo);

    // Spawn a process with cwd inside the worktree.
    const proc = spawn("sleep", ["30"], { cwd: wtPath, detached: true });
    // Wait for the process to start.
    await new Promise((resolve) => setTimeout(resolve, 200));

    try {
      const plan = await planResourceGc({
        home,
        projects: store.listProjects(),
        managedWorkspaces: [],
        taskStatusById: new Map([["task-1", "archived"]]),
        mode: "quarantine",
        now
      });
      const wtRecord = plan.records.find((r) => r.path === wtPath);
      assert.ok(wtRecord);
      assert.equal(wtRecord.disposition, "active");
      assert.ok(wtRecord.activeRefs.length > 0);
      assert.ok(wtRecord.activeRefs.some((ref) => ref.startsWith("proc:cwd:")));

      const result = await applyResourceGc(plan);
      assert.equal(result.applied.length, 0);
      assert.ok(existsSync(wtPath));
    } finally {
      proc.kill("SIGKILL");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC is idempotent across repeated runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-idem-"));
  try {
    const repo = createGitRepo(join(root, "repo"));
    const { home, store } = createHomeWithStore(root);
    const project = createProject("project-1", "Test", repo, {
      stable: "main",
      development: "main"
    }, now, { ownership: "external" });
    store.transaction((tx) => tx.saveProject(project));
    const task = createTask("task-1", "Test task", now, { projectBindings: [{ projectId: project.id, directory: "repo", baseRef: "main" }] });
    store.transaction((tx) => tx.saveTask(task));
    store.transaction((tx) => {
      const active = activateTask(task, now);
      const completed = completeTask(active, now, { by: "user", summary: "done" });
      tx.saveTask(archiveTask(completed, now));
    });

    const wtPath = join(root, "worktrees", "task-1", "main");
    mkdirSync(join(root, "worktrees", "task-1"), { recursive: true });
    git(["worktree", "add", wtPath, "-b", "yui/task-1-abcdef12/main"], repo);

    const input = {
      home,
      projects: store.listProjects(),
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now
    };

    // First run: quarantine.
    const plan1 = await planResourceGc(input);
    const result1 = await applyResourceGc(plan1);
    assert.equal(result1.applied.length, 1);

    // Second run: should not re-quarantine (already quarantined).
    const plan2 = await planResourceGc(input);
    const result2 = await applyResourceGc(plan2);
    assert.equal(result2.applied.length, 0);

    // Git metadata should not be corrupted.
    const worktrees = git(["worktree", "list", "--porcelain"], repo);
    assert.ok(!worktrees.includes(wtPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC restores quarantined runtime artifact when new reference appears", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-restore-"));
  try {
    const { home, store } = createHomeWithStore(root);
    const task = createTask("task-1", "Test task", now);
    store.transaction((tx) => tx.saveTask(task));
    store.transaction((tx) => {
      const active = activateTask(task, now);
      const completed = completeTask(active, now, { by: "user", summary: "done" });
      tx.saveTask(archiveTask(completed, now));
    });

    // Create a legacy deployment directory (non-Git artifact).
    const depPath = join(home, "runtime", "deployments", "combined-task1-abc123-20260817");
    mkdirSync(depPath, { recursive: true });
    writeFileSync(join(depPath, "file.txt"), "content\n", "utf8");

    // Quarantine first.
    const plan1 = await planResourceGc({
      home,
      projects: [],
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now
    });
    await applyResourceGc(plan1);
    assert.ok(!existsSync(depPath));

    // Reopen the task (simulate a new reference).
    store.transaction((tx) => tx.saveTask(activateTask(task, now)));

    // Plan again: the quarantined resource should be restored.
    const plan2 = await planResourceGc({
      home,
      projects: [],
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "active"]]),
      mode: "quarantine",
      now
    });
    // The restored record should be active.
    const restored = plan2.records.find((r) => r.path === depPath);
    assert.ok(restored);
    assert.equal(restored.disposition, "active");
    assert.ok(existsSync(depPath), "deployment should be restored");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
