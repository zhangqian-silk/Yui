import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import {
  appendStepLog,
  completeStep,
  createReleaseWorkflow,
  failStep,
  markStepUnknown,
  resumeCursor,
  skipStep,
  startStep,
  validateReleaseWorkflow,
  workflowStatus
} from "../../dist/release/releaseWorkflow.js";
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

function planInput() {
  return [
    { id: "pr", kind: "pr-create-or-reuse" },
    { id: "publish", kind: "npm-publish", irreversibility: "irreversible" },
    { id: "verify", kind: "post-verify" }
  ];
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-release-workflow-"));
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
  const result = runTaskCommand(["create", "Release workflow test"], store, { now: () => NOW });
  return result.data.task;
}

function issueGrant(store, task, operator) {
  return runTaskCommand([
    "grant", "issue", task.id,
    "--action", "npm-publish"
  ], store, { now: () => NOW, environment: operator.environment });
}

function createWorkflow(store, task, overrides = {}) {
  const args = [
    "workflow", "create", task.id,
    "--grant", overrides.grantId ?? "capability-grant-1",
    "--source-repo", overrides.repo ?? "acme/widget",
    "--source-commit", overrides.commit ?? "abc123def4567890000000000000000000000000",
    "--step", "pr:pr-create-or-reuse",
    "--step", "publish:npm-publish",
    "--step", "verify:post-verify"
  ];
  if (overrides.artifact !== null) {
    args.push("--source-artifact", overrides.artifact ?? "widget-1.2.3.tgz@sha512-dGVzdC1pbnRlZ3JpdHk=");
  }
  if (overrides.irreversibility !== false) {
    args.push("--step-irreversibility", "publish=irreversible");
  }
  return runTaskCommand(args, store, { now: () => NOW });
}

// ---------------------------------------------------------------------------
// Domain unit tests
// ---------------------------------------------------------------------------

test("createReleaseWorkflow derives idempotency keys and pending steps", () => {
  const workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  assert.equal(workflow.id, "release-workflow-1");
  assert.equal(workflow.taskId, "task-1");
  assert.equal(workflow.grantId, "capability-grant-1");
  assert.equal(workflow.plan[0].idempotencyKey, "task-1/release-workflow-1/pr");
  assert.equal(workflow.plan[1].idempotencyKey, "task-1/release-workflow-1/publish");
  assert.equal(workflow.plan[2].idempotencyKey, "task-1/release-workflow-1/verify");
  for (const entry of workflow.plan) {
    const step = workflow.steps[entry.id];
    assert.equal(step.status, "pending");
    assert.equal(step.attempts, 0);
    assert.deepEqual(step.logs, []);
    assert.equal(step.planId, entry.id);
  }
  assert.equal(workflow.createdAt, NOW.toISOString());
  assert.equal(workflow.updatedAt, NOW.toISOString());
});

test("createReleaseWorkflow preserves plan declaration order", () => {
  const workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: [
      { id: "zeta", kind: "post-verify" },
      { id: "alpha", kind: "merge" },
      { id: "mid", kind: "ci-confirm" }
    ]
  }, NOW);
  assert.deepEqual(workflow.plan.map((entry) => entry.id), ["zeta", "alpha", "mid"]);
});

test("createReleaseWorkflow rejects duplicate step ids", () => {
  assert.throws(() => createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: [
      { id: "pr", kind: "merge" },
      { id: "pr", kind: "ci-confirm" }
    ]
  }, NOW), /unique/);
});

test("createReleaseWorkflow rejects an unknown kind", () => {
  assert.throws(() => createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: [{ id: "pr", kind: "not-a-kind" }]
  }, NOW), /invalid/);
});

test("createReleaseWorkflow rejects an empty plan", () => {
  assert.throws(() => createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: []
  }, NOW), /non-empty/);
});

test("createReleaseWorkflow rejects a missing grantId", () => {
  assert.throws(() => createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "",
    source: SOURCE,
    plan: planInput()
  }, NOW), /grantId/);
});

test("createReleaseWorkflow rejects a missing source commit", () => {
  assert.throws(() => createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: { repository: { owner: "acme", name: "widget" }, commit: "  " },
    plan: planInput()
  }, NOW), /commit/);
});

