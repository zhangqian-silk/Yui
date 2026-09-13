import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import {
  captureRoleRunDispatch,
  enqueueRoleRunDispatch,
  settleRoleRunDispatch
} from "../../dist/coordination/workMailboxQueue.js";
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
import {
  dispatchPreparedReviewRound,
  previewTaskRoleAgentConfigurationMutation,
  runTaskCommand
} from "../../dist/commands/taskCommands.js";
import { upsertTaskPublication } from "../../dist/commands/taskPublicationCommands.js";
import {
  createGlobalRole,
  createRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";
import { createAgentProfile } from "../../dist/profile/agentProfile.js";
import { materializeSessionBootstrap } from "../../dist/context/sessionBootstrapManifest.js";
import { builtinAgentDriverRegistry } from "../../dist/runtime/builtinAgentDrivers.js";
import { serializeAgentErrorRaw, standardAgentError } from "../../dist/runtime/agentError.js";
import { runtimeLifecycleTarget } from "../../dist/runtime/lifecycleReservation.js";
import {
  createRuntimeObservation,
  runtimeObservationTaskEventPayload
} from "../../dist/runtime/runtimeObservation.js";
import { createSessionOwnerIdentity } from "../../dist/runtime/sessionOwnerIdentity.js";
import {
  RuntimeLaunchError
} from "../../dist/runtime/ports.js";
import { RuntimeLaunchCoordinator } from "../../dist/controller/runtimeLaunchCoordinator.js";
import { resolveManagedTaskCaller } from "../../dist/runtime/managedCaller.js";
import { taskLocalActor } from "../../dist/commands/taskActor.js";
import { buildRunContextPack } from "../../dist/context/runContextPack.js";
import {
  buildTaskWakeEnvelope,
  WAKE_ENVELOPE_HARD_BYTES
} from "../../dist/context/wakeNotification.js";
import { startStructuredProviderSession } from "../../dist/runtime/structuredProviderHost.js";
import {
  acceptProviderTurn,
  beginProviderTurn,
  createProviderRuntimeBinding,
  settleProviderTurn,
  updateProviderGoal
} from "../../dist/runtime/providerRuntimeIdentity.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { runControllerSchedulerPass } from "../../dist/controller/controller.js";
import { createAsyncRuntimeObserver } from "../../dist/controller/runtimeEventProcessor.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { runRuntimeObservationHookCommand } from "../../dist/controller/runtimeObservationHook.js";
import { callFileTaskController } from "../../dist/controller/clientRuntime.js";
import { startControllerServer } from "../../dist/core/controllerServer.js";
import { terminalizeExactTaskRun } from "../../dist/lifecycle/exactRunTerminalization.js";
import {
  MAX_RUN_RESULT_OUTPUT_BYTES,
  completeRun,
  createRun,
  validateRun
} from "../../dist/agentRun/agentRun.js";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { processActiveRoleRunDeliveries } from "../../dist/scheduler/activeRoleRunDelivery.js";
import { processOperatorInputNotifications } from "../../dist/scheduler/operatorInputNotificationProcessor.js";
import {
  LEADER_WAKE_AGGREGATION_MS,
  processLeaderWakeups
} from "../../dist/scheduler/leaderWakeupProcessor.js";
import { buildTaskExecutionProjection } from "../../dist/scheduler/taskExecutionProjection.js";
import { projectWorkItemExecution } from "../../dist/execution/workItemExecutionProjection.js";
import {
  createWorkItemExecutionAssignment,
  createWorkItemExecutionGroup
} from "../../dist/execution/workItemExecution.js";
import {
  attachReviewRoundWorkspace,
  createTaskReviewRound,
  finishReviewRound,
  startReviewRound,
  validateReviewRound
} from "../../dist/review/reviewRound.js";
import { projectReviewerAvailability } from "../../dist/review/reviewerAvailability.js";
import { projectNextAction } from "../../dist/task/nextAction.js";
import { projectTaskRemoteDelivery } from "../../dist/task/remoteDelivery.js";
import { listPublicCommandPaths } from "../../dist/cli/commandCatalog.js";
import { runUpdate } from "../../dist/cli/updateOrchestrator.js";
import { createUpdatePorts } from "../../dist/cli/updatePorts.js";
import { acquireHandoverLock, readHandoverFence } from "../../dist/release/runtimeRelease.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import * as taskStoreContract from "../../dist/storage/taskStore.js";
import { inspectStorageSchema, StorageSchemaError } from "../../dist/storage/storageSchema.js";
import {
  CURRENT_STORAGE_VERSION,
  MIN_SUPPORTED_STORAGE_VERSION
} from "../../dist/storage/storageVersions.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { initializeCurrentTaskStore } from "../../dist/storage/currentTaskStore.js";
import { createProject } from "../../dist/repository/project.js";
import {
  createIntegrationAttempt,
  updateIntegrationAttempt
} from "../../dist/integration/integrationAttempt.js";
import { snapshotExecutionLaneWorkspaceSync } from "../../dist/repository/executionLaneGitSnapshot.js";
import { FileTaskWorkspacePreparer } from "../../dist/repository/taskWorkspacePreparer.js";
import { generateTaskWorkspaceIdentity } from "../../dist/repository/taskWorkspaceIdentity.js";
import { SqliteTelemetryStore } from "../../dist/telemetry/sqliteTelemetryStore.js";
import {
  activateTask,
  bindTaskProjectCommits,
  bindTaskWorkspaceIdentity,
  createTask,
  startTaskExecution,
  stopTaskExecution
} from "../../dist/task/task.js";
import {
  attachWorkItemExecutionGroup,
  createCandidateGitSnapshot,
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus,
  validateWorkItem
} from "../../dist/workItem/workItem.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

const root = resolve(import.meta.dirname, "../..");
const bareEnv = sanitizedTestEnv();

function runInput(runId, taskId, roleName, directive, options = {}) {
  void runId;
  void taskId;
  void roleName;
  return createRunInput({
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
  const version = JSON.parse(execFileSync(
    process.execPath,
    [join(root, "dist", "cli.js"), "--json", "version"],
    { cwd: root, encoding: "utf8", env: bareEnv }
  ));
  assert.equal(version.ok, true);
  assert.equal(version.data.storageVersion, CURRENT_STORAGE_VERSION);
  assert.equal(version.data.minimumStorageVersion, MIN_SUPPORTED_STORAGE_VERSION);
  assert.equal(Object.hasOwn(version.data, "storageLayoutVersion"), false);
  assert.equal(Object.hasOwn(version.data, "aggregateSchemaVersion"), false);
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
  assert.ok(commands.includes("task run list"));
  assert.ok(commands.includes("task publication upsert"));
  assert.ok(commands.includes("task publication verify"));
  assert.ok(commands.includes("task remote-delivery"));
  assert.equal(commands.includes("task publication add"), false);
  assert.ok(commands.includes("task run show"));
  assert.equal(commands.includes("task rebuild"), false);
  assert.equal(commands.some((command) => command.startsWith("task history")), false);
  assert.equal(commands.includes("task review rebind"), false);
  assert.equal(commands.includes("task review force-fresh"), false);
  assert.equal(commands.includes("task review finding"), false);
  assert.equal(commands.includes("task role session switch"), false);
});

test("publication evidence changes stay exact across upsert and remote delivery", () => {
  const baseCommit = "1".repeat(40);
  const headCommit = "2".repeat(40);
  const originalRemoteCommit = "3".repeat(40);
  const replacementRemoteCommit = "4".repeat(40);
  const task = {
    schemaVersion: 6,
    id: "task-1",
    title: "Publish exact head",
    status: "active",
    executionGate: { state: "enabled" },
    projectBindings: [{
      projectId: "project-1",
      directory: "Repo",
      baseRef: "master"
    }],
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z"
  };
  const verifiedPublication = {
    schemaVersion: 1,
    id: "publication-1",
    taskId: task.id,
    projectId: "project-1",
    provider: "github",
    repository: "example/repo",
    externalKind: "pull-request",
    externalId: "17",
    localCommit: headCommit,
    remoteCommit: originalRemoteCommit,
    state: "merged",
    verification: "verified",
    evidence: "provider-confirmed merge",
    mergedAt: "2026-09-02T00:01:00.000Z",
    recordedBy: "operator",
    source: "manual",
    createdAt: "2026-09-02T00:01:00.000Z"
  };
  const publicationIdentity = {
    projectId: "project-1",
    provider: "github",
    repository: "example/repo",
    externalKind: "pull-request",
    externalId: "17"
  };
  const applyUpsert = (input) => {
    const publications = [verifiedPublication];
    const events = [];
    const reference = upsertTaskPublication({
      findPublicationReferenceByExternalKey: () => publications.at(-1),
      nextPublicationReferenceId: () => `publication-${publications.length + 1}`,
      savePublicationReference: (_taskId, publication) => publications.push(publication),
      nextEventId: () => `event-${events.length + 1}`,
      saveEvent: (_taskId, event) => events.push(event)
    }, task, { ...publicationIdentity, ...input }, "leader", new Date(
      "2026-09-02T00:02:00.000Z"
    ));
    return { reference, publications, events };
  };
  const replay = applyUpsert({
    remoteCommit: originalRemoteCommit.toUpperCase()
  }).reference;
  assert.equal(replay.idempotent, true);
  const changedResult = applyUpsert({
    remoteCommit: replacementRemoteCommit
  });
  const changed = changedResult.reference;
  assert.equal(changed.reference.verification, "reported");
  assert.equal(changed.reference.evidence, undefined);
  assert.equal(changed.reference.mergedAt, undefined);
  const evidenceChanged = applyUpsert({ evidence: "replacement evidence" }).reference;
  assert.equal(evidenceChanged.reference.verification, "reported");
  assert.equal(evidenceChanged.reference.remoteCommit, undefined);
  assert.equal(evidenceChanged.reference.mergedAt, undefined);
  const mergedAtChanged = applyUpsert({
    mergedAt: "2026-09-02T00:04:00.000Z"
  }).reference;
  assert.equal(mergedAtChanged.reference.verification, "reported");
  assert.equal(mergedAtChanged.reference.remoteCommit, undefined);
  assert.equal(mergedAtChanged.reference.evidence, undefined);
  const publications = changedResult.publications;
  const events = changedResult.events;

  const managedWorkspaces = [{
    schemaVersion: 2,
    owner: { type: "task", taskId: task.id },
    root: "/tmp/task-1",
    entries: [{
      projectId: "project-1",
      directory: "Repo",
      access: "write",
      path: "/tmp/task-1/Repo",
      branch: "yui/task-1/main",
      baseRef: "master",
      baseCommit
    }],
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z"
  }];
  const projection = projectTaskRemoteDelivery({
    task,
    events,
    publications,
    managedWorkspaces,
    runs: [],
    currentCandidate: {
      projects: [{ projectId: "project-1", commit: headCommit }]
    }
  });
  assert.equal(projection.status, "unverified");
  assert.equal(projection.allMerged, true);
  assert.equal(projection.allVerified, false);
  assert.equal(projection.integratedCoverageSatisfied, false);
  assert.equal(projection.projects[0].expectedLocalCommit, headCommit);
  assert.equal(projection.projects[0].remoteCommit, replacementRemoteCommit);

  const unavailable = projectTaskRemoteDelivery({
    task,
    events,
    publications,
    managedWorkspaces,
    runs: [],
    currentCandidate: null
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.allMerged, false);
});

test("update quiesces the exact Controller before replacing a current-contract binary", () => {
  const calls = [];
  const result = runUpdate({
    stage: () => {
      calls.push("stage");
      return { binaryPath: "/tmp/staged-yui", version: "0.15.0" };
    },
    preflight: () => {
      calls.push("preflight");
      return { status: "already-current", stepCount: 0 };
    },
    beginControllerHandover: () => {
      calls.push("handover");
      return () => calls.push("release");
    },
    controllerStatus: () => {
      calls.push("status");
      return {
        running: true,
        pid: 42,
        identity: {
          executablePath: process.execPath,
          args: ["/tmp/old-yui-controller"],
          version: "0.14.1"
        }
      };
    },
    stopController: (_home, pid) => {
      calls.push(`stop:${pid}`);
      return { stopped: true, pid };
    },
    activateBinary: () => calls.push("activate"),
    verify: () => calls.push("verify"),
    startController: () => calls.push("start"),
    restoreController: () => calls.push("restore"),
    cleanup: () => calls.push("cleanup")
  }, { home: "/tmp/yui-update-home" });
  assert.deepEqual(result, {
    outcome: "updated",
    version: "0.15.0"
  });
  assert.deepEqual(calls, [
    "stage",
    "preflight",
    "handover",
    "status",
    "stop:42",
    "preflight",
    "activate",
    "verify",
    "start",
    "release",
    "cleanup"
  ]);
});

test("update applies a supported storage migration before post-verification", () => {
  const calls = [];
  const result = runUpdate({
    stage: () => {
      calls.push("stage");
      return { binaryPath: "/tmp/staged-yui", version: "0.15.0" };
    },
    preflight: () => {
      calls.push("preflight");
      return { status: "migration-ready", stepCount: 1 };
    },
    beginControllerHandover: () => {
      calls.push("handover");
      return () => calls.push("release");
    },
    controllerStatus: () => {
      calls.push("status");
      return { running: false };
    },
    stopController: () => {
      calls.push("stop");
      return { stopped: true };
    },
    activateBinary: () => calls.push("activate"),
    migrateStorage: () => {
      calls.push("migrate");
      return { backupPath: "/tmp/yui-backup.db" };
    },
    verify: () => calls.push("verify"),
    startController: () => calls.push("start"),
    restoreController: () => calls.push("restore"),
    cleanup: () => calls.push("cleanup")
  }, { home: "/tmp/yui-update-home" });
  assert.deepEqual(result, {
    outcome: "updated",
    version: "0.15.0",
    backupPath: "/tmp/yui-backup.db"
  });
  assert.deepEqual(calls, [
    "stage",
    "preflight",
    "handover",
    "status",
    "preflight",
    "activate",
    "migrate",
    "verify",
    "start",
    "release",
    "cleanup"
  ]);
});

test("update ports delegate the planned migration to the exact staged binary", () => {
  const invocations = [];
  const response = (data) => {
    const stdout = Buffer.from(JSON.stringify({ ok: true, data }));
    return {
      pid: 1,
      output: [null, stdout, Buffer.alloc(0)],
      stdout,
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null
    };
  };
  const ports = createUpdatePorts({}, (command, args, options) => {
    invocations.push({ command, args: [...args], env: options.env });
    if (args.includes("--update-preflight")) {
      return response({
        outcome: "update-preflight",
        status: "migration-ready",
        stepCount: 1,
        steps: [{
          fromVersion: 1,
          toVersion: 2,
          name: "future-storage-change",
          introducedIn: "0.16.0"
        }],
        classification: {
          classification: { verdict: "MIGRATABLE", status: "migration-ready" }
        }
      });
    }
    return response({
      outcome: "upgraded",
      report: { backupPath: "/tmp/yui-backup.db" }
    });
  });
  const staged = { binaryPath: "/tmp/staged-yui", version: "0.15.0" };
  assert.deepEqual(ports.preflight(staged, "/tmp/yui-home"), {
    status: "migration-ready",
    stepCount: 1
  });
  assert.deepEqual(ports.migrateStorage(staged, "/tmp/yui-home"), {
    backupPath: "/tmp/yui-backup.db"
  });
  assert.deepEqual(invocations.map(({ command, args }) => ({ command, args })), [
    {
      command: "/tmp/staged-yui",
      args: ["--json", "upgrade", "--update-preflight"]
    },
    {
      command: "/tmp/staged-yui",
      args: ["--json", "upgrade", "--update-apply"]
    }
  ]);
  assert.equal(
    invocations[1].env.YUI_UPDATE_HANDOVER_OWNER_PID,
    String(process.pid)
  );
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
  const entryPoint = {
    executable: process.execPath,
    cliEntry: join(root, "dist", "cli.js")
  };
  const bootstrap = materializeSessionBootstrap({
    yuiHome: home,
    role,
    owner: { scope: "global" },
    roleKind: "operator",
    skills: [],
    entryPoint
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
  });
  assert.equal(planned.launch.providerControl.kind, "start");
  assert.equal(planned.launch.providerControl.transport, "codex-app-server-proxy");
  assert.equal(planned.launch.providerControl.sessionOnly, true);
  assert.ok(!planned.launch.args.includes("--remote"));
  assert.ok(planned.launch.env.YUI_SESSION_MANIFEST);
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
    onStarted: (run) => starts.push(run),
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
  assert.equal(terminal.output, "Native Codex result.");
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

test("SQLite projects an active native Session", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-active-session-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
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
    sessionUpdatedAt: now.toISOString(),
  }]);
});

test("native continuation results wake the supervisor only after the parent Turn is terminal", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-continuation-owner-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-09-03T09:15:00.000Z");
  const task = activateTask(createTask("task-1", "Route native continuation", now), now);
  store.saveTask(task);
  const agent = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const worker = createRole(task.id, "worker", [agent], agent.agentId, home, now);
  const leader = createRole(task.id, "leader", [agent], agent.agentId, home, now);
  store.saveRole(task.id, worker);
  store.saveRole(task.id, leader);
  const run = createRun(
    "turn-1",
    task.id,
    worker.name,
    "new",
    runInput("turn-1", task.id, worker.name, "Delegate and aggregate."),
    now,
    { effective: resolveEffectiveLaunch({ role: worker, purpose: "execution" }) }
  );
  store.saveActiveRun(run);
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: task.id, roleName: worker.name },
    agent.agentId,
    now
  ), {
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    nativeSessionId: "thread-1",
    policy: "fixed",
    status: "active",
    effective: run.effective
  }, now));
  const adapter = new FileSchedulerStoreAdapter(store);
  const fence = {
    taskId: task.id,
    roleName: worker.name,
    runId: run.id,
    agentId: agent.agentId,
    driverId: "openai/codex",
    nativeSessionId: "thread-1",
    nativeTurnId: "provider-turn-1",
    receiptId: `turn:${task.id}/${run.id}`,
    conversationId: "thread-1",
    continuationId: "child-1",
  };
  const observation = (kind, payload, minute) => createRuntimeObservation({
    schemaVersion: 4,
    eventId: `continuation-${kind}-${minute}`,
    semanticKey: `continuation-${kind}-${minute}`,
    kind,
    authority: "provider-structured",
    receivedAt: `2026-09-03T09:${minute}:00.000Z`,
    fence,
    payload
  });
  const common = {
    attachment: "attached",
    observationQuality: "exact",
    mayWriteWorkspace: true
  };
  assert.equal(adapter.observeRuntimeObservation(observation(
    "continuation.started",
    { ...common, execution: "active", outcome: "pending" },
    "11"
  ), now), "applied");
  assert.equal(adapter.observeRuntimeObservation(observation(
    "continuation.reported",
    {
      ...common,
      execution: "active",
      outcome: "pending",
      reportId: "report-1",
      summary: "Intermediate child result."
    },
    "12"
  ), now), "applied");
  assert.equal(store.getWorkMailbox({
    kind: "role",
    taskId: task.id,
    roleName: leader.name
  }), null);

  store.saveRun(completeRun(
    run,
    "Parent Turn finished.",
    new Date("2026-09-03T09:13:00.000Z")
  ));
  store.clearActiveRun(task.id, worker.name);
  assert.equal(adapter.observeRuntimeObservation(observation(
    "continuation.settled",
    {
      ...common,
      execution: "quiescent",
      outcome: "succeeded",
      mayWriteWorkspace: false,
      resultRef: "result-1"
    },
    "14"
  ), now), "applied");
  const leaderMailbox = store.getWorkMailbox({
    kind: "role",
    taskId: task.id,
    roleName: leader.name
  });
  assert.notEqual(leaderMailbox, null);
  assert.deepEqual(leaderMailbox.pending.reasons, ["provider-continuation-settled"]);
});

