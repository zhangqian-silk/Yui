import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import {
  attachExecutionProviderRef,
  completeExecutionAttempt,
  createExecutionAttempt
} from "../../dist/execution/executionAttempt.js";
import { createAgentProfile } from "../../dist/profile/agentProfile.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import { createTask } from "../../dist/task/task.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";

const NOW = new Date("2026-07-26T00:00:00.000Z");

test("FileTaskStore persists Profile, WorkItem, and Attempt with frozen execution input", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-profile-attempt-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const profile = createAgentProfile({
    id: "implementer",
    agentId: "codex",
    defaultAccess: "write",
  }, NOW);
  const task = createTask("task-1", "Implement", NOW);
  const work = createWorkItem("work-item-1", task.id, {
    title: "Implement",
    objective: "Implement the model.",
    acceptance: ["The model is persisted."],
    dependsOn: []
  }, NOW);
  const running = createExecutionAttempt({
    id: "attempt-1",
    taskId: task.id,
    workItemId: work.id,
    profileId: profile.id,
    profileRevision: profile.revision,
    executor: "fork",
    access: "write",
    input: "Implement the model."
  }, NOW);

  store.transaction((tx) => {
    tx.saveConfiguredAgent(createConfiguredAgent("codex", "codex", "codex", [], [], NOW));
    tx.saveAgentProfile(profile);
    tx.saveTask(task);
    tx.saveWorkItem(task.id, work);
    tx.saveExecutionAttempt(task.id, running);
  });

  const attached = attachExecutionProviderRef(
    running,
    { sessionId: "session-1", threadId: "thread-1", turnId: "turn-1" },
    new Date("2026-07-26T00:01:00.000Z")
  );
  store.saveExecutionAttempt(task.id, attached);
  const completed = completeExecutionAttempt(
    attached,
    { summary: "Implemented.", checks: [] },
    new Date("2026-07-26T00:02:00.000Z")
  );
  store.saveExecutionAttempt(task.id, completed);

  assert.deepEqual(store.getAgentProfile(profile.id), profile);
  assert.deepEqual(store.getAgentProfileRevision(profile.id, 1), profile);
  assert.deepEqual(store.getExecutionAttempt(task.id, running.id), completed);
});

test("FileTaskStore rejects Agent Profiles backed by a non-Codex Agent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-profile-adapter-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  store.saveConfiguredAgent(createConfiguredAgent("claude", "claude", "claude", [], [], NOW));

  assert.throws(
    () => store.saveAgentProfile(createAgentProfile({
      id: "invalid",
      agentId: "claude",
      defaultAccess: "read"
    }, NOW)),
    /requires a Codex Configured Agent/
  );
});

test("FileTaskStore rejects WorkItem dependency cycles and illegal lifecycle jumps", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-work-graph-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureStorageSchema(root, NOW);
  const store = new FileTaskStore(root);
  const task = createTask("task-1", "Graph", NOW);
  store.saveTask(task);
  const first = createWorkItem("work-item-1", task.id, {
    title: "First",
    dependsOn: []
  }, NOW);
  const second = createWorkItem("work-item-2", task.id, {
    title: "Second",
    dependsOn: [first.id]
  }, NOW);
  store.saveWorkItem(task.id, first);
  store.saveWorkItem(task.id, second);

  assert.throws(
    () => store.saveWorkItem(task.id, {
      ...first,
      dependsOn: [second.id],
      revision: 2,
      updatedAt: "2026-07-26T00:01:00.000Z"
    }),
    /dependency cycle/
  );
  assert.throws(
    () => store.saveWorkItem(task.id, {
      ...first,
      status: "completed",
      outcome: "Bypassed required execution.",
      revision: 2,
      updatedAt: "2026-07-26T00:01:00.000Z",
      endedAt: "2026-07-26T00:01:00.000Z"
    }),
    /transition is invalid/
  );
});
