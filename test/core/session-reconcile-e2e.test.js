/**
 * Issue 03 E2E: real tmux + mock Provider child, driven through the
 * production Controller launch and archive cleanup seams in an isolated
 * sandbox Home. Covers owner identity recording, durable<->physical
 * reconciliation, exact-owner termination with physical exit proof, the
 * three archive races, and the no-false-kill guarantees.
 *
 * Every test owns its tmux namespace, Controller socket, and runtime root
 * via createIsolatedRuntime; the real Yui Home is never touched.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import {
  FileTaskWorkflowRuntime,
  ensureFileTaskController,
  stopFileTaskController
} from "../../dist/controller/clientRuntime.js";
import { SessionOwnerReconciliation } from "../../dist/controller/sessionOwnerReconciliation.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { callController } from "../../dist/core/controllerClient.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import {
  isLinuxProcessLive,
  readLinuxProcessIdentity
} from "../../dist/runtime/index.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { recordLeaderFailure } from "../../dist/scheduler/leaderFailure.js";
import { TaskWorkspaceCoordinator } from "../../dist/repository/taskWorkspaceCoordinator.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, archiveTask, completeTask } from "../../dist/task/task.js";
import { TmuxManager } from "../../dist/tmux/tmuxManager.js";
import { NodeCommandExecutor } from "../../dist/tmux/commandExecutor.js";
import { createIsolatedRuntime } from "../helpers/isolatedRuntime.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");
const FIVE_SECONDS_MS = 5_000;

const TEST_ENV_NAMES = [
  "E2E_TEST_OBSERVATION",
  "E2E_TEST_FORK",
  "E2E_TEST_FORK_ON_STOP",
  "E2E_TEST_STUBBORN",
  "E2E_TEST_IGNORE_SIGHUP",
  "E2E_TEST_EXIT_AFTER_MS"
];

function testEnvBindings() {
  return TEST_ENV_NAMES.map((sourceName) => ({
    source: "process",
    sourceName,
    target: sourceName,
    required: false
  }));
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function git(path, args) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
}

function initRepository(path) {
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  git(path, ["config", "user.name", "Yui Test"]);
  git(path, ["config", "user.email", "yui@example.invalid"]);
  writeFileSync(join(path, "tracked.txt"), "initial\n");
  git(path, ["add", "tracked.txt"]);
  git(path, ["commit", "-qm", "initial"]);
}

/**
 * Writes the test Provider stand-in. Behavior is controlled by env vars the
 * launch fence carries into the pane:
 *  - E2E_TEST_FORK=1: fork a fenced child at startup (root + child).
 *  - E2E_TEST_FORK_ON_STOP=1: fork a fenced child on the first stop
 *    signal (race: fork during stop).
 *  - E2E_TEST_STUBBORN=1: ignore SIGHUP/SIGTERM (only SIGKILL works).
 *  - E2E_TEST_IGNORE_SIGHUP=1: survive the tmux kill-window SIGHUP
 *    (race: pane dies first, Provider root survives).
 *  - E2E_TEST_EXIT_AFTER_MS=<n>: exit after n ms (race: root dies first).
 * Forked children ignore SIGHUP (so they survive the kill-window group
 * signal) but exit on SIGTERM, so the guard's escalation can reap them.
 */