test("runtime pre-start persists the empty Session binding before Provider discovery", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-prestart-session-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-08-31T00:00:00.000Z");
  const task = activateTask(createTask("task-1", "Pre-start binding", now), now);
  store.saveTask(task);
  const agent = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(task.id, "leader", [agent], agent.agentId, "/tmp/yui-prestart", now);
  store.saveRole(task.id, role);
  const run = createRun(
    "turn-1",
    task.id,
    role.name,
    "new",
    runInput("turn-1", task.id, role.name, "Start Provider."),
    now,
    { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }
  );
  store.saveActiveRun(run);

  new FileSchedulerStoreAdapter(store).saveRoleRunPrepared({
    task,
    role,
    run: run,
    session: null,
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
  const run = createRun(
    "turn-1",
    "task-1",
    role.name,
    "new",
    runInput(
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

  assert.equal(run.schemaVersion, 5);
  assert.deepEqual(run.inputs[0].input.source, { type: "yui", channel: "task-dispatch" });
  assert.equal(run.inputs[0].input.directive, "Read the durable Task context and continue.");
  for (const legacyField of ["pushedAt", "deliveredAt", "deliveryReceiptId", "controlRequest"]) {
    assert.equal(Object.hasOwn(run, legacyField), false);
  }
  assert.equal(sessions.schemaVersion, 12);
  assert.equal(Object.hasOwn(sessions, "inFlight"), false);
  assert.equal(mailbox.schemaVersion, 5);
  assert.equal(mailbox.pending, null);
  assert.equal(mailbox.processing, null);
  assert.deepEqual(mailbox.recentDedupeKeys, []);
  assert.equal(Object.hasOwn(mailbox, "inputDelivery"), false);
  assert.throws(
    () => validateRun({ ...run, deliveredAt: now.toISOString() }),
    /unknown field: deliveredAt/u
  );
  assert.throws(
    () => validateRoleSessionSet({ ...sessions, inFlight: null }),
    /unknown field: inFlight/u
  );
  const originalOutput = "not JSON: { pass? }\nNo required headings.";
  const completed = completeRun(run, originalOutput, new Date(now.getTime() + 1_000));
  assert.equal(completed.result.output, originalOutput);
  assert.throws(
    () => validateRun({
      ...completed,
      result: { ...completed.result, producer: { checks: [] } }
    }),
    /unknown field: producer/u
  );
  const item = createWorkItem("work-item-1", "task-1", { title: "Current contract" }, now);
  assert.throws(
    () => validateWorkItem({ ...item, legacyExecutionGroups: [] }),
    /unknown field: legacyExecutionGroups/u
  );
  const round = createTaskReviewRound(
    "review-round-1",
    "task-1",
    "reviewer",
    "leader",
    { schemaVersion: 1, projects: [{ projectId: "project-1", commit: "a".repeat(40) }] },
    now
  );
  assert.throws(
    () => validateReviewRound({ ...round, report: "parsed report" }),
    /unknown field: report/u
  );
  assert.throws(
    () => validateReviewRound({
      ...round,
      status: "completed",
      endedAt: new Date(now.getTime() + 1_000).toISOString()
    }),
    /requires its exact main Reviewer AgentRun/u
  );
});

test("Task-scoped Turn listing includes Leader Turns without a WorkItem", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-turn-list-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-08-31T00:00:00.000Z");
  const task = activateTask(createTask("task-1", "List every Task Turn", now), now);
  store.saveTask(task);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(task.id, "leader", [binding], binding.agentId, "/tmp/yui-turn-list", now);
  store.saveRole(task.id, role);
  store.saveActiveRun(createRun(
    "turn-1",
    task.id,
    role.name,
    "new",
    runInput("turn-1", task.id, role.name, "Inspect the Task."),
    now,
    { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }
  ));

  const result = runTaskCommand(["run", "list", task.id], store);
  assert.equal(result.kind, "output");
  assert.match(result.output, /AgentRuns: task-1/u);
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

test("Role dispatch settlement preserves merged work and Leader wakes", () => {
  const workerTarget = { kind: "role", taskId: "task-1", roleName: "worker" };
  let workerMailbox = createWorkMailbox(workerTarget);
  const workerStore = {
    getWorkMailbox: () => workerMailbox,
    saveWorkMailbox: (updated) => { workerMailbox = updated; }
  };
  enqueueRoleRunDispatch(workerStore, {
    taskId: "task-1",
    roleName: "worker",
    runId: "turn-1",
    reason: "turn-dispatched",
    occurredAt: "2026-09-03T00:00:00.000Z"
  });
  const acceptedToken = captureRoleRunDispatch(workerMailbox, {
    taskId: "task-1",
    roleName: "worker",
    runId: "turn-1"
  });
  workerMailbox = enqueueSignal(workerMailbox, {
    reason: "future-work",
    refs: [{ type: "run", taskId: "task-1", id: "turn-2" }],
    occurredAt: "2026-09-03T00:00:01.000Z",
    dedupeKey: "future-work"
  });
  assert.equal(settleRoleRunDispatch(workerStore, {
    taskId: "task-1",
    roleName: "worker",
    runId: "turn-1"
  }, acceptedToken), "settled");
  assert.equal(workerMailbox.pending.fromSequence, 2);
  assert.equal(workerMailbox.pending.requestCount, 1);
  assert.deepEqual(workerMailbox.pending.dedupeKeys, ["future-work"]);
  assert.equal(settleRoleRunDispatch(workerStore, {
    taskId: "task-1",
    roleName: "worker",
    runId: "turn-2"
  }), "absent");
  assert.equal(workerMailbox.pending.requestCount, 1);

  let legacyMerged = enqueueSignal(createWorkMailbox(workerTarget), {
    reason: "legacy-turn-dispatched",
    refs: [{ type: "run", taskId: "task-1", id: "turn-9" }],
    occurredAt: "2026-09-03T00:00:02.000Z"
  });
  legacyMerged = enqueueSignal(legacyMerged, {
    reason: "future-work",
    refs: [{ type: "run", taskId: "task-1", id: "turn-10" }],
    occurredAt: "2026-09-03T00:00:03.000Z"
  });
  const legacyStore = {
    getWorkMailbox: () => legacyMerged,
    saveWorkMailbox: (updated) => { legacyMerged = updated; }
  };
  assert.equal(settleRoleRunDispatch(legacyStore, {
    taskId: "task-1",
    roleName: "worker",
    runId: "turn-9"
  }), "absent");
  assert.equal(legacyMerged.pending.requestCount, 2);

  const leaderTarget = { kind: "role", taskId: "task-1", roleName: "leader" };
  let leaderMailbox = enqueueSignal(createWorkMailbox(leaderTarget), {
    reason: "operator-input",
    refs: [{ type: "run", taskId: "task-1", id: "turn-1" }],
    occurredAt: "2026-09-03T00:00:04.000Z"
  });
  const leaderStore = {
    getWorkMailbox: () => leaderMailbox,
    saveWorkMailbox: (updated) => { leaderMailbox = updated; }
  };
  assert.equal(settleRoleRunDispatch(leaderStore, {
    taskId: "task-1",
    roleName: "leader",
    runId: "turn-1"
  }), "absent");
  assert.equal(leaderMailbox.pending.requestCount, 1);
});

test("Reviewer availability ignores Role delivery residue", () => {
  const target = { kind: "role", taskId: "task-1", roleName: "reviewer" };
  const mailbox = enqueueSignal(createWorkMailbox(target), {
    reason: "review-requested",
    refs: [
      { type: "run", taskId: "task-1", id: "turn-1" },
      { type: "work-item", taskId: "task-1", id: "work-item-1" }
    ],
    occurredAt: "2026-09-02T00:00:00.000Z"
  });
  const availability = projectReviewerAvailability({
    getActiveRun: () => null,
    listReviewRounds: () => [],
    getWorkMailbox: (candidate) => candidate.kind === "role" ? mailbox : null
  }, "task-1", "reviewer");

  assert.equal(availability.kind, "available");
  assert.equal(projectReviewerAvailability({
    getActiveRun: () => null,
    listReviewRounds: () => [],
    getWorkMailbox: (candidate) => candidate.kind === "role" ? mailbox : null
  }, "task-1", "reviewer").kind, "available");
  const processing = claimPending(mailbox, {
    batchId: "review-delivery",
    owner: "reviewer",
    startedAt: "2026-09-02T00:00:01.000Z"
  });
  assert.equal(projectReviewerAvailability({
    getActiveRun: () => null,
    listReviewRounds: () => [],
    getWorkMailbox: (candidate) => candidate.kind === "role" ? processing : null
  }, "task-1", "reviewer").kind, "available");
  const runtime = enqueueSignal(createWorkMailbox(runtimeLifecycleTarget({
    scope: "task",
    taskId: "task-1",
    roleName: "reviewer"
  })), {
    reason: "runtime-launch",
    refs: [{ type: "run", taskId: "task-1", id: "turn-2" }],
    occurredAt: "2026-09-02T00:00:02.000Z"
  });
  const runtimeBusy = projectReviewerAvailability({
    getActiveRun: () => null,
    listReviewRounds: () => [],
    getWorkMailbox: (candidate) => candidate.kind === "role-runtime" ? runtime : mailbox
  }, "task-1", "reviewer");
  assert.equal(runtimeBusy.kind, "busy");
  assert.equal(runtimeBusy.phase, "runtime-lifecycle");

  let storedMailbox = mailbox;
  assert.equal(settleRoleRunDispatch({
    getWorkMailbox: () => storedMailbox,
    saveWorkMailbox: (updated) => { storedMailbox = updated; }
  }, {
    taskId: "task-1",
    roleName: "reviewer",
    runId: "turn-1"
  }), "settled");
  assert.equal(storedMailbox.pending, null);
});

test("Yui and direct Turns share one Provider conversation", () => {
  let binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex",
    accountScope: "default",
    conversationId: "thread-1",
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
    runId: "turn-1",
    attemptId: "agent-input:task-1/turn-1:2-2",
    authorityEpoch: 1,
    submittedAt: "2026-08-31T00:00:06.000Z"
  });

  assert.equal(binding.currentConversationEpoch, 1);
  assert.equal(binding.conversations[0].conversationId, "thread-1");
  assert.equal(Object.hasOwn(binding, "activations"), false);
  assert.equal(binding.run.runId, "turn-1");
});

test("a direct Provider Turn records visible input and output without workflow state", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-direct-provider-turn-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
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
    policy: "fixed",
    status: "active",
    effective
  }, startedAt);
  let provider = createProviderRuntimeBinding({
    providerNamespace: "openai/codex",
    accountScope: agent.agentId,
    conversationId: "thread-1",
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
    conversationId: "thread-1",
    nativeSessionId: "thread-1"
  };
  const observation = (kind, ordinal, extra = {}) => ({
    schemaVersion: 4,
    eventId: `direct-run-${ordinal}`,
    semanticKey: `direct-run-${kind}-${ordinal}`,
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
    observation("turn.accepted", 5, {
      fence: { nativeTurnId: "turn-ordinary-1", receiptId: "direct:turn-ordinary-1" },
      payload: { input: "Please inspect the current code." }
    })
  ]) {
    assert.equal(adapter.observeRuntimeObservation(event, completedAt), "applied");
  }
  assert.equal(
    store.getTaskRoleSessionSet(task.id, role.name).providerBinding.run.status,
    "accepted"
  );
  const directRun = store.getActiveRun(task.id, role.name);
  assert.equal(directRun, null);
  const terminal = {
    taskId: task.id,
    roleName: role.name,
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    nativeSessionId: "thread-1",
    nativeTurnId: "turn-ordinary-1",
    attemptId: "direct:turn-ordinary-1",
    input: "Please inspect the current code.",
    providerStatus: "completed",
    outcome: {
      status: "completed",
      output: "\nOrdinary conversation reply.\n"
    }
  };

  assert.equal(adapter.classifyRuntimeRunTerminal(terminal), "apply");
  const observed = adapter.observeRuntimeRunTerminal(terminal, completedAt);
  assert.equal(observed.duplicate, false);
  assert.equal(observed.run, undefined);
  assert.equal(store.listRuns(task.id).length, 0);
  assert.equal(store.getTask(task.id).status, "active");
  assert.equal(store.getTaskRoleSessionSet(task.id, role.name).providerBinding.run.status, "completed");
  assert.equal(store.getPendingWakeup(task.id), null);

  const continuationAt = new Date("2026-08-31T00:31:00.500Z");
  assert.equal(adapter.observeRuntimeObservation(observation("turn.accepted", 6, {
    fence: { nativeTurnId: "turn-goal-2", receiptId: "direct:turn-goal-2" }
  }), continuationAt), "applied");
  const goalRun = store.getActiveRun(task.id, role.name);
  assert.equal(goalRun, null);
  const continued = adapter.observeRuntimeRunTerminal({
    taskId: task.id,
    roleName: role.name,
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    nativeSessionId: "thread-1",
    nativeTurnId: "turn-goal-2",
    attemptId: "direct:turn-goal-2",
    providerStatus: "completed",
    outcome: {
      status: "completed",
      output: "Goal-directed continuation reply."
    }
  }, continuationAt);
  assert.equal(continued.run, undefined);
  assert.equal(store.listRuns(task.id).length, 0);
  assert.equal(store.getPendingWakeup(task.id), null);

  assert.equal(adapter.observeRuntimeObservation(observation("turn.accepted", 7, {
    fence: { nativeTurnId: "turn-missing-result-3", receiptId: "direct:turn-missing-result-3" }
  }), new Date("2026-08-31T00:31:01.000Z")), "applied");
  const missingResultRun = store.getActiveRun(task.id, role.name);
  assert.equal(missingResultRun, null);
  const preciseDiagnostic = "Provider Agent result is 900000 bytes and exceeds the durable result limit.";
  assert.equal(adapter.observeRuntimeObservation(observation("turn.completed", 8, {
    fence: {
      nativeTurnId: "turn-missing-result-3",
      receiptId: "direct:turn-missing-result-3"
    },
    payload: { resultTransportDiagnostic: preciseDiagnostic }
  }), new Date("2026-08-31T00:31:02.000Z")), "applied");
  assert.equal(store.listRuns(task.id).length, 0);

  assert.equal(adapter.observeRuntimeObservation(observation("goal.updated", 9, {
    payload: {
      goalStatus: "complete",
      goalObjective: "Continue until the delegated work is actually complete.",
      goalUpdatedAt: "2026-08-31T00:31:03.000Z",
      goalNativeTurnId: "turn-ordinary-1"
    }
  }), new Date("2026-08-31T00:31:03.000Z")), "applied");
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, [
    "provider-goal-complete"
  ]);
});

