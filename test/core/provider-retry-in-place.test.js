import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { FileRuntimeEventProcessor } from "../../dist/controller/runtimeEventProcessor.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { runClaudeLifecycleHookCommand } from "../../dist/controller/claudeLifecycleHook.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunDelivered,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import {
  createRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../../dist/role/role.js";
import {
  createAgentRun,
  markAgentRunDelivered,
  withProviderRetry
} from "../../dist/run/agentRun.js";
import {
  nextProviderRetryDelayMs,
  scheduleProviderRetry
} from "../../dist/run/providerRetry.js";
import { processActiveRoleRunDeliveries } from "../../dist/scheduler/activeRoleRunDelivery.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { taskOwnedWorkspace } from "../helpers/taskWorkspace.js";
import { createWorkItem, updateWorkItemStatus } from "../../dist/workItem/workItem.js";
import { createIsolatedRuntime } from "../helpers/isolatedRuntime.js";
import { testEffectiveLaunch } from "../helpers/effectiveLaunch.js";
import { installMockProviderCommands } from "../helpers/mockProviderCommands.js";

/**
 * Issue 04 — durable in-place Provider retry on the original Native Session.
 *
 * A transient Provider failure (500/504/server_error) keeps the exact Run and
 * Native Session: the Run stays `active` with a `providerRetry` projection,
 * the Controller re-pushes on the durable `nextAttemptAt` timer, and the
 * Session identity never changes. Only a proven Session death terminalizes
 * with a replacement blocker; a policy denial blocks without replacement.
 */

const BASE = new Date("2026-08-17T00:00:00.000Z");

function hookCommon(hookEventName) {
  return {
    session_id: "native-1",
    prompt_id: "550e8400-e29b-41d4-a716-446655440000",
    transcript_path: "/tmp/claude/native-1.jsonl",
    cwd: "/tmp/managed-workspace",
    permission_mode: "dontAsk",
    effort: { level: "max" },
    hook_event_name: hookEventName
  };
}

function fixture(t) {
  const { home } = createIsolatedRuntime(t);
  installMockProviderCommands(home, ["claude"]);
  ensureStorageSchema(home, BASE);
  const store = new FileTaskStore(home);
  const first = new Date(BASE.getTime());
  const second = new Date(BASE.getTime() + 1_000);
  const agent = createConfiguredAgent("claude-primary", "claude", "claude", [], [], first);
  const task = activateTask(createTask("task-1", "Provider retry", first, {
    cwd: home
  }), first);
  const binding = createRoleAgentBinding(agent);
  const leader = createRole(task.id, "leader", [binding], agent.id, home, first);
  const worker = createRole(task.id, "worker", [binding], agent.id, home, first);
  const item = updateWorkItemStatus(createWorkItem(
    "work-item-1",
    task.id,
    { title: "Return exact result", assignee: worker.name },
    first
  ), "running", first);
  let run = createAgentRun(
    "agent-run-1",
    task.id,
    worker.name,
    "new",
    "Do the work",
    first,
    {
      workItemId: item.id,
      effective: resolveEffectiveLaunch({ role: worker, purpose: "execution" })
    }
  );
  run = markAgentRunDelivered(run, second);
  const target = { kind: "role", taskId: task.id, roleName: worker.name };
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveManagedWorkspace(taskOwnedWorkspace(task, first));
    tx.saveRole(task.id, leader);
    tx.saveRole(task.id, updateRoleStatus(worker, "running", first));
    tx.saveWorkItem(task.id, item);
    tx.saveActiveAgentRun(run);
    let sessions = createRoleSessionSet(
      { scope: "task", taskId: task.id, roleName: worker.name },
      agent.id,
      first
    );
    sessions = recordRoleAgentSession(sessions, {
      agentId: agent.id,
      adapterId: "claude",
      nativeSessionId: "native-1",
      launchId: "launch-1",
      policy: "fixed",
      status: "running",
      effective: run.effective
    }, first);
    sessions = bindTaskRoleRun(sessions, {
      agentId: agent.id,
      runId: run.id,
      receiptId: `agent-run:${task.id}/${run.id}`
    }, first);
    sessions = markTaskRoleRunDelivered(sessions, {
      agentId: agent.id,
      runId: run.id,
      receiptId: `agent-run:${task.id}/${run.id}`
    }, second);
    tx.saveTaskRoleSessionSet(sessions);
  });
  return { home, store, task, worker, item, run, agent, target, first, second };
}