function writeProviderScript(root) {
  const command = join(root, "e2e-provider.cjs");
  writeFileSync(command, `
const { appendFileSync } = require("node:fs");
const { fork } = require("node:child_process");

const observationPath = process.env.E2E_TEST_OBSERVATION;
const isChild = process.env.E2E_TEST_CHILD === "1";

function observe(event, extra) {
  appendFileSync(observationPath, JSON.stringify({
    event, pid: process.pid, ppid: process.ppid,
    launchId: process.env.YUI_LAUNCH_ID ?? "", isChild, ...extra
  }) + "\\n");
}

observe("process-started");
const keepAlive = setInterval(() => {}, 2 ** 30);
const exit = () => { clearInterval(keepAlive); process.exit(0); };

if (isChild) {
  // A child survives the kill-window SIGHUP but honors SIGTERM/SIGINT.
  process.on("SIGHUP", () => {});
  process.once("SIGTERM", exit);
  process.once("SIGINT", exit);
} else if (process.env.E2E_TEST_STUBBORN === "1") {
  process.on("SIGHUP", () => {});
  process.on("SIGTERM", () => {});
} else if (process.env.E2E_TEST_IGNORE_SIGHUP === "1") {
  // Survive the tmux kill-window SIGHUP but honor forced-stop signals.
  process.on("SIGHUP", () => {});
  process.once("SIGTERM", exit);
  process.once("SIGINT", exit);
} else {
  process.once("SIGHUP", exit);
  process.once("SIGTERM", exit);
  process.once("SIGINT", exit);
}

function spawnChild() {
  const child = fork(__filename, [], {
    env: { ...process.env, E2E_TEST_CHILD: "1" },
    stdio: "ignore"
  });
  observe("child-forked", { childPid: child.pid });
  child.unref();
}

if (!isChild && process.env.E2E_TEST_FORK === "1") spawnChild();
if (!isChild && process.env.E2E_TEST_FORK_ON_STOP === "1") {
  let forked = false;
  const forkOnce = () => { if (!forked) { forked = true; spawnChild(); } };
  process.on("SIGHUP", forkOnce);
  process.on("SIGTERM", forkOnce);
}
if (!isChild && process.env.E2E_TEST_EXIT_AFTER_MS !== undefined) {
  setTimeout(exit, Number(process.env.E2E_TEST_EXIT_AFTER_MS));
}
`);
  return command;
}

function readObservations(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(predicate, timeoutMs, message) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(typeof message === "function" ? message() : (message ?? "timed out waiting for condition"));
    }
    await delay(50);
  }
}

async function waitForProcessExit(pid, timeoutMs, label) {
  await waitFor(
    () => !isLinuxProcessLive(pid, readLinuxProcessIdentity(pid)?.startIdentity ?? ""),
    timeoutMs,
    `${label} (pid ${pid}) did not exit within ${timeoutMs}ms`
  );
}

/**
 * The Controller's tmux launch can fail transiently under CI full-suite load
 * (resource contention makes `tmux start-server; new-session` exit non-zero).
 * The Controller maps CommandExecutionError to SERVICE_ERROR with the real
 * stderr; retry the launch a bounded number of times so a transient
 * infrastructure failure does not flake the E2E. Permanent failures (missing
 * tmux, real contract violations) persist across retries and still fail.
 */
async function ensureRoleSessionWithRetry(home, taskId, roleName, environment, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await callController(home, "runtime.ensure-role-session", {
        scope: "task",
        taskId,
        roleName,
        environment
      });
      return;
    } catch (error) {
      lastError = error;
      const transient = error?.code === "SERVICE_ERROR" || error?.code === "INTERNAL_ERROR";
      if (!transient || attempt === attempts - 1) throw error;
      await delay(200);
    }
  }
  throw lastError;
}

/**
 * Builds the isolated sandbox: own Home, tmux namespace, Controller socket,
 * Git Project, active Task with a prepared workspace, Leader Role, and a
 * configured Agent whose command is the test Provider stand-in.
 */
