import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { dispatchPreparedReviewRound, runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import { createIntegrationAttempt, updateIntegrationAttempt } from "../../dist/integration/integrationAttempt.js";
import { stopFileTaskController } from "../../dist/controller/clientRuntime.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { terminalizeExactTaskRun } from "../../dist/lifecycle/exactRunTerminalization.js";
import { createProject } from "../../dist/repository/project.js";
import { createGlobalRole, createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import {
  createAgentRun,
  failAgentRun,
  markAgentRunDelivered,
  yieldAgentRun
} from "../../dist/run/agentRun.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { bindExecution, claimPending } from "../../dist/coordination/workMailbox.js";
import {
  attachReviewRoundWorkspace,
  createReviewRound,
  createTaskReviewRound,
  finishReviewRound
} from "../../dist/review/reviewRound.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { formatAgentRunReceiptId } from "../../dist/task/taskRecordReference.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import {
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { exactTaskCliInvocation } from "../helpers/exactTaskCli.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const COMMIT = (letter) => letter.repeat(40);

function fixture(t, projectIds = ["project-1", "project-2"], options = {}) {
  const root = mkdtempSync(join(tmpdir(), "yui-task13-final-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const codex = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({
      schemaVersion: 1,
      defaultAgent: codex.id,
      defaultWorkspace: root,
      review: { roleName: "reviewer", trigger: "final" }
    });
    tx.saveConfiguredAgent(codex);
    tx.saveGlobalRole(createGlobalRole("leader", [createRoleAgentBinding(codex)], codex.id, root, NOW));
    tx.saveGlobalRole(createGlobalRole("reviewer", [createRoleAgentBinding(codex)], codex.id, root, NOW));
    tx.saveGlobalRole(createGlobalRole("worker", [createRoleAgentBinding(codex)], codex.id, root, NOW));
    for (const [index, projectId] of projectIds.entries()) {
      const directory = `project-${index + 1}`;
      mkdirSync(join(root, directory), { recursive: true });
      tx.saveProject(createProject(projectId, index === 0 ? "one" : "two", join(root, directory), {
        stable: "main",
        development: "main"
      }, NOW));
    }
  });
  runTaskCommand([
    "create", "delivery", ...projectIds.flatMap((projectId) => ["--project", projectId]),
    "--require-integration"
  ], store, { now: () => NOW });
  const task = store.getTask("task-1");
  const leaderOptions = {
    now: () => NOW,
    environment: { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: task.id, YUI_ROLE: "leader" },
    actualTaskReviewCandidate: {
      schemaVersion: 1,
      projects: projectIds.map((projectId, index) => ({
        projectId,
        commit: COMMIT(String.fromCharCode(99 + index))
      }))
    }
  };
  runTaskCommand(["activate", task.id], store, { now: () => NOW });
  runTaskCommand([
    "work", "create", task.id, "change",
    ...(options.candidateSnapshot ? ["--project", projectIds[0]] : [])
  ], store, { now: () => NOW });
  const item = store.getWorkItem(task.id, "work-item-1");
  runTaskCommand(["work", "update", item.id, "running"], store, leaderOptions);
  store.transaction((tx) => {
    const running = tx.getWorkItem(task.id, item.id);
    const candidateWorkspace = options.candidateSnapshot
      ? createManagedWorkspace({
          owner: { type: "work-item", taskId: task.id, workItemId: item.id },
          root: join(root, "work-items", item.id),
          entries: projectIds.map((projectId, index) => ({
            projectId,
            directory: task.projectBindings[index].directory,
            access: running.writeProjectIds.includes(projectId) ? "write" : "read",
            path: join(root, "work-items", item.id, task.projectBindings[index].directory),
            branch: `yui/${task.id}/${item.id}-${index + 1}`,
            baseRef: COMMIT("b"),
            baseCommit: COMMIT("b")
          }))
        }, NOW)
      : undefined;
    if (candidateWorkspace !== undefined) tx.saveManagedWorkspace(candidateWorkspace);
    const candidate = submitWorkItemCandidate(running, {
      summary: "integrated candidate",
      source: { type: "direct" },
      ...(candidateWorkspace === undefined ? {} : {
        workspace: candidateWorkspace,
        gitSnapshot: {
          schemaVersion: 1,
          reviewBaseCommit: COMMIT("b"),
          projects: projectIds.map((projectId) => ({ projectId, commit: COMMIT("b") }))
        }
      })
    }, NOW);
    tx.saveWorkItem(task.id, candidate);
    tx.saveWorkItem(task.id, updateWorkItemStatus(candidate, "completed", NOW, "accepted"));
  });
  addCommittedIntegrations(
    store,
    task,
    item,
    options.integratedProjectIds ?? projectIds
  );
  return { root, store, task: store.getTask(task.id), item: store.getWorkItem(task.id, item.id), leaderOptions };
}

function setActualTaskHeads(fx, commits) {
  fx.leaderOptions.actualTaskReviewCandidate = {
    schemaVersion: 1,
    projects: fx.task.projectBindings.map(({ projectId }, index) => ({
      projectId,
      commit: commits[index]
    }))
  };
}

function addCommittedIntegrations(store, task, item, projectIds, suffix = "") {
  store.transaction((tx) => {
    for (const [index, projectId] of projectIds.entries()) {
      const base = COMMIT(String.fromCharCode(97 + index));
      const head = COMMIT(String.fromCharCode(99 + index));
      const changeSetId = `change-set-${index + 1}${suffix}`;
      tx.saveChangeSet(task.id, createWorkItemChangeSet({
        id: changeSetId,
        taskId: task.id,
        projectId,
        workItemId: item.id,
        baseCommit: base,
        headCommit: head,
        branch: `yui/${task.id}/${item.id}/${projectId}${suffix}`,
        changedPaths: [`${projectId}/change.ts`]
      }, NOW));
      const attempt = createIntegrationAttempt({
        id: `integration-${index + 1}${suffix}`,
        taskId: task.id,
        projectId,
        targetRef: `yui/${task.id}/main/${projectId}`,
        expectedHead: base,
        changeSetIds: [changeSetId],
        checkCommands: []
      }, NOW);
      tx.saveIntegrationAttempt(task.id, updateIntegrationAttempt(
        attempt,
        { status: "committed", candidateCommit: head },
        NOW
      ));
    }
  });
}

function addCommittedHead(fx, head) {
  const later = new Date(NOW.getTime() + 1_000);
  fx.store.transaction((tx) => {
    const changeSet = createWorkItemChangeSet({
      id: "change-set-2",
      taskId: fx.task.id,
      projectId: "project-1",
      workItemId: fx.item.id,
      baseCommit: COMMIT("a"),
      headCommit: head,
      branch: "yui/task-1/stale-final-repair",
      changedPaths: ["project-1/stale-final.ts"]
    }, later);
    tx.saveChangeSet(fx.task.id, changeSet);
    const attempt = createIntegrationAttempt({
      id: "integration-2",
      taskId: fx.task.id,
      projectId: "project-1",
      targetRef: "yui/task-1/main/project-1",
      expectedHead: COMMIT("a"),
      changeSetIds: [changeSet.id],
      checkCommands: []
    }, later);
    tx.saveIntegrationAttempt(fx.task.id, updateIntegrationAttempt(
      attempt,
      { status: "committed", candidateCommit: head },
      later
    ));
  });
  setActualTaskHeads(fx, fx.task.projectBindings.map(({ projectId }, index) => (
    projectId === "project-1"
      ? head
      : fx.leaderOptions.actualTaskReviewCandidate.projects[index].commit
  )));
}

function produceAssignedCandidate(fx, roleName, title, yieldAt) {
  runTaskCommand(["role", "add", fx.task.id, roleName], fx.store, fx.leaderOptions);
  const created = runTaskCommand(
    ["work", "create", fx.task.id, title, "--role", roleName],
    fx.store,
    fx.leaderOptions
  );
  const item = created.data.workItem;
  return fx.store.transaction((tx) => {
    const running = updateWorkItemStatus(
      tx.getWorkItem(fx.task.id, item.id),
      "running",
      yieldAt
    );
    tx.saveWorkItem(fx.task.id, running);
    const role = tx.getRole(fx.task.id, roleName);
    const effective = resolveEffectiveLaunch({
      role,
      purpose: "execution",
      workItemWriteProjectIds: running.writeProjectIds
    });
    const createdRun = createAgentRun(
      tx.nextAgentRunId(fx.task.id),
      fx.task.id,
      roleName,
      "new",
      `${roleName} candidate input`,
      yieldAt,
      { workItemId: item.id, effective }
    );
    const yieldedRun = yieldAgentRun(
      markAgentRunDelivered(createdRun, yieldAt),
      `${roleName} candidate`,
      yieldAt
    );
    tx.saveAgentRun(yieldedRun);
    const candidate = submitWorkItemCandidate(running, {
      summary: `${roleName} candidate`,
      source: { type: "run", runId: yieldedRun.id }
    }, yieldAt);
    tx.saveWorkItem(fx.task.id, candidate);
    const accepted = updateWorkItemStatus(candidate, "completed", yieldAt, "accepted");
    tx.saveWorkItem(fx.task.id, accepted);
    return accepted;
  });
}

function addCommittedIntegrationForItem(fx, {
  projectId,
  item,
  changeSetId,
  integrationId,
  head,
  at
}) {
  fx.store.transaction((tx) => {
    tx.saveChangeSet(fx.task.id, createWorkItemChangeSet({
      id: changeSetId,
      taskId: fx.task.id,
      projectId,
      workItemId: item.id,
      baseCommit: COMMIT("a"),
      headCommit: head,
      branch: `yui/${fx.task.id}/${item.id}/${projectId}`,
      changedPaths: [`${projectId}/${item.id}.ts`]
    }, at));
    const attempt = createIntegrationAttempt({
      id: integrationId,
      taskId: fx.task.id,
      projectId,
      targetRef: `yui/${fx.task.id}/main/${projectId}`,
      expectedHead: COMMIT("a"),
      changeSetIds: [changeSetId],
      checkCommands: []
    }, at);
    tx.saveIntegrationAttempt(fx.task.id, updateIntegrationAttempt(
      attempt,
      { status: "committed", candidateCommit: head },
      at
    ));
  });
  setActualTaskHeads(fx, fx.task.projectBindings.map(({ projectId: boundProjectId }, index) => (
    boundProjectId === projectId
      ? head
      : fx.leaderOptions.actualTaskReviewCandidate.projects[index].commit
  )));
}

function setGlobalReviewConfig(fx, review) {
  fx.store.transaction((tx) => {
    const config = tx.getConfig();
    if (review === undefined) {
      const { review: _review, ...withoutReview } = config;
      tx.saveConfig(withoutReview);
      return;
    }
    tx.saveConfig({ ...config, review });
  });
}

function addGlobalRoleAlias(fx, sourceName, aliasName) {
  const source = fx.store.getGlobalRole(sourceName);
  assert.ok(source, `missing source Global Role: ${sourceName}`);
  fx.store.transaction((tx) => {
    tx.saveGlobalRole({ ...source, name: aliasName });
  });
}

function taskStateSnapshot(fx) {
  return structuredClone({
    task: fx.store.getTask(fx.task.id),
    roles: fx.store.listRoles(fx.task.id),
    runs: fx.store.listAgentRuns(fx.task.id),
    rounds: fx.store.listReviewRounds(fx.task.id),
    events: fx.store.listEvents(fx.task.id),
    activeReviewer: fx.store.getActiveAgentRun(fx.task.id, "reviewer"),
    mailboxes: fx.store.listWorkMailboxes(),
    workspaces: fx.store.listManagedWorkspaces(fx.task.id)
  });
}

function reviewWorkspace(fx, round, frozenProjects = undefined) {
  const task = fx.store.getTask(fx.task.id);
  const bindings = new Map(task.projectBindings.map((binding) => [binding.projectId, binding]));
  const root = join(fx.root, "reviews", round.id);
  const projects = frozenProjects ?? round.taskCandidate?.projects ?? [{
    projectId: fx.task.projectBindings[0].projectId,
    commit: round.reviewBaseCommit
  }];
  return createManagedWorkspace({
    owner: { type: "review-round", taskId: fx.task.id, reviewRoundId: round.id },
    root,
    entries: projects.map(({ projectId, commit }, index) => ({
      projectId,
      directory: bindings.get(projectId).directory,
      access: "write",
      path: join(root, bindings.get(projectId).directory),
      branch: `yui/${fx.task.id}/${round.id}-${index + 1}`,
      baseRef: commit,
      baseCommit: commit
    }))
  }, NOW);
}

function attachWorkspace(fx, round, frozenProjects = undefined) {
  const workspace = reviewWorkspace(fx, round, frozenProjects);
  fx.store.transaction((tx) => {
    tx.saveManagedWorkspace(workspace);
    tx.saveReviewRound(fx.task.id, attachReviewRoundWorkspace(round, workspace));
  });
  return fx.store.getReviewRound(fx.task.id, round.id);
}

function dispatchFinal(fx, round = fx.store.listReviewRounds(fx.task.id)[0]) {
  attachWorkspace(fx, round);
  return dispatchPreparedReviewRound(fx.task.id, round.id, fx.store, fx.leaderOptions);
}

function terminalize(fx, run, status = "failed", summary = "review failed") {
  return fx.store.transaction((tx) => terminalizeExactTaskRun(tx, {
    taskId: fx.task.id,
    roleName: run.roleName,
    agentId: run.effective.agentId,
    runId: run.id,
    receiptId: formatAgentRunReceiptId(fx.task.id, run.id),
    outcome: { status, summary }
  }, NOW));
}

function explicitTaskReview(fx, roleName) {
  return runTaskCommand(
    ["review", "request", fx.task.id, "--role", roleName],
    fx.store,
    fx.leaderOptions
  ).data.reviewRound;
}

function failedNoRunTaskReview(fx) {
  const round = explicitTaskReview(fx, "reviewer");
  fx.store.saveReviewRound(fx.task.id, finishReviewRound(
    round,
    "failed",
    "failed before Reviewer Run",
    NOW
  ));
  return round;
}

function activeDifferentReviewerTaskReview(fx, status) {
  addGlobalRoleAlias(fx, "reviewer", "scout");
  const round = explicitTaskReview(fx, "scout");
  if (status === "running") dispatchFinal(fx, round);
  return round;
}

test("Task-final queue rejects an actual Task head moved after its latest committed Integration", (t) => {
  const fx = fixture(t);
  setActualTaskHeads(fx, [COMMIT("f"), COMMIT("d")]);

  assert.throws(
    () => runTaskCommand(
      ["complete", fx.task.id, "--summary", "must not review an unintegrated target"],
      fx.store,
      fx.leaderOptions
    ),
    /actual Task head.*latest committed Integration/i
  );
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 0);
  assert.equal(fx.store.getTask(fx.task.id).status, "active");
});

