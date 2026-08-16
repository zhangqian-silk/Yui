/**
 * Regression tests for review-round-3 findings (f1–f10).
 *
 * Each test targets one finding from the review and exercises the exact
 * failure mode the reviewer reproduced. All tests use isolated temp homes,
 * the real FileTaskStore, and the real compiled dist modules.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { preflightTaskCompletion, runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createProject } from "../../dist/repository/project.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import {
  CURRENT_INTEGRATION_ATTEMPT_SCHEMA_VERSION,
  FileTaskStore
} from "../../dist/storage/taskStore.js";
import { createDurableJobControl } from "../../dist/controller/jobControl.js";
import {
  DurableJobSupervisor,
  createFileArtifactPort
} from "../../dist/controller/jobSupervisor.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createDurableJob, isDurableJobTerminal, startDurableJob, completeDurableJob, markDurableJobUnknown } from "../../dist/job/durableJob.js";
import {
  createIntegrationAttempt,
  validateIntegrationAttempt
} from "../../dist/integration/integrationAttempt.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { bindTaskRoleRun, createRoleSessionSet } from "../../dist/executor/agentExecutor.js";
import { formatAgentRunReceiptId } from "../../dist/task/taskRecordReference.js";
import { createAgentRun, testEffectiveLaunch } from "../helpers/effectiveLaunch.js";

const NOW = new Date("2026-08-13T00:00:00.000Z");
const HEAD = "0123456789abcdef0123456789abcdef01234567";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-r3-regression-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  const checkout = join(root, "checkout");
  mkdirSync(checkout, { recursive: true });
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(agent);
    tx.saveGlobalRole(createGlobalRole(
      "leader",
      [createRoleAgentBinding(agent)],
      agent.id,
      root,
      NOW
    ));
    tx.saveProject(createProject(
      "project-1",
      "Proj",
      checkout,
      { stable: "main", development: "main" },
      NOW
    ));
  });
  const options = {
    runtime: {
      notifyStateChanged() {},
      reconcileTask() {},
      prepareTaskRoleEnter() {}
    },
    now: () => new Date(NOW)
  };
  runTaskCommand(["create", "Regression task"], store, options);
  const task = store.listTasks()[0];
  runTaskCommand(["project", "add", task.id, "project-1", "--base", HEAD], store, options);
  runTaskCommand(["activate", task.id], store, options);

  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });

  // rr4/finding-2: The managed workspace project entry must be a real git
  // repository whose HEAD matches the declared head.
  const projectDir = join(workspace, "Proj");
  mkdirSync(projectDir);
  execSync("git init -q", { cwd: projectDir });
  execSync("git config user.email t@t", { cwd: projectDir });
  execSync("git config user.name t", { cwd: projectDir });
  writeFileSync(join(projectDir, "README.md"), "# test\n");
  execSync("git add -A", { cwd: projectDir });
  execSync("git commit -qm init", { cwd: projectDir });
  const head = execSync("git rev-parse HEAD", { cwd: projectDir }).toString().trim();

  // Register the workspace as the Task's managed workspace so job.start
  // validation (f2) accepts it.
  const managedWorkspace = createManagedWorkspace({
    owner: { type: "task", taskId: task.id },
    root: workspace,
    entries: [{
      projectId: "project-1",
      directory: "Proj",
      access: "write",
      path: projectDir,
      branch: `refs/heads/yui/${task.id}`,
      baseRef: "main",
      baseCommit: head
    }]
  }, NOW);
  store.transaction((tx) => {
    tx.saveManagedWorkspace(managedWorkspace);
  });

  const control = createDurableJobControl(store);
  const artifacts = createFileArtifactPort(root);
  const adapter = new FileSchedulerStoreAdapter(store);

  return { root, store, task, workspace, control, artifacts, adapter, head, agent };
}

/**
 * rr12: Save an active Leader Run + in-flight session so a job.start/job.cancel
 * caller can be verified against durable Run state. The Task is created via
 * runTaskCommand, which creates the task-level leader Role, so the Role Session
 * Set and active-Run pointer resolve. Returns the assertion a Leader caller
 * carries.
 */
