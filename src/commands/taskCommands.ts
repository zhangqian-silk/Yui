import type { ConfiguredAgent } from "../agent/agent.js";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import {
  compileDispatchInput,
  ensureWorkerRunCompletionRequirement
} from "../context/dispatchContext.js";
import {
  dataError,
  roleNotFound,
  runtimeError,
  taskNotFound,
  usageError
} from "../errors/cliError.js";
import { createTaskEvent, type TaskEventPayload } from "../event/taskEvent.js";
import { readCommandText } from "./textInput.js";
import {
  createRoleSessionSet,
  roleAgentSessionResumeMode,
  terminalizeTaskRoleRunSession,
  updateRoleAgentSessionStatus,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { formatTimestamp } from "../output/timePresentation.js";
import { renderRoleDetails } from "../output/rolePresentation.js";
import {
  createTaskMessage,
  taskMessageAuthorLabel,
  type TaskMessage,
  type TaskMessageAuthor,
  type TaskMessageContext,
  type TaskMessageKind
} from "../message/message.js";
import type { WorkItemIntegrationProof } from "../workspace/workItemChangeSetManager.js";
import {
  activeRoleAgentBinding,
  copyGlobalRoleToTaskRole,
  createRole,
  createRoleAgentBinding,
  switchActiveRoleAgent,
  unbindRoleAgent,
  updateRole,
  updateRoleStatus,
  type GlobalRole,
  type Role
} from "../role/role.js";
import {
  createAgentRun,
  failAgentRun,
  yieldAgentRun,
  type AgentRun
} from "../run/agentRun.js";
import {
  createReviewRound,
  finishReviewRound,
  startReviewRound,
  type ReviewRound
} from "../review/reviewRound.js";
import { markYuiRunInput, retagYuiRunInput } from "../run/runIdentity.js";
import { taskRoleSessionTitle } from "../runtime/sessionTitle.js";
import { createTaskBrief, updateTaskBrief } from "../brief/taskBrief.js";
import { createDecision, supersedeDecision } from "../decision/decision.js";
import { createMilestone } from "../milestone/milestone.js";
import {
  enqueueWork,
  requireCompleteWorkExecution
} from "../coordination/workMailboxQueue.js";
import type { MailboxEntityRef, MailboxTarget } from "../coordination/workMailbox.js";
import {
  activateTask,
  addTaskProjectBinding,
  archiveTask,
  completeTask,
  createTask,
  reopenTask,
  updateTaskMetadata,
  type Task,
  type TaskMetadata,
  type TaskProjectBinding,
  type TaskPriority
} from "../task/task.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { AgentProfile } from "../profile/agentProfile.js";
import { resolveProject, type Project } from "../repository/project.js";
import type { TmuxRolePaneState } from "../tmux/tmuxManager.js";
import {
  currentWorkItemCandidate,
  createWorkItem,
  retryFailedWorkItem,
  submitWorkItemCandidate,
  updateWorkItemWriteProjects,
  updateWorkItemStatus,
  type WorkItem,
  type WorkItemCandidate,
  type WorkItemStatus
} from "../workItem/workItem.js";
import type { ReviewConfig } from "../review/reviewConfig.js";
import {
  createManagedWorkspace,
  validateManagedWorkspace,
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
import {
  hasAgentConfigOptions,
  parseRoleOptions,
  patchRoleAgentBinding,
  roleOptionSpecs,
  roleProfilePatch
} from "./roleConfiguration.js";
import {
  hasRoleLaunchContextOptions,
  validateConfiguredRoleSkills
} from "./roleSkillValidation.js";
import { assertRoleRuntimeMutationAllowed } from "./roleRuntimeGuard.js";
import { runTaskContextCommand } from "./taskContextCommand.js";
import {
  inspectTaskRoleRuntimeStatuses,
  renderTaskRoleRuntimeStatus,
  taskRoleActiveWorkLabel,
  taskRoleNativeSessionLabel,
  taskRoleOpenInputLabel,
  taskRoleTmuxLabel
} from "./taskRoleRuntimeStatus.js";
import {
  assertNoOpenInputRequests,
  openInputRequestCount,
  runTaskInputCommand
} from "./taskInputCommands.js";
import { taskActor as resolveTaskActor } from "./taskActor.js";

const LEADER_ROLE = "leader";

export type TaskCommandExecution =
  | Readonly<{ kind: "output"; output: string; data?: unknown }>
  | Readonly<{
      kind: "enter";
      taskId: string;
      roleName: string;
      output?: string;
    }>;

/**
 * The command layer only persists intent. It never launches an Agent, writes
 * terminal bytes, or attaches a tmux client.
 */
export type TaskWorkflowRuntimePort = Readonly<{
  notifyStateChanged(taskId: string): void;
  notifyMailboxChanged?(target: MailboxTarget): void;
  reconcileTask(taskId: string): void;
  inspectTaskRolePanes?(taskId: string): readonly TmuxRolePaneState[];
}>;

export type TaskWorkflowStore = TaskStore;

export type TaskCommandOptions = Readonly<{
  runtime?: TaskWorkflowRuntimePort;
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
  yuiHome?: string;
  workItemIntegrationProof?: WorkItemIntegrationProof;
}>;

export function runTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {}
): TaskCommandExecution {
  const [command, ...rest] = args;
  switch (command) {
    case "create": return createTaskCommand(rest, store, options);
    case "update": return output(updateTaskCommand(rest, store, options));
    case "list": return listTaskCommand(rest, store);
    case "show": return showTaskCommand(rest, store);
    case "context": return runTaskContextCommand(rest, store);
    case "activate": return output(activateTaskCommand(rest, store, options));
    case "complete": return output(completeTaskCommand(rest, store, options));
    case "reopen": return output(reopenTaskCommand(rest, store, options));
    case "archive": return output(archiveTaskCommand(rest, store, options));
    case "reconcile": return output(reconcileTaskCommand(rest, store, options));
    case "message": return output(taskMessageCommand(rest, store, options));
    case "project": return taskProjectCommand(rest, store, options);
    case "input": return runTaskInputCommand(rest, store, options);
    case "role": return taskRoleCommand(rest, store, options);
    case "work": return taskWorkCommand(rest, store, options);
    case "run": return output(taskRunCommand(rest, store, options));
    case "brief": return taskBriefCommand(rest, store, options);
    case "decision": return taskDecisionCommand(rest, store, options);
    case "milestone": return taskMilestoneCommand(rest, store, options);
    case "event": return taskEventCommand(rest, store);
    case "enter": return enterTaskRoleAlias(rest, store, options);
    default:
      throw usageError(command === undefined
        ? "Task command is required."
        : `Unknown command: task ${command}`);
  }
}

function taskProjectCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "list") {
    exactPositionals(rest, 1, "Task project list usage: yui task project list <task>.");
    const task = requireTask(store, rest[0]);
    const rendered = task.projectBindings.length === 0
      ? `Task ${task.id} has no Projects.\n`
      : `${renderTable(
          `Task Projects: ${task.id}`,
          [
            { header: "Directory", minWidth: 8, maxWidth: 24 },
            { header: "Project", minWidth: 8, maxWidth: 24 },
            { header: "Base", minWidth: 6, maxWidth: 36 }
          ],
          task.projectBindings.map(({ directory, projectId, baseRef }) => [
            directory, projectId, baseRef
          ]),
          defaultTableWidth()
        )}\n`;
    return output(rendered, { projectBindings: task.projectBindings });
  }
  if (command !== "add") {
    throw usageError(command === undefined
      ? "Task project command is required."
      : `Unknown command: task project ${command}`);
  }
  const usage = "Task project add usage: yui task project add <task> <project> [--base <ref>] [--directory <name>].";
  const parsed = parseTail(rest, new Set(["--base", "--directory"]), usage);
  exactPositionals(parsed.positionals, 2, usage);
  const now = clock(options);
  const updated = store.transaction((tx) => {
    const task = requireTask(tx, parsed.positionals[0]);
    assertTaskOpen(task);
    if (task.status === "active" && taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may add a Project to an active Task.");
    }
    const project = resolveProject(tx.listProjects(), parsed.positionals[1]);
    if (project === null) throw usageError(`Project not found: ${parsed.positionals[1]}.`);
    const next = addTaskProjectBinding(task, {
      projectId: project.id,
      directory: parsed.options.get("--directory") ?? project.name,
      baseRef: parsed.options.get("--base") ?? project.developmentBranch
    }, now);
    tx.saveTask(next);
    recordTaskEvent(tx, task.id, "task.project-added", {
      projectId: project.id,
      directory: next.projectBindings.at(-1)!.directory
    }, now);
    enqueueWork(tx, taskMailbox(task.id), "task-project-added", now, [taskRef(task.id)]);
    if (task.status === "active") {
      enqueueWork(tx, leaderMailbox(task.id), "task-project-added", now, [taskRef(task.id)]);
    }
    return next;
  });
  notifyMailbox(options.runtime, taskMailbox(updated.id), updated.id);
  if (updated.status === "active") {
    notifyMailbox(options.runtime, leaderMailbox(updated.id), updated.id);
  }
  return output(`Added Project to ${updated.id}\n`, { task: updated });
}

function updateTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const optionNames = new Set(["--title", "--description", "--priority", "--tags", "--due-at"]);
  const flagOptions = new Set([
    "--clear-description", "--clear-priority", "--clear-tags", "--clear-due-at",
    "--require-integration"
  ]);
  const usage = "Task update usage: yui task update <id> [--title <text>] [--description <text>|--clear-description] [--priority <low|medium|high|urgent>|--clear-priority] [--tags <comma-separated>|--clear-tags] [--due-at <RFC3339>|--clear-due-at] [--require-integration].";
  const parsed = parseTail(args, optionNames, usage, flagOptions);
  exactPositionals(parsed.positionals, 1, usage);
  if (parsed.options.size === 0) throw usageError("At least one Task metadata option is required.", usage);
  for (const [setOption, clearOption] of [
    ["--description", "--clear-description"],
    ["--priority", "--clear-priority"],
    ["--tags", "--clear-tags"],
    ["--due-at", "--clear-due-at"]
  ] as const) {
    if (parsed.options.has(setOption) && parsed.options.has(clearOption)) {
      throw usageError(`${setOption} and ${clearOption} cannot be used together.`, usage);
    }
  }
  const priority = parsed.options.has("--priority")
    ? parseTaskPriority(requiredOption(parsed.options, "--priority"))
    : undefined;
  const dueAt = parsed.options.has("--due-at")
    ? parseIsoTimestamp(requiredOption(parsed.options, "--due-at"), "--due-at")
    : undefined;
  const tags = parsed.options.has("--tags")
    ? parseTaskTags(requiredOption(parsed.options, "--tags"))
    : undefined;
  const now = clock(options);
  const result = store.transaction((tx) => {
    const current = requireTask(tx, parsed.positionals[0]);
    if (current.status === "archived") throw usageError(`Task is archived: ${current.id}.`);
    if (parsed.options.has("--require-integration") && current.status === "completed") {
      throw usageError(
        `Task ${current.id} is completed; use task reopen before enabling integration evidence.`
      );
    }
    if (
      parsed.options.size === 1
      && parsed.options.has("--require-integration")
      && current.requireIntegration === true
    ) {
      return { task: current, integrationState: "already-enabled" as const };
    }
    const updated = updateTaskMetadata(current, {
      ...(parsed.options.has("--title") ? { title: requiredOption(parsed.options, "--title") } : {}),
      ...(parsed.options.has("--description")
        ? { description: requiredOption(parsed.options, "--description") }
        : parsed.options.has("--clear-description") ? { description: null } : {}),
      ...(priority === undefined
        ? parsed.options.has("--clear-priority") ? { priority: null } : {}
        : { priority }),
      ...(tags === undefined
        ? parsed.options.has("--clear-tags") ? { tags: null } : {}
        : { tags }),
      ...(dueAt === undefined
        ? parsed.options.has("--clear-due-at") ? { dueAt: null } : {}
        : { dueAt }),
      ...(parsed.options.has("--require-integration") ? { requireIntegration: true } : {})
    }, now);
    tx.saveTask(updated);
    recordTaskEvent(tx, updated.id, "task.updated", {
      status: updated.status,
      ...(parsed.options.has("--require-integration")
        ? { completionEvidence: "integration-required" }
        : {})
    }, now);
    enqueueWork(tx, taskMailbox(updated.id), "task-updated", now, [taskRef(updated.id)]);
    return {
      task: updated,
      integrationState: parsed.options.has("--require-integration")
        ? "enabled" as const
        : "unchanged" as const
    };
  });
  if (result.integrationState !== "already-enabled") {
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
  }
  return result.integrationState === "enabled"
    ? `Updated task ${result.task.id}\nCompletion evidence enabled: WorkItem, ChangeSet, and committed Integration required\n`
    : result.integrationState === "already-enabled"
      ? `Task ${result.task.id} completion evidence is already enabled\n`
      : `Updated task ${result.task.id}\n`;
}

/** Compatibility helper for call sites that cannot yet handle foreground enter. */
export function runTaskOutputCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {}
): string {
  const execution = runTaskCommand(args, store, options);
  if (execution.kind === "enter") {
    throw runtimeError("Task role enter requires foreground tmux handoff by the CLI.");
  }
  return execution.output;
}

export function submitOperatorMessage(
  body: string,
  taskId: string | undefined,
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {}
): string {
  const now = clock(options);
  const result = store.transaction((tx) => {
    if (taskId !== undefined) {
      const task = requireTask(tx, taskId);
      assertTaskOpen(task);
      const message = appendMessage(tx, task.id, body, "operator", { type: "operator" }, now);
      if (task.status === "active") {
        enqueueWork(tx, leaderMailbox(task.id), "operator-input", now, [messageRef(message.id)]);
      }
      return { task, message, created: false } as const;
    }

    const created = createTaskAggregate(tx, titleFrom(body), {}, now);
    const message = appendMessage(tx, created.task.id, body, "operator", { type: "operator" }, now);
    return { ...created, message, created: true } as const;
  });
  notifyMailbox(
    options.runtime,
    result.task.status === "active" ? leaderMailbox(result.task.id) : taskMailbox(result.task.id),
    result.task.id
  );
  return result.created
    ? `Created Draft task ${result.task.id}: ${result.task.title}\nSubmitted message ${result.message.id}\n`
    : `Submitted message ${result.message.id} to ${result.task.id}\n`;
}

function createTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const parsed = parseTaskCreation(args, store);
  const now = clock(options);
  const created = store.transaction((tx) => createTaskAggregate(tx, parsed.title, {
    projectBindings: parsed.projectBindings,
    ...(parsed.requireIntegration ? { requireIntegration: true } : {})
  }, now));
  notifyMailbox(options.runtime, taskMailbox(created.task.id), created.task.id);
  return output(
    `Created Draft task ${created.task.id}: ${created.task.title}\n`
      + `Assigned role: ${created.leader.name}\n`
      + (created.task.requireIntegration
        ? "Completion: WorkItem, ChangeSet, and committed Integration required\n"
        : "Completion: delivery integration not required\n"),
    { task: created.task, leader: created.leader }
  );
}

function parseTaskCreation(
  args: string[],
  store: TaskWorkflowStore
): Readonly<{
  title: string;
  projectBindings: readonly TaskProjectBinding[];
  requireIntegration: boolean;
}> {
  const usage = "Task create usage: yui task create <title> [--project <project> ...] [--base <project>=<ref> ...] [--require-integration].";
  const parsed = parseMultiValueTail(
    args,
    new Set(),
    new Set(["--project", "--base"]),
    usage,
    new Set(["--require-integration"])
  );
  exactPositionals(parsed.positionals, 1, usage);
  const projectReferences = parsed.multiOptions.get("--project") ?? [];
  const baseOptions = parsed.multiOptions.get("--base") ?? [];
  if (baseOptions.length > 0 && projectReferences.length === 0) {
    throw usageError("--base requires --project.");
  }
  const projects = projectReferences.map((reference) => {
    const project = resolveProject(store.listProjects(), reference);
    if (project === null) throw usageError(`Project not found: ${reference}.`);
    return project;
  });
  if (new Set(projects.map(({ id }) => id)).size !== projects.length) {
    throw usageError("A Task cannot bind the same Project more than once.");
  }
  const bases = new Map<string, string>();
  for (const option of baseOptions) {
    const separator = option.indexOf("=");
    if (separator < 0) {
      if (projects.length !== 1) {
        throw usageError("--base must use <project>=<ref> when a Task has multiple Projects.");
      }
      bases.set(projects[0].id, requiredText(option, "--base"));
      continue;
    }
    const reference = requiredText(option.slice(0, separator), "--base Project");
    const baseRef = requiredText(option.slice(separator + 1), "--base ref");
    const project = resolveProject(projects, reference);
    if (project === null) throw usageError(`Task Project not found for --base: ${reference}.`);
    if (bases.has(project.id)) throw usageError(`Project base may only be specified once: ${reference}.`);
    bases.set(project.id, baseRef);
  }
  return {
    title: parsed.positionals[0],
    projectBindings: projects.map((project) => ({
      projectId: project.id,
      directory: project.name,
      baseRef: bases.get(project.id) ?? project.developmentBranch
    })),
    requireIntegration: parsed.options.has("--require-integration")
  };
}

function createTaskAggregate(
  store: TaskWorkflowStore,
  title: string,
  metadata: TaskMetadata,
  now: Date
): Readonly<{ task: Task; leader: Role }> {
  const task = createTask(store.nextTaskId(), title, now, metadata);
  const leader = createTaskRole(store, task, LEADER_ROLE, undefined, now);
  store.saveTask(task);
  store.saveRole(task.id, leader);
  recordTaskEvent(store, task.id, "task.created", { status: task.status }, now);
  enqueueWork(store, taskMailbox(task.id), "task-created", now, [taskRef(task.id)]);
  return { task, leader };
}

function listTaskCommand(args: string[], store: TaskWorkflowStore): TaskCommandExecution {
  assertNoArguments(args, "Task list usage: yui task list.");
  const tasks = store.listTasks();
  const rendered = tasks.length === 0
    ? "No tasks found.\n"
    : `${renderTable(
        "Tasks",
        [
          { header: "Task", minWidth: 6, maxWidth: 20 },
          { header: "Status", minWidth: 6, maxWidth: 10 },
          { header: "Title", minWidth: 8, maxWidth: 64 },
          { header: "Projects", minWidth: 8, maxWidth: 24 }
        ],
        tasks.map((task) => [
          task.id,
          task.status,
          task.title,
          task.projectBindings.map(({ directory }) => directory).join(", ") || "-"
        ]),
        defaultTableWidth()
      )}\n`;
  return output(rendered, { tasks });
}

