import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureStorageSchema,
  CURRENT_STORAGE_LAYOUT_VERSION,
  CURRENT_AGGREGATE_SCHEMA_VERSION
} from "../dist/storage/storageSchema.js";
import {
  FileTaskStore,
  CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION,
  CURRENT_AGENT_RUN_SCHEMA_VERSION,
  CURRENT_CONFIG_SCHEMA_VERSION,
  CURRENT_STORED_TASK_SCHEMA_VERSION,
  CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION
} from "../dist/storage/taskStore.js";
import { MigrationRegistry, createEmptyRegistry, planMigration, runMigration } from "../dist/storage/migration/index.js";
import { createProductionRegistry } from "../dist/storage/migration/productionRegistry.js";
import {
  latestStorageVersionState,
  currentRecordVersions,
  assertRecordVersionDescriptors
} from "../dist/storage/upgrade/recordVersions.js";
import { classifyHome } from "../dist/storage/upgrade/homeClassification.js";
import { runStorageUpgrade } from "../dist/storage/upgrade/upgradeOrchestrator.js";
import { createSqliteMigrationTarget } from "../dist/storage/upgrade/sqliteMigrationTarget.js";
import {
  inspectHomeRuntime,
  homeRuntimeIsActive,
  inspectSourceVersionState
} from "../dist/storage/upgrade/homeMigrationTarget.js";
import { scanSourceRecordVersions } from "../dist/storage/upgrade/recordVersionScan.js";
import {
  readUpgradeReceipt,
  writeUpgradeReceipt,
  clearUpgradeReceipt,
  upgradeReceiptPath
} from "../dist/storage/upgrade/upgradeReceipt.js";
import { runUpdate } from "../dist/cli/updateOrchestrator.js";
import { createUpdatePorts } from "../dist/cli/updatePorts.js";
import { createConfiguredAgent } from "../dist/agent/agent.js";
import { resolveEffectiveLaunch } from "../dist/executor/effectiveLaunch.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../dist/executor/agentExecutor.js";
import { createAgentRun } from "../dist/run/agentRun.js";
import { createRole, createRoleAgentBinding } from "../dist/role/role.js";
import { CURRENT_LEADER_FAILURE_SCHEMA_VERSION, recordLeaderFailure } from "../dist/scheduler/leaderFailure.js";
import {
  CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION,
  createLeaderRecoveryNotification
} from "../dist/scheduler/operatorNotification.js";
import {
  ensureFileTaskControllerIdentity
} from "../dist/controller/clientRuntime.js";
import { callController, ControllerClientError } from "../dist/core/controllerClient.js";
import { FILE_TASK_CONTROLLER_PROTOCOL_VERSION } from "../dist/core/protocol.js";
import { createTask } from "../dist/task/task.js";

// ---------------------------------------------------------------------------
// Shared isolation helpers — every fixture Home MUST live under the OS temp dir.
// ---------------------------------------------------------------------------

/** A fresh, current, loadable Home under a temp base directory. */
function currentHome() {
  const base = mkdtempSync(join(tmpdir(), "yui-p1-"));
  const home = join(base, "home");
  assert.ok(home.startsWith(tmpdir()), `test Home must be under the temp dir, got ${home}`);
  mkdirSync(home, { recursive: true });
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  store.saveConfig({ ...store.getConfig(), timeZone: "UTC" });
  return { base, home };
}

/**
 * Issue 01: promote a file-backend fixture Home to a healthy layout-7 Home
 * (yui.db + persistent receipt, state.json retained) through the real 6→7
 * staged migration, so the fixture is a genuine current Home rather than a
 * pseudo-layout-7 one. The records already persisted to state.json ride
 * through the migration into yui.db.
 */
function migrateFixtureToLayout7(home) {
  const manifest = JSON.parse(readFileSync(join(home, "schema.json"), "utf8"));
  manifest.storageVersion = 6;
  writeFileSync(join(home, "schema.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const migrationTarget = createSqliteMigrationTarget({
    home,
    latest: latestStorageVersionState(),
    registry: createProductionRegistry()
  });
  const migration = runMigration({
    registry: createProductionRegistry(),
    target: migrationTarget,
    latest: latestStorageVersionState(),
    mode: "execute"
  });
  assert.equal(migration.outcome, "migrated");
  return home;
}

/**
 * Build a valid, non-empty current Home through the domain/store APIs. Keeping
 * both records real is important: a current-version map must not only classify
 * empty families as current.
 */
function currentHomeWithTaskRoleRecords() {
  const fixture = currentHome();
  const now = new Date("2026-08-07T00:00:00.000Z");
  const store = new FileTaskStore(fixture.home);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  const task = createTask("task-1", "Record-version fixture", now);
  store.saveTask(task);
  const role = createRole(
    task.id,
    "worker",
    [createRoleAgentBinding(agent)],
    agent.id,
    fixture.home,
    now
  );
  store.saveRole(task.id, role);
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  let sessions = createRoleSessionSet(
    { scope: "task", taskId: task.id, roleName: role.name },
    agent.id,
    now
  );
  sessions = recordRoleAgentSession(sessions, {
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: "native-record-version-fixture",
    policy: "fixed",
    status: "ready",
    effective
  }, now);
  store.saveTaskRoleSessionSet(sessions);
  const run = createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    role.name,
    "new",
    "Record-version fixture run",
    now,
    { effective }
  );
  store.saveActiveAgentRun(run);
  return { ...fixture, taskId: task.id, roleName: role.name, runId: run.id };
}

/** Add valid non-null singleton records to exercise every StoredTask boundary. */
function currentHomeWithBoundaryRecords() {
  const fixture = currentHomeWithTaskRoleRecords();
  const now = new Date("2026-08-07T00:01:00.000Z");
  const store = new FileTaskStore(fixture.home);
  store.saveLeaderFailure(recordLeaderFailure(
    fixture.taskId,
    "native-record-version-fixture",
    "record-version fixture failure",
    now,
    null
  ));
  store.saveOperatorNotification(createLeaderRecoveryNotification(
    fixture.taskId,
    "record-version fixture notification",
    now,
    null
  ));
  return fixture;
}