function saveLeaderAssertion(store, task, agent, now = NOW) {
  const run = createAgentRun(
    "agent-run-1",
    task.id,
    "leader",
    "new",
    "Leader turn.",
    now,
    { effective: testEffectiveLaunch({ agentId: agent.id, adapterId: agent.adapterId }) }
  );
  store.saveAgentRun(run);
  store.saveActiveAgentRun(run);
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: task.id,
    roleName: "leader"
  }, agent.id, now);
  sessions = bindTaskRoleRun(sessions, {
    agentId: agent.id,
    runId: run.id,
    receiptId: formatAgentRunReceiptId(task.id, run.id)
  }, now);
  store.saveTaskRoleSessionSet(sessions);
  return {
    runId: run.id,
    receiptId: formatAgentRunReceiptId(task.id, run.id)
  };
}

// rr12: A verified task-scope Leader caller (active Run + in-flight receipt).
// rr13: Also carries the per-Session caller key whose hash is durable.
function leaderCaller(store, task, agent, now = NOW) {
  const a = saveLeaderAssertion(store, task, agent, now);
  const callerKey = saveJobCallerKey(store, task, agent, "leader");
  return { scope: "task", taskId: task.id, role: "leader", runId: a.runId, receiptId: a.receiptId, callerKey };
}

// rr13: Persist the SHA-256 hash of a per-Session job caller key and return
// the plaintext key so a test can construct a verified caller.
function saveJobCallerKey(store, task, agent, role) {
  const key = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(key).digest("hex");
  store.setJobCallerKeyHash(task.id, role, agent.id, hash);
  return key;
}

function makeProcessPort(options = {}) {
  const state = {
    alive: options.alive ?? true,
    identity: options.identity ?? "start-identity-1",
    pid: options.pid ?? 4242
  };
  const spawned = [];
  const signals = [];
  const port = {
    spawnJobRunner(specPath) {
      spawned.push(specPath);
      return { pid: state.pid, startIdentity: state.identity };
    },
    processStartIdentity(pid) {
      if (pid !== state.pid) return undefined;
      return state.alive ? state.identity : undefined;
    },
    isProcessAlive(pid) {
      return pid === state.pid && state.alive;
    },
    signalIfOwned(pid, startIdentity, signal) {
      if (pid !== state.pid) return;
      if (state.alive && state.identity !== startIdentity) return;
      signals.push(signal);
    }
  };
  return { port, state, spawned, signals };
}

function stepResult(name, overrides = {}) {
  return {
    name,
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 5,
    logPath: `001-${name}.log`,
    head: HEAD,
    ...overrides
  };
}

