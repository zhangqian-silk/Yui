import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import {
  FileTaskStore,
  STORAGE_STATE_FILE
} from "../../dist/storage/taskStore.js";
import {
  activateTask,
  archiveTask,
  completeTask,
  createTask,
  reopenTask
} from "../../dist/task/task.js";
import {
  createWorkItem,
  submitWorkItemCandidate,
  updateWorkItemStatus,
  validateWorkItem
} from "../../dist/workItem/workItem.js";
import { createAgentRun } from "../helpers/effectiveLaunch.js";
import { createReviewRound } from "../../dist/review/reviewRound.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { createInputRequest } from "../../dist/input/inputRequest.js";
import { createDecision } from "../../dist/decision/decision.js";
import { createMilestone } from "../../dist/milestone/milestone.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { runTaskIntegrationCommand } from "../../dist/commands/taskIntegrationCommands.js";
import {
  createWorkMailbox,
  enqueueSignal
} from "../../dist/coordination/workMailbox.js";

const NOW = new Date("2026-08-02T00:00:00.000Z");
const REVIEW_BASE_COMMIT = "a".repeat(40);

test("WorkItem ids start at one independently inside each Task", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-local-id-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);

  for (const taskId of ["task-1", "task-2"]) {
    store.transaction((tx) => {
      tx.saveTask(createTask(taskId, taskId, NOW));
      const item = createWorkItem(tx.nextWorkItemId(taskId), taskId, {
        title: "First local WorkItem"
      }, NOW);
      tx.saveWorkItem(taskId, item);
    });
  }

  assert.equal(store.listWorkItems("task-1")[0]?.id, "work-item-1");
  assert.equal(store.listWorkItems("task-2")[0]?.id, "work-item-1");
});

test("ChangeSet and IntegrationAttempt ids use Task-local sequences instead of UUIDs", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-local-delivery-id-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);

  for (const taskId of ["task-1", "task-2"]) {
    store.saveTask(createTask(taskId, taskId, NOW));
    assert.deepEqual(store.transaction((tx) => [
      tx.nextChangeSetId(taskId),
      tx.nextIntegrationAttemptId(taskId)
    ]), ["change-set-1", "integration-1"]);
  }
});

test("every remaining Task-owned family allocates independently per Task", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-local-family-id-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);

  store.transaction((tx) => {
    const task = createTask("task-1", "task-1", NOW);
    tx.saveTask(task);
    const pending = createWorkItem(tx.nextWorkItemId(task.id), task.id, {
      title: "Candidate source"
    }, NOW);
    tx.saveWorkItem(task.id, pending);
    const running = updateWorkItemStatus(pending, "running", NOW);
    tx.saveWorkItem(task.id, running);
    const item = submitWorkItemCandidate(running, {
      summary: "Ready",
      source: { type: "direct" }
    }, NOW);
    tx.saveWorkItem(task.id, item);

    const run = createAgentRun(
      tx.nextAgentRunId(task.id),
      task.id,
      "leader",
      "new",
      "Execute",
      NOW
    );
    tx.saveAgentRun(run);
    tx.saveReviewRound(task.id, createReviewRound(
      tx.nextReviewRoundId(task.id),
      task.id,
      item.id,
      item.candidates[0].id,
      "reviewer",
      "leader",
      REVIEW_BASE_COMMIT,
      NOW
    ));
    tx.saveMessage(task.id, createTaskMessage(
      tx.nextMessageId(task.id),
      task.id,
      "Message",
      "system",
      { type: "system" },
      NOW
    ));
    tx.saveInputRequest(task.id, createInputRequest(
      tx.nextInputRequestId(task.id),
      task.id,
      { taskId: task.id, roleName: "leader", agentId: "codex", runId: run.id },
      { question: "Continue?", choices: [], blockedRefs: [] },
      NOW
    ));
    tx.saveDecision(task.id, createDecision(
      tx.nextDecisionId(task.id), task.id, "Decision", "Rationale", NOW
    ));
    tx.saveMilestone(task.id, createMilestone(
      tx.nextMilestoneId(task.id), task.id, "Milestone", "Summary", NOW
    ));
    tx.saveEvent(task.id, createTaskEvent(
      tx.nextEventId(task.id), task.id, "test.created", {}, NOW
    ));
  });

  store.saveTask(createTask("task-2", "task-2", NOW));
  assert.deepEqual(store.transaction((tx) => [
    tx.nextAgentRunId("task-2"),
    tx.nextReviewRoundId("task-2"),
    tx.nextMessageId("task-2"),
    tx.nextInputRequestId("task-2"),
    tx.nextDecisionId("task-2"),
    tx.nextMilestoneId("task-2"),
    tx.nextEventId("task-2")
  ]), [
    "agent-run-1",
    "review-round-1",
    "message-1",
    "input-1",
    "decision-1",
    "milestone-1",
    "event-1"
  ]);
});

