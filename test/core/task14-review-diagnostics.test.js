import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createDurableJobControl } from "../../dist/controller/jobControl.js";
import {
  createDurableJob,
  isDurableJobTerminal,
  markDurableJobUnknown,
  startDurableJob
} from "../../dist/job/durableJob.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import {
  createFileArtifactPort,
  createLinuxProcessPort,
  DurableJobSupervisor
} from "../../dist/controller/jobSupervisor.js";
import { startFileTaskController } from "../../dist/controller/controller.js";
import { callController, ControllerClientError } from "../../dist/core/controllerClient.js";
import { openCompatibleFileTaskStore } from "../../dist/storage/compatibleTaskStore.js";
import { createProject } from "../../dist/repository/project.js";
import { ensureStorageSchema, STORAGE_SCHEMA_FILE } from "../../dist/storage/storageSchema.js";
import { FileTaskStore, STORAGE_STATE_FILE } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { runDurableJobCommand } from "../../dist/commands/durableJobCommands.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createWorkItem, updateWorkItemStatus } from "../../dist/workItem/workItem.js";
import { bindTaskRoleRun, createRoleSessionSet } from "../../dist/executor/agentExecutor.js";
import { formatAgentRunReceiptId } from "../../dist/task/taskRecordReference.js";
import { yieldAgentRun } from "../../dist/run/agentRun.js";
import { createAgentRun, testEffectiveLaunch } from "../helpers/effectiveLaunch.js";

const NOW = new Date("2026-08-13T00:00:00.000Z");
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const RUNNER = new URL("../../dist/job/jobRunner.js", import.meta.url);

function taskFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-task14-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const project = createProject(
    "project-1",
    "Project",
    checkout,
    { stable: "main", development: "main" },
    NOW
  );
  store.saveProject(project);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  const task = activateTask(createTask("task-1", "Task", NOW, {
    projectBindings: [{ projectId: project.id, directory: project.name, baseRef: HEAD }]
  }), NOW);
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    // rr4/finding-7: The terminal transition enqueues a Leader wakeup via the
    // work mailbox, which requires a Task-level leader Role to exist.
    tx.saveRole(task.id, createRole(
      task.id,
      "leader",
      [createRoleAgentBinding({ id: agent.id, adapterId: agent.adapterId })],
      agent.id,
      root,
      NOW
    ));
  });
  const workspace = join(root, "workspace");
  mkdirSync(workspace);

  // rr4/finding-2 + verification-gap: The managed workspace project entry
  // must be a real git repository whose HEAD matches the declared head.
  // job.start validation reads the physical HEAD and rejects drift.
  const projectDir = join(workspace, project.name);
  mkdirSync(projectDir);
  execSync("git init -q", { cwd: projectDir });
  execSync("git config user.email t@t", { cwd: projectDir });
  execSync("git config user.name t", { cwd: projectDir });
  writeFileSync(join(projectDir, "README.md"), "# test\n");
  execSync("git add -A", { cwd: projectDir });
  execSync("git commit -qm init", { cwd: projectDir });
  const head = execSync("git rev-parse HEAD", { cwd: projectDir }).toString().trim();

  const managedWorkspace = createManagedWorkspace({
    owner: { type: "task", taskId: task.id },
    root: workspace,
    entries: [{
      projectId: project.id,
      directory: project.name,
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

  return { root, store, task, project, workspace, checkout, head, agent };
}

/**
 * rr5/f5: Save an active Leader Run + in-flight session so the acknowledge
 * assertion can be verified. Returns the assertion the CLI would carry.
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

// rr12: A verified user-scope caller backed by a Leader assertion.
// rr13: user scope is rejected outright for job.start/job.cancel; this helper
// is retained only for negative tests that assert the rejection.
function userCaller(store, task, agent, now = NOW) {
  const a = saveLeaderAssertion(store, task, agent, now);
  return { scope: "user", leaderAssertion: a };
}

test("DurableJob start rejects a dangling WorkItem owner at the persisted boundary", (t) => {
  const { store, task, project, workspace, head, agent } = taskFixture(t);
  const control = createDurableJobControl(store);

  assert.throws(() => control.startJob({
    taskId: task.id,
    owner: { kind: "work-item", workItemId: "work-item-999" },
    projectId: project.id,
    head,
    workspace,
    env: {},
    caller: leaderCaller(store, task, agent),
    steps: [{ name: "check", command: "true" }]
  }, NOW), /Work Item.*not found|owner.*not found/iu);
});

test("DurableJob start cannot target the stable Project checkout at the persisted boundary", (t) => {
  const { store, task, project, checkout, head, agent } = taskFixture(t);
  const control = createDurableJobControl(store);

  assert.throws(() => control.startJob({
    taskId: task.id,
    owner: { kind: "task" },
    projectId: project.id,
    head,
    workspace: checkout,
    env: {},
    caller: leaderCaller(store, task, agent),
    steps: [{ name: "write", command: "touch should-not-run" }]
  }, NOW), /managed workspace|stable.*read.only/iu);
});

test("Task completion waits for its queued or running DurableJobs", (t) => {
  const { store, task, project, workspace, head, agent } = taskFixture(t);
  createDurableJobControl(store).startJob({
    taskId: task.id,
    owner: { kind: "task" },
    projectId: project.id,
    head,
    workspace,
    env: {},
    caller: leaderCaller(store, task, agent),
    steps: [{ name: "check", command: "true" }]
  }, NOW);

  assert.throws(() => runTaskCommand(
    ["complete", task.id, "--summary", "done"],
    store,
    {
      now: () => NOW,
      runtime: {
        notifyStateChanged() {},
        reconcileTask() {},
        prepareTaskRoleEnter() {}
      }
    }
  ), /active DurableJob|unsettled Job/iu);
});

test("a spawn-to-persist failure cannot start a second runner on reconciliation", (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  const control = createDurableJobControl(store);
  const artifacts = createFileArtifactPort(root);
  const adapter = new FileSchedulerStoreAdapter(store);
  const spawned = [];
  const processPort = {
    spawnJobRunner(specPath) {
      spawned.push(specPath);
      return { pid: 4200 + spawned.length, startIdentity: `start-${spawned.length}` };
    },
    processStartIdentity() { return undefined; },
    isProcessAlive() { return false; },
    signalIfOwned() {}
  };
  control.startJob({
    taskId: task.id,
    owner: { kind: "task" },
    projectId: project.id,
    head,
    workspace,
    env: {},
    caller: leaderCaller(store, task, agent),
    steps: [{ name: "side-effect", command: "true" }]
  }, NOW);
  let failFirstPersistence = true;
  const interruptedStore = {
    listAllDurableJobs: () => adapter.listAllDurableJobs(),
    transitionDurableJob(...args) {
      if (failFirstPersistence) {
        failFirstPersistence = false;
        throw new Error("simulated Controller loss after spawn");
      }
      return adapter.transitionDurableJob(...args);
    }
  };

  new DurableJobSupervisor({
    store: interruptedStore,
    process: processPort,
    artifacts
  }).reconcile(new Date(NOW.getTime() + 1_000));
  assert.equal(control.getJob(task.id, "job-1").status, "queued");
  new DurableJobSupervisor({
    store: adapter,
    process: processPort,
    artifacts
  }).reconcile(new Date(NOW.getTime() + 2_000));

  assert.equal(spawned.length, 1, "the same Job must not execute twice across this crash window");
});

test("terminal DurableJob transition persists wakeupNotified and enqueues without an error", (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  const control = createDurableJobControl(store);
  const artifacts = createFileArtifactPort(root);
  const errors = [];
  let alive = true;
  const processPort = {
    spawnJobRunner() {
      return { pid: 4242, startIdentity: "start-1" };
    },
    processStartIdentity() {
      return alive ? "start-1" : undefined;
    },
    isProcessAlive() {
      return alive;
    },
    signalIfOwned() {}
  };
  const { job } = control.startJob({
    taskId: task.id,
    owner: { kind: "task" },
    projectId: project.id,
    head,
    workspace,
    env: {},
    caller: leaderCaller(store, task, agent),
    steps: [{ name: "check", command: "true" }]
  }, NOW);
  const supervisor = new DurableJobSupervisor({
    store: new FileSchedulerStoreAdapter(store),
    process: processPort,
    artifacts,
    onError: (error) => errors.push(error)
  });
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));
  alive = false;
  const dir = artifacts.artifactDir(task.id, job.id);
  writeFileSync(join(dir, "exit.json"), `${JSON.stringify({
    outcome: "succeeded",
    exitCode: 0,
    signal: null,
    steps: [{
      name: "check",
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1,
      logPath: "001-check.log",
      head
    }],
    finishedAt: new Date(NOW.getTime() + 2_000).toISOString()
  })}\n`);
  supervisor.reconcile(new Date(NOW.getTime() + 2_000));
  supervisor.reconcile(new Date(NOW.getTime() + 3_000));

  assert.deepEqual(errors, []);
  assert.equal(control.getJob(task.id, job.id).wakeupNotified, true);
});

test("the declared StoredTask v14 to v15 compatible load supplies every new default", (t) => {
  const { root, task } = taskFixture(t);
  const manifestPath = join(root, STORAGE_SCHEMA_FILE);
  const statePath = join(root, STORAGE_STATE_FILE);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  manifest.recordVersions.storedTask = 14;
  delete manifest.recordVersions.durableJob;
  state.tasks[task.id].schemaVersion = 14;
  delete state.tasks[task.id].durableJobs;
  delete state.tasks[task.id].idHighWaterMarks.durableJob;
  delete state.tasks[task.id].jobCallerKeyHashes;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const compatible = openCompatibleFileTaskStore(root);
  assert.equal(compatible.getTask(task.id).id, task.id);
  assert.equal(compatible.nextDurableJobId(task.id), "job-1");
});

test("the declared StoredTask v15 to v16 compatible load supplies every new default", (t) => {
  const { root, task } = taskFixture(t);
  const manifestPath = join(root, STORAGE_SCHEMA_FILE);
  const statePath = join(root, STORAGE_STATE_FILE);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  manifest.recordVersions.storedTask = 15;
  state.tasks[task.id].schemaVersion = 15;
  delete state.tasks[task.id].jobCallerKeyHashes;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const compatible = openCompatibleFileTaskStore(root);
  assert.equal(compatible.getTask(task.id).id, task.id);
  assert.deepEqual(compatible.getJobCallerKeyHash(task.id, "leader", "agent-1"), null);
});

test("a timed-out step that ignores SIGTERM still reaches a bounded terminal result", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-task14-timeout-"));
  const artifactDir = join(root, "artifacts");
  const workspace = join(root, "workspace");
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(workspace);
  const specPath = join(artifactDir, "spec.json");
  writeFileSync(specPath, `${JSON.stringify({
    jobId: "job-1",
    taskId: "task-1",
    workspace,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    steps: [{
      name: "ignore-term",
      command: "trap '' TERM; while :; do sleep 1; done",
      timeoutMs: 100
    }],
    defaultStepTimeoutMs: 100,
    artifactDir,
    head: HEAD
  })}\n`);
  const child = spawn(process.execPath, [RUNNER.pathname, specPath], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    rmSync(root, { recursive: true, force: true });
  });

  await delay(1_000);
  assert.ok(
    existsSync(join(artifactDir, "exit.json")),
    "timeout must converge even when the command ignores SIGTERM"
  );
});

// ─── rr4/finding-2: forged-HEAD / drift rejection ─────────────────────────

test("job.start rejects a declared head that does not match the workspace HEAD", (t) => {
  const { store, task, project, workspace, head, agent } = taskFixture(t);
  const control = createDurableJobControl(store);
  const forged = "f".repeat(40);
  assert.notEqual(forged, head);
  assert.throws(() => control.startJob({
    taskId: task.id,
    owner: { kind: "task" },
    projectId: project.id,
    head: forged,
    workspace,
    env: {},
    caller: leaderCaller(store, task, agent),
    steps: [{ name: "check", command: "true" }]
  }, NOW), /does not match the workspace HEAD/iu);
});

test("rr7: a head-mismatch job.start rejection crosses the Controller socket as JOB_ERROR", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  const jobControl = createDurableJobControl(store);
  const controller = await startFileTaskController(root, schedulerStore, noDelivery, undefined, {
    intervalMs: 300_000,
    jobControl
  });
  t.after(async () => { await controller?.close(); });

  // A forged head is an expected job-domain rejection. Over the real socket
  // it must surface as JOB_ERROR with the actionable reason, not collapse to
  // INTERNAL_ERROR (rr7: plain Errors are folded by the Controller server).
  const forged = "f".repeat(40);
  assert.notEqual(forged, head);
  await assert.rejects(
    () => callController(root, "job.start", {
      taskId: task.id,
      owner: { kind: "task" },
      projectId: project.id,
      head: forged,
      workspace,
      env: {},
      caller: leaderCaller(store, task, agent),
      steps: [{ name: "check", command: "true" }]
    }),
    (error) => {
      assert.ok(error instanceof ControllerClientError);
      assert.equal(error.code, "JOB_ERROR");
      assert.match(error.message, /does not match the workspace HEAD/iu);
      return true;
    }
  );
});

// ─── rr4/finding-6: acknowledge unblocks lifecycle gates ──────────────────

test("an acknowledged unknown-needs-attention job no longer blocks Task completion", (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  const control = createDurableJobControl(store);
  const artifacts = createFileArtifactPort(root);
  const adapter = new FileSchedulerStoreAdapter(store);
  let alive = true;
  const processPort = {
    spawnJobRunner() { return { pid: 4242, startIdentity: "start-1" }; },
    processStartIdentity() { return alive ? "start-1" : undefined; },
    isProcessAlive() { return alive; },
    signalIfOwned() {}
  };
  const { job } = control.startJob({
    taskId: task.id,
    owner: { kind: "task" },
    projectId: project.id,
    head,
    workspace,
    env: {},
    caller: leaderCaller(store, task, agent),
    steps: [{ name: "check", command: "true" }]
  }, NOW);
  const supervisor = new DurableJobSupervisor({
    store: adapter,
    process: processPort,
    artifacts
  });
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));
  // Write ready.json so the job adopts to running.
  const dir = artifacts.artifactDir(task.id, job.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ready.json"), `${JSON.stringify({
    pid: 4242,
    startIdentity: "start-1",
    startedAt: new Date(NOW.getTime() + 500).toISOString()
  })}\n`);
  supervisor.reconcile(new Date(NOW.getTime() + 1_500));
  assert.equal(control.getJob(task.id, job.id).status, "running");
  // Process dies with no exit evidence → unknown-needs-attention.
  alive = false;
  supervisor.reconcile(new Date(NOW.getTime() + 2_000));
  const unknown = control.getJob(task.id, job.id);
  assert.equal(unknown.status, "unknown-needs-attention");
  // Before acknowledge: completion is blocked.
  assert.throws(() => runTaskCommand(
    ["complete", task.id, "--summary", "done"],
    store,
    {
      now: () => NOW,
      runtime: {
        notifyStateChanged() {},
        reconcileTask() {},
        prepareTaskRoleEnter() {}
      }
    }
  ), /active DurableJob/iu);
  // Acknowledge the unknown job with a verified Leader assertion.
  const assertion = saveLeaderAssertion(store, task, agent, new Date(NOW.getTime() + 2_500));
  control.acknowledgeJob(
    task.id,
    job.id,
    new Date(NOW.getTime() + 3_000),
    assertion
  );
  const acknowledged = control.getJob(task.id, job.id);
  assert.equal(acknowledged.status, "unknown-needs-attention");
  assert.notEqual(acknowledged.acknowledgedAt, undefined);
  // After acknowledge: completion is no longer blocked by this job.
  // (It may still block on other Task-level requirements, but not on the job.)
  assert.doesNotThrow(() => {
    try {
      runTaskCommand(
        ["complete", task.id, "--summary", "done"],
        store,
        {
          now: () => NOW,
          runtime: {
            notifyStateChanged() {},
            reconcileTask() {},
            prepareTaskRoleEnter() {}
          }
        }
      );
    } catch (error) {
      // The only acceptable errors are non-job-related (e.g. missing
      // integration requirements). A job-related error means the gate failed.
      if (/active DurableJob/iu.test(error.message)) throw error;
    }
  });
});

// ─── rr4/finding-5: WorkItem retire blocks on owned active jobs ───────────

test("retiring a Work Item with an active owned DurableJob is rejected", (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  const control = createDurableJobControl(store);
  // Create a WorkItem.
  const workItem = store.transaction((tx) => {
    const item = createWorkItem("work-item-1", task.id, {
      title: "Test work",
      writeProjectIds: [project.id]
    }, NOW);
    tx.saveWorkItem(task.id, item);
    // Register a WorkItem-owned managed workspace so job.start can resolve it.
    const workItemWorkspace = createManagedWorkspace({
      owner: { type: "work-item", taskId: task.id, workItemId: item.id },
      root: workspace,
      entries: [{
        projectId: project.id,
        directory: project.name,
        access: "write",
        path: join(workspace, project.name),
        branch: `refs/heads/yui/${task.id}/${item.id}`,
        baseRef: "main",
        baseCommit: head
      }]
    }, NOW);
    tx.saveManagedWorkspace(workItemWorkspace);
    return item;
  });
  // Start a job owned by this WorkItem.
  control.startJob({
    taskId: task.id,
    owner: { kind: "work-item", workItemId: workItem.id },
    projectId: project.id,
    head,
    workspace,
    env: {},
    caller: leaderCaller(store, task, agent),
    steps: [{ name: "check", command: "true" }]
  }, NOW);
  // Retire must be rejected.
  assert.throws(() => runTaskCommand(
    ["work", "retire", `${task.id}/${workItem.id}`, "--summary", "obsolete"],
    store,
    {
      now: () => NOW,
      environment: {
        YUI_SESSION_SCOPE: "task",
        YUI_TASK_ID: task.id,
        YUI_ROLE: "leader"
      },
      runtime: {
        notifyStateChanged() {},
        reconcileTask() {},
        prepareTaskRoleEnter() {}
      }
    }
  ), /active DurableJob/iu);
});

// ─── rr4/finding-7: one-reconcile terminal transition + wakeup ────────────

test("a terminal transition enqueues the Leader wakeup in the same reconcile", (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  const control = createDurableJobControl(store);
  const artifacts = createFileArtifactPort(root);
  const adapter = new FileSchedulerStoreAdapter(store);
  let alive = true;
  const processPort = {
    spawnJobRunner() { return { pid: 4242, startIdentity: "start-1" }; },
    processStartIdentity() { return alive ? "start-1" : undefined; },
    isProcessAlive() { return alive; },
    signalIfOwned() {}
  };
  const { job } = control.startJob({
    taskId: task.id,
    owner: { kind: "task" },
    projectId: project.id,
    head,
    workspace,
    env: {},
    caller: leaderCaller(store, task, agent),
    steps: [{ name: "check", command: "true" }]
  }, NOW);
  const supervisor = new DurableJobSupervisor({
    store: adapter,
    process: processPort,
    artifacts
  });
  supervisor.reconcile(new Date(NOW.getTime() + 1_000));
  // Write ready.json + exit.json before the next reconcile.
  const dir = artifacts.artifactDir(task.id, job.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ready.json"), `${JSON.stringify({
    pid: 4242,
    startIdentity: "start-1",
    startedAt: new Date(NOW.getTime() + 500).toISOString()
  })}\n`);
  writeFileSync(join(dir, "exit.json"), `${JSON.stringify({
    outcome: "succeeded",
    exitCode: 0,
    signal: null,
    steps: [{
      name: "check",
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1,
      logPath: "001-check.log",
      head
    }],
    finishedAt: new Date(NOW.getTime() + 2_000).toISOString()
  })}\n`);
  alive = false;
  // One reconcile must both adopt to running AND harvest the terminal.
  supervisor.reconcile(new Date(NOW.getTime() + 2_000));
  const terminal = control.getJob(task.id, job.id);
  assert.equal(terminal.status, "succeeded");
  assert.equal(terminal.wakeupNotified, true);
  // The pending wakeup must be set (the Leader will be woken).
  const pending = store.getPendingWakeup(task.id);
  assert.notEqual(pending, null);
});

// ─── rr5/f4(b): job.start rejects a terminal owner ───────────────────────

test("rr5/f4: job.start rejects a terminal WorkItem owner", (t) => {
  const { store, task, project, workspace, head, agent } = taskFixture(t);
  const control = createDurableJobControl(store);
  // Create a WorkItem and mark it completed (terminal).
  const workItem = store.transaction((tx) => {
    const item = createWorkItem("work-item-1", task.id, {
      title: "Terminal work",
      writeProjectIds: [project.id]
    }, NOW);
    const terminal = updateWorkItemStatus(item, "completed", NOW, "done");
    tx.saveWorkItem(task.id, terminal);
    // Register a WorkItem-owned managed workspace so job.start can resolve it.
    const workItemWorkspace = createManagedWorkspace({
      owner: { type: "work-item", taskId: task.id, workItemId: item.id },
      root: workspace,
      entries: [{
        projectId: project.id,
        directory: project.name,
        access: "write",
        path: join(workspace, project.name),
        branch: `refs/heads/yui/${task.id}/${item.id}`,
        baseRef: "main",
        baseCommit: head
      }]
    }, NOW);
    tx.saveManagedWorkspace(workItemWorkspace);
    return terminal;
  });
  assert.equal(workItem.status, "completed");
  // Starting a job owned by a terminal WorkItem must be rejected.
  assert.throws(() => control.startJob({
    taskId: task.id,
    owner: { kind: "work-item", workItemId: workItem.id },
    projectId: project.id,
    head,
    workspace,
    env: {},
    caller: leaderCaller(store, task, agent),
    steps: [{ name: "check", command: "true" }]
  }, NOW), /terminal/i);
});

// ─── rr5/f5(a): non-Leader acknowledge is rejected at the CLI boundary ───

test("rr5/f5: a non-Leader caller cannot acknowledge at the CLI boundary", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  const control = createDurableJobControl(store);
  // Create a job in unknown-needs-attention state.
  const { job } = control.startJob({
    taskId: task.id,
    owner: { kind: "task" },
    projectId: project.id,
    head,
    workspace,
    env: {},
    caller: leaderCaller(store, task, agent),
    steps: [{ name: "check", command: "true" }]
  }, NOW);
  // A plain user (no managed session env) is not the Leader.
  await assert.rejects(
    runDurableJobCommand(
      ["acknowledge", "--task", task.id, "--job", job.id],
      { home: root, json: false, environment: {}, store }
    ),
    /Only the Task Leader may acknowledge/iu
  );
  // A managed Task session that is not the Leader is also rejected.
  await assert.rejects(
    runDurableJobCommand(
      ["acknowledge", "--task", task.id, "--job", job.id],
      {
        home: root,
        json: false,
        environment: {
          YUI_SESSION_SCOPE: "task",
          YUI_TASK_ID: task.id,
          YUI_ROLE: "worker"
        },
        store
      }
    ),
    /Leader/iu
  );
});

// ─── rr5/f5(b): Controller rejects an invalid Leader assertion ───────────

test("rr5/f5: the Controller rejects acknowledge with a stale or wrong assertion", (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  const control = createDurableJobControl(store);
  const { job } = control.startJob({
    taskId: task.id,
    owner: { kind: "task" },
    projectId: project.id,
    head,
    workspace,
    env: {},
    caller: leaderCaller(store, task, agent),
    steps: [{ name: "check", command: "true" }]
  }, NOW);
  // The active Leader Run is agent-run-1 (created by the job.start caller);
  // an assertion carrying a wrong runId is rejected.
  saveLeaderAssertion(store, task, agent, new Date(NOW.getTime() + 2_000));
  assert.throws(
    () => control.acknowledgeJob(task.id, job.id, new Date(NOW.getTime() + 3_000), {
      runId: "agent-run-999",
      receiptId: formatAgentRunReceiptId(task.id, "agent-run-999")
    }),
    /UNAUTHORIZED|Leader/iu
  );
  // A valid assertion succeeds (the job is acknowledged). First transition
  // the job to unknown-needs-attention so acknowledge is legal.
  store.transaction((tx) => {
    const current = tx.getDurableJob(task.id, job.id);
    const running = startDurableJob(
      current,
      { pid: 4242, startIdentity: "start-identity-1" },
      new Date(NOW.getTime() + 400)
    );
    tx.saveDurableJob(task.id, running);
    const unknown = markDurableJobUnknown(
      running,
      "diagnostic unknown",
      [],
      new Date(NOW.getTime() + 500)
    );
    tx.saveDurableJob(task.id, unknown);
  });
  const assertion = saveLeaderAssertion(store, task, agent, new Date(NOW.getTime() + 4_000));
  const acknowledged = control.acknowledgeJob(
    task.id,
    job.id,
    new Date(NOW.getTime() + 5_000),
    assertion
  );
  assert.notEqual(acknowledged, null);
  assert.notEqual(acknowledged.acknowledgedAt, undefined);
});

test("rr26: job.acknowledge is Leader-only even for a Worker-owned Job", (t) => {
  const { store, task, project, workspace, head, agent } = taskFixture(t);
  const control = createDurableJobControl(store);
  const item = saveWorkItemWithWorkspace(store, task, project, workspace, head, "work-item-1");
  const owner = { kind: "work-item", workItemId: item.id };
  const job = createDurableJob({
    id: store.nextDurableJobId(task.id),
    taskId: task.id,
    owner,
    projectId: project.id,
    head,
    workspace,
    env: {},
    steps: [{ name: "check", command: "true" }],
    artifactsLocator: `artifacts/jobs/${task.id}/worker-owned`
  }, NOW);
  const running = startDurableJob(
    job,
    { pid: 4242, startIdentity: "worker-owned" },
    new Date(NOW.getTime() + 100)
  );
  const unknown = markDurableJobUnknown(
    running,
    "worker-owned unknown",
    [],
    new Date(NOW.getTime() + 200)
  );
  store.saveDurableJob(task.id, unknown);

  const workerRun = createAgentRun(
    "agent-run-2",
    task.id,
    "worker",
    "new",
    "Worker turn.",
    NOW,
    {
      workItemId: owner.workItemId,
      effective: testEffectiveLaunch({ agentId: agent.id, adapterId: agent.adapterId })
    }
  );
  store.saveAgentRun(workerRun);
  store.saveActiveAgentRun(workerRun);
  const workerKey = saveJobCallerKey(store, task, agent, "worker");

  assert.throws(
    () => control.acknowledgeJob(task.id, job.id, new Date(NOW.getTime() + 300), {
      scope: "task",
      taskId: task.id,
      role: "worker",
      runId: workerRun.id,
      callerKey: workerKey
    }),
    /Leader|UNAUTHORIZED/iu
  );
});

// ─── rr6/f1: bounded supervision wake after spawn and on runner exit ──────

// A no-op delivery stand-in. taskFixture creates a leader Role (required so
// the terminal transition's wakeup enqueue can target the leader mailbox),
// but the Task has no cwd, so isSchedulerTaskWorkspaceReady is false and
// processLeaderWakeups skips before any tmux call. Robust shapes keep the
// pass green even if a future pass probes delivery.
//
// rr12: The caller-binding helpers save an ACTIVE Leader Run + in-flight
// Role Session. A successful socket job.start fires runtime.signal, whose
// scheduler tick runs reconcileExitedRoleRuns; that path inspects every
// active Run and reaps any whose role reports "absent". The fixture's Leader
// Run is a durable test fixture, not a real tmux session, so inspectRole
// reports "present" to keep it alive across the tick.
const noDelivery = {
  async prepareRoleSession(input) {
    return {
      deliveryId: `delivery-${input.runId ?? "pending"}`,
      taskId: input.taskId,
      roleName: input.roleName,
      agentId: input.agentId,
      adapterId: input.adapterId,
      mode: input.mode,
      sessionStarted: false,
      session: undefined,
      inputSubmittedAtLaunch: false
    };
  },
  async waitUntilReady(prepared) { return { prepared, session: null }; },
  async sendOnce() { return "unavailable"; },
  async inspectRole() { return "present"; }
};

test("rr6/f1: a quick job reaches running then terminal via the bounded wake, not the recovery interval", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  const jobControl = createDurableJobControl(store);
  const errors = [];
  let runtime;
  const jobSupervisor = new DurableJobSupervisor({
    store: schedulerStore,
    process: createLinuxProcessPort(),
    artifacts: createFileArtifactPort(root),
    // rr6/f1: the bounded wake. The composition root wires this to the
    // Controller signal; here we close over the runtime assigned below.
    wake: (taskId) => {
      try { runtime?.signal(`task:${taskId}`); } catch { /* stopped */ }
    },
    onError: (error) => errors.push(error)
  });
  // A 300s recovery interval means the ONLY path to terminal is the bounded
  // supervision wake (post-spawn adoption + runner-exit harvest), never the
  // long recovery timer.
  const controller = await startFileTaskController(root, schedulerStore, noDelivery, undefined, {
    intervalMs: 300_000,
    jobSupervisor,
    jobControl,
    onError: (error) => errors.push(error)
  });
  t.after(async () => { await controller?.close(); });
  runtime = controller.runtime;

  // Start a quick job through the real Controller socket. The job.start
  // handler signals once; everything after that is driven by the supervisor's
  // own bounded wakes — no scheduler.scan, no supervisor.reconcile.
  const started = await callController(root, "job.start", {
    taskId: task.id,
    owner: { kind: "task" },
    projectId: project.id,
    head,
    workspace,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    caller: leaderCaller(store, task, agent),
    steps: [{ name: "check", command: "true" }]
  });
  const jobId = started.job.id;

  const deadline = Date.now() + 15_000;
  let terminal;
  for (;;) {
    const current = store.getDurableJob(task.id, jobId);
    if (current !== null && isDurableJobTerminal(current.status)) {
      terminal = current;
      break;
    }
    if (Date.now() >= deadline) break;
    await delay(25);
  }

  assert.ok(
    terminal,
    "job must reach a terminal state via the bounded wake, not the 300s recovery interval"
  );
  assert.equal(terminal.status, "succeeded");
  assert.equal(terminal.wakeupNotified, true);
  // The job passed through running: the queued→running transition persisted
  // the process identity, which completeDurableJob preserves.
  assert.notEqual(terminal.process, undefined);
  assert.deepEqual(errors, []);
});

