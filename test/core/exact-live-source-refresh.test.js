import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
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
  YUI_CONTROL_PLANE_DESCRIPTOR,
  YUI_TASK_RUNTIME_DESCRIPTOR,
  createExactControlPlaneDescriptor,
  createExactTaskRuntimeDescriptor,
  exactControlPlaneDigest,
  exactTaskRuntimeDescriptorPath,
  readExactTaskRuntimeDescriptorSource,
  refreshReusedTaskRuntimeDescriptorSource,
  serializeExactDescriptor
} from "../../dist/runtime/exactControlPlane.js";
import { resolveProviderHookRunFence } from "../../dist/controller/providerHookRunFence.js";
import { refreshAppliedTaskRuntimeDescriptor } from "../../dist/controller/runtime.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { yuiVersionIdentity } from "../../dist/version.js";
import { createAgentRun } from "../helpers/effectiveLaunch.js";

function createFixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-live-source-"));
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
  const now = new Date("2026-08-09T00:00:00.000Z");
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent("claude", "claude", "claude-test", [], [], now);
  const task = activateTask(createTask("task-1", "live source", now, { cwd: home }), now);
  const role = createRole(task.id, "leader", [createRoleAgentBinding(agent)], agent.id, home, now);
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveRole(task.id, role);
  });
  return { home, cliEntry, control, digest, store, task, role, agent, now, effective };
}

function projectGeneration(fx, { runId, launchId, nativeSessionId, at }) {
  const when = at ?? fx.now;
  const run = createAgentRun(
    runId,
    fx.task.id,
    fx.role.name,
    runId === "agent-run-1" ? "new" : "resume",
    "project generation",
    when,
    { effective: fx.effective }
  );
  let sessions = createRoleSessionSet(
    { scope: "task", taskId: fx.task.id, roleName: fx.role.name },
    fx.agent.id,
    when
  );
  sessions = recordRoleAgentSession(sessions, {
    agentId: fx.agent.id,
    adapterId: fx.agent.adapterId,
    nativeSessionId,
    launchId,
    policy: "fixed",
    status: "running",
    effective: fx.effective
  }, when);
  sessions = bindTaskRoleRun(sessions, {
    agentId: fx.agent.id,
    runId,
    receiptId: `agent-run:${fx.task.id}/${runId}`
  }, when);
  fx.store.transaction((tx) => {
    tx.saveActiveAgentRun(run);
    tx.saveTaskRoleSessionSet(sessions);
  });
  return { run, sessions };
}

function descriptorFor(fx, { runId, launchId, nativeSessionId }) {
  return createExactTaskRuntimeDescriptor({
    controlPlaneDigest: fx.digest,
    taskId: fx.task.id,
    roleName: fx.role.name,
    agentId: fx.agent.id,
    adapterId: fx.agent.adapterId,
    workspace: fx.effective.workspace.root,
    ...(runId === undefined ? {} : { runId }),
    ...(launchId === undefined ? {} : { launchId }),
    ...(nativeSessionId === undefined ? {} : { nativeSessionId })
  });
}

function writeSource(fx, descriptor) {
  const source = exactTaskRuntimeDescriptorPath(fx.home, descriptor);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, `${serializeExactDescriptor(descriptor)}\n`, { mode: 0o600 });
  return source;
}

function hookEnvironment(fx, source) {
  return {
    YUI_HOME: fx.home,
    YUI_SESSION_SCOPE: "task",
    YUI_ADAPTER_ID: "claude",
    YUI_TASK_ID: fx.task.id,
    YUI_ROLE: fx.role.name,
    YUI_AGENT_ID: fx.agent.id,
    YUI_WORKSPACE: fx.effective.workspace.root,
    [YUI_TASK_RUNTIME_DESCRIPTOR]: source,
    [YUI_CONTROL_PLANE_DESCRIPTOR]: serializeExactDescriptor(fx.control)
  };
}

function historicalDescriptor(fx, index) {
  return createExactTaskRuntimeDescriptor({
    controlPlaneDigest: fx.digest,
    taskId: `history-task-${index}`,
    roleName: "worker",
    agentId: "claude",
    adapterId: "claude",
    workspace: fx.home,
    runId: `history-run-${index}`,
    launchId: `history-launch-${index}`,
    nativeSessionId: `history-native-${index}`
  });
}

