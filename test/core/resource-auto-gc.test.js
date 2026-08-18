import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileTaskController } from "../../dist/controller/controller.js";
import { createResourceAutoGc } from "../../dist/resources/autoResourceGc.js";
import { scanLiveReferences } from "../../dist/resources/liveReferences.js";
import { loadResourceRegistry } from "../../dist/resources/resourceRegistry.js";
import { createProject } from "../../dist/repository/project.js";
import { readLinuxProcessStartIdentity } from "../../dist/controller/domainIdentity.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import {
  activateTask,
  archiveTask,
  completeTask,
  createTask
} from "../../dist/task/task.js";

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

function archivedTaskProject(store, repo) {
  const project = createProject("project-1", "Test", repo, {
    stable: "main",
    development: "main"
  }, now, { ownership: "external" });
  store.transaction((tx) => tx.saveProject(project));
  const task = createTask("task-1", "Test task", now, {
    projectBindings: [{ projectId: project.id, directory: "repo", baseRef: "main" }]
  });
  store.transaction((tx) => tx.saveTask(task));
  store.transaction((tx) => {
    const active = activateTask(task, now);
    const completed = completeTask(active, now, { by: "user", summary: "done" });
    tx.saveTask(archiveTask(completed, now));
  });
  return { project, task };
}

