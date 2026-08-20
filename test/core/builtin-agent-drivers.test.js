import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUILTIN_AGENT_DRIVERS,
  builtinAgentDriverRegistry
} from "../../dist/runtime/builtinAgentDrivers.js";
import {
  mapAgentDriverHook,
  mapAgentDriverUsage
} from "../../dist/runtime/agentDriverObservation.js";
import {
  claudeTranscriptUsage,
  codexTranscriptUsage
} from "../../dist/runtime/builtinTranscriptUsage.js";
import {
  claudeTranscriptObserver,
  codexTranscriptObserver
} from "../../dist/runtime/builtinTranscriptObserver.js";

const BASE_FENCE = Object.freeze({
  taskId: "task-1",
  roleName: "worker",
  runId: "run-1",
  agentId: "agent-1",
  driverId: "anthropic/claude-code",
  launchId: "launch-1",
  sessionGenerationId: "launch-1",
  nativeSessionId: "session-1",
  nativeTurnId: "run-1",
  receiptId: "receipt-1"
});

test("built-in Drivers are ordinary registry entries with exact managed-runtime capabilities", () => {
  assert.deepEqual(BUILTIN_AGENT_DRIVERS.map(({ id }) => id), [
    "anthropic/claude-code",
    "openai/codex"
  ]);
  assert.equal(
    builtinAgentDriverRegistry().require("openai/codex")
      .capabilities.observation.promptAcceptance,
    "exact"
  );
  assert.equal(
    builtinAgentDriverRegistry().require("openai/codex")
      .capabilities.observation.usage,
    "streaming-cumulative"
  );
  assert.deepEqual(
    builtinAgentDriverRegistry().require("openai/codex")
      .capabilities.observation.operations,
    ["tool", "subagent"]
  );
  assert.deepEqual(
    builtinAgentDriverRegistry().require("anthropic/claude-code")
      .capabilities.observation.waiting,
    ["permission"]
  );
});

test("Claude hooks map at the Driver edge into provider-neutral operations and waiting", () => {
  const driver = builtinAgentDriverRegistry().require("anthropic/claude-code");
  const started = mapAgentDriverHook({
    driver,
    hookEventName: "PreToolUse",
    receivedAt: "2026-08-19T00:00:00.000Z",
    fence: BASE_FENCE,
    payload: { tool_use_id: "tool-1" }
  });
  assert.equal(started.kind, "operation.started");
  assert.deepEqual(started.payload, { operationId: "tool-1", operation: "tool" });

  const waiting = mapAgentDriverHook({
    driver,
    hookEventName: "PermissionRequest",
    receivedAt: "2026-08-19T00:00:01.000Z",
    occurrenceId: "permission-occurrence-1",
    fence: BASE_FENCE,
    payload: {}
  });
  assert.equal(waiting.kind, "turn.waiting");
  assert.equal(waiting.payload.reason, "permission");
  assert.equal(waiting.payload.waitId, "permission-occurrence-1");
});

test("permission episodes without provider ids retain distinct canonical identities", () => {
  const driver = builtinAgentDriverRegistry().require("openai/codex");
  const fence = { ...BASE_FENCE, driverId: "openai/codex" };
  const map = (occurrenceId) => mapAgentDriverHook({
    driver,
    hookEventName: "PermissionRequest",
    occurrenceId,
    receivedAt: "2026-08-19T00:00:01.000Z",
    fence,
    payload: {}
  });
  const first = map("permission-occurrence-1");
  const second = map("permission-occurrence-2");
  assert.notEqual(first.eventId, second.eventId);
  assert.notEqual(first.payload.waitId, second.payload.waitId);
});

test("Codex hooks map subagents and Stop without leaking native names into canonical kinds", () => {
  const driver = builtinAgentDriverRegistry().require("openai/codex");
  const fence = { ...BASE_FENCE, driverId: "openai/codex" };
  const child = mapAgentDriverHook({
    driver,
    hookEventName: "SubagentStart",
    receivedAt: "2026-08-19T00:00:00.000Z",
    fence,
    payload: { agent_id: "child-1" }
  });
  assert.equal(child.kind, "operation.started");
  assert.equal(child.payload.operation, "subagent");

  const completed = mapAgentDriverHook({
    driver,
    hookEventName: "Stop",
    receivedAt: "2026-08-19T00:00:02.000Z",
    fence,
    payload: {}
  });
  assert.equal(completed.kind, "turn.completed");
  assert.equal(Object.values(completed).includes("Stop"), false);
});

