import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../dist/agent/agent.js";
import { getSelectionCandidates } from "../dist/cli/interactionCandidates.js";
import { createTaskComment } from "../dist/comment/comment.js";
import { createTaskEvent } from "../dist/event/taskEvent.js";
import { runConfigCommand } from "../dist/commands/configCommands.js";
import { runExportCommand } from "../dist/commands/maintenanceCommands.js";
import { runTaskCommand } from "../dist/commands/taskCommands.js";
import { runCompletionWizard } from "../dist/completion/completionWizard.js";
import { getDoctorChecks } from "../dist/doctor/doctor.js";
import { createRole } from "../dist/role/role.js";
import { createResilientTaskStore, primeResilientTaskStore } from "../dist/storage/resilientTaskStore.js";
import { rebuildDerivedIndex } from "../dist/storage/derivedIndex.js";
import {
  executeDomainReadSnapshot,
  executeDomainTransaction
} from "../dist/storage/domainTransaction.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createTask } from "../dist/task/task.js";
import { createAgentRun } from "../dist/run/agentRun.js";
import { dataError } from "../dist/errors/cliError.js";
import { enrollAgentCapabilityProbePin } from "../dist/executor/agentAdapter.js";
import { processLeaderWakeups } from "../dist/scheduler/leaderWakeupProcessor.js";
import { createRoleExpiryNotification } from "../dist/scheduler/operatorNotification.js";
import { mergePendingWakeup } from "../dist/scheduler/pendingWakeup.js";
import {
  expireStaleAgentRuns,
  failExitedAgentRuns,
  scanTaskWakeups
} from "../dist/scheduler/inactivityScanner.js";

const now = new Date("2026-07-14T00:00:00.000Z");

function fixtureHome(prefix = "taskmux-domain-read-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function roleFixture(store) {
  const fixtureBin = join(store.rootDirectory(), "fixture-bin");
  mkdirSync(fixtureBin, { recursive: true });
  const fixtureCodex = join(fixtureBin, "codex");
  writeFileSync(
    fixtureCodex,
    `#!${process.execPath}\n` +
      `if (process.argv.includes("--version")) process.stdout.write("codex-cli 0.144.1\\n");\n`
  );
  chmodSync(fixtureCodex, 0o700);
  const probePin = enrollAgentCapabilityProbePin(
    { adapterId: "codex", command: "codex" },
    {
      ...process.env,
      PATH: [fixtureBin, dirname(process.execPath), process.env.PATH]
        .filter((value) => typeof value === "string" && value.length > 0)
        .join(delimiter)
    }
  );
  assert.ok(probePin, "Expected a canonical Codex capability probe pin for the role fixture.");
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now, probePin);
  store.saveConfiguredAgent(agent);
  store.saveTask(createTask("task-1", "Snapshot fixture", now));
  store.saveRole("task-1", createRole(
    "task-1",
    "leader",
    [{ agentId: agent.id, adapterId: agent.adapterId, config: { adapterId: agent.adapterId } }],
    agent.id,
    "/repo",
    now
  ));
}

