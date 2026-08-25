import assert from "node:assert/strict";
import test from "node:test";

import { createYieldReceipt } from "../../dist/run/yieldReceipt.js";
import {
  classifyReviewRoundOutcome
} from "../../dist/review/reviewOutcomeClassifier.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import { projectNextAction } from "../../dist/task/nextAction.js";

const now = new Date("2026-08-24T00:00:00.000Z");
const later = new Date("2026-08-24T00:01:00.000Z");
const commit = "a".repeat(40);

function review(overrides = {}) {
  return {
    schemaVersion: 4,
    id: "review-round-1",
    taskId: "task-1",
    workItemId: "work-item-1",
    candidateId: "candidate-1",
    reviewerRoleName: "reviewer",
    reviewBaseCommit: commit,
    requestedBy: "leader",
    status: "completed",
    summary: "Reviewed candidate",
    report: "No findings",
    checks: [],
    evidenceCommit: commit,
    createdAt: now.toISOString(),
    endedAt: later.toISOString(),
    ...overrides
  };
}

test("Review outcomes distinguish semantic, non-semantic, and ambiguous evidence", () => {
  assert.equal(classifyReviewRoundOutcome(review()).kind, "semantic");
  assert.equal(classifyReviewRoundOutcome(review({
    status: "failed",
    summary: "Role Run could not start",
    report: "Role Run could not start",
    evidenceCommit: undefined
  })).kind, "non-semantic");
  assert.equal(classifyReviewRoundOutcome(review({
    status: "failed",
    summary: "Role Run could not start",
    report: JSON.stringify({ findings: [{ severity: "P1", summary: "real finding" }] }),
    evidenceCommit: undefined
  })).kind, "ambiguous");

  const summary = "Role Run workspace is not the durable owner: task-1/reviewer.";
  const round = review({
    reviewerRunId: "agent-run-1",
    summary,
    report: summary
  });
  const outcome = {
    status: "yielded",
    summary,
    reviewResult: { report: summary, checks: [], evidenceCommit: commit }
  };
  const run = {
    id: "agent-run-1",
    taskId: "task-1",
    roleName: "reviewer",
    purpose: "review",
    reviewRoundId: round.id,
    status: "yielded",
    summary,
    yieldReceipt: createYieldReceipt("task-1", "agent-run-1", outcome, later)
  };
  const event = {
    id: "event-1",
    taskId: "task-1",
    type: "review.completed",
    payload: {
      reviewRoundId: round.id,
      workItemId: round.workItemId,
      candidateId: round.candidateId,
      reviewBaseCommit: commit,
      evidenceCommit: commit,
      checks: "none"
    },
    createdAt: later.toISOString()
  };
  assert.equal(classifyReviewRoundOutcome(round).kind, "ambiguous");
  assert.equal(classifyReviewRoundOutcome(round, {
    listAgentRuns: () => [run],
    listReviewFindings: () => [],
    listEvents: () => [event]
  }).kind, "non-semantic");
});

test("next-action force-refreshes corroborated non-semantic completed Reviews", () => {
  const summary = "Role Run workspace is not the durable owner: task-1/reviewer.";
  const round = review({
    scope: "task",
    reviewerRunId: "agent-run-1",
    summary,
    report: summary,
    taskCandidate: {
      schemaVersion: 1,
      projects: [{ projectId: "project-1", commit }]
    }
  });
  const runOutcome = {
    status: "yielded",
    summary,
    reviewResult: { report: summary, checks: [], evidenceCommit: commit }
  };
  const run = {
    id: "agent-run-1",
    taskId: "task-1",
    roleName: "reviewer",
    purpose: "review",
    reviewRoundId: round.id,
    status: "yielded",
    summary,
    yieldReceipt: createYieldReceipt("task-1", "agent-run-1", runOutcome, later)
  };
  const event = {
    id: "event-1",
    taskId: "task-1",
    type: "review.completed",
    payload: {
      reviewRoundId: round.id,
      workItemId: round.workItemId,
      candidateId: round.candidateId,
      reviewBaseCommit: commit,
      evidenceCommit: commit,
      checks: "none"
    },
    createdAt: later.toISOString()
  };
  const item = {
    ...createWorkItem("work-item-1", "task-1", { title: "fix" }, now),
    status: "completed",
    outcome: "done",
    endedAt: later.toISOString(),
    updatedAt: later.toISOString()
  };
  const facts = {
    task: {
      id: "task-1",
      status: "active",
      projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "main" }],
      requireIntegration: true
    },
    workItems: [item],
    changeSets: [{
      id: "change-set-1",
      taskId: "task-1",
      workItemId: item.id,
      projectId: "project-1",
      baseCommit: "b".repeat(40),
      headCommit: commit,
      branch: "change",
      changedPaths: ["value.txt"],
      createdAt: now.toISOString()
    }],
    integrations: [{
      id: "integration-1",
      taskId: "task-1",
      projectId: "project-1",
      targetRef: "refs/heads/main",
      expectedHead: "b".repeat(40),
      changeSetIds: ["change-set-1"],
      checkCommands: [],
      candidateCommit: commit,
      status: "committed",
      createdAt: now.toISOString(),
      updatedAt: later.toISOString(),
      endedAt: later.toISOString()
    }],
    reviewRounds: [round],
    taskFinalReviewContractEvents: [],
    reviewConfig: { roleName: "reviewer", trigger: "final" },
    openInputRequests: [],
    activeRuns: [],
    leaderRuns: []
  };
  assert.equal(projectNextAction(facts).kind, "repair-protocol-inconsistency");
  const action = projectNextAction({
    ...facts,
    reviewOutcomeEvidence: { agentRuns: [run], reviewFindings: [], events: [event] }
  });
  assert.equal(action.kind, "resume-review");
  assert.equal(
    action.recommendedCommand,
    "yui task review force-fresh task-1/review-round-1"
  );
});
