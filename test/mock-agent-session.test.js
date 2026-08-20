import assert from "node:assert/strict";
import test from "node:test";

import { CommandExecutionError } from "../dist/tmux/commandExecutor.js";
import {
  createMockAgentSession,
  isExplicitTmuxResourceAbsenceError
} from "./helpers/mockAgentSession.mjs";
import { MOCK_TRANSPORT_DISCLAIMER } from "./helpers/testTiers.js";

test("Mock Session cleanup classifies only explicit tmux absence", () => {
  assert.equal(isExplicitTmuxResourceAbsenceError(
    new CommandExecutionError("COMMAND_FAILED", 1, "can't find window: worker")
  ), true);
  assert.equal(isExplicitTmuxResourceAbsenceError(
    new CommandExecutionError("COMMAND_FAILED", 1, "no server running on /tmp/tmux/yui-test")
  ), true);
  assert.equal(isExplicitTmuxResourceAbsenceError(
    new CommandExecutionError(
      "COMMAND_FAILED",
      1,
      "error connecting to /tmp/tmux/yui-test (No such file or directory)"
    )
  ), true);
  assert.equal(isExplicitTmuxResourceAbsenceError(
    new CommandExecutionError("COMMAND_FAILED", 1, "no current target")
  ), true);
  assert.equal(isExplicitTmuxResourceAbsenceError(
    new CommandExecutionError("COMMAND_FAILED", 1, "session not found: worker")
  ), true);
  assert.equal(isExplicitTmuxResourceAbsenceError(
    new CommandExecutionError("COMMAND_FAILED", 1, "")
  ), false);
  assert.equal(isExplicitTmuxResourceAbsenceError(
    new CommandExecutionError("COMMAND_FAILED", 1, "permission denied")
  ), false);
  assert.equal(isExplicitTmuxResourceAbsenceError(
    new CommandExecutionError("COMMAND_NOT_FOUND", undefined, "no server running")
  ), false);
  assert.equal(isExplicitTmuxResourceAbsenceError(new Error("can't find window")), false);
});

test("normal Mock Agent Session separates tmux transport from provider acceptance", async (t) => {
  const session = await createMockAgentSession(t, { scenario: "normal" });

  const started = await session.waitForObservation("process-started");
  assert.equal(session.processCommand, process.execPath);
  assert.equal(session.modelCalled, false);
  assert.equal(started.yuiHome, session.home);
  assert.equal(started.taskId, "task-mock");
  assert.equal(started.roleName, "worker");
  assert.equal(started.adapterId, "claude");
  assert.equal(started.nativeSessionId, session.nativeSessionId);
  assert.ok(Number.isSafeInteger(started.processId) && started.processId > 0);
  assert.ok(session.home.startsWith(`${session.ownedRoot}/`));
  await session.waitForEvent("session-start");
  session.drainEvents();
  assert.equal(session.inputSubmittedAtLaunch, true);
  assert.notEqual(session.currentRun().pushedAt, undefined);
  assert.equal(session.currentRun().deliveredAt, undefined);

  await session.waitForEvent("prompt-accepted");
  session.drainEvents();
  assert.notEqual(session.currentRun().deliveredAt, undefined);
  assert.equal((await session.waitForObservation("complete")).nativeSessionId, session.nativeSessionId);
  assert.equal(await session.waitForState("stopped"), "stopped");
});

test("transport-only Mock Agent Session never claims provider acceptance", async (t) => {
  const session = await createMockAgentSession(t, { scenario: "transport-only" });

  await session.waitForEvent("session-start");
  session.drainEvents();
  assert.equal(session.inputSubmittedAtLaunch, true);
  assert.notEqual(session.currentRun().pushedAt, undefined);

  const observation = await session.waitForObservation("transport-received");
  assert.equal(observation.nativeSessionId, session.nativeSessionId);
  assert.equal(session.inboxEvents().some((event) => (
    event.type === "runtime-observation"
    && event.observation.kind === "turn.accepted"
  )), false);
  assert.equal(session.currentRun().deliveredAt, undefined);
});

