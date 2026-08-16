import assert from "node:assert/strict";
import test from "node:test";

// Round-9 ports-lane reproductions for frozen head 3cb450d. Every external
// effect is replaced by a deterministic fake command/port. These tests never
// contact GitHub, npm, a Controller, a real Project, or a user Home.
//
// P1: cli-update must be bound to a concrete frozen version — an unversioned
//     plan staged and activated a moving `latest`.
// P2: a repo-scoped version-tag must run through an attested checkout (the
//     engine blanket-rejected the required path), and the remote attestation
//     must compare the canonical host, not only the owner/name path.

import { createCapabilityGrant } from "../dist/grant/capabilityGrant.js";
import { createInMemoryReleaseIdempotencyStore } from "../dist/release/releaseIdempotencyStore.js";
import { createReleaseWorkflow } from "../dist/release/releaseWorkflow.js";
import { runReleaseWorkflow } from "../dist/release/releaseWorkflowEngine.js";
import { createReleaseWorkflowPorts } from "../dist/release/releaseWorkflowPorts.js";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SOURCE = Object.freeze({
  repository: { owner: "acme", name: "widget" },
  commit: COMMIT
});

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
    idempotencyStore: createInMemoryReleaseIdempotencyStore(),
    ...extra
  });
}

function updatePorts(overrides = {}) {
  const calls = [];
  const ports = {
    stage: (version) => {
      calls.push({ op: "stage", version });
      return { binaryPath: "/stage/yui", version: "1.2.3" };
    },
    preflight: () => {
      calls.push({ op: "preflight" });
      return { status: "already-current" };
    },
    activateStorage: () => {
      calls.push({ op: "activateStorage" });
      return { status: "already-current" };
    },
    activateBinary: () => { calls.push({ op: "activateBinary" }); },
    verify: () => { calls.push({ op: "verify" }); },
    probeStorage: () => ({ switched: false, schemaCurrent: true }),
    cleanup: () => { calls.push({ op: "cleanup" }); },
    ...overrides
  };
  return { ports, calls };
}

// ---------------------------------------------------------------------------
// P1: cli-update requires a concrete frozen version before grant consumption
// ---------------------------------------------------------------------------

test("round9 P1: cli-update without a frozen version is unauthorized before any grant use", async () => {
  const fx = memoryFixture({
    grant: { maxUses: 1 },
    plan: [{ id: "update", kind: "cli-update", irreversibility: "irreversible" }]
  });
  let calls = 0;

  const result = await runReleaseWorkflow(
    fx.store,
    "task-1",
    "release-workflow-1",
    fakePorts(async () => { calls += 1; return { outcome: "succeeded" }; }),
    { now: () => NOW }
  );

  assert.deepEqual({
    outcome: result.outcome,
    calls,
    usesUsed: fx.grant.usesUsed,
    status: fx.workflow.steps.update.status
  }, {
    outcome: "unauthorized",
    calls: 0,
    usesUsed: 0,
    status: "failed"
  });
});

