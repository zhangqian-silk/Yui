import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

// Reviewer-only red tests for review-round-3. These tests exercise the frozen
// Task head through deterministic stores and command runners; they never call
// GitHub, npm, a Controller, or another real external resource.

import { createConfiguredAgent } from "../dist/agent/agent.js";
import { runTaskCommand } from "../dist/commands/taskCommands.js";
import { createCapabilityGrant } from "../dist/grant/capabilityGrant.js";
import { runWorkflowCommandAsync } from "../dist/commands/workflowCommands.js";
import { createReleaseWorkflow, startStep, recoverRunningStep } from "../dist/release/releaseWorkflow.js";
import { runReleaseWorkflow } from "../dist/release/releaseWorkflowEngine.js";
import { createReleaseWorkflowPorts, createPinnedRunner, resolveExecutable } from "../dist/release/releaseWorkflowPorts.js";
import { activatedControllerEntrypoint } from "../dist/cli/updatePorts.js";
import { createInMemoryReleaseIdempotencyStore } from "../dist/release/releaseIdempotencyStore.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { installOperatorSession } from "./helpers/operatorSession.js";

const NOW = new Date("2026-08-14T00:00:00.000Z");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SOURCE = Object.freeze({
  repository: { owner: "acme", name: "widget" },
  commit: COMMIT,
  artifact: { name: "widget-1.2.3.tgz", integrity: "sha512-dGVzdC1pbnRlZ3JpdHk=" }
});

function engineFixture({ grant: grantInput, source = SOURCE, plan }) {
  let grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: plan.map((step) => step.kind),
    irreversibilityCeiling: "irreversible",
    ...grantInput
  }, NOW);
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: grant.id,
    source,
    plan
  }, NOW);
  const store = {
    getReleaseWorkflow: () => workflow,
    saveReleaseWorkflow: (_taskId, next) => { workflow = next; },
    getCapabilityGrant: () => grant,
    saveCapabilityGrant: (_taskId, next) => { grant = next; }
  };
  return { store, get workflow() { return workflow; } };
}

function realPorts(runCommand, extra = {}) {
  return createReleaseWorkflowPorts({
    home: "/isolated/exact-home",
    updatePorts: {},
    projectStore: {},
    runCommand,
    // In-memory store: the fake /isolated/exact-home must never accumulate
    // durable state across test processes.
    idempotencyStore: createInMemoryReleaseIdempotencyStore(),
    ...extra
  });
}

/**
 * Write the durable pre-effect npm-publish target record the adapter writes
 * before `npm publish` (P1, rr24). Tests that exercise the npm-package
 * recovery query need this record: without it the query fails closed.
 */
