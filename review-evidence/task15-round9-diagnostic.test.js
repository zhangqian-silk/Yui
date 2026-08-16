import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

// Reviewer-lane diagnostics for round-9 P1+P2 findings. Every external effect
// is replaced by a deterministic fake; every store is in-memory or a disposable
// temp directory. These tests never contact GitHub, npm, a Controller, a real
// Project, or a user Home.

import { createConfiguredAgent } from "../dist/agent/agent.js";
import { runTaskCommand } from "../dist/commands/taskCommands.js";
import { runWorkflowCommandAsync } from "../dist/commands/workflowCommands.js";
import { createCapabilityGrant } from "../dist/grant/capabilityGrant.js";
import {
  createReleaseWorkflow,
  startStep
} from "../dist/release/releaseWorkflow.js";
import { runReleaseWorkflow } from "../dist/release/releaseWorkflowEngine.js";
import { acquireWorkflowFileLock } from "../dist/release/workflowFileLock.js";
import { createFileReleaseIdempotencyStore } from "../dist/release/releaseIdempotencyStore.js";
import { createReleaseWorkflowPorts } from "../dist/release/releaseWorkflowPorts.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { installOperatorSession } from "../test/helpers/operatorSession.js";

const NOW = new Date("2026-08-15T06:30:00.000Z");
const LATER = new Date("2026-08-15T06:30:01.000Z");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SOURCE = Object.freeze({
  repository: { owner: "acme", name: "widget" },
  commit: COMMIT
});
// A pid that names no live process on any supported host.
const DEAD_PID = 999_999_999;
const execFileAsync = promisify(execFile);

// ===========================================================================
// P2-E (Lane E): the immutable run-intent event must commit before the engine
// runs, so a crash, hard exit, or rethrown engine error can never leave
// mutation/effect evidence without an audit record saying the run was tried.
// ===========================================================================

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-task15-round9-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(agent);
  });
  const task = runTaskCommand(["create", "Task 15 round 9 diagnostic"], store, {
    now: () => NOW
  }).data.task;
  const operator = installOperatorSession(store, agent, NOW);
  return { root, store, task, operator };
}

function fakePorts(executeStep) {
  return {
    executeStep,
    queryStepEffect: async () => ({ state: "unknown" })
  };
}

function issuePostVerifyGrant(store, task, operator) {
  runTaskCommand([
    "grant", "issue", task.id,
    "--action", "post-verify"
  ], store, { now: () => NOW, environment: operator.environment });
}

function createPostVerifyWorkflow(store, task) {
  return runTaskCommand([
    "workflow", "create", task.id,
    "--grant", "capability-grant-1",
    "--source-repo", "acme/widget",
    "--source-commit", COMMIT,
    "--step", "verify:post-verify",
    "--step-param", "verify:command=verify-release"
  ], store, { now: () => NOW }).data;
}

test("round9 P2-E: a failed run still has its immutable run-intent event", async (t) => {
  const { store, task, operator } = fixture(t);
  issuePostVerifyGrant(store, task, operator);
  const workflow = createPostVerifyWorkflow(store, task);

  // executeStep rejects: the engine persists the failed step for recovery and
  // rethrows. The run-intent event committed before the engine ran.
  await assert.rejects(() => runWorkflowCommandAsync(
    ["run", task.id, workflow.id], store,
    {
      now: () => LATER,
      ports: fakePorts(async () => { throw new Error("external system exploded"); })
    }
  ), /external system exploded/);

  const persisted = store.getReleaseWorkflow(task.id, workflow.id);
  const events = store.listEvents(task.id);
  assert.equal(persisted.steps.verify.status, "failed");
  assert.notEqual(
    events.find((event) => event.type === "release-workflow.run-started"),
    undefined,
    "the run-intent event is durable despite the rethrown crash"
  );
  assert.equal(
    events.find((event) => event.type === "release-workflow.run"),
    undefined,
    "no outcome event when the engine rethrows"
  );
});

