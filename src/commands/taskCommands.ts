import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTaskComment } from "../comment/comment.js";
import { createTaskBrief, renderTaskBrief } from "../brief/taskBrief.js";
import { createCycle, endCycle, type CycleCause } from "../cycle/cycle.js";
import { createDecision, renderDecisionTimelineEntry, supersedeDecision } from "../decision/decision.js";
import { compileDispatchInput } from "../context/dispatchContext.js";
import { roleNotFound, runtimeError, taskNotFound, usageError } from "../errors/cliError.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { createTaskInputDraft } from "../input/taskInput.js";
import { createMilestone, renderMilestoneTimelineEntry } from "../milestone/milestone.js";
import { recordAgentSession } from "../executor/agentExecutor.js";
import { buildAgentLaunchPlan, type DispatchMode, withTaskmuxRunEnvironment } from "../executor/launchPlan.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { copyGlobalRoleToTaskRole, createRole, updateRole, updateRoleStatus } from "../role/role.js";
import { createChildRole } from "../role/childRole.js";
import { createAgentRun, yieldAgentRun } from "../run/agentRun.js";
import { SYSTEM_LEADER_ROLE } from "../role/systemRoles.js";
import { resolveRunner, supportedRunnerIds } from "../runner/runnerRegistry.js";
import { mergePendingWakeup } from "../scheduler/pendingWakeup.js";
import { createTaskSchedule } from "../scheduler/taskSchedule.js";
import { createTask, updateTaskArchived, updateTaskMetadata } from "../task/task.js";
import { BUILTIN_TOPICS, createCustomTopic, usesConventionalTopicId } from "../topic/topic.js";
import { createWorkItem, updateWorkItemStatus, type WorkItemStatus } from "../workItem/workItem.js";
import { createRoleWorktree } from "../worktree/worktree.js";
import type { TaskComment } from "../comment/comment.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { Role } from "../role/role.js";
import type { ChildRole } from "../role/childRole.js";
import type { AgentRun } from "../run/agentRun.js";
import type { TaskStore } from "../storage/taskStore.js";
import { resolveTaskmuxHome } from "../storage/taskStore.js";
import type { Task, TaskMetadata, TaskPriority } from "../task/task.js";
import type { TmuxManager } from "../tmux/tmuxManager.js";

const BUILTIN_LEADER_ROLE = SYSTEM_LEADER_ROLE;

export function runTaskCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  const [command, ...rest] = args;

  switch (command) {
    case "create":
      return createTaskCommand(rest, store);
    case "list":
      return listTaskCommand(rest, store);
    case "board":
      return boardTaskCommand(rest, store);
    case "show":
      return showTaskCommand(rest, store);
    case "current":
      return currentTaskCommand(rest, store);
    case "last":
      return lastTaskCommand(store);
    case "clone":
      return cloneTaskCommand(rest, store);
    case "update":
      return updateTaskCommand(rest, store);
    case "archive":
      return updateTaskArchivedCommand(rest, store, true);
    case "unarchive":
      return updateTaskArchivedCommand(rest, store, false);
    case "open":
      return openTaskCommand(rest, store);
    case "context":
      return contextTaskCommand(rest, store);
    case "delete":
      return deleteTaskCommand(rest, store);
    case "restore":
      return restoreTaskCommand(rest, store);
    case "role":
      return taskRoleCommand(rest, store, tmux);
    case "assign":
      return assignTaskRoleCommand(rest, store);
    case "bind":
      return bindTaskRoleCommand(rest, store);
    case "assign-many":
      return assignManyTaskRolesCommand(rest, store);
    case "roles":
      return listTaskRolesCommand(rest, store);
    case "enter":
      return enterTaskRoleCommand(rest, store, tmux);
    case "tail":
      return tailTaskRoleCommand(rest, store, tmux);
    case "detail":
      return detailTaskRoleCommand(rest, store);
    case "status":
      return statusTaskRoleCommand(rest, store, tmux);
    case "refresh":
      return refreshTaskRolesCommand(rest, store, tmux, "Refreshed");
    case "transcript":
      return transcriptTaskRoleCommand(rest, store, tmux);
    case "detach":
      return detachTaskRoleCommand(rest, store, tmux);
    case "stop":
      return stopTaskRoleCommand(rest, store, tmux);
    case "kill":
      return killTaskRoleCommand(rest, store, tmux);
    case "restart":
      return restartTaskRoleCommand(rest, store, tmux);
    case "cleanup":
      return refreshTaskRolesCommand(rest, store, tmux, "Cleaned");
    case "comment":
      return addTaskCommentCommand(rest, store);
    case "comments":
      return listTaskCommentsCommand(rest, store);
    case "events":
      return listTaskEventsCommand(rest, store);
    case "activity":
      return taskActivityCommand(rest, store);
    case "timeline":
      return taskTimelineCommand(rest, store);
    case "topic":
      return taskTopicCommand(rest, store);
    case "input":
      return taskInputCommand(rest, store);
    case "cycle":
      return taskCycleCommand(rest, store);
    case "work-item":
      return taskWorkItemCommand(rest, store);
    case "wake":
      return wakeTaskCommand(rest, store);
    case "session":
      return taskSessionCommand(rest, store);
    case "dispatch":
      return dispatchTaskRoleCommand(rest, store, tmux);
    case "yield":
      return yieldTaskRoleCommand(rest, store);
    case "schedule":
      return taskScheduleCommand(rest, store);
    case "brief":
      return taskBriefCommand(rest, store);
    case "milestone":
      return taskMilestoneCommand(rest, store);
    case "decision":
      return taskDecisionCommand(rest, store);
    case "worktree":
      return taskWorktreeCommand(rest, store);
    default:
      if (command === undefined) {
        return taskUsage();
      }
      throw usageError(taskUsage().trimEnd());
  }
}

function taskWorktreeCommand(args: string[], store: TaskStore): string {
  const [command, taskId, roleName, ...rest] = args;
  if (command !== "create" || taskId === undefined || roleName === undefined) {
    throw usageError("Worktree usage: taskmux task worktree create <task-id> <role> --path <path> --branch <branch> [--base <ref>].");
  }
  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }
  if (roleName === BUILTIN_LEADER_ROLE) {
    throw usageError("The Leader owns the primary workspace and does not use a TaskMux worktree.");
  }

  const role = store.getRole(taskId, roleName);
  if (role === null) {
    throw roleNotFound(roleName);
  }
  const path = readOption(rest, "--path").trim();
  const branch = readOption(rest, "--branch").trim();
  const base = readOptionalOption(rest, "--base")?.trim();
  const gitArgs = ["-C", role.workspace, "worktree", "add", "-b", branch, path];
  if (base !== undefined) {
    gitArgs.push(base);
  }
  execFileSync("git", gitArgs, { stdio: "pipe" });

  const worktree = createRoleWorktree(
    taskId,
    roleName,
    role.workspace,
    path,
    branch,
    base,
    new Date()
  );
  store.saveRoleWorktree(taskId, worktree);
  store.saveRole(taskId, updateRole(role, { workspace: path }, new Date()));
  recordTaskEvent(store, taskId, "role.worktree_created", { role: roleName, branch });
  return `Created worktree for ${taskId}/${roleName}: ${path}\n`;
}

function taskBriefCommand(args: string[], store: TaskStore): string {
  const [command, taskId, ...rest] = args;
  if (command !== "update" || taskId === undefined) {
    throw usageError("Brief usage: taskmux task brief update <task-id> --objective <body> [--boundary <body> ...] --focus <body> --leader-summary <body>.");
  }
  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const brief = createTaskBrief({
    objective: readOption(rest, "--objective"),
    boundaries: readRepeatedOption(rest, "--boundary"),
    currentFocus: readOption(rest, "--focus"),
    leaderSummary: readOption(rest, "--leader-summary")
  }, new Date());
  store.saveTaskBrief(taskId, renderTaskBrief(brief));
  recordTaskEvent(store, taskId, "task.brief_updated", {});
  return `Updated brief for task ${taskId}\n`;
}

function taskMilestoneCommand(args: string[], store: TaskStore): string {
  const [command, taskId, ...rest] = args;
  if (command !== "add" || taskId === undefined) {
    throw usageError("Milestone usage: taskmux task milestone add <task-id> --title <title> --summary <body> [--topic <topic> ...].");
  }
  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const topics = readRepeatedOption(rest, "--topic").map((topic) => topic.trim());
  const knownTopics = new Set([
    ...BUILTIN_TOPICS.map(({ id }) => id),
    ...store.getTaskTopics(taskId).customTopics.map(({ id }) => id)
  ]);
  const unknownTopic = topics.find((topic) => !knownTopics.has(topic));
  if (unknownTopic !== undefined) {
    throw usageError(`Topic not found: ${unknownTopic}.`);
  }

  const milestone = createMilestone(
    store.nextMilestoneId(taskId),
    taskId,
    readOption(rest, "--title"),
    readOption(rest, "--summary"),
    topics,
    new Date()
  );
  store.saveMilestone(taskId, milestone);
  store.appendTaskTimeline(taskId, renderMilestoneTimelineEntry(milestone));
  recordTaskEvent(store, taskId, "milestone.added", { milestone: milestone.id });
  return `Added milestone ${milestone.id} to task ${taskId}\n`;
}

function taskDecisionCommand(args: string[], store: TaskStore): string {
  const [command, taskId, ...rest] = args;
  if (taskId === undefined || store.getTask(taskId) === null) {
    if (taskId !== undefined) {
      throw taskNotFound(taskId);
    }
    throw usageError("Decision usage: taskmux task decision record|supersede <task-id> ...");
  }

  if (command === "record") {
    const topics = readRepeatedOption(rest, "--topic").map((topic) => topic.trim());
    const knownTopics = new Set([
      ...BUILTIN_TOPICS.map(({ id }) => id),
      ...store.getTaskTopics(taskId).customTopics.map(({ id }) => id)
    ]);
    const unknownTopic = topics.find((topic) => !knownTopics.has(topic));
    if (unknownTopic !== undefined) {
      throw usageError(`Topic not found: ${unknownTopic}.`);
    }
    const decision = createDecision(
      store.nextDecisionId(taskId),
      taskId,
      readOption(rest, "--title"),
      readOption(rest, "--rationale"),
      topics,
      new Date()
    );
    store.saveDecision(taskId, decision);
    store.appendTaskTimeline(taskId, renderDecisionTimelineEntry(decision));
    recordTaskEvent(store, taskId, "decision.recorded", { decision: decision.id });
    return `Recorded decision ${decision.id} for task ${taskId}\n`;
  }

  if (command === "supersede") {
    const [decisionId, ...options] = rest;
    if (decisionId === undefined) {
      throw usageError("Decision id is required.");
    }
    const decision = store.getDecision(taskId, decisionId);
    if (decision === null) {
      throw usageError(`Decision not found: ${decisionId}.`);
    }
    const updated = supersedeDecision(decision, readOption(options, "--reason"), new Date());
    store.saveDecision(taskId, updated);
    recordTaskEvent(store, taskId, "decision.superseded", { decision: decision.id });
    return `Superseded decision ${decision.id} for task ${taskId}\n`;
  }

  throw usageError("Decision usage: taskmux task decision record|supersede <task-id> ...");
}

