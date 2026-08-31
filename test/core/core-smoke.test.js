import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  claimPending,
  completeProcessing,
  createWorkMailbox,
  enqueueSignal,
  releaseProcessing
} from "../../dist/coordination/workMailbox.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { resolveAgentAdapter } from "../../dist/executor/agentAdapter.js";
import {
  startTaskExecutionCommand,
  stopTaskExecutionCommand
} from "../../dist/commands/taskExecutionCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { createProject } from "../../dist/repository/project.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import {
  attachReviewRoundWorkspace,
  createTaskReviewRound,
  finishReviewRound,
  startReviewRound
} from "../../dist/review/reviewRound.js";
import { builtinAgentDriverRegistry } from "../../dist/runtime/builtinAgentDrivers.js";
import { startStructuredProviderSession } from "../../dist/runtime/structuredProviderHost.js";
import { createAsyncRuntimeObserver } from "../../dist/controller/runtimeEventProcessor.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { runRuntimeObservationHookCommand } from "../../dist/controller/runtimeObservationHook.js";
import { createAgentRun, yieldAgentRun } from "../../dist/run/agentRun.js";
import { processOperatorInputNotifications } from "../../dist/scheduler/operatorInputNotificationProcessor.js";
import { buildTaskExecutionProjection } from "../../dist/scheduler/taskExecutionProjection.js";
import { projectNextAction } from "../../dist/task/nextAction.js";
import { listPublicCommandPaths } from "../../dist/cli/commandCatalog.js";
import { acquireHandoverLock } from "../../dist/release/runtimeRelease.js";
import {
  assertRegistryCoversBaselineToCurrent,
  createProductionRegistry
} from "../../dist/storage/migration/index.js";
import { createProductionStorageRegistry } from "../../dist/storage/migration/productionRegistry.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { placeUpgradeFence } from "../../dist/storage/upgradeFence.js";
import { latestStorageVersionState } from "../../dist/storage/upgrade/recordVersions.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { populateSqliteFromState } from "../../dist/storage/upgrade/sqliteStateMigration.js";
import {
  activateTask,
  createTask,
  startTaskExecution,
  stopTaskExecution
} from "../../dist/task/task.js";
import { createWorkItem, updateWorkItemStatus } from "../../dist/workItem/workItem.js";
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
  for (const command of [
    "setup",
    "update",
    "upgrade",
    "task create",
    "task list",
    "task execution stop",
    "task execution start"
  ]) {
    assert.ok(commands.includes(command), `missing core command: ${command}`);
  }
  assert.equal(commands.includes("task run recover"), false);
  assert.equal(commands.includes("task role session switch"), false);
});

test("Managed Codex shares the native App Server used by interactive clients", () => {
  const adapter = resolveAgentAdapter("codex");
  const launch = adapter.compileManagedControl({
    agent: {
      schemaVersion: 2,
      id: "codex",
      adapterId: "codex",
      command: "codex",
      baseArgs: [],
      environment: [],
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      source: "custom"
    },
    config: {
      adapterId: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      permission: { strategy: "bypass" }
    },
    workspace: "/tmp/yui-shared-codex-runtime"
  }, "new");

  assert.equal(launch.transport, "codex-app-server-proxy");
  assert.deepEqual(launch.argv.slice(-2), ["app-server", "proxy"]);
  assert.throws(() => adapter.compileManagedControl({
    agent: {
      schemaVersion: 2,
      id: "codex",
      adapterId: "codex",
      command: "codex",
      baseArgs: [],
      environment: [],
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      source: "custom"
    },
    config: {
      adapterId: "codex",
      permission: { strategy: "bypass" },
      profile: "operator"
    },
    workspace: "/tmp/yui-shared-codex-runtime"
  }, "new"), /cannot be scoped to one shared-daemon thread/u);
});

test("Managed Codex performs the App Server WebSocket handshake through its proxy", async (t) => {
  let session;
  t.after(() => session?.terminate("SIGTERM"));
  let resolveTerminal;
  const terminalPromise = new Promise((resolvePromise) => {
    resolveTerminal = resolvePromise;
  });
  const attemptId = "fake-attempt-1";
  const started = await startStructuredProviderSession({
    schemaVersion: 1,
    launchId: "fake-launch-1",
    command: process.execPath,
    args: [join(root, "test", "fixtures", "fake-codex-app-server-proxy.mjs")],
    environment: bareEnv,
    cwd: root,
    childLifecycle: "persistent",
    startMode: "provider",
    providerControl: {
      schemaVersion: 1,
      adapterId: "codex",
      transport: "codex-app-server-proxy",
      kind: "new",
      mode: "new",
      sessionTitle: "Yui proxy handshake smoke",
      authority: { epoch: 1, owner: "controller", holderId: "core-smoke" },
      codexThread: { model: "gpt-5.6-luna", approvalPolicy: "never", sandbox: "read-only" },
      initialTurn: { attemptId, boundedText: "handshake smoke" }
    }
  }, { onTerminal: resolveTerminal, mirrorOutput: () => {} });
  session = started.session;
  const receipt = await session.submitTurn({ attemptId, boundedText: "handshake smoke" });
  const terminal = await terminalPromise;

  assert.equal(receipt.conversationId, "fake-thread-1");
  assert.equal(receipt.nativeTurnId, "fake-turn-1");
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.clientOwned, true);
});

