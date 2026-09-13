import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createRun } from "../../dist/agentRun/agentRun.js";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { createRole, createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { activateTask, createTask, stopTaskExecution } from "../../dist/task/task.js";
import { createTaskMessage, createGlobalRoleMessage } from "../../dist/message/message.js";
import { createTaskWake } from "../../dist/scheduler/taskWake.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import {
  createRoleSessionSet, recordRoleAgentSession, bindTaskRoleProviderRuntime,
  bindGlobalRoleProviderRuntime
} from "../../dist/executor/agentExecutor.js";
import {
  createProviderRuntimeBinding, transferProviderAuthority
} from "../../dist/runtime/providerRuntimeIdentity.js";
import { createRuntimeObservation } from "../../dist/runtime/runtimeObservation.js";
import { standardAgentError } from "../../dist/runtime/agentError.js";
import { mapCodexAgentError } from "../../dist/runtime/builtinAgentErrorMappers.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { createProviderRetryHooks } from "../../dist/controller/providerRetryDelivery.js";
import { createRuntimeLifecycleDispatcher } from "../../dist/controller/runtime.js";
import { deliverGlobalInputs } from "../../dist/controller/globalInputDelivery.js";
import { providerRetryAttemptId } from "../../dist/runtime/providerRetry.js";
import { runTaskCommand, dispatchPreparedReviewRound } from "../../dist/commands/taskCommands.js";
import { readTaskContext } from "../../dist/context/taskContext.js";
import { buildWebTaskDetail } from "../../dist/web/webSnapshot.js";
import { runGlobalRoleCommand } from "../../dist/commands/globalRoleCommands.js";
import { createProject } from "../../dist/repository/project.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createTaskReviewRound, attachReviewRoundWorkspace } from "../../dist/review/reviewRound.js";

const epoch = Date.parse("2026-09-13T00:00:00Z");
const rawFailure = JSON.stringify({
  message: "Too many requests",
  codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } }
});
const transient = standardAgentError({
  source: "provider", phase: "turn-execute", message: "Too many requests",
  raw: rawFailure, inputDisposition: "accepted",
  classification: mapCodexAgentError({ message: "Too many requests", raw: rawFailure })
});