function writeNpmPublishTarget(home, idempotencyKey, npmPath, registry) {
  const target = join(home, "release", "npm-publish-target", `${idempotencyKey}.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ npmPath, registry }));
}

test("round3 diagnostic: a managed Agent cannot self-issue an irreversible grant", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-review-grant-authority-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(agent);
  });
  const task = runTaskCommand(["create", "authority boundary"], store, {
    now: () => NOW
  }).data.task;

  assert.throws(() => runTaskCommand([
    "grant", "issue", task.id,
    "--action", "npm-publish",
    "--irreversibility-ceiling", "irreversible"
  ], store, {
    now: () => NOW,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "reviewer",
      YUI_RUN_ID: "agent-run-review"
    }
  }), /operator|user authorization|managed agent/i);
  assert.equal(store.listCapabilityGrants(task.id).length, 0);
});

test("round3 diagnostic: the catalog prevents downgrading npm-publish to irreversibility none", async () => {
  const fx = engineFixture({
    grant: { irreversibilityCeiling: "none" },
    plan: [{ id: "publish", kind: "npm-publish" }]
  });
  let calls = 0;
  const result = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", {
    executeStep: async () => { calls += 1; return { outcome: "succeeded" }; },
    queryStepEffect: async () => ({ state: "unknown" })
  }, { now: () => NOW });

  assert.equal(result.outcome, "unauthorized");
  assert.equal(calls, 0);
});

test("round3 diagnostic: a package-scoped grant cannot publish another package", async () => {
  const fx = engineFixture({
    grant: { scope: { packages: ["@acme/allowed"] } },
    plan: [{
      id: "publish",
      kind: "npm-publish",
      params: { package: "@other/forbidden", version: "1.2.3", tarball: "/tmp/forbidden.tgz" },
      irreversibility: "irreversible"
    }]
  });
  let calls = 0;
  const result = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", {
    executeStep: async () => { calls += 1; return { outcome: "succeeded" }; },
    queryStepEffect: async () => ({ state: "unknown" })
  }, { now: () => NOW });

  assert.equal(result.outcome, "unauthorized");
  assert.equal(calls, 0);
});

test("round3 diagnostic: concurrent starts submit one external effect", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-review-concurrent-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const setupStore = new FileTaskStore(root);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  setupStore.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(agent);
  });
  const task = runTaskCommand(["create", "concurrent workflow"], setupStore, {
    now: () => NOW
  }).data.task;
  const operator = installOperatorSession(setupStore, agent, NOW);
  runTaskCommand([
    "grant", "issue", task.id,
    "--action", "npm-publish",
    "--irreversibility-ceiling", "irreversible"
  ], setupStore, { now: () => NOW, environment: operator.environment });
  const workflow = runTaskCommand([
    "workflow", "create", task.id,
    "--grant", "capability-grant-1",
    "--source-repo", "acme/widget",
    "--source-commit", COMMIT,
    "--source-artifact", "widget-1.2.3.tgz@sha512-dGVzdC1pbnRlZ3JpdHk=",
    "--step", "publish:npm-publish",
    "--step-irreversibility", "publish=irreversible"
  ], setupStore, { now: () => NOW }).data;
  const storeA = new FileTaskStore(root);
  const storeB = new FileTaskStore(root);
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ports = {
    executeStep: async () => {
      calls += 1;
      await gate;
      return { outcome: "succeeded" };
    },
    queryStepEffect: async () => ({ state: "unknown" })
  };

  const first = runReleaseWorkflow(storeA, task.id, workflow.id, ports, { now: () => NOW });
  await new Promise((resolve) => setImmediate(resolve));
  const second = runReleaseWorkflow(storeB, task.id, workflow.id, ports, { now: () => NOW });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.allSettled([first, second]);

  assert.equal(calls, 1);
});

test("round3 diagnostic: a crash after an external effect does not submit it again", async () => {
  const fx = engineFixture({
    plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
  });
  let calls = 0;
  const ports = {
    executeStep: async () => {
      calls += 1;
      if (calls === 1) throw new Error("process disappeared after registry accepted the upload");
      return { outcome: "succeeded" };
    },
    queryStepEffect: async () => ({ state: "unknown" })
  };

  await assert.rejects(
    runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", ports, { now: () => NOW }),
    /registry accepted/
  );
  await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", ports, { now: () => NOW });
  assert.equal(calls, 1);
});

test("round3 diagnostic: a crash after consuming the grant does not strand the workflow", async () => {
  const fx = engineFixture({
    grant: { maxUses: 1 },
    plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
  });
  let crash = true;
  const crashStore = {
    ...fx.store,
    saveCapabilityGrant: (taskId, next) => {
      fx.store.saveCapabilityGrant(taskId, next);
      if (crash) {
        crash = false;
        throw new Error("process exited after grant use commit");
      }
    }
  };
  let calls = 0;
  let queries = 0;
  // The crash happened before the external submission, so the effect is
  // authoritatively absent. The recognized use makes the single re-attempt
  // free even though the grant is exhausted; a port that cannot establish
  // the disposition answers "unknown" and the workflow stops unconfirmed
  // instead (see the round9 P1 diagnostics).
  const ports = {
    executeStep: async () => { calls += 1; return { outcome: "succeeded" }; },
    queryStepEffect: async () => { queries += 1; return { state: "absent" }; }
  };

  await assert.rejects(
    runReleaseWorkflow(crashStore, "task-1", "release-workflow-1", ports, { now: () => NOW }),
    /grant use commit/
  );
  const resumed = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", ports, {
    now: () => NOW
  });
  assert.equal(resumed.outcome, "succeeded");
  assert.equal(calls, 1);
  assert.equal(queries, 1, "the authoritative query precedes the free re-attempt");
});

test("round3 diagnostic: an unknowable failed publish is not re-submitted", async () => {
  const fx = engineFixture({
    plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
  });
  let calls = 0;
  const first = {
    executeStep: async () => ({
      outcome: "failed",
      externalIdentity: { kind: "npm-package", value: "@acme/widget" },
      error: "network timed out after upload"
    }),
    queryStepEffect: async () => ({ state: "unknown" })
  };
  await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", first, { now: () => NOW });

  const result = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", {
    executeStep: async () => { calls += 1; return { outcome: "succeeded" }; },
    queryStepEffect: async () => ({ state: "unknown" })
  }, { now: () => NOW });
  assert.equal(result.outcome, "unknown");
  assert.equal(calls, 0);
});

test("round3 diagnostic: CI confirmation queries the frozen source commit with workflow and branch binding", async () => {
  const calls = [];
  const ports = realPorts(async (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    return { code: 0, stdout: JSON.stringify({ conclusion: "success", status: "completed" }) + "\n", stderr: "" };
  });
  await ports.executeStep({
    step: { id: "ci", kind: "ci-confirm", idempotencyKey: "task-1/release-workflow-1/ci" },
    idempotencyKey: "task-1/release-workflow-1/ci",
    source: SOURCE,
    params: { workflow: "ci.yml", branch: "master" }
  });

  // The query must bind to the exact commit, workflow, and branch so an
  // unrelated successful workflow on the same SHA cannot satisfy the gate.
  const ciArgs = calls[0].args;
  assert.ok(ciArgs.includes("--commit"), "missing --commit filter");
  assert.ok(ciArgs.includes(COMMIT), "missing frozen commit");
  assert.ok(ciArgs.includes("--workflow"), "missing --workflow filter");
  assert.ok(ciArgs.includes("ci.yml"), "missing workflow binding");
  assert.ok(ciArgs.includes("--branch"), "missing --branch filter");
  assert.ok(ciArgs.includes("master"), "missing branch binding");
});

test("round3 diagnostic: CI confirmation refuses without workflow and branch binding", async () => {
  const calls = [];
  const ports = realPorts(async (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    return { code: 0, stdout: "success\n", stderr: "" };
  });
  const result = await ports.executeStep({
    step: { id: "ci", kind: "ci-confirm", idempotencyKey: "task-1/release-workflow-1/ci" },
    idempotencyKey: "task-1/release-workflow-1/ci",
    source: SOURCE,
    params: {}
  });
  assert.equal(result.outcome, "failed");
  assert.ok(result.error.includes("workflow"), "should refuse without workflow param");
  assert.equal(calls.length, 0, "should not invoke gh without workflow binding");
});

test("round3 diagnostic: PR creation does not treat a commit SHA as a head branch", async () => {
  const calls = [];
  const ports = realPorts(async (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    if (args[1] === "view" || args[1] === "list") {
      return { code: 0, stdout: "", stderr: "" };
    }
    // P2-2: the pre-create remote-head resolution must confirm the derived
    // branch points at the frozen commit before a create is allowed.
    if (args[0] === "api" && args[1]?.startsWith("repos/")) {
      return { code: 0, stdout: `${COMMIT}\n`, stderr: "" };
    }
    return { code: 0, stdout: "https://github.com/acme/widget/pull/42\n", stderr: "" };
  });
  await ports.executeStep({
    step: { id: "pr", kind: "pr-create-or-reuse", idempotencyKey: "task-1/release-workflow-1/pr" },
    idempotencyKey: "task-1/release-workflow-1/pr",
    source: SOURCE,
    params: {}
  });

  const create = calls.find((call) => call.args[0] === "pr" && call.args[1] === "create");
  assert.notEqual(create, undefined);
  const headIndex = create.args.indexOf("--head");
  assert.notEqual(headIndex, -1);
  assert.notEqual(create.args[headIndex + 1], COMMIT);
});

test("round3 diagnostic: a failed PR lookup does not authorize a create", async () => {
  const calls = [];
  const ports = realPorts(async (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    if (args[1] === "view" || args[1] === "list") {
      return { code: 1, stdout: "", stderr: "network unavailable" };
    }
    return { code: 0, stdout: "https://github.com/acme/widget/pull/42\n", stderr: "" };
  });
  const effect = await ports.executeStep({
    step: { id: "pr", kind: "pr-create-or-reuse", idempotencyKey: "task-1/release-workflow-1/pr" },
    idempotencyKey: "task-1/release-workflow-1/pr",
    source: SOURCE,
    params: { head: "release-branch" }
  });

  assert.equal(effect.outcome, "failed");
  assert.equal(calls.some((call) => call.args[0] === "pr" && call.args[1] === "create"), false);
});

test("round3 diagnostic: merge strips the PR display prefix and fences the frozen head commit", async () => {
  const calls = [];
  const ports = realPorts(async (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    return { code: 0, stdout: "", stderr: "" };
  });
  await ports.executeStep({
    step: { id: "merge", kind: "merge", idempotencyKey: "task-1/release-workflow-1/merge" },
    idempotencyKey: "task-1/release-workflow-1/merge",
    source: SOURCE,
    params: { pr: "pr:42" }
  });

  assert.equal(calls[0].args[2], "42");
  assert.ok(calls[0].args.includes("--match-head-commit"));
  assert.equal(calls[0].args[calls[0].args.indexOf("--match-head-commit") + 1], COMMIT);
});

test("round3 diagnostic: npm recovery proves the exact package version, not any latest version", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-rr24-exact-version-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeNpmPublishTarget(home, "task-1/release-workflow-1/publish", "/usr/local/bin/npm", "https://registry.example.com/");
  const calls = [];
  const ports = realPorts(async (command, args) => {
    calls.push({ command, args: [...args] });
    return { code: 0, stdout: "9.9.9\n", stderr: "" };
  }, { home });
  const query = await ports.queryStepEffect({
    step: {
      id: "publish",
      kind: "npm-publish",
      idempotencyKey: "task-1/release-workflow-1/publish",
      params: { package: "@acme/widget", version: "1.2.3" },
      irreversibility: "irreversible"
    },
    externalIdentity: { kind: "npm-package", value: "@acme/widget" }
  });

  assert.notEqual(query.state, "exists");
  // The query must pin the exact frozen version, not the moving latest.
  const viewCall = calls.find((c) => c.args[0] === "view");
  assert.ok(viewCall !== undefined, "expected an npm view call");
  assert.ok(viewCall.args.includes("@acme/widget@1.2.3"),
    "the view must query the exact frozen version, not latest");
  assert.equal(viewCall.command, "/usr/local/bin/npm",
    "the view must use the persisted npm executable");
  assert.ok(viewCall.args.includes("--registry"),
    "the view must pin the persisted registry");
});

test("round3 diagnostic: a missing npm version is not treated as an absent effect", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-rr24-missing-version-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeNpmPublishTarget(home, "task-1/release-workflow-1/publish", "/usr/local/bin/npm", "https://registry.example.com/");
  const ports = realPorts(async (command, args) => {
    if (args[0] === "view") {
      return {
        code: 1,
        stdout: "",
        stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found"
      };
    }
    return { code: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
  }, { home });
  const query = await ports.queryStepEffect({
    step: {
      id: "publish",
      kind: "npm-publish",
      idempotencyKey: "task-1/release-workflow-1/publish",
      params: { package: "@acme/widget", version: "1.2.3" },
      irreversibility: "irreversible"
    },
    externalIdentity: { kind: "npm-package", value: "@acme/widget@1.2.3" }
  });

  assert.equal(query.state, "absent");
});

test("round3 diagnostic: tag recovery rejects a tag that points at another commit", async () => {
  const calls = [];
  const ports = realPorts(async (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    return {
      code: 0,
      stdout: "ffffffffffffffffffffffffffffffffffffffff\trefs/tags/v1.2.3\n",
      stderr: ""
    };
  });
  const query = await ports.queryStepEffect({
    step: {
      id: "tag",
      kind: "version-tag",
      idempotencyKey: "task-1/release-workflow-1/tag",
      params: { tag: "v1.2.3", repositoryPath: "/projects/acme-widget" },
      irreversibility: "irreversible"
    },
    source: SOURCE,
    externalIdentity: { kind: "git-tag", value: "v1.2.3" }
  });

  assert.notEqual(query.state, "exists");
});

test("round3 diagnostic: npm publish refuses a tarball that is not the frozen artifact", async () => {
  let calls = 0;
  const ports = realPorts(async () => {
    calls += 1;
    return { code: 0, stdout: "+ @acme/widget@1.2.3\n", stderr: "" };
  });
  const effect = await ports.executeStep({
    step: {
      id: "publish",
      kind: "npm-publish",
      idempotencyKey: "task-1/release-workflow-1/publish",
      irreversibility: "irreversible"
    },
    idempotencyKey: "task-1/release-workflow-1/publish",
    source: {
      ...SOURCE,
      artifact: { name: "widget-1.2.3.tgz", integrity: "sha512-frozen" }
    },
    params: { package: "@acme/widget", version: "1.2.3", tarball: "/tmp/other.tgz" }
  });

  assert.equal(effect.outcome, "failed");
  assert.equal(calls, 0);
});

test("round3 diagnostic: doctor alone cannot confirm an exact CLI update", async () => {
  const ports = realPorts(async () => ({ code: 0, stdout: "{\"ok\":true}\n", stderr: "" }));
  const query = await ports.queryStepEffect({
    step: {
      id: "update",
      kind: "cli-update",
      idempotencyKey: "task-1/release-workflow-1/update",
      params: { version: "1.2.3" },
      irreversibility: "irreversible"
    },
    externalIdentity: { kind: "controller-home", value: "/isolated/exact-home" }
  });

  assert.equal(query.state, "unknown");
});

test("round3 diagnostic: a grant rebind is preserved in the immutable run audit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-review-grant-rebind-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(agent);
  });
  const task = runTaskCommand(["create", "grant rebind audit"], store, {
    now: () => NOW
  }).data.task;
  const operator = installOperatorSession(store, agent, NOW);
  for (const _granter of ["alice", "bob"]) {
    runTaskCommand([
      "grant", "issue", task.id,
      "--action", "post-verify"
    ], store, { now: () => NOW, environment: operator.environment });
  }
  const workflow = runTaskCommand([
    "workflow", "create", task.id,
    "--grant", "capability-grant-1",
    "--source-repo", "acme/widget",
    "--source-commit", COMMIT,
    "--step", "verify:post-verify"
  ], store, { now: () => NOW }).data;

  await runWorkflowCommandAsync([
    "run", task.id, workflow.id, "--grant", "capability-grant-2"
  ], store, {
    now: () => NOW,
    ports: {
      executeStep: async () => ({ outcome: "succeeded" }),
      queryStepEffect: async () => ({ state: "unknown" })
    }
  });

  const runEvent = store.listEvents(task.id)
    .findLast((event) => event.type === "release-workflow.run");
  assert.notEqual(runEvent, undefined);
  assert.equal(runEvent.payload.grantId, "capability-grant-2");
});

// --- rr19/rr20 regression tests ---

test("rr19 regression: startStep clears attempt-scoped evidence to prevent maxUses bypass", () => {
  const fx = engineFixture({
    plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
  });
  // Simulate a previous attempt that recorded externalIdentity/externalId/terminalAt
  const withEvidence = {
    ...fx.workflow,
    steps: {
      ...fx.workflow.steps,
      publish: {
        ...fx.workflow.steps.publish,
        status: "failed",
        externalId: "old-id",
        externalIdentity: { kind: "npm-package", value: "@acme/widget" },
        terminalAt: NOW.toISOString(),
        attempts: 1
      }
    }
  };
  const started = startStep(withEvidence, "publish", NOW);
  const step = started.steps.publish;
  assert.equal(step.status, "running");
  assert.equal(step.externalId, undefined, "externalId must be cleared on new attempt");
  assert.equal(step.externalIdentity, undefined, "externalIdentity must be cleared on new attempt");
  assert.equal(step.terminalAt, undefined, "terminalAt must be cleared on new attempt");
  assert.equal(step.attempts, 2, "attempts must increment");
});

test("rr19 regression: recoverRunningStep clears attempt-scoped evidence", () => {
  const fx = engineFixture({
    plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
  });
  // Simulate a running step that recorded evidence from a previous attempt
  const withEvidence = {
    ...fx.workflow,
    steps: {
      ...fx.workflow.steps,
      publish: {
        ...fx.workflow.steps.publish,
        status: "running",
        externalId: "old-id",
        externalIdentity: { kind: "npm-package", value: "@acme/widget" },
        terminalAt: NOW.toISOString(),
        attempts: 1,
        lastAttemptAt: NOW.toISOString()
      }
    }
  };
  const recovered = recoverRunningStep(withEvidence, "publish", NOW);
  const step = recovered.steps.publish;
  assert.equal(step.status, "running");
  assert.equal(step.externalId, undefined, "externalId must be cleared on recovery");
  assert.equal(step.externalIdentity, undefined, "externalIdentity must be cleared on recovery");
  assert.equal(step.terminalAt, undefined, "terminalAt must be cleared on recovery");
  assert.equal(step.attempts, 2, "attempts must increment");
});

test("rr19 regression: hard-exit version-tag derives identity from frozen plan and enters authoritative query", async () => {
  const calls = [];
  const ports = realPorts(async (command, args) => {
    calls.push({ command, args: [...args] });
    // The git-tag query first verifies remote URLs, then runs ls-remote
    if (args[0] === "remote" && args[1] === "get-url") {
      return { code: 0, stdout: "https://github.com/acme/widget.git\n", stderr: "" };
    }
    // git ls-remote returns the tag pointing at the frozen commit
    return { code: 0, stdout: `${COMMIT}\trefs/tags/v1.2.3\n`, stderr: "" };
  });
  // No externalIdentity: simulates a hard exit between the external effect
  // and the idempotency/identity persistence.
  const query = await ports.queryStepEffect({
    step: {
      id: "tag",
      kind: "version-tag",
      idempotencyKey: "task-1/release-workflow-1/tag",
      params: { tag: "v1.2.3", repositoryPath: "/projects/acme-widget" },
      irreversibility: "irreversible"
    },
    source: SOURCE
    // no externalIdentity — the adapter must derive it from the frozen plan
  });

  // The query must have been made (not returned "unknown" immediately),
  // proving the identity was derived from the frozen plan.
  const lsRemoteCall = calls.find((c) => c.args[0] === "ls-remote");
  assert.notEqual(lsRemoteCall, undefined, "expected git ls-remote query");
  assert.ok(lsRemoteCall.args.some((a) => a.includes("v1.2.3")), "expected the derived tag in the query");
  // The tag points at the frozen commit, so the effect is confirmed exists.
  assert.equal(query.state, "exists");
});

test("rr19 regression: fresh-install-smoke uses isolated prefix+cache and fails on version mismatch", async () => {
  const calls = [];
  const ports = realPorts(async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "npm") {
      // npm install succeeds
      return { code: 0, stdout: "", stderr: "" };
    }
    // The installed binary returns a WRONG version
    return { code: 0, stdout: "9.9.9\n", stderr: "" };
  });
  const effect = await ports.executeStep({
    step: {
      id: "smoke",
      kind: "fresh-install-smoke",
      idempotencyKey: "task-1/release-workflow-1/smoke"
    },
    idempotencyKey: "task-1/release-workflow-1/smoke",
    source: SOURCE,
    params: { version: "1.2.3" }
  });

  // Must fail because the installed version doesn't match the pinned version
  assert.equal(effect.outcome, "failed");
  assert.ok(effect.error.includes("does not match pinned"), "should reject version mismatch");

  // Verify the npm install used an isolated prefix and cache
  const installCall = calls.find((c) => c.command === "npm");
  assert.notEqual(installCall, undefined, "expected npm install call");
  assert.ok(installCall.args.includes("--prefix"), "npm install must use --prefix (isolated)");
  assert.ok(installCall.args.includes("--cache"), "npm install must use --cache (isolated)");
  assert.ok(installCall.args.includes("--no-audit"), "npm install must use --no-audit");
  assert.ok(installCall.args.includes("--no-fund"), "npm install must use --no-fund");

  // Verify the binary was run from node_modules/.bin (not PATH)
  const binCall = calls.find((c) => c.command !== "npm");
  assert.notEqual(binCall, undefined, "expected binary execution call");
  assert.ok(binCall.command.includes("node_modules") && binCall.command.includes(".bin"),
    "binary must be run from the isolated node_modules/.bin, not PATH");
});

test("rr20 P1-1 regression: grant expiry during recovery query is re-checked before external call", async () => {
  const fx = engineFixture({
    grant: { expiresAt: "2026-08-14T00:00:01.000Z" },
    plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
  });
  // Set the step to unknown with an externalIdentity (simulating a previous timeout)
  const withUnknown = {
    ...fx.workflow,
    steps: {
      ...fx.workflow.steps,
      publish: {
        ...fx.workflow.steps.publish,
        status: "unknown",
        externalIdentity: { kind: "npm-package", value: "@acme/widget" },
        attempts: 1
      }
    }
  };
  fx.store.saveReleaseWorkflow("task-1", withUnknown);

  // The clock starts before expiry, advances past it during the async query
  let currentTime = new Date("2026-08-14T00:00:00.000Z");
  let executeCalls = 0;
  const ports = {
    executeStep: async () => { executeCalls += 1; return { outcome: "succeeded" }; },
    queryStepEffect: async () => {
      // Advance the clock past the grant expiry during the async query
      currentTime = new Date("2026-08-14T00:00:02.000Z");
      return { state: "absent" };
    }
  };

  const result = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", ports, {
    now: () => currentTime
  });

  // The grant expired during the query; the re-sampled clock must deny it
  assert.equal(result.outcome, "unauthorized");
  assert.ok(result.stopReason.includes("grant-expired"),
    `expected grant-expired, got ${result.stopReason}`);
  assert.equal(executeCalls, 0, "external call must not be made after grant expiry");
});

test("rr20 P1-3 regression: controller-home query resolves the global install target, not the checkout module", async () => {
  const calls = [];
  const ports = realPorts(async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "npm" && args[0] === "prefix" && args[1] === "--global") {
      return { code: 0, stdout: "/usr/local\n", stderr: "" };
    }
    // rr22 P1-1: the recovery query also verifies the Controller lifecycle.
    if (args.includes("controller") && args.includes("status")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            resources: [{
              kind: "controller",
              state: "current",
              yuiHome: "/isolated/exact-home",
              processes: [{ pid: 4242 }]
            }]
          }
        }) + "\n",
        stderr: ""
      };
    }
    if (args.includes("controller") && args.includes("identity")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            executablePath: process.execPath,
            args: [activatedControllerEntrypoint("/usr/local/bin/yui")],
            version: "1.2.3"
          }
        }) + "\n",
        stderr: ""
      };
    }
    // The global binary returns the expected version
    return { code: 0, stdout: "1.2.3\n", stderr: "" };
  });
  const query = await ports.queryStepEffect({
    step: {
      id: "update",
      kind: "cli-update",
      idempotencyKey: "task-1/release-workflow-1/update",
      params: { version: "1.2.3" },
      irreversibility: "irreversible"
    },
    externalIdentity: { kind: "controller-home", value: "/isolated/exact-home" }
  });

  // Must resolve the global binary via npm prefix --global
  const prefixCall = calls.find((c) => c.command === "npm" && c.args[0] === "prefix");
  assert.notEqual(prefixCall, undefined, "expected npm prefix --global call");
  assert.ok(prefixCall.args.includes("--global"), "must resolve the global prefix");

  // The doctor/version commands must use the global binary path (not the
  // checkout module). The adapter invokes via process.execPath, so check args.
  const doctorCall = calls.find((c) => c.args.some((a) => typeof a === "string" && a.includes("doctor")));
  assert.notEqual(doctorCall, undefined, "expected doctor call");
  assert.ok(doctorCall.args.some((a) => typeof a === "string" && a.includes("/usr/local/bin/yui")),
    "doctor must run the global binary, not the checkout module");

  assert.equal(query.state, "exists");
});

test("rr23 P1-2 regression: a hard-exit cli-update with no durable identity file fails closed without consulting the resume environment", async (t) => {
  // A real Home directory: the durable pre-effect identity file would live
  // under it, but this variant deliberately writes none (the process hard-
  // exited before the pre-effect persistence).
  const home = mkdtempSync(join(tmpdir(), "yui-rr23-hardexit-nofile-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let prefixQueried = false;
  const ports = realPorts(async (command, args) => {
    if (command === "npm" && args[0] === "prefix") {
      // The resume caller's environment resolves a DIFFERENT global prefix.
      // It must never be consulted: deriving the target from it could
      // confirm a different installation.
      prefixQueried = true;
      return { code: 0, stdout: "/other/prefix\n", stderr: "" };
    }
    return { code: 0, stdout: "1.2.3\n", stderr: "" };
  }, { home });
  // No externalIdentity: simulates a hard exit between the global effect
  // and the idempotency/identity persistence.
  const query = await ports.queryStepEffect({
    step: {
      id: "update",
      kind: "cli-update",
      idempotencyKey: "task-1/release-workflow-1/update",
      params: { version: "1.2.3" },
      irreversibility: "irreversible"
    }
  });

  assert.equal(query.state, "unknown",
    "a hard-exit cli-update with no durable identity file must not be confirmed");
  assert.equal(prefixQueried, false,
    "the resume caller's npm prefix must never be consulted for a hard-exit query");
});

// --- rr21 regression tests ---

test("rr21 P1 regression: Controller ownership unknown persists as unknown/manual blocker, not controller-home query", async () => {
  const fx = engineFixture({
    plan: [
      { id: "update", kind: "cli-update", irreversibility: "irreversible", params: { version: "2.0.0" } },
      { id: "publish", kind: "npm-publish", irreversibility: "irreversible" }
    ]
  });

  // Custom updatePorts that trigger the controllerOwnershipUnknown path:
  // binary activation and health check succeed, but Controller start fails
  // with UPDATE_CONTROLLER_UNKNOWN_ACTIVE (the replacement Controller's
  // identity could not be authenticated).
  const updatePorts = {
    stage: (version) => ({ binaryPath: "/tmp/staged/yui", version: version ?? "2.0.0" }),
    preflight: () => ({ status: "already-current" }),
    controllerStatus: () => ({
      running: true,
      pid: 12345,
      identity: {
        executablePath: "/usr/local/bin/node",
        args: ["/usr/local/bin/yui", "controller"],
        version: "1.0.0"
      }
    }),
    stopController: () => ({ stopped: true, pid: 12345 }),
    activateBinary: () => {},
    verify: () => {},
    startController: () => {
      throw Object.assign(new Error("Controller ownership could not be authenticated"), {
        code: "UPDATE_CONTROLLER_UNKNOWN_ACTIVE"
      });
    },
    restoreController: () => {},
    probeStorage: () => ({ switched: false, schemaCurrent: true }),
    cleanup: () => {}
  };

  let publishAttempted = false;
  const ports = realPorts(
    async (command, args) => {
      // The adapter's pre-effect identity persistence runs `npm prefix
      // --global`; only an actual publish counts as a subsequent effect.
      if (command === "npm" && args[0] === "publish") publishAttempted = true;
      return { code: 0, stdout: "", stderr: "" };
    },
    { updatePorts }
  );

  // First run: cli-update fails with controllerOwnershipUnknown.
  // The adapter must return timeout WITHOUT externalIdentity so the engine
  // marks the step as unknown and stops — a controller-home identity query
  // would confirm the global binary but NOT prove the Controller handoff.
  const first = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", ports, { now: () => NOW });
  assert.equal(first.outcome, "unknown", `first run should be unknown, got ${first.outcome}`);
  assert.ok(first.stopReason.includes("unknown:update"),
    `expected unknown:update, got ${first.stopReason}`);

  const stepAfterFirst = fx.workflow.steps.update;
  assert.equal(stepAfterFirst.status, "unknown", "cli-update step should be unknown");
  assert.equal(stepAfterFirst.externalIdentity, undefined,
    "controllerOwnershipUnknown must NOT persist a controller-home identity");

  // Second run (resume): the unknown step without identity must fail closed
  // (unconfirmed) and must NOT continue to the npm-publish step.
  const second = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", ports, { now: () => NOW });
  assert.equal(second.outcome, "unconfirmed", `second run should be unconfirmed, got ${second.outcome}`);
  assert.ok(second.stopReason.includes("unconfirmed:update"),
    `expected unconfirmed:update, got ${second.stopReason}`);
  assert.equal(publishAttempted, false, "second run must not continue to subsequent effects");

  const publishStep = fx.workflow.steps.publish;
  assert.equal(publishStep.status, "pending", "npm-publish step must not be attempted");
});

