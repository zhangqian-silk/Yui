import assert from "node:assert/strict";
import test from "node:test";

import {
  recoverExactAgentRun
} from "../../dist/lifecycle/exactRunTerminalization.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import {
  createRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../../dist/role/role.js";
import { testEffectiveLaunch } from "../helpers/effectiveLaunch.js";
import {
  RUN_RECOVERY_REQUESTED_EVENT
} from "../../dist/scheduler/roleRunStall.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";

const NOW = new Date("2026-08-05T01:00:00.000Z");
const PROGRESS = "2026-08-05T00:00:00.000Z";

test("exact diagnosis is idempotent and leaves provider/session state untouched", () => {
  const store = recoveryStore();
  const input = recoveryInput({ action: "diagnose" });

  const first = recoverExactAgentRun(store, input);
  const second = recoverExactAgentRun(store, input);

  assert.equal(first.disposition, "applied");
  assert.equal(first.requiresExplicitFollowup, true);
  assert.equal(second.disposition, "applied");
  assert.equal(store.events.filter((event) => event.type === RUN_RECOVERY_REQUESTED_EVENT).length, 1);
  assert.equal(store.run.status, "active");
  assert.deepEqual(store.session, {
    agentId: "agent-1",
    adapterId: "codex",
    nativeSessionId: "native-1",
    launchId: "launch-1",
    status: "running",
    updatedAt: PROGRESS
  });
});

test("ambiguous provider acceptance blocks retry while allowing diagnosis", () => {
  const store = recoveryStore();

  const blocked = recoverExactAgentRun(store, recoveryInput({
    action: "retry",
    providerAcceptance: "ambiguous"
  }));
  assert.equal(blocked.disposition, "blocked");
  assert.equal(blocked.reason, "provider-acceptance-ambiguous");
  assert.equal(store.events.length, 0);

  const diagnostic = recoverExactAgentRun(store, recoveryInput({
    action: "diagnose",
    providerAcceptance: "ambiguous"
  }));
  assert.equal(diagnostic.disposition, "applied");
  assert.equal(store.events.length, 1);
});

test("provider acceptance must match the durable delivery boundary", () => {
  const undelivered = recoveryStore();
  delete undelivered.run.deliveredAt;
  const accepted = recoverExactAgentRun(undelivered, recoveryInput({
    providerAcceptance: "accepted"
  }));
  assert.equal(accepted.disposition, "blocked");
  assert.equal(accepted.reason, "provider-acceptance-mismatch");

  const delivered = recoveryStore();
  const rejected = recoverExactAgentRun(delivered, recoveryInput({
    providerAcceptance: "rejected"
  }));
  assert.equal(rejected.disposition, "blocked");
  assert.equal(rejected.reason, "provider-acceptance-mismatch");
});

test("recovery uses progress, native Session, and launch CAS fences", () => {
  const store = recoveryStore();

  store.events.push(createTaskEvent(
    "event-1",
    "task-1",
    "run.progress",
    { runId: "run-1", progressAt: "2026-08-05T00:30:00.000Z" },
    new Date("2026-08-05T00:30:00.000Z")
  ));
  const staleProgress = recoverExactAgentRun(store, recoveryInput());
  assert.equal(staleProgress.disposition, "state-changed");
  assert.equal(staleProgress.reason, "progress-fence-mismatch");

  const staleSession = recoverExactAgentRun(store, recoveryInput({
    expectedProgressAt: "2026-08-05T00:30:00.000Z",
    nativeSessionId: "native-old"
  }));
  assert.equal(staleSession.disposition, "state-changed");
  assert.equal(staleSession.reason, "session-or-launch-fence-mismatch");

  const staleLaunch = recoverExactAgentRun(store, recoveryInput({
    expectedProgressAt: "2026-08-05T00:30:00.000Z",
    launchId: "launch-old"
  }));
  assert.equal(staleLaunch.disposition, "state-changed");
  assert.equal(staleLaunch.reason, "session-or-launch-fence-mismatch");
  assert.equal(store.events.filter((event) => event.type === RUN_RECOVERY_REQUESTED_EVENT).length, 0);
});

