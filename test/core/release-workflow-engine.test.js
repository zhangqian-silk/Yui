import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { runWorkflowCommandAsync } from "../../dist/commands/workflowCommands.js";
import {
  createReleaseWorkflow,
  markStepUnknown,
  startStep
} from "../../dist/release/releaseWorkflow.js";
import { runReleaseWorkflow } from "../../dist/release/releaseWorkflowEngine.js";
import { createFakeReleasePorts } from "../../dist/release/fakeReleasePorts.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { installOperatorSession } from "../helpers/operatorSession.js";

const NOW = new Date("2026-08-13T12:00:00.000Z");
const LATER = new Date("2026-08-13T13:00:00.000Z");

const SOURCE = Object.freeze({
  repository: { owner: "acme", name: "widget" },
  commit: "abc123def4567890000000000000000000000000",
  artifact: { name: "widget-1.2.3.tgz", integrity: "sha512-dGVzdC1pbnRlZ3JpdHk=" }
});

const PLAN = [
  { id: "pr", kind: "pr-create-or-reuse" },
  { id: "publish", kind: "npm-publish", irreversibility: "irreversible" },
  { id: "verify", kind: "post-verify" }
];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-release-engine-"));
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
  const result = runTaskCommand(["create", "Release engine test"], store, { now: () => NOW });
  return result.data.task;
}

/**
 * Issues a grant authorizing the full step catalog with an irreversible
 * ceiling; extra flags pass through to the grant CLI.
 */
function issueFullGrant(store, task, operator, extraArgs = []) {
  const result = runTaskCommand([
    "grant", "issue", task.id,
    "--action", "pr-create-or-reuse",
    "--action", "npm-publish",
    "--action", "post-verify",
    "--action", "merge",
    "--irreversibility-ceiling", "irreversible",
    ...extraArgs
  ], store, { now: () => NOW, environment: operator.environment });
  return result.data;
}

function setupWorkflow(store, task, plan = PLAN, grantId) {
  const created = runTaskCommand([
    "workflow", "create", task.id,
    "--grant", grantId ?? "capability-grant-1",
    "--source-repo", "acme/widget",
    "--source-commit", "abc123def4567890000000000000000000000000",
    "--source-artifact", "widget-1.2.3.tgz@sha512-dGVzdC1pbnRlZ3JpdHk=",
    ...plan.flatMap((entry) => [
      "--step", `${entry.id}:${entry.kind}`,
      ...(entry.irreversibility === undefined
        ? []
        : ["--step-irreversibility", `${entry.id}=${entry.irreversibility}`])
    ])
  ], store, { now: () => NOW });
  return created.data;
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

function threeStepPorts(overrides = {}) {
  return createFakeReleasePorts({
    pr: { execute: [ok("pr:42")] },
    publish: { execute: [ok("1.2.3")], ...overrides.publish },
    verify: { execute: [ok("verified")], ...overrides.verify }
  });
}

// ---------------------------------------------------------------------------
// Happy path and resume
// ---------------------------------------------------------------------------

test("runs the whole plan in one pass and records each external id", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task);
  const ports = threeStepPorts();

  const result = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: tickingClock() });

  assert.equal(result.outcome, "succeeded");
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.attempted, ["pr", "publish", "verify"]);
  assert.equal(ports.calls("pr").execute, 1);
  assert.equal(ports.calls("publish").execute, 1);
  assert.equal(ports.calls("verify").execute, 1);
  const saved = store.getReleaseWorkflow(task.id, workflow.id);
  assert.equal(saved.steps.pr.externalId, "pr:42");
  assert.equal(saved.steps.publish.externalId, "1.2.3");
  assert.equal(saved.steps.verify.status, "succeeded");
});

