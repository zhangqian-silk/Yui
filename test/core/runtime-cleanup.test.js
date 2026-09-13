import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { activateTask, completeTask, createTask } from "../../dist/task/task.js";
import { TaskWorkspaceCoordinator } from "../../dist/repository/taskWorkspaceCoordinator.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { FileTaskWorkflowRuntime } from "../../dist/controller/clientRuntime.js";
import { SessionOwnerReconciliation } from "../../dist/controller/sessionOwnerReconciliation.js";
import { createSessionOwnerIdentity } from "../../dist/runtime/sessionOwnerIdentity.js";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-runtime-cleanup-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date();
  store.saveTask(completeTask(activateTask(createTask("task-1", "Finished work", now), now),
    now, { by: "user", summary: "Done" }));
  const panes = new Map([
    ["task-1", [{ roleName: "leader", dead: true }, { roleName: "worker", dead: true }]],
    ["task-2", [{ roleName: "leader", dead: false }]]
  ]);
  const tmux = {
    inspectTaskRolePanes: taskId => panes.get(taskId) ?? [],
    async stopTaskAsync(taskId) { return panes.delete(taskId); },
    killRole(taskId, roleName) {
      panes.set(taskId, (panes.get(taskId) ?? []).filter(p => p.roleName !== roleName));
    }
  };
  const preparer = new FileTaskWorkspacePreparer(home, store);
  const runtime = new FileTaskWorkflowRuntime(home, store, null, null, tmux, preparer);
  return { home, store, now, panes, tmux, runtime, preparer };
}

test("archive releases retained Task terminals, remains idempotent and preserves another Task", async t => {
  const { store, panes, runtime, preparer } = fixture(t);
  const coordinator = new TaskWorkspaceCoordinator(store, preparer, runtime);
  const originalTask = store.getTask("task-1");
  // Read-only quiescence inspection may preserve a useful exited scene.
  await runtime.assertTaskPhysicalResourcesReleased("task-1");
  assert.equal(panes.get("task-1").length, 2);
  assert.equal((await coordinator.cleanupTaskForArchive("task-1", "abandoned")).status, "removed");
  assert.deepEqual(runtime.inspectTaskRolePanes("task-1"), []);
  assert.deepEqual(panes.get("task-2"), [{ roleName: "leader", dead: false }]);
  assert.equal((await coordinator.cleanupTaskForArchive("task-1", "abandoned")).status, "removed");
  assert.equal(store.getTask("task-1").status, originalTask.status, "cleanup never deletes or archives the Task record");
});

test("terminal cleanup preserves a Task with live resources or an unconfirmed removal", async t => {
  const { panes, runtime, tmux } = fixture(t);
  panes.get("task-1")[0].dead = false;
  await assert.rejects(runtime.releaseTaskTerminals("task-1"), /still live/);
  assert.equal(panes.get("task-1").length, 2);
  panes.get("task-1")[0].dead = true;
  tmux.stopTaskAsync = async () => false;
  await assert.rejects(runtime.releaseTaskTerminals("task-1"), /terminal.*remain/i);
  assert.equal(panes.get("task-1").length, 2);
});

test("explicit owner termination releases the exited Role window after proving its Host absent", async t => {
  const { home, store, now, panes, tmux } = fixture(t);
  const owner = { scope: "task", taskId: "task-1", roleName: "leader" };
  const record = createSessionOwnerIdentity({
    owner, agentId: "codex", adapterId: "codex", nativeSessionId: "finished-session",
    tmux: { serverName: "fixture", socketPath: join(home, "tmux.sock"),
      sessionName: "task-1", windowName: "leader" },
    // A different start identity proves this historical Host is gone without
    // signalling the test runner (or needing a real Provider).
    providerRoot: { pid: process.pid, startIdentity: "0", attribution: "pane-pid" },
    recordedAt: now
  });
  store.saveSessionOwner(record);
  const reconciliation = new SessionOwnerReconciliation({ home, store, tmux });
  const result = await reconciliation.terminateOwner(owner);
  assert.equal(result.outcome, "stop-confirmed");
  assert.deepEqual(panes.get("task-1"), [{ roleName: "worker", dead: true }]);
  assert.deepEqual(store.listSessionOwnersForOwner(owner), []);
  assert.deepEqual(panes.get("task-2"), [{ roleName: "leader", dead: false }]);
});
