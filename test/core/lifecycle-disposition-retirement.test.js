import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runOperatorCommand } from "../../dist/commands/operatorCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { runControllerSchedulerPass } from "../../dist/controller/controller.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import {
  bindExecution,
  claimPending
} from "../../dist/coordination/workMailbox.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunDelivered,
  recordObservedTaskRoleCompletion,
  roleAgentSessionResumeMode
} from "../../dist/executor/agentExecutor.js";
import { createPendingTurnCompletion } from "../../dist/executor/turnCompletion.js";
import { terminalizeExactTaskRun } from "../../dist/lifecycle/exactRunTerminalization.js";
import {
  attachReviewRoundWorkspace,
  createReviewRound,
  startReviewRound
} from "../../dist/review/reviewRound.js";
import { createRole, createRoleAgentBinding, updateRoleStatus } from "../../dist/role/role.js";
import { markAgentRunDelivered } from "../../dist/run/agentRun.js";
import {
  RUNTIME_CLEANUP_REQUIRED_REASON,
  RUNTIME_LAUNCH_RESERVED_REASON,
  RUNTIME_LIFECYCLE_OWNER
} from "../../dist/runtime/lifecycleReservation.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { createAgentRun, recordRoleAgentSession } from "../helpers/effectiveLaunch.js";
import {
  activateTask,
  createTask,
  retireTask
} from "../../dist/task/task.js";
import {
  createWorkItem,
  disposeWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { createRoleWorkspace } from "../../dist/worktree/roleWorkspace.js";

const FIRST = new Date("2026-08-02T01:00:00.000Z");
const SECOND = new Date("2026-08-02T01:00:01.000Z");
const THIRD = new Date("2026-08-02T01:00:02.000Z");

function fixture(t, { adapterId = "claude" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "yui-terminal-disposition-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const agentId = `${adapterId}-primary`;
  const agent = createConfiguredAgent(agentId, adapterId, adapterId, [], [], FIRST);
  const task = activateTask(createTask("task-1", "Retire stale task", FIRST), FIRST);
  const role = createRole(
    task.id,
    "worker",
    [createRoleAgentBinding(agent)],
    agent.id,
    home,
    FIRST
  );
  const leader = createRole(
    task.id,
    "leader",
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
    tx.saveRole(task.id, leader);
    tx.saveRole(task.id, updateRoleStatus(role, "running", FIRST));
    tx.saveWorkItem(task.id, item);
  });
  return { home, store, agent, task, role, item };
}

function prepareRun(store, {
  delivered,
  id = "agent-run-1",
  roleName = "worker",
  purpose = "execution",
  workItemId = roleName === "leader" ? undefined : "work-item-1",
  reviewRoundId,
  reviewRound,
  workspace,
  nativeSessionId = "native-1",
  launchId = "launch-1",
  agentId = "claude-primary",
  adapterId = "claude"
}) {
  let run = createAgentRun(
    id,
    "task-1",
    roleName,
    "new",
    "Do bounded work",
    FIRST,
    {
      ...(workItemId === undefined ? {} : { workItemId }),
      purpose,
      ...(reviewRoundId === undefined ? {} : { reviewRoundId }),
      ...(workspace === undefined ? {} : { workspace }),
      agent: { agentId, adapterId }
    }
  );
  if (delivered) run = markAgentRunDelivered(run, SECOND);
  const target = { kind: "role", taskId: "task-1", roleName };
  store.transaction((tx) => {
    const role = tx.getRole("task-1", roleName);
    tx.saveRole("task-1", updateRoleStatus(role, "running", FIRST));
    if (reviewRound !== undefined) tx.saveReviewRound("task-1", reviewRound);
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
      { scope: "task", taskId: "task-1", roleName },
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

function retirementCommandArgs(run, agent, overrides = {}) {
  return [
    "retire-unusable-session",
    overrides.taskId ?? run.taskId,
    overrides.roleName ?? run.roleName,
    "--run", overrides.runId ?? run.id,
    "--agent", overrides.agentId ?? agent.id,
    "--adapter", overrides.adapterId ?? agent.adapterId,
    "--receipt", overrides.receiptId ?? `agent-run:${run.taskId}/${run.id}`,
    "--native-session", overrides.nativeSessionId ?? "native-matrix",
    "--launch", overrides.launchId ?? "launch-matrix",
    "--reason", overrides.reason ?? "Operator declared the fixed Session unusable."
  ];
}

function globalOperatorOptions() {
  return {
    now: () => THIRD,
    environment: { YUI_SESSION_SCOPE: "global", YUI_ROLE: "operator" }
  };
}

function lifecycleSnapshot(store, taskId, roleName, runId, workItemId) {
  return JSON.stringify({
    task: store.getTask(taskId),
    role: store.getRole(taskId, roleName),
    run: store.getAgentRun(taskId, runId),
    activeRun: store.getActiveAgentRun(taskId, roleName),
    workItem: store.getWorkItem(taskId, workItemId),
    sessions: store.getTaskRoleSessionSet(taskId, roleName),
    roleMailbox: store.getWorkMailbox({ kind: "role", taskId, roleName }),
    runtimeMailbox: store.getWorkMailbox({ kind: "role-runtime", taskId, roleName }),
    leaderMailbox: store.getWorkMailbox({ kind: "role", taskId, roleName: "leader" }),
    operatorMailbox: store.getWorkMailbox({ kind: "operator" }),
    messages: store.listMessages(taskId),
    events: store.listEvents(taskId)
  });
}

test("Operator can declare one exact delivered fixed Session unusable without synthesizing success", (t) => {
  const { store, task, role, item, agent } = fixture(t, { adapterId: "codex" });
  const run = prepareRun(store, {
    delivered: true,
    id: "agent-run-2",
    nativeSessionId: "native-unusable",
    launchId: "launch-unusable",
    agentId: agent.id,
    adapterId: agent.adapterId
  });
  enqueueWork(
    store,
    { kind: "role", taskId: task.id, roleName: role.name },
    "user-message",
    SECOND
  );

  const result = runOperatorCommand([
    "retire-unusable-session", task.id, role.name,
    "--run", run.id,
    "--agent", agent.id,
    "--adapter", agent.adapterId,
    "--receipt", `agent-run:${run.taskId}/${run.id}`,
    "--native-session", "native-unusable",
    "--launch", "launch-unusable",
    "--reason", "The fixed native Session cannot execute another Turn."
  ], store, {
    now: () => THIRD,
    environment: {
      YUI_SESSION_SCOPE: "global",
      YUI_ROLE: "operator"
    }
  });

  assert.equal(result.kind, "output");
  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.equal(store.getWorkItem(task.id, item.id).status, "failed");
  assert.equal(store.getWorkItem(task.id, item.id).candidates.length, 0);
  const sessions = store.getTaskRoleSessionSet(task.id, role.name);
  assert.equal(sessions.inFlight.runId, run.id);
  assert.equal(sessions.sessions[agent.id].nativeSessionId, "native-unusable");
  assert.equal(sessions.sessions[agent.id].launchId, "launch-unusable");
  assert.equal(
    sessions.unusableSessionRetirement.reason,
    "The fixed native Session cannot execute another Turn."
  );
  assert.equal(sessions.unusableSessionRetirement.status, "cleanup-pending");
  assert.deepEqual(
    store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: role.name }).pending.reasons,
    ["user-message"]
  );
  assert.deepEqual(
    store.getWorkMailbox({
      kind: "role-runtime",
      taskId: task.id,
      roleName: role.name
    }).pending.reasons,
    ["runtime-cleanup-required"]
  );
  assert.equal(
    store.listEvents(task.id).at(-1).type,
    "runtime.unusable-session-retirement-requested"
  );
});

test("verified cleanup completion retires only the declared Session generation", (t) => {
  const { store, task, role, agent } = fixture(t, { adapterId: "codex" });
  const run = prepareRun(store, {
    delivered: true,
    id: "agent-run-3",
    nativeSessionId: "native-before-retirement",
    launchId: "launch-before-retirement",
    agentId: agent.id,
    adapterId: agent.adapterId
  });
  runOperatorCommand([
    "retire-unusable-session", task.id, role.name,
    "--run", run.id,
    "--agent", agent.id,
    "--adapter", agent.adapterId,
    "--receipt", `agent-run:${run.taskId}/${run.id}`,
    "--native-session", "native-before-retirement",
    "--launch", "launch-before-retirement",
    "--reason", "Operator verified this fixed Session is unusable."
  ], store, {
    now: () => THIRD,
    environment: { YUI_SESSION_SCOPE: "global", YUI_ROLE: "operator" }
  });

  const target = {
    kind: "role-runtime",
    taskId: task.id,
    roleName: role.name
  };
  const adapter = new FileSchedulerStoreAdapter(store);
  assert.equal(adapter.completeRuntimeCleanup(target, new Date("2026-08-02T01:00:03.000Z")), true);

  const sessions = store.getTaskRoleSessionSet(task.id, role.name);
  assert.equal(sessions.inFlight, null);
  assert.equal(sessions.unusableSessionRetirement, null);
  assert.equal(sessions.sessions[agent.id], undefined);
  assert.equal(roleAgentSessionResumeMode(sessions, agent.id), "new");
  const retired = Object.values(sessions.retiredSessions);
  assert.equal(retired.length, 1);
  assert.equal(retired[0].session.nativeSessionId, "native-before-retirement");
  assert.equal(retired[0].session.launchId, "launch-before-retirement");
  assert.equal(retired[0].session.status, "broken");
  assert.equal(retired[0].reason, "Operator verified this fixed Session is unusable.");
  assert.equal(
    store.listEvents(task.id).at(-1).type,
    "runtime.unusable-session-retired"
  );

  const successor = recordRoleAgentSession(sessions, {
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: "native-after-retirement",
    launchId: "launch-after-retirement",
    policy: "fixed",
    status: "running"
  }, new Date("2026-08-02T01:00:04.000Z"));
  store.saveTaskRoleSessionSet(successor);
  const beforeLateCompletion = lifecycleSnapshot(store, task.id, role.name, run.id, "work-item-1");
  assert.equal(
    adapter.completeRuntimeCleanup(target, new Date("2026-08-02T01:00:05.000Z")),
    false
  );
  assert.equal(
    lifecycleSnapshot(store, task.id, role.name, run.id, "work-item-1"),
    beforeLateCompletion
  );
  assert.equal(
    store.getTaskRoleSessionSet(task.id, role.name).sessions[agent.id].nativeSessionId,
    "native-after-retirement"
  );
  assert.throws(() => recordRoleAgentSession(sessions, {
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: "native-before-retirement",
    launchId: "launch-different",
    policy: "fixed",
    status: "running"
  }, new Date("2026-08-02T01:00:04.000Z")), /cannot reuse retired native or launch identity/i);
  assert.throws(() => recordRoleAgentSession(sessions, {
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: "native-different",
    launchId: "launch-before-retirement",
    policy: "fixed",
    status: "running"
  }, new Date("2026-08-02T01:00:04.000Z")), /cannot reuse retired native or launch identity/i);
  assert.throws(() => recordRoleAgentSession(sessions, {
    agentId: "other-agent",
    adapterId: agent.adapterId,
    nativeSessionId: "native-before-retirement",
    launchId: "launch-other-agent",
    policy: "fixed",
    status: "running"
  }, new Date("2026-08-02T01:00:04.000Z")), /cannot reuse retired native or launch identity/i);
  const lateOldFact = adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: "native-before-retirement",
    launchId: "launch-before-retirement",
    turnId: "turn-after-successor-started",
    runId: run.id,
    summary: "Late old Session fact."
  }, new Date("2026-08-02T01:00:06.000Z"));
  assert.equal(lateOldFact.disposition, "obsolete");
  assert.equal(
    store.getTaskRoleSessionSet(task.id, role.name).sessions[agent.id].nativeSessionId,
    "native-after-retirement"
  );
});

