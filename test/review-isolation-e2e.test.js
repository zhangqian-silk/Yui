import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../dist/agent/agent.js";
import { runTaskIntegrationCommand } from "../dist/commands/taskIntegrationCommands.js";
import {
  dispatchPreparedReviewRound,
  runTaskCommand
} from "../dist/commands/taskCommands.js";
import {
  bindExecution,
  claimPending,
  createWorkMailbox,
  enqueueSignal
} from "../dist/coordination/workMailbox.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../dist/executor/agentExecutor.js";
import { createWorkItemChangeSet } from "../dist/integration/changeSet.js";
import { createProject } from "../dist/repository/project.js";
import { FileTaskWorkspacePreparer } from "../dist/repository/taskWorkspacePreparer.js";
import {
  createGlobalRole,
  createRole,
  createRoleAgentBinding
} from "../dist/role/role.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { activateTask, createTask } from "../dist/task/task.js";
import {
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../dist/workItem/workItem.js";
import { WorkItemChangeSetManager } from "../dist/workspace/workItemChangeSetManager.js";
import { createIsolatedRuntime } from "./helpers/isolatedRuntime.js";
import { exactTaskCliInvocation } from "./helpers/exactTaskCli.js";

const START = new Date("2026-08-03T08:00:00.000Z");

test("managed ReviewRound isolates writable diagnostic evidence from Candidate delivery", async (t) => {
  const requestedRoot = process.env.YUI_REVIEW_E2E_ROOT;
  const isolated = createIsolatedRuntime(t, requestedRoot === undefined
    ? {}
    : { root: resolve(requestedRoot), retainRoot: true });
  const { root, home } = isolated;
  const mockCodex = createMockCodexExecutable(root);
  const sourceRepository = initializeFixtureRepository(root);
  assert.notEqual(resolve(process.env.YUI_HOME ?? join(root, "unconfigured")), resolve(home));
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent(
    "codex-review",
    "codex",
    mockCodex.command,
    [],
    [],
    START
  );
  assert.equal(agent.command, mockCodex.command);
  assert.equal(agent.command.startsWith(`${root}/`), true);
  const binding = createRoleAgentBinding(agent, {
    adapterId: "codex",
    model: "gpt-review-e2e",
    effort: "max",
    search: true,
    permission: { strategy: "bypass" }
  });
  const project = createProject(
    "project-1",
    "fixture",
    sourceRepository,
    { stable: "main", development: "main" },
    START,
    { remoteUrl: sourceRepository }
  );
  const task = activateTask(createTask("task-1", "Review isolation", START, {
    projectBindings: [{
      projectId: project.id,
      directory: project.name,
      baseRef: project.developmentBranch
    }]
  }), START);
  store.transaction((tx) => {
    tx.saveConfig({
      schemaVersion: 1,
      defaultAgent: agent.id,
      defaultWorkspace: root,
      review: { roleName: "reviewer", trigger: "always" }
    });
    tx.saveConfiguredAgent(agent);
    tx.saveProject(project);
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [binding],
      agent.id,
      root,
      START,
      {},
      "write"
    ));
    tx.saveTask(task);
    for (const roleName of ["leader", "worker"]) {
      tx.saveRole(task.id, createRole(
        task.id,
        roleName,
        [binding],
        agent.id,
        sourceRepository,
        START,
        {},
        "write"
      ));
    }
  });

  const runtime = noOpRuntime();
  let now = new Date(START);
  const preparer = new FileTaskWorkspacePreparer(home, store, undefined, () => now);
  await preparer.prepareTaskWorkspace(task.id);
  const item = createWorkItem("work-item-1", task.id, {
    title: "Produce a reviewable Candidate",
    assignee: "worker",
    writeProjectIds: [project.id]
  }, now);
  store.saveWorkItem(task.id, item);
  const workerWorkspace = await preparer.prepareWorkItemWorkspace(task.id, item.id);
  const workerEntry = workerWorkspace.entries[0];
  const leaderOptions = commandOptions(task.id, "leader", runtime, now);
  runTaskCommand(["work", "dispatch", item.id], store, leaderOptions);
  const candidateRun = store.getActiveAgentRun(task.id, "worker");
  assert.notEqual(candidateRun, null);

  writeFileSync(join(workerEntry.path, "candidate.txt"), "frozen candidate bytes\n");
  git(workerEntry.path, "add", "candidate.txt");
  git(workerEntry.path, "commit", "-qm", "candidate");
  const candidateCommit = git(workerEntry.path, "rev-parse", "HEAD");
  const candidateTree = git(workerEntry.path, "rev-parse", "HEAD^{tree}");
  const candidateBytes = readFileSync(join(workerEntry.path, "candidate.txt"), "utf8");
  const candidateStatus = git(workerEntry.path, "status", "--porcelain=v1");
  const candidateSnapshot = await preparer.snapshotCandidateWorkspace(workerWorkspace);

  markDelivered(store, candidateRun, now);
  runTaskCommand([
    "run", "yield", candidateRun.id,
    "--summary", "Frozen Candidate is ready."
  ], store, {
    now: () => now,
    runtime,
    environment: { YUI_TASK_ID: task.id },
    candidateGitSnapshot: candidateSnapshot
  });
  const candidateCount = store.getWorkItem(task.id, item.id).candidates.length;
  const [pendingRound] = store.listReviewRounds(task.id);
  assert.equal(pendingRound.status, "pending");
  assert.equal(pendingRound.reviewBaseCommit, candidateCommit);

  now = new Date(START.getTime() + 1_000);
  const reviewWorkspace = await preparer.prepareReviewRoundWorkspace(task.id, pendingRound.id);
  const reviewRun = dispatchPreparedReviewRound(task.id, pendingRound.id, store, {
    now: () => now,
    runtime,
    environment: { YUI_TASK_ID: task.id }
  });
  markDelivered(store, reviewRun, now);
  const reviewEntry = reviewWorkspace.entries[0];
  assert.notEqual(reviewWorkspace.root, workerWorkspace.root);
  assert.notEqual(reviewEntry.path, workerEntry.path);
  assert.deepEqual(reviewWorkspace.owner, {
    type: "review-round",
    taskId: task.id,
    reviewRoundId: pendingRound.id
  });
  assert.equal(reviewEntry.access, "write");
  assert.equal(reviewEntry.baseCommit, candidateCommit);
  assert.equal(git(reviewEntry.path, "rev-parse", "HEAD"), candidateCommit);
  assert.equal(reviewRun.effective.profileAccess, "write");
  assert.deepEqual(reviewRun.effective.permission, { strategy: "bypass" });
  assert.equal(reviewRun.effective.reviewRoundId, pendingRound.id);
  assert.equal(reviewRun.effective.reviewBaseCommit, candidateCommit);
  assert.equal(reviewRun.effective.workspace.root, reviewWorkspace.root);

  const captureProbe = {
    ...submitWorkItemCandidate(
      updateWorkItemStatus(createWorkItem("work-item-2", task.id, {
        title: "Reject Review workspace capture"
      }, now), "running", now),
    { summary: "API guard probe.", source: { type: "direct" } },
    now
    ),
    assignee: "reviewer",
    writeProjectIds: [project.id]
  };
  await assert.rejects(
    new WorkItemChangeSetManager(
      taskStoreWithWorkItem(store, captureProbe, reviewWorkspace),
      () => now
    ).capture(task.id, captureProbe.id),
    /ReviewRound-owned workspace cannot be captured/
  );
  await assert.rejects(
    preparer.snapshotCandidateWorkspace(reviewWorkspace),
    /ReviewRound workspace cannot become a WorkItem Candidate source/
  );

  writeFileSync(
    join(reviewEntry.path, "test", "reproduction.test.js"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { add } from "../src.js";',
      'test("review reproduction", () => assert.equal(add(2, 3), 5));',
      ""
    ].join("\n")
  );
  execFileSync("npm", ["run", "build"], { cwd: reviewEntry.path, stdio: "pipe" });
  execFileSync("npm", ["test"], { cwd: reviewEntry.path, stdio: "pipe" });
  git(reviewEntry.path, "add", "test/reproduction.test.js");
  git(reviewEntry.path, "commit", "-qm", "diagnostic reproduction");
  const reviewResult = await preparer.snapshotReviewRoundResult(task.id, pendingRound.id);
  const evidenceCommit = reviewResult.evidenceCommit;
  assert.notEqual(evidenceCommit, undefined);
  assert.notEqual(evidenceCommit, candidateCommit);

  assert.equal(git(workerEntry.path, "rev-parse", "HEAD"), candidateCommit);
  assert.equal(git(workerEntry.path, "rev-parse", "HEAD^{tree}"), candidateTree);
  assert.equal(git(workerEntry.path, "status", "--porcelain=v1"), candidateStatus);
  assert.equal(readFileSync(join(workerEntry.path, "candidate.txt"), "utf8"), candidateBytes);

  now = new Date(START.getTime() + 2_000);
  const committedYield = yieldReview(store, task.id, reviewRun.id, {
    summary: "Diagnostic reproduction committed; Candidate remains immutable.",
    checks: [
      {
        name: "npm run build",
        outcome: "passed",
        details: "node --check src.js completed"
      },
      {
        name: "npm test",
        outcome: "passed",
        details: "base and reproduction tests passed"
      }
    ],
    evidenceCommit
  }, reviewResult, runtime, now);
  assert.equal(committedYield.kind, "output");
  const completedRound = store.getReviewRound(task.id, pendingRound.id);
  assert.equal(completedRound.status, "completed");
  assert.equal(
    store.getAgentRun(task.id, reviewRun.id).summary,
    "Diagnostic reproduction committed; Candidate remains immutable."
  );
  assert.equal(completedRound.evidenceCommit, evidenceCommit);
  assert.deepEqual(completedRound.checks, [
    {
      name: "npm run build",
      outcome: "passed",
      details: "node --check src.js completed"
    },
    {
      name: "npm test",
      outcome: "passed",
      details: "base and reproduction tests passed"
    }
  ]);
  assert.equal(store.getWorkItem(task.id, item.id).candidates.length, candidateCount);
  assert.deepEqual(store.listChangeSets(task.id), []);
  assert.throws(
    () => runTaskCommand([
      "run", "yield", reviewRun.id,
      "--summary", "Late duplicate yield."
    ], store, {
      now: () => now,
      runtime,
      environment: { YUI_TASK_ID: task.id }
    }),
    /already terminal/i
  );

  const evidenceChangeSet = createWorkItemChangeSet({
    id: "change-set-1",
    taskId: task.id,
    workItemId: item.id,
    projectId: project.id,
    baseCommit: candidateCommit,
    headCommit: evidenceCommit,
    branch: reviewEntry.branch,
    changedPaths: ["test/reproduction.test.js"]
  }, now);
  assert.throws(
    () => store.saveChangeSet(task.id, evidenceChangeSet),
    /ReviewRound evidence commit.*cannot become a ChangeSet/
  );
  const integrationGuardStore = taskStoreWithChangeSet(store, evidenceChangeSet);
  await assert.rejects(
    runTaskIntegrationCommand([
      "start", task.id,
      "--change-set", evidenceChangeSet.id
    ], integrationGuardStore, home, { now: () => now }),
    /ReviewRound evidence commit cannot become an Integration source/
  );
  assert.throws(
    () => runTaskCommand([
      "work", "accept", item.id,
      "--summary", "Review evidence is not delivery evidence."
    ], store, {
      ...leaderOptions,
      now: () => now,
      workItemIntegrationProof: {
        workItemId: item.id,
        assignee: "reviewer",
        workspace: reviewWorkspace,
        projects: [{
          projectId: project.id,
          baseCommit: candidateCommit,
          headCommit: evidenceCommit
        }]
      }
    }),
    /ReviewRound-owned workspace.*acceptance/
  );

  assert.equal(await preparer.cleanupReviewRoundWorkspace(task.id, pendingRound.id), "removed");
  assert.equal(existsSync(reviewEntry.path), false);
  assert.equal(existsSync(workerEntry.path), true);
  assert.equal(git(workerEntry.path, "rev-parse", "HEAD"), candidateCommit);
  assert.equal(store.getReviewRound(task.id, pendingRound.id).workspaceDisposition.kind, "removed");

  recordReadyWorkerSession(store, candidateRun, now);
  runTaskCommand([
    "work", "reject", item.id,
    "--summary", `Route diagnostic evidence ${evidenceCommit} to the original Worker.`
  ], store, { ...leaderOptions, now: () => now });
  runTaskCommand([
    "work", "dispatch", item.id,
    "--input", `Inspect diagnostic evidence ${evidenceCommit}; repair only in the Worker workspace.`
  ], store, { ...leaderOptions, now: () => now });
  const resumedWorker = store.getActiveAgentRun(task.id, "worker");
  assert.equal(resumedWorker.mode, "resume");
  assert.equal(resumedWorker.workspace.root, workerWorkspace.root);
  assert.match(resumedWorker.input, new RegExp(evidenceCommit));
  writeFileSync(join(workerEntry.path, "worker-follow-up.txt"), "original Worker continued\n");
  git(workerEntry.path, "add", "worker-follow-up.txt");
  git(workerEntry.path, "commit", "-qm", "worker follow-up");
  const continuedCommit = git(workerEntry.path, "rev-parse", "HEAD");
  assert.notEqual(continuedCommit, evidenceCommit);
  assert.equal(store.getWorkItem(task.id, item.id).candidates[0].gitSnapshot.reviewBaseCommit, candidateCommit);

  const continuedTree = git(workerEntry.path, "rev-parse", "HEAD^{tree}");
  const continuedStatus = git(workerEntry.path, "status", "--porcelain=v1");
  const continuedBytes = readFileSync(join(workerEntry.path, "worker-follow-up.txt"), "utf8");
  markDelivered(store, resumedWorker, now);
  const continuedSnapshot = await preparer.snapshotCandidateWorkspace(workerWorkspace);
  runTaskCommand([
    "run", "yield", resumedWorker.id,
    "--summary", "Original Worker follow-up is ready."
  ], store, {
    now: () => now,
    runtime,
    environment: { YUI_TASK_ID: task.id },
    candidateGitSnapshot: continuedSnapshot
  });
  const secondCandidateCount = store.getWorkItem(task.id, item.id).candidates.length;
  assert.equal(secondCandidateCount, candidateCount + 1);
  const secondRound = store.listReviewRounds(task.id).at(-1);
  assert.notEqual(secondRound.id, pendingRound.id);
  assert.equal(secondRound.status, "pending");
  assert.equal(secondRound.reviewBaseCommit, continuedCommit);
  const dirtyReviewWorkspace = await preparer.prepareReviewRoundWorkspace(
    task.id,
    secondRound.id
  );
  const dirtyReviewEntry = dirtyReviewWorkspace.entries[0];
  const dirtyReviewRun = dispatchPreparedReviewRound(task.id, secondRound.id, store, {
    now: () => now,
    runtime,
    environment: { YUI_TASK_ID: task.id }
  });
  assert.equal(dirtyReviewRun.reviewRoundId, secondRound.id);
  markDelivered(store, dirtyReviewRun, now);

  writeFileSync(
    join(dirtyReviewEntry.path, "test", "dirty-no-commit.test.js"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { add } from "../src.js";',
      'test("dirty review diagnosis", () => assert.equal(add(4, 5), 9));',
      ""
    ].join("\n")
  );
  execFileSync("npm", ["run", "build"], { cwd: dirtyReviewEntry.path, stdio: "pipe" });
  execFileSync("npm", ["test"], { cwd: dirtyReviewEntry.path, stdio: "pipe" });
  assert.notEqual(git(dirtyReviewEntry.path, "status", "--porcelain=v1"), "");
  const dirtyReviewResult = await preparer.snapshotReviewRoundResult(task.id, secondRound.id);

  const dirtyYield = yieldReview(store, task.id, dirtyReviewRun.id, {
    summary: "Uncommitted diagnosis reproduced the behavior; preserve for Leader judgment.",
    checks: [
      {
        name: "npm run build",
        outcome: "passed",
        details: "review source parsed successfully"
      },
      {
        name: "npm test",
        outcome: "passed",
        details: "dirty reproduction and base tests passed"
      }
    ]
  }, dirtyReviewResult, runtime, now);
  assert.equal(dirtyYield.kind, "output");
  const dirtyCompletedRound = store.getReviewRound(task.id, secondRound.id);
  assert.equal(dirtyCompletedRound.status, "completed");
  assert.equal(dirtyCompletedRound.evidenceCommit, undefined);
  assert.equal(dirtyCompletedRound.checks.length, 2);
  assert.equal(store.getWorkItem(task.id, item.id).candidates.length, secondCandidateCount);
  assert.equal(git(workerEntry.path, "rev-parse", "HEAD"), continuedCommit);
  assert.equal(git(workerEntry.path, "rev-parse", "HEAD^{tree}"), continuedTree);
  assert.equal(git(workerEntry.path, "status", "--porcelain=v1"), continuedStatus);
  assert.equal(readFileSync(join(workerEntry.path, "worker-follow-up.txt"), "utf8"), continuedBytes);

  const preserve = reviewWorkspaceCommand(home, store, task.id, "preserve", secondRound.id);
  assert.equal(preserve.status, 0, preserve.stderr || preserve.error?.message);
  assert.equal(
    store.getReviewRound(task.id, secondRound.id).workspaceDisposition.kind,
    "preserved"
  );
  const dirtyCleanup = reviewWorkspaceCommand(home, store, task.id, "cleanup", secondRound.id);
  assert.notEqual(dirtyCleanup.status, 0);
  assert.match(dirtyCleanup.stderr, /dirty and was retained/i);
  assert.equal(existsSync(dirtyReviewEntry.path), true);
  assert.equal(
    store.getReviewRound(task.id, secondRound.id).workspaceDisposition.kind,
    "preserved"
  );

  git(dirtyReviewEntry.path, "add", "test/dirty-no-commit.test.js");
  git(dirtyReviewEntry.path, "commit", "-qm", "preserved post-yield diagnosis");
  assert.equal(git(dirtyReviewEntry.path, "status", "--porcelain=v1"), "");
  const cleanCleanup = reviewWorkspaceCommand(home, store, task.id, "cleanup", secondRound.id);
  assert.equal(cleanCleanup.status, 0, cleanCleanup.stderr || cleanCleanup.error?.message);
  assert.equal(existsSync(dirtyReviewEntry.path), false);
  assert.equal(existsSync(workerEntry.path), true);
  assert.equal(git(workerEntry.path, "rev-parse", "HEAD"), continuedCommit);
  assert.equal(store.getReviewRound(task.id, secondRound.id).evidenceCommit, undefined);
  assert.equal(
    store.getReviewRound(task.id, secondRound.id).workspaceDisposition.kind,
    "removed"
  );

  const report = {
    schemaVersion: 1,
    yuiHome: home,
    sourceRepository,
    taskId: task.id,
    workItemId: item.id,
    reviewRoundId: pendingRound.id,
    dirtyReviewRoundId: secondRound.id,
    candidateCommit,
    reviewBaseCommit: completedRound.reviewBaseCommit,
    evidenceCommit,
    continuedWorkerCommit: continuedCommit,
    candidateCountAfterReview: candidateCount,
    candidateCountAfterDirtyReview: secondCandidateCount,
    reviewWorkspace: {
      root: reviewWorkspace.root,
      branch: reviewEntry.branch,
      disposition: store.getReviewRound(task.id, pendingRound.id).workspaceDisposition.kind
    },
    effective: {
      agentId: reviewRun.effective.agentId,
      adapterId: reviewRun.effective.adapterId,
      model: reviewRun.effective.model,
      effort: reviewRun.effective.effort,
      profileAccess: reviewRun.effective.profileAccess,
      permission: reviewRun.effective.permission
    },
    mockProvider: {
      command: mockCodex.command,
      launchObserved: existsSync(mockCodex.observationPath)
    },
    checks: completedRound.checks,
    dirtyNoCommit: {
      evidenceCommit: dirtyCompletedRound.evidenceCommit ?? null,
      checks: dirtyCompletedRound.checks,
      preserveStatus: preserve.status,
      dirtyCleanupStatus: dirtyCleanup.status,
      cleanCleanupStatus: cleanCleanup.status,
      disposition: store.getReviewRound(task.id, secondRound.id).workspaceDisposition.kind
    },
    guards: ["capture", "candidate", "change-set", "integration", "accept"],
    workerWorkspacePreserved: existsSync(workerEntry.path)
  };
  writeFileSync(
    join(root, "review-isolation-e2e-report.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
});

function createMockCodexExecutable(root) {
  const bin = join(root, "mock-bin");
  const command = join(bin, "codex");
  const observationPath = join(root, "mock-codex-launch.ndjson");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  writeFileSync(command, [
    `#!${process.execPath}`,
    'const { appendFileSync } = require("node:fs");',
    `const observationPath = ${JSON.stringify(observationPath)};`,
    "appendFileSync(observationPath, `${JSON.stringify({",
    "  pid: process.pid,",
    "  yuiHome: process.env.YUI_HOME ?? null,",
    "  taskId: process.env.YUI_TASK_ID ?? null,",
    "  role: process.env.YUI_ROLE ?? null",
    "})}\\n`);",
    "const stop = () => process.exit(0);",
    'process.on("SIGINT", stop);',
    'process.on("SIGTERM", stop);',
    "setInterval(() => {}, 60_000);",
    ""
  ].join("\n"), { mode: 0o700 });
  return { command, observationPath };
}

function initializeFixtureRepository(root) {
  const repository = join(root, "fixture-repository");
  execFileSync("git", ["init", "-q", "-b", "main", repository]);
  git(repository, "config", "user.name", "Yui Review E2E");
  git(repository, "config", "user.email", "review-e2e@example.invalid");
  writeFileSync(join(repository, "package.json"), `${JSON.stringify({
    name: "review-isolation-fixture",
    private: true,
    type: "module",
    scripts: {
      build: "node --check src.js",
      test: "node --test test/*.test.js"
    }
  }, null, 2)}\n`);
  writeFileSync(join(repository, "src.js"), "export const add = (left, right) => left + right;\n");
  mkdirSync(join(repository, "test"), { recursive: true });
  writeFileSync(
    join(repository, "test", "base.test.js"),
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { add } from "../src.js";',
      'test("base", () => assert.equal(add(1, 1), 2));',
      ""
    ].join("\n")
  );
  git(repository, "add", ".");
  git(repository, "commit", "-qm", "initial fixture");
  return repository;
}

