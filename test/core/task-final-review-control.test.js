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
import {
  createIntegrationAttempt,
  updateIntegrationAttempt
} from "../../dist/integration/integrationAttempt.js";
import { createProject } from "../../dist/repository/project.js";
import {
  createGlobalRole,
  createRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";
import {
  attachReviewRoundWorkspace,
  createReviewRound,
  createTaskReviewRound,
  finishReviewRound,
  startReviewRound
} from "../../dist/review/reviewRound.js";
import {
  createTaskFinalReviewContract
} from "../../dist/review/taskFinalReviewContract.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { terminalizeExactTaskRun } from "../../dist/lifecycle/exactRunTerminalization.js";
import { formatAgentRunReceiptId } from "../../dist/task/taskRecordReference.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createAgentRun, yieldAgentRun } from "../../dist/run/agentRun.js";

const NOW = new Date("2026-08-10T00:00:00.000Z");

function fixture(t, { projectTask = true, projectWork = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "yui-task-final-control-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  const projectPath = join(home, "project");
  mkdirSync(projectPath, { recursive: true });
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveConfig({
      schemaVersion: 1,
      defaultAgent: agent.id,
      defaultWorkspace: home,
      review: { roleName: "reviewer", trigger: "leader" }
    });
    tx.saveGlobalRole(createGlobalRole(
      "leader", [createRoleAgentBinding(agent)], agent.id, home, NOW
    ));
    tx.saveGlobalRole(createGlobalRole(
      "reviewer", [createRoleAgentBinding(agent)], agent.id, home, NOW
    ));
    tx.saveProject(createProject(
      "project-1", "project", projectPath, { stable: "main", development: "main" }, NOW
    ));
  });
  runTaskCommand([
    "create", "delivery", ...(projectTask ? ["--project", "project-1"] : [])
  ], store, {
    now: () => NOW
  });
  const task = store.getTask("task-1");
  store.saveRole(task.id, createRole(
    task.id,
    "reviewer",
    [createRoleAgentBinding(agent)],
    agent.id,
    home,
    NOW
  ));
  runTaskCommand(["activate", task.id], store, { now: () => NOW });
  runTaskCommand([
    "work", "create", task.id, "metadata result",
    ...(projectWork ? ["--project", "project-1"] : [])
  ], store, {
    now: () => NOW
  });
  const item = store.getWorkItem(task.id, "work-item-1");
  const leader = {
    now: () => NOW,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  const contract = createTaskFinalReviewContract({
    taskId: task.id,
    reviewerRoleName: "reviewer",
    controlPlaneDigest: "a".repeat(64)
  });
  const exact = {
    ...leader,
    taskFinalReviewContract: contract,
    actualTaskReviewCandidate: projectTask
      ? {
          schemaVersion: 1,
          projects: [{ projectId: "project-1", commit: "c".repeat(40) }]
        }
      : undefined
  };
  return {
    home,
    store,
    task,
    item,
    leader,
    contract,
    exact
  };
}

function submitAndAccept(fx, options = fx.exact) {
  runTaskCommand(["work", "update", fx.item.id, "running"], fx.store, fx.leader);
  runTaskCommand([
    "work", "update", fx.item.id, "done", "--summary", "metadata candidate"
  ], fx.store, options);
  runTaskCommand([
    "work", "accept", fx.item.id, "--summary", "candidate accepted"
  ], fx.store, options);
  const baseCommit = "b".repeat(40);
  const headCommit = "c".repeat(40);
  fx.store.transaction((tx) => {
    tx.saveChangeSet(fx.task.id, createWorkItemChangeSet({
      id: "change-set-1",
      taskId: fx.task.id,
      projectId: "project-1",
      workItemId: fx.item.id,
      baseCommit,
      headCommit,
      branch: "yui/task-1/main",
      changedPaths: ["metadata.txt"]
    }, NOW));
    const attempt = createIntegrationAttempt({
      id: "integration-1",
      taskId: fx.task.id,
      projectId: "project-1",
      targetRef: "yui/task-1/main",
      expectedHead: baseCommit,
      changeSetIds: ["change-set-1"],
      checkCommands: []
    }, NOW);
    tx.saveIntegrationAttempt(fx.task.id, updateIntegrationAttempt(
      attempt,
      { status: "committed", candidateCommit: headCommit },
      NOW
    ));
  });
}

function advanceIntegratedHead(fx) {
  const attempt = createIntegrationAttempt({
    id: "integration-2",
    taskId: fx.task.id,
    projectId: "project-1",
    targetRef: "yui/task-1/main",
    expectedHead: "c".repeat(40),
    changeSetIds: ["change-set-1"],
    checkCommands: []
  }, NOW);
  fx.store.saveIntegrationAttempt(fx.task.id, updateIntegrationAttempt(
    attempt,
    { status: "committed", candidateCommit: "d".repeat(40) },
    NOW
  ));
  fx.exact.actualTaskReviewCandidate = {
    schemaVersion: 1,
    projects: [{ projectId: "project-1", commit: "d".repeat(40) }]
  };
}

function completeReview(fx, round) {
  const workspaceRoot = join(fx.home, "reviews", round.id);
  const commit = round.taskCandidate?.projects[0].commit ?? round.reviewBaseCommit;
  const workspace = createManagedWorkspace({
    owner: { type: "review-round", taskId: fx.task.id, reviewRoundId: round.id },
    root: workspaceRoot,
    entries: [{
      projectId: "project-1",
      directory: "project",
      access: "write",
      path: join(workspaceRoot, "project"),
      branch: `yui/${fx.task.id}/${round.id}`,
      baseRef: commit,
      baseCommit: commit
    }]
  }, NOW);
  fx.store.transaction((tx) => {
    tx.saveManagedWorkspace(workspace);
    tx.saveReviewRound(fx.task.id, attachReviewRoundWorkspace(round, workspace));
  });
  const run = dispatchPreparedReviewRound(fx.task.id, round.id, fx.store, fx.exact);
  fx.store.transaction((tx) => {
    const terminal = terminalizeExactTaskRun(tx, {
      taskId: fx.task.id,
      roleName: run.roleName,
      agentId: run.effective.agentId,
      runId: run.id,
      receiptId: formatAgentRunReceiptId(fx.task.id, run.id),
      outcome: { status: "yielded", summary: "approved exact head" },
      reviewResult: {
        report: "approved exact head",
        checks: [{ name: "focused review", outcome: "passed" }]
      }
    }, NOW);
    assert.equal(terminal.disposition, "applied");
  });
}

function recordCompletedReviewEvidence(fx, round) {
  const workspaceRoot = join(fx.home, "reviews", round.id);
  const workspace = createManagedWorkspace({
    owner: { type: "review-round", taskId: fx.task.id, reviewRoundId: round.id },
    root: workspaceRoot,
    entries: [{
      projectId: "project-1",
      directory: "project",
      access: "write",
      path: join(workspaceRoot, "project"),
      branch: `yui/${fx.task.id}/${round.id}`,
      baseRef: round.reviewBaseCommit,
      baseCommit: round.reviewBaseCommit
    }]
  }, NOW);
  const reviewer = fx.store.getRole(fx.task.id, "reviewer");
  const runId = fx.store.nextAgentRunId(fx.task.id);
  const effective = resolveEffectiveLaunch({
    role: reviewer,
    purpose: "review",
    workspace,
    reviewRoundId: round.id,
    reviewBaseCommit: round.reviewBaseCommit
  });
  const run = yieldAgentRun(createAgentRun(
    runId,
    fx.task.id,
    reviewer.name,
    "new",
    "bounded WorkItem review",
    NOW,
    {
      purpose: "review",
      workItemId: round.workItemId,
      reviewRoundId: round.id,
      workspace,
      effective
    }
  ), "approved WorkItem evidence", NOW);
  fx.store.transaction((tx) => {
    tx.saveManagedWorkspace(workspace);
    const attached = attachReviewRoundWorkspace(round, workspace);
    tx.saveReviewRound(fx.task.id, attached);
    const running = startReviewRound(attached, run.id);
    tx.saveReviewRound(fx.task.id, running);
    tx.saveAgentRun(run);
    tx.saveReviewRound(
      fx.task.id,
      finishReviewRound(running, "completed", "approved WorkItem evidence", NOW)
    );
  });
}

test("exact Task contract creates a metadata-only Candidate and one final Task Review after global drift", (t) => {
  const fx = fixture(t);
  submitAndAccept(fx);
  assert.deepEqual(fx.item.writeProjectIds, ["project-1"]);
  const candidate = fx.store.getWorkItem(fx.task.id, fx.item.id).candidates[0];
  assert.equal(candidate.workspace, undefined);
  assert.deepEqual(candidate.reviewPolicy, {
    roleName: "reviewer",
    trigger: "final"
  });
  assert.deepEqual(candidate.taskFinalReviewContract, fx.contract);

  const requested = runTaskCommand([
    "complete", fx.task.id, "--summary", "request final review"
  ], fx.store, fx.exact);
  assert.match(requested.output, /Final Task Review requested/);
  const rounds = fx.store.listReviewRounds(fx.task.id);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].scope, "task");
  assert.deepEqual(rounds[0].taskFinalReviewContract, fx.contract);
  assert.equal(fx.store.getTask(fx.task.id).status, "active");

  const repeated = runTaskCommand([
    "complete", fx.task.id, "--summary", "resume the exact pending Review"
  ], fx.store, fx.exact);
  assert.match(repeated.output, /Final Task Review requested/);
  assert.equal(repeated.data.reviewRound.id, rounds[0].id);
  assert.deepEqual(repeated.data.reviewRound, rounds[0]);
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);

  completeReview(fx, rounds[0]);
  runTaskCommand([
    "complete", fx.task.id, "--summary", "complete reviewed head"
  ], fx.store, fx.exact);
  assert.equal(fx.store.getTask(fx.task.id).status, "completed");
});

