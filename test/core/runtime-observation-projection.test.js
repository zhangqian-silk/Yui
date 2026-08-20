import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRuntimeObservation
} from "../../dist/runtime/runtimeObservation.js";
import {
  createRuntimeProjection,
  projectRuntimeObservation,
  runtimeDisplayStatus,
  evaluateRuntimeAttention
} from "../../dist/runtime/runtimeProjection.js";
import { FileRuntimeEventInbox } from "../../dist/controller/runtimeEventInbox.js";

const FENCE = Object.freeze({
  taskId: "task-1",
  roleName: "worker",
  runId: "run-1",
  agentId: "agent-1",
  driverId: "example/future-agent",
  launchId: "launch-1",
  sessionGenerationId: "generation-1",
  nativeSessionId: "session-1",
  nativeTurnId: "turn-1"
});

function observation(kind, payload = {}, receivedAt = "2026-08-19T00:00:00.000Z") {
  return createRuntimeObservation({
    schemaVersion: 1,
    eventId: `${kind}:${JSON.stringify(payload)}`,
    kind,
    authority: "provider-structured",
    receivedAt,
    fence: FENCE,
    payload
  });
}

test("canonical observations accept an opaque future Driver id and require exact Run fences", () => {
  const accepted = observation("turn.accepted");
  assert.equal(accepted.fence.driverId, "example/future-agent");

  assert.throws(
    () => createRuntimeObservation({
      ...accepted,
      eventId: "missing-run",
      fence: { ...FENCE, runId: undefined }
    }),
    /turn\.accepted requires runId/
  );
});

test("only growth after a cumulative token baseline proves model activity", () => {
  let projection = createRuntimeProjection(FENCE, "2026-08-19T00:00:00.000Z");
  projection = projectRuntimeObservation(projection, observation("turn.accepted"));
  projection = projectRuntimeObservation(projection, observation(
    "activity.observed",
    { activity: "model", usage: { inputTokens: 10, outputTokens: 2 } },
    "2026-08-19T00:00:10.000Z"
  ));
  assert.equal(projection.activity.kind, "provider");
  assert.equal(projection.lastRuntimeActivityAt, "2026-08-19T00:00:00.000Z");

  projection = projectRuntimeObservation(projection, observation(
    "activity.observed",
    { activity: "model", usage: { inputTokens: 10, outputTokens: 3 } },
    "2026-08-19T00:00:20.000Z"
  ));
  assert.equal(projection.activity.kind, "model");
  assert.equal(projection.lastRuntimeActivityAt, "2026-08-19T00:00:20.000Z");

  projection = projectRuntimeObservation(projection, observation(
    "activity.observed",
    { activity: "model", usage: { inputTokens: 10, outputTokens: 3 } },
    "2026-08-19T00:00:30.000Z"
  ));
  assert.equal(projection.lastRuntimeActivityAt, "2026-08-19T00:00:20.000Z");
});

test("a reset usage counter establishes a new baseline without fabricating activity", () => {
  let projection = createRuntimeProjection(FENCE, "2026-08-19T00:00:00.000Z");
  projection = projectRuntimeObservation(projection, observation(
    "activity.observed",
    { activity: "model", usage: { inputTokens: 100, outputTokens: 20 } },
    "2026-08-19T00:00:10.000Z"
  ));
  projection = projectRuntimeObservation(projection, observation(
    "activity.observed",
    { activity: "model", usage: { inputTokens: 2, outputTokens: 0 } },
    "2026-08-19T00:00:20.000Z"
  ));
  assert.equal(projection.lastRuntimeActivityAt, undefined);

  projection = projectRuntimeObservation(projection, observation(
    "activity.observed",
    {
      activity: "model",
      usage: {
        inputTokens: 2,
        outputTokens: 1,
        cachedInputTokens: 2,
        reasoningTokens: 1
      }
    },
    "2026-08-19T00:00:30.000Z"
  ));
  assert.equal(projection.lastRuntimeActivityAt, "2026-08-19T00:00:30.000Z");

  projection = projectRuntimeObservation(projection, observation(
    "activity.observed",
    {
      activity: "model",
      usage: {
        inputTokens: 2,
        outputTokens: 1,
        cachedInputTokens: 999,
        reasoningTokens: 999
      }
    },
    "2026-08-19T00:00:40.000Z"
  ));
  assert.equal(projection.lastRuntimeActivityAt, "2026-08-19T00:00:30.000Z");
});

test("a long-running tool remains tool-active without token changes", () => {
  let projection = createRuntimeProjection(FENCE, "2026-08-19T00:00:00.000Z");
  projection = projectRuntimeObservation(projection, observation("turn.accepted"));
  projection = projectRuntimeObservation(projection, observation("operation.started", {
    operationId: "tool-1",
    operation: "tool"
  }, "2026-08-19T00:00:05.000Z"));

  assert.equal(runtimeDisplayStatus(projection), "tool-active");
  assert.equal(
    evaluateRuntimeAttention(projection, new Date("2026-08-19T01:00:00.000Z"), {
      runtimeSilenceMs: 60_000,
      semanticSilenceMs: 30 * 60_000
    }).runtime,
    "active-operation-quiet"
  );
});

test("permission waiting and descendant activity project independently", () => {
  let projection = createRuntimeProjection(FENCE, "2026-08-19T00:00:00.000Z");
  projection = projectRuntimeObservation(projection, observation("turn.accepted"));
  projection = projectRuntimeObservation(projection, observation("turn.waiting", {
    reason: "permission",
    waitId: "permission-1"
  }));
  assert.equal(runtimeDisplayStatus(projection), "waiting-permission");

  projection = projectRuntimeObservation(projection, observation("operation.started", {
    operationId: "child-1",
    operation: "subagent"
  }));
  assert.equal(runtimeDisplayStatus(projection), "subagent-active");
});