function withRetryEnv(t) {
  const previous = {
    inPlace: process.env.YUI_PROVIDER_RETRY_IN_PLACE,
    mode: process.env.YUI_PROVIDER_RETRY_MODE
  };
  process.env.YUI_PROVIDER_RETRY_IN_PLACE = "claude";
  process.env.YUI_PROVIDER_RETRY_MODE = "enforce";
  t.after(() => {
    if (previous.inPlace === undefined) delete process.env.YUI_PROVIDER_RETRY_IN_PLACE;
    else process.env.YUI_PROVIDER_RETRY_IN_PLACE = previous.inPlace;
    if (previous.mode === undefined) delete process.env.YUI_PROVIDER_RETRY_MODE;
    else process.env.YUI_PROVIDER_RETRY_MODE = previous.mode;
  });
}

async function injectStopFailure(fx, now, error = "server_error", errorDetails = "upstream 503") {
  await runClaudeLifecycleHookCommand(JSON.stringify({
    ...hookCommon("StopFailure"),
    error,
    error_details: errorDetails,
    last_assistant_message: "partial output"
  }), {
    YUI_HOME: fx.home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: fx.task.id,
    YUI_ROLE: fx.worker.name,
    YUI_AGENT_ID: fx.agent.id,
    YUI_ADAPTER_ID: "claude",
    YUI_WORKSPACE: fx.run.effective.workspace.root,
    YUI_LAUNCH_ID: "launch-1",
    YUI_RUN_ID: fx.run.id,
    YUI_NATIVE_SESSION_ID: "native-1"
  }, async () => ({}));
  const inbox = new FileRuntimeEventInbox(fx.home);
  const adapter = new FileSchedulerStoreAdapter(fx.store);
  const drained = new FileRuntimeEventProcessor(inbox, adapter).drain(now);
  assert.deepEqual(drained.failed, []);
  return adapter;
}

function recordingDelivery(fx, calls) {
  return {
    async prepareRoleSession(input) {
      calls.push({ phase: "prepare", mode: input.mode, nativeSessionId: input.nativeSessionId });
      return { ...input, deliveryId: `delivery-${calls.length}`, sessionStarted: false };
    },
    async waitUntilReady(prepared) {
      calls.push({ phase: "ready" });
      const session = fx.store.getRoleSession(fx.task.id, fx.worker.name);
      return {
        prepared,
        session: {
          agentId: session.agentId,
          adapterId: session.adapterId,
          nativeSessionId: session.nativeSessionId,
          status: "running",
          effective: session.effective
        }
      };
    },
    async sendOnce() {
      calls.push({ phase: "send" });
      return "sent";
    },
    async inspectRole() { return "present"; },
    async inspectRoles(inputs) {
      return inputs.map(({ taskId, roleName }) => ({ taskId, roleName, status: "present" }));
    },
    async stopTask() { return false; }
  };
}

test("10 transient failures then success keep the same Run, Session, and launch with capped backoff", async (t) => {
  withRetryEnv(t);
  const fx = fixture(t);
  const runId = fx.run.id;
  let now = new Date(fx.second.getTime() + 1_000);
  const delays = [];

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    // A transient StopFailure schedules an in-place retry instead of failing.
    await injectStopFailure(fx, now);
    let active = fx.store.getAgentRun(fx.task.id, runId);
    assert.equal(active.status, "active", `attempt ${attempt}: Run must stay active`);
    assert.ok(active.providerRetry, `attempt ${attempt}: projection must exist`);
    assert.equal(active.providerRetry.attempt, attempt, `attempt ${attempt}: lineage`);
    assert.equal(active.providerRetry.errorClass, "transient-provider");
    assert.equal(active.providerRetry.nativeSessionId, "native-1");
    assert.equal(active.providerRetry.launchId, "launch-1");
    assert.ok(active.providerRetry.nextAttemptAt !== undefined);
    const expectedDelay = nextProviderRetryDelayMs(attempt);
    delays.push(expectedDelay);

    // Advance past the durable timer and resolve + re-deliver in one pass.
    now = new Date(Date.parse(active.providerRetry.nextAttemptAt) + 1);
    const adapter = new FileSchedulerStoreAdapter(fx.store);
    const reopened = adapter.resolveDueProviderRetries(now);
    assert.equal(reopened.length, 1, `attempt ${attempt}: one due retry reopened`);
    const calls = [];
    const results = await processActiveRoleRunDeliveries(
      adapter,
      recordingDelivery(fx, calls),
      now
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "delivered");
    assert.equal(results[0].runId, runId);
    // The re-push must resume the exact same Native Session.
    assert.equal(calls[0].mode, "resume");
    assert.equal(calls[0].nativeSessionId, "native-1");

    active = fx.store.getAgentRun(fx.task.id, runId);
    assert.equal(active.status, "active");
    assert.equal(active.mode, "resume");
    assert.ok(active.pushedAt !== undefined, "retry must re-push the Run");
    assert.equal(active.providerRetry.nativeSessionId, "native-1");
    assert.equal(active.providerRetry.launchId, "launch-1");
    // The projection is in-flight while the re-pushed turn is outstanding.
    assert.equal(active.providerRetry.nextAttemptAt, undefined);
    now = new Date(now.getTime() + 1_000);
  }

  // Backoff is exponential and capped at 60s.
  assert.equal(delays[0], 1_000);
  assert.equal(delays[1], 2_000);
  assert.equal(delays[5], 32_000);
  assert.equal(delays[9], 60_000, "backoff must cap at 60s");

  // The 11th turn succeeds: the same Run yields with a receipt.
  const yieldResult = runTaskCommand(
    ["run", "yield", `${fx.task.id}/${runId}`, "--summary", "done after retries"],
    fx.store,
    { now: () => now }
  );
  assert.equal(yieldResult.kind, "output");
  const terminal = fx.store.getAgentRun(fx.task.id, runId);
  assert.equal(terminal.status, "yielded");
  assert.ok(terminal.yieldReceipt, "successful yield after retries must record a receipt");
  assert.equal(terminal.providerRetry, undefined, "terminal Run must clear the retry projection");
  assert.equal(fx.store.listAgentRuns(fx.task.id).length, 1, "no new Run was created");
  // The Session identity never changed across all 10 retries.
  const session = fx.store.getRoleSession(fx.task.id, fx.worker.name);
  assert.equal(session.nativeSessionId, "native-1");
  assert.equal(session.launchId, "launch-1");
});

