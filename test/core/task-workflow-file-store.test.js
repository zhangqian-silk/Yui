import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createAgentProfile } from "../../dist/profile/agentProfile.js";
import { runOperatorCommand } from "../../dist/commands/operatorCommands.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import {
  bindExecution,
  claimPending,
  createWorkMailbox,
  enqueueSignal
} from "../../dist/coordination/workMailbox.js";
import {
  createGlobalRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../../dist/role/role.js";
import { createAgentRun, failAgentRun } from "../../dist/run/agentRun.js";
import {
  markYuiRunInput,
  retagYuiRunInput,
  yuiRunIdFromInputMessages
} from "../../dist/run/runIdentity.js";
import { taskRoleSessionTitle } from "../../dist/runtime/sessionTitle.js";
import { createProject } from "../../dist/repository/project.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunDelivered,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import { FileRoleLaunchPlanner } from "../../dist/executor/fileRoleLaunchPlanner.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { createRoleWorkspace } from "../../dist/worktree/roleWorkspace.js";
import {
  recordWorkItemWorkspaceDisposition,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";

const NOW = new Date("2026-07-19T12:00:00.000Z");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const codex = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  const claude = createConfiguredAgent("claude", "claude", "claude", [], [], NOW);
  const leader = createGlobalRole(
    "leader",
    [createRoleAgentBinding(codex)],
    codex.id,
    root,
    NOW
  );
  const worker = createGlobalRole(
    "worker",
    [createRoleAgentBinding(codex)],
    codex.id,
    root,
    NOW
  );
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: codex.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(codex);
    tx.saveConfiguredAgent(claude);
    tx.saveGlobalRole(leader);
    tx.saveGlobalRole(worker);
  });
  const calls = { changed: [], reconcile: [], enter: [] };
  const runtime = {
    notifyStateChanged(taskId) { calls.changed.push(taskId); },
    reconcileTask(taskId) { calls.reconcile.push(taskId); },
    prepareTaskRoleEnter(input) { calls.enter.push(input); }
  };
  const options = { runtime, now: () => new Date(NOW) };
  return { root, store, calls, options };
}

function run(args, store, options) {
  const result = runTaskCommand(args, store, options);
  assert.equal(result.kind, "output");
  return result.output;
}

function createTask(store, options, title = "Plan first") {
  run(["create", title], store, options);
  return store.listTasks().at(-1);
}

function markDelivered(store, run) {
  store.transaction((tx) => {
    const target = { kind: "role", taskId: run.taskId, roleName: run.roleName };
    let mailbox = tx.getWorkMailbox(target) ?? createWorkMailbox(target);
    if (mailbox.processing === null) {
      if (mailbox.pending === null) {
        mailbox = enqueueSignal(mailbox, {
          reason: "fixture-run-dispatched",
          refs: [{ type: "run", id: run.id }],
          occurredAt: NOW.toISOString()
        });
      }
      const batchId = `agent-run:${run.id}`;
      mailbox = bindExecution(
        claimPending(mailbox, {
          batchId,
          owner: "controller",
          startedAt: NOW.toISOString()
        }),
        batchId,
        { type: "run", id: run.id }
      );
      tx.saveWorkMailbox(mailbox);
    }
    tx.saveAgentRun({ ...run, deliveredAt: NOW.toISOString() });
  });
}

function recordReadyNativeSession(store, taskId, roleName, nativeSessionId) {
  let sessions = createRoleSessionSet({
    scope: "task",
    taskId,
    roleName
  }, "codex", NOW);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId,
    policy: "fixed",
    status: "ready"
  }, NOW);
  store.saveTaskRoleSessionSet(sessions);
}

test("Work Item rejection and cancellation close the acceptance loop without new states", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options);
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "Review result"], store, options);
  const rejected = store.listWorkItems(task.id).at(-1);
  const running = updateWorkItemStatus(rejected, "running", NOW);
  store.saveWorkItem(task.id, running);
  store.saveWorkItem(
    task.id,
    submitWorkItemCandidate(running, {
      summary: "Candidate ready.",
      source: { type: "direct" }
    }, NOW)
  );

  assert.throws(
    () => runTaskCommand(
      ["work", "reject", rejected.id, "--summary", "Needs another pass."],
      store,
      options
    ),
    /Only the Task Leader may reject/
  );
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  assert.match(
    run(["work", "reject", rejected.id, "--summary", "Needs another pass."], store, leaderOptions),
    /Rejected Work Item/
  );
  assert.equal(store.getWorkItem(task.id, rejected.id).status, "failed");

  assert.match(
    run(["work", "cancel", rejected.id, "--summary", "No longer needed."], store, options),
    /Cancelled Work Item/
  );
  assert.equal(store.getWorkItem(task.id, rejected.id).status, "cancelled");
  assert.equal(
    store.listEvents(task.id).some(({ type }) => type === "work.rejected"),
    true
  );
  assert.equal(
    store.listEvents(task.id).some(({ type }) => type === "work.cancelled"),
    true
  );
});

function dispatchTestRun(store, taskId, roleName, workItemId, input = "test run") {
  const role = store.getRole(taskId, roleName);
  if (store.getActiveAgentRun(taskId, roleName) !== null) {
    throw new Error(`${taskId}/${roleName} already has an active run.`);
  }
  const runId = store.nextAgentRunId(taskId);
  const run = createAgentRun(
    runId,
    taskId,
    roleName,
    "new",
    markYuiRunInput(
      input,
      runId,
      taskRoleSessionTitle(store.getTask(taskId), roleName)
    ),
    NOW,
    { workItemId }
  );
  store.transaction((tx) => {
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    tx.saveRole(taskId, updateRoleStatus(role, "running", NOW));
    const item = tx.getWorkItem(taskId, workItemId);
    tx.saveWorkItem(taskId, updateWorkItemStatus(item, "running", NOW));
    const target = { kind: "role", taskId, roleName };
    const mailbox = enqueueSignal(tx.getWorkMailbox(target) ?? createWorkMailbox(target), {
      reason: "run-dispatched",
      refs: [{ type: "run", id: run.id }, { type: "work-item", id: workItemId }],
      occurredAt: NOW.toISOString()
    });
    tx.saveWorkMailbox(mailbox);
  });
  return run;
}

test("Draft activation atomically creates one durable first Leader wake", (t) => {
  const { root, store, options } = fixture(t);
  store.saveProject(createProject(
    "repo-1",
    "fixture",
    root,
    { stable: "main", development: "main" },
    NOW
  ));
  run(["create", "Project task", "--project", "repo-1", "--base", "main"], store, options);
  const task = store.listTasks()[0];

  assert.equal(task.status, "draft");
  assert.deepEqual(task.projectBindings, [{
    projectId: "repo-1",
    directory: "fixture",
    baseRef: "main"
  }]);
  assert.equal(store.getRole(task.id, "leader")?.activeAgentId, "codex");
  assert.equal(store.getPendingWakeup(task.id), null);

  run(["activate", task.id], store, options);
  const first = store.getPendingWakeup(task.id);
  assert.equal(store.getTask(task.id)?.status, "active");
  assert.deepEqual(first?.reasons, ["task-created"]);
  assert.equal(first?.requestCount, 1);

  run(["activate", task.id], store, options);
  assert.deepEqual(store.getPendingWakeup(task.id), first);
});

