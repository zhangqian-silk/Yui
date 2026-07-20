import assert from "node:assert/strict";
import test from "node:test";

import {
  createGlobalRole,
  createRole,
  copyGlobalRoleToTaskRole,
  switchActiveRoleAgent
} from "../../dist/role/role.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import {
  createAgentRun,
  yieldAgentRun
} from "../../dist/run/agentRun.js";
import { activateTask, archiveTask, createTask } from "../../dist/task/task.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";

const now = new Date("2026-07-19T12:00:00.000Z");
const later = new Date("2026-07-19T12:01:00.000Z");

function binding(agentId, adapterId = agentId, config = {}) {
  return { agentId, adapterId, config: { adapterId, ...config } };
}

test("GlobalRole copies into an isolated TaskRole with independent Agent bindings", () => {
  const globalRole = createGlobalRole(
    "leader",
    [
      binding("codex", "codex", { model: "gpt-5.6-sol" }),
      binding("claude", "claude", { model: "sonnet" })
    ],
    "codex",
    "/repo",
    now,
    { responsibilities: ["coordinate"] }
  );
  const taskRole = copyGlobalRoleToTaskRole(globalRole, "task-1", later);

  assert.equal(globalRole.schemaVersion, 2);
  assert.equal(taskRole.schemaVersion, 2);
  assert.equal(taskRole.taskId, "task-1");
  assert.equal(taskRole.status, "idle");
  assert.notEqual(taskRole.agentBindings, globalRole.agentBindings);
  assert.notEqual(taskRole.agentBindings.codex.config, globalRole.agentBindings.codex.config);
  assert.notEqual(taskRole.responsibilities, globalRole.responsibilities);
});

test("Agent switching preserves dormant sessions and resumes the target native session", () => {
  const role = createRole(
    "task-1",
    "leader",
    [binding("codex"), binding("claude")],
    "codex",
    "/repo",
    now
  );
  let sessions = createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "leader" },
    "codex",
    now
  );
  sessions = recordRoleAgentSession(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "codex-thread",
    policy: "fixed",
    status: "stopped"
  }, now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "claude",
    adapterId: "claude",
    nativeSessionId: "claude-session",
    policy: "fixed",
    status: "stopped"
  }, now);

  const switched = switchActiveRoleAgent(
    role,
    sessions,
    "claude",
    { activeRun: false, nativeProcessRunning: false },
    later
  );

  assert.equal(switched.mode, "resume");
  assert.equal(switched.role.activeAgentId, "claude");
  assert.equal(switched.sessions.activeAgentId, "claude");
  assert.equal(switched.sessions.sessions.codex.nativeSessionId, "codex-thread");
  assert.equal(switched.sessions.sessions.claude.nativeSessionId, "claude-session");
});

test("Agent switching rejects active runs and mismatched GlobalRole/TaskRole session owners", () => {
  const role = createRole(
    "task-1",
    "leader",
    [binding("codex"), binding("claude")],
    "codex",
    "/repo",
    now
  );
  const taskSessions = createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "leader" },
    "codex",
    now
  );
  assert.throws(
    () => switchActiveRoleAgent(
      role,
      taskSessions,
      "claude",
      { activeRun: true, nativeProcessRunning: false },
      later
    ),
    /active AgentRun/i
  );

  const globalSessions = createRoleSessionSet(
    { scope: "global", roleName: "leader" },
    "codex",
    now
  );
  assert.throws(
    () => switchActiveRoleAgent(
      role,
      globalSessions,
      "claude",
      { activeRun: false, nativeProcessRunning: false },
      later
    ),
    /session owner/i
  );
});

test("restored persistent domain records are plain JSON with explicit schema versions", () => {
  const task = createTask("task-1", "Restore models", now);
  const workItem = createWorkItem(
    "work-1",
    task.id,
    { title: "Implement", assignee: "worker", topics: ["model", "model"] },
    now
  );
  const run = createAgentRun(
    "run-1",
    task.id,
    "worker",
    "new",
    "Implement the model",
    now,
    { workItemId: workItem.id }
  );
  const yielded = yieldAgentRun(run, "Implemented", later);
  const snapshot = JSON.parse(JSON.stringify({ task, workItem, yielded }));

  assert.equal(snapshot.task.schemaVersion, 1);
  assert.equal(snapshot.task.status, "draft");
  assert.equal(snapshot.workItem.schemaVersion, 1);
  assert.equal(snapshot.yielded.schemaVersion, 1);
  assert.equal(snapshot.yielded.status, "yielded");
  assert.equal(snapshot.yielded.endedAt, later.toISOString());
  assert.deepEqual(snapshot.workItem.topics, ["model"]);
});

test("Task follows the retained draft, active, archived lifecycle", () => {
  const draft = createTask("task-1", "Lifecycle", now, {
    repositoryId: "repo-1",
    baseRef: "main"
  });
  const active = activateTask(draft, later);
  const archived = archiveTask(active, new Date("2026-07-19T12:02:00.000Z"));

  assert.deepEqual([draft.status, active.status, archived.status], ["draft", "active", "archived"]);
  assert.equal("archived" in draft, false);
  assert.equal(draft.repositoryId, "repo-1");
  assert.equal(draft.baseRef, "main");
  assert.throws(() => activateTask(archived, later), /archived/i);
});
