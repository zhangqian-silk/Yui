import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readControllerDiscovery, callController } from "../dist/controller/controller.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";

const cli = join(process.cwd(), "dist", "cli.js");

function runTaskmux(args, environment) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      TASKMUX_CONTROLLER_MODE: "direct",
      ...environment
    }
  });
}

function runTaskmuxFailure(args, environment) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      TASKMUX_CONTROLLER_MODE: "direct",
      ...environment
    }
  });
}

function createFakeCarrier(home) {
  const bin = join(home, "carrier-bin");
  const logFile = join(home, "carrier.log");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "env"),
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.FAKE_CARRIER_LOG, process.argv.slice(2).join(" ") + "\\n");
`
  );
  chmodSync(join(bin, "env"), 0o755);
  return { bin, logFile };
}

function createFakeTmux(home) {
  const { bin, logFile: carrierLog } = createFakeCarrier(home);
  const executable = join(home, "tmux");
  const logFile = join(home, "tmux.log");
  const sessionFile = join(home, "tmux-session");
  const windowFile = join(home, "tmux-window");
  const optionFile = join(home, "tmux-options.json");
  writeFileSync(
    executable,
    `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(args) + "\\n");
const sessionFile = ${JSON.stringify(sessionFile)};
const windowFile = ${JSON.stringify(windowFile)};
const optionFile = ${JSON.stringify(optionFile)};
const readOptions = () => existsSync(optionFile) ? JSON.parse(readFileSync(optionFile, "utf8")) : {};
const writeOptions = (value) => writeFileSync(optionFile, JSON.stringify(value));
const ensurePaneOptions = (options, target) => options[target] ??= {};
if (args[0] === "has-session") process.exit(existsSync(sessionFile) ? 0 : 1);
if (args[0] === "new-session") {
  writeFileSync(sessionFile, "");
  process.exit(0);
}
if (args[0] === "list-windows") {
  if (existsSync(windowFile)) {
    const windows = process.env.FAKE_TMUX_WINDOWS ?? "leader";
    process.stdout.write(windows.endsWith("\\n") ? windows : windows + "\\n");
  }
  process.exit(0);
}
if (args[0] === "if-shell" && process.env.FAKE_TMUX_FAIL_OPERATOR_DELIVERY === "1") {
  process.stderr.write("simulated Operator delivery failure\\n");
  process.exit(1);
}
const exactCondition = args[0] === "if-shell" && args.includes("-t") &&
  args[args.indexOf("-F") + 1]?.includes("@taskmux_exact_role_input_binding");
if (exactCondition && process.env.FAKE_TMUX_FAIL_LEADER_WAKEUP === "1") {
  process.stderr.write("simulated Leader wakeup failure\\n");
  process.exit(1);
}
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
  const shellIndex = args.lastIndexOf("/bin/sh");
  const result = spawnSync("/bin/sh", args.slice(shellIndex + 1), {
    cwd: cwdIndex === -1 || !existsSync(args[cwdIndex + 1]) ? undefined : args[cwdIndex + 1],
    env: {
      ...process.env,
      PATH: ${JSON.stringify(`${bin}:/usr/bin:/bin`)},
      FAKE_CARRIER_LOG: ${JSON.stringify(carrierLog)}
    },
    stdio: "ignore"
  });
  if (result.status === 0) writeFileSync(windowFile, "leader\\n");
  process.exit(result.status ?? 1);
}
if (args[0] === "rename-window") {
  const options = readOptions();
  const previous = args[args.indexOf("-t") + 1];
  const next = previous.slice(0, previous.lastIndexOf(":") + 1) + args.at(-1);
  options[next] = options[previous] ?? {};
  delete options[previous];
  writeOptions(options);
  process.exit(0);
}
if (args[0] === "kill-window") {
  rmSync(windowFile, { force: true });
  process.exit(0);
}
process.exit(0);
`
  );
  chmodSync(executable, 0o755);
  return { executable, logFile };
}

function createFakeCodex(home) {
  const executable = join(home, "codex");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) process.stdout.write("codex-cli 0.144.1\\n");
else if (args.join(" ") === "debug models --bundled") process.stdout.write('{"models":[]}\\n');
else process.stdout.write("ready\\n");
`
  );
  chmodSync(executable, 0o755);
}