test("the same local ids are legal in separate Task aggregates", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-local-duplicate-id-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);

  for (const taskId of ["task-1", "task-2"]) {
    store.transaction((tx) => {
      tx.saveTask(createTask(taskId, taskId, NOW));
      const run = createAgentRun(
        tx.nextAgentRunId(taskId), taskId, "leader", "new", "Execute", NOW
      );
      tx.saveAgentRun(run);
      tx.saveMessage(taskId, createTaskMessage(
        tx.nextMessageId(taskId), taskId, "Message", "system", { type: "system" }, NOW
      ));
      tx.saveInputRequest(taskId, createInputRequest(
        tx.nextInputRequestId(taskId),
        taskId,
        { taskId, roleName: "leader", agentId: "codex", runId: run.id },
        { question: "Continue?", choices: [], blockedRefs: [] },
        NOW
      ));
      tx.saveDecision(taskId, createDecision(
        tx.nextDecisionId(taskId), taskId, "Decision", "Rationale", NOW
      ));
      tx.saveMilestone(taskId, createMilestone(
        tx.nextMilestoneId(taskId), taskId, "Milestone", "Summary", NOW
      ));
      tx.saveEvent(taskId, createTaskEvent(
        tx.nextEventId(taskId), taskId, "test.created", {}, NOW
      ));
    });
  }

  for (const taskId of ["task-1", "task-2"]) {
    assert.equal(store.listMessages(taskId)[0]?.id, "message-1");
    assert.equal(store.listInputRequests(taskId)[0]?.id, "input-1");
    assert.equal(store.listDecisions(taskId)[0]?.id, "decision-1");
    assert.equal(store.listMilestones(taskId)[0]?.id, "milestone-1");
    assert.equal(store.listEvents(taskId)[0]?.id, "event-1");
  }
  assert.deepEqual(
    store.listAllInputRequests().map(({ taskId, id }) => `${taskId}/${id}`),
    ["task-1/input-1", "task-2/input-1"]
  );
});

test("persisted high-water marks prevent reuse and reject counter rollback", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-local-high-water-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);

  store.transaction((tx) => {
    tx.saveTask(createTask("task-1", "task-1", NOW));
    const item = createWorkItem(tx.nextWorkItemId("task-1"), "task-1", {
      title: "First WorkItem"
    }, NOW);
    tx.saveWorkItem("task-1", item);
  });

  const statePath = join(home, STORAGE_STATE_FILE);
  const withoutFirst = JSON.parse(readFileSync(statePath, "utf8"));
  delete withoutFirst.tasks["task-1"].workItems["work-item-1"];
  writeFileSync(statePath, JSON.stringify(withoutFirst));
  assert.equal(new FileTaskStore(home).nextWorkItemId("task-1"), "work-item-2");

  const rolledBack = JSON.parse(readFileSync(statePath, "utf8"));
  rolledBack.tasks["task-1"].workItems["work-item-2"] = {
    schemaVersion: 6,
    id: "work-item-2",
    taskId: "task-1",
    title: "Second WorkItem",
    objective: "Second WorkItem",
    acceptance: [],
    dependsOn: [],
    writeProjectIds: [],
    revision: 1,
    status: "pending",
    candidates: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
  rolledBack.tasks["task-1"].idHighWaterMarks.workItem = 1;
  writeFileSync(statePath, JSON.stringify(rolledBack));

  assert.throws(
    () => new FileTaskStore(home).listTasks(),
    /high-water.*task-1\/workItem.*work-item-2/i
  );
});

test("the aggregate lock serializes Task-local allocation across processes", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-local-concurrent-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, NOW);
  new FileTaskStore(home).saveTask(createTask("task-1", "task-1", NOW));

  const allocated = await Promise.all(
    Array.from({ length: 16 }, () => allocateWorkItemIdInChild(home))
  );
  assert.deepEqual(
    allocated.toSorted((left, right) => numericSuffix(left) - numericSuffix(right)),
    Array.from({ length: 16 }, (_, index) => `work-item-${index + 1}`)
  );
  assert.equal(new FileTaskStore(home).nextWorkItemId("task-1"), "work-item-17");
});

test("complete, reopen, and archive never reset a Task-local high-water mark", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-task-local-lifecycle-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);
  const firstAt = new Date(NOW.getTime() + 1_000);
  const secondAt = new Date(NOW.getTime() + 2_000);

  store.transaction((tx) => {
    const task = activateTask(createTask("task-1", "task-1", NOW), NOW);
    tx.saveTask(task);
    const first = createWorkItem(tx.nextWorkItemId(task.id), task.id, {
      title: "First lifecycle WorkItem"
    }, NOW);
    tx.saveWorkItem(task.id, updateWorkItemStatus(
      first,
      "cancelled",
      firstAt,
      "Lifecycle fixture settled."
    ));
    tx.saveTask(completeTask(task, firstAt, { by: "leader", summary: "First pass complete." }));
  });

  store.transaction((tx) => {
    const reopened = reopenTask(tx.getTask("task-1"), secondAt);
    tx.saveTask(reopened);
    const second = createWorkItem(tx.nextWorkItemId(reopened.id), reopened.id, {
      title: "Second lifecycle WorkItem"
    }, secondAt);
    assert.equal(second.id, "work-item-2");
    tx.saveWorkItem(reopened.id, updateWorkItemStatus(
      second,
      "cancelled",
      secondAt,
      "Reopened lifecycle fixture settled."
    ));
    tx.saveTask(archiveTask(
      completeTask(reopened, secondAt, { by: "leader", summary: "Second pass complete." }),
      secondAt,
      { by: "leader", summary: "Archived after verification." }
    ));
  });

  const persisted = JSON.parse(readFileSync(join(home, STORAGE_STATE_FILE), "utf8"));
  assert.equal(persisted.tasks["task-1"].idHighWaterMarks.workItem, 2);
  assert.equal(store.getTask("task-1").status, "archived");
});