test("a reused Hook advances its own stale exact source before the volatile fence", (t) => {
  const fx = createFixture(t);
  // The reused pane's source still carries the original run/launch generation.
  const stale = descriptorFor(fx, {
    runId: "agent-run-1",
    launchId: "launch-1",
    nativeSessionId: "native-1"
  });
  const source = writeSource(fx, stale);

  // The durable Run/inFlight/Role Session generation advances while the reused
  // native pane keeps its original process environment and descriptor source.
  projectGeneration(fx, {
    runId: "agent-run-2",
    launchId: "launch-2",
    nativeSessionId: "native-1"
  });

  const fence = resolveProviderHookRunFence(hookEnvironment(fx, source), "claude", "native-1");
  assert.equal(fence.runId, "agent-run-2");
  assert.equal(fence.launchId, "launch-2");
  assert.equal(fence.nativeSessionId, "native-1");

  const advanced = readExactTaskRuntimeDescriptorSource(source, fx.home);
  assert.equal(advanced.runId, "agent-run-2");
  assert.equal(advanced.launchId, "launch-2");
  assert.equal(advanced.nativeSessionId, "native-1");
  assert.equal(advanced.controlPlaneDigest, fx.digest);
  assert.equal(exactTaskRuntimeDescriptorPath(fx.home, advanced), source);
});

test("the Controller refresh writes only the current-control source and never reads history", (t) => {
  const fx = createFixture(t);
  projectGeneration(fx, {
    runId: "agent-run-2",
    launchId: "launch-2",
    nativeSessionId: "native-1"
  });

  // 160 unrelated valid historical descriptors plus 4 malformed files, all well
  // above the 154-descriptor floor observed in production.
  const directory = join(fx.home, "runtime", "exact-task-runtime");
  mkdirSync(directory, { recursive: true });
  const historical = [];
  for (let i = 0; i < 160; i++) {
    const descriptor = historicalDescriptor(fx, i);
    const path = exactTaskRuntimeDescriptorPath(fx.home, descriptor);
    const bytes = `${serializeExactDescriptor(descriptor)}\n`;
    writeFileSync(path, bytes, { mode: 0o600 });
    historical.push({ path, bytes });
  }
  const malformed = [];
  for (let i = 0; i < 4; i++) {
    const name = `${createHash("sha256").update(`malformed-${i}`).digest("hex")}.json`;
    const path = join(directory, name);
    const bytes = `{ "broken": ${i} `;
    writeFileSync(path, bytes, { mode: 0o600 });
    malformed.push({ path, bytes });
  }

  const planner = new FileRoleLaunchPlanner(fx.home, fx.store, { cliPath: fx.cliEntry });
  planner.refreshTaskRuntimeDescriptor({
    taskId: fx.task.id,
    roleName: fx.role.name,
    runId: "agent-run-2",
    launchId: "launch-2",
    nativeSessionId: "native-1",
    agentId: fx.agent.id,
    adapterId: fx.agent.adapterId,
    workspace: fx.effective.workspace.root
  });

  const currentSource = exactTaskRuntimeDescriptorPath(
    fx.home,
    descriptorFor(fx, {
      runId: "agent-run-2",
      launchId: "launch-2",
      nativeSessionId: "native-1"
    })
  );
  const current = readExactTaskRuntimeDescriptorSource(currentSource, fx.home);
  assert.equal(current.runId, "agent-run-2");
  assert.equal(current.launchId, "launch-2");
  for (const { path, bytes } of historical) {
    assert.equal(readFileSync(path, "utf8"), bytes, `historical source ${path} must not be rewritten`);
  }
  for (const { path, bytes } of malformed) {
    assert.equal(readFileSync(path, "utf8"), bytes, `malformed source ${path} must not be read or rewritten`);
  }
});

