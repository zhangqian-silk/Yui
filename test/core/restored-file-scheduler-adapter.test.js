import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { runControllerSchedulerPass } from "../../dist/controller/controller.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { FileRuntimeEventProcessor } from "../../dist/controller/runtimeEventProcessor.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession,
  updateRoleAgentSessionStatus
} from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import {
  attachReviewRoundWorkspace,
  createReviewRound,
  startReviewRound
} from "../../dist/review/reviewRound.js";
import {
  createGlobalRole,
  createRole,
  createRoleAgentBinding,
  updateRole,
  updateRoleStatus
} from "../../dist/role/role.js";
import { yieldAgentRun } from "../../dist/run/agentRun.js";
import { createAgentRun as createTestAgentRun } from "../helpers/effectiveLaunch.js";
import { processActiveRoleRunDeliveries } from "../../dist/scheduler/activeRoleRunDelivery.js";
import { processLeaderWakeups } from "../../dist/scheduler/leaderWakeupProcessor.js";
import { processOperatorInputNotifications } from "../../dist/scheduler/operatorInputNotificationProcessor.js";
import {
  isRoleRunStalled,
  reconcileStalledRoleRuns,
  RUN_PROGRESS_EVENT,
  RUN_RECOVERED_EVENT
} from "../../dist/scheduler/roleRunStall.js";
import { createLeaderStallNotification } from "../../dist/scheduler/operatorNotification.js";
import { queueLeaderWakeup } from "../../dist/scheduler/wakeupQueue.js";
import {
  hasRuntimeCleanupObligation,
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../../dist/runtime/lifecycleReservation.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, archiveTask, completeTask, createTask } from "../../dist/task/task.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createProject } from "../../dist/repository/project.js";
import {
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-scheduler-store-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  const now = new Date("2026-07-19T00:00:00.000Z");
  const task = activateTask(createTask("task-1", "Run workflow", now, {
    projectBindings: [{ projectId: "project-1", directory: "Yui", baseRef: "main" }],
    cwd: home
  }), now);
  const role = createRole(
    task.id,
    "leader",
    [createRoleAgentBinding(
      { id: "codex", adapterId: "codex" },
      { adapterId: "codex", model: "gpt-test", effort: "high" }
    )],
    "codex",
    home,
    now
  );
  store.transaction((tx) => {
    tx.saveProject(createProject(
      "project-1",
      "Yui",
      home,
      { stable: "main", development: "main" },
      now
    ));
    tx.saveTask(task);
    tx.saveRole(task.id, role);
    queueLeaderWakeup(tx, task.id, "task-created", now);
  });
  return { home, store, task, role, now, adapter: new FileSchedulerStoreAdapter(store) };
}

function seedLeaderStall(store, task, run, now) {
  store.transaction((tx) => {
    const progressAt = run.createdAt;
    tx.saveEvent(task.id, createTaskEvent(
      tx.nextEventId(task.id),
      task.id,
      "run.stalled",
      {
        runId: run.id,
        roleName: run.roleName,
        kind: "execution-stalled",
        classification: "truly-stalled",
        progressAt,
        idleMs: "1800000",
        evidenceKey: "provider-neutral-test",
        status: "needs-attention"
      },
      now
    ));
    tx.saveOperatorNotification(createLeaderStallNotification(
      task.id,
      run.id,
      progressAt,
      "provider-neutral-test",
      now,
      null
    ));
  });
}

function schedulerSession(run, nativeSessionId, status = "ready") {
  return {
    agentId: run.effective.agentId,
    adapterId: run.effective.adapterId,
    nativeSessionId,
    status,
    effective: run.effective
  };
}

function createAgentRun(adapterOrRunId, ...args) {
  // Task-7's focused stall tests predate the effective-launch adapter helper;
  // keep their compact call form while using the current adapter-aware form
  // for the master lifecycle tests.
  if (typeof adapterOrRunId === "string") {
    return createTestAgentRun(adapterOrRunId, ...args);
  }
  const adapter = adapterOrRunId;
  const context = args[6] ?? {};
  if (context.effective !== undefined || context.agent !== undefined) {
    return createTestAgentRun(...args);
  }
  return createTestAgentRun(...args.slice(0, 6), {
    ...context,
    effective: adapter.getRole(args[1], args[2]).effective
  });
}

function preparedDeliveryFailureFixture(
  t,
  { roleName = "worker", purpose = "execution" } = {}
) {
  const fx = fixture(t);
  const { home, store, task, now, adapter } = fx;
  const role = roleName === "leader"
    ? fx.role
    : createRole(
        task.id,
        roleName,
        [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
        "codex",
        home,
        now
      );
  let item = null;
  let round = null;
  const runId = "agent-run-1";
  if (purpose === "execution" && roleName !== "leader") {
    item = updateWorkItemStatus(createWorkItem(
      "work-item-1",
      task.id,
      { title: `Execute ${roleName}`, writeProjectIds: ["project-1"] },
      now
    ), "running", now);
  } else if (purpose === "review") {
    item = updateWorkItemStatus(createWorkItem(
      "work-item-1",
      task.id,
      { title: `Review ${roleName}`, writeProjectIds: ["project-1"] },
      now
    ), "running", now);
    item = submitWorkItemCandidate(item, {
      summary: "candidate under review",
      source: { type: "direct" }
    }, now);
    const reviewBaseCommit = "b".repeat(40);
    const pendingRound = createReviewRound(
      "review-round-1",
      task.id,
      item.id,
      item.candidates[0].id,
      roleName,
      "leader",
      reviewBaseCommit,
      now
    );
    const reviewWorkspace = createManagedWorkspace({
      owner: { type: "review-round", taskId: task.id, reviewRoundId: pendingRound.id },
      root: join(home, "reviews", pendingRound.id),
      entries: [{
        projectId: "project-1",
        directory: "Yui",
        access: "write",
        path: join(home, "reviews", pendingRound.id, "Yui"),
        branch: `yui/${task.id}/${pendingRound.id}`,
        baseRef: reviewBaseCommit,
        baseCommit: reviewBaseCommit
      }]
    }, now);
    round = startReviewRound(
      attachReviewRoundWorkspace(pendingRound, reviewWorkspace),
      runId
    );
  }
  const effective = purpose === "review"
    ? resolveEffectiveLaunch({
        role,
        purpose,
        workspace: round.workspace,
        workItemWriteProjectIds: item.writeProjectIds,
        reviewRoundId: round.id,
        reviewBaseCommit: round.reviewBaseCommit
      })
    : resolveEffectiveLaunch({ role, purpose });
  const run = createAgentRun(
    adapter,
    runId,
    task.id,
    roleName,
    "new",
    `deliver ${roleName}`,
    now,
    {
      purpose,
      ...(item === null ? {} : { workItemId: item.id }),
      ...(round === null ? {} : { reviewRoundId: round.id }),
      ...(round?.workspace === undefined ? {} : { workspace: round.workspace }),
      effective
    }
  );
  const target = { kind: "role", taskId: task.id, roleName };
  store.transaction((tx) => {
    if (roleName !== "leader") tx.saveRole(task.id, role);
    tx.saveRole(task.id, updateRoleStatus(role, "running", now));
    if (item !== null) tx.saveWorkItem(task.id, item);
    if (round !== null) {
      tx.saveReviewRound(task.id, round);
      tx.saveManagedWorkspace(round.workspace);
    }
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, target, "run-dispatched", now, [
      { type: "run", taskId: task.id, id: run.id }
    ]);
  });
  const mailboxBatchId = `agent-run:${task.id}/${run.id}`;
  const claim = adapter.claimWorkMailbox({
    target,
    batchId: mailboxBatchId,
    owner: "controller",
    now,
    executionRef: { type: "run", taskId: task.id, id: run.id }
  });
  assert.notEqual(claim.status, "empty");
  const launchId = `runtime-test:generation:${roleName}`;
  adapter.reserveRuntimeLaunch({
    owner: { scope: "task", taskId: task.id, roleName },
    launchId,
    runId: run.id
  }, () => {}, now);
  const session = schedulerSession(run, `native-${roleName}`, "running");
  adapter.saveRoleRunPrepared({
    task: adapter.getTask(task.id),
    role: adapter.getRole(task.id, roleName),
    run,
    session,
    launchId,
    now
  });
  return {
    ...fx,
    role,
    run,
    item,
    round,
    target,
    launchId,
    session,
    failure: {
      taskId: task.id,
      roleName,
      agentId: run.effective.agentId,
      adapterId: run.effective.adapterId,
      runId: run.id,
      mailboxBatchId,
      nativeSessionId: session.nativeSessionId,
      launchId,
      now
    }
  };
}

test("FileSchedulerStoreAdapter commits Leader run, Role and fixed session together", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const before = JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision;
  const proposedRunId = adapter.peekNextAgentRunId(task.id);
  assert.equal(proposedRunId, "agent-run-1");
  assert.equal(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision, before);
  const run = createAgentRun(adapter, proposedRunId, task.id, role.name, "resume", "continue", now);

  const result = adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: schedulerSession(run, "thread-1"),
    wakeup: store.getPendingWakeup(task.id),
    now
  });

  assert.equal(result, "claimed");
  assert.equal(store.getPendingWakeup(task.id), null);
  const mailbox = store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: role.name });
  assert.equal(mailbox.processing.executionRef.type, "run");
  assert.equal(mailbox.processing.executionRef.id, run.id);
  assert.equal(mailbox.pending, null);
  assert.equal(store.getActiveAgentRun(task.id, role.name).id, run.id);
  assert.equal(store.getRole(task.id, role.name).status, "running");
  assert.equal(store.getRoleSession(task.id, role.name).nativeSessionId, "thread-1");
  assert.equal(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision, before + 1);
});

test("Leader delivery stall is routed through the existing Operator notification lane", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun(adapter, adapter.peekNextAgentRunId(task.id), task.id, role.name, "new", "continue", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  const result = await reconcileStalledRoleRuns(
    adapter,
    { async inspectRole() { return "present"; } },
    new Date(now.getTime() + 31 * 60_000),
    undefined,
    30 * 60_000
  );
  assert.equal(result[0].kind, "delivery-stalled");
  assert.equal(result[0].classification, "truly-stalled");
  const stalled = store.listEvents(task.id).find((event) => event.type === "run.stalled");
  assert.equal(stalled.payload.runId, run.id);
  assert.equal(stalled.payload.kind, "delivery-stalled");
  assert.equal(store.getPendingWakeup(task.id), null);
  assert.equal(store.getOperatorNotification(task.id).type, "leader-stalled");
  const operatorMailbox = store.getWorkMailbox({ kind: "operator" });
  assert.equal(operatorMailbox.pending.reasons.includes("leader-run-stalled"), true);
});

