// Task-contract acceptance E2E for the release workflow.
//
// These tests drive the operator-facing command surface (task grant issue/revoke,
// task workflow create/run/resume/status) against a real FileTaskStore in an
// isolated temp YUI_HOME, with deterministic fake ports standing in for every
// external system (GitHub, npm, git, Controller, Home). They prove the six
// acceptance scenarios end to end:
//
//   a. recovery across process exit at any step
//   b. at-most-once side effects (call counts + idempotency keys)
//   c. timeout-but-actually-succeeded confirmed without a second submission
//   d. repeated start safety (a finished workflow is a no-op)
//   e. partial failure then resume
//   f. grant revoked/expired fails closed; a fresh grant resumes
//
// No real GitHub, npm, git, Controller, or process side effect is ever touched.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../dist/agent/agent.js";
import { runTaskCommand } from "../dist/commands/taskCommands.js";
import { runWorkflowCommandAsync } from "../dist/commands/workflowCommands.js";
import { createFakeReleasePorts } from "../dist/release/fakeReleasePorts.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { installOperatorSession } from "./helpers/operatorSession.js";

const NOW = new Date("2026-08-13T12:00:00.000Z");
const LATER = new Date("2026-08-13T13:00:00.000Z");

const SOURCE_REPO = "acme/widget";
const SOURCE_COMMIT = "abc123def4567890000000000000000000000000";

const PLAN = [
  { id: "pr", kind: "pr-create-or-reuse" },
  { id: "publish", kind: "npm-publish", irreversibility: "irreversible" },
  { id: "verify", kind: "post-verify" }
];

/** An isolated YUI_HOME per test, exactly like the engine suite's fixture. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-release-acceptance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(agent);
  });
  const operator = installOperatorSession(store, agent, NOW);
  return { root, store, operator };
}

function createTask(store) {
  return runTaskCommand(["create", "Release acceptance"], store, { now: () => NOW }).data.task;
}

/** Issues a grant covering the full plan with an irreversible ceiling. */
function issueFullGrant(store, task, operator, extraArgs = []) {
  return runTaskCommand([
    "grant", "issue", task.id,
    "--action", "pr-create-or-reuse",
    "--action", "npm-publish",
    "--action", "post-verify",
    "--action", "merge",
    "--irreversibility-ceiling", "irreversible",
    ...extraArgs
  ], store, { now: () => NOW, environment: operator.environment }).data;
}

function createWorkflow(store, task, plan = PLAN) {
  return runTaskCommand([
    "workflow", "create", task.id,
    "--grant", "capability-grant-1",
    "--source-repo", SOURCE_REPO,
    "--source-commit", SOURCE_COMMIT,
    "--source-artifact", "widget-1.2.3.tgz@sha512-dGVzdC1pbnRlZ3JpdHk=",
    ...plan.flatMap((entry) => [
      "--step", `${entry.id}:${entry.kind}`,
      ...(entry.irreversibility === undefined
        ? []
        : ["--step-irreversibility", `${entry.id}=${entry.irreversibility}`])
    ])
  ], store, { now: () => NOW }).data;
}

/** A clock that ticks one second per call so every transition has a fresh stamp. */
function tickingClock() {
  let tick = 0;
  return () => new Date(NOW.getTime() + (++tick) * 1000);
}

const ok = (externalId) => ({ outcome: "succeeded", externalId, logs: [`ok ${externalId}`] });
const boom = (message) => ({ outcome: "failed", error: message, logs: [`fail ${message}`] });
const timeoutWith = (kind, value) => ({
  outcome: "timeout",
  externalIdentity: { kind, value },
  logs: [`timeout ${kind}=${value}`]
});

function threeStepPorts() {
  return createFakeReleasePorts({
    pr: { execute: [ok("pr:42")] },
    publish: { execute: [ok("1.2.3")] },
    verify: { execute: [ok("verified")] }
  });
}

