import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createGlobalRole } from "../dist/role/role.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";

const cli = join(process.cwd(), "dist", "cli.js");
const now = new Date("2026-07-15T00:00:00.000Z");

function writeExecutable(path, body) {
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}

function configuredAgent(id, adapterId, command) {
  return {
    schemaVersion: 2,
    id,
    adapterId,
    command,
    baseArgs: [],
    environment: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

function binding(agentId, adapterId = agentId) {
  return { agentId, adapterId, config: { adapterId } };
}

function createFakeTmux(home) {
  const statePath = join(home, "fake-tmux-state.json");
  const executable = join(home, "fake-tmux.js");
  writeFileSync(statePath, JSON.stringify({ session: false, windows: {} }));
  writeExecutable(executable, `
const { readFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const statePath = process.env.TASKMUX_TEST_TMUX_STATE;
const args = process.argv.slice(2);
const load = () => JSON.parse(readFileSync(statePath, "utf8"));
const save = (state) => writeFileSync(statePath, JSON.stringify(state));
const indexOf = (value) => args.indexOf(value);
const targetName = (target) => target.slice(target.lastIndexOf(":") + 1);
const command = args[0];
const state = load();
if (command === "has-session") {
  process.exit(state.session ? 0 : 1);
}
if (command === "new-session") {
  state.session = true;
  save(state);
  process.exit(0);
}
if (command === "list-windows") {
  process.stdout.write(Object.keys(state.windows).join("\\n"));
  process.exit(0);
}
if (command === "new-window") {
  const name = args[indexOf("-n") + 1];
  const carrier = args.at(-1);
  state.windows[name] = { launchToken: null };
  save(state);
  const child = spawn("/bin/sh", [carrier], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  process.exit(0);
}
if (command === "set-option") {
  const target = targetName(args[indexOf("-t") + 1]);
  const token = args.at(-1);
  if (state.windows[target] !== undefined) {
    state.windows[target].launchToken = token;
    save(state);
  }
  process.exit(0);
}
if (command === "rename-window") {
  const oldName = targetName(args[indexOf("-t") + 1]);
  const nextName = args.at(-1);
  state.windows[nextName] = state.windows[oldName];
  delete state.windows[oldName];
  save(state);
  process.exit(0);
}
if (command === "show-options") {
  const target = targetName(args[indexOf("-t") + 1]);
  process.stdout.write(state.windows[target]?.launchToken ?? "");
  process.exit(0);
}
if (command === "attach-session") {
  writeFileSync(process.env.TASKMUX_TEST_TMUX_ATTACHED, "attached");
  process.exit(0);
}
if (command === "kill-window") {
  const target = targetName(args[indexOf("-t") + 1]);
  delete state.windows[target];
  save(state);
  process.exit(0);
}
process.exit(0);
`);
  return { executable, statePath };
}

function runOperator(home, environment) {
  return spawnSync(process.execPath, [cli, "operator"], {
    cwd: home,
    encoding: "utf8",
    env: {
      ...process.env,
      TASKMUX_HOME: home,
      TASKMUX_CONTROLLER_MODE: "direct",
      ...environment
    }
  });
}

function runCli(home, args, environment) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: home,
    encoding: "utf8",
    env: {
      ...process.env,
      TASKMUX_HOME: home,
      TASKMUX_CONTROLLER_MODE: "direct",
      ...environment
    }
  });
}

function waitFor(predicate, description) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

test("real taskmux operator CLI durably reserves and confirms a preallocated Claude session", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-operator-session-authority-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const claudeHome = join(home, "claude-home");
  const launched = join(home, "claude-launched.json");
  const attached = join(home, "operator-attached");
  const fakeClaude = writeExecutable(join(home, "fake-claude.js"), `
const { writeFileSync } = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.207\\n");
  process.exit(0);
}
if (process.argv.includes("--help")) {
  process.stdout.write("--model <model> --permission-mode <mode>\\n");
  process.exit(0);
}
writeFileSync(${JSON.stringify(launched)}, JSON.stringify({
  args: process.argv.slice(2),
  env: {
    role: process.env.TASKMUX_ROLE,
    agent: process.env.TASKMUX_AGENT_ID,
    adapter: process.env.TASKMUX_ADAPTER_ID
  }
}));
`);
  const { executable: fakeTmux, statePath } = createFakeTmux(home);
  const store = new FileTaskStore(home);
  store.saveConfiguredAgent(configuredAgent("claude", "claude", fakeClaude));
  store.saveGlobalRole(createGlobalRole(
    "operator",
    [binding("claude")],
    "claude",
    home,
    now
  ));

  const result = runOperator(home, {
    CLAUDE_CONFIG_DIR: claudeHome,
    TASKMUX_TMUX_BIN: fakeTmux,
    TASKMUX_TEST_TMUX_STATE: statePath,
    TASKMUX_TEST_TMUX_ATTACHED: attached
  });

  assert.equal(result.status, 0, result.stderr);
  waitFor(() => existsSync(launched) && existsSync(attached), "operator window launch and attach");

  const sessionSet = new FileTaskStore(home).getGlobalRoleSessionSet("operator");
  assert.ok(sessionSet, "operator launch must persist GlobalRoleSessionSet");
  assert.equal(sessionSet.activeAgentId, "claude");
  assert.equal(sessionSet.sessions.claude.adapterId, "claude");
  assert.equal(sessionSet.sessions.claude.status, "running");
  assert.equal(
    new FileTaskStore(home).nativeSessionIdentityClaims().get(JSON.stringify([
      "claude",
      sessionSet.sessions.claude.sessionRoot,
      sessionSet.sessions.claude.nativeSessionId
    ]))?.state,
    "owned"
  );
  assert.match(readFileSync(launched, "utf8"), /--session-id/);
});

