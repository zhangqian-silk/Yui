import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { listPublicCommandPaths } from "../../dist/cli/commandCatalog.js";
import {
  assertRegistryCoversBaselineToCurrent,
  createProductionRegistry
} from "../../dist/storage/migration/index.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { moveSqliteFileSet } from "../../dist/storage/upgrade/sqliteFileSet.js";
import { createProject } from "../../dist/repository/project.js";
import { createPublicationReference } from "../../dist/task/publicationReference.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createDecision } from "../../dist/decision/decision.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { builtinAgentDriverRegistry } from "../../dist/runtime/builtinAgentDrivers.js";
import { validateAgentLaunchConfiguration } from "../../dist/executor/agentConfigurationCatalog.js";
import { resolveAgentAdapter } from "../../dist/executor/agentAdapter.js";
import { runExecutionAudit } from "../../dist/observability/executionAudit.js";
import { createAgentRun, failAgentRun, yieldAgentRun } from "../../dist/run/agentRun.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import {
  bindTaskRoleProviderRuntime,
  bindTaskRoleRun,
  clearTaskRoleRun,
  createRoleSessionSet,
  recordRoleAgentSession,
  updateRoleAgentSessionStatus
} from "../../dist/executor/agentExecutor.js";
import {
  inspectTaskRoleRuntimeStatuses,
  renderTaskRoleRuntimeStatus
} from "../../dist/commands/taskRoleRuntimeStatus.js";
import {
  createSessionLaunchRequest,
  RuntimeLaunchFailure,
  TmuxSessionHost
} from "../../dist/runtime/index.js";
import { runtimeObservationSemanticKey } from "../../dist/runtime/runtimeObservation.js";
import { createPromptEnvelope } from "../../dist/runtime/promptEnvelope.js";
import {
  ProviderConversationMissingError,
  ProviderDeliveryUnknownError,
  ProviderTurnRejectedError,
  startStructuredProviderSession
} from "../../dist/runtime/structuredProviderHost.js";
import {
  CodexAppServerRuntime,
  CodexAppServerRequestError,
  acceptProviderTurn,
  beginProviderTurn,
  codexNotificationBoundary,
  codexAppServerErrorIsMissing,
  createRuntimeBinding,
  createProviderRuntimeBinding,
  currentProviderAuthority,
  decideProviderRecovery,
  endProviderActivation,
  FencedProviderControl,
  markProviderTurnDeliveryUnknown,
  rebindProviderRuntimeRun,
  settleProviderTurn,
  startProviderActivation,
  transferProviderAuthority
} from "../../dist/runtime/index.js";
import {
  createWorkMailbox,
  enqueueSignal,
  nextPendingBatch
} from "../../dist/coordination/workMailbox.js";
import {
  prepareProviderRetryDispatch,
  scheduleProviderRetry,
  serializeProviderRetryEnvelope
} from "../../dist/run/providerRetry.js";
import { SqliteTelemetryStore } from "../../dist/telemetry/sqliteTelemetryStore.js";

const root = resolve(import.meta.dirname, "../..");

// Strip managed Task runtime descriptors so the packaged CLI is exercised
// directly instead of being refused by the exact control-plane guard.
const bareEnv = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? ""
};

test("the packaged CLI starts and exposes the core workflow", () => {
  const help = execFileSync(process.execPath, [join(root, "dist", "cli.js"), "help"], {
    cwd: root,
    encoding: "utf8",
    env: bareEnv
  });
  assert.match(help, /Yui/u);
  const commands = listPublicCommandPaths();
  for (const command of ["setup", "update", "upgrade", "task create", "task list"]) {
    assert.ok(commands.includes(command), `missing core command: ${command}`);
  }
  for (const command of ["task role view", "task role takeover", "task role release"]) {
    assert.ok(commands.includes(command), `missing Provider authority command: ${command}`);
  }
  assert.equal(commands.includes("task enter"), false);
  assert.equal(commands.includes("task role enter"), false);
});

test("the SQLite Task path persists one normal Task and Message", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-core-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date("2026-08-20T00:00:00.000Z");
  const store = new SqliteTaskStore(home);
  const task = activateTask(createTask(store.nextTaskId(), "Core smoke", now), now);
  store.saveTask(task);
  const message = createTaskMessage(
    store.nextMessageId(task.id),
    task.id,
    "Keep the core path healthy.",
    "user",
    { type: "user" },
    now,
    { wakePolicy: "leader" }
  );
  store.saveMessage(task.id, message);
  store.close();

  const reopened = new SqliteTaskStore(home);
  assert.equal(reopened.getTask(task.id)?.status, "active");
  assert.deepEqual(reopened.listMessages(task.id), [message]);
  reopened.close();
});

test("a SQLite switch backs up the database and its live WAL file set", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-sqlite-switch-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = join(home, "yui.db");
  const backup = join(home, "yui.db.backup");
  writeFileSync(source, "database");
  writeFileSync(`${source}-wal`, "wal");
  writeFileSync(`${source}-shm`, "shm");

  moveSqliteFileSet(source, backup);

  assert.equal(existsSync(source), false);
  assert.equal(existsSync(`${source}-wal`), false);
  assert.equal(existsSync(`${source}-shm`), false);
  assert.equal(readFileSync(backup, "utf8"), "database");
  assert.equal(readFileSync(`${backup}-wal`, "utf8"), "wal");
  assert.equal(readFileSync(`${backup}-shm`, "utf8"), "shm");
});

test("the SQLite publication path records an external MR reference", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-core-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date("2026-08-22T00:00:00.000Z");
  const store = new SqliteTaskStore(home);
  const project = createProject(
    "project-1",
    "app",
    home,
    { stable: "master", development: "master" },
    now
  );
  const task = activateTask(createTask(store.nextTaskId(), "Publication smoke", now, {
    projectBindings: [{ projectId: project.id, directory: "app", baseRef: "master" }]
  }), now);
  store.saveProject(project);
  store.saveTask(task);
  const reference = createPublicationReference(
    store.nextPublicationReferenceId(task.id),
    task.id,
    {
      projectId: project.id,
      provider: "gitlab",
      repository: "team/app",
      externalKind: "merge-request",
      externalId: "179",
      externalUrl: "https://example.invalid/team/app/-/merge_requests/179",
      title: "Ship publication trace",
      sourceBranch: "feature/publication-trace",
      targetBranch: "master",
      localCommit: "0123456789abcdef0123456789abcdef01234567",
      remoteCommit: "fedcba9876543210fedcba9876543210fedcba98",
      state: "merged",
      verification: "verified",
      mergedAt: "2026-08-22T01:02:03.000Z"
    },
    now
  );
  store.savePublicationReference(task.id, reference);
  store.close();

  const reopened = new SqliteTaskStore(home);
  const loaded = reopened.getPublicationReference(task.id, reference.id);
  assert.equal(loaded?.title, "Ship publication trace");
  assert.equal(loaded?.sourceBranch, "feature/publication-trace");
  assert.equal(loaded?.targetBranch, "master");
  assert.equal(loaded?.mergedAt, "2026-08-22T01:02:03.000Z");
  assert.equal(loaded?.state, "merged");
  assert.equal(loaded?.verification, "verified");
  assert.equal(
    reopened.findPublicationReferenceByExternalKey("gitlab/team/app/179")?.id,
    reference.id
  );
  assert.deepEqual(reopened.listPublicationReferences(task.id), [reference]);
  reopened.close();
});