// --- rr22 regression tests ---

/**
 * A Controller start failure for the cli-update handoff. Every variant
 * (generic start failure, identity mismatch, unknown-active) must persist as
 * an unknown step WITHOUT a controller-home identity, so a resume cannot
 * confirm the step on binary health alone and cannot continue to subsequent
 * irreversible effects.
 */
function controllerHandoffFailurePorts(startError) {
  const updatePorts = {
    stage: (version) => ({ binaryPath: "/tmp/staged/yui", version: version ?? "2.0.0" }),
    preflight: () => ({ status: "already-current" }),
    controllerStatus: () => ({
      running: true,
      pid: 12345,
      identity: {
        executablePath: "/usr/local/bin/node",
        args: ["/usr/local/bin/yui", "controller"],
        version: "1.0.0"
      }
    }),
    stopController: () => ({ stopped: true, pid: 12345 }),
    activateBinary: () => {},
    verify: () => {},
    startController: () => { throw startError; },
    restoreController: () => {},
    probeStorage: () => ({ switched: false, schemaCurrent: true }),
    cleanup: () => {}
  };
  let publishAttempted = false;
  const ports = realPorts(
    async (command, args) => {
      // The adapter's pre-effect identity persistence runs `npm prefix
      // --global`; only an actual publish counts as a subsequent effect.
      if (command === "npm" && args[0] === "publish") publishAttempted = true;
      return { code: 0, stdout: "", stderr: "" };
    },
    { updatePorts }
  );
  return { ports, get publishAttempted() { return publishAttempted; } };
}

