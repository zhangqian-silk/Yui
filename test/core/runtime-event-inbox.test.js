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
