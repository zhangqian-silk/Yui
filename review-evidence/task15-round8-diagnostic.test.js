import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

// Reviewer-lane diagnostics for frozen Task-final head b7f456b. Every external
// effect is replaced by a deterministic fake command/port. These tests never
// contact GitHub, npm, a Controller, a real Project, or a user Home.

import { createConfiguredAgent } from "../dist/agent/agent.js";
import { runTaskCommand } from "../dist/commands/taskCommands.js";
import { runWorkflowCommandAsync } from "../dist/commands/workflowCommands.js";
import {
  createCapabilityGrant,
  recordGrantUse
} from "../dist/grant/capabilityGrant.js";
import { createInMemoryReleaseIdempotencyStore } from "../dist/release/releaseIdempotencyStore.js";
import {
  createReleaseWorkflow,
  startStep
} from "../dist/release/releaseWorkflow.js";
import { runReleaseWorkflow } from "../dist/release/releaseWorkflowEngine.js";
import { createReleaseWorkflowPorts } from "../dist/release/releaseWorkflowPorts.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { installOperatorSession } from "../test/helpers/operatorSession.js";

const NOW = new Date("2026-08-14T06:30:00.000Z");
const LATER = new Date("2026-08-14T06:30:01.000Z");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SOURCE = Object.freeze({
  repository: { owner: "acme", name: "widget" },
  commit: COMMIT
});
const execFileAsync = promisify(execFile);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-task15-round8-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(agent);
  });
  const task = runTaskCommand(["create", "Task 15 round 8 diagnostic"], store, {
    now: () => NOW
  }).data.task;
  const operator = installOperatorSession(store, agent, NOW);
  return { root, store, task, operator };
}

function memoryFixture({ grant: grantInput = {}, plan, source = SOURCE }) {
  let grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: [...new Set(plan.map(({ kind }) => kind))],
    irreversibilityCeiling: "irreversible",
    ...grantInput
  }, NOW);
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: grant.id,
    source,
    plan
  }, NOW);
  return {
    store: {
      getReleaseWorkflow: () => workflow,
      saveReleaseWorkflow: (_taskId, next) => { workflow = next; },
      getCapabilityGrant: () => grant,
      saveCapabilityGrant: (_taskId, next) => { grant = next; }
    },
    get grant() { return grant; },
    get workflow() { return workflow; }
  };
}

function fakePorts(executeStep, home) {
  return {
    ...(home === undefined ? {} : { home }),
    executeStep,
    queryStepEffect: async () => ({ state: "unknown" })
  };
}
function realAdapter(runCommand, extra = {}) {
  return createReleaseWorkflowPorts({
    home: "/isolated/home",
    updatePorts: {},
    projectStore: {},
    runCommand,
    // Tests that do not exercise idempotency get an in-memory store so the
    // default file store never touches the fake /isolated/home.
    idempotencyStore: createInMemoryReleaseIdempotencyStore(),
    ...extra
  });
}

function updatePortsFake(overrides = {}) {
  const calls = [];
  const ports = {
    stage: () => {
      calls.push("stage");
      return { binaryPath: "/stage/yui", version: "1.2.3" };
    },
    preflight: () => {
      calls.push("preflight");
      return { status: "already-current" };
    },
    activateStorage: () => {
      calls.push("activateStorage");
      return { status: "already-current" };
    },
    activateBinary: () => {
      calls.push("activateBinary");
    },
    verify: () => {
      calls.push("verify");
    },
    probeStorage: () => ({ switched: false, schemaCurrent: true }),
    cleanup: () => {
      calls.push("cleanup");
    },
    ...overrides
  };
  return { ports, calls };
}
test("managed Agents cannot self-issue a post-verify shell grant at ceiling none", (t) => {
  const { store, task } = fixture(t);

  assert.throws(() => runTaskCommand([
    "grant", "issue", task.id,
    "--action", "post-verify"
  ], store, {
    now: () => NOW,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "reviewer",
      YUI_RUN_ID: "agent-run-review"
    }
  }), /managed agent|operator|user authorization/i);
});