async function e2eFixture(t, { providerEnv = {} } = {}) {
  const runtime = createIsolatedRuntime(t);
  const { root, home } = runtime;
  const observationPath = join(root, "provider-observations.ndjson");
  const providerCommand = writeProviderScript(root);

  const workspace = join(root, "workspace");
  const repositoryPath = join(workspace, "Yui");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  initRepository(repositoryPath);

  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent(
    "e2e-agent", "codex", process.execPath, [providerCommand], testEnvBindings(), NOW
  );
  store.saveConfiguredAgent(agent);
  store.saveConfig({
    schemaVersion: 1,
    defaultWorkspace: workspace,
    defaultAgent: agent.id
  });
  await runProjectCommand(
    ["add", "Yui", repositoryPath, "--stable", "main", "--development", "main"],
    store,
    { now: () => new Date(NOW) }
  );
  const project = store.getProject("project-1");
  const created = runTaskCommand(
    ["create", "Reconcile E2E", "--project", project.id],
    store,
    { now: () => new Date(NOW) }
  );
  const task = activateTask(created.data.task, NOW);
  store.saveTask(task);
  const role = createRole(
    task.id, "leader", [createRoleAgentBinding(agent)], agent.id, home, NOW
  );
  store.saveRole(task.id, role);

  // A Leader failure record prevents the Controller scheduler's
  // repairOrphanedActiveTasks from auto-dispatching a Leader Run for this
  // active-but-idle Task.  Without it, the Controller's startup pump races
  // the test's explicit launchLeader() call and the launch coordinator
  // rejects the duplicate generation.  The failure is a test-only hold: it
  // has no native session to recover and is harmless to every launch,
  // reconcile, and archive path under test.
  store.saveLeaderFailure(recordLeaderFailure(
    task.id,
    "native-e2e-hold",
    "E2E fixture: hold scheduler auto-dispatch until the explicit launch",
    NOW,
    null
  ));

  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => new Date(NOW));
  await preparer.prepareTaskWorkspace(task.id);

  const providerEnvironment = {
    E2E_TEST_OBSERVATION: observationPath,
    ...providerEnv
  };

  return {
    runtime, root, home, store, agent, task, role, preparer, project,
    observationPath, providerEnvironment,
    async startController() {
      await runtime.startController();
    },
    async launchLeader() {
      await ensureRoleSessionWithRetry(home, task.id, role.name, providerEnvironment);
      // Wait for the Provider process and its owner record.
      await waitFor(
        () => readObservations(observationPath).some((o) => o.event === "process-started" && !o.isChild),
        FIVE_SECONDS_MS,
        "Provider root did not start"
      );
      const registry = new FileTaskStore(home);
      await waitFor(
        () => registry.listSessionOwners().length > 0,
        FIVE_SECONDS_MS,
        "Owner record was not written"
      );
      const [record] = registry.listSessionOwners();
      // Record the durable Session the way the runtime event processor would
      // once the Provider signals session-start. The mock Provider keeps
      // alive without sending notifications, so the test commits the exact
      // durable generation the launch fence created.
      const launchStore = new FileTaskStore(home);
      const launchRole = launchStore.getRole(task.id, role.name);
      const effective = resolveEffectiveLaunch({
        role: launchRole,
        purpose: "execution",
        workspace: launchStore.getTaskWorkspace(task.id)
      });
      let sessions = launchStore.getTaskRoleSessionSet(task.id, role.name)
        ?? createRoleSessionSet(
          { scope: "task", taskId: task.id, roleName: role.name },
          agent.id,
          NOW
        );
      sessions = recordRoleAgentSession(sessions, {
        agentId: agent.id,
        adapterId: agent.adapterId,
        nativeSessionId: record.nativeSessionId ?? `native-${record.launchId}`,
        launchId: record.launchId,
        policy: "fixed",
        status: "running",
        effective
      }, NOW);
      launchStore.saveTaskRoleSessionSet(sessions);
      // Wait for the durable Session to be readable.
      await waitFor(
        () => {
          const set = new FileTaskStore(home).getTaskRoleSessionSet(task.id, role.name);
          const session = set?.sessions[agent.id];
          return session?.status === "running" && session.launchId === record.launchId;
        },
        FIVE_SECONDS_MS,
        "Durable session was not recorded"
      );
      return registry.listSessionOwners();
    },
    reconciliation() {
      const tmux = new TmuxManager(
        runtime.environment.YUI_TMUX_BIN ?? "tmux",
        new NodeCommandExecutor(),
        { yuiHome: home }
      );
      return new SessionOwnerReconciliation({
        home,
        store: new FileTaskStore(home),
        environment: runtime.environment,
        tmux
      });
    },
    async archiveTask() {
      const prepared = store.getTask(task.id);
      store.saveTask(completeTask(prepared, NOW, { by: "leader", summary: "done" }));
      // Clear the in-flight Run reservation the launch coordinator recorded:
      // the mock Provider never delivers a Run, and archive cleanup requires
      // settled Run state before retiring the workspace-bound session.
      const archiveStore = new FileTaskStore(home);
      const currentSet = archiveStore.getTaskRoleSessionSet(task.id, role.name);
      if (currentSet !== null && (currentSet.inFlight !== null || currentSet.pendingTurnCompletion !== null)) {
        archiveStore.saveTaskRoleSessionSet({
          ...currentSet,
          inFlight: null,
          pendingTurnCompletion: null,
          updatedAt: NOW.toISOString()
        });
      }
      const schedulerStore = new FileSchedulerStoreAdapter(store);
      const planner = new FileRoleLaunchPlanner(home, store, {
        environment: runtime.environment
      });
      const tmux = new TmuxManager(
        runtime.environment.YUI_TMUX_BIN ?? "tmux",
        new NodeCommandExecutor(),
        { yuiHome: home }
      );
      const runtimeClient = new FileTaskWorkflowRuntime(
        home, store, schedulerStore, planner, tmux, preparer,
        { environment: runtime.environment }
      );
      const coordinator = new TaskWorkspaceCoordinator(store, preparer, runtimeClient);
      return coordinator.cleanupTaskForArchive(task.id, "abandoned");
    },
    async stopController() {
      await stopFileTaskController(home, { environment: runtime.environment });
    }
  };
}

