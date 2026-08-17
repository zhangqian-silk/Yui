/**
 * Tests for the pseudo-layout-7 repair and Home-decided SQLite activation
 * (Issue 01).
 *
 * A pseudo-layout-7 Home declares layout 7 in `schema.json` but has no
 * `yui.db`; `state.json` is still the only authoritative copy. Covers:
 *  1. Classification: pseudo-layout-7 → NEEDS_STORAGE_REPAIR; the three
 *     physical-backend violations each get a distinct, deterministic verdict.
 *  2. Dry-run repair stages and verifies without promoting.
 *  3. Execute repair: staged promotion, receipt, read-back, state.json archive.
 *  4. Explicit rollback restores the layout-6 File store without revision loss.
 *  5. Home-decided backend and worker resolution (no env opt-in needed).
 *  6. The compatibility opener and doctor surface the SQLite backend.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { FileTaskStore } from "../dist/storage/taskStore.js";
import { SqliteTaskStore } from "../dist/storage/sqliteStore.js";
import {
  resolveTaskStoreBackendForHome
} from "../dist/storage/sqliteStore.js";
import { resolveStoreWorkerEnabledForHome } from "../dist/storage/storeRpc.js";
import { openCompatibleFileTaskStore } from "../dist/storage/compatibleTaskStore.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { createProductionStorageRegistry } from "../dist/storage/migration/productionRegistry.js";
import { latestStorageVersionState } from "../dist/storage/upgrade/recordVersions.js";
import { classifyHome } from "../dist/storage/upgrade/homeClassification.js";
import { repairPseudoLayout7 } from "../dist/storage/upgrade/pseudoLayoutRepair.js";
import {
  latestStateBackupPath,
  listStateBackups
} from "../dist/storage/upgrade/pseudoLayoutRepair.js";
import {
  rollbackSqliteMigration
} from "../dist/storage/upgrade/sqliteMigrationTarget.js";
import { createSqliteMigrationTarget } from "../dist/storage/upgrade/sqliteMigrationTarget.js";
import { runMigration } from "../dist/storage/migration/index.js";
import {
  readMigrationReceipt,
  writeMigrationReceipt
} from "../dist/storage/upgrade/migrationReceipt.js";
import {
  computeDbFamilyChecksums,
  computeStateFamilyChecksums,
  COMMITTED_DATABASE_FILENAME,
  STAGED_DATABASE_FILENAME
} from "../dist/storage/upgrade/sqliteStateMigration.js";
import { buildDoctorReport } from "../dist/doctor/doctor.js";
import { createDurableJob } from "../dist/job/durableJob.js";

const LATEST = latestStorageVersionState();
const REGISTRY = createProductionStorageRegistry();
const NOW = "2026-08-17T12:00:00.000Z";

// -- helpers ----------------------------------------------------------------

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), "yui-pseudo-layout7-"));
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
 * Build a rich, current Home via FileTaskStore (every record has the exact
 * shape production expects) and KEEP the layout-7 manifest. With no `yui.db`
 * on disk this is exactly a pseudo-layout-7 Home: manifest claims SQLite WAL,
 * `state.json` is the only authoritative copy.
 */
function setupPseudoLayout7Home() {
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
    schemaVersion: 6,
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

  const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
  return { home, store, state };
}

function classify(home) {
  return classifyHome({ home, registry: REGISTRY, latest: LATEST });
}

