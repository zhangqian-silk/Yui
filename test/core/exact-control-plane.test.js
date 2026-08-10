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
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { yuiVersionIdentity } from "../../dist/version.js";
import {
  TASK_FINAL_REVIEW_ARGUMENT,
  createTaskFinalReviewContract
} from "../../dist/review/taskFinalReviewContract.js";

function fixture(t, roleName = "worker", { projectBacked = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "yui-exact-control-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
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

test("exact Task-final CLI submits and accepts a metadata-only Project Candidate", (t) => {
  const { home, cliEntry, control, digest, runtime, store } = fixture(
    t,
    "leader",
    { projectBacked: true }
  );
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

  const accepted = spawnSync(process.execPath, [
    ...prefix,
    "task", "work", "accept", "work-item-1",
    "--summary", "exact metadata accepted"
  ], { encoding: "utf8", env: environment });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /Accepted Work Item/u);
  assert.equal(store.getWorkItem(runtime.taskId, "work-item-1").status, "completed");
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
  assert.match(exact.stdout, /0\.3\.0/u);
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