test("a wake names a completed Turn even when that Turn predates the delta cursor", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-wake-result-turn-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const createdAt = new Date("2026-09-04T01:00:00.000Z");
  const cursor = "2026-09-04T01:05:00.000Z";
  const eventAt = new Date("2026-09-04T01:06:00.000Z");
  const task = activateTask(createTask("task-1", "Wake exact result Turn", createdAt), createdAt);
  store.saveTask(task);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const worker = createRole(
    task.id,
    "worker",
    [binding],
    binding.agentId,
    home,
    createdAt
  );
  store.saveRole(task.id, worker);
  const run = completeRun(createRun(
    "turn-1",
    task.id,
    worker.name,
    "new",
    runInput("turn-1", task.id, worker.name, "Produce the result."),
    createdAt,
    { effective: resolveEffectiveLaunch({ role: worker, purpose: "execution" }) }
  ), "# Original result\n\nPreserve this text.", new Date("2026-09-04T01:01:00.000Z"));
  store.saveRun(run);
  store.saveEvent(task.id, createTaskEvent(
    store.nextEventId(task.id),
    task.id,
    "run.completed",
    { runId: run.id, role: worker.name },
    eventAt
  ));

  const envelope = buildTaskWakeEnvelope(store, {
    taskId: task.id,
    wakeId: "wake-1",
    reasons: ["worker-completed"],
    fromCursor: cursor,
    now: eventAt
  });
  assert.deepEqual(envelope.referencedRunIds, [run.id]);
  assert.match(envelope.text, /Changed: 1 events, 0 messages, 1 AgentRuns/u);
  assert.match(envelope.text, /yui task run show task-1\/turn-1/u);

  const wideRuns = Array.from({ length: 6 }, (_, index) => ({
    ...run,
    id: `run-${index + 2}`
  }));
  const wideEvents = wideRuns.map((candidate, index) => createTaskEvent(
    `event-${index + 10}`,
    task.id,
    "run.completed",
    { runId: candidate.id, role: worker.name },
    new Date(eventAt.getTime() + index + 1)
  ));
  const wideEnvelope = buildTaskWakeEnvelope({
    getTask: () => task,
    listEvents: () => wideEvents,
    listMessages: () => [],
    listRuns: () => wideRuns,
    listReviewRounds: () => []
  }, {
    taskId: task.id,
    wakeId: "wake-wide",
    reasons: Array.from(
      { length: 6 },
      (_, index) => `reason-${index + 1}-${"r".repeat(400)}`
    ),
    fromCursor: cursor,
    now: eventAt
  });
  assert.equal(wideEnvelope.referencedRunIds.length, 6);
  assert.ok(wideEnvelope.totalBytes <= WAKE_ENVELOPE_HARD_BYTES);
  assert.equal(Buffer.byteLength(wideEnvelope.text, "utf8"), wideEnvelope.totalBytes);
});

test("Leader notifications settle their accepted mailbox batch without creating an AgentRun", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-leader-wake-window-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
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
    policy: "fixed",
    status: "active",
    effective
  }, firstEventAt);
  let provider = createProviderRuntimeBinding({
    providerNamespace: "openai/codex",
    accountScope: agent.agentId,
    conversationId: "thread-1",
    startedAt: firstEventAt.toISOString()
  });
  sessions = bindTaskRoleProviderRuntime(sessions, provider, firstEventAt);
  store.saveTaskRoleSessionSet(sessions);
  const adapter = new FileSchedulerStoreAdapter(store);
  adapter.enqueueLeaderWakeup(task.id, "worker-completed", firstEventAt);

  const notifications = [];
  const delivery = {
    prepareRoleSession: async (request) => {
      assert.equal(request.runId, undefined);
      return { session: sessions.sessions[agent.agentId] };
    },
    waitUntilReady: async (prepared) => prepared,
    sendOnce: async (request) => {
      notifications.push(request);
      adapter.enqueueLeaderWakeup(task.id, "later-external-message",
        new Date(firstEventAt.getTime() + LEADER_WAKE_AGGREGATION_MS));
      return { status: "sent" };
    }
  };
  let results = await processLeaderWakeups(
    adapter,
    delivery,
    new Date(firstEventAt.getTime() + LEADER_WAKE_AGGREGATION_MS - 1)
  );
  assert.equal(results[0].reason, "aggregating");
  assert.equal(notifications.length, 0);

  results = await processLeaderWakeups(
    adapter,
    delivery,
    new Date(firstEventAt.getTime() + LEADER_WAKE_AGGREGATION_MS)
  );
  assert.equal(results[0].status, "dispatched");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /No separate final report is required/u);
  assert.equal(store.listRuns(task.id).length, 0);
  assert.equal(store.getActiveRun(task.id, leader.name), null);
  assert.deepEqual(store.getPendingWakeup(task.id).reasons, ["later-external-message"]);
  assert.equal(store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" }).processing, null);
  assert.equal(store.listTaskWakes(task.id)[0].status, "consumed");
  assert.equal(store.listTaskWakes(task.id)[0].runId, undefined);
});

test("an active Task without a durable event remains quiet", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-active-task-quiet-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
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
  assert.deepEqual(store.listRuns(task.id), []);
  assert.equal(store.getPendingWakeup(task.id), null);
  assert.equal(store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" }), null);
});

test("active Role Turns deliver from durable state and Worker hints settle at acceptance", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-unowned-provider-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
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
  const role = createRole(
    task.id,
    "worker",
    [agent],
    agent.agentId,
    workspaceRoot,
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
    nativeSessionId: "thread-old",
    policy: "fixed",
    status: "ended",
    endReason: "stopped",
    effective
  }, startedAt);
  let provider = createProviderRuntimeBinding({
    providerNamespace: "openai/codex",
    accountScope: agent.agentId,
    conversationId: "thread-old",
    startedAt: startedAt.toISOString()
  });
  provider = beginProviderTurn(provider, {
    runId: "turn-old",
    attemptId: "turn:task-1/turn-old",
    authorityEpoch: provider.authority.epoch,
    submittedAt: startedAt.toISOString()
  });
  provider = acceptProviderTurn(provider, {
    attemptId: "turn:task-1/turn-old",
    nativeTurnId: "native-turn-old",
    acceptedAt: new Date(startedAt.getTime() + 1_000).toISOString()
  });
  // The old input completed before this explicit Conversation replacement.
  // Ending its Host alone must not manufacture that execution result.
  provider = settleProviderTurn(provider, {
    attemptId: "turn:task-1/turn-old",
    nativeTurnId: "native-turn-old",
    status: "completed",
    settledAt: new Date(startedAt.getTime() + 1_500).toISOString()
  });
  sessions = bindTaskRoleProviderRuntime(sessions, provider, startedAt);
  store.saveTaskRoleSessionSet(sessions);
  const run = createRun(
    "turn-1",
    task.id,
    role.name,
    "new",
    runInput("turn-1", task.id, role.name, "Continue from durable Task context."),
    nextAt,
    { effective }
  );
  store.saveActiveRun(run);
  const deliveryTarget = { kind: "role", taskId: task.id, roleName: role.name };
  const dispatchMailbox = enqueueRoleRunDispatch(store, {
    taskId: task.id,
    roleName: role.name,
    runId: run.id,
    reason: "turn-dispatched",
    occurredAt: nextAt
  });
  assert.deepEqual(dispatchMailbox.pending.refs, [
    { type: "run", taskId: task.id, id: run.id }
  ]);

  let preparedCalls = 0;
  const prepared = {
    deliveryId: "delivery-1",
    runId: run.id,
    taskId: task.id,
    roleName: role.name,
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    mode: "new",
    sessionStarted: true,
    session: {
      agentId: agent.agentId,
      adapterId: agent.adapterId,
      nativeSessionId: "thread-new",
      status: "active",
      effective
    }
  };
  const adapter = new FileSchedulerStoreAdapter(store);
  const delivery = {
    prepareRoleSession: async (request) => {
      preparedCalls += 1;
      request.beforeHostStart({
        owner: { scope: "task", taskId: task.id, roleName: role.name },
        runId: run.id,
        agentId: agent.agentId,
        adapterId: agent.adapterId,
        effective,
        nativeSessionId: "thread-new"
      });
      return prepared;
    },
    waitUntilReady: async () => {
      assert.equal(adapter.observeRuntimeObservation({
        schemaVersion: 4,
        eventId: "new-session-ready",
        semanticKey: "new-session-ready",
        kind: "session.ready",
        authority: "provider-structured",
        receivedAt: nextAt.toISOString(),
        observedAt: nextAt.toISOString(),
        sequence: 1,
        ordinal: 0,
        fence: {
          taskId: task.id,
          roleName: role.name,
          runId: run.id,
          agentId: agent.agentId,
          driverId: "openai/codex",
          nativeSessionId: "thread-new",
          receiptId: "turn:task-1/turn-1",
          conversationId: "thread-new",
        },
        payload: {}
      }, nextAt), "applied");
      return { prepared, session: prepared.session };
    },
    sendOnce: async () => ({ status: "sent" }),
    inspectRole: async () => "present"
  };

  const [result] = await processActiveRoleRunDeliveries(
    adapter,
    delivery,
    nextAt
  );
  assert.equal(result.status, "delivered", JSON.stringify(result));
  assert.equal(preparedCalls, 1);
  assert.equal(store.getWorkMailbox(deliveryTarget).pending, null);
  const replacedProvider = store.getTaskRoleSessionSet(task.id, role.name).providerBinding;
  assert.equal(replacedProvider.currentConversationEpoch, 2);
  assert.equal(
    replacedProvider.conversations.find(({ status }) => status === "current").conversationId,
    "thread-new"
  );
  const workerTerminal = store.transaction((tx) => terminalizeExactTaskRun(tx, {
    taskId: task.id,
    roleName: role.name,
    agentId: agent.agentId,
    runId: run.id,
    outcome: {
      status: "failed",
      failureReason: "runtime-failed",
      diagnostic: "Worker delivery path verified."
    }
  }, new Date(nextAt.getTime() + 1_000)));
  assert.equal(workerTerminal.disposition, "applied");

  const leaderTask = activateTask(createTask("task-2", "Deliver a Leader Turn", nextAt, {
    cwd: workspaceRoot
  }), nextAt);
  store.saveTask(leaderTask);
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: leaderTask.id },
    root: workspaceRoot,
    entries: []
  }, nextAt));
  const leader = createRole(
    leaderTask.id,
    "leader",
    [agent],
    agent.agentId,
    workspaceRoot,
    nextAt
  );
  store.saveRole(leaderTask.id, leader);
  const leaderEffective = resolveEffectiveLaunch({ role: leader, purpose: "execution" });
  const leaderRun = createRun(
    "turn-1",
    leaderTask.id,
    leader.name,
    "new",
    runInput("turn-1", leaderTask.id, leader.name, "Continue from durable Task state."),
    nextAt,
    { effective: leaderEffective }
  );
  store.saveActiveRun(leaderRun);
  assert.equal(store.getWorkMailbox({
    kind: "role",
    taskId: leaderTask.id,
    roleName: leader.name
  }), null);
  const leaderPrepared = {
    deliveryId: "delivery-leader",
    runId: leaderRun.id,
    taskId: leaderTask.id,
    roleName: leader.name,
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    mode: "new",
    sessionStarted: true,
    session: {
      agentId: agent.agentId,
      adapterId: agent.adapterId,
      nativeSessionId: "thread-leader",
      status: "active",
      effective: leaderEffective
    }
  };
  let leaderDeliveryCalls = 0;
  const leaderPass = await runControllerSchedulerPass(
    adapter,
    {
      prepareRoleSession: async (request) => {
        leaderDeliveryCalls += 1;
        request.beforeHostStart({
          owner: { scope: "task", taskId: leaderTask.id, roleName: leader.name },
          runId: leaderRun.id,
          agentId: agent.agentId,
          adapterId: agent.adapterId,
          effective: leaderEffective,
          nativeSessionId: "thread-leader"
        });
        return leaderPrepared;
      },
      waitUntilReady: async () => ({
        prepared: leaderPrepared,
        session: leaderPrepared.session
      }),
      sendOnce: async () => ({ status: "sent" }),
      inspectRole: async () => "present"
    },
    nextAt,
    undefined,
    { kind: "full" },
    false
  );
  const leaderResult = leaderPass.activeRunDeliveries.find((candidate) => (
    candidate.taskId === leaderTask.id && candidate.roleName === leader.name
  ));
  assert.notEqual(leaderResult, undefined);
  assert.equal(leaderResult.status, "delivered", JSON.stringify(leaderResult));
  assert.equal(leaderDeliveryCalls, 1);
  assert.equal(store.getWorkMailbox({
    kind: "role",
    taskId: leaderTask.id,
    roleName: leader.name
  }), null);
});