test("stale Leader stall persistence cannot outrun newer durable progress", (t) => {
  const { store, task, run, session, launchId, adapter, now } =
    preparedDeliveryFailureFixture(t, { roleName: "leader" });
  const deliveredAt = now.toISOString();
  store.saveActiveAgentRun({ ...run, pushedAt: deliveredAt, deliveredAt });
  const observedSession = { ...session, launchId };
  const progressAt = new Date(now.getTime() + 1_000).toISOString();
  store.saveEvent(task.id, createTaskEvent(
    store.nextEventId(task.id),
    task.id,
    RUN_PROGRESS_EVENT,
    { runId: run.id, roleName: run.roleName, progressAt },
    new Date(progressAt)
  ));

  assert.equal(adapter.recordRoleRunStall({
    taskId: task.id,
    roleName: run.roleName,
    runId: run.id,
    agentId: run.effective.agentId,
    adapterId: run.effective.adapterId,
    session: observedSession,
    kind: "execution-stalled",
    classification: "truly-stalled",
    progressAt: deliveredAt,
    idleMs: 30 * 60_000,
    evidenceKey: "stale-progress",
    now: new Date(now.getTime() + 31 * 60_000)
  }), "state-changed");
  assert.equal(
    store.listEvents(task.id).some((event) => event.type === "run.stalled"),
    false
  );
  assert.equal(store.getOperatorNotification(task.id), null);
});

test("stale stall persistence cannot cross a Session terminal transition", (t) => {
  const { store, task, run, session, launchId, adapter, now } =
    preparedDeliveryFailureFixture(t, { roleName: "worker" });
  const deliveredAt = now.toISOString();
  store.saveActiveAgentRun({ ...run, pushedAt: deliveredAt, deliveredAt });
  const observedSession = { ...session, launchId };
  const changedAt = new Date(now.getTime() + 1_000);
  const changedSessions = updateRoleAgentSessionStatus(
    store.getTaskRoleSessionSet(task.id, run.roleName),
    run.effective.agentId,
    "stopped",
    changedAt
  );
  store.saveTaskRoleSessionSet(changedSessions);

  assert.equal(adapter.recordRoleRunStall({
    taskId: task.id,
    roleName: run.roleName,
    runId: run.id,
    agentId: run.effective.agentId,
    adapterId: run.effective.adapterId,
    session: observedSession,
    kind: "execution-stalled",
    classification: "truly-stalled",
    progressAt: deliveredAt,
    idleMs: 30 * 60_000,
    evidenceKey: "stale-session-transition",
    now: new Date(now.getTime() + 31 * 60_000)
  }), "state-changed");
  assert.equal(
    store.listEvents(task.id).some((event) => event.type === "run.stalled"),
    false
  );
  assert.equal(
    store.getPendingWakeup(task.id)?.reasons.includes("role-run-stalled") ?? false,
    false
  );
});

test("advisory resource suppression survives a Controller restart for one Run/progress point", async (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const createdAt = new Date(now.getTime() - 60 * 60_000);
  const run = createAgentRun(
    adapter,
    "agent-run-77",
    task.id,
    role.name,
    "new",
    "resource restart",
    createdAt
  );
  const delivered = {
    ...run,
    pushedAt: createdAt.toISOString(),
    deliveredAt: createdAt.toISOString()
  };
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  }, run.effective.agentId, createdAt);
  sessions = recordRoleAgentSession(sessions, {
    agentId: run.effective.agentId,
    adapterId: run.effective.adapterId,
    nativeSessionId: "native-resource-restart",
    launchId: "launch-resource-restart",
    policy: "fixed",
    status: "running",
    effective: run.effective
  }, createdAt);
  store.transaction((tx) => {
    tx.saveAgentRun(delivered);
    tx.saveActiveAgentRun(delivered);
    tx.saveRole(task.id, updateRoleStatus(
      tx.getRole(task.id, role.name),
      "running",
      createdAt
    ));
    tx.saveTaskRoleSessionSet(sessions);
  });
  const delivery = {
    async inspectRole() { return "present"; },
    async inspectRoles(inputs) {
      return inputs.map((input) => ({
        taskId: input.taskId,
        roleName: input.roleName,
        status: "present",
        resource: {
          observedAt: new Date(now.getTime() - 1_000).toISOString(),
          progressAt: input.progressAt,
          identity: {
            taskId: input.taskId,
            roleName: input.roleName,
            runId: input.runId,
            agentId: input.agentId,
            adapterId: input.adapterId,
            nativeSessionId: input.nativeSessionId,
            launchId: input.launchId
          },
          active: true,
          changed: true,
          cpuTimeMs: 20,
          rssBytes: 4096
        }
      }));
    }
  };
  const first = await runControllerSchedulerPass(
    adapter,
    delivery,
    now,
    undefined,
    { kind: "full" },
    true,
    [],
    undefined,
    30 * 60_000,
    new Set()
  );
  assert.deepEqual(first.failedRunRefs, []);
  assert.equal(
    store.listEvents(task.id).filter((event) => event.type === "run.resource-suppressed").length,
    1
  );
  assert.equal(
    store.listEvents(task.id).filter((event) => event.type === "run.stalled").length,
    0
  );

  const restartedStore = new FileTaskStore(home);
  const restartedAdapter = new FileSchedulerStoreAdapter(restartedStore);
  const second = await runControllerSchedulerPass(
    restartedAdapter,
    delivery,
    now,
    undefined,
    { kind: "full" },
    true,
    [],
    undefined,
    30 * 60_000,
    new Set()
  );
  assert.deepEqual(second.failedRunRefs, []);
  assert.equal(
    restartedStore.listEvents(task.id).filter((event) => event.type === "run.resource-suppressed").length,
    1
  );
  assert.equal(
    restartedStore.listEvents(task.id).filter((event) => event.type === "run.stalled").length,
    1
  );
});

test("transport delivery records pushed without provider acceptance", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun(
    adapter,
    adapter.peekNextAgentRunId(task.id),
    task.id,
    role.name,
    "new",
    "continue",
    now
  );
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  seedLeaderStall(store, task, run, now);
  assert.equal(isRoleRunStalled(store.listEvents(task.id), run.id), true);

  const deliveredAt = new Date(now.getTime() + 1_000);
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    now: deliveredAt
  });

  assert.notEqual(store.getAgentRun(task.id, run.id).pushedAt, undefined);
  assert.equal(store.getAgentRun(task.id, run.id).deliveredAt, undefined);
  const events = store.listEvents(task.id);
  assert.equal(events.filter((event) => (
    event.type === "run.pushed" && event.payload.runId === run.id
  )).length, 1);
  assert.equal(isRoleRunStalled(events, run.id), true);
  assert.equal(store.getOperatorNotification(task.id).runId, run.id);

  const stateBeforeDuplicate = readFileSync(join(home, "state.json"), "utf8");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    now: new Date(deliveredAt.getTime() + 1_000)
  });
  assert.equal(store.listEvents(task.id).filter((event) => (
    event.type === "run.pushed" && event.payload.runId === run.id
  )).length, 1);
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), stateBeforeDuplicate);

  store.saveOperatorNotification(createLeaderStallNotification(
    task.id,
    "agent-run-2",
    deliveredAt.toISOString(),
    "newer-run",
    deliveredAt,
    null
  ));
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    now: new Date(deliveredAt.getTime() + 2_000)
  });
  assert.equal(store.getOperatorNotification(task.id).runId, "agent-run-2");
});

test("adapter delivery progress ignores a newer Work Item timestamp before acceptance", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const createdAt = new Date(now.getTime() - 60 * 60_000);
  const item = updateWorkItemStatus(createWorkItem(
    "work-item-101",
    task.id,
    { title: "Delivery boundary" },
    createdAt
  ), "running", new Date(now.getTime() - 60_000));
  const run = createAgentRun(
    adapter,
    "agent-run-105",
    task.id,
    role.name,
    "new",
    "continue",
    createdAt,
    { workItemId: item.id }
  );
  store.transaction((tx) => {
    tx.saveWorkItem(task.id, item);
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
  });

  const progress = adapter.getRunDurableProgress(task.id, role.name, run.id);
  assert.equal(progress.progressAt, createdAt.toISOString());
  assert.equal(progress.evidence, "work-review-integration");
  const result = await reconcileStalledRoleRuns(
    adapter,
    { async inspectRole() { return "present"; } },
    now,
    undefined,
    30 * 60_000
  );
  assert.equal(result[0].kind, "delivery-stalled");
});

test("native and Controller recovery clear only the matching Leader stall attention", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun(adapter, adapter.peekNextAgentRunId(task.id), task.id, role.name, "new", "continue", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: schedulerSession(run, "thread-native-recovery"),
    now
  });
  seedLeaderStall(store, task, run, now);

  const observed = adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-native-recovery",
    turnId: "turn-native-recovery",
    runId: run.id,
    summary: "native progress"
  }, now);
  assert.equal(observed.pendingRunId, run.id);
  assert.equal(store.getOperatorNotification(task.id), null);

  const duplicate = adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-native-recovery",
    turnId: "turn-native-recovery",
    runId: run.id,
    summary: "native progress"
  }, now);
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.getOperatorNotification(task.id), null);

  const controllerFixture = fixture(t);
  const controllerStore = controllerFixture.store;
  const controllerTask = controllerFixture.task;
  const controllerRole = controllerFixture.role;
  const controllerAdapter = controllerFixture.adapter;
  const controllerNow = controllerFixture.now;
  const controllerRun = {
    ...createAgentRun(
      controllerAdapter,
      controllerAdapter.peekNextAgentRunId(controllerTask.id),
      controllerTask.id,
      controllerRole.name,
      "new",
      "continue",
      controllerNow
    ),
    pushedAt: controllerNow.toISOString(),
    deliveredAt: controllerNow.toISOString()
  };
  assert.equal(controllerAdapter.saveLeaderDispatch({
    task: controllerTask,
    role: controllerAdapter.getRole(controllerTask.id, controllerRole.name),
    run: controllerRun,
    session: schedulerSession(controllerRun, "thread-native-recovery"),
    wakeup: controllerStore.getPendingWakeup(controllerTask.id),
    now: controllerNow
  }), "claimed");
  controllerAdapter.saveRoleRunDelivery({
    task: controllerTask,
    role: controllerAdapter.getRole(controllerTask.id, controllerRole.name),
    run: controllerRun,
    session: schedulerSession(controllerRun, "thread-native-recovery"),
    now: controllerNow
  });
  seedLeaderStall(controllerStore, controllerTask, controllerRun, controllerNow);
  assert.equal(controllerAdapter.saveExitedRoleRun({
    task: controllerTask,
    role: controllerAdapter.getRole(controllerTask.id, controllerRole.name),
    run: controllerRun,
    session: controllerAdapter.getRoleSession(controllerTask.id, controllerRole.name),
    summary: "controller liveness recovery",
    now: controllerNow
  }), "failed");
  assert.equal(controllerStore.getOperatorNotification(controllerTask.id), null);
  assert.equal(controllerStore.getActiveAgentRun(controllerTask.id, controllerRole.name), null);
});