test("an opaque Session accepts every explicit recovery action with its exact launch fence", () => {
  for (const action of ["diagnose", "retry", "replace-session"]) {
    const store = opaqueRecoveryStore();
    const result = recoverExactAgentRun(store, opaqueRecoveryInput({ action }));
    assert.equal(result.disposition, "applied", action);
    assert.equal(result.action, action);
  }
  const terminalStore = opaqueTerminalRecoveryStore();
  const terminal = recoverExactAgentRun(
    terminalStore,
    opaqueRecoveryInput({
      action: "terminate",
      runId: "agent-run-1"
    })
  );
  assert.equal(terminal.disposition, "applied");
  assert.equal(terminalStore.run.status, "failed");
  assert.equal(terminalStore.getActiveAgentRun(), null);
});

test("opaque recovery remains fail-closed for every Session identity boundary", () => {
  const cases = [
    { name: "missing launch", input: { launchId: undefined } },
    { name: "wrong launch", input: { launchId: "launch-old" } },
    { name: "wrong agent", input: { agentId: "agent-old" } },
    { name: "wrong adapter", input: { adapterId: "claude" } },
    { name: "wrong task", input: { taskId: "task-old" } },
    { name: "wrong role", input: { roleName: "worker" } },
    { name: "wrong run", input: { runId: "run-old" } },
    { name: "wrong progress", input: { expectedProgressAt: "2026-08-05T00:01:00.000Z" } }
  ];
  for (const { name, input } of cases) {
    const store = opaqueRecoveryStore();
    if (input.taskId !== undefined && input.taskId !== "task-1") {
      store.getTask = () => null;
    }
    if (input.runId !== undefined && input.runId !== "run-1") {
      store.getAgentRun = () => null;
    }
    const result = recoverExactAgentRun(store, opaqueRecoveryInput(input));
    assert.equal(result.disposition, "state-changed", name);
    assert.equal(store.events.length, 0, name);
  }

  for (const status of ["stopped", "broken"]) {
    const store = opaqueRecoveryStore();
    store.session.status = status;
    const result = recoverExactAgentRun(store, opaqueRecoveryInput({ action: "diagnose" }));
    assert.equal(result.disposition, "state-changed", status);
    assert.equal(result.reason, "session-or-launch-fence-mismatch", status);
  }
  const mismatchedSession = opaqueRecoveryStore();
  mismatchedSession.session.adapterId = "claude";
  const mismatched = recoverExactAgentRun(
    mismatchedSession,
    opaqueRecoveryInput({ action: "diagnose" })
  );
  assert.equal(mismatched.disposition, "state-changed");
  assert.equal(mismatched.reason, "session-or-launch-fence-mismatch");
});

test("the recovery CLI carries an opaque Session's launch fence and rejects a wrong launch", () => {
  const options = {
    now: () => NOW,
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: "task-1",
      YUI_ROLE: "leader"
    }
  };
  const store = opaqueRecoveryStore();
  store.run.id = "agent-run-1";
  const applied = runTaskCommand([
    "run", "recover", "task-1/agent-run-1",
    "--action", "diagnose",
    "--expected-progress-at", PROGRESS,
    "--provider-acceptance", "accepted",
    "--launch-id", "launch-1",
    "--reason", "Inspect the opaque host."
  ], store, options);
  assert.equal(applied.kind, "output");
  assert.match(applied.output, /Recorded exact diagnose recovery/u);

  const wrongLaunch = opaqueRecoveryStore();
  wrongLaunch.run.id = "agent-run-1";
  assert.throws(
    () => runTaskCommand([
      "run", "recover", "task-1/agent-run-1",
      "--action", "diagnose",
      "--expected-progress-at", PROGRESS,
      "--provider-acceptance", "accepted",
      "--launch-id", "launch-old",
      "--reason", "Do not guess the host identity."
    ], wrongLaunch, options),
    /Exact Run recovery state-changed: session-or-launch-fence-mismatch/u
  );
});

function recoveryInput(overrides = {}) {
  return {
    taskId: "task-1",
    roleName: "leader",
    runId: "run-1",
    agentId: "agent-1",
    adapterId: "codex",
    nativeSessionId: "native-1",
    launchId: "launch-1",
    expectedProgressAt: PROGRESS,
    providerAcceptance: "accepted",
    action: "diagnose",
    reason: "pane is live but has no durable progress",
    now: NOW,
    ...overrides
  };
}

