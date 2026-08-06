import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { bindExecution, claimPending } from "../../dist/coordination/workMailbox.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { FileRuntimeEventProcessor } from "../../dist/controller/runtimeEventProcessor.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { runClaudeLifecycleHookCommand } from "../../dist/controller/claudeLifecycleHook.js";
import { runCodexLifecycleHookCommand } from "../../dist/controller/codexLifecycleHook.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunDelivered,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import {
  createRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../../dist/role/role.js";
import { createAgentRun, markAgentRunPushed } from "../../dist/run/agentRun.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createWorkItem, updateWorkItemStatus } from "../../dist/workItem/workItem.js";

// ---------------------------------------------------------------------------
// LAYER 2b — Production-path acceptance boundary (adapter mapping evidence).
// Drives the REAL managed hook entrypoint -> immutable inbox -> processor ->
// canonical fold -> scheduler store, proving that the wiring the review found
// missing now exists: transport records prompt-pushed only, and delivered
// (acceptance) is written exclusively by an exact provider-accepted fold. Still
// seam evidence — no live provider process — never a first-prompt acceptance.
// ---------------------------------------------------------------------------

function fixture(t, adapterId, sessionStatus = "running") {
  const home = mkdtempSync(join(tmpdir(), "yui-provider-accept-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const adapter = new FileSchedulerStoreAdapter(store);
  const first = new Date("2026-08-06T02:00:00.000Z");
  const second = new Date("2026-08-06T02:00:01.000Z");
  const agentId = `${adapterId}-primary`;
  const agent = createConfiguredAgent(agentId, adapterId, adapterId, [], [], first);
  const task = activateTask(createTask("task-1", "Provider acceptance", first), first);
  const binding = createRoleAgentBinding(agent);
  const leader = createRole(task.id, "leader", [binding], agent.id, home, first);
  const worker = createRole(task.id, "worker", [binding], agent.id, home, first);
  const item = updateWorkItemStatus(createWorkItem(
    "work-item-1", task.id, { title: "Do work", assignee: worker.name }, first
  ), "running", first);
  // The run is transport-pushed (never pre-set delivered): acceptance must come
  // from the provider fold under test.
  let run = createAgentRun(
    "agent-run-1", task.id, worker.name, "new", "Do the work", first,
    { workItemId: item.id, effective: resolveEffectiveLaunch({ role: worker, purpose: "execution" }) }
  );
  run = markAgentRunPushed(run, second);
  const nativeSessionId = `${adapterId}-native-1`;
  const target = { kind: "role", taskId: task.id, roleName: worker.name };
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveRole(task.id, leader);
    tx.saveRole(task.id, updateRoleStatus(worker, "running", first));
    tx.saveWorkItem(task.id, item);
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, target, "run-dispatched", first, [{ type: "run", taskId: task.id, id: run.id }]);
    const pending = tx.getWorkMailbox(target);
    tx.saveWorkMailbox(bindExecution(claimPending(pending, {
      batchId: "delivery-1", owner: "worker-delivery", startedAt: first.toISOString()
    }), "delivery-1", { type: "run", taskId: task.id, id: run.id }));
    let sessions = createRoleSessionSet(
      { scope: "task", taskId: task.id, roleName: worker.name }, agent.id, first
    );
    sessions = recordRoleAgentSession(sessions, {
      agentId: agent.id, adapterId, nativeSessionId, launchId: "launch-1",
      policy: "fixed", status: sessionStatus, effective: run.effective
    }, first);
    sessions = bindTaskRoleRun(sessions, {
      agentId: agent.id, runId: run.id, receiptId: `agent-run:${task.id}/${run.id}`
    }, first);
    sessions = markTaskRoleRunDelivered(sessions, {
      agentId: agent.id, runId: run.id, receiptId: `agent-run:${task.id}/${run.id}`
    }, second);
    tx.saveTaskRoleSessionSet(sessions);
  });
  const environment = {
    YUI_HOME: home, YUI_SESSION_SCOPE: "task", YUI_TASK_ID: task.id,
    YUI_ROLE: worker.name, YUI_AGENT_ID: agent.id, YUI_ADAPTER_ID: adapterId,
    YUI_LAUNCH_ID: "launch-1", YUI_RUN_ID: run.id, YUI_NATIVE_SESSION_ID: nativeSessionId
  };
  const drain = () => new FileRuntimeEventProcessor(
    new FileRuntimeEventInbox(home), adapter
  ).drain(new Date("2026-08-06T02:00:02.000Z"));
  return { home, store, task, worker, run, agent, nativeSessionId, environment, drain };
}

