import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  claimPending,
  completeProcessing,
  consumePendingBatch,
  createWorkMailbox,
  enqueueSignal,
  releaseProcessing
} from "../../dist/coordination/workMailbox.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import {
  configuredAgentToDefinition,
  createConfiguredAgent
} from "../../dist/agent/agent.js";
import { resolveAgentAdapter } from "../../dist/executor/agentAdapter.js";
import * as roleLaunchPlanner from "../../dist/executor/fileRoleLaunchPlanner.js";
import {
  bindTaskRoleProviderRuntime,
  createRoleSessionSet,
  recordRoleAgentSession,
  updateTaskRoleProviderRuntime,
  validateRoleSessionSet
} from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import {
  startTaskExecutionCommand,
  stopTaskExecutionCommand
} from "../../dist/commands/taskExecutionCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import {
  createGlobalRole,
  createRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";
import { materializeSessionBootstrap } from "../../dist/context/sessionBootstrapManifest.js";
import { builtinAgentDriverRegistry } from "../../dist/runtime/builtinAgentDrivers.js";
import { serializeAgentErrorRaw, standardAgentError } from "../../dist/runtime/agentError.js";
import { runtimeLifecycleTarget } from "../../dist/runtime/lifecycleReservation.js";
import { createExactControlPlaneDescriptor } from "../../dist/runtime/exactControlPlane.js";
import { startStructuredProviderSession } from "../../dist/runtime/structuredProviderHost.js";
import {
  acceptProviderTurn,
  beginProviderTurn,
  createProviderRuntimeBinding,
  endProviderActivation,
  settleProviderTurn,
  updateProviderGoal
} from "../../dist/runtime/providerRuntimeIdentity.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { runControllerSchedulerPass } from "../../dist/controller/controller.js";
import { createAsyncRuntimeObserver } from "../../dist/controller/runtimeEventProcessor.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { runRuntimeObservationHookCommand } from "../../dist/controller/runtimeObservationHook.js";
import { createTurn, validateTurn } from "../../dist/turn/turn.js";
import { createTurnInput } from "../../dist/context/turnInputContract.js";
import { processActiveRoleTurnDeliveries } from "../../dist/scheduler/activeRoleTurnDelivery.js";
import { processOperatorInputNotifications } from "../../dist/scheduler/operatorInputNotificationProcessor.js";
import {
  LEADER_WAKE_AGGREGATION_MS,
  LEADER_WAKE_FORCE_MS,
  processLeaderWakeups
} from "../../dist/scheduler/leaderWakeupProcessor.js";
import { buildTaskExecutionProjection } from "../../dist/scheduler/taskExecutionProjection.js";
import { projectNextAction } from "../../dist/task/nextAction.js";
import { listPublicCommandPaths } from "../../dist/cli/commandCatalog.js";
import { acquireHandoverLock } from "../../dist/release/runtimeRelease.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import * as taskStoreContract from "../../dist/storage/taskStore.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { latestStorageVersionState } from "../../dist/storage/upgrade/recordVersions.js";
import { initializeCurrentTaskStore } from "../../dist/storage/currentTaskStore.js";
import { SqliteTelemetryStore } from "../../dist/telemetry/sqliteTelemetryStore.js";
import {
  activateTask,
  createTask,
  startTaskExecution,
  stopTaskExecution
} from "../../dist/task/task.js";
import { createWorkItem, updateWorkItemStatus } from "../../dist/workItem/workItem.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

const root = resolve(import.meta.dirname, "../..");
const bareEnv = sanitizedTestEnv();

function turnInput(turnId, taskId, roleName, directive, options = {}) {
  void turnId;
  void taskId;
  void roleName;
  return createTurnInput({
    source: { type: "yui", channel: options.channel ?? "task-dispatch" },
    directive,
    deltaRefIds: []
  });
}

test("the packaged CLI starts and exposes the core workflow", () => {
  const help = execFileSync(process.execPath, [join(root, "dist", "cli.js"), "help"], {
    cwd: root,
    encoding: "utf8",
    env: bareEnv
  });
  assert.match(help, /Yui/u);
  const commands = listPublicCommandPaths();
  for (const command of [
    "setup",
    "update",
    "upgrade",
    "task create",
    "task list",
    "task execution stop",
    "task execution start",
    "task role session inspect",
    "task role session stop"
  ]) {
    assert.ok(commands.includes(command), `missing core command: ${command}`);
  }
  assert.ok(commands.includes("task turn list"));
  assert.equal(commands.some((command) => command.startsWith("task run")), false);
  assert.equal(commands.includes("task rebuild"), false);
  assert.equal(commands.some((command) => command.startsWith("task history")), false);
  assert.equal(commands.includes("task review rebind"), false);
  assert.equal(commands.includes("task role session switch"), false);
});

test("Managed Codex shares the native App Server used by interactive clients", () => {
  const adapter = resolveAgentAdapter("codex");
  const launch = adapter.compileManagedControl({
    agent: {
      schemaVersion: 2,
      id: "codex",
      adapterId: "codex",
      command: "codex",
      baseArgs: [],
      environment: [],
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      source: "custom"
    },
    config: {
      adapterId: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      permission: { strategy: "bypass" }
    },
    workspace: "/tmp/yui-shared-codex-runtime"
  }, "new");

  assert.equal(launch.transport, "codex-app-server-proxy");
  assert.deepEqual(launch.argv.slice(-2), ["app-server", "proxy"]);
  assert.throws(() => adapter.compileManagedControl({
    agent: {
      schemaVersion: 2,
      id: "codex",
      adapterId: "codex",
      command: "codex",
      baseArgs: [],
      environment: [],
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      source: "custom"
    },
    config: {
      adapterId: "codex",
      permission: { strategy: "bypass" },
      profile: "operator"
    },
    workspace: "/tmp/yui-shared-codex-runtime"
  }, "new"), /cannot be scoped to one shared-daemon thread/u);
});