test("real taskmux operator CLI records Codex's runtime-discovered tuple through the pending launch claim", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-operator-codex-authority-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const codexHome = join(home, "codex-home");
  const registered = join(home, "codex-registered.json");
  const attached = join(home, "operator-attached");
  const { executable: fakeTmux, statePath } = createFakeTmux(home);
  const fakeCodex = writeExecutable(join(home, "fake-codex.js"), `
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.144.1\\n");
  process.exit(0);
}
if (process.argv.includes("debug")) {
  process.stdout.write(JSON.stringify({ models: [] }));
  process.exit(0);
}
if (process.argv.includes("--help")) {
  process.stdout.write("--model <model> --sandbox <sandbox> --ask-for-approval <approval>\\n");
  process.exit(0);
}
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  const state = JSON.parse(readFileSync(process.env.TASKMUX_TEST_TMUX_STATE, "utf8"));
  if (state.windows.operator?.launchToken === process.env.TASKMUX_OPERATOR_LAUNCH_TOKEN) break;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
const result = spawnSync(process.execPath, [
  process.env.TASKMUX_TEST_CLI,
  "role", "session", "record", "operator", "--native-id", "codex-native-1"
], {
  encoding: "utf8",
  env: {
    ...process.env,
    CODEX_THREAD_ID: "codex-native-1",
    TASKMUX_CONTROLLER_MODE: "direct"
  }
});
writeFileSync(${JSON.stringify(registered)}, JSON.stringify({
  status: result.status,
  stdout: result.stdout,
  stderr: result.stderr,
  token: process.env.TASKMUX_OPERATOR_LAUNCH_TOKEN
}));
`);
  const store = new FileTaskStore(home);
  store.saveConfiguredAgent(configuredAgent("codex", "codex", fakeCodex));
  store.saveGlobalRole(createGlobalRole("operator", [binding("codex")], "codex", home, now));

  const environment = {
    CODEX_HOME: codexHome,
    TASKMUX_TMUX_BIN: fakeTmux,
    TASKMUX_TEST_TMUX_STATE: statePath,
    TASKMUX_TEST_TMUX_ATTACHED: attached,
    TASKMUX_TEST_CLI: cli
  };
  const result = runOperator(home, environment);
  assert.equal(result.status, 0, result.stderr);
  waitFor(() => existsSync(registered), "Codex native session registration");
  assert.equal(JSON.parse(readFileSync(registered, "utf8")).status, 0);

  const persisted = new FileTaskStore(home);
  const sessionSet = persisted.getGlobalRoleSessionSet("operator");
  assert.equal(sessionSet.sessions.codex.nativeSessionId, "codex-native-1");
  assert.equal(sessionSet.sessions.codex.status, "running");
  assert.equal(
    persisted.nativeSessionIdentityClaims().get(
      JSON.stringify(["codex", codexHome, "codex-native-1"])
    )?.state,
    "owned"
  );
  const duplicate = runCli(home, [
    "role", "session", "record", "operator", "--native-id", "codex-native-1"
  ], {
    ...environment,
    CODEX_THREAD_ID: "codex-native-1",
    TASKMUX_ROLE: "operator",
    TASKMUX_AGENT_ID: "codex",
    TASKMUX_ADAPTER_ID: "codex",
    TASKMUX_NATIVE_SESSION_ROOT: sessionSet.sessions.codex.sessionRoot,
    TASKMUX_OPERATOR_LAUNCH_TOKEN: JSON.parse(readFileSync(registered, "utf8")).token
  });
  assert.equal(duplicate.status, 0, duplicate.stderr);
});