test("no-progress Mock Agent Session stays observable until exact teardown", async (t) => {
  const session = await createMockAgentSession(t, { scenario: "no-progress" });

  const started = await session.waitForObservation("process-started");
  assert.equal(started.nativeSessionId, session.nativeSessionId);
  assert.equal(await session.inspect(), "running");
  await session.expectNoRuntimeEvents(100);
  assert.notEqual(session.currentRun().pushedAt, undefined);
  assert.equal(session.currentRun().deliveredAt, undefined);

  await session.teardown();
  assert.equal(session.ownedRootExists(), false);
});

test("crashed Mock Agent Session exits visibly without forging lifecycle progress", async (t) => {
  const session = await createMockAgentSession(t, { scenario: "crash" });

  const crashed = await session.waitForObservation("crash");
  assert.equal(crashed.exitCode, 23);
  assert.equal(await session.waitForState("stopped"), "stopped");
  assert.deepEqual(session.inboxEvents(), []);
  assert.notEqual(session.currentRun().pushedAt, undefined);
  assert.equal(session.currentRun().deliveredAt, undefined);
});

test("StopFailure reaches the supported hook and terminalizes only the exact Run", async (t) => {
  const session = await createMockAgentSession(t, { scenario: "stop-failure" });

  await session.waitForEvent("stop-failure");
  const drained = session.drainEvents();
  assert.deepEqual(drained.failed, []);
  assert.equal(session.currentRun().status, "failed");
  assert.match(session.currentRun().summary, /mock_stop_failure/);
  assert.equal(session.currentWorkItem().status, "failed");
  const observed = await session.waitForObservation("stop-failure");
  assert.equal(observed.exitCode, 70);
});

test("a late Mock Agent event cannot cross into a successor launch generation", async (t) => {
  const session = await createMockAgentSession(t, {
    scenario: "late-event",
    delayMs: 300
  });

  await session.waitForEvent("session-start");
  session.drainEvents();
  await session.waitForObservation("transport-received");

  const successor = session.advanceGeneration();
  const rejected = await session.waitForHook("UserPromptSubmit");
  assert.notEqual(rejected.exitCode, 0);
  assert.match(rejected.stderr, /does not match|no matching|not current/i);
  assert.equal(session.inboxEvents().some((event) => (
    event.type === "runtime-observation"
    && event.observation.kind === "turn.accepted"
  )), false);
  assert.equal(session.activeRun().id, successor.id);
  assert.equal(session.activeRun().deliveredAt, undefined);
});

test("Mock Agent evidence becomes cleanup-success only after exact teardown", async (t) => {
  const session = await createMockAgentSession(t, { scenario: "no-progress" });

  await session.waitForObservation("process-started");
  const running = session.evidenceSnapshot();
  assert.equal(running.tier, "mock-agent-session");
  assert.equal(running.sessionCreated, true);
  assert.equal(running.modelCalled, false);
  assert.equal(running.providerAccepted, false);
  assert.equal(running.binarySource, process.execPath);
  assert.equal(running.yuiHome, session.home);
  assert.equal(running.workspace, session.workspace);
  assert.equal(running.namespaceOwnership.kind, "ephemeral-test");
  assert.equal(running.namespaceOwnership.home, session.home);
  assert.equal(running.namespaceOwnership.tmuxServer, session.tmuxServer);
  assert.equal(running.namespaceOwnership.token, session.ownershipToken);
  assert.equal(running.cleanupOutcome, "pending");
  assert.deepEqual(
    running.checks.filter(({ name }) => [
      "controller-runtime",
      "provider-e2e",
      "release-e2e"
    ].includes(name)).map(({ name, outcome }) => ({ name, outcome })),
    [
      { name: "controller-runtime", outcome: "not-started" },
      { name: "provider-e2e", outcome: "not-run" },
      { name: "release-e2e", outcome: "not-run" }
    ]
  );
  assert.ok(running.verificationGaps.includes(MOCK_TRANSPORT_DISCLAIMER));

  await session.teardown();

  const cleaned = session.evidenceSnapshot();
  assert.equal(session.ownedRootExists(), false);
  assert.equal(cleaned.cleanupOutcome, "success");
  assert.match(cleaned.cleanupDetail, /exact runtime teardown completed; owned root removed/u);
  assert.match(session.evidenceReport(), /Tier: Mock Agent Session \(mock-agent-session\)/u);
  assert.match(session.evidenceReport(), /Provider-native acceptance proven: no/u);
  assert.match(session.evidenceReport(), /Cleanup: success/u);
  assert.match(session.evidenceReport(), new RegExp(MOCK_TRANSPORT_DISCLAIMER.replaceAll(".", "\\."), "u"));
});