test("round9 P2-E: a hard exit after engine state save leaves the run-intent event", async (t) => {
  const { root, store, task, operator } = fixture(t);
  issuePostVerifyGrant(store, task, operator);
  const workflow = createPostVerifyWorkflow(store, task);
  const worker = new URL("./task15-round9-crash-worker.mjs", import.meta.url);

  // The worker hard-exits (process.exit) from inside executeStep, AFTER the
  // engine persisted the running step. A fresh process then reads the store.
  let exitCode;
  try {
    await execFileAsync(process.execPath, [worker.pathname, root, task.id, workflow.id]);
    exitCode = 0;
  } catch (error) {
    exitCode = error.code;
  }
  assert.equal(exitCode, 42, "the worker hard-exited mid-run");

  const reopened = new FileTaskStore(root);
  const persisted = reopened.getReleaseWorkflow(task.id, workflow.id);
  const events = reopened.listEvents(task.id);
  assert.equal(persisted.steps.verify.status, "running", "engine state was saved before the hard exit");
  assert.notEqual(
    events.find((event) => event.type === "release-workflow.run-started"),
    undefined,
    "the run-intent event survived the hard exit"
  );
  assert.equal(
    events.find((event) => event.type === "release-workflow.run"),
    undefined,
    "no outcome event after a hard exit"
  );
});

test("round9 P2-E: a successful run records the intent before the outcome", async (t) => {
  const { store, task, operator } = fixture(t);
  issuePostVerifyGrant(store, task, operator);
  const workflow = createPostVerifyWorkflow(store, task);

  const result = await runWorkflowCommandAsync(
    ["run", task.id, workflow.id], store,
    { now: () => LATER, ports: fakePorts(async () => ({ outcome: "succeeded" })) }
  );

  assert.equal(result.data.outcome, "succeeded");
  const trail = store.listEvents(task.id)
    .filter((event) =>
      event.type === "release-workflow.run-started" || event.type === "release-workflow.run");
  assert.deepEqual(
    trail.map((event) => event.type),
    ["release-workflow.run-started", "release-workflow.run"]
  );
  assert.equal(trail[0].payload.workflowId, workflow.id);
  assert.equal(trail[0].payload.command, "run");
  assert.equal(trail[1].payload.outcome, "succeeded");
});

// ===========================================================================
// P1 (Lane B): crash recovery must not re-submit an irreversible effect
// ===========================================================================

/**
 * An in-memory engine store plus a crash wrapper. The wrapper lands every
 * grant-use save durably and then kills the "process", reproducing a hard
 * exit after the registry accepted the upload but before the adapter result
 * was persisted: the step is still `running` without an external identity,
 * and the grant carries the use reservation for this exact attempt.
 */
function crashedAfterReservationStore({ plan, grant: grantInput = {} }) {
  let grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: [...new Set(plan.map(({ kind }) => kind))],
    irreversibilityCeiling: "irreversible",
    ...grantInput
  }, NOW);
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: grant.id,
    source: SOURCE,
    plan
  }, NOW);
  const store = {
    getReleaseWorkflow: () => workflow,
    saveReleaseWorkflow: (_taskId, next) => { workflow = next; },
    getCapabilityGrant: () => grant,
    saveCapabilityGrant: (_taskId, next) => { grant = next; }
  };
  const crashStore = {
    ...store,
    saveCapabilityGrant: (taskId, next) => {
      store.saveCapabilityGrant(taskId, next);
      throw new Error("simulated hard exit after the registry accepted the upload");
    }
  };
  return { store, crashStore, ids: { taskId: "task-1", workflowId: "release-workflow-1" } };
}

test("round9 P1: a crash after the grant reservation does not re-submit an irreversible effect", async () => {
  const { store, crashStore, ids } = crashedAfterReservationStore({
    plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
  });
  let calls = 0;
  let queries = 0;
  // The real adapter cannot establish an identity for a step that crashed
  // before recording one, so its query answers "unknown".
  const ports = {
    executeStep: async () => { calls += 1; return { outcome: "succeeded" }; },
    queryStepEffect: async () => { queries += 1; return { state: "unknown" }; }
  };

  await assert.rejects(
    runReleaseWorkflow(crashStore, ids.taskId, ids.workflowId, ports, { now: () => NOW }),
    /simulated hard exit/
  );
  const resumed = await runReleaseWorkflow(store, ids.taskId, ids.workflowId, ports, { now: () => LATER });

  assert.deepEqual({
    outcome: resumed.outcome,
    stopReason: resumed.stopReason,
    calls,
    queries,
    usesUsed: store.getCapabilityGrant(ids.taskId, "capability-grant-1").usesUsed
  }, {
    outcome: "unconfirmed",
    stopReason: "unconfirmed:publish",
    calls: 0,
    queries: 1,
    usesUsed: 1
  });
});

