import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { listPublicCommandPaths } from "../../dist/cli/commandCatalog.js";
import {
  assertRegistryCoversBaselineToCurrent,
  createProductionRegistry
} from "../../dist/storage/migration/index.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { moveSqliteFileSet } from "../../dist/storage/upgrade/sqliteFileSet.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { builtinAgentDriverRegistry } from "../../dist/runtime/builtinAgentDrivers.js";
import { runtimeObservationSemanticKey } from "../../dist/runtime/runtimeObservation.js";
import { createPromptEnvelope } from "../../dist/runtime/promptEnvelope.js";
import {
  CodexAppServerRuntime,
  codexNotificationBoundary
} from "../../dist/runtime/index.js";
import {
  createWorkMailbox,
  enqueueSignal,
  nextPendingBatch
} from "../../dist/coordination/workMailbox.js";

const root = resolve(import.meta.dirname, "../..");

test("the packaged CLI starts and exposes the core workflow", () => {
  const help = execFileSync(process.execPath, [join(root, "dist", "cli.js"), "help"], {
    cwd: root,
    encoding: "utf8"
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
  const now = new Date("2026-08-20T00:00:00.000Z");
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

test("a SQLite switch backs up the database and its live WAL file set", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-sqlite-switch-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = join(home, "yui.db");
  const backup = join(home, "yui.db.backup");
  writeFileSync(source, "database");
  writeFileSync(`${source}-wal`, "wal");
  writeFileSync(`${source}-shm`, "shm");

  moveSqliteFileSet(source, backup);

  assert.equal(existsSync(source), false);
  assert.equal(existsSync(`${source}-wal`), false);
  assert.equal(existsSync(`${source}-shm`), false);
  assert.equal(readFileSync(backup, "utf8"), "database");
  assert.equal(readFileSync(`${backup}-wal`, "utf8"), "wal");
  assert.equal(readFileSync(`${backup}-shm`, "utf8"), "shm");
});

test("the production migration graph advances the normal aggregate path", () => {
  const registry = createProductionRegistry();
  assert.doesNotThrow(() => assertRegistryCoversBaselineToCurrent(registry));
  const step = registry.lookup("aggregate", undefined, 18);
  assert.notEqual(step, undefined);
  const source = {
    schemaManifest: { aggregateSchemaVersion: 18 },
    state: { schemaVersion: 18, tasks: {} }
  };
  step.preconditions(source);
  const migrated = step.transform(source);
  assert.equal(migrated.schemaManifest.aggregateSchemaVersion, 19);
  assert.equal(migrated.state.schemaVersion, 19);

  const currentStep = registry.lookup("aggregate", undefined, 19);
  assert.notEqual(currentStep, undefined);
  const currentSource = {
    schemaManifest: { aggregateSchemaVersion: 19 },
    state: { schemaVersion: 19, tasks: {} }
  };
  currentStep.preconditions(currentSource);
  const current = currentStep.transform(currentSource);
  assert.equal(current.schemaManifest.aggregateSchemaVersion, 20);
  assert.equal(current.state.schemaVersion, 20);
});

test("the built-in Agent Drivers are available through the shared registry", () => {
  const drivers = builtinAgentDriverRegistry();
  assert.equal(drivers.requireByAdapterId("codex").id, "openai/codex");
  assert.equal(drivers.requireByAdapterId("claude").id, "anthropic/claude-code");
});

test("the Codex App Server adapter keeps attachment and Run boundaries separate", async () => {
  const calls = [];
  const runtime = new CodexAppServerRuntime({
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/read") {
        return {
          thread: {
            id: params.threadId,
            status: { type: "notLoaded" },
            turns: []
          }
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    }
  });
  const snapshot = await runtime.readConversation("thread-1");
  assert.equal(snapshot.status, "notLoaded");
  assert.equal(snapshot.latestTurnStatus, undefined);
  assert.deepEqual(codexNotificationBoundary({
    method: "thread/closed",
    params: { threadId: "thread-1" }
  }), {
    kind: "activation-ended",
    conversationId: "thread-1"
  });
  assert.deepEqual(calls.map(({ method }) => method), ["thread/read"]);
});

test("the runtime coordination core keeps correction lanes and terminal facts stable", () => {
  const continuationEnvelope = createPromptEnvelope({
    id: "agent-input:task-1/agent-run-1/normal:2-3",
    source: { kind: "run-input", taskId: "task-1", localId: "agent-run-1" },
    text: "New durable facts are available.",
    createdAt: new Date("2026-08-20T00:00:00.000Z")
  });
  assert.equal(continuationEnvelope.source.kind, "run-input");
  let mailbox = createWorkMailbox({ kind: "role", taskId: "task-1", roleName: "leader" });
  mailbox = enqueueSignal(mailbox, {
    reason: "worker-result",
    refs: [{ type: "event", taskId: "task-1", id: "event-1" }],
    occurredAt: "2026-08-20T00:00:00.000Z",
    dedupeKey: "event-1",
    lane: "normal"
  });
  mailbox = enqueueSignal(mailbox, {
    reason: "user-correction",
    refs: [{ type: "message", taskId: "task-1", id: "message-1" }],
    occurredAt: "2026-08-20T00:00:01.000Z",
    dedupeKey: "message-1",
    lane: "user-correction",
    deliveryMode: "steer-if-safe"
  });
  assert.equal(nextPendingBatch(mailbox), mailbox.pending.userCorrection);
  assert.equal(mailbox.pending.normal.requestCount, 1);

  const fence = {
    taskId: "task-1",
    roleName: "leader",
    runId: "agent-run-1",
    agentId: "agent-1",
    driverId: "anthropic/claude-code",
    launchId: "activation-1",
    sessionGenerationId: "activation-1",
    conversationId: "conversation-1",
    activationId: "activation-1",
    nativeSessionId: "conversation-1",
    nativeTurnId: "turn-1"
  };
  const first = runtimeObservationSemanticKey({
    eventId: "end-1", kind: "turn.completed", fence, sequence: 1, payload: {}
  });
  const replay = runtimeObservationSemanticKey({
    eventId: "end-2", kind: "turn.completed", fence, sequence: 1_386, payload: {}
  });
  assert.equal(first, replay);
  const otherAccount = runtimeObservationSemanticKey({
    eventId: "end-3",
    kind: "turn.completed",
    fence: { ...fence, agentId: "agent-2" },
    sequence: 1,
    payload: {}
  });
  assert.notEqual(first, otherAccount);
});