test("the Knowledge promotion flow proposes, accepts, deduplicates, and gates Agents", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-core-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date("2026-08-22T00:00:00.000Z");
  const store = new SqliteTaskStore(home);
  const project = createProject(
    "project-1",
    "app",
    home,
    { stable: "master", development: "master" },
    now
  );
  const task = activateTask(createTask(store.nextTaskId(), "Promotion smoke", now, {
    projectBindings: [{ projectId: project.id, directory: "app", baseRef: "master" }]
  }), now);
  store.saveProject(project);
  store.saveTask(task);
  store.saveDecision(task.id, createDecision(
    store.nextDecisionId(task.id),
    task.id,
    "D-01 freeze",
    "The two-layer orchestration RFC is frozen.",
    now
  ));

  const leaderEnv = {
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: task.id,
    YUI_ROLE: "leader"
  };

  // A Leader may propose a candidate for its own Task but cannot write the
  // authoritative Knowledge list directly.
  const proposed = await runProjectCommand(
    ["knowledge", "propose", "project-1", "--title", "Two-layer orchestration",
     "--body", "The Leader owns protocol convergence.", "--task", task.id,
     "--decision", "decision-1"],
    store,
    { environment: leaderEnv, now: () => now }
  );
  assert.match(proposed.output, /Proposed knowledge proposal-1/);
  await assert.rejects(
    () => runProjectCommand(
      ["knowledge", "add", "project-1", "Sneaky", "--body", "bypass"],
      store,
      { environment: leaderEnv, now: () => now }
    ),
    /Operator authority/
  );

  // The Operator accepts; the Knowledge entry carries source provenance.
  const accepted = await runProjectCommand(
    ["knowledge", "accept", "project-1", "proposal-1"],
    store,
    { now: () => now }
  );
  assert.match(accepted.output, /Accepted knowledge proposal proposal-1 as knowledge-1/);
  const withKnowledge = store.getProject("project-1");
  const knowledge = withKnowledge.knowledge.find(({ id }) => id === "knowledge-1");
  assert.equal(knowledge?.title, "Two-layer orchestration");
  assert.equal(knowledge?.provenance?.taskId, task.id);
  assert.equal(knowledge?.provenance?.decisionId, "decision-1");
  assert.equal(knowledge?.provenance?.proposalId, "proposal-1");
  assert.ok(knowledge?.provenance?.evidenceDigest);

  // Resubmitting the same candidate is deduplicated to the existing entry.
  const duplicate = await runProjectCommand(
    ["knowledge", "propose", "project-1", "--title", "Two-layer orchestration",
     "--body", "The Leader owns protocol convergence.", "--task", task.id,
     "--decision", "decision-1"],
    store,
    { now: () => now }
  );
  assert.match(duplicate.output, /Already accepted as knowledge knowledge-1/);
  assert.equal(store.getProject("project-1").knowledge.length, 1);

  // A conflicting candidate (same title, different body) fails closed on
  // accept instead of silently overwriting the existing entry.
  await runProjectCommand(
    ["knowledge", "propose", "project-1", "--title", "Two-layer orchestration",
     "--body", "A conflicting conclusion.", "--task", task.id],
    store,
    { now: () => now }
  );
  await assert.rejects(
    () => runProjectCommand(
      ["knowledge", "accept", "project-1", "proposal-2"],
      store,
      { now: () => now }
    ),
    /same title but a different conclusion/
  );
  store.close();
});

test("the production migration graph advances the normal aggregate path", () => {
  const registry = createProductionRegistry();
  assert.doesNotThrow(() => assertRegistryCoversBaselineToCurrent(registry));
  const step = registry.lookup("aggregate", undefined, 18);
  assert.notEqual(step, undefined);
  const source = {
    schemaManifest: { aggregateSchemaVersion: 18 },
    state: { schemaVersion: 18, tasks: {} }
  };
  step.preconditions(source);
  const migrated = step.transform(source);
  assert.equal(migrated.schemaManifest.aggregateSchemaVersion, 19);
  assert.equal(migrated.state.schemaVersion, 19);

  const currentStep = registry.lookup("aggregate", undefined, 19);
  assert.notEqual(currentStep, undefined);
  const currentSource = {
    schemaManifest: { aggregateSchemaVersion: 19 },
    state: { schemaVersion: 19, tasks: {} }
  };
  currentStep.preconditions(currentSource);
  const current = currentStep.transform(currentSource);
  assert.equal(current.schemaManifest.aggregateSchemaVersion, 20);
  assert.equal(current.state.schemaVersion, 20);

  // Issue 12: the Project v3->v4 compatible normalizer adds the
  // knowledgeProposals workflow list without rewriting any other field.
  const projectStep = registry.lookupDeclaration("record", "project", 3);
  assert.notEqual(projectStep, undefined);
  const v3Project = {
    schemaVersion: 3,
    id: "project-1",
    name: "app",
    aliases: [],
    path: "/tmp/app",
    ownership: "external",
    stableBranch: "master",
    developmentBranch: "master",
    knowledge: [],
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z"
  };
  const projectSnapshot = {
    schemaManifest: {
      schemaVersion: 1,
      storageVersion: 7,
      aggregateSchemaVersion: 20,
      recordVersions: { project: 3 },
      updatedAt: "2026-08-22T00:00:00.000Z"
    },
    state: { schemaVersion: 20, projects: { "project-1": v3Project } }
  };
  projectStep.validateSource(projectSnapshot);
  const normalizedProject = projectStep.normalize(projectSnapshot);
  assert.equal(normalizedProject.state.projects["project-1"].schemaVersion, 4);
  assert.deepEqual(normalizedProject.state.projects["project-1"].knowledgeProposals, []);
  assert.deepEqual(normalizedProject.state.projects["project-1"].knowledge, []);
  assert.equal(normalizedProject.schemaManifest.recordVersions.project, 4);

  const configStep = registry.lookup("record", "config", 1);
  assert.notEqual(configStep, undefined);
  const configSnapshot = {
    schemaManifest: {
      schemaVersion: 1,
      storageVersion: 7,
      aggregateSchemaVersion: 20,
      recordVersions: { config: 1 },
      updatedAt: "2026-08-22T00:00:00.000Z"
    },
    state: {
      schemaVersion: 20,
      config: {
        schemaVersion: 1,
        providerRetryMaxWindowMs: 12_345,
        yieldReceiptReplay: false,
        gitBin: "/custom/git",
        telemetryMode: "bounded"
      }
    }
  };
  configStep.preconditions(configSnapshot);
  const migratedConfig = configStep.transform(configSnapshot);
  assert.equal(migratedConfig.schemaManifest.recordVersions.config, 2);
  assert.deepEqual(migratedConfig.state.config, {
    schemaVersion: 2,
    providerRetryMaxWindowSeconds: 13,
    telemetryEnabled: true
  });
});

