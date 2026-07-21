import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { runControllerSchedulerPass } from "../../dist/controller/controller.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import {
  answerInputRequest,
  cancelInputRequest,
  createInputRequest,
  validateInputRequest
} from "../../dist/input/inputRequest.js";
import {
  createGlobalRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../../dist/role/role.js";
import { createAgentRun } from "../../dist/run/agentRun.js";
import { processLeaderWakeups } from "../../dist/scheduler/leaderWakeupProcessor.js";
import { mergePendingWakeup } from "../../dist/scheduler/pendingWakeup.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";

const FIRST = new Date("2026-07-21T01:00:00.000Z");
const SECOND = new Date("2026-07-21T01:01:00.000Z");

function requester(overrides = {}) {
  return {
    roleName: "leader",
    agentId: "codex",
    runId: "agent-run-1",
    nativeSessionId: "native-1",
    ...overrides
  };
}

test("InputRequest domain supports text or choice answers and terminal transitions", () => {
  const choice = createInputRequest(
    "input-1",
    "task-1",
    requester(),
    {
      question: " Which path? ",
      choices: [
        { key: "safe", label: "Safe path" },
        { key: "fast", label: "Fast path" }
      ],
      blockedRefs: [
        { type: "work-item", id: "work-item-1" },
        { type: "run", id: "agent-run-2" }
      ]
    },
    FIRST
  );
  assert.equal(choice.status, "open");
  assert.equal(choice.question, "Which path?");
  assert.deepEqual(choice.policy, { kind: "required" });

  const answered = answerInputRequest(
    choice,
    { choiceKey: "safe" },
    "operator",
    SECOND
  );
  assert.equal(answered.status, "answered");
  assert.deepEqual(answered.resolution.answer, { choiceKey: "safe", text: "Safe path" });
  assert.equal(answered.resolution.answeredBy, "operator");
  assert.equal(answered.resolution.answeredAt, SECOND.toISOString());
  assert.throws(() => answerInputRequest(
    answered,
    { choiceKey: "fast" },
    "user",
    SECOND
  ), /already answered/i);
  assert.throws(() => validateInputRequest({
    ...answered,
    resolution: {
      ...answered.resolution,
      answer: { choiceKey: "fast", text: "Safe path" }
    }
  }), /answer text does not match/i);

  const freeText = createInputRequest(
    "input-2",
    "task-1",
    requester(),
    { question: "Describe the constraint", choices: [], blockedRefs: [] },
    FIRST
  );
  const textAnswer = answerInputRequest(
    freeText,
    { text: "Keep compatibility" },
    "user",
    SECOND
  );
  assert.deepEqual(textAnswer.resolution.answer, { text: "Keep compatibility" });
  assert.throws(() => answerInputRequest(
    freeText,
    { choiceKey: "missing" },
    "user",
    SECOND
  ), /does not accept a choice/i);

  const cancelled = cancelInputRequest(freeText, "No longer needed", SECOND);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancellation.cancelledAt, SECOND.toISOString());
  assert.throws(() => cancelInputRequest(cancelled, "Again", SECOND), /already cancelled/i);

  const recommended = createInputRequest(
    "input-3",
    "task-1",
    requester(),
    {
      question: "Use the safe fallback?",
      choices: [
        { key: "safe", label: "Safe path" },
        { key: "fast", label: "Fast path" }
      ],
      blockedRefs: [],
      policy: {
        kind: "recommended",
        recommendedChoiceKey: "safe",
        timeoutAt: SECOND.toISOString()
      }
    },
    FIRST
  );
  assert.deepEqual(recommended.policy, {
    kind: "recommended",
    recommendedChoiceKey: "safe",
    timeoutAt: SECOND.toISOString()
  });
  assert.throws(() => answerInputRequest(
    recommended,
    { choiceKey: "safe" },
    "agent-timeout",
    FIRST
  ), /has not reached its timeout/i);
  assert.throws(() => answerInputRequest(
    recommended,
    { choiceKey: "fast" },
    "agent-timeout",
    SECOND
  ), /must use the recommended choice/i);
  const fallback = answerInputRequest(
    recommended,
    { choiceKey: "safe" },
    "agent-timeout",
    SECOND
  );
  assert.equal(fallback.resolution.answeredBy, "agent-timeout");
  assert.deepEqual(fallback.resolution.answer, { choiceKey: "safe", text: "Safe path" });
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "taskmux-input-request-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, FIRST);
  const store = new FileTaskStore(root);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], FIRST);
  const leader = createGlobalRole(
    "leader",
    [createRoleAgentBinding(agent)],
    agent.id,
    root,
    FIRST
  );
  store.transaction((tx) => {
    tx.saveConfig({ schemaVersion: 1, defaultAgent: agent.id, defaultWorkspace: root });
    tx.saveConfiguredAgent(agent);
    tx.saveGlobalRole(createGlobalRole(
      "operator",
      [createRoleAgentBinding(agent)],
      agent.id,
      root,
      FIRST
    ));
    tx.saveGlobalRole(leader);
  });
  const changed = [];
  const runtime = {
    notifyStateChanged(taskId) { changed.push(taskId); },
    reconcileTask() {},
    prepareTaskRoleEnter() {}
  };
  const options = { runtime, now: () => new Date(FIRST) };
  runTaskCommand(["create", "Need user input"], store, options);
  const task = store.listTasks()[0];
  runTaskCommand(["activate", task.id], store, options);
  store.clearPendingWakeup(task.id);
  const role = store.getRole(task.id, "leader");
  const active = {
    ...createAgentRun(
      store.nextAgentRunId(task.id),
      task.id,
      role.name,
      "resume",
      "Steward the task",
      FIRST
    ),
    deliveredAt: FIRST.toISOString()
  };
  let sessions = createRoleSessionSet(
    { scope: "task", taskId: task.id, roleName: role.name },
    role.activeAgentId,
    FIRST
  );
  sessions = recordRoleAgentSession(sessions, {
    agentId: role.activeAgentId,
    adapterId: role.agentBindings[role.activeAgentId].adapterId,
    nativeSessionId: "native-1",
    policy: "fixed",
    status: "running"
  }, FIRST);
  store.transaction((tx) => {
    tx.saveActiveAgentRun(active);
    tx.saveRole(task.id, updateRoleStatus(role, "running", FIRST));
    tx.saveTaskRoleSessionSet(sessions);
  });
  const environment = {
    TASKMUX_SESSION_SCOPE: "task",
    TASKMUX_TASK_ID: task.id,
    TASKMUX_ROLE: "leader",
    TASKMUX_AGENT_ID: role.activeAgentId,
    TASKMUX_RUN_ID: active.id,
    TASKMUX_NATIVE_SESSION_ID: "native-1"
  };
  return { root, store, task, role, active, changed, options: { ...options, environment } };
}

