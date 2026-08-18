import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import {
  dispatchPreparedReviewRound,
  runTaskCommand
} from "../../dist/commands/taskCommands.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import { createIntegrationAttempt, updateIntegrationAttempt } from "../../dist/integration/integrationAttempt.js";
import { terminalizeExactTaskRun } from "../../dist/lifecycle/exactRunTerminalization.js";
import { createProject } from "../../dist/repository/project.js";
import {
  createGlobalRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../../dist/role/role.js";
import { createAgentRun, failAgentRun, yieldAgentRun } from "../../dist/run/agentRun.js";
import {
  attachReviewExecutionGroup,
  attachReviewRoundWorkspace,
  createReviewRound,
  createTaskReviewRound,
  finishReviewRound
} from "../../dist/review/reviewRound.js";
import { createExecutionGroup } from "../../dist/execution/executionGroup.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { formatAgentRunReceiptId } from "../../dist/task/taskRecordReference.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { submitWorkItemCandidate, updateWorkItemStatus } from "../../dist/workItem/workItem.js";

const NOW = new Date("2026-08-08T00:00:00.000Z");
const EXITED_REVIEW_SUMMARY = "The role's tmux session exited before the run yielded.";

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "yui-final-review-"));
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
    tx.saveGlobalRole(createGlobalRole(
      "leader", [createRoleAgentBinding(codex)], codex.id, root, NOW
    ));
    tx.saveGlobalRole(createGlobalRole(
      "reviewer", [createRoleAgentBinding(codex)], codex.id, root, NOW
    ));
    for (const [id, name] of [["project-1", "one"], ["project-2", "two"]]) {
      const projectPath = join(root, name);
      mkdirSync(projectPath, { recursive: true });
      tx.saveProject(createProject(id, name, projectPath, { stable: "main", development: "main" }, NOW));
    }
  });
  runTaskCommand([
    "create", "delivery", "--project", "project-1", "--project", "project-2",
    "--require-integration"
  ], store, { now: () => NOW });
  const task = store.getTask("task-1");
  runTaskCommand(["activate", task.id], store, { now: () => NOW });
  if (options.producerRunRoleName !== undefined) {
    runTaskCommand(
      ["role", "add", task.id, options.producerRunRoleName, "--agent", codex.id],
      store,
      { now: () => NOW }
    );
  }
  runTaskCommand([
    "work", "create", task.id, "change",
    ...(options.producerRunRoleName === undefined
      ? []
      : ["--role", options.producerRunRoleName])
  ], store, { now: () => NOW });
  const item = store.getWorkItem(task.id, "work-item-1");
  const leaderOptions = {
    now: () => NOW,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    },
    actualTaskReviewCandidate: {
      schemaVersion: 1,
      projects: [
        { projectId: "project-1", commit: "c".repeat(40) },
        { projectId: "project-2", commit: "d".repeat(40) }
      ]
    }
  };
  if (options.producerRunRoleName === undefined) {
    runTaskCommand(["work", "update", item.id, "running"], store, leaderOptions);
  }
  store.transaction((tx) => {
    const current = tx.getWorkItem(task.id, item.id);
    const running = options.producerRunRoleName === undefined
      ? current
      : updateWorkItemStatus(current, "running", NOW);
    if (options.producerRunRoleName !== undefined) {
      tx.saveWorkItem(task.id, running);
    }
    let source = { type: "direct" };
    if (options.producerRunRoleName !== undefined) {
      const producer = tx.getRole(task.id, options.producerRunRoleName);
      const producerRun = createAgentRun(
        tx.nextAgentRunId(task.id),
        task.id,
        producer.name,
        "new",
        "produce integrated candidate",
        NOW,
        {
          workItemId: item.id,
          effective: resolveEffectiveLaunch({
            role: producer,
            purpose: "execution",
            workItemWriteProjectIds: running.writeProjectIds
          })
        }
      );
      tx.saveAgentRun(yieldAgentRun(producerRun, "integrated candidate", NOW));
      source = { type: "run", runId: producerRun.id };
    }
    const candidate = submitWorkItemCandidate(running, {
      summary: "integrated candidate",
      source
    }, NOW);
    tx.saveWorkItem(task.id, candidate);
    tx.saveWorkItem(task.id, updateWorkItemStatus(candidate, "completed", NOW, "accepted"));
    const integratedProjectIds = options.integratedProjectIds
      ?? ["project-1", "project-2"];
    for (const [index, projectId] of ["project-1", "project-2"].entries()) {
      if (!integratedProjectIds.includes(projectId)) continue;
      const baseCommit = String.fromCharCode(97 + index).repeat(40);
      const headCommit = String.fromCharCode(99 + index).repeat(40);
      const changeSetId = `change-set-${index + 1}`;
      tx.saveChangeSet(task.id, createWorkItemChangeSet({
        id: changeSetId,
        taskId: task.id,
        projectId,
        workItemId: item.id,
        baseCommit,
        headCommit,
        branch: `yui/task-11/work-item-1-${index + 1}`,
        changedPaths: [`${projectId}/change.ts`]
      }, NOW));
      const attempt = createIntegrationAttempt({
        id: `integration-${index + 1}`,
        taskId: task.id,
        projectId,
        targetRef: `yui/task-11/main-${index + 1}`,
        expectedHead: baseCommit,
        changeSetIds: [changeSetId],
        checkCommands: []
      }, NOW);
      tx.saveIntegrationAttempt(task.id, updateIntegrationAttempt(
        attempt, { status: "committed", candidateCommit: headCommit }, NOW
      ));
    }
  });
  return { root, store, task, item, leaderOptions };
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

function dispatchFinalReview(fx, round) {
  const bindings = new Map(fx.task.projectBindings.map((binding) => (
    [binding.projectId, binding]
  )));
  const workspaceRoot = join(fx.root, "reviews", round.id);
  const workspace = createManagedWorkspace({
    owner: { type: "review-round", taskId: fx.task.id, reviewRoundId: round.id },
    root: workspaceRoot,
    entries: round.taskCandidate.projects.map(({ projectId, commit }, index) => ({
      projectId,
      directory: bindings.get(projectId).directory,
      access: "write",
      path: join(workspaceRoot, bindings.get(projectId).directory),
      branch: `yui/${fx.task.id}/${round.id}-${index + 1}`,
      baseRef: commit,
      baseCommit: commit
    }))
  }, NOW);
  fx.store.transaction((tx) => {
    tx.saveManagedWorkspace(workspace);
    tx.saveReviewRound(
      fx.task.id,
      attachReviewRoundWorkspace(round, workspace)
    );
  });
  return dispatchPreparedReviewRound(
    fx.task.id,
    round.id,
    fx.store,
    fx.leaderOptions
  );
}

function finishFinalReviewRun(fx, run, status, summary, reviewResult = undefined) {
  fx.store.transaction((tx) => {
    const result = terminalizeExactTaskRun(tx, {
      taskId: fx.task.id,
      roleName: run.roleName,
      agentId: run.effective.agentId,
      runId: run.id,
      receiptId: formatAgentRunReceiptId(fx.task.id, run.id),
      outcome: { status, summary },
      ...(reviewResult === undefined ? {} : { reviewResult })
    }, NOW);
    assert.equal(result.disposition, "applied");
  });
}

function strandFinalReviewRun(fx, run, summary = EXITED_REVIEW_SUMMARY) {
  fx.store.transaction((tx) => {
    tx.saveAgentRun(failAgentRun(run, summary, NOW));
    tx.clearActiveAgentRun(fx.task.id, run.roleName);
    tx.saveRole(
      fx.task.id,
      updateRoleStatus(tx.getRole(fx.task.id, run.roleName), "exited", NOW)
    );
  });
}

function createLaterFinalRound(fx, previousRound, taskCandidate) {
  return fx.store.transaction((tx) => {
    const round = createTaskReviewRound(
      tx.nextReviewRoundId(fx.task.id),
      fx.task.id,
      previousRound.workItemId,
      previousRound.candidateId,
      previousRound.reviewerRoleName,
      "leader",
      taskCandidate,
      NOW
    );
    tx.saveReviewRound(fx.task.id, round);
    return round;
  });
}

function strandTaskFinalReview(fx) {
  runTaskCommand(
    ["complete", fx.task.id, "--summary", "request old-head review"],
    fx.store,
    fx.leaderOptions
  );
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  const run = dispatchFinalReview(fx, round);
  strandFinalReviewRun(fx, run);
  return { round, run };
}

