import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { createProject } from "../../dist/repository/project.js";
import { createDurableJobControl } from "../../dist/controller/jobControl.js";
import {
  DurableJobSupervisor,
  createFileArtifactPort
} from "../../dist/controller/jobSupervisor.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { bindTaskRoleRun, createRoleSessionSet } from "../../dist/executor/agentExecutor.js";
import { formatAgentRunReceiptId } from "../../dist/task/taskRecordReference.js";
import { createAgentRun, testEffectiveLaunch } from "../helpers/effectiveLaunch.js";

const NOW = new Date("2026-07-19T15:00:00.000Z");
const HEAD = "0123456789abcdef0123456789abcdef01234567";

/**
 * Build a real FileTaskStore with a single Project-backed Task and a
 * DurableJob control port. The supervisor store port is the production
 * FileSchedulerStoreAdapter, and the artifact port is the production
 * createFileArtifactPort rooted at an isolated temp home. Only the process
 * port is a fake, so we can drive liveness/startIdentity/signals
 * deterministically without spawning real detached runners.
 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-durable-sup-"));
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
  runTaskCommand(["create", "Durable job task"], store, options);
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

  // f2: job.start only accepts the Task's registered managed workspace root.
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

/**
 * Controllable fake process port. `alive` and `identity` drive the supervisor
 * liveness ladder; every signal request that passes the startIdentity guard is
 * recorded. `spawned` records each spawnJobRunner call.
 */
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
      // Mirror the production guard: only signal when the recorded identity
      // still owns the pid.
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
 * f3 startup handshake: the spawned runner writes ready.json before any side
 * effect; the next reconcile pass adopts the queued job to running.
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

test("supervisor restarts to a single spawn and harvests exit.json as the unique terminal", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  const { port, spawned } = makeProcessPort();

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  assert.equal(job.status, "queued");

  const supervisor = new DurableJobSupervisor({ store: adapter, process: port, artifacts });

  // First reconcile: writes the pending start marker and spawns exactly one
  // runner. The job stays queued until the runner's ready.json handshake.
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));
  assert.equal(spawned.length, 1);
  adoptRunning(supervisor, control, artifacts, task, job, new Date(NOW.getTime() + 1_500));

  // A second supervisor over the same store + artifacts (Controller restart)
  // must not re-spawn while the process is still alive.
  const restarted = new DurableJobSupervisor({ store: adapter, process: port, artifacts });
  restarted.reconcile(new Date(NOW.getTime() + 2_000));
  assert.equal(spawned.length, 1);
  assert.equal(control.getJob(task.id, job.id).status, "running");

  // exit.json is the authoritative terminal; harvested with exit-artifact evidence.
  writeArtifact(artifacts, task.id, job.id, "exit.json", {
    outcome: "succeeded",
    exitCode: 0,
    signal: null,
    steps: [stepResult("step-alpha"), stepResult("step-beta")],
    finishedAt: new Date(NOW.getTime() + 3_000).toISOString()
  });
  restarted.reconcile(new Date(NOW.getTime() + 4_000));
  const terminal = control.getJob(task.id, job.id);
  assert.equal(terminal.status, "succeeded");
  assert.equal(terminal.result.evidenceSource, "exit-artifact");
  assert.equal(terminal.result.steps.length, 2);

  // Idempotent: further reconciles neither re-spawn nor change the terminal.
  restarted.reconcile(new Date(NOW.getTime() + 5_000));
  restarted.reconcile(new Date(NOW.getTime() + 6_000));
  assert.equal(spawned.length, 1);
  assert.equal(control.getJob(task.id, job.id).status, "succeeded");
  assert.equal(control.getJob(task.id, job.id).result.evidenceSource, "exit-artifact");
});

test("supervisor cancel path writes the fence, sends SIGTERM, and settles on cancelled exit.json", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  const { port, signals } = makeProcessPort();

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  const supervisor = new DurableJobSupervisor({ store: adapter, process: port, artifacts });
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));
  adoptRunning(supervisor, control, artifacts, task, job, new Date(NOW.getTime() + 1_500));
  adoptRunning(supervisor, control, artifacts, task, job, new Date(NOW.getTime() + 1_500));

  // Operator requests cancel; cancelRequestedAt is set on the record.
  control.cancelJob(task.id, job.id, new Date(NOW.getTime() + 2_000), leaderCaller(store, task, agent));
  assert.notEqual(control.getJob(task.id, job.id).cancelRequestedAt, undefined);

  // Reconcile writes the cancel fence and sends exactly one SIGTERM.
  supervisor.reconcile(new Date(NOW.getTime() + 3_000));
  const cancelFence = join(artifacts.artifactDir(task.id, job.id), "cancel");
  assert.ok(existsSync(cancelFence), "cancel fence file should exist");
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(control.getJob(task.id, job.id).status, "running");

  // Runner acknowledges by writing a cancelled exit.json -> terminal cancelled.
  writeArtifact(artifacts, task.id, job.id, "exit.json", {
    outcome: "cancelled",
    exitCode: null,
    signal: null,
    steps: [stepResult("step-alpha")],
    finishedAt: new Date(NOW.getTime() + 4_000).toISOString()
  });
  supervisor.reconcile(new Date(NOW.getTime() + 5_000));
  assert.equal(control.getJob(task.id, job.id).status, "cancelled");
});

