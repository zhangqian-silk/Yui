import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import {
  bindTaskRoleProviderRuntime, createRoleSessionSet, recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import {
  acceptProviderTurn, beginProviderTurn, cancelQuiescentProviderInput,
  createProviderRuntimeBinding, settleProviderTurn
} from "../../dist/runtime/providerRuntimeIdentity.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { runTaskInputCommand } from "../../dist/commands/taskInputCommands.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { claimPending } from "../../dist/coordination/workMailbox.js";
import { createTaskWake } from "../../dist/scheduler/taskWake.js";
import { readTaskContext } from "../../dist/context/taskContext.js";
import { resolveManagedTaskCaller, resolveManagedTaskReader } from "../../dist/runtime/managedCaller.js";
import { pendingCompletionMessages } from "../../dist/task/completionReadiness.js";
import { codexInteractiveStartupParameters } from "../../dist/runtime/codexInteractiveHost.js";
import { resolveAgentAdapter } from "../../dist/executor/agentAdapter.js";
import { operatorOfflineCommand, taskDiagnosticTarget } from "../../dist/cli/managedDiagnostics.js";
import { publishStructuredProviderTerminal } from "../../dist/controller/structuredProviderObservation.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import { classifyRuntimeHealth, createRuntimeProjection, projectRuntimeObservation, runtimeDisplayStatus } from "../../dist/runtime/runtimeProjection.js";
import { createRuntimeObservation } from "../../dist/runtime/runtimeObservation.js";
import { createProject } from "../../dist/repository/project.js";
import { startControllerServer } from "../../dist/core/controllerServer.js";
import { stopCodexNativeSession } from "../../dist/runtime/nativeSessionControl.js";

const at = new Date("2026-09-10T00:00:00Z");
const later = new Date("2026-09-10T00:01:00Z");

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-recovery-boundary-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], at);
  store.saveConfiguredAgent(agent);
  store.saveTask(activateTask(createTask("task-1", "Preserve intent", at, { cwd: home }), at));
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: "task-1" }, root: home, entries: []
  }, at));
  for (const name of ["leader", "worker"]) {
    const role = createRole("task-1", name, [createRoleAgentBinding(agent)], agent.id, home, at);
    store.saveRole("task-1", role);
    if (name !== "leader") continue;
    const set = recordRoleAgentSession(createRoleSessionSet(
      { scope: "task", taskId: "task-1", roleName: name }, agent.id, at
    ), {
      agentId: agent.id, adapterId: "codex", nativeSessionId: `${name}-old`,
      policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" })
    }, at);
    store.saveTaskRoleSessionSet(set);
  }
  const command = args => runTaskCommand(args, store, { now: () => later, environment: {} });
  const leader = {
    YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1", YUI_ROLE: "leader",
    YUI_NATIVE_SESSION_ID: "leader-old", YUI_WORKSPACE: home
  };
  return { store, home, agent, command, leader, scheduler: new FileSchedulerStoreAdapter(store) };
}