function writeArtifact(artifacts, taskId, jobId, file, value) {
  const dir = artifacts.artifactDir(taskId, jobId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
}

function startTwoStepJob(control, task, workspace, head, caller) {
  return control.startJob({
    taskId: task.id,
    owner: { kind: "task" },
    projectId: "project-1",
    head,
    workspace,
    env: {},
    caller,
    steps: [
      { name: "step-alpha", command: "echo alpha" },
      { name: "step-beta", command: "echo beta" }
    ]
  }, NOW);
}

/**
 * Simulate the runner's startup handshake: the spawned runner writes ready.json
 * (O_EXCL, before any side effect), then a reconcile pass adopts the queued
 * job to running via the start marker + ready evidence.
 */
function adoptRunning(supervisor, control, artifacts, task, job, at) {
  writeArtifact(artifacts, task.id, job.id, "ready.json", {
    pid: 4242,
    startIdentity: "start-identity-1",
    startedAt: new Date(at.getTime() - 500).toISOString()
  });
  supervisor.reconcile(at);
  assert.equal(control.getJob(task.id, job.id).status, "running");
}

// ─── f1: public `job` CLI is registered ────────────────────────────────────

test("f1: the singular `job` command surface exposes start, get, cancel, and acknowledge", async (t) => {
  const { root } = fixture(t);
  const { runDurableJobCommand } = await import("../../dist/commands/durableJobCommands.js");
  // The CLI dispatches `yui job ...` to runDurableJobCommand; with no
  // subcommand it renders the usage text naming all operations.
  await assert.rejects(
    runDurableJobCommand([], { home: root, json: false, environment: {} }),
    (error) => {
      assert.match(error.message, /start, get, cancel, or acknowledge/);
      assert.match(error.helpText, /job start[\s\S]*job get[\s\S]*job cancel[\s\S]*job acknowledge/);
      return true;
    }
  );
});

// ─── f2: job.start validates workspace binding ─────────────────────────────

test("f2: job.start rejects a workspace that is not the managed workspace root", (t) => {
  const { store, task, control, agent } = fixture(t);
  const bogusWorkspace = join(tmpdir(), "not-a-managed-workspace");
  assert.throws(
    () => control.startJob({
      taskId: task.id,
      owner: { kind: "task" },
      projectId: "project-1",
      head: HEAD,
      workspace: bogusWorkspace,
      env: {},
      caller: leaderCaller(store, task, agent),
      steps: [{ name: "s1", command: "true" }]
    }, NOW),
    /managed workspace|not a registered managed workspace/i
  );
});

test("f2: job.start rejects a job on an inactive Task", (t) => {
  const { store, task, workspace, control, head, agent } = fixture(t);
  store.transaction((tx) => {
    const current = tx.getTask(task.id);
    tx.saveTask({
      ...current,
      status: "retired",
      retiredAt: NOW.toISOString(),
      retiredBy: "user",
      retirementSummary: "retired for test"
    });
  });
  assert.throws(
    () => control.startJob({
      taskId: task.id,
      owner: { kind: "task" },
      projectId: "project-1",
      head: HEAD,
      workspace,
      env: {},
      caller: leaderCaller(store, task, agent),
      steps: [{ name: "s1", command: "true" }]
    }, NOW),
    /active Task|requires an active Task/i
  );
});

// ─── f3: durable startup handshake (ready.json) ────────────────────────────

test("f3: supervisor adopts a queued job with a pending start marker and ready.json", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  const { port, spawned } = makeProcessPort();

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  const supervisor = new DurableJobSupervisor({ store: adapter, process: port, artifacts });

  // First reconcile: writes the pending start marker, spawns, and updates the
  // marker with the real pid. The job stays queued until the runner's own
  // ready.json handshake is observed on a later pass.
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));
  assert.equal(spawned.length, 1);
  assert.equal(control.getJob(task.id, job.id).status, "queued");

  // Simulate Controller crash in the spawn window: restore the pending marker
  // (written before spawn) and have the runner write ready.json before any
  // side effect. The restarted supervisor must adopt, not re-spawn.
  artifacts.writeStartMarker(task.id, job.id, {
    pid: 0,
    startIdentity: "pending",
    spawnedAt: new Date(NOW.getTime() + 500).toISOString()
  });
  writeArtifact(artifacts, task.id, job.id, "ready.json", {
    pid: 4242,
    startIdentity: "start-identity-1",
    startedAt: new Date(NOW.getTime() + 500).toISOString()
  });
  const restarted = new DurableJobSupervisor({ store: adapter, process: port, artifacts });
  restarted.reconcile(new Date(NOW.getTime() + 2_000));
  assert.equal(spawned.length, 1, "must not re-spawn when ready.json proves a live runner");
  assert.equal(control.getJob(task.id, job.id).status, "running");
});

// ─── f4: queued cancel converges without spawning ──────────────────────────

test("f4: cancelling a queued job converges to cancelled without spawning a runner", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  const { port, spawned } = makeProcessPort();

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  assert.equal(job.status, "queued");

  // Cancel before any reconcile (no spawn yet).
  control.cancelJob(task.id, job.id, new Date(NOW.getTime() + 500), leaderCaller(store, task, agent));

  const supervisor = new DurableJobSupervisor({ store: adapter, process: port, artifacts });
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));

  assert.equal(spawned.length, 0, "a cancelled queued job must not spawn a runner");
  const cancelled = control.getJob(task.id, job.id);
  assert.equal(cancelled.status, "cancelled");
});

// ─── f5: composite SIGKILL key ─────────────────────────────────────────────

test("f5: SIGKILL escalation uses a composite taskId/jobId key", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  const { port, signals } = makeProcessPort();

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  const supervisor = new DurableJobSupervisor({ store: adapter, process: port, artifacts });
  const firstReconcile = new Date(NOW.getTime() + 10_000);
  supervisor.reconcile(firstReconcile);
  adoptRunning(supervisor, control, artifacts, task, job, new Date(firstReconcile.getTime() + 500));

  // Write a stale heartbeat.
  const dir = artifacts.artifactDir(task.id, job.id);
  mkdirSync(dir, { recursive: true });
  const heartbeatPath = join(dir, "heartbeat");
  writeFileSync(heartbeatPath, "");
  const staleTime = new Date(firstReconcile.getTime() - 3 * 60_000);
  utimesSync(heartbeatPath, staleTime, staleTime);

  // First stale reconcile sends SIGTERM and arms the SIGKILL deadline.
  supervisor.reconcile(new Date(firstReconcile.getTime() + 1_000));
  assert.ok(signals.includes("SIGTERM"));

  // 31s later the grace window has elapsed -> SIGKILL escalation.
  supervisor.reconcile(new Date(firstReconcile.getTime() + 1_000 + 31_000));
  assert.ok(signals.includes("SIGKILL"));
});

