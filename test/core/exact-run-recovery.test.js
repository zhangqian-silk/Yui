import assert from "node:assert/strict";
import test from "node:test";

import {
  recoverExactAgentRun
} from "../../dist/lifecycle/exactRunTerminalization.js";
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