function taskScheduleCommand(args: string[], store: TaskStore): string {
  const [command, taskId, ...rest] = args;

  if (command !== "set" || taskId === undefined) {
    throw usageError("Schedule usage: taskmux task schedule set <task-id> --inactivity-minutes <minutes> --cooldown-minutes <minutes> [--review-at <iso>].");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const inactivityMinutes = Number(readOption(rest, "--inactivity-minutes"));
  const cooldownMinutes = Number(readOption(rest, "--cooldown-minutes"));
  const reviewAt = readOptionalOption(rest, "--review-at")?.trim();
  const everyMinutesValue = readOptionalOption(rest, "--every-minutes")?.trim();
  const nextAt = readOptionalOption(rest, "--next-at")?.trim();
  if ((everyMinutesValue === undefined) !== (nextAt === undefined)) {
    throw usageError("--every-minutes and --next-at must be provided together.");
  }
  const recurring = everyMinutesValue === undefined || nextAt === undefined
    ? undefined
    : { everyMinutes: Number(everyMinutesValue), nextAt };
  const schedule = createTaskSchedule(
    inactivityMinutes,
    cooldownMinutes,
    reviewAt,
    recurring,
    new Date()
  );
  store.saveTaskSchedule(taskId, schedule);
  recordTaskEvent(store, taskId, "task.schedule_updated", {});
  return `Updated schedule for task ${taskId}\n`;
}

function yieldTaskRoleCommand(args: string[], store: TaskStore): string {
  const [taskId, roleName, ...rest] = args;

  if (taskId === undefined || roleName === undefined) {
    throw usageError("Yield usage: taskmux task yield <task-id> <role> --summary <summary>.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const role = store.getRole(taskId, roleName);
  if (role === null) {
    throw roleNotFound(roleName);
  }

  const activeRun = store.getActiveAgentRun(taskId, roleName);
  if (activeRun === null) {
    throw usageError(`No active agent run exists for ${taskId}/${roleName}.`);
  }

  const run = yieldAgentRun(activeRun, readOption(rest, "--summary"), new Date());
  store.saveAgentRun(run);
  store.clearActiveAgentRun(taskId, roleName);
  store.saveRole(taskId, updateRoleStatus(role, "idle", new Date()));
  const session = store.getAgentSession(taskId, roleName);
  if (session !== null) {
    store.saveAgentSession({ ...session, status: "ready", updatedAt: new Date().toISOString() });
  }
  if (run.workItemId !== undefined) {
    const workItem = store.getWorkItem(taskId, run.workItemId);
    if (workItem !== null && workItem.status === "running") {
      store.saveWorkItem(taskId, updateWorkItemStatus(workItem, "completed", run.summary, new Date()));
    }
  }
  recordTaskEvent(store, taskId, "agent-run.yielded", { run: run.id, role: roleName });
  if (roleName !== BUILTIN_LEADER_ROLE) {
    queueLeaderWakeup(store, taskId, "role-result");
  }

  return `Yielded ${run.id} from ${taskId}/${roleName}\n`;
}

function dispatchTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  const [taskId, roleName, ...rest] = args;

  if (taskId === undefined || roleName === undefined) {
    throw usageError("Dispatch usage: taskmux task dispatch <task-id> <role> --mode new|resume --input <input>.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const role = store.getRole(taskId, roleName);
  if (role === null) {
    throw roleNotFound(roleName);
  }

  if (tmux === undefined) {
    throw runtimeError("Tmux manager is not configured.");
  }

  if (store.getActiveAgentRun(taskId, roleName) !== null) {
    throw usageError(`${taskId}/${roleName} already has an active agent run.`);
  }

  const mode = readOption(rest, "--mode");
  if (mode !== "new" && mode !== "resume") {
    throw usageError("--mode must be new or resume.");
  }

  const input = readOption(rest, "--input").trim();
  if (input.length === 0) {
    throw usageError("Dispatch input is required.");
  }

  const session = store.getAgentSession(taskId, roleName);
  if (roleName === BUILTIN_LEADER_ROLE && session !== null && mode === "new") {
    throw usageError("The Leader must resume its fixed session; replace it explicitly if irrecoverable.");
  }

  const workItemId = readOptionalOption(rest, "--work-item")?.trim();
  const workItem = workItemId === undefined ? null : store.getWorkItem(taskId, workItemId);
  if (workItemId !== undefined && workItem === null) {
    throw usageError(`Work item not found: ${workItemId}.`);
  }
  if (workItem !== null && workItem.assignee !== roleName) {
    throw usageError(`Work item ${workItem.id} is assigned to ${workItem.assignee}, not ${roleName}.`);
  }
  if (workItem !== null && ["completed", "failed", "cancelled", "superseded"].includes(workItem.status)) {
    throw usageError(`Work item ${workItem.id} is already ${workItem.status}.`);
  }
  const topics = [...new Set([
    ...(workItem?.topics ?? []),
    ...readRepeatedOption(rest, "--topic").map((topic) => topic.trim())
  ])];
  const knownTopics = new Set([
    ...BUILTIN_TOPICS.map(({ id }) => id),
    ...store.getTaskTopics(taskId).customTopics.map(({ id }) => id)
  ]);
  const unknownTopic = topics.find((topic) => !knownTopics.has(topic));
  if (unknownTopic !== undefined) {
    throw usageError(`Topic not found: ${unknownTopic}.`);
  }
  const scopedInput = workItem === null
    ? input
    : [
        `WorkItem ${workItem.id}: ${workItem.title}`,
        ...(topics.length === 0 ? [] : [`Topics: ${topics.join(", ")}`]),
        input
      ].join("\n");
  const run = createAgentRun(
    store.nextAgentRunId(taskId),
    taskId,
    roleName,
    mode as DispatchMode,
    scopedInput,
    new Date(),
    { workItemId, topics }
  );
  let effectiveSession = session;
  let baseLaunch = buildAgentLaunchPlan(role, mode as DispatchMode, session);
  if (mode === "new" && role.agent === "claude") {
    const nativeSessionId = randomUUID();
    effectiveSession = recordAgentSession(
      taskId,
      roleName,
      role.agent,
      nativeSessionId,
      new Date(),
      session,
      session === null ? undefined : "Leader selected a new native session."
    );
    baseLaunch = { ...baseLaunch, args: [...baseLaunch.args, "--session-id", nativeSessionId] };
  }
  const launch = withTaskmuxRunEnvironment(
    baseLaunch,
    resolveTaskmuxHome(process.env),
    role,
    run,
    effectiveSession?.nativeSessionId
  );
  const compiledInput = compileDispatchInput(store, taskId, role, scopedInput);
  tmux.dispatchRole(taskId, role, launch, compiledInput, { replaceExisting: mode === "new" });
  store.saveRole(taskId, updateRoleStatus(role, "running", new Date()));
  if (effectiveSession !== null) {
    store.saveAgentSession({ ...effectiveSession, status: "running", updatedAt: new Date().toISOString() });
  }
  const storedRun = { ...run, input: compiledInput };
  store.saveAgentRun(storedRun);
  store.saveActiveAgentRun(storedRun);
  if (workItem !== null) {
    store.saveWorkItem(taskId, updateWorkItemStatus(workItem, "running", undefined, new Date()));
  }
  recordTaskEvent(store, taskId, "role.dispatch_accepted", { role: roleName, mode });

  return `Dispatch accepted for ${taskId}/${roleName} (${mode})\n`;
}

function taskSessionCommand(args: string[], store: TaskStore): string {
  const [command, taskId, roleName, ...rest] = args;

  if (taskId === undefined || roleName === undefined) {
    throw usageError("Session usage: taskmux task session record|replace <task-id> <role> --native-id <id> [--reason <reason>].");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const role = store.getRole(taskId, roleName);
  if (role === null) {
    throw roleNotFound(roleName);
  }

  const nativeSessionId = readOption(rest, "--native-id").trim();
  const existing = store.getAgentSession(taskId, roleName);

  if (command === "record") {
    if (
      roleName === BUILTIN_LEADER_ROLE &&
      existing !== null &&
      existing.nativeSessionId !== nativeSessionId
    ) {
      throw usageError("Leader session replacement must be explicit.");
    }

    const session = recordAgentSession(taskId, roleName, role.agent, nativeSessionId, new Date(), existing);
    store.saveAgentSession(session);
    if (roleName === BUILTIN_LEADER_ROLE) {
      store.clearLeaderFailure(taskId);
    }
    return `Recorded native session for ${taskId}/${roleName}\n`;
  }

  if (command === "replace") {
    const reason = readOption(rest, "--reason").trim();
    if (reason.length === 0) {
      throw usageError("Session replacement reason is required.");
    }

    const session = recordAgentSession(
      taskId,
      roleName,
      role.agent,
      nativeSessionId,
      new Date(),
      existing,
      reason
    );
    store.saveAgentSession(session);
    if (roleName === BUILTIN_LEADER_ROLE) {
      store.clearLeaderFailure(taskId);
    }
    recordTaskEvent(store, taskId, "role.session_replaced", { role: roleName, reason });
    return `Replaced native session for ${taskId}/${roleName}\n`;
  }

  throw usageError("Session usage: taskmux task session record|replace <task-id> <role> --native-id <id> [--reason <reason>].");
}

function wakeTaskCommand(args: string[], store: TaskStore): string {
  const [taskId, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const task = store.getTask(taskId);

  if (task === null) {
    throw taskNotFound(taskId);
  }

  if (task.archived) {
    throw usageError(`Cannot wake archived task: ${taskId}.`);
  }

  const reason = readOption(rest, "--reason").trim();
  queueLeaderWakeup(store, taskId, reason);
  recordTaskEvent(store, taskId, "leader.wakeup_requested", { reason });
  return `Queued leader wakeup for task ${taskId}\n`;
}

function taskCycleCommand(args: string[], store: TaskStore): string {
  const [command, taskId, ...rest] = args;

  if (command === "end" && taskId !== undefined) {
    const [cycleId, ...options] = rest;
    if (store.getTask(taskId) === null) {
      throw taskNotFound(taskId);
    }
    if (cycleId === undefined) {
      throw usageError("Cycle id is required.");
    }
    const cycle = store.getCycle(taskId, cycleId);
    if (cycle === null) {
      throw usageError(`Cycle not found: ${cycleId}.`);
    }
    if (cycle.status === "ended") {
      throw usageError(`Cycle is already ended: ${cycleId}.`);
    }
    const ended = endCycle(cycle, readOption(options, "--summary"), new Date());
    store.saveCycle(taskId, ended);
    recordTaskEvent(store, taskId, "cycle.ended", { cycle: cycle.id });
    return `Ended cycle ${cycle.id} for task ${taskId}\n`;
  }

  if (command !== "create" || taskId === undefined || store.getTask(taskId) === null) {
    if (taskId !== undefined && store.getTask(taskId) === null) {
      throw taskNotFound(taskId);
    }
    throw usageError("Cycle usage: taskmux task cycle create <task-id> --cause <cause> --summary <summary>.");
  }

  const cause = readOption(rest, "--cause");
  const allowedCauses = [
    "task-created", "user-comment", "schedule", "review-time", "operator-input",
    "role-result", "inactivity", "explicit-wake"
  ];

  if (!allowedCauses.includes(cause)) {
    throw usageError(`Invalid cycle cause: ${cause}.`);
  }

  const cycle = createCycle(
    store.nextCycleId(taskId),
    taskId,
    cause as CycleCause,
    readOption(rest, "--summary"),
    new Date()
  );
  store.saveCycle(taskId, cycle);
  recordTaskEvent(store, taskId, "cycle.created", { cycle: cycle.id, cause: cycle.cause });
  return `Created cycle ${cycle.id} for task ${taskId}\n`;
}

function taskWorkItemCommand(args: string[], store: TaskStore): string {
  const [command, taskId, ...commandArgs] = args;

  if (taskId !== undefined && store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  if (command === "update" && taskId !== undefined) {
    const [workItemId, ...rest] = commandArgs;
    if (workItemId === undefined) {
      throw usageError("Work item id is required.");
    }
    const workItem = store.getWorkItem(taskId, workItemId);
    if (workItem === null) {
      throw usageError(`Work item not found: ${workItemId}.`);
    }
    const status = readOption(rest, "--status");
    const allowed = ["pending", "running", "completed", "failed", "cancelled", "superseded"];
    if (!allowed.includes(status)) {
      throw usageError(`Invalid work item status: ${status}.`);
    }
    const updated = updateWorkItemStatus(
      workItem,
      status as WorkItemStatus,
      readOptionalOption(rest, "--outcome"),
      new Date()
    );
    store.saveWorkItem(taskId, updated);
    recordTaskEvent(store, taskId, "work-item.updated", { workItem: updated.id, status });
    return `Updated work item ${updated.id} for task ${taskId}\n`;
  }

  if (command !== "create" || taskId === undefined) {
    throw usageError("Work item usage: taskmux task work-item create <task-id> --title <title> [--cycle <cycle>] [--assignee <role>] [--topic <topic> ...].");
  }

  const rest = commandArgs;

  const cycleId = readOptionalOption(rest, "--cycle")?.trim();
  const assignee = readOptionalOption(rest, "--assignee")?.trim() ?? BUILTIN_LEADER_ROLE;
  const topics = readRepeatedOption(rest, "--topic").map((topic) => topic.trim());
  const knownTopicIds = new Set([
    ...BUILTIN_TOPICS.map(({ id }) => id),
    ...store.getTaskTopics(taskId).customTopics.map(({ id }) => id)
  ]);

  if (cycleId !== undefined && store.getCycle(taskId, cycleId) === null) {
    throw usageError(`Cycle not found: ${cycleId}.`);
  }

  if (store.getRole(taskId, assignee) === null) {
    throw roleNotFound(assignee);
  }

  const unknownTopic = topics.find((topic) => !knownTopicIds.has(topic));
  if (unknownTopic !== undefined) {
    throw usageError(`Topic not found: ${unknownTopic}.`);
  }

  const workItem = createWorkItem(
    store.nextWorkItemId(taskId),
    taskId,
    {
      title: readOption(rest, "--title"),
      assignee,
      topics,
      ...(cycleId === undefined ? {} : { cycleId })
    },
    new Date()
  );
  store.saveWorkItem(taskId, workItem);
  recordTaskEvent(store, taskId, "work-item.created", { workItem: workItem.id, assignee });
  return `Created work item ${workItem.id} for task ${taskId}\n`;
}

function taskInputCommand(args: string[], store: TaskStore): string {
  const [command, taskId, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  if (command === "draft") {
    const body = rest.join(" ").trim();
    const draft = createTaskInputDraft(taskId, body, new Date(), store.getTaskInputDraft(taskId) ?? undefined);
    store.saveTaskInputDraft(taskId, draft);
    return `Saved input draft for task ${taskId}\n`;
  }

  if (command === "submit" && rest.length === 0) {
    const draft = store.getTaskInputDraft(taskId);

    if (draft === null) {
      throw usageError(`No input draft exists for task ${taskId}.`);
    }

    const comment = createTaskComment(store.nextCommentId(taskId), draft.body, new Date(), "operator");
    store.saveComment(taskId, comment);
    recordTaskEvent(store, taskId, "task.input_submitted", { comment: comment.id });
    queueLeaderWakeup(store, taskId, "operator-input");
    store.clearTaskInputDraft(taskId);
    return `Submitted input draft for task ${taskId}\n`;
  }

  throw usageError("Input usage: taskmux task input draft <task-id> <body> | taskmux task input submit <task-id>.");
}

function updateTaskArchivedCommand(args: string[], store: TaskStore, archived: boolean): string {
  const [taskId, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError(`Task ${archived ? "archive" : "unarchive"} requires a task id.`);
  }
  if (archived) {
    assertKnownOptions(rest, new Set(["--reason", "--summary"]));
  } else if (rest.length > 0) {
    throw usageError("Task unarchive requires exactly one task id.");
  }

  const task = store.getTask(taskId);

  if (task === null) {
    throw taskNotFound(taskId);
  }

  const actor = process.env.TASKMUX_ROLE === "leader"
    ? "leader"
    : process.env.TASKMUX_ROLE === "operator" ? "operator" : "user";
  const reason = archived ? readOptionalOption(rest, "--reason") : undefined;
  const summary = archived ? readOptionalOption(rest, "--summary") : undefined;
  const updatedTask = updateTaskArchived(task, archived, new Date(), { by: actor, reason, summary });
  store.saveTask(updatedTask);
  if (archived) {
    store.clearPendingWakeup(taskId);
  }
  recordTaskEvent(store, taskId, archived ? "task.archived" : "task.unarchived", {
    ...(reason === undefined ? {} : { reason })
  });
  return `${archived ? "Archived" : "Unarchived"} task ${taskId}\n`;
}

function taskTopicCommand(args: string[], store: TaskStore): string {
  const [command, taskId, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  if (command === "create") {
    const topics = store.getTaskTopics(taskId);
    const topic = createCustomTopic(
      {
        id: readOption(rest, "--id"),
        name: readOption(rest, "--name"),
        description: readOption(rest, "--description"),
        createdBy: "user"
      },
      new Date()
    );

    if (BUILTIN_TOPICS.some(({ id }) => id === topic.id) || topics.customTopics.some(({ id }) => id === topic.id)) {
      throw usageError(`Topic already exists: ${topic.id}`);
    }

    store.saveTaskTopics(taskId, {
      ...topics,
      customTopics: [...topics.customTopics, topic]
    });
    const warning = usesConventionalTopicId(topic.id)
      ? ""
      : "Warning: topic ids conventionally use lower-case kebab-case.\n";
    return `Created topic ${topic.id} for task ${taskId}\n${warning}`;
  }

  if (command === "list" && rest.length === 0) {
    const customTopics = store.getTaskTopics(taskId).customTopics;
    const rows = [
      ...BUILTIN_TOPICS.map((topic) => [topic.id, topic.name, "built-in", topic.description]),
      ...customTopics.map((topic) => [topic.id, topic.name, "custom", topic.description])
    ];

    return `${renderTable(
      `Task topics: ${taskId}`,
      [
        { header: "Topic", minWidth: 8, maxWidth: 24 },
        { header: "Name", minWidth: 4, maxWidth: 16 },
        { header: "Scope", minWidth: 7, maxWidth: 8 },
        { header: "Description", minWidth: 11, maxWidth: 44 }
      ],
      rows,
      defaultTableWidth()
    )}\n`;
  }

  throw usageError("Topic usage: taskmux task topic create|list <task-id>.");
}

function createTaskCommand(args: string[], store: TaskStore): string {
  const input = parseTaskBoardInput(args, {
    requireTitle: true,
    extraKnownOptions: new Set(["--template", "--agent", "--workspace"])
  });
  const title = input.title ?? "";

  if (title.length === 0) {
    throw usageError("Task title is required.");
  }

  const template = parseTaskTemplate(readOptionalOption(args, "--template"));
  const metadata = template === undefined ? input.metadata : mergeTemplateMetadata(input.metadata, template);
  const task = createTask(store.nextTaskId(), title, new Date(), metadata);
  const config = store.getConfig();
  const explicitAgent = readOptionalOption(args, "--agent")?.trim();
  const defaultAgent = explicitAgent ?? config.defaultAgent;
  const explicitWorkspace = readOptionalOption(args, "--workspace")?.trim();
  const workspace = explicitWorkspace ?? config.defaultWorkspace ?? process.cwd();
  const assignedRoles = uniqueStrings([BUILTIN_LEADER_ROLE, ...(template?.roles ?? [])])
    .map((roleName) => createRoleFromGlobalOrAgent(roleName, {
      agent: explicitAgent,
      fallbackAgent: defaultAgent,
      workspace,
      workspaceOverride: explicitWorkspace
    }, store));

  store.saveTask(task);
  rememberTask(store, task.id);
  recordTaskEvent(store, task.id, "task.created", { title: task.title });
  assignedRoles.forEach((role) => saveRoleAndRecordEvent(task.id, role, store));
  if (process.env.TASKMUX_CONTROLLER_MODE !== "direct") {
    queueLeaderWakeup(store, task.id, "task-created");
  }

  if (template === undefined) {
    return [
      `Created task ${task.id}: ${task.title}`,
      `Assigned roles: ${assignedRoles.map((role) => role.name).join(", ")}`
    ].join("\n").concat("\n");
  }

  return [
    `Created task ${task.id}: ${task.title}`,
    `Template: ${template.name}`,
    `Assigned roles: ${assignedRoles.map((role) => role.name).join(", ")}`
  ].join("\n").concat("\n");
}

function listTaskCommand(args: string[], store: TaskStore): string {
  const filters = parseTaskListFilters(args);
  const tasks = store.listTasks().filter((task) => taskMatchesFilters(task, filters));

  if (tasks.length === 0) {
    return "No tasks found.\n";
  }

  return `${renderTaskListTable(tasks)}\n`;
}

function boardTaskCommand(args: string[], store: TaskStore): string {
  const options = parseTaskBoardViewOptions(args);
  const tasks = store.listTasks().filter((task) => taskMatchesFilters(task, options.filters));

  return renderTaskBoard(tasks, store, options.withRoles);
}

function showTaskCommand(args: string[], store: TaskStore): string {
  const [id] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const task = store.getTask(id);

  if (task === null) {
    throw taskNotFound(id);
  }

  rememberTask(store, task.id);

  return [
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Archived: ${task.archived ? "yes" : "no"}`,
    ...renderTaskMetadataLines(task),
    `Created: ${task.createdAt}`,
    `Updated: ${task.updatedAt}`
  ].join("\n").concat("\n");
}

function currentTaskCommand(args: string[], store: TaskStore): string {
  const [taskId] = args;

  if (taskId === undefined) {
    return renderTaskPointer("Current task", store.getConfig().currentTaskId, store);
  }

  if (taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const task = store.getTask(taskId);

  if (task === null) {
    throw taskNotFound(taskId);
  }

  rememberTask(store, task.id, { current: true });

  return `Current task: ${task.id} ${task.title}\n`;
}

function lastTaskCommand(store: TaskStore): string {
  return renderTaskPointer("Last task", store.getConfig().lastTaskId, store);
}

function cloneTaskCommand(args: string[], store: TaskStore): string {
  const [sourceTaskId, ...rest] = args;

  if (sourceTaskId === undefined || sourceTaskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const sourceTask = store.getTask(sourceTaskId);

  if (sourceTask === null) {
    throw taskNotFound(sourceTaskId);
  }

  assertKnownOptions(rest, new Set(["--title"]));

  const title = readOptionalOption(rest, "--title")?.trim() ?? `${sourceTask.title} copy`;
  const clonedTask = createTask(store.nextTaskId(), title, new Date(), {
    description: sourceTask.description,
    priority: sourceTask.priority,
    tags: sourceTask.tags,
    dueAt: sourceTask.dueAt
  });

  store.saveTask(clonedTask);
  rememberTask(store, clonedTask.id);
  recordTaskEvent(store, clonedTask.id, "task.created", { title: clonedTask.title });
  recordTaskEvent(store, clonedTask.id, "task.cloned", { from: sourceTask.id });

  const roles = store.listRoles(sourceTask.id).map((role) => {
    const clonedRole = createRole(
      role.name,
      {
        id: role.agent,
        command: role.command,
        args: role.args,
        env: role.env,
        source: "custom"
      },
      role.workspace,
      new Date(),
      {
        description: role.description,
        responsibilities: role.responsibilities,
        constraints: role.constraints,
        expectedOutput: role.expectedOutput,
        systemPrompt: role.systemPrompt,
        skills: role.skills
      }
    );

    store.saveRole(clonedTask.id, clonedRole);
    recordTaskEvent(store, clonedTask.id, "role.assigned", { role: clonedRole.name, agent: clonedRole.agent });
    return clonedRole.name;
  });

  return [
    `Cloned task ${sourceTask.id} -> ${clonedTask.id}`,
    `Title: ${clonedTask.title}`,
    `Roles: ${roles.length === 0 ? "none" : roles.join(", ")}`
  ].join("\n").concat("\n");
}

function updateTaskCommand(args: string[], store: TaskStore): string {
  const [id, ...rest] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const task = store.getTask(id);

  if (task === null) {
    throw taskNotFound(id);
  }

  const input = parseTaskBoardInput(rest, { requireTitle: false, allowTitleOption: true, allowClear: true });
  const patch = input.title === undefined ? input.metadata : { title: input.title, ...input.metadata };

  if (Object.keys(patch).length === 0) {
    throw usageError("At least one task update option is required.");
  }

  const updatedTask = updateTaskMetadata(task, patch, new Date());
  store.saveTask(updatedTask);
  recordTaskEvent(store, updatedTask.id, "task.updated", { title: updatedTask.title });

  return `Updated task ${updatedTask.id}\n`;
}

function openTaskCommand(args: string[], store: TaskStore): string {
  const [id] = args;

  if (id === undefined || id.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const task = store.getTask(id);

  if (task === null) {
    throw taskNotFound(id);
  }

  rememberTask(store, task.id);

  return [
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Archived: ${task.archived ? "yes" : "no"}`,
    ...renderTaskMetadataLines(task),
    `Roles: ${store.listRoles(task.id).length}`,
    `Comments: ${store.listComments(task.id).length}`,
    `Next: taskmux task enter ${task.id} <role>`
  ].join("\n").concat("\n");
}

function contextTaskCommand(args: string[], store: TaskStore): string {
  const [taskId, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  const task = store.getTask(taskId);

  if (task === null) {
    throw taskNotFound(taskId);
  }

  rememberTask(store, task.id);

  const options = parseTaskContextOptions(rest);
  const context = buildTaskContext(task, store, options.includeTranscripts);

  if (options.format === "json") {
    return `${JSON.stringify(context, null, 2)}\n`;
  }

  return renderTaskContextText(context, options.includeTranscripts);
}

function deleteTaskCommand(args: string[], store: TaskStore): string {
  const [taskId] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  recordTaskEvent(store, taskId, "task.deleted", { task: taskId });
  store.deleteTask(taskId);

  return `Deleted task ${taskId}\n`;
}

function restoreTaskCommand(args: string[], store: TaskStore): string {
  const [taskId] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (!store.restoreTask(taskId)) {
    throw taskNotFound(taskId);
  }

  recordTaskEvent(store, taskId, "task.restored", { task: taskId });

  return `Restored task ${taskId}\n`;
}

function taskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  const [command, ...rest] = args;

  switch (command) {
    case "child":
      return createTaskChildRoleCommand(rest, store);
    case "update":
      return updateTaskRoleCommand(rest, store);
    case "rename":
      return renameTaskRoleCommand(rest, store, tmux);
    case "remove":
      return removeTaskRoleCommand(rest, store);
    default:
      return taskUsage();
  }
}

function removeTaskRoleCommand(args: string[], store: TaskStore): string {
  const [taskId, roleName, ...rest] = args;

  if (taskId === undefined || roleName === undefined || rest.length > 0) {
    throw usageError("Role remove usage: taskmux task role remove <task-id> <role>.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  if (roleName === BUILTIN_LEADER_ROLE) {
    throw usageError("The task leader role cannot be removed.");
  }

  const result = store.removeTaskRole(taskId, roleName);
  if (!result.removed) {
    throw roleNotFound(roleName);
  }

  recordTaskEvent(store, taskId, "role.removed", {
    role: roleName,
    childCount: String(result.childCount)
  });
  return `Removed role ${roleName} and ${result.childCount} child role${result.childCount === 1 ? "" : "s"}\n`;
}

function createTaskChildRoleCommand(args: string[], store: TaskStore): string {
  const [taskId, roleName, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (roleName === undefined || roleName.trim().length === 0) {
    throw usageError("Child role name is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  assertKnownOptions(rest, new Set([
    "--parent",
    "--description",
    "--responsibility",
    "--constraint",
    "--expected-output"
  ]));

  const parentRole = readOptionalOption(rest, "--parent")?.trim() ?? BUILTIN_LEADER_ROLE;

  if (store.getRole(taskId, parentRole) === null) {
    throw roleNotFound(parentRole);
  }

  if (store.getRole(taskId, roleName) !== null || store.getChildRole(taskId, roleName) !== null) {
    throw usageError(`Role already exists: ${roleName}.`);
  }

  const childRole = createChildRole(
    roleName,
    parentRole,
    {
      description: readOption(rest, "--description"),
      responsibilities: readRepeatedOption(rest, "--responsibility"),
      constraints: readRepeatedOption(rest, "--constraint"),
      expectedOutput: readOption(rest, "--expected-output")
    },
    new Date()
  );
  store.saveChildRole(taskId, childRole);
  recordTaskEvent(store, taskId, "child-role.created", {
    role: childRole.name,
    parent: childRole.parentRole
  });

  return `Created child role ${childRole.name} for parent ${childRole.parentRole}\n`;
}

function assignTaskRoleCommand(args: string[], store: TaskStore): string {
  const [taskId, roleName, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (roleName === undefined || roleName.trim().length === 0) {
    throw usageError("Role name is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  assertKnownOptions(rest, new Set(["--agent", "--workspace", "--as"]));

  const agent = readOptionalOption(rest, "--agent")?.trim();
  const workspace = readOptionalOption(rest, "--workspace")?.trim();
  const targetName = readOptionalOption(rest, "--as")?.trim() ?? roleName;
  const role = agent === undefined
    ? copyGlobalRole(roleName, store, { name: targetName, workspaceOverride: workspace })
    : createResolvedRole(targetName, agent, requireWorkspace(workspace), store);

  saveRoleAndRecordEvent(taskId, role, store);

  if (agent === undefined) {
    return [
      `Bound role ${role.name} to ${taskId}`,
      `Source role: ${roleName}`,
      `Agent: ${role.agent}`,
      `Workspace: ${role.workspace}`
    ].join("\n").concat("\n");
  }

  return [
    `Assigned role ${role.name} to ${taskId}`,
    `Agent: ${agent}`,
    `Workspace: ${role.workspace}`
  ].join("\n").concat("\n");
}

function bindTaskRoleCommand(args: string[], store: TaskStore): string {
  return assignTaskRoleCommand(args, store);
}

function assignManyTaskRolesCommand(args: string[], store: TaskStore): string {
  const [taskId, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  assertKnownOptions(rest, new Set(["--role", "--agent", "--workspace"]));

  const roleNames = readRepeatedOption(rest, "--role").map((role) => role.trim()).filter((role) => role.length > 0);

  if (roleNames.length === 0) {
    throw usageError("At least one --role is required.");
  }

  const config = store.getConfig();
  const agent = readOptionalOption(rest, "--agent")?.trim() ?? config.defaultAgent;
  const explicitWorkspace = readOptionalOption(rest, "--workspace")?.trim();
  const workspace = explicitWorkspace ?? config.defaultWorkspace;

  const assignedRoles = roleNames.map((roleName) => {
    const role = createRoleFromGlobalOrAgent(roleName, {
      agent: undefined,
      fallbackAgent: agent,
      workspace,
      workspaceOverride: explicitWorkspace
    }, store);

    saveRoleAndRecordEvent(taskId, role, store);
    return role.name;
  });

  return `Assigned roles to ${taskId}: ${assignedRoles.join(", ")}\n`;
}

function updateTaskRoleCommand(args: string[], store: TaskStore): string {
  const [taskId, roleName, ...rest] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (roleName === undefined || roleName.trim().length === 0) {
    throw usageError("Role name is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const role = store.getRole(taskId, roleName);

  if (role === null) {
    throw roleNotFound(roleName);
  }

  assertKnownOptions(rest, new Set(["--agent", "--workspace"]));

  const agent = readOptionalOption(rest, "--agent")?.trim();
  const workspace = readOptionalOption(rest, "--workspace")?.trim();
  const patch: Partial<Pick<Role, "agent" | "command" | "args" | "env" | "workspace">> = {};

  if (agent !== undefined) {
    if (agent.length === 0) {
      throw usageError("--agent is required.");
    }

    const runner = resolveRunner(agent, store.listCustomRunners());

    if (runner === null) {
      throw usageError(`Unsupported agent: ${agent}\nSupported agents: ${supportedRunnerIds(store.listCustomRunners()).join(", ")}`);
    }

    patch.agent = runner.id;
    patch.command = runner.command;
    patch.args = runner.args;
    patch.env = runner.env;
  }

  if (workspace !== undefined) {
    if (workspace.length === 0) {
      throw usageError("--workspace is required.");
    }

    patch.workspace = workspace;
  }

  if (Object.keys(patch).length === 0) {
    throw usageError("At least one role update option is required.");
  }

  const updatedRole = updateRole(role, patch, new Date());
  store.saveRole(taskId, updatedRole);
  recordTaskEvent(store, taskId, "role.updated", { role: updatedRole.name });

  return `Updated role ${updatedRole.name} for ${taskId}\n`;
}

function renameTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  const [taskId, oldName, newName] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (oldName === undefined || oldName.trim().length === 0) {
    throw usageError("Role name is required.");
  }

  if (newName === undefined || newName.trim().length === 0) {
    throw usageError("New role name is required.");
  }

  if (oldName === BUILTIN_LEADER_ROLE || newName.trim() === BUILTIN_LEADER_ROLE) {
    throw usageError("Built-in leader role cannot be renamed.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const role = store.getRole(taskId, oldName);

  if (role === null) {
    throw roleNotFound(oldName);
  }

  if (store.getRole(taskId, newName) !== null) {
    throw usageError(`Role already exists: ${newName}`);
  }

  try {
    tmux?.renameRole(taskId, oldName, newName);
  } catch {
    // Role metadata is still renamed when no tmux session or window exists.
  }

  const renamedRole = updateRole(role, { name: newName }, new Date());
  store.renameRole(taskId, oldName, renamedRole);
  recordTaskEvent(store, taskId, "role.renamed", { from: oldName, to: newName });

  return `Renamed role ${oldName} to ${newName} for ${taskId}\n`;
}

function listTaskRolesCommand(args: string[], store: TaskStore): string {
  const [taskId] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const roles = store.listRoles(taskId);

  if (roles.length === 0) {
    return "No roles assigned.\n";
  }

  return `${renderRoleTable(`Task roles: ${taskId}`, roles)}\n`;
}

function enterTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  const roleLookup = findRole(args, store);

  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }

  if (tmux === undefined) {
    throw runtimeError("Tmux manager is not configured.");
  }

  tmux.enterRole(roleLookup.taskId, roleLookup.role);
  store.saveRole(roleLookup.taskId, updateRoleStatus(roleLookup.role, "running", new Date()));

  return `Attached role ${roleLookup.role.name} for ${roleLookup.taskId}\n`;
}

function tailTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  const roleLookup = findRole(args, store);

  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }

  if (tmux === undefined) {
    throw runtimeError("Tmux manager is not configured.");
  }

  return tmux.captureRole(roleLookup.taskId, roleLookup.role.name);
}

function transcriptTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  if (args[0] === "export") {
    return exportTranscriptCommand(args.slice(1), store);
  }

  const roleLookup = findRole(args, store);

  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }

  if (tmux === undefined) {
    throw runtimeError("Tmux manager is not configured.");
  }

  const transcript = tmux.captureRole(roleLookup.taskId, roleLookup.role.name);
  store.saveTranscript(roleLookup.taskId, roleLookup.role.name, transcript);

  return transcript;
}

function exportTranscriptCommand(args: string[], store: TaskStore): string {
  const roleLookup = findRole(args, store);

  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }

  const rest = args.slice(2);
  assertKnownOptions(rest, new Set(["--format", "--output"]));

  const format = parseTranscriptExportFormat(readOptionalOption(rest, "--format"));
  const transcript = store.readTranscript(roleLookup.taskId, roleLookup.role.name);

  if (transcript === null) {
    return "No transcript captured.\n";
  }

  const rendered = renderTranscriptExport(roleLookup.taskId, roleLookup.role.name, transcript, format);
  const output = readOptionalOption(rest, "--output")?.trim();

  if (output !== undefined && output.length > 0) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, rendered);
    return `Exported transcript ${roleLookup.taskId} ${roleLookup.role.name} to ${output}\n`;
  }

  return rendered;
}

function detailTaskRoleCommand(args: string[], store: TaskStore): string {
  const roleLookup = findRole(args, store);

  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }

  const role = roleLookup.role;

  return [
    `Task: ${roleLookup.taskId}`,
    `Role: ${role.name}`,
    `Agent: ${role.agent}`,
    `Workspace: ${role.workspace}`,
    `Status: ${role.status}`,
    `Tmux: taskmux-${roleLookup.taskId}:${role.name}`,
    `Created: ${role.createdAt}`,
    `Updated: ${role.updatedAt}`
  ].join("\n").concat("\n");
}

function refreshTaskRolesCommand(
  args: string[],
  store: TaskStore,
  tmux: TmuxManager | undefined,
  action: string
): string {
  const [taskId] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  if (tmux === undefined) {
    throw runtimeError("Tmux manager is not configured.");
  }

  const roles = store.listRoles(taskId);

  if (roles.length === 0) {
    return `${action} task ${taskId} roles\nNo roles assigned.\n`;
  }

  const currentRoles = roles.map((role) => {
    const status = tmux.detectRoleStatus(taskId, role.name, role.status);
    const currentRole = status === role.status ? role : updateRoleStatus(role, status, new Date());

    if (currentRole !== role) {
      store.saveRole(taskId, currentRole);
    }

    return currentRole;
  });

  return `${renderTable(
    `${action} task ${taskId} roles`,
    [
      { header: "Role", minWidth: 4, maxWidth: 24 },
      { header: "Status", minWidth: 6, maxWidth: 12 }
    ],
    currentRoles.map((role) => [role.name, role.status]),
    defaultTableWidth()
  )}\n`;
}

function statusTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  const roleLookup = findRole(args, store);

  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }

  const role = roleLookup.role;
  const status = tmux?.detectRoleStatus(roleLookup.taskId, role.name, role.status) ?? role.status;
  const currentRole = status === role.status ? role : updateRoleStatus(role, status, new Date());

  if (currentRole !== role) {
    store.saveRole(roleLookup.taskId, currentRole);
  }

  return [
    `Task: ${roleLookup.taskId}`,
    `Role: ${currentRole.name}`,
    `Agent: ${currentRole.agent}`,
    `Workspace: ${currentRole.workspace}`,
    `Status: ${currentRole.status}`,
    `Tmux: taskmux-${roleLookup.taskId}:${currentRole.name}`,
    `Created: ${currentRole.createdAt}`,
    `Updated: ${currentRole.updatedAt}`
  ].join("\n").concat("\n");
}

function detachTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  const roleLookup = findRole(args, store);

  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }

  if (tmux === undefined) {
    throw runtimeError("Tmux manager is not configured.");
  }

  tmux.detachRole(roleLookup.taskId);
  store.saveRole(roleLookup.taskId, updateRoleStatus(roleLookup.role, "detached", new Date()));

  return `Detached role ${roleLookup.role.name} for ${roleLookup.taskId}\n`;
}

function restartTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  const roleLookup = findRole(args, store);

  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }

  if (tmux === undefined) {
    throw runtimeError("Tmux manager is not configured.");
  }

  tmux.restartRole(roleLookup.taskId, roleLookup.role);
  store.saveRole(roleLookup.taskId, updateRoleStatus(roleLookup.role, "running", new Date()));

  return `Restarted role ${roleLookup.role.name} for ${roleLookup.taskId}\n`;
}

function stopTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  const roleLookup = findRole(args, store);

  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }

  if (tmux === undefined) {
    throw runtimeError("Tmux manager is not configured.");
  }

  tmux.stopRole(roleLookup.taskId, roleLookup.role.name);
  store.saveRole(roleLookup.taskId, updateRoleStatus(roleLookup.role, "exited", new Date()));

  return `Stopped role ${roleLookup.role.name} for ${roleLookup.taskId}\n`;
}

