import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { startFileTaskControllerRuntime } from "../../dist/controller/runtime.js";
import { enqueueWork } from "../../dist/coordination/workMailboxQueue.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { NodeCommandExecutor } from "../../dist/tmux/commandExecutor.js";
import {
  TmuxManager,
  yuiTmuxServerName,
  yuiTmuxTarget
} from "../../dist/tmux/tmuxManager.js";
import { TmuxSessionHost } from "../../dist/runtime/tmuxAdapters.js";

const execFileAsync = promisify(execFile);
const CLI = join(process.cwd(), "dist", "cli.js");
const FIRST = new Date("2026-08-03T01:00:00.000Z");

function isolatedCliEnvironment(home, overrides = {}) {
  const environment = { ...process.env, YUI_HOME: home, ...overrides };
  for (const name of [
    "YUI_TASK_ID",
    "YUI_ROLE",
    "YUI_AGENT_ID",
    "YUI_AGENT_RUN_ID",
    "YUI_ADAPTER_ID",
    "YUI_NATIVE_SESSION_ID",
    "YUI_LAUNCH_ID",
    "YUI_SESSION_SCOPE"
  ]) {
    if (!Object.hasOwn(overrides, name)) delete environment[name];
  }
  return environment;
}

async function runCli(home, args, environment = {}) {
  const result = await execFileAsync(
    process.execPath,
    [CLI, "--json", ...args],
    {
      cwd: process.cwd(),
      env: isolatedCliEnvironment(home, environment),
      maxBuffer: 4 * 1024 * 1024
    }
  );
  return JSON.parse(result.stdout);
}

async function runRejectedCli(home, args, environment = {}) {
  try {
    await runCli(home, args, environment);
  } catch (error) {
    return {
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
      message: String(error.message ?? error)
    };
  }
  assert.fail(`CLI unexpectedly succeeded: ${args.join(" ")}`);
}

