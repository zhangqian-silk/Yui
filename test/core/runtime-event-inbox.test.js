import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileRuntimeEventInbox,
  MAX_RUNTIME_TURN_SUMMARY_BYTES
} from "../../dist/controller/runtimeEventInbox.js";
import { FileRuntimeEventProcessor } from "../../dist/controller/runtimeEventProcessor.js";
import { runSessionNotifyCommand } from "../../dist/controller/sessionNotify.js";

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

test("Codex notify writes an immutable event without waiting for FileTaskStore lock", async (t) => {
  const { home, environment, payload } = fixture(t);
  const stateLock = join(home, ".state.lock");
  mkdirSync(stateLock, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateLock, "owner"), `${process.pid}\n`, { mode: 0o600 });
  const calls = [];

  const startedAt = Date.now();
  await runSessionNotifyCommand(payload(), environment, async (...args) => {
    calls.push(args);
    return {};
  });

  assert.ok(Date.now() - startedAt < 1_000, "notify must not wait for the 5s state lock");
  const inbox = new FileRuntimeEventInbox(home);
  const events = inbox.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].scope, "task");
  assert.equal(events[0].taskId, "task-1");
  assert.equal(events[0].launchId, "launch-current");
  assert.equal(events[0].title, "Plan a lean session picker");
  assert.equal(events[0].summary, "done");
  assert.deepEqual(calls.map(([, method, params]) => [method, params]), [[
    "scheduler.signal",
    { key: "role:task-1/leader" }
  ]]);
  const eventPath = join(home, "runtime", "inbox", `${events[0].id}.json`);
  assert.equal(statSync(eventPath).mode & 0o777, 0o600);
});

test("Codex notify persists a tool-only Turn with no final assistant message", async (t) => {
  const { home, environment, payload } = fixture(t);

  await runSessionNotifyCommand(payload(null), environment, async () => ({}));

  const [event] = new FileRuntimeEventInbox(home).list();
  assert.equal(event.nativeSessionId, "thread-native-1");
  assert.equal(event.turnId, "turn-1");
  assert.equal(
    event.summary,
    "Native Turn completed without a final assistant message."
  );
});

test("a global Role Hook signals only its lifecycle lane", async (t) => {
  const { home, environment, payload } = fixture(t);
  const calls = [];

  await runSessionNotifyCommand(
    payload(),
    {
      ...environment,
      YUI_SESSION_SCOPE: "global",
      YUI_ROLE: "reviewer"
    },
    async (...args) => {
      calls.push(args);
      return {};
    }
  );

  assert.deepEqual(calls.map(([, method, params]) => [method, params]), [[
    "scheduler.signal",
    { key: "global-role:reviewer" }
  ]]);
  const [event] = new FileRuntimeEventInbox(home).list();
  assert.equal(event.scope, "global");
  assert.equal(event.roleName, "reviewer");
});

test("duplicate Codex notifications create one deterministic event and preserve first content", async (t) => {
  const { home, environment, payload } = fixture(t);
  const signal = async () => ({});

  await runSessionNotifyCommand(payload("first summary"), environment, signal);
  await runSessionNotifyCommand(payload("different retry summary"), environment, signal);

  const inbox = new FileRuntimeEventInbox(home);
  const files = readdirSync(join(home, "runtime", "inbox"))
    .filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 1);
  const [event] = inbox.list();
  assert.equal(event.summary, "first summary");
  assert.equal(inbox.read(event.id).id, event.id);
  assert.equal(inbox.acknowledge(event.id), true);
  assert.equal(inbox.acknowledge(event.id), false);
  assert.deepEqual(inbox.list(), []);
});

test("runtime events remain readable after recreating the inbox", async (t) => {
  const { home, environment, payload } = fixture(t);
  await runSessionNotifyCommand(payload(), environment, async () => ({}));

  const beforeRestart = new FileRuntimeEventInbox(home).list();
  const afterRestart = new FileRuntimeEventInbox(home).list();

  assert.equal(beforeRestart.length, 1);
  assert.deepEqual(afterRestart, beforeRestart);
});

test("runtime events are listed in durable arrival order", (t) => {
  const { home } = fixture(t);
  const times = [
    new Date("2026-07-24T01:00:01.000Z"),
    new Date("2026-07-24T01:00:02.000Z")
  ];
  const inbox = new FileRuntimeEventInbox(home, () => times.shift());
  const common = {
    scope: "task",
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex-personal",
    adapterId: "codex",
    nativeSessionId: "thread-native-1",
    summary: "done"
  };
  inbox.enqueueTurnCompleted({ ...common, turnId: "turn-z" });
  inbox.enqueueTurnCompleted({ ...common, turnId: "turn-a" });

  assert.deepEqual(inbox.list().map((event) => event.turnId), ["turn-z", "turn-a"]);
});

