import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunPushed,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import {
  EXACT_CONTROL_ARGUMENT,
  YUI_CONTROL_PLANE_DESCRIPTOR,
  YUI_TASK_RUNTIME_DESCRIPTOR,
  createExactControlPlaneDescriptor,
  createExactTaskRuntimeDescriptor,
  exactControlPlaneDigest,
  exactTaskRuntimeDescriptorPath,
  serializeExactDescriptor
} from "../../dist/runtime/exactControlPlane.js";
import {
  hasRuntimeCleanupObligation,
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../../dist/runtime/lifecycleReservation.js";
import { nativeSessionIdForLaunch } from "../../dist/runtime/preallocatedNativeSession.js";
import {
  createRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../../dist/role/role.js";
import { createAgentRun, markAgentRunPushed } from "../../dist/run/agentRun.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { writeTextFileAtomically } from "../../dist/storage/durableFile.js";
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

function fixture(t, adapterId, sessionStatus = "running", options = {}) {
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
  // Most fixtures begin after the transport receipt. The timeout regression
  // deliberately leaves the push commit absent even though the provider has
  // already executed the native prompt.
  let run = createAgentRun(
    "agent-run-1", task.id, worker.name, "new", "Do the work", first,
    { workItemId: item.id, effective: resolveEffectiveLaunch({ role: worker, purpose: "execution" }) }
  );
  if (options.transportPushed !== false) run = markAgentRunPushed(run, second);
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
    if (options.runtimeDiscovered !== true) {
      sessions = recordRoleAgentSession(sessions, {
        agentId: agent.id, adapterId, nativeSessionId, launchId: "launch-1",
        policy: "fixed", status: sessionStatus, effective: run.effective
      }, first);
    }
    if (options.bindInFlight !== false) {
      sessions = bindTaskRoleRun(sessions, {
        agentId: agent.id, runId: run.id, receiptId: `agent-run:${task.id}/${run.id}`
      }, first);
      if (options.transportPushed !== false) {
        sessions = markTaskRoleRunPushed(sessions, {
          agentId: agent.id, runId: run.id, receiptId: `agent-run:${task.id}/${run.id}`
        }, second);
      }
    }
    tx.saveTaskRoleSessionSet(sessions);
  });
  if (options.runtimeDiscovered === true) {
    adapter.reserveRuntimeLaunch({
      owner: { scope: "task", taskId: task.id, roleName: worker.name },
      launchId: "launch-1",
      runId: run.id
    }, () => {}, first);
  }
  const environment = {
    YUI_HOME: home, YUI_SESSION_SCOPE: "task", YUI_TASK_ID: task.id,
    YUI_ROLE: worker.name, YUI_AGENT_ID: agent.id, YUI_ADAPTER_ID: adapterId,
    YUI_WORKSPACE: run.effective.workspace.root,
    YUI_LAUNCH_ID: "launch-1", YUI_RUN_ID: run.id,
    ...(options.runtimeDiscovered === true ? {} : { YUI_NATIVE_SESSION_ID: nativeSessionId })
  };
  const drain = (drainNow = new Date()) => new FileRuntimeEventProcessor(
    new FileRuntimeEventInbox(home), adapter
  ).drain(drainNow);
  return { home, store, adapter, task, worker, run, agent, nativeSessionId, environment, drain };
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

test("Claude PostToolUse hook records exact in-turn provider progress without acceptance", async (t) => {
  const fx = fixture(t, "claude");
  const acceptance = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: fx.nativeSessionId,
    prompt: "Do the work"
  });
  await runClaudeLifecycleHookCommand(acceptance, fx.environment, async () => ({}));
  fx.drain();
  const deliveredAt = fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt;
  assert.notEqual(deliveredAt, undefined);

  await runClaudeLifecycleHookCommand(JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: fx.nativeSessionId,
    tool_use_id: "toolu_01_progress",
    tool_name: "Read",
    tool_input: { file_path: "/managed/workspace/input.txt" }
  }), fx.environment, async () => ({}));
  const [queued] = new FileRuntimeEventInbox(fx.home).list();
  assert.equal(queued.type, "native-turn-progress");
  assert.equal(queued.progressId, "toolu_01_progress");
  assert.equal(queued.runId, fx.run.id);
  assert.equal(queued.nativeSessionId, fx.nativeSessionId);

  fx.drain();
  assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt, deliveredAt);
  const progress = fx.store.listEvents(fx.task.id).filter(
    (event) => event.type === "runtime.provider-turn-progress"
  );
  assert.equal(progress.length, 1);
  assert.equal(progress[0].payload.progressId, "toolu_01_progress");
  assert.equal(progress[0].payload.roleName, fx.worker.name);
  assert.equal(progress[0].payload.agentId, fx.agent.id);
  assert.equal(progress[0].payload.adapterId, "claude");
  assert.equal(progress[0].payload.launchId, "launch-1");
});

