import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  EXACT_CONTROL_ARGUMENT,
  YUI_CONTROL_PLANE_DESCRIPTOR,
  YUI_TASK_RUNTIME_DESCRIPTOR,
  assertExactControlPlanePreflight,
  assertExactTaskRuntimeEnvironment,
  assertExactTaskRuntimeState,
  createExactControlPlaneDescriptor,
  createExactTaskRuntimeDescriptor,
  exactTaskRuntimeDescriptorPath,
  exactControlPlaneDigest,
  parseExactControlPlaneDescriptor,
  parseExactTaskRuntimeDescriptor,
  readExactTaskRuntimeDescriptorSource,
  refreshExactTaskRuntimeDescriptorSource,
  serializeExactDescriptor
} from "../../dist/runtime/exactControlPlane.js";
import { ControllerClientError } from "../../dist/core/controllerClient.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createAgentRun } from "../helpers/effectiveLaunch.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createProject } from "../../dist/repository/project.js";
import {
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { stopFileTaskController } from "../../dist/controller/clientRuntime.js";
import { yuiVersionIdentity } from "../../dist/version.js";
import {
  TASK_FINAL_REVIEW_ARGUMENT,
  createTaskFinalReviewContract
} from "../../dist/review/taskFinalReviewContract.js";
import { exactTaskCliInvocation } from "../helpers/exactTaskCli.js";
import { bindExecution, claimPending } from "../../dist/coordination/workMailbox.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";

function fixture(t, roleName = "worker", { projectBacked = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "yui-exact-control-"));
  t.after(async () => {
    await stopFileTaskController(home);
    rmSync(home, { recursive: true, force: true });
  });
  ensureStorageSchema(home, new Date("2026-08-09T00:00:00.000Z"));
  const cliEntry = join(process.cwd(), "dist", "cli.js");
  const control = createExactControlPlaneDescriptor({
    executable: process.execPath,
    cliEntry,
    yuiHome: home,
    identity: yuiVersionIdentity()
  });
  const digest = exactControlPlaneDigest(control);
  const runtime = createExactTaskRuntimeDescriptor({
    controlPlaneDigest: digest,
    taskId: "task-15",
    roleName,
    agentId: "claude",
    adapterId: "claude",
    workspace: home,
    runId: "agent-run-1",
    launchId: "launch-1",
    nativeSessionId: "native-1"
  });
  const now = new Date("2026-08-09T00:00:00.000Z");
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent(
    runtime.agentId,
    runtime.adapterId,
    "claude-test",
    [],
    [],
    now
  );
  const projectPath = join(home, "project");
  if (projectBacked) mkdirSync(projectPath, { recursive: true });
  const task = activateTask(createTask(runtime.taskId, "Exact runtime", now, {
    ...(projectBacked
      ? {
          projectBindings: [{
            projectId: "project-1",
            directory: "project",
            baseRef: "main"
          }]
        }
      : {})
  }), now);
  const role = createRole(
    task.id,
    runtime.roleName,
    [createRoleAgentBinding(agent)],
    agent.id,
    runtime.workspace,
    now
  );
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  const run = createAgentRun(
    runtime.runId,
    task.id,
    role.name,
    "new",
    "exact invocation",
    now,
    { effective }
  );
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  }, agent.id, now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: agent.id,
    adapterId: agent.adapterId,
    nativeSessionId: runtime.nativeSessionId,
    launchId: runtime.launchId,
    policy: "fixed",
    status: "running",
    effective
  }, now);
  sessions = bindTaskRoleRun(sessions, {
    agentId: agent.id,
    runId: run.id,
    receiptId: `agent-run:${task.id}/${run.id}`
  }, now);
  store.transaction((tx) => {
    if (projectBacked) {
      tx.saveProject(createProject(
        "project-1",
        "project",
        projectPath,
        { stable: "main", development: "main" },
        now
      ));
      tx.saveConfig({
        ...tx.getConfig(),
        review: { roleName: "reviewer", trigger: "leader" }
      });
    }
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveRole(task.id, role);
    tx.saveActiveAgentRun(run);
    tx.saveTaskRoleSessionSet(sessions);
    if (projectBacked) {
      const item = createWorkItem("work-item-1", task.id, {
        title: "metadata-only exact Candidate",
        writeProjectIds: ["project-1"]
      }, now);
      tx.saveWorkItem(task.id, updateWorkItemStatus(item, "running", now));
    }
  });
  return { home, cliEntry, control, digest, runtime, store };
}