test("round9 P1: cli-update with a moving version tag is unauthorized", async () => {
  const fx = memoryFixture({
    grant: { maxUses: 1 },
    plan: [{
      id: "update",
      kind: "cli-update",
      irreversibility: "irreversible",
      params: { version: "latest" }
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

  assert.deepEqual({ outcome: result.outcome, calls, usesUsed: fx.grant.usesUsed }, {
    outcome: "unauthorized",
    calls: 0,
    usesUsed: 0
  });
});

test("round9 P1: the adapter fails closed before staging when no version is given", async () => {
  const { ports, calls } = updatePorts();
  const adapter = realAdapter(async () => ({ code: 0, stdout: "", stderr: "" }), {
    updatePorts: ports
  });

  const effect = await adapter.executeStep({
    step: { id: "update", kind: "cli-update", idempotencyKey: "task-1/wf/update" },
    idempotencyKey: "task-1/wf/update",
    source: SOURCE,
    params: {}
  });

  assert.equal(effect.outcome, "failed");
  assert.ok(effect.error.includes("params.version"));
  assert.deepEqual(calls, [], "nothing staged or activated");
});

test("round9 P1: cli-update stages the exact frozen version, not latest", async () => {
  const { ports, calls } = updatePorts();
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
  assert.deepEqual(
    calls.filter((call) => call.op === "stage"),
    [{ op: "stage", version: "1.2.3" }],
    "the stage port receives the frozen version"
  );
});

// ---------------------------------------------------------------------------
// P2: version-tag checkout attestation
// ---------------------------------------------------------------------------

test("round9 P2: version-tag rejects a foreign-host remote with a matching owner/name", async () => {
  const calls = [];
  const adapter = realAdapter(async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "git" && args[0] === "remote") {
      return { code: 0, stdout: "git@evil.example:acme/widget.git\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  });

  const effect = await adapter.executeStep({
    step: { id: "tag", kind: "version-tag", idempotencyKey: "task-1/wf/tag" },
    idempotencyKey: "task-1/wf/tag",
    source: SOURCE,
    params: { tag: "v1.2.3", repositoryPath: "/projects/acme-widget" }
  });

  assert.equal(effect.outcome, "failed");
  assert.ok(effect.error.includes("evil.example"));
  assert.ok(!calls.some((call) => call.args[0] === "tag"), "no tag created");
  assert.ok(!calls.some((call) => call.args[0] === "push"), "no push attempted");
});

test("round9 P2: a repo-scoped version-tag with an attested checkout succeeds", async () => {
  const fx = memoryFixture({
    grant: { scope: { repositories: [{ owner: "acme", name: "widget" }] }, maxUses: 1 },
    plan: [{
      id: "tag",
      kind: "version-tag",
      irreversibility: "irreversible",
      params: { tag: "v1.2.3", repositoryPath: "/projects/acme-widget" }
    }]
  });
  const calls = [];
  const ports = realAdapter(async (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    if (command === "git" && args[0] === "remote") {
      return { code: 0, stdout: "git@github.com:acme/widget.git\n", stderr: "" };
    }
    if (command === "git" && args[0] === "rev-parse") {
      return { code: 1, stdout: "", stderr: "no such tag" };
    }
    if (command === "git" && args[0] === "tag") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "git" && args[0] === "push") {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected command" };
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
    usesUsed: fx.grant.usesUsed,
    tagged: calls.some((call) => call.args[0] === "tag"),
    pushed: calls.some((call) => call.args[0] === "push"),
    checkoutCwd: calls.every((call) => call.cwd === "/projects/acme-widget")
  }, {
    outcome: "succeeded",
    usesUsed: 1,
    tagged: true,
    pushed: true,
    checkoutCwd: true
  });
});

test("round9 P2: a repo-scoped version-tag without a checkout path is unauthorized", async () => {
  const fx = memoryFixture({
    grant: { scope: { repositories: [{ owner: "acme", name: "widget" }] } },
    plan: [{ id: "tag", kind: "version-tag", irreversibility: "irreversible" }]
  });
  let calls = 0;

  const result = await runReleaseWorkflow(
    fx.store,
    "task-1",
    "release-workflow-1",
    fakePorts(async () => { calls += 1; return { outcome: "succeeded" }; }),
    { now: () => NOW }
  );

  assert.deepEqual({ outcome: result.outcome, calls }, {
    outcome: "unauthorized",
    calls: 0
  });
});

test("round9 P2: tag recovery never confirms through a foreign-host origin", async () => {
  const calls = [];
  const adapter = realAdapter(async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "git" && args[0] === "remote") {
      return { code: 0, stdout: "git@evil.example:acme/widget.git\n", stderr: "" };
    }
    // A ls-remote that would confirm the tag — must never be trusted.
    return {
      code: 0,
      stdout: `${COMMIT}\trefs/tags/v1.2.3\n`,
      stderr: ""
    };
  });

  const query = await adapter.queryStepEffect({
    step: {
      id: "tag",
      kind: "version-tag",
      idempotencyKey: "task-1/wf/tag",
      params: { tag: "v1.2.3", repositoryPath: "/projects/acme-widget" }
    },
    source: SOURCE,
    externalIdentity: { kind: "git-tag", value: "v1.2.3" }
  });

  assert.equal(query.state, "unknown");
  assert.ok(!calls.some((call) => call.args[0] === "ls-remote"), "no untrusted ls-remote answer");
});