function fixture(t, scope = "task", roleName = scope === "task" ? "leader" : "assistant") {
  const home = mkdtempSync(join(tmpdir(), "yui-retry-controller-"));
  let store = new SqliteTaskStore(home);
  let at = epoch;
  let sequence = 0;
  const now = () => new Date(at);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now());
  store.saveConfiguredAgent(agent);
  const scoped = { roleName, ...(scope === "task" ? { taskId: "task-1" } : {}) };
  const owner = { scope, ...scoped };
  const role = scope === "task"
    ? createRole("task-1", roleName, [createRoleAgentBinding(agent)], agent.id, home, now())
    : createGlobalRole(roleName, [createRoleAgentBinding(agent)], agent.id, home, now());
  if (scope === "task") {
    store.saveTask(activateTask(createTask("task-1", "Preserve original work", now(), { cwd: home }), now()));
    store.saveRole("task-1", role);
  } else store.saveGlobalRole(role);
  const nativeSessionId = `${scope}-same-session`;
  let sessions = recordRoleAgentSession(createRoleSessionSet(owner, agent.id, now()), {
    agentId: agent.id, adapterId: "codex", nativeSessionId,
    policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" })
  }, now());
  const binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: agent.id,
    conversationId: nativeSessionId, startedAt: now().toISOString()
  });
  sessions = scope === "task"
    ? bindTaskRoleProviderRuntime(sessions, binding, now())
    : bindGlobalRoleProviderRuntime(sessions, binding, now());
  const saveSessions = value => scope === "task"
    ? store.saveTaskRoleSessionSet(value) : store.saveGlobalRoleSessionSet(value);
  const loadSessions = () => scope === "task"
    ? store.getTaskRoleSessionSet("task-1", roleName) : store.getGlobalRoleSessionSet(roleName);
  saveSessions(sessions);
  const body = "Keep the original edits; finish the authorized unfinished work.";
  let originalAttempt;
  if (scope === "task") {
    store.saveMessage("task-1", createTaskMessage("message-1", "task-1", body,
      "user", { type: "user" }, now()));
    store.saveTaskWake("task-1", createTaskWake({
      id: "wake-1", taskId: "task-1", reasons: ["user-message"],
      refs: [{ type: "message", taskId: "task-1", id: "message-1" }],
      fromCursor: now().toISOString(), toCursor: now().toISOString(), now: now()
    }));
    originalAttempt = "notification:task-1/wake-1/initial";
  } else {
    const message = createGlobalRoleMessage("global-message-1", roleName, body,
      "user", { type: "user" }, now(), {
        inputControl: { action: "queue", requestId: "original-input" }
      });
    store.saveGlobalRoleMessage({
      ...message, deliveryTarget: { agentId: agent.id, nativeSessionId }
    });
    originalAttempt = `global-input:${roleName}/${message.id}`;
  }
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const adapter = () => new FileSchedulerStoreAdapter(store);
  const read = () => loadSessions().providerBinding;
  const begin = (attemptId = originalAttempt, boundedText = body, runId) =>
    adapter().beginAgentHostProviderTurn({
      ...scoped, agentId: agent.id, nativeSessionId, attemptId, boundedText,
      ...(runId === undefined ? {} : { runId }),
      authorityEpoch: read().authority.epoch, authorityOwner: read().authority.owner,
      holderId: read().authority.holderId, retrySupported: true, now: now()
    });
  const observe = (kind, attemptId = read().run.attemptId, nativeTurnId = "native-original",
    payload = {}, runId = read().run?.runId) => {
    const eventId = `observation-${++sequence}`;
    return adapter().observeRuntimeObservation(createRuntimeObservation({
      schemaVersion: 4, eventId, semanticKey: eventId,
      kind, authority: "provider-structured",
      observedAt: now().toISOString(), receivedAt: now().toISOString(), payload,
      fence: { ...scoped, agentId: agent.id, driverId: "openai/codex",
        ...(runId === undefined ? {} : { runId }),
        nativeSessionId, conversationId: nativeSessionId, receiptId: attemptId, nativeTurnId }
    }), now());
  };
  const resolve = (status, attemptId = read().run.attemptId) =>
    adapter().resolveAgentHostProviderTurnSubmission({
      ...scoped, attemptId, status, reason: "Too many requests", raw: rawFailure, now: now()
    });
  const fail = () => {
    begin();
    assert.equal(observe("turn.accepted"), "applied");
    at += 1;
    assert.equal(observe("turn.failed", originalAttempt, "native-original", { failure: { error: transient } }), "applied");
    assert.equal(read().retry.status, "waiting");
  };
  const submissions = [];
  const hooks = (outcome = "accepted") => createProviderRetryHooks(home, store, {
    now, monotonicNow: () => at - epoch,
    onError: error => { throw error; },
    inspect: async () => ({
      nativeSessionId, attemptId: read().run.attemptId, state: "delivery-unknown"
    }),
    submit: async request => {
      const { attemptId, boundedText } = request.control.run;
      begin(attemptId, boundedText);
      submissions.push(request);
      if (outcome === "unknown") {
        resolve("delivery-unknown", attemptId);
        return { outcome: "rejected", snapshot: { state: "delivery-unknown" },
          failure: { inputDisposition: "unknown", registrationDisposition: "committed" } };
      }
      if (outcome === "rejected") {
        resolve("rejected", attemptId);
        return { outcome: "rejected", snapshot: { state: "rejected" },
          failure: { inputDisposition: "not-accepted", registrationDisposition: "committed" } };
      }
      assert.equal(observe("turn.accepted", attemptId, "native-retry"), "applied");
      return { outcome: "delivered", snapshot: { state: "ready" } };
    }
  });
  return {
    home, scoped, roleName, nativeSessionId, originalAttempt, body, now, read,
    begin, observe, resolve, fail, hooks, submissions, loadSessions, saveSessions,
    get store() { return store; },
    due() { at = Date.parse(read().retry.nextEligibleAt); },
    advanceTo(value) { at = value; },
    reopen() { store.close(); store = new SqliteTaskStore(home); }
  };
}

