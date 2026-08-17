/**
 * Tests for the state.json → SQLite staged migration (layout 6 → 7, task-21 §8).
 *
 * Covers:
 *  1. Realistic state.json migration + checksum verification + read-back.
 *  2. Failure rollback (checksum mismatch → state.json untouched, layout 6).
 *  3. Rollback drill (migrate → rollback → layout 6, state.json intact).
 *  4. Idempotent re-run (stage, abort, re-stage → no duplicates).
 *  5. Four-state classification (MIGRATABLE / USABLE / CORRUPTED).
 *  6. §8.4 invariants: evidence and sessions preserved row-for-record.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";

import { FileTaskStore } from "../dist/storage/taskStore.js";
import { SqliteTaskStore } from "../dist/storage/sqliteStore.js";
import { createDurableJob } from "../dist/job/durableJob.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { runMigration } from "../dist/storage/migration/index.js";
import { createProductionRegistry } from "../dist/storage/migration/productionRegistry.js";
import { latestStorageVersionState } from "../dist/storage/upgrade/recordVersions.js";
import { classifyHome } from "../dist/storage/upgrade/homeClassification.js";
import {
  createSqliteMigrationTarget,
  rollbackSqliteMigration
} from "../dist/storage/upgrade/sqliteMigrationTarget.js";
import {
  populateSqliteFromState,
  computeDbFamilyChecksums,
  verifySqliteChecksums,
  STAGED_DATABASE_FILENAME,
  COMMITTED_DATABASE_FILENAME
} from "../dist/storage/upgrade/sqliteStateMigration.js";

const LATEST = latestStorageVersionState();
const REGISTRY = createProductionRegistry();
const NOW = "2026-08-15T12:00:00.000Z";

// -- helpers ----------------------------------------------------------------

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), "yui-sqlite-migration-"));
}

function readEffective(agentId, adapterId, workspace) {
  return {
    schemaVersion: 2,
    sourceDesiredRevision: 1,
    agentId,
    adapterId,
    profileAccess: "read",
    search: false,
    permission: { strategy: "configured", sandbox: "read-only", approval: "never" },
    writeProjectIds: [],
    workspace: { root: workspace, entries: [] },
    context: {}
  };
}

/**
 * Build a rich, current Home via FileTaskStore (so every record has the exact
 * shape and schemaVersion the production code expects), then downgrade the
 * on-disk schema to layout 6. This gives us a realistic migration source
 * without hand-crafting JSON.
 */
