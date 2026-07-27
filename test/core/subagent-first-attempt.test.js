import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createAgentProfile } from "../../dist/profile/agentProfile.js";
import { createTask, activateTask } from "../../dist/task/task.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import {
  AttemptCoordinator,
  selectExecutor
} from "../../dist/execution/attemptCoordinator.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import {
  createRole,
  createRoleAgentBinding
} from "../../dist/role/role.js";

const now = new Date("2026-07-26T00:00:00.000Z");

test("auto requires a Leader child thread and never silently creates a root Session", () => {
  const profile = profileFixture("worker", "read");
  assert.deepEqual(selectExecutor("auto", {
    parentThreadId: "thread-leader"
  }), { executor: "fork" });
  assert.throws(
    () => selectExecutor("auto", {}),
    /resume or start the Task Leader and retry/
  );
  assert.throws(
    () => selectExecutor("session", {}),
    /requires --session-reason/
  );
});

test("AttemptCoordinator persists the Profile revision and frozen input before a structured turn", async () => {
  const home = mkdtempSync(join(tmpdir(), "yui-attempt-"));
  ensureStorageSchema(home, now);
  const store = new FileTaskStore(home);
  const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
  const profile = profileFixture("worker", "read");
  const task = activateTask(createTask(store.nextTaskId(), "Read architecture", now), now);
  store.saveConfiguredAgent(agent);
  store.saveAgentProfile(profile);
  store.saveTask(task);
  const work = createWorkItem(store.nextWorkItemId(task.id), task.id, {
    title: "Inspect the scheduler",
    objective: "Return source-backed scheduler boundaries.",
    acceptance: ["Names the state authority."],
    dependsOn: []
  }, now);
  store.saveWorkItem(task.id, work);

  const calls = [];
  const executor = {
    async execute(request, started) {
      calls.push(request);
      started?.({
        sessionId: "session-1",
        threadId: "thread-1",
        turnId: "turn-1"
      });
      return {
        providerRef: {
          sessionId: "session-1",
          threadId: "thread-1",
          turnId: "turn-1"
        },
        result: {
          summary: "The FileTaskStore is authoritative.",
          checks: [{ name: "source inspection", outcome: "passed" }]
        }
      };
    },
    async interrupt() {}
  };
  const coordinator = new AttemptCoordinator(home, store, executor, () => now);
  await assert.rejects(
    coordinator.dispatch({ workItemId: work.id }),
    /resume or start the Task Leader and retry/
  );

  assert.equal(store.listExecutionAttempts(task.id).length, 0);
  assert.equal(store.getWorkItem(task.id, work.id).status, "pending");
  const result = await coordinator.dispatch({
    workItemId: work.id,
    executor: "session",
    sessionReason: "Explicit independent user-owned work."
  });
  assert.equal(result.attempt.executor, "session");
  assert.equal(result.attempt.sessionReason, "Explicit independent user-owned work.");
  assert.equal(result.attempt.state, "succeeded");
  assert.equal(result.workItem.status, "awaiting_acceptance");
  assert.equal(result.attempt.profileId, profile.id);
  assert.equal(result.attempt.profileRevision, profile.revision);
  assert.match(result.attempt.input, /Return source-backed scheduler boundaries/);
  assert.equal(calls[0].executor, "session");
  assert.equal(calls[0].profile.revision, 1);
});

test("auto only forks a ready or running Codex Leader thread", async () => {
  for (const [adapterId, status] of [
    ["codex", "stopped"],
    ["claude", "running"]
  ]) {
    const fixture = leaderFixture(adapterId, status);
    await assert.rejects(
      fixture.coordinator.dispatch({ workItemId: fixture.work.id }),
      /No compatible Task Leader thread/
    );
    assert.equal(fixture.store.listExecutionAttempts(fixture.task.id).length, 0);
  }

  const fixture = leaderFixture("codex", "ready");
  let request;
  fixture.executor.execute = async (value) => {
    request = value;
    return { result: { summary: "done" } };
  };
  const result = await fixture.coordinator.dispatch({ workItemId: fixture.work.id });
  assert.equal(result.attempt.executor, "fork");
  assert.equal(request.parentThreadId, "leader-thread");
});

function profileFixture(id, access) {
  return createAgentProfile({
    id,
    agentId: "codex",
    defaultAccess: access,
  }, now);
}

function leaderFixture(adapterId, status) {
  const home = mkdtempSync(join(tmpdir(), "yui-leader-fork-"));
  ensureStorageSchema(home, now);
  const store = new FileTaskStore(home);
  const workerAgent = createConfiguredAgent("worker-codex", "codex", "codex", [], [], now);
  const leaderAgent = adapterId === "codex"
    ? workerAgent
    : createConfiguredAgent("leader-claude", "claude", "claude", [], [], now);
  const profile = createAgentProfile({
    id: "worker",
    agentId: workerAgent.id,
    defaultAccess: "read"
  }, now);
  const task = activateTask(createTask(store.nextTaskId(), "Fork work", now), now);
  const work = createWorkItem(store.nextWorkItemId(task.id), task.id, {
    title: "Delegate",
    dependsOn: []
  }, now);
  const role = createRole(
    task.id,
    "leader",
    [createRoleAgentBinding(leaderAgent)],
    leaderAgent.id,
    home,
    now
  );
  const sessions = recordRoleAgentSession(
    createRoleSessionSet({
      scope: "task",
      taskId: task.id,
      roleName: "leader"
    }, leaderAgent.id, now),
    {
      agentId: leaderAgent.id,
      adapterId,
      nativeSessionId: "leader-thread",
      policy: "fixed",
      status
    },
    now
  );
  store.transaction((tx) => {
    tx.saveConfiguredAgent(workerAgent);
    if (leaderAgent.id !== workerAgent.id) tx.saveConfiguredAgent(leaderAgent);
    tx.saveAgentProfile(profile);
    tx.saveTask(task);
    tx.saveRole(task.id, role);
    tx.saveTaskRoleSessionSet(sessions);
    tx.saveWorkItem(task.id, work);
  });
  const executor = {
    async execute() { return { result: { summary: "done" } }; },
    async interrupt() {}
  };
  return {
    store,
    task,
    work,
    executor,
    coordinator: new AttemptCoordinator(home, store, executor, () => now)
  };
}