test("contextless commands require qualified refs and Task context resolves local refs", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-qualified-ref-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);

  for (const taskId of ["task-1", "task-2"]) {
    store.transaction((tx) => {
      tx.saveTask(createTask(taskId, taskId, NOW));
      const item = createWorkItem(tx.nextWorkItemId(taskId), taskId, {
        title: "Local WorkItem"
      }, NOW);
      tx.saveWorkItem(taskId, item);
      if (taskId === "task-2") {
        tx.saveAgentRun(createAgentRun(
          tx.nextAgentRunId(taskId),
          taskId,
          "leader",
          "new",
          "Execute",
          NOW,
          { workItemId: item.id }
        ));
      }
    });
  }

  assert.match(
    runTaskCommand(["run", "list", "task-2/work-item-1"], store).output,
    /agent-run-1/
  );
  assert.equal(
    runTaskCommand(["run", "list", "work-item-1"], store, {
      environment: { YUI_TASK_ID: "task-1" }
    }).output,
    "No runs found.\n"
  );
  assert.throws(
    () => runTaskCommand(["run", "list", "work-item-1"], store),
    /Task context.*task-[^/]+\/work-item-1/i
  );
});

test("FileTaskStore exposes no all-Task bare-id lookup API", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-no-bare-lookup-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);

  assert.equal("findWorkItem" in store, false);
  assert.equal("findAgentRun" in store, false);
  assert.equal("findInputRequest" in store, false);
});

test("Task-owned mailbox refs carry explicit taskId provenance", () => {
  const mailbox = createWorkMailbox({ kind: "operator" });
  const signal = {
    reason: "input-requested",
    occurredAt: NOW.toISOString()
  };

  assert.throws(
    () => enqueueSignal(mailbox, {
      ...signal,
      refs: [{ type: "input", id: "input-1" }]
    }),
    /taskId/
  );
  assert.deepEqual(
    enqueueSignal(mailbox, {
      ...signal,
      refs: [{ type: "input", taskId: "task-2", id: "input-1" }]
    }).pending.refs,
    [{ type: "input", taskId: "task-2", id: "input-1" }]
  );
});

test("nested Task-owned records preserve explicit provenance", () => {
  const pending = createWorkItem("work-item-1", "task-2", {
    title: "Candidate provenance"
  }, NOW);
  const running = updateWorkItemStatus(pending, "running", NOW);
  const candidate = submitWorkItemCandidate(running, {
    summary: "Ready",
    source: { type: "direct" }
  }, NOW).candidates[0];

  assert.deepEqual(
    { id: candidate.id, taskId: candidate.taskId, workItemId: candidate.workItemId },
    { id: "candidate-1", taskId: "task-2", workItemId: "work-item-1" }
  );
  assert.equal(
    createTaskMessage(
      "message-1",
      "task-2",
      "Message",
      "system",
      { type: "system" },
      NOW
    ).taskId,
    "task-2"
  );
  assert.equal(
    createTaskEvent("event-1", "task-2", "test.created", {}, NOW).taskId,
    "task-2"
  );

  const runRequester = {
    taskId: "task-2",
    roleName: "leader",
    agentId: "codex",
    runId: "agent-run-1"
  };
  const request = createInputRequest(
    "input-1",
    "task-2",
    runRequester,
    {
      question: "Continue?",
      choices: [],
      blockedRefs: [{ type: "run", taskId: "task-2", id: "agent-run-1" }]
    },
    NOW
  );
  assert.equal(request.requester.taskId, "task-2");
  assert.deepEqual(request.blockedRefs, [
    { type: "run", taskId: "task-2", id: "agent-run-1" }
  ]);

  assert.throws(
    () => validateWorkItem({ ...pending, id: "custom-work" }),
    /work-item local id/i
  );
  assert.throws(
    () => submitWorkItemCandidate(running, {
      summary: "Invalid Run provenance",
      source: { type: "run", runId: "custom-run" }
    }, NOW),
    /agent-run local id/i
  );
});

test("WorkItem-local candidate ids never match another WorkItem review", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-candidate-scope-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ensureStorageSchema(home, NOW);
  const store = new FileTaskStore(home);

  store.transaction((tx) => {
    const task = activateTask(createTask("task-1", "task-1", NOW), NOW);
    tx.saveTask(task);
    const awaiting = [];
    for (const title of ["Reviewed candidate", "Independent candidate"]) {
      const pending = createWorkItem(tx.nextWorkItemId(task.id), task.id, { title }, NOW);
      tx.saveWorkItem(task.id, pending);
      const running = updateWorkItemStatus(pending, "running", NOW);
      tx.saveWorkItem(task.id, running);
      const candidate = submitWorkItemCandidate(running, {
        summary: `${title} is ready`,
        source: { type: "direct" }
      }, NOW);
      tx.saveWorkItem(task.id, candidate);
      awaiting.push(candidate);
    }
    tx.saveReviewRound(task.id, createReviewRound(
      tx.nextReviewRoundId(task.id),
      task.id,
      awaiting[0].id,
      awaiting[0].candidates[0].id,
      "reviewer",
      "leader",
      REVIEW_BASE_COMMIT,
      NOW
    ));
  });

  const result = runTaskCommand([
    "work", "accept", "task-1/work-item-2", "--summary", "Accepted independently."
  ], store, {
    environment: {
      YUI_SESSION_SCOPE: "task",
      YUI_TASK_ID: "task-1",
      YUI_ROLE: "leader"
    }
  });
  assert.match(result.output, /Accepted Work Item work-item-2/);
});