test("a retried native Hook keeps one content-derived canonical event identity", () => {
  const driver = builtinAgentDriverRegistry().require("anthropic/claude-code");
  const map = (receivedAt, sequence) => mapAgentDriverHook({
    driver,
    hookEventName: "PreToolUse",
    receivedAt,
    sequence,
    fence: BASE_FENCE,
    payload: { tool_use_id: "tool-replayed" }
  });

  assert.equal(
    map("2026-08-19T00:00:00.000Z", 1).eventId,
    map("2026-08-19T00:00:01.000Z", 2).eventId
  );
});

test("built-in transcript readers normalize cumulative token snapshots", () => {
  const codex = codexTranscriptUsage([
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 80,
          output_tokens: 20,
          reasoning_output_tokens: 5
        } }
      }
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: {
          input_tokens: 150,
          cached_input_tokens: 90,
          output_tokens: 30,
          reasoning_output_tokens: 7
        } }
      }
    })
  ].join("\n"));
  assert.deepEqual(codex, {
    inputTokens: 150,
    outputTokens: 30,
    cachedInputTokens: 90,
    reasoningTokens: 7
  });

  const claude = claudeTranscriptUsage([
    JSON.stringify({ type: "assistant", message: {
      id: "message-1",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 5,
        output_tokens: 4
      }
    } }),
    // A later finalized copy of the same provider message replaces the first;
    // it must not be counted twice.
    JSON.stringify({ type: "assistant", message: {
      id: "message-1",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 5,
        output_tokens: 6
      }
    } }),
    JSON.stringify({ type: "assistant", message: {
      id: "message-2",
      usage: { input_tokens: 3, output_tokens: 2 }
    } }),
    // Identity-free streaming fragments are ambiguous and fail closed.
    JSON.stringify({ type: "assistant", message: {
      usage: { input_tokens: 999, output_tokens: 999 }
    } })
  ].join("\n"));
  assert.deepEqual(claude, {
    inputTokens: 58,
    outputTokens: 8,
    cachedInputTokens: 45
  });
});

test("usage snapshots become model activity without provider fields", () => {
  const observation = mapAgentDriverUsage({
    driver: builtinAgentDriverRegistry().require("anthropic/claude-code"),
    hookEventName: "PostToolUse",
    receivedAt: "2026-08-19T00:00:02.000Z",
    fence: BASE_FENCE,
    payload: {}
  }, { inputTokens: 500, outputTokens: 25, cachedInputTokens: 400 });
  assert.equal(observation.kind, "activity.observed");
  assert.equal(observation.payload.activity, "model");
  assert.equal(observation.payload.usage.inputTokens, 500);
});

test("transcript observers read bounded increments and surface health", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "yui-transcript-observer-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const codexPath = join(directory, "codex.jsonl");
  writeFileSync(codexPath, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: {
      input_tokens: 10,
      output_tokens: 1
    } } }
  })}\n`);
  const source = {
    schemaVersion: 1,
    sourceId: "codex-source",
    transport: "append-only-jsonl",
    locator: codexPath
  };
  const baseline = await codexTranscriptObserver(source);
  assert.equal(baseline.status, "healthy");
  assert.deepEqual(baseline.usage, { inputTokens: 10, outputTokens: 1 });
  appendFileSync(codexPath, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: {
      input_tokens: 10,
      output_tokens: 3
    } } }
  })}\n`);
  const advanced = await codexTranscriptObserver(source, baseline.cursor);
  assert.deepEqual(advanced.usage, { inputTokens: 10, outputTokens: 3 });

  const claudePath = join(directory, "claude.jsonl");
  writeFileSync(claudePath, `${JSON.stringify({ type: "assistant", message: {
    id: "message-1",
    usage: { input_tokens: 2, output_tokens: 1 }
  } })}\n`);
  const claude = await claudeTranscriptObserver({
    ...source,
    sourceId: "claude-source",
    locator: claudePath
  });
  assert.deepEqual(claude.usage, {
    inputTokens: 2,
    outputTokens: 1,
    cachedInputTokens: 0
  });

  const unavailable = await codexTranscriptObserver({
    ...source,
    locator: join(directory, "missing.jsonl")
  });
  assert.equal(unavailable.status, "unavailable");
  assert.match(unavailable.detail, /ENOENT/);
});