test("Task execution can be fenced without changing semantic progress", () => {
  const now = new Date("2026-08-30T00:00:00.000Z");
  const active = activateTask(createTask("task-1", "Continue safely", now), now);
  const stopped = stopTaskExecution(active, new Date("2026-08-30T00:01:00.000Z"));
  assert.equal(stopped.status, "active");
  assert.equal(stopped.executionGate.state, "stopped");
  const restarted = startTaskExecution(stopped, new Date("2026-08-30T00:02:00.000Z"));
  assert.equal(restarted.status, "active");
  assert.equal(restarted.executionGate.state, "enabled");
});

test("Task execution stop/start atomically controls scheduler admission", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-execution-gate-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-08-30T00:00:00.000Z");
  const task = activateTask(createTask("task-1", "Preserve progress", now), now);
  store.saveTask(task);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const leader = createRole(
    task.id,
    "leader",
    [binding],
    binding.agentId,
    "/tmp/yui-execution-gate-smoke",
    now
  );
  store.saveRole(task.id, leader);
  const item = updateWorkItemStatus(
    createWorkItem("work-item-1", task.id, { title: "Keep completed edits" }, now),
    "running",
    now
  );
  store.saveWorkItem(task.id, item);
  const activeRun = createAgentRun(
    "agent-run-1",
    task.id,
    leader.name,
    "new",
    "Continue the Task.",
    now,
    {
      effective: {
        schemaVersion: 2,
        sourceDesiredRevision: leader.launchRevision,
        agentId: binding.agentId,
        adapterId: "codex",
        profileAccess: "write",
        search: false,
        permission: { strategy: "default" },
        writeProjectIds: [],
        workspace: { root: leader.workspace, entries: [] },
        context: {}
      }
    }
  );
  store.saveActiveAgentRun(activeRun);

  const stopped = stopTaskExecutionCommand(
    { taskId: task.id, reason: "Operator safety fence" },
    store,
    { now: () => new Date("2026-08-30T00:01:00.000Z"), environment: bareEnv }
  );
  assert.equal(stopped.changed, true);
  assert.equal(store.getTask(task.id).status, "active");
  assert.equal(store.getTask(task.id).executionGate.state, "stopped");
  assert.deepEqual(store.listActiveTaskIds(), []);
  assert.equal(buildTaskExecutionProjection(store, task.id).status, "stopped");
  assert.equal(
    projectNextAction(store.readNextActionFacts(task.id)).recommendedCommand,
    `yui task execution start ${task.id}`
  );
  assert.equal(store.getAgentRun(task.id, activeRun.id).status, "failed");
  assert.equal(store.getActiveAgentRun(task.id, leader.name), null);
  assert.equal(store.getWorkItem(task.id, item.id).status, "running");
  assert.throws(() => runTaskCommand(
    ["run", "retry", `${task.id}/${activeRun.id}`],
    store,
    { now: () => new Date("2026-08-30T00:01:30.000Z"), environment: bareEnv }
  ), /Task execution is stopped/);
  assert.equal(store.getActiveAgentRun(task.id, leader.name), null);

  const started = startTaskExecutionCommand(task.id, store, {
    now: () => new Date("2026-08-30T00:02:00.000Z"),
    environment: bareEnv
  });
  assert.equal(started.changed, true);
  assert.equal(store.getTask(task.id).executionGate.state, "enabled");
  assert.deepEqual(store.listActiveTaskIds(), [task.id]);
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["execution-started"]);

  const completedItem = updateWorkItemStatus(
    store.getWorkItem(task.id, item.id),
    "completed",
    new Date("2026-08-30T00:03:00.000Z"),
    "Edits retained."
  );
  store.saveWorkItem(task.id, completedItem);
  const disposableRun = createAgentRun(
    "agent-run-2",
    task.id,
    leader.name,
    "new",
    "Finish the Task.",
    new Date("2026-08-30T00:03:00.000Z"),
    { effective: activeRun.effective }
  );
  store.saveActiveAgentRun(disposableRun);
  runTaskCommand(
    ["complete", task.id, "--summary", "Delivery complete."],
    store,
    { now: () => new Date("2026-08-30T00:04:00.000Z"), environment: bareEnv }
  );
  assert.equal(store.getTask(task.id).status, "completed");
  assert.equal(store.getAgentRun(task.id, disposableRun.id).status, "failed");
  assert.equal(store.getWorkItem(task.id, completedItem.id).status, "completed");
});