test("round9 P1: a recognized use still confirms on an authoritative exists without re-submitting", async () => {
  const { store, crashStore, ids } = crashedAfterReservationStore({
    plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
  });
  let calls = 0;
  const ports = {
    executeStep: async () => { calls += 1; return { outcome: "succeeded" }; },
    queryStepEffect: async () => ({ state: "exists", externalId: "1.2.3" })
  };

  await assert.rejects(
    runReleaseWorkflow(crashStore, ids.taskId, ids.workflowId, ports, { now: () => NOW }),
    /simulated hard exit/
  );
  const resumed = await runReleaseWorkflow(store, ids.taskId, ids.workflowId, ports, { now: () => LATER });

  assert.equal(resumed.outcome, "succeeded");
  assert.equal(calls, 0, "the effect is never re-submitted");
  assert.equal(store.getReleaseWorkflow(ids.taskId, ids.workflowId).steps.publish.externalId, "1.2.3");
});

test("round9 P1: an authoritative absent re-submits exactly once, free, after a recognized use", async () => {
  const { store, crashStore, ids } = crashedAfterReservationStore({
    grant: { maxUses: 2 },
    plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
  });
  let calls = 0;
  let queries = 0;
  const ports = {
    executeStep: async () => { calls += 1; return { outcome: "succeeded", externalId: "1.2.3" }; },
    queryStepEffect: async () => { queries += 1; return { state: "absent" }; }
  };

  await assert.rejects(
    runReleaseWorkflow(crashStore, ids.taskId, ids.workflowId, ports, { now: () => NOW }),
    /simulated hard exit/
  );
  const resumed = await runReleaseWorkflow(store, ids.taskId, ids.workflowId, ports, { now: () => LATER });

  assert.deepEqual({
    outcome: resumed.outcome,
    calls,
    queries,
    usesUsed: store.getCapabilityGrant(ids.taskId, "capability-grant-1").usesUsed
  }, {
    outcome: "succeeded",
    calls: 1,
    queries: 1,
    usesUsed: 1
  });
});

test("round9 P1: an inherently irreversible kind is queried without an explicit plan declaration", async () => {
  let grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"],
    irreversibilityCeiling: "irreversible"
  }, NOW);
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: grant.id,
    source: SOURCE,
    // No explicit irreversibility: npm-publish is inherently irreversible.
    plan: [{ id: "publish", kind: "npm-publish" }]
  }, NOW);
  workflow = startStep(workflow, "publish", NOW);
  const store = {
    getReleaseWorkflow: () => workflow,
    saveReleaseWorkflow: (_taskId, next) => { workflow = next; },
    getCapabilityGrant: () => grant,
    saveCapabilityGrant: (_taskId, next) => { grant = next; }
  };
  let calls = 0;
  let queries = 0;
  const ports = {
    executeStep: async () => { calls += 1; return { outcome: "succeeded" }; },
    queryStepEffect: async () => { queries += 1; return { state: "unknown" }; }
  };

  const result = await runReleaseWorkflow(store, "task-1", "release-workflow-1", ports, { now: () => LATER });

  assert.deepEqual({
    outcome: result.outcome,
    stopReason: result.stopReason,
    calls,
    queries
  }, {
    outcome: "unconfirmed",
    stopReason: "unconfirmed:publish",
    calls: 0,
    queries: 1
  });
});

// ===========================================================================
// P2 (Lane B): the file lock must never have two owners
// ===========================================================================

function lockFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-task15-round9-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockDir = join(root, ".release-workflow-locks", "task-1--wf-1.lock");
  return { root, lockDir };
}

test("round9 P2: an in-progress acquisition (no complete receipt) is never reclaimed as dead", async (t) => {
  const { root, lockDir } = lockFixture(t);
  // The owner is between the mkdir and the receipt rename: the lock exists
  // but carries no complete ownership metadata.
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });

  await assert.rejects(
    acquireWorkflowFileLock(root, "task-1", "wf-1", { timeoutMs: 120, retryMs: 20 }),
    /Timed out waiting for the release workflow lock/
  );
  assert.ok(existsSync(lockDir), "the in-progress lock must not be reclaimed");
});

