import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexAppServerRuntime, CodexPreSubmissionError
} from "../../dist/runtime/codexAppServerRuntime.js";
import { FencedProviderControl } from "../../dist/runtime/providerControl.js";
import { createProviderRuntimeBinding } from "../../dist/runtime/providerRuntimeIdentity.js";

const input = {
  conversationId: "same-session", attemptId: "recovery-1",
  text: "Continue only unfinished work.", expectedNoActiveTurn: true,
  expectedFailedNativeTurnId: "failed-turn"
};

function fixture({
  status = "systemError",
  latest = { id: "failed-turn", status: "failed" },
  backgrounds = { data: [], nextCursor: null }
} = {}) {
  const calls = [];
  const runtime = new CodexAppServerRuntime({
    request: async (method, params) => {
      calls.push({ method, params });
      switch (method) {
        case "thread/read":
          return { thread: { id: "same-session", status: { type: status }, turns: [] } };
        case "thread/turns/list": return { data: latest === null ? [] : [latest], nextCursor: null };
        case "thread/backgroundTerminals/list": return backgrounds;
        case "turn/start": return { turn: { id: "recovery-turn" } };
        default: throw new Error(`Unexpected operation: ${method}`);
      }
    }
  });
  return { calls, runtime };
}

test("Codex retry admits only the exact failed latest Turn with no background execution", async () => {
  for (const status of ["systemError", "idle"]) {
    const { runtime, calls } = fixture({ status });
    const binding = createProviderRuntimeBinding({
      providerNamespace: "openai/codex", accountScope: "test",
      conversationId: input.conversationId, startedAt: "2026-09-13T00:00:00Z"
    });
    const result = await new FencedProviderControl(runtime).submitTurn({
      binding,
      fence: {
        conversationId: input.conversationId, authorityEpoch: 1,
        authorityOwner: "controller", holderId: "controller"
      },
      attemptId: input.attemptId, text: input.text,
      expectedFailedNativeTurnId: input.expectedFailedNativeTurnId
    });
    assert.deepEqual(result, { status: "accepted", turnId: "recovery-turn" });
    assert.deepEqual(calls.map(c => c.method), [
      "thread/read", "thread/turns/list", "thread/backgroundTerminals/list", "turn/start"
    ]);
    assert.equal(calls[0].params.includeTurns, false);
    assert.deepEqual(calls[1].params, {
      threadId: "same-session", limit: 1, sortDirection: "desc", itemsView: "notLoaded"
    });
    assert.deepEqual(calls[2].params, { threadId: "same-session", limit: 1 });
    assert.equal(calls[3].params.clientUserMessageId, input.attemptId);
  }
});

test("uncertain, changed or occupied native retry evidence never mutates the Session", async () => {
  for (const status of ["idle", "systemError"]) {
    for (const scenario of [
      { status: "active" },
      { status: "notLoaded" },
      { latest: null },
      { latest: { id: "newer-turn", status: "failed" } },
      { latest: { id: "newer-turn", status: "inProgress" } },
      { latest: { id: "failed-turn", status: "completed" } },
      { backgrounds: { data: [{ id: "still-running" }], nextCursor: null } },
      { backgrounds: { data: [], nextCursor: "more" } },
      { backgrounds: { data: [] } }
    ]) {
      const { runtime, calls } = fixture({ status, ...scenario });
      let result;
      try {
        result = await runtime.submitTurn({ ...input, expectedNoActiveTurn: false });
      } catch (error) {
        assert.ok(error instanceof CodexPreSubmissionError);
      }
      assert.notEqual(result?.status, "accepted", JSON.stringify(scenario));
      assert.ok(calls.every(c => [
        "thread/read", "thread/turns/list", "thread/backgroundTerminals/list"
      ].includes(c.method)), JSON.stringify(scenario));
    }
  }
  const ordinary = fixture();
  const { expectedFailedNativeTurnId: _failedTurn, ...ordinaryInput } = input;
  await assert.rejects(ordinary.runtime.submitTurn(ordinaryInput), CodexPreSubmissionError);
  assert.deepEqual(ordinary.calls.map(c => c.method), ["thread/read"]);
  const idle = fixture({ status: "idle" });
  assert.equal((await idle.runtime.submitTurn(ordinaryInput)).status, "accepted");
  assert.deepEqual(idle.calls.map(c => c.method), ["thread/read", "turn/start"]);
});

test("read and resume preserve complete native terminal error evidence", async () => {
  const rawError = {
    message: "Too many requests",
    codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
    headers: { "Retry-After": "30" }
  };
  const runtime = new CodexAppServerRuntime({
    request: async (method) => {
      assert.ok(["thread/read", "thread/resume"].includes(method));
      return { thread: {
        id: input.conversationId, status: { type: "systemError" },
        turns: [{ id: "failed-turn", status: "failed", error: rawError }]
      } };
    }
  });
  for (const snapshot of [
    await runtime.readConversation(input.conversationId),
    await runtime.resumeConversation(input.conversationId)
  ]) {
    assert.equal(snapshot.turns[0].error, rawError.message);
    assert.deepEqual(JSON.parse(snapshot.turns[0].rawError), rawError);
  }
});