test("Leader dispatch rejects a stale launch configuration snapshot", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const snapshot = adapter.getRole(task.id, role.name);
  const changedAt = new Date(now.getTime() + 1);
  store.saveRole(task.id, updateRole(role, {
    agentBindings: {
      ...role.agentBindings,
      codex: createRoleAgentBinding(
        { id: "codex", adapterId: "codex" },
        { adapterId: "codex", model: "gpt-new", effort: "medium" }
      )
    }
  }, changedAt));
  const run = createAgentRun(adapter, "agent-run-118", task.id, role.name, "resume", "continue", now);

  const result = adapter.saveLeaderDispatch({
    task,
    role: snapshot,
    run,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  });

  assert.equal(result, "state-changed");
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.notEqual(store.getPendingWakeup(task.id), null);
  assert.equal(adapter.getRole(task.id, role.name).model, "gpt-new");
  assert.equal(adapter.getRole(task.id, role.name).effort, "medium");
  assert.equal(adapter.getRole(task.id, role.name).workspace, home);

  const current = adapter.getRole(task.id, role.name);
  const mismatchedRun = createAgentRun(adapter,
    "agent-run-105",
    task.id,
    role.name,
    "resume",
    "continue",
    now,
    {
      agent: {
        agentId: current.activeAgentId,
        adapterId: current.adapterId,
        model: "gpt-test",
        effort: "high"
      }
    }
  );
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: current,
    run: mismatchedRun,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "state-changed");
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
});

test("a busy Leader claim is retried through active Run delivery without another wakeup", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  let sends = 0;
  const delivery = {
    async prepareRoleSession(input) {
      return { ...input, deliveryId: `delivery-${input.runId}`, sessionStarted: false };
    },
    async waitUntilReady(prepared) { return { prepared, session: null }; },
    async sendOnce() {
      sends += 1;
      return sends === 1 ? "busy" : "sent";
    }
  };

  const [claimed] = await processLeaderWakeups(adapter, delivery, now);
  assert.equal(claimed.reason, "not-ready");
  assert.equal(store.getPendingWakeup(task.id), null);
  const active = store.getActiveAgentRun(task.id, role.name);
  assert.equal(active.deliveredAt, undefined);
  assert.equal(active.effective.agentId, role.activeAgentId);
  assert.equal(active.effective.adapterId, "codex");
  assert.equal(active.effective.model, "gpt-test");
  assert.equal(active.effective.effort, "high");

  const [retried] = await processActiveRoleRunDeliveries(adapter, delivery, now);
  assert.equal(retried.status, "delivered");
  assert.equal(sends, 2);
  // Transport success records prompt-pushed; acceptance (deliveredAt) awaits an
  // exact provider-accepted fold, so it stays undefined after the push alone.
  assert.notEqual(store.getActiveAgentRun(task.id, role.name).pushedAt, undefined);
  assert.equal(store.getActiveAgentRun(task.id, role.name).deliveredAt, undefined);
});

test("desired drift does not block a wake delivered to the still-live Leader Session", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-before-drift"
  }, now);
  adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-before-drift",
    turnId: "turn-before-drift",
    summary: "idle before desired drift"
  }, now);
  const immutable = structuredClone(adapter.getRoleSession(task.id, role.name).effective);
  const changedAt = new Date(now.getTime() + 1);
  store.saveRole(task.id, updateRole(role, {
    agentBindings: {
      codex: createRoleAgentBinding(
        { id: "codex", adapterId: "codex" },
        { adapterId: "codex", model: "gpt-next", effort: "medium" }
      )
    }
  }, changedAt));

  let preparedInput;
  const [result] = await processLeaderWakeups(adapter, {
    async prepareRoleSession(input) {
      preparedInput = input;
      return { ...input, deliveryId: "wake-after-drift", sessionStarted: false };
    },
    async waitUntilReady(prepared) {
      return {
        prepared,
        session: { ...adapter.getRoleSession(task.id, role.name), status: "running" }
      };
    },
    async sendOnce() { return "sent"; }
  }, changedAt);

  assert.equal(result.status, "dispatched");
  assert.equal(preparedInput.mode, "resume");
  assert.equal(preparedInput.nativeSessionId, "thread-before-drift");
  assert.deepEqual(preparedInput.effective, immutable);
  assert.deepEqual(store.getActiveAgentRun(task.id, role.name).effective, immutable);
  assert.ok(store.getRole(task.id, role.name).launchRevision > immutable.sourceDesiredRevision);
});

test("Leader preparation owns its durable Run before awaiting tmux", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  let announcePreparation;
  let releasePreparation;
  const preparationStarted = new Promise((resolve) => { announcePreparation = resolve; });
  const preparationBlocked = new Promise((resolve) => { releasePreparation = resolve; });
  const delivery = {
    async prepareRoleSession(input) {
      announcePreparation();
      return { ...input, deliveryId: `delivery-${input.runId}`, sessionStarted: true };
    },
    async waitUntilReady(prepared) {
      await preparationBlocked;
      return { prepared, session: null };
    },
    async sendOnce() { return "sent"; }
  };

  const processing = processLeaderWakeups(adapter, delivery, now);
  await preparationStarted;

  const claimed = store.getActiveAgentRun(task.id, role.name);
  assert.notEqual(claimed, null);
  assert.equal(store.getPendingWakeup(task.id), null);
  assert.throws(
    () => store.saveActiveAgentRun(createAgentRun(adapter,
      "agent-run-119",
      task.id,
      role.name,
      "new",
      "concurrent work",
      new Date(now.getTime() + 1)
    )),
    /already has an active Agent run/
  );

  releasePreparation();
  assert.equal((await processing)[0].status, "dispatched");
});

test("Leader dispatch rejects a Run id that already exists in Task history", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const historic = createAgentRun(adapter,
    "agent-run-101",
    task.id,
    role.name,
    "new",
    "historic",
    now
  );
  store.saveAgentRun(historic);

  const result = adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run: createAgentRun(adapter,
      historic.id,
      task.id,
      role.name,
      "new",
      "replacement",
      new Date(now.getTime() + 1)
    ),
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  });

  assert.equal(result, "state-changed");
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.notEqual(store.getPendingWakeup(task.id), null);
  assert.equal(store.getAgentRun(task.id, historic.id).input, "historic");
});

test("prepare failure terminates a claimed Run with an existing fixed session", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-existing"
  }, now);
  adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-existing",
    turnId: "turn-before-wakeup",
    summary: "idle"
  }, now);
  assert.equal(adapter.getRoleSession(task.id, role.name).status, "ready");

  const [result] = await processLeaderWakeups(adapter, {
    async prepareRoleSession() {
      throw new Error("tmux resume failed");
    }
  }, now);

  assert.equal(result.status, "failed");
  assert.match(result.error, /tmux resume failed/);
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.notEqual(store.getPendingWakeup(task.id), null);
  assert.equal(store.getRole(task.id, role.name).status, "failed");
  assert.equal(store.getRoleSession(task.id, role.name).status, "broken");
  assert.match(store.getLeaderFailure(task.id).message, /tmux resume failed/);
});

test("a stale Leader preparation failure cannot overwrite a newer active Run", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const wakeup = store.getPendingWakeup(task.id);
  const replacement = createAgentRun(adapter,
    "agent-run-102",
    task.id,
    role.name,
    "new",
    "newer work",
    new Date(now.getTime() + 1_000)
  );
  store.saveActiveAgentRun(replacement);

  const result = adapter.saveLeaderDispatchFailure({
    task,
    role: adapter.getRole(task.id, role.name),
    session: null,
    claimed: {
      run: createAgentRun(adapter,
        "agent-run-118",
        task.id,
        role.name,
        "new",
        "stale work",
        now
      ),
      wakeup
    },
    failure: {
      schemaVersion: 1,
      taskId: task.id,
      nativeSessionId: "(unregistered)",
      message: "stale preparation failed",
      attemptCount: 1,
      firstFailedAt: now.toISOString(),
      lastFailedAt: now.toISOString()
    },
    notification: {
      schemaVersion: 1,
      taskId: task.id,
      type: "leader-recovery-failed",
      message: "stale preparation failed",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    },
    now
  });

  assert.equal(result, "state-changed");
  assert.equal(store.getActiveAgentRun(task.id, role.name).id, replacement.id);
  assert.equal(store.getRole(task.id, role.name).status, "idle");
  assert.equal(store.getLeaderFailure(task.id), null);
  assert.equal(store.getOperatorNotification(task.id), null);
  assert.deepEqual(store.getPendingWakeup(task.id), wakeup);
});

test("runtime Turn completion waits for the two-second grace deadline before closing a Leader Run", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun(adapter, adapter.peekNextAgentRunId(task.id), task.id, role.name, "new", "continue", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: schedulerSession(run, "thread-grace"),
    now
  });
  const observed = adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-grace",
    turnId: "turn-grace",
    runId: run.id,
    summary: "I forgot to yield."
  }, now);

  assert.equal(observed.pendingRunId, run.id);
  assert.equal(store.getActiveAgentRun(task.id, role.name).id, run.id);
  assert.equal(store.getRoleSession(task.id, role.name).status, "running");
  assert.deepEqual(
    adapter.resolveDueRuntimeTurnCompletions(new Date(now.getTime() + 1_999)),
    []
  );
  assert.deepEqual(
    adapter.resolveDueRuntimeTurnCompletions(new Date(now.getTime() + 2_000)),
    [`${task.id}/${run.id}`]
  );
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.equal(store.getAgentRun(task.id, run.id).status, "yielded");
  assert.equal(store.getRoleSession(task.id, role.name).status, "ready");
  assert.equal(store.getTaskRoleSessionSet(task.id, role.name).inFlight, null);
  assert.equal(store.getTask(task.id).status, "active");
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["leader-turn-unclosed"]);
});

