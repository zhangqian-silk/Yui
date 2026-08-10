import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { bindExecution, claimPending } from "../../dist/coordination/workMailbox.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { stopFileTaskController } from "../../dist/controller/clientRuntime.js";
import { FileRuntimeEventProcessor } from "../../dist/controller/runtimeEventProcessor.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { runClaudeLifecycleHookCommand } from "../../dist/controller/claudeLifecycleHook.js";
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
import { createAgentRun, markAgentRunDelivered } from "../../dist/run/agentRun.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createWorkItem, updateWorkItemStatus } from "../../dist/workItem/workItem.js";
import {
  EXACT_CONTROL_ARGUMENT,
  YUI_CONTROL_PLANE_DESCRIPTOR,
  exactControlPlaneDigest,
  parseExactControlPlaneDescriptor
} from "../../dist/runtime/exactControlPlane.js";

function fixture(t) {
  const { home } = workflowFixture(t);
  return {
    home,
    environment: {
      YUI_HOME: home,
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: "task-1",
      YUI_ROLE: "worker",
      YUI_AGENT_ID: "claude-primary",
      YUI_ADAPTER_ID: "claude",
      YUI_WORKSPACE: home,
      YUI_LAUNCH_ID: "launch-1",
      YUI_RUN_ID: "agent-run-stale-process-value",
      YUI_NATIVE_SESSION_ID: "native-1"
    }
  };
}

function currentClaudeHookCommon(hookEventName) {
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

function workflowFixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-claude-lifecycle-state-"));
  t.after(async () => {
    await stopFileTaskController(home);
    rmSync(home, { recursive: true, force: true });
  });
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const first = new Date("2026-08-02T02:00:00.000Z");
  const second = new Date("2026-08-02T02:00:01.000Z");
  const agent = createConfiguredAgent("claude-primary", "claude", "claude", [], [], first);
  const task = activateTask(createTask("task-1", "Claude lifecycle", first), first);
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
    tx.saveRole(task.id, leader);
    tx.saveRole(task.id, updateRoleStatus(worker, "running", first));
    tx.saveWorkItem(task.id, item);
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, target, "run-dispatched", first, [{
      type: "run",
      taskId: task.id,
      id: run.id
    }]);
    const pending = tx.getWorkMailbox(target);
    tx.saveWorkMailbox(bindExecution(claimPending(pending, {
      batchId: "delivery-1",
      owner: "worker-delivery",
      startedAt: first.toISOString()
    }), "delivery-1", { type: "run", taskId: task.id, id: run.id }));
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
  return { home, store, task, leader, worker, item, run, agent, first, second };
}

function yieldThroughCli(home, runId, summary) {
  const store = new FileTaskStore(home);
  const task = store.getTask("task-1");
  const role = store.getRole(task.id, "worker");
  const active = store.getActiveAgentRun(task.id, role.name);
  const session = store.getRoleSession(task.id, role.name);
  const cliEntry = join(process.cwd(), "dist", "cli.js");
  const plan = new FileRoleLaunchPlanner(home, store, { cliPath: cliEntry }).plan({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: session.adapterId,
    effective: active?.effective ?? session.effective,
    mode: "resume",
    nativeSessionId: session.nativeSessionId,
    launchId: session.launchId,
    ...(active === null ? {} : { runId: active.id })
  });
  const control = parseExactControlPlaneDescriptor(
    plan.launch.env[YUI_CONTROL_PLANE_DESCRIPTOR]
  );
  return spawnSync(
    process.execPath,
    [
      cliEntry,
      EXACT_CONTROL_ARGUMENT,
      exactControlPlaneDigest(control),
      "task", "run", "yield", runId, "--summary-file", "-"
    ],
    {
      encoding: "utf8",
      input: summary,
      env: {
        ...process.env,
        ...plan.launch.env
      }
    }
  );
}

test("ordinary Claude Stop is rejected and cannot become a managed lifecycle event", async (t) => {
  const { home, environment } = fixture(t);
  const signals = [];

  await assert.rejects(runClaudeLifecycleHookCommand(JSON.stringify({
    ...currentClaudeHookCommon("Stop"),
    stop_hook_active: false,
    last_assistant_message: "A peer Stop hook can still block this response.",
    background_tasks: [],
    session_crons: []
  }), environment, async (...args) => {
    signals.push(args);
    return {};
  }), /unsupported hook event/i);

  assert.deepEqual(new FileRuntimeEventInbox(home).list(), []);
  assert.deepEqual(signals, []);
});

