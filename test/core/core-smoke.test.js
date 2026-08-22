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
import { builtinAgentDriverRegistry } from "../../dist/runtime/builtinAgentDrivers.js";
import { validateAgentLaunchConfiguration } from "../../dist/executor/agentConfigurationCatalog.js";
import { runExecutionAudit } from "../../dist/observability/executionAudit.js";
import { createAgentRun, failAgentRun, yieldAgentRun } from "../../dist/run/agentRun.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import {
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
  CodexAppServerRuntime,
  codexNotificationBoundary
} from "../../dist/runtime/index.js";
import {
  createWorkMailbox,
  enqueueSignal,
  nextPendingBatch
} from "../../dist/coordination/workMailbox.js";

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
      initialPromptRunId: "run-1"
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

test("TmuxSessionHost backstops an unresponsive agent and stops the host", async () => {
  let killed = false;
  const planner = {
    plan: () => ({
      role: { name: "reviewer", workspace: launchWorkspace },
      launch: { command: "codex", args: ["--model", "gpt-good"], env: {} },
      session: null,
      initialPromptRunId: "run-1"
    })
  };
  const tmux = {
    ensureRoleWindow: () => true,
    probeRoleStatus: () => "running",
    inspectRolePane: () => ({ target: "tmux:0", dead: false, currentCommand: "codex" }),
    captureRolePane: () => "",
    killRole: () => { killed = true; }
  };
  const host = new TmuxSessionHost(planner, tmux, {
    inactivityTimeoutMs: 25,
    waitForNativeSession: () => new Promise(() => undefined)
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
      assert.equal(error.diagnostic.phase, "native-session-discovery");
      assert.equal(error.diagnostic.kind, "timeout");
      assert.match(error.diagnostic.detail, /no signal/);
      assert.equal(killed, true);
      return true;
    }
  );
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
