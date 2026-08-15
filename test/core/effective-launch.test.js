import assert from "node:assert/strict";
import test from "node:test";

import { createConfiguredAgent, configuredAgentToDefinition } from "../../dist/agent/agent.js";
import { resolveAgentAdapter } from "../../dist/executor/agentAdapter.js";
import {
  effectiveLaunchConfig,
  effectiveLaunchSnapshotsCompatible,
  effectiveLaunchSnapshotsCompatibleForTaskMain,
  resolveEffectiveLaunch
} from "../../dist/executor/effectiveLaunch.js";
import { createRoleAgentBinding } from "../../dist/role/role.js";

const NOW = new Date("2026-08-02T13:30:00.000Z");

test("Profile access is behavior intent and does not erase an exact WorkItem write scope", () => {
  const role = desiredRole("codex", {
    adapterId: "codex",
    model: "gpt-5.6-sol",
    effort: "max",
    search: true,
    permission: { strategy: "bypass" }
  }, "read");
  const effective = resolveEffectiveLaunch({
    role,
    purpose: "execution",
    workspace: workspace("write"),
    workItemWriteProjectIds: ["project-1"]
  });

  assert.equal(effective.schemaVersion, 2);
  assert.equal(effective.profileAccess, "read");
  assert.deepEqual(effective.writeProjectIds, ["project-1"]);
  assert.deepEqual(effective.permission, { strategy: "bypass" });
  assert.equal(effective.search, true);
  const argv = compileArgv(role, effective);
  assert.equal(argv.includes("--dangerously-bypass-approvals-and-sandbox"), true);
  assert.equal(argv.includes("--search"), true);
});

test("explicit Codex native permission options remain independent from write scope", () => {
  const role = desiredRole("codex", {
    adapterId: "codex",
    permission: {
      strategy: "configured",
      sandbox: "read-only",
      approval: "never"
    }
  });
  const effective = resolveEffectiveLaunch({
    role,
    purpose: "execution",
    workspace: workspace("write"),
    workItemWriteProjectIds: ["project-1"]
  });

  assert.equal(effective.profileAccess, "write");
  assert.deepEqual(effective.writeProjectIds, ["project-1"]);
  assert.deepEqual(effective.permission, {
    strategy: "configured",
    sandbox: "read-only",
    approval: "never"
  });
  assert.deepEqual(compileArgv(role, effective).slice(2), [
    "--sandbox", "read-only", "--ask-for-approval", "never",
    "--config", 'projects={"/fixture/work-item-1"={trust_level="trusted"}}'
  ]);
});

test("explicit Claude native permission options remain independent from read scope", () => {
  const role = desiredRole("claude", {
    adapterId: "claude",
    permission: {
      strategy: "configured",
      mode: "plan",
      allowedTools: ["Read"],
      disallowedTools: ["Edit"]
    }
  }, "read");
  const effective = resolveEffectiveLaunch({
    role,
    purpose: "execution",
    workspace: workspace("read")
  });

  assert.equal(effective.profileAccess, "read");
  assert.deepEqual(effective.permission, {
    strategy: "configured",
    mode: "plan",
    allowedTools: ["Read"],
    disallowedTools: ["Edit"]
  });
  assert.deepEqual(compileArgv(role, effective), [
    "--permission-mode", "plan",
    "--allowed-tools", "Read",
    "--disallowed-tools", "Edit"
  ]);
});

test("Review uses its configured permission in the exact writable ReviewRound workspace", () => {
  const role = desiredRole("claude", {
    adapterId: "claude",
    permission: { strategy: "bypass" }
  });
  const effective = resolveEffectiveLaunch({
    role,
    purpose: "review",
    reviewRoundId: "review-round-1",
    reviewBaseCommit: "b".repeat(40),
    workspace: reviewWorkspace("review-round-1")
  });

  assert.equal(effective.profileAccess, "write");
  assert.deepEqual(effective.writeProjectIds, ["project-1"]);
  assert.deepEqual(effective.permission, { strategy: "bypass" });
  assert.equal(effective.reviewRoundId, "review-round-1");
  assert.equal(effective.reviewBaseCommit, "b".repeat(40));
  assert.equal(compileArgv(role, effective).includes("--dangerously-skip-permissions"), true);
});