test("an unrelated Hook cannot prove that a prepared Leader Run was delivered", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun(adapter, adapter.peekNextAgentRunId(task.id), task.id, role.name, "new", "continue", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: schedulerSession(run, "thread-prepared"),
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");

  const observed = adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-prepared",
    turnId: "turn-unrelated",
    runId: "agent-run-114",
    summary: "This was an unrelated native turn."
  }, now);

  assert.equal(observed.pendingRunId, undefined);
  assert.equal(store.getActiveAgentRun(task.id, role.name).deliveredAt, undefined);
  const sessions = store.getTaskRoleSessionSet(task.id, role.name);
  assert.equal(sessions.inFlight.runId, run.id);
  assert.equal(sessions.inFlight.deliveredAt, undefined);
  assert.equal(sessions.pendingTurnCompletion, null);
  assert.deepEqual(
    sessions.sessions[role.activeAgentId].recentCompletedTurnIds,
    []
  );
});

test("a matching Hook proves delivery across the receipt persistence crash window", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun(adapter, adapter.peekNextAgentRunId(task.id), task.id, role.name, "new", "continue", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: schedulerSession(run, "thread-crash-window"),
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  const inbox = new FileRuntimeEventInbox(home, () => now);
  inbox.enqueueTurnCompleted({
    scope: "task",
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-crash-window",
    turnId: "turn-after-send",
    runId: run.id,
    summary: "sent before Controller persisted delivery"
  });
  const processor = new FileRuntimeEventProcessor(inbox, adapter);

  const beforeReceipt = processor.drain(now);
  assert.equal(beforeReceipt.acknowledgedEventIds.length, 1);
  assert.equal(beforeReceipt.deferred.length, 0);
  assert.equal(inbox.list().length, 0);
  // A native turn completion proves the prompt was pushed, not that the provider
  // accepted it: it records pushedAt, never deliveredAt (only a provider-accepted
  // fold may do that).
  assert.notEqual(store.getActiveAgentRun(task.id, role.name).pushedAt, undefined);
  assert.equal(store.getActiveAgentRun(task.id, role.name).deliveredAt, undefined);
  assert.equal(
    store.getTaskRoleSessionSet(task.id, role.name).pendingTurnCompletion.runId,
    run.id
  );
});

test("a Hook replay is idempotent after state commit succeeds and inbox ack crashes", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun(adapter, adapter.peekNextAgentRunId(task.id), task.id, role.name, "new", "continue", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: schedulerSession(run, "thread-ack-crash"),
    now
  });
  const inbox = new FileRuntimeEventInbox(home, () => now);
  inbox.enqueueTurnCompleted({
    scope: "task",
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-ack-crash",
    turnId: "turn-ack-crash",
    runId: run.id,
    summary: "state committed before ack"
  });
  const crashingProcessor = new FileRuntimeEventProcessor({
    list: () => inbox.list(),
    acknowledge() {
      throw new Error("process crashed before inbox ack");
    }
  }, adapter);

  const first = crashingProcessor.drain(now);
  assert.equal(first.failed.length, 1);
  const pendingBeforeRestart = store
    .getTaskRoleSessionSet(task.id, role.name)
    .pendingTurnCompletion;
  const stateBeforeReplay = readFileSync(join(home, "state.json"), "utf8");
  assert.equal(inbox.list().length, 1);

  const restartedStore = new FileTaskStore(home);
  const restartedAdapter = new FileSchedulerStoreAdapter(restartedStore);
  const replayed = new FileRuntimeEventProcessor(inbox, restartedAdapter).drain(
    new Date(now.getTime() + 500)
  );

  assert.equal(replayed.failed.length, 0);
  assert.equal(replayed.acknowledgedEventIds.length, 1);
  assert.deepEqual(
    restartedStore.getTaskRoleSessionSet(task.id, role.name).pendingTurnCompletion,
    pendingBeforeRestart
  );
  assert.equal(readFileSync(join(home, "state.json"), "utf8"), stateBeforeReplay);
  assert.deepEqual(inbox.list(), []);
  assert.deepEqual(
    restartedAdapter.resolveDueRuntimeTurnCompletions(
      new Date(now.getTime() + 2_000)
    ),
    [`${task.id}/${run.id}`]
  );
  assert.equal(restartedStore.getActiveAgentRun(task.id, role.name), null);
});

test("an obsolete Hook cannot claim the native session of the current Run", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun(adapter, adapter.peekNextAgentRunId(task.id), task.id, role.name, "new", "continue", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    now
  });
  adapter.reserveRuntimeLaunch({
    owner: {
      scope: "task",
      taskId: task.id,
      roleName: role.name
    },
    launchId: "launch-current-native"
  }, () => {});
  const times = [
    now,
    new Date(now.getTime() + 1)
  ];
  const inbox = new FileRuntimeEventInbox(home, () => times.shift());
  const common = {
    scope: "task",
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    launchId: "launch-current-native",
    summary: "done"
  };
  inbox.enqueueTurnCompleted({
    ...common,
    nativeSessionId: "thread-obsolete",
    turnId: "turn-obsolete",
    runId: "agent-run-109"
  });
  inbox.enqueueTurnCompleted({
    ...common,
    nativeSessionId: "thread-current",
    turnId: "turn-current",
    runId: run.id
  });
  assert.equal(
    adapter.classifyRuntimeTurnCompleted({
      ...common,
      nativeSessionId: "thread-current",
      turnId: "turn-current",
      runId: run.id
    }),
    "apply"
  );
  assert.equal(inbox.list()[1].launchId, "launch-current-native");

  const result = new FileRuntimeEventProcessor(inbox, adapter).drain(
    new Date(now.getTime() + 2)
  );

  assert.equal(result.failed.length, 0);
  assert.equal(result.acknowledgedEventIds.length, 2);
  const sessions = store.getTaskRoleSessionSet(task.id, role.name);
  assert.equal(sessions.sessions[role.activeAgentId].nativeSessionId, "thread-current");
  assert.equal(sessions.pendingTurnCompletion.runId, run.id);
  assert.deepEqual(inbox.list(), []);
});

for (const terminalStatus of ["stopped", "broken"]) {
  test(`a late Hook preserves a ${terminalStatus} native session`, (t) => {
    const { store, task, role, now, adapter } = fixture(t);
    adapter.recordRuntimeNativeSession({
      taskId: task.id,
      roleName: role.name,
      agentId: role.activeAgentId,
      adapterId: "codex",
      nativeSessionId: `thread-${terminalStatus}`
    }, now);
    store.transaction((tx) => {
      const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
      tx.saveTaskRoleSessionSet(updateRoleAgentSessionStatus(
        sessions,
        role.activeAgentId,
        terminalStatus,
        new Date(now.getTime() + 1)
      ));
    });

    adapter.observeRuntimeTurnCompleted({
      taskId: task.id,
      roleName: role.name,
      agentId: role.activeAgentId,
      adapterId: "codex",
      nativeSessionId: `thread-${terminalStatus}`,
      turnId: `turn-late-${terminalStatus}`,
      summary: "late native completion"
    }, new Date(now.getTime() + 2));

    const session = store.getRoleSession(task.id, role.name);
    assert.equal(session.status, terminalStatus);
    assert.deepEqual(session.recentCompletedTurnIds, [`turn-late-${terminalStatus}`]);
  });
}

for (const terminalStatus of ["stopped", "broken"]) {
  test(`a late global Hook preserves a ${terminalStatus} native session`, (t) => {
    const { home, store, now, adapter } = fixture(t);
    const role = createGlobalRole(
      `operator-${terminalStatus}`,
      [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
      "codex",
      home,
      now
    );
    store.saveGlobalRole(role);
    adapter.recordGlobalRuntimeNativeSession({
      roleName: role.name,
      agentId: role.activeAgentId,
      adapterId: "codex",
      nativeSessionId: `thread-global-${terminalStatus}`
    }, now);
    store.transaction((tx) => {
      const sessions = tx.getGlobalRoleSessionSet(role.name);
      tx.saveGlobalRoleSessionSet(updateRoleAgentSessionStatus(
        sessions,
        role.activeAgentId,
        terminalStatus,
        new Date(now.getTime() + 1)
      ));
    });

    adapter.observeGlobalRuntimeTurnCompleted({
      roleName: role.name,
      agentId: role.activeAgentId,
      adapterId: "codex",
      nativeSessionId: `thread-global-${terminalStatus}`,
      turnId: `turn-global-late-${terminalStatus}`
    }, new Date(now.getTime() + 2));

    const session = store.getGlobalRoleSessionSet(role.name).sessions[role.activeAgentId];
    assert.equal(session.status, terminalStatus);
    assert.deepEqual(
      session.recentCompletedTurnIds,
      [`turn-global-late-${terminalStatus}`]
    );
  });
}

test("Operator notification delivery requires a structured ready Session", (t) => {
  const { home, store, now, adapter } = fixture(t);
  const role = createGlobalRole(
    "operator",
    [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
    "codex",
    home,
    now
  );
  store.saveGlobalRole(role);
  assert.equal(adapter.getOperatorDeliveryTarget(), null);

  adapter.recordGlobalRuntimeNativeSession({
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-operator"
  }, now);
  assert.equal(adapter.getOperatorDeliveryTarget(), null);

  adapter.observeGlobalRuntimeTurnCompleted({
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-operator",
    turnId: "turn-operator-ready"
  }, new Date(now.getTime() + 1));
  assert.deepEqual(adapter.getOperatorDeliveryTarget(), {
    roleName: "operator",
    adapterId: "codex"
  });
});

test("a Hook classified for Run A cannot close Run B after an intervening dispatch", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const first = createAgentRun(adapter, adapter.peekNextAgentRunId(task.id), task.id, role.name, "new", "A", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run: first,
    session: schedulerSession(first, "thread-race"),
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run: first,
    session: store.getRoleSession(task.id, role.name),
    now
  });
  const event = {
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-race",
    turnId: "turn-race-a",
    runId: first.id,
    summary: "A ended"
  };
  assert.equal(adapter.classifyRuntimeTurnCompleted(event), "apply");

  adapter.recordRuntimeTurnCompleted({
    ...event,
    expectedRunId: first.id
  }, now);
  const second = createAgentRun(adapter, adapter.peekNextAgentRunId(task.id), task.id, role.name, "resume", "B", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run: second,
    session: store.getRoleSession(task.id, role.name),
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run: second,
    session: store.getRoleSession(task.id, role.name),
    now
  });

  adapter.observeRuntimeTurnCompleted(event, new Date(now.getTime() + 1_000));

  assert.equal(store.getActiveAgentRun(task.id, role.name).id, second.id);
  assert.equal(
    store.getTaskRoleSessionSet(task.id, role.name).pendingTurnCompletion,
    null
  );
});

