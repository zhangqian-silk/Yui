import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  finalizeTaskLifecycleOperation,
  prepareTaskLifecycleOperation,
  probeTaskLifecycleEffectPlan,
  replayTaskLifecycleEffectPlan,
  runTaskCommand
} from "../dist/commands/taskCommands.js";
import {
  clearRuntimeOperationClaim,
  roleRuntimeStateDigest,
  writeRoleRuntimeOperationClaim,
  writeTaskLifecycleEffectPlan
} from "../dist/executor/roleRuntimeOperationClaim.js";
import { createGlobalRole, createRole, updateRoleStatus } from "../dist/role/role.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createTask } from "../dist/task/task.js";

const now = new Date("2026-07-13T00:00:00.000Z");
const later = new Date("2026-07-13T01:00:00.000Z");
const OWNER_TOKEN = "00000000-0000-4000-8000-000000000001";
const FOREIGN_OWNER_TOKEN = "00000000-0000-4000-8000-000000000002";

function binding() {
  return { agentId: "codex", adapterId: "codex", config: { adapterId: "codex" } };
}

function fixture(roleNames = []) {
  const home = mkdtempSync(join(tmpdir(), "taskmux-lifecycle-operation-"));
  const store = FileTaskStore.forDomainTransactionWorkspace(home);
  store.saveTask(createTask("task-1", "Lifecycle", now));
  for (const roleName of roleNames) {
    store.saveRole("task-1", createRole("task-1", roleName, [binding()], "codex", "/repo", now));
  }
  return { home, store };
}

function exitedRuntime() {
  return {
    probeRoleStatus() { return "exited"; },
    roleLaunchToken() { return null; },
    roleOperationToken() { return null; }
  };
}

