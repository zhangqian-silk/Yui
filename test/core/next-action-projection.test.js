import assert from "node:assert/strict";
import test from "node:test";

import { createTask, activateTask, completeTask } from "../../dist/task/task.js";
import { projectNextAction } from "../../dist/task/nextAction.js";
import {
  createWorkItem,
  updateWorkItemStatus,
  submitWorkItemCandidate,
  retireWorkItem
} from "../../dist/workItem/workItem.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import {
  createIntegrationAttempt,
  updateIntegrationAttempt
} from "../../dist/integration/integrationAttempt.js";
import {
  createReviewRound,
  createTaskReviewRound,
  finishReviewRound
} from "../../dist/review/reviewRound.js";
import { createTaskFinalReviewContract } from "../../dist/review/taskFinalReviewContract.js";
import { yieldAgentRun } from "../../dist/run/agentRun.js";
import { createAgentRun } from "../helpers/effectiveLaunch.js";
import { createInputRequest } from "../../dist/input/inputRequest.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");
const BASE = "0".repeat(40);
const HEAD = "1".repeat(40);
const HEAD2 = "2".repeat(40);
const DIGEST = "a".repeat(64);

function taskFixture(status = "active", { projects = true } = {}) {
  let task = createTask("task-1", "Deliver the thing", NOW, {
    ...(projects
      ? { projectBindings: [{ projectId: "project-1", directory: "one", baseRef: "main" }] }
      : {})
  });
  if (status === "active") task = activateTask(task, NOW);
  if (status === "completed") {
    task = activateTask(task, NOW);
    task = completeTask(task, NOW, { by: "leader", summary: "done" });
  }
  return task;
}

function facts(overrides = {}) {
  const task = overrides.task ?? taskFixture();
  return {
    task: { id: task.id, status: task.status, projectBindings: task.projectBindings },
    workItems: overrides.workItems ?? [],
    changeSets: overrides.changeSets ?? [],
    integrations: overrides.integrations ?? [],
    reviewRounds: overrides.reviewRounds ?? [],
    openInputRequests: overrides.openInputRequests ?? [],
    activeRuns: overrides.activeRuns ?? [],
    leaderRuns: overrides.leaderRuns ?? []
  };
}

function workItem(status = "pending", overrides = {}) {
  let item = createWorkItem("work-item-1", "task-1", {
    title: "Change the parser",
    objective: "Change the parser",
    acceptance: ["parser handles X"],
    writeProjectIds: ["project-1"],
    ...overrides
  }, NOW);
  if (status !== "pending") {
    const next = status === "awaiting_acceptance" ? "running" : status;
    const terminal = ["completed", "failed", "retired"].includes(next);
    item = updateWorkItemStatus(item, next, NOW, terminal ? "fixture outcome" : undefined);
  }
  return item;
}

function directCandidate(item, { baseCommit = BASE, headCommit = HEAD } = {}) {
  const contract = createTaskFinalReviewContract({
    taskId: "task-1",
    reviewerRoleName: "reviewer",
    controlPlaneDigest: DIGEST
  });
  return submitWorkItemCandidate(item, {
    summary: "direct delivery",
    source: { type: "direct" },
    reviewPolicy: { roleName: "reviewer", trigger: "final" },
    taskFinalReviewContract: contract,
    taskMainSnapshot: {
      schemaVersion: 1,
      projects: [{
        projectId: "project-1",
        directory: "one",
        branch: "main",
        baseCommit,
        headCommit
      }]
    }
  }, NOW);
}

function candidateWithWorkspace(item) {
  const workspace = createManagedWorkspace({
    owner: { type: "work-item", taskId: "task-1", workItemId: item.id },
    root: "/tmp/work-item-1",
    entries: [{
      projectId: "project-1",
      directory: "one",
      access: "write",
      path: "/tmp/work-item-1/one",
      branch: "yui/task-1/work-item-1",
      baseRef: "main",
      baseCommit: BASE
    }]
  }, NOW);
  return submitWorkItemCandidate(item, {
    summary: "implemented",
    source: { type: "direct" },
    workspace
  }, NOW);
}

function completedWithWorkspaceCandidate() {
  let item = workItem("awaiting_acceptance");
  item = candidateWithWorkspace(item);
  return updateWorkItemStatus(item, "completed", NOW, "delivered");
}

function changeSet(headCommit = HEAD) {
  return createWorkItemChangeSet({
    id: "change-set-1",
    taskId: "task-1",
    workItemId: "work-item-1",
    projectId: "project-1",
    baseCommit: BASE,
    headCommit,
    branch: "yui/task-1/work-item-1",
    changedPaths: ["src/parser.ts"]
  }, NOW);
}

function committedIntegration(changeSetIds = ["change-set-1"]) {
  const attempt = createIntegrationAttempt({
    id: "integration-1",
    taskId: "task-1",
    projectId: "project-1",
    targetRef: "main",
    expectedHead: BASE,
    changeSetIds
  }, NOW);
  return updateIntegrationAttempt(attempt, { status: "committed" }, NOW);
}

