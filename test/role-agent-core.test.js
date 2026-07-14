import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as agentDomain from "../dist/agent/agent.js";
import * as roleDomain from "../dist/role/role.js";
import * as sessionDomain from "../dist/executor/agentExecutor.js";
import * as executorRegistry from "../dist/executor/executorRegistry.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createTask } from "../dist/task/task.js";

const now = new Date("2026-07-12T00:00:00.000Z");

function definition(id, adapterId = id) {
  return {
    schemaVersion: 2,
    id,
    adapterId,
    command: id,
    baseArgs: [],
    environment: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

function binding(agentId, adapterId = agentId, config = {}) {
  return { agentId, adapterId, config: { adapterId, ...config } };
}

function fingerprint(seed) {
  const hash = (field) => createHash("sha256").update(`${seed}-${field}`).digest("hex");
  return {
    overall: hash("overall"),
    replayable: hash("replayable"),
    permission: hash("permission"),
    sessionBound: hash("session-bound")
  };
}

test("AgentDefinition stores adapter identity and process environment references without literal values", () => {
  const agent = agentDomain.createConfiguredAgent(
    "codex-local",
    "codex",
    "/opt/bin/codex",
    ["--strict-config"],
    [{ target: "OPENAI_API_KEY", source: "process", sourceName: "OPENAI_API_KEY", required: true }],
    now
  );

  assert.equal(agent.schemaVersion, 2);
  assert.equal(agent.adapterId, "codex");
  assert.deepEqual(agent.baseArgs, ["--strict-config"]);
  assert.deepEqual(agent.environment, [
    { target: "OPENAI_API_KEY", source: "process", sourceName: "OPENAI_API_KEY", required: true }
  ]);
  assert.equal("args" in agent, false);
  assert.equal("env" in agent, false);
  assert.doesNotMatch(JSON.stringify(agent), /secret-value/);
});

test("Role binds independent Agent configurations and deep-copies a GlobalRole into a TaskRole", () => {
  const globalRole = roleDomain.createGlobalRole(
    "leader",
    [
      binding("codex", "codex", { model: "gpt-5.6-sol", effort: "high" }),
      binding("claude", "claude", { model: "sonnet", effort: "medium" })
    ],
    "codex",
    "/repo",
    now,
    { responsibilities: ["coordinate"] }
  );
  const taskRole = roleDomain.copyGlobalRoleToTaskRole(globalRole, "task-1", now);

  assert.equal(globalRole.schemaVersion, 2);
  assert.equal(taskRole.activeAgentId, "codex");
  assert.equal(taskRole.taskId, "task-1");
  assert.equal(taskRole.agentBindings.claude.config.model, "sonnet");
  assert.equal(taskRole.workspace, "/repo");
  assert.notEqual(taskRole.agentBindings, globalRole.agentBindings);
  assert.notEqual(taskRole.agentBindings.codex, globalRole.agentBindings.codex);
  assert.notEqual(taskRole.agentBindings.codex.config, globalRole.agentBindings.codex.config);

  globalRole.agentBindings.codex.config.model = "changed-after-copy";
  globalRole.responsibilities.push("changed-after-copy");
  assert.equal(taskRole.agentBindings.codex.config.model, "gpt-5.6-sol");
  assert.deepEqual(taskRole.responsibilities, ["coordinate"]);
});

test("Role rejects an active Agent that is absent from its binding map", () => {
  assert.throws(
    () => roleDomain.createGlobalRole("leader", [binding("codex")], "claude", "/repo", now),
    /active agent.*bound/i
  );
});

test("RoleSessionSet keeps independent per-Agent native IDs, histories, roots, and fingerprints", () => {
  assert.equal(typeof sessionDomain.createRoleSessionSet, "function");
  assert.equal(typeof sessionDomain.recordRoleAgentSession, "function");

  let sessions = sessionDomain.createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "leader" },
    "codex",
    now
  );
  sessions = sessionDomain.recordRoleAgentSession(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "codex-1",
    status: "ready",
    policy: "fixed",
    sessionRoot: "/home/test/.codex",
    worktreeRoot: "/repo",
    configFingerprint: fingerprint("codex"),
    permissionEnvelope: { adapterId: "codex" }
  }, now);
  sessions = sessionDomain.recordRoleAgentSession(sessions, {
    agentId: "claude",
    adapterId: "claude",
    nativeSessionId: "claude-1",
    status: "ready",
    policy: "fixed",
    sessionRoot: "/home/test/.claude",
    worktreeRoot: "/repo",
    configFingerprint: fingerprint("claude"),
    permissionEnvelope: { adapterId: "claude" }
  }, now);
  sessions = sessionDomain.recordRoleAgentSession(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "codex-2",
    status: "ready",
    policy: "fixed",
    sessionRoot: "/home/test/.codex",
    worktreeRoot: "/repo",
    configFingerprint: fingerprint("codex-next"),
    permissionEnvelope: { adapterId: "codex" },
    replacementReason: "Native session was explicitly replaced."
  }, now);

  assert.equal(sessions.sessions.codex.nativeSessionId, "codex-2");
  assert.deepEqual(sessions.sessions.codex.previousIdentities, [{
    adapterId: "codex",
    sessionRoot: "/home/test/.codex",
    nativeSessionId: "codex-1"
  }]);
  assert.equal(sessions.sessions.claude.nativeSessionId, "claude-1");
  assert.equal(sessions.sessions.claude.sessionRoot, "/home/test/.claude");
  assert.equal(sessions.sessions.codex.createdConfigHash.overall, fingerprint("codex-next").overall);
  assert.equal(sessions.sessions.codex.lastLaunchConfigHash.overall, fingerprint("codex-next").overall);
});