test("Controller preserves the exact retirement obligation until owned stop is confirmed", async (t) => {
  const { store, task, role, agent } = fixture(t, { adapterId: "codex" });
  const run = prepareRun(store, {
    delivered: true,
    id: "agent-run-4",
    nativeSessionId: "native-controller-stop",
    launchId: "launch-controller-stop",
    agentId: agent.id,
    adapterId: agent.adapterId
  });
  runOperatorCommand([
    "retire-unusable-session", task.id, role.name,
    "--run", run.id,
    "--agent", agent.id,
    "--adapter", agent.adapterId,
    "--receipt", `agent-run:${run.taskId}/${run.id}`,
    "--native-session", "native-controller-stop",
    "--launch", "launch-controller-stop",
    "--reason", "The fixed Session is unusable."
  ], store, {
    now: () => THIRD,
    environment: { YUI_SESSION_SCOPE: "global", YUI_ROLE: "operator" }
  });
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  const stoppedOwners = [];
  let allowStop = false;
  const lifecycleHost = {
    async inspectOwner() { return { state: "running" }; },
    async stopOwner(owner) {
      stoppedOwners.push(owner);
      return allowStop;
    }
  };
  const delivery = {
    async prepareRoleSession() { throw new Error("Role launch must remain fenced."); },
    async waitUntilReady() { throw new Error("Role launch must remain fenced."); },
    async sendOnce() { throw new Error("Role launch must remain fenced."); },
    async inspectRole() { return "present"; },
    async stopTask() { return false; },
    forgetPrepared() {}
  };
  const scope = {
    kind: "dirty",
    keys: [`role:${task.id}/${role.name}`]
  };
  const failedOutcomes = [];
  await runControllerSchedulerPass(
    schedulerStore,
    delivery,
    new Date("2026-08-02T01:00:03.000Z"),
    undefined,
    scope,
    false,
    failedOutcomes,
    lifecycleHost
  );

  assert.equal(failedOutcomes.length, 1);
  assert.equal(failedOutcomes[0].status, "failed");
  assert.deepEqual(stoppedOwners, [{
    scope: "task",
    taskId: task.id,
    roleName: role.name
  }]);
  let sessions = store.getTaskRoleSessionSet(task.id, role.name);
  assert.equal(sessions.unusableSessionRetirement.status, "cleanup-pending");
  assert.equal(sessions.sessions[agent.id].nativeSessionId, "native-controller-stop");
  assert.equal(sessions.inFlight.runId, run.id);
  assert.notEqual(store.getWorkMailbox({
    kind: "role-runtime",
    taskId: task.id,
    roleName: role.name
  }), null);

  allowStop = true;
  const completedOutcomes = [];
  await runControllerSchedulerPass(
    schedulerStore,
    delivery,
    new Date("2026-08-02T01:00:04.000Z"),
    undefined,
    scope,
    false,
    completedOutcomes,
    lifecycleHost
  );

  assert.equal(completedOutcomes.length, 1);
  assert.equal(completedOutcomes[0].status, "completed");
  sessions = store.getTaskRoleSessionSet(task.id, role.name);
  assert.equal(sessions.unusableSessionRetirement, null);
  assert.equal(sessions.sessions[agent.id], undefined);
  assert.equal(roleAgentSessionResumeMode(sessions, agent.id), "new");
});