test("delayed provider progress keeps its immutable inbox receivedAt as the activity fence", async (t) => {
  const fx = fixture(t, "claude");
  await runClaudeLifecycleHookCommand(
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: fx.nativeSessionId,
      prompt: "Do the work"
    }),
    fx.environment,
    async () => ({})
  );
  fx.drain();

  const receivedAt = new Date("2026-08-06T01:00:00.000Z");
  const inbox = new FileRuntimeEventInbox(fx.home, () => receivedAt);
  inbox.enqueueProviderProgress({
    scope: "task",
    taskId: fx.task.id,
    roleName: fx.worker.name,
    agentId: fx.agent.id,
    adapterId: "claude",
    launchId: "launch-1",
    nativeSessionId: fx.nativeSessionId,
    runId: fx.run.id,
    progressId: "toolu_delayed"
  });
  const drain = new FileRuntimeEventProcessor(
    new FileRuntimeEventInbox(fx.home),
    new FileSchedulerStoreAdapter(fx.store)
  ).drain(new Date("2026-08-06T02:00:00.000Z"));
  assert.equal(drain.failed.length, 0);
  const [progress] = fx.store.listEvents(fx.task.id).filter(
    (event) => event.type === "runtime.provider-turn-progress"
  );
  assert.equal(progress.payload.progressAt, receivedAt.toISOString());
  assert.notEqual(progress.createdAt, progress.payload.progressAt);
});

test("future provider progress is rejected at the drain boundary", async (t) => {
  const fx = fixture(t, "claude");
  await runClaudeLifecycleHookCommand(
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: fx.nativeSessionId,
      prompt: "Do the work"
    }),
    fx.environment,
    async () => ({})
  );
  fx.drain();

  const future = new Date("2026-08-06T03:00:00.000Z");
  const inbox = new FileRuntimeEventInbox(fx.home, () => future);
  inbox.enqueueProviderProgress({
    scope: "task",
    taskId: fx.task.id,
    roleName: fx.worker.name,
    agentId: fx.agent.id,
    adapterId: "claude",
    launchId: "launch-1",
    nativeSessionId: fx.nativeSessionId,
    runId: fx.run.id,
    progressId: "toolu_future"
  });
  const drain = new FileRuntimeEventProcessor(
    new FileRuntimeEventInbox(fx.home),
    new FileSchedulerStoreAdapter(fx.store)
  ).drain(new Date("2026-08-06T02:00:00.000Z"));
  assert.equal(drain.failed.length, 0);
  assert.equal(
    fx.store.listEvents(fx.task.id).some((event) => (
      event.type === "runtime.provider-turn-progress"
      && event.payload.progressId === "toolu_future"
    )),
    false
  );
});

test("Claude PostToolUse without its provider event identity fails closed", async (t) => {
  const fx = fixture(t, "claude");
  await assert.rejects(
    runClaudeLifecycleHookCommand(JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: fx.nativeSessionId,
      tool_name: "Read"
    }), fx.environment, async () => ({})),
    /PostToolUse id/i
  );
  assert.deepEqual(new FileRuntimeEventInbox(fx.home).list(), []);
});

test("Codex UserPromptSubmit hook folds to provider-accepted and writes delivered", async (t) => {
  const fx = fixture(t, "codex");
  assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt, undefined);

  await runCodexLifecycleHookCommand(
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: fx.nativeSessionId, prompt: "Do the work" }),
    fx.environment,
    async () => ({})
  );
  const events = new FileRuntimeEventInbox(fx.home).list();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "native-prompt-accepted");

  fx.drain();
  assert.notEqual(fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt, undefined);
});