test("Provider retry scheduling consumes the configured delays and total window", () => {
  const now = new Date("2026-08-22T00:00:00.000Z");
  const decision = scheduleProviderRetry(undefined, {
    failureEventId: "event-1",
    errorClass: "transient-provider",
    lastErrorSummary: "temporary"
  }, now, { delaysMs: [1_000, 3_000], maxWindowMs: 10_000 });
  assert.equal(decision.outcome, "scheduled");
  assert.equal(decision.retry.nextAttemptAt, "2026-08-22T00:00:01.000Z");
  assert.equal(decision.retry.episodeDeadlineAt, "2026-08-22T00:00:10.000Z");
  assert.equal(decision.retry.maxRetries, 2);
  const dispatching = prepareProviderRetryDispatch(
    decision.retry,
    "retry-receipt-1",
    new Date(decision.retry.nextAttemptAt)
  );
  assert.match(serializeProviderRetryEnvelope({
    taskId: "task-1",
    runId: "run-1",
    roleName: "worker",
    retry: dispatching
  }), /retry=1\/2/u);
});

test("diagnostic telemetry enforces the configured per-Run cap during writes", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-core-smoke-telemetry-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const taskStore = new SqliteTaskStore(home);
  taskStore.close();
  const telemetry = new SqliteTelemetryStore(home, { mode: "on", runCap: 2 });
  t.after(() => telemetry.close());
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    telemetry.observe({
      taskId: "task-1",
      roleName: "worker",
      runId: "agent-run-1",
      generation: "launch-1",
      progressId: `progress-${sequence}`,
      sequence,
      payload: { kind: "progress" },
      receivedAt: new Date(Date.UTC(2026, 7, 22, 0, 0, sequence)).toISOString()
    });
  }
  await telemetry.flush();
  assert.equal(telemetry.count("task-1", "agent-run-1"), 2);
  assert.deepEqual(
    telemetry.list("task-1", "agent-run-1").items.map(({ sequence }) => sequence),
    [2, 3]
  );
});

test("the v6 Task Role Session migration invalidates legacy managed writers", () => {
  const registry = createProductionRegistry();
  const step = registry.lookup("record", "taskRoleSessionSet", 5);
  assert.notEqual(step, undefined);
  const at = "2026-08-23T00:00:00.000Z";
  const source = {
    schemaManifest: {
      schemaVersion: 1,
      storageVersion: 7,
      aggregateSchemaVersion: 20,
      recordVersions: { taskRoleSessionSet: 5 },
      updatedAt: at
    },
    state: {
      schemaVersion: 20,
      tasks: {
        "task-1": {
          roleSessionSets: {
            leader: {
              schemaVersion: 5,
              owner: { scope: "task", taskId: "task-1", roleName: "leader" },
              activeAgentId: "agent-1",
              sessions: {
                "agent-1": {
                  schemaVersion: 3,
                  agentId: "agent-1",
                  adapterId: "codex",
                  nativeSessionId: "thread-legacy",
                  launchId: "launch-legacy",
                  status: "running",
                  updatedAt: at
                }
              },
              inFlight: {
                agentId: "agent-1",
                runId: "run-legacy",
                receiptId: "task-1/agentRun/run-legacy",
                preparedAt: at
              },
              providerBinding: {
                schemaVersion: 1,
                providerNamespace: "openai/codex",
                accountScope: "agent-1",
                runId: "run-legacy",
                currentConversationEpoch: 1,
                conversations: [{
                  conversationId: "thread-legacy",
                  epoch: 1,
                  status: "current",
                  recoverability: "recoverable",
                  createdAt: at
                }],
                activations: [{
                  activationId: "launch-legacy",
                  conversationId: "thread-legacy",
                  generation: 1,
                  status: "active",
                  writerLease: true,
                  startedAt: at
                }]
              },
              updatedAt: at
            }
          }
        }
      }
    }
  };
  step.preconditions(source);
  const migrated = step.transform(source);
  const set = migrated.state.tasks["task-1"].roleSessionSets.leader;
  assert.equal(migrated.schemaManifest.recordVersions.taskRoleSessionSet, 6);
  assert.equal(set.schemaVersion, 6);
  assert.equal(set.sessions["agent-1"].status, "broken");
  assert.equal(set.providerBinding.schemaVersion, 2);
  assert.equal(set.providerBinding.authority.owner, "none");
  assert.equal(set.providerBinding.turn, null);
  assert.equal(set.providerBinding.conversations[0].recoverability, "unknown");
  assert.equal(set.providerBinding.activations[0].status, "failed");
  assert.equal(Object.hasOwn(set.providerBinding.activations[0], "writerLease"), false);
});

test("the built-in Agent Drivers are available through the shared registry", () => {
  const drivers = builtinAgentDriverRegistry();
  assert.equal(drivers.requireByAdapterId("codex").id, "openai/codex");
  assert.equal(drivers.requireByAdapterId("claude").id, "anthropic/claude-code");
});

// Issue 02: managed Codex launch failures must be diagnosed at the failing
// phase instead of degrading to a generic command-execution error.

const launchWorkspace = "/tmp/yui-core-smoke-launch";
const launchEffective = {
  schemaVersion: 2,
  sourceDesiredRevision: 1,
  agentId: "agent",
  adapterId: "codex",
  profileAccess: "write",
  model: "gpt-bad",
  effort: "xhigh",
  search: false,
  permission: { strategy: "default" },
  writeProjectIds: [],
  workspace: { root: launchWorkspace, entries: [] },
  context: {}
};
const launchCatalog = {
  schemaVersion: 1,
  agentId: "agent",
  adapterId: "codex",
  models: [{
    value: "gpt-good",
    label: "Good",
    isDefault: true,
    efforts: [{ value: "low", label: "low" }, { value: "high", label: "high" }]
  }],
  fields: [],
  warnings: []
};