function commandOptions(taskId, roleName, runtime, now) {
  return {
    now: () => now,
    runtime,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: taskId,
      YUI_ROLE: roleName
    }
  };
}

function noOpRuntime() {
  return {
    notifyStateChanged() {},
    reconcileTask() {},
    prepareTaskRoleEnter() {}
  };
}

function yieldReview(store, taskId, runId, result, reviewWorkspaceResult, runtime, now) {
  // This E2E owns Review workspace/result isolation, not managed CLI transport.
  // Keep its state transitions on the fixture clock; exact CLI and
  // --summary-file transport have dedicated regression coverage.
  return runTaskCommand([
    "run", "yield", runId,
    "--summary", JSON.stringify(result)
  ], store, {
    now: () => now,
    runtime,
    environment: { YUI_TASK_ID: taskId },
    reviewWorkspaceResult
  });
}

function reviewWorkspaceCommand(home, store, taskId, command, reviewRoundId) {
  const invocation = exactTaskCliInvocation({
    home,
    store,
    taskId,
    roleName: "leader"
  });
  const result = spawnSync(
    process.execPath,
    [
      invocation.cliEntry,
      ...invocation.prefix,
      "task", "work", "review", command, `${taskId}/${reviewRoundId}`
    ],
    {
      encoding: "utf8",
      env: invocation.environment,
      timeout: 10_000
    }
  );
  if (result.status === 0) invocation.completeFixtureRuntimeReservation();
  return result;
}