test("Task completion leaves its reusable Provider Session running", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-completed-task-session-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
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
  const run = createRun(
    "turn-1",
    task.id,
    role.name,
    "new",
    runInput("turn-1", task.id, role.name, "Finish this managed Turn."),
    startedAt,
    { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }
  );
  store.saveActiveRun(run);
  let sessions = recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: task.id, roleName: role.name },
    agent.agentId,
    startedAt
  ), {
    agentId: agent.agentId,
    adapterId: agent.adapterId,
    nativeSessionId: "thread-1",
    policy: "fixed",
    status: "active",
    effective: run.effective
  }, startedAt);
  let provider = createProviderRuntimeBinding({
    providerNamespace: "openai/codex",
    accountScope: agent.agentId,
    conversationId: "thread-1",
    startedAt: startedAt.toISOString()
  });
  provider = beginProviderTurn(provider, {
    runId: run.id,
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
    nativeSessionId: "thread-1",
    nativeTurnId: "turn-1",
    attemptId: "run:task-1/turn-1",
    runId: run.id,
    providerStatus: "completed",
    outcome: {
      status: "completed",
      output: "Managed execution finished."
    }
  };
  runTaskCommand(
    ["message", "send", task.id, "A newer fact arrived during the current Turn."],
    store,
    { now: () => new Date("2026-08-31T01:00:30.000Z"), environment: bareEnv }
  );

  assert.deepEqual(adapter.observeRuntimeRunTerminal(terminal, completedAt), {
    session: store.getTaskRoleSessionSet(task.id, role.name).sessions[agent.agentId],
    duplicate: false,
    run: store.getRun(task.id, run.id)
  });
  const completed = store.getRun(task.id, run.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.output, "Managed execution finished.");
  assert.deepEqual(completed.result.provider, {
    providerNamespace: "openai/codex",
    accountScope: agent.agentId,
    conversationId: "thread-1",
    nativeTurnId: "turn-1",
    attemptId: "run:task-1/turn-1",
    status: "completed"
  });
  assert.equal(store.getActiveRun(task.id, role.name), null);
  assert.equal(store.getTaskRoleSessionSet(task.id, role.name).sessions[agent.agentId].status, "active");

  const replay = adapter.observeRuntimeRunTerminal(terminal, completedAt);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.run.id, run.id);
  assert.equal(store.listRuns(task.id).length, 1);

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
    "open",
    now
  );
  store.saveWorkItem(task.id, item);
  const activeRun = createRun(
    "turn-1",
    task.id,
    leader.name,
    "new",
    runInput("turn-1", task.id, leader.name, "Continue the Task."),
    now,
    {
      effective: resolveEffectiveLaunch({ role: leader, purpose: "execution" })
    }
  );
  store.saveActiveRun(activeRun);

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
  assert.equal(store.getRun(task.id, activeRun.id).status, "failed");
  assert.equal(store.getActiveRun(task.id, leader.name), null);
  assert.equal(store.getWorkItem(task.id, item.id).status, "open");
  assert.throws(() => runTaskCommand(
    ["run", "retry", `${task.id}/${activeRun.id}`],
    store,
    { now: () => new Date("2026-08-30T00:01:30.000Z"), environment: bareEnv }
  ), /Task execution is stopped/);
  assert.equal(store.getActiveRun(task.id, leader.name), null);

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
    "accepted",
    new Date("2026-08-30T00:03:00.000Z"),
    "Edits retained."
  );
  store.saveWorkItem(task.id, completedItem);
  const disposableRun = createRun(
    "turn-2",
    task.id,
    leader.name,
    "new",
    runInput("turn-2", task.id, leader.name, "Finish the Task."),
    new Date("2026-08-30T00:03:00.000Z"),
    { effective: activeRun.effective }
  );
  store.saveActiveRun(disposableRun);
  runTaskCommand(
    ["complete", task.id, "--summary", "Delivery complete."],
    store,
    { now: () => new Date("2026-08-30T00:04:00.000Z"), environment: bareEnv }
  );
  assert.equal(store.getTask(task.id).status, "completed");
  assert.equal(store.getRun(task.id, disposableRun.id).status, "active");
  assert.equal(store.getActiveRun(task.id, leader.name).id, disposableRun.id);
  assert.equal(store.getWorkItem(task.id, completedItem.id).status, "accepted");
});

test("direct and replicated WorkItem execution converge through exact Lane retry", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-work-item-execution-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const startedAt = new Date("2026-09-02T00:00:00.000Z");
  const task = activateTask(createTask("task-1", "Execute WorkItems", startedAt, {
    cwd: home
  }), startedAt);
  store.saveTask(task);
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: task.id },
    root: home,
    entries: []
  }, startedAt));
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  for (const roleName of ["leader", "producer-a", "producer-b"]) {
    store.saveRole(task.id, createRole(
      task.id,
      roleName,
      [binding],
      binding.agentId,
      home,
      startedAt
    ));
  }
  const finish = (run, status, now) => {
    const result = store.transaction((tx) => terminalizeExactTaskRun(tx, {
      taskId: task.id,
      roleName: run.roleName,
      agentId: run.effective.agentId,
      runId: run.id,
      outcome: status === "completed"
        ? { status, output: `${run.roleName} completed.` }
        : {
            status,
            diagnostic: `${run.roleName} failed.`,
            failureReason: "runtime-failed"
          }
    }, now));
    assert.equal(result.disposition, "applied");
  };

  const directItem = createWorkItem("work-item-1", task.id, {
    title: "Direct execution",
    assignee: "leader"
  }, startedAt);
  store.saveWorkItem(task.id, directItem);
  assert.throws(() => runTaskCommand(
    ["work", "dispatch", `${task.id}/${directItem.id}`],
    store,
    {
      now: () => startedAt,
      environment: {
        ...bareEnv,
        YUI_SESSION_SCOPE: "task",
        YUI_TASK_ID: task.id,
        YUI_ROLE: "producer-a"
      }
    }
  ), /matching Leader/u);
  assert.deepEqual(store.listRuns(task.id), []);
  runTaskCommand(
    ["work", "dispatch", `${task.id}/${directItem.id}`],
    store,
    { now: () => startedAt, environment: bareEnv }
  );
  const directRun = store.getActiveRun(task.id, "leader");
  assert.equal(directRun.executionGroupId, undefined);
  assert.equal(directRun.sourceExecutionGroupId, undefined);
  assert.equal(
    store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" }),
    null
  );
  finish(directRun, "failed", new Date("2026-09-02T00:00:30.000Z"));
  const directProjection = projectWorkItemExecution(
    store.getWorkItem(task.id, directItem.id),
    store.listRuns(task.id)
  );
  assert.equal(directProjection.nextAction.kind, "retry-main");
  assert.deepEqual(directProjection.nextAction.targetIds, [directRun.id]);
  runTaskCommand(
    ["run", "retry", `${task.id}/${directRun.id}`],
    store,
    { now: () => new Date("2026-09-02T00:00:45.000Z"), environment: bareEnv }
  );
  const retriedDirect = store.getActiveRun(task.id, "leader");
  assert.notEqual(retriedDirect.id, directRun.id);
  finish(retriedDirect, "completed", new Date("2026-09-02T00:01:00.000Z"));

  const groupedItem = createWorkItem("work-item-2", task.id, {
    title: "Replicated execution",
    assignee: "leader"
  }, startedAt);
  store.saveWorkItem(task.id, groupedItem);
  const groupId = `execution-group-${store.peekNextRunId(task.id)}`;
  const laneWorkspaces = new Map([1, 2].map((ordinal) => {
    const laneId = `${groupId}-lane-${ordinal}`;
    return [laneId, createManagedWorkspace({
      owner: {
        type: "execution-lane",
        taskId: task.id,
        executionGroupId: groupId,
        executionLaneId: laneId,
        purpose: "execution",
        workItemId: groupedItem.id
      },
      root: join(home, `lane-${ordinal}`),
      entries: []
    }, startedAt)];
  }));
  runTaskCommand([
    "work", "dispatch", `${task.id}/${groupedItem.id}`,
    "--lane-role", "producer-a",
    "--lane-role", "producer-b"
  ], store, {
    now: () => new Date("2026-09-02T00:02:00.000Z"),
    environment: bareEnv,
    executionLaneWorkspaces: laneWorkspaces
  });
  const producerA = store.getActiveExecutionLaneRun(task.id, groupId, `${groupId}-lane-1`);
  const producerB = store.getActiveExecutionLaneRun(task.id, groupId, `${groupId}-lane-2`);
  const producerAMailbox = store.getWorkMailbox({
    kind: "role",
    taskId: task.id,
    roleName: producerA.roleName
  });
  assert.deepEqual(producerAMailbox.pending.refs, [
    { type: "run", taskId: task.id, id: producerA.id }
  ]);
  finish(producerA, "completed", new Date("2026-09-02T00:03:00.000Z"));
  assert.equal(store.getWorkMailbox({
    kind: "role",
    taskId: task.id,
    roleName: producerA.roleName
  }).pending, null);
  stopTaskExecutionCommand(
    { taskId: task.id, reason: "Exercise exact Lane recovery" },
    store,
    { now: () => new Date("2026-09-02T00:04:00.000Z"), environment: bareEnv }
  );
  assert.equal(store.getRun(task.id, producerB.id).status, "failed");
  assert.equal(
    store.getWorkItem(task.id, groupedItem.id).executionGroups.at(-1).lanes[1].disposition,
    "open"
  );
  startTaskExecutionCommand(task.id, store, {
    now: () => new Date("2026-09-02T00:04:30.000Z"),
    environment: bareEnv
  });

  const execution = buildTaskExecutionProjection(store, task.id);
  const next = projectNextAction({
    ...store.readNextActionFacts(task.id),
    executionGroups: execution.executionGroups
  });
  assert.equal(next.kind, "retry-execution-lane");
  assert.equal(next.recommendedCommand, `yui task run retry ${task.id}/${producerB.id}`);
  runTaskCommand(
    ["run", "retry", `${task.id}/${producerB.id}`],
    store,
    { now: () => new Date("2026-09-02T00:05:00.000Z"), environment: bareEnv }
  );
  const retriedProducer = store.getActiveExecutionLaneRun(
    task.id,
    groupId,
    `${groupId}-lane-2`
  );
  assert.notEqual(retriedProducer.id, producerB.id);
  finish(retriedProducer, "completed", new Date("2026-09-02T00:06:00.000Z"));

  assert.equal(store.getActiveRun(task.id, "leader"), null);
  runTaskCommand([
    "work", "synthesize", `${task.id}/${groupedItem.id}`,
    "--source-run", `${task.id}/${producerA.id}`
  ], store, {
    now: () => new Date("2026-09-02T00:06:30.000Z"), environment: bareEnv
  });
  const mainRun = store.getActiveRun(task.id, "leader");
  assert.equal(mainRun.workItemId, groupedItem.id);
  assert.equal(mainRun.sourceExecutionGroupId, groupId);
  assert.equal(mainRun.executionGroupId, undefined);
  assert.match(mainRun.inputs[0].input.directive, new RegExp(groupId, "u"));
});