function reviewFixture(t) {
  const f = fixture(t, "task", "reviewer");
  const commit = "a".repeat(40);
  const candidate = { schemaVersion: 1, projects: [{ projectId: "project-1", commit }] };
  f.store.saveProject(createProject("project-1", "lab", join(f.home, "reference"),
    { stable: "main", development: "main" }, f.now()));
  f.store.saveTask({
    ...f.store.getTask("task-1"), projectBindings: [{
      projectId: "project-1", directory: "lab", baseRef: "main",
      baseCommit: commit, currentCommit: commit
    }]
  });
  const root = join(f.home, "review");
  const workspace = createManagedWorkspace({
    owner: { type: "review-round", taskId: "task-1", reviewRoundId: "review-round-1" },
    root, entries: [{
      projectId: "project-1", directory: "lab", access: "write", path: join(root, "lab"),
      branch: "review-only", baseRef: commit, baseCommit: commit
    }]
  }, f.now());
  f.store.saveManagedWorkspace(workspace);
  const round = attachReviewRoundWorkspace(createTaskReviewRound("review-round-1",
    "task-1", f.roleName, "user", candidate, f.now()), workspace);
  f.store.saveReviewRound("task-1", round);
  // Seed the initial native Session at this exact frozen review workspace.
  const sessions = recordRoleAgentSession(createRoleSessionSet({
    scope: "task", taskId: "task-1", roleName: f.roleName
  }, "codex", f.now()), {
    agentId: "codex", adapterId: "codex", nativeSessionId: f.nativeSessionId,
    policy: "fixed", status: "active", effective: resolveEffectiveLaunch({
      role: f.store.getRole("task-1", f.roleName), purpose: "review", workspace,
      reviewRoundId: round.id, reviewBaseCommit: commit
    })
  }, f.now());
  f.saveSessions(bindTaskRoleProviderRuntime(sessions, f.read(), f.now()));
  const dispatch = () => dispatchPreparedReviewRound("task-1", round.id, f.store, {
    now: f.now, environment: {}, actualTaskReviewCandidate: candidate
  });
  return { ...f, candidate, workspace, round, dispatch };
}

test("Task no-Run retry preserves its wake and original Message, and duplicate passes admit one successor", async t => {
  const f = fixture(t);
  f.fail();
  assert.deepEqual(f.read().retry.input, { kind: "wake", taskId: "task-1", wakeId: "wake-1" });
  const chain = f.read().retry.chainId;
  const cli = runTaskCommand(["role", "session", "retry", "task-1", f.roleName], f.store,
    { now: f.now, environment: {} }).data.retry;
  const context = readTaskContext(f.store, "task-1", {}).records.find(r => r.ref.store === "role").providerRetry;
  const web = buildWebTaskDetail(f.store, "task-1", f.now()).roles.find(r => r.name === f.roleName).providerRetry;
  assert.deepEqual(cli, context);
  assert.deepEqual(cli, web);
  const hooks = f.hooks();
  assert.equal(hooks.deadlines().length, 1);
  await hooks.reconcile();
  assert.equal(f.submissions.length, 0, "backoff must not start native work");
  f.due();
  await Promise.all([hooks.reconcile(), f.hooks().reconcile()]);
  await hooks.reconcile();
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].control.nativeSessionId, f.nativeSessionId);
  assert.equal(f.read().retry.chainId, chain);
  assert.equal(f.read().retry.attempts, 1);
  assert.equal(f.read().retry.status, "in-flight");
  assert.equal(f.store.listRuns("task-1").length, 0);
  assert.equal(f.store.listMessages("task-1")[0].body, f.body);
  assert.equal(f.store.listTaskWakes("task-1").length, 1);
  assert.match(f.submissions[0].control.run.boundedText, /task=task-1 wake=wake-1/);
  assert.throws(() => f.observe("turn.completed", f.originalAttempt, "native-original",
    { output: "Late original result" }), /Conflicting terminal/);
  assert.equal(f.read().retry.status, "in-flight", "Old terminal cannot recover the successor.");
  assert.equal(f.read().retry.attempts, 1);
  assert.equal(f.observe("turn.completed", f.read().run.attemptId, "native-retry", { output: "Finished" }), "applied");
  assert.equal(f.read().retry.status, "recovered");
  assert.equal(hooks.deadlines().length, 0);
});

