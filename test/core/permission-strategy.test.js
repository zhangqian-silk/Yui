import assert from "node:assert/strict";
import test from "node:test";

import { createConfiguredAgent, configuredAgentToDefinition } from "../../dist/agent/agent.js";
import { resolveAgentAdapter } from "../../dist/executor/agentAdapter.js";
import {
  effectiveLaunchConfig,
  resolveEffectiveLaunch
} from "../../dist/executor/effectiveLaunch.js";
import {
  createGlobalRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";

const NOW = new Date("2026-08-03T12:00:00.000Z");

test("new Role bindings default to one explicit bypass permission strategy", () => {
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  const binding = createRoleAgentBinding(agent);

  assert.deepEqual(binding.config, {
    adapterId: "codex",
    permission: { strategy: "bypass" }
  });
  assert.deepEqual(createRoleAgentBinding(agent, {
    adapterId: "codex",
    model: "gpt-custom"
  }).config, {
    adapterId: "codex",
    model: "gpt-custom",
    permission: { strategy: "bypass" }
  });
});

test("current Role storage rejects a binding without an explicit permission strategy", () => {
  assert.throws(() => createGlobalRole(
    "worker",
    [{
      agentId: "codex",
      adapterId: "codex",
      config: { adapterId: "codex" }
    }],
    "codex",
    "/fixture",
    NOW
  ), /explicit permission strategy/i);

  assert.throws(() => resolveAgentAdapter("codex").canonicalizeConfig({
    adapterId: "codex"
  }), /permission strategy is required/i);
  assert.throws(() => resolveAgentAdapter("claude").canonicalizeConfig({
    adapterId: "claude"
  }), /permission strategy is required/i);
});

test("configured permission forwards any non-empty subset of provider-native options", () => {
  const codex = resolveAgentAdapter("codex").canonicalizeConfig({
    adapterId: "codex",
    permission: { strategy: "configured", sandbox: "read-only" }
  });
  assert.deepEqual(codex.permission, {
    strategy: "configured",
    sandbox: "read-only"
  });

  const claude = resolveAgentAdapter("claude").canonicalizeConfig({
    adapterId: "claude",
    permission: {
      strategy: "configured",
      allowedTools: ["Bash(API_KEY=$API_KEY command)"]
    }
  });
  assert.deepEqual(claude.permission, {
    strategy: "configured",
    allowedTools: ["Bash(API_KEY=$API_KEY command)"]
  });

  assert.throws(() => resolveAgentAdapter("claude").canonicalizeConfig({
    adapterId: "claude",
    permission: { strategy: "configured" }
  }), /at least one provider-native option/i);
  assert.throws(() => resolveAgentAdapter("claude").canonicalizeConfig({
    adapterId: "claude",
    permission: { strategy: "configured", allowedTools: [] }
  }), /tool lists must not be empty/i);
});

test("read access does not downgrade a configured provider bypass", () => {
  const role = desiredRole("codex", {
    adapterId: "codex",
    permission: { strategy: "bypass" }
  }, "read");
  const effective = resolveEffectiveLaunch({
    role,
    purpose: "execution",
    workspace: workspace("read")
  });

  assert.equal(effective.profileAccess, "read");
  assert.deepEqual(effective.permission, { strategy: "bypass" });
  assert.ok(compileArgv(role, effective).includes(
    "--dangerously-bypass-approvals-and-sandbox"
  ));
});

test("configured provider enums remain independent from write access", () => {
  const codexRole = desiredRole("codex", {
    adapterId: "codex",
    permission: {
      strategy: "configured",
      sandbox: "read-only",
      approval: "never"
    }
  });
  const codexEffective = resolveEffectiveLaunch({
    role: codexRole,
    purpose: "execution",
    workspace: workspace("write"),
    workItemWriteProjectIds: ["project-1"]
  });
  assert.equal(codexEffective.profileAccess, "write");
  assert.deepEqual(compileArgv(codexRole, codexEffective).slice(2), [
    "--sandbox", "read-only", "--ask-for-approval", "never",
    "--config", 'projects={"/fixture/work-item-1"={trust_level="trusted"}}'
  ]);

  const claudeRole = desiredRole("claude", {
    adapterId: "claude",
    permission: {
      strategy: "configured",
      mode: "plan",
      allowedTools: ["Read", "Grep"],
      disallowedTools: ["Edit"]
    }
  });
  const claudeEffective = resolveEffectiveLaunch({
    role: claudeRole,
    purpose: "execution",
    workspace: workspace("write"),
    workItemWriteProjectIds: ["project-1"]
  });
  assert.equal(claudeEffective.profileAccess, "write");
  assert.deepEqual(compileArgv(claudeRole, claudeEffective), [
    "--permission-mode", "plan",
    "--allowed-tools", "Read", "Grep",
    "--disallowed-tools", "Edit"
  ]);
});

function desiredRole(adapterId, config, defaultAccess = "write") {
  const agent = createConfiguredAgent(adapterId, adapterId, adapterId, [], [], NOW);
  const binding = createRoleAgentBinding(agent, config);
  return {
    schemaVersion: 3,
    taskId: "task-1",
    name: "worker",
    activeAgentId: agent.id,
    agentBindings: { [agent.id]: binding },
    workspace: "/fixture/work-item-1",
    defaultAccess,
    launchRevision: 1,
    status: "idle",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
}

function workspace(access) {
  return {
    schemaVersion: 3,
    taskId: "task-1",
    roleName: "worker",
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
    workspace: effective.workspace.root,
    ...(effective.adapterId === "codex"
      ? { codexDeveloperInstructions: { status: "absent" } }
      : {})
  }).argv;
}