test("provider acceptance after a missing push commit stays obsolete and exact yield remains denied", async (t) => {
  const fx = fixture(t, "claude", "running", { transportPushed: false });
  const before = fx.store.getAgentRun(fx.task.id, fx.run.id);
  assert.equal(before.pushedAt, undefined);
  assert.equal(before.deliveredAt, undefined);

  // This native hook is the durable provider fact observed after the prompt
  // executed while the Controller caller timed out before run.pushed committed.
  await runClaudeLifecycleHookCommand(
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: fx.nativeSessionId,
      prompt: "Do the work"
    }),
    fx.environment,
    async () => ({})
  );
  fx.drain();

  const unchanged = fx.store.getAgentRun(fx.task.id, fx.run.id);
  assert.equal(unchanged.pushedAt, undefined);
  assert.equal(unchanged.deliveredAt, undefined);
  const sessions = fx.store.getTaskRoleSessionSet(fx.task.id, fx.worker.name);
  assert.equal(sessions.inFlight.pushedAt, undefined);
  assert.equal(sessions.inFlight.deliveredAt, undefined);
  assert.equal(
    sessions.sessions[fx.agent.id].nativeSessionId,
    fx.nativeSessionId
  );
  assert.deepEqual(sessions.history ?? [], []);
  assert.equal(
    fx.store.listEvents(fx.task.id).filter(({ type }) => type === "run.pushed").length,
    0
  );
  assert.equal(
    fx.store.listEvents(fx.task.id).filter(({ type }) => type === "run.delivered").length,
    0
  );
  assert.ok(fx.store.listEvents(fx.task.id).some((event) => (
    event.type === "runtime.event-obsolete"
      && event.payload.reason === "fail-closed:accept-without-push"
  )));

  // Provider acceptance cannot repair transport state. Without a matching
  // receipt reconciliation, exact yield remains unavailable.
  assert.throws(() => runTaskCommand(
    ["run", "yield", fx.run.id, "--summary", "Provider accepted before caller timeout."],
    fx.store,
    {
      now: () => new Date("2026-08-06T02:00:03.000Z"),
      environment: {
        YUI_SESSION_SCOPE: "task",
        YUI_TASK_ID: fx.task.id,
        YUI_ROLE: fx.worker.name,
        YUI_AGENT_ID: fx.agent.id
      }
    }
  ), /has not been pushed|before.*push|delivery/i);
});

test("hook resolves the current in-flight Run instead of a stale process YUI_RUN_ID", async (t) => {
  const fx = fixture(t, "codex");
  await runCodexLifecycleHookCommand(
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: fx.nativeSessionId,
      prompt: "Do the work"
    }),
    { ...fx.environment, YUI_RUN_ID: "agent-run-stale" },
    async () => ({})
  );
  const [event] = new FileRuntimeEventInbox(fx.home).list();
  assert.equal(event.runId, fx.run.id);
  assert.equal(event.receiptId, `agent-run:${fx.task.id}/${fx.run.id}`);
  fx.drain();
  assert.notEqual(fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt, undefined);
});

test("hook resolves a resumed Session generation from its stable runtime descriptor", async (t) => {
  const fx = fixture(t, "claude");
  const sessions = fx.store.getTaskRoleSessionSet(fx.task.id, fx.worker.name);
  const currentSession = sessions.sessions[fx.agent.id];
  fx.store.saveTaskRoleSessionSet(recordRoleAgentSession(sessions, {
    agentId: fx.agent.id,
    adapterId: "claude",
    nativeSessionId: fx.nativeSessionId,
    launchId: "launch-2",
    policy: "fixed",
    status: "running",
    effective: currentSession.effective
  }, new Date("2026-08-06T02:00:02.000Z")));

  const cliEntry = join(process.cwd(), "dist", "cli.js");
  const control = createExactControlPlaneDescriptor({
    executable: process.execPath,
    cliEntry,
    yuiHome: fx.home
  });
  const runtime = createExactTaskRuntimeDescriptor({
    controlPlaneDigest: exactControlPlaneDigest(control),
    taskId: fx.task.id,
    roleName: fx.worker.name,
    agentId: fx.agent.id,
    adapterId: "claude",
    workspace: fx.run.effective.workspace.root,
    runId: fx.run.id,
    launchId: "launch-2",
    nativeSessionId: fx.nativeSessionId
  });
  const runtimeSource = exactTaskRuntimeDescriptorPath(fx.home, runtime);
  writeTextFileAtomically(runtimeSource, `${serializeExactDescriptor(runtime)}\n`);

  await runClaudeLifecycleHookCommand(
    JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: fx.nativeSessionId,
      tool_use_id: "toolu_resumed_generation",
      tool_name: "Read",
      tool_input: { file_path: "/managed/workspace/input.txt" }
    }),
    {
      ...fx.environment,
      // A reused native process cannot receive a new environment. The file
      // source is the current durable generation; these ambient fields are
      // intentionally the prior generation.
      YUI_LAUNCH_ID: "launch-1",
      [YUI_CONTROL_PLANE_DESCRIPTOR]: serializeExactDescriptor(control),
      [YUI_TASK_RUNTIME_DESCRIPTOR]: runtimeSource
    },
    async () => ({})
  );

  const [event] = new FileRuntimeEventInbox(fx.home).list();
  assert.equal(event.type, "native-turn-progress");
  assert.equal(event.runId, fx.run.id);
  assert.equal(event.launchId, "launch-2");
  assert.equal(event.nativeSessionId, fx.nativeSessionId);
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