test("Session replacement preserves durable intent and releases only its own engineering attempt", t => {
  const { store, home, command, leader, scheduler } = fixture(t);
  command(["work", "create", "task-1", "Independent work", "--role", "worker"]);
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "work-item", taskId: "task-1", workItemId: "work-item-1" },
    root: join(home, "worker"), entries: []
  }, at));
  command(["work", "dispatch", "task-1/work-item-1"]);
  const unaffected = store.getActiveRun("task-1", "worker");
  command(["message", "send", "task-1", "Original user requirement must survive"]);
  const target = { kind: "role", taskId: "task-1", roleName: "leader" };
  const attemptId = "notification:old-claim";
  store.saveWorkMailbox(claimPending(store.getWorkMailbox(target), {
    batchId: attemptId, owner: "leader-notification:old-session", startedAt: later.toISOString()
  }));
  let binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex", conversationId: "leader-old",
    startedAt: at.toISOString()
  });
  binding = beginProviderTurn(binding, { attemptId, authorityEpoch: 1, submittedAt: later.toISOString() });
  store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(
    store.getTaskRoleSessionSet("task-1", "leader"), binding, later
  ));
  const args = ["role", "session", "new", "task-1", "leader", "--reason", "Context-preserving replacement"];
  runTaskCommand(args, store, { now: () => later, environment: leader });
  runTaskCommand(args, store, { now: () => later, environment: leader });
  assert.equal(store.listEvents("task-1").filter(e => e.type === "runtime.session-replacement-requested").length, 1);
  // Controller calls this boundary only after native/OS stop proof, never on a timer.
  assert.equal(scheduler.completeRuntimeCleanup({ kind: "role-runtime", taskId: "task-1", roleName: "leader" }, later), true);
  assert.equal(store.getTask("task-1").status, "active");
  assert.deepEqual(store.getActiveRun("task-1", "worker"), unaffected);
  assert.equal(store.getTaskRoleSessionSet("task-1", "leader").sessions.codex, undefined);
  assert.ok(store.getWorkMailbox(target).pending.refs.some(r => r.type === "message" && r.id === "message-1"));
  assert.equal(pendingCompletionMessages(store, "task-1")[0].body, "Original user requirement must survive");
  assert.equal(resolveManagedTaskReader(store, leader).nativeSessionId, "leader-old");
  assert.throws(() => resolveManagedTaskCaller(store, leader), /current|runtime|Session/i);
  assert.ok(readTaskContext(store, "task-1", leader).records.some(r => r.ref.store === "task-message"));
  assert.throws(() => command(["complete", "task-1", "--summary", "Premature"]), /pending-user-input/);

  const wake = createTaskWake({
    id: "wake-1", taskId: "task-1", reasons: ["session-replaced"],
    refs: [{ type: "message", taskId: "task-1", id: "message-1" }],
    fromCursor: later.toISOString(), toCursor: later.toISOString(), now: later
  });
  store.saveTaskWake("task-1", wake);
  const shown = command(["wake", "show", "task-1", wake.id]);
  assert.match(JSON.stringify(shown), /Original user requirement must survive/);
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "worker" }, "codex", later
  ), {
    agentId: "codex", adapterId: "codex", nativeSessionId: "worker-current",
    policy: "fixed", status: "active", effective: unaffected.effective
  }, later));
  command(["work", "create", "task-1", "Leader coordination", "--role", "leader"]);
  command(["work", "dispatch", "task-1/work-item-2"]);
  command(["message", "send", "task-1", "Leader-only coordination", "--to", "leader", "--work-item", "work-item-2"]);
  const workerContext = readTaskContext(store, "task-1", {
    YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1", YUI_ROLE: "worker",
    YUI_NATIVE_SESSION_ID: "worker-current", YUI_WORKSPACE: unaffected.effective.workspace.root
  });
  assert.ok(workerContext.records.some(r => r.ref.store === "task-message"
    && r.value?.body === "Original user requirement must survive"),
  "The original shared user amendment is readable even though it arrived after the frozen Assignment.");
  assert.ok(!workerContext.records.some(r => r.value?.body === "Leader-only coordination"));
});

test("Runless questions survive replacement and a successor can manage the original question", t => {
  const { store, command, leader, scheduler } = fixture(t);
  runTaskInputCommand(["request", "task-1", "--question", "Confirm durable intent", "--choice", "yes=Proceed"], store, {
    now: () => at, environment: leader
  });
  assert.equal(store.listRuns("task-1").length, 0);
  const question = store.getInputRequest("task-1", "input-1");
  assert.equal(question.requester.runId, undefined);
  command(["role", "session", "new", "task-1", "leader", "--reason", "Replace while waiting"]);
  scheduler.completeRuntimeCleanup({ kind: "role-runtime", taskId: "task-1", roleName: "leader" }, later);
  assert.deepEqual(store.getInputRequest("task-1", "input-1"), question);
  const role = store.getRole("task-1", "leader");
  store.saveTaskRoleSessionSet(recordRoleAgentSession(store.getTaskRoleSessionSet("task-1", "leader"), {
    agentId: "codex", adapterId: "codex", nativeSessionId: "leader-new", policy: "fixed",
    status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" })
  }, later));
  runTaskInputCommand(["cancel", "task-1", "input-1", "--reason", "Superseded user request"], store, {
    now: () => later, environment: { ...leader, YUI_NATIVE_SESSION_ID: "leader-new" }
  });
  assert.equal(store.getInputRequest("task-1", "input-1").status, "cancelled");
  assert.equal(store.getInputRequest("task-1", "input-1").requester.nativeSessionId, "leader-old");
});

