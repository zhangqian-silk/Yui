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
import { dirname, join } from "node:path";
import test from "node:test";

import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createProject } from "../dist/repository/project.js";
import { createTask, completeTask, archiveTask, activateTask } from "../dist/task/task.js";
import {
  planResourceGc,
  applyResourceGc,
  purgeResourceQuarantine,
  restoreAllResourceGc
} from "../dist/resources/resourceGc.js";
import { runAutoResourceGc } from "../dist/resources/autoResourceGc.js";
import {
  emptyResourceRegistry,
  loadResourceRegistry,
  saveResourceRegistry,
  upsertResourceRecord
} from "../dist/resources/resourceRegistry.js";
import { createResourceRecord } from "../dist/resources/resourceTypes.js";
import { writeRuntimeIdentity } from "../dist/release/runtimeRelease.js";
import { readLinuxProcessStartIdentity } from "../dist/controller/domainIdentity.js";
import {
  createExactTaskRuntimeDescriptor,
  exactTaskRuntimeDescriptorPath,
  serializeExactDescriptor
} from "../dist/runtime/exactControlPlane.js";

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
    const gcInput = {
      home,
      projects: store.listProjects(),
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now
    };
    const plan = await planResourceGc(gcInput);
    const wtRecord = plan.records.find((r) => r.path === wtPath);
    assert.ok(wtRecord, "worktree should be discovered");
    assert.equal(wtRecord.disposition, "releasable");
    assert.equal(wtRecord.cleanliness, "clean");

    // Apply: quarantine the worktree.
    const result = await applyResourceGc(gcInput, plan);
    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].disposition, "quarantined");
    assert.ok(!existsSync(wtPath), "worktree should be removed from original path");
    assert.ok(existsSync(result.applied[0].quarantine.path), "worktree should be moved to quarantine");

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
    assert.ok(!existsSync(result.applied[0].quarantine.path), "quarantined worktree should be removed");
    assert.ok(!git(["worktree", "list", "--porcelain"], repo).includes(result.applied[0].quarantine.path));

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

    const gcInput = {
      home,
      projects: store.listProjects(),
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now
    };
    const plan = await planResourceGc(gcInput);
    const wtRecord = plan.records.find((r) => r.path === wtPath);
    assert.ok(wtRecord);
    assert.equal(wtRecord.disposition, "retained-dirty");
    assert.ok(wtRecord.blocker?.includes("uncommitted"));

    // Apply should not quarantine it.
    const result = await applyResourceGc(gcInput, plan);
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

    const gcInput = {
      home,
      projects: store.listProjects(),
      managedWorkspaces: [],
      taskStatusById: new Map(),
      mode: "quarantine",
      now
    };
    const plan = await planResourceGc(gcInput);
    const wtRecord = plan.records.find((r) => r.path === wtPath);
    assert.ok(wtRecord);
    assert.equal(wtRecord.disposition, "retained-unowned");

    const result = await applyResourceGc(gcInput, plan);
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
      const gcInput = {
        home,
        projects: store.listProjects(),
        managedWorkspaces: [],
        taskStatusById: new Map([["task-1", "archived"]]),
        mode: "quarantine",
        now
      };
      const plan = await planResourceGc(gcInput);
      const wtRecord = plan.records.find((r) => r.path === wtPath);
      assert.ok(wtRecord);
      assert.equal(wtRecord.disposition, "active");
      assert.ok(wtRecord.activeRefs.length > 0);
      assert.ok(wtRecord.activeRefs.some((ref) => ref.startsWith("proc:cwd:")));

      const result = await applyResourceGc(gcInput, plan);
      assert.equal(result.applied.length, 0);
      assert.ok(existsSync(wtPath));
    } finally {
      proc.kill("SIGKILL");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC retains candidates when a live-reference source fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-tmux-fail-"));
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

    const gcInput = {
      home,
      projects: store.listProjects(),
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now,
      liveReferencePorts: {
        tmuxPaneCwds: async () => {
          throw new Error("tmux namespace unavailable");
        }
      }
    };
    const plan = await planResourceGc(gcInput);
    const wtRecord = plan.records.find((record) => record.path === wtPath);
    assert.ok(wtRecord);
    assert.equal(wtRecord.disposition, "retained-unproven");
    assert.ok(plan.scan.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
    const result = await applyResourceGc(gcInput, plan);
    assert.equal(result.applied.length, 0);
    assert.ok(existsSync(wtPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC protects runtime identity resolved paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-runtime-identity-"));
  try {
    const { home, store } = createHomeWithStore(root);
    const task = createTask("task-1", "Test task", now);
    store.transaction((tx) => tx.saveTask(task));
    store.transaction((tx) => {
      const active = activateTask(task, now);
      const completed = completeTask(active, now, { by: "user", summary: "done" });
      tx.saveTask(archiveTask(completed, now));
    });
    const deployment = join(home, "runtime", "deployments", "combined-active");
    mkdirSync(deployment, { recursive: true });
    writeRuntimeIdentity(home, {
      schemaVersion: 1,
      version: "0.0.0",
      executablePath: process.execPath,
      args: [process.execPath, "controller"],
      buildId: "dev",
      packageDigest: null,
      sourceCommit: null,
      cliRealpath: deployment,
      controllerRealpath: deployment,
      controllerProtocolVersion: 1,
      storageLayoutVersion: 7,
      aggregateSchemaVersion: 18,
      storageBackend: "file",
      workerEnabled: false,
      pid: process.pid,
      processStartIdentity: readLinuxProcessStartIdentity(process.pid) ?? "missing",
      mode: "primary",
      dualOwner: false,
      activeRelease: null,
      writtenAt: now.toISOString()
    });

    const plan = await planResourceGc({
      home,
      projects: [],
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now,
      liveReferencePorts: {
        processCwdRefs: () => new Map(),
        tmuxPaneCwds: async () => []
      }
    });
    const record = plan.records.find((candidate) => candidate.path === deployment);
    assert.ok(record);
    assert.equal(record.disposition, "active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC protects the workspace named by an exact Task descriptor", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-exact-descriptor-"));
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
    const descriptor = createExactTaskRuntimeDescriptor({
      controlPlaneDigest: "a".repeat(64),
      taskId: "task-1",
      roleName: "worker",
      agentId: "agent-1",
      adapterId: "codex",
      workspace: wtPath
    });
    const descriptorPath = exactTaskRuntimeDescriptorPath(home, descriptor);
    mkdirSync(dirname(descriptorPath), { recursive: true, mode: 0o700 });
    writeFileSync(descriptorPath, `${serializeExactDescriptor(descriptor)}\n`, "utf8");

    const plan = await planResourceGc({
      home,
      projects: store.listProjects(),
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now,
      liveReferencePorts: {
        processCwdRefs: () => new Map(),
        tmuxPaneCwds: async () => []
      }
    });
    const record = plan.records.find((candidate) => candidate.path === wtPath);
    assert.ok(record);
    assert.equal(record.disposition, "active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC fails closed when the active release pointer is unreadable", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-active-release-corrupt-"));
  try {
    const { home, store } = createHomeWithStore(root);
    const task = createTask("task-1", "Test task", now);
    store.transaction((tx) => tx.saveTask(task));
    store.transaction((tx) => {
      const active = activateTask(task, now);
      const completed = completeTask(active, now, { by: "user", summary: "done" });
      tx.saveTask(archiveTask(completed, now));
    });
    mkdirSync(join(home, "runtime"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "runtime", "active-release.json"), "{not-json", "utf8");
    const deployment = join(home, "runtime", "deployments", "combined-task1-corrupt");
    mkdirSync(deployment, { recursive: true });
    const input = {
      home,
      projects: [],
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now,
      liveReferencePorts: {
        processCwdRefs: () => new Map(),
        tmuxPaneCwds: async () => []
      }
    };
    const plan = await planResourceGc(input);
    assert.ok(plan.scan.diagnostics.some((diagnostic) =>
      diagnostic.severity === "error"
        && diagnostic.message.includes("active release is unreadable")));
    const candidate = plan.records.find((record) => record.path === deployment);
    assert.ok(candidate);
    assert.equal(candidate.disposition, "retained-unproven");
    const result = await applyResourceGc(input, plan);
    assert.equal(result.applied.length, 0);
    assert.ok(existsSync(deployment));
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
    const result1 = await applyResourceGc(input, plan1);
    assert.equal(result1.applied.length, 1);

    // Second run: should not re-quarantine (already quarantined).
    const plan2 = await planResourceGc(input);
    const result2 = await applyResourceGc(input, plan2);
    assert.equal(result2.applied.length, 0);

    // Git metadata should not be corrupted.
    const worktrees = git(["worktree", "list", "--porcelain"], repo);
    assert.ok(!worktrees.includes(wtPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC move-quarantine restores a Git worktree at its recorded HEAD", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-git-restore-"));
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
    git(["worktree", "add", "--detach", wtPath], repo);
    const recordedHead = git(["-C", wtPath, "rev-parse", "HEAD^{commit}"], wtPath);
    const newerHead = git(["-C", repo, "commit-tree", `${recordedHead}^{tree}`, "-p", recordedHead, "-m", "newer"], repo);

    const input = {
      home,
      projects: store.listProjects(),
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now,
      liveReferencePorts: {
        processCwdRefs: () => new Map(),
        tmuxPaneCwds: async () => []
      }
    };
    const applied = await applyResourceGc(input, await planResourceGc(input));
    assert.equal(applied.applied.length, 1);
    assert.equal(applied.applied[0].quarantine.method, "move");
    assert.ok(!existsSync(wtPath));

    // A branch/ref can advance while the worktree is quarantined; restore must
    // preserve the exact checkout that was quarantined.
    git(["-C", repo, "update-ref", "refs/heads/yui/task-1-newer", newerHead], repo);
    const restored = await restoreAllResourceGc(home, { now });
    assert.equal(restored.restored.length, 1);
    assert.ok(existsSync(wtPath));
    assert.equal(git(["-C", wtPath, "rev-parse", "HEAD^{commit}"], wtPath), recordedHead);
    assert.ok(git(["worktree", "list", "--porcelain"], repo).includes(wtPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC retries restore after a cleanup failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-restore-retry-"));
  try {
    const { home, store } = createHomeWithStore(root);
    const task = createTask("task-1", "Test task", now);
    store.transaction((tx) => tx.saveTask(task));
    store.transaction((tx) => {
      const active = activateTask(task, now);
      const completed = completeTask(active, now, { by: "user", summary: "done" });
      tx.saveTask(archiveTask(completed, now));
    });
    const artifact = join(home, "runtime", "deployments", "combined-task1-retry");
    mkdirSync(artifact, { recursive: true });
    const input = {
      home,
      projects: [],
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now
    };
    await applyResourceGc(input, await planResourceGc(input));
    assert.ok(!existsSync(artifact));

    mkdirSync(artifact, { recursive: true });
    const failed = await restoreAllResourceGc(home, { now });
    assert.equal(failed.failed.length, 1);
    assert.equal(failed.failed[0].disposition, "cleanup-failed");
    assert.ok(failed.failed[0].blocker?.includes("already exists"));

    rmSync(artifact, { recursive: true, force: true });
    const retried = await restoreAllResourceGc(home, { now });
    assert.equal(retried.restored.length, 1);
    assert.ok(existsSync(artifact));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC discovers registry-only resources that still exist", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-registry-only-"));
  try {
    const { home, store } = createHomeWithStore(root);
    const task = createTask("task-1", "Test task", now);
    store.transaction((tx) => tx.saveTask(task));
    store.transaction((tx) => {
      const active = activateTask(task, now);
      const completed = completeTask(active, now, { by: "user", summary: "done" });
      tx.saveTask(archiveTask(completed, now));
    });
    const runtimeRoot = join(root, "yi-runtime-only");
    mkdirSync(runtimeRoot, { recursive: true });
    const record = createResourceRecord({
      kind: "runtime-artifact",
      path: runtimeRoot,
      owner: { home, taskId: "task-1", basis: "marker" },
      cleanliness: "n/a",
      activeRefs: [],
      disposition: "active"
    }, now);
    saveResourceRegistry(home, upsertResourceRecord(emptyResourceRegistry(), record));

    const input = {
      home,
      projects: [],
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now
    };
    const plan = await planResourceGc(input);
    const planned = plan.records.find((candidate) => candidate.path === runtimeRoot);
    assert.ok(planned);
    assert.equal(planned.disposition, "releasable");
    const applied = await applyResourceGc(input, plan);
    assert.equal(applied.applied.length, 1);
    assert.ok(!existsSync(runtimeRoot));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC protects workspaces claimed by an active AgentRun Job", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-active-job-"));
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
    git(["worktree", "add", wtPath, "-b", "yui/task-1-job/main"], repo);

    // An active AgentRun still claims this workspace path.
    const input = {
      home,
      projects: store.listProjects(),
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now,
      activeWorkspaceOwnerPaths: [wtPath],
      liveReferencePorts: {
        processCwdRefs: () => new Map(),
        tmuxPaneCwds: async () => []
      }
    };
    const plan = await planResourceGc(input);
    const record = plan.records.find((candidate) => candidate.path === wtPath);
    assert.ok(record);
    assert.equal(record.disposition, "active");
    const result = await applyResourceGc(input, plan);
    assert.equal(result.applied.length, 0);
    assert.ok(existsSync(wtPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC purge fails closed when a live-reference source is untrusted", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-purge-failclosed-"));
  try {
    const { home, store } = createHomeWithStore(root);
    const task = createTask("task-1", "Test task", now);
    store.transaction((tx) => tx.saveTask(task));
    store.transaction((tx) => {
      const active = activateTask(task, now);
      const completed = completeTask(active, now, { by: "user", summary: "done" });
      tx.saveTask(archiveTask(completed, now));
    });
    const artifact = join(home, "runtime", "deployments", "combined-task1-purge");
    mkdirSync(artifact, { recursive: true });
    const input = {
      home,
      projects: [],
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now
    };
    await applyResourceGc(input, await planResourceGc(input));
    assert.ok(!existsSync(artifact));

    // After the TTL, a scan with an untrusted source must not purge.
    const later = new Date(now.getTime() + 25 * 3_600_000);
    const purge = await purgeResourceQuarantine(home, {
      now: later,
      ttlHours: 24,
      managedWorkspaces: [],
      liveReferencePorts: {
        processCwdRefs: () => new Map(),
        tmuxPaneCwds: async () => {
          throw new Error("tmux namespace unavailable");
        }
      }
    });
    assert.equal(purge.purged.length, 0);
    const registry = loadResourceRegistry(home);
    const record = Object.values(registry.records).find((candidate) => candidate.path === artifact);
    assert.ok(record);
    assert.equal(record.disposition, "quarantined");
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
    const gcInput1 = {
      home,
      projects: [],
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now
    };
    await applyResourceGc(gcInput1, await planResourceGc(gcInput1));
    assert.ok(!existsSync(depPath));

    // Reopen the task (simulate a new reference).
    store.transaction((tx) => tx.saveTask(activateTask(task, now)));

    // Plan + apply: the quarantined resource should be restored.
    const gcInput2 = {
      home,
      projects: [],
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "active"]]),
      mode: "quarantine",
      now
    };
    const plan2 = await planResourceGc(gcInput2);
    const result2 = await applyResourceGc(gcInput2, plan2);
    // The restored record should be active.
    const restored = result2.restored.find((r) => r.path === depPath);
    assert.ok(restored);
    assert.equal(restored.disposition, "active");
    assert.ok(existsSync(depPath), "deployment should be restored");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC dry-run never writes the registry or moves files", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-dryrun-"));
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

    const registryPath = join(home, "runtime", "resource-registry", "registry.json");
    const gcInput = {
      home,
      projects: store.listProjects(),
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "report",
      now
    };

    // Dry-run: no registry file should be created.
    const plan = await planResourceGc(gcInput);
    assert.ok(plan.records.length > 0, "plan should discover resources");
    assert.ok(!existsSync(registryPath), "dry-run must not create the registry file");
    assert.ok(existsSync(wtPath), "dry-run must not move the worktree");

    // Apply in report mode: also no writes.
    const result = await applyResourceGc(gcInput, plan);
    assert.equal(result.applied.length, 0);
    assert.ok(!existsSync(registryPath), "report apply must not create the registry file");
    assert.ok(existsSync(wtPath), "report apply must not move the worktree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC retains worktree with unknown cleanliness", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-unknown-"));
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

    // Create a worktree and then make git status fail by removing .git
    const wtPath = join(root, "worktrees", "task-1", "main");
    mkdirSync(join(root, "worktrees", "task-1"), { recursive: true });
    git(["worktree", "add", wtPath, "-b", "yui/task-1-abcdef12/main"], repo);

    // Corrupt the worktree's .git pointer so Git still enumerates it but
    // `git status` can no longer prove its state. GC must retain it.
    writeFileSync(join(wtPath, ".git"), "gitdir: /nonexistent/yui-gc-gitdir\n", "utf8");

    const gcInput = {
      home,
      projects: store.listProjects(),
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now
    };
    const plan = await planResourceGc(gcInput);
    const wtRecord = plan.records.find((r) => r.path === wtPath);
    assert.ok(wtRecord);
    assert.equal(wtRecord.cleanliness, "unknown");
    assert.equal(wtRecord.disposition, "retained-unproven");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC restore-all returns quarantined resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-restore-all-"));
  try {
    const { home, store } = createHomeWithStore(root);
    const task = createTask("task-1", "Test task", now);
    store.transaction((tx) => tx.saveTask(task));
    store.transaction((tx) => {
      const active = activateTask(task, now);
      const completed = completeTask(active, now, { by: "user", summary: "done" });
      tx.saveTask(archiveTask(completed, now));
    });

    const depPath = join(home, "runtime", "deployments", "combined-task1-abc123-20260817");
    mkdirSync(depPath, { recursive: true });
    writeFileSync(join(depPath, "file.txt"), "content\n", "utf8");

    const gcInput = {
      home,
      projects: [],
      managedWorkspaces: [],
      taskStatusById: new Map([["task-1", "archived"]]),
      mode: "quarantine",
      now
    };
    await applyResourceGc(gcInput, await planResourceGc(gcInput));
    assert.ok(!existsSync(depPath));

    // Restore-all should bring it back.
    const result = await restoreAllResourceGc(home, { now });
    assert.equal(result.restored.length, 1);
    assert.ok(existsSync(depPath), "deployment should be restored");
    assert.equal(result.restored[0].disposition, "active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GC auto-quarantine defaults to off", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-gc-auto-off-"));
  try {
    const { home, store } = createHomeWithStore(root);
    const task = createTask("task-1", "Test task", now);
    store.transaction((tx) => tx.saveTask(task));
    store.transaction((tx) => {
      const active = activateTask(task, now);
      const completed = completeTask(active, now, { by: "user", summary: "done" });
      tx.saveTask(archiveTask(completed, now));
    });

    const depPath = join(home, "runtime", "deployments", "combined-task1-abc123-20260817");
    mkdirSync(depPath, { recursive: true });
    writeFileSync(join(depPath, "file.txt"), "content\n", "utf8");

    // Auto-GC with default config should skip.
    const result = await runAutoResourceGc(store, { now });
    assert.equal(result.ran, false);
    assert.ok(existsSync(depPath), "auto-GC must not quarantine when disabled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