test("exact internal Claude startup is queued before its preallocated Session is durable and folds only afterward", (t) => {
  const fx = fixture(t, "claude", "reserved", {
    runtimeDiscovered: true,
    transportPushed: false,
    bindInFlight: false
  });
  const nativeSessionId = nativeSessionIdForLaunch(
    fx.home,
    "launch-1",
    fx.agent.id,
    "claude"
  );
  const cliEntry = join(process.cwd(), "dist", "cli.js");
  const control = createExactControlPlaneDescriptor({
    executable: process.execPath,
    cliEntry,
    yuiHome: fx.home
  });
  const digest = exactControlPlaneDigest(control);
  const runtime = createExactTaskRuntimeDescriptor({
    controlPlaneDigest: digest,
    taskId: fx.task.id,
    roleName: fx.worker.name,
    agentId: fx.agent.id,
    adapterId: "claude",
    workspace: fx.run.effective.workspace.root,
    runId: fx.run.id,
    launchId: "launch-1",
    nativeSessionId
  });
  const runtimeSource = exactTaskRuntimeDescriptorPath(fx.home, runtime);
  writeTextFileAtomically(runtimeSource, `${serializeExactDescriptor(runtime)}\n`);
  assert.equal(isRuntimeLaunchReservation(fx.store.getWorkMailbox(
    runtimeLifecycleTarget({
      scope: "task",
      taskId: fx.task.id,
      roleName: fx.worker.name
    })
  )?.processing, "launch-1"), true);
  const environment = {
    ...process.env,
    ...fx.environment,
    YUI_NATIVE_SESSION_ID: nativeSessionId,
    [YUI_CONTROL_PLANE_DESCRIPTOR]: serializeExactDescriptor(control),
    [YUI_TASK_RUNTIME_DESCRIPTOR]: runtimeSource
  };
  const invoke = (command, payload, invocationEnvironment = environment) => spawnSync(process.execPath, [
    cliEntry,
    EXACT_CONTROL_ARGUMENT,
    digest,
    ...command
  ], {
    encoding: "utf8",
    env: invocationEnvironment,
    ...(payload === undefined ? {} : { input: JSON.stringify(payload) })
  });
  const inbox = new FileRuntimeEventInbox(fx.home);

  const forgedNativeSessionId = "00000000-0000-4000-a000-000000000000";
  const forgedRuntime = createExactTaskRuntimeDescriptor({
    ...runtime,
    nativeSessionId: forgedNativeSessionId
  });
  writeTextFileAtomically(runtimeSource, `${serializeExactDescriptor(forgedRuntime)}\n`);
  const forged = invoke(["internal", "claude-hook"], {
    hook_event_name: "SessionStart",
    source: "startup",
    session_id: forgedNativeSessionId
  }, { ...environment, YUI_NATIVE_SESSION_ID: forgedNativeSessionId });
  assert.notEqual(forged.status, 0);
  assert.match(forged.stderr, /in-flight Run fence is not current/i);
  assert.equal(inbox.list().length, 0);
  writeTextFileAtomically(runtimeSource, `${serializeExactDescriptor(runtime)}\n`);

  const external = invoke(["version"]);
  assert.notEqual(external.status, 0);
  assert.match(external.stderr, /in-flight Run fence is not current/i);
  assert.equal(inbox.list().length, 0);
  for (const payload of [
    {
      hook_event_name: "UserPromptSubmit",
      session_id: nativeSessionId,
      prompt: "must not append"
    },
    {
      hook_event_name: "StopFailure",
      session_id: nativeSessionId,
      error: "must not append"
    },
    {
      hook_event_name: "SessionStart",
      source: "resume",
      session_id: nativeSessionId
    }
  ]) {
    const rejected = invoke(["internal", "claude-hook"], payload);
    assert.notEqual(rejected.status, 0, payload.hook_event_name);
    assert.equal(inbox.list().length, 0);
  }

  const invoked = invoke(["internal", "claude-hook"], {
    hook_event_name: "SessionStart",
    source: "startup",
    session_id: nativeSessionId
  });
  assert.equal(invoked.status, 0, invoked.stderr);

  assert.equal(inbox.list().length, 1);
  const beforeSession = fx.drain();
  assert.equal(beforeSession.acknowledgedEventIds.length, 0);
  assert.equal(beforeSession.deferred.length, 1);
  assert.equal(beforeSession.failed.length, 0);
  assert.equal(inbox.list().length, 1);
  assert.equal(fx.store.getRoleSession(fx.task.id, fx.worker.name), null);
  assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).pushedAt, undefined);
  assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt, undefined);

  fx.adapter.saveRoleRunPrepared({
    task: fx.adapter.getTask(fx.task.id),
    role: fx.adapter.getRole(fx.task.id, fx.worker.name),
    run: fx.run,
    session: {
      agentId: fx.agent.id,
      adapterId: "claude",
      launchId: "launch-1",
      nativeSessionId,
      status: "running",
      effective: fx.run.effective
    },
    launchId: "launch-1",
    now: new Date("2026-08-06T02:00:01.500Z")
  });
  const afterSession = fx.drain();
  assert.equal(afterSession.acknowledgedEventIds.length, 1);
  assert.equal(afterSession.deferred.length, 0);
  assert.equal(afterSession.failed.length, 0);
  assert.equal(inbox.list().length, 0);
  assert.equal(fx.store.listEvents(fx.task.id).filter((event) => (
    event.type === "runtime.provider-session-lifecycle"
      && event.payload.preInputReady === "true"
  )).length, 1);
  assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).pushedAt, undefined);
  assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt, undefined);
  assert.equal(isRuntimeLaunchReservation(fx.store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId: fx.task.id,
    roleName: fx.worker.name
  }))?.processing, "launch-1"), true);
});

