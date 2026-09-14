import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { CURRENT_STORAGE_VERSION } from "../../dist/storage/storageVersions.js";
import { openCurrentTaskStore } from "../../dist/storage/currentTaskStore.js";
import {
  publishStructuredProviderActivity, publishStructuredProviderTerminal,
  publishStructuredProviderAccepted, publishStructuredProviderConnection,
  publishStructuredProviderStarted, publishStructuredProviderInputObserved,
  publishStructuredProviderOpened
} from "../../dist/controller/structuredProviderObservation.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { FileRuntimeEventProcessor, AsyncRuntimeEventProcessor, createAsyncRuntimeObserver } from "../../dist/controller/runtimeEventProcessor.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createGlobalRole, createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { bindTaskRoleProviderRuntime, updateTaskRoleProviderRuntime, createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { createProviderRuntimeBinding, beginProviderTurn } from "../../dist/runtime/providerRuntimeIdentity.js";
import { runTaskCommand, submitOperatorMessage } from "../../dist/commands/taskCommands.js";
import { terminalizeExactTaskRun } from "../../dist/lifecycle/exactRunTerminalization.js";
import { createRuntimeLifecycleDispatcher } from "../../dist/controller/runtime.js";
import { startControllerServer } from "../../dist/core/controllerServer.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { migrateSqliteSchema } from "../../dist/storage/sqliteSchema.js";
import { agentHostControlSocketPath } from "../../dist/runtime/agentHost.js";
import { createServer } from "node:net";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { renameSync } from "node:fs";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { runUpdate } from "../../dist/cli/updateOrchestrator.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { TmuxSessionHost } from "../../dist/runtime/tmuxAdapters.js";
import { launchBrokerForHome } from "../../dist/runtime/launchBroker.js";
import { randomBytes } from "node:crypto";
import { createSessionOwnerIdentity, readLinuxProcessIdentity } from "../../dist/runtime/sessionOwnerIdentity.js";
import { rebuildHistoricalFixture } from "../helpers/historicalHome.mjs";

/** Independent minimum RPC-v4 Controller transport; intentionally no current
 * Controller/store parser on the Home-19 side. It authenticates the exact
 * discovery fence and defers persisted facts until the new Controller starts. */
async function startFrozenControllerV4(home, homeId) {
  const metadata = statSync(home, { bigint: true });
  const discovery = {
    schemaVersion: 1, protocolVersion: 4, homeId,
    homeFilesystemId: `${metadata.dev}:${metadata.ino}`,
    controllerInstanceId: randomBytes(16).toString("hex"),
    pid: process.pid, processStartIdentity: readLinuxProcessIdentity(process.pid).startIdentity,
    socketPath: join("/tmp", `yui-${process.getuid()}`, `${homeId}.sock`),
    token: randomBytes(32).toString("hex")
  };
  const requests = [];
  const server = createServer(client => {
    let text = "";
    client.on("data", bytes => {
      text += bytes;
      if (!text.includes("\n")) return;
      const request = JSON.parse(text.trim());
      const valid = request.protocolVersion === 4 && request.token === discovery.token
        && request.homeId === homeId && request.homeFilesystemId === discovery.homeFilesystemId
        && request.controllerInstanceId === discovery.controllerInstanceId
        && request.method === "runtime.host-observation-apply";
      if (!valid) {
        client.end(`${JSON.stringify({ id: request.id, ok: false,
          error: { code: "INVALID_REQUEST", message: "Old Controller fence mismatch" } })}\n`);
        return;
      }
      requests.push(request);
      client.end(`${JSON.stringify({ id: request.id, ok: true, result: { outcome: "deferred" } })}\n`);
    });
  });
  mkdirSync(dirname(discovery.socketPath), { recursive: true, mode: 0o700 });
  await new Promise(resolve => server.listen(discovery.socketPath, resolve));
  chmodSync(discovery.socketPath, 0o600);
  mkdirSync(join(home, "runtime"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "runtime", "controller.json"), JSON.stringify(discovery), { mode: 0o600 });
  return { discovery, requests, close: async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(join(home, "runtime", "controller.json"));
  } };
}

function executionFixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-host-execution-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const now = new Date();
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  store.saveTask(activateTask(createTask("task-1", "Original intent", now, { cwd: home }), now));
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: "task-1" }, root: home, entries: []
  }, now));
  const role = createRole("task-1", "worker", [createRoleAgentBinding(agent)], agent.id, home, now);
  store.saveRole("task-1", role);
  const command = args => runTaskCommand(args, store, { environment: {}, now: () => new Date() });
  command(["work", "create", "task-1", "Bounded result", "--role", "worker"]);
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "work-item", taskId: "task-1", workItemId: "work-item-1" },
    root: home, entries: []
  }, now));
  command(["work", "dispatch", "task-1/work-item-1"]);
  const run = store.getActiveRun("task-1", "worker");
  let sessions = recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "worker" }, agent.id, now
  ), { agentId: agent.id, adapterId: "codex", nativeSessionId: "original-session",
    policy: "fixed", status: "active", effective: run.effective }, now);
  sessions = bindTaskRoleProviderRuntime(sessions, beginProviderTurn(createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex", conversationId: "original-session",
    startedAt: now.toISOString()
  }), { attemptId: "original-attempt", runId: run.id, authorityEpoch: 1, submittedAt: now.toISOString() }), now);
  store.saveTaskRoleSessionSet(sessions);
  const environment = {
    YUI_HOME: home, YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1",
    YUI_ROLE: "worker", YUI_AGENT_ID: "codex", YUI_ADAPTER_ID: "codex",
    YUI_WORKSPACE: home, YUI_RUN_ID: run.id
  };
  const identity = {
    nativeSessionId: "original-session", conversationId: "original-session",
    nativeTurnId: "original-turn", attemptId: "original-attempt"
  };
  const scheduler = new FileSchedulerStoreAdapter(store);
  return { home, store, scheduler, environment, identity, run, command };
}

test("Host migration appends after the published v21 ledger without rewriting its prefix", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-host-upgrade-v21-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(`${home}-backups`, { recursive: true, force: true });
  });
  // Initialize valid singleton records; their layouts are unchanged by 22.
  // Build the historical schema from its real registry, not a downgraded ledger.
  new SqliteTaskStore(home).close();
  const seed = join(home, "singleton-seed.db");
  renameSync(join(home, "yui.db"), seed);
  const source = new Database(join(home, "yui.db"));
  migrateSqliteSchema(source, { mode: "apply", throughVersion: 21 });
  source.prepare("ATTACH DATABASE ? AS seed").run(seed);
  source.exec("INSERT INTO home_meta SELECT * FROM seed.home_meta; INSERT INTO config SELECT * FROM seed.config;");
  const prefix = source.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  source.close();
  const result = await runStorageUpgrade({ home, mode: "execute" });
  assert.equal(result.outcome, "upgraded", JSON.stringify(result));
  assert.equal(result.report.sourceVersion, 21);
  assert.equal(result.report.targetVersion, CURRENT_STORAGE_VERSION);
  assert.deepEqual(result.report.steps.map(({ fromVersion, toVersion, name }) => ({ fromVersion, toVersion, name }))[0], {
    fromVersion: 21, toVersion: 22, name: "controller-owned-agent-host-ingress"
  });
  const upgraded = new Database(join(home, "yui.db"), { readonly: true });
  try {
    assert.deepEqual(upgraded.prepare("SELECT * FROM schema_migrations WHERE version <= 21 ORDER BY version").all(), prefix);
  } finally { upgraded.close(); }
});