test("Review purpose fails closed on workspace owner or ReviewRound mismatch", () => {
  const role = desiredRole("claude", {
    adapterId: "claude",
    permission: { strategy: "bypass" }
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

test("Session compatibility compares the complete effective config except desired revision", () => {
  const role = desiredRole("codex", {
    adapterId: "codex",
    permission: { strategy: "bypass" }
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
    permission: { strategy: "default" }
  }), false);
  assert.equal(effectiveLaunchSnapshotsCompatible(first, {
    ...laterRevision,
    profileAccess: "read"
  }), false);
});

test("Task-main Session compatibility permits only durable base-commit advancement", () => {
  const role = desiredRole("codex", {
    adapterId: "codex",
    model: "gpt-5.6-sol",
    permission: { strategy: "bypass" }
  });
  const beforeWorkspace = taskMainWorkspace("a".repeat(40));
  const afterWorkspace = taskMainWorkspace("b".repeat(40));
  const existing = resolveEffectiveLaunch({
    role,
    purpose: "execution",
    workspace: beforeWorkspace
  });
  const desired = resolveEffectiveLaunch({
    role,
    purpose: "execution",
    workspace: afterWorkspace
  });

  assert.equal(
    effectiveLaunchSnapshotsCompatibleForTaskMain(
      existing,
      desired,
      afterWorkspace
    ),
    true
  );
  for (const changedWorkspace of [
    taskMainWorkspace("b".repeat(40), { path: "/fixture/other/Yui" }),
    taskMainWorkspace("b".repeat(40), { branch: "other-main" }),
    taskMainWorkspace("b".repeat(40), { access: "read" })
  ]) {
    const changed = resolveEffectiveLaunch({
      role,
      purpose: "execution",
      workspace: changedWorkspace
    });
    assert.equal(
      effectiveLaunchSnapshotsCompatibleForTaskMain(
        existing,
        changed,
        changedWorkspace
      ),
      false
    );
  }
  const changedConfig = resolveEffectiveLaunch({
    role: desiredRole("codex", {
      adapterId: "codex",
      model: "gpt-next",
      permission: { strategy: "bypass" }
    }),
    purpose: "execution",
    workspace: afterWorkspace
  });
  assert.equal(
    effectiveLaunchSnapshotsCompatibleForTaskMain(
      existing,
      changedConfig,
      afterWorkspace
    ),
    false
  );

  const beforeWorkItem = workItemWorkspace("a".repeat(40));
  const afterWorkItem = workItemWorkspace("b".repeat(40));
  assert.equal(
    effectiveLaunchSnapshotsCompatibleForTaskMain(
      resolveEffectiveLaunch({
        role,
        purpose: "execution",
        workspace: beforeWorkItem,
        workItemWriteProjectIds: ["project-1"]
      }),
      resolveEffectiveLaunch({
        role,
        purpose: "execution",
        workspace: afterWorkItem,
        workItemWriteProjectIds: ["project-1"]
      }),
      afterWorkItem
    ),
    false
  );
});

function desiredRole(adapterId, config, defaultAccess = "write") {
  const agent = createConfiguredAgent(adapterId, adapterId, adapterId, [], [], NOW);
  const binding = createRoleAgentBinding(agent, config);
  return {
    schemaVersion: 3,
    taskId: "task-1",
    name: "implementer",
    activeAgentId: agent.id,
    agentBindings: { [agent.id]: binding },
    workspace: "/fixture/work-item-1",
    defaultAccess,
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

function taskMainWorkspace(baseCommit, entryOverrides = {}) {
  return {
    schemaVersion: 2,
    owner: { type: "task", taskId: "task-1" },
    root: "/fixture/task-main",
    entries: [{
      projectId: "project-1",
      directory: "Yui",
      access: "write",
      path: "/fixture/task-main/Yui",
      branch: "main",
      baseRef: "main",
      baseCommit,
      ...entryOverrides
    }],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
}

function workItemWorkspace(baseCommit) {
  return {
    ...taskMainWorkspace(baseCommit),
    owner: {
      type: "work-item",
      taskId: "task-1",
      workItemId: "work-item-1"
    },
    root: "/fixture/work-item-1",
    entries: taskMainWorkspace(baseCommit).entries.map((entry) => ({
      ...entry,
      path: "/fixture/work-item-1/Yui",
      branch: "work-item-1"
    }))
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
    workspace: effective.workspace.root,
    ...(effective.adapterId === "codex"
      ? { codexDeveloperInstructions: { status: "absent" } }
      : {})
  }).argv;
}
