import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readRoleRuntimeOperationClaim,
  roleRuntimeStateDigest,
  writeRoleRuntimeOperationClaim
} from "../dist/executor/roleRuntimeOperationClaim.js";
import { createAgentRun } from "../dist/run/agentRun.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { TmuxManager, taskmuxTmuxSessionName, taskmuxTmuxTarget } from "../dist/tmux/tmuxManager.js";

const cli = join(process.cwd(), "dist", "cli.js");

test("publishes package metadata with the taskmux command only", () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

  assert.equal(packageJson.name, "@zq-silk/taskmux");
  assert.deepEqual(packageJson.bin, {
    taskmux: "./dist/cli.js"
  });
  assert.ok(packageJson.files.includes("skills"));
});

function runTaskmux(args, env) {
  return execFileSync("node", [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      TASKMUX_CONTROLLER_MODE: "direct",
      ...env
    }
  });
}

function runTaskmuxFailure(args, env) {
  return spawnSync("node", [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      TASKMUX_CONTROLLER_MODE: "direct",
      ...env
    }
  });
}

function waitForCondition(condition, description, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.ok(condition(), `Timed out waiting for ${description}.`);
}

function pendingDomainTransactionIds(home) {
  const directory = join(home, "runtime", "domain-transactions");
  return [...new Set(readdirSync(directory).flatMap((name) => {
    const match = /^([A-Za-z0-9_-]+)(?:\.receipt-[0-9]{12}-[a-f0-9]{64})?\.json$/.exec(name);
    return match === null ? [] : [match[1]];
  }))].sort();
}

function runTaskmuxInteractive(args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        TASKMUX_CONTROLLER_MODE: "direct",
        ...env
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`taskmux exited with ${code}: ${stderr}`));
        return;
      }

      resolve(stdout);
    });

    child.stdin.end(input);
  });
}

function createFakeCarrier(home) {
  const carrierBin = join(home, "fake-carrier-bin");
  const carrierLogFile = join(home, "carrier-calls.jsonl");

  mkdirSync(carrierBin);
  writeFileSync(
    join(carrierBin, "env"),
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.FAKE_CARRIER_LOG, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd()
}) + "\\n");
`
  );
  chmodSync(join(carrierBin, "env"), 0o755);

  return { carrierBin, carrierLogFile };
}

function privateCarrierRunner(carrierBin, carrierLogFile) {
  return `
  const cwdIndex = args.indexOf("-c");
  const cwd = cwdIndex === -1 ? undefined : args[cwdIndex + 1];
  const shellIndex = args.lastIndexOf("/bin/sh");
  const command = shellIndex === -1 ? args.at(-2) : args[shellIndex];
  const commandArgs = shellIndex === -1 ? [args.at(-1)] : args.slice(shellIndex + 1);
  const result = spawnSync(command, commandArgs, {
    cwd: cwd === undefined || !existsSync(cwd) ? undefined : cwd,
    env: {
      ...process.env,
      PATH: ${JSON.stringify(`${carrierBin}:/usr/bin:/bin`)},
      FAKE_CARRIER_LOG: process.env.FAKE_CARRIER_LOG ?? ${JSON.stringify(carrierLogFile)}
    },
    stdio: "ignore"
  });
  process.exit(result.status ?? 1);
`;
}

function createFakeTmux(home) {
  const fakeTmux = join(home, "fake-tmux.js");
  const logFile = join(home, "tmux-calls.jsonl");
  const { carrierBin, carrierLogFile } = createFakeCarrier(home);

  writeFileSync(
    fakeTmux,
    `#!${process.execPath}
const { appendFileSync, existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "has-session") process.exit(1);
if (args[0] === "list-windows") process.exit(0);
if (args[0] === "capture-pane") {
  process.stdout.write("recent reviewer output\\n");
  process.exit(0);
}
if (args[0] === "new-window") {
${privateCarrierRunner(carrierBin, carrierLogFile)}
}
process.exit(0);
`
  );
  chmodSync(fakeTmux, 0o755);

  return { fakeTmux, logFile, carrierLogFile };
}

function createFencedOperatorTmux(home) {
  const fakeTmux = join(home, "fake-fenced-operator-tmux.js");
  const logFile = join(home, "fenced-operator-tmux-calls.jsonl");
  const stateFile = join(home, "fenced-operator-tmux-state.json");
  const { carrierBin, carrierLogFile } = createFakeCarrier(home);

  writeFileSync(
    fakeTmux,
    `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_TMUX_STATE;
const emptyState = () => ({ session: false, windows: {} });
const readState = () => existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : emptyState();
const writeState = (state) => writeFileSync(stateFile, JSON.stringify(state));
const targetName = (target) => target.slice(target.lastIndexOf(":") + 1);
const state = readState();
appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "has-session") process.exit(state.session ? 0 : 1);
if (args[0] === "new-session") {
  state.session = true;
  writeState(state);
  process.exit(0);
}
if (args[0] === "list-windows") {
  process.stdout.write(Object.keys(state.windows).join("\\n"));
  process.exit(0);
}
if (args[0] === "new-window") {
  const name = args[args.indexOf("-n") + 1];
  state.windows[name] = { options: {} };
  writeState(state);
${privateCarrierRunner(carrierBin, carrierLogFile)}
}
if (args[0] === "set-option") {
  const name = targetName(args[args.indexOf("-t") + 1]);
  if (state.windows[name] !== undefined) {
    state.windows[name].options[args.at(-2)] = args.at(-1);
    writeState(state);
  }
  process.exit(0);
}
if (args[0] === "show-options") {
  const name = targetName(args[args.indexOf("-t") + 1]);
  process.stdout.write(state.windows[name]?.options[args.at(-1)] ?? "");
  process.exit(0);
}
if (args[0] === "rename-window") {
  const oldName = targetName(args[args.indexOf("-t") + 1]);
  const newName = args.at(-1);
  state.windows[newName] = state.windows[oldName];
  delete state.windows[oldName];
  writeState(state);
  process.exit(0);
}
if (args[0] === "kill-window") {
  delete state.windows[targetName(args[args.indexOf("-t") + 1])];
  writeState(state);
  process.exit(0);
}
if (args[0] === "capture-pane") {
  process.stdout.write("recent reviewer output\\n");
  process.exit(0);
}
process.exit(0);
`
  );
  chmodSync(fakeTmux, 0o755);

  return { fakeTmux, logFile, stateFile };
}

function fencedOperatorLaunchToken(stateFile) {
  const token = JSON.parse(readFileSync(stateFile, "utf8"))
    .windows.operator?.options["@taskmux_launch_token"];
  assert.match(token ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  return token;
}

function createStatusTmux(home) {
  const fakeTmux = join(home, "fake-status-tmux.js");

  writeFileSync(
    fakeTmux,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "list-windows") {
  process.stdout.write("rd\\n");
  process.exit(0);
}
process.exit(0);
`
  );
  chmodSync(fakeTmux, 0o755);

  return fakeTmux;
}

function createExistingRoleTmux(home, roleName) {
  const fakeTmux = join(home, "fake-existing-role-tmux.js");
  const logFile = join(home, "existing-role-tmux-calls.jsonl");
  const { carrierBin, carrierLogFile } = createFakeCarrier(home);

  writeFileSync(
    fakeTmux,
    `#!${process.execPath}
const { appendFileSync, existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "list-windows") process.stdout.write(${JSON.stringify(`${roleName}\n`)});
if (args[0] === "new-window") {
${privateCarrierRunner(carrierBin, carrierLogFile)}
}
process.exit(0);
`
  );
  chmodSync(fakeTmux, 0o755);

  return { fakeTmux, logFile, carrierLogFile };
}

function createStatefulTmux(home) {
  const fakeTmux = join(home, "fake-stateful-tmux.js");
  const logFile = join(home, "stateful-tmux-calls.jsonl");
  const stateFile = join(home, "stateful-tmux-windows.txt");
  const optionFile = join(home, "stateful-tmux-options.json");
  const carrierBin = join(home, "fake-stateful-carrier-bin");
  mkdirSync(carrierBin);
  writeFileSync(join(carrierBin, "env"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(carrierBin, "env"), 0o755);

  writeFileSync(
    fakeTmux,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const state = process.env.FAKE_TMUX_STATE;
const optionFile = ${JSON.stringify(optionFile)};
const readOptions = () => existsSync(optionFile) ? JSON.parse(readFileSync(optionFile, "utf8")) : {};
const writeOptions = (value) => writeFileSync(optionFile, JSON.stringify(value));
const ensurePaneOptions = (options, target) => options[target] ??= {};
appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "has-session") process.exit(existsSync(state) ? 0 : 1);
if (args[0] === "new-session") { writeFileSync(state, ""); process.exit(0); }
if (args[0] === "list-windows") { if (existsSync(state)) process.stdout.write(readFileSync(state, "utf8")); process.exit(0); }
const exactCondition = args[0] === "if-shell" && args.includes("-t") &&
  args[args.indexOf("-F") + 1]?.includes("@taskmux_exact_role_input_binding");
if (exactCondition) {
  const target = args[args.indexOf("-t") + 1];
  const condition = args[args.indexOf("-F") + 1];
  const command = args[args.indexOf("-F") + 2];
  const expected = /@taskmux_exact_role_input_binding},([a-f0-9]{64})}/.exec(condition)?.[1];
  const receipt = /@taskmux_leader_input_([a-f0-9]{64})\\s+1/.exec(command)?.[1];
  if (expected === undefined || receipt === undefined) process.exit(1);
  const options = readOptions();
  const pane = ensurePaneOptions(options, target);
  if (pane["@taskmux_exact_role_input_binding"] !== expected) {
    process.stdout.write("__TASKMUX_EXACT_INPUT_FENCED_" + receipt + "__\\n");
    process.exit(0);
  }
  const receiptOption = "@taskmux_leader_input_" + receipt;
  if (pane[receiptOption] === "1") {
    process.stdout.write("__TASKMUX_EXACT_INPUT_RECEIPT_" + receipt + "__\\n");
    process.exit(0);
  }
  pane[receiptOption] = "1";
  writeOptions(options);
  process.stdout.write("__TASKMUX_EXACT_INPUT_APPLIED_" + receipt + "__\\n");
  process.exit(0);
}
if (args[0] === "set-option") {
  const options = readOptions();
  const pane = ensurePaneOptions(options, args[args.indexOf("-t") + 1]);
  pane[args.at(-2)] = args.at(-1);
  writeOptions(options);
  process.exit(0);
}
if (args[0] === "new-window") {
  const cwdIndex = args.indexOf("-c");
  const cwd = cwdIndex === -1 ? undefined : args[cwdIndex + 1];
  appendFileSync(
    process.env.FAKE_TMUX_LOG,
    JSON.stringify(["carrier", readFileSync(args.at(-1), "utf8")]) + "\\n"
  );
  const result = spawnSync(args.at(-2), [args.at(-1)], {
    cwd: cwd === undefined || !existsSync(cwd) ? undefined : cwd,
    env: { ...process.env, PATH: ${JSON.stringify(`${carrierBin}:/usr/bin:/bin`)} },
    stdio: "ignore"
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const name = args[args.indexOf("-n") + 1];
  const current = existsSync(state) ? readFileSync(state, "utf8").split("\\n").filter(Boolean) : [];
  if (!current.includes(name)) current.push(name);
  writeFileSync(state, current.join("\\n") + "\\n");
  process.exit(0);
}
if (args[0] === "rename-window") {
  const target = args[args.indexOf("-t") + 1];
  const oldName = target.split(":").at(-1);
  const newName = args.at(-1);
  const current = existsSync(state) ? readFileSync(state, "utf8").split("\\n").filter(Boolean) : [];
  const index = current.indexOf(oldName);
  if (index !== -1) current[index] = newName;
  writeFileSync(state, current.length === 0 ? "" : current.join("\\n") + "\\n");
  const options = readOptions();
  const nextTarget = target.slice(0, target.lastIndexOf(":") + 1) + newName;
  options[nextTarget] = options[target] ?? {};
  delete options[target];
  writeOptions(options);
  process.exit(0);
}
if (args[0] === "kill-window") {
  const target = args.at(-1);
  const name = target.split(":").at(-1);
  const current = existsSync(state) ? readFileSync(state, "utf8").split("\\n").filter((item) => item && item !== name) : [];
  writeFileSync(state, current.length === 0 ? "" : current.join("\\n") + "\\n");
  const options = readOptions();
  delete options[target];
  writeOptions(options);
  process.exit(0);
}
process.exit(0);
`
  );
  chmodSync(fakeTmux, 0o755);

  return { fakeTmux, logFile, stateFile };
}

function createFailingDispatchTmux(home) {
  const fakeTmux = join(home, "fake-failing-dispatch-tmux.js");
  const logFile = join(home, "failing-dispatch-tmux-calls.jsonl");

  writeFileSync(
    fakeTmux,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
if (args[0] === "has-session" || args[0] === "new-session") process.exit(1);
process.exit(0);
`
  );
  chmodSync(fakeTmux, 0o755);

  return { fakeTmux, logFile };
}

function createFakeExecutable(home, name, output) {
  const executable = join(home, name);

  writeFileSync(
    executable,
    `#!${process.execPath}
process.stdout.write(${JSON.stringify(output)});
`
  );
  chmodSync(executable, 0o755);

  return executable;
}

function createFakeAgentCli(home, name, adapter = "codex") {
  const executable = join(home, name);
  const version = adapter === "claude" ? "2.1.207 (Claude Code)" : "codex-cli 0.144.1";

  writeFileSync(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) process.stdout.write(${JSON.stringify(`${version}\n`)});
else if (${JSON.stringify(adapter)} === "codex" && args.join(" ") === "debug models --bundled") process.stdout.write('{"models":[]}\\n');
else if (${JSON.stringify(adapter)} === "claude" && args.includes("--help")) process.stdout.write('--effort <level> (low, medium, high, xhigh, max)\\n--permission-mode <mode> (choices: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan)\\n');
else process.stdout.write("agent ready\\n");
`
  );
  chmodSync(executable, 0o755);

  return executable;
}

function agentDefinitionFixture(id, command, {
  adapterId = id,
  baseArgs = [],
  environment = []
} = {}) {
  const timestamp = "2026-07-11T00:00:00.000Z";

  return {
    schemaVersion: 2,
    id,
    adapterId,
    command,
    baseArgs,
    environment,
    source: "custom",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function roleAgentConfigFixture(adapterId) {
  if (adapterId === "claude") {
    return {
      adapterId: "claude",
      permission: {
        mode: "plan",
        allowedTools: ["Bash(git status)", "Read"],
        disallowedTools: ["Write"]
      }
    };
  }

  return {
    adapterId: "codex",
    permission: {
      sandbox: "workspace-write",
      approval: "on-request"
    }
  };
}

function taskRoleFixture({
  taskId = "task-1",
  name = "reviewer",
  agentId = "codex",
  adapterId = agentId,
  config = roleAgentConfigFixture(adapterId),
  workspace = "/tmp/project-a",
  status = "idle"
} = {}) {
  const timestamp = "2026-07-11T00:00:00.000Z";

  return {
    schemaVersion: 2,
    taskId,
    name,
    activeAgentId: agentId,
    agentBindings: {
      [agentId]: { agentId, adapterId, config }
    },
    workspace,
    status,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function taskRoleRuntimeFixture(options = {}) {
  const { name: _name, ...runtime } = taskRoleFixture(options);
  return runtime;
}

function hashPermissionTool(tool) {
  return createHash("sha256").update(tool).digest("hex");
}

function hashPermissionTools(tools) {
  return [...new Set(tools.map(hashPermissionTool))].sort();
}

function permissionEnvelopeFixture(adapterId) {
  if (adapterId === "claude") {
    return {
      adapterId: "claude",
      mode: "plan",
      allowedToolHashes: hashPermissionTools(["Bash(git status)", "Read"]),
      disallowedToolHashes: hashPermissionTools(["Write"]),
      additionalDirectoryHashes: []
    };
  }

  return {
    adapterId: "codex",
    sandbox: "workspace-write",
    approval: "on-request",
    additionalDirectoryHashes: []
  };
}

function configFingerprintFixture(seed = "taskmux-test") {
  const digest = createHash("sha256").update(seed).digest("hex");
  return {
    overall: digest,
    replayable: digest,
    permission: digest,
    sessionBound: digest
  };
}

function taskRoleSessionSetFixture({
  taskId = "task-1",
  roleName = "reviewer",
  agentId = "codex",
  adapterId = agentId,
  nativeSessionId = "native-session",
  sessionRoot = adapterId === "claude" ? "/tmp/claude" : "/tmp/codex",
  worktreeRoot = "/tmp/project-a",
  configFingerprint = configFingerprintFixture(),
  permissionEnvelope = permissionEnvelopeFixture(adapterId),
  policy = "leader-controlled",
  status = "ready"
} = {}) {
  const timestamp = "2026-07-11T00:00:00.000Z";

  return {
    schemaVersion: 3,
    owner: { scope: "task", taskId, roleName },
    activeAgentId: agentId,
    sessions: {
      [agentId]: {
        schemaVersion: 3,
        agentId,
        adapterId,
        nativeSessionId,
        policy,
        status,
        previousIdentities: [],
        sessionRoot,
        worktreeRoot,
        createdConfigHash: configFingerprint,
        lastLaunchConfigHash: configFingerprint,
        permissionEnvelope,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    },
    updatedAt: timestamp
  };
}

function tmuxTarget(home, taskId, roleName) {
  return taskmuxTmuxTarget(home, taskId, roleName);
}

function taskRoleSessionSet(home, taskId, roleName) {
  const sessionSet = new FileTaskStore(home).getRoleSessionSet(taskId, roleName);

  assert.ok(sessionSet, `Expected a RoleSessionSet for ${taskId}/${roleName}.`);
  return sessionSet;
}

function fakeCarrierCalls(carrierLogFile) {
  if (!existsSync(carrierLogFile)) return [];
  const content = readFileSync(carrierLogFile, "utf8").trim();
  return content.length === 0 ? [] : content.split("\n").map((line) => JSON.parse(line));
}

function fakeCarrierEnvironment(call) {
  return Object.fromEntries(call.argv
    .filter((argument) => argument.startsWith("TASKMUX_"))
    .map((argument) => {
      const separator = argument.indexOf("=");
      return [argument.slice(0, separator), argument.slice(separator + 1)];
    }));
}

function assertPrivateCarrierWindow(call) {
  assert.ok(call);
  assert.deepEqual(call.slice(-2, -1), ["/bin/sh"]);
  assert.match(call.at(-1), /\.taskmux-launch-carriers-.*\/\.pending-launch-.*\/launch\.sh$/);
}

function assertPrivateCarrierWindowRenamedForRole(calls, home, taskId, roleName) {
  const newWindow = calls.find((call) => call[0] === "new-window");

  assertPrivateCarrierWindow(newWindow);
  const temporaryName = newWindow.at(newWindow.indexOf("-n") + 1);
  assert.match(temporaryName, /^taskmux-launch-[a-f0-9-]{36}$/);
  assert.equal(newWindow[newWindow.indexOf("-t") + 1], taskmuxTmuxSessionName(home, taskId));
  assert.ok(calls.some((call) =>
    call[0] === "rename-window" &&
    call[call.indexOf("-t") + 1] === tmuxTarget(home, taskId, temporaryName) &&
    call.at(-1) === roleName
  ));
}

function addAgent(
  home,
  id,
  command = id,
  adapter = id === "claude" ? "claude" : "codex",
  environment = {}
) {
  ensureTestStorageSchema(home);

  return runTaskmux(["agent", "add", id, "--adapter", adapter, "--command", command], {
    ...environment,
    TASKMUX_HOME: home
  });
}

function createTaskmuxHome() {
  return mkdtempSync(join(tmpdir(), "taskmux-test-"));
}

function createConfiguredHome(environment = {}) {
  const home = createTaskmuxHome();
  const probeBin = mkdtempSync(join(tmpdir(), "taskmux-canonical-agent-probe-"));
  createFakeAgentCli(probeBin, "codex", "codex");
  createFakeAgentCli(probeBin, "claude", "claude");
  const probeEnvironment = {
    ...environment,
    PATH: [probeBin, environment.PATH ?? process.env.PATH ?? ""]
      .filter((value) => typeof value === "string" && value.length > 0)
      .join(delimiter)
  };

  writeStorageSchema(home, 4);
  addAgent(home, "codex", "codex", "codex", probeEnvironment);
  addAgent(home, "claude", "claude", "claude", probeEnvironment);
  runTaskmux(["config", "set", "default-agent", "codex"], {
    ...environment,
    TASKMUX_HOME: home
  });
  runTaskmux(["config", "set", "default-workspace", "/tmp/project-a"], {
    ...environment,
    TASKMUX_HOME: home
  });

  return home;
}

function createRunningTaskLeaderSessionCaller() {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const sessionRoot = join(home, "caller-codex");
  mkdirSync(sessionRoot);
  const baseEnv = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    CODEX_HOME: sessionRoot
  };

  runTaskmux(["task", "create", "Caller task"], baseEnv);
  runTaskmux(["task", "create", "Target task"], baseEnv);
  runTaskmux(
    ["task", "dispatch", "task-1", "leader", "--mode", "new", "--input", "Begin the caller task"],
    baseEnv
  );
  const activeRun = new FileTaskStore(home).getActiveAgentRun("task-1", "leader");

  assert.ok(activeRun);
  return {
    home,
    fakeTmux,
    logFile,
    sessionRoot,
    baseEnv,
    callerEnv: {
      ...baseEnv,
      TASKMUX_TASK_ID: "task-1",
      TASKMUX_ROLE: "leader",
      TASKMUX_RUN_ID: activeRun.id,
      TASKMUX_AGENT_ID: "codex",
      TASKMUX_ADAPTER_ID: "codex",
      TASKMUX_NATIVE_SESSION_ROOT: sessionRoot,
      CODEX_THREAD_ID: "caller-thread"
    }
  };
}

function createGlobalRoleSessionCaller() {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const sessionRoot = join(home, "caller-codex");
  mkdirSync(sessionRoot);
  const baseEnv = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    CODEX_HOME: sessionRoot
  };

  runTaskmux(["role", "add", "operator", "--agent", "codex", "--workspace", "/tmp/project-a"], baseEnv);
  runTaskmux(["role", "add", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"], baseEnv);

  return {
    home,
    fakeTmux,
    logFile,
    sessionRoot,
    baseEnv,
    callerEnv: {
      ...baseEnv,
      TASKMUX_ROLE: "operator",
      TASKMUX_AGENT_ID: "codex",
      TASKMUX_ADAPTER_ID: "codex",
      TASKMUX_NATIVE_SESSION_ROOT: sessionRoot,
      CODEX_THREAD_ID: "caller-thread"
    }
  };
}

function startCleanController(home, fakeTmux, logFile) {
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "60000"
  };
  runTaskmux(["controller", "start"], env);
  return env;
}

function stopController(home) {
  runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
}

function createPathExecutable(dir, name, body) {
  const executable = join(dir, name);

  writeFileSync(executable, `#!${process.execPath}\n${body}\n`);
  chmodSync(executable, 0o755);

  return executable;
}

function createCanonicalCodexFake(dir) {
  return createPathExecutable(dir, "codex", "process.stdout.write('codex-cli 0.144.1\\n');");
}

function createShellExecutable(home, name, body) {
  const executable = join(home, name);

  writeFileSync(executable, `#!/bin/sh\n${body}\n`);
  chmodSync(executable, 0o755);

  return executable;
}

function tableRowRegex(item, status, detailPattern = ".*") {
  return new RegExp(`\\|\\s+${escapeRegex(item)}\\s+\\|\\s+${escapeRegex(status)}\\s+\\|\\s+${detailPattern}`);
}

function tableCellsRegex(...cells) {
  return new RegExp(`\\|\\s+${cells.map((cell) => cell instanceof RegExp ? cell.source : escapeRegex(cell)).join("\\s+\\|\\s+")}`);
}

function configTableRows(output) {
  const rows = [];
  let previousDetailLength = 0;
  let detailWidth = 0;

  for (const line of output.split("\n").filter((line) => line.startsWith("|"))) {
    const rawCells = line.split("|").slice(1, -1);
    const cells = rawCells.map((cell) => cell.trim());

    if (cells[0] === "Item") {
      continue;
    }

    if (cells[0].length > 0) {
      rows.push(cells);
      previousDetailLength = cells[2].length;
      detailWidth = rawCells[2].length - 2;
      continue;
    }

    const row = rows.at(-1);
    if (row !== undefined) {
      row[2] += `${previousDetailLength < detailWidth ? " " : ""}${cells[2]}`;
      previousDetailLength = cells[2].length;
    }
  }

  return rows;
}

function configTableItems(output) {
  return configTableRows(output).map(([item]) => item);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeStorageSchema(home, storageVersion) {
  writeFileSync(
    join(home, "schema.json"),
    JSON.stringify({
      schemaVersion: 1,
      storageVersion,
      updatedAt: "2026-06-24T00:00:00.000Z"
    })
  );
}

function ensureTestStorageSchema(home) {
  if (!existsSync(join(home, "schema.json"))) {
    writeStorageSchema(home, 4);
  }
}

test("rejects removed compatibility command groups", () => {
  const home = createConfiguredHome();

  for (const command of [["assistant"], ["runner", "list"], ["migrate"], ["board"]]) {
    const result = runTaskmuxFailure(command, { TASKMUX_HOME: home });

    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`USAGE_ERROR: Unknown command: ${command[0]}`));
  }
});

test("stores configured agents only under the canonical agents directory", () => {
  const home = createTaskmuxHome();
  writeStorageSchema(home, 4);

  addAgent(home, "codex", "codex");

  assert.equal(existsSync(join(home, "agents", "codex", "agent.json")), true);
  assert.equal(existsSync(join(home, "runners")), false);
});

test("creates configured canonical agents from an isolated probe fixture", () => {
  const home = createConfiguredHome();
  const codex = JSON.parse(readFileSync(join(home, "agents", "codex", "agent.json"), "utf8"));
  const claude = JSON.parse(readFileSync(join(home, "agents", "claude", "agent.json"), "utf8"));

  assert.equal(codex.command, "codex");
  assert.equal(claude.command, "claude");
  assert.match(codex.probePin.executable.path, /taskmux-canonical-agent-probe-/);
  assert.match(claude.probePin.executable.path, /taskmux-canonical-agent-probe-/);
  assert.equal(codex.probePin.executable.path.startsWith(home), false);
  assert.equal(claude.probePin.executable.path.startsWith(home), false);
});

test("prepends the configured-home probe fixture to an explicit PATH", () => {
  const bin = mkdtempSync(join(tmpdir(), "taskmux-explicit-agent-probe-"));
  createFakeAgentCli(bin, "codex", "codex");
  createFakeAgentCli(bin, "claude", "claude");
  const home = createConfiguredHome({ PATH: [bin, dirname(process.execPath)].join(delimiter) });
  const codex = JSON.parse(readFileSync(join(home, "agents", "codex", "agent.json"), "utf8"));
  const claude = JSON.parse(readFileSync(join(home, "agents", "claude", "agent.json"), "utf8"));

  assert.match(codex.probePin.executable.path, /taskmux-canonical-agent-probe-/);
  assert.match(claude.probePin.executable.path, /taskmux-canonical-agent-probe-/);
  assert.notEqual(codex.probePin.executable.path, join(bin, "codex"));
  assert.notEqual(claude.probePin.executable.path, join(bin, "claude"));
});

test("treats help as leaf data and keeps business argument errors concise", () => {
  const home = createConfiguredHome();
  const created = runTaskmux(["task", "create", "help"], { TASKMUX_HOME: home });
  const invalid = runTaskmuxFailure(["task", "show"], { TASKMUX_HOME: home });

  assert.match(created, /Created task task-1: help/);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stderr, "USAGE_ERROR: Task id is required.\n");
});

test("rejects previous storage schemas without an upgrade path", () => {
  const home = createTaskmuxHome();
  writeStorageSchema(home, 2);

  const result = runTaskmuxFailure(["task", "list"], { TASKMUX_HOME: home });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /Unsupported storage schema version: 2\. This TaskMux requires storage schema 4/);
  assert.doesNotMatch(result.stderr, /migrate/i);
});

test("creates a task in the configured taskmux home", () => {
  const home = createConfiguredHome();

  const output = runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Created task task-1/);
  assert.match(output, /Refactor login page/);

  const task = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8")
  );
  const taskInfo = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "info.json"), "utf8")
  );

  assert.equal(task.schemaVersion, 1);
  assert.equal(task.id, "task-1");
  assert.equal(task.status, undefined);
  assert.equal(task.archived, false);
  assert.equal(task.title, undefined);
  assert.equal(taskInfo.schemaVersion, 1);
  assert.equal(taskInfo.title, "Refactor login page");
});

