import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { bindExecution, claimPending } from "../../dist/coordination/workMailbox.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import {
  FileRuntimeEventInbox,
  MAX_CLAUDE_RESULT_BYTES
} from "../../dist/controller/runtimeEventInbox.js";
import { runClaudeLifecycleHookCommand } from "../../dist/controller/claudeLifecycleHook.js";
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
import { createAgentRun, markAgentRunDelivered } from "../../dist/run/agentRun.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createWorkItem, updateWorkItemStatus } from "../../dist/workItem/workItem.js";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-claude-hook-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    home,
    environment: {
      YUI_HOME: home,
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: "task-1",
      YUI_ROLE: "worker",
      YUI_AGENT_ID: "claude-primary",
      YUI_ADAPTER_ID: "claude",
      YUI_LAUNCH_ID: "launch-1",
      YUI_RUN_ID: "agent-run-1",
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
  t.after(() => rmSync(home, { recursive: true, force: true }));
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
      agent: { agentId: agent.id, adapterId: "claude" }
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
    enqueueWork(tx, target, "run-dispatched", first, [{ type: "run", id: run.id }]);
    const pending = tx.getWorkMailbox(target);
    tx.saveWorkMailbox(bindExecution(claimPending(pending, {
      batchId: "delivery-1",
      owner: "worker-delivery",
      startedAt: first.toISOString()
    }), "delivery-1", { type: "run", id: run.id }));
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
      status: "running"
    }, first);
    sessions = bindTaskRoleRun(sessions, {
      agentId: agent.id,
      runId: run.id,
      receiptId: `agent-run:${run.id}`
    }, first);
    sessions = markTaskRoleRunDelivered(sessions, {
      agentId: agent.id,
      runId: run.id,
      receiptId: `agent-run:${run.id}`
    }, second);
    tx.saveTaskRoleSessionSet(sessions);
  });
  return { home, store, task, leader, worker, item, run, agent, first, second };
}

test("Claude Stop durably preserves a complete long multiline UTF-8 result before signaling", async (t) => {
  const { home, environment } = fixture(t);
  const result = `第一行\n${"界🙂".repeat(20_000)}\n最后一行`;
  const signals = [];

  await runClaudeLifecycleHookCommand(JSON.stringify({
    ...currentClaudeHookCommon("Stop"),
    stop_hook_active: false,
    last_assistant_message: result,
    background_tasks: [],
    session_crons: []
  }), environment, async (...args) => {
    signals.push(args);
    assert.equal(new FileRuntimeEventInbox(home).list().length, 1);
    return {};
  });

  const [event] = new FileRuntimeEventInbox(home).list();
  assert.equal(event.type, "claude-stop");
  assert.equal(event.runId, "agent-run-1");
  assert.equal(event.result, result);
  assert.ok(Buffer.byteLength(event.result, "utf8") < MAX_CLAUDE_RESULT_BYTES);
  assert.deepEqual(signals.map(([, method, params]) => [method, params]), [[
    "scheduler.signal",
    { key: "role:task-1/worker" }
  ]]);
});

test("Claude StopFailure captures structured evidence and remains durable when wake fails", async (t) => {
  const { home, environment } = fixture(t);

  await assert.doesNotReject(runClaudeLifecycleHookCommand(JSON.stringify({
    ...currentClaudeHookCommon("StopFailure"),
    agent_type: "managed-worker",
    error: "server_error",
    error_details: "upstream 503\nrequest-id: abc",
    last_assistant_message: "API Error: upstream 503"
  }), environment, async () => {
    throw new Error("Controller offline");
  }));

  const [event] = new FileRuntimeEventInbox(home).list();
  assert.equal(event.type, "claude-stop-failure");
  assert.equal(event.error, "server_error");
  assert.equal(event.errorDetails, "upstream 503\nrequest-id: abc");
  assert.equal(event.lastAssistantMessage, "API Error: upstream 503");
  assert.equal(event.agentId, "claude-primary");
});

test("Claude Stop with pending background or scheduled work is not a terminal result", async (t) => {
  const { home, environment } = fixture(t);
  const signals = [];

  for (const pending of [
    {
      background_tasks: [{
        id: "task-001",
        type: "shell",
        status: "running",
        description: "tail logs",
        command: "tail -f /tmp/service.log"
      }],
      session_crons: []
    },
    {
      background_tasks: [],
      session_crons: [{
        id: "cron-001",
        schedule: "0 9 * * 1-5",
        recurring: true,
        prompt: "check the build"
      }]
    }
  ]) {
    await assert.doesNotReject(runClaudeLifecycleHookCommand(JSON.stringify({
      ...currentClaudeHookCommon("Stop"),
      stop_hook_active: false,
      last_assistant_message: "Waiting for managed background work.",
      ...pending
    }), environment, async (...args) => {
      signals.push(args);
      return {};
    }));
  }

  assert.deepEqual(new FileRuntimeEventInbox(home).list(), []);
  assert.deepEqual(signals, []);
});