test("Task create binds multiple Projects with independent base refs", (t) => {
  const { root, store, options } = fixture(t);
  store.saveProject(createProject(
    "repo-1",
    "backend",
    join(root, "backend"),
    { stable: "main", development: "develop" },
    NOW
  ));
  store.saveProject(createProject(
    "repo-2",
    "frontend",
    join(root, "frontend"),
    { stable: "main", development: "release" },
    NOW
  ));

  run([
    "create",
    "Coordinated release",
    "--project", "backend",
    "--project", "frontend",
    "--base", "backend=develop",
    "--base", "frontend=release",
    "--require-integration"
  ], store, options);
  const task = store.listTasks()[0];

  assert.deepEqual(task.projectBindings, [
    { projectId: "repo-1", directory: "backend", baseRef: "develop" },
    { projectId: "repo-2", directory: "frontend", baseRef: "release" }
  ]);
  assert.equal(task.requireIntegration, true);
  assert.match(run(["project", "list", task.id], store, options), /backend\s+repo-1\s+develop/);
  assert.match(run(["project", "list", task.id], store, options), /frontend\s+repo-2\s+release/);
  const context = run(["context", task.id], store, options);
  assert.match(context, /- backend: repo-1 @ develop/);
  assert.match(context, /- frontend: repo-2 @ release/);

  assert.throws(
    () => runTaskCommand([
      "create",
      "Ambiguous bases",
      "--project", "backend",
      "--project", "frontend",
      "--base", "main"
    ], store, options),
    /must use <project>=<ref>.*multiple Projects/i
  );
  assert.equal(store.listTasks().length, 1);
});

test("Leader can expand an active Task and WorkItem Project scope", (t) => {
  const { root, store, options } = fixture(t);
  for (const [id, name] of [["repo-1", "backend"], ["repo-2", "frontend"]]) {
    store.saveProject(createProject(
      id,
      name,
      join(root, id),
      { stable: "main", development: "main" },
      NOW
    ));
  }
  run(["create", "Cross-project change", "--project", "repo-1"], store, options);
  const task = store.listTasks()[0];
  run(["activate", task.id], store, options);
  const leader = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };

  run(["project", "add", task.id, "repo-2"], store, leader);
  assert.deepEqual(store.getTask(task.id).projectBindings.map(({ projectId }) => projectId), [
    "repo-1",
    "repo-2"
  ]);
  run(["role", "add", task.id, "worker"], store, leader);
  run([
    "work", "create", task.id, "Update both",
    "--project", "repo-1",
    "--role", "worker"
  ], store, leader);
  const item = store.listWorkItems(task.id)[0];
  run([
    "work", "scope", item.id,
    "--project", "repo-1",
    "--project", "repo-2"
  ], store, leader);
  assert.deepEqual(store.getWorkItem(task.id, item.id).writeProjectIds, [
    "repo-1",
    "repo-2"
  ]);
  const expanded = store.getWorkItem(task.id, item.id);
  const eventCount = store.listEvents(task.id).length;
  assert.match(run([
    "work", "scope", item.id,
    "--project", "repo-2",
    "--project", "repo-1"
  ], store, leader), /Unchanged Work Item Project scope/i);
  assert.equal(store.getWorkItem(task.id, item.id).revision, expanded.revision);
  assert.equal(store.listEvents(task.id).length, eventCount);
  assert.throws(
    () => run([
      "work", "scope", item.id,
      "--project", "repo-2"
    ], store, leader),
    /cannot remove.*repo-1/i
  );
  assert.throws(
    () => run(["work", "dispatch", item.id], store, leader),
    /must be isolated.*Project scope/i
  );
});

test("invalid project and Role options fail before mutating the aggregate", (t) => {
  const { store, options } = fixture(t);
  assert.throws(
    () => runTaskCommand(["create", "invalid", "--base", "main"], store, options),
    /requires --project/i
  );
  assert.equal(store.listTasks().length, 0);
  const task = createTask(store, options, "Valid");
  assert.throws(
    () => runTaskCommand(["role", "add", task.id, "worker", "--agent", ""], store, options),
    /--agent is required/i
  );
  assert.equal(store.getRole(task.id, "worker"), null);
});

test("Task metadata can be updated and is visible in Task details", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Initial title");

  run([
    "update",
    task.id,
    "--title",
    "Release readiness",
    "--description",
    "Prepare the release candidate",
    "--priority",
    "high",
    "--tags",
    "release,backend",
    "--due-at",
    "2026-07-31T12:00:00.000Z"
  ], store, options);

  const updated = store.getTask(task.id);
  assert.equal(updated.title, "Release readiness");
  assert.equal(updated.description, "Prepare the release candidate");
  assert.equal(updated.priority, "high");
  assert.deepEqual(updated.tags, ["release", "backend"]);
  assert.equal(updated.dueAt, "2026-07-31T12:00:00.000Z");
  const shown = run(["show", task.id], store, options);
  assert.match(shown, /Description: Prepare the release candidate/);
  assert.match(shown, /Priority: high/);
  assert.match(shown, /Tags: release, backend/);
  assert.match(shown, /Due: 2026-07-31 20:00:00 \+08:00/);

  run([
    "update",
    task.id,
    "--clear-description",
    "--clear-priority",
    "--clear-tags",
    "--clear-due-at"
  ], store, options);
  const cleared = store.getTask(task.id);
  assert.equal(cleared.description, undefined);
  assert.equal(cleared.priority, undefined);
  assert.equal(cleared.tags, undefined);
  assert.equal(cleared.dueAt, undefined);

  assert.throws(
    () => runTaskCommand(["update", task.id, "--due-at", "July 31, 2026"], store, options),
    /ISO|RFC 3339/i
  );
  run(["update", task.id, "--due-at", "2026-07-31T20:00:00+08:00"], store, options);
  assert.equal(store.getTask(task.id).dueAt, "2026-07-31T12:00:00.000Z");
});

test("an active read-only Task can enable integration evidence exactly once", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Investigate first");
  run(["activate", task.id], store, options);

  assert.match(
    run(["update", task.id, "--require-integration"], store, options),
    /Completion evidence enabled/
  );
  assert.equal(store.getTask(task.id).requireIntegration, true);
  assert.match(run(["show", task.id], store, options), /Completion evidence: required/);
  assert.deepEqual(store.listEvents(task.id).at(-1).payload, {
    status: "active",
    completionEvidence: "integration-required"
  });

  assert.match(
    run(["update", task.id, "--require-integration"], store, options),
    /already enabled/
  );

  const completed = createTask(store, options, "Completed investigation");
  run(["activate", completed.id], store, options);
  run(["complete", completed.id, "--summary", "Investigation done"], store, options);
  assert.throws(
    () => run(["update", completed.id, "--require-integration"], store, options),
    /reopen/i
  );
});

test("Task list and show emit one-pass structured JSON for Agents", (t) => {
  const { root, store, options } = fixture(t);
  const task = createTask(store, options, "Agent-readable task");
  const runCli = (...args) => JSON.parse(execFileSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "--json", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, YUI_HOME: root }
    }
  ));

  assert.deepEqual(runCli("task", "list"), {
    ok: true,
    data: { tasks: [task] }
  });
  assert.deepEqual(runCli("task", "show", task.id), {
    ok: true,
    data: {
      task,
      counts: {
        messages: 0,
        decisions: 0,
        milestones: 0,
        events: 1,
        workItems: 0,
        agentRuns: 0,
        changeSets: 0,
        integrations: 0,
        openInputs: 0
      },
      hasBrief: false
    }
  });
  assert.deepEqual(runCli("task", "work", "list", task.id), {
    ok: true,
    data: { workItems: [] }
  });
});

