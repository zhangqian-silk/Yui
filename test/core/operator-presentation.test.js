import assert from "node:assert/strict";
import { test } from "node:test";

import { createInputRequest } from "../../dist/input/inputRequest.js";
import {
  createInputRequestOperatorPresentation,
  createLeaderRecoveryOperatorPresentation,
  createLeaderStallOperatorPresentation
} from "../../dist/interaction/operatorPresentation.js";

const CREATED_AT = new Date("2026-07-23T01:00:00.000Z");
const TIMEOUT_AT = "2026-07-23T01:05:00.000Z";

function inputRequest(policy) {
  return createInputRequest(
    "input-7",
    "task-3",
    {
      roleName: "leader",
      agentId: "codex",
      runId: "agent-run-8",
      nativeSessionId: "native-2"
    },
    {
      question: "Which rollout should we use?",
      choices: [
        { key: "safe", label: "Safe rollout" },
        { key: "fast", label: "Fast rollout" }
      ],
      blockedRefs: [{ type: "run", id: "agent-run-8" }],
      policy
    },
    CREATED_AT
  );
}

test("required InputRequest becomes an attention presentation that only the user may answer", () => {
  const presentation = createInputRequestOperatorPresentation(
    inputRequest({ kind: "required" }),
    { timeZone: "Asia/Shanghai" }
  );

  assert.deepEqual(
    {
      category: presentation.category,
      taskId: presentation.taskId,
      receiptId: presentation.receiptId,
      source: presentation.source
    },
    {
      category: "attention",
      taskId: "task-3",
      receiptId: "input-request:input-7",
      source: { kind: "input-request", id: "input-7" }
    }
  );
  assert.match(presentation.text, /Which rollout should we use\?/);
  assert.match(presentation.text, /safe: Safe rollout/);
  assert.match(presentation.text, /fast: Fast rollout/);
  assert.match(presentation.text, /requires the user's response/i);
  assert.match(presentation.text, /do not answer or choose on the user's behalf/i);
  assert.match(presentation.text, /yui task input answer input-7 --choice <key>/);
  assert.doesNotMatch(presentation.text, /automatic fallback after/i);
});

test("recommended InputRequest identifies its recommendation and automatic fallback deadline", () => {
  const request = inputRequest({
    kind: "recommended",
    recommendedChoiceKey: "safe",
    timeoutAt: TIMEOUT_AT
  });
  const presentation = createInputRequestOperatorPresentation(
    request,
    { timeZone: "America/New_York" }
  );

  assert.equal(presentation.category, "attention");
  assert.equal(presentation.receiptId, "input-request:input-7");
  assert.match(presentation.text, /Agent recommendation: safe: Safe rollout/);
  assert.match(
    presentation.text,
    /Automatic fallback after: 2026-07-22 21:05:00 -04:00/
  );
  assert.doesNotMatch(presentation.text, new RegExp(TIMEOUT_AT));
  assert.match(presentation.text, /do not answer or choose on the user's behalf/i);

  assert.match(
    createInputRequestOperatorPresentation(request, {}).text,
    /Automatic fallback after: 2026-07-23 09:05:00 \+08:00/
  );
});

test("free-text InputRequest renders the native answer command without inventing choices", () => {
  const request = createInputRequest(
    "input-8",
    "task-3",
    {
      roleName: "leader",
      agentId: "codex",
      runId: "agent-run-8"
    },
    {
      question: "Describe the rollout constraint.",
      choices: [],
      blockedRefs: []
    },
    CREATED_AT
  );

  const presentation = createInputRequestOperatorPresentation(request, {});
  assert.match(presentation.text, /Answer type: free text/);
  assert.match(presentation.text, /yui task input answer input-8 --text "<answer>"/);
  assert.doesNotMatch(presentation.text, /Choices:/);
});

test("Leader recovery failure is an attention-only Operator presentation", () => {
  const presentation = createLeaderRecoveryOperatorPresentation({
    schemaVersion: 1,
    taskId: "task-3",
    type: "leader-recovery-failed",
    message: "Leader ended two consecutive Turns without closing its Run.",
    createdAt: CREATED_AT.toISOString(),
    updatedAt: CREATED_AT.toISOString()
  });

  assert.deepEqual(
    {
      category: presentation.category,
      receiptId: presentation.receiptId,
      source: presentation.source
    },
    {
      category: "attention",
      receiptId: `leader-recovery:task-3:${CREATED_AT.toISOString()}`,
      source: { kind: "leader-recovery", id: "task-3" }
    }
  );
  assert.match(presentation.text, /needs user attention/i);
  assert.match(presentation.text, /Leader ended two consecutive Turns/);
  assert.match(presentation.text, /yui jobs list/);
  assert.match(presentation.text, /yui jobs retry leader-recovery:task-3/);
  assert.doesNotMatch(presentation.text, /yui job show/);
});

test("Leader stall keeps the exact Run and semantic progress evidence in Operator attention", () => {
  const presentation = createLeaderStallOperatorPresentation({
    schemaVersion: 1,
    taskId: "task-3",
    type: "leader-stalled",
    message: "Leader Run agent-run-9 is truly stalled.",
    runId: "agent-run-9",
    progressAt: CREATED_AT.toISOString(),
    classification: "truly-stalled",
    evidenceKey: "execution-stalled:mailbox-pending",
    createdAt: CREATED_AT.toISOString(),
    updatedAt: CREATED_AT.toISOString()
  });
  assert.equal(presentation.category, "attention");
  assert.equal(
    presentation.receiptId,
    `leader-stall:task-3:agent-run-9:${CREATED_AT.toISOString()}`
  );
  assert.deepEqual(presentation.source, {
    kind: "leader-stall",
    id: `agent-run-9:${CREATED_AT.toISOString()}`
  });
  assert.match(presentation.text, /truly stalled/i);
  assert.match(presentation.text, /agent-run-9/);
  assert.match(presentation.text, /no automatic Enter, reset, retry, kill/i);
});
