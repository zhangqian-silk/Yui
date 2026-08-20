import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { FileRuntimeEventProcessor } from "../../dist/controller/runtimeEventProcessor.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { runRuntimeObservationHookCommand } from "../../dist/controller/runtimeObservationHook.js";
const runClaudeLifecycleHookCommand = (payload, environment, ...rest) => (
  runRuntimeObservationHookCommand(payload, {
    ...environment,
    YUI_DRIVER_ID: "anthropic/claude-code"
  }, ...rest)
);
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunDelivered,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import {
  createRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../../dist/role/role.js";
import {
  createAgentRun,
  markAgentRunDelivered
} from "../../dist/run/agentRun.js";
import { processActiveRoleRunDeliveries } from "../../dist/scheduler/activeRoleRunDelivery.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { taskOwnedWorkspace } from "../helpers/taskWorkspace.js";
import {
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import {
  attachReviewRoundWorkspace,
  createReviewRound,
  startReviewRound
} from "../../dist/review/reviewRound.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createProject } from "../../dist/repository/project.js";
import { createIsolatedRuntime } from "../helpers/isolatedRuntime.js";
import { installMockProviderCommands } from "../helpers/mockProviderCommands.js";

/**
 * Issue 04 — a final Review Run's transient Provider failure retries in place
 * without creating a new semantic ReviewRound. The Reviewer stays on the same
 * Run and Native Session; when the full report is finally yielded, the same
 * Round completes once and the receipt is replayable.
 */

const BASE = new Date("2026-08-17T00:00:00.000Z");
const REVIEW_REPORT = JSON.stringify({
  summary: "No material finding.",
  findings: [],
  checks: [{ name: "build", outcome: "passed" }]
});

function hookCommon(hookEventName) {
  return {
    session_id: "native-review-1",
    prompt_id: "660e8400-e29b-41d4-a716-446655440000",
    transcript_path: "/tmp/claude/native-review-1.jsonl",
    cwd: "/tmp/managed-workspace",
    permission_mode: "dontAsk",
    effort: { level: "max" },
    hook_event_name: hookEventName
  };
}

function fixture(t) {
  const { home } = createIsolatedRuntime(t);
  installMockProviderCommands(home, ["claude"]);
  ensureStorageSchema(home, BASE);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const first = new Date(BASE.getTime());
  const second = new Date(BASE.getTime() + 1_000);
  const agent = createConfiguredAgent("claude-primary", "claude", "claude", [], [], first);
  const task = activateTask(createTask("task-1", "Review retry", first, {
    cwd: home,
    projectBindings: [{ projectId: "project-1", directory: "project-1", baseRef: "main" }]
  }), first);
  const binding = createRoleAgentBinding(agent);
  const leader = createRole(task.id, "leader", [binding], agent.id, home, first);
  const reviewer = createRole(task.id, "reviewer", [binding], agent.id, home, first);
  let item = updateWorkItemStatus(createWorkItem(
    "work-item-1",
    task.id,
    { title: "Change to review" },
    first
  ), "running", first);
  item = submitWorkItemCandidate(item, {
    summary: "integrated candidate",
    source: { type: "direct" }
  }, first);
  item = updateWorkItemStatus(item, "completed", first, "accepted");
  const candidateId = item.candidates[0].id;
  const reviewBaseCommit = "a".repeat(40);
  let round = createReviewRound(
    "review-round-1",
    task.id,
    item.id,
    candidateId,
    reviewer.name,
    "leader",
    reviewBaseCommit,
    first
  );
  const workspaceRoot = join(home, "reviews", round.id);
  const workspace = createManagedWorkspace({
    owner: { type: "review-round", taskId: task.id, reviewRoundId: round.id },
    root: workspaceRoot,
    entries: [{
      projectId: "project-1",
      directory: "project-1",
      access: "write",
      path: join(workspaceRoot, "project-1"),
      branch: `yui/${task.id}/${round.id}-1`,
      baseRef: reviewBaseCommit,
      baseCommit: reviewBaseCommit
    }]
  }, first);
  round = attachReviewRoundWorkspace(round, workspace);
  let run = createAgentRun(
    "agent-run-1",
    task.id,
    reviewer.name,
    "new",
    "Review the candidate",
    first,
    {
      workItemId: item.id,
      purpose: "review",
      reviewRoundId: round.id,
      workspace,
      effective: resolveEffectiveLaunch({
        role: reviewer,
        purpose: "review",
        workspace,
        reviewRoundId: round.id,
        reviewBaseCommit
      })
    }
  );
  run = markAgentRunDelivered(run, second);
  round = startReviewRound(round, run.id);
  const target = { kind: "role", taskId: task.id, roleName: reviewer.name };
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveProject(createProject("project-1", "one", join(home, "project-1"), {
      stable: "main",
      development: "main"
    }, first));
    tx.saveTask(task);
    tx.saveManagedWorkspace(taskOwnedWorkspace(task, first, [{
      projectId: "project-1",
      directory: "project-1",
      access: "write",
      path: join(home, "project-1"),
      branch: "main",
      baseRef: "main",
      baseCommit: reviewBaseCommit
    }]));
    tx.saveRole(task.id, leader);
    tx.saveRole(task.id, updateRoleStatus(reviewer, "running", first));
    tx.saveWorkItem(task.id, item);
    tx.saveReviewRound(task.id, round);
    tx.saveManagedWorkspace(workspace);
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    let sessions = createRoleSessionSet(
      { scope: "task", taskId: task.id, roleName: reviewer.name },
      agent.id,
      first
    );
    sessions = recordRoleAgentSession(sessions, {
      agentId: agent.id,
      adapterId: "claude",
      nativeSessionId: "native-review-1",
      launchId: "launch-review-1",
      policy: "fixed",
      status: "running",
      effective: run.effective
    }, first);
    sessions = bindTaskRoleRun(sessions, {
      agentId: agent.id,
      runId: run.id,
      receiptId: `agent-run:${task.id}/${run.id}`
    }, first);
    sessions = markTaskRoleRunDelivered(sessions, {
      agentId: agent.id,
      runId: run.id,
      receiptId: `agent-run:${task.id}/${run.id}`
    }, second);
    tx.saveTaskRoleSessionSet(sessions);
  });
  return { home, store, task, reviewer, item, round, run, agent, target, first, second };
}