function killTaskRoleCommand(args: string[], store: TaskStore, tmux?: TmuxManager): string {
  const roleLookup = findRole(args, store);

  if (typeof roleLookup === "string") {
    throw usageError(roleLookup.trim());
  }

  if (tmux === undefined) {
    throw runtimeError("Tmux manager is not configured.");
  }

  tmux.killRole(roleLookup.taskId, roleLookup.role.name);
  store.saveRole(roleLookup.taskId, updateRoleStatus(roleLookup.role, "exited", new Date()));

  return `Killed role ${roleLookup.role.name} for ${roleLookup.taskId}\n`;
}

function addTaskCommentCommand(args: string[], store: TaskStore): string {
  const [taskId, ...bodyParts] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const body = bodyParts.join(" ").trim();

  if (body.length === 0) {
    throw usageError("Comment body is required.");
  }

  const comment = createTaskComment(store.nextCommentId(taskId), body, new Date(), "user");
  store.saveComment(taskId, comment);
  recordTaskEvent(store, taskId, "comment.added", { comment: comment.id });
  queueLeaderWakeup(store, taskId, "user-comment");

  return `Added comment to ${taskId}: ${comment.body}\n`;
}

function listTaskCommentsCommand(args: string[], store: TaskStore): string {
  const [taskId] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const comments = store.listComments(taskId);

  if (comments.length === 0) {
    return "No comments found.\n";
  }

  return `${renderTable(
    `Task comments: ${taskId}`,
    [
      { header: "Comment", minWidth: 7, maxWidth: 16 },
      { header: "Created", minWidth: 10, maxWidth: 28 },
      { header: "Body", minWidth: 8, maxWidth: 76 }
    ],
    comments.map((comment) => [comment.id, comment.createdAt, comment.body]),
    defaultTableWidth()
  )}\n`;
}