test("launch configuration validation rejects unsupported model and effort before launch", () => {
  assert.throws(
    () => validateAgentLaunchConfiguration(launchCatalog, {
      adapterId: "codex",
      model: "gpt-bad",
      permission: { strategy: "default" }
    }),
    /field=model.*supported=\["gpt-good"\]/u
  );
  assert.throws(
    () => validateAgentLaunchConfiguration(launchCatalog, {
      adapterId: "codex",
      effort: "xhigh",
      permission: { strategy: "default" }
    }),
    /field=effort.*supported=\["low","high"\]/u
  );
});

test("TmuxSessionHost runs launch validation before creating the provider process", async () => {
  let ensured = false;
  const planner = {
    plan: () => ({
      role: { name: "reviewer", workspace: launchWorkspace },
      launch: { command: "codex", args: ["--model", "gpt-bad"], env: {} },
      session: null,
      initialTurnRunId: "run-1"
    })
  };
  const tmux = {
    ensureRoleWindow: () => { ensured = true; return true; },
    inspectRolePane: () => ({ target: "tmux:0", dead: false, currentCommand: "codex" }),
    killRole: () => undefined
  };
  const host = new TmuxSessionHost(planner, tmux, {
    validateLaunch: async () => {
      throw new Error("field=model actual=gpt-bad supported=[gpt-good]");
    }
  });
  await assert.rejects(
    host.start(createSessionLaunchRequest({
      launchId: "launch-1",
      owner: { scope: "task", taskId: "task-1", roleName: "reviewer" },
      agentId: "agent",
      adapterId: "codex",
      effective: launchEffective,
      workspace: launchWorkspace,
      runId: "run-1",
      mode: "new"
    })),
    (error) => {
      assert.ok(error instanceof RuntimeLaunchFailure);
      assert.equal(error.diagnostic.phase, "validation");
      assert.equal(error.diagnostic.kind, "config");
      assert.deepEqual(error.diagnostic.argv, ["codex", "--model", "gpt-bad"]);
      assert.equal(ensured, false);
      return true;
    }
  );
});

test("TmuxSessionHost rejects a managed Task planner without structured Agent Host control", async () => {
  let killed = false;
  const planner = {
    plan: () => ({
      role: { name: "reviewer", workspace: launchWorkspace },
      launch: { command: "codex", args: ["--model", "gpt-good"], env: {} },
      session: null,
      initialTurnRunId: "run-1"
    })
  };
  const tmux = {
    ensureRoleWindow: () => true,
    probeRoleStatus: () => "running",
    inspectRolePane: () => ({ target: "tmux:0", dead: false, currentCommand: "codex" }),
    captureRolePane: () => "",
    killRole: () => { killed = true; }
  };
  const host = new TmuxSessionHost(planner, tmux);
  await assert.rejects(
    host.start(createSessionLaunchRequest({
      launchId: "launch-1",
      owner: { scope: "task", taskId: "task-1", roleName: "reviewer" },
      agentId: "agent",
      adapterId: "codex",
      effective: launchEffective,
      workspace: launchWorkspace,
      runId: "run-1",
      mode: "new"
    })),
    /missing its structured Agent Host contract/
  );
  assert.equal(killed, false);
});

test("execution audit projects structured launch failure phase and kind", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-core-smoke-audit-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const now = new Date("2026-08-22T00:00:00.000Z");
  const store = new SqliteTaskStore(home);
  const task = activateTask(createTask(store.nextTaskId(), "Audit smoke", now), now);
  store.saveTask(task);
  const run = failAgentRun(createAgentRun(
    "agent-run-1",
    task.id,
    "reviewer",
    "new",
    "Review",
    now,
    { effective: launchEffective, purpose: "review" }
  ), "Role Run could not start: failurePhase=native-session-discovery failureKind=timeout argv=[\"codex\"]", now);
  store.saveAgentRun(run);
  const report = runExecutionAudit(home, {}, {
    openStore: () => store,
    directorySize: () => null
  });
  assert.equal(report.runs.status, "ok");
  assert.equal(report.runs.data.launchFailures.total, 1);
  assert.equal(report.runs.data.launchFailures.byPhase["native-session-discovery"], 1);
  assert.equal(report.runs.data.launchFailures.byKind.timeout, 1);
});

// Issue 09: a Session that stops after its Run yielded is a post-completion
// Session stop, not a Run failure. The audit keeps the two axes separate.
const issue09Effective = {
  schemaVersion: 2,
  sourceDesiredRevision: 1,
  agentId: "agent",
  adapterId: "codex",
  profileAccess: "write",
  search: false,
  permission: { strategy: "default" },
  writeProjectIds: [],
  workspace: { root: "/tmp/yui-issue09", entries: [] },
  context: {}
};

function issue09Setup(now) {
  const home = mkdtempSync(join(tmpdir(), "yui-core-smoke-issue09-"));
  const store = new SqliteTaskStore(home);
  const task = activateTask(createTask(store.nextTaskId(), "Issue 09", now), now);
  store.saveTask(task);
  const role = createRole(
    task.id,
    "leader",
    [createRoleAgentBinding({ id: "agent", adapterId: "codex" })],
    "agent",
    "/tmp/yui-issue09",
    now
  );
  store.saveRole(task.id, role);
  return { home, store, task, role };
}

function issue09Session(store, task, status, at) {
  let sessions = createRoleSessionSet(
    { scope: "task", taskId: task.id, roleName: "leader" },
    "agent",
    at
  );
  sessions = recordRoleAgentSession(sessions, {
    agentId: "agent",
    adapterId: "codex",
    nativeSessionId: "sess-1",
    status: "running",
    policy: "fixed",
    effective: issue09Effective
  }, at);
  sessions = updateRoleAgentSessionStatus(sessions, "agent", status, at);
  store.saveTaskRoleSessionSet(sessions);
}