test("production launch preserves scoped startup facts before native Session adoption", async t => {
  const { home, store, scheduler, run: createdRun } = executionFixture(t);
  const run = { ...createdRun, workspace: store.getManagedWorkspace({ type: "task", taskId: "task-1" }) };
  store.saveRun(run);
  store.saveActiveRun(run);
  const role = store.getRole("task-1", "worker");
  mkdirSync(join(home, "role-default"));
  store.saveRole("task-1", { ...role, workspace: join(home, "role-default") });
  store.saveTaskRoleSessionSet(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "worker" }, "codex", new Date()
  ));
  const planner = new FileRoleLaunchPlanner(home, store, { environment: { HOME: home, PATH: process.env.PATH } });
  let payload;
  const host = new TmuxSessionHost({
    plan: input => {
      const planned = planner.plan(input);
      // Keep native process creation outside this fast regression. Everything
      // through the actual broker reservation and its launch identity is real.
      return { ...planned, launch: { ...planned.launch, deferProviderStart: true } };
    }
  }, {
    ensureRoleWindow: (_task, _role, launch) => {
      payload = launchBrokerForHome(home).redeem(launch.args.at(-1));
      return true;
    }
  });
  await host.start({
    mode: "new", owner: { scope: "task", taskId: "task-1", roleName: "worker" },
    agentId: "codex", adapterId: "codex", effective: run.effective,
    workspace: run.effective.workspace.root, runId: run.id
  });
  assert.equal(payload.environment.YUI_RUN_ID, undefined, "Never pin a Run to the native Session environment.");
  assert.notEqual(store.getRole("task-1", "worker").workspace, payload.environment.YUI_WORKSPACE);
  const startup = { home, environment: payload.environment, startupRunId: payload.startupRunId,
    nativeSessionId: "opened-before-adoption" };
  await publishStructuredProviderConnection({ ...startup,
    connection: { account: { home, codexHome: join(home, "native-account") } } });
  await publishStructuredProviderOpened({ ...startup, conversationId: startup.nativeSessionId,
    recoverability: "recoverable", observedAt: new Date().toISOString() });
  const inbox = new FileRuntimeEventInbox(home);
  const processor = new FileRuntimeEventProcessor(inbox, scheduler);
  assert.deepEqual(processor.drain(new Date()).failed, []);
  scheduler.recordLaunchedRuntimeNativeSession({
    owner: { scope: "task", taskId: "task-1", roleName: "worker" },
    agentId: "codex", adapterId: "codex", nativeSessionId: startup.nativeSessionId, effective: run.effective
  }, () => {}, new Date());
  assert.deepEqual(processor.drain(new Date()).failed, []);
  assert.equal(store.listEvents("task-1").filter(e => e.type === "runtime.native-connection-bound").length, 1,
    "Early consumption must not discard the original account/custody evidence.");
  assert.equal(store.listEvents("task-1").filter(e => e.type === "runtime.observation"
    && ["session.started", "conversation.observed"].includes(e.payload.kind)).length, 2);
  assert.equal(payload.startupRunId, run.id, "Startup identity comes from the authorized launch, not ambient active state.");
  assert.equal(inbox.list().length, 0);
  await publishStructuredProviderConnection({ ...startup, startupRunId: "another-run",
    nativeSessionId: "must-not-bind", connection: { account: { home, codexHome: join(home, "wrong-account") } } });
  assert.deepEqual(processor.drain(new Date()).failed, []);
  assert.equal(store.listEvents("task-1").filter(e => e.type === "runtime.native-connection-bound").length, 1);
});

