import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createRole, createRoleAgentBinding, createGlobalRole } from "../../dist/role/role.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import {
  bindTaskRoleProviderRuntime, createRoleSessionSet, recordRoleAgentSession,
  updateTaskRoleProviderRuntime
} from "../../dist/executor/agentExecutor.js";
import {
  acceptProviderTurn, beginProviderTurn, createProviderRuntimeBinding,
  markProviderTurnDeliveryUnknown, settleProviderTurn, transferProviderAuthority
} from "../../dist/runtime/providerRuntimeIdentity.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { prepareMessageContinuations } from "../../dist/message/messageContinuation.js";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createRun, failRun } from "../../dist/agentRun/agentRun.js";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createAgentEndpointFactory } from "../../dist/runtime/agentEndpoint.js";
import { FileSchedulerStoreAdapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { processLeaderWakeups } from "../../dist/scheduler/leaderWakeupProcessor.js";
import { createRuntimeObservation } from "../../dist/runtime/runtimeObservation.js";
import { taskMessageInputControlState } from "../../dist/message/message.js";
import { recordTaskInterruptResult } from "../../dist/message/taskInterrupt.js";
import { inspectTaskContext, listContextMessages } from "../../dist/context/taskContext.js";
import { createWebTaskSurface } from "../../dist/web/webTaskSurface.js";
import { createYuiWebServer } from "../../dist/web/webServer.js";
import { foldSteerLiveReceipt, foldInterruptLiveReceipt } from "../../dist/runtime/agentHost.js";

const at = new Date("2026-09-10T00:00:00Z");
const later = new Date("2026-09-10T00:01:00Z");
const evenLater = new Date("2026-09-10T00:02:00Z");

/**
 * A Task with an active Session per Role, so a control can be resolved against a
 * real capability plan and writer fence. Each Role's Agent plan (adapterId)
 * decides its steer/interrupt capability; the fixture lets a test choose it.
 */
function fixture(t, roles = { leader: "codex", worker: "codex" }) {
  const home = mkdtempSync(join(tmpdir(), "yui-input-control-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  store.saveTask(activateTask(createTask("task-1", "Unified input control", at, { cwd: home }), at));
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "task", taskId: "task-1" }, root: home, entries: []
  }, at));
  for (const [name, adapterId] of Object.entries(roles)) {
    const agent = createConfiguredAgent(adapterId, adapterId, adapterId, [], [], at);
    store.saveConfiguredAgent(agent);
    const role = createRole("task-1", name, [createRoleAgentBinding(agent)], agent.id, home, at);
    store.saveRole("task-1", role);
    // Only the Leader holds a Session up front. A Worker's active Session is
    // recorded after its Dispatch from the run's own effective, so its pinned
    // workspace matches the WorkItem and resume mode stays legal.
    if (name !== "leader") continue;
    const set = recordRoleAgentSession(createRoleSessionSet(
      { scope: "task", taskId: "task-1", roleName: name }, agent.id, at
    ), {
      agentId: agent.id, adapterId, nativeSessionId: `${name}-native`,
      policy: "fixed", status: "active", effective: resolveEffectiveLaunch({ role, purpose: "execution" })
    }, at);
    store.saveTaskRoleSessionSet(set);
  }
  const command = args => runTaskCommand(args, store, { now: () => later, environment: {} });
  return { store, home, command, roles };
}

/** Put the Role's Provider on an accepted (in-flight) native Turn the Controller owns. */
function withControllerTurn(store, roleName, { attemptId, nativeTurnId }) {
  let binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: `${roleName}-native`, startedAt: at.toISOString()
  });
  const owner = store.getActiveRun("task-1", roleName);
  binding = beginProviderTurn(binding, {
    ...(owner === null ? {} : { runId: owner.id }),
    attemptId, authorityEpoch: 1, submittedAt: at.toISOString()
  });
  binding = acceptProviderTurn(binding, { attemptId, nativeTurnId, acceptedAt: later.toISOString() });
  store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(
    store.getTaskRoleSessionSet("task-1", roleName), binding, later));
  return binding;
}

/** Same in-flight Turn, but a human takeover holds the writer fence. */
function withHumanHeldTurn(store, roleName, { attemptId, nativeTurnId }) {
  let binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: `${roleName}-native`, startedAt: at.toISOString()
  });
  binding = transferProviderAuthority(binding, {
    expectedEpoch: 1, expectedOwner: "controller", owner: "human",
    holderId: "human-1", changedAt: at.toISOString()
  });
  binding = beginProviderTurn(binding, { attemptId, authorityEpoch: 2, submittedAt: at.toISOString() });
  binding = acceptProviderTurn(binding, { attemptId, nativeTurnId, acceptedAt: later.toISOString() });
  store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(
    store.getTaskRoleSessionSet("task-1", roleName), binding, later));
}

function dispatchWorker(store, command, home, adapterId = "codex") {
  command(["work", "create", "task-1", "Bounded work", "--role", "worker"]);
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "work-item", taskId: "task-1", workItemId: "work-item-1" },
    root: join(home, "worker"), entries: []
  }, at));
  command(["work", "dispatch", "task-1/work-item-1"]);
  // Record the Worker's active Session from the run's own effective, so its
  // pinned workspace matches the dispatched WorkItem (a legal resume).
  const run = store.getActiveRun("task-1", "worker");
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "worker" }, run.effective.agentId, later
  ), {
    agentId: run.effective.agentId, adapterId, nativeSessionId: "worker-native",
    policy: "fixed", status: "active", effective: run.effective
  }, later));
}

/**
 * Put the Worker's Provider on an unconfirmed-delivery native Turn the Controller
 * owns. The attempt was submitted but never `accepted`: either it is still in
 * flight (`submitting`) or its acceptance was never proven (`delivery-unknown`).
 * This is the exact state decision-3 §3/§8 separates from a clean active Turn.
 */
function withUnconfirmedTurn(store, roleName, { attemptId, unknown = false }) {
  let binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: `${roleName}-native`, startedAt: at.toISOString()
  });
  binding = beginProviderTurn(binding, { attemptId, authorityEpoch: 1, submittedAt: at.toISOString() });
  if (unknown) {
    binding = markProviderTurnDeliveryUnknown(binding, {
      attemptId, observedAt: later.toISOString(), reason: "transport-dropped" });
  }
  store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(
    store.getTaskRoleSessionSet("task-1", roleName), binding, later));
  return binding;
}

/**
 * Make a dispatched Worker eligible for a real message continuation: its active
 * Session's native id is the one the owner Run was prepared on, so
 * prepareMessageContinuations resolves the same Session rather than bailing at a
 * blocker. Returns the owner Run so a test can terminalize it.
 */
function readyWorkerContinuation(store) {
  const run = store.getActiveRun("task-1", "worker");
  store.saveEvent("task-1", createTaskEvent(store.nextEventId("task-1"), "task-1",
    "run.session-prepared", { runId: run.id, roleName: "worker", nativeSessionId: "worker-native" }, later));
  return run;
}

/**
 * Drive the exact interrupted Run to a proven terminal and settle its native
 * Turn, the real precondition an interrupt-then handoff waits for (decision-3 §4).
 */
function terminalizeWorkerRun(store, run, reason, at2) {
  store.saveRun(failRun(run, reason, `worker ${reason}`, at2));
  store.clearActiveRun("task-1", "worker");
  const settled = settleProviderTurn(store.getTaskRoleSessionSet("task-1", "worker").providerBinding,
    { nativeTurnId: "t-1", status: reason === "cancelled" ? "cancelled" : "failed", settledAt: at2.toISOString() });
  store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(
    store.getTaskRoleSessionSet("task-1", "worker"), settled, at2));
}

// ── queue ────────────────────────────────────────────────────────────────────

test("queue persists an input and never returns a live Provider intent", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const result = command(["message", "queue", "task-1", "Continue when free",
    "--request-id", "q-1", "--to", "worker", "--work-item", "work-item-1"]);
  // A queue is a durable save, not a live edge: it is never an input-steer /
  // input-interrupt intent, so the busy Provider is never written now.
  assert.equal(result.kind, "output");
  assert.equal(result.data.delivery.state, "queued");
});

test("queue is idempotent by request id and rejects a conflicting reuse", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  command(["message", "queue", "task-1", "Same body",
    "--request-id", "q-1", "--to", "worker", "--work-item", "work-item-1"]);
  const replay = command(["message", "queue", "task-1", "Same body",
    "--request-id", "q-1", "--to", "worker", "--work-item", "work-item-1"]);
  assert.equal(replay.data.delivery.state, "idempotent-replay");
  assert.equal(store.listMessages("task-1").filter(m => m.inputControl?.requestId === "q-1").length, 1);
  assert.throws(() => command(["message", "queue", "task-1", "Different body",
    "--request-id", "q-1", "--to", "worker", "--work-item", "work-item-1"]), /different content/);
});

// ── steer ────────────────────────────────────────────────────────────────────

test("steer resolves the exact current native Turn on a capable plan", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const result = command(["message", "steer", "task-1", "Prefer approach B now",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "worker", "--work-item", "work-item-1"]);
  assert.equal(result.kind, "input-steer");
  assert.equal(result.target.nativeTurnId, "t-1");
  assert.equal(result.target.attemptId, "a-1");
  assert.equal(result.receiptId, `steer:task-1/${result.messageId}`);
  // The Message is persisted before the live edge, so it survives a failed call.
  assert.ok(store.listMessages("task-1").some(m => m.id === result.messageId
    && m.inputControl?.action === "steer"));
});

test("steer on a plan without native steering is saved and reported, never downgraded", t => {
  const { store, home, command } = fixture(t, { leader: "codex", worker: "claude" });
  dispatchWorker(store, command, home, "claude");
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const result = command(["message", "steer", "task-1", "Prefer approach B now",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "worker", "--work-item", "work-item-1"]);
  assert.equal(result.kind, "output");
  assert.equal(result.data.steer.state, "not-steered");
  assert.equal(result.data.steer.code, "STEER_UNSUPPORTED");
  // Saved, not lost, and not silently turned into an interrupt or a queue.
  assert.ok(store.listMessages("task-1").some(m => m.id === result.data.message.id
    && m.inputControl?.action === "steer"));
});

test("steer with no in-flight Turn is NO_ACTIVE_TURN, not a fabricated Turn", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  // No provider binding / no accepted Turn on worker.
  const result = command(["message", "steer", "task-1", "Redirect",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "worker", "--work-item", "work-item-1"]);
  assert.equal(result.data.steer.code, "NO_ACTIVE_TURN");
});

test("steer against a stale target is TARGET_CHANGED, never retargeted", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const result = command(["message", "steer", "task-1", "Redirect",
    "--request-id", "s-1", "--expected-target", "t-OLD", "--to", "worker", "--work-item", "work-item-1"]);
  assert.equal(result.data.steer.code, "TARGET_CHANGED");
});

test("steer across a human writer fence is TARGET_CHANGED", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withHumanHeldTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const result = command(["message", "steer", "task-1", "Redirect",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "worker", "--work-item", "work-item-1"]);
  assert.equal(result.data.steer.code, "TARGET_CHANGED");
});