test("a persisted running irreversible step without identity is never blindly resubmitted", async (t) => {
  const { store, task } = fixture(t);
  const grant = createCapabilityGrant("capability-grant-1", task.id, {
    granter: "alice",
    actions: ["npm-publish"],
    irreversibilityCeiling: "irreversible"
  }, NOW);
  store.saveCapabilityGrant(task.id, grant);
  let workflow = createReleaseWorkflow("release-workflow-1", task.id, {
    grantId: grant.id,
    source: SOURCE,
    plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
  }, NOW);
  workflow = startStep(workflow, "publish", LATER);
  store.saveReleaseWorkflow(task.id, workflow);
  let calls = 0;

  const result = await runReleaseWorkflow(
    store,
    task.id,
    workflow.id,
    fakePorts(async () => { calls += 1; return { outcome: "succeeded" }; }),
    { now: () => LATER }
  );

  assert.deepEqual({ outcome: result.outcome, calls }, { outcome: "unconfirmed", calls: 0 });
});

test("running state and its grant use are one crash-safe unit when capacity remains", async (t) => {
  const { store, task } = fixture(t);
  let grant = createCapabilityGrant("capability-grant-1", task.id, {
    granter: "alice",
    actions: ["npm-publish"],
    irreversibilityCeiling: "irreversible",
    maxUses: 2
  }, NOW);
  store.saveCapabilityGrant(task.id, grant);
  let workflow = createReleaseWorkflow("release-workflow-1", task.id, {
    grantId: grant.id,
    source: SOURCE,
    plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
  }, NOW);
  workflow = startStep(workflow, "publish", LATER);
  store.saveReleaseWorkflow(task.id, workflow);
  grant = recordGrantUse(grant, LATER);
  store.saveCapabilityGrant(task.id, grant);
  let calls = 0;
  let queries = 0;

  // The use was committed before the crash, but a reservation is not
  // effect-disposition evidence: the engine still queries authoritatively.
  // The port proves the effect absent, so the recognized use makes the
  // single re-attempt free rather than a second charge.
  const result = await runReleaseWorkflow(
    store,
    task.id,
    workflow.id,
    {
      executeStep: async () => { calls += 1; return { outcome: "succeeded" }; },
      queryStepEffect: async () => { queries += 1; return { state: "absent" }; }
    },
    { now: () => LATER }
  );

  assert.deepEqual({
    outcome: result.outcome,
    calls,
    queries,
    usesUsed: store.getCapabilityGrant(task.id, grant.id).usesUsed
  }, { outcome: "succeeded", calls: 1, queries: 1, usesUsed: 1 });
});

test("FileTaskStore rejects a stale second maxUses consumption", (t) => {
  const { store, task } = fixture(t);
  const grant = createCapabilityGrant("capability-grant-1", task.id, {
    granter: "alice",
    actions: ["npm-publish"],
    irreversibilityCeiling: "irreversible",
    maxUses: 1
  }, NOW);
  store.saveCapabilityGrant(task.id, grant);
  const staleA = store.getCapabilityGrant(task.id, grant.id);
  const staleB = store.getCapabilityGrant(task.id, grant.id);

  store.saveCapabilityGrant(task.id, recordGrantUse(staleA, LATER));
  assert.throws(
    () => store.saveCapabilityGrant(task.id, recordGrantUse(staleB, LATER)),
    /concurrent|stale|exhausted|overwritten/i
  );
});

test("two workflows cannot concurrently spend the same maxUses slot", async (t) => {
  const { root, store, task } = fixture(t);
  const barrier = mkdtempSync(join(tmpdir(), "yui-task15-round8-barrier-"));
  t.after(() => rmSync(barrier, { recursive: true, force: true }));
  const grant = createCapabilityGrant("capability-grant-1", task.id, {
    granter: "alice",
    actions: ["npm-publish"],
    irreversibilityCeiling: "irreversible",
    maxUses: 1
  }, NOW);
  store.saveCapabilityGrant(task.id, grant);
  for (const workflowId of ["release-workflow-1", "release-workflow-2"]) {
    store.saveReleaseWorkflow(task.id, createReleaseWorkflow(workflowId, task.id, {
      grantId: grant.id,
      source: SOURCE,
      plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
    }, NOW));
  }
  const worker = new URL("./task15-round8-concurrent-worker.mjs", import.meta.url);

  const runs = await Promise.all([
    "release-workflow-1",
    "release-workflow-2"
  ].map((workflowId) => execFileAsync(process.execPath, [
    worker.pathname,
    root,
    task.id,
    workflowId,
    barrier
  ])));
  const effects = runs
    .map(({ stdout }) => JSON.parse(stdout.trim()).effects)
    .reduce((sum, value) => sum + value, 0);

  assert.deepEqual({
    effects,
    usesUsed: new FileTaskStore(root).getCapabilityGrant(task.id, grant.id).usesUsed
  }, { effects: 1, usesUsed: 1 });
});

