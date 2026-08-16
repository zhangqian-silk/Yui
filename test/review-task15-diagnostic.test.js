import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Reviewer-only red tests for the frozen Task head. Each test expresses a Task
// contract that the candidate currently violates; do not integrate this file
// as a green regression suite until the corresponding implementation is fixed.

import { createCapabilityGrant } from "../dist/grant/capabilityGrant.js";
import { routeInvocation } from "../dist/cli/invocationRouter.js";
import { createReleaseWorkflow } from "../dist/release/releaseWorkflow.js";
import { startStep } from "../dist/release/releaseWorkflow.js";
import { runReleaseWorkflow } from "../dist/release/releaseWorkflowEngine.js";
import { createReleaseWorkflowPorts } from "../dist/release/releaseWorkflowPorts.js";
import { createInMemoryReleaseIdempotencyStore } from "../dist/release/releaseIdempotencyStore.js";
import { createConfiguredAgent } from "../dist/agent/agent.js";
import { runTaskCommand } from "../dist/commands/taskCommands.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { installOperatorSession } from "./helpers/operatorSession.js";

const NOW = new Date("2026-08-13T12:00:00.000Z");

test("review diagnostic: repository-scoped grant does not authorize another repository", async () => {
  let grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    scope: { repositories: [{ owner: "allowed", name: "repo" }] },
    actions: ["npm-publish"],
    irreversibilityCeiling: "irreversible"
  }, NOW);
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: grant.id,
    source: {
      repository: { owner: "forbidden", name: "repo" },
      commit: "0123456789abcdef000000000000000000000000",
      artifact: { name: "widget-1.2.3.tgz", integrity: "sha512-dGVzdC1pbnRlZ3JpdHk=" }
    },
    plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
  }, NOW);
  let calls = 0;
  const store = {
    getReleaseWorkflow: () => workflow,
    saveReleaseWorkflow: (_taskId, next) => { workflow = next; },
    getCapabilityGrant: () => grant,
    saveCapabilityGrant: (_taskId, next) => { grant = next; }
  };
  const result = await runReleaseWorkflow(store, "task-1", workflow.id, {
    executeStep: async () => {
      calls += 1;
      return { outcome: "succeeded" };
    },
    queryStepEffect: async () => ({ state: "unknown" })
  }, { now: () => NOW });

  assert.equal(result.outcome, "unauthorized");
  assert.equal(calls, 0);
});