function withRetryEnv(t) {
  const previous = {
    inPlace: process.env.YUI_PROVIDER_RETRY_IN_PLACE,
    mode: process.env.YUI_PROVIDER_RETRY_MODE
  };
  process.env.YUI_PROVIDER_RETRY_IN_PLACE = "claude";
  process.env.YUI_PROVIDER_RETRY_MODE = "enforce";
  t.after(() => {
    if (previous.inPlace === undefined) delete process.env.YUI_PROVIDER_RETRY_IN_PLACE;
    else process.env.YUI_PROVIDER_RETRY_IN_PLACE = previous.inPlace;
    if (previous.mode === undefined) delete process.env.YUI_PROVIDER_RETRY_MODE;
    else process.env.YUI_PROVIDER_RETRY_MODE = previous.mode;
  });
}

async function injectStopFailure(fx, now) {
  await runClaudeLifecycleHookCommand(JSON.stringify({
    ...hookCommon("StopFailure"),
    error: "server_error",
    error_details: "upstream 503",
    last_assistant_message: "partial review"
  }), {
    YUI_HOME: fx.home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: fx.task.id,
    YUI_ROLE: fx.reviewer.name,
    YUI_AGENT_ID: fx.agent.id,
    YUI_ADAPTER_ID: "claude",
    YUI_WORKSPACE: fx.run.effective.workspace.root,
    YUI_LAUNCH_ID: "launch-review-1",
    YUI_RUN_ID: fx.run.id,
    YUI_NATIVE_SESSION_ID: "native-review-1"
  }, async () => ({}), now);
  const inbox = new FileRuntimeEventInbox(fx.home);
  const adapter = new FileSchedulerStoreAdapter(fx.store);
  const drained = new FileRuntimeEventProcessor(inbox, adapter).drain(now);
  assert.deepEqual(drained.failed, []);
  return adapter;
}