test("auto GC hook self-skips in report mode (default)", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-auto-gc-report-"));
  try {
    const repo = createGitRepo(join(root, "repo"));
    const { home, store } = createHomeWithStore(root);
    archivedTaskProject(store, repo);

    const outcome = await createResourceAutoGc({ home, store })();
    assert.equal(outcome.skipped, true);
    assert.equal(outcome.applied, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto GC hook self-skips in quarantine mode when auto-quarantine is off", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-auto-gc-off-"));
  try {
    const repo = createGitRepo(join(root, "repo"));
    const { home, store } = createHomeWithStore(root);
    archivedTaskProject(store, repo);
    store.transaction((tx) => tx.saveConfig({ ...tx.getConfig(), resourcesGcMode: "quarantine" }));

    const outcome = await createResourceAutoGc({ home, store })();
    assert.equal(outcome.skipped, true);
    assert.equal(outcome.applied, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto GC hook quarantines a terminal Task clean worktree when opted in", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-auto-gc-apply-"));
  try {
    const repo = createGitRepo(join(root, "repo"));
    const { home, store } = createHomeWithStore(root);
    archivedTaskProject(store, repo);
    store.transaction((tx) => tx.saveConfig({
      ...tx.getConfig(),
      resourcesGcMode: "quarantine",
      resourcesGcAutoQuarantine: true
    }));

    const wtPath = join(root, "worktrees", "task-1", "main");
    mkdirSync(join(root, "worktrees", "task-1"), { recursive: true });
    git(["worktree", "add", wtPath, "-b", "yui/task-1-abcdef12/main"], repo);

    const outcome = await createResourceAutoGc({ home, store })();
    assert.equal(outcome.skipped, false);
    assert.equal(outcome.applied, 1);
    assert.equal(outcome.failed, 0);
    assert.ok(!existsSync(wtPath), "worktree should be quarantined");

    const registry = loadResourceRegistry(home);
    const quarantined = Object.values(registry.records).find(
      (record) => record.disposition === "quarantined"
    );
    assert.ok(quarantined, "registry should hold the quarantine receipt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto GC hook retains a dirty worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-auto-gc-dirty-"));
  try {
    const repo = createGitRepo(join(root, "repo"));
    const { home, store } = createHomeWithStore(root);
    archivedTaskProject(store, repo);
    store.transaction((tx) => tx.saveConfig({
      ...tx.getConfig(),
      resourcesGcMode: "quarantine",
      resourcesGcAutoQuarantine: true
    }));

    const wtPath = join(root, "worktrees", "task-1", "main");
    mkdirSync(join(root, "worktrees", "task-1"), { recursive: true });
    git(["worktree", "add", wtPath, "-b", "yui/task-1-abcdef12/main"], repo);
    writeFileSync(join(wtPath, "uncommitted.txt"), "dirty\n", "utf8");

    const outcome = await createResourceAutoGc({ home, store })();
    assert.equal(outcome.skipped, false);
    assert.equal(outcome.applied, 0);
    assert.ok(existsSync(wtPath), "dirty worktree must remain in place");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -- Controller hook ---------------------------------------------------------

function emptyStore() {
  return {
    getPresentationContext() { return { timeZone: "Asia/Shanghai" }; },
    listTasks() { return []; },
    getTask() { return null; },
    getTaskWorkspace() { return null; },
    listRoles() { return []; },
    getRole() { return null; },
    getActiveAgentRun() { return null; },
    hasOpenInputRequest() { return false; },
    listOpenInputRequests() { return []; },
    listPendingRuntimeTurnCompletions() { return []; },
    getOperatorDeliveryTarget() { return null; },
    resolveExpiredInputRecommendations() { return []; },
    resolveDueRuntimeTurnCompletions() { return []; },
    getRoleSession() { return null; },
    hasInFlightTurn() { return false; },
    peekNextAgentRunId() { return "agent-run-1"; },
    getWorkMailbox() { return null; },
    listWorkMailboxes() { return []; },
    claimWorkMailbox() { return { status: "empty" }; },
    completeWorkMailbox() { return false; },
    releaseWorkMailbox() { return false; },
    getPendingWakeup() { return null; },
    listPendingWakeups() { return []; },
    savePendingWakeup() {},
    clearPendingWakeup() {},
    getLeaderFailure() { return null; },
    getOperatorNotification() { return null; },
    getTaskBrief() { return null; },
    listDecisions() { return []; },
    listMilestones() { return []; },
    saveLeaderDispatch() {},
    saveRoleRunPrepared() {},
    saveRoleRunDelivery() {},
    saveRoleRunDeliveryFailure() { return "state-changed"; },
    saveLeaderDispatchFailure() {},
    saveExitedRoleRun() {}
  };
}

const noTmux = {
  async prepareRoleSession() { throw new Error("unused"); },
  async waitUntilReady() { throw new Error("unused"); },
  async sendOnce() { throw new Error("unused"); },
  async inspectRole() { throw new Error("unused"); },
  async stopTask() { return false; }
};

test("Controller full pass invokes the resourceAutoGc hook", async () => {
  let calls = 0;
  const controller = new FileTaskController(emptyStore(), noTmux, {
    intervalMs: 60_000,
    resourceAutoGc: async () => {
      calls += 1;
      return { skipped: true, applied: 0, failed: 0, restored: 0 };
    }
  });
  try {
    await controller.pump();
    assert.equal(calls, 1, "a full pass runs the hook exactly once");
  } finally {
    controller.stop();
  }
});

test("Controller routes resourceAutoGc failures to onError without breaking the pass", async () => {
  const errors = [];
  const sentinel = new Error("auto-gc boom");
  const controller = new FileTaskController(emptyStore(), noTmux, {
    intervalMs: 60_000,
    onError(error) { errors.push(error); },
    resourceAutoGc: async () => { throw sentinel; }
  });
  try {
    await controller.pump();
    assert.equal(errors.length, 1);
    assert.equal(errors[0], sentinel);
  } finally {
    controller.stop();
  }
});

test("Controller reports partial auto-GC failures via onError", async () => {
  const errors = [];
  const controller = new FileTaskController(emptyStore(), noTmux, {
    intervalMs: 60_000,
    onError(error) { errors.push(error); },
    resourceAutoGc: async () => ({ skipped: false, applied: 1, failed: 2, restored: 0 })
  });
  try {
    await controller.pump();
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /failed to quarantine 2/);
  } finally {
    controller.stop();
  }
});

// -- Precise Controller discovery --------------------------------------------

test("live Controller discovery protects only its own record, not legacy deployments", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-auto-gc-discovery-"));
  try {
    const home = join(root, "yui-home");
    mkdirSync(join(home, "runtime"), { recursive: true, mode: 0o700 });
    // A live Controller: the record points at this very process.
    writeFileSync(join(home, "runtime", "controller.json"), JSON.stringify({
      pid: process.pid,
      processStartIdentity: readLinuxProcessStartIdentity(process.pid) ?? "missing"
    }), "utf8");
    const deployment = join(home, "runtime", "deployments", "legacy-combined");
    mkdirSync(deployment, { recursive: true });
    const controllerRecord = join(home, "runtime", "controller.json");

    const scan = await scanLiveReferences({
      home,
      paths: [deployment, controllerRecord],
      environment: { PATH: process.env.PATH ?? "" },
      ports: {
        processCwdRefs: () => new Map(),
        tmuxPaneCwds: async () => []
      }
    });
    assert.deepEqual(scan.refsByPath.get(deployment) ?? [], []);
    assert.ok(
      (scan.refsByPath.get(controllerRecord) ?? []).some((token) => token.startsWith("controller:")),
      "the discovery record itself stays protected"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