test("restoring an authorized Draft planning Session retains Host custody without a new Run", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-host-planning-restore-"));
  const home = join(root, "home");
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const now = new Date();
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  store.saveConfiguredAgent(agent);
  store.saveGlobalRole(createGlobalRole("leader", [createRoleAgentBinding(agent)], agent.id, home, now));
  store.saveConfig({ ...store.getConfig(), defaultAgent: agent.id, defaultWorkspace: home });
  submitOperatorMessage("Discuss the result before activation.", undefined, store, { now: () => now });
  const scheduler = new FileSchedulerStoreAdapter(store);
  assert.equal(scheduler.prepareDraftPlanning("task-1", now), true);
  const run = store.getActiveRun("task-1", "leader");
  const owner = { scope: "task", taskId: "task-1", roleName: "leader" };
  const identity = { owner, agentId: agent.id, adapterId: "codex",
    nativeSessionId: "planning-session", effective: run.effective };
  scheduler.recordLaunchedRuntimeNativeSession(identity, () => {}, now);
  store.transaction(tx => terminalizeExactTaskRun(tx, {
    taskId: "task-1", roleName: "leader", agentId: agent.id, runId: run.id,
    outcome: { status: "completed", output: "Proposal saved; await discussion." }
  }, now));
  assert.equal(store.getActiveRun("task-1", "leader"), null);
  const planner = new FileRoleLaunchPlanner(home, store, { environment: { HOME: home, PATH: process.env.PATH } });
  let payload;
  const host = new TmuxSessionHost({
    plan: input => {
      const planned = planner.plan(input);
      return { ...planned, launch: { ...planned.launch, deferProviderStart: true } };
    }
  }, {
    ensureRoleWindow: (_task, _role, launch) => {
      payload = launchBrokerForHome(home).redeem(launch.args.at(-1));
      return true;
    }
  });
  await host.restore({ mode: "resume", ...identity, workspace: run.effective.workspace.root });
  assert.equal(payload.startupRunId, undefined);
  assert.equal(payload.environment.YUI_RUN_ID, undefined);
  const processOwner = createSessionOwnerIdentity({
    owner, agentId: agent.id, adapterId: "codex", nativeSessionId: identity.nativeSessionId,
    tmux: { serverName: "isolated", socketPath: join(home, "tmux.sock"),
      sessionName: "task-1", windowName: "leader" },
    providerRoot: { pid: 12345, startIdentity: "1", attribution: "owned-child" }, recordedAt: now
  });
  const connection = { processOwner, account: { home, codexHome: join(home, "native-account") } };
  const publish = overrides => publishStructuredProviderConnection({
    home, environment: payload.environment, nativeSessionId: identity.nativeSessionId,
    connection, ...overrides
  });
  await publish({});
  scheduler.recordLaunchedRuntimeNativeSession(identity, () => {}, new Date());
  const inbox = new FileRuntimeEventInbox(home);
  const processor = new FileRuntimeEventProcessor(inbox, scheduler);
  assert.deepEqual(processor.drain(new Date()).failed, []);
  const connections = () => store.listEvents("task-1").filter(e => e.type === "runtime.native-connection-bound");
  assert.equal(connections().length, 1, "A completed planning Run cannot erase restored Session evidence.");
  assert.deepEqual(store.listSessionOwnersForOwner(owner), [processOwner]);
  assert.equal(inbox.list().length, 0);

  // The runless planning allowance still requires the exact live Session,
  // its workspace, planning authority and an enabled Task.
  const accepted = store.getTaskRoleSessionSet("task-1", "leader");
  const session = accepted.sessions.codex;
  const rejected = async (overrides = {}) => {
    await publish(overrides);
    const [event] = inbox.list();
    assert.equal(scheduler.observeAgentHostObservation(event, new Date()), "obsolete");
    assert.deepEqual(processor.drain(new Date()).failed, []);
    assert.equal(connections().length, 1);
    assert.deepEqual(store.listSessionOwnersForOwner(owner), [processOwner]);
  };
  await rejected({ nativeSessionId: "other-session" });
  await rejected({ environment: { ...payload.environment, YUI_WORKSPACE: join(home, "wrong-workspace") } });
  store.saveTaskRoleSessionSet({ ...accepted, sessions: { codex: {
    ...session, effective: { ...session.effective, executionAuthority: "delivery" }
  } } });
  await rejected();
  store.saveTaskRoleSessionSet(accepted);
  store.saveTask({ ...store.getTask("task-1"), executionGate: { state: "stopped" } });
  await rejected();
  assert.equal(store.getTask("task-1").status, "draft");
  assert.equal(store.listRuns("task-1").length, 1, "Restoration must not manufacture a managed Run.");
  assert.equal(store.getRun("task-1", run.id).effective.executionAuthority, "planning");
});