test("direct and replicated Review keep Producer results non-authoritative", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-review-execution-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-09-02T00:10:00.000Z");
  const projectRoot = join(home, "project");
  mkdirSync(projectRoot, { recursive: true });
  const project = createProject(
    "project-1",
    "app",
    projectRoot,
    { stable: "main", development: "main" },
    now
  );
  store.saveProject(project);
  const taskIdentity = generateTaskWorkspaceIdentity({
    home: store.getHomeIdentity(),
    taskId: "task-1",
    now,
    entropy: Buffer.alloc(16, 8)
  });
  const commit = "a".repeat(40);
  const task = activateTask(bindTaskWorkspaceIdentity(createTask(
    "task-1",
    "Review one frozen Task candidate",
    now,
    {
      cwd: home,
      projectBindings: [{
        projectId: project.id,
        directory: "app",
        baseRef: "main",
        baseCommit: commit,
        currentCommit: commit
      }]
    }
  ), taskIdentity, now), now);
  store.saveTask(task);
  const candidate = {
    schemaVersion: 1,
    projects: [{ projectId: project.id, commit }]
  };
  const taskRoot = join(home, "task-main");
  mkdirSync(taskRoot, { recursive: true });
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: task.id },
    root: taskRoot,
    entries: [{
      projectId: project.id,
      directory: "app",
      access: "write",
      path: projectRoot,
      branch: "main",
      baseRef: "main",
      baseCommit: commit
    }]
  }, now));
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  for (const roleName of [
    "reviewer-direct",
    "reviewer-main",
    "producer-a",
    "producer-b",
    "candidate-main",
    "candidate-a",
    "candidate-b"
  ]) {
    store.saveGlobalRole(createGlobalRole(
      roleName,
      [binding],
      binding.agentId,
      home,
      now
    ));
  }
  const attachWorkspace = (round, label) => {
    const rootPath = join(home, label);
    const projectPath = join(rootPath, "app");
    mkdirSync(projectPath, { recursive: true });
    const workspace = createManagedWorkspace({
      owner: { type: "review-round", taskId: task.id, reviewRoundId: round.id },
      root: rootPath,
      entries: [{
        projectId: project.id,
        directory: "app",
        access: "write",
        path: projectPath,
        branch: label,
        baseRef: commit,
        baseCommit: commit
      }]
    }, now);
    store.saveManagedWorkspace(workspace);
    const attached = attachReviewRoundWorkspace(round, workspace);
    store.saveReviewRound(task.id, attached);
    return attached;
  };
  const laneWorkspacesFor = (round) => new Map(round.executionGroup.lanes.map((lane) => {
    const laneRoot = join(home, lane.id);
    return [lane.id, createManagedWorkspace({
      owner: {
        type: "execution-lane",
        taskId: task.id,
        executionGroupId: round.executionGroup.id,
        executionLaneId: lane.id,
        purpose: "review",
        reviewRoundId: round.id
      },
      root: laneRoot,
      entries: [{
        projectId: project.id,
        directory: "app",
        access: "write",
        path: join(laneRoot, "app"),
        branch: lane.id,
        baseRef: commit,
        baseCommit: commit
      }]
    }, now)];
  }));
  const finish = (
    run,
    status,
    completedAt,
    output,
    producerLabel,
    includeGitSnapshot = true
  ) => {
    const result = store.transaction((tx) => terminalizeExactTaskRun(tx, {
      taskId: task.id,
      roleName: run.roleName,
      agentId: run.effective.agentId,
      runId: run.id,
      outcome: status === "failed"
        ? { status, diagnostic: output, failureReason: "runtime-failed" }
        : { status, output },
      ...(status === "completed"
        && run.executionLaneId !== undefined
        && includeGitSnapshot
        ? {
            systemEvidence: {
              workspaceSnapshot: {
                schemaVersion: 1,
                projects: [{
                  projectId: project.id,
                  headCommit: commit,
                  branch: producerLabel
                }]
              }
            }
          }
        : {})
    }, completedAt));
    assert.equal(result.disposition, "applied");
    return result.run;
  };

  const revisionBeforeInvalidCandidateRequest = store.getRevision();
  assert.throws(() => runTaskCommand([
    "review", "request", task.id,
    "--role", "reviewer-main",
    "--lane-role", "producer-a"
  ], store, {
    now: () => now,
    environment: bareEnv,
    actualTaskReviewCandidate: candidate
  }), /zero or at least two --lane-role/u);
  assert.equal(store.getRevision(), revisionBeforeInvalidCandidateRequest);
  assert.deepEqual(store.listReviewRounds(task.id), []);

  runTaskCommand([
    "review", "request", task.id,
    "--role", "reviewer-direct"
  ], store, {
    now: () => now,
    environment: bareEnv,
    actualTaskReviewCandidate: candidate
  });
  const directRound = attachWorkspace(store.listReviewRounds(task.id).at(-1), "review-direct");
  assert.equal(directRound.executionGroup, undefined);
  const directRun = dispatchPreparedReviewRound(task.id, directRound.id, store, {
    now: () => new Date("2026-09-02T00:11:00.000Z"),
    environment: bareEnv,
    actualTaskReviewCandidate: candidate
  });
  assert.ok(directRun);
  assert.equal(directRun.executionGroupId, undefined);
  assert.equal(directRun.executionLaneId, undefined);
  assert.equal(directRun.sourceExecutionGroupId, undefined);
  const directOutput = "# Direct review\n\nFree-form result; no JSON contract.";
  const completedDirect = finish(
    directRun,
    "completed",
    new Date("2026-09-02T00:12:00.000Z"),
    directOutput,
    "direct"
  );
  assert.equal(store.getReviewRound(task.id, directRound.id).status, "completed");
  assert.equal(completedDirect.result.output, directOutput);

  runTaskCommand([
    "review", "request", task.id,
    "--role", "reviewer-direct"
  ], store, {
    now: () => new Date("2026-09-02T00:12:10.000Z"),
    environment: bareEnv,
    actualTaskReviewCandidate: candidate
  });
  const failedRound = attachWorkspace(
    store.listReviewRounds(task.id).at(-1),
    "review-direct-failed"
  );
  const failedRun = dispatchPreparedReviewRound(task.id, failedRound.id, store, {
    now: () => new Date("2026-09-02T00:12:20.000Z"),
    environment: bareEnv,
    actualTaskReviewCandidate: candidate
  });
  const failureOutput = "Provider Agent Turn failed: reviewer process exited with status 17";
  const terminalFailure = finish(
    failedRun,
    "failed",
    new Date("2026-09-02T00:12:30.000Z"),
    failureOutput,
    "direct-failed"
  );
  assert.equal(terminalFailure.result.failureReason, "runtime-failed");
  assert.equal(
    store.getReviewRound(task.id, failedRound.id).failure.message,
    failureOutput
  );

  runTaskCommand([
    "review", "request", task.id,
    "--role", "reviewer-main",
    "--lane-role", "producer-a",
    "--lane-role", "producer-b"
  ], store, {
    now: () => new Date("2026-09-02T00:13:00.000Z"),
    environment: bareEnv,
    actualTaskReviewCandidate: candidate
  });
  let replicatedRound = store.listReviewRounds(task.id).at(-1);
  assert.ok(replicatedRound.executionGroup);
  assert.deepEqual(
    replicatedRound.executionGroup.lanes.map(({ roleName }) => roleName),
    ["producer-a", "producer-b"]
  );
  assert.deepEqual(
    replicatedRound.executionGroup.assignment.projects,
    [{ projectId: project.id, baseCommit: commit }]
  );
  replicatedRound = attachWorkspace(replicatedRound, "review-main");
  const groupId = replicatedRound.executionGroup.id;
  const laneWorkspaces = laneWorkspacesFor(replicatedRound);
  dispatchPreparedReviewRound(task.id, replicatedRound.id, store, {
    now: () => new Date("2026-09-02T00:14:00.000Z"),
    environment: bareEnv,
    actualTaskReviewCandidate: candidate,
    executionLaneWorkspaces: laneWorkspaces
  });
  const producerRuns = store.listRuns(task.id)
    .filter(({ reviewRoundId, executionGroupId }) => (
      reviewRoundId === replicatedRound.id && executionGroupId === groupId
    ))
    .sort((left, right) => left.executionLaneId.localeCompare(right.executionLaneId));
  assert.equal(producerRuns.length, 2);
  assert.equal(store.getReviewRound(task.id, replicatedRound.id).reviewerRunId, undefined);
  assert.equal(new Set(producerRuns.map(({ workspace }) => workspace.root)).size, 2);
  for (const producer of producerRuns) {
    assert.notEqual(producer.workspace.root, taskRoot);
    assert.notEqual(producer.workspace.root, replicatedRound.workspace.root);
    assert.equal(producer.effective.writeProjectIds[0], project.id);
    assert.match(producer.inputs[0].input.directive, new RegExp(groupId, "u"));
    assert.match(producer.inputs[0].input.directive, new RegExp(commit, "u"));
  }

  const producerOutputs = [
    "# Producer A\n\nA plain Markdown result without required headings.",
    "{\"shape\":\"optional\"}\nThis trailing prose intentionally makes it invalid JSON."
  ];
  const firstProducer = finish(
    producerRuns[0],
    "completed",
    new Date("2026-09-02T00:15:00.000Z"),
    producerOutputs[0],
    "producer-a"
  );
  assert.equal(firstProducer.status, "completed");
  assert.equal(firstProducer.result.output, producerOutputs[0]);
  assert.deepEqual(firstProducer.result.systemEvidence.workspaceSnapshot.projects, [{
    projectId: project.id,
    headCommit: commit,
    branch: "producer-a"
  }]);
  assert.equal(store.getReviewRound(task.id, replicatedRound.id).reviewerRunId, undefined);
  const secondProducer = finish(
    producerRuns[1],
    "completed",
    new Date("2026-09-02T00:16:00.000Z"),
    producerOutputs[1],
    "producer-b"
  );
  assert.equal(secondProducer.result.output, producerOutputs[1]);
  assert.equal(store.getActiveRun(task.id, "reviewer-main"), null);
  runTaskCommand([
    "review", "synthesize", `${task.id}/${replicatedRound.id}`,
    ...producerRuns.flatMap(({ id }) => ["--source-run", `${task.id}/${id}`])
  ], store, {
    now: () => new Date("2026-09-02T00:16:15.000Z"), environment: bareEnv
  });
  const initialMain = store.getActiveRun(task.id, "reviewer-main");
  assert.ok(initialMain);
  assert.equal(initialMain.sourceExecutionGroupId, groupId);
  assert.equal(initialMain.executionGroupId, undefined);
  assert.equal(initialMain.executionLaneId, undefined);
  const mainSnapshotRef = initialMain.inputs[0].input.contextSnapshotRef;
  const mainSnapshot = store.getContextSnapshot(task.id, mainSnapshotRef.id);
  const sourceRuns = mainSnapshot.resources
    .filter(({ ref }) => ref.store === "source-run")
    .map(({ value }) => value);
  assert.deepEqual(
    sourceRuns.map(({ id }) => id),
    producerRuns.map(({ id }) => id)
  );
  assert.deepEqual(
    sourceRuns.map(({ result }) => result.output),
    producerOutputs
  );
  for (const sourceRun of sourceRuns) {
    assert.equal(Object.hasOwn(sourceRun, "inputs"), false);
    assert.equal(Object.hasOwn(sourceRun, "workspace"), false);
    assert.equal(Object.hasOwn(sourceRun, "effective"), false);
  }

  const authoritativeOutput = [
    "# Main review",
    "",
    "I read both exact source results. This conclusion remains ordinary prose.",
    "Severity words and JSON-like text have no Core meaning."
  ].join("\n");
  const completedMain = finish(
    initialMain,
    "completed",
    new Date("2026-09-02T00:17:00.000Z"),
    authoritativeOutput,
    "main"
  );
  const terminalRound = store.getReviewRound(task.id, replicatedRound.id);
  assert.equal(terminalRound.status, "completed");
  assert.equal(terminalRound.reviewerRunId, initialMain.id);
  assert.equal(completedMain.result.output, authoritativeOutput);
  assert.equal(Object.hasOwn(terminalRound, "report"), false);
  assert.equal(Object.hasOwn(terminalRound, "checks"), false);
  assert.deepEqual(store.listWorkItems(task.id), []);
  assert.deepEqual(store.listChangeSets(task.id), []);
  assert.deepEqual(store.listIntegrationAttempts(task.id), []);
  const candidateWorkspace = createManagedWorkspace({
    owner: { type: "work-item", taskId: task.id, workItemId: "work-item-1" },
    root: join(home, "candidate"),
    entries: [{
      projectId: project.id,
      directory: "app",
      access: "write",
      path: join(home, "candidate", "app"),
      branch: "candidate",
      baseRef: commit,
      baseCommit: commit
    }]
  }, now);
  store.saveManagedWorkspace(candidateWorkspace);
  let item = updateWorkItemStatus(createWorkItem("work-item-1", task.id, {
    title: "Candidate implementation",
    objective: "Review the exact submitted implementation.",
    acceptance: ["Inspect the frozen Candidate."],
    writeProjectIds: [project.id]
  }, now), "open", now);
  item = submitWorkItemCandidate(item, {
    summary: "Candidate ready.",
    source: { type: "direct" },
    reviewPolicy: { roleName: "candidate-main", trigger: "leader" },
    workspace: candidateWorkspace,
    gitSnapshot: createCandidateGitSnapshot(candidateWorkspace, [{
      projectId: project.id,
      commit
    }])
  }, now);
  store.saveWorkItem(task.id, item);

  const revisionBeforeInvalidRequest = store.getRevision();
  assert.throws(() => runTaskCommand([
    "work", "review", `${task.id}/${item.id}`,
    "--lane-role", "candidate-a"
  ], store, {
    now: () => now,
    environment: bareEnv
  }), /zero or at least two --lane-role/u);
  assert.equal(store.getRevision(), revisionBeforeInvalidRequest);

  const revisionBeforeProducerCollision = store.getRevision();
  assert.throws(() => runTaskCommand([
    "work", "review", `${task.id}/${item.id}`,
    "--lane-role", "leader",
    "--lane-role", "candidate-b"
  ], store, {
    now: () => now,
    environment: bareEnv
  }), /separate from the Candidate producer/u);
  assert.equal(store.getRevision(), revisionBeforeProducerCollision);

  runTaskCommand([
    "work", "review", `${task.id}/${item.id}`,
    "--lane-role", "candidate-a",
    "--lane-role", "candidate-b"
  ], store, {
    now: () => now,
    environment: bareEnv
  });
  let round = store.listReviewRounds(task.id).at(-1);
  assert.equal(round.scope ?? "work-item", "work-item");
  assert.deepEqual(
    round.executionGroup.lanes.map(({ roleName }) => roleName),
    ["candidate-a", "candidate-b"]
  );
  assert.deepEqual(round.executionGroup.assignment, {
    schemaVersion: 1,
    input: `Review the frozen WorkItem Candidate for ReviewRound ${round.id}.`,
    objective: item.objective,
    acceptance: item.acceptance,
    contextSnapshotRef: round.executionGroup.assignment.contextSnapshotRef,
    taskId: task.id,
    reviewRoundId: round.id,
    reviewBaseCommit: commit,
    scope: "work-item",
    workItemId: item.id,
    candidateId: item.candidates.at(-1).id,
    projects: [{ projectId: project.id, baseCommit: commit }]
  });
  assert.equal(
    projectNextAction(store.readNextActionFacts(task.id)).recommendedCommand,
    `yui task work review ${task.id}/${item.id}`
      + " --lane-role candidate-a --lane-role candidate-b"
  );
  round = attachWorkspace(round, "candidate-review");
  dispatchPreparedReviewRound(task.id, round.id, store, {
    now: () => new Date("2026-09-03T00:01:00.000Z"),
    environment: bareEnv,
    executionLaneWorkspaces: laneWorkspacesFor(round)
  });
  const candidateProducerRuns = store.listRuns(task.id).filter(({ reviewRoundId }) => (
    reviewRoundId === round.id
  ));
  assert.equal(candidateProducerRuns.length, 2);
  assert.equal(new Set(candidateProducerRuns.map(({ workspace }) => workspace.root)).size, 2);
  assert.ok(candidateProducerRuns.every(({ executionGroupId }) => (
    executionGroupId === round.executionGroup.id
  )));
  assert.equal(store.getReviewRound(task.id, round.id).reviewerRunId, undefined);
});