test("startStep moves pending to running and counts attempts", () => {
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  workflow = startStep(workflow, "pr", LATER);
  const step = workflow.steps.pr;
  assert.equal(step.status, "running");
  assert.equal(step.attempts, 1);
  assert.equal(step.lastAttemptAt, LATER.toISOString());
  assert.equal(workflow.updatedAt, LATER.toISOString());
});

test("startStep is illegal from running", () => {
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  workflow = startStep(workflow, "pr", NOW);
  assert.throws(() => startStep(workflow, "pr", LATER), /running/);
});

test("startStep retries a failed step", () => {
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  workflow = startStep(workflow, "pr", NOW);
  workflow = failStep(workflow, "pr", {}, LATER);
  workflow = startStep(workflow, "pr", LATER);
  assert.equal(workflow.steps.pr.status, "running");
  assert.equal(workflow.steps.pr.attempts, 2);
});

test("completeStep moves running to succeeded with terminalAt", () => {
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  workflow = startStep(workflow, "pr", NOW);
  workflow = completeStep(workflow, "pr", {
    externalId: "42",
    logs: ["opened PR 42"]
  }, LATER);
  const step = workflow.steps.pr;
  assert.equal(step.status, "succeeded");
  assert.equal(step.externalId, "42");
  assert.equal(step.terminalAt, LATER.toISOString());
  assert.deepEqual(step.logs, ["opened PR 42"]);
});

test("completeStep is illegal from pending", () => {
  const workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  assert.throws(() => completeStep(workflow, "pr", {}, LATER), /pending/);
});

test("failStep moves running to failed with terminalAt", () => {
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  workflow = startStep(workflow, "pr", NOW);
  workflow = failStep(workflow, "pr", { logs: ["boom"] }, LATER);
  const step = workflow.steps.pr;
  assert.equal(step.status, "failed");
  assert.equal(step.terminalAt, LATER.toISOString());
  assert.deepEqual(step.logs, ["boom"]);
});

test("failStep is illegal from pending", () => {
  const workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  assert.throws(() => failStep(workflow, "pr", {}, LATER), /pending/);
});

test("markStepUnknown moves running to unknown without terminalAt", () => {
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  workflow = startStep(workflow, "pr", NOW);
  workflow = markStepUnknown(workflow, "pr", {
    externalIdentity: { kind: "check-run", value: "42" }
  }, LATER);
  const step = workflow.steps.pr;
  assert.equal(step.status, "unknown");
  assert.equal(step.terminalAt, undefined);
  assert.deepEqual(step.externalIdentity, { kind: "check-run", value: "42" });
});

test("markStepUnknown allows a missing externalIdentity for crash recovery", () => {
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  workflow = startStep(workflow, "pr", NOW);
  // A running irreversible step that crashed before recording an identity
  // can be marked unknown without one; the engine fails closed (unconfirmed).
  const marked = markStepUnknown(workflow, "pr", {
    logs: ["crash recovery: no external identity"]
  }, LATER);
  assert.equal(marked.steps.pr.status, "unknown");
  assert.equal(marked.steps.pr.externalIdentity, undefined);
});

test("markStepUnknown is illegal from pending", () => {
  const workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  assert.throws(() => markStepUnknown(workflow, "pr", {
    externalIdentity: { kind: "check-run", value: "42" }
  }, LATER), /pending/);
});

test("skipStep moves pending to skipped with a reason log", () => {
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  workflow = skipStep(workflow, "verify", { reason: "not needed" }, LATER);
  const step = workflow.steps.verify;
  assert.equal(step.status, "skipped");
  assert.equal(step.terminalAt, LATER.toISOString());
  assert.equal(step.logs.length, 1);
  assert.ok(step.logs[0].includes("not needed"));
});

test("skipStep is illegal from running", () => {
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  workflow = startStep(workflow, "pr", NOW);
  assert.throws(() => skipStep(workflow, "pr", { reason: "x" }, LATER), /running/);
});

test("appendStepLog appends to a non-terminal step", () => {
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  workflow = appendStepLog(workflow, "pr", "waiting on CI");
  assert.deepEqual(workflow.steps.pr.logs, ["waiting on CI"]);
});