test("a proven Session death stops in-place retry with a replacement blocker", async (t) => {
  withRetryEnv(t);
  const fx = fixture(t);
  const runId = fx.run.id;
  const now = new Date(fx.second.getTime() + 1_000);
  await injectStopFailure(fx, now);
  let active = fx.store.getAgentRun(fx.task.id, runId);
  assert.equal(active.status, "active");
  assert.ok(active.providerRetry);

  // Simulate the original Session dying before the retry is due.
  const sessions = fx.store.getTaskRoleSessionSet(fx.task.id, fx.worker.name);
  const dead = {
    ...sessions,
    sessions: {
      [fx.agent.id]: {
        ...sessions.sessions[fx.agent.id],
        status: "broken"
      }
    }
  };
  fx.store.saveTaskRoleSessionSet(dead);

  const dueAt = new Date(Date.parse(active.providerRetry.nextAttemptAt) + 1);
  const adapter = new FileSchedulerStoreAdapter(fx.store);
  const reopened = adapter.resolveDueProviderRetries(dueAt);
  assert.equal(reopened.length, 0, "a dead Session must not be reopened");

  const terminal = fx.store.getAgentRun(fx.task.id, runId);
  assert.equal(terminal.status, "failed");
  assert.match(terminal.summary, /Provider retry stopped/);
  assert.match(terminal.summary, /replacement Session requires an explicit Leader recovery/);
  assert.ok(
    fx.store.listEvents(fx.task.id).some((e) => e.type === "runtime.provider-retry-session-dead"),
    "session-dead must emit a dedicated event"
  );
  // The Leader is woken to make the replacement decision.
  const leaderMailbox = fx.store.getWorkMailbox({ kind: "role", taskId: fx.task.id, roleName: "leader" });
  assert.ok(leaderMailbox.pending.reasons.includes("role-run-failed"));
});

test("cyber_policy blocks without Session replacement or permission widening", async (t) => {
  withRetryEnv(t);
  const fx = fixture(t);
  const runId = fx.run.id;
  const now = new Date(fx.second.getTime() + 1_000);
  await injectStopFailure(fx, now, "cyber_policy violation", "permission boundary");

  const active = fx.store.getAgentRun(fx.task.id, runId);
  assert.equal(active.status, "active", "policy-denied must not terminalize the Run");
  assert.ok(active.providerRetry);
  assert.equal(active.providerRetry.errorClass, "policy-denied");
  assert.equal(active.providerRetry.nextAttemptAt, undefined, "policy-denied must not schedule a retry");
  assert.equal(active.providerRetry.nativeSessionId, "native-1", "original Session is preserved");

  // No replacement Session was created and no retry is pending.
  const adapter = new FileSchedulerStoreAdapter(fx.store);
  assert.deepEqual(adapter.listPendingProviderRetries(), []);
  const session = fx.store.getRoleSession(fx.task.id, fx.worker.name);
  assert.equal(session.nativeSessionId, "native-1");
  assert.equal(session.launchId, "launch-1");
  // The Leader receives a bounded blocker, not a retry loop.
  const leaderMailbox = fx.store.getWorkMailbox({ kind: "role", taskId: fx.task.id, roleName: "leader" });
  assert.ok(leaderMailbox.pending.reasons.includes("provider-policy-blocked"));
  const classified = fx.store.listEvents(fx.task.id)
    .filter((e) => e.type === "runtime.provider-retry-classified");
  assert.ok(classified.some((e) => e.payload.errorClass === "policy-denied"));
});