test("Mock Agent teardown records a cleanup error before surfacing it", async (t) => {
  const session = await createMockAgentSession(t, {
    scenario: "no-progress",
    teardownFault: new Error("injected exact-teardown failure")
  });

  await session.waitForObservation("process-started");
  await assert.rejects(session.teardown(), /injected exact-teardown failure/u);

  const evidence = session.evidenceSnapshot();
  assert.equal(session.ownedRootExists(), false);
  assert.equal(evidence.cleanupOutcome, "error");
  assert.match(evidence.cleanupDetail, /injected exact-teardown failure/u);
  assert.match(session.evidenceReport(), /Cleanup: error/u);
});

test("explicit tmux absence converges only after exact Mock Session teardown", async (t) => {
  const session = await createMockAgentSession(t, {
    scenario: "no-progress",
    stopFault: new CommandExecutionError(
      "COMMAND_FAILED",
      1,
      "can't find window: worker"
    )
  });

  await session.waitForObservation("process-started");
  await session.teardown();

  assert.equal(session.ownedRootExists(), false);
  assert.equal(session.evidenceSnapshot().cleanupOutcome, "success");
  assert.match(session.evidenceSnapshot().cleanupDetail, /explicit tmux absence/u);
});

test("Mock Session teardown does not suppress a stop error with missing stderr", async (t) => {
  const stopFault = new CommandExecutionError("COMMAND_FAILED", 1, "");
  const session = await createMockAgentSession(t, {
    scenario: "no-progress",
    stopFault
  });

  await session.waitForObservation("process-started");
  await assert.rejects(session.teardown(), (error) => error === stopFault);

  assert.equal(session.ownedRootExists(), false);
  assert.equal(session.evidenceSnapshot().cleanupOutcome, "error");
});

test("explicit tmux absence remains fail-closed when exact teardown is uncertain", async (t) => {
  const stopFault = new CommandExecutionError(
    "COMMAND_FAILED",
    1,
    "no server running on /tmp/tmux/yui-test"
  );
  const teardownFault = new Error("injected exact-teardown uncertainty");
  const session = await createMockAgentSession(t, {
    scenario: "no-progress",
    stopFault,
    teardownFault
  });

  await session.waitForObservation("process-started");
  await assert.rejects(session.teardown(), (error) => (
    error instanceof AggregateError
    && error.errors[0] === stopFault
    && error.errors[1] === teardownFault
  ));

  assert.equal(session.ownedRootExists(), false);
  assert.equal(session.evidenceSnapshot().cleanupOutcome, "error");
});

test("an aged Leader waiting on a real healthy Mock Worker is not reported stalled", async (t) => {
  const session = await createMockAgentSession(t, {
    scenario: "no-progress",
    waitingLeader: true
  });

  await session.waitForObservation("process-started", {
    nativeSessionId: session.nativeSessionId
  });
  await session.waitForObservation("process-started", {
    nativeSessionId: session.leaderNativeSessionId
  });
  const beforeLeader = session.leaderRun();
  const beforeWorker = session.currentRun();
  assert.equal(beforeLeader.deliveredAt, "2026-08-09T00:00:00.000Z");
  assert.equal(beforeWorker.createdAt, "2026-08-09T00:30:00.000Z");
  assert.equal(beforeWorker.deliveredAt, undefined);

  const reconciliation = await session.reconcileWaitingLeader(
    new Date("2026-08-09T00:31:00.000Z"),
    30 * 60_000
  );

  assert.deepEqual(reconciliation.liveness, [
    {
      taskId: "task-mock",
      roleName: "leader",
      nativeSessionId: session.leaderNativeSessionId,
      status: "present"
    },
    {
      taskId: "task-mock",
      roleName: "worker",
      nativeSessionId: session.nativeSessionId,
      status: "present"
    }
  ]);
  assert.deepEqual(reconciliation.raised, []);
  assert.equal(session.taskEvents().some((event) => event.type === "run.stalled"), false);
  assert.deepEqual(session.taskMessages(), []);
  assert.deepEqual(session.leaderRun(), beforeLeader);
  assert.deepEqual(session.currentRun(), beforeWorker);
});
