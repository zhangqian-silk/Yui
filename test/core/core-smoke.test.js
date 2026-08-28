import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { createTaskMessage } from "../../dist/message/message.js";
import { createProject } from "../../dist/repository/project.js";
import {
  attachReviewRoundWorkspace,
  createTaskReviewRound,
  finishReviewRound,
  startReviewRound
} from "../../dist/review/reviewRound.js";
import { builtinAgentDriverRegistry } from "../../dist/runtime/builtinAgentDrivers.js";
import { createAgentRun, yieldAgentRun } from "../../dist/run/agentRun.js";
import { listPublicCommandPaths } from "../../dist/cli/commandCatalog.js";
import {
  assertRegistryCoversBaselineToCurrent,
  createProductionRegistry
} from "../../dist/storage/migration/index.js";
import { writeTextFileAtomically } from "../../dist/storage/durableFile.js";
import { SQLITE_SCHEMA_VERSION } from "../../dist/storage/sqliteSchema.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createSqliteRecordMigrationTarget } from "../../dist/storage/upgrade/sqliteRecordMigrationTarget.js";
import { latestStorageVersionState } from "../../dist/storage/upgrade/recordVersions.js";
import { populateSqliteFromState } from "../../dist/storage/upgrade/sqliteStateMigration.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

const root = resolve(import.meta.dirname, "../..");
const bareEnv = sanitizedTestEnv();

test("the packaged CLI starts and exposes the core workflow", () => {
  const help = execFileSync(process.execPath, [join(root, "dist", "cli.js"), "help"], {
    cwd: root,
    encoding: "utf8",
    env: bareEnv
  });
  assert.match(help, /Yui/u);
  const commands = listPublicCommandPaths();
  for (const command of ["setup", "update", "upgrade", "task create", "task list"]) {
    assert.ok(commands.includes(command), `missing core command: ${command}`);
  }
});

test("the SQLite Task path persists one normal Task and Message", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-core-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date("2026-08-27T00:00:00.000Z");
  const store = new SqliteTaskStore(home);
  const task = activateTask(createTask(store.nextTaskId(), "Core smoke", now), now);
  store.saveTask(task);
  const message = createTaskMessage(
    store.nextMessageId(task.id),
    task.id,
    "Keep the core path healthy.",
    "user",
    { type: "user" },
    now,
    { wakePolicy: "leader" }
  );
  store.saveMessage(task.id, message);
  store.close();

  const reopened = new SqliteTaskStore(home);
  assert.equal(reopened.getTask(task.id)?.status, "active");
  assert.deepEqual(reopened.listMessages(task.id), [message]);
  reopened.close();
});