test("execution audit separates post-completion Session stops from Run failures", (t) => {
  const now = new Date("2026-08-22T00:00:00.000Z");
  const { home, store, task } = issue09Setup(now);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // R1 yields durably; the Session stops 6s later.
  let run = createAgentRun("agent-run-1", task.id, "leader", "new", "wake", now, {
    effective: issue09Effective
  });
  run = yieldAgentRun(run, "delivered", now);
  store.saveAgentRun(run);
  issue09Session(store, task, "stopped", new Date(now.getTime() + 6_000));
  const report = runExecutionAudit(home, { taskId: task.id }, {
    openStore: () => store,
    directorySize: () => null
  });
  assert.equal(report.runs.status, "ok");
  assert.equal(report.runs.data.yielded, 1);
  assert.equal(report.runs.data.failed, 0);
  assert.equal(report.sessions.data.terminalByRunRelation.postRunYielded, 1);
  assert.equal(report.sessions.data.terminalByRunRelation.runFailed, 0);
  assert.equal(report.sessions.data.terminalByRunRelation.activeRun, 0);
  // The Run stays yielded even though the Session later stopped.
  assert.equal(store.getAgentRun(task.id, "agent-run-1").status, "yielded");
});

test("role status shows the last Run outcome beside the Session lifecycle", (t) => {
  const now = new Date("2026-08-22T00:00:00.000Z");
  const { home, store, task, role } = issue09Setup(now);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let run = createAgentRun("agent-run-1", task.id, "leader", "new", "wake", now, {
    effective: issue09Effective
  });
  run = yieldAgentRun(run, "delivered", now);
  store.saveAgentRun(run);
  const brokenAt = new Date(now.getTime() + 6_000);
  issue09Session(store, task, "broken", brokenAt);
  const [status] = inspectTaskRoleRuntimeStatuses(task.id, [role], store, [], brokenAt);
  assert.equal(status.lastRun?.id, "agent-run-1");
  assert.equal(status.lastRun?.status, "yielded");
  // A broken Session after the Run yielded is attention, not a Run failure.
  assert.equal(status.health, "needs-attention");
  assert.match(status.healthReason, /last run agent-run-1 yielded/u);
  const rendered = renderTaskRoleRuntimeStatus(status);
  assert.match(rendered, /Last run\s+agent-run-1 \(yielded/u);
  assert.match(rendered, /Native session\s+sess-1 \(broken/u);
});

test("the Codex App Server adapter keeps attachment and Run boundaries separate", async () => {
  const calls = [];
  const runtime = new CodexAppServerRuntime({
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/read") {
        return {
          thread: {
            id: params.threadId,
            status: { type: "notLoaded" },
            turns: []
          }
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    }
  });
  const snapshot = await runtime.readConversation("thread-1");
  assert.equal(snapshot.status, "notLoaded");
  assert.equal(snapshot.latestTurnStatus, undefined);
  assert.deepEqual(codexNotificationBoundary({
    method: "thread/closed",
    params: { threadId: "thread-1" }
  }), {
    kind: "activation-ended",
    conversationId: "thread-1"
  });
  assert.deepEqual(calls.map(({ method }) => method), ["thread/read"]);
});

test("managed Codex waits for App Server Turn acceptance and keeps input off argv", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "yui-codex-host-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = join(root, "test", "fixtures", "fake-codex-app-server.mjs");
  const attempts = join(directory, "attempts.txt");
  const started = await startStructuredProviderSession({
    schemaVersion: 1,
    launchId: "launch-codex-1",
    command: process.execPath,
    args: [server, "structured", attempts],
    environment: { PATH: process.env.PATH ?? "" },
    cwd: directory,
    childLifecycle: "persistent",
    startMode: "provider",
    providerControl: {
      schemaVersion: 1,
      adapterId: "codex",
      transport: "codex-app-server-stdio",
      mode: "new",
      authority: { epoch: 1, owner: "controller", holderId: "launch-codex-1" },
      initialTurn: {
        attemptId: "task-1/agentRun/run-1",
        boundedText: "perform the managed work"
      }
    }
  }, { mirrorOutput: () => {} });
  assert.equal(existsSync(attempts), false);
  const receipt = await started.session.submitTurn({
    attemptId: "task-1/agentRun/run-1",
    boundedText: "perform the managed work"
  });
  assert.equal(receipt.conversationId, "thread-structured-1");
  assert.equal(receipt.nativeTurnId, "turn-structured-1");
  assert.equal(readFileSync(attempts, "utf8"), "turn/start\n");
  started.session.terminate("SIGTERM");
  await started.session.waitForExit();
});

test("managed Claude accepts only an exact replayed user message", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "yui-claude-host-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = join(root, "test", "fixtures", "fake-claude-stream.mjs");
  const started = await startStructuredProviderSession({
    schemaVersion: 1,
    launchId: "launch-claude-1",
    command: process.execPath,
    args: [server, "11111111-1111-4111-8111-111111111111"],
    environment: { PATH: process.env.PATH ?? "" },
    cwd: directory,
    childLifecycle: "persistent",
    startMode: "provider",
    providerControl: {
      schemaVersion: 1,
      adapterId: "claude",
      transport: "claude-stream-json",
      mode: "resume",
      nativeSessionId: "11111111-1111-4111-8111-111111111111",
      authority: { epoch: 1, owner: "controller", holderId: "launch-claude-1" },
      initialTurn: {
        attemptId: "task-1/agentRun/run-2",
        boundedText: "continue the managed work"
      }
    }
  }, { mirrorOutput: () => {} });
  const receipt = await started.session.submitTurn({
    attemptId: "task-1/agentRun/run-2",
    boundedText: "continue the managed work"
  });
  assert.equal(receipt.attemptId, "task-1/agentRun/run-2");
  assert.equal(
    receipt.nativeTurnId,
    "claude-input:task-1/agentRun/run-2"
  );
  started.session.terminate("SIGTERM");
  await started.session.waitForExit();
});

test("managed Claude keeps new and resume native identity flags mutually exclusive", () => {
  const nativeSessionId = "11111111-1111-4111-8111-111111111111";
  const adapter = resolveAgentAdapter("claude");
  const input = {
    agent: {
      schemaVersion: 2,
      id: "claude-agent",
      adapterId: "claude",
      command: "claude",
      baseArgs: [],
      environment: [],
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      source: "custom"
    },
    config: { adapterId: "claude", permission: { strategy: "bypass" } },
    workspace: root
  };
  const fresh = adapter.compileManagedControl(input, "new", nativeSessionId).argv;
  assert.equal(fresh.includes("--resume"), false);
  assert.deepEqual(fresh.slice(fresh.indexOf("--session-id"), fresh.indexOf("--session-id") + 2), [
    "--session-id",
    nativeSessionId
  ]);
  const resumed = adapter.compileManagedControl(input, "resume", nativeSessionId).argv;
  assert.equal(resumed.includes("--session-id"), false);
  assert.deepEqual(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2), [
    "--resume",
    nativeSessionId
  ]);
});