test("Host saves exact provider facts before any Controller/storage compatibility check", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-host-storage-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  new SqliteTaskStore(home).close();
  const db = new Database(join(home, "yui.db"));
  // A future ledger head makes this compiled store unsupported, as in a
  // Controller upgrade beneath a still-running Host. No model is involved.
  db.prepare("INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES (?, ?, ?, ?)")
    .run(CURRENT_STORAGE_VERSION + 1, "future-controller-contract", new Date().toISOString(), "future");
  db.close();
  assert.throws(() => openCurrentTaskStore(home), /supported storage contract/);
  const environment = {
    YUI_HOME: home, YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1",
    YUI_ROLE: "worker", YUI_AGENT_ID: "codex", YUI_ADAPTER_ID: "codex",
    YUI_WORKSPACE: home, YUI_RUN_ID: "launch-run-must-not-own-late-events"
  };
  const identity = {
    nativeSessionId: "original-session", conversationId: "original-session",
    nativeTurnId: "original-turn", attemptId: "original-attempt",
    observedAt: new Date().toISOString()
  };
  await publishStructuredProviderConnection({
    home, environment, nativeSessionId: identity.nativeSessionId,
    connection: { account: { home, codexHome: join(home, ".codex") } }
  });
  await publishStructuredProviderActivity({
    home, environment, activity: { ...identity, phase: "model", id: "model-item" }
  });
  await publishStructuredProviderTerminal({
    home, environment,
    terminal: { ...identity, clientOwned: true, status: "completed", output: "Full original report\n第二行" }
  });
  const entries = new FileRuntimeEventInbox(home).list();
  assert.equal(entries.length, 3);
  assert.equal(entries.find(e => e.observation.kind === "host.observed").observation.authority, "host");
  const terminal = entries.find(e => e.observation?.kind === "turn.completed");
  assert.equal(terminal.observation.payload.output, "Full original report\n第二行");
  assert.equal(terminal.observation.fence.receiptId, "original-attempt");
  assert.equal(terminal.observation.fence.runId, undefined, "Only Controller resolves the durable Run.");
  assert.equal(terminal.host.startupRunId, undefined, "A late terminal must not borrow the launch identity.");
  const { YUI_TASK_ID, ...globalEnvironment } = environment;
  await publishStructuredProviderConnection({
    home, environment: { ...globalEnvironment, YUI_SESSION_SCOPE: "global" },
    nativeSessionId: identity.nativeSessionId,
    connection: { account: { home, codexHome: join(home, ".codex") } }
  });
  await publishStructuredProviderTerminal({
    home, environment: { ...globalEnvironment, YUI_SESSION_SCOPE: "global" },
    terminal: { ...identity, clientOwned: true, status: "completed", output: "Global original report" }
  });
  const globalEvents = new FileRuntimeEventInbox(home).list().filter(event => event.scope === "global");
  assert.equal(globalEvents.length, 2, "Global Host must also enqueue against an unreadable future store.");
  assert.ok(globalEvents.every(event => event.host && event.observation.fence.taskId === undefined
    && event.observation.fence.runId === undefined));
});

