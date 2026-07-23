import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createConfiguredAgent } from "../dist/agent/agent.js";
import { createTaskBrief } from "../dist/brief/taskBrief.js";
import { createDecision, supersedeDecision } from "../dist/decision/decision.js";
import { createTaskEvent } from "../dist/event/taskEvent.js";
import {
  answerInputRequest,
  cancelInputRequest,
  createInputRequest
} from "../dist/input/inputRequest.js";
import { createTaskMessage } from "../dist/message/message.js";
import { createMilestone } from "../dist/milestone/milestone.js";
import { createRepository } from "../dist/repository/repository.js";
import {
  createRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../dist/role/role.js";
import {
  createAgentRun,
  failAgentRun,
  markAgentRunDelivered,
  yieldAgentRun
} from "../dist/run/agentRun.js";
import { recordLeaderFailure } from "../dist/scheduler/leaderFailure.js";
import { createLeaderRecoveryNotification } from "../dist/scheduler/operatorNotification.js";
import { mergePendingWakeup } from "../dist/scheduler/pendingWakeup.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { ensureYuiHome, FileTaskStore } from "../dist/storage/taskStore.js";
import {
  activateTask,
  archiveTask,
  completeTask,
  createTask
} from "../dist/task/task.js";
import { createWorkItem, updateWorkItemStatus } from "../dist/workItem/workItem.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const yuiHome = resolve(process.env.YUI_HOME ?? resolve(projectRoot, "output"));
const at = (value) => new Date(value);

ensureYuiHome(yuiHome);
ensureStorageSchema(yuiHome);
const store = new FileTaskStore(yuiHome);

if (store.listTasks().length > 0) {
  throw new Error(`Refusing to seed non-empty YUI_HOME: ${yuiHome}`);
}

const codex = createConfiguredAgent("codex", "codex", "codex", [], [], at("2026-07-01T08:00:00Z"));
const claude = createConfiguredAgent("claude", "claude", "claude", [], [], at("2026-07-01T08:05:00Z"));
const codexBinding = createRoleAgentBinding(codex);
const claudeBinding = createRoleAgentBinding(claude);

const task1 = activateTask(createTask("task-1", "Ship the Yui web dashboard", at("2026-07-18T01:00:00Z"), {
  description: "Deliver a polished read-only control room for local Yui tasks.",
  priority: "high",
  tags: ["web", "release", "ux"],
  dueAt: "2026-07-28T10:00:00Z",
  repositoryId: "repository-1",
  baseRef: "master"
}), at("2026-07-18T02:00:00Z"));
const task2 = activateTask(createTask("task-2", "Resolve deployment approval", at("2026-07-19T02:00:00Z"), {
  description: "A blocked urgent task with open user input and an overdue date.",
  priority: "urgent",
  tags: ["ops", "blocked"],
  dueAt: "2026-07-22T12:00:00Z"
}), at("2026-07-19T02:30:00Z"));
const task3 = createTask("task-3", "Draft onboarding guide", at("2026-07-20T03:00:00Z"), {
  description: "A draft task used to verify empty and not-yet-started states.",
  priority: "medium",
  tags: ["docs", "onboarding"]
});
const task4 = completeTask(activateTask(createTask(
  "task-4",
  "Restore native terminal scrolling",
  at("2026-07-15T02:00:00Z"),
  { priority: "low", tags: ["terminal", "completed"] }
), at("2026-07-15T03:00:00Z")), at("2026-07-21T09:00:00Z"), {
  by: "leader",
  summary: "Native tmux scrollback was restored and verified."
});
const task5 = archiveTask(createTask("task-5", "Retired prototype", at("2026-06-10T01:00:00Z"), {
  description: "An archived task retained to exercise historical filtering.",
  tags: ["archive", "prototype"]
}), at("2026-07-10T08:00:00Z"), {
  by: "user",
  reason: "Superseded by the production dashboard.",
  summary: "Prototype findings were folded into task-1."
});
const task6 = activateTask(createTask("task-6", "Recover failed release worker", at("2026-07-22T04:00:00Z"), {
  description: "Exercises failed Role, WorkItem, Run, and recovery diagnostics.",
  priority: "high",
  tags: ["recovery", "failure"]
}), at("2026-07-22T04:10:00Z"));

store.transaction((writer) => {
  writer.saveConfiguredAgent(codex);
  writer.saveConfiguredAgent(claude);
  writer.saveConfig({
    schemaVersion: 1,
    defaultAgent: "codex",
    defaultWorkspace: resolve(yuiHome, "workspace"),
    currentTaskId: "task-1",
    lastTaskId: "task-6"
  });
  writer.saveRepository(createRepository(
    "repository-1",
    "Yui Web",
    projectRoot,
    "master",
    at("2026-07-01T08:10:00Z")
  ));
  for (const task of [task1, task2, task3, task4, task5, task6]) writer.saveTask(task);

  writer.saveTaskBrief("task-1", createTaskBrief({
    objective: "Ship a local dashboard that makes every active thread legible at a glance.",
    boundaries: ["Read-only Web surface", "Loopback access only", "FileTaskStore remains authoritative"],
    currentFocus: "Verify responsive layout and task detail states.",
    leaderSummary: "Server, API, filters, details, and release packaging are implemented.",
    updatedBy: "leader"
  }, at("2026-07-23T07:25:00Z")));
  writer.saveTaskBrief("task-2", createTaskBrief({
    objective: "Obtain an explicit deployment decision from the operator.",
    boundaries: ["No automatic production deployment"],
    currentFocus: "Waiting for approval.",
    leaderSummary: "All preflight checks pass; user input is the remaining blocker.",
    updatedBy: "leader"
  }, at("2026-07-23T07:30:00Z")));

  const roles = [
    updateRoleStatus(createRole("task-1", "leader", [codexBinding, claudeBinding], "codex", resolve(yuiHome, "workspace/task-1/leader"), at("2026-07-18T02:00:00Z"), {
      description: "Owns the dashboard delivery.",
      responsibilities: ["Coordinate work", "Verify release evidence"]
    }), "running", at("2026-07-23T07:20:00Z")),
    updateRoleStatus(createRole("task-1", "frontend", [codexBinding], "codex", resolve(yuiHome, "workspace/task-1/frontend"), at("2026-07-18T02:05:00Z"), {
      description: "Builds the responsive dashboard interface.",
      expectedOutput: "Accessible production UI"
    }), "idle", at("2026-07-23T06:40:00Z")),
    updateRoleStatus(createRole("task-1", "reviewer", [claudeBinding], "claude", resolve(yuiHome, "workspace/task-1/reviewer"), at("2026-07-18T02:10:00Z")), "detached", at("2026-07-23T06:45:00Z")),
    updateRoleStatus(createRole("task-2", "leader", [codexBinding], "codex", resolve(yuiHome, "workspace/task-2/leader"), at("2026-07-19T02:30:00Z")), "running", at("2026-07-23T07:35:00Z")),
    updateRoleStatus(createRole("task-6", "leader", [codexBinding], "codex", resolve(yuiHome, "workspace/task-6/leader"), at("2026-07-22T04:10:00Z")), "failed", at("2026-07-23T05:00:00Z")),
    updateRoleStatus(createRole("task-6", "release-worker", [claudeBinding], "claude", resolve(yuiHome, "workspace/task-6/release-worker"), at("2026-07-22T04:15:00Z")), "exited", at("2026-07-23T04:55:00Z"))
  ];
  for (const role of roles) writer.saveRole(role.taskId, role);

  const work1 = updateWorkItemStatus(createWorkItem("work-item-1", "task-1", { title: "Build HTTP and snapshot API", assignee: "leader" }, at("2026-07-18T03:00:00Z")), "completed", "API and security headers verified.", at("2026-07-22T08:00:00Z"));
  const work2 = updateWorkItemStatus(createWorkItem("work-item-2", "task-1", { title: "Polish responsive dashboard", assignee: "frontend" }, at("2026-07-20T03:00:00Z")), "running", undefined, at("2026-07-23T06:30:00Z"));
  const work3 = createWorkItem("work-item-3", "task-1", { title: "Run accessibility review", assignee: "reviewer" }, at("2026-07-22T04:00:00Z"));
  const work4 = updateWorkItemStatus(createWorkItem("work-item-4", "task-1", { title: "Try abandoned card-grid concept", assignee: "frontend" }, at("2026-07-19T04:00:00Z")), "superseded", "Replaced by the control-room composition.", at("2026-07-20T04:00:00Z"));
  const work5 = updateWorkItemStatus(createWorkItem("work-item-5", "task-1", { title: "Capture obsolete screenshot set", assignee: "reviewer" }, at("2026-07-20T05:00:00Z")), "cancelled", "Browser runtime was unavailable at the time.", at("2026-07-20T06:00:00Z"));
  const work6 = updateWorkItemStatus(createWorkItem("work-item-6", "task-6", { title: "Publish release artifact", assignee: "release-worker" }, at("2026-07-22T05:00:00Z")), "failed", "Worker exited before upload completed.", at("2026-07-23T04:55:00Z"));
  const work7 = createWorkItem("work-item-7", "task-2", { title: "Wait for deployment approval", assignee: "leader" }, at("2026-07-23T03:00:00Z"));
  for (const item of [work1, work2, work3, work4, work5, work6, work7]) writer.saveWorkItem(item.taskId, item);

  const yieldedRun = yieldAgentRun(markAgentRunDelivered(createAgentRun("agent-run-1", "task-1", "leader", "new", "Implement the HTTP snapshot API.", at("2026-07-18T03:05:00Z"), { workItemId: "work-item-1" }), at("2026-07-18T03:06:00Z")), "API implemented and focused tests pass.", at("2026-07-22T08:00:00Z"));
  const activeRun = markAgentRunDelivered(createAgentRun("agent-run-2", "task-1", "frontend", "resume", "Finish responsive states and overflow handling.", at("2026-07-23T06:30:00Z"), { workItemId: "work-item-2" }), at("2026-07-23T06:31:00Z"));
  const failedRun = failAgentRun(markAgentRunDelivered(createAgentRun("agent-run-3", "task-6", "release-worker", "new", "Publish the verified artifact.", at("2026-07-23T04:30:00Z"), { workItemId: "work-item-6" }), at("2026-07-23T04:31:00Z")), "Native process exited with status 1.", at("2026-07-23T04:55:00Z"));
  const blockedRun = markAgentRunDelivered(createAgentRun("agent-run-4", "task-2", "leader", "resume", "Wait for explicit operator approval.", at("2026-07-23T07:00:00Z"), { workItemId: "work-item-7" }), at("2026-07-23T07:01:00Z"));
  writer.saveAgentRun(yieldedRun);
  writer.saveActiveAgentRun(activeRun);
  writer.saveAgentRun(failedRun);
  writer.saveActiveAgentRun(blockedRun);

  const requiredInput = createInputRequest("input-1", "task-2", { roleName: "leader", agentId: "codex", runId: "agent-run-4" }, {
    question: "Deploy the verified build to production now?",
    choices: [{ key: "deploy", label: "Deploy now" }, { key: "hold", label: "Hold release" }],
    blockedRefs: [{ type: "work-item", id: "work-item-7" }]
  }, at("2026-07-23T07:05:00Z"));
  const recommendedInput = createInputRequest("input-2", "task-1", { roleName: "leader", agentId: "codex", runId: "agent-run-1" }, {
    question: "Use port 4173 for local dashboard documentation?",
    choices: [{ key: "default", label: "Use 4173" }, { key: "alternate", label: "Use 4180" }],
    blockedRefs: [],
    policy: { kind: "recommended", recommendedChoiceKey: "default", timeoutAt: "2026-07-25T08:00:00Z" }
  }, at("2026-07-23T06:00:00Z"));
  const answeredInput = createInputRequest("input-3", "task-1", { roleName: "leader", agentId: "codex", runId: "agent-run-1" }, {
    question: "Which visual direction should the dashboard use?",
    choices: [{ key: "control-room", label: "Control room" }, { key: "cards", label: "Card grid" }],
    blockedRefs: []
  }, at("2026-07-20T06:00:00Z"));
  const cancelledInput = createInputRequest("input-4", "task-1", { roleName: "leader", agentId: "codex", runId: "agent-run-1" }, {
    question: "Should we add a second persistence layer?",
    choices: [],
    blockedRefs: []
  }, at("2026-07-20T06:10:00Z"));
  for (const [taskId, request] of [["task-2", requiredInput], ["task-1", recommendedInput], ["task-1", answeredInput], ["task-1", cancelledInput]]) writer.saveInputRequest(taskId, request);
  writer.saveInputRequest("task-1", answerInputRequest(answeredInput, { choiceKey: "control-room" }, "user", at("2026-07-20T06:20:00Z")));
  writer.saveInputRequest("task-1", cancelInputRequest(cancelledInput, "The FileTaskStore remains the only authority.", at("2026-07-20T06:25:00Z")));

  const messages = [
    ["task-1", createTaskMessage("message-1", "Please make the dashboard dense, calm, and easy to scan.", "user", { type: "user" }, at("2026-07-18T01:05:00Z"))],
    ["task-1", createTaskMessage("message-2", "The dashboard task is active and work has been dispatched.", "operator", { type: "operator" }, at("2026-07-18T02:05:00Z"))],
    ["task-1", createTaskMessage("message-3", "HTTP API implemented; security headers and focused tests pass.", "role-result", { type: "role", roleName: "leader" }, at("2026-07-22T08:00:00Z"), { runId: "agent-run-1", workItemId: "work-item-1" })],
    ["task-6", createTaskMessage("message-4", "Release worker exited; inspect partial artifact before retry.", "system", { type: "system" }, at("2026-07-23T04:56:00Z"))]
  ];
  for (const [taskId, message] of messages) writer.saveMessage(taskId, message);

  const activeDecision = createDecision("decision-1", "task-1", "Keep the Web surface read-only", "Mutations remain explicit CLI operations and FileTaskStore stays authoritative.", at("2026-07-18T04:00:00Z"));
  const oldDecision = createDecision("decision-2", "task-1", "Use a uniform card grid", "An early direction before operational density was tested.", at("2026-07-18T04:10:00Z"));
  writer.saveDecision("task-1", activeDecision);
  writer.saveDecision("task-1", oldDecision);
  writer.saveDecision("task-1", supersedeDecision(oldDecision, "The control-room composition scans better at operational density.", at("2026-07-20T04:00:00Z")));
  writer.saveMilestone("task-1", createMilestone("milestone-1", "task-1", "Read-only API complete", "Dashboard and task detail endpoints pass HTTP contract tests.", at("2026-07-22T08:05:00Z")));
  writer.saveMilestone("task-1", createMilestone("milestone-2", "task-1", "Release package verified", "The Web modules are present in the npm dry-run package.", at("2026-07-23T07:10:00Z")));

  const events = [
    createTaskEvent("event-1", "task.created", { taskId: "task-1", title: task1.title }, at("2026-07-18T01:00:00Z")),
    createTaskEvent("event-2", "task.activated", { taskId: "task-1" }, at("2026-07-18T02:00:00Z")),
    createTaskEvent("event-3", "work.completed", { taskId: "task-1", workItemId: "work-item-1" }, at("2026-07-22T08:00:00Z"))
  ];
  for (const event of events) writer.saveEvent("task-1", event);

  writer.savePendingWakeup(mergePendingWakeup("task-6", "leader-recovery", at("2026-07-23T05:01:00Z"), null));
  writer.saveLeaderFailure(recordLeaderFailure("task-6", "native-session-failed", "Leader pane exited during recovery.", at("2026-07-23T05:02:00Z"), null));
  writer.saveOperatorNotification(createLeaderRecoveryNotification("task-6", "Manual recovery is required for the release worker.", at("2026-07-23T05:03:00Z"), null));
});

const tasks = store.listTasks();
const openInputs = store.listAllInputRequests().filter((request) => request.status === "open");
console.log(JSON.stringify({
  yuiHome,
  stateFile: resolve(yuiHome, "state.json"),
  taskCount: tasks.length,
  taskStatuses: Object.fromEntries(["draft", "active", "completed", "archived"].map((status) => [
    status,
    tasks.filter((task) => task.status === status).length
  ])),
  openInputCount: openInputs.length
}, null, 2));