test("Task-final contract prefix is bound to the verified exact Leader Task and control digest", (t) => {
  const { home, cliEntry, control, digest, runtime } = fixture(t, "leader");
  const statePath = join(home, "state.json");
  const stateBefore = readFileSync(statePath, "utf8");
  const environment = {
    ...process.env,
    YUI_HOME: home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: runtime.taskId,
    YUI_ROLE: runtime.roleName,
    YUI_AGENT_ID: runtime.agentId,
    YUI_ADAPTER_ID: runtime.adapterId,
    YUI_WORKSPACE: runtime.workspace,
    YUI_RUN_ID: runtime.runId,
    YUI_LAUNCH_ID: runtime.launchId,
    YUI_NATIVE_SESSION_ID: runtime.nativeSessionId,
    [YUI_CONTROL_PLANE_DESCRIPTOR]: serializeExactDescriptor(control),
    [YUI_TASK_RUNTIME_DESCRIPTOR]: serializeExactDescriptor(runtime)
  };
  const exact = spawnSync(process.execPath, [
    cliEntry,
    EXACT_CONTROL_ARGUMENT,
    digest,
    TASK_FINAL_REVIEW_ARGUMENT,
    runtime.taskId,
    "reviewer",
    "version"
  ], { encoding: "utf8", env: environment });
  assert.equal(exact.status, 0, exact.stderr);
  const contract = createTaskFinalReviewContract({
    taskId: runtime.taskId,
    reviewerRoleName: "reviewer",
    controlPlaneDigest: digest
  });
  assert.equal(contract.taskId, runtime.taskId);
  assert.equal(contract.reviewerRoleName, "reviewer");
  assert.equal(contract.controlPlaneDigest, digest);
  assert.match(contract.digest, /^[a-f0-9]{64}$/u);
  assert.equal(readFileSync(statePath, "utf8"), stateBefore);

  const wrongTask = spawnSync(process.execPath, [
    cliEntry,
    EXACT_CONTROL_ARGUMENT,
    digest,
    TASK_FINAL_REVIEW_ARGUMENT,
    "task-16",
    "reviewer",
    "version"
  ], { encoding: "utf8", env: environment });
  assert.notEqual(wrongTask.status, 0);
  assert.match(wrongTask.stderr, /contract Task id mismatch/i);
  assert.equal(readFileSync(statePath, "utf8"), stateBefore);

  const wrongDigest = spawnSync(process.execPath, [
    cliEntry,
    EXACT_CONTROL_ARGUMENT,
    "0".repeat(64),
    TASK_FINAL_REVIEW_ARGUMENT,
    runtime.taskId,
    "reviewer",
    "version"
  ], { encoding: "utf8", env: environment });
  assert.notEqual(wrongDigest.status, 0);
  assert.match(wrongDigest.stderr, /digest does not match/i);
  assert.equal(readFileSync(statePath, "utf8"), stateBefore);
});