test("Leader queue waits through Session cleanup and only its accepted wake consumes input", t => {
  const { store, command, scheduler } = fixture(t);
  const target = { kind: "role", taskId: "task-1", roleName: "leader" };
  assert.throws(() => command(["message", "queue", "task-1", "Original input",
    "--request-id", "original", "--to", "leader"]), /requires --work-item or --review-round/);
  command(["message", "queue", "task-1", "Original input", "--request-id", "original"]);
  const message = store.listMessages("task-1")[0];
  command(["role", "session", "new", "task-1", "leader", "--reason", "Replace idle Session"]);
  const pending = store.getWorkMailbox(target);
  assert.equal(scheduler.claimLeaderNotification("task-1", later), null,
    "Do not dispatch queued input to a Session whose cleanup is already requested.");
  assert.deepEqual(store.getWorkMailbox(target), pending);
  assert.equal(store.listTaskWakes("task-1").length, 0);

  scheduler.completeRuntimeCleanup({ kind: "role-runtime", taskId: "task-1", roleName: "leader" }, later);
  const first = scheduler.claimLeaderNotification("task-1", later);
  assert.equal(first.disposition, "submit");
  assert.ok(store.getTaskWake("task-1", first.wakeId).refs.some(ref => ref.id === message.id));
  scheduler.settleLeaderNotification("task-1", first.attemptId, "unknown", later);
  command(["role", "session", "new", "task-1", "leader", "--reason", "Discard unconfirmed attempt"]);
  scheduler.completeRuntimeCleanup({ kind: "role-runtime", taskId: "task-1", roleName: "leader" }, later);
  const successor = scheduler.claimLeaderNotification("task-1", later);
  assert.notEqual(successor.wakeId, first.wakeId);
  assert.ok(store.getTaskWake("task-1", successor.wakeId).refs.some(ref => ref.id === message.id));
  assert.equal(pendingCompletionMessages(store, "task-1")[0].id, message.id);
  scheduler.settleLeaderNotification("task-1", first.attemptId, "accepted", later);
  assert.equal(store.getWorkMailbox(target).processing.batchId, successor.attemptId,
    "A late receipt from the discarded attempt cannot settle its successor.");
  assert.equal(store.getTaskWake("task-1", first.wakeId).status, "dispatched");
  command(["message", "queue", "task-1", "Later input", "--request-id", "later"]);
  scheduler.settleLeaderNotification("task-1", successor.attemptId, "accepted", later);
  assert.equal(store.getTaskWake("task-1", successor.wakeId).status, "consumed");
  assert.equal(store.getTaskWake("task-1", first.wakeId).status, "dispatched",
    "Successor acceptance must not fabricate acceptance of the discarded wake.");
  assert.deepEqual(pendingCompletionMessages(store, "task-1").map(m => m.body), ["Later input"]);
  assert.equal(store.listRuns("task-1").length, 0, "Notification acceptance is not execution completion.");
});

test("late native terminals cannot settle successor input or fabricate acceptance", () => {
  let binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex", conversationId: "thread",
    startedAt: at.toISOString()
  });
  binding = beginProviderTurn(binding, { attemptId: "unknown-old", authorityEpoch: 1, submittedAt: at.toISOString() });
  binding = cancelQuiescentProviderInput(binding, { attemptId: "unknown-old", cancelledAt: later.toISOString(), reason: "Exact execution stopped" });
  assert.equal(binding.run.status, "cancelled");
  assert.equal(binding.run.nativeTurnId, undefined);
  binding = beginProviderTurn(binding, { attemptId: "successor", authorityEpoch: 1, submittedAt: later.toISOString() });
  binding = acceptProviderTurn(binding, { attemptId: "successor", nativeTurnId: "native-new", acceptedAt: later.toISOString() });
  assert.throws(() => settleProviderTurn(binding, {
    attemptId: "unknown-old", nativeTurnId: "native-old", status: "completed", settledAt: later.toISOString()
  }), /match/);
  assert.equal(binding.run.status, "accepted");
  assert.equal(binding.run.nativeTurnId, "native-new");
  const fence = { taskId: "task-1", roleName: "leader", agentId: "codex",
    driverId: "openai/codex", nativeSessionId: "thread", receiptId: "successor", nativeTurnId: "native-new" };
  let projection = createRuntimeProjection(fence, at.toISOString());
  for (const [index, kind] of ["turn.accepted", "turn.completed"].entries()) {
    projection = projectRuntimeObservation(projection, createRuntimeObservation({
      schemaVersion: 4, eventId: `event-${index}`, semanticKey: `event-${index}`,
      kind, authority: "provider-structured", receivedAt: later.toISOString(),
      sequence: index + 1, ordinal: 0, fence, payload: {}
    }));
  }
  assert.equal(runtimeDisplayStatus(projection), "ready");
  assert.equal(classifyRuntimeHealth({
    projection, semanticProgressAt: at.toISOString(), now: new Date("2026-09-10T01:00:00Z")
  }).layer, "ready", "Elapsed time must not turn a completed native input into active/quiet work.");
});