function advanceTaskCandidate(fx) {
  fx.store.transaction((tx) => {
    const baseCommit = "d".repeat(40);
    const headCommit = "e".repeat(40);
    tx.saveChangeSet(fx.task.id, createWorkItemChangeSet({
      id: "change-set-3",
      taskId: fx.task.id,
      projectId: "project-2",
      workItemId: fx.item.id,
      baseCommit,
      headCommit,
      branch: "yui/task-11/work-item-2",
      changedPaths: ["project-2/fix.ts"]
    }, NOW));
    const attempt = createIntegrationAttempt({
      id: "integration-3",
      taskId: fx.task.id,
      projectId: "project-2",
      targetRef: "yui/task-11/main-2",
      expectedHead: baseCommit,
      changeSetIds: ["change-set-3"],
      checkCommands: []
    }, NOW);
    tx.saveIntegrationAttempt(fx.task.id, updateIntegrationAttempt(
      attempt, { status: "committed", candidateCommit: headCommit }, NOW
    ));
  });
  setActualTaskHeads(fx, ["c".repeat(40), "e".repeat(40)]);
}

function setReviewConfig(fx, review) {
  fx.store.transaction((tx) => {
    const { review: _previousReview, ...config } = tx.getConfig();
    tx.saveConfig(review === undefined ? config : { ...config, review });
  });
}

function failFinalReviewBeforeRun(fx) {
  const globalReviewer = fx.store.getGlobalRole("reviewer");
  assert.notEqual(globalReviewer, null);
  assert.equal(fx.store.removeGlobalRole("reviewer"), true);
  const completion = runTaskCommand(
    ["complete", fx.task.id, "--summary", "request final review"],
    fx.store,
    fx.leaderOptions
  );
  const round = fx.store.listReviewRounds(fx.task.id).at(-1);
  assert.match(completion.output, /Final Task Review is blocked/);
  assert.equal(round.status, "failed");
  assert.equal(round.reviewerRunId, undefined);
  assert.match(round.summary, /Global Role not found/);
  return { globalReviewer, round };
}

function addCompletedDirectWorkItem(fx, title, assignee = undefined) {
  if (assignee !== undefined && fx.store.getRole(fx.task.id, assignee) === null) {
    runTaskCommand(
      ["role", "add", fx.task.id, assignee, "--agent", "codex"],
      fx.store,
      fx.leaderOptions
    );
  }
  runTaskCommand([
    "work", "create", fx.task.id, title,
    ...(assignee === undefined ? [] : ["--role", assignee])
  ], fx.store, fx.leaderOptions);
  const item = fx.store.listWorkItems(fx.task.id).at(-1);
  if (assignee === undefined) {
    runTaskCommand(["work", "update", item.id, "running"], fx.store, fx.leaderOptions);
  }
  fx.store.transaction((tx) => {
    const current = tx.getWorkItem(fx.task.id, item.id);
    const running = assignee === undefined
      ? current
      : updateWorkItemStatus(current, "running", NOW);
    if (assignee !== undefined) tx.saveWorkItem(fx.task.id, running);
    const summary = `${title} candidate`;
    let source = { type: "direct" };
    if (assignee !== undefined) {
      const producer = tx.getRole(fx.task.id, assignee);
      const run = createAgentRun(
        tx.nextAgentRunId(fx.task.id),
        fx.task.id,
        producer.name,
        "new",
        `produce ${title}`,
        NOW,
        {
          workItemId: item.id,
          effective: resolveEffectiveLaunch({
            role: producer,
            purpose: "execution",
            workItemWriteProjectIds: running.writeProjectIds
          })
        }
      );
      tx.saveAgentRun(yieldAgentRun(run, summary, NOW));
      source = { type: "run", runId: run.id };
    }
    const candidate = submitWorkItemCandidate(running, {
      summary,
      source
    }, NOW);
    tx.saveWorkItem(fx.task.id, candidate);
    tx.saveWorkItem(
      fx.task.id,
      updateWorkItemStatus(candidate, "completed", NOW, `${title} accepted`)
    );
  });
  return fx.store.getWorkItem(fx.task.id, item.id);
}

function integrateProducerAfterCurrentHeads(fx, item, options = {}) {
  const headCommits = (options.headCommits ?? ["e", "f"])
    .map((value) => value.repeat(40));
  fx.store.transaction((tx) => {
    for (const [index, projectId] of ["project-1", "project-2"].entries()) {
      const baseCommit = String.fromCharCode(99 + index).repeat(40);
      const headCommit = headCommits[index];
      const expectedHead = (options.expectedHeads ?? ["c", "d"])[index].repeat(40);
      const changeSetId = tx.nextChangeSetId(fx.task.id);
      tx.saveChangeSet(fx.task.id, createWorkItemChangeSet({
        id: changeSetId,
        taskId: fx.task.id,
        projectId,
        workItemId: item.id,
        baseCommit,
        headCommit,
        branch: `yui/task-1/${item.id}-${index + 1}`,
        changedPaths: [`${projectId}/${item.id}.ts`]
      }, NOW));
      const attempt = createIntegrationAttempt({
        id: tx.nextIntegrationAttemptId(fx.task.id),
        taskId: fx.task.id,
        projectId,
        targetRef: `yui/task-11/main-${index + 1}`,
        expectedHead,
        changeSetIds: [changeSetId],
        checkCommands: []
      }, NOW);
      tx.saveIntegrationAttempt(fx.task.id, updateIntegrationAttempt(
        attempt, { status: "committed", candidateCommit: headCommit }, NOW
      ));
    }
  });
  setActualTaskHeads(fx, headCommits);
}

function recordIntegrationAttempt(fx, item, input) {
  const timestamp = input.now ?? NOW;
  return fx.store.transaction((tx) => {
    const changeSetId = tx.nextChangeSetId(fx.task.id);
    tx.saveChangeSet(fx.task.id, createWorkItemChangeSet({
      id: changeSetId,
      taskId: fx.task.id,
      projectId: input.projectId,
      workItemId: item.id,
      baseCommit: input.changeSetBase,
      headCommit: input.changeSetHead,
      branch: `yui/task-1/${item.id}-${changeSetId}`,
      changedPaths: [`${input.projectId}/${changeSetId}.ts`]
    }, timestamp));
    const attempt = createIntegrationAttempt({
      id: tx.nextIntegrationAttemptId(fx.task.id),
      taskId: fx.task.id,
      projectId: input.projectId,
      targetRef: input.targetRef,
      expectedHead: input.expectedHead,
      changeSetIds: [changeSetId],
      checkCommands: []
    }, timestamp);
    const stored = input.status === "running"
      ? attempt
      : updateIntegrationAttempt(attempt, {
          status: input.status,
          ...(input.candidateCommit === undefined
            ? {}
            : { candidateCommit: input.candidateCommit })
        }, timestamp);
    tx.saveIntegrationAttempt(fx.task.id, stored);
    return stored;
  });
}

