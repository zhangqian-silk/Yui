import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  markTaskRoleRunDelivered,
  updateRoleAgentSessionStatus
} from "../../dist/executor/agentExecutor.js";
import { taskLeaderActionRunId } from "../../dist/commands/taskActor.js";
import { reconcileStalledRoleRuns } from "../../dist/scheduler/roleRunStall.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createRole, createRoleAgentBinding, updateRoleStatus } from "../../dist/role/role.js";
import { markAgentRunDelivered } from "../../dist/run/agentRun.js";
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
      YUI_WORKSPACE: leaderRun.effective.workspace.root,
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

test("fixed Leader Session uses an exact per-command current-turn assertion", async (t) => {
  const { store, adapter, task, leaderRun, workerRun, leaderEnvironment } = fixture(t);
  const fixedSessionEnvironment = {
    ...leaderEnvironment,
    // A fixed native Session keeps the process environment from an earlier
    // AgentRun/generation.  The managed turn must carry its exact durable
    // Run/receipt assertion separately for this command.
    YUI_RUN_ID: "agent-run-46",
    YUI_LAUNCH_ID: "runtime-old:generation:old",
    YUI_LEADER_ACTION_RUN_ID: leaderRun.id,
    YUI_LEADER_ACTION_RECEIPT_ID: `agent-run:${task.id}/${leaderRun.id}`
  };
  delete fixedSessionEnvironment.YUI_NATIVE_SESSION_ID;

  const command = (args) => runTaskCommand(args, store, leaderOptions(fixedSessionEnvironment, PROGRESS));
  command([
    "decision", "record", task.id,
    "--title", "Fixed Session progress",
    "--rationale", "The current turn carries an exact durable assertion."
  ]);
  command([
    "milestone", "add", task.id,
    "--title", "Fixed Session milestone",
    "--summary", "The exact current turn reached a durable checkpoint."
  ]);
  command([
    "work", "retire", `${task.id}/work-item-2`,
    "--summary", "The exact current turn completed its lifecycle action."
  ]);

  const actionEvents = store.listEvents(task.id).filter((event) => (
    ["decision.recorded", "milestone.added", "work.retired"].includes(event.type)
  ));
  assert.equal(actionEvents.length, 3);
  assert.deepEqual(actionEvents.map((event) => event.payload.leaderRunId), [
    leaderRun.id,
    leaderRun.id,
    leaderRun.id
  ]);
  const result = await reconcile(adapter, FIRST_RECONCILE);
  assert.deepEqual(result.map(({ runId }) => runId), [workerRun.id]);
  const expired = await reconcile(adapter, EXPIRED_RECONCILE);
  assert.equal(expired.some(({ runId }) => runId === leaderRun.id), true);
  assert.equal(store.listEvents(task.id).filter((event) => (
    event.type === "run.stalled" && event.payload.runId === leaderRun.id
  )).length, 1);

  // The production CLI receives the per-command assertion through its child
  // environment even though the fixed provider process retains stale values.
  const cliEntry = join(process.cwd(), "dist", "cli.js");
  const control = createExactControlPlaneDescriptor({
    executable: process.execPath,
    cliEntry,
    yuiHome: store.rootDirectory()
  });
  const controlDigest = exactControlPlaneDigest(control);
  const runtime = createExactTaskRuntimeDescriptor({
    controlPlaneDigest: controlDigest,
    taskId: task.id,
    roleName: "leader",
    agentId: "codex",
    adapterId: "codex",
    workspace: leaderRun.effective.workspace.root,
    runId: leaderRun.id,
    launchId: "leader-launch",
    nativeSessionId: "leader-native"
  });
  const runtimeSource = exactTaskRuntimeDescriptorPath(store.rootDirectory(), runtime);
  mkdirSync(dirname(runtimeSource), { recursive: true });
  writeFileSync(runtimeSource, `${serializeExactDescriptor(runtime)}\n`, { mode: 0o600 });
  const cliEnvironment = { ...process.env, ...fixedSessionEnvironment };
  delete cliEnvironment.YUI_NATIVE_SESSION_ID;
  cliEnvironment[YUI_CONTROL_PLANE_DESCRIPTOR] = serializeExactDescriptor(control);
  cliEnvironment[YUI_TASK_RUNTIME_DESCRIPTOR] = runtimeSource;
  const cliResult = JSON.parse(execFileSync(
    process.execPath,
    [
      cliEntry,
      EXACT_CONTROL_ARGUMENT,
      controlDigest,
      "--json", "task", "decision", "record", task.id,
      "--title", "Fixed Session CLI progress",
      "--rationale", "The managed launcher carries the exact current assertion."
    ],
    { encoding: "utf8", env: cliEnvironment }
  ));
  assert.equal(cliResult.ok, true);
  const cliDecision = store.listDecisions(task.id).at(-1);
  assert.notEqual(cliDecision, undefined);
  const cliEvent = store.listEvents(task.id).find((event) => (
    event.type === "decision.recorded"
      && event.payload.decisionId === cliDecision.id
  ));
  assert.notEqual(cliEvent, undefined);
  assert.equal(cliEvent.payload.leaderRunId, leaderRun.id);
});

test("current-turn assertions fail closed on receipt, Task, Session, and caller mismatches", (t) => {
  const { store, task, leaderRun, leaderEnvironment } = fixture(t);
  const base = {
    ...leaderEnvironment,
    YUI_RUN_ID: "agent-run-46",
    YUI_LAUNCH_ID: "runtime-old:generation:old",
    YUI_LEADER_ACTION_RUN_ID: leaderRun.id,
    YUI_LEADER_ACTION_RECEIPT_ID: `agent-run:${task.id}/${leaderRun.id}`
  };
  delete base.YUI_NATIVE_SESSION_ID;
  const variants = [
    ["stale receipt", { ...base, YUI_LEADER_ACTION_RECEIPT_ID: "agent-run:task-1/old" }],
    ["missing receipt", { ...base, YUI_LEADER_ACTION_RECEIPT_ID: undefined }],
    ["old native Session", { ...base, YUI_NATIVE_SESSION_ID: "native-old" }],
    ["cross-Task identity", { ...base, YUI_TASK_ID: "task-2" }],
    ["unmanaged caller", { ...base, YUI_SESSION_SCOPE: undefined, YUI_ROLE: undefined }]
  ];
  for (const [label, environment] of variants) {
    assert.equal(
      taskLeaderActionRunId(store, task.id, environment, store.rootDirectory()),
      undefined,
      label
    );
  }
  for (const status of ["stopped", "broken"]) {
    const sessions = updateRoleAgentSessionStatus(
      store.getTaskRoleSessionSet(task.id, "leader"),
      "codex",
      status,
      PROGRESS
    );
    store.saveTaskRoleSessionSet(sessions);
    assert.equal(
      taskLeaderActionRunId(store, task.id, base, store.rootDirectory()),
      undefined,
      `current ${status} Session`
    );
    store.saveTaskRoleSessionSet(updateRoleAgentSessionStatus(
      store.getTaskRoleSessionSet(task.id, "leader"),
      "codex",
      "running",
      PROGRESS
    ));
  }
});