test("Task lifecycle and messages append a durable Web timeline", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Timeline");
  run(["update", task.id, "--priority", "high"], store, options);
  run(["activate", task.id], store, options);
  run(["message", "send", task.id, "Proceed"], store, options);
  run(["complete", task.id, "--summary", "Finished"], store, options);
  run(["reopen", task.id], store, options);
  run(["complete", task.id, "--summary", "Finished after reopen"], store, options);
  assert.throws(
    () => run(["archive", task.id], store, options),
    /--integrated|--abandon/
  );
  run(["archive", task.id, "--integrated"], store, options);

  assert.deepEqual(
    store.listEvents(task.id).map((event) => event.type),
    [
      "task.created",
      "task.updated",
      "task.activated",
      "message.sent",
      "task.completed",
      "task.reopened",
      "task.completed",
      "task.archived"
    ]
  );
  assert.deepEqual(store.listEvents(task.id)[3].payload, {
    messageId: store.listMessages(task.id)[0].id,
    kind: "user"
  });
  assert.equal(store.listEvents(task.id).at(-1).payload.workspaceDisposition, "integrated");
  const message = store.listMessages(task.id)[0];
  assert.throws(
    () => store.saveMessage(task.id, { ...message, body: "Rewritten history" }),
    /already exists/i
  );
});

test("Operator submit creates a Draft and active Task messages wake its Leader", (t) => {
  const { root, store, options } = fixture(t);
  const created = runOperatorCommand(["submit", "Build the smallest useful workflow"], store, options);
  assert.equal(created.kind, "output");
  const task = store.listTasks()[0];
  assert.equal(task.status, "draft");
  assert.deepEqual(store.listMessages(task.id)[0].author, { type: "operator" });
  assert.equal(store.listMessages(task.id)[0].kind, "operator");
  assert.equal(store.getPendingWakeup(task.id), null);

  run(["activate", task.id], store, options);
  const before = store.getPendingWakeup(task.id)?.requestCount;
  runOperatorCommand(["submit", "Continue here", "--task", task.id], store, options);
  assert.equal(store.listMessages(task.id).at(-1).body, "Continue here");
  assert.equal(store.getPendingWakeup(task.id)?.requestCount, before + 1);
  assert.ok(store.getPendingWakeup(task.id)?.reasons.includes("operator-input"));

  run(["message", "send", task.id, "User follow-up"], store, options);
  const userMessage = store.listMessages(task.id).at(-1);
  assert.equal(userMessage.kind, "user");
  assert.deepEqual(userMessage.author, { type: "user" });
  assert.ok(store.getPendingWakeup(task.id)?.reasons.includes("user-message"));

  const aggregate = JSON.parse(readFileSync(join(root, "state.json"), "utf8")).tasks[task.id];
  assert.ok(aggregate.messages[userMessage.id]);
  assert.equal("comments" in aggregate, false);
});

test("assigned Work dispatch honors dependencies and Worker yield awaits Leader acceptance", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Dispatch");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "first", "--role", "worker"], store, options);
  const first = store.listWorkItems(task.id)[0];
  run([
    "work", "create", task.id, "second", "--role", "worker",
    "--after", first.id
  ], store, options);
  const second = store.listWorkItems(task.id)[1];

  assert.throws(
    () => run(["work", "dispatch", second.id], store, options),
    new RegExp(`Work Item dependency is not completed: ${first.id}`)
  );
  run(["work", "dispatch", first.id, "--input", "implement"], store, options);
  assert.equal(store.findWorkItem(second.id)?.status, "pending");
  const active = store.getActiveAgentRun(task.id, "worker");
  assert.equal(active?.workItemId, first.id);
  assert.equal(active?.agentId, "codex");
  assert.equal(active?.adapterId, "codex");
  const workerMailbox = store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "worker" });
  assert.deepEqual(workerMailbox.pending.reasons, ["run-dispatched"]);
  assert.ok(workerMailbox.pending.refs.some((ref) => ref.type === "run" && ref.id === active.id));

  markDelivered(store, active);
  run(["run", "yield", active.id, "--summary", "implemented"], store, options);
  assert.equal(store.findAgentRun(active.id)?.status, "yielded");
  assert.equal(store.findWorkItem(first.id)?.status, "awaiting_acceptance");
  assert.equal(store.getActiveAgentRun(task.id, "worker"), null);
  const resultMessage = store.listMessages(task.id).at(-1);
  assert.deepEqual(resultMessage.author, { type: "role", roleName: "worker" });
  assert.equal(resultMessage.kind, "role-result");
  assert.equal(resultMessage.runId, active.id);
  assert.equal(resultMessage.workItemId, first.id);
  assert.equal(resultMessage.body, "implemented");
  assert.ok(store.getPendingWakeup(task.id)?.reasons.includes("candidate-ready"));
  const leaderMailbox = store.getWorkMailbox({ kind: "role", taskId: task.id, roleName: "leader" });
  assert.ok(leaderMailbox.pending.refs.some((ref) => ref.type === "run" && ref.id === active.id));
  assert.throws(
    () => run(
      ["work", "update", first.id, "done", "--summary", "bypassed review"],
      store,
      options
    ),
    /assigned Work Item.*accept or reject/iu
  );
  assert.equal(store.findWorkItem(first.id)?.status, "awaiting_acceptance");

  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  run(["work", "accept", first.id, "--summary", "reviewed"], store, leaderOptions);
  assert.equal(store.findWorkItem(first.id)?.status, "completed");
  run(["work", "dispatch", second.id], store, options);
  assert.equal(store.findWorkItem(second.id)?.status, "running");
});

test("always review creates a ReviewRound under the same WorkItem and never reviews the review", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "always" }
    });
  });
  const task = createTask(store, options, "Automatic review");
  assert.deepEqual(store.getReviewConfig(), {
    roleName: "reviewer",
    trigger: "always"
  });
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "candidate", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const execution = store.getActiveAgentRun(task.id, "worker");
  assert.equal(execution.purpose, "execution");
  markDelivered(store, execution);
  run(["run", "yield", execution.id, "--summary", "candidate ready"], store, options);

  assert.equal(store.listWorkItems(task.id).length, 1);
  const rounds = store.listReviewRounds(task.id);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].workItemId, item.id);
  const candidate = store.getWorkItem(task.id, item.id).candidates.at(-1);
  assert.equal(rounds[0].candidateId, candidate.id);
  assert.equal(candidate.workItemRevision, store.getWorkItem(task.id, item.id).revision);
  assert.equal(candidate.summary, "candidate ready");
  assert.deepEqual(candidate.source, { type: "run", runId: execution.id });
  assert.equal(rounds[0].status, "running");
  const reviewRun = store.getActiveAgentRun(task.id, "reviewer");
  assert.equal(reviewRun.purpose, "review");
  assert.equal(reviewRun.reviewRoundId, rounds[0].id);
  assert.match(reviewRun.input, /Do not modify files or create another WorkItem/);
  assert.match(reviewRun.input, /candidate summary is a pointer, not proof/i);
  assert.match(reviewRun.input, /reachable, material, actionable problems/i);
  assert.match(reviewRun.input, /speculative extreme cases/i);
  assert.match(reviewRun.input, /the Leader decides/i);

  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  assert.throws(
    () => run(["work", "accept", item.id, "--summary", "accept"], store, leaderOptions),
    /ReviewRound.*running/
  );
  assert.throws(
    () => run(["work", "reject", item.id, "--summary", "reject early"], store, leaderOptions),
    /ReviewRound is still active/
  );

  markDelivered(store, reviewRun);
  run(["run", "yield", reviewRun.id, "--summary", "One issue to consider."], store, options);
  assert.equal(store.listReviewRounds(task.id).length, 1);
  assert.equal(store.listWorkItems(task.id).length, 1);
  assert.deepEqual(store.getReviewRound(task.id, rounds[0].id), {
    ...rounds[0],
    reviewerRunId: reviewRun.id,
    status: "completed",
    summary: "One issue to consider.",
    endedAt: NOW.toISOString()
  });
  assert.equal(store.findWorkItem(item.id)?.status, "awaiting_acceptance");
  run(["work", "accept", item.id, "--summary", "Leader considered the review."], store, leaderOptions);
  assert.equal(store.findWorkItem(item.id)?.status, "completed");
});

