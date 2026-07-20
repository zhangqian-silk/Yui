import type { ConfiguredAgent } from "../agent/agent.js";
import { createTaskComment, type TaskComment } from "../comment/comment.js";
import { compileDispatchInput } from "../context/dispatchContext.js";
import {
  dataError,
  roleNotFound,
  runtimeError,
  taskNotFound,
  usageError
} from "../errors/cliError.js";
import {
  createRoleSessionSet,
  roleAgentSessionResumeMode,
  updateRoleAgentSessionStatus,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { activeRoleSummary, renderRoleDetails } from "../output/rolePresentation.js";
import {
  copyGlobalRoleToTaskRole,
  createRole,
  createRoleAgentBinding,
  switchActiveRoleAgent,
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
import { queueLeaderWakeup, queueLeaderWakeupAfterYield } from "../scheduler/wakeupQueue.js";
import {
  activateTask,
  archiveTask,
  createTask,
  type Task,
  type TaskMetadata
} from "../task/task.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  createWorkItem,
  updateWorkItemStatus,
  type WorkItem,
  type WorkItemStatus
} from "../workItem/workItem.js";
import {
  hasAgentConfigOptions,
  parseRoleOptions,
  patchRoleAgentBinding,
  roleOptionSpecs,
  roleProfilePatch
} from "./roleConfiguration.js";

const LEADER_ROLE = "leader";

export type TaskCommandExecution =
  | Readonly<{ kind: "output"; output: string }>
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
  reconcileTask(taskId: string): void;
  prepareTaskRoleEnter(input: Readonly<{ taskId: string; roleName: string }>): void;
}>;

export type TaskWorkflowStore = TaskStore;

export type TaskCommandOptions = Readonly<{
  runtime?: TaskWorkflowRuntimePort;
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
}>;

export function runTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {}
): TaskCommandExecution {
  const [command, ...rest] = args;
  switch (command) {
    case "create": return output(createTaskCommand(rest, store, options));
    case "list": return output(listTaskCommand(rest, store));
    case "show": return output(showTaskCommand(rest, store));
    case "activate": return output(activateTaskCommand(rest, store, options));
    case "archive": return output(archiveTaskCommand(rest, store, options));
    case "reconcile": return output(reconcileTaskCommand(rest, store, options));
    case "message": return output(taskMessageCommand(rest, store, options));
    case "role": return taskRoleCommand(rest, store, options);
    case "work": return output(taskWorkCommand(rest, store, options));
    case "run": return output(taskRunCommand(rest, store, options));
    case "enter": return enterTaskRoleAlias(rest, store, options);
    default:
      throw usageError(command === undefined
        ? "Task command is required."
        : `Unknown command: task ${command}`);
  }
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
      const comment = appendMessage(tx, task.id, body, "operator", now);
      if (task.status === "active") {
        queueLeaderWakeup(tx, task.id, "operator-input", now);
      }
      return { task, comment, created: false } as const;
    }

    const created = createTaskAggregate(tx, titleFrom(body), {}, now);
    const comment = appendMessage(tx, created.task.id, body, "operator", now);
    return { ...created, comment, created: true } as const;
  });
  options.runtime?.notifyStateChanged(result.task.id);
  return result.created
    ? `Created Draft task ${result.task.id}: ${result.task.title}\nSubmitted message ${result.comment.id}\n`
    : `Submitted message ${result.comment.id} to ${result.task.id}\n`;
}

function createTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task create usage: taskmux task create <title> [--repository <id>] [--base <ref>].";
  const parsed = parseTail(args, new Set(["--repository", "--base"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const repositoryId = optionalNonEmptyOption(parsed.options, "--repository");
  const baseRef = optionalNonEmptyOption(parsed.options, "--base");
  if (baseRef !== undefined && repositoryId === undefined) {
    throw usageError("--base requires --repository.");
  }
  if (repositoryId !== undefined && store.getRepository(repositoryId) === null) {
    throw usageError(`Repository not found: ${repositoryId}.`);
  }
  const now = clock(options);
  const created = store.transaction((tx) => createTaskAggregate(tx, parsed.positionals[0], {
    ...(repositoryId === undefined ? {} : { repositoryId }),
    ...(baseRef === undefined ? {} : { baseRef })
  }, now));
  options.runtime?.notifyStateChanged(created.task.id);
  return `Created Draft task ${created.task.id}: ${created.task.title}\nAssigned role: ${created.leader.name}\n`;
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
  return { task, leader };
}

function listTaskCommand(args: string[], store: TaskWorkflowStore): string {
  assertNoArguments(args, "Task list usage: taskmux task list.");
  const tasks = store.listTasks();
  if (tasks.length === 0) return "No tasks found.\n";
  return `${renderTable(
    "Tasks",
    [
      { header: "Task", minWidth: 6, maxWidth: 20 },
      { header: "Status", minWidth: 6, maxWidth: 10 },
      { header: "Title", minWidth: 8, maxWidth: 64 },
      { header: "Repository", minWidth: 10, maxWidth: 24 }
    ],
    tasks.map((task) => [task.id, task.status, task.title, task.repositoryId ?? "-"]),
    defaultTableWidth()
  )}\n`;
}

function showTaskCommand(args: string[], store: TaskWorkflowStore): string {
  const [taskId] = args;
  exactPositionals(args, 1, "Task show usage: taskmux task show <id>.");
  const task = requireTask(store, taskId);
  const roles = store.listRoles(task.id);
  const comments = store.listComments(task.id);
  const work = store.listWorkItems(task.id);
  const runs = store.listAgentRuns(task.id);
  return [
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Status: ${task.status}`,
    ...(task.repositoryId === undefined ? [] : [`Repository: ${task.repositoryId}`]),
    ...(task.baseRef === undefined ? [] : [`Base: ${task.baseRef}`]),
    ...(task.cwd === undefined ? [] : [`Workspace: ${task.cwd}`]),
    `Roles: ${roles.length}`,
    `Messages: ${comments.length}`,
    `Work items: ${work.length}`,
    `Runs: ${runs.length}`,
    `Created: ${task.createdAt}`,
    `Updated: ${task.updatedAt}`
  ].join("\n").concat("\n");
}

function activateTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 1, "Task activate usage: taskmux task activate <task>.");
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, args[0]);
    if (task.status === "archived") throw usageError(`Task is archived: ${task.id}.`);
    if (task.status === "active") return { task, changed: false } as const;
    const active = activateTask(task, now);
    tx.saveTask(active);
    // Repository-backed Tasks keep this durable wake pending until the
    // Controller has prepared and recorded the Task workspace.
    queueLeaderWakeup(tx, task.id, "task-created", now);
    return { task: active, changed: true } as const;
  });
  if (result.changed) options.runtime?.notifyStateChanged(result.task.id);
  return result.changed
    ? `Activated task ${result.task.id}\n`
    : `Task ${result.task.id} is already active\n`;
}

function archiveTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 1, "Task archive usage: taskmux task archive <id>.");
  const now = clock(options);
  const actor = options.environment?.TASKMUX_ROLE === "leader"
    ? "leader"
    : options.environment?.TASKMUX_ROLE === "operator" ? "operator" : "user";
  const result = store.transaction((tx) => {
    const task = requireTask(tx, args[0]);
    if (task.status === "archived") return { task, changed: false } as const;
    const archived = archiveTask(task, now, { by: actor });
    tx.saveTask(archived);
    tx.clearPendingWakeup(task.id);
    for (const role of tx.listRoles(task.id)) {
      const activeRun = tx.getActiveAgentRun(task.id, role.name);
      if (activeRun === null) continue;
      const failed = failAgentRun(activeRun, "Task archived.", now);
      tx.saveAgentRun(failed);
      tx.clearActiveAgentRun(task.id, role.name);
      tx.saveRole(task.id, updateRoleStatus(role, "idle", now));
      if (failed.workItemId !== undefined) {
        const item = tx.getWorkItem(task.id, failed.workItemId);
        if (item !== null && item.status === "running") {
          tx.saveWorkItem(task.id, updateWorkItemStatus(item, "failed", "Task archived.", now));
        }
      }
    }
    return { task: archived, changed: true } as const;
  });
  if (result.changed) options.runtime?.notifyStateChanged(result.task.id);
  return result.changed
    ? `Archived task ${result.task.id}\n`
    : `Task ${result.task.id} is already archived\n`;
}

function reconcileTaskCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 1, "Task reconcile usage: taskmux task reconcile <task>.");
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
    exactPositionals(rest, 2, "Task message send usage: taskmux task message send <id> <body>.");
    const now = clock(options);
    const result = store.transaction((tx) => {
      const task = requireTask(tx, rest[0]);
      assertTaskOpen(task);
      const comment = appendMessage(tx, task.id, rest[1], "user", now);
      if (task.status === "active") queueLeaderWakeup(tx, task.id, "user-comment", now);
      return { task, comment };
    });
    options.runtime?.notifyStateChanged(result.task.id);
    return `Sent message ${result.comment.id} to ${result.task.id}\n`;
  }
  if (command === "list") {
    exactPositionals(rest, 1, "Task message list usage: taskmux task message list <id>.");
    const task = requireTask(store, rest[0]);
    const comments = store.listComments(task.id);
    if (comments.length === 0) return "No messages found.\n";
    return `${renderTable(
      `Task messages: ${task.id}`,
      [
        { header: "Message", minWidth: 7, maxWidth: 18 },
        { header: "Author", minWidth: 6, maxWidth: 18 },
        { header: "Created", minWidth: 10, maxWidth: 28 },
        { header: "Body", minWidth: 8, maxWidth: 72 }
      ],
      comments.map((comment) => [comment.id, comment.author ?? "-", comment.createdAt, comment.body]),
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
  if (command === "list") return output(listTaskRoles(rest, store));
  if (command === "show") return output(showTaskRole(rest, store));
  if (command === "update") return output(updateTaskRole(rest, store, options));
  if (command === "remove") return output(removeTaskRole(rest, store, options));
  if (command === "bind") return output(bindTaskRole(rest, store, options));
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
  const usage = "Task role add usage: taskmux task role add <task> <name> [Role and Agent settings].";
  const [taskId, roleName, ...tail] = args;
  if (taskId === undefined || roleName === undefined || taskId.startsWith("--") || roleName.startsWith("--")) {
    throw usageError("Task id and Role name are required.", usage);
  }
  const parsed = parseRoleOptions(tail, roleOptionSpecs({ update: false, includeAgent: true }), usage);
  const agentId = parsed.one("--agent")?.trim();
  if (parsed.has("--agent") && (agentId === undefined || agentId.length === 0)) {
    throw usageError("--agent is required.", usage);
  }
  const now = clock(options);
  const role = store.transaction((tx) => {
    const task = requireTask(tx, taskId);
    assertTaskOpen(task);
    if (roleName === LEADER_ROLE) throw usageError("The Task leader role already exists.");
    if (tx.getRole(task.id, roleName) !== null) throw usageError(`Role already exists: ${roleName}.`);
    let created = createTaskRole(tx, task, roleName, agentId, now);
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
    tx.saveRole(task.id, created);
    return created;
  });
  options.runtime?.notifyStateChanged(role.taskId);
  return `Added role ${role.name} to ${role.taskId} (Agent: ${role.activeAgentId})\n`;
}

function listTaskRoles(args: string[], store: TaskWorkflowStore): string {
  exactPositionals(args, 1, "Task role list usage: taskmux task role list <task>.");
  const task = requireTask(store, args[0]);
  const roles = store.listRoles(task.id);
  if (roles.length === 0) return "No roles assigned.\n";
  return `${renderTable(
    `Task roles: ${task.id}`,
    [
      { header: "Role", minWidth: 4, maxWidth: 24 },
      { header: "Active Agent", minWidth: 8, maxWidth: 20 },
      { header: "Model", minWidth: 8, maxWidth: 22 },
      { header: "Effort", minWidth: 8, maxWidth: 14 },
      { header: "Status", minWidth: 6, maxWidth: 12 },
    ],
    roles.map((role) => {
      const summary = activeRoleSummary(role);
      return [role.name, summary.agent, summary.model, summary.effort, role.status];
    }),
    defaultTableWidth()
  )}\n`;
}

function showTaskRole(args: string[], store: TaskWorkflowStore): string {
  exactPositionals(args, 2, "Task role show usage: taskmux task role show <task> <role>.");
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
  const usage = "Task role update usage: taskmux task role update <task> <role> [Role and Agent settings].";
  const [taskId, roleName, ...tail] = args;
  if (taskId === undefined || roleName === undefined || taskId.startsWith("--") || roleName.startsWith("--")) {
    throw usageError("Task id and Role name are required.", usage);
  }
  const parsed = parseRoleOptions(tail, roleOptionSpecs({ update: true, includeAgent: true }), usage);
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
    let bindings = role.agentBindings;
    if (hasAgentConfigOptions(parsed)) {
      const agentId = parsed.one("--agent")?.trim() || role.activeAgentId;
      const agent = requireAgent(tx, agentId);
      const binding = bindings[agentId]
        ?? createRoleAgentBinding({ id: agent.id, adapterId: agent.adapterId });
      const activeSession = tx.getTaskRoleSessionSet(task.id, role.name)?.sessions[agentId];
      if (agentId === role.activeAgentId && (
        tx.getActiveAgentRun(task.id, role.name) !== null || activeSession?.status === "running"
      )) {
        throw usageError("Active Agent settings cannot be changed while its Run or native process is running.");
      }
      bindings = { ...bindings, [agentId]: patchRoleAgentBinding(binding, parsed) };
    }
    const next = updateRole(role, {
      ...(bindings === role.agentBindings ? {} : { agentBindings: bindings }),
      ...roleProfilePatch(parsed)
    }, now);
    tx.saveRole(task.id, next);
    return next;
  });
  options.runtime?.notifyStateChanged(updated.taskId);
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
  exactPositionals(args, 2, "Task role remove usage: taskmux task role remove <task> <role>.");
  const removed = store.transaction((tx) => {
    const task = requireTask(tx, args[0]);
    assertTaskOpen(task);
    const role = requireRole(tx, task.id, args[1]);
    if (role.name === LEADER_ROLE) throw usageError("The Task Leader role cannot be removed.");
    if (tx.getActiveAgentRun(task.id, role.name) !== null) {
      throw usageError(`Task Role has an active Run and cannot be removed: ${task.id}/${role.name}.`);
    }
    const session = tx.getTaskRoleSessionSet(task.id, role.name)?.sessions[role.activeAgentId];
    if (session?.status === "running") {
      throw usageError(`Task Role has a running native Agent and cannot be removed: ${task.id}/${role.name}.`);
    }
    if (!tx.removeTaskRole(task.id, role.name)) throw roleNotFound(role.name);
    return role;
  });
  options.runtime?.notifyStateChanged(removed.taskId);
  return `Removed role ${removed.name} from ${removed.taskId}\n`;
}

function bindTaskRole(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 3, "Task role bind usage: taskmux task role bind <task> <role> <agent-id>.");
  const now = clock(options);
  const result = store.transaction((tx) => {
    const task = requireTask(tx, args[0]);
    assertTaskOpen(task);
    const role = requireRole(tx, task.id, args[1]);
    const agent = requireAgent(tx, args[2]);
    const binding = role.agentBindings[agent.id]
      ?? createRoleAgentBinding({ id: agent.id, adapterId: agent.adapterId });
    const bound = updateRole(role, {
      agentBindings: { ...role.agentBindings, [agent.id]: binding }
    }, now);
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
          nativeProcessRunning: currentSession?.status === "running"
        }, now);
      } catch (error) {
        throw usageError(messageOf(error));
      }
    })();
    tx.saveTaskRoleWithSessionSet(switched.role, switched.sessions);
    return { role: switched.role, mode: switched.mode };
  });
  options.runtime?.notifyStateChanged(result.role.taskId);
  return `Bound ${result.role.taskId}/${result.role.name} to ${result.role.activeAgentId} (${result.mode})\n`;
}