test("rr22 P1-1 regression: a generic Controller start failure persists as unknown without identity", async () => {
  const fx = engineFixture({
    plan: [
      { id: "update", kind: "cli-update", irreversibility: "irreversible", params: { version: "2.0.0" } },
      { id: "publish", kind: "npm-publish", irreversibility: "irreversible" }
    ]
  });
  const { ports, publishAttempted } = controllerHandoffFailurePorts(
    new Error("replacement Controller exited immediately after spawn")
  );

  const first = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", ports, { now: () => NOW });
  assert.equal(first.outcome, "unknown", `first run should be unknown, got ${first.outcome}`);
  assert.ok(first.stopReason.includes("unknown:update"),
    `expected unknown:update, got ${first.stopReason}`);

  const stepAfterFirst = fx.workflow.steps.update;
  assert.equal(stepAfterFirst.status, "unknown", "cli-update step should be unknown");
  assert.equal(stepAfterFirst.externalIdentity, undefined,
    "a Controller start failure must NOT persist a controller-home identity");

  const second = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", ports, { now: () => NOW });
  assert.equal(second.outcome, "unconfirmed", `second run should be unconfirmed, got ${second.outcome}`);
  assert.ok(second.stopReason.includes("unconfirmed:update"),
    `expected unconfirmed:update, got ${second.stopReason}`);
  assert.equal(publishAttempted, false, "second run must not continue to subsequent effects");
  assert.equal(fx.workflow.steps.publish.status, "pending", "npm-publish step must not be attempted");
});

