import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../dist/agent/agent.js";
import {
  dispatchPreparedReviewRound,
  runTaskCommand
} from "../dist/commands/taskCommands.js";
import { FileSchedulerStoreAdapter } from "../dist/controller/fileSchedulerStoreAdapter.js";
import { FileRuntimeEventInbox } from "../dist/controller/runtimeEventInbox.js";
import { runSessionNotifyCommand } from "../dist/controller/sessionNotify.js";
import { updateRoleAgentSessionStatus } from "../dist/executor/agentExecutor.js";
import { createProject } from "../dist/repository/project.js";
import { TaskWorkspaceCoordinator } from "../dist/repository/taskWorkspaceCoordinator.js";
import { FileTaskWorkspacePreparer } from "../dist/repository/taskWorkspacePreparer.js";
import {
  createGlobalRole,
  createRole,
  createRoleAgentBinding
} from "../dist/role/role.js";
import { processActiveRoleRunDeliveries } from "../dist/scheduler/activeRoleRunDelivery.js";
import { processLeaderWakeups } from "../dist/scheduler/leaderWakeupProcessor.js";
import { queueLeaderWakeup } from "../dist/scheduler/wakeupQueue.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore, STORAGE_STATE_FILE } from "../dist/storage/taskStore.js";
import { activateTask, createTask } from "../dist/task/task.js";
import { createYuiWebServer } from "../dist/web/webServer.js";

const START = new Date("2026-08-02T08:00:00.000Z");

