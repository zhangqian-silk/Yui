import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION,
  ensureStorageSchema,
  inspectStorageSchema,
  requireStorageSchema
} from "../dist/storage/storageSchema.js";
import { currentRecordVersions } from "../dist/storage/upgrade/recordVersions.js";
import {
  FileTaskStore,
  CURRENT_STORED_TASK_SCHEMA_VERSION,
  STORAGE_STATE_FILE
} from "../dist/storage/taskStore.js";

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), "yui-file-store-"));
}

function readEffective(agentId, adapterId, workspace) {
  return {
    schemaVersion: 2,
    sourceDesiredRevision: 1,
    agentId,
    adapterId,
    profileAccess: "read",
    search: false,
    permission: adapterId === "codex"
      ? { strategy: "configured", sandbox: "read-only", approval: "never" }
      : {
          strategy: "configured",
          mode: "dontAsk",
          allowedTools: [
            "Read", "Grep", "Glob",
            "Bash(yui --json task context *)",
            "Bash(yui --json task work show *)",
            "Bash(yui --json task work list *)",
            "Bash(git diff *)", "Bash(git status *)", "Bash(git show *)",
            "Bash(git log *)", "Bash(yui task run yield *)"
          ],
          disallowedTools: ["Edit", "Write", "NotebookEdit"]
        },
    ...(adapterId === "claude" ? { settingsSources: [] } : {}),
    writeProjectIds: [],
    workspace: { root: workspace, entries: [] },
    context: {}
  };
}
test("storage schema initializes layout v7 with aggregate v18 and rejects non-current versions", () => {
  const home = temporaryHome();
  assert.equal(CURRENT_STORAGE_LAYOUT_VERSION, 7);
  assert.equal(CURRENT_AGGREGATE_SCHEMA_VERSION, 18);
  assert.equal(inspectStorageSchema(home).status, "uninitialized");

  ensureStorageSchema(home, new Date("2026-07-19T00:00:00.000Z"));
  const expectedRecordVersions = {};
  for (const [kind, entry] of Object.entries(currentRecordVersions())) {
    expectedRecordVersions[kind] = entry.version;
  }
  assert.deepEqual(JSON.parse(readFileSync(join(home, "schema.json"), "utf8")), {
    schemaVersion: 1,
    storageVersion: 7,
    aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION,
    recordVersions: expectedRecordVersions,
    updatedAt: "2026-07-19T00:00:00.000Z"
  });
  assert.equal(inspectStorageSchema(home).status, "current");
  assert.doesNotThrow(() => requireStorageSchema(home));

  for (const storageVersion of [5, 6, 8]) {
    writeFileSync(join(home, "schema.json"), JSON.stringify({
      schemaVersion: 1,
      storageVersion,
      aggregateSchemaVersion: 1,
      updatedAt: "2026-07-19T00:00:00.000Z"
    }));
    assert.throws(
      () => requireStorageSchema(home),
      storageVersion < 7 ? /older.*no migration/i : /newer.*Yui/i
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
    schemaVersion: 4,
    id: "task-1",
    title: "Restore storage",
    projectBindings: [],
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp
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
        createdAt: timestamp,
        updatedAt: timestamp
      }
    },
    updatedAt: timestamp
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
  const item = {
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
    candidates: [],
    createdAt: timestamp,
    updatedAt: timestamp
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
  assert.equal(onDisk.schemaVersion, 18);
  assert.equal(onDisk.tasks[task.id].schemaVersion, CURRENT_STORED_TASK_SCHEMA_VERSION);
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
      claude: {
        agentId: "claude",
        adapterId: "claude",
        config: { adapterId: "claude", permission: { strategy: "bypass" } }
      }
    }
  };
  const switchedGlobalSessions = { ...globalSessions, activeAgentId: "claude" };
  assert.doesNotThrow(() => store.saveGlobalRoleWithSessionSet(
    switchedGlobalRole,
    switchedGlobalSessions
  ));
  assert.equal(store.getGlobalRole("operator").activeAgentId, "claude");
  assert.equal(store.getGlobalRoleSessionSet("operator").activeAgentId, "claude");

  const incompatible = JSON.parse(readFileSync(join(home, STORAGE_STATE_FILE), "utf8"));
  incompatible.tasks[task.id].schemaVersion = 1;
  writeFileSync(join(home, STORAGE_STATE_FILE), JSON.stringify(incompatible));
  assert.throws(
    () => new FileTaskStore(home).listTasks(),
    new RegExp(`Task aggregate task-1 must use schemaVersion ${CURRENT_STORED_TASK_SCHEMA_VERSION}`)
  );
});