function run(args, store, options) {
  const result = runTaskCommand(args, store, options);
  assert.equal(result.kind, "output");
  return result;
}

test("Leader request releases its active fence and answer durably queues a resume wake", (t) => {
  const { root, store, task, active, options } = fixture(t);
  const work = createWorkItem("work-item-foreign-check", task.id, {
    title: "Check rollout",
    assignee: "leader"
  }, FIRST);
  store.saveWorkItem(task.id, work);

  run([
    "input", "request", task.id,
    "--question", "Which rollout?",
    "--choice", "safe=Safe rollout",
    "--choice", "fast=Fast rollout",
    "--blocks", `work-item:${work.id}`,
    "--blocks", `run:${active.id}`
  ], store, options);

  const request = store.listInputRequests(task.id)[0];
  assert.equal(request.requester.runId, active.id);
  assert.deepEqual(request.blockedRefs, [
    { type: "work-item", id: work.id },
    { type: "run", id: active.id }
  ]);
  assert.equal(store.getActiveAgentRun(task.id, "leader"), null);
  assert.equal(store.getAgentRun(task.id, active.id).status, "yielded");
  assert.match(store.getAgentRun(task.id, active.id).summary, new RegExp(request.id));
  assert.equal(store.getRole(task.id, "leader").status, "idle");
  assert.equal(store.getRoleSession(task.id, "leader").status, "ready");
  assert.equal(store.listEvents(task.id).at(-1).type, "input.requested");

  const reloaded = new FileTaskStore(root);
  assert.deepEqual(reloaded.getInputRequest(task.id, request.id), request);
  const answer = run([
    "input", "answer", request.id,
    "--choice", "safe"
  ], reloaded, { ...options, now: () => new Date(SECOND), environment: {} });
  assert.equal(answer.data.request.status, "answered");
  assert.equal(answer.data.request.resolution.answeredBy, "user");
  assert.ok(reloaded.getPendingWakeup(task.id).reasons.includes(`input-answered:${request.id}`));
  assert.equal(reloaded.listEvents(task.id).at(-1).type, "input.answered");
  assert.throws(() => runTaskCommand([
    "input", "answer", request.id, "--choice", "fast"
  ], reloaded, { ...options, environment: {} }), /already answered/i);

  const json = JSON.parse(execFileSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), "--json", "task", "input", "list", "--all"],
    { encoding: "utf8", env: { ...process.env, TASKMUX_HOME: root } }
  ));
  assert.deepEqual(json, { ok: true, data: { requests: [answer.data.request] } });
});

