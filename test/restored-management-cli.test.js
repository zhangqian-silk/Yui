import assert from "node:assert/strict";
import test from "node:test";

import { listPublicCommandPaths } from "../dist/cli/commandCatalog.js";
import { runUpdateCommand } from "../dist/cli/updateCommand.js";
import { runAgentCommand } from "../dist/commands/agentCommands.js";
import { runGlobalRoleCommand } from "../dist/commands/globalRoleCommands.js";

function agentStore(seed = []) {
  const records = new Map(seed.map((agent) => [agent.id, structuredClone(agent)]));
  return {
    records,
    createConfiguredAgentIfAbsent(agent) {
      if (records.has(agent.id)) return null;
      records.set(agent.id, structuredClone(agent));
      return structuredClone(agent);
    },
    updateConfiguredAgent(id, patch, now) {
      const existing = records.get(id);
      if (existing === undefined) return null;
      const agent = { ...existing, ...structuredClone(patch), updatedAt: now.toISOString() };
      const unchanged = JSON.stringify({ ...existing, updatedAt: "" })
        === JSON.stringify({ ...agent, updatedAt: "" });
      records.set(id, agent);
      return { status: unchanged ? "unchanged" : "updated", agent };
    },
    listConfiguredAgents: () => [...records.values()].map(structuredClone),
    getConfiguredAgent: (id) => records.has(id) ? structuredClone(records.get(id)) : null,
    removeConfiguredAgent: (id) => records.delete(id)
  };
}

function roleStore() {
  const codex = {
    schemaVersion: 2, id: "codex", adapterId: "codex", command: "codex",
    baseArgs: [], environment: [], createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const claude = { ...codex, id: "claude", adapterId: "claude", command: "claude" };
  const base = agentStore([codex, claude]);
  const roles = new Map();
  const sessions = new Map();
  return {
    ...base,
    roles,
    sessions,
    getConfig: () => ({ defaultWorkspace: "/workspace" }),
    createGlobalRoleIfAbsent(role) {
      if (roles.has(role.name)) return null;
      roles.set(role.name, structuredClone(role));
      return structuredClone(role);
    },
    listGlobalRoles: () => [...roles.values()].map(structuredClone),
    getGlobalRole: (name) => roles.has(name) ? structuredClone(roles.get(name)) : null,
    saveGlobalRole: (role) => { roles.set(role.name, structuredClone(role)); },
    saveGlobalRoleWithSessionSet(role, set) {
      roles.set(role.name, structuredClone(role));
      if (set !== null) sessions.set(role.name, structuredClone(set));
    },
    removeGlobalRole: (name) => roles.delete(name),
    getGlobalRoleSessionSet: (name) => sessions.has(name) ? structuredClone(sessions.get(name)) : null,
    saveGlobalRoleSessionSet: (set) => { sessions.set(set.owner.roleName, structuredClone(set)); }
  };
}

test("public catalog restores only the requested Agent and global Role management groups", () => {
  const paths = listPublicCommandPaths();
  assert.ok(paths.includes("update"));
  assert.deepEqual(paths.filter((path) => path === "agent" || path.startsWith("agent ")), [
    "agent", "agent add", "agent list", "agent show", "agent update", "agent remove"
  ]);
  assert.deepEqual(paths.filter((path) => path === "role" || path.startsWith("role ")), [
    "role", "role add", "role list", "role show", "role update", "role remove",
    "role bind", "role enter", "role session", "role session record", "role session replace"
  ]);
  for (const excluded of ["backup", "maintenance", "migrate", "import", "export", "prune"]) {
    assert.equal(paths.some((path) => path === excluded || path.startsWith(`${excluded} `)), false);
  }
});

test("update uses the exact shell-free published npm command", () => {
  let invocation;
  const status = runUpdateCommand((command, args, options) => {
    invocation = { command, args, options };
    return { pid: 1, output: [], stdout: null, stderr: null, status: 7, signal: null };
  });
  assert.equal(status, 7);
  assert.equal(invocation.command, "npm");
  assert.deepEqual(invocation.args, ["install", "--global", "@zq-silk/taskmux@latest"]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.stdio, "inherit");
});

test("Agent add preserves adapter args and environment names without secret values", () => {
  const store = agentStore();
  const output = runAgentCommand([
    "add", "reviewer", "--adapter", "codex", "--command", "codex",
    "--arg", "--verbose", "--arg", "2", "--env", "OPENAI_API_KEY=TASKMUX_OPENAI_KEY"
  ], store);
  const agent = store.records.get("reviewer");
  assert.match(output, /Added agent reviewer/);
  assert.equal(agent.adapterId, "codex");
  assert.deepEqual(agent.baseArgs, ["--verbose", "2"]);
  assert.deepEqual(agent.environment, [{
    target: "OPENAI_API_KEY",
    source: "process",
    sourceName: "TASKMUX_OPENAI_KEY",
    required: true
  }]);
  assert.equal(JSON.stringify(agent).includes(process.env.TASKMUX_OPENAI_KEY ?? "never-present"), false);
});

test("Agent update supports intentional clears and rejects ambiguous replacements", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const store = agentStore([{
    schemaVersion: 2,
    id: "reviewer",
    adapterId: "codex",
    command: "codex",
    baseArgs: ["--profile", "review"],
    environment: [{ target: "OPENAI_API_KEY", source: "process", sourceName: "OPENAI_API_KEY", required: true }],
    createdAt: now,
    updatedAt: now
  }]);
  assert.match(runAgentCommand(["update", "reviewer", "--clear-args", "--clear-env"], store), /Updated agent/);
  assert.deepEqual(store.records.get("reviewer").baseArgs, []);
  assert.deepEqual(store.records.get("reviewer").environment, []);
  assert.throws(
    () => runAgentCommand(["update", "reviewer", "--arg", "one", "--clear-args"], store),
    /--arg and --clear-args cannot be used together/
  );
});

test("global Role enter returns a control result and binding preserves dormant sessions", () => {
  const store = roleStore();
  assert.match(
    runGlobalRoleCommand(["add", "reviewer", "--agent", "codex"], store),
    /Added role reviewer/
  );
  const control = runGlobalRoleCommand(["enter", "reviewer"], store, {
    taskmuxHome: "/tmp/taskmux",
    env: {}
  });
  assert.equal(control.kind, "enter");
  assert.equal(control.launch.command, "codex");

  assert.match(runGlobalRoleCommand(["bind", "reviewer", "claude"], store), /Bound role/);
  assert.equal(store.roles.get("reviewer").activeAgentId, "claude");
  assert.equal(store.sessions.get("reviewer").activeAgentId, "claude");

  assert.match(runGlobalRoleCommand([
    "session", "record", "reviewer", "--native-id", "session-1"
  ], store, { env: {} }), /Recorded native session/);
  assert.match(runGlobalRoleCommand([
    "session", "replace", "reviewer", "--native-id", "session-2", "--reason", "rotated"
  ], store, { env: {} }), /Replaced native session/);
  assert.equal(store.sessions.get("reviewer").sessions.claude.nativeSessionId, "session-2");
});