test("Global Codex Sessions use the shared daemon and retain a process-independent Context entry", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-global-codex-context-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date("2026-09-01T00:00:00.000Z");
  assert.throws(
    () => createConfiguredAgent("custom", "codex", "codex", ["--remote", "unix://"], [], now),
    /Agent base argument is reserved by adapter codex: --remote/u
  );
  ensureStorageSchema(home);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  const binding = createRoleAgentBinding(configuredAgentToDefinition(agent));
  const role = createGlobalRole(
    "operator",
    [binding],
    binding.agentId,
    home,
    now
  );
  store.saveConfiguredAgent(agent);
  store.saveGlobalRole(role);
  assert.throws(() => resolveAgentAdapter("codex").compileNew({
    agent: configuredAgentToDefinition(agent),
    config: {
      adapterId: "codex",
      permission: { strategy: "bypass" },
      advanced: { rawArgs: ["--remote", "unix://"] }
    },
    workspace: home
  }), /Advanced rawArgs contains reserved argument: --remote/u);
  const controlPlane = createExactControlPlaneDescriptor({
    executable: process.execPath,
    cliEntry: join(root, "dist", "cli.js"),
    yuiHome: home
  });
  const bootstrap = materializeSessionBootstrap({
    yuiHome: home,
    role,
    owner: { scope: "global" },
    roleKind: "operator",
    skills: [],
    controlPlane
  });

  assert.equal(typeof roleLaunchPlanner.addCodexSharedDaemonRemote, "function");
  assert.deepEqual(
    roleLaunchPlanner.addCodexSharedDaemonRemote(["--model", "gpt-test"], "new"),
    ["--model", "gpt-test", "--remote", "unix://"]
  );
  assert.deepEqual(
    roleLaunchPlanner.addCodexSharedDaemonRemote(
      ["--model", "gpt-test", "resume", "thread-1"],
      "resume"
    ),
    ["--model", "gpt-test", "--remote", "unix://", "resume", "thread-1"]
  );
  const remoteWithContext = roleLaunchPlanner.addCodexSharedDaemonRemote(
    ["--model", "gpt-test"],
    "new",
    {
      PATH: "/not-forwarded",
      YUI_HOME: home,
      YUI_ROLE: "operator",
      YUI_SESSION_MANIFEST: bootstrap.manifestPath,
      YUI_SESSION_SCOPE: "global"
    }
  );
  assert.deepEqual(remoteWithContext.slice(-4, -2), ["--remote", "unix://"]);
  assert.equal(remoteWithContext.at(-2), "--config");
  assert.match(remoteWithContext.at(-1), /shell_environment_policy\.set=/u);
  assert.match(remoteWithContext.at(-1), /"YUI_ROLE"="operator"/u);
  assert.doesNotMatch(remoteWithContext.at(-1), /PATH/u);
  const planned = new roleLaunchPlanner.FileRoleLaunchPlanner(home, store, {
    cliPath: join(root, "dist", "cli.js"),
    environment: { ...bareEnv, CODEX_HOME: join(home, "codex-home") }
  }).planGlobalRole({
    roleName: role.name,
    agentId: agent.id,
    adapterId: agent.adapterId,
    mode: "new",
    launchId: "operator-launch-1"
  });
  assert.ok(planned.launch.args.includes("--remote"));
  assert.ok(planned.launch.args.includes("unix://"));
  assert.ok(planned.launch.args.some((argument) => (
    argument.includes("shell_environment_policy.set=")
    && argument.includes("YUI_SESSION_MANIFEST")
  )));
  assert.doesNotMatch(bootstrap.manifest.contextProtocol.loadCommand, /\$YUI_/u);
  assert.doesNotMatch(bootstrap.manifest.contextProtocol.loadCommand, /--yui-control/u);
  assert.match(bootstrap.manifest.contextProtocol.loadCommand, /session context 'operator' --json/u);
  assert.match(bootstrap.manifest.contextProtocol.loadCommand, /YUI_HOME=/u);
  const directContext = JSON.parse(execFileSync(
    "/bin/sh",
    ["-c", bootstrap.manifest.contextProtocol.loadCommand],
    { cwd: home, encoding: "utf8", env: bareEnv }
  ));
  const directContextData = JSON.parse(directContext.output);
  assert.equal(directContextData.identity.roleName, "operator");
  assert.equal(directContextData.identity.scope, "global");
});

test("Managed Codex performs the App Server WebSocket handshake through its proxy", async (t) => {
  let session;
  t.after(() => session?.terminate("SIGTERM"));
  let resolveTerminal;
  const terminalPromise = new Promise((resolvePromise) => {
    resolveTerminal = resolvePromise;
  });
  const starts = [];
  const attemptId = "fake-attempt-1";
  const started = await startStructuredProviderSession({
    schemaVersion: 1,
    launchId: "fake-launch-1",
    command: process.execPath,
    args: [join(root, "test", "fixtures", "fake-codex-app-server-proxy.mjs")],
    environment: bareEnv,
    cwd: root,
    childLifecycle: "persistent",
    startMode: "provider",
    providerControl: {
      schemaVersion: 1,
      adapterId: "codex",
      transport: "codex-app-server-proxy",
      kind: "new",
      mode: "new",
      sessionTitle: "Yui proxy handshake smoke",
      authority: { epoch: 1, owner: "controller", holderId: "core-smoke" },
      codexThread: { model: "gpt-5.6-luna", approvalPolicy: "never", sandbox: "read-only" },
    }
  }, {
    onStarted: (turn) => starts.push(turn),
    onTerminal: resolveTerminal,
    mirrorOutput: () => {}
  });
  session = started.session;
  const receipt = await session.submitTurn({ attemptId, boundedText: "handshake smoke" });
  const terminal = await terminalPromise;

  assert.equal(receipt.conversationId, "fake-thread-1");
  assert.equal(receipt.nativeTurnId, "fake-turn-1");
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.clientOwned, true);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].clientOwned, true);
  assert.equal(terminal.summary, "Native Codex result.");
});

test("Task execution can be fenced without changing semantic progress", () => {
  const now = new Date("2026-08-30T00:00:00.000Z");
  const active = activateTask(createTask("task-1", "Continue safely", now), now);
  const stopped = stopTaskExecution(active, new Date("2026-08-30T00:01:00.000Z"));
  assert.equal(stopped.status, "active");
  assert.equal(stopped.executionGate.state, "stopped");
  const restarted = startTaskExecution(stopped, new Date("2026-08-30T00:02:00.000Z"));
  assert.equal(restarted.status, "active");
  assert.equal(restarted.executionGate.state, "enabled");
});

test("SQLite projects an active native Session and its Host activation", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-active-session-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-08-31T00:00:00.000Z");
  const task = activateTask(createTask("task-1", "Bind the native Session", now), now);
  store.saveTask(task);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const leader = createRole(
    task.id,
    "leader",
    [binding],
    binding.agentId,
    "/tmp/yui-active-session-smoke",
    now
  );
  store.saveRole(task.id, leader);
  const empty = createRoleSessionSet(
    { scope: "task", taskId: task.id, roleName: leader.name },
    binding.agentId,
    now
  );
  const sessions = recordRoleAgentSession(empty, {
    agentId: binding.agentId,
    adapterId: binding.adapterId,
    nativeSessionId: "native-session-1",
    launchId: "launch-1",
    policy: "fixed",
    status: "active",
    effective: resolveEffectiveLaunch({ role: leader, purpose: "execution" })
  }, now);

  assert.doesNotThrow(() => store.saveRoleSessionSet(sessions));
  assert.deepEqual(store.listRuntimeSessionCandidates({ taskIds: [task.id] }), [{
    owner: { scope: "task", taskId: task.id, roleName: leader.name },
    agentId: binding.agentId,
    adapterId: binding.adapterId,
    nativeSessionId: "native-session-1",
    launchId: "launch-1",
    sessionUpdatedAt: now.toISOString(),
    cleanupRequired: true
  }]);
});