test("Controller folds each runtime event before acknowledging it", (t) => {
  const { home } = fixture(t);
  const inbox = new FileRuntimeEventInbox(home);
  inbox.enqueueTurnCompleted({
    scope: "task",
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex-personal",
    adapterId: "codex",
    nativeSessionId: "thread-native-1",
    turnId: "turn-1",
    summary: "done"
  });
  const observed = [];
  const processor = new FileRuntimeEventProcessor(inbox, {
    getTask: () => ({ id: "task-1", status: "active" }),
    observeRuntimeTurnCompleted(input) {
      observed.push(input);
    },
    observeGlobalRuntimeTurnCompleted() {
      throw new Error("unexpected global event");
    }
  });

  const result = processor.drain(new Date("2026-07-24T01:00:02.000Z"));

  assert.equal(result.failed.length, 0);
  assert.equal(result.acknowledgedEventIds.length, 1);
  assert.equal(observed[0].turnId, "turn-1");
  assert.deepEqual(inbox.list(), []);
});

test("Controller retains a runtime event when its state transaction fails", (t) => {
  const { home } = fixture(t);
  const inbox = new FileRuntimeEventInbox(home);
  const { event } = inbox.enqueueTurnCompleted({
    scope: "task",
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex-personal",
    adapterId: "codex",
    nativeSessionId: "thread-native-1",
    turnId: "turn-1",
    summary: "done"
  });
  const processor = new FileRuntimeEventProcessor(inbox, {
    getTask: () => ({ id: "task-1", status: "active" }),
    observeRuntimeTurnCompleted() {
      throw new Error("state lock unavailable");
    },
    observeGlobalRuntimeTurnCompleted() {
      throw new Error("unexpected global event");
    }
  });

  const result = processor.drain(new Date("2026-07-24T01:00:02.000Z"));

  assert.deepEqual(result.acknowledgedEventIds, []);
  assert.equal(result.failed[0].eventId, event.id);
  assert.equal(inbox.list()[0].id, event.id);
});

test("Controller reports a top-level inbox read failure for fast retry", () => {
  const failure = new Error("runtime inbox temporarily unavailable");
  const processor = new FileRuntimeEventProcessor({
    list() {
      throw failure;
    },
    acknowledge() {
      throw new Error("unexpected acknowledge");
    }
  }, {
    getTask() {
      throw new Error("unexpected Task read");
    },
    observeRuntimeTurnCompleted() {
      throw new Error("unexpected Task event");
    },
    observeGlobalRuntimeTurnCompleted() {
      throw new Error("unexpected global event");
    }
  });

  const result = processor.drain(new Date("2026-07-24T01:00:02.000Z"));

  assert.deepEqual(result.acknowledgedEventIds, []);
  assert.deepEqual(result.deferred, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].eventId, undefined);
  assert.equal(result.failed[0].error, failure);
});

test("Controller reports only inbox ids actually removed by acknowledgement", () => {
  const event = progressEvent(0, 0);
  const processor = new FileRuntimeEventProcessor({
    list: () => [event],
    acknowledge: () => false,
    acknowledgeMany: () => []
  }, {
    getTask: () => ({ id: "task-1", status: "active" }),
    observeProviderTurnProgress: () => "applied",
    observeRuntimeTurnCompleted() {},
    observeGlobalRuntimeTurnCompleted() {}
  });

  const result = processor.drain(new Date("2026-08-13T01:00:00.000Z"));

  assert.deepEqual(result.acknowledgedEventIds, []);
  assert.equal(result.remainingEventCount, 1);
  assert.equal(result.metrics.remainingProgressEventCount, 1);
});

test("invalid inbox files are quarantined without blocking valid Hook events", (t) => {
  const { home } = fixture(t);
  const inbox = new FileRuntimeEventInbox(home);
  inbox.enqueueTurnCompleted({
    scope: "task",
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex-personal",
    adapterId: "codex",
    nativeSessionId: "thread-native-1",
    turnId: "turn-valid",
    summary: "done"
  });
  const directory = join(home, "runtime", "inbox");
  writeFileSync(join(directory, "bad.json"), "{not-json}\n", { mode: 0o600 });

  const events = inbox.list();

  assert.deepEqual(events.map((event) => event.turnId), ["turn-valid"]);
  assert.equal(readdirSync(directory).includes("bad.json"), false);
  assert.equal(
    readdirSync(join(home, "runtime", "inbox-invalid"))
      .some((name) => name.startsWith("bad.json.")),
    true
  );
});