test("pending exact Task Review recovery rejects identity and head drift without writes", (t) => {
  for (const drift of ["contract", "reviewer", "reviewer-run", "head"]) {
    const fx = fixture(t);
    submitAndAccept(fx);
    runTaskCommand([
      "complete", fx.task.id, "--summary", "establish exact pending Review"
    ], fx.store, fx.exact);
    const round = structuredClone(fx.store.listReviewRounds(fx.task.id)[0]);
    if (drift === "reviewer-run") {
      assert.throws(() => fx.store.saveReviewRound(fx.task.id, {
        ...round,
        reviewerRunId: "agent-run-99"
      }), /transition is invalid/i);
      assert.deepEqual(fx.store.getReviewRound(fx.task.id, round.id), round);
      continue;
    }
    const options = drift === "head"
      ? {
          ...fx.exact,
          actualTaskReviewCandidate: {
            schemaVersion: 1,
            projects: [{ projectId: "project-1", commit: "d".repeat(40) }]
          }
        }
      : {
          ...fx.exact,
          taskFinalReviewContract: createTaskFinalReviewContract({
            taskId: fx.task.id,
            reviewerRoleName: drift === "reviewer" ? "replacement-reviewer" : "reviewer",
            controlPlaneDigest: drift === "contract"
              ? "b".repeat(64)
              : fx.contract.controlPlaneDigest
          })
        };

    assert.throws(
      () => runTaskCommand([
        "complete", fx.task.id, "--summary", `reject ${drift} drift`
      ], fx.store, options),
      /contract|control-plane digest|actual Task head|Reviewer/i
    );
    assert.deepEqual(fx.store.getReviewRound(fx.task.id, round.id), round);
    assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
    assert.equal(
      fx.store.listAgentRuns(fx.task.id).filter(({ purpose }) => purpose === "review").length,
      0
    );
  }
});

