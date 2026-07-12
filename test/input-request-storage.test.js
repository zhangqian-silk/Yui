import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  MAX_INPUT_QUESTION_LENGTH,
  answerInputRequest,
  createInputRequest
} from "../dist/input/inputRequest.js";
import { rebuildDerivedIndex } from "../dist/storage/derivedIndex.js";
import { createTaskEvent } from "../dist/event/taskEvent.js";
import {
  createResilientTaskStore,
  primeResilientTaskStore
} from "../dist/storage/resilientTaskStore.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { executeDomainTransaction } from "../dist/storage/domainTransaction.js";
import { replayPendingDomainTransactions } from "../dist/storage/recoveryJournal.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createTask } from "../dist/task/task.js";

const now = new Date("2026-07-12T12:00:00.000Z");

function createHome(t) {
  const home = mkdtempSync(join(tmpdir(), "taskmux-input-storage-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home);
  return home;
}

function requester(agentRunId = "agent-run-1") {
  return {
    roleName: "leader",
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "session-1",
    agentRunId
  };
}

function request(id, taskId, createdAt = now, question = `Question ${id}`) {
  return createInputRequest(
    id,
    taskId,
    requester(),
    {
      question,
      choices: [{ key: "safe", label: "Safe path" }],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    },
    createdAt
  );
}

function saveTask(store, id, title = id) {
  store.saveTask(createTask(id, title, now));
}

test("persists requests and resolutions only under their owning task", (t) => {
  const home = createHome(t);
  const store = new FileTaskStore(home);
  saveTask(store, "task-1");
  const open = request("input-1", "task-1");
  store.saveInputRequest(open);
  const answered = answerInputRequest(
    open,
    "resolution-1",
    { choiceKey: "safe", text: "Safe path" },
    "online",
    new Date("2026-07-12T12:01:00.000Z")
  );
  store.saveInputResolution(answered.resolution);
  store.saveInputRequest(answered.request);

  assert.deepEqual(store.getInputRequest("task-1", "input-1"), answered.request);
  assert.deepEqual(store.listInputRequests("task-1"), [answered.request]);
  assert.deepEqual(store.getInputResolution("task-1", "resolution-1"), answered.resolution);
  assert.deepEqual(store.listInputResolutions("task-1"), [answered.resolution]);

  const requestFile = join(home, "tasks", "task-1", "input-requests", "input-1.json");
  const resolutionFile = join(home, "tasks", "task-1", "input-resolutions", "resolution-1.json");
  assert.equal(existsSync(requestFile), true);
  assert.equal(existsSync(resolutionFile), true);
  assert.equal(existsSync(join(home, "runtime", "inbox")), false);
  assert.match(readFileSync(requestFile, "utf8"), /Question input-1/);
  assert.match(readFileSync(resolutionFile, "utf8"), /Safe path/);
});

test("keeps request linkage checks outside the storage codec", (t) => {
  const home = createHome(t);
  const store = new FileTaskStore(home);
  saveTask(store, "task-1");
  const first = answerInputRequest(
    request("input-a", "task-1"),
    "resolution-global",
    { choiceKey: "safe", text: "Safe path" },
    "online",
    now
  );
  store.saveInputResolution(first.resolution);

  assert.equal(store.getInputResolution("task-1", "resolution-global").requestId, "input-a");
  assert.equal(store.getInputRequest("task-1", "input-a"), null);
});

test("lists every task-owned request in stable id order without deleting terminal records", (t) => {
  const home = createHome(t);
  const store = new FileTaskStore(home);
  saveTask(store, "task-2");
  saveTask(store, "task-1");
  const later = request("input-z", "task-1", new Date("2026-07-12T12:02:00.000Z"));
  const sameTimeB = request("input-b", "task-2", new Date("2026-07-12T12:01:00.000Z"));
  const sameTimeA = request("input-a", "task-1", new Date("2026-07-12T12:01:00.000Z"));
  store.saveInputRequest(later);
  store.saveInputRequest(sameTimeB);
  store.saveInputRequest(sameTimeA);
  const answered = answerInputRequest(
    request("input-closed", "task-2", new Date("2026-07-12T12:00:00.000Z")),
    "resolution-closed",
    { choiceKey: "safe", text: "Safe path" },
    "online",
    now
  );
  store.saveInputRequest(answered.request);
  store.saveInputResolution(answered.resolution);

  assert.deepEqual(store.listInputRequests("task-1").map(({ id }) => id), ["input-a", "input-z"]);
  assert.deepEqual(
    store.listInputRequests("task-2").map(({ id, status }) => `${id}:${status}`),
    ["input-b:open", "input-closed:answered"]
  );
});

test("rebuilds a pointer-only derived index without copying request or answer bodies", (t) => {
  const home = createHome(t);
  const store = new FileTaskStore(home);
  saveTask(store, "task-1", "Indexed task");
  const bodySecret = "QUESTION_BODY_SENTINEL_8d143f";
  const answerSecret = "ANSWER_BODY_SENTINEL_51cc9a";
  const open = request("input-open", "task-1", now, bodySecret);
  const freeText = createInputRequest(
    "input-closed",
    "task-1",
    requester(),
    {
      question: "Free text question",
      choices: [],
      blockedRefs: [],
      resolutionPolicy: { mode: "user-required" }
    },
    now
  );
  const answered = answerInputRequest(
    freeText,
    "resolution-1",
    { text: answerSecret },
    "online",
    now
  );
  store.saveInputRequest(open);
  store.saveInputRequest(answered.request);
  store.saveInputResolution(answered.resolution);

  rebuildDerivedIndex(home, store);
  const indexFile = join(home, "runtime", "index.sqlite");
  let database = new Database(indexFile, { readonly: true });
  assert.deepEqual(
    database.prepare("SELECT request_id, task_id, status, policy FROM input_requests ORDER BY request_id").all(),
    [
      { request_id: "input-closed", task_id: "task-1", status: "answered", policy: "user-required" },
      { request_id: "input-open", task_id: "task-1", status: "open", policy: "user-required" }
    ]
  );
  const columns = database.prepare("PRAGMA table_info(input_requests)").all().map((column) => column.name);
  assert.equal(columns.includes("question"), false);
  assert.equal(columns.includes("answer"), false);
  database.close();
  const rawIndex = readFileSync(indexFile);
  assert.equal(rawIndex.includes(Buffer.from(bodySecret)), false);
  assert.equal(rawIndex.includes(Buffer.from(answerSecret)), false);

  writeFileSync(indexFile, "not a sqlite database");
  rebuildDerivedIndex(home, store);
  database = new Database(indexFile, { readonly: true });
  assert.equal(database.prepare("SELECT count(*) AS count FROM input_requests").get().count, 2);
  database.close();
});

test("rebuilds the task-scoped index when external edits violate the Controller global-id invariant", (t) => {
  const home = createHome(t);
  const store = new FileTaskStore(home);
  saveTask(store, "task-1");
  saveTask(store, "task-2");
  store.saveInputRequest(request("input-duplicate", "task-1"));
  store.saveInputRequest(request("input-duplicate", "task-2"));

  rebuildDerivedIndex(home, store);

  const database = new Database(join(home, "runtime", "index.sqlite"), { readonly: true });
  t.after(() => database.close());
  assert.deepEqual(
    database.prepare(
      "SELECT task_id, request_id FROM input_requests WHERE request_id = ? ORDER BY task_id"
    ).all("input-duplicate"),
    [
      { task_id: "task-1", request_id: "input-duplicate" },
      { task_id: "task-2", request_id: "input-duplicate" }
    ]
  );
});

test("surfaces corrupt authoritative records and keeps the last valid resilient snapshot", (t) => {
  const home = createHome(t);
  const direct = new FileTaskStore(home);
  saveTask(direct, "task-1");
  const valid = request("input-1", "task-1");
  direct.saveInputRequest(valid);
  const diagnostics = [];
  const store = createResilientTaskStore(direct, (error, method, args) => {
    diagnostics.push({ message: error.message, method, args });
  });
  primeResilientTaskStore(store);

  const requestFile = join(home, "tasks", "task-1", "input-requests", "input-1.json");
  writeFileSync(requestFile, `${JSON.stringify({ ...valid, taskId: "task-2" })}\n`);

  assert.throws(
    () => direct.getInputRequest("task-1", "input-1"),
    /Invalid input request record: task-1\/input-1/
  );
  assert.deepEqual(store.getInputRequest("task-1", "input-1"), valid);
  assert.deepEqual(store.listInputRequests("task-1"), [valid]);
  assert.deepEqual(diagnostics, [
    {
      message: "Invalid input request record: task-1/input-1",
      method: "getInputRequest",
      args: ["task-1", "input-1"]
    },
    {
      message: "Invalid input request record: task-1/input-1",
      method: "listInputRequests",
      args: ["task-1"]
    }
  ]);
  assert.match(readFileSync(requestFile, "utf8"), /"taskId":"task-2"/);
});

test("strictly rejects unknown fields and malformed timestamps at every record boundary", (t) => {
  const home = createHome(t);
  const store = new FileTaskStore(home);
  saveTask(store, "task-1");
  const valid = createInputRequest(
    "input-strict",
    "task-1",
    requester(),
    {
      question: "Strict question",
      choices: [{ key: "safe", label: "Safe path" }],
      blockedRefs: [{ type: "work-item", id: "work-item-1" }],
      resolutionPolicy: { mode: "user-required" }
    },
    now
  );

  for (const invalid of [
    { ...valid, unexpected: true },
    { ...valid, requester: { ...valid.requester, unexpected: true } },
    { ...valid, choices: [{ ...valid.choices[0], unexpected: true }] },
    { ...valid, blockedRefs: [{ ...valid.blockedRefs[0], unexpected: true }] },
    { ...valid, resolutionPolicy: { ...valid.resolutionPolicy, unexpected: true } },
    { ...valid, createdAt: "not-a-timestamp" },
    { ...valid, updatedAt: "2026-07-12T11:59:59.000Z" },
    { ...valid, status: "auto-resolved", resolutionId: "resolution-invalid-policy" },
    {
      ...valid,
      status: "superseded",
      superseded: {
        replacementRequestId: valid.id,
        reason: "Self replacement",
        supersededAt: valid.updatedAt
      }
    }
  ]) {
    assert.throws(() => store.saveInputRequest(invalid), /Invalid input request record/);
  }

  const resolution = answerInputRequest(valid, "resolution-strict", { choiceKey: "safe", text: "ignored" }, "online", now).resolution;
  for (const invalid of [
    { ...resolution, unexpected: true },
    { ...resolution, answer: { ...resolution.answer, unexpected: true } },
    { ...resolution, resolvedAt: "yesterday" }
  ]) {
    assert.throws(() => store.saveInputResolution(invalid), /Invalid input resolution record/);
  }
});

test("replays input request, resolution, event, and supersede linkage as one domain transaction", (t) => {
  const home = createHome(t);
  const store = new FileTaskStore(home);
  saveTask(store, "task-1");
  const original = request("input-original", "task-1");
  const answerable = request("input-answerable", "task-1");
  store.saveInputRequest(original);
  store.saveInputRequest(answerable);

  const previousFailpoint = process.env.TASKMUX_DOMAIN_TRANSACTION_FAILPOINT;
  process.env.TASKMUX_DOMAIN_TRANSACTION_FAILPOINT = "after-stage";
  t.after(() => {
    if (previousFailpoint === undefined) {
      delete process.env.TASKMUX_DOMAIN_TRANSACTION_FAILPOINT;
    } else {
      process.env.TASKMUX_DOMAIN_TRANSACTION_FAILPOINT = previousFailpoint;
    }
  });

  assert.throws(
    () => executeDomainTransaction(home, "input-atomic", (workingRoot) => {
      const transactionStore = new FileTaskStore(workingRoot);
      const replacement = request("input-replacement", "task-1");
      const superseded = {
        ...original,
        status: "superseded",
        superseded: {
          replacementRequestId: replacement.id,
          reason: "Question changed",
          supersededAt: "2026-07-12T12:01:00.000Z"
        },
        updatedAt: "2026-07-12T12:01:00.000Z"
      };
      const answered = answerInputRequest(
        answerable,
        "resolution-atomic",
        { choiceKey: "safe", text: "ignored" },
        "online",
        new Date("2026-07-12T12:01:00.000Z")
      );
      transactionStore.saveInputRequest(replacement);
      transactionStore.saveInputRequest(superseded);
      transactionStore.saveInputResolution(answered.resolution);
      transactionStore.saveInputRequest(answered.request);
      transactionStore.saveEvent("task-1", createTaskEvent(
        transactionStore.nextEventId("task-1"),
        "task.input_superseded",
        {
          taskId: "task-1",
          requestId: original.id,
          replacementRequestId: replacement.id
        },
        new Date("2026-07-12T12:01:00.000Z")
      ));
    }),
    /stopped after staging/
  );

  assert.equal(store.getInputRequest("task-1", "input-original").status, "open");
  assert.equal(store.getInputRequest("task-1", "input-replacement"), null);
  assert.equal(store.getInputResolution("task-1", "resolution-atomic"), null);
  assert.deepEqual(store.listEvents("task-1"), []);

  delete process.env.TASKMUX_DOMAIN_TRANSACTION_FAILPOINT;
  assert.deepEqual(replayPendingDomainTransactions(home), ["input-atomic"]);
  assert.equal(store.getInputRequest("task-1", "input-original").status, "superseded");
  assert.equal(store.getInputRequest("task-1", "input-replacement").status, "open");
  assert.deepEqual(
    (({ status, resolutionId }) => ({ status, resolutionId }))(
      store.getInputRequest("task-1", "input-answerable")
    ),
    { status: "answered", resolutionId: "resolution-atomic" }
  );
  assert.equal(store.getInputResolution("task-1", "resolution-atomic").requestId, "input-answerable");
  assert.deepEqual(store.listEvents("task-1").map((event) => event.payload), [{
    taskId: "task-1",
    requestId: "input-original",
    replacementRequestId: "input-replacement"
  }]);
});

test("rejects invalid in-memory records and unsafe pointer ids before touching paths", (t) => {
  const home = createHome(t);
  const store = new FileTaskStore(home);
  saveTask(store, "task-1");
  const valid = request("input-safe", "task-1");

  assert.throws(
    () => store.saveInputRequest({
      ...valid,
      status: "open",
      cancelled: { reason: "mixed terminal state", cancelledAt: now.toISOString() }
    }),
    /Invalid input request record/
  );
  assert.throws(
    () => store.saveInputRequest({ ...valid, id: "../../escaped" }),
    /Invalid input request record/
  );
  assert.throws(
    () => store.saveInputRequest({ ...valid, taskId: "../../escaped-task" }),
    /Invalid input request record/
  );
  assert.throws(
    () => store.saveInputRequest({
      ...valid,
      question: "😀".repeat(Math.floor(MAX_INPUT_QUESTION_LENGTH / 4) + 1)
    }),
    /Invalid input request record/
  );
  assert.throws(
    () => store.getInputRequest("task-1", "../../escaped"),
    /Invalid input request id/
  );
  assert.equal(existsSync(join(home, "escaped.json")), false);
  assert.equal(existsSync(join(home, "escaped-task")), false);
});

test("rejects coercible, sparse, and prototype-backed records with stable data errors", (t) => {
  const home = createHome(t);
  const store = new FileTaskStore(home);
  saveTask(store, "task-1");
  const valid = createInputRequest(
    "input-shape",
    "task-1",
    requester(),
    {
      question: "Question",
      choices: [],
      blockedRefs: [{ type: "task", id: "task-1" }],
      resolutionPolicy: { mode: "user-required" }
    },
    now
  );
  const sparseBlockedRefs = [];
  sparseBlockedRefs.length = 1;

  for (const invalid of [
    { ...valid, id: 1, taskId: 1 },
    {
      ...valid,
      blockedRefs: [{ type: { toString: () => "task" }, id: "task-1" }]
    },
    { ...valid, blockedRefs: sparseBlockedRefs },
    { ...valid, requester: Object.create(valid.requester) }
  ]) {
    assert.throws(
      () => store.saveInputRequest(invalid),
      (error) => error.code === "DATA_ERROR" && /Invalid input request record/.test(error.message)
    );
  }
  assert.throws(
    () => store.saveInputRequest(null),
    (error) => error.code === "DATA_ERROR" && /Invalid input request record/.test(error.message)
  );
  assert.throws(
    () => store.getInputRequest(1, 1),
    (error) => error.code === "DATA_ERROR" && /Invalid task id/.test(error.message)
  );

  const resolution = answerInputRequest(valid, "resolution-shape", { text: "Answer" }, "online", now).resolution;
  assert.throws(
    () => store.saveInputResolution({
      ...resolution,
      operatorPresence: { toString: () => "online" }
    }),
    (error) => error.code === "DATA_ERROR" && /Invalid input resolution record/.test(error.message)
  );
  assert.throws(
    () => store.saveInputResolution(null),
    (error) => error.code === "DATA_ERROR" && /Invalid input resolution record/.test(error.message)
  );
});