function enterTaskRole(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  exactPositionals(args, 2, "Task role enter usage: taskmux task role enter <task> <role>.");
  const task = requireTask(store, args[0]);
  if (task.status !== "active") {
    throw usageError(task.status === "draft"
      ? `Task ${task.id} is a Draft; activate it before entering a role session.`
      : `Task is archived: ${task.id}.`);
  }
  const role = requireRole(store, task.id, args[1]);
  requireRuntime(options).prepareTaskRoleEnter({ taskId: task.id, roleName: role.name });
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
    throw usageError("Task enter usage: taskmux task enter <task> [role].");
  }
  return enterTaskRole([args[0], args[1] ?? LEADER_ROLE], store, options);
}

function taskWorkCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const [command, ...rest] = args;
  if (command === "create") return createWork(rest, store, options);
  if (command === "list") return listWork(rest, store);
  if (command === "update") return updateWork(rest, store, options);
  if (command === "dispatch") return dispatchWork(rest, store, options);
  throw usageError(command === undefined
    ? "Task work command is required."
    : `Unknown command: task work ${command}`);
}

function createWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task work create usage: taskmux task work create <task> <title> [--role <name>].";
  const parsed = parseTail(args, new Set(["--role"]), usage);
  exactPositionals(parsed.positionals, 2, usage);
  const now = clock(options);
  const item = store.transaction((tx) => {
    const task = requireTask(tx, parsed.positionals[0]);
    assertTaskOpen(task);
    const roleName = parsed.options.get("--role")?.trim() ?? LEADER_ROLE;
    requireRole(tx, task.id, roleName);
    const created = createWorkItem(tx.nextWorkItemId(task.id), task.id, {
      title: parsed.positionals[1],
      assignee: roleName,
      topics: [],
      cycleId: undefined
    }, now);
    tx.saveWorkItem(task.id, created);
    return created;
  });
  options.runtime?.notifyStateChanged(item.taskId);
  return `Created work item ${item.id} for ${item.taskId}\n`;
}