test("remote Operator startup applies its own workspace, Role instructions and scoped CLI identity", () => {
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], at);
  const compiled = resolveAgentAdapter("codex").compileNew({
    agent, workspace: "/private/operator", sessionManifestPath: "/private/manifest.json", sessionManifestDigest: "digest",
    config: { adapterId: "codex", model: "selected-model", effort: "medium", permission: { strategy: "bypass" } }
  });
  const params = codexInteractiveStartupParameters({
    cwd: "/private/operator", interactiveCodexThread: compiled.codexThread,
    environment: { YUI_HOME: "/private/home", YUI_ROLE: "operator", YUI_SESSION_SCOPE: "global", ANTHROPIC_API_KEY: "not-thread-context" }
  }, { threadId: "original-resume-id", cwd: "/daemon", config: { unrelated: true, shell_environment_policy: { set: { KEEP: "yes" } } } });
  assert.equal(params.threadId, "original-resume-id");
  assert.equal(params.cwd, "/private/operator");
  assert.equal(params.model, "selected-model");
  assert.equal(params.approvalPolicy, "never");
  assert.match(params.developerInstructions, /\/private\/manifest.json/);
  assert.deepEqual(params.config.shell_environment_policy.set, {
    KEEP: "yes", YUI_HOME: "/private/home", YUI_ROLE: "operator", YUI_SESSION_SCOPE: "global"
  });
  assert.equal(params.config.unrelated, true);
  for (const args of [
    ["controller", "restart"], ["task", "context", "task-1"],
    ["task", "role", "session", "inspect", "task-1", "leader"]
  ]) assert.equal(operatorOfflineCommand(args), true);
  assert.equal(taskDiagnosticTarget(["task", "role", "session", "new", "task-1", "leader"]), undefined);
  assert.equal(operatorOfflineCommand(["task", "complete", "task-1"]), false);
});

test("durably queued native results survive a Controller outage without failing the Host", async t => {
  const { store, home, leader } = fixture(t);
  const binding = acceptProviderTurn(beginProviderTurn(createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex", conversationId: "leader-old",
    startedAt: at.toISOString()
  }), {
    attemptId: "notification:offline-terminal", authorityEpoch: 1, submittedAt: at.toISOString()
  }), { attemptId: "notification:offline-terminal", nativeTurnId: "native-terminal", acceptedAt: at.toISOString() });
  store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(
    store.getTaskRoleSessionSet("task-1", "leader"), binding, at
  ));
  await publishStructuredProviderTerminal({
    home,
    environment: { ...leader, YUI_HOME: home, YUI_AGENT_ID: "codex", YUI_ADAPTER_ID: "codex" },
    terminal: {
      conversationId: "leader-old", nativeSessionId: "leader-old",
      attemptId: "notification:offline-terminal", nativeTurnId: "native-terminal",
      clientOwned: true, status: "completed", output: "Original provider result",
      observedAt: later.toISOString()
    }
  });
  const entries = new FileRuntimeEventInbox(home).list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].observation.kind, "turn.completed");
  assert.equal(entries[0].observation.payload.output, "Original provider result");
  assert.equal(entries[0].observation.fence.receiptId, "notification:offline-terminal");
  // The same durable boundary must also return promptly when a reachable
  // Controller accepts a connection but never acknowledges this observation.
  let received = false;
  const controller = await startControllerServer(home, method => {
    if (method === "runtime.host-observation-apply") {
      received = true;
      return new Promise(() => {});
    }
    return {};
  }, undefined, { release: null, storageBackend: "sqlite", workerEnabled: false });
  const began = performance.now();
  try {
    await publishStructuredProviderTerminal({
      home, environment: { ...leader, YUI_HOME: home, YUI_AGENT_ID: "codex", YUI_ADAPTER_ID: "codex" },
      terminal: {
        conversationId: "leader-old", nativeSessionId: "leader-old",
        attemptId: "notification:offline-terminal", nativeTurnId: "native-terminal",
        clientOwned: true, status: "completed", output: "Original provider result",
        observedAt: later.toISOString()
      }
    });
    assert.equal(received, true);
    assert.ok(performance.now() - began < 1500, "Already durable observations must not block Host control on RPC.");
  } finally { await controller.close(); }
});