test("creates tasks with the built-in leader role from configured agent defaults", () => {
  const home = createConfiguredHome();
  const leaderCli = createFakeExecutable(home, "leader-agent.js", "leader agent 1.0\n");

  addAgent(home, "leader-cli", leaderCli);
  runTaskmux(["config", "set", "default-agent", "leader-cli"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["config", "set", "default-workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["task", "create", "Leadable task"], {
    TASKMUX_HOME: home
  });
  const roles = runTaskmux(["task", "roles", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Assigned roles: leader/);
  assert.match(roles, tableCellsRegex("leader", "leader-cli", "idle", "/tmp/project-a"));
});

test("requires a leader role agent before creating a task", () => {
  const home = createTaskmuxHome();
  ensureTestStorageSchema(home);

  const result = runTaskmuxFailure(["task", "create", "Missing leader agent"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE_ERROR: Role leader requires an agent or a configured global role/);
  assert.match(result.stderr, /taskmux role add leader --agent <agent-id>/);
});

test("normal commands require setup before writing storage", () => {
  const home = createTaskmuxHome();

  const result = runTaskmuxFailure(["task", "list"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: TaskMux is not initialized\. Run `taskmux setup`\./);
  assert.equal(existsSync(join(home, "schema.json")), false);
});

test("creates explicit storage backups", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["backup"], {
    TASKMUX_HOME: home
  });
  const backupPath = output.match(/Created backup (.+)/)?.[1]?.trim();

  assert.ok(backupPath);
  assert.equal(existsSync(join(backupPath, "backups")), false);
  assert.equal(JSON.parse(readFileSync(join(backupPath, "schema.json"), "utf8")).storageVersion, 4);
  assert.equal(
    JSON.parse(readFileSync(join(backupPath, "tasks", "task-1", "info.json"), "utf8")).title,
    "Refactor login page"
  );
});

test("does not publish a partially created backup", () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Atomic backup"], { TASKMUX_HOME: home });

  const result = runTaskmuxFailure(["backup"], {
    TASKMUX_HOME: home,
    TASKMUX_BACKUP_FAILPOINT: "before-publish"
  });
  const published = existsSync(join(home, "backups"))
    ? readdirSync(join(home, "backups")).filter((name) => name.startsWith("backup-"))
    : [];

  assert.equal(result.status, 5);
  assert.deepEqual(published, []);
});

test("exports imports and prunes local data", () => {
  const sourceHome = createConfiguredHome();
  const targetHome = createConfiguredHome();
  const exportPath = join(mkdtempSync(join(tmpdir(), "taskmux-export-")), "snapshot.json");
  new FileTaskStore(targetHome).saveConfig({
    schemaVersion: 1,
    defaultWorkspace: "/tmp/project-target"
  });

  runTaskmux(["config", "set", "default-agent", "codex"], {
    TASKMUX_HOME: sourceHome
  });
  runTaskmux(["task", "create", "Portable task", "--priority", "high"], {
    TASKMUX_HOME: sourceHome
  });
  runTaskmux(["task", "assign", "task-1", "rd", "--agent", "codex", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: sourceHome
  });
  runTaskmux(["task", "comment", "task-1", "Ship it"], {
    TASKMUX_HOME: sourceHome
  });

  const exportOutput = runTaskmux(["export", "--output", exportPath], {
    TASKMUX_HOME: sourceHome
  });
  assert.match(exportOutput, /Exported TaskMux portable data/);
  assert.equal(existsSync(exportPath), true);

  const importOutput = runTaskmux(["import", exportPath, "--workspace-map", "default=default"], {
    TASKMUX_HOME: targetHome
  });
  assert.match(importOutput, /Imported TaskMux portable data/);

  assert.match(runTaskmux(["task", "show", "task-1"], { TASKMUX_HOME: targetHome }), /Portable task/);
  assert.match(runTaskmux(["task", "roles", "task-1"], { TASKMUX_HOME: targetHome }), tableCellsRegex("rd", "codex"));
  assert.match(runTaskmux(["task", "comments", "task-1"], { TASKMUX_HOME: targetHome }), /Ship it/);
  assert.match(
    runTaskmux(["config", "show"], { TASKMUX_HOME: targetHome }),
    tableRowRegex("default-agent", "configured", "agent=codex; command=codex")
  );

  runTaskmux(["task", "delete", "task-1"], {
    TASKMUX_HOME: targetHome
  });
  assert.equal(existsSync(join(targetHome, "trash", "tasks", "task-1")), true);

  const pruneOutput = runTaskmux(["prune", "--trash"], {
    TASKMUX_HOME: targetHome
  });
  assert.match(pruneOutput, /Pruned trash tasks: 1/);
  assert.equal(existsSync(join(targetHome, "trash", "tasks", "task-1")), false);
});

test("maintenance commands do not initialize missing storage", () => {
  const parent = createTaskmuxHome();
  const home = join(parent, "taskmux-home");

  const backup = runTaskmuxFailure(["backup"], { TASKMUX_HOME: home });
  const maintenance = runTaskmuxFailure(["maintenance", "git", "recover"], { TASKMUX_HOME: home });

  assert.equal(backup.status, 4);
  assert.match(backup.stderr, /DATA_ERROR: TaskMux is not initialized\. Run `taskmux setup`\./);
  assert.equal(maintenance.status, 4);
  assert.match(maintenance.stderr, /DATA_ERROR: TaskMux is not initialized\. Run `taskmux setup`\./);
  assert.equal(existsSync(home), false);
});

test("reads edited task info from the user-editable info file", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  writeFileSync(
    join(home, "tasks", "task-1", "info.json"),
    JSON.stringify({ schemaVersion: 1, title: "Edited task title" })
  );

  const showOutput = runTaskmux(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });
  const listOutput = runTaskmux(["task", "list"], {
    TASKMUX_HOME: home
  });

  assert.match(showOutput, /Title: Edited task title/);
  assert.match(listOutput, tableCellsRegex("task-1", "ongoing", "Edited task title"));
});

test("fails closed for an invalid authoritative task edit instead of serving stale state", async () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Last valid title"], { TASKMUX_HOME: home });
  const { FileTaskStore } = await import("../dist/storage/taskStore.js");
  const { createResilientTaskStore } = await import("../dist/storage/resilientTaskStore.js");
  const diagnostics = [];
  const store = createResilientTaskStore(new FileTaskStore(home), (error) => diagnostics.push(error.message));
  const infoFile = join(home, "tasks", "task-1", "info.json");

  assert.equal(store.getTask("task-1").title, "Last valid title");
  writeFileSync(infoFile, "{ invalid json\n");
  assert.throws(() => store.getTask("task-1"), /Invalid task info record/);
  assert.equal(readFileSync(infoFile, "utf8"), "{ invalid json\n");
  assert.deepEqual(diagnostics, []);

  writeFileSync(infoFile, JSON.stringify({ schemaVersion: 1, title: "Reloaded valid title" }));
  assert.equal(store.getTask("task-1").title, "Reloaded valid title");
});

test("fails closed instead of following a state-file symlink", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Protect local state writes"], { TASKMUX_HOME: home });
  const taskFile = join(home, "tasks", "task-1", "task.json");
  const sentinel = join(home, "sentinel-task.json");
  writeFileSync(sentinel, readFileSync(taskFile, "utf8"));
  unlinkSync(taskFile);
  symlinkSync(sentinel, taskFile);

  const result = runTaskmuxFailure(["task", "archive", "task-1"], { TASKMUX_HOME: home });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Authoritative storage contains an unsupported entry/);
  assert.equal(JSON.parse(readFileSync(sentinel, "utf8")).archived, false);
  assert.equal(JSON.parse(readFileSync(taskFile, "utf8")).archived, false);
  assert.equal(lstatSync(taskFile).isSymbolicLink(), true);
});

test("fails closed instead of following an append-only domain-log symlink", () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Protect event writes"], { TASKMUX_HOME: home });
  const commentsFile = join(home, "tasks", "task-1", "comments.jsonl");
  const sentinel = join(home, "sentinel-comments.jsonl");
  writeFileSync(sentinel, "");
  symlinkSync(sentinel, commentsFile);

  const result = runTaskmuxFailure(
    ["task", "comment", "task-1", "Atomic comment"],
    { TASKMUX_HOME: home }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Authoritative storage contains an unsupported entry/);
  assert.equal(readFileSync(sentinel, "utf8"), "");
  assert.equal(readFileSync(commentsFile, "utf8"), "");
  assert.equal(lstatSync(commentsFile).isSymbolicLink(), true);
});

test("replays a staged complete snapshot after an interrupted write", async () => {
  const home = createTaskmuxHome();
  const target = join(home, "tasks", "task-1", "task.json");
  const recovery = await import("../dist/storage/recoveryJournal.js");

  recovery.stageSnapshotWrite(home, target, '{"schemaVersion":2,"archived":false}\n', "write-1");
  assert.equal(existsSync(target), false);

  const replayed = recovery.replayPendingSnapshotWrites(home);
  assert.deepEqual(replayed, [target]);
  assert.equal(readFileSync(target, "utf8"), '{"schemaVersion":2,"archived":false}\n');
  assert.deepEqual(readdirSync(join(home, "runtime", "recovery-journal")), []);
});

test("replays a complete multi-file domain transaction after partial application", async () => {
  const home = createTaskmuxHome();
  const first = join(home, "tasks", "task-1", "task.json");
  const second = join(home, "tasks", "task-1", "info.json");
  const removed = join(home, "runtime", "pending-wakeups", "task-1.json");
  mkdirSync(join(home, "tasks", "task-1"), { recursive: true });
  mkdirSync(join(home, "runtime", "pending-wakeups"), { recursive: true });
  writeFileSync(first, "old task\n");
  writeFileSync(second, "old info\n");
  writeFileSync(removed, "pending\n");
  const recovery = await import("../dist/storage/recoveryJournal.js");

  recovery.stageDomainTransaction(home, "transaction-1", [
    { type: "write", target: first, content: "new task\n" },
    { type: "write", target: second, content: "new info\n" },
    { type: "delete", target: removed }
  ]);
  assert.throws(
    () => recovery.applyStagedDomainTransaction(home, "transaction-1", {
      initialAfterOperation: 1,
      recoveryAfterOperation: 1
    }),
    (error) => error.name === "DomainTransactionRecoveryError"
  );

  const replayed = recovery.replayPendingDomainTransactions(home);

  assert.deepEqual(replayed, ["transaction-1"]);
  assert.equal(readFileSync(first, "utf8"), "new task\n");
  assert.equal(readFileSync(second, "utf8"), "new info\n");
  assert.equal(existsSync(removed), false);
  assert.deepEqual(readdirSync(join(home, "runtime", "domain-transactions")), []);
});

test("commits command mutations and the cached RPC result as one domain transaction", async () => {
  const home = createConfiguredHome();
  const transactions = await import("../dist/storage/domainTransaction.js");
  const resultFile = join(home, "runtime", "rpc-results", "create-request.json");

  const output = transactions.executeDomainTransaction(
    home,
    "create-request",
    (workingRoot) => {
      const info = join(workingRoot, "tasks", "task-1", "info.json");
      const runtime = join(workingRoot, "tasks", "task-1", "task.json");
      mkdirSync(join(workingRoot, "tasks", "task-1"), { recursive: true });
      writeFileSync(info, `${JSON.stringify({ schemaVersion: 1, title: "Transactional task" })}\n`);
      writeFileSync(runtime, `${JSON.stringify({
        schemaVersion: 1,
        archived: false,
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z"
      })}\n`);
      return "Created task task-1\n";
    },
    (result) => [{
      type: "write",
      target: resultFile,
      content: `${JSON.stringify({ requestId: "create-request", result: { output: result } }, null, 2)}\n`
    }]
  );

  assert.equal(output, "Created task task-1\n");
  assert.equal(JSON.parse(readFileSync(join(home, "tasks", "task-1", "info.json"), "utf8")).title, "Transactional task");
  assert.equal(JSON.parse(readFileSync(resultFile, "utf8")).result.output, "Created task task-1\n");
  assert.deepEqual(readdirSync(join(home, "runtime", "domain-transactions")), []);
});

test("rebuilds the deletable SQLite index from authoritative task files", async () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Index this mission"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "work-item", "create", "task-1", "--title", "Index finite work", "--assignee", "leader"],
    { TASKMUX_HOME: home }
  );
  const { FileTaskStore } = await import("../dist/storage/taskStore.js");
  const { rebuildDerivedIndex } = await import("../dist/storage/derivedIndex.js");
  const { default: Database } = await import("better-sqlite3");
  const indexFile = join(home, "runtime", "index.sqlite");

  rebuildDerivedIndex(home, new FileTaskStore(home));
  let database = new Database(indexFile, { readonly: true });
  assert.deepEqual(database.prepare("SELECT id, title, archived FROM tasks").get(), {
    id: "task-1", title: "Index this mission", archived: 0
  });
  assert.deepEqual(database.prepare("SELECT task_id, name FROM roles").get(), {
    task_id: "task-1", name: "leader"
  });
  assert.deepEqual(database.prepare("SELECT task_id, id, status FROM work_items").get(), {
    task_id: "task-1", id: "work-item-1", status: "pending"
  });
  database.close();

  unlinkSync(indexFile);
  rebuildDerivedIndex(home, new FileTaskStore(home));
  database = new Database(indexFile, { readonly: true });
  assert.equal(database.prepare("SELECT count(*) AS count FROM tasks").get().count, 1);
  database.close();
});

test("creates tasks with task board metadata", () => {
  const home = createConfiguredHome();

  const output = runTaskmux(
    [
      "task",
      "create",
      "Refactor login page",
      "--description",
      "Update the auth form",
      "--priority",
      "high",
      "--tag",
      "frontend",
      "--tag",
      "auth",
      "--due",
      "2026-07-01"
    ],
    { TASKMUX_HOME: home }
  );
  const taskInfo = JSON.parse(readFileSync(join(home, "tasks", "task-1", "info.json"), "utf8"));
  const showOutput = runTaskmux(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Created task task-1: Refactor login page/);
  assert.equal(taskInfo.description, "Update the auth form");
  assert.equal(taskInfo.priority, "high");
  assert.deepEqual(taskInfo.tags, ["frontend", "auth"]);
  assert.equal(taskInfo.dueAt, "2026-07-01");
  assert.match(showOutput, /Description: Update the auth form/);
  assert.match(showOutput, /Priority: high/);
  assert.match(showOutput, /Tags: frontend, auth/);
  assert.match(showOutput, /Due: 2026-07-01/);
});

test("stores defaults and creates templated tasks with default roles", () => {
  const home = createConfiguredHome();

  runTaskmux(["config", "set", "default-agent", "codex"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["config", "set", "default-workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["task", "create", "Build export flow", "--template", "feature"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Created task task-1: Build export flow/);
  assert.match(output, /Template: feature/);
  assert.match(output, /Assigned roles: leader, rd, reviewer/);

  const task = runTaskmux(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });
  assert.match(task, /Priority: medium/);
  assert.match(task, /Tags: feature/);

  const roles = runTaskmux(["task", "roles", "task-1"], {
    TASKMUX_HOME: home
  });
  assert.match(roles, tableCellsRegex("leader", "codex", "idle", "/tmp/project-a"));
  assert.match(roles, tableCellsRegex("rd", "codex", "idle", "/tmp/project-a"));
  assert.match(roles, tableCellsRegex("reviewer", "codex", "idle", "/tmp/project-a"));

  const config = runTaskmux(["config", "show"], {
    TASKMUX_HOME: home
  });
  assert.match(config, tableRowRegex("default-agent", "configured", "agent=codex; command=codex"));
  assert.match(config, tableRowRegex("default-workspace", "configured", "/tmp/project-a"));
});

test("shows configuration pointers in one ordered table", () => {
  const home = createConfiguredHome();

  runTaskmux(["role", "add", "operator", "--agent", "codex", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["role", "add", "leader", "--agent", "codex", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["config", "show"], { TASKMUX_HOME: home });

  assert.equal(output.match(/^TaskMux config$/gm)?.length, 1);
  assert.doesNotMatch(output, /^Default agent:/m);
  assert.doesNotMatch(output, /^Default workspace:/m);
  assert.doesNotMatch(output, /^Current task:/m);
  assert.doesNotMatch(output, /^Last task:/m);
  assert.doesNotMatch(output, /^Status$/m);
  assert.deepEqual(configTableItems(output), [
    "default-agent",
    "default-workspace",
    "current-task",
    "last-task",
    "role:operator",
    "role:leader"
  ]);
  assert.match(output, tableRowRegex("default-agent", "configured", "agent=codex; command=codex"));
  assert.match(output, tableRowRegex("default-workspace", "configured", "/tmp/project-a"));
  assert.match(output, tableRowRegex("current-task", "unset", "\\s*\\|"));
  assert.match(output, tableRowRegex("last-task", "unset", "\\s*\\|"));
});

test("shows a shared system-role workspace only on its owner row", () => {
  const home = createConfiguredHome();

  runTaskmux(["role", "add", "operator", "--agent", "codex", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["role", "add", "leader", "--agent", "codex", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["config", "show"], { TASKMUX_HOME: home });

  assert.match(output, tableRowRegex("role:operator", "configured", "agent=codex\\s+\\|"));
  assert.match(output, tableRowRegex("role:leader", "configured", "agent=codex\\s+\\|"));
  assert.doesNotMatch(output, /role:(?:operator|leader)[^\n]*workspace=/);
});

test("shows only system-role workspace overrides when a default exists", () => {
  const home = createConfiguredHome();

  runTaskmux(["role", "add", "operator", "--agent", "codex", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["role", "add", "leader", "--agent", "codex", "--workspace", "/tmp/project-b"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["config", "show"], { TASKMUX_HOME: home });

  assert.match(output, tableRowRegex("role:operator", "configured", "agent=codex\\s+\\|"));
  assert.match(output, tableRowRegex("role:leader", "configured", "agent=codex; workspace=/tmp/project-b"));
});

test("keeps system-role workspaces visible when the default workspace is missing", () => {
  const home = createTaskmuxHome();

  addAgent(home, "codex", "codex");
  runTaskmux(["config", "set", "default-agent", "codex"], { TASKMUX_HOME: home });
  runTaskmux(["role", "add", "operator", "--agent", "codex", "--workspace", "/tmp/operator"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["role", "add", "leader", "--agent", "codex", "--workspace", "/tmp/leader"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["config", "show"], { TASKMUX_HOME: home });

  assert.match(output, tableRowRegex("default-workspace", "missing", "taskmux config set default-workspace <path>"));
  assert.match(output, tableRowRegex("role:operator", "configured", "agent=codex; workspace=/tmp/operator"));
  assert.match(output, tableRowRegex("role:leader", "configured", "agent=codex; workspace=/tmp/leader"));
});

test("shows configured current and last task pointers as set", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "First task"], { TASKMUX_HOME: home });
  runTaskmux(["task", "create", "Second task"], { TASKMUX_HOME: home });
  runTaskmux(["task", "current", "task-1"], { TASKMUX_HOME: home });
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  writeFileSync(join(home, "config.json"), `${JSON.stringify({ ...config, lastTaskId: "task-2" }, null, 2)}\n`);

  const output = runTaskmux(["config", "show"], { TASKMUX_HOME: home });

  assert.match(output, tableRowRegex("current-task", "set", "task-1"));
  assert.match(output, tableRowRegex("last-task", "set", "task-2"));
});

test("preserves missing and invalid configuration diagnostics in the table", () => {
  const home = createTaskmuxHome();

  ensureTestStorageSchema(home);
  runTaskmux(["config", "set", "default-agent", "missing-agent"], { TASKMUX_HOME: home });

  const output = runTaskmux(["config", "show"], { TASKMUX_HOME: home });

  assert.match(output, tableRowRegex("default-agent", "invalid", "missing-agent is not configured"));
  assert.match(
    output,
    tableRowRegex("default-workspace", "missing", "taskmux config set default-workspace <path>")
  );
  assert.match(
    output,
    tableRowRegex("role:operator", "missing", "Run taskmux setup in an interactive terminal\\.")
  );
  assert.match(
    output,
    tableRowRegex("role:leader", "missing", "Run taskmux setup in an interactive terminal\\.")
  );
});

test("preserves unavailable default-agent command diagnostics in the table", () => {
  const home = createTaskmuxHome();
  const missingPath = join(home, "missing-agent-command");

  addAgent(home, "path-agent", missingPath);
  addAgent(home, "name-agent", "taskmux-missing-agent-cli");
  runTaskmux(["config", "set", "default-agent", "path-agent"], { TASKMUX_HOME: home });

  const missingPathOutput = runTaskmux(["config", "show"], { TASKMUX_HOME: home });

  assert.match(
    missingPathOutput,
    tableRowRegex("default-agent", "configured", "agent=path-agent;")
  );
  assert.match(missingPathOutput, new RegExp(`command=${escapeRegex(missingPath)}; missing`));

  runTaskmux(["config", "set", "default-agent", "name-agent"], { TASKMUX_HOME: home });

  const missingNameOutput = runTaskmux(["config", "show"], { TASKMUX_HOME: home });

  assert.match(
    missingNameOutput,
    tableRowRegex("default-agent", "configured", "agent=name-agent;")
  );
  assert.equal(
    configTableRows(missingNameOutput).find(([item]) => item === "default-agent")?.[2],
    "agent=name-agent; command=taskmux-missing-agent-cli; not found in PATH"
  );
});

test("keeps a wrapped shared workspace only on the default-workspace row", () => {
  const home = createConfiguredHome();
  const workspace = `/tmp/${"shared-workspace-segment-".repeat(6)}`;

  runTaskmux(["config", "set", "default-workspace", workspace], { TASKMUX_HOME: home });
  runTaskmux(["role", "add", "operator", "--agent", "codex", "--workspace", workspace], {
    TASKMUX_HOME: home
  });
  runTaskmux(["role", "add", "leader", "--agent", "codex", "--workspace", workspace], {
    TASKMUX_HOME: home
  });

  const rows = configTableRows(runTaskmux(["config", "show"], { TASKMUX_HOME: home }));

  assert.equal(rows.find(([item]) => item === "default-workspace")?.[2], workspace);
  assert.equal(rows.find(([item]) => item === "role:operator")?.[2], "agent=codex");
  assert.equal(rows.find(([item]) => item === "role:leader")?.[2], "agent=codex");
});

test("wraps the single config table in the existing JSON success envelope", () => {
  const home = createConfiguredHome();
  const response = JSON.parse(runTaskmux(["config", "show", "--json"], { TASKMUX_HOME: home }));

  assert.equal(response.ok, true);
  assert.deepEqual(configTableItems(response.output), [
    "default-agent",
    "default-workspace",
    "current-task",
    "last-task",
    "role:operator",
    "role:leader"
  ]);
  assert.doesNotMatch(response.output, /^Default agent:/m);
  assert.doesNotMatch(response.output, /^Default workspace:/m);
});

test("tracks current and last tasks for shorter workflows", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "First task"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "create", "Second task"], {
    TASKMUX_HOME: home
  });

  assert.match(runTaskmux(["task", "last"], { TASKMUX_HOME: home }), /task-2 Second task/);

  const setCurrent = runTaskmux(["task", "current", "task-1"], {
    TASKMUX_HOME: home
  });
  assert.match(setCurrent, /Current task: task-1/);
  assert.match(runTaskmux(["task", "current"], { TASKMUX_HOME: home }), /task-1 First task/);
});

test("clones tasks with metadata and roles", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Original task", "--priority", "high", "--tag", "frontend", "--due", "2026-09-01"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "assign", "task-1", "rd", "--agent", "codex", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["task", "clone", "task-1", "--title", "Cloned task"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Cloned task task-1 -> task-2/);

  const task = runTaskmux(["task", "show", "task-2"], {
    TASKMUX_HOME: home
  });
  assert.match(task, /Title: Cloned task/);
  assert.match(task, /Priority: high/);
  assert.match(task, /Tags: frontend/);
  assert.match(task, /Due: 2026-09-01/);

  const roles = runTaskmux(["task", "roles", "task-2"], {
    TASKMUX_HOME: home
  });
  assert.match(roles, tableCellsRegex("rd", "codex", "idle", "/tmp/project-a"));
});

test("updates task board metadata", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(
    [
      "task",
      "update",
      "task-1",
      "--title",
      "Refactor checkout page",
      "--description",
      "Coordinate UI and validation work",
      "--priority",
      "urgent",
      "--tag",
      "checkout",
      "--tag",
      "blocked",
      "--due",
      "2026-08-02"
    ],
    { TASKMUX_HOME: home }
  );
  const showOutput = runTaskmux(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Updated task task-1/);
  assert.match(showOutput, /Title: Refactor checkout page/);
  assert.match(showOutput, /Description: Coordinate UI and validation work/);
  assert.match(showOutput, /Priority: urgent/);
  assert.match(showOutput, /Tags: checkout, blocked/);
  assert.match(showOutput, /Due: 2026-08-02/);
});

test("clears task board metadata", () => {
  const home = createConfiguredHome();

  runTaskmux(
    [
      "task",
      "create",
      "Refactor login page",
      "--description",
      "Update the auth form",
      "--priority",
      "high",
      "--tag",
      "frontend",
      "--due",
      "2026-07-01"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(
    [
      "task",
      "update",
      "task-1",
      "--clear-description",
      "--clear-priority",
      "--clear-tags",
      "--clear-due"
    ],
    { TASKMUX_HOME: home }
  );
  const showOutput = runTaskmux(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });
  const taskInfo = JSON.parse(readFileSync(join(home, "tasks", "task-1", "info.json"), "utf8"));

  assert.match(output, /Updated task task-1/);
  assert.equal(taskInfo.title, "Refactor login page");
  assert.equal(taskInfo.description, undefined);
  assert.equal(taskInfo.priority, undefined);
  assert.equal(taskInfo.tags, undefined);
  assert.equal(taskInfo.dueAt, undefined);
  assert.doesNotMatch(showOutput, /Description:/);
  assert.doesNotMatch(showOutput, /Priority:/);
  assert.doesNotMatch(showOutput, /Tags:/);
  assert.doesNotMatch(showOutput, /Due:/);
});

test("filters and searches tasks on board metadata", () => {
  const home = createConfiguredHome();

  runTaskmux(
    ["task", "create", "Refactor login page", "--tag", "frontend", "--priority", "high"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "create", "Write release docs", "--tag", "docs", "--priority", "medium"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "create", "Fix auth token bug", "--tag", "backend", "--priority", "urgent"],
    { TASKMUX_HOME: home }
  );

  const frontendOutput = runTaskmux(["task", "list", "--tag", "frontend"], { TASKMUX_HOME: home });
  const tagOutput = runTaskmux(["task", "list", "--tag", "docs"], { TASKMUX_HOME: home });
  const priorityOutput = runTaskmux(["task", "list", "--priority", "urgent"], { TASKMUX_HOME: home });
  const searchOutput = runTaskmux(["task", "list", "--search", "release"], { TASKMUX_HOME: home });

  assert.match(frontendOutput, /Refactor login page/);
  assert.doesNotMatch(frontendOutput, /Fix auth token bug/);
  assert.doesNotMatch(frontendOutput, /Write release docs/);
  assert.match(tagOutput, /Write release docs/);
  assert.doesNotMatch(tagOutput, /Refactor login page/);
  assert.match(priorityOutput, /Fix auth token bug/);
  assert.doesNotMatch(priorityOutput, /Refactor login page/);
  assert.match(searchOutput, /Write release docs/);
  assert.doesNotMatch(searchOutput, /Fix auth token bug/);
});

test("renders a grouped task board with metadata filters", () => {
  const home = createConfiguredHome();

  runTaskmux(
    ["task", "create", "Plan checkout work", "--tag", "frontend", "--priority", "high"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "create", "Implement checkout work", "--tag", "frontend", "--priority", "urgent"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "create", "Write rollout notes", "--tag", "docs", "--priority", "medium"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "archive", "task-3"], { TASKMUX_HOME: home });

  const output = runTaskmux(["task", "board", "--tag", "frontend"], { TASKMUX_HOME: home });

  assert.match(output, /Ongoing/);
  assert.match(output, tableCellsRegex("Ongoing", "task-1", "Plan checkout work", "priority=high tags=frontend"));
  assert.match(output, tableCellsRegex("Ongoing", "task-2", "Implement checkout work", "priority=urgent tags=frontend"));
  assert.doesNotMatch(output, /Write rollout notes/);
  assert.match(output, /Archived/);
});

test("renders role status counts on the grouped task board", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Coordinate checkout flow"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "assign", "task-1", "rd", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "claude", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  const output = runTaskmux(["task", "board", "--with-roles"], { TASKMUX_HOME: home });

  assert.match(output, tableCellsRegex("Ongoing", "task-1", "Coordinate checkout flow", "", "", "roles idle=3"));
});

test("deletes and restores tasks without losing task data", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page", "--due", "2026-07-01"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "comment", "task-1", "Keep task data."], {
    TASKMUX_HOME: home
  });

  const deleteOutput = runTaskmux(["task", "delete", "task-1"], {
    TASKMUX_HOME: home
  });
  const listOutput = runTaskmux(["task", "list"], { TASKMUX_HOME: home });
  const missingShow = runTaskmuxFailure(["task", "show", "task-1"], { TASKMUX_HOME: home });

  assert.match(deleteOutput, /Deleted task task-1/);
  assert.match(listOutput, /No tasks found/);
  assert.equal(missingShow.status, 3);
  assert.equal(existsSync(join(home, "trash", "tasks", "task-1", "info.json")), true);

  const restoreOutput = runTaskmux(["task", "restore", "task-1"], {
    TASKMUX_HOME: home
  });
  const showOutput = runTaskmux(["task", "show", "task-1"], { TASKMUX_HOME: home });
  const commentsOutput = runTaskmux(["task", "comments", "task-1"], { TASKMUX_HOME: home });

  assert.match(restoreOutput, /Restored task task-1/);
  assert.match(showOutput, /Due: 2026-07-01/);
  assert.match(commentsOutput, /Keep task data/);
});

