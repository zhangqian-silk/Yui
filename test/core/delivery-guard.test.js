import assert from "node:assert/strict";
import test from "node:test";

import { createTask, activateTask, completeTask } from "../../dist/task/task.js";
import {
  detectDeliveryDuplicates,
  evaluateDeliveryGuard,
  evaluateSemanticBudget,
  formatDeliveryDuplicate
} from "../../dist/task/deliveryGuard.js";
import {
  createWorkItem,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import {
  createIntegrationAttempt,
  updateIntegrationAttempt
} from "../../dist/integration/integrationAttempt.js";
import {
  createTaskReviewRound,
  finishReviewRound
} from "../../dist/review/reviewRound.js";
import { yieldAgentRun } from "../../dist/run/agentRun.js";
import { createAgentRun } from "../helpers/effectiveLaunch.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");
const BASE = "0".repeat(40);
const HEAD = "1".repeat(40);

function taskFixture(status = "active") {
  let task = createTask("task-1", "Deliver the thing", NOW, {
    projectBindings: [{ projectId: "project-1", directory: "one", baseRef: "main" }]
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

function workItem(id, status, overrides = {}) {
  let item = createWorkItem(id, "task-1", {
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

function changeSet(id = "change-set-1", headCommit = HEAD) {
  return createWorkItemChangeSet({
    id,
    taskId: "task-1",
    workItemId: "work-item-1",
    projectId: "project-1",
    baseCommit: BASE,
    headCommit,
    branch: "yui/task-1/work-item-1",
    changedPaths: ["src/parser.ts"]
  }, NOW);
}

function integration(id, status, changeSetIds = ["change-set-1"]) {
  const attempt = createIntegrationAttempt({
    id,
    taskId: "task-1",
    projectId: "project-1",
    targetRef: "main",
    expectedHead: BASE,
    changeSetIds
  }, NOW);
  return updateIntegrationAttempt(attempt, { status }, NOW);
}

function taskFinalReview(id, headCommits, status = "completed") {
  let round = createTaskReviewRound(
    id,
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

function yieldedLeaderRun(id, now = NOW) {
  return yieldAgentRun(
    createAgentRun(id, "task-1", "leader", "new", "wake", now, {}),
    "waiting for facts",
    now
  );
}

// --- duplicate detection -------------------------------------------------

test("guard: open Work Item with identical scope is an exact duplicate", () => {
  const duplicates = detectDeliveryDuplicates(
    facts({ workItems: [workItem("work-item-1", "running")] }),
    {
      kind: "create-work-item",
      scope: {
        title: "Change the parser",
        objective: "Change the parser",
        acceptance: ["parser handles X"],
        writeProjectIds: ["project-1"]
      }
    }
  );
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].severity, "exact");
  assert.equal(duplicates[0].refs[0].id, "work-item-1");
  assert.ok(duplicates[0].reuseCommand.includes("work-item-1"));
});

test("guard: completed identical scope is only a suspected duplicate", () => {
  const duplicates = detectDeliveryDuplicates(
    facts({ workItems: [workItem("work-item-1", "completed")] }),
    {
      kind: "create-work-item",
      scope: {
        title: "Change the parser",
        objective: "Change the parser",
        acceptance: ["parser handles X"],
        writeProjectIds: ["project-1"]
      }
    }
  );
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].severity, "suspected");
});

test("guard: different title but same Project and acceptance overlap is suspected", () => {
  const duplicates = detectDeliveryDuplicates(
    facts({ workItems: [workItem("work-item-1", "running")] }),
    {
      kind: "create-work-item",
      scope: {
        title: "A completely different title",
        objective: "Different objective",
        acceptance: ["parser handles X"],
        writeProjectIds: ["project-1"]
      }
    }
  );
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].severity, "suspected");
});

test("guard: distinct scope with no acceptance overlap is not a duplicate", () => {
  const duplicates = detectDeliveryDuplicates(
    facts({ workItems: [workItem("work-item-1", "running")] }),
    {
      kind: "create-work-item",
      scope: {
        title: "Change the lexer",
        objective: "Change the lexer",
        acceptance: ["lexer handles Y"],
        writeProjectIds: ["project-1"]
      }
    }
  );
  assert.equal(duplicates.length, 0);
});

test("guard: committed Integration with the same ChangeSet set is exact", () => {
  const duplicates = detectDeliveryDuplicates(
    facts({
      workItems: [workItem("work-item-1", "completed")],
      changeSets: [changeSet()],
      integrations: [integration("integration-1", "committed")]
    }),
    { kind: "integration-start", projectId: "project-1", changeSetIds: ["change-set-1"] }
  );
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].severity, "exact");
  assert.equal(duplicates[0].refs[0].id, "integration-1");
});