test("appendStepLog rejects a terminal step", () => {
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  workflow = startStep(workflow, "pr", NOW);
  workflow = completeStep(workflow, "pr", {}, LATER);
  assert.throws(() => appendStepLog(workflow, "pr", "late"), /terminal/);
});

test("resumeCursor walks the plan matrix", () => {
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  assert.equal(resumeCursor(workflow), "pr");

  workflow = startStep(workflow, "pr", NOW);
  workflow = completeStep(workflow, "pr", {}, NOW);
  assert.equal(resumeCursor(workflow), "publish");

  workflow = startStep(workflow, "publish", NOW);
  workflow = failStep(workflow, "publish", {}, NOW);
  assert.equal(resumeCursor(workflow), "publish");

  workflow = startStep(workflow, "publish", NOW);
  workflow = completeStep(workflow, "publish", {}, NOW);
  workflow = skipStep(workflow, "verify", { reason: "not needed" }, NOW);
  assert.equal(resumeCursor(workflow), null);
});

test("resumeCursor stops at an unknown step", () => {
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  workflow = startStep(workflow, "pr", NOW);
  workflow = completeStep(workflow, "pr", {}, NOW);
  workflow = startStep(workflow, "publish", NOW);
  workflow = markStepUnknown(workflow, "publish", {
    externalIdentity: { kind: "check-run", value: "42" }
  }, NOW);
  assert.equal(resumeCursor(workflow), "publish");
});

test("workflowStatus derives each branch", () => {
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  assert.equal(workflowStatus(workflow), "pending");

  workflow = startStep(workflow, "pr", NOW);
  assert.equal(workflowStatus(workflow), "running");

  workflow = failStep(workflow, "pr", {}, NOW);
  assert.equal(workflowStatus(workflow), "failed");

  let unknown = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  unknown = startStep(unknown, "pr", NOW);
  unknown = markStepUnknown(unknown, "pr", {
    externalIdentity: { kind: "check-run", value: "42" }
  }, NOW);
  assert.equal(workflowStatus(unknown), "unknown");

  let succeeded = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  for (const entry of succeeded.plan) {
    succeeded = startStep(succeeded, entry.id, NOW);
    succeeded = completeStep(succeeded, entry.id, {}, NOW);
  }
  assert.equal(workflowStatus(succeeded), "succeeded");
});

test("validateReleaseWorkflow allows an unknown step without externalIdentity", () => {
  const workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  // An unknown step without an identity is a crash-recovery state; the engine
  // fails closed (unconfirmed) rather than rejecting the workflow record.
  const broken = {
    ...workflow,
    steps: {
      ...workflow.steps,
      pr: { ...workflow.steps.pr, status: "unknown" }
    }
  };
  assert.doesNotThrow(() => validateReleaseWorkflow(broken));
});

test("validateReleaseWorkflow rejects plan/steps key mismatch", () => {
  const workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: SOURCE,
    plan: planInput()
  }, NOW);
  const missing = {
    ...workflow,
    steps: { pr: workflow.steps.pr, publish: workflow.steps.publish }
  };
  assert.throws(() => validateReleaseWorkflow(missing), /missing/);
});

// ---------------------------------------------------------------------------
// Storage round-trip tests
// ---------------------------------------------------------------------------

test("release workflow storage round-trip survives reopen", (t) => {
  const { root, store, operator } = fixture(t);
  const task = createTask(store);
  issueGrant(store, task, operator);

  const first = createWorkflow(store, task);
  assert.equal(first.data.id, "release-workflow-1");
  const second = createWorkflow(store, task, {
    repo: "acme/gadget",
    commit: "9876543210fedcba000000000000000000000000",
    artifact: "widget-1.0.0.tgz@sha512-deadbeef"
  });
  assert.equal(second.data.id, "release-workflow-2");

  const reopened = new FileTaskStore(root);
  assert.deepEqual(reopened.getReleaseWorkflow(task.id, "release-workflow-1"), first.data);
  assert.deepEqual(reopened.getReleaseWorkflow(task.id, "release-workflow-2"), second.data);
  assert.equal(reopened.listReleaseWorkflows(task.id).length, 2);
});

test("release workflow save rejects an older updatedAt", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueGrant(store, task, operator);

  const created = createWorkflow(store, task);
  const advanced = startStep(created.data, "pr", LATER);
  store.saveReleaseWorkflow(task.id, advanced);

  assert.throws(
    () => store.saveReleaseWorkflow(task.id, created.data),
    /overwritten/
  );
});

