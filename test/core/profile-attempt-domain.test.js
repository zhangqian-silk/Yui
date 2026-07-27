import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_PROFILE_IDS,
  createAgentProfile,
  updateAgentProfile
} from "../../dist/profile/agentProfile.js";
import {
  attachExecutionProviderRef,
  completeExecutionAttempt,
  createExecutionAttempt
} from "../../dist/execution/executionAttempt.js";
import {
  createWorkItem
} from "../../dist/workItem/workItem.js";
import {
  createIntegrationAttempt,
  recordResolutionDecision,
  requireLeaderDecision
} from "../../dist/integration/integrationAttempt.js";

const now = new Date("2026-07-26T00:00:00.000Z");

test("built-in Agent Profiles are the complete stable product set", () => {
  assert.deepEqual(BUILTIN_PROFILE_IDS, [
    "worker",
    "explorer",
    "implementer",
    "reviewer"
  ]);
});

test("AgentProfile is versioned independently from Actor and has no workspace or session", () => {
  const profile = createAgentProfile({
    id: "implementer",
    agentId: "codex",
    description: "Implement one bounded change.",
    skills: ["yui-worker"],
    defaultAccess: "write"
  }, now);
  assert.equal(profile.revision, 1);
  assert.equal("workspace" in profile, false);
  assert.equal("session" in profile, false);

  const updated = updateAgentProfile(profile, {
    description: "Implement and validate one bounded change."
  }, new Date("2026-07-26T00:01:00.000Z"));
  assert.equal(updated.revision, 2);
  assert.equal(profile.description, "Implement one bounded change.");
});

test("WorkItem contains only intent while Attempt owns execution and result", () => {
  const work = createWorkItem("work-item-1", "task-1", {
    title: "Split Profile from Actor",
    objective: "Make execution configuration reusable.",
    acceptance: ["The WorkItem has no runtime fields."],
    dependsOn: []
  }, now);
  assert.deepEqual(Object.keys(work).sort(), [
    "acceptance",
    "createdAt",
    "dependsOn",
    "id",
    "objective",
    "revision",
    "schemaVersion",
    "status",
    "taskId",
    "title",
    "updatedAt"
  ]);

  const attempt = createExecutionAttempt({
    id: "attempt-1",
    taskId: "task-1",
    workItemId: work.id,
    profileId: "implementer",
    profileRevision: 2,
    executor: "fork",
    access: "write",
    input: "Implement the WorkItem."
  }, now);
  const running = attachExecutionProviderRef(attempt, {
    sessionId: "session-1",
    threadId: "thread-2",
    turnId: "turn-1"
  }, new Date("2026-07-26T00:01:00.000Z"));
  const completed = completeExecutionAttempt(running, {
    summary: "Implemented.",
    checks: [{ name: "npm test", outcome: "passed" }],
    changeSetId: "change-1"
  }, new Date("2026-07-26T00:02:00.000Z"));

  assert.equal(completed.state, "succeeded");
  assert.equal(completed.result?.summary, "Implemented.");
  assert.equal(completed.providerRef?.threadId, "thread-2");
});

test("session Attempts require an auditable sessionReason", () => {
  assert.throws(
    () => createExecutionAttempt({
      id: "attempt-1",
      taskId: "task-1",
      workItemId: "work-item-1",
      profileId: "implementer",
      profileRevision: 1,
      executor: "session",
      access: "write",
      input: "Run independently."
    }, now),
    /sessionReason/u
  );
});

test("a later conflict replaces the consumed Leader decision without adding another state", () => {
  const integration = createIntegrationAttempt({
    id: "integration-1",
    taskId: "task-1",
    targetRef: "main",
    expectedHead: "a".repeat(40),
    changeSetIds: ["change-1"]
  }, now);
  const firstConflict = requireLeaderDecision(integration, {
    affectedPaths: ["first.ts"],
    summary: "First conflict."
  }, now);
  const resolved = recordResolutionDecision(firstConflict, {
    action: "manual-resolution",
    rationale: "Keep both changes."
  }, now);
  const secondConflict = requireLeaderDecision(resolved, {
    affectedPaths: ["second.ts"],
    summary: "Second conflict."
  }, now);

  assert.equal(secondConflict.status, "blocked");
  assert.deepEqual(secondConflict.conflict.affectedPaths, ["second.ts"]);
  assert.equal(secondConflict.resolution, undefined);
});