function setupLayout6Home() {
  const home = temporaryHome();
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);

  const agent = {
    schemaVersion: 2,
    id: "codex",
    adapterId: "codex",
    command: "codex",
    baseArgs: [],
    environment: [],
    createdAt: NOW,
    updatedAt: NOW
  };

  const project = {
    schemaVersion: 3,
    id: "proj-alpha",
    name: "Alpha",
    aliases: [],
    path: join(home, "proj-alpha"),
    ownership: "external",
    stableBranch: "main",
    developmentBranch: "main",
    knowledge: [],
    createdAt: NOW,
    updatedAt: NOW
  };

  const globalRole = {
    schemaVersion: 3,
    launchRevision: 1,
    defaultAccess: "write",
    name: "operator",
    activeAgentId: "codex",
    agentBindings: {
      codex: {
        agentId: "codex",
        adapterId: "codex",
        config: { adapterId: "codex", permission: { strategy: "bypass" } }
      }
    },
    workspace: home,
    createdAt: NOW,
    updatedAt: NOW
  };

  const globalSessions = {
    schemaVersion: 3,
    owner: { scope: "global", roleName: "operator" },
    activeAgentId: "codex",
    sessions: {
      codex: {
        schemaVersion: 3,
        agentId: "codex",
        adapterId: "codex",
        nativeSessionId: "global-session",
        policy: "fixed",
        effective: readEffective("codex", "codex", home),
        status: "ready",
        recentCompletedTurnIds: [],
        createdAt: NOW,
        updatedAt: NOW
      }
    },
    updatedAt: NOW
  };

  const task = {
    schemaVersion: 4,
    id: "task-alpha",
    title: "Alpha Task",
    projectBindings: [{ projectId: "proj-alpha", directory: "src", baseRef: "main" }],
    status: "active",
    createdAt: NOW,
    updatedAt: NOW
  };

  const taskRole = {
    ...globalRole,
    name: "leader",
    taskId: task.id,
    status: "idle"
  };

  const taskSessions = {
    ...globalSessions,
    schemaVersion: 4,
    owner: { scope: "task", taskId: task.id, roleName: "leader" },
    inFlight: null,
    pendingTurnCompletion: null,
    sessions: {
      codex: { ...globalSessions.sessions.codex, nativeSessionId: "task-session" }
    }
  };

  const workItem = {
    schemaVersion: 9,
    id: "work-item-1",
    taskId: task.id,
    title: "Implement",
    objective: "Implement",
    acceptance: [],
    dependsOn: [],
    writeProjectIds: [],
    executionGroups: [],
    revision: 1,
    status: "running",
    candidates: [{
      schemaVersion: 2,
      id: "candidate-1",
      taskId: task.id,
      workItemId: "work-item-1",
      sequence: 1,
      workItemRevision: 1,
      summary: "First candidate",
      source: { type: "direct" },
      createdAt: NOW
    }],
    createdAt: NOW,
    updatedAt: NOW
  };

  const run = {
    schemaVersion: 7,
    id: "agent-run-1",
    taskId: task.id,
    roleName: "leader",
    mode: "new",
    input: "implement",
    purpose: "execution",
    effective: readEffective("codex", "codex", home),
    workItemId: workItem.id,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW
  };

  const brief = {
    schemaVersion: 2,
    objective: "Build the feature",
    boundaries: [],
    technicalApproach: "TBD",
    currentFocus: "Starting",
    leaderSummary: "Starting implementation",
    updatedAt: NOW,
    updatedBy: "codex"
  };

  const changeSet = {
    schemaVersion: 3,
    id: "change-set-1",
    taskId: task.id,
    projectId: project.id,
    baseCommit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    headCommit: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
    branch: "feature/branch",
    changedPaths: [],
    workItemId: workItem.id,
    createdAt: NOW
  };

  const integrationAttempt = {
    schemaVersion: 3,
    id: "integration-1",
    taskId: task.id,
    projectId: project.id,
    targetRef: "refs/heads/main",
    expectedHead: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    changeSetIds: ["change-set-1"],
    checkCommands: [],
    status: "committed",
    createdAt: NOW,
    updatedAt: NOW,
    endedAt: NOW
  };

  const reviewRound = {
    schemaVersion: 4,
    id: "review-round-1",
    taskId: task.id,
    workItemId: workItem.id,
    candidateId: "candidate-1",
    reviewerRoleName: "leader",
    reviewBaseCommit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    requestedBy: "leader",
    status: "completed",
    summary: "Review passed",
    report: "All checks passed",
    checks: [],
    createdAt: NOW,
    endedAt: NOW
  };

  const message = {
    schemaVersion: 2,
    id: "message-1",
    taskId: task.id,
    kind: "user",
    author: { type: "user" },
    body: "Hello",
    createdAt: NOW
  };

  const inputRequest = {
    schemaVersion: 2,
    id: "input-1",
    taskId: task.id,
    requester: { taskId: task.id, roleName: "leader", agentId: "codex", runId: "agent-run-1" },
    question: "Proceed?",
    choices: [],
    blockedRefs: [],
    policy: { kind: "required" },
    status: "open",
    createdAt: NOW,
    updatedAt: NOW
  };

  const decision = {
    schemaVersion: 1,
    id: "decision-1",
    taskId: task.id,
    title: "Approved",
    rationale: "Looks good",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW
  };

  const milestone = {
    schemaVersion: 1,
    id: "milestone-1",
    taskId: task.id,
    title: "M1",
    summary: "First milestone",
    createdBy: "leader",
    createdAt: NOW
  };

  const event1 = {
    schemaVersion: 2,
    id: "event-1",
    taskId: task.id,
    type: "task.created",
    payload: {},
    createdAt: NOW
  };
  const event2 = {
    schemaVersion: 2,
    id: "event-2",
    taskId: task.id,
    type: "task.updated",
    payload: {},
    createdAt: NOW
  };

  const leaderFailure = {
    schemaVersion: 1,
    taskId: task.id,
    nativeSessionId: "task-session",
    message: "failed",
    attemptCount: 1,
    firstFailedAt: NOW,
    lastFailedAt: NOW
  };

  const operatorNotification = {
    schemaVersion: 1,
    taskId: task.id,
    type: "leader-recovery-failed",
    message: "failed",
    createdAt: NOW,
    updatedAt: NOW
  };

  const durableJob = createDurableJob({
    id: "job-1",
    taskId: task.id,
    owner: { kind: "task" },
    projectId: project.id,
    head: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    workspace: home,
    env: { YUI_CHECK: "migration" },
    steps: [{ name: "check", command: "true" }],
    artifactsLocator: "artifacts/job-1"
  }, new Date(NOW));

  const mailbox = {
    schemaVersion: 1,
    target: { kind: "role-runtime", taskId: task.id, roleName: "leader" },
    nextSequence: 1,
    processing: null,
    pending: null
  };

  const managedWorkspace = {
    schemaVersion: 2,
    owner: { type: "work-item", taskId: task.id, workItemId: workItem.id },
    root: join(home, "ws-1"),
    entries: [],
    createdAt: NOW,
    updatedAt: NOW
  };

  store.transaction((tx) => {
    tx.saveConfig({ ...tx.getConfig(), timeZone: "UTC" });
    tx.saveConfiguredAgent(agent);
    tx.saveProject(project);
    tx.saveGlobalRole(globalRole);
    tx.saveGlobalRoleSessionSet(globalSessions);
    tx.saveTask(task);
    tx.saveTaskBrief(task.id, brief);
    tx.saveRole(task.id, taskRole);
    tx.saveRoleSessionSet(taskSessions);
    tx.saveWorkItem(task.id, workItem);
    tx.saveManagedWorkspace(managedWorkspace);
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    tx.saveReviewRound(task.id, reviewRound);
    tx.saveChangeSet(task.id, changeSet);
    tx.saveIntegrationAttempt(task.id, integrationAttempt);
    tx.saveMessage(task.id, message);
    tx.saveInputRequest(task.id, inputRequest);
    tx.saveDecision(task.id, decision);
    tx.saveMilestone(task.id, milestone);
    tx.saveEvent(task.id, event1);
    tx.saveEvent(task.id, event2);
    tx.saveLeaderFailure(leaderFailure);
    tx.saveOperatorNotification(operatorNotification);
    tx.saveDurableJob(task.id, durableJob);
    tx.setJobCallerKeyHash(task.id, "leader", "codex", "a".repeat(64));
    tx.saveWorkMailbox(mailbox);
  });

  // Read the state.json before downgrading.
  const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));

  // Downgrade schema.json to layout 6 (the migration source).
  const manifest = JSON.parse(readFileSync(join(home, "schema.json"), "utf8"));
  manifest.storageVersion = 6;
  writeFileSync(join(home, "schema.json"), JSON.stringify(manifest, null, 2) + "\n");

  return { home, state };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readManifest(home) {
  return JSON.parse(readFileSync(join(home, "schema.json"), "utf8"));
}

