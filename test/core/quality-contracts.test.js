import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { SqliteResourceRegistry } from "../../dist/resources/sqliteResourceRegistry.js";
import { createResourceRecord } from "../../dist/resources/resourceTypes.js";
import { upsertResourceRecord } from "../../dist/resources/resourceRegistry.js";
import { planResourceGc } from "../../dist/resources/resourceGc.js";
import { normalizeVerificationPlan, planL2JobSteps } from "../../dist/verification/verificationPlan.js";
import { runGateStepsInProcess } from "../../dist/verification/verificationGateService.js";
import { parseDurableJobStartParams } from "../../dist/controller/jobControl.js";
import { createDurableJob } from "../../dist/job/durableJob.js";
import { runDurableJobRunner } from "../../dist/job/jobRunner.js";
import { routeInvocation } from "../../dist/cli/invocationRouter.js";
import Database from "better-sqlite3";
import { SqliteTelemetryStore } from "../../dist/telemetry/sqliteTelemetryStore.js";
import { createTask } from "../../dist/task/task.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { readTaskContext, readTaskContextDelta, inspectTaskContext } from "../../dist/context/taskContext.js";
import { createCapabilityGrant } from "../../dist/grant/capabilityGrant.js";
import { createReleaseWorkflow } from "../../dist/release/releaseWorkflow.js";
import { runReleaseWorkflow } from "../../dist/release/releaseWorkflowEngine.js";

const now = new Date("2026-09-13T00:00:00Z");

test("structured verification survives RPC and both executors preserve cwd, argv, env and shell failure", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-quality-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "nested"), { recursive: true });
  const plan = normalizeVerificationPlan({
    schemaVersion: 1, kind: "verification-plan", id: "normal-checks", version: "1",
    bootstrap: [], l1: { categories: [] },
    l2: { steps: [
      { name: "argv-env-cwd", cwd: "nested", env: { CHECK_VALUE: "literal" },
        argv: [process.execPath, "-e",
          'if(process.argv[1] !== "; &&" || process.env.CHECK_VALUE !== "literal") process.exit(2); console.log(process.cwd())',
          "; &&"] },
      { name: "must-fail", argv: ["true", "&&", "false"], shell: true },
      { name: "must-not-run", argv: ["/usr/bin/false"] }
    ] }
  });
  const steps = planL2JobSteps(plan, workspace);
  const input = parseDurableJobStartParams({
    taskId: "task-1", owner: { kind: "task" }, projectId: "project-1",
    head: "a".repeat(40), workspace, env: { PATH: "/usr/bin:/bin" },
    steps, caller: { scope: "user" }
  });
  // Parsing a request is not caller authorization, but must preserve its
  // executable specification unchanged for the authenticated Job boundary.
  assert.deepEqual(input.steps, steps);
  const job = createDurableJob({
    ...input, id: "job-1", artifactsLocator: "jobs/job-1"
  }, now);
  const outcomes = await runGateStepsInProcess(
    workspace, job.steps, job.env, join(root, "local-logs"), job.head
  );
  assert.deepEqual(outcomes.map(o => o.exitCode), [0, 1]);
  assert.equal(readFileSync(outcomes[0].sourceLogPath, "utf8").trim(), join(workspace, "nested"));

  const artifactDir = join(root, "job");
  mkdirSync(artifactDir);
  const specPath = join(root, "spec.json");
  writeFileSync(specPath, JSON.stringify({
    ...input, jobId: job.id, artifactDir, defaultStepTimeoutMs: 1000
  }));
  await runDurableJobRunner(specPath);
  const exit = JSON.parse(readFileSync(join(artifactDir, "exit.json"), "utf8"));
  assert.equal(exit.outcome, "failed");
  assert.deepEqual(exit.steps.map(s => s.exitCode), [0, 1]);
  assert.equal(readFileSync(join(artifactDir, "logs", exit.steps[0].logPath), "utf8").trim(),
    join(workspace, "nested"));
  assert.throws(() => planL2JobSteps({ ...plan, l2: {
    steps: [{ name: "escape", argv: ["true"], cwd: "../outside" }]
  } }, workspace), /workspace|outside/i);
});