test("late facts from the declared unusable generation are obsolete before and after retirement", (t) => {
  const { store, task, role, agent } = fixture(t, { adapterId: "codex" });
  const run = prepareRun(store, {
    delivered: true,
    id: "agent-run-5",
    nativeSessionId: "native-late-facts",
    launchId: "launch-late-facts",
    agentId: agent.id,
    adapterId: agent.adapterId
  });
  runOperatorCommand([
    "retire-unusable-session", task.id, role.name,
    "--run", run.id,
    "--agent", agent.id,
    "--adapter", agent.adapterId,
    "--receipt", `agent-run:${run.taskId}/${run.id}`,
    "--native-session", "native-late-facts",
    "--launch", "launch-late-facts",
    "--reason", "This fixed Session is unusable."
  ], store, {
    now: () => THIRD,
    environment: { YUI_SESSION_SCOPE: "global", YUI_ROLE: "operator" }
  });
  const adapter = new FileSchedulerStoreAdapter(store);
  const lateTurn = {
    taskId: task.id,
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: "native-late-facts",
    launchId: "launch-late-facts",
    turnId: "turn-late-facts",
    runId: run.id
  };

  assert.equal(adapter.classifyRuntimeTurnCompleted(lateTurn), "obsolete");
  assert.equal(adapter.observeRuntimeTurnCompleted({
    ...lateTurn,
    summary: "Late old generation result."
  }, THIRD).disposition, "obsolete");
  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.equal(store.getWorkItem(task.id, "work-item-1").candidates.length, 0);

  const target = { kind: "role-runtime", taskId: task.id, roleName: role.name };
  assert.equal(adapter.completeRuntimeCleanup(target, new Date("2026-08-02T01:00:03.000Z")), true);
  assert.equal(adapter.classifyRuntimeTurnCompleted(lateTurn), "obsolete");
  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
});