async function waitFor(predicate, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${label}.`);
}

function nativeIdentity(launchId) {
  return `native-${createHash("sha256").update(launchId).digest("hex").slice(0, 20)}`;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

test("fresh Controller E2E retires one unusable fixed Session and launches a new Leader Session", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-task-8-session-retirement-"));
  const home = join(root, "home");
  const repository = join(root, "fixture-repo");
  const runtimeScript = join(root, "deterministic-runtime.mjs");
  const runtimeLog = join(root, "runtime.log");
  const auditLog = join(root, "e2e-evidence.json");
  const retainArtifacts = process.env.YUI_RETAIN_E2E_ARTIFACTS === "1";
  let controller;
  let realHost;
  let taskOwner;
  const observedPids = new Set();
  let teardownComplete = false;

  try {
    mkdirSync(home, { recursive: true });
    mkdirSync(repository, { recursive: true });
    writeFileSync(join(repository, "README.md"), "deterministic fixture\n");
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: repository });
    await execFileAsync("git", ["config", "user.name", "Yui E2E"], { cwd: repository });
    await execFileAsync("git", ["config", "user.email", "yui-e2e@example.invalid"], {
      cwd: repository
    });
    await execFileAsync("git", ["add", "README.md"], { cwd: repository });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repository });
    const fixtureHead = (await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repository
    })).stdout.trim();

    writeFileSync(runtimeScript, [
      "import { appendFileSync } from 'node:fs';",
      "import { createInterface } from 'node:readline';",
      "const log = process.env.YUI_E2E_RUNTIME_LOG;",
      "const native = process.env.YUI_E2E_NATIVE_SESSION;",
      "appendFileSync(log, `started:${native}:${process.pid}\\n`);",
      "const input = createInterface({ input: process.stdin, terminal: false });",
      "input.on('line', (line) => appendFileSync(log, `input:${native}:${line}\\n`));",
      "const stopped = () => { appendFileSync(log, `stopped:${native}:${process.pid}\\n`); process.exit(0); };",
      "process.on('SIGTERM', stopped);",
      "process.on('SIGINT', stopped);"
    ].join("\n"));

    ensureStorageSchema(home, FIRST);
    const store = new FileTaskStore(home);
    const agent = createConfiguredAgent(
      "deterministic-agent",
      "codex",
      process.execPath,
      [],
      [],
      FIRST
    );
    const task = activateTask(createTask(
      "task-e2e-session-retirement",
      "Recover one unusable fixed Session",
      FIRST
    ), FIRST);
    const leader = createRole(
      task.id,
      "leader",
      [createRoleAgentBinding(agent)],
      agent.id,
      repository,
      FIRST
    );
    store.transaction((tx) => {
      tx.saveConfig({
        schemaVersion: 1,
        defaultAgent: agent.id,
        defaultWorkspace: repository,
        reconciliationIntervalSeconds: 120
      });
      tx.saveConfiguredAgent(agent);
      tx.saveTask(task);
      tx.saveRole(task.id, leader);
      enqueueWork(
        tx,
        { kind: "role", taskId: task.id, roleName: leader.name },
        "fixture-start",
        FIRST,
        [{ type: "task", id: task.id }]
      );
    });

    const plans = [];
    const planner = {
      plan(input) {
        const nativeSessionId = input.mode === "resume"
          ? input.nativeSessionId
          : nativeIdentity(input.launchId);
        plans.push({ ...input, nativeSessionId });
        return {
          role: { name: input.roleName, workspace: repository, status: "idle" },
          launch: {
            command: process.execPath,
            args: [runtimeScript],
            env: {
              YUI_E2E_RUNTIME_LOG: runtimeLog,
              YUI_E2E_NATIVE_SESSION: nativeSessionId
            }
          },
          session: { nativeSessionId }
        };
      },
      planGlobalRole() {
        throw new Error("The provider-neutral fixture never launches a global runtime.");
      }
    };
    const tmux = new TmuxManager("tmux", new NodeCommandExecutor(), { yuiHome: home });
    let bindingSequence = 0;
    realHost = new TmuxSessionHost(planner, tmux, {
      createBindingId: () => `binding-e2e-${++bindingSequence}`
    });
    let allowOwnedStop = false;
    const stoppedOwners = [];
    const guardedHost = {
      start: (request) => realHost.start(request),
      resume: (request) => realHost.resume(request),
      stop: (binding) => realHost.stop(binding),
      inspect: (binding) => realHost.inspect(binding),
      inspectOwner: (owner) => realHost.inspectOwner(owner),
      inspectOwners: (owners) => realHost.inspectOwners(owners),
      async stopOwner(owner) {
        stoppedOwners.push(owner);
        if (!allowOwnedStop) return false;
        return realHost.stopOwner(owner);
      }
    };
    const deliveredReceipts = new Set();
    const promptDeliveries = [];
    const promptPush = {
      async tryPush({ binding, envelope }) {
        if (deliveredReceipts.has(envelope.id)) return "delivered";
        const owner = binding.owner;
        assert.equal(owner.scope, "task");
        const buffer = `yui_e2e_${createHash("sha256")
          .update(envelope.id).digest("hex").slice(0, 20)}`;
        await execFileAsync("tmux", [
          "-L", yuiTmuxServerName(home),
          "set-buffer", "-b", buffer, "--", envelope.text,
          ";", "paste-buffer", "-dpr", "-b", buffer,
          "-t", yuiTmuxTarget(home, owner.taskId, owner.roleName),
          ";", "send-keys", "-t", yuiTmuxTarget(home, owner.taskId, owner.roleName), "Enter"
        ]);
        deliveredReceipts.add(envelope.id);
        promptDeliveries.push({
          receiptId: envelope.id,
          sourceId: envelope.source.id,
          nativeSessionId: binding.nativeSessionId,
          launchId: binding.launchId
        });
        return "delivered";
      }
    };

    controller = await startFileTaskControllerRuntime(home, {
      store,
      planner,
      tmux,
      sessionHost: guardedHost,
      promptPush,
      intervalMs: 60_000,
      signalWindowMs: 5,
      deliveryRetryMs: 50,
      deliveryRetryLimit: 2
    });
    taskOwner = { scope: "task", taskId: task.id, roleName: leader.name };

    await waitFor(() => {
      const run = store.getActiveAgentRun(task.id, leader.name);
      return run?.deliveredAt !== undefined;
    }, "the first delivered Leader Run");
    const firstRun = store.getActiveAgentRun(task.id, leader.name);
    const firstSessions = store.getTaskRoleSessionSet(task.id, leader.name);
    const firstSession = firstSessions.sessions[agent.id];
    assert.equal(firstRun.mode, "new");
    assert.equal(firstSessions.inFlight.runId, firstRun.id);
    assert.equal(firstSession.policy, "fixed");
    assert.equal(firstSession.status, "running");
    assert.equal((await realHost.inspectOwner(taskOwner)).state, "running");
    for (const pane of tmux.inspectRolePaneInventory()) {
      if (pane.taskId === task.id && pane.pid !== undefined) observedPids.add(pane.pid);
    }
    await waitFor(
      () => existsSync(runtimeLog) && readFileSync(runtimeLog, "utf8").includes(firstRun.id),
      "the deterministic runtime to receive the first Run"
    );

    await runCli(home, [
      "task", "message", "send", task.id,
      "Keep this user signal durable across Session retirement."
    ]);
    const userMessageIds = store.listMessages(task.id).map((message) => message.id);
    const roleTarget = { kind: "role", taskId: task.id, roleName: leader.name };
    assert.deepEqual(store.getWorkMailbox(roleTarget).pending.reasons, ["user-message"]);

    const operatorEnvironment = {
      YUI_SESSION_SCOPE: "global",
      YUI_ROLE: "operator"
    };
    const commandArgs = [
      "operator", "retire-unusable-session", task.id, leader.name,
      "--run", firstRun.id,
      "--agent", agent.id,
      "--adapter", agent.adapterId,
      "--receipt", `agent-run:${task.id}/${firstRun.id}`,
      "--native-session", firstSession.nativeSessionId,
      "--launch", firstSession.launchId,
      "--reason", "E2E Operator declaration: the fixed Session is unusable."
    ];
    const beforeStaleRejection = JSON.stringify({
      run: store.getAgentRun(task.id, firstRun.id),
      sessions: store.getTaskRoleSessionSet(task.id, leader.name),
      mailbox: store.getWorkMailbox(roleTarget),
      events: store.listEvents(task.id)
    });
    const staleRejection = await runRejectedCli(home, commandArgs.map((value, index, all) => (
      all[index - 1] === "--launch" ? `${value}-stale` : value
    )), operatorEnvironment);
    assert.match(
      `${staleRejection.stdout}\n${staleRejection.stderr}\n${staleRejection.message}`,
      /fixed Session generation/i
    );
    assert.equal(JSON.stringify({
      run: store.getAgentRun(task.id, firstRun.id),
      sessions: store.getTaskRoleSessionSet(task.id, leader.name),
      mailbox: store.getWorkMailbox(roleTarget),
      events: store.listEvents(task.id)
    }), beforeStaleRejection);

    const declaration = await runCli(home, commandArgs, operatorEnvironment);
    assert.equal(declaration.ok, true);
    await waitFor(() => stoppedOwners.length >= 1, "one failed owned-stop attempt");
    let pendingSessions = store.getTaskRoleSessionSet(task.id, leader.name);
    assert.equal(store.getAgentRun(task.id, firstRun.id).status, "failed");
    assert.equal(store.getActiveAgentRun(task.id, leader.name), null);
    assert.equal(pendingSessions.unusableSessionRetirement.status, "cleanup-pending");
    assert.equal(pendingSessions.inFlight.runId, firstRun.id);
    assert.equal(pendingSessions.sessions[agent.id].nativeSessionId, firstSession.nativeSessionId);
    assert.equal((await realHost.inspectOwner(taskOwner)).state, "running");
    assert.deepEqual(store.getWorkMailbox(roleTarget).pending.reasons, ["user-message"]);
    assert.equal(store.listWorkItems(task.id).flatMap((item) => item.candidates).length, 0);
    const runtimeTarget = { kind: "role-runtime", taskId: task.id, roleName: leader.name };
    assert.deepEqual(store.getWorkMailbox(runtimeTarget).pending.reasons, [
      "runtime-cleanup-required"
    ]);
    const pendingStatus = await runCli(
      home,
      ["task", "role", "status", task.id, leader.name]
    );
    assert.equal(pendingStatus.data.role.sessionRetirement.state, "cleanup-pending");
    assert.equal(pendingStatus.data.role.runtimeCleanupPending, true);
    assert.equal(pendingStatus.data.role.freshLaunchAllowed, false);

    allowOwnedStop = true;
    await controller.runtime.pump();
    await waitFor(
      () => store.getTaskRoleSessionSet(task.id, leader.name).unusableSessionRetirement === null,
      "verified cleanup and Session retirement"
    );
    const retiredSessions = store.getTaskRoleSessionSet(task.id, leader.name);
    const retired = Object.values(retiredSessions.retiredSessions);
    assert.equal(retiredSessions.sessions[agent.id], undefined);
    assert.equal(retiredSessions.inFlight, null);
    assert.equal(retired.length, 1);
    assert.equal(retired[0].session.nativeSessionId, firstSession.nativeSessionId);
    assert.equal(retired[0].session.launchId, firstSession.launchId);
    assert.equal(retired[0].reason, "E2E Operator declaration: the fixed Session is unusable.");
    assert.equal((await realHost.inspectOwner(taskOwner)).state, "stopped");
    assert.deepEqual(store.getWorkMailbox(roleTarget).pending.reasons, ["user-message"]);
    for (const messageId of userMessageIds) {
      assert.equal(store.listMessages(task.id).some((message) => message.id === messageId), true);
    }

    await runCli(
      home,
      ["jobs", "retry", `leader-recovery:${task.id}`],
      operatorEnvironment
    );
    await waitFor(() => {
      const run = store.getActiveAgentRun(task.id, leader.name);
      return run !== null && run.id !== firstRun.id && run.deliveredAt !== undefined;
    }, "the successor delivered Leader Run");
    const successorRun = store.getActiveAgentRun(task.id, leader.name);
    const successorSessions = store.getTaskRoleSessionSet(task.id, leader.name);
    const successorSession = successorSessions.sessions[agent.id];
    assert.equal(successorRun.mode, "new");
    assert.notEqual(successorSession.nativeSessionId, firstSession.nativeSessionId);
    assert.notEqual(successorSession.launchId, firstSession.launchId);
    assert.deepEqual(plans.map((plan) => plan.mode), ["new", "new"]);
    assert.equal((await realHost.inspectOwner(taskOwner)).state, "running");
    for (const pane of tmux.inspectRolePaneInventory()) {
      if (pane.taskId === task.id && pane.pid !== undefined) observedPids.add(pane.pid);
    }
    await waitFor(
      () => readFileSync(runtimeLog, "utf8").includes(successorRun.id),
      "the deterministic runtime to receive the successor Run"
    );
    const successorMailbox = store.getWorkMailbox(roleTarget);
    assert.equal(successorMailbox.processing.executionRef.id, successorRun.id);
    assert.equal(successorMailbox.processing.batch.reasons.includes("user-message"), true);
    assert.equal(successorMailbox.processing.batch.reasons.includes("recovery-retry"), true);

    const lateOldFact = controller.schedulerStore.observeRuntimeTurnCompleted({
      taskId: task.id,
      roleName: leader.name,
      agentId: agent.id,
      adapterId: agent.adapterId,
      nativeSessionId: firstSession.nativeSessionId,
      launchId: firstSession.launchId,
      turnId: "turn-late-old-e2e",
      runId: firstRun.id,
      summary: "Late fact from the retired Session."
    }, new Date());
    assert.equal(lateOldFact.disposition, "obsolete");
    assert.equal(controller.schedulerStore.completeRuntimeCleanup(runtimeTarget, new Date()), false);
    assert.equal(store.getActiveAgentRun(task.id, leader.name).id, successorRun.id);
    assert.equal(store.listWorkItems(task.id).flatMap((item) => item.candidates).length, 0);

    await runCli(home, [
      "task", "run", "yield", successorRun.id,
      "--summary", "Successor Leader completed a fresh deterministic Turn."
    ], {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: leader.name,
      YUI_AGENT_ID: agent.id,
      YUI_AGENT_RUN_ID: successorRun.id,
      YUI_ADAPTER_ID: agent.adapterId,
      YUI_NATIVE_SESSION_ID: successorSession.nativeSessionId,
      YUI_LAUNCH_ID: successorSession.launchId
    });
    assert.equal(store.getAgentRun(task.id, successorRun.id).status, "yielded");
    assert.equal(store.getActiveAgentRun(task.id, leader.name), null);
    assert.equal(store.getTask(task.id).status, "active");
    assert.equal(store.listWorkItems(task.id).flatMap((item) => item.candidates).length, 0);

    const eventTypes = store.listEvents(task.id).map((event) => event.type);
    assert.equal(eventTypes.includes("runtime.unusable-session-retirement-requested"), true);
    assert.equal(eventTypes.includes("runtime.unusable-session-retired"), true);
    const messages = store.listMessages(task.id);
    assert.equal(messages.some((message) => message.body.includes("fixed native Session unusable")), true);
    assert.equal(messages.some((message) => message.body.includes("Successor Leader completed")), true);
    const repositoryStatus = (await execFileAsync("git", ["status", "--porcelain"], {
      cwd: repository
    })).stdout;
    assert.equal(repositoryStatus, "");

    await realHost.stopOwner(taskOwner);
    await waitFor(
      () => realHost.inspectOwner(taskOwner).then(({ state }) => state === "stopped"),
      "the successor runtime to stop during teardown"
    );
    await controller.close();
    controller = undefined;
    await waitFor(
      () => [...observedPids].every((pid) => !processIsAlive(pid)),
      "all owned runtime PIDs to exit"
    );
    assert.equal(
      tmux.inspectRolePaneInventory().some((pane) => pane.taskId === task.id),
      false
    );
    teardownComplete = true;

    const evidence = {
      root,
      home,
      repository,
      fixtureHead,
      taskId: task.id,
      firstRunId: firstRun.id,
      firstNativeSessionId: firstSession.nativeSessionId,
      firstLaunchId: firstSession.launchId,
      successorRunId: successorRun.id,
      successorNativeSessionId: successorSession.nativeSessionId,
      successorLaunchId: successorSession.launchId,
      planModes: plans.map((plan) => plan.mode),
      promptDeliveries,
      stopAttempts: stoppedOwners.length,
      stoppedOwners,
      staleGenerationRejected: true,
      lateOldFact: lateOldFact.disposition,
      userMessageIds,
      messageIds: messages.map((message) => message.id),
      eventTypes,
      candidateCount: 0,
      observedPids: [...observedPids],
      orphanPidCount: [...observedPids].filter(processIsAlive).length,
      fixtureRepositoryClean: true,
      teardownComplete
    };
    writeFileSync(auditLog, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`YUI_SESSION_RETIREMENT_E2E ${JSON.stringify(evidence)}`);
  } finally {
    if (!teardownComplete && realHost !== undefined && taskOwner !== undefined) {
      await realHost.stopOwner(taskOwner).catch(() => false);
    }
    if (controller !== undefined) await controller.close().catch(() => {});
    if (!retainArtifacts) rmSync(root, { recursive: true, force: true });
    else console.log(`YUI_SESSION_RETIREMENT_E2E_ARTIFACTS ${root}`);
  }
});