test("a Hook for an older Run is acknowledged without closing the fresh Run", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun(adapter, adapter.peekNextAgentRunId(task.id), task.id, role.name, "new", "continue", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: schedulerSession(run, "thread-fresh-send"),
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  const inbox = new FileRuntimeEventInbox(home, () => now);
  inbox.enqueueTurnCompleted({
    scope: "task",
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-fresh-send",
    turnId: "turn-before-send",
    runId: "agent-run-112",
    summary: "old turn"
  });
  const processor = new FileRuntimeEventProcessor(inbox, adapter);
  const beforeSend = processor.drain(now);

  assert.equal(beforeSend.deferred.length, 0);
  assert.equal(beforeSend.acknowledgedEventIds.length, 1);
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: schedulerSession(run, "thread-fresh-send"),
    now
  });
  assert.equal(processor.drain(now).acknowledgedEventIds.length, 0);
  assert.equal(store.getTaskRoleSessionSet(task.id, role.name).pendingTurnCompletion, null);
});

test("a second Hook waits behind the first grace closure instead of poisoning reconciliation", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun(adapter, adapter.peekNextAgentRunId(task.id), task.id, role.name, "new", "continue", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: schedulerSession(run, "thread-two-hooks"),
    now
  });
  const inbox = new FileRuntimeEventInbox(home, () => now);
  const common = {
    scope: "task",
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-two-hooks",
    runId: run.id,
    summary: "done"
  };
  inbox.enqueueTurnCompleted({ ...common, turnId: "turn-first" });
  const processor = new FileRuntimeEventProcessor(inbox, adapter);
  assert.equal(processor.drain(now).failed.length, 0);
  inbox.enqueueTurnCompleted({ ...common, turnId: "turn-second" });

  const blocked = processor.drain(new Date(now.getTime() + 1_000));
  assert.equal(blocked.failed.length, 0);
  assert.deepEqual(blocked.deferred.map((event) => event.turnId), ["turn-second"]);
  adapter.resolveDueRuntimeTurnCompletions(new Date(now.getTime() + 2_000));
  const settled = processor.drain(new Date(now.getTime() + 2_000));

  assert.equal(settled.failed.length, 0);
  assert.equal(inbox.list().length, 0);
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
});

test("native completion failure for a Leader WorkItem clears only matching stall attention", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const item = updateWorkItemStatus(createWorkItem(
    "work-item-102",
    task.id,
    { title: "Native failure" },
    now
  ), "running", now);
  const run = createAgentRun(
    adapter,
    adapter.peekNextAgentRunId(task.id),
    task.id,
    role.name,
    "new",
    "continue",
    now,
    { workItemId: item.id }
  );
  store.transaction((tx) => {
    tx.saveWorkItem(task.id, item);
  });
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: schedulerSession(run, "thread-native-work-item"),
    now
  });
  seedLeaderStall(store, task, run, now);

  const completedAt = new Date(now.getTime() + 1_000);
  const completion = adapter.recordRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-native-work-item",
    turnId: "turn-native-work-item",
    expectedRunId: run.id,
    summary: "WorkItem completion did not yield the Run.",
    origin: "native"
  }, completedAt);

  assert.equal(completion.finalizedRunId, run.id);
  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.equal(store.getWorkItem(task.id, item.id).status, "failed");
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.equal(store.getTaskRoleSessionSet(task.id, role.name).inFlight, null);
  assert.equal(store.getOperatorNotification(task.id), null);

  store.saveOperatorNotification(createLeaderStallNotification(
    task.id,
    "agent-run-2",
    completedAt.toISOString(),
    "newer-run",
    completedAt,
    null
  ));
  const duplicate = adapter.recordRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-native-work-item",
    turnId: "turn-native-work-item",
    expectedRunId: run.id,
    summary: "duplicate completion",
    origin: "native"
  }, new Date(completedAt.getTime() + 1_000));
  assert.equal(duplicate.finalizedRunId, undefined);
  assert.equal(store.getOperatorNotification(task.id).runId, "agent-run-2");
});

test("a quiescent result-driven Leader Turn is recovered instead of inferring Task completion", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  store.transaction((tx) => {
    tx.clearPendingWakeup(task.id);
    enqueueWork(
      tx,
      { kind: "role", taskId: task.id, roleName: role.name },
      "role-result",
      now,
      [{ type: "task", id: task.id }]
    );
  });
  const run = createAgentRun(adapter, adapter.peekNextAgentRunId(task.id), task.id, role.name, "new", "synthesize", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: schedulerSession(run, "thread-result"),
    now
  });
  adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-result",
    turnId: "turn-result",
    runId: run.id,
    summary: "The synthesis looks complete, but no terminal command was issued."
  }, now);

  adapter.resolveDueRuntimeTurnCompletions(new Date(now.getTime() + 2_000));

  assert.equal(store.getTask(task.id).status, "active");
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["leader-turn-unclosed"]);
  assert.equal(
    store.listEvents(task.id).some((event) => event.type === "task.completed"),
    false
  );
});

test("a repeated unclosed Leader recovery escalates and notifies Operator once", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  store.transaction((tx) => {
    tx.clearPendingWakeup(task.id);
    enqueueWork(
      tx,
      { kind: "role", taskId: task.id, roleName: role.name },
      "leader-turn-unclosed",
      now,
      [{ type: "task", id: task.id }]
    );
  });
  const run = createAgentRun(adapter, adapter.peekNextAgentRunId(task.id), task.id, role.name, "new", "recover", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: schedulerSession(run, "thread-recovery"),
    now
  });
  adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-recovery",
    turnId: "turn-recovery",
    runId: run.id,
    summary: "The recovery Turn also forgot to close."
  }, now);

  adapter.resolveDueRuntimeTurnCompletions(new Date(now.getTime() + 2_000));

  assert.equal(store.getPendingWakeup(task.id), null);
  assert.equal(store.getLeaderFailure(task.id).attemptCount, 1);
  assert.equal(store.getOperatorNotification(task.id).type, "leader-recovery-failed");
  assert.deepEqual(
    store.getWorkMailbox({ kind: "operator" }).pending.reasons,
    ["leader-recovery-failed"]
  );

  const deliveries = [];
  adapter.getOperatorDeliveryTarget = () => ({
    roleName: "operator",
    adapterId: "codex"
  });
  const result = await processOperatorInputNotifications(adapter, {
    async notifyOperatorInputOnce(input) {
      deliveries.push(input);
      return "sent";
    }
  });
  assert.deepEqual(result, [{
    recoveryTaskId: task.id,
    taskId: task.id,
    status: "sent"
  }]);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].receiptId, /^leader-recovery:task-1:/);
  assert.match(deliveries[0].text, /needs user attention/i);
  assert.equal(store.getWorkMailbox({ kind: "operator" }).processing, null);
});

test("a partial low-level Run mutation remains fenced until its matching Hook repairs it", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const first = createAgentRun(adapter, adapter.peekNextAgentRunId(task.id), task.id, role.name, "new", "first", now);
  assert.equal(adapter.saveLeaderDispatch({
    task,
    role: adapter.getRole(task.id, role.name),
    run: first,
    session: null,
    wakeup: store.getPendingWakeup(task.id),
    now
  }), "claimed");
  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run: first,
    session: schedulerSession(first, "thread-first"),
    now
  });
  store.transaction((tx) => {
    tx.saveAgentRun(yieldAgentRun(tx.getActiveAgentRun(task.id, role.name), "done", now));
    tx.clearActiveAgentRun(task.id, role.name);
  });

  const second = createAgentRun(adapter, "agent-run-121", task.id, role.name, "resume", "second", now);
  assert.throws(
    () => store.saveActiveAgentRun(second),
    /still has an in-flight Turn/u
  );

  adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-first",
    turnId: "turn-first",
    runId: first.id,
    summary: "done"
  }, now);
  assert.doesNotThrow(() => store.saveActiveAgentRun(second));
});

test("generic mailbox claim and release preserve signals queued during processing", (t) => {
  const { store, task, now, adapter } = fixture(t);
  const target = { kind: "task", taskId: task.id };
  enqueueWork(store, target, "task-activated", now);

  const claim = adapter.claimWorkMailbox({
    target,
    batchId: "batch-1",
    owner: "controller",
    now
  });
  assert.equal(claim.status, "claimed");

  enqueueWork(store, target, "workspace-ready", new Date(now.getTime() + 1_000));
  assert.equal(adapter.releaseWorkMailbox(target, "batch-1"), true);
  const released = store.getWorkMailbox(target);
  assert.equal(released.processing, null);
  assert.deepEqual(released.pending.reasons, ["task-activated", "workspace-ready"]);
  assert.equal(released.pending.requestCount, 2);
});