test("Operator unusable Session command fails closed across exact identities and conflicts", async (t) => {
  const cases = [
    ["wrong task", { taskId: "task-wrong" }],
    ["wrong role and runtime owner", { roleName: "reviewer" }],
    ["wrong agent", { agentId: "agent-wrong" }],
    ["wrong adapter", { adapterId: "adapter-wrong" }],
    ["wrong Run", { runId: "agent-run-999" }],
    ["wrong receipt", { receiptId: "agent-run:wrong" }],
    ["wrong native Session", { nativeSessionId: "native-wrong" }],
    ["stale launch generation", { launchId: "launch-stale" }]
  ];
  for (const [index, [label, overrides]] of cases.entries()) {
    await t.test(label, (subtest) => {
      const { store, task, role, item, agent } = fixture(subtest, { adapterId: "codex" });
      const run = prepareRun(store, {
        delivered: true,
        id: `agent-run-${index + 2}`,
        nativeSessionId: "native-matrix",
        launchId: "launch-matrix",
        agentId: agent.id,
        adapterId: agent.adapterId
      });
      const before = lifecycleSnapshot(store, task.id, role.name, run.id, item.id);
      assert.throws(
        () => runOperatorCommand(
          retirementCommandArgs(run, agent, overrides),
          store,
          globalOperatorOptions()
        )
      );
      assert.equal(
        lifecycleSnapshot(store, task.id, role.name, run.id, item.id),
        before
      );
      assert.equal(store.getWorkItem(task.id, item.id).candidates.length, 0);
    });
  }

  await t.test("deliveredAt null", (subtest) => {
    const { store, task, role, item, agent } = fixture(subtest, { adapterId: "codex" });
    const run = prepareRun(store, {
      delivered: false,
      id: "agent-run-10",
      nativeSessionId: "native-matrix",
      launchId: "launch-matrix",
      agentId: agent.id,
      adapterId: agent.adapterId
    });
    const before = lifecycleSnapshot(store, task.id, role.name, run.id, item.id);
    assert.throws(() => runOperatorCommand(
      retirementCommandArgs(run, agent), store, globalOperatorOptions()
    ), /delivery is still pending/i);
    assert.equal(lifecycleSnapshot(store, task.id, role.name, run.id, item.id), before);
  });

  await t.test("Task state changed", (subtest) => {
    const { store, task, role, item, agent } = fixture(subtest, { adapterId: "codex" });
    const run = prepareRun(store, {
      delivered: true,
      id: "agent-run-11",
      nativeSessionId: "native-matrix",
      launchId: "launch-matrix",
      agentId: agent.id,
      adapterId: agent.adapterId
    });
    store.saveTask(retireTask(task, {
      status: "abandoned",
      summary: "This Task was retired independently.",
      by: "leader"
    }, THIRD));
    const before = lifecycleSnapshot(store, task.id, role.name, run.id, item.id);
    assert.throws(() => runOperatorCommand(
      retirementCommandArgs(run, agent), store, globalOperatorOptions()
    ), /Task is not active/i);
    assert.equal(lifecycleSnapshot(store, task.id, role.name, run.id, item.id), before);
  });

  await t.test("Role state changed", (subtest) => {
    const { store, task, role, item, agent } = fixture(subtest, { adapterId: "codex" });
    const run = prepareRun(store, {
      delivered: true,
      id: "agent-run-12",
      nativeSessionId: "native-matrix",
      launchId: "launch-matrix",
      agentId: agent.id,
      adapterId: agent.adapterId
    });
    store.saveRole(task.id, updateRoleStatus(store.getRole(task.id, role.name), "idle", THIRD));
    const before = lifecycleSnapshot(store, task.id, role.name, run.id, item.id);
    assert.throws(() => runOperatorCommand(
      retirementCommandArgs(run, agent), store, globalOperatorOptions()
    ), /Role is not running/i);
    assert.equal(lifecycleSnapshot(store, task.id, role.name, run.id, item.id), before);
  });

  await t.test("already-terminal Run without a retirement record", (subtest) => {
    const { store, task, role, item, agent } = fixture(subtest, { adapterId: "codex" });
    const run = prepareRun(store, {
      delivered: true,
      id: "agent-run-13",
      nativeSessionId: "native-matrix",
      launchId: "launch-matrix",
      agentId: agent.id,
      adapterId: agent.adapterId
    });
    store.transaction((tx) => terminalizeExactTaskRun(tx, {
      taskId: task.id,
      roleName: role.name,
      agentId: agent.id,
      runId: run.id,
      receiptId: `agent-run:${run.taskId}/${run.id}`,
      nativeSessionId: "native-matrix",
      launchId: "launch-matrix",
      outcome: { status: "failed", summary: "An earlier exact terminal fact won." }
    }, THIRD));
    store.saveRole(
      task.id,
      updateRoleStatus(store.getRole(task.id, role.name), "running", THIRD)
    );
    const before = lifecycleSnapshot(store, task.id, role.name, run.id, item.id);
    assert.throws(() => runOperatorCommand(
      retirementCommandArgs(run, agent), store, globalOperatorOptions()
    ), /already terminal/i);
    assert.equal(lifecycleSnapshot(store, task.id, role.name, run.id, item.id), before);
  });

  await t.test("pending Turn completion", (subtest) => {
    const { store, task, role, item, agent } = fixture(subtest, { adapterId: "codex" });
    const run = prepareRun(store, {
      delivered: true,
      id: "agent-run-14",
      nativeSessionId: "native-matrix",
      launchId: "launch-matrix",
      agentId: agent.id,
      adapterId: agent.adapterId
    });
    store.transaction((tx) => {
      const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
      tx.saveTaskRoleSessionSet(recordObservedTaskRoleCompletion(
        sessions,
        createPendingTurnCompletion({
          taskId: task.id,
          roleName: role.name,
          agentId: agent.id,
          nativeSessionId: "native-matrix",
          turnId: "turn-pending-matrix",
          runId: run.id,
          summary: "Pending exact native completion.",
          observedAt: SECOND,
          dueAt: THIRD
        })
      ));
    });
    const before = lifecycleSnapshot(store, task.id, role.name, run.id, item.id);
    assert.throws(() => runOperatorCommand(
      retirementCommandArgs(run, agent), store, globalOperatorOptions()
    ), /pending Turn completion/i);
    assert.equal(lifecycleSnapshot(store, task.id, role.name, run.id, item.id), before);
  });

  for (const lifecycleConflict of ["cleanup obligation", "launch reservation"]) {
    await t.test(lifecycleConflict, (subtest) => {
      const { store, task, role, item, agent } = fixture(subtest, { adapterId: "codex" });
      const run = prepareRun(store, {
        delivered: true,
        id: lifecycleConflict === "cleanup obligation" ? "agent-run-15" : "agent-run-16",
        nativeSessionId: "native-matrix",
        launchId: "launch-matrix",
        agentId: agent.id,
        adapterId: agent.adapterId
      });
      const target = { kind: "role-runtime", taskId: task.id, roleName: role.name };
      store.transaction((tx) => {
        const queued = enqueueWork(
          tx,
          target,
          lifecycleConflict === "cleanup obligation"
            ? RUNTIME_CLEANUP_REQUIRED_REASON
            : RUNTIME_LAUNCH_RESERVED_REASON,
          SECOND,
          [{ type: "task", id: task.id }]
        );
        if (lifecycleConflict === "launch reservation") {
          const claimed = claimPending(queued, {
            batchId: "launch-conflicting-reservation",
            owner: RUNTIME_LIFECYCLE_OWNER,
            startedAt: SECOND.toISOString()
          });
          tx.saveWorkMailbox(bindExecution(
            claimed,
            "launch-conflicting-reservation",
            { type: "run", taskId: run.taskId, id: run.id }
          ));
        }
      });
      const before = lifecycleSnapshot(store, task.id, role.name, run.id, item.id);
      assert.throws(() => runOperatorCommand(
        retirementCommandArgs(run, agent), store, globalOperatorOptions()
      ), /runtime lifecycle work/i);
      assert.equal(lifecycleSnapshot(store, task.id, role.name, run.id, item.id), before);
    });
  }

  await t.test("non-Operator authority", (subtest) => {
    const { store, task, role, item, agent } = fixture(subtest, { adapterId: "codex" });
    const run = prepareRun(store, {
      delivered: true,
      id: "agent-run-17",
      nativeSessionId: "native-matrix",
      launchId: "launch-matrix",
      agentId: agent.id,
      adapterId: agent.adapterId
    });
    for (const environment of [
      undefined,
      { YUI_SESSION_SCOPE: "global", YUI_ROLE: "user" },
      { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: task.id, YUI_ROLE: "leader" },
      { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: task.id, YUI_ROLE: role.name },
      { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: task.id, YUI_ROLE: "reviewer" }
    ]) {
      const before = lifecycleSnapshot(store, task.id, role.name, run.id, item.id);
      assert.throws(() => runOperatorCommand(
        retirementCommandArgs(run, agent),
        store,
        { now: () => THIRD, environment }
      ), /Only the global Operator/i);
      assert.equal(lifecycleSnapshot(store, task.id, role.name, run.id, item.id), before);
    }
  });
});