test("round9 P2: a live owner is not reclaimed; a released lock passes to the next owner", async (t) => {
  const { root, lockDir } = lockFixture(t);
  const release = await acquireWorkflowFileLock(root, "task-1", "wf-1", { timeoutMs: 500 });
  assert.ok(existsSync(join(lockDir, "owner")), "the owner receipt is published");

  await assert.rejects(
    acquireWorkflowFileLock(root, "task-1", "wf-1", { timeoutMs: 120, retryMs: 20 }),
    /Timed out waiting for the release workflow lock/
  );

  release();
  assert.ok(!existsSync(lockDir), "release removes the lock directory");
  const next = await acquireWorkflowFileLock(root, "task-1", "wf-1", { timeoutMs: 500 });
  assert.ok(existsSync(lockDir), "the next owner acquires the same pathname");
  next();
  assert.ok(!existsSync(lockDir));
});

test("round9 P2: a stale release does not remove a lock whose receipt names another owner", async (t) => {
  const { root, lockDir } = lockFixture(t);
  const releaseStale = await acquireWorkflowFileLock(root, "task-1", "wf-1", { timeoutMs: 500 });

  // The original holder died; its lock was reclaimed and a new owner acquired
  // with its own receipt. The stale release closure must not remove the new
  // owner's lock.
  writeFileSync(
    join(lockDir, "owner"),
    `${JSON.stringify({ pid: DEAD_PID, token: "transferred-owner" })}\n`,
    { mode: 0o600 }
  );
  releaseStale();
  assert.ok(existsSync(lockDir), "the transferred lock survives the stale release");

  // The transferred owner is dead, so a fresh acquirer reclaims and wins.
  const releaseFresh = await acquireWorkflowFileLock(root, "task-1", "wf-1", { timeoutMs: 500 });
  assert.ok(existsSync(join(lockDir, "owner")));
  releaseFresh();
  assert.ok(!existsSync(lockDir));
});

test("round9 P2: a complete receipt for a dead owner is reclaimed", async (t) => {
  const { root, lockDir } = lockFixture(t);
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(lockDir, "owner"),
    `${JSON.stringify({ pid: DEAD_PID, token: "dead-owner" })}\n`,
    { mode: 0o600 }
  );

  const release = await acquireWorkflowFileLock(root, "task-1", "wf-1", { timeoutMs: 500 });
  assert.ok(existsSync(lockDir), "the stale lock was reclaimed and re-acquired");
  release();
  assert.ok(!existsSync(lockDir));
});

test("round9 P2: three processes contending for a stale lock never overlap", async (t) => {
  const { root, lockDir } = lockFixture(t);
  // Seed a stale lock: a complete receipt for a dead owner.
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(lockDir, "owner"),
    `${JSON.stringify({ pid: DEAD_PID, token: "dead-owner" })}\n`,
    { mode: 0o600 }
  );

  const logPath = join(root, "contention.log");
  const worker = new URL("./task15-round9-lock-contention-worker.mjs", import.meta.url);
  const args = [worker.pathname, root, "task-1", "wf-1", logPath, "150"];

  // Launch three contenders simultaneously. Each must acquire, hold 150ms,
  // and release. With the atomic reclaim marker, no two workers can hold
  // the lock at the same time: the first reclaims and acquires; the others
  // see the live receipt and wait.
  await Promise.all([
    execFileAsync(process.execPath, args),
    execFileAsync(process.execPath, args),
    execFileAsync(process.execPath, args)
  ]);

  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 6, "three workers each logged acquire + release");

  // Parse hold intervals and verify no overlap.
  const holds = new Map();
  for (const line of lines) {
    const [event, pidStr, tsStr] = line.split(" ");
    const pid = Number(pidStr);
    const ts = Number(tsStr);
    if (event === "acquire") holds.set(pid, { start: ts, end: null });
    else if (event === "release") holds.get(pid).end = ts;
  }
  assert.equal(holds.size, 3, "three distinct workers acquired the lock");

  const intervals = [...holds.values()].map((h) => ({ ...h }));
  for (const h of intervals) {
    assert.ok(h.end !== null, "every worker released the lock");
    assert.ok(h.end > h.start, "the hold interval is positive");
  }
  // Sort by start time and verify no overlap.
  intervals.sort((a, b) => a.start - b.start);
  for (let i = 1; i < intervals.length; i++) {
    assert.ok(
      intervals[i].start >= intervals[i - 1].end,
      `worker ${i} started at ${intervals[i].start} before worker ${i - 1} released at ${intervals[i - 1].end}`
    );
  }
  assert.ok(!existsSync(lockDir), "the last worker released the lock");
});