function setLayout(home, version) {
  const manifestPath = join(home, "schema.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.storageVersion = version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ---------------------------------------------------------------------------
// 1. Classification: the physical-backend invariant
// ---------------------------------------------------------------------------

test("classification: pseudo-layout-7 (manifest 7, no yui.db, readable state.json) is NEEDS_STORAGE_REPAIR", () => {
  const { home } = setupPseudoLayout7Home();
  const result = classify(home);
  assert.equal(result.classification.verdict, "NEEDS_STORAGE_REPAIR");
  assert.equal(result.classification.status, "needs-storage-repair");
  assert.match(result.classification.detail, /pseudo-layout-7/);
});

test("classification: layout 7 without yui.db and without state.json is CORRUPTED", () => {
  const { home } = setupPseudoLayout7Home();
  rmSync(join(home, "state.json"));
  const result = classify(home);
  assert.equal(result.classification.verdict, "CORRUPTED");
  assert.match(result.classification.detail, /no authoritative backend/);
});

test("classification: layout 7 with a damaged yui.db is CORRUPTED", () => {
  const { home } = setupPseudoLayout7Home();
  writeFileSync(join(home, COMMITTED_DATABASE_FILENAME), "this is not a sqlite database");
  const result = classify(home);
  assert.equal(result.classification.verdict, "CORRUPTED");
  assert.match(result.classification.detail, /SQLite/);
});

test("classification: layout 7 with state.json and yui.db but no receipt is a dual-copy conflict", () => {
  const { home } = setupPseudoLayout7Home();
  // A healthy yui.db alongside state.json, with no migration receipt.
  const sqlite = new SqliteTaskStore(mkdtempSync(join(tmpdir(), "yui-db-donor-")));
  sqlite.close();
  // Build a real empty database in the home instead of a donor copy.
  const seeded = new SqliteTaskStore(home);
  seeded.close();
  assert.ok(existsSync(join(home, COMMITTED_DATABASE_FILENAME)));
  assert.ok(existsSync(join(home, "state.json")));
  assert.equal(readMigrationReceipt(home), null);
  const result = classify(home);
  assert.equal(result.classification.verdict, "CORRUPTED");
  assert.match(result.classification.detail, /ambiguous/);
});

test("classification: repaired Home (yui.db + receipt, state.json archived) is USABLE", () => {
  const { home } = setupPseudoLayout7Home();
  const result = repairPseudoLayout7({ home, latest: LATEST, mode: "execute" });
  assert.equal(result.outcome, "repaired");
  assert.ok(!existsSync(join(home, "state.json")), "state.json archived");
  assert.ok(existsSync(join(home, COMMITTED_DATABASE_FILENAME)));
  assert.notEqual(readMigrationReceipt(home), null);
  const after = classify(home);
  assert.equal(after.classification.verdict, "USABLE");
});

// ---------------------------------------------------------------------------
// 2. Dry-run repair
// ---------------------------------------------------------------------------

test("dry-run: stages and verifies but promotes nothing", () => {
  const { home } = setupPseudoLayout7Home();
  const stateBefore = sha256File(join(home, "state.json"));
  const result = repairPseudoLayout7({ home, latest: LATEST, mode: "dry-run" });
  assert.equal(result.outcome, "dry-run");
  assert.ok(result.verifiedFamilies >= 10);
  assert.equal(result.sourceRevision, JSON.parse(
    readFileSync(join(home, "state.json"), "utf8")
  ).revision);
  assert.ok(!existsSync(join(home, COMMITTED_DATABASE_FILENAME)), "no promoted database");
  assert.ok(!existsSync(join(home, STAGED_DATABASE_FILENAME)), "staged database discarded");
  assert.equal(readMigrationReceipt(home), null, "no receipt written");
  assert.equal(sha256File(join(home, "state.json")), stateBefore, "state.json untouched");
});

// ---------------------------------------------------------------------------
// 3. Execute repair
// ---------------------------------------------------------------------------

test("execute: promotes yui.db, writes receipt, archives state.json, read-back matches", () => {
  const { home, state } = setupPseudoLayout7Home();
  const sourceRevision = state.revision;
  const result = repairPseudoLayout7({ home, latest: LATEST, mode: "execute" });
  assert.equal(result.outcome, "repaired");
  assert.equal(result.sourceRevision, sourceRevision);

  // The database exists and is healthy; state.json moved to a timestamped backup.
  assert.ok(existsSync(join(home, COMMITTED_DATABASE_FILENAME)));
  assert.ok(!existsSync(join(home, "state.json")));
  const backups = listStateBackups(home);
  assert.equal(backups.length, 1);
  assert.equal(latestStateBackupPath(home), backups[0]);

  // The persistent receipt certifies the switch.
  const receipt = readMigrationReceipt(home);
  assert.notEqual(receipt, null);
  assert.equal(receipt.kind, "pseudo-layout-7-repair");
  assert.equal(receipt.sourceRevision, sourceRevision);
  assert.equal(receipt.targetLayoutVersion, LATEST.layout);

  // Read-back through a fresh SQLite store: every family matches the backup.
  const backupState = JSON.parse(readFileSync(backups[0]), "utf8");
  const expected = computeStateFamilyChecksums(backupState);
  const actual = computeDbFamilyChecksums(home, COMMITTED_DATABASE_FILENAME);
  for (const family of Object.keys(expected)) {
    assert.equal(actual[family].count, expected[family].count, `family ${family} count`);
    assert.equal(actual[family].hash, expected[family].hash, `family ${family} hash`);
  }

  const store = new SqliteTaskStore(home);
  try {
    assert.equal(store.getRevision(), sourceRevision);
    assert.equal(store.listTasks().length, 1);
    assert.equal(store.listProjects().length, 1);
    assert.equal(store.listConfiguredAgents().length, 1);
    assert.equal(store.listWorkMailboxes().length, 1);
  } finally {
    store.close();
  }
});

test("execute: staged WAL/SHM sidecars are removed after promotion", () => {
  const { home } = setupPseudoLayout7Home();
  const result = repairPseudoLayout7({ home, latest: LATEST, mode: "execute" });
  assert.equal(result.outcome, "repaired");

  // The staged database and its WAL/SHM sidecars must not linger.
  assert.ok(!existsSync(join(home, STAGED_DATABASE_FILENAME)));
  assert.ok(!existsSync(join(home, `${STAGED_DATABASE_FILENAME}-wal`)));
  assert.ok(!existsSync(join(home, `${STAGED_DATABASE_FILENAME}-shm`)));
});

test("execute: a stale staged database from a crashed attempt is rebuilt, never reused", () => {
  const { home } = setupPseudoLayout7Home();
  writeFileSync(join(home, STAGED_DATABASE_FILENAME), "garbage from a crashed attempt");
  const result = repairPseudoLayout7({ home, latest: LATEST, mode: "execute" });
  assert.equal(result.outcome, "repaired");
  assert.ok(existsSync(join(home, COMMITTED_DATABASE_FILENAME)));
});

test("execute: refuses to rebuild over an existing yui.db", () => {
  const { home } = setupPseudoLayout7Home();
  const seeded = new SqliteTaskStore(home);
  seeded.close();
  const result = repairPseudoLayout7({ home, latest: LATEST, mode: "execute" });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "validate");
  assert.match(result.message, /already exists/);
});

test("execute: malformed state.json blocks the repair and leaves the Home unchanged", () => {
  const { home } = setupPseudoLayout7Home();
  writeFileSync(join(home, "state.json"), "{ not json");
  const result = repairPseudoLayout7({ home, latest: LATEST, mode: "execute" });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "validate");
  assert.ok(!existsSync(join(home, COMMITTED_DATABASE_FILENAME)));
  assert.ok(!existsSync(join(home, STAGED_DATABASE_FILENAME)));
});