test("resumes across process restarts: maxSteps=1 per run, three runs finish", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task);
  const ports = threeStepPorts();
  const clock = tickingClock();

  const first = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: clock, maxSteps: 1 });
  assert.equal(first.outcome, "budget-exhausted");
  assert.equal(first.stopReason, "budget-exhausted:publish");
  assert.equal(first.attempted.length, 1);

  // A fresh engine run (new process) loads the persisted workflow and continues.
  const second = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: clock, maxSteps: 1 });
  assert.equal(second.outcome, "budget-exhausted");
  assert.equal(second.stopReason, "budget-exhausted:verify");

  const third = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: clock, maxSteps: 1 });
  assert.equal(third.outcome, "succeeded");
  assert.equal(third.status, "succeeded");
  assert.equal(ports.calls("pr").execute, 1);
  assert.equal(ports.calls("publish").execute, 1);
  assert.equal(ports.calls("verify").execute, 1);
});

test("a completed workflow is a no-op", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task);
  const ports = threeStepPorts();

  await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: tickingClock() });
  const again = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: tickingClock() });

  assert.equal(again.outcome, "succeeded");
  assert.deepEqual(again.attempted, []);
  assert.equal(ports.calls("pr").execute, 1);
});

// ---------------------------------------------------------------------------
// Timeout-but-maybe-succeeded: authoritative query before any re-submission
// ---------------------------------------------------------------------------

test("timeout then authoritative exists: confirms without a second submission", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task);
  const ports = createFakeReleasePorts({
    pr: { execute: [ok("pr:42")] },
    publish: {
      execute: [timeoutWith("npm-package", "yui")],
      query: [{ state: "exists", externalId: "1.2.3" }]
    },
    verify: { execute: [ok("verified")] }
  });
  const clock = tickingClock();

  const first = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: clock });
  assert.equal(first.outcome, "unknown");
  assert.equal(first.stopReason, "unknown:publish");
  assert.equal(first.status, "unknown");
  assert.equal(ports.calls("publish").execute, 1);
  assert.equal(store.getReleaseWorkflow(task.id, workflow.id).steps.publish.status, "unknown");

  const second = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: clock });
  assert.equal(second.outcome, "succeeded");
  assert.equal(ports.calls("publish").execute, 1, "publish must never be re-submitted");
  assert.equal(ports.calls("publish").query, 1);
  assert.equal(second.workflow.steps.publish.externalId, "1.2.3");
});

test("timeout then authoritative absent: re-attempts exactly once with the same key", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task);
  const ports = createFakeReleasePorts({
    pr: { execute: [ok("pr:42")] },
    publish: {
      execute: [timeoutWith("npm-package", "yui"), ok("1.2.3")],
      query: [{ state: "absent" }]
    },
    verify: { execute: [ok("verified")] }
  });
  const clock = tickingClock();

  const first = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: clock });
  assert.equal(first.outcome, "unknown");
  const second = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: clock });

  assert.equal(second.outcome, "succeeded");
  const calls = ports.calls("publish");
  assert.equal(calls.execute, 2);
  assert.equal(calls.query, 1, "the authoritative query precedes the re-attempt");
  assert.deepEqual(calls.keys, [
    `${task.id}/${workflow.id}/publish`,
    `${task.id}/${workflow.id}/publish`
  ], "both attempts carry the same idempotency key");
});

test("unknown stays unknown: an unknown query never re-submits", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task);
  const ports = createFakeReleasePorts({
    pr: { execute: [ok("pr:42")] },
    publish: {
      execute: [timeoutWith("npm-package", "yui")],
      query: [{ state: "unknown" }, { state: "unknown" }]
    },
    verify: { execute: [ok("verified")] }
  });
  const clock = tickingClock();

  const first = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: clock });
  assert.equal(first.outcome, "unknown");
  const second = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: clock });
  const third = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: clock });

  assert.equal(second.outcome, "unknown");
  assert.equal(third.outcome, "unknown");
  assert.equal(third.stopReason, "unknown:publish");
  assert.equal(ports.calls("publish").execute, 1, "an unknown step is never re-submitted");
  assert.equal(ports.calls("publish").query, 2);
  assert.equal(ports.calls("verify").execute, 0, "the workflow does not advance past unknown");
});