test("rr22 P1-1 regression: an identity-mismatch Controller start failure persists as unknown without identity", async () => {
  const fx = engineFixture({
    plan: [
      { id: "update", kind: "cli-update", irreversibility: "irreversible", params: { version: "2.0.0" } },
      { id: "publish", kind: "npm-publish", irreversibility: "irreversible" }
    ]
  });
  const mismatch = Object.assign(
    new Error("Replacement Controller launch identity does not match the activated global binary"),
    { code: "UPDATE_CONTROLLER_IDENTITY_MISMATCH", replacementPid: 67890, replacementStopped: true }
  );
  const { ports, publishAttempted } = controllerHandoffFailurePorts(mismatch);

  const first = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", ports, { now: () => NOW });
  assert.equal(first.outcome, "unknown", `first run should be unknown, got ${first.outcome}`);
  assert.equal(fx.workflow.steps.update.externalIdentity, undefined,
    "an identity mismatch must NOT persist a controller-home identity");

  const second = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", ports, { now: () => NOW });
  assert.equal(second.outcome, "unconfirmed", `second run should be unconfirmed, got ${second.outcome}`);
  assert.equal(publishAttempted, false, "second run must not continue to subsequent effects");
});

test("rr22 P1-1 regression: a hard-exit cli-update query fails closed when no Controller is current for the Home", async (t) => {
  // A real Home with a durable pre-effect identity file, as the adapter
  // writes it before the irreversible effect.
  const home = mkdtempSync(join(tmpdir(), "yui-rr22-nocontroller-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const idempotencyKey = "task-1/release-workflow-1/update";
  const identityFile = join(home, "release", "cli-update-identity", `${idempotencyKey}.json`);
  mkdirSync(dirname(identityFile), { recursive: true });
  writeFileSync(
    identityFile,
    JSON.stringify({ home, globalPrefix: "/usr/local" }),
    { flag: "wx" }
  );
  const calls = [];
  const ports = realPorts(async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "npm" && args[0] === "prefix") {
      return { code: 0, stdout: "/other/prefix\n", stderr: "" };
    }
    if (args.includes("controller") && args.includes("status")) {
      // No current Controller for this Home: the handoff never completed.
      return { code: 0, stdout: JSON.stringify({ ok: true, data: { resources: [] } }) + "\n", stderr: "" };
    }
    // Binary health is fine — this must NOT be enough to confirm.
    return { code: 0, stdout: "1.2.3\n", stderr: "" };
  }, { home });
  // No externalIdentity: simulates a hard exit during the handoff window.
  const query = await ports.queryStepEffect({
    step: {
      id: "update",
      kind: "cli-update",
      idempotencyKey,
      params: { version: "1.2.3" },
      irreversibility: "irreversible"
    }
  });

  assert.equal(query.state, "unknown",
    "binary health without a current Controller must not confirm the handoff");
  const statusCall = calls.find((c) => c.args.includes("controller") && c.args.includes("status"));
  assert.notEqual(statusCall, undefined, "the query must check the Controller lifecycle, not just binary health");
  assert.equal(calls.some((c) => c.command === "npm" && c.args[0] === "prefix"), false,
    "the durable identity file pins the target; the resume environment's npm prefix must not be consulted");
});

test("rr22 P1-1 regression: a hard-exit cli-update query fails closed when the Controller runs a different version", async () => {
  const ports = realPorts(async (command, args) => {
    if (command === "npm" && args[0] === "prefix") {
      return { code: 0, stdout: "/usr/local\n", stderr: "" };
    }
    if (args.includes("controller") && args.includes("status")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            resources: [{
              kind: "controller",
              state: "current",
              yuiHome: "/isolated/exact-home",
              processes: [{ pid: 4242 }]
            }]
          }
        }) + "\n",
        stderr: ""
      };
    }
    if (args.includes("controller") && args.includes("identity")) {
      // The running Controller is an OLD version, not the replacement.
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            executablePath: "/usr/local/bin/node",
            args: ["/usr/local/bin/yui", "controller"],
            version: "1.0.0"
          }
        }) + "\n",
        stderr: ""
      };
    }
    return { code: 0, stdout: "1.2.3\n", stderr: "" };
  });
  const query = await ports.queryStepEffect({
    step: {
      id: "update",
      kind: "cli-update",
      idempotencyKey: "task-1/release-workflow-1/update",
      params: { version: "1.2.3" },
      irreversibility: "irreversible"
    }
  });

  assert.equal(query.state, "unknown",
    "a wrong-version Controller must not confirm the expected-version handoff");
});

test("rr22 P1-1 regression: a current expected-version Controller confirms a hard-exit cli-update query", async (t) => {
  // A real Home with the durable pre-effect identity file the adapter writes
  // before the irreversible effect.
  const home = mkdtempSync(join(tmpdir(), "yui-rr22-confirms-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const idempotencyKey = "task-1/release-workflow-1/update";
  const identityFile = join(home, "release", "cli-update-identity", `${idempotencyKey}.json`);
  mkdirSync(dirname(identityFile), { recursive: true });
  writeFileSync(
    identityFile,
    JSON.stringify({ home, globalPrefix: "/usr/local" }),
    { flag: "wx" }
  );
  const ports = realPorts(async (command, args) => {
    if (command === "npm" && args[0] === "prefix") {
      return { code: 0, stdout: "/other/prefix\n", stderr: "" };
    }
    if (args.includes("controller") && args.includes("status")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            resources: [{
              kind: "controller",
              state: "current",
              yuiHome: home,
              processes: [{ pid: 4242 }]
            }]
          }
        }) + "\n",
        stderr: ""
      };
    }
    if (args.includes("controller") && args.includes("identity")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            executablePath: process.execPath,
            args: [activatedControllerEntrypoint("/usr/local/bin/yui")],
            version: "1.2.3"
          }
        }) + "\n",
        stderr: ""
      };
    }
    return { code: 0, stdout: "1.2.3\n", stderr: "" };
  }, { home });
  const query = await ports.queryStepEffect({
    step: {
      id: "update",
      kind: "cli-update",
      idempotencyKey,
      params: { version: "1.2.3" },
      irreversibility: "irreversible"
    }
  });

  assert.equal(query.state, "exists",
    "a current Controller reporting the expected version and exact entrypoint completes the lifecycle proof");
});

test("rr22 P1-2 regression: resolveExecutable pins external commands to absolute PATH-resolved paths", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yui-rr22-path-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakeGh = join(dir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\n", { mode: 0o755 });

  assert.equal(resolveExecutable("gh", dir), fakeGh,
    "a command on PATH resolves to its absolute path");
  assert.equal(resolveExecutable("gh", `${dir}${delimiter}/empty`), fakeGh,
    "the first matching PATH entry wins");
  assert.equal(resolveExecutable("definitely-not-on-path-xyz", dir), undefined,
    "an unresolvable command has no trusted executable and must fail closed without invoking PATH");
  assert.equal(resolveExecutable("/already/absolute/npm", dir), "/already/absolute/npm",
    "an absolute command is returned unchanged");
});

test("rr22 P1-2 regression: a pinned activation target is queried even when the caller's npm prefix differs", async () => {
  const calls = [];
  const ports = realPorts(async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "npm" && args[0] === "prefix") {
      // The resume caller's environment resolves a DIFFERENT global prefix.
      return { code: 0, stdout: "/other/prefix\n", stderr: "" };
    }
    if (args[0] !== undefined && args[0].includes("/usr/local/bin/yui")) {
      // The pinned activation target is gone: its doctor must fail closed.
      return { code: 1, stdout: "", stderr: "no such file or directory" };
    }
    if (args[0] !== undefined && args[0].includes("/other/prefix/bin/yui")) {
      // A healthy foreign installation must NOT confirm this step.
      return { code: 0, stdout: "1.2.3\n", stderr: "" };
    }
    return { code: 0, stdout: "1.2.3\n", stderr: "" };
  });
  // The persisted identity pins the exact activation target.
  const query = await ports.queryStepEffect({
    step: {
      id: "update",
      kind: "cli-update",
      idempotencyKey: "task-1/release-workflow-1/update",
      params: { version: "1.2.3" },
      irreversibility: "irreversible"
    },
    externalIdentity: {
      kind: "controller-home",
      value: JSON.stringify({ home: "/isolated/exact-home", globalPrefix: "/usr/local" })
    }
  });

  assert.equal(query.state, "unknown",
    "a missing pinned target must fail closed even when the caller's environment has a healthy other install");
  assert.equal(calls.some((c) => c.command === "npm" && c.args[0] === "prefix"), false,
    "the caller's npm prefix must never be consulted for a pinned identity");
});