test("a crash after the tmux effect is recovered through the same global-role launch claim", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-operator-launch-recovery-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const claudeHome = join(home, "claude-home");
  const attached = join(home, "operator-attached");
  const fakeClaude = writeExecutable(join(home, "fake-claude.js"), `
if (process.argv.includes("--version")) {
  process.stdout.write("2.1.207\\n");
  process.exit(0);
}
if (process.argv.includes("--help")) process.stdout.write("--model <model>\\n");
`);
  const { executable: fakeTmux, statePath } = createFakeTmux(home);
  const store = new FileTaskStore(home);
  store.saveConfiguredAgent(configuredAgent("claude", "claude", fakeClaude));
  store.saveGlobalRole(createGlobalRole("operator", [binding("claude")], "claude", home, now));
  const environment = {
    CLAUDE_CONFIG_DIR: claudeHome,
    TASKMUX_TMUX_BIN: fakeTmux,
    TASKMUX_TEST_TMUX_STATE: statePath,
    TASKMUX_TEST_TMUX_ATTACHED: attached
  };

  const crashed = runOperator(home, {
    ...environment,
    TASKMUX_TEST_ONLY_OPERATOR_LAUNCH_FAILPOINT: "after-window"
  });
  assert.notEqual(crashed.status, 0);
  assert.equal(new FileTaskStore(home).getGlobalRoleSessionSet("operator").sessions.claude.status, "reserved");

  const recovered = runOperator(home, environment);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(new FileTaskStore(home).getGlobalRoleSessionSet("operator").sessions.claude.status, "running");
});

test("operator agent switching preserves the former agent tuple and creates the new active tuple", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-operator-agent-switch-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const codexHome = join(home, "codex-home");
  const claudeHome = join(home, "claude-home");
  const registered = join(home, "codex-registered.json");
  const attached = join(home, "operator-attached");
  const { executable: fakeTmux, statePath } = createFakeTmux(home);
  const fakeCodex = writeExecutable(join(home, "fake-codex.js"), `
const { readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
if (process.argv.includes("--version")) { process.stdout.write("codex-cli 0.144.1\\n"); process.exit(0); }
if (process.argv.includes("debug")) { process.stdout.write(JSON.stringify({ models: [] })); process.exit(0); }
if (process.argv.includes("--help")) { process.stdout.write("--sandbox <sandbox>\\n"); process.exit(0); }
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  const state = JSON.parse(readFileSync(process.env.TASKMUX_TEST_TMUX_STATE, "utf8"));
  if (state.windows.operator?.launchToken === process.env.TASKMUX_OPERATOR_LAUNCH_TOKEN) break;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
const result = spawnSync(process.execPath, [process.env.TASKMUX_TEST_CLI, "role", "session", "record", "operator", "--native-id", "codex-switch-native"], {
  encoding: "utf8",
  env: { ...process.env, CODEX_THREAD_ID: "codex-switch-native", TASKMUX_CONTROLLER_MODE: "direct" }
});
writeFileSync(${JSON.stringify(registered)}, JSON.stringify({ status: result.status }));
`);
  const fakeClaude = writeExecutable(join(home, "fake-claude.js"), `
if (process.argv.includes("--version")) { process.stdout.write("2.1.207\\n"); process.exit(0); }
if (process.argv.includes("--help")) process.stdout.write("--model <model>\\n");
`);
  const store = new FileTaskStore(home);
  store.saveConfiguredAgent(configuredAgent("codex", "codex", fakeCodex));
  store.saveConfiguredAgent(configuredAgent("claude", "claude", fakeClaude));
  store.saveGlobalRole(createGlobalRole(
    "operator",
    [binding("codex"), binding("claude")],
    "codex",
    home,
    now
  ));
  const environment = {
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    TASKMUX_TMUX_BIN: fakeTmux,
    TASKMUX_TEST_TMUX_STATE: statePath,
    TASKMUX_TEST_TMUX_ATTACHED: attached,
    TASKMUX_TEST_CLI: cli
  };
  assert.equal(runOperator(home, environment).status, 0);
  waitFor(() => existsSync(registered), "first Codex registration");
  assert.equal(JSON.parse(readFileSync(registered, "utf8")).status, 0);
  const before = new FileTaskStore(home).getGlobalRoleSessionSet("operator").sessions.codex.nativeSessionId;

  writeFileSync(statePath, JSON.stringify({ session: true, windows: {} }));
  const switched = runCli(home, ["role", "update", "operator", "--active-agent", "claude"], environment);
  assert.equal(switched.status, 0, switched.stderr);
  assert.equal(runOperator(home, environment).status, 0);

  const sessionSet = new FileTaskStore(home).getGlobalRoleSessionSet("operator");
  assert.equal(sessionSet.activeAgentId, "claude");
  assert.equal(sessionSet.sessions.codex.nativeSessionId, before);
  assert.equal(sessionSet.sessions.claude.status, "running");
});