test("an ambiguous Codex Turn submission is not retried automatically", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "yui-codex-unknown-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = join(root, "test", "fixtures", "fake-codex-app-server.mjs");
  const attempts = join(directory, "attempts.txt");
  const started = await startStructuredProviderSession({
      schemaVersion: 1,
      launchId: "launch-codex-unknown",
      command: process.execPath,
      args: [server, "unknown", attempts],
      environment: { PATH: process.env.PATH ?? "" },
      cwd: directory,
      childLifecycle: "persistent",
      startMode: "provider",
      providerControl: {
        schemaVersion: 1,
        adapterId: "codex",
        transport: "codex-app-server-stdio",
        mode: "new",
        authority: { epoch: 1, owner: "controller", holderId: "launch-codex-unknown" },
        initialTurn: {
          attemptId: "task-1/agentRun/run-unknown",
          boundedText: "do not duplicate this"
        }
      }
    }, { mirrorOutput: () => {} });
  await assert.rejects(
    started.session.submitTurn({
      attemptId: "task-1/agentRun/run-unknown",
      boundedText: "do not duplicate this"
    }),
    ProviderDeliveryUnknownError
  );
  await started.session.waitForExit();
  assert.equal(readFileSync(attempts, "utf8"), "turn/start\n");
});

test("an exact Codex Turn rejection stays distinct from ambiguous delivery", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "yui-codex-rejected-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = join(root, "test", "fixtures", "fake-codex-app-server.mjs");
  const started = await startStructuredProviderSession({
    schemaVersion: 1,
    launchId: "launch-codex-rejected",
    command: process.execPath,
    args: [server, "structured"],
    environment: { PATH: process.env.PATH ?? "" },
    cwd: directory,
    childLifecycle: "persistent",
    startMode: "provider",
    providerControl: {
      schemaVersion: 1,
      adapterId: "codex",
      transport: "codex-app-server-stdio",
      mode: "new",
      authority: { epoch: 1, owner: "controller", holderId: "launch-codex-rejected" }
    }
  }, { mirrorOutput: () => {} });
  await assert.rejects(started.session.submitTurn({
    attemptId: "task-1/agentRun/run-rejected",
    boundedText: "this input is definitively rejected"
  }), ProviderTurnRejectedError);
  started.session.terminate("SIGTERM");
  await started.session.waitForExit();
});

test("managed Codex distinguishes an exact missing Conversation from an unknown probe", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "yui-codex-missing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = join(root, "test", "fixtures", "fake-codex-app-server.mjs");
  await assert.rejects(startStructuredProviderSession({
    schemaVersion: 1,
    launchId: "launch-codex-missing",
    command: process.execPath,
    args: [server, "missing"],
    environment: { PATH: process.env.PATH ?? "" },
    cwd: directory,
    childLifecycle: "persistent",
    startMode: "provider",
    providerControl: {
      schemaVersion: 1,
      adapterId: "codex",
      transport: "codex-app-server-stdio",
      mode: "resume",
      nativeSessionId: "thread-no-longer-exists",
      authority: { epoch: 3, owner: "controller", holderId: "launch-codex-missing" }
    }
  }, { mirrorOutput: () => {} }), (error) => {
    assert.ok(error instanceof ProviderConversationMissingError);
    assert.equal(error.conversationId, "thread-no-longer-exists");
    return true;
  });
  assert.equal(codexAppServerErrorIsMissing(
    new CodexAppServerRequestError(-32601, "method not found")
  ), false);
  assert.equal(codexAppServerErrorIsMissing(
    new CodexAppServerRequestError(-32000, "Codex thread does not exist")
  ), true);
});

test("Provider authority handoff fences Controller and human writers by epoch", () => {
  const startedAt = "2026-08-22T00:00:00.000Z";
  const initial = createProviderRuntimeBinding({
    providerNamespace: "openai/codex",
    accountScope: "agent-1",
    runId: "agent-run-1",
    conversationId: "thread-1",
    activationId: "activation-1",
    startedAt
  });
  assert.deepEqual(currentProviderAuthority(initial), {
    epoch: 1,
    owner: "controller",
    holderId: "activation-1",
    changedAt: startedAt
  });

  const human = transferProviderAuthority(initial, {
    expectedEpoch: 1,
    expectedOwner: "controller",
    owner: "human",
    holderId: "view-1",
    changedAt: "2026-08-22T00:00:01.000Z"
  });
  assert.deepEqual(currentProviderAuthority(human), {
    epoch: 2,
    owner: "human",
    holderId: "view-1",
    changedAt: "2026-08-22T00:00:01.000Z"
  });

  assert.throws(() => transferProviderAuthority(human, {
    expectedEpoch: 1,
    expectedOwner: "controller",
    owner: "human",
    holderId: "view-2",
    changedAt: "2026-08-22T00:00:02.000Z"
  }), /authority fence is stale/u);

  const controller = transferProviderAuthority(human, {
    expectedEpoch: 2,
    expectedOwner: "human",
    owner: "controller",
    holderId: "activation-1",
    changedAt: "2026-08-22T00:00:03.000Z"
  });
  assert.deepEqual(currentProviderAuthority(controller), {
    epoch: 3,
    owner: "controller",
    holderId: "activation-1",
    changedAt: "2026-08-22T00:00:03.000Z"
  });

  const ended = endProviderActivation(initial, "activation-1", {
    status: "failed",
    endedAt: "2026-08-22T00:10:00.000Z"
  });
  const rebound = rebindProviderRuntimeRun(ended, "agent-run-2");
  const restarted = startProviderActivation(rebound, {
    activationId: "activation-2",
    startedAt: "2026-08-22T00:11:00.000Z"
  });
  assert.equal(restarted.runId, "agent-run-2");
  assert.equal(restarted.currentConversationEpoch, 1);
  assert.equal(restarted.activations.at(-1).generation, 2);
  assert.deepEqual(currentProviderAuthority(restarted), {
    epoch: 3,
    owner: "controller",
    holderId: "activation-2",
    changedAt: "2026-08-22T00:11:00.000Z"
  });
});

