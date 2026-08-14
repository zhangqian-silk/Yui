/**
 * Delivery regression for review-round-7 P1 finding A (migration high-water
 * mark).
 *
 * The integrationQueue 0->1 introduction migration adds the empty
 * `integrationQueue` map to every Task aggregate but must also seed
 * `idHighWaterMarks.integrationQueue: 0`.  The current store strictly requires
 * that field for every record family in TASK_RECORD_ID_PREFIXES, so without
 * the seed an old Home containing a Task becomes unloadable after the
 * migration (upgrade/startup breaks).
 *
 * This test deletes both `aggregate.integrationQueue` and
 * `aggregate.idHighWaterMarks.integrationQueue`, runs the 0->1 step, and
 * asserts the current snapshot parser (and the current FileTaskStore on a
 * state.json round-trip) load the migrated state successfully.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProject } from "../../dist/repository/project.js";
import { createProductionStorageRegistry } from "../../dist/storage/migration/productionRegistry.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import {
  FileTaskStore,
  validateCurrentStorageStateSnapshot
} from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";

const now = new Date("2026-08-14T02:00:00.000Z");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function createFixture(label = "queue") {
  const root = mkdtempSync(join(tmpdir(), `yui-task-16-rr7-${label}-`));
  const repositoryPath = join(root, "repository");
  git(["init", "-b", "master", repositoryPath]);
  git(["-C", repositoryPath, "config", "user.name", "Test"]);
  git(["-C", repositoryPath, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repositoryPath, "base.txt"), "base\n");
  git(["-C", repositoryPath, "add", "base.txt"]);
  git(["-C", repositoryPath, "commit", "-m", "base"]);
  const baseCommit = git(["-C", repositoryPath, "rev-parse", "HEAD"]).trim();

  const home = join(root, "home");
  mkdirSync(home);
  ensureStorageSchema(home, now);
  const store = new FileTaskStore(home);
  const workspaceRoot = join(root, "workspace");
  mkdirSync(workspaceRoot);
  store.saveConfig({ schemaVersion: 1, defaultWorkspace: workspaceRoot });
  const project = createProject(
    store.nextProjectId(),
    "fixture",
    repositoryPath,
    { stable: "master", development: "master" },
    now
  );
  store.saveProject(project);
  const task = activateTask(createTask(store.nextTaskId(), "Queue task", now, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: "master" }]
  }), now);
  store.saveTask(task);
  return { root, repositoryPath, home, store, project, task, baseCommit };
}

test("integrationQueue 0->1 migration leaves an old Task loadable by the current store", () => {
  const fixture = createFixture("migration");
  const legacyState = JSON.parse(readFileSync(join(fixture.home, "state.json"), "utf8"));
  const aggregate = legacyState.tasks[fixture.task.id];
  delete aggregate.integrationQueue;
  delete aggregate.idHighWaterMarks.integrationQueue;
  const snapshot = {
    schemaManifest: {
      schemaVersion: 1,
      storageVersion: 6,
      aggregateSchemaVersion: 18,
      recordVersions: {},
      updatedAt: now.toISOString()
    },
    state: legacyState
  };
  const step = createProductionStorageRegistry().lookup("record", "integrationQueue", 0);
  assert.ok(step);
  const migrated = step.transform(snapshot);
  assert.deepEqual(migrated.state.tasks[fixture.task.id].integrationQueue, {});
  assert.equal(
    migrated.state.tasks[fixture.task.id].idHighWaterMarks.integrationQueue,
    0
  );
  // The current snapshot parser must accept the migrated state.
  assert.doesNotThrow(() => validateCurrentStorageStateSnapshot(migrated.state));
  // End-to-end: the current FileTaskStore must load the migrated state.json.
  writeFileSync(join(fixture.home, "state.json"), `${JSON.stringify(migrated.state)}\n`);
  const reloaded = new FileTaskStore(fixture.home);
  assert.equal(reloaded.getTask(fixture.task.id)?.id, fixture.task.id);
});