test("global review policy is snapshotted by each candidate, not by Task creation", (t) => {
  const { root, store, options } = fixture(t);
  const task = createTask(store, options, "Live global review policy");
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "always" }
    });
  });
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "candidate", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const firstExecution = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, firstExecution);
  run(["run", "yield", firstExecution.id, "--summary", "first candidate"], store, options);

  const firstCandidate = store.getWorkItem(task.id, item.id).candidates.at(-1);
  assert.deepEqual(firstCandidate.reviewPolicy, {
    roleName: "reviewer",
    trigger: "always"
  });
  assert.equal(store.listReviewRounds(task.id).length, 1);

  const { review: _review, ...configWithoutReview } = store.getConfig();
  store.saveConfig(configWithoutReview);
  const firstReview = store.getActiveAgentRun(task.id, "reviewer");
  markDelivered(store, firstReview);
  run(["run", "yield", firstReview.id, "--summary", "reviewed first candidate"], store, options);
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  recordReadyNativeSession(store, task.id, "worker", "native-worker-policy-snapshot");
  run(["work", "reject", item.id, "--summary", "repair"], store, leaderOptions);
  run(["work", "dispatch", item.id, "--input", "repair the candidate"], store, options);
  const secondExecution = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, secondExecution);
  run(["run", "yield", secondExecution.id, "--summary", "second candidate"], store, options);

  const updated = store.getWorkItem(task.id, item.id);
  assert.equal(updated.candidates.length, 2);
  assert.equal(updated.candidates[0].id, firstCandidate.id);
  assert.equal(updated.candidates[1].reviewPolicy, undefined);
  assert.equal(store.listReviewRounds(task.id).length, 1);
  run(["work", "accept", item.id, "--summary", "accepted without a cleared policy"], store, leaderOptions);
});

test("always review covers a Leader-managed WorkItem without inventing an execution Run", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "always" }
    });
  });
  const task = createTask(store, options, "Review native subagent work");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "native candidate"], store, options);
  const item = store.listWorkItems(task.id)[0];
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };

  run(["work", "update", item.id, "running"], store, leaderOptions);
  const running = store.getWorkItem(task.id, item.id);
  const foreignWorkspace = createRoleWorkspace({
    taskId: "foreign-task",
    roleName: "leader",
    owner: { type: "task" },
    root,
    entries: []
  }, new Date(NOW));
  assert.throws(
    () => store.saveWorkItem(task.id, submitWorkItemCandidate(running, {
      summary: "Invalid cross-Task candidate.",
      source: { type: "direct" },
      reviewPolicy: { roleName: "reviewer", trigger: "leader" },
      workspace: foreignWorkspace
    }, NOW)),
    /workspace belongs to another Task/
  );
  run([
    "work", "update", item.id, "done",
    "--summary", "Native subagent result is ready."
  ], store, leaderOptions);

  const awaiting = store.findWorkItem(item.id);
  assert.equal(awaiting.status, "awaiting_acceptance");
  assert.deepEqual(store.listAgentRuns(task.id).filter(({ purpose }) => purpose === "execution"), []);
  const [round] = store.listReviewRounds(task.id);
  const candidate = awaiting.candidates.at(-1);
  assert.equal(round.candidateId, candidate.id);
  assert.equal(candidate.workItemRevision, awaiting.revision);
  assert.equal(candidate.summary, "Native subagent result is ready.");
  assert.deepEqual(candidate.source, { type: "direct" });
  assert.equal(round.status, "running");
  const reviewRun = store.getActiveAgentRun(task.id, "reviewer");
  assert.equal(reviewRun.purpose, "review");
  assert.match(reviewRun.input, /Native subagent result is ready\./);
});

test("always review covers a yielded Leader execution candidate", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "always" }
    });
  });
  const task = createTask(store, options, "Review Leader execution");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "leader candidate"], store, options);
  const item = store.listWorkItems(task.id)[0];
  const execution = dispatchTestRun(store, task.id, "leader", item.id);
  markDelivered(store, execution);

  run(["run", "yield", execution.id, "--summary", "Leader candidate ready."], store, options);

  assert.equal(store.findWorkItem(item.id).status, "awaiting_acceptance");
  const candidate = store.getWorkItem(task.id, item.id).candidates.at(-1);
  assert.equal(store.listReviewRounds(task.id)[0].candidateId, candidate.id);
  assert.equal(candidate.summary, "Leader candidate ready.");
  assert.deepEqual(candidate.source, { type: "run", runId: execution.id });
  assert.equal(store.getActiveAgentRun(task.id, "reviewer").purpose, "review");
});

test("review can reuse the candidate Role without leaving its active status idle", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "worker",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "worker", trigger: "always" }
    });
  });
  const task = createTask(store, options, "Self review lifecycle");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "candidate", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const execution = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, execution);

  run(["run", "yield", execution.id, "--summary", "candidate ready"], store, options);

  const reviewRun = store.getActiveAgentRun(task.id, "worker");
  assert.equal(reviewRun.purpose, "review");
  assert.equal(store.getRole(task.id, "worker").status, "running");
});

test("a failed ReviewRound remains evidence but does not override Leader judgment", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "always" }
    });
  });
  const task = createTask(store, options, "Review failure judgment");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "candidate", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const execution = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, execution);
  run(["run", "yield", execution.id, "--summary", "candidate ready"], store, options);
  const reviewRun = store.getActiveAgentRun(task.id, "reviewer");
  store.transaction((tx) => {
    tx.saveAgentRun(failAgentRun(reviewRun, "Reviewer runtime unavailable.", NOW));
    tx.clearActiveAgentRun(task.id, "reviewer");
  });
  assert.equal(store.listReviewRounds(task.id)[0].status, "failed");

  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  run([
    "work", "accept", item.id,
    "--summary", "User authorized acceptance after the review failure."
  ], store, leaderOptions);
  assert.equal(store.findWorkItem(item.id).status, "completed");
});

test("leader-triggered review starts only when the Leader requests it", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "leader" }
    });
  });
  const task = createTask(store, options, "Leader review");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "candidate", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const execution = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, execution);
  run(["run", "yield", execution.id, "--summary", "candidate ready"], store, options);
  assert.deepEqual(store.listReviewRounds(task.id), []);

  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  assert.match(
    run(["work", "review", item.id], store, leaderOptions),
    /Review queued/
  );
  assert.equal(store.listReviewRounds(task.id).length, 1);
  assert.equal(store.getActiveAgentRun(task.id, "reviewer")?.purpose, "review");
});

test("the latest ReviewRound stays authoritative when timestamps tie", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "leader" }
    });
  });
  const task = createTask(store, options, "Many review rounds");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "candidate", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const execution = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, execution);
  run(["run", "yield", execution.id, "--summary", "candidate ready"], store, options);
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };

  for (let round = 1; round <= 10; round += 1) {
    run(["work", "review", item.id], store, leaderOptions);
    const reviewRun = store.getActiveAgentRun(task.id, "reviewer");
    markDelivered(store, reviewRun);
    run(["run", "yield", reviewRun.id, "--summary", `review ${round}`], store, options);
  }
  run(["work", "review", item.id], store, leaderOptions);

  assert.throws(
    () => run(["work", "accept", item.id, "--summary", "accept"], store, leaderOptions),
    /ReviewRound.*running/
  );
});

test("leader-triggered review can inspect a Leader-managed direct candidate", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "leader" }
    });
  });
  const task = createTask(store, options, "Leader direct review");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "direct candidate"], store, options);
  const item = store.listWorkItems(task.id)[0];
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };

  run(["work", "update", item.id, "running"], store, leaderOptions);
  run([
    "work", "update", item.id, "done",
    "--summary", "Leader-managed candidate is ready."
  ], store, leaderOptions);

  const awaiting = store.getWorkItem(task.id, item.id);
  assert.equal(awaiting.status, "awaiting_acceptance");
  const candidate = awaiting.candidates.at(-1);
  assert.equal(candidate.workItemRevision, awaiting.revision);
  assert.equal(candidate.summary, "Leader-managed candidate is ready.");
  assert.deepEqual(candidate.source, { type: "direct" });
  assert.deepEqual(store.listReviewRounds(task.id), []);
  assert.match(
    run(["work", "review", item.id], store, leaderOptions),
    /Review queued/
  );
  assert.equal(store.listReviewRounds(task.id)[0].candidateId, candidate.id);
});