test("runtime pre-start persists the empty Session binding before Provider discovery", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-prestart-session-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-08-31T00:00:00.000Z");
  const task = activateTask(createTask("task-1", "Pre-start binding", now), now);
  store.saveTask(task);
  const agent = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(task.id, "leader", [agent], agent.agentId, "/tmp/yui-prestart", now);
  store.saveRole(task.id, role);
  const run = createTurn(
    "turn-1",
    task.id,
    role.name,
    "new",
    turnInput("turn-1", task.id, role.name, "Start Provider."),
    now,
    { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }
  );
  store.saveActiveTurn(run);

  new FileSchedulerStoreAdapter(store).saveRoleTurnPrepared({
    task,
    role,
    turn: run,
    session: null,
    launchId: "activation-1",
    now
  });

  const sessions = store.getTaskRoleSessionSet(task.id, role.name);
  assert.notEqual(sessions, null);
  assert.deepEqual(sessions.sessions, {});
  assert.equal(sessions.providerBinding, null);
});

test("Turns record provider-visible input without delivery handshake state", () => {
  const now = new Date("2026-08-31T00:00:00.000Z");
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(
    "task-1",
    "leader",
    [binding],
    binding.agentId,
    "/tmp/yui-run-boundary-smoke",
    now
  );
  const run = createTurn(
    "turn-1",
    "task-1",
    role.name,
    "new",
    turnInput(
      "turn-1",
      "task-1",
      role.name,
      "Read the durable Task context and continue."
    ),
    now,
    { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }
  );
  const sessions = createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: role.name },
    binding.agentId,
    now
  );
  const mailbox = createWorkMailbox({ kind: "role", taskId: "task-1", roleName: role.name });

  assert.equal(run.schemaVersion, 3);
  assert.deepEqual(run.inputs[0].input.source, { type: "yui", channel: "task-dispatch" });
  assert.equal(run.inputs[0].input.directive, "Read the durable Task context and continue.");
  for (const legacyField of ["pushedAt", "deliveredAt", "deliveryReceiptId", "controlRequest"]) {
    assert.equal(Object.hasOwn(run, legacyField), false);
  }
  assert.equal(sessions.schemaVersion, 11);
  assert.equal(Object.hasOwn(sessions, "inFlight"), false);
  assert.equal(mailbox.schemaVersion, 5);
  assert.equal(mailbox.pending, null);
  assert.equal(mailbox.processing, null);
  assert.deepEqual(mailbox.recentDedupeKeys, []);
  assert.equal(Object.hasOwn(mailbox, "inputDelivery"), false);
  assert.throws(
    () => validateTurn({ ...run, deliveredAt: now.toISOString() }),
    /unknown field: deliveredAt/u
  );
  assert.throws(
    () => validateRoleSessionSet({ ...sessions, inFlight: null }),
    /unknown field: inFlight/u
  );
});

test("Task-scoped Turn listing includes Leader Turns without a WorkItem", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-turn-list-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-08-31T00:00:00.000Z");
  const task = activateTask(createTask("task-1", "List every Task Turn", now), now);
  store.saveTask(task);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(task.id, "leader", [binding], binding.agentId, "/tmp/yui-turn-list", now);
  store.saveRole(task.id, role);
  store.saveActiveTurn(createTurn(
    "turn-1",
    task.id,
    role.name,
    "new",
    turnInput("turn-1", task.id, role.name, "Inspect the Task."),
    now,
    { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }
  ));

  const result = runTaskCommand(["turn", "list", task.id], store);
  assert.equal(result.kind, "output");
  assert.match(result.output, /Turns: task-1/u);
  assert.match(result.output, /turn-1/u);
  assert.match(result.output, /task/u);
});

test("Provider acceptance consumes only the submitted mailbox prefix", () => {
  const target = { kind: "role", taskId: "task-1", roleName: "worker" };
  const first = enqueueSignal(createWorkMailbox(target), {
    reason: "message-added",
    refs: [{ type: "message", taskId: "task-1", id: "message-1" }],
    occurredAt: "2026-08-31T00:00:00.000Z",
    dedupeKey: "message-1"
  });
  const submitted = first.pending;
  const merged = enqueueSignal(first, {
    reason: "message-added",
    refs: [{ type: "message", taskId: "task-1", id: "message-2" }],
    occurredAt: "2026-08-31T00:00:01.000Z",
    dedupeKey: "message-2"
  });
  const consumed = consumePendingBatch(merged, submitted);

  assert.equal(consumed.pending.fromSequence, 2);
  assert.equal(consumed.pending.toSequence, 2);
  assert.equal(consumed.pending.requestCount, 1);
  assert.deepEqual(consumed.pending.dedupeKeys, ["message-2"]);
  assert.deepEqual(consumed.recentDedupeKeys, ["message-1"]);
});

test("Yui and direct Turns share one Provider conversation", () => {
  let binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex",
    accountScope: "default",
    conversationId: "thread-1",
    activationId: "activation-1",
    startedAt: "2026-08-31T00:00:00.000Z"
  });
  binding = beginProviderTurn(binding, {
    attemptId: "ordinary-turn-1",
    authorityEpoch: 1,
    submittedAt: "2026-08-31T00:00:02.000Z"
  });
  binding = acceptProviderTurn(binding, {
    attemptId: "ordinary-turn-1",
    nativeTurnId: "turn-ordinary-1",
    acceptedAt: "2026-08-31T00:00:03.000Z"
  });
  binding = settleProviderTurn(binding, {
    nativeTurnId: "turn-ordinary-1",
    status: "completed",
    settledAt: "2026-08-31T00:00:04.000Z"
  });
  binding = beginProviderTurn(binding, {
    turnId: "turn-1",
    attemptId: "agent-input:task-1/turn-1:2-2",
    authorityEpoch: 1,
    submittedAt: "2026-08-31T00:00:06.000Z"
  });

  assert.equal(binding.currentConversationEpoch, 1);
  assert.equal(binding.conversations[0].conversationId, "thread-1");
  assert.equal(binding.activations.length, 1);
  assert.equal(binding.turn.turnId, "turn-1");
});