test("contextless Integration commands never discover a bare id across Tasks", async () => {
  const attempt = {
    schemaVersion: 2,
    id: "integration-1",
    taskId: "task-2",
    projectId: "project-1",
    targetRef: "main",
    expectedHead: "a".repeat(40),
    changeSetIds: ["change-set-1"],
    checkCommands: [],
    status: "running",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
  const store = {
    listTasks: () => [{ id: "task-2" }],
    getIntegrationAttempt: (taskId, id) => (
      taskId === attempt.taskId && id === attempt.id ? attempt : null
    )
  };

  await assert.rejects(
    runTaskIntegrationCommand(["show", "integration-1"], store, "/unused"),
    /Task context.*task-[^/]+\/integration-1/i
  );
  assert.match(
    (await runTaskIntegrationCommand(
      ["show", "task-2/integration-1"], store, "/unused"
    )).output,
    /Task: task-2/
  );
});

test("delivery receipt ids serialize qualified Task record references", async () => {
  const references = await import("../../dist/task/taskRecordReference.js");
  assert.equal(typeof references.formatAgentRunReceiptId, "function");
  assert.equal(
    references.formatAgentRunReceiptId("task-2", "agent-run-1"),
    "agent-run:task-2/agent-run-1"
  );
  assert.equal(
    references.formatInputRequestReceiptId("task-2", "input-1"),
    "input-request:task-2/input-1"
  );
});

test("offline identity conversion writes a fresh zero-dangling output without touching source", async (t) => {
  const requestedRoot = process.env.YUI_CONVERTER_E2E_ROOT;
  const root = requestedRoot === undefined
    ? mkdtempSync(join(tmpdir(), "yui-identity-convert-"))
    : resolve(requestedRoot);
  if (requestedRoot !== undefined) {
    assert.equal(existsSync(root), false, `Converter artifact root already exists: ${root}`);
    mkdirSync(root, { recursive: true });
  }
  t.after(() => {
    if (requestedRoot === undefined) rmSync(root, { recursive: true, force: true });
  });
  const source = join(root, "source");
  const output = join(root, "output");
  mkdirSync(source);
  const sourceState = legacyIdentityState();
  writeFileSync(join(source, "schema.json"), `${JSON.stringify({
    schemaVersion: 1,
    storageVersion: 6,
    aggregateSchemaVersion: 10,
    updatedAt: NOW.toISOString()
  }, null, 2)}\n`);
  writeFileSync(join(source, STORAGE_STATE_FILE), `${JSON.stringify(sourceState, null, 2)}\n`);
  const sourceBefore = readFileSync(join(source, STORAGE_STATE_FILE));

  const conversion = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), "dist", "cli.js"),
    "--json",
    "storage", "convert-task-identity",
    "--source", source,
    "--output", output
  ], { encoding: "utf8" }));
  assert.equal(conversion.ok, true);
  const report = conversion.data;

  assert.deepEqual(report.taskIds, ["task-1", "task-2"]);
  assert.deepEqual(readFileSync(join(source, STORAGE_STATE_FILE)), sourceBefore);
  const converted = JSON.parse(readFileSync(join(output, STORAGE_STATE_FILE), "utf8"));
  assert.equal(converted.schemaVersion, 12);
  for (const taskId of report.taskIds) {
    const task = converted.tasks[taskId];
    assert.equal(task.schemaVersion, 11);
    assert.deepEqual(Object.keys(task.workItems), ["work-item-1"]);
    assert.deepEqual(Object.keys(task.agentRuns), ["agent-run-1"]);
    assert.deepEqual(Object.keys(task.messages), ["message-1"]);
    assert.deepEqual(Object.keys(task.inputRequests), ["input-1"]);
    assert.deepEqual(Object.keys(task.decisions), ["decision-1"]);
    assert.deepEqual(Object.keys(task.milestones), ["milestone-1"]);
    assert.deepEqual(Object.keys(task.events), ["event-1"]);
    assert.equal(task.messages["message-1"].taskId, taskId);
    assert.equal(task.messages["message-1"].runId, "agent-run-1");
    assert.deepEqual(task.inputRequests["input-1"].blockedRefs, [
      { type: "run", taskId, id: "agent-run-1" }
    ]);
    assert.deepEqual(task.events["event-1"].payload, {
      requestId: "input-1",
      requesterRunId: "agent-run-1",
      policy: "required"
    });
  }
  const first = converted.tasks["task-1"];
  assert.deepEqual(Object.keys(first.reviewRounds), ["review-round-1"]);
  assert.deepEqual(Object.keys(first.changeSets), ["change-set-1"]);
  assert.deepEqual(Object.keys(first.integrationAttempts), ["integration-1"]);
  assert.deepEqual(first.workItems["work-item-1"].candidates.map((candidate) => ({
    id: candidate.id,
    taskId: candidate.taskId,
    workItemId: candidate.workItemId,
    runId: candidate.source.runId
  })), [{
    id: "candidate-1",
    taskId: "task-1",
    workItemId: "work-item-1",
    runId: "agent-run-1"
  }]);
  assert.equal(first.reviewRounds["review-round-1"].candidateId, "candidate-1");
  assert.equal(
    first.reviewRounds["review-round-1"].reviewBaseProvenance,
    "legacy-unavailable"
  );
  assert.equal(first.reviewRounds["review-round-1"].reviewBaseCommit, undefined);
  assert.deepEqual(first.reviewRounds["review-round-1"].checks, []);
  assert.deepEqual(
    first.workItems["work-item-1"].candidates[0].workspace.owner,
    { type: "work-item", workItemId: "work-item-1" }
  );
  assert.deepEqual(first.integrationAttempts["integration-1"].changeSetIds, [
    "change-set-1"
  ]);
  const second = converted.tasks["task-2"];
  assert.equal(second.roles.leader.schemaVersion, 3);
  assert.equal(second.roles.leader.launchRevision, 1);
  assert.equal(second.roles.leader.defaultAccess, "read");
  assert.equal(second.agentRuns["agent-run-1"].schemaVersion, 4);
  assert.equal(second.agentRuns["agent-run-1"].effective.access, "read");
  assert.equal(second.agentRuns["agent-run-1"].effective.sourceDesiredRevision, 1);
  assert.equal(second.roleSessionSets.leader.sessions.codex.schemaVersion, 3);
  assert.equal(second.roleSessionSets.leader.sessions.codex.effective.access, "read");
  assert.equal(second.activeRuns.leader.runId, "agent-run-1");
  assert.deepEqual(second.roleSessionSets.leader.inFlight, {
    agentId: "codex",
    runId: "agent-run-1",
    receiptId: "agent-run:task-2/agent-run-1",
    preparedAt: second.roleSessionSets.leader.inFlight.preparedAt,
    deliveredAt: second.roleSessionSets.leader.inFlight.deliveredAt
  });
  assert.equal(
    second.roleSessionSets.leader.pendingTurnCompletion.runId,
    "agent-run-1"
  );
  assert.deepEqual(
    converted.mailboxes.operator.pending.refs,
    [{ type: "input", taskId: "task-2", id: "input-1" }]
  );
  assert.equal(
    converted.mailboxes.operator.processing.batchId,
    "agent-run:task-2/agent-run-1"
  );
  assert.deepEqual(converted.mailboxes.operator.processing.executionRef, {
    type: "run",
    taskId: "task-2",
    id: "agent-run-1"
  });
  assert.deepEqual(converted.mailboxes.operator.processing.batch.refs, [{
    type: "run",
    taskId: "task-2",
    id: "agent-run-1"
  }]);
  assert.deepEqual(converted.mailboxes.operator.processing.batch.reasons, [
    "run-dispatched:task-2/agent-run-1"
  ]);
  assert.doesNotThrow(() => new FileTaskStore(output).listTasks());
});