function markDelivered(store, run, now) {
  store.transaction((tx) => {
    const target = { kind: "role", taskId: run.taskId, roleName: run.roleName };
    let mailbox = tx.getWorkMailbox(target) ?? createWorkMailbox(target);
    if (mailbox.processing === null) {
      if (mailbox.pending === null) {
        mailbox = enqueueSignal(mailbox, {
          reason: "review-e2e-run-dispatched",
          refs: [{ type: "run", taskId: run.taskId, id: run.id }],
          occurredAt: now.toISOString()
        });
      }
      const batchId = `agent-run:${run.taskId}/${run.id}`;
      mailbox = bindExecution(
        claimPending(mailbox, {
          batchId,
          owner: "controller",
          startedAt: now.toISOString()
        }),
        batchId,
        { type: "run", taskId: run.taskId, id: run.id }
      );
      tx.saveWorkMailbox(mailbox);
    }
    tx.saveAgentRun({ ...run, pushedAt: now.toISOString(), deliveredAt: now.toISOString() });
  });
}

function recordReadyWorkerSession(store, candidateRun, now) {
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId: candidateRun.taskId,
    roleName: candidateRun.roleName
  }, candidateRun.effective.agentId, now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: candidateRun.effective.agentId,
    adapterId: candidateRun.effective.adapterId,
    nativeSessionId: "native-worker-review-e2e",
    policy: "fixed",
    status: "ready",
    effective: candidateRun.effective
  }, now);
  store.saveTaskRoleSessionSet(sessions);
}

function taskStoreWithChangeSet(store, changeSet) {
  return new Proxy(store, {
    get(target, property) {
      if (property === "getChangeSet") {
        return (taskId, changeSetId) => (
          taskId === changeSet.taskId && changeSetId === changeSet.id
            ? structuredClone(changeSet)
            : target.getChangeSet(taskId, changeSetId)
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function taskStoreWithWorkItem(store, workItem, workspace) {
  return new Proxy(store, {
    get(target, property) {
      if (property === "getWorkItem") {
        return (taskId, workItemId) => (
          taskId === workItem.taskId && workItemId === workItem.id
            ? structuredClone(workItem)
            : target.getWorkItem(taskId, workItemId)
        );
      }
      if (property === "getWorkItemWorkspace") {
        return (taskId, workItemId) => (
          taskId === workItem.taskId && workItemId === workItem.id
            ? structuredClone(workspace)
            : target.getWorkItemWorkspace(taskId, workItemId)
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}