test("steer is idempotent by request id", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const first = command(["message", "steer", "task-1", "Prefer approach B now",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "worker", "--work-item", "work-item-1"]);
  assert.equal(first.kind, "input-steer");
  const replay = command(["message", "steer", "task-1", "Prefer approach B now",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "worker", "--work-item", "work-item-1"]);
  assert.equal(replay.kind, "output");
  assert.equal(replay.data.steer.state, "idempotent-replay");
  assert.equal(store.listMessages("task-1").filter(m => m.inputControl?.requestId === "s-1").length, 1);
});

test("a saved steer never becomes a queued continuation", t => {
  const { store, home, command } = fixture(t, { leader: "codex", worker: "claude" });
  dispatchWorker(store, command, home, "claude");
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const saved = command(["message", "steer", "task-1", "In-flight redirect",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "worker", "--work-item", "work-item-1"]);
  const before = store.listRuns("task-1").length;
  prepareMessageContinuations(store, "task-1", later, "worker");
  // The steer message is excluded from the continuation path: no new Run, and it
  // is never tagged with a continuation runId (§1/§8).
  assert.equal(store.listRuns("task-1").length, before);
  const message = store.listMessages("task-1").find(m => m.id === saved.data.message.id);
  assert.equal(message.continuation?.runId, undefined);
});

// ── steer control op: independent, monotonic, idempotent (message-5 gap D) ────
// A steer carries one live control attempt whose observed disposition is a
// separate, message-associated control op — distinct from the frozen business
// intent. These drive the REAL chain end to end: the CLI command records the one
// `pending` attempt at the live edge, and the Host's own input settlement folds
// through the exact adapter ingress (observeRuntimeObservation) to the proven
// terminal, for a Worker (run-bound) and a no-Run Leader steer alike. No writeback
// from the CLI: the authoritative terminal is the Host fact, and the fold is
// monotonic (first proven terminal wins) and idempotent (a replay folds once).

/** Bind the Role's Provider to an accepted native Turn that carries its owning
 * AgentRun id — the exact shape a Worker/Reviewer steer settlement folds onto
 * (the Host stamps YUI_RUN_ID into the turn). withControllerTurn omits the runId
 * for the no-Run cases; the Worker accepted fold requires it (native.runId ===
 * run.id), so a faithful Worker chain uses this variant. */
function withRunBoundTurn(store, roleName, { runId, attemptId, nativeTurnId, nativeSessionId = `${roleName}-native` }) {
  let binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: nativeSessionId, startedAt: at.toISOString()
  });
  binding = beginProviderTurn(binding, { runId, attemptId, authorityEpoch: 1, submittedAt: at.toISOString() });
  binding = acceptProviderTurn(binding, { attemptId, nativeTurnId, acceptedAt: later.toISOString() });
  store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(
    store.getTaskRoleSessionSet("task-1", roleName), binding, later));
  return binding;
}

/** Build the exact Host input-settlement observation
 * publishStructuredProviderInputSettlement emits for a steer receipt: an
 * input.accepted/rejected/delivery-unknown canonical fact keyed by the steer's
 * `steer:<taskId>/<messageId>` receipt, carrying the run fence when the steer had
 * an owning AgentRun and none for a no-Run Leader steer. A distinct `key` models
 * a separate Host fact; the same `key` models a transport replay. */
function steerSettlement({ kind, receiptId, roleName, agentId, runId, nativeSessionId, nativeTurnId = "t-1", key }) {
  const id = key ?? `${kind}:${receiptId}`;
  return createRuntimeObservation({
    schemaVersion: 4, eventId: id, semanticKey: id, kind,
    authority: "provider-structured", receivedAt: later.toISOString(), sequence: 0,
    fence: {
      taskId: "task-1", roleName, agentId, driverId: "openai/codex",
      conversationId: nativeSessionId, nativeSessionId, nativeTurnId,
      ...(runId === undefined ? {} : { runId }), receiptId
    },
    payload: { input: "Prefer approach B now" }
  });
}

test("a saved-but-undelivered steer is not-submitted; a delivered steer is pending", t => {
  // not-submitted: an incapable plan saves the steer but never reaches the live
  // edge, so there is no control op at all — the absence of a record, not a value.
  const incapable = fixture(t, { leader: "codex", worker: "claude" });
  dispatchWorker(incapable.store, incapable.command, incapable.home, "claude");
  withControllerTurn(incapable.store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const saved = incapable.command(["message", "steer", "task-1", "Prefer approach B now",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "worker", "--work-item", "work-item-1"]);
  assert.equal(saved.data.steer.code, "STEER_UNSUPPORTED");
  const savedMessage = incapable.store.listMessages("task-1").find(m => m.id === saved.data.message.id);
  assert.equal(savedMessage.control, undefined);
  assert.equal(taskMessageInputControlState(savedMessage), "not-submitted");
  // pending: a capable plan reaches the live edge, so exactly one control op is
  // recorded as pending — an attempt made but not yet proven by the Host.
  const capable = fixture(t);
  dispatchWorker(capable.store, capable.command, capable.home);
  withControllerTurn(capable.store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const steer = capable.command(["message", "steer", "task-1", "Prefer approach B now",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "worker", "--work-item", "work-item-1"]);
  assert.equal(steer.kind, "input-steer");
  const pending = capable.store.listMessages("task-1").find(m => m.id === steer.messageId);
  assert.equal(taskMessageInputControlState(pending), "pending");
  // The op is messageRef-associated: keyed by this exact receipt and the steer's
  // own requestId, so a later Host fact folds onto this Message and no other.
  assert.equal(pending.control.receiptId, `steer:task-1/${steer.messageId}`);
  assert.equal(pending.control.requestId, "s-1");
});

test("the Host's accepted settlement folds a Worker steer's control op to accepted", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  const run = store.getActiveRun("task-1", "worker");
  withRunBoundTurn(store, "worker", { runId: run.id, attemptId: "a-1", nativeTurnId: "t-1" });
  const steer = command(["message", "steer", "task-1", "Prefer approach B now",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "worker", "--work-item", "work-item-1"]);
  assert.equal(steer.kind, "input-steer");
  assert.equal(taskMessageInputControlState(
    store.listMessages("task-1").find(m => m.id === steer.messageId)), "pending");
  // The Host's own accepted settlement, folded through the real adapter ingress.
  const adapter = new FileSchedulerStoreAdapter(store);
  const applied = adapter.observeRuntimeObservation(steerSettlement({
    kind: "input.accepted", receiptId: steer.receiptId, roleName: "worker",
    agentId: run.effective.agentId, runId: run.id, nativeSessionId: "worker-native"
  }), evenLater);
  assert.equal(applied, "applied");
  const accepted = store.listMessages("task-1").find(m => m.id === steer.messageId);
  assert.equal(accepted.control.outcome, "accepted");
  assert.equal(taskMessageInputControlState(accepted), "accepted");
});

test("a rejected Host settlement folds the control op to rejected and appends no run input", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  const run = store.getActiveRun("task-1", "worker");
  withRunBoundTurn(store, "worker", { runId: run.id, attemptId: "a-1", nativeTurnId: "t-1" });
  const steer = command(["message", "steer", "task-1", "Prefer approach B now",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "worker", "--work-item", "work-item-1"]);
  const inputsBefore = store.getActiveRun("task-1", "worker").inputs.length;
  const adapter = new FileSchedulerStoreAdapter(store);
  const applied = adapter.observeRuntimeObservation(steerSettlement({
    kind: "input.rejected", receiptId: steer.receiptId, roleName: "worker",
    agentId: run.effective.agentId, runId: run.id, nativeSessionId: "worker-native"
  }), evenLater);
  assert.equal(applied, "applied");
  assert.equal(store.listMessages("task-1").find(m => m.id === steer.messageId).control.outcome, "rejected");
  // A rejected input changed no execution: the owning Run gains no input delta.
  assert.equal(store.getActiveRun("task-1", "worker").inputs.length, inputsBefore);
});

test("a no-Run Leader steer records pending and folds a delivery-unknown settlement, with no AgentRun", (t) => {
  const { store } = fixture(t);
  withLeaderTurn(store, { attemptId: "a-1", nativeTurnId: "t-1" });
  const agentId = store.getTaskRoleSessionSet("task-1", "leader").activeAgentId;
  const steer = runTaskCommand(["message", "steer", "task-1", "Re-plan around the new constraint",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "leader"],
    store, { now: () => later, environment: {} });
  assert.equal(steer.kind, "input-steer");
  assert.equal(taskMessageInputControlState(
    store.listMessages("task-1").find(m => m.id === steer.messageId)), "pending");
  // A Leader's own turn is a real native turn but not an AgentRun (decision-3 §9):
  // its settlement carries no runId, and the fold records the op with no run append.
  const adapter = new FileSchedulerStoreAdapter(store);
  const applied = adapter.observeRuntimeObservation(steerSettlement({
    kind: "input.delivery-unknown", receiptId: steer.receiptId, roleName: "leader",
    agentId, nativeSessionId: "leader-native"
  }), evenLater);
  assert.equal(applied, "applied");
  assert.equal(store.listMessages("task-1").find(m => m.id === steer.messageId).control.outcome, "delivery-unknown");
  assert.equal(store.listRuns("task-1").length, 0, "the fold never fabricates an AgentRun");
});

test("a proven control terminal is frozen: a later Host settlement never rewinds it", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  const run = store.getActiveRun("task-1", "worker");
  withRunBoundTurn(store, "worker", { runId: run.id, attemptId: "a-1", nativeTurnId: "t-1" });
  const steer = command(["message", "steer", "task-1", "Prefer approach B now",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "worker", "--work-item", "work-item-1"]);
  const adapter = new FileSchedulerStoreAdapter(store);
  adapter.observeRuntimeObservation(steerSettlement({
    kind: "input.delivery-unknown", receiptId: steer.receiptId, roleName: "worker",
    agentId: run.effective.agentId, runId: run.id, nativeSessionId: "worker-native", key: "unknown-first"
  }), later);
  adapter.observeRuntimeObservation(steerSettlement({
    kind: "input.accepted", receiptId: steer.receiptId, roleName: "worker",
    agentId: run.effective.agentId, runId: run.id, nativeSessionId: "worker-native", key: "accepted-1"
  }), evenLater);
  assert.equal(store.listMessages("task-1").find(m => m.id === steer.messageId).control.outcome, "accepted");
  // A later, distinct Host fact (not a replay) tries to move the same op. The
  // first proven terminal wins: the control op is absorbed, never rewound.
  const applied = adapter.observeRuntimeObservation(steerSettlement({
    kind: "input.delivery-unknown", receiptId: steer.receiptId, roleName: "worker",
    agentId: run.effective.agentId, runId: run.id, nativeSessionId: "worker-native", key: "unknown-2"
  }), evenLater);
  assert.equal(applied, "applied");
  assert.equal(store.listMessages("task-1").find(m => m.id === steer.messageId).control.outcome, "accepted");
});