test("rr22 P1-2 regression: a pinned activation target confirms without consulting the caller's npm prefix", async () => {
  const calls = [];
  const ports = realPorts(async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "npm" && args[0] === "prefix") {
      return { code: 0, stdout: "/other/prefix\n", stderr: "" };
    }
    if (args.includes("controller") && args.includes("status")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            resources: [{
              kind: "controller",
              state: "current",
              yuiHome: "/isolated/exact-home",
              processes: [{ pid: 4242 }]
            }]
          }
        }) + "\n",
        stderr: ""
      };
    }
    if (args.includes("controller") && args.includes("identity")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            executablePath: process.execPath,
            args: [activatedControllerEntrypoint("/usr/local/bin/yui")],
            version: "1.2.3"
          }
        }) + "\n",
        stderr: ""
      };
    }
    return { code: 0, stdout: "1.2.3\n", stderr: "" };
  });
  const query = await ports.queryStepEffect({
    step: {
      id: "update",
      kind: "cli-update",
      idempotencyKey: "task-1/release-workflow-1/update",
      params: { version: "1.2.3" },
      irreversibility: "irreversible"
    },
    externalIdentity: {
      kind: "controller-home",
      value: JSON.stringify({ home: "/isolated/exact-home", globalPrefix: "/usr/local" })
    }
  });

  assert.equal(query.state, "exists");
  assert.equal(calls.some((c) => c.command === "npm" && c.args[0] === "prefix"), false,
    "a pinned identity must not re-derive the target from the caller's environment");
});

test("rr22 P1-3 regression: npm publish reads an immutable snapshot of the verified tarball, not the live path", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yui-rr22-toctou-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tarball = join(dir, "widget-1.2.3.tgz");
  const verifiedBytes = Buffer.from("verified-tarball-bytes");
  writeFileSync(tarball, verifiedBytes);
  const integrity = `sha512-${createHash("sha512").update(verifiedBytes).digest("base64")}`;

  let publishedPath;
  let publishedBytes;
  const ports = realPorts(async (command, args) => {
    if (command === "tar") {
      return { code: 0, stdout: JSON.stringify({ name: "@acme/widget", version: "1.2.3" }), stderr: "" };
    }
    if (command === "npm" && args[0] === "publish") {
      publishedPath = args[args.length - 1];
      // Attacker replaces the original tarball AFTER the integrity check.
      writeFileSync(tarball, Buffer.from("TAMPERED-BYTES"));
      publishedBytes = readFileSync(publishedPath);
      return { code: 0, stdout: "+ @acme/widget@1.2.3\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
  });

  const effect = await ports.executeStep({
    step: {
      id: "publish",
      kind: "npm-publish",
      idempotencyKey: "task-1/release-workflow-1/publish",
      irreversibility: "irreversible"
    },
    idempotencyKey: "task-1/release-workflow-1/publish",
    source: { ...SOURCE, artifact: { name: "widget-1.2.3.tgz", integrity } },
    params: { package: "@acme/widget", version: "1.2.3", tarball }
  });

  assert.equal(effect.outcome, "succeeded");
  assert.notEqual(publishedPath, tarball,
    "publish must read the private snapshot, not the live tarball path");
  assert.deepEqual(publishedBytes, verifiedBytes,
    "publish must read the verified snapshot bytes even after the live path is replaced");
  assert.equal(existsSync(publishedPath), false,
    "the private snapshot must be removed after publish completes");
});

test("rr22 P1-4 regression: npm recovery with a matching version but mismatched integrity stays unknown", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-rr24-integrity-mismatch-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeNpmPublishTarget(home, "task-1/release-workflow-1/publish", "/usr/local/bin/npm", "https://registry.example.com/");
  const ports = realPorts(async (command, args) => {
    if (args[0] === "view" && args.includes("dist.integrity")) {
      // Same version, different bytes: a conflict, never a confirmation.
      return { code: 0, stdout: "sha512-DIFFERENT-BYTES\n", stderr: "" };
    }
    return { code: 0, stdout: "1.2.3\n", stderr: "" };
  }, { home });
  const query = await ports.queryStepEffect({
    step: {
      id: "publish",
      kind: "npm-publish",
      idempotencyKey: "task-1/release-workflow-1/publish",
      params: { package: "@acme/widget", version: "1.2.3" },
      irreversibility: "irreversible"
    },
    source: SOURCE,
    externalIdentity: { kind: "npm-package", value: "@acme/widget@1.2.3" }
  });

  assert.equal(query.state, "unknown",
    "a same-version publish with different integrity must never confirm the step");
});

test("rr22 P1-4 regression: npm recovery confirms only when version and integrity both match", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-rr24-integrity-match-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeNpmPublishTarget(home, "task-1/release-workflow-1/publish", "/usr/local/bin/npm", "https://registry.example.com/");
  const calls = [];
  const ports = realPorts(async (command, args) => {
    calls.push({ command, args: [...args] });
    if (args[0] === "view" && args.includes("dist.integrity")) {
      return { code: 0, stdout: `${SOURCE.artifact.integrity}\n`, stderr: "" };
    }
    return { code: 0, stdout: "1.2.3\n", stderr: "" };
  }, { home });
  const query = await ports.queryStepEffect({
    step: {
      id: "publish",
      kind: "npm-publish",
      idempotencyKey: "task-1/release-workflow-1/publish",
      params: { package: "@acme/widget", version: "1.2.3" },
      irreversibility: "irreversible"
    },
    source: SOURCE,
    externalIdentity: { kind: "npm-package", value: "@acme/widget@1.2.3" }
  });

  assert.equal(query.state, "exists");
  assert.equal(query.externalId, "1.2.3");
  // P1 (rr24): both view calls must use the persisted npm executable and
  // registry, never the resume caller's bare npm/registry.
  for (const call of calls.filter((c) => c.args[0] === "view")) {
    assert.equal(call.command, "/usr/local/bin/npm",
      "the recovery query must use the persisted npm executable");
    assert.ok(call.args.includes("--registry"),
      "the recovery query must pin the persisted registry");
    assert.ok(call.args.includes("https://registry.example.com/"),
      "the recovery query must query the persisted registry");
  }
});

test("rr22 P1-4 regression: a timed-out publish stays unknown when the registry serves the same version with different bytes", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-rr22-p1-4-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = mkdtempSync(join(tmpdir(), "yui-rr22-p1-4-tarball-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tarball = join(dir, "widget-1.2.3.tgz");
  const verifiedBytes = Buffer.from("verified-tarball-bytes");
  writeFileSync(tarball, verifiedBytes);
  const integrity = `sha512-${createHash("sha512").update(verifiedBytes).digest("base64")}`;

  let publishCalls = 0;
  const viewCalls = [];
  const runCommand = async (command, args) => {
    if (command === "tar") {
      return { code: 0, stdout: JSON.stringify({ name: "@acme/widget", version: "1.2.3" }), stderr: "" };
    }
    // The pre-effect persistence records environment A's registry. Dispatch
    // npm commands on args: on resume the command is the persisted absolute
    // npm path, not the bare "npm".
    if (args[0] === "config" && args[1] === "get") {
      return { code: 0, stdout: "https://registry-a.example.com/\n", stderr: "" };
    }
    if (args[0] === "publish") {
      publishCalls += 1;
      // Transport failure after the upload: the package may have landed.
      return { code: 1, stdout: "", stderr: "network timeout during upload" };
    }
    if (args[0] === "view") {
      viewCalls.push({ command, args: [...args] });
      if (args.includes("dist.integrity")) {
        // The registry now serves 1.2.3 with DIFFERENT bytes than the frozen
        // artifact: a same-version/different-integrity conflict.
        return { code: 0, stdout: "sha512-DIFFERENT-BYTES\n", stderr: "" };
      }
      return { code: 0, stdout: "1.2.3\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
  };
  const ports = realPorts(runCommand, { home });

  const fx = engineFixture({
    source: { ...SOURCE, artifact: { name: "widget-1.2.3.tgz", integrity } },
    plan: [{
      id: "publish",
      kind: "npm-publish",
      params: { package: "@acme/widget", version: "1.2.3", tarball },
      irreversibility: "irreversible"
    }]
  });

  // First run: the transport failure after upload persists the npm-package
  // identity so the engine queries the registry instead of re-publishing.
  const first = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", ports, { now: () => NOW });
  assert.equal(first.outcome, "failed", `first run should be failed, got ${first.outcome}`);
  assert.equal(fx.workflow.steps.publish.status, "failed");
  assert.deepEqual(fx.workflow.steps.publish.externalIdentity,
    { kind: "npm-package", value: "@acme/widget@1.2.3" });
  // The durable pre-effect target must pin environment A's npm and registry.
  const persisted = JSON.parse(readFileSync(
    join(home, "release", "npm-publish-target", "task-1/release-workflow-1/publish.json"), "utf8"));
  assert.equal(typeof persisted.npmPath, "string");
  assert.ok(persisted.npmPath.length > 0, "the durable target must record the resolved npm path");
  assert.equal(persisted.registry, "https://registry-a.example.com/");

  // Second run: the recovery query finds the same version with different
  // bytes. The run must remain unknown — never confirmed, never re-published.
  const second = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", ports, { now: () => NOW });
  assert.equal(second.outcome, "unknown", `second run should be unknown, got ${second.outcome}`);
  // The engine preserves the failed record and its identity while reporting
  // an unknown recovery disposition; it does not invent a new state transition
  // when the authoritative query itself is unknowable.
  assert.equal(fx.workflow.steps.publish.status, "failed");
  assert.equal(publishCalls, 1, "the conflicting publish must never be re-submitted");
  // P1 (rr24): the recovery query must use the persisted npm executable and
  // registry from environment A, never the resume caller's bare npm.
  assert.ok(viewCalls.length >= 2, "expected both version and dist.integrity view calls");
  for (const call of viewCalls) {
    assert.equal(call.command, persisted.npmPath,
      "the recovery query must use the persisted npm executable");
    assert.notEqual(call.command, "npm",
      "the recovery query must never fall back to the bare npm");
    assert.ok(call.args.includes("--registry"),
      "the recovery query must pin the persisted registry");
    assert.ok(call.args.includes("https://registry-a.example.com/"),
      "the recovery query must query environment A's registry");
  }
});

test("rr22 P1-5 regression: post-verify requires an irreversible grant ceiling", async () => {
  const fx = engineFixture({
    grant: { irreversibilityCeiling: "none" },
    plan: [{ id: "verify", kind: "post-verify", params: { command: "yui --version" } }]
  });
  let calls = 0;
  const result = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", {
    executeStep: async () => { calls += 1; return { outcome: "succeeded" }; },
    queryStepEffect: async () => ({ state: "unknown" })
  }, { now: () => NOW });

  assert.equal(result.outcome, "unauthorized");
  assert.ok(result.stopReason.includes("grant-irreversibility-exceeds-ceiling"),
    `expected grant-irreversibility-exceeds-ceiling, got ${result.stopReason}`);
  assert.equal(calls, 0, "the arbitrary shell command must never execute under a none ceiling");
});

test("rr22 P1-5 regression: post-verify is denied under a reversible ceiling too", async () => {
  const fx = engineFixture({
    grant: { irreversibilityCeiling: "reversible" },
    plan: [{ id: "verify", kind: "post-verify", params: { command: "yui --version" } }]
  });
  let calls = 0;
  const result = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", {
    executeStep: async () => { calls += 1; return { outcome: "succeeded" }; },
    queryStepEffect: async () => ({ state: "unknown" })
  }, { now: () => NOW });

  assert.equal(result.outcome, "unauthorized");
  assert.ok(result.stopReason.includes("grant-irreversibility-exceeds-ceiling"),
    `expected grant-irreversibility-exceeds-ceiling, got ${result.stopReason}`);
  assert.equal(calls, 0);
});

