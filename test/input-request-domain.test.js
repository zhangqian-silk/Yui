import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_INPUT_QUESTION_LENGTH,
  InputRequestStateError,
  answerInputRequest,
  autoResolveInputRequest,
  cancelInputRequest,
  createInputRequest,
  createInputRequestEventPayload,
  createInputResolutionEventPayload,
  inputResolutionSourceLabel,
  supersedeInputRequest
} from "../dist/input/inputRequest.js";

const now = new Date("2026-07-12T12:00:00.000Z");

function requester(overrides = {}) {
  return {
    roleName: "leader",
    agentId: "codex",
    adapterId: "codex",
    sessionRoot: "/tmp",
    nativeSessionId: "session-1",
    agentRunId: "agent-run-1",
    ...overrides
  };
}

test("creates a normalized user-required request without recommendation fields", () => {
  const request = createInputRequest(
    "input-1",
    "task-1",
    requester(),
    {
      question: "  Which release path should we use?\r\n",
      choices: [
        { key: "safe", label: " Safe path " },
        { key: "fast", label: "Fast path", description: " Existing authority only " }
      ],
      blockedRefs: [{ type: "work-item", id: "work-item-1" }],
      resolutionPolicy: { mode: "user-required" }
    },
    now
  );

  assert.deepEqual(request, {
    schemaVersion: 1,
    id: "input-1",
    taskId: "task-1",
    requester: requester(),
    question: "Which release path should we use?",
    choices: [
      { key: "safe", label: "Safe path" },
      { key: "fast", label: "Fast path", description: "Existing authority only" }
    ],
    blockedRefs: [{ type: "work-item", id: "work-item-1" }],
    resolutionPolicy: { mode: "user-required" },
    status: "open",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  });
  assert.equal("recommendation" in request.resolutionPolicy, false);
  assert.equal("offlineTimeoutMs" in request.resolutionPolicy, false);
});

test("canonicalizes requester fields instead of persisting caller-owned extras", () => {
  const request = createInputRequest(
    "input-requester",
    "task-1",
    requester({ unexpected: "must not persist" }),
    {
      question: "Question",
      choices: [],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    },
    now
  );

  assert.deepEqual(request.requester, requester());
});

test("creates a validated offline-recommended request", () => {
  const request = createInputRequest(
    "input-2",
    "task-1",
    requester(),
    {
      question: "Which safe retry should run?",
      choices: [
        { key: "retry-once", label: " Retry once " },
        { key: "stop", label: "Stop" }
      ],
      blockedRefs: [{ type: "decision", id: "decision-1" }],
      resolutionPolicy: {
        mode: "offline-recommended",
        recommendation: { choiceKey: "retry-once", reason: " Already delegated and reversible. " },
        offlineTimeoutMs: 30_000
      }
    },
    now
  );

  assert.deepEqual(request.resolutionPolicy, {
    mode: "offline-recommended",
    recommendation: {
      choiceKey: "retry-once",
      reason: "Already delegated and reversible."
    },
    offlineTimeoutMs: 30_000
  });
});