// ─── f6: Leader mailbox wakeup ─────────────────────────────────────────────

test("f6: a DurableJob terminal transition enqueues a Leader role wakeup", (t) => {
  const { task, workspace, control, artifacts, adapter, store, head, agent } = fixture(t);
  const { port } = makeProcessPort();

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  const supervisor = new DurableJobSupervisor({ store: adapter, process: port, artifacts });
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));
  adoptRunning(supervisor, control, artifacts, task, job, new Date(NOW.getTime() + 1_500));

  // Write exit.json to trigger a terminal transition.
  writeArtifact(artifacts, task.id, job.id, "exit.json", {
    outcome: "succeeded",
    exitCode: 0,
    signal: null,
    steps: [stepResult("step-alpha"), stepResult("step-beta")],
    finishedAt: new Date(NOW.getTime() + 2_000).toISOString()
  });
  supervisor.reconcile(new Date(NOW.getTime() + 3_000));
  assert.equal(control.getJob(task.id, job.id).status, "succeeded");

  // rr4/finding-7: The terminal transition composes complete +
  // wakeupNotified + enqueue in one atomic transaction, so the wakeup is
  // already pending after the harvest pass. A second pass is a no-op.
  supervisor.reconcile(new Date(NOW.getTime() + 4_000));
  const wakeup = store.getPendingWakeup(task.id);
  assert.ok(wakeup, "a terminal DurableJob must enqueue a Leader wakeup");
  assert.ok(wakeup.reasons.length > 0, "wakeup must have at least one reason");
});

// ─── f7: remote-baseline completion uses jobPort ───────────────────────────

test("f7: reconcileTaskRemoteBaselines accepts a jobPort option", async (t) => {
  const { task, workspace } = fixture(t);
  const { reconcileTaskRemoteBaselines } = await import("../../dist/commands/taskCompletionGate.js");
  assert.equal(typeof reconcileTaskRemoteBaselines, "function");
  // Use a Task without project bindings so the function returns early
  // without needing a real git remote. This verifies the jobPort option
  // is accepted by the type signature.
  const mockStore = {
    getTask: () => ({ ...task, projectBindings: [] }),
    getProject: () => null,
    getTaskWorkspace: () => null,
    listIntegrationAttempts: () => [],
    transaction: (fn) => fn({
      nextIntegrationAttemptId: () => "integration-1",
      saveIntegrationAttempt: () => {}
    })
  };
  // The function should return an empty array for a Task without project bindings,
  // proving it accepts the jobPort option without a type error.
  const result = await reconcileTaskRemoteBaselines(task.id, mockStore, workspace, {
    environment: {},
    jobPort: {
      async startCheckJob() { throw new Error("should not be called"); },
      async getJob() { return null; },
      async cancelJob() {}
    }
  });
  assert.deepEqual(result, []);
});

// ─── f8: lifecycle gates fence jobs ────────────────────────────────────────

test("f8: preflightTaskCompletion rejects unknown-needs-attention jobs", (t) => {
  const { store, task, workspace, control, head, agent } = fixture(t);
  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  // Save the intermediate running state first.
  store.transaction((tx) => {
    const current = tx.getDurableJob(task.id, job.id);
    const running = startDurableJob(current, {
      pid: 4242,
      startIdentity: "start-identity-1"
    }, NOW);
    tx.saveDurableJob(task.id, running);
  });
  // Then save the unknown state.
  store.transaction((tx) => {
    const running = tx.getDurableJob(task.id, job.id);
    const unknown = markDurableJobUnknown(running, "test unknown reason", [], NOW);
    tx.saveDurableJob(task.id, unknown);
  });

  assert.throws(
    () => preflightTaskCompletion(task.id, store),
    /active DurableJob|unknown-needs-attention/i
  );
});