// --- rr23 regression tests ---

/**
 * An updatePorts fake whose post-verify health check fails after binary
 * activation: an aborted, non-recoverable outcome. The adapter persists a
 * controller-home identity so the engine marks the step unknown-with-identity
 * and a resume re-queries instead of re-submitting.
 */
function postVerifyFailureUpdatePorts() {
  return {
    stage: (version) => ({ binaryPath: "/tmp/staged/yui", version: version ?? "2.0.0" }),
    preflight: () => ({ status: "already-current" }),
    controllerStatus: () => ({ running: false }),
    stopController: () => { throw new Error("not running"); },
    activateBinary: () => {},
    verify: () => { throw new Error("post-update health check failed"); },
    startController: () => {},
    restoreController: () => {},
    probeStorage: () => ({ switched: false, schemaCurrent: true }),
    cleanup: () => {}
  };
}

test("rr23 P1-1 regression: a same-version Controller with a foreign entrypoint cannot confirm a cli-update query", async () => {
  const ports = realPorts(async (command, args) => {
    if (command === "npm" && args[0] === "prefix") {
      return { code: 0, stdout: "/usr/local\n", stderr: "" };
    }
    if (args.includes("controller") && args.includes("status")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            resources: [{
              kind: "controller",
              state: "current",
              yuiHome: "/isolated/exact-home",
              processes: [{ pid: 4242 }]
            }]
          }
        }) + "\n",
        stderr: ""
      };
    }
    if (args.includes("controller") && args.includes("identity")) {
      // The CORRECT version but a FOREIGN entrypoint: a same-version install
      // that is not the activated global artifact.
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            executablePath: process.execPath,
            args: ["/usr/local/lib/foreign-yui/dist/controller/controllerMain.js"],
            version: "1.2.3"
          }
        }) + "\n",
        stderr: ""
      };
    }
    return { code: 0, stdout: "1.2.3\n", stderr: "" };
  });
  const query = await ports.queryStepEffect({
    step: {
      id: "update",
      kind: "cli-update",
      idempotencyKey: "task-1/release-workflow-1/update",
      params: { version: "1.2.3" },
      irreversibility: "irreversible"
    },
    externalIdentity: {
      kind: "controller-home",
      value: JSON.stringify({ home: "/isolated/exact-home", globalPrefix: "/usr/local" })
    }
  });

  assert.equal(query.state, "unknown",
    "a same-version Controller with a foreign entrypoint must not confirm the activated artifact");
});

test("rr23 P1-1 regression: a timed-out cli-update stays unknown on resume when the Controller reports the same version from a foreign entrypoint", async () => {
  const fx = engineFixture({
    plan: [
      { id: "update", kind: "cli-update", irreversibility: "irreversible", params: { version: "2.0.0" } },
      { id: "publish", kind: "npm-publish", irreversibility: "irreversible" }
    ]
  });
  let publishAttempted = false;
  const ports = realPorts(async (command, args) => {
    if (command === "npm" && args[0] === "prefix") {
      return { code: 0, stdout: "/usr/local\n", stderr: "" };
    }
    if (args.includes("doctor")) return { code: 0, stdout: "", stderr: "" };
    if (args.includes("--version")) return { code: 0, stdout: "2.0.0\n", stderr: "" };
    if (args.includes("controller") && args.includes("status")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            resources: [{
              kind: "controller",
              state: "current",
              yuiHome: "/isolated/exact-home",
              processes: [{ pid: 4242 }]
            }]
          }
        }) + "\n",
        stderr: ""
      };
    }
    if (args.includes("controller") && args.includes("identity")) {
      // Same version, FOREIGN entrypoint: the recovery query must not confirm.
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            executablePath: process.execPath,
            args: ["/usr/local/lib/foreign-yui/dist/controller/controllerMain.js"],
            version: "2.0.0"
          }
        }) + "\n",
        stderr: ""
      };
    }
    if (command === "npm" && args[0] === "publish") publishAttempted = true;
    return { code: 0, stdout: "", stderr: "" };
  }, { updatePorts: postVerifyFailureUpdatePorts() });

  // First run: the cli-update times out with a controller-home identity.
  const first = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", ports, { now: () => NOW });
  assert.equal(first.outcome, "unknown", `first run should be unknown, got ${first.outcome}`);
  assert.ok(first.stopReason.includes("unknown:update"),
    `expected unknown:update, got ${first.stopReason}`);
  assert.equal(fx.workflow.steps.update.externalIdentity?.kind, "controller-home",
    "the timed-out cli-update must persist a queryable controller-home identity");

  // Second run: the recovery query finds a same-version Controller launched
  // from a foreign entrypoint. The step must stay unknown and subsequent
  // effects must not execute.
  const second = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", ports, { now: () => NOW });
  assert.equal(second.outcome, "unknown", `second run should stay unknown, got ${second.outcome}`);
  assert.ok(second.stopReason.includes("unknown:update"),
    `expected unknown:update, got ${second.stopReason}`);
  assert.equal(publishAttempted, false,
    "subsequent effects must not execute while the Controller handoff is unconfirmed");
  assert.equal(fx.workflow.steps.publish.status, "pending", "npm-publish step must not be attempted");
});