test("timeout without an external identity marks the step unknown, not failed", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task);
  const ports = createFakeReleasePorts({
    pr: { execute: [ok("pr:42")] },
    publish: { execute: [{ outcome: "timeout", logs: ["lost in flight"] }] },
    verify: { execute: [ok("verified")] }
  });

  const result = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: tickingClock() });

  // A timeout without an identity means the effect may have landed but cannot
  // be re-queried. The step is marked unknown (unconfirmed) rather than
  // failed: a failed step would be re-submitted on the next run, potentially
  // duplicating an effect that actually landed.
  assert.equal(result.outcome, "unknown");
  assert.equal(result.stopReason, "unknown:publish");
  assert.equal(result.status, "unknown");
  assert.equal(ports.calls("publish").execute, 1);
  assert.equal(ports.calls("verify").execute, 0, "the workflow does not advance past unknown");
  assert.match(store.getReleaseWorkflow(task.id, workflow.id).steps.publish.logs.join("\n"), /timeout without external identity/);
});

// ---------------------------------------------------------------------------
// Crash recovery for steps left running
// ---------------------------------------------------------------------------

test("a running step with an identity is queried, not re-submitted", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task, [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]);

  // Simulate a crash: the step was started, timed out once (unknown), then a
  // recovery run re-entered running and died before answering.
  let crashed = startStep(store.getReleaseWorkflow(task.id, workflow.id), "publish", NOW);
  store.saveReleaseWorkflow(task.id, crashed);
  crashed = markStepUnknown(crashed, "publish", { externalIdentity: { kind: "npm-package", value: "yui" } }, NOW);
  store.saveReleaseWorkflow(task.id, crashed);
  crashed = startStep(crashed, "publish", NOW);
  store.saveReleaseWorkflow(task.id, crashed);

  const ports = createFakeReleasePorts({
    publish: {
      execute: [boom("must not be called")],
      query: [{ state: "exists", externalId: "1.2.3" }]
    }
  });
  const result = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: tickingClock() });

  assert.equal(result.outcome, "succeeded");
  assert.equal(ports.calls("publish").execute, 0);
  assert.equal(ports.calls("publish").query, 1);
  assert.equal(result.workflow.steps.publish.status, "succeeded");
  assert.equal(result.workflow.steps.publish.externalId, "1.2.3");
});

test("a running step without an identity is re-attempted after a crash", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  // npm-publish is inherently irreversible even without an explicit plan
  // declaration, so the engine must query authoritatively before re-submitting.
  const workflow = setupWorkflow(store, task, [{ id: "publish", kind: "npm-publish" }]);
  let crashed = startStep(store.getReleaseWorkflow(task.id, workflow.id), "publish", NOW);
  store.saveReleaseWorkflow(task.id, crashed);

  // The process died after persisting "running" but before the external
  // submission; the port proves the effect absent, so the idempotency-keyed
  // re-attempt is safe.
  const ports = createFakeReleasePorts({
    publish: { execute: [ok("1.2.3")], query: [{ state: "absent" }] }
  });
  const result = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: tickingClock() });

  assert.equal(result.outcome, "succeeded");
  assert.equal(ports.calls("publish").query, 1, "the authoritative query precedes the re-attempt");
  assert.equal(ports.calls("publish").execute, 1);
  assert.equal(result.workflow.steps.publish.status, "succeeded");
});

// ---------------------------------------------------------------------------
// Authorization: fail closed
// ---------------------------------------------------------------------------

test("a grant missing the step action fails closed and records the denial", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  runTaskCommand([
    "grant", "issue", task.id,
    "--action", "pr-create-or-reuse",
    "--irreversibility-ceiling", "irreversible"
  ], store, { now: () => NOW, environment: operator.environment });
  const workflow = setupWorkflow(store, task);
  const ports = threeStepPorts();

  const result = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: tickingClock() });

  assert.equal(result.outcome, "unauthorized");
  assert.equal(result.stopReason, "unauthorized:grant-action-not-allowed");
  assert.equal(ports.calls("pr").execute, 1);
  assert.equal(ports.calls("publish").execute, 0);
  const publish = store.getReleaseWorkflow(task.id, workflow.id).steps.publish;
  assert.equal(publish.status, "failed");
  assert.match(publish.logs.join("\n"), /unauthorized: grant-action-not-allowed/);
});