function rootPidAndChildPids(fixture) {
  const observations = readObservations(fixture.observationPath);
  const root = observations.find((o) => o.event === "process-started" && !o.isChild);
  const children = observations
    .filter((o) => o.event === "process-started" && o.isChild)
    .map((o) => o.pid);
  return { rootPid: root?.pid, childPids: [...new Set(children)] };
}

test("a launched Provider root is recorded and attributed in the reconcile report", async (t) => {
  const fx = await e2eFixture(t);
  await fx.startController();
  const records = await fx.launchLeader();

  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.owner.scope, "task");
  assert.equal(record.owner.taskId, fx.task.id);
  assert.equal(record.owner.roleName, "leader");
  assert.equal(record.providerRoot.attribution, "launch-env");
  assert.ok(record.providerRoot.pid > 0);
  assert.match(record.providerRoot.startIdentity, /^[0-9]+$/u);
  assert.equal(record.tmux.sessionName.includes(fx.task.id), true);

  const report = fx.reconciliation().report();
  assert.equal(report.entries.length, 1);
  const entry = report.entries[0];
  assert.equal(entry.owner.taskId, fx.task.id);
  assert.equal(entry.owner.roleName, "leader");
  assert.equal(entry.physical.alive, true);
  assert.equal(entry.physical.pid, record.providerRoot.pid);
  assert.equal(entry.physical.startIdentity, record.providerRoot.startIdentity);
  assert.equal(entry.durableStatus, "running");
  assert.equal(entry.archiveBlocked, false);

  // Simulate the historical leak: durable map cleared, process still live.
  const freshStore = new FileTaskStore(fx.home);
  freshStore.saveTaskRoleSessionSet(createRoleSessionSet(
    { scope: "task", taskId: fx.task.id, roleName: "leader" },
    fx.agent.id,
    NOW
  ));
  const leaked = fx.reconciliation().report();
  const leakedEntry = leaked.entries[0];
  assert.equal(leakedEntry.physical.alive, true);
  assert.equal(leakedEntry.durableStatus, "absent");
  assert.equal(leakedEntry.mismatch, "durable-terminal-physical-live");
  // Report mode never blocks archive.
  assert.equal(leakedEntry.archiveBlocked, false);

  await fx.stopController();
});