function finalReview(headCommits, { status = "completed" } = {}) {
  let round = createTaskReviewRound(
    "review-round-1",
    "task-1",
    "work-item-1",
    "candidate-1",
    "reviewer",
    "leader",
    { schemaVersion: 1, projects: headCommits.map((commit) => ({ projectId: "project-1", commit })) },
    NOW
  );
  if (status === "completed" || status === "failed") {
    round = finishReviewRound(round, status, "verdict", NOW);
  }
  return round;
}

function leaderRun(id, { status = "active", yielded = false } = {}) {
  let run = createAgentRun(id, "task-1", "leader", "new", "wake", NOW, {});
  if (status === "yielded" || yielded) run = yieldAgentRun(run, "waiting", NOW);
  return run;
}

const LIFECYCLE_CASES = [
  {
    name: "draft Task with no WorkItem defers to activation",
    facts: facts({ task: taskFixture("draft") }),
    kind: "implement-current-work-item",
    command: "yui task activate task-1"
  },
  {
    name: "active Task with no WorkItem creates the first unit of work",
    facts: facts(),
    kind: "implement-current-work-item",
    command: "yui task work create task-1"
  },
  {
    name: "pending WorkItem is dispatched",
    facts: facts({ workItems: [workItem("pending")] }),
    kind: "implement-current-work-item",
    command: "yui task work dispatch task-1/work-item-1"
  },
  {
    name: "running WorkItem continues implementation",
    facts: facts({ workItems: [workItem("running")] }),
    kind: "implement-current-work-item",
    command: "yui task work dispatch task-1/work-item-1"
  },
  {
    name: "Candidate awaiting acceptance converges to accept-or-reject",
    facts: facts({ workItems: [candidateWithWorkspace(workItem("awaiting_acceptance"))] }),
    kind: "accept-or-reject-candidate",
    command: "yui task work accept task-1/work-item-1"
  },
  {
    name: "base==head direct Candidate is a protocol inconsistency",
    facts: facts({ workItems: [directCandidate(workItem("awaiting_acceptance"), { baseCommit: BASE, headCommit: BASE })] }),
    kind: "repair-protocol-inconsistency",
    command: "yui task work reject task-1/work-item-1"
  },
  {
    name: "failed WorkItem without a Review retries implementation",
    facts: facts({ workItems: [workItem("failed")] }),
    kind: "implement-current-work-item",
    command: "yui task work update task-1/work-item-1 running"
  },
  {
    name: "failed WorkItem with a failed Review routes findings",
    facts: facts({
      workItems: [workItem("failed")],
      reviewRounds: [
        finishReviewRound(
          createReviewRound("review-round-1", "task-1", "work-item-1", "candidate-1", "reviewer", "leader", BASE, NOW),
          "failed",
          "findings",
          NOW
        )
      ]
    }),
    kind: "route-review-findings"
  },
  {
    name: "active Leader Run waits for owned execution",
    facts: facts({ activeRuns: [leaderRun("run-1")] }),
    kind: "wait-for-owned-execution"
  },
  {
    name: "active Worker Run waits for owned execution",
    facts: facts({
      workItems: [workItem("running")],
      activeRuns: [createAgentRun("run-1", "task-1", "worker", "new", "impl", NOW, { workItemId: "work-item-1" })]
    }),
    kind: "wait-for-owned-execution"
  },
  {
    name: "open Input resolves before any protocol action",
    facts: facts({
      openInputRequests: [
        createInputRequest("input-1", "task-1", { taskId: "task-1", runId: "agent-run-1", roleName: "leader", agentId: "codex" }, {
          question: "Which scope?",
          choices: [],
          blockedRefs: []
        }, NOW)
      ]
    }),
    kind: "resolve-input",
    command: "yui task input answer task-1/input-1"
  },
  {
    name: "completed WorkItem without a ChangeSet captures one",
    facts: facts({ workItems: [completedWithWorkspaceCandidate()] }),
    kind: "capture-change-set",
    command: "yui task work capture task-1/work-item-1"
  },
  {
    name: "ChangeSet without a committed Integration integrates",
    facts: facts({
      workItems: [workItem("completed")],
      changeSets: [changeSet()]
    }),
    kind: "integrate-change-set",
    command: "yui task integration start task-1 --project project-1 --change-set change-set-1"
  },
  {
    name: "integrated Task without a final Review requests one",
    facts: facts({
      workItems: [workItem("completed")],
      changeSets: [changeSet()],
      integrations: [committedIntegration()]
    }),
    kind: "request-final-review",
    command: "yui task review request task-1 --role"
  },
  {
    name: "failed Task-final Review routes a repair wave",
    facts: facts({
      workItems: [workItem("completed")],
      changeSets: [changeSet()],
      integrations: [committedIntegration()],
      reviewRounds: [finalReview([HEAD], { status: "failed" })]
    }),
    kind: "route-review-findings"
  },
  {
    name: "valid final Review at the integrated head converges to complete",
    facts: facts({
      workItems: [workItem("completed")],
      changeSets: [changeSet()],
      integrations: [committedIntegration()],
      reviewRounds: [finalReview([HEAD], { status: "completed" })]
    }),
    kind: "complete-task",
    command: "yui task complete task-1 --summary-file -"
  },
  {
    name: "already completed Task converges without a successor",
    facts: facts({ task: taskFixture("completed") }),
    kind: "complete-task"
  },
  {
    name: "Gitless Task completes after its WorkItem without a Review",
    facts: facts({
      task: taskFixture("active", { projects: false }),
      workItems: [workItem("completed")]
    }),
    kind: "complete-task",
    command: "yui task complete task-1 --summary-file -"
  }
];

