import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { bindExecution, claimPending } from "../../dist/coordination/workMailbox.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunDelivered
} from "../../dist/executor/agentExecutor.js";
import { terminalizeExactTaskRun } from "../../dist/lifecycle/exactRunTerminalization.js";
import { createRole, createRoleAgentBinding, updateRoleStatus } from "../../dist/role/role.js";
import { markAgentRunDelivered } from "../../dist/run/agentRun.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask, retireTask } from "../../dist/task/task.js";
import {
  createWorkItem,
  retireWorkItem,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { createAgentRun, recordRoleAgentSession } from "../helpers/effectiveLaunch.js";

const FIRST = new Date("2026-08-02T01:00:00.000Z");
const SECOND = new Date("2026-08-02T01:00:01.000Z");
const THIRD = new Date("2026-08-02T01:00:02.000Z");

function fixture(t, { adapterId = "claude" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "yui-retirement-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent(
    `${adapterId}-primary`, adapterId, adapterId, [], [], FIRST
  );
  const task = activateTask(createTask("task-1", "Lifecycle task", FIRST), FIRST);
  const leader = createRole(
    task.id,
    "leader",
    [createRoleAgentBinding(agent)],
    agent.id,
    home,
    FIRST
  );
  const worker = createRole(
    task.id,
    "worker",
    [createRoleAgentBinding(agent)],
    agent.id,
    home,
    FIRST
  );
  const item = updateWorkItemStatus(
    createWorkItem("work-item-1", task.id, {
      title: "Bounded result",
      assignee: worker.name
    }, FIRST),
    "running",
    FIRST
  );
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveRole(task.id, leader);
    tx.saveRole(task.id, updateRoleStatus(worker, "running", FIRST));
    tx.saveWorkItem(task.id, item);
  });
  return { store, task, agent, item };
}

function prepareRun(store, {
  delivered = true,
  adapterId = "claude",
  agentId = `${adapterId}-primary`,
  nativeSessionId = "native-1",
  launchId = "launch-1"
} = {}) {
  let run = createAgentRun(
    "agent-run-1",
    "task-1",
    "worker",
    "new",
    "Do bounded work",
    FIRST,
    {
      workItemId: "work-item-1",
      purpose: "execution",
      agent: { agentId, adapterId }
    }
  );
  if (delivered) run = markAgentRunDelivered(run, SECOND);
  const target = { kind: "role", taskId: run.taskId, roleName: run.roleName };
  store.transaction((tx) => {
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, target, "run-dispatched", FIRST, [{
      type: "run",
      taskId: run.taskId,
      id: run.id
    }]);
    if (delivered) {
      const claimed = claimPending(tx.getWorkMailbox(target), {
        batchId: "delivery-1",
        owner: "worker-delivery",
        startedAt: FIRST.toISOString()
      });
      tx.saveWorkMailbox(bindExecution(claimed, "delivery-1", {
        type: "run",
        taskId: run.taskId,
        id: run.id
      }));
    }
    let sessions = createRoleSessionSet(
      { scope: "task", taskId: run.taskId, roleName: run.roleName },
      agentId,
      FIRST
    );
    sessions = recordRoleAgentSession(sessions, {
      agentId,
      adapterId,
      nativeSessionId,
      launchId,
      policy: "fixed",
      status: "running"
    }, FIRST);
    sessions = bindTaskRoleRun(sessions, {
      agentId,
      runId: run.id,
      receiptId: `agent-run:${run.taskId}/${run.id}`
    }, FIRST);
    if (delivered) {
      sessions = markTaskRoleRunDelivered(sessions, {
        agentId,
        runId: run.id,
        receiptId: `agent-run:${run.taskId}/${run.id}`
      }, SECOND);
    }
    tx.saveTaskRoleSessionSet(sessions);
  });
  return run;
}

const leaderOptions = {
  now: () => THIRD,
  environment: {
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: "task-1",
    YUI_ROLE: "leader"
  }
};

test("Task Role reset fails exact work and forgets only the current native generation", (t) => {
  const { store, task, item, agent } = fixture(t, { adapterId: "codex" });
  const run = prepareRun(store, { adapterId: "codex", agentId: agent.id });

  const result = runTaskCommand([
    "role", "reset", task.id, run.roleName,
    "--reason", "The provider generation cannot continue."
  ], store, leaderOptions);

  assert.equal(result.kind, "output");
  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.equal(store.getActiveAgentRun(task.id, run.roleName), null);
  assert.equal(store.getWorkItem(task.id, item.id).status, "failed");
  const sessions = store.getTaskRoleSessionSet(task.id, run.roleName);
  assert.deepEqual(sessions.sessions, {});
  assert.equal(sessions.history.length, 1);
  assert.equal(sessions.history[0].nativeSessionId, "native-1");
  assert.equal(sessions.history[0].status, "broken");
  assert.equal(sessions.inFlight, null);
  assert.deepEqual(
    store.getWorkMailbox({
      kind: "role-runtime",
      taskId: task.id,
      roleName: run.roleName
    }).pending.reasons,
    ["runtime-cleanup-required"]
  );
  assert.equal(
    store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" })
      .pending.reasons.includes("role-run-failed"),
    true
  );
  assert.equal(new FileSchedulerStoreAdapter(store).classifyRuntimeTurnCompleted({
    taskId: task.id,
    roleName: run.roleName,
    agentId: agent.id,
    adapterId: "codex",
    nativeSessionId: "native-1",
    turnId: "late-turn",
    runId: run.id
  }), "obsolete");
});

