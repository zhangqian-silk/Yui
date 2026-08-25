import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession,
  updateRoleAgentSessionStatus
} from "../../dist/executor/agentExecutor.js";
import { createYieldReceipt } from "../../dist/run/yieldReceipt.js";
import {
  classifyReviewRoundOutcome
} from "../../dist/review/reviewOutcomeClassifier.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import { projectNextAction } from "../../dist/task/nextAction.js";
import {
  boundProviderRetryBeforeFirstProgress,
  projectFirstProgressStopLoss
} from "../../dist/runtime/firstProgressStopLoss.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";

const now = new Date("2026-08-24T00:00:00.000Z");
const later = new Date("2026-08-24T00:01:00.000Z");
const commit = "a".repeat(40);
const effective = {
  schemaVersion: 2,
  sourceDesiredRevision: 1,
  agentId: "agent",
  adapterId: "codex",
  profileAccess: "write",
  search: false,
  permission: { strategy: "default" },
  writeProjectIds: [],
  workspace: { root: "/tmp/yui-orchestration", entries: [] },
  context: {}
};

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

function taskSessions(owner = { scope: "task", taskId: "task-1", roleName: "leader" }) {
  let sessions = createRoleSessionSet(owner, "agent", now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "agent",
    adapterId: "codex",
    nativeSessionId: "session-1",
    launchId: "launch-1",
    status: "running",
    policy: "fixed",
    effective
  }, now);
  return sessions;
}

test("two generations without first durable progress exhaust the stop-loss", () => {
  const first = taskSessions();
  const session = first.sessions.agent;
  const sessions = {
    ...first,
    history: [{ ...session, status: "broken", updatedAt: later.toISOString() }],
    sessions: {
      agent: {
        ...session,
        nativeSessionId: "session-2",
        launchId: "launch-2",
        createdAt: later.toISOString(),
        updatedAt: later.toISOString()
      }
    },
    updatedAt: later.toISOString()
  };
  const exhausted = projectFirstProgressStopLoss({
    sessions,
    events: [],
    workItems: [],
    reviewRounds: [],
    integrations: []
  });
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.generationsBeforeFirstProgress, 2);
  assert.deepEqual(boundProviderRetryBeforeFirstProgress({
    delaysMs: [2_000, 5_000, 15_000],
    maxWindowMs: 600_000
  }, exhausted), {
    delaysMs: [2_000],
    maxWindowMs: 600_000
  });
  const progressed = projectFirstProgressStopLoss({
    sessions,
    events: [{
      id: "event-1",
      createdAt: later.toISOString(),
      payload: { leaderRunId: "agent-run-1" }
    }],
    workItems: [],
    reviewRounds: [],
    integrations: []
  });
  assert.equal(progressed.exhausted, false);
  assert.equal(progressed.firstProgressAt, later.toISOString());
  assert.deepEqual(boundProviderRetryBeforeFirstProgress({
    delaysMs: [2_000, 5_000, 15_000],
    maxWindowMs: 600_000
  }, progressed), {
    delaysMs: [2_000, 5_000, 15_000],
    maxWindowMs: 600_000
  });
});

test("the first-progress stop-loss records one durable Operator handoff", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-first-progress-stop-loss-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  store.saveConfiguredAgent(createConfiguredAgent(
    "agent", "codex", "codex", [], [], now
  ));
  const task = activateTask(createTask("task-1", "stop retry churn", now), now);
  store.saveTask(task);
  store.saveRole(task.id, createRole(
    task.id,
    "leader",
    [createRoleAgentBinding({ id: "agent", adapterId: "codex" })],
    "agent",
    "/tmp/yui-orchestration",
    now
  ));
  let sessions = taskSessions();
  sessions = updateRoleAgentSessionStatus(sessions, "agent", "broken", later);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "agent",
    adapterId: "codex",
    nativeSessionId: "session-2",
    launchId: "launch-2",
    status: "running",
    policy: "fixed",
    effective
  }, later);
  store.saveTaskRoleSessionSet(sessions);
  const projection = projectFirstProgressStopLoss({
    sessions,
    events: [],
    workItems: [],
    reviewRounds: [],
    integrations: []
  });
  const adapter = new FileSchedulerStoreAdapter(store);
  assert.equal(adapter.saveLeaderFirstProgressStopLoss({
    taskId: task.id,
    roleName: "leader",
    expectedFingerprint: projection.fingerprint,
    now: later
  }), "recorded");
  assert.equal(store.getRole(task.id, "leader").status, "failed");
  assert.match(store.getLeaderFailure(task.id).message, /first-progress stop-loss/u);
  assert.match(store.getOperatorNotification(task.id).message, /first-progress stop-loss/u);
  const mailbox = store.getWorkMailbox({ kind: "operator" });
  assert.equal(mailbox.pending.normal.requestCount, 1);
  assert.deepEqual(mailbox.pending.normal.reasons, ["leader-first-progress-stop-loss"]);
  assert.equal(adapter.saveLeaderFirstProgressStopLoss({
    taskId: task.id,
    roleName: "leader",
    expectedFingerprint: projection.fingerprint,
    now: later
  }), "state-changed");
  assert.equal(store.getWorkMailbox({ kind: "operator" }).pending.normal.requestCount, 1);
});