for (const mismatch of [
  "native",
  "launch",
  "workspace",
  "run",
  "inflight-cross-run",
  "cleanup-pending",
  "reservation-missing",
  "reservation-cross-run"
]) {
  test(`preallocated Claude startup rejects ${mismatch} before inbox append`, async (t) => {
    const fx = fixture(t, "claude", "reserved", {
      runtimeDiscovered: true,
      transportPushed: false,
      bindInFlight: false
    });
    const owner = {
      scope: "task",
      taskId: fx.task.id,
      roleName: fx.worker.name
    };
    const nativeSessionId = nativeSessionIdForLaunch(
      fx.home,
      "launch-1",
      fx.agent.id,
      "claude"
    );
    let environment = {
      ...fx.environment,
      YUI_NATIVE_SESSION_ID: nativeSessionId
    };
    let payloadNativeSessionId = nativeSessionId;
    if (mismatch === "native") {
      payloadNativeSessionId = "not-the-preallocated-native";
    } else if (mismatch === "launch") {
      environment = { ...environment, YUI_LAUNCH_ID: "launch-stale" };
    } else if (mismatch === "workspace") {
      environment = { ...environment, YUI_WORKSPACE: `${environment.YUI_WORKSPACE}-stale` };
    } else if (mismatch === "run") {
      environment = { ...environment, YUI_RUN_ID: "agent-run-stale" };
    } else if (mismatch === "inflight-cross-run") {
      fx.store.saveAgentRun(createAgentRun(
        "agent-run-2",
        fx.task.id,
        fx.worker.name,
        "new",
        "other Run",
        new Date("2026-08-06T02:00:01.250Z"),
        { effective: fx.run.effective }
      ));
      fx.store.saveTaskRoleSessionSet(bindTaskRoleRun(
        fx.store.getTaskRoleSessionSet(fx.task.id, fx.worker.name),
        {
          agentId: fx.agent.id,
          runId: "agent-run-2",
          receiptId: `agent-run:${fx.task.id}/agent-run-2`
        },
        new Date("2026-08-06T02:00:01.500Z")
      ));
    } else if (mismatch === "cleanup-pending") {
      assert.notEqual(fx.adapter.enqueueRuntimeCleanup(
        owner,
        new Date("2026-08-06T02:00:01.250Z")
      ), null);
      assert.equal(hasRuntimeCleanupObligation(fx.store.getWorkMailbox(
        runtimeLifecycleTarget(owner)
      )), true);
    } else {
      assert.equal(fx.adapter.completeRuntimeLaunchReservation(owner, "launch-1"), true);
      if (mismatch === "reservation-cross-run") {
        fx.store.saveAgentRun(createAgentRun(
          "agent-run-2",
          fx.task.id,
          fx.worker.name,
          "new",
          "other Run",
          new Date("2026-08-06T02:00:01.250Z"),
          { effective: fx.run.effective }
        ));
        fx.adapter.reserveRuntimeLaunch({
          owner,
          launchId: "launch-1",
          runId: "agent-run-2"
        }, () => {}, new Date("2026-08-06T02:00:01.500Z"));
      }
    }

    await assert.rejects(runClaudeLifecycleHookCommand(
      JSON.stringify({
        hook_event_name: "SessionStart",
        source: "startup",
        session_id: payloadNativeSessionId
      }),
      environment,
      async () => ({})
    ));
    assert.equal(new FileRuntimeEventInbox(fx.home).list().length, 0);
    assert.equal(fx.store.getRoleSession(fx.task.id, fx.worker.name), null);
    assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).pushedAt, undefined);
    assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt, undefined);
  });
}