test("a replayed Host settlement folds the control op exactly once", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  const run = store.getActiveRun("task-1", "worker");
  withRunBoundTurn(store, "worker", { runId: run.id, attemptId: "a-1", nativeTurnId: "t-1" });
  const steer = command(["message", "steer", "task-1", "Prefer approach B now",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "worker", "--work-item", "work-item-1"]);
  const adapter = new FileSchedulerStoreAdapter(store);
  const obs = steerSettlement({
    kind: "input.accepted", receiptId: steer.receiptId, roleName: "worker",
    agentId: run.effective.agentId, runId: run.id, nativeSessionId: "worker-native", key: "accepted-once"
  });
  assert.equal(adapter.observeRuntimeObservation(obs, evenLater), "applied");
  assert.equal(adapter.observeRuntimeObservation(obs, evenLater), "applied");
  assert.equal(store.listMessages("task-1").find(m => m.id === steer.messageId).control.outcome, "accepted");
  const folded = store.listEvents("task-1").filter(e =>
    e.type === "runtime.observation" && e.payload.semanticKey === "accepted-once");
  assert.equal(folded.length, 1, "the settlement is persisted and folded exactly once");
});

// ── steer read authority: the promised Context reconcile path (message-5 gap E) ─
// The steer receipt directs the recipient to reconcile the pushed input "through
// your authorized Context read path". A steer is TARGETED (recipient + work scope)
// and created AFTER the Assignment snapshot, so it enters neither the frozen
// readableRefs nor the untargeted-shared set — the promised read would deny it.
// The fix authorizes exactly the steers addressed to the caller's current
// Assignment scope as a live delta, and nothing wider: an ordinary addressed
// Message still needs its own frozen delta, and a steer for another Role or
// WorkItem stays out of scope. These drive the REAL read path end to end
// (inspectTaskContext / listContextMessages), the exact `context expand` entry.

/** The managed caller identity of the Worker's current native Session — the env a
 * Worker's own `yui task context` invocation carries. YUI_WORKSPACE is omitted on
 * purpose: the runtime recognizes the caller by its native session id, and the
 * pinned workspace root is a dynamic per-Dispatch path, not a fixed test value. */
function workerContextEnv() {
  return { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1", YUI_ROLE: "worker", YUI_NATIVE_SESSION_ID: "worker-native" };
}

test("a Worker reconciles its own steer through the authorized Context read path (message-5 gap E)", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  const run = store.getActiveRun("task-1", "worker");
  withRunBoundTurn(store, "worker", { runId: run.id, attemptId: "a-1", nativeTurnId: "t-1" });
  const steer = command(["message", "steer", "task-1", "Prefer approach B now",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "worker", "--work-item", "work-item-1"]);
  assert.equal(steer.kind, "input-steer");
  // The steer header promises reconciliation "through your authorized Context read
  // path". Prove that exact path (`context expand`) resolves the steer it names.
  const env = workerContextEnv();
  const expanded = inspectTaskContext(store, "task-1", { store: "task-message", refId: steer.messageId }, env);
  assert.equal(expanded.ref.refId, steer.messageId);
  assert.equal(expanded.value.inputControl.action, "steer");
  assert.ok(listContextMessages(store, "task-1", env).some(m => m.id === steer.messageId));
  // The delta is exactly the steer, not a widening of the frozen Assignment: an
  // ordinary addressed Message to the same scope still requires its own frozen
  // delta, so it is not readable off the back of the steer grant.
  const ordinary = command(["message", "send", "task-1", "Ordinary follow-up",
    "--to", "worker", "--work-item", "work-item-1"]);
  assert.throws(() => inspectTaskContext(store, "task-1",
    { store: "task-message", refId: ordinary.data.message.id }, env),
    /unavailable in the caller's current scope/);
  assert.ok(!listContextMessages(store, "task-1", env).some(m => m.id === ordinary.data.message.id));
});

test("a steer to another Role is not authorized to this Worker (message-5 gap E scope isolation)", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  const run = store.getActiveRun("task-1", "worker");
  withRunBoundTurn(store, "worker", { runId: run.id, attemptId: "a-1", nativeTurnId: "t-1" });
  // A Leader steer stores as an untargeted `user` Message (a Leader holds no
  // Assignment), yet it is a live-turn control for the Leader alone — never shared
  // Task intent. The untargeted-shared grant must not leak it to a Worker.
  withLeaderTurn(store, { attemptId: "la-1", nativeTurnId: "lt-1" });
  const leaderSteer = runTaskCommand(["message", "steer", "task-1", "Re-plan around the new constraint",
    "--request-id", "ls-1", "--expected-target", "lt-1", "--to", "leader"],
    store, { now: () => later, environment: {} });
  assert.equal(leaderSteer.kind, "input-steer");
  const env = workerContextEnv();
  assert.throws(() => inspectTaskContext(store, "task-1",
    { store: "task-message", refId: leaderSteer.messageId }, env),
    /unavailable in the caller's current scope/);
  assert.ok(!listContextMessages(store, "task-1", env).some(m => m.id === leaderSteer.messageId));
});

test("a steer for a different WorkItem is not authorized in the Worker's current scope (message-5 gap E)", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  const run1 = store.getActiveRun("task-1", "worker");
  withRunBoundTurn(store, "worker", { runId: run1.id, attemptId: "a-1", nativeTurnId: "t-1" });
  const steer1 = command(["message", "steer", "task-1", "Prefer B on the first WorkItem",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "worker", "--work-item", "work-item-1"]);
  // Move the Worker to a second WorkItem on the same pinned workspace (a legal
  // resume), so its current Assignment scope becomes work-item-2.
  terminalizeWorkerRun(store, run1, "cancelled", evenLater);
  command(["work", "create", "task-1", "Second bounded work", "--role", "worker"]);
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "work-item", taskId: "task-1", workItemId: "work-item-2" },
    root: join(home, "worker"), entries: []
  }, at));
  command(["work", "dispatch", "task-1/work-item-2"]);
  const run2 = store.getActiveRun("task-1", "worker");
  store.saveTaskRoleSessionSet(recordRoleAgentSession(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "worker" }, run2.effective.agentId, evenLater
  ), {
    agentId: run2.effective.agentId, adapterId: "codex", nativeSessionId: "worker-native",
    policy: "fixed", status: "active", effective: run2.effective
  }, evenLater));
  let binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: "worker-native", startedAt: evenLater.toISOString()
  });
  binding = beginProviderTurn(binding, { runId: run2.id, attemptId: "a-2", authorityEpoch: 1, submittedAt: evenLater.toISOString() });
  binding = acceptProviderTurn(binding, { attemptId: "a-2", nativeTurnId: "t-2", acceptedAt: evenLater.toISOString() });
  store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(
    store.getTaskRoleSessionSet("task-1", "worker"), binding, evenLater));
  const steer2 = command(["message", "steer", "task-1", "Prefer B on the second WorkItem",
    "--request-id", "s-2", "--expected-target", "t-2", "--to", "worker", "--work-item", "work-item-2"]);
  const env = workerContextEnv();
  // The current-scope steer resolves; the prior WorkItem's steer stays out of scope.
  assert.equal(inspectTaskContext(store, "task-1",
    { store: "task-message", refId: steer2.messageId }, env).ref.refId, steer2.messageId);
  assert.throws(() => inspectTaskContext(store, "task-1",
    { store: "task-message", refId: steer1.messageId }, env),
    /unavailable in the caller's current scope/);
});

// ── interrupt ──────────────────────────────────────────────────────────────

test("interrupt resolves a native cancel on a capable plan", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const result = command(["role", "interrupt", "task-1", "worker", "--expected-target", "t-1"]);
  assert.equal(result.kind, "input-interrupt");
  assert.match(result.receiptId, /^interrupt:task-1\/interrupt-/);
  assert.equal(result.thenMessageId, undefined);
  recordTaskInterruptResult(store, "task-1", result.receiptId,
    { state: "interrupt-unavailable", outcome: "rejected" }, later);
  const retry = command(["role", "interrupt", "task-1", "worker",
    "--expected-target", "t-1", "--request-id", "explicit-retry-after-rejection"]);
  assert.equal(retry.kind, "input-interrupt", "known rejection permits a new explicit operation");
  assert.notEqual(retry.receiptId, result.receiptId);
  const uncertainRetry = command(["role", "interrupt", "task-1", "worker",
    "--expected-target", "t-1", "--request-id", "cannot-bypass-pending"]);
  assert.equal(uncertainRetry.data.interrupt.code, "DELIVERY_UNKNOWN");
});

test("interrupt on an owned-process plan is INTERRUPT_UNSUPPORTED, never a kill", t => {
  const { store, home, command } = fixture(t, { leader: "codex", worker: "claude" });
  dispatchWorker(store, command, home, "claude");
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const result = command(["role", "interrupt", "task-1", "worker", "--expected-target", "t-1"]);
  assert.equal(result.kind, "output");
  assert.equal(result.data.interrupt.state, "not-interrupted");
  assert.equal(result.data.interrupt.code, "INTERRUPT_UNSUPPORTED");
});

test("interrupt --then-message claims one same-Session continuation after a proven terminal", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const saved = command(["message", "send", "task-1", "Do this next",
    "--to", "worker", "--work-item", "work-item-1"]);
  const activeRunId = store.getActiveRun("task-1", "worker").id;
  const result = command(["role", "interrupt", "task-1", "worker",
    "--expected-target", "t-1", "--then-message", `task-1/${saved.data.message.id}`, "--request-id", "i-1"]);
  assert.equal(result.kind, "input-interrupt");
  assert.equal(result.thenMessageId, saved.data.message.id);
  const message = store.listMessages("task-1").find(m => m.id === saved.data.message.id);
  assert.equal(message.interruptThen.targetRunId, activeRunId);
  assert.equal(message.inputControl, undefined);
  assert.ok(store.listEvents("task-1").some(e => e.type === "message.interrupt-then-claimed"
    && e.payload.messageId === saved.data.message.id));
});

test("a second continuation claim on the same target Run is refused, not duplicated", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const first = command(["message", "send", "task-1", "First next", "--to", "worker", "--work-item", "work-item-1"]);
  const second = command(["message", "send", "task-1", "Second next", "--to", "worker", "--work-item", "work-item-1"]);
  command(["role", "interrupt", "task-1", "worker",
    "--expected-target", "t-1", "--then-message", `task-1/${first.data.message.id}`, "--request-id", "i-1"]);
  const conflict = command(["role", "interrupt", "task-1", "worker",
    "--expected-target", "t-1", "--then-message", `task-1/${second.data.message.id}`, "--request-id", "i-2"]);
  assert.equal(conflict.kind, "output");
  assert.equal(conflict.data.interrupt.code, "DELIVERY_UNKNOWN");
});