test("Controller resolves Host facts, retains ACK-loss replay and rejects wrong/old identities", async t => {
  const f = executionFixture(t);
  const { home, store, scheduler, environment, identity, run } = f;
  const inbox = new FileRuntimeEventInbox(home);
  const dispatcher = createRuntimeLifecycleDispatcher(store, scheduler, {});
  let eager = 0;
  const controller = await startControllerServer(home, async (method, params) => {
    if (method !== "runtime.host-observation-apply") return {};
    eager += 1;
    await dispatcher(method, params);
    // Lose the first acknowledgement AFTER its authoritative commit.
    return eager === 1 ? new Promise(() => {}) : { outcome: "applied" };
  }, undefined, { release: null, storageBackend: "sqlite", workerEnabled: false });
  await publishStructuredProviderAccepted({
    home, environment, receipt: { ...identity, acceptance: "provider", acceptedAt: new Date().toISOString() }
  });
  assert.equal(eager, 1);
  assert.equal(store.getTaskRoleSessionSet("task-1", "worker").providerBinding.run.status, "accepted");
  assert.equal(inbox.list().length, 1, "The lost ACK still has its original Inbox identity.");
  await controller.close();
  await publishStructuredProviderActivity({
    home, environment, activity: { ...identity, observedAt: new Date().toISOString(), phase: "model", id: "working" }
  });
  await publishStructuredProviderTerminal({
    home, environment, terminal: { ...identity, clientOwned: true, status: "completed",
      output: "Full original result\n中文证据", observedAt: new Date().toISOString() }
  });
  const saved = inbox.list();
  const processor = new FileRuntimeEventProcessor(inbox, scheduler);
  const drained = processor.drain(new Date());
  assert.deepEqual(drained.failed, []);
  assert.deepEqual(drained.deferred, []);
  assert.equal(store.getRun("task-1", run.id).status, "completed");
  assert.equal(store.getRun("task-1", run.id).result.output, "Full original result\n中文证据");
  assert.equal(store.getWorkItem("task-1", "work-item-1").status, "open", "Result is evidence, not business acceptance.");
  const count = store.listMessages("task-1").length;
  // Re-deliver byte-identical facts after an ACK is lost at the inbox boundary.
  for (const event of saved) inbox.enqueueObservation(event.observation, event.host);
  const asyncProcessor = new AsyncRuntimeEventProcessor(inbox, createAsyncRuntimeObserver(
    async (method, args) => scheduler[method](...args)
  ));
  const replayed = await asyncProcessor.drainAsync(new Date());
  assert.deepEqual(replayed.failed, []);
  assert.equal(store.listMessages("task-1").length, count);
  assert.equal(inbox.list().length, 0);
  // Ordinary native chat is not a managed assignment and an observed user
  // input must not be misreported as a Host reporting fault.
  const direct = { ...identity, nativeTurnId: "direct-chat", attemptId: undefined };
  await publishStructuredProviderStarted({
    home, environment, started: { ...direct, clientOwned: false, observedAt: new Date().toISOString() }
  });
  assert.deepEqual(processor.drain(new Date()).failed, []);
  await publishStructuredProviderInputObserved({
    home, environment, observed: { ...direct, inputId: "visible-user-input", input: "Ordinary conversation",
      observedAt: new Date().toISOString() }
  });
  const visibleInput = inbox.list()[0];
  assert.equal(scheduler.observeAgentHostObservation(visibleInput, new Date()), "applied");
  assert.deepEqual(processor.drain(new Date()).failed, []);
  await publishStructuredProviderTerminal({
    home, environment, terminal: { ...direct, clientOwned: false, status: "completed",
      output: "Ordinary reply", observedAt: new Date().toISOString() }
  });
  assert.deepEqual(processor.drain(new Date()).failed, []);
  assert.equal(store.listRuns("task-1").length, 1, "Ordinary conversation must not create an assignment.");
  f.command(["work", "dispatch", "task-1/work-item-1"]);
  const successor = store.getActiveRun("task-1", "worker");
  assert.notEqual(successor.id, run.id);
  const sessions = store.getTaskRoleSessionSet("task-1", "worker");
  store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(sessions, beginProviderTurn(sessions.providerBinding, {
    attemptId: "successor-attempt", runId: successor.id, authorityEpoch: 1, submittedAt: new Date().toISOString()
  }), new Date()));
  await publishStructuredProviderTerminal({
    home, environment: { ...environment, YUI_RUN_ID: successor.id },
    terminal: { ...identity, clientOwned: true, status: "completed",
      output: "Full original result\n中文证据", observedAt: new Date().toISOString() }
  });
  assert.deepEqual(processor.drain(new Date()).failed, []);
  assert.equal(store.getActiveRun("task-1", "worker").id, successor.id);
  // A forged old attempt cannot borrow even this Session's known native Turn.
  await publishStructuredProviderTerminal({
    home, environment: { ...environment, YUI_RUN_ID: "a-successor-launch" },
    terminal: { ...identity, attemptId: "wrong-attempt", clientOwned: true, status: "completed",
      output: "Must not replace result", observedAt: new Date().toISOString() }
  });
  const rejected = processor.drain(new Date());
  assert.deepEqual(rejected.failed, []);
  assert.equal(store.getRun("task-1", run.id).result.output, "Full original result\n中文证据");
  assert.equal(store.getActiveRun("task-1", "worker").id, successor.id);
  assert.ok(store.listEvents("task-1").some(e => JSON.stringify(e.payload).includes("conflicting durable")));
  const progress = saved.find(e => e.observation.kind === "activity.observed");
  inbox.enqueueObservation({
    ...progress.observation, authority: "controller", eventId: "forged-authority", semanticKey: "forged-authority"
  }, progress.host);
  inbox.enqueueObservation({
    ...progress.observation, eventId: "wrong-workspace", semanticKey: "wrong-workspace"
  }, { ...progress.host, workspace: join(home, "another-workspace") });
  assert.deepEqual(processor.drain(new Date()).failed, []);
  assert.equal(store.getActiveRun("task-1", "worker").id, successor.id);
  assert.ok(store.listEvents("task-1").some(e => JSON.stringify(e.payload).includes("exceeds its event authority")));
  assert.ok(store.listEvents("task-1").some(e => JSON.stringify(e.payload).includes("workspace does not match")));
  const status = runTaskCommand(["role", "status", "task-1", "worker"], store, {
    environment: {}, liveHostObservations: { worker: { snapshot: {
      schemaVersion: 2, state: "failed", adapterId: "codex", nativeSessionId: identity.nativeSessionId,
      detail: "This Home does not use a supported storage contract.", updatedAt: new Date().toISOString()
    } } }
  });
  assert.equal(status.data.role.health, "needs-attention");
  assert.equal(status.data.role.activeRun.id, successor.id);
  assert.equal(store.getRun("task-1", successor.id).status, "active", "A reporting failure is not a model or business terminal.");
  assert.match(status.output, /supported storage contract/);
});