test("rejects invalid questions, choices, blocked references, and policies", () => {
  const valid = {
    question: "Choose",
    choices: [{ key: "safe", label: "Safe" }],
    blockedRefs: [{ type: "work-item", id: "work-item-1" }],
    resolutionPolicy: { mode: "user-required" }
  };

  assert.throws(
    () => createInputRequest(1, "task-1", requester(), valid, now),
    /Input request id is invalid/
  );
  assert.throws(
    () => createInputRequest("input-1", "task-1", requester(), { ...valid, question: " \r\n " }, now),
    /Input request question is required/
  );
  assert.throws(
    () => createInputRequest(
      "input-1",
      "task-1",
      requester(),
      { ...valid, question: "x".repeat(MAX_INPUT_QUESTION_LENGTH + 1) },
      now
    ),
    /Input request question is too long/
  );
  assert.throws(
    () => createInputRequest(
      "input-1",
      "task-1",
      requester(),
      { ...valid, choices: [{ key: "same", label: "One" }, { key: "same", label: "Two" }] },
      now
    ),
    /Choice keys must be unique/
  );
  assert.throws(
    () => createInputRequest(
      "input-1",
      "task-1",
      requester(),
      { ...valid, choices: [{ key: "not allowed", label: "Invalid" }] },
      now
    ),
    /Invalid choice key/
  );
  assert.throws(
    () => createInputRequest(
      "input-1",
      "task-1",
      requester(),
      { ...valid, blockedRefs: [{ type: "work-item", id: " " }] },
      now
    ),
    /Invalid blocked reference/
  );
  assert.throws(
    () => createInputRequest(
      "input-1",
      "task-1",
      requester(),
      {
        ...valid,
        resolutionPolicy: {
          mode: "offline-recommended",
          recommendation: { choiceKey: "safe", reason: " " },
          offlineTimeoutMs: 1
        }
      },
      now
    ),
    /Recommendation reason is required/
  );
  assert.throws(
    () => createInputRequest(
      "input-1",
      "task-1",
      requester(),
      {
        ...valid,
        resolutionPolicy: {
          mode: "offline-recommended",
          recommendation: { choiceKey: "safe", reason: "Safe" },
          offlineTimeoutMs: 0
        }
      },
      now
    ),
    /Offline timeout must be positive/
  );
  assert.throws(
    () => createInputRequest(
      "input-1",
      "task-1",
      requester(),
      {
        ...valid,
        resolutionPolicy: {
          mode: "offline-recommended",
          recommendation: { choiceKey: "missing", reason: "Safe" },
          offlineTimeoutMs: 1
        }
      },
      now
    ),
    /Recommended choice does not exist/
  );
});

test("bounds requester metadata, choices, and blocked references", () => {
  const valid = {
    question: "Question",
    choices: [],
    blockedRefs: [],
    resolutionPolicy: { mode: "user-required" }
  };
  assert.throws(
    () => createInputRequest(
      "input-requester-long",
      "task-1",
      requester({ agentId: "x".repeat(1025) }),
      valid,
      now
    ),
    /Invalid input requester/
  );
  assert.throws(
    () => createInputRequest(
      "input-requester-unicode",
      "task-1",
      requester({ nativeSessionId: "broken-\ud800" }),
      valid,
      now
    ),
    /Invalid input requester/
  );
  assert.throws(
    () => createInputRequest(
      "input-requester-control",
      "task-1",
      requester({ agentId: "codex\nforged" }),
      valid,
      now
    ),
    /Invalid input requester/
  );
  assert.throws(
    () => createInputRequest(
      "input-too-many-choices",
      "task-1",
      requester(),
      {
        ...valid,
        choices: Array.from({ length: 101 }, (_, index) => ({
          key: `choice-${index}`,
          label: `Choice ${index}`
        }))
      },
      now
    ),
    /Too many input choices/
  );
  assert.throws(
    () => createInputRequest(
      "input-too-many-blocked",
      "task-1",
      requester(),
      {
        ...valid,
        blockedRefs: Array.from({ length: 1001 }, (_, index) => ({
          type: "work-item",
          id: `work-item-${index}`
        }))
      },
      now
    ),
    /Too many blocked references/
  );
});

