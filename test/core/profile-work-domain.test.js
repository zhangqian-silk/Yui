import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_PROFILE_IDS,
  builtinAgentProfileInputs,
  createAgentProfile,
  updateAgentProfile
} from "../../dist/profile/agentProfile.js";
import {
  createWorkItem,
  updateWorkItemWriteProjects
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

test("the built-in reviewer delegates evidence-backed judgment without engineering edge cases", () => {
  const reviewer = builtinAgentProfileInputs().find(({ id }) => id === "reviewer");

  assert.match(reviewer.description, /user's core outcome.*direct evidence/i);
  assert.match(reviewer.instructions, /reachable, material, actionable problems/i);
  assert.match(reviewer.instructions, /smallest sufficient correction/i);
  assert.match(reviewer.instructions, /speculative or extreme edge cases/i);
  assert.match(reviewer.instructions, /Leader, who decides/i);
  assert.equal(reviewer.defaultAccess, "read");
});

test("AgentProfile is versioned independently from Actor and has no workspace or session", () => {
  const profile = createAgentProfile({
    id: "implementer",
    description: "Implement one bounded change.",
    skills: ["yui-worker"],
    defaultAccess: "write"
  }, now);
  assert.equal(profile.revision, 1);
  assert.equal(profile.schemaVersion, 2);
  assert.equal("agentId" in profile, false);
  assert.equal("workspace" in profile, false);
  assert.equal("session" in profile, false);

  const updated = updateAgentProfile(profile, {
    description: "Implement and validate one bounded change."
  }, new Date("2026-07-26T00:01:00.000Z"));
  assert.equal(updated.revision, 2);
  assert.equal(profile.description, "Implement one bounded change.");
});

test("WorkItem contains intent without provider-specific execution fields", () => {
  const work = createWorkItem("work-item-1", "task-1", {
    title: "Split Profile from Actor",
    objective: "Make execution configuration reusable.",
    acceptance: ["The WorkItem has no runtime fields."],
    dependsOn: []
  }, now);
  assert.deepEqual(Object.keys(work).sort(), [
    "acceptance",
    "candidates",
    "createdAt",
    "dependsOn",
    "id",
    "objective",
    "revision",
    "schemaVersion",
    "status",
    "taskId",
    "title",
    "updatedAt",
    "writeProjectIds"
  ]);

  assert.equal("agentId" in work, false);
  assert.equal("providerRef" in work, false);
});

test("WorkItem write scope is monotonic and idempotent", () => {
  const work = createWorkItem("work-item-1", "task-1", {
    title: "Update backend",
    writeProjectIds: ["project-backend"]
  }, now);
  const later = new Date("2026-07-26T00:01:00.000Z");

  const unchanged = updateWorkItemWriteProjects(
    work,
    ["project-backend"],
    later
  );
  assert.equal(unchanged, work);

  const expanded = updateWorkItemWriteProjects(
    work,
    ["project-backend", "project-frontend"],
    later
  );
  assert.deepEqual(expanded.writeProjectIds, [
    "project-backend",
    "project-frontend"
  ]);
  assert.equal(expanded.revision, work.revision + 1);

  assert.throws(
    () => updateWorkItemWriteProjects(
      expanded,
      ["project-frontend"],
      later
    ),
    /cannot remove.*project-backend/i
  );
});

test("a later conflict replaces the consumed Leader decision without adding another state", () => {
  const integration = createIntegrationAttempt({
    id: "integration-1",
    taskId: "task-1",
    projectId: "project-1",
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