test("supervisor fails closed to unknown-needs-attention with no exit.json and no checkpoint", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  const { port, state, spawned } = makeProcessPort();

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  const supervisor = new DurableJobSupervisor({ store: adapter, process: port, artifacts });
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));
  adoptRunning(supervisor, control, artifacts, task, job, new Date(NOW.getTime() + 1_500));
  adoptRunning(supervisor, control, artifacts, task, job, new Date(NOW.getTime() + 1_500));

  // Process dies with no durable terminal evidence at all.
  state.alive = false;
  supervisor.reconcile(new Date(NOW.getTime() + 2_000));
  const dead = control.getJob(task.id, job.id);
  assert.equal(dead.status, "unknown-needs-attention");
  assert.equal(dead.result.outcome, "unknown-needs-attention");
  assert.ok(
    typeof dead.result.unknownReason === "string" && dead.result.unknownReason.length > 0,
    "unknownReason must be a non-empty string"
  );

  // The supervisor never blindly re-runs a fail-closed job.
  const spawnsAfterUnknown = spawned.length;
  supervisor.reconcile(new Date(NOW.getTime() + 3_000));
  supervisor.reconcile(new Date(NOW.getTime() + 4_000));
  assert.equal(spawned.length, spawnsAfterUnknown);
  assert.equal(control.getJob(task.id, job.id).status, "unknown-needs-attention");
});

test("supervisor treats a partial checkpoint as unknown rather than guessing an outcome", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  const { port, state } = makeProcessPort();

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  const supervisor = new DurableJobSupervisor({ store: adapter, process: port, artifacts });
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));
  adoptRunning(supervisor, control, artifacts, task, job, new Date(NOW.getTime() + 1_500));

  // A checkpoint covering only 1 of 2 planned steps is not proof of any
  // terminal outcome: the runner died mid-job.
  writeArtifact(artifacts, task.id, job.id, "checkpoint.json", {
    completedSteps: [stepResult("step-alpha")],
    updatedAt: new Date(NOW.getTime() + 1_500).toISOString()
  });
  state.alive = false;
  supervisor.reconcile(new Date(NOW.getTime() + 2_000));
  const settled = control.getJob(task.id, job.id);
  assert.equal(settled.status, "unknown-needs-attention");
  assert.ok(
    typeof settled.result.unknownReason === "string" && settled.result.unknownReason.length > 0
  );
});

test("supervisor proves succeeded from a checkpoint that covers every step", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  const { port, state } = makeProcessPort();

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  const supervisor = new DurableJobSupervisor({ store: adapter, process: port, artifacts });
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));
  adoptRunning(supervisor, control, artifacts, task, job, new Date(NOW.getTime() + 1_500));

  // No exit.json, but the checkpoint records both planned steps as successful.
  writeArtifact(artifacts, task.id, job.id, "checkpoint.json", {
    completedSteps: [stepResult("step-alpha"), stepResult("step-beta")],
    updatedAt: new Date(NOW.getTime() + 1_500).toISOString()
  });
  state.alive = false;
  supervisor.reconcile(new Date(NOW.getTime() + 2_000));
  const proven = control.getJob(task.id, job.id);
  assert.equal(proven.status, "succeeded");
  assert.equal(proven.result.evidenceSource, "checkpoint");
  assert.equal(proven.result.steps.length, 2);
});

test("supervisor proves failed from a checkpoint whose covered steps include a failure", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  const { port, state } = makeProcessPort();

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  const supervisor = new DurableJobSupervisor({ store: adapter, process: port, artifacts });
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));
  adoptRunning(supervisor, control, artifacts, task, job, new Date(NOW.getTime() + 1_500));

  writeArtifact(artifacts, task.id, job.id, "checkpoint.json", {
    completedSteps: [
      stepResult("step-alpha"),
      stepResult("step-beta", { exitCode: 7 })
    ],
    updatedAt: new Date(NOW.getTime() + 1_500).toISOString()
  });
  state.alive = false;
  supervisor.reconcile(new Date(NOW.getTime() + 2_000));
  const proven = control.getJob(task.id, job.id);
  assert.equal(proven.status, "failed");
  assert.equal(proven.result.evidenceSource, "checkpoint");
  assert.equal(proven.result.failedStep, "step-beta");
  assert.equal(proven.result.exitCode, 7);
});