test("structured Provider mutation rejects a stale writer before Adapter dispatch", async () => {
  let submissions = 0;
  const control = new FencedProviderControl({
    providerNamespace: "openai/codex",
    async inspectConversation(conversationId) {
      return { state: "exists", conversationId };
    },
    async submitTurn() {
      submissions += 1;
      return { status: "accepted", turnId: "turn-1" };
    },
    async interruptTurn() {
      return "interrupted";
    }
  });
  const initial = createProviderRuntimeBinding({
    providerNamespace: "openai/codex",
    accountScope: "agent-1",
    runId: "agent-run-1",
    conversationId: "thread-1",
    activationId: "activation-1",
    startedAt: "2026-08-22T00:00:00.000Z"
  });
  const human = transferProviderAuthority(initial, {
    expectedEpoch: 1,
    expectedOwner: "controller",
    owner: "human",
    holderId: "view-1",
    changedAt: "2026-08-22T00:00:01.000Z"
  });

  await assert.rejects(control.submitTurn({
    binding: human,
    fence: {
      conversationId: "thread-1",
      activationId: "activation-1",
      authorityEpoch: 1,
      authorityOwner: "controller",
      holderId: "activation-1"
    },
    attemptId: "attempt-stale",
    text: "must not dispatch"
  }), /writer fence is stale/u);
  assert.equal(submissions, 0);

  const accepted = await control.submitTurn({
    binding: human,
    fence: {
      conversationId: "thread-1",
      activationId: "activation-1",
      authorityEpoch: 2,
      authorityOwner: "human",
      holderId: "view-1"
    },
    attemptId: "attempt-1",
    text: "continue"
  });
  assert.deepEqual(accepted, { status: "accepted", turnId: "turn-1" });
  assert.equal(submissions, 1);
});

test("Provider Turn acknowledgement is durable before writer handoff", () => {
  const initial = createProviderRuntimeBinding({
    providerNamespace: "openai/codex",
    accountScope: "agent-1",
    runId: "agent-run-1",
    conversationId: "thread-1",
    activationId: "activation-1",
    startedAt: "2026-08-22T00:00:00.000Z"
  });
  const submitting = beginProviderTurn(initial, {
    attemptId: "attempt-1",
    authorityEpoch: 1,
    submittedAt: "2026-08-22T00:00:01.000Z"
  });
  assert.throws(() => transferProviderAuthority(submitting, {
    expectedEpoch: 1,
    expectedOwner: "controller",
    owner: "human",
    holderId: "view-1",
    changedAt: "2026-08-22T00:00:02.000Z"
  }), /Turn is unsettled/u);

  const accepted = acceptProviderTurn(submitting, {
    attemptId: "attempt-1",
    turnId: "turn-1",
    acceptedAt: "2026-08-22T00:00:02.000Z"
  });
  const settled = settleProviderTurn(accepted, {
    turnId: "turn-1",
    status: "completed",
    settledAt: "2026-08-22T00:00:03.000Z"
  });
  const human = transferProviderAuthority(settled, {
    expectedEpoch: 1,
    expectedOwner: "controller",
    owner: "human",
    holderId: "view-1",
    changedAt: "2026-08-22T00:00:04.000Z"
  });
  assert.equal(human.authority.owner, "human");
  assert.equal(human.turn?.status, "completed");
});

test("Runtime binding reports exactly one initial Turn launch outcome", () => {
  const base = {
    id: "binding-1",
    launchId: "launch-1",
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "agent-1",
    adapterId: "codex",
    hostRef: "host-1"
  };
  assert.equal(createRuntimeBinding({
    ...base,
    initialTurnDeliveryUnknownRunId: "run-1"
  }).initialTurnDeliveryUnknownRunId, "run-1");
  assert.throws(() => createRuntimeBinding({
    ...base,
    initialTurnRunId: "run-1",
    initialTurnDeliveryUnknownRunId: "run-1"
  }), /at most one initial Turn outcome/u);
  assert.equal(createRuntimeBinding({
    ...base,
    initialTurnRejectedRunId: "run-1"
  }).initialTurnRejectedRunId, "run-1");
});

test("Provider recovery requires exact tri-state evidence before resume or replacement", () => {
  const startedAt = "2026-08-23T00:00:00.000Z";
  const binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex",
    accountScope: "default",
    runId: "run-recovery",
    conversationId: "conversation-1",
    activationId: "activation-1",
    startedAt
  });

  assert.deepEqual(decideProviderRecovery({
    binding,
    probe: { state: "exists", conversationId: "conversation-1" },
    unsettledInputDelivery: false
  }), { action: "resume", conversationId: "conversation-1" });
  assert.deepEqual(decideProviderRecovery({
    binding,
    probe: {
      state: "exists",
      conversationId: "conversation-1",
      activeTurnId: "turn-1"
    },
    unsettledInputDelivery: false
  }), {
    action: "observe-active-turn",
    conversationId: "conversation-1",
    turnId: "turn-1"
  });
  assert.equal(decideProviderRecovery({
    binding,
    probe: { state: "unknown", conversationId: "conversation-1" },
    unsettledInputDelivery: false
  }).action, "attention");

  const ended = endProviderActivation(binding, "activation-1", {
    status: "failed",
    endedAt: "2026-08-23T00:01:00.000Z",
    reason: "provider process exited"
  });
  assert.deepEqual(decideProviderRecovery({
    binding: ended,
    probe: { state: "missing", conversationId: "conversation-1" },
    unsettledInputDelivery: false
  }), { action: "replace", conversationId: "conversation-1" });
  assert.throws(() => decideProviderRecovery({
    binding,
    probe: { state: "exists", conversationId: "conversation-other" },
    unsettledInputDelivery: false
  }), /different Conversation/u);
});

test("Provider recovery never replaces a Conversation with unsettled delivery", () => {
  const startedAt = "2026-08-23T00:00:00.000Z";
  const initial = createProviderRuntimeBinding({
    providerNamespace: "anthropic/claude-code",
    accountScope: "default",
    runId: "run-uncertain",
    conversationId: "conversation-1",
    activationId: "activation-1",
    startedAt
  });
  const submitting = beginProviderTurn(initial, {
    attemptId: "attempt-1",
    authorityEpoch: 1,
    submittedAt: "2026-08-23T00:00:01.000Z"
  });
  const uncertain = markProviderTurnDeliveryUnknown(submitting, {
    attemptId: "attempt-1",
    observedAt: "2026-08-23T00:00:02.000Z",
    reason: "stdin write outcome is unknown"
  });
  const lateAcceptance = acceptProviderTurn(uncertain, {
    attemptId: "attempt-1",
    turnId: "turn-late-ack",
    acceptedAt: "2026-08-23T00:00:03.000Z"
  });
  assert.equal(lateAcceptance.turn.status, "accepted");
  assert.equal(lateAcceptance.turn.turnId, "turn-late-ack");
  const ended = endProviderActivation(uncertain, "activation-1", {
    status: "failed",
    endedAt: "2026-08-23T00:01:00.000Z",
    reason: "provider process exited"
  });

  const decision = decideProviderRecovery({
    binding: ended,
    probe: { state: "missing", conversationId: "conversation-1" },
    unsettledInputDelivery: false
  });
  assert.equal(decision.action, "attention");
  assert.match(decision.reason, /delivery remains unsettled/u);
  assert.equal(decideProviderRecovery({
    binding: endProviderActivation(initial, "activation-1", {
      status: "failed",
      endedAt: "2026-08-23T00:01:00.000Z"
    }),
    probe: { state: "missing", conversationId: "conversation-1" },
    unsettledInputDelivery: true
  }).action, "attention");
  assert.equal(decideProviderRecovery({
    binding: uncertain,
    probe: { state: "exists", conversationId: "conversation-1" },
    unsettledInputDelivery: false
  }).action, "attention");
});

