import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_SCHEMA_VERSION,
  ensureStorageSchema,
  inspectStorageSchema,
  requireStorageSchema,
  STORAGE_MIGRATIONS
} from "../dist/storage/storageSchema.js";
import {
  FileTaskStore,
  STORAGE_STATE_FILE
} from "../dist/storage/taskStore.js";

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), "taskmux-file-store-"));
}

test("storage schema initializes v5 and rejects every non-current version", () => {
  const home = temporaryHome();
  assert.equal(CURRENT_STORAGE_SCHEMA_VERSION, 5);
  assert.deepEqual(STORAGE_MIGRATIONS, []);
  assert.equal(inspectStorageSchema(home).status, "uninitialized");

  ensureStorageSchema(home, new Date("2026-07-19T00:00:00.000Z"));
  assert.deepEqual(JSON.parse(readFileSync(join(home, "schema.json"), "utf8")), {
    schemaVersion: 1,
    storageVersion: 5,
    aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    activeGeneration: null,
    updatedAt: "2026-07-19T00:00:00.000Z"
  });
  assert.equal(inspectStorageSchema(home).status, "current");
  assert.doesNotThrow(() => requireStorageSchema(home));

  for (const storageVersion of [4, 6]) {
    writeFileSync(join(home, "schema.json"), JSON.stringify({
      schemaVersion: 1,
      storageVersion,
      updatedAt: "2026-07-19T00:00:00.000Z"
    }));
    assert.throws(
      () => requireStorageSchema(home),
      storageVersion < 5 ? /older.*no migration/i : /newer.*TaskMux/i
    );
  }
});

test("FileTaskStore commits the authoritative workflow graph in one aggregate write", () => {
  const home = temporaryHome();
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const timestamp = "2026-07-19T00:00:00.000Z";
  const agent = {
    schemaVersion: 2,
    id: "codex",
    adapterId: "codex",
    command: "codex",
    baseArgs: [],
    environment: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const task = {
    schemaVersion: 1,
    id: "task-1",
    title: "Restore storage",
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const globalRole = {
    schemaVersion: 2,
    name: "operator",
    activeAgentId: "codex",
    agentBindings: { codex: { agentId: "codex", adapterId: "codex", config: { adapterId: "codex" } } },
    workspace: home,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const taskRole = {
    ...globalRole,
    name: "leader",
    taskId: task.id,
    status: "idle"
  };
  const globalSessions = {
    schemaVersion: 1,
    owner: { scope: "global", roleName: "operator" },
    activeAgentId: "codex",
    sessions: {
      codex: {
        schemaVersion: 1,
        agentId: "codex",
        adapterId: "codex",
        nativeSessionId: "global-session",
        policy: "fixed",
        status: "ready",
        createdAt: timestamp,
        updatedAt: timestamp
      }
    },
    updatedAt: timestamp
  };
  const taskSessions = {
    ...globalSessions,
    owner: { scope: "task", taskId: task.id, roleName: "leader" },
    sessions: {
      codex: { ...globalSessions.sessions.codex, nativeSessionId: "task-session" }
    }
  };
  const item = {
    schemaVersion: 1,
    id: "work-1",
    taskId: task.id,
    title: "Implement",
    assignee: "leader",
    status: "running",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const run = {
    schemaVersion: 1,
    id: "agent-run-1",
    taskId: task.id,
    roleName: "leader",
    mode: "new",
    input: "implement",
    workItemId: item.id,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };

  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: "codex" });
    tx.saveConfiguredAgent(agent);
    tx.saveGlobalRole(globalRole);
    tx.saveGlobalRoleSessionSet(globalSessions);
    tx.saveTask(task);
    tx.saveRole(task.id, taskRole);
    tx.saveRoleSessionSet(taskSessions);
    tx.saveWorkItem(task.id, item);
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    tx.savePendingWakeup({
      schemaVersion: 1,
      taskId: task.id,
      reasons: ["worker-yielded"],
      requestCount: 1,
      firstRequestedAt: timestamp,
      lastRequestedAt: timestamp
    });
    tx.saveLeaderFailure({
      schemaVersion: 1,
      taskId: task.id,
      nativeSessionId: "task-session",
      message: "failed",
      attemptCount: 1,
      firstFailedAt: timestamp,
      lastFailedAt: timestamp
    });
    tx.saveOperatorNotification({
      schemaVersion: 1,
      taskId: task.id,
      type: "leader-recovery-failed",
      message: "failed",
      createdAt: timestamp,
      updatedAt: timestamp
    });
  });

  const onDisk = JSON.parse(readFileSync(join(home, STORAGE_STATE_FILE), "utf8"));
  assert.equal(onDisk.schemaVersion, 1);
  assert.equal(onDisk.revision, 1);
  assert.deepEqual(store.getConfiguredAgent("codex"), agent);
  assert.deepEqual(store.getGlobalRole("operator"), globalRole);
  assert.deepEqual(store.getGlobalRoleSessionSet("operator"), globalSessions);
  assert.deepEqual(store.getTask(task.id), task);
  assert.deepEqual(store.getRole(task.id, "leader"), taskRole);
  assert.deepEqual(store.getRoleSessionSet(task.id, "leader"), taskSessions);
  assert.deepEqual(store.getWorkItem(task.id, item.id), item);
  assert.deepEqual(store.getAgentRun(task.id, run.id), run);
  assert.deepEqual(store.getActiveAgentRun(task.id, "leader"), run);
  assert.equal(store.listPendingWakeups().length, 1);
  assert.equal(store.getLeaderFailure(task.id)?.message, "failed");
  assert.equal(store.getOperatorNotification(task.id)?.type, "leader-recovery-failed");
  assert.equal(readdirSync(home).some((name) => name.includes(".tmp-")), false);

  const switchedGlobalRole = {
    ...globalRole,
    activeAgentId: "claude",
    agentBindings: {
      ...globalRole.agentBindings,
      claude: { agentId: "claude", adapterId: "claude", config: { adapterId: "claude" } }
    }
  };
  const switchedGlobalSessions = { ...globalSessions, activeAgentId: "claude" };
  assert.doesNotThrow(() => store.saveGlobalRoleWithSessionSet(
    switchedGlobalRole,
    switchedGlobalSessions
  ));
  assert.equal(store.getGlobalRole("operator").activeAgentId, "claude");
  assert.equal(store.getGlobalRoleSessionSet("operator").activeAgentId, "claude");
});