test("Task-final queue fails closed when the latest committed Integration has no candidate commit", (t) => {
  const fx = fixture(t, ["project-1"]);
  const rolledBackClock = new Date(NOW.getTime() - 1_000);
  fx.store.transaction((tx) => {
    const attempt = createIntegrationAttempt({
      id: "integration-2",
      taskId: fx.task.id,
      projectId: "project-1",
      targetRef: "yui/task-1/main/project-1",
      expectedHead: COMMIT("a"),
      changeSetIds: ["change-set-1"],
      checkCommands: []
    }, rolledBackClock);
    tx.saveIntegrationAttempt(fx.task.id, updateIntegrationAttempt(
      attempt,
      { status: "committed" },
      rolledBackClock
    ));
  });
  const malformed = fx.store.getIntegrationAttempt(fx.task.id, "integration-2");
  assert.equal(malformed.status, "committed");
  assert.equal(malformed.candidateCommit, undefined);
  const before = taskStateSnapshot(fx);

  let error;
  try {
    runTaskCommand(
      ["complete", fx.task.id, "--summary", "must reject malformed Integration"],
      fx.store,
      fx.leaderOptions
    );
  } catch (caught) {
    error = caught;
  }

  assert.deepEqual(taskStateSnapshot(fx), before);
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 0);
  assert.equal(fx.store.listAgentRuns(fx.task.id).length, 0);
  assert.equal(fx.store.getTask(fx.task.id).status, "active");
  assert.match(String(error), /Committed Integration has no candidate commit: task-1\/integration-2/i);
});

test("Task completion rechecks actual heads before reusing completed final Review evidence", (t) => {
  const fx = fixture(t);
  runTaskCommand(["complete", fx.task.id, "--summary", "review exact heads"], fx.store, fx.leaderOptions);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  const run = dispatchFinal(fx, round);
  assert.equal(terminalize(fx, run, "yielded", "exact heads reviewed").disposition, "applied");
  setActualTaskHeads(fx, [COMMIT("f"), COMMIT("d")]);

  assert.throws(
    () => runTaskCommand(
      ["complete", fx.task.id, "--summary", "must recheck physical heads"],
      fx.store,
      fx.leaderOptions
    ),
    /actual Task head.*latest committed Integration/i
  );
  assert.equal(fx.store.getTask(fx.task.id).status, "active");
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
});

test("Task-final dispatch rechecks actual heads after queueing", (t) => {
  const fx = fixture(t);
  runTaskCommand(["complete", fx.task.id, "--summary", "queue exact heads"], fx.store, fx.leaderOptions);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  setActualTaskHeads(fx, [COMMIT("f"), COMMIT("d")]);

  assert.throws(
    () => dispatchFinal(fx, round),
    /actual Task head.*latest committed Integration/i
  );
  assert.equal(fx.store.getReviewRound(fx.task.id, round.id).status, "pending");
  assert.equal(fx.store.listAgentRuns(fx.task.id).length, 0);
});

test("no-Run Task-final retry rechecks actual heads", (t) => {
  const fx = fixture(t);
  const failed = failedNoRunTaskReview(fx);
  setActualTaskHeads(fx, [COMMIT("f"), COMMIT("d")]);

  assert.throws(
    () => runTaskCommand(
      ["review", "retry", `${fx.task.id}/${failed.id}`],
      fx.store,
      fx.leaderOptions
    ),
    /actual Task head.*latest committed Integration/i
  );
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
});

test("failed-Run Task-final retry rechecks actual heads", (t) => {
  const fx = fixture(t);
  runTaskCommand(["complete", fx.task.id, "--summary", "queue exact heads"], fx.store, fx.leaderOptions);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  const run = dispatchFinal(fx, round);
  assert.equal(terminalize(fx, run).disposition, "applied");
  setActualTaskHeads(fx, [COMMIT("f"), COMMIT("d")]);

  assert.throws(
    () => runTaskCommand(
      ["run", "retry", `${fx.task.id}/${run.id}`],
      fx.store,
      fx.leaderOptions
    ),
    /actual Task head.*latest committed Integration/i
  );
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
});