test("review diagnostic: a local-only tag is not authoritative proof of a pushed release tag", async () => {
  const calls = [];
  const ports = createReleaseWorkflowPorts({
    home: "/tmp/review-home",
    updatePorts: {},
    projectStore: {},
    idempotencyStore: createInMemoryReleaseIdempotencyStore(),
    runCommand: async (command, args, cwd) => {
      calls.push([command, ...args, cwd]);
      if (command === "git" && args[0] === "tag" && args[1] === "-l") {
        return { code: 0, stdout: "v1.2.3\n", stderr: "" };
      }
      if (command === "git" && args[0] === "remote") {
        return { code: 0, stdout: "git@github.com:acme/widget.git\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
  });

  const query = await ports.queryStepEffect({
    step: {
      id: "tag",
      kind: "version-tag",
      idempotencyKey: "task-1/release-workflow-1/tag",
      params: { tag: "v1.2.3", repositoryPath: "/projects/acme-widget" },
      irreversibility: "irreversible"
    },
    source: {
      repository: { owner: "acme", name: "widget" },
      commit: "0123456789abcdef0123456789abcdef01234567"
    },
    externalIdentity: { kind: "git-tag", value: "v1.2.3" }
  });

  assert.equal(query.state, "absent");
  assert.deepEqual(calls, [
    ["git", "remote", "get-url", "origin", "/projects/acme-widget"],
    ["git", "remote", "get-url", "--push", "--all", "origin", "/projects/acme-widget"],
    ["git", "ls-remote", "--tags", "origin", "refs/tags/v1.2.3", "/projects/acme-widget"]
  ]);
});

test("review diagnostic: an authoritative query fails closed on transport errors", async () => {
  const ports = createReleaseWorkflowPorts({
    home: "/tmp/review-home",
    updatePorts: {},
    projectStore: {},
    idempotencyStore: createInMemoryReleaseIdempotencyStore(),
    runCommand: async () => ({
      code: 1,
      stdout: "",
      stderr: "network request timed out"
    })
  });

  const query = await ports.queryStepEffect({
    step: {
      id: "pr",
      kind: "pr-create-or-reuse",
      idempotencyKey: "task-1/release-workflow-1/pr",
      irreversibility: "reversible"
    },
    source: {
      repository: { owner: "acme", name: "widget" },
      commit: "0123456789abcdef0123456789abcdef01234567"
    },
    externalIdentity: { kind: "pull-request", value: "42" }
  });

  assert.equal(query.state, "unknown");
});

test("review diagnostic: pr-create-or-reuse can reuse an existing head PR", async () => {
  const calls = [];
  const ports = createReleaseWorkflowPorts({
    home: "/tmp/review-home",
    updatePorts: {},
    projectStore: {},
    idempotencyStore: createInMemoryReleaseIdempotencyStore(),
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        return args.includes("--head")
          ? { code: 1, stdout: "", stderr: "unknown flag: --head" }
          : { code: 0, stdout: JSON.stringify({ number: 42, headRefOid: "0123456789abcdef000000000000000000000000" }) + "\n", stderr: "" };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return { code: 0, stdout: JSON.stringify([{ number: 42, headRefOid: "0123456789abcdef000000000000000000000000" }]) + "\n", stderr: "" };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "create") {
        return { code: 1, stdout: "", stderr: "a pull request already exists" };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    }
  });

  const effect = await ports.executeStep({
    step: {
      id: "pr",
      kind: "pr-create-or-reuse",
      idempotencyKey: "task-1/release-workflow-1/pr",
      params: { head: "release-1" },
      irreversibility: "reversible"
    },
    idempotencyKey: "task-1/release-workflow-1/pr",
    source: {
      repository: { owner: "acme", name: "widget" },
      commit: "0123456789abcdef000000000000000000000000"
    },
    params: { head: "release-1" }
  });

  assert.equal(effect.outcome, "succeeded", JSON.stringify(calls));
  assert.equal(effect.externalId, "pr:42");
});

test("review diagnostic: fresh-install smoke installs the released scoped package", async () => {
  const calls = [];
  const ports = createReleaseWorkflowPorts({
    home: "/tmp/review-home",
    updatePorts: {},
    projectStore: {},
    idempotencyStore: createInMemoryReleaseIdempotencyStore(),
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, stdout: "0.5.3\n", stderr: "" };
    }
  });

  await ports.executeStep({
    step: {
      id: "smoke",
      kind: "fresh-install-smoke",
      idempotencyKey: "task-1/release-workflow-1/smoke"
    },
    idempotencyKey: "task-1/release-workflow-1/smoke",
    source: {
      repository: { owner: "zq-silk", name: "yui" },
      commit: "0123456789abcdef000000000000000000000000"
    },
    params: { version: "0.5.3" }
  });

  assert.ok(calls[0].includes("@zq-silk/yui@0.5.3"), JSON.stringify(calls[0]));
});