test("offline identity conversion only remaps documented Task Event references", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-identity-event-convert-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const output = join(root, "output");
  mkdirSync(source);
  const sourceState = legacyIdentityState();
  const taskOneEvents = sourceState.tasks["task-1"].events;
  const eventStamp = taskOneEvents["event-10"].createdAt;
  taskOneEvents["event-10"] = {
    ...taskOneEvents["event-10"],
    type: "input.requested",
    payload: {
      requestId: "input-10",
      requesterRunId: "agent-run-10",
      policy: "required",
      summary: "Rejected: work-item-10",
      title: "work-item-10",
      reason: "Retain:agent-run-10",
      relatedRunId: "agent-run-10"
    }
  };
  taskOneEvents["event-11"] = {
    schemaVersion: 1,
    id: "event-11",
    type: "work.accepted",
    payload: {
      workItemId: "work-item-10",
      candidateId: "work-item-10-candidate-1",
      runId: "agent-run-10",
      acceptedBy: "leader",
      summary: "Accepted:work-item-10-candidate-1"
    },
    createdAt: eventStamp
  };
  taskOneEvents["event-12"] = {
    schemaVersion: 1,
    id: "event-12",
    type: "message.sent",
    payload: { messageId: "message-10", kind: "system" },
    createdAt: eventStamp
  };
  taskOneEvents["event-13"] = {
    schemaVersion: 1,
    id: "event-13",
    type: "decision.recorded",
    payload: { decisionId: "decision-10", title: "decision-10" },
    createdAt: eventStamp
  };
  taskOneEvents["event-14"] = {
    schemaVersion: 1,
    id: "event-14",
    type: "milestone.added",
    payload: { milestoneId: "milestone-10", title: "milestone-10" },
    createdAt: eventStamp
  };
  sourceState.tasks["task-2"].events["event-20"] = {
    ...sourceState.tasks["task-2"].events["event-20"],
    type: "legacy.created",
    payload: {
      runId: "agent-run-20",
      requestId: "input-20",
      summary: "Unknown event: work-item-20"
    }
  };
  writeLegacyStorage(source, sourceState);
  const sourceBefore = readFileSync(join(source, STORAGE_STATE_FILE));

  const { convertLegacyTaskIdentityStorage } = await import(
    "../../dist/storage/taskIdentityConverter.js"
  );
  convertLegacyTaskIdentityStorage({ source, output, now: NOW });

  assert.deepEqual(readFileSync(join(source, STORAGE_STATE_FILE)), sourceBefore);
  const converted = JSON.parse(readFileSync(join(output, STORAGE_STATE_FILE), "utf8"));
  const convertedTaskOneEvents = Object.fromEntries(
    Object.values(converted.tasks["task-1"].events).map((event) => [event.type, event.payload])
  );
  assert.deepEqual(convertedTaskOneEvents["input.requested"], {
    requestId: "input-1",
    requesterRunId: "agent-run-1",
    policy: "required",
    summary: "Rejected: work-item-10",
    title: "work-item-10",
    reason: "Retain:agent-run-10",
    relatedRunId: "agent-run-10"
  });
  assert.deepEqual(convertedTaskOneEvents["work.accepted"], {
    workItemId: "work-item-1",
    candidateId: "candidate-1",
    runId: "agent-run-1",
    acceptedBy: "leader",
    summary: "Accepted:work-item-10-candidate-1"
  });
  assert.deepEqual(convertedTaskOneEvents["message.sent"], {
    messageId: "message-1",
    kind: "system"
  });
  assert.deepEqual(convertedTaskOneEvents["decision.recorded"], {
    decisionId: "decision-1",
    title: "decision-10"
  });
  assert.deepEqual(convertedTaskOneEvents["milestone.added"], {
    milestoneId: "milestone-1",
    title: "milestone-10"
  });
  assert.deepEqual(converted.tasks["task-2"].events["event-1"].payload, {
    runId: "agent-run-20",
    requestId: "input-20",
    summary: "Unknown event: work-item-20"
  });
  const convertedStore = new FileTaskStore(output);
  assert.equal(convertedStore.getInputRequest("task-1", "input-1")?.id, "input-1");
  assert.equal(convertedStore.getAgentRun("task-1", "agent-run-1")?.id, "agent-run-1");
});