/** Drives the operator CLI the same way the yui binary does. */
async function run(store, task, workflow, ports, extraArgs = [], clock = tickingClock()) {
  return runWorkflowCommandAsync(
    ["run", task.id, workflow.id, ...extraArgs],
    store,
    { now: clock, ports }
  );
}

async function resume(store, task, workflow, ports, extraArgs = [], clock = tickingClock()) {
  return runWorkflowCommandAsync(
    ["resume", task.id, workflow.id, ...extraArgs],
    store,
    { now: clock, ports }
  );
}

function savedWorkflow(store, task, workflow) {
  return store.getReleaseWorkflow(task.id, workflow.id);
}

// ---------------------------------------------------------------------------
// (a) Recovery across process exit at any step
// ---------------------------------------------------------------------------

test("acceptance: recovers across process exits at every step and persists external ids", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = createWorkflow(store, task);
  const ports = threeStepPorts();
  const clock = tickingClock();

  // Simulate a process exit after every step: each invocation is a fresh
  // engine run that reloads the persisted workflow from the isolated home.
  const first = await run(store, task, workflow, ports, ["--max-steps", "1"], clock);
  assert.equal(first.data.outcome, "budget-exhausted");
  assert.equal(first.data.stopReason, "budget-exhausted:publish");
  let saved = savedWorkflow(store, task, workflow);
  assert.equal(saved.steps.pr.status, "succeeded");
  assert.equal(saved.steps.pr.externalId, "pr:42", "the first external id survives the exit");
  assert.equal(saved.steps.publish.status, "pending");

  const second = await resume(store, task, workflow, ports, ["--max-steps", "1"], clock);
  assert.equal(second.data.outcome, "budget-exhausted");
  assert.equal(second.data.stopReason, "budget-exhausted:verify");
  saved = savedWorkflow(store, task, workflow);
  assert.equal(saved.steps.publish.status, "succeeded");
  assert.equal(saved.steps.publish.externalId, "1.2.3", "the second external id survives the exit");
  assert.equal(saved.steps.verify.status, "pending");

  const third = await resume(store, task, workflow, ports, [], clock);
  assert.equal(third.data.outcome, "succeeded");
  assert.equal(third.data.status, "succeeded");
  assert.deepEqual(third.data.attempted, ["verify"]);
  saved = savedWorkflow(store, task, workflow);
  assert.equal(saved.steps.verify.status, "succeeded");
  assert.equal(saved.steps.pr.externalId, "pr:42");
  assert.equal(saved.steps.publish.externalId, "1.2.3");

  // Each external effect happened exactly once across the three processes.
  assert.equal(ports.calls("pr").execute, 1);
  assert.equal(ports.calls("publish").execute, 1);
  assert.equal(ports.calls("verify").execute, 1);
  assert.ok(ports.exhausted(), "no scripted outcome went unused");

  // The operator-facing status reflects the recovered, finished workflow.
  const status = runTaskCommand(
    ["workflow", "status", task.id, workflow.id],
    store,
    { now: () => NOW }
  );
  assert.ok(status.output.includes("Status: succeeded"));
  assert.ok(status.output.includes("[succeeded] pr (pr-create-or-reuse)"));
  assert.ok(status.output.includes("[succeeded] publish (npm-publish)"));
  assert.ok(status.output.includes("[succeeded] verify (post-verify)"));
});

// ---------------------------------------------------------------------------
// (b) At-most-once side effects
// ---------------------------------------------------------------------------

test("acceptance: every external effect happens at most once under a stable idempotency key", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = createWorkflow(store, task);
  const ports = threeStepPorts();

  const result = await run(store, task, workflow, ports);

  assert.equal(result.data.outcome, "succeeded");
  assert.deepEqual(result.data.attempted, ["pr", "publish", "verify"]);
  for (const stepId of ["pr", "publish", "verify"]) {
    const calls = ports.calls(stepId);
    assert.equal(calls.execute, 1, `${stepId} executed exactly once`);
    assert.deepEqual(calls.keys, [`${task.id}/${workflow.id}/${stepId}`],
      `${stepId} carries its predeclared idempotency key`);
  }
  assert.ok(ports.exhausted());
});