test("Worker delivery claims and binds its mailbox before external work, then fails deterministically before send", async (t) => {
  const { store, task, now, adapter } = fixture(t);
  const worker = createRole(
    task.id,
    "worker",
    [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
    "codex",
    "/repo",
    now
  );
  const run = createAgentRun(
    adapter,
    "agent-run-122",
    task.id,
    worker.name,
    "new",
    "work",
    now,
    { effective: resolveEffectiveLaunch({ role: worker, purpose: "execution" }) }
  );
  const target = { kind: "role", taskId: task.id, roleName: worker.name };
  store.transaction((tx) => {
    tx.saveRole(task.id, worker);
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, target, "run-dispatched", now, [
      { type: "run", taskId: task.id, id: run.id }
    ]);
  });
  let observedBound = false;
  const forgotten = [];
  const delivery = {
    async prepareRoleSession() {
      const processing = store.getWorkMailbox(target).processing;
      observedBound = processing?.executionRef?.type === "run"
        && processing.executionRef.id === run.id;
      throw new Error("launch failed");
    },
    async waitUntilReady() { throw new Error("unexpected readiness"); },
    async sendOnce() { throw new Error("unexpected send"); },
    forgetPrepared(input) { forgotten.push(input); },
    async inspectRole() { return "present"; },
    async stopTask() { return true; }
  };

  const [result] = await processActiveRoleRunDeliveries(adapter, delivery, now);

  assert.equal(observedBound, true);
  assert.equal(result.status, "failed");
  assert.deepEqual(forgotten, [{
    taskId: task.id,
    roleName: worker.name,
    runId: run.id
  }]);
  const completed = store.getWorkMailbox(target);
  assert.equal(completed.processing, null);
  assert.equal(completed.pending, null);
  assert.equal(store.getActiveAgentRun(task.id, worker.name), null);
  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.ok(store.getPendingWakeup(task.id).reasons.includes("role-run-failed"));
});

test("Worker busy retry persists and reuses the hosted native session before delivery", async (t) => {
  const { store, task, now, adapter } = fixture(t);
  const worker = createRole(
    task.id,
    "worker",
    [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
    "codex",
    "/repo",
    now
  );
  const run = createAgentRun(
    adapter,
    "agent-run-122",
    task.id,
    worker.name,
    "new",
    "work",
    now,
    { effective: resolveEffectiveLaunch({ role: worker, purpose: "execution" }) }
  );
  const target = { kind: "role", taskId: task.id, roleName: worker.name };
  store.transaction((tx) => {
    tx.saveRole(task.id, worker);
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, target, "run-dispatched", now, [
      { type: "run", taskId: task.id, id: run.id }
    ]);
  });
  let sends = 0;
  const delivery = {
    async prepareRoleSession(input) {
      return { ...input, deliveryId: "delivery-worker" };
    },
    async waitUntilReady(prepared) {
      const persisted = store.getRoleSession(task.id, worker.name)?.nativeSessionId;
      return {
        prepared,
        session: schedulerSession(run, persisted ?? "hosted-native-b")
      };
    },
    async sendOnce() { sends += 1; return sends === 1 ? "busy" : "sent"; },
    async inspectRole() { return "present"; },
    async stopTask() { return true; }
  };

  assert.equal((await processActiveRoleRunDeliveries(adapter, delivery, now))[0].reason, "not-ready");
  assert.equal(store.getRoleSession(task.id, worker.name).nativeSessionId, "hosted-native-b");
  assert.equal(store.getActiveAgentRun(task.id, worker.name).deliveredAt, undefined);

  const [retried] = await processActiveRoleRunDeliveries(adapter, delivery, now);
  assert.equal(retried.status, "delivered", retried.error);
  assert.equal(store.getRoleSession(task.id, worker.name).nativeSessionId, "hosted-native-b");
  assert.notEqual(store.getActiveAgentRun(task.id, worker.name).pushedAt, undefined);
  assert.equal(store.getActiveAgentRun(task.id, worker.name).deliveredAt, undefined);
});

test("Worker delivery exhaustion atomically fails the exact Run and queues cleanup plus Leader work", (t) => {
  const fx = preparedDeliveryFailureFixture(t);
  const runtimeTarget = runtimeLifecycleTarget({
    scope: "task",
    taskId: fx.task.id,
    roleName: fx.role.name
  });
  const reserved = fx.store.getWorkMailbox(runtimeTarget);
  assert.equal(isRuntimeLaunchReservation(reserved.processing, fx.launchId), true);
  assert.deepEqual(reserved.processing.executionRef, {
    type: "run",
    taskId: fx.task.id,
    id: fx.run.id
  });

  assert.equal(
    fx.adapter.saveRoleRunDeliveryFailure(fx.failure),
    "failed"
  );

  const terminal = fx.store.getAgentRun(fx.task.id, fx.run.id);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.deliveredAt, undefined);
  assert.equal(fx.store.getActiveAgentRun(fx.task.id, fx.role.name), null);
  assert.equal(fx.store.getWorkItem(fx.task.id, fx.item.id).status, "failed");
  assert.equal(fx.store.getWorkItem(fx.task.id, fx.item.id).candidates.length, 0);
  assert.equal(fx.store.getRole(fx.task.id, fx.role.name).status, "idle");
  assert.equal(fx.store.getRoleSession(fx.task.id, fx.role.name).status, "ready");
  assert.equal(fx.store.getWorkMailbox(fx.target).processing, null);
  assert.equal(hasRuntimeCleanupObligation(
    fx.store.getWorkMailbox(runtimeTarget)
  ), true);
  assert.ok(fx.store.getPendingWakeup(fx.task.id).reasons.includes("role-run-failed"));
  assert.ok(fx.store.listEvents(fx.task.id).some(
    (event) => event.type === "runtime.role-delivery-failed"
  ));
  const messageCount = fx.store.listMessages(fx.task.id).length;

  assert.equal(
    fx.adapter.saveRoleRunDeliveryFailure(fx.failure),
    "state-changed"
  );
  assert.equal(fx.store.listMessages(fx.task.id).length, messageCount);
});

test("Reviewer delivery exhaustion fails only its ReviewRound and queues the Leader", (t) => {
  const fx = preparedDeliveryFailureFixture(t, {
    roleName: "reviewer",
    purpose: "review"
  });

  assert.equal(
    fx.adapter.saveRoleRunDeliveryFailure(fx.failure),
    "failed"
  );

  assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).status, "failed");
  assert.equal(
    fx.store.getReviewRound(fx.task.id, fx.round.id).status,
    "failed"
  );
  assert.equal(
    fx.store.getWorkItem(fx.task.id, fx.item.id).status,
    "awaiting_acceptance"
  );
  assert.equal(
    fx.store.getWorkItem(fx.task.id, fx.item.id).candidates.length,
    1
  );
  assert.ok(fx.store.getPendingWakeup(fx.task.id).reasons.includes("review-failed"));
});

test("Leader delivery exhaustion records Operator recovery and stops its owned runtime before session exit", async (t) => {
  const fx = preparedDeliveryFailureFixture(t, { roleName: "leader" });
  const runtimeTarget = runtimeLifecycleTarget({
    scope: "task",
    taskId: fx.task.id,
    roleName: fx.role.name
  });

  assert.equal(
    fx.adapter.saveRoleRunDeliveryFailure(fx.failure),
    "failed"
  );
  assert.equal(fx.store.getRole(fx.task.id, fx.role.name).status, "failed");
  assert.equal(
    fx.store.getLeaderFailure(fx.task.id).nativeSessionId,
    fx.session.nativeSessionId
  );
  assert.equal(
    fx.store.getOperatorNotification(fx.task.id).type,
    "leader-recovery-failed"
  );
  assert.ok(
    fx.store.getWorkMailbox({ kind: "operator" }).pending.reasons.includes(
      "leader-run-failed"
    )
  );
  assert.equal(fx.store.getRoleSession(fx.task.id, fx.role.name).status, "ready");
  assert.equal(hasRuntimeCleanupObligation(
    fx.store.getWorkMailbox(runtimeTarget)
  ), true);

  let stopCalls = 0;
  const forgotten = [];
  await runControllerSchedulerPass(
    fx.adapter,
    {
      async prepareRoleSession() { throw new Error("unused"); },
      async waitUntilReady() { throw new Error("unused"); },
      async sendOnce() { throw new Error("unused"); },
      async inspectRole() { return "present"; },
      async stopTask() { return false; },
      forgetPrepared(input) { forgotten.push(input); }
    },
    new Date(fx.now.getTime() + 1_000),
    undefined,
    { kind: "dirty", keys: [`role:${fx.task.id}/${fx.role.name}`] },
    false,
    [],
    {
      async inspectOwner() { return { state: "running" }; },
      async stopOwner(owner) {
        stopCalls += 1;
        assert.deepEqual(owner, {
          scope: "task",
          taskId: fx.task.id,
          roleName: fx.role.name
        });
        assert.equal(
          fx.store.getRoleSession(fx.task.id, fx.role.name).status,
          "ready"
        );
        return true;
      }
    }
  );

  assert.equal(stopCalls, 1);
  assert.equal(fx.store.getRoleSession(fx.task.id, fx.role.name).status, "stopped");
  assert.equal(fx.store.getWorkMailbox(runtimeTarget), null);
  assert.deepEqual(forgotten, [{
    taskId: fx.task.id,
    roleName: fx.role.name
  }]);
});

test("delivery exhaustion is a no-op when the exact generation fence changed", (t) => {
  const fx = preparedDeliveryFailureFixture(t);
  const beforeMessages = fx.store.listMessages(fx.task.id).length;

  assert.equal(fx.adapter.saveRoleRunDeliveryFailure({
    ...fx.failure,
    launchId: "runtime-test:generation:stale"
  }), "state-changed");

  assert.equal(fx.store.getAgentRun(fx.task.id, fx.run.id).status, "active");
  assert.equal(fx.store.getActiveAgentRun(fx.task.id, fx.role.name).id, fx.run.id);
  assert.equal(fx.store.getWorkItem(fx.task.id, fx.item.id).status, "running");
  assert.equal(fx.store.listMessages(fx.task.id).length, beforeMessages);
  const reservation = fx.store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId: fx.task.id,
    roleName: fx.role.name
  }));
  assert.equal(isRuntimeLaunchReservation(
    reservation.processing,
    fx.launchId
  ), true);
  assert.equal(hasRuntimeCleanupObligation(reservation), false);
});