test("obsolete Task-final settlement rechecks actual heads", (t) => {
  const fx = fixture(t, ["project-1"]);
  runTaskCommand(["complete", fx.task.id, "--summary", "queue old head"], fx.store, fx.leaderOptions);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  const run = dispatchFinal(fx, round);
  fx.store.transaction((tx) => {
    tx.saveAgentRun(failAgentRun(
      tx.getAgentRun(fx.task.id, run.id),
      "review launch failed before delivery",
      NOW
    ));
    tx.clearActiveAgentRun(fx.task.id, run.roleName);
  });
  fx.store.removeTaskRole(fx.task.id, run.roleName);
  addCommittedHead(fx, COMMIT("e"));
  setActualTaskHeads(fx, [COMMIT("f")]);
  const frozen = structuredClone(fx.store.getReviewRound(fx.task.id, round.id));

  assert.throws(
    () => runTaskCommand(
      ["run", "settle", `${fx.task.id}/${run.id}`],
      fx.store,
      fx.leaderOptions
    ),
    /actual Task head.*latest committed Integration/i
  );
  assert.deepEqual(fx.store.getReviewRound(fx.task.id, round.id), frozen);
});

test("latest committed Integration follows numeric identity despite clock rollback", (t) => {
  const fx = fixture(t, ["project-1"]);
  const saveCommitted = (id, head, at) => fx.store.transaction((tx) => {
    const changeSet = createWorkItemChangeSet({
      id: `change-set-${id}`,
      taskId: fx.task.id,
      projectId: "project-1",
      workItemId: fx.item.id,
      baseCommit: COMMIT("c"),
      headCommit: head,
      branch: `yui/${fx.task.id}/${fx.item.id}/${id}`,
      changedPaths: [`project-1/${id}.ts`]
    }, at);
    tx.saveChangeSet(fx.task.id, changeSet);
    const attempt = createIntegrationAttempt({
      id: `integration-${id}`,
      taskId: fx.task.id,
      projectId: "project-1",
      targetRef: `yui/${fx.task.id}/main/project-1`,
      expectedHead: COMMIT("c"),
      changeSetIds: [changeSet.id],
      checkCommands: []
    }, at);
    tx.saveIntegrationAttempt(fx.task.id, updateIntegrationAttempt(
      attempt,
      { status: "committed", candidateCommit: head },
      at
    ));
  });
  saveCommitted(9, COMMIT("e"), new Date(NOW.getTime() + 1_000));
  saveCommitted(10, COMMIT("f"), new Date(NOW.getTime() - 1_000));
  setActualTaskHeads(fx, [COMMIT("f")]);

  runTaskCommand(
    ["complete", fx.task.id, "--summary", "review numeric latest Integration"],
    fx.store,
    fx.leaderOptions
  );
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  assert.equal(round.taskCandidate.projects[0].commit, COMMIT("f"));
});

test("Task-final Review freezes an actual bound Project with no Integration and no producer", (t) => {
  const fx = fixture(
    t,
    ["project-1", "project-2"],
    { integratedProjectIds: ["project-1"] }
  );

  const requested = runTaskCommand(
    ["complete", fx.task.id, "--summary", "review modified and context Projects"],
    fx.store,
    fx.leaderOptions
  );
  const round = requested.data.reviewRound;
  assert.deepEqual(round.taskCandidate.projects, [
    { projectId: "project-1", commit: COMMIT("c") },
    { projectId: "project-2", commit: COMMIT("d") }
  ]);
  const run = dispatchFinal(fx, round);
  assert.equal(run.purpose, "review");
  assert.equal(run.reviewRoundId, round.id);
});

test("final policy selects the latest committed Integration, not a newer failed attempt", (t) => {
  const fx = fixture(t, ["project-1"]);
  fx.store.transaction((tx) => {
    const failedSet = createWorkItemChangeSet({
      id: "change-set-2",
      taskId: fx.task.id,
      projectId: "project-1",
      workItemId: fx.item.id,
      baseCommit: COMMIT("a"),
      headCommit: COMMIT("f"),
      branch: "yui/task-1/failed",
      changedPaths: ["project-1/fail.ts"]
    }, NOW);
    tx.saveChangeSet(fx.task.id, failedSet);
    const failed = createIntegrationAttempt({
      id: "integration-2",
      taskId: fx.task.id,
      projectId: "project-1",
      targetRef: "yui/task-1/main/project-1",
      expectedHead: COMMIT("a"),
      changeSetIds: [failedSet.id],
      checkCommands: []
    }, new Date(NOW.getTime() + 1_000));
    tx.saveIntegrationAttempt(fx.task.id, updateIntegrationAttempt(
      failed,
      { status: "failed", candidateCommit: COMMIT("f") },
      new Date(NOW.getTime() + 1_000)
    ));
  });
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  assert.equal(round.taskCandidate.projects[0].commit, COMMIT("c"));
});

test("Task-final dispatch reviews frozen integrated heads despite a mismatched Candidate snapshot", (t) => {
  const fx = fixture(t, ["project-1"]);
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const run = dispatchFinal(fx);
  assert.match(run.input, /Review Task-final WorkItem/);
  assert.match(run.input, /Review scope: task/);
  assert.match(run.input, /Frozen integrated Task heads: project-1@cccccccccccccccccccccccccccccccccccccccc/);
  assert.match(run.input, /Project Policy pointers:.*yui project show project-1/);
});

test("FileTaskStore reload accepts a Task-final workspace at the integrated SHA, not the Candidate snapshot", (t) => {
  const fx = fixture(t, ["project-1"], { candidateSnapshot: true });
  fx.store.removeManagedWorkspace({
    type: "work-item",
    taskId: fx.task.id,
    workItemId: fx.item.id
  });
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  const candidate = fx.store.getWorkItem(fx.task.id, fx.item.id).candidates.at(-1);
  const candidateCommit = candidate.gitSnapshot.projects[0].commit;
  const integratedCommit = round.taskCandidate.projects[0].commit;
  // The fixture keeps the same Project/tree entry and varies only the
  // immutable commit identity, matching a linear Integration with a
  // same-tree/different-SHA head.
  assert.notEqual(integratedCommit, candidateCommit);

  attachWorkspace(fx, round);
  const reloaded = new FileTaskStore(fx.root);
  const storedRound = reloaded.getReviewRound(fx.task.id, round.id);
  assert.equal(storedRound.workspace.entries[0].baseCommit, integratedCommit);
  assert.equal(
    reloaded.getWorkItem(fx.task.id, fx.item.id).candidates.at(-1).gitSnapshot.projects[0].commit,
    candidateCommit
  );
});

test("FileTaskStore rejects Task-final workspace project-set and commit drift", (t) => {
  const fx = fixture(t, ["project-1", "project-2"], { candidateSnapshot: true });
  fx.store.removeManagedWorkspace({
    type: "work-item",
    taskId: fx.task.id,
    workItemId: fx.item.id
  });
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  const frozen = round.taskCandidate.projects;
  assert.throws(
    () => fx.store.saveManagedWorkspace(reviewWorkspace(fx, round, frozen.slice(0, 1))),
    /Task frozen project set/u
  );
  assert.throws(
    () => fx.store.saveManagedWorkspace(reviewWorkspace(
      fx,
      round,
      frozen.map(({ projectId }) => ({ projectId, commit: COMMIT("f") }))
    )),
    /Task frozen project set/u
  );

  const extraProject = createProject(
    "project-3",
    "three",
    join(fx.root, "project-3"),
    { stable: "main", development: "main" },
    NOW
  );
  assert.throws(
    () => fx.store.transaction((tx) => {
      tx.saveProject(extraProject);
      const task = tx.getTask(fx.task.id);
      tx.saveTask({
        ...task,
        projectBindings: [
          ...task.projectBindings,
          { projectId: extraProject.id, directory: extraProject.name, baseRef: "main" }
        ]
      });
    }),
    /Task ReviewRound Projects do not match Task scope/u
  );
  assert.equal(fx.store.getTask(fx.task.id).projectBindings.length, 2);
});

test("FileTaskStore retains exact WorkItem Candidate gitSnapshot provenance", (t) => {
  const fx = fixture(t, ["project-1"], { candidateSnapshot: true });
  const item = fx.store.getWorkItem(fx.task.id, fx.item.id);
  const candidate = item.candidates.at(-1);
  const round = createReviewRound(
    "review-round-2",
    fx.task.id,
    item.id,
    candidate.id,
    "reviewer",
    "leader",
    candidate.gitSnapshot.projects[0].commit,
    NOW
  );
  fx.store.saveReviewRound(fx.task.id, round);
  const mismatched = reviewWorkspace(fx, round, [{
    projectId: "project-1",
    commit: COMMIT("c")
  }]);
  assert.throws(
    () => fx.store.saveManagedWorkspace(mismatched),
    /Candidate frozen commit/u
  );
});

for (const [drift, review] of [
  ["always", { roleName: "reviewer", trigger: "always" }],
  ["leader", { roleName: "reviewer", trigger: "leader" }],
  ["none", undefined]
]) {
  test(`established Task-final policy survives global drift to ${drift} for changed heads`, (t) => {
    const fx = fixture(t, ["project-1"]);
    runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
    const firstRound = fx.store.listReviewRounds(fx.task.id)[0];
    const firstRun = dispatchFinal(fx, firstRound);
    assert.equal(terminalize(fx, firstRun, "yielded", "review passed").disposition, "applied");

    setGlobalReviewConfig(fx, review);
    addCommittedHead(fx, COMMIT("d"));
    const result = runTaskCommand(
      ["complete", fx.task.id, "--summary", "finish newer head"],
      fx.store,
      fx.leaderOptions
    );
    const freshRound = result.data.reviewRound;
    assert.equal(fx.store.getTask(fx.task.id).status, "active");
    assert.equal(freshRound.status, "pending");
    assert.equal(freshRound.scope, "task");
    assert.equal(freshRound.requestedBy, "policy");
    assert.equal(freshRound.reviewerRoleName, "reviewer");
    assert.equal(freshRound.taskCandidate.projects[0].commit, COMMIT("d"));
  });
}