// ---------------------------------------------------------------------------
// CLI envelope tests
// ---------------------------------------------------------------------------

test("release workflow CLI create show list", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueGrant(store, task, operator);

  const created = createWorkflow(store, task);
  assert.equal(created.kind, "output");
  assert.equal(created.data.id, "release-workflow-1");
  assert.equal(created.data.plan.length, 3);
  assert.equal(created.data.grantId, "capability-grant-1");
  assert.equal(created.data.source.repository.owner, "acme");
  assert.equal(created.data.source.repository.name, "widget");
  assert.equal(created.data.source.commit, "abc123def4567890000000000000000000000000");
  for (const entry of created.data.plan) {
    assert.equal(created.data.steps[entry.id].status, "pending");
  }
  assert.ok(created.output.includes("Created release workflow release-workflow-1 with 3 steps."));

  const shown = runTaskCommand(
    ["workflow", "show", task.id, "release-workflow-1"],
    store,
    { now: () => NOW }
  );
  assert.equal(shown.kind, "output");
  assert.equal(shown.data.id, "release-workflow-1");
  assert.ok(shown.output.includes("Workflow: release-workflow-1"));
  assert.ok(shown.output.includes("Grant: capability-grant-1"));
  assert.ok(shown.output.includes("acme/widget@abc123d"));
  assert.ok(shown.output.includes("[pending] pr (pr-create-or-reuse) attempts=0 ext=-"));

  const listed = runTaskCommand(["workflow", "list", task.id], store, { now: () => NOW });
  assert.equal(listed.kind, "output");
  assert.ok(Array.isArray(listed.data));
  assert.equal(listed.data.length, 1);
  assert.deepEqual(shown.data, listed.data[0]);
});

test("release workflow create rejects an unknown grant", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  assert.throws(
    () => createWorkflow(store, task, { grantId: "capability-grant-999" }),
    /not found/
  );
});

test("release workflow create rejects an unknown step kind", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueGrant(store, task, operator);
  assert.throws(
    () => runTaskCommand([
      "workflow", "create", task.id,
      "--grant", "capability-grant-1",
      "--source-repo", "acme/widget",
      "--source-commit", "abc123def4567890000000000000000000000000",
      "--step", "pr:not-a-kind"
    ], store, { now: () => NOW }),
    /invalid/
  );
});

test("release workflow create rejects an npm-publish plan without a source artifact", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueGrant(store, task, operator);
  // The workflow source is immutable, so a plan that needs an artifact must
  // bring one at creation time rather than discovering the gap mid-release.
  assert.throws(
    () => createWorkflow(store, task, { artifact: null }),
    /npm-publish step requires a source artifact/
  );
  assert.deepEqual(
    runTaskCommand(["workflow", "list", task.id], store, { now: () => NOW }).data,
    [],
    "the rejected workflow is not persisted"
  );
});

test("release workflow list empty state", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  const result = runTaskCommand(["workflow", "list", task.id], store, { now: () => NOW });
  assert.equal(result.kind, "output");
  assert.ok(result.output.includes("No release workflows found."));
  assert.ok(Array.isArray(result.data));
  assert.equal(result.data.length, 0);
});

test("release workflow show rejects a missing workflow", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  assert.throws(
    () => runTaskCommand(
      ["workflow", "show", task.id, "release-workflow-999"],
      store,
      { now: () => NOW }
    ),
    /not found/
  );
});

// ---------------------------------------------------------------------------
// Audit event tests
// ---------------------------------------------------------------------------

test("release workflow create emits an audit event", (t) => {
  const { store, operator } = fixture(t);
  const task = createTask(store);
  issueGrant(store, task, operator);
  createWorkflow(store, task);

  const events = store.listEvents(task.id);
  const created = events.find((e) => e.type === "release-workflow.created");
  assert.ok(created, "release-workflow.created event should exist");
  assert.equal(created.payload.workflowId, "release-workflow-1");
  assert.equal(created.payload.grantId, "capability-grant-1");
  assert.equal(created.payload.commit, "abc123def4567890000000000000000000000000");
  assert.equal(created.payload.steps, "pr,publish,verify");
});