test("runtime native session registration is structured and exited work fails atomically", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const registered = adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, now);
  assert.equal(registered.nativeSessionId, "thread-1");

  const item = updateWorkItemStatus(createWorkItem(
    "work-item-1",
    task.id,
    { title: "Implement" },
    now
  ), "running", now);
  const run = createAgentRun(adapter,
    "agent-run-1",
    task.id,
    role.name,
    "resume",
    "work",
    now,
    { workItemId: item.id }
  );
  store.transaction((tx) => {
    tx.saveWorkItem(task.id, item);
    tx.saveActiveAgentRun(run);
    enqueueWork(tx, { kind: "role", taskId: task.id, roleName: role.name }, "run-dispatched", now, [
      { type: "run", taskId: task.id, id: run.id }
    ]);
  });
  adapter.claimWorkMailbox({
    target: { kind: "role", taskId: task.id, roleName: role.name },
    batchId: `agent-run:${task.id}/${run.id}`,
    owner: "controller",
    now,
    executionRef: { type: "run", taskId: task.id, id: run.id }
  });
  const deliveredAt = new Date(now.getTime() + 1_000).toISOString();
  store.saveActiveAgentRun({ ...run, pushedAt: deliveredAt, deliveredAt });

  assert.equal(adapter.saveExitedRoleRun({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: adapter.getRoleSession(task.id, role.name),
    summary: "tmux exited",
    now
  }), "failed");

  assert.equal(store.getAgentRun(task.id, run.id).status, "failed");
  assert.equal(store.getAgentRun(task.id, run.id).deliveredAt, deliveredAt);
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.equal(store.getWorkItem(task.id, item.id).status, "failed");
  assert.equal(store.getRole(task.id, role.name).status, "exited");
  assert.equal(store.getRoleSession(task.id, role.name).status, "stopped");
  assert.equal(store.getOperatorNotification(task.id), null);
  assert.equal(
    store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: role.name }).processing,
    null
  );
  assert.ok(store.getPendingWakeup(task.id).reasons.includes("leader-run-failed"));

  assert.equal(adapter.saveExitedRoleRun({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: adapter.getRoleSession(task.id, role.name),
    summary: "duplicate pane absence",
    now
  }), "state-changed");
  assert.equal(store.getOperatorNotification(task.id), null);

  const replacement = createAgentRun(adapter,
    "agent-run-102",
    task.id,
    role.name,
    "new",
    "replacement",
    now
  );
  store.transaction((tx) => {
    tx.saveActiveAgentRun(replacement);
    enqueueWork(tx, {
      kind: "role",
      taskId: task.id,
      roleName: role.name
    }, "run-dispatched", now, [
      { type: "run", taskId: task.id, id: replacement.id }
    ]);
  });
  adapter.claimWorkMailbox({
    target: { kind: "role", taskId: task.id, roleName: role.name },
    batchId: `agent-run:${task.id}/${replacement.id}`,
    owner: "controller",
    now,
    executionRef: { type: "run", taskId: task.id, id: replacement.id }
  });
  store.saveOperatorNotification(createLeaderStallNotification(
    task.id,
    replacement.id,
    replacement.createdAt,
    "newer-run",
    now,
    null
  ));

  assert.equal(adapter.saveExitedRoleRun({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: adapter.getRoleSession(task.id, role.name),
    summary: "stale liveness snapshot",
    now
  }), "state-changed");
  assert.equal(store.getActiveAgentRun(task.id, role.name).id, replacement.id);
  assert.equal(store.getOperatorNotification(task.id).runId, replacement.id);
});

test("reconfirming an already delivered active run does not rewrite authoritative state", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const run = createAgentRun(adapter,
    "agent-run-1",
    task.id,
    role.name,
    "new",
    "work",
    now
  );
  run.pushedAt = now.toISOString();
  run.deliveredAt = now.toISOString();
  store.transaction((tx) => {
    tx.saveRole(task.id, { ...role, status: "running" });
    tx.saveActiveAgentRun(run);
  });
  const before = JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision;

  adapter.saveRoleRunDelivery({
    task,
    role: adapter.getRole(task.id, role.name),
    run,
    session: null,
    now: new Date(now.getTime() + 1_000)
  });

  assert.equal(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).revision, before);
});

test("confirmed Task and global runtime cleanup also stops their persisted sessions", (t) => {
  const { home, store, task, role, now, adapter } = fixture(t);
  const globalRole = createGlobalRole(
    "operator",
    [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
    "codex",
    home,
    now
  );
  store.saveGlobalRole(globalRole);
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-task"
  }, now);
  adapter.recordGlobalRuntimeNativeSession({
    roleName: globalRole.name,
    agentId: globalRole.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-global"
  }, now);
  const taskOwner = {
    scope: "task", taskId: task.id, roleName: role.name
  };
  const globalOwner = { scope: "global", roleName: globalRole.name };
  assert.deepEqual(
    adapter.listDormantRuntimeOwners().map((candidate) => candidate.owner),
    [taskOwner, globalOwner]
  );
  const taskTarget = adapter.enqueueRuntimeCleanup(taskOwner, now);
  const globalTarget = adapter.enqueueRuntimeCleanup(globalOwner, now);
  const stoppedAt = new Date(now.getTime() + 1);

  assert.equal(adapter.completeRuntimeCleanup(taskTarget, stoppedAt), true);
  assert.equal(adapter.completeRuntimeCleanup(globalTarget, stoppedAt), true);

  assert.equal(store.getRoleSession(task.id, role.name).status, "stopped");
  assert.equal(
    store.getGlobalRoleSessionSet(globalRole.name)
      .sessions[globalRole.activeAgentId].status,
    "stopped"
  );
  assert.equal(store.getWorkMailbox(taskTarget), null);
  assert.equal(store.getWorkMailbox(globalTarget), null);
});

test("Task completion queues exact runtime cleanup without a completed-task wake", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const launchId = "runtime-test:generation:completion";
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    launchId,
    nativeSessionId: "thread-completed"
  }, now);

  const completion = runTaskCommand([
    "complete", task.id, "--summary", "Completed with runtime cleanup."
  ], store, { now: () => now });
  assert.equal(completion.kind, "output");
  assert.equal(store.getTask(task.id).status, "completed");
  assert.equal(store.getWorkMailbox({ kind: "task", taskId: task.id }), null);

  const target = runtimeLifecycleTarget({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  });
  assert.equal(hasRuntimeCleanupObligation(store.getWorkMailbox(target)), true);
  assert.equal(store.getRoleSession(task.id, role.name).nativeSessionId, "thread-completed");
  assert.equal(store.getRoleSession(task.id, role.name).launchId, launchId);

  const owners = [];
  await runControllerSchedulerPass(
    adapter,
    {
      async prepareRoleSession() { throw new Error("unexpected Leader wake"); },
      async waitUntilReady() { throw new Error("unexpected Leader readiness"); },
      async sendOnce() { throw new Error("unexpected Leader send"); },
      async inspectRole() { return "present"; },
      async stopTask() { return false; }
    },
    new Date(now.getTime() + 1),
    undefined,
    { kind: "full" },
    false,
    [],
    {
      async inspectOwner() { return { state: "running" }; },
      async stopOwner(owner) {
        owners.push(owner);
        return true;
      }
    }
  );

  assert.deepEqual(owners, [{
    scope: "task",
    taskId: task.id,
    roleName: role.name
  }]);
  const stopped = store.getRoleSession(task.id, role.name);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.nativeSessionId, "thread-completed");
  assert.equal(stopped.launchId, launchId);
  assert.equal(store.getWorkMailbox(target), null);
});

test("Task completion discards residual Role wake mailboxes", (t) => {
  const { store, task, role, now } = fixture(t);
  const worker = createRole(
    task.id,
    "worker",
    [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
    "codex",
    task.cwd,
    now
  );
  store.transaction((tx) => {
    tx.saveRole(task.id, worker);
    enqueueWork(tx, { kind: "role", taskId: task.id, roleName: worker.name }, "stale-role-result", now);
    enqueueWork(tx, { kind: "role", taskId: task.id, roleName: role.name }, "stale-leader-result", now);
  });

  runTaskCommand([
    "complete", task.id, "--summary", "Discard derived wake state."
  ], store, { now: () => now });

  assert.equal(store.getWorkMailbox({ kind: "task", taskId: task.id }), null);
  assert.equal(store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: role.name }), null);
  assert.equal(store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: worker.name }), null);
});

test("failed completed-Task cleanup stays pending, then reopen resumes the fixed native Session", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    launchId: "runtime-test:generation:reopen",
    nativeSessionId: "thread-reopen"
  }, now);
  runTaskCommand([
    "complete", task.id, "--summary", "Waiting for a confirmed stop."
  ], store, { now: () => now });
  const target = runtimeLifecycleTarget({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  });

  await runControllerSchedulerPass(
    adapter,
    {
      async prepareRoleSession() { throw new Error("unexpected Leader wake"); },
      async waitUntilReady() { throw new Error("unexpected Leader readiness"); },
      async sendOnce() { throw new Error("unexpected Leader send"); },
      async inspectRole() { return "present"; },
      async stopTask() { return false; }
    },
    new Date(now.getTime() + 1),
    undefined,
    { kind: "full" },
    false,
    [],
    {
      async inspectOwner() { return { state: "running" }; },
      async stopOwner() { return false; }
    }
  );
  assert.equal(hasRuntimeCleanupObligation(store.getWorkMailbox(target)), true);
  assert.equal(store.getRoleSession(task.id, role.name).status, "running");

  await runControllerSchedulerPass(
    adapter,
    {
      async prepareRoleSession() { throw new Error("unexpected Leader wake"); },
      async waitUntilReady() { throw new Error("unexpected Leader readiness"); },
      async sendOnce() { throw new Error("unexpected Leader send"); },
      async inspectRole() { return "present"; },
      async stopTask() { return false; }
    },
    new Date(now.getTime() + 2),
    undefined,
    { kind: "full" },
    false,
    [],
    {
      async inspectOwner() { return { state: "running" }; },
      async stopOwner() { return true; }
    }
  );
  assert.equal(store.getWorkMailbox(target), null);
  assert.equal(store.getRoleSession(task.id, role.name).status, "stopped");

  runTaskCommand(["reopen", task.id], store, { now: () => new Date(now.getTime() + 3) });
  const prepared = [];
  const [result] = await processLeaderWakeups(adapter, {
    async prepareRoleSession(input) {
      prepared.push(input);
      return { ...input, deliveryId: "reopen-delivery", sessionStarted: false };
    },
    async waitUntilReady(delivery) {
      return {
        prepared: delivery,
        session: { ...adapter.getRoleSession(task.id, role.name), status: "running" }
      };
    },
    async sendOnce() { return "sent"; }
  }, new Date(now.getTime() + 4));

  assert.equal(result.status, "dispatched");
  assert.equal(prepared[0].mode, "resume");
  assert.equal(prepared[0].nativeSessionId, "thread-reopen");
});