test("exact Task contract is preserved by a no-Run final Review retry", (t) => {
  const fx = fixture(t);
  submitAndAccept(fx);
  const candidate = fx.store.getWorkItem(fx.task.id, fx.item.id).candidates.at(-1);
  const failed = finishReviewRound(createTaskReviewRound(
    fx.store.nextReviewRoundId(fx.task.id),
    fx.task.id,
    fx.item.id,
    candidate.id,
    "reviewer",
    "policy",
    fx.exact.actualTaskReviewCandidate,
    NOW,
    fx.contract
  ), "failed", "reviewer unavailable before dispatch", NOW);
  fx.store.saveReviewRound(fx.task.id, failed);

  const retried = runTaskCommand(
    ["work", "review", "retry", failed.id],
    fx.store,
    fx.exact
  );

  assert.match(retried.output, /Task-final Review retry requested/);
  const rounds = fx.store.listReviewRounds(fx.task.id);
  // Issue 06: infrastructure retry reuses the semantic Round ID.
  assert.equal(rounds.length, 1);
  const retryRound = rounds[0];
  assert.equal(retryRound.id, failed.id);
  assert.equal(retryRound.status, "pending");
  assert.deepEqual(retryRound.taskFinalReviewContract, fx.contract);
  assert.deepEqual(retryRound.taskCandidate, failed.taskCandidate);
  assert.equal(retryRound.report, undefined);
  assert.equal(retryRound.endedAt, undefined);
});