test("Claude StopFailure captures structured evidence and remains durable when wake fails", async (t) => {
  const { home, environment } = fixture(t);

  await assert.doesNotReject(runClaudeLifecycleHookCommand(JSON.stringify({
    ...currentClaudeHookCommon("StopFailure"),
    agent_id: "provider-subagent-id",
    agent_type: "managed-worker",
    error: "server_error",
    error_details: "upstream 503\nrequest-id: abc",
    last_assistant_message: "API Error: upstream 503"
  }), environment, async () => {
    const [durable] = new FileRuntimeEventInbox(home).list();
    assert.equal(durable.type, "claude-stop-failure");
    assert.equal(durable.runId, "agent-run-1");
    throw new Error("Controller offline");
  }));

  const [event] = new FileRuntimeEventInbox(home).list();
  assert.equal(event.type, "claude-stop-failure");
  assert.equal(event.error, "server_error");
  assert.equal(event.errorDetails, "upstream 503\nrequest-id: abc");
  assert.equal(event.lastAssistantMessage, "API Error: upstream 503");
  assert.equal(event.agentId, "claude-primary");
});

test("Claude StopFailure accepts provider evolution but never infers a managed identity", async (t) => {
  const { home, environment } = fixture(t);
  await assert.rejects(
    runClaudeLifecycleHookCommand(JSON.stringify({
      ...currentClaudeHookCommon("StopFailure")
    }), environment, async () => ({})),
    /error/i
  );
  await assert.doesNotReject(
    runClaudeLifecycleHookCommand(JSON.stringify({
      ...currentClaudeHookCommon("StopFailure"),
      permission_mode: "manual",
      effort: { level: "ultra", provider_metadata: true },
      error: "future_provider_error",
      future_provider_field: { nested: true }
    }), environment, async () => ({}))
  );
  await assert.rejects(
    runClaudeLifecycleHookCommand(JSON.stringify({
      ...currentClaudeHookCommon("StopFailure"),
      error: "server_error"
    }), { ...environment, YUI_LAUNCH_ID: undefined }, async () => ({})),
    /Launch id/i
  );
  await assert.rejects(
    runClaudeLifecycleHookCommand(JSON.stringify({
      ...currentClaudeHookCommon("StopFailure"),
      session_id: "provider-newest-session",
      agent_id: "provider-supplied-agent",
      error: "server_error"
    }), environment, async () => ({})),
    /native session/i
  );
  const [event] = new FileRuntimeEventInbox(home).list();
  assert.equal(event.error, "future_provider_error");
});

test("Claude StopFailure fails the exact Run and WorkItem without a Candidate or retry", async (t) => {
  const { home, store, task, worker, item, run, agent, second } = workflowFixture(t);
  const adapter = new FileSchedulerStoreAdapter(store);
  const messagesBeforeFailure = store.listMessages(task.id);
  await runClaudeLifecycleHookCommand(JSON.stringify({
    ...currentClaudeHookCommon("StopFailure"),
    error: "server_error",
    error_details: "upstream 503",
    last_assistant_message: "partial output"
  }), {
    YUI_HOME: home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: task.id,
    YUI_ROLE: worker.name,
    YUI_AGENT_ID: agent.id,
    YUI_ADAPTER_ID: "claude",
    YUI_WORKSPACE: run.effective.workspace.root,
    YUI_LAUNCH_ID: "launch-1",
    YUI_RUN_ID: run.id,
    YUI_NATIVE_SESSION_ID: "native-1"
  }, async () => ({}));
  const inbox = new FileRuntimeEventInbox(home);
  const [durable] = inbox.list();
  const drained = new FileRuntimeEventProcessor(inbox, adapter).drain(second);
  assert.deepEqual(drained.failed, []);
  assert.deepEqual(drained.acknowledgedEventIds, [durable.id]);
  const event = {
    eventId: durable.id,
    type: durable.type,
    taskId: durable.taskId,
    roleName: durable.roleName,
    agentId: durable.agentId,
    adapterId: durable.adapterId,
    launchId: durable.launchId,
    nativeSessionId: durable.nativeSessionId,
    runId: durable.runId,
    error: durable.error,
    errorDetails: durable.errorDetails,
    lastAssistantMessage: durable.lastAssistantMessage
  };

  const failed = store.getAgentRun(task.id, run.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.summary, /server_error.*upstream 503.*partial output/s);
  const failedItem = store.getWorkItem(task.id, item.id);
  assert.equal(failedItem.status, "failed");
  assert.deepEqual(failedItem.candidates, []);
  assert.equal(store.getActiveAgentRun(task.id, worker.name), null);
  assert.equal(store.listAgentRuns(task.id).length, 1);
  const leaderMailbox = store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" });
  assert.ok(leaderMailbox.pending.reasons.includes("role-run-failed"));
  assert.ok(leaderMailbox.pending.refs.every((ref) => ref.type !== "message"));
  assert.deepEqual(store.listMessages(task.id), messagesBeforeFailure);
  assert.ok(store.listEvents(task.id).some((entry) => (
    entry.type === "runtime.claude-stop-failure"
    && entry.payload.runId === run.id
  )));
  assert.equal(adapter.classifyClaudeStopFailureEvent(event), "obsolete");
  assert.equal(adapter.observeClaudeStopFailureEvent(event, second).disposition, "obsolete");
  assert.equal(store.getWorkItem(task.id, item.id).candidates.length, 0);
  assert.equal(store.listAgentRuns(task.id).length, 1);
});