function recordingDelivery(fx, calls) {
  return {
    async prepareRoleSession(input) {
      calls.push({ phase: "prepare", mode: input.mode, nativeSessionId: input.nativeSessionId });
      return { ...input, deliveryId: `delivery-${calls.length}`, sessionStarted: false };
    },
    async waitUntilReady(prepared) {
      calls.push({ phase: "ready" });
      const session = fx.store.getRoleSession(fx.task.id, fx.reviewer.name);
      return {
        prepared,
        session: {
          agentId: session.agentId,
          adapterId: session.adapterId,
          nativeSessionId: session.nativeSessionId,
          status: "running",
          effective: session.effective
        }
      };
    },
    async sendOnce() {
      calls.push({ phase: "send" });
      return "sent";
    },
    async inspectRole() { return "present"; },
    async inspectRoles(inputs) {
      return inputs.map(({ taskId, roleName }) => ({ taskId, roleName, status: "present" }));
    },
    async stopTask() { return false; }
  };
}

test("a transient Review failure retries in place and completes the same Round once", async (t) => {
  withRetryEnv(t);
  const fx = fixture(t);
  const runId = fx.run.id;
  const roundId = fx.round.id;
  let now = new Date(fx.second.getTime() + 1_000);

  // A transient StopFailure on the Review Run schedules an in-place retry.
  await injectStopFailure(fx, now);
  let active = fx.store.getAgentRun(fx.task.id, runId);
  assert.equal(active.status, "active");
  assert.equal(active.purpose, "review");
  assert.equal(active.reviewRoundId, roundId);
  assert.ok(active.providerRetry);
  assert.equal(active.providerRetry.attempt, 1);
  assert.equal(active.providerRetry.nativeSessionId, "native-review-1");
  // No new ReviewRound was created.
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
  assert.equal(fx.store.getReviewRound(fx.task.id, roundId).status, "running");

  // Resolve the durable timer and re-deliver on the same Session.
  now = new Date(Date.parse(active.providerRetry.nextAttemptAt) + 1);
  const adapter = new FileSchedulerStoreAdapter(fx.store);
  const reopened = adapter.resolveDueProviderRetries(now);
  assert.equal(reopened.length, 1);
  const calls = [];
  const results = await processActiveRoleRunDeliveries(
    adapter,
    recordingDelivery(fx, calls),
    now
  );
  assert.equal(results[0].status, "delivered");
  assert.equal(calls[0].mode, "resume");
  assert.equal(calls[0].nativeSessionId, "native-review-1");

  // The Reviewer produces its full report and yields. The same Round completes.
  now = new Date(now.getTime() + 1_000);
  const yieldResult = runTaskCommand(
    ["run", "yield", `${fx.task.id}/${runId}`, "--summary", REVIEW_REPORT],
    fx.store,
    { now: () => now, reviewWorkspaceResult: {} }
  );
  assert.equal(yieldResult.kind, "output");
  const terminal = fx.store.getAgentRun(fx.task.id, runId);
  assert.equal(terminal.status, "yielded");
  assert.ok(terminal.yieldReceipt, "Review yield must record a receipt");
  assert.equal(terminal.providerRetry, undefined);
  const round = fx.store.getReviewRound(fx.task.id, roundId);
  assert.equal(round.status, "completed", "the same Round must complete");
  assert.equal(round.reviewerRunId, runId, "no new Reviewer Run");
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1, "no new Round");
  assert.equal(fx.store.listAgentRuns(fx.task.id).length, 1, "no new Run");

  // A lost-response resend returns the same receipt without re-running the review.
  const replay = runTaskCommand(
    ["run", "yield", `${fx.task.id}/${runId}`, "--summary", REVIEW_REPORT],
    fx.store,
    { now: () => now, reviewWorkspaceResult: {} }
  );
  assert.equal(replay.kind, "output");
  assert.match(replay.output, /already committed/);
  assert.equal(replay.data.receipt.receiptId, terminal.yieldReceipt.receiptId);
  assert.equal(fx.store.listReviewRounds(fx.task.id).length, 1);
  assert.equal(fx.store.listAgentRuns(fx.task.id).length, 1);
});
