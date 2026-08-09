import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { bindExecution, claimPending } from "../../dist/coordination/workMailbox.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunDelivered
} from "../../dist/executor/agentExecutor.js";
import { reconcileStalledRoleRuns } from "../../dist/scheduler/roleRunStall.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createRole, createRoleAgentBinding, updateRoleStatus } from "../../dist/role/role.js";
import { markAgentRunDelivered } from "../../dist/run/agentRun.js";
import {
  createWorkItem,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { createAgentRun, recordRoleAgentSession } from "../helpers/effectiveLaunch.js";

const START = new Date("2026-08-05T00:00:00.000Z");
const PROGRESS = new Date("2026-08-05T00:20:00.000Z");
const FIRST_RECONCILE = new Date("2026-08-05T00:40:00.000Z");
const EXPIRED_RECONCILE = new Date("2026-08-05T00:50:00.000Z");

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-leader-action-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, START);
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], START);
  const task = activateTask(createTask("task-1", "Leader action", START), START);
  const leader = createRole(
    task.id,
    "leader",
    [createRoleAgentBinding(agent)],
    agent.id,
    home,
    START
  );
  const worker = createRole(
    task.id,
    "worker",
    [createRoleAgentBinding(agent)],
    agent.id,
    home,
    START
  );
  const leaderWork = createWorkItem("work-item-2", task.id, {
    title: "Leader lifecycle record"
  }, START);
  const workerWork = updateWorkItemStatus(createWorkItem(
    "work-item-3",
    task.id,
    { title: "Stalled worker", assignee: worker.name },
    START
  ), "running", START);
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveRole(task.id, leader);
    tx.saveRole(task.id, updateRoleStatus(worker, "running", START));
    tx.saveWorkItem(task.id, leaderWork);
    tx.saveWorkItem(task.id, workerWork);
    tx.saveMessage(task.id, createTaskMessage(
      "message-1",
      task.id,
      "Continue the current Leader action.",
      "user",
      { type: "user" },
      START
    ));
  });

  const leaderRun = installRun(store, {
    taskId: task.id,
    roleName: leader.name,
    runId: "agent-run-1",
    launchId: "leader-launch",
    nativeSessionId: "leader-native"
  });
  const workerRun = installRun(store, {
    taskId: task.id,
    roleName: worker.name,
    workItemId: workerWork.id,
    runId: "agent-run-2",
    launchId: "worker-launch",
    nativeSessionId: "worker-native"
  });

  // Reproduce the production shape: a user-message batch is claimed for the
  // exact Leader Run, while the action's later records have no mailbox refs.
  store.transaction((tx) => {
    const target = { kind: "role", taskId: task.id, roleName: leader.name };
    const mailbox = tx.getWorkMailbox(target);
    assert.notEqual(mailbox, null);
    assert.notEqual(mailbox.processing, null);
    tx.saveWorkMailbox({
      ...mailbox,
      processing: {
        ...mailbox.processing,
        batch: {
          ...mailbox.processing.batch,
          reasons: ["user-message"],
          refs: [{ type: "message", taskId: task.id, id: "message-1" }]
        }
      }
    });
  });

  return {
    home,
    store,
    adapter: new FileSchedulerStoreAdapter(store),
    task,
    leaderRun,
    workerRun,
    leaderEnvironment: {
      YUI_HOME: home,
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader",
      YUI_AGENT_ID: "codex",
      YUI_ADAPTER_ID: "codex",
      YUI_RUN_ID: leaderRun.id,
      YUI_LAUNCH_ID: "leader-launch",
      YUI_NATIVE_SESSION_ID: "leader-native"
    }
  };
}

