import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import {
  bindExecution,
  claimPending
} from "../../dist/coordination/workMailbox.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet
} from "../../dist/executor/agentExecutor.js";
import { terminalizeExactTaskRun } from "../../dist/lifecycle/exactRunTerminalization.js";
import { createRole, createRoleAgentBinding, updateRoleStatus } from "../../dist/role/role.js";
import { markAgentRunDelivered } from "../../dist/run/agentRun.js";
import { createAgentRun, recordRoleAgentSession } from "../helpers/effectiveLaunch.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import {
  activateTask,
  createTask,
  retireTask
} from "../../dist/task/task.js";
import {
  createWorkItem,
  disposeWorkItem,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";

const FIRST = new Date("2026-08-02T01:00:00.000Z");
const SECOND = new Date("2026-08-02T01:00:01.000Z");
const THIRD = new Date("2026-08-02T01:00:02.000Z");

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-terminal-disposition-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent("claude-primary", "claude", "claude", [], [], FIRST);
  const task = activateTask(createTask("task-1", "Retire stale task", FIRST), FIRST);
  const role = createRole(
    task.id,
    "worker",
    [createRoleAgentBinding(agent)],
    agent.id,
    home,
    FIRST
  );
  const item = updateWorkItemStatus(
    createWorkItem("work-item-1", task.id, { title: "Bounded result", assignee: role.name }, FIRST),
    "running",
    FIRST
  );
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveRole(task.id, updateRoleStatus(role, "running", FIRST));
    tx.saveWorkItem(task.id, item);
  });
  return { home, store, agent, task, role, item };
}

