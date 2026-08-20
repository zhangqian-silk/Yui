import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import {
  AsyncRuntimeEventProcessor,
  coalesceRuntimeProgress,
  FileRuntimeEventProcessor
} from "../../dist/controller/runtimeEventProcessor.js";
import { runSessionNotifyCommand } from "../../dist/controller/sessionNotify.js";
import { AgentDriverRegistry } from "../../dist/runtime/agentDriver.js";
import { createRuntimeObservation } from "../../dist/runtime/runtimeObservation.js";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-runtime-inbox-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const environment = {
    YUI_HOME: home,
    YUI_SESSION_SCOPE: "task",
    YUI_TASK_ID: "task-1",
    YUI_ROLE: "leader",
    YUI_AGENT_ID: "codex-personal",
    YUI_ADAPTER_ID: "codex",
    YUI_LAUNCH_ID: "launch-current"
  };
  const payload = (message = "done") => JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "thread-native-1",
    "turn-id": "turn-1",
    cwd: home,
    "input-messages": ["Plan a lean session picker"],
    "last-assistant-message": message
  });
  return { home, environment, payload };
}

function observation({
  eventId,
  kind,
  receivedAt,
  sequence,
  runId = "run-1",
  driverId = "openai/codex",
  payload = {}
}) {
  return createRuntimeObservation({
    schemaVersion: 1,
    eventId,
    kind,
    authority: "provider-structured",
    receivedAt,
    ...(sequence === undefined ? {} : { sequence }),
    fence: {
      taskId: "task-1",
      roleName: "worker",
      runId,
      agentId: "agent-1",
      driverId,
      launchId: "launch-1",
      sessionGenerationId: "launch-1",
      nativeSessionId: "session-1",
      nativeTurnId: runId,
      receiptId: `agent-run:task-1/${runId}`
    },
    payload
  });
}

function observer(overrides = {}) {
  return {
    getTask: () => ({ id: "task-1", status: "active" }),
    observeRuntimeObservation: () => "applied",
    observeRuntimeTurnCompleted: () => ({}),
    observeGlobalRuntimeTurnCompleted: () => ({}),
    ...overrides
  };
}

function memoryInbox(seed) {
  const remaining = new Map(seed.map((event) => [event.id, event]));
  return {
    list: () => [...remaining.values()],
    acknowledge: (id) => remaining.delete(id),
    acknowledgeMany(ids) {
      return ids.filter((id) => remaining.delete(id));
    },
    depth: () => remaining.size
  };
}

test("Codex notify durably records completion even when the Controller wake fails", async (t) => {
  const fx = fixture(t);
  await assert.doesNotReject(runSessionNotifyCommand(
    fx.payload("complete"),
    fx.environment,
    async () => { throw new Error("Controller offline"); }
  ));

  const [event] = new FileRuntimeEventInbox(fx.home).list();
  assert.equal(event.type, "native-turn-completed");
  assert.equal(event.taskId, "task-1");
  assert.equal(event.summary, "complete");
});

test("duplicate Codex notifications retain one content-derived inbox event", async (t) => {
  const fx = fixture(t);
  await runSessionNotifyCommand(fx.payload(), fx.environment, async () => ({}));
  await runSessionNotifyCommand(fx.payload(), fx.environment, async () => ({}));
  assert.equal(new FileRuntimeEventInbox(fx.home).list().length, 1);
});

test("canonical observations are replayed by receivedAt then monotonic sequence", (t) => {
  const { home } = fixture(t);
  const inbox = new FileRuntimeEventInbox(home);
  const at = "2026-08-19T00:00:00.000Z";
  inbox.enqueueObservation(observation({
    eventId: "later",
    kind: "turn.accepted",
    receivedAt: at,
    sequence: 8
  }));
  inbox.enqueueObservation(observation({
    eventId: "earlier",
    kind: "turn.accepted",
    receivedAt: at,
    sequence: 7
  }));

  assert.deepEqual(
    inbox.list().map((event) => event.observation.eventId),
    ["earlier", "later"]
  );
});

