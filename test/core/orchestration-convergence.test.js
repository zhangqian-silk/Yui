import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { runOperatorCommand } from "../../dist/commands/operatorCommands.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession,
  updateRoleAgentSessionStatus
} from "../../dist/executor/agentExecutor.js";
import { createYieldReceipt } from "../../dist/run/yieldReceipt.js";
import {
  findReusableIntegrationCheckEvidence,
  INTEGRATION_RUNTIME_RELEASE_ENV
} from "../../dist/integration/integrationCheckEvidenceReuse.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import { GitIntegrationService } from "../../dist/integration/gitIntegrationService.js";
import {
  createIntegrationAttempt,
  recordIntegrationCheckJob,
  updateIntegrationAttempt
} from "../../dist/integration/integrationAttempt.js";
import {
  completeDurableJob,
  createDurableJob,
  startDurableJob
} from "../../dist/job/durableJob.js";
import { writeRuntimeIdentity } from "../../dist/release/runtimeRelease.js";
import {
  prepareOperatorNewSession,
  projectOperatorStatus
} from "../../dist/operator/operatorSessionHistory.js";
import { runExecutionAudit } from "../../dist/observability/executionAudit.js";
import { projectTaskOrchestration } from "../../dist/observability/orchestrationMetrics.js";
import {
  classifyReviewRoundOutcome
} from "../../dist/review/reviewOutcomeClassifier.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import { projectNextAction } from "../../dist/task/nextAction.js";
import {
  boundProviderRetryBeforeFirstProgress,
  projectFirstProgressStopLoss
} from "../../dist/runtime/firstProgressStopLoss.js";
import {
  createGlobalRole,
  createRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";
import { createProject } from "../../dist/repository/project.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { activateTask, createTask } from "../../dist/task/task.js";

const now = new Date("2026-08-24T00:00:00.000Z");
const later = new Date("2026-08-24T00:01:00.000Z");
const commit = "a".repeat(40);
const effective = {
  schemaVersion: 2,
  sourceDesiredRevision: 1,
  agentId: "agent",
  adapterId: "codex",
  profileAccess: "write",
  search: false,
  permission: { strategy: "default" },
  writeProjectIds: [],
  workspace: { root: "/tmp/yui-orchestration", entries: [] },
  context: {}
};

function review(overrides = {}) {
  return {
    schemaVersion: 5,
    id: "review-round-1",
    taskId: "task-1",
    workItemId: "work-item-1",
    candidateId: "candidate-1",
    reviewerRoleName: "reviewer",
    reviewBaseCommit: commit,
    requestedBy: "leader",
    status: "completed",
    summary: "Reviewed candidate",
    report: "No findings",
    checks: [],
    evidenceCommit: commit,
    createdAt: now.toISOString(),
    endedAt: later.toISOString(),
    ...overrides
  };
}

test("Review outcomes distinguish semantic, non-semantic, and ambiguous evidence", () => {
  assert.equal(classifyReviewRoundOutcome(review()).kind, "semantic");
  assert.equal(classifyReviewRoundOutcome(review({
    status: "failed",
    summary: "Role Run could not start",
    report: "Role Run could not start",
    evidenceCommit: undefined
  })).kind, "non-semantic");
  assert.equal(classifyReviewRoundOutcome(review({
    status: "failed",
    summary: "Role Run could not start",
    report: JSON.stringify({ findings: [{ severity: "P1", summary: "real finding" }] }),
    evidenceCommit: undefined
  })).kind, "ambiguous");

  const summary = "Role Run workspace is not the durable owner: task-1/reviewer.";
  const round = review({
    reviewerRunId: "agent-run-1",
    summary,
    report: summary
  });
  const outcome = {
    status: "yielded",
    summary,
    reviewResult: { report: summary, checks: [], evidenceCommit: commit }
  };
  const run = {
    id: "agent-run-1",
    taskId: "task-1",
    roleName: "reviewer",
    purpose: "review",
    reviewRoundId: round.id,
    status: "yielded",
    summary,
    yieldReceipt: createYieldReceipt("task-1", "agent-run-1", outcome, later)
  };
  const event = {
    id: "event-1",
    taskId: "task-1",
    type: "review.completed",
    payload: {
      reviewRoundId: round.id,
      workItemId: round.workItemId,
      candidateId: round.candidateId,
      reviewBaseCommit: commit,
      evidenceCommit: commit,
      checks: "none"
    },
    createdAt: later.toISOString()
  };
  assert.equal(classifyReviewRoundOutcome(round).kind, "ambiguous");
  assert.equal(classifyReviewRoundOutcome(round, {
    listAgentRuns: () => [run],
    listReviewFindings: () => [],
    listEvents: () => [event]
  }).kind, "non-semantic");
});

test("next-action force-refreshes corroborated non-semantic completed Reviews", () => {
  const summary = "Role Run workspace is not the durable owner: task-1/reviewer.";
  const round = review({
    scope: "task",
    reviewerRunId: "agent-run-1",
    summary,
    report: summary,
    taskCandidate: {
      schemaVersion: 1,
      projects: [{ projectId: "project-1", commit }]
    }
  });
  const runOutcome = {
    status: "yielded",
    summary,
    reviewResult: { report: summary, checks: [], evidenceCommit: commit }
  };
  const run = {
    id: "agent-run-1",
    taskId: "task-1",
    roleName: "reviewer",
    purpose: "review",
    reviewRoundId: round.id,
    status: "yielded",
    summary,
    yieldReceipt: createYieldReceipt("task-1", "agent-run-1", runOutcome, later)
  };
  const event = {
    id: "event-1",
    taskId: "task-1",
    type: "review.completed",
    payload: {
      reviewRoundId: round.id,
      workItemId: round.workItemId,
      candidateId: round.candidateId,
      reviewBaseCommit: commit,
      evidenceCommit: commit,
      checks: "none"
    },
    createdAt: later.toISOString()
  };
  const item = {
    ...createWorkItem("work-item-1", "task-1", { title: "fix" }, now),
    status: "completed",
    outcome: "done",
    endedAt: later.toISOString(),
    updatedAt: later.toISOString()
  };
  const facts = {
    task: {
      id: "task-1",
      status: "active",
      projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "main" }],
      type: "feature"
    },
    workItems: [item],
    changeSets: [{
      id: "change-set-1",
      taskId: "task-1",
      workItemId: item.id,
      projectId: "project-1",
      baseCommit: "b".repeat(40),
      headCommit: commit,
      branch: "change",
      changedPaths: ["value.txt"],
      createdAt: now.toISOString()
    }],
    integrations: [{
      id: "integration-1",
      taskId: "task-1",
      projectId: "project-1",
      targetRef: "refs/heads/main",
      expectedHead: "b".repeat(40),
      changeSetIds: ["change-set-1"],
      checkCommands: [],
      candidateCommit: commit,
      status: "committed",
      createdAt: now.toISOString(),
      updatedAt: later.toISOString(),
      endedAt: later.toISOString()
    }],
    reviewRounds: [round],
    taskFinalReviewContractEvents: [],
    reviewConfig: { roleName: "reviewer", trigger: "final" },
    openInputRequests: [],
    activeRuns: [],
    leaderRuns: []
  };
  assert.equal(projectNextAction(facts).kind, "repair-protocol-inconsistency");
  const action = projectNextAction({
    ...facts,
    reviewOutcomeEvidence: { agentRuns: [run], reviewFindings: [], events: [event] }
  });
  assert.equal(action.kind, "resume-review");
  assert.equal(
    action.recommendedCommand,
    "yui task review force-fresh task-1/review-round-1"
  );
});