test("established Task-final policy allows only exact completed heads after global drift", (t) => {
  const fx = fixture(t, ["project-1"]);
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  const run = dispatchFinal(fx, round);
  assert.equal(terminalize(fx, run, "yielded", "review passed").disposition, "applied");
  setGlobalReviewConfig(fx, undefined);

  const completed = runTaskCommand(
    ["complete", fx.task.id, "--summary", "complete exact reviewed heads"],
    fx.store,
    fx.leaderOptions
  );
  assert.equal(fx.store.getTask(fx.task.id).status, "completed");
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);

  const repeated = runTaskCommand(
    ["complete", fx.task.id, "--summary", "repeat"],
    fx.store,
    fx.leaderOptions
  );
  assert.equal(fx.store.getTask(fx.task.id).status, "completed");
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
});

test("failed established Task-final evidence remains a completion blocker after global drift", (t) => {
  const fx = fixture(t, ["project-1"]);
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  const run = dispatchFinal(fx, round);
  assert.equal(terminalize(fx, run, "failed", "review failed").disposition, "applied");
  setGlobalReviewConfig(fx, undefined);

  const blocked = runTaskCommand(
    ["complete", fx.task.id, "--summary", "must remain blocked"],
    fx.store,
    fx.leaderOptions
  );
  assert.equal(blocked.data.reviewRound.id, round.id);
  assert.equal(blocked.data.reviewRound.status, "failed");
  assert.equal(fx.store.getTask(fx.task.id).status, "active");
});

test("a failed Task-final Round with no Reviewer Run has an explicit Leader retry boundary", (t) => {
  const fx = fixture(t, ["project-1"]);
  // Remove the configured Reviewer before final preparation. This reproduces
  // the reachable pre-dispatch failure: completion persists a terminal failed
  // Round but no Reviewer Run exists to address via `task run retry`.
  const reviewerRole = fx.store.getGlobalRole("reviewer");
  fx.store.transaction((tx) => {
    tx.removeGlobalRole("reviewer");
  });
  const completed = runTaskCommand(
    ["complete", fx.task.id, "--summary", "finish"],
    fx.store,
    fx.leaderOptions
  );
  const failed = completed.data.reviewRound;
  assert.equal(failed.status, "failed");
  assert.equal(failed.reviewerRunId, undefined);
  const oldRound = structuredClone(fx.store.getReviewRound(fx.task.id, failed.id));
  assert.throws(
    () => runTaskCommand(["run", "retry", `${fx.task.id}/${failed.id}`], fx.store, fx.leaderOptions),
    /Agent Run reference|agent-run local id|not found/i
  );
  fx.store.saveGlobalRole(reviewerRole);

  // The public Leader boundary is intentionally separate from failed-Run
  // retry. This assertion is RED until `task review retry` is implemented.
  const retried = runTaskCommand(
    ["review", "retry", `${fx.task.id}/${failed.id}`],
    fx.store,
    fx.leaderOptions
  );
  assert.equal(retried.data.reviewRound.status, "pending");
  assert.notEqual(retried.data.reviewRound.id, failed.id);
  assert.deepEqual(fx.store.getReviewRound(fx.task.id, failed.id), oldRound);
  assert.equal(
    runTaskCommand(["review", "retry", `${fx.task.id}/${failed.id}`], fx.store, fx.leaderOptions)
      .data.reviewRound.id,
    retried.data.reviewRound.id
  );
  const retriedRun = dispatchFinal(fx, retried.data.reviewRound);
  assert.equal(
    runTaskCommand(["review", "retry", `${fx.task.id}/${failed.id}`], fx.store, fx.leaderOptions)
      .data.reviewRound.id,
    retried.data.reviewRound.id
  );
  assert.equal(fx.store.getReviewRound(fx.task.id, retriedRun.reviewRoundId).status, "running");
});

test("Task-final reviewer independence covers every frozen ChangeSet producer", (t) => {
  const fx = fixture(t, ["project-1", "project-2"]);
  const producer = produceAssignedCandidate(
    fx,
    "reviewer",
    "reviewer-produced change",
    new Date(NOW.getTime() + 1_000)
  );
  addCommittedIntegrationForItem(fx, {
    projectId: "project-2",
    item: producer,
    changeSetId: "change-set-3",
    integrationId: "integration-3",
    head: COMMIT("e"),
    at: new Date(NOW.getTime() + 2_000)
  });

  const result = runTaskCommand(
    ["complete", fx.task.id, "--summary", "finish"],
    fx.store,
    fx.leaderOptions
  );
  assert.equal(result.data.reviewRound.status, "failed");
  assert.match(result.data.reviewRound.summary, /every integrated Candidate producer/i);
  assert.equal(result.data.reviewRound.reviewerRunId, undefined);
});

test("an independent Reviewer dispatches for multiple integrated producers", (t) => {
  const fx = fixture(t, ["project-1", "project-2"]);
  const producer = produceAssignedCandidate(
    fx,
    "worker",
    "worker-produced change",
    new Date(NOW.getTime() + 1_000)
  );
  addCommittedIntegrationForItem(fx, {
    projectId: "project-2",
    item: producer,
    changeSetId: "change-set-3",
    integrationId: "integration-3",
    head: COMMIT("e"),
    at: new Date(NOW.getTime() + 2_000)
  });

  const result = runTaskCommand(
    ["complete", fx.task.id, "--summary", "finish"],
    fx.store,
    fx.leaderOptions
  );
  assert.equal(result.data.reviewRound.status, "pending");
  const run = dispatchFinal(fx, result.data.reviewRound);
  assert.equal(run.roleName, "reviewer");
  assert.match(run.input, /Frozen integrated Task heads:/);
});

test("failed Task-final retry is one-transaction and idempotent before and after dispatch", (t) => {
  const fx = fixture(t, ["project-1"]);
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const firstRound = fx.store.listReviewRounds(fx.task.id)[0];
  const firstRun = dispatchFinal(fx, firstRound);
  assert.equal(terminalize(fx, firstRun).disposition, "applied");
  const firstRoundSnapshot = structuredClone(fx.store.getReviewRound(fx.task.id, firstRound.id));
  const firstRetry = runTaskCommand(["run", "retry", firstRun.id], fx.store, fx.leaderOptions);
  const retryRound = firstRetry.data.reviewRound;
  assert.equal(retryRound.requestedBy, "leader");
  assert.deepEqual(retryRound.taskCandidate, firstRoundSnapshot.taskCandidate);
  assert.deepEqual(fx.store.getReviewRound(fx.task.id, firstRound.id), firstRoundSnapshot);
  assert.equal(runTaskCommand(["run", "retry", firstRun.id], fx.store, fx.leaderOptions).data.reviewRound.id, retryRound.id);
  const retryRun = dispatchFinal(fx, retryRound);
  fx.store.transaction((tx) => {
    const target = { kind: "role", taskId: fx.task.id, roleName: retryRun.roleName };
    const mailbox = tx.getWorkMailbox(target);
    const claimed = claimPending(mailbox, {
      batchId: "retry-batch",
      owner: "task-13-test",
      startedAt: NOW.toISOString()
    });
    tx.saveWorkMailbox(bindExecution(claimed, "retry-batch", {
      type: "run", taskId: fx.task.id, id: retryRun.id
    }));
  });
  assert.equal(runTaskCommand(["run", "retry", firstRun.id], fx.store, fx.leaderOptions).data.reviewRound.id, retryRound.id);
  assert.equal(fx.store.getActiveAgentRun(fx.task.id, retryRun.roleName).id, retryRun.id);
});

test("stale failed Task-final split settles exactly, then completion dispatches the newer heads", (t) => {
  const fx = fixture(t, ["project-1"]);
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const oldRound = fx.store.listReviewRounds(fx.task.id)[0];
  const oldRun = dispatchFinal(fx, oldRound);
  fx.store.transaction((tx) => {
    const failed = failAgentRun(
      tx.getAgentRun(fx.task.id, oldRun.id),
      "review launch failed before delivery",
      NOW
    );
    tx.saveAgentRun(failed);
    tx.clearActiveAgentRun(fx.task.id, oldRun.roleName);
  });
  // Reproduce the production split: the failed Run and running Round remain,
  // while the reviewer Role and both mailbox lanes have already disappeared.
  fx.store.removeTaskRole(fx.task.id, oldRun.roleName);
  const beforeRun = structuredClone(fx.store.getAgentRun(fx.task.id, oldRun.id));
  const beforeRound = structuredClone(fx.store.getReviewRound(fx.task.id, oldRound.id));
  addCommittedHead(fx, COMMIT("d"));

  const settled = runTaskCommand(["run", "settle", oldRun.id], fx.store, fx.leaderOptions);
  assert.equal(settled.data.reviewRound.id, oldRound.id);
  assert.equal(settled.data.reviewRound.status, "failed");
  assert.deepEqual(fx.store.getAgentRun(fx.task.id, oldRun.id), beforeRun);
  const settledRound = fx.store.getReviewRound(fx.task.id, oldRound.id);
  assert.deepEqual(settledRound.workspace, beforeRound.workspace);
  if (beforeRound.report !== undefined) assert.deepEqual(settledRound.report, beforeRound.report);
  if (beforeRound.checks !== undefined) assert.deepEqual(settledRound.checks, beforeRound.checks);
  if (beforeRound.evidenceCommit !== undefined) {
    assert.deepEqual(settledRound.evidenceCommit, beforeRound.evidenceCommit);
  }

  const completed = runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const freshRound = completed.data.reviewRound;
  assert.notEqual(freshRound.id, oldRound.id);
  assert.equal(freshRound.status, "pending");
  assert.equal(freshRound.taskCandidate.projects[0].commit, COMMIT("d"));
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 2);
  const freshRun = dispatchFinal(fx, freshRound);
  assert.match(freshRun.input, /Frozen integrated Task heads: project-1@dddddddddddddddddddddddddddddddddddddddd/);
});