test("a direct Provider Turn records visible input and output without workflow state", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-direct-provider-turn-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const startedAt = new Date("2026-08-31T00:30:00.000Z");
  const completedAt = new Date("2026-08-31T00:31:00.000Z");
  const task = activateTask(createTask("task-1", "Direct conversation", startedAt), startedAt);
  store.saveTask(task);
  const agent = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(
    task.id,
    "worker",
    [agent],
    agent.agentId,
    "/tmp/yui-direct-provider-turn-smoke",
    startedAt
  );
  store.saveRole(task.id, role);
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  let sessions = recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: task.id, roleName: role.name },
    agent.agentId,
    startedAt
  ), {
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    nativeSessionId: "thread-1",
    launchId: "activation-1",
    policy: "fixed",
    status: "active",
    effective
  }, startedAt);
  let provider = createProviderRuntimeBinding({
    providerNamespace: "openai/codex",
    accountScope: agent.agentId,
    conversationId: "thread-1",
    activationId: "activation-1",
    startedAt: startedAt.toISOString()
  });
  provider = updateProviderGoal(provider, {
    status: "active",
    objective: "Continue until the delegated work is actually complete.",
    updatedAt: "2026-08-31T00:30:01.500Z"
  });
  sessions = bindTaskRoleProviderRuntime(sessions, provider, startedAt);
  store.saveTaskRoleSessionSet(sessions);
  const adapter = new FileSchedulerStoreAdapter(store);
  const commonFence = {
    taskId: task.id,
    roleName: role.name,
    agentId: agent.agentId,
    driverId: "openai/codex",
    launchId: "activation-1",
    sessionGenerationId: "activation-1",
    conversationId: "thread-1",
    activationId: "activation-1",
    nativeSessionId: "thread-1"
  };
  const observation = (kind, ordinal, extra = {}) => ({
    schemaVersion: 2,
    eventId: `direct-turn-${ordinal}`,
    semanticKey: `direct-turn-${kind}-${ordinal}`,
    kind,
    authority: "provider-structured",
    receivedAt: `2026-08-31T00:30:0${ordinal}.000Z`,
    observedAt: `2026-08-31T00:30:0${ordinal}.000Z`,
    sequence: 1,
    ordinal,
    fence: { ...commonFence, ...(extra.fence ?? {}) },
    payload: extra.payload ?? {}
  });

  for (const event of [
    observation("session.ready", 2),
    observation("conversation.observed", 3, { payload: { recoverability: "recoverable" } }),
    observation("activation.started", 4),
    observation("turn.accepted", 5, {
      fence: { nativeTurnId: "turn-ordinary-1", receiptId: "direct:turn-ordinary-1" },
      payload: { input: "Please inspect the current code." }
    })
  ]) {
    assert.equal(adapter.observeRuntimeObservation(event, completedAt), "applied");
  }
  assert.equal(
    store.getTaskRoleSessionSet(task.id, role.name).providerBinding.turn.status,
    "accepted"
  );
  const directTurn = store.getActiveTurn(task.id, role.name);
  assert.notEqual(directTurn, null);
  const terminal = {
    taskId: task.id,
    roleName: role.name,
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    launchId: "activation-1",
    nativeSessionId: "thread-1",
    nativeTurnId: "turn-ordinary-1",
    attemptId: "direct:turn-ordinary-1",
    turnId: directTurn.id,
    input: "Please inspect the current code.",
    summary: "Ordinary conversation reply.",
    providerStatus: "completed"
  };

  assert.equal(adapter.classifyRuntimeTurnCompleted(terminal), "apply");
  const observed = adapter.observeRuntimeTurnCompleted(terminal, completedAt);
  assert.equal(observed.duplicate, false);
  assert.equal(observed.turn.inputs[0].input.source.type, "user");
  assert.equal(observed.turn.inputs[0].input.source.channel, "direct");
  assert.equal(observed.turn.inputs[0].input.directive, "Please inspect the current code.");
  assert.equal(observed.turn.result.output, "Ordinary conversation reply.");
  assert.equal(store.listTurns(task.id).length, 1);
  assert.equal(store.getTask(task.id).status, "active");
  assert.equal(store.getTaskRoleSessionSet(task.id, role.name).providerBinding.turn.status, "completed");
  assert.equal(store.getPendingWakeup(task.id), null);

  const continuationAt = new Date("2026-08-31T00:31:00.500Z");
  assert.equal(adapter.observeRuntimeObservation(observation("turn.accepted", 6, {
    fence: { nativeTurnId: "turn-goal-2", receiptId: "direct:turn-goal-2" }
  }), continuationAt), "applied");
  const goalTurn = store.getActiveTurn(task.id, role.name);
  assert.notEqual(goalTurn, null);
  const continued = adapter.observeRuntimeTurnCompleted({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    launchId: "activation-1",
    nativeSessionId: "thread-1",
    nativeTurnId: "turn-goal-2",
    attemptId: "direct:turn-goal-2",
    turnId: goalTurn.id,
    summary: "Goal-directed continuation reply.",
    providerStatus: "completed"
  }, continuationAt);
  assert.deepEqual(continued.turn.inputs[0].input.source, {
    type: "provider",
    channel: "goal-continuation"
  });
  assert.equal(continued.turn.inputs[0].input.directive, undefined);
  assert.equal(store.listTurns(task.id).length, 2);
  assert.equal(store.getPendingWakeup(task.id), null);

  assert.equal(adapter.observeRuntimeObservation(observation("goal.updated", 7, {
    payload: {
      goalStatus: "complete",
      goalObjective: "Continue until the delegated work is actually complete.",
      goalUpdatedAt: "2026-08-31T00:31:01.000Z",
      goalNativeTurnId: "turn-ordinary-1"
    }
  }), new Date("2026-08-31T00:31:01.000Z")), "applied");
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["provider-goal-complete"]);
});