test("Leader replicated Lanes derive from Task main without a WorkItem workspace", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-leader-lane-workspace-smoke-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "yui-leader-lane-worktrees-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  store.saveConfig({ ...store.getConfig(), defaultWorkspace: workspaceRoot });
  const now = new Date("2026-09-02T00:10:00.000Z");
  const projectRoot = join(home, "project");
  const laneRoots = [join(home, "lane-project-1"), join(home, "lane-project-2")];
  mkdirSync(projectRoot, { recursive: true });
  for (const laneRoot of laneRoots) mkdirSync(laneRoot, { recursive: true });
  const project = createProject(
    "project-1",
    "app",
    projectRoot,
    { stable: "main", development: "main" },
    now
  );
  store.saveProject(project);
  const taskIdentity = generateTaskWorkspaceIdentity({
    home: store.getHomeIdentity(),
    taskId: "task-1",
    now,
    entropy: Buffer.alloc(16, 7)
  });
  const task = activateTask(bindTaskWorkspaceIdentity(createTask(
    "task-1",
    "Leader replicated execution",
    now,
    {
      cwd: home,
      projectBindings: [{ projectId: project.id, directory: "app", baseRef: "main" }]
    }
  ), taskIdentity, now), now);
  store.saveTask(task);
  const recordedBase = "a".repeat(40);
  const currentHead = "b".repeat(40);
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: task.id },
    root: join(home, "task-main"),
    entries: [{
      projectId: project.id,
      directory: "app",
      access: "write",
      path: projectRoot,
      branch: "main",
      baseRef: "main",
      baseCommit: recordedBase
    }]
  }, now));
  const item = createWorkItem("work-item-1", task.id, {
    title: "Leader work",
    assignee: "leader",
    writeProjectIds: [project.id]
  }, now);
  store.saveWorkItem(task.id, item);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  for (const roleName of ["leader", "producer-a", "producer-b"]) {
    store.saveRole(task.id, createRole(
      task.id,
      roleName,
      [binding],
      binding.agentId,
      home,
      now
    ));
  }
  const ensureCalls = [];
  const git = {
    isClean: async () => true,
    headRef: async () => "main",
    inspect: async () => ({ baseCommit: currentHead }),
    isAncestor: async (_path, ancestor, descendant) => (
      ancestor === recordedBase && descendant === currentHead
    ),
    ensureWorktree: async (input) => {
      ensureCalls.push(input);
      return {
        path: laneRoots[ensureCalls.length - 1],
        branch: `yui/task-1/lane-${ensureCalls.length}`,
        baseCommit: currentHead
      };
    }
  };
  const preparer = new FileTaskWorkspacePreparer(home, store, git, () => now);
  const inputHeads = await preparer.snapshotExecutionLaneInputHeads(
    store.getTaskWorkspace(task.id),
    item.writeProjectIds
  );
  const groupId = `execution-group-${store.peekNextRunId(task.id)}`;
  const laneWorkspaces = new Map();
  for (const ordinal of [1, 2]) {
    const laneId = `${groupId}-lane-${ordinal}`;
    laneWorkspaces.set(laneId, await preparer.prepareExecutionLaneWorkspace(
      task.id,
      groupId,
      laneId,
      { purpose: "execution", workItemId: item.id, inputHeads }
    ));
  }
  assert.equal(store.getWorkItemWorkspace(task.id, item.id), null);
  assert.equal(ensureCalls.length, 2);
  assert.deepEqual(inputHeads, [{ projectId: project.id, headCommit: currentHead }]);
  for (const [ordinal, workspace] of [...laneWorkspaces.values()].entries()) {
    assert.equal(ensureCalls[ordinal].baseRef, currentHead);
    assert.equal(workspace.entries[0].baseCommit, currentHead);
    assert.equal(workspace.entries[0].access, "write");
  }
  runTaskCommand([
    "work", "dispatch", `${task.id}/${item.id}`,
    "--lane-role", "producer-a",
    "--lane-role", "producer-b"
  ], store, {
    now: () => now,
    environment: bareEnv,
    executionLaneWorkspaces: laneWorkspaces
  });
  assert.deepEqual(
    store.getWorkItem(task.id, item.id).executionGroups[0].assignment.projects,
    [{ projectId: project.id, baseCommit: currentHead }]
  );
});

test("Core freezes writable Lane state without parsing the Producer output", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-producer-evidence-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-09-02T00:20:00.000Z");
  const task = activateTask(createTask("task-1", "Producer evidence", now, { cwd: home }), now);
  store.saveTask(task);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const roles = ["producer-a", "producer-b"].map((roleName) => createRole(
    task.id,
    roleName,
    [binding],
    binding.agentId,
    home,
    now
  ));
  for (const role of roles) store.saveRole(task.id, role);
  const projectIds = ["project-1", "project-2"];
  const commits = ["a".repeat(40), "b".repeat(40)];
  const snapshotRef = {
    schemaVersion: 1,
    id: "context-snapshot-1",
    taskId: task.id,
    scope: "task",
    sequence: 1,
    digest: "c".repeat(64)
  };

  const prepare = (workItemId, groupId, firstRunId, writeProjectIds = projectIds) => {
    const item = updateWorkItemStatus(createWorkItem(workItemId, task.id, {
      title: workItemId,
      assignee: "producer-a",
      writeProjectIds
    }, now), "open", now);
    const laneWorkspaces = roles.map((role, index) => createManagedWorkspace({
      owner: {
        type: "execution-lane",
        taskId: task.id,
        executionGroupId: groupId,
        executionLaneId: `${groupId}-lane-${index + 1}`,
        purpose: "execution",
        workItemId
      },
      root: join(home, `${groupId}-lane-${index + 1}`),
      entries: writeProjectIds.map((projectId) => {
        const projectIndex = projectIds.indexOf(projectId);
        return {
          projectId,
          directory: projectId,
          access: "write",
          path: join(home, `${groupId}-lane-${index + 1}-${projectId}`),
          branch: `${groupId}-lane-${index + 1}`,
          baseRef: commits[projectIndex],
          baseCommit: commits[projectIndex]
        };
      })
    }, now));
    const effective = laneWorkspaces.map((workspace, index) => resolveEffectiveLaunch({
      role: roles[index],
      purpose: "execution",
      workspace,
      workItemWriteProjectIds: writeProjectIds
    }));
    const assignment = createWorkItemExecutionAssignment({
      input: "Produce the same frozen result.",
      objective: item.objective,
      acceptance: item.acceptance,
      contextSnapshotRef: snapshotRef,
      taskId: task.id,
      workItemId,
      workItemRevision: item.revision,
      projects: writeProjectIds.map((projectId) => ({
        projectId,
        baseCommit: commits[projectIds.indexOf(projectId)]
      })),
      dependencyFacts: []
    });
    if (groupId === "execution-group-1") {
      assert.throws(() => createWorkItemExecutionGroup(
        "execution-group-too-wide",
        task.id,
        assignment,
        Array.from({ length: 9 }, (_, index) => ({
          roleName: `producer-${index + 1}`,
          effective: effective[0],
          workspace: {
            root: laneWorkspaces[0].root,
            writableProjectIds: writeProjectIds
          }
        })),
        now
      ), /at most 8 Lanes/u);
    }
    const group = createWorkItemExecutionGroup(groupId, task.id, assignment, roles.map((role, index) => ({
      roleName: role.name,
      effective: effective[index],
      workspace: { root: laneWorkspaces[index].root, writableProjectIds: writeProjectIds },
      currentRunId: index === 0 ? firstRunId : `${firstRunId}-sibling`
    })), now);
    const groupedItem = attachWorkItemExecutionGroup(item, group, now);
    store.saveWorkItem(task.id, groupedItem);
    store.saveManagedWorkspace(laneWorkspaces[0]);
    const run = createRun(
      firstRunId,
      task.id,
      roles[0].name,
      "new",
      runInput(firstRunId, task.id, roles[0].name, "Produce."),
      now,
      {
        workItemId,
        purpose: "execution",
        executionGroupId: groupId,
        executionLaneId: `${groupId}-lane-1`,
        workspace: laneWorkspaces[0],
        effective: effective[0]
      }
    );
    store.saveActiveExecutionLaneRun(run);
    return { item: groupedItem, run };
  };

  const incomplete = prepare("work-item-1", "execution-group-1", "turn-1");
  const rejected = store.transaction((tx) => terminalizeExactTaskRun(tx, {
    taskId: task.id,
    roleName: incomplete.run.roleName,
    agentId: incomplete.run.effective.agentId,
    runId: incomplete.run.id,
    outcome: {
      status: "completed",
      output: "# Result\n\nThe Agent claims everything passed."
    }
  }, new Date("2026-09-02T00:21:00.000Z")));
  assert.equal(rejected.run.status, "failed");
  assert.equal(rejected.run.result.failureReason, "workspace-unavailable");
  assert.equal(rejected.run.result.output, "# Result\n\nThe Agent claims everything passed.");
  assert.match(rejected.run.result.diagnostic, /could not freeze/u);

  const gitless = prepare("work-item-3", "execution-group-3", "turn-3", []);
  const rejectedGitless = store.transaction((tx) => terminalizeExactTaskRun(tx, {
    taskId: task.id,
    roleName: gitless.run.roleName,
    agentId: gitless.run.effective.agentId,
    runId: gitless.run.id,
    outcome: {
      status: "completed",
      output: "Unstructured result for a Lane with no writable Projects."
    }
  }, new Date("2026-09-02T00:21:30.000Z")));
  assert.equal(rejectedGitless.run.status, "completed");
  assert.equal(
    rejectedGitless.run.result.output,
    "Unstructured result for a Lane with no writable Projects."
  );
  assert.equal(rejectedGitless.run.result.systemEvidence, undefined);

  const complete = prepare("work-item-2", "execution-group-2", "turn-2");
  const accepted = store.transaction((tx) => terminalizeExactTaskRun(tx, {
    taskId: task.id,
    roleName: complete.run.roleName,
    agentId: complete.run.effective.agentId,
    runId: complete.run.id,
    outcome: {
      status: "completed",
      output: "{\"status\":\"pass\"}\nnot valid JSON after all"
    },
    systemEvidence: {
      workspaceSnapshot: {
        schemaVersion: 1,
        projects: projectIds.map((projectId, index) => ({
          projectId,
          headCommit: commits[index],
          branch: `execution-group-2-lane-1`
        }))
      }
    }
  }, new Date("2026-09-02T00:22:00.000Z")));
  assert.equal(accepted.run.status, "completed");
  assert.equal(accepted.run.result.output, "{\"status\":\"pass\"}\nnot valid JSON after all");
  assert.deepEqual(
    accepted.run.result.systemEvidence.workspaceSnapshot.projects.map(({ projectId }) => projectId),
    projectIds
  );

  const snapshotPath = join(home, "actual-lane-project");
  mkdirSync(snapshotPath, { recursive: true });
  execFileSync("git", ["init", "--initial-branch", "lane-main"], { cwd: snapshotPath });
  writeFileSync(join(snapshotPath, "result.txt"), "committed result\n");
  execFileSync("git", ["add", "result.txt"], { cwd: snapshotPath });
  execFileSync(
    "git",
    ["-c", "user.name=Yui Test", "-c", "user.email=yui@example.invalid", "commit", "-m", "result"],
    { cwd: snapshotPath }
  );
  const headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: snapshotPath,
    encoding: "utf8"
  }).trim();
  const actualWorkspace = createManagedWorkspace({
    owner: {
      type: "execution-lane",
      taskId: task.id,
      executionGroupId: "execution-group-actual",
      executionLaneId: "execution-group-actual-lane-1",
      purpose: "execution",
      workItemId: complete.item.id
    },
    root: join(home, "execution-group-actual-lane-1"),
    entries: [{
      projectId: projectIds[0],
      directory: projectIds[0],
      access: "write",
      path: snapshotPath,
      branch: "lane-main",
      baseRef: commits[0],
      baseCommit: commits[0]
    }]
  }, now);
  store.saveManagedWorkspace(actualWorkspace);
  assert.deepEqual(snapshotExecutionLaneWorkspaceSync(store, actualWorkspace), {
    status: "captured",
    snapshot: {
      schemaVersion: 1,
      projects: [{
        projectId: projectIds[0],
        headCommit,
        branch: "lane-main"
      }]
    }
  });
  writeFileSync(join(snapshotPath, "dirty.txt"), "not committed\n");
  const dirtySnapshot = snapshotExecutionLaneWorkspaceSync(store, actualWorkspace);
  assert.equal(dirtySnapshot.status, "failed");
  assert.equal(dirtySnapshot.cause, "workspace-dirty");
  rmSync(join(snapshotPath, "dirty.txt"));
  execFileSync("git", ["checkout", "-b", "wrong-lane"], { cwd: snapshotPath });
  const wrongBranchSnapshot = snapshotExecutionLaneWorkspaceSync(store, actualWorkspace);
  assert.equal(wrongBranchSnapshot.status, "failed");
  assert.equal(wrongBranchSnapshot.cause, "branch-mismatch");
});