test("Task review retry rejects a different Reviewer pending Round before any write", (t) => {
  const fx = fixture(t, ["project-1"]);
  setGlobalReviewConfig(fx, undefined);
  const failed = failedNoRunTaskReview(fx);
  const conflicting = activeDifferentReviewerTaskReview(fx, "pending");
  assert.equal(conflicting.status, "pending");
  const before = taskStateSnapshot(fx);
  assert.throws(
    () => runTaskCommand(
      ["review", "retry", `${fx.task.id}/${failed.id}`],
      fx.store,
      fx.leaderOptions
    ),
    /active Task-final ReviewRound|conflicting/i
  );
  assert.deepEqual(taskStateSnapshot(fx), before);
});

test("Task review retry rejects a different Reviewer running Round before any write", (t) => {
  const fx = fixture(t, ["project-1"]);
  setGlobalReviewConfig(fx, undefined);
  const failed = failedNoRunTaskReview(fx);
  const conflicting = activeDifferentReviewerTaskReview(fx, "running");
  assert.equal(fx.store.getReviewRound(fx.task.id, conflicting.id).status, "running");
  const before = taskStateSnapshot(fx);
  assert.throws(
    () => runTaskCommand(
      ["review", "retry", `${fx.task.id}/${failed.id}`],
      fx.store,
      fx.leaderOptions
    ),
    /active Task-final ReviewRound|conflicting/i
  );
  assert.deepEqual(taskStateSnapshot(fx), before);
});

test("Task-final failed-Run retry rejects a different Reviewer pending Round before any write", (t) => {
  const fx = fixture(t, ["project-1"]);
  setGlobalReviewConfig(fx, undefined);
  const failedRound = explicitTaskReview(fx, "reviewer");
  const failedRun = dispatchFinal(fx, failedRound);
  assert.equal(terminalize(fx, failedRun, "failed", "provider failed").disposition, "applied");
  const conflicting = activeDifferentReviewerTaskReview(fx, "pending");
  assert.equal(conflicting.status, "pending");
  const before = taskStateSnapshot(fx);
  assert.throws(
    () => runTaskCommand(["run", "retry", failedRun.id], fx.store, fx.leaderOptions),
    /active Task-final ReviewRound|conflicting/i
  );
  assert.deepEqual(taskStateSnapshot(fx), before);
});

test("Task-final failed-Run retry rejects a different Reviewer running Round before any write", (t) => {
  const fx = fixture(t, ["project-1"]);
  setGlobalReviewConfig(fx, undefined);
  const failedRound = explicitTaskReview(fx, "reviewer");
  const failedRun = dispatchFinal(fx, failedRound);
  assert.equal(terminalize(fx, failedRun, "failed", "provider failed").disposition, "applied");
  const conflicting = activeDifferentReviewerTaskReview(fx, "running");
  assert.equal(fx.store.getReviewRound(fx.task.id, conflicting.id).status, "running");
  const before = taskStateSnapshot(fx);
  assert.throws(
    () => runTaskCommand(["run", "retry", failedRun.id], fx.store, fx.leaderOptions),
    /active Task-final ReviewRound|conflicting/i
  );
  assert.deepEqual(taskStateSnapshot(fx), before);
});

test("normal final queue rejects persisted older active Round before writing a newer Round", (t) => {
  const fx = fixture(t, ["project-1"]);
  const first = runTaskCommand(
    ["complete", fx.task.id, "--summary", "finish"],
    fx.store,
    fx.leaderOptions
  ).data.reviewRound;
  const newerTerminal = finishReviewRound(
    createTaskReviewRound(
      "review-round-2",
      fx.task.id,
      fx.item.id,
      fx.item.candidates.at(-1).id,
      "reviewer",
      "policy",
      first.taskCandidate,
      new Date(NOW.getTime() + 1_000)
    ),
    "completed",
    "historical final review completed",
    new Date(NOW.getTime() + 2_000)
  );
  fx.store.saveReviewRound(fx.task.id, newerTerminal);
  addCommittedHead(fx, COMMIT("d"));
  const before = taskStateSnapshot(fx);
  assert.throws(
    () => runTaskCommand(
      ["complete", fx.task.id, "--summary", "queue newer final review"],
      fx.store,
      fx.leaderOptions
    ),
    /active Task-final ReviewRound|conflicting/i
  );
  assert.deepEqual(taskStateSnapshot(fx), before);
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 2);
});

test("pending retry refuses an unrelated active reviewer round and preserves every record", (t) => {
  const fx = fixture(t, ["project-1"], { candidateSnapshot: true });
  fx.store.transaction((tx) => {
    tx.removeManagedWorkspace({
      type: "work-item",
      taskId: fx.task.id,
      workItemId: fx.item.id
    });
  });
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const firstRound = fx.store.listReviewRounds(fx.task.id)[0];
  const firstRun = dispatchFinal(fx, firstRound);
  terminalize(fx, firstRun);
  const retry = runTaskCommand(["run", "retry", firstRun.id], fx.store, fx.leaderOptions).data.reviewRound;
  const unrelated = createReviewRound(
    "review-round-3",
    fx.task.id,
    fx.item.id,
    fx.item.candidates.at(-1).id,
    "reviewer",
    "policy",
    COMMIT("b"),
    NOW
  );
  fx.store.saveReviewRound(fx.task.id, unrelated);
  const unrelatedRun = dispatchFinal(fx, unrelated);
  assert.equal(fx.store.getActiveAgentRun(fx.task.id, unrelatedRun.roleName).id, unrelatedRun.id);
  const before = taskStateSnapshot(fx);
  assert.throws(
    () => runTaskCommand(["run", "retry", firstRun.id], fx.store, fx.leaderOptions),
    /active review round|active Task-final ReviewRound|active run|mailbox/i
  );
  assert.deepEqual(taskStateSnapshot(fx), before);
});

test("running retry is reusable only with its exact active pointer and mailbox execution", (t) => {
  const fx = fixture(t, ["project-1"]);
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const firstRound = fx.store.listReviewRounds(fx.task.id)[0];
  const firstRun = dispatchFinal(fx, firstRound);
  terminalize(fx, firstRun);
  const retryRound = runTaskCommand(["run", "retry", firstRun.id], fx.store, fx.leaderOptions).data.reviewRound;
  const retryRun = dispatchFinal(fx, retryRound);
  const target = { kind: "role", taskId: fx.task.id, roleName: retryRun.roleName };
  fx.store.transaction((tx) => {
    const mailbox = tx.getWorkMailbox(target);
    const claimed = claimPending(mailbox, {
      batchId: "retry-batch",
      owner: "task-13-test",
      startedAt: NOW.toISOString()
    });
    tx.saveWorkMailbox(bindExecution(claimed, "retry-batch", {
      type: "run", taskId: fx.task.id, id: retryRun.id
    }));
    tx.clearActiveAgentRun(fx.task.id, retryRun.roleName);
  });
  const before = taskStateSnapshot(fx);
  assert.throws(
    () => runTaskCommand(["run", "retry", firstRun.id], fx.store, fx.leaderOptions),
    /active|execution|mailbox/i
  );
  assert.deepEqual(taskStateSnapshot(fx), before);
});

test("completed identical retry is a no-write idempotent result", (t) => {
  const fx = fixture(t, ["project-1"]);
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const firstRound = fx.store.listReviewRounds(fx.task.id)[0];
  const firstRun = dispatchFinal(fx, firstRound);
  terminalize(fx, firstRun);
  const retryRound = runTaskCommand(["run", "retry", firstRun.id], fx.store, fx.leaderOptions).data.reviewRound;
  const retryRun = dispatchFinal(fx, retryRound);
  terminalize(fx, retryRun, "yielded", "review passed");
  const before = taskStateSnapshot(fx);
  const duplicate = runTaskCommand(["run", "retry", firstRun.id], fx.store, fx.leaderOptions);
  assert.equal(duplicate.data.reviewRound.id, retryRound.id);
  assert.equal(duplicate.data.reviewRound.status, "completed");
  assert.deepEqual(taskStateSnapshot(fx), before);
});