test("acceptance: a re-attempt after a confirmed-absent timeout reuses the same idempotency key", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = createWorkflow(store, task);
  const ports = createFakeReleasePorts({
    pr: { execute: [ok("pr:42")] },
    publish: {
      execute: [timeoutWith("npm-package", "yui"), ok("1.2.3")],
      query: [{ state: "absent" }]
    },
    verify: { execute: [ok("verified")] }
  });
  const clock = tickingClock();

  const first = await run(store, task, workflow, ports, [], clock);
  assert.equal(first.data.outcome, "unknown");
  assert.equal(first.data.stopReason, "unknown:publish");

  const second = await resume(store, task, workflow, ports, [], clock);
  assert.equal(second.data.outcome, "succeeded");
  const calls = ports.calls("publish");
  assert.equal(calls.execute, 2, "the absent effect is re-attempted exactly once");
  assert.equal(calls.query, 1, "the authoritative query precedes the re-attempt");
  assert.deepEqual(calls.keys, [
    `${task.id}/${workflow.id}/publish`,
    `${task.id}/${workflow.id}/publish`
  ], "both attempts carry the same idempotency key");
});

// ---------------------------------------------------------------------------
// (c) Timeout-but-actually-succeeded
// ---------------------------------------------------------------------------

test("acceptance: a timeout that actually succeeded is confirmed without a second submission", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = createWorkflow(store, task);
  const ports = createFakeReleasePorts({
    pr: { execute: [ok("pr:42")] },
    publish: {
      execute: [timeoutWith("npm-package", "yui")],
      query: [{ state: "exists", externalId: "1.2.3" }]
    },
    verify: { execute: [ok("verified")] }
  });
  const clock = tickingClock();

  const first = await run(store, task, workflow, ports, [], clock);
  assert.equal(first.data.outcome, "unknown");
  assert.equal(first.data.stopReason, "unknown:publish");
  assert.equal(savedWorkflow(store, task, workflow).steps.publish.status, "unknown");

  const second = await resume(store, task, workflow, ports, [], clock);
  assert.equal(second.data.outcome, "succeeded");
  assert.equal(ports.calls("publish").execute, 1, "publish must never be re-submitted");
  assert.equal(ports.calls("publish").query, 1, "the authoritative query confirms success");
  assert.equal(second.data.workflow.steps.publish.externalId, "1.2.3");
  assert.equal(second.data.workflow.steps.publish.status, "succeeded");
  assert.equal(ports.calls("verify").execute, 1, "the workflow advances past the confirmed step");
});

// ---------------------------------------------------------------------------
// (d) Repeated start safety
// ---------------------------------------------------------------------------

test("acceptance: running an already-succeeded workflow is a no-op", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = createWorkflow(store, task);
  const ports = threeStepPorts();

  const first = await run(store, task, workflow, ports);
  assert.equal(first.data.outcome, "succeeded");

  // A second run (or resume) against the finished workflow submits nothing.
  const again = await run(store, task, workflow, ports, [], tickingClock());
  assert.equal(again.data.outcome, "succeeded");
  assert.deepEqual(again.data.attempted, []);
  const onceMore = await resume(store, task, workflow, ports, [], tickingClock());
  assert.equal(onceMore.data.outcome, "succeeded");
  assert.deepEqual(onceMore.data.attempted, []);

  assert.equal(ports.calls("pr").execute, 1);
  assert.equal(ports.calls("publish").execute, 1);
  assert.equal(ports.calls("verify").execute, 1);
  assert.ok(ports.exhausted());
});

// ---------------------------------------------------------------------------
// (e) Partial failure then resume
// ---------------------------------------------------------------------------