test("rebinding to a broader grant resumes the workflow", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  runTaskCommand([
    "grant", "issue", task.id,
    "--action", "pr-create-or-reuse",
    "--irreversibility-ceiling", "irreversible"
  ], store, { now: () => NOW, environment: operator.environment });
  const workflow = setupWorkflow(store, task);
  const ports = threeStepPorts();
  const clock = tickingClock();

  const denied = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: clock });
  assert.equal(denied.outcome, "unauthorized");

  // A new grant covers the remaining catalog; the run rebinds and continues.
  issueFullGrant(store, task, operator);
  const resumed = await runReleaseWorkflow(store, task.id, workflow.id, ports, {
    now: clock,
    grantId: "capability-grant-2"
  });

  assert.equal(resumed.outcome, "succeeded");
  assert.equal(resumed.workflow.grantId, "capability-grant-2");
  assert.equal(ports.calls("publish").execute, 1);
});

test("a parameter bound rejects an out-of-bounds value", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  runTaskCommand([
    "grant", "issue", task.id,
    "--action", "npm-publish",
    "--param", "version=1.2.3",
    "--irreversibility-ceiling", "irreversible"
  ], store, { now: () => NOW, environment: operator.environment });
  const workflow = createWorkflowWithParam(store, task);
  const ports = createFakeReleasePorts({
    publish: { execute: [ok("9.9.9")] }
  });

  const result = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: tickingClock() });

  assert.equal(result.outcome, "unauthorized");
  assert.equal(result.stopReason, "unauthorized:grant-parameter-value-not-allowed");
  assert.equal(ports.calls("publish").execute, 0);
});

test("an irreversible step under a reversible ceiling is denied", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  runTaskCommand([
    "grant", "issue", task.id,
    "--action", "npm-publish",
    "--irreversibility-ceiling", "reversible"
  ], store, { now: () => NOW, environment: operator.environment });
  const workflow = setupWorkflow(store, task, [
    { id: "publish", kind: "npm-publish", irreversibility: "irreversible" }
  ]);
  const ports = createFakeReleasePorts({ publish: { execute: [ok("1.2.3")] } });

  const result = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: tickingClock() });

  assert.equal(result.outcome, "unauthorized");
  assert.equal(result.stopReason, "unauthorized:grant-irreversibility-exceeds-ceiling");
  assert.equal(ports.calls("publish").execute, 0);
});

test("an irreversible step refuses to start while a prior step failed", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task);
  const ports = createFakeReleasePorts({
    pr: { execute: [boom("ci red")] },
    publish: { execute: [ok("1.2.3")] },
    verify: { execute: [ok("verified")] }
  });

  const result = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: tickingClock() });

  assert.equal(result.outcome, "failed");
  assert.equal(result.stopReason, "failed:pr");
  assert.equal(ports.calls("publish").execute, 0, "the irreversible publish never runs behind a failed PR");
  assert.equal(ports.calls("verify").execute, 0);
});

test("maxUses fails closed on the attempt that would exceed it", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator, ["--max-uses", "2"]);
  const workflow = setupWorkflow(store, task);
  const ports = threeStepPorts();

  const result = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: tickingClock() });

  assert.equal(result.outcome, "unauthorized");
  assert.equal(result.stopReason, "unauthorized:grant-uses-exhausted");
  assert.equal(ports.calls("pr").execute, 1);
  assert.equal(ports.calls("publish").execute, 1);
  assert.equal(ports.calls("verify").execute, 0);
  const grant = store.getCapabilityGrant(task.id, "capability-grant-1");
  assert.equal(grant.usesUsed, 2);
});