async function waitForLine(stream, expected, child, stderr) {
  stream.setEncoding("utf8");
  let buffered = "";
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffered += chunk;
      if (!buffered.includes("\n")) return;
      cleanup();
      const line = buffered.slice(0, buffered.indexOf("\n"));
      if (line === expected) resolve();
      else reject(new Error(`Unexpected barrier output: ${line}`));
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Barrier process exited early (${code}): ${stderr()}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    stream.on("data", onData);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

const sharedHolderSource = `
const { readSync } = await import("node:fs");
const { FileTaskStore } = await import("./dist/storage/taskStore.js");
new FileTaskStore(process.argv[1]).runReadSnapshot(() => {
  process.stdout.write("shared-ready\\n");
  readSync(0, Buffer.alloc(1), 0, 1, null);
});
`;

test("Native read snapshots use a shared stable-ancestor barrier that blocks writers", async (t) => {
  const home = fixtureHome("taskmux-domain-read-ipc-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new FileTaskStore(home);
  store.getConfig();
  const child = spawn(process.execPath, ["--input-type=module", "-e", sharedHolderSource, home], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await waitForLine(child.stdout, "shared-ready", child, () => stderr);
  try {
    assert.throws(
      () => executeDomainTransaction(home, "exclusive-publisher", (workingRoot) => {
        mkdirSync(join(workingRoot, "tasks"), { recursive: true });
      }),
      /storage is locked|would block|resource temporarily unavailable/i
    );
  } finally {
    child.stdin.end("release\n");
  }
});

test("a shared snapshot never retries an error thrown by its callback", (t) => {
  const home = fixtureHome("taskmux-domain-read-callback-error-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  new FileTaskStore(home).getConfig();
  const expected = Object.assign(new Error("callback would block"), { code: "EWOULDBLOCK" });
  let callbacks = 0;

  assert.throws(
    () => executeDomainReadSnapshot(home, () => {
      callbacks += 1;
      throw expected;
    }),
    (error) => error === expected
  );
  assert.equal(callbacks, 1);
});

test("FileTaskStore exposes only a frozen, callback-bounded TaskReader", (t) => {
  const home = fixtureHome("taskmux-domain-read-reader-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new FileTaskStore(home);
  roleFixture(store);

  let escaped;
  let escapedRead;
  store.runReadSnapshot((reader) => {
    escaped = reader;
    escapedRead = reader.getConfig;
    assert.equal(Object.getPrototypeOf(reader), null);
    assert.equal(Object.isFrozen(reader), true);
    for (const forbidden of ["constructor", "saveConfig", "saveTask", "deleteTask", "rootDirectory"]) {
      assert.equal(Reflect.has(reader, forbidden), false, forbidden);
    }
    assert.deepEqual(reader.getConfig(), { schemaVersion: 1 });
    assert.equal(reader.getRole("task-1", "leader")?.name, "leader");
    reader.runReadSnapshot((nested) => assert.equal(nested, reader));
  });
  assert.throws(() => escaped.getConfig(), /read snapshot capability is no longer active/i);
  assert.throws(() => escapedRead(), /read snapshot capability is no longer active/i);

  assert.throws(
    () => store.runReadSnapshot(async () => "escaped"),
    /read snapshot callback must be synchronous/i
  );
  let getterCalls = 0;
  const accessorThenable = {};
  Object.defineProperty(accessorThenable, "then", {
    get() {
      getterCalls += 1;
      return () => {};
    }
  });
  assert.throws(
    () => store.runReadSnapshot(() => accessorThenable),
    /read snapshot callback must be synchronous/i
  );
  assert.equal(getterCalls, 0);
  let proxyTraps = 0;
  const proxyThenable = new Proxy({}, {
    get() {
      proxyTraps += 1;
      return () => {};
    },
    getOwnPropertyDescriptor() {
      proxyTraps += 1;
      return { configurable: true, value: () => {} };
    }
  });
  assert.throws(
    () => store.runReadSnapshot(() => proxyThenable),
    /read snapshot callback must be synchronous/i
  );
  assert.equal(proxyTraps, 0);
});

test("resilient storage never serves stale authoritative records", () => {
  for (const method of [
    "getConfig",
    "getTask",
    "getRole",
    "listRoles",
    "listComments",
    "listEvents",
    "getInputRequest",
    "listInputRequests",
    "getActiveAgentRun",
    "listConfiguredAgents"
  ]) {
    let invalid = false;
    const expected = method === "getConfig" ? { schemaVersion: 1 } : method.startsWith("get") ? null : [];
    const backing = {
      [method]: () => {
        if (invalid) throw dataError(`invalid ${method}`);
        return expected;
      }
    };
    const resilient = createResilientTaskStore(backing, () => assert.fail("must not use stale data"));
    assert.deepEqual(resilient[method](), expected);
    invalid = true;
    assert.throws(() => resilient[method](), new RegExp(`invalid ${method}`));
  }
});

test("malformed comments and events fail closed in direct and resilient modes", (t) => {
  const home = fixtureHome("taskmux-domain-read-derived-cache-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new FileTaskStore(home);
  roleFixture(store);
  const comment = createTaskComment("comment-1", "safe derived rendering", now, "operator");
  const event = createTaskEvent("event-1", "task.created", { title: "Snapshot fixture" }, now);
  store.saveComment("task-1", comment);
  store.saveEvent("task-1", event);
  const diagnostics = [];
  const resilient = createResilientTaskStore(store, (error, method, args) => {
    diagnostics.push({ message: error.message, method, args });
  });

  primeResilientTaskStore(resilient);
  writeFileSync(join(home, "tasks", "task-1", "comments.jsonl"), "{ invalid json\n");

  for (const mode of [store, resilient]) {
    assert.throws(() => mode.listComments("task-1"), /Invalid comment record: task-1:1/i);
    assert.throws(() => runTaskCommand(["context", "task-1"], mode), /Invalid comment record: task-1:1/i);
  }
  assert.equal(store.getConfig().lastTaskId, undefined);

  writeFileSync(join(home, "tasks", "task-1", "comments.jsonl"), `${JSON.stringify(comment)}\n`);
  writeFileSync(join(home, "tasks", "task-1", "events.jsonl"), "{ invalid json\n");

  for (const mode of [store, resilient]) {
    assert.throws(() => mode.listEvents("task-1"), /Invalid event record: task-1:1/i);
    assert.throws(() => runTaskCommand(["context", "task-1"], mode), /Invalid event record: task-1:1/i);
  }
  assert.equal(store.getConfig().lastTaskId, undefined);
  assert.deepEqual(diagnostics, []);
});

test("read-only aggregate consumers each use one coherent snapshot", (t) => {
  const home = fixtureHome("taskmux-domain-read-aggregates-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new FileTaskStore(home);
  roleFixture(store);
  const original = store.runReadSnapshot.bind(store);
  let snapshots = 0;
  store.runReadSnapshot = (execute) => {
    snapshots += 1;
    return original(execute);
  };

  runConfigCommand(["show"], store, {});
  assert.equal(snapshots, 1, "config show");
  snapshots = 0;
  rebuildDerivedIndex(home, store);
  assert.equal(snapshots, 1, "derived index");
  snapshots = 0;
  const candidates = getSelectionCandidates(
    { provider: "configured-agents", argumentIndex: 0, actionTarget: false },
    store,
    []
  );
  assert.deepEqual(candidates?.candidates.map((candidate) => candidate.value), ["codex"]);
  assert.equal(snapshots, 1, "interactive candidates");
  snapshots = 0;
  runTaskCommand(["board", "--with-roles"], store);
  assert.equal(snapshots, 1, "task board");
  snapshots = 0;
  const exportHome = fixtureHome("taskmux-domain-read-export-");
  t.after(() => rmSync(exportHome, { recursive: true, force: true }));
  const exportFile = join(exportHome, "export.json");
  runExportCommand(["--output", exportFile], store);
  assert.equal(snapshots, 0, "export uses a domain transaction");
  snapshots = 0;
  expireStaleAgentRuns(store, now, 1);
  assert.equal(snapshots, 0, "expire stale scheduler uses role runtime transactions");
  snapshots = 0;
  failExitedAgentRuns(store, { detectRoleStatus: () => "running" }, now);
  assert.equal(snapshots, 0, "exited-run scheduler uses role runtime transactions");
  snapshots = 0;
  scanTaskWakeups(store, now);
  assert.equal(snapshots, 0, "wakeup scheduler uses role runtime transactions");
});

test("completion reads its initial state from one snapshot before prompting", async (t) => {
  const home = fixtureHome("taskmux-domain-read-completion-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new FileTaskStore(home);
  const original = store.runReadSnapshot.bind(store);
  let snapshots = 0;
  store.runReadSnapshot = (execute) => {
    snapshots += 1;
    return original(execute);
  };

  assert.equal(
    await runCompletionWizard(
      "install",
      store,
      {},
      "taskmux",
      async () => "skip"
    ),
    "Completion install skipped.\n"
  );
  assert.equal(snapshots, 1);
});

test("doctor captures configuration, agents, and record counts in one snapshot", (t) => {
  const home = fixtureHome("taskmux-domain-read-doctor-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  roleFixture(store);
  const original = FileTaskStore.prototype.runReadSnapshot;
  let snapshots = 0;
  FileTaskStore.prototype.runReadSnapshot = function(execute) {
    snapshots += 1;
    return original.call(this, execute);
  };
  try {
    const checks = getDoctorChecks(
      { TASKMUX_HOME: home },
      { run: () => "tmux 3.4\n" }
    );
    assert.equal(checks.find((check) => check.name === "storage records")?.status, "ok");
  } finally {
    FileTaskStore.prototype.runReadSnapshot = original;
  }
  assert.equal(snapshots, 1);
});

test("resilient priming has one generation and traverses AgentRun records", (t) => {
  const home = fixtureHome("taskmux-domain-read-prime-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new FileTaskStore(home);
  roleFixture(store);
  store.saveAgentRun(createAgentRun("agent-run-1", "task-1", "leader", "new", "input", now));

  const original = store.runReadSnapshot.bind(store);
  let snapshots = 0;
  let agentRunReads = 0;
  store.runReadSnapshot = (execute) => original((reader) => {
    snapshots += 1;
    const observed = Object.assign(Object.create(null), reader);
    const getAgentRun = reader.getAgentRun.bind(reader);
    observed.getAgentRun = (...args) => {
      agentRunReads += 1;
      return getAgentRun(...args);
    };
    return execute(observed);
  });
  primeResilientTaskStore(store);
  assert.equal(snapshots, 1);
  assert.ok(agentRunReads > 0);
});

test("resilient priming validates orphan pending-wakeup records", (t) => {
  const home = fixtureHome("taskmux-domain-read-prime-pending-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new FileTaskStore(home);
  store.savePendingWakeup({
    schemaVersion: 1,
    taskId: "orphan-task",
    reasons: ["explicit-wake"],
    requestCount: 1,
    firstRequestedAt: now.toISOString(),
    lastRequestedAt: now.toISOString()
  });
  const original = store.runReadSnapshot.bind(store);
  let pendingWakeupLists = 0;
  store.runReadSnapshot = (execute) => original((reader) => {
    const observed = Object.assign(Object.create(null), reader);
    const listPendingWakeups = reader.listPendingWakeups.bind(reader);
    observed.listPendingWakeups = (...args) => {
      pendingWakeupLists += 1;
      return listPendingWakeups(...args);
    };
    return execute(observed);
  });

  primeResilientTaskStore(store);

  assert.equal(pendingWakeupLists, 1);
  writeFileSync(
    join(home, "runtime", "pending-wakeups", "orphan-task.json"),
    "{ malformed pending wakeup\n"
  );
  assert.throws(() => primeResilientTaskStore(store), /Invalid pending wakeup/i);
});

test("Role expiry notifications round-trip through authoritative storage", (t) => {
  const home = fixtureHome("taskmux-domain-read-role-expiry-notification-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new FileTaskStore(home);
  const notification = createRoleExpiryNotification(
    "task-1",
    "reviewer",
    "codex",
    "agent-run-1",
    "role-expiry-identity-drift",
    now,
    null
  );

  store.saveOperatorNotification(notification);

  assert.deepEqual(store.getOperatorNotification("task-1"), notification);
});

test("leader wakeups use compare-and-clear without deleting an intervening replacement", (t) => {
  const home = fixtureHome("taskmux-domain-read-wakeup-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new FileTaskStore(home);
  roleFixture(store);
  const wakeup = {
    schemaVersion: 1,
    taskId: "task-1",
    reasons: ["explicit-wake"],
    requestCount: 1,
    firstRequestedAt: now.toISOString(),
    lastRequestedAt: now.toISOString()
  };
  store.savePendingWakeup(wakeup);
  let replacement;
  const originalSnapshot = store.runReadSnapshot.bind(store);
  let snapshots = 0;
  store.runReadSnapshot = (execute) => {
    snapshots += 1;
    return originalSnapshot(execute);
  };
  const runtime = {
    dispatchRole() {
    replacement = mergePendingWakeup(
      "task-1",
      "operator-input",
      new Date("2026-07-14T00:01:00.000Z"),
      store.getPendingWakeup("task-1")
    );
    store.savePendingWakeup(replacement);
    return true;
    },
    killRoleLaunchAndConfirmStopped() {
      return true;
    }
  };

  const result = processLeaderWakeups(store, runtime, now);

  assert.deepEqual(result, [{ taskId: "task-1", status: "dispatched" }]);
  assert.equal(snapshots, 1);
  assert.deepEqual(store.getPendingWakeup("task-1"), replacement);
});

test("direct CLI writers take the same exclusive barrier as coherent snapshots", async (t) => {
  const home = fixtureHome("taskmux-domain-read-direct-writer-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  roleFixture(store);
  const child = spawn(process.execPath, ["--input-type=module", "-e", sharedHolderSource, home], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await waitForLine(child.stdout, "shared-ready", child, () => stderr);
  try {
    for (const args of [
      ["config", "set", "default-workspace", "/repo"],
      ["agent", "add", "reviewer", "--command", "codex"],
      ["role", "add", "reviewer", "--agent", "codex", "--workspace", "/repo"],
      ["task", "comment", "task-1", "blocked"],
      ["prune", "--trash"],
      ["backup"]
    ]) {
      const result = spawnSync(process.execPath, [join(process.cwd(), "dist", "cli.js"), ...args], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          TASKMUX_HOME: home,
          TASKMUX_CONTROLLER_MODE: "direct"
        }
      });
      assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly bypassed the shared barrier`);
      assert.match(`${result.stdout}\n${result.stderr}`, /locked|would block|temporarily unavailable/i);
    }
    assert.equal(store.getConfig().defaultWorkspace, undefined);
    assert.equal(store.getConfiguredAgent("reviewer"), null);
    assert.equal(store.getGlobalRole("reviewer"), null);
    assert.deepEqual(store.listComments("task-1"), []);
  } finally {
    child.stdin.end("release\n");
  }
});

test("direct task pointer writes use the controller transaction boundary", (t) => {
  const home = fixtureHome("taskmux-domain-read-direct-pointer-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new FileTaskStore(home);
  roleFixture(store);

  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "task", "context", "task-1"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        TASKMUX_HOME: home,
        TASKMUX_CONTROLLER_MODE: "direct",
        TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT: "after-stage"
      }
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /stopped after staging|could not complete synchronous recovery/i
  );
  assert.equal(store.getConfig().lastTaskId, undefined);
});

test("a snapshot cannot return data after an absent authority root is created", (t) => {
  const parent = fixtureHome("taskmux-domain-read-absent-");
  const home = join(parent, "taskmux-home");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const store = new FileTaskStore(home);

  assert.throws(
    () => store.runReadSnapshot(() => {
      mkdirSync(home);
      return "stale";
    }),
    /read snapshot root identity changed/i
  );
  writeFileSync(join(home, "config.json"), '{"schemaVersion":1}\n');
});

test("a snapshot cannot return data after its existing authority root is replaced", (t) => {
  const parent = fixtureHome("taskmux-domain-read-replaced-");
  const home = join(parent, "taskmux-home");
  const moved = join(parent, "taskmux-home-moved");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(home);
  writeFileSync(join(home, "config.json"), '{"schemaVersion":1,"defaultAgent":"old"}\n');
  const store = new FileTaskStore(home);

  assert.throws(
    () => store.runReadSnapshot((reader) => {
      assert.equal(reader.getConfig().defaultAgent, "old");
      renameSync(home, moved);
      mkdirSync(home);
      writeFileSync(join(home, "config.json"), '{"schemaVersion":1,"defaultAgent":"new"}\n');
      return "stale";
    }),
    /read snapshot path identity changed/i
  );
});

test("a snapshot binds its opened Native root to the pre-open path witness", (t) => {
  const parent = fixtureHome("taskmux-domain-read-open-swap-");
  const home = join(parent, "taskmux-home");
  const moved = join(parent, "taskmux-home-original");
  const replacement = join(parent, "taskmux-home-replacement");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(home);
  writeFileSync(join(home, "config.json"), '{"schemaVersion":1,"defaultAgent":"original"}\n');
  const script = `
    import { createRequire } from "node:module";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const fs = require("node:fs");
    const home = process.argv[1];
    const moved = process.argv[2];
    const replacement = process.argv[3];
    const originalOpen = fs.openSync;
    let swapped = false;
    fs.openSync = function(path, ...args) {
      if (!swapped && path === home) {
        swapped = true;
        fs.renameSync(home, moved);
        fs.mkdirSync(home);
        fs.writeFileSync(join(home, "config.json"), '{"schemaVersion":1,"defaultAgent":"replacement"}\\n');
        const descriptor = originalOpen.call(this, path, ...args);
        fs.renameSync(home, replacement);
        fs.renameSync(moved, home);
        return descriptor;
      }
      return originalOpen.call(this, path, ...args);
    };
    const { FileTaskStore } = await import("./dist/storage/taskStore.js");
    let invoked = false;
    try {
      const result = new FileTaskStore(home).runReadSnapshot((reader) => {
        invoked = true;
        return reader.getConfig();
      });
      process.stdout.write(JSON.stringify({ result, invoked }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        invoked
      }));
    }
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script, home, moved, replacement],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_TEST_CONTEXT: undefined }
    }
  );

  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.equal(typeof output.error, "string", JSON.stringify(output));
  assert.match(output.error, /identity changed before Native pin|root identity changed/i);
  assert.equal(output.invoked, false);
});

test("an absent root that appears before Native pin never reaches the snapshot callback", (t) => {
  const parent = fixtureHome("taskmux-domain-read-appeared-root-");
  const home = join(parent, "taskmux-home");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const script = `
    import { createRequire } from "node:module";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const fs = require("node:fs");
    const parent = process.argv[1];
    const home = process.argv[2];
    const originalOpen = fs.openSync;
    let created = false;
    fs.openSync = function(path, ...args) {
      const descriptor = originalOpen.call(this, path, ...args);
      if (!created && path === parent) {
        created = true;
        fs.mkdirSync(home);
        fs.writeFileSync(join(home, "config.json"), '{"schemaVersion":1,"defaultAgent":"replacement"}\\n');
      }
      return descriptor;
    };
    const { FileTaskStore } = await import("./dist/storage/taskStore.js");
    let invoked = false;
    try {
      const result = new FileTaskStore(home).runReadSnapshot((reader) => {
        invoked = true;
        return reader.getConfig();
      });
      process.stdout.write(JSON.stringify({ result, invoked }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        invoked
      }));
    }
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script, parent, home],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_TEST_CONTEXT: undefined }
    }
  );

  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.equal(typeof output.error, "string", JSON.stringify(output));
  assert.match(output.error, /identity changed before Native pin|root identity changed/i);
  assert.equal(output.invoked, false);
});