function listTaskEventsCommand(args: string[], store: TaskStore): string {
  const [taskId] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const events = store.listEvents(taskId);

  if (events.length === 0) {
    return "No events found.\n";
  }

  return `${renderEventTable(`Task events: ${taskId}`, events)}\n`;
}

function taskActivityCommand(args: string[], store: TaskStore): string {
  const [taskId] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const roles = store.listRoles(taskId);

  if (roles.length === 0) {
    return `Task activity: ${taskId}\nNo roles assigned.\n`;
  }

  return `${renderTable(
    `Task activity: ${taskId}`,
    [
      { header: "Role", minWidth: 4, maxWidth: 24 },
      { header: "Agent", minWidth: 5, maxWidth: 20 },
      { header: "Status", minWidth: 6, maxWidth: 12 },
      { header: "Transcript", minWidth: 10, maxWidth: 18 },
      { header: "Updated", minWidth: 10, maxWidth: 28 }
    ],
    roles.map((role) => {
      const transcript = store.readTranscript(taskId, role.name);

      return [
        role.name,
        role.agent,
        role.status,
        String(countTranscriptLines(transcript)),
        role.updatedAt
      ];
    }),
    defaultTableWidth()
  )}\n`;
}

function taskTimelineCommand(args: string[], store: TaskStore): string {
  const [taskId] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    throw usageError("Task id is required.");
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const lines = [
    ...store.listEvents(taskId).map((event) => ({
      createdAt: event.createdAt,
      row: [event.createdAt, "event", event.type, renderEventPayload(event.payload)]
    })),
    ...store.listComments(taskId).map((comment) => ({
      createdAt: comment.createdAt,
      row: [comment.createdAt, "comment", comment.id, comment.body]
    }))
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  if (lines.length === 0) {
    return `Task timeline: ${taskId}\nNo timeline entries.\n`;
  }

  return `${renderTable(
    `Task timeline: ${taskId}`,
    [
      { header: "Created", minWidth: 10, maxWidth: 28 },
      { header: "Kind", minWidth: 5, maxWidth: 10 },
      { header: "Type", minWidth: 4, maxWidth: 24 },
      { header: "Detail", minWidth: 8, maxWidth: 76 }
    ],
    lines.map((entry) => entry.row),
    defaultTableWidth()
  )}\n`;
}

type TaskContextFormat = "text" | "json";

type TaskContextOptions = {
  format: TaskContextFormat;
  includeTranscripts: boolean;
};

type TaskContextRole = Role & {
  transcript?: string | null;
};

type TaskContext = {
  task: Task;
  brief: string | null;
  roles: TaskContextRole[];
  childRoles: ChildRole[];
  topics: {
    builtIn: typeof BUILTIN_TOPICS;
    custom: ReturnType<TaskStore["getTaskTopics"]>["customTopics"];
  };
  activeRuns: AgentRun[];
  schedule: ReturnType<TaskStore["getTaskSchedule"]>;
  cycles: ReturnType<TaskStore["listCycles"]>;
  workItems: ReturnType<TaskStore["listWorkItems"]>;
  milestones: ReturnType<TaskStore["listMilestones"]>;
  decisions: ReturnType<TaskStore["listDecisions"]>;
  sessions: Record<string, NonNullable<ReturnType<TaskStore["getAgentSession"]>>>;
  pendingWakeup: ReturnType<TaskStore["getPendingWakeup"]>;
  leaderFailure: ReturnType<TaskStore["getLeaderFailure"]>;
  comments: TaskComment[];
  events: TaskEvent[];
};

function parseTaskContextOptions(args: string[]): TaskContextOptions {
  assertKnownOptions(args, new Set(["--format", "--include-transcripts"]));

  const format = parseTaskContextFormat(readOptionalOption(args, "--format"));

  return {
    format,
    includeTranscripts: hasFlag(args, "--include-transcripts")
  };
}

function parseTaskContextFormat(value: string | undefined): TaskContextFormat {
  if (value === undefined) {
    return "text";
  }

  if (value !== "text" && value !== "json") {
    throw usageError("--format must be one of text, json.");
  }

  return value;
}

function buildTaskContext(task: Task, store: TaskStore, includeTranscripts: boolean): TaskContext {
  return {
    task,
    brief: store.readTaskBrief(task.id),
    roles: store.listRoles(task.id).map((role) => includeTranscripts
      ? { ...role, transcript: store.readTranscript(task.id, role.name) }
      : role),
    childRoles: store.listChildRoles(task.id),
    topics: {
      builtIn: BUILTIN_TOPICS,
      custom: store.getTaskTopics(task.id).customTopics
    },
    activeRuns: store.listRoles(task.id)
      .map((role) => store.getActiveAgentRun(task.id, role.name))
      .filter((run): run is AgentRun => run !== null),
    schedule: store.getTaskSchedule(task.id),
    cycles: store.listCycles(task.id),
    workItems: store.listWorkItems(task.id),
    milestones: store.listMilestones(task.id),
    decisions: store.listDecisions(task.id),
    sessions: Object.fromEntries(store.listRoles(task.id)
      .map((role) => [role.name, store.getAgentSession(task.id, role.name)] as const)
      .filter((entry): entry is readonly [string, NonNullable<ReturnType<TaskStore["getAgentSession"]>>] => entry[1] !== null)),
    pendingWakeup: store.getPendingWakeup(task.id),
    leaderFailure: store.getLeaderFailure(task.id),
    comments: store.listComments(task.id),
    events: store.listEvents(task.id)
  };
}

function renderTaskContextText(context: TaskContext, includeTranscripts: boolean): string {
  return [
    "Task Context",
    ...renderTaskContextTaskLines(context.task),
    ...(context.brief === null ? [] : ["", context.brief.trimEnd()]),
    "",
    renderTaskContextRoles(context.roles, includeTranscripts),
    ...(context.childRoles.length === 0
      ? []
      : ["", "Child role constraints", ...context.childRoles.map((role) =>
        `${role.name} -> ${role.parentRole}: ${role.description}; expected: ${role.expectedOutput}`
      )]),
    "",
    renderTaskContextComments(context.comments),
    "",
    renderTaskContextEvents(context.events)
  ].join("\n").concat("\n");
}

function renderTaskContextTaskLines(task: Task): string[] {
  return [
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Archived: ${task.archived ? "yes" : "no"}`,
    ...renderTaskMetadataLines(task),
    `Created: ${task.createdAt}`,
    `Updated: ${task.updatedAt}`
  ];
}

function renderTaskContextRoles(roles: TaskContextRole[], includeTranscripts: boolean): string {
  const columns = [
    { header: "Role", minWidth: 4, maxWidth: 24 },
    { header: "Agent", minWidth: 5, maxWidth: 20 },
    { header: "Status", minWidth: 6, maxWidth: 12 },
    { header: "Workspace", minWidth: 9, maxWidth: 48 },
    ...(includeTranscripts ? [{ header: "Transcript", minWidth: 10, maxWidth: 54 }] : [])
  ];
  const rows = roles.map((role) => [
    role.name,
    role.agent,
    role.status,
    role.workspace,
    ...(includeTranscripts ? [role.transcript === undefined || role.transcript === null ? "not captured" : role.transcript.trimEnd()] : [])
  ]);

  return renderTable("Roles", columns, rows, defaultTableWidth());
}

function renderTaskContextComments(comments: TaskComment[]): string {
  return renderTable(
    "Comments",
    [
      { header: "Comment", minWidth: 7, maxWidth: 16 },
      { header: "Body", minWidth: 8, maxWidth: 76 }
    ],
    comments.map((comment) => [comment.id, comment.body]),
    defaultTableWidth()
  );
}

function renderTaskContextEvents(events: TaskEvent[]): string {
  return renderEventTable("Events", events);
}

function recordTaskEvent(
  store: TaskStore,
  taskId: string,
  type: string,
  payload: Record<string, string>
): void {
  store.saveEvent(taskId, createTaskEvent(store.nextEventId(taskId), type, payload, new Date()));
}

function queueLeaderWakeup(store: TaskStore, taskId: string, reason: string): void {
  if (store.getTask(taskId)?.archived === true) {
    return;
  }
  store.savePendingWakeup(
    mergePendingWakeup(taskId, reason, new Date(), store.getPendingWakeup(taskId))
  );
}

function createResolvedRole(
  roleName: string,
  agent: string,
  workspace: string,
  store: TaskStore
): Role {
  const runner = resolveRunner(agent, store.listCustomRunners());

  if (runner === null) {
    throwUnsupportedAgent(agent, store);
  }

  return createRole(roleName, runner, workspace, new Date());
}

function createRoleFromGlobalOrAgent(
  roleName: string,
  options: {
    agent: string | undefined;
    fallbackAgent: string | undefined;
    workspace: string | undefined;
    workspaceOverride?: string;
  },
  store: TaskStore
): Role {
  if (options.agent === undefined) {
    const globalRole = store.getGlobalRole(roleName);

    if (globalRole !== null) {
      return copyGlobalRole(roleName, store, {
        workspaceOverride: options.workspaceOverride
      });
    }
  }

  const agent = options.agent ?? options.fallbackAgent;

  if (agent === undefined || agent.length === 0) {
    throw usageError(`Role ${roleName} requires an agent or a configured global role. Run taskmux role add ${roleName} --agent <agent-id>.`);
  }

  return createResolvedRole(roleName, agent, requireWorkspace(options.workspace), store);
}

function copyGlobalRole(
  roleName: string,
  store: TaskStore,
  options: { name?: string; workspaceOverride?: string } = {}
): Role {
  const globalRole = store.getGlobalRole(roleName);

  if (globalRole === null) {
    throw roleNotFound(roleName);
  }

  const role = copyGlobalRoleToTaskRole(globalRole, new Date(), options.name ?? globalRole.name);

  if (options.workspaceOverride !== undefined) {
    if (options.workspaceOverride.length === 0) {
      throw usageError("--workspace is required.");
    }

    return updateRole(role, { workspace: options.workspaceOverride }, new Date());
  }

  return role;
}

function saveRoleAndRecordEvent(taskId: string, role: Role, store: TaskStore): void {
  store.saveRole(taskId, role);
  recordTaskEvent(store, taskId, "role.assigned", { role: role.name, agent: role.agent });
}

function throwUnsupportedAgent(agent: string, store: TaskStore): never {
  const supportedAgents = supportedRunnerIds(store.listCustomRunners());
  const supportedText = supportedAgents.length === 0
    ? "none configured. Run taskmux setup, then add an agent."
    : supportedAgents.join(", ");

  throw usageError(`Unsupported agent: ${agent}\nSupported agents: ${supportedText}`);
}

function requireWorkspace(workspace: string | undefined): string {
  if (workspace !== undefined && workspace.length > 0) {
    return workspace;
  }

  throw usageError("--workspace is required.");
}

function rememberTask(store: TaskStore, taskId: string, options: { current?: boolean } = {}): void {
  const config = store.getConfig();

  store.saveConfig({
    ...config,
    lastTaskId: taskId,
    currentTaskId: options.current === true ? taskId : config.currentTaskId
  });
}

function renderTaskPointer(label: string, taskId: string | undefined, store: TaskStore): string {
  if (taskId === undefined) {
    return `${label}: (none)\n`;
  }

  const task = store.getTask(taskId);

  if (task === null) {
    return `${label}: ${taskId} missing\n`;
  }

  return `${label}: ${task.id} ${task.title}\n`;
}

function renderEventPayload(payload: Record<string, string>): string {
  return Object.entries(payload)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function renderRoleTable(title: string, roles: Role[]): string {
  return renderTable(
    title,
    [
      { header: "Role", minWidth: 4, maxWidth: 24 },
      { header: "Agent", minWidth: 5, maxWidth: 20 },
      { header: "Status", minWidth: 6, maxWidth: 12 },
      { header: "Workspace", minWidth: 9, maxWidth: 54 }
    ],
    roles.map((role) => [role.name, role.agent, role.status, role.workspace]),
    defaultTableWidth()
  );
}

function renderEventTable(title: string, events: TaskEvent[]): string {
  return renderTable(
    title,
    [
      { header: "Event", minWidth: 6, maxWidth: 16 },
      { header: "Created", minWidth: 10, maxWidth: 28 },
      { header: "Type", minWidth: 8, maxWidth: 24 },
      { header: "Payload", minWidth: 8, maxWidth: 76 }
    ],
    events.map((event) => [event.id, event.createdAt, event.type, renderEventPayload(event.payload)]),
    defaultTableWidth()
  );
}

function findRole(
  args: string[],
  store: TaskStore
): { taskId: string; role: NonNullable<ReturnType<TaskStore["getRole"]>> } | string {
  const [taskId, roleName] = args;

  if (taskId === undefined || taskId.trim().length === 0) {
    return "Task id is required.\n";
  }

  if (roleName === undefined || roleName.trim().length === 0) {
    return "Role name is required.\n";
  }

  if (store.getTask(taskId) === null) {
    throw taskNotFound(taskId);
  }

  const role = store.getRole(taskId, roleName);

  if (role === null) {
    throw roleNotFound(roleName);
  }

  return { taskId, role };
}

function readOption(args: string[], name: string): string {
  const index = args.indexOf(name);

  if (index === -1 || args[index + 1] === undefined) {
    throw usageError(`${name} is required.`);
  }

  return args[index + 1];
}

type TaskBoardInput = {
  title?: string;
  metadata: TaskMetadata;
};

type TaskTemplateName = "feature" | "bug" | "review";

type TaskTemplate = {
  name: TaskTemplateName;
  metadata: TaskMetadata;
  roles: string[];
};

type TranscriptExportFormat = "text" | "json" | "markdown";

type TaskListFilters = {
  archived?: boolean;
  tag?: string;
  priority?: TaskPriority;
  search?: string;
};

type TaskBoardViewOptions = {
  filters: TaskListFilters;
  withRoles: boolean;
};

function parseTaskBoardInput(
  args: string[],
  options: { requireTitle: boolean; allowTitleOption?: boolean; allowClear?: boolean; extraKnownOptions?: Set<string> }
): TaskBoardInput {
  const optionStart = args.findIndex((arg) => arg.startsWith("--"));
  const titleParts = optionStart === -1 ? args : args.slice(0, optionStart);
  const optionArgs = optionStart === -1 ? [] : args.slice(optionStart);
  const titleFromOption = options.allowTitleOption === true ? readOptionalOption(optionArgs, "--title")?.trim() : undefined;
  const title = (titleFromOption ?? titleParts.join(" ")).trim();
  const metadata: TaskMetadata = {};
  const description = readOptionalOption(optionArgs, "--description")?.trim();
  const priority = parseTaskPriority(readOptionalOption(optionArgs, "--priority"));
  const tags = readRepeatedOption(optionArgs, "--tag").map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  const dueAt = readOptionalOption(optionArgs, "--due")?.trim();

  const knownOptions = new Set(["--title", "--description", "--priority", "--tag", "--due"]);

  for (const option of options.extraKnownOptions ?? []) {
    knownOptions.add(option);
  }

  if (options.allowClear === true) {
    knownOptions.add("--clear-description");
    knownOptions.add("--clear-priority");
    knownOptions.add("--clear-tags");
    knownOptions.add("--clear-due");
  }

  assertKnownOptions(optionArgs, knownOptions);

  if (options.requireTitle && title.length === 0) {
    throw usageError("Task title is required.");
  }

  if (description !== undefined && description.length > 0) {
    metadata.description = description;
  }

  if (priority !== undefined) {
    metadata.priority = priority;
  }

  if (tags.length > 0) {
    metadata.tags = tags;
  }

  if (dueAt !== undefined && dueAt.length > 0) {
    assertDueAt(dueAt);
    metadata.dueAt = dueAt;
  }

  if (options.allowClear === true) {
    if (hasFlag(optionArgs, "--clear-description")) {
      metadata.description = undefined;
    }

    if (hasFlag(optionArgs, "--clear-priority")) {
      metadata.priority = undefined;
    }

    if (hasFlag(optionArgs, "--clear-tags")) {
      metadata.tags = undefined;
    }

    if (hasFlag(optionArgs, "--clear-due")) {
      metadata.dueAt = undefined;
    }
  }

  return {
    title: title.length === 0 ? undefined : title,
    metadata
  };
}

function parseTaskTemplate(value: string | undefined): TaskTemplate | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "feature") {
    return {
      name: value,
      metadata: { priority: "medium", tags: ["feature"] },
      roles: ["rd", "reviewer"]
    };
  }

  if (value === "bug") {
    return {
      name: value,
      metadata: { priority: "high", tags: ["bug"] },
      roles: ["rd", "tester"]
    };
  }

  if (value === "review") {
    return {
      name: value,
      metadata: { priority: "medium", tags: ["review"] },
      roles: ["reviewer"]
    };
  }

  throw usageError("--template must be one of feature, bug, review.");
}

function mergeTemplateMetadata(input: TaskMetadata, template: TaskTemplate): TaskMetadata {
  return {
    ...template.metadata,
    ...input,
    tags: uniqueStrings([...(template.metadata.tags ?? []), ...(input.tags ?? [])])
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function parseTranscriptExportFormat(value: string | undefined): TranscriptExportFormat {
  if (value === undefined) {
    return "text";
  }

  if (value !== "text" && value !== "json" && value !== "markdown") {
    throw usageError("--format must be one of text, json, markdown.");
  }

  return value;
}

function renderTranscriptExport(
  taskId: string,
  roleName: string,
  transcript: string,
  format: TranscriptExportFormat
): string {
  if (format === "json") {
    return `${JSON.stringify({ taskId, role: roleName, transcript }, null, 2)}\n`;
  }

  if (format === "markdown") {
    return `# Transcript ${taskId} ${roleName}\n\n\`\`\`text\n${transcript.trimEnd()}\n\`\`\`\n`;
  }

  return transcript;
}

function countTranscriptLines(transcript: string | null): number {
  if (transcript === null || transcript.trimEnd().length === 0) {
    return 0;
  }

  return transcript.trimEnd().split("\n").length;
}

function parseTaskListFilters(args: string[]): TaskListFilters {
  assertKnownOptions(args, new Set(["--archived", "--tag", "--priority", "--search"]));

  return {
    archived: parseBooleanOption(readOptionalOption(args, "--archived"), "--archived"),
    tag: readOptionalOption(args, "--tag")?.trim(),
    priority: parseTaskPriority(readOptionalOption(args, "--priority")),
    search: readOptionalOption(args, "--search")?.trim().toLowerCase()
  };
}

function parseTaskBoardViewOptions(args: string[]): TaskBoardViewOptions {
  assertKnownOptions(args, new Set(["--archived", "--tag", "--priority", "--search", "--with-roles"]));

  return {
    filters: {
      archived: parseBooleanOption(readOptionalOption(args, "--archived"), "--archived"),
      tag: readOptionalOption(args, "--tag")?.trim(),
      priority: parseTaskPriority(readOptionalOption(args, "--priority")),
      search: readOptionalOption(args, "--search")?.trim().toLowerCase()
    },
    withRoles: hasFlag(args, "--with-roles")
  };
}

function taskMatchesFilters(task: Task, filters: TaskListFilters): boolean {
  if (filters.archived !== undefined && task.archived !== filters.archived) {
    return false;
  }

  if (filters.tag !== undefined && !(task.tags ?? []).includes(filters.tag)) {
    return false;
  }

  if (filters.priority !== undefined && task.priority !== filters.priority) {
    return false;
  }

  if (filters.search !== undefined && !taskSearchText(task).includes(filters.search)) {
    return false;
  }

  return true;
}

function renderTaskListTable(tasks: Task[]): string {
  return renderTable(
    "Tasks",
    [
      { header: "Task", minWidth: 6, maxWidth: 14 },
      { header: "State", minWidth: 7, maxWidth: 10 },
      { header: "Title", minWidth: 10, maxWidth: 48 },
      { header: "Metadata", minWidth: 8, maxWidth: 58 }
    ],
    tasks.map((task) => [task.id, task.archived ? "archived" : "ongoing", task.title, renderTaskMetadataSummary(task)]),
    defaultTableWidth()
  );
}

function renderTaskBoard(tasks: Task[], store: TaskStore, withRoles: boolean): string {
  const groups = [
    { archived: false, title: "Ongoing" },
    { archived: true, title: "Archived" }
  ];
  const rows = groups.flatMap((group) => {
    const groupTasks = tasks.filter((task) => task.archived === group.archived);

    if (groupTasks.length === 0) {
      return [[group.title, "", "(none)", "", "", ""]];
    }

    return groupTasks.map((task) => [
        group.title,
        task.id,
        task.title,
        renderTaskMetadataSummary(task),
        renderTaskProgressSummary(task.id, store),
        withRoles ? renderTaskRoleSummary(store.listRoles(task.id)) : ""
      ]);
  });

  return `${renderTable(
    "Task board",
    [
      { header: "Status", minWidth: 6, maxWidth: 10 },
      { header: "Task", minWidth: 6, maxWidth: 14 },
      { header: "Title", minWidth: 10, maxWidth: 44 },
      { header: "Metadata", minWidth: 8, maxWidth: 44 },
      { header: "Progress", minWidth: 8, maxWidth: 54 },
      { header: "Roles", minWidth: 6, maxWidth: 42 }
    ],
    rows,
    defaultTableWidth()
  )}\n`;
}

function renderTaskProgressSummary(taskId: string, store: TaskStore): string {
  const brief = store.readTaskBrief(taskId);
  const focus = brief?.match(/## Current focus\s+([^\n]+)/)?.[1]?.trim();
  const workCounts = store.listWorkItems(taskId).reduce<Record<string, number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
  const work = Object.entries(workCounts)
    .map(([status, count]) => `${status}=${count}`)
    .join(" ");

  return [
    focus === undefined ? null : `focus=${focus}`,
    work.length === 0 ? null : `work ${work}`,
    store.listMilestones(taskId).length === 0 ? null : `milestones=${store.listMilestones(taskId).length}`,
    store.getLeaderFailure(taskId) === null ? null : "leader-failed"
  ].filter((value): value is string => value !== null).join(" ");
}

function renderTaskRoleSummary(roles: Role[]): string {
  if (roles.length === 0) {
    return "roles none";
  }

  const counts = roles.reduce<Record<string, number>>((result, role) => {
    result[role.status] = (result[role.status] ?? 0) + 1;
    return result;
  }, {});

  return `roles ${["idle", "running", "detached", "exited", "failed"]
    .filter((status) => counts[status] !== undefined)
    .map((status) => `${status}=${counts[status]}`)
    .join(" ")}`;
}

function renderTaskMetadataLines(task: Task): string[] {
  const lines: string[] = [];

  if (task.description !== undefined) {
    lines.push(`Description: ${task.description}`);
  }

  if (task.priority !== undefined) {
    lines.push(`Priority: ${task.priority}`);
  }

  if (task.tags !== undefined && task.tags.length > 0) {
    lines.push(`Tags: ${task.tags.join(", ")}`);
  }

  if (task.dueAt !== undefined) {
    lines.push(`Due: ${task.dueAt}`);
  }

  return lines;
}

function renderTaskMetadataSummary(task: Task): string {
  return [
    task.priority === undefined ? null : `priority=${task.priority}`,
    task.tags === undefined || task.tags.length === 0 ? null : `tags=${task.tags.join(",")}`,
    task.dueAt === undefined ? null : `due=${task.dueAt}`
  ]
    .filter((item): item is string => item !== null)
    .join(" ");
}

function taskSearchText(task: Task): string {
  return [
    task.title,
    task.description,
    task.priority,
    task.dueAt,
    ...(task.tags ?? [])
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();
}

function readOptionalOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  if (args[index + 1] === undefined || args[index + 1].startsWith("--")) {
    throw usageError(`${name} is required.`);
  }

  return args[index + 1];
}

function readRepeatedOption(args: string[], name: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) {
      continue;
    }

    if (args[index + 1] === undefined || args[index + 1].startsWith("--")) {
      throw usageError(`${name} is required.`);
    }

    values.push(args[index + 1]);
    index += 1;
  }

  return values;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function assertKnownOptions(args: string[], knownOptions: Set<string>): void {
  for (const arg of args) {
    if (arg.startsWith("--") && !knownOptions.has(arg)) {
      throw usageError(`Unsupported option: ${arg}`);
    }
  }
}

function parseTaskPriority(value: string | undefined): TaskPriority | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!["low", "medium", "high", "urgent"].includes(value)) {
    throw usageError("--priority must be one of low, medium, high, urgent.");
  }

  return value as TaskPriority;
}

