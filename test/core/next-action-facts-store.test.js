/**
 * Issue 07 (Leader convergence): the store-owned next-action facts seam.
 *
 * `readNextActionFacts` is the db-only shape of the projection's input:
 * each backend filters at its own storage boundary (in-memory predicates for
 * the file store, indexed SQL predicates for SQLite) and returns exactly the
 * records the projection consumes — open Inputs, active Runs, leader Runs —
 * without materializing the full task history.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { answerInputRequest, createInputRequest } from "../../dist/input/inputRequest.js";
import { createProject } from "../../dist/repository/project.js";
import {
  createGlobalRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { projectNextAction } from "../../dist/task/nextAction.js";
import { failAgentRun, yieldAgentRun } from "../../dist/run/agentRun.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import { createAgentRun } from "../helpers/effectiveLaunch.js";

const NOW = new Date("2026-08-17T00:00:00.000Z");

function fixture(t, StoreClass) {
  const root = mkdtempSync(join(tmpdir(), "yui-next-action-facts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new StoreClass(root);
  const codex = createConfiguredAgent("codex", "codex", "codex", [], [], NOW);
  store.transaction((tx) => {
    tx.saveConfig({
      schemaVersion: 1,
      defaultAgent: codex.id,
      defaultWorkspace: root,
      review: { roleName: "reviewer", trigger: "final" }
    });
    tx.saveConfiguredAgent(codex);
    tx.saveGlobalRole(createGlobalRole(
      "leader", [createRoleAgentBinding(codex)], codex.id, root, NOW
    ));
    tx.saveGlobalRole(createGlobalRole(
      "reviewer", [createRoleAgentBinding(codex)], codex.id, root, NOW
    ));
    const projectPath = join(root, "one");
    mkdirSync(projectPath, { recursive: true });
    tx.saveProject(createProject(
      "project-1", "one", projectPath, { stable: "main", development: "main" }, NOW
    ));
  });
  runTaskCommand(
    ["create", "delivery", "--project", "project-1", "--require-integration"],
    store,
    { now: () => NOW }
  );
  runTaskCommand(["activate", "task-1"], store, { now: () => NOW });
  return { store, root };
}

function populate(store) {
  const item = createWorkItem(
    store.nextWorkItemId("task-1"),
    "task-1",
    {
      title: "First",
      objective: "Do first",
      acceptance: ["a1"],
      writeProjectIds: ["project-1"]
    },
    NOW
  );
  store.saveWorkItem("task-1", item);
  const activeLeader = createAgentRun(
    store.nextAgentRunId("task-1"), "task-1", "leader", "new", "Leading", NOW
  );
  store.saveAgentRun(activeLeader);
  const yieldedLeader = yieldAgentRun(createAgentRun(
    store.nextAgentRunId("task-1"), "task-1", "leader", "new", "Yielded", NOW
  ), "Yielded", NOW);
  store.saveAgentRun(yieldedLeader);
  const activeWorker = createAgentRun(
    store.nextAgentRunId("task-1"), "task-1", "worker", "new", "Working", NOW
  );
  store.saveAgentRun(activeWorker);
  const failedWorker = failAgentRun(createAgentRun(
    store.nextAgentRunId("task-1"), "task-1", "worker", "new", "Failed", NOW
  ), "Failed", NOW);
  store.saveAgentRun(failedWorker);
  const open = createInputRequest(
    store.nextInputRequestId("task-1"),
    "task-1",
    { taskId: "task-1", roleName: "leader", agentId: "codex", runId: activeLeader.id },
    { question: "Choose", choices: [], blockedRefs: [] },
    NOW
  );
  store.saveInputRequest("task-1", open);
  const resolved = createInputRequest(
    store.nextInputRequestId("task-1"),
    "task-1",
    { taskId: "task-1", roleName: "leader", agentId: "codex", runId: yieldedLeader.id },
    { question: "Done", choices: [], blockedRefs: [] },
    NOW
  );
  store.saveInputRequest("task-1", resolved);
  store.saveInputRequest("task-1", answerInputRequest(
    resolved,
    { text: "ok" },
    "user",
    NOW
  ));
  return { item, activeLeader, yieldedLeader, activeWorker, failedWorker, open };
}

function assertFacts(store, records) {
  const facts = store.readNextActionFacts("task-1");
  assert.ok(facts !== null);
  assert.equal(facts.task.id, "task-1");
  assert.equal(facts.task.status, "active");
  assert.deepEqual(
    facts.task.projectBindings.map(({ projectId }) => projectId),
    ["project-1"]
  );
  assert.deepEqual(facts.workItems.map(({ id }) => id), [records.item.id]);
  // Only the open Input crosses the boundary; the resolved one stays out.
  assert.deepEqual(facts.openInputRequests.map(({ id }) => id), [records.open.id]);
  // Active Runs of any role, id-sorted.
  assert.deepEqual(
    facts.activeRuns.map(({ id }) => id),
    [records.activeLeader.id, records.activeWorker.id]
  );
  // Leader Runs of any status, id-sorted (newest last for the budget window).
  assert.deepEqual(
    facts.leaderRuns.map(({ id }) => id),
    [records.activeLeader.id, records.yieldedLeader.id]
  );
  assert.deepEqual(facts.changeSets, []);
  assert.deepEqual(facts.integrations, []);
  assert.deepEqual(facts.reviewRounds, []);
  assert.deepEqual(facts.reviewConfig, { roleName: "reviewer", trigger: "final" });
  // The pure projection stays consistent over store-loaded facts.
  const action = projectNextAction(facts);
  assert.equal(action.kind, "resolve-input");
  assert.deepEqual(action.refs, [{ kind: "input-request", id: records.open.id }]);
}

test("FileTaskStore readNextActionFacts filters at the storage boundary", () => {
  const { store } = fixture(test, FileTaskStore);
  const records = populate(store);
  assertFacts(store, records);
  assert.equal(store.readNextActionFacts("task-999"), null);
});

test("SqliteTaskStore readNextActionFacts filters in indexed SQL", () => {
  const { store } = fixture(test, SqliteTaskStore);
  const records = populate(store);
  assertFacts(store, records);
  assert.equal(store.readNextActionFacts("task-999"), null);
});