for (const event of [
  { hook_event_name: "SessionStart", source: "resume" },
  { hook_event_name: "UserPromptSubmit", prompt: "must not append" },
  { hook_event_name: "StopFailure", error: "must not append" }
]) {
  test(`${event.hook_event_name}${event.source === undefined ? "" : `(${event.source})`} cannot use the startup-only pre-binding window`, async (t) => {
    const fx = fixture(t, "claude", "reserved", {
      runtimeDiscovered: true,
      transportPushed: false,
      bindInFlight: false
    });
    const nativeSessionId = nativeSessionIdForLaunch(
      fx.home,
      "launch-1",
      fx.agent.id,
      "claude"
    );
    await assert.rejects(runClaudeLifecycleHookCommand(
      JSON.stringify({ ...event, session_id: nativeSessionId }),
      { ...fx.environment, YUI_NATIVE_SESSION_ID: nativeSessionId },
      async () => ({})
    ));
    assert.equal(new FileRuntimeEventInbox(fx.home).list().length, 0);
  });
}

test("Codex SessionStart hook records session-lifecycle without pre-input readiness", async (t) => {
  const fx = fixture(t, "codex", "reserved");
  await runCodexLifecycleHookCommand(
    JSON.stringify({ hook_event_name: "SessionStart", session_id: fx.nativeSessionId }),
    fx.environment,
    async () => ({})
  );
  fx.drain();
  assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).deliveredAt, undefined);
  // Codex SessionStart is provider-session-started only — preInputReady stays false.
  assert.ok(fx.store.listEvents(fx.task.id).some(
    (e) => e.type === "runtime.provider-session-lifecycle" && e.payload.preInputReady === "false"
  ));
});

test("runtime-discovered Codex SessionStart binds the provider session without a native id in launch env", async (t) => {
  const fx = fixture(t, "codex", "reserved", { runtimeDiscovered: true });
  assert.equal(fx.store.getRoleSession(fx.task.id, fx.worker.name), null);
  await runCodexLifecycleHookCommand(
    JSON.stringify({ hook_event_name: "SessionStart", session_id: fx.nativeSessionId }),
    fx.environment,
    async () => ({})
  );
  fx.drain();
  const session = fx.store.getRoleSession(fx.task.id, fx.worker.name);
  assert.equal(session.nativeSessionId, fx.nativeSessionId);
  assert.equal(session.launchId, "launch-1");
  assert.ok(fx.store.listEvents(fx.task.id).some(
    (event) => event.type === "runtime.provider-session-lifecycle"
      && event.payload.outcome === "bind-native-session"
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

test("a UserPromptSubmit hook whose workspace differs from the Run snapshot fails before enqueue", async (t) => {
  const fx = fixture(t, "claude");
  await assert.rejects(
    runClaudeLifecycleHookCommand(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: fx.nativeSessionId,
        prompt: "x"
      }),
      { ...fx.environment, YUI_WORKSPACE: `${fx.environment.YUI_WORKSPACE}-stale` },
      async () => ({})
    ),
    /workspace does not match/i
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