test("Claude lifecycle stdin is strict and never infers an active Run", async (t) => {
  const { home, environment } = fixture(t);
  await assert.rejects(
    runClaudeLifecycleHookCommand(JSON.stringify({
      ...currentClaudeHookCommon("Stop"),
      stop_hook_active: false,
      background_tasks: [],
      session_crons: []
    }), environment, async () => ({})),
    /last_assistant_message/i
  );
  await assert.rejects(
    runClaudeLifecycleHookCommand(JSON.stringify({
      ...currentClaudeHookCommon("Stop"),
      stop_hook_active: false,
      last_assistant_message: "done",
      background_tasks: [],
      session_crons: [],
      unexpected: true
    }), environment, async () => ({})),
    /invalid|unexpected/i
  );
  await assert.rejects(
    runClaudeLifecycleHookCommand(JSON.stringify({
      ...currentClaudeHookCommon("Stop"),
      effort: { level: "ultra" },
      stop_hook_active: false,
      last_assistant_message: "done",
      background_tasks: [],
      session_crons: []
    }), environment, async () => ({})),
    /effort/i
  );
  await assert.rejects(
    runClaudeLifecycleHookCommand(JSON.stringify({
      ...currentClaudeHookCommon("Stop"),
      stop_hook_active: false,
      last_assistant_message: "waiting",
      background_tasks: [{
        id: "task-001",
        type: "shell",
        status: "running",
        description: "tail logs",
        command: "tail -f /tmp/service.log",
        inferred_run_id: "agent-run-wrong"
      }],
      session_crons: []
    }), environment, async () => ({})),
    /background_tasks/i
  );
  await assert.rejects(
    runClaudeLifecycleHookCommand(JSON.stringify({
      ...currentClaudeHookCommon("Stop"),
      stop_hook_active: false,
      last_assistant_message: "done",
      background_tasks: [],
      session_crons: []
    }), { ...environment, YUI_RUN_ID: undefined }, async () => ({})),
    /Run id/i
  );
  assert.deepEqual(new FileRuntimeEventInbox(home).list(), []);
});

test("normal Claude Stop yields the exact Run and submits the complete result as its Candidate", (t) => {
  const { store, task, worker, item, run, agent, second } = workflowFixture(t);
  const adapter = new FileSchedulerStoreAdapter(store);
  const result = "\n 第一段\n\n完整结果🙂\n最后一段 \n";
  const event = {
    eventId: "turn-stop-1",
    type: "claude-stop",
    taskId: task.id,
    roleName: worker.name,
    agentId: agent.id,
    adapterId: "claude",
    launchId: "launch-1",
    nativeSessionId: "native-1",
    runId: run.id,
    result
  };

  assert.equal(adapter.classifyClaudeLifecycleEvent(event), "apply");
  adapter.observeClaudeLifecycleEvent(event, second);

  assert.equal(store.getAgentRun(task.id, run.id).status, "yielded");
  assert.equal(store.getAgentRun(task.id, run.id).summary, result);
  const submitted = store.getWorkItem(task.id, item.id);
  assert.equal(submitted.status, "awaiting_acceptance");
  assert.equal(submitted.candidates.length, 1);
  assert.equal(submitted.candidates[0].summary, result);
  assert.deepEqual(submitted.candidates[0].source, { type: "run", runId: run.id });
  assert.equal(store.listMessages(task.id).at(-1).body, result);
  assert.equal(store.getActiveAgentRun(task.id, worker.name), null);
  assert.equal(store.getTaskRoleSessionSet(task.id, worker.name).inFlight, null);
  assert.deepEqual(
    store.getWorkMailbox({
      kind: "role-runtime",
      taskId: task.id,
      roleName: worker.name
    }).pending.reasons,
    ["runtime-cleanup-required"]
  );
  assert.equal(adapter.classifyClaudeLifecycleEvent(event), "obsolete");
});

