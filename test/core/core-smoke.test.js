import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  claimPending,
  completeProcessing,
  createWorkMailbox,
  enqueueSignal,
  releaseProcessing
} from "../../dist/coordination/workMailbox.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { createProject } from "../../dist/repository/project.js";
import {
  attachReviewRoundWorkspace,
  createTaskReviewRound,
  finishReviewRound,
  startReviewRound
} from "../../dist/review/reviewRound.js";
import { builtinAgentDriverRegistry } from "../../dist/runtime/builtinAgentDrivers.js";
import { createAsyncRuntimeObserver } from "../../dist/controller/runtimeEventProcessor.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { runRuntimeObservationHookCommand } from "../../dist/controller/runtimeObservationHook.js";
import { createAgentRun, yieldAgentRun } from "../../dist/run/agentRun.js";
import { processOperatorInputNotifications } from "../../dist/scheduler/operatorInputNotificationProcessor.js";
import { listPublicCommandPaths } from "../../dist/cli/commandCatalog.js";
import {
  assertRegistryCoversBaselineToCurrent,
  createProductionRegistry
} from "../../dist/storage/migration/index.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
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