test("Leader wakeups aggregate for one minute and force-steer after ten", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-leader-wake-window-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const firstEventAt = new Date("2026-08-31T01:00:00.000Z");
  const workspaceRoot = "/tmp/yui-leader-wake-window-smoke";
  const task = activateTask(createTask("task-1", "Aggregate Leader events", firstEventAt, {
    cwd: workspaceRoot
  }), firstEventAt);
  store.saveTask(task);
  const workspace = createManagedWorkspace({
    owner: { type: "task", taskId: task.id },
    root: workspaceRoot,
    entries: []
  }, firstEventAt);
  store.saveManagedWorkspace(workspace);
  const agent = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const leader = createRole(
    task.id,
    "leader",
    [agent],
    agent.agentId,
    workspaceRoot,
    firstEventAt
  );
  store.saveRole(task.id, leader);
  const effective = resolveEffectiveLaunch({ role: leader, purpose: "execution" });
  let sessions = recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: task.id, roleName: leader.name },
    agent.agentId,
    firstEventAt
  ), {
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    nativeSessionId: "thread-1",
    launchId: "activation-1",
    policy: "fixed",
    status: "active",
    effective
  }, firstEventAt);
  let provider = createProviderRuntimeBinding({
    providerNamespace: "openai/codex",
    accountScope: agent.agentId,
    conversationId: "thread-1",
    activationId: "activation-1",
    startedAt: firstEventAt.toISOString()
  });
  provider = beginProviderTurn(provider, {
    turnId: "turn-1",
    attemptId: "turn-input:task-1/turn-1/1",
    authorityEpoch: provider.authority.epoch,
    submittedAt: firstEventAt.toISOString()
  });
  provider = acceptProviderTurn(provider, {
    attemptId: "turn-input:task-1/turn-1/1",
    nativeTurnId: "native-turn-1",
    acceptedAt: new Date(firstEventAt.getTime() + 1_000).toISOString()
  });
  sessions = bindTaskRoleProviderRuntime(sessions, provider, firstEventAt);
  store.saveTaskRoleSessionSet(sessions);
  const active = createTurn(
    "turn-1",
    task.id,
    leader.name,
    "new",
    turnInput("turn-1", task.id, leader.name, "Continue the original task."),
    firstEventAt,
    { workspace, effective }
  );
  store.saveActiveTurn(active);
  const adapter = new FileSchedulerStoreAdapter(store);
  adapter.enqueueLeaderWakeup(task.id, "worker-completed", firstEventAt);

  const steers = [];
  let enqueueDuringSteer = false;
  const delivery = {
    steerOnce: async (request) => {
      steers.push(request);
      if (enqueueDuringSteer) {
        adapter.enqueueLeaderWakeup(
          task.id,
          "event-arrived-during-steer",
          new Date(firstEventAt.getTime() + LEADER_WAKE_FORCE_MS)
        );
      }
      return "sent";
    }
  };
  let results = await processLeaderWakeups(
    adapter,
    delivery,
    new Date(firstEventAt.getTime() + LEADER_WAKE_AGGREGATION_MS - 1)
  );
  assert.equal(results[0].reason, "aggregating");
  assert.equal(steers.length, 0);

  enqueueDuringSteer = true;
  results = await processLeaderWakeups(
    adapter,
    delivery,
    new Date(firstEventAt.getTime() + LEADER_WAKE_AGGREGATION_MS)
  );
  assert.equal(results[0].reason, "busy");
  adapter.enqueueLeaderWakeup(
    task.id,
    "reviewer-completed",
    new Date(firstEventAt.getTime() + 5 * 60_000)
  );
  assert.equal(store.getPendingWakeup(task.id).firstRequestedAt, firstEventAt.toISOString());

  results = await processLeaderWakeups(
    adapter,
    delivery,
    new Date(firstEventAt.getTime() + LEADER_WAKE_FORCE_MS)
  );
  assert.equal(results[0].status, "steered");
  assert.equal(steers.length, 1);
  assert.match(steers[0].text, /worker-completed, reviewer-completed/u);
  assert.match(steers[0].text, /waited at least 10 minutes/u);
  assert.match(steers[0].text, /continue the work you were doing/u);
  const updated = store.getActiveTurn(task.id, leader.name);
  assert.equal(updated.inputs.length, 2);
  assert.equal(updated.inputs[1].input.source.type, "yui");
  assert.equal(updated.inputs[1].input.source.channel, "leader-forced-wakeup");
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["event-arrived-during-steer"]);
  assert.equal(store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" }).processing, null);

  const leaderTarget = { kind: "role", taskId: task.id, roleName: "leader" };
  store.saveWorkMailbox(claimPending(store.getWorkMailbox(leaderTarget), {
    batchId: "stale-steer-batch",
    owner: "leader-steer:turn-retired",
    startedAt: new Date(firstEventAt.getTime() + LEADER_WAKE_FORCE_MS).toISOString()
  }));
  assert.equal(adapter.listPendingWakeups().length, 1);
  results = await processLeaderWakeups(
    adapter,
    delivery,
    new Date(firstEventAt.getTime() + 21 * 60_000)
  );
  assert.equal(results[0].reason, "state-changed");
  assert.equal(store.getWorkMailbox(leaderTarget).processing, null);
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["event-arrived-during-steer"]);
});

test("an active Task without a durable event remains quiet", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-active-task-quiet-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-08-31T00:30:00.000Z");
  const workspaceRoot = "/tmp/yui-active-task-quiet-smoke";
  const task = activateTask(createTask("task-1", "Wait for a real event", now, {
    cwd: workspaceRoot
  }), now);
  store.saveTask(task);
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: task.id },
    root: workspaceRoot,
    entries: []
  }, now));
  const agent = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  store.saveRole(task.id, createRole(
    task.id,
    "leader",
    [agent],
    agent.agentId,
    workspaceRoot,
    now
  ));
  const adapter = new FileSchedulerStoreAdapter(store);
  let deliveryCalls = 0;
  const delivery = {
    prepareRoleSession: async () => { deliveryCalls += 1; throw new Error("unexpected dispatch"); },
    waitUntilReady: async () => { deliveryCalls += 1; throw new Error("unexpected dispatch"); },
    sendOnce: async () => { deliveryCalls += 1; throw new Error("unexpected dispatch"); },
    inspectRole: async () => "absent"
  };

  await runControllerSchedulerPass(
    adapter,
    delivery,
    new Date(now.getTime() + 5 * 60_000),
    undefined,
    { kind: "full" },
    false
  );

  assert.equal(deliveryCalls, 0);
  assert.deepEqual(store.listTurns(task.id), []);
  assert.equal(store.getPendingWakeup(task.id), null);
  assert.equal(store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" }), null);
});

test("an unowned ended Provider binding does not block the next Turn", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-unowned-provider-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const startedAt = new Date("2026-08-31T01:00:00.000Z");
  const nextAt = new Date("2026-08-31T01:01:00.000Z");
  const workspaceRoot = "/tmp/yui-unowned-provider-smoke";
  const task = activateTask(createTask("task-1", "Start the next Turn", startedAt, {
    cwd: workspaceRoot
  }), startedAt);
  store.saveTask(task);
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: task.id },
    root: workspaceRoot,
    entries: []
  }, startedAt));
  const agent = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const leader = createRole(
    task.id,
    "leader",
    [agent],
    agent.agentId,
    workspaceRoot,
    startedAt
  );
  store.saveRole(task.id, leader);
  const effective = resolveEffectiveLaunch({ role: leader, purpose: "execution" });
  let sessions = recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: task.id, roleName: leader.name },
    agent.agentId,
    startedAt
  ), {
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    nativeSessionId: "thread-old",
    launchId: "activation-old",
    policy: "fixed",
    status: "ended",
    endReason: "stopped",
    effective
  }, startedAt);
  let provider = createProviderRuntimeBinding({
    providerNamespace: "openai/codex",
    accountScope: agent.agentId,
    conversationId: "thread-old",
    activationId: "activation-old",
    startedAt: startedAt.toISOString()
  });
  provider = beginProviderTurn(provider, {
    turnId: "turn-old",
    attemptId: "turn:task-1/turn-old",
    authorityEpoch: provider.authority.epoch,
    submittedAt: startedAt.toISOString()
  });
  provider = acceptProviderTurn(provider, {
    attemptId: "turn:task-1/turn-old",
    nativeTurnId: "native-turn-old",
    acceptedAt: new Date(startedAt.getTime() + 1_000).toISOString()
  });
  provider = endProviderActivation(provider, "activation-old", {
    status: "ended",
    endedAt: new Date(startedAt.getTime() + 2_000).toISOString(),
    reason: "session-ended"
  });
  sessions = bindTaskRoleProviderRuntime(sessions, provider, startedAt);
  store.saveTaskRoleSessionSet(sessions);
  const turn = createTurn(
    "turn-1",
    task.id,
    leader.name,
    "new",
    turnInput("turn-1", task.id, leader.name, "Continue from durable Task context."),
    nextAt,
    { effective }
  );
  store.saveActiveTurn(turn);

  let preparedCalls = 0;
  const prepared = {
    deliveryId: "delivery-1",
    launchId: "activation-new",
    turnId: turn.id,
    taskId: task.id,
    roleName: leader.name,
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    mode: "new",
    sessionStarted: true,
    session: null
  };
  const delivery = {
    prepareRoleSession: async () => {
      preparedCalls += 1;
      return prepared;
    },
    waitUntilReady: async () => ({
      prepared,
      session: {
        agentId: agent.agentId,
        adapterId: agent.adapterId,
        nativeSessionId: "thread-new",
        launchId: "activation-new",
        status: "active",
        effective
      }
    }),
    sendOnce: async () => "sent",
    inspectRole: async () => "present"
  };

  const [result] = await processActiveRoleTurnDeliveries(
    new FileSchedulerStoreAdapter(store),
    delivery,
    nextAt
  );
  assert.equal(result.status, "delivered");
  assert.equal(preparedCalls, 1);
});