test("a failed automatic review after Leader yield durably wakes the Leader", (t) => {
  const { root, store, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveGlobalRole(createGlobalRole(
      "reviewer",
      [createRoleAgentBinding(tx.getConfiguredAgent("codex"))],
      "codex",
      root,
      NOW
    ));
    tx.saveConfig({
      ...tx.getConfig(),
      review: { roleName: "reviewer", trigger: "always" }
    });
  });
  const task = createTask(store, options, "Failed review handoff");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "leader candidate"], store, options);
  const item = store.listWorkItems(task.id)[0];
  const execution = dispatchTestRun(store, task.id, "leader", item.id);
  markDelivered(store, execution);
  assert.equal(store.removeGlobalRole("reviewer"), true);

  run(["run", "yield", execution.id, "--summary", "Candidate ready."], store, options);

  const [round] = store.listReviewRounds(task.id);
  assert.equal(round.status, "failed");
  assert.match(round.summary, /Global Role not found/);
  const leaderMailbox = store.getWorkMailbox({
    kind: "role",
    taskId: task.id,
    roleName: "leader"
  });
  assert.deepEqual(leaderMailbox.pending?.reasons, ["review-failed"]);
  assert.equal(
    leaderMailbox.pending?.refs.some((ref) => ref.type === "work-item" && ref.id === item.id),
    true
  );
});

test("Leader rejection preserves a Worker WorkItem for another dispatch round", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Review rounds");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "iterate", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const first = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, first);
  run(["run", "yield", first.id, "--summary", "first pass"], store, options);

  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };
  run(["work", "reject", item.id, "--summary", "Fix the review findings."], store, leaderOptions);
  assert.throws(
    () => run(["work", "dispatch", item.id, "--input", "Apply the review findings."], store, options),
    /repair requires the original Worker native Session/i
  );
  recordReadyNativeSession(store, task.id, "worker", "native-worker-history");
  run(["work", "dispatch", item.id, "--input", "Apply the review findings."], store, options);

  const second = store.getActiveAgentRun(task.id, "worker");
  assert.notEqual(second.id, first.id);
  assert.equal(second.mode, "resume");
  assert.equal(second.workItemId, item.id);
  assert.equal(store.findWorkItem(item.id)?.status, "running");
});

test("retry replaces the old causal Run marker instead of reusing it", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Retry marker");
  run(["activate", task.id], store, options);
  const failed = failAgentRun(createAgentRun(
    "agent-run-old",
    task.id,
    "leader",
    "new",
    markYuiRunInput(
      "recover",
      "agent-run-old",
      `Yui · ${task.id} · Retry marker · Leader`
    ),
    NOW
  ), "failed before delivery", NOW);
  store.saveAgentRun(failed);

  run(["run", "retry", failed.id], store, options);

  const retried = store.getActiveAgentRun(task.id, "leader");
  const markers = retried.input.match(/^Yui · .+ · Retry marker · Leader · Run .+$/gm);
  assert.deepEqual(markers, [
    `Yui · ${task.id} · Retry marker · Leader · Run ${retried.id}`
  ]);
  assert.equal(retried.input.includes("Run agent-run-old"), false);
  assert.equal(yuiRunIdFromInputMessages([retried.input]), retried.id);
});

test("a failed Worker Run can retry its failed WorkItem", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Retry Worker work");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "recover", "--role", "worker"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["work", "dispatch", item.id], store, options);
  const active = store.getActiveAgentRun(task.id, "worker");
  active.input = markYuiRunInput(
    "legacy Worker dispatch without an explicit yield requirement",
    active.id,
    `Yui · ${task.id} · Retry Worker work · Worker`
  );
  store.transaction((tx) => {
    tx.saveAgentRun(failAgentRun(active, "transient failure", NOW));
    tx.clearActiveAgentRun(task.id, "worker");
    tx.saveRole(task.id, updateRoleStatus(
      tx.getRole(task.id, "worker"),
      "idle",
      NOW
    ));
    tx.saveWorkItem(task.id, updateWorkItemStatus(
      tx.getWorkItem(task.id, item.id),
      "failed",
      NOW,
      "transient failure"
    ));
  });

  run(["run", "retry", active.id], store, options);

  assert.equal(store.findWorkItem(item.id)?.status, "running");
  const retried = store.getActiveAgentRun(task.id, "worker");
  assert.equal(retried?.workItemId, item.id);
  assert.match(retried.input, /yui task run yield <current-run-id>/);
  assert.match(retried.input, /final response alone does neither/i);
});

test("Run marker handling preserves user-authored marker lines outside the managed header", () => {
  const userInput = [
    "Analyze this exact payload:",
    "Yui-Run: example-from-user",
    "keep the line above"
  ].join("\n");

  const marked = markYuiRunInput(
    userInput,
    "agent-run-current",
    "Yui · task-7 · Test Task · Worker"
  );
  const retried = retagYuiRunInput(
    marked,
    "agent-run-retried",
    "Yui · task-7 · Test Task · Worker"
  );

  assert.equal(marked.includes("Yui-Run: example-from-user"), true);
  assert.equal(retried.includes("Yui-Run: example-from-user"), true);
  assert.equal(
    retried.startsWith(
      "Yui · task-7 · Test Task · Worker · Run agent-run-retried\n\n"
    ),
    true
  );
  assert.equal(yuiRunIdFromInputMessages([retried]), "agent-run-retried");
  assert.equal(yuiRunIdFromInputMessages([userInput]), undefined);
});

test("first Run marking preserves a user lookalike at the start of the body", () => {
  const userInput = [
    "Yui-Run: example-from-user",
    "",
    "This is user-authored content, not a managed envelope."
  ].join("\n");

  const marked = markYuiRunInput(
    userInput,
    "agent-run-current",
    "Yui · task-7 · Test Task · Worker"
  );

  assert.equal(
    marked,
    `Yui · task-7 · Test Task · Worker · Run agent-run-current\n\n${userInput}`
  );
  assert.equal(yuiRunIdFromInputMessages([marked]), "agent-run-current");
});

test("Run parsing rejects previous marker formats", () => {
  const legacy = "Yui-Run-Id: agent-run-legacy\n\nContinue the existing Run.";

  assert.equal(yuiRunIdFromInputMessages([legacy]), undefined);
  assert.throws(
    () => retagYuiRunInput(
      legacy,
      "agent-run-current",
      "Yui · task-7 · Existing Task · Leader"
    ),
    /managed Run input header is required/iu
  );
});

test("Run retagging rejects input without a managed envelope", () => {
  assert.throws(
    () => retagYuiRunInput(
      "plain user input",
      "agent-run-retried",
      "Yui · task-7 · Test Task · Worker"
    ),
    /managed Run input header is required/iu
  );
});

test("Leader yield does not self-wake and preserves a wake queued while busy", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Leader work");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "coordinate"], store, options);
  const item = store.listWorkItems(task.id)[0];
  dispatchTestRun(store, task.id, "leader", item.id);
  const runRecord = store.getActiveAgentRun(task.id, "leader");

  markDelivered(store, runRecord);
  run(["message", "send", task.id, "arrived while Leader was busy"], store, options);
  const pending = store.getPendingWakeup(task.id);
  run(["run", "yield", runRecord.id, "--summary", "coordinated"], store, options);
  assert.deepEqual(store.getPendingWakeup(task.id), pending);
  assert.equal(store.findWorkItem(item.id)?.status, "completed");
});