function taskSessions(owner = { scope: "task", taskId: "task-1", roleName: "leader" }) {
  let sessions = createRoleSessionSet(owner, "agent", now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "agent",
    adapterId: "codex",
    nativeSessionId: "session-1",
    launchId: "launch-1",
    status: "running",
    policy: "fixed",
    effective
  }, now);
  return sessions;
}

test("two generations without first durable progress exhaust the stop-loss", () => {
  const first = taskSessions();
  const session = first.sessions.agent;
  const sessions = {
    ...first,
    history: [{ ...session, status: "broken", updatedAt: later.toISOString() }],
    sessions: {
      agent: {
        ...session,
        nativeSessionId: "session-2",
        launchId: "launch-2",
        createdAt: later.toISOString(),
        updatedAt: later.toISOString()
      }
    },
    updatedAt: later.toISOString()
  };
  const exhausted = projectFirstProgressStopLoss({
    sessions,
    events: [],
    workItems: [],
    reviewRounds: [],
    integrations: []
  });
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.generationsBeforeFirstProgress, 2);
  assert.deepEqual(boundProviderRetryBeforeFirstProgress({
    delaysMs: [2_000, 5_000, 15_000],
    maxWindowMs: 600_000
  }, exhausted), {
    delaysMs: [2_000],
    maxWindowMs: 600_000
  });
  const progressed = projectFirstProgressStopLoss({
    sessions,
    events: [{
      id: "event-1",
      createdAt: later.toISOString(),
      payload: { leaderRunId: "agent-run-1" }
    }],
    workItems: [],
    reviewRounds: [],
    integrations: []
  });
  assert.equal(progressed.exhausted, false);
  assert.equal(progressed.firstProgressAt, later.toISOString());
  assert.deepEqual(boundProviderRetryBeforeFirstProgress({
    delaysMs: [2_000, 5_000, 15_000],
    maxWindowMs: 600_000
  }, progressed), {
    delaysMs: [2_000, 5_000, 15_000],
    maxWindowMs: 600_000
  });
});