for (const { name, facts: caseFacts, kind, command } of LIFECYCLE_CASES) {
  test(`next action: ${name}`, () => {
    const action = projectNextAction(caseFacts);
    assert.equal(action.kind, kind);
    assert.ok(action.reason.length > 0);
    assert.ok(action.fingerprint.length > 0);
    if (command !== undefined) {
      assert.ok(
        action.recommendedCommand !== undefined
          && action.recommendedCommand.startsWith(command),
        `expected recommended command starting with ${command}, got ${action.recommendedCommand}`
      );
    }
  });
}

test("next action returns exact refs for every lifecycle stage", () => {
  const cases = [
    { facts: facts({ workItems: [workItem("pending")] }), ref: "work-item work-item-1" },
    {
      facts: facts({ workItems: [candidateWithWorkspace(workItem("awaiting_acceptance"))] }),
      ref: "candidate work-item-1/candidate-1"
    },
    {
      facts: facts({ workItems: [workItem("completed")], changeSets: [changeSet()] }),
      ref: "change-set change-set-1"
    },
    {
      facts: facts({
        workItems: [workItem("completed")],
        changeSets: [changeSet()],
        integrations: [committedIntegration()]
      }),
      ref: "task task-1"
    }
  ];
  for (const { facts: caseFacts, ref } of cases) {
    const action = projectNextAction(caseFacts);
    const rendered = action.refs.map((entry) => `${entry.kind} ${entry.id}`).join(", ");
    assert.ok(rendered.includes(ref), `${action.kind} refs ${rendered} should include ${ref}`);
  }
});

test("next action: already-integrated ChangeSet is not re-integrated", () => {
  const action = projectNextAction(facts({
    workItems: [workItem("completed")],
    changeSets: [changeSet()],
    integrations: [committedIntegration()]
  }));
  assert.notEqual(action.kind, "integrate-change-set");
});

test("next action: already-reviewed head does not request another final Review", () => {
  const action = projectNextAction(facts({
    workItems: [workItem("completed")],
    changeSets: [changeSet()],
    integrations: [committedIntegration()],
    reviewRounds: [finalReview([HEAD], { status: "completed" })]
  }));
  assert.notEqual(action.kind, "request-final-review");
  assert.equal(action.kind, "complete-task");
});

test("next action: final Review at a different head still requests review", () => {
  const action = projectNextAction(facts({
    workItems: [workItem("completed")],
    changeSets: [changeSet(HEAD2)],
    integrations: [committedIntegration()],
    reviewRounds: [finalReview([HEAD], { status: "completed" })]
  }));
  assert.equal(action.kind, "request-final-review");
});

test("next action: dangling committed Integration is a protocol inconsistency", () => {
  const action = projectNextAction(facts({
    workItems: [workItem("completed")],
    integrations: [committedIntegration(["change-set-2"])]
  }));
  assert.equal(action.kind, "repair-protocol-inconsistency");
  assert.ok(action.conflicts?.some((ref) => ref.id === "integration-1"));
  assert.ok(action.conflicts?.some((ref) => ref.id === "change-set-2"));
});

test("next action: pending Review on a retired WorkItem is a protocol inconsistency", () => {
  const retired = retireWorkItem(workItem("running"), {
    by: "leader",
    summary: "obsolete"
  }, NOW);
  const action = projectNextAction(facts({
    workItems: [retired],
    reviewRounds: [
      createReviewRound("review-round-1", "task-1", "work-item-1", "candidate-1", "reviewer", "leader", BASE, NOW)
    ]
  }));
  assert.equal(action.kind, "repair-protocol-inconsistency");
  assert.ok(action.conflicts?.some((ref) => ref.id === "review-round-1"));
});

test("next action: identical projection inputs produce the same fingerprint", () => {
  const left = projectNextAction(facts({ workItems: [workItem("pending")] }));
  const right = projectNextAction(facts({ workItems: [workItem("pending")] }));
  assert.equal(left.fingerprint, right.fingerprint);
});