test("Task completion leaves its reusable Provider Session running", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-completed-task-session-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-08-31T00:45:00.000Z");
  const task = activateTask(createTask("task-1", "Keep the conversation", now), now);
  store.saveTask(task);
  const agent = createRoleAgentBinding({ id: "claude", adapterId: "claude" });
  const role = createRole(
    task.id,
    "leader",
    [agent],
    agent.agentId,
    "/tmp/yui-completed-task-session-smoke",
    now
  );
  store.saveRole(task.id, role);
  const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
  const sessions = recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: task.id, roleName: role.name },
    agent.agentId,
    now
  ), {
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    nativeSessionId: "session-1",
    launchId: "activation-1",
    policy: "fixed",
    status: "active",
    effective
  }, now);
  store.saveTaskRoleSessionSet(sessions);
  runTaskCommand(
    ["complete", task.id, "--summary", "Leader accepted the result."],
    store,
    { now: () => new Date("2026-08-31T00:46:00.000Z"), environment: bareEnv }
  );
  const adapter = new FileSchedulerStoreAdapter(store);
  const unreachableDelivery = {
    prepareRoleSession: async () => { throw new Error("completed Task must not dispatch"); },
    waitUntilReady: async () => { throw new Error("completed Task must not dispatch"); },
    sendOnce: async () => { throw new Error("completed Task must not dispatch"); },
    inspectRole: async () => "present"
  };

  await runControllerSchedulerPass(
    adapter,
    unreachableDelivery,
    new Date("2026-08-31T00:47:00.000Z"),
    undefined,
    { kind: "full" },
    false
  );

  assert.equal(store.getTaskRoleSessionSet(task.id, role.name).sessions[agent.agentId].status, "active");
  assert.equal(store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId: task.id,
    roleName: role.name
  })), null);
});

test("the exact Provider Turn terminal atomically completes its Turn once", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-provider-terminal-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const startedAt = new Date("2026-08-31T01:00:00.000Z");
  const completedAt = new Date("2026-08-31T01:01:00.000Z");
  const task = activateTask(createTask("task-1", "Automatic Turn result", startedAt), startedAt);
  store.saveTask(task);
  const agent = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(
    task.id,
    "leader",
    [agent],
    agent.agentId,
    "/tmp/yui-provider-terminal-smoke",
    startedAt
  );
  store.saveRole(task.id, role);
  const run = createTurn(
    "turn-1",
    task.id,
    role.name,
    "new",
    turnInput("turn-1", task.id, role.name, "Finish this managed Turn."),
    startedAt,
    { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }
  );
  store.saveActiveTurn(run);
  let sessions = recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: task.id, roleName: role.name },
    agent.agentId,
    startedAt
  ), {
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    nativeSessionId: "thread-1",
    launchId: "activation-1",
    policy: "fixed",
    status: "active",
    effective: run.effective
  }, startedAt);
  let provider = createProviderRuntimeBinding({
    providerNamespace: "openai/codex",
    accountScope: agent.agentId,
    conversationId: "thread-1",
    activationId: "activation-1",
    startedAt: startedAt.toISOString()
  });
  provider = beginProviderTurn(provider, {
    turnId: run.id,
    attemptId: "run:task-1/turn-1",
    authorityEpoch: provider.authority.epoch,
    submittedAt: "2026-08-31T01:00:01.000Z"
  });
  provider = acceptProviderTurn(provider, {
    attemptId: "run:task-1/turn-1",
    nativeTurnId: "turn-1",
    acceptedAt: "2026-08-31T01:00:02.000Z"
  });
  sessions = bindTaskRoleProviderRuntime(sessions, provider, startedAt);
  store.saveTaskRoleSessionSet(sessions);
  const adapter = new FileSchedulerStoreAdapter(store);
  const terminal = {
    taskId: task.id,
    roleName: role.name,
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    launchId: "activation-1",
    nativeSessionId: "thread-1",
    nativeTurnId: "turn-1",
    attemptId: "run:task-1/turn-1",
    turnId: run.id,
    summary: "Managed execution finished.",
    providerStatus: "completed"
  };
  runTaskCommand(
    ["message", "send", task.id, "A newer fact arrived during the current Turn."],
    store,
    { now: () => new Date("2026-08-31T01:00:30.000Z"), environment: bareEnv }
  );

  assert.deepEqual(adapter.observeRuntimeTurnCompleted(terminal, completedAt), {
    session: store.getTaskRoleSessionSet(task.id, role.name).sessions[agent.agentId],
    duplicate: false,
    turn: store.getTurn(task.id, run.id)
  });
  const completed = store.getTurn(task.id, run.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.output, "Managed execution finished.");
  assert.deepEqual(completed.result.provider, {
    providerNamespace: "openai/codex",
    accountScope: agent.agentId,
    conversationId: "thread-1",
    activationId: "activation-1",
    nativeTurnId: "turn-1",
    status: "completed"
  });
  assert.equal(store.getActiveTurn(task.id, role.name), null);
  assert.equal(store.getTaskRoleSessionSet(task.id, role.name).sessions[agent.agentId].status, "active");

  const replay = adapter.observeRuntimeTurnCompleted(terminal, completedAt);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.turn.id, run.id);
  assert.equal(store.listTurns(task.id).length, 1);

  const leaderMailbox = store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: role.name });
  assert.deepEqual(leaderMailbox.pending.reasons, ["user-message"]);
  assert.equal(leaderMailbox.processing, null);
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["user-message"]);
  assert.equal(store.getLeaderFailure(task.id), null);
  assert.equal(adapter.hasOpenInputRequest(task.id), false);
  assert.deepEqual(adapter.listActiveTaskIds(), [task.id]);
  assert.equal(
    store.getTaskRoleSessionSet(task.id, role.name).sessions[agent.agentId].nativeSessionId,
    "thread-1"
  );
});