test("rejects task records with inline titles", () => {
  const home = createConfiguredHome();
  const taskDir = join(home, "tasks", "task-1");
  execFileSync("mkdir", ["-p", taskDir]);
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "task-1",
      title: "Legacy task title",
      archived: false,
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z"
    })
  );

  const result = runTaskmuxFailure(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid task record: task-1/);
});

test("rejects task records that use the removed status field", () => {
  const home = createConfiguredHome();
  const taskDir = join(home, "tasks", "task-1");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({
    schemaVersion: 1,
    id: "task-1",
    status: "open",
    createdAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:00:00.000Z"
  }));
  writeFileSync(join(taskDir, "info.json"), JSON.stringify({
    schemaVersion: 1,
    title: "Removed status field"
  }));

  const result = runTaskmuxFailure(["task", "show", "task-1"], { TASKMUX_HOME: home });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid task record: task-1/);
});

test("rejects task records missing editable task info", () => {
  const home = createConfiguredHome();
  const taskDir = join(home, "tasks", "task-1");
  execFileSync("mkdir", ["-p", taskDir]);
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "task-1",
      archived: false,
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z"
    })
  );

  const result = runTaskmuxFailure(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid task info record: task-1/);
});

test("lists tasks from the configured taskmux home", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "First task"], { TASKMUX_HOME: home });
  runTaskmux(["task", "create", "Second task"], { TASKMUX_HOME: home });

  const output = runTaskmux(["task", "list"], { TASKMUX_HOME: home });

  assert.match(output, tableCellsRegex("task-1", "ongoing", "First task"));
  assert.match(output, tableCellsRegex("task-2", "ongoing", "Second task"));
});

test("shows a task by id", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Review checkout flow"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Task: task-1/);
  assert.match(output, /Title: Review checkout flow/);
  assert.match(output, /Archived: no/);
});

test("returns stable JSON envelopes for generic command success and failure", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Read JSON output"], { TASKMUX_HOME: home });
  const success = JSON.parse(
    runTaskmux(["task", "show", "task-1", "--json"], { TASKMUX_HOME: home })
  );
  const failed = runTaskmuxFailure(
    ["task", "show", "task-999", "--json"],
    { TASKMUX_HOME: home }
  );
  const error = JSON.parse(failed.stderr);

  assert.equal(success.ok, true);
  assert.match(success.output, /Task: task-1/);
  assert.equal(error.ok, false);
  assert.equal(error.code, "TASK_NOT_FOUND");
  assert.match(error.message, /task-999/);
});

test("preserves structured CLI errors across the Controller RPC boundary", () => {
  const home = createConfiguredHome();
  const env = { TASKMUX_HOME: home, TASKMUX_CONTROLLER_MODE: "auto" };

  try {
    const failed = runTaskmuxFailure(["task", "show", "task-999", "--json"], env);
    const error = JSON.parse(failed.stderr);

    assert.equal(failed.status, 3);
    assert.equal(error.code, "TASK_NOT_FOUND");
    assert.match(error.message, /task-999/);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("updates the task archive marker", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Review checkout flow"], {
    TASKMUX_HOME: home
  });

  assert.match(
    runTaskmux(["task", "archive", "task-1"], { TASKMUX_HOME: home }),
    /Archived task task-1/
  );
  assert.match(
    runTaskmux(["task", "unarchive", "task-1"], { TASKMUX_HOME: home }),
    /Unarchived task task-1/
  );

  const task = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8")
  );
  assert.equal(task.status, undefined);
  assert.equal(task.archived, false);
});

test("persists an archive summary and discards stale automatic wakeups", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Archive a completed phase"], { TASKMUX_HOME: home });
  runTaskmux(["task", "wake", "task-1", "--reason", "old-trigger"], { TASKMUX_HOME: home });
  runTaskmux(
    [
      "task", "archive", "task-1",
      "--reason", "Current phase has reached a stable point",
      "--summary", "Canary is complete; revisit when production traffic increases."
    ],
    { TASKMUX_HOME: home }
  );
  const archived = JSON.parse(readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8"));

  assert.equal(archived.archived, true);
  assert.equal(archived.archiveReason, "Current phase has reached a stable point");
  assert.match(archived.archiveSummary, /Canary is complete/);
  assert.match(archived.archivedAt, /^\d{4}-/);
  assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), false);
  runTaskmux(["task", "comment", "task-1", "Keep this note for reactivation."], { TASKMUX_HOME: home });
  assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), false);

  runTaskmux(["task", "unarchive", "task-1"], { TASKMUX_HOME: home });
  const active = JSON.parse(readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8"));
  assert.equal(active.archived, false);
  assert.equal(active.archivedAt, undefined);
  assert.equal(active.archiveReason, undefined);
  assert.equal(active.archiveSummary, undefined);
});

test("keeps a task long-lived until it is explicitly archived", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Maintain the daily deployment check"], {
    TASKMUX_HOME: home
  });
  let task = JSON.parse(readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8"));
  assert.equal(task.archived, false);

  runTaskmux(["task", "archive", "task-1"], { TASKMUX_HOME: home });
  task = JSON.parse(readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8"));
  assert.equal(task.archived, true);

  const output = runTaskmux(["task", "unarchive", "task-1"], { TASKMUX_HOME: home });
  task = JSON.parse(readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8"));
  assert.match(output, /Unarchived task task-1/);
  assert.equal(task.archived, false);
});

test("does not expose a ticket-style done transition for Tasks", () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Continue improving deployments"], { TASKMUX_HOME: home });

  const result = runTaskmuxFailure(["task", "done", "task-1"], { TASKMUX_HOME: home });
  const task = JSON.parse(readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8"));

  assert.equal(result.status, 2);
  assert.match(result.stderr, /^USAGE_ERROR: Unknown command: task done\n\nTaskMux task\n/);
  assert.equal(task.status, undefined);
  assert.equal(task.archived, false);
});

test("assigns a role to an existing task", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  assert.match(output, /Assigned role rd to task-1/);
  assert.match(output, /Agent: codex/);
  assert.match(output, /Workspace: \/tmp\/project-a/);

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  const roleInfo = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "info.json"), "utf8")
  );

  assert.equal(role.schemaVersion, 2);
  assert.equal(role.name, undefined);
  assert.equal(role.activeAgentId, "codex");
  assert.deepEqual(role.agentBindings.codex, {
    agentId: "codex",
    adapterId: "codex",
    config: { adapterId: "codex" }
  });
  assert.equal(role.workspace, "/tmp/project-a");
  assert.equal(role.status, "idle");
  assert.equal(roleInfo.schemaVersion, 1);
  assert.equal(roleInfo.name, "rd");
});

test("assigns multiple roles with one command", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Coordinate release"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(
    [
      "task",
      "assign-many",
      "task-1",
      "--role",
      "rd",
      "--role",
      "reviewer",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  assert.match(output, /Assigned roles to task-1: rd, reviewer/);

  const roles = runTaskmux(["task", "roles", "task-1"], {
    TASKMUX_HOME: home
  });
  assert.match(roles, tableCellsRegex("rd", "codex", "idle", "/tmp/project-a"));
  assert.match(roles, tableCellsRegex("reviewer", "codex", "idle", "/tmp/project-a"));
});

test("reads edited role info from the user-editable info file", async () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  writeFileSync(
    join(home, "tasks", "task-1", "roles", "rd", "info.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "rd",
      description: "Owns the frontend implementation."
    })
  );

  const rolesOutput = runTaskmux(["task", "roles", "task-1"], {
    TASKMUX_HOME: home
  });
  const detailOutput = runTaskmux(["task", "detail", "task-1", "rd"], {
    TASKMUX_HOME: home
  });
  const { FileTaskStore } = await import("../dist/storage/taskStore.js");

  assert.match(rolesOutput, tableCellsRegex("rd", "codex", "idle", "/tmp/project-a"));
  assert.match(detailOutput, /Role: rd/);
  assert.equal(
    new FileTaskStore(home).getRole("task-1", "rd")?.description,
    "Owns the frontend implementation."
  );
});

test("rejects role records with inline names", () => {
  const home = createConfiguredHome();
  const taskDir = join(home, "tasks", "task-1");
  const roleDir = join(taskDir, "roles", "rd");
  execFileSync("mkdir", ["-p", roleDir]);
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "task-1",
      archived: false,
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z"
    })
  );
  writeFileSync(
    join(taskDir, "info.json"),
    JSON.stringify({
      schemaVersion: 1,
      title: "Current task title"
    })
  );
  writeFileSync(
    join(roleDir, "role.json"),
    JSON.stringify({ ...taskRoleRuntimeFixture(), name: "rd" })
  );

  const result = runTaskmuxFailure(["task", "detail", "task-1", "rd"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid role record: rd/);
});

test("rejects role records missing editable role info", () => {
  const home = createConfiguredHome();
  const taskDir = join(home, "tasks", "task-1");
  const roleDir = join(taskDir, "roles", "rd");
  execFileSync("mkdir", ["-p", roleDir]);
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "task-1",
      archived: false,
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z"
    })
  );
  writeFileSync(
    join(taskDir, "info.json"),
    JSON.stringify({
      schemaVersion: 1,
      title: "Current task title"
    })
  );
  writeFileSync(
    join(roleDir, "role.json"),
    JSON.stringify(taskRoleRuntimeFixture())
  );

  const result = runTaskmuxFailure(["task", "detail", "task-1", "rd"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid role info record: rd/);
});

test("rejects role records missing Agent bindings", () => {
  const home = createConfiguredHome();
  const taskDir = join(home, "tasks", "task-1");
  const roleDir = join(taskDir, "roles", "rd");
  execFileSync("mkdir", ["-p", roleDir]);
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "task-1",
      archived: false,
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z"
    })
  );
  writeFileSync(
    join(taskDir, "info.json"),
    JSON.stringify({
      schemaVersion: 1,
      title: "Current task title"
    })
  );
  writeFileSync(
    join(roleDir, "role.json"),
    JSON.stringify({ ...taskRoleRuntimeFixture(), agentBindings: {} })
  );
  writeFileSync(
    join(roleDir, "info.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "rd"
    })
  );

  const result = runTaskmuxFailure(["task", "detail", "task-1", "rd"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid role record: rd/);
});

test("rejects unsupported role agents", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const result = runTaskmuxFailure(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "unknown",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE_ERROR: Unsupported agent: unknown/);
  assert.match(result.stderr, /Supported agents: (codex, claude|claude, codex)/);
});

test("returns a usage exit code for unsupported agents", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const result = runTaskmuxFailure(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "unknown",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE_ERROR: Unsupported agent: unknown/);
});

test("lists roles for a task", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "reviewer",
      "--agent",
      "claude",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "roles", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, tableCellsRegex("rd", "codex", "idle", "/tmp/project-a"));
  assert.match(output, tableCellsRegex("reviewer", "claude", "idle", "/tmp/project-a"));
});

test("updates role workspace without changing its Agent contract", () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    ["task", "assign", "task-1", "rd", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  const roleFile = join(home, "tasks", "task-1", "roles", "rd", "role.json");
  const originalRole = JSON.parse(readFileSync(roleFile, "utf8"));

  const output = runTaskmux(
    ["task", "role", "update", "task-1", "rd", "--workspace", "/tmp/project-b"],
    { TASKMUX_HOME: home }
  );
  const detailOutput = runTaskmux(["task", "detail", "task-1", "rd"], {
    TASKMUX_HOME: home
  });
  const role = JSON.parse(readFileSync(roleFile, "utf8"));

  assert.match(output, /Updated role rd for task-1/);
  assert.match(detailOutput, /Agent: codex/);
  assert.match(detailOutput, /Workspace: \/tmp\/project-b/);
  assert.equal(role.schemaVersion, 2);
  assert.equal(role.activeAgentId, "codex");
  assert.deepEqual(role.agentBindings, originalRole.agentBindings);
  assert.equal(role.workspace, "/tmp/project-b");
});

test("switches a task role to another bound Agent while preserving its original binding", () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Switch role agent"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "session", "record", "task-1", "reviewer", "--native-id", "dormant-codex-session"],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(
    ["task", "role", "update", "task-1", "reviewer", "--agent", "claude"],
    { TASKMUX_HOME: home }
  );
  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "reviewer", "role.json"), "utf8")
  );
  const sessions = taskRoleSessionSet(home, "task-1", "reviewer");

  assert.match(output, /Updated role reviewer for task-1/);
  assert.equal(role.schemaVersion, 2);
  assert.equal(role.activeAgentId, "claude");
  assert.deepEqual(Object.keys(role.agentBindings).sort(), ["claude", "codex"]);
  assert.deepEqual(role.agentBindings.codex, {
    agentId: "codex",
    adapterId: "codex",
    config: { adapterId: "codex" }
  });
  assert.deepEqual(role.agentBindings.claude, {
    agentId: "claude",
    adapterId: "claude",
    config: { adapterId: "claude" }
  });
  assert.equal(sessions.schemaVersion, 3);
  assert.equal(sessions.activeAgentId, "claude");
  assert.equal(sessions.sessions.codex.nativeSessionId, "dormant-codex-session");
});

test("switches back to a dormant bound Agent without losing either native session", () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Keep per-Agent role sessions"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "session", "record", "task-1", "reviewer", "--native-id", "codex-review-session"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "role", "update", "task-1", "reviewer", "--agent", "claude"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    ["task", "session", "record", "task-1", "reviewer", "--native-id", "claude-review-session"],
    { TASKMUX_HOME: home }
  );
  const output = runTaskmux(["task", "role", "update", "task-1", "reviewer", "--agent", "codex"], {
    TASKMUX_HOME: home
  });
  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "reviewer", "role.json"), "utf8")
  );
  const sessionSet = taskRoleSessionSet(home, "task-1", "reviewer");

  assert.match(output, /Updated role reviewer for task-1/);
  assert.equal(role.schemaVersion, 2);
  assert.equal(role.activeAgentId, "codex");
  assert.deepEqual(Object.keys(role.agentBindings).sort(), ["claude", "codex"]);
  assert.equal(sessionSet.schemaVersion, 3);
  assert.equal(sessionSet.activeAgentId, "codex");
  assert.equal(sessionSet.sessions.codex.nativeSessionId, "codex-review-session");
  assert.equal(sessionSet.sessions.claude.nativeSessionId, "claude-review-session");
});

test("renames an idle role without creating a tmux window", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createStatefulTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    ["task", "assign", "task-1", "rd", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "role", "rename", "task-1", "rd", "developer"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });
  const rolesOutput = runTaskmux(["task", "roles", "task-1"], {
    TASKMUX_HOME: home
  });
  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.match(output, /Renamed role rd to developer for task-1/);
  assert.match(rolesOutput, tableCellsRegex("developer", "codex", "idle", "/tmp/project-a"));
  assert.doesNotMatch(rolesOutput, /rd\s+codex/);
  assert.ok(calls.some((call) => (
    call[0] === "has-session" &&
    call.at(-1) === tmuxTarget(home, "task-1", "rd").split(":")[0]
  )));
  assert.equal(calls.some((call) => call[0] === "rename-window"), false);
});

test("rejects renaming the built-in leader role", () => {
  const home = createConfiguredHome();
  const leaderCli = createFakeExecutable(home, "leader-agent.js", "leader agent 1.0\n");

  addAgent(home, "leader-cli", leaderCli);
  runTaskmux(["task", "create", "Refactor login page", "--agent", "leader-cli", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });

  const result = runTaskmuxFailure(["task", "role", "rename", "task-1", "leader", "developer"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE_ERROR: Built-in leader role cannot be renamed/);
});

test("enters a role through tmux without requiring real tmux", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile, carrierLogFile } = createFakeTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    CODEX_THREAD_ID: "codex-rd-session"
  };

  runTaskmux(["task", "create", "Refactor login page"], env);
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    env
  );

  const missingNativeIdentity = runTaskmuxFailure(["task", "enter", "task-1", "rd"], env);
  assert.equal(missingNativeIdentity.status, 2);
  assert.match(
    missingNativeIdentity.stderr,
    /must establish its native session through task dispatch/
  );

  runTaskmux(
    ["task", "dispatch", "task-1", "rd", "--mode", "new", "--input", "Begin implementation"],
    env
  );
  const dispatchCarrier = fakeCarrierCalls(carrierLogFile).at(-1);
  assert.ok(dispatchCarrier);
  const registrationEnv = fakeCarrierEnvironment(dispatchCarrier);
  runTaskmux(
    ["task", "session", "record", "task-1", "rd", "--native-id", "codex-rd-session"],
    { ...env, ...registrationEnv }
  );

  const output = runTaskmux(["task", "enter", "task-1", "rd"], env);

  assert.match(output, /Attached role rd for task-1/);

  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  const sessionName = taskmuxTmuxSessionName(home, "task-1");
  const roleTarget = taskmuxTmuxTarget(home, "task-1", "rd");
  assert.ok(calls.some((call) => call[0] === "new-session" && call.at(-1) === sessionName));
  assert.ok(calls.filter((call) => call[0] === "new-window").length >= 2);
  for (const call of calls.filter((call) => call[0] === "new-window")) {
    assertPrivateCarrierWindow(call);
  }
  assert.ok(calls.some((call) => call[0] === "attach-session" && call.at(-1) === roleTarget));

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.status, "running");
});

test("tails role output through tmux capture-pane", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Review checkout flow"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "reviewer",
      "--agent",
      "claude",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "tail", "task-1", "reviewer"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  assert.match(output, /recent reviewer output/);

  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.deepEqual(calls[0], [
    "capture-pane",
    "-p",
    "-t",
    tmuxTarget(home, "task-1", "reviewer"),
    "-S",
    "-80"
  ]);
});

test("shows role detail for a task", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "detail", "task-1", "rd"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Task: task-1/);
  assert.match(output, /Role: rd/);
  assert.match(output, /Agent: codex/);
  assert.match(output, /Workspace: \/tmp\/project-a/);
  assert.match(output, /Status: idle/);
  assert.match(output, /Tmux: taskmux-task-1:rd/);
});

test("reads role transcript through tmux capture-pane", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Review checkout flow"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "reviewer",
      "--agent",
      "claude",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "transcript", "task-1", "reviewer"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  assert.match(output, /recent reviewer output/);
  assert.match(
    readFileSync(
      join(home, "tasks", "task-1", "roles", "reviewer", "transcript.log"),
      "utf8"
    ),
    /recent reviewer output/
  );
}
);

test("opens a task context summary", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "comment", "task-1", "Keep old session compatibility."], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["task", "open", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Task: task-1/);
  assert.match(output, /Title: Refactor login page/);
  assert.match(output, /Roles: 2/);
  assert.match(output, /Comments: 1/);
  assert.match(output, /Next: taskmux task enter task-1 <role>/);
});

test("includes schedules cycles work items milestones and sessions in task context", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Expose durable progress context"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "schedule", "set", "task-1", "--inactivity-minutes", "60", "--cooldown-minutes", "15"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "cycle", "create", "task-1", "--cause", "explicit-wake", "--summary", "Plan the release"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "work-item", "create", "task-1", "--title", "Run canary", "--cycle", "cycle-1"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "milestone", "add", "task-1", "--title", "Plan approved", "--summary", "Release plan is approved"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "session", "record", "task-1", "leader", "--native-id", "leader-session"],
    { TASKMUX_HOME: home }
  );

  const context = JSON.parse(
    runTaskmux(["task", "context", "task-1", "--format", "json"], { TASKMUX_HOME: home })
  );

  assert.equal(context.schedule.inactivityMinutes, 60);
  assert.deepEqual(context.cycles.map((cycle) => cycle.id), ["cycle-1"]);
  assert.deepEqual(context.workItems.map((item) => item.id), ["work-item-1"]);
  assert.deepEqual(context.milestones.map((milestone) => milestone.id), ["milestone-1"]);
  assert.equal(context.sessions.leader.sessions.codex.nativeSessionId, "leader-session");
});

test("exports transcripts in markdown and json formats", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const markdownPath = join(mkdtempSync(join(tmpdir(), "taskmux-transcript-")), "reviewer.md");

  runTaskmux(["task", "create", "Review checkout flow"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "claude", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "transcript", "task-1", "reviewer"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  const markdownOutput = runTaskmux(
    ["task", "transcript", "export", "task-1", "reviewer", "--format", "markdown", "--output", markdownPath],
    { TASKMUX_HOME: home }
  );
  assert.match(markdownOutput, /Exported transcript task-1 reviewer/);
  assert.match(readFileSync(markdownPath, "utf8"), /# Transcript task-1 reviewer/);
  assert.match(readFileSync(markdownPath, "utf8"), /recent reviewer output/);

  const jsonOutput = runTaskmux(
    ["task", "transcript", "export", "task-1", "reviewer", "--format", "json"],
    { TASKMUX_HOME: home }
  );
  const parsed = JSON.parse(jsonOutput);
  assert.equal(parsed.taskId, "task-1");
  assert.equal(parsed.role, "reviewer");
  assert.match(parsed.transcript, /recent reviewer output/);
});

test("renders role activity and task timeline", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Review checkout flow"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "assign", "task-1", "reviewer", "--agent", "claude", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "comment", "task-1", "Ready for review"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "transcript", "task-1", "reviewer"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  const activity = runTaskmux(["task", "activity", "task-1"], {
    TASKMUX_HOME: home
  });
  assert.match(activity, /Task activity: task-1/);
  assert.match(activity, tableCellsRegex("reviewer", "claude", "idle", "1"));

  const timeline = runTaskmux(["task", "timeline", "task-1"], {
    TASKMUX_HOME: home
  });
  assert.match(timeline, /task.created/);
  assert.match(timeline, /role.assigned/);
  assert.match(timeline, tableCellsRegex("comment", "comment-1", "Ready for review"));
});

test("renders a task handoff context as text", () => {
  const home = createConfiguredHome();

  runTaskmux(
    [
      "task",
      "create",
      "Refactor login page",
      "--description",
      "Update the auth form",
      "--priority",
      "high",
      "--tag",
      "frontend",
      "--due",
      "2026-07-01"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "comment", "task-1", "Keep old session compatibility."], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["task", "context", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Task Context/);
  assert.match(output, /Task: task-1/);
  assert.match(output, /Title: Refactor login page/);
  assert.match(output, /Description: Update the auth form/);
  assert.match(output, /Priority: high/);
  assert.match(output, /Tags: frontend/);
  assert.match(output, /Due: 2026-07-01/);
  assert.match(output, /Roles/);
  assert.match(output, tableCellsRegex("rd", "codex", "idle", "/tmp/project-a"));
  assert.match(output, /Comments/);
  assert.match(output, tableCellsRegex("comment-1", "Keep old session compatibility."));
  assert.match(output, /Events/);
  assert.match(output, /task.created/);
  assert.match(output, /comment.added/);
});

test("renders a task handoff context as json with stored transcripts", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Review checkout flow"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "reviewer",
      "--agent",
      "claude",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "comment", "task-1", "Check edge cases."], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "transcript", "task-1", "reviewer"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  const output = runTaskmux(["task", "context", "task-1", "--format", "json", "--include-transcripts"], {
    TASKMUX_HOME: home
  });
  const context = JSON.parse(output);

  assert.equal(context.task.id, "task-1");
  assert.equal(context.task.title, "Review checkout flow");
  const reviewerContext = context.roles.find((role) => role.name === "reviewer");
  assert.ok(reviewerContext);
  assert.equal(reviewerContext.transcript, "recent reviewer output\n");
  assert.equal(context.comments[0].body, "Check edge cases.");
  assert.equal(context.events[0].type, "task.created");
});

test("detaches a task role through tmux", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    TASKMUX_CONTROLLER_MODE: "auto"
  };

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  try {
    const output = runTaskmux(["task", "detach", "task-1", "rd"], env);

    assert.match(output, /Detached role rd for task-1/);

    const calls = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const recoveryProbe = ["has-session", "-t", taskmuxTmuxSessionName(home, "operator")];
    const detachCall = ["detach-client", "-s", taskmuxTmuxSessionName(home, "task-1")];
    const recoveryProbeIndex = calls.findIndex((call) => (
      JSON.stringify(call) === JSON.stringify(recoveryProbe)
    ));
    const detachCallIndex = calls.findIndex((call) => (
      JSON.stringify(call) === JSON.stringify(detachCall)
    ));

    assert.notEqual(recoveryProbeIndex, -1);
    assert.deepEqual(calls[recoveryProbeIndex], recoveryProbe);
    assert.equal(calls.some((call) => ["new-session", "new-window"].includes(call[0])), false);
    assert.notEqual(detachCallIndex, -1);
    assert.deepEqual(calls[detachCallIndex], detachCall);
    assert.ok(recoveryProbeIndex < detachCallIndex);

    const role = JSON.parse(
      readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
    );
    assert.equal(role.status, "detached");
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("shows role status", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "status", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: join(home, "missing-tmux")
  });

  assert.match(output, /Role: rd/);
  assert.match(output, /Status: idle/);
  assert.match(output, /Tmux: taskmux-task-1:rd/);
});

test("detects running role status from tmux", () => {
  const home = createConfiguredHome();
  const fakeTmux = createStatusTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "status", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, /Status: running/);

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.status, "running");
});

test("detects exited role status when tmux window is absent", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "status", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  assert.match(output, /Status: exited/);

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.status, "exited");
});

test("refreshes every role status for a task", () => {
  const home = createConfiguredHome();
  const fakeTmux = createStatusTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "reviewer",
      "--agent",
      "claude",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "refresh", "task-1"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, /Refreshed task task-1 roles/);
  assert.match(output, tableCellsRegex("rd", "running"));
  assert.match(output, tableCellsRegex("reviewer", "exited"));

  const rd = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  const reviewer = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "reviewer", "role.json"), "utf8")
  );
  assert.equal(rd.status, "running");
  assert.equal(reviewer.status, "exited");
});

test("restarts a role through tmux and updates status", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "session", "record", "task-1", "rd", "--native-id", "restart-session"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "kill", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  const output = runTaskmux(["task", "restart", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  assert.match(output, /Restarted role rd for task-1/);

  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const newWindow = calls.find((call) => call[0] === "new-window");
  assert.ok(newWindow);
  assert.equal(newWindow[newWindow.indexOf("-c") + 1], "/tmp/project-a");
  assert.deepEqual(newWindow.slice(-2, -1), ["/bin/sh"]);
  assert.match(newWindow.at(-1), /\.taskmux-launch-carriers-.*\/\.pending-launch-.*\/launch\.sh$/);
  assert.ok(calls.some((call) => (
    call[0] === "rename-window" && call.at(-1) === "rd"
  )));
  assert.ok(calls.some((call) => (
    call[0] === "attach-session" && call.at(-1) === tmuxTarget(home, "task-1", "rd")
  )));

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.status, "running");
});

test("cleans stale role windows into exited status", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "cleanup", "task-1"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  assert.match(output, /Cleaned task task-1 roles/);
  assert.match(output, tableCellsRegex("rd", "exited"));

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.status, "exited");
});

test("stops a role through tmux and updates status", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "stop", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  assert.match(output, /Stopped role rd for task-1/);

  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(calls.some((call) => (
    call[0] === "has-session" && call.at(-1) === tmuxTarget(home, "task-1", "rd").split(":")[0]
  )));
  assert.equal(calls.some((call) => call[0] === "send-keys"), false);

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.status, "exited");
});

test("kills a role tmux window and updates status", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "kill", "task-1", "rd"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  });

  assert.match(output, /Killed role rd for task-1/);

  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(calls.some((call) => (
    call[0] === "has-session" && call.at(-1) === tmuxTarget(home, "task-1", "rd").split(":")[0]
  )));
  assert.equal(calls.some((call) => call[0] === "kill-window"), false);

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.status, "exited");
});