test("a packaged Controller restart inherits its direct parent's handover", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-controller-handover-smoke-"));
  const environment = { ...bareEnv, YUI_HOME: home };
  t.after(() => {
    try {
      execFileSync(
        process.execPath,
        [join(root, "dist", "cli.js"), "controller", "stop"],
        { cwd: root, encoding: "utf8", env: environment }
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  ensureStorageSchema(home);
  new SqliteTaskStore(home).close();

  const handover = acquireHandoverLock(home);
  let restarted;
  try {
    restarted = JSON.parse(execFileSync(
      process.execPath,
      [join(root, "dist", "cli.js"), "--json", "controller", "restart"],
      { cwd: root, encoding: "utf8", env: environment }
    ));
  } finally {
    handover.release();
  }
  assert.equal(restarted.ok, true);
  assert.equal(restarted.data.restarted, true);
  assert.ok(Number.isInteger(restarted.data.pid) && restarted.data.pid > 0);
});

test("the SQLite Task path persists across one in-place schema upgrade", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-core-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date("2026-08-27T00:00:00.000Z");
  ensureStorageSchema(home);
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

  const db = new Database(join(home, "yui.db"));
  db.exec(`
    DROP INDEX idx_context_snapshots_scope_sequence;
    DROP TABLE context_snapshots;
    DELETE FROM schema_migrations WHERE version = 17;
  `);
  db.close();

  const releaseFence = placeUpgradeFence(home, {
    ownerPid: process.ppid,
    reason: "parent update storage activation",
    createdAt: now.toISOString()
  });
  const upgraded = await runStorageUpgrade({
    home,
    mode: "execute",
    controllerLifecycle: "externally-quiesced",
    externalUpgradeFenceOwnerPid: process.ppid,
    registry: createProductionStorageRegistry(),
    latest: latestStorageVersionState(),
    inspectOfflineInventory: async () => ({ total: 0, blockers: [] })
  }).finally(releaseFence);
  assert.equal(upgraded.outcome, "upgraded", JSON.stringify(upgraded));
  assert.equal(upgraded.migrationMode, "in-place");
  assert.equal(upgraded.backupPath, undefined);

  const reopened = new SqliteTaskStore(home);
  assert.equal(reopened.getTask(task.id)?.status, "active");
  assert.deepEqual(reopened.listMessages(task.id), [message]);
  reopened.close();
});

test("the production migration preserves ReviewRound-backed Agent Runs", (t) => {
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
});

test("the production migrations remove duplicate Role and Provider Run state", () => {
  const registry = createProductionRegistry();
  const roleStep = registry.lookup("record", "taskRole", 3);
  const sessionStep = registry.lookup("record", "taskRoleSessionSet", 6);
  assert.ok(roleStep);
  assert.ok(sessionStep);

  const source = {
    schemaManifest: {
      recordVersions: { taskRole: 3, taskRoleSessionSet: 6 }
    },
    state: {
      tasks: {
        "task-1": {
          roles: {
            leader: { schemaVersion: 3, name: "leader", status: "running" }
          },
          roleSessionSets: {
            leader: {
              schemaVersion: 6,
              providerBinding: {
                schemaVersion: 2,
                providerNamespace: "anthropic/claude-code",
                runId: "agent-run-1",
                turn: { attemptId: "receipt-1", status: "completed" }
              }
            }
          }
        }
      }
    }
  };

  roleStep.preconditions(source);
  const roleMigrated = roleStep.transform(source);
  sessionStep.preconditions(roleMigrated);
  const migrated = sessionStep.transform(roleMigrated);
  const aggregate = migrated.state.tasks["task-1"];
  const role = aggregate.roles.leader;
  const binding = aggregate.roleSessionSets.leader.providerBinding;

  assert.equal(migrated.schemaManifest.recordVersions.taskRole, 4);
  assert.equal(migrated.schemaManifest.recordVersions.taskRoleSessionSet, 7);
  assert.equal(role.schemaVersion, 4);
  assert.equal(Object.hasOwn(role, "status"), false);
  assert.equal(binding.schemaVersion, 3);
  assert.equal(Object.hasOwn(binding, "runId"), false);
  assert.equal(binding.turn.runId, "agent-run-1");
});

test("the built-in Agent Drivers are available through the shared registry", () => {
  const drivers = builtinAgentDriverRegistry();
  assert.equal(drivers.requireByAdapterId("codex").id, "openai/codex");
  assert.equal(drivers.requireByAdapterId("claude").id, "anthropic/claude-code");
});

test("Operator batches durable refs and defers the whole batch while busy", async () => {
  const now = new Date("2026-08-28T00:00:00.000Z");
  const event = createTaskEvent(
    "event-1",
    "task-1",
    "task.completed",
    { by: "leader", summary: "Done." },
    now
  );
  let mailbox = enqueueSignal(createWorkMailbox({ kind: "operator" }), {
    reason: "task-terminal",
    refs: [{ type: "event", taskId: event.taskId, id: event.id }],
    occurredAt: now.toISOString()
  });
  let startedTurns = 0;
  const store = {
    getWorkMailbox: () => mailbox,
    claimWorkMailbox: ({ batchId, owner, now: claimedAt }) => {
      mailbox = claimPending(mailbox, { batchId, owner, startedAt: claimedAt.toISOString() });
      return { status: "claimed", processing: mailbox.processing };
    },
    completeWorkMailbox: (_target, batchId) => {
      mailbox = completeProcessing(mailbox, batchId);
      return true;
    },
    releaseWorkMailbox: (_target, batchId) => {
      mailbox = releaseProcessing(mailbox, batchId);
      return true;
    },
    getInputRequest: () => null,
    listEvents: () => [event],
    getOperatorDeliveryTarget: () => ({ roleName: "operator", adapterId: "codex" }),
    markOperatorTurnStarted: () => {
      startedTurns += 1;
    }
  };
  const delivered = [];
  const result = await processOperatorInputNotifications(store, {
    notifyOperatorInputOnce: async (input) => {
      delivered.push(input);
      return "sent";
    }
  }, undefined, now);

  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /yui task event show task-1 event-1/u);
  assert.equal(result[0].status, "sent");
  assert.equal(startedTurns, 1);
  assert.equal(mailbox.processing, null);
  assert.equal(mailbox.pending.normal, null);

  mailbox = enqueueSignal(mailbox, {
    reason: "task-terminal",
    refs: [{ type: "event", taskId: event.taskId, id: event.id }],
    occurredAt: now.toISOString()
  });
  const deferred = await processOperatorInputNotifications(store, {
    notifyOperatorInputOnce: async () => "not-ready"
  }, undefined, now);
  assert.equal(deferred[0].reason, "operator-not-ready");
  assert.equal(startedTurns, 1);
  assert.equal(mailbox.processing, null);
  assert.notEqual(mailbox.pending.normal, null);
});

test("the async runtime observer preserves completion classification", async () => {
  const calls = [];
  const observer = createAsyncRuntimeObserver(async (method) => {
    calls.push(method);
    return method === "classifyGlobalRuntimeTurnCompleted" ? "apply" : "deferred";
  });

  assert.equal(await observer.classifyRuntimeTurnCompleted({}), "deferred");
  assert.equal(await observer.classifyGlobalRuntimeTurnCompleted({}), "apply");
  assert.deepEqual(calls, [
    "classifyRuntimeTurnCompleted",
    "classifyGlobalRuntimeTurnCompleted"
  ]);
});

test("Claude global Stop hooks publish the native completion boundary", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-claude-global-hook-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let signal;
  await runRuntimeObservationHookCommand(JSON.stringify({
    hook_event_name: "Stop",
    session_id: "claude-session-1",
    last_assistant_message: "Done."
  }), {
    YUI_SESSION_SCOPE: "global",
    YUI_HOME: home,
    YUI_DRIVER_ID: "anthropic/claude-code",
    YUI_ADAPTER_ID: "claude",
    YUI_ROLE: "operator",
    YUI_AGENT_ID: "claude",
    YUI_LAUNCH_ID: "launch-1",
    YUI_NATIVE_SESSION_ID: "claude-session-1"
  }, async (_home, _method, params) => {
    signal = params;
    return null;
  }, new Date("2026-08-28T00:00:00.000Z"), { sequence: () => 1 });

  const [event] = new FileRuntimeEventInbox(home).list();
  assert.equal(event.type, "native-turn-completed");
  assert.equal(event.scope, "global");
  assert.equal(event.adapterId, "claude");
  assert.equal(event.summary, "Done.");
  assert.deepEqual(signal, { key: "global-role:operator" });
});
