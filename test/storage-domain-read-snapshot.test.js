import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../dist/agent/agent.js";
import { getSelectionCandidates } from "../dist/cli/interactionCandidates.js";
import { createTaskComment } from "../dist/comment/comment.js";
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
import { processLeaderWakeups } from "../dist/scheduler/leaderWakeupProcessor.js";
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
  const agent = createConfiguredAgent("codex", "codex", [], {}, now);
  store.saveConfiguredAgent(agent);
  store.saveTask(createTask("task-1", "Snapshot fixture", now));
  store.saveRole("task-1", createRole("leader", {
    ...agent,
    source: "custom"
  }, "/repo", now));
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

test("resilient priming can retain a derived rendering without caching domain records", (t) => {
  const home = fixtureHome("taskmux-domain-read-derived-cache-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new FileTaskStore(home);
  roleFixture(store);
  const comment = createTaskComment("comment-1", "safe derived rendering", now, "operator");
  store.saveComment("task-1", comment);
  const diagnostics = [];
  const resilient = createResilientTaskStore(store, (error, method, args) => {
    diagnostics.push({ message: error.message, method, args });
  });

  primeResilientTaskStore(resilient);
  writeFileSync(join(home, "tasks", "task-1", "comments.jsonl"), "{ invalid json\n");

  assert.deepEqual(resilient.listComments("task-1"), [comment]);
  assert.deepEqual(diagnostics, [{
    message: "Invalid comment record: task-1:1",
    method: "listComments",
    args: ["task-1"]
  }]);
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
  const exportFile = join(home, "export.json");
  runExportCommand(["--output", exportFile], store);
  assert.equal(snapshots, 1, "export");
  snapshots = 0;
  expireStaleAgentRuns(store, now, 1);
  assert.equal(snapshots, 1, "expire stale scheduler reads");
  snapshots = 0;
  failExitedAgentRuns(store, { detectRoleStatus: () => "running" }, now);
  assert.equal(snapshots, 1, "exited-run scheduler reads");
  snapshots = 0;
  scanTaskWakeups(store, now);
  assert.equal(snapshots, 1, "wakeup scheduler reads");
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

test("leader wakeups compare the current record before clearing it", (t) => {
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
  const runtime = {
    dispatchRole() {
      replacement = mergePendingWakeup(
        "task-1",
        "operator-input",
        new Date("2026-07-14T00:01:00.000Z"),
        store.getPendingWakeup("task-1")
      );
      store.savePendingWakeup(replacement);
    }
  };

  const result = processLeaderWakeups(store, runtime, now);

  assert.deepEqual(result, [{ taskId: "task-1", status: "dispatched" }]);
  assert.deepEqual(store.getPendingWakeup("task-1"), replacement);
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
    try {
      const result = new FileTaskStore(home).runReadSnapshot((reader) => reader.getConfig());
      process.stdout.write(JSON.stringify({ result }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
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
  assert.match(output.error, /path identity changed/i);
});