test("FileTaskStore persists strict task, role, and operator WorkMailboxes", () => {
  const home = temporaryHome();
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const timestamp = "2026-07-22T00:00:00.000Z";
  const task = {
    schemaVersion: 4,
    id: "task-1",
    title: "Mailbox storage",
    projectBindings: [],
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const role = {
    schemaVersion: 3,
    launchRevision: 1,
    defaultAccess: "write",
    name: "leader",
    taskId: task.id,
    status: "idle",
    activeAgentId: "codex",
    agentBindings: {
      codex: {
        agentId: "codex",
        adapterId: "codex",
        config: { adapterId: "codex", permission: { strategy: "bypass" } }
      }
    },
    workspace: home,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  store.saveTask(task);
  store.saveRole(task.id, role);

  const mailboxes = [
    {
      schemaVersion: 1,
      target: { kind: "task", taskId: task.id },
      nextSequence: 2,
      processing: null,
      pending: {
        fromSequence: 1,
        toSequence: 1,
        reasons: ["activated"],
        refs: [{ type: "task", id: task.id }],
        requestCount: 1,
        firstQueuedAt: timestamp,
        lastQueuedAt: timestamp
      }
    },
    {
      schemaVersion: 1,
      target: { kind: "role", taskId: task.id, roleName: role.name },
      nextSequence: 1,
      processing: null,
      pending: null
    },
    {
      schemaVersion: 1,
      target: { kind: "operator" },
      nextSequence: 1,
      processing: null,
      pending: null
    }
  ];
  store.transaction((tx) => mailboxes.forEach((mailbox) => tx.saveWorkMailbox(mailbox)));

  assert.deepEqual(store.listWorkMailboxes(), [mailboxes[2], mailboxes[1], mailboxes[0]]);
  assert.deepEqual(store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: role.name }), mailboxes[1]);
  const state = JSON.parse(readFileSync(join(home, STORAGE_STATE_FILE), "utf8"));
  assert.deepEqual(Object.keys(state.mailboxes), [
    "task/task-1",
    "role/task-1/leader",
    "operator"
  ]);
  assert.equal(Object.hasOwn(state.tasks[task.id], "pendingWakeup"), false);

  const processingMailbox = {
    schemaVersion: 1,
    target: { kind: "role", taskId: task.id, roleName: role.name },
    nextSequence: 2,
    processing: {
      batchId: "batch-1",
      batch: {
        fromSequence: 1,
        toSequence: 1,
        reasons: ["initial"],
        refs: [{ type: "task", id: task.id }],
        requestCount: 1,
        firstQueuedAt: timestamp,
        lastQueuedAt: timestamp
      },
      owner: "controller-1",
      startedAt: timestamp
    },
    pending: null
  };
  store.saveWorkMailbox(processingMailbox);
  store.savePendingWakeup({
    schemaVersion: 1,
    taskId: task.id,
    reasons: ["user-message"],
    requestCount: 1,
    firstRequestedAt: timestamp,
    lastRequestedAt: timestamp
  });
  const signalledWhileProcessing = store.getWorkMailbox(processingMailbox.target);
  assert.deepEqual(signalledWhileProcessing.processing, processingMailbox.processing);
  assert.deepEqual(signalledWhileProcessing.pending, {
    fromSequence: 2,
    toSequence: 2,
    reasons: ["user-message"],
    refs: [],
    requestCount: 1,
    firstQueuedAt: timestamp,
    lastQueuedAt: timestamp
  });
  assert.equal(signalledWhileProcessing.nextSequence, 3);

  assert.equal(store.removeWorkMailbox({ kind: "operator" }), true);
  assert.equal(store.removeWorkMailbox({ kind: "operator" }), false);
});