test("runtime terminalization preserves Agent output across dirty and wrong-branch Lane failures", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-lane-result-preservation-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());

  const runCase = (ordinal, workspaceMutation, expectedReason) => {
    const startedAt = new Date(`2026-09-04T02:0${ordinal}:00.000Z`);
    const task = activateTask(createTask(
      `task-${ordinal}`,
      `Lane failure ${ordinal}`,
      startedAt,
      { cwd: home }
    ), startedAt);
    store.saveTask(task);
    const agent = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
    const role = createRole(
      task.id,
      "producer",
      [agent],
      agent.agentId,
      home,
      startedAt
    );
    store.saveRole(task.id, role);
    const secondaryRole = createRole(
      task.id,
      "producer-secondary",
      [agent],
      agent.agentId,
      home,
      startedAt
    );
    store.saveRole(task.id, secondaryRole);

    const projectId = "project-1";
    const workItemId = "work-item-1";
    const groupId = "execution-group-1";
    const laneId = `${groupId}-lane-1`;
    const runId = "turn-1";
    const repositoryPath = join(home, `lane-repository-${ordinal}`);
    mkdirSync(repositoryPath, { recursive: true });
    execFileSync("git", ["init", "--initial-branch", laneId], { cwd: repositoryPath });
    writeFileSync(join(repositoryPath, "result.txt"), "committed result\n");
    execFileSync("git", ["add", "result.txt"], { cwd: repositoryPath });
    execFileSync(
      "git",
      ["-c", "user.name=Yui Test", "-c", "user.email=yui@example.invalid", "commit", "-m", "result"],
      { cwd: repositoryPath }
    );
    const headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryPath,
      encoding: "utf8"
    }).trim();
    workspaceMutation(repositoryPath);

    const workspace = createManagedWorkspace({
      owner: {
        type: "execution-lane",
        taskId: task.id,
        executionGroupId: groupId,
        executionLaneId: laneId,
        purpose: "execution",
        workItemId
      },
      root: join(home, `${task.id}-${laneId}`),
      entries: [{
        projectId,
        directory: projectId,
        access: "write",
        path: repositoryPath,
        branch: laneId,
        baseRef: headCommit,
        baseCommit: headCommit
      }]
    }, startedAt);
    const effective = resolveEffectiveLaunch({
      role,
      purpose: "execution",
      workspace,
      workItemWriteProjectIds: [projectId]
    });
    const secondaryWorkspace = createManagedWorkspace({
      owner: {
        type: "execution-lane",
        taskId: task.id,
        executionGroupId: groupId,
        executionLaneId: `${groupId}-lane-2`,
        purpose: "execution",
        workItemId
      },
      root: join(home, `${task.id}-${groupId}-lane-2`),
      entries: [{
        projectId,
        directory: projectId,
        access: "write",
        path: repositoryPath,
        branch: laneId,
        baseRef: headCommit,
        baseCommit: headCommit
      }]
    }, startedAt);
    const secondaryEffective = resolveEffectiveLaunch({
      role: secondaryRole,
      purpose: "execution",
      workspace: secondaryWorkspace,
      workItemWriteProjectIds: [projectId]
    });
    let item = updateWorkItemStatus(createWorkItem(workItemId, task.id, {
      title: "Preserve the exact result",
      assignee: role.name,
      writeProjectIds: [projectId]
    }, startedAt), "open", startedAt);
    const assignment = createWorkItemExecutionAssignment({
      input: "Produce a result.",
      objective: item.objective,
      acceptance: item.acceptance,
      contextSnapshotRef: {
        schemaVersion: 1,
        id: "context-snapshot-1",
        taskId: task.id,
        scope: "task",
        sequence: 1,
        digest: "a".repeat(64)
      },
      taskId: task.id,
      workItemId,
      workItemRevision: item.revision,
      projects: [{ projectId, baseCommit: headCommit }],
      dependencyFacts: []
    });
    item = attachWorkItemExecutionGroup(item, createWorkItemExecutionGroup(
      groupId,
      task.id,
      assignment,
      [{
        roleName: role.name,
        effective,
        workspace: { root: workspace.root, writableProjectIds: [projectId] },
        currentRunId: runId
      }, {
        roleName: secondaryRole.name,
        effective: secondaryEffective,
        workspace: {
          root: secondaryWorkspace.root,
          writableProjectIds: [projectId]
        }
      }],
      startedAt
    ), startedAt);
    store.saveWorkItem(task.id, item);
    store.saveManagedWorkspace(workspace);
    const run = createRun(
      runId,
      task.id,
      role.name,
      "new",
      runInput(runId, task.id, role.name, "Produce a result."),
      startedAt,
      {
        workItemId,
        purpose: "execution",
        executionGroupId: groupId,
        executionLaneId: laneId,
        workspace,
        effective
      }
    );
    store.saveActiveExecutionLaneRun(run);

    const nativeSessionId = `session-${ordinal}`;
    const nativeTurnId = `native-run-${ordinal}`;
    const attemptId = `run:${task.id}/${run.id}`;
    let sessions = recordRoleAgentSession(createRoleSessionSet(
      { scope: "task", taskId: task.id, roleName: role.name },
      agent.agentId,
      startedAt
    ), {
      agentId: agent.agentId,
      adapterId: agent.adapterId,
      nativeSessionId,
      policy: "fixed",
      status: "active",
      effective
    }, startedAt);
    let provider = createProviderRuntimeBinding({
      providerNamespace: "openai/codex",
      accountScope: agent.agentId,
      conversationId: nativeSessionId,
      startedAt: startedAt.toISOString()
    });
    provider = beginProviderTurn(provider, {
      runId,
      attemptId,
      authorityEpoch: provider.authority.epoch,
      submittedAt: startedAt.toISOString()
    });
    provider = acceptProviderTurn(provider, {
      attemptId,
      nativeTurnId,
      acceptedAt: new Date(startedAt.getTime() + 1_000).toISOString()
    });
    sessions = bindTaskRoleProviderRuntime(sessions, provider, startedAt);
    store.saveTaskRoleSessionSet(sessions);

    const originalOutput = `\n# Agent result ${ordinal}\n\nThis text must survive.\n`;
    const observed = new FileSchedulerStoreAdapter(store).observeRuntimeRunTerminal({
      taskId: task.id,
      roleName: role.name,
      agentId: agent.agentId,
      adapterId: agent.adapterId,
      nativeSessionId,
      nativeTurnId,
      attemptId,
      runId,
      providerStatus: "completed",
      outcome: { status: "completed", output: originalOutput }
    }, new Date(startedAt.getTime() + 2_000));
    assert.equal(observed.run.status, "failed");
    assert.equal(observed.run.result.output, originalOutput);
    assert.equal(observed.run.result.failureReason, expectedReason);
    assert.ok(observed.run.result.diagnostic.length > 0);
  };

  runCase(
    1,
    (repositoryPath) => writeFileSync(join(repositoryPath, "dirty.txt"), "dirty\n"),
    "workspace-dirty"
  );
  runCase(
    2,
    (repositoryPath) => execFileSync("git", ["checkout", "-b", "wrong-lane"], {
      cwd: repositoryPath
    }),
    "workspace-branch-mismatch"
  );
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

test("Controller begin-handover accepts a null fromReleaseId", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-controller-null-handover-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  new SqliteTaskStore(home).close();
  const controller = await startControllerServer(home, undefined, undefined, {
    release: null,
    storageBackend: "sqlite",
    workerEnabled: false
  });
  try {
    const handoverId = "handover-null-from-release";
    const toReleaseId = `0.15.0-${"a".repeat(64)}`;
    const result = await callFileTaskController(home, "controller.begin-handover", {
      handoverId,
      fromReleaseId: null,
      toReleaseId
    });
    assert.equal(result.handoverId, handoverId);
    assert.equal(result.phase, "fenced");
    assert.equal(readHandoverFence(home).fromReleaseId, null);
    await callFileTaskController(home, "controller.rollback-handover", { handoverId });
  } finally {
    await controller.close();
    await controller.closed;
  }
});

test("production storage exposes one current version and one migration floor", () => {
  assert.equal(MIN_SUPPORTED_STORAGE_VERSION, 1);
  assert.equal(CURRENT_STORAGE_VERSION, 27);
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
  assert.equal(existsSync(join(home, "schema.json")), false);
  assert.ok(existsSync(join(home, "yui.db")));
  const database = new Database(join(home, "yui.db"), { readonly: true });
  try {
    assert.deepEqual(
      database.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      Array.from({ length: CURRENT_STORAGE_VERSION }, (_, index) => ({ version: index + 1 }))
    );
    // The storage 18->19 migration retires the DB-owned immutable Artifact
    // table: file/directory artifacts now live in each Task's local Git repo.
    // A fresh Home runs v5 (which creates `artifacts`) and then v19 (which drops
    // it), so the initialized authority must NOT expose the retired table. This
    // locks the "no dual DB-Artifact/Git read/write surface" contract end-to-end
    // through the real runner, not only through the direct migration regression.
    assert.deepEqual(
      database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'"
      ).all(),
      []
    );
    assert.deepEqual(
      database.prepare("PRAGMA table_info(schema_migrations)").all().map(({ name }) => name),
      ["version", "name", "applied_at", "checksum"]
    );
    const homeMetaColumns = database
      .prepare("PRAGMA table_info(home_meta)")
      .all()
      .map(({ name }) => name);
    assert.equal(homeMetaColumns.includes("layout_version"), false);
    assert.equal(homeMetaColumns.includes("aggregate_version"), false);
  } finally {
    database.close();
  }
});

test("Task Role Profiles preserve runtime and portable behavior across add and update", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-role-profile-update-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-09-03T06:10:00.000Z");
  const task = activateTask(createTask("task-1", "Update one Role binding", now, {
    cwd: home
  }), now);
  store.saveTask(task);
  const codex = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  const claude = createConfiguredAgent("claude", "claude", "claude", [], [], now);
  store.saveConfiguredAgent(codex);
  store.saveConfiguredAgent(claude);
  const workerBinding = createRoleAgentBinding(codex, {
    adapterId: "codex",
    permission: {
      strategy: "configured",
      sandbox: "workspace-write",
      approval: "on-request"
    },
    model: "worker-model",
    effort: "medium",
    search: true
  });
  store.saveGlobalRole(createGlobalRole(
    "worker",
    [workerBinding],
    workerBinding.agentId,
    home,
    now
  ));
  const codexProfile = createAgentProfile({
    id: "profile-codex",
    runtime: {
      source: "explicit",
      agentId: codex.id,
      model: "profile-model",
      effort: "high"
    }
  }, now);
  const claudeProfile = createAgentProfile({
    id: "profile-claude",
    runtime: {
      source: "explicit",
      agentId: claude.id,
      model: "claude-model"
    }
  }, now);
  const inheritedProfile = createAgentProfile({
    id: "profile-inherited",
    defaultAccess: "write",
    description: "Portable inherited behavior",
    runtime: { source: "global-worker" }
  }, now);
  store.saveAgentProfile(codexProfile);
  store.saveAgentProfile(claudeProfile);
  store.saveAgentProfile(inheritedProfile);
  const role = createRole(
    task.id,
    "runner",
    [workerBinding],
    workerBinding.agentId,
    home,
    now
  );
  store.saveRole(task.id, role);

  const addWithProfileRuntime = [
    "role", "add", task.id, "profile-runner",
    "--profile", codexProfile.id,
    "--agent", codex.id,
    "--effort", "low"
  ];
  assert.deepEqual(
    previewTaskRoleAgentConfigurationMutation(addWithProfileRuntime, store),
    {
      agentId: codex.id,
      config: {
        ...workerBinding.config,
        model: "profile-model",
        effort: "low"
      },
      cwd: home
    }
  );
  runTaskCommand(addWithProfileRuntime, store, {
    now: () => new Date("2026-09-03T06:10:05.000Z"),
    environment: bareEnv
  });
  const added = store.getRole(task.id, "profile-runner");
  assert.equal(added.activeAgentId, codex.id);
  assert.deepEqual(added.agentBindings[codex.id].config, {
    ...workerBinding.config,
    model: "profile-model",
    effort: "low"
  });

  const implicitOtherAgent = [
    "role", "update", task.id, role.name, "--profile", claudeProfile.id
  ];
  assert.throws(
    () => previewTaskRoleAgentConfigurationMutation(implicitOtherAgent, store),
    /Agent Profile profile-claude resolves to Agent claude.*active Agent codex.*--agent claude/u
  );
  assert.throws(
    () => runTaskCommand(implicitOtherAgent, store, {
      now: () => new Date("2026-09-03T06:10:10.000Z"),
      environment: bareEnv
    }),
    /Agent Profile profile-claude resolves to Agent claude.*active Agent codex.*--agent claude/u
  );
  assert.deepEqual(store.getRole(task.id, role.name), role);

  const mergeProfileRuntime = [
    "role", "update", task.id, role.name,
    "--profile", codexProfile.id,
    "--agent", codex.id,
    "--effort", "low"
  ];
  assert.deepEqual(
    previewTaskRoleAgentConfigurationMutation(mergeProfileRuntime, store),
    {
      agentId: codex.id,
      config: {
        ...workerBinding.config,
        model: "profile-model",
        effort: "low"
      },
      cwd: home
    }
  );
  runTaskCommand(mergeProfileRuntime, store, {
    now: () => new Date("2026-09-03T06:10:20.000Z"),
    environment: bareEnv
  });
  assert.equal(store.getRole(task.id, role.name).activeAgentId, codex.id);
  assert.deepEqual(
    store.getRole(task.id, role.name).agentBindings[codex.id].config,
    {
      ...workerBinding.config,
      model: "profile-model",
      effort: "low"
    }
  );

  const updateInactiveBinding = [
    "role", "update", task.id, role.name,
    "--profile", claudeProfile.id,
    "--agent", claude.id
  ];
  assert.deepEqual(
    previewTaskRoleAgentConfigurationMutation(updateInactiveBinding, store),
    {
      agentId: claude.id,
      config: {
        adapterId: "claude",
        permission: { strategy: "bypass" },
        model: "claude-model"
      },
      cwd: home
    }
  );
  runTaskCommand(updateInactiveBinding, store, {
    now: () => new Date("2026-09-03T06:10:30.000Z"),
    environment: bareEnv
  });
  const updated = store.getRole(task.id, role.name);
  assert.equal(updated.activeAgentId, codex.id);
  assert.deepEqual(updated.agentBindings[claude.id].config, {
    adapterId: "claude",
    permission: { strategy: "bypass" },
    model: "claude-model"
  });

  const claudeBinding = createRoleAgentBinding(claude, {
    adapterId: "claude",
    permission: {
      strategy: "configured",
      mode: "acceptEdits"
    },
    model: "existing-claude-model",
    effort: "medium"
  });
  const portableRole = createRole(
    task.id,
    "portable",
    [claudeBinding],
    claude.id,
    home,
    now
  );
  store.saveRole(task.id, portableRole);
  // Explicit reapplication resolves the template's current runtime defaults.
  // Target its Codex binding without silently switching this Claude Role.
  const applyInheritedProfile = [
    "role", "update", task.id, portableRole.name,
    "--profile", inheritedProfile.id, "--agent", codex.id
  ];
  assert.deepEqual(
    previewTaskRoleAgentConfigurationMutation(applyInheritedProfile, store),
    { agentId: codex.id, config: workerBinding.config, cwd: home }
  );
  runTaskCommand(applyInheritedProfile, store, {
    now: () => new Date("2026-09-03T06:10:40.000Z"),
    environment: bareEnv
  });
  const portableUpdated = store.getRole(task.id, portableRole.name);
  assert.equal(portableUpdated.activeAgentId, claude.id);
  assert.deepEqual(portableUpdated.agentBindings, {
    ...portableRole.agentBindings, [codex.id]: workerBinding
  });
  assert.equal(portableUpdated.description, "Portable inherited behavior");
  assert.equal(portableUpdated.defaultAccess, "write");

  const claudeWorkerBinding = createRoleAgentBinding(claude, {
    adapterId: "claude",
    permission: { strategy: "bypass" },
    model: "worker-claude-model",
    effort: "max"
  });
  store.saveGlobalRole(createGlobalRole(
    "worker",
    [workerBinding, claudeWorkerBinding],
    claude.id,
    home,
    new Date("2026-09-03T06:10:50.000Z")
  ));
  runTaskCommand(
    ["role", "add", task.id, "dormant-worker-profile", "--profile", codexProfile.id],
    store,
    { now: () => new Date("2026-09-03T06:11:00.000Z"), environment: bareEnv }
  );
  assert.deepEqual(
    store.getRole(task.id, "dormant-worker-profile").agentBindings[codex.id].config,
    {
      ...workerBinding.config,
      model: "profile-model",
      effort: "high"
    }
  );
});