test("duplicate exact Operator declarations are idempotent and do not notify or stop twice", (t) => {
  const { store, task, role, item, agent } = fixture(t, { adapterId: "codex" });
  const run = prepareRun(store, {
    delivered: true,
    id: "agent-run-18",
    nativeSessionId: "native-matrix",
    launchId: "launch-matrix",
    agentId: agent.id,
    adapterId: agent.adapterId
  });
  const first = runOperatorCommand(
    retirementCommandArgs(run, agent), store, globalOperatorOptions()
  );
  const afterFirst = lifecycleSnapshot(store, task.id, role.name, run.id, item.id);
  const duplicate = runOperatorCommand(
    retirementCommandArgs(run, agent), store, globalOperatorOptions()
  );

  assert.equal(first.data.disposition, "applied");
  assert.equal(duplicate.data.disposition, "existing");
  assert.equal(lifecycleSnapshot(store, task.id, role.name, run.id, item.id), afterFirst);
  assert.equal(store.getWorkItem(task.id, item.id).candidates.length, 0);
});

test("review Session retirement fails only the ReviewRound and preserves its Candidate", (t) => {
  const { home, store, task, agent } = fixture(t, { adapterId: "codex" });
  const reviewer = createRole(
    task.id,
    "reviewer",
    [createRoleAgentBinding(agent)],
    agent.id,
    home,
    FIRST
  );
  const reviewItem = updateWorkItemStatus(createWorkItem(
    "work-item-2",
    task.id,
    { title: "Candidate under review" },
    FIRST
  ), "running", FIRST);
  const candidateItem = submitWorkItemCandidate(reviewItem, {
    summary: "Candidate awaiting independent review.",
    source: { type: "direct" }
  }, FIRST);
  const runId = "agent-run-19";
  const reviewBaseCommit = "a".repeat(40);
  const pendingRound = createReviewRound(
    "review-round-1",
    task.id,
    reviewItem.id,
    candidateItem.candidates[0].id,
    reviewer.name,
    "leader",
    reviewBaseCommit,
    FIRST
  );
  const reviewWorkspace = createRoleWorkspace({
    taskId: task.id,
    roleName: reviewer.name,
    owner: { type: "review-round", reviewRoundId: pendingRound.id },
    root: join(home, "review-round-1"),
    entries: [{
      projectId: "project-1",
      directory: "fixture",
      access: "write",
      path: join(home, "review-round-1", "fixture"),
      branch: "review-round-1",
      baseRef: "main",
      baseCommit: reviewBaseCommit
    }]
  }, FIRST);
  const round = startReviewRound(
    attachReviewRoundWorkspace(pendingRound, reviewWorkspace),
    runId
  );
  store.transaction((tx) => {
    tx.saveRole(task.id, reviewer);
    tx.saveWorkItem(task.id, candidateItem);
  });
  const run = prepareRun(store, {
    delivered: true,
    id: runId,
    roleName: reviewer.name,
    purpose: "review",
    workItemId: reviewItem.id,
    reviewRoundId: round.id,
    reviewRound: round,
    workspace: reviewWorkspace,
    nativeSessionId: "native-review-unusable",
    launchId: "launch-review-unusable",
    agentId: agent.id,
    adapterId: agent.adapterId
  });

  runOperatorCommand(retirementCommandArgs(run, agent, {
    nativeSessionId: "native-review-unusable",
    launchId: "launch-review-unusable"
  }), store, globalOperatorOptions());

  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.equal(store.getReviewRound(task.id, round.id).status, "failed");
  assert.equal(store.getWorkItem(task.id, reviewItem.id).status, "awaiting_acceptance");
  assert.equal(store.getWorkItem(task.id, reviewItem.id).candidates.length, 1);
  assert.equal(
    store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" })
      .pending.reasons.includes("review-failed"),
    true
  );
});