test("a stale Hook source cannot jump to a replacement native Session", (t) => {
  const fx = createFixture(t);
  const stale = descriptorFor(fx, {
    runId: "agent-run-1",
    launchId: "launch-1",
    nativeSessionId: "native-1"
  });
  const source = writeSource(fx, stale);

  // The durable generation advances to a replacement native Session.
  projectGeneration(fx, {
    runId: "agent-run-2",
    launchId: "launch-2",
    nativeSessionId: "native-2"
  });

  assert.throws(
    () => resolveProviderHookRunFence(hookEnvironment(fx, source), "claude", "native-1"),
    /replacement native Session|cannot jump/i
  );
  assert.deepEqual(readExactTaskRuntimeDescriptorSource(source, fx.home), stale);
});

test("history-scaled runtime refresh keeps a queued control callback inside the 3-second fairness boundary", async (t) => {
  const fx = createFixture(t);
  projectGeneration(fx, {
    runId: "agent-run-2",
    launchId: "launch-2",
    nativeSessionId: "native-1"
  });

  // 1600 unrelated valid historical descriptors, an order of magnitude above
  // the 154-descriptor production floor.
  const directory = join(fx.home, "runtime", "exact-task-runtime");
  mkdirSync(directory, { recursive: true });
  for (let i = 0; i < 1600; i++) {
    const descriptor = historicalDescriptor(fx, i);
    const path = exactTaskRuntimeDescriptorPath(fx.home, descriptor);
    writeFileSync(path, `${serializeExactDescriptor(descriptor)}\n`, { mode: 0o600 });
  }

  const planner = new FileRoleLaunchPlanner(fx.home, fx.store, { cliPath: fx.cliEntry });
  const input = {
    taskId: fx.task.id,
    roleName: fx.role.name,
    runId: "agent-run-2",
    launchId: "launch-2",
    nativeSessionId: "native-1",
    agentId: fx.agent.id,
    adapterId: fx.agent.adapterId,
    workspace: fx.effective.workspace.root
  };

  const started = Date.now();
  let callbackFiredAt = null;
  const callbackFired = new Promise((resolve) => {
    setImmediate(() => {
      callbackFiredAt = Date.now();
      resolve();
    });
  });

  // A drain batch of 64 semantic events, each refreshing the exact source.
  for (let i = 0; i < 64; i++) {
    refreshAppliedTaskRuntimeDescriptor(fx.store, planner, input);
  }

  await callbackFired;
  const elapsed = callbackFiredAt - started;
  assert.ok(
    elapsed < 3_000,
    `queued control callback delayed ${elapsed}ms beyond the 3s fairness boundary`
  );
});

test("reused source refresh is idempotent and preserves the stable path", (t) => {
  const fx = createFixture(t);
  const stale = descriptorFor(fx, {
    runId: "agent-run-1",
    launchId: "launch-1",
    nativeSessionId: "native-1"
  });
  const source = writeSource(fx, stale);
  projectGeneration(fx, {
    runId: "agent-run-2",
    launchId: "launch-2",
    nativeSessionId: "native-1"
  });

  const current = {
    runId: "agent-run-2",
    launchId: "launch-2",
    nativeSessionId: "native-1"
  };
  const first = refreshReusedTaskRuntimeDescriptorSource(source, fx.home, fx.store, current);
  const second = refreshReusedTaskRuntimeDescriptorSource(source, fx.home, fx.store, current);
  assert.deepEqual(second, first);
  assert.equal(second.controlPlaneDigest, fx.digest);
  assert.equal(exactTaskRuntimeDescriptorPath(fx.home, second), source);
  assert.deepEqual(readExactTaskRuntimeDescriptorSource(source, fx.home), second);
});

test("reused source refresh rejects an inline JSON descriptor", (t) => {
  const fx = createFixture(t);
  projectGeneration(fx, {
    runId: "agent-run-2",
    launchId: "launch-2",
    nativeSessionId: "native-1"
  });
  const inline = serializeExactDescriptor(descriptorFor(fx, {
    runId: "agent-run-1",
    launchId: "launch-1",
    nativeSessionId: "native-1"
  }));
  assert.throws(
    () => refreshReusedTaskRuntimeDescriptorSource(
      inline,
      fx.home,
      fx.store,
      { runId: "agent-run-2", launchId: "launch-2", nativeSessionId: "native-1" }
    ),
    /stable file source/i
  );
});
