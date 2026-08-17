import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import {
  createRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../../dist/role/role.js";
import {
  createAgentRun,
  markAgentRunDelivered
} from "../../dist/run/agentRun.js";
import { computeYieldOutcomeDigest } from "../../dist/run/yieldReceipt.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { taskOwnedWorkspace } from "../helpers/taskWorkspace.js";
import {
  bindTaskRoleRun,
  createRoleSessionSet,
  markTaskRoleRunDelivered,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import { updateWorkItemStatus, createWorkItem } from "../../dist/workItem/workItem.js";

/**
 * Issue 04 — idempotent yield receipt.
 *
 * A yield whose response was lost after the commit must be safely replayable:
 * the same request returns the same receipt without creating a second
 * Candidate, Run, or Event; a different outcome on an already-terminal Run
 * fails closed. The receipt is written in the same transaction as the
 * terminal state, so a crash before the commit leaves an active Run (normal
 * resend) and a crash after the commit leaves a durable receipt (idempotent
 * resend).
 */

const FIRST = new Date("2026-08-17T00:00:00.000Z");
const SECOND = new Date("2026-08-17T00:00:01.000Z");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-yield-receipt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "yui-home");
  ensureStorageSchema(home, FIRST);
  const store = new SqliteTaskStore(home);
  t.after(() => store.close());
  const agent = createConfiguredAgent("claude-primary", "claude", "claude", [], [], FIRST);
  const task = activateTask(createTask("task-1", "Yield receipt", FIRST, {
    cwd: home
  }), FIRST);
  const binding = createRoleAgentBinding(agent);
  const leader = createRole(task.id, "leader", [binding], agent.id, home, FIRST);
  const worker = createRole(task.id, "worker", [binding], agent.id, home, FIRST);
  const item = updateWorkItemStatus(createWorkItem(
    "work-item-1",
    task.id,
    { title: "Return exact result", assignee: worker.name },
    FIRST
  ), "running", FIRST);
  let run = createAgentRun(
    "agent-run-1",
    task.id,
    worker.name,
    "new",
    "Do the work",
    FIRST,
    {
      workItemId: item.id,
      effective: resolveEffectiveLaunch({ role: worker, purpose: "execution" })
    }
  );
  run = markAgentRunDelivered(run, SECOND);
  const target = { kind: "role", taskId: task.id, roleName: worker.name };
  store.transaction((tx) => {
    tx.saveConfiguredAgent(agent);
    tx.saveTask(task);
    tx.saveManagedWorkspace(taskOwnedWorkspace(task, FIRST));
    tx.saveRole(task.id, leader);
    tx.saveRole(task.id, updateRoleStatus(worker, "running", FIRST));
    tx.saveWorkItem(task.id, item);
    tx.saveAgentRun(run);
    tx.saveActiveAgentRun(run);
    let sessions = createRoleSessionSet(
      { scope: "task", taskId: task.id, roleName: worker.name },
      agent.id,
      FIRST
    );
    sessions = recordRoleAgentSession(sessions, {
      agentId: agent.id,
      adapterId: "claude",
      nativeSessionId: "native-1",
      launchId: "launch-1",
      policy: "fixed",
      status: "running",
      effective: run.effective
    }, FIRST);
    sessions = bindTaskRoleRun(sessions, {
      agentId: agent.id,
      runId: run.id,
      receiptId: `agent-run:${task.id}/${run.id}`
    }, FIRST);
    sessions = markTaskRoleRunDelivered(sessions, {
      agentId: agent.id,
      runId: run.id,
      receiptId: `agent-run:${task.id}/${run.id}`
    }, SECOND);
    tx.saveTaskRoleSessionSet(sessions);
  });
  return { home, store, task, worker, item, run, agent, target };
}

function yieldRun(store, task, run, summary, environment = {}) {
  return runTaskCommand(
    ["run", "yield", `${task.id}/${run.id}`, "--summary", summary],
    store,
    { now: () => SECOND, environment }
  );
}

test("yield commit writes a receipt atomically with the terminal Run and Candidate", (t) => {
  const { store, task, item, run } = fixture(t);
  const summary = "The work is complete.";
  const result = yieldRun(store, task, run, summary);
  assert.equal(result.kind, "output");

  const terminal = store.getAgentRun(task.id, run.id);
  assert.equal(terminal.status, "yielded");
  assert.equal(terminal.summary, summary);
  assert.ok(terminal.yieldReceipt, "a yielded Run must carry its receipt");
  assert.equal(terminal.yieldReceipt.schemaVersion, 1);
  assert.ok(terminal.yieldReceipt.receiptId.startsWith(`yield-receipt:${task.id}:${run.id}:`));
  assert.ok(terminal.yieldReceipt.requestId.startsWith(`yield:${task.id}:${run.id}:`));
  assert.equal(terminal.yieldReceipt.outcomeDigest.length, 64);
  assert.equal(store.getWorkItem(task.id, item.id).candidates.length, 1);
  assert.equal(store.getActiveAgentRun(task.id, "worker"), null);
});