test("first Leader run can request input before a native session id is registered", (t) => {
  const { store, task, active, options } = fixture(t);
  store.transaction((tx) => {
    tx.saveTaskRoleSessionSet(createRoleSessionSet(
      { scope: "task", taskId: task.id, roleName: "leader" },
      "codex",
      FIRST
    ));
  });
  const environment = { ...options.environment };
  delete environment.TASKMUX_NATIVE_SESSION_ID;

  run(["input", "request", task.id, "--question", "First turn question?"], store, {
    ...options,
    environment
  });

  const request = store.listInputRequests(task.id)[0];
  assert.equal(request.requester.runId, active.id);
  assert.equal(request.requester.nativeSessionId, undefined);
  assert.equal(store.getActiveAgentRun(task.id, "leader"), null);
});

test("a pending wake cannot bypass open input and becomes dispatchable after answer", async (t) => {
  const { store, task, options } = fixture(t);
  store.savePendingWakeup(mergePendingWakeup(task.id, "user-message", FIRST, null));
  run(["input", "request", task.id, "--question", "Wait for the user?"], store, options);

  const calls = [];
  const delivery = {
    async prepareRoleSession(input) {
      calls.push("prepare");
      return { ...input, deliveryId: "input-wakeup-delivery" };
    },
    async waitUntilReady(prepared) {
      calls.push("ready");
      const session = store.getRoleSession(task.id, "leader");
      return {
        prepared,
        session: {
          agentId: session.agentId,
          adapterId: session.adapterId,
          nativeSessionId: session.nativeSessionId,
          status: "running"
        }
      };
    },
    async sendOnce() { calls.push("send"); return "sent"; },
    async inspectRole() { return "present"; },
    async stopTask() { return false; }
  };
  const scheduler = new FileSchedulerStoreAdapter(store);
  assert.deepEqual(await processLeaderWakeups(scheduler, delivery, FIRST), [
    { taskId: task.id, status: "skipped", reason: "waiting-input" }
  ]);
  assert.deepEqual(calls, []);
  assert.equal(store.getPendingWakeup(task.id).requestCount, 1);

  const request = store.listInputRequests(task.id)[0];
  run(["input", "answer", request.id, "--text", "Continue"], store, {
    ...options,
    now: () => new Date(SECOND),
    environment: { TASKMUX_SESSION_SCOPE: "global", TASKMUX_ROLE: "operator" }
  });
  assert.equal(store.getInputRequest(task.id, request.id).resolution.answeredBy, "operator");
  assert.ok(store.getPendingWakeup(task.id).reasons.includes(`input-answered:${request.id}`));
  assert.equal((await processLeaderWakeups(scheduler, delivery, SECOND))[0].status, "dispatched");
  assert.deepEqual(calls, ["prepare", "ready", "send"]);
  assert.equal(store.getActiveAgentRun(task.id, "leader").mode, "resume");
});