test("Leader Session retirement records failure recovery but cannot complete the Task", (t) => {
  const { store, task, item, agent } = fixture(t, { adapterId: "codex" });
  const run = prepareRun(store, {
    delivered: true,
    id: "agent-run-20",
    roleName: "leader",
    workItemId: undefined,
    nativeSessionId: "native-leader-unusable",
    launchId: "launch-leader-unusable",
    agentId: agent.id,
    adapterId: agent.adapterId
  });

  runOperatorCommand(retirementCommandArgs(run, agent, {
    nativeSessionId: "native-leader-unusable",
    launchId: "launch-leader-unusable"
  }), store, globalOperatorOptions());

  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.equal(store.getTask(task.id).status, "active");
  assert.equal(store.getRole(task.id, "leader").status, "failed");
  assert.equal(store.getLeaderFailure(task.id).nativeSessionId, "native-leader-unusable");
  assert.match(store.getLeaderFailure(task.id).message, /Operator declared fixed native Session unusable/);
  assert.equal(store.getOperatorNotification(task.id).type, "leader-recovery-failed");
  assert.equal(
    store.getWorkMailbox({ kind: "operator" }).pending.reasons.includes("leader-run-failed"),
    true
  );
  assert.equal(store.getWorkItem(task.id, item.id).status, "running");
  assert.equal(store.getWorkItem(task.id, item.id).candidates.length, 0);
});

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