test("exact stdin yield preserves multiline UTF-8, rejects wrong or repeated Runs, and resumes", (t) => {
  const { home, store, task, worker, item, run, agent } = workflowFixture(t);
  const adapter = new FileSchedulerStoreAdapter(store);
  const summary = "第一段\n\n完整结果🙂\n最后一段";
  const messagesBeforeYield = store.listMessages(task.id);

  const wrong = yieldThroughCli(home, "agent-run-99", "wrong Run must fail");
  assert.notEqual(wrong.status, 0);
  assert.equal(store.getWorkItem(task.id, item.id).candidates.length, 0);

  const yielded = yieldThroughCli(home, run.id, summary);
  assert.equal(yielded.status, 0, yielded.stderr);
  assert.equal(store.getAgentRun(task.id, run.id).summary, summary);
  assert.equal(store.getWorkItem(task.id, item.id).candidates[0].summary, summary);
  assert.deepEqual(store.listMessages(task.id), messagesBeforeYield);

  const repeated = yieldThroughCli(home, run.id, "duplicate result");
  assert.notEqual(repeated.status, 0);
  assert.equal(store.getWorkItem(task.id, item.id).candidates.length, 1);
  assert.deepEqual(store.listMessages(task.id), messagesBeforeYield);
  const third = new Date(Date.now() + 60_000);
  const options = {
    now: () => third,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  const lifecycleTarget = {
    kind: "role-runtime",
    taskId: task.id,
    roleName: worker.name
  };
  const lifecycleMailbox = store.getWorkMailbox(lifecycleTarget);
  if (lifecycleMailbox !== null) {
    assert.deepEqual(lifecycleMailbox.pending.reasons, ["runtime-cleanup-required"]);
    assert.equal(adapter.completeRuntimeCleanup(lifecycleTarget, third), true);
  }
  assert.equal(
    store.getTaskRoleSessionSet(task.id, worker.name).sessions[agent.id].status,
    "stopped"
  );

  runTaskCommand([
    "work", "reject", item.id, "--summary", "One correction is required."
  ], store, options);
  runTaskCommand(["work", "dispatch", item.id], store, options);
  const successor = store.getActiveAgentRun(task.id, worker.name);
  assert.equal(successor.mode, "resume");
  assert.equal(store.getWorkItem(task.id, item.id).candidates.length, 1);

  const plan = new FileRoleLaunchPlanner(home, store).plan({
    taskId: task.id,
    roleName: worker.name,
    agentId: agent.id,
    adapterId: "claude",
    mode: "resume",
    nativeSessionId: "native-1",
    launchId: "launch-2",
    runId: successor.id,
    effective: successor.effective
  });
  assert.equal(plan.launch.env.YUI_RUN_ID, successor.id);
  assert.equal(plan.launch.env.YUI_LAUNCH_ID, "launch-2");
  assert.equal(plan.launch.env.YUI_NATIVE_SESSION_ID, "native-1");
  assert.deepEqual(
    plan.launch.args.slice(plan.launch.args.indexOf("--resume"), plan.launch.args.indexOf("--resume") + 2),
    ["--resume", "native-1"]
  );
  assert.ok(plan.launch.args.includes("--plugin-dir"));
  const resumePluginRoot = plan.launch.args[
    plan.launch.args.indexOf("--plugin-dir") + 1
  ];
  const resumeHooks = JSON.parse(
    readFileSync(join(resumePluginRoot, "hooks", "hooks.json"), "utf8")
  );
  assert.deepEqual(
    Object.keys(resumeHooks.hooks).sort(),
    ["PostToolUse", "SessionStart", "StopFailure", "UserPromptSubmit"]
  );

  const late = {
    eventId: "late-stop-failure-old-run",
    type: "claude-stop-failure",
    taskId: task.id,
    roleName: worker.name,
    agentId: agent.id,
    adapterId: "claude",
    launchId: "launch-1",
    nativeSessionId: "native-1",
    runId: run.id,
    error: "server_error",
    errorDetails: "Late provider failure"
  };
  assert.equal(adapter.classifyClaudeStopFailureEvent(late), "obsolete");
  assert.equal(adapter.observeClaudeStopFailureEvent(late, third).disposition, "obsolete");
  assert.equal(store.getAgentRun(task.id, run.id).summary, summary);
  assert.equal(store.getActiveAgentRun(task.id, worker.name).id, successor.id);
  assert.equal(store.getWorkItem(task.id, item.id).candidates.length, 1);
  assert.ok(store.listEvents(task.id).some((event) => (
    event.type === "runtime.event-obsolete"
      && event.payload.eventId === late.eventId
  )));
});