test("a deferred canonical observation stays durable until a later applied fold", (t) => {
  const { home } = fixture(t);
  const inbox = new FileRuntimeEventInbox(home);
  inbox.enqueueObservation(observation({
    eventId: "ready-1",
    kind: "session.ready",
    receivedAt: "2026-08-19T00:00:00.000Z"
  }));
  let ready = false;
  const processor = new FileRuntimeEventProcessor(inbox, observer({
    observeRuntimeObservation: () => ready ? "applied" : "deferred"
  }));

  const first = processor.drain(new Date("2026-08-19T00:00:01.000Z"));
  assert.equal(first.deferred.length, 1);
  assert.equal(inbox.list().length, 1);

  ready = true;
  const second = processor.drain(new Date("2026-08-19T00:00:02.000Z"));
  assert.equal(second.acknowledgedEventIds.length, 1);
  assert.equal(inbox.list().length, 0);
});

test("activity coalescing preserves the usage baseline and latest snapshot per semantic segment", () => {
  const at = "2026-08-19T00:00:00.000Z";
  const activity = (id, sequence, inputTokens) => ({
    schemaVersion: 1,
    id: `inbox-${id}`,
    type: "runtime-observation",
    receivedAt: at,
    scope: "task",
    taskId: "task-1",
    observation: observation({
      eventId: id,
      kind: "activity.observed",
      receivedAt: at,
      sequence,
      payload: {
        activity: "model",
        usage: { inputTokens, outputTokens: sequence }
      }
    })
  });
  const accepted = {
    schemaVersion: 1,
    id: "inbox-accepted",
    type: "runtime-observation",
    receivedAt: at,
    scope: "task",
    taskId: "task-1",
    observation: observation({
      eventId: "accepted",
      kind: "turn.accepted",
      receivedAt: at,
      sequence: 4
    })
  };
  const events = [
    activity("usage-1", 1, 10),
    activity("usage-2", 2, 20),
    activity("usage-3", 3, 30),
    accepted,
    activity("usage-4", 5, 40),
    activity("usage-5", 6, 50)
  ];

  const coalesced = coalesceRuntimeProgress(events);
  assert.deepEqual(coalesced.map(({ event }) => (
    event.type === "runtime-observation" ? event.observation.eventId : event.id
  )), ["usage-1", "usage-3", "accepted", "usage-4", "usage-5"]);
  assert.deepEqual(coalesced[1].representedEventIds, ["inbox-usage-2", "inbox-usage-3"]);
});

test("activity coalescing preserves a reset baseline before later token growth", () => {
  const at = "2026-08-19T00:00:00.000Z";
  const events = [100, 2, 3, 4].map((inputTokens, index) => ({
    id: `inbox-reset-${index}`,
    type: "runtime-observation",
    receivedAt: at,
    scope: "task",
    taskId: "task-1",
    observation: observation({
      eventId: `reset-${index}`,
      kind: "activity.observed",
      receivedAt: at,
      sequence: index,
      payload: {
        activity: "model",
        usage: { inputTokens, outputTokens: 0 }
      }
    })
  }));

  const coalesced = coalesceRuntimeProgress(events);
  assert.deepEqual(
    coalesced.map(({ event }) => event.observation.eventId),
    ["reset-0", "reset-1", "reset-3"]
  );
  assert.deepEqual(
    coalesced.map(({ representedEventIds }) => representedEventIds),
    [["inbox-reset-0"], ["inbox-reset-1"], ["inbox-reset-2", "inbox-reset-3"]]
  );
});

test("async persistence coalesces a runtime activity burst before worker folds", async () => {
  const events = [1, 2, 3].map((sequence) => ({
    id: `inbox-activity-${sequence}`,
    type: "runtime-observation",
    scope: "task",
    taskId: "task-1",
    receivedAt: `2026-08-19T00:00:0${sequence}.000Z`,
    observation: observation({
      eventId: `activity-${sequence}`,
      kind: "activity.observed",
      receivedAt: `2026-08-19T00:00:0${sequence}.000Z`,
      sequence,
      payload: { activity: "tool" }
    })
  }));
  const inbox = memoryInbox(events);
  const folded = [];
  const processor = new AsyncRuntimeEventProcessor(inbox, {
    getTask: async () => ({ id: "task-1", status: "active" }),
    observeRuntimeObservation: async (input) => {
      folded.push(input.eventId);
      return "applied";
    },
    observeRuntimeTurnCompleted: async () => ({}),
    observeGlobalRuntimeTurnCompleted: async () => ({})
  });

  const result = await processor.drainAsync(new Date("2026-08-19T00:00:10.000Z"));
  assert.deepEqual(folded, ["activity-3"]);
  assert.equal(result.metrics.selectedEventCount, 1);
  assert.equal(result.metrics.progressEventsCoalesced, 2);
  assert.equal(result.remainingEventCount, 0);
});