test("guard: running Integration for the same set is only suspected", () => {
  const duplicates = detectDeliveryDuplicates(
    facts({
      workItems: [workItem("work-item-1", "completed")],
      changeSets: [changeSet()],
      integrations: [integration("integration-1", "running")]
    }),
    { kind: "integration-start", projectId: "project-1", changeSetIds: ["change-set-1"] }
  );
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].severity, "suspected");
});

test("guard: a different ChangeSet set is not an Integration duplicate", () => {
  const duplicates = detectDeliveryDuplicates(
    facts({
      workItems: [workItem("work-item-1", "completed")],
      changeSets: [changeSet("change-set-1"), changeSet("change-set-2", "2".repeat(40))],
      integrations: [integration("integration-1", "committed")]
    }),
    { kind: "integration-start", projectId: "project-1", changeSetIds: ["change-set-2"] }
  );
  assert.equal(duplicates.length, 0);
});

test("guard: completed Task-final Review at the same head is exact", () => {
  const duplicates = detectDeliveryDuplicates(
    facts({ reviewRounds: [taskFinalReview("review-round-1", [HEAD], "completed")] }),
    { kind: "review-request", reviewerRoleName: "reviewer", taskCandidateCommits: [HEAD] }
  );
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].severity, "exact");
  assert.equal(duplicates[0].refs[0].id, "review-round-1");
});

test("guard: pending Task-final Review at the same head is suspected", () => {
  const duplicates = detectDeliveryDuplicates(
    facts({ reviewRounds: [taskFinalReview("review-round-1", [HEAD], "pending")] }),
    { kind: "review-request", reviewerRoleName: "reviewer", taskCandidateCommits: [HEAD] }
  );
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].severity, "suspected");
});

test("guard: a different reviewer or head is not a Review duplicate", () => {
  const base = facts({ reviewRounds: [taskFinalReview("review-round-1", [HEAD], "completed")] });
  assert.equal(
    detectDeliveryDuplicates(base, {
      kind: "review-request",
      reviewerRoleName: "other-reviewer",
      taskCandidateCommits: [HEAD]
    }).length,
    0
  );
  assert.equal(
    detectDeliveryDuplicates(base, {
      kind: "review-request",
      reviewerRoleName: "reviewer",
      taskCandidateCommits: ["2".repeat(40)]
    }).length,
    0
  );
});

test("guard: completing an already completed Task is an exact duplicate", () => {
  const duplicates = detectDeliveryDuplicates(
    facts({ task: taskFixture("completed") }),
    { kind: "complete-task" }
  );
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].severity, "exact");
});

// --- mode evaluation ------------------------------------------------------

test("guard modes: display never interferes", () => {
  const duplicates = [{
    severity: "exact",
    reason: "already open",
    refs: [{ kind: "work-item", id: "work-item-1" }]
  }];
  const outcome = evaluateDeliveryGuard(duplicates, "display");
  assert.equal(outcome.blocked, null);
  assert.equal(outcome.warnings.length, 0);
});

test("guard modes: warn reports every match without blocking", () => {
  const duplicates = [
    { severity: "exact", reason: "already open", refs: [{ kind: "work-item", id: "work-item-1" }] },
    { severity: "suspected", reason: "maybe", refs: [{ kind: "work-item", id: "work-item-2" }] }
  ];
  const outcome = evaluateDeliveryGuard(duplicates, "warn");
  assert.equal(outcome.blocked, null);
  assert.equal(outcome.warnings.length, 2);
});