test("Global original Message survives rejected delivery and same-Session retry without fake Task or Run", async t => {
  const f = fixture(t, "global");
  f.begin();
  f.resolve("rejected");
  assert.equal(f.read().retry.status, "waiting");
  assert.equal(f.read().retry.error.inputDisposition, "not-accepted");
  assert.deepEqual(f.read().retry.input, {
    kind: "message", roleName: "assistant", messageId: "global-message-1"
  });
  assert.equal(f.store.listGlobalRoleMessages(f.roleName)[0].notDelivered, undefined);
  f.due();
  await f.hooks().reconcile();
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].control.nativeSessionId, f.nativeSessionId);
  assert.match(f.submissions[0].control.run.boundedText, /role=assistant message=global-message-1/);
  assert.equal(f.store.listTasks().length, 0);
  assert.equal(f.read().run.runId, undefined);
  const messages = f.store.listGlobalRoleMessages(f.roleName);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, f.body);
  assert.equal(messages[0].delivery?.via, "provider",
    "The successful recovery receipt must settle the same original Global Message.");
  assert.equal(messages[0].control.outcome, "accepted");
});

test("unknown admitted retry remains fenced after SQLite reopen and fresh Controller hooks", async t => {
  const f = fixture(t);
  f.fail();
  f.due();
  await f.hooks("unknown").reconcile();
  assert.equal(f.read().run.status, "delivery-unknown");
  const attemptId = f.read().run.attemptId;
  const deadline = Date.parse(f.read().retry.deadline);
  f.reopen();
  f.advanceTo(deadline + 1);
  const hooks = f.hooks();
  await hooks.reconcile();
  await hooks.reconcile();
  assert.equal(f.submissions.length, 1);
  assert.equal(f.read().run.attemptId, attemptId);
  assert.equal(f.read().retry.status, "in-flight");
  assert.equal(f.read().retry.attempts, 1);
  assert.equal(hooks.deadlines().length, 0);
  assert.throws(() => f.begin("explicit-successor"), /unsettled/i);
  assert.equal(f.observe("turn.accepted", attemptId, "confirmed-retry"), "applied");
  assert.equal(f.observe("turn.completed", attemptId, "confirmed-retry", { output: "Confirmed" }), "applied");
  assert.equal(f.read().retry.status, "recovered");
});

test("cancel, authority revocation and deadline stop waiting recovery without discarding original work", async t => {
  for (const action of ["cancel", "authority", "deadline", "execution-stop"]) {
    const f = fixture(t);
    f.fail();
    if (action === "cancel") {
      runTaskCommand(["role", "session", "retry", "task-1", f.roleName, "cancel"],
        f.store, { now: f.now, environment: {} });
    } else if (action === "authority") {
      f.saveSessions({
        ...f.loadSessions(), providerBinding: transferProviderAuthority(f.read(), {
          expectedEpoch: 1, expectedOwner: "controller", owner: "human",
          holderId: "authorized-human", changedAt: f.now().toISOString()
        })
      });
    } else if (action === "execution-stop") {
      f.store.saveTask(stopTaskExecution(f.store.getTask("task-1"), f.now()));
    }
    f.advanceTo(action === "deadline" ? Date.parse(f.read().retry.deadline) : Date.parse(f.read().retry.nextEligibleAt));
    await f.hooks().reconcile();
    assert.equal(f.submissions.length, 0, action);
    assert.equal(f.read().retry.status, action === "deadline" ? "exhausted" : "cancelled", action);
    assert.equal(f.store.listMessages("task-1")[0].body, f.body);
    assert.equal(f.store.listRuns("task-1").length, 0);
  }
});