function prepareRun(store, { delivered, id = "agent-run-1", nativeSessionId = "native-1" }) {
  let run = createAgentRun(
    id,
    "task-1",
    "worker",
    "new",
    "Do bounded work",
    FIRST,
    {
      workItemId: "work-item-1",
      agent: { agentId: "claude-primary", adapterId: "claude" }
    }
  );
  if (delivered) run = markAgentRunDelivered(run, SECOND);
  const target = { kind: "role", taskId: "task-1", roleName: "worker" };
  store.transaction((tx) => {
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, target, "run-dispatched", FIRST, [{
      type: "run",
      taskId: run.taskId,
      id: run.id
    }]);
    if (delivered) {
      const pending = tx.getWorkMailbox(target);
      const claimed = claimPending(pending, {
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
      { scope: "task", taskId: "task-1", roleName: "worker" },
      "claude-primary",
      FIRST
    );
    sessions = recordRoleAgentSession(sessions, {
      agentId: "claude-primary",
      adapterId: "claude",
      nativeSessionId,
      policy: "fixed",
      status: "running"
    }, FIRST);
    sessions = bindTaskRoleRun(sessions, {
      agentId: "claude-primary",
      runId: run.id,
      receiptId: `agent-run:${run.taskId}/${run.id}`
    }, FIRST);
    tx.saveTaskRoleSessionSet(sessions);
  });
  return run;
}

test("the shared exact-Run terminal boundary converges delivered and undelivered executions", (t) => {
  const { store } = fixture(t);
  const run = prepareRun(store, { delivered: false });

  const applied = store.transaction((tx) => terminalizeExactTaskRun(tx, {
    taskId: run.taskId,
    roleName: run.roleName,
    agentId: "claude-primary",
    runId: run.id,
    receiptId: `agent-run:${run.taskId}/${run.id}`,
    nativeSessionId: "native-1",
    outcome: { status: "failed", summary: "Leader abandoned stale execution." }
  }, SECOND));

  assert.equal(applied.disposition, "applied");
  assert.equal(store.getAgentRun(run.taskId, run.id).status, "failed");
  assert.equal(store.getActiveAgentRun(run.taskId, run.roleName), null);
  assert.equal(store.getWorkMailbox({ kind: "role", taskId: run.taskId, roleName: run.roleName }).pending, null);
  assert.equal(store.getTaskRoleSessionSet(run.taskId, run.roleName).inFlight, null);
  assert.equal(store.getTaskRoleSessionSet(run.taskId, run.roleName).sessions["claude-primary"].status, "ready");
  assert.deepEqual(
    store.getWorkMailbox({
      kind: "role-runtime",
      taskId: run.taskId,
      roleName: run.roleName
    }).pending.reasons,
    ["runtime-cleanup-required"]
  );
});

test("Leader disposition atomically closes delivered and undelivered WorkItem Runs", (t) => {
  for (const delivered of [false, true]) {
    const { store, task, item } = fixture(t);
    const run = prepareRun(store, {
      delivered,
      id: "agent-run-1"
    });
    const execution = runTaskCommand([
      "work", "dispose", item.id, "abandoned",
      "--summary", delivered ? "Delivered attempt retired." : "Queued attempt retired."
    ], store, {
      now: () => THIRD,
      environment: {
        YUI_SESSION_SCOPE: "task",
        YUI_TASK_ID: task.id,
        YUI_ROLE: "leader"
      }
    });

    assert.equal(execution.kind, "output");
    assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
    assert.equal(store.getActiveAgentRun(task.id, run.roleName), null);
    assert.equal(store.getWorkItem(task.id, item.id).status, "abandoned");
    assert.equal(store.getWorkItem(task.id, item.id).disposition.kind, "abandoned");
    const mailbox = store.getWorkMailbox({
      kind: "role",
      taskId: task.id,
      roleName: run.roleName
    });
    assert.equal(mailbox.pending, null);
    assert.equal(mailbox.processing, null);
    assert.equal(store.getTaskRoleSessionSet(task.id, run.roleName).inFlight, null);
  }
});

test("explicit terminal state wins and a late old-session Hook cannot close its successor", (t) => {
  const { store } = fixture(t);
  const oldRun = prepareRun(store, { delivered: true, id: "agent-run-1" });
  const first = store.transaction((tx) => terminalizeExactTaskRun(tx, {
    taskId: oldRun.taskId,
    roleName: oldRun.roleName,
    agentId: "claude-primary",
    runId: oldRun.id,
    receiptId: `agent-run:${oldRun.taskId}/${oldRun.id}`,
    nativeSessionId: "native-1",
    outcome: { status: "yielded", summary: "Explicit result" }
  }, SECOND));
  assert.equal(first.disposition, "applied");

  const lateDuplicate = store.transaction((tx) => terminalizeExactTaskRun(tx, {
    taskId: oldRun.taskId,
    roleName: oldRun.roleName,
    agentId: "claude-primary",
    runId: oldRun.id,
    receiptId: `agent-run:${oldRun.taskId}/${oldRun.id}`,
    nativeSessionId: "native-1",
    outcome: { status: "failed", summary: "Late StopFailure" }
  }, THIRD));
  assert.equal(lateDuplicate.disposition, "obsolete");
  assert.equal(store.getAgentRun(oldRun.taskId, oldRun.id).status, "yielded");

  const successor = createAgentRun(
    "agent-run-2",
    oldRun.taskId,
    oldRun.roleName,
    "resume",
    "Second round",
    THIRD,
    {
      workItemId: "work-item-1",
      agent: { agentId: "claude-primary", adapterId: "claude" }
    }
  );
  store.saveActiveAgentRun(successor);
  const stale = store.transaction((tx) => terminalizeExactTaskRun(tx, {
    taskId: oldRun.taskId,
    roleName: oldRun.roleName,
    agentId: "claude-primary",
    runId: oldRun.id,
    receiptId: `agent-run:${oldRun.taskId}/${oldRun.id}`,
    nativeSessionId: "native-old",
    outcome: { status: "yielded", summary: "Old Hook" }
  }, THIRD));
  assert.equal(stale.disposition, "obsolete");
  assert.equal(store.getActiveAgentRun(successor.taskId, successor.roleName).id, successor.id);
});

test("WorkItem disposition is typed, idempotent, and replacement-scoped", () => {
  const running = updateWorkItemStatus(
    createWorkItem("work-item-1", "task-1", { title: "Old attempt" }, FIRST),
    "running",
    FIRST
  );
  const replaced = disposeWorkItem(running, {
    kind: "replaced",
    by: "leader",
    summary: "A narrower replacement owns the remaining work.",
    replacementWorkItemId: "work-item-2"
  }, SECOND);

  assert.equal(replaced.status, "superseded");
  assert.equal(replaced.disposition.kind, "replaced");
  assert.equal(replaced.disposition.replacementWorkItemId, "work-item-2");
  assert.equal(disposeWorkItem(replaced, replaced.disposition, THIRD), replaced);
  assert.throws(() => disposeWorkItem(running, {
    kind: "replaced",
    by: "leader",
    summary: "Cross-owner replacement",
    replacementWorkItemId: "task-2/work-item-2"
  }, SECOND), /replacement/i);
});

test("Task retirement preserves history and validates typed replacement metadata", () => {
  const task = activateTask(createTask("task-1", "Stale task", FIRST), FIRST);
  const retired = retireTask(task, {
    status: "superseded",
    by: "leader",
    summary: "task-2 is the single authoritative continuation.",
    replacementTaskId: "task-2"
  }, SECOND);

  assert.equal(retired.status, "superseded");
  assert.equal(retired.retirementSummary, "task-2 is the single authoritative continuation.");
  assert.equal(retired.replacementTaskId, "task-2");
  assert.equal(retireTask(retired, {
    status: "superseded",
    by: "leader",
    summary: "task-2 is the single authoritative continuation.",
    replacementTaskId: "task-2"
  }, THIRD), retired);
  assert.throws(() => retireTask(task, {
    status: "cancelled",
    by: "leader",
    summary: "No longer needed.",
    replacementTaskId: "task-2"
  }, SECOND), /replacement/i);
});

test("Task retirement closes the exact Run and makes its late provider Hook obsolete", (t) => {
  const { store, task, item } = fixture(t);
  const run = prepareRun(store, { delivered: true });
  enqueueWork(
    store,
    { kind: "role", taskId: task.id, roleName: run.roleName },
    "coalesced-control-signal",
    SECOND
  );
  runTaskCommand([
    "retire", task.id, "cancelled", "--summary", "The request was withdrawn."
  ], store, {
    now: () => THIRD,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  });

  assert.equal(store.getTask(task.id).status, "cancelled");
  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.equal(store.getWorkItem(task.id, item.id).status, "cancelled");
  const adapter = new FileSchedulerStoreAdapter(store);
  assert.equal(adapter.classifyClaudeLifecycleEvent({
    eventId: "late-after-retirement",
    type: "claude-stop",
    taskId: task.id,
    roleName: run.roleName,
    agentId: "claude-primary",
    adapterId: "claude",
    launchId: "launch-1",
    nativeSessionId: "native-1",
    runId: run.id,
    result: "Late result"
  }), "obsolete");
  assert.deepEqual(
    store.getWorkMailbox({
      kind: "role-runtime",
      taskId: task.id,
      roleName: run.roleName
    }).pending.reasons,
    ["runtime-cleanup-required"]
  );
});