test("reopen identity drift fails closed with durable recovery state and no provider call", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    launchId: "runtime-test:generation:identity",
    nativeSessionId: "thread-identity"
  }, now);
  runTaskCommand(["complete", task.id, "--summary", "Identity fence."], store, { now: () => now });
  const target = runtimeLifecycleTarget({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  });
  await runControllerSchedulerPass(
    adapter,
    {
      async prepareRoleSession() { throw new Error("unexpected Leader wake"); },
      async waitUntilReady() { throw new Error("unexpected Leader readiness"); },
      async sendOnce() { throw new Error("unexpected Leader send"); },
      async inspectRole() { return "present"; },
      async stopTask() { return false; }
    },
    new Date(now.getTime() + 1),
    undefined,
    { kind: "full" },
    false,
    [],
    {
      async inspectOwner() { return { state: "running" }; },
      async stopOwner() { return true; }
    }
  );
  store.saveRole(task.id, updateRole(role, {
    agentBindings: {
      codex: createRoleAgentBinding(
        { id: "codex", adapterId: "codex" },
        { adapterId: "codex", model: "gpt-next", effort: "medium" }
      )
    }
  }, new Date(now.getTime() + 2)));
  runTaskCommand(["reopen", task.id], store, { now: () => new Date(now.getTime() + 3) });

  let providerCalls = 0;
  const [result] = await processLeaderWakeups(adapter, {
    async prepareRoleSession() {
      providerCalls += 1;
      throw new Error("provider must not be called after identity drift");
    }
  }, new Date(now.getTime() + 4));

  assert.equal(result.status, "failed");
  assert.equal(providerCalls, 0);
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.equal(store.getRoleSession(task.id, role.name).status, "broken");
  assert.match(store.getLeaderFailure(task.id).message, /identity drift/i);
  assert.equal(hasRuntimeCleanupObligation(store.getWorkMailbox(target)), false);
  assert.notEqual(store.getPendingWakeup(task.id), null);
});

test("reopen identity drift also fails closed while the old host remains live", async (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    launchId: "runtime-test:generation:live-drift",
    nativeSessionId: "thread-live-drift"
  }, now);
  runTaskCommand(["complete", task.id, "--summary", "Retain the live owner fence."], store, {
    now: () => now
  });
  const target = runtimeLifecycleTarget({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  });
  assert.equal(store.getRoleSession(task.id, role.name).status, "running");
  assert.equal(hasRuntimeCleanupObligation(store.getWorkMailbox(target)), true);

  store.saveRole(task.id, updateRole(role, {
    agentBindings: {
      codex: createRoleAgentBinding(
        { id: "codex", adapterId: "codex" },
        { adapterId: "codex", model: "gpt-drifted", effort: "medium" }
      )
    }
  }, new Date(now.getTime() + 1)));
  runTaskCommand(["reopen", task.id], store, {
    now: () => new Date(now.getTime() + 2)
  });

  let providerCalls = 0;
  const [result] = await processLeaderWakeups(adapter, {
    async prepareRoleSession() {
      providerCalls += 1;
      throw new Error("provider must not be called for a live identity drift");
    }
  }, new Date(now.getTime() + 3));

  assert.equal(result.status, "failed");
  assert.equal(providerCalls, 0);
  assert.equal(store.getActiveAgentRun(task.id, role.name), null);
  assert.equal(store.getRoleSession(task.id, role.name).status, "broken");
  assert.match(store.getLeaderFailure(task.id).message, /identity drift/i);
  assert.equal(hasRuntimeCleanupObligation(store.getWorkMailbox(target)), true);
  assert.notEqual(store.getPendingWakeup(task.id), null);
});

test("a confirmed-absent exact reservation is cleared with its Task session stopped", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const owner = { scope: "task", taskId: task.id, roleName: role.name };
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-old"
  }, now);
  adapter.reserveRuntimeLaunch(
    { owner, launchId: "launch-stale" },
    () => {},
    now
  );

  assert.equal(adapter.completeStoppedRuntimeReservation(
    { kind: "role-runtime", taskId: task.id, roleName: role.name },
    "launch-stale",
    new Date(now.getTime() + 1)
  ), true);

  assert.equal(store.getRoleSession(task.id, role.name).status, "stopped");
  assert.equal(
    store.getWorkMailbox({
      kind: "role-runtime", taskId: task.id, roleName: role.name
    }),
    null
  );
});

test("settling a stopped launch handles the exact reservation and Hook-won race atomically", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const owner = { scope: "task", taskId: task.id, roleName: role.name };
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, now);
  adapter.reserveRuntimeLaunch(
    { owner, launchId: "launch-exact" },
    () => {},
    now
  );

  assert.equal(adapter.settleStoppedRuntimeLaunch({
    owner,
    launchId: "launch-exact",
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, new Date(now.getTime() + 1)), true);
  assert.equal(store.getRoleSession(task.id, role.name).status, "stopped");

  adapter.reserveRuntimeLaunch(
    { owner, launchId: "launch-hook-won" },
    () => {},
    new Date(now.getTime() + 2)
  );
  adapter.recordReservedRuntimeNativeSession({
    owner,
    launchId: "launch-hook-won",
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-1",
    effective: store.getRoleSession(task.id, role.name).effective
  }, () => {}, new Date(now.getTime() + 3));
  assert.equal(
    store.getWorkMailbox({
      kind: "role-runtime", taskId: task.id, roleName: role.name
    }),
    null
  );

  assert.equal(adapter.settleStoppedRuntimeLaunch({
    owner,
    launchId: "launch-hook-won",
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, new Date(now.getTime() + 4)), true);
  assert.equal(store.getRoleSession(task.id, role.name).status, "stopped");
});

test("an exact fresh-launch reservation replaces and archives a stopped incompatible Session", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const owner = { scope: "task", taskId: task.id, roleName: role.name };
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-old"
  }, now);
  const previous = structuredClone(store.getRoleSession(task.id, role.name));
  store.saveTaskRoleSessionSet(updateRoleAgentSessionStatus(
    store.getTaskRoleSessionSet(task.id, role.name),
    role.activeAgentId,
    "stopped",
    new Date(now.getTime() + 1)
  ));
  const desired = updateRole(role, {
    agentBindings: {
      codex: createRoleAgentBinding(
        { id: "codex", adapterId: "codex" },
        { adapterId: "codex", model: "gpt-next", effort: "high" }
      )
    }
  }, new Date(now.getTime() + 2));
  store.saveRole(task.id, desired);
  const effective = resolveEffectiveLaunch({ role: desired, purpose: "execution" });
  adapter.reserveRuntimeLaunch(
    { owner, launchId: "launch-fresh-effective" },
    () => {},
    new Date(now.getTime() + 3)
  );

  adapter.recordReservedRuntimeNativeSession({
    owner,
    launchId: "launch-fresh-effective",
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-new",
    effective
  }, () => {}, new Date(now.getTime() + 4));

  const sessions = store.getTaskRoleSessionSet(task.id, role.name);
  assert.equal(sessions.sessions.codex.nativeSessionId, "thread-new");
  assert.deepEqual(sessions.sessions.codex.effective, effective);
  assert.deepEqual(sessions.history, [
    { ...previous, status: "stopped", updatedAt: new Date(now.getTime() + 1).toISOString() }
  ]);
  assert.equal(store.getWorkMailbox({
    kind: "role-runtime",
    taskId: task.id,
    roleName: role.name
  }), null);
});

test("stopped-launch and dormant-session CAS fences preserve newer lifecycle facts", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  const owner = { scope: "task", taskId: task.id, roleName: role.name };
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, now);
  const [candidate] = adapter.listDormantRuntimeOwners();
  assert.deepEqual(candidate.owner, owner);

  adapter.reserveRuntimeLaunch(
    { owner, launchId: "launch-newer" },
    () => {},
    new Date(now.getTime() + 1)
  );
  assert.equal(adapter.settleStoppedRuntimeLaunch({
    owner,
    launchId: "launch-older",
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, new Date(now.getTime() + 2)), false);
  assert.equal(
    adapter.markRuntimeOwnerStopped(candidate, new Date(now.getTime() + 2)),
    false
  );
  assert.equal(store.getRoleSession(task.id, role.name).status, "running");
  assert.equal(adapter.completeRuntimeLaunchReservation(owner, "launch-newer"), true);

  const run = createAgentRun(adapter,
    "agent-run-123",
    task.id,
    role.name,
    "resume",
    "newer work",
    new Date(now.getTime() + 3)
  );
  store.saveActiveAgentRun(run);
  assert.equal(adapter.settleStoppedRuntimeLaunch({
    owner,
    launchId: "launch-older",
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, new Date(now.getTime() + 4)), false);
  assert.equal(
    adapter.markRuntimeOwnerStopped(candidate, new Date(now.getTime() + 4)),
    false
  );
  assert.equal(store.getRoleSession(task.id, role.name).status, "running");
});

test("dormant-session CAS rejects a Hook-updated session and stops an unchanged one", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "thread-1"
  }, now);
  const [stale] = adapter.listDormantRuntimeOwners();
  store.transaction((tx) => {
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    tx.saveTaskRoleSessionSet(updateRoleAgentSessionStatus(
      sessions,
      role.activeAgentId,
      "ready",
      new Date(now.getTime() + 1)
    ));
  });

  assert.equal(
    adapter.markRuntimeOwnerStopped(stale, new Date(now.getTime() + 2)),
    false
  );
  const [current] = adapter.listDormantRuntimeOwners();
  assert.equal(
    adapter.markRuntimeOwnerStopped(current, new Date(now.getTime() + 3)),
    true
  );
  assert.equal(store.getRoleSession(task.id, role.name).status, "stopped");
});

test("a late Codex notify cannot reactivate a session after Task archive", (t) => {
  const { store, task, role, now, adapter } = fixture(t);
  store.saveTask(archiveTask(
    completeTask(task, now, { by: "leader", summary: "Fixture complete." }),
    new Date(now.getTime() + 1_000)
  ));

  assert.throws(() => adapter.recordRuntimeNativeSession({
    taskId: task.id,
    roleName: role.name,
    agentId: role.activeAgentId,
    adapterId: "codex",
    nativeSessionId: "late-thread"
  }), /archived Task/);
  assert.equal(store.getRoleSession(task.id, role.name), null);
});