test("retry fails closed when committed Integration heads changed after the failed review", (t) => {
  const fx = fixture(t, ["project-1"]);
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const firstRound = fx.store.listReviewRounds(fx.task.id)[0];
  const firstRun = dispatchFinal(fx, firstRound);
  terminalize(fx, firstRun);
  const beforeRound = structuredClone(fx.store.getReviewRound(fx.task.id, firstRound.id));
  fx.store.transaction((tx) => {
    tx.saveChangeSet(fx.task.id, createWorkItemChangeSet({
      id: "change-set-2",
      taskId: fx.task.id,
      projectId: "project-1",
      workItemId: fx.item.id,
      baseCommit: COMMIT("a"),
      headCommit: COMMIT("d"),
      branch: "yui/task-1/changed-head",
      changedPaths: ["project-1/changed.ts"]
    }, NOW));
    const attempt = createIntegrationAttempt({
      id: "integration-2",
      taskId: fx.task.id,
      projectId: "project-1",
      targetRef: "yui/task-1/main/project-1",
      expectedHead: COMMIT("a"),
      changeSetIds: ["change-set-2"],
      checkCommands: []
    }, new Date(NOW.getTime() + 1_000));
    tx.saveIntegrationAttempt(fx.task.id, updateIntegrationAttempt(
      attempt,
      { status: "committed", candidateCommit: COMMIT("d") },
      new Date(NOW.getTime() + 1_000)
    ));
  });
  setActualTaskHeads(fx, [COMMIT("d")]);
  assert.throws(
    () => runTaskCommand(["run", "retry", firstRun.id], fx.store, fx.leaderOptions),
    /latest committed Integration heads/i
  );
  assert.deepEqual(fx.store.getReviewRound(fx.task.id, firstRound.id), beforeRound);
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
});

test("Task-final dispatch rejects a drifted stored Review workspace before creating a Run", (t) => {
  const fx = fixture(t, ["project-1"]);
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  attachWorkspace(fx, round);
  const stored = fx.store.getReviewRoundWorkspace(fx.task.id, round.id);
  const foreignRoot = join(fx.root, "foreign");
  const drifted = createManagedWorkspace({
    ...stored,
    root: foreignRoot,
    entries: stored.entries.map((entry) => ({
      ...entry,
      path: join(foreignRoot, entry.directory)
    }))
  }, NOW);
  fx.store.saveManagedWorkspace(drifted);
  assert.throws(
    () => dispatchPreparedReviewRound(fx.task.id, round.id, fx.store, fx.leaderOptions),
    /workspace ownership changed/i
  );
  assert.equal(fx.store.getReviewRound(fx.task.id, round.id).status, "pending");
  assert.equal(fx.store.listAgentRuns(fx.task.id).length, 0);
});

test("Task-final dispatch rechecks frozen committed Integration heads before creating a Run", (t) => {
  const fx = fixture(t, ["project-1"]);
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  attachWorkspace(fx, round);
  addCommittedHead(fx, COMMIT("d"));
  assert.throws(
    () => dispatchPreparedReviewRound(fx.task.id, round.id, fx.store, fx.leaderOptions),
    /frozen integrated heads changed/i
  );
  assert.equal(fx.store.getReviewRound(fx.task.id, round.id).status, "pending");
  assert.equal(fx.store.listAgentRuns(fx.task.id).length, 0);
});

test("explicit Task-final Review request is Leader-only and does not mutate state for another actor", (t) => {
  const fx = fixture(t, ["project-1"]);
  setGlobalReviewConfig(fx, undefined);
  const before = taskStateSnapshot(fx);
  assert.throws(
    () => runTaskCommand(
      ["review", "request", fx.task.id, "--role", "reviewer"],
      fx.store,
      {
        ...fx.leaderOptions,
        environment: { ...fx.leaderOptions.environment, YUI_ROLE: "worker" }
      }
    ),
    /matching Leader|Only the Task Leader/i
  );
  assert.deepEqual(taskStateSnapshot(fx), before);
});

test("explicit Task-final Review request requires the named global Role without partial records", (t) => {
  const fx = fixture(t, ["project-1"]);
  setGlobalReviewConfig(fx, undefined);
  fx.store.transaction((tx) => tx.removeGlobalRole("reviewer"));
  const before = taskStateSnapshot(fx);
  assert.throws(
    () => runTaskCommand(
      ["review", "request", fx.task.id, "--role", "reviewer"],
      fx.store,
      fx.leaderOptions
    ),
    /Global Role not found/i
  );
  assert.deepEqual(taskStateSnapshot(fx), before);
});

test("explicit Task-final Review request rejects every integrated producer collision without partial records", (t) => {
  const fx = fixture(t, ["project-1", "project-2"]);
  const producer = produceAssignedCandidate(
    fx,
    "reviewer",
    "reviewer-produced change",
    new Date(NOW.getTime() + 1_000)
  );
  addCommittedIntegrationForItem(fx, {
    projectId: "project-2",
    item: producer,
    changeSetId: "change-set-3",
    integrationId: "integration-3",
    head: COMMIT("e"),
    at: new Date(NOW.getTime() + 2_000)
  });
  setGlobalReviewConfig(fx, undefined);
  const before = taskStateSnapshot(fx);
  assert.throws(
    () => runTaskCommand(
      ["review", "request", fx.task.id, "--role", "reviewer"],
      fx.store,
      fx.leaderOptions
    ),
    /every integrated Candidate producer/i
  );
  assert.deepEqual(taskStateSnapshot(fx), before);
});

test("explicit Task-final Review request is idempotent across pending, running, and completed evidence", (t) => {
  const fx = fixture(t, ["project-1"]);
  setGlobalReviewConfig(fx, undefined);
  const originalGetReviewConfig = fx.store.getReviewConfig;
  fx.store.getReviewConfig = () => {
    throw new Error("explicit Task-final request must not read global review trigger");
  };
  let first;
  try {
    first = runTaskCommand(
      ["review", "request", fx.task.id, "--role", "reviewer"],
      fx.store,
      fx.leaderOptions
    ).data.reviewRound;
  } finally {
    fx.store.getReviewConfig = originalGetReviewConfig;
  }
  assert.equal(first.scope, "task");
  assert.equal(first.requestedBy, "leader");
  const pending = runTaskCommand(
    ["review", "request", fx.task.id, "--role", "reviewer"],
    fx.store,
    fx.leaderOptions
  ).data.reviewRound;
  assert.equal(pending.id, first.id);
  const running = dispatchFinal(fx, first);
  const runningAgain = runTaskCommand(
    ["review", "request", fx.task.id, "--role", "reviewer"],
    fx.store,
    fx.leaderOptions
  ).data.reviewRound;
  assert.equal(runningAgain.id, first.id);
  assert.equal(runningAgain.status, "running");
  assert.equal(terminalize(fx, running, "yielded", "review passed").disposition, "applied");
  const completed = runTaskCommand(
    ["review", "request", fx.task.id, "--role", "reviewer"],
    fx.store,
    fx.leaderOptions
  ).data.reviewRound;
  assert.equal(completed.id, first.id);
  assert.equal(completed.status, "completed");
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
});

test("explicit Task-final request rejects a different Reviewer while another Round is pending without writes", (t) => {
  const fx = fixture(t, ["project-1"]);
  setGlobalReviewConfig(fx, undefined);
  addGlobalRoleAlias(fx, "reviewer", "scout");
  const first = runTaskCommand(
    ["review", "request", fx.task.id, "--role", "reviewer"],
    fx.store,
    fx.leaderOptions
  ).data.reviewRound;
  const before = taskStateSnapshot(fx);
  assert.throws(
    () => runTaskCommand(
      ["review", "request", fx.task.id, "--role", "scout"],
      fx.store,
      fx.leaderOptions
    ),
    /active Task-final ReviewRound|active.*Round|conflicting/i
  );
  assert.deepEqual(taskStateSnapshot(fx), before);
  assert.equal(fx.store.getReviewRound(fx.task.id, first.id).status, "pending");
});

test("explicit Task-final request rejects a different Reviewer while another Round is running without writes", (t) => {
  const fx = fixture(t, ["project-1"]);
  setGlobalReviewConfig(fx, undefined);
  addGlobalRoleAlias(fx, "reviewer", "scout");
  const first = runTaskCommand(
    ["review", "request", fx.task.id, "--role", "reviewer"],
    fx.store,
    fx.leaderOptions
  ).data.reviewRound;
  const firstRun = dispatchFinal(fx, first);
  assert.equal(firstRun.roleName, "reviewer");
  const before = taskStateSnapshot(fx);
  assert.throws(
    () => runTaskCommand(
      ["review", "request", fx.task.id, "--role", "scout"],
      fx.store,
      fx.leaderOptions
    ),
    /active Task-final ReviewRound|active.*Round|conflicting/i
  );
  assert.deepEqual(taskStateSnapshot(fx), before);
  assert.equal(fx.store.getReviewRound(fx.task.id, first.id).status, "running");
});

test("Task-final dispatch rejects a persisted conflicting Reviewer Round before creating a Run", (t) => {
  const fx = fixture(t, ["project-1"]);
  setGlobalReviewConfig(fx, undefined);
  addGlobalRoleAlias(fx, "reviewer", "scout");
  const first = runTaskCommand(
    ["review", "request", fx.task.id, "--role", "reviewer"],
    fx.store,
    fx.leaderOptions
  ).data.reviewRound;
  runTaskCommand(["role", "add", fx.task.id, "scout"], fx.store, fx.leaderOptions);
  const candidate = fx.store.getWorkItem(fx.task.id, fx.item.id).candidates.at(-1);
  const second = createTaskReviewRound(
    "review-round-3",
    fx.task.id,
    fx.item.id,
    candidate.id,
    "scout",
    "leader",
    first.taskCandidate,
    NOW
  );
  fx.store.saveReviewRound(fx.task.id, second);
  attachWorkspace(fx, second);
  const before = taskStateSnapshot(fx);
  assert.throws(
    () => dispatchPreparedReviewRound(fx.task.id, second.id, fx.store, fx.leaderOptions),
    /active Task-final ReviewRound|conflicting/i
  );
  assert.deepEqual(taskStateSnapshot(fx), before);
  assert.equal(fx.store.getReviewRound(fx.task.id, first.id).status, "pending");
  assert.equal(fx.store.getReviewRound(fx.task.id, second.id).status, "pending");
  assert.equal(fx.store.listAgentRuns(fx.task.id).length, 0);
});