test("the first-progress stop-loss records one durable Operator handoff", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-first-progress-stop-loss-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  store.saveConfiguredAgent(createConfiguredAgent(
    "agent", "codex", "codex", [], [], now
  ));
  const task = activateTask(createTask("task-1", "stop retry churn", now), now);
  store.saveTask(task);
  store.saveRole(task.id, createRole(
    task.id,
    "leader",
    [createRoleAgentBinding({ id: "agent", adapterId: "codex" })],
    "agent",
    "/tmp/yui-orchestration",
    now
  ));
  let sessions = taskSessions();
  sessions = updateRoleAgentSessionStatus(sessions, "agent", "broken", later);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "agent",
    adapterId: "codex",
    nativeSessionId: "session-2",
    launchId: "launch-2",
    status: "running",
    policy: "fixed",
    effective
  }, later);
  store.saveTaskRoleSessionSet(sessions);
  const projection = projectFirstProgressStopLoss({
    sessions,
    events: [],
    workItems: [],
    reviewRounds: [],
    integrations: []
  });
  const adapter = new FileSchedulerStoreAdapter(store);
  assert.equal(adapter.saveLeaderFirstProgressStopLoss({
    taskId: task.id,
    roleName: "leader",
    expectedFingerprint: projection.fingerprint,
    now: later
  }), "recorded");
  assert.equal(store.getRole(task.id, "leader").status, "failed");
  assert.match(store.getLeaderFailure(task.id).message, /first-progress stop-loss/u);
  assert.match(store.getOperatorNotification(task.id).message, /first-progress stop-loss/u);
  const mailbox = store.getWorkMailbox({ kind: "operator" });
  assert.equal(mailbox.pending.normal.requestCount, 1);
  assert.deepEqual(mailbox.pending.normal.reasons, ["leader-first-progress-stop-loss"]);
  assert.equal(adapter.saveLeaderFirstProgressStopLoss({
    taskId: task.id,
    roleName: "leader",
    expectedFingerprint: projection.fingerprint,
    now: later
  }), "state-changed");
  assert.equal(store.getWorkMailbox({ kind: "operator" }).pending.normal.requestCount, 1);
});

function job(overrides = {}) {
  return {
    id: "durable-job-1",
    taskId: "task-1",
    owner: { kind: "integration-attempt", integrationAttemptId: "integration-attempt-1" },
    projectId: "project-1",
    head: commit,
    env: { [INTEGRATION_RUNTIME_RELEASE_ENV]: "0.8.5-deadbeef" },
    steps: [{ name: "check-1", command: "npm test" }],
    status: "succeeded",
    result: {
      outcome: "succeeded",
      steps: [{
        name: "check-1",
        exitCode: 0,
        signal: null,
        timedOut: false,
        head: commit,
        logPath: "check.log"
      }]
    },
    ...overrides
  };
}