test("interrupt --then-message is idempotent by request id", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const saved = command(["message", "send", "task-1", "Do this next", "--to", "worker", "--work-item", "work-item-1"]);
  const ref = `task-1/${saved.data.message.id}`;
  const first = command(["role", "interrupt", "task-1", "worker",
    "--expected-target", "t-1", "--then-message", ref, "--request-id", "i-1"]);
  const replay = command(["role", "interrupt", "task-1", "worker",
    "--expected-target", "t-1", "--then-message", ref, "--request-id", "i-1"]);
  assert.equal(first.kind, "input-interrupt");
  assert.equal(replay.kind, "output");
  assert.equal(replay.data.interrupt.state, "idempotent-replay");
  assert.equal(store.listEvents("task-1").filter(e => e.type === "message.interrupt-then-claimed").length, 1);
  recordTaskInterruptResult(store, "task-1", first.receiptId,
    { state: "interrupt-unavailable", outcome: "rejected" }, later);
  const retry = command(["role", "interrupt", "task-1", "worker",
    "--expected-target", "t-1", "--then-message", ref, "--request-id", "i-2"]);
  assert.equal(retry.kind, "input-interrupt");
  assert.equal(store.listEvents("task-1").filter(e => e.type === "message.interrupt-then-claimed").length, 1);
});

test("then refuses a steer already accepted or still uncertain without changing its input", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  const run = store.getActiveRun("task-1", "worker");
  withRunBoundTurn(store, "worker", { runId: run.id, attemptId: "a-1", nativeTurnId: "t-1" });
  for (const outcome of ["pending", "accepted", "delivery-unknown"]) {
    const steer = command(["message", "steer", "task-1", `input ${outcome}`,
      "--request-id", `s-${outcome}`, "--expected-target", "t-1",
      "--to", "worker", "--work-item", "work-item-1"]);
    const original = store.listMessages("task-1").find(m => m.id === steer.messageId);
    store.updateMessage("task-1", { ...original, control: { ...original.control, outcome } });
    const result = command(["role", "interrupt", "task-1", "worker",
      "--expected-target", "t-1", "--then-message", `task-1/${steer.messageId}`,
      "--request-id", `i-${outcome}`]);
    assert.equal(result.kind, "output");
    assert.notEqual(result.data.interrupt.state, "interrupted");
    const kept = store.listMessages("task-1").find(m => m.id === steer.messageId);
    assert.equal(kept.interruptThen, undefined);
    assert.equal(kept.inputControl.action, "steer");
  }
});

test("a prior Assignment cannot steer the Role's new active Turn", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  const old = readyWorkerContinuation(store);
  withRunBoundTurn(store, "worker", { runId: old.id, attemptId: "a-1", nativeTurnId: "t-1" });
  terminalizeWorkerRun(store, old, "cancelled", evenLater);
  command(["work", "create", "task-1", "Other assignment", "--role", "worker"]);
  store.saveManagedWorkspace(createManagedWorkspace({
    owner: { type: "work-item", taskId: "task-1", workItemId: "work-item-2" },
    root: join(home, "worker-2"), entries: []
  }, evenLater));
  store.saveTaskRoleSessionSet(createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "worker" }, "codex", evenLater));
  command(["work", "dispatch", "task-1/work-item-2"]);
  const current = store.getActiveRun("task-1", "worker");
  store.saveTaskRoleSessionSet(recordRoleAgentSession(
    store.getTaskRoleSessionSet("task-1", "worker"), {
      agentId: "codex", adapterId: "codex", nativeSessionId: "worker-native-new",
      policy: "fixed", status: "active", effective: current.effective
    }, evenLater));
  withRunBoundTurn(store, "worker", {
    runId: current.id, attemptId: "a-2", nativeTurnId: "t-2", nativeSessionId: "worker-native-new"
  });
  const result = command(["message", "steer", "task-1", "Old assignment input",
    "--request-id", "stale-assignment", "--expected-target", "t-2",
    "--to", "worker", "--work-item", "work-item-1"]);
  assert.equal(result.kind, "output");
  assert.equal(result.data.steer.code, "TARGET_CHANGED");
  assert.equal(result.data.message.control, undefined);
});

// ── real-chain regressions (decision-3 §11) ──────────────────────────────────
// The command-return tests above prove the CLI's saved fields; these drive the
// live continuation/turn-state chain the Host actually reads, the seconds-scale
// deterministic core message-3 #7 requires: an unconfirmed original Turn is not a
// steerable/cancellable target, a then-handoff is not preempted by the old queue
// and delivers once in the same Session after a proven terminal, and an unknown
// terminal is never replayed.

test("steer against a still-submitting original Turn is DELIVERY_UNKNOWN, never a steer", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  // The attempt was submitted but never accepted: acceptance is unproven.
  withUnconfirmedTurn(store, "worker", { attemptId: "a-1" });
  const result = command(["message", "steer", "task-1", "Prefer approach B now",
    "--request-id", "s-1", "--expected-target", "a-1", "--to", "worker", "--work-item", "work-item-1"]);
  // The right Turn is confirmed, but its own delivery is unproven: report it, do
  // not push a second input onto an unconfirmed one (decision-3 §3/§8).
  assert.equal(result.kind, "output");
  assert.equal(result.data.steer.state, "not-steered");
  assert.equal(result.data.steer.code, "DELIVERY_UNKNOWN");
  // Saved, never downgraded to a queue or replayed under another action.
  assert.ok(store.listMessages("task-1").some(m => m.id === result.data.message.id
    && m.inputControl?.action === "steer"));
});

test("interrupt against a delivery-unknown original Turn is DELIVERY_UNKNOWN, never a guessed cancel", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  // The outbound attempt's acceptance was never proven (transport dropped).
  withUnconfirmedTurn(store, "worker", { attemptId: "a-1", unknown: true });
  const result = command(["role", "interrupt", "task-1", "worker", "--expected-target", "a-1"]);
  // Cancelling an attempt that may not have landed would guess a stop; report the
  // unknown so the caller confirms the original attempt first (decision-3 §8/§10).
  assert.equal(result.kind, "output");
  assert.equal(result.data.interrupt.state, "not-interrupted");
  assert.equal(result.data.interrupt.code, "DELIVERY_UNKNOWN");
});

test("an interrupt-then handoff holds the old queue until the exact Run terminates, then delivers once in the same Session", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const target = readyWorkerContinuation(store);
  const handoff = command(["message", "send", "task-1", "Do this after the stop",
    "--to", "worker", "--work-item", "work-item-1"]);
  const queued = command(["message", "send", "task-1", "Ordinary queued follow-up",
    "--to", "worker", "--work-item", "work-item-1"]);
  command(["role", "interrupt", "task-1", "worker", "--expected-target", "t-1",
    "--then-message", `task-1/${handoff.data.message.id}`, "--request-id", "i-1"]);
  // Phase 1: the interrupted Run is still active. The whole recipient is held —
  // neither the handoff nor the ordinary queue may start a new Run (decision-3 §4).
  const runsBefore = store.listRuns("task-1").length;
  prepareMessageContinuations(store, "task-1", later, "worker");
  assert.equal(store.listRuns("task-1").length, runsBefore);
  assert.equal(store.listMessages("task-1").find(m => m.id === handoff.data.message.id).continuation?.runId, undefined);
  assert.equal(store.listMessages("task-1").find(m => m.id === queued.data.message.id).continuation?.runId, undefined);
  // Phase 2: the exact interrupted Run reaches a proven terminal and its native
  // Turn settles. Now — and only now — the handoff delivers, once, ahead of the
  // old queue, in the same native Session.
  terminalizeWorkerRun(store, target, "cancelled", evenLater);
  prepareMessageContinuations(store, "task-1", evenLater, "worker");
  const created = store.listRuns("task-1").filter(r => r.id !== target.id);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].inputs[0].input.deltaRefIds, [handoff.data.message.id]);
  assert.equal(store.listMessages("task-1").find(m => m.id === handoff.data.message.id).continuation?.runId, created[0].id);
  // The ordinary queue only follows after the handoff; it is not delivered here.
  assert.equal(store.listMessages("task-1").find(m => m.id === queued.data.message.id).continuation?.runId, undefined);
});

test("an interrupt-then handoff whose target terminates delivery-unknown is never replayed", t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const target = readyWorkerContinuation(store);
  const handoff = command(["message", "send", "task-1", "Do this after the stop",
    "--to", "worker", "--work-item", "work-item-1"]);
  command(["role", "interrupt", "task-1", "worker", "--expected-target", "t-1",
    "--then-message", `task-1/${handoff.data.message.id}`, "--request-id", "i-1"]);
  // The interrupted Run cannot prove it stopped: its terminal is delivery-unknown.
  terminalizeWorkerRun(store, target, "delivery-unknown", evenLater);
  const runsBefore = store.listRuns("task-1").length;
  prepareMessageContinuations(store, "task-1", evenLater, "worker");
  // No new Run: the handoff is held, not released across an unproven boundary,
  // and never replayed under the same or a new request (decision-3 §4/§8).
  assert.equal(store.listRuns("task-1").length, runsBefore);
  const held = store.listMessages("task-1").find(m => m.id === handoff.data.message.id);
  assert.equal(held.continuation?.runId, undefined);
  assert.match(held.continuation?.notDeliveredReason ?? "", /unknown/);
});

// ── no-Run Leader interrupt-then release chain (decision-3 §4/§9, message-5 gap B) ──
// A Worker/Reviewer handoff is released by the reconcile loop's
// prepareMessageContinuations pass, driven by the owning AgentRun's terminal. A
// Leader's own management/Draft turn owns NO AgentRun and is never surfaced by
// that push path; it is delivered only by waking the Leader to read its Context.
// The interrupt itself — and a reused steer-to-leader (wakePolicy "none") — leaves
// NO wake, so registerInterruptThen must enqueue a busy-gated leader release wake.
// These drive the REAL command + FileSchedulerStoreAdapter + processLeaderWakeups
// chain: no fabricated Run, and the busy-gate holds the wake on exactly the same
// unsettled/unproven Turn set as the terminal gate (§4).

/** Put the Leader's own native Turn in-flight (accepted) with NO AgentRun, or,
 * with `unknown`, on a submitting→delivery-unknown Turn whose delivery is unproven. */
function withLeaderTurn(store, { attemptId, nativeTurnId, unknown = false }) {
  let binding = createProviderRuntimeBinding({
    providerNamespace: "openai/codex", accountScope: "codex",
    conversationId: "leader-native", startedAt: at.toISOString()
  });
  binding = beginProviderTurn(binding, { attemptId, authorityEpoch: 1, submittedAt: at.toISOString() });
  binding = unknown
    ? markProviderTurnDeliveryUnknown(binding, { attemptId, observedAt: later.toISOString(), reason: "transport-dropped" })
    : acceptProviderTurn(binding, { attemptId, nativeTurnId, acceptedAt: later.toISOString() });
  store.saveTaskRoleSessionSet(bindTaskRoleProviderRuntime(
    store.getTaskRoleSessionSet("task-1", "leader"), binding, later));
  return binding;
}

/** Settle the Leader's own native Turn to a clean terminal (the release precondition). */
function settleLeaderTurn(store, { nativeTurnId, status }, when) {
  const settled = settleProviderTurn(
    store.getTaskRoleSessionSet("task-1", "leader").providerBinding,
    { nativeTurnId, status, settledAt: when.toISOString() });
  store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(
    store.getTaskRoleSessionSet("task-1", "leader"), settled, when));
}