test("explicit Task-final Review request fails closed on a stale head and conflicting active lane", (t) => {
  const fx = fixture(t, ["project-1"]);
  setGlobalReviewConfig(fx, undefined);
  const first = runTaskCommand(
    ["review", "request", fx.task.id, "--role", "reviewer"],
    fx.store,
    fx.leaderOptions
  ).data.reviewRound;
  addCommittedHead(fx, COMMIT("d"));
  const before = taskStateSnapshot(fx);
  assert.throws(
    () => runTaskCommand(
      ["review", "request", fx.task.id, "--role", "reviewer"],
      fx.store,
      fx.leaderOptions
    ),
    /active|conflicting|frozen|head/i
  );
  assert.equal(fx.store.getReviewRound(fx.task.id, first.id).status, "pending");
  assert.deepEqual(taskStateSnapshot(fx), before);
});

test("explicit Task-final Review freezes a bound Project without Integration provenance", (t) => {
  const fx = fixture(t, ["project-1"]);
  setGlobalReviewConfig(fx, undefined);
  const missingProject = createProject(
    "project-2",
    "two",
    join(fx.root, "project-2"),
    { stable: "main", development: "main" },
    NOW
  );
  fx.store.transaction((tx) => {
    tx.saveProject(missingProject);
    const task = tx.getTask(fx.task.id);
    tx.saveTask({
      ...task,
      projectBindings: [
        ...task.projectBindings,
        { projectId: missingProject.id, directory: missingProject.name, baseRef: "main" }
      ]
    });
  });
  fx.task = fx.store.getTask(fx.task.id);
  setActualTaskHeads(fx, [COMMIT("c"), COMMIT("e")]);

  const round = runTaskCommand(
    ["review", "request", fx.task.id, "--role", "reviewer"],
    fx.store,
    fx.leaderOptions
  ).data.reviewRound;
  assert.equal(round.status, "pending");
  assert.deepEqual(
    round.taskCandidate.projects,
    [
      { projectId: "project-1", commit: COMMIT("c") },
      { projectId: "project-2", commit: COMMIT("e") }
    ]
  );
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
});

test("explicit Task-final Review evidence is required for completion after exact heads complete", (t) => {
  const fx = fixture(t, ["project-1"]);
  setGlobalReviewConfig(fx, { roleName: "reviewer", trigger: "leader" });
  const round = runTaskCommand(
    ["review", "request", fx.task.id, "--role", "reviewer"],
    fx.store,
    fx.leaderOptions
  ).data.reviewRound;
  const run = dispatchFinal(fx, round);
  assert.equal(terminalize(fx, run, "yielded", "review passed").disposition, "applied");
  setGlobalReviewConfig(fx, undefined);
  runTaskCommand(["complete", fx.task.id, "--summary", "complete explicit review"], fx.store, fx.leaderOptions);
  assert.equal(fx.store.getTask(fx.task.id).status, "completed");
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
});

test("explicit Task-final pending, running, failed, and mismatched evidence never bypasses completion", (t) => {
  const fx = fixture(t, ["project-1"]);
  setGlobalReviewConfig(fx, undefined);
  const round = runTaskCommand(
    ["review", "request", fx.task.id, "--role", "reviewer"],
    fx.store,
    fx.leaderOptions
  ).data.reviewRound;
  assert.throws(
    () => runTaskCommand(["complete", fx.task.id, "--summary", "pending must block"], fx.store, fx.leaderOptions),
    /Final Task Review is still active/i
  );
  const run = dispatchFinal(fx, round);
  assert.throws(
    () => runTaskCommand(["complete", fx.task.id, "--summary", "running must block"], fx.store, fx.leaderOptions),
    /Final Task Review is still active|active run for Role reviewer/i
  );
  assert.equal(terminalize(fx, run, "failed", "review failed").disposition, "applied");
  const failed = runTaskCommand(
    ["complete", fx.task.id, "--summary", "failed must block"],
    fx.store,
    fx.leaderOptions
  );
  assert.equal(failed.data.reviewRound.id, round.id);
  assert.equal(failed.data.reviewRound.status, "failed");
  assert.equal(fx.store.getTask(fx.task.id).status, "active");

  addCommittedHead(fx, COMMIT("d"));
  const mismatched = runTaskCommand(
    ["complete", fx.task.id, "--summary", "mismatched must re-review"],
    fx.store,
    fx.leaderOptions
  );
  assert.equal(mismatched.data.reviewRound.status, "pending");
  assert.equal(mismatched.data.reviewRound.requestedBy, "leader");
  assert.notEqual(mismatched.data.reviewRound.id, round.id);
  assert.equal(fx.store.getTask(fx.task.id).status, "active");
});

test("explicit failed Task-final evidence keeps no-Run and failed-Run retries separate", (t) => {
  const noRun = fixture(t, ["project-1"]);
  setGlobalReviewConfig(noRun, undefined);
  const noRunRound = runTaskCommand(
    ["review", "request", noRun.task.id, "--role", "reviewer"],
    noRun.store,
    noRun.leaderOptions
  ).data.reviewRound;
  noRun.store.saveReviewRound(noRun.task.id, finishReviewRound(
    noRunRound,
    "failed",
    "failed before Reviewer Run",
    NOW
  ));
  const noRunRetry = runTaskCommand(
    ["review", "retry", `${noRun.task.id}/${noRunRound.id}`],
    noRun.store,
    noRun.leaderOptions
  ).data.reviewRound;
  assert.equal(noRunRetry.requestedBy, "leader");
  assert.equal(noRunRetry.reviewerRunId, undefined);

  const failedRun = fixture(t, ["project-1"]);
  setGlobalReviewConfig(failedRun, undefined);
  const failedRunRound = runTaskCommand(
    ["review", "request", failedRun.task.id, "--role", "reviewer"],
    failedRun.store,
    failedRun.leaderOptions
  ).data.reviewRound;
  const failedRunRun = dispatchFinal(failedRun, failedRunRound);
  assert.equal(terminalize(failedRun, failedRunRun, "failed", "provider failed").disposition, "applied");
  const failedRunRetry = runTaskCommand(
    ["run", "retry", failedRunRun.id],
    failedRun.store,
    failedRun.leaderOptions
  ).data.reviewRound;
  assert.equal(failedRunRetry.requestedBy, "leader");
  assert.notEqual(failedRunRetry.id, failedRunRound.id);
});

test("explicit Task-final Review request rejects moved evidence during final dispatch", (t) => {
  const fx = fixture(t, ["project-1"]);
  setGlobalReviewConfig(fx, undefined);
  const round = runTaskCommand(
    ["review", "request", fx.task.id, "--role", "reviewer"],
    fx.store,
    fx.leaderOptions
  ).data.reviewRound;
  attachWorkspace(fx, round);
  addCommittedHead(fx, COMMIT("d"));
  assert.throws(
    () => dispatchPreparedReviewRound(fx.task.id, round.id, fx.store, fx.leaderOptions),
    /frozen integrated heads changed/i
  );
  assert.equal(fx.store.getReviewRound(fx.task.id, round.id).status, "pending");
  assert.equal(fx.store.listAgentRuns(fx.task.id).length, 0);
});

test("retry rejects a policy WorkItem ReviewRound", (t) => {
  const fx = fixture(t, ["project-1"], { candidateSnapshot: true });
  runTaskCommand(["role", "add", fx.task.id, "reviewer"], fx.store, { now: () => NOW });
  const workItemRound = createReviewRound(
    "review-round-2",
    fx.task.id,
    fx.item.id,
    fx.item.candidates.at(-1).id,
    "reviewer",
    "policy",
    COMMIT("b"),
    NOW
  );
  fx.store.saveReviewRound(fx.task.id, workItemRound);
  const run = dispatchFinal(fx, workItemRound);
  terminalize(fx, run);
  assert.throws(
    () => runTaskCommand(["run", "retry", run.id], fx.store, fx.leaderOptions),
    /not a Task-final review/i
  );
});

test("review terminalization rejects absent and unrelated mailbox state without mutation", (t) => {
  const fx = fixture(t, ["project-1"]);
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  const run = dispatchFinal(fx, round);
  const roleTarget = { kind: "role", taskId: fx.task.id, roleName: run.roleName };
  const beforeRun = structuredClone(fx.store.getAgentRun(fx.task.id, run.id));
  const beforeRound = structuredClone(fx.store.getReviewRound(fx.task.id, round.id));
  fx.store.removeWorkMailbox(roleTarget);
  const absent = terminalize(fx, run);
  assert.equal(absent.disposition, "obsolete");
  assert.deepEqual(fx.store.getAgentRun(fx.task.id, run.id), beforeRun);
  assert.deepEqual(fx.store.getReviewRound(fx.task.id, round.id), beforeRound);

  fx.store.transaction((tx) => {
    enqueueWork(tx, roleTarget, "unrelated", NOW, [{ type: "work-item", taskId: fx.task.id, id: fx.item.id }]);
  });
  const unrelated = terminalize(fx, run);
  assert.equal(unrelated.disposition, "obsolete");
  assert.deepEqual(fx.store.getAgentRun(fx.task.id, run.id), beforeRun);
  assert.deepEqual(fx.store.getReviewRound(fx.task.id, round.id), beforeRound);
});