// ─── rr8: caller identity binding for job.start / job.cancel ──────────────

/**
 * rr8: Save a WorkItem and its managed workspace so a work-item-owned
 * job.start can resolve the owner and workspace.
 */
function saveWorkItemWithWorkspace(store, task, project, workspace, head, workItemId, now = NOW) {
  return store.transaction((tx) => {
    const item = createWorkItem(workItemId, task.id, {
      title: `Work ${workItemId}`,
      writeProjectIds: [project.id]
    }, now);
    tx.saveWorkItem(task.id, item);
    const ws = createManagedWorkspace({
      owner: { type: "work-item", taskId: task.id, workItemId: item.id },
      root: workspace,
      entries: [{
        projectId: project.id,
        directory: project.name,
        access: "write",
        path: join(workspace, project.name),
        branch: `refs/heads/yui/${task.id}/${item.id}`,
        baseRef: "main",
        baseCommit: head
      }]
    }, now);
    tx.saveManagedWorkspace(ws);
    return item;
  });
}

/**
 * rr8/rr12: Save a managed Run (Worker or Reviewer) so the Controller can
 * verify the caller's Role against durable Run state. A Reviewer Run carries
 * no Work Item; a Worker Run is bound to its Work Item.
 */
function saveManagedRun(store, task, agent, runId, role, workItemId, now = NOW) {
  const run = createAgentRun(
    runId, task.id, role, "new", `${role} turn.`, now,
    {
      ...(workItemId === undefined ? {} : { workItemId }),
      effective: testEffectiveLaunch({ agentId: agent.id, adapterId: agent.adapterId })
    }
  );
  store.saveAgentRun(run);
  return run;
}