test("upgrade rejects a live legacy Host before migration and preserves the scene", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-legacy-host-"));
  const db = new Database(join(home, "yui.db"));
  migrateSqliteSchema(db, { mode: "apply", throughVersion: 19 });
  db.close();
  const socket = agentHostControlSocketPath({ home, scope: "task", taskId: "task-legacy", roleName: "worker" });
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const server = createServer({ allowHalfOpen: true }, client => {
    client.resume();
    client.on("end", () => client.end(JSON.stringify({
      protocol: "yui-agent-host/v5", outcome: "status",
      snapshot: { schemaVersion: 2, state: "ready", nativeSessionId: "legacy-session",
        attemptId: "legacy-attempt", updatedAt: new Date().toISOString() }
    })));
  });
  await new Promise(resolve => server.listen(socket, resolve));
  chmodSync(socket, 0o600);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(socket, { force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const before = readFileSync(join(home, "yui.db"));
  for (const mode of ["update-preflight", "execute"]) {
    const result = await runStorageUpgrade({ home, mode });
    assert.equal(result.outcome, "blocked");
    assert.equal(result.stage, "host-compatibility");
    assert.equal(result.sceneUnchanged, true);
    assert.match(result.message, /legacy-session/);
    assert.deepEqual(readFileSync(join(home, "yui.db")), before);
  }
  const effects = [];
  let preflights = 0;
  const update = runUpdate({
    stage: () => ({ binaryPath: "/fixture/target", version: "0.16.0" }),
    preflight: () => ++preflights === 1
      ? { status: "migration-ready", stepCount: 1 }
      : { status: "blocked", message: "Legacy Host appeared during drain", action: "Preserve execution" },
    beginControllerHandover: () => () => {},
    controllerStatus: () => ({ running: true, pid: 42, identity: {
      executablePath: "/fixture/node", args: ["/fixture/old/controllerMain.js"], version: "0.15.9"
    } }),
    stopController: (_home, pid) => { effects.push("stop"); return { stopped: true, pid }; },
    activateBinary: () => effects.push("activate"),
    migrateStorage: () => { effects.push("migrate"); return {}; },
    verify: () => effects.push("verify"),
    startController: () => effects.push("start"),
    restoreController: () => effects.push("restore-old"),
    cleanup: () => {}
  }, { home });
  assert.equal(update.outcome, "aborted");
  assert.deepEqual(effects, ["stop", "restore-old"], "A late blocker cannot promote the install or mutate storage.");
});

test("frozen v1 Host process survives a Controller replacement and real Home 19→22 migration", { timeout: 10000 }, async t => {
  const f = executionFixture(t);
  const { home, run } = f;
  const homeId = f.store.getHomeIdentity().homeId;
  f.store.close();
  // Build the historical ledger using the released migration prefix, then
  // seed unchanged Task/Run records (the Host migration changes only ingress).
  // This is a disposable version fixture, never a downgrade of a real Home.
  rebuildHistoricalFixture(home, 19);
  const socket = agentHostControlSocketPath({ home, scope: "task", taskId: "task-1", roleName: "worker" });
  const child = fork(fileURLToPath(new URL("../fixtures/agent-host-events-v1.mjs", import.meta.url)), [home, socket, home], {
    env: { PATH: process.env.PATH }, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  let childError = "";
  child.stderr.on("data", bytes => { childError += bytes; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.send({ kind: "stop" });
      await exited;
    }
    rmSync(socket, { force: true });
  });
  const [ready] = await once(child, "message");
  const hostPid = ready.pid;
  const emit = async (kind, eventId) => {
    const next = once(child, "message");
    child.send({ kind, eventId, output: "Report from the retained old v1 Host\n完整结果" });
    const [receipt] = await next;
    assert.equal(receipt.error, undefined);
    assert.equal(receipt.pid, hostPid);
    return receipt;
  };
  const previous = await startFrozenControllerV4(home, homeId);
  try {
    const oldReceipt = await emit("turn.accepted");
    assert.equal(oldReceipt.remote?.outcome, "deferred");
    assert.equal(oldReceipt.remote.controllerInstanceId, previous.discovery.controllerInstanceId);
    assert.equal(previous.requests.length, 1, "The retained producer must actually contact the old Controller.");
  } finally { await previous.close(); }
  const duringGap = await emit("activity.observed");
  assert.equal(duringGap.remote.outcome, "pending");
  const upgraded = await runStorageUpgrade({ home, mode: "execute" });
  assert.equal(upgraded.outcome, "upgraded");
  assert.equal(upgraded.report.sourceVersion, 19);
  assert.equal(upgraded.report.targetVersion, CURRENT_STORAGE_VERSION);
  const current = new SqliteTaskStore(home);
  const scheduler = new FileSchedulerStoreAdapter(current);
  const processor = new FileRuntimeEventProcessor(new FileRuntimeEventInbox(home), scheduler);
  // Match the Controller's startup drain for facts retained during handover.
  assert.deepEqual(processor.drain(new Date()).failed, []);
  const dispatch = createRuntimeLifecycleDispatcher(current, scheduler, {});
  const currentRequests = [];
  const controller = await startControllerServer(home, async (method, params) => {
    const result = await dispatch(method, params);
    if (method === "runtime.host-observation-apply") {
      currentRequests.push(params.eventId);
      assert.deepEqual(processor.drain(new Date()).failed, []);
    }
    return result;
  },
    undefined, { release: null, storageBackend: "sqlite", workerEnabled: false });
  try {
    const activity = await emit("activity.observed");
    const terminal = await emit("turn.completed");
    assert.equal(activity.remote.outcome, "applied");
    assert.equal(terminal.remote.outcome, "applied");
    assert.equal(terminal.remote.controllerInstanceId, controller.discovery.controllerInstanceId);
    assert.notEqual(controller.discovery.controllerInstanceId, previous.discovery.controllerInstanceId);
    assert.deepEqual(currentRequests, [activity.emitted, terminal.emitted]);
    assert.equal(current.getRun("task-1", run.id).status, "completed");
    assert.equal(current.getRun("task-1", run.id).result.output, "Report from the retained old v1 Host\n完整结果");
    const messageCount = current.listMessages("task-1").length;
    const repeated = await emit("replay", terminal.emitted);
    assert.equal(repeated.remote.outcome, "applied");
    assert.equal(repeated.sequence, terminal.sequence, "Only the exact event hint is replayed, never Provider work.");
    assert.equal(current.listMessages("task-1").length, messageCount);
    assert.equal(new FileRuntimeEventInbox(home).list().length, 0);
    assert.equal(child.exitCode, null, "The old-side Host was neither restarted nor hot-swapped.");
    assert.equal(childError, "");
  } finally {
    await controller.close();
    current.close();
  }
});