test("a quarantine failure does not block readable Hook events", (t) => {
  const { home } = fixture(t);
  const inbox = new FileRuntimeEventInbox(home);
  const directory = join(home, "runtime", "inbox");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "bad.json"), "{not-json}\n", { mode: 0o600 });
  writeFileSync(join(home, "runtime", "inbox-invalid"), "blocked\n", { mode: 0o600 });

  assert.deepEqual(inbox.list(), []);

  inbox.enqueueTurnCompleted({
    scope: "task",
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex-personal",
    adapterId: "codex",
    nativeSessionId: "thread-native-1",
    turnId: "turn-valid-after-quarantine-failure",
    summary: "done"
  });

  assert.deepEqual(
    inbox.list().map((event) => event.turnId),
    ["turn-valid-after-quarantine-failure"]
  );
});

test("Codex notify truncates the durable summary on a UTF-8 boundary", async (t) => {
  const { home, environment, payload } = fixture(t);
  const message = "界".repeat(20_000);

  await runSessionNotifyCommand(payload(message), environment, async () => ({}));

  const [event] = new FileRuntimeEventInbox(home).list();
  assert.ok(Buffer.byteLength(event.summary, "utf8") <= MAX_RUNTIME_TURN_SUMMARY_BYTES);
  assert.equal(event.summary.includes("\uFFFD"), false);
  assert.ok(readFileSync(
    join(home, "runtime", "inbox", `${event.id}.json`),
    "utf8"
  ).length > 0);
});

test("Codex notify retains the event when the best-effort signal fails", async (t) => {
  const { home, environment, payload } = fixture(t);

  await runSessionNotifyCommand(payload(), environment, async () => {
    throw new Error("Controller offline");
  });

  assert.equal(new FileRuntimeEventInbox(home).list().length, 1);
});

test("Codex notify rejects payloads above its input limit before writing", async (t) => {
  const { home, environment, payload } = fixture(t);

  await assert.rejects(
    runSessionNotifyCommand(payload("x".repeat(524_289)), environment, async () => ({})),
    /last assistant message is invalid/
  );

  assert.deepEqual(new FileRuntimeEventInbox(home).list(), []);
});

test("progress admission keeps only the latest exact-Run fact within each semantic segment", (t) => {
  const { home } = fixture(t);
  const receivedAt = [
    ...Array.from({ length: 10 }, (_, index) => (
      new Date(Date.UTC(2026, 7, 13, 0, 0, index))
    )),
    new Date(Date.UTC(2026, 7, 13, 0, 0, 10)),
    ...Array.from({ length: 10 }, (_, index) => (
      new Date(Date.UTC(2026, 7, 13, 0, 0, 11 + index))
    )),
    // A delayed retry from before the terminal boundary must not replace the
    // latest progress in the segment after that boundary.
    new Date(Date.UTC(2026, 7, 13, 0, 0, 9, 500))
  ];
  const inbox = new FileRuntimeEventInbox(home, () => receivedAt.shift());
  const progress = (progressId) => inbox.enqueueProviderProgress({
    scope: "task",
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex-personal",
    adapterId: "codex",
    launchId: "launch-current",
    nativeSessionId: "thread-native-1",
    runId: "agent-run-1",
    progressId
  });

  for (let index = 0; index < 10; index += 1) progress(`before-${index}`);
  inbox.enqueueTurnCompleted({
    scope: "task",
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex-personal",
    adapterId: "codex",
    launchId: "launch-current",
    nativeSessionId: "thread-native-1",
    turnId: "turn-terminal",
    runId: "agent-run-1",
    summary: "terminal boundary"
  });
  for (let index = 0; index < 10; index += 1) progress(`after-${index}`);
  progress("before-retry");

  const events = inbox.list();
  assert.deepEqual(events.map(({ type }) => type), [
    "native-turn-progress",
    "native-turn-completed",
    "native-turn-progress"
  ]);
  assert.deepEqual(
    events.filter(({ type }) => type === "native-turn-progress")
      .map(({ progressId }) => progressId),
    ["before-retry", "after-9"]
  );
});

