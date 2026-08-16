import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

// Reviewer-lane diagnostics for the frozen Task-final head. All external
// effects are fakes; these tests do not contact npm, GitHub, a Controller, or a
// real Project/Home.

import { createConfiguredAgent } from "../dist/agent/agent.js";
import { runTaskCommand } from "../dist/commands/taskCommands.js";
import { createCapabilityGrant } from "../dist/grant/capabilityGrant.js";
import { createReleaseWorkflow } from "../dist/release/releaseWorkflow.js";
import { runReleaseWorkflow } from "../dist/release/releaseWorkflowEngine.js";
import { createReleaseWorkflowPorts } from "../dist/release/releaseWorkflowPorts.js";
import { createInMemoryReleaseIdempotencyStore } from "../dist/release/releaseIdempotencyStore.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { installOperatorSession } from "../test/helpers/operatorSession.js";

const NOW = new Date("2026-08-14T04:00:00.000Z");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SOURCE = Object.freeze({
  repository: { owner: "acme", name: "widget" },
  commit: COMMIT
});

function taskFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-task15-round5-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(agent);
  });
  const task = runTaskCommand(["create", "Task 15 round 5 diagnostic"], store, {
    now: () => NOW
  }).data.task;
  const operator = installOperatorSession(store, agent, NOW);
  return { root, store, task, operator };
}

function persistWorkflow(store, taskId, {
  plan,
  grant: grantInput = {},
  source = SOURCE
}) {
  const grant = createCapabilityGrant("capability-grant-1", taskId, {
    granter: "alice",
    actions: [...new Set(plan.map(({ kind }) => kind))],
    irreversibilityCeiling: "irreversible",
    ...grantInput
  }, NOW);
  store.saveCapabilityGrant(taskId, grant);
  const workflow = createReleaseWorkflow("release-workflow-1", taskId, {
    grantId: grant.id,
    source,
    plan
  }, NOW);
  store.saveReleaseWorkflow(taskId, workflow);
  return { grant, workflow };
}

function inMemoryWorkflow({ plan, grant: grantInput = {}, source = SOURCE }) {
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
    }
  };
}

function fakePorts(executeStep) {
  return {
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
    // In-memory store: the fake /isolated/home must never accumulate durable
    // state across test processes.
    idempotencyStore: createInMemoryReleaseIdempotencyStore(),
    ...extra
  });
}

test("managed Task authority does not become unmanaged when ambient YUI_RUN_ID is absent", (t) => {
  const { store, task } = taskFixture(t);

  assert.throws(() => runTaskCommand([
    "grant", "issue", task.id,
    "--action", "npm-publish",
    "--irreversibility-ceiling", "irreversible"
  ], store, {
    now: () => NOW,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "reviewer"
    }
  }), /managed agent|operator|user authorization/i);
  assert.equal(store.listCapabilityGrants(task.id).length, 0);
});

test("FileTaskStore crash recovery never resubmits an irreversible effect with no identity", async (t) => {
  const { store, task } = taskFixture(t);
  const { workflow } = persistWorkflow(store, task.id, {
    plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
  });
  let calls = 0;
  const ports = fakePorts(async () => {
    calls += 1;
    if (calls === 1) throw new Error("process disappeared after registry accepted upload");
    return { outcome: "succeeded" };
  });

  await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: () => NOW }).catch(() => {});
  const persistedAfterCrash = store.getReleaseWorkflow(task.id, workflow.id).steps.publish.status;
  const resumed = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: () => NOW });

  assert.deepEqual(
    { calls, persistedAfterCrash, resumed: resumed.outcome },
    { calls: 1, persistedAfterCrash: "unknown", resumed: "unconfirmed" }
  );
});

test("running state and maxUses consumption cannot be split by a crash", async (t) => {
  const { store, task } = taskFixture(t);
  const { workflow } = persistWorkflow(store, task.id, {
    grant: { maxUses: 1 },
    plan: [
      { id: "first", kind: "npm-publish", irreversibility: "irreversible" },
      { id: "second", kind: "npm-publish", irreversibility: "irreversible" }
    ]
  });
  const crashStore = {
    getReleaseWorkflow: (...args) => store.getReleaseWorkflow(...args),
    saveReleaseWorkflow: (...args) => store.saveReleaseWorkflow(...args),
    getCapabilityGrant: (...args) => store.getCapabilityGrant(...args),
    saveCapabilityGrant: () => { throw new Error("crash before grant-use commit"); }
  };
  let calls = 0;
  const ports = fakePorts(async () => {
    calls += 1;
    return { outcome: "succeeded" };
  });

  await runReleaseWorkflow(crashStore, task.id, workflow.id, ports, { now: () => NOW }).catch(() => {});
  const resumed = await runReleaseWorkflow(store, task.id, workflow.id, ports, { now: () => NOW });

  assert.deepEqual(
    { calls, outcome: resumed.outcome, usesUsed: store.getCapabilityGrant(task.id, "capability-grant-1").usesUsed },
    { calls: 0, outcome: "unconfirmed", usesUsed: 0 }
  );
});