test("a Controller restart resumes the same retry attempt lineage from durable state", async (t) => {
  withRetryEnv(t);
  const fx = fixture(t);
  const runId = fx.run.id;
  const now = new Date(fx.second.getTime() + 1_000);
  await injectStopFailure(fx, now);
  const before = fx.store.getAgentRun(fx.task.id, runId);
  assert.equal(before.providerRetry.attempt, 1);
  const nextAttemptAt = before.providerRetry.nextAttemptAt;

  // Simulate a Controller restart: a brand-new adapter over the same Home.
  const restartedStore = new FileTaskStore(fx.home);
  const restartedAdapter = new FileSchedulerStoreAdapter(restartedStore);
  const pending = restartedAdapter.listPendingProviderRetries();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].runId, runId);
  assert.equal(pending[0].nextAttemptAt, nextAttemptAt);

  // The restarted Controller resolves the durable timer and re-delivers on
  // the original Session, rebinding the in-flight fence.
  const secondNow = new Date(Date.parse(nextAttemptAt) + 1);
  const reopened = restartedAdapter.resolveDueProviderRetries(secondNow);
  assert.equal(reopened.length, 1);
  const restartedFx = { ...fx, store: restartedStore };
  const calls = [];
  const results = await processActiveRoleRunDeliveries(
    restartedAdapter,
    recordingDelivery(restartedFx, calls),
    secondNow
  );
  assert.equal(results[0].status, "delivered");
  assert.equal(calls[0].mode, "resume");
  assert.equal(calls[0].nativeSessionId, "native-1");

  // A second failure after restart continues the lineage (attempt 2), not a fresh one.
  const thirdNow = new Date(secondNow.getTime() + 1_000);
  await injectStopFailure(restartedFx, thirdNow);
  const after = restartedStore.getAgentRun(fx.task.id, runId);
  assert.equal(after.status, "active");
  assert.equal(after.providerRetry.attempt, 2, "restart must continue the same lineage");
  assert.equal(after.providerRetry.firstFailureAt, before.providerRetry.firstFailureAt);
});

test("SQLite stores answer pending retry scans with a native query", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-provider-retry-sqlite-"));
  const store = new SqliteTaskStore(home);
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  const now = new Date("2026-08-17T00:00:00.000Z");
  const task = activateTask(createTask("task-sqlite", "SQLite retry", now, { cwd: home }), now);
  store.saveTask(task);

  const retry = scheduleProviderRetry(undefined, {
    errorClass: "transient-provider",
    launchId: "launch-sqlite",
    nativeSessionId: "native-sqlite",
    lastErrorSummary: "upstream 500"
  }, now);
  const pendingRun = withProviderRetry(createAgentRun(
    "agent-run-1",
    task.id,
    "worker",
    "new",
    "Do the work",
    now,
    { effective: testEffectiveLaunch({ adapterId: "claude" }) }
  ), retry);
  const inFlightRun = createAgentRun(
    "agent-run-2",
    task.id,
    "worker",
    "new",
    "Also do the work",
    now,
    { effective: testEffectiveLaunch({ adapterId: "claude" }) }
  );
  store.saveAgentRun(pendingRun);
  store.saveAgentRun(inFlightRun);

  const draftTask = createTask("task-draft", "Draft retry", now, { cwd: home });
  store.saveTask(draftTask);
  store.saveAgentRun(withProviderRetry(createAgentRun(
    "agent-run-1",
    draftTask.id,
    "worker",
    "new",
    "Draft work",
    now,
    { effective: testEffectiveLaunch({ adapterId: "claude" }) }
  ), retry));

  const expected = [{
    taskId: task.id,
    roleName: "worker",
    runId: pendingRun.id,
    nextAttemptAt: retry.nextAttemptAt
  }];
  assert.deepEqual(store.listPendingProviderRetries(), expected);
  assert.deepEqual(new FileSchedulerStoreAdapter(store).listPendingProviderRetries(), expected);
});
