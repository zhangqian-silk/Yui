import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { activateTask, archiveTask, completeTask, createTask } from "../../dist/task/task.js";
import {
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import {
  createAgentRun,
  failAgentRun,
  yieldAgentRun
} from "../../dist/run/agentRun.js";
import {
  createReviewRound,
  finishReviewRound
} from "../../dist/review/reviewRound.js";
import {
  createIntegrationAttempt,
  updateIntegrationAttempt
} from "../../dist/integration/integrationAttempt.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { createProject } from "../../dist/repository/project.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { runExecutionAudit } from "../../dist/observability/executionAudit.js";

function temporaryHome() {
  const home = mkdtempSync(join(tmpdir(), "yui-execution-audit-"));
  return {
    home,
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function effective(workspace) {
  return {
    schemaVersion: 2,
    sourceDesiredRevision: 1,
    agentId: "codex",
    adapterId: "codex",
    profileAccess: "read",
    search: false,
    permission: { strategy: "configured", sandbox: "read-only", approval: "never" },
    writeProjectIds: [],
    workspace: { root: workspace, entries: [] },
    context: {}
  };
}

function reviewWorkspace(workspace, reviewRoundId, baseCommit) {
  return {
    schemaVersion: 2,
    owner: { type: "review-round", taskId: "task-1", reviewRoundId },
    root: workspace,
    entries: [{
      projectId: "project-1",
      directory: "repo",
      access: "write",
      path: join(workspace, "repo"),
      branch: "review",
      baseRef: "master",
      baseCommit
    }],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
}

function reviewEffective(workspace, reviewRoundId, baseCommit) {
  const managed = reviewWorkspace(workspace, reviewRoundId, baseCommit);
  return {
    schemaVersion: 2,
    sourceDesiredRevision: 1,
    agentId: "codex",
    adapterId: "codex",
    profileAccess: "read",
    search: false,
    permission: { strategy: "configured", sandbox: "read-only", approval: "never" },
    writeProjectIds: [],
    workspace: { root: managed.root, entries: managed.entries },
    context: {},
    reviewRoundId,
    reviewBaseCommit: baseCommit
  };
}

const NOW = new Date("2026-08-17T00:00:00.000Z");
const LATER = new Date("2026-08-17T01:00:00.000Z");

function seedStore(home) {
  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);
  const workspace = join(home, "workspace");
  const task1 = activateTask(createTask("task-1", "Audit fixture one", NOW, {
    projectBindings: [{ projectId: "project-1", directory: "repo", baseRef: "master" }]
  }), NOW);
  const task2 = archiveTask(
    completeTask(activateTask(createTask("task-2", "Audit fixture two", NOW), NOW), NOW, {
      by: "user",
      summary: "fixture complete"
    }),
    LATER
  );
  let item = updateWorkItemStatus(
    createWorkItem("work-item-1", "task-1", { title: "fixture" }, NOW),
    "running",
    NOW
  );
  const candidateSummaries = ["candidate one", "candidate two", "candidate three"];
  for (let index = 0; index < candidateSummaries.length; index += 1) {
    item = submitWorkItemCandidate(
      item,
      { summary: candidateSummaries[index], source: { type: "direct" } },
      NOW
    );
    if (index < candidateSummaries.length - 1) {
      item = updateWorkItemStatus(item, "running", NOW);
    }
  }

  const runs = [];
  // 7 leader runs: 4 yielded (2 orphan wakes), 2 failed, 1 active
  for (let index = 0; index < 7; index += 1) {
    const run = createAgentRun(
      `agent-run-${index + 1}`,
      "task-1",
      "leader",
      "new",
      index < 2
        ? "Yui wakeup reasons: task-orphaned.\nContinue."
        : "Yui wakeup reasons: user-message.\nContinue.",
      new Date(NOW.getTime() + index * 60_000),
      { effective: effective(workspace) }
    );
    if (index < 4) {
      runs.push(yieldAgentRun(run, "state unchanged", new Date(NOW.getTime() + index * 60_000 + 30_000)));
    } else if (index < 6) {
      runs.push(failAgentRun(
        run,
        index === 4
          ? "Claude StopFailure. API Error: 504 Gateway Time-out."
          : "The role's tmux session exited before the run yielded.",
        new Date(NOW.getTime() + index * 60_000 + 30_000)
      ));
    } else {
      runs.push(run);
    }
  }
  // 2 reviewer runs (review purpose), 1 yielded 1 failed
  const reviewRun1 = yieldAgentRun(
    createAgentRun("agent-run-8", "task-1", "reviewer", "new", "review", new Date("2026-08-17T00:05:00.000Z"), {
      purpose: "review",
      workItemId: "work-item-1",
      reviewRoundId: "review-round-1",
      workspace: reviewWorkspace(workspace, "review-round-1", "a".repeat(40)),
      effective: reviewEffective(workspace, "review-round-1", "a".repeat(40))
    }),
    "looks good",
    new Date("2026-08-17T00:06:00.000Z")
  );
  const reviewRun2 = failAgentRun(
    createAgentRun("agent-run-9", "task-1", "reviewer", "new", "review", new Date("2026-08-17T00:07:00.000Z"), {
      purpose: "review",
      workItemId: "work-item-1",
      reviewRoundId: "review-round-2",
      workspace: reviewWorkspace(workspace, "review-round-2", "b".repeat(40)),
      effective: reviewEffective(workspace, "review-round-2", "b".repeat(40))
    }),
    "Role Run could not start: Command execution failed.",
    new Date("2026-08-17T00:08:00.000Z")
  );
  // 1 implementer run, yielded
  const implementerRun = yieldAgentRun(
    createAgentRun("agent-run-10", "task-1", "implementer-1", "new", "implement", new Date("2026-08-17T00:09:00.000Z"), {
      workItemId: "work-item-1",
      effective: effective(workspace)
    }),
    "done",
    new Date("2026-08-17T00:10:00.000Z")
  );

  const round1 = finishReviewRound(
    createReviewRound("review-round-1", "task-1", "work-item-1", "candidate-1", "reviewer", "policy", "a".repeat(40), NOW),
    "completed",
    "clean",
    LATER,
    { checks: [{ name: "build", outcome: "passed" }] }
  );
  const round2 = finishReviewRound(
    createReviewRound("review-round-2", "task-1", "work-item-1", "candidate-2", "reviewer", "policy", "b".repeat(40), NOW),
    "failed",
    "session died",
    LATER
  );
  const round3 = finishReviewRound(
    createReviewRound("review-round-3", "task-1", "work-item-1", "candidate-3", "reviewer", "leader", "c".repeat(40), NOW),
    "completed",
    "findings",
    LATER,
    { checks: [{ name: "tests", outcome: "failed", details: "2 failing" }] }
  );

  const integration1 = updateIntegrationAttempt(
    createIntegrationAttempt({
      id: "integration-1",
      taskId: "task-1",
      projectId: "project-1",
      targetRef: "master",
      expectedHead: "d".repeat(40),
      changeSetIds: ["change-set-1"],
      checkCommands: ["npm test"]
    }, NOW),
    { status: "committed", candidateCommit: "e".repeat(40) },
    LATER
  );
  const integration2 = updateIntegrationAttempt(
    createIntegrationAttempt({
      id: "integration-2",
      taskId: "task-1",
      projectId: "project-1",
      targetRef: "master",
      expectedHead: "f".repeat(40),
      changeSetIds: ["change-set-2"],
      checkCommands: ["npm test"]
    }, NOW),
    {
      status: "failed",
      checks: [{ name: "verify", outcome: "failed", details: "tsc: not found" }]
    },
    LATER
  );
  const integration3 = updateIntegrationAttempt(
    createIntegrationAttempt({
      id: "integration-3",
      taskId: "task-1",
      projectId: "project-1",
      targetRef: "master",
      expectedHead: "e".repeat(40),
      changeSetIds: ["change-set-3"],
      checkCommands: ["npm test"]
    }, NOW),
    { status: "committed", candidateCommit: "e".repeat(40) },
    LATER
  );

  const changeSets = [1, 2, 3].map((sequence) => createWorkItemChangeSet({
    id: `change-set-${sequence}`,
    taskId: "task-1",
    projectId: "project-1",
    workItemId: "work-item-1",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    branch: `codex/change-${sequence}`,
    changedPaths: [`src/file-${sequence}.ts`]
  }, NOW));

  const events = [
    ...Array.from({ length: 12 }, (_, index) =>
      createTaskEvent(`event-${index + 1}`, "task-1", "runtime.provider-turn-progress", {}, NOW)),
    createTaskEvent("event-13", "task-1", "runtime.role-session-reset", {}, NOW),
    createTaskEvent("event-14", "task-1", "runtime.role-session-reset", {}, NOW),
    createTaskEvent("event-15", "task-1", "runtime.provider-session-lifecycle", {}, NOW),
    createTaskEvent("event-16", "task-1", "runtime.claude-stop-failure", {}, NOW),
    createTaskEvent("event-17", "task-1", "runtime.event-obsolete", {}, NOW),
    createTaskEvent("event-18", "task-1", "runtime.event-obsolete", {}, NOW),
    createTaskEvent("event-19", "task-1", "runtime.event-obsolete", {}, NOW),
    createTaskEvent("event-20", "task-1", "run.dispatched", {}, NOW)
  ];
  const messages = [
    createTaskMessage("message-1", "task-1", "hello", "user", { type: "user" }, NOW),
    createTaskMessage("message-2", "task-1", "world", "user", { type: "user" }, NOW),
    createTaskMessage("message-3", "task-1", "ok", "role-result", { type: "role", roleName: "leader" }, NOW),
    createTaskMessage("message-4", "task-1", "done", "role-result", { type: "role", roleName: "implementer-1" }, NOW)
  ];

  const sessionSet = {
    schemaVersion: 4,
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    activeAgentId: "codex",
    sessions: {
      codex: {
        schemaVersion: 3,
        agentId: "codex",
        adapterId: "codex",
        nativeSessionId: "native-3",
        policy: "fixed",
        effective: effective(workspace),
        status: "running",
        recentCompletedTurnIds: [],
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString()
      }
    },
    history: [
      {
        schemaVersion: 3,
        agentId: "codex",
        adapterId: "codex",
        nativeSessionId: "native-1",
        policy: "fixed",
        effective: effective(workspace),
        status: "broken",
        recentCompletedTurnIds: [],
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString()
      },
      {
        schemaVersion: 3,
        agentId: "codex",
        adapterId: "codex",
        nativeSessionId: "native-2",
        policy: "fixed",
        effective: effective(workspace),
        status: "stopped",
        recentCompletedTurnIds: [],
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString()
      }
    ],
    inFlight: null,
    pendingTurnCompletion: null,
    updatedAt: NOW.toISOString()
  };

  store.transaction((tx) => {
    tx.saveProject(createProject(
      "project-1",
      "Fixture Project",
      join(home, "project"),
      { stable: "master", development: "dev" },
      NOW
    ));
    tx.saveTask(task1);
    tx.saveTask(task2);
    tx.saveWorkItem("task-1", item);
    tx.saveReviewRound("task-1", round1);
    tx.saveReviewRound("task-1", round2);
    tx.saveReviewRound("task-1", round3);
    for (const run of [...runs, reviewRun1, reviewRun2, implementerRun]) {
      tx.saveAgentRun(run);
    }
    for (const changeSet of changeSets) {
      tx.saveChangeSet("task-1", changeSet);
    }
    tx.saveIntegrationAttempt("task-1", integration1);
    tx.saveIntegrationAttempt("task-1", integration2);
    tx.saveIntegrationAttempt("task-1", integration3);
    for (const event of events) tx.saveEvent("task-1", event);
    for (const message of messages) tx.saveMessage("task-1", message);
    tx.saveTaskRoleWithSessionSet(
      createRole(
        "task-1",
        "leader",
        [createRoleAgentBinding({ id: "codex", adapterId: "codex" })],
        "codex",
        workspace,
        NOW
      ),
      sessionSet
    );
  });
  return store;
}

test("execution audit recomputes the seeded totals", () => {
  const { home, cleanup } = temporaryHome();
  try {
    const store = seedStore(home);
    const report = runExecutionAudit(home, {}, {
      openStore: () => store,
      directorySize: () => 0
    });

    assert.equal(report.tasks.status, "ok");
    assert.deepEqual(report.tasks.data, { total: 2, archived: 1, active: 1 });

    assert.equal(report.runs.status, "ok");
    assert.equal(report.runs.data.total, 10);
    assert.equal(report.runs.data.failed, 3);
    assert.equal(report.runs.data.yielded, 6);
    assert.equal(report.runs.data.active, 1);
    assert.equal(report.runs.data.byRole.leader, 7);
    assert.equal(report.runs.data.byRole.reviewer, 2);
    assert.equal(report.runs.data.byRole.implementer, 1);
    assert.equal(report.runs.data.byPurpose.execution, 8);
    assert.equal(report.runs.data.byPurpose.review, 2);
    assert.equal(report.runs.data.faultClasses["provider-transient"], 1);
    assert.equal(report.runs.data.faultClasses["session-dead"], 2);

    assert.equal(report.wakes.status, "ok");
    assert.equal(report.wakes.data.leaderRuns, 7);
    assert.equal(report.wakes.data.orphanWakes, 2);
    assert.equal(report.wakes.data.orphanYieldOnly, 2);
    assert.equal(report.wakes.data.suppressedWakes.status, "unsupported");

    assert.equal(report.sessions.status, "ok");
    assert.equal(report.sessions.data.generations, 3);
    assert.equal(report.sessions.data.broken, 1);
    assert.equal(report.sessions.data.stopped, 1);
    assert.equal(report.sessions.data.resets, 2);
    assert.equal(report.sessions.data.lifecycleEvents, 1);
    assert.equal(report.sessions.data.stopFailures, 1);

    assert.equal(report.reviews.status, "ok");
    assert.equal(report.reviews.data.total, 3);
    assert.equal(report.reviews.data.completed, 2);
    assert.equal(report.reviews.data.failed, 1);
    assert.equal(report.reviews.data.infraFailed, 1);
    assert.equal(report.reviews.data.semanticNegative, 1);

    assert.equal(report.integrations.status, "ok");
    assert.equal(report.integrations.data.total, 3);
    assert.equal(report.integrations.data.committed, 2);
    assert.equal(report.integrations.data.failed, 1);
    assert.equal(report.integrations.data.environmentFailures, 1);
    assert.equal(report.integrations.data.gateReuse, 1);

    assert.equal(report.events.status, "ok");
    assert.equal(report.events.data.total, 20);
    assert.equal(report.events.data.progressEvents, 12);
    assert.equal(report.events.data.semanticEvents, 8);
    assert.equal(report.events.data.obsoleteEvents, 3);
    assert.equal(report.events.data.messages, 4);

    assert.equal(report.workItems.status, "ok");
    assert.equal(report.workItems.data.total, 1);
    assert.equal(report.workItems.data.completed, 0);

    assert.equal(report.topLongRunning.status, "ok");
    assert.ok(report.topLongRunning.data.length > 0);
  } finally {
    cleanup();
  }
});

test("execution audit filters by task and time window", () => {
  const { home, cleanup } = temporaryHome();
  try {
    const store = seedStore(home);
    const byTask = runExecutionAudit(home, { taskId: "task-2" }, {
      openStore: () => store,
      directorySize: () => 0
    });
    assert.equal(byTask.tasks.data.total, 1);
    assert.equal(byTask.runs.data.total, 0);

    const windowed = runExecutionAudit(
      home,
      {
        since: new Date("2026-08-17T00:06:00.000Z"),
        until: new Date("2026-08-17T00:09:00.000Z")
      },
      { openStore: () => store, directorySize: () => 0 }
    );
    // Runs created between 00:06 and 00:09 inclusive: agent-run-7 (00:06),
    // agent-run-8 (00:05 no), agent-run-9 (00:07), agent-run-10 (00:09).
    assert.equal(windowed.runs.data.total, 3);
  } finally {
    cleanup();
  }
});

test("execution audit degrades to error sections when the store cannot open", () => {
  const { home, cleanup } = temporaryHome();
  try {
    const report = runExecutionAudit(home, {}, {
      openStore: () => {
        throw new Error("store locked");
      },
      directorySize: () => 0
    });
    assert.equal(report.runs.status, "error");
    assert.match(report.runs.error, /store locked/u);
    assert.equal(report.events.status, "error");
  } finally {
    cleanup();
  }
});

test("execution audit renderer includes the core totals", async () => {
  const { home, cleanup } = temporaryHome();
  try {
    const store = seedStore(home);
    const report = runExecutionAudit(home, {}, {
      openStore: () => store,
      directorySize: () => 0
    });
    const { renderExecutionAudit } = await import(
      "../../dist/commands/executionAuditCommands.js"
    );
    const text = renderExecutionAudit(report, 4000);
    assert.match(text, /Agent runs: 10 total/);
    assert.match(text, /3 failed/);
    assert.match(text, /orphan wakes/);
    assert.match(text, /Review rounds: 3 total/);
    assert.match(text, /Integration attempts: 3 total/);
    assert.match(text, /provider-progress/);
  } finally {
    cleanup();
  }
});