test("FileTaskStore persists a RoleSessionSet and rejects the historical single-session schema", () => {
  const store = FileTaskStore.createEphemeralWorkspace("taskmux-role-sessions-");
  const home = store.rootDirectory();
  try {
    const set = sessionDomain.createRoleSessionSet(
      { scope: "task", taskId: "task-1", roleName: "leader" },
      "codex",
      now
    );
    store.saveTask(createTask("task-1", "Role sessions", now));
    store.saveRole("task-1", roleDomain.createRole(
      "task-1",
      "leader",
      [binding("codex")],
      "codex",
      "/repo",
      now
    ));
    store.saveRoleSessionSet(set);
    assert.deepEqual(
      JSON.parse(JSON.stringify(store.getRoleSessionSet("task-1", "leader"))),
      JSON.parse(JSON.stringify(set))
    );

    const path = join(home, "runtime", "role-sessions", "tasks", "task-1", "leader.json");
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      taskId: "task-1",
      roleName: "leader",
      agent: "codex",
      nativeSessionId: "legacy"
    }));
    assert.throws(() => store.getRoleSessionSet("task-1", "leader"), /Invalid role session set/);
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("Codex adapter discovers model-specific effort and compiles structured new/resume argv", () => {
  assert.equal(typeof executorRegistry.resolveAgentAdapter, "function");
  const adapter = executorRegistry.resolveAgentAdapter("codex");
  const snapshot = adapter.discoverCapabilities({
    agent: definition("codex"),
    version: "0.144.1",
    now,
    fixtures: {
      bundledModels: JSON.stringify({ models: [{
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }]
      }] })
    }
  });
  const effort = snapshot.fields.find((field) => field.key === "effort");
  assert.deepEqual(effort.choicesByModel["gpt-5.6-sol"].map((choice) => choice.value), ["low", "high"]);

  const config = {
    adapterId: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    permission: { sandbox: "read-only", approval: "never" },
    search: true,
    additionalDirectories: ["/tmp"]
  };
  const compiled = adapter.compileNew({
    agent: definition("codex"), config, workspace: "/repo", snapshot
  });
  assert.deepEqual(compiled.argv, [
    "--model", "gpt-5.6-sol",
    "--config", "model_reasoning_effort=\"high\"",
    "--sandbox", "read-only",
    "--ask-for-approval", "never",
    "--search",
    "--add-dir", "/tmp"
  ]);
  assert.deepEqual(
    adapter.compileResume({ agent: definition("codex"), config, workspace: "/repo", snapshot, nativeSessionId: "thread-1" }).argv,
    [...compiled.argv, "resume", "thread-1"]
  );
});

test("Claude adapter exposes version-derived choices, allows a custom model, and owns resume arguments", () => {
  const adapter = executorRegistry.resolveAgentAdapter("claude");
  const snapshot = adapter.discoverCapabilities({
    agent: definition("claude"), version: "2.1.207", now,
    fixtures: { help: "--effort <level> (low, medium, high, xhigh, max)\n--permission-mode <mode> (choices: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan)" }
  });
  const model = snapshot.fields.find((field) => field.key === "model");
  assert.equal(model.allowCustom, true);
  assert.equal(model.source, "adapter-baseline");

  const config = {
    adapterId: "claude",
    model: "my-account-model",
    effort: "xhigh",
    permission: { mode: "plan", allowedTools: ["Read", "Bash(git status)"] }
  };
  const compiled = adapter.compileResume({
    agent: definition("claude"), config, workspace: "/repo", snapshot, nativeSessionId: "session-1"
  });
  assert.deepEqual(compiled.argv, [
    "--model", "my-account-model",
    "--effort", "xhigh",
    "--permission-mode", "plan",
    "--allowed-tools", "Read", "Bash(git status)",
    "--resume", "session-1"
  ]);
});