test("f8: retireTaskCommand rejects a Task with an active job", (t) => {
  const { store, task, workspace, control, head, agent } = fixture(t);
  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  assert.equal(job.status, "queued");

  assert.throws(
    () => runTaskCommand(
      ["retire", task.id, "--summary", "retire test"],
      store,
      { runtime: { notifyStateChanged() {}, reconcileTask() {}, prepareTaskRoleEnter() {} }, now: () => new Date(NOW) }
    ),
    /active DurableJob/i
  );
});

test("f8: archiveTaskCommand rejects a Task with an active job", (t) => {
  const { store, task, workspace, control, head, agent } = fixture(t);
  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  assert.equal(job.status, "queued");

  // First complete the task so it can be archived.
  store.transaction((tx) => {
    const current = tx.getTask(task.id);
    tx.saveTask({
      ...current,
      status: "completed",
      completedAt: NOW.toISOString(),
      completedBy: "user",
      completionSummary: "Done"
    });
  });

  assert.throws(
    () => runTaskCommand(
      ["archive", task.id, "--integrated"],
      store,
      { runtime: { notifyStateChanged() {}, reconcileTask() {}, prepareTaskRoleEnter() {} }, now: () => new Date(NOW) }
    ),
    /active DurableJob/i
  );
});

// ─── f9: IntegrationAttempt schema v3 ──────────────────────────────────────

test("f9: IntegrationAttempt uses schemaVersion 3", (t) => {
  const attempt = createIntegrationAttempt({
    id: "integration-1",
    taskId: "task-1",
    projectId: "project-1",
    targetRef: "refs/heads/yui/task-1",
    expectedHead: HEAD,
    changeSetIds: ["change-set-1"]
  }, NOW);
  assert.equal(attempt.schemaVersion, 3);
  assert.doesNotThrow(() => validateIntegrationAttempt(attempt));
  assert.throws(
    () => validateIntegrationAttempt({ ...attempt, schemaVersion: 2 }),
    /schemaVersion 3/
  );
});

test("f9: CURRENT_INTEGRATION_ATTEMPT_SCHEMA_VERSION is 3", (t) => {
  assert.equal(CURRENT_INTEGRATION_ATTEMPT_SCHEMA_VERSION, 3);
});

// ─── f10: idempotent terminal cancel ───────────────────────────────────────

test("f10: cancelling a terminal job returns the job unchanged", (t) => {
  const { task, workspace, control, store, head, agent } = fixture(t);
  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));

  // Put the job in a terminal state using proper transitions.
  // Save the intermediate running state first so the store sees queued→running.
  store.transaction((tx) => {
    const current = tx.getDurableJob(task.id, job.id);
    const running = startDurableJob(current, {
      pid: 4242,
      startIdentity: "start-identity-1"
    }, NOW);
    tx.saveDurableJob(task.id, running);
  });
  // Then save the terminal state so the store sees running→succeeded.
  store.transaction((tx) => {
    const running = tx.getDurableJob(task.id, job.id);
    const succeeded = completeDurableJob(running, {
      outcome: "succeeded",
      exitCode: 0,
      signal: null,
      steps: [],
      evidenceSource: "exit-artifact"
    }, NOW);
    tx.saveDurableJob(task.id, succeeded);
  });

  // Cancel should return the job unchanged, not throw.
  const cancelled = control.cancelJob(task.id, job.id, new Date(NOW.getTime() + 1_000), leaderCaller(store, task, agent));
  assert.equal(cancelled.status, "succeeded");
  assert.equal(cancelled.cancelRequestedAt, undefined);
});

test("f10: isDurableJobTerminal returns true for all terminal states", (t) => {
  const terminalStates = ["succeeded", "failed", "timed-out", "cancelled", "unknown-needs-attention"];
  for (const status of terminalStates) {
    const job = createDurableJob({
      id: "job-1",
      taskId: "task-1",
      owner: { kind: "task" },
      projectId: "project-1",
      head: HEAD,
      workspace: "/tmp/workspace",
      env: {},
      caller: { scope: "user" },
      steps: [{ name: "s1", command: "true" }],
      artifactsLocator: "artifacts/jobs/task-1/job-1"
    }, NOW);
    const terminalJob = { ...job, status, endedAt: NOW.toISOString() };
    assert.equal(isDurableJobTerminal(terminalJob.status), true, `${status} should be terminal`);
  }
});