/**
 * rr8: Save a Worker Run bound to a Work Item so the Controller can verify
 * the caller's Work Item scope.
 */
function saveWorkerRun(store, task, agent, runId, workItemId, now = NOW) {
  return saveManagedRun(store, task, agent, runId, "worker", workItemId, now);
}

/**
 * rr12: Save a Reviewer Run so a reviewer-caller rejection exercises the
 * reviewer-rejection branch (not the run-not-found branch).
 */
function saveReviewerRun(store, task, agent, runId, now = NOW) {
  return saveManagedRun(store, task, agent, runId, "reviewer", undefined, now);
}

/**
 * rr8: Start a Controller with jobControl for the caller-binding socket tests.
 */
async function startJobController(t, root, store) {
  const schedulerStore = new FileSchedulerStoreAdapter(store);
  const jobControl = createDurableJobControl(store);
  const controller = await startFileTaskController(root, schedulerStore, noDelivery, undefined, {
    intervalMs: 300_000,
    jobControl
  });
  t.after(async () => { await controller?.close(); });
  return jobControl;
}

function taskStartParams(task, project, workspace, head, owner, caller) {
  return {
    taskId: task.id,
    owner,
    projectId: project.id,
    head,
    workspace,
    env: {},
    steps: [{ name: "check", command: "true" }],
    caller
  };
}