test("Adapters reject lifecycle and structured ownership collisions in advanced rawArgs", () => {
  const codex = executorRegistry.resolveAgentAdapter("codex");
  const snapshot = codex.discoverCapabilities({
    agent: definition("codex"), version: "0.144.1", now,
    fixtures: { bundledModels: JSON.stringify({ models: [] }) }
  });
  assert.throws(() => codex.validateConfig({
    agent: definition("codex"),
    config: { adapterId: "codex", advanced: { rawArgs: ["--model=stolen", "resume", "other-session"] } },
    snapshot
  }), /reserved.*--model/i);

  for (const argument of [
    "-mstolen", "-ac", "--profile=unsafe", "--dangerously-bypass-approvals-and-sandbox"
  ]) {
    assert.throws(() => codex.validateConfig({
      agent: definition("codex"),
      config: { adapterId: "codex", advanced: { rawArgs: [argument] } },
      snapshot
    }), /reserved/i, argument);
  }

  assert.throws(() => codex.validateConfig({
    agent: { ...definition("codex"), baseArgs: ["-sworkspace-write"] },
    config: { adapterId: "codex" },
    snapshot
  }), /reserved/i);

  const claude = executorRegistry.resolveAgentAdapter("claude");
  const claudeSnapshot = claude.discoverCapabilities({
    agent: definition("claude"), version: "2.1.207", now,
    fixtures: { help: "--effort <level> (low, high)\n--permission-mode <mode> (choices: plan)" }
  });
  for (const argument of [
    "-rsession", "-cr", "--tools=Bash", "--no-session-persistence",
    "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"
  ]) {
    assert.throws(() => claude.validateConfig({
      agent: definition("claude"),
      config: { adapterId: "claude", advanced: { rawArgs: [argument] } },
      snapshot: claudeSnapshot
    }), /reserved/i, argument);
  }
});

test("Adapter installation probe refuses an unpinned configured executable", () => {
  const directory = mkdtempSync(join(tmpdir(), "taskmux-adapter-probe-"));
  try {
    const executable = join(directory, "codex-fixture");
    writeFileSync(executable, "#!/bin/sh\nprintf 'codex-cli 0.144.1\\n'\n");
    chmodSync(executable, 0o700);
    const adapter = executorRegistry.resolveAgentAdapter("codex");
    const installation = adapter.probeInstallation({ ...definition("codex"), command: executable }, now);
    assert.deepEqual(installation, {
      status: "unavailable",
      command: executable,
      reason: "Configured Agent commands are not eligible for live capability probing.",
      probedAt: now.toISOString()
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Adapters reject unavailable model-effort combinations and controlled enum values", () => {
  const codex = executorRegistry.resolveAgentAdapter("codex");
  const codexSnapshot = codex.discoverCapabilities({
    agent: definition("codex"), version: "0.144.1", now,
    fixtures: { bundledModels: JSON.stringify({ models: [{
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }]
    }] }) }
  });
  assert.throws(() => codex.validateConfig({
    agent: definition("codex"),
    config: { adapterId: "codex", model: "gpt-5.6-sol", effort: "ultra" },
    workspace: "/repo",
    snapshot: codexSnapshot
  }), /effort.*not available.*gpt-5\.6-sol/i);

  const claude = executorRegistry.resolveAgentAdapter("claude");
  const claudeSnapshot = claude.discoverCapabilities({
    agent: definition("claude"), version: "2.1.207", now,
    fixtures: { help: "--effort <level> (low, medium, high)\n--permission-mode <mode> (choices: acceptEdits, plan)" }
  });
  assert.throws(() => claude.validateConfig({
    agent: definition("claude"),
    config: { adapterId: "claude", model: "custom-is-allowed", effort: "max" },
    workspace: "/repo",
    snapshot: claudeSnapshot
  }), /effort.*not available/i);
  assert.throws(() => claude.validateConfig({
    agent: definition("claude"),
    config: { adapterId: "claude", permission: { mode: "bypassPermissions" } },
    workspace: "/repo",
    snapshot: claudeSnapshot
  }), /permission\.mode.*not available/i);
});

test("switchActiveRoleAgent preserves dormant sessions and refuses to switch active work", () => {
  assert.equal(typeof roleDomain.switchActiveRoleAgent, "function");
  const role = roleDomain.createRole(
    "task-1",
    "leader",
    [binding("codex"), binding("claude")],
    "codex",
    "/repo",
    now
  );
  const sessionSet = sessionDomain.createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "leader" },
    "codex",
    now
  );

  assert.throws(
    () => roleDomain.switchActiveRoleAgent(role, sessionSet, "claude", { activeRun: true, nativeProcessRunning: false }, now),
    /active AgentRun/i
  );

  const result = roleDomain.switchActiveRoleAgent(
    role,
    sessionSet,
    "claude",
    { activeRun: false, nativeProcessRunning: false },
    now
  );
  assert.equal(result.role.activeAgentId, "claude");
  assert.equal(result.sessions.activeAgentId, "claude");
  assert.equal(result.mode, "new");
  assert.deepEqual(role.agentBindings.codex, result.role.agentBindings.codex);
  assert.equal(result.event.type, "role.agent_switched");
  assert.deepEqual(result.event.payload, { fromAgentId: "codex", toAgentId: "claude", mode: "new" });
});