/** A fake Leader delivery port that refuses to carry an AgentRun and records
 * each generic "read your Context" notification the wake produced. */
function leaderDelivery(notifications, session) {
  return {
    prepareRoleSession: async (request) => {
      assert.equal(request.runId, undefined, "a Leader notification must not carry an AgentRun");
      return { session };
    },
    waitUntilReady: async (prepared) => prepared,
    sendOnce: async (request) => { notifications.push(request); return { status: "sent" }; }
  };
}

test("a no-Run Leader interrupt-then wake is held while the interrupted Turn is live, then fires once after a clean terminal with no AgentRun", async (t) => {
  const { store } = fixture(t);
  withLeaderTurn(store, { attemptId: "a-1", nativeTurnId: "t-1" });
  // A steer-to-leader is the reused input; wakePolicy "none" means it enqueues NO
  // wake, so the release trigger must come from the interrupt claim itself.
  const saved = runTaskCommand(["message", "steer", "task-1", "Re-plan around the new constraint",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "leader"],
    store, { now: () => later, environment: {} });
  const messageId = saved.messageId;
  new FileSchedulerStoreAdapter(store).observeRuntimeObservation(steerSettlement({
    kind: "input.rejected", receiptId: saved.receiptId, roleName: "leader",
    agentId: "codex", nativeSessionId: "leader-native"
  }), later);
  assert.equal(store.getPendingWakeup("task-1"), null, "steer-to-leader must not wake the Leader");
  // Interrupt the Leader's OWN turn with an explicit then-handoff.
  const interrupt = runTaskCommand(["role", "interrupt", "task-1", "leader",
    "--expected-target", "t-1", "--then-message", `task-1/${messageId}`, "--request-id", "i-1"],
    store, { now: () => later, environment: {} });
  assert.equal(interrupt.kind, "input-interrupt");
  const claim = store.listMessages("task-1").find((m) => m.id === messageId);
  assert.equal(claim.interruptThen.targetAttemptId, "a-1");
  assert.equal(claim.interruptThen.targetRunId, undefined, "no-Run Leader claim carries no targetRunId");
  assert.equal(claim.inputControl, undefined, "the live steer is cleared, kept only as provenance");
  assert.equal(claim.interruptThen.reusedInput.requestId, "s-1");
  // The claim enqueued the release wake (this is the gap-B fix).
  const pending = store.getPendingWakeup("task-1");
  assert.ok(pending?.reasons.includes("interrupt-then"), "the claim enqueues a busy-gated leader release wake");

  const adapter = new FileSchedulerStoreAdapter(store);
  const session = Object.values(store.getTaskRoleSessionSet("task-1", "leader").sessions)[0];
  const notifications = [];
  const delivery = leaderDelivery(notifications, session);
  // Phase 1: the interrupted Turn is still accepted → busy-gate HOLDS the wake.
  let results = await processLeaderWakeups(adapter, delivery, evenLater);
  assert.equal(results[0].status, "skipped", "held while the interrupted Turn is still live");
  assert.equal(notifications.length, 0);
  assert.ok(store.getPendingWakeup("task-1") !== null, "the wake stays pending while held");
  // Phase 2: the interrupted native Turn settles to a clean terminal → wake FIRES.
  settleLeaderTurn(store, { nativeTurnId: "t-1", status: "cancelled" }, evenLater);
  results = await processLeaderWakeups(adapter, delivery, evenLater);
  assert.equal(results[0].status, "dispatched", "released only after a proven clean terminal");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /yui task context/u, "the Leader is woken to read its Context");
  assert.equal(store.listRuns("task-1").length, 0, "the release never fabricates an AgentRun");
  assert.ok(store.listMessages("task-1").some((m) => m.id === messageId), "the handoff stays durable and visible");
});

test("a no-Run Leader interrupt-then wake is never released across a delivery-unknown Turn", async (t) => {
  const { store } = fixture(t);
  // The Leader's own Turn is submitting→delivery-unknown: its delivery is unproven.
  withLeaderTurn(store, { attemptId: "a-1", nativeTurnId: "t-1", unknown: true });
  const adapter = new FileSchedulerStoreAdapter(store);
  // The release wake our fix enqueues, standing against an unprovable Turn.
  adapter.enqueueLeaderWakeup("task-1", "interrupt-then", later);
  assert.ok(store.getPendingWakeup("task-1") !== null);
  const session = Object.values(store.getTaskRoleSessionSet("task-1", "leader").sessions)[0];
  const notifications = [];
  const delivery = leaderDelivery(notifications, session);
  const results = await processLeaderWakeups(adapter, delivery, evenLater);
  assert.equal(results[0].status, "skipped", "held across an unprovable Turn (decision-3 §4/§8)");
  assert.equal(notifications.length, 0, "never released while delivery is unproven");
  assert.ok(store.getPendingWakeup("task-1") !== null, "the wake stays held, never replayed");
});

test("a repeated no-Run Leader interrupt-then claim does not stack a second release wake", (t) => {
  const { store } = fixture(t);
  withLeaderTurn(store, { attemptId: "a-1", nativeTurnId: "t-1" });
  const saved = runTaskCommand(["message", "steer", "task-1", "Re-plan",
    "--request-id", "s-1", "--expected-target", "t-1", "--to", "leader"],
    store, { now: () => later, environment: {} });
  const ref = `task-1/${saved.messageId}`;
  new FileSchedulerStoreAdapter(store).observeRuntimeObservation(steerSettlement({
    kind: "input.rejected", receiptId: saved.receiptId, roleName: "leader",
    agentId: "codex", nativeSessionId: "leader-native"
  }), later);
  const cmd = () => runTaskCommand(["role", "interrupt", "task-1", "leader",
    "--expected-target", "t-1", "--then-message", ref, "--request-id", "i-1"],
    store, { now: () => later, environment: {} });
  cmd();
  cmd();
  const pending = store.getPendingWakeup("task-1");
  assert.equal(pending.reasons.filter((r) => r === "interrupt-then").length, 1,
    "an idempotent repeat of the same claim does not stack a second wake");
  assert.equal(store.listEvents("task-1").filter((e) => e.type === "message.interrupt-then-claimed").length, 1,
    "the claim is recorded exactly once");
});

test("Leader then selects its own next notification ahead of ordinary queue", t => {
  const { store, command } = fixture(t);
  withLeaderTurn(store, { attemptId: "a-1", nativeTurnId: "t-1" });
  const queued = command(["message", "queue", "task-1", "Ordinary later input", "--request-id", "q-later"]);
  const saved = command(["message", "send", "task-1", "Chosen immediate successor", "--intent", "record"]);
  const result = command(["role", "interrupt", "task-1", "leader", "--expected-target", "t-1",
    "--then-message", `task-1/${saved.data.message.id}`, "--request-id", "i-next"]);
  assert.equal(result.kind, "input-interrupt");
  settleLeaderTurn(store, { nativeTurnId: "t-1", status: "cancelled" }, evenLater);
  const adapter = new FileSchedulerStoreAdapter(store);
  assert.throws(() => adapter.beginAgentHostProviderTurn({
    taskId: "task-1", roleName: "leader", agentId: "codex", nativeSessionId: "leader-native",
    attemptId: "competing-console-input", authorityEpoch: 1, authorityOwner: "controller",
    holderId: "controller", now: evenLater
  }), /then handoff/);
  const notification = adapter.claimLeaderNotification("task-1", evenLater);
  assert.equal(notification.disposition, "submit");
  const wake = store.listTaskWakes("task-1").find(w => w.id === notification.wakeId);
  assert.deepEqual(wake.refs.filter(r => r.type === "message").map(r => r.id), [saved.data.message.id]);
  const pending = store.getWorkMailbox({ kind: "role", taskId: "task-1", roleName: "leader" }).pending;
  assert.ok(pending.refs.some(r => r.type === "message" && r.id === queued.data.message.id));
});

test("a Leader-owned AgentRun can claim then without inventing a WorkItem Assignment", t => {
  const { store, command } = fixture(t);
  const session = store.getTaskRoleSessionSet("task-1", "leader").sessions.codex;
  const run = createRun("run-1", "task-1", "leader", "new", createRunInput({
    source: { type: "yui", channel: "task-dispatch" }, directive: "Manage the Task.", deltaRefIds: []
  }), at, { effective: session.effective, purpose: "execution" });
  store.saveRun(run);
  store.saveActiveRun(run);
  withRunBoundTurn(store, "leader", { runId: run.id, attemptId: "a-leader", nativeTurnId: "t-leader" });
  const saved = command(["message", "send", "task-1", "Continue after stopping", "--intent", "record"]);
  const control = command(["role", "interrupt", "task-1", "leader", "--expected-target", "t-leader",
    "--then-message", `task-1/${saved.data.message.id}`, "--request-id", "leader-with-run"]);
  assert.equal(control.kind, "input-interrupt");
  const claim = store.listMessages("task-1").find(message => message.id === saved.data.message.id).interruptThen;
  assert.equal(claim.targetRunId, run.id);
  assert.ok(store.getWorkMailbox({ kind: "role", taskId: "task-1", roleName: "leader" }).pending);
});

test("a replaced Leader never receives an old then, while new queue remains usable", t => {
  const { store, command } = fixture(t);
  withLeaderTurn(store, { attemptId: "a-1", nativeTurnId: "t-1" });
  const saved = command(["message", "send", "task-1", "Old then", "--intent", "record"]);
  command(["role", "interrupt", "task-1", "leader", "--expected-target", "t-1",
    "--then-message", `task-1/${saved.data.message.id}`, "--request-id", "i-old"]);
  const original = store.getTaskRoleSessionSet("task-1", "leader");
  store.saveTaskRoleSessionSet({
    ...original, providerBinding: null,
    sessions: { ...original.sessions, codex: { ...original.sessions.codex, nativeSessionId: "replacement" } }
  });
  const queued = command(["message", "queue", "task-1", "New input", "--request-id", "q-new"]);
  const notification = new FileSchedulerStoreAdapter(store).claimLeaderNotification("task-1", evenLater);
  assert.equal(notification.disposition, "submit");
  const wake = store.listTaskWakes("task-1").find(w => w.id === notification.wakeId);
  assert.deepEqual(wake.refs.filter(r => r.type === "message").map(r => r.id), [queued.data.message.id]);
  const expired = store.listMessages("task-1").find(m => m.id === saved.data.message.id);
  assert.equal(expired.interruptThen.notDeliveredReason, "target-session-or-authority-changed");
});

// ── Endpoint control boundary (decision-3 §3/§7, message-3 #1/#7) ─────────────
// The command-layer resolver decides a control is legal; the live Endpoint is
// where it is actually delivered. These drive the REAL BuiltinAgentEndpoint over
// an in-process fake Driver (no subprocess, no socket), so cancel() exercises the
// exact Host-facing path: the original attempt is named, and a cancel that cannot
// prove a quiescent terminal returns `unknown` rather than a guessed stop.