test("permission waiting is one episode and positive evidence resumes the turn", () => {
  let projection = createRuntimeProjection(FENCE, "2026-08-19T00:00:00.000Z");
  projection = projectRuntimeObservation(projection, observation("turn.accepted"));
  projection = projectRuntimeObservation(projection, observation("turn.waiting", {
    reason: "permission",
    waitId: "permission-1"
  }, "2026-08-19T00:00:01.000Z"));
  projection = projectRuntimeObservation(projection, observation("operation.completed", {
    operationId: "tool-1",
    operation: "tool"
  }, "2026-08-19T00:00:02.000Z"));
  assert.equal(projection.turn, "accepted");
  assert.equal(projection.waitId, undefined);
  assert.equal(runtimeDisplayStatus(projection), "active-quiet");

  projection = projectRuntimeObservation(projection, observation("turn.waiting", {
    reason: "permission",
    waitId: "permission-2"
  }, "2026-08-19T00:00:03.000Z"));
  projection = projectRuntimeObservation(projection, observation("activity.observed", {
    activity: "model",
    activityId: "message-1:0"
  }, "2026-08-19T00:00:04.000Z"));
  assert.equal(projection.turn, "accepted");
  assert.equal(runtimeDisplayStatus(projection), "model-active");
});

test("an unchanged usage snapshot does not falsely resume a waiting turn", () => {
  let projection = createRuntimeProjection(FENCE, "2026-08-19T00:00:00.000Z");
  projection = projectRuntimeObservation(projection, observation("activity.observed", {
    activity: "model",
    usage: { inputTokens: 10, outputTokens: 2 }
  }));
  projection = projectRuntimeObservation(projection, observation("turn.waiting", {
    reason: "permission",
    waitId: "permission-1"
  }));
  projection = projectRuntimeObservation(projection, observation("activity.observed", {
    activity: "model",
    usage: { inputTokens: 10, outputTokens: 2 }
  }, "2026-08-19T00:00:02.000Z"));
  assert.equal(projection.turn, "waiting");
  assert.equal(runtimeDisplayStatus(projection), "waiting-permission");
});

test("host evidence alone is unobservable and provider turn completion does not complete workflow", () => {
  let projection = createRuntimeProjection(FENCE, "2026-08-19T00:00:00.000Z");
  projection = projectRuntimeObservation(projection, createRuntimeObservation({
    schemaVersion: 1,
    eventId: "host-alive",
    kind: "host.observed",
    authority: "host",
    receivedAt: "2026-08-19T00:00:01.000Z",
    fence: FENCE,
    payload: { alive: true }
  }));
  assert.equal(runtimeDisplayStatus(projection), "runtime-unobservable");

  projection = projectRuntimeObservation(projection, observation("turn.accepted"));
  projection = projectRuntimeObservation(projection, observation("turn.completed"));
  assert.equal(runtimeDisplayStatus(projection), "ready");
  assert.equal(projection.workflow.completed, false);
});

test("a started provider Session remains distinguishable from host-only evidence", () => {
  let projection = createRuntimeProjection(FENCE, "2026-08-19T00:00:00.000Z");
  projection = projectRuntimeObservation(projection, observation("session.started"));
  projection = projectRuntimeObservation(projection, createRuntimeObservation({
    schemaVersion: 1,
    eventId: "host-alive-after-start",
    kind: "host.observed",
    authority: "host",
    receivedAt: "2026-08-19T00:00:01.000Z",
    fence: FENCE,
    payload: { alive: true }
  }));
  assert.equal(runtimeDisplayStatus(projection), "awaiting-provider-acceptance");
});

test("the durable runtime inbox stores canonical observations without provider-specific envelopes", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-runtime-observation-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const inbox = new FileRuntimeEventInbox(home, () => new Date("2026-08-19T00:00:00.000Z"));
  const canonical = observation("turn.accepted");

  const result = inbox.enqueueObservation(canonical);
  assert.equal(result.created, true);
  assert.equal(result.event.type, "runtime-observation");
  assert.deepEqual(inbox.list(), [result.event]);
  assert.equal("adapterId" in result.event, false);
});

test("the runtime inbox orders same-millisecond Hook facts by their monotonic sequence", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-runtime-sequence-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const inbox = new FileRuntimeEventInbox(home);
  const base = observation("turn.accepted");
  const later = createRuntimeObservation({ ...base, eventId: "a-later", sequence: 2 });
  const earlier = createRuntimeObservation({ ...base, eventId: "z-earlier", sequence: 1 });

  inbox.enqueueObservation(later);
  inbox.enqueueObservation(earlier);
  assert.deepEqual(
    inbox.list().map((event) => event.observation.eventId),
    ["z-earlier", "a-later"]
  );
});

test("the runtime inbox honors semantic ordinal within one Hook occurrence", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-runtime-ordinal-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const inbox = new FileRuntimeEventInbox(home);
  const base = observation("turn.accepted");
  const accepted = createRuntimeObservation({
    ...base,
    eventId: "z-accepted",
    sequence: 1,
    ordinal: 0
  });
  const usage = createRuntimeObservation({
    ...base,
    eventId: "a-usage",
    kind: "activity.observed",
    sequence: 1,
    ordinal: 1,
    payload: { activity: "model", usage: { inputTokens: 10, outputTokens: 0 } }
  });
  inbox.enqueueObservation(usage);
  inbox.enqueueObservation(accepted);
  assert.deepEqual(
    inbox.list().map((event) => event.observation.eventId),
    ["z-accepted", "a-usage"]
  );
});