// ---------------------------------------------------------------------------
// P1-1: maxUses bypass via cross-workflow running step
// ---------------------------------------------------------------------------

test("a cross-workflow running step cannot bypass maxUses", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  // maxUses=2: one for the PR step, one for the publish step.
  issueFullGrant(store, task, operator, ["--max-uses", "2"]);

  // Workflow A uses both grant uses and crashes mid-publish (timeout without
  // identity). The publish step is marked unknown, not failed.
  const workflowA = setupWorkflow(store, task);
  const portsA = createFakeReleasePorts({
    pr: { execute: [ok("pr:42")] },
    publish: { execute: [{ outcome: "timeout", logs: ["lost in flight"] }] },
    verify: { execute: [ok("verified")] }
  });
  const resultA = await runReleaseWorkflow(store, task.id, workflowA.id, portsA, { now: tickingClock() });
  assert.equal(resultA.outcome, "unknown");
  assert.equal(resultA.status, "unknown");

  // Workflow B uses the same grant. The grant's uses were consumed by
  // workflow A; workflow B must not be treated as "already paid" just because
  // the grant has usesUsed > 0.
  const workflowB = setupWorkflow(store, task);
  const portsB = threeStepPorts();
  const resultB = await runReleaseWorkflow(store, task.id, workflowB.id, portsB, { now: tickingClock() });

  assert.equal(resultB.outcome, "unauthorized");
  assert.equal(resultB.stopReason, "unauthorized:grant-uses-exhausted");
  assert.equal(portsB.calls("pr").execute, 0, "workflow B never starts: the grant is exhausted");
  assert.equal(portsB.calls("publish").execute, 0);
  assert.equal(portsB.calls("verify").execute, 0);
  const grant = store.getCapabilityGrant(task.id, "capability-grant-1");
  assert.equal(grant.usesUsed, 2, "the grant was used exactly twice (by workflow A)");
});

// The vulnerable window: B persists "running" but crashes before its grant
// use is committed, so no reservation exists for B's attempt. A then consumes
// the final use. B's resume must not read its own exhaustion denial as "this
// attempt already paid" and execute anyway.
test("a running step with no committed use cannot ride another workflow's exhaustion", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator, ["--max-uses", "1"]);
  const plan = [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }];

  // B starts and dies between the running-save and the grant-use commit.
  const workflowB = setupWorkflow(store, task, plan);
  const crashBeforeUse = {
    getReleaseWorkflow: (taskId, workflowId) => store.getReleaseWorkflow(taskId, workflowId),
    saveReleaseWorkflow: (taskId, next) => store.saveReleaseWorkflow(taskId, next),
    getCapabilityGrant: (taskId, grantId) => store.getCapabilityGrant(taskId, grantId),
    saveCapabilityGrant: () => {
      throw new Error("crash before grant-use commit");
    }
  };
  await assert.rejects(
    runReleaseWorkflow(
      crashBeforeUse,
      task.id,
      workflowB.id,
      createFakeReleasePorts({ publish: { execute: [ok("1.2.3")] } }),
      { now: tickingClock() }
    ),
    /crash before grant-use/
  );

  // A consumes the only use with its own reservation and completes.
  const workflowA = setupWorkflow(store, task, plan);
  const portsA = createFakeReleasePorts({ publish: { execute: [ok("1.2.3")] } });
  const resultA = await runReleaseWorkflow(store, task.id, workflowA.id, portsA, { now: tickingClock() });
  assert.equal(resultA.outcome, "succeeded");

  // B resumes: running without an identity, the effect proven absent, but the
  // grant is exhausted by A and B has no recognized use. The re-attempt is
  // denied, not treated as already paid.
  const portsB = createFakeReleasePorts({
    publish: { execute: [ok("1.2.3")], query: [{ state: "absent" }] }
  });
  const resultB = await runReleaseWorkflow(store, task.id, workflowB.id, portsB, { now: tickingClock() });
  assert.equal(resultB.outcome, "unauthorized");
  assert.equal(resultB.stopReason, "unauthorized:grant-uses-exhausted");
  assert.equal(portsB.calls("publish").execute, 0, "B never executes: the exhaustion is A's paid use, not B's");
  const grant = store.getCapabilityGrant(task.id, "capability-grant-1");
  assert.equal(grant.usesUsed, 1, "only A's use was ever recorded");
});

