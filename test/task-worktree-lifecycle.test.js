import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

import {
  finalizeTaskLifecycleOperation,
  executeTaskLifecycleOperation,
  prepareTaskLifecycleOperation,
  probeTaskLifecycleEffectPlan,
  recoverTaskLifecycleRuntimeOperations,
  replayTaskLifecycleEffectPlan
} from "../dist/commands/taskCommands.js";
import { getSelectionCandidates } from "../dist/cli/interactionCandidates.js";
import {
  clearRuntimeOperationClaim,
  readTaskRuntimeOperationClaim,
  roleRuntimeStateDigest,
  writeRoleRuntimeOperationClaim,
  writeTaskLifecycleEffectPlan
} from "../dist/executor/roleRuntimeOperationClaim.js";
import { createRole } from "../dist/role/role.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createTask } from "../dist/task/task.js";
import { GitWorktreeManager } from "../dist/worktree/gitWorktreeManager.js";

const now = new Date("2026-07-13T00:00:00.000Z");
const later = new Date("2026-07-13T01:00:00.000Z");
const OWNER_TOKEN = "00000000-0000-4000-8000-000000000001";
const FOREIGN_OWNER_TOKEN = "00000000-0000-4000-8000-000000000002";
const require = createRequire(import.meta.url);

function canUseAuthoritativeTransactionLock() {
  try {
    const Database = require("better-sqlite3");
    const database = new Database(":memory:");
    database.exec("BEGIN IMMEDIATE; ROLLBACK;");
    database.close();
    return true;
  } catch {
    return false;
  }
}

const authoritativeTransactionTest = canUseAuthoritativeTransactionLock() ? test : test.skip;

function binding() {
  return { agentId: "codex", adapterId: "codex", config: { adapterId: "codex" } };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "taskmux-worktree-operation-"));
  const home = join(root, "home");
  const repository = join(root, "repository");
  const targetParent = join(root, "worktrees");
  const target = join(targetParent, "reviewer");
  mkdirSync(home, { recursive: true });
  mkdirSync(repository, { recursive: true });
  mkdirSync(targetParent, { recursive: true });
  execFileSync("git", ["init"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "taskmux@example.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "TaskMux Test"], { cwd: repository });
  writeFileSync(join(repository, "README.md"), "initial\n");
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-m", "initial"], {
    cwd: repository,
    stdio: "ignore"
  });
  const store = FileTaskStore.forDomainTransactionWorkspace(home);
  store.saveTask(createTask("task-1", "Managed worktree", now));
  store.saveRole("task-1", createRole(
    "task-1", "reviewer", [binding()], "codex", repository, now
  ));
  return { root, home, repository, target, store };
}

function runtime() {
  return {
    probeRoleStatus() { return "exited"; },
    roleLaunchToken() { return null; },
    roleOperationToken() { return null; }
  };
}