test("independent engine processes cannot submit the same workflow effect concurrently", async (t) => {
  const { root, store, task } = taskFixture(t);
  const { workflow } = persistWorkflow(store, task.id, {
    plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
  });
  const engineUrl = new URL("../dist/release/releaseWorkflowEngine.js", import.meta.url);
  const [engineA, engineB] = await Promise.all([
    import(`${engineUrl.href}?round5-lane-a`),
    import(`${engineUrl.href}?round5-lane-b`)
  ]);
  const storeA = new FileTaskStore(root);
  const storeB = new FileTaskStore(root);
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ports = fakePorts(async () => {
    calls += 1;
    await gate;
    return { outcome: "succeeded" };
  });

  const first = engineA.runReleaseWorkflow(storeA, task.id, workflow.id, ports, { now: () => NOW });
  for (let turn = 0; calls === 0 && turn < 20; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(calls, 1, "the first process must reach its external effect");
  const second = engineB.runReleaseWorkflow(storeB, task.id, workflow.id, ports, { now: () => NOW });
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  await Promise.allSettled([first, second]);

  assert.equal(calls, 1);
});

test("package scope cannot be bypassed by omitting params.package", async () => {
  const fx = inMemoryWorkflow({
    source: {
      repository: { owner: "forbidden", name: "package" },
      commit: COMMIT
    },
    grant: { scope: { packages: ["@acme/allowed"] } },
    plan: [{
      id: "publish",
      kind: "npm-publish",
      irreversibility: "irreversible",
      params: { tarball: "/tmp/package.tgz", version: "1.2.3" }
    }]
  });
  let calls = 0;
  const result = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", fakePorts(async () => {
    calls += 1;
    return { outcome: "succeeded" };
  }), { now: () => NOW });

  assert.deepEqual({ outcome: result.outcome, calls }, { outcome: "unauthorized", calls: 0 });
});

test("project scope is enforced before project-migrate", async () => {
  const fx = inMemoryWorkflow({
    grant: { scope: { projectIds: ["project-allowed"] } },
    plan: [{
      id: "migrate",
      kind: "project-migrate",
      irreversibility: "irreversible",
      params: { project: "project-forbidden" }
    }]
  });
  let calls = 0;
  const result = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", fakePorts(async () => {
    calls += 1;
    return { outcome: "succeeded" };
  }), { now: () => NOW });

  assert.deepEqual({ outcome: result.outcome, calls }, { outcome: "unauthorized", calls: 0 });
});

test("a none-ceiling grant cannot authorize cli-update", async () => {
  const fx = inMemoryWorkflow({
    grant: { irreversibilityCeiling: "none" },
    plan: [{ id: "update", kind: "cli-update" }]
  });
  let calls = 0;
  const result = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", fakePorts(async () => {
    calls += 1;
    return { outcome: "succeeded" };
  }), { now: () => NOW });

  assert.deepEqual({ outcome: result.outcome, calls }, { outcome: "unauthorized", calls: 0 });
});

test("a Home-scoped grant cannot update another Home", async () => {
  const fx = inMemoryWorkflow({
    grant: { scope: { homePath: "/authorized/home" } },
    plan: [{
      id: "update",
      kind: "cli-update",
      irreversibility: "irreversible",
      params: { version: "1.2.3" }
    }]
  });
  let stages = 0;
  const ports = realAdapter(async () => ({ code: 0, stdout: "", stderr: "" }), {
    home: "/forbidden/home",
    updatePorts: {
      stage: () => {
        stages += 1;
        return { binaryPath: "/stage/yui", version: "1.2.3" };
      },
      preflight: () => ({ status: "already-current" }),
      activateStorage: () => ({ status: "already-current" }),
      activateBinary: () => {},
      verify: () => {},
      probeStorage: () => ({ switched: false, schemaCurrent: true }),
      cleanup: () => {}
    }
  });
  const result = await runReleaseWorkflow(fx.store, "task-1", "release-workflow-1", ports, {
    now: () => NOW
  });

  assert.deepEqual({ outcome: result.outcome, stages }, { outcome: "unauthorized", stages: 0 });
});