test("exact Task-final CLI submits and accepts a metadata-only Project Candidate", async (t) => {
  const submittedFixture = fixture(
    t,
    "leader",
    { projectBacked: true }
  );
  const {
    home,
    cliEntry,
    control,
    digest,
    runtime,
    store
  } = submittedFixture;
  const environment = {
    ...process.env,
    YUI_HOME: home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: runtime.taskId,
    YUI_ROLE: runtime.roleName,
    YUI_AGENT_ID: runtime.agentId,
    YUI_ADAPTER_ID: runtime.adapterId,
    YUI_WORKSPACE: runtime.workspace,
    YUI_RUN_ID: runtime.runId,
    YUI_LAUNCH_ID: runtime.launchId,
    YUI_NATIVE_SESSION_ID: runtime.nativeSessionId,
    [YUI_CONTROL_PLANE_DESCRIPTOR]: serializeExactDescriptor(control),
    [YUI_TASK_RUNTIME_DESCRIPTOR]: serializeExactDescriptor(runtime)
  };
  const prefix = [
    cliEntry,
    EXACT_CONTROL_ARGUMENT,
    digest,
    TASK_FINAL_REVIEW_ARGUMENT,
    runtime.taskId,
    "reviewer"
  ];
  const submitted = spawnSync(process.execPath, [
    ...prefix,
    "task", "work", "update", "work-item-1", "done",
    "--summary", "metadata-only Candidate"
  ], { encoding: "utf8", env: environment });
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.match(submitted.stdout, /Submitted work item/u);
  const candidate = store.getWorkItem(runtime.taskId, "work-item-1").candidates[0];
  assert.equal(candidate.workspace, undefined);
  assert.equal(candidate.taskFinalReviewContract.controlPlaneDigest, digest);

  await stopFileTaskController(home);

  // The first write legitimately wakes the Controller, which may settle its
  // exact Run before another process starts. Exercise acceptance against a
  // separately current runtime instead of reusing a stale descriptor.
  const acceptedFixture = fixture(t, "leader", { projectBacked: true });
  const acceptedContract = createTaskFinalReviewContract({
    taskId: acceptedFixture.runtime.taskId,
    reviewerRoleName: "reviewer",
    controlPlaneDigest: acceptedFixture.digest
  });
  acceptedFixture.store.transaction((tx) => {
    const running = tx.getWorkItem(
      acceptedFixture.runtime.taskId,
      "work-item-1"
    );
    tx.saveWorkItem(acceptedFixture.runtime.taskId, submitWorkItemCandidate(running, {
      summary: "metadata-only Candidate",
      source: { type: "direct" },
      reviewPolicy: { roleName: "reviewer", trigger: "final" },
      taskFinalReviewContract: acceptedContract
    }, new Date("2026-08-09T00:00:00.000Z")));
  });
  const acceptedEnvironment = {
    ...process.env,
    YUI_HOME: acceptedFixture.home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: acceptedFixture.runtime.taskId,
    YUI_ROLE: acceptedFixture.runtime.roleName,
    YUI_AGENT_ID: acceptedFixture.runtime.agentId,
    YUI_ADAPTER_ID: acceptedFixture.runtime.adapterId,
    YUI_WORKSPACE: acceptedFixture.runtime.workspace,
    YUI_RUN_ID: acceptedFixture.runtime.runId,
    YUI_LAUNCH_ID: acceptedFixture.runtime.launchId,
    YUI_NATIVE_SESSION_ID: acceptedFixture.runtime.nativeSessionId,
    [YUI_CONTROL_PLANE_DESCRIPTOR]: serializeExactDescriptor(acceptedFixture.control),
    [YUI_TASK_RUNTIME_DESCRIPTOR]: serializeExactDescriptor(acceptedFixture.runtime)
  };
  const acceptedPrefix = [
    acceptedFixture.cliEntry,
    EXACT_CONTROL_ARGUMENT,
    acceptedFixture.digest,
    TASK_FINAL_REVIEW_ARGUMENT,
    acceptedFixture.runtime.taskId,
    "reviewer"
  ];

  const accepted = spawnSync(process.execPath, [
    ...acceptedPrefix,
    "task", "work", "accept", "work-item-1",
    "--summary", "exact metadata accepted"
  ], { encoding: "utf8", env: acceptedEnvironment });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /Accepted Work Item/u);
  assert.equal(
    acceptedFixture.store.getWorkItem(
      acceptedFixture.runtime.taskId,
      "work-item-1"
    ).status,
    "completed"
  );
  await stopFileTaskController(acceptedFixture.home);
});

test("control-plane and Task runtime descriptors are tagged and never interchangeable", (t) => {
  const { control, runtime } = fixture(t);
  assert.deepEqual(
    parseExactControlPlaneDescriptor(serializeExactDescriptor(control)),
    control
  );
  assert.deepEqual(
    parseExactTaskRuntimeDescriptor(serializeExactDescriptor(runtime)),
    runtime
  );
  assert.throws(
    () => parseExactControlPlaneDescriptor(serializeExactDescriptor(runtime)),
    /expected yui-control-plane.*found yui-task-runtime/i
  );
  assert.throws(
    () => parseExactTaskRuntimeDescriptor(serializeExactDescriptor(control)),
    /expected yui-task-runtime.*found yui-control-plane/i
  );
});