test("rr8: a Reviewer cannot start a job over the Controller socket", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  // rr12: Save a REAL Reviewer Run so the rejection exercises the
  // reviewer-rejection branch, not the run-not-found branch.
  const reviewerRun = saveReviewerRun(store, task, agent, "agent-run-10");
  // rr13: A valid caller key is required to reach the reviewer-rejection
  // branch (the key check precedes the role check).
  const reviewerKey = saveJobCallerKey(store, task, agent, "reviewer");
  await assert.rejects(
    () => callController(root, "job.start", taskStartParams(
      task, project, workspace, head,
      { kind: "task" },
      { scope: "task", taskId: task.id, role: "reviewer", runId: reviewerRun.id, callerKey: reviewerKey }
    )),
    (error) => {
      assert.ok(error instanceof ControllerClientError);
      assert.equal(error.code, "UNAUTHORIZED");
      return true;
    }
  );
});

test("rr8: a Reviewer cannot cancel a job over the Controller socket", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  // A verified Leader caller creates the job (full access).
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    leaderCaller(store, task, agent)
  ));
  // rr12: A REAL Reviewer Run must still be rejected (reviewer-rejection
  // branch, not run-not-found).
  const reviewerRun = saveReviewerRun(store, task, agent, "agent-run-10");
  const reviewerKey = saveJobCallerKey(store, task, agent, "reviewer");
  await assert.rejects(
    () => callController(root, "job.cancel", {
      taskId: task.id,
      jobId: started.job.id,
      caller: { scope: "task", taskId: task.id, role: "reviewer", runId: reviewerRun.id, callerKey: reviewerKey }
    }),
    (error) => {
      assert.ok(error instanceof ControllerClientError);
      assert.equal(error.code, "UNAUTHORIZED");
      return true;
    }
  );
});