test("the production migration is atomic and preserves ReviewRound-backed Agent Runs", (t) => {
  const registry = createProductionRegistry();
  assert.doesNotThrow(() => assertRegistryCoversBaselineToCurrent(registry));

  const home = mkdtempSync(join(tmpdir(), "yui-migration-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date("2026-08-27T00:00:00.000Z");
  const commit = "a".repeat(40);
  const project = createProject(
    "project-1",
    "app",
    "/tmp/app",
    { stable: "master", development: "master" },
    now
  );
  const task = createTask("task-1", "Migrate review history", now, {
    projectBindings: [{ projectId: project.id, directory: "app", baseRef: "master" }]
  });
  const round = createTaskReviewRound(
    "review-round-1",
    task.id,
    "reviewer",
    "leader",
    { schemaVersion: 1, projects: [{ projectId: project.id, commit }] },
    now
  );
  const workspace = {
    schemaVersion: 2,
    owner: { type: "review-round", taskId: task.id, reviewRoundId: round.id },
    root: "/tmp/task-1/review-round-1",
    entries: [{
      projectId: project.id,
      directory: "app",
      access: "write",
      path: "/tmp/task-1/review-round-1/app",
      branch: "yui/task-1/reviewer",
      baseRef: commit,
      baseCommit: commit
    }],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  const runningRound = startReviewRound(
    attachReviewRoundWorkspace(round, workspace),
    "agent-run-1"
  );
  const run = yieldAgentRun(createAgentRun(
    "agent-run-1",
    task.id,
    "reviewer",
    "new",
    "Review the frozen Task candidate.",
    now,
    {
      purpose: "review",
      reviewRoundId: runningRound.id,
      workspace,
      effective: {
        schemaVersion: 2,
        sourceDesiredRevision: 1,
        agentId: "codex",
        adapterId: "codex",
        profileAccess: "write",
        search: false,
        permission: { strategy: "default" },
        writeProjectIds: [project.id],
        workspace: { root: workspace.root, entries: workspace.entries },
        context: {},
        reviewRoundId: runningRound.id,
        reviewBaseCommit: commit
      }
    }
  ), "Review completed.", now);
  const completedRound = finishReviewRound(
    runningRound,
    "completed",
    "Accepted.",
    now,
    { evidenceCommit: commit }
  );
  const migratedRound = {
    ...completedRound,
    legacyAnchor: { workItemId: "work-item-1", candidateId: "candidate-1" }
  };
  const migratedRun = { ...run, workItemId: migratedRound.legacyAnchor.workItemId };
  const databaseFilename = "migration.db";

  populateSqliteFromState(home, {
    projects: { [project.id]: project },
    tasks: {
      [task.id]: {
        task,
        agentRuns: { [migratedRun.id]: migratedRun },
        reviewRounds: { [migratedRound.id]: migratedRound }
      }
    }
  }, databaseFilename);

  const migrated = new SqliteTaskStore(home, { databaseFilename });
  assert.equal(migrated.getReviewRound(task.id, migratedRound.id)?.status, "completed");
  assert.equal(migrated.getAgentRun(task.id, migratedRun.id)?.reviewRoundId, migratedRound.id);
  migrated.close();

  const databasePath = join(home, databaseFilename);
  const database = new Database(databasePath);
  database.prepare("DELETE FROM schema_migrations WHERE version = ?").run(SQLITE_SCHEMA_VERSION);
  const before = database.prepare(
    "SELECT version, axis, record_kind, applied_at, checksum FROM schema_migrations ORDER BY version"
  ).all();
  const schemaBefore = database.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE name IS NOT NULL ORDER BY type, name"
  ).all();
  database.close();

  assert.throws(() => {
    const reopened = new SqliteTaskStore(home, { databaseFilename });
    reopened.close();
  }, /pending SQLite schema migration .*offline staged upgrade/iu);

  const unchanged = new Database(databasePath, { readonly: true });
  assert.deepEqual(unchanged.prepare(
    "SELECT version, axis, record_kind, applied_at, checksum FROM schema_migrations ORDER BY version"
  ).all(), before);
  assert.deepEqual(unchanged.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE name IS NOT NULL ORDER BY type, name"
  ).all(), schemaBefore);
  unchanged.close();

  const atomicHome = mkdtempSync(join(tmpdir(), "yui-migration-atomicity-smoke-"));
  t.after(() => rmSync(atomicHome, { recursive: true, force: true }));
  ensureStorageSchema(atomicHome);
  const current = new SqliteTaskStore(atomicHome);
  current.close();
  const committedDatabasePath = join(atomicHome, "yui.db");
  const schemaPath = join(atomicHome, "schema.json");
  const committedDatabaseBefore = readFileSync(committedDatabasePath);
  const committedSchemaBefore = readFileSync(schemaPath);
  let schemaWrites = 0;
  const target = createSqliteRecordMigrationTarget({
    home: atomicHome,
    latest: latestStorageVersionState(),
    registry,
    now: () => now,
    writeSchemaFile(path, content) {
      schemaWrites += 1;
      writeTextFileAtomically(path, content);
      if (schemaWrites === 1) throw new Error("injected post-rename schema failure");
    }
  });
  target.writeFreshOutput(target.readSource());
  assert.throws(
    () => target.atomicSwitchWithBackup(),
    /injected post-rename schema failure/u
  );
  assert.deepEqual(readFileSync(committedDatabasePath), committedDatabaseBefore);
  assert.deepEqual(readFileSync(schemaPath), committedSchemaBefore);
  assert.equal(existsSync(target.stagedDbPath), false);
});

test("the built-in Agent Drivers are available through the shared registry", () => {
  const drivers = builtinAgentDriverRegistry();
  assert.equal(drivers.requireByAdapterId("codex").id, "openai/codex");
  assert.equal(drivers.requireByAdapterId("claude").id, "anthropic/claude-code");
});