test("Task execution stop/start atomically controls scheduler admission", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-execution-gate-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-08-30T00:00:00.000Z");
  const task = activateTask(createTask("task-1", "Preserve progress", now), now);
  store.saveTask(task);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const leader = createRole(
    task.id,
    "leader",
    [binding],
    binding.agentId,
    "/tmp/yui-execution-gate-smoke",
    now
  );
  store.saveRole(task.id, leader);
  const item = updateWorkItemStatus(
    createWorkItem("work-item-1", task.id, { title: "Keep completed edits" }, now),
    "running",
    now
  );
  store.saveWorkItem(task.id, item);
  const activeTurn = createTurn(
    "turn-1",
    task.id,
    leader.name,
    "new",
    turnInput("turn-1", task.id, leader.name, "Continue the Task."),
    now,
    {
      effective: resolveEffectiveLaunch({ role: leader, purpose: "execution" })
    }
  );
  store.saveActiveTurn(activeTurn);

  const stopped = stopTaskExecutionCommand(
    { taskId: task.id, reason: "Operator safety fence" },
    store,
    { now: () => new Date("2026-08-30T00:01:00.000Z"), environment: bareEnv }
  );
  assert.equal(stopped.changed, true);
  assert.equal(store.getTask(task.id).status, "active");
  assert.equal(store.getTask(task.id).executionGate.state, "stopped");
  assert.deepEqual(store.listActiveTaskIds(), []);
  assert.equal(buildTaskExecutionProjection(store, task.id).status, "stopped");
  assert.equal(
    projectNextAction(store.readNextActionFacts(task.id)).recommendedCommand,
    `yui task execution start ${task.id}`
  );
  assert.equal(store.getTurn(task.id, activeTurn.id).status, "failed");
  assert.equal(store.getActiveTurn(task.id, leader.name), null);
  assert.equal(store.getWorkItem(task.id, item.id).status, "running");
  assert.throws(() => runTaskCommand(
    ["turn", "retry", `${task.id}/${activeTurn.id}`],
    store,
    { now: () => new Date("2026-08-30T00:01:30.000Z"), environment: bareEnv }
  ), /Task execution is stopped/);
  assert.equal(store.getActiveTurn(task.id, leader.name), null);

  const started = startTaskExecutionCommand(task.id, store, {
    now: () => new Date("2026-08-30T00:02:00.000Z"),
    environment: bareEnv
  });
  assert.equal(started.changed, true);
  assert.equal(store.getTask(task.id).executionGate.state, "enabled");
  assert.deepEqual(store.listActiveTaskIds(), [task.id]);
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["execution-started"]);

  const completedItem = updateWorkItemStatus(
    store.getWorkItem(task.id, item.id),
    "completed",
    new Date("2026-08-30T00:03:00.000Z"),
    "Edits retained."
  );
  store.saveWorkItem(task.id, completedItem);
  const disposableRun = createTurn(
    "turn-2",
    task.id,
    leader.name,
    "new",
    turnInput("turn-2", task.id, leader.name, "Finish the Task."),
    new Date("2026-08-30T00:03:00.000Z"),
    { effective: activeTurn.effective }
  );
  store.saveActiveTurn(disposableRun);
  runTaskCommand(
    ["complete", task.id, "--summary", "Delivery complete."],
    store,
    { now: () => new Date("2026-08-30T00:04:00.000Z"), environment: bareEnv }
  );
  assert.equal(store.getTask(task.id).status, "completed");
  assert.equal(store.getTurn(task.id, disposableRun.id).status, "active");
  assert.equal(store.getActiveTurn(task.id, leader.name).id, disposableRun.id);
  assert.equal(store.getWorkItem(task.id, completedItem.id).status, "completed");
});