test("offline identity conversion rejects ambiguous bare refs without guessing", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-identity-ambiguous-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const output = join(root, "output");
  mkdirSync(source);
  const sourceState = legacyIdentityState();
  const duplicate = sourceState.tasks["task-2"].inputRequests["input-20"];
  delete sourceState.tasks["task-2"].inputRequests["input-20"];
  sourceState.tasks["task-2"].inputRequests["input-10"] = {
    ...duplicate,
    id: "input-10"
  };
  sourceState.tasks["task-2"].events["event-20"].payload.requestId = "input-10";
  sourceState.mailboxes.operator.pending.refs = [{ type: "input", id: "input-10" }];
  writeLegacyStorage(source, sourceState);
  const sourceBefore = readFileSync(join(source, STORAGE_STATE_FILE));

  const { convertLegacyTaskIdentityStorage } = await import(
    "../../dist/storage/taskIdentityConverter.js"
  );
  assert.throws(
    () => convertLegacyTaskIdentityStorage({ source, output, now: NOW }),
    /Source input reference is ambiguous: input-10/
  );
  assert.deepEqual(readFileSync(join(source, STORAGE_STATE_FILE)), sourceBefore);
  assert.equal(existsSync(output), false);
});

test("offline identity conversion rejects dangling references without output", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-identity-dangling-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const output = join(root, "output");
  mkdirSync(source);
  const sourceState = legacyIdentityState();
  sourceState.tasks["task-1"].messages["message-10"].runId = "agent-run-missing";
  writeLegacyStorage(source, sourceState);
  const sourceBefore = readFileSync(join(source, STORAGE_STATE_FILE));

  const { convertLegacyTaskIdentityStorage } = await import(
    "../../dist/storage/taskIdentityConverter.js"
  );
  assert.throws(
    () => convertLegacyTaskIdentityStorage({ source, output, now: NOW }),
    /Message Run is dangling: task-1\/agent-run-missing/
  );
  assert.deepEqual(readFileSync(join(source, STORAGE_STATE_FILE)), sourceBefore);
  assert.equal(existsSync(output), false);
});

test("offline identity conversion removes an output that fails current-schema validation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-identity-invalid-output-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const output = join(root, "output");
  mkdirSync(source);
  const sourceState = legacyIdentityState();
  sourceState.config = { schemaVersion: 99 };
  writeLegacyStorage(source, sourceState);
  const sourceBefore = readFileSync(join(source, STORAGE_STATE_FILE));

  const { convertLegacyTaskIdentityStorage } = await import(
    "../../dist/storage/taskIdentityConverter.js"
  );
  assert.throws(
    () => convertLegacyTaskIdentityStorage({ source, output, now: NOW }),
    /Yui config must use schemaVersion 1/
  );
  assert.deepEqual(readFileSync(join(source, STORAGE_STATE_FILE)), sourceBefore);
  assert.equal(existsSync(output), false);
});