test("rr23 P1-2 regression: a resume query uses the durable pre-effect identity from the update process, never the resume environment", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-rr23-twoenv-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const idempotencyKey = "task-1/release-workflow-1/update";

  // Environment A: the update process. Its npm prefix resolves to /usr/local.
  // The post-verify failure makes the effect ambiguous, but the adapter must
  // have persisted the exact activation target BEFORE the effect ran.
  const portsA = realPorts(async (command, args) => {
    if (command === "npm" && args[0] === "prefix") {
      return { code: 0, stdout: "/usr/local\n", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }, { home, updatePorts: postVerifyFailureUpdatePorts() });
  const effect = await portsA.executeStep({
    step: {
      id: "update",
      kind: "cli-update",
      idempotencyKey,
      params: { version: "2.0.0" },
      irreversibility: "irreversible"
    },
    idempotencyKey,
    source: SOURCE,
    params: { version: "2.0.0" }
  });
  assert.equal(effect.outcome, "timeout");

  // The durable pre-effect identity file pins environment A's exact target.
  const identityFile = join(home, "release", "cli-update-identity", `${idempotencyKey}.json`);
  assert.ok(existsSync(identityFile),
    "the adapter must persist the activation target to a durable file before the effect");
  const persisted = JSON.parse(readFileSync(identityFile, "utf8"));
  assert.equal(persisted.home, home);
  assert.equal(persisted.globalPrefix, "/usr/local");

  // Environment B: a different resume caller whose npm prefix is /other/prefix.
  let envBPrefixQueried = false;
  const portsB = realPorts(async (command, args) => {
    if (command === "npm" && args[0] === "prefix") {
      envBPrefixQueried = true;
      return { code: 0, stdout: "/other/prefix\n", stderr: "" };
    }
    if (args.includes("doctor")) return { code: 0, stdout: "", stderr: "" };
    if (args.includes("--version")) return { code: 0, stdout: "2.0.0\n", stderr: "" };
    if (args.includes("controller") && args.includes("status")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            resources: [{
              kind: "controller",
              state: "current",
              yuiHome: home,
              processes: [{ pid: 4242 }]
            }]
          }
        }) + "\n",
        stderr: ""
      };
    }
    if (args.includes("controller") && args.includes("identity")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            executablePath: process.execPath,
            args: [activatedControllerEntrypoint("/usr/local/bin/yui")],
            version: "2.0.0"
          }
        }) + "\n",
        stderr: ""
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  }, { home });
  // No externalIdentity: simulates a hard exit between the effect and the
  // engine's identity persistence. The durable file is the only authority.
  const query = await portsB.queryStepEffect({
    step: {
      id: "update",
      kind: "cli-update",
      idempotencyKey,
      params: { version: "2.0.0" },
      irreversibility: "irreversible"
    }
  });

  assert.equal(query.state, "exists",
    "the resume query must confirm against the persisted target from environment A");
  assert.equal(envBPrefixQueried, false,
    "the resume caller's npm prefix must never be consulted");
});

// --- rr24 regression tests ---

test("rr24 P1 regression: npm-publish recovery queries the persisted npm executable and registry, not the resume environment's", async (t) => {
  // A real Home shared by both adapters: the durable pre-effect target file
  // is the only channel through which environment A's npm/registry reaches
  // the environment-B resume.
  const home = mkdtempSync(join(tmpdir(), "yui-rr24-npm-target-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = mkdtempSync(join(tmpdir(), "yui-rr24-npm-tarball-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tarball = join(dir, "widget-1.2.3.tgz");
  const verifiedBytes = Buffer.from("verified-tarball-bytes");
  writeFileSync(tarball, verifiedBytes);
  const integrity = `sha512-${createHash("sha512").update(verifiedBytes).digest("base64")}`;

  // Adapter A (environment A): the publish times out after the upload. Its
  // runCommand answers `npm config get registry` with environment A's
  // registry and fails the publish with a transport error.
  const runCommandA = async (command, args) => {
    if (command === "tar") {
      return { code: 0, stdout: JSON.stringify({ name: "@acme/widget", version: "1.2.3" }), stderr: "" };
    }
    if (args[0] === "config" && args[1] === "get") {
      return { code: 0, stdout: "https://registry-a.example.com/\n", stderr: "" };
    }
    if (args[0] === "publish") {
      // Transport failure after the upload: the package may have landed.
      return { code: 1, stdout: "", stderr: "network timeout during upload" };
    }
    return { code: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
  };
  const portsA = realPorts(runCommandA, { home });

  const fx = engineFixture({
    source: { ...SOURCE, artifact: { name: "widget-1.2.3.tgz", integrity } },
    plan: [{
      id: "publish",
      kind: "npm-publish",
      params: { package: "@acme/widget", version: "1.2.3", tarball },
      irreversibility: "irreversible"
    }]
  });

  // First run: the transport failure persists the npm-package identity and
  // the durable pre-effect target (npm path + registry).
  const first = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", portsA, { now: () => NOW });
  assert.equal(first.outcome, "failed", `first run should be failed, got ${first.outcome}`);
  assert.equal(fx.workflow.steps.publish.status, "failed");
  assert.deepEqual(fx.workflow.steps.publish.externalIdentity,
    { kind: "npm-package", value: "@acme/widget@1.2.3" });

  // The durable receipt must pin environment A's npm executable and registry.
  const persisted = JSON.parse(readFileSync(
    join(home, "release", "npm-publish-target", "task-1/release-workflow-1/publish.json"), "utf8"));
  assert.equal(typeof persisted.npmPath, "string");
  assert.ok(persisted.npmPath.length > 0, "the durable target must record the resolved npm path");
  assert.equal(persisted.registry, "https://registry-a.example.com/");

  // Adapter B (environment B): a DIFFERENT runCommand that reports the
  // matching version and integrity. It must be invoked with the persisted
  // npmPath from environment A and the --registry flag — never the bare
  // "npm" and never environment B's own registry.
  const callsB = [];
  const runCommandB = async (command, args) => {
    callsB.push({ command, args: [...args] });
    if (args[0] === "view" && args.includes("dist.integrity")) {
      return { code: 0, stdout: `${integrity}\n`, stderr: "" };
    }
    if (args[0] === "view") {
      return { code: 0, stdout: "1.2.3\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
  };
  const portsB = realPorts(runCommandB, { home });

  // Resume: the recovery query confirms the publish against environment A's
  // persisted npm/registry, and the workflow completes.
  const second = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", portsB, { now: () => NOW });
  assert.equal(second.outcome, "succeeded", `second run should succeed, got ${second.outcome}`);
  assert.equal(fx.workflow.steps.publish.status, "succeeded");

  const viewCalls = callsB.filter((c) => c.args[0] === "view");
  assert.ok(viewCalls.length >= 2, "expected both version and dist.integrity view calls");
  for (const call of viewCalls) {
    assert.equal(call.command, persisted.npmPath,
      "recovery must invoke the persisted npm executable from environment A");
    assert.notEqual(call.command, "npm",
      "recovery must never fall back to the resume environment's bare npm");
    assert.ok(call.args.includes("--registry"),
      "the view must pin the persisted registry");
    assert.ok(call.args.includes("https://registry-a.example.com/"),
      "the view must query environment A's registry, not environment B's");
  }
});

test("rr24 P1 regression: npm-publish recovery with no durable target file fails closed without consulting the resume environment's npm", async (t) => {
  // A real Home with NO durable target file (the process hard-exited before
  // the pre-effect persistence). The resume environment's npm must never be
  // consulted: a different mirror with the same version+integrity could
  // otherwise falsely confirm environment A's publish.
  const home = mkdtempSync(join(tmpdir(), "yui-rr24-npm-nofile-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let npmConsulted = false;
  const ports = realPorts(async (command, args) => {
    if (args[0] === "view") npmConsulted = true;
    return { code: 0, stdout: "1.2.3\n", stderr: "" };
  }, { home });

  const query = await ports.queryStepEffect({
    step: {
      id: "publish",
      kind: "npm-publish",
      idempotencyKey: "task-1/release-workflow-1/publish",
      params: { package: "@acme/widget", version: "1.2.3" },
      irreversibility: "irreversible"
    },
    source: SOURCE,
    externalIdentity: { kind: "npm-package", value: "@acme/widget@1.2.3" }
  });

  assert.equal(query.state, "unknown",
    "a hard-exit npm-publish with no durable target file must not be confirmed");
  assert.equal(npmConsulted, false,
    "the resume environment's npm must never be consulted without a durable target");
});

test("rr24 P2 regression: createPinnedRunner negative cache survives a later PATH addition", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yui-rr24-pinned-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakeCommand = "fake-npm-rr24";
  const fakeExecutable = join(dir, fakeCommand);
  writeFileSync(fakeExecutable, "#!/bin/sh\necho fake-npm\n", { mode: 0o755 });

  const originalPath = process.env.PATH;
  const pathWithoutDir = originalPath.split(delimiter).filter((d) => d !== dir).join(delimiter);
  process.env.PATH = pathWithoutDir;
  try {
    const baseCalls = [];
    const runner = createPinnedRunner(async (command) => {
      baseCalls.push(command);
      return { code: 0, stdout: "", stderr: "" };
    });
    // The command is not on PATH at construction: the first call must fail
    // closed without invoking the base runner.
    const first = await runner(fakeCommand, []);
    assert.equal(first.code, 127, "a command missing at construction must fail closed");

    // The command appears on PATH later. The negative cache must still hold:
    // a command resolved as missing at construction stays missing for the
    // adapter's lifetime, so a PATH change cannot swap in a new binary.
    process.env.PATH = `${dir}${delimiter}${pathWithoutDir}`;
    const second = await runner(fakeCommand, []);
    assert.equal(second.code, 127,
      "a command resolved as missing at construction must stay missing even after it appears on PATH");
    assert.equal(baseCalls.length, 0,
      "the base runner must never be invoked for a negatively-cached command");
  } finally {
    process.env.PATH = originalPath;
  }
});