test("completed non-Task-scoped evidence cannot satisfy the exact Task contract", (t) => {
  const fx = fixture(t);
  submitAndAccept(fx);
  const candidate = fx.store.getWorkItem(fx.task.id, fx.item.id).candidates[0];
  const workRound = createReviewRound(
    fx.store.nextReviewRoundId(fx.task.id),
    fx.task.id,
    fx.item.id,
    candidate.id,
    "reviewer",
    "leader",
    "c".repeat(40),
    NOW
  );
  fx.store.saveReviewRound(fx.task.id, workRound);
  recordCompletedReviewEvidence(fx, workRound);

  const requested = runTaskCommand([
    "complete", fx.task.id, "--summary", "Task evidence is still required"
  ], fx.store, fx.exact);
  assert.match(requested.output, /Final Task Review requested/);
  const rounds = fx.store.listReviewRounds(fx.task.id);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].scope, undefined);
  assert.equal(rounds[0].status, "completed");
  assert.equal(rounds[1].scope, "task");
  assert.equal(rounds[1].status, "pending");
  assert.equal(fx.store.getTask(fx.task.id).status, "active");
});

test("completed older-head Task evidence cannot satisfy the current integrated head", (t) => {
  const fx = fixture(t);
  submitAndAccept(fx);
  runTaskCommand([
    "complete", fx.task.id, "--summary", "review first head"
  ], fx.store, fx.exact);
  const first = fx.store.listReviewRounds(fx.task.id)[0];
  completeReview(fx, first);
  advanceIntegratedHead(fx);

  const requested = runTaskCommand([
    "complete", fx.task.id, "--summary", "review current head"
  ], fx.store, fx.exact);
  assert.match(requested.output, /Final Task Review requested/);
  const rounds = fx.store.listReviewRounds(fx.task.id);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].status, "completed");
  assert.equal(rounds[0].taskCandidate.projects[0].commit, "c".repeat(40));
  assert.equal(rounds[1].status, "pending");
  assert.equal(rounds[1].taskCandidate.projects[0].commit, "d".repeat(40));
  assert.equal(fx.store.getTask(fx.task.id).status, "active");
});