function legacyIdentityState() {
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  const binding = createRoleAgentBinding(agent);
  const tasks = {};
  for (const [taskNumber, recordNumber] of [[1, 10], [2, 20]]) {
    const taskId = `task-${taskNumber}`;
    const stamp = new Date(NOW.getTime() + taskNumber * 1_000).toISOString();
    const workItemId = `work-item-${recordNumber}`;
    const runId = `agent-run-${recordNumber}`;
    const inputId = `input-${recordNumber}`;
    tasks[taskId] = {
      schemaVersion: 9,
      task: createTask(taskId, taskId, new Date(stamp)),
      brief: null,
      changeSets: {},
      integrationAttempts: {},
      roles: {},
      roleWorkspaces: {},
      roleSessionSets: {},
      workItems: {
        [workItemId]: {
          schemaVersion: 5,
          id: workItemId,
          taskId,
          title: "Legacy work",
          objective: "Legacy work",
          acceptance: [],
          dependsOn: [],
          writeProjectIds: [],
          revision: 1,
          status: "pending",
          candidates: [],
          createdAt: stamp,
          updatedAt: stamp
        }
      },
      agentRuns: {
        [runId]: {
          schemaVersion: 3,
          id: runId,
          taskId,
          roleName: "leader",
          mode: "new",
          input: "Legacy run",
          purpose: "execution",
          workItemId,
          agentId: "codex",
          adapterId: "codex",
          status: "active",
          createdAt: stamp,
          updatedAt: stamp
        }
      },
      reviewRounds: {},
      activeRuns: {},
      messages: {
        [`message-${recordNumber}`]: {
          schemaVersion: 1,
          id: `message-${recordNumber}`,
          kind: "system",
          author: { type: "system" },
          body: "Legacy message",
          runId,
          workItemId,
          createdAt: stamp
        }
      },
      inputRequests: {
        [inputId]: {
          schemaVersion: 1,
          id: inputId,
          taskId,
          requester: { roleName: "leader", agentId: "codex", runId },
          question: "Continue?",
          choices: [],
          blockedRefs: [{ type: "run", id: runId }],
          policy: { kind: "required" },
          status: "open",
          createdAt: stamp,
          updatedAt: stamp
        }
      },
      decisions: {
        [`decision-${recordNumber}`]: {
          schemaVersion: 1,
          id: `decision-${recordNumber}`,
          taskId,
          title: "Legacy decision",
          rationale: "Legacy rationale",
          status: "active",
          createdAt: stamp,
          updatedAt: stamp
        }
      },
      milestones: {
        [`milestone-${recordNumber}`]: {
          schemaVersion: 1,
          id: `milestone-${recordNumber}`,
          taskId,
          title: "Legacy milestone",
          summary: "Legacy summary",
          createdBy: "leader",
          createdAt: stamp
        }
      },
      events: {
        [`event-${recordNumber}`]: {
          schemaVersion: 1,
          id: `event-${recordNumber}`,
          type: "input.requested",
          payload: { requestId: inputId, requesterRunId: runId, policy: "required" },
          createdAt: stamp
        }
      },
      leaderFailure: null,
      operatorNotification: null
    };
  }
  const firstStamp = new Date(NOW.getTime() + 1_000).toISOString();
  tasks["task-1"].task = createTask("task-1", "task-1", new Date(firstStamp), {
    projectBindings: [{ projectId: "project-1", directory: "fixture", baseRef: "main" }]
  });
  tasks["task-1"].workItems["work-item-10"] = {
    ...tasks["task-1"].workItems["work-item-10"],
    revision: 3,
    status: "awaiting_acceptance",
    candidates: [{
      schemaVersion: 1,
      id: "work-item-10-candidate-1",
      sequence: 1,
      workItemRevision: 3,
      summary: "Ready",
      source: { type: "run", runId: "agent-run-10" },
      workspace: legacyWorkItemWorkspace(firstStamp),
      createdAt: firstStamp
    }]
  };
  tasks["task-1"].agentRuns["agent-run-10"] = {
    ...tasks["task-1"].agentRuns["agent-run-10"],
    status: "yielded",
    summary: "Ready",
    workspace: legacyWorkItemWorkspace(firstStamp),
    endedAt: firstStamp
  };
  tasks["task-1"].reviewRounds["review-round-10"] = {
    schemaVersion: 2,
    id: "review-round-10",
    taskId: "task-1",
    workItemId: "work-item-10",
    candidateId: "work-item-10-candidate-1",
    reviewerRoleName: "reviewer",
    requestedBy: "leader",
    status: "completed",
    summary: "Legacy review completed.",
    createdAt: firstStamp,
    endedAt: firstStamp
  };
  tasks["task-1"].changeSets["change-set-10"] = {
    schemaVersion: 2,
    id: "change-set-10",
    taskId: "task-1",
    projectId: "project-1",
    workItemId: "work-item-10",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    branch: "fixture",
    changedPaths: ["fixture.txt"],
    createdAt: firstStamp
  };
  tasks["task-1"].integrationAttempts["legacy-integration"] = {
    schemaVersion: 2,
    id: "legacy-integration",
    taskId: "task-1",
    projectId: "project-1",
    targetRef: "main",
    expectedHead: "a".repeat(40),
    changeSetIds: ["change-set-10"],
    checkCommands: [],
    status: "running",
    createdAt: firstStamp,
    updatedAt: firstStamp
  };
  const secondStamp = new Date(NOW.getTime() + 2_000).toISOString();
  const currentLeader = createRole(
      "task-2",
      "leader",
      [binding],
      agent.id,
      "/fixture/task-2",
      new Date(secondStamp)
    );
  const {
    launchRevision: _launchRevision,
    defaultAccess: _defaultAccess,
    ...legacyLeader
  } = currentLeader;
  tasks["task-2"].roles.leader = {
    ...legacyLeader,
    schemaVersion: 2,
    status: "running"
  };
  tasks["task-2"].activeRuns.leader = {
    schemaVersion: 1,
    runId: "agent-run-20"
  };
  tasks["task-2"].roleSessionSets.leader = legacyTaskRoleSessions(secondStamp);
  return {
    schemaVersion: 10,
    revision: 17,
    config: { schemaVersion: 1 },
    configuredAgents: { [agent.id]: agent },
    projects: {
      "project-1": {
        schemaVersion: 2,
        id: "project-1",
        name: "fixture",
        aliases: [],
        path: "/fixture/project",
        stableBranch: "main",
        developmentBranch: "main",
        knowledge: [],
        createdAt: firstStamp,
        updatedAt: firstStamp
      }
    },
    agentProfiles: {},
    globalRoles: {},
    globalRoleSessionSets: {},
    tasks,
    mailboxes: {
      operator: {
        schemaVersion: 1,
        target: { kind: "operator" },
        nextSequence: 3,
        processing: {
          batchId: "agent-run:agent-run-20",
          batch: {
            fromSequence: 1,
            toSequence: 1,
            reasons: ["run-dispatched:agent-run-20"],
            refs: [{ type: "run", id: "agent-run-20" }],
            requestCount: 1,
            firstQueuedAt: NOW.toISOString(),
            lastQueuedAt: NOW.toISOString()
          },
          owner: "controller",
          startedAt: NOW.toISOString(),
          executionRef: { type: "run", id: "agent-run-20" }
        },
        pending: {
          fromSequence: 2,
          toSequence: 2,
          reasons: ["input-requested"],
          refs: [{ type: "input", id: "input-20" }],
          requestCount: 1,
          firstQueuedAt: NOW.toISOString(),
          lastQueuedAt: NOW.toISOString()
        }
      }
    }
  };
}