function attempt(overrides = {}) {
  return {
    id: "integration-attempt-1",
    taskId: "task-1",
    projectId: "project-1",
    checkCommands: ["npm test"],
    jobId: "durable-job-1",
    updatedAt: later.toISOString(),
    ...overrides
  };
}

test("Integration check reuse requires the complete exact identity", () => {
  const query = {
    taskId: "task-1",
    projectId: "project-1",
    currentAttemptId: "integration-attempt-2",
    candidateCommit: commit,
    checkCommands: ["npm test"],
    runtimeReleaseId: "0.8.5-deadbeef",
    attempts: [attempt()],
    jobs: [job()],
    logExists: (path) => path === "jobs/durable-job-1/logs/check.log",
    logPathFor: (sourceJob, relative) => `jobs/${sourceJob.id}/logs/${relative}`
  };
  const reused = findReusableIntegrationCheckEvidence(query);
  assert.equal(reused.sourceJob.id, "durable-job-1");
  assert.match(reused.checks[0].details, /Reused successful check evidence/u);
  assert.equal(reused.checks[0].logPath, "jobs/durable-job-1/logs/check.log");
  assert.equal(findReusableIntegrationCheckEvidence({
    ...query,
    checkCommands: ["npm test", "npm run lint"]
  }), null);
  assert.equal(findReusableIntegrationCheckEvidence({
    ...query,
    runtimeReleaseId: "0.8.6-other"
  }), null);
  assert.equal(findReusableIntegrationCheckEvidence({
    ...query,
    jobs: [job({ head: "b".repeat(40) })]
  }), null);
  assert.equal(findReusableIntegrationCheckEvidence({
    ...query,
    jobs: [job({ steps: [{ name: "check-1", command: "npm run test:other" }] })]
  }), null);
});