test("FileTaskStore rejects mailbox identity and dangling cross-references", () => {
  const home = temporaryHome();
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const timestamp = "2026-07-22T00:00:00.000Z";
  store.saveTask({
    schemaVersion: 4,
    id: "task-1",
    title: "Mailbox validation",
    projectBindings: [],
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const statePath = join(home, STORAGE_STATE_FILE);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.mailboxes["task/wrong-key"] = {
    schemaVersion: 1,
    target: { kind: "task", taskId: "task-1" },
    nextSequence: 2,
    processing: null,
    pending: {
      fromSequence: 1,
      toSequence: 1,
      reasons: ["changed"],
      refs: [{ type: "run", taskId: "task-1", id: "agent-run-99" }],
      requestCount: 1,
      firstQueuedAt: timestamp,
      lastQueuedAt: timestamp
    }
  };
  writeFileSync(statePath, JSON.stringify(state));
  assert.throws(() => new FileTaskStore(home).listTasks(), /mailbox identity.*wrong-key/i);

  state.mailboxes = { "task/task-1": state.mailboxes["task/wrong-key"] };
  writeFileSync(statePath, JSON.stringify(state));
  assert.throws(() => new FileTaskStore(home).listTasks(), /mailbox reference.*agent-run-99/i);
});

test("FileTaskStore keeps legacy config valid and validates recovery and timezone settings", () => {
  const home = temporaryHome();
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);

  assert.deepEqual(store.getConfig(), { schemaVersion: 1 });
  store.saveConfig({
    schemaVersion: 1,
    reconciliationIntervalSeconds: 30,
    timeZone: "Asia/Shanghai"
  });
  assert.equal(new FileTaskStore(home).getConfig().reconciliationIntervalSeconds, 30);
  assert.equal(new FileTaskStore(home).getConfig().timeZone, "Asia/Shanghai");

  for (const reconciliationIntervalSeconds of [4, 301, 30.5]) {
    assert.throws(
      () => store.saveConfig({ schemaVersion: 1, reconciliationIntervalSeconds }),
      /reconciliationIntervalSeconds must be an integer from 5 to 300/
    );
  }
  assert.throws(
    () => store.saveConfig({ schemaVersion: 1, timeZone: "not/a-zone" }),
    /timeZone must be a valid IANA timezone/
  );
});

test("record versions and aggregate shape are validated without silently repairing data", () => {
  const home = temporaryHome();
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  assert.throws(
    () => store.saveTask({ schemaVersion: 1, id: "task-1" }),
    /Task.*schemaVersion 4/
  );
  assert.throws(
    () => store.saveTask({
      schemaVersion: 4,
      id: "task-invalid",
      title: "Invalid completion",
      projectBindings: [],
      status: "completed",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z"
    }),
    /completedAt|completion metadata/i
  );

  const timestamp = "2026-07-19T00:00:00.000Z";
  const task = {
    schemaVersion: 4,
    id: "task-1",
    title: "Validate WorkItem cleanup",
    projectBindings: [],
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const item = {
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
    assignee: "leader",
    status: "completed",
    candidates: [],
    outcome: "Done",
    endedAt: timestamp,
    workspaceDisposition: "integrated",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  store.saveTask(task);
  store.saveWorkItem(task.id, item);
  assert.equal(
    new FileTaskStore(home).getWorkItem(task.id, item.id).workspaceDisposition,
    "integrated"
  );

  writeFileSync(join(home, STORAGE_STATE_FILE), JSON.stringify({
    schemaVersion: 17,
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
  assert.deepEqual(
    first.listConfiguredAgents().map(({ id }) => id),
    ["codex"]
  );
  assert.deepEqual(
    first.transaction((store) => store.listConfiguredAgents().map(({ id }) => id)),
    ["codex"]
  );
  second.saveConfiguredAgent(configuredAgent("claude", "claude"));

  assert.deepEqual(
    first.transaction((store) => store.listConfiguredAgents().map(({ id }) => id)),
    ["claude", "codex"]
  );
  assert.equal(JSON.parse(readFileSync(join(home, STORAGE_STATE_FILE), "utf8")).revision, 2);
});