function legacyWorkItemWorkspace(timestamp) {
  return {
    schemaVersion: 3,
    taskId: "task-1",
    roleName: "worker",
    owner: { type: "work-item", workItemId: "work-item-10" },
    root: "/fixture/work-item-10",
    entries: [{
      projectId: "project-1",
      directory: "fixture",
      access: "write",
      path: "/fixture/work-item-10/fixture",
      branch: "work-item-10",
      baseRef: "main",
      baseCommit: "a".repeat(40)
    }],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function legacyTaskRoleSessions(timestamp) {
  return {
    schemaVersion: 2,
    owner: { scope: "task", taskId: "task-2", roleName: "leader" },
    activeAgentId: "codex",
    sessions: {
      codex: {
        schemaVersion: 2,
        agentId: "codex",
        adapterId: "codex",
        nativeSessionId: "native-task-2-leader",
        policy: "fixed",
        status: "running",
        recentCompletedTurnIds: [],
        createdAt: timestamp,
        updatedAt: timestamp
      }
    },
    inFlight: {
      agentId: "codex",
      runId: "agent-run-20",
      receiptId: "agent-run:agent-run-20",
      preparedAt: timestamp,
      deliveredAt: timestamp
    },
    pendingTurnCompletion: {
      schemaVersion: 1,
      taskId: "task-2",
      roleName: "leader",
      agentId: "codex",
      nativeSessionId: "native-task-2-leader",
      turnId: "turn-legacy-20",
      runId: "agent-run-20",
      summary: "Legacy completion",
      observedAt: timestamp,
      dueAt: new Date(Date.parse(timestamp) + 1_000).toISOString()
    },
    updatedAt: timestamp
  };
}

function writeLegacyStorage(source, state) {
  writeFileSync(join(source, "schema.json"), `${JSON.stringify({
    schemaVersion: 1,
    storageVersion: 6,
    aggregateSchemaVersion: 10,
    updatedAt: NOW.toISOString()
  }, null, 2)}\n`);
  writeFileSync(join(source, STORAGE_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

function allocateWorkItemIdInChild(home) {
  const moduleUrl = new URL("../../dist/storage/taskStore.js", import.meta.url).href;
  const program = [
    `import { FileTaskStore } from ${JSON.stringify(moduleUrl)};`,
    "process.stdout.write(new FileTaskStore(process.argv[1]).nextWorkItemId('task-1'));"
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", program, home], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Allocator child exited ${code}: ${stderr.trim()}`));
    });
  });
}

function numericSuffix(id) {
  return Number.parseInt(id.slice(id.lastIndexOf("-") + 1), 10);
}