test("Claude Stop preserves automatic review semantics without waking the Leader early", (t) => {
  const { store, task, worker, item, run, agent, second } = workflowFixture(t);
  store.saveConfig({
    ...store.getConfig(),
    review: { roleName: worker.name, trigger: "always" }
  });
  const adapter = new FileSchedulerStoreAdapter(store);

  adapter.observeClaudeLifecycleEvent({
    eventId: "turn-stop-review",
    type: "claude-stop",
    taskId: task.id,
    roleName: worker.name,
    agentId: agent.id,
    adapterId: "claude",
    launchId: "launch-1",
    nativeSessionId: "native-1",
    runId: run.id,
    result: "Candidate for policy review"
  }, second);

  const submitted = store.getWorkItem(task.id, item.id);
  assert.equal(submitted.status, "awaiting_acceptance");
  assert.deepEqual(submitted.candidates[0].reviewPolicy, {
    roleName: worker.name,
    trigger: "always"
  });
  const [round] = store.listReviewRounds(task.id);
  assert.equal(round.status, "running");
  assert.equal(round.candidateId, submitted.candidates[0].id);
  const reviewRun = store.getActiveAgentRun(task.id, worker.name);
  assert.equal(reviewRun.id, round.reviewerRunId);
  assert.equal(reviewRun.purpose, "review");
  assert.equal(
    store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" }),
    null
  );
});

test("Claude StopFailure fails the exact Run and WorkItem without a Candidate or retry", (t) => {
  const { store, task, worker, item, run, agent, second } = workflowFixture(t);
  const adapter = new FileSchedulerStoreAdapter(store);
  const event = {
    eventId: "turn-failure-1",
    type: "claude-stop-failure",
    taskId: task.id,
    roleName: worker.name,
    agentId: agent.id,
    adapterId: "claude",
    launchId: "launch-1",
    nativeSessionId: "native-1",
    runId: run.id,
    error: "API request failed",
    errorDetails: "upstream 503",
    lastAssistantMessage: "partial output"
  };

  adapter.observeClaudeLifecycleEvent(event, second);

  const failed = store.getAgentRun(task.id, run.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.summary, /API request failed.*upstream 503.*partial output/s);
  const failedItem = store.getWorkItem(task.id, item.id);
  assert.equal(failedItem.status, "failed");
  assert.deepEqual(failedItem.candidates, []);
  assert.equal(store.getActiveAgentRun(task.id, worker.name), null);
  assert.equal(store.listAgentRuns(task.id).length, 1);
  assert.ok(store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" }).pending.reasons.includes("role-run-failed"));
});

test("explicit yield wins its Stop race and the next Claude round resumes with a new exact Run envelope", (t) => {
  const { home, store, task, worker, item, run, agent } = workflowFixture(t);
  const adapter = new FileSchedulerStoreAdapter(store);
  const third = new Date("2026-08-02T02:00:02.000Z");
  const options = {
    now: () => third,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };

  runTaskCommand([
    "run", "yield", run.id, "--summary", "Explicit result wins."
  ], store, options);
  const lifecycleTarget = {
    kind: "role-runtime",
    taskId: task.id,
    roleName: worker.name
  };
  assert.deepEqual(
    store.getWorkMailbox(lifecycleTarget).pending.reasons,
    ["runtime-cleanup-required"]
  );
  assert.equal(adapter.completeRuntimeCleanup(lifecycleTarget, third), true);
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
    runId: successor.id
  });
  assert.equal(plan.launch.env.YUI_RUN_ID, successor.id);
  assert.equal(plan.launch.env.YUI_LAUNCH_ID, "launch-2");
  assert.equal(plan.launch.env.YUI_NATIVE_SESSION_ID, "native-1");
  assert.deepEqual(
    plan.launch.args.slice(plan.launch.args.indexOf("--resume"), plan.launch.args.indexOf("--resume") + 2),
    ["--resume", "native-1"]
  );
  assert.ok(plan.launch.args.includes("--plugin-dir"));

  const late = {
    eventId: "late-stop-old-run",
    type: "claude-stop",
    taskId: task.id,
    roleName: worker.name,
    agentId: agent.id,
    adapterId: "claude",
    launchId: "launch-1",
    nativeSessionId: "native-1",
    runId: run.id,
    result: "Late provider Stop"
  };
  assert.equal(adapter.classifyClaudeLifecycleEvent(late), "obsolete");
  assert.equal(adapter.observeClaudeLifecycleEvent(late, third).disposition, "obsolete");
  assert.equal(store.getAgentRun(task.id, run.id).summary, "Explicit result wins.");
  assert.equal(store.getActiveAgentRun(task.id, worker.name).id, successor.id);
});