// -- 1. realistic migration + checksum + read-back --------------------------

test("migrates a realistic state.json to SQLite with matching checksums and read-back", () => {
  const { home, state } = setupLayout6Home();
  try {
    const target = createSqliteMigrationTarget({
      home, latest: LATEST, registry: REGISTRY
    });

    const report = runMigration({
      registry: REGISTRY, target, latest: LATEST, mode: "execute"
    });

    assert.equal(report.outcome, "migrated",
      `expected migrated, got ${report.outcome}: ${report.error ?? ""}`);

    // schema.json advanced to layout 7.
    assert.equal(readManifest(home).storageVersion, 7);

    // yui.db exists; the sidecar is gone.
    assert.ok(existsSync(join(home, COMMITTED_DATABASE_FILENAME)), "yui.db should exist");
    assert.ok(!existsSync(join(home, STAGED_DATABASE_FILENAME)), "yui.db.staged should be removed");
    assert.ok(!existsSync(join(home, `${STAGED_DATABASE_FILENAME}-wal`)), "staged WAL sidecar should be removed");
    assert.ok(!existsSync(join(home, `${STAGED_DATABASE_FILENAME}-shm`)), "staged SHM sidecar should be removed");

    // state.json is retained (read-only) and unchanged.
    const stateAfter = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    assert.equal(stateAfter.revision, state.revision);
    assert.equal(stateAfter.tasks["task-alpha"].task.title, "Alpha Task");

    // Checksums match between state.json and the committed db.
    verifySqliteChecksums(state, home, COMMITTED_DATABASE_FILENAME);

    // Read back through SqliteTaskStore and verify key data.
    const store = new SqliteTaskStore(home);
    try {
      assert.equal(store.listTasks().length, 1);
      assert.equal(store.listProjects().length, 1);
      assert.equal(store.listConfiguredAgents().length, 1);
      assert.equal(store.listWorkMailboxes().length, 1);

      const alpha = store.getTask("task-alpha");
      assert.ok(alpha, "task-alpha should be readable");
      assert.equal(alpha.title, "Alpha Task");

      const workItems = store.listWorkItems("task-alpha");
      assert.equal(workItems.length, 1);
      assert.equal(workItems[0].title, "Implement");

      const events = store.listEvents("task-alpha");
      assert.equal(events.length, 2);

      const runs = store.listAgentRuns("task-alpha");
      assert.equal(runs.length, 1);
      assert.equal(runs[0].id, "agent-run-1");

      const reviewRounds = store.listReviewRounds("task-alpha");
      assert.equal(reviewRounds.length, 1);

      const messages = store.listMessages("task-alpha");
      assert.equal(messages.length, 1);
      assert.equal(messages[0].body, "Hello");

      // Active run pointer migrated.
      const activeRun = store.getActiveAgentRun("task-alpha", "leader");
      assert.ok(activeRun, "active run pointer should be migrated");
      assert.equal(activeRun.id, "agent-run-1");

      // Config migrated.
      const config = store.getConfig();
      assert.equal(config.timeZone, "UTC");

      // Home meta: revision.
      assert.equal(store.getRevision(), state.revision);

      // Global role and sessions.
      const globalRoles = store.listGlobalRoles();
      assert.equal(globalRoles.length, 1);
      const globalSets = store.listGlobalRoleSessionSets();
      assert.equal(globalSets.length, 1);

      // Managed workspace and role session set.
      const workspaces = store.listManagedWorkspaces("task-alpha");
      assert.equal(workspaces.length, 1);
      const sessionSets = store.listRoleSessionSets("task-alpha");
      assert.equal(sessionSets.length, 1);

      // Brief, change set, integration attempt.
      const brief = store.getTaskBrief("task-alpha");
      assert.ok(brief, "brief should be migrated");
      assert.equal(brief.objective, "Build the feature");
      assert.equal(store.listChangeSets("task-alpha").length, 1);
      assert.equal(store.listIntegrationAttempts("task-alpha").length, 1);

      // Durable Controller state must survive the document-to-database cutover.
      const jobs = store.listDurableJobs("task-alpha");
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].id, "job-1");
      assert.equal(jobs[0].env.YUI_CHECK, "migration");
      assert.equal(
        store.getJobCallerKeyHash("task-alpha", "leader", "codex"),
        "a".repeat(64)
      );

      // Leader failure and operator notification.
      const failure = store.getLeaderFailure("task-alpha");
      assert.ok(failure, "leader failure should be migrated");
      assert.equal(failure.message, "failed");
      const notification = store.getOperatorNotification("task-alpha");
      assert.ok(notification, "operator notification should be migrated");
    } finally {
      store.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// -- 2. failure rollback: checksum mismatch ----------------------------------

test("checksum mismatch aborts migration and leaves state.json untouched at layout 6", () => {
  const { home, state } = setupLayout6Home();
  try {
    const stateHashBefore = sha256File(join(home, "state.json"));

    const target = createSqliteMigrationTarget({
      home, latest: LATEST, registry: REGISTRY
    });

    // Stage the db.
    const snapshot = target.readSource();
    target.writeFreshOutput(snapshot);

    // Corrupt the staged db by deleting an event row directly.
    {
      const db = new Database(join(home, STAGED_DATABASE_FILENAME));
      try {
        db.prepare("DELETE FROM events WHERE task_id = ? AND event_id = ?").run("task-alpha", "event-2");
      } finally {
        db.close();
      }
    }

    // Verification must fail.
    assert.throws(
      () => target.validateCurrentState(),
      /checksum mismatch/
    );

    // Discard the staged output (the engine does this on failure).
    target.discardFreshOutput();

    // state.json is byte-for-byte unchanged.
    assert.equal(sha256File(join(home, "state.json")), stateHashBefore);

    // schema.json is still layout 6.
    assert.equal(readManifest(home).storageVersion, 6);

    // No yui.db was committed.
    assert.ok(!existsSync(join(home, COMMITTED_DATABASE_FILENAME)));

    // The state is intact.
    const stateAfter = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    assert.equal(stateAfter.revision, state.revision);
    assert.equal(stateAfter.tasks["task-alpha"].task.title, "Alpha Task");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("verifySqliteChecksums throws on corrupted staged database", () => {
  const { home, state } = setupLayout6Home();
  try {
    populateSqliteFromState(home, state, STAGED_DATABASE_FILENAME);

    // Tamper with the staged db: modify an event type.
    {
      const db = new Database(join(home, STAGED_DATABASE_FILENAME));
      try {
        const row = db.prepare("SELECT payload FROM events WHERE task_id = ? AND event_id = ?")
          .get("task-alpha", "event-1");
        const event = JSON.parse(row.payload);
        event.type = "task.tampered";
        db.prepare("UPDATE events SET payload = ? WHERE task_id = ? AND event_id = ?")
          .run(JSON.stringify(event), "task-alpha", "event-1");
      } finally {
        db.close();
      }
    }

    assert.throws(
      () => verifySqliteChecksums(state, home, STAGED_DATABASE_FILENAME),
      /checksum mismatch/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// -- 3. rollback drill -------------------------------------------------------

test("rollback quarantines yui.db and restores layout 6 with state.json intact", () => {
  const { home, state } = setupLayout6Home();
  try {
    const stateHashBefore = sha256File(join(home, "state.json"));

    // Migrate to layout 7.
    const target = createSqliteMigrationTarget({
      home, latest: LATEST, registry: REGISTRY
    });
    const report = runMigration({
      registry: REGISTRY, target, latest: LATEST, mode: "execute"
    });
    assert.equal(report.outcome, "migrated");
    assert.equal(readManifest(home).storageVersion, 7);
    assert.ok(existsSync(join(home, COMMITTED_DATABASE_FILENAME)));

    // Rollback.
    const quarantinePath = rollbackSqliteMigration(home);

    // yui.db is quarantined (renamed, not deleted).
    assert.ok(!existsSync(join(home, COMMITTED_DATABASE_FILENAME)), "yui.db should be quarantined");
    assert.ok(existsSync(quarantinePath), "quarantine file should exist");

    // schema.json is back to layout 6.
    assert.equal(readManifest(home).storageVersion, 6);

    // state.json is intact.
    assert.equal(sha256File(join(home, "state.json")), stateHashBefore);
    const stateAfter = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
    assert.equal(stateAfter.revision, state.revision);
    assert.equal(stateAfter.tasks["task-alpha"].task.title, "Alpha Task");

    // The Home can be re-migrated (idempotent after rollback).
    const target2 = createSqliteMigrationTarget({
      home, latest: LATEST, registry: REGISTRY
    });
    const report2 = runMigration({
      registry: REGISTRY, target: target2, latest: LATEST, mode: "execute"
    });
    assert.equal(report2.outcome, "migrated");
    assert.equal(readManifest(home).storageVersion, 7);
    assert.ok(existsSync(join(home, COMMITTED_DATABASE_FILENAME)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// -- 4. idempotent re-run ----------------------------------------------------

test("interrupted staged run is idempotent: re-stage produces no duplicates", () => {
  const { home, state } = setupLayout6Home();
  try {
    const target = createSqliteMigrationTarget({
      home, latest: LATEST, registry: REGISTRY
    });

    // First stage.
    const snapshot = target.readSource();
    target.writeFreshOutput(snapshot);

    // Record checksums from the first stage.
    const firstChecksums = computeDbFamilyChecksums(home, STAGED_DATABASE_FILENAME);

    // Simulate interruption: discard the staged output.
    target.discardFreshOutput();
    assert.ok(!existsSync(join(home, STAGED_DATABASE_FILENAME)));

    // Re-stage (idempotent).
    target.discardFreshOutput(); // ensure clean
    target.writeFreshOutput(snapshot);

    // Checksums from the second stage match the first.
    const secondChecksums = computeDbFamilyChecksums(home, STAGED_DATABASE_FILENAME);
    assert.deepEqual(secondChecksums, firstChecksums);

    // Verify against state.json.
    verifySqliteChecksums(state, home, STAGED_DATABASE_FILENAME);

    // Complete the migration.
    const switchOutcome = target.atomicSwitchWithBackup();
    assert.equal(switchOutcome.status, "switched");
    assert.equal(readManifest(home).storageVersion, 7);

    // Read back and verify no duplicates.
    const store = new SqliteTaskStore(home);
    try {
      assert.equal(store.listTasks().length, 1);
      assert.equal(store.listWorkItems("task-alpha").length, 1);
      assert.equal(store.listEvents("task-alpha").length, 2);
      assert.equal(store.listAgentRuns("task-alpha").length, 1);
      assert.equal(store.listReviewRounds("task-alpha").length, 1);
      assert.equal(store.listMessages("task-alpha").length, 1);
      assert.equal(store.listWorkMailboxes().length, 1);
      assert.equal(store.listProjects().length, 1);
      assert.equal(store.listConfiguredAgents().length, 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// -- 5. four-state classification --------------------------------------------

test("four-state classification: layout-6 healthy = MIGRATABLE, layout-7 = USABLE, corrupted = CORRUPTED", () => {
  const { home } = setupLayout6Home();
  try {
    // Layout-6 healthy Home → MIGRATABLE.
    const before = classifyHome({ home, registry: REGISTRY, latest: LATEST });
    assert.equal(before.classification.verdict, "MIGRATABLE",
      `expected MIGRATABLE, got ${before.classification.verdict}: ${before.classification.detail ?? ""}`);
    assert.equal(before.layoutVersion, 6);

    // Migrate to layout 7.
    const target = createSqliteMigrationTarget({
      home, latest: LATEST, registry: REGISTRY
    });
    const report = runMigration({
      registry: REGISTRY, target, latest: LATEST, mode: "execute"
    });
    assert.equal(report.outcome, "migrated");

    // Layout-7 healthy db → USABLE.
    const after = classifyHome({ home, registry: REGISTRY, latest: LATEST });
    assert.equal(after.classification.verdict, "USABLE",
      `expected USABLE, got ${after.classification.verdict}: ${after.classification.detail ?? ""}`);
    assert.equal(after.layoutVersion, 7);

    // Corrupt yui.db → CORRUPTED.
    const dbPath = join(home, COMMITTED_DATABASE_FILENAME);
    writeFileSync(dbPath, "this is not a valid sqlite database" + "\0".repeat(100));

    const corrupted = classifyHome({ home, registry: REGISTRY, latest: LATEST });
    assert.equal(corrupted.classification.verdict, "CORRUPTED",
      `expected CORRUPTED, got ${corrupted.classification.verdict}: ${corrupted.classification.detail ?? ""}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// -- 6. §8.4 invariants: evidence and sessions preserved ---------------------

test("evidence (events, review rounds, change sets, integration attempts) and sessions are preserved row-for-record", () => {
  const { home } = setupLayout6Home();
  try {
    const target = createSqliteMigrationTarget({
      home, latest: LATEST, registry: REGISTRY
    });
    const report = runMigration({
      registry: REGISTRY, target, latest: LATEST, mode: "execute"
    });
    assert.equal(report.outcome, "migrated");

    const store = new SqliteTaskStore(home);
    try {
      // Evidence families: row-for-record counts.
      assert.equal(store.listEvents("task-alpha").length, 2, "events preserved");
      assert.equal(store.listReviewRounds("task-alpha").length, 1, "review rounds preserved");
      assert.equal(store.listChangeSets("task-alpha").length, 1, "change sets preserved");
      assert.equal(store.listIntegrationAttempts("task-alpha").length, 1, "integration attempts preserved");

      // Sessions: managed workspaces and role session sets migrated verbatim.
      const workspaces = store.listManagedWorkspaces("task-alpha");
      assert.equal(workspaces.length, 1, "managed workspaces preserved");
      assert.equal(workspaces[0].root, join(home, "ws-1"));

      const sessionSets = store.listRoleSessionSets("task-alpha");
      assert.equal(sessionSets.length, 1, "role session sets preserved");

      // Global role session sets.
      const globalSets = store.listGlobalRoleSessionSets();
      assert.equal(globalSets.length, 1, "global role session sets preserved");

      // Leader failure and operator notification.
      const failure = store.getLeaderFailure("task-alpha");
      assert.ok(failure, "leader failure preserved");
      assert.equal(failure.message, "failed");

      const notification = store.getOperatorNotification("task-alpha");
      assert.ok(notification, "operator notification preserved");
    } finally {
      store.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