// The positive side of the same contract: when B's use WAS committed with its
// own reservation before the crash, B's re-attempt stays free even after A
// consumes the final use.
test("a running step's own committed use stays free after another workflow exhausts the grant", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator, ["--max-uses", "2"]);
  const plan = [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }];

  // B starts, its use is committed (reservation B#1), then the process dies
  // before the external call.
  const workflowB = setupWorkflow(store, task, plan);
  let crashOnce = true;
  const crashAfterUse = {
    getReleaseWorkflow: (taskId, workflowId) => store.getReleaseWorkflow(taskId, workflowId),
    saveReleaseWorkflow: (taskId, next) => store.saveReleaseWorkflow(taskId, next),
    getCapabilityGrant: (taskId, grantId) => store.getCapabilityGrant(taskId, grantId),
    saveCapabilityGrant: (taskId, next) => {
      store.saveCapabilityGrant(taskId, next);
      if (crashOnce) {
        crashOnce = false;
        throw new Error("crash after grant-use commit");
      }
    }
  };
  await assert.rejects(
    runReleaseWorkflow(
      crashAfterUse,
      task.id,
      workflowB.id,
      createFakeReleasePorts({ publish: { execute: [ok("1.2.3")] } }),
      { now: tickingClock() }
    ),
    /crash after grant-use/
  );

  // A consumes the second and final use.
  const workflowA = setupWorkflow(store, task, plan);
  const portsA = createFakeReleasePorts({ publish: { execute: [ok("1.2.3")] } });
  const resultA = await runReleaseWorkflow(store, task.id, workflowA.id, portsA, { now: tickingClock() });
  assert.equal(resultA.outcome, "succeeded");

  // B resumes against an exhausted grant: its exact reservation is
  // recognized, so the re-attempt is free and completes without a third use.
  const portsB = createFakeReleasePorts({
    publish: { execute: [ok("1.2.3")], query: [{ state: "absent" }] }
  });
  const resultB = await runReleaseWorkflow(store, task.id, workflowB.id, portsB, { now: tickingClock() });
  assert.equal(resultB.outcome, "succeeded");
  assert.equal(portsB.calls("publish").execute, 1);
  const grant = store.getCapabilityGrant(task.id, "capability-grant-1");
  assert.equal(grant.usesUsed, 2, "B's use and A's use; the free re-attempt deducts nothing");
});

// ---------------------------------------------------------------------------
// P1-2: timeout-without-identity is unknown, not failed
// ---------------------------------------------------------------------------

test("a timeout-without-identity step is not re-submitted on resume", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task);
  const ports = createFakeReleasePorts({
    pr: { execute: [ok("pr:42")] },
    publish: { execute: [{ outcome: "timeout", logs: ["lost in flight"] }] },
    verify: { execute: [ok("verified")] }
  });

  const first = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: tickingClock() });
  assert.equal(first.outcome, "unknown");
  assert.equal(first.status, "unknown");
  assert.equal(ports.calls("publish").execute, 1);

  // A second run must not re-submit the publish step: the effect may have
  // landed, and without an identity it cannot be re-queried. The engine
  // returns "unconfirmed" for an unknown step without an identity.
  const second = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: tickingClock() });
  assert.equal(second.outcome, "unconfirmed");
  assert.equal(ports.calls("publish").execute, 1, "the publish step is not re-submitted");
  assert.equal(ports.calls("verify").execute, 0, "the workflow does not advance past unknown");
});

// ---------------------------------------------------------------------------
// Partial failure and recovery
// ---------------------------------------------------------------------------