test("an explicit no-Run input supersedes waiting automatic recovery at the same admission boundary", async t => {
  const f = fixture(t);
  f.fail();
  f.due();
  f.begin("explicit-successor", "New explicit authorized input.");
  assert.equal(f.read().retry.status, "cancelled");
  assert.equal(f.read().retry.reason, "superseded-by-explicit-input");
  assert.equal(f.read().retry.attempts, 0);
  assert.equal(f.read().run.attemptId, "explicit-successor");
  await f.hooks().reconcile();
  assert.equal(f.submissions.length, 0);
  assert.equal(f.store.listRuns("task-1").length, 0);
});

test("manual and automatic managed Run retries share one successor without charging manual work to the automatic limit", async t => {
  for (const manual of [false, true]) {
    const f = fixture(t);
    const previous = createRun(f.store.nextRunId("task-1"), "task-1", f.roleName, "resume",
      createRunInput({ source: { type: "yui", channel: "task-dispatch" },
        directive: f.body, deltaRefIds: [] }), f.now(), {
        effective: f.loadSessions().sessions.codex.effective
      });
    f.store.saveRun(previous);
    f.store.saveActiveRun(previous);
    f.begin(`task-1/turn/${previous.id}`, f.body, previous.id);
    assert.equal(f.observe("turn.accepted"), "applied");
    f.advanceTo(epoch + 1);
    assert.equal(f.observe("turn.failed", undefined, "native-original", { failure: { error: transient } }), "applied");
    assert.equal(f.store.getRun("task-1", previous.id).status, "failed");
    assert.equal(f.read().retry.previousRunId, previous.id);
    const chainId = f.read().retry.chainId;
    f.due();
    const retryCommand = () => runTaskCommand(["run", "retry", `task-1/${previous.id}`],
      f.store, { now: f.now, environment: {} });
    if (manual) retryCommand();
    await f.hooks().reconcile();
    retryCommand();
    await f.hooks().reconcile();
    const successor = f.store.getActiveRun("task-1", f.roleName);
    assert.ok(successor);
    assert.notEqual(successor.id, previous.id);
    assert.equal(f.store.listRuns("task-1").length, 2);
    assert.equal(f.store.listEvents("task-1").filter(event => event.type === "run.retried").length, 1);
    assert.equal(f.read().retry.successorRunId, successor.id);
    assert.equal(f.read().retry.successorAutomatic, !manual);
    f.begin(`task-1/turn/${successor.id}`, "Read the exact successor Run.", successor.id);
    assert.equal(f.read().retry.chainId, chainId);
    assert.equal(f.read().retry.attempts, manual ? 0 : 1);
    assert.deepEqual(f.read().run.input, { kind: "run", taskId: "task-1", runId: previous.id });
    assert.equal(f.read().run.runId, successor.id);
    assert.equal(f.loadSessions().sessions.codex.nativeSessionId, f.nativeSessionId);
    assert.equal(f.submissions.length, 0, "Run delivery remains in the ordinary dispatch path.");
  }
});