test("Leader can track conversation-internal work without a Task Role", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Native subagent work");
  run(["activate", task.id], store, options);
  run([
    "work", "create", task.id, "Review the implementation",
    "--objective", "Use a native subagent and validate its findings.",
    "--accept", "Findings are reviewed and recorded."
  ], store, options);
  const item = store.listWorkItems(task.id).at(-1);
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };

  assert.throws(
    () => run(["work", "dispatch", item.id], store, leaderOptions),
    /Task Leader must run "yui task work update .* running".*native subagent/u
  );
  assert.throws(
    () => run(["work", "update", item.id, "running"], store, options),
    /Only the Task Leader may update unassigned Work Item execution/u
  );
  run([
    "work", "update", item.id, "running",
    "--summary", "executor=subagent; profile=reviewer@3; model=inherited"
  ], store, leaderOptions);
  assert.equal(store.findWorkItem(item.id)?.status, "running");
  assert.equal(store.findWorkItem(item.id)?.outcome, undefined);
  assert.equal(store.getActiveAgentRun(task.id, "leader"), null);

  run([
    "work", "update", item.id, "done",
    "--summary", "Leader reviewed the native subagent result and verified the evidence."
  ], store, leaderOptions);
  assert.equal(store.findWorkItem(item.id)?.status, "completed");
  assert.equal(
    store.findWorkItem(item.id)?.outcome,
    "Leader reviewed the native subagent result and verified the evidence."
  );
  const progress = store.listEvents(task.id)
    .filter(({ type }) => type === "work.updated");
  assert.equal(progress.length, 2);
  assert.deepEqual(progress[0].payload, {
    workItemId: item.id,
    status: "running",
    summary: "executor=subagent; profile=reviewer@3; model=inherited"
  });
  assert.deepEqual(progress[1].payload, {
    workItemId: item.id,
    status: "completed",
    summary: "Leader reviewed the native subagent result and verified the evidence."
  });
});

test("Leader-owned work honors dependencies and can retry directly", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Native work recovery");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "Establish the contract"], store, options);
  const prerequisite = store.listWorkItems(task.id).at(-1);
  run([
    "work", "create", task.id, "Implement the contract",
    "--after", prerequisite.id
  ], store, options);
  const implementation = store.listWorkItems(task.id).at(-1);
  const leaderOptions = {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  };

  assert.throws(
    () => run(["work", "update", implementation.id, "running"], store, leaderOptions),
    new RegExp(`Work Item dependency is not completed: ${prerequisite.id}`)
  );
  run(["work", "update", prerequisite.id, "running"], store, leaderOptions);
  run([
    "work", "update", prerequisite.id, "done",
    "--summary", "Contract established."
  ], store, leaderOptions);
  run(["work", "update", implementation.id, "running"], store, leaderOptions);
  run([
    "work", "update", implementation.id, "failed",
    "--summary", "First native subagent result did not pass review."
  ], store, leaderOptions);
  run(["work", "update", implementation.id, "running"], store, leaderOptions);
  assert.equal(store.findWorkItem(implementation.id)?.status, "running");
  assert.equal(store.findWorkItem(implementation.id)?.outcome, undefined);
});

test("Leader control Run without a WorkItem can yield and release the pending wake boundary", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Leader wake");
  run(["activate", task.id], store, options);
  const leader = store.getRole(task.id, "leader");
  const controlRun = createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "leader",
    "new",
    "Review pending Task events",
    NOW
  );
  controlRun.deliveredAt = NOW.toISOString();
  store.transaction((tx) => {
    tx.saveActiveAgentRun(controlRun);
    tx.saveRole(task.id, updateRoleStatus(leader, "running", NOW));
  });
  markDelivered(store, controlRun);
  store.transaction((tx) => {
    const fence = {
      agentId: leader.activeAgentId,
      runId: controlRun.id,
      receiptId: `agent-run:${controlRun.id}`
    };
    const sessions = tx.getTaskRoleSessionSet(task.id, "leader")
      ?? createRoleSessionSet(
        { scope: "task", taskId: task.id, roleName: "leader" },
        leader.activeAgentId,
        NOW
      );
    tx.saveTaskRoleSessionSet(markTaskRoleRunDelivered(
      bindTaskRoleRun(sessions, fence, NOW),
      fence,
      NOW
    ));
  });

  run(["run", "yield", controlRun.id, "--summary", "reviewed"], store, options);
  assert.equal(store.findAgentRun(controlRun.id)?.status, "yielded");
  assert.equal(store.getActiveAgentRun(task.id, "leader"), null);
  assert.equal(store.getRole(task.id, "leader")?.status, "idle");
  assert.equal(store.getPendingWakeup(task.id), null);
  assert.equal(store.listMessages(task.id).at(-1).body, "reviewed");
  assert.equal(store.getTaskRoleSessionSet(task.id, "leader").inFlight, null);
  assert.equal(store.getTaskRoleSessionSet(task.id, "leader").pendingTurnCompletion, null);
});

test("a rejected Worker control yield rolls back all staged FileTaskStore writes", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Atomic yield");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  const worker = store.getRole(task.id, "worker");
  const invalidRun = createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "worker",
    "new",
    "invalid control run",
    NOW
  );
  invalidRun.deliveredAt = NOW.toISOString();
  store.transaction((tx) => {
    tx.saveActiveAgentRun(invalidRun);
    tx.saveRole(task.id, updateRoleStatus(worker, "running", NOW));
  });
  markDelivered(store, invalidRun);
  const beforeMessages = store.listMessages(task.id);

  assert.throws(
    () => runTaskCommand(
      ["run", "yield", invalidRun.id, "--summary", "must roll back"],
      store,
      options
    ),
    /not a work run/i
  );
  assert.equal(store.findAgentRun(invalidRun.id)?.status, "active");
  assert.equal(store.getActiveAgentRun(task.id, "worker")?.id, invalidRun.id);
  assert.equal(store.getRole(task.id, "worker")?.status, "running");
  assert.deepEqual(store.listMessages(task.id), beforeMessages);
});

test("Role bind switches the active Agent while enter remains a foreground CLI action", (t) => {
  const { store, options, calls } = fixture(t);
  const task = createTask(store, options, "Sessions");
  run(["role", "bind", task.id, "leader", "claude"], store, options);
  assert.equal(store.getRole(task.id, "leader")?.activeAgentId, "claude");
  assert.equal(store.getTaskRoleSessionSet(task.id, "leader")?.activeAgentId, "claude");
  run(["role", "bind", task.id, "leader", "codex"], store, options);
  assert.equal(store.getRole(task.id, "leader")?.activeAgentId, "codex");
  run(["role", "bind", task.id, "leader", "claude"], store, options);
  assert.equal(store.getRole(task.id, "leader")?.activeAgentId, "claude");

  assert.throws(
    () => runTaskCommand(["role", "enter", task.id, "leader"], store, options),
    /Draft.*activate/i
  );
  run(["activate", task.id], store, options);
  const execution = runTaskCommand(["enter", task.id], store, options);
  assert.deepEqual(execution, {
    kind: "enter",
    taskId: task.id,
    roleName: "leader",
    output: `Prepared role leader for ${task.id}\n`
  });
  assert.deepEqual(calls.enter, []);
});