test("a failed step is retried on resume and then completes", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task);
  const ports = createFakeReleasePorts({
    pr: { execute: [ok("pr:42")] },
    publish: { execute: [boom("registry flake"), ok("1.2.3")] },
    verify: { execute: [ok("verified")] }
  });
  const clock = tickingClock();

  const first = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: clock });
  assert.equal(first.outcome, "failed");
  assert.equal(first.status, "failed");
  assert.equal(store.getReleaseWorkflow(task.id, workflow.id).steps.publish.attempts, 1);

  const second = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: clock });
  assert.equal(second.outcome, "succeeded");
  assert.equal(ports.calls("publish").execute, 2);
  assert.equal(second.workflow.steps.publish.attempts, 2);
  assert.equal(second.workflow.steps.publish.status, "succeeded");
});

test("a revoked grant stops the run at the next step", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task);
  const ports = createFakeReleasePorts({
    pr: { execute: [ok("pr:42")] },
    publish: { execute: [ok("1.2.3")] },
    verify: { execute: [ok("verified")] }
  });

  // Revoke between steps: the first run completes pr, then the grant is gone.
  const clock = () => LATER;
  const first = await runReleaseWorkflow(store, task.id, workflow.id, ports, {
    now: clock,
    maxSteps: 1
  });
  assert.equal(first.outcome, "budget-exhausted");
  runTaskCommand(["grant", "revoke", task.id, "capability-grant-1"], store, { now: clock, environment: operator.environment });

  const second = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: clock });
  assert.equal(second.outcome, "unauthorized");
  assert.equal(second.stopReason, "unauthorized:grant-revoked");
  assert.equal(ports.calls("publish").execute, 0);
});

// ---------------------------------------------------------------------------
// Param references
// ---------------------------------------------------------------------------

test("$externalId references resolve against confirmed steps", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  runTaskCommand([
    "grant", "issue", task.id,
    "--action", "pr-create-or-reuse",
    "--action", "merge",
    "--irreversibility-ceiling", "irreversible"
  ], store, { now: () => NOW, environment: operator.environment });
  // The merge step consumes the PR number the pr step produced.
  const workflow = createMergeWorkflowWithRef(store, task);
  const seen = {};
  const inner = createFakeReleasePorts({
    pr: { execute: [ok("pr:42")] },
    merge: { execute: [ok("merge:42")] }
  });
  const ports = {
    executeStep: async (input) => {
      seen[input.step.id] = input.params;
      return inner.executeStep(input);
    },
    queryStepEffect: (input) => inner.queryStepEffect(input)
  };

  const result = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: tickingClock() });

  assert.equal(result.outcome, "succeeded");
  assert.equal(seen.merge.pr, "pr:42");
});

// ---------------------------------------------------------------------------
// Helpers for workflows the CLI cannot express yet (params land with the CLI)
// ---------------------------------------------------------------------------

function createWorkflowWithParam(store, task) {
  const workflow = createReleaseWorkflow("release-workflow-1", task.id, {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: [{ id: "publish", kind: "npm-publish", params: { version: "9.9.9" }, irreversibility: "irreversible" }]
  }, NOW);
  store.saveReleaseWorkflow(task.id, workflow);
  return workflow;
}

function createMergeWorkflowWithRef(store, task) {
  const workflow = createReleaseWorkflow("release-workflow-1", task.id, {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: [
      { id: "pr", kind: "pr-create-or-reuse" },
      { id: "merge", kind: "merge", params: { pr: "$externalId:pr" }, irreversibility: "irreversible" }
    ]
  }, NOW);
  store.saveReleaseWorkflow(task.id, workflow);
  return workflow;
}

// ---------------------------------------------------------------------------
// CLI run/resume/status envelope
// ---------------------------------------------------------------------------