test("review diagnostic: version-tag runs inside the exact source repository", async () => {
  const calls = [];
  const ports = createReleaseWorkflowPorts({
    home: "/tmp/review-home",
    updatePorts: {},
    projectStore: {},
    idempotencyStore: createInMemoryReleaseIdempotencyStore(),
    runCommand: async (command, args, cwd) => {
      calls.push({ command, args, cwd });
      if (command === "git" && args[0] === "remote") {
        return { code: 0, stdout: "git@github.com:acme/widget.git\n", stderr: "" };
      }
      if (command === "git" && args[0] === "rev-parse") {
        return { code: 1, stdout: "", stderr: "no such tag" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
  });

  await ports.executeStep({
    step: {
      id: "tag",
      kind: "version-tag",
      idempotencyKey: "task-1/release-workflow-1/tag",
      params: { tag: "v1.2.3" },
      irreversibility: "irreversible"
    },
    idempotencyKey: "task-1/release-workflow-1/tag",
    source: {
      repository: { owner: "acme", name: "widget" },
      commit: "0123456789abcdef000000000000000000000000"
    },
    params: { tag: "v1.2.3", repositoryPath: "/projects/acme-widget" }
  });

  assert.equal(calls[0].cwd, "/projects/acme-widget");
  assert.equal(calls[1].cwd, "/projects/acme-widget");
});

test("review diagnostic: an exact source rejects a moving branch name", () => {
  assert.throws(() => createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: "capability-grant-1",
    source: {
      repository: { owner: "acme", name: "widget" },
      commit: "main"
    },
    plan: [{ id: "tag", kind: "version-tag" }]
  }, NOW), /commit.*sha|pinned.*commit/i);
});

test("review diagnostic: storage rejects a rewritten exact source and plan", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-review-immutable-workflow-"));
  try {
    ensureStorageSchema(root, NOW);
    const store = new FileTaskStore(root);
    const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
    store.transaction((tx) => {
      tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
      tx.saveConfiguredAgent(agent);
    });
    const operator = installOperatorSession(store, agent, NOW);
    const task = runTaskCommand(["create", "immutable workflow"], store, { now: () => NOW }).data.task;
    runTaskCommand([
      "grant", "issue", task.id,
      "--action", "version-tag",
      "--irreversibility-ceiling", "irreversible"
    ], store, { now: () => NOW, environment: operator.environment });
    const created = runTaskCommand([
      "workflow", "create", task.id,
      "--grant", "capability-grant-1",
      "--source-repo", "acme/widget",
      "--source-commit", "0123456789abcdef000000000000000000000000",
      "--step", "tag:version-tag",
      "--step-param", "tag:tag=v1.2.3"
    ], store, { now: () => NOW }).data;
    const replacement = createReleaseWorkflow(created.id, task.id, {
      grantId: created.grantId,
      source: {
        repository: { owner: "attacker", name: "other" },
        commit: "fedcba9876543210000000000000000000000000"
      },
      plan: [{
        id: "tag",
        kind: "version-tag",
        params: { tag: "v9.9.9" }
      }]
    }, new Date(NOW.getTime() + 1000));

    assert.throws(() => store.saveReleaseWorkflow(task.id, replacement), /overwritten|immutable/);
    assert.deepEqual(store.getReleaseWorkflow(task.id, created.id), created);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review diagnostic: storage rejects illegal step-state rewrites", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-review-step-transition-"));
  try {
    ensureStorageSchema(root, NOW);
    const store = new FileTaskStore(root);
    const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
    store.transaction((tx) => {
      tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
      tx.saveConfiguredAgent(agent);
    });
    const operator = installOperatorSession(store, agent, NOW);
    const task = runTaskCommand(["create", "step transition"], store, { now: () => NOW }).data.task;
    runTaskCommand([
      "grant", "issue", task.id,
      "--action", "version-tag",
      "--irreversibility-ceiling", "irreversible"
    ], store, { now: () => NOW, environment: operator.environment });
    const created = runTaskCommand([
      "workflow", "create", task.id,
      "--grant", "capability-grant-1",
      "--source-repo", "acme/widget",
      "--source-commit", "0123456789abcdef000000000000000000000000",
      "--step", "tag:version-tag"
    ], store, { now: () => NOW }).data;
    const running = startStep(created, "tag", new Date(NOW.getTime() + 1000));
    store.saveReleaseWorkflow(task.id, running);

    const rewound = {
      ...running,
      steps: { ...running.steps, tag: created.steps.tag },
      updatedAt: new Date(NOW.getTime() + 2000).toISOString()
    };
    assert.throws(() => store.saveReleaseWorkflow(task.id, rewound), /transition|overwritten/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review diagnostic: a crash after persisting running can resume a normal step", async () => {
  let grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"],
    irreversibilityCeiling: "irreversible"
  }, NOW);
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: grant.id,
    source: {
      repository: { owner: "allowed", name: "repo" },
      commit: "0123456789abcdef000000000000000000000000",
      artifact: { name: "widget-1.2.3.tgz", integrity: "sha512-dGVzdC1pbnRlZ3JpdHk=" }
    },
    plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
  }, NOW);
  let firstSave = true;
  const store = {
    getReleaseWorkflow: () => workflow,
    saveReleaseWorkflow: (_taskId, next) => {
      workflow = next;
      if (firstSave && next.steps.publish.status === "running") {
        firstSave = false;
        throw new Error("simulated process exit before external submission");
      }
    },
    getCapabilityGrant: () => grant,
    saveCapabilityGrant: (_taskId, next) => { grant = next; }
  };
  const ports = {
    executeStep: async () => ({ outcome: "succeeded" }),
    queryStepEffect: async () => ({ state: "absent" })
  };

  await assert.rejects(
    runReleaseWorkflow(store, "task-1", workflow.id, ports, { now: () => NOW }),
    /simulated process exit/
  );
  const resumed = await runReleaseWorkflow(store, "task-1", workflow.id, ports, { now: () => NOW });
  assert.equal(resumed.outcome, "succeeded");
});