// ---------------------------------------------------------------------------
// 4. Explicit rollback
// ---------------------------------------------------------------------------

test("rollback: restores state.json from the backup and reopens the layout-6 File store", () => {
  const { home, state } = setupPseudoLayout7Home();
  const sourceRevision = state.revision;
  const stateChecksums = computeStateFamilyChecksums(state);
  const repair = repairPseudoLayout7({ home, latest: LATEST, mode: "execute" });
  assert.equal(repair.outcome, "repaired");

  rollbackSqliteMigration(home, { now: () => new Date(NOW) });

  // The layout-6 File store is authoritative again, at the same revision. This
  // release's FileTaskStore requires layout 7, so (like the 6→7 rollback
  // drill) the restored document is verified directly and by re-repair.
  assert.ok(existsSync(join(home, "state.json")), "state.json restored");
  assert.ok(!existsSync(join(home, COMMITTED_DATABASE_FILENAME)), "yui.db quarantined");
  assert.equal(readMigrationReceipt(home), null, "receipt removed");
  const manifest = JSON.parse(readFileSync(join(home, "schema.json"), "utf8"));
  assert.equal(manifest.storageVersion, 6);

  const restoredState = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
  assert.equal(restoredState.revision, sourceRevision);
  assert.equal(restoredState.tasks["task-alpha"].task.title, "Alpha Task");
  const restoredChecksums = computeStateFamilyChecksums(restoredState);
  for (const family of Object.keys(stateChecksums)) {
    assert.equal(restoredChecksums[family].count, stateChecksums[family].count, `family ${family} count`);
    assert.equal(restoredChecksums[family].hash, stateChecksums[family].hash, `family ${family} hash`);
  }

  // The Home can be re-upgraded through the normal 6→7 migration (the
  // rollback restored an exact layout-6 source, so the repair no longer
  // applies; the version-migration engine is the recovery path).
  const target = createSqliteMigrationTarget({ home, latest: LATEST, registry: REGISTRY });
  const reMigrated = runMigration({ registry: REGISTRY, target, latest: LATEST, mode: "execute" });
  assert.equal(reMigrated.outcome, "migrated");
  assert.ok(existsSync(join(home, COMMITTED_DATABASE_FILENAME)));
});