test("Controller nudges an available Operator once while the Inbox remains authoritative", async (t) => {
  const { store, task, options } = fixture(t);
  run([
    "input", "request", task.id,
    "--question", "Which rollout?",
    "--choice", "safe=Safe rollout",
    "--choice", "fast=Fast rollout"
  ], store, options);
  const request = store.listInputRequests(task.id)[0];
  const notifications = [];
  const delivery = {
    async prepareRoleSession() { throw new Error("unused"); },
    async waitUntilReady() { throw new Error("unused"); },
    async sendOnce() { throw new Error("unused"); },
    async inspectRole() { return "present"; },
    async stopTask() { return false; },
    async notifyOperatorInputOnce(input) {
      notifications.push(input);
      return "sent";
    }
  };

  const result = await runControllerSchedulerPass(
    new FileSchedulerStoreAdapter(store),
    delivery,
    new Date("2099-01-01T00:00:00.000Z")
  );

  assert.deepEqual(result.autoResolvedInputs, []);
  assert.deepEqual(result.inputNotifications, [{
    inputRequestId: request.id,
    taskId: task.id,
    status: "sent"
  }]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].receiptId, `input-request:${request.id}`);
  assert.equal(notifications[0].roleName, "operator");
  assert.match(notifications[0].text, new RegExp(`Input: ${request.id}`));
  assert.match(notifications[0].text, /Which rollout\?/);
  assert.match(notifications[0].text, /safe: Safe rollout/);
  assert.match(notifications[0].text, /do not answer it yourself/i);
  assert.match(notifications[0].text, /no automatic fallback/i);
  assert.equal(store.getInputRequest(task.id, request.id).status, "open");
});

test("Controller atomically applies an expired Agent recommendation and resumes Leader", async (t) => {
  const { store, task, options } = fixture(t);
  run([
    "input", "request", task.id,
    "--question", "Which rollout?",
    "--choice", "safe=Safe rollout",
    "--choice", "fast=Fast rollout",
    "--recommend", "safe",
    "--timeout-seconds", "60"
  ], store, options);
  const request = store.listInputRequests(task.id)[0];
  assert.deepEqual(request.policy, {
    kind: "recommended",
    recommendedChoiceKey: "safe",
    timeoutAt: SECOND.toISOString()
  });
  const leaderCalls = [];
  const notices = [];
  let leaderWakeupText = "";
  const delivery = {
    async prepareRoleSession(input) {
      leaderCalls.push("prepare");
      return { ...input, deliveryId: "recommendation-wakeup" };
    },
    async waitUntilReady(prepared) {
      leaderCalls.push("ready");
      const session = store.getRoleSession(task.id, "leader");
      return { prepared, session: { ...session, status: "running" } };
    },
    async sendOnce(input) {
      leaderCalls.push("send");
      leaderWakeupText = input.text;
      return "sent";
    },
    async inspectRole() { return "present"; },
    async stopTask() { return false; },
    async notifyOperatorInputOnce(input) {
      notices.push(input.text);
      return "sent";
    }
  };

  const beforeTimeout = await runControllerSchedulerPass(
    new FileSchedulerStoreAdapter(store),
    delivery,
    new Date(FIRST.getTime() + 30_000)
  );
  assert.deepEqual(beforeTimeout.autoResolvedInputs, []);
  assert.equal(store.getInputRequest(task.id, request.id).status, "open");
  assert.match(notices[0], /Agent recommendation: safe: Safe rollout/);
  assert.match(notices[0], new RegExp(`Automatic fallback after: ${SECOND.toISOString()}`));

  const result = await runControllerSchedulerPass(
    new FileSchedulerStoreAdapter(store),
    delivery,
    SECOND
  );

  assert.deepEqual(result.autoResolvedInputs, [{
    inputRequestId: request.id,
    taskId: task.id,
    choiceKey: "safe"
  }]);
  assert.equal(result.wakeups[0].status, "dispatched");
  assert.deepEqual(leaderCalls, ["prepare", "ready", "send"]);
  assert.match(leaderWakeupText, new RegExp(`input-timeout:${request.id}`));
  assert.match(leaderWakeupText, new RegExp(`task context ${task.id}`));
  assert.match(leaderWakeupText, /recently resolved input requests/);
  assert.equal(notices.length, 1);
  const resolved = store.getInputRequest(task.id, request.id);
  assert.equal(resolved.status, "answered");
  assert.equal(resolved.resolution.answeredBy, "agent-timeout");
  assert.deepEqual(resolved.resolution.answer, {
    choiceKey: "safe",
    text: "Safe rollout"
  });
  assert.equal(store.listEvents(task.id).at(-1).type, "input.auto-answered");
});