test("idempotent creation returns the same job and yields a single spawn", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  const { port, spawned } = makeProcessPort();

  const first = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  const second = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);

  const supervisor = new DurableJobSupervisor({ store: adapter, process: port, artifacts });
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));
  supervisor.reconcile(new Date(NOW.getTime() + 2_000));
  assert.equal(spawned.length, 1);
  assert.equal(control.getJob(task.id, first.job.id).status, "running");
});

test("stale heartbeat escalates from SIGTERM to SIGKILL after the grace window", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  const { port, signals } = makeProcessPort();

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  const supervisor = new DurableJobSupervisor({ store: adapter, process: port, artifacts });
  const firstReconcile = new Date(NOW.getTime() + 10_000);
  supervisor.reconcile(firstReconcile);
  adoptRunning(supervisor, control, artifacts, task, job, new Date(firstReconcile.getTime() + 500));

  // Write a heartbeat file whose mtime is 3 minutes before the reconcile clock:
  // that is beyond the 2-minute staleness threshold.
  const dir = artifacts.artifactDir(task.id, job.id);
  mkdirSync(dir, { recursive: true });
  const heartbeatPath = join(dir, "heartbeat");
  writeFileSync(heartbeatPath, "");
  const staleTime = new Date(firstReconcile.getTime() - 3 * 60_000);
  utimesSync(heartbeatPath, staleTime, staleTime);

  // First stale reconcile sends SIGTERM and arms the SIGKILL deadline.
  supervisor.reconcile(new Date(firstReconcile.getTime() + 1_000));
  assert.ok(signals.includes("SIGTERM"), "SIGTERM should be sent for a stale heartbeat");
  assert.ok(!signals.includes("SIGKILL"), "SIGKILL must not fire before the grace window");

  // 31s later the grace window has elapsed -> SIGKILL escalation.
  supervisor.reconcile(new Date(firstReconcile.getTime() + 1_000 + 31_000));
  assert.ok(signals.includes("SIGKILL"), "SIGKILL should escalate after the grace window");
});

// ---------------------------------------------------------------------------
// rr5 findings
// ---------------------------------------------------------------------------

test("f1: queued cancel with a spawned runner signals SIGTERM in the same reconcile pass", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  const { port, signals } = makeProcessPort();

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  const supervisor = new DurableJobSupervisor({ store: adapter, process: port, artifacts });

  // First reconcile: writes spec + start marker (real pid) and spawns.
  // The job stays queued until ready.json is written.
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));
  assert.equal(control.getJob(task.id, job.id).status, "queued");

  // Operator cancels while the job is still queued (before ready.json).
  control.cancelJob(task.id, job.id, new Date(NOW.getTime() + 2_000), leaderCaller(store, task, agent));

  // The same reconcile pass must signal the spawned runner AND adopt to
  // running — not terminalize to cancelled without signaling.
  supervisor.reconcile(new Date(NOW.getTime() + 3_000));
  assert.ok(signals.includes("SIGTERM"), "SIGTERM must be sent in the same reconcile pass");
  assert.equal(
    control.getJob(task.id, job.id).status,
    "running",
    "job must be adopted to running, not terminalized without signaling"
  );

  // The cancel fence was written so the runner exits as cancelled.
  const cancelFence = join(artifacts.artifactDir(task.id, job.id), "cancel");
  assert.ok(existsSync(cancelFence), "cancel fence should exist");
});

test("f1: queued cancel with a pending marker and no ready.json re-spawns instead of terminalizing", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  const { port, spawned, signals } = makeProcessPort();

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));

  // Simulate a Controller crash after writing the pending marker but before
  // the spawn completed. No ready.json exists.
  const dir = artifacts.artifactDir(task.id, job.id);
  mkdirSync(dir, { recursive: true });
  writeArtifact(artifacts, task.id, job.id, "start.json", {
    pid: 0,
    startIdentity: "pending",
    spawnedAt: new Date(NOW.getTime() - 5_000).toISOString()
  });

  // Operator cancels the queued job.
  control.cancelJob(task.id, job.id, new Date(NOW.getTime()), leaderCaller(store, task, agent));

  const supervisor = new DurableJobSupervisor({ store: adapter, process: port, artifacts });
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));

  // The ambiguous spawn must NOT be terminalized. The supervisor re-spawns
  // so the new runner writes ready.json, sees the cancel fence, and exits
  // as cancelled without side effects.
  assert.equal(
    control.getJob(task.id, job.id).status,
    "queued",
    "ambiguous spawn must not be terminalized"
  );
  assert.equal(spawned.length, 1, "a new runner should be spawned");
  assert.equal(signals.length, 0, "no signal should be sent for an unconfirmed spawn");
});