function listWork(args: string[], store: TaskWorkflowStore): string {
  exactPositionals(args, 1, "Task work list usage: taskmux task work list <task>.");
  const task = requireTask(store, args[0]);
  const items = store.listWorkItems(task.id);
  if (items.length === 0) return "No work items found.\n";
  return `${renderTable(
    `Task work: ${task.id}`,
    [
      { header: "Work", minWidth: 6, maxWidth: 20 },
      { header: "Status", minWidth: 6, maxWidth: 12 },
      { header: "Role", minWidth: 4, maxWidth: 22 },
      { header: "Title", minWidth: 8, maxWidth: 64 },
      { header: "Summary", minWidth: 8, maxWidth: 48 }
    ],
    items.map((item) => [item.id, presentWorkStatus(item.status), item.assignee, item.title, item.outcome ?? "-"]),
    defaultTableWidth()
  )}\n`;
}

function updateWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task work update usage: taskmux task work update <id> <todo|running|done|failed> [--summary <text>].";
  const parsed = parseTail(args, new Set(["--summary"]), usage);
  exactPositionals(parsed.positionals, 2, usage);
  const requested = parsed.positionals[1];
  const status = parseWorkStatus(requested);
  const summary = parsed.options.get("--summary");
  if ((status === "completed" || status === "failed") && trimmed(summary) === undefined) {
    throw usageError(`--summary is required when work becomes ${requested}.`);
  }
  const now = clock(options);
  const item = store.transaction((tx) => {
    const current = requireWorkItem(tx, parsed.positionals[0]);
    const task = requireTask(tx, current.taskId);
    assertTaskOpen(task);
    const active = tx.getActiveAgentRun(task.id, current.assignee);
    if (active?.workItemId === current.id && status !== "running") {
      throw usageError(`Work item ${current.id} has an active run; yield the run instead.`);
    }
    const updated = updateWorkItemStatus(current, status, trimmed(summary), now);
    tx.saveWorkItem(task.id, updated);
    return updated;
  });
  options.runtime?.notifyStateChanged(item.taskId);
  return `Updated work item ${item.id} to ${requested}\n`;
}