test("resending the same yield 5 times returns the same receipt with no new state", (t) => {
  const { store, task, item, run } = fixture(t);
  const summary = "The work is complete.";
  const first = yieldRun(store, task, run, summary);
  assert.equal(first.kind, "output");
  const receiptId = store.getAgentRun(task.id, run.id).yieldReceipt.receiptId;
  const eventsBefore = store.listEvents(task.id).length;
  const candidatesBefore = store.getWorkItem(task.id, item.id).candidates.length;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const replay = yieldRun(store, task, run, summary);
    assert.equal(replay.kind, "output", `resend ${attempt + 1} must succeed`);
    assert.match(replay.output, /already committed/);
    assert.ok(replay.data.receipt, `resend ${attempt + 1} must return the receipt`);
    assert.equal(replay.data.receipt.receiptId, receiptId);
  }

  const terminal = store.getAgentRun(task.id, run.id);
  assert.equal(terminal.status, "yielded");
  assert.equal(terminal.yieldReceipt.receiptId, receiptId);
  assert.equal(store.getWorkItem(task.id, item.id).candidates.length, candidatesBefore);
  assert.equal(store.listEvents(task.id).length, eventsBefore);
  assert.equal(store.listAgentRuns(task.id).length, 1);
});

test("a different outcome on an already-terminal Run fails closed and shows the existing receipt", (t) => {
  const { store, task, run } = fixture(t);
  yieldRun(store, task, run, "original outcome");
  const receiptId = store.getAgentRun(task.id, run.id).yieldReceipt.receiptId;

  assert.throws(
    () => yieldRun(store, task, run, "a conflicting outcome"),
    (error) => {
      assert.match(error.message, /already terminal with a different yield outcome/);
      assert.ok(error.message.includes(receiptId), "error must show the existing receipt");
      return true;
    }
  );
  // The failed resend must not have mutated the committed receipt.
  const terminal = store.getAgentRun(task.id, run.id);
  assert.equal(terminal.summary, "original outcome");
  assert.equal(terminal.yieldReceipt.receiptId, receiptId);
});

test("yield-status returns the committed receipt for a terminal Run", (t) => {
  const { store, task, run } = fixture(t);
  const active = runTaskCommand(
    ["run", "yield-status", `${task.id}/${run.id}`],
    store,
    { now: () => FIRST }
  );
  assert.equal(active.kind, "output");
  assert.match(active.output, /active; no yield receipt yet/);

  yieldRun(store, task, run, "done");
  const status = runTaskCommand(
    ["run", "yield-status", `${task.id}/${run.id}`],
    store,
    { now: () => SECOND }
  );
  assert.equal(status.kind, "output");
  assert.match(status.output, /yield receipt/);
  assert.ok(status.data.receipt);
  assert.equal(
    status.data.receipt.receiptId,
    store.getAgentRun(task.id, run.id).yieldReceipt.receiptId
  );
});

test("a Controller restart after the commit replays the same receipt from durable state", (t) => {
  const { home, store, task, run } = fixture(t);
  const summary = "durable outcome";
  yieldRun(store, task, run, summary);
  const committed = store.getAgentRun(task.id, run.id).yieldReceipt;

  // Simulate a Controller restart: a brand-new store over the same Home.
  const restarted = new SqliteTaskStore(home);
  t.after(() => restarted.close());
  const replayed = yieldRun(restarted, task, run, summary);
  assert.equal(replayed.kind, "output");
  assert.equal(replayed.data.receipt.receiptId, committed.receiptId);
  assert.equal(replayed.data.receipt.outcomeDigest, committed.outcomeDigest);
  assert.equal(restarted.listAgentRuns(task.id).length, 1);
});

test("disabling receipt replay keeps the legacy already-terminal error", (t) => {
  const { store, task, run } = fixture(t);
  yieldRun(store, task, run, "done");
  assert.throws(
    () => yieldRun(store, task, run, "done", { YUI_YIELD_RECEIPT_REPLAY: "0" }),
    /already terminal: yielded/
  );
});

test("the same outcome text always produces the same digest regardless of key order", (t) => {
  const direct = computeYieldOutcomeDigest({ status: "yielded", summary: "x" });
  const reversed = computeYieldOutcomeDigest({ summary: "x", status: "yielded" });
  assert.equal(direct, reversed);
  assert.notEqual(
    computeYieldOutcomeDigest({ status: "yielded", summary: "x" }),
    computeYieldOutcomeDigest({ status: "yielded", summary: "y" })
  );
});