test("the shared exact-Run terminal boundary converges queued execution", (t) => {
  const { store } = fixture(t);
  const run = prepareRun(store, { delivered: false });

  const applied = store.transaction((tx) => terminalizeExactTaskRun(tx, {
    taskId: run.taskId,
    roleName: run.roleName,
    agentId: "claude-primary",
    runId: run.id,
    receiptId: `agent-run:${run.taskId}/${run.id}`,
    nativeSessionId: "native-1",
    outcome: { status: "failed", summary: "Leader retired stale execution." }
  }, SECOND));

  assert.equal(applied.disposition, "applied");
  assert.equal(store.getAgentRun(run.taskId, run.id).status, "failed");
  assert.equal(store.getActiveAgentRun(run.taskId, run.roleName), null);
  assert.equal(store.getTaskRoleSessionSet(run.taskId, run.roleName).inFlight, null);
  assert.deepEqual(
    store.getWorkMailbox({
      kind: "role-runtime", taskId: run.taskId, roleName: run.roleName
    }).pending.reasons,
    ["runtime-cleanup-required"]
  );
});

test("Leader WorkItem retirement closes its active Run with one terminal state", (t) => {
  const { store, task, item } = fixture(t);
  const run = prepareRun(store);

  runTaskCommand([
    "work", "retire", `${task.id}/${item.id}`,
    "--summary", "This attempt is obsolete."
  ], store, leaderOptions);

  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.equal(store.getActiveAgentRun(task.id, run.roleName), null);
  const retired = store.getWorkItem(task.id, item.id);
  assert.equal(retired.status, "retired");
  assert.equal(retired.disposition.summary, "This attempt is obsolete.");
  assert.equal(retired.disposition.replacementWorkItemId, undefined);
});

test("WorkItem and Task replacement metadata are optional and idempotent", () => {
  const running = updateWorkItemStatus(
    createWorkItem("work-item-1", "task-1", { title: "Old attempt" }, FIRST),
    "running",
    FIRST
  );
  const replacement = retireWorkItem(running, {
    by: "leader",
    summary: "A narrower WorkItem owns the rest.",
    replacementWorkItemId: "work-item-2"
  }, SECOND);
  assert.equal(replacement.status, "retired");
  assert.equal(replacement.disposition.replacementWorkItemId, "work-item-2");
  assert.equal(retireWorkItem(replacement, {
    by: "leader",
    summary: "A narrower WorkItem owns the rest.",
    replacementWorkItemId: "work-item-2"
  }, THIRD), replacement);

  const task = activateTask(createTask("task-1", "Old Task", FIRST), FIRST);
  const retiredTask = retireTask(task, {
    by: "leader",
    summary: "task-2 is authoritative.",
    replacementTaskId: "task-2"
  }, SECOND);
  assert.equal(retiredTask.status, "retired");
  assert.equal(retiredTask.replacementTaskId, "task-2");
  assert.equal(retireTask(retiredTask, {
    by: "leader",
    summary: "task-2 is authoritative.",
    replacementTaskId: "task-2"
  }, THIRD), retiredTask);
});

test("Task retirement closes exact work and makes late provider facts obsolete", (t) => {
  const { store, task, item } = fixture(t);
  const run = prepareRun(store);

  runTaskCommand([
    "retire", task.id, "--summary", "The request was withdrawn."
  ], store, leaderOptions);

  assert.equal(store.getTask(task.id).status, "retired");
  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.equal(store.getWorkItem(task.id, item.id).status, "retired");
  assert.equal(new FileSchedulerStoreAdapter(store).classifyClaudeStopFailureEvent({
    eventId: "late-after-retirement",
    type: "claude-stop-failure",
    taskId: task.id,
    roleName: run.roleName,
    agentId: "claude-primary",
    adapterId: "claude",
    launchId: "launch-1",
    nativeSessionId: "native-1",
    runId: run.id,
    error: "server_error",
    errorDetails: "Late provider failure"
  }), "obsolete");
});