test("isolated multi-Task identity workflow keeps local ids qualified end to end", async (t) => {
  const requestedRoot = process.env.YUI_IDENTITY_E2E_ROOT;
  const root = requestedRoot === undefined
    ? mkdtempSync(join(tmpdir(), "yui-task-identity-e2e-"))
    : resolve(requestedRoot);
  if (requestedRoot !== undefined) {
    assert.equal(existsSync(root), false, `E2E artifact root already exists: ${root}`);
    mkdirSync(root, { recursive: true });
  }

  const home = join(root, "yui-home");
  t.after(() => {
    if (existsSync(join(home, "runtime", "controller.json"))) {
      execFileSync(
        process.execPath,
        [join(process.cwd(), "dist", "cli.js"), "controller", "stop"],
        { env: isolatedCliEnvironment(home), stdio: "ignore" }
      );
    }
    if (requestedRoot === undefined) rmSync(root, { recursive: true, force: true });
  });
  assert.notEqual(resolve(process.env.YUI_HOME ?? join(root, "unconfigured")), resolve(home));
  const primaryRepository = initializeFixtureRepository(root, "primary-repository");
  const secondaryRepository = initializeFixtureRepository(root, "secondary-repository");
  ensureStorageSchema(home, START);
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], START);
  const binding = createRoleAgentBinding(agent);
  const primaryProject = createProject(
    "project-1",
    "primary",
    primaryRepository,
    { stable: "HEAD", development: "HEAD" },
    START
  );
  const secondaryProject = createProject(
    "project-2",
    "secondary",
    secondaryRepository,
    { stable: "HEAD", development: "HEAD" },
    START
  );
  const primaryTask = activateTask(createTask("task-1", "Qualified delivery", START, {
    projectBindings: [{
      projectId: primaryProject.id,
      directory: primaryProject.name,
      baseRef: primaryProject.developmentBranch
    }],
    requireIntegration: true
  }), START);
  const lifecycleTask = activateTask(createTask(
    "task-2",
    "Lifecycle non-reuse",
    START,
    {
      projectBindings: [{
        projectId: secondaryProject.id,
        directory: secondaryProject.name,
        baseRef: secondaryProject.developmentBranch
      }]
    }
  ), START);

  store.transaction((tx) => {
    tx.saveConfig({
      schemaVersion: 1,
      defaultAgent: agent.id,
      defaultWorkspace: root,
      review: { roleName: "reviewer", trigger: "leader" }
    });
    tx.saveConfiguredAgent(agent);
    tx.saveProject(primaryProject);
    tx.saveProject(secondaryProject);
    for (const name of ["leader", "worker", "reviewer"]) {
      tx.saveGlobalRole(createGlobalRole(name, [binding], agent.id, root, START));
    }
    tx.saveTask(primaryTask);
    tx.saveRole(primaryTask.id, createRole(
      primaryTask.id,
      "leader",
      [binding],
      agent.id,
      primaryRepository,
      START
    ));
    tx.saveRole(primaryTask.id, createRole(
      primaryTask.id,
      "worker",
      [binding],
      agent.id,
      primaryRepository,
      START
    ));
    tx.saveTask(lifecycleTask);
    tx.saveRole(lifecycleTask.id, createRole(
      lifecycleTask.id,
      "leader",
      [binding],
      agent.id,
      secondaryRepository,
      START
    ));
  });

  const runtime = noOpRuntime();
  const primaryLeader = commandOptions(primaryTask.id, "leader", runtime, 1);
  const lifecycleLeader = commandOptions(lifecycleTask.id, "leader", runtime, 1);
  const primaryWork = runTaskCommand([
    "work", "create", primaryTask.id, "Implement qualified references",
    "--role", "worker",
    "--project", primaryProject.id
  ], store, primaryLeader).data.workItem;
  const lifecycleWork = runTaskCommand([
    "work", "create", lifecycleTask.id, "First lifecycle pass"
  ], store, lifecycleLeader).data.workItem;
  assert.deepEqual(
    [primaryWork.id, lifecycleWork.id],
    ["work-item-1", "work-item-1"]
  );

  let workspaceNow = at(2);
  const preparer = new FileTaskWorkspacePreparer(
    home,
    store,
    undefined,
    () => workspaceNow
  );
  const coordinator = new TaskWorkspaceCoordinator(store, preparer, {
    async stopTaskRoleSessions(taskId, roleNames) {
      store.transaction((tx) => {
        for (const roleName of roleNames) {
          const sessions = tx.getTaskRoleSessionSet(taskId, roleName);
          if (sessions === null) continue;
          let stopped = sessions;
          for (const agentId of Object.keys(sessions.sessions)) {
            stopped = updateRoleAgentSessionStatus(stopped, agentId, "stopped", new Date());
          }
          tx.saveTaskRoleSessionSet(stopped);
        }
      });
    }
  });
  const isolated = await coordinator.isolateWorkItem(primaryTask.id, primaryWork.id);
  const isolateResult = runCliJson(home, [
    "task", "work", "isolate", `${primaryTask.id}/${primaryWork.id}`
  ]);
  assert.equal(isolateResult.data.workspace.root, isolated.root);
  runCliJson(home, ["controller", "stop"]);
  await preparer.prepareTaskWorkspace(lifecycleTask.id);

  const scheduler = new FileSchedulerStoreAdapter(store);
  const delivery = recordingDelivery();
  queueLeaderWakeup(scheduler, primaryTask.id, "e2e-start", at(3));
  const [initialWake] = await processLeaderWakeups(
    scheduler,
    delivery,
    at(4),
    taskSelection(primaryTask.id)
  );
  assert.equal(initialWake.status, "dispatched", JSON.stringify(initialWake));
  assert.equal(delivery.receipts[0], "agent-run:task-1/agent-run-1");

  const firstLeaderRun = store.getActiveAgentRun(primaryTask.id, "leader");
  const leaderSession = store.getRoleSession(primaryTask.id, "leader");
  assert.notEqual(firstLeaderRun, null);
  assert.notEqual(leaderSession, null);
  const requestResult = runTaskCommand([
    "input", "request", primaryTask.id,
    "--question", "Proceed with the qualified cutover?",
    "--choice", "yes=Proceed",
    "--blocks", `run:${firstLeaderRun.id}`
  ], store, {
    ...commandOptions(primaryTask.id, "leader", runtime, 5),
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: primaryTask.id,
      YUI_ROLE: "leader",
      YUI_AGENT_ID: agent.id,
      YUI_NATIVE_SESSION_ID: leaderSession.nativeSessionId
    }
  });
  const request = requestResult.data.request;
  assert.equal(request.id, "input-1");
  assert.equal(request.requester.taskId, primaryTask.id);

  const answerResult = runCliJson(home, [
    "task", "input", "answer", `${primaryTask.id}/${request.id}`,
    "--choice", "yes"
  ]);
  assert.equal(answerResult.data.request.status, "answered");
  runCliJson(home, ["controller", "stop"]);
  const postAnswerNow = new Date();
  const postAnswerLeader = { ...primaryLeader, now: () => postAnswerNow };
  const postAnswerWorker = {
    ...commandOptions(primaryTask.id, "worker", runtime, 9),
    now: () => postAnswerNow
  };
  const postAnswerReviewer = {
    ...commandOptions(primaryTask.id, "reviewer", runtime, 12),
    now: () => postAnswerNow
  };
  const cliInputDetail = runCliJson(home, [
    "task", "input", "show", `${primaryTask.id}/${request.id}`
  ]);
  assert.equal(cliInputDetail.ok, true);
  assert.equal(cliInputDetail.data.request.status, "answered");

  const resumedLeaderRun = store.getActiveAgentRun(primaryTask.id, "leader");
  assert.notEqual(resumedLeaderRun, null);
  const [answerDelivery] = await processActiveRoleRunDeliveries(
    scheduler,
    delivery,
    postAnswerNow,
    taskSelection(primaryTask.id)
  );
  assert.equal(answerDelivery.status, "delivered", JSON.stringify(answerDelivery));
  assert.equal(
    delivery.receipts.at(-1),
    `agent-run:${primaryTask.id}/${resumedLeaderRun.id}`
  );

  const hookPayload = JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": store.getRoleSession(primaryTask.id, "leader").nativeSessionId,
    "turn-id": "turn-e2e-qualified-1",
    "input-messages": [resumedLeaderRun.input],
    "last-assistant-message": "Qualified input applied."
  });
  await runSessionNotifyCommand(
    hookPayload,
    {
      YUI_HOME: home,
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: primaryTask.id,
      YUI_ROLE: "leader",
      YUI_AGENT_ID: agent.id,
      YUI_ADAPTER_ID: "codex",
      YUI_LAUNCH_ID: "launch-e2e-qualified-1"
    },
    async () => ({}),
    async () => {}
  );
  const [hookEvent] = new FileRuntimeEventInbox(home).list();
  assert.equal(hookEvent.taskId, primaryTask.id);
  assert.equal(hookEvent.runId, resumedLeaderRun.id);
  runTaskCommand([
    "run", "yield", `${primaryTask.id}/${resumedLeaderRun.id}`,
    "--summary", "Qualified input applied."
  ], store, postAnswerLeader);

  writeFileSync(
    join(isolated.entries[0].path, "qualified-identity.txt"),
    "task-1/work-item-1\n"
  );
  execFileSync("git", ["-C", isolated.entries[0].path, "add", "qualified-identity.txt"]);
  execFileSync("git", [
    "-C", isolated.entries[0].path,
    "-c", "user.name=Yui Identity E2E",
    "-c", "user.email=identity@example.invalid",
    "commit", "-qm", "qualified identity candidate"
  ]);
  runTaskCommand([
    "work", "dispatch", `${primaryTask.id}/${primaryWork.id}`,
    "--input", "Implement the Task-local identity cutover."
  ], store, postAnswerLeader);
  assert.equal(
    (await processActiveRoleRunDeliveries(
      scheduler,
      delivery,
      postAnswerNow,
      taskSelection(primaryTask.id)
    ))[0].status,
    "delivered"
  );
  const workerRun = store.getActiveAgentRun(primaryTask.id, "worker");
  assert.notEqual(workerRun, null);
  const candidateGitSnapshot = await preparer.snapshotCandidateWorkspace(isolated);
  runTaskCommand([
    "run", "yield", `${primaryTask.id}/${workerRun.id}`,
    "--summary", "Task-local identity candidate is ready."
  ], store, { ...postAnswerWorker, candidateGitSnapshot });
  const candidate = store.getWorkItem(primaryTask.id, primaryWork.id).candidates[0];
  assert.deepEqual(
    { id: candidate.id, taskId: candidate.taskId, workItemId: candidate.workItemId },
    { id: "candidate-1", taskId: primaryTask.id, workItemId: primaryWork.id }
  );

  runTaskCommand([
    "work", "review", `${primaryTask.id}/${primaryWork.id}`
  ], store, postAnswerLeader);
  const pendingReview = store.listReviewRounds(primaryTask.id)[0];
  workspaceNow = postAnswerNow;
  const reviewWorkspace = await preparer.prepareReviewRoundWorkspace(
    primaryTask.id,
    pendingReview.id
  );
  dispatchPreparedReviewRound(primaryTask.id, pendingReview.id, store, postAnswerLeader);
  assert.equal(
    (await processActiveRoleRunDeliveries(
      scheduler,
      delivery,
      postAnswerNow,
      taskSelection(primaryTask.id)
    ))[0].status,
    "delivered"
  );
  const reviewRun = store.getActiveAgentRun(primaryTask.id, "reviewer");
  assert.notEqual(reviewRun, null);
  runTaskCommand([
    "run", "yield", `${primaryTask.id}/${reviewRun.id}`,
    "--summary", JSON.stringify({
      summary: "Review passed with no material findings.",
      checks: [{ name: "identity E2E review", outcome: "passed" }]
    })
  ], store, {
    ...postAnswerReviewer,
    reviewWorkspaceResult: {}
  });
  const review = store.listReviewRounds(primaryTask.id)[0];
  assert.equal(review.id, "review-round-1");
  assert.equal(review.status, "completed");
  assert.equal(review.reviewBaseCommit, candidateGitSnapshot.reviewBaseCommit);
  assert.notEqual(reviewWorkspace.root, isolated.root);
  assert.equal(await coordinator.cleanupReviewRound(primaryTask.id, review.id), "removed");

  const captureResult = runCliJson(home, [
    "task", "work", "capture", `${primaryTask.id}/${primaryWork.id}`
  ]);
  const [changeSet] = captureResult.data.changeSets;
  assert.equal(changeSet.id, "change-set-1");
  const integrationResult = runCliJson(home, [
    "task", "integration", "start", primaryTask.id,
    "--project", primaryProject.id,
    "--change-set", changeSet.id
  ]).data;
  assert.equal(integrationResult.status, "committed");
  assert.equal(integrationResult.attempt.id, "integration-1");
  const acceptResult = runCliJson(home, [
    "task", "work", "accept", `${primaryTask.id}/${primaryWork.id}`,
    "--summary", "Leader accepted reviewed and integrated output."
  ], leaderCliEnvironment(home, primaryTask.id));
  assert.equal(acceptResult.data.workItem.status, "completed");
  assert.equal(store.getWorkItem(primaryTask.id, primaryWork.id).status, "completed");
  await coordinator.runtime.stopTaskRoleSessions(primaryTask.id, ["worker"]);
  const cleanupResult = runCliJson(home, [
    "task", "work", "cleanup", `${primaryTask.id}/${primaryWork.id}`, "--integrated"
  ]);
  const workItemCleanup = cleanupResult.data.worktree.removal;
  assert.equal(workItemCleanup, "removed");
  assert.equal(
    store.getWorkItem(primaryTask.id, primaryWork.id).workspaceDisposition,
    "integrated"
  );

  runCliJson(home, ["controller", "stop"]);
  const lifecycleNow = new Date();
  const lifecycleLeaderNow = { ...lifecycleLeader, now: () => lifecycleNow };
  let lifecycleControlRun = store.getActiveAgentRun(lifecycleTask.id, "leader");
  if (lifecycleControlRun === null && store.getPendingWakeup(lifecycleTask.id) !== null) {
    const [wake] = await processLeaderWakeups(
      scheduler,
      delivery,
      lifecycleNow,
      taskSelection(lifecycleTask.id)
    );
    assert.equal(wake.status, "dispatched", JSON.stringify(wake));
    lifecycleControlRun = store.getActiveAgentRun(lifecycleTask.id, "leader");
  } else if (lifecycleControlRun?.deliveredAt === undefined) {
    const [deliveryResult] = await processActiveRoleRunDeliveries(
      scheduler,
      delivery,
      lifecycleNow,
      taskSelection(lifecycleTask.id)
    );
    assert.equal(deliveryResult.status, "delivered", JSON.stringify(deliveryResult));
    lifecycleControlRun = store.getActiveAgentRun(lifecycleTask.id, "leader");
  }
  if (lifecycleControlRun !== null) {
    runTaskCommand([
      "run", "yield", `${lifecycleTask.id}/${lifecycleControlRun.id}`,
      "--summary", "Controller wake settled before lifecycle verification."
    ], store, lifecycleLeaderNow);
  }
  runTaskCommand([
    "work", "dispose", `${lifecycleTask.id}/${lifecycleWork.id}`, "cancelled",
    "--summary", "First lifecycle pass settled."
  ], store, lifecycleLeaderNow);
  runTaskCommand([
    "complete", lifecycleTask.id, "--summary", "First lifecycle pass complete."
  ], store, lifecycleLeaderNow);
  runTaskCommand(["reopen", lifecycleTask.id], store, lifecycleLeaderNow);
  const secondLifecycleWork = runTaskCommand([
    "work", "create", lifecycleTask.id, "Second lifecycle pass"
  ], store, lifecycleLeaderNow).data.workItem;
  assert.equal(secondLifecycleWork.id, "work-item-2");
  runTaskCommand([
    "work", "dispose", `${lifecycleTask.id}/${secondLifecycleWork.id}`, "cancelled",
    "--summary", "Second lifecycle pass settled."
  ], store, lifecycleLeaderNow);
  runTaskCommand([
    "complete", lifecycleTask.id, "--summary", "Second lifecycle pass complete."
  ], store, lifecycleLeaderNow);
  runCliJson(home, [
    "task", "archive", lifecycleTask.id, "--abandon"
  ], leaderCliEnvironment(home, lifecycleTask.id));
  runCliJson(home, ["controller", "stop"]);
  const finalSettlementNow = new Date();
  let finalPrimaryControlRun = store.getActiveAgentRun(primaryTask.id, "leader");
  if (finalPrimaryControlRun !== null && finalPrimaryControlRun.deliveredAt === undefined) {
    const [deliveryResult] = await processActiveRoleRunDeliveries(
      scheduler,
      delivery,
      finalSettlementNow,
      taskSelection(primaryTask.id)
    );
    assert.equal(deliveryResult.status, "delivered", JSON.stringify(deliveryResult));
    finalPrimaryControlRun = store.getActiveAgentRun(primaryTask.id, "leader");
  }
  if (finalPrimaryControlRun !== null) {
    runTaskCommand([
      "run", "yield", `${primaryTask.id}/${finalPrimaryControlRun.id}`,
      "--summary", "Controller handoff settled after the integrated workflow."
    ], store, { ...primaryLeader, now: () => finalSettlementNow });
  }
  assert.equal(store.getActiveAgentRun(primaryTask.id, "leader"), null);
  const taskCleanup = store.getRoleWorkspace(lifecycleTask.id, "leader") === null
    ? { status: "removed" }
    : { status: "failed" };
  assert.equal(taskCleanup.status, "removed");
  assert.equal(store.getTask(lifecycleTask.id).status, "archived");

  const web = createYuiWebServer(store, { token: "identity-e2e-token", now: () => new Date() });
  await new Promise((resolveListen, reject) => {
    web.once("error", reject);
    web.listen(0, "127.0.0.1", resolveListen);
  });
  t.after(() => web.close());
  const address = web.address();
  assert.equal(typeof address, "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${primaryTask.id}`);
  assert.equal(response.status, 200);
  const webDetail = await response.json();
  assert.equal(webDetail.task.id, primaryTask.id);
  assert.equal(webDetail.workItems[0].taskId, primaryTask.id);
  assert.equal(webDetail.runs.every(({ taskId }) => taskId === primaryTask.id), true);
  assert.equal(webDetail.messages.every(({ taskId }) => taskId === primaryTask.id), true);

  const state = JSON.parse(readFileSync(join(home, STORAGE_STATE_FILE), "utf8"));
  assert.equal(state.tasks[lifecycleTask.id].idHighWaterMarks.workItem, 2);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    isolatedHome: home,
    fixtureRepositories: [
      repositoryEvidence(primaryRepository),
      repositoryEvidence(secondaryRepository)
    ],
    projectBindings: {
      [primaryTask.id]: primaryTask.projectBindings,
      [lifecycleTask.id]: lifecycleTask.projectBindings
    },
    actualCli: [
      `task work isolate ${primaryTask.id}/${primaryWork.id}`,
      `task input answer ${primaryTask.id}/${request.id}`,
      `task input show ${primaryTask.id}/${request.id}`,
      `task work capture ${primaryTask.id}/${primaryWork.id}`,
      `task integration start ${primaryTask.id} --change-set ${changeSet.id}`,
      `task work accept ${primaryTask.id}/${primaryWork.id}`,
      `task work cleanup ${primaryTask.id}/${primaryWork.id} --integrated`,
      `task archive ${lifecycleTask.id} --abandon`
    ],
    duplicateLocalIds: {
      [primaryTask.id]: primaryWork.id,
      [lifecycleTask.id]: lifecycleWork.id
    },
    qualifiedReceipts: delivery.receipts,
    controllerWake: {
      taskId: primaryTask.id,
      runId: resumedLeaderRun.id,
      claimedAfterActualCliInputAnswer: true,
      deliveryStatus: answerDelivery.status,
      settledPostWorkflowRunId: finalPrimaryControlRun?.id ?? null
    },
    input: {
      taskId: request.taskId,
      id: request.id,
      status: answerResult.data.request.status
    },
    hook: hookEvent,
    candidate: {
      id: candidate.id,
      taskId: candidate.taskId,
      workItemId: candidate.workItemId
    },
    review: { id: review.id, taskId: review.taskId, status: review.status },
    changeSet: { id: changeSet.id, taskId: changeSet.taskId },
    integration: {
      id: integrationResult.attempt.id,
      taskId: integrationResult.attempt.taskId,
      status: integrationResult.status
    },
    cleanup: {
      workItem: workItemCleanup,
      workspaceDisposition: store.getWorkItem(
        primaryTask.id,
        primaryWork.id
      ).workspaceDisposition,
      archivedTask: taskCleanup.status
    },
    webDetail: {
      taskId: webDetail.task.id,
      workItemIds: webDetail.workItems.map(({ id }) => id),
      runIds: webDetail.runs.map(({ id }) => id),
      messageIds: webDetail.messages.map(({ id }) => id)
    },
    archiveReopen: {
      taskId: lifecycleTask.id,
      status: store.getTask(lifecycleTask.id).status,
      workItemIds: store.listWorkItems(lifecycleTask.id).map(({ id }) => id),
      highWater: state.tasks[lifecycleTask.id].idHighWaterMarks.workItem
    }
  };
  const artifact = join(root, "identity-e2e-report.json");
  writeFileSync(artifact, `${JSON.stringify(report, null, 2)}\n`);
  t.diagnostic(`identity E2E artifacts: ${artifact}`);
});