test("review terminalization fences a pending Run ref from another Task", (t) => {
  const fx = fixture(t, ["project-1"]);
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  const run = dispatchFinal(fx, round);
  const roleTarget = { kind: "role", taskId: fx.task.id, roleName: run.roleName };
  const beforeRun = structuredClone(fx.store.getAgentRun(fx.task.id, run.id));
  const beforeRound = structuredClone(fx.store.getReviewRound(fx.task.id, round.id));
  fx.store.removeWorkMailbox(roleTarget);
  fx.store.transaction((tx) => {
    const foreignTask = activateTask(createTask("task-foreign", "foreign", NOW), NOW);
    tx.saveTask(foreignTask);
    const {
      reviewRoundId: _reviewRoundId,
      workspace: _workspace,
      workItemId: _workItemId,
      ...runWithoutReview
    } = run;
    const {
      reviewRoundId: _effectiveReviewRoundId,
      reviewBaseCommit: _effectiveReviewBaseCommit,
      ...effectiveWithoutReview
    } = run.effective;
    tx.saveAgentRun({
      ...runWithoutReview,
      taskId: foreignTask.id,
      purpose: "execution",
      effective: {
        ...effectiveWithoutReview,
        workspace: { root: fx.root, entries: [] }
      }
    });
    enqueueWork(tx, roleTarget, "wrong-task", NOW, [
      { type: "run", taskId: "task-foreign", id: run.id }
    ]);
  });
  assert.equal(terminalize(fx, run).disposition, "obsolete");
  assert.deepEqual(fx.store.getAgentRun(fx.task.id, run.id), beforeRun);
  assert.deepEqual(fx.store.getReviewRound(fx.task.id, round.id), beforeRound);
});

test("exact pending review dispatch settles mailbox and terminal Round atomically", (t) => {
  const fx = fixture(t, ["project-1"]);
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  const run = dispatchFinal(fx, round);
  assert.equal(terminalize(fx, run, "yielded", "review passed").disposition, "applied");
  assert.equal(fx.store.getReviewRound(fx.task.id, round.id).status, "completed");
  assert.equal(fx.store.getWorkMailbox({ kind: "role", taskId: fx.task.id, roleName: run.roleName }).pending, null);
});

test("normal execution and Leader terminalization retain absent-mailbox behavior", (t) => {
  const fx = fixture(t, ["project-1"]);
  const { review: _review, ...withoutReview } = fx.store.getConfig();
  fx.store.saveConfig(withoutReview);
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  assert.equal(fx.store.getTask(fx.task.id).status, "completed");
});

test("pre-delivery review launch failure settles its exact pending dispatch", (t) => {
  const fx = fixture(t, ["project-1"]);
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  const run = dispatchFinal(fx, round);
  const adapter = new FileSchedulerStoreAdapter(fx.store);
  const role = adapter.getRole(fx.task.id, run.roleName);
  assert.equal(adapter.saveExitedRoleRun({
    task: adapter.getTask(fx.task.id),
    role,
    run,
    session: adapter.getRoleSession(fx.task.id, run.roleName),
    summary: "launch failed before provider delivery",
    now: NOW
  }), "failed");
  assert.equal(fx.store.getReviewRound(fx.task.id, round.id).status, "failed");
  assert.equal(fx.store.getWorkMailbox({ kind: "role", taskId: fx.task.id, roleName: run.roleName }).pending, null);
});

test("terminal ReviewRound leaves every record bit-identical", (t) => {
  const fx = fixture(t, ["project-1"]);
  runTaskCommand(["complete", fx.task.id, "--summary", "finish"], fx.store, fx.leaderOptions);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  const run = dispatchFinal(fx, round);
  const terminalRound = finishReviewRound(fx.store.getReviewRound(fx.task.id, round.id), "failed", "already failed", NOW);
  fx.store.saveReviewRound(fx.task.id, terminalRound);
  const beforeRun = structuredClone(fx.store.getAgentRun(fx.task.id, run.id));
  const beforeMailbox = structuredClone(fx.store.getWorkMailbox({ kind: "role", taskId: fx.task.id, roleName: run.roleName }));
  const result = terminalize(fx, run);
  assert.equal(result.disposition, "obsolete");
  assert.deepEqual(fx.store.getAgentRun(fx.task.id, run.id), beforeRun);
  assert.deepEqual(fx.store.getWorkMailbox({ kind: "role", taskId: fx.task.id, roleName: run.roleName }), beforeMailbox);
});

test("isolated temporary YUI_HOME CLI prepares and dispatches a Task-final ReviewRound", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-task13-cli-e2e-"));
  const home = join(root, "home");
  t.after(async () => {
    await stopFileTaskController(home);
    rmSync(root, { recursive: true, force: true });
  });
  const repository = join(root, "repository");
  mkdirSync(repository, { recursive: true });
  execFileSync("git", ["-C", repository, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "task13@example.invalid"]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Task 13"]);
  const file = join(repository, "README.md");
  writeFileSync(file, "Task-final CLI fixture\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "commit", "-q", "-m", "fixture"]);
  const head = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);
  const fakeCodex = join(root, "codex-test.cjs");
  const cliEntry = join(process.cwd(), "dist", "cli.js");
  writeFileSync(fakeCodex, `
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const started = spawnSync(process.execPath, [${JSON.stringify(cliEntry)}, "internal", "codex-hook"], {
  encoding: "utf8",
  env: process.env,
  input: JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: "codex-test-" + process.env.YUI_RUN_ID
  })
});
if (started.status !== 0) {
  process.stderr.write(started.stderr || started.stdout || "mock Codex startup hook failed\\n");
  process.exit(started.status ?? 1);
}
const discovery = join(process.env.YUI_HOME, "runtime", "controller.json");
const poll = setInterval(() => {
  if (!existsSync(discovery)) process.exit(0);
}, 10);
setTimeout(() => {
  clearInterval(poll);
  process.exit(0);
}, 10_000);
`);
  const codex = createConfiguredAgent(
    "codex-test",
    "codex",
    process.execPath,
    [fakeCodex],
    [],
    NOW
  );
  const binding = createRoleAgentBinding(codex);
  const project = createProject("project-1", "one", repository, { stable: "main", development: "main" }, NOW);
  const task = activateTask(createTask("task-1", "CLI Task-final", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: "main" }],
    requireIntegration: true
  }), NOW);
  store.transaction((tx) => {
    tx.saveConfig({
      schemaVersion: 1,
      defaultAgent: codex.id,
      defaultWorkspace: root,
      review: { roleName: "reviewer", trigger: "final" }
    });
    tx.saveConfiguredAgent(codex);
    tx.saveProject(project);
    tx.saveGlobalRole(createGlobalRole("leader", [binding], codex.id, root, NOW));
    tx.saveGlobalRole(createGlobalRole("reviewer", [binding], codex.id, root, NOW));
    tx.saveGlobalRole(createGlobalRole("worker", [binding], codex.id, root, NOW));
    tx.saveTask(task);
    tx.saveRole(task.id, createRole(task.id, "leader", [binding], codex.id, root, NOW));
    let item = createWorkItem("work-item-1", task.id, { title: "integrated change" }, NOW);
    item = updateWorkItemStatus(item, "running", NOW);
    tx.saveWorkItem(task.id, item);
    item = submitWorkItemCandidate(item, {
      summary: "CLI candidate",
      source: { type: "direct" }
    }, NOW);
    tx.saveWorkItem(task.id, item);
    tx.saveWorkItem(task.id, updateWorkItemStatus(item, "completed", NOW, "accepted"));
    tx.saveChangeSet(task.id, createWorkItemChangeSet({
      id: "change-set-1",
      taskId: task.id,
      projectId: project.id,
      workItemId: item.id,
      baseCommit: COMMIT("a"),
      headCommit: head,
      branch: "yui/task-1/work-item-1",
      changedPaths: ["README.md"]
    }, NOW));
    const integration = createIntegrationAttempt({
      id: "integration-1",
      taskId: task.id,
      projectId: project.id,
      targetRef: "main",
      expectedHead: COMMIT("a"),
      changeSetIds: ["change-set-1"],
      checkCommands: []
    }, NOW);
    tx.saveIntegrationAttempt(task.id, updateIntegrationAttempt(
      integration,
      { status: "committed", candidateCommit: head },
      NOW
    ));
  });
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);
  const invocation = exactTaskCliInvocation({
    home,
    store,
    taskId: task.id,
    roleName: "leader",
    environment: isolatedCliEnvironment(home)
  });
  const result = runIsolatedCliJson(
    home,
    [...invocation.prefix, "--json", "task", "complete", task.id, "--summary", "finish"],
    invocation.environment
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.reviewRound.scope, "task");
  assert.equal(result.data.reviewRound.taskCandidate.projects[0].commit, head);
  assert.equal(result.data.reviewRun.purpose, "review");
  assert.equal(result.data.workspace.owner.reviewRoundId, result.data.reviewRound.id);
  assert.match(result.data.reviewRun.input, /Project Policy pointers:.*yui project show project-1/);
});

function runIsolatedCliJson(home, args, environment) {
  return JSON.parse(execFileSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), ...args],
    { encoding: "utf8", env: environment }
  ));
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