test("request provenance, blocked ownership, lifecycle, and origin-only cancel are fenced", (t) => {
  const { store, task, active, options } = fixture(t);
  const other = runTaskCommand(["create", "Other"], store, options);
  assert.equal(other.kind, "output");
  const otherTask = store.listTasks().find((entry) => entry.id !== task.id);
  const foreignWork = createWorkItem("foreign-work", otherTask.id, {
    title: "Foreign",
    assignee: "leader"
  }, FIRST);
  store.saveWorkItem(otherTask.id, foreignWork);

  assert.throws(() => runTaskCommand([
    "input", "request", task.id,
    "--question", "Forged",
    "--blocks", `work-item:${foreignWork.id}`
  ], store, options), /belongs to another Task/i);
  assert.throws(() => runTaskCommand([
    "input", "request", task.id, "--question", "Forged"
  ], store, {
    ...options,
    environment: { ...options.environment, TASKMUX_RUN_ID: "agent-run-forged" }
  }), /active Leader Run/i);
  assert.throws(() => runTaskCommand([
    "input", "request", task.id,
    "--question", "Incomplete fallback",
    "--choice", "safe=Safe rollout",
    "--recommend", "safe"
  ], store, options), /--recommend and --timeout-seconds must be used together/i);
  assert.equal(store.getActiveAgentRun(task.id, "leader").id, active.id);

  run(["input", "request", task.id, "--question", "Proceed?"], store, options);
  const request = store.listInputRequests(task.id)[0];
  assert.throws(() => runTaskCommand([
    "complete", task.id, "--summary", "Cannot complete with open input"
  ], store, { ...options, environment: {} }), /open input/i);
  assert.throws(() => runTaskCommand([
    "archive", task.id
  ], store, { ...options, environment: {} }), /open input/i);
  assert.throws(() => runTaskCommand([
    "input", "cancel", task.id, request.id, "--reason", "Forged"
  ], store, {
    ...options,
    environment: { ...options.environment, TASKMUX_NATIVE_SESSION_ID: "native-forged" }
  }), /originating Leader/i);
  run([
    "input", "cancel", task.id, request.id, "--reason", "No longer needed"
  ], store, { ...options, now: () => new Date(SECOND) });
  assert.equal(store.getInputRequest(task.id, request.id).status, "cancelled");
  assert.equal(store.getPendingWakeup(task.id), null);
  const completed = run([
    "complete", task.id, "--summary", "Cancelled input before completion"
  ], store, { ...options, environment: {} });
  assert.match(completed.output, /Completed task/);
  assert.equal(store.getAgentRun(task.id, active.id).status, "yielded");
});

test("Task details expose open InputRequest counts and storage rejects unknown fields", (t) => {
  const { root, store, task, options } = fixture(t);
  run(["input", "request", task.id, "--question", "Visible?"], store, options);
  const shown = run(["show", task.id], store, { ...options, environment: {} });
  assert.match(shown.output, /Open inputs: 1/);
  assert.equal(shown.data.counts.openInputs, 1);

  const statePath = join(root, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const requestId = Object.keys(state.tasks[task.id].inputRequests)[0];
  state.tasks[task.id].inputRequests[requestId].unexpected = true;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  assert.throws(
    () => new FileTaskStore(root).listInputRequests(task.id),
    /Input request has unknown field: unexpected/i
  );
});