test("Leader disposition forces cleanup and obsoletes late Hooks for delivered and prepared Codex Runs", (t) => {
  for (const delivered of [false, true]) {
    const { store, task, item, agent } = fixture(t, { adapterId: "codex" });
    const run = prepareRun(store, {
      delivered,
      id: "agent-run-1",
      agentId: agent.id,
      adapterId: "codex"
    });
    runTaskCommand([
      "work", "dispose", item.id, "cancelled", "--summary", "The attempt is obsolete."
    ], store, {
      now: () => THIRD,
      environment: {
        YUI_SESSION_SCOPE: "task",
        YUI_TASK_ID: task.id,
        YUI_ROLE: "leader"
      }
    });

    assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
    assert.equal(store.getActiveAgentRun(task.id, run.roleName), null);
    const sessions = store.getTaskRoleSessionSet(task.id, run.roleName);
    assert.equal(sessions.inFlight, null);
    assert.equal(sessions.sessions[agent.id].status, "ready");
    assert.equal(sessions.sessions[agent.id].nativeSessionId, "native-1");
    const runtimeTarget = {
      kind: "role-runtime",
      taskId: task.id,
      roleName: run.roleName
    };
    assert.deepEqual(
      store.getWorkMailbox(runtimeTarget).pending.reasons,
      ["runtime-cleanup-required"]
    );

    const adapter = new FileSchedulerStoreAdapter(store);
    const lateHook = {
      taskId: task.id,
      roleName: run.roleName,
      agentId: agent.id,
      adapterId: "codex",
      nativeSessionId: "native-1",
      turnId: delivered ? "turn-delivered" : "turn-prepared",
      runId: run.id
    };
    assert.equal(adapter.classifyRuntimeTurnCompleted(lateHook), "obsolete");
    assert.equal(adapter.observeRuntimeTurnCompleted({
      ...lateHook,
      summary: "Late result from the disposed Run."
    }, THIRD).disposition, "obsolete");
    assert.deepEqual(
      store.getTaskRoleSessionSet(task.id, run.roleName).sessions[agent.id].recentCompletedTurnIds,
      []
    );
    assert.equal(adapter.completeRuntimeCleanup(runtimeTarget, THIRD), true);
    const stopped = store.getTaskRoleSessionSet(task.id, run.roleName);
    assert.equal(stopped.sessions[agent.id].status, "stopped");
    assert.equal(stopped.sessions[agent.id].nativeSessionId, "native-1");
    assert.equal(adapter.classifyRuntimeTurnCompleted(lateHook), "obsolete");
  }
});