test("rr8: a Worker cannot start a job for a foreign Work Item", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  // The caller's Run is for work-item-1; the declared owner is work-item-2.
  saveWorkItemWithWorkspace(store, task, project, workspace, head, "work-item-1");
  saveWorkItemWithWorkspace(store, task, project, workspace, head, "work-item-2");
  saveWorkerRun(store, task, agent, "agent-run-20", "work-item-1");
  const workerKey = saveJobCallerKey(store, task, agent, "worker");
  await assert.rejects(
    () => callController(root, "job.start", taskStartParams(
      task, project, workspace, head,
      { kind: "work-item", workItemId: "work-item-2" },
      { scope: "task", taskId: task.id, role: "worker", runId: "agent-run-20", callerKey: workerKey }
    )),
    (error) => {
      assert.ok(error instanceof ControllerClientError);
      assert.equal(error.code, "UNAUTHORIZED");
      return true;
    }
  );
});

test("rr8: a Worker can start a job for its own Work Item", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  saveWorkItemWithWorkspace(store, task, project, workspace, head, "work-item-1");
  saveWorkerRun(store, task, agent, "agent-run-20", "work-item-1");
  const workerKey = saveJobCallerKey(store, task, agent, "worker");
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "work-item", workItemId: "work-item-1" },
    { scope: "task", taskId: task.id, role: "worker", runId: "agent-run-20", callerKey: workerKey }
  ));
  assert.equal(started.created, true);
  assert.equal(started.job.owner.kind, "work-item");
  assert.equal(started.job.owner.workItemId, "work-item-1");
});