test("Controller restart re-attributes a generation whose durable map was cleared", async (t) => {
  const fx = await e2eFixture(t);
  await fx.startController();
  await fx.launchLeader();
  await fx.stopController();

  // Clear the durable session map while the Provider stays alive.
  const freshStore = new FileTaskStore(fx.home);
  freshStore.saveTaskRoleSessionSet(createRoleSessionSet(
    { scope: "task", taskId: fx.task.id, roleName: "leader" },
    fx.agent.id,
    NOW
  ));

  await fx.startController();
  const report = fx.reconciliation().report();
  assert.equal(report.entries.length, 1);
  assert.equal(report.entries[0].physical.alive, true);
  assert.equal(report.entries[0].durableStatus, "absent");
  assert.equal(report.entries[0].mismatch, "durable-terminal-physical-live");

  await fx.stopController();
});

test("exact-owner archive cleanup proves Provider root and child exit within 5s", async (t) => {
  const fx = await e2eFixture(t, {
    providerEnv: { E2E_TEST_FORK: "1" }
  });
  await fx.startController();
  await fx.launchLeader();
  // The FORK provider spawns its child asynchronously; wait for the child's
  // own process-start observation before asserting the tree shape.
  await waitFor(
    () => rootPidAndChildPids(fx).childPids.length === 1,
    FIVE_SECONDS_MS,
    "Provider child did not fork"
  );
  const { rootPid, childPids } = rootPidAndChildPids(fx);
  assert.ok(rootPid > 0);
  assert.equal(childPids.length, 1);

  const cleanup = await fx.archiveTask();
  assert.equal(cleanup.status, "removed", cleanup.error ?? JSON.stringify(cleanup));

  await waitForProcessExit(rootPid, FIVE_SECONDS_MS, "Provider root");
  for (const childPid of childPids) {
    await waitForProcessExit(childPid, FIVE_SECONDS_MS, "Provider child");
  }

  // Owner records are removed only after confirmed exit.
  const registry = new FileTaskStore(fx.home);
  assert.equal(registry.listSessionOwners().length, 0);
  // The tmux pane is gone.
  const panes = new TmuxManager(
    fx.runtime.environment.YUI_TMUX_BIN ?? "tmux", new NodeCommandExecutor(), { yuiHome: fx.home }
  ).inspectRolePaneInventory();
  assert.equal(panes.length, 0);

  // Lifecycle events carry the full termination outcome chain.
  const events = new FileTaskStore(fx.home)
    .listEvents(fx.task.id)
    .filter((event) => event.type === "runtime.session-termination");
  const outcomes = events.map((event) => event.payload.outcome);
  assert.ok(outcomes.includes("stop-requested"));
  assert.ok(outcomes.includes("graceful-stop"));
  assert.ok(outcomes.includes("stop-confirmed"));

  await fx.stopController();
});

test("a stubborn Provider is escalated SIGTERM/SIGKILL and confirmed", async (t) => {
  const fx = await e2eFixture(t, {
    providerEnv: { E2E_TEST_STUBBORN: "1" }
  });
  await fx.startController();
  await fx.launchLeader();
  const { rootPid } = rootPidAndChildPids(fx);

  const cleanup = await fx.archiveTask();
  assert.equal(cleanup.status, "removed", cleanup.error ?? JSON.stringify(cleanup));
  await waitForProcessExit(rootPid, FIVE_SECONDS_MS, "Stubborn Provider root");

  const events = new FileTaskStore(fx.home)
    .listEvents(fx.task.id)
    .filter((event) => event.type === "runtime.session-termination");
  const outcomes = events.map((event) => event.payload.outcome);
  assert.ok(outcomes.includes("forced-stop"));
  assert.ok(outcomes.includes("stop-confirmed"));

  await fx.stopController();
});

