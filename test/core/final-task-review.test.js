import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import {
  dispatchPreparedReviewRound,
  runTaskCommand
} from "../../dist/commands/taskCommands.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import { createIntegrationAttempt, updateIntegrationAttempt } from "../../dist/integration/integrationAttempt.js";
import { terminalizeExactTaskRun } from "../../dist/lifecycle/exactRunTerminalization.js";
import { createProject } from "../../dist/repository/project.js";
import {
  createGlobalRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../../dist/role/role.js";
import { failAgentRun } from "../../dist/run/agentRun.js";
import {
  attachReviewRoundWorkspace,
  createTaskReviewRound,
  finishReviewRound
} from "../../dist/review/reviewRound.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { formatAgentRunReceiptId } from "../../dist/task/taskRecordReference.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { submitWorkItemCandidate, updateWorkItemStatus } from "../../dist/workItem/workItem.js";

const NOW = new Date("2026-08-08T00:00:00.000Z");
const EXITED_REVIEW_SUMMARY = "The role's tmux session exited before the run yielded.";

function fixture(t) {
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
  runTaskCommand(["work", "create", task.id, "change"], store, { now: () => NOW });
  const item = store.getWorkItem(task.id, "work-item-1");
  const leaderOptions = {
    now: () => NOW,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  runTaskCommand(["work", "update", item.id, "running"], store, leaderOptions);
  store.transaction((tx) => {
    const running = tx.getWorkItem(task.id, item.id);
    const candidate = submitWorkItemCandidate(running, {
      summary: "integrated candidate",
      source: { type: "direct" }
    }, NOW);
    tx.saveWorkItem(task.id, candidate);
    tx.saveWorkItem(task.id, updateWorkItemStatus(candidate, "completed", NOW, "accepted"));
    for (const [index, projectId] of ["project-1", "project-2"].entries()) {
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
  runTaskCommand(["complete", task.id, "--summary", "finish"], store, leaderOptions);
  const rounds = store.listReviewRounds(task.id);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].status, "failed");
  assert.equal(rounds[1].status, "pending");
  assert.notDeepEqual(rounds[0].taskCandidate, rounds[1].taskCandidate);
});

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

test("retrying an exact failed final Review Run creates one independent Round for the unchanged candidate", (t) => {
  const fx = fixture(t);
  runTaskCommand(
    ["complete", fx.task.id, "--summary", "request final review"],
    fx.store,
    fx.leaderOptions
  );
  const firstRound = fx.store.listReviewRounds(fx.task.id)[0];
  const firstRun = dispatchFinalReview(fx, firstRound);
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
  const frozenFailedRound = structuredClone(
    fx.store.getReviewRound(fx.task.id, firstRound.id)
  );
  const frozenFailedWorkspace = structuredClone(
    fx.store.getReviewRoundWorkspace(fx.task.id, firstRound.id)
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
  assert.equal(rounds.length, 2);
  const retryRound = rounds[1];
  assert.equal(retryRound.status, "pending");
  assert.notEqual(retryRound.id, firstRound.id);
  assert.equal(retryRound.requestedBy, "leader");
  assert.deepEqual(retryRound.taskCandidate, firstRound.taskCandidate);
  assert.equal(retryRound.workspace, undefined);
  assert.deepEqual(
    fx.store.getReviewRound(fx.task.id, firstRound.id),
    frozenFailedRound
  );
  assert.deepEqual(
    fx.store.getReviewRoundWorkspace(fx.task.id, firstRound.id),
    frozenFailedWorkspace
  );

  const repeated = runTaskCommand(
    ["run", "retry", firstRun.id],
    fx.store,
    retryOptions
  );
  assert.equal(repeated.kind, "output");
  assert.equal(repeated.data.reviewRound.id, retryRound.id);
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 2);

  const retryRun = dispatchFinalReview(fx, retryRound);
  const runningRetryRound = fx.store.getReviewRound(fx.task.id, retryRound.id);
  assert.notEqual(runningRetryRound.workspace.root, frozenFailedRound.workspace.root);
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
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 2);
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
  assert.deepEqual(
    fx.store.getReviewRound(fx.task.id, firstRound.id),
    frozenFailedRound
  );
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
  assert.equal(rounds.length, 2);
  const repairedRound = fx.store.getReviewRound(fx.task.id, firstRound.id);
  assert.deepEqual(repairedRound, {
    ...frozenRunningRound,
    status: "failed",
    summary: EXITED_REVIEW_SUMMARY,
    report: EXITED_REVIEW_SUMMARY,
    checks: [],
    endedAt: retryNow.toISOString()
  });
  assert.deepEqual(
    fx.store.getReviewRoundWorkspace(fx.task.id, firstRound.id),
    frozenWorkspace
  );
  const retryRound = rounds[1];
  assert.equal(retryRound.status, "pending");
  assert.equal(retryRound.requestedBy, "leader");
  assert.deepEqual(retryRound.taskCandidate, frozenRunningRound.taskCandidate);
  assert.equal(retryRound.workspace, undefined);

  const repeated = runTaskCommand(
    ["run", "retry", firstRun.id],
    fx.store,
    { ...fx.leaderOptions, now: () => new Date(retryNow.getTime() + 1_000) }
  );
  assert.equal(repeated.kind, "output");
  assert.equal(repeated.data.reviewRound.id, retryRound.id);
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 2);
  assert.deepEqual(
    fx.store.getReviewRound(fx.task.id, firstRound.id),
    repairedRound
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

test("stranded final Review retry preserves the old Round when a newer Reviewer Run is active", (t) => {
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
    /already has an active run/i
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