test("FileTaskStore keeps legacy config valid and enforces reconciliation interval bounds", () => {
  const home = temporaryHome();
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);

  assert.deepEqual(store.getConfig(), { schemaVersion: 1 });
  store.saveConfig({ schemaVersion: 1, reconciliationIntervalSeconds: 30 });
  assert.equal(new FileTaskStore(home).getConfig().reconciliationIntervalSeconds, 30);

  for (const reconciliationIntervalSeconds of [4, 301, 30.5]) {
    assert.throws(
      () => store.saveConfig({ schemaVersion: 1, reconciliationIntervalSeconds }),
      /reconciliationIntervalSeconds must be an integer from 5 to 300/
    );
  }
});

test("record versions and aggregate shape are validated without silently repairing data", () => {
  const home = temporaryHome();
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  assert.throws(
    () => store.saveTask({ schemaVersion: 2, id: "task-1" }),
    /Task.*schemaVersion 1/
  );
  assert.throws(
    () => store.saveTask({
      schemaVersion: 1,
      id: "task-invalid",
      title: "Invalid completion",
      status: "completed",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z"
    }),
    /completedAt|completion metadata/i
  );

  writeFileSync(join(home, STORAGE_STATE_FILE), JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    config: { schemaVersion: 1 },
    configuredAgents: {},
    globalRoles: {},
    globalRoleSessionSets: {},
    tasks: {},
    unknownField: true
  }));
  assert.throws(() => new FileTaskStore(home).listTasks(), /unknown field.*unknownField/i);
});

test("separate FileTaskStore instances observe and preserve interleaved writes", () => {
  const home = temporaryHome();
  ensureStorageSchema(home);
  const first = new FileTaskStore(home);
  const second = new FileTaskStore(home);
  const timestamp = "2026-07-19T00:00:00.000Z";
  const configuredAgent = (id, adapterId) => ({
    schemaVersion: 2,
    id,
    adapterId,
    command: id,
    baseArgs: [],
    environment: [],
    createdAt: timestamp,
    updatedAt: timestamp
  });

  first.saveConfiguredAgent(configuredAgent("codex", "codex"));
  second.saveConfiguredAgent(configuredAgent("claude", "claude"));

  assert.deepEqual(
    first.listConfiguredAgents().map(({ id }) => id),
    ["claude", "codex"]
  );
  assert.equal(JSON.parse(readFileSync(join(home, STORAGE_STATE_FILE), "utf8")).revision, 2);
});
