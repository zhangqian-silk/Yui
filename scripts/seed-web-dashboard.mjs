import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createConfiguredAgent } from "../dist/agent/agent.js";
import { createTaskBrief } from "../dist/brief/taskBrief.js";
import { createDecision, supersedeDecision } from "../dist/decision/decision.js";
import {
  createExecutionGroup,
  recordExecutionLaneResult,
  resolveExecutionGroup,
  updateExecutionLane
} from "../dist/execution/executionGroup.js";
import { createTaskEvent } from "../dist/event/taskEvent.js";
import { resolveEffectiveLaunch } from "../dist/executor/effectiveLaunch.js";
import {
  answerInputRequest,
  cancelInputRequest,
  createInputRequest
} from "../dist/input/inputRequest.js";
import { createTaskMessage } from "../dist/message/message.js";
import { createMilestone } from "../dist/milestone/milestone.js";
import { createProject } from "../dist/repository/project.js";
import {
  createRole,
  createRoleAgentBinding,
  updateRoleStatus
} from "../dist/role/role.js";
import {
  createAgentRun,
  failAgentRun,
  markAgentRunDelivered,
  withYieldReceipt,
  yieldAgentRun
} from "../dist/run/agentRun.js";
import { createYieldReceipt } from "../dist/run/yieldReceipt.js";
import { recordLeaderFailure } from "../dist/scheduler/leaderFailure.js";
import { createLeaderRecoveryNotification } from "../dist/scheduler/operatorNotification.js";
import { mergePendingWakeup } from "../dist/scheduler/pendingWakeup.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { ensureYuiHome, FileTaskStore } from "../dist/storage/taskStore.js";
import {
  activateTask,
  archiveTask,
  completeTask,
  createTask,
  retireTask
} from "../dist/task/task.js";
import {
  attachWorkItemExecutionGroup,
  createWorkItem,
  retireWorkItem,
  submitWorkItemCandidate,
  updateWorkItemExecutionGroup,
  updateWorkItemStatus
} from "../dist/workItem/workItem.js";
import { createReviewRound } from "../dist/review/reviewRound.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const yuiHome = resolve(process.env.YUI_HOME ?? resolve(projectRoot, "output"));
const at = (value) => new Date(value);
const COMMIT = "a".repeat(40);

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
  projectBindings: [{ projectId: "project-1", directory: "yui-web", baseRef: "master" }],
  cwd: resolve(projectRoot)
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
const task4 = completeTask(activateTask(createTask("task-4", "Restore native terminal scrolling", at("2026-07-15T02:00:00Z"), {
  priority: "low",
  tags: ["terminal", "completed"]
}), at("2026-07-15T03:00:00Z")), at("2026-07-21T09:00:00Z"), {
  by: "leader",
  summary: "Native tmux scrollback was restored and verified."
});
const task5 = archiveTask(retireTask(createTask("task-5", "Retired prototype", at("2026-06-10T01:00:00Z"), {
  description: "An archived task retained to exercise historical filtering.",
  tags: ["archive", "prototype"]
}), {
  by: "leader",
  summary: "Prototype retired in favor of the production dashboard."
}, at("2026-07-09T08:00:00Z")), at("2026-07-10T08:00:00Z"), {
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
  writer.saveProject(createProject(
    "project-1",
    "Yui Web",
    projectRoot,
    { stable: "master", development: "develop" },
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

  // --- Work items with execution groups, candidates, and review rounds ---

  // work-item-1: completed with a yielded run, candidate, and review round.
  const work1 = updateWorkItemStatus(createWorkItem("work-item-1", "task-1", {
    title: "Build HTTP and snapshot API",
    objective: "Serve a read-only dashboard snapshot and task detail over loopback HTTP.",
    acceptance: ["Snapshot and detail endpoints return validated JSON", "Security headers are set on every response"],
    assignee: "leader",
    writeProjectIds: ["project-1"]
  }, at("2026-07-18T03:00:00Z")), "running", at("2026-07-18T03:01:00Z"));
  const group1 = createExecutionGroup("exec-group-1", "task-1", {
    purpose: "execution",
    target: {
      schemaVersion: 1,
      kind: "work-item",
      taskId: "task-1",
      workItemId: "work-item-1",
      revision: 1,
      projects: [{ projectId: "project-1", commit: COMMIT }],
      fingerprint: "seed-group-1"
    },
    roleName: "leader"
  }, at("2026-07-18T03:02:00Z"));
  let work1WithGroup = attachWorkItemExecutionGroup(work1, group1, at("2026-07-18T03:03:00Z"));
  const effective1 = resolveEffectiveLaunch({ role: roles[0], purpose: "execution" });
  const run1Yielded = yieldAgentRun(markAgentRunDelivered(createAgentRun("agent-run-1", "task-1", "leader", "new", "Implement the HTTP snapshot API.", at("2026-07-18T03:05:00Z"), {
    workItemId: "work-item-1",
    executionGroupId: "exec-group-1",
    executionLaneId: "exec-group-1-lane-1",
    effective: effective1
  }), at("2026-07-18T03:06:00Z")), "API implemented and focused tests pass.", at("2026-07-22T08:00:00Z"));
  const receipt1 = createYieldReceipt("task-1", "agent-run-1", {
    status: "yielded",
    summary: "API implemented and focused tests pass."
  }, at("2026-07-22T08:00:00Z"));
  const run1 = { ...withYieldReceipt(run1Yielded, receipt1), disposition: "progress" };
  const group1Running = updateExecutionLane(group1, "exec-group-1-lane-1", {
    status: "running",
    runId: "agent-run-1"
  }, at("2026-07-18T03:06:00Z"));
  work1WithGroup = updateWorkItemExecutionGroup(work1WithGroup, group1Running, at("2026-07-18T03:07:00Z"));
  const group1Yielded = recordExecutionLaneResult(group1Running, "exec-group-1-lane-1", {
    summary: "API implemented and focused tests pass.",
    findings: [
      { id: "finding-1", severity: "medium", summary: "Snapshot endpoint lacks ETag caching.", status: "open" },
      { id: "finding-2", severity: "low", summary: "Dashboard title could use more contrast.", status: "resolved" }
    ]
  }, "yielded", at("2026-07-22T08:00:00Z"));
  const work1Yielded = updateWorkItemExecutionGroup(work1WithGroup, group1Yielded, at("2026-07-22T08:01:00Z"));
  const work1Candidate = submitWorkItemCandidate(work1Yielded, {
    summary: "API implemented and focused tests pass.",
    source: { type: "run", runId: "agent-run-1" },
    executionGroupId: "exec-group-1",
    executionLaneId: "exec-group-1-lane-1"
  }, at("2026-07-22T08:05:00Z"));
  const review1 = createReviewRound(
    "review-round-1", "task-1", "work-item-1", "candidate-1",
    "reviewer", "policy", COMMIT, at("2026-07-22T08:10:00Z")
  );
  const group1Resolved = resolveExecutionGroup(group1Yielded, {
    decision: "accept",
    summary: "API verified; accepting the candidate."
  }, at("2026-07-22T08:15:00Z"));
  const work1Resolved = updateWorkItemExecutionGroup(work1Candidate, group1Resolved, at("2026-07-22T08:16:00Z"));
  const work1Done = updateWorkItemStatus(work1Resolved, "completed", at("2026-07-22T08:20:00Z"), "API and security headers verified.");

  // work-item-2: running with an active frontend run and execution group.
  const work2 = updateWorkItemStatus(createWorkItem("work-item-2", "task-1", {
    title: "Polish responsive dashboard",
    objective: "Make every task legible from mobile to wide desktop.",
    acceptance: ["Master-detail collapses below 900px", "No horizontal overflow at 320px"],
    dependsOn: ["work-item-1"],
    assignee: "frontend",
    writeProjectIds: ["project-1"]
  }, at("2026-07-20T03:00:00Z")), "running", at("2026-07-23T06:30:00Z"));
  const group2 = createExecutionGroup("exec-group-2", "task-1", {
    purpose: "execution",
    target: {
      schemaVersion: 1,
      kind: "work-item",
      taskId: "task-1",
      workItemId: "work-item-2",
      revision: 1,
      projects: [{ projectId: "project-1", commit: COMMIT }],
      fingerprint: "seed-group-2"
    },
    roleName: "frontend"
  }, at("2026-07-23T06:31:00Z"));
  const work2WithGroup = attachWorkItemExecutionGroup(work2, group2, at("2026-07-23T06:32:00Z"));
  const effective2 = resolveEffectiveLaunch({ role: roles[1], purpose: "execution" });
  const run2 = markAgentRunDelivered(createAgentRun("agent-run-2", "task-1", "frontend", "resume", "Finish responsive states and overflow handling.", at("2026-07-23T06:30:00Z"), {
    workItemId: "work-item-2",
    executionGroupId: "exec-group-2",
    executionLaneId: "exec-group-2-lane-1",
    effective: effective2
  }), at("2026-07-23T06:31:00Z"));
  const group2Running = updateExecutionLane(group2, "exec-group-2-lane-1", {
    status: "running",
    runId: "agent-run-2"
  }, at("2026-07-23T06:33:00Z"));
  const work2Running = updateWorkItemExecutionGroup(work2WithGroup, group2Running, at("2026-07-23T06:34:00Z"));

  // work-item-3: pending, blocked by dependency on work-item-2.
  const work3 = createWorkItem("work-item-3", "task-1", {
    title: "Run accessibility review",
    objective: "Confirm keyboard and screen-reader access across the dashboard.",
    acceptance: ["All controls reachable by keyboard", "Live regions announce updates"],
    dependsOn: ["work-item-2"],
    assignee: "reviewer"
  }, at("2026-07-22T04:00:00Z"));

  // work-item-4: retired with disposition.
  const work4 = retireWorkItem(createWorkItem("work-item-4", "task-1", {
    title: "Try abandoned card-grid concept",
    assignee: "frontend"
  }, at("2026-07-19T04:00:00Z")), {
    by: "leader",
    summary: "Replaced by the control-room composition.",
    replacementWorkItemId: "work-item-2"
  }, at("2026-07-20T04:00:00Z"));

  // work-item-5: retired without replacement.
  const work5 = retireWorkItem(createWorkItem("work-item-5", "task-1", {
    title: "Capture obsolete screenshot set",
    assignee: "reviewer"
  }, at("2026-07-20T05:00:00Z")), {
    by: "leader",
    summary: "Browser runtime was unavailable at the time."
  }, at("2026-07-20T06:00:00Z"));

  // work-item-6: failed with a failed execution group lane.
  const work6 = updateWorkItemStatus(createWorkItem("work-item-6", "task-6", {
    title: "Publish release artifact",
    objective: "Upload the verified build to the release channel.",
    acceptance: ["Artifact checksum matches the build"],
    assignee: "release-worker"
  }, at("2026-07-22T05:00:00Z")), "running", at("2026-07-23T04:30:00Z"));
  const group6 = createExecutionGroup("exec-group-6", "task-6", {
    purpose: "execution",
    target: {
      schemaVersion: 1,
      kind: "work-item",
      taskId: "task-6",
      workItemId: "work-item-6",
      revision: 1,
      projects: [],
      fingerprint: "seed-group-6"
    },
    roleName: "release-worker"
  }, at("2026-07-23T04:31:00Z"));
  const work6WithGroup = attachWorkItemExecutionGroup(work6, group6, at("2026-07-23T04:32:00Z"));
  const effective6 = resolveEffectiveLaunch({ role: roles[5], purpose: "execution" });
  const run3 = failAgentRun(markAgentRunDelivered(createAgentRun("agent-run-3", "task-6", "release-worker", "new", "Publish the verified artifact.", at("2026-07-23T04:30:00Z"), {
    workItemId: "work-item-6",
    executionGroupId: "exec-group-6",
    executionLaneId: "exec-group-6-lane-1",
    effective: effective6
  }), at("2026-07-23T04:31:00Z")), "Native process exited with status 1.", at("2026-07-23T04:55:00Z"));
  const group6Running = updateExecutionLane(group6, "exec-group-6-lane-1", {
    status: "running",
    runId: "agent-run-3"
  }, at("2026-07-23T04:33:00Z"));
  const group6Failed = recordExecutionLaneResult(group6Running, "exec-group-6-lane-1", {
    summary: "Native process exited with status 1."
  }, "failed", at("2026-07-23T04:55:00Z"));
  const work6Failed = updateWorkItemExecutionGroup(work6WithGroup, group6Failed, at("2026-07-23T04:56:00Z"));
  const work6Done = updateWorkItemStatus(work6Failed, "failed", at("2026-07-23T04:57:00Z"), "Worker exited before upload completed.");

  // work-item-7: waiting for user input.
  const work7 = createWorkItem("work-item-7", "task-2", {
    title: "Wait for deployment approval",
    assignee: "leader"
  }, at("2026-07-23T03:00:00Z"));

  // Phase 1: persist Work Items in their pre-candidate state so Runs and
  // Candidates can reference them through the storage boundary.
  for (const item of [work1Yielded, work2Running, work3, work4, work5, work6Done, work7]) {
    writer.saveWorkItem(item.taskId, item);
  }

  // Phase 2: persist Runs once their owning Work Items and ExecutionGroups exist.
  writer.saveAgentRun(run1);
  writer.saveActiveAgentRun(run2);
  writer.saveAgentRun(run3);

  // task-2 leader run waiting on input (no execution lineage, so no Work Item dependency).
  const effective4 = resolveEffectiveLaunch({ role: roles[3], purpose: "execution" });
  const run4 = markAgentRunDelivered(createAgentRun("agent-run-4", "task-2", "leader", "resume", "Wait for explicit operator approval.", at("2026-07-23T07:00:00Z"), {
    workItemId: "work-item-7",
    effective: effective4
  }), at("2026-07-23T07:01:00Z"));
  writer.saveActiveAgentRun(run4);

  // Phase 3: advance work-item-1 through candidate submission, resolution, and
  // completion in consecutive revisions (the store requires +1 per save).
  writer.saveWorkItem(work1Candidate.taskId, work1Candidate);
  writer.saveWorkItem(work1Resolved.taskId, work1Resolved);
  writer.saveWorkItem(work1Done.taskId, work1Done);

  // Phase 4: ReviewRound once its Candidate and source Run exist.
  writer.saveReviewRound("task-1", review1);

  const requiredInput = createInputRequest("input-1", "task-2", {
    taskId: "task-2",
    roleName: "leader",
    agentId: "codex",
    runId: "agent-run-4"
  }, {
    question: "Deploy the verified build to production now?",
    choices: [{ key: "deploy", label: "Deploy now" }, { key: "hold", label: "Hold release" }],
    blockedRefs: [{ type: "work-item", taskId: "task-2", id: "work-item-7" }]
  }, at("2026-07-23T07:05:00Z"));
  const recommendedInput = createInputRequest("input-2", "task-1", {
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex",
    runId: "agent-run-1"
  }, {
    question: "Use port 4173 for local dashboard documentation?",
    choices: [{ key: "default", label: "Use 4173" }, { key: "alternate", label: "Use 4180" }],
    blockedRefs: [],
    policy: { kind: "recommended", recommendedChoiceKey: "default", timeoutAt: "2026-07-25T08:00:00Z" }
  }, at("2026-07-23T06:00:00Z"));
  const answeredInput = createInputRequest("input-3", "task-1", {
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex",
    runId: "agent-run-1"
  }, {
    question: "Which visual direction should the dashboard use?",
    choices: [{ key: "control-room", label: "Control room" }, { key: "cards", label: "Card grid" }],
    blockedRefs: []
  }, at("2026-07-20T06:00:00Z"));
  const cancelledInput = createInputRequest("input-4", "task-1", {
    taskId: "task-1",
    roleName: "leader",
    agentId: "codex",
    runId: "agent-run-1"
  }, {
    question: "Should we add a second persistence layer?",
    choices: [],
    blockedRefs: []
  }, at("2026-07-20T06:10:00Z"));
  for (const [taskId, request] of [["task-2", requiredInput], ["task-1", recommendedInput], ["task-1", answeredInput], ["task-1", cancelledInput]]) {
    writer.saveInputRequest(taskId, request);
  }
  writer.saveInputRequest("task-1", answerInputRequest(answeredInput, { choiceKey: "control-room" }, "user", at("2026-07-20T06:20:00Z")));
  writer.saveInputRequest("task-1", cancelInputRequest(cancelledInput, "The FileTaskStore remains the only authority.", at("2026-07-20T06:25:00Z")));

  const messages = [
    ["task-1", createTaskMessage("message-1", "task-1", "Please make the dashboard dense, calm, and easy to scan.", "user", { type: "user" }, at("2026-07-18T01:05:00Z"))],
    ["task-1", createTaskMessage("message-2", "task-1", "The dashboard task is active and work has been dispatched.", "operator", { type: "operator" }, at("2026-07-18T02:05:00Z"))],
    ["task-1", createTaskMessage("message-3", "task-1", "HTTP API implemented; security headers and focused tests pass.", "role-result", { type: "role", roleName: "leader" }, at("2026-07-22T08:00:00Z"), { runId: "agent-run-1", workItemId: "work-item-1" })],
    ["task-6", createTaskMessage("message-4", "task-6", "Release worker exited; inspect partial artifact before retry.", "system", { type: "system" }, at("2026-07-23T04:56:00Z"))]
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
    createTaskEvent("event-1", "task-1", "task.created", { taskId: "task-1", title: task1.title }, at("2026-07-18T01:00:00Z")),
    createTaskEvent("event-2", "task-1", "task.activated", { taskId: "task-1" }, at("2026-07-18T02:00:00Z")),
    createTaskEvent("event-3", "task-1", "work.completed", { taskId: "task-1", workItemId: "work-item-1" }, at("2026-07-22T08:00:00Z"))
  ];
  for (const event of events) writer.saveEvent("task-1", event);

  writer.savePendingWakeup(mergePendingWakeup("task-6", "leader-recovery", at("2026-07-23T05:01:00Z"), null));
  writer.saveLeaderFailure(recordLeaderFailure("task-6", "native-session-failed", "Leader pane exited during recovery.", at("2026-07-23T05:02:00Z"), null));
  writer.saveOperatorNotification(createLeaderRecoveryNotification("task-6", "Manual recovery is required for the release worker.", at("2026-07-23T05:03:00Z"), null));
});

console.log(`Seeded web dashboard at ${yuiHome}`);