/**
 * An in-process StructuredProviderSession. The real endpoint factory wraps it,
 * so the returned endpoint is a genuine BuiltinAgentEndpoint. `cancelResult` is
 * what the Driver reports for cancelTurn; `emitTerminal` lets a test deliver a
 * native terminal event, and the turn's activeTurnId models quiescence.
 */
function fakeEndpoint(cancelResult) {
  let activeTurnId;
  let onTerminal = () => {};
  const cancelledAttempts = [];
  let resolveExit;
  const exit = new Promise((resolve) => { resolveExit = resolve; });
  const driver = {
    adapterId: "codex", conversationId: "conv-1", nativeSessionId: "sess-1", processInstanceId: "proc-1",
    get activeTurnId() { return activeTurnId; },
    runConfiguration: { status: "unknown", reason: "in-process fake" },
    async submitTurn(turn) {
      activeTurnId = `nt-${turn.attemptId}`;
      return { attemptId: turn.attemptId, conversationId: "conv-1", nativeSessionId: "sess-1",
        nativeTurnId: activeTurnId, acceptedAt: at.toISOString(), acceptance: "provider" };
    },
    async steerTurn(turn) { return this.submitTurn(turn); },
    async cancelTurn(attemptId) { cancelledAttempts.push(attemptId); return cancelResult; },
    waitForExit() { return exit; },
    terminate() { resolveExit?.({ code: 0 }); }
  };
  const control = { schemaVersion: 1, adapterId: "codex", transport: "codex-app-server-proxy",
    kind: "start", mode: "new", authority: { epoch: 1, owner: "controller", holderId: "test" } };
  const payload = { schemaVersion: 2, command: "x", args: [], environment: {}, cwd: tmpdir(),
    childLifecycle: "persistent", startMode: "provider", providerControl: control };
  const factory = createAgentEndpointFactory(async (_payload, callbacks) => {
    onTerminal = (attemptId) => callbacks.onTerminal({ conversationId: "conv-1", nativeSessionId: "sess-1",
      nativeTurnId: `nt-${attemptId}`, attemptId, clientOwned: true, status: "cancelled", observedAt: later.toISOString() });
    return { session: driver };
  });
  return { factory, payload, cancelledAttempts,
    emitTerminal: (attemptId) => onTerminal(attemptId),
    clearActiveTurn: () => { activeTurnId = undefined; } };
}

test("a native cancel names the exact original attempt at the live Endpoint", async () => {
  const fake = fakeEndpoint("unknown");
  const { session: endpoint } = await fake.factory.open(fake.payload);
  await endpoint.submit({ attemptId: "a-1", boundedText: "go", inputRef: "m-1" });
  const outcome = await endpoint.cancel("a-1");
  // The Driver received the original execution attempt id, not a control receipt.
  assert.deepEqual(fake.cancelledAttempts, ["a-1"]);
  // The Driver could not prove delivery, so the Endpoint reports unknown.
  assert.equal(outcome.status, "unknown");
  assert.equal(outcome.resources, "unknown");
});

test("a cancel with a terminal but a still-active Turn is unknown, not a proven stop", async () => {
  const fake = fakeEndpoint("requested");
  const { session: endpoint } = await fake.factory.open(fake.payload);
  await endpoint.submit({ attemptId: "a-1", boundedText: "go", inputRef: "m-1" });
  fake.emitTerminal("a-1");
  // A terminal was seen, but the Session still shows an active Turn: not quiescent.
  const outcome = await endpoint.cancel("a-1");
  assert.equal(outcome.status, "unknown");
  assert.equal(outcome.terminal, undefined);
});

test("a cancel with a proven quiescent terminal returns the original Turn's terminal fact", async () => {
  const fake = fakeEndpoint("requested");
  const { session: endpoint } = await fake.factory.open(fake.payload);
  await endpoint.submit({ attemptId: "a-1", boundedText: "go", inputRef: "m-1" });
  fake.emitTerminal("a-1");
  fake.clearActiveTurn();
  const outcome = await endpoint.cancel("a-1");
  assert.equal(outcome.status, "requested");
  assert.equal(outcome.terminal.status, "cancelled");
  assert.equal(outcome.terminal.attemptId, "a-1");
  // Even a proven terminal never claims the background resources are quiescent.
  assert.equal(outcome.resources, "unknown");
});

// ── src/web three-action surface (message-5 gap F) ───────────────────────────
// The local-user Web surface must expose the SAME decision-3 three actions the
// CLI does, through the SAME application-layer primitive (runTaskCommand), not a
// parallel re-implementation. A queue/steer/interrupt issued at the Web edge
// persists identically, records the one `pending` control op, and — for a ready
// steer/interrupt — performs the single live Agent Host edge exactly as cli.ts
// does. A real Provider is never a test subject, so the Host edge is a fake port
// that records the control it was asked to send; every durable fact around it is
// real. There is no fourth action and no auto-fallback.

/** A fake Agent Host control port: it records each steer/cancel it is asked to
 * perform and returns a fixed accepted outcome, standing in for the socket
 * client cli.ts uses. It never launches or contacts a Provider. */
function fakeWebHostControl() {
  const steers = [];
  const cancels = [];
  const result = (outcome) => ({
    protocol: "yui-agent-host/v5", outcome,
    snapshot: { protocol: "yui-agent-host/v5", state: "ready", nativeSessionId: "worker-native" }
  });
  return {
    steers, cancels,
    port: {
      steer: async (input) => { steers.push(input); return result("accepted"); },
      cancel: async (input) => { cancels.push(input); return result("cancel-requested"); }
    }
  };
}

test("Draft input controls preserve submission intent and keyed receipts without acquiring develop authority", async t => {
  const { store, home, command } = fixture(t, {});
  store.saveTask(createTask("task-1", "Draft input composition", at, { cwd: home }));
  const host = fakeWebHostControl();
  const surface = createWebTaskSurface(store, { yuiHome: home }, [], host.port);
  const recorded = surface.message("task-1", "Keep this requirement", "record", "record-1");
  assert.equal(recorded.record.intent, "record");
  assert.equal(recorded.record.submissionKey, "record-1");
  assert.equal(recorded.submission.planning, "none");
  assert.equal(recorded.submission.activation, "none");
  assert.equal(recorded.record.inputControl, undefined);

  const steer = await surface.control("task-1", {
    action: "steer", body: "Develop immediately", requestId: "steer-draft",
    to: "leader", expectedTarget: "absent-turn"
  });
  assert.equal(steer.record.inputControl.action, "steer");
  assert.equal(steer.record.intent, "record");
  assert.equal(steer.steer.state, "not-steered");
  assert.equal(store.getTask("task-1").activationRequest, undefined);
  assert.equal(store.listEvents("task-1").some(e => e.type === "task.planning-entered"), false);

  const queued = await surface.control("task-1", {
    action: "queue", body: "Develop immediately", requestId: "queue-draft"
  });
  assert.equal(queued.record.inputControl.action, "queue");
  assert.equal(queued.record.intent, "discuss");
  assert.equal(store.getTask("task-1").activationRequest, undefined);
  assert.equal(store.listEvents("task-1").filter(e => e.type === "task.planning-entered").length, 1);
  const replay = command(["message", "queue", "task-1", "Develop immediately",
    "--request-id", "queue-draft"]);
  assert.equal(replay.data.message.id, queued.record.id);
  assert.equal(replay.data.delivery.state, "idempotent-replay");
  assert.equal(store.listMessages("task-1").length, 3);

  // A receipt remains its original pre-planning disposition, even after queue
  // has entered planning; a different intent under that key is not a replay.
  const recordReplay = surface.message("task-1", "Keep this requirement", "record", "record-1");
  assert.equal(recordReplay.record.id, recorded.record.id);
  assert.deepEqual(recordReplay.submission, recorded.submission);
  assert.throws(() => surface.message("task-1", "Keep this requirement", "develop", "record-1"));
  const manual = surface.message("task-1", "Explicit develop", "develop", "develop-1");
  assert.equal(manual.submission.activation, "manual-required");
  assert.equal(store.getTask("task-1").activationRequest, undefined);
  assert.equal(host.steers.length, 0);
  assert.equal(host.cancels.length, 0);
});

test("the Web surface queues through the shared primitive and never reaches the live Host (gap F)", async t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const host = fakeWebHostControl();
  const surface = createWebTaskSurface(store, { yuiHome: home }, [], host.port);
  const receipt = await surface.control("task-1", {
    action: "queue", body: "--literal text, not a CLI option", requestId: "wq-1", to: "worker", workItem: "work-item-1" });
  // A queue is a durable save: it produced a real Message with a queued delivery
  // and touched no live edge, exactly like the CLI queue path.
  assert.equal(receipt.action, "queue");
  assert.equal(receipt.disposition, "queued");
  assert.equal(receipt.delivery.state, "queued");
  assert.equal(host.steers.length, 0);
  assert.equal(host.cancels.length, 0);
  const saved = store.listMessages("task-1").find(m => m.inputControl?.requestId === "wq-1");
  assert.ok(saved, "the queue persisted a real Message");
  assert.equal(saved.inputControl.action, "queue");
  assert.equal(saved.body, "--literal text, not a CLI option");
});

test("the Web surface steer records pending then performs the one live Host steer (gap F)", async t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  const run = store.getActiveRun("task-1", "worker");
  withRunBoundTurn(store, "worker", { runId: run.id, attemptId: "a-1", nativeTurnId: "t-1" });
  const host = fakeWebHostControl();
  const surface = createWebTaskSurface(store, { yuiHome: home }, [], host.port);
  const receipt = await surface.control("task-1", {
    action: "steer", body: "Prefer approach B now", requestId: "ws-1",
    expectedTarget: "t-1", to: "worker", workItem: "work-item-1" });
  assert.equal(receipt.action, "steer");
  assert.equal(receipt.disposition, "steered");
  assert.equal(receipt.steer.outcome, "accepted");
  // The one live edge ran exactly once, against the resolved exact Turn, with the
  // receiptId as the Provider request id — the identical call cli.ts performs.
  assert.equal(host.steers.length, 1);
  assert.equal(host.cancels.length, 0);
  const sent = host.steers[0];
  assert.equal(sent.control.type, "steer-turn");
  assert.equal(sent.control.nativeSessionId, "worker-native");
  assert.equal(sent.control.nativeTurnId, "t-1");
  assert.equal(sent.control.run.attemptId, `steer:task-1/${receipt.messageId}`);
  // The durable control op was recorded `pending` before the edge (message-5 gap D).
  const message = store.listMessages("task-1").find(m => m.id === receipt.messageId);
  assert.equal(message.control.receiptId, `steer:task-1/${receipt.messageId}`);
  assert.equal(message.control.requestId, "ws-1");
});