function parseBooleanOption(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value !== "true" && value !== "false") {
    throw usageError(`${name} must be true or false.`);
  }

  return value === "true";
}

function assertDueAt(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw usageError("--due must use YYYY-MM-DD.");
  }
}

export function taskUsage(): string {
  return `Task commands:
  taskmux task create <title> [--template feature|bug|review] [--agent <agent>] [--workspace <path>] [--description <body>] [--priority low|medium|high|urgent] [--tag <tag> ...] [--due YYYY-MM-DD]
  taskmux task update <task-id> [--title <title>] [--description <body>] [--priority low|medium|high|urgent] [--tag <tag> ...] [--due YYYY-MM-DD] [--clear-description] [--clear-priority] [--clear-tags] [--clear-due]
  taskmux task list [--archived true|false] [--tag <tag>] [--priority <priority>] [--search <text>]
  taskmux task board [--archived true|false] [--tag <tag>] [--priority <priority>] [--search <text>] [--with-roles]
  taskmux task show <task-id>
  taskmux task current [<task-id>]
  taskmux task last
  taskmux task clone <task-id> [--title <title>]
  taskmux task archive <task-id> [--reason <body>] [--summary <body>]
  taskmux task unarchive <task-id>
  taskmux task delete <task-id>
  taskmux task restore <task-id>
  taskmux task open <task-id>
  taskmux task context <task-id> [--format text|json] [--include-transcripts]
  taskmux task bind <task-id> <role> [--as <task-role>] [--workspace <path>]
  taskmux task assign <task-id> <role> [--agent <agent>] [--workspace <path>] [--as <task-role>]
  taskmux task assign-many <task-id> --role <role> ... [--agent <agent>] [--workspace <path>]
  taskmux task role update <task-id> <role> [--agent <agent>] [--workspace <path>]
  taskmux task role rename <task-id> <role> <new-role>
  taskmux task role child <task-id> <role> [--parent <role>] --description <body> [--responsibility <body> ...] [--constraint <body> ...] --expected-output <body>
  taskmux task role remove <task-id> <role>
  taskmux task roles <task-id>
  taskmux task enter <task-id> <role>
  taskmux task tail <task-id> <role>
  taskmux task detail <task-id> <role>
  taskmux task status <task-id> <role>
  taskmux task refresh <task-id>
  taskmux task transcript <task-id> <role>
  taskmux task transcript export <task-id> <role> [--format text|json|markdown] [--output <file>]
  taskmux task activity <task-id>
  taskmux task timeline <task-id>
  taskmux task detach <task-id> <role>
  taskmux task stop <task-id> <role>
  taskmux task kill <task-id> <role>
  taskmux task restart <task-id> <role>
  taskmux task cleanup <task-id>
  taskmux task comment <task-id> <body>
  taskmux task comments <task-id>
  taskmux task events <task-id>
  taskmux task topic create <task-id> --id <id> --name <name> --description <body>
  taskmux task topic list <task-id>
  taskmux task input draft <task-id> <body>
  taskmux task input submit <task-id>
  taskmux task cycle create <task-id> --cause <cause> --summary <summary>
  taskmux task cycle end <task-id> <cycle-id> --summary <summary>
  taskmux task work-item create <task-id> --title <title> [--cycle <cycle>] [--assignee <role>] [--topic <topic> ...]
  taskmux task work-item update <task-id> <work-item> --status <status> [--outcome <body>]
  taskmux task wake <task-id> --reason <reason>
  taskmux task session record <task-id> <role> --native-id <id>
  taskmux task session replace <task-id> <role> --native-id <id> --reason <reason>
  taskmux task dispatch <task-id> <role> --mode new|resume [--work-item <id>] [--topic <topic> ...] --input <input>
  taskmux task yield <task-id> <role> --summary <summary>
  taskmux task schedule set <task-id> --inactivity-minutes <minutes> --cooldown-minutes <minutes> [--review-at <iso>] [--every-minutes <minutes> --next-at <iso>]
  taskmux task brief update <task-id> --objective <body> [--boundary <body> ...] --focus <body> --leader-summary <body>
  taskmux task milestone add <task-id> --title <title> --summary <body> [--topic <topic> ...]
  taskmux task decision record <task-id> --title <title> --rationale <body> [--topic <topic> ...]
  taskmux task decision supersede <task-id> <decision-id> --reason <body>
  taskmux task worktree create <task-id> <role> --path <path> --branch <branch> [--base <ref>]
`;
}