test("f3: ready.json is authoritative over start.json when both exist", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  // The fake port must recognize the ready.json pid/identity as alive so
  // #adoptAndContinue does not fall through to #handleDeadProcess.
  const { port } = makeProcessPort({
    pid: 2222,
    identity: "identity-from-ready"
  });

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));

  // Write a start marker with pid A / identity X, and ready.json with
  // pid B / identity Y. The supervisor must adopt using ready.json.
  writeArtifact(artifacts, task.id, job.id, "start.json", {
    pid: 1111,
    startIdentity: "identity-from-marker",
    spawnedAt: new Date(NOW.getTime() - 5_000).toISOString()
  });
  writeArtifact(artifacts, task.id, job.id, "ready.json", {
    pid: 2222,
    startIdentity: "identity-from-ready",
    startedAt: new Date(NOW.getTime() - 4_000).toISOString()
  });

  const supervisor = new DurableJobSupervisor({ store: adapter, process: port, artifacts });
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));

  const adopted = control.getJob(task.id, job.id);
  assert.equal(adopted.status, "running");
  assert.equal(adopted.process.pid, 2222, "ready.json pid must win over start.json");
  assert.equal(
    adopted.process.startIdentity,
    "identity-from-ready",
    "ready.json startIdentity must win over start.json"
  );
});

test("f6: queued-never-started cancel is atomic with the Leader wakeup", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  const { port } = makeProcessPort();

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));

  // Cancel before any reconcile — no spawn marker exists.
  control.cancelJob(task.id, job.id, new Date(NOW.getTime()), leaderCaller(store, task, agent));

  const supervisor = new DurableJobSupervisor({ store: adapter, process: port, artifacts });
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));

  const cancelled = control.getJob(task.id, job.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(
    cancelled.wakeupNotified,
    true,
    "wakeupNotified must be set in the same transaction as the cancel"
  );
});

test("f7: supervisor delivers a terminal notice when a job reaches a terminal state", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  const { port } = makeProcessPort();
  const terminalNotices = [];

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  const supervisor = new DurableJobSupervisor({
    store: adapter,
    process: port,
    artifacts,
    terminalEvents: {
      deliverTerminalEvent(notice) {
        terminalNotices.push(notice);
      }
    }
  });

  supervisor.reconcile(new Date(NOW.getTime() + 1_000));
  adoptRunning(supervisor, control, artifacts, task, job, new Date(NOW.getTime() + 1_500));

  // Runner writes a succeeded exit.json.
  writeArtifact(artifacts, task.id, job.id, "exit.json", {
    outcome: "succeeded",
    exitCode: 0,
    signal: null,
    steps: [stepResult("step-alpha"), stepResult("step-beta")],
    finishedAt: new Date(NOW.getTime() + 3_000).toISOString()
  });
  supervisor.reconcile(new Date(NOW.getTime() + 4_000));

  assert.equal(control.getJob(task.id, job.id).status, "succeeded");
  assert.equal(terminalNotices.length, 1, "one terminal notice must be delivered");
  assert.equal(terminalNotices[0].taskId, task.id);
  assert.equal(terminalNotices[0].jobId, job.id);
  assert.equal(terminalNotices[0].status, "succeeded");
  assert.equal(terminalNotices[0].outcome, "succeeded");
});

test("f7: terminal notice is best-effort and does not fail the reconcile", (t) => {
  const { store, task, workspace, control, artifacts, adapter, head, agent } = fixture(t);
  const { port } = makeProcessPort();
  const errors = [];

  const { job } = startTwoStepJob(control, task, workspace, head, leaderCaller(store, task, agent));
  const supervisor = new DurableJobSupervisor({
    store: adapter,
    process: port,
    artifacts,
    terminalEvents: {
      deliverTerminalEvent() {
        throw new Error("inbox unavailable");
      }
    },
    onError: (error) => errors.push(error)
  });

  supervisor.reconcile(new Date(NOW.getTime() + 1_000));
  adoptRunning(supervisor, control, artifacts, task, job, new Date(NOW.getTime() + 1_500));

  writeArtifact(artifacts, task.id, job.id, "exit.json", {
    outcome: "succeeded",
    exitCode: 0,
    signal: null,
    steps: [stepResult("step-alpha")],
    finishedAt: new Date(NOW.getTime() + 3_000).toISOString()
  });

  // The reconcile must not throw even though the terminal port fails.
  supervisor.reconcile(new Date(NOW.getTime() + 4_000));
  assert.equal(control.getJob(task.id, job.id).status, "succeeded");
});
