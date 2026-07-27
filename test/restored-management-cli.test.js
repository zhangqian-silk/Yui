import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listPublicCommandPaths } from "../dist/cli/commandCatalog.js";
import { runUpdateCommand } from "../dist/cli/updateCommand.js";
import { runAgentCommand } from "../dist/commands/agentCommands.js";
import { runGlobalRoleCommand } from "../dist/commands/globalRoleCommands.js";

function agentStore(seed = []) {
  const records = new Map(seed.map((agent) => [agent.id, structuredClone(agent)]));
  return {
    records,
    transaction(execute) { return execute(this); },
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
    removeConfiguredAgent: (id) => records.delete(id),
    getConfig: () => ({}),
    listGlobalRoles: () => [],
    listGlobalRoleSessionSets: () => [],
    listTasks: () => [],
    listRoles: () => [],
    listRoleSessionSets: () => [],
    getWorkMailbox: () => null
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
    transaction(execute) { return execute(this); },
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

test("public catalog exposes Agent, Agent Profile, and persistent Role management groups", () => {
  const paths = listPublicCommandPaths();
  assert.ok(paths.includes("update"));
  assert.deepEqual(paths.filter((path) => path === "agent" || path.startsWith("agent ")), [
    "agent", "agent add", "agent list", "agent show", "agent update", "agent remove"
  ]);
  assert.deepEqual(paths.filter((path) => path === "profile" || path.startsWith("profile ")), [
    "profile", "profile add", "profile list", "profile show", "profile update",
    "profile remove", "profile reset"
  ]);
  assert.deepEqual(paths.filter((path) => path === "role" || path.startsWith("role ")), [
    "role", "role add", "role list", "role show", "role update", "role remove",
    "role bind", "role unbind", "role enter", "role session", "role session record",
    "role session replace"
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
  assert.deepEqual(invocation.args, ["install", "--global", "@zq-silk/yui@latest"]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.stdio, "inherit");
});

test("Agent add preserves adapter args and environment names without secret values", () => {
  const store = agentStore();
  const output = runAgentCommand([
    "add", "reviewer", "--adapter", "codex", "--command", "codex",
    "--arg", "--verbose", "--arg", "2", "--env", "OPENAI_API_KEY=YUI_OPENAI_KEY"
  ], store);
  const agent = store.records.get("reviewer");
  assert.match(output, /Added agent reviewer/);
  assert.equal(agent.adapterId, "codex");
  assert.deepEqual(agent.baseArgs, ["--verbose", "2"]);
  assert.deepEqual(agent.environment, [{
    target: "OPENAI_API_KEY",
    source: "process",
    sourceName: "YUI_OPENAI_KEY",
    required: true
  }]);
  assert.equal(JSON.stringify(agent).includes(process.env.YUI_OPENAI_KEY ?? "never-present"), false);
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

test("global Role enter defers launch compilation to the Controller and preserves dormant sessions", (t) => {
  const store = roleStore();
  const home = mkdtempSync(join(tmpdir(), "yui-global-enter-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.match(
    runGlobalRoleCommand(["add", "reviewer", "--agent", "codex"], store),
    /Added role reviewer/
  );
  const control = runGlobalRoleCommand(["enter", "reviewer"], store, {
    yuiHome: "/tmp/yui",
    env: {}
  });
  assert.equal(control.kind, "enter");
  assert.equal("launch" in control, false);

  assert.match(runGlobalRoleCommand(["bind", "reviewer", "claude"], store), /Bound role/);
  assert.equal(store.roles.get("reviewer").activeAgentId, "claude");
  assert.equal(store.sessions.get("reviewer").activeAgentId, "claude");
  const claudeControl = runGlobalRoleCommand(["enter", "reviewer"], store, {
    yuiHome: home,
    env: {}
  });
  assert.equal(claudeControl.kind, "enter");
  assert.equal(existsSync(join(home, "runtime")), false);

  assert.match(runGlobalRoleCommand([
    "session", "record", "reviewer", "--native-id", "session-1"
  ], store, { env: {} }), /Recorded native session/);
  store.sessions.get("reviewer").sessions.claude.status = "stopped";
  assert.match(runGlobalRoleCommand([
    "session", "replace", "reviewer", "--native-id", "session-2", "--reason", "rotated"
  ], store, { env: {} }), /Replaced native session/);
  assert.equal(store.sessions.get("reviewer").sessions.claude.nativeSessionId, "session-2");
});

test("global Role Agent settings support adapter-aware field patches and CLI-default clears", () => {
  const store = roleStore();
  runGlobalRoleCommand([
    "add", "reviewer", "--agent", "codex",
    "--model", "gpt-5.6-sol", "--effort", "high",
    "--sandbox", "workspace-write", "--approval", "on-request", "--search", "true"
  ], store);

  assert.deepEqual(store.roles.get("reviewer").agentBindings.codex.config, {
    adapterId: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    permission: { sandbox: "workspace-write", approval: "on-request" },
    search: true
  });
  const launch = runGlobalRoleCommand(["enter", "reviewer"], store, { env: {} });
  assert.equal(launch.kind, "enter");
  assert.equal("launch" in launch, false);

  runGlobalRoleCommand([
    "update", "reviewer", "--agent", "codex",
    "--model", "gpt-5.6-codex", "--clear-effort", "--clear-approval"
  ], store);
  assert.deepEqual(store.roles.get("reviewer").agentBindings.codex.config, {
    adapterId: "codex",
    model: "gpt-5.6-codex",
    permission: { sandbox: "workspace-write" },
    search: true
  });

  runGlobalRoleCommand([
    "update", "reviewer", "--agent", "claude", "--model", "claude-opus"
  ], store);
  assert.equal(store.roles.get("reviewer").activeAgentId, "codex");
  assert.deepEqual(store.roles.get("reviewer").agentBindings.claude.config, {
    adapterId: "claude",
    model: "claude-opus"
  });

  const output = runGlobalRoleCommand(["show", "reviewer"], store);
  assert.match(output, /gpt-5\.6-codex/);
  assert.match(output, /workspace-write/);
  assert.match(output, /CLI default/);
  assert.doesNotMatch(output, /\{"adapterId"/);
});

test("global Role rejects adapter-specific settings before mutating the binding", () => {
  const store = roleStore();
  runGlobalRoleCommand(["add", "reviewer", "--agent", "claude"], store);
  const before = structuredClone(store.roles.get("reviewer"));

  assert.throws(
    () => runGlobalRoleCommand([
      "update", "reviewer", "--agent", "claude", "--sandbox", "read-only"
    ], store),
    /only supported by Codex/i
  );
  assert.deepEqual(store.roles.get("reviewer"), before);
  assert.throws(
    () => runGlobalRoleCommand([
      "update", "reviewer", "--agent", "claude", "--permission-mode", ""
    ], store),
    /must not be empty|required/i
  );
  assert.throws(
    () => runGlobalRoleCommand([
      "update", "reviewer", "--agent", "", "--model", "unexpected"
    ], store),
    /--agent is required/i
  );
  assert.throws(
    () => runGlobalRoleCommand(["update", "reviewer", "--workspace", ""], store),
    /--workspace is required/i
  );
});

test("Codex search uses enabled or CLI-default semantics", () => {
  const store = roleStore();
  runGlobalRoleCommand(["add", "reviewer", "--agent", "codex"], store);
  assert.throws(
    () => runGlobalRoleCommand([
      "update", "reviewer", "--search", "false"
    ], store),
    /supports true only/i
  );
  assert.equal(store.roles.get("reviewer").agentBindings.codex.config.search, undefined);
});

test("global Role profile fields are intentionally removed only by clear options", () => {
  const store = roleStore();
  runGlobalRoleCommand([
    "add", "reviewer", "--agent", "codex", "--description", "Review changes"
  ], store);
  runGlobalRoleCommand(["update", "reviewer", "--clear-description"], store);
  assert.equal(Object.hasOwn(store.roles.get("reviewer"), "description"), false);
});