test("a pre-0.15.0 Home stays outside the migration floor and remains untouched", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-pre-baseline-storage-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const databasePath = join(home, "yui.db");
  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TABLE schema_migrations (
        version     INTEGER PRIMARY KEY,
        axis        TEXT NOT NULL CHECK (axis IN ('layout','aggregate','record')),
        record_kind TEXT,
        applied_at  TEXT NOT NULL,
        checksum    TEXT NOT NULL
      );
      CREATE TABLE home_meta (
        id                INTEGER PRIMARY KEY CHECK (id = 1),
        home_identity     TEXT NOT NULL,
        revision          INTEGER NOT NULL,
        layout_version    INTEGER NOT NULL,
        aggregate_version INTEGER NOT NULL,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
    `);
    database.prepare(
      `INSERT INTO schema_migrations
       (version, axis, record_kind, applied_at, checksum)
       VALUES (1, 'layout', NULL, ?, ?)`
    ).run("2026-09-04T00:00:00.000Z", "pre-0.15.0-ledger");
    database.prepare(
      `INSERT INTO home_meta
       (id, home_identity, revision, layout_version, aggregate_version, created_at, updated_at)
       VALUES (1, ?, ?, 8, 2, ?, ?)`
    ).run(
      JSON.stringify({ schemaVersion: 1, id: "legacy-home" }),
      0,
      "2026-09-04T00:00:00.000Z",
      "2026-09-04T00:00:00.000Z"
    );
  } finally {
    database.close();
  }
  const manifestPath = join(home, "schema.json");
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    storageVersion: 8,
    aggregateSchemaVersion: 31,
    recordVersions: {},
    updatedAt: "2026-09-04T00:00:00.000Z"
  }));

  const before = readFileSync(databasePath);
  const inspected = inspectStorageSchema(home);
  assert.equal(inspected.status, "unsupported");
  assert.equal(inspected.direction, "older");
  assert.equal(inspected.currentVersion, 0);
  assert.equal(inspected.latestVersion, CURRENT_STORAGE_VERSION);

  const dryRun = await runStorageUpgrade({ home, mode: "dry-run" });
  assert.equal(dryRun.outcome, "blocked");
  assert.equal(dryRun.stage, "unsupported");
  assert.equal(dryRun.sceneUnchanged, true);
  assert.match(dryRun.action, /initialize a new Home/u);
  assert.deepEqual(readFileSync(databasePath), before);
  assert.equal(existsSync(manifestPath), true);
});

test("an existing SQLite Home with missing singleton rows fails closed", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-missing-sqlite-singletons-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  new SqliteTaskStore(home).close();
  const database = new Database(join(home, "yui.db"));
  try {
    database.prepare("DELETE FROM home_meta WHERE id = 1").run();
    database.prepare("DELETE FROM config WHERE id = 1").run();
  } finally {
    database.close();
  }
  assert.throws(
    () => new SqliteTaskStore(home),
    (error) => error instanceof StorageSchemaError
      && error.code === "STORAGE_SCHEMA_INVALID"
      && /home_meta/u.test(error.message)
      && /config/u.test(error.message)
  );
});

test("fresh SQLite telemetry persists and aggregates by Turn", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-turn-telemetry-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const business = new SqliteTaskStore(home);
  business.close();
  const telemetry = new SqliteTelemetryStore(home, { runCap: 2 });
  t.after(() => telemetry.close());
  telemetry.observe({
    taskId: "task-1",
    roleName: "worker",
    runId: "turn-1",
    progressId: "progress-1",
    sequence: 1,
    payload: { kind: "activity" },
    receivedAt: "2026-08-31T03:00:00.000Z"
  });
  telemetry.observe({
    taskId: "task-1",
    roleName: "worker",
    runId: "turn-1",
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
  assert.equal(telemetry.listRunAggregates("task-1")[0].runId, "turn-1");
});

test("the built-in Agent Drivers are available through the shared registry", () => {
  assert.equal(execFileSync(join(root, "dist", "runtime", "claude-process-owner"),
    [process.execPath, "-e", "process.stdout.write('owner-ready')"], { encoding: "utf8" }), "owner-ready");
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
    assert.deepEqual(observations, []);

    const completed = drivers.requireByAdapterId(adapterId).runtime.mapHook({
      hookEventName: "Stop",
      payload: { summary: "Not the final Agent result." },
      occurrenceId: "hook-2"
    });
    const terminal = (Array.isArray(completed) ? completed : [completed])
      .find(({ kind }) => kind === "turn.completed");
    assert.equal(terminal.payload.output, undefined);
    assert.equal(
      terminal.payload.resultTransportDiagnostic,
      "Provider terminal event did not include an Agent result."
    );

    const boundary = "x".repeat(MAX_RUN_RESULT_OUTPUT_BYTES);
    const oversized = drivers.requireByAdapterId(adapterId).runtime.mapHook({
      hookEventName: "Stop",
      payload: { last_assistant_message: `${boundary}x` },
      occurrenceId: "hook-3"
    });
    const oversizedTerminal = (Array.isArray(oversized) ? oversized : [oversized])
      .find(({ kind }) => kind === "turn.completed");
    assert.equal(oversizedTerminal.payload.output, undefined);
    assert.match(oversizedTerminal.payload.resultTransportDiagnostic, /524289 bytes/u);
    assert.match(
      oversizedTerminal.payload.resultTransportDiagnostic,
      /524288-byte durable result limit/u
    );
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
  let startedRuns = 0;
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
    markOperatorRunStarted: () => {
      startedRuns += 1;
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
  assert.equal(startedRuns, 1);
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
  assert.equal(startedRuns, 1);
  assert.equal(mailbox.processing, null);
  assert.notEqual(mailbox.pending, null);
});

test("the async runtime observer preserves terminal classification", async () => {
  const calls = [];
  const observer = createAsyncRuntimeObserver(async (method) => {
    calls.push(method);
    return method === "classifyGlobalRuntimeRunTerminal" ? "apply" : "deferred";
  });

  assert.equal(await observer.classifyRuntimeRunTerminal({}), "deferred");
  assert.equal(await observer.classifyGlobalRuntimeRunTerminal({}), "apply");
  assert.deepEqual(calls, [
    "classifyRuntimeRunTerminal",
    "classifyGlobalRuntimeRunTerminal"
  ]);
});

test("Claude global Stop hooks publish the native completion boundary", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-claude-global-hook-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let signal;
  await runRuntimeObservationHookCommand(JSON.stringify({
    hook_event_name: "Stop",
    session_id: "claude-session-1",
    last_assistant_message: "\nDone.\n"
  }), {
    YUI_SESSION_SCOPE: "global",
    YUI_HOME: home,
    YUI_DRIVER_ID: "anthropic/claude-code",
    YUI_ADAPTER_ID: "claude",
    YUI_ROLE: "operator",
    YUI_AGENT_ID: "claude",
    YUI_NATIVE_SESSION_ID: "claude-session-1"
  }, async (_home, _method, params) => {
    signal = params;
    return null;
  }, new Date("2026-08-28T00:00:00.000Z"), { sequence: () => 1 });

  const [event] = new FileRuntimeEventInbox(home).list();
  assert.equal(event.type, "native-turn-terminal");
  assert.equal(event.scope, "global");
  assert.equal(event.adapterId, "claude");
  assert.deepEqual(event.outcome, { status: "completed", output: "\nDone.\n" });
  assert.deepEqual(signal, { key: "global-role:operator" });
});

test("native terminal ingress preserves valid output and durably fails missing or oversized output", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-native-terminal-output-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const inbox = new FileRuntimeEventInbox(home);
  const base = {
    scope: "task",
    taskId: "task-1",
    roleName: "worker",
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "session-1",
    providerStatus: "completed"
  };
  const boundary = "x".repeat(MAX_RUN_RESULT_OUTPUT_BYTES);
  const accepted = inbox.enqueueRunTerminal({
    ...base,
    nativeTurnId: "native-turn-1",
    runId: "turn-1",
    outcome: { status: "completed", output: boundary }
  }).event;
  assert.equal(accepted.outcome.status, "completed");
  assert.equal(accepted.outcome.output, boundary);

  const oversized = inbox.enqueueRunTerminal({
    ...base,
    nativeTurnId: "native-turn-2",
    runId: "turn-2",
    outcome: {
      status: "completed",
      output: `${boundary}x`
    }
  }).event;
  assert.equal(oversized.outcome.status, "failed");
  assert.equal(oversized.outcome.failureReason, "runtime-failed");
  assert.equal(oversized.outcome.output, undefined);
  assert.match(oversized.outcome.diagnostic, /524289 bytes/u);
  assert.match(oversized.outcome.diagnostic, /524288-byte durable result limit/u);

  const missing = inbox.enqueueRunTerminal({
    ...base,
    nativeTurnId: "native-turn-3",
    runId: "turn-3",
    outcome: { status: "completed", output: null }
  }).event;
  assert.deepEqual(missing.outcome, {
    status: "failed",
    diagnostic: "Provider terminal event did not include an Agent result.",
    failureReason: "missing-result"
  });

  const longDiagnostic = `failed:${"🔥".repeat(20_000)}`;
  const failed = inbox.enqueueRunTerminal({
    ...base,
    nativeTurnId: "native-turn-4",
    runId: "turn-4",
    providerStatus: "failed",
    outcome: {
      status: "failed",
      diagnostic: longDiagnostic,
      failureReason: "runtime-failed"
    }
  }).event;
  assert.equal(failed.outcome.status, "failed");
  assert.ok(Buffer.byteLength(failed.outcome.diagnostic, "utf8") <= 16 * 1024);
  assert.ok(longDiagnostic.startsWith(failed.outcome.diagnostic));

  assert.throws(() => inbox.enqueueRunTerminal({
    ...base,
    nativeTurnId: "native-turn-5",
    runId: "turn-5",
    providerStatus: "failed",
    outcome: { status: "completed", output: "Contradictory success." }
  }), /Only a completed Provider Turn/u);
  assert.equal(inbox.list().length, 4);
});

test("managed Session authority follows durable state, not a frozen environment", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-managed-caller-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-09-03T00:00:00.000Z");
  const workspace = join(home, "main");
  const task = activateTask(createTask("task-1", "Outlive a control-plane change", now), now);
  store.saveTask(task);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const role = createRole(task.id, "leader", [binding], binding.agentId, workspace, now);
  store.saveRole(task.id, role);
  const sessions = recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: task.id, roleName: role.name },
    binding.agentId,
    now
  ), {
    agentId: binding.agentId,
    adapterId: binding.adapterId,
    nativeSessionId: "native-session-1",
    policy: "fixed",
    status: "active",
    effective: resolveEffectiveLaunch({ role, purpose: "execution" })
  }, now);
  store.saveTaskRoleSessionSet(sessions);

  // A native pane's environment is frozen at launch. It names only the
  // process's own immutable identity: no Turn, no runtime generation, and no
  // descriptor path that a Yui upgrade or workspace move could invalidate.
  const environment = {
    YUI_SESSION_SCOPE: "task",
    YUI_HOME: home,
    YUI_TASK_ID: task.id,
    YUI_ROLE: role.name,
    YUI_WORKSPACE: workspace,
    CODEX_THREAD_ID: "native-session-1"
  };

  const betweenRuns = resolveManagedTaskCaller(store, environment);
  assert.equal(betweenRuns.agentId, "codex");
  assert.equal(betweenRuns.adapterId, "codex");
  assert.equal(betweenRuns.currentRunId, undefined);
  assert.equal(taskLocalActor(store, environment, task.id), "leader");

  store.saveActiveRun(createRun(
    "turn-7",
    task.id,
    role.name,
    "new",
    runInput("turn-7", task.id, role.name, "Do the work."),
    now,
    { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) }
  ));

  // The same unchanged environment now reports the current Turn, so a Turn
  // advance can never strand a live Session.
  assert.equal(resolveManagedTaskCaller(store, environment).currentRunId, "turn-7");
  assert.equal(taskLocalActor(store, environment, task.id), "leader");

  // A caller naming another Session cannot act as this Role.
  assert.throws(
    () => resolveManagedTaskCaller(store, { ...environment, CODEX_THREAD_ID: "other-session" }),
    /no longer the current runtime of task-1\/leader/u
  );
  assert.throws(() => taskLocalActor(store, {
    ...environment, CODEX_THREAD_ID: "other-session"
  }, task.id));
});

test("a Turn Context Pack reports which of the Task's records are in flight", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-live-task-state-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const now = new Date("2026-09-03T00:00:00.000Z");
  const workspace = join(home, "main");
  const task = activateTask(createTask("task-1", "Report in-flight execution", now), now);
  store.saveTask(task);
  const binding = createRoleAgentBinding({ id: "codex", adapterId: "codex" });
  const leader = createRole(task.id, "leader", [binding], binding.agentId, workspace, now);
  store.saveRole(task.id, leader);
  const reviewer = createRole(task.id, "final-reviewer", [binding], binding.agentId, workspace, now);
  store.saveRole(task.id, reviewer);
  const worker = createRole(task.id, "worker", [binding], binding.agentId, workspace, now);
  store.saveRole(task.id, worker);
  store.saveActiveRun(createRun(
    "turn-22",
    task.id,
    leader.name,
    "resume",
    runInput("turn-22", task.id, leader.name, "Finish the Task."),
    now,
    { effective: resolveEffectiveLaunch({ role: leader, purpose: "execution" }) }
  ));

  // Alone, the Leader sees only itself in flight.
  const alone = buildRunContextPack(store, task.id, "turn-22");
  assert.deepEqual(alone.liveTaskState.activeTaskReviews, []);
  assert.deepEqual(alone.liveTaskState.activeRuns.map((entry) => entry.runId), ["turn-22"]);

  // Another Role starts executing while the Leader Turn runs on.
  store.saveActiveRun(createRun(
    "turn-21",
    task.id,
    worker.name,
    "new",
    runInput("turn-21", task.id, worker.name, "Land the remaining change."),
    now,
    { effective: resolveEffectiveLaunch({ role: worker, purpose: "execution" }) }
  ));

  // The Pack already carried peer Turns as readable refs, but a ref is a
  // pointer with no status: it cannot tell the Leader that turn-21 is still
  // running. That is what this block adds.
  const peer = buildRunContextPack(store, task.id, "turn-22");
  assert.deepEqual(
    peer.liveTaskState.activeRuns.map((entry) => entry.runId).sort(),
    ["turn-21", "turn-22"]
  );
  assert.equal(peer.liveTaskState.activeRuns.length, 2);

  // A requested Task-final Review is the blocker a Leader must not miss before
  // it treats the Task as finishable.
  store.saveReviewRound(task.id, createTaskReviewRound(
    "review-round-6",
    task.id,
    reviewer.name,
    "leader",
    { schemaVersion: 1, projects: [{ projectId: "project-1", commit: "f".repeat(40) }] },
    now
  ));
  const during = buildRunContextPack(store, task.id, "turn-22");
  assert.deepEqual(during.liveTaskState.activeTaskReviews, [{
    reviewRoundId: "review-round-6",
    reviewerRoleName: "final-reviewer",
    status: "pending"
  }]);
});