// ===========================================================================
// P2-D (Lane D): the release idempotency store must survive concurrent
// writers, fail closed on durable-write errors, and version its records.
// ===========================================================================

function tempHome(t, label) {
  const home = mkdtempSync(join(tmpdir(), `yui-task15-round9-${label}-`));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/**
 * Block the per-key record directory so a durable write cannot land, while a
 * `load` still reads the store as empty (the directory path is a file, so no
 * per-key record can exist). This forces recordSuccess to fail without
 * depending on file permissions (which root ignores).
 */
function blockRecordDirectory(home) {
  writeFileSync(join(home, "release-idempotency"), "blocked\n");
}

function postVerifyInput(key) {
  return {
    step: { id: "verify", kind: "post-verify", idempotencyKey: key },
    idempotencyKey: key,
    source: SOURCE,
    params: { command: "echo ok" }
  };
}

test("round9 P2-D: two processes recording different keys both persist", async (t) => {
  const home = tempHome(t, "conc");
  const worker = new URL("./task15-round9-concurrent-worker.mjs", import.meta.url);
  const keyA = "task-1/wf/step-a";
  const keyB = "task-1/wf/step-b";
  const effectA = { outcome: "succeeded", externalId: "a-1" };
  const effectB = { outcome: "succeeded", externalId: "b-1" };

  await Promise.all([
    execFileAsync(process.execPath, [worker.pathname, home, keyA, JSON.stringify(effectA)]),
    execFileAsync(process.execPath, [worker.pathname, home, keyB, JSON.stringify(effectB)])
  ]);

  // A fresh process loads both keys: the old whole-map store would have
  // clobbered one writer's record with the other's stale snapshot.
  const fresh = createFileReleaseIdempotencyStore(home);
  const loadedA = await fresh.load(keyA);
  const loadedB = await fresh.load(keyB);
  assert.equal(loadedA?.externalId, "a-1", "key A survived the concurrent writer");
  assert.equal(loadedB?.externalId, "b-1", "key B survived the concurrent writer");
});

test("round9 P2-D: a forced durable-write failure returns ambiguous, not success", async (t) => {
  const home = tempHome(t, "writefail");
  blockRecordDirectory(home);
  let calls = 0;
  const adapter = createReleaseWorkflowPorts({
    home,
    updatePorts: {},
    projectStore: {},
    runCommand: async () => {
      calls += 1;
      return { code: 0, stdout: "ok\n", stderr: "" };
    }
  });

  const effect = await adapter.executeStep(postVerifyInput("task-1/wf/verify"));

  assert.notEqual(effect.outcome, "succeeded", "an unpersisted success must not be returned as success");
  assert.equal(effect.outcome, "timeout", "the effect is reported as ambiguous, not clean success");
  assert.equal(calls, 1, "the shell command ran exactly once");
  assert.ok(
    effect.logs.some((line) => line.includes("not durable")),
    "the logs explain the durability failure"
  );
  assert.ok(
    effect.error?.includes("not persisted"),
    "the error names the persistence failure"
  );
});

test("round9 P2-D: a failed record of a queryable effect carries its re-query identity", async (t) => {
  const home = tempHome(t, "writefail-tag");
  blockRecordDirectory(home);
  const calls = [];
  const adapter = createReleaseWorkflowPorts({
    home,
    updatePorts: {},
    projectStore: {},
    runCommand: async (command, args) => {
      calls.push({ command, args: [...args] });
      if (args[0] === "remote") return { code: 0, stdout: "git@github.com:acme/widget.git\n", stderr: "" };
      if (args[0] === "rev-parse") return { code: 1, stdout: "", stderr: "no such tag" };
      if (args[0] === "tag") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "push") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    }
  });

  const effect = await adapter.executeStep({
    step: {
      id: "tag",
      kind: "version-tag",
      idempotencyKey: "task-1/wf/tag",
      params: { tag: "v1.2.3", repositoryPath: "/repo" }
    },
    idempotencyKey: "task-1/wf/tag",
    source: SOURCE,
    params: { tag: "v1.2.3", repositoryPath: "/repo" }
  });

  assert.equal(effect.outcome, "timeout");
  assert.deepEqual(
    effect.externalIdentity,
    { kind: "git-tag", value: "v1.2.3" },
    "the engine can re-query the tag authoritatively instead of re-pushing"
  );
  assert.ok(calls.some((call) => call.args[0] === "push"), "the tag was pushed before the record failed");
});