test("resource registry changes preserve concurrent owners and reject stale same-record writes", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-quality-registry-"));
  new SqliteTaskStore(home).close();
  const a = new SqliteResourceRegistry(home);
  const b = new SqliteResourceRegistry(home);
  t.after(() => { a.close(); b.close(); rmSync(home, { recursive: true, force: true }); });
  const record = name => createResourceRecord({
    kind: "runtime-artifact", path: join(home, name), owner: { home, basis: "durable-record" },
    cleanliness: "n/a", activeRefs: [], disposition: "active"
  }, now);
  const first = record("first"), second = record("second");
  const oldA = a.load(), oldB = b.load();
  b.save(upsertResourceRecord(oldB, second), oldB);
  a.save(upsertResourceRecord(oldA, first), oldA);
  assert.deepEqual(Object.keys(a.load().records).sort(), [first.id, second.id].sort());
  const old = a.load();
  const quarantine = { ...first, disposition: "quarantined" };
  b.save(upsertResourceRecord(old, quarantine), old);
  assert.throws(() => a.save(upsertResourceRecord(old, {
    ...first, disposition: "deleted"
  }), old), /changed|conflict/i);
  assert.equal(a.load().records[first.id].disposition, "quarantined");
  assert.equal(a.load().records[second.id].disposition, "active");
});

test("GC planning closes its own registry on success and failure without closing a borrowed registry", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-quality-gc-"));
  new SqliteTaskStore(home).close();
  const opened = new Set();
  const load = SqliteResourceRegistry.prototype.load;
  const close = SqliteResourceRegistry.prototype.close;
  SqliteResourceRegistry.prototype.load = function () { opened.add(this); return load.call(this); };
  SqliteResourceRegistry.prototype.close = function () { opened.delete(this); return close.call(this); };
  t.after(() => {
    SqliteResourceRegistry.prototype.load = load;
    SqliteResourceRegistry.prototype.close = close;
    for (const registry of opened) registry.close();
    rmSync(home, { recursive: true, force: true });
  });
  const input = {
    home, projects: [], managedWorkspaces: [], taskStatusById: new Map(),
    mode: "report", now,
    liveReferencePorts: { processCwdRefs: () => new Map(), tmuxPaneCwds: async () => [] }
  };
  await planResourceGc(input);
  assert.equal(opened.size, 0);
  SqliteResourceRegistry.prototype.load = function () { opened.add(this); throw new Error("fixture read failure"); };
  await assert.rejects(planResourceGc(input), /fixture read failure/);
  assert.equal(opened.size, 0);
  const borrowed = { load: () => ({ schemaVersion: 1, records: {} }), close: () => assert.fail("borrowed") };
  await planResourceGc({ ...input, registryStore: borrowed });
});

test("Global input commands are executable through the public catalog without exposing configuration aliases", () => {
  for (const args of [
    ["role", "message", "queue", "operator", "hello", "--request-id", "one"],
    ["role", "message", "steer", "operator", "hello", "--request-id", "two", "--expected-target", "turn-1"],
    ["role", "interrupt", "operator", "--request-id", "three", "--expected-target", "turn-1"]
  ]) assert.equal(routeInvocation(args).kind, "execute", args.join(" "));
  assert.equal(routeInvocation(["role", "add", "worker"]).kind, "path-error");
});

test("Context pages preserve counts and exact history without materializing it or taking the write lock", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-quality-context-"));
  const store = new SqliteTaskStore(home);
  const writer = new Database(join(home, "yui.db"));
  t.after(() => { writer.close(); store.close(); rmSync(home, { recursive: true, force: true }); });
  store.saveTask(createTask("task-1", "Bounded read", now));
  const initial = readTaskContext(store, "task-1");
  store.transaction(tx => {
    for (let i = 0; i < 1000; i++) tx.saveEvent("task-1", createTaskEvent(
      tx.nextEventId("task-1"), "task-1", "fixture.history", { body: "x".repeat(1000) }, now
    ));
  });
  store.listEvents = () => assert.fail("Context must not deserialize all history");
  const revision = store.getStateRevision();
  writer.exec("BEGIN IMMEDIATE");
  try {
    const page = readTaskContext(store, "task-1");
    assert.equal(page.count, initial.count + 1000);
    assert.ok(page.records.length < 256);
    assert.equal(page.records.find(r => r.ref.store === "task-event").ref.refId, "event-1000");
    const delta = readTaskContextDelta(store, "task-1", { after: initial.coreCursor, limit: 2 });
    assert.equal(delta.count, 1000);
    assert.deepEqual(delta.events.map(e => e.ref.refId), ["event-1", "event-2"]);
    const next = readTaskContextDelta(store, "task-1", {
      after: initial.coreCursor, continuation: delta.continuation, limit: 2
    });
    assert.equal(next.count, 998);
    assert.equal(next.events[0].ref.refId, "event-3");
    assert.equal(inspectTaskContext(store, "task-1", {
      store: "task-event", refId: "event-750"
    }).value.payload.body.length, 1000);
    assert.equal(store.getStateRevision(), revision);
    assert.throws(() => store.readTransaction(tx => tx.saveTask(createTask("task-2", "forbidden", now))),
      /readonly|read-only/i);
  } finally { writer.exec("ROLLBACK"); }
});