test("Task Role takeover and release persist monotonic Provider authority epochs", (t) => {
  const now = new Date("2026-08-23T00:00:00.000Z");
  const { home, store, task } = issue09Setup(now);
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  let sessions = createRoleSessionSet(
    { scope: "task", taskId: task.id, roleName: "leader" },
    "agent",
    now
  );
  sessions = recordRoleAgentSession(sessions, {
    agentId: "agent",
    adapterId: "codex",
    nativeSessionId: "conversation-takeover",
    launchId: "activation-takeover",
    status: "running",
    policy: "fixed",
    effective: issue09Effective
  }, now);
  sessions = bindTaskRoleRun(sessions, {
    agentId: "agent",
    runId: "run-takeover",
    receiptId: "task/agentRun/run-takeover"
  }, now);
  sessions = bindTaskRoleProviderRuntime(sessions, createProviderRuntimeBinding({
    providerNamespace: "openai/codex",
    accountScope: "default",
    runId: "run-takeover",
    conversationId: "conversation-takeover",
    activationId: "activation-takeover",
    startedAt: now.toISOString()
  }), now);
  store.saveTaskRoleSessionSet(sessions);
  store.saveActiveAgentRun(createAgentRun(
    "run-takeover",
    task.id,
    "leader",
    "new",
    "human takeover test",
    now,
    { effective: issue09Effective }
  ));

  const takeover = runTaskCommand(
    ["role", "takeover", task.id, "leader"],
    store,
    { now: () => new Date("2026-08-23T00:00:01.000Z") }
  );
  assert.equal(takeover.kind, "authority");
  assert.equal(takeover.action, "takeover");
  assert.equal(takeover.authority.owner, "human");
  assert.equal(takeover.authority.epoch, 2);
  assert.match(takeover.authority.holderId, /^human:/u);
  const replayedTakeover = runTaskCommand(
    ["role", "takeover", task.id, "leader"],
    store,
    { now: () => new Date("2026-08-23T00:00:01.500Z") }
  );
  assert.deepEqual(replayedTakeover.authority, takeover.authority);

  const release = runTaskCommand(
    ["role", "release", task.id, "leader"],
    store,
    { now: () => new Date("2026-08-23T00:00:02.000Z") }
  );
  assert.equal(release.kind, "authority");
  assert.equal(release.action, "release");
  assert.deepEqual(release.authority, {
    epoch: 3,
    owner: "controller",
    holderId: "activation-takeover"
  });
  assert.equal(
    store.getTaskRoleSessionSet(task.id, "leader").providerBinding.authority.epoch,
    3
  );
  const replayedRelease = runTaskCommand(
    ["role", "release", task.id, "leader"],
    store,
    { now: () => new Date("2026-08-23T00:00:03.000Z") }
  );
  assert.deepEqual(replayedRelease.authority, release.authority);

  const cleared = clearTaskRoleRun(
    store.getTaskRoleSessionSet(task.id, "leader"),
    {
      agentId: "agent",
      runId: "run-takeover",
      receiptId: "task/agentRun/run-takeover"
    },
    new Date("2026-08-23T00:00:04.000Z")
  );
  assert.equal(cleared.providerBinding.authority.epoch, 3);
  const nextRun = bindTaskRoleRun(cleared, {
    agentId: "agent",
    runId: "run-next",
    receiptId: "task/agentRun/run-next"
  }, new Date("2026-08-23T00:00:05.000Z"));
  assert.equal(nextRun.providerBinding.runId, "run-next");
  assert.deepEqual(nextRun.providerBinding.authority, cleared.providerBinding.authority);
});

test("the runtime coordination core keeps correction lanes and terminal facts stable", () => {
  const continuationEnvelope = createPromptEnvelope({
    id: "agent-input:task-1/agent-run-1/normal:2-3",
    source: { kind: "run-input", taskId: "task-1", localId: "agent-run-1" },
    text: "New durable facts are available.",
    createdAt: new Date("2026-08-20T00:00:00.000Z")
  });
  assert.equal(continuationEnvelope.source.kind, "run-input");
  let mailbox = createWorkMailbox({ kind: "role", taskId: "task-1", roleName: "leader" });
  mailbox = enqueueSignal(mailbox, {
    reason: "worker-result",
    refs: [{ type: "event", taskId: "task-1", id: "event-1" }],
    occurredAt: "2026-08-20T00:00:00.000Z",
    dedupeKey: "event-1",
    lane: "normal"
  });
  mailbox = enqueueSignal(mailbox, {
    reason: "user-correction",
    refs: [{ type: "message", taskId: "task-1", id: "message-1" }],
    occurredAt: "2026-08-20T00:00:01.000Z",
    dedupeKey: "message-1",
    lane: "user-correction",
    deliveryMode: "steer-if-safe"
  });
  assert.equal(nextPendingBatch(mailbox), mailbox.pending.userCorrection);
  assert.equal(mailbox.pending.normal.requestCount, 1);

  const fence = {
    taskId: "task-1",
    roleName: "leader",
    runId: "agent-run-1",
    agentId: "agent-1",
    driverId: "anthropic/claude-code",
    launchId: "activation-1",
    sessionGenerationId: "activation-1",
    conversationId: "conversation-1",
    activationId: "activation-1",
    nativeSessionId: "conversation-1",
    nativeTurnId: "turn-1"
  };
  const first = runtimeObservationSemanticKey({
    eventId: "end-1", kind: "turn.completed", fence, sequence: 1, payload: {}
  });
  const replay = runtimeObservationSemanticKey({
    eventId: "end-2", kind: "turn.completed", fence, sequence: 1_386, payload: {}
  });
  assert.equal(first, replay);
  const otherAccount = runtimeObservationSemanticKey({
    eventId: "end-3",
    kind: "turn.completed",
    fence: { ...fence, agentId: "agent-2" },
    sequence: 1,
    payload: {}
  });
  assert.notEqual(first, otherAccount);
});
