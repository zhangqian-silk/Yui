import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileTaskRuntimeIsolation,
  YUI_TASK_RUNTIME_ISOLATION_DESCRIPTOR,
  YUI_TASK_RUNTIME_SERVICE_NAMESPACE,
  assertTaskRuntimeIsolationPreflight,
  createTaskRuntimeIsolationDescriptor,
  parseTaskRuntimeIsolationDescriptor,
  planTaskRuntimeCleanup,
  taskRuntimeIsolationEnvironment,
  taskRuntimeIsolationFingerprint
} from "../../dist/runtime/taskRuntimeIsolation.js";
import {
  createExactControlPlaneDescriptor,
  parseExactControlPlaneDescriptor,
  serializeExactDescriptor
} from "../../dist/runtime/exactControlPlane.js";
import { RuntimeLaunchCoordinator } from "../../dist/controller/runtimeLaunchCoordinator.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";

const NOW = new Date("2026-08-09T00:00:00.000Z");
const COMMIT = "a".repeat(40);

function fixture(t, owner = { type: "task", taskId: "task-15" }) {
  const base = mkdtempSync(join(tmpdir(), "yui-task-runtime-isolation-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const controlHome = join(base, "control-home");
  const workspaceRoot = join(base, "managed-workspace");
  const projectRoot = join(workspaceRoot, "project");
  const runtimeRoot = join(base, "task-runtimes");
  const globalInstall = join(base, "global-install");
  for (const path of [controlHome, projectRoot, globalInstall]) {
    mkdirSync(path, { recursive: true });
  }
  const workspace = createManagedWorkspace({
    owner,
    root: workspaceRoot,
    entries: [{
      projectId: "project-1",
      directory: "project",
      access: "write",
      path: projectRoot,
      branch: "yui/task-15/main",
      baseRef: "refs/heads/master",
      baseCommit: COMMIT
    }]
  }, NOW);
  const controlPlane = {
    yuiHome: controlHome,
    controllerSocketPath: join(base, "controller.sock"),
    tmuxNamespace: "yui-control-tmux",
    globalInstallPaths: [globalInstall]
  };
  const service = new FileTaskRuntimeIsolation({
    runtimeRoot,
    controlPlane
  });
  return { base, controlHome, workspace, runtimeRoot, globalInstall, controlPlane, service };
}

function launchInput(fx, suffix = "1", policy) {
  return {
    workspace: fx.workspace,
    runId: `agent-run-${suffix}`,
    launchId: `launch-${suffix}`,
    generationId: `generation-${suffix}`,
    ...(policy === undefined ? {} : { policy })
  };
}

function descriptor(fx, suffix = "1", policy) {
  return createTaskRuntimeIsolationDescriptor({
    ...launchInput(fx, suffix, policy),
    runtimeRoot: fx.runtimeRoot
  });
}

test("Task runtime descriptor is ManagedWorkspace-owned and not a frozen control descriptor", (t) => {
  const fx = fixture(t, {
    type: "work-item",
    taskId: "task-15",
    workItemId: "work-item-9"
  });
  const runtime = descriptor(fx, "1", {
    declaredExternalCapabilities: ["network:mock", "service:postgres"],
    requestedExternalCapabilities: ["network:mock"],
    portPreference: [4100, 4101],
    portAllocations: [{ name: "mock-api", port: 4101 }]
  });
  const parsed = parseTaskRuntimeIsolationDescriptor(JSON.stringify(runtime));
  const environment = taskRuntimeIsolationEnvironment(runtime);

  assert.deepEqual(parsed.workspace.owner, fx.workspace.owner);
  assert.equal(parsed.taskId, "task-15");
  assert.equal("roleName" in parsed, false);
  assert.equal(parsed.generation.runId, "agent-run-1");
  assert.equal(parsed.generation.launchId, "launch-1");
  assert.deepEqual(parsed.portPreference, [4100, 4101]);
  assert.deepEqual(parsed.portAllocations, [{ name: "mock-api", port: 4101 }]);
  assert.deepEqual(parsed.externalCapabilities, {
    declared: ["network:mock", "service:postgres"],
    requested: ["network:mock"]
  });
  assert.equal(environment.TMPDIR, parsed.roots.temporary);
  assert.equal(environment.XDG_CACHE_HOME, parsed.roots.cache);
  assert.equal(environment.XDG_DATA_HOME, parsed.roots.data);
  assert.equal(
    environment[YUI_TASK_RUNTIME_SERVICE_NAMESPACE],
    parsed.serviceNamespace
  );
  assert.deepEqual(
    parseTaskRuntimeIsolationDescriptor(
      environment[YUI_TASK_RUNTIME_ISOLATION_DESCRIPTOR]
    ),
    parsed
  );

  const control = createExactControlPlaneDescriptor({
    executable: process.execPath,
    cliEntry: join(fx.base, "dist", "cli.js"),
    yuiHome: fx.controlHome
  });
  assert.throws(
    () => parseTaskRuntimeIsolationDescriptor(serializeExactDescriptor(control)),
    /expected yui-task-runtime-isolation.*found yui-control-plane/i
  );
  assert.throws(
    () => parseExactControlPlaneDescriptor(JSON.stringify(runtime)),
    /expected yui-control-plane.*found yui-task-runtime-isolation/i
  );
});

test("a foreground Task runtime remains workspace-owned without inventing a Run", (t) => {
  const fx = fixture(t);
  const preparation = fx.service.preflight({
    workspace: fx.workspace,
    launchId: "launch-foreground",
    generationId: "generation-foreground"
  });
  assert.equal(preparation.descriptor.generation.runId, undefined);
  assert.deepEqual(preparation.descriptor.workspace.owner, fx.workspace.owner);
  fx.service.activate(preparation);
  fx.service.cleanup(preparation, "interruption");
});

for (const owner of [
  { type: "task", taskId: "task-15" },
  { type: "work-item", taskId: "task-15", workItemId: "work-item-9" },
  { type: "review-round", taskId: "task-15", reviewRoundId: "review-round-4" },
  {
    type: "integration-attempt",
    taskId: "task-15",
    integrationAttemptId: "integration-4"
  }
]) {
  test(`${owner.type} ManagedWorkspace can own one exact Task runtime generation`, (t) => {
    const fx = fixture(t, owner);
    const preparation = fx.service.preflight(launchInput(fx));
    fx.service.activate(preparation);

    assert.equal(existsSync(preparation.descriptor.roots.data), true);
    assert.equal(existsSync(preparation.descriptor.roots.cache), true);
    assert.equal(existsSync(preparation.descriptor.roots.temporary), true);
    assert.equal(
      preparation.descriptor.workspace.owner.type,
      owner.type
    );

    // Reopening the same exact generation is idempotent; it never allocates a
    // Role-selected or second owner path.
    const reopened = fx.service.preflight({
      ...launchInput(fx),
      allowExactActive: true
    });
    fx.service.activate(reopened);
    assert.equal(reopened.descriptor.roots.generation, preparation.descriptor.roots.generation);
    fx.service.cleanup(reopened, "reopen");
    assert.equal(existsSync(preparation.descriptor.roots.generation), false);
  });
}

test("parallel non-Yui Tasks isolate colliding runtime names and exact cleanup", (t) => {
  const base = mkdtempSync(join(tmpdir(), "yui-parallel-project-runtime-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const controlHome = join(base, "control-home");
  const runtimeRoot = join(base, "task-runtimes");
  const globalInstall = join(base, "global-install");
  for (const path of [controlHome, globalInstall]) mkdirSync(path, { recursive: true });
  const controlPlane = {
    yuiHome: controlHome,
    controllerSocketPath: join(base, "controller.sock"),
    tmuxNamespace: "yui-control-tmux",
    globalInstallPaths: [globalInstall]
  };
  const observed = new Map();
  const service = new FileTaskRuntimeIsolation({
    runtimeRoot,
    controlPlane,
    inspectResources(runtime) {
      const fingerprint = taskRuntimeIsolationFingerprint(runtime);
      const ids = [
        ...runtime.portAllocations.map(({ port }) => `port:${port}`),
        ...runtime.portAllocations.map(({ name }) => (
          `service:${runtime.serviceNamespace}:${name}`
        )),
        `process:${runtime.serviceNamespace}:mock-agent`,
        ...runtime.externalCapabilities.requested.map((capability) => (
          `external:${runtime.serviceNamespace}:${capability}`
        ))
      ];
      return ids.flatMap((id) => {
        const resource = observed.get(id);
        if (resource === undefined) return [];
        return [{
          id,
          kind: resource.kind,
          ownership: resource.fingerprint === fingerprint ? "owned" : "mismatched",
          state: resource.active ? "active" : "inactive",
          descriptorFingerprint: resource.fingerprint
        }];
      });
    }
  });

  function nonYuiWorkspace(taskId, projectId) {
    const root = join(base, "workspaces", taskId);
    const project = join(root, "inventory-service");
    mkdirSync(project, { recursive: true });
    return createManagedWorkspace({
      owner: { type: "task", taskId },
      root,
      entries: [{
        projectId,
        directory: "inventory-service",
        access: "write",
        path: project,
        branch: `feature/${taskId}`,
        baseRef: "refs/heads/main",
        baseCommit: COMMIT
      }]
    }, NOW);
  }

  function request(workspace, port) {
    return {
      workspace,
      runId: "agent-run-1",
      launchId: "launch-shared-local-id",
      generationId: "generation-shared-local-id",
      policy: {
        declaredExternalCapabilities: ["network:mock"],
        requestedExternalCapabilities: ["network:mock"],
        portPreference: [43110, 43111],
        portAllocations: [{ name: "inventory-api", port }]
      }
    };
  }

  function startMock(preparation) {
    const runtime = preparation.descriptor;
    for (const { name, port } of runtime.portAllocations) {
      observed.set(`port:${port}`, {
        kind: "port",
        fingerprint: preparation.fingerprint,
        active: true
      });
      observed.set(`service:${runtime.serviceNamespace}:${name}`, {
        kind: "service",
        fingerprint: preparation.fingerprint,
        active: true
      });
    }
    observed.set(`process:${runtime.serviceNamespace}:mock-agent`, {
      kind: "service",
      fingerprint: preparation.fingerprint,
      active: true
    });
    for (const capability of runtime.externalCapabilities.requested) {
      observed.set(`external:${runtime.serviceNamespace}:${capability}`, {
        kind: "external",
        fingerprint: preparation.fingerprint,
        active: true
      });
    }
  }

  function stopMock(preparation) {
    const runtime = preparation.descriptor;
    for (const { name, port } of runtime.portAllocations) {
      observed.delete(`port:${port}`);
      observed.delete(`service:${runtime.serviceNamespace}:${name}`);
    }
    observed.delete(`process:${runtime.serviceNamespace}:mock-agent`);
    for (const capability of runtime.externalCapabilities.requested) {
      observed.delete(`external:${runtime.serviceNamespace}:${capability}`);
    }
  }

  const workspaceA = nonYuiWorkspace("task-15", "inventory-a");
  const workspaceB = nonYuiWorkspace("task-16", "inventory-b");
  const preparationA = service.preflight(request(workspaceA, 43110));
  service.activate(preparationA);
  startMock(preparationA);

  const collidingB = request(workspaceB, 43110);
  assert.throws(
    () => service.preflight(collidingB),
    /ambiguous or externally owned.*port:43110/i
  );
  const rejectedB = createTaskRuntimeIsolationDescriptor({
    ...collidingB,
    runtimeRoot
  });
  assert.equal(existsSync(rejectedB.roots.generation), false);
  assert.equal(existsSync(preparationA.descriptor.roots.generation), true);

  const preparationB = service.preflight(request(workspaceB, 43111));
  service.activate(preparationB);
  startMock(preparationB);
  const runtimeA = preparationA.descriptor;
  const runtimeB = preparationB.descriptor;
  const cacheKey = "shared-cache-key";
  writeFileSync(join(runtimeA.roots.cache, cacheKey), "task-15\n");
  writeFileSync(join(runtimeB.roots.cache, cacheKey), "task-16\n");

  assert.equal(runtimeA.generation.runId, runtimeB.generation.runId);
  assert.deepEqual(runtimeA.portPreference, runtimeB.portPreference);
  assert.equal(runtimeA.portAllocations[0].name, runtimeB.portAllocations[0].name);
  assert.notEqual(runtimeA.portAllocations[0].port, runtimeB.portAllocations[0].port);
  assert.notEqual(runtimeA.roots.generation, runtimeB.roots.generation);
  assert.notEqual(runtimeA.roots.data, runtimeB.roots.data);
  assert.notEqual(runtimeA.roots.cache, runtimeB.roots.cache);
  assert.notEqual(runtimeA.serviceNamespace, runtimeB.serviceNamespace);
  assert.notEqual(runtimeA.serviceNamespace, controlPlane.tmuxNamespace);
  assert.notEqual(runtimeB.serviceNamespace, controlPlane.tmuxNamespace);
  assert.notEqual(preparationA.fingerprint, preparationB.fingerprint);
  assert.deepEqual(runtimeA.externalCapabilities, runtimeB.externalCapabilities);
  assert.equal(readFileSync(join(runtimeA.roots.cache, cacheKey), "utf8"), "task-15\n");
  assert.equal(readFileSync(join(runtimeB.roots.cache, cacheKey), "utf8"), "task-16\n");

  assert.throws(
    () => service.cleanup(preparationA, "completion"),
    /active or unknown.*port:43110/i
  );
  stopMock(preparationA);
  service.cleanup(preparationA, "completion");
  assert.equal(existsSync(runtimeA.roots.generation), false);
  assert.equal(existsSync(runtimeB.roots.generation), true);
  assert.equal(readFileSync(join(runtimeB.roots.cache, cacheKey), "utf8"), "task-16\n");
  assert.equal(observed.get("port:43111").fingerprint, preparationB.fingerprint);

  stopMock(preparationB);
  service.cleanup(preparationB, "completion");
  assert.equal(existsSync(runtimeB.roots.generation), false);
  assert.equal(observed.size, 0);
  assert.equal(existsSync(controlHome), true);
  assert.equal(existsSync(globalInstall), true);
});

test("preflight rejects cross-Task, cross-owner, control, global, workspace, and external drift", (t) => {
  const fx = fixture(t);
  const runtime = descriptor(fx, "1", {
    declaredExternalCapabilities: ["network:mock"],
    requestedExternalCapabilities: ["network:mock"]
  });
  const base = {
    descriptor: runtime,
    workspace: fx.workspace,
    runtimeRoot: fx.runtimeRoot,
    controlPlane: fx.controlPlane
  };
  assert.doesNotThrow(() => assertTaskRuntimeIsolationPreflight(base));

  const anotherTask = createManagedWorkspace({
    ...fx.workspace,
    owner: { type: "task", taskId: "task-16" }
  }, NOW);
  assert.throws(
    () => assertTaskRuntimeIsolationPreflight({ ...base, workspace: anotherTask }),
    /owner or workspace.*ManagedWorkspace/i
  );
  const anotherOwner = createManagedWorkspace({
    ...fx.workspace,
    owner: {
      type: "work-item",
      taskId: "task-15",
      workItemId: "work-item-other"
    }
  }, NOW);
  assert.throws(
    () => assertTaskRuntimeIsolationPreflight({ ...base, workspace: anotherOwner }),
    /owner or workspace.*ManagedWorkspace/i
  );

  const crossTaskGeneration = join(
    fx.runtimeRoot,
    "task-16",
    "foreign-owner",
    "foreign-launch"
  );
  const redirected = parseTaskRuntimeIsolationDescriptor(JSON.stringify({
    ...runtime,
    roots: {
      generation: crossTaskGeneration,
      data: join(crossTaskGeneration, "data"),
      cache: join(crossTaskGeneration, "cache"),
      temporary: join(crossTaskGeneration, "tmp")
    }
  }));
  assert.throws(
    () => assertTaskRuntimeIsolationPreflight({ ...base, descriptor: redirected }),
    /exact Task, owner, and launch identity/i
  );
  const renamedService = parseTaskRuntimeIsolationDescriptor(JSON.stringify({
    ...runtime,
    serviceNamespace: "yui-task-foreign-generation"
  }));
  assert.throws(
    () => assertTaskRuntimeIsolationPreflight({ ...base, descriptor: renamedService }),
    /exact Task launch generation/i
  );

  const controlRuntimeRoot = join(fx.controlHome, "runtime");
  const controlRuntime = createTaskRuntimeIsolationDescriptor({
    ...launchInput(fx),
    runtimeRoot: controlRuntimeRoot
  });
  assert.throws(
    () => assertTaskRuntimeIsolationPreflight({
      ...base,
      descriptor: controlRuntime,
      runtimeRoot: controlRuntimeRoot
    }),
    /control YUI_HOME|global install/i
  );
  const globalRuntime = createTaskRuntimeIsolationDescriptor({
    ...launchInput(fx),
    runtimeRoot: join(fx.globalInstall, "runtime")
  });
  assert.throws(
    () => assertTaskRuntimeIsolationPreflight({
      ...base,
      descriptor: globalRuntime,
      runtimeRoot: join(fx.globalInstall, "runtime")
    }),
    /control YUI_HOME|global install/i
  );
  const workspaceRuntime = createTaskRuntimeIsolationDescriptor({
    ...launchInput(fx),
    runtimeRoot: join(fx.workspace.root, ".runtime")
  });
  assert.throws(
    () => assertTaskRuntimeIsolationPreflight({
      ...base,
      descriptor: workspaceRuntime,
      runtimeRoot: join(fx.workspace.root, ".runtime")
    }),
    /must not dirty the managed workspace/i
  );
  assert.throws(
    () => assertTaskRuntimeIsolationPreflight({
      ...base,
      controlPlane: {
        ...fx.controlPlane,
        tmuxNamespace: runtime.serviceNamespace
      }
    }),
    /tmux namespace/i
  );

  const undeclared = descriptor(fx, "2", {
    declaredExternalCapabilities: ["network:mock"],
    requestedExternalCapabilities: ["network:real"]
  });
  assert.throws(
    () => assertTaskRuntimeIsolationPreflight({ ...base, descriptor: undeclared }),
    /external capability is undeclared.*network:real/i
  );
});

test("preflight and cleanup fail closed for active, unknown, unmarked, mismatched, or external resources", (t) => {
  const fx = fixture(t);
  const runtime = descriptor(fx);
  const fingerprint = taskRuntimeIsolationFingerprint(runtime);
  const exact = {
    id: "resource-1",
    kind: "service",
    ownership: "owned",
    state: "inactive",
    descriptorFingerprint: fingerprint
  };
  const base = {
    descriptor: runtime,
    workspace: fx.workspace,
    runtimeRoot: fx.runtimeRoot,
    controlPlane: fx.controlPlane
  };
  assert.doesNotThrow(() => assertTaskRuntimeIsolationPreflight({
    ...base,
    resources: [exact]
  }));
  assert.deepEqual(
    planTaskRuntimeCleanup(runtime, "completion", [exact]),
    [exact.id]
  );

  for (const bad of [
    { ...exact, state: "active" },
    { ...exact, state: "unknown" },
    { ...exact, ownership: "unmarked", descriptorFingerprint: undefined },
    { ...exact, ownership: "mismatched", descriptorFingerprint: "b".repeat(64) },
    { ...exact, ownership: "ambiguous", descriptorFingerprint: undefined },
    { ...exact, ownership: "external", descriptorFingerprint: undefined }
  ]) {
    assert.throws(
      () => assertTaskRuntimeIsolationPreflight({ ...base, resources: [bad] }),
      /ambiguous|externally owned|not safely reusable/i
    );
    assert.throws(
      () => planTaskRuntimeCleanup(runtime, "completion", [bad]),
      /unowned|active or unknown/i
    );
  }
  assert.doesNotThrow(() => assertTaskRuntimeIsolationPreflight({
    ...base,
    resources: [{ ...exact, state: "active" }],
    allowExactActive: true
  }));
  assert.throws(
    () => assertTaskRuntimeIsolationPreflight({
      ...base,
      resources: [exact, exact]
    }),
    /inventory is ambiguous/i
  );
  assert.throws(
    () => planTaskRuntimeCleanup(runtime, "completion", [exact, exact]),
    /inventory is ambiguous/i
  );
});

for (const reason of ["failure", "timeout", "interruption", "completion", "reopen"]) {
  test(`${reason} cleanup removes only its exact marked Task generation`, (t) => {
    const fx = fixture(t);
    const preparation = fx.service.preflight(launchInput(fx, reason));
    fx.service.activate(preparation);
    const sibling = fx.service.preflight(launchInput(fx, `${reason}-sibling`));
    fx.service.activate(sibling);

    fx.service.cleanup(preparation, reason);

    assert.equal(existsSync(preparation.descriptor.roots.generation), false);
    assert.equal(existsSync(sibling.descriptor.roots.generation), true);
    fx.service.cleanup(sibling, reason);
  });
}

test("lifecycle cleanup resolves one exact Task and launch marker without a Role", (t) => {
  const fx = fixture(t, {
    type: "work-item",
    taskId: "task-15",
    workItemId: "work-item-9"
  });
  const selected = fx.service.preflight(launchInput(fx, "selected"));
  const sibling = fx.service.preflight(launchInput(fx, "sibling"));
  fx.service.activate(selected);
  fx.service.activate(sibling);

  assert.equal(fx.service.cleanupTaskLaunch({
    taskId: "task-15",
    launchId: selected.descriptor.generation.launchId,
    reason: "completion"
  }), "cleaned");
  assert.equal(existsSync(selected.descriptor.roots.generation), false);
  assert.equal(existsSync(sibling.descriptor.roots.generation), true);
  assert.equal(fx.service.cleanupTaskLaunch({
    taskId: "task-15",
    launchId: "launch-absent",
    reason: "reopen"
  }), "absent");
  fx.service.cleanup(sibling, "completion");
});

test("unmarked runtime paths are never repaired or cleaned", (t) => {
  const fx = fixture(t);
  const runtime = descriptor(fx);
  mkdirSync(runtime.roots.generation, { recursive: true });
  assert.throws(
    () => fx.service.preflight(launchInput(fx)),
    /ambiguous|externally owned|unmarked/i
  );
  assert.throws(
    () => fx.service.cleanupTaskLaunch({
      taskId: "task-15",
      launchId: runtime.generation.launchId,
      reason: "completion"
    }),
    /unmarked or invalid/i
  );
  assert.equal(existsSync(runtime.roots.generation), true);
});

test("coordinator activates isolation after reservation and cleans a stopped failed start", async (t) => {
  const fx = fixture(t);
  const events = [];
  let generationRoot;
  const reservations = {
    reserveRuntimeLaunch(input) {
      events.push("reserve");
      return { status: "reserved", ...input };
    },
    confirmRuntimeLaunchReservation() { events.push("confirm"); },
    recordReservedRuntimeNativeSession() { throw new Error("not expected"); },
    completeRuntimeLaunchReservation() { return true; },
    settleStoppedRuntimeLaunch() { events.push("settle"); return true; },
    enqueueRuntimeCleanup() { events.push("queue-cleanup"); return null; }
  };
  const host = {
    async start(request) {
      events.push("host-start");
      assert.ok(request.runtimeIsolation);
      generationRoot = request.runtimeIsolation.roots.generation;
      assert.equal(existsSync(generationRoot), true);
      throw new Error("mock start failed");
    },
    async resume() { throw new Error("not expected"); },
    async stop() { throw new Error("not expected"); },
    async inspect() { return { state: "stopped" }; },
    async inspectOwner() { events.push("inspect-stopped"); return { state: "stopped" }; },
    async stopOwner() { throw new Error("not expected"); }
  };
  const coordinator = new RuntimeLaunchCoordinator(reservations, host, {
    createGenerationId: () => "generation-1",
    runtimeIsolation: fx.service
  });
  const effective = {
    schemaVersion: 2,
    sourceDesiredRevision: 1,
    agentId: "mock-agent",
    adapterId: "claude",
    profileAccess: "write",
    search: false,
    writeProjectIds: ["project-1"],
    workspace: {
      root: fx.workspace.root,
      entries: fx.workspace.entries
    },
    context: {},
    permission: { strategy: "bypass" }
  };

  await assert.rejects(
    coordinator.prepare({
      owner: { scope: "task", taskId: "task-15", roleName: "worker" },
      agentId: "mock-agent",
      adapterId: "claude",
      effective,
      workspace: fx.workspace.root,
      managedWorkspace: fx.workspace,
      mode: "new",
      runId: "agent-run-1"
    }, "deferred"),
    /mock start failed/i
  );
  assert.deepEqual(events, ["reserve", "host-start", "inspect-stopped", "settle"]);
  assert.equal(existsSync(generationRoot), false);
});