test("the Web surface reports a saved-but-not-steered failure without a live edge or fallback (gap F)", async t => {
  // An incapable plan saves the steer but resolution fails; the surface returns
  // the exact failure receipt and never falls back to a queue or an interrupt.
  const { store, home, command } = fixture(t, { leader: "codex", worker: "claude" });
  dispatchWorker(store, command, home, "claude");
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const host = fakeWebHostControl();
  const surface = createWebTaskSurface(store, { yuiHome: home }, [], host.port);
  const receipt = await surface.control("task-1", {
    action: "steer", body: "Prefer approach B now", requestId: "ws-1",
    expectedTarget: "t-1", to: "worker", workItem: "work-item-1" });
  assert.equal(receipt.action, "steer");
  assert.equal(receipt.steer.state, "not-steered");
  assert.equal(receipt.steer.code, "STEER_UNSUPPORTED");
  assert.equal(host.steers.length, 0, "an unsupported steer never reaches the live edge");
  assert.equal(host.cancels.length, 0);
});

test("the Web surface interrupt performs the one live Host cancel and claims a then-handoff (gap F)", async t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const saved = command(["message", "send", "task-1", "Do this next",
    "--to", "worker", "--work-item", "work-item-1"]);
  const activeRunId = store.getActiveRun("task-1", "worker").id;
  const host = fakeWebHostControl();
  const surface = createWebTaskSurface(store, { yuiHome: home }, [], host.port);
  const receipt = await surface.control("task-1", {
    action: "interrupt", role: "worker", expectedTarget: "t-1",
    thenMessage: `task-1/${saved.data.message.id}`, requestId: "wi-1" });
  assert.equal(receipt.action, "interrupt");
  assert.equal(receipt.disposition, "interrupt-unknown");
  assert.equal(receipt.interrupt.outcome, "cancel-requested");
  assert.equal(receipt.thenMessageId, saved.data.message.id);
  // The one live edge is a native cancel of the exact attempt, never a kill.
  assert.equal(host.cancels.length, 1);
  assert.equal(host.steers.length, 0);
  assert.equal(host.cancels[0].control.type, "cancel");
  assert.equal(host.cancels[0].control.attemptId, "a-1");
  // The then-handoff was claimed durably on the reused Message before the cancel.
  const message = store.listMessages("task-1").find(m => m.id === saved.data.message.id);
  assert.equal(message.interruptThen.targetRunId, activeRunId);
});

test("a Web steer whose live Host edge fails is delivery-unknown, not not-submitted, and keeps the Message (gap F)", async t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  const run = store.getActiveRun("task-1", "worker");
  withRunBoundTurn(store, "worker", { runId: run.id, attemptId: "a-1", nativeTurnId: "t-1" });
  const surface = createWebTaskSurface(store, { yuiHome: home }, [], {
    steer: async () => { throw new Error("host socket closed"); },
    cancel: async () => { throw new Error("unused"); }
  });
  await assert.rejects(surface.control("task-1", {
    action: "steer", body: "Prefer approach B now", requestId: "ws-1",
    expectedTarget: "t-1", to: "worker", workItem: "work-item-1" }),
    // Not a WebRequestRejected: the input committed, so it is delivery-unknown.
    (error) => error.disposition === undefined && /saved but the native steer did not complete/.test(error.message));
  // The Message and its pending control op survive; the failed edge does not roll
  // back a committed input, and there is no silent fallback to a queue.
  const message = store.listMessages("task-1").find(m => m.inputControl?.requestId === "ws-1");
  assert.ok(message, "the committed steer Message is retained");
  assert.equal(taskMessageInputControlState(message), "pending");
});

test("the Web control HTTP route drives the surface and rejects a malformed body (gap F)", async t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const host = fakeWebHostControl();
  const surface = createWebTaskSurface(store, { yuiHome: home }, [], host.port);
  const server = createYuiWebServer(store, { surface, token: "test-token" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const post = (body, token = "test-token") => fetch(`http://127.0.0.1:${port}/api/tasks/task-1/control`, {
    method: "POST", headers: { "content-type": "application/json", "x-yui-web-token": token },
    body: JSON.stringify(body) });
  // A well-formed queue drives the real surface through the HTTP edge.
  const ok = await post({ action: "queue", body: "Continue when free", requestId: "wq-1", to: "worker", workItem: "work-item-1" });
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.action, "queue");
  assert.equal(okBody.disposition, "queued");
  assert.equal(okBody.requestId, "wq-1");
  assert.ok(store.listMessages("task-1").some(m => m.inputControl?.requestId === "wq-1"));
  // An unknown field is a not-submitted rejection, never a silent default.
  const bad = await post({ action: "queue", body: "x", requestId: "wq-2", surprise: true });
  assert.equal(bad.status, 409);
  assert.equal((await bad.json()).disposition, "not-submitted");
  // An unknown action is rejected before any mutation.
  const badAction = await post({ action: "redirect", requestId: "wq-3" });
  assert.equal(badAction.status, 409);
  assert.equal((await badAction.json()).disposition, "not-submitted");
  // The token boundary still gates the control route.
  const noToken = await post({ action: "queue", body: "x", requestId: "wq-4" }, "wrong");
  assert.equal(noToken.status, 403);
});