test("Task Role add, update, show, and remove preserve lean field-level configuration", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Role settings");

  run([
    "role", "add", task.id, "reviewer", "--agent", "codex",
    "--description", "Review changes", "--model", "gpt-5.6-sol",
    "--effort", "high", "--sandbox", "read-only"
  ], store, options);
  run([
    "role", "update", task.id, "reviewer", "--agent", "codex",
    "--clear-model", "--approval", "never", "--description", "Review safely"
  ], store, options);

  const role = store.getRole(task.id, "reviewer");
  assert.equal(role.description, "Review safely");
  assert.deepEqual(role.agentBindings.codex.config, {
    adapterId: "codex",
    effort: "high",
    permission: { sandbox: "read-only", approval: "never" }
  });

  run([
    "role", "update", task.id, "reviewer", "--agent", "claude",
    "--model", "claude-opus", "--permission-mode", "acceptEdits"
  ], store, options);
  const withClaude = store.getRole(task.id, "reviewer");
  assert.equal(withClaude.activeAgentId, "codex");
  assert.deepEqual(withClaude.agentBindings.claude.config, {
    adapterId: "claude",
    model: "claude-opus",
    permission: { mode: "acceptEdits" }
  });

  const shown = run(["role", "show", task.id, "reviewer"], store, options);
  assert.match(shown, /Task Role: reviewer/);
  assert.match(shown, /CLI default/);
  assert.match(shown, /read-only/);
  assert.doesNotMatch(shown, /\{"adapterId"/);

  const listed = run(["role", "list", task.id], store, options);
  assert.match(listed, /Agent/);
  assert.match(listed, /Health/);
  assert.match(listed, /Native session/);
  assert.doesNotMatch(listed, /Workspace/);

  assert.match(run(["role", "remove", task.id, "reviewer"], store, options), /Removed role reviewer/);
  assert.equal(store.getRole(task.id, "reviewer"), null);
});

test("Task Role creation copies the global worker Role's complete Agent binding and reports it", (t) => {
  const { root, store, options } = fixture(t);
  store.saveGlobalRole(createGlobalRole(
    "worker",
    [createRoleAgentBinding(
      store.getConfiguredAgent("claude"),
      {
        adapterId: "claude",
        model: "sonnet",
        effort: "max",
        yolo: true
      }
    )],
    "claude",
    root,
    NOW
  ));
  const task = createTask(store, options, "Copy configured Worker Role");

  const receipt = run(["role", "add", task.id, "investigator"], store, options);

  assert.deepEqual(
    store.getRole(task.id, "investigator")?.agentBindings.claude.config,
    {
      adapterId: "claude",
      model: "sonnet",
      effort: "max",
      yolo: true
    }
  );
  assert.match(receipt, /Runtime source: Global Role worker/);
  assert.match(receipt, /Agent: claude\/claude/);
  assert.match(receipt, /Model: sonnet; effort: max; YOLO: enabled/);
  const context = run(["context", task.id], store, options);
  assert.match(context, /Runtime source at creation: Global Role worker/);
  assert.match(context, /Model: sonnet; effort: max; YOLO: enabled/);
});

test("integration-required Task cannot complete without delivery evidence", (t) => {
  const { store, options } = fixture(t);
  const created = run(
    ["create", "Deliver a change", "--require-integration"],
    store,
    options
  );
  const task = store.listTasks().at(-1);
  assert.match(created, /Completion: WorkItem, ChangeSet, and committed Integration required/);
  run(["activate", task.id], store, options);

  assert.throws(
    () => runTaskCommand(["complete", task.id, "--summary", "Done"], store, options),
    /requires at least one WorkItem/i
  );
});

test("file-backed Agent text preserves shell metacharacters literally", (t) => {
  const { root, store, options } = fixture(t);
  const task = createTask(store, options, "Preserve Agent text");
  const bodyPath = join(root, "message.txt");
  writeFileSync(bodyPath, "Total is -$12.34 and shell token is $0.\n");

  run(["message", "send", task.id, "--body-file", bodyPath], store, options);

  assert.equal(
    store.listMessages(task.id).at(-1).body,
    "Total is -$12.34 and shell token is $0."
  );
});

test("Leader creates a profiled Worker instance, binds Claude config, then launches Claude", (t) => {
  const { root, store, options } = fixture(t);
  const task = createTask(store, options, "Generic Worker instance");
  store.saveAgentProfile(createAgentProfile({
    id: "implementer",
    defaultAccess: "write",
    description: "Implement one bounded change.",
    instructions: "Follow the WorkItem and return validation evidence.",
    model: "profile-model-hint"
  }, NOW));

  run([
    "role", "add", task.id, "worker",
    "--profile", "implementer",
    "--agent", "codex"
  ], store, options);
  run([
    "role", "update", task.id, "worker",
    "--agent", "claude",
    "--model", "claude-opus",
    "--permission-mode", "acceptEdits",
    "--yolo", "true"
  ], store, options);
  run(["role", "bind", task.id, "worker", "claude"], store, options);

  const worker = store.getRole(task.id, "worker");
  assert.equal(worker.description, "Implement one bounded change.");
  assert.equal(
    worker.systemPrompt,
    "Follow the WorkItem and return validation evidence."
  );
  assert.equal(worker.activeAgentId, "claude");
  assert.deepEqual(Object.keys(worker.agentBindings).sort(), ["claude", "codex"]);
  assert.deepEqual(worker.agentBindings.claude.config, {
    adapterId: "claude",
    model: "claude-opus",
    permission: { mode: "acceptEdits" },
    yolo: true
  });
  assert.equal(worker.agentBindings.codex.config.model, undefined);

  run(["activate", task.id], store, options);
  run([
    "work", "create", task.id, "Implement the change",
    "--role", "worker"
  ], store, options);
  const item = store.listWorkItems(task.id).at(-1);
  run(["work", "dispatch", item.id], store, options);
  assert.equal(store.getRole(task.id, "worker")?.activeAgentId, "claude");

  const plan = new FileRoleLaunchPlanner(root, store, {
    createNativeSessionId: () => "claude-worker-session"
  }).plan({
    taskId: task.id,
    roleName: "worker",
    agentId: "claude",
    adapterId: "claude",
    mode: "new"
  });
  assert.equal(plan.launch.command, "claude");
  assert.deepEqual(
    plan.launch.args.slice(
      plan.launch.args.indexOf("--model"),
      plan.launch.args.indexOf("--model") + 2
    ),
    ["--model", "claude-opus"]
  );
  assert.ok(plan.launch.args.includes("--dangerously-skip-permissions"));
  assert.equal(plan.launch.args.includes("--permission-mode"), false);
  assert.equal(plan.session.nativeSessionId, "claude-worker-session");
});

test("reapplying a Worker Profile replaces portable behavior without changing Agent bindings", (t) => {
  const { root, store, options } = fixture(t);
  const localOptions = { ...options, yuiHome: root };
  mkdirSync(join(root, "skills", "review-policy"), { recursive: true });
  writeFileSync(
    join(root, "skills", "review-policy", "SKILL.md"),
    "# Review policy\n",
    "utf8"
  );
  const task = createTask(store, localOptions, "Replace Worker Profile");
  store.saveAgentProfile(createAgentProfile({
    id: "rich-worker",
    description: "Implement a bounded change.",
    instructions: "Modify the implementation.",
    skills: ["review-policy"]
  }, NOW));
  store.saveAgentProfile(createAgentProfile({
    id: "plain-worker"
  }, NOW));

  run([
    "role", "add", task.id, "worker",
    "--profile", "rich-worker",
    "--agent", "codex"
  ], store, localOptions);
  run([
    "role", "update", task.id, "worker",
    "--agent", "claude",
    "--model", "claude-opus"
  ], store, localOptions);
  const before = store.getRole(task.id, "worker");

  run([
    "role", "update", task.id, "worker",
    "--profile", "plain-worker"
  ], store, localOptions);
  const after = store.getRole(task.id, "worker");

  assert.equal(after.description, undefined);
  assert.equal(after.systemPrompt, undefined);
  assert.equal(after.skills, undefined);
  assert.deepEqual(after.constraints, ["Do not modify files or external state."]);
  assert.deepEqual(after.agentBindings, before.agentBindings);
  assert.equal(after.activeAgentId, before.activeAgentId);
});

