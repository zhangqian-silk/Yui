import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentRuntimeObserver } from "../../dist/controller/agentRuntimeObserver.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";
import {
  createRuntimeObservation,
  runtimeObservationTaskEventPayload
} from "../../dist/runtime/runtimeObservation.js";

test("the Controller observer samples an accepted transcript independently of Hooks", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-agent-runtime-observer-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const transcript = join(home, "codex.jsonl");
  const tokenLine = (outputTokens) => `${JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: {
      input_tokens: 10,
      output_tokens: outputTokens
    } } }
  })}\n`;
  writeFileSync(transcript, tokenLine(1));
  const fence = {
    taskId: "task-1",
    roleName: "worker",
    runId: "run-1",
    agentId: "agent-1",
    driverId: "openai/codex",
    launchId: "launch-1",
    sessionGenerationId: "launch-1",
    nativeSessionId: "session-1",
    nativeTurnId: "turn-1",
    receiptId: "agent-run:task-1/run-1"
  };
  const accepted = createRuntimeObservation({
    schemaVersion: 1,
    eventId: "accepted-1",
    kind: "turn.accepted",
    authority: "provider-structured",
    receivedAt: "2026-08-19T00:00:00.000Z",
    fence,
    payload: {
      observerSource: {
        schemaVersion: 1,
        sourceId: "source-1",
        transport: "append-only-jsonl",
        locator: transcript
      }
    }
  });
  const event = {
    schemaVersion: 2,
    id: "event-1",
    taskId: "task-1",
    type: "runtime.observation",
    payload: runtimeObservationTaskEventPayload(accepted),
    createdAt: "2026-08-19T00:00:00.000Z"
  };
  const run = {
    id: "run-1",
    taskId: "task-1",
    roleName: "worker",
    mode: "new",
    status: "active",
    effective: { agentId: "agent-1" }
  };
  const events = [event];
  const store = {
    listTasks: () => [{ id: "task-1", status: "active" }],
    listAgentRuns: () => [run],
    getActiveAgentRun: () => run,
    listEvents: () => events
  };
  const inbox = new FileRuntimeEventInbox(home);
  const observer = new AgentRuntimeObserver(store, inbox);

  assert.deepEqual(
    await observer.sample(new Date("2026-08-19T00:00:01.000Z")),
    ["role:task-1/worker"]
  );
  assert.deepEqual(
    inbox.list().map(({ observation }) => observation.kind),
    ["observer.health", "activity.observed", "activity.observed"]
  );
  const usage = inbox.list().filter(({ observation }) => (
    observation.kind === "activity.observed"
  )).map(({ observation }) => observation.payload.usage);
  assert.deepEqual(usage, [
    { inputTokens: 0, outputTokens: 0 },
    { inputTokens: 10, outputTokens: 1 }
  ]);
  for (const queued of inbox.list()) inbox.acknowledge(queued.id);

  const persistedUsage = createRuntimeObservation({
    schemaVersion: 1,
    eventId: "usage-1",
    kind: "activity.observed",
    authority: "driver-inferred",
    receivedAt: "2026-08-19T00:00:01.000Z",
    fence,
    payload: {
      activity: "model",
      activityId: "usage:10:1",
      usage: { inputTokens: 10, outputTokens: 1 }
    }
  });
  const persistedHealth = createRuntimeObservation({
    schemaVersion: 1,
    eventId: "health-1",
    kind: "observer.health",
    authority: "diagnostic",
    receivedAt: "2026-08-19T00:00:01.000Z",
    fence,
    payload: {
      sourceId: "source-1",
      observerStatus: "healthy"
    }
  });
  events.push({
    ...event,
    id: "event-usage-1",
    payload: runtimeObservationTaskEventPayload(persistedUsage)
  }, {
    ...event,
    id: "event-health-1",
    payload: runtimeObservationTaskEventPayload(persistedHealth)
  });
  const restarted = new AgentRuntimeObserver(store, inbox);
  const restartedDirty = await restarted.sample(new Date("2026-08-19T00:00:01.500Z"));
  assert.deepEqual(inbox.list(), []);
  assert.deepEqual(restartedDirty, []);

  appendFileSync(transcript, tokenLine(3));
  await observer.sample(new Date("2026-08-19T00:00:02.000Z"));
  const [advanced] = inbox.list();
  assert.equal(advanced.observation.kind, "activity.observed");
  assert.deepEqual(advanced.observation.payload.usage, { inputTokens: 10, outputTokens: 3 });
});
