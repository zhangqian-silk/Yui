import assert from "node:assert/strict";
import test from "node:test";

import { createAgentRun, failAgentRun } from "../../dist/run/agentRun.js";
import { projectNextAction } from "../../dist/task/nextAction.js";

const now = new Date("2026-08-27T00:00:00.000Z");
const binding = { projectId: "project-1", directory: "app", baseRef: "main" };
const effective = {
  schemaVersion: 2,
  sourceDesiredRevision: 1,
  agentId: "agent",
  adapterId: "codex",
  profileAccess: "write",
  search: false,
  permission: { strategy: "default" },
  writeProjectIds: [],
  workspace: { root: "/tmp/yui-resume-test", entries: [] },
  context: {}
};

function facts(overrides = {}) {
  return {
    task: { id: "task-1", status: "active", projectBindings: [binding], type: "bugfix" },
    workItems: [],
    changeSets: [],
    integrations: [],
    integrationQueueEntries: [],
    reviewRounds: [],
    taskFinalReviewContractEvents: [],
    reviewConfig: { roleName: "reviewer", trigger: "final" },
    openInputRequests: [],
    activeRuns: [],
    leaderRuns: [],
    ...overrides
  };
}

function failedResumeRun(id) {
  return failAgentRun(
    createAgentRun(id, "task-1", "leader", "resume", "resume delivery", now, { effective }),
    "resume failed before acceptance",
    now
  );
}

function deliveredNewRun(id) {
  return {
    ...createAgentRun(id, "task-1", "leader", "new", "fresh delivery", now, { effective }),
    deliveredAt: now.toISOString()
  };
}

test("failed resume run recommends replace-leader-session with role reset + jobs retry", () => {
  const action = projectNextAction(facts({ leaderRuns: [failedResumeRun("agent-run-1")] }));
  assert.equal(action.kind, "replace-leader-session");
  // The failed resume Run is already terminal, so `task run recover
  // --action replace-session` (which requires an active Run) cannot act on
  // it.  The working recovery is role reset + jobs retry.
  assert.match(action.recommendedCommand, /yui task role reset task-1 leader/);
  assert.match(action.recommendedCommand, /yui jobs retry leader-recovery:task-1/);
  assert.doesNotMatch(action.recommendedCommand, /task run recover/);
});

test("replace-leader-session is not recommended when a newer run follows the failed resume", () => {
  const action = projectNextAction(facts({
    leaderRuns: [failedResumeRun("agent-run-1"), deliveredNewRun("agent-run-2")]
  }));
  assert.notEqual(action.kind, "replace-leader-session");
});

test("replace-leader-session is not recommended when the latest run is a failed new-session run", () => {
  const failedNew = failAgentRun(
    createAgentRun("agent-run-2", "task-1", "leader", "new", "fresh delivery", now, { effective }),
    "new session launch failed",
    now
  );
  const action = projectNextAction(facts({
    leaderRuns: [failedResumeRun("agent-run-1"), failedNew]
  }));
  assert.notEqual(action.kind, "replace-leader-session");
});