test("one failed canonical fold does not acknowledge independent events", () => {
  const at = "2026-08-19T00:00:00.000Z";
  const events = ["good-1", "bad", "good-2"].map((eventId, index) => ({
    schemaVersion: 1,
    id: `inbox-${eventId}`,
    type: "runtime-observation",
    receivedAt: at,
    scope: "task",
    taskId: "task-1",
    observation: observation({
      eventId,
      kind: "turn.accepted",
      receivedAt: at,
      sequence: index
    })
  }));
  const inbox = memoryInbox(events);
  const processor = new FileRuntimeEventProcessor(inbox, observer({
    withRuntimeEventTransaction: (execute) => execute(),
    observeRuntimeObservation(input) {
      if (input.eventId === "bad") throw new Error("bad event");
      return "applied";
    }
  }));

  const result = processor.drain(new Date("2026-08-19T00:00:01.000Z"));
  assert.deepEqual(result.acknowledgedEventIds.sort(), ["inbox-good-1", "inbox-good-2"]);
  assert.equal(result.failed.length, 1);
  assert.equal(inbox.depth(), 1);
});

test("runtime apply callback carries the exact canonical generation", (t) => {
  const { home } = fixture(t);
  const inbox = new FileRuntimeEventInbox(home);
  inbox.enqueueObservation(observation({
    eventId: "accepted-callback",
    kind: "turn.accepted",
    receivedAt: "2026-08-19T00:00:00.000Z"
  }));
  const applied = [];
  const processor = new FileRuntimeEventProcessor(
    inbox,
    observer(),
    { onTaskRuntimeApplied: (input) => applied.push(input) }
  );
  processor.drain(new Date("2026-08-19T00:00:01.000Z"));

  assert.deepEqual(applied, [{
    taskId: "task-1",
    roleName: "worker",
    agentId: "agent-1",
    adapterId: "codex",
    launchId: "launch-1",
    nativeSessionId: "session-1",
    runId: "run-1"
  }]);
});

test("runtime apply callback resolves a registered future Driver without a core mapping", () => {
  const event = {
    id: "future-session-started",
    type: "runtime-observation",
    scope: "task",
    taskId: "task-1",
    receivedAt: "2026-08-19T00:00:00.000Z",
    observation: observation({
      eventId: "future-session-started",
      kind: "session.started",
      receivedAt: "2026-08-19T00:00:00.000Z",
      driverId: "example/future-agent"
    })
  };
  const drivers = new AgentDriverRegistry();
  drivers.register({
    id: "example/future-agent",
    label: "Future Agent",
    protocolVersion: 1,
    adapterId: "future-cli",
    capabilities: {
      surfaces: ["interactive-cli"],
      control: { start: true, resume: true, sendTurn: true, interrupt: true, stop: true },
      observation: {
        sessionIdentity: "exact",
        sessionBootstrap: "discovered",
        preInputReadiness: "unavailable",
        promptAcceptance: "exact",
        turnLifecycle: "exact",
        operations: ["tool"],
        waiting: ["permission"],
        usage: "event-snapshot",
        delivery: "ordered-best-effort"
      }
    },
    runtime: {
      nativeSessionId: () => undefined,
      nativeTurnId: () => undefined,
      mapHook: () => ({ kind: "session.started", payload: {} }),
      classifyHook: () => ({})
    }
  });
  const applied = [];
  const processor = new FileRuntimeEventProcessor(
    memoryInbox([event]),
    observer(),
    {
      drivers,
      onTaskRuntimeApplied: (input) => applied.push(input)
    }
  );

  const result = processor.drain(new Date("2026-08-19T00:00:01.000Z"));
  assert.equal(result.failed.length, 0);
  assert.equal(applied[0].adapterId, "future-cli");
});

test("durable-job-terminal is idempotent and acknowledged without a provider observer", (t) => {
  const { home } = fixture(t);
  const inbox = new FileRuntimeEventInbox(home);
  const input = {
    scope: "task",
    taskId: "task-1",
    jobId: "job-1",
    status: "succeeded",
    outcome: "artifact ready"
  };
  assert.equal(inbox.enqueueDurableJobTerminal(input).created, true);
  assert.equal(inbox.enqueueDurableJobTerminal(input).created, false);

  const result = new FileRuntimeEventProcessor(inbox, observer()).drain(new Date());
  assert.equal(result.failed.length, 0);
  assert.equal(result.acknowledgedEventIds.length, 1);
  assert.equal(inbox.list().length, 0);
});