test("managed Task invocation rejects bare, candidate, and mismatched runtime control before state", (t) => {
  const { home, cliEntry, control, digest, runtime } = fixture(t);
  const schemaPath = join(home, "schema.json");
  const statePath = join(home, "state.json");
  const before = readFileSync(schemaPath, "utf8");
  const stateBefore = readFileSync(statePath, "utf8");
  const environment = {
    ...process.env,
    YUI_HOME: home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: runtime.taskId,
    YUI_ROLE: runtime.roleName,
    YUI_AGENT_ID: runtime.agentId,
    YUI_ADAPTER_ID: runtime.adapterId,
    YUI_WORKSPACE: runtime.workspace,
    YUI_RUN_ID: runtime.runId,
    YUI_LAUNCH_ID: runtime.launchId,
    YUI_NATIVE_SESSION_ID: runtime.nativeSessionId,
    [YUI_CONTROL_PLANE_DESCRIPTOR]: serializeExactDescriptor(control),
    [YUI_TASK_RUNTIME_DESCRIPTOR]: serializeExactDescriptor(runtime)
  };

  const bare = spawnSync(process.execPath, [cliEntry, "version"], {
    encoding: "utf8",
    env: environment
  });
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /exact control-plane invocation is required/i);
  assert.equal(readFileSync(schemaPath, "utf8"), before);
  assert.equal(readFileSync(statePath, "utf8"), stateBefore);

  const candidate = createExactControlPlaneDescriptor({
    ...control,
    cliEntry: join(home, "candidate", "dist", "cli.js")
  });
  const candidateDigest = exactControlPlaneDigest(candidate);
  const candidateRuntime = createExactTaskRuntimeDescriptor({
    ...runtime,
    controlPlaneDigest: candidateDigest
  });
  const wrongCli = spawnSync(process.execPath, [
    cliEntry,
    EXACT_CONTROL_ARGUMENT,
    candidateDigest,
    "version"
  ], {
    encoding: "utf8",
    env: {
      ...environment,
      [YUI_CONTROL_PLANE_DESCRIPTOR]: serializeExactDescriptor(candidate),
      [YUI_TASK_RUNTIME_DESCRIPTOR]: serializeExactDescriptor(candidateRuntime)
    }
  });
  assert.notEqual(wrongCli.status, 0);
  assert.match(wrongCli.stderr, /CLI entry.*does not match/i);
  assert.equal(readFileSync(schemaPath, "utf8"), before);
  assert.equal(readFileSync(statePath, "utf8"), stateBefore);

  const wrongRuntime = spawnSync(process.execPath, [
    cliEntry,
    EXACT_CONTROL_ARGUMENT,
    digest,
    "version"
  ], {
    encoding: "utf8",
    env: { ...environment, YUI_WORKSPACE: `${runtime.workspace}-stale` }
  });
  assert.notEqual(wrongRuntime.status, 0);
  assert.match(wrongRuntime.stderr, /Task runtime workspace.*does not match/i);
  assert.equal(readFileSync(schemaPath, "utf8"), before);
  assert.equal(readFileSync(statePath, "utf8"), stateBefore);

  const exact = spawnSync(process.execPath, [
    cliEntry,
    EXACT_CONTROL_ARGUMENT,
    digest,
    "version"
  ], { encoding: "utf8", env: environment });
  assert.equal(exact.status, 0, exact.stderr);
  assert.match(exact.stdout, /0\.4\.2/u);
  assert.equal(readFileSync(schemaPath, "utf8"), before);
  assert.equal(readFileSync(statePath, "utf8"), stateBefore);
});

test("managed Task invocation fails closed when both exact descriptors are absent", (t) => {
  const { home, cliEntry } = fixture(t);
  const statePath = join(home, "state.json");
  const stateBefore = readFileSync(statePath, "utf8");
  const invocation = spawnSync(process.execPath, [cliEntry, "version"], {
    encoding: "utf8",
    env: {
      ...process.env,
      YUI_HOME: home,
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: "task-15",
      YUI_ROLE: "worker",
      YUI_AGENT_ID: "claude",
      YUI_ADAPTER_ID: "claude",
      YUI_WORKSPACE: "/workspace/task-15",
      [YUI_CONTROL_PLANE_DESCRIPTOR]: undefined,
      [YUI_TASK_RUNTIME_DESCRIPTOR]: undefined
    }
  });

  assert.notEqual(invocation.status, 0);
  assert.match(invocation.stderr, /exact.*descriptor|exact control-plane invocation/i);
  assert.equal(readFileSync(statePath, "utf8"), stateBefore);
});

