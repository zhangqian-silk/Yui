import assert from "node:assert/strict";
import { test } from "node:test";

import { createInputRequest } from "../../dist/input/inputRequest.js";
import { createTaskMessage } from "../../dist/message/message.js";
import {
  createInputRequestOperatorPresentation,
  createTaskMessageOperatorPresentation,
  createTaskTerminalOperatorPresentation
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
    inputRequest({ kind: "required" })
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
  const presentation = createInputRequestOperatorPresentation(inputRequest({
    kind: "recommended",
    recommendedChoiceKey: "safe",
    timeoutAt: TIMEOUT_AT
  }));

  assert.equal(presentation.category, "attention");
  assert.equal(presentation.receiptId, "input-request:input-7");
  assert.match(presentation.text, /Agent recommendation: safe: Safe rollout/);
  assert.match(presentation.text, new RegExp(`Automatic fallback after: ${TIMEOUT_AT}`));
  assert.match(presentation.text, /do not answer or choose on the user's behalf/i);
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

  const presentation = createInputRequestOperatorPresentation(request);
  assert.match(presentation.text, /Answer type: free text/);
  assert.match(presentation.text, /yui task input answer input-8 --text "<answer>"/);
  assert.doesNotMatch(presentation.text, /Choices:/);
});

test("TaskMessage and Task terminal constructors remain narrow and deterministic", () => {
  const message = createTaskMessage(
    "message-9",
    "Worker finished the focused checks.",
    "role-result",
    { type: "role", roleName: "worker-1" },
    CREATED_AT,
    { runId: "agent-run-9" }
  );

  const progress = createTaskMessageOperatorPresentation("task-3", message);
  assert.deepEqual(
    {
      category: progress.category,
      receiptId: progress.receiptId,
      source: progress.source
    },
    {
      category: "progress",
      receiptId: "task-message:task-3:message-9",
      source: { kind: "task-message", id: "message-9" }
    }
  );
  assert.match(progress.text, /Worker finished the focused checks\./);
  assert.match(progress.text, /worker-1/);
  assert.match(progress.text, /do not describe the Task as complete/i);

  const terminal = createTaskTerminalOperatorPresentation({
    taskId: "task-3",
    eventId: "event-12",
    status: "failed",
    summary: "Integration checks failed."
  });
  assert.deepEqual(
    {
      category: terminal.category,
      receiptId: terminal.receiptId,
      source: terminal.source
    },
    {
      category: "terminal",
      receiptId: "task-terminal:task-3:event-12",
      source: { kind: "task-terminal", id: "event-12" }
    }
  );
  assert.match(terminal.text, /Task status: failed/);
  assert.match(terminal.text, /Integration checks failed\./);
});
