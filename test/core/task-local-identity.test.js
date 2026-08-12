import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
  retireWorkItem,
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
    schemaVersion: 8,
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
    tx.saveWorkItem(task.id, retireWorkItem(first, {
      by: "leader",
      summary: "Lifecycle fixture settled."
    }, firstAt));
    tx.saveTask(completeTask(task, firstAt, { by: "leader", summary: "First pass complete." }));
  });

  store.transaction((tx) => {
    const reopened = reopenTask(tx.getTask("task-1"), secondAt);
    tx.saveTask(reopened);
    const second = createWorkItem(tx.nextWorkItemId(reopened.id), reopened.id, {
      title: "Second lifecycle WorkItem"
    }, secondAt);
    assert.equal(second.id, "work-item-2");
    tx.saveWorkItem(reopened.id, retireWorkItem(second, {
      by: "leader",
      summary: "Reopened lifecycle fixture settled."
    }, secondAt));
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