test("an existing pane resolves the current Run fence from one stable descriptor path", (t) => {
  const { home, digest, runtime } = fixture(t);
  const source = exactTaskRuntimeDescriptorPath(home, runtime);
  mkdirSync(join(home, "runtime", "exact-task-runtime"), { recursive: true });
  writeFileSync(source, `${serializeExactDescriptor(runtime)}\n`, { mode: 0o600 });
  const current = createExactTaskRuntimeDescriptor({
    ...runtime,
    runId: "agent-run-2",
    launchId: "launch-2",
    nativeSessionId: "native-2"
  });
  assert.equal(exactTaskRuntimeDescriptorPath(home, current), source);
  writeFileSync(source, `${serializeExactDescriptor(current)}\n`, { mode: 0o600 });

  const staleProcessEnvironment = {
    YUI_HOME: home,
    YUI_TASK_ID: runtime.taskId,
    YUI_ROLE: runtime.roleName,
    YUI_AGENT_ID: runtime.agentId,
    YUI_ADAPTER_ID: runtime.adapterId,
    YUI_WORKSPACE: runtime.workspace,
    YUI_RUN_ID: runtime.runId,
    YUI_LAUNCH_ID: runtime.launchId,
    YUI_NATIVE_SESSION_ID: runtime.nativeSessionId
  };
  assert.deepEqual(readExactTaskRuntimeDescriptorSource(source, home), current);
  assert.deepEqual(
    assertExactTaskRuntimeEnvironment(
      source,
      staleProcessEnvironment,
      digest,
      home
    ),
    current
  );

  const effective = {
    schemaVersion: 1,
    agentId: current.agentId,
    adapterId: current.adapterId,
    config: { adapterId: current.adapterId },
    workspace: {
      root: current.workspace,
      owner: { type: "task", taskId: current.taskId },
      projects: []
    }
  };
  const state = {
    getTask: () => ({ id: current.taskId, status: "active" }),
    getRole: () => ({ name: current.roleName, activeAgentId: current.agentId }),
    getActiveAgentRun: () => ({
      id: current.runId,
      status: "active",
      effective
    }),
    getTaskRoleSessionSet: () => ({
      activeAgentId: current.agentId,
      sessions: {
        [current.agentId]: {
          agentId: current.agentId,
          adapterId: current.adapterId,
          nativeSessionId: current.nativeSessionId,
          launchId: current.launchId,
          status: "running",
          effective
        }
      },
      inFlight: {
        agentId: current.agentId,
        runId: current.runId,
        receiptId: `agent-run:${current.taskId}/${current.runId}`
      }
    }),
    getWorkMailbox: () => null
  };
  assert.doesNotThrow(() => assertExactTaskRuntimeState(current, state));
  assert.throws(
    () => assertExactTaskRuntimeState(runtime, state),
    /Run.*current|runtime.*Run/i
  );
});

test("provider native discovery atomically refreshes the same runtime descriptor source", (t) => {
  const { home, runtime } = fixture(t);
  const discovering = createExactTaskRuntimeDescriptor({
    ...runtime,
    nativeSessionId: undefined
  });
  const source = exactTaskRuntimeDescriptorPath(home, discovering);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, `${serializeExactDescriptor(discovering)}\n`, { mode: 0o600 });
  const store = new FileTaskStore(home);

  assert.throws(
    () => assertExactTaskRuntimeState(discovering, store),
    /native Session fence is missing/i
  );
  const refreshed = refreshExactTaskRuntimeDescriptorSource(source, home, store);
  assert.equal(refreshed.nativeSessionId, runtime.nativeSessionId);
  assert.equal(exactTaskRuntimeDescriptorPath(home, refreshed), source);
  assert.deepEqual(readExactTaskRuntimeDescriptorSource(source, home), refreshed);
  assert.doesNotThrow(() => assertExactTaskRuntimeState(refreshed, store));
});