/** Read + mutate + write the raw state.json (bypassing the strict store). */
function editState(home, mutate) {
  const path = join(home, "state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  mutate(state);
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Keep a valid fixture's durable record-version declaration in sync. */
function setManifestRecordVersion(home, recordKind, schemaVersion) {
  const path = join(home, "schema.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.recordVersions[recordKind] = schemaVersion;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Install a syntactically-valid ConfiguredAgent record at a chosen version. */
function setConfiguredAgent(home, schemaVersion) {
  editState(home, (state) => {
    state.configuredAgents = {
      claude: {
        schemaVersion,
        id: "claude",
        adapterId: "claude",
        command: "claude",
        baseArgs: [],
        environment: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    };
  });
  setManifestRecordVersion(home, "configuredAgent", schemaVersion);
}

const EMPTY = () => createEmptyRegistry();
const LATEST = () => latestStorageVersionState();

// ===========================================================================
// P1-1 — the record version axis is wired: a record-only-older Home is a
// version verdict, never a false CORRUPTED.
// ===========================================================================

test("P1-1 positive: a record-only-older Home is NEEDS_NEW_VERSION, not CORRUPTED", () => {
  const { home } = currentHome();
  setConfiguredAgent(home, 1); // configuredAgent latest is 2; scalar axes current.
  const result = classifyHome({ home, registry: EMPTY(), latest: LATEST() });
  assert.equal(result.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(result.classification.blocker.reason, "missing-step");
  assert.equal(result.classification.blocker.axis, "record");
  assert.equal(result.classification.blocker.recordKind, "configuredAgent");
  assert.equal(result.classification.blocker.from, 1);
  assert.equal(result.classification.blocker.to, 2);
});

test("P1-1 positive: a record-only-older Home with a registered step is MIGRATABLE", () => {
  const { home } = currentHome();
  setConfiguredAgent(home, 1);
  // A synthetic registry that supplies exactly the record step configuredAgent 1->2.
  const registry = new MigrationRegistry();
  registry.register({
    axis: "record",
    recordKind: "configuredAgent",
    fromVersion: 1,
    toVersion: 2,
    preconditions: () => {},
    transform: (snapshot) => ({ ...snapshot }),
    declaredEffects: []
  });
  const result = classifyHome({ home, registry, latest: LATEST() });
  assert.equal(result.classification.verdict, "MIGRATABLE");
  assert.equal(result.classification.stepCount, 1);
});

test("P1-1 positive: a mixed scalar+record-older Home plans in layout->aggregate->record order", () => {
  const { home } = currentHome();
  // aggregate one behind + configuredAgent one behind: a cross-axis plan.
  editState(home, (state) => { state.configuredAgents = {}; });
  setConfiguredAgent(home, 1);
  const latest = {
    layout: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregate: CURRENT_AGGREGATE_SCHEMA_VERSION + 1,
    record: currentRecordVersions()
  };
  const source = inspectSourceVersionState(home, latest);
  assert.ok("source" in source, "source versions were extracted, not a corruption");
  assert.equal(source.source.aggregate, CURRENT_AGGREGATE_SCHEMA_VERSION);
  assert.equal(source.source.record.configuredAgent.version, 1);

  const registry = new MigrationRegistry();
  registry.register({
    axis: "aggregate",
    fromVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    toVersion: CURRENT_AGGREGATE_SCHEMA_VERSION + 1,
    preconditions: () => {},
    transform: (s) => ({ ...s }),
    declaredEffects: []
  });
  registry.register({
    axis: "record",
    recordKind: "configuredAgent",
    fromVersion: 1,
    toVersion: 2,
    preconditions: () => {},
    transform: (s) => ({ ...s }),
    declaredEffects: []
  });
  const plan = planMigration(registry, source.source, latest);
  assert.equal(plan.kind, "runnable");
  assert.deepEqual(
    plan.steps.map((s) => `${s.axis}${s.recordKind ? `/${s.recordKind}` : ""}`),
    ["aggregate", "record/configuredAgent"]
  );
});

test("P1-1 negative: a structurally-broken state.json is still CORRUPTED", () => {
  const { home } = currentHome();
  writeFileSync(join(home, "state.json"), "{ not valid json");
  const result = classifyHome({ home, registry: EMPTY(), latest: LATEST() });
  assert.equal(result.classification.verdict, "CORRUPTED");
});

test("P1-1 negative: a record with a missing/invalid schemaVersion is CORRUPTED", () => {
  const { home } = currentHome();
  editState(home, (state) => {
    state.configuredAgents = { claude: { id: "claude" /* no schemaVersion */ } };
  });
  const result = classifyHome({ home, registry: EMPTY(), latest: LATEST() });
  assert.equal(result.classification.verdict, "CORRUPTED");
});

test("P1-1 negative: a record family NEWER than supported is future-version, not CORRUPTED", () => {
  const { home } = currentHome();
  setConfiguredAgent(home, 99);
  const result = classifyHome({ home, registry: EMPTY(), latest: LATEST() });
  assert.equal(result.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(result.classification.blocker.reason, "future-version");
  assert.equal(result.classification.blocker.axis, "record");
});

test("P1-1 scan: an absent/empty family is treated as already-latest", () => {
  const { home } = currentHome();
  editState(home, (state) => { state.configuredAgents = {}; });
  const scan = scanSourceRecordVersions(home, currentRecordVersions());
  assert.ok("record" in scan);
  // configuredAgent absent-on-disk collapses to the latest version (nothing to migrate).
  assert.equal(scan.record.configuredAgent.version, currentRecordVersions().configuredAgent.version);
});

test("P1-1 map completeness: current persisted workspace family is ManagedWorkspace", () => {
  const versions = currentRecordVersions();
  assert.deepEqual(
    Object.keys(versions).sort(),
    [
      "activeRunPointer", "agentProfile", "agentRun", "capabilityGrant", "changeSet", "config",
      "configuredAgent", "decision", "durableJob", "event", "globalRole", "globalRoleSessionSet",
      "inputRequest", "integrationAttempt", "integrationQueue", "leaderFailure", "managedWorkspace",
      "message", "milestone", "operatorNotification", "project", "releaseWorkflow", "reviewFinding",
      "reviewRound",
      "storedTask", "task", "taskBrief", "taskRole", "taskRoleSessionSet", "workItem",
      "workMailbox"
    ].sort()
  );
  assert.deepEqual(versions.managedWorkspace, {
    version: 2,
    path: "state.json#/tasks/*/managedWorkspaces"
  });
  assert.equal("roleWorkspace" in versions, false);
});

test("P2 map guard: current non-empty StorageState and StoredTask families are USABLE", async () => {
  const fixture = currentHomeWithBoundaryRecords();
  migrateFixtureToLayout7(fixture.home);
  const { home, taskId, roleName, runId } = fixture;
  const store = new FileTaskStore(home);
  assert.equal(store.getConfig().schemaVersion, CURRENT_CONFIG_SCHEMA_VERSION);
  assert.equal(store.getActiveAgentRun(taskId, roleName)?.id, runId);
  assert.equal(store.getLeaderFailure(taskId)?.schemaVersion, CURRENT_LEADER_FAILURE_SCHEMA_VERSION);
  assert.equal(
    store.getOperatorNotification(taskId)?.schemaVersion,
    CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION
  );

  const versions = currentRecordVersions();
  assert.deepEqual(versions.config, {
    version: CURRENT_CONFIG_SCHEMA_VERSION,
    path: "state.json#/config"
  });
  assert.deepEqual(versions.activeRunPointer, {
    version: CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION,
    path: "state.json#/tasks/*/activeRuns"
  });
  assert.deepEqual(versions.leaderFailure, {
    version: CURRENT_LEADER_FAILURE_SCHEMA_VERSION,
    path: "state.json#/tasks/*/leaderFailure"
  });
  assert.deepEqual(versions.operatorNotification, {
    version: CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION,
    path: "state.json#/tasks/*/operatorNotification"
  });

  const scan = scanSourceRecordVersions(home, versions);
  assert.ok("record" in scan);
  assert.equal(scan.record.config.version, CURRENT_CONFIG_SCHEMA_VERSION);
  assert.equal(scan.record.activeRunPointer.version, CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION);
  assert.equal(scan.record.leaderFailure.version, CURRENT_LEADER_FAILURE_SCHEMA_VERSION);
  assert.equal(
    scan.record.operatorNotification.version,
    CURRENT_OPERATOR_NOTIFICATION_SCHEMA_VERSION
  );

  const classification = classifyHome({ home, registry: EMPTY(), latest: LATEST() });
  assert.equal(classification.classification.verdict, "USABLE");
  const result = await runStorageUpgrade({
    home,
    registry: EMPTY(),
    latest: LATEST(),
    mode: "execute",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "already-current");
});

test("P2 map guard rejects a missing direct-family descriptor before classification", () => {
  const drifted = currentRecordVersions();
  delete drifted.configuredAgent;
  assert.throws(
    () => classifyHome({
      home: currentHome().home,
      registry: EMPTY(),
      latest: latestStorageVersionState(drifted)
    }),
    /Record version map completeness drift: missing=configuredAgent/
  );
  assert.throws(
    () => assertRecordVersionDescriptors(drifted),
    /Record version map completeness drift: missing=configuredAgent/
  );
});

test("P2 map guard rejects a changed default locator before classification", () => {
  const drifted = {
    ...currentRecordVersions(),
    configuredAgent: {
      ...currentRecordVersions().configuredAgent,
      path: "state.json#/projects"
    }
  };
  assert.throws(
    () => classifyHome({
      home: currentHome().home,
      registry: EMPTY(),
      latest: latestStorageVersionState(drifted)
    }),
    /Record version map drift for configuredAgent/
  );
  assert.throws(
    () => assertRecordVersionDescriptors(drifted),
    /Record version map drift for configuredAgent/
  );
});

test("P2 map guard: future config and active-run pointer versions are future-version blockers", () => {
  const futureConfig = currentHomeWithBoundaryRecords();
  editState(futureConfig.home, (state) => {
    state.config.schemaVersion = CURRENT_CONFIG_SCHEMA_VERSION + 1;
  });
  setManifestRecordVersion(
    futureConfig.home,
    "config",
    CURRENT_CONFIG_SCHEMA_VERSION + 1
  );
  const configResult = classifyHome({
    home: futureConfig.home,
    registry: EMPTY(),
    latest: LATEST()
  });
  assert.equal(configResult.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(configResult.classification.blocker.reason, "future-version");
  assert.equal(configResult.classification.blocker.recordKind, "config");
  assert.equal(configResult.classification.blocker.found, CURRENT_CONFIG_SCHEMA_VERSION + 1);
  assert.equal(configResult.classification.blocker.supported, CURRENT_CONFIG_SCHEMA_VERSION);

  const futurePointer = currentHomeWithBoundaryRecords();
  editState(futurePointer.home, (state) => {
    state.tasks[futurePointer.taskId].activeRuns[futurePointer.roleName].schemaVersion =
      CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION + 1;
  });
  setManifestRecordVersion(
    futurePointer.home,
    "activeRunPointer",
    CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION + 1
  );
  const pointerResult = classifyHome({
    home: futurePointer.home,
    registry: EMPTY(),
    latest: LATEST()
  });
  assert.equal(pointerResult.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(pointerResult.classification.blocker.reason, "future-version");
  assert.equal(pointerResult.classification.blocker.recordKind, "activeRunPointer");
  assert.equal(
    pointerResult.classification.blocker.found,
    CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION + 1
  );
  assert.equal(
    pointerResult.classification.blocker.supported,
    CURRENT_ACTIVE_RUN_POINTER_SCHEMA_VERSION
  );
});

test("P2 map guard preserves corruption for missing boundary schemaVersion", () => {
  const missingConfig = currentHomeWithBoundaryRecords();
  editState(missingConfig.home, (state) => {
    delete state.config.schemaVersion;
  });
  const configResult = classifyHome({
    home: missingConfig.home,
    registry: EMPTY(),
    latest: LATEST()
  });
  assert.equal(configResult.classification.verdict, "CORRUPTED");

  const missingPointer = currentHomeWithBoundaryRecords();
  editState(missingPointer.home, (state) => {
    delete state.tasks[missingPointer.taskId].activeRuns[missingPointer.roleName].schemaVersion;
  });
  const pointerResult = classifyHome({
    home: missingPointer.home,
    registry: EMPTY(),
    latest: LATEST()
  });
  assert.equal(pointerResult.classification.verdict, "CORRUPTED");
});

test("P1-1 map guard: non-empty current RoleSessionSet and AgentRun Home is USABLE", async () => {
  const fixture = currentHomeWithTaskRoleRecords();
  migrateFixtureToLayout7(fixture.home);
  const { home, taskId, roleName, runId } = fixture;
  const store = new FileTaskStore(home);
  const sessions = store.getTaskRoleSessionSet(taskId, roleName);
  const run = store.getAgentRun(taskId, runId);
  assert.equal(sessions?.schemaVersion, CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION);
  assert.equal(run?.schemaVersion, CURRENT_AGENT_RUN_SCHEMA_VERSION);

  const versions = currentRecordVersions();
  assert.equal(
    versions.taskRoleSessionSet.version,
    CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION,
    "the upgrade map must match taskStore's persisted RoleSessionSet gate"
  );
  assert.equal(
    versions.agentRun.version,
    CURRENT_AGENT_RUN_SCHEMA_VERSION,
    "the upgrade map must match taskStore's persisted AgentRun gate"
  );

  const scan = scanSourceRecordVersions(home, versions);
  assert.ok("record" in scan);
  assert.equal(scan.record.taskRoleSessionSet.version, CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION);
  assert.equal(scan.record.agentRun.version, CURRENT_AGENT_RUN_SCHEMA_VERSION);

  const classification = classifyHome({ home, registry: EMPTY(), latest: LATEST() });
  assert.equal(classification.classification.verdict, "USABLE");
  const result = await runStorageUpgrade({
    home,
    registry: EMPTY(),
    latest: LATEST(),
    mode: "execute",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "already-current");
});

test("P1-1 map guard preserves older/future/corrupt record outcomes", () => {
  const older = currentHomeWithTaskRoleRecords();
  editState(older.home, (state) => {
    state.tasks[older.taskId].roleSessionSets[older.roleName].schemaVersion =
      CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION - 1;
  });
  setManifestRecordVersion(
    older.home,
    "taskRoleSessionSet",
    CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION - 1
  );
  const oldResult = classifyHome({ home: older.home, registry: EMPTY(), latest: LATEST() });
  assert.equal(oldResult.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(oldResult.classification.blocker.reason, "missing-step");
  assert.equal(oldResult.classification.blocker.recordKind, "taskRoleSessionSet");
  assert.equal(oldResult.classification.blocker.from, CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION - 1);
  assert.equal(oldResult.classification.blocker.to, CURRENT_TASK_ROLE_SESSION_SET_SCHEMA_VERSION);

  const future = currentHomeWithTaskRoleRecords();
  editState(future.home, (state) => {
    state.tasks[future.taskId].agentRuns[future.runId].schemaVersion =
      CURRENT_AGENT_RUN_SCHEMA_VERSION + 1;
  });
  setManifestRecordVersion(
    future.home,
    "agentRun",
    CURRENT_AGENT_RUN_SCHEMA_VERSION + 1
  );
  const futureResult = classifyHome({ home: future.home, registry: EMPTY(), latest: LATEST() });
  assert.equal(futureResult.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(futureResult.classification.blocker.reason, "future-version");
  assert.equal(futureResult.classification.blocker.recordKind, "agentRun");
  assert.equal(futureResult.classification.blocker.found, CURRENT_AGENT_RUN_SCHEMA_VERSION + 1);
  assert.equal(futureResult.classification.blocker.supported, CURRENT_AGENT_RUN_SCHEMA_VERSION);

  const corrupt = currentHomeWithTaskRoleRecords();
  editState(corrupt.home, (state) => {
    delete state.tasks[corrupt.taskId].roleSessionSets[corrupt.roleName].schemaVersion;
  });
  const corruptResult = classifyHome({ home: corrupt.home, registry: EMPTY(), latest: LATEST() });
  assert.equal(corruptResult.classification.verdict, "CORRUPTED");
});

test("P1-1 aggregate family: StoredTask 14->13 is a record missing-step, not corruption", () => {
  const { home } = currentHome();
  const store = new FileTaskStore(home);
  store.saveTask(createTask("task-1", "Aggregate scan", new Date("2026-08-07T00:00:00.000Z")));
  editState(home, (state) => {
    state.tasks["task-1"].schemaVersion = 13;
  });
  setManifestRecordVersion(home, "storedTask", 13);

  const scan = scanSourceRecordVersions(home, currentRecordVersions());
  assert.ok("record" in scan);
  assert.equal(scan.record.storedTask.version, 13);
  assert.equal(scan.record.task.version, 4, "nested task family remains independently scanned");

  const result = classifyHome({ home, registry: EMPTY(), latest: LATEST() });
  assert.equal(result.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(result.classification.blocker.reason, "missing-step");
  assert.equal(result.classification.blocker.axis, "record");
  assert.equal(result.classification.blocker.recordKind, "storedTask");
  assert.equal(result.classification.blocker.from, 13);
  assert.equal(result.classification.blocker.to, 14);
});

// ===========================================================================
// P1-2/P1-3 — binary-only update owns the same deterministic Controller
// lifecycle as Home upgrade, and restores the exact pre-update identity.
// ===========================================================================

function binaryOnlyPorts(events, overrides = {}) {
  const identity = {
    executablePath: "/old/node",
    args: ["/old/controllerMain.js"],
    version: "8.8.8"
  };
  return {
    stage: () => { events.push("stage"); return { binaryPath: "/staged/yui", version: "9.9.9" }; },
    preflight: () => { events.push("preflight"); return { status: "already-current" }; },
    activateStorage: () => { events.push("activate-storage"); return { status: "already-current" }; },
    activateBinary: () => { events.push("activate-binary"); },
    verify: () => { events.push("verify"); },
    cleanup: () => { events.push("cleanup"); },
    controllerStatus: () => { events.push("status"); return { running: true, pid: 41, identity }; },
    stopController: (_home, expectedPid) => {
      events.push("stop");
      assert.equal(expectedPid, 41);
      return { stopped: true, pid: 41 };
    },
    startController: () => { events.push("start"); },
    restoreController: (_home, captured) => {
      events.push("restore");
      assert.deepEqual(captured, identity);
    },
    ...overrides
  };
}

test("binary-only update stops once and starts replacement after verify", () => {
  const events = [];
  const result = runUpdate(binaryOnlyPorts(events), { home: "/unused" });
  assert.equal(result.outcome, "updated");
  assert.deepEqual(events, [
    "stage", "preflight", "status", "stop", "activate-binary", "verify", "start", "cleanup"
  ]);
});

test("binary-only activation failure restores the exact old Controller identity", () => {
  const events = [];
  const result = runUpdate(binaryOnlyPorts(events, {
    activateBinary: () => {
      events.push("activate-binary");
      throw new Error("binary switch blocked");
    }
  }), { home: "/unused" });
  assert.equal(result.outcome, "aborted");
  assert.equal(result.phase, "activate-binary");
  assert.deepEqual(events, [
    "stage", "preflight", "status", "stop", "activate-binary", "restore", "cleanup"
  ]);
});

test("binary-only restore rejects a same-version wrong executable or argv", async (t) => {
  const { home } = currentHome();
  await startIsolatedController(home, t);
  const captured = await callController(home, "controller.identity", {});
  const wrong = {
    executablePath: captured.executablePath,
    args: [...captured.args, "--wrong-captured-argv"],
    version: captured.version
  };
  const ports = createUpdatePorts(process.env, spawnSync);
  assert.throws(
    () => ports.restoreController(home, wrong),
    /Failed to restore the previously running Controller identity: exited with status 1/i
  );
  assert.deepEqual(await callController(home, "controller.identity", {}), captured);
});

test("binary-only restore accepts the exact captured executable, argv, and version", async (t) => {
  const { home } = currentHome();
  await startIsolatedController(home, t);
  const captured = await callController(home, "controller.identity", {});
  const ports = createUpdatePorts(process.env, spawnSync);
  assert.doesNotThrow(() => ports.restoreController(home, captured));
  assert.deepEqual(await callController(home, "controller.identity", {}), captured);
});

test("Controller restore inherits environment without serializing credentials into child argv", () => {
  const secret = "restore-secret-do-not-leak";
  const environment = { ...process.env, YUI_HOME: "/tmp/yui-restore-secret", OPENAI_API_KEY: secret };
  let captured;
  const ports = createUpdatePorts(environment, (command, args, options) => {
    captured = { command, args: [...args], options };
    return spawnResult();
  });
  ports.restoreController("/tmp/yui-restore-secret", {
    executablePath: "/old/node",
    args: ["/old/controllerMain.js"],
    version: "8.8.8"
  });

  assert.ok(captured);
  assert.equal(JSON.stringify(captured.args).includes(secret), false);
  assert.equal(JSON.stringify(captured.args).includes("OPENAI_API_KEY"), false);
  assert.equal(captured.options.env.OPENAI_API_KEY, secret);
  assert.equal(captured.options.env.YUI_HOME, "/tmp/yui-restore-secret");
});

test("binary-only stop failure is structured with no retry, activation, or restore", () => {
  const events = [];
  const result = runUpdate(binaryOnlyPorts(events, {
    stopController: () => {
      events.push("stop");
      throw new Error("shutdown timeout");
    }
  }), { home: "/unused" });
  assert.equal(result.outcome, "aborted");
  assert.equal(result.phase, "preflight");
  assert.match(result.message, /shutdown timeout/);
  assert.deepEqual(events, ["stage", "preflight", "status", "stop", "cleanup"]);
});

test("binary-only real ports capture authenticated exact identity, never inferred current identity", () => {
  const home = "/tmp/yui-authenticated-identity";
  const identity = {
    executablePath: "/old/node-v20",
    args: ["/old/controller-main.js", "--legacy"],
    version: "8.8.8"
  };
  const spawn = (command, args) => {
    if (args.includes("controller") && args.includes("status")) {
      return okData({
        resources: [{
          kind: "controller",
          state: "current",
          yuiHome: home,
          processes: [{ pid: 41 }]
        }],
        warnings: []
      });
    }
    if (args.includes("controller") && args.includes("identity")) return okData(identity);
    return spawnResult();
  };
  const ports = createUpdatePorts(process.env, spawn);
  assert.deepEqual(ports.controllerStatus(home), { running: true, pid: 41, identity });
});

test("binary-only real ports accept only an explicit no-Controller proof as stopped", () => {
  const home = "/tmp/yui-no-controller-proof";
  const spawn = (_command, args) => {
    if (args.includes("controller") && args.includes("status")) {
      return okData({ resources: [], warnings: [] });
    }
    if (args.includes("controller") && args.includes("identity")) {
      return spawnResult({
        status: 5,
        stderr: Buffer.from(JSON.stringify({
          ok: false,
          code: "CONTROLLER_NOT_RUNNING",
          message: "Controller is not running."
        }))
      });
    }
    throw new Error("unexpected Controller lifecycle command");
  };
  const ports = createUpdatePorts(process.env, spawn);
  assert.deepEqual(ports.controllerStatus(home), { running: false });
});

test("binary-only real ports block orphaned discovery as unknown-active", () => {
  const home = "/tmp/yui-orphaned-controller";
  const spawn = (_command, args) => {
    if (args.includes("controller") && args.includes("status")) {
      return okData({
        resources: [{
          kind: "controller",
          state: "orphaned",
          yuiHome: home,
          processes: [{ pid: 41 }]
        }],
        warnings: []
      });
    }
    throw new Error("identity must not be queried for an orphaned inventory");
  };
  const ports = createUpdatePorts(process.env, spawn);
  assert.throws(() => ports.controllerStatus(home), /unknown-active/i);
});

test("binary-only real ports require an authenticated identity when a current process is listed", () => {
  const home = "/tmp/yui-identity-uncertain";
  const spawn = (_command, args) => {
    if (args.includes("controller") && args.includes("status")) {
      return okData({
        resources: [{
          kind: "controller",
          state: "current",
          yuiHome: home,
          processes: [{ pid: 41 }]
        }],
        warnings: []
      });
    }
    return spawnResult({
      status: 5,
      stderr: Buffer.from(JSON.stringify({ ok: false, code: "METHOD_NOT_FOUND" }))
    });
  };
  const ports = createUpdatePorts(process.env, spawn);
  assert.throws(() => ports.controllerStatus(home), /absence could not be authenticated|METHOD_NOT_FOUND|identity/i);
});

test("exact-identity restore readiness waits for authenticated running status", async () => {
  const identity = {
    executablePath: "/old/node-v20",
    args: ["/old/controller-main.js"],
    version: "8.8.8"
  };
  let statusCalls = 0;
  let spawnCalls = 0;
  const result = await ensureFileTaskControllerIdentity(
    "/tmp/yui-readiness-handshake",
    identity,
    {
      call: async (_home, method) => {
        if (method === "controller.identity") return identity;
        statusCalls += 1;
        if (statusCalls < 3) {
          throw new ControllerClientError("CONTROLLER_UNAVAILABLE", "not ready yet");
        }
        return {
          running: true,
          protocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
          version: identity.version
        };
      },
      spawnController: () => { spawnCalls += 1; },
      startupTimeoutMs: 100,
      pollIntervalMs: 1
    }
  );
  assert.equal(result.running, true);
  assert.equal(spawnCalls, 1);
  assert.equal(statusCalls, 3);
});

test("exact-identity readiness rejects a same-version Controller with wrong executable or argv", async () => {
  const identity = {
    executablePath: "/old/node-v20",
    args: ["/old/controller-main.js", "--captured"],
    version: "8.8.8"
  };
  const wrong = {
    executablePath: "/other/node-v20",
    args: ["/other/controller-main.js", "--captured"],
    version: identity.version
  };
  let spawnCalls = 0;
  let identityCalls = 0;
  await assert.rejects(
    ensureFileTaskControllerIdentity(
      "/tmp/yui-readiness-wrong-identity",
      identity,
      {
        call: async (_home, method) => {
          if (method === "controller.status") {
            return {
              running: true,
              protocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
              version: identity.version
            };
          }
          identityCalls += 1;
          return wrong;
        },
        spawnController: () => { spawnCalls += 1; },
        startupTimeoutMs: 100,
        pollIntervalMs: 1
      }
    ),
    /identity.*(?:mismatch|match|executable|argv)/i
  );
  assert.equal(identityCalls, 1);
  assert.equal(spawnCalls, 0, "identity mismatch must not spawn a second Controller");
});

test("exact-identity readiness accepts the captured executable, argv, and version", async () => {
  const identity = {
    executablePath: "/old/node-v20",
    args: ["/old/controller-main.js", "--captured"],
    version: "8.8.8"
  };
  let identityCalls = 0;
  const result = await ensureFileTaskControllerIdentity(
    "/tmp/yui-readiness-exact-identity",
    identity,
    {
      call: async (_home, method) => {
        if (method === "controller.status") {
          return {
            running: true,
            pid: 41,
            protocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
            version: identity.version
          };
        }
        identityCalls += 1;
        return identity;
      },
      spawnController: () => { throw new Error("must not spawn for an already-running exact identity"); }
    }
  );
  assert.equal(result.running, true);
  assert.equal(identityCalls, 1);
});

test("storage upgrade default restore rejects same-version wrong Controller identity", async () => {
  const { home } = currentHome();
  mkdirSync(join(home, ".state.lock"));
  const { latest, registry } = migratableSetup();
  const identity = {
    executablePath: "/old/node-v20",
    args: ["/old/controller-main.js"],
    version: "8.8.8"
  };
  const wrong = {
    executablePath: "/other/node-v20",
    args: ["/other/controller-main.js"],
    version: identity.version
  };
  let identityCalls = 0;
  let spawnCalls = 0;
  const result = await runStorageUpgrade({
    home,
    registry,
    latest,
    mode: "execute",
    controllerOptions: {
      call: async (_home, method) => {
        if (method === "controller.status") {
          return {
            running: true,
            pid: 41,
            protocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
            version: identity.version
          };
        }
        identityCalls += 1;
        return identityCalls === 1 ? identity : wrong;
      },
      spawnController: () => { spawnCalls += 1; }
    },
    stopController: async (_home, expectedPid) => {
      assert.equal(expectedPid, 41);
      return { stopped: true, pid: 41 };
    }
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "active-runtime");
  assert.match(result.message, /could not be restored|identity/i);
  assert.equal(identityCalls, 2, "capture and restore must each authenticate identity");
  assert.equal(spawnCalls, 0, "wrong identity must not start a second Controller");
});

test("storage upgrade default restore accepts the captured Controller identity", async () => {
  const { home } = currentHome();
  mkdirSync(join(home, ".state.lock"));
  const { latest, registry } = migratableSetup();
  const identity = {
    executablePath: "/old/node-v20",
    args: ["/old/controller-main.js"],
    version: "8.8.8"
  };
  let identityCalls = 0;
  const result = await runStorageUpgrade({
    home,
    registry,
    latest,
    mode: "execute",
    controllerOptions: {
      call: async (_home, method) => {
        if (method === "controller.status") {
          return {
            running: true,
            pid: 41,
            protocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
            version: identity.version
          };
        }
        identityCalls += 1;
        return identity;
      },
      spawnController: () => { throw new Error("must not spawn for an already-running exact identity"); }
    },
    stopController: async (_home, expectedPid) => {
      assert.equal(expectedPid, 41);
      return { stopped: true, pid: 41 };
    }
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "active-runtime");
  assert.equal(identityCalls, 2, "capture and restore must authenticate the exact identity");
});

test("P1-1 managed workspace record-only mismatch is NEEDS_NEW_VERSION/missing-step", () => {
  const { home } = currentHome();
  editState(home, (state) => {
    // The scanner intentionally needs only the record's schemaVersion here;
    // the strict aggregate loader must not run while this record axis is old.
    state.tasks = {
      "task-1": {
        schemaVersion: CURRENT_STORED_TASK_SCHEMA_VERSION,
        managedWorkspaces: {
          "task": { schemaVersion: 1 }
        }
      }
    };
  });
  const schemaPath = join(home, "schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  schema.recordVersions.managedWorkspace = 1;
  writeFileSync(schemaPath, JSON.stringify(schema));
  const latest = LATEST();
  latest.record = {
    ...latest.record,
    managedWorkspace: {
      version: 2,
      path: "state.json#/tasks/*/managedWorkspaces"
    }
  };
  const result = classifyHome({ home, registry: EMPTY(), latest });
  assert.equal(result.classification.verdict, "NEEDS_NEW_VERSION");
  assert.equal(result.classification.blocker.reason, "missing-step");
  assert.equal(result.classification.blocker.axis, "record");
  assert.equal(result.classification.blocker.recordKind, "managedWorkspace");
  assert.equal(result.classification.blocker.from, 1);
  assert.equal(result.classification.blocker.to, 2);
});

test("P1-1 upgrade: a record-only-older Home blocks with missing-step and never switches", async () => {
  const { home } = currentHome();
  setConfiguredAgent(home, 1);
  const result = await runStorageUpgrade({
    home, registry: EMPTY(), latest: LATEST(), mode: "execute",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "missing-step");
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
  // The record verdict, not corruption.
  assert.equal(result.classification.classification.verdict, "NEEDS_NEW_VERSION");
});

// ===========================================================================
// P1-2 — an activation with no parseable receipt is AMBIGUOUS, never a false
// "recoverable/unchanged".
// ===========================================================================

/** Fake ports whose activateStorage is ambiguous; probe drives the resolution. */
function ambiguousPorts(probeStorage, spy = {}) {
  return {
    stage: () => ({ binaryPath: "/staged/yui", version: "9.9.9" }),
    preflight: () => ({ status: "migratable", summary: "1 step" }),
    activateStorage: () => ({ status: "ambiguous", detail: "terminated by SIGTERM" }),
    activateBinary: () => { spy.activatedBinary = true; },
    verify: () => { spy.verified = true; },
    probeStorage,
    cleanup: () => { spy.cleaned = true; }
  };
}

test("P1-2 kill-after-switch (receipt present): ambiguous, points at backup, binary NOT promoted", () => {
  const spy = {};
  const result = runUpdate(
    ambiguousPorts(() => ({ switched: true, backupPath: "/home.backup-x", schemaCurrent: true }), spy),
    { home: "/unused" }
  );
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.switched, true);
  assert.equal(result.storageBackupPath, "/home.backup-x");
  assert.match(result.action, /home\.backup-x|yui doctor/);
  assert.equal(spy.activatedBinary, undefined, "binary must NOT be promoted on an ambiguous switch");
  assert.equal(spy.cleaned, true, "staging is still cleaned up");
  // Must not masquerade as a completed update or a recoverable no-op.
  assert.notEqual(result.outcome, "updated");
  assert.equal("recoverable" in result, false);
});

test("P1-2 switch-then-crash (no receipt): ambiguous, reports likely-not-committed, never recoverable", () => {
  const result = runUpdate(
    ambiguousPorts(() => ({ switched: false, schemaCurrent: true })),
    { home: "/unused" }
  );
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.switched, false);
  assert.match(result.action, /yui doctor|re-run/);
  assert.equal("recoverable" in result, false);
});

test("P1-2 probe failure: maximum uncertainty, still ambiguous (never recoverable)", () => {
  const result = runUpdate(
    ambiguousPorts(() => { throw new Error("probe blew up"); }),
    { home: "/unused" }
  );
  assert.equal(result.outcome, "ambiguous");
  assert.match(result.message, /unknown/i);
  assert.match(result.action, /Do NOT assume/);
});

test("P1-2 interpretActivation: a signal-killed child with no JSON maps to ambiguous", () => {
  // Exercises the REAL port logic: the staged binary is killed after switching.
  const spawn = fakeSpawn({
    stageVersion: "9.9.9",
    activate: killed("SIGKILL")
  });
  const ports = createUpdatePorts(process.env, spawn);
  const activation = ports.activateStorage({ binaryPath: "/staged/yui", version: "9.9.9" }, "/home");
  assert.equal(activation.status, "ambiguous");
  assert.match(activation.detail, /SIGKILL|terminated/);
});

test("P1-2 interpretActivation: non-zero exit with garbage stdout is ambiguous, not blocked", () => {
  const spawn = fakeSpawn({ stageVersion: "9.9.9", activate: exitWith(1, "not json") });
  const ports = createUpdatePorts(process.env, spawn);
  const activation = ports.activateStorage({ binaryPath: "/staged/yui", version: "9.9.9" }, "/home");
  assert.equal(activation.status, "ambiguous");
});

test("P1-2 interpretActivation: a clean 'upgraded' receipt maps to migrated", () => {
  const spawn = fakeSpawn({
    stageVersion: "9.9.9",
    activate: okData({ outcome: "upgraded", backupPath: "/home.backup-y" })
  });
  const ports = createUpdatePorts(process.env, spawn);
  const activation = ports.activateStorage({ binaryPath: "/staged/yui", version: "9.9.9" }, "/home");
  assert.equal(activation.status, "migrated");
  assert.equal(activation.backupPath, "/home.backup-y");
});

test("P1-2 interpretActivation: a clean 'blocked' receipt stays a clean blocked", () => {
  const spawn = fakeSpawn({
    stageVersion: "9.9.9",
    activate: okData({ outcome: "blocked", stage: "active-runtime", message: "busy", action: "stop it" })
  });
  const ports = createUpdatePorts(process.env, spawn);
  const activation = ports.activateStorage({ binaryPath: "/staged/yui", version: "9.9.9" }, "/home");
  assert.equal(activation.status, "blocked");
  assert.equal(activation.stage, "active-runtime");
});

test("P1-2 receipt: round-trips at a sibling path and is cleared cleanly", () => {
  const { home } = currentHome();
  assert.equal(readUpgradeReceipt(home), null);
  assert.equal(upgradeReceiptPath(home).startsWith(tmpdir()), true);
  writeUpgradeReceipt(home, { switched: true, completedAt: "2026-08-06T00:00:00.000Z", backupPath: `${home}.backup-z` });
  const read = readUpgradeReceipt(home);
  assert.equal(read.switched, true);
  assert.equal(read.backupPath, `${home}.backup-z`);
  clearUpgradeReceipt(home);
  assert.equal(readUpgradeReceipt(home), null);
});

test("P1-2 receipt: a clean upgrade leaves NO receipt behind (written then cleared)", async () => {
  const { home } = currentHome();
  const { latest, registry } = migratableSetup();
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {},
    now: () => new Date("2026-08-06T12:00:00.000Z")
  });
  assert.equal(result.outcome, "upgraded");
  // On a fully-verified success the ambiguity marker is cleared.
  assert.equal(readUpgradeReceipt(home), null);
  assert.equal(existsSync(upgradeReceiptPath(home)), false);
});

// ===========================================================================
// P1-3 — the SAME staged artifact is promoted, and the ACTUALLY-ACTIVATED
// binary is verified (identity must match, else fail closed).
// ===========================================================================

test("P1-3 activateBinary promotes the exact staged version, not a bare @latest", () => {
  const calls = [];
  const spawn = fakeSpawn({ stageVersion: "9.9.9", record: calls });
  const ports = createUpdatePorts(process.env, spawn);
  const staged = ports.stage();
  assert.equal(staged.version, "9.9.9", "stage resolved the exact version");
  ports.activateBinary(staged);
  const install = calls.find((c) => c.command === "npm"
    && c.args[0] === "install" && c.args.includes("--global") && !c.args.includes("--prefix"));
  assert.ok(install, "a global install (activation) was invoked");
  assert.ok(
    install.args.includes("@zq-silk/yui@9.9.9"),
    `activation must pin the staged version, got ${JSON.stringify(install.args)}`
  );
  assert.equal(
    install.args.includes("@zq-silk/yui@latest"), false,
    "activation must NOT re-resolve a bare @latest"
  );
});

test("P1-3 verify runs the activated global binary (not the staging path) and matches identity", () => {
  const { globalPrefix, globalBinary } = fakeGlobalInstall("9.9.9");
  const calls = [];
  const spawn = fakeSpawn({ stageVersion: "9.9.9", globalPrefix, activatedVersion: "9.9.9", record: calls });
  const ports = createUpdatePorts(process.env, spawn);
  const staged = ports.stage();
  assert.doesNotThrow(() => ports.verify(staged, "/home"));
  // The doctor health check ran against the ACTIVATED binary, never the staging path.
  const doctor = calls.find((c) => c.args.includes("doctor"));
  assert.ok(doctor, "a doctor health check ran");
  assert.equal(doctor.command, globalBinary, "verify used the activated global binary");
  assert.notEqual(doctor.command, staged.binaryPath, "verify must NOT re-check the staging binary");
});

test("P1-3 verify fails closed when the activated binary's version differs from staged (A vs B)", () => {
  // Staged A=9.9.9 but the live global resolved to B=8.8.8 (a moved @latest).
  const { globalPrefix } = fakeGlobalInstall("8.8.8");
  const spawn = fakeSpawn({ stageVersion: "9.9.9", globalPrefix, activatedVersion: "8.8.8" });
  const ports = createUpdatePorts(process.env, spawn);
  const staged = ports.stage();
  assert.throws(() => ports.verify(staged, "/home"), /activated binary is version 8\.8\.8.*staged.*9\.9\.9/s);
});

// ===========================================================================
// P1-4 — quiesce fails closed on an undeterminable write lock / discovery.
// ===========================================================================

const NOT_ME = 424242; // a pid that is not this process (and almost surely dead).

test("P1-4 lock dir with a missing owner file is unknown-active (fail closed)", () => {
  const { home } = currentHome();
  mkdirSync(join(home, ".state.lock"));
  const signals = inspectHomeRuntime(home, NOT_ME);
  assert.deepEqual(signals.foreignWriteLock, { state: "unknown" });
  assert.equal(homeRuntimeIsActive(signals), true);
});

test("P1-4 lock dir with a non-integer owner is unknown-active (fail closed)", () => {
  const { home } = currentHome();
  mkdirSync(join(home, ".state.lock"));
  writeFileSync(join(home, ".state.lock", "owner"), "not-a-pid\n");
  const signals = inspectHomeRuntime(home, NOT_ME);
  assert.deepEqual(signals.foreignWriteLock, { state: "unknown" });
  assert.equal(homeRuntimeIsActive(signals), true);
});

test("P1-4 lock dir with an empty owner file is unknown-active (fail closed)", () => {
  const { home } = currentHome();
  mkdirSync(join(home, ".state.lock"));
  writeFileSync(join(home, ".state.lock", "owner"), "");
  const signals = inspectHomeRuntime(home, NOT_ME);
  assert.deepEqual(signals.foreignWriteLock, { state: "unknown" });
  assert.equal(homeRuntimeIsActive(signals), true);
});

test("P1-4 a malformed controller.json is unknown-active (fail closed), not 'no controller'", () => {
  const { home } = currentHome();
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(join(home, "runtime", "controller.json"), "{ broken");
  const signals = inspectHomeRuntime(home, NOT_ME);
  assert.deepEqual(signals.liveController, { state: "unknown" });
  assert.equal(homeRuntimeIsActive(signals), true);
});

test("P1-4 positive: a live owner is recognized as active", () => {
  const { home } = currentHome();
  mkdirSync(join(home, ".state.lock"));
  writeFileSync(join(home, ".state.lock", "owner"), "1\n"); // pid 1 (init) is always alive.
  const signals = inspectHomeRuntime(home, NOT_ME);
  assert.equal(signals.foreignWriteLock.state, "live");
  assert.equal(signals.foreignWriteLock.ownerPid, 1);
  assert.equal(homeRuntimeIsActive(signals), true);
});

test("P1-4 negative: a provably-dead owner is reclaimable (not active)", () => {
  const { home } = currentHome();
  mkdirSync(join(home, ".state.lock"));
  writeFileSync(join(home, ".state.lock", "owner"), "999999999\n"); // not a live pid.
  const signals = inspectHomeRuntime(home, NOT_ME);
  assert.equal(signals.foreignWriteLock, null);
  assert.equal(homeRuntimeIsActive(signals), false);
});

test("P1-4 no lock directory at all means no writer", () => {
  const { home } = currentHome();
  const signals = inspectHomeRuntime(home, NOT_ME);
  assert.equal(signals.foreignWriteLock, null);
});

test("P1-4 upgrade fails closed with active-runtime on an undeterminable lock", async () => {
  const { home } = currentHome();
  const { latest, registry } = migratableSetup();
  mkdirSync(join(home, ".state.lock")); // present but ownerless: unknown => active.
  const result = await runStorageUpgrade({
    home, registry, latest, mode: "execute",
    stopController: async () => {}
  });
  assert.equal(result.outcome, "blocked");
  assert.equal(result.stage, "active-runtime");
  assert.match(result.message, /undeterminable|cannot be ruled out/i);
  assert.equal(existsSync(`${home}.upgrade-staging`), false);
});

// ---------------------------------------------------------------------------
// Local helpers (kept at the bottom for readability).
// ---------------------------------------------------------------------------

async function startIsolatedController(home, t) {
  const controllerPath = join(process.cwd(), "dist/controller/controllerMain.js");
  const child = spawn(process.execPath, [controllerPath], {
    cwd: process.cwd(),
    env: { ...process.env, YUI_HOME: home },
    stdio: "ignore"
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill("SIGTERM");
    });
  });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const status = await callController(home, "controller.status", {});
      if (status.running === true) return child;
    } catch (error) {
      if (!(error instanceof ControllerClientError)
        || !["CONTROLLER_NOT_RUNNING", "CONTROLLER_UNAVAILABLE"].includes(error.code)) {
        throw error;
      }
    }
    if (Date.now() >= deadline) throw new Error("isolated Controller did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The synthetic migratable setup (mirrors storage-upgrade-e2e). */
function migratableSetup() {
  const latest = {
    layout: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregate: CURRENT_AGGREGATE_SCHEMA_VERSION + 1,
    record: currentRecordVersions()
  };
  const registry = new MigrationRegistry();
  registry.register({
    axis: "aggregate",
    fromVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    toVersion: CURRENT_AGGREGATE_SCHEMA_VERSION + 1,
    preconditions: () => {},
    transform: (snapshot) => ({
      schemaManifest: {
        ...snapshot.schemaManifest,
        aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION
      },
      state: snapshot.state
    }),
    declaredEffects: []
  });
  return { latest, registry };
}

// --- fake spawn plumbing for the real update ports -------------------------

function spawnResult(overrides) {
  return {
    pid: 0,
    output: [],
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
    status: 0,
    signal: null,
    ...overrides
  };
}
function okData(data) {
  return spawnResult({ stdout: Buffer.from(JSON.stringify({ ok: true, data })) });
}
function rawOut(text) {
  return spawnResult({ stdout: Buffer.from(text) });
}
function killed(signal) {
  return spawnResult({ status: null, signal });
}
function exitWith(code, text) {
  return spawnResult({ status: code, stdout: Buffer.from(text) });
}

/**
 * Build a fake spawn dispatching on (command, args). Records calls in `record`.
 * Recognizes: npm install (stage/activate), npm prefix -g, `<bin> --json version`,
 * `<bin> --json doctor`, `<bin> --json upgrade [--dry-run]`.
 */
function fakeSpawn(config) {
  const record = config.record ?? [];
  return (command, args, _options) => {
    record.push({ command, args: [...args] });
    if (command === "npm" && args[0] === "prefix") {
      return rawOut(config.globalPrefix ?? "");
    }
    if (command === "npm" && args[0] === "install") {
      return spawnResult({}); // stage / activate succeed
    }
    // A `yui` binary invocation.
    const isVersion = args.includes("version");
    const isDoctor = args.includes("doctor");
    const isUpgrade = args.includes("upgrade");
    const isGlobalBinary = config.globalPrefix !== undefined
      && command === join(config.globalPrefix, "bin", "yui");
    if (isVersion) {
      const version = isGlobalBinary
        ? (config.activatedVersion ?? config.stageVersion)
        : config.stageVersion;
      return okData({ version });
    }
    if (isDoctor) {
      // The real `--json doctor` returns { checks, storage: { healthy, blocking } }
      // with EVERY storage check present; the post-verify requires all of them
      // present-and-ok (P1-3/R3-F2). Default to a full healthy set unless a test
      // overrides config.doctor to inject an unhealthy or unparseable result.
      return config.doctor ?? okData({
        checks: [
          { name: "storage schema", status: "ok", detail: "current" },
          { name: "storage compatibility", status: "ok", detail: "USABLE" },
          { name: "storage state", status: "ok", detail: "readable" }
        ],
        storage: { healthy: true, blocking: [] }
      });
    }
    if (isUpgrade) {
      return config.activate ?? okData({ outcome: "already-current" });
    }
    return spawnResult({});
  };
}

/** Create a temp global prefix with a real bin/yui file so existsSync passes. */
function fakeGlobalInstall(_version) {
  const globalPrefix = mkdtempSync(join(tmpdir(), "yui-global-"));
  mkdirSync(join(globalPrefix, "bin"), { recursive: true });
  writeFileSync(join(globalPrefix, "bin", "yui"), "#!/bin/sh\n", { mode: 0o755 });
  return { globalPrefix, globalBinary: join(globalPrefix, "bin", "yui") };
}