test("missing, tampered, wrong-Task, and wrong-control contracts fail before WorkItem mutation", (t) => {
  for (const kind of ["missing", "tampered", "wrong-task", "wrong-control"]) {
    const fx = fixture(t);
    runTaskCommand(["work", "update", fx.item.id, "running"], fx.store, fx.leader);
    runTaskCommand([
      "work", "update", fx.item.id, "done", "--summary", "contract established"
    ], fx.store, fx.exact);
    const before = structuredClone(fx.store.getWorkItem(fx.task.id, fx.item.id));
    const contract = kind === "missing"
      ? undefined
      : kind === "tampered"
        ? { ...fx.contract, digest: "e".repeat(64) }
        : kind === "wrong-task"
          ? createTaskFinalReviewContract({
              taskId: "task-2",
              reviewerRoleName: "reviewer",
              controlPlaneDigest: fx.contract.controlPlaneDigest
            })
          : createTaskFinalReviewContract({
              taskId: fx.task.id,
              reviewerRoleName: "reviewer",
              controlPlaneDigest: "d".repeat(64)
            });
    assert.throws(
      () => runTaskCommand([
        "work", "accept", fx.item.id, "--summary", "must not persist"
      ], fx.store, {
        ...fx.leader,
        taskFinalReviewContract: contract
      }),
      /Task final-review contract|control-plane digest|Task id|missing/i
    );
    assert.deepEqual(fx.store.getWorkItem(fx.task.id, fx.item.id), before);
  }
});

test("Task-final contract stays Task-scoped and requires a Project-backed Task", (t) => {
  const fx = fixture(t);
  runTaskCommand(["work", "update", fx.item.id, "running"], fx.store, fx.leader);
  runTaskCommand([
    "work", "update", fx.item.id, "done", "--summary", "Task-final candidate"
  ], fx.store, fx.exact);
  assert.throws(() => runTaskCommand([
    "work", "review", fx.item.id
  ], fx.store, fx.leader), /Final review policy is Task-scoped/);
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 0);

  const unbound = fixture(t, { projectTask: false, projectWork: false });
  runTaskCommand([
    "work", "update", unbound.item.id, "running"
  ], unbound.store, unbound.leader);
  const before = structuredClone(
    unbound.store.getWorkItem(unbound.task.id, unbound.item.id)
  );
  assert.throws(() => runTaskCommand([
    "work", "update", unbound.item.id, "done", "--summary", "must not persist"
  ], unbound.store, unbound.exact), /requires a Project-backed Task/);
  assert.deepEqual(
    unbound.store.getWorkItem(unbound.task.id, unbound.item.id),
    before
  );
});

test("raw environment cannot forge a Task contract and ordinary global policy remains unchanged", (t) => {
  const projectFx = fixture(t);
  const forgedProjectOptions = {
    ...projectFx.leader,
    environment: {
      ...projectFx.leader.environment,
      YUI_TASK_FINAL_REVIEW: JSON.stringify(projectFx.contract)
    }
  };
  runTaskCommand([
    "work", "update", projectFx.item.id, "running"
  ], projectFx.store, projectFx.leader);
  assert.throws(() => runTaskCommand([
    "work", "update", projectFx.item.id, "done", "--summary", "must remain isolated"
  ], projectFx.store, forgedProjectOptions), /must be isolated/);
  assert.equal(
    projectFx.store.getWorkItem(projectFx.task.id, projectFx.item.id).status,
    "running"
  );

  const fx = fixture(t, { projectWork: false });
  const ordinary = {
    ...fx.leader,
    environment: {
      ...fx.leader.environment,
      YUI_TASK_FINAL_REVIEW: JSON.stringify(fx.contract)
    }
  };
  submitAndAccept(fx, ordinary);
  const candidate = fx.store.getWorkItem(fx.task.id, fx.item.id).candidates[0];
  assert.deepEqual(candidate.reviewPolicy, {
    roleName: "reviewer",
    trigger: "leader"
  });
  assert.equal(candidate.taskFinalReviewContract, undefined);

  runTaskCommand([
    "complete", fx.task.id, "--summary", "ordinary completion"
  ], fx.store, ordinary);
  assert.equal(fx.store.getTask(fx.task.id).status, "completed");
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 0);
});