test("rollback: a committed layout-6→7 migration leaves state.json untouched and clears the receipt", () => {
  const { home } = setupPseudoLayout7Home();
  setLayout(home, 6);
  // Run the real 6→7 migration, which retains state.json read-only in place.
  const target = createSqliteMigrationTarget({ home, latest: LATEST, registry: REGISTRY });
  const report = runMigration({ registry: REGISTRY, target, latest: LATEST, mode: "execute" });
  assert.equal(report.outcome, "migrated");
  assert.ok(existsSync(join(home, COMMITTED_DATABASE_FILENAME)));
  assert.ok(existsSync(join(home, "state.json")), "6→7 migration retains state.json");
  writeMigrationReceipt(home, {
    kind: "layout6-to-7",
    completedAt: NOW,
    sourceRevision: JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision,
    targetLayoutVersion: 7,
    sourceStateSha256: sha256File(join(home, "state.json")),
    verifiedFamilies: 10
  });
  const stateBefore = sha256File(join(home, "state.json"));

  rollbackSqliteMigration(home, { now: () => new Date(NOW) });

  assert.equal(sha256File(join(home, "state.json")), stateBefore, "state.json untouched");
  assert.ok(!existsSync(join(home, COMMITTED_DATABASE_FILENAME)));
});

// ---------------------------------------------------------------------------
// 5. Home-decided backend and worker resolution
// ---------------------------------------------------------------------------

test("backend resolution: a layout-7 Home opens SQLite without any env opt-in", () => {
  const { home } = setupPseudoLayout7Home();
  assert.equal(resolveTaskStoreBackendForHome(home, {}), "sqlite");
  assert.equal(resolveTaskStoreBackendForHome(home, { YUI_STORE_BACKEND: "file" }), "file");
  assert.equal(resolveTaskStoreBackendForHome(home, { YUI_STORE_BACKEND: "sqlite" }), "sqlite");
});

test("backend resolution: a layout-6 Home opens the file store", () => {
  const { home } = setupPseudoLayout7Home();
  setLayout(home, 6);
  assert.equal(resolveTaskStoreBackendForHome(home, {}), "file");
  assert.equal(resolveTaskStoreBackendForHome(home, { YUI_STORE_BACKEND: "sqlite" }), "sqlite");
});