test("Git Integration reuses exact successful evidence without starting another job", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-integration-evidence-reuse-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const repository = join(root, "repository");
  mkdirSync(home, { recursive: true });
  mkdirSync(repository, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Yui Test"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "yui-test@example.invalid"], { cwd: repository });
  writeFileSync(join(repository, "value.txt"), "base\n");
  execFileSync("git", ["add", "value.txt"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repository });
  const base = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository, encoding: "utf8"
  }).trim();
  execFileSync("git", ["checkout", "-b", "change"], { cwd: repository });
  writeFileSync(join(repository, "value.txt"), "changed\n");
  execFileSync("git", ["commit", "-am", "change"], { cwd: repository });
  const candidate = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository, encoding: "utf8"
  }).trim();
  execFileSync("git", ["checkout", "main"], { cwd: repository });

  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const workspaceRoot = join(root, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  store.saveConfig({ ...store.getConfig(), defaultWorkspace: workspaceRoot });
  store.saveProject(createProject(
    "project-1", "repository", repository,
    { stable: "main", development: "main" }, now
  ));
  const task = activateTask(createTask("task-1", "reuse checks", now, {
    type: "feature",
    projectBindings: [{ projectId: "project-1", directory: "repository", baseRef: "main" }]
  }), now);
  store.saveTask(task);
  const item = createWorkItem("work-item-1", task.id, { title: "change" }, now);
  store.saveWorkItem(task.id, item);
  const changeSet = createWorkItemChangeSet({
    id: "change-set-1",
    taskId: task.id,
    workItemId: item.id,
    projectId: "project-1",
    baseCommit: base,
    headCommit: candidate,
    branch: "change",
    changedPaths: ["value.txt"]
  }, now);
  store.saveChangeSet(task.id, changeSet);

  const sourceAttempt = createIntegrationAttempt({
    id: "integration-1",
    taskId: task.id,
    projectId: "project-1",
    targetRef: "refs/heads/main",
    expectedHead: base,
    changeSetIds: [changeSet.id],
    checkCommands: ["npm test"]
  }, now);
  store.saveIntegrationAttempt(task.id, sourceAttempt);
  const artifactsLocator = "runtime/jobs/job-1";
  const relativeLogPath = "check.log";
  const logDirectory = join(home, artifactsLocator, "logs");
  mkdirSync(logDirectory, { recursive: true });
  writeFileSync(join(logDirectory, relativeLogPath), "passed\n");
  let sourceJob = createDurableJob({
    id: "job-1",
    taskId: task.id,
    owner: { kind: "integration-attempt", integrationAttemptId: sourceAttempt.id },
    projectId: "project-1",
    head: candidate,
    workspace: repository,
    env: { [INTEGRATION_RUNTIME_RELEASE_ENV]: "0.8.5-release" },
    steps: [{ name: "check-1", command: "npm test" }],
    artifactsLocator
  }, now);
  sourceJob = startDurableJob(sourceJob, { pid: 1, startIdentity: "test" }, now);
  sourceJob = completeDurableJob(sourceJob, {
    outcome: "succeeded",
    exitCode: 0,
    signal: null,
    evidenceSource: "exit-artifact",
    steps: [{
      name: "check-1",
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1,
      logPath: relativeLogPath,
      head: candidate
    }]
  }, later);
  store.saveDurableJob(task.id, sourceJob);
  store.saveIntegrationAttempt(task.id, updateIntegrationAttempt(
    recordIntegrationCheckJob(sourceAttempt, sourceJob.id, now),
    {
      status: "committed",
      candidateCommit: candidate,
      checks: [{ name: "npm test", outcome: "passed" }]
    },
    later
  ));
  const currentAttempt = createIntegrationAttempt({
    id: "integration-2",
    taskId: task.id,
    projectId: "project-1",
    targetRef: "refs/heads/main",
    expectedHead: base,
    changeSetIds: [changeSet.id],
    checkCommands: ["npm test"]
  }, later);
  store.saveIntegrationAttempt(task.id, currentAttempt);
  writeRuntimeIdentity(home, {
    schemaVersion: 1,
    version: "0.8.5",
    executablePath: process.execPath,
    args: [],
    buildId: "release",
    packageDigest: "digest",
    sourceCommit: null,
    cliRealpath: "/release/dist/cli.js",
    controllerRealpath: "/release/dist/controller.js",
    controllerProtocolVersion: 1,
    storageLayoutVersion: 1,
    aggregateSchemaVersion: 1,
    storageBackend: "sqlite",
    workerEnabled: true,
    pid: process.pid,
    processStartIdentity: "test",
    mode: "primary",
    dualOwner: false,
    activeRelease: {
      schemaVersion: 1,
      releaseId: "0.8.5-release",
      version: "0.8.5",
      buildId: "release",
      packageDigest: "digest",
      activatedAt: now.toISOString()
    },
    writtenAt: now.toISOString()
  });

  let starts = 0;
  let activations = 0;
  const service = new GitIntegrationService(
    home,
    store,
    undefined,
    () => later,
    process.env,
    {
      preflight: () => ({ release: () => {} }),
      activate: () => { activations += 1; },
      cleanup: () => {}
    },
    {
      startCheckJob: async () => { starts += 1; throw new Error("unexpected job start"); },
      getJob: async () => { throw new Error("unexpected job read"); },
      cancelJob: async () => {}
    }
  );
  const result = await service.integrate(task.id, currentAttempt.id);
  assert.equal(result.status, "committed");
  assert.equal(starts, 0);
  assert.equal(activations, 0);
  assert.equal(store.listDurableJobs(task.id).length, 1);
  assert.match(result.attempt.checks[0].details, /integration-1\/job-1/u);
  assert.equal(
    result.attempt.checks[0].logPath,
    join(artifactsLocator, "logs", relativeLogPath)
  );
  assert.equal(execFileSync("git", ["rev-parse", "main"], {
    cwd: repository, encoding: "utf8"
  }).trim(), candidate);
});

