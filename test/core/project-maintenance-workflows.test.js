import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { FileTaskController } from "../../dist/controller/controller.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createProject } from "../../dist/repository/project.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import {
  acquireProjectMaintenanceLock,
  isProjectMaintenanceFenced,
  ProjectMaintenanceLockedError,
  ProjectMaintenanceLockCancelledError
} from "../../dist/repository/projectMaintenanceLock.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask } from "../../dist/task/task.js";
import { requestTaskActivation, cancelTaskActivation } from "../../dist/task/taskActivationService.js";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-maintenance-workflows-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date("2026-09-13T00:00:00Z");
  const project = createProject("project-1", "fixture", join(home, "reference"),
    { stable: "main", development: "main" }, now,
    { remoteUrl: join(home, "remote.git") });
  store.saveProject(project);
  store.saveConfig({ ...store.getConfig(), defaultWorkspace: join(home, "scratch") });
  const task = createTask("task-1", "Wait before adopting", now, {
    projectBindings: [{ projectId: project.id, directory: "fixture", baseRef: "main" }]
  });
  store.saveTask(task);
  requestTaskActivation(store, {
    taskId: task.id, requestId: "begin", actorId: "user:local", authorityRef: "test",
    environmentPlan: { kind: "scratch" }
  }, now);
  const git = { resolveRemoteHead: async () => assert.fail("must not start Git before admission") };
  return { home, store, project, task, git, now };
}

test("activation timeout leaves the original request pending without adopting or replaying resources", async t => {
  const f = fixture(t);
  const release = await acquireProjectMaintenanceLock(f.home, f.project.id);
  t.after(release);
  const before = f.store.getTask(f.task.id);
  let clock = 0;
  const preparer = new FileTaskWorkspacePreparer(f.home, f.store, f.git, () => f.now, {
    now: () => clock, random: () => 0,
    wait: async ms => { clock += ms; }
  });
  await assert.rejects(preparer.activateTaskWorkspace(f.task.id), ProjectMaintenanceLockedError);
  assert.equal(clock, 60_000);
  assert.deepEqual(f.store.getTask(f.task.id), before);
  assert.deepEqual(f.store.listEnvironmentPreparations(f.task.id), []);
  assert.equal(f.store.getTaskWorkspace(f.task.id), null);
  assert.equal(isProjectMaintenanceFenced(f.home, f.project.id), true);
});

test("Controller stop cancels its pending activation lock wait without failing durable intent", async t => {
  const f = fixture(t);
  const release = await acquireProjectMaintenanceLock(f.home, f.project.id);
  t.after(release);
  const before = f.store.getTask(f.task.id);
  let sawSignal;
  const errors = [];
  const preparer = new FileTaskWorkspacePreparer(f.home, f.store, f.git, () => f.now, {
    wait: async (ms, signal) => {
      sawSignal = signal;
      controller.stop();
      await delay(ms, undefined, { signal });
    }
  });
  const controller = new FileTaskController(new FileSchedulerStoreAdapter(f.store), {}, {
    workspacePreparer: preparer,
    onError: error => errors.push(error)
  });
  t.after(() => controller.stop());
  await controller.pump();
  await controller.shutdownAndDrain();
  assert.equal(sawSignal?.aborted, true);
  assert.ok(errors.some(error => error instanceof ProjectMaintenanceLockCancelledError));
  assert.deepEqual(f.store.getTask(f.task.id), before);
  assert.deepEqual(f.store.listEnvironmentPreparations(f.task.id), []);
  assert.equal(isProjectMaintenanceFenced(f.home, f.project.id), true);
});

test("activation rechecks cancelled intent after the wait before any resource adoption", async t => {
  const f = fixture(t);
  const release = await acquireProjectMaintenanceLock(f.home, f.project.id);
  t.after(release);
  const preparer = new FileTaskWorkspacePreparer(f.home, f.store, f.git, () => f.now, {
    wait: async () => {
      cancelTaskActivation(f.store, f.task.id, "begin", "User cancelled", f.now);
      release();
    }
  });
  await assert.rejects(preparer.activateTaskWorkspace(f.task.id), /activation request changed/);
  assert.equal(f.store.getTask(f.task.id).activationRequest.disposition, "cancelled");
  assert.deepEqual(f.store.listEnvironmentPreparations(f.task.id), []);
  assert.equal(isProjectMaintenanceFenced(f.home, f.project.id), false);
});

test("Project refresh rechecks its catalog after an asynchronous acquisition before touching Git", async t => {
  const f = fixture(t);
  const release = await acquireProjectMaintenanceLock(f.home, f.project.id);
  t.after(release);
  const pending = runProjectCommand(["refresh", f.project.id], f.store, {
    git: { refresh: async () => assert.fail("must not refresh a stale Project") }
  });
  // Let the old snapshot enter the waiter, then simulate a legal catalog writer.
  f.store.saveProject({ ...f.project, path: join(f.home, "migrated") });
  release();
  await assert.rejects(pending, /Project changed while waiting to refresh/);
  assert.equal(isProjectMaintenanceFenced(f.home, f.project.id), false);
});