function createFixture(t) {
  const home = mkdtempSync(join(tmpdir(), "taskmux-public-input-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  createFakeCodex(home);
  const tmux = createFakeTmux(home);
  const sessionRoot = join(home, "codex-home");
  mkdirSync(sessionRoot);
  const baseEnv = {
    TASKMUX_HOME: home,
    TASKMUX_TMUX_BIN: tmux.executable,
    FAKE_TMUX_LOG: tmux.logFile,
    CODEX_HOME: sessionRoot,
    PATH: `${home}:${process.env.PATH ?? ""}`
  };

  runTaskmux(["agent", "add", "codex", "--adapter", "codex", "--command", "codex"], baseEnv);
  runTaskmux(["config", "set", "default-agent", "codex"], baseEnv);
  runTaskmux(["config", "set", "default-workspace", home], baseEnv);

  return { home, baseEnv, tmux, sessionRoot };
}

function createLeader(fixture, title) {
  const created = runTaskmux(["task", "create", title], fixture.baseEnv);
  const taskId = /Created task (task-\d+):/.exec(created)?.[1];
  assert.ok(taskId);
  const nativeSessionId = `leader-native-${taskId}`;
  runTaskmux(
    ["task", "session", "record", taskId, "leader", "--native-id", nativeSessionId],
    fixture.baseEnv
  );
  runTaskmux(
    ["task", "dispatch", taskId, "leader", "--mode", "resume", "--input", "Begin stewardship"],
    fixture.baseEnv
  );

  const store = new FileTaskStore(fixture.home);
  const run = store.getActiveAgentRun(taskId, "leader");
  const sessionSet = store.getRoleSessionSet(taskId, "leader");
  const session = sessionSet?.sessions.codex;
  assert.ok(run);
  assert.ok(session);
  assert.ok(
    tmuxCalls(fixture.tmux.logFile).some((call) =>
      call[0] === "set-option" &&
      call.at(-2) === "@taskmux_exact_role_input_binding"
    ),
    "Leader launch must bind its exact native session tuple to the pane"
  );
  return {
    taskId,
    environment: {
      ...fixture.baseEnv,
      TASKMUX_TASK_ID: taskId,
      TASKMUX_ROLE: "leader",
      TASKMUX_RUN_ID: run.id,
      TASKMUX_AGENT_ID: "codex",
      TASKMUX_ADAPTER_ID: "codex",
      TASKMUX_NATIVE_SESSION_ROOT: session.sessionRoot,
      TASKMUX_NATIVE_SESSION_ID: session.nativeSessionId,
      CODEX_THREAD_ID: session.nativeSessionId
    }
  };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function seedLiveOperator(fixture) {
  const sessionRoot = join(fixture.home, "operator-session");
  mkdirSync(sessionRoot);
  const [
    { createRoleSessionSet, recordRoleAgentSession },
    { createGlobalRole },
    { executeDomainTransaction }
  ] = await Promise.all([
    import("../dist/executor/agentExecutor.js"),
    import("../dist/role/role.js"),
    import("../dist/storage/domainTransaction.js")
  ]);
  const now = new Date();
  const role = createGlobalRole("operator", [{
    agentId: "codex",
    adapterId: "codex",
    config: { adapterId: "codex" }
  }], "codex", fixture.home, now);
  let sessions = createRoleSessionSet({ scope: "global", roleName: "operator" }, "codex", now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "operator-native-1",
    policy: "fixed",
    status: "running",
    sessionRoot,
    worktreeRoot: fixture.home,
    configFingerprint: {
      overall: digest("operator-session"),
      replayable: digest("operator-replayable"),
      permission: digest("operator-permission"),
      sessionBound: digest("operator-session-bound")
    },
    permissionEnvelope: {
      adapterId: "codex",
      sandbox: "workspace-write",
      approval: "on-request",
      additionalDirectoryHashes: []
    }
  }, now);
  executeDomainTransaction(fixture.home, "seed-live-operator", (workingRoot) => {
    new FileTaskStore(workingRoot).saveGlobalRoleWithSessionSet(role, sessions);
  });
}

function tmuxCalls(logFile) {
  return readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function provenance(environment) {
  return Object.fromEntries([
    "TASKMUX_TASK_ID",
    "TASKMUX_ROLE",
    "TASKMUX_RUN_ID",
    "TASKMUX_AGENT_ID",
    "TASKMUX_ADAPTER_ID",
    "TASKMUX_NATIVE_SESSION_ROOT",
    "TASKMUX_NATIVE_SESSION_ID"
  ].flatMap((key) => environment[key] === undefined ? [] : [[key, environment[key]]]));
}

function selectionIo(answers) {
  const pending = [...answers];
  return {
    interactive: true,
    json: false,
    width: 100,
    write() {},
    async question() {
      return pending.shift();
    }
  };
}

test("catalog exposes the complete public task input command surface", async () => {
  const { listPublicCommandPaths } = await import("../dist/cli/commandCatalog.js");
  const paths = new Set(listPublicCommandPaths());

  for (const path of [
    "task input request",
    "task input list",
    "task input show",
    "task input answer",
    "task input cancel"
  ]) {
    assert.equal(paths.has(path), true, `missing ${path}`);
  }
});

test("public input selection remains deterministic outside a TTY and in JSON mode", (t) => {
  const fixture = createFixture(t);
  const nonTerminal = runTaskmuxFailure(["task", "input", "show"], fixture.baseEnv);
  assert.equal(nonTerminal.status, 2);
  assert.doesNotMatch(`${nonTerminal.stdout}${nonTerminal.stderr}`, /Select input request/);
  assert.match(nonTerminal.stderr, /Input request id is required/);

  const json = runTaskmuxFailure(["task", "input", "show", "--json"], fixture.baseEnv);
  assert.equal(json.status, 2);
  assert.doesNotMatch(`${json.stdout}${json.stderr}`, /Select input request/);
  assert.match(json.stderr, /Input request id is required/);
});

test("public CLI creates, queries, answers, and cancels task-owned input without bypassing durable state", async (t) => {
  const fixture = createFixture(t);
  const first = createLeader(fixture, "Answer one request");
  await seedLiveOperator(fixture);
  const directLiveEnv = {
    ...first.environment,
    FAKE_TMUX_WINDOWS: "leader\noperator"
  };
  const spoofed = runTaskmuxFailure([
    "task", "input", "request", first.taskId,
    "--question", "Forged request",
    "--policy", "human-only"
  ], {
    ...directLiveEnv,
    TASKMUX_NATIVE_SESSION_ID: "forged-session"
  });
  assert.equal(spoofed.status, 2);
  assert.match(spoofed.stderr, /Current Leader session does not match the active input origin/);
  assert.equal(new FileTaskStore(fixture.home).listInputRequests(first.taskId).length, 0);

  const requestOutput = runTaskmux([
    "task", "input", "request", first.taskId,
    "--question", "Choose a deployment path",
    "--choice", "safe=Safe path",
    "--policy", "timeout",
    "--recommend", "safe",
    "--recommendation-reason", "Safe path is reversible.",
    "--timeout", "30s"
  ], directLiveEnv);
  const requestId = /Created input request ([A-Za-z0-9._:-]+) for task/.exec(requestOutput)?.[1];
  assert.ok(requestId);
  const deliveredRequests = tmuxCalls(fixture.tmux.logFile)
    .filter((call) => call[0] === "if-shell" && call.at(-1).includes("[TaskMux input request delivery"));
  assert.equal(deliveredRequests.length, 1);
  assert.match(deliveredRequests[0].at(-1), new RegExp(`request ${requestId}`));

  const globalList = runTaskmux(["task", "input", "list"], fixture.baseEnv);
  assert.match(globalList, new RegExp(first.taskId));
  assert.match(globalList, /Choose a deployment path/);
  assert.match(runTaskmux(["task", "input", "show", requestId], fixture.baseEnv), /Choose a deployment path/);
  const [{ routeInvocation }, { resolveInteractiveArguments }] = await Promise.all([
    import("../dist/cli/invocationRouter.js"),
    import("../dist/cli/interactiveSelection.js")
  ]);
  const resolve = async (args, answers) => {
    const invocation = routeInvocation(args);
    assert.equal(invocation.kind, "execute");
    return resolveInteractiveArguments(args, invocation.node, new FileTaskStore(fixture.home), selectionIo(answers));
  };
  assert.deepEqual(
    await resolve(["task", "input", "request", "--question", "Interactive question"], [""]),
    {
      kind: "resolved",
      args: ["task", "input", "request", first.taskId, "--question", "Interactive question"]
    }
  );
  assert.deepEqual(
    await resolve(["task", "input", "show"], [""]),
    { kind: "resolved", args: ["task", "input", "show", requestId] }
  );
  assert.deepEqual(
    await resolve(["task", "input", "answer"], ["", ""]),
    {
      kind: "resolved",
      args: ["task", "input", "answer", requestId, "--choice", "safe"]
    }
  );
  assert.match(
    runTaskmux(["task", "input", "answer", requestId, "--choice", "safe"], directLiveEnv),
    new RegExp(`Answered input request ${requestId}`)
  );

  const store = new FileTaskStore(fixture.home);
  assert.equal(store.getInputRequest(first.taskId, requestId).status, "answered");
  assert.equal(store.getInputResolutionWakeup(first.taskId, requestId).status, "completed");
  assert.equal(store.getActiveAgentRun(first.taskId, "leader").status, "active");
  const leaderResolutionInputs = tmuxCalls(fixture.tmux.logFile)
    .filter((call) => call[0] === "if-shell" && call.includes("-t"))
    .filter((call) => call.at(-2).includes("[TaskMux input resolution delivery"));
  assert.equal(leaderResolutionInputs.length, 1);
  assert.match(leaderResolutionInputs[0][leaderResolutionInputs[0].indexOf("-t") + 1], /:leader$/);
  assert.match(leaderResolutionInputs[0].at(-2), new RegExp(`blocked Leader run ${first.environment.TASKMUX_RUN_ID}`));

  const second = createLeader(fixture, "Cancel one request");
  const secondOutput = runTaskmux([
    "task", "input", "request", second.taskId,
    "--question", "Need a cancellation",
    "--policy", "human-only"
  ], second.environment);
  const secondRequestId = /Created input request ([A-Za-z0-9._:-]+) for task/.exec(secondOutput)?.[1];
  assert.ok(secondRequestId);
  assert.deepEqual(
    await resolve(["task", "input", "cancel", "--reason", "No longer needed"], [second.taskId, ""]),
    {
      kind: "resolved",
      args: ["task", "input", "cancel", second.taskId, secondRequestId, "--reason", "No longer needed"]
    }
  );

  assert.match(
    runTaskmux([
      "task", "input", "cancel", second.taskId, secondRequestId, "--reason", "No longer needed"
    ], second.environment),
    new RegExp(`Cancelled input request ${secondRequestId}`)
  );
  assert.equal(store.getInputRequest(second.taskId, secondRequestId).status, "cancelled");
  assert.equal(store.getInputResolutionWakeup(second.taskId, secondRequestId), null);
});

test("direct input keeps the committed Operator delivery pending when its post-commit effect fails", async (t) => {
  const fixture = createFixture(t);
  const leader = createLeader(fixture, "Retry a failed delivery");
  await seedLiveOperator(fixture);
  const failed = runTaskmuxFailure([
    "task", "input", "request", leader.taskId,
    "--question", "Retry this Operator delivery",
    "--policy", "human-only"
  ], {
    ...leader.environment,
    FAKE_TMUX_WINDOWS: "leader\noperator",
    FAKE_TMUX_FAIL_OPERATOR_DELIVERY: "1"
  });

  assert.notEqual(failed.status, 0);
  const store = new FileTaskStore(fixture.home);
  const [request] = store.listInputRequests(leader.taskId);
  assert.ok(request);
  const [delivery] = store.listOperatorDeliveries();
  assert.ok(delivery);
  assert.equal(delivery.status, "pending");
  assert.equal(store.getActiveAgentRun(leader.taskId, "leader").status, "blocked");

  runTaskmux(["controller", "scan"], {
    ...fixture.baseEnv,
    FAKE_TMUX_WINDOWS: "leader\noperator"
  });
  assert.equal(new FileTaskStore(fixture.home).getOperatorDelivery(delivery.deliveryId).status, "accepted");
});

test("direct input answer keeps its exact Leader wakeup pending when the post-commit effect fails", async (t) => {
  const fixture = createFixture(t);
  const leader = createLeader(fixture, "Retry a failed Leader wakeup");
  await seedLiveOperator(fixture);
  const directLiveEnv = {
    ...leader.environment,
    FAKE_TMUX_WINDOWS: "leader\noperator"
  };
  const requestOutput = runTaskmux([
    "task", "input", "request", leader.taskId,
    "--question", "Wake the exact Leader after this answer",
    "--choice", "safe=Safe path",
    "--policy", "human-only"
  ], directLiveEnv);
  const requestId = /Created input request ([A-Za-z0-9._:-]+) for task/.exec(requestOutput)?.[1];
  assert.ok(requestId);

  assert.match(
    runTaskmux(["task", "input", "answer", requestId, "--choice", "safe"], {
      ...directLiveEnv,
      FAKE_TMUX_FAIL_LEADER_WAKEUP: "1"
    }),
    new RegExp(`Answered input request ${requestId}`)
  );
  const store = new FileTaskStore(fixture.home);
  assert.equal(store.getInputResolutionWakeup(leader.taskId, requestId).status, "pending");
  assert.equal(store.getActiveAgentRun(leader.taskId, "leader").status, "blocked");

  runTaskmux(["controller", "scan"], directLiveEnv);
  assert.equal(new FileTaskStore(fixture.home).getInputResolutionWakeup(leader.taskId, requestId).status, "completed");
  assert.equal(new FileTaskStore(fixture.home).getActiveAgentRun(leader.taskId, "leader").status, "active");
});

test("Controller task input RPC uses one idempotent domain transaction and the same trusted Leader tuple", async (t) => {
  const fixture = createFixture(t);
  const leader = createLeader(fixture, "Controller request");
  await seedLiveOperator(fixture);
  const controllerEnv = {
    ...fixture.baseEnv,
    TASKMUX_CONTROLLER_MODE: "auto",
    TASKMUX_CONTROLLER_SCAN_INTERVAL_MS: "60000",
    FAKE_TMUX_WINDOWS: "leader\noperator"
  };
  let controllerPid;
  runTaskmux(["controller", "start"], controllerEnv);
  t.after(() => {
    spawnSync(process.execPath, [cli, "controller", "stop"], {
      encoding: "utf8",
      env: { ...process.env, ...controllerEnv }
    });
    if (controllerPid !== undefined) {
      try {
        process.kill(controllerPid, "SIGTERM");
      } catch {
        // The Controller may already be stopped.
      }
    }
  });

  const discovery = readControllerDiscovery(fixture.home);
  assert.ok(discovery);
  controllerPid = discovery.pid;
  const args = [
    "input", "request", leader.taskId,
    "--question", "Controller chooses once",
    "--choice", "safe=Safe path",
    "--policy", "human-only"
  ];
  const requestId = "public-input-rpc-1";
  const first = await callController(discovery, "task.command", requestId, {
    args,
    provenance: provenance(leader.environment)
  });
  const replay = await callController(discovery, "task.command", requestId, {
    args,
    provenance: provenance(leader.environment)
  });

  assert.deepEqual(replay, first);
  const store = new FileTaskStore(fixture.home);
  assert.equal(store.listInputRequests(leader.taskId).length, 1);
  assert.equal(store.listOperatorDeliveries().length, 1);
  assert.equal(store.listOperatorDeliveries()[0].status, "accepted");
  const deliveredRequests = tmuxCalls(fixture.tmux.logFile)
    .filter((call) => call[0] === "if-shell" && call.at(-1).includes("[TaskMux input request delivery"));
  assert.equal(deliveredRequests.length, 1);
});