test("CLI run drives the plan through runWorkflowCommandAsync and returns the envelope", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task);
  const ports = threeStepPorts();

  const result = await runWorkflowCommandAsync(
    ["run", task.id, workflow.id],
    store,
    { now: tickingClock(), ports }
  );

  assert.equal(result.kind, "output");
  assert.equal(result.data.outcome, "succeeded");
  assert.equal(result.data.status, "succeeded");
  assert.deepEqual(result.data.attempted, ["pr", "publish", "verify"]);
  assert.ok(result.output.includes("succeeded"));
  assert.equal(ports.calls("pr").execute, 1);
  assert.equal(ports.calls("publish").execute, 1);
  assert.equal(ports.calls("verify").execute, 1);
});

test("CLI resume continues from the first unconfirmed step", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task);
  const ports = threeStepPorts();
  const clock = tickingClock();

  const first = await runWorkflowCommandAsync(
    ["run", task.id, workflow.id, "--max-steps", "1"],
    store,
    { now: clock, ports }
  );
  assert.equal(first.kind, "output");
  assert.equal(first.data.outcome, "budget-exhausted");

  const second = await runWorkflowCommandAsync(
    ["resume", task.id, workflow.id],
    store,
    { now: clock, ports }
  );
  assert.equal(second.kind, "output");
  assert.equal(second.data.outcome, "succeeded");
  assert.deepEqual(second.data.attempted, ["publish", "verify"]);
  assert.equal(ports.calls("pr").execute, 1);
  assert.equal(ports.calls("publish").execute, 1);
  assert.equal(ports.calls("verify").execute, 1);
});

test("CLI run requires ports", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task);

  await assert.rejects(
    () => runWorkflowCommandAsync(["run", task.id, workflow.id], store, { now: () => NOW }),
    /requires ports/
  );
});

test("CLI run rejects a missing workflow", async (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  const ports = threeStepPorts();

  await assert.rejects(
    () => runWorkflowCommandAsync(
      ["run", task.id, "release-workflow-999"],
      store,
      { now: () => NOW, ports }
    ),
    /not found/
  );
});

test("CLI status renders each step and returns the workflow envelope", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task);

  const result = runTaskCommand(
    ["workflow", "status", task.id, workflow.id],
    store,
    { now: () => NOW }
  );
  assert.equal(result.kind, "output");
  assert.equal(result.data.id, workflow.id);
  assert.ok(result.output.includes("Workflow: release-workflow-1"));
  assert.ok(result.output.includes("[pending] pr (pr-create-or-reuse) attempts=0 ext=-"));
  assert.ok(result.output.includes("[pending] publish (npm-publish) attempts=0 ext=-"));
});

test("CLI status rejects a missing workflow", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  assert.throws(
    () => runTaskCommand(
      ["workflow", "status", task.id, "release-workflow-999"],
      store,
      { now: () => NOW }
    ),
    /not found/
  );
});

test("sync task workflow run refuses and points at the async entry", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  const workflow = setupWorkflow(store, task);
  assert.throws(
    () => runTaskCommand(
      ["workflow", "run", task.id, workflow.id],
      store,
      { now: () => NOW }
    ),
    /asynchronous/
  );
});

test("CLI create lands --step-param on the plan entry", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);

  const result = runTaskCommand([
    "workflow", "create", task.id,
    "--grant", "capability-grant-1",
    "--source-repo", "acme/widget",
    "--source-commit", "abc123def4567890000000000000000000000000",
    "--source-artifact", "widget-1.2.3.tgz@sha512-dGVzdC1pbnRlZ3JpdHk=",
    "--step", "publish:npm-publish",
    "--step-param", "publish:version=9.9.9"
  ], store, { now: () => NOW });

  assert.equal(result.kind, "output");
  assert.deepEqual(result.data.plan[0].params, { version: "9.9.9" });
});

test("CLI create rejects --step-param for an unknown step", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueFullGrant(store, task, operator);
  assert.throws(
    () => runTaskCommand([
      "workflow", "create", task.id,
      "--grant", "capability-grant-1",
      "--source-repo", "acme/widget",
      "--source-commit", "abc123def4567890000000000000000000000000",
      "--step", "publish:npm-publish",
      "--step-param", "ghost:version=9.9.9"
    ], store, { now: () => NOW }),
    /unknown step/
  );
});