test("Global Web inputs use the authenticated shared primitive and state reads never consume queue", async t => {
  const { store, home } = fixture(t);
  const agent = store.getConfiguredAgent("codex");
  store.createGlobalRoleIfAbsent(createGlobalRole("assistant", [createRoleAgentBinding(agent)], agent.id, home, at));
  const host = fakeWebHostControl();
  const surface = createWebTaskSurface(store, { yuiHome: home }, [], host.port);
  const server = createYuiWebServer(store, { surface, token: "global-web-token" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/roles/assistant/control`;
  const headers = { "content-type": "application/json", "x-yui-web-token": "global-web-token" };
  assert.equal((await fetch(url)).status, 403);
  const response = await fetch(url, { method: "POST", headers,
    body: JSON.stringify({ action: "queue", body: "--literal global input", requestId: "global-web-1" }) });
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.delivery.state, "queued");
  assert.equal(receipt.message.roleName, "assistant");
  assert.equal(receipt.message.body, "--literal global input");
  const before = store.listGlobalRoleMessages("assistant");
  const state = await (await fetch(url, { headers })).json();
  assert.equal(state.messages[0].id, before[0].id);
  assert.deepEqual(store.listGlobalRoleMessages("assistant"), before);
  assert.equal(host.steers.length + host.cancels.length, 0);
  const bad = await fetch(url, { method: "POST", headers,
    body: JSON.stringify({ action: "queue", body: "x", requestId: "global-web-2", caller: "operator" }) });
  assert.equal(bad.status, 409);
  assert.equal((await bad.json()).disposition, "not-submitted");
  assert.equal(store.listGlobalRoleMessages("assistant").length, 1);
});

// ---------------------------------------------------------------------------
// Gap G (message-5): the live edge must report the ACTUAL decision-3 §7
// acceptance, not presume success. The static resolver is only the pre-flight
// gate; whether the Provider took the steer, or whether a cancel proved a stop,
// is the live `control.outcome`/`control.cancellation`. `foldSteerLiveReceipt`
// and `foldInterruptLiveReceipt` are the single shared classifier used by every
// edge — CLI Task, CLI Global, and the Web surface — so both are unit-tested
// exhaustively here, then the Web wiring is proven end-to-end with a fake Host
// that returns non-success outcomes. There is no fourth action and no fallback:
// a non-delivered steer or an unproven cancel is REPORTED, never retried.

const hostSnapshot = (detail) => ({
  protocol: "yui-agent-host/v5", state: "ready", nativeSessionId: "worker-native",
  ...(detail === undefined ? {} : { detail }) });
const steerControl = (outcome, extra = {}) => ({
  protocol: "yui-agent-host/v5", outcome, snapshot: hostSnapshot(), ...extra });
const cancelControl = (cancellation, extra = {}) => ({
  protocol: "yui-agent-host/v5", outcome: "cancel-requested", snapshot: hostSnapshot(),
  ...(cancellation === undefined ? {} : { cancellation }), ...extra });

test("foldSteerLiveReceipt maps only accepted to steered; pending is delivery-unknown (gap G)", () => {
  // Accepted is the one proven delivery.
  assert.deepEqual(foldSteerLiveReceipt(steerControl("accepted")),
    { state: "steered", outcome: "accepted" });
  // Pending is delivery-unknown, NOT success: the Host holds it but the Provider
  // has not proven acceptance. The durable fold resolves it later.
  assert.deepEqual(foldSteerLiveReceipt(steerControl("pending")),
    { state: "steer-unknown", outcome: "pending" });
  // Rejected did not deliver.
  assert.deepEqual(foldSteerLiveReceipt(steerControl("rejected")),
    { state: "steer-rejected", outcome: "rejected" });
  // Any other outcome (busy/status/cancel-requested) means the Host could not run
  // the steer — reported faithfully, never flattened to steered.
  assert.deepEqual(foldSteerLiveReceipt(steerControl("busy")),
    { state: "steer-unavailable", outcome: "busy" });
});

test("foldSteerLiveReceipt carries a redacted failure/snapshot detail on non-success (gap G)", () => {
  // A structured failure detail wins over the snapshot detail.
  assert.equal(foldSteerLiveReceipt(steerControl("rejected",
    { failure: { detail: "provider refused", phase: "turn-submit", inputDisposition: "not-accepted" } })).detail,
    "provider refused");
  // Otherwise the snapshot detail is surfaced so the operator sees the cause.
  assert.equal(foldSteerLiveReceipt({
    protocol: "yui-agent-host/v5", outcome: "pending", snapshot: hostSnapshot("still settling") }).detail,
    "still settling");
  // A clean accepted receipt carries no detail noise.
  assert.equal(foldSteerLiveReceipt(steerControl("accepted")).detail, undefined);
});

test("interrupt receipt distinguishes a cancellation request from a proven stop", () => {
  assert.deepEqual(
    foldInterruptLiveReceipt(cancelControl({ status: "requested", resources: "unknown" })),
    { state: "interrupt-requested", outcome: "cancel-requested",
      cancellation: { status: "requested", resources: "unknown" } });
  // No active Turn to stop: reported distinctly, cancellation retained.
  assert.deepEqual(
    foldInterruptLiveReceipt(cancelControl({ status: "not-active", resources: "unknown" })),
    { state: "interrupt-not-active", outcome: "cancel-requested",
      cancellation: { status: "not-active", resources: "unknown" } });
  // Stop could not be proven.
  assert.deepEqual(
    foldInterruptLiveReceipt(cancelControl({ status: "unknown", resources: "unknown" })),
    { state: "interrupt-unknown", outcome: "cancel-requested",
      cancellation: { status: "unknown", resources: "unknown" } });
});

test("interrupt receipt without cancellation evidence remains unknown", () => {
  assert.deepEqual(foldInterruptLiveReceipt(cancelControl(undefined)),
    { state: "interrupt-unknown", outcome: "cancel-requested" });
  // An outcome that is not cancel-requested at all means the cancel edge could
  // not run; surface it (with detail) rather than claim an interrupt.
  assert.deepEqual(foldInterruptLiveReceipt({
    protocol: "yui-agent-host/v5", outcome: "busy", snapshot: hostSnapshot("host busy") }),
    { state: "interrupt-unavailable", outcome: "busy", detail: "host busy" });
});

/** A fake Host control port whose outcomes are configurable, so a rejected steer
 * or an unproven cancel can be driven through the real Web surface without a
 * Provider. It still records every control it was asked to perform. */
function scriptedWebHostControl(steerResult, cancelResult) {
  const steers = [];
  const cancels = [];
  return {
    steers, cancels,
    port: {
      steer: async (input) => { steers.push(input); return steerResult; },
      cancel: async (input) => { cancels.push(input); return cancelResult; }
    }
  };
}

test("a Web steer the Provider rejects reports steer-rejected and keeps the Message (gap G)", async t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  const run = store.getActiveRun("task-1", "worker");
  withRunBoundTurn(store, "worker", { runId: run.id, attemptId: "a-1", nativeTurnId: "t-1" });
  const host = scriptedWebHostControl(
    steerControl("rejected", { failure: { detail: "turn already closed", phase: "turn-submit", inputDisposition: "not-accepted" } }),
    cancelControl({ status: "requested", resources: "unknown" }));
  const surface = createWebTaskSurface(store, { yuiHome: home }, [], host.port);
  const receipt = await surface.control("task-1", {
    action: "steer", body: "Prefer approach B now", requestId: "ws-1",
    expectedTarget: "t-1", to: "worker", workItem: "work-item-1" });
  // The live edge ran once, but the receipt reflects the real non-delivery — not
  // a hardcoded "steered" — and preserves the cause. No fallback to queue.
  assert.equal(host.steers.length, 1);
  assert.equal(receipt.disposition, "steer-rejected");
  assert.equal(receipt.steer.state, "steer-rejected");
  assert.equal(receipt.steer.outcome, "rejected");
  assert.equal(receipt.steer.detail, "turn already closed");
  // The committed Message and its pending control op survive an undelivered steer.
  const message = store.listMessages("task-1").find(m => m.inputControl?.requestId === "ws-1");
  assert.ok(message, "the committed steer Message is retained");
  assert.equal(taskMessageInputControlState(message), "pending");
});

test("a Web steer the Host holds as pending reports delivery-unknown, not steered (gap G)", async t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  const run = store.getActiveRun("task-1", "worker");
  withRunBoundTurn(store, "worker", { runId: run.id, attemptId: "a-1", nativeTurnId: "t-1" });
  const host = scriptedWebHostControl(steerControl("pending"), cancelControl());
  const surface = createWebTaskSurface(store, { yuiHome: home }, [], host.port);
  const receipt = await surface.control("task-1", {
    action: "steer", body: "Prefer approach B now", requestId: "ws-1",
    expectedTarget: "t-1", to: "worker", workItem: "work-item-1" });
  assert.equal(host.steers.length, 1);
  assert.equal(receipt.disposition, "steer-unknown");
  assert.equal(receipt.steer.outcome, "pending");
});

test("a Web interrupt whose cancel proves no active Turn reports interrupt-not-active (gap G)", async t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const saved = command(["message", "send", "task-1", "Do this next",
    "--to", "worker", "--work-item", "work-item-1"]);
  const host = scriptedWebHostControl(steerControl("accepted"),
    cancelControl({ status: "not-active", resources: "unknown" }));
  const surface = createWebTaskSurface(store, { yuiHome: home }, [], host.port);
  const receipt = await surface.control("task-1", {
    action: "interrupt", role: "worker", expectedTarget: "t-1",
    thenMessage: `task-1/${saved.data.message.id}`, requestId: "wi-1" });
  // The one live cancel ran, but its cancellation.status proves nothing stopped;
  // the receipt reflects that and carries the stop-proof rather than "interrupted".
  assert.equal(host.cancels.length, 1);
  assert.equal(receipt.disposition, "interrupt-not-active");
  assert.equal(receipt.interrupt.state, "interrupt-not-active");
  assert.equal(receipt.interrupt.cancellation.status, "not-active");
  // The then-handoff was still claimed durably before the cancel — it is delivered
  // once by the ordinary continuation path after a proven terminal, independent of
  // this cancel's outcome, and is neither re-driven nor dropped here.
  assert.equal(receipt.thenMessageId, saved.data.message.id);
  const message = store.listMessages("task-1").find(m => m.id === saved.data.message.id);
  assert.ok(message.interruptThen, "the then-handoff claim is retained regardless of the cancel outcome");
});

// ---------------------------------------------------------------------------
// Gap H (message-5): join the real live edge to the durable chain. The steer
// fold (real FileSchedulerStoreAdapter) and the interrupt-then release (real
// prepareMessageContinuations) are each proven above, and the real
// BuiltinAgentEndpoint cancel contract is proven in isolation. This closes the
// last synthetic seam: the SAME real Endpoint cancel — over a fake Driver, no
// Provider, no subprocess — produces the terminal that the durable interrupt-then
// handoff actually waits on. A proven-quiescent cancel releases the handoff once
// through the ordinary continuation path; an unproven (`unknown`) cancel does
// not, and is never replayed. This is the whole authorized chain: CLI interrupt
// (durable claim) → live Endpoint cancel (real terminal) → continuation release.

/** Settle the Worker's durable Turn from a REAL Endpoint cancellation terminal,
 * rather than a hand-made status. The Endpoint proved (or could not prove) the
 * stop; this carries that exact fact into the durable binding the continuation
 * path reads, so the release gate is driven by the live edge's own proof. */
function settleWorkerFromEndpointTerminal(store, run, cancellation, when) {
  // A proven-quiescent cancel carries the original Turn's terminal; an unproven
  // one carries none, so the durable Run is only terminalized when the Endpoint
  // actually proved the stop — exactly the §4 release precondition.
  if (cancellation.status !== "requested" || cancellation.terminal === undefined) return false;
  store.saveRun(failRun(run, "cancelled", "worker cancelled (endpoint-proven)", when));
  store.clearActiveRun("task-1", "worker");
  const settled = settleProviderTurn(store.getTaskRoleSessionSet("task-1", "worker").providerBinding,
    { nativeTurnId: "t-1", status: "cancelled", settledAt: when.toISOString() });
  store.saveTaskRoleSessionSet(updateTaskRoleProviderRuntime(
    store.getTaskRoleSessionSet("task-1", "worker"), settled, when));
  return true;
}

test("a real Endpoint cancel that proves a quiescent stop releases the durable interrupt-then handoff once (gap H)", async t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const target = readyWorkerContinuation(store);
  const handoff = command(["message", "send", "task-1", "Do this after the stop",
    "--to", "worker", "--work-item", "work-item-1"]);
  // Authorized CLI entry: the interrupt claims the durable then-handoff on the
  // exact attempt, before any live edge runs (decision-3 §4).
  const interrupt = command(["role", "interrupt", "task-1", "worker", "--expected-target", "t-1",
    "--then-message", `task-1/${handoff.data.message.id}`, "--request-id", "i-1"]);
  assert.equal(interrupt.kind, "input-interrupt");
  assert.equal(store.listMessages("task-1").find(m => m.id === handoff.data.message.id)
    .interruptThen.targetRunId, target.id);

  // The one live edge: a REAL BuiltinAgentEndpoint cancel over a fake Driver that
  // reports `requested` and, once the Turn goes quiescent, proves the terminal.
  const fake = fakeEndpoint("requested");
  const { session: endpoint } = await fake.factory.open(fake.payload);
  await endpoint.submit({ attemptId: "a-1", boundedText: "go", inputRef: `task-1/${handoff.data.message.id}` });
  fake.emitTerminal("a-1");
  fake.clearActiveTurn();
  const outcome = await endpoint.cancel("a-1");
  // The live edge proved a quiescent stop (this is foldInterruptLiveReceipt's
  // `interrupted` case) and carries the original Turn's terminal fact.
  assert.equal(outcome.status, "requested");
  assert.equal(outcome.terminal.attemptId, "a-1");

  // Phase 1 — before the durable terminal folds, the handoff is HELD: the live
  // cancel request alone never releases a continuation.
  const runsBefore = store.listRuns("task-1").length;
  prepareMessageContinuations(store, "task-1", later, "worker");
  assert.equal(store.listRuns("task-1").length, runsBefore);
  assert.equal(store.listMessages("task-1").find(m => m.id === handoff.data.message.id).continuation?.runId, undefined);

  // Phase 2 — the Endpoint's own proven terminal settles the durable Run, and the
  // ordinary continuation path releases the handoff exactly once, same Session.
  assert.equal(settleWorkerFromEndpointTerminal(store, target, outcome, evenLater), true);
  prepareMessageContinuations(store, "task-1", evenLater, "worker");
  const created = store.listRuns("task-1").filter(r => r.id !== target.id);
  assert.equal(created.length, 1, "the proven terminal releases exactly one continuation Run");
  assert.deepEqual(created[0].inputs[0].input.deltaRefIds, [handoff.data.message.id]);
  assert.equal(store.listMessages("task-1").find(m => m.id === handoff.data.message.id).continuation?.runId, created[0].id);
  // Idempotent: a second reconcile pass never delivers the handoff twice.
  prepareMessageContinuations(store, "task-1", evenLater, "worker");
  assert.equal(store.listRuns("task-1").filter(r => r.id !== target.id).length, 1);
});

test("a real Endpoint cancel that cannot prove a stop holds the durable handoff, never released or replayed (gap H)", async t => {
  const { store, home, command } = fixture(t);
  dispatchWorker(store, command, home);
  withControllerTurn(store, "worker", { attemptId: "a-1", nativeTurnId: "t-1" });
  const target = readyWorkerContinuation(store);
  const handoff = command(["message", "send", "task-1", "Do this after the stop",
    "--to", "worker", "--work-item", "work-item-1"]);
  command(["role", "interrupt", "task-1", "worker", "--expected-target", "t-1",
    "--then-message", `task-1/${handoff.data.message.id}`, "--request-id", "i-1"]);

  // The REAL Endpoint cancel sees a terminal but a still-active Turn: not
  // quiescent, so it returns `unknown` — foldInterruptLiveReceipt's
  // `interrupt-unknown`, which proves no stop.
  const fake = fakeEndpoint("requested");
  const { session: endpoint } = await fake.factory.open(fake.payload);
  await endpoint.submit({ attemptId: "a-1", boundedText: "go", inputRef: `task-1/${handoff.data.message.id}` });
  fake.emitTerminal("a-1");
  const outcome = await endpoint.cancel("a-1");
  assert.equal(outcome.status, "unknown");

  // An unproven cancel never terminalizes the durable Run, so the release gate is
  // never opened: the handoff stays held and is not replayed across the boundary.
  assert.equal(settleWorkerFromEndpointTerminal(store, target, outcome, evenLater), false);
  const runsBefore = store.listRuns("task-1").length;
  prepareMessageContinuations(store, "task-1", evenLater, "worker");
  assert.equal(store.listRuns("task-1").length, runsBefore);
  assert.equal(store.listMessages("task-1").find(m => m.id === handoff.data.message.id).continuation?.runId, undefined);
});
