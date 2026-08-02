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
  recordRoleAgentSession,
  retireTaskRoleSessionsForWorkspace,
  updateRoleAgentSessionStatus
} from "../../dist/executor/agentExecutor.js";
import {
  createAgentRun,
  yieldAgentRun
} from "../../dist/run/agentRun.js";
import { activateTask, archiveTask, createTask } from "../../dist/task/task.js";
import {
  createWorkItem,
  recordWorkItemWorkspaceDisposition,
  updateWorkItemStatus
} from "../../dist/workItem/workItem.js";
import { createTaskMessage } from "../../dist/message/message.js";

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

test("workspace migration retires only after every bound native session is stopped", () => {
  let sessions = createRoleSessionSet(
    { scope: "task", taskId: "task-1", roleName: "worker" },
    "codex",
    now
  );
  sessions = recordRoleAgentSession(sessions, {
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "codex-stopped",
    policy: "fixed",
    status: "stopped"
  }, now);
  sessions = recordRoleAgentSession(sessions, {
    agentId: "claude",
    adapterId: "claude",
    nativeSessionId: "claude-dormant-ready",
    policy: "fixed",
    status: "ready"
  }, now);

  assert.throws(
    () => retireTaskRoleSessionsForWorkspace(sessions, later),
    /claude.*stopped|stopped.*claude/i
  );

  const stopped = updateRoleAgentSessionStatus(sessions, "claude", "stopped", later);
  assert.deepEqual(
    retireTaskRoleSessionsForWorkspace(stopped, later).sessions,
    {}
  );
});

test("restored persistent domain records are plain JSON with explicit schema versions", () => {
  const task = createTask("task-1", "Restore models", now);
  const workItem = createWorkItem(
    "work-item-1",
    task.id,
    { title: "Implement", assignee: "worker" },
    now
  );
  const run = createAgentRun(
    "agent-run-1",
    task.id,
    "worker",
    "new",
    "Implement the model",
    now,
    { workItemId: workItem.id }
  );
  const yielded = yieldAgentRun(run, "Implemented", later);
  const snapshot = JSON.parse(JSON.stringify({ task, workItem, yielded }));

  assert.equal(snapshot.task.schemaVersion, 2);
  assert.equal(snapshot.task.status, "draft");
  assert.equal(snapshot.workItem.schemaVersion, 6);
  assert.equal(snapshot.yielded.schemaVersion, 3);
  assert.equal(snapshot.yielded.purpose, "execution");
  assert.equal(snapshot.yielded.status, "yielded");
  assert.equal(snapshot.yielded.endedAt, later.toISOString());
});

test("Task follows the retained draft, active, archived lifecycle", () => {
  const draft = createTask("task-1", "Lifecycle", now, {
    projectBindings: [
      { projectId: "repo-1", directory: "backend", baseRef: "main" },
      { projectId: "repo-2", directory: "frontend", baseRef: "develop" }
    ]
  });
  const active = activateTask(draft, later);
  const archived = archiveTask(active, new Date("2026-07-19T12:02:00.000Z"));

  assert.deepEqual([draft.status, active.status, archived.status], ["draft", "active", "archived"]);
  assert.equal("archived" in draft, false);
  assert.deepEqual(draft.projectBindings, [
    { projectId: "repo-1", directory: "backend", baseRef: "main" },
    { projectId: "repo-2", directory: "frontend", baseRef: "develop" }
  ]);
  assert.throws(() => activateTask(archived, later), /archived/i);
});

test("WorkItems keep the Leader-approved writable Project subset", () => {
  const item = createWorkItem(
    "work-item-1",
    "task-1",
    {
      title: "Update the contract",
      assignee: "worker",
      writeProjectIds: ["repo-1", "repo-2"]
    },
    now
  );

  assert.deepEqual(item.writeProjectIds, ["repo-1", "repo-2"]);
});

test("terminal WorkItems cannot be reopened", () => {
  const pending = createWorkItem(
    "work-item-1",
    "task-1",
    { title: "Implement", assignee: "worker" },
    now
  );
  const completed = updateWorkItemStatus(pending, "completed", later, "Implemented.");

  assert.throws(
    () => updateWorkItemStatus(completed, "pending", later),
    /terminal/i
  );
});

test("updating a terminal WorkItem outcome preserves its workspace disposition", () => {
  const completed = updateWorkItemStatus(createWorkItem(
    "work-item-1",
    "task-1",
    { title: "Implement", assignee: "worker" },
    now
  ), "completed", later, "Implemented.");
  const disposed = recordWorkItemWorkspaceDisposition(completed, "integrated", later);
  const corrected = updateWorkItemStatus(disposed, "completed", later, "Implemented and tested.");

  assert.equal(corrected.outcome, "Implemented and tested.");
  assert.equal(corrected.workspaceDisposition, "integrated");
  assert.equal(corrected.endedAt, completed.endedAt);
});

test("closing an abandoned failed WorkItem preserves its workspace disposition", () => {
  const failed = updateWorkItemStatus(createWorkItem(
    "work-item-1",
    "task-1",
    { title: "Implement", assignee: "worker" },
    now
  ), "failed", later, "Native session exited.");
  const abandoned = recordWorkItemWorkspaceDisposition(failed, "abandoned", later);
  const superseded = updateWorkItemStatus(
    abandoned,
    "superseded",
    later,
    "Replacement work completed."
  );

  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.workspaceDisposition, "abandoned");
  assert.equal(superseded.outcome, "Replacement work completed.");
});

test("TaskMessage represents user, operator, and Role result authors structurally", () => {
  const user = createTaskMessage(
    "message-1",
    "task-1",
    "Please continue",
    "user",
    { type: "user" },
    now
  );
  const result = createTaskMessage(
    "message-2",
    "task-1",
    "Implemented",
    "role-result",
    { type: "role", roleName: "worker" },
    later,
    { runId: "agent-run-1", workItemId: "work-item-1" }
  );

  assert.deepEqual(user.author, { type: "user" });
  assert.equal(user.kind, "user");
  assert.deepEqual(result.author, { type: "role", roleName: "worker" });
  assert.equal(result.runId, "agent-run-1");
  assert.equal(result.workItemId, "work-item-1");
  assert.throws(
    () => createTaskMessage(
      "message-3", "task-1", "Invalid", "role-result", { type: "user" }, now
    ),
    /Role result.*Role author/i
  );
});