test("Task-final review uses the Task-local Reviewer without requiring a global template", t => {
  const { store, home, agent } = fixture(t);
  const commit = "1".repeat(40);
  store.saveProject(createProject("project-1", "lab", join(home, "reference"),
    { stable: "main", development: "main" }, at));
  store.saveTask({ ...store.getTask("task-1"), projectBindings: [{
    projectId: "project-1", directory: "lab", baseRef: "main", baseCommit: commit, currentCommit: commit
  }] });
  const reviewer = createRole("task-1", "reviewer", [createRoleAgentBinding(agent)], "codex", home, at);
  store.saveRole("task-1", reviewer);
  runTaskCommand(["review", "request", "task-1", "--role", "reviewer"], store, {
    now: () => later, environment: {},
    actualTaskReviewCandidate: { schemaVersion: 1, projects: [{ projectId: "project-1", commit }] }
  });
  assert.equal(store.getGlobalRole("reviewer"), null);
  assert.deepEqual(store.getRole("task-1", "reviewer"), reviewer);
  const round = store.listReviewRounds("task-1")[0];
  assert.equal(round.reviewerRoleName, "reviewer");
  assert.equal(round.status, "pending");
  assert.equal(round.scope, "task");
});

test("native systemError with a proven terminal Turn is replaceable without starting model work", async () => {
  const calls = [];
  let closed = false;
  const launch = { command: "codex", args: ["app-server", "proxy"],
    environment: {}, cwd: "/private", expectedAccountHome: "/private/account" };
  const channel = {
    request: async (method, params) => {
      calls.push({ method, params });
      switch (method) {
        case "initialize": return { codexHome: "/private/account" };
        case "thread/read": return { thread: { id: "errored", status: { type: "systemError" }, turns: [] } };
        case "thread/goal/get": return { goal: null };
        case "thread/turns/list": return { data: [{ id: "failed-native", status: "failed", items: [] }], nextCursor: null };
        case "thread/backgroundTerminals/clean": return {};
        case "thread/backgroundTerminals/list": return { data: [], nextCursor: null };
        default: throw new Error(`Unexpected model/control operation: ${method}`);
      }
    },
    notify: async () => {},
    close: () => { closed = true; }
  };
  await stopCodexNativeSession(launch, { conversationId: "errored", clearGoal: true }, async () => channel);
  assert.equal(closed, true);
  assert.ok(calls.some(c => c.method === "thread/backgroundTerminals/clean"));
  assert.ok(calls.filter(c => c.method === "thread/read").every(c => c.params.includeTurns === false));
  assert.ok(calls.filter(c => c.method === "thread/turns/list")
    .every(c => c.params.limit === 1 && c.params.itemsView === "notLoaded"));
  calls.length = 0;
  await assert.rejects(stopCodexNativeSession({ ...launch, expectedAccountHome: "/another/account" },
    { conversationId: "errored", clearGoal: true }, async () => channel), /different account/);
  assert.deepEqual(calls.map(c => c.method), ["initialize"]);
  calls.length = 0;
  await assert.rejects(stopCodexNativeSession(launch, { conversationId: "errored", clearGoal: true }, async () => ({
    ...channel,
    request: async (method, params) => method === "thread/turns/list"
      ? { data: [{ id: "still-running", status: "inProgress" }] } : channel.request(method, params)
  })), /no proven terminal/);
  assert.ok(!calls.some(c => c.method === "thread/backgroundTerminals/clean"));
});