test("acceptance: a failed step is retried on resume and then completes", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = createWorkflow(store, task);
  const ports = createFakeReleasePorts({
    pr: { execute: [ok("pr:42")] },
    publish: { execute: [boom("registry flake"), ok("1.2.3")] },
    verify: { execute: [ok("verified")] }
  });
  const clock = tickingClock();

  const first = await run(store, task, workflow, ports, [], clock);
  assert.equal(first.data.outcome, "failed");
  assert.equal(first.data.stopReason, "failed:publish");
  assert.equal(first.data.status, "failed");
  assert.equal(savedWorkflow(store, task, workflow).steps.publish.attempts, 1);
  assert.equal(ports.calls("verify").execute, 0, "the workflow halts behind the failure");

  const second = await resume(store, task, workflow, ports, [], clock);
  assert.equal(second.data.outcome, "succeeded");
  assert.equal(ports.calls("publish").execute, 2, "the failed step is retried exactly once");
  assert.equal(second.data.workflow.steps.publish.attempts, 2);
  assert.equal(second.data.workflow.steps.publish.status, "succeeded");
  assert.equal(second.data.workflow.steps.publish.externalId, "1.2.3");
  assert.equal(ports.calls("pr").execute, 1, "the confirmed prefix is not re-run");
  assert.equal(ports.calls("verify").execute, 1);
});

// ---------------------------------------------------------------------------
// (f) Grant revoked/expired fails closed; a fresh grant resumes
// ---------------------------------------------------------------------------

test("acceptance: a revoked grant halts the workflow and a fresh grant resumes it", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = createWorkflow(store, task);
  const ports = threeStepPorts();
  const clock = tickingClock();

  const first = await run(store, task, workflow, ports, ["--max-steps", "1"], clock);
  assert.equal(first.data.outcome, "budget-exhausted");
  assert.equal(ports.calls("pr").execute, 1);

  // The operator revokes the grant between steps.
  const revoked = runTaskCommand(
    ["grant", "revoke", task.id, "capability-grant-1"],
    store,
    { now: () => LATER, environment: operator.environment }
  );
  assert.equal(revoked.kind, "output");
  assert.equal(revoked.data.revokedBy, operator.granter);

  const halted = await resume(store, task, workflow, ports, [], clock);
  assert.equal(halted.data.outcome, "unauthorized");
  assert.equal(halted.data.stopReason, "unauthorized:grant-revoked");
  assert.equal(ports.calls("publish").execute, 0, "the workflow halts before the next external effect");
  const denied = savedWorkflow(store, task, workflow).steps.publish;
  assert.equal(denied.status, "failed");
  assert.match(denied.logs.join("\n"), /unauthorized: grant-revoked/);

  // A granter issues a fresh grant covering the remaining catalog; the run
  // rebinds and completes from the denied step.
  issueFullGrant(store, task, operator);
  const resumed = await resume(store, task, workflow, ports, ["--grant", "capability-grant-2"], clock);
  assert.equal(resumed.data.outcome, "succeeded");
  assert.equal(resumed.data.workflow.grantId, "capability-grant-2");
  assert.equal(ports.calls("publish").execute, 1);
  assert.equal(ports.calls("verify").execute, 1);
  assert.ok(ports.exhausted());
});

test("acceptance: an expired grant fails closed at the next step", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator, [
    "--expires-at", new Date(NOW.getTime() + 30 * 60 * 1000).toISOString()
  ]);
  const workflow = createWorkflow(store, task);
  const ports = threeStepPorts();
  let now = NOW;
  const clock = () => now;

  const first = await run(store, task, workflow, ports, ["--max-steps", "1"], clock);
  assert.equal(first.data.outcome, "budget-exhausted");
  assert.equal(ports.calls("pr").execute, 1);

  // Time advances past the grant's expiry before the next submission.
  now = LATER;
  const halted = await resume(store, task, workflow, ports, [], clock);
  assert.equal(halted.data.outcome, "unauthorized");
  assert.equal(halted.data.stopReason, "unauthorized:grant-expired");
  assert.equal(ports.calls("publish").execute, 0, "no external effect after expiry");
  assert.equal(ports.calls("verify").execute, 0);
  assert.equal(savedWorkflow(store, task, workflow).steps.publish.status, "failed");
});