test("restart drain coalesces 25 progress streams into one state transaction", () => {
  const events = [];
  for (let stream = 0; stream < 25; stream += 1) {
    for (let sequence = 0; sequence < 20; sequence += 1) {
      events.push(progressEvent(stream, sequence));
    }
  }
  const inbox = memoryInbox(events);
  const observed = [];
  let transactions = 0;
  const processor = new FileRuntimeEventProcessor(inbox, {
    withRuntimeEventTransaction(execute) {
      transactions += 1;
      return execute();
    },
    getTask: () => ({ id: "task-1", status: "active" }),
    observeProviderTurnProgress(input) {
      observed.push(input);
      return "applied";
    },
    observeRuntimeTurnCompleted() {
      throw new Error("unexpected terminal event");
    },
    observeGlobalRuntimeTurnCompleted() {
      throw new Error("unexpected global event");
    }
  }, { maxEventsPerDrain: 64 });

  const result = processor.drain(new Date("2026-08-13T01:00:00.000Z"));

  assert.equal(transactions, 1);
  assert.equal(observed.length, 25);
  assert.deepEqual(observed.map(({ progressId }) => progressId),
    Array.from({ length: 25 }, (_, index) => `progress-${index}-19`));
  assert.equal(result.acknowledgedEventIds.length, 500);
  assert.equal(result.failed.length, 0);
  assert.equal(result.remainingEventCount, 0);
  assert.equal(result.metrics.progressEventsCoalesced, 475);
  assert.equal(result.metrics.stateTransactions, 1);
  assert.equal(inbox.depth(), 0);
});

test("progress coalescing never crosses ordered semantic events", () => {
  const runId = "agent-run-1";
  const events = [
    progressEvent(0, 0, { runId }),
    progressEvent(0, 1, { runId }),
    semanticEvent("native-prompt-accepted", 2, runId),
    progressEvent(0, 3, { runId }),
    progressEvent(0, 4, { runId }),
    semanticEvent("native-turn-completed", 5, runId),
    progressEvent(0, 6, { runId }),
    progressEvent(0, 7, { runId })
  ];
  const calls = [];
  const processor = new FileRuntimeEventProcessor(memoryInbox(events), {
    withRuntimeEventTransaction: (execute) => execute(),
    getTask: () => ({ id: "task-1", status: "active" }),
    observeProviderTurnProgress(input) {
      calls.push(input.progressId);
      return "applied";
    },
    observeProviderPromptAccepted() {
      calls.push("accepted");
      return "applied";
    },
    classifyRuntimeTurnCompleted: () => "apply",
    observeRuntimeTurnCompleted() {
      calls.push("terminal");
    },
    observeGlobalRuntimeTurnCompleted() {
      throw new Error("unexpected global event");
    }
  });

  const result = processor.drain(new Date("2026-08-13T01:00:00.000Z"));

  assert.deepEqual(calls, [
    "progress-0-1",
    "accepted",
    "progress-0-4",
    "terminal",
    "progress-0-7"
  ]);
  assert.equal(result.acknowledgedEventIds.length, events.length);
  assert.equal(result.metrics.progressEventsCoalesced, 3);
});

test("a failed batched fold is isolated without acknowledging the bad semantic event", () => {
  const bad = semanticEvent("native-prompt-accepted", 2, "agent-run-bad");
  const good = semanticEvent("native-turn-completed", 3, "agent-run-good");
  const inbox = memoryInbox([
    progressEvent(0, 0),
    progressEvent(0, 1),
    bad,
    good
  ]);
  let transactionCalls = 0;
  const processor = new FileRuntimeEventProcessor(inbox, {
    withRuntimeEventTransaction(execute) {
      transactionCalls += 1;
      return execute();
    },
    getTask: () => ({ id: "task-1", status: "active" }),
    observeProviderTurnProgress: () => "applied",
    observeProviderPromptAccepted() {
      throw new Error("bad semantic event");
    },
    classifyRuntimeTurnCompleted: () => "apply",
    observeRuntimeTurnCompleted() {},
    observeGlobalRuntimeTurnCompleted() {
      throw new Error("unexpected global event");
    }
  });

  const result = processor.drain(new Date("2026-08-13T01:00:00.000Z"));

  assert.equal(transactionCalls, 4);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].eventId, bad.id);
  assert.deepEqual(inbox.list().map(({ id }) => id), [bad.id]);
  assert.equal(result.acknowledgedEventIds.length, 3);
});