test("worktree interaction candidates separate create and remove actions", () => {
  const { root, repository, target, store } = fixture();
  try {
    store.saveRole("task-1", createRole(
      "task-1", "audit", [binding()], "codex", repository, now
    ));
    store.saveRoleWorktree("task-1", {
      schemaVersion: 2,
      taskId: "task-1",
      roleName: "reviewer",
      repositoryRoot: repository,
      commonDir: join(repository, ".git"),
      repositoryFingerprint: "a".repeat(64),
      path: target,
      worktreeGitDir: join(repository, ".git", "worktrees", "reviewer"),
      branchRef: "taskmux/reviewer",
      headOid: "b".repeat(40),
      ownerToken: OWNER_TOKEN,
      createdAt: now.toISOString()
    });

    const create = getSelectionCandidates({
      argumentIndex: 4,
      entity: "task-role",
      provider: "worktree-task-roles",
      dependsOn: 3,
      actionTarget: true
    }, store, ["task", "worktree", "create", "task-1"]);
    const remove = getSelectionCandidates({
      argumentIndex: 4,
      entity: "task-role",
      provider: "managed-worktree-task-roles",
      dependsOn: 3,
      actionTarget: true
    }, store, ["task", "worktree", "remove", "task-1"]);

    assert.deepEqual(create.candidates.map(({ value }) => value), ["audit"]);
    assert.deepEqual(remove.candidates.map(({ value }) => value), ["reviewer"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RoleWorktree storage codec rejects non-canonical host ownership records", () => {
  const { root, home, repository, target, store } = fixture();
  try {
    const record = {
      schemaVersion: 2,
      taskId: "task-1",
      roleName: "reviewer",
      repositoryRoot: repository,
      commonDir: join(repository, ".git"),
      repositoryFingerprint: "a".repeat(64),
      path: target,
      worktreeGitDir: join(repository, ".git", "worktrees", "reviewer"),
      branchRef: "taskmux/reviewer",
      headOid: "b".repeat(40),
      ownerToken: OWNER_TOKEN,
      createdAt: now.toISOString()
    };
    store.saveRoleWorktree("task-1", record);
    const recordPath = join(home, "tasks", "task-1", "roles", "reviewer", "worktree.json");
    for (const invalid of [
      { ...record, path: `${target}/../foreign` },
      { ...record, ownerToken: "------------------------------------" },
      { ...record, branchRef: "bad..branch" },
      { ...record, headOid: "b".repeat(41) },
      { ...record, unexpected: true }
    ]) {
      writeFileSync(recordPath, `${JSON.stringify(invalid)}\n`);
      assert.throws(() => store.getRoleWorktree("task-1", "reviewer"), /Invalid role worktree/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree create refuses a foreign temporary branch before creating a worktree", () => {
  const { root, home, repository, target } = fixture();
  try {
    const manager = new GitWorktreeManager();
    const ownerToken = OWNER_TOKEN;
    const baseOid = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(repository, "README.md"), "foreign\n");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", [
      "-C", repository, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false",
      "commit", "-m", "foreign"
    ], { stdio: "ignore" });
    const foreignOid = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const plan = manager.probeCreate({
      roleName: "reviewer",
      repository,
      path: target,
      branch: "taskmux/reviewer",
      base: baseOid,
      ownerToken,
      taskmuxHome: home
    });
    execFileSync("git", ["-C", repository, "branch", plan.temporaryBranch, foreignOid]);

    assert.throws(() => manager.applyCreate(plan, "task-1", later), /temporary branch.*foreign/i);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree create rejects a symlinked ownership-marker directory before Git effects", () => {
  const { root, home, repository, target } = fixture();
  try {
    const manager = new GitWorktreeManager();
    const plan = manager.probeCreate({
      roleName: "reviewer",
      repository,
      path: target,
      branch: "taskmux/reviewer",
      ownerToken: OWNER_TOKEN,
      taskmuxHome: home
    });
    const foreign = join(root, "foreign-markers");
    mkdirSync(foreign);
    symlinkSync(foreign, join(plan.commonDir, "taskmux-worktree-owners"));

    assert.throws(() => manager.applyCreate(plan, "task-1", later), /ownership marker.*symbolic link/i);
    assert.equal(existsSync(target), false);
    assert.deepEqual(readdirSync(foreign), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree create is token-owned, replayable, and finalized with Role metadata atomically", () => {
  const { root, home, repository, target, store } = fixture();
  try {
    const claim = prepareTaskLifecycleOperation("worktree-create", "task-1", store, {
      targetRoleName: "reviewer",
      worktreeRequest: {
        roleName: "reviewer",
        path: target,
        branch: "taskmux/reviewer",
        base: null
      }
    }, now);
    writeRoleRuntimeOperationClaim(home, claim, claim.expectedStateDigest);
    const manager = new GitWorktreeManager();
    const plan = probeTaskLifecycleEffectPlan(claim, runtime(), manager, home);
    const started = writeTaskLifecycleEffectPlan(home, claim, plan);
    const first = replayTaskLifecycleEffectPlan(started, runtime(), manager, later);
    const replayed = replayTaskLifecycleEffectPlan(started, runtime(), manager, later);
    assert.deepEqual(replayed, first);
    assert.equal(existsSync(target), true);
    const authorized = FileTaskStore.forDomainTransactionWorkspace(home, claim.token);
    finalizeTaskLifecycleOperation(started, authorized, later, replayed);
    clearRuntimeOperationClaim(home, { scope: "task", taskId: "task-1" }, claim.token);

    const record = store.getRoleWorktree("task-1", "reviewer");
    assert.equal(record.schemaVersion, 2);
    assert.equal(record.repositoryRoot, repository);
    assert.equal(record.path, target);
    assert.equal(record.branchRef, "taskmux/reviewer");
    assert.equal(record.ownerToken, claim.token);
    assert.equal(store.getRole("task-1", "reviewer").workspace, target);
    assert.equal(
      JSON.parse(readFileSync(join(record.commonDir, "taskmux-worktree-owners", `${claim.token}.json`), "utf8")).ownerToken,
      claim.token
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree remove refuses dirty or foreign paths and replays a completed Git effect", () => {
  const { root, home, target, store } = fixture();
  try {
    const manager = new GitWorktreeManager();
    const create = prepareTaskLifecycleOperation("worktree-create", "task-1", store, {
      targetRoleName: "reviewer",
      worktreeRequest: { roleName: "reviewer", path: target, branch: "taskmux/reviewer", base: null }
    }, now);
    writeRoleRuntimeOperationClaim(home, create, create.expectedStateDigest);
    const createStarted = writeTaskLifecycleEffectPlan(
      home,
      create,
      probeTaskLifecycleEffectPlan(create, runtime(), manager, home)
    );
    const created = replayTaskLifecycleEffectPlan(createStarted, runtime(), manager, later);
    finalizeTaskLifecycleOperation(
      createStarted,
      FileTaskStore.forDomainTransactionWorkspace(home, create.token),
      later,
      created
    );
    clearRuntimeOperationClaim(home, { scope: "task", taskId: "task-1" }, create.token);

    writeFileSync(join(target, "dirty.txt"), "dirty\n");
    const remove = prepareTaskLifecycleOperation("worktree-remove", "task-1", store, {
      targetRoleName: "reviewer",
      worktreeRequest: { roleName: "reviewer", path: null, branch: null, base: null }
    }, later);
    writeRoleRuntimeOperationClaim(home, remove, remove.expectedStateDigest);
    const removeStarted = writeTaskLifecycleEffectPlan(
      home,
      remove,
      probeTaskLifecycleEffectPlan(remove, runtime(), manager, home)
    );
    assert.throws(
      () => replayTaskLifecycleEffectPlan(removeStarted, runtime(), manager, later),
      /uncommitted changes/i
    );
    assert.equal(existsSync(target), true);
    rmSync(join(target, "dirty.txt"));
    const removed = replayTaskLifecycleEffectPlan(removeStarted, runtime(), manager, later);
    assert.deepEqual(replayTaskLifecycleEffectPlan(removeStarted, runtime(), manager, later), removed);
    finalizeTaskLifecycleOperation(
      removeStarted,
      FileTaskStore.forDomainTransactionWorkspace(home, remove.token),
      later,
      removed
    );
    clearRuntimeOperationClaim(home, { scope: "task", taskId: "task-1" }, remove.token);
    assert.equal(store.getRoleWorktree("task-1", "reviewer"), null);
    assert.notEqual(store.getRole("task-1", "reviewer").workspace, target);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Role control claim fences direct RoleWorktree record writes", () => {
  const { root, home, repository, target, store } = fixture();
  try {
    const role = store.getRole("task-1", "reviewer");
    const snapshot = { role, sessionSet: null, activeRun: null, selectedWorkItem: null, pendingRun: null };
    const claim = {
      schemaVersion: 1,
      scope: "task-role",
      kind: "launch",
      token: OWNER_TOKEN,
      taskId: "task-1",
      roleName: "reviewer",
      operation: "dispatch",
      ownerPid: process.pid,
      preparedSession: null,
      selectedWorkItem: null,
      pendingRun: null,
      expectedStateDigest: roleRuntimeStateDigest(snapshot),
      recoveryToken: null,
      createdAt: now.toISOString(),
      leaseExpiresAt: later.toISOString()
    };
    writeRoleRuntimeOperationClaim(home, claim, claim.expectedStateDigest);
    assert.throws(() => store.saveRoleWorktree("task-1", {
      schemaVersion: 2,
      taskId: "task-1",
      roleName: "reviewer",
      repositoryRoot: repository,
      commonDir: join(repository, ".git"),
      repositoryFingerprint: "a".repeat(64),
      path: target,
      worktreeGitDir: join(repository, ".git", "worktrees", "reviewer"),
      branchRef: "taskmux/reviewer",
      headOid: "b".repeat(40),
      ownerToken: FOREIGN_OWNER_TOKEN,
      createdAt: now.toISOString()
    }), /runtime operation|reserved/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree removal rejects a symlink replacement without deleting the foreign target", () => {
  const { root, home, target, store } = fixture();
  try {
    const foreign = join(root, "foreign");
    mkdirSync(foreign);
    const manager = new GitWorktreeManager();
    const create = prepareTaskLifecycleOperation("worktree-create", "task-1", store, {
      targetRoleName: "reviewer",
      worktreeRequest: { roleName: "reviewer", path: target, branch: "taskmux/reviewer", base: null }
    }, now);
    writeRoleRuntimeOperationClaim(home, create, create.expectedStateDigest);
    const started = writeTaskLifecycleEffectPlan(home, create, probeTaskLifecycleEffectPlan(create, runtime(), manager, home));
    const receipt = replayTaskLifecycleEffectPlan(started, runtime(), manager, later);
    finalizeTaskLifecycleOperation(started, FileTaskStore.forDomainTransactionWorkspace(home, create.token), later, receipt);
    clearRuntimeOperationClaim(home, { scope: "task", taskId: "task-1" }, create.token);
    const record = store.getRoleWorktree("task-1", "reviewer");
    execFileSync("git", ["-C", record.repositoryRoot, "worktree", "remove", record.path]);
    symlinkSync(foreign, target);
    const plan = manager.probeRemove(record);
    assert.throws(() => manager.applyRemove(plan), /symbolic links|identity/i);
    assert.equal(existsSync(join(foreign, "sentinel")), false);
    assert.equal(existsSync(foreign), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

authoritativeTransactionTest("a failed claim stage performs zero Git effects", () => {
  const { root, home, target, store } = fixture();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFailpoint = process.env.TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT;
  let gitCalls = 0;
  try {
    const claim = prepareTaskLifecycleOperation("worktree-create", "task-1", store, {
      targetRoleName: "reviewer",
      worktreeRequest: { roleName: "reviewer", path: target, branch: "taskmux/reviewer", base: null }
    }, now);
    class CountingGitWorktreeManager extends GitWorktreeManager {
      probeCreate(input) { gitCalls += 1; return super.probeCreate(input); }
      applyCreate(plan, taskId, at) { gitCalls += 1; return super.applyCreate(plan, taskId, at); }
    }
    process.env.NODE_ENV = "test";
    process.env.TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT = "after-stage";
    assert.throws(() => executeTaskLifecycleOperation(
      home,
      claim,
      runtime(),
      () => "unexpected",
      new CountingGitWorktreeManager()
    ), /domain transaction|after staging/i);
    assert.equal(gitCalls, 0);
    assert.equal(existsSync(target), false);
    assert.equal(readTaskRuntimeOperationClaim(home, "task-1"), null);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousFailpoint === undefined) delete process.env.TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT;
    else process.env.TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT = previousFailpoint;
    rmSync(root, { recursive: true, force: true });
  }
});

authoritativeTransactionTest("Git success followed by process loss replays and atomically finalizes the same claim", () => {
  const { root, home, target, store } = fixture();
  try {
    const expired = new Date("2000-01-01T00:00:00.000Z");
    const claim = {
      ...prepareTaskLifecycleOperation("worktree-create", "task-1", store, {
        targetRoleName: "reviewer",
        worktreeRequest: { roleName: "reviewer", path: target, branch: "taskmux/reviewer", base: null }
      }, expired),
      ownerPid: 2_147_483_647
    };
    writeRoleRuntimeOperationClaim(home, claim, claim.expectedStateDigest);
    const manager = new GitWorktreeManager();
    const started = writeTaskLifecycleEffectPlan(
      home,
      claim,
      probeTaskLifecycleEffectPlan(claim, runtime(), manager, home)
    );
    replayTaskLifecycleEffectPlan(started, runtime(), manager, later);
    assert.equal(store.getRoleWorktree("task-1", "reviewer"), null);
    assert.equal(readTaskRuntimeOperationClaim(home, "task-1").phase, "effect-started");

    assert.deepEqual(recoverTaskLifecycleRuntimeOperations(home, runtime(), later), [claim.token]);
    assert.equal(store.getRoleWorktree("task-1", "reviewer").ownerToken, claim.token);
    assert.equal(store.getRole("task-1", "reviewer").workspace, target);
    assert.equal(readTaskRuntimeOperationClaim(home, "task-1"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