test("a packaged Controller restart inherits its direct parent's handover", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-controller-handover-smoke-"));
  const environment = { ...bareEnv, YUI_HOME: home };
  t.after(() => {
    try {
      execFileSync(
        process.execPath,
        [join(root, "dist", "cli.js"), "controller", "stop"],
        { cwd: root, encoding: "utf8", env: environment }
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  ensureStorageSchema(home);
  new SqliteTaskStore(home).close();

  const handover = acquireHandoverLock(home);
  let restarted;
  try {
    restarted = JSON.parse(execFileSync(
      process.execPath,
      [join(root, "dist", "cli.js"), "--json", "controller", "restart"],
      { cwd: root, encoding: "utf8", env: environment }
    ));
  } finally {
    handover.release();
  }
  assert.equal(restarted.ok, true);
  assert.equal(restarted.data.restarted, true);
  assert.ok(Number.isInteger(restarted.data.pid) && restarted.data.pid > 0);
});

test("production storage exposes only the current contract", () => {
  const latest = latestStorageVersionState();
  assert.ok(Object.values(latest.record).every(({ path }) => path.startsWith("sqlite:")));
  assert.equal(latest.record.turn.path, "sqlite:turn");
  assert.equal(latest.record.workMailbox.path, "sqlite:workMailbox");
  assert.equal(Object.hasOwn(latest.record, "storedTask"), false);
  assert.equal(Object.hasOwn(latest.record, "activeTurnPointer"), false);
  for (const retiredExport of [
    "FileTaskStore",
    "STORAGE_STATE_FILE",
    "validateCurrentStorageStateSnapshot",
    "withStorageWriteLock"
  ]) {
    assert.equal(Object.hasOwn(taskStoreContract, retiredExport), false);
  }
});

test("a new current Home initializes its SQLite authority exactly once", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-current-home-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = initializeCurrentTaskStore(home);
  assert.equal(store.getRevision(), 0);
  store.close();
  assert.ok(existsSync(join(home, "schema.json")));
  assert.ok(existsSync(join(home, "yui.db")));
  const database = new Database(join(home, "yui.db"), { readonly: true });
  try {
    assert.deepEqual(
      database.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      [{ version: 1 }]
    );
  } finally {
    database.close();
  }
});

test("fresh SQLite telemetry persists and aggregates by Turn", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-turn-telemetry-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  const business = new SqliteTaskStore(home);
  business.close();
  const telemetry = new SqliteTelemetryStore(home, { turnCap: 2 });
  t.after(() => telemetry.close());
  telemetry.observe({
    taskId: "task-1",
    roleName: "worker",
    turnId: "turn-1",
    generation: "activation-1",
    progressId: "progress-1",
    sequence: 1,
    payload: { kind: "activity" },
    receivedAt: "2026-08-31T03:00:00.000Z"
  });
  telemetry.observe({
    taskId: "task-1",
    roleName: "worker",
    turnId: "turn-1",
    generation: "activation-1",
    progressId: "progress-2",
    sequence: 2,
    payload: { kind: "activity" },
    receivedAt: "2026-08-31T03:00:01.000Z"
  });
  await telemetry.flush();
  assert.equal(telemetry.count("task-1", "turn-1"), 2);
  assert.deepEqual(
    telemetry.list("task-1", "turn-1").items.map(({ progressId }) => progressId),
    ["progress-1", "progress-2"]
  );
  assert.equal(telemetry.aggregate("task-1", "turn-1").count, 2);
  assert.equal(telemetry.listTurnAggregates("task-1")[0].turnId, "turn-1");
});

test("the built-in Agent Drivers are available through the shared registry", () => {
  const drivers = builtinAgentDriverRegistry();
  assert.equal(drivers.requireByAdapterId("codex").id, "openai/codex");
  assert.equal(drivers.requireByAdapterId("claude").id, "anthropic/claude-code");
  for (const adapterId of ["codex", "claude"]) {
    const mapped = drivers.requireByAdapterId(adapterId).runtime.mapHook({
      hookEventName: "SessionEnd",
      payload: {},
      occurrenceId: "hook-1"
    });
    const observations = Array.isArray(mapped) ? mapped : [mapped];
    assert.deepEqual(observations.map(({ kind }) => kind), ["activation.ended"]);
  }
});

test("Agent errors preserve provider classification and the complete native Error", () => {
  const drivers = builtinAgentDriverRegistry();
  const native = Object.assign(new Error("Selected model is at capacity"), {
    code: "model_capacity",
    requestId: "request-1"
  });
  native.cause = native;
  const raw = serializeAgentErrorRaw(native);
  const classification = drivers.requireByAdapterId("codex").runtime.mapError({
    message: native.message,
    raw
  });
  const error = standardAgentError({
    source: "provider",
    phase: "turn-execute",
    classification,
    message: native.message,
    raw,
    inputDisposition: "accepted"
  });

  assert.equal(error.category, "availability");
  assert.equal(error.code, "provider.model-capacity");
  assert.equal(error.sessionDisposition, "recoverable");
  assert.equal(error.inputDisposition, "accepted");
  assert.match(error.raw, /model_capacity/u);
  assert.match(error.raw, /request-1/u);
  assert.match(error.raw, /stack/u);
  assert.match(error.raw, /\[Circular\]/u);

  for (const adapterId of ["codex", "claude"]) {
    const transport = drivers.requireByAdapterId(adapterId).runtime.mapError({
      message: "connect ECONNREFUSED /tmp/yui/agent-host.sock",
      raw: '{"code":"ECONNREFUSED","syscall":"connect"}'
    });
    assert.equal(transport.category, "transport");
    assert.equal(transport.code, "transport.connection-refused");
    assert.equal(transport.sessionDisposition, "recoverable");
  }

  const unknown = standardAgentError({
    source: "driver",
    phase: "session-restore",
    message: "new native failure",
    raw: '{"shape":"unrecognized"}'
  });
  assert.equal(unknown.category, "unknown");
  assert.equal(unknown.code, "unknown");
  assert.equal(unknown.raw, '{"shape":"unrecognized"}');
});

test("Operator batches durable refs and defers the whole batch while busy", async () => {
  const now = new Date("2026-08-28T00:00:00.000Z");
  const event = createTaskEvent(
    "event-1",
    "task-1",
    "task.completed",
    { by: "leader", summary: "Done." },
    now
  );
  let mailbox = enqueueSignal(createWorkMailbox({ kind: "operator" }), {
    reason: "task-terminal",
    refs: [{ type: "event", taskId: event.taskId, id: event.id }],
    occurredAt: now.toISOString()
  });
  let startedTurns = 0;
  const store = {
    getWorkMailbox: () => mailbox,
    claimWorkMailbox: ({ batchId, owner, now: claimedAt }) => {
      mailbox = claimPending(mailbox, { batchId, owner, startedAt: claimedAt.toISOString() });
      return { status: "claimed", processing: mailbox.processing };
    },
    completeWorkMailbox: (_target, batchId) => {
      mailbox = completeProcessing(mailbox, batchId);
      return true;
    },
    releaseWorkMailbox: (_target, batchId) => {
      mailbox = releaseProcessing(mailbox, batchId);
      return true;
    },
    getInputRequest: () => null,
    listEvents: () => [event],
    getOperatorDeliveryTarget: () => ({ roleName: "operator", adapterId: "codex" }),
    markOperatorTurnStarted: () => {
      startedTurns += 1;
    }
  };
  const delivered = [];
  const result = await processOperatorInputNotifications(store, {
    notifyOperatorInputOnce: async (input) => {
      delivered.push(input);
      return "sent";
    }
  }, undefined, now);

  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /yui task event show task-1 event-1/u);
  assert.equal(result[0].status, "sent");
  assert.equal(startedTurns, 1);
  assert.equal(mailbox.processing, null);
  assert.equal(mailbox.pending, null);

  mailbox = enqueueSignal(mailbox, {
    reason: "task-terminal",
    refs: [{ type: "event", taskId: event.taskId, id: event.id }],
    occurredAt: now.toISOString()
  });
  const deferred = await processOperatorInputNotifications(store, {
    notifyOperatorInputOnce: async () => "not-ready"
  }, undefined, now);
  assert.equal(deferred[0].reason, "operator-not-ready");
  assert.equal(startedTurns, 1);
  assert.equal(mailbox.processing, null);
  assert.notEqual(mailbox.pending, null);
});

test("the async runtime observer preserves completion classification", async () => {
  const calls = [];
  const observer = createAsyncRuntimeObserver(async (method) => {
    calls.push(method);
    return method === "classifyGlobalRuntimeTurnCompleted" ? "apply" : "deferred";
  });

  assert.equal(await observer.classifyRuntimeTurnCompleted({}), "deferred");
  assert.equal(await observer.classifyGlobalRuntimeTurnCompleted({}), "apply");
  assert.deepEqual(calls, [
    "classifyRuntimeTurnCompleted",
    "classifyGlobalRuntimeTurnCompleted"
  ]);
});

test("Claude global Stop hooks publish the native completion boundary", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-claude-global-hook-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let signal;
  await runRuntimeObservationHookCommand(JSON.stringify({
    hook_event_name: "Stop",
    session_id: "claude-session-1",
    last_assistant_message: "Done."
  }), {
    YUI_SESSION_SCOPE: "global",
    YUI_HOME: home,
    YUI_DRIVER_ID: "anthropic/claude-code",
    YUI_ADAPTER_ID: "claude",
    YUI_ROLE: "operator",
    YUI_AGENT_ID: "claude",
    YUI_LAUNCH_ID: "launch-1",
    YUI_NATIVE_SESSION_ID: "claude-session-1"
  }, async (_home, _method, params) => {
    signal = params;
    return null;
  }, new Date("2026-08-28T00:00:00.000Z"), { sequence: () => 1 });

  const [event] = new FileRuntimeEventInbox(home).list();
  assert.equal(event.type, "native-turn-completed");
  assert.equal(event.scope, "global");
  assert.equal(event.adapterId, "claude");
  assert.equal(event.summary, "Done.");
  assert.deepEqual(signal, { key: "global-role:operator" });
});