test("npm publish verifies the frozen artifact bytes, not only its basename", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-task15-artifact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tarball = join(root, "widget-1.2.3.tgz");
  writeFileSync(tarball, "tampered bytes");
  const integrity = `sha512-${createHash("sha512").update("frozen bytes").digest("base64")}`;
  let calls = 0;
  const ports = realAdapter(async () => {
    calls += 1;
    return { code: 0, stdout: "+ @acme/widget@1.2.3\n", stderr: "" };
  });

  const effect = await ports.executeStep({
    step: { id: "publish", kind: "npm-publish", idempotencyKey: "task-1/workflow-1/publish" },
    idempotencyKey: "task-1/workflow-1/publish",
    source: {
      ...SOURCE,
      artifact: { name: basename(tarball), integrity }
    },
    params: { package: "@acme/widget", version: "1.2.3", tarball }
  });

  assert.deepEqual({ outcome: effect.outcome, calls }, { outcome: "failed", calls: 0 });
});

test("npm recovery without an exact version cannot confirm an unrelated latest version", async () => {
  const ports = realAdapter(async () => ({ code: 0, stdout: "9.9.9\n", stderr: "" }));
  const query = await ports.queryStepEffect({
    step: {
      id: "publish",
      kind: "npm-publish",
      idempotencyKey: "task-1/workflow-1/publish",
      params: { package: "@acme/widget" },
      irreversibility: "irreversible"
    },
    source: SOURCE,
    externalIdentity: { kind: "npm-package", value: "@acme/widget" }
  });

  assert.equal(query.state, "unknown");
});

test("tag recovery queries the source repository and accepts its own annotated tag", async () => {
  const calls = [];
  const tagObject = "f".repeat(40);
  const ports = realAdapter(async (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    // Round-9: recovery re-attests the checkout origin before trusting its
    // ls-remote answer.
    if (command === "git" && args[0] === "remote") {
      return { code: 0, stdout: "git@github.com:acme/widget.git\n", stderr: "" };
    }
    return {
      code: 0,
      stdout: `${tagObject}\trefs/tags/v1.2.3\n${COMMIT}\trefs/tags/v1.2.3^{}\n`,
      stderr: ""
    };
  });
  const query = await ports.queryStepEffect({
    step: {
      id: "tag",
      kind: "version-tag",
      idempotencyKey: "task-1/workflow-1/tag",
      params: { tag: "v1.2.3", repositoryPath: "/projects/acme-widget" },
      irreversibility: "irreversible"
    },
    source: SOURCE,
    externalIdentity: { kind: "git-tag", value: "v1.2.3" }
  });

  assert.deepEqual(
    { firstCall: calls[0].args[0], cwd: calls[0].cwd, state: query.state },
    { firstCall: "remote", cwd: "/projects/acme-widget", state: "exists" }
  );
});

test("cli-update executes the version frozen in the workflow", async () => {
  const ports = realAdapter(async () => ({ code: 0, stdout: "", stderr: "" }), {
    updatePorts: {
      stage: () => ({ binaryPath: "/stage/yui", version: "9.9.9" }),
      preflight: () => ({ status: "already-current" }),
      activateStorage: () => ({ status: "already-current" }),
      activateBinary: () => {},
      verify: () => {},
      probeStorage: () => ({ switched: false, schemaCurrent: true }),
      cleanup: () => {}
    }
  });
  const effect = await ports.executeStep({
    step: {
      id: "update",
      kind: "cli-update",
      idempotencyKey: "task-1/workflow-1/update",
      params: { version: "1.2.3" }
    },
    idempotencyKey: "task-1/workflow-1/update",
    source: SOURCE,
    params: { version: "1.2.3" }
  });

  assert.equal(effect.outcome, "failed");
});

test("grant creation and its immutable audit event commit atomically", (t) => {
  const { store, task, operator } = taskFixture(t);
  store.saveEvent = () => { throw new Error("audit persistence failed"); };

  assert.throws(() => runTaskCommand([
    "grant", "issue", task.id,
    "--action", "post-verify"
  ], store, { now: () => NOW, environment: operator.environment }), /audit persistence failed/);

  assert.equal(store.listCapabilityGrants(task.id).length, 0);
});