test("telemetry yields while a writer is occupied and close drains its owned worker", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-quality-telemetry-"));
  new SqliteTaskStore(home).close();
  const telemetry = new SqliteTelemetryStore(home);
  const writer = new Database(join(home, "yui.db"));
  t.after(async () => { await telemetry.close(); writer.close(); rmSync(home, { recursive: true, force: true }); });
  telemetry.count();
  writer.exec("BEGIN IMMEDIATE");
  try {
    telemetry.observe({ taskId: "task-1", roleName: "leader", runId: "run-1", progressId: "first",
      payload: { kind: "activity" }, receivedAt: now.toISOString() });
    let completed = false;
    const flushing = telemetry.flush().then(() => { completed = true; });
    await new Promise(setImmediate);
    assert.equal(completed, false, "the event loop must be available while SQLite waits");
    writer.exec("ROLLBACK");
    await flushing;
    assert.equal(telemetry.count(), 1);
    telemetry.observe({ taskId: "task-1", roleName: "leader", runId: "run-1", progressId: "last",
      payload: { kind: "activity" }, receivedAt: now.toISOString() });
    await telemetry.close();
    assert.equal(writer.prepare("SELECT count(*) AS n FROM telemetry").get().n, 2);
  } finally { if (writer.inTransaction) writer.exec("ROLLBACK"); }
});

test("release resume re-queries uncertain effects and never repeats confirmed work or bypasses a grant", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-quality-release-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  store.saveTask(createTask("task-1", "Release evidence", now));
  store.saveCapabilityGrant("task-1", createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "operator:fixture", actions: ["post-verify"], maxUses: 1,
    irreversibilityCeiling: "irreversible"
  }, now));
  const create = id => createReleaseWorkflow(id, "task-1", {
    grantId: "capability-grant-1", source: { repository: { owner: "fixture", name: "repo" }, commit: "a".repeat(40) },
    plan: [{ id: "verify", kind: "post-verify", params: { command: "fixture-only" } }]
  }, now);
  store.saveReleaseWorkflow("task-1", create("release-workflow-1"));
  let executions = 0, queries = 0, outcome = "unknown";
  const ports = {
    async executeStep(input) {
      executions++;
      assert.equal(store.getReleaseWorkflow("task-1", "release-workflow-1").steps.verify.status, "running");
      assert.equal(store.getCapabilityGrant("task-1", "capability-grant-1").usesUsed, 1);
      assert.equal(input.idempotencyKey, "task-1/release-workflow-1/verify");
      return { outcome: "timeout", externalIdentity: { kind: "fixture", value: "receipt-1" } };
    },
    async queryStepEffect(input) {
      queries++;
      assert.deepEqual(input.externalIdentity, { kind: "fixture", value: "receipt-1" });
      return { state: outcome, externalId: "receipt-1" };
    }
  };
  const run = id => runReleaseWorkflow(store, "task-1", id, ports, { now: () => now });
  assert.equal((await run("release-workflow-1")).outcome, "unknown");
  assert.equal((await run("release-workflow-1")).outcome, "unknown");
  outcome = "exists";
  assert.equal((await run("release-workflow-1")).outcome, "succeeded");
  assert.equal((await run("release-workflow-1")).outcome, "succeeded");
  assert.equal(executions, 1);
  assert.equal(queries, 2);
  store.saveReleaseWorkflow("task-1", create("release-workflow-2"));
  assert.equal((await run("release-workflow-2")).outcome, "unauthorized");
  assert.equal(executions, 1);
});