for (const [name, providerEnv] of [
  ["fork during stop", { E2E_TEST_FORK_ON_STOP: "1" }],
  ["pane dies first", { E2E_TEST_IGNORE_SIGHUP: "1" }],
  ["root dies first", { E2E_TEST_FORK: "1", E2E_TEST_EXIT_AFTER_MS: "300" }]
]) {
  test(`archive race: ${name} still proves physical zero`, async (t) => {
    const fx = await e2eFixture(t, {
      providerEnv
    });
    await fx.startController();
    await fx.launchLeader();
    // The FORK-at-startup variant spawns its child asynchronously.
    if (providerEnv.E2E_TEST_FORK === "1") {
      await waitFor(
        () => rootPidAndChildPids(fx).childPids.length === 1,
        FIVE_SECONDS_MS,
        "Provider child did not fork"
      );
    }
    const before = rootPidAndChildPids(fx);

    const cleanup = await fx.archiveTask();
    assert.equal(cleanup.status, "removed");

    await waitForProcessExit(before.rootPid, FIVE_SECONDS_MS, "Provider root");
    for (const childPid of before.childPids) {
      await waitForProcessExit(childPid, FIVE_SECONDS_MS, "Provider child");
    }
    // A child forked during the stop must also be gone.
    const after = rootPidAndChildPids(fx);
    for (const childPid of after.childPids) {
      await waitForProcessExit(childPid, FIVE_SECONDS_MS, "late-forked child");
    }
    assert.equal(new FileTaskStore(fx.home).listSessionOwners().length, 0);

    await fx.stopController();
  });
}

test("a reused PID with a different start identity is never signaled", async (t) => {
  const fx = await e2eFixture(t, {
    // The guard's role-scoped gracefulStop still kills the tmux window
    // (SIGHUP); ignoring it proves the guard's PID signal path (SIGTERM/
    // SIGKILL) never touched the reused-PID Provider.
    providerEnv: { E2E_TEST_IGNORE_SIGHUP: "1" }
  });
  await fx.startController();
  await fx.launchLeader();
  const { rootPid } = rootPidAndChildPids(fx);
  const realIdentity = readLinuxProcessIdentity(rootPid);
  assert.ok(realIdentity);

  // Plant a record that claims this PID with a WRONG start identity
  // (PID reuse): the guard must treat it as absent and never signal.
  const registry = new FileTaskStore(fx.home);
  const [realRecord] = registry.listSessionOwners();
  registry.removeSessionOwner(realRecord.launchId);
  registry.saveSessionOwner({
    ...realRecord,
    providerRoot: {
      ...realRecord.providerRoot,
      startIdentity: "1"
    }
  });

  const reconciliation = fx.reconciliation();
  const result = await reconciliation.terminateOwner({
    scope: "task", taskId: fx.task.id, roleName: "leader"
  });
  assert.equal(result.outcome, "stop-confirmed");
  // The real Provider at that PID must still be alive.
  assert.equal(isLinuxProcessLive(rootPid, realIdentity.startIdentity), true);

  await fx.stopController();
});

test("a process without the launch fence is unattributed and survives cleanup", async (t) => {
  const fx = await e2eFixture(t, {
    
  });
  await fx.startController();
  await fx.launchLeader();

  // An unrelated process with no YUI launch fence.
  const bystander = spawn("sleep", ["30"], { stdio: "ignore" });
  bystander.unref();
  const bystanderIdentity = readLinuxProcessIdentity(bystander.pid);
  assert.ok(bystanderIdentity);

  // A foreign tmux server (non-Yui namespace) with a live window.
  const foreignSocket = join(fx.root, "foreign-tmux.sock");
  execFileSync("tmux", [
    "-S", foreignSocket, "new-session", "-d", "-s", "foreign", "-n", "foreign", "sleep 30"
  ]);

  // Run the exact-owner cleanup lane: only fenced, terminal-Task owners are
  // targeted. The Task is still active, so nothing is eligible anyway; the
  // assertions prove the guard never broadens beyond its records.
  const reconciliation = fx.reconciliation();
  const report = reconciliation.report("exact-owner-cleanup");
  assert.equal(report.entries.every((entry) => entry.archiveBlocked === false), true);

  assert.equal(isLinuxProcessLive(bystander.pid, bystanderIdentity.startIdentity), true);
  const foreignWindows = execFileSync("tmux", [
    "-S", foreignSocket, "list-windows", "-F", "#{window_name}"
  ], { encoding: "utf8" }).trim();
  assert.equal(foreignWindows, "foreign");

  try { process.kill(bystander.pid, "SIGKILL"); } catch {}
  try { execFileSync("tmux", ["-S", foreignSocket, "kill-server"]); } catch {}
  await fx.stopController();
});