function recoveryStore() {
  const task = { id: "task-1", status: "active" };
  const role = {
    taskId: task.id,
    name: "leader",
    activeAgentId: "agent-1",
    adapterId: "codex",
    status: "running"
  };
  const run = {
    schemaVersion: 4,
    id: "run-1",
    taskId: task.id,
    roleName: role.name,
    mode: "new",
    input: "work",
    purpose: "execution",
    status: "active",
    createdAt: PROGRESS,
    deliveredAt: PROGRESS,
    updatedAt: PROGRESS,
    workItemId: "work-1",
    effective: {
      agentId: "agent-1",
      adapterId: "codex",
      input: "work"
    }
  };
  const session = {
    agentId: "agent-1",
    adapterId: "codex",
    nativeSessionId: "native-1",
    launchId: "launch-1",
    status: "running",
    updatedAt: PROGRESS
  };
  return {
    task,
    role,
    run,
    session,
    events: [],
    transaction(execute) { return execute(this); },
    getTask() { return this.task; },
    getAgentRun() { return this.run; },
    getRole() { return this.role; },
    getActiveAgentRun() { return this.run; },
    getTaskRoleSessionSet() { return { activeAgentId: "agent-1", sessions: { "agent-1": this.session } }; },
    getWorkMailbox() { return null; },
    getWorkItem() { return null; },
    listEvents() { return this.events; },
    nextEventId() { return `event-${this.events.length + 1}`; },
    saveEvent(_taskId, event) { this.events.push(event); }
  };
}

function opaqueRecoveryStore() {
  const store = recoveryStore();
  delete store.session.nativeSessionId;
  return store;
}

function opaqueRecoveryInput(overrides = {}) {
  const input = recoveryInput({
    nativeSessionId: undefined,
    ...overrides
  });
  delete input.nativeSessionId;
  return input;
}

function opaqueTerminalRecoveryStore() {
  const store = recoveryStore();
  const agent = createConfiguredAgent("agent-1", "codex", "codex", [], [], NOW);
  store.task = { id: "task-1", status: "active" };
  store.role = updateRoleStatus(
    createRole(
      "task-1",
      "leader",
      [createRoleAgentBinding(agent)],
      "agent-1",
      "/tmp/work",
      NOW
    ),
    "running",
    NOW
  );
  store.run = {
    ...store.run,
    id: "agent-run-1",
    effective: testEffectiveLaunch({
      agentId: "agent-1",
      adapterId: "codex",
      roleName: "leader",
      workspaceRoot: "/tmp/work"
    })
  };
  store.session = {
    schemaVersion: 3,
    agentId: "agent-1",
    adapterId: "codex",
    launchId: "launch-1",
    policy: "fixed",
    effective: store.run.effective,
    status: "running",
    recentCompletedTurnIds: [],
    createdAt: PROGRESS,
    updatedAt: PROGRESS
  };
  const sessionSet = {
    schemaVersion: 4,
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    activeAgentId: "agent-1",
    sessions: { "agent-1": store.session },
    inFlight: null,
    pendingTurnCompletion: null,
    updatedAt: PROGRESS
  };
  let active = store.run;
  let mailbox = {
    pending: {
      requestCount: 1,
      refs: [{ type: "run", taskId: "task-1", id: "agent-run-1" }]
    },
    processing: null
  };
  store.getAgentRun = (_taskId, runId) => runId === store.run.id ? store.run : null;
  store.getActiveAgentRun = () => active;
  store.getTaskRoleSessionSet = () => sessionSet;
  store.getWorkMailbox = () => mailbox;
  store.saveWorkMailbox = (value) => { mailbox = value; };
  store.saveAgentRun = (value) => { store.run = value; };
  store.clearActiveAgentRun = () => { active = null; };
  store.saveRole = (_taskId, value) => { store.role = value; };
  store.saveTaskRoleSessionSet = (value) => { store.session = value.sessions["agent-1"]; };
  store.getOperatorNotification = () => null;
  store.clearOperatorNotification = () => {};
  return store;
}