test("Operator status separates its unique writer from historical conversations", () => {
  let sessions = taskSessions({ scope: "global", roleName: "operator" });
  sessions = updateRoleAgentSessionStatus(sessions, "agent", "stopped", later);
  sessions = prepareOperatorNewSession(sessions, "agent", later);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "agent",
    adapterId: "codex",
    nativeSessionId: "session-2",
    launchId: "launch-2",
    status: "running",
    policy: "fixed",
    effective
  }, later);
  const status = projectOperatorStatus(sessions, "agent", "codex");
  assert.equal(status.writer.state, "active");
  assert.equal(status.writer.nativeSessionId, "session-2");
  assert.equal(status.historicalConversations.length, 1);
  assert.equal(status.historicalConversations[0].state, "history");

  const drifted = projectOperatorStatus(sessions, "replacement", "claude");
  assert.equal(drifted.writer.state, "unrecorded");
  assert.equal(drifted.writer.agentId, "replacement");
  assert.equal(drifted.historicalConversations.length, 2);
  assert.ok(drifted.historicalConversations.every(({ state }) => state === "history"));

  const adapterDrifted = projectOperatorStatus(sessions, "agent", "claude");
  assert.equal(adapterDrifted.writer.state, "unrecorded");
  assert.equal(adapterDrifted.historicalConversations.length, 2);
  assert.ok(adapterDrifted.historicalConversations.every(({ state }) => state === "history"));
});

test("operator status renders one writer separately from retained history", () => {
  let sessions = taskSessions({ scope: "global", roleName: "operator" });
  sessions = updateRoleAgentSessionStatus(sessions, "agent", "stopped", later);
  sessions = prepareOperatorNewSession(sessions, "agent", later);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "agent",
    adapterId: "codex",
    nativeSessionId: "session-2",
    launchId: "launch-2",
    status: "running",
    policy: "fixed",
    effective
  }, later);
  const role = createGlobalRole(
    "operator",
    [createRoleAgentBinding({ id: "agent", adapterId: "codex" })],
    "agent",
    "/tmp/yui-orchestration",
    now
  );
  const result = runOperatorCommand(["status"], {
    getGlobalRole: () => role,
    getGlobalRoleSessionSet: () => sessions
  }, { now: () => later });
  assert.equal(result.kind, "output");
  assert.match(result.output, /Active writer:\n  State: active/u);
  assert.match(result.output, /Historical conversations/u);
  assert.equal(result.data.writer.nativeSessionId, "session-2");
  assert.equal(result.data.historicalConversations.length, 1);
});

test("orchestration metrics expose protocol overhead without treating reuse as a rerun", () => {
  const task = {
    ...createTask("task-1", "small bug", now, {
      type: "bugfix",
      projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "main" }]
    }),
    status: "active"
  };
  const item = createWorkItem("work-item-1", task.id, { title: "unnecessary split" }, later);
  const metrics = projectTaskOrchestration({
    task,
    runs: [],
    roleSessionSets: [],
    workItems: [item],
    changeSets: [],
    reviewRounds: [],
    reviewFindings: [],
    integrations: [attempt({
      status: "committed",
      checks: [{
        name: "npm test",
        outcome: "passed",
        details: "Reused successful check evidence from integration-attempt-0/durable-job-1."
      }]
    })],
    durableJobs: [job()],
    publications: [],
    decisions: [],
    events: [],
    managedWorkspaces: []
  });
  assert.equal(metrics.taskType, "bugfix");
  assert.equal(metrics.workItems, 1);
  assert.equal(metrics.integrations.repeatedIdentities, 0);
  assert.equal(metrics.integrations.evidenceReuses, 1);
  assert.ok(metrics.advisories.some(({ code }) => code === "bugfix-workitem-overhead"));
  assert.ok(!metrics.advisories.some(({ code }) => code === "repeated-integration-check"));
});

test("execution audit exposes the orchestration projection without writes", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-orchestration-audit-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  store.saveProject(createProject(
    "project-1", "app", home, { stable: "main", development: "main" }, now
  ));
  const task = activateTask(createTask("task-1", "small bug", now, {
    type: "bugfix",
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "main" }]
  }), now);
  store.saveTask(task);
  store.saveWorkItem(task.id, createWorkItem("work-item-1", task.id, {
    title: "unnecessary split"
  }, later));
  const before = store.getRevision();
  const report = runExecutionAudit(home, { taskId: task.id }, {
    openStore: () => store,
    directorySize: () => null
  });
  assert.equal(report.orchestration.status, "ok");
  assert.equal(report.orchestration.data.tasks[0].workItems, 1);
  assert.equal(report.orchestration.data.advisoryCount, 1);
  assert.equal(store.getRevision(), before);
});