function withMissingProducerProvenance(store, input) {
  return new Proxy(store, {
    get(target, property) {
      if (property === "transaction") {
        return (callback) => target.transaction((tx) => callback(new Proxy(tx, {
          get(transaction, transactionProperty) {
            if (transactionProperty === "getChangeSet") {
              return (taskId, changeSetId) => {
                const changeSet = transaction.getChangeSet(taskId, changeSetId);
                return input.kind === "change-set" && changeSetId === input.changeSetId
                  ? null
                  : changeSet;
              };
            }
            if (transactionProperty === "getWorkItem") {
              return (taskId, workItemId) => {
                const item = transaction.getWorkItem(taskId, workItemId);
                if (workItemId !== input.workItemId || item === null) return item;
                if (input.kind === "work-item") return null;
                if (input.kind === "candidate") return { ...item, candidates: [] };
                if (input.kind !== "run") return item;
                return {
                  ...item,
                  candidates: item.candidates.map((candidate, index) => (
                    index === item.candidates.length - 1
                      ? {
                          ...candidate,
                          source: { type: "run", runId: "agent-run-999" }
                        }
                      : candidate
                  ))
                };
              };
            }
            const value = Reflect.get(transaction, transactionProperty, transaction);
            return typeof value === "function" ? value.bind(transaction) : value;
          }
        })));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function withoutAnchorCandidate(store, taskId, workItemId) {
  return new Proxy(store, {
    get(target, property) {
      if (property === "transaction") {
        return (callback) => target.transaction((tx) => callback(new Proxy(tx, {
          get(transaction, transactionProperty) {
            if (transactionProperty === "getWorkItem") {
              return (requestedTaskId, requestedWorkItemId) => {
                const item = transaction.getWorkItem(requestedTaskId, requestedWorkItemId);
                return requestedTaskId === taskId && requestedWorkItemId === workItemId
                  ? { ...item, candidates: [] }
                  : item;
              };
            }
            const value = Reflect.get(transaction, transactionProperty, transaction);
            return typeof value === "function" ? value.bind(transaction) : value;
          }
        })));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

test("Leader retries one failed no-Run final ReviewRound under the same Round ID", (t) => {
  const fx = fixture(t);
  const { globalReviewer, round: failedRound } = failFinalReviewBeforeRun(fx);
  fx.store.saveGlobalRole(globalReviewer);

  const retried = runTaskCommand(
    ["work", "review", "retry", failedRound.id],
    fx.store,
    fx.leaderOptions
  );

  assert.equal(retried.kind, "output");
  assert.match(retried.output, /Task-final Review retry requested/);
  const rounds = fx.store.listReviewRounds(fx.task.id);
  // Issue 06: infra retry reuses the same semantic Round ID; no new Round row.
  assert.equal(rounds.length, 1);
  const retryRound = rounds[0];
  assert.equal(retryRound.id, failedRound.id);
  assert.equal(retryRound.status, "pending");
  assert.equal(retryRound.requestedBy, "leader");
  assert.deepEqual(retryRound.taskCandidate, failedRound.taskCandidate);
  assert.equal(retryRound.workItemId, failedRound.workItemId);
  assert.equal(retryRound.candidateId, failedRound.candidateId);
  assert.equal(retryRound.reviewerRoleName, failedRound.reviewerRoleName);
  // The failed attempt's terminal metadata is cleared; candidate identity is preserved.
  assert.equal(retryRound.report, undefined);
  assert.equal(retryRound.endedAt, undefined);

  const repeated = runTaskCommand(
    ["work", "review", "retry", failedRound.id],
    fx.store,
    fx.leaderOptions
  );
  assert.match(repeated.output, /already requested/);
  assert.equal(repeated.data.reviewRound.id, retryRound.id);
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);

  const retryRun = dispatchFinalReview(fx, retryRound);
  assert.equal(retryRun.purpose, "review");
  assert.equal(retryRun.reviewRoundId, retryRound.id);
  assert.equal(retryRun.roleName, failedRound.reviewerRoleName);
  assert.equal(
    fx.store.listAgentRuns(fx.task.id).filter(({ purpose }) => purpose === "review").length,
    1
  );
  // After dispatch the Round carries a Reviewer Run; `task review retry`
  // correctly defers to `task run retry` for that path.
  assert.throws(
    () => runTaskCommand(
      ["work", "review", "retry", failedRound.id],
      fx.store,
      fx.leaderOptions
    ),
    /has Reviewer Run .*use task run retry/i
  );
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
});

test("no-Run final Review retry is exact-Leader-only and rejects nonfailed or nonfinal Rounds", (t) => {
  const failed = fixture(t);
  const { round: failedRound } = failFinalReviewBeforeRun(failed);
  const frozenFailedRound = structuredClone(failedRound);
  assert.throws(
    () => runTaskCommand(
      ["work", "review", "retry", `${failed.task.id}/${failedRound.id}`],
      failed.store,
      { now: () => NOW }
    ),
    /Only the Task Leader/i
  );
  assert.throws(
    () => runTaskCommand(
      ["work", "review", "retry", `task-2/${failedRound.id}`],
      failed.store,
      failed.leaderOptions
    ),
    /ReviewRound not found/i
  );
  assert.deepEqual(
    failed.store.getReviewRound(failed.task.id, failedRound.id),
    frozenFailedRound
  );

  const pending = fixture(t);
  runTaskCommand(
    ["complete", pending.task.id, "--summary", "request pending review"],
    pending.store,
    pending.leaderOptions
  );
  const pendingRound = pending.store.listReviewRounds(pending.task.id)[0];
  // Issue 06: a pending Round is the idempotent retry result, not an error.
  const pendingRetry = runTaskCommand(
    ["work", "review", "retry", pendingRound.id],
    pending.store,
    pending.leaderOptions
  );
  assert.equal(pendingRetry.kind, "output");
  assert.match(pendingRetry.output, /already requested/);
  assert.equal(pendingRetry.data.reviewRound.id, pendingRound.id);
  assert.equal(pending.store.listReviewRounds(pending.task.id).length, 1);

  const completed = fixture(t);
  runTaskCommand(
    ["complete", completed.task.id, "--summary", "request completed review"],
    completed.store,
    completed.leaderOptions
  );
  const completedRound = completed.store.listReviewRounds(completed.task.id)[0];
  finishFinalReviewRun(
    completed,
    dispatchFinalReview(completed, completedRound),
    "yielded",
    "green",
    { report: "green", checks: [] }
  );
  assert.throws(
    () => runTaskCommand(
      ["work", "review", "retry", completedRound.id],
      completed.store,
      completed.leaderOptions
    ),
    /not retryable from completed/i
  );

  const withRun = fixture(t);
  runTaskCommand(
    ["complete", withRun.task.id, "--summary", "request dispatched review"],
    withRun.store,
    withRun.leaderOptions
  );
  const withRunRound = withRun.store.listReviewRounds(withRun.task.id)[0];
  finishFinalReviewRun(
    withRun,
    dispatchFinalReview(withRun, withRunRound),
    "failed",
    "review run failed"
  );
  assert.throws(
    () => runTaskCommand(
      ["work", "review", "retry", withRunRound.id],
      withRun.store,
      withRun.leaderOptions
    ),
    /has Reviewer Run .*use task run retry/i
  );

  const workItem = fixture(t);
  const candidate = workItem.store.getWorkItem(
    workItem.task.id,
    workItem.item.id
  ).candidates.at(-1);
  const workItemRound = finishReviewRound(createReviewRound(
    workItem.store.nextReviewRoundId(workItem.task.id),
    workItem.task.id,
    workItem.item.id,
    candidate.id,
    "reviewer",
    "leader",
    "c".repeat(40),
    NOW
  ), "failed", "work-item review failed before dispatch", NOW);
  workItem.store.saveReviewRound(workItem.task.id, workItemRound);
  assert.throws(
    () => runTaskCommand(
      ["work", "review", "retry", workItemRound.id],
      workItem.store,
      workItem.leaderOptions
    ),
    /not a failed Task-final ReviewRound/i
  );
});

test("no-Run final Review retry rejects candidate drift, unavailable anchors, and conflicts", (t) => {
  const drifted = fixture(t);
  const { globalReviewer, round: driftedRound } = failFinalReviewBeforeRun(drifted);
  drifted.store.saveGlobalRole(globalReviewer);
  advanceTaskCandidate(drifted);
  assert.throws(
    () => runTaskCommand(
      ["work", "review", "retry", driftedRound.id],
      drifted.store,
      drifted.leaderOptions
    ),
    /no longer the current Task candidate/i
  );
  assert.equal(drifted.store.listReviewRounds(drifted.task.id).length, 1);

  const unavailable = fixture(t);
  const {
    globalReviewer: unavailableReviewer,
    round: unavailableRound
  } = failFinalReviewBeforeRun(unavailable);
  unavailable.store.saveGlobalRole(unavailableReviewer);
  const unavailableStore = withoutAnchorCandidate(
    unavailable.store,
    unavailable.task.id,
    unavailableRound.workItemId
  );
  assert.throws(
    () => runTaskCommand(
      ["work", "review", "retry", unavailableRound.id],
      unavailableStore,
      unavailable.leaderOptions
    ),
    /anchor Candidate is no longer available/i
  );

  const newer = fixture(t);
  const { globalReviewer: restored, round: oldRound } = failFinalReviewBeforeRun(newer);
  newer.store.saveGlobalRole(restored);
  createLaterFinalRound(
    newer,
    { ...oldRound, reviewerRoleName: "conflicting-reviewer" },
    oldRound.taskCandidate
  );
  assert.throws(
    () => runTaskCommand(
      ["work", "review", "retry", oldRound.id],
      newer.store,
      newer.leaderOptions
    ),
    /newer conflicting final ReviewRound/i
  );
  assert.equal(newer.store.listReviewRounds(newer.task.id).length, 2);

  const active = fixture(t);
  const { globalReviewer: activeReviewer, round: activeRound } = failFinalReviewBeforeRun(active);
  active.store.saveGlobalRole(activeReviewer);
  runTaskCommand(
    ["role", "add", active.task.id, "reviewer", "--agent", "codex"],
    active.store,
    active.leaderOptions
  );
  active.store.transaction((tx) => {
    const reviewer = tx.getRole(active.task.id, "reviewer");
    const run = createAgentRun(
      tx.nextAgentRunId(active.task.id),
      active.task.id,
      reviewer.name,
      "new",
      "unrelated active review-role work",
      NOW,
      {
        workItemId: active.item.id,
        effective: resolveEffectiveLaunch({
          role: reviewer,
          purpose: "execution",
          workItemWriteProjectIds: active.item.writeProjectIds
        })
      }
    );
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    tx.saveRole(active.task.id, updateRoleStatus(reviewer, "running", NOW));
  });
  assert.throws(
    () => runTaskCommand(
      ["work", "review", "retry", activeRound.id],
      active.store,
      active.leaderOptions
    ),
    /Reviewer Role already has an active run/i
  );
  assert.equal(active.store.listReviewRounds(active.task.id).length, 1);
});

test("Task-final Reviewer checks every integrated producer instead of the latest anchor", (t) => {
  const fx = fixture(t, { producerRunRoleName: "reviewer" });
  const laterAnchor = addCompletedDirectWorkItem(fx, "later independent producer", "worker-a");
  integrateProducerAfterCurrentHeads(fx, laterAnchor);

  const completion = runTaskCommand(
    ["complete", fx.task.id, "--summary", "request final review"],
    fx.store,
    fx.leaderOptions
  );

  assert.match(completion.output, /Final Task Review is blocked/);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  assert.equal(round.workItemId, laterAnchor.id);
  assert.equal(round.status, "failed");
  assert.equal(round.reviewerRunId, undefined);
  assert.match(round.summary, /work-item-1/);
  assert.match(round.summary, /reviewer/);
  assert.equal(
    fx.store.listAgentRuns(fx.task.id).filter(({ purpose }) => purpose === "review").length,
    0
  );
});

test("Task-final Reviewer covers producers across non-Integration merge boundaries", (t) => {
  const fx = fixture(t, { producerRunRoleName: "reviewer" });
  const laterAnchor = addCompletedDirectWorkItem(fx, "post-merge independent producer", "worker-a");
  integrateProducerAfterCurrentHeads(fx, laterAnchor, { expectedHeads: ["1", "2"] });

  const completion = runTaskCommand(
    ["complete", fx.task.id, "--summary", "request final review"],
    fx.store,
    fx.leaderOptions
  );

  assert.match(completion.output, /Final Task Review is blocked/);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  assert.equal(round.status, "failed");
  assert.equal(round.reviewerRunId, undefined);
  assert.match(round.summary, /work-item-1/);
  assert.match(round.summary, /reviewer/);
  assert.equal(
    fx.store.listAgentRuns(fx.task.id).filter(({ purpose }) => purpose === "review").length,
    0
  );
});

test("Task-final producer lineage excludes noncommitted and unrelated attempts", (t) => {
  const fx = fixture(t);
  const excluded = addCompletedDirectWorkItem(fx, "excluded reviewer producer", "reviewer");
  recordIntegrationAttempt(fx, excluded, {
    projectId: "project-1",
    targetRef: "yui/task-11/main-1",
    expectedHead: "c".repeat(40),
    changeSetBase: "c".repeat(40),
    changeSetHead: "7".repeat(40),
    status: "failed"
  });
  recordIntegrationAttempt(fx, excluded, {
    projectId: "project-1",
    targetRef: "yui/task-11/main-1",
    expectedHead: "c".repeat(40),
    changeSetBase: "c".repeat(40),
    changeSetHead: "8".repeat(40),
    status: "running"
  });
  recordIntegrationAttempt(fx, excluded, {
    projectId: "project-1",
    targetRef: "yui/task-11/preview",
    expectedHead: "c".repeat(40),
    changeSetBase: "c".repeat(40),
    changeSetHead: "5".repeat(40),
    candidateCommit: "5".repeat(40),
    status: "committed"
  });
  recordIntegrationAttempt(fx, excluded, {
    projectId: "project-2",
    targetRef: "yui/task-11/main-1",
    expectedHead: "d".repeat(40),
    changeSetBase: "d".repeat(40),
    changeSetHead: "6".repeat(40),
    candidateCommit: "6".repeat(40),
    status: "committed"
  });
  recordIntegrationAttempt(fx, excluded, {
    projectId: "project-2",
    targetRef: "yui/task-11/main-2",
    expectedHead: "d".repeat(40),
    changeSetBase: "d".repeat(40),
    changeSetHead: "a".repeat(40),
    status: "failed"
  });
  const included = addCompletedDirectWorkItem(fx, "frozen independent producer", "worker-a");
  integrateProducerAfterCurrentHeads(fx, included, { expectedHeads: ["1", "2"] });
  const frozenCandidate = {
    schemaVersion: 1,
    projects: [
      { projectId: "project-1", commit: "e".repeat(40) },
      { projectId: "project-2", commit: "f".repeat(40) }
    ]
  };
  const round = createTaskReviewRound(
    fx.store.nextReviewRoundId(fx.task.id),
    fx.task.id,
    included.id,
    included.candidates.at(-1).id,
    "reviewer",
    "policy",
    frozenCandidate,
    NOW
  );
  fx.store.saveReviewRound(fx.task.id, round);

  const run = dispatchFinalReview(fx, round);

  assert.equal(run.roleName, "reviewer");
  assert.equal(run.purpose, "review");
  assert.equal(run.reviewRoundId, round.id);
});

test("merge-boundary producer provenance remains fail-closed", (t) => {
  const fx = fixture(t);
  const laterAnchor = addCompletedDirectWorkItem(fx, "post-merge producer", "worker-a");
  integrateProducerAfterCurrentHeads(fx, laterAnchor, { expectedHeads: ["1", "2"] });
  const firstChangeSet = fx.store.listChangeSets(fx.task.id).find((changeSet) => (
    changeSet.workItemId === fx.item.id && changeSet.projectId === "project-1"
  ));
  assert.notEqual(firstChangeSet, undefined);
  const cases = [
    ["change-set", /Committed Integration ChangeSet provenance is invalid/i],
    ["work-item", /Committed Integration producer WorkItem is unavailable/i],
    ["candidate", /Committed producer WorkItem has no Candidate/i],
    ["run", /Committed producer Candidate Run is unavailable/i]
  ];
  for (const [kind, expected] of cases) {
    const unavailable = withMissingProducerProvenance(fx.store, {
      kind,
      changeSetId: firstChangeSet.id,
      workItemId: fx.item.id
    });
    assert.throws(
      () => runTaskCommand(
        ["complete", fx.task.id, "--summary", "request final review"],
        unavailable,
        fx.leaderOptions
      ),
      expected
    );
    assert.equal(fx.store.listReviewRounds(fx.task.id).length, 0);
  }
});

test("dispatch rechecks producer independence for a pre-existing pending Task Round", (t) => {
  const fx = fixture(t, { producerRunRoleName: "reviewer" });
  const laterAnchor = addCompletedDirectWorkItem(fx, "later independent producer", "worker-a");
  integrateProducerAfterCurrentHeads(fx, laterAnchor);
  const legacyPending = createTaskReviewRound(
    fx.store.nextReviewRoundId(fx.task.id),
    fx.task.id,
    laterAnchor.id,
    laterAnchor.candidates.at(-1).id,
    "reviewer",
    "policy",
    {
      schemaVersion: 1,
      projects: [
        { projectId: "project-1", commit: "e".repeat(40) },
        { projectId: "project-2", commit: "f".repeat(40) }
      ]
    },
    NOW
  );
  fx.store.saveReviewRound(fx.task.id, legacyPending);

  assert.throws(
    () => dispatchFinalReview(fx, legacyPending),
    /Final Task Review cannot dispatch.*work-item-1/i
  );
  const stored = fx.store.getReviewRound(fx.task.id, legacyPending.id);
  assert.equal(stored.status, "pending");
  assert.equal(stored.reviewerRunId, undefined);
  assert.equal(
    fx.store.listAgentRuns(fx.task.id).filter(({ purpose }) => purpose === "review").length,
    0
  );
});

test("independent Reviewer still dispatches across non-Integration merge boundaries", (t) => {
  const fx = fixture(t);
  const laterProducer = addCompletedDirectWorkItem(fx, "later producer", "worker-a");
  integrateProducerAfterCurrentHeads(fx, laterProducer, { expectedHeads: ["1", "2"] });

  const completion = runTaskCommand(
    ["complete", fx.task.id, "--summary", "request final review"],
    fx.store,
    fx.leaderOptions
  );

  assert.match(completion.output, /Final Task Review requested/);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  assert.equal(round.status, "pending");
  const run = dispatchFinalReview(fx, round);
  assert.equal(run.roleName, "reviewer");
  assert.equal(run.purpose, "review");
  assert.equal(run.reviewRoundId, round.id);
});

test("final Review queue rejects an actual Task head that moved after its latest Integration", (t) => {
  const fx = fixture(t);
  setActualTaskHeads(fx, ["f".repeat(40), "d".repeat(40)]);

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

test("completed final Review evidence is not reused after the actual Task head drifts", (t) => {
  const fx = fixture(t);
  runTaskCommand(
    ["complete", fx.task.id, "--summary", "review the integrated head"],
    fx.store,
    fx.leaderOptions
  );
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  finishFinalReviewRun(
    fx,
    dispatchFinalReview(fx, round),
    "yielded",
    "reviewed exact integrated head"
  );
  setActualTaskHeads(fx, ["f".repeat(40), "d".repeat(40)]);

  assert.throws(
    () => runTaskCommand(
      ["complete", fx.task.id, "--summary", "must recheck the target"],
      fx.store,
      fx.leaderOptions
    ),
    /actual Task head.*latest committed Integration/i
  );
  assert.equal(fx.store.getTask(fx.task.id).status, "active");
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
});

test("Task-final dispatch rechecks the actual Task head after queue", (t) => {
  const fx = fixture(t);
  runTaskCommand(
    ["complete", fx.task.id, "--summary", "queue exact final review"],
    fx.store,
    fx.leaderOptions
  );
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  setActualTaskHeads(fx, ["f".repeat(40), "d".repeat(40)]);

  assert.throws(
    () => dispatchFinalReview(fx, round),
    /actual Task head.*latest committed Integration/i
  );
  assert.equal(fx.store.getReviewRound(fx.task.id, round.id).status, "pending");
  assert.equal(fx.store.listAgentRuns(fx.task.id).length, 0);
});

test("no-Run final Review retry rechecks the actual Task head", (t) => {
  const fx = fixture(t);
  const { globalReviewer, round } = failFinalReviewBeforeRun(fx);
  fx.store.saveGlobalRole(globalReviewer);
  setActualTaskHeads(fx, ["f".repeat(40), "d".repeat(40)]);

  assert.throws(
    () => runTaskCommand(
      ["work", "review", "retry", round.id],
      fx.store,
      fx.leaderOptions
    ),
    /actual Task head.*latest committed Integration/i
  );
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
});

test("failed final Review Run retry rechecks the actual Task head", (t) => {
  const fx = fixture(t);
  runTaskCommand(
    ["complete", fx.task.id, "--summary", "queue exact final review"],
    fx.store,
    fx.leaderOptions
  );
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  const run = dispatchFinalReview(fx, round);
  finishFinalReviewRun(fx, run, "failed", "review failed");
  setActualTaskHeads(fx, ["f".repeat(40), "d".repeat(40)]);

  assert.throws(
    () => runTaskCommand(["run", "retry", run.id], fx.store, fx.leaderOptions),
    /actual Task head.*latest committed Integration/i
  );
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
});

test("obsolete final Review settlement rechecks the actual Task head", (t) => {
  const fx = fixture(t);
  const { round, run } = strandTaskFinalReview(fx);
  const frozen = structuredClone(fx.store.getReviewRound(fx.task.id, round.id));
  advanceTaskCandidate(fx);
  setActualTaskHeads(fx, ["f".repeat(40), "e".repeat(40)]);

  assert.throws(
    () => runTaskCommand(["run", "settle", run.id], fx.store, fx.leaderOptions),
    /actual Task head.*latest committed Integration/i
  );
  assert.deepEqual(fx.store.getReviewRound(fx.task.id, round.id), frozen);
});

test("latest committed Integration follows numeric Task-local identity despite clock rollback", (t) => {
  const fx = fixture(t);
  for (let index = 3; index <= 8; index += 1) {
    recordIntegrationAttempt(fx, fx.item, {
      projectId: "project-1",
      targetRef: "yui/task-11/main-1",
      expectedHead: "c".repeat(40),
      changeSetBase: "c".repeat(40),
      changeSetHead: String(index).repeat(40),
      status: "failed"
    });
  }
  const integration9 = recordIntegrationAttempt(fx, fx.item, {
    projectId: "project-1",
    targetRef: "yui/task-11/main-1",
    expectedHead: "c".repeat(40),
    changeSetBase: "c".repeat(40),
    changeSetHead: "e".repeat(40),
    candidateCommit: "e".repeat(40),
    status: "committed",
    now: new Date(NOW.getTime() + 1_000)
  });
  assert.equal(integration9.id, "integration-9");
  setActualTaskHeads(fx, ["e".repeat(40), "d".repeat(40)]);
  runTaskCommand(
    ["complete", fx.task.id, "--summary", "review integration-9"],
    fx.store,
    fx.leaderOptions
  );
  const firstRound = fx.store.listReviewRounds(fx.task.id)[0];
  finishFinalReviewRun(
    fx,
    dispatchFinalReview(fx, firstRound),
    "yielded",
    "integration-9 reviewed"
  );

  const integration10 = recordIntegrationAttempt(fx, fx.item, {
    projectId: "project-1",
    targetRef: "yui/task-11/main-1",
    expectedHead: "e".repeat(40),
    changeSetBase: "e".repeat(40),
    changeSetHead: "f".repeat(40),
    candidateCommit: "f".repeat(40),
    status: "committed",
    now: new Date(NOW.getTime() - 1_000)
  });
  assert.equal(integration10.id, "integration-10");
  setActualTaskHeads(fx, ["f".repeat(40), "d".repeat(40)]);

  const requested = runTaskCommand(
    ["complete", fx.task.id, "--summary", "review integration-10"],
    fx.store,
    fx.leaderOptions
  );
  assert.match(requested.output, /Final Task Review requested/);
  const rounds = fx.store.listReviewRounds(fx.task.id);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[1].taskCandidate.projects[0].commit, "f".repeat(40));
  assert.equal(fx.store.getTask(fx.task.id).status, "active");
});

test("final Review freezes a bound Project with no Integration and no producer", (t) => {
  const fx = fixture(t, { integratedProjectIds: ["project-1"] });

  const requested = runTaskCommand(
    ["complete", fx.task.id, "--summary", "review modified and context Projects"],
    fx.store,
    fx.leaderOptions
  );
  assert.match(requested.output, /Final Task Review requested/);
  const round = fx.store.listReviewRounds(fx.task.id)[0];
  assert.deepEqual(round.taskCandidate.projects, [
    { projectId: "project-1", commit: "c".repeat(40) },
    { projectId: "project-2", commit: "d".repeat(40) }
  ]);
  const run = dispatchFinalReview(fx, round);
  assert.equal(run.purpose, "review");
  assert.equal(run.reviewRoundId, round.id);
  finishFinalReviewRun(
    fx,
    run,
    "yielded",
    "modified and context Projects reviewed"
  );
  const completed = runTaskCommand(
    ["complete", fx.task.id, "--summary", "partial multi-Project delivery accepted"],
    fx.store,
    fx.leaderOptions
  );
  assert.match(completed.output, /Completed task/);
  assert.equal(fx.store.getTask(fx.task.id).status, "completed");
});

test("final policy queues one Task Review over all committed Project heads", (t) => {
  const { store, task, item, leaderOptions } = fixture(t);
  const first = runTaskCommand(
    ["complete", task.id, "--summary", "finish"], store, leaderOptions
  );
  assert.equal(first.kind, "output");
  assert.match(first.output, /Final Task Review requested/);
  const rounds = store.listReviewRounds(task.id);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].scope, "task");
  assert.deepEqual(rounds[0].taskCandidate.projects.map(({ projectId }) => projectId), [
    "project-1", "project-2"
  ]);
  assert.equal(store.getWorkItem(task.id, item.id).candidates.at(-1).reviewPolicy, undefined);
  assert.equal(store.getTask(task.id).status, "active");
  assert.throws(
    () => runTaskCommand(["complete", task.id, "--summary", "finish"], store, leaderOptions),
    /Final Task Review is still active/
  );
});

test("Reviewer panels retain each Lane until Leader resolution", (t) => {
  const fx = fixture(t);
  const { store, task, leaderOptions } = fx;
  runTaskCommand(
    ["role", "add", task.id, "reviewer-2", "--agent", "codex"],
    store,
    leaderOptions
  );
  const requested = runTaskCommand([
    "review", "request", task.id,
    "--role", "reviewer",
    "--strategy", "fixed:2",
    "--lane-role", "reviewer",
    "--lane-role", "reviewer-2"
  ], store, leaderOptions);
  assert.equal(requested.kind, "output");
  const round = store.listReviewRounds(task.id)[0];
  assert.equal(round.executionGroup.strategy.count, 2);
  const firstRun = dispatchFinalReview(fx, round);
  const secondRun = store.listAgentRuns(task.id).find(({ id }) => id !== firstRun.id && id.startsWith("agent-run-"));
  assert.ok(secondRun);
  finishFinalReviewRun(fx, firstRun, "yielded", "first perspective", {
    report: "first report",
    checks: [{ name: "first-check", outcome: "passed" }]
  });
  assert.equal(store.getReviewRound(task.id, round.id).status, "running");
  finishFinalReviewRun(fx, secondRun, "yielded", "second perspective", {
    report: "second report",
    checks: [{ name: "second-check", outcome: "passed" }]
  });
  assert.equal(store.getReviewRound(task.id, round.id).status, "running");
  const resolved = runTaskCommand([
    "review", "group", "resolve", round.id,
    "--decision", "accept",
    "--summary", "Leader accepted both perspectives"
  ], store, leaderOptions);
  assert.equal(resolved.kind, "output");
  const completed = store.getReviewRound(task.id, round.id);
  assert.equal(completed.status, "completed");
  assert.match(completed.report, /first report/);
  assert.match(completed.report, /second report/);
});

test("a clean panel Lane cannot attest checks contributed by a dirty Lane", {
  skip: process.env.YUI_REVIEW_PANEL_DIRTY_EVIDENCE !== "1"
}, (t) => {
  const fx = fixture(t);
  const { store, task, leaderOptions } = fx;
  runTaskCommand(
    ["role", "add", task.id, "reviewer-2", "--agent", "codex"],
    store,
    leaderOptions
  );
  runTaskCommand([
    "review", "request", task.id,
    "--role", "reviewer",
    "--strategy", "fixed:2",
    "--lane-role", "reviewer",
    "--lane-role", "reviewer-2"
  ], store, leaderOptions);
  const round = store.listReviewRounds(task.id)[0];
  const firstRun = dispatchFinalReview(fx, round);
  const secondRun = store.listAgentRuns(task.id).find(({ id }) => id !== firstRun.id);
  assert.ok(secondRun);

  finishFinalReviewRun(fx, firstRun, "yielded", "clean perspective", {
    report: "clean report",
    checks: [{ name: "clean-check", outcome: "passed" }],
    evidenceCommit: round.reviewBaseCommit
  });
  finishFinalReviewRun(fx, secondRun, "yielded", "dirty perspective", {
    report: "dirty report",
    checks: [{ name: "dirty-only-check", outcome: "passed" }]
  });

  runTaskCommand([
    "review", "group", "resolve", round.id,
    "--decision", "accept",
    "--summary", "Leader accepted both perspectives"
  ], store, leaderOptions);
  const completed = store.getReviewRound(task.id, round.id);
  assert.deepEqual(completed.checks.map(({ name }) => name), [
    "clean-check",
    "dirty-only-check"
  ]);
  assert.equal(
    completed.evidenceCommit,
    undefined,
    "the aggregate must not bind a dirty Lane's checks to the clean Lane's base attestation"
  );
});

test("a changed integrated head creates a fresh final ReviewRound and keeps prior evidence", (t) => {
  const { store, task, item, leaderOptions } = fixture(t);
  runTaskCommand(["complete", task.id, "--summary", "finish"], store, leaderOptions);
  const first = store.listReviewRounds(task.id)[0];
  store.saveReviewRound(task.id, finishReviewRound(first, "failed", "reviewer unavailable", NOW));
  store.transaction((tx) => {
    const baseCommit = "d".repeat(40);
    const headCommit = "e".repeat(40);
    tx.saveChangeSet(task.id, createWorkItemChangeSet({
      id: "change-set-3",
      taskId: task.id,
      projectId: "project-2",
      workItemId: item.id,
      baseCommit,
      headCommit,
      branch: "yui/task-11/work-item-2",
      changedPaths: ["project-2/fix.ts"]
    }, NOW));
    const attempt = createIntegrationAttempt({
      id: "integration-3",
      taskId: task.id,
      projectId: "project-2",
      targetRef: "yui/task-11/main-2",
      expectedHead: baseCommit,
      changeSetIds: ["change-set-3"],
      checkCommands: []
    }, NOW);
    tx.saveIntegrationAttempt(task.id, updateIntegrationAttempt(
      attempt, { status: "committed", candidateCommit: headCommit }, NOW
    ));
  });
  leaderOptions.actualTaskReviewCandidate = {
    schemaVersion: 1,
    projects: [
      { projectId: "project-1", commit: "c".repeat(40) },
      { projectId: "project-2", commit: "e".repeat(40) }
    ]
  };
  runTaskCommand(["complete", task.id, "--summary", "finish"], store, leaderOptions);
  const rounds = store.listReviewRounds(task.id);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].status, "failed");
  assert.equal(rounds[1].status, "pending");
  assert.notDeepEqual(rounds[0].taskCandidate, rounds[1].taskCandidate);
});

for (const [drift, review] of [
  ["leader", { roleName: "replacement-reviewer", trigger: "leader" }],
  ["always", { roleName: "replacement-reviewer", trigger: "always" }],
  ["absent", undefined]
]) {
  test(`durable final-review contract survives global ${drift} drift after integrated head changes`, (t) => {
    const fx = fixture(t);
    runTaskCommand(
      ["complete", fx.task.id, "--summary", "request initial review"],
      fx.store,
      fx.leaderOptions
    );
    const first = fx.store.listReviewRounds(fx.task.id)[0];
    const reviewerSnapshot = structuredClone(
      fx.store.getRole(fx.task.id, first.reviewerRoleName)
    );
    fx.store.saveReviewRound(
      fx.task.id,
      finishReviewRound(first, "failed", "old head needs replacement", NOW)
    );
    advanceTaskCandidate(fx);
    setReviewConfig(fx, review);

    const completion = runTaskCommand(
      ["complete", fx.task.id, "--summary", "request latest-head review"],
      fx.store,
      fx.leaderOptions
    );

    assert.match(completion.output, /Final Task Review requested/);
    const rounds = fx.store.listReviewRounds(fx.task.id);
    assert.equal(rounds.length, 2);
    assert.equal(rounds[1].reviewerRoleName, first.reviewerRoleName);
    assert.deepEqual(
      fx.store.getRole(fx.task.id, first.reviewerRoleName),
      reviewerSnapshot
    );
    assert.notDeepEqual(rounds[1].taskCandidate, first.taskCandidate);
    assert.equal(fx.store.getTask(fx.task.id).status, "active");
    assert.throws(
      () => runTaskCommand(
        ["complete", fx.task.id, "--summary", "do not duplicate latest review"],
        fx.store,
        fx.leaderOptions
      ),
      /Final Task Review is still active/
    );
    assert.equal(fx.store.listReviewRounds(fx.task.id).length, 2);
  });
}

test("same-head final-review states remain authoritative after global drift", (t) => {
  const pending = fixture(t);
  runTaskCommand(
    ["complete", pending.task.id, "--summary", "request pending review"],
    pending.store,
    pending.leaderOptions
  );
  setReviewConfig(pending, { roleName: "replacement-reviewer", trigger: "leader" });
  assert.throws(
    () => runTaskCommand(
      ["complete", pending.task.id, "--summary", "pending must block"],
      pending.store,
      pending.leaderOptions
    ),
    /Final Task Review is still active: review-round-1\/pending/
  );
  assert.equal(pending.store.getTask(pending.task.id).status, "active");

  const running = fixture(t);
  runTaskCommand(
    ["complete", running.task.id, "--summary", "request running review"],
    running.store,
    running.leaderOptions
  );
  const runningRound = running.store.listReviewRounds(running.task.id)[0];
  strandFinalReviewRun(running, dispatchFinalReview(running, runningRound));
  setReviewConfig(running, { roleName: "replacement-reviewer", trigger: "always" });
  assert.throws(
    () => runTaskCommand(
      ["complete", running.task.id, "--summary", "running must block"],
      running.store,
      running.leaderOptions
    ),
    /Final Task Review is still active: review-round-1\/running/
  );
  assert.equal(running.store.getTask(running.task.id).status, "active");

  const failed = fixture(t);
  runTaskCommand(
    ["complete", failed.task.id, "--summary", "request failed review"],
    failed.store,
    failed.leaderOptions
  );
  const failedRound = failed.store.listReviewRounds(failed.task.id)[0];
  failed.store.saveReviewRound(
    failed.task.id,
    finishReviewRound(failedRound, "failed", "material finding", NOW)
  );
  setReviewConfig(failed, undefined);
  const blocked = runTaskCommand(
    ["complete", failed.task.id, "--summary", "failed must block"],
    failed.store,
    failed.leaderOptions
  );
  assert.match(blocked.output, /Final Task Review is blocked: material finding/);
  assert.equal(failed.store.getTask(failed.task.id).status, "active");

  const completed = fixture(t);
  runTaskCommand(
    ["complete", completed.task.id, "--summary", "request completed review"],
    completed.store,
    completed.leaderOptions
  );
  const completedRound = completed.store.listReviewRounds(completed.task.id)[0];
  finishFinalReviewRun(
    completed,
    dispatchFinalReview(completed, completedRound),
    "yielded",
    "review passed"
  );
  setReviewConfig(completed, { roleName: "replacement-reviewer", trigger: "always" });
  const completion = runTaskCommand(
    ["complete", completed.task.id, "--summary", "reviewed head may complete"],
    completed.store,
    completed.leaderOptions
  );
  assert.match(completion.output, /Completed task/);
  assert.equal(completed.store.getTask(completed.task.id).status, "completed");
  assert.equal(completed.store.listReviewRounds(completed.task.id).length, 1);
});

for (const [policy, review] of [
  ["leader", { roleName: "reviewer", trigger: "leader" }],
  ["always", { roleName: "reviewer", trigger: "always" }],
  ["absent", undefined]
]) {
  test(`Project-backed Task without a final-review contract retains global ${policy} behavior`, (t) => {
    const fx = fixture(t);
    setReviewConfig(fx, review);

    const completion = runTaskCommand(
      ["complete", fx.task.id, "--summary", "no final contract"],
      fx.store,
      fx.leaderOptions
    );

    assert.match(completion.output, /Completed task/);
    assert.equal(fx.store.getTask(fx.task.id).status, "completed");
    assert.equal(fx.store.listReviewRounds(fx.task.id).length, 0);
  });
}

test("an unchanged failed final ReviewRound does not duplicate or unblock completion", (t) => {
  const { store, task, leaderOptions } = fixture(t);
  runTaskCommand(["complete", task.id, "--summary", "finish"], store, leaderOptions);
  const first = store.listReviewRounds(task.id)[0];
  store.saveReviewRound(task.id, finishReviewRound(first, "failed", "reviewer unavailable", NOW));

  const second = runTaskCommand(
    ["complete", task.id, "--summary", "finish again"],
    store,
    leaderOptions
  );

  assert.equal(second.kind, "output");
  assert.match(second.output, /Final Task Review is blocked/);
  assert.equal(store.listReviewRounds(task.id).length, 1);
  assert.equal(store.getTask(task.id).status, "active");
});

test("retrying an exact failed final Review Run reuses the same Round ID for the unchanged candidate", (t) => {
  const fx = fixture(t);
  runTaskCommand(
    ["complete", fx.task.id, "--summary", "request final review"],
    fx.store,
    fx.leaderOptions
  );
  const firstRound = fx.store.listReviewRounds(fx.task.id)[0];
  const firstRun = dispatchFinalReview(fx, firstRound);
  const dispatchedRound = fx.store.getReviewRound(fx.task.id, firstRound.id);
  finishFinalReviewRun(
    fx,
    firstRun,
    "failed",
    "material review finding",
    {
      report: "The frozen candidate needs explicit Leader disposition.",
      checks: [{ name: "focused review", outcome: "failed" }],
      evidenceCommit: "f".repeat(40)
    }
  );
  const retryOptions = {
    ...fx.leaderOptions,
    now: () => new Date(NOW.getTime() - 1_000)
  };

  const retried = runTaskCommand(
    ["run", "retry", firstRun.id],
    fx.store,
    retryOptions
  );

  assert.equal(retried.kind, "output");
  assert.match(retried.output, /Review retry requested/);
  const rounds = fx.store.listReviewRounds(fx.task.id);
  // Issue 06: infra retry reuses the same semantic Round ID; no new Round row.
  assert.equal(rounds.length, 1);
  const retryRound = rounds[0];
  assert.equal(retryRound.id, firstRound.id);
  assert.equal(retryRound.status, "pending");
  assert.equal(retryRound.requestedBy, "leader");
  assert.deepEqual(retryRound.taskCandidate, firstRound.taskCandidate);
  assert.deepEqual(retryRound.workspace, dispatchedRound.workspace);
  assert.equal(retryRound.executionGroup?.id, dispatchedRound.executionGroup?.id);
  assert.equal(retryRound.executionGroup?.lanes[0]?.status, "pending");
  assert.equal(retryRound.executionGroup?.lanes[0]?.runId, undefined);
  // The failed attempt's terminal metadata is cleared; candidate identity is preserved.
  assert.equal(retryRound.report, undefined);
  assert.equal(retryRound.endedAt, undefined);

  const repeated = runTaskCommand(
    ["run", "retry", firstRun.id],
    fx.store,
    retryOptions
  );
  assert.equal(repeated.kind, "output");
  assert.equal(repeated.data.reviewRound.id, retryRound.id);
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);

  const retryRun = dispatchFinalReview(fx, retryRound);
  const runningRetryRound = fx.store.getReviewRound(fx.task.id, retryRound.id);
  assert.deepEqual(runningRetryRound.workspace.owner, {
    type: "review-round",
    taskId: fx.task.id,
    reviewRoundId: retryRound.id
  });
  const repeatedAfterDispatch = runTaskCommand(
    ["run", "retry", firstRun.id],
    fx.store,
    retryOptions
  );
  assert.equal(repeatedAfterDispatch.kind, "output");
  assert.equal(repeatedAfterDispatch.data.reviewRound.id, retryRound.id);
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
  finishFinalReviewRun(fx, retryRun, "yielded", "final review passed");
  assert.equal(fx.store.getTask(fx.task.id).status, "active");
  const completed = runTaskCommand(
    ["complete", fx.task.id, "--summary", "final review accepted"],
    fx.store,
    fx.leaderOptions
  );
  assert.equal(completed.kind, "output");
  assert.match(completed.output, /Completed task/);
  assert.equal(fx.store.getTask(fx.task.id).status, "completed");
});

test("retrying a failed final Review Run repairs its exact stranded running Round", (t) => {
  const fx = fixture(t);
  runTaskCommand(
    ["complete", fx.task.id, "--summary", "request final review"],
    fx.store,
    fx.leaderOptions
  );
  const firstRound = fx.store.listReviewRounds(fx.task.id)[0];
  const firstRun = dispatchFinalReview(fx, firstRound);
  const frozenRunningRound = structuredClone(
    fx.store.getReviewRound(fx.task.id, firstRound.id)
  );
  const frozenWorkspace = structuredClone(
    fx.store.getReviewRoundWorkspace(fx.task.id, firstRound.id)
  );

  // Reproduce the aggregate transition committed by the pre-fix Controller:
  // the exact Run became terminal and lost its active pointer, but its started
  // ReviewRound was not terminalized with it.
  strandFinalReviewRun(fx, firstRun);
  assert.equal(fx.store.getAgentRun(fx.task.id, firstRun.id).status, "failed");
  assert.equal(fx.store.getReviewRound(fx.task.id, firstRound.id).status, "running");
  assert.equal(fx.store.getActiveAgentRun(fx.task.id, firstRun.roleName), null);
  assert.equal(fx.store.getRole(fx.task.id, firstRun.roleName).status, "exited");

  const retryNow = new Date(NOW.getTime() + 1_000);
  const retried = runTaskCommand(
    ["run", "retry", firstRun.id],
    fx.store,
    { ...fx.leaderOptions, now: () => retryNow }
  );

  assert.equal(retried.kind, "output");
  assert.match(retried.output, /Review retry requested/);
  const rounds = fx.store.listReviewRounds(fx.task.id);
  // Issue 06: the stranded running Round is terminalized and reset to pending
  // under the same semantic Round ID; no new Round row is created.
  assert.equal(rounds.length, 1);
  const repairedRound = fx.store.getReviewRound(fx.task.id, firstRound.id);
  assert.equal(repairedRound.id, firstRound.id);
  assert.equal(repairedRound.status, "pending");
  assert.equal(repairedRound.requestedBy, "leader");
  assert.deepEqual(repairedRound.taskCandidate, frozenRunningRound.taskCandidate);
  assert.deepEqual(repairedRound.workspace, frozenRunningRound.workspace);
  assert.equal(repairedRound.report, undefined);
  assert.equal(repairedRound.endedAt, undefined);
  const retryRound = repairedRound;
  assert.equal(retryRound.status, "pending");

  const repeated = runTaskCommand(
    ["run", "retry", firstRun.id],
    fx.store,
    { ...fx.leaderOptions, now: () => new Date(retryNow.getTime() + 1_000) }
  );
  assert.equal(repeated.kind, "output");
  assert.equal(repeated.data.reviewRound.id, retryRound.id);
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
});

test("settling an obsolete stranded final Review closes it without retrying before latest-head review", (t) => {
  const fx = fixture(t);
  const { round: firstRound, run: firstRun } = strandTaskFinalReview(fx);
  const frozenRunningRound = structuredClone(
    fx.store.getReviewRound(fx.task.id, firstRound.id)
  );
  const frozenFailedRun = structuredClone(
    fx.store.getAgentRun(fx.task.id, firstRun.id)
  );
  const frozenWorkspace = structuredClone(
    fx.store.getReviewRoundWorkspace(fx.task.id, firstRound.id)
  );
  advanceTaskCandidate(fx);
  const settledAt = new Date(NOW.getTime() + 1_000);

  const settled = runTaskCommand(
    ["run", "settle", firstRun.id],
    fx.store,
    { ...fx.leaderOptions, now: () => settledAt }
  );

  assert.equal(settled.kind, "output");
  assert.match(settled.output, /Settled obsolete final Review/);
  const oldRound = fx.store.getReviewRound(fx.task.id, firstRound.id);
  assert.deepEqual(oldRound, {
    ...frozenRunningRound,
    status: "failed",
    summary: EXITED_REVIEW_SUMMARY,
    report: EXITED_REVIEW_SUMMARY,
    checks: [],
    endedAt: settledAt.toISOString()
  });
  assert.deepEqual(
    fx.store.getAgentRun(fx.task.id, firstRun.id),
    frozenFailedRun
  );
  assert.deepEqual(
    fx.store.getReviewRoundWorkspace(fx.task.id, firstRound.id),
    frozenWorkspace
  );
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);

  const completion = runTaskCommand(
    ["complete", fx.task.id, "--summary", "request latest-head review"],
    fx.store,
    fx.leaderOptions
  );
  assert.equal(completion.kind, "output");
  assert.match(completion.output, /Final Task Review requested/);
  const latestRound = fx.store.listReviewRounds(fx.task.id)[1];
  assert.equal(latestRound.status, "pending");
  assert.notDeepEqual(latestRound.taskCandidate, oldRound.taskCandidate);
  assert.deepEqual(latestRound.taskCandidate.projects, [
    { projectId: "project-1", commit: "c".repeat(40) },
    { projectId: "project-2", commit: "e".repeat(40) }
  ]);
  assert.throws(
    () => runTaskCommand(
      ["complete", fx.task.id, "--summary", "do not duplicate latest-head review"],
      fx.store,
      fx.leaderOptions
    ),
    /Final Task Review is still active/i
  );
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 2);
});

test("settling an obsolete final Review is exactly idempotent with no state write", (t) => {
  const fx = fixture(t);
  const { round, run } = strandTaskFinalReview(fx);
  advanceTaskCandidate(fx);
  runTaskCommand(
    ["run", "settle", run.id],
    fx.store,
    { ...fx.leaderOptions, now: () => new Date(NOW.getTime() + 1_000) }
  );
  const statePath = join(fx.root, "state.json");
  const settledState = readFileSync(statePath, "utf8");

  const repeated = runTaskCommand(
    ["run", "settle", run.id],
    fx.store,
    { ...fx.leaderOptions, now: () => new Date(NOW.getTime() + 2_000) }
  );

  assert.equal(repeated.kind, "output");
  assert.match(repeated.output, /already settled/);
  assert.equal(readFileSync(statePath, "utf8"), settledState);
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
  assert.equal(fx.store.getReviewRound(fx.task.id, round.id).status, "failed");
});

test("settling a stranded final Review fails closed when its candidate is current", (t) => {
  const fx = fixture(t);
  const { round, run } = strandTaskFinalReview(fx);
  const frozenRound = structuredClone(
    fx.store.getReviewRound(fx.task.id, round.id)
  );

  assert.throws(
    () => runTaskCommand(
      ["run", "settle", run.id],
      fx.store,
      fx.leaderOptions
    ),
    /freezes the current Task candidate/i
  );
  assert.deepEqual(fx.store.getReviewRound(fx.task.id, round.id), frozenRound);
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
});

test("settling an obsolete final Review is Leader-only and exact-Run fenced", (t) => {
  const fx = fixture(t);
  const { round, run } = strandTaskFinalReview(fx);
  advanceTaskCandidate(fx);
  const frozenRound = structuredClone(
    fx.store.getReviewRound(fx.task.id, round.id)
  );

  assert.throws(
    () => runTaskCommand(
      ["run", "settle", `${fx.task.id}/${run.id}`],
      fx.store,
      { now: () => NOW }
    ),
    /Only the Task Leader/i
  );

  const nonmatchingRun = failAgentRun(
    { ...run, id: "agent-run-99" },
    "different failed Review Run",
    NOW
  );
  fx.store.saveAgentRun(nonmatchingRun);
  assert.throws(
    () => runTaskCommand(
      ["run", "settle", nonmatchingRun.id],
      fx.store,
      fx.leaderOptions
    ),
    /identity does not match/i
  );
  assert.deepEqual(fx.store.getReviewRound(fx.task.id, round.id), frozenRound);
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
});

test("settling an obsolete final Review fails closed while any Reviewer Run is active", (t) => {
  const fx = fixture(t);
  const { round, run } = strandTaskFinalReview(fx);
  advanceTaskCandidate(fx);
  const frozenRound = structuredClone(
    fx.store.getReviewRound(fx.task.id, round.id)
  );
  const laterRound = createLaterFinalRound(
    fx,
    round,
    fx.leaderOptions.actualTaskReviewCandidate
  );
  const activeRun = dispatchFinalReview(fx, laterRound);

  assert.throws(
    () => runTaskCommand(
      ["run", "settle", run.id],
      fx.store,
      fx.leaderOptions
    ),
    new RegExp(`already has active Run ${activeRun.id}`, "i")
  );
  assert.deepEqual(fx.store.getReviewRound(fx.task.id, round.id), frozenRound);
  assert.equal(
    fx.store.getActiveAgentRun(fx.task.id, activeRun.roleName).id,
    activeRun.id
  );
});

test("settling an obsolete final Review fails closed for later final Review history", (t) => {
  const fx = fixture(t);
  const { round, run } = strandTaskFinalReview(fx);
  advanceTaskCandidate(fx);
  const frozenRound = structuredClone(
    fx.store.getReviewRound(fx.task.id, round.id)
  );
  const laterCandidate = {
    ...round.taskCandidate,
    projects: round.taskCandidate.projects.map((project) => (
      project.projectId === "project-2"
        ? { ...project, commit: "e".repeat(40) }
        : project
    ))
  };
  const laterRound = createLaterFinalRound(fx, round, laterCandidate);

  assert.throws(
    () => runTaskCommand(
      ["run", "settle", run.id],
      fx.store,
      fx.leaderOptions
    ),
    /later final ReviewRound already exists/i
  );
  assert.deepEqual(fx.store.getReviewRound(fx.task.id, round.id), frozenRound);
  assert.equal(
    fx.store.getReviewRound(fx.task.id, laterRound.id).status,
    "pending"
  );
});
test("stranded final Review retry fails closed for a nonmatching failed Run", (t) => {
  const fx = fixture(t);
  runTaskCommand(
    ["complete", fx.task.id, "--summary", "request final review"],
    fx.store,
    fx.leaderOptions
  );
  const firstRound = fx.store.listReviewRounds(fx.task.id)[0];
  const firstRun = dispatchFinalReview(fx, firstRound);
  strandFinalReviewRun(fx, firstRun);
  const frozenRound = structuredClone(
    fx.store.getReviewRound(fx.task.id, firstRound.id)
  );
  const nonmatchingRun = failAgentRun(
    { ...firstRun, id: "agent-run-99" },
    "different failed Review Run",
    NOW
  );
  fx.store.saveAgentRun(nonmatchingRun);

  assert.throws(
    () => runTaskCommand(
      ["run", "retry", nonmatchingRun.id],
      fx.store,
      fx.leaderOptions
    ),
    /identity does not match/i
  );
  assert.deepEqual(
    fx.store.getReviewRound(fx.task.id, firstRound.id),
    frozenRound
  );
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
});

test("stranded final Review retry preserves the old Round when a newer Reviewer Run or Round is active", (t) => {
  const fx = fixture(t);
  runTaskCommand(
    ["complete", fx.task.id, "--summary", "request final review"],
    fx.store,
    fx.leaderOptions
  );
  const firstRound = fx.store.listReviewRounds(fx.task.id)[0];
  const firstRun = dispatchFinalReview(fx, firstRound);
  strandFinalReviewRun(fx, firstRun);
  const frozenRound = structuredClone(
    fx.store.getReviewRound(fx.task.id, firstRound.id)
  );
  const laterRound = createLaterFinalRound(
    fx,
    firstRound,
    firstRound.taskCandidate
  );
  const laterRun = dispatchFinalReview(fx, laterRound);

  assert.throws(
    () => runTaskCommand(
      ["run", "retry", firstRun.id],
      fx.store,
      fx.leaderOptions
    ),
    /already has an active run|active Task-final ReviewRound/i
  );
  assert.deepEqual(
    fx.store.getReviewRound(fx.task.id, firstRound.id),
    frozenRound
  );
  assert.equal(
    fx.store.getActiveAgentRun(fx.task.id, firstRun.roleName).id,
    laterRun.id
  );
});

test("stranded final Review retry rolls back when a newer Round freezes a different Task candidate", (t) => {
  const fx = fixture(t);
  runTaskCommand(
    ["complete", fx.task.id, "--summary", "request final review"],
    fx.store,
    fx.leaderOptions
  );
  const firstRound = fx.store.listReviewRounds(fx.task.id)[0];
  const firstRun = dispatchFinalReview(fx, firstRound);
  strandFinalReviewRun(fx, firstRun);
  const frozenRound = structuredClone(
    fx.store.getReviewRound(fx.task.id, firstRound.id)
  );
  const changedTaskCandidate = {
    ...firstRound.taskCandidate,
    projects: firstRound.taskCandidate.projects.map((project, index) => (
      index === 0 ? { ...project, commit: "e".repeat(40) } : project
    ))
  };
  const laterRound = createLaterFinalRound(
    fx,
    firstRound,
    changedTaskCandidate
  );

  assert.throws(
    () => runTaskCommand(
      ["run", "retry", firstRun.id],
      fx.store,
      fx.leaderOptions
    ),
    /newer final Task candidate/i
  );
  assert.deepEqual(
    fx.store.getReviewRound(fx.task.id, firstRound.id),
    frozenRound
  );
  assert.equal(
    fx.store.getReviewRound(fx.task.id, laterRound.id).status,
    "pending"
  );
});