function installRun(store, input) {
  let run = createAgentRun(
    input.runId,
    input.taskId,
    input.roleName,
    "new",
    `Run ${input.runId}`,
    START,
    {
      workItemId: input.workItemId,
      agent: { agentId: "codex", adapterId: "codex" }
    }
  );
  run = markAgentRunDelivered(run, START);
  store.transaction((tx) => {
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    tx.saveRole(input.taskId, updateRoleStatus(
      tx.getRole(input.taskId, input.roleName),
      "running",
      START
    ));
    const target = { kind: "role", taskId: input.taskId, roleName: input.roleName };
    enqueueWork(tx, target, "run-dispatched", START, [
      { type: "run", taskId: input.taskId, id: input.runId },
      ...(input.workItemId === undefined
        ? []
        : [{ type: "work-item", taskId: input.taskId, id: input.workItemId }])
    ]);
    const claimed = claimPending(tx.getWorkMailbox(target), {
      batchId: `${input.runId}-batch`,
      owner: "controller",
      startedAt: START.toISOString()
    });
    tx.saveWorkMailbox(bindExecution(claimed, `${input.runId}-batch`, {
      type: "run",
      taskId: input.taskId,
      id: input.runId
    }));
    let sessions = createRoleSessionSet(
      { scope: "task", taskId: input.taskId, roleName: input.roleName },
      "codex",
      START
    );
    sessions = recordRoleAgentSession(sessions, {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: input.nativeSessionId,
      launchId: input.launchId,
      policy: "fixed",
      status: "running",
      effective: run.effective
    }, START);
    sessions = bindTaskRoleRun(sessions, {
      agentId: "codex",
      runId: run.id,
      receiptId: `agent-run:${input.taskId}/${run.id}`
    }, START);
    sessions = markTaskRoleRunDelivered(sessions, {
      agentId: "codex",
      runId: run.id,
      receiptId: `agent-run:${input.taskId}/${run.id}`
    }, START);
    tx.saveTaskRoleSessionSet(sessions);
  });
  return run;
}

function leaderOptions(environment, now) {
  return { environment, now: () => now };
}

async function reconcile(store, now) {
  return reconcileStalledRoleRuns(
    store,
    { async inspectRole() { return "present"; } },
    now,
    undefined,
    30 * 60_000
  );
}

test("managed current Leader lifecycle records buy one exact action window", async (t) => {
  const { store, adapter, task, leaderRun, workerRun, leaderEnvironment } = fixture(t);

  runTaskCommand([
    "decision", "record", task.id,
    "--title", "Keep the current plan",
    "--rationale", "The exact Leader action made durable progress."
  ], store, leaderOptions(leaderEnvironment, PROGRESS));
  runTaskCommand([
    "milestone", "add", task.id,
    "--title", "Decision recorded",
    "--summary", "The current Leader reached a milestone."
  ], store, leaderOptions(leaderEnvironment, PROGRESS));
  runTaskCommand([
    "work", "retire", `${task.id}/work-item-2`,
    "--summary", "The Leader lifecycle action is complete."
  ], store, leaderOptions(leaderEnvironment, PROGRESS));

  const actionEvents = store.listEvents(task.id).filter((event) => (
    ["decision.recorded", "milestone.added", "work.retired"].includes(event.type)
  ));
  assert.equal(actionEvents.length, 3);

  const first = await reconcile(adapter, FIRST_RECONCILE);
  assert.deepEqual(first.map(({ runId }) => runId), [workerRun.id]);
  // This assertion is intentionally red on 922c0be: production commands do
  // not yet stamp the current Leader Run into their Task events, so the exact
  // processing action is treated as stale at the first reconcile.
  assert.deepEqual(actionEvents.map((event) => event.payload.leaderRunId), [
    leaderRun.id,
    leaderRun.id,
    leaderRun.id
  ]);
  assert.equal(store.listEvents(task.id).some((event) => (
    event.type === "run.stalled" && event.payload.runId === leaderRun.id
  )), false);

  const expired = await reconcile(adapter, EXPIRED_RECONCILE);
  assert.equal(expired.some(({ runId }) => runId === leaderRun.id), true);
  assert.equal(store.listEvents(task.id).filter((event) => (
    event.type === "run.stalled" && event.payload.runId === leaderRun.id
  )).length, 1);
});

test("unmanaged or stale Leader environment cannot stamp a lifecycle event", async (t) => {
  const { store, adapter, task, leaderRun } = fixture(t);
  const staleEnvironment = {
    YUI_HOME: store.rootDirectory(),
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: task.id,
    YUI_ROLE: "leader",
    YUI_AGENT_ID: "codex",
    YUI_ADAPTER_ID: "codex",
    YUI_RUN_ID: "old-leader-run",
    YUI_LAUNCH_ID: "old-launch",
    YUI_NATIVE_SESSION_ID: "old-native"
  };

  runTaskCommand([
    "decision", "record", task.id,
    "--title", "Unmanaged identity",
    "--rationale", "This must not refresh the exact current action."
  ], store, leaderOptions(staleEnvironment, PROGRESS));

  const event = store.listEvents(task.id).find((candidate) => candidate.type === "decision.recorded");
  assert.notEqual(event, undefined);
  assert.equal(event.payload.leaderRunId, undefined);
  const result = await reconcile(adapter, FIRST_RECONCILE);
  assert.equal(result.some(({ runId }) => runId === leaderRun.id), true);
});