test("Claude UserPromptSubmit hook folds to provider-accepted and only then writes delivered", async (t) => {
  const fx = fixture(t, "claude");
  // Precondition: the run is pushed (transport) but NOT accepted.
  assert.notEqual(fx.store.getAgentRun(fx.task.id, fx.run.id).pushedAt, undefined);
  assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt, undefined);

  // The managed Claude UserPromptSubmit hook writes an immutable inbox event.
  await runClaudeLifecycleHookCommand(
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: fx.nativeSessionId, prompt: "Do the work" }),
    fx.environment,
    async () => ({})
  );
  const before = new FileRuntimeEventInbox(fx.home).list();
  assert.equal(before.length, 1);
  assert.equal(before[0].type, "native-prompt-accepted");

  // Draining folds the acceptance through the canonical contract -> delivered.
  fx.drain();
  assert.equal(new FileRuntimeEventInbox(fx.home).list().length, 0);
  assert.notEqual(fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt, undefined);
  assert.ok(fx.store.listEvents(fx.task.id).some((e) => e.type === "run.delivered"));
});

test("Codex user_prompt_submit hook folds to provider-accepted and writes delivered", async (t) => {
  const fx = fixture(t, "codex");
  assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt, undefined);

  await runCodexLifecycleHookCommand(
    JSON.stringify({ hook_event_name: "user_prompt_submit", session_id: fx.nativeSessionId, prompt: "Do the work" }),
    fx.environment,
    async () => ({})
  );
  const events = new FileRuntimeEventInbox(fx.home).list();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "native-prompt-accepted");

  fx.drain();
  assert.notEqual(fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt, undefined);
});

test("Claude SessionStart hook folds to a session-lifecycle event, never delivered", async (t) => {
  const fx = fixture(t, "claude", "reserved");
  await runClaudeLifecycleHookCommand(
    JSON.stringify({ hook_event_name: "SessionStart", session_id: fx.nativeSessionId, source: "startup" }),
    fx.environment,
    async () => ({})
  );
  const events = new FileRuntimeEventInbox(fx.home).list();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "native-session-lifecycle");
  assert.equal(events[0].sessionSource, "startup");

  fx.drain();
  // A readiness/session-started fact never advances acceptance.
  assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt, undefined);
  assert.ok(fx.store.listEvents(fx.task.id).some(
    (e) => e.type === "runtime.provider-session-lifecycle" && e.payload.preInputReady === "true"
  ));
});

test("Codex session_start hook records session-lifecycle without pre-input readiness", async (t) => {
  const fx = fixture(t, "codex", "reserved");
  await runCodexLifecycleHookCommand(
    JSON.stringify({ hook_event_name: "session_start", session_id: fx.nativeSessionId }),
    fx.environment,
    async () => ({})
  );
  fx.drain();
  assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt, undefined);
  // Codex session_start is provider-session-started only — preInputReady stays false.
  assert.ok(fx.store.listEvents(fx.task.id).some(
    (e) => e.type === "runtime.provider-session-lifecycle" && e.payload.preInputReady === "false"
  ));
});

test("a UserPromptSubmit hook whose native session mismatches the launch fence fails closed", async (t) => {
  const fx = fixture(t, "claude");
  await assert.rejects(
    runClaudeLifecycleHookCommand(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "wrong-native", prompt: "x" }),
      fx.environment,
      async () => ({})
    ),
    /native session does not match/i
  );
  assert.equal(new FileRuntimeEventInbox(fx.home).list().length, 0);
  assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt, undefined);
});

test("a duplicate provider-accepted fold is idempotent — delivered is written once", async (t) => {
  const fx = fixture(t, "claude");
  const payload = JSON.stringify({
    hook_event_name: "UserPromptSubmit", session_id: fx.nativeSessionId, prompt: "Do the work"
  });
  await runClaudeLifecycleHookCommand(payload, fx.environment, async () => ({}));
  fx.drain();
  const firstDelivered = fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt;
  assert.notEqual(firstDelivered, undefined);

  // A replayed identical acceptance folds idempotently; delivered timestamp holds.
  await runClaudeLifecycleHookCommand(payload, fx.environment, async () => ({}));
  fx.drain();
  assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt, firstDelivered);
  const deliveredEvents = fx.store.listEvents(fx.task.id).filter((e) => e.type === "run.delivered");
  assert.equal(deliveredEvents.length, 1);
});