test("rr8: a Leader can start a job for any owner", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  // rr12: A REAL verified Leader (active Run + in-flight receipt), not a
  // borrowed/forged runId.
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    leaderCaller(store, task, agent)
  ));
  assert.equal(started.created, true);
  assert.equal(started.job.owner.kind, "task");
});

test("rr13: a user-scope caller is rejected for job.start (fail-closed)", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  // rr13: user scope has no per-Session channel binding; every durable-state
  // claim it could carry is replayable. Reject outright.
  await assert.rejects(
    () => callController(root, "job.start", taskStartParams(
      task, project, workspace, head,
      { kind: "task" },
      userCaller(store, task, agent)
    )),
    (error) => {
      assert.ok(error instanceof ControllerClientError);
      assert.equal(error.code, "UNAUTHORIZED");
      return true;
    }
  );
});

test("rr13: a user-scope caller is rejected for job.cancel (fail-closed)", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  const leader = leaderCaller(store, task, agent);
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    leader
  ));
  assert.equal(started.created, true);
  // rr13: user scope has no per-Session channel binding; reject outright.
  await assertUnauthorized(() => callController(root, "job.cancel", {
    taskId: task.id,
    jobId: started.job.id,
    caller: userCaller(store, task, agent)
  }));
});

test("rr13: replaying the Leader assertion without the caller key is rejected", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  const leader = leaderCaller(store, task, agent);
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    leader
  ));
  assert.equal(started.created, true);
  // rr13: An attacker reads the Leader assertion (runId + receiptId) from
  // state.json and replays it as a task-scope caller. Without the per-Session
  // key whose hash is durable, the Controller rejects the channel.
  const replayed = {
    scope: "task",
    taskId: task.id,
    role: "leader",
    runId: leader.runId,
    receiptId: leader.receiptId
  };
  await assertUnauthorized(() => callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    replayed
  )));
  await assertUnauthorized(() => callController(root, "job.cancel", {
    taskId: task.id,
    jobId: started.job.id,
    caller: replayed
  }));
});

test("rr13: borrowing an active Worker Run without the caller key is rejected", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  saveWorkItemWithWorkspace(store, task, project, workspace, head, "work-item-1");
  const workerRun = saveWorkerRun(store, task, agent, "agent-run-20", "work-item-1");
  const leader = leaderCaller(store, task, agent);
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    leader
  ));
  assert.equal(started.created, true);
  // rr13: An attacker reads the Worker Run's runId from state.json and
  // borrows it as a task-scope worker caller. Without the per-Session key,
  // the Controller rejects the channel — even though the Run is real.
  const borrowed = {
    scope: "task",
    taskId: task.id,
    role: "worker",
    runId: workerRun.id
  };
  await assertUnauthorized(() => callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "work-item", workItemId: "work-item-1" },
    borrowed
  )));
  await assertUnauthorized(() => callController(root, "job.cancel", {
    taskId: task.id,
    jobId: started.job.id,
    caller: borrowed
  }));
});

test("rr13: a wrong caller key is rejected", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  const leader = leaderCaller(store, task, agent);
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    leader
  ));
  assert.equal(started.created, true);
  // rr13: A caller with the correct role/runId/receiptId but a key whose
  // hash does not match the durable map is rejected.
  const wrong = {
    scope: "task",
    taskId: task.id,
    role: "leader",
    runId: leader.runId,
    receiptId: leader.receiptId,
    callerKey: randomBytes(32).toString("hex")
  };
  await assertUnauthorized(() => callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    wrong
  )));
  await assertUnauthorized(() => callController(root, "job.cancel", {
    taskId: task.id,
    jobId: started.job.id,
    caller: wrong
  }));
});

test("rr8: a Worker cannot cancel a job owned by a foreign Work Item", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  // A verified Leader caller creates a job owned by work-item-1.
  saveWorkItemWithWorkspace(store, task, project, workspace, head, "work-item-1");
  saveWorkItemWithWorkspace(store, task, project, workspace, head, "work-item-2");
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "work-item", workItemId: "work-item-1" },
    leaderCaller(store, task, agent)
  ));
  // The caller's Run is for work-item-2 — the cancel must be rejected.
  saveWorkerRun(store, task, agent, "agent-run-2", "work-item-2");
  const workerKey = saveJobCallerKey(store, task, agent, "worker");
  await assert.rejects(
    () => callController(root, "job.cancel", {
      taskId: task.id,
      jobId: started.job.id,
      caller: { scope: "task", taskId: task.id, role: "worker", runId: "agent-run-2", callerKey: workerKey }
    }),
    (error) => {
      assert.ok(error instanceof ControllerClientError);
      assert.equal(error.code, "UNAUTHORIZED");
      return true;
    }
  );
});

// ─── rr9: fail-closed missing caller at the Controller/socket boundary ────

test("rr9: job.start without a caller is rejected over the Controller socket", async (t) => {
  const { root, store, task, project, workspace, head } = taskFixture(t);
  await startJobController(t, root, store);
  // A managed Session that simply omits the caller field must not fall back
  // to user scope: the request is rejected at the socket boundary.
  await assert.rejects(
    () => callController(root, "job.start", {
      taskId: task.id,
      owner: { kind: "task" },
      projectId: project.id,
      head,
      workspace,
      env: {},
      steps: [{ name: "check", command: "true" }]
    }),
    (error) => {
      assert.ok(error instanceof ControllerClientError);
      assert.equal(error.code, "INVALID_PARAMS");
      assert.match(error.message, /caller is required/iu);
      return true;
    }
  );
});

test("rr9: job.cancel without a caller is rejected over the Controller socket", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  // A verified Leader caller creates the job; a cancel that omits the caller
  // field is rejected rather than defaulting to user scope.
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    leaderCaller(store, task, agent)
  ));
  await assert.rejects(
    () => callController(root, "job.cancel", {
      taskId: task.id,
      jobId: started.job.id
    }),
    (error) => {
      assert.ok(error instanceof ControllerClientError);
      assert.equal(error.code, "INVALID_PARAMS");
      // The strict three-key parser rejects the missing caller key before
      // parseCaller runs; either diagnostic proves the fail-closed boundary.
      assert.match(error.message, /caller is required|cancel params are invalid/iu);
      return true;
    }
  );
});