test("zero-Role delete still owns a task claim and atomically moves the Task to trash", () => {
  const { home, store } = fixture();
  try {
    const claim = prepareTaskLifecycleOperation("delete", "task-1", store, {}, now);
    writeRoleRuntimeOperationClaim(home, claim, claim.expectedStateDigest);
    const plan = probeTaskLifecycleEffectPlan(claim, exitedRuntime());
    assert.deepEqual(plan, { kind: "stop-roles", windows: [] });
    const started = writeTaskLifecycleEffectPlan(home, claim, plan);
    assert.equal(replayTaskLifecycleEffectPlan(started, exitedRuntime()), null);
    finalizeTaskLifecycleOperation(
      started,
      FileTaskStore.forDomainTransactionWorkspace(home, claim.token),
      later
    );
    clearRuntimeOperationClaim(home, { scope: "task", taskId: "task-1" }, claim.token);
    assert.equal(store.getTask("task-1"), null);
    assert.equal(store.listTrashedTaskIds().includes("task-1"), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Role removal uses a task claim and removes its child dependency graph only after effects", () => {
  const { home, store } = fixture(["reviewer"]);
  try {
    runTaskCommand([
      "role", "child", "task-1", "audit", "--parent", "reviewer",
      "--description", "Audit", "--expected-output", "Report"
    ], store);
    const claim = prepareTaskLifecycleOperation(
      "role-remove",
      "task-1",
      store,
      { targetRoleName: "reviewer" },
      now
    );
    writeRoleRuntimeOperationClaim(home, claim, claim.expectedStateDigest);
    const started = writeTaskLifecycleEffectPlan(
      home,
      claim,
      probeTaskLifecycleEffectPlan(claim, exitedRuntime())
    );
    assert.equal(store.getRole("task-1", "reviewer") !== null, true);
    assert.equal(store.getChildRole("task-1", "audit") !== null, true);
    replayTaskLifecycleEffectPlan(started, exitedRuntime());
    finalizeTaskLifecycleOperation(
      started,
      FileTaskStore.forDomainTransactionWorkspace(home, claim.token),
      later
    );
    clearRuntimeOperationClaim(home, { scope: "task", taskId: "task-1" }, claim.token);
    assert.equal(store.getRole("task-1", "reviewer"), null);
    assert.equal(store.getChildRole("task-1", "audit"), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Role detach runs as a claimed lifecycle effect before finalizing durable status", () => {
  const { home, store } = fixture(["reviewer"]);
  try {
    const claim = prepareTaskLifecycleOperation(
      "role-detach",
      "task-1",
      store,
      { targetRoleName: "reviewer" },
      now
    );
    writeRoleRuntimeOperationClaim(home, claim, claim.expectedStateDigest);
    const detachedTasks = [];
    const runtime = {
      probeRoleStatus() { return "exited"; },
      roleLaunchToken() { return null; },
      roleOperationToken() { return null; },
      detachRole(taskId) { detachedTasks.push(taskId); }
    };
    const plan = probeTaskLifecycleEffectPlan(claim, runtime);
    assert.deepEqual(plan, { kind: "detach-role", roleName: "reviewer" });
    const started = writeTaskLifecycleEffectPlan(home, claim, plan);

    assert.equal(store.getRole("task-1", "reviewer").status, "idle");
    assert.equal(replayTaskLifecycleEffectPlan(started, runtime), null);
    assert.deepEqual(detachedTasks, ["task-1"]);

    finalizeTaskLifecycleOperation(
      started,
      FileTaskStore.forDomainTransactionWorkspace(home, claim.token),
      later
    );
    clearRuntimeOperationClaim(home, { scope: "task", taskId: "task-1" }, claim.token);
    assert.equal(store.getRole("task-1", "reviewer").status, "detached");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Role rename recovers response loss and fails closed when both native names exist", () => {
  const { home, store } = fixture(["reviewer"]);
  try {
    store.saveRole("task-1", updateRoleStatus(store.getRole("task-1", "reviewer"), "running", now));
    const claim = prepareTaskLifecycleOperation("role-rename", "task-1", store, {
      targetRoleName: "reviewer",
      newRoleName: "audit"
    }, now);
    writeRoleRuntimeOperationClaim(home, claim, claim.expectedStateDigest);
    const launchToken = OWNER_TOKEN;
    const windows = new Map([["reviewer", launchToken]]);
    const operations = new Map();
    const runtime = {
      probeRoleStatus(_taskId, roleName) { return windows.has(roleName) ? "running" : "exited"; },
      roleLaunchToken(_taskId, roleName) { return windows.get(roleName) ?? null; },
      roleOperationToken(_taskId, roleName) { return operations.get(roleName) ?? null; },
      renameRoleWithOperationToken(_taskId, oldName, newName, token) {
        operations.delete(oldName);
        windows.delete(oldName);
        windows.set(newName, launchToken);
        operations.set(newName, token);
        if (!runtime.lostResponse) {
          runtime.lostResponse = true;
          throw new Error("rename response lost");
        }
      },
      lostResponse: false
    };
    const started = writeTaskLifecycleEffectPlan(
      home,
      claim,
      probeTaskLifecycleEffectPlan(claim, runtime)
    );
    assert.throws(() => replayTaskLifecycleEffectPlan(started, runtime), /response lost/);
    assert.equal(replayTaskLifecycleEffectPlan(started, runtime), null);
    finalizeTaskLifecycleOperation(
      started,
      FileTaskStore.forDomainTransactionWorkspace(home, claim.token),
      later
    );
    clearRuntimeOperationClaim(home, { scope: "task", taskId: "task-1" }, claim.token);
    assert.equal(store.getRole("task-1", "reviewer"), null);
    assert.equal(store.getRole("task-1", "audit").name, "audit");

    windows.set("reviewer", launchToken);
    assert.throws(() => replayTaskLifecycleEffectPlan(started, runtime), /both source and destination/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GlobalRole claims are isolated from same-name TaskRoles and fence every global mutation", () => {
  const { home, store } = fixture(["reviewer"]);
  try {
    const globalRole = createGlobalRole("reviewer", [binding()], "codex", "/repo", now);
    store.saveGlobalRole(globalRole);
    const preparedState = { role: globalRole, sessionSet: null, activeRun: null };
    const claim = {
      schemaVersion: 1,
      scope: "global-role",
      kind: "global-role-mutation",
      token: OWNER_TOKEN,
      taskId: null,
      roleName: "reviewer",
      operation: "update",
      ownerPid: process.pid,
      preparedSession: null,
      selectedWorkItem: null,
      pendingRun: null,
      expectedStateDigest: roleRuntimeStateDigest(preparedState),
      recoveryToken: null,
      createdAt: now.toISOString(),
      leaseExpiresAt: later.toISOString(),
      phase: "prepared",
      preparedState
    };
    writeRoleRuntimeOperationClaim(home, claim, claim.expectedStateDigest);
    assert.throws(
      () => store.saveGlobalRole({ ...globalRole, workspace: "/racing" }),
      /runtime operation|reserved/i
    );
    store.saveRole("task-1", { ...store.getRole("task-1", "reviewer"), workspace: "/task-role-change" });
    assert.equal(store.getRole("task-1", "reviewer").workspace, "/task-role-change");
    FileTaskStore.forDomainTransactionWorkspace(home, claim.token)
      .saveGlobalRole({ ...globalRole, workspace: "/authorized" });
    assert.equal(store.getGlobalRole("reviewer").workspace, "/authorized");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Task lifecycle claim codec rejects non-canonical prepared arrays", () => {
  const { home, store } = fixture(["reviewer", "audit"]);
  try {
    const prepared = prepareTaskLifecycleOperation("archive", "task-1", store, {}, now);
    const preparedState = {
      ...prepared.preparedState,
      roles: [...prepared.preparedState.roles].reverse()
    };
    const claim = {
      ...prepared,
      preparedState,
      expectedStateDigest: roleRuntimeStateDigest(preparedState)
    };
    assert.throws(
      () => writeRoleRuntimeOperationClaim(home, claim, claim.expectedStateDigest),
      /Invalid Task runtime operation claim/i
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Task lifecycle effect plan codec binds canonical paths, target Role, and operation token", () => {
  const invalidCases = [
    { targetPath: "/tmp/./reviewer" },
    { roleName: "other" },
    { ownerToken: FOREIGN_OWNER_TOKEN }
  ];

  for (const patch of invalidCases) {
    const { home, store } = fixture(["reviewer"]);
    try {
      const claim = prepareTaskLifecycleOperation("worktree-create", "task-1", store, {
        targetRoleName: "reviewer",
        worktreeRequest: {
          roleName: "reviewer",
          path: "/tmp/reviewer",
          branch: "taskmux/reviewer",
          base: null
        }
      }, now);
      writeRoleRuntimeOperationClaim(home, claim, claim.expectedStateDigest);
      const plan = {
        kind: "git-worktree-create",
        roleName: "reviewer",
        repositoryRoot: "/repo",
        commonDir: "/repo/.git",
        repositoryFingerprint: "a".repeat(64),
        targetPath: "/tmp/reviewer",
        baseOid: "b".repeat(40),
        requestedBranch: "taskmux/reviewer",
        temporaryBranch: `taskmux-op-${claim.token}`,
        ownerToken: claim.token,
        markerPath: `/repo/.git/taskmux-worktree-owners/${claim.token}.json`,
        ...patch
      };
      assert.throws(
        () => writeTaskLifecycleEffectPlan(home, claim, plan),
        /Invalid Task runtime operation claim/i,
        JSON.stringify(patch)
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("GlobalRole claim codec binds an active run to the claimed Role", () => {
  const { home, store } = fixture();
  try {
    const role = createGlobalRole("reviewer", [binding()], "codex", "/repo", now);
    store.saveGlobalRole(role);
    const preparedState = {
      role,
      sessionSet: null,
      activeRun: {
        schemaVersion: 1,
        id: "run-1",
        taskId: "operator",
        roleName: "other",
        mode: "new",
        input: "run",
        status: "active",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      }
    };
    const claim = {
      schemaVersion: 1,
      scope: "global-role",
      kind: "global-role-mutation",
      token: OWNER_TOKEN,
      taskId: null,
      roleName: "reviewer",
      operation: "update",
      ownerPid: process.pid,
      preparedSession: null,
      selectedWorkItem: null,
      pendingRun: null,
      expectedStateDigest: roleRuntimeStateDigest(preparedState),
      recoveryToken: null,
      createdAt: now.toISOString(),
      leaseExpiresAt: later.toISOString(),
      phase: "prepared",
      preparedState
    };
    assert.throws(
      () => writeRoleRuntimeOperationClaim(home, claim, claim.expectedStateDigest),
      /Invalid GlobalRole runtime operation claim/i
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