test("routes role controls through the Controller post-commit coordinator", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "auto",
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  };

  try {
    runTaskmux(["task", "create", "Control through Controller"], { TASKMUX_HOME: home });
    runTaskmux(
      ["task", "assign", "task-1", "rd", "--agent", "codex", "--workspace", "/tmp/project-a"],
      { TASKMUX_HOME: home }
    );

    const output = runTaskmux(["task", "kill", "task-1", "rd"], env);

    assert.match(output, /Killed role rd for task-1/);
    assert.equal(existsSync(join(home, "runtime", "controller.json")), true);
    assert.equal(JSON.parse(
      readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
    ).status, "exited");
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("adds and lists task comments", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const addOutput = runTaskmux(
    ["task", "comment", "task-1", "Keep old session compatibility."],
    { TASKMUX_HOME: home }
  );

  assert.match(addOutput, /Added comment to task-1/);

  const commentsFile = readFileSync(join(home, "tasks", "task-1", "comments.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(commentsFile[0].schemaVersion, 1);
  assert.equal(commentsFile[0].body, "Keep old session compatibility.");

  runTaskmux(["task", "comment", "task-1", "Reviewer should check copy."], {
    TASKMUX_HOME: home
  });

  const listOutput = runTaskmux(["task", "comments", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(listOutput, /Keep old session compatibility\./);
  assert.match(listOutput, /Reviewer should check copy\./);
});

test("records and lists task event history", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "comment", "task-1", "Keep old session compatibility."], {
    TASKMUX_HOME: home
  });

  const events = readFileSync(join(home, "tasks", "task-1", "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events[0].schemaVersion, 1);
  assert.equal(events[0].id, "event-1");
  assert.equal(events[0].type, "task.created");
  assert.equal(events[0].payload.title, "Refactor login page");
  assert.equal(events[1].type, "role.assigned");
  assert.deepEqual(events[1].payload, { role: "leader", agent: "codex" });
  assert.equal(events[2].type, "role.assigned");
  assert.deepEqual(events[2].payload, { role: "rd", agent: "codex" });
  assert.equal(events[3].type, "comment.added");
  assert.deepEqual(events[3].payload, { comment: "comment-1" });

  const output = runTaskmux(["task", "events", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.match(output, tableCellsRegex("event-1", /.*/, "task.created", "title=Refactor login page"));
  assert.match(output, tableCellsRegex("event-2", /.*/, "role.assigned", "role=leader agent=codex"));
  assert.match(output, tableCellsRegex("event-3", /.*/, "role.assigned", "role=rd agent=codex"));
  assert.match(output, tableCellsRegex("event-4", /.*/, "comment.added", "comment=comment-1"));
});

test("returns a data error exit code for invalid event schema", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  writeFileSync(join(home, "tasks", "task-1", "events.jsonl"), "{\"schemaVersion\":2}\n");

  const result = runTaskmuxFailure(["task", "events", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid event record: task-1:1/);
});

test("returns a not found exit code for missing tasks", () => {
  const home = createConfiguredHome();

  const result = runTaskmuxFailure(["task", "show", "task-404"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 3);
  assert.match(result.stderr, /TASK_NOT_FOUND: Task not found: task-404/);
});

test("returns a role not found exit code for missing roles", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const result = runTaskmuxFailure(["task", "detail", "task-1", "reviewer"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 3);
  assert.match(result.stderr, /ROLE_NOT_FOUND: Role not found: reviewer/);
});

test("returns a usage exit code for missing task shell ids", () => {
  const home = createConfiguredHome();

  const result = runTaskmuxFailure(["task", "shell"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE_ERROR: Task id is required/);
});

test("returns a data error exit code for invalid task schema", () => {
  const home = createConfiguredHome();
  const taskDir = join(home, "tasks", "task-1");
  execFileSync("mkdir", ["-p", taskDir]);
  writeFileSync(join(taskDir, "task.json"), JSON.stringify({ id: "task-1" }));

  const result = runTaskmuxFailure(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid task record: task-1/);
});

test("returns a data error exit code for invalid task info schema", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  writeFileSync(join(home, "tasks", "task-1", "info.json"), JSON.stringify({ schemaVersion: 2 }));

  const result = runTaskmuxFailure(["task", "show", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid task info record: task-1/);
});

test("returns a data error exit code for invalid role schema", () => {
  const home = createConfiguredHome();
  const taskDir = join(home, "tasks", "task-1");
  const roleDir = join(taskDir, "roles", "rd");
  execFileSync("mkdir", ["-p", roleDir]);
  writeFileSync(
    join(taskDir, "task.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "task-1",
      archived: false,
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z"
    })
  );
  writeFileSync(
    join(taskDir, "info.json"),
    JSON.stringify({
      schemaVersion: 1,
      title: "Refactor login page"
    })
  );
  writeFileSync(join(roleDir, "role.json"), JSON.stringify({ schemaVersion: 2 }));

  const result = runTaskmuxFailure(["task", "detail", "task-1", "rd"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid role record: rd/);
});

test("returns a data error exit code for invalid role info schema", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );
  writeFileSync(
    join(home, "tasks", "task-1", "roles", "rd", "info.json"),
    JSON.stringify({ schemaVersion: 2 })
  );

  const result = runTaskmuxFailure(["task", "roles", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid role info record: rd/);
});

test("returns a data error exit code for invalid comment schema", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  writeFileSync(join(home, "tasks", "task-1", "comments.jsonl"), "{\"schemaVersion\":2}\n");

  const result = runTaskmuxFailure(["task", "comments", "task-1"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /DATA_ERROR: Invalid comment record: task-1:1/);
});

test("adds lists shows and removes agents", () => {
  const home = createTaskmuxHome();
  const fakeAgent = createFakeExecutable(home, "custom-agent.js", "custom agent 1.0\n");
  ensureTestStorageSchema(home);

  const addOutput = runTaskmux(
    ["agent", "add", "agent-js", "--adapter", "codex", "--command", fakeAgent, "--arg", "--strict-config", "--env", "TASKMUX_MODE=TASKMUX_MODE"],
    { TASKMUX_HOME: home }
  );

  assert.match(addOutput, /Added agent agent-js/);

  const listOutput = runTaskmux(["agent", "list"], { TASKMUX_HOME: home });
  assert.match(listOutput, tableCellsRegex("agent-js", "custom", "codex", "1 args hidden", "1"));

  const showResult = runTaskmuxFailure(["agent", "show", "agent-js"], { TASKMUX_HOME: home });
  assert.equal(showResult.status, 4);
  assert.match(showResult.stderr, /DATA_ERROR: Agent live capability inspection is unavailable: agent-js/);

  const removeOutput = runTaskmux(["agent", "remove", "agent-js"], { TASKMUX_HOME: home });
  assert.match(removeOutput, /Removed agent agent-js/);

  const result = runTaskmuxFailure(["agent", "show", "agent-js"], { TASKMUX_HOME: home });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /AGENT_NOT_FOUND: Agent not found: agent-js/);
});

test("configures global roles and binds copied roles to tasks", () => {
  const home = createTaskmuxHome();
  const codexAgent = createFakeExecutable(home, "codex-agent.js", "codex agent 1.0\n");
  const claudeAgent = createFakeExecutable(home, "claude-agent.js", "claude agent 1.0\n");

  addAgent(home, "codex", codexAgent);
  addAgent(home, "claude", claudeAgent);

  const addRoleOutput = runTaskmux(["role", "add", "reviewer", "--agent", "claude", "--workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });
  assert.match(addRoleOutput, /Added role reviewer/);
  assert.match(addRoleOutput, /Active agent: claude/);

  runTaskmux(["config", "set", "default-agent", "codex"], { TASKMUX_HOME: home });
  runTaskmux(["config", "set", "default-workspace", "/tmp/project-a"], { TASKMUX_HOME: home });
  runTaskmux(["task", "create", "Review payment flow"], { TASKMUX_HOME: home });

  const bindOutput = runTaskmux(["task", "bind", "task-1", "reviewer"], { TASKMUX_HOME: home });
  assert.match(bindOutput, /Bound role reviewer to task-1/);
  assert.match(bindOutput, /Agent: claude/);

  runTaskmux(["role", "update", "reviewer", "--workspace", "/tmp/project-b"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "role", "update", "task-1", "reviewer", "--workspace", "/tmp/task-local"], {
    TASKMUX_HOME: home
  });

  const taskRole = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "reviewer", "role.json"), "utf8")
  );
  const globalRole = JSON.parse(readFileSync(join(home, "roles", "reviewer", "role.json"), "utf8"));

  assert.equal(taskRole.activeAgentId, "claude");
  assert.equal(taskRole.workspace, "/tmp/task-local");
  assert.equal(globalRole.activeAgentId, "claude");
  assert.equal(globalRole.workspace, "/tmp/project-b");
});

test("copies descriptive role template fields into an independent task role", () => {
  const home = createConfiguredHome();

  runTaskmux(
    [
      "role", "add", "reviewer",
      "--agent", "codex",
      "--workspace", "/tmp/project-a",
      "--description", "Review risky changes",
      "--responsibility", "Check rollback safety",
      "--constraint", "Do not edit production",
      "--expected-output", "A concise review",
      "--system-prompt", "Be skeptical and evidence-driven.",
      "--skill", "security-review"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "create", "Review deployment"], { TASKMUX_HOME: home });
  runTaskmux(["task", "bind", "task-1", "reviewer"], { TASKMUX_HOME: home });
  const taskRole = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "reviewer", "info.json"), "utf8")
  );

  assert.equal(taskRole.description, "Review risky changes");
  assert.deepEqual(taskRole.responsibilities, ["Check rollback safety"]);
  assert.deepEqual(taskRole.constraints, ["Do not edit production"]);
  assert.equal(taskRole.expectedOutput, "A concise review");
  assert.equal(taskRole.systemPrompt, "Be skeptical and evidence-driven.");
  assert.deepEqual(taskRole.skills, ["security-review"]);
});

test("protects system roles and shows missing system role agents as question marks", () => {
  const home = createTaskmuxHome();
  ensureTestStorageSchema(home);

  const listOutput = runTaskmux(["role", "list"], { TASKMUX_HOME: home });
  assert.match(listOutput, tableCellsRegex("operator", "?", "?"));
  assert.match(listOutput, /system:global user-facing/);
  assert.match(listOutput, tableCellsRegex("leader", "?", "?"));
  assert.match(listOutput, /system:task leader and role/);

  const showOutput = runTaskmux(["role", "show", "operator"], { TASKMUX_HOME: home });
  assert.match(showOutput, /Role: operator/);
  assert.match(showOutput, /Agent: \?/);

  const operatorRemove = runTaskmuxFailure(["role", "remove", "operator"], { TASKMUX_HOME: home });
  assert.equal(operatorRemove.status, 2);
  assert.match(operatorRemove.stderr, /USAGE_ERROR: System role cannot be removed: operator/);

  const leaderRemove = runTaskmuxFailure(["role", "remove", "leader"], { TASKMUX_HOME: home });
  assert.equal(leaderRemove.status, 2);
  assert.match(leaderRemove.stderr, /USAGE_ERROR: System role cannot be removed: leader/);
});

test("runs the Operator in its own persistent tmux session", () => {
  const home = createTaskmuxHome();
  const fakeAgent = createFakeAgentCli(home, "operator-agent.js", "codex");
  const { fakeTmux, logFile, stateFile } = createFencedOperatorTmux(home);

  writeStorageSchema(home, 4);
  addAgent(home, "codex", fakeAgent);
  runTaskmux(["role", "add", "operator", "--agent", "codex", "--workspace", home], {
    TASKMUX_HOME: home
  });
  runTaskmux(["operator"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    FAKE_TMUX_STATE: stateFile
  });

  const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const newWindow = calls.find((call) => call[0] === "new-window");
  const attach = calls.find((call) => call[0] === "attach-session");

  assert.ok(newWindow);
  assert.deepEqual(newWindow.slice(-2, -1), ["/bin/sh"]);
  assert.match(newWindow.at(-1), /\.taskmux-launch-carriers-.*\/\.pending-launch-.*\/launch\.sh$/);
  assert.match(attach?.at(-1) ?? "", /^taskmux-[a-f0-9]{12}-operator:operator$/);
  assert.doesNotMatch(JSON.stringify(newWindow), /TASKMUX_OPERATOR_CONTEXT|operator-agent\.js/);
  const context = readFileSync(join(home, "operator", "TASKMUX_OPERATOR.md"), "utf8");
  const runtimeStart = context.indexOf("# TaskMux Operator runtime");
  assert.notEqual(runtimeStart, -1);
  const runtime = context.slice(runtimeStart);
  assert.match(
    runtime,
    /taskmux task input request[\s\S]*taskmux task input list[\s\S]*taskmux task input show[\s\S]*taskmux task input answer[\s\S]*taskmux task input cancel/
  );
  assert.match(runtime, /Global Inbox[\s\S]*Task-owned/i);
  assert.match(runtime, /foreground Operator[\s\S]*exact active Leader origin/i);
  assert.match(runtime, /delivery receipt is not an answer/i);
  assert.doesNotMatch(runtime, /\binput\s+(?:draft|submit)\b/i);
  fencedOperatorLaunchToken(stateFile);
});

test("real Operator entry delivers each durable inbox pointer once to its active GlobalRoleSessionSet pane", async () => {
  const home = createTaskmuxHome();
  const { fakeTmux, logFile, stateFile } = createFencedOperatorTmux(home);
  const fakeAgent = createFakeAgentCli(home, "operator-agent.js", "codex");
  writeStorageSchema(home, 4);
  addAgent(home, "codex", fakeAgent);
  runTaskmux(["config", "set", "default-agent", "codex"], { TASKMUX_HOME: home });
  runTaskmux(["config", "set", "default-workspace", home], { TASKMUX_HOME: home });
  const operatorSessionRoot = join(home, "operator-session-root");
  mkdirSync(operatorSessionRoot);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "direct",
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    FAKE_TMUX_STATE: stateFile,
    CODEX_HOME: operatorSessionRoot
  };

  try {
    runTaskmux(["role", "add", "operator", "--agent", "codex", "--workspace", home], env);
    runTaskmux(["task", "create", "Await a release decision"], env);
    runTaskmux(["operator"], env);
    const launchToken = fencedOperatorLaunchToken(stateFile);
    runTaskmux(
      ["role", "session", "record", "operator", "--native-id", "operator-native-1"],
      {
        ...env,
        TASKMUX_ROLE: "operator",
        TASKMUX_AGENT_ID: "codex",
        TASKMUX_ADAPTER_ID: "codex",
        TASKMUX_NATIVE_SESSION_ROOT: operatorSessionRoot,
        CODEX_THREAD_ID: "operator-native-1",
        TASKMUX_OPERATOR_LAUNCH_TOKEN: launchToken
      }
    );

    const { createInputRequest } = await import("../dist/input/inputRequest.js");
    const { createOperatorDelivery } = await import("../dist/operator/operatorDelivery.js");
    const now = new Date(Date.now() - 1_000);
    const store = new FileTaskStore(home);
    store.saveInputRequest(createInputRequest(
      "input-1",
      "task-1",
      {
        roleName: "leader",
        agentId: "codex",
        adapterId: "codex",
        sessionRoot: "/tmp",
        nativeSessionId: "leader-native-1",
        agentRunId: "leader-run-1"
      },
      {
        question: "Should the safe deployment proceed?",
        choices: [{ key: "safe", label: "Proceed with the safe deployment" }],
        blockedRefs: [],
        resolutionPolicy: { mode: "user-required" }
      },
      now
    ));
    store.saveOperatorDelivery(createOperatorDelivery(
      "delivery-1",
      1,
      "task-1",
      "input-1",
      now
    ));

    runTaskmux(["operator"], env);
    assert.equal(store.getOperatorDelivery("delivery-1").status, "accepted");
    const firstInputs = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((call) => call[0] === "if-shell" && call.at(-1).includes("[TaskMux input request delivery delivery-1]"))
      .map((call) => call.at(-1))
      .filter((input) => input.includes("[TaskMux input request delivery delivery-1]"));
    assert.equal(firstInputs.length, 1);
    assert.match(firstInputs[0], /Should the safe deployment proceed\?/);
    assert.equal(existsSync(join(home, "runtime", "operator")), false);

    runTaskmux(["operator"], env);
    const replayedInputs = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((call) => call[0] === "if-shell" && call.at(-1).includes("[TaskMux input request delivery delivery-1]"))
      .map((call) => call.at(-1))
      .filter((input) => input.includes("[TaskMux input request delivery delivery-1]"));
    assert.equal(replayedInputs.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("direct Controller scans time out only offline-recommended input and restore the exact blocked Leader session", async () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile, stateFile } = createStatefulTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "direct",
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    FAKE_TMUX_STATE: stateFile
  };

  try {
    runTaskmux(["task", "create", "Resolve an offline decision"], env);
    writeFileSync(stateFile, "leader\n");

    const {
      createRoleSessionSet,
      recordRoleAgentSession
    } = await import("../dist/executor/agentExecutor.js");
    const { createInputRequest } = await import("../dist/input/inputRequest.js");
    const { updateRoleStatus } = await import("../dist/role/role.js");
    const {
      blockAgentRunForInput,
      createAgentRun
    } = await import("../dist/run/agentRun.js");
    const now = new Date();
    const store = new FileTaskStore(home);
    const role = store.getRole("task-1", "leader");
    assert.ok(role);
    store.saveRole("task-1", updateRoleStatus(role, "running", now));
    store.saveRoleSessionSet(recordRoleAgentSession(
      createRoleSessionSet(
        { scope: "task", taskId: "task-1", roleName: "leader" },
        "codex",
        now
      ),
      {
        agentId: "codex",
        adapterId: "codex",
        nativeSessionId: "leader-native-1",
        policy: "fixed",
        status: "running",
        sessionRoot: "/tmp",
        configFingerprint: configFingerprintFixture("offline-leader"),
        permissionEnvelope: permissionEnvelopeFixture("codex")
      },
      now
    ));
    const request = createInputRequest(
      "input-1",
      "task-1",
      {
        roleName: "leader",
        agentId: "codex",
        adapterId: "codex",
        sessionRoot: "/tmp",
        nativeSessionId: "leader-native-1",
        agentRunId: "leader-run-1"
      },
      {
        question: "Use the safe retry?",
        choices: [{ key: "safe", label: "Use the safe retry" }],
        blockedRefs: [],
        resolutionPolicy: {
          mode: "offline-recommended",
          recommendation: { choiceKey: "safe", reason: "The retry is reversible." },
          offlineTimeoutMs: 1
        }
      },
      now
    );
    const blocked = blockAgentRunForInput(
      createAgentRun(
        "leader-run-1",
        "task-1",
        "leader",
        "resume",
        "Continue leadership",
        now
      ),
      request.id,
      now
    );
    store.saveInputRequest(request);
    store.saveAgentRun(blocked);
    store.saveActiveAgentRun(blocked);
    new TmuxManager(fakeTmux, {
      run(command, args) {
        return execFileSync(command, args, {
          encoding: "utf8",
          env: { ...process.env, ...env }
        });
      }
    }, home).bindExactRoleInputTarget({
      taskId: "task-1",
      roleName: "leader",
      agentId: "codex",
      adapterId: "codex",
      sessionRoot: "/tmp",
      nativeSessionId: "leader-native-1",
      agentRunId: "leader-run-1"
    });

    runTaskmux(["controller", "scan"], env);
    assert.ok(store.getOfflineResolutionClock("task-1", "input-1"));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    runTaskmux(["controller", "scan"], env);

    assert.equal(store.getInputRequest("task-1", "input-1").status, "auto-resolved");
    assert.equal(store.getInputResolutionWakeup("task-1", "input-1").status, "completed");
    assert.equal(store.getActiveAgentRun("task-1", "leader").status, "active");
    const session = store.getRoleSessionSet("task-1", "leader").sessions.codex;
    assert.deepEqual(
      {
        adapterId: session.adapterId,
        sessionRoot: session.sessionRoot,
        nativeSessionId: session.nativeSessionId
      },
      {
        adapterId: "codex",
        sessionRoot: "/tmp",
        nativeSessionId: "leader-native-1"
      }
    );

    const replacementRequest = createInputRequest(
      "input-2",
      "task-1",
      {
        roleName: "leader",
        agentId: "codex",
        adapterId: "codex",
        sessionRoot: "/tmp",
        nativeSessionId: "leader-native-1",
        agentRunId: "leader-run-2"
      },
      {
        question: "Retry the reversible operation?",
        choices: [{ key: "retry", label: "Retry once" }],
        blockedRefs: [],
        resolutionPolicy: {
          mode: "offline-recommended",
          recommendation: { choiceKey: "retry", reason: "The operation is reversible." },
          offlineTimeoutMs: 1
        }
      },
      new Date()
    );
    const replacementBlocked = blockAgentRunForInput(
      createAgentRun(
        "leader-run-2",
        "task-1",
        "leader",
        "resume",
        "Continue leadership",
        new Date()
      ),
      replacementRequest.id,
      new Date()
    );
    store.saveInputRequest(replacementRequest);
    store.saveAgentRun(replacementBlocked);
    store.saveActiveAgentRun(replacementBlocked);
    runTaskmux(["controller", "scan"], env);

    const currentSet = store.getRoleSessionSet("task-1", "leader");
    const currentSession = currentSet.sessions.codex;
    store.saveRoleSessionSet(recordRoleAgentSession(currentSet, {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId: "leader-native-replacement",
      policy: currentSession.policy,
      status: currentSession.status,
      sessionRoot: currentSession.sessionRoot,
      configFingerprint: currentSession.lastLaunchConfigHash,
      permissionEnvelope: currentSession.permissionEnvelope,
      replacementReason: "The old native session exited."
    }, new Date()));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    runTaskmux(["controller", "scan"], env);

    assert.equal(store.getInputRequest("task-1", "input-2").status, "auto-resolved");
    assert.equal(store.getInputResolutionWakeup("task-1", "input-2").status, "abandoned");
    assert.equal(store.getActiveAgentRun("task-1", "leader").status, "blocked");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("assigns configured agents and starts their commands", () => {
  const home = createConfiguredHome();
  const fakeAgent = createFakeAgentCli(home, "custom-agent.js", "codex");
  const { fakeTmux, logFile, carrierLogFile } = createFakeTmux(home);

  runTaskmux(
    [
      "agent",
      "add",
      "agent-js",
      "--adapter",
      "codex",
      "--command",
      fakeAgent,
      "--arg",
      "--strict-config",
      "--env",
      "TASKMUX_MODE=TASKMUX_MODE"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });

  const assignOutput = runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "agent-js",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  assert.match(assignOutput, /Assigned role rd to task-1/);
  assert.match(assignOutput, /Agent: agent-js/);

  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "rd", "role.json"), "utf8")
  );
  assert.equal(role.activeAgentId, "agent-js");
  assert.deepEqual(role.agentBindings["agent-js"], {
    agentId: "agent-js",
    adapterId: "codex",
    config: { adapterId: "codex" }
  });
  const storedAgent = JSON.parse(readFileSync(join(home, "agents", "agent-js", "agent.json"), "utf8"));
  assert.equal(storedAgent.command, fakeAgent);
  assert.deepEqual(storedAgent.baseArgs, ["--strict-config"]);
  assert.deepEqual(storedAgent.environment, [{
    target: "TASKMUX_MODE",
    source: "process",
    sourceName: "TASKMUX_MODE",
    required: true
  }]);

  runTaskmux(["task", "dispatch", "task-1", "rd", "--mode", "new", "--input", "Start work"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    TASKMUX_MODE: "dev"
  });

  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const newWindow = calls.find((call) => call[0] === "new-window");
  const carrier = fakeCarrierCalls(carrierLogFile).at(-1);

  assertPrivateCarrierWindow(newWindow);
  assert.ok(carrier);
  assert.ok(carrier.argv.includes("TASKMUX_MODE=dev"));
  assert.equal(carrier.argv.at(-2), fakeAgent);
  assert.equal(carrier.argv.at(-1), "--strict-config");
});

test("runs doctor checks with configured executables", () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  const fakeAgent = createFakeExecutable(home, "default-agent.js", "default agent 1.0\n");

  writeStorageSchema(home, 4);
  addAgent(home, "default-agent", fakeAgent);
  runTaskmux(["config", "set", "default-agent", "default-agent"], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["doctor"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, /TaskMux doctor/);
  assert.match(output, /\|\s+Check\s+\|\s+Status\s+\|\s+Detail\s+\|/);
  assert.match(output, tableRowRegex("node", "ok", "v"));
  assert.match(output, tableRowRegex("tmux", "ok", "tmux 3\\.4"));
  assert.match(output, tableRowRegex("agent:default-agent", "ok", "default agent 1\\.0"));
  assert.doesNotMatch(output, /codex\s+ok/);
  assert.doesNotMatch(output, /claude\s+ok/);
  assert.match(output, tableRowRegex("taskmux home", "ok"));
  assert.match(output, tableRowRegex("default agent", "ok", "default-agent"));
  assert.match(output, tableRowRegex("storage schema", "ok", "current=4 latest=4"));
  assert.match(output, tableRowRegex("storage permissions", "ok", "read-write"));
  assert.match(output, tableRowRegex("storage records", "ok", "tasks=0 roles=0 globalRoles=0 agents=1"));
  assert.match(output, new RegExp(home.replaceAll("\\", "\\\\")));
});

test("doctor reports missing default agent", () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  writeStorageSchema(home, 4);

  const output = runTaskmux(["doctor"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, tableRowRegex("default agent", "missing", "run taskmux setup"));
});

test("doctor does not initialize a missing taskmux home", () => {
  const parent = createTaskmuxHome();
  const home = join(parent, "taskmux-home");
  const fakeTmux = createFakeExecutable(parent, "fake-tmux.js", "tmux 3.4\n");

  const output = runTaskmux(["doctor"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, tableRowRegex("taskmux home", "missing", "run taskmux setup"));
  assert.match(output, tableRowRegex("storage schema", "missing", "run taskmux setup"));
  assert.match(output, tableRowRegex("storage permissions", "missing", "run taskmux setup"));
  assert.match(output, tableRowRegex("storage records", "missing", "run taskmux setup"));
  assert.equal(existsSync(home), false);
});

test("doctor rejects unsupported storage schemas without migration guidance", () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  writeStorageSchema(home, 2);

  const output = runTaskmux(["doctor"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, tableRowRegex("storage schema", "unsupported", "current=2 latest=4"));
  assert.doesNotMatch(output, /migrate/i);
});

test("doctor reports invalid storage records without failing", () => {
  const home = createConfiguredHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  writeFileSync(join(home, "tasks", "task-1", "task.json"), JSON.stringify({ schemaVersion: 2 }));

  const output = runTaskmux(["doctor"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, tableRowRegex("storage records", "invalid", "Invalid task record: task-1"));
});

test("runs doctor checks for configured agent executables", () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  const fakeAgent = createFakeExecutable(home, "custom-agent.js", "custom agent 1.0\n");
  ensureTestStorageSchema(home);

  runTaskmux(["agent", "add", "agent-js", "--adapter", "codex", "--command", fakeAgent], {
    TASKMUX_HOME: home
  });

  const output = runTaskmux(["doctor"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, tableRowRegex("agent:agent-js", "ok", "custom agent 1\\.0"));
});

test("starts the default dashboard after doctor checks pass", async () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  const fakeAgent = createFakeExecutable(home, "leader-agent.js", "leader agent 1.0\n");

  addAgent(home, "leader-cli", fakeAgent);
  runTaskmux(["config", "set", "default-agent", "leader-cli"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["config", "set", "default-workspace", "/tmp/project-a"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "create", "Dashboard task"], {
    TASKMUX_HOME: home
  });
  runTaskmux(["task", "current", "task-1"], {
    TASKMUX_HOME: home
  });

  const output = await runTaskmuxInteractive([], "board\nq\n", {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });

  assert.match(output, /TaskMux doctor/);
  assert.match(output, tableRowRegex("tmux", "ok", "tmux 3\\.4"));
  assert.match(output, tableRowRegex("agent:leader-cli", "ok", "leader agent 1\\.0"));
  assert.match(output, /TaskMux dashboard/);
  assert.match(output, /Current task: task-1\s+Dashboard task/);
  assert.match(output, /Board/);
  assert.match(output, tableCellsRegex("Ongoing", "task-1", "Dashboard task", "", "", "roles idle=1"));
  assert.match(output, /taskmux>/);
});

test("routes dashboard mutations through the Controller", async () => {
  const home = createConfiguredHome();
  const fakeTmux = createFakeExecutable(home, "dashboard-tmux.js", "tmux 3.4\n");
  runTaskmux(["task", "create", "Dashboard Controller task"], { TASKMUX_HOME: home });

  const output = await runTaskmuxInteractive([], "comment task-1 staged dashboard comment\nq\n", {
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "auto",
    TASKMUX_TMUX_BIN: fakeTmux,
    NODE_ENV: "test",
    TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT: "after-stage"
  });

  assert.match(output, /fail-closed pending restart recovery/);
  assert.equal(existsSync(join(home, "tasks", "task-1", "comments.jsonl")), false);
  assert.equal(readdirSync(join(home, "runtime", "domain-transactions")).length, 1);
  runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
});

test("fails the Controller closed when mid-apply synchronous recovery cannot complete", () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Fail-closed task"], { TASKMUX_HOME: home });
  const failingEnv = {
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "auto",
    NODE_ENV: "test",
    TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT: "after-operation:1-always"
  };

  try {
    runTaskmux(["controller", "start"], failingEnv);
    const failed = runTaskmuxFailure(
      ["task", "comment", "task-1", "Recover this committed comment"],
      failingEnv
    );
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /fail-closed pending restart recovery/);

    let status = { running: true };
    for (let attempt = 0; attempt < 40 && status.running; attempt += 1) {
      status = JSON.parse(runTaskmux(
        ["controller", "status", "--json"],
        { TASKMUX_HOME: home }
      ));
      if (status.running) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    assert.equal(status.running, false);
    assert.equal(pendingDomainTransactionIds(home).length, 1);

    runTaskmux(["controller", "start"], { TASKMUX_HOME: home });
    assert.match(
      runTaskmux(["task", "comments", "task-1"], { TASKMUX_HOME: home }),
      /Recover this committed comment/
    );
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("fails the Controller closed when a background Scheduler transaction cannot recover", () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Fail-closed Scheduler task"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "schedule", "set", "task-1", "--inactivity-minutes", "0", "--cooldown-minutes", "30"],
    { TASKMUX_HOME: home }
  );
  const failingEnv = {
    TASKMUX_HOME: home,
    NODE_ENV: "test",
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "25",
    TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT: "after-operation:1-always"
  };

  try {
    runTaskmux(["controller", "start"], failingEnv);
    let status = { running: true };
    for (let attempt = 0; attempt < 40 && status.running; attempt += 1) {
      status = JSON.parse(runTaskmux(
        ["controller", "status", "--json"],
        { TASKMUX_HOME: home }
      ));
      if (status.running) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    assert.equal(status.running, false);
    assert.equal(pendingDomainTransactionIds(home).length, 1);

    const recoveredEnv = {
      TASKMUX_HOME: home,
      TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "60000"
    };
    runTaskmux(["controller", "start"], recoveredEnv);
    assert.deepEqual(readdirSync(join(home, "runtime", "domain-transactions")), []);
    assert.equal(
      JSON.parse(runTaskmux(
        ["controller", "status", "--json"],
        recoveredEnv
      )).running,
      true
    );
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("blocks the default dashboard when doctor checks fail", () => {
  const home = createTaskmuxHome();

  const result = runTaskmuxFailure([], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: join(home, "missing-tmux")
  });

  assert.equal(result.status, 4);
  assert.match(result.stdout, /TaskMux doctor/);
  assert.match(result.stdout, tableRowRegex("tmux", "missing"));
  assert.doesNotMatch(result.stdout, /TaskMux dashboard/);
  assert.match(result.stderr, /DATA_ERROR: Doctor checks failed: tmux=missing/);
});

test("setup prints a tmux install plan without changing the system", async () => {
  const home = createTaskmuxHome();
  const fakeBin = join(home, "bin");
  mkdirSync(fakeBin);
  createCanonicalCodexFake(fakeBin);
  createPathExecutable(fakeBin, "apt-get", "process.stdout.write('apt 2.0\\n');");
  createPathExecutable(fakeBin, "sudo", "process.stdout.write('sudo 1.0\\n');");

  const output = await runTaskmuxInteractive(
    ["setup"],
    "1\nskip\n\n",
    {
      TASKMUX_HOME: home,
      TASKMUX_SETUP_INTERACTIVE: "1",
      TASKMUX_TMUX_BIN: join(home, "missing-tmux"),
      PATH: fakeBin
    }
  );

  assert.match(output, /TaskMux setup complete/);
  assert.match(output, /Tmux is not installed/);
  assert.match(output, /Install with apt-get/);
  assert.match(output, /Install tmux now\? \[y\/N\]: /);
  assert.match(output, /(sudo )?apt-get update/);
  assert.match(output, /(sudo )?apt-get install -y tmux/);
  assert.match(output, /Skipped tmux installation/);
  assert.doesNotMatch(output, /TaskMux config/);
  assert.doesNotMatch(output, /taskmux setup --yes/);
});

test("setup requires an interactive terminal", () => {
  const home = createTaskmuxHome();

  const result = runTaskmuxFailure(["setup"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: join(home, "missing-tmux")
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /USAGE_ERROR: Setup requires an interactive terminal/);
  assert.match(result.stderr, /taskmux config set default-agent <agent-id>/);
  assert.match(result.stderr, /taskmux config set default-workspace <path>/);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(join(home, "schema.json")), false);
});

test("setup interactively selects a default agent from numbered candidates", async () => {
  const home = createTaskmuxHome();
  const fakeBin = join(home, "bin");
  mkdirSync(fakeBin);
  createCanonicalCodexFake(fakeBin);

  const output = await runTaskmuxInteractive(
    ["setup"],
    "1\nskip\n",
    {
      TASKMUX_HOME: home,
      TASKMUX_SETUP_INTERACTIVE: "1",
      TASKMUX_TMUX_BIN: process.execPath,
      PATH: fakeBin
    }
  );

  assert.match(output, /Default agent candidates/i);
  assert.doesNotMatch(output, /TaskMux home \[/);
  assert.match(output, /\|\s+#\s+\|\s+Agent\s+\|\s+Command\s+\|\s+Status\s+\|/i);
  assert.match(output, /\|\s+1\s+\|\s+codex\s+\|\s+codex\s+\|\s+installed\s+\|/i);
  assert.match(output, /\|\s+\d+\s+\|\s+claude\s+\|\s+claude\s+\|\s+missing\s+\|/i);
  assert.doesNotMatch(output, /\|\s+\d+\s+\|\s+(?:gemini|qwen)\s+\|/i);
  assert.doesNotMatch(output, /Default agent id/);
  assert.doesNotMatch(output, /Command for agent/);
  assert.doesNotMatch(output, /Default workspace \[/);
  assert.doesNotMatch(output, tableRowRegex("agent", "configured"));
  assert.match(output, /TaskMux setup complete/);
  assert.match(output, /TaskMux home initialized/);
  assert.match(output, /Workspace initialized under TaskMux home/);
  assert.doesNotMatch(output, /TaskMux config/);
  assert.doesNotMatch(output, /TaskMux setup\nStatus/);

  const config = runTaskmux(["config", "show"], { TASKMUX_HOME: home });
  const agent = runTaskmux(["agent", "show", "codex"], { TASKMUX_HOME: home });
  const roles = runTaskmux(["role", "list"], { TASKMUX_HOME: home });
  const workspace = join(home, "workspace");

  assert.match(config, tableRowRegex("default-agent", "configured", "agent=codex; command=codex"));
  assert.doesNotMatch(config, /command=codex; found in PATH/);
  assert.match(config, tableRowRegex("default-workspace", "configured", escapeRegex(workspace)));
  assert.match(config, tableRowRegex("role:operator", "configured", "agent=codex\\s+\\|"));
  assert.match(config, tableRowRegex("role:leader", "configured", "agent=codex\\s+\\|"));
  assert.match(agent, /Agent: codex/);
  assert.match(agent, /Executable: codex/);
  assert.match(roles, tableCellsRegex("operator", "codex", workspace));
  assert.match(roles, tableCellsRegex("leader", "codex", workspace));
  assert.equal(existsSync(workspace), true);
});

test("setup initializes a missing taskmux home before writing storage data", async () => {
  const parent = createTaskmuxHome();
  const home = join(parent, "taskmux-home");
  const fakeBin = join(parent, "bin");
  mkdirSync(fakeBin);
  createCanonicalCodexFake(fakeBin);

  assert.equal(existsSync(home), false);

  const output = await runTaskmuxInteractive(
    ["setup"],
    "1\nskip\n",
    {
      TASKMUX_HOME: home,
      TASKMUX_SETUP_INTERACTIVE: "1",
      TASKMUX_TMUX_BIN: process.execPath,
      PATH: fakeBin
    }
  );

  assert.match(output, /TaskMux home initialized[\s\S]*Workspace initialized[\s\S]*TaskMux setup complete/);
  assert.equal(existsSync(home), true);
  assert.equal(existsSync(join(home, "schema.json")), true);
  assert.equal(existsSync(join(home, "config.json")), true);
  assert.equal(existsSync(join(home, "workspace")), true);
});

test("setup refuses piped permission repair even when the test interactive escape is enabled", async () => {
  const parent = createTaskmuxHome();
  const home = join(parent, "taskmux-home");
  const fakeBin = join(parent, "bin");
  mkdirSync(home);
  chmodSync(home, 0o755);
  writeFileSync(join(home, "keep.txt"), "do not touch\n");
  mkdirSync(fakeBin);
  createCanonicalCodexFake(fakeBin);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_SETUP_INTERACTIVE: "1",
    TASKMUX_TMUX_BIN: process.execPath,
    PATH: fakeBin
  };

  await assert.rejects(
    () => runTaskmuxInteractive(["setup"], "yes\n1\nskip\n", env),
    /Repairing an existing TASKMUX_HOME requires a real interactive terminal/
  );
  assert.equal(statSync(home).mode & 0o7777, 0o755);
  assert.equal(readFileSync(join(home, "keep.txt"), "utf8"), "do not touch\n");
  assert.equal(existsSync(join(home, "schema.json")), false);
});

test("runtime commands fail closed without mutating an unsafe TASKMUX_HOME", () => {
  const home = createTaskmuxHome();
  writeStorageSchema(home, 4);
  writeFileSync(join(home, "keep.txt"), "unchanged\n");
  chmodSync(home, 0o755);

  const result = runTaskmuxFailure(["config", "show"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /owned real directory with exact mode 0700/);
  assert.equal(statSync(home).mode & 0o7777, 0o755);
  assert.equal(readFileSync(join(home, "keep.txt"), "utf8"), "unchanged\n");
});

test("setup can install tmux after interactive confirmation", async () => {
  const home = createTaskmuxHome();
  const fakeBin = join(home, "bin");
  const logFile = join(home, "setup.log");
  const installedMarker = join(home, "tmux-installed");
  const fakeTmux = join(home, "tmux");
  mkdirSync(fakeBin);

  createCanonicalCodexFake(fakeBin);
  writeFileSync(
    fakeTmux,
    `#!/usr/bin/env node
const { existsSync } = require("node:fs");
if (!existsSync(${JSON.stringify(installedMarker)})) process.exit(1);
process.stdout.write("tmux 3.4\\n");
`
  );
  chmodSync(fakeTmux, 0o755);

  createPathExecutable(
    fakeBin,
    "apt-get",
    `const { appendFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("apt 2.0\\n");
  process.exit(0);
}
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(["apt-get", ...args]) + "\\n");
if (args.join(" ") === "install -y tmux") writeFileSync(${JSON.stringify(installedMarker)}, "ok\\n");
process.stdout.write("apt 2.0\\n");
`
  );
  createPathExecutable(
    fakeBin,
    "sudo",
    `const { appendFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("sudo 1.0\\n");
  process.exit(0);
}
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(["sudo", ...args]) + "\\n");
if (args.join(" ") === "apt-get install -y tmux") writeFileSync(${JSON.stringify(installedMarker)}, "ok\\n");
process.stdout.write("sudo 1.0\\n");
`
  );

  const output = await runTaskmuxInteractive(
    ["setup"],
    "1\nskip\ny\n",
    {
      TASKMUX_HOME: home,
      TASKMUX_SETUP_INTERACTIVE: "1",
      TASKMUX_TMUX_BIN: fakeTmux,
      PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`
    }
  );
  const log = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));

  assert.match(output, /Install tmux now\? \[y\/N\]: /);
  assert.match(output, /Tmux installed/);
  assert.doesNotMatch(output, /TaskMux config/);
  assert.deepEqual(log.map((entry) => entry[0] === "sudo" ? entry.slice(1) : entry), [
    ["apt-get", "update"],
    ["apt-get", "install", "-y", "tmux"]
  ]);
});

test("setup reports unavailable default agent commands", async () => {
  const home = createTaskmuxHome();
  const fakeBin = join(home, "bin");
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  mkdirSync(fakeBin);
  writeStorageSchema(home, 4);
  runTaskmux(
    ["agent", "add", "taskmux-missing-agent-cli", "--adapter", "codex", "--command", "taskmux-missing-agent-cli"],
    {
      TASKMUX_HOME: home,
      PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`
    }
  );

  const output = await runTaskmuxInteractive(
    ["setup"],
    "taskmux-missing-agent-cli\nskip\n",
    {
      TASKMUX_HOME: home,
      TASKMUX_SETUP_INTERACTIVE: "1",
      TASKMUX_TMUX_BIN: fakeTmux,
      PATH: fakeBin
    }
  );

  assert.equal(
    configTableRows(runTaskmux(["config", "show"], { TASKMUX_HOME: home }))
      .find(([item]) => item === "default-agent")?.[2],
    "agent=taskmux-missing-agent-cli; command=taskmux-missing-agent-cli; not found in PATH"
  );
  assert.doesNotMatch(output, /TaskMux setup\nStatus/);
});

test("setup configures system roles from the default agent", async () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  const fakeAgent = createFakeExecutable(home, "default-agent.js", "default agent 1.0\n");

  addAgent(home, "default-agent", fakeAgent);
  runTaskmux(["config", "set", "default-agent", "default-agent"], { TASKMUX_HOME: home });
  runTaskmux(["config", "set", "default-workspace", "/tmp/system-workspace"], { TASKMUX_HOME: home });

  const output = await runTaskmuxInteractive(
    ["setup"],
    "\nskip\n",
    {
      TASKMUX_HOME: home,
      TASKMUX_SETUP_INTERACTIVE: "1",
      TASKMUX_TMUX_BIN: fakeTmux
    }
  );
  const roles = runTaskmux(["role", "list"], { TASKMUX_HOME: home });

  const config = runTaskmux(["config", "show"], { TASKMUX_HOME: home });
  const workspace = join(home, "workspace");

  assert.match(output, /TaskMux setup complete/);
  assert.match(output, /TaskMux home initialized/);
  assert.doesNotMatch(output, /TaskMux config/);
  assert.equal(
    configTableRows(config).find(([item]) => item === "default-agent")?.[2],
    `agent=default-agent; command=${fakeAgent}`
  );
  assert.match(config, tableRowRegex("default-workspace", "configured", escapeRegex(workspace)));
  assert.match(config, tableRowRegex("role:operator", "configured", "agent=default-agent\\s+\\|"));
  assert.match(config, tableRowRegex("role:leader", "configured", "agent=default-agent\\s+\\|"));
  assert.match(roles, tableCellsRegex("operator", "default-agent", workspace));
  assert.match(roles, tableCellsRegex("leader", "default-agent", workspace));
});

test("non-interactive setup does not configure roles", () => {
  const home = createTaskmuxHome();
  const fakeTmux = createFakeExecutable(home, "fake-tmux.js", "tmux 3.4\n");
  const fakeAgent = createFakeExecutable(home, "default-agent.js", "default agent 1.0\n");

  addAgent(home, "default-agent", fakeAgent);
  runTaskmux(["config", "set", "default-agent", "default-agent"], { TASKMUX_HOME: home });

  const result = runTaskmuxFailure(["setup"], {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux
  });
  const roles = runTaskmux(["role", "list"], { TASKMUX_HOME: home });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Setup requires an interactive terminal/);
  assert.match(roles, tableCellsRegex("operator", "?", "?"));
  assert.match(roles, tableCellsRegex("leader", "?", "?"));
});

test("setup prompts through existing config and keeps values on enter", async () => {
  const home = createTaskmuxHome();
  const fakeTmux = createShellExecutable(home, "fake-tmux", "printf 'tmux 3.4\\n'\n");
  const fakeBin = join(home, "bin");
  mkdirSync(fakeBin);
  createCanonicalCodexFake(fakeBin);

  ensureTestStorageSchema(home);
  runTaskmux(["agent", "add", "codex", "--command", "codex"], {
    TASKMUX_HOME: home,
    PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`
  });
  runTaskmux(["config", "set", "default-agent", "codex"], { TASKMUX_HOME: home });
  runTaskmux(["config", "set", "default-workspace", "/tmp/existing-workspace"], { TASKMUX_HOME: home });

  const output = await runTaskmuxInteractive(
    ["setup"],
    "\nskip\n",
    {
      TASKMUX_HOME: home,
      TASKMUX_SETUP_INTERACTIVE: "1",
      TASKMUX_TMUX_BIN: fakeTmux,
      PATH: fakeBin
    }
  );
  const config = runTaskmux(["config", "show"], { TASKMUX_HOME: home });

  assert.match(output, /Default agent candidates/i);
  assert.match(output, /\|\s+1\s+\|\s+codex\s+\|\s+codex\s+\|\s+installed\s+\|\s+yes\s+\|/i);
  assert.match(output, /Choose default agent by number or name \[codex\]: /);
  assert.doesNotMatch(output, /Default workspace \[/);
  assert.doesNotMatch(output, tableRowRegex("agent", "ok"));
  assert.match(output, /TaskMux setup complete/);
  assert.match(output, /TaskMux home initialized/);
  assert.match(output, /Tmux already installed/);
  assert.doesNotMatch(output, /TaskMux config/);
  assert.doesNotMatch(output, /TaskMux setup\nStatus/);
  assert.match(config, tableRowRegex("default-agent", "configured", "agent=codex; command=codex"));
  assert.doesNotMatch(config, /command=codex; found in PATH/);
  assert.match(config, tableRowRegex("default-workspace", "configured", escapeRegex(join(home, "workspace"))));
});

test("setup reports an unknown mode before scoped help", () => {
  const parent = createTaskmuxHome();
  const home = join(parent, "taskmux-home");
  const result = runTaskmuxFailure(["setup", "--yes"], {
    TASKMUX_HOME: home
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /^USAGE_ERROR: Unknown command: setup --yes\n\nTaskMux setup\n/);
  assert.match(result.stderr, /\btmux\s+Install tmux before setup\./);
  assert.equal(existsSync(home), false);
});

test("runs an interactive task shell", async () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Refactor login page"], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    [
      "task",
      "assign",
      "task-1",
      "rd",
      "--agent",
      "codex",
      "--workspace",
      "/tmp/project-a"
    ],
    { TASKMUX_HOME: home }
  );

  const output = await runTaskmuxInteractive(
    ["task", "shell", "task-1"],
    "summary\nupdate --priority high --due 2026-07-01\nsummary\nr\ncomment hello from shell\nc\ne\na\nt\ncontext\nq\n",
    { TASKMUX_HOME: home }
  );

  assert.match(output, /Task: task-1/);
  assert.match(output, /taskmux task-1>/);
  assert.match(output, /Updated task task-1/);
  assert.match(output, /Priority: high/);
  assert.match(output, /Due: 2026-07-01/);
  assert.match(output, tableCellsRegex("rd", "codex", "idle", "/tmp/project-a"));
  assert.match(output, /Added comment to task-1: hello from shell/);
  assert.match(output, /hello from shell/);
  assert.match(output, /task\.created/);
  assert.match(output, /role\.assigned/);
  assert.match(output, /comment\.added/);
  assert.match(output, /Task activity: task-1/);
  assert.match(output, /Task timeline: task-1/);
  assert.match(output, /Task Context/);
});

test("routes Task shell mutations through the Controller", async () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Controller shell"], { TASKMUX_HOME: home });
  const env = { TASKMUX_HOME: home, TASKMUX_CONTROLLER_MODE: "auto" };

  try {
    await runTaskmuxInteractive(
      ["task", "shell", "task-1"],
      "comment shell-controlled update\nexit\n",
      env
    );
    assert.equal(existsSync(join(home, "runtime", "controller.json")), true);
    const comments = readFileSync(join(home, "tasks", "task-1", "comments.jsonl"), "utf8");
    assert.match(comments, /shell-controlled update/);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("creates a task-local custom topic", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Plan data migration"], { TASKMUX_HOME: home });
  const output = runTaskmux(
    [
      "task",
      "topic",
      "create",
      "task-1",
      "--id",
      "data-migration",
      "--name",
      "数据迁移",
      "--description",
      "数据结构变更、迁移过程与兼容性处理"
    ],
    { TASKMUX_HOME: home }
  );
  const topics = JSON.parse(readFileSync(join(home, "tasks", "task-1", "topics.json"), "utf8"));

  assert.match(output, /Created topic data-migration for task task-1/);
  assert.equal(topics.schemaVersion, 1);
  assert.deepEqual(topics.customTopics.map(({ createdAt, ...topic }) => topic), [
    {
      id: "data-migration",
      name: "数据迁移",
      description: "数据结构变更、迁移过程与兼容性处理",
      createdBy: "user"
    }
  ]);
  assert.match(topics.customTopics[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("lists built-in and task-local topics together", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Plan data migration"], { TASKMUX_HOME: home });
  runTaskmux(
    [
      "task",
      "topic",
      "create",
      "task-1",
      "--id",
      "data-migration",
      "--name",
      "数据迁移",
      "--description",
      "数据结构变更、迁移过程与兼容性处理"
    ],
    { TASKMUX_HOME: home }
  );
  const output = runTaskmux(["task", "topic", "list", "task-1"], { TASKMUX_HOME: home });

  for (const topic of [
    "requirements",
    "architecture",
    "ui",
    "implementation",
    "testing",
    "deployment",
    "operations",
    "security",
    "data-migration"
  ]) {
    assert.match(output, new RegExp(topic));
  }
  assert.match(output, /数据迁移/);
});

test("persists curated Topic summaries in task context", () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Summarize architecture"], { TASKMUX_HOME: home });
  runTaskmux(
    [
      "task", "topic", "summarize", "task-1", "--topic", "architecture",
      "--summary", "The Controller is the only mutation writer."
    ],
    { TASKMUX_HOME: home }
  );
  const summaryFile = readFileSync(join(home, "tasks", "task-1", "topic-summaries.md"), "utf8");
  const context = JSON.parse(
    runTaskmux(["task", "context", "task-1", "--format", "json"], { TASKMUX_HOME: home })
  );

  assert.match(summaryFile, /## architecture/);
  assert.match(summaryFile, /Controller is the only mutation writer/);
  assert.equal(context.topicSummaries, summaryFile);
});

test("warns about custom topic naming without blocking it", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Prepare deployment"], { TASKMUX_HOME: home });
  const output = runTaskmux(
    [
      "task",
      "topic",
      "create",
      "task-1",
      "--id",
      "Deployment Check",
      "--name",
      "部署检查",
      "--description",
      "发布前检查"
    ],
    { TASKMUX_HOME: home }
  );

  assert.match(output, /Created topic Deployment Check/);
  assert.match(output, /Warning: topic ids conventionally use lower-case kebab-case/);
});

test("keeps operator input as a draft until it is submitted", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Investigate deployment failures"], { TASKMUX_HOME: home });
  const draftOutput = runTaskmux(
    ["task", "input", "draft", "task-1", "Production fails only in the canary environment."],
    { TASKMUX_HOME: home }
  );
  const draft = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "input-draft.json"), "utf8")
  );

  assert.match(draftOutput, /Saved input draft for task task-1/);
  assert.equal(draft.body, "Production fails only in the canary environment.");
  assert.equal(existsSync(join(home, "tasks", "task-1", "comments.jsonl")), false);

  const submitOutput = runTaskmux(["task", "input", "submit", "task-1"], {
    TASKMUX_HOME: home
  });
  const comments = readFileSync(join(home, "tasks", "task-1", "comments.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const events = readFileSync(join(home, "tasks", "task-1", "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const pendingWakeup = JSON.parse(
    readFileSync(join(home, "runtime", "pending-wakeups", "task-1.json"), "utf8")
  );

  assert.match(submitOutput, /Submitted input draft for task task-1/);
  assert.equal(comments.at(-1).body, "Production fails only in the canary environment.");
  assert.equal(comments.at(-1).author, "operator");
  assert.equal(events.at(-1).type, "task.input_submitted");
  assert.deepEqual(pendingWakeup.reasons, ["operator-input"]);
  assert.equal(pendingWakeup.requestCount, 1);
  assert.equal(existsSync(join(home, "tasks", "task-1", "input-draft.json")), false);
});

test("creates a cycle and a finite work item inside a long-lived task", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Keep production deployments healthy"], { TASKMUX_HOME: home });
  const cycleOutput = runTaskmux(
    ["task", "cycle", "create", "task-1", "--cause", "explicit-wake", "--summary", "Check today's release"],
    { TASKMUX_HOME: home }
  );
  const workItemOutput = runTaskmux(
    [
      "task",
      "work-item",
      "create",
      "task-1",
      "--title",
      "Run canary checks",
      "--cycle",
      "cycle-1",
      "--assignee",
      "leader",
      "--topic",
      "testing",
      "--topic",
      "deployment"
    ],
    { TASKMUX_HOME: home }
  );
  const cycle = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "cycles", "cycle-1.json"), "utf8")
  );
  const workItem = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "work-items", "work-item-1.json"), "utf8")
  );

  assert.match(cycleOutput, /Created cycle cycle-1 for task task-1/);
  assert.equal(cycle.cause, "explicit-wake");
  assert.equal(cycle.status, "active");
  assert.match(workItemOutput, /Created work item work-item-1 for task task-1/);
  assert.equal(workItem.cycleId, "cycle-1");
  assert.equal(workItem.assignee, "leader");
  assert.equal(workItem.status, "pending");
  assert.deepEqual(workItem.topics, ["testing", "deployment"]);

  runTaskmux(
    [
      "task", "work-item", "update", "task-1", "work-item-1",
      "--status", "completed",
      "--outcome", "Canary checks passed"
    ],
    { TASKMUX_HOME: home }
  );
  const completed = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "work-items", "work-item-1.json"), "utf8")
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome, "Canary checks passed");
  assert.match(completed.endedAt, /^\d{4}-/);

  runTaskmux(
    ["task", "cycle", "end", "task-1", "cycle-1", "--summary", "Canary cycle completed successfully"],
    { TASKMUX_HOME: home }
  );
  const endedCycle = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "cycles", "cycle-1.json"), "utf8")
  );
  assert.equal(endedCycle.status, "ended");
  assert.equal(endedCycle.summary, "Canary cycle completed successfully");
  assert.match(endedCycle.endedAt, /^\d{4}-/);

  const initialCycle = runTaskmux(
    ["task", "cycle", "create", "task-1", "--cause", "task-created", "--summary", "Initial stewardship"],
    { TASKMUX_HOME: home }
  );
  assert.match(initialCycle, /Created cycle cycle-2/);
});

test("coalesces comments and explicit triggers into one leader wakeup", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Track an external release"], { TASKMUX_HOME: home });
  runTaskmux(["task", "comment", "task-1", "The vendor moved the release date."], {
    TASKMUX_HOME: home
  });
  const output = runTaskmux(
    ["task", "wake", "task-1", "--reason", "review-time"],
    { TASKMUX_HOME: home }
  );
  const pendingWakeup = JSON.parse(
    readFileSync(join(home, "runtime", "pending-wakeups", "task-1.json"), "utf8")
  );

  assert.match(output, /Queued leader wakeup for task task-1/);
  assert.deepEqual(pendingWakeup.reasons, ["user-comment", "review-time"]);
  assert.equal(pendingWakeup.requestCount, 2);
});

test("associates comments and Cycles with multiple Topics", () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Track operational context"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "comment", "task-1", "Review the rollout", "--topic", "operations", "--topic", "security"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    [
      "task", "cycle", "create", "task-1", "--cause", "explicit-wake",
      "--summary", "Review rollout controls", "--topic", "operations", "--topic", "security"
    ],
    { TASKMUX_HOME: home }
  );
  const context = JSON.parse(
    runTaskmux(["task", "context", "task-1", "--format", "json"], { TASKMUX_HOME: home })
  );

  assert.equal(context.comments[0].body, "Review the rollout");
  assert.deepEqual(context.comments[0].topics, ["operations", "security"]);
  assert.deepEqual(context.cycles[0].topics, ["operations", "security"]);
});

test("starts and reaches the controller through authenticated loopback RPC", () => {
  const home = createConfiguredHome();

  try {
    const startOutput = runTaskmux(["controller", "start"], { TASKMUX_HOME: home });
    const status = JSON.parse(
      runTaskmux(["controller", "status", "--json"], { TASKMUX_HOME: home })
    );
    const discovery = JSON.parse(
      readFileSync(join(home, "runtime", "controller.json"), "utf8")
    );

    assert.match(startOutput, /Controller started/);
    assert.equal(discovery.host, "127.0.0.1");
    assert.equal(discovery.apiVersion, 1);
    assert.match(discovery.token, /^[a-f0-9]{64}$/);
    assert.equal(status.running, true);
    assert.equal(status.pid, discovery.pid);
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("rejects unauthenticated and incompatible Controller RPC requests", async () => {
  const home = createConfiguredHome();

  try {
    runTaskmux(["controller", "start"], { TASKMUX_HOME: home });
    const discovery = JSON.parse(readFileSync(join(home, "runtime", "controller.json"), "utf8"));
    const endpoint = `http://${discovery.host}:${discovery.port}/rpc`;
    const unauthorized = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, requestId: "unauthorized", method: "health" })
    });
    const incompatible = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${discovery.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ apiVersion: 999, requestId: "incompatible", method: "health" })
    });

    assert.equal(unauthorized.status, 401);
    assert.equal(incompatible.status, 400);
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("controller replays staged snapshot writes before serving requests", async () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Original title"], { TASKMUX_HOME: home });
  const recovery = await import("../dist/storage/recoveryJournal.js");
  const target = join(home, "tasks", "task-1", "info.json");
  recovery.stageSnapshotWrite(
    home,
    target,
    `${JSON.stringify({ schemaVersion: 1, title: "Recovered title" }, null, 2)}\n`,
    "controller-replay"
  );

  try {
    runTaskmux(["controller", "start"], { TASKMUX_HOME: home });
    assert.equal(JSON.parse(readFileSync(target, "utf8")).title, "Recovered title");
    assert.deepEqual(readdirSync(join(home, "runtime", "recovery-journal")), []);
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("controller replays a committed domain transaction and its RPC result before serving", async () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Before domain replay"], { TASKMUX_HOME: home });
  const recovery = await import("../dist/storage/recoveryJournal.js");
  const infoFile = join(home, "tasks", "task-1", "info.json");
  const resultFile = join(home, "runtime", "rpc-results", "replayed-request.json");
  const intentDir = join(home, "runtime", "rpc-intents");
  mkdirSync(intentDir, { recursive: true });
  writeFileSync(join(intentDir, "replayed-request.json"), JSON.stringify({
    schemaVersion: 1,
    requestId: "replayed-request",
    method: "task.command",
    createdAt: new Date().toISOString()
  }));
  recovery.stageDomainTransaction(home, "replayed-request", [
    {
      type: "write",
      target: infoFile,
      content: `${JSON.stringify({ schemaVersion: 1, title: "After domain replay" }, null, 2)}\n`
    },
    {
      type: "write",
      target: resultFile,
      content: `${JSON.stringify({
        requestId: "replayed-request",
        result: { output: "Updated task task-1\n" }
      }, null, 2)}\n`
    }
  ]);

  try {
    runTaskmux(["controller", "start"], { TASKMUX_HOME: home });
    const discovery = JSON.parse(readFileSync(join(home, "runtime", "controller.json"), "utf8"));
    const response = await fetch(`http://${discovery.host}:${discovery.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${discovery.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        apiVersion: 1,
        requestId: "replayed-request",
        method: "task.command",
        params: { args: ["update", "task-1", "--title", "must not run"] }
      })
    });

    assert.equal(response.status, 200);
    assert.equal(JSON.parse(readFileSync(infoFile, "utf8")).title, "After domain replay");
    assert.match(JSON.stringify(await response.json()), /Updated task task-1/);
    assert.deepEqual(readdirSync(join(home, "runtime", "domain-transactions")), []);
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("controller rebuilds and refreshes its derived SQLite index", async () => {
  const home = createConfiguredHome();
  const env = { TASKMUX_HOME: home, TASKMUX_CONTROLLER_MODE: "auto" };
  const { default: Database } = await import("better-sqlite3");
  runTaskmux(["task", "create", "Existing indexed task"], { TASKMUX_HOME: home });
  const indexFile = join(home, "runtime", "index.sqlite");

  try {
    runTaskmux(["controller", "start"], env);
    let database = new Database(indexFile, { readonly: true });
    assert.equal(database.prepare("SELECT count(*) AS count FROM tasks").get().count, 1);
    database.close();

    runTaskmux(["task", "create", "Controller indexed task"], env);
    database = new Database(indexFile, { readonly: true });
    assert.equal(database.prepare("SELECT count(*) AS count FROM tasks").get().count, 2);
    database.close();
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("controller does not depend on filesystem watchers", () => {
  const controllerSource = readFileSync(join(process.cwd(), "src", "controller", "controller.ts"), "utf8");

  assert.doesNotMatch(controllerSource, /fileReloadWatcher|startTaskmuxFileWatcher|stopFileWatcher/);
  assert.equal(existsSync(join(process.cwd(), "src", "storage", "fileReloadWatcher.ts")), false);
});

test("controller fails closed for an invalid authoritative task edit", () => {
  const home = createConfiguredHome();
  const env = { TASKMUX_HOME: home, TASKMUX_CONTROLLER_MODE: "auto" };
  runTaskmux(["task", "create", "Controller cached title"], { TASKMUX_HOME: home });

  try {
    runTaskmux(["controller", "start"], env);
    assert.match(runTaskmux(["task", "show", "task-1"], env), /Controller cached title/);
    const infoFile = join(home, "tasks", "task-1", "info.json");
    writeFileSync(infoFile, "{ invalid json\n");

    const result = runTaskmuxFailure(["task", "show", "task-1"], env);
    assert.equal(result.status, 4);
    assert.match(result.stderr, /DATA_ERROR: Invalid task info record: task-1/);
    assert.equal(readFileSync(infoFile, "utf8"), "{ invalid json\n");
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("Scheduler leaves an invalid authoritative task wakeup pending", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile, stateFile } = createStatefulTmux(home);
  runTaskmux(["task", "create", "Last valid scheduled task"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "session", "record", "task-1", "leader", "--native-id", "last-valid-session"],
    { TASKMUX_HOME: home }
  );
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    FAKE_TMUX_STATE: stateFile,
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "50"
  };

  try {
    runTaskmux(["controller", "start"], env);
    const infoFile = join(home, "tasks", "task-1", "info.json");
    writeFileSync(infoFile, "{ invalid json\n");
    const pendingDir = join(home, "runtime", "pending-wakeups");
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(join(pendingDir, "task-1.json"), `${JSON.stringify({
      schemaVersion: 1,
      taskId: "task-1",
      reasons: ["explicit-wake"],
      requestCount: 1,
      firstRequestedAt: new Date().toISOString(),
      lastRequestedAt: new Date().toISOString()
    }, null, 2)}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);

    assert.equal(existsSync(join(pendingDir, "task-1.json")), true);
    assert.equal(existsSync(join(home, "runtime", "active-runs", "task-1", "leader.json")), false);
    assert.equal(readFileSync(infoFile, "utf8"), "{ invalid json\n");
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("controller fails closed for an invalid authoritative role edit", () => {
  const home = createConfiguredHome();
  const env = { TASKMUX_HOME: home, TASKMUX_CONTROLLER_MODE: "auto" };
  runTaskmux(["task", "create", "Cache role records"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );

  try {
    runTaskmux(["controller", "start"], env);
    const roleInfo = join(home, "tasks", "task-1", "roles", "reviewer", "info.json");
    writeFileSync(roleInfo, "{ invalid json\n");
    const result = runTaskmuxFailure(["task", "detail", "task-1", "reviewer"], env);
    assert.equal(result.status, 4);
    assert.match(result.stderr, /DATA_ERROR: Invalid role info record: reviewer/);
    assert.equal(readFileSync(roleInfo, "utf8"), "{ invalid json\n");
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("controller fails closed for an invalid authoritative global role edit", () => {
  const home = createConfiguredHome();
  runTaskmux(
    ["role", "add", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  const env = { TASKMUX_HOME: home, TASKMUX_CONTROLLER_MODE: "auto" };

  try {
    runTaskmux(["controller", "start"], env);
    const roleInfo = join(home, "roles", "reviewer", "role.json");
    writeFileSync(roleInfo, "{ invalid json\n");
    const result = runTaskmuxFailure(["role", "show", "reviewer"], env);
    assert.equal(result.status, 4);
    assert.match(result.stderr, /DATA_ERROR: Invalid global role record: reviewer/);
    assert.equal(readFileSync(roleInfo, "utf8"), "{ invalid json\n");
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("commits query task pointers through the Controller transaction", () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Transactional pointer"], { TASKMUX_HOME: home });
  runTaskmux(["config", "set", "default-workspace", "/tmp/project-a"], { TASKMUX_HOME: home });
  const configFile = join(home, "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  delete config.lastTaskId;
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "auto",
    NODE_ENV: "test",
    TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT: "after-stage"
  };

  try {
    runTaskmux(["controller", "start"], env);
    const show = runTaskmuxFailure(["task", "show", "task-1"], env);

    assert.equal(show.status, 5);
    assert.equal(JSON.parse(readFileSync(configFile, "utf8")).lastTaskId, undefined);
    assert.equal(readdirSync(join(home, "runtime", "domain-transactions")).length, 1);
    runTaskmuxFailure(["controller", "stop"], env);

    runTaskmux(["controller", "start"], { TASKMUX_HOME: home });
    assert.equal(JSON.parse(readFileSync(configFile, "utf8")).lastTaskId, "task-1");
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("removes a stale discovery file when its live pid does not answer Controller health", () => {
  const home = createConfiguredHome();
  const discoveryFile = join(home, "runtime", "controller.json");
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(discoveryFile, JSON.stringify({
    schemaVersion: 1,
    apiVersion: 1,
    host: "127.0.0.1",
    port: 1,
    pid: process.pid,
    token: "not-a-controller",
    startedAt: new Date().toISOString()
  }));

  const status = JSON.parse(runTaskmux(["controller", "status", "--json"], { TASKMUX_HOME: home }));
  assert.equal(status.running, false);
  assert.equal(existsSync(discoveryFile), false);
});

test("uses an exclusive process lock for Controller startup", async () => {
  const home = createConfiguredHome();
  const controller = await import("../dist/controller/controller.js");

  assert.equal(typeof controller.acquireControllerLock, "function");
  const release = controller.acquireControllerLock(home, process.pid);
  assert.throws(() => controller.acquireControllerLock(home, process.pid), /Controller startup is locked/);
  release();

  const releaseAgain = controller.acquireControllerLock(home, process.pid);
  releaseAgain();
});

test("controller applies a mutating RPC request id only once", async () => {
  const home = createConfiguredHome();
  const { fakeTmux } = createFailingDispatchTmux(home);
  const env = { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux };

  runTaskmux(["task", "create", "Deduplicate wakeups"], { TASKMUX_HOME: home });
  try {
    runTaskmux(["controller", "start"], env);
    const discovery = JSON.parse(
      readFileSync(join(home, "runtime", "controller.json"), "utf8")
    );
    const request = {
      apiVersion: 1,
      requestId: "same-request-id",
      method: "wakeup.merge",
      params: { taskId: "task-1", reason: "explicit-wake" }
    };
    const invoke = () => fetch(`http://127.0.0.1:${discovery.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${discovery.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });

    assert.equal((await invoke()).status, 200);
    assert.equal((await invoke()).status, 200);
    const wakeup = JSON.parse(
      readFileSync(join(home, "runtime", "pending-wakeups", "task-1.json"), "utf8")
    );
    assert.equal(wakeup.requestCount, 1);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("prunes old RPC results without allowing their request ids to execute again", async () => {
  const home = createConfiguredHome();
  const resultsDir = join(home, "runtime", "rpc-results");
  mkdirSync(resultsDir, { recursive: true });
  const oldResult = join(resultsDir, "expired-request.json");
  const recentResult = join(resultsDir, "recent-request.json");
  writeFileSync(oldResult, JSON.stringify({ requestId: "expired-request", result: { output: "old" } }));
  writeFileSync(recentResult, JSON.stringify({ requestId: "recent-request", result: { output: "recent" } }));
  utimesSync(oldResult, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));

  try {
    runTaskmux(["controller", "start"], {
      TASKMUX_HOME: home,
      TASKMUX_RPC_RESULT_RETENTION_MS: "1000"
    });
    const discovery = JSON.parse(readFileSync(join(home, "runtime", "controller.json"), "utf8"));
    const response = await fetch(`http://${discovery.host}:${discovery.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${discovery.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        apiVersion: 1,
        requestId: "expired-request",
        method: "task.command",
        params: { args: ["create", "Must not be created"] }
      })
    });

    assert.equal(existsSync(oldResult), false);
    assert.equal(existsSync(recentResult), true);
    assert.equal(response.status, 409);
    assert.match(JSON.stringify(await response.json()), /expired/);
    assert.equal(existsSync(join(home, "tasks", "task-1")), false);
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("controller does not reapply a request whose crash intent has an unknown outcome", async () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Protect crash retries"], { TASKMUX_HOME: home });
  runTaskmux(["controller", "start"], { TASKMUX_HOME: home });

  try {
    const discovery = JSON.parse(readFileSync(join(home, "runtime", "controller.json"), "utf8"));
    const intentDir = join(home, "runtime", "rpc-intents");
    mkdirSync(intentDir, { recursive: true });
    writeFileSync(join(intentDir, "crashed-request.json"), JSON.stringify({
      schemaVersion: 1,
      requestId: "crashed-request",
      method: "task.command",
      createdAt: "2026-07-11T00:00:00.000Z"
    }));
    const response = await fetch(`http://${discovery.host}:${discovery.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${discovery.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        apiVersion: 1,
        requestId: "crashed-request",
        method: "task.command",
        params: { args: ["comment", "task-1", "must not be duplicated"] }
      })
    });

    assert.equal(response.status, 409);
    assert.match(JSON.stringify(await response.json()), /outcome is unknown/);
    assert.equal(existsSync(join(home, "tasks", "task-1", "comments.jsonl")), false);
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("controller completes a staged command transaction after restart without reapplying it", async () => {
  const home = createConfiguredHome();
  const failingEnv = {
    TASKMUX_HOME: home,
    NODE_ENV: "test",
    TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT: "after-stage"
  };
  const request = {
    apiVersion: 1,
    requestId: "restart-transaction",
    method: "task.command",
    params: { args: ["create", "Recovered transactional task"] }
  };

  try {
    runTaskmux(["controller", "start"], failingEnv);
    let discovery = JSON.parse(readFileSync(join(home, "runtime", "controller.json"), "utf8"));
    const invoke = () => fetch(`http://${discovery.host}:${discovery.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${discovery.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });

    assert.equal((await invoke()).status, 503);
    assert.equal(existsSync(join(home, "tasks", "task-1", "task.json")), false);
    assert.equal(existsSync(join(home, "runtime", "domain-transactions", "restart-transaction.json")), true);
    runTaskmuxFailure(["controller", "stop"], failingEnv);

    runTaskmux(["controller", "start"], { TASKMUX_HOME: home });
    discovery = JSON.parse(readFileSync(join(home, "runtime", "controller.json"), "utf8"));
    const recovered = await invoke();

    assert.equal(recovered.status, 200);
    assert.match(JSON.stringify(await recovered.json()), /Created task task-1/);
    assert.equal(JSON.parse(readFileSync(join(home, "tasks", "task-1", "info.json"), "utf8")).title, "Recovered transactional task");
    assert.equal(readFileSync(join(home, "tasks", "task-1", "events.jsonl"), "utf8").match(/task\.created/g)?.length, 1);
    assert.equal(existsSync(join(home, "runtime", "domain-transactions", "restart-transaction.json")), false);
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("fails closed when interactive attach claim staging is interrupted before its Controller commit", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  runTaskmux(["task", "create", "Attach transaction"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "session", "record", "task-1", "leader", "--native-id", "interactive-attach-session"],
    { TASKMUX_HOME: home }
  );
  const failingEnv = {
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "auto",
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    NODE_ENV: "test",
    TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT: "after-stage"
  };

  try {
    runTaskmux(["controller", "start"], failingEnv);
    const attach = runTaskmuxFailure(["task", "enter", "task-1", "leader"], failingEnv);

    assert.equal(attach.status, 5);
    assert.equal(JSON.parse(
      readFileSync(join(home, "tasks", "task-1", "roles", "leader", "role.json"), "utf8")
    ).status, "idle");
    assert.equal(readdirSync(join(home, "runtime", "domain-transactions")).length, 1);
    runTaskmuxFailure(["controller", "stop"], failingEnv);

    const recoveredEnv = {
      TASKMUX_HOME: home,
      TASKMUX_CONTROLLER_MODE: "auto",
      TASKMUX_TMUX_BIN: fakeTmux,
      FAKE_TMUX_LOG: logFile
    };
    runTaskmux(["controller", "start"], recoveredEnv);
    assert.equal(JSON.parse(
      readFileSync(join(home, "tasks", "task-1", "roles", "leader", "role.json"), "utf8")
    ).status, "idle");
  } finally {
    runTaskmuxFailure(["controller", "stop"], {
      TASKMUX_HOME: home,
      TASKMUX_CONTROLLER_MODE: "auto"
    });
  }
});

test("auto-starts the Controller and routes ordinary task commands through RPC", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile, stateFile } = createStatefulTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "auto",
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    FAKE_TMUX_STATE: stateFile
  };

  try {
    const output = runTaskmux(["task", "create", "Create through the Controller"], env);
    const discovery = JSON.parse(readFileSync(join(home, "runtime", "controller.json"), "utf8"));

    assert.match(output, /Created task task-1/);
    assert.equal(discovery.host, "127.0.0.1");
    assert.equal(JSON.parse(readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8")).archived, false);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("starts the dedicated Leader's first run after task creation", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createExistingRoleTmux(home, "leader");
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "auto",
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "60000"
  };

  try {
    runTaskmux(["task", "create", "Start Leader stewardship"], env);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    const run = JSON.parse(
      readFileSync(join(home, "runtime", "active-runs", "task-1", "leader.json"), "utf8")
    );
    const cycle = JSON.parse(
      readFileSync(join(home, "tasks", "task-1", "cycles", "cycle-1.json"), "utf8")
    );
    const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));

    assert.equal(run.mode, "new");
    assert.match(run.input, /# TaskMux Leader/);
    assert.match(run.input, /task-created/);
    assert.equal(cycle.cause, "task-created");
    assert.match(cycle.summary, /task-created/);
    assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), false);
    assertPrivateCarrierWindowRenamedForRole(calls, home, "task-1", "leader");
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("routes configuration and role mutations through the same Controller", () => {
  const home = createConfiguredHome();
  const env = { TASKMUX_HOME: home, TASKMUX_CONTROLLER_MODE: "auto" };

  try {
    runTaskmux(["config", "set", "default-workspace", "/tmp/controller-workspace"], env);
    runTaskmux(
      ["role", "add", "controller-reviewer", "--agent", "codex", "--workspace", "/tmp/controller-workspace"],
      env
    );

    assert.equal(existsSync(join(home, "runtime", "controller.json")), true);
    assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).defaultWorkspace, "/tmp/controller-workspace");
    assert.equal(
      JSON.parse(readFileSync(join(home, "roles", "controller-reviewer", "role.json"), "utf8")).activeAgentId,
      "codex"
    );
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

function seedStaleActiveRunAfterDeletion(home) {
  const run = createAgentRun(
    "stale-after-delete",
    "task-1",
    "leader",
    "new",
    "This nonportable runtime record must not survive a portable restore.",
    new Date()
  );
  new FileTaskStore(home).saveActiveAgentRun(run);
  return run;
}

function seedOrphanRuntimeOperationClaim(home) {
  const snapshot = {
    role: null,
    sessionSet: null,
    activeRun: null,
    selectedWorkItem: null,
    pendingRun: null
  };
  const claim = {
    schemaVersion: 1,
    scope: "task-role",
    kind: "launch",
    token: "00000000-0000-4000-8000-000000000031",
    taskId: "task-1",
    roleName: "leader",
    operation: "dispatch",
    ownerPid: process.pid,
    preparedSession: null,
    selectedWorkItem: null,
    pendingRun: null,
    expectedStateDigest: roleRuntimeStateDigest(snapshot),
    recoveryToken: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    leaseExpiresAt: "2026-07-15T00:02:00.000Z"
  };
  writeRoleRuntimeOperationClaim(home, claim, claim.expectedStateDigest);
  return claim;
}

test("direct import restores a same-id trashed task without restoring its runtime session", () => {
  const home = createConfiguredHome();
  const snapshotDirectory = mkdtempSync(join(tmpdir(), "taskmux-export-"));
  const snapshot = join(snapshotDirectory, "snapshot.json");
  const { fakeTmux, logFile } = createFakeTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "direct",
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  };

  try {
    runTaskmux(["task", "create", "Restore directly"], env);
    runTaskmux(["export", "--output", snapshot], env);
    runTaskmux(["task", "delete", "task-1"], env);
    seedStaleActiveRunAfterDeletion(home);

    assert.match(
      runTaskmux(["import", snapshot, "--workspace-map", "default=default"], env),
      /Imported TaskMux portable data/
    );
    assert.match(
      runTaskmux(["import", snapshot, "--workspace-map", "default=default"], env),
      /No-op:/
    );

    const store = new FileTaskStore(home);
    assert.equal(store.getTask("task-1")?.title, "Restore directly");
    assert.equal(existsSync(join(home, "trash", "tasks", "task-1")), false);
    assert.equal(store.getRoleSessionSet("task-1", "leader"), null);
    assert.equal(store.getActiveAgentRun("task-1", "leader"), null);
    assert.match(
      runTaskmux(
        ["task", "dispatch", "task-1", "leader", "--mode", "new", "--input", "Dispatch after restore"],
        env
      ),
      /Dispatch accepted/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(snapshotDirectory, { recursive: true, force: true });
  }
});

test("routes import mutations through the Controller single-writer boundary", () => {
  const home = createConfiguredHome();
  const snapshotDirectory = mkdtempSync(join(tmpdir(), "taskmux-export-"));
  const snapshot = join(snapshotDirectory, "snapshot.json");
  const { fakeTmux, logFile } = createFakeTmux(home);
  runTaskmux(["task", "create", "Restore through Controller"], { TASKMUX_HOME: home });
  runTaskmux(["export", "--output", snapshot], { TASKMUX_HOME: home });
  runTaskmux(["task", "delete", "task-1"], { TASKMUX_HOME: home });
  seedStaleActiveRunAfterDeletion(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "auto",
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  };

  try {
    assert.match(
      runTaskmux(["import", snapshot, "--workspace-map", "default=default"], env),
      /Imported TaskMux portable data/
    );
    assert.equal(existsSync(join(home, "runtime", "controller.json")), true);
    assert.equal(JSON.parse(readFileSync(join(home, "tasks", "task-1", "info.json"), "utf8")).title,
      "Restore through Controller");
    assert.equal(new FileTaskStore(home).getRoleSessionSet("task-1", "leader"), null);
    assert.equal(new FileTaskStore(home).getActiveAgentRun("task-1", "leader"), null);
    assert.match(
      runTaskmux(["import", snapshot, "--workspace-map", "default=default"], env),
      /No-op:/
    );
    assert.match(
      runTaskmux(
        ["task", "dispatch", "task-1", "leader", "--mode", "new", "--input", "Dispatch after restore"],
        env
      ),
      /Dispatch accepted/
    );
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
    rmSync(home, { recursive: true, force: true });
    rmSync(snapshotDirectory, { recursive: true, force: true });
  }
});

test("direct and Controller imports clear orphaned runtime after a trash prune", async (t) => {
  for (const mode of ["direct", "auto"]) {
    await t.test(mode, () => {
      const home = createConfiguredHome();
      const snapshotDirectory = mkdtempSync(join(tmpdir(), "taskmux-export-"));
      const snapshot = join(snapshotDirectory, "snapshot.json");
      const { fakeTmux, logFile } = createFakeTmux(home);
      const setupEnv = {
        TASKMUX_HOME: home,
        TASKMUX_CONTROLLER_MODE: "direct",
        TASKMUX_TMUX_BIN: fakeTmux,
        FAKE_TMUX_LOG: logFile
      };
      const env = { ...setupEnv, TASKMUX_CONTROLLER_MODE: mode };

      try {
        runTaskmux(["task", "create", `Pruned restore ${mode}`], setupEnv);
        runTaskmux(["export", "--output", snapshot], setupEnv);
        runTaskmux(["task", "delete", "task-1"], setupEnv);
        runTaskmux(["prune", "--trash"], setupEnv);
        const stale = seedStaleActiveRunAfterDeletion(home);

        assert.equal(existsSync(join(home, "trash", "tasks", "task-1")), false);
        assert.match(
          runTaskmux(["import", snapshot, "--workspace-map", "default=default"], env),
          /Imported TaskMux portable data/
        );
        const store = new FileTaskStore(home);
        assert.equal(store.getActiveAgentRun("task-1", "leader"), null);
        assert.match(
          runTaskmux(
            ["task", "dispatch", "task-1", "leader", "--mode", "new", "--input", "Dispatch after prune"],
            env
          ),
          /Dispatch accepted/
        );
        assert.notEqual(store.getActiveAgentRun("task-1", "leader")?.id, stale.id);
      } finally {
        if (mode === "auto") {
          runTaskmuxFailure(["controller", "stop"], env);
        }
        rmSync(home, { recursive: true, force: true });
        rmSync(snapshotDirectory, { recursive: true, force: true });
      }
    });
  }
});

test("portable import rejects an orphaned task runtime operation without mutation", () => {
  const home = createConfiguredHome();
  const snapshotDirectory = mkdtempSync(join(tmpdir(), "taskmux-export-"));
  const snapshot = join(snapshotDirectory, "snapshot.json");
  const env = { TASKMUX_HOME: home, TASKMUX_CONTROLLER_MODE: "direct" };

  try {
    runTaskmux(["task", "create", "Fence orphan runtime"], env);
    runTaskmux(["export", "--output", snapshot], env);
    runTaskmux(["task", "delete", "task-1"], env);
    runTaskmux(["prune", "--trash"], env);
    const stale = seedStaleActiveRunAfterDeletion(home);
    const claim = seedOrphanRuntimeOperationClaim(home);

    const failed = runTaskmuxFailure(["import", snapshot, "--workspace-map", "default=default"], env);

    assert.equal(failed.status, 4);
    assert.match(failed.stderr, /Portable import transaction is invalid|active runtime operation/i);
    assert.equal(new FileTaskStore(home).getTask("task-1"), null);
    assert.equal(existsSync(join(home, "trash", "tasks", "task-1")), false);
    assert.equal(new FileTaskStore(home).getActiveAgentRun("task-1", "leader")?.id, stale.id);
    assert.equal(readRoleRuntimeOperationClaim(home, "task-1", "leader")?.token, claim.token);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(snapshotDirectory, { recursive: true, force: true });
  }
});

test("direct and Controller import failures preserve orphaned runtime after a trash prune", async (t) => {
  for (const mode of ["direct", "auto"]) {
    await t.test(mode, () => {
      const home = createConfiguredHome();
      const snapshotDirectory = mkdtempSync(join(tmpdir(), "taskmux-export-"));
      const snapshot = join(snapshotDirectory, "snapshot.json");
      const env = {
        TASKMUX_HOME: home,
        TASKMUX_CONTROLLER_MODE: mode,
        NODE_ENV: "test",
        TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT: "after-apply"
      };

      try {
        runTaskmux(["task", "create", `Pruned rollback ${mode}`], {
          TASKMUX_HOME: home,
          TASKMUX_CONTROLLER_MODE: "direct"
        });
        runTaskmux(["export", "--output", snapshot], {
          TASKMUX_HOME: home,
          TASKMUX_CONTROLLER_MODE: "direct"
        });
        runTaskmux(["task", "delete", "task-1"], {
          TASKMUX_HOME: home,
          TASKMUX_CONTROLLER_MODE: "direct"
        });
        runTaskmux(["prune", "--trash"], {
          TASKMUX_HOME: home,
          TASKMUX_CONTROLLER_MODE: "direct"
        });
        const stale = seedStaleActiveRunAfterDeletion(home);

        const failed = runTaskmuxFailure(
          ["import", snapshot, "--workspace-map", "default=default"],
          env
        );

        assert.equal(failed.status, 4);
        assert.match(failed.stderr, /Portable import failed/);
        assert.equal(new FileTaskStore(home).getTask("task-1"), null);
        assert.equal(existsSync(join(home, "trash", "tasks", "task-1")), false);
        assert.equal(new FileTaskStore(home).getActiveAgentRun("task-1", "leader")?.id, stale.id);
      } finally {
        if (mode === "auto") {
          runTaskmuxFailure(["controller", "stop"], {
            TASKMUX_HOME: home,
            TASKMUX_CONTROLLER_MODE: "auto"
          });
        }
        rmSync(home, { recursive: true, force: true });
        rmSync(snapshotDirectory, { recursive: true, force: true });
      }
    });
  }
});

test("direct and Controller import failures preserve a same-id trashed task atomically", async (t) => {
  for (const mode of ["direct", "auto"]) {
    await t.test(mode, () => {
      const home = createConfiguredHome();
      const snapshotDirectory = mkdtempSync(join(tmpdir(), "taskmux-export-"));
      const snapshot = join(snapshotDirectory, "snapshot.json");
      const env = {
        TASKMUX_HOME: home,
        TASKMUX_CONTROLLER_MODE: mode,
        NODE_ENV: "test",
        TASKMUX_TEST_ONLY_PORTABLE_IMPORT_FAILPOINT: "after-apply"
      };

      try {
        runTaskmux(["task", "create", `Rollback ${mode}`], {
          TASKMUX_HOME: home,
          TASKMUX_CONTROLLER_MODE: "direct"
        });
        runTaskmux(["export", "--output", snapshot], {
          TASKMUX_HOME: home,
          TASKMUX_CONTROLLER_MODE: "direct"
        });
        runTaskmux(["task", "delete", "task-1"], {
          TASKMUX_HOME: home,
          TASKMUX_CONTROLLER_MODE: "direct"
        });
        const stale = seedStaleActiveRunAfterDeletion(home);

        const failed = runTaskmuxFailure(
          ["import", snapshot, "--workspace-map", "default=default"],
          env
        );

        assert.equal(failed.status, 4);
        assert.match(failed.stderr, /Portable import failed/);
        assert.equal(new FileTaskStore(home).getTask("task-1"), null);
        assert.equal(existsSync(join(home, "trash", "tasks", "task-1")), true);
        assert.equal(
          new FileTaskStore(home).readTrashedTask("task-1", (trash) => trash.getTask("task-1")?.title),
          `Rollback ${mode}`
        );
        assert.equal(new FileTaskStore(home).getActiveAgentRun("task-1", "leader")?.id, stale.id);
      } finally {
        if (mode === "auto") {
          runTaskmuxFailure(["controller", "stop"], {
            TASKMUX_HOME: home,
            TASKMUX_CONTROLLER_MODE: "auto"
          });
        }
        rmSync(home, { recursive: true, force: true });
        rmSync(snapshotDirectory, { recursive: true, force: true });
      }
    });
  }
});

test("replays a staged prune transaction after Controller restart", () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Prune transaction"], { TASKMUX_HOME: home });
  runTaskmux(["task", "delete", "task-1"], { TASKMUX_HOME: home });
  const failingEnv = {
    TASKMUX_HOME: home,
    TASKMUX_CONTROLLER_MODE: "auto",
    NODE_ENV: "test",
    TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT: "after-stage"
  };
  const trashTask = join(home, "trash", "tasks", "task-1");

  try {
    runTaskmux(["controller", "start"], failingEnv);
    const prune = runTaskmuxFailure(["prune", "--trash"], failingEnv);

    assert.equal(prune.status, 5);
    assert.equal(existsSync(trashTask), true);
    assert.equal(readdirSync(join(home, "runtime", "domain-transactions")).length, 1);
    runTaskmuxFailure(["controller", "stop"], failingEnv);

    runTaskmux(["controller", "start"], { TASKMUX_HOME: home });
    assert.equal(existsSync(trashTask), false);
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("deduplicates a generic task command RPC by request id", async () => {
  const home = createConfiguredHome();

  try {
    runTaskmux(["controller", "start"], { TASKMUX_HOME: home });
    const discovery = JSON.parse(readFileSync(join(home, "runtime", "controller.json"), "utf8"));
    const request = {
      apiVersion: 1,
      requestId: "same-task-command",
      method: "task.command",
      params: { args: ["create", "Create exactly once"] }
    };
    const invoke = () => fetch(`http://127.0.0.1:${discovery.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${discovery.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });

    assert.equal((await invoke()).status, 200);
    assert.equal((await invoke()).status, 200);
    assert.deepEqual(
      readdirSync(join(home, "tasks")).filter((name) => name.startsWith("task-")),
      ["task-1"]
    );
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("stores child roles as parent-only descriptive constraints", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Review the deployment architecture"], { TASKMUX_HOME: home });
  const output = runTaskmux(
    [
      "task",
      "role",
      "child",
      "task-1",
      "deployment-reviewer",
      "--parent",
      "leader",
      "--description",
      "Review deployment changes",
      "--responsibility",
      "Find rollback risks",
      "--constraint",
      "Do not modify production",
      "--expected-output",
      "A concise risk report"
    ],
    { TASKMUX_HOME: home }
  );
  const roleDir = join(home, "tasks", "task-1", "roles", "deployment-reviewer");
  const childRole = JSON.parse(readFileSync(join(roleDir, "info.json"), "utf8"));

  assert.match(output, /Created child role deployment-reviewer for parent leader/);
  assert.equal(childRole.architecture, "child");
  assert.equal(childRole.parentRole, "leader");
  assert.deepEqual(childRole.responsibilities, ["Find rollback risks"]);
  assert.deepEqual(childRole.constraints, ["Do not modify production"]);
  assert.equal(childRole.expectedOutput, "A concise risk report");
  assert.equal("agent" in childRole, false);
  assert.equal("skills" in childRole, false);
  assert.equal(existsSync(join(roleDir, "role.json")), false);
});

test("injects child role descriptions into the parent dispatch only", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Review deployment"], { TASKMUX_HOME: home });
  runTaskmux(
    [
      "task", "role", "child", "task-1", "risk-reviewer",
      "--parent", "leader",
      "--description", "Review rollback risk",
      "--responsibility", "Check data compatibility",
      "--constraint", "Do not deploy",
      "--expected-output", "Risk report"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "leader", "--mode", "new", "--input", "Plan the review"],
    { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile }
  );
  const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const literalInput = calls.find((call) => call[0] === "send-keys" && call[1] === "-l");

  assert.ok(literalInput);
  const injectedInput = literalInput.at(-1);

  assert.match(injectedInput, /risk-reviewer/);
  assert.match(injectedInput, /Review rollback risk/);
  assert.match(injectedInput, /Check data compatibility/);
  assert.match(injectedInput, /Do not deploy/);
  assert.match(injectedInput, /Risk report/);
  assert.match(injectedInput, /Plan the review/);
});

test("removes child role constraints when their parent role is removed", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Review deployment"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    [
      "task", "role", "child", "task-1", "risk-checker",
      "--parent", "reviewer",
      "--description", "Check risks",
      "--expected-output", "Risk notes"
    ],
    { TASKMUX_HOME: home }
  );

  const output = runTaskmux(["task", "role", "remove", "task-1", "reviewer"], {
    TASKMUX_HOME: home
  });

  assert.match(output, /Removed role reviewer and 1 child role/);
  assert.equal(existsSync(join(home, "tasks", "task-1", "roles", "reviewer")), false);
  assert.equal(existsSync(join(home, "tasks", "task-1", "roles", "risk-checker")), false);
});

test("creates a git worktree for an independent task role", () => {
  const home = createConfiguredHome();
  const repository = join(home, "project");
  const worktreeRoot = mkdtempSync(join(tmpdir(), "taskmux-managed-worktrees-"));
  const worktree = join(worktreeRoot, "reviewer");
  mkdirSync(repository, { recursive: true });
  execFileSync("git", ["init"], { cwd: repository });
  mkdirSync(join(repository, ".taskmux-test-hooks"));
  execFileSync("git", ["config", "core.hooksPath", ".taskmux-test-hooks"], { cwd: repository });
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/master"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "taskmux@example.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "TaskMux Test"], { cwd: repository });
  writeFileSync(join(repository, "README.md"), "initial\n");
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repository });

  runTaskmux(["task", "create", "Review release", "--workspace", repository], {
    TASKMUX_HOME: home
  });
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", repository],
    { TASKMUX_HOME: home }
  );
  const output = runTaskmux(
    ["task", "worktree", "create", "task-1", "reviewer", "--path", worktree, "--branch", "taskmux/reviewer"],
    { TASKMUX_HOME: home }
  );
  const metadata = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "reviewer", "worktree.json"), "utf8")
  );
  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "reviewer", "role.json"), "utf8")
  );
  const { fakeTmux, logFile } = createFakeTmux(home);
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Review in isolation"],
    { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile }
  );
  const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const newWindow = calls.find((call) => call[0] === "new-window");

  assert.match(output, /Created worktree for task-1\/reviewer/);
  assert.equal(existsSync(join(worktree, ".git")), true);
  assert.equal(metadata.schemaVersion, 2);
  assert.equal(metadata.branchRef, "taskmux/reviewer");
  assert.equal(metadata.path, worktree);
  assert.equal(role.workspace, worktree);
  assert.ok(newWindow);
  assert.equal(newWindow[newWindow.indexOf("-c") + 1], worktree);
  assert.deepEqual(newWindow.slice(-2, -1), ["/bin/sh"]);
  assert.match(newWindow.at(-1), /\.taskmux-launch-carriers-.*\/\.pending-launch-.*\/launch\.sh$/);
  assert.ok(calls.some((call) => call[0] === "rename-window" && call.at(-1) === "reviewer"));
});

test("requires an explicit worktree before dispatching an independent role in a Git workspace", () => {
  const home = createConfiguredHome();
  const repository = join(home, "repository");
  mkdirSync(repository, { recursive: true });
  execFileSync("git", ["init", repository], { stdio: "pipe" });
  runTaskmux(["config", "set", "default-workspace", repository], { TASKMUX_HOME: home });
  runTaskmux(["task", "create", "Isolate delegated work"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", repository],
    { TASKMUX_HOME: home }
  );
  const { fakeTmux, logFile } = createFakeTmux(home);

  const result = runTaskmuxFailure(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Review"],
    { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile }
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /worktree/i);
  assert.equal(existsSync(logFile), false);
});

test("keeps the leader native session fixed until explicit replacement", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Maintain a long-running release"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "session", "record", "task-1", "leader", "--native-id", "codex-session-1"],
    { TASKMUX_HOME: home }
  );
  const rejected = runTaskmuxFailure(
    ["task", "session", "record", "task-1", "leader", "--native-id", "codex-session-2"],
    { TASKMUX_HOME: home }
  );

  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /Leader session replacement must be explicit/);

  const output = runTaskmux(
    [
      "task", "session", "replace", "task-1", "leader",
      "--native-id", "codex-session-2",
      "--reason", "irrecoverable native session"
    ],
    { TASKMUX_HOME: home }
  );
  const session = taskRoleSessionSet(home, "task-1", "leader");

  assert.match(output, /Replaced native session for task-1\/leader/);
  assert.equal(session.schemaVersion, 3);
  assert.equal(session.activeAgentId, "codex");
  assert.equal(session.sessions.codex.nativeSessionId, "codex-session-2");
  assert.equal(session.sessions.codex.policy, "fixed");
  assert.deepEqual(session.sessions.codex.previousIdentities, [{
    adapterId: "codex",
    sessionRoot: session.sessions.codex.sessionRoot,
    nativeSessionId: "codex-session-1"
  }]);
});

test("Controller rejects a running task Agent's cross-task session record like direct mode", () => {
  const fixture = createRunningTaskLeaderSessionCaller();
  const args = ["task", "session", "record", "task-2", "leader", "--native-id", "target-thread"];

  try {
    const direct = runTaskmuxFailure(args, {
      ...fixture.callerEnv,
      TASKMUX_CONTROLLER_MODE: "direct"
    });
    assert.equal(direct.status, 2);
    assert.match(direct.stderr, /target does not match the active AgentRun owner/i);

    startCleanController(fixture.home, fixture.fakeTmux, fixture.logFile);
    const automatic = runTaskmuxFailure(args, {
      ...fixture.callerEnv,
      TASKMUX_CONTROLLER_MODE: "auto"
    });

    assert.equal(automatic.status, direct.status, automatic.stderr);
    assert.equal(automatic.stderr, direct.stderr);
    assert.equal(new FileTaskStore(fixture.home).getRoleSessionSet("task-2", "leader"), null);
  } finally {
    stopController(fixture.home);
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("Controller rejects a running task Agent's cross-task session replacement like direct mode", () => {
  const fixture = createRunningTaskLeaderSessionCaller();
  const args = [
    "task", "session", "replace", "task-2", "leader",
    "--native-id", "target-replacement", "--reason", "replace target session"
  ];

  try {
    runTaskmux(
      ["task", "session", "record", "task-2", "leader", "--native-id", "target-original"],
      fixture.baseEnv
    );
    const direct = runTaskmuxFailure(args, {
      ...fixture.callerEnv,
      TASKMUX_CONTROLLER_MODE: "direct"
    });
    assert.equal(direct.status, 2);
    assert.match(direct.stderr, /running Agent may record only its current native session/i);

    startCleanController(fixture.home, fixture.fakeTmux, fixture.logFile);
    const automatic = runTaskmuxFailure(args, {
      ...fixture.callerEnv,
      TASKMUX_CONTROLLER_MODE: "auto"
    });

    assert.equal(automatic.status, direct.status, automatic.stderr);
    assert.equal(automatic.stderr, direct.stderr);
    assert.equal(
      new FileTaskStore(fixture.home).getRoleSessionSet("task-2", "leader").sessions.codex.nativeSessionId,
      "target-original"
    );
  } finally {
    stopController(fixture.home);
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("Controller rejects a running GlobalRole's cross-role session record like direct mode", () => {
  const fixture = createGlobalRoleSessionCaller();
  const args = ["role", "session", "record", "reviewer", "--native-id", "target-thread"];

  try {
    const direct = runTaskmuxFailure(args, {
      ...fixture.callerEnv,
      TASKMUX_CONTROLLER_MODE: "direct"
    });
    assert.equal(direct.status, 2);
    assert.match(direct.stderr, /does not match the active GlobalRole binding/i);

    startCleanController(fixture.home, fixture.fakeTmux, fixture.logFile);
    const automatic = runTaskmuxFailure(args, {
      ...fixture.callerEnv,
      TASKMUX_CONTROLLER_MODE: "auto"
    });

    assert.equal(automatic.status, direct.status, automatic.stderr);
    assert.equal(automatic.stderr, direct.stderr);
    assert.equal(new FileTaskStore(fixture.home).getGlobalRoleSessionSet("reviewer"), null);
  } finally {
    stopController(fixture.home);
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("Controller rejects a running GlobalRole's cross-role session replacement like direct mode", () => {
  const fixture = createGlobalRoleSessionCaller();
  const args = [
    "role", "session", "replace", "reviewer",
    "--native-id", "target-replacement", "--reason", "replace target session"
  ];

  try {
    runTaskmux(
      ["role", "session", "record", "reviewer", "--native-id", "target-original"],
      fixture.baseEnv
    );
    const direct = runTaskmuxFailure(args, {
      ...fixture.callerEnv,
      TASKMUX_CONTROLLER_MODE: "direct"
    });
    assert.equal(direct.status, 2);
    assert.match(direct.stderr, /running Agent may record only its current native session/i);

    startCleanController(fixture.home, fixture.fakeTmux, fixture.logFile);
    const automatic = runTaskmuxFailure(args, {
      ...fixture.callerEnv,
      TASKMUX_CONTROLLER_MODE: "auto"
    });

    assert.equal(automatic.status, direct.status, automatic.stderr);
    assert.equal(automatic.stderr, direct.stderr);
    assert.equal(
      new FileTaskStore(fixture.home).getGlobalRoleSessionSet("reviewer").sessions.codex.nativeSessionId,
      "target-original"
    );
  } finally {
    stopController(fixture.home);
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("Controller fails closed when a session RPC omits trusted registration provenance", async () => {
  const controller = await import("../dist/controller/controller.js");
  const taskFixture = createRunningTaskLeaderSessionCaller();

  try {
    startCleanController(taskFixture.home, taskFixture.fakeTmux, taskFixture.logFile);
    const discovery = controller.readControllerDiscovery(taskFixture.home);

    assert.ok(discovery);
    await assert.rejects(
      controller.callController(
        discovery,
        "task.command",
        "missing-task-provenance",
        { args: ["session", "record", "task-2", "leader", "--native-id", "target-thread"] }
      ),
      /Controller session registration provenance is required/
    );
    assert.equal(new FileTaskStore(taskFixture.home).getRoleSessionSet("task-2", "leader"), null);
  } finally {
    stopController(taskFixture.home);
    rmSync(taskFixture.home, { recursive: true, force: true });
  }

  const globalFixture = createGlobalRoleSessionCaller();
  try {
    startCleanController(globalFixture.home, globalFixture.fakeTmux, globalFixture.logFile);
    const discovery = controller.readControllerDiscovery(globalFixture.home);

    assert.ok(discovery);
    await assert.rejects(
      controller.callController(
        discovery,
        "command.execute",
        "missing-global-provenance",
        {
          group: "role",
          args: ["session", "record", "reviewer", "--native-id", "target-thread"]
        }
      ),
      /Controller session registration provenance is required/
    );
    assert.equal(new FileTaskStore(globalFixture.home).getGlobalRoleSessionSet("reviewer"), null);
  } finally {
    stopController(globalFixture.home);
    rmSync(globalFixture.home, { recursive: true, force: true });
  }
});

test("Controller preserves the CLI-bound manual session registration root", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const sessionRoot = join(home, "caller-codex");
  mkdirSync(sessionRoot);
  const callerEnv = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    CODEX_HOME: sessionRoot,
    TASKMUX_CONTROLLER_MODE: "auto"
  };

  try {
    runTaskmux(["task", "create", "Manual session target"], { TASKMUX_HOME: home });
    runTaskmux(["role", "add", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"], {
      TASKMUX_HOME: home
    });
    startCleanController(home, fakeTmux, logFile);

    assert.match(
      runTaskmux(
        ["task", "session", "record", "task-1", "leader", "--native-id", "task-native"],
        callerEnv
      ),
      /Recorded native session for task-1\/leader/
    );
    assert.match(
      runTaskmux(
        ["role", "session", "record", "reviewer", "--native-id", "global-native"],
        callerEnv
      ),
      /Recorded native session for role reviewer/
    );
    assert.equal(
      new FileTaskStore(home).getRoleSessionSet("task-1", "leader").sessions.codex.sessionRoot,
      sessionRoot
    );
    assert.equal(
      new FileTaskStore(home).getGlobalRoleSessionSet("reviewer").sessions.codex.sessionRoot,
      sessionRoot
    );
  } finally {
    stopController(home);
    rmSync(home, { recursive: true, force: true });
  }
});

test("reserves a fixed Claude Leader session when the Task is created", () => {
  const home = createConfiguredHome();

  runTaskmux(
    ["task", "create", "Reserve the Leader", "--agent", "claude", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  const session = taskRoleSessionSet(home, "task-1", "leader");

  assert.match(session.sessions.claude.nativeSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(session.activeAgentId, "claude");
  assert.equal(session.sessions.claude.policy, "fixed");
  assert.equal(session.sessions.claude.status, "reserved");
});

test("starts a reserved Claude Leader session instead of replacing it", () => {
  const cliDirectory = mkdtempSync(join(tmpdir(), "taskmux-claude-cli-"));
  createFakeAgentCli(cliDirectory, "claude", "claude");
  const probeEnvironment = { PATH: `${cliDirectory}:${process.env.PATH}` };
  const home = createConfiguredHome(probeEnvironment);
  const { fakeTmux, logFile, carrierLogFile } = createFakeTmux(home);
  const env = {
    ...probeEnvironment,
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile
  };
  runTaskmux(
    ["task", "create", "Start the reserved Leader", "--agent", "claude", "--workspace", "/tmp/project-a"],
    env
  );
  const reservedId = taskRoleSessionSet(home, "task-1", "leader").sessions.claude.nativeSessionId;
  runTaskmux(
    ["task", "dispatch", "task-1", "leader", "--mode", "new", "--input", "Begin stewardship"],
    env
  );
  const session = taskRoleSessionSet(home, "task-1", "leader");
  const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const newWindow = calls.find((call) => call[0] === "new-window");
  const carrier = fakeCarrierCalls(carrierLogFile).at(-1);

  assert.match(session.sessions.claude.nativeSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(session.sessions.claude.nativeSessionId, reservedId);
  assert.equal(session.sessions.claude.status, "running");
  assertPrivateCarrierWindow(newWindow);
  assert.ok(carrier);
  assert.match(
    carrier.argv.join(" "),
    new RegExp(`claude --session-id ${session.sessions.claude.nativeSessionId}`)
  );
});

test("builds Codex start and recovery plans through the unified executor adapter", async () => {
  const { resolveAgentAdapter, resolveAgentExecutor } = await import("../dist/executor/executorRegistry.js");
  const home = createTaskmuxHome();

  try {
    const command = createFakeAgentCli(home, "codex-executor", "codex");
    const processEnv = { HOME: "/tmp/executor-home", CODEX_HOME: "/tmp/codex" };
    const agent = agentDefinitionFixture("codex", command, {
      baseArgs: ["--strict-config"],
      environment: [{ target: "CODEX_HOME", source: "process", sourceName: "CODEX_HOME", required: true }]
    });
    const role = taskRoleFixture();
    const configFingerprint = resolveAgentAdapter("codex").fingerprint(
      role.agentBindings.codex.config,
      { workspace: role.workspace, agent }
    );
    const sessionSet = taskRoleSessionSetFixture({
      nativeSessionId: "codex-thread-1",
      sessionRoot: "/tmp/codex",
      configFingerprint
    });
    const session = sessionSet.sessions[sessionSet.activeAgentId];
    const executor = resolveAgentExecutor("codex");
    const now = new Date("2026-07-11T00:00:00.000Z");

    assert.deepEqual(executor.prepare({
      taskId: "task-1", role, agent, mode: "new", session: null, now, processEnv
    }), {
      launch: {
        command,
        args: ["--strict-config", "--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
        env: { CODEX_HOME: "/tmp/codex", HOME: "/tmp/executor-home" }
      },
      session: null
    });
    assert.deepEqual(executor.prepare({
      taskId: "task-1", role, agent, mode: "resume", session, now, processEnv
    }), {
      launch: {
        command,
        args: [
          "--strict-config",
          "--sandbox", "workspace-write",
          "--ask-for-approval", "on-request",
          "resume", "codex-thread-1"
        ],
        env: { CODEX_HOME: "/tmp/codex", HOME: "/tmp/executor-home" }
      },
      session
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("every Agent executor passes the common runtime operation contract", async () => {
  const { resolveAgentAdapter, resolveAgentExecutor } = await import("../dist/executor/executorRegistry.js");
  const now = new Date("2026-07-11T00:00:00.000Z");
  const home = createTaskmuxHome();

  try {
    for (const agentId of ["codex", "claude"]) {
      const calls = [];
      const runtime = {
        dispatchRole: (...args) => calls.push(["dispatch", ...args]),
        sendRoleInput: (...args) => calls.push(["send", ...args]),
        stopRole: (...args) => calls.push(["interrupt", ...args]),
        killRole: (...args) => calls.push(["stop", ...args]),
        detectRoleStatus: () => "running"
      };
      const command = createFakeAgentCli(home, `${agentId}-executor`, agentId);
      const agent = agentDefinitionFixture(agentId, command, { baseArgs: ["--safe"] });
      const role = taskRoleFixture({ agentId });
      const processEnv = {
        HOME: "/tmp/executor-home",
        CODEX_HOME: "/tmp/codex",
        CLAUDE_CONFIG_DIR: "/tmp/claude"
      };
      const run = {
        schemaVersion: 1,
        id: "agent-run-1",
        taskId: "task-1",
        roleName: "reviewer",
        mode: "new",
        input: "Review",
        status: "active",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      const executor = resolveAgentExecutor(agentId);
      const started = executor.start({
        runtime, taskmuxHome: "/tmp/taskmux", taskId: "task-1", role, agent, run,
        session: null, input: "Review", now, processEnv
      });
      const nativeId = agentId === "codex"
        ? executor.discoverNativeSessionId(started.session, { CODEX_THREAD_ID: "codex-thread-1" })
        : executor.discoverNativeSessionId(started.session, {});

      assert.notEqual(nativeId, null);
      const configFingerprint = resolveAgentAdapter(agentId).fingerprint(
        role.agentBindings[agentId].config,
        { workspace: role.workspace, agent }
      );
      const sessionSet = taskRoleSessionSetFixture({
        agentId,
        nativeSessionId: nativeId,
        sessionRoot: agentId === "codex" ? "/tmp/codex" : "/tmp/claude",
        configFingerprint
      });
      const session = sessionSet.sessions[sessionSet.activeAgentId];
      const expectedPrefix = agentId === "codex"
        ? ["--safe", "--sandbox", "workspace-write", "--ask-for-approval", "on-request"]
        : [
            "--safe",
            "--permission-mode", "plan",
            "--allowed-tools", "Bash(git status)", "Read",
            "--disallowed-tools", "Write"
          ];

      assert.deepEqual(
        started.launch.args,
        agentId === "codex" ? expectedPrefix : [...expectedPrefix, "--session-id", nativeId]
      );
      assert.equal(session.permissionEnvelope.adapterId, agentId);
      if (agentId === "claude") {
        assert.deepEqual(
          [...session.permissionEnvelope.allowedToolHashes].sort(),
          session.permissionEnvelope.allowedToolHashes
        );
        assert.deepEqual(
          [...session.permissionEnvelope.disallowedToolHashes].sort(),
          session.permissionEnvelope.disallowedToolHashes
        );
        assert.doesNotMatch(JSON.stringify(session.permissionEnvelope), /Bash|Read|Write/);
      }

      const recovered = executor.recover({
        runtime, taskmuxHome: "/tmp/taskmux", taskId: "task-1", role, agent,
        run: { ...run, mode: "resume" }, session, input: "Continue", now, processEnv
      });
      assert.deepEqual(
        recovered.launch.args,
        agentId === "codex"
          ? [...expectedPrefix, "resume", nativeId]
          : [...expectedPrefix, "--resume", nativeId]
      );
      executor.send({ runtime, taskId: "task-1", role, input: "More context" });
      executor.interrupt({ runtime, taskId: "task-1", role });
      executor.stop({ runtime, taskId: "task-1", role });

      assert.equal(executor.status({ runtime, taskId: "task-1", role }), "running");
      assert.match(nativeId, agentId === "codex" ? /codex-thread-1/ : /^[0-9a-f-]{36}$/);
      assert.equal(calls.filter(([type]) => type === "dispatch").length, 2);
      assert.equal(calls.find(([type]) => type === "dispatch")[5].replaceExisting, true);
      assert.equal(calls.filter(([type]) => type === "dispatch")[1][5].replaceExisting, false);
      assert.deepEqual(calls.slice(-3).map(([type]) => type), ["send", "interrupt", "stop"]);
      assert.match(calls[0][3].env.TASKMUX_RUN_ID, /agent-run-1/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("preallocates and records a native session id for a new Claude dispatch", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile, carrierLogFile } = createFakeTmux(home);
  const env = { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile };

  runTaskmux(["task", "create", "Delegate a Claude review"], env);
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "claude", "--workspace", "/tmp/project-a"],
    env
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Review the release"],
    env
  );

  const session = taskRoleSessionSet(home, "task-1", "reviewer");
  const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const newWindow = calls.find((call) => call[0] === "new-window");
  const carrier = fakeCarrierCalls(carrierLogFile).at(-1);

  assert.match(session.sessions.claude.nativeSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(session.activeAgentId, "claude");
  assertPrivateCarrierWindow(newWindow);
  assert.ok(carrier);
  assert.match(carrier.argv.join(" "), new RegExp(`claude --session-id ${session.sessions.claude.nativeSessionId}`));
  assert.ok(carrier.argv.includes(`TASKMUX_NATIVE_SESSION_ID=${session.sessions.claude.nativeSessionId}`));
});

test("asks a new Codex role to register the executor-provided thread id", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const env = { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile };

  runTaskmux(["task", "create", "Register a Codex session"], env);
  runTaskmux(
    ["task", "dispatch", "task-1", "leader", "--mode", "new", "--input", "Begin stewardship"],
    env
  );
  const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const literalInput = calls.find((call) => call[0] === "send-keys" && call[1] === "-l");

  assert.ok(literalInput);
  assert.match(literalInput.at(-1), /CODEX_THREAD_ID/);
  assert.match(literalInput.at(-1), /task session record/);
});

test("replaces an existing tmux role window when the Leader selects a new session", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createExistingRoleTmux(home, "reviewer");
  const env = { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile };

  runTaskmux(["task", "create", "Restart a role with fresh context"], env);
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "claude", "--workspace", "/tmp/project-a"],
    env
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Start from fresh context"],
    env
  );

  const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.some((call) => call[0] === "kill-window" && call.at(-1) === tmuxTarget(home, "task-1", "reviewer")));
  assertPrivateCarrierWindowRenamedForRole(calls, home, "task-1", "reviewer");
});

test("dispatches a role synchronously while its agent work continues in tmux", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile, carrierLogFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Continue release work"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "session", "record", "task-1", "leader", "--native-id", "codex-session-1"],
    { TASKMUX_HOME: home }
  );
  const output = runTaskmux(
    ["task", "dispatch", "task-1", "leader", "--mode", "resume", "--input", "Continue the next work item"],
    { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile }
  );
  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const carrier = fakeCarrierCalls(carrierLogFile).at(-1);

  assert.match(output, /Dispatch accepted for task-1\/leader \(resume\)/);
  assert.ok(carrier);
  assert.ok(carrier.argv.includes("TASKMUX_TASK_ID=task-1"));
  assert.match(carrier.argv.join(" "), /codex resume codex-session-1$/);
  const target = taskmuxTmuxTarget(home, "task-1", "leader");
  const literalInput = calls.find((call) => call[0] === "send-keys" && call[1] === "-l");
  assert.deepEqual(literalInput?.slice(0, 5), ["send-keys", "-l", "-t", target, "--"]);
  assert.match(literalInput?.at(-1) ?? "", /# TaskMux Leader/);
  assert.match(literalInput?.at(-1) ?? "", /Continue the next work item$/);
  assert.ok(calls.some((call) => call[0] === "send-keys" && call.at(-1) === "Enter"));
});

test("matches direct and Controller post-commit dispatch behavior", () => {
  function dispatch(controllerMode) {
    const home = createConfiguredHome();
    const { fakeTmux, logFile, carrierLogFile } = createFakeTmux(home);
    const directEnv = {
      TASKMUX_HOME: home,
      TASKMUX_CONTROLLER_MODE: "direct",
      TASKMUX_TMUX_BIN: fakeTmux,
      FAKE_TMUX_LOG: logFile,
      TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "60000"
    };
    const env = { ...directEnv, TASKMUX_CONTROLLER_MODE: controllerMode };

    runTaskmux(
      ["task", "create", "Dispatch parity", "--agent", "claude", "--workspace", "/tmp/project-a"],
      directEnv
    );
    try {
      const output = runTaskmux(
        ["task", "dispatch", "task-1", "leader", "--mode", "new", "--input", "Begin stewardship"],
        env
      );
      const session = taskRoleSessionSet(home, "task-1", "leader");
      const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const carrier = fakeCarrierCalls(carrierLogFile).at(-1);

      return { home, output, session, calls, carrier };
    } finally {
      if (controllerMode !== "direct") {
        runTaskmuxFailure(["controller", "stop"], env);
      }
    }
  }

  const direct = dispatch("direct");
  const automatic = dispatch("auto");

  assert.equal(automatic.output, direct.output);
  assert.match(automatic.output, /Dispatch accepted for task-1\/leader \(new\)/);
  assert.doesNotMatch(automatic.output, /Role dispatch must run as a post-commit effect/);

  for (const result of [direct, automatic]) {
    assert.equal(result.session.activeAgentId, "claude");
    assert.equal(result.session.sessions.claude.status, "running");
    assert.match(result.session.sessions.claude.nativeSessionId, /^[0-9a-f-]{36}$/);
    assertPrivateCarrierWindowRenamedForRole(result.calls, result.home, "task-1", "leader");
    assert.ok(result.carrier);
    assert.ok(result.carrier.argv.includes(
      `TASKMUX_NATIVE_SESSION_ID=${result.session.sessions.claude.nativeSessionId}`
    ));
  }
});

test("deduplicates a Controller dispatch request after its post-commit effect", async () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "60000"
  };

  runTaskmux(
    ["task", "create", "Deduplicate Controller dispatch", "--agent", "claude", "--workspace", "/tmp/project-a"],
    { ...env, TASKMUX_CONTROLLER_MODE: "direct" }
  );
  try {
    runTaskmux(["controller", "start"], env);
    const discovery = JSON.parse(readFileSync(join(home, "runtime", "controller.json"), "utf8"));
    const request = {
      apiVersion: 1,
      requestId: "controller-dispatch-once",
      method: "task.command",
      params: {
        args: ["dispatch", "task-1", "leader", "--mode", "new", "--input", "Begin stewardship"]
      }
    };
    const invoke = () => fetch(`http://${discovery.host}:${discovery.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${discovery.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });

    const first = await invoke();
    const second = await invoke();

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.match(JSON.stringify(await first.json()), /Dispatch accepted for task-1\/leader \(new\)/);
    assert.match(JSON.stringify(await second.json()), /Dispatch accepted for task-1\/leader \(new\)/);
    const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.filter((call) => call[0] === "new-window").length, 1);
    assert.equal(calls.filter((call) => call[0] === "rename-window").length, 1);
    assert.equal(taskRoleSessionSet(home, "task-1", "leader").sessions.claude.status, "running");
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("dispatches roles through an isolated real tmux server", {
  skip: spawnSync("tmux", ["-V"]).status !== 0
}, () => {
  const home = createConfiguredHome();
  const socket = `taskmux-test-${process.pid}-${Date.now()}`;
  const isolatedTmux = join(home, "isolated-tmux.sh");
  writeFileSync(isolatedTmux, `#!/bin/sh
case "$1" in
  has-session|kill-window) exec tmux -L ${socket} "$@" 2>/dev/null ;;
  *) exec tmux -L ${socket} "$@" ;;
esac
`);
  chmodSync(isolatedTmux, 0o755);
  const reviewerWorkspace = join(home, "reviewer-workspace");
  const researcherWorkspace = join(home, "researcher-workspace");
  mkdirSync(reviewerWorkspace, { recursive: true });
  mkdirSync(researcherWorkspace, { recursive: true });
  const loopingCodex = join(home, "looping-codex.sh");
  writeFileSync(loopingCodex, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex-cli 0.144.1'; exit 0; fi
if [ "$1 $2 $3" = "debug models --bundled" ]; then echo '{"models":[]}'; exit 0; fi
while :; do sleep 1; done
`);
  chmodSync(loopingCodex, 0o755);
  runTaskmux(
    ["agent", "update", "codex", "--adapter", "codex", "--command", loopingCodex],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "create", "Exercise real tmux isolation"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", reviewerWorkspace],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "assign", "task-1", "researcher", "--agent", "codex", "--workspace", researcherWorkspace],
    { TASKMUX_HOME: home }
  );

  try {
    runTaskmux(
      ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Review"],
      { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: isolatedTmux }
    );
    runTaskmux(
      ["task", "dispatch", "task-1", "researcher", "--mode", "new", "--input", "Research"],
      { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: isolatedTmux }
    );
    const windows = execFileSync(
      "tmux",
      ["-L", socket, "list-windows", "-t", taskmuxTmuxSessionName(home, "task-1"), "-F", "#{window_name}|#{pane_current_path}"],
      { encoding: "utf8" }
    );
    assert.match(windows, new RegExp(`^reviewer\\|${escapeRegex(reviewerWorkspace)}$`, "m"));
    assert.match(windows, new RegExp(`^researcher\\|${escapeRegex(researcherWorkspace)}$`, "m"));
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"]);
  }
});

test("links a dispatch run to its finite WorkItem and Topics", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const env = { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile };

  runTaskmux(["task", "create", "Review deployment safety"], env);
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    env
  );
  runTaskmux(
    [
      "task", "work-item", "create", "task-1",
      "--title", "Review rollback safety", "--assignee", "reviewer", "--topic", "deployment"
    ],
    env
  );
  runTaskmux(
    [
      "task", "dispatch", "task-1", "reviewer", "--mode", "new",
      "--work-item", "work-item-1", "--topic", "testing", "--input", "Run the review"
    ],
    env
  );

  const run = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "agent-runs", "agent-run-1.json"), "utf8")
  );
  const workItem = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "work-items", "work-item-1.json"), "utf8")
  );

  assert.equal(run.workItemId, "work-item-1");
  assert.deepEqual(run.topics, ["deployment", "testing"]);
  assert.match(run.input, /WorkItem work-item-1: Review rollback safety/);
  assert.equal(workItem.status, "running");

  runTaskmux(
    ["task", "session", "record", "task-1", "reviewer", "--native-id", "reviewer-work-item-session"],
    env
  );
  runTaskmux(
    ["task", "yield", "task-1", "reviewer", "--summary", "Rollback safety is verified."],
    env
  );
  const completedWorkItem = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "work-items", "work-item-1.json"), "utf8")
  );
  assert.equal(completedWorkItem.status, "completed");
  assert.equal(completedWorkItem.outcome, "Rollback safety is verified.");
  assert.match(completedWorkItem.endedAt, /^\d{4}-/);
});

test("injects TaskMux role context and the matching system skill into a dispatch", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile, carrierLogFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Review release context"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Review the release"],
    { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile }
  );

  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const newWindow = calls.find((call) => call[0] === "new-window");
  const carrier = fakeCarrierCalls(carrierLogFile).at(-1);
  assert.ok(carrier);
  const carrierEnv = fakeCarrierEnvironment(carrier);
  const literalInput = calls.find((call) => call[0] === "send-keys" && call[1] === "-l");

  assertPrivateCarrierWindow(newWindow);
  assert.equal(carrierEnv.TASKMUX_HOME, home);
  assert.equal(carrierEnv.TASKMUX_TASK_ID, "task-1");
  assert.equal(carrierEnv.TASKMUX_ROLE, "reviewer");
  assert.equal(carrierEnv.TASKMUX_RUN_ID, "agent-run-1");
  assert.equal(carrierEnv.TASKMUX_WORKSPACE, "/tmp/project-a");
  assert.ok(literalInput);
  assert.match(literalInput.at(-1), /# TaskMux Worker/);
  assert.match(literalInput.at(-1), /Review the release/);
});

test("merges configured custom Skill content into the system Skill dispatch context", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const skillDir = join(home, "skills", "security-review");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Security review\n\nInspect trust boundaries and secret handling.\n");
  runTaskmux(
    [
      "role", "add", "security-reviewer", "--agent", "codex", "--workspace", "/tmp/project-a",
      "--skill", "security-review"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "create", "Review security boundaries"], { TASKMUX_HOME: home });
  runTaskmux(["task", "bind", "task-1", "security-reviewer"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "dispatch", "task-1", "security-reviewer", "--mode", "new", "--input", "Review now"],
    { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile }
  );

  const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const literalInput = calls.find((call) => call[0] === "send-keys" && call[1] === "-l").at(-1);
  assert.match(literalInput, /# TaskMux Worker/);
  assert.match(literalInput, /# Security review/);
  assert.match(literalInput, /Inspect trust boundaries and secret handling/);
});

test("rejects a second dispatch while the same role already has an active run", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const env = { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile };

  runTaskmux(["task", "create", "Avoid overlapping role work"], env);
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    env
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "First round"],
    env
  );

  const rejected = runTaskmuxFailure(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Overlapping round"],
    env
  );

  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /already has an active agent run/);
});

test("records an agent run and wakes the leader when an independent role yields", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);

  runTaskmux(["task", "create", "Review release risks"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Review rollback risks"],
    { TASKMUX_HOME: home, TASKMUX_TMUX_BIN: fakeTmux, FAKE_TMUX_LOG: logFile }
  );
  const activeRunPath = join(home, "runtime", "active-runs", "task-1", "reviewer.json");
  const activeRun = JSON.parse(readFileSync(activeRunPath, "utf8"));

  assert.equal(activeRun.status, "active");
  assert.equal(activeRun.roleName, "reviewer");

  runTaskmux(
    ["task", "session", "record", "task-1", "reviewer", "--native-id", "reviewer-yield-session"],
    { TASKMUX_HOME: home }
  );
  const output = runTaskmux(
    ["task", "yield", "task-1", "reviewer", "--summary", "Rollback requires a database compatibility check."],
    { TASKMUX_HOME: home }
  );
  const storedRun = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "agent-runs", "agent-run-1.json"), "utf8")
  );
  const pendingWakeup = JSON.parse(
    readFileSync(join(home, "runtime", "pending-wakeups", "task-1.json"), "utf8")
  );

  assert.match(output, /Yielded agent-run-1 from task-1\/reviewer/);
  assert.equal(existsSync(activeRunPath), false);
  assert.equal(storedRun.status, "yielded");
  assert.equal(storedRun.summary, "Rollback requires a database compatibility check.");
  assert.deepEqual(pendingWakeup.reasons, ["role-result"]);
});

test("resolves context and yield scope from the role session environment", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile, carrierLogFile } = createFakeTmux(home);
  const baseEnv = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    CODEX_THREAD_ID: "scoped-session"
  };

  runTaskmux(["task", "create", "Use scoped role commands"], baseEnv);
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    baseEnv
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Review"],
    baseEnv
  );
  const carrier = fakeCarrierCalls(carrierLogFile).at(-1);
  assert.ok(carrier);
  const roleEnv = { ...baseEnv, ...fakeCarrierEnvironment(carrier) };

  runTaskmux(["task", "session", "record", "--native-id", "scoped-session"], roleEnv);
  const context = JSON.parse(runTaskmux(["task", "context", "--format", "json"], roleEnv));
  const yielded = runTaskmux(["task", "yield", "--summary", "Review is complete"], roleEnv);

  assert.equal(context.task.id, "task-1");
  assert.equal(context.sessions.reviewer.sessions.codex.nativeSessionId, "scoped-session");
  assert.match(yielded, /Yielded agent-run-1 from task-1\/reviewer/);
});

test("wakes an inactive unarchived task only when no agent run is active", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Wait for an external deployment"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "schedule", "set", "task-1", "--inactivity-minutes", "0", "--cooldown-minutes", "30"],
    { TASKMUX_HOME: home }
  );
  const output = runTaskmux(["controller", "scan"], { TASKMUX_HOME: home });
  const wakeup = JSON.parse(
    readFileSync(join(home, "runtime", "pending-wakeups", "task-1.json"), "utf8")
  );

  assert.match(output, /Queued 1 task wakeup/);
  assert.deepEqual(wakeup.reasons, ["inactivity"]);

  runTaskmux(["task", "archive", "task-1"], { TASKMUX_HOME: home });
  const secondScan = runTaskmux(["controller", "scan"], { TASKMUX_HOME: home });
  assert.match(secondScan, /Queued 0 task wakeups/);
});

test("suppresses a repeated inactivity wakeup during the configured cooldown", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "50"
  };

  runTaskmux(["task", "create", "Avoid repeated idle reviews"], env);
  runTaskmux(
    ["task", "session", "record", "task-1", "leader", "--native-id", "codex-session-1"],
    env
  );
  runTaskmux(
    ["task", "schedule", "set", "task-1", "--inactivity-minutes", "0", "--cooldown-minutes", "60"],
    env
  );
  runTaskmux(["task", "wake", "task-1", "--reason", "initial-review"], env);

  try {
    runTaskmux(["controller", "start"], env);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }

  runTaskmux(["task", "yield", "task-1", "leader", "--summary", "No action needed yet."], env);
  const scan = runTaskmux(["controller", "scan"], env);
  const schedule = JSON.parse(readFileSync(join(home, "tasks", "task-1", "schedule.json"), "utf8"));

  assert.match(scan, /Queued 0 task wakeups/);
  assert.match(schedule.lastLeaderWakeupAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), false);
});

test("expires an abandoned agent run and wakes the leader once", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile, stateFile } = createStatefulTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    FAKE_TMUX_STATE: stateFile,
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "25",
    TASKMUX_AGENT_RUN_TTL_MS: "25"
  };

  runTaskmux(["task", "create", "Recover an abandoned review"], env);
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    env
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Review the release"],
    env
  );

  try {
    runTaskmux(["controller", "start"], env);
    waitForCondition(() => {
      const runFile = join(home, "tasks", "task-1", "agent-runs", "agent-run-1.json");
      const eventsFile = join(home, "tasks", "task-1", "events.jsonl");
      if (!existsSync(runFile) || !existsSync(eventsFile)) return false;
      const storedRun = JSON.parse(readFileSync(runFile, "utf8"));
      if (storedRun.status !== "expired") return false;
      return readFileSync(eventsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .some((event) => event.type === "leader.wakeup_dispatched");
    }, "the abandoned AgentRun expiry and Leader wakeup");
    const storedRun = JSON.parse(
      readFileSync(join(home, "tasks", "task-1", "agent-runs", "agent-run-1.json"), "utf8")
    );
    const reviewer = JSON.parse(
      readFileSync(join(home, "tasks", "task-1", "roles", "reviewer", "role.json"), "utf8")
    );
    const events = readFileSync(join(home, "tasks", "task-1", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(storedRun.status, "expired");
    assert.equal(reviewer.status, "idle");
    assert.match(storedRun.endedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(existsSync(join(home, "runtime", "active-runs", "task-1", "reviewer.json")), false);
    assert.equal(events.filter((event) => event.type === "leader.wakeup_dispatched").length, 1);
    assert.match(
      events.find((event) => event.type === "leader.wakeup_dispatched").payload.reasons,
      /role-run-expired/
    );
    assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), false);
    assert.match(runTaskmux(["controller", "scan"], env), /Queued 0 task wakeups/);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("fails an unregistered Codex AgentRun after the native session registration deadline", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile, stateFile } = createStatefulTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    FAKE_TMUX_STATE: stateFile,
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "25",
    TASKMUX_AGENT_RUN_TTL_MS: "99999999",
    TASKMUX_NATIVE_SESSION_REGISTRATION_TTL_MS: "25"
  };

  runTaskmux(["task", "create", "Reject an unregistered Codex review"], env);
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    env
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Review the release"],
    env
  );

  try {
    runTaskmux(["controller", "start"], env);
    const store = new FileTaskStore(home);
    let terminalState = null;
    waitForCondition(() => {
      terminalState = store.runReadSnapshot((snapshot) => {
        const storedRun = snapshot.getAgentRun("task-1", "agent-run-1");
        const reviewer = snapshot.getRole("task-1", "reviewer");
        if (storedRun?.status !== "failed" || reviewer?.status !== "failed") return null;
        return { storedRun, reviewer };
      });
      return terminalState !== null;
    }, "the unregistered Codex AgentRun to fail");

    assert.ok(terminalState);
    assert.equal(terminalState.storedRun.status, "failed");
    assert.equal(terminalState.reviewer.status, "failed");
    assert.match(terminalState.storedRun.summary, /did not register its native session identity/i);
    assert.match(runTaskmux(["controller", "scan"], env), /Queued 0 task wakeups/);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("fails an active role run immediately when its tmux window has exited", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFakeTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    TASKMUX_AGENT_RUN_TTL_MS: "99999999"
  };

  runTaskmux(["task", "create", "Notice a failed review process"], env);
  runTaskmux(
    ["task", "assign", "task-1", "reviewer", "--agent", "codex", "--workspace", "/tmp/project-a"],
    env
  );
  runTaskmux(
    ["task", "dispatch", "task-1", "reviewer", "--mode", "new", "--input", "Review the release"],
    env
  );

  runTaskmux(["controller", "scan"], env);
  const storedRun = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "agent-runs", "agent-run-1.json"), "utf8")
  );
  const wakeup = JSON.parse(
    readFileSync(join(home, "runtime", "pending-wakeups", "task-1.json"), "utf8")
  );
  const role = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "roles", "reviewer", "role.json"), "utf8")
  );

  assert.equal(storedRun.status, "failed");
  assert.equal(role.status, "exited");
  assert.equal(existsSync(join(home, "runtime", "active-runs", "task-1", "reviewer.json")), false);
  assert.deepEqual(wakeup.reasons, ["role-run-failed"]);
});

test("controller periodically performs the inactivity safety scan", () => {
  const home = createConfiguredHome();
  const { fakeTmux } = createFailingDispatchTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "50"
  };

  runTaskmux(["task", "create", "Keep an unattended task moving"], env);
  runTaskmux(
    ["task", "schedule", "set", "task-1", "--inactivity-minutes", "0", "--cooldown-minutes", "30"],
    env
  );

  try {
    runTaskmux(["controller", "start"], env);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    const wakeup = JSON.parse(
      readFileSync(join(home, "runtime", "pending-wakeups", "task-1.json"), "utf8")
    );
    assert.deepEqual(wakeup.reasons, ["inactivity"]);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("runs an explicit Scheduler scan as a recoverable one-shot transaction", () => {
  const home = createConfiguredHome();
  runTaskmux(["task", "create", "Transactional explicit scan"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "schedule", "set", "task-1", "--inactivity-minutes", "0", "--cooldown-minutes", "30"],
    { TASKMUX_HOME: home }
  );

  const result = runTaskmuxFailure(["controller", "scan"], {
    TASKMUX_HOME: home,
    NODE_ENV: "test",
    TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT: "after-stage"
  });

  assert.equal(result.status, 5);
  assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), false);
  assert.equal(readdirSync(join(home, "runtime", "domain-transactions")).length, 1);
  assert.equal(existsSync(join(home, "runtime", "controller.json")), false);
});

test("routes an explicit Scheduler scan to an already running Controller", () => {
  const home = createConfiguredHome();
  const env = { TASKMUX_HOME: home, TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "60000" };

  try {
    runTaskmux(["controller", "start"], env);
    assert.match(runTaskmux(["controller", "scan"], env), /Queued 0 task wakeups/);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("controller replays a staged Scheduler transaction without dispatching twice", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile, stateFile } = createStatefulTmux(home);
  runTaskmux(["task", "create", "Recover Scheduler state"], { TASKMUX_HOME: home });
  runTaskmux(
    ["task", "session", "record", "task-1", "leader", "--native-id", "scheduler-session"],
    { TASKMUX_HOME: home }
  );
  runTaskmux(["task", "wake", "task-1", "--reason", "explicit-wake"], { TASKMUX_HOME: home });
  const failingEnv = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    FAKE_TMUX_STATE: stateFile,
    NODE_ENV: "test",
    TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT: "after-stage",
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "60000"
  };

  try {
    runTaskmux(["controller", "start"], failingEnv);
    waitForCondition(
      () => readdirSync(join(home, "runtime", "domain-transactions")).length === 1,
      "the staged Scheduler transaction"
    );
    assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), true);
    assert.equal(readdirSync(join(home, "runtime", "domain-transactions")).length, 1);
    runTaskmuxFailure(["controller", "stop"], failingEnv);

    const recoveredEnv = {
      TASKMUX_HOME: home,
      TASKMUX_TMUX_BIN: fakeTmux,
      FAKE_TMUX_LOG: logFile,
      FAKE_TMUX_STATE: stateFile,
      TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "60000"
    };
    runTaskmux(["controller", "start"], recoveredEnv);
    waitForCondition(
      () => existsSync(join(home, "runtime", "active-runs", "task-1", "leader.json")),
      "the recovered Leader dispatch"
    );
    assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), false);
    assert.equal(existsSync(join(home, "runtime", "active-runs", "task-1", "leader.json")), true);
    const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.filter((call) => call[0] === "send-keys" && call[1] === "-l").length, 1);
  } finally {
    runTaskmuxFailure(["controller", "stop"], { TASKMUX_HOME: home });
  }
});

test("controller recovers the fixed leader session to process a pending wakeup", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile, stateFile } = createStatefulTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    FAKE_TMUX_LOG: logFile,
    FAKE_TMUX_STATE: stateFile,
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "50"
  };

  runTaskmux(["task", "create", "Process submitted information"], env);
  runTaskmux(
    ["task", "session", "record", "task-1", "leader", "--native-id", "codex-session-1"],
    env
  );
  runTaskmux(["task", "comment", "task-1", "The release is now available."], env);

  try {
    runTaskmux(["controller", "start"], env);
    waitForCondition(
      () => existsSync(join(home, "runtime", "active-runs", "task-1", "leader.json")),
      "the fixed Leader session recovery"
    );
    const activeRun = JSON.parse(
      readFileSync(join(home, "runtime", "active-runs", "task-1", "leader.json"), "utf8")
    );
    const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));

    assert.equal(activeRun.roleName, "leader");
    assert.equal(activeRun.mode, "resume");
    assert.match(activeRun.input, /user-comment/);
    assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), false);
    const carrier = calls.find((call) => call[0] === "carrier");
    assert.ok(carrier);
    assert.match(carrier[1], /TASKMUX_HOME=/);
    assert.match(carrier[1], /TASKMUX_TASK_ID=task-1/);
    assert.match(carrier[1], /TASKMUX_ROLE=leader/);
    assert.match(carrier[1], /TASKMUX_RUN_ID=agent-run-1/);
    assert.match(carrier[1], /codex resume codex-session-1/);
    assert.match(activeRun.input, /# TaskMux Leader/);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }
});

test("pauses leader wakeups after recovery failure until the session is explicitly replaced", () => {
  const home = createConfiguredHome();
  const { fakeTmux, logFile } = createFailingDispatchTmux(home);
  const env = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: fakeTmux,
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "25"
  };

  runTaskmux(["task", "create", "Repair a broken Leader session"], env);
  runTaskmux(
    ["task", "session", "record", "task-1", "leader", "--native-id", "broken-session"],
    env
  );
  runTaskmux(["task", "wake", "task-1", "--reason", "scheduled-review"], env);

  try {
    runTaskmux(["controller", "start"], env);
    waitForCondition(
      () =>
        existsSync(join(home, "runtime", "leader-failures", "task-1.json")) &&
        existsSync(join(home, "runtime", "operator-notifications", "task-1.json")),
      "the durable Leader recovery failure"
    );
    const failure = JSON.parse(
      readFileSync(join(home, "runtime", "leader-failures", "task-1.json"), "utf8")
    );
    const notification = JSON.parse(
      readFileSync(join(home, "runtime", "operator-notifications", "task-1.json"), "utf8")
    );
    runTaskmuxFailure(["controller", "stop"], env);
    const context = JSON.parse(
      runTaskmux(["task", "context", "task-1", "--format", "json"], env)
    );

    assert.equal(failure.nativeSessionId, "broken-session");
    assert.equal(failure.attemptCount, 1);
    assert.equal(notification.type, "leader-recovery-failed");
    assert.equal(notification.taskId, "task-1");
    assert.match(notification.message, /tmux|dispatch|session/i);
    const calls = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(calls.some((call) =>
      call[0] === "send-keys" &&
      call.some((value) => typeof value === "string" && value.endsWith("-operator:operator"))
    ));
    assert.equal(context.leaderFailure.attemptCount, 1);
    assert.equal(existsSync(join(home, "runtime", "pending-wakeups", "task-1.json")), true);
  } finally {
    runTaskmuxFailure(["controller", "stop"], env);
  }

  runTaskmux(
    [
      "task", "session", "replace", "task-1", "leader",
      "--native-id", "replacement-session", "--reason", "original session is irrecoverable"
    ],
    env
  );
  assert.equal(existsSync(join(home, "runtime", "leader-failures", "task-1.json")), false);
  assert.equal(existsSync(join(home, "runtime", "operator-notifications", "task-1.json")), false);
});

test("coalesces one-off review and recurring schedule firings without reopening the task", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Run the daily deployment check"], { TASKMUX_HOME: home });
  runTaskmux(
    [
      "task", "schedule", "set", "task-1",
      "--inactivity-minutes", "999999",
      "--cooldown-minutes", "30",
      "--review-at", "2020-01-01T00:00:00.000Z",
      "--every-minutes", "1440",
      "--next-at", "2020-01-01T00:00:00.000Z"
    ],
    { TASKMUX_HOME: home }
  );

  const firstScan = runTaskmux(["controller", "scan"], { TASKMUX_HOME: home });
  const wakeup = JSON.parse(
    readFileSync(join(home, "runtime", "pending-wakeups", "task-1.json"), "utf8")
  );
  const schedule = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "schedule.json"), "utf8")
  );
  const task = JSON.parse(readFileSync(join(home, "tasks", "task-1", "task.json"), "utf8"));

  assert.match(firstScan, /Queued 1 task wakeup/);
  assert.deepEqual(wakeup.reasons, ["review-time", "schedule"]);
  assert.equal(schedule.reviewAt, undefined);
  assert.ok(Date.parse(schedule.recurring.nextAt) > Date.now());
  assert.equal(task.archived, false);
  assert.match(runTaskmux(["controller", "scan"], { TASKMUX_HOME: home }), /Queued 0 task wakeups/);
});

test("persists the leader brief and curated milestones in user-readable files", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Modernize deployment"], { TASKMUX_HOME: home });
  runTaskmux(
    [
      "task", "brief", "update", "task-1",
      "--objective", "Make deployments repeatable",
      "--boundary", "Do not change the cloud provider",
      "--focus", "Canary verification",
      "--leader-summary", "The release pipeline works; rollback is still manual."
    ],
    { TASKMUX_HOME: home }
  );
  const milestoneOutput = runTaskmux(
    [
      "task", "milestone", "add", "task-1",
      "--title", "Canary pipeline verified",
      "--summary", "The canary environment now deploys and rolls back cleanly.",
      "--topic", "deployment",
      "--topic", "testing"
    ],
    { TASKMUX_HOME: home }
  );
  const brief = readFileSync(join(home, "tasks", "task-1", "brief.md"), "utf8");
  const timeline = readFileSync(join(home, "tasks", "task-1", "timeline.md"), "utf8");
  const milestone = JSON.parse(
    readFileSync(join(home, "tasks", "task-1", "milestones", "milestone-1.json"), "utf8")
  );
  const context = JSON.parse(
    runTaskmux(["task", "context", "task-1", "--format", "json"], { TASKMUX_HOME: home })
  );

  assert.match(brief, /## Objective\n\nMake deployments repeatable/);
  assert.match(brief, /## Current focus\n\nCanary verification/);
  assert.match(milestoneOutput, /Added milestone milestone-1/);
  assert.deepEqual(milestone.topics, ["deployment", "testing"]);
  assert.match(timeline, /Canary pipeline verified/);
  assert.match(timeline, /The canary environment now deploys/);
  assert.match(context.brief, /Make deployments repeatable/);
  assert.deepEqual(context.topics.builtIn.map((topic) => topic.id).slice(0, 2), ["requirements", "architecture"]);
});

test("records and supersedes durable decisions with Topic associations", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Choose a deployment strategy"], { TASKMUX_HOME: home });
  runTaskmux(
    [
      "task", "decision", "record", "task-1",
      "--title", "Use canary deployment",
      "--rationale", "Canary limits rollback impact while preserving feedback speed.",
      "--topic", "architecture", "--topic", "deployment"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    [
      "task", "decision", "supersede", "task-1", "decision-1",
      "--reason", "The platform now provides native blue-green routing."
    ],
    { TASKMUX_HOME: home }
  );

  const context = JSON.parse(
    runTaskmux(["task", "context", "task-1", "--format", "json"], { TASKMUX_HOME: home })
  );
  const timeline = readFileSync(join(home, "tasks", "task-1", "timeline.md"), "utf8");

  assert.equal(context.decisions[0].id, "decision-1");
  assert.equal(context.decisions[0].status, "superseded");
  assert.deepEqual(context.decisions[0].topics, ["architecture", "deployment"]);
  assert.match(context.decisions[0].supersededReason, /blue-green/);
  assert.match(timeline, /Use canary deployment/);
});

test("shows durable focus and finite progress on the task board", () => {
  const home = createConfiguredHome();

  runTaskmux(["task", "create", "Track release progress"], { TASKMUX_HOME: home });
  runTaskmux(
    [
      "task", "brief", "update", "task-1",
      "--objective", "Ship safely",
      "--focus", "Canary validation",
      "--leader-summary", "Preparing the first canary"
    ],
    { TASKMUX_HOME: home }
  );
  runTaskmux(
    ["task", "work-item", "create", "task-1", "--title", "Run canary"],
    { TASKMUX_HOME: home }
  );

  const board = runTaskmux(["task", "board", "--with-roles"], { TASKMUX_HOME: home });
  assert.match(board, /focus=Canary validation/);
  assert.match(board, /work pending=1/);
});