test("worker resolution: Home-decided SQLite runs the worker by default", () => {
  const { home } = setupPseudoLayout7Home();
  assert.equal(resolveStoreWorkerEnabledForHome(home, {}), true);
  assert.equal(resolveStoreWorkerEnabledForHome(home, { YUI_STORE_WORKER: "0" }), false);
  assert.equal(resolveStoreWorkerEnabledForHome(home, { YUI_STORE_WORKER: "false" }), false);
  assert.equal(resolveStoreWorkerEnabledForHome(home, { YUI_STORE_WORKER: "1" }), true);
});

test("worker resolution: env-decided SQLite keeps the historical opt-in", () => {
  const { home } = setupPseudoLayout7Home();
  setLayout(home, 6);
  assert.equal(
    resolveStoreWorkerEnabledForHome(home, { YUI_STORE_BACKEND: "sqlite" }),
    false,
    "env-decided sqlite without YUI_STORE_WORKER stays in-process"
  );
  assert.equal(
    resolveStoreWorkerEnabledForHome(home, { YUI_STORE_BACKEND: "sqlite", YUI_STORE_WORKER: "1" }),
    true
  );
  assert.equal(resolveStoreWorkerEnabledForHome(home, {}), false, "file store never uses the worker");
});

// ---------------------------------------------------------------------------
// 6. Compatibility opener and doctor surface the SQLite backend
// ---------------------------------------------------------------------------

test("compatibility opener: a repaired Home opens the SQLite store directly", () => {
  const { home } = setupPseudoLayout7Home();
  const repair = repairPseudoLayout7({ home, latest: LATEST, mode: "execute" });
  assert.equal(repair.outcome, "repaired");
  const store = openCompatibleFileTaskStore(home);
  assert.ok(store instanceof SqliteTaskStore);
  assert.equal(store.listTasks().length, 1);
  assert.equal(store.getRevision(), repair.sourceRevision);
  store.close();
});

test("compatibility opener: a pseudo-layout-7 Home still opens the File store pre-repair", () => {
  const { home } = setupPseudoLayout7Home();
  const store = openCompatibleFileTaskStore(home);
  assert.ok(store instanceof FileTaskStore);
  assert.equal(store.listTasks().length, 1);
});

test("doctor: reports the physical-backend facts for a repaired Home", () => {
  const { home } = setupPseudoLayout7Home();
  const repair = repairPseudoLayout7({ home, latest: LATEST, mode: "execute" });
  assert.equal(repair.outcome, "repaired");
  const executor = { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) };
  const report = buildDoctorReport({ ...process.env, YUI_HOME: home }, executor);
  const details = report.storage.details;
  assert.notEqual(details, undefined);
  assert.equal(details.logicalLayout, LATEST.layout);
  assert.equal(details.authoritativeBackend, "sqlite");
  assert.equal(details.databasePath, join(home, COMMITTED_DATABASE_FILENAME));
  assert.equal(details.journalMode, "wal");
  assert.equal(details.workerEnabled, true);
  assert.notEqual(details.migrationReceipt, null);
  assert.equal(details.migrationReceipt.kind, "pseudo-layout-7-repair");
  assert.equal(details.lastCommittedRevision, repair.sourceRevision);
});

test("doctor: a pseudo-layout-7 Home is flagged needs-storage-repair with file backend facts", () => {
  const { home } = setupPseudoLayout7Home();
  const executor = { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) };
  const report = buildDoctorReport({ ...process.env, YUI_HOME: home }, executor);
  const stateCheck = report.checks.find((check) => check.name === "storage compatibility");
  assert.notEqual(stateCheck, undefined);
  // Diagnostic mode (Issue 01 rollout step 1): the Home is readable and
  // usable, so the compatibility check stays ok while the repair need is
  // surfaced in the detail.
  assert.equal(stateCheck.status, "ok");
  assert.match(stateCheck.detail, /needs-storage-repair/);
  const details = report.storage.details;
  assert.equal(details.authoritativeBackend, "sqlite", "layout 7 still resolves to SQLite");
  assert.equal(details.databasePath, null, "no database yet");
  assert.equal(details.journalMode, null);
  assert.equal(details.workerEnabled, true);
  assert.equal(details.migrationReceipt, null);
});