test("review diagnostic: an ambiguous npm publish is queried instead of blindly re-submitted", async (t) => {
  // P1-6: npm-publish now requires a content-addressed source.artifact.
  // Create a mock tarball and compute its sha512 for the artifact integrity.
  const tarballPath = join(tmpdir(), "yui-0.5.3.tgz");
  writeFileSync(tarballPath, "mock tarball content\n");
  const tarballBytes = readFileSync(tarballPath);
  const tarballIntegrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
  // A real Home so the durable pre-effect npm-publish target (npm path +
  // registry) can be written before the effect and read back on resume.
  const home = mkdtempSync(join(tmpdir(), "yui-review-npm-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  let grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"],
    irreversibilityCeiling: "irreversible"
  }, NOW);
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: grant.id,
    source: {
      repository: { owner: "allowed", name: "repo" },
      commit: "0123456789abcdef000000000000000000000000",
      artifact: { name: "yui-0.5.3.tgz", integrity: tarballIntegrity }
    },
    plan: [{
      id: "publish",
      kind: "npm-publish",
      params: {
        package: "@zq-silk/yui",
        tarball: tarballPath,
        version: "0.5.3"
      },
      irreversibility: "irreversible"
    }]
  }, NOW);
  let calls = 0;
  const store = {
    getReleaseWorkflow: () => workflow,
    saveReleaseWorkflow: (_taskId, next) => { workflow = next; },
    getCapabilityGrant: () => grant,
    saveCapabilityGrant: (_taskId, next) => { grant = next; }
  };
  const ports = createReleaseWorkflowPorts({
    home,
    updatePorts: {},
    projectStore: {},
    idempotencyStore: createInMemoryReleaseIdempotencyStore(),
    runCommand: async (command, args) => {
      // Dispatch npm commands on args: on resume the command is the
      // persisted absolute npm path, not the bare "npm".
      if (args[0] === "config" && args[1] === "get") {
        return { code: 0, stdout: "https://registry.example.com/\n", stderr: "" };
      }
      if (args[0] === "publish") {
        calls += 1;
        return calls === 1
          ? { code: 1, stdout: "", stderr: "network timed out after upload" }
          : { code: 1, stdout: "", stderr: "version already published" };
      }
      if (args[0] === "view") {
        return { code: 0, stdout: "0.5.3\n", stderr: "" };
      }
      if (command === "tar") {
        return { code: 0, stdout: JSON.stringify({ name: "@zq-silk/yui", version: "0.5.3" }) + "\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    }
  });

  const first = await runReleaseWorkflow(store, "task-1", workflow.id, ports, { now: () => NOW });
  assert.equal(first.outcome, "failed");
  await runReleaseWorkflow(store, "task-1", workflow.id, ports, { now: () => NOW });
  assert.equal(calls, 1);
});

test("review diagnostic: a crash cannot persist grant use without the matching step attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-review-atomic-attempt-"));
  try {
    ensureStorageSchema(root, NOW);
    const store = new FileTaskStore(root);
    const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
    store.transaction((tx) => {
      tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
      tx.saveConfiguredAgent(agent);
    });
    const operator = installOperatorSession(store, agent, NOW);
    const task = runTaskCommand(["create", "atomic attempt"], store, { now: () => NOW }).data.task;
    runTaskCommand([
      "grant", "issue", task.id,
      "--action", "npm-publish",
      "--irreversibility-ceiling", "irreversible"
    ], store, { now: () => NOW, environment: operator.environment });
    const workflowRecord = runTaskCommand([
      "workflow", "create", task.id,
      "--grant", "capability-grant-1",
      "--source-repo", "acme/widget",
      "--source-commit", "0123456789abcdef000000000000000000000000",
      "--source-artifact", "widget-1.2.3.tgz@sha512-dGVzdC1pbnRlZ3JpdHk=",
      "--step", "publish:npm-publish",
      "--step-irreversibility", "publish=irreversible"
    ], store, { now: () => NOW }).data;
    let calls = 0;
    let crashBeforeRunningSave = true;
    const crashStore = {
      getReleaseWorkflow: (taskId, workflowId) => store.getReleaseWorkflow(taskId, workflowId),
      saveReleaseWorkflow: (taskId, next) => {
        if (crashBeforeRunningSave && next.steps.publish.status === "running") {
          crashBeforeRunningSave = false;
          throw new Error("simulated crash between grant-use and running commits");
        }
        store.saveReleaseWorkflow(taskId, next);
      },
      getCapabilityGrant: (taskId, grantId) => store.getCapabilityGrant(taskId, grantId),
      saveCapabilityGrant: (taskId, next) => store.saveCapabilityGrant(taskId, next)
    };
    const ports = {
      executeStep: async () => {
        calls += 1;
        return { outcome: "succeeded" };
      },
      queryStepEffect: async () => ({ state: "unknown" })
    };

    await assert.rejects(
      runReleaseWorkflow(crashStore, task.id, workflowRecord.id, ports, { now: () => NOW }),
      /simulated crash/
    );
    const observer = new FileTaskStore(root);
    const observedGrant = observer.getCapabilityGrant(task.id, "capability-grant-1");
    const observedWorkflow = observer.getReleaseWorkflow(task.id, workflowRecord.id);
    assert.deepEqual({
      usesUsed: observedGrant.usesUsed,
      stepStatus: observedWorkflow.steps.publish.status,
      calls
    }, {
      usesUsed: 0,
      stepStatus: "pending",
      calls: 0
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// P2-1: an npm-publish workflow without a source artifact must fail closed
// before any grant use is deducted or port called. The engine re-validates the
// record on every run, so a pre-invariant persisted record is rejected at the
// resume cursor; the observable contract is no use, no port call.
test("review diagnostic: an npm-publish without a source artifact fails closed before any grant use", async () => {
  let grant = createCapabilityGrant("capability-grant-1", "task-1", {
    granter: "alice",
    actions: ["npm-publish"],
    maxUses: 1,
    irreversibilityCeiling: "irreversible"
  }, NOW);
  let workflow = createReleaseWorkflow("release-workflow-1", "task-1", {
    grantId: grant.id,
    source: {
      repository: { owner: "acme", name: "widget" },
      commit: "0123456789abcdef000000000000000000000000",
      artifact: { name: "widget-1.2.3.tgz", integrity: "sha512-dGVzdC1pbnRlZ3JpdHk=" }
    },
    plan: [{ id: "publish", kind: "npm-publish", irreversibility: "irreversible" }]
  }, NOW);
  // Strip the artifact after validation to model a pre-invariant persisted record.
  workflow = {
    ...workflow,
    source: { repository: workflow.source.repository, commit: workflow.source.commit }
  };
  let calls = 0;
  const store = {
    getReleaseWorkflow: () => workflow,
    saveReleaseWorkflow: (_taskId, next) => { workflow = next; },
    getCapabilityGrant: () => grant,
    saveCapabilityGrant: (_taskId, next) => { grant = next; }
  };
  const ports = {
    executeStep: async () => { calls += 1; return { outcome: "succeeded" }; },
    queryStepEffect: async () => ({ state: "unknown" })
  };

  await assert.rejects(
    runReleaseWorkflow(store, "task-1", workflow.id, ports, { now: () => NOW }),
    /npm-publish step requires a source artifact/
  );
  assert.equal(calls, 0, "no port call without a bound artifact");
  assert.equal(grant.usesUsed, 0, "the rejection precedes use deduction");
});

// P2-2: a moved remote head must fail closed before any external PR creation.
test("review diagnostic: a moved remote head fails before PR creation", async () => {
  const calls = [];
  const ports = createReleaseWorkflowPorts({
    home: "/tmp/review-home",
    updatePorts: {},
    projectStore: {},
    idempotencyStore: createInMemoryReleaseIdempotencyStore(),
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      // No open PR for the head: an authoritative empty list result.
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        return { code: 1, stdout: "", stderr: "no pull requests found" };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return { code: 0, stdout: "[]\n", stderr: "" };
      }
      // The remote head moved: it names a different commit than the frozen source.
      if (command === "gh" && args[0] === "api") {
        return { code: 0, stdout: "ffffffffffffffffffffffffffffffffffffffff\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    }
  });

  const effect = await ports.executeStep({
    step: { id: "pr", kind: "pr-create-or-reuse", idempotencyKey: "task-1/release-workflow-1/pr" },
    idempotencyKey: "task-1/release-workflow-1/pr",
    source: {
      repository: { owner: "acme", name: "widget" },
      commit: "0123456789abcdef0123456789abcdef01234567"
    },
    params: { head: "release-1" }
  });

  assert.equal(effect.outcome, "failed");
  assert.match(effect.error ?? "", /not the frozen source commit|head that moved/);
  assert.equal(
    calls.some((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create"),
    false,
    "no PR is created for a head that moved"
  );
});

// P2-2: recovery binds the PR query to the source repository and requires the
// PR head to be the frozen commit. A same-numbered PR elsewhere, or one whose
// head moved, must not confirm the effect.
test("review diagnostic: an unrelated same-number PR does not confirm the effect in recovery", async () => {
  const calls = [];
  const ports = createReleaseWorkflowPorts({
    home: "/tmp/review-home",
    updatePorts: {},
    projectStore: {},
    idempotencyStore: createInMemoryReleaseIdempotencyStore(),
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      // PR #42 exists, but its head is not the frozen commit (it moved, or it
      // is a same-numbered PR in a different repository than the query targets).
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({ number: 42, headRefOid: "ffffffffffffffffffffffffffffffffffffffff" }) + "\n",
          stderr: ""
        };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    }
  });

  const query = await ports.queryStepEffect({
    step: {
      id: "pr",
      kind: "pr-create-or-reuse",
      idempotencyKey: "task-1/release-workflow-1/pr",
      irreversibility: "reversible"
    },
    source: {
      repository: { owner: "acme", name: "widget" },
      commit: "0123456789abcdef0123456789abcdef01234567"
    },
    externalIdentity: { kind: "pull-request", value: "42" }
  });

  assert.equal(query.state, "unknown");
  const view = calls.find((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "view");
  assert.notEqual(view, undefined, "the recovery query runs");
  assert.ok(view.includes("--repo"), "the query is bound to the source repository");
  assert.ok(view.includes("acme/widget"), "the query targets the exact source repository");
  assert.ok(view.some((arg) => arg.includes("headRefOid")), "the query requests the PR head for comparison");
});

// P2-3: a moving version spec must never reach npx; only a concrete pinned
// version may be installed.
test("review diagnostic: fresh-install smoke rejects moving version specs", async () => {
  for (const version of ["latest", "next", "1.x", ">=1.0.0", ""]) {
    const calls = [];
    const ports = createReleaseWorkflowPorts({
      home: "/tmp/review-home",
      updatePorts: {},
      projectStore: {},
      idempotencyStore: createInMemoryReleaseIdempotencyStore(),
      runCommand: async (command, args) => {
        calls.push([command, ...args]);
        return { code: 0, stdout: "0.5.3\n", stderr: "" };
      }
    });

    const effect = await ports.executeStep({
      step: { id: "smoke", kind: "fresh-install-smoke", idempotencyKey: "task-1/release-workflow-1/smoke" },
      idempotencyKey: "task-1/release-workflow-1/smoke",
      source: { repository: { owner: "zq-silk", name: "yui" }, commit: "0123456789abcdef000000000000000000000000" },
      params: { version }
    });

    assert.equal(effect.outcome, "failed", `version ${JSON.stringify(version)} must be rejected`);
    assert.equal(calls.length, 0, `no npx call for a moving version (${JSON.stringify(version)})`);
  }
});

test("review diagnostic: fresh-install smoke installs a concrete pinned version", async () => {
  const calls = [];
  const ports = createReleaseWorkflowPorts({
    home: "/tmp/review-home",
    updatePorts: {},
    projectStore: {},
    idempotencyStore: createInMemoryReleaseIdempotencyStore(),
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, stdout: "0.5.3\n", stderr: "" };
    }
  });

  const effect = await ports.executeStep({
    step: { id: "smoke", kind: "fresh-install-smoke", idempotencyKey: "task-1/release-workflow-1/smoke" },
    idempotencyKey: "task-1/release-workflow-1/smoke",
    source: { repository: { owner: "zq-silk", name: "yui" }, commit: "0123456789abcdef000000000000000000000000" },
    params: { version: "0.5.3" }
  });

  assert.equal(effect.outcome, "succeeded");
  assert.ok(calls[0].includes("@zq-silk/yui@0.5.3"), JSON.stringify(calls[0]));
});

test("review diagnostic: public routing exposes workflow run, resume, and status", () => {
  for (const action of ["run", "resume", "status"]) {
    const invocation = routeInvocation([
      "task",
      "workflow",
      action,
      "task-1",
      "release-workflow-1"
    ]);
    assert.equal(invocation.kind, "execute", `${action}: ${JSON.stringify(invocation)}`);
  }
});