function showTaskCommand(args: string[], store: TaskWorkflowStore): TaskCommandExecution {
  const [taskId] = args;
  exactPositionals(args, 1, "Task show usage: yui task show <id>.");
  const task = requireTask(store, taskId);
  const messages = store.listMessages(task.id);
  const brief = store.getTaskBrief(task.id);
  const decisions = store.listDecisions(task.id);
  const milestones = store.listMilestones(task.id);
  const events = store.listEvents(task.id);
  const openInputs = openInputRequestCount(store, task.id);
  const work = store.listWorkItems(task.id);
  const changeSets = store.listChangeSets(task.id);
  const integrations = store.listIntegrationAttempts(task.id);
  const counts = {
    messages: messages.length,
    decisions: decisions.length,
    milestones: milestones.length,
    events: events.length,
    workItems: work.length,
    agentRuns: store.listAgentRuns(task.id).length,
    changeSets: changeSets.length,
    integrations: integrations.length,
    openInputs
  };
  const timeZone = store.getConfig().timeZone;
  const rendered = [
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Status: ${task.status}`,
    ...(task.description === undefined ? [] : [`Description: ${task.description}`]),
    ...(task.priority === undefined ? [] : [`Priority: ${task.priority}`]),
    ...(task.tags === undefined ? [] : [`Tags: ${task.tags.join(", ")}`]),
    ...(task.dueAt === undefined ? [] : [`Due: ${presentTime(task.dueAt, timeZone)}`]),
    `Completion evidence: ${task.requireIntegration === true ? "required" : "not required"}`,
    ...(task.completedAt === undefined ? [] : [`Completed: ${presentTime(task.completedAt, timeZone)}`]),
    ...(task.completedBy === undefined ? [] : [`Completed by: ${task.completedBy}`]),
    ...(task.completionSummary === undefined ? [] : [`Completion summary: ${task.completionSummary}`]),
    ...(task.projectBindings.length === 0
      ? []
      : [
          "Projects:",
          ...task.projectBindings.map((binding) => (
            `- ${binding.directory}: ${binding.projectId} @ ${binding.baseRef}`
          ))
        ]),
    ...(task.cwd === undefined ? [] : [`Workspace: ${task.cwd}`]),
    `Messages: ${counts.messages}`,
    `Brief: ${brief === null ? "no" : "yes"}`,
    `Decisions: ${counts.decisions}`,
    `Milestones: ${counts.milestones}`,
    `Events: ${counts.events}`,
    `Work items: ${counts.workItems}`,
    `Agent Runs: ${counts.agentRuns}`,
    `ChangeSets: ${counts.changeSets}`,
    `Integration Attempts: ${counts.integrations}`,
    `Open inputs: ${counts.openInputs}`,
    `Created: ${presentTime(task.createdAt, timeZone)}`,
    `Updated: ${presentTime(task.updatedAt, timeZone)}`
  ].join("\n").concat("\n");
  return output(rendered, { task, counts, hasBrief: brief !== null });
}

function activateTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 1, "Task activate usage: yui task activate <task>.");
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, args[0]);
    if (task.status === "archived") throw usageError(`Task is archived: ${task.id}.`);
    if (task.status === "completed") {
      throw usageError(`Task ${task.id} is completed; use task reopen before activating it.`);
    }
    if (task.status === "active") return { task, changed: false } as const;
    const active = activateTask(task, now);
    tx.saveTask(active);
    // Project-backed Tasks keep this durable wake pending until the
    // Controller has prepared and recorded the Task workspace.
    enqueueWork(tx, leaderMailbox(task.id), "task-created", now, [taskRef(task.id)]);
    enqueueWork(tx, taskMailbox(task.id), "task-activated", now, [taskRef(task.id)]);
    recordTaskEvent(tx, task.id, "task.activated", {
      fromStatus: task.status,
      status: active.status
    }, now);
    return { task: active, changed: true } as const;
  });
  if (result.changed) {
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
    notifyMailbox(options.runtime, leaderMailbox(result.task.id), result.task.id);
  }
  return result.changed
    ? `Activated task ${result.task.id}\n`
    : `Task ${result.task.id} is already active\n`;
}

function completeTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task complete usage: yui task complete <id> (--summary <text>|--summary-file <path|->).";
  const parsed = parseTail(args, new Set(["--summary", "--summary-file"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const summary = readCommandText(
    parsed.options.get("--summary"),
    parsed.options.get("--summary-file"),
    "--summary",
    usage
  );
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, parsed.positionals[0]);
    const actor = taskActor(options, task.id);
    if (task.status === "completed") return { task, changed: false } as const;
    if (task.status === "archived") throw usageError(`Task is archived: ${task.id}.`);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    assertNoOpenInputRequests(tx, task.id, "completing the Task");
    const incompleteWork = tx.listWorkItems(task.id).find((item) => (
      item.status !== "completed"
      && item.status !== "cancelled"
      && item.status !== "superseded"
    ));
    if (incompleteWork !== undefined) {
      throw usageError(`Task ${task.id} has unaccepted work: ${incompleteWork.id}/${incompleteWork.status}.`);
    }
    if (task.requireIntegration) {
      if (tx.listWorkItems(task.id).length === 0) {
        throw usageError(`Task ${task.id} requires at least one WorkItem before completion.`);
      }
      if (tx.listChangeSets(task.id).length === 0) {
        throw usageError(`Task ${task.id} requires at least one ChangeSet before completion.`);
      }
      if (!tx.listIntegrationAttempts(task.id).some(({ status }) => status === "committed")) {
        throw usageError(`Task ${task.id} requires a committed Integration Attempt before completion.`);
      }
    }
    const unresolvedIntegration = tx.listIntegrationAttempts(task.id).find((integration) => (
      integration.status === "running"
      || integration.status === "blocked"
      || integration.status === "validating"
    ));
    if (unresolvedIntegration !== undefined) {
      throw usageError(
        `Task ${task.id} has an unresolved Integration Attempt: ${unresolvedIntegration.id}.`
      );
    }
    const isolatedWorkspace = tx.listManagedWorkspaces(task.id)
      .find(({ owner }) => owner.type === "work-item");
    if (isolatedWorkspace?.owner.type === "work-item") {
      throw usageError(
        `Task ${task.id} has an isolated WorkItem workspace: `
        + `${isolatedWorkspace.owner.workItemId}. Capture, integrate or abandon it, then clean it up.`
      );
    }

    const roles = tx.listRoles(task.id);
    const activeRuns = roles
      .map((role) => ({ role, run: tx.getActiveAgentRun(task.id, role.name) }))
      .filter((entry): entry is { role: Role; run: AgentRun } => entry.run !== null);
    const workerRun = activeRuns.find(({ role }) => role.name !== LEADER_ROLE);
    if (workerRun !== undefined) {
      throw usageError(`Task ${task.id} has an active run for Role ${workerRun.role.name}.`);
    }
    const unsettledWork = tx.listWorkItems(task.id)
      .find((item) => item.status === "pending" || item.status === "running");
    if (unsettledWork !== undefined) {
      throw usageError(`Task ${task.id} has unsettled work: ${unsettledWork.id}.`);
    }

    const leaderEntry = activeRuns.find(({ role }) => role.name === LEADER_ROLE);
    if (leaderEntry !== undefined) {
      if (actor !== "leader") {
        throw usageError(`Task ${task.id} has an active Leader run.`);
      }
      if (leaderEntry.run.workItemId !== undefined) {
        throw usageError(`Task ${task.id} has running work: ${leaderEntry.run.workItemId}.`);
      }
      if (leaderEntry.run.deliveredAt === undefined) {
        throw usageError(`Task ${task.id} Leader delivery is still pending.`);
      }
      tx.saveAgentRun(yieldAgentRun(leaderEntry.run, summary, now));
      requireCompleteWorkExecution(
        tx,
        roleMailbox(task.id, LEADER_ROLE),
        runRef(leaderEntry.run.id)
      );
      tx.clearActiveAgentRun(task.id, LEADER_ROLE);
      tx.saveRole(task.id, updateRoleStatus(leaderEntry.role, "idle", now));
      const sessions = tx.getTaskRoleSessionSet(task.id, LEADER_ROLE);
      if (sessions !== null) {
        tx.saveTaskRoleSessionSet(
          terminalizeTaskRoleRunSession(sessions, {
            agentId: leaderEntry.role.activeAgentId,
            runId: leaderEntry.run.id,
            receiptId: `agent-run:${leaderEntry.run.id}`
          }, now)
        );
      }
    }

    const completed = completeTask(task, now, { by: actor, summary });
    tx.saveTask(completed);
    tx.clearPendingWakeup(task.id);
    tx.clearLeaderFailure(task.id);
    tx.clearOperatorNotification(task.id);
    recordTaskEvent(tx, task.id, "task.completed", { by: actor, summary }, now);
    enqueueWork(tx, taskMailbox(task.id), "task-completed", now, [taskRef(task.id)]);
    return { task: completed, changed: true } as const;
  });
  if (result.changed) notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
  return result.changed
    ? `Completed task ${result.task.id}\n`
    : `Task ${result.task.id} is already completed\n`;
}

function reopenTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 1, "Task reopen usage: yui task reopen <id>.");
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, args[0]);
    if (task.status === "active") return { task, changed: false } as const;
    if (task.status === "archived") throw usageError(`Task is archived: ${task.id}.`);
    if (task.status !== "completed") throw usageError(`Task is not completed: ${task.id}.`);
    const active = reopenTask(task, now);
    tx.saveTask(active);
    enqueueWork(tx, leaderMailbox(task.id), "task-reopened", now, [taskRef(task.id)]);
    enqueueWork(tx, taskMailbox(task.id), "task-reopened", now, [taskRef(task.id)]);
    recordTaskEvent(tx, task.id, "task.reopened", { status: active.status }, now);
    return { task: active, changed: true } as const;
  });
  if (result.changed) {
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
    notifyMailbox(options.runtime, leaderMailbox(result.task.id), result.task.id);
  }
  return result.changed
    ? `Reopened task ${result.task.id}\n`
    : `Task ${result.task.id} is already active\n`;
}

function archiveTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const request = validateTaskArchiveRequest(args, store, options);
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, request.taskId);
    const actor = taskActor(options, task.id);
    if (task.status === "archived") return { task, changed: false } as const;
    if (task.status !== "completed") {
      throw usageError(`Task ${task.id} must be completed before it can be archived.`);
    }
    if (task.cwd !== undefined || tx.listManagedWorkspaces(task.id).length > 0) {
      throw usageError(`Task ${task.id} still has managed worktrees; clean them before archiving.`);
    }
    assertNoOpenInputRequests(tx, task.id, "archiving the Task");
    const unresolvedIntegration = tx.listIntegrationAttempts(task.id).find((integration) => (
      integration.status === "running"
      || integration.status === "blocked"
      || integration.status === "validating"
    ));
    if (unresolvedIntegration !== undefined) {
      throw usageError(
        `Task ${task.id} has an unresolved Integration Attempt: ${unresolvedIntegration.id}.`
      );
    }
    const archived = archiveTask(task, now, { by: actor });
    tx.saveTask(archived);
    tx.clearPendingWakeup(task.id);
    tx.clearLeaderFailure(task.id);
    tx.clearOperatorNotification(task.id);
    for (const role of tx.listRoles(task.id)) {
      const activeRun = tx.getActiveAgentRun(task.id, role.name);
      // Archival is the explicit aggregate teardown boundary. Unlike a normal
      // Run terminal transition, it may cancel work before Controller claimed
      // the pending delivery, so the Role mailbox is discarded as a whole.
      tx.removeWorkMailbox(roleMailbox(task.id, role.name));
      if (activeRun === null) continue;
      const failed = failAgentRun(activeRun, "Task archived.", now);
      tx.saveAgentRun(failed);
      tx.clearActiveAgentRun(task.id, role.name);
      tx.saveRole(task.id, updateRoleStatus(role, "idle", now));
      const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
      if (sessions !== null) {
        tx.saveTaskRoleSessionSet(terminalizeTaskRoleRunSession(sessions, {
          agentId: role.activeAgentId,
          runId: activeRun.id,
          receiptId: `agent-run:${activeRun.id}`
        }, now));
      }
      if (failed.workItemId !== undefined) {
        const item = tx.getWorkItem(task.id, failed.workItemId);
        if (item !== null && item.status === "running") {
          tx.saveWorkItem(task.id, updateWorkItemStatus(item, "failed", now, "Task archived."));
        }
      }
    }
    recordTaskEvent(tx, task.id, "task.archived", {
      by: actor,
      workspaceDisposition: request.disposition
    }, now);
    enqueueWork(tx, taskMailbox(task.id), "task-archived", now, [taskRef(task.id)]);
    return { task: archived, changed: true } as const;
  });
  if (result.changed) notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
  return result.changed
    ? `Archived task ${result.task.id}\n`
    : `Task ${result.task.id} is already archived\n`;
}

export function parseTaskArchiveArguments(
  args: readonly string[]
): Readonly<{ taskId: string; disposition: "integrated" | "abandoned" }> {
  const usage = "Task archive usage: yui task archive <id> (--integrated|--abandon).";
  if (args.length !== 2 || !["--integrated", "--abandon"].includes(args[1] ?? "")) {
    throw usageError(usage);
  }
  return {
    taskId: args[0]!,
    disposition: args[1] === "--integrated" ? "integrated" : "abandoned"
  };
}

export function validateTaskArchiveRequest(
  args: readonly string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {}
): Readonly<{ taskId: string; disposition: "integrated" | "abandoned" }> {
  const request = parseTaskArchiveArguments(args);
  const task = requireTask(store, request.taskId);
  taskActor(options, task.id);
  if (task.status !== "archived" && task.status !== "completed") {
    throw usageError(`Task ${task.id} must be completed before it can be archived.`);
  }
  if (task.status === "completed") {
    assertNoOpenInputRequests(store, task.id, "archiving the Task");
  }
  return request;
}

function reconcileTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 1, "Task reconcile usage: yui task reconcile <task>.");
  const task = requireTask(store, args[0]);
  const runtime = requireRuntime(options);
  runtime.reconcileTask(task.id);
  return `Reconcile requested for task ${task.id}\n`;
}

function taskMessageCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const [command, ...rest] = args;
  if (command === "send") {
    const usage = "Task message send usage: yui task message send <id> (<body>|--body-file <path|->).";
    const parsed = parseTail(rest, new Set(["--body-file"]), usage);
    if (parsed.positionals.length < 1 || parsed.positionals.length > 2) throw usageError(usage);
    const body = readCommandText(
      parsed.positionals[1],
      parsed.options.get("--body-file"),
      "--body",
      usage
    );
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      assertTaskOpen(task);
      const message = appendMessage(tx, task.id, body, "user", { type: "user" }, now);
      if (task.status === "active") {
        enqueueWork(tx, leaderMailbox(task.id), "user-message", now, [messageRef(message.id)]);
      }
      return { task, message };
    });
    notifyMailbox(
      options.runtime,
      result.task.status === "active" ? leaderMailbox(result.task.id) : taskMailbox(result.task.id),
      result.task.id
    );
    return `Sent message ${result.message.id} to ${result.task.id}\n`;
  }
  if (command === "list") {
    exactPositionals(rest, 1, "Task message list usage: yui task message list <id>.");
    const task = requireTask(store, rest[0]);
    const messages = store.listMessages(task.id);
    if (messages.length === 0) return "No messages found.\n";
    const timeZone = store.getConfig().timeZone;
    return `${renderTable(
      `Task messages: ${task.id}`,
      [
        { header: "Message", minWidth: 7, maxWidth: 18 },
        { header: "Author", minWidth: 6, maxWidth: 18 },
        { header: "Created", minWidth: 10, maxWidth: 28 },
        { header: "Body", minWidth: 8, maxWidth: 72 }
      ],
      messages.map((message) => [
        message.id,
        taskMessageAuthorLabel(message.author),
        presentTime(message.createdAt, timeZone),
        message.body
      ]),
      defaultTableWidth()
    )}\n`;
  }
  throw usageError(command === undefined
    ? "Task message command is required."
    : `Unknown command: task message ${command}`);
}

function taskRoleCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "add") return output(addTaskRole(rest, store, options));
  if (command === "list") return listTaskRoles(rest, store, options);
  if (command === "status") return taskRoleStatus(rest, store, options);
  if (command === "show") return output(showTaskRole(rest, store));
  if (command === "update") return output(updateTaskRole(rest, store, options));
  if (command === "remove") return output(removeTaskRole(rest, store, options));
  if (command === "bind") return output(bindTaskRole(rest, store, options));
  if (command === "unbind") return output(unbindTaskRole(rest, store, options));
  if (command === "enter") return enterTaskRole(rest, store, options);
  throw usageError(command === undefined
    ? "Task role command is required."
    : `Unknown command: task role ${command}`);
}

function addTaskRole(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task role add usage: yui task role add <task> <name> [Role and Agent settings].";
  const [taskId, roleName, ...tail] = args;
  if (taskId === undefined || roleName === undefined || taskId.startsWith("--") || roleName.startsWith("--")) {
    throw usageError("Task id and Role name are required.", usage);
  }
  const parsed = parseRoleOptions(tail, new Map([
    ...roleOptionSpecs({ update: false, includeAgent: true }),
    ["--profile", "value" as const]
  ]), usage);
  const agentId = parsed.one("--agent")?.trim();
  if (parsed.has("--agent") && (agentId === undefined || agentId.length === 0)) {
    throw usageError("--agent is required.", usage);
  }
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, taskId);
    assertTaskOpen(task);
    assertRoleRuntimeMutationAllowed(tx, {
      scope: "task",
      taskId: task.id,
      roleName
    }, "creation");
    if (roleName === LEADER_ROLE) throw usageError("The Task leader role already exists.");
    if (tx.getRole(task.id, roleName) !== null) throw usageError(`Role already exists: ${roleName}.`);
    let created = createTaskRole(tx, task, roleName, agentId, now);
    const profileId = parsed.one("--profile");
    if (profileId !== undefined) {
      created = updateRole(created, workerProfileRolePatch(
        requireAgentProfile(tx, profileId)
      ), now);
    }
    const profile = roleProfilePatch(parsed);
    if (Object.keys(profile).length > 0) created = updateRole(created, profile, now);
    if (hasAgentConfigOptions(parsed)) {
      const targetAgentId = agentId || created.activeAgentId;
      const binding = created.agentBindings[targetAgentId];
      if (binding === undefined) throw usageError(`Role Agent is not bound: ${targetAgentId}.`);
      created = updateRole(created, {
        agentBindings: {
          ...created.agentBindings,
          [targetAgentId]: patchRoleAgentBinding(binding, parsed)
        }
      }, now);
    }
    validateConfiguredRoleSkills(options.yuiHome, created.skills ?? []);
    tx.saveRole(task.id, created);
    enqueueWork(tx, taskMailbox(task.id), "role-added", now, [taskRef(task.id)]);
    const binding = created.agentBindings[created.activeAgentId];
    recordTaskEvent(tx, task.id, "role.added", {
      role: created.name,
      runtimeSource: agentId === undefined ? "Global Role worker" : `Explicit Agent ${agentId}`,
      agent: `${created.activeAgentId}/${binding.adapterId}`,
      model: binding.config.model ?? "CLI default",
      effort: binding.config.effort ?? "CLI default",
      yolo: binding.config.yolo === true ? "enabled" : "disabled"
    }, now);
    return { role: created, binding };
  });
  notifyMailbox(options.runtime, taskMailbox(result.role.taskId), result.role.taskId);
  return [
    `Added role ${result.role.name} to ${result.role.taskId}`,
    `Runtime source: ${agentId === undefined ? "Global Role worker" : `Explicit Agent ${agentId}`}`,
    `Agent: ${result.role.activeAgentId}/${result.binding.adapterId}`,
    `Model: ${result.binding.config.model ?? "CLI default"}; effort: ${result.binding.config.effort ?? "CLI default"}; YOLO: ${result.binding.config.yolo === true ? "enabled" : "disabled"}`,
    "Next: create a WorkItem and start this Role when it has assigned work."
  ].join("\n").concat("\n");
}

function listTaskRoles(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 1, "Task role list usage: yui task role list <task>.");
  const task = requireTask(store, args[0]);
  const roles = store.listRoles(task.id);
  const statuses = inspectTaskRoleRuntimeStatuses(
    task.id,
    roles,
    store,
    options.runtime?.inspectTaskRolePanes?.(task.id) ?? []
  );
  if (statuses.length === 0) return output("No roles assigned.\n", { roles: statuses });
  return output(`${renderTable(
    `Task roles: ${task.id}`,
    [
      { header: "Role", minWidth: 4, maxWidth: 24 },
      { header: "Agent", minWidth: 5, maxWidth: 20 },
      { header: "Health", minWidth: 6, maxWidth: 15 },
      { header: "Open input", minWidth: 5, maxWidth: 10 },
      { header: "Active work", minWidth: 10, maxWidth: 34 },
      { header: "Native session", minWidth: 10, maxWidth: 28 },
      { header: "tmux", minWidth: 6, maxWidth: 22 }
    ],
    statuses.map((status) => [
      status.roleName,
      status.agentId,
      status.health,
      taskRoleOpenInputLabel(status),
      taskRoleActiveWorkLabel(status),
      taskRoleNativeSessionLabel(status),
      taskRoleTmuxLabel(status)
    ]),
    defaultTableWidth()
  )}\n`, { roles: statuses });
}

function taskRoleStatus(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 2, "Task role status usage: yui task role status <task> <role>.");
  const task = requireTask(store, args[0]);
  const role = requireRole(store, task.id, args[1]);
  const [status] = inspectTaskRoleRuntimeStatuses(
    task.id,
    [role],
    store,
    options.runtime?.inspectTaskRolePanes?.(task.id) ?? []
  );
  if (status === undefined) throw roleNotFound(role.name);
  return output(renderTaskRoleRuntimeStatus(status), { role: status });
}

function showTaskRole(args: string[], store: TaskWorkflowStore): string {
  exactPositionals(args, 2, "Task role show usage: yui task role show <task> <role>.");
  const task = requireTask(store, args[0]);
  const role = requireRole(store, task.id, args[1]);
  return renderRoleDetails(`Task Role: ${role.name}`, role, {
    kind: "task",
    sessions: store.getTaskRoleSessionSet(task.id, role.name)
  });
}

function updateTaskRole(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task role update usage: yui task role update <task> <role> [Role and Agent settings].";
  const [taskId, roleName, ...tail] = args;
  if (taskId === undefined || roleName === undefined || taskId.startsWith("--") || roleName.startsWith("--")) {
    throw usageError("Task id and Role name are required.", usage);
  }
  const parsed = parseRoleOptions(tail, new Map([
    ...roleOptionSpecs({ update: true, includeAgent: true }),
    ["--profile", "value" as const]
  ]), usage);
  if (parsed.has("--agent") && (parsed.one("--agent")?.trim().length ?? 0) === 0) {
    throw usageError("--agent is required.", usage);
  }
  if ([...parsed.seen].every((option) => option === "--agent")) {
    throw usageError("At least one role update option is required.", usage);
  }
  const now = clock(options);
  const updated = store.transaction((tx) => {
    const task = requireTask(tx, taskId);
    assertTaskOpen(task);
    const role = requireRole(tx, task.id, roleName);
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    const activeRun = tx.getActiveAgentRun(task.id, role.name);
    const changesLaunchContext = hasRoleLaunchContextOptions(parsed) || parsed.has("--profile");
    const changesAgentConfig = hasAgentConfigOptions(parsed);
    if (changesLaunchContext || changesAgentConfig) {
      assertRoleRuntimeMutationAllowed(tx, {
        scope: "task",
        taskId: task.id,
        roleName: role.name
      }, "launch configuration update");
    }
    if (
      changesLaunchContext
      && (
        activeRun !== null
        || Object.values(sessions?.sessions ?? {}).some(({ status }) => status !== "stopped")
      )
    ) {
      throw usageError(
        "Role launch context cannot be changed while its Run or native process is running."
      );
    }
    let bindings = role.agentBindings;
    if (changesAgentConfig) {
      const agentId = parsed.one("--agent")?.trim() || role.activeAgentId;
      const agent = requireAgent(tx, agentId);
      const binding = bindings[agentId]
        ?? createRoleAgentBinding({ id: agent.id, adapterId: agent.adapterId });
      const targetSession = sessions?.sessions[agentId];
      if (
        (agentId === role.activeAgentId && activeRun !== null)
        || (targetSession !== undefined && targetSession.status !== "stopped")
      ) {
        throw usageError("Agent settings cannot be changed while its Run or native process is running.");
      }
      bindings = { ...bindings, [agentId]: patchRoleAgentBinding(binding, parsed) };
    }
    const profileId = parsed.one("--profile");
    const withProfile = profileId === undefined
      ? role
      : updateRole(role, workerProfileRolePatch(requireAgentProfile(tx, profileId)), now);
    const next = updateRole(withProfile, {
      ...(bindings === role.agentBindings ? {} : { agentBindings: bindings }),
      ...roleProfilePatch(parsed)
    }, now);
    if (changesLaunchContext) {
      validateConfiguredRoleSkills(options.yuiHome, next.skills ?? []);
    }
    tx.saveRole(task.id, next);
    enqueueWork(tx, taskMailbox(task.id), "role-updated", now, [taskRef(task.id)]);
    return next;
  });
  notifyMailbox(options.runtime, taskMailbox(updated.taskId), updated.taskId);
  return renderRoleDetails(`Updated Task Role: ${updated.name}`, updated, {
    kind: "task",
    sessions: store.getTaskRoleSessionSet(updated.taskId, updated.name)
  });
}

function removeTaskRole(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 2, "Task role remove usage: yui task role remove <task> <role>.");
  const now = clock(options);
  const removed = store.transaction((tx) => {
    const task = requireTask(tx, args[0]);
    assertTaskOpen(task);
    const role = requireRole(tx, task.id, args[1]);
    if (role.name === LEADER_ROLE) throw usageError("The Task Leader role cannot be removed.");
    assertRoleRuntimeMutationAllowed(tx, {
      scope: "task",
      taskId: task.id,
      roleName: role.name
    }, "removal");
    if (tx.getActiveAgentRun(task.id, role.name) !== null) {
      throw usageError(`Task Role has an active Run and cannot be removed: ${task.id}/${role.name}.`);
    }
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    if (Object.values(sessions?.sessions ?? {}).some(({ status }) => status !== "stopped")) {
      throw usageError(`Task Role has a running native Agent and cannot be removed: ${task.id}/${role.name}.`);
    }
    if (!tx.removeTaskRole(task.id, role.name)) throw roleNotFound(role.name);
    enqueueWork(tx, taskMailbox(task.id), "role-removed", now, [taskRef(task.id)]);
    return role;
  });
  notifyMailbox(options.runtime, taskMailbox(removed.taskId), removed.taskId);
  return `Removed role ${removed.name} from ${removed.taskId}\n`;
}

function bindTaskRole(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 3, "Task role bind usage: yui task role bind <task> <role> <agent-id>.");
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, args[0]);
    assertTaskOpen(task);
    const role = requireRole(tx, task.id, args[1]);
    assertRoleRuntimeMutationAllowed(tx, {
      scope: "task",
      taskId: task.id,
      roleName: role.name
    }, "Agent binding");
    const agent = requireAgent(tx, args[2]);
    const binding = role.agentBindings[agent.id]
      ?? createRoleAgentBinding({ id: agent.id, adapterId: agent.adapterId });
    const bound = updateRole(role, {
      agentBindings: { ...role.agentBindings, [agent.id]: binding }
    }, now);
    enqueueWork(tx, taskMailbox(task.id), "role-bound", now, [taskRef(task.id)]);
    if (agent.id === role.activeAgentId) {
      tx.saveRole(task.id, bound);
      return { role: bound, mode: "current" as const };
    }
    const existing = tx.getTaskRoleSessionSet(task.id, role.name)
      ?? createRoleSessionSet({ scope: "task", taskId: task.id, roleName: role.name }, role.activeAgentId, now);
    const currentSession = existing.sessions[role.activeAgentId];
    const switched = (() => {
      try {
        return switchActiveRoleAgent(bound, existing, agent.id, {
          activeRun: tx.getActiveAgentRun(task.id, role.name) !== null,
          nativeProcessRunning: currentSession !== undefined
            && currentSession.status !== "stopped"
        }, now);
      } catch (error) {
        throw usageError(messageOf(error));
      }
    })();
    tx.saveTaskRoleWithSessionSet(switched.role, switched.sessions);
    return { role: switched.role, mode: switched.mode };
  });
  notifyMailbox(options.runtime, taskMailbox(result.role.taskId), result.role.taskId);
  return `Bound ${result.role.taskId}/${result.role.name} to ${result.role.activeAgentId} (${result.mode})\n`;
}

function unbindTaskRole(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(
    args,
    3,
    "Task role unbind usage: yui task role unbind <task> <role> <agent-id>."
  );
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, args[0]);
    const role = requireRole(tx, task.id, args[1]);
    try {
      const unbound = unbindRoleAgent(
        role,
        tx.getTaskRoleSessionSet(task.id, role.name),
        args[2],
        now
      );
      if (unbound.sessions === null) tx.saveRole(task.id, unbound.role);
      else tx.saveTaskRoleWithSessionSet(unbound.role, unbound.sessions);
      return unbound.role;
    } catch (error) {
      throw usageError(messageOf(error));
    }
  });
  return `Unbound Agent ${args[2]} from ${result.taskId}/${result.name}\n`;
}

function enterTaskRole(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 2, "Task role enter usage: yui task role enter <task> <role>.");
  const task = requireTask(store, args[0]);
  if (task.status !== "active") {
    throw usageError(inactiveTaskMessage(task, "entering a role session"));
  }
  const role = requireRole(store, task.id, args[1]);
  return {
    kind: "enter",
    taskId: task.id,
    roleName: role.name,
    output: `Prepared role ${role.name} for ${task.id}\n`
  };
}

function enterTaskRoleAlias(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  if (args.length < 1 || args.length > 2 || args.some((value) => value.trim().length === 0)) {
    throw usageError("Task enter usage: yui task enter <task> [role].");
  }
  return enterTaskRole([args[0], args[1] ?? LEADER_ROLE], store, options);
}

function taskWorkCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "create") return createWork(rest, store, options);
  if (command === "list") return listWork(rest, store);
  if (command === "update") return output(updateWork(rest, store, options));
  if (command === "scope") return output(updateWorkScope(rest, store, options));
  if (command === "dispatch") return output(dispatchWork(rest, store, options));
  if (command === "review") return output(reviewWork(rest, store, options));
  if (command === "accept") return acceptWork(rest, store, options);
  if (command === "reject") return rejectWork(rest, store, options);
  if (command === "cancel") return cancelWork(rest, store, options);
  throw usageError(command === undefined
    ? "Task work command is required."
    : `Unknown command: task work ${command}`);
}

function createWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task work create usage: yui task work create <task> <title> [--project <project> ...] [--objective <text>] [--accept <criterion> ...] [--after <work> ...] [--role <name>].";
  const parsed = parseWorkCreateArgs(args, usage);
  exactPositionals(parsed.positionals, 2, usage);
  const now = clock(options);
  const item = store.transaction((tx) => {
    const task = requireTask(tx, parsed.positionals[0]);
    assertTaskOpen(task);
    for (const dependencyId of parsed.after) {
      const dependency = tx.getWorkItem(task.id, dependencyId);
      if (dependency === null) throw usageError(`Work Item dependency not found: ${dependencyId}.`);
    }
    if (parsed.role !== undefined) requireRole(tx, task.id, parsed.role);
    const writeProjectIds = parsed.projects.map((reference) => {
      const project = resolveProject(
        task.projectBindings.map(({ projectId }) => requireProject(tx, projectId)),
        reference
      );
      if (project === null) throw usageError(`Task Project not found: ${reference}.`);
      return project.id;
    });
    const created = createWorkItem(tx.nextWorkItemId(task.id), task.id, {
      title: parsed.positionals[1],
      objective: parsed.objective ?? parsed.positionals[1],
      acceptance: parsed.acceptance,
      dependsOn: parsed.after,
      writeProjectIds,
      ...(parsed.role === undefined ? {} : { assignee: parsed.role })
    }, now);
    tx.saveWorkItem(task.id, created);
    enqueueWork(tx, taskMailbox(task.id), "work-created", now, [workItemRef(created.id)]);
    return created;
  });
  notifyMailbox(options.runtime, taskMailbox(item.taskId), item.taskId);
  return output(`Created work item ${item.id} for ${item.taskId}\n`, { workItem: item });
}

function updateWorkScope(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task work scope usage: yui task work scope <work> [--project <project> ...].";
  const parsed = parseMultiValueTail(
    args,
    new Set(),
    new Set(["--project"]),
    usage
  );
  exactPositionals(parsed.positionals, 1, usage);
  const now = clock(options);
  const updated = store.transaction((tx) => {
    const item = requireWorkItem(tx, parsed.positionals[0]);
    const task = requireTask(tx, item.taskId);
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may change a Work Item Project scope.");
    }
    if (tx.getActiveAgentRun(task.id, item.assignee ?? "") !== null) {
      throw usageError(`Stop the active Work Item Run before changing scope: ${item.id}.`);
    }
    const requestedProjectIds = (parsed.multiOptions.get("--project") ?? []).map((reference) => {
      const project = resolveProject(
        task.projectBindings.map(({ projectId }) => requireProject(tx, projectId)),
        reference
      );
      if (project === null) throw usageError(`Task Project not found: ${reference}.`);
      return project.id;
    });
    const requested = new Set(requestedProjectIds);
    const projectIds = task.projectBindings
      .map(({ projectId }) => projectId)
      .filter((projectId) => requested.has(projectId));
    const next = updateWorkItemWriteProjects(item, projectIds, now);
    if (next === item) return { item, changed: false } as const;
    tx.saveWorkItem(task.id, next);
    recordTaskEvent(tx, task.id, "work.scope-updated", {
      workItemId: item.id,
      projectIds: projectIds.join(",")
    }, now);
    enqueueWork(tx, taskMailbox(task.id), "work-scope-updated", now, [workItemRef(item.id)]);
    return { item: next, changed: true } as const;
  });
  if (updated.changed) {
    notifyMailbox(options.runtime, taskMailbox(updated.item.taskId), updated.item.taskId);
  }
  return `${updated.changed ? "Updated" : "Unchanged"} Work Item Project scope ${
    updated.item.id
  }: ${
    updated.item.writeProjectIds.join(", ") || "read-only"
  }\n`;
}

function updateWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task work update usage: yui task work update <id> <todo|running|done|failed|cancelled|superseded> [--summary <text>].";
  const parsed = parseTail(args, new Set(["--summary"]), usage);
  exactPositionals(parsed.positionals, 2, usage);
  const requested = parsed.positionals[1];
  const status = parseWorkStatus(requested);
  const summary = trimmed(parsed.options.get("--summary"));
  if (["completed", "failed", "cancelled", "superseded"].includes(status)
    && summary === undefined) {
    throw usageError(`--summary is required when work becomes ${requested}.`);
  }
  const now = clock(options);
  const result = store.transaction((tx) => {
    const current = requireWorkItem(tx, parsed.positionals[0]);
    const task = requireTask(tx, current.taskId);
    assertTaskOpen(task);
    if (current.assignee === undefined) {
      if (taskActor(options, task.id) !== "leader") {
        throw usageError(
          `Only the Task Leader may update unassigned Work Item execution: ${current.id}.`
        );
      }
      if (status === "running") {
        assertWorkItemDependenciesCompleted(tx, current);
      }
      const reviewConfig = status === "completed" && !isTerminalWorkItemStatus(current.status)
        ? tx.getReviewConfig()
        : null;
      const projectDelivery = task.projectBindings.length > 0
        && current.writeProjectIds.length > 0;
      const candidateRequired = projectDelivery || reviewConfig !== null;
      const developWorkspace = tx.getWorkItemWorkspace(task.id, current.id);
      if (status === "completed" && projectDelivery && developWorkspace === null) {
        throw usageError(
          `Project-backed Work Item ${current.id} must be isolated before Candidate submission.`
        );
      }
      const updated = candidateRequired
        ? submitWorkItemCandidate(current, {
            summary: summary!,
            source: { type: "direct" },
            ...(reviewConfig === null ? {} : { reviewPolicy: reviewConfig }),
            ...(developWorkspace === null
              ? {}
              : {
                  workspace: freezeCandidateWorkspace(
                    developWorkspace,
                    now
                  )
                })
          }, now)
        : current.status === "failed" && status === "running"
        ? retryFailedWorkItem(current, now)
        : updateWorkItemStatus(
            current,
            status,
            now,
            isTerminalWorkItemStatus(status) ? summary : undefined
          );
      tx.saveWorkItem(task.id, updated);
      if (summary !== undefined) {
        recordTaskEvent(tx, task.id, "work.updated", {
          workItemId: updated.id,
          status: updated.status,
          summary
        }, now);
      }
      enqueueWork(tx, taskMailbox(task.id), "work-updated", now, [
        workItemRef(updated.id)
      ]);
      const reviewDispatch = reviewConfig?.trigger === "always"
        ? queueReviewRound(
            tx,
            updated,
            reviewConfig,
            "policy",
            now
          )
        : null;
      return {
        item: updated,
        reviewDispatch,
        reviewTrigger: reviewConfig?.trigger ?? null
      };
    }
    if (
      current.workspaceDisposition !== undefined
      && isTerminalWorkItemStatus(current.status)
      && status === "superseded"
    ) {
      const updated = updateWorkItemStatus(current, status, now, summary);
      tx.saveWorkItem(task.id, updated);
      enqueueWork(tx, taskMailbox(task.id), "work-updated", now, [workItemRef(updated.id)]);
      return { item: updated, reviewDispatch: null, reviewTrigger: null };
    }
    throw usageError(
      `Assigned Work Item execution cannot use task work update: ${current.id}. `
      + "Use dispatch and run yield, then let the Task Leader accept or reject the result; "
      + "use task work cancel to cancel it."
    );
  });
  notifyMailbox(options.runtime, taskMailbox(result.item.taskId), result.item.taskId);
  if (result.reviewDispatch?.run !== null
    && result.reviewDispatch?.run !== undefined) {
    notifyMailbox(
      options.runtime,
      roleMailbox(result.reviewDispatch.run.taskId, result.reviewDispatch.run.roleName),
      result.reviewDispatch.run.taskId
    );
  }
  if (result.item.status === "awaiting_acceptance" && status === "completed") {
    const failure = result.reviewDispatch?.round.status === "failed"
      ? `Review could not start: ${result.reviewDispatch.round.summary}\n`
      : "";
    const destination = result.reviewTrigger === "always"
      ? "review"
      : "Leader decision";
    return `Submitted work item ${result.item.id} for ${destination}\n${failure}`;
  }
  return `Updated work item ${result.item.id} to ${requested}\n`;
}

function dispatchWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task work dispatch usage: yui task work dispatch <id> [--input <text>].";
  const parsed = parseTail(args, new Set(["--input"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const now = clock(options);
  const run = store.transaction((tx) => {
    const item = requireWorkItem(tx, parsed.positionals[0]);
    const task = requireTask(tx, item.taskId);
    if (task.status !== "active") {
      throw usageError(inactiveTaskMessage(task, "dispatch"));
    }
    if (item.status !== "pending" && item.status !== "failed") {
      throw usageError(`Work item ${item.id} cannot be dispatched from ${item.status}.`);
    }
    if (item.assignee === undefined) {
      throw usageError(
        `Work Item has no Task Role assignee: ${item.id}. `
        + `The Task Leader must run "yui task work update ${item.id} running", `
        + "then execute it directly or create a native subagent in the Leader conversation."
      );
    }
    assertWorkItemDependenciesCompleted(tx, item);
    const role = requireRole(tx, task.id, item.assignee);
    const workspace = tx.getWorkItemWorkspace(task.id, item.id);
    if (workspace?.owner.type === "work-item"
      && workspace.owner.workItemId !== item.id) {
      throw usageError(
        `Role ${role.name} still uses the isolated worktree for ${workspace.owner.workItemId}; `
        + `cleanup ${workspace.owner.workItemId} before dispatching ${item.id}.`
      );
    }
    if (item.writeProjectIds.length > 0) {
      const writable = workspace?.owner.type === "work-item"
        && workspace.owner.workItemId === item.id
        ? workspace.entries
          .filter(({ access }) => access === "write")
          .map(({ projectId }) => projectId)
          .sort()
        : [];
      const visible = workspace?.owner.type === "work-item"
        && workspace.owner.workItemId === item.id
        ? workspace.entries.map(({ projectId }) => projectId).sort()
        : [];
      if (
        !isDeepStrictEqual(writable, [...item.writeProjectIds].sort())
        || !isDeepStrictEqual(
          visible,
          task.projectBindings.map(({ projectId }) => projectId).sort()
        )
      ) {
        throw usageError(
          `Work Item ${item.id} must be isolated with its approved Project scope before dispatch.`
        );
      }
    }
    if (tx.getActiveAgentRun(task.id, role.name) !== null) {
      throw usageError(`${task.id}/${role.name} already has an active run.`);
    }
    const rawInput = trimmed(parsed.options.get("--input")) ?? item.objective;
    const runId = tx.nextAgentRunId(task.id);
    const input = markYuiRunInput(
      compileDispatchInput({}, task.id, role, rawInput, {
        workItem: item,
        ...(workspace?.owner.type === "work-item"
          && workspace.owner.workItemId === item.id
          ? { workspace }
          : {})
      }),
      runId,
      taskRoleSessionTitle(task, role.name)
    );
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    const dispatchMode = roleAgentSessionResumeMode(sessions, role.activeAgentId);
    if (item.status === "failed"
      && item.candidates.length > 0
      && dispatchMode !== "resume") {
      throw usageError(
        `Work Item ${item.id} repair requires the original ${role.name} native Session. `
        + "Restore it or ask the user how to proceed; Yui will not create a replacement "
        + "Session implicitly."
      );
    }
    const created = createAgentRun(
      runId,
      task.id,
      role.name,
      dispatchMode,
      input,
      now,
      {
        workItemId: item.id,
        ...(workspace === null
          ? (tx.getTaskWorkspace(task.id) === null
            ? {}
            : { workspace: tx.getTaskWorkspace(task.id)! })
          : { workspace }),
        agent: agentRunSnapshot(role)
      }
    );
    tx.saveAgentRun(created);
    tx.saveActiveAgentRun(created);
    tx.saveWorkItem(task.id, item.status === "failed"
      ? retryFailedWorkItem(item, now)
      : updateWorkItemStatus(item, "running", now));
    tx.saveRole(task.id, updateRoleStatus(role, "running", now));
    enqueueWork(tx, roleMailbox(task.id, role.name), "run-dispatched", now, [
      runRef(created.id),
      workItemRef(item.id)
    ]);
    return created;
  });
  notifyMailbox(options.runtime, roleMailbox(run.taskId, run.roleName), run.taskId);
  return `Dispatch queued for ${run.taskId}/${run.roleName} (${run.id})\n`;
}

function acceptWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task work accept usage: yui task work accept <work> --summary <text>.";
  const parsed = parseTail(args, new Set(["--summary"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const summary = requiredOption(parsed.options, "--summary");
  const now = clock(options);
  const accepted = store.transaction((tx) => {
    const item = requireWorkItem(tx, parsed.positionals[0]);
    const task = requireTask(tx, item.taskId);
    if (task.status !== "active") {
      throw usageError(`Task is not active: ${task.id}/${task.status}.`);
    }
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may accept a Work Item.");
    }
    if (item.status !== "awaiting_acceptance") {
      throw usageError(`Work Item is not awaiting acceptance: ${item.id}/${item.status}.`);
    }
    const candidate = requireWorkItemCandidate(item);
    const latestReview = chronologicalReviewRounds(tx.listReviewRounds(item.taskId)
      .filter((round) => round.candidateId === candidate.id)).at(-1);
    if (latestReview !== undefined
      && (latestReview.status === "pending" || latestReview.status === "running")) {
      throw usageError(
        `ReviewRound is not completed: ${latestReview.id}/${latestReview.status}.`
      );
    }
    if (candidate.reviewPolicy?.trigger === "always"
      && latestReview === undefined) {
      throw usageError(`Work Item candidate has no required ReviewRound: ${item.id}.`);
    }
    const isolatedWorkspace = tx.getWorkItemWorkspace(item.taskId, item.id);
    if (task.projectBindings.length > 0
      && item.writeProjectIds.length > 0
      && isolatedWorkspace === null) {
      throw usageError(
        `Project-backed Work Item ${item.id} has no WorkItem Develop workspace for acceptance.`
      );
    }
    if (
      isolatedWorkspace?.owner.type === "work-item"
      && isolatedWorkspace.owner.workItemId === item.id
    ) {
      assertWorkItemIntegrationProof(
        tx,
        item.id,
        item.assignee,
        isolatedWorkspace,
        options.workItemIntegrationProof
      );
    }
    const completed = updateWorkItemStatus(item, "completed", now, summary);
    tx.saveWorkItem(item.taskId, completed);
    recordTaskEvent(tx, item.taskId, "work.accepted", {
      workItemId: item.id,
      candidateId: candidate.id,
      ...(candidate.source.type === "run"
        ? { runId: candidate.source.runId }
        : { workItemRevision: String(candidate.workItemRevision) }),
      acceptedBy: "leader",
      summary
    }, now);
    return completed;
  });
  return output(`Accepted Work Item ${accepted.id}\n`, { workItem: accepted });
}

function assertWorkItemIntegrationProof(
  store: TaskWorkflowStore,
  workItemId: string,
  assignee: string | undefined,
  workspace: NonNullable<ReturnType<TaskWorkflowStore["getWorkItemWorkspace"]>>,
  proof: WorkItemIntegrationProof | undefined
): void {
  if (
    proof === undefined
    || proof.workItemId !== workItemId
    || proof.assignee !== assignee
    || !isDeepStrictEqual(proof.workspace, workspace)
  ) {
    throw usageError(
      `WorkItem workspace has not been verified for acceptance: ${workItemId}.`
    );
  }
  const writable = workspace.entries.filter(({ access }) => access === "write");
  if (proof.projects.length !== writable.length) {
    throw usageError(`WorkItem integration verification is stale: ${workItemId}.`);
  }
  for (const entry of writable) {
    const projectProof = proof.projects.find(({ projectId }) => projectId === entry.projectId);
    if (projectProof === undefined || projectProof.baseCommit !== entry.baseCommit) {
      throw usageError(`WorkItem integration verification is stale: ${workItemId}.`);
    }
    const latestChangeSet = store.listChangeSets(workspace.owner.taskId)
      .filter((changeSet) => (
        changeSet.workItemId === workItemId
        && changeSet.projectId === entry.projectId
      ))
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id)
      ))
      .at(-1);
    if (projectProof.headCommit === entry.baseCommit) {
      if (projectProof.changeSetId !== undefined || latestChangeSet !== undefined) {
        throw usageError(`WorkItem integration verification is stale: ${workItemId}.`);
      }
      continue;
    }
    if (
      projectProof.changeSetId === undefined
      || latestChangeSet?.id !== projectProof.changeSetId
      || latestChangeSet.baseCommit !== entry.baseCommit
      || latestChangeSet.headCommit !== projectProof.headCommit
      || latestChangeSet.branch !== entry.branch
    ) {
      throw usageError(
        `WorkItem integration verification is stale: ${workItemId}.`
      );
    }
    if (!store.listIntegrationAttempts(workspace.owner.taskId).some((integration) => (
      integration.status === "committed"
      && integration.projectId === entry.projectId
      && integration.changeSetIds.includes(projectProof.changeSetId!)
    ))) {
      throw usageError(`Work Item ChangeSet is not integrated: ${projectProof.changeSetId}.`);
    }
  }
}

function rejectWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task work reject usage: yui task work reject <work> --summary <text>.";
  const parsed = parseTail(args, new Set(["--summary"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const summary = requiredOption(parsed.options, "--summary");
  const now = clock(options);
  const rejected = store.transaction((tx) => {
    const item = requireWorkItem(tx, parsed.positionals[0]);
    const task = requireTask(tx, item.taskId);
    if (task.status !== "active") {
      throw usageError(`Task is not active: ${task.id}/${task.status}.`);
    }
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may reject a Work Item.");
    }
    if (item.status !== "awaiting_acceptance") {
      throw usageError(`Work Item is not awaiting acceptance: ${item.id}/${item.status}.`);
    }
    const candidate = requireWorkItemCandidate(item);
    const activeReview = activeReviewRoundForCandidate(tx, item, candidate);
    if (activeReview !== undefined) {
      throw usageError(`ReviewRound is still active: ${activeReview.id}/${activeReview.status}.`);
    }
    const failed = updateWorkItemStatus(item, "failed", now, summary);
    tx.saveWorkItem(item.taskId, failed);
    recordTaskEvent(tx, item.taskId, "work.rejected", {
      workItemId: item.id,
      candidateId: candidate.id,
      rejectedBy: "leader",
      summary
    }, now);
    return failed;
  });
  return output(`Rejected Work Item ${rejected.id}\n`, { workItem: rejected });
}

function cancelWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task work cancel usage: yui task work cancel <work> --summary <text>.";
  const parsed = parseTail(args, new Set(["--summary"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const summary = requiredOption(parsed.options, "--summary");
  const now = clock(options);
  const result = store.transaction((tx) => {
    const item = requireWorkItem(tx, parsed.positionals[0]);
    const task = requireTask(tx, item.taskId);
    if (task.status !== "active") {
      throw usageError(`Task is not active: ${task.id}/${task.status}.`);
    }
    if (!["pending", "failed", "awaiting_acceptance"].includes(item.status)) {
      throw usageError(
        item.status === "running"
          ? `Work Item is running; stop or fail its active AgentRun first: ${item.id}.`
          : `Work Item cannot be cancelled from ${item.status}: ${item.id}.`
      );
    }
    const actor = taskActor(options, task.id);
    if (item.status === "awaiting_acceptance") {
      const candidate = requireWorkItemCandidate(item);
      const activeReview = activeReviewRoundForCandidate(tx, item, candidate);
      if (activeReview !== undefined) {
        throw usageError(`ReviewRound is still active: ${activeReview.id}/${activeReview.status}.`);
      }
    }
    const cancelled = updateWorkItemStatus(item, "cancelled", now, summary);
    tx.saveWorkItem(item.taskId, cancelled);
    recordTaskEvent(tx, item.taskId, "work.cancelled", {
      workItemId: item.id,
      cancelledBy: actor,
      summary
    }, now);
    if (actor !== "leader") {
      enqueueWork(tx, leaderMailbox(task.id), "work-cancelled", now, [
        workItemRef(item.id)
      ]);
    }
    return { item: cancelled, notifyLeader: actor !== "leader" };
  });
  if (result.notifyLeader) {
    notifyMailbox(options.runtime, leaderMailbox(result.item.taskId), result.item.taskId);
  }
  return output(`Cancelled Work Item ${result.item.id}\n`, { workItem: result.item });
}

function listWork(args: string[], store: TaskWorkflowStore): TaskCommandExecution {
  exactPositionals(args, 1, "Task work list usage: yui task work list <task>.");
  const task = requireTask(store, args[0]);
  const items = store.listWorkItems(task.id);
  const rendered = items.length === 0
    ? "No work items found.\n"
    : `${renderTable(
        `Task work: ${task.id}`,
        [
          { header: "Work", minWidth: 6, maxWidth: 20 },
          { header: "Status", minWidth: 6, maxWidth: 12 },
          { header: "Role", minWidth: 4, maxWidth: 18 },
          { header: "Write Projects", minWidth: 8, maxWidth: 28 },
          { header: "Title", minWidth: 8, maxWidth: 64 },
          { header: "Acceptance", minWidth: 10, maxWidth: 16 },
          { header: "Outcome", minWidth: 8, maxWidth: 40 }
        ],
        items.map((item) => [
          item.id,
          presentWorkStatus(item.status),
          item.assignee ?? "Leader",
          item.writeProjectIds.join(", ") || "-",
          item.title,
          String(item.acceptance.length),
          item.outcome ?? "-"
        ]),
        defaultTableWidth()
      )}\n`;
  return output(rendered, { workItems: items });
}

function reviewWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 1, "Task work review usage: yui task work review <work>.");
  const now = clock(options);
  const result = store.transaction((tx) => {
    const item = requireWorkItem(tx, args[0]);
    const task = requireTask(tx, item.taskId);
    if (task.status !== "active") {
      throw usageError(`Task is not active: ${task.id}/${task.status}.`);
    }
    if (taskActor(options, task.id) !== "leader") {
      throw usageError("Only the Task Leader may request a Work Item review.");
    }
    if (item.status !== "awaiting_acceptance") {
      throw usageError(`Work Item is not awaiting acceptance: ${item.id}/${item.status}.`);
    }
    const candidate = requireWorkItemCandidate(item);
    const config = candidate.reviewPolicy;
    if (config === undefined) {
      throw usageError(`Candidate has no review policy: ${candidate.id}.`);
    }
    const activeRound = chronologicalReviewRounds(tx.listReviewRounds(task.id)
      .filter((round) => (
        round.candidateId === candidate.id
        && (round.status === "pending" || round.status === "running")
      ))).at(-1);
    if (activeRound !== undefined) {
      throw usageError(`ReviewRound is already active: ${activeRound.id}/${activeRound.status}.`);
    }
    return queueReviewRound(tx, item, config, "leader", now);
  });
  if (result.run !== null) {
    notifyMailbox(
      options.runtime,
      roleMailbox(result.run.taskId, result.run.roleName),
      result.run.taskId
    );
  }
  return result.run === null
    ? `Review could not start for ${result.round.workItemId}: ${result.round.summary}\n`
    : `Review queued as ${result.round.id} (${result.run.id})\n`;
}

function taskRunCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const [command, ...rest] = args;
  if (command === "list") return listRuns(rest, store);
  if (command === "retry") return retryRun(rest, store, options);
  if (command === "yield") return yieldRun(rest, store, options);
  throw usageError(command === undefined
    ? "Task run command is required."
    : `Unknown command: task run ${command}`);
}

function listRuns(args: string[], store: TaskWorkflowStore): string {
  exactPositionals(args, 1, "Task run list usage: yui task run list <work>.");
  const item = requireWorkItem(store, args[0]);
  const runs = store.listAgentRuns(item.taskId).filter((run) => run.workItemId === item.id);
  if (runs.length === 0) return "No runs found.\n";
  return `${renderTable(
    `Runs: ${item.id}`,
    [
      { header: "Run", minWidth: 6, maxWidth: 20 },
      { header: "Role", minWidth: 4, maxWidth: 22 },
      { header: "Purpose", minWidth: 6, maxWidth: 10 },
      { header: "Mode", minWidth: 4, maxWidth: 8 },
      { header: "Status", minWidth: 6, maxWidth: 12 },
      { header: "Summary", minWidth: 8, maxWidth: 58 }
    ],
    runs.map((run) => [
      run.id,
      run.roleName,
      run.purpose,
      run.mode,
      run.status,
      run.summary ?? "-"
    ]),
    defaultTableWidth()
  )}\n`;
}

function retryRun(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 1, "Task run retry usage: yui task run retry <run>.");
  const now = clock(options);
  const retried = store.transaction((tx) => {
    const previous = requireRun(tx, args[0]);
    if (previous.status !== "failed") {
      throw usageError(`Run ${previous.id} is not retryable from ${previous.status}.`);
    }
    if (previous.purpose === "review") {
      throw usageError(
        `Review Run ${previous.id} is not retried directly; request a new WorkItem review.`
      );
    }
    const task = requireTask(tx, previous.taskId);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    const role = requireRole(tx, task.id, previous.roleName);
    if (tx.getActiveAgentRun(task.id, role.name) !== null) {
      throw usageError(`${task.id}/${role.name} already has an active run.`);
    }
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    const runId = tx.nextAgentRunId(task.id);
    const retaggedInput = retagYuiRunInput(
      previous.input,
      runId,
      taskRoleSessionTitle(task, role.name)
    );
    const created = createAgentRun(
      runId,
      task.id,
      role.name,
      roleAgentSessionResumeMode(sessions, role.activeAgentId),
      previous.workItemId === undefined
        ? retaggedInput
        : ensureWorkerRunCompletionRequirement(retaggedInput),
      now,
      {
        ...(previous.workItemId === undefined ? {} : { workItemId: previous.workItemId }),
        ...(previous.workspace === undefined ? {} : { workspace: previous.workspace }),
        agent: agentRunSnapshot(role)
      }
    );
    tx.saveAgentRun(created);
    tx.saveActiveAgentRun(created);
    tx.saveRole(task.id, updateRoleStatus(role, "running", now));
    if (previous.workItemId !== undefined) {
      const item = tx.getWorkItem(task.id, previous.workItemId);
      if (item === null) {
        throw dataError(`Work item not found for run ${previous.id}: ${previous.workItemId}.`);
      }
      const workspace = tx.getWorkItemWorkspace(task.id, item.id);
      if (workspace?.owner.type === "work-item"
        && workspace.owner.workItemId !== item.id) {
        throw usageError(
          `Role ${role.name} uses the isolated worktree for ${workspace.owner.workItemId}; `
          + `cannot retry ${item.id}.`
        );
      }
      tx.saveWorkItem(task.id, retryFailedWorkItem(item, now));
    }
    enqueueWork(tx, roleMailbox(task.id, role.name), "run-retried", now, [runRef(created.id)]);
    return created;
  });
  notifyMailbox(options.runtime, roleMailbox(retried.taskId, retried.roleName), retried.taskId);
  return `Retry queued as ${retried.id} for ${retried.taskId}/${retried.roleName}\n`;
}

function yieldRun(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task run yield usage: yui task run yield <run> (--summary <text>|--summary-file <path|->).";
  const parsed = parseTail(args, new Set(["--summary", "--summary-file"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const summary = readCommandText(
    parsed.options.get("--summary"),
    parsed.options.get("--summary-file"),
    "--summary",
    usage
  );
  const now = clock(options);
  const yielded = store.transaction((tx) => {
    const active = requireRun(tx, parsed.positionals[0]);
    if (active.status !== "active") {
      throw usageError(`Run ${active.id} is already terminal: ${active.status}.`);
    }
    if (active.deliveredAt === undefined) {
      throw usageError(`Run ${active.id} delivery is still pending.`);
    }
    const task = requireTask(tx, active.taskId);
    if (task.status !== "active") throw usageError(inactiveTaskMessage(task, "yielding a run"));
    const role = requireRole(tx, task.id, active.roleName);
    const pointer = tx.getActiveAgentRun(task.id, role.name);
    if (pointer?.id !== active.id) throw usageError(`Run is not active for ${task.id}/${role.name}: ${active.id}.`);
    const terminal = yieldAgentRun(active, summary, now);
    const message = appendMessage(
      tx,
      task.id,
      summary,
      "role-result",
      { type: "role", roleName: role.name },
      now,
      { runId: terminal.id, workItemId: active.workItemId }
    );
    tx.saveAgentRun(terminal);
    requireCompleteWorkExecution(
      tx,
      roleMailbox(task.id, role.name),
      runRef(terminal.id)
    );
    tx.clearActiveAgentRun(task.id, role.name);
    let automaticReview: Readonly<{
      item: WorkItem;
      config: ReviewConfig;
    }> | null = null;
    let submittedItem: WorkItem | null = null;
    if (active.purpose === "review") {
      // Saving the terminal review Run completes its ReviewRound in the same
      // aggregate transaction. The WorkItem remains the candidate under review.
    } else if (active.workItemId !== undefined) {
      const item = tx.getWorkItem(task.id, active.workItemId);
      if (item === null) throw dataError(`Work item not found for run ${active.id}: ${active.workItemId}.`);
      const reviewConfig = tx.getReviewConfig();
      const candidateRequired = role.name !== LEADER_ROLE || reviewConfig !== null;
      const yieldedItem = candidateRequired
          ? submitWorkItemCandidate(item, {
            summary,
            source: { type: "run", runId: terminal.id },
            ...(reviewConfig === null ? {} : { reviewPolicy: reviewConfig }),
            ...(active.workspace === undefined
              ? {}
              : { workspace: freezeCandidateWorkspace(active.workspace, now) })
          }, now)
        : updateWorkItemStatus(item, "completed", now, summary);
      tx.saveWorkItem(task.id, yieldedItem);
      if (candidateRequired) submittedItem = yieldedItem;
      if (reviewConfig?.trigger === "always") {
        automaticReview = { item: yieldedItem, config: reviewConfig };
      }
    } else if (role.name !== LEADER_ROLE) {
      throw usageError(`Run ${active.id} is not a work run.`);
    }
    tx.saveRole(task.id, updateRoleStatus(role, "idle", now));
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    if (sessions !== null) {
      tx.saveTaskRoleSessionSet(terminalizeTaskRoleRunSession(sessions, {
        agentId: role.activeAgentId,
        runId: active.id,
        receiptId: `agent-run:${active.id}`
      }, now));
    }
    const reviewDispatch = automaticReview === null
      ? null
      : queueReviewRound(
          tx,
          automaticReview.item,
          automaticReview.config,
          "policy",
          now
        );
    const leaderHandoff = active.purpose === "review"
      ? "review-result"
      : submittedItem === null
        || (reviewDispatch !== null && reviewDispatch.run !== null)
        ? null
        : reviewDispatch?.round.status === "failed"
          ? "review-failed"
          : "candidate-ready";
    if (leaderHandoff !== null) {
      enqueueWork(tx, leaderMailbox(task.id), leaderHandoff, now, [
        runRef(terminal.id),
        messageRef(message.id),
        ...(terminal.workItemId === undefined ? [] : [workItemRef(terminal.workItemId)])
      ]);
    }
    return {
      run: terminal,
      message,
      reviewDispatch,
      notifyLeader: leaderHandoff !== null
    };
  });
  if (yielded.notifyLeader) {
    notifyMailbox(options.runtime, leaderMailbox(yielded.run.taskId), yielded.run.taskId);
  }
  if (yielded.reviewDispatch?.run !== null
    && yielded.reviewDispatch?.run !== undefined) {
    notifyMailbox(
      options.runtime,
      roleMailbox(
        yielded.reviewDispatch.run.taskId,
        yielded.reviewDispatch.run.roleName
      ),
      yielded.reviewDispatch.run.taskId
    );
  }
  return `Yielded ${yielded.run.id}: ${yielded.message.body}\n`;
}

function queueReviewRound(
  store: TaskWorkflowStore,
  item: WorkItem,
  config: ReviewConfig,
  requestedBy: "policy" | "leader",
  now: Date
): Readonly<{ round: ReviewRound; run: AgentRun | null }> {
  const candidate = requireWorkItemCandidate(item);
  const candidateRun = candidate.source.type === "run"
    ? store.getAgentRun(item.taskId, candidate.source.runId)
    : null;
  const pending = createReviewRound(
    store.nextReviewRoundId(item.taskId),
    item.taskId,
    item.id,
    candidate.id,
    config.roleName,
    requestedBy,
    now
  );
  store.saveReviewRound(item.taskId, pending);
  let reviewer = store.getRole(item.taskId, config.roleName);
  if (reviewer === null) {
    const globalRole = store.getGlobalRole(config.roleName);
    if (globalRole === null) {
      const failed = finishReviewRound(
        pending,
        "failed",
        `Global Role not found: ${config.roleName}.`,
        now
      );
      store.saveReviewRound(item.taskId, failed);
      return { round: failed, run: null };
    }
    const task = requireTask(store, item.taskId);
    reviewer = createTaskRole(store, task, config.roleName, undefined, now, config.roleName);
    store.saveRole(task.id, reviewer);
  }
  if (store.getActiveAgentRun(item.taskId, reviewer.name) !== null) {
    const failed = finishReviewRound(
      pending,
      "failed",
      `Reviewer Role already has an active run: ${reviewer.name}.`,
      now
    );
    store.saveReviewRound(item.taskId, failed);
    return { round: failed, run: null };
  }
  const task = requireTask(store, item.taskId);
  const candidateRoleName = candidateRun?.roleName;
  const candidateRole = candidateRoleName === undefined
    ? null
    : store.getRole(item.taskId, candidateRoleName);
  const projectDelivery = task.projectBindings.length > 0 && item.writeProjectIds.length > 0;
  const developWorkspaceRecord = candidate.workspace
    ?? candidateRun?.workspace
    ?? store.getWorkItemWorkspace(item.taskId, item.id)
    ?? (!projectDelivery && candidateRole === null
      ? store.getTaskWorkspace(item.taskId) ?? undefined
      : undefined);
  if (projectDelivery && (
    developWorkspaceRecord === undefined
    || developWorkspaceRecord.owner.type !== "work-item"
    || developWorkspaceRecord.owner.workItemId !== item.id
  )) {
    throw usageError(
      `Project-backed Work Item ${item.id} has no frozen WorkItem Develop workspace for review.`
    );
  }
  const reviewWorkspaceRecord = developWorkspaceRecord === undefined
    ? undefined
    : createReviewWorkspaceSnapshot(developWorkspaceRecord, pending.id, now);
  if (reviewWorkspaceRecord !== undefined) {
    store.saveManagedWorkspace(reviewWorkspaceRecord);
  }
  const candidateWorkspace = reviewWorkspaceRecord?.root
    ?? developWorkspaceRecord?.root
    ?? candidateRole?.workspace
    ?? task.cwd;
  const candidateLabel = candidate.source.type === "run"
    ? `candidate Run ${candidate.source.runId}`
    : `revision ${candidate.workItemRevision}`;
  const rawInput = [
    `Review WorkItem ${item.id} ${candidateLabel}.`,
    `Candidate summary: ${candidate.summary}`,
    `Candidate workspace: ${candidateWorkspace ?? "Task workspace"}`,
    `Acceptance criteria: ${item.acceptance.length === 0 ? "none" : item.acceptance.join("; ")}`,
    "Start from the user's core outcome and the WorkItem intent. The candidate summary is a pointer, not proof: inspect the complete relevant change, context, callers, and proportionate checks.",
    "Report only reachable, material, actionable problems with concrete evidence. Separate defects from verification gaps and prefer the smallest sufficient correction; do not design state, retries, fallbacks, or protocol for speculative extreme cases.",
    "Review the candidate only. Do not modify files or create another WorkItem. Expose evidence and options; the Leader decides whether to accept, fix, review again, or ask the user."
  ].join("\n");
  const runId = store.nextAgentRunId(item.taskId);
  const input = markYuiRunInput(
    compileDispatchInput({}, item.taskId, reviewer, rawInput, { workItem: item }),
    runId,
    taskRoleSessionTitle(task, reviewer.name)
  );
  const sessions = store.getTaskRoleSessionSet(item.taskId, reviewer.name);
  const run = createAgentRun(
    runId,
    item.taskId,
    reviewer.name,
    roleAgentSessionResumeMode(sessions, reviewer.activeAgentId),
    input,
    now,
    {
      workItemId: item.id,
      purpose: "review",
      reviewRoundId: pending.id,
      ...(reviewWorkspaceRecord === undefined
        ? {}
        : { workspace: reviewWorkspaceRecord }),
      agent: agentRunSnapshot(reviewer)
    }
  );
  store.saveAgentRun(run);
  const running = startReviewRound(pending, run.id);
  store.saveReviewRound(item.taskId, running);
  store.saveActiveAgentRun(run);
  store.saveRole(item.taskId, updateRoleStatus(reviewer, "running", now));
  enqueueWork(store, roleMailbox(item.taskId, reviewer.name), "review-requested", now, [
    runRef(run.id),
    workItemRef(item.id)
  ]);
  return { round: running, run };
}

function requireWorkItemCandidate(item: WorkItem): WorkItemCandidate {
  const candidate = currentWorkItemCandidate(item);
  if (candidate === undefined) {
    throw dataError(`Work Item has no submitted candidate: ${item.id}.`);
  }
  return candidate;
}

function createReviewWorkspaceSnapshot(
  workspace: ManagedWorkspace,
  reviewRoundId: string,
  now: Date
): ManagedWorkspace {
  return createManagedWorkspace({
    owner: {
      type: "review-round",
      taskId: workspace.owner.taskId,
      reviewRoundId
    },
    root: join(workspace.root, ".review-rounds", reviewRoundId),
    entries: workspace.entries.map((entry) => ({
      ...entry,
      path: join(workspace.root, ".review-rounds", reviewRoundId, entry.directory),
      access: "write" as const
    }))
  }, now);
}

/**
 * Freeze the Git snapshot carried by a Candidate without changing the
 * WorkItem-owned Develop record.  Workers are required to yield a committed,
 * clean Develop checkout; otherwise a ReviewRound could not be recreated
 * after a restart from a durable commit identity.
 */
function freezeCandidateWorkspace(
  workspace: ManagedWorkspace,
  now: Date
): ManagedWorkspace {
  const entries = workspace.entries.map((entry) => {
    try {
      const status = execFileSync(
        "git",
        ["-C", entry.path, "status", "--porcelain=v1", "--untracked-files=all"],
        { encoding: "utf8" }
      ).trim();
      if (status.length > 0) {
        throw new Error("the Develop workspace has uncommitted changes");
      }
      const branch = execFileSync(
        "git",
        ["-C", entry.path, "symbolic-ref", "--quiet", "--short", "HEAD"],
        { encoding: "utf8" }
      ).trim();
      if (branch !== entry.branch) {
        throw new Error(`the Develop workspace is on branch ${branch}`);
      }
      const baseCommit = execFileSync(
        "git",
        ["-C", entry.path, "rev-parse", "--verify", "HEAD^{commit}"],
        { encoding: "utf8" }
      ).trim().toLowerCase();
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseCommit)) {
        throw new Error("Git returned an invalid frozen commit");
      }
      return { ...entry, baseCommit };
    } catch (error) {
      throw usageError(
        `Cannot freeze Candidate workspace ${workspace.owner.taskId}: ${
          entry.projectId
       }; ${error instanceof Error ? error.message : String(error)}.`
      );
    }
  });
  return validateManagedWorkspace({
    ...workspace,
    entries,
    updatedAt: now.toISOString()
  });
}

function chronologicalReviewRounds(rounds: ReviewRound[]): ReviewRound[] {
  return [...rounds].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id, undefined, {numeric: true})
  ));
}

function activeReviewRoundForCandidate(
  store: TaskWorkflowStore,
  item: WorkItem,
  candidate: WorkItemCandidate
): ReviewRound | undefined {
  return chronologicalReviewRounds(store.listReviewRounds(item.taskId)
    .filter((round) => round.candidateId === candidate.id
      && (round.status === "pending" || round.status === "running")))
    .at(-1);
}

function createTaskRole(
  store: TaskWorkflowStore,
  task: Task,
  roleName: string,
  explicitAgentId: string | undefined,
  now: Date,
  sourceGlobalRoleName?: string
): Role {
  const workspace = task.cwd ?? store.getConfig().defaultWorkspace ?? process.cwd();
  if (explicitAgentId === undefined) {
    const sourceRoleName = sourceGlobalRoleName
      ?? (roleName === LEADER_ROLE ? LEADER_ROLE : "worker");
    const globalRole = store.getGlobalRole(sourceRoleName);
    if (globalRole !== null) {
      const copied = copyGlobalRoleToTaskRole(globalRole, task.id, now, roleName);
      return copied.workspace === workspace ? copied : updateRole(copied, { workspace }, now);
    }
    if (roleName !== LEADER_ROLE) {
      throw dataError(`Global Role ${sourceRoleName} is not configured for Task role: ${roleName}.`);
    }
  }
  const agentId = explicitAgentId?.trim() || store.getConfig().defaultAgent;
  if (agentId === undefined) {
    throw dataError(`No Agent is configured for Task role: ${roleName}.`);
  }
  const agent = requireAgent(store, agentId);
  const binding = createRoleAgentBinding({ id: agent.id, adapterId: agent.adapterId });
  return createRole(task.id, roleName, [binding], agent.id, workspace, now);
}

function requireAgentProfile(store: TaskWorkflowStore, id: string): AgentProfile {
  const profile = store.getAgentProfile(id);
  if (profile === null) throw usageError(`Agent Profile not found: ${id}.`);
  return profile;
}

function workerProfileRolePatch(profile: AgentProfile) {
  return {
    description: profile.description,
    systemPrompt: profile.instructions,
    skills: profile.skills === undefined ? undefined : [...profile.skills],
    constraints: profile.defaultAccess === "read"
      ? ["Do not modify files or external state."]
      : undefined
  };
}

function appendMessage(
  store: TaskWorkflowStore,
  taskId: string,
  body: string,
  kind: TaskMessageKind,
  author: TaskMessageAuthor,
  now: Date,
  context: TaskMessageContext = {}
): TaskMessage {
  const message = createTaskMessage(store.nextMessageId(taskId), body, kind, author, now, context);
  store.saveMessage(taskId, message);
  recordTaskEvent(store, taskId, "message.sent", { messageId: message.id, kind: message.kind }, now);
  return message;
}

function recordTaskEvent(
  store: TaskWorkflowStore,
  taskId: string,
  type: string,
  payload: TaskEventPayload,
  now: Date
): void {
  store.saveEvent(taskId, createTaskEvent(store.nextEventId(taskId), type, payload, now));
}

function requireTask(store: TaskWorkflowStore, taskId: string | undefined): Task {
  const id = requiredText(taskId, "Task id");
  const task = store.getTask(id);
  if (task === null) throw taskNotFound(id);
  return task;
}

function requireRole(store: TaskWorkflowStore, taskId: string, roleName: string | undefined): Role {
  const name = requiredText(roleName, "Role name");
  const role = store.getRole(taskId, name);
  if (role === null) throw roleNotFound(name);
  return role;
}

function requireProject(store: TaskWorkflowStore, projectId: string): Project {
  const project = store.getProject(projectId);
  if (project === null) throw usageError(`Project not found: ${projectId}.`);
  return project;
}

function requireAgent(store: TaskWorkflowStore, agentId: string | undefined): ConfiguredAgent {
  const id = requiredText(agentId, "Agent id");
  const agent = store.getConfiguredAgent(id);
  if (agent === null) throw usageError(`Agent not found: ${id}.`);
  return agent;
}

function requireWorkItem(store: TaskWorkflowStore, workItemId: string | undefined): WorkItem {
  const id = requiredText(workItemId, "Work item id");
  const item = store.findWorkItem(id);
  if (item === null) throw usageError(`Work item not found: ${id}.`);
  return item;
}

function requireRun(store: TaskWorkflowStore, runId: string | undefined): AgentRun {
  const id = requiredText(runId, "Run id");
  const run = store.findAgentRun(id);
  if (run === null) throw usageError(`Run not found: ${id}.`);
  return run;
}

function assertWorkItemDependenciesCompleted(
  store: TaskWorkflowStore,
  item: WorkItem
): void {
  for (const dependencyId of item.dependsOn) {
    const dependency = requireWorkItem(store, dependencyId);
    if (dependency.taskId !== item.taskId || dependency.status !== "completed") {
      throw usageError(`Work Item dependency is not completed: ${dependencyId}.`);
    }
  }
}

function chronologicalAgentRuns(runs: readonly AgentRun[]): AgentRun[] {
  return [...runs].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id)
  ));
}

function agentRunSnapshot(role: Role): NonNullable<
  NonNullable<Parameters<typeof createAgentRun>[6]>["agent"]
> {
  const binding = activeRoleAgentBinding(role);
  return {
    agentId: binding.agentId,
    adapterId: binding.adapterId,
    ...(binding.config.model === undefined ? {} : { model: binding.config.model }),
    ...(binding.config.effort === undefined ? {} : { effort: binding.config.effort })
  };
}

function isTerminalWorkItemStatus(status: WorkItemStatus): boolean {
  return ["completed", "failed", "cancelled", "superseded"].includes(status);
}

function assertTaskOpen(task: Task): void {
  if (task.status === "completed") {
    throw usageError(`Task ${task.id} is completed; reopen it before continuing.`);
  }
  if (task.status === "archived") throw usageError(`Task is archived: ${task.id}.`);
}

function taskActor(options: TaskCommandOptions, taskId: string) {
  return resolveTaskActor(options.environment, taskId);
}

function inactiveTaskMessage(task: Task, action: string): string {
  if (task.status === "draft") {
    return `Task ${task.id} is a Draft; activate it before ${action}.`;
  }
  if (task.status === "completed") {
    return `Task ${task.id} is completed; reopen it before ${action}.`;
  }
  return `Task is archived: ${task.id}.`;
}

function requireRuntime(options: TaskCommandOptions): TaskWorkflowRuntimePort {
  if (options.runtime === undefined) throw runtimeError("Task workflow runtime is not configured.");
  return options.runtime;
}

function parseWorkStatus(value: string): WorkItemStatus {
  if (value === "todo") return "pending";
  if (value === "running") return "running";
  if (value === "done") return "completed";
  if (value === "failed") return "failed";
  if (value === "cancelled") return "cancelled";
  if (value === "superseded") return "superseded";
  throw usageError(`Invalid work item status: ${value}.`);
}

function presentWorkStatus(status: WorkItemStatus): string {
  if (status === "pending") return "todo";
  if (status === "completed") return "done";
  return status;
}

function parseWorkCreateArgs(
  args: readonly string[],
  usage: string
): Readonly<{
  positionals: string[];
  objective?: string;
  acceptance: string[];
  after: string[];
  projects: string[];
  role?: string;
}> {
  const positionals: string[] = [];
  const acceptance: string[] = [];
  const after: string[] = [];
  const projects: string[] = [];
  let objective: string | undefined;
  let role: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (
      argument !== "--objective"
      && argument !== "--accept"
      && argument !== "--after"
      && argument !== "--project"
      && argument !== "--role"
    ) {
      throw usageError(`Unsupported option: ${argument}.`, usage);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw usageError(`${argument} is required.`, usage);
    }
    if (argument === "--objective") {
      if (objective !== undefined) throw usageError("--objective may only be specified once.", usage);
      objective = value;
    } else if (argument === "--role") {
      if (role !== undefined) throw usageError("--role may only be specified once.", usage);
      role = value;
    } else if (argument === "--accept") acceptance.push(value);
    else if (argument === "--after") after.push(value);
    else if (argument === "--project") projects.push(value);
    index += 1;
  }
  return {
    positionals,
    ...(objective === undefined ? {} : { objective }),
    ...(role === undefined ? {} : { role }),
    acceptance,
    after,
    projects
  };
}

function parseTaskPriority(value: string): TaskPriority {
  if (["low", "medium", "high", "urgent"].includes(value)) return value as TaskPriority;
  throw usageError(`Invalid Task priority: ${value}.`);
}

function parseTaskTags(value: string): string[] {
  const tags = [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
  if (tags.length === 0) throw usageError("--tags must contain at least one tag.");
  return tags;
}

function parseIsoTimestamp(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw usageError(`${label} must be an ISO/RFC 3339 timestamp with a timezone.`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw usageError(`${label} must be an ISO/RFC 3339 timestamp with a timezone.`);
  }
  return timestamp.toISOString();
}

function taskBriefCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "show") {
    exactPositionals(rest, 1, "Task brief show usage: yui task brief show <task>.");
    const task = requireTask(store, rest[0]);
    const brief = store.getTaskBrief(task.id);
    if (brief === null) {
      return output(`Task ${task.id} has no brief.\n`, { taskId: task.id, brief: null });
    }
    const timeZone = store.getConfig().timeZone;
    return output([
      `Task: ${task.id}`,
      `Objective: ${brief.objective}`,
      `Boundaries:`,
      ...(brief.boundaries.length === 0 ? ["  (none)"] : brief.boundaries.map((b) => `  - ${b}`)),
      `Technical approach: ${brief.technicalApproach || "(not defined)"}`,
      `Current focus: ${brief.currentFocus}`,
      `Leader summary: ${brief.leaderSummary}`,
      `Updated by: ${brief.updatedBy}`,
      `Updated at: ${presentTime(brief.updatedAt, timeZone)}`
    ].join("\n").concat("\n"), { taskId: task.id, brief });
  }
  if (command === "update") {
    const usage = "Task brief update usage: yui task brief update <task> [--objective <text>] [--boundary <text> ...] [--approach <text>] [--focus <text>] [--leader-summary <text>].";
    const parsed = parseMultiValueTail(
      rest,
      new Set(["--objective", "--approach", "--focus", "--leader-summary"]),
      new Set(["--boundary"]),
      usage
    );
    exactPositionals(parsed.positionals, 1, usage);
    const hasObjective = parsed.options.has("--objective");
    const hasApproach = parsed.options.has("--approach");
    const hasFocus = parsed.options.has("--focus");
    const hasSummary = parsed.options.has("--leader-summary");
    const boundaries = parsed.multiOptions.get("--boundary") ?? [];
    if (!hasObjective && !hasApproach && !hasFocus && !hasSummary && boundaries.length === 0) {
      throw usageError("At least one brief field is required.", usage);
    }
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      assertTaskOpen(task);
      const existing = tx.getTaskBrief(task.id);
      const updatedBy = taskActor(options, task.id);
      const brief = existing === null
        ? createTaskBrief({
            objective: requiredText(parsed.options.get("--objective"), "--objective"),
            boundaries,
            ...(hasApproach
              ? { technicalApproach: requiredText(
                  parsed.options.get("--approach"),
                  "--approach"
                ) }
              : {}),
            currentFocus: requiredText(parsed.options.get("--focus"), "--focus"),
            leaderSummary: requiredText(parsed.options.get("--leader-summary"), "--leader-summary"),
            updatedBy
          }, now)
        : updateTaskBrief(existing, {
            ...(hasObjective ? { objective: parsed.options.get("--objective") } : {}),
            ...(boundaries.length > 0 ? { boundaries } : {}),
            ...(hasApproach
              ? { technicalApproach: parsed.options.get("--approach") }
              : {}),
            ...(hasFocus ? { currentFocus: parsed.options.get("--focus") } : {}),
            ...(hasSummary ? { leaderSummary: parsed.options.get("--leader-summary") } : {})
          }, updatedBy, now);
      tx.saveTaskBrief(task.id, brief);
      recordTaskEvent(tx, task.id, "brief.updated", { updatedBy }, now);
      enqueueWork(tx, taskMailbox(task.id), "brief-updated", now, [taskRef(task.id)]);
      if (task.status === "active" && updatedBy !== "leader") {
        enqueueWork(tx, leaderMailbox(task.id), "brief-updated", now, [taskRef(task.id)]);
      }
      return { task, brief };
    });
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
    if (result.task.status === "active") {
      notifyMailbox(options.runtime, leaderMailbox(result.task.id), result.task.id);
    }
    return output(`Updated brief for ${result.task.id}\n`);
  }
  throw usageError(command === undefined
    ? "Task brief command is required."
    : `Unknown command: task brief ${command}`);
}

function taskDecisionCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "record") {
    const usage = "Task decision record usage: yui task decision record <task> --title <text> --rationale <text>.";
    const parsed = parseTail(rest, new Set(["--title", "--rationale"]), usage);
    exactPositionals(parsed.positionals, 1, usage);
    const title = requiredOption(parsed.options, "--title");
    const rationale = requiredOption(parsed.options, "--rationale");
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      assertTaskOpen(task);
      const actor = taskActor(options, task.id);
      const decision = createDecision(tx.nextDecisionId(task.id), task.id, title, rationale, now);
      tx.saveDecision(task.id, decision);
      recordTaskEvent(tx, task.id, "decision.recorded", { decisionId: decision.id, title }, now);
      enqueueWork(tx, taskMailbox(task.id), "decision-recorded", now, [taskRef(task.id)]);
      if (task.status === "active" && actor !== "leader") {
        enqueueWork(tx, leaderMailbox(task.id), "decision-recorded", now, [taskRef(task.id)]);
      }
      return { task, decision };
    });
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
    if (result.task.status === "active") notifyMailbox(options.runtime, leaderMailbox(result.task.id), result.task.id);
    return output(`Recorded decision ${result.decision.id} for ${result.task.id}\n`);
  }
  if (command === "list") {
    const usage = "Task decision list usage: yui task decision list <task> [--status active|superseded].";
    const parsed = parseTail(rest, new Set(["--status"]), usage);
    exactPositionals(parsed.positionals, 1, usage);
    const task = requireTask(store, parsed.positionals[0]);
    let decisions = store.listDecisions(task.id);
    const status = parsed.options.get("--status");
    if (status !== undefined) {
      if (status !== "active" && status !== "superseded") {
        throw usageError("--status must be active or superseded.", usage);
      }
      decisions = decisions.filter((d) => d.status === status);
    }
    if (decisions.length === 0) {
      return output(`No decisions found for ${task.id}.\n`, { taskId: task.id, decisions: [] });
    }
    const timeZone = store.getConfig().timeZone;
    return output(`${renderTable(
      `Decisions: ${task.id}`,
      [
        { header: "Decision", minWidth: 8, maxWidth: 18 },
        { header: "Status", minWidth: 6, maxWidth: 12 },
        { header: "Title", minWidth: 8, maxWidth: 64 },
        { header: "Created", minWidth: 10, maxWidth: 28 }
      ],
      decisions.map((d) => [d.id, d.status, d.title, presentTime(d.createdAt, timeZone)]),
      defaultTableWidth()
    )}\n`, { taskId: task.id, decisions });
  }
  if (command === "show") {
    exactPositionals(rest, 2, "Task decision show usage: yui task decision show <task> <decision>.");
    const task = requireTask(store, rest[0]);
    const decision = store.getDecision(task.id, rest[1]);
    if (decision === null) throw dataError(`Decision not found: ${rest[1]}.`);
    const timeZone = store.getConfig().timeZone;
    return output([
      `Decision: ${decision.id}`,
      `Task: ${task.id}`,
      `Title: ${decision.title}`,
      `Rationale: ${decision.rationale}`,
      `Status: ${decision.status}`,
      ...(decision.supersededReason === undefined ? [] : [`Superseded reason: ${decision.supersededReason}`]),
      ...(decision.supersededAt === undefined ? [] : [`Superseded at: ${presentTime(decision.supersededAt, timeZone)}`]),
      `Created: ${presentTime(decision.createdAt, timeZone)}`,
      `Updated: ${presentTime(decision.updatedAt, timeZone)}`
    ].join("\n").concat("\n"), { taskId: task.id, decision });
  }
  if (command === "supersede") {
    const usage = "Task decision supersede usage: yui task decision supersede <task> <decision> --reason <text>.";
    const parsed = parseTail(rest, new Set(["--reason"]), usage);
    exactPositionals(parsed.positionals, 2, usage);
    const reason = requiredOption(parsed.options, "--reason");
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      assertTaskOpen(task);
      const actor = taskActor(options, task.id);
      const existing = tx.getDecision(task.id, parsed.positionals[1]);
      if (existing === null) throw dataError(`Decision not found: ${parsed.positionals[1]}.`);
      const decision = supersedeDecision(existing, reason, now);
      tx.saveDecision(task.id, decision);
      recordTaskEvent(tx, task.id, "decision.superseded", { decisionId: decision.id, reason }, now);
      enqueueWork(tx, taskMailbox(task.id), "decision-superseded", now, [taskRef(task.id)]);
      if (task.status === "active" && actor !== "leader") {
        enqueueWork(tx, leaderMailbox(task.id), "decision-superseded", now, [taskRef(task.id)]);
      }
      return { task, decision };
    });
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
    if (result.task.status === "active") notifyMailbox(options.runtime, leaderMailbox(result.task.id), result.task.id);
    return output(`Superseded decision ${result.decision.id} for ${result.task.id}\n`);
  }
  throw usageError(command === undefined
    ? "Task decision command is required."
    : `Unknown command: task decision ${command}`);
}

function taskMilestoneCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "add") {
    const usage = "Task milestone add usage: yui task milestone add <task> --title <text> --summary <text>.";
    const parsed = parseTail(rest, new Set(["--title", "--summary"]), usage);
    exactPositionals(parsed.positionals, 1, usage);
    const title = requiredOption(parsed.options, "--title");
    const summary = requiredOption(parsed.options, "--summary");
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, parsed.positionals[0]);
      assertTaskOpen(task);
      if (taskActor(options, task.id) !== "leader") {
        throw usageError("Only the Task Leader can add a Milestone.");
      }
      const milestone = createMilestone(tx.nextMilestoneId(task.id), task.id, title, summary, now);
      tx.saveMilestone(task.id, milestone);
      recordTaskEvent(tx, task.id, "milestone.added", { milestoneId: milestone.id, title }, now);
      enqueueWork(tx, taskMailbox(task.id), "milestone-added", now, [taskRef(task.id)]);
      return { task, milestone };
    });
    notifyMailbox(options.runtime, taskMailbox(result.task.id), result.task.id);
    return output(`Added milestone ${result.milestone.id} for ${result.task.id}\n`);
  }
  if (command === "list") {
    exactPositionals(rest, 1, "Task milestone list usage: yui task milestone list <task>.");
    const task = requireTask(store, rest[0]);
    const milestones = store.listMilestones(task.id);
    if (milestones.length === 0) {
      return output(`No milestones found for ${task.id}.\n`, { taskId: task.id, milestones: [] });
    }
    const timeZone = store.getConfig().timeZone;
    return output(`${renderTable(
      `Milestones: ${task.id}`,
      [
        { header: "Milestone", minWidth: 9, maxWidth: 18 },
        { header: "Title", minWidth: 8, maxWidth: 64 },
        { header: "Created", minWidth: 10, maxWidth: 28 }
      ],
      milestones.map((m) => [m.id, m.title, presentTime(m.createdAt, timeZone)]),
      defaultTableWidth()
    )}\n`, { taskId: task.id, milestones });
  }
  if (command === "show") {
    exactPositionals(rest, 2, "Task milestone show usage: yui task milestone show <task> <milestone>.");
    const task = requireTask(store, rest[0]);
    const milestone = store.getMilestone(task.id, rest[1]);
    if (milestone === null) throw dataError(`Milestone not found: ${rest[1]}.`);
    const timeZone = store.getConfig().timeZone;
    return output([
      `Milestone: ${milestone.id}`,
      `Task: ${task.id}`,
      `Title: ${milestone.title}`,
      `Summary: ${milestone.summary}`,
      `Created by: ${milestone.createdBy}`,
      `Created: ${presentTime(milestone.createdAt, timeZone)}`
    ].join("\n").concat("\n"), { taskId: task.id, milestone });
  }
  throw usageError(command === undefined
    ? "Task milestone command is required."
    : `Unknown command: task milestone ${command}`);
}

function taskEventCommand(
  args: string[],
  store: TaskWorkflowStore
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command === "list") {
    exactPositionals(rest, 1, "Task event list usage: yui task event list <task>.");
    const task = requireTask(store, rest[0]);
    const events = store.listEvents(task.id);
    if (events.length === 0) {
      return output(`No events found for ${task.id}.\n`, { taskId: task.id, events: [] });
    }
    const timeZone = store.getConfig().timeZone;
    return output(`${renderTable(
      `Events: ${task.id}`,
      [
        { header: "Event", minWidth: 8, maxWidth: 18 },
        { header: "Type", minWidth: 8, maxWidth: 28 },
        { header: "Created", minWidth: 10, maxWidth: 28 }
      ],
      events.map((e) => [e.id, e.type, presentTime(e.createdAt, timeZone)]),
      defaultTableWidth()
    )}\n`, { taskId: task.id, events });
  }
  if (command === "show") {
    exactPositionals(rest, 2, "Task event show usage: yui task event show <task> <event>.");
    const task = requireTask(store, rest[0]);
    const events = store.listEvents(task.id);
    const event = events.find((e) => e.id === rest[1]) ?? null;
    if (event === null) throw dataError(`Event not found: ${rest[1]}.`);
    const timeZone = store.getConfig().timeZone;
    return output([
      `Event: ${event.id}`,
      `Task: ${task.id}`,
      `Type: ${event.type}`,
      `Created: ${presentTime(event.createdAt, timeZone)}`,
      `Payload:`,
      ...(Object.keys(event.payload).length === 0
        ? ["  (none)"]
        : Object.entries(event.payload).map(([k, v]) => `  ${k}: ${v}`))
    ].join("\n").concat("\n"), { taskId: task.id, event });
  }
  throw usageError(command === undefined
    ? "Task event command is required."
    : `Unknown command: task event ${command}`);
}

type ParsedMultiTail = Readonly<{
  positionals: string[];
  options: ReadonlyMap<string, string>;
  multiOptions: ReadonlyMap<string, string[]>;
}>;

function parseMultiValueTail(
  args: string[],
  valueOptions: ReadonlySet<string>,
  repeatOptions: ReadonlySet<string>,
  usage: string,
  flagOptions: ReadonlySet<string> = new Set()
): ParsedMultiTail {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const multiOptions = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!valueOptions.has(value) && !repeatOptions.has(value) && !flagOptions.has(value)) {
      throw usageError(`Unsupported option: ${value}.`, usage);
    }
    if (flagOptions.has(value)) {
      if (options.has(value)) throw usageError(`Option may only be specified once: ${value}.`, usage);
      options.set(value, "");
      continue;
    }
    if (repeatOptions.has(value)) {
      const optionValue = args[index + 1];
      if (optionValue === undefined || optionValue.startsWith("--")) {
        throw usageError(`${value} is required.`, usage);
      }
      const existing = multiOptions.get(value) ?? [];
      multiOptions.set(value, [...existing, optionValue]);
      index += 1;
      continue;
    }
    if (options.has(value)) throw usageError(`Option may only be specified once: ${value}.`, usage);
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw usageError(`${value} is required.`, usage);
    }
    options.set(value, optionValue);
    index += 1;
  }
  return { positionals, options, multiOptions };
}

type ParsedTail = Readonly<{
  positionals: string[];
  options: ReadonlyMap<string, string>;
}>;

function parseTail(
  args: string[],
  valueOptions: ReadonlySet<string>,
  usage: string,
  flagOptions: ReadonlySet<string> = new Set()
): ParsedTail {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!valueOptions.has(value) && !flagOptions.has(value)) {
      throw usageError(`Unsupported option: ${value}.`, usage);
    }
    if (options.has(value)) throw usageError(`Option may only be specified once: ${value}.`, usage);
    if (flagOptions.has(value)) {
      options.set(value, "");
      continue;
    }
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw usageError(`${value} is required.`, usage);
    }
    options.set(value, optionValue);
    index += 1;
  }
  return { positionals, options };
}

function requiredOption(options: ReadonlyMap<string, string>, name: string): string {
  return requiredText(options.get(name), name);
}

function optionalNonEmptyOption(
  options: ReadonlyMap<string, string>,
  name: string
): string | undefined {
  if (!options.has(name)) return undefined;
  return requiredText(options.get(name), name);
}

function exactPositionals(values: readonly string[], count: number, usage: string): void {
  if (values.length !== count || values.some((value) => value.trim().length === 0)) {
    throw usageError(usage);
  }
}

function assertNoArguments(args: readonly string[], usage: string): void {
  if (args.length > 0) throw usageError(usage);
}

function requiredText(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) throw usageError(`${label} is required.`);
  return normalized;
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function titleFrom(body: string): string {
  const oneLine = requiredText(body, "Message body").replace(/\s+/g, " ");
  return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 77)}...`;
}

function presentTime(value: string, timeZone: string | undefined): string {
  return formatTimestamp(value, timeZone);
}

function output(value: string, data?: unknown): TaskCommandExecution {
  return data === undefined
    ? { kind: "output", output: value }
    : { kind: "output", output: value, data };
}

function clock(options: TaskCommandOptions): Date {
  return options.now?.() ?? new Date();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function taskMailbox(taskId: string): MailboxTarget {
  return { kind: "task", taskId };
}

function roleMailbox(taskId: string, roleName: string): MailboxTarget {
  return { kind: "role", taskId, roleName };
}

function leaderMailbox(taskId: string): MailboxTarget {
  return roleMailbox(taskId, LEADER_ROLE);
}

function taskRef(id: string): MailboxEntityRef {
  return { type: "task", id };
}

function runRef(id: string): MailboxEntityRef {
  return { type: "run", id };
}

function workItemRef(id: string): MailboxEntityRef {
  return { type: "work-item", id };
}

function messageRef(id: string): MailboxEntityRef {
  return { type: "message", id };
}

function notifyMailbox(
  runtime: TaskWorkflowRuntimePort | undefined,
  target: MailboxTarget,
  compatibilityTaskId: string
): void {
  if (runtime?.notifyMailboxChanged !== undefined) {
    runtime.notifyMailboxChanged(target);
  } else {
    runtime?.notifyStateChanged(compatibilityTaskId);
  }
}