test("central preflight fences digest, Home, storage, and running Controller identity", async (t) => {
  const { home, cliEntry, control, digest } = fixture(t);
  const current = yuiVersionIdentity();
  const status = {
    running: true,
    pid: 42,
    protocolVersion: current.controllerProtocolVersion,
    version: current.version,
    storageLayoutVersion: current.storageLayoutVersion,
    aggregateSchemaVersion: current.aggregateSchemaVersion
  };
  const input = {
    serializedDescriptor: serializeExactDescriptor(control),
    digest,
    actualExecutable: process.execPath,
    actualCliEntry: cliEntry,
    actualHome: home
  };
  await assert.doesNotReject(assertExactControlPlanePreflight(input, {
    callController: async () => status
  }));
  await assert.rejects(
    assertExactControlPlanePreflight({ ...input, digest: "0".repeat(64) }, {
      callController: async () => status
    }),
    /digest does not match/i
  );
  await assert.rejects(
    assertExactControlPlanePreflight({ ...input, actualHome: join(home, "other") }, {
      callController: async () => status
    }),
    /YUI_HOME does not match/i
  );
  await assert.rejects(
    assertExactControlPlanePreflight(input, {
      inspectStorage: () => ({
        status: "current",
        currentLayoutVersion: current.storageLayoutVersion,
        currentAggregateSchemaVersion: current.aggregateSchemaVersion - 1
      }),
      callController: async () => status
    }),
    /aggregate schema.*does not match/i
  );
  await assert.rejects(
    assertExactControlPlanePreflight(input, {
      callController: async () => ({ ...status, aggregateSchemaVersion: 15 })
    }),
    /Controller aggregate schema.*incompatible/i
  );
  await assert.doesNotReject(assertExactControlPlanePreflight(input, {
    callController: async () => {
      throw new ControllerClientError("CONTROLLER_NOT_RUNNING", "not running");
    }
  }));
});

test("managed compatible continuity ignores only package-version drift", async (t) => {
  const { home, cliEntry, control, digest } = fixture(t);
  const current = yuiVersionIdentity();
  const replacement = { ...current, version: `${current.version}-replacement` };
  const status = {
    running: true,
    protocolVersion: current.controllerProtocolVersion,
    version: replacement.version,
    storageLayoutVersion: current.storageLayoutVersion,
    aggregateSchemaVersion: current.aggregateSchemaVersion
  };
  const input = {
    serializedDescriptor: serializeExactDescriptor(control),
    digest,
    actualExecutable: process.execPath,
    actualCliEntry: cliEntry,
    actualHome: home
  };
  const preflight = (identity, controller = status) => assertExactControlPlanePreflight(input, {
    identity,
    callController: async () => controller
  });

  await assert.doesNotReject(preflight(replacement));
  for (const [field, value] of [
    ["controllerProtocolVersion", current.controllerProtocolVersion + 1],
    ["storageLayoutVersion", current.storageLayoutVersion + 1],
    ["aggregateSchemaVersion", current.aggregateSchemaVersion + 1]
  ]) {
    await assert.rejects(
      preflight({ ...replacement, [field]: value }),
      new RegExp(field, "i")
    );
  }
  for (const [field, value, label] of [
    ["protocolVersion", current.controllerProtocolVersion + 1, "protocol"],
    ["storageLayoutVersion", current.storageLayoutVersion + 1, "storage layout"],
    ["aggregateSchemaVersion", current.aggregateSchemaVersion + 1, "aggregate schema"]
  ]) {
    await assert.rejects(
      preflight(replacement, { ...status, [field]: value }),
      new RegExp(`Controller ${label}.*incompatible`, "i")
    );
  }
  await assert.rejects(
    preflight(replacement, { ...status, version: null }),
    /Controller version is invalid/i
  );
});