test("Task Role removal is blocked for Leader and active Runs", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Role removal guard");
  assert.throws(
    () => runTaskCommand(["role", "remove", task.id, "leader"], store, options),
    /Leader role cannot be removed/i
  );

  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "active"], store, options);
  const item = store.listWorkItems(task.id)[0];
  run(["activate", task.id], store, options);
  dispatchTestRun(store, task.id, "worker", item.id);
  assert.throws(
    () => runTaskCommand(["role", "remove", task.id, "worker"], store, options),
    /active Run/i
  );
  assert.notEqual(store.getRole(task.id, "worker"), null);
});

test("archive refuses active work and leaves its runtime ownership intact", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Archive");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "unfinished"], store, options);
  const item = store.listWorkItems(task.id)[0];
  dispatchTestRun(store, task.id, "leader", item.id);
  const active = store.getActiveAgentRun(task.id, "leader");

  assert.throws(
    () => run(["archive", task.id, "--integrated"], store, options),
    /must be completed/i
  );
  assert.equal(store.getTask(task.id)?.status, "active");
  assert.equal(store.findAgentRun(active.id)?.status, "active");
  assert.equal(store.findWorkItem(item.id)?.status, "running");
  assert.equal(store.getActiveAgentRun(task.id, "leader")?.id, active.id);
});

test("completion fences active behavior until an explicit reopen", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Complete and reopen");
  run(["activate", task.id], store, options);
  run(["role", "add", task.id, "worker"], store, options);
  run(["work", "create", task.id, "in flight"], store, options);
  const item = store.listWorkItems(task.id)[0];
  dispatchTestRun(store, task.id, "worker", item.id);

  assert.throws(
    () => runTaskCommand(["complete", task.id, "--summary", "premature"], store, options),
    /active run|running work|unaccepted work/i
  );
  const workerRun = store.getActiveAgentRun(task.id, "worker");
  markDelivered(store, workerRun);
  run(["run", "yield", workerRun.id, "--summary", "done"], store, options);
  run([
    "work", "accept", item.id, "--summary", "reviewed"
  ], store, {
    ...options,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: task.id,
      YUI_ROLE: "leader"
    }
  });

  run(["complete", task.id, "--summary", "Everything requested is done."], store, options);
  const completed = store.getTask(task.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.completionSummary, "Everything requested is done.");
  assert.equal(store.getPendingWakeup(task.id), null);
  assert.equal(store.getLeaderFailure(task.id), null);
  assert.equal(store.getOperatorNotification(task.id), null);
  assert.throws(
    () => runTaskCommand(["message", "send", task.id, "continue"], store, options),
    /completed.*reopen/i
  );
  assert.throws(
    () => runTaskCommand(["enter", task.id], store, options),
    /completed.*reopen/i
  );

  run(["reopen", task.id], store, options);
  assert.equal(store.getTask(task.id)?.status, "active");
  assert.deepEqual(store.getPendingWakeup(task.id)?.reasons, ["task-reopened"]);
  run(["message", "send", task.id, "continue"], store, options);
  assert.ok(store.getPendingWakeup(task.id)?.reasons.includes("user-message"));
});

test("Task completion requires every WorkItem to be terminal", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Settle work first");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "not needed"], store, options);
  const item = store.listWorkItems(task.id)[0];

  assert.throws(
    () => runTaskCommand(["complete", task.id, "--summary", "Done"], store, options),
    /unsettled work|work-item-1/i
  );
  assert.equal(store.getTask(task.id)?.status, "active");

  run(["work", "cancel", item.id, "--summary", "No longer needed."], store, options);
  run(["complete", task.id, "--summary", "Done"], store, options);
  assert.equal(store.getTask(task.id)?.status, "completed");
  assert.equal(store.findWorkItem(item.id)?.status, "cancelled");
});

test("a failed WorkItem can be explicitly closed after its isolated workspace was abandoned", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Recover failed isolated work");
  run(["activate", task.id], store, options);
  run(["work", "create", task.id, "first attempt", "--role", "leader"], store, options);
  const item = store.listWorkItems(task.id)[0];
  const running = updateWorkItemStatus(item, "running", NOW);
  store.saveWorkItem(task.id, running);
  const failed = updateWorkItemStatus(running, "failed", NOW, "Native session exited.");
  store.saveWorkItem(task.id, failed);
  store.saveWorkItem(
    task.id,
    recordWorkItemWorkspaceDisposition(failed, "abandoned", NOW)
  );

  run(
    ["work", "update", item.id, "superseded", "--summary", "Replacement completed."],
    store,
    options
  );
  run(["complete", task.id, "--summary", "Recovered and delivered."], store, options);

  assert.equal(store.getTask(task.id)?.status, "completed");
  assert.equal(store.findWorkItem(item.id)?.status, "superseded");
  assert.equal(store.findWorkItem(item.id)?.workspaceDisposition, "abandoned");
});

test("a Leader control Run can complete its Task atomically", (t) => {
  const { store, options } = fixture(t);
  const task = createTask(store, options, "Leader completes");
  run(["activate", task.id], store, options);
  const leader = store.getRole(task.id, "leader");
  const controlRun = createAgentRun(
    store.nextAgentRunId(task.id),
    task.id,
    "leader",
    "new",
    "Review final state",
    NOW
  );
  controlRun.deliveredAt = NOW.toISOString();
  store.transaction((tx) => {
    tx.saveActiveAgentRun(controlRun);
    tx.saveRole(task.id, updateRoleStatus(leader, "running", NOW));
  });
  markDelivered(store, controlRun);

  run(
    ["complete", task.id, "--summary", "Final review passed."],
    store,
    {
      ...options,
      environment: {
        YUI_SESSION_SCOPE: "task",
        YUI_TASK_ID: task.id,
        YUI_ROLE: "leader"
      }
    }
  );

  assert.equal(store.getTask(task.id)?.status, "completed");
  assert.equal(store.findAgentRun(controlRun.id)?.status, "yielded");
  assert.equal(store.findAgentRun(controlRun.id)?.summary, "Final review passed.");
  assert.equal(store.getActiveAgentRun(task.id, "leader"), null);
  assert.equal(store.getRole(task.id, "leader")?.status, "idle");
});

test("a Leader session cannot complete another Task as that Task's Leader", (t) => {
  const { store, options } = fixture(t);
  const source = createTask(store, options, "Source Task");
  run(["activate", source.id], store, options);
  const target = createTask(store, options, "Target Task");
  run(["activate", target.id], store, options);
  const targetLeader = store.getRole(target.id, "leader");
  const targetRun = createAgentRun(
    store.nextAgentRunId(target.id),
    target.id,
    "leader",
    "new",
    "Target control run",
    NOW
  );
  targetRun.deliveredAt = NOW.toISOString();
  store.transaction((tx) => {
    tx.saveActiveAgentRun(targetRun);
    tx.saveRole(target.id, updateRoleStatus(targetLeader, "running", NOW));
  });

  assert.throws(
    () => runTaskCommand(
      ["complete", target.id, "--summary", "Wrong Task"],
      store,
      {
        ...options,
        environment: {
          YUI_SESSION_SCOPE: "task",
          YUI_TASK_ID: source.id,
          YUI_ROLE: "leader"
        }
      }
    ),
    /active Leader run/i
  );
  assert.equal(store.getTask(target.id)?.status, "active");
  assert.equal(store.getActiveAgentRun(target.id, "leader")?.id, targetRun.id);
});

test("reconcile only requests the Controller runtime", (t) => {
  const { store, options, calls } = fixture(t);
  const task = createTask(store, options, "Reconcile");
  run(["reconcile", task.id], store, options);
  assert.deepEqual(calls.reconcile, [task.id]);
  assert.equal(store.getTask(task.id)?.status, "draft");
});