test("a failed batch transaction acknowledges nothing before isolated retries commit", () => {
  const first = progressEvent(0, 0);
  const second = semanticEvent("native-prompt-accepted", 2, "agent-run-bad");
  const acknowledged = [];
  let transactionCalls = 0;
  const processor = new FileRuntimeEventProcessor({
    list: () => [first, second],
    acknowledge(id) {
      acknowledged.push(id);
      return true;
    },
    acknowledgeMany(ids) {
      acknowledged.push(...ids);
      return [...ids];
    }
  }, {
    withRuntimeEventTransaction(execute) {
      transactionCalls += 1;
      const result = execute();
      if (transactionCalls === 1) {
        assert.deepEqual(acknowledged, []);
        throw new Error("aggregate commit failed");
      }
      return result;
    },
    getTask: () => ({ id: "task-1", status: "active" }),
    observeProviderTurnProgress: () => "applied",
    observeProviderPromptAccepted: () => "applied",
    observeRuntimeTurnCompleted() {},
    observeGlobalRuntimeTurnCompleted() {}
  });

  const result = processor.drain(new Date("2026-08-13T01:00:00.000Z"));

  assert.equal(transactionCalls, 3);
  assert.deepEqual(acknowledged, [first.id, second.id]);
  assert.deepEqual(result.acknowledgedEventIds, acknowledged);
  assert.deepEqual(result.failed, []);
});

test("bounded drains preserve arrival order before reaching a semantic event", () => {
  const events = Array.from({ length: 25 }, (_, stream) => (
    progressEvent(stream, 0)
  ));
  const semantic = semanticEvent("native-prompt-accepted", 30, "agent-run-semantic");
  events.push(semantic);
  const calls = [];
  const inbox = memoryInbox(events);
  const processor = new FileRuntimeEventProcessor(inbox, {
    withRuntimeEventTransaction: (execute) => execute(),
    getTask: () => ({ id: "task-1", status: "active" }),
    observeProviderTurnProgress(input) {
      calls.push(input.progressId);
      return "applied";
    },
    observeProviderPromptAccepted() {
      calls.push("semantic");
      return "applied";
    },
    observeRuntimeTurnCompleted() {},
    observeGlobalRuntimeTurnCompleted() {}
  }, { maxEventsPerDrain: 8 });

  const first = processor.drain(new Date("2026-08-13T01:00:00.000Z"));

  assert.equal(first.metrics.selectedEventCount, 8);
  assert.equal(first.metrics.semanticEventsSelected, 0);
  assert.deepEqual(calls, Array.from(
    { length: 8 },
    (_, stream) => `progress-${stream}-0`
  ));
  assert.ok(first.remainingEventCount > 0);

  while (inbox.depth() > 0) {
    processor.drain(new Date("2026-08-13T01:00:00.000Z"));
  }
  assert.equal(calls.length, 26);
  assert.equal(calls.at(-1), "semantic");
});

function progressEvent(stream, sequence, overrides = {}) {
  return Object.freeze({
    schemaVersion: 1,
    id: testEventId(stream * 1_000 + sequence),
    type: "native-turn-progress",
    receivedAt: new Date(Date.UTC(2026, 7, 13, 0, 0, stream * 20 + sequence))
      .toISOString(),
    scope: "task",
    taskId: "task-1",
    roleName: `worker-${stream}`,
    agentId: `agent-${stream}`,
    adapterId: "codex",
    launchId: `launch-${stream}`,
    nativeSessionId: `session-${stream}`,
    runId: `agent-run-${stream + 1}`,
    progressId: `progress-${stream}-${sequence}`,
    sequence,
    ...overrides
  });
}

function semanticEvent(type, sequence, runId) {
  const common = {
    schemaVersion: 1,
    id: testEventId(50_000 + sequence),
    type,
    receivedAt: new Date(Date.UTC(2026, 7, 13, 0, 10, sequence)).toISOString(),
    scope: "task",
    taskId: "task-1",
    roleName: "worker-0",
    agentId: "agent-0",
    adapterId: "codex",
    launchId: "launch-0",
    nativeSessionId: "session-0",
    runId
  };
  return type === "native-prompt-accepted"
    ? Object.freeze({ ...common, receiptId: "receipt-1" })
    : Object.freeze({
        ...common,
        turnId: "turn-1",
        summary: "done"
      });
}

function testEventId(value) {
  return `turn-${value.toString(16).padStart(64, "0")}`;
}

function memoryInbox(seed) {
  const remaining = new Map(seed.map((event) => [event.id, event]));
  return {
    list: () => [...remaining.values()],
    acknowledge(id) {
      return remaining.delete(id);
    },
    acknowledgeMany(ids) {
      const acknowledged = [];
      for (const id of ids) {
        if (remaining.delete(id)) acknowledged.push(id);
      }
      return acknowledged;
    },
    depth: () => remaining.size
  };
}