test("does not reflect rejected choice values into errors", () => {
  const secret = "SYNTHETIC_CHOICE_SECRET_91d77e";
  const capture = (action) => {
    assert.throws(action, (error) => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  };

  capture(() => createInputRequest(
    "input-secret-key",
    "task-1",
    requester(),
    {
      question: "Question",
      choices: [{ key: `${secret} invalid`, label: "Label" }],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    },
    now
  ));
  capture(() => createInputRequest(
    "input-secret-recommendation",
    "task-1",
    requester(),
    {
      question: "Question",
      choices: [{ key: "safe", label: "Safe" }],
      blockedRefs: [],
      resolutionPolicy: {
        mode: "offline-recommended",
        recommendation: { choiceKey: secret, reason: "Reason" },
        offlineTimeoutMs: 1
      }
    },
    now
  ));
  const request = createInputRequest(
    "input-secret-answer",
    "task-1",
    requester(),
    {
      question: "Question",
      choices: [{ key: "safe", label: "Safe" }],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    },
    now
  );
  capture(() => answerInputRequest(
    request,
    "resolution-secret-answer",
    { choiceKey: secret, text: "ignored" },
    "online",
    now
  ));
  capture(() => createInputRequest(
    "input-secret-label",
    "task-1",
    requester(),
    {
      question: "Question",
      choices: [{ key: secret, label: " " }],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    },
    now
  ));
  capture(() => createInputRequest(
    "input-secret-description",
    "task-1",
    requester(),
    {
      question: "Question",
      choices: [{ key: secret, label: "Label", description: " " }],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    },
    now
  ));
});

test("rejects sparse request arrays before constructing an unpersistable record", () => {
  const choices = [];
  choices.length = 1;
  const blockedRefs = [];
  blockedRefs.length = 1;

  assert.throws(
    () => createInputRequest(
      "input-sparse-choices",
      "task-1",
      requester(),
      {
        question: "Question",
        choices,
        blockedRefs: [],
        resolutionPolicy: { mode: "user-required" }
      },
      now
    ),
    /Input choices must be a dense array/
  );
  assert.throws(
    () => createInputRequest(
      "input-sparse-blocked",
      "task-1",
      requester(),
      {
        question: "Question",
        choices: [],
        blockedRefs,
        resolutionPolicy: { mode: "user-required" }
      },
      now
    ),
    /Blocked references must be a dense array/
  );
});

test("answers an open request and links a user resolution", () => {
  const request = createInputRequest(
    "input-3",
    "task-1",
    requester(),
    {
      question: "Choose",
      choices: [{ key: "safe", label: "Safe path" }],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    },
    now
  );
  const resolvedAt = new Date("2026-07-12T12:05:00.000Z");

  const result = answerInputRequest(
    request,
    "resolution-1",
    { choiceKey: "safe", text: " Safe path " },
    "online",
    resolvedAt
  );

  assert.equal(result.request.status, "answered");
  assert.equal(result.request.resolutionId, "resolution-1");
  assert.equal(result.request.updatedAt, resolvedAt.toISOString());
  assert.deepEqual(result.resolution, {
    schemaVersion: 1,
    id: "resolution-1",
    requestId: "input-3",
    taskId: "task-1",
    source: "user",
    answer: { choiceKey: "safe", text: "Safe path" },
    operatorPresence: "online",
    resolvedAt: resolvedAt.toISOString()
  });
});

test("auto-resolves only an offline-recommended request without claiming user confirmation", () => {
  const request = createInputRequest(
    "input-4",
    "task-1",
    requester(),
    {
      question: "Choose",
      choices: [{ key: "retry", label: "Retry once" }],
      blockedRefs: [],
      resolutionPolicy: {
        mode: "offline-recommended",
        recommendation: { choiceKey: "retry", reason: "Reversible retry" },
        offlineTimeoutMs: 60_000
      }
    },
    now
  );

  const result = autoResolveInputRequest(
    request,
    "resolution-2",
    "offline",
    new Date("2026-07-12T12:01:00.000Z")
  );

  assert.equal(result.request.status, "auto-resolved");
  assert.deepEqual(result.resolution, {
    schemaVersion: 1,
    id: "resolution-2",
    requestId: "input-4",
    taskId: "task-1",
    source: "offline-recommended",
    answer: { choiceKey: "retry", text: "Retry once" },
    recommendationReason: "Reversible retry",
    operatorPresence: "offline",
    resolvedAt: "2026-07-12T12:01:00.000Z"
  });
});

test("supports every terminal transition and the first terminal transition wins", () => {
  const create = (id) => createInputRequest(
    id,
    "task-1",
    requester(),
    {
      question: "Still needed?",
      choices: [],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    },
    now
  );
  const changedAt = new Date("2026-07-12T12:10:00.000Z");

  const cancelled = cancelInputRequest(create("input-5"), " No longer relevant ", changedAt);
  assert.deepEqual(cancelled.cancelled, {
    reason: "No longer relevant",
    cancelledAt: changedAt.toISOString()
  });
  const superseded = supersedeInputRequest(
    create("input-6"),
    "input-7",
    "Question changed",
    changedAt
  );
  assert.deepEqual(superseded.superseded, {
    replacementRequestId: "input-7",
    reason: "Question changed",
    supersededAt: changedAt.toISOString()
  });

  assert.throws(
    () => cancelInputRequest(cancelled, "Again", changedAt),
    /Input request input-5 is already cancelled/
  );
  assert.throws(
    () => answerInputRequest(cancelled, "resolution-3", { text: "Late" }, "online", changedAt),
    /Input request input-5 is already cancelled/
  );
  assert.throws(
    () => autoResolveInputRequest(create("input-8"), "resolution-4", "offline", changedAt),
    /does not allow automatic resolution/
  );
});

test("measures question limits as well-formed UTF-8 bytes", () => {
  const input = {
    choices: [],
    blockedRefs: [],
    resolutionPolicy: { mode: "user-required" }
  };
  assert.throws(
    () => createInputRequest(
      "input-utf8",
      "task-1",
      requester(),
      { ...input, question: "😀".repeat(Math.floor(MAX_INPUT_QUESTION_LENGTH / 4) + 1) },
      now
    ),
    /Input request question is too long/
  );
  assert.throws(
    () => createInputRequest(
      "input-utf16",
      "task-1",
      requester(),
      { ...input, question: "broken \ud800 text" },
      now
    ),
    /Input request question is not valid Unicode/
  );
});

test("derives canonical choice answer text from the stored choice", () => {
  const request = createInputRequest(
    "input-canonical",
    "task-1",
    requester(),
    {
      question: "Choose",
      choices: [{ key: "safe", label: "Canonical safe label" }],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    },
    now
  );
  const { resolution } = answerInputRequest(
    request,
    "resolution-canonical",
    { choiceKey: "safe", text: "forged caller text" },
    "online",
    now
  );
  assert.deepEqual(resolution.answer, { choiceKey: "safe", text: "Canonical safe label" });
});

test("automatic resolution requires the Controller to supply offline presence", () => {
  const request = createInputRequest(
    "input-presence",
    "task-1",
    requester(),
    {
      question: "Choose",
      choices: [{ key: "safe", label: "Safe" }],
      blockedRefs: [],
      resolutionPolicy: {
        mode: "offline-recommended",
        recommendation: { choiceKey: "safe", reason: "Already delegated" },
        offlineTimeoutMs: 1
      }
    },
    now
  );

  assert.throws(
    () => autoResolveInputRequest(request, "resolution-online", "online", now),
    /requires offline Operator presence/
  );
  assert.throws(
    () => answerInputRequest(request, "resolution-invalid", { choiceKey: "safe", text: "Safe" }, "away", now),
    /Invalid Operator presence/
  );
});

test("every terminal state rejects every later terminal transition with a typed conflict", () => {
  const userRequest = createInputRequest(
    "input-user-terminal",
    "task-1",
    requester(),
    { question: "Choose", choices: [], blockedRefs: [], resolutionPolicy: { mode: "user-required" } },
    now
  );
  const autoRequest = createInputRequest(
    "input-auto-terminal",
    "task-1",
    requester(),
    {
      question: "Choose",
      choices: [{ key: "safe", label: "Safe" }],
      blockedRefs: [],
      resolutionPolicy: {
        mode: "offline-recommended",
        recommendation: { choiceKey: "safe", reason: "Safe" },
        offlineTimeoutMs: 1
      }
    },
    now
  );
  const terminals = [
    answerInputRequest(userRequest, "resolution-user", { text: "Answer" }, "online", now).request,
    autoResolveInputRequest(autoRequest, "resolution-auto", "offline", now).request,
    cancelInputRequest({ ...userRequest, id: "input-cancel-terminal" }, "Cancelled", now),
    supersedeInputRequest(
      { ...userRequest, id: "input-super-terminal" },
      "input-replacement",
      "Replaced",
      now
    )
  ];

  for (const terminal of terminals) {
    const actions = [
      () => answerInputRequest(terminal, "resolution-late", { text: "Late" }, "online", now),
      () => autoResolveInputRequest(terminal, "resolution-late", "offline", now),
      () => cancelInputRequest(terminal, "Late", now),
      () => supersedeInputRequest(terminal, "input-late", "Late", now)
    ];
    for (const action of actions) {
      assert.throws(action, (error) => {
        assert.equal(error instanceof InputRequestStateError, true);
        assert.equal(error.requestId, terminal.id);
        assert.equal(error.status, terminal.status);
        return true;
      });
    }
  }
});

test("rejects terminal transitions whose timestamp predates request creation", () => {
  const request = createInputRequest(
    "input-monotonic",
    "task-1",
    requester(),
    {
      question: "Question",
      choices: [],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    },
    now
  );
  const earlier = new Date("2026-07-12T11:59:59.999Z");

  assert.throws(
    () => answerInputRequest(request, "resolution-earlier", { text: "Answer" }, "online", earlier),
    /cannot predate request creation/
  );
  assert.throws(
    () => cancelInputRequest(request, "Cancel", earlier),
    /cannot predate request creation/
  );
  assert.throws(
    () => supersedeInputRequest(request, "input-replacement", "Replace", earlier),
    /cannot predate request creation/
  );
});

test("builds pointer-only event payloads and honest source labels", () => {
  const request = createInputRequest(
    "input-event",
    "task-1",
    requester(),
    {
      question: "QUESTION_SECRET",
      choices: [{ key: "safe", label: "Safe" }],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    },
    now
  );
  const result = answerInputRequest(
    request,
    "resolution-event",
    { choiceKey: "safe", text: "ANSWER_SECRET" },
    "online",
    now
  );

  assert.deepEqual(createInputRequestEventPayload(request), {
    taskId: "task-1",
    requestId: "input-event",
    status: "open",
    policy: "user-required"
  });
  assert.deepEqual(createInputResolutionEventPayload(result.resolution), {
    taskId: "task-1",
    requestId: "input-event",
    resolutionId: "resolution-event",
    source: "user"
  });
  const superseded = supersedeInputRequest(
    request,
    "input-replacement",
    "REASON_SECRET",
    now
  );
  assert.deepEqual(createInputRequestEventPayload(superseded), {
    taskId: "task-1",
    requestId: "input-event",
    replacementRequestId: "input-replacement",
    status: "superseded",
    policy: "user-required"
  });
  assert.doesNotMatch(JSON.stringify(createInputRequestEventPayload(request)), /QUESTION_SECRET|ANSWER_SECRET/);
  assert.doesNotMatch(JSON.stringify(createInputRequestEventPayload(superseded)), /QUESTION_SECRET|REASON_SECRET/);
  assert.equal(inputResolutionSourceLabel("user"), "User answer");
  assert.equal(inputResolutionSourceLabel("offline-recommended"), "Offline recommendation");
  assert.doesNotMatch(inputResolutionSourceLabel("offline-recommended"), /confirm|approv|chosen by user/i);
});