test("normal Codex explicit yield keeps its resumable runtime and Hook behavior", (t) => {
  const { store, task, agent } = fixture(t, { adapterId: "codex" });
  const run = prepareRun(store, {
    delivered: true,
    id: "agent-run-1",
    agentId: agent.id,
    adapterId: "codex"
  });

  runTaskCommand([
    "run", "yield", run.id, "--summary", "Normal explicit result."
  ], store, {
    now: () => THIRD,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "worker"
    }
  });

  const runtimeTarget = {
    kind: "role-runtime",
    taskId: task.id,
    roleName: run.roleName
  };
  assert.equal(store.getWorkMailbox(runtimeTarget), null);
  assert.equal(
    store.getTaskRoleSessionSet(task.id, run.roleName).sessions[agent.id].nativeSessionId,
    "native-1"
  );
  assert.equal(new FileSchedulerStoreAdapter(store).classifyRuntimeTurnCompleted({
    taskId: task.id,
    roleName: run.roleName,
    agentId: agent.id,
    adapterId: "codex",
    nativeSessionId: "native-1",
    turnId: "turn-normal-yield",
    runId: run.id
  }), "apply");
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
  assert.equal(adapter.classifyClaudeStopFailureEvent({
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
  assert.deepEqual(
    store.getWorkMailbox({
      kind: "role-runtime",
      taskId: task.id,
      roleName: run.roleName
    }).pending.reasons,
    ["runtime-cleanup-required"]
  );
});