test("Global exhaustion and cancellation settle the original queue entry without replay or blocking later input", async t => {
  for (const action of ["exhausted", "cancel"]) {
    const f = fixture(t, "global");
    f.begin();
    f.resolve("rejected");
    if (action === "exhausted") {
      const hooks = f.hooks("rejected");
      for (let n = 0; n < 5; n++) { f.due(); await hooks.reconcile(); }
      assert.equal(f.submissions.length, 5);
      assert.equal(f.read().retry.status, "exhausted");
    } else {
      runGlobalRoleCommand(["session", "retry", f.roleName, "cancel"], f.store, { env: {} });
    }
    const original = f.store.listGlobalRoleMessages(f.roleName)[0];
    assert.ok(original.notDelivered, `${action} must settle the never-accepted original input.`);
    assert.equal(original.body, f.body);
    assert.throws(() => f.begin(), /settled|retry|cancel|exhaust/i);
    let prepares = 0;
    const beforeNative = new Error("Stop fixture before any Host or Provider transport.");
    const inspectQueue = () => deliverGlobalInputs(f.home, f.store, async () => {
      prepares++;
      throw beforeNative;
    }, error => { assert.equal(error, beforeNative); });
    await inspectQueue();
    assert.equal(prepares, 0, "A stopped retry cannot silently return to ordinary delivery.");
    f.advanceTo(f.now().getTime() + 1);
    f.store.saveGlobalRoleMessage(createGlobalRoleMessage("global-message-2", f.roleName,
      "New authorized input", "user", { type: "user" }, f.now(), {
        inputControl: { action: "queue", requestId: "new-input" }
      }));
    await inspectQueue();
    assert.equal(prepares, 1, "The stopped original must not strand newer Global Messages.");
  }
});

test("registration ACK replay and a cancellation racing its reply never strip the recovery descriptor", async t => {
  for (const race of ["ack-replay", "reply-read"]) {
    const f = fixture(t, "global");
    f.fail();
    f.due();
    const scheduler = new FileSchedulerStoreAdapter(f.store);
    const cancel = () => runGlobalRoleCommand(["session", "retry", f.roleName, "cancel"],
      f.store, { env: {} });
    if (race === "reply-read") {
      const begin = scheduler.beginAgentHostProviderTurn.bind(scheduler);
      scheduler.beginAgentHostProviderTurn = input => { begin(input); cancel(); };
    }
    const dispatch = createRuntimeLifecycleDispatcher(f.store, scheduler, {});
    const params = {
      scope: "global", roleName: f.roleName, agentId: "codex", nativeSessionId: f.nativeSessionId,
      attemptId: providerRetryAttemptId(f.read().retry), authorityEpoch: 1,
      authorityOwner: "controller", holderId: "controller",
      observedAt: f.now().toISOString(), boundedText: f.body, retrySupport: "codex-failed-turn-v1"
    };
    const original = await dispatch("runtime.provider-turn-begin", params);
    assert.equal(original.retryInput?.expectedFailedNativeTurnId, "native-original");
    assert.match(original.retryInput.text, /continue only unfinished work/);
    if (race === "reply-read") {
      assert.equal(f.read().retry.status, "cancelled");
      continue;
    }
    assert.deepEqual(await dispatch("runtime.provider-turn-begin", params), original);
    assert.equal(f.read().retry.attempts, 1);
    cancel();
    let replay;
    try {
      replay = await dispatch("runtime.provider-turn-begin", params);
    } catch (error) {
      assert.match(error.message, /cancel|retry/i, "A cancelled unsubmitted retry may be rejected.");
    }
    if (replay !== undefined) assert.deepEqual(replay.retryInput, original.retryInput,
      "An admitted retry may continue, but never as unguarded ordinary input.");
    assert.equal(f.read().run.status, "submitting");
    assert.equal(f.read().retry.attempts, 1);
  }
});