function dispatchWork(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task work dispatch usage: taskmux task work dispatch <id> [--input <text>].";
  const parsed = parseTail(args, new Set(["--input"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const now = clock(options);
  const run = store.transaction((tx) => {
    const item = requireWorkItem(tx, parsed.positionals[0]);
    const task = requireTask(tx, item.taskId);
    if (task.status !== "active") {
      throw usageError(task.status === "draft"
        ? `Task ${task.id} is a Draft; activate it before dispatch.`
        : `Task is archived: ${task.id}.`);
    }
    if (item.status !== "pending") {
      throw usageError(`Work item ${item.id} cannot be dispatched from ${item.status}.`);
    }
    const role = requireRole(tx, task.id, item.assignee);
    if (tx.getActiveAgentRun(task.id, role.name) !== null) {
      throw usageError(`${task.id}/${role.name} already has an active run.`);
    }
    const rawInput = trimmed(parsed.options.get("--input")) ?? item.title;
    const input = compileDispatchInput({}, task.id, role, rawInput);
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    const created = createAgentRun(
      tx.nextAgentRunId(task.id),
      task.id,
      role.name,
      roleAgentSessionResumeMode(sessions, role.activeAgentId),
      input,
      now,
      { workItemId: item.id }
    );
    tx.saveAgentRun(created);
    tx.saveActiveAgentRun(created);
    tx.saveWorkItem(task.id, updateWorkItemStatus(item, "running", undefined, now));
    tx.saveRole(task.id, updateRoleStatus(role, "running", now));
    return created;
  });
  options.runtime?.notifyStateChanged(run.taskId);
  return `Dispatch queued for ${run.taskId}/${run.roleName} (${run.id})\n`;
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
  exactPositionals(args, 1, "Task run list usage: taskmux task run list <work>.");
  const item = requireWorkItem(store, args[0]);
  const runs = store.listAgentRuns(item.taskId).filter((run) => run.workItemId === item.id);
  if (runs.length === 0) return "No runs found.\n";
  return `${renderTable(
    `Runs: ${item.id}`,
    [
      { header: "Run", minWidth: 6, maxWidth: 20 },
      { header: "Role", minWidth: 4, maxWidth: 22 },
      { header: "Mode", minWidth: 4, maxWidth: 8 },
      { header: "Status", minWidth: 6, maxWidth: 12 },
      { header: "Summary", minWidth: 8, maxWidth: 58 }
    ],
    runs.map((run) => [run.id, run.roleName, run.mode, run.status, run.summary ?? "-"]),
    defaultTableWidth()
  )}\n`;
}

function retryRun(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  exactPositionals(args, 1, "Task run retry usage: taskmux task run retry <run>.");
  const now = clock(options);
  const retried = store.transaction((tx) => {
    const previous = requireRun(tx, args[0]);
    if (previous.status !== "failed" && previous.status !== "expired") {
      throw usageError(`Run ${previous.id} is not retryable from ${previous.status}.`);
    }
    const task = requireTask(tx, previous.taskId);
    if (task.status !== "active") throw usageError(`Task is not active: ${task.id}.`);
    const role = requireRole(tx, task.id, previous.roleName);
    if (tx.getActiveAgentRun(task.id, role.name) !== null) {
      throw usageError(`${task.id}/${role.name} already has an active run.`);
    }
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    const created = createAgentRun(
      tx.nextAgentRunId(task.id),
      task.id,
      role.name,
      roleAgentSessionResumeMode(sessions, role.activeAgentId),
      previous.input,
      now,
      { workItemId: previous.workItemId, topics: previous.topics }
    );
    tx.saveAgentRun(created);
    tx.saveActiveAgentRun(created);
    tx.saveRole(task.id, updateRoleStatus(role, "running", now));
    if (previous.workItemId !== undefined) {
      const item = tx.getWorkItem(task.id, previous.workItemId);
      if (item === null) throw dataError(`Work item not found for run ${previous.id}: ${previous.workItemId}.`);
      tx.saveWorkItem(task.id, updateWorkItemStatus(item, "running", undefined, now));
    }
    return created;
  });
  options.runtime?.notifyStateChanged(retried.taskId);
  return `Retry queued as ${retried.id} for ${retried.taskId}/${retried.roleName}\n`;
}

function yieldRun(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): string {
  const usage = "Task run yield usage: taskmux task run yield <run> --summary <text>.";
  const parsed = parseTail(args, new Set(["--summary"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const summary = requiredOption(parsed.options, "--summary");
  const now = clock(options);
  const yielded = store.transaction((tx) => {
    const active = requireRun(tx, parsed.positionals[0]);
    if (active.status !== "active") {
      throw usageError(`Run ${active.id} is already terminal: ${active.status}.`);
    }
    const task = requireTask(tx, active.taskId);
    if (task.status === "archived") throw usageError(`Task is archived: ${task.id}.`);
    const role = requireRole(tx, task.id, active.roleName);
    const pointer = tx.getActiveAgentRun(task.id, role.name);
    if (pointer?.id !== active.id) throw usageError(`Run is not active for ${task.id}/${role.name}: ${active.id}.`);
    const terminal = yieldAgentRun(active, summary, now);
    const comment = appendMessage(tx, task.id, summary, role.name, now);
    tx.saveAgentRun(terminal);
    tx.clearActiveAgentRun(task.id, role.name);
    if (active.workItemId !== undefined) {
      const item = tx.getWorkItem(task.id, active.workItemId);
      if (item === null) throw dataError(`Work item not found for run ${active.id}: ${active.workItemId}.`);
      tx.saveWorkItem(task.id, updateWorkItemStatus(item, "completed", summary, now));
    } else if (role.name !== LEADER_ROLE) {
      throw usageError(`Run ${active.id} is not a work run.`);
    }
    tx.saveRole(task.id, updateRoleStatus(role, "idle", now));
    const sessions = tx.getTaskRoleSessionSet(task.id, role.name);
    if (sessions?.sessions[role.activeAgentId]?.status === "running") {
      tx.saveTaskRoleSessionSet(updateRoleAgentSessionStatus(sessions, role.activeAgentId, "ready", now));
    }
    queueLeaderWakeupAfterYield(tx, task, terminal, now);
    return { run: terminal, comment };
  });
  // For a Leader yield this also advances a wake that arrived while the Leader
  // was busy; queueLeaderWakeupAfterYield deliberately does not self-wake.
  options.runtime?.notifyStateChanged(yielded.run.taskId);
  return `Yielded ${yielded.run.id}: ${yielded.comment.body}\n`;
}

function createTaskRole(
  store: TaskWorkflowStore,
  task: Task,
  roleName: string,
  explicitAgentId: string | undefined,
  now: Date
): Role {
  const workspace = task.cwd ?? store.getConfig().defaultWorkspace ?? process.cwd();
  if (explicitAgentId === undefined) {
    const globalRole = store.getGlobalRole(roleName);
    if (globalRole !== null) {
      const copied = copyGlobalRoleToTaskRole(globalRole, task.id, now, roleName);
      return copied.workspace === workspace ? copied : updateRole(copied, { workspace }, now);
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

function appendMessage(
  store: TaskWorkflowStore,
  taskId: string,
  body: string,
  author: string,
  now: Date
): TaskComment {
  const comment = createTaskComment(store.nextCommentId(taskId), body, now, author);
  store.saveComment(taskId, comment);
  return comment;
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

function assertTaskOpen(task: Task): void {
  if (task.status === "archived") throw usageError(`Task is archived: ${task.id}.`);
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
  throw usageError(`Invalid work item status: ${value}.`);
}

function presentWorkStatus(status: WorkItemStatus): string {
  if (status === "pending") return "todo";
  if (status === "completed") return "done";
  return status;
}

type ParsedTail = Readonly<{
  positionals: string[];
  options: ReadonlyMap<string, string>;
}>;

function parseTail(args: string[], valueOptions: ReadonlySet<string>, usage: string): ParsedTail {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!valueOptions.has(value)) throw usageError(`Unsupported option: ${value}.`, usage);
    if (options.has(value)) throw usageError(`Option may only be specified once: ${value}.`, usage);
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

function output(value: string): TaskCommandExecution {
  return { kind: "output", output: value };
}

function clock(options: TaskCommandOptions): Date {
  return options.now?.() ?? new Date();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