test("round9 P2-D: persisted records carry schemaVersion 1", async (t) => {
  const home = tempHome(t, "schema");
  const store = createFileReleaseIdempotencyStore(home);
  await store.recordSuccess("task-1/wf/verify", { outcome: "succeeded", externalId: "v1" });

  const onDisk = JSON.parse(
    readFileSync(join(home, "release-idempotency", `${encodeURIComponent("task-1/wf/verify")}.json`), "utf8")
  );
  assert.equal(onDisk.schemaVersion, 1);
  assert.equal(onDisk.key, "task-1/wf/verify");
  assert.equal(onDisk.effect.outcome, "succeeded");
  assert.equal(onDisk.effect.externalId, "v1");
  assert.equal(typeof onDisk.recordedAt, "string");
});

test("round9 P2-D: a legacy whole-map file fails closed on load and record", async (t) => {
  const home = tempHome(t, "legacy-fail-closed");
  // The old unversioned layout: one whole-map file. This layout was never
  // shipped in a valid release; the store must not trust or migrate it.
  writeFileSync(join(home, "release-idempotency.json"), JSON.stringify({
    "task-1/wf/old": {
      effect: { outcome: "succeeded", externalId: "old-1" },
      recordedAt: "2026-01-01T00:00:00.000Z"
    }
  }));

  const store = createFileReleaseIdempotencyStore(home);
  await assert.rejects(
    () => store.load("task-1/wf/old"),
    /unsupported legacy release idempotency layout/,
    "a legacy whole-map file is not silently trusted on load"
  );
  await assert.rejects(
    () => store.recordSuccess("task-1/wf/new", { outcome: "succeeded", externalId: "new-1" }),
    /unsupported legacy release idempotency layout/,
    "a legacy whole-map file blocks new records until cleaned up"
  );
  assert.ok(
    existsSync(join(home, "release-idempotency.json")),
    "the legacy file is left in place for operator inspection"
  );
});

test("round9 P2-D: a record with an unknown schemaVersion fails closed", async (t) => {
  const home = tempHome(t, "corrupt");
  const dir = join(home, "release-idempotency");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${encodeURIComponent("task-1/wf/bad")}.json`), JSON.stringify({
    schemaVersion: 99,
    key: "task-1/wf/bad",
    effect: { outcome: "succeeded" },
    recordedAt: "2026-01-01T00:00:00.000Z"
  }));

  const store = createFileReleaseIdempotencyStore(home);
  await assert.rejects(
    () => store.load("task-1/wf/bad"),
    /schemaVersion/,
    "an unknown record version is not silently skipped"
  );
});

test("round9 P2-D: a recorded success is replayed within the same process", async (t) => {
  const home = tempHome(t, "replay");
  let calls = 0;
  const adapter = createReleaseWorkflowPorts({
    home,
    updatePorts: {},
    projectStore: {},
    runCommand: async () => {
      calls += 1;
      return { code: 0, stdout: "ok\n", stderr: "" };
    }
  });
  const input = postVerifyInput("task-1/wf/verify");

  const first = await adapter.executeStep(input);
  const second = await adapter.executeStep(input);

  assert.equal(first.outcome, "succeeded");
  assert.equal(second.outcome, "succeeded");
  assert.equal(calls, 1, "the shell command runs once; the second call replays the record");
  assert.ok(second.logs.some((line) => line.includes("idempotent")), "the replay is marked idempotent");
});
