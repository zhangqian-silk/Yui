import assert from "node:assert/strict";
import test from "node:test";

import { createConfiguredAgent, configuredAgentToDefinition } from "../../dist/agent/agent.js";
import { resolveAgentAdapter } from "../../dist/executor/agentAdapter.js";
import {
  assertReadOnlyAgentArgv,
  effectiveLaunchConfig,
  effectiveLaunchSnapshotsCompatible,
  resolveEffectiveLaunch
} from "../../dist/executor/effectiveLaunch.js";
import { createRoleAgentBinding } from "../../dist/role/role.js";

const NOW = new Date("2026-08-02T13:30:00.000Z");

test("Task execution without an explicit WorkItem write scope is native read-only", () => {
  const role = desiredRole("codex", {
    adapterId: "codex",
    model: "gpt-5.6-sol",
    effort: "max",
    yolo: true,
    search: true,
    permission: { sandbox: "danger-full-access", approval: "never" }
  });
  const effective = resolveEffectiveLaunch({
    role,
    purpose: "execution",
    workspace: workspace("write"),
    workItemWriteProjectIds: []
  });

  assert.equal(effective.access, "read");
  assert.equal(effective.yolo, false);
  assert.equal(effective.search, false);
  assert.deepEqual(effective.writeProjectIds, []);
  assert.deepEqual(effective.permission, {
    sandbox: "read-only",
    approval: "never"
  });
  const argv = compileArgv(role, effective);
  assertReadOnlyAgentArgv(effective, argv);
  assert.deepEqual(argv.slice(2, 6), [
    "--model", "gpt-5.6-sol", "--config", "model_reasoning_effort=\"max\""
  ]);
  assert.ok(argv.includes("read-only"));
  assert.ok(argv.includes("never"));
  assert.equal(argv.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.equal(argv.includes("--search"), false);
});

test("a writable workspace alone never grants a non-WorkItem Task Run write access", () => {
  const role = desiredRole("codex", {
    adapterId: "codex",
    yolo: true,
    permission: { sandbox: "danger-full-access", approval: "never" }
  });
  const effective = resolveEffectiveLaunch({
    role,
    purpose: "execution",
    workspace: workspace("write")
  });

  assert.equal(effective.access, "read");
  assert.deepEqual(effective.writeProjectIds, []);
  assert.equal(effective.yolo, false);
  assertReadOnlyAgentArgv(effective, compileArgv(role, effective));
});

test("write Profile plus exact WorkItem and workspace scope preserves configured Codex YOLO", () => {
  const role = desiredRole("codex", {
    adapterId: "codex",
    model: "gpt-5.6-sol",
    yolo: true,
    search: true
  });
  const effective = resolveEffectiveLaunch({
    role,
    purpose: "execution",
    workspace: workspace("write"),
    workItemWriteProjectIds: ["project-1"]
  });

  assert.equal(effective.access, "write");
  assert.equal(effective.yolo, true);
  assert.equal(effective.search, true);
  assert.deepEqual(effective.writeProjectIds, ["project-1"]);
  const argv = compileArgv(role, effective);
  assert.ok(argv.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(argv.includes("--search"));
});

test("Review purpose retains Claude bypass only in its exact ReviewRound workspace", () => {
  const role = desiredRole("claude", {
    adapterId: "claude",
    model: "opus",
    effort: "max",
    yolo: true,
    permission: { mode: "bypassPermissions" }
  });
  const effective = resolveEffectiveLaunch({
    role,
    purpose: "review",
    reviewRoundId: "review-round-1",
    reviewBaseCommit: "b".repeat(40),
    workspace: reviewWorkspace("review-round-1")
  });

  assert.equal(effective.access, "write");
  assert.equal(effective.yolo, true);
  assert.equal(effective.permission, undefined);
  assert.equal(effective.reviewRoundId, "review-round-1");
  assert.equal(effective.reviewBaseCommit, "b".repeat(40));
  const argv = compileArgv(role, effective);
  assert.equal(argv.includes("--dangerously-skip-permissions"), true);
});

test("Review purpose retains Codex YOLO in its exact ReviewRound workspace", () => {
  const role = desiredRole("codex", {
    adapterId: "codex",
    yolo: true,
    search: true,
    permission: { sandbox: "danger-full-access", approval: "never" }
  });
  const effective = resolveEffectiveLaunch({
    role,
    purpose: "review",
    reviewRoundId: "review-round-1",
    reviewBaseCommit: "b".repeat(40),
    workspace: reviewWorkspace("review-round-1")
  });

  assert.equal(effective.access, "write");
  assert.equal(effective.yolo, true);
  assert.equal(effective.search, true);
  assert.deepEqual(effective.writeProjectIds, ["project-1"]);
  assert.ok(compileArgv(role, effective).includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("Review purpose fails closed on workspace owner or ReviewRound mismatch", () => {
  const role = desiredRole("claude", {
    adapterId: "claude",
    yolo: true,
    permission: { mode: "bypassPermissions" }
  });
  assert.throws(
    () => resolveEffectiveLaunch({
      role,
      purpose: "review",
      reviewRoundId: "review-round-2",
      reviewBaseCommit: "b".repeat(40),
      workspace: reviewWorkspace("review-round-1")
    }),
    /ReviewRound workspace owner.*review-round-2/i
  );
  assert.throws(
    () => resolveEffectiveLaunch({
      role,
      purpose: "review",
      reviewRoundId: "review-round-1",
      reviewBaseCommit: "b".repeat(40),
      workspace: workspace("write")
    }),
    /ReviewRound-owned workspace/i
  );
});

test("Session compatibility compares complete effective config and workspace, not provenance revision alone", () => {
  const role = desiredRole("codex", {
    adapterId: "codex",
    permission: { sandbox: "workspace-write", approval: "never" }
  });
  const first = resolveEffectiveLaunch({
    role,
    purpose: "execution",
    workspace: workspace("write"),
    workItemWriteProjectIds: ["project-1"]
  });
  const laterRevision = { ...first, sourceDesiredRevision: first.sourceDesiredRevision + 1 };
  assert.equal(effectiveLaunchSnapshotsCompatible(first, laterRevision), true);
  assert.equal(effectiveLaunchSnapshotsCompatible(first, {
    ...laterRevision,
    workspace: { ...laterRevision.workspace, root: "/fixture/other" }
  }), false);
  assert.equal(effectiveLaunchSnapshotsCompatible(first, {
    ...laterRevision,
    access: "read",
    writeProjectIds: [],
    permission: { sandbox: "read-only", approval: "never" }
  }), false);
});

function desiredRole(adapterId, config) {
  const agent = createConfiguredAgent(adapterId, adapterId, adapterId, [], [], NOW);
  const binding = createRoleAgentBinding(agent, config);
  return {
    schemaVersion: 3,
    taskId: "task-1",
    name: "implementer",
    activeAgentId: agent.id,
    agentBindings: { [agent.id]: binding },
    workspace: "/fixture/work-item-1",
    defaultAccess: "write",
    launchRevision: 7,
    status: "idle",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
}

function workspace(access) {
  return {
    schemaVersion: 3,
    taskId: "task-1",
    roleName: "implementer",
    owner: { type: "work-item", workItemId: "work-item-1" },
    root: "/fixture/work-item-1",
    entries: [{
      projectId: "project-1",
      directory: "fixture",
      access,
      path: "/fixture/work-item-1/fixture",
      branch: "fixture-work",
      baseRef: "main",
      baseCommit: "a".repeat(40)
    }],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
}

function reviewWorkspace(reviewRoundId) {
  return {
    ...workspace("write"),
    roleName: "reviewer",
    owner: { type: "review-round", reviewRoundId },
    root: `/fixture/reviews/${reviewRoundId}`,
    entries: workspace("write").entries.map((entry) => ({
      ...entry,
      path: `/fixture/reviews/${reviewRoundId}/fixture`,
      branch: `fixture-${reviewRoundId}`,
      baseRef: "b".repeat(40),
      baseCommit: "b".repeat(40)
    }))
  };
}

function compileArgv(role, effective) {
  const binding = role.agentBindings[effective.agentId];
  const agent = createConfiguredAgent(
    effective.agentId,
    effective.adapterId,
    effective.adapterId,
    [],
    [],
    NOW
  );
  return resolveAgentAdapter(effective.adapterId).compileNew({
    agent: configuredAgentToDefinition(agent),
    config: effectiveLaunchConfig(effective),
    workspace: effective.workspace.root
  }).argv;
}