test("manual recovery after exhaustion retains the original automatic count and deadline until exact success", async t => {
  const f = fixture(t);
  let run = createRun(f.store.nextRunId("task-1"), "task-1", f.roleName, "resume",
    createRunInput({ source: { type: "yui", channel: "task-dispatch" },
      directive: f.body, deltaRefIds: [] }), f.now(), {
      effective: f.loadSessions().sessions.codex.effective
    });
  f.store.saveRun(run);
  f.store.saveActiveRun(run);
  const failCurrent = nativeTurnId => {
    f.begin(`task-1/turn/${run.id}`, f.body, run.id);
    assert.equal(f.observe("turn.accepted", undefined, nativeTurnId), "applied");
    f.advanceTo(f.now().getTime() + 1);
    assert.equal(f.observe("turn.failed", undefined, nativeTurnId, { failure: { error: transient } }), "applied");
  };
  failCurrent("initial-native");
  const { chainId, deadline } = f.read().retry;
  const hooks = f.hooks();
  for (let n = 1; n <= 5; n++) {
    f.due();
    await hooks.reconcile();
    run = f.store.getActiveRun("task-1", f.roleName);
    failCurrent(`automatic-native-${n}`);
  }
  assert.equal(f.read().retry.status, "exhausted");
  assert.equal(f.read().retry.attempts, 5);
  runTaskCommand(["run", "retry", `task-1/${run.id}`], f.store, { now: f.now, environment: {} });
  run = f.store.getActiveRun("task-1", f.roleName);
  failCurrent("manual-native");
  assert.equal(f.read().retry.chainId, chainId);
  assert.equal(f.read().retry.deadline, deadline);
  assert.equal(f.read().retry.attempts, 5, "A manual failure cannot replenish automatic attempts.");
  assert.equal(f.read().retry.status, "exhausted");
  await hooks.reconcile();
  assert.equal(f.store.getActiveRun("task-1", f.roleName), null);
  assert.equal(f.store.listRuns("task-1").length, 7);
});

test("same-Round review recovery preserves its candidate and workspace, and cancellation fences a later-created Run", async t => {
  for (const cancel of [false, true]) {
    const f = reviewFixture(t);
    const initial = f.dispatch();
    assert.ok(initial);
    f.begin(`task-1/turn/${initial.id}`, "Review the frozen candidate.", initial.id);
    assert.equal(f.observe("turn.accepted"), "applied");
    f.advanceTo(f.now().getTime() + 1);
    assert.equal(f.observe("turn.failed", undefined, "native-original", {
      failure: { error: transient }
    }), "applied");
    assert.equal(f.store.getReviewRound("task-1", f.round.id).status, "failed");
    f.due();
    const hooks = createProviderRetryHooks(f.home, f.store, {
      now: f.now, snapshotTaskCandidate: async () => f.candidate,
      onError: error => { throw error; },
      submit: async () => { assert.fail("Review uses its ordinary Run dispatch path."); }
    });
    await hooks.reconcile();
    const pending = f.store.getReviewRound("task-1", f.round.id);
    assert.equal(pending.requestedBy, "policy", "Automatic infrastructure retry does not invent a user request.");
    assert.equal(pending.status, "pending");
    assert.deepEqual(pending.taskCandidate, f.candidate);
    assert.deepEqual(pending.workspace, f.workspace);
    assert.equal(f.read().retry.successorRunId, undefined);
    assert.equal(f.read().retry.successorReviewRoundId, f.round.id);
    if (cancel) runTaskCommand(["role", "session", "retry", "task-1", f.roleName, "cancel"],
      f.store, { now: f.now, environment: {} });
    const successor = f.dispatch();
    assert.ok(successor);
    assert.notEqual(successor.id, initial.id);
    assert.equal(successor.reviewRoundId, initial.reviewRoundId);
    assert.deepEqual(successor.workspace, initial.workspace);
    assert.equal(f.store.listReviewRounds("task-1").length, 1);
    const admit = () => f.begin(`task-1/turn/${successor.id}`,
      "Continue only the unfinished frozen Review.", successor.id);
    if (cancel) {
      assert.throws(admit, /retry.*cancel|cancel.*retry/i,
        "Cancelling before the Review Run exists must still fence its eventual native admission.");
      assert.equal(f.read().run.attemptId, `task-1/turn/${initial.id}`);
    } else {
      admit();
      assert.equal(f.read().retry.status, "in-flight");
      assert.equal(f.read().retry.attempts, 1);
      assert.equal(f.read().retry.successorRunId, successor.id);
      assert.equal(f.loadSessions().sessions.codex.nativeSessionId, f.nativeSessionId);
    }
  }
});