function initializeFixtureRepository(root, name) {
  const repository = join(root, name);
  execFileSync("git", ["init", "-q", repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Yui Identity E2E"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "identity@example.invalid"]);
  writeFileSync(join(repository, "fixture.txt"), `${name}\n`);
  execFileSync("git", ["-C", repository, "add", "fixture.txt"]);
  execFileSync("git", ["-C", repository, "commit", "-qm", "initial fixture"]);
  return repository;
}

function recordingDelivery() {
  let sequence = 0;
  const receipts = [];
  return {
    receipts,
    async prepareRoleSession(input) {
      sequence += 1;
      return { ...input, deliveryId: `identity-delivery-${sequence}` };
    },
    async waitUntilReady(prepared) {
      return {
        prepared,
        session: {
          agentId: prepared.agentId,
          adapterId: prepared.adapterId,
          nativeSessionId: prepared.nativeSessionId
            ?? `native-${prepared.taskId}-${prepared.roleName}`,
          status: "running",
          effective: prepared.effective
        }
      };
    },
    async sendOnce(input) {
      receipts.push(input.receiptId);
      return "sent";
    },
    async inspectRole() { return "present"; }
  };
}

function commandOptions(taskId, roleName, runtime, offset) {
  return {
    runtime,
    now: () => at(offset),
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: taskId,
      YUI_ROLE: roleName
    }
  };
}

function taskSelection(taskId) {
  return {
    full: false,
    taskIds: new Set([taskId]),
    allRoleTaskIds: new Set([taskId]),
    rolesByTask: new Map(),
    operator: false
  };
}

function noOpRuntime() {
  return {
    notifyStateChanged() {},
    notifyMailboxChanged() {},
    reconcileTask() {},
    prepareTaskRoleEnter() {}
  };
}

function runCliJson(home, args, environment = isolatedCliEnvironment(home)) {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "--json", ...args],
    { encoding: "utf8", env: environment }
  ));
  assert.equal(result.ok, true);
  return result;
}

function isolatedCliEnvironment(home) {
  const environment = { ...process.env, YUI_HOME: home };
  for (const name of [
    "YUI_SESSION_SCOPE",
    "YUI_TASK_ID",
    "YUI_ROLE",
    "YUI_AGENT_ID",
    "YUI_ADAPTER_ID",
    "YUI_NATIVE_SESSION_ID",
    "YUI_LAUNCH_ID"
  ]) delete environment[name];
  return environment;
}

function leaderCliEnvironment(home, taskId) {
  return {
    ...isolatedCliEnvironment(home),
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: taskId,
    YUI_ROLE: "leader"
  };
}

function repositoryEvidence(repository) {
  return {
    path: repository,
    head: execFileSync(
      "git",
      ["-C", repository, "rev-parse", "HEAD"],
      { encoding: "utf8" }
    ).trim()
  };
}

function at(offset) {
  return new Date(START.getTime() + offset * 1_000);
}