test("cli-update checks the frozen version before mutating the live install", async () => {
  let activated = 0;
  let verified = 0;
  const ports = createReleaseWorkflowPorts({
    home: "/isolated/home",
    projectStore: {},
    updatePorts: {
      stage: () => ({ binaryPath: "/stage/yui", version: "9.9.9" }),
      preflight: () => ({ status: "already-current" }),
      activateStorage: () => ({ status: "already-current" }),
      activateBinary: () => { activated += 1; },
      verify: () => { verified += 1; },
      probeStorage: () => ({ switched: false, schemaCurrent: true }),
      cleanup: () => {}
    },
    runCommand: async () => ({ code: 0, stdout: "", stderr: "" })
  });

  const effect = await ports.executeStep({
    step: {
      id: "update",
      kind: "cli-update",
      idempotencyKey: "task-1/release-workflow-1/update",
      params: { version: "1.2.3" }
    },
    idempotencyKey: "task-1/release-workflow-1/update",
    source: SOURCE,
    params: { version: "1.2.3" }
  });

  assert.deepEqual({ outcome: effect.outcome, activated, verified }, {
    outcome: "failed",
    activated: 0,
    verified: 0
  });
});

test("repository scope authenticates the checkout before version-tag pushes", async () => {
  // Round-9: the engine no longer blanket-rejects a repo-scoped version-tag's
  // repositoryPath (that made the step impossible). The path is now required
  // and the adapter attests its origin against the bound source — host, owner,
  // and repository — before any local tag or push. A foreign host fails closed.
  const fx = memoryFixture({
    grant: { scope: { repositories: [{ owner: "acme", name: "widget" }] } },
    plan: [{
      id: "tag",
      kind: "version-tag",
      irreversibility: "irreversible",
      params: { tag: "v1.2.3", repositoryPath: "/foreign/repository" }
    }]
  });
  const calls = [];
  const ports = createReleaseWorkflowPorts({
    home: "/isolated/home",
    updatePorts: {},
    projectStore: {},
    runCommand: async (command, args, cwd) => {
      calls.push({ command, args: [...args], cwd });
      if (command === "git" && args[0] === "remote") {
        return { code: 0, stdout: "git@evil.example:acme/widget.git\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    }
  });

  const result = await runReleaseWorkflow(
    fx.store,
    "task-1",
    "release-workflow-1",
    ports,
    { now: () => NOW }
  );

  assert.deepEqual({
    outcome: result.outcome,
    calls: calls.length,
    tagged: calls.some((call) => call.args[0] === "tag"),
    pushed: calls.some((call) => call.args[0] === "push")
  }, {
    outcome: "failed",
    calls: 1,
    tagged: false,
    pushed: false
  });
});

test("npm-publish requires and authenticates a frozen artifact before package scope passes", async () => {
  const fx = memoryFixture({
    grant: { scope: { packages: ["@acme/widget"] } },
    plan: [{
      id: "publish",
      kind: "npm-publish",
      irreversibility: "irreversible",
      params: {
        package: "@acme/widget",
        version: "1.2.3",
        tarball: "/tmp/unfrozen-foreign-package.tgz"
      }
    }]
  });
  const calls = [];
  const ports = createReleaseWorkflowPorts({
    home: "/isolated/home",
    updatePorts: {},
    projectStore: {},
    runCommand: async (command, args, cwd) => {
      calls.push({ command, args: [...args], cwd });
      return { code: 0, stdout: "+ @foreign/package@8.8.8\n", stderr: "" };
    }
  });

  const result = await runReleaseWorkflow(
    fx.store,
    "task-1",
    "release-workflow-1",
    ports,
    { now: () => NOW }
  );

  assert.deepEqual({ outcome: result.outcome, calls: calls.length }, {
    outcome: "unauthorized",
    calls: 0
  });
});

test("the real adapter deduplicates repeated executeStep calls by idempotency key", async (t) => {
  // A writable Home: the dedup record must persist, not be swallowed.
  const home = mkdtempSync(join(tmpdir(), "yui-task15-round8-dedupe-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let calls = 0;
  const ports = createReleaseWorkflowPorts({
    home,
    updatePorts: {},
    projectStore: {},
    runCommand: async () => {
      calls += 1;
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  const input = {
    step: {
      id: "verify",
      kind: "post-verify",
      idempotencyKey: "task-1/release-workflow-1/verify",
      params: { command: "release-side-effect" }
    },
    idempotencyKey: "task-1/release-workflow-1/verify",
    source: SOURCE,
    params: { command: "release-side-effect" }
  };

  await ports.executeStep(input);
  await ports.executeStep(input);

  assert.equal(calls, 1);
});

test("version-tag converges after an uncertain push is authoritatively absent", async (t) => {
  // A writable Home so the converged success can persist its dedup record.
  const home = mkdtempSync(join(tmpdir(), "yui-task15-round8-converge-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fx = memoryFixture({
    plan: [{
      id: "tag",
      kind: "version-tag",
      irreversibility: "irreversible",
      params: { tag: "v1.2.3", repositoryPath: "/isolated/repository" }
    }]
  });
  let tagCalls = 0;
  let pushCalls = 0;
  let tagCreated = false;
  const ports = createReleaseWorkflowPorts({
    home,
    updatePorts: {},
    projectStore: {},
    runCommand: async (command, args) => {
      if (command === "git" && args[0] === "remote") {
        return { code: 0, stdout: "git@github.com:acme/widget.git\n", stderr: "" };
      }
      if (command === "git" && args[0] === "rev-parse") {
        return tagCreated
          ? { code: 0, stdout: COMMIT + "\n", stderr: "" }
          : { code: 1, stdout: "", stderr: "no such tag" };
      }
      if (command === "git" && args[0] === "tag") {
        tagCalls += 1;
        tagCreated = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "push") {
        pushCalls += 1;
        return pushCalls === 1
          ? { code: 1, stdout: "", stderr: "network timed out before remote accepted the push" }
          : { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "ls-remote") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    }
  });

  const first = await runReleaseWorkflow(
    fx.store,
    "task-1",
    "release-workflow-1",
    ports,
    { now: () => NOW }
  );
  const resumed = await runReleaseWorkflow(
    fx.store,
    "task-1",
    "release-workflow-1",
    ports,
    { now: () => LATER }
  );

  assert.deepEqual({
    first: first.outcome,
    resumed: resumed.outcome,
    tagCalls,
    pushCalls
  }, {
    first: "unknown",
    resumed: "succeeded",
    tagCalls: 1,
    pushCalls: 2
  });
});

test("PR reuse proves the head commit equals the frozen source", async () => {
  const otherCommit = "f".repeat(40);
  const calls = [];
  const ports = createReleaseWorkflowPorts({
    home: "/isolated/home",
    updatePorts: {},
    projectStore: {},
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        return { code: 0, stdout: JSON.stringify({ number: 42, headRefOid: otherCommit }) + "\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    }
  });

  const effect = await ports.executeStep({
    step: {
      id: "pr",
      kind: "pr-create-or-reuse",
      idempotencyKey: "task-1/release-workflow-1/pr",
      params: { head: "release-branch" }
    },
    idempotencyKey: "task-1/release-workflow-1/pr",
    source: SOURCE,
    params: { head: "release-branch" }
  });

  assert.equal(effect.outcome, "failed");
  assert.ok(calls.some((call) => call.join(" ").includes("headRefOid")), "the lookup requests the head object id");
});

test("grant revocation and its immutable audit event commit atomically", (t) => {
  const { store, task, operator } = fixture(t);
  runTaskCommand([
    "grant", "issue", task.id,
    "--action", "npm-publish",
    "--irreversibility-ceiling", "irreversible"
  ], store, { now: () => NOW, environment: operator.environment });
  store.saveEvent = () => { throw new Error("audit persistence failed"); };

  assert.throws(() => runTaskCommand([
    "grant", "revoke", task.id, "capability-grant-1"
  ], store, { now: () => LATER, environment: operator.environment }), /audit persistence failed/);

  assert.equal(store.getCapabilityGrant(task.id, "capability-grant-1").revokedAt, undefined);
});

test("a workflow effect cannot start without its immutable run audit", async (t) => {
  const { store, task, operator } = fixture(t);
  runTaskCommand([
    "grant", "issue", task.id,
    "--action", "post-verify"
  ], store, { now: () => NOW, environment: operator.environment });
  const workflow = runTaskCommand([
    "workflow", "create", task.id,
    "--grant", "capability-grant-1",
    "--source-repo", "acme/widget",
    "--source-commit", COMMIT,
    "--step", "verify:post-verify",
    "--step-param", "verify:command=verify-release"
  ], store, { now: () => NOW }).data;
  let executed = 0;
  store.saveEvent = () => { throw new Error("audit persistence failed"); };

  await assert.rejects(() => runWorkflowCommandAsync([
    "run", task.id, workflow.id
  ], store, {
    now: () => LATER,
    ports: fakePorts(async () => { executed += 1; return { outcome: "succeeded" }; })
  }), /audit persistence failed/);

  // The run-intent event commits BEFORE the engine runs, so an audit failure
  // blocks the effect entirely: the step never leaves pending, the external
  // system is never called, and no run event is committed.
  const persisted = store.getReleaseWorkflow(task.id, workflow.id);
  assert.equal(persisted.steps.verify.status, "pending");
  assert.equal(executed, 0);
  assert.equal(
    store.listEvents(task.id)
      .filter((event) => event.type.startsWith("release-workflow.run")).length,
    0
  );
});

test("a Home-scoped grant cannot replace another Home's Controller", async () => {
  const fx = memoryFixture({
    grant: { scope: { homePath: "/authorized/home" } },
    plan: [{ id: "replace", kind: "controller-replace", irreversibility: "irreversible" }]
  });
  let calls = 0;

  const result = await runReleaseWorkflow(
    fx.store,
    "task-1",
    "release-workflow-1",
    fakePorts(async () => { calls += 1; return { outcome: "succeeded" }; }, "/forbidden/home"),
    { now: () => NOW }
  );

  assert.deepEqual({ outcome: result.outcome, calls }, { outcome: "unauthorized", calls: 0 });
});

test("a package-scoped grant cannot execute another package in fresh-install smoke", async () => {
  const fx = memoryFixture({
    grant: { scope: { packages: ["@acme/allowed"] } },
    plan: [{
      id: "smoke",
      kind: "fresh-install-smoke",
      params: { package: "@foreign/code", version: "9.9.9" }
    }]
  });
  let calls = 0;

  const result = await runReleaseWorkflow(
    fx.store,
    "task-1",
    "release-workflow-1",
    fakePorts(async () => { calls += 1; return { outcome: "succeeded" }; }),
    { now: () => NOW }
  );

  assert.deepEqual({ outcome: result.outcome, calls }, { outcome: "unauthorized", calls: 0 });
});
// ---------------------------------------------------------------------------
// P1#3: cli-update validates the frozen version BEFORE activation
// ---------------------------------------------------------------------------

test("round8 P1#3: a staged version mismatch fails before any activation", async () => {
  const { ports, calls } = updatePortsFake({
    stage: () => {
      calls.push("stage");
      return { binaryPath: "/stage/yui", version: "9.9.9" };
    }
  });
  const adapter = realAdapter(async () => ({ code: 0, stdout: "", stderr: "" }), {
    updatePorts: ports
  });

  const effect = await adapter.executeStep({
    step: { id: "update", kind: "cli-update", idempotencyKey: "task-1/wf/update" },
    idempotencyKey: "task-1/wf/update",
    source: SOURCE,
    params: { version: "1.2.3" }
  });

  assert.equal(effect.outcome, "failed");
  assert.ok(effect.error.includes("9.9.9") && effect.error.includes("1.2.3"));
  assert.deepEqual(calls, ["stage", "cleanup"], "only staging ran; the active CLI is untouched");
});

test("round8 P1#3: the matching frozen version activates through the inspected stage", async () => {
  const { ports, calls } = updatePortsFake();
  const adapter = realAdapter(async () => ({ code: 0, stdout: "", stderr: "" }), {
    updatePorts: ports
  });

  const effect = await adapter.executeStep({
    step: { id: "update", kind: "cli-update", idempotencyKey: "task-1/wf/update" },
    idempotencyKey: "task-1/wf/update",
    source: SOURCE,
    params: { version: "1.2.3" }
  });

  assert.equal(effect.outcome, "succeeded");
  assert.equal(effect.externalId, "1.2.3");
  assert.deepEqual(calls, ["stage", "preflight", "activateBinary", "verify", "cleanup"]);
});

// ---------------------------------------------------------------------------
// P1#4: version-tag validates the checkout's origin before any effect
// ---------------------------------------------------------------------------

test("round8 P1#4: version-tag refuses a checkout whose origin is not the granted repository", async () => {
  const calls = [];
  const adapter = realAdapter(async (command, args) => {
    calls.push({ command, args: [...args] });
    return { code: 0, stdout: "git@github.com:evil/widget.git\n", stderr: "" };
  });

  const effect = await adapter.executeStep({
    step: { id: "tag", kind: "version-tag", idempotencyKey: "task-1/wf/tag" },
    idempotencyKey: "task-1/wf/tag",
    source: SOURCE,
    params: { tag: "v1.2.3", repositoryPath: "/projects/evil-widget" }
  });

  assert.equal(effect.outcome, "failed");
  assert.ok(effect.error.includes("evil/widget"));
  assert.ok(!calls.some((call) => call.args[0] === "tag"), "no tag created");
  assert.ok(!calls.some((call) => call.args[0] === "push"), "no push attempted");
});

test("round8 P1#4: version-tag accepts the granted repository over https and ssh", async () => {
  for (const remote of [
    "https://github.com/acme/widget.git",
    "ssh://git@github.com/acme/widget.git",
    "git@github.com:acme/widget.git"
  ]) {
    const calls = [];
    const adapter = realAdapter(async (command, args) => {
      calls.push({ command, args: [...args] });
      if (args[0] === "remote") return { code: 0, stdout: `${remote}\n`, stderr: "" };
      if (args[0] === "rev-parse") return { code: 1, stdout: "", stderr: "no tag" };
      if (args[0] === "tag") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "push") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    });

    const effect = await adapter.executeStep({
      step: { id: "tag", kind: "version-tag", idempotencyKey: `task-1/wf/tag-${remote.length}` },
      idempotencyKey: `task-1/wf/tag-${remote.length}`,
      source: SOURCE,
      params: { tag: "v1.2.3", repositoryPath: "/projects/acme-widget" }
    });

    assert.equal(effect.outcome, "succeeded", `remote ${remote} must be accepted`);
  }
});

// ---------------------------------------------------------------------------
// P1#5: npm-publish inspects the tarball manifest and the publish result
// ---------------------------------------------------------------------------

function manifestResponse(manifest) {
  return { code: 0, stdout: `${JSON.stringify(manifest)}\n`, stderr: "" };
}

test("round8 P1#5: npm-publish refuses a tarball whose manifest names another package", async () => {
  let publishes = 0;
  const adapter = realAdapter(async (command, args) => {
    if (args[0] === "publish") publishes += 1;
    if (command === "tar") return manifestResponse({ name: "@other/widget", version: "1.2.3" });
    return { code: 0, stdout: "+ @other/widget@1.2.3\n", stderr: "" };
  });

  const effect = await adapter.executeStep({
    step: { id: "publish", kind: "npm-publish", idempotencyKey: "task-1/wf/publish" },
    idempotencyKey: "task-1/wf/publish",
    source: SOURCE,
    params: { package: "@acme/widget", version: "1.2.3", tarball: "/tmp/widget-1.2.3.tgz" }
  });

  assert.equal(effect.outcome, "failed");
  assert.ok(effect.error.includes("@other/widget"));
  assert.equal(publishes, 0, "no publish attempted");
});

test("round8 P1#5: npm-publish refuses a tarball whose manifest names another version", async () => {
  let publishes = 0;
  const adapter = realAdapter(async (command, args) => {
    if (args[0] === "publish") publishes += 1;
    if (command === "tar") return manifestResponse({ name: "@acme/widget", version: "9.9.9" });
    return { code: 0, stdout: "+ @acme/widget@9.9.9\n", stderr: "" };
  });

  const effect = await adapter.executeStep({
    step: { id: "publish", kind: "npm-publish", idempotencyKey: "task-1/wf/publish" },
    idempotencyKey: "task-1/wf/publish",
    source: SOURCE,
    params: { package: "@acme/widget", version: "1.2.3", tarball: "/tmp/widget-1.2.3.tgz" }
  });

  assert.equal(effect.outcome, "failed");
  assert.ok(effect.error.includes("9.9.9") && effect.error.includes("1.2.3"));
  assert.equal(publishes, 0, "no publish attempted");
});

test("round8 P1#5: npm-publish refuses an unreadable tarball manifest", async () => {
  let publishes = 0;
  const adapter = realAdapter(async (command, args) => {
    if (args[0] === "publish") publishes += 1;
    if (command === "tar") return { code: 1, stdout: "", stderr: "tar: not a gzip archive" };
    return { code: 0, stdout: "+ @acme/widget@1.2.3\n", stderr: "" };
  });

  const effect = await adapter.executeStep({
    step: { id: "publish", kind: "npm-publish", idempotencyKey: "task-1/wf/publish" },
    idempotencyKey: "task-1/wf/publish",
    source: SOURCE,
    params: { package: "@acme/widget", version: "1.2.3", tarball: "/tmp/widget-1.2.3.tgz" }
  });

  assert.equal(effect.outcome, "failed");
  assert.ok(effect.error.includes("manifest"));
  assert.equal(publishes, 0, "no publish attempted");
});

test("round8 P1#5: npm-publish succeeds only when the publish result matches the frozen declaration", async () => {
  const adapter = realAdapter(async (command, args) => {
    if (command === "tar") return manifestResponse({ name: "@acme/widget", version: "1.2.3" });
    return { code: 0, stdout: "npm notice\n+ @acme/widget@1.2.3\n", stderr: "" };
  });

  const effect = await adapter.executeStep({
    step: { id: "publish", kind: "npm-publish", idempotencyKey: "task-1/wf/publish" },
    idempotencyKey: "task-1/wf/publish",
    source: SOURCE,
    params: { package: "@acme/widget", version: "1.2.3", tarball: "/tmp/widget-1.2.3.tgz" }
  });

  assert.equal(effect.outcome, "succeeded");
  assert.equal(effect.externalId, "1.2.3");
});

test("round8 P1#5: a publish result naming another version does not satisfy the step", async () => {
  const adapter = realAdapter(async (command, args) => {
    if (command === "tar") return manifestResponse({ name: "@acme/widget", version: "1.2.3" });
    return { code: 0, stdout: "+ @acme/widget@9.9.9\n", stderr: "" };
  });

  const effect = await adapter.executeStep({
    step: { id: "publish", kind: "npm-publish", idempotencyKey: "task-1/wf/publish" },
    idempotencyKey: "task-1/wf/publish",
    source: SOURCE,
    params: { package: "@acme/widget", version: "1.2.3", tarball: "/tmp/widget-1.2.3.tgz" }
  });

  assert.equal(effect.outcome, "failed");
  assert.equal(effect.externalIdentity.kind, "npm-package");
  assert.equal(effect.externalIdentity.value, "@acme/widget@1.2.3");
});

test("round8 P1#5: an unparseable publish result is uncertain, not a success", async () => {
  const adapter = realAdapter(async (command, args) => {
    if (command === "tar") return manifestResponse({ name: "@acme/widget", version: "1.2.3" });
    return { code: 0, stdout: "", stderr: "" };
  });

  const effect = await adapter.executeStep({
    step: { id: "publish", kind: "npm-publish", idempotencyKey: "task-1/wf/publish" },
    idempotencyKey: "task-1/wf/publish",
    source: SOURCE,
    params: { package: "@acme/widget", version: "1.2.3", tarball: "/tmp/widget-1.2.3.tgz" }
  });

  assert.equal(effect.outcome, "timeout");
  assert.equal(effect.externalIdentity.kind, "npm-package");
  assert.equal(effect.externalIdentity.value, "@acme/widget@1.2.3");
});

// ---------------------------------------------------------------------------
// P2#6: durable adapter-level idempotency
// ---------------------------------------------------------------------------

test("round8 P2#6: a second process replays the recorded effect instead of a second execution", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-task15-round8-idem-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const runCommand = async () => {
    calls += 1;
    return { code: 0, stdout: "ok\n", stderr: "" };
  };
  const input = {
    step: { id: "verify", kind: "post-verify", idempotencyKey: "task-1/wf/verify" },
    idempotencyKey: "task-1/wf/verify",
    source: SOURCE,
    params: { command: "echo ok" }
  };

  const first = createReleaseWorkflowPorts({
    home: root,
    updatePorts: {},
    projectStore: {},
    runCommand
  });
  const firstEffect = await first.executeStep(input);
  // A fresh process: a new adapter over the same durable Home.
  const second = createReleaseWorkflowPorts({
    home: root,
    updatePorts: {},
    projectStore: {},
    runCommand
  });
  const secondEffect = await second.executeStep(input);

  assert.equal(firstEffect.outcome, "succeeded");
  assert.equal(secondEffect.outcome, "succeeded");
  assert.equal(calls, 1, "the shell command runs exactly once across processes");
  assert.ok(secondEffect.logs.some((line) => line.includes("idempotent")));
});

test("round8 P2#6: a failed effect is retried, not replayed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-task15-round8-idem-fail-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const runCommand = async () => {
    calls += 1;
    return calls === 1
      ? { code: 1, stdout: "", stderr: "transient" }
      : { code: 0, stdout: "ok\n", stderr: "" };
  };
  const input = {
    step: { id: "verify", kind: "post-verify", idempotencyKey: "task-1/wf/verify" },
    idempotencyKey: "task-1/wf/verify",
    source: SOURCE,
    params: { command: "echo ok" }
  };

  const adapter = createReleaseWorkflowPorts({
    home: root,
    updatePorts: {},
    projectStore: {},
    runCommand
  });
  const firstEffect = await adapter.executeStep(input);
  const secondEffect = await adapter.executeStep(input);

  assert.equal(firstEffect.outcome, "failed");
  assert.equal(secondEffect.outcome, "succeeded");
  assert.equal(calls, 2, "a failed effect is re-executed on retry");
});

// ---------------------------------------------------------------------------
// P2#8: version-tag recovery converges
// ---------------------------------------------------------------------------

test("round8 P2#8: recovery skips tag creation when the local tag names the frozen commit", async () => {
  const calls = [];
  const adapter = realAdapter(async (command, args) => {
    calls.push({ command, args: [...args] });
    if (args[0] === "remote") return { code: 0, stdout: "git@github.com:acme/widget.git\n", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${COMMIT}\n`, stderr: "" };
    if (args[0] === "push") return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  });

  const effect = await adapter.executeStep({
    step: { id: "tag", kind: "version-tag", idempotencyKey: "task-1/wf/tag" },
    idempotencyKey: "task-1/wf/tag",
    source: SOURCE,
    params: { tag: "v1.2.3", repositoryPath: "/projects/acme-widget" }
  });

  assert.equal(effect.outcome, "succeeded");
  assert.ok(!calls.some((call) => call.args[0] === "tag"), "no tag -a on recovery");
  assert.ok(calls.some((call) => call.args[0] === "push"), "the push is retried");
});

test("round8 P2#8: a local tag pointing elsewhere fails closed without pushing", async () => {
  const calls = [];
  const adapter = realAdapter(async (command, args) => {
    calls.push({ command, args: [...args] });
    if (args[0] === "remote") return { code: 0, stdout: "git@github.com:acme/widget.git\n", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: "ffffffffffffffffffffffffffffffffffffffff\n", stderr: "" };
    if (args[0] === "push") return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  });

  const effect = await adapter.executeStep({
    step: { id: "tag", kind: "version-tag", idempotencyKey: "task-1/wf/tag" },
    idempotencyKey: "task-1/wf/tag",
    source: SOURCE,
    params: { tag: "v1.2.3", repositoryPath: "/projects/acme-widget" }
  });

  assert.equal(effect.outcome, "failed");
  assert.ok(effect.error.includes("ffffffff"));
  assert.ok(!calls.some((call) => call.args[0] === "push"), "no push for a wrong local tag");
});

// ---------------------------------------------------------------------------
// P2#9: PR reuse requires the exact frozen head object id
// ---------------------------------------------------------------------------

test("round8 P2#9: a PR whose head is not the frozen commit is not reused", async () => {
  const calls = [];
  const adapter = realAdapter(async (command, args) => {
    calls.push({ command, args: [...args] });
    if (args[1] === "view") {
      return { code: 0, stdout: `${JSON.stringify({ number: 42, headRefOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" })}\n`, stderr: "" };
    }
    return { code: 0, stdout: "https://github.com/acme/widget/pull/42\n", stderr: "" };
  });

  const effect = await adapter.executeStep({
    step: { id: "pr", kind: "pr-create-or-reuse", idempotencyKey: "task-1/wf/pr" },
    idempotencyKey: "task-1/wf/pr",
    source: SOURCE,
    params: { head: "release-branch" }
  });

  assert.equal(effect.outcome, "failed");
  assert.ok(effect.error.includes("deadbeef") && effect.error.includes(COMMIT));
  assert.ok(!calls.some((call) => call.args[1] === "create"), "no PR created");
});

test("round8 P2#9: a PR whose head equals the frozen commit is reused", async () => {
  const calls = [];
  const adapter = realAdapter(async (command, args) => {
    calls.push({ command, args: [...args] });
    if (args[1] === "view") {
      return { code: 0, stdout: `${JSON.stringify({ number: 42, headRefOid: COMMIT })}\n`, stderr: "" };
    }
    return { code: 0, stdout: "https://github.com/acme/widget/pull/42\n", stderr: "" };
  });

  const effect = await adapter.executeStep({
    step: { id: "pr", kind: "pr-create-or-reuse", idempotencyKey: "task-1/wf/pr" },
    idempotencyKey: "task-1/wf/pr",
    source: SOURCE,
    params: { head: "release-branch" }
  });

  assert.equal(effect.outcome, "succeeded");
  assert.equal(effect.externalId, "pr:42");
  assert.ok(!calls.some((call) => call.args[1] === "create"), "no PR created");
});