test("guard modes: enforce blocks on exact evidence and warns on suspected", () => {
  const duplicates = [
    { severity: "suspected", reason: "maybe", refs: [{ kind: "work-item", id: "work-item-2" }] },
    { severity: "exact", reason: "already open", refs: [{ kind: "work-item", id: "work-item-1" }] }
  ];
  const outcome = evaluateDeliveryGuard(duplicates, "enforce");
  assert.ok(outcome.blocked !== null);
  assert.equal(outcome.blocked.severity, "exact");
  assert.equal(outcome.warnings.length, 1);
  assert.equal(outcome.warnings[0].severity, "suspected");
});

test("guard modes: enforce with only suspected duplicates does not block", () => {
  const duplicates = [
    { severity: "suspected", reason: "maybe", refs: [{ kind: "work-item", id: "work-item-2" }] }
  ];
  const outcome = evaluateDeliveryGuard(duplicates, "enforce");
  assert.equal(outcome.blocked, null);
  assert.equal(outcome.warnings.length, 1);
});

test("formatDeliveryDuplicate renders severity, reason, refs and reuse command", () => {
  const line = formatDeliveryDuplicate({
    severity: "exact",
    reason: "already open",
    refs: [{ kind: "work-item", id: "work-item-1" }],
    reuseCommand: "yui task work show task-1/work-item-1"
  });
  assert.ok(line.startsWith("Exact duplicate: already open (work-item work-item-1)."));
  assert.ok(line.includes("yui task work show task-1/work-item-1"));
});

// --- semantic progress budget --------------------------------------------

test("budget: three yielded Leader turns with no durable change are exhausted", () => {
  const budget = evaluateSemanticBudget(facts({
    leaderRuns: [
      yieldedLeaderRun("run-1"),
      yieldedLeaderRun("run-2"),
      yieldedLeaderRun("run-3")
    ]
  }));
  assert.equal(budget.exhausted, true);
  assert.deepEqual(budget.evidence, ["run-1", "run-2", "run-3"]);
});

test("budget: an active Run is never interrupted by the budget", () => {
  const budget = evaluateSemanticBudget(facts({
    activeRuns: [createAgentRun("run-active", "task-1", "worker", "new", "impl", NOW, {})],
    leaderRuns: [
      yieldedLeaderRun("run-1"),
      yieldedLeaderRun("run-2"),
      yieldedLeaderRun("run-3")
    ]
  }));
  assert.equal(budget.exhausted, false);
  assert.ok(budget.evidence.includes("run-active"));
});

test("budget: a recent durable delivery change is not exhausted", () => {
  const earlier = new Date(NOW.getTime() - 60_000);
  const later = new Date(NOW.getTime() + 60_000);
  const staleItem = updateWorkItemStatus(
    workItem("work-item-1", "pending", {}),
    "running",
    earlier
  );
  const changedItem = updateWorkItemStatus(
    workItem("work-item-1", "pending", {}),
    "running",
    later
  );
  const leaderRuns = [
    yieldedLeaderRun("run-1"),
    yieldedLeaderRun("run-2"),
    yieldedLeaderRun("run-3")
  ];
  const budget = evaluateSemanticBudget(facts({
    workItems: [staleItem],
    leaderRuns
  }));
  const budgetWithChange = evaluateSemanticBudget(facts({
    workItems: [changedItem],
    leaderRuns
  }));
  assert.equal(budget.exhausted, true);
  assert.equal(budgetWithChange.exhausted, false);
});

test("budget: fewer than the threshold of yielded turns is not exhausted", () => {
  const budget = evaluateSemanticBudget(facts({
    leaderRuns: [yieldedLeaderRun("run-1"), yieldedLeaderRun("run-2")]
  }));
  assert.equal(budget.exhausted, false);
});

test("budget: only yielded Leader Runs count toward the threshold", () => {
  const budget = evaluateSemanticBudget(facts({
    leaderRuns: [
      yieldedLeaderRun("run-1"),
      createAgentRun("run-2", "task-1", "leader", "new", "wake", NOW, {}),
      yieldedLeaderRun("run-3")
    ]
  }));
  assert.equal(budget.exhausted, false);
});