// ─── rr12: caller identity must be bound to a verified Run ────────────────

/**
 * rr12: Assert a socket call rejects with UNAUTHORIZED (the Controller's
 * caller-binding rejection) rather than INVALID_PARAMS or INTERNAL_ERROR.
 */
async function assertUnauthorized(invoke) {
  await assert.rejects(
    invoke,
    (error) => {
      assert.ok(error instanceof ControllerClientError);
      assert.equal(error.code, "UNAUTHORIZED");
      return true;
    }
  );
}

test("rr12: a forged Leader caller with a non-existent Run is rejected", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    leaderCaller(store, task, agent)
  ));
  assert.equal(started.created, true);
  const forged = { scope: "task", taskId: task.id, role: "leader", runId: "agent-run-999" };
  await assertUnauthorized(() => callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    forged
  )));
  await assertUnauthorized(() => callController(root, "job.cancel", {
    taskId: task.id,
    jobId: started.job.id,
    caller: forged
  }));
});

test("rr12: a Leader caller without the in-flight Turn receipt is rejected", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  const leader = leaderCaller(store, task, agent);
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    leader
  ));
  assert.equal(started.created, true);
  const noReceipt = { scope: "task", taskId: task.id, role: "leader", runId: leader.runId, callerKey: leader.callerKey };
  await assertUnauthorized(() => callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    noReceipt
  )));
  await assertUnauthorized(() => callController(root, "job.cancel", {
    taskId: task.id,
    jobId: started.job.id,
    caller: noReceipt
  }));
});

test("rr12: a Leader caller with a wrong Turn receipt is rejected", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  const leader = leaderCaller(store, task, agent);
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    leader
  ));
  assert.equal(started.created, true);
  const wrongReceipt = {
    scope: "task",
    taskId: task.id,
    role: "leader",
    runId: leader.runId,
    receiptId: formatAgentRunReceiptId(task.id, "agent-run-999"),
    callerKey: leader.callerKey
  };
  await assertUnauthorized(() => callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    wrongReceipt
  )));
  await assertUnauthorized(() => callController(root, "job.cancel", {
    taskId: task.id,
    jobId: started.job.id,
    caller: wrongReceipt
  }));
});

test("rr12: a user caller without a Leader assertion is rejected", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    leaderCaller(store, task, agent)
  ));
  assert.equal(started.created, true);
  const bareUser = { scope: "user" };
  await assertUnauthorized(() => callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    bareUser
  )));
  await assertUnauthorized(() => callController(root, "job.cancel", {
    taskId: task.id,
    jobId: started.job.id,
    caller: bareUser
  }));
});

test("rr12: a Worker Run claimed as a Leader is rejected", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  saveWorkItemWithWorkspace(store, task, project, workspace, head, "work-item-1");
  const workerRun = saveWorkerRun(store, task, agent, "agent-run-20", "work-item-1");
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    leaderCaller(store, task, agent)
  ));
  assert.equal(started.created, true);
  // The Worker Run's roleName is "worker"; claiming "leader" is a mismatch.
  const forged = { scope: "task", taskId: task.id, role: "leader", runId: workerRun.id };
  await assertUnauthorized(() => callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    forged
  )));
  await assertUnauthorized(() => callController(root, "job.cancel", {
    taskId: task.id,
    jobId: started.job.id,
    caller: forged
  }));
});

test("rr12: a yielded Leader Run is rejected", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  // Save a stale, yielded Leader Run BEFORE the active one so the active
  // slot points at the real Leader (agent-run-1), not the stale Run.
  const stale = createAgentRun(
    "agent-run-2", task.id, "leader", "new", "Stale turn.", NOW,
    { effective: testEffectiveLaunch({ agentId: agent.id, adapterId: agent.adapterId }) }
  );
  store.saveAgentRun(yieldAgentRun(stale, "yielded for test", NOW));
  const leader = leaderCaller(store, task, agent);
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    leader
  ));
  assert.equal(started.created, true);
  const forged = {
    scope: "task",
    taskId: task.id,
    role: "leader",
    runId: "agent-run-2",
    receiptId: formatAgentRunReceiptId(task.id, "agent-run-2")
  };
  await assertUnauthorized(() => callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    forged
  )));
  await assertUnauthorized(() => callController(root, "job.cancel", {
    taskId: task.id,
    jobId: started.job.id,
    caller: forged
  }));
});

test("rr12: a caller bound to a different Task is rejected", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  const leader = leaderCaller(store, task, agent);
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    leader
  ));
  assert.equal(started.created, true);
  const crossTask = {
    scope: "task",
    taskId: "task-2",
    role: "leader",
    runId: leader.runId,
    receiptId: leader.receiptId
  };
  await assertUnauthorized(() => callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    crossTask
  )));
  await assertUnauthorized(() => callController(root, "job.cancel", {
    taskId: task.id,
    jobId: started.job.id,
    caller: crossTask
  }));
});

test("rr12: a verified Leader caller can start and cancel a job", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  const leader = leaderCaller(store, task, agent);
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "task" },
    leader
  ));
  assert.equal(started.created, true);
  const cancelled = await callController(root, "job.cancel", {
    taskId: task.id,
    jobId: started.job.id,
    caller: leader
  });
  assert.equal(cancelled.cancelRequested, true);
});

test("rr12: a verified Worker caller can cancel a job owned by its own Work Item", async (t) => {
  const { root, store, task, project, workspace, head, agent } = taskFixture(t);
  await startJobController(t, root, store);
  saveWorkItemWithWorkspace(store, task, project, workspace, head, "work-item-1");
  const workerRun = saveWorkerRun(store, task, agent, "agent-run-20", "work-item-1");
  const workerKey = saveJobCallerKey(store, task, agent, "worker");
  const workerCaller = { scope: "task", taskId: task.id, role: "worker", runId: workerRun.id, callerKey: workerKey };
  const started = await callController(root, "job.start", taskStartParams(
    task, project, workspace, head,
    { kind: "work-item", workItemId: "work-item-1" },
    workerCaller
  ));
  assert.equal(started.created, true);
  const cancelled = await callController(root, "job.cancel", {
    taskId: task.id,
    jobId: started.job.id,
    caller: workerCaller
  });
  assert.equal(cancelled.cancelRequested, true);
});