test("an existing exact managed Session can yield after a compatible package replacement", (t) => {
  const { home, runtime, store } = fixture(t, "leader");
  const run = store.getAgentRun(runtime.taskId, runtime.runId);
  assert.notEqual(run, null);
  store.saveAgentRun({
    ...run,
    pushedAt: "2026-08-09T00:00:01.000Z"
  });
  store.transaction((tx) => {
    const target = {
      kind: "role",
      taskId: runtime.taskId,
      roleName: runtime.roleName
    };
    const now = new Date("2026-08-09T00:00:00.000Z");
    enqueueWork(tx, target, "run-dispatched", now, [{
      type: "run",
      taskId: runtime.taskId,
      id: runtime.runId
    }]);
    const pending = tx.getWorkMailbox(target);
    tx.saveWorkMailbox(bindExecution(claimPending(pending, {
      batchId: "delivery-1",
      owner: "fixture-delivery",
      startedAt: now.toISOString()
    }), "delivery-1", {
      type: "run",
      taskId: runtime.taskId,
      id: runtime.runId
    }));
  });
  const current = yuiVersionIdentity();
  const invocation = exactTaskCliInvocation({
    home,
    store,
    taskId: runtime.taskId,
    roleName: runtime.roleName,
    controlIdentity: { ...current, version: `${current.version}-previous` }
  });
  try {
    const result = spawnSync(process.execPath, [
      invocation.cliEntry,
      ...invocation.prefix,
      "task", "run", "yield", runtime.runId,
      "--summary", "continued after compatible package replacement"
    ], {
      encoding: "utf8",
      env: invocation.environment,
      timeout: 10_000
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(store.getAgentRun(runtime.taskId, runtime.runId)?.status, "yielded");
    assert.equal(
      store.getAgentRun(runtime.taskId, runtime.runId)?.summary,
      "continued after compatible package replacement"
    );
  } finally {
    invocation.stopFixtureController();
  }
});

test("central preflight delegates record-only older storage to the compatible opener", async (t) => {
  const { home, cliEntry, control, digest } = fixture(t);
  const current = yuiVersionIdentity();
  const input = {
    serializedDescriptor: serializeExactDescriptor(control),
    digest,
    actualExecutable: process.execPath,
    actualCliEntry: cliEntry,
    actualHome: home
  };
  let openedHome;
  let validated = false;

  await assert.doesNotReject(assertExactControlPlanePreflight(input, {
    inspectStorage: () => ({
      status: "unsupported",
      incompatibleComponent: "record",
      direction: "older",
      currentLayoutVersion: current.storageLayoutVersion,
      currentAggregateSchemaVersion: current.aggregateSchemaVersion
    }),
    openCompatibleStore: (candidateHome) => {
      openedHome = candidateHome;
      return {
        getConfig() {
          validated = true;
          return {};
        }
      };
    },
    checkController: false
  }));
  assert.equal(openedHome, home);
  assert.equal(validated, true);
});

test("central preflight keeps every non-compatible storage state fail-closed", async (t) => {
  const { home, cliEntry, control, digest } = fixture(t);
  const current = yuiVersionIdentity();
  const input = {
    serializedDescriptor: serializeExactDescriptor(control),
    digest,
    actualExecutable: process.execPath,
    actualCliEntry: cliEntry,
    actualHome: home
  };
  const blocked = [
    { status: "uninitialized" },
    { status: "invalid" },
    {
      status: "unsupported",
      incompatibleComponent: "layout",
      direction: "older",
      currentLayoutVersion: current.storageLayoutVersion - 1,
      currentAggregateSchemaVersion: current.aggregateSchemaVersion
    },
    {
      status: "unsupported",
      incompatibleComponent: "aggregate",
      direction: "older",
      currentLayoutVersion: current.storageLayoutVersion,
      currentAggregateSchemaVersion: current.aggregateSchemaVersion - 1
    },
    {
      status: "unsupported",
      incompatibleComponent: "record",
      direction: "newer",
      currentLayoutVersion: current.storageLayoutVersion,
      currentAggregateSchemaVersion: current.aggregateSchemaVersion
    },
    {
      status: "unsupported",
      incompatibleComponent: "record",
      direction: "older",
      currentLayoutVersion: current.storageLayoutVersion - 1,
      currentAggregateSchemaVersion: current.aggregateSchemaVersion
    }
  ];
  let openCount = 0;
  for (const storage of blocked) {
    await assert.rejects(assertExactControlPlanePreflight(input, {
      inspectStorage: () => storage,
      openCompatibleStore: () => {
        openCount += 1;
        return { getConfig: () => ({}) };
      },
      checkController: false
    }), /storage is not current/i);
  }
  assert.equal(openCount, 0);

  await assert.rejects(assertExactControlPlanePreflight(input, {
    inspectStorage: () => ({
      status: "unsupported",
      incompatibleComponent: "record",
      direction: "older",
      currentLayoutVersion: current.storageLayoutVersion,
      currentAggregateSchemaVersion: current.aggregateSchemaVersion
    }),
    openCompatibleStore: () => {
      openCount += 1;
      throw new Error("compatible source declaration or shape is corrupted");
    },
    checkController: false
  }), /compatible source declaration or shape is corrupted/i);
  assert.equal(openCount, 1);
});
